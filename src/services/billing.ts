import type { AuthUser } from '../auth.js';
import {
  AUTOPAY_MAX_PAISE,
  getPlan,
  isPlanKey,
  quotePeriod,
  quoteSeatTopup,
  type PlanDef,
  type PlanKey,
  type Quote,
  type QuoteContext,
} from '../catalog.js';
import { dateOrNull, num, textOrNull, type Queryable } from '../db.js';
import { AppError, badRequest, conflict, notFound } from '../errors.js';
import { RazorpayError } from '../razorpay.js';
import {
  ADMIN_ROLES,
  activeMemberCount,
  audit,
  loadOrg,
  raiseAlert,
  requireRole,
  type CollectionMethod,
  type Deps,
  type Org,
} from './common.js';
import { enqueueCancels, runProviderActions, type ProviderRef } from './outbox.js';

export { raiseAlert };
import { isAcademicDomain } from './domains.js';
import { recipientOf, type RecipientSnapshot } from './invoices.js';

const DAY_MS = 86_400_000;
/** Payment links must expire 15 minutes to 6 months after creation (Razorpay limits). */
const LINK_MIN_LIFETIME_MS = 3_600_000;
const LINK_MAX_LIFETIME_MS = 180 * DAY_MS;
/** Checkouts and seat changes an org may start per hour; each one makes Razorpay email the buyer. */
const CHECKOUTS_PER_HOUR = 10;

export type Purpose = 'new_period' | 'renewal' | 'seat_topup';

/** A quote as stored on a checkout, with the buyer details it was made for. */
export type CheckoutQuote = Quote & { recipient?: RecipientSnapshot };

export interface Checkout {
  id: string;
  orgId: string;
  purpose: Purpose;
  /** For payment-link renewals: the period end this renewal continues from. */
  renewsPaidThrough: Date | null;
  method: CollectionMethod;
  planKey: PlanKey;
  seats: number;
  quote: CheckoutQuote;
  totalPaise: number;
  providerRef: string | null;
  status: 'pending' | 'paid' | 'superseded' | 'expired' | 'cancelled';
}

export const CHECKOUT_COLUMNS =
  'id, org_id, purpose, renews_paid_through, method, plan_key, seats, quote, total_paise, provider_ref, status';

export function mapCheckout(r: Record<string, unknown>): Checkout {
  return {
    id: String(r.id),
    orgId: String(r.org_id),
    purpose: r.purpose as Purpose,
    renewsPaidThrough: dateOrNull(r.renews_paid_through),
    method: r.method as CollectionMethod,
    planKey: r.plan_key as PlanKey,
    seats: num(r.seats),
    quote: (typeof r.quote === 'string' ? JSON.parse(r.quote) : r.quote) as CheckoutQuote,
    totalPaise: num(r.total_paise),
    providerRef: textOrNull(r.provider_ref),
    status: r.status as Checkout['status'],
  };
}

/** B2B place of supply is the recipient's registered state; otherwise the billing state. */
export function placeOfSupply(org: Org): string {
  if (org.gstin) return org.gstin.slice(0, 2);
  if (org.billingStateCode) return org.billingStateCode;
  throw badRequest('Add your billing state (or GSTIN) before buying seats');
}

export function quoteContext(deps: Deps, org: Org): QuoteContext {
  return { supplierState: deps.config.supplier.stateCode, placeOfSupply: placeOfSupply(org), sac: deps.config.sac };
}

function planFor(org: Org, planKey: string): PlanDef {
  if (!isPlanKey(planKey)) throw badRequest(`Unknown plan: ${planKey}`);
  const plan = getPlan(planKey);
  if (!plan.orgKinds.includes(org.kind)) throw badRequest(`${plan.name} is not available for ${org.kind} organisations`);
  return plan;
}

function quoteOrThrow(fn: () => Quote): Quote {
  try {
    return fn();
  } catch (err) {
    if (err instanceof RangeError) throw badRequest(err.message);
    throw err;
  }
}

/** UPI Autopay / card mandates only while each debit stays within the RBI e-mandate limit. */
export function collectionMethodFor(deps: Deps, planKey: PlanKey, totalPaise: number): CollectionMethod {
  return deps.config.razorpay.planIds[planKey] && totalPaise <= AUTOPAY_MAX_PAISE ? 'autopay' : 'payment_link';
}

export const hasActivePeriod = (org: Org, now: Date) => org.paidThrough !== null && org.paidThrough > now;

export const ENDED_SUBSCRIPTION = new Set(['cancelled', 'completed', 'expired']);

function providerFailure(err: unknown): AppError {
  const message = err instanceof RazorpayError ? err.message : 'Payment provider unavailable';
  return new AppError(502, 'payment_provider_error', `Could not start the payment: ${message}`);
}

export interface QuoteView {
  planKey: PlanKey;
  seats: number;
  method: CollectionMethod;
  quote: Quote;
}

export async function getQuote(
  deps: Deps,
  user: AuthUser,
  orgId: string,
  planKey: string,
  seats: number,
): Promise<QuoteView> {
  await requireRole(deps.db, orgId, user, ADMIN_ROLES);
  const org = await loadOrg(deps.db, orgId);
  if (!org) throw notFound('Organisation not found');
  const plan = planFor(org, planKey);
  const quote = quoteOrThrow(() => quotePeriod(plan, seats, quoteContext(deps, org)));
  return { planKey: plan.key, seats, method: collectionMethodFor(deps, plan.key, quote.totalPaise), quote };
}

export async function hasAcademicDomain(q: Queryable, orgId: string): Promise<boolean> {
  const res = await q.query('SELECT domain FROM org_domains WHERE org_id = $1 AND verified_at IS NOT NULL', [orgId]);
  return res.rows.some((r) => isAcademicDomain(String(r.domain)));
}

function requireBillingDetails(org: Org): void {
  if (!org.legalName || !org.billingEmail || (!org.gstin && !org.billingStateCode)) {
    throw badRequest('Add the legal name, billing email and billing state (or GSTIN) before buying seats');
  }
}

async function enforceCheckoutRate(q: Queryable, orgId: string): Promise<void> {
  const res = await q.query(
    "SELECT count(*)::int AS n FROM checkouts WHERE org_id = $1 AND created_by IS NOT NULL AND created_at > now() - interval '1 hour'",
    [orgId],
  );
  if (num(res.rows[0]?.n ?? 0) >= CHECKOUTS_PER_HOUR) {
    throw new AppError(429, 'rate_limited', 'Too many payment requests for this organisation. Try again in an hour.');
  }
}

async function insertCheckout(
  q: Queryable,
  c: {
    org: Org;
    purpose: Purpose;
    method: CollectionMethod;
    quote: Quote;
    createdBy: string | null;
    renewsPaidThrough?: Date | null;
  },
): Promise<string | null> {
  const stored: CheckoutQuote = { ...c.quote, recipient: recipientOf(c.org) };
  // Only the one-renewal-per-period index can conflict; anything else is a real error.
  const res = await q.query(
    `INSERT INTO checkouts (org_id, purpose, method, plan_key, seats, quote, total_paise, created_by, renews_paid_through)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (org_id, renews_paid_through) WHERE purpose = 'renewal' AND status = 'pending' DO NOTHING
     RETURNING id`,
    [
      c.org.id,
      c.purpose,
      c.method,
      c.quote.planKey,
      c.quote.seats,
      JSON.stringify(stored),
      c.quote.totalPaise,
      c.createdBy,
      c.renewsPaidThrough ?? null,
    ],
  );
  return textOrNull(res.rows[0]?.id);
}

/** Mark matching pending checkouts superseded; returns provider objects to cancel after commit. */
async function supersede(q: Queryable, orgId: string, purposes: Purpose[], exceptId?: string): Promise<ProviderRef[]> {
  const res = await q.query(
    `UPDATE checkouts SET status = 'superseded', updated_at = now()
      WHERE org_id = $1 AND status = 'pending' AND purpose = ANY($2::text[]) AND id IS DISTINCT FROM $3::uuid
      RETURNING method, provider_ref`,
    [orgId, purposes, exceptId ?? null],
  );
  return refsOf(res.rows);
}

function refsOf(rows: Record<string, unknown>[]): ProviderRef[] {
  return rows
    .filter((r) => r.provider_ref !== null && r.provider_ref !== undefined)
    .map((r) => ({ method: r.method as CollectionMethod, ref: String(r.provider_ref) }));
}

/** Queue a cycle-end cancellation of a mandate (in the caller's transaction) and mark it. */
export async function enqueueCancelAtCycleEnd(q: Queryable, orgId: string, subId: string, ref: string): Promise<number[]> {
  await q.query('UPDATE subscriptions SET cancel_scheduled = true, updated_at = now() WHERE id = $1', [subId]);
  return enqueueCancels(q, orgId, [{ method: 'autopay', ref }], { atCycleEnd: true });
}

interface ProviderObject {
  id: string;
  shortUrl: string;
}

/**
 * Create the Razorpay object for a committed checkout row and record it. If the row stopped being
 * pending meanwhile (a newer request superseded it), the new object is cancelled at once.
 */
async function createProviderObject(
  deps: Deps,
  org: Org,
  checkoutId: string,
  method: CollectionMethod,
  quote: Quote,
  opts: { purpose: Purpose; startAt?: Date; linkExpiresAt?: Date },
): Promise<ProviderObject> {
  const plan = getPlan(quote.planKey);
  const notes = { checkout_id: checkoutId, org_id: org.id, purpose: opts.purpose };
  const now = deps.now().getTime();
  let obj: ProviderObject;
  try {
    if (method === 'autopay') {
      const planId = deps.config.razorpay.planIds[plan.key];
      if (!planId) throw new Error(`No Razorpay plan configured for ${plan.key}`);
      const sub = await deps.razorpay.createSubscription({
        planId,
        quantity: quote.seats,
        // Ten years of cycles; the mandate is cancelled when the org cancels.
        totalCount: plan.cycle === 'monthly' ? 120 : 10,
        ...(opts.startAt ? { startAt: Math.floor(opts.startAt.getTime() / 1000) } : {}),
        notes,
      });
      obj = { id: sub.id, shortUrl: sub.shortUrl };
    } else {
      const wanted = opts.linkExpiresAt?.getTime() ?? now + 7 * DAY_MS;
      const expireBy = Math.min(Math.max(wanted, now + LINK_MIN_LIFETIME_MS), now + LINK_MAX_LIFETIME_MS);
      obj = await deps.razorpay.createPaymentLink({
        amountPaise: quote.totalPaise,
        description: quote.lines.map((l) => l.description).join('; '),
        referenceId: checkoutId,
        customer: {
          ...(org.legalName ? { name: org.legalName.slice(0, 100) } : {}),
          ...(org.billingEmail ? { email: org.billingEmail } : {}),
        },
        expireBy: Math.floor(expireBy / 1000),
        notes,
      });
    }
  } catch (err) {
    deps.log.error({ err, checkoutId, method }, 'razorpay create failed');
    await deps.db.query(
      "UPDATE checkouts SET status = 'cancelled', updated_at = now() WHERE id = $1 AND status = 'pending'",
      [checkoutId],
    );
    throw providerFailure(err);
  }

  let unrecorded: number[] | null;
  try {
    unrecorded = await deps.db.tx(async (q) => {
    // Org first, like every other path (the subscription insert below takes a key-share lock on
    // the org through its foreign key, so locking the checkout first could deadlock).
    await q.query('SELECT id FROM orgs WHERE id = $1 FOR UPDATE', [org.id]);
      const res = await q.query(
        `UPDATE checkouts SET provider_ref = $2, short_url = $3, updated_at = now()
          WHERE id = $1 AND status = 'pending' RETURNING id`,
        [checkoutId, obj.id, obj.shortUrl],
      );
      // Superseded meanwhile: the object we just made must not stay payable.
      if (res.rowCount === 0) return enqueueCancels(q, org.id, [{ method, ref: obj.id }]);
      if (method === 'autopay') {
        await q.query(
          `INSERT INTO subscriptions (org_id, checkout_id, provider_subscription_id, plan_key, quantity, status, start_at)
           VALUES ($1, $2, $3, $4, $5, 'created', $6)
           ON CONFLICT (provider_subscription_id) DO UPDATE SET start_at = coalesce(subscriptions.start_at, EXCLUDED.start_at)`,
          [org.id, checkoutId, obj.id, quote.planKey, quote.seats, opts.startAt ?? null],
        );
      }
      return null;
    });
  } catch (err) {
    // Recording failed (e.g. the database aborted): queue the cancellation on its own.
    const ids = await enqueueCancels(deps.db, org.id, [{ method, ref: obj.id }]);
    await runProviderActions(deps, ids);
    throw err;
  }
  if (unrecorded) {
    await runProviderActions(deps, unrecorded);
    throw conflict('This request was replaced by a newer one. Refresh and try again.');
  }
  return obj;
}

export interface CheckoutResult {
  checkoutId: string;
  method: CollectionMethod;
  url: string;
  quote: Quote;
}

/** Buy a plan for an org with no active period. */
export async function startCheckout(
  deps: Deps,
  user: AuthUser,
  orgId: string,
  input: { planKey: string; seats: number },
): Promise<CheckoutResult> {
  const now = deps.now();
  const prepared = await deps.db.tx(async (q) => {
    await requireRole(q, orgId, user, ADMIN_ROLES);
    const org = await loadOrg(q, orgId, { lock: true });
    if (!org) throw notFound('Organisation not found');
    if (hasActivePeriod(org, now)) throw conflict('This organisation already has an active plan. Change seats instead.');
    requireBillingDetails(org);
    if (org.kind === 'campus' && !(await hasAcademicDomain(q, orgId))) {
      throw conflict('Verify your institution domain (e.g. yourcollege.ac.in) before buying campus seats');
    }
    await enforceCheckoutRate(q, orgId);
    const plan = planFor(org, input.planKey);
    const members = await activeMemberCount(q, orgId);
    if (input.seats < members) throw badRequest(`You have ${members} members; buy at least that many seats`);
    const quote = quoteOrThrow(() => quotePeriod(plan, input.seats, quoteContext(deps, org)));
    const method = collectionMethodFor(deps, plan.key, quote.totalPaise);

    // A new purchase replaces anything still payable from before (old checkouts, a renewal link
    // for the lapsed period, unpaid top-ups) and stops a lapsed mandate from retrying.
    const stale = await supersede(q, orgId, ['new_period', 'renewal', 'seat_topup']);
    if (org.subscriptionId) {
      const sub = await q.query('SELECT provider_subscription_id, status FROM subscriptions WHERE id = $1', [
        org.subscriptionId,
      ]);
      const row = sub.rows[0];
      if (row && !ENDED_SUBSCRIPTION.has(String(row.status))) {
        stale.push({ method: 'autopay', ref: String(row.provider_subscription_id) });
      }
    }
    const checkoutId = await insertCheckout(q, { org, purpose: 'new_period', method, quote, createdBy: user.id });
    if (!checkoutId) throw new Error('Checkout insert returned no row');
    await audit(q, orgId, user.id, 'checkout.started', { checkoutId, planKey: plan.key, seats: input.seats, method });
    const actions = await enqueueCancels(q, orgId, stale);
    return { org, checkoutId, method, quote, actions };
  });

  await runProviderActions(deps, prepared.actions);
  const obj = await createProviderObject(deps, prepared.org, prepared.checkoutId, prepared.method, prepared.quote, {
    purpose: 'new_period',
  });
  return { checkoutId: prepared.checkoutId, method: prepared.method, url: obj.shortUrl, quote: prepared.quote };
}

export interface SeatChangeResult {
  seatLimit: number;
  renewalSeats: number;
  /** Pay this to get the extra seats now (prorated). */
  topup: CheckoutResult | null;
  /**
   * Autopay orgs whose renewal amount changes: authorise this new mandate. The current mandate
   * keeps renewing at the old count until the new one is authorised.
   */
  renewalAuthorizationUrl: string | null;
  /** Set when the new mandate could not be created; the current one keeps renewing. */
  renewalAuthorizationError: string | null;
}

/**
 * Change the seat count.
 * - More seats are usable as soon as a prorated top-up is paid.
 * - The new count (up or down) applies from the next renewal. Payment-link orgs get a fresh
 *   renewal link from the daily job; any unpaid link at the old count is withdrawn.
 * - Autopay mandates have a fixed amount, so a replacement subscription starting at the period
 *   end is created. The current mandate is only cancelled once the replacement is authorised
 *   (subscription.authenticated webhook), so ignoring the new link never ends a paying plan.
 */
export async function changeSeats(deps: Deps, user: AuthUser, orgId: string, seats: number): Promise<SeatChangeResult> {
  const now = deps.now();
  const prepared = await deps.db.tx(async (q) => {
    await requireRole(q, orgId, user, ADMIN_ROLES);
    const org = await loadOrg(q, orgId, { lock: true });
    if (!org) throw notFound('Organisation not found');
    const { planKey, currentPeriodStart, paidThrough } = org;
    if (!hasActivePeriod(org, now) || !planKey || !currentPeriodStart || !paidThrough) {
      throw conflict('This organisation has no active plan. Start a checkout instead.');
    }
    requireBillingDetails(org);
    await enforceCheckoutRate(q, orgId);
    const plan = getPlan(planKey);
    const members = await activeMemberCount(q, orgId);
    if (seats < members) throw badRequest(`You have ${members} members; remove members before going below that`);
    const ctx = quoteContext(deps, org);
    const renewalQuote = quoteOrThrow(() => quotePeriod(plan, seats, ctx));

    // Withdraw unpaid top-ups, payment-link renewals and autopay replacements nobody has authorised.
    // An authorised replacement stays: the current mandate may already be ending because of it;
    // it is retired only once a newer replacement is authorised (see webhooks).
    const withdrawn = await q.query(
      `UPDATE checkouts c SET status = 'superseded', updated_at = now()
        WHERE c.org_id = $1 AND c.status = 'pending'
          AND (c.purpose = 'seat_topup'
               OR (c.purpose = 'renewal' AND (c.method = 'payment_link' OR NOT EXISTS (
                     SELECT 1 FROM subscriptions s WHERE s.checkout_id = c.id AND s.status IN ('authenticated', 'active')))))
        RETURNING c.method, c.provider_ref`,
      [orgId],
    );
    const stale = refsOf(withdrawn.rows);

    let topup: { checkoutId: string; quote: Quote } | null = null;
    if (seats > org.seatLimit) {
      if (paidThrough.getTime() - now.getTime() < DAY_MS) {
        throw conflict('Your plan renews within a day. Add seats after the renewal.');
      }
      const quote = quoteOrThrow(() =>
        quoteSeatTopup(plan, org.seatLimit, seats, { start: currentPeriodStart, end: paidThrough }, now, ctx),
      );
      const checkoutId = await insertCheckout(q, { org, purpose: 'seat_topup', method: 'payment_link', quote, createdBy: user.id });
      if (!checkoutId) throw new Error('Checkout insert returned no row');
      topup = { checkoutId, quote };
    }

    await q.query('UPDATE orgs SET renewal_seats = $2, updated_at = now() WHERE id = $1', [orgId, seats]);

    let replacement: { checkoutId: string; quote: Quote } | null = null;
    let cancelAtCycleEnd: { id: string; ref: string } | null = null;
    const subRes = org.subscriptionId
      ? await q.query('SELECT id, provider_subscription_id, quantity, status, cancel_scheduled FROM subscriptions WHERE id = $1', [
          org.subscriptionId,
        ])
      : null;
    const current = subRes?.rows[0];
    if (current) {
      const live = !ENDED_SUBSCRIPTION.has(String(current.status));
      const cancelScheduled = Boolean(current.cancel_scheduled);
      const stopCurrent = (): { id: string; ref: string } | null =>
        live && !cancelScheduled ? { id: String(current.id), ref: String(current.provider_subscription_id) } : null;
      if (org.collectionMethod === 'payment_link') {
        // A mandate left over from a switch to payment links must not keep charging (this also
        // repairs a switch whose cancellation did not go through earlier).
        cancelAtCycleEnd = stopCurrent();
      } else {
        // The mandate that bills next period: an authorised replacement if any, else the current one.
        const successor = await q.query(
          `SELECT s.quantity FROM subscriptions s JOIN checkouts c ON c.id = s.checkout_id
            WHERE s.org_id = $1 AND c.purpose = 'renewal' AND c.status = 'pending' AND s.status IN ('authenticated', 'active')
            ORDER BY s.created_at DESC LIMIT 1`,
          [orgId],
        );
        const successorRow = successor.rows[0];
        let nextQuantity: number | null = null;
        if (successorRow) nextQuantity = num(successorRow.quantity);
        else if (live && !cancelScheduled) nextQuantity = num(current.quantity);
        if (nextQuantity !== seats) {
          if (collectionMethodFor(deps, plan.key, renewalQuote.totalPaise) === 'autopay') {
            const checkoutId = await insertCheckout(q, {
              org,
              purpose: 'renewal',
              method: 'autopay',
              quote: renewalQuote,
              createdBy: user.id,
            });
            if (!checkoutId) throw new Error('Checkout insert returned no row');
            replacement = { checkoutId, quote: renewalQuote };
          } else {
            // Above the e-mandate limit: renewals move to payment links, sent by the daily job
            // before the period ends, so every mandate must stop after this cycle.
            await q.query("UPDATE orgs SET collection_method = 'payment_link' WHERE id = $1", [orgId]);
            stale.push(...(await supersede(q, orgId, ['renewal'])));
            cancelAtCycleEnd = stopCurrent();
          }
        }
      }
    }
    await audit(q, orgId, user.id, 'seats.changed', { from: org.seatLimit, to: seats });
    // Recorded in this transaction, so they happen even if a later step fails or the process dies.
    const actions = await enqueueCancels(q, orgId, stale);
    const stop = cancelAtCycleEnd;
    if (stop) actions.push(...(await enqueueCancelAtCycleEnd(q, orgId, stop.id, stop.ref)));
    return { org, paidThrough, topup, replacement, actions };
  });

  await runProviderActions(deps, prepared.actions);

  let topupResult: CheckoutResult | null = null;
  if (prepared.topup) {
    const { checkoutId, quote } = prepared.topup;
    try {
      const obj = await createProviderObject(deps, prepared.org, checkoutId, 'payment_link', quote, {
        purpose: 'seat_topup',
        // Payable only while the period it prorates still runs.
        linkExpiresAt: new Date(Math.min(prepared.paidThrough.getTime(), now.getTime() + 7 * DAY_MS)),
      });
      topupResult = { checkoutId, method: 'payment_link', url: obj.shortUrl, quote };
    } catch (err) {
      if (prepared.replacement) {
        await deps.db.query("UPDATE checkouts SET status = 'cancelled' WHERE id = $1 AND status = 'pending'", [
          prepared.replacement.checkoutId,
        ]);
      }
      throw err;
    }
  }

  let renewalAuthorizationUrl: string | null = null;
  let renewalAuthorizationError: string | null = null;
  if (prepared.replacement) {
    try {
      const obj = await createProviderObject(
        deps,
        prepared.org,
        prepared.replacement.checkoutId,
        'autopay',
        prepared.replacement.quote,
        { purpose: 'renewal', startAt: prepared.paidThrough },
      );
      renewalAuthorizationUrl = obj.shortUrl;
    } catch (err) {
      // The top-up (if any) is already payable, so report this instead of failing the request.
      renewalAuthorizationError = err instanceof AppError ? err.message : 'Could not create the new mandate';
      await raiseAlert(deps.db, orgId, 'replacement_mandate_failed', { checkoutId: prepared.replacement.checkoutId });
    }
  }
  return {
    seatLimit: prepared.org.seatLimit,
    renewalSeats: seats,
    topup: topupResult,
    renewalAuthorizationUrl,
    renewalAuthorizationError,
  };
}

export interface RenewalRunResult {
  markedPastDue: number;
  linksCreated: number;
  failures: number;
}

/**
 * Daily job:
 * - mark lapsed orgs past due;
 * - send a renewal payment link to payment-link orgs whose period ends within the lead window
 *   (or ended within the grace window). A unique index allows one live renewal per period, so
 *   re-runs are safe, and a link withdrawn by a seat change is re-issued at the new count;
 * - purge old idempotency records.
 */
export async function runRenewals(deps: Deps): Promise<RenewalRunResult> {
  const now = deps.now();
  const graceMs = deps.config.pastDueGraceDays * DAY_MS;
  const past = await deps.db.query(
    "UPDATE orgs SET status = 'past_due', updated_at = now() WHERE status = 'active' AND paid_through < $1",
    [now],
  );
  const due = await deps.db.query(
    `SELECT id FROM orgs
      WHERE collection_method = 'payment_link' AND auto_renew AND plan_key IS NOT NULL
        AND status IN ('active', 'past_due') AND paid_through <= $1 AND paid_through > $2`,
    [new Date(now.getTime() + deps.config.renewalLeadDays * DAY_MS), new Date(now.getTime() - graceMs)],
  );

  let linksCreated = 0;
  let failures = 0;
  for (const row of due.rows) {
    const orgId = String(row.id);
    try {
      const prepared = await deps.db.tx(async (q) => {
        const org = await loadOrg(q, orgId, { lock: true });
        if (!org?.planKey || !org.paidThrough || org.collectionMethod !== 'payment_link') return null;
        if (org.kind === 'campus' && !(await hasAcademicDomain(q, orgId))) {
          await raiseAlert(q, orgId, 'renewal_skipped_no_academic_domain', {});
          return null;
        }
        const plan = getPlan(org.planKey);
        const seats = Math.max(org.renewalSeats ?? org.seatLimit, plan.minSeats);
        let quote: Quote;
        try {
          quote = quotePeriod(plan, seats, quoteContext(deps, org));
        } catch (err) {
          await raiseAlert(q, orgId, 'renewal_quote_failed', { message: (err as Error).message });
          return null;
        }
        const checkoutId = await insertCheckout(q, {
          org,
          purpose: 'renewal',
          method: 'payment_link',
          quote,
          createdBy: null,
          renewsPaidThrough: org.paidThrough,
        });
        return checkoutId ? { org, checkoutId, quote, paidThrough: org.paidThrough } : null;
      });
      if (!prepared) continue;
      await createProviderObject(deps, prepared.org, prepared.checkoutId, 'payment_link', prepared.quote, {
        purpose: 'renewal',
        linkExpiresAt: new Date(prepared.paidThrough.getTime() + graceMs),
      });
      linksCreated++;
    } catch (err) {
      failures++;
      deps.log.error({ err, orgId }, 'renewal link failed');
    }
  }

  await runProviderActions(deps);
  await deps.db.query("DELETE FROM webhook_events WHERE received_at < now() - interval '90 days'");
  await deps.db.query("DELETE FROM usage_batches WHERE received_at < now() - interval '30 days'");
  return { markedPastDue: past.rowCount, linksCreated, failures };
}
