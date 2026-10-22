import { createHash } from 'node:crypto';
import { z } from 'zod';
import { addCycle, getPlan, isPlanKey, periodAmounts } from '../catalog.js';
import { textOrNull, type Queryable } from '../db.js';
import { AppError, badRequest } from '../errors.js';
import { verifyWebhookSignature } from '../razorpay.js';
import {
  CHECKOUT_COLUMNS,
  ENDED_SUBSCRIPTION,
  enqueueCancelAtCycleEnd,
  hasActivePeriod,
  mapCheckout,
  quoteContext,
  raiseAlert,
  type Checkout,
} from './billing.js';
import { loadOrg, type Deps, type Org } from './common.js';
import { enqueueCancels, runProviderActions, stopLiveMandates } from './outbox.js';
import { issueInvoice, type InvoiceAmounts, type RecipientSnapshot } from './invoices.js';

// Razorpay sends `notes` as [] when empty on subscriptions and null on some payment links.
const notesSchema = z
  .union([z.record(z.string(), z.unknown()), z.array(z.unknown())])
  .nullable()
  .optional()
  .transform((v): Record<string, string> => {
    if (!v || Array.isArray(v)) return {};
    const out: Record<string, string> = {};
    for (const [k, val] of Object.entries(v)) if (typeof val === 'string') out[k] = val;
    return out;
  });

const unixSeconds = z.number().int().positive().nullable().optional();

const subscriptionEntity = z.object({
  id: z.string().min(1),
  status: z.string(),
  quantity: z.number().int().positive().optional(),
  current_start: unixSeconds,
  current_end: unixSeconds,
  notes: notesSchema,
});

const paymentEntity = z.object({
  id: z.string().min(1),
  amount: z.number().int().nonnegative(),
  currency: z.string(),
  status: z.string().optional(),
  created_at: unixSeconds,
});

const paymentLinkEntity = z.object({
  id: z.string().min(1),
  amount: z.number().int().nonnegative(),
  amount_paid: z.number().int().nonnegative().optional(),
  status: z.string(),
  notes: notesSchema,
});

const envelope = z.object({
  event: z.string(),
  payload: z
    .object({
      subscription: z.object({ entity: subscriptionEntity }).optional(),
      payment: z.object({ entity: paymentEntity }).optional(),
      payment_link: z.object({ entity: paymentLinkEntity }).optional(),
    })
    .optional(),
});

type SubscriptionEntity = z.infer<typeof subscriptionEntity>;
type PaymentEntity = z.infer<typeof paymentEntity>;
type PaymentLinkEntity = z.infer<typeof paymentLinkEntity>;

export type WebhookOutcome = 'processed' | 'duplicate' | 'ignored';

interface Ctx {
  q: Queryable;
  deps: Deps;
  /** Outbox actions recorded in this transaction; executed right after it commits. */
  actions: number[];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Verify, de-duplicate and apply a Razorpay webhook. The dedupe row and all database effects
 * commit in one transaction, so a failure leaves nothing recorded and Razorpay's retry is
 * processed afresh. Provider calls (cancelling mandates) go through the outbox: recorded in the
 * same transaction, executed after commit, retried by a job if they fail.
 *
 * Lock order everywhere is org row first, then checkout/subscription rows, matching the API paths.
 */
export async function handleRazorpayWebhook(
  deps: Deps,
  rawBody: string,
  signature: string | undefined,
  eventIdHeader: string | undefined,
): Promise<WebhookOutcome> {
  if (!verifyWebhookSignature(rawBody, signature, deps.config.razorpay.webhookSecret)) {
    throw new AppError(401, 'unauthorized', 'Invalid webhook signature');
  }
  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    throw badRequest('Webhook body is not JSON');
  }
  const parsed = envelope.safeParse(body);
  if (!parsed.success) {
    deps.log.warn({ issues: parsed.error.issues }, 'unrecognised razorpay webhook shape');
    throw badRequest('Unrecognised webhook payload');
  }
  const event = parsed.data;
  const bodyHash = createHash('sha256').update(rawBody).digest('hex');
  const eventId = eventIdHeader?.trim() || `sha256:${bodyHash}`;
  const actions: number[] = [];

  const outcome = await deps.db.tx(async (q): Promise<WebhookOutcome> => {
    const fresh = await q.query(
      `INSERT INTO webhook_events (event_id, body_sha256, event) VALUES ($1, $2, $3)
       ON CONFLICT DO NOTHING RETURNING event_id`,
      [eventId, bodyHash, event.event],
    );
    if (fresh.rowCount === 0) return 'duplicate';

    const ctx: Ctx = { q, deps, actions };
    const p = event.payload ?? {};
    const sub = p.subscription?.entity;
    const payment = p.payment?.entity;
    const link = p.payment_link?.entity;
    switch (event.event) {
      case 'subscription.charged':
        return sub && payment ? onSubscriptionCharged(ctx, sub, payment) : 'ignored';
      case 'subscription.authenticated':
      case 'subscription.activated':
        return sub ? onSubscriptionAuthorised(ctx, sub) : 'ignored';
      case 'subscription.pending':
      case 'subscription.halted':
        return sub ? onSubscriptionTrouble(ctx, sub) : 'ignored';
      case 'subscription.cancelled':
      case 'subscription.completed':
      case 'subscription.expired':
        return sub ? onSubscriptionEnded(ctx, sub) : 'ignored';
      case 'payment_link.paid':
        return link ? onPaymentLinkPaid(ctx, link, payment) : 'ignored';
      case 'payment_link.expired':
      case 'payment_link.cancelled':
        if (!link) return 'ignored';
        await q.query(
          "UPDATE checkouts SET status = $2, updated_at = now() WHERE provider_ref = $1 AND status = 'pending'",
          [link.id, event.event === 'payment_link.expired' ? 'expired' : 'cancelled'],
        );
        return 'processed';
      default:
        return 'ignored';
    }
  });

  try {
    await runProviderActions(deps, actions);
  } catch (err) {
    // Still queued; the provider-actions job retries them.
    deps.log.error({ err, eventId }, 'post-commit provider actions failed');
  }
  return outcome;
}

interface SubRow {
  id: string;
  providerId: string;
  orgId: string;
  checkoutId: string | null;
  planKey: string;
  quantity: number;
  status: string;
  cancelScheduled: boolean;
}

const SUB_SELECT =
  'SELECT id, provider_subscription_id, org_id, checkout_id, plan_key, quantity, status, cancel_scheduled FROM subscriptions';

function mapSub(r: Record<string, unknown>): SubRow {
  return {
    id: String(r.id),
    providerId: String(r.provider_subscription_id),
    orgId: String(r.org_id),
    checkoutId: textOrNull(r.checkout_id),
    planKey: String(r.plan_key),
    quantity: Number(r.quantity),
    status: String(r.status),
    cancelScheduled: Boolean(r.cancel_scheduled),
  };
}

async function lockCheckout(q: Queryable, checkoutId: string): Promise<Checkout | null> {
  const res = await q.query(`SELECT ${CHECKOUT_COLUMNS} FROM checkouts WHERE id = $1 FOR UPDATE`, [checkoutId]);
  return res.rows[0] ? mapCheckout(res.rows[0]) : null;
}

interface LockedSub {
  org: Org;
  sub: SubRow;
  checkout: Checkout | null;
}

/**
 * Lock org → subscription → checkout for a provider subscription. If the webhook beat our own
 * write of the subscription row, it is recreated from the checkout named in the notes.
 */
async function lockSubscription(q: Queryable, entity: SubscriptionEntity): Promise<LockedSub | null> {
  let orgId: string | null = null;
  const known = await q.query('SELECT org_id FROM subscriptions WHERE provider_subscription_id = $1', [entity.id]);
  if (known.rows[0]) {
    orgId = String(known.rows[0].org_id);
  } else {
    const checkoutId = entity.notes.checkout_id;
    if (!checkoutId || !UUID.test(checkoutId)) return null;
    const c = await q.query('SELECT org_id FROM checkouts WHERE id = $1', [checkoutId]);
    if (!c.rows[0]) return null;
    orgId = String(c.rows[0].org_id);
  }
  const org = await loadOrg(q, orgId, { lock: true });
  if (!org) return null;

  let subRes = await q.query(`${SUB_SELECT} WHERE provider_subscription_id = $1 FOR UPDATE`, [entity.id]);
  if (!subRes.rows[0]) {
    const checkoutId = entity.notes.checkout_id ?? '';
    const checkout = UUID.test(checkoutId) ? await lockCheckout(q, checkoutId) : null;
    if (
      !checkout ||
      checkout.orgId !== org.id ||
      checkout.method !== 'autopay' ||
      (checkout.providerRef && checkout.providerRef !== entity.id)
    ) {
      return null;
    }
    await q.query(
      `INSERT INTO subscriptions (org_id, checkout_id, provider_subscription_id, plan_key, quantity, status)
       VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (provider_subscription_id) DO NOTHING`,
      [org.id, checkout.id, entity.id, checkout.planKey, checkout.seats, entity.status],
    );
    await q.query('UPDATE checkouts SET provider_ref = $2 WHERE id = $1 AND provider_ref IS NULL', [checkout.id, entity.id]);
    subRes = await q.query(`${SUB_SELECT} WHERE provider_subscription_id = $1 FOR UPDATE`, [entity.id]);
  }
  const subRow = subRes.rows[0];
  if (!subRow) return null;
  const sub = mapSub(subRow);
  const checkout = sub.checkoutId ? await lockCheckout(q, sub.checkoutId) : null;
  return { org, sub, checkout };
}

/** Record a provider status, never moving a terminal status back to a live one. */
async function setSubStatus(q: Queryable, subId: string, status: string): Promise<void> {
  await q.query(
    `UPDATE subscriptions SET status = CASE WHEN status IN ('cancelled', 'completed', 'expired') THEN status ELSE $2 END,
            updated_at = now()
      WHERE id = $1`,
    [subId, status],
  );
}

/** A replacement mandate is one created by a seat change that has not been superseded since. */
const isLiveReplacement = (checkout: Checkout | null) => checkout?.purpose === 'renewal' && checkout.status === 'pending';

/** Once a replacement mandate is authorised, the current mandate should stop after its cycle. */
async function retireCurrentMandate(ctx: Ctx, org: Org, replacementId: string): Promise<void> {
  if (!org.subscriptionId || org.subscriptionId === replacementId) return;
  const res = await ctx.q.query(`${SUB_SELECT} WHERE id = $1`, [org.subscriptionId]);
  const current = res.rows[0] ? mapSub(res.rows[0]) : null;
  if (!current || current.cancelScheduled || ENDED_SUBSCRIPTION.has(current.status)) return;
  ctx.actions.push(...(await enqueueCancelAtCycleEnd(ctx.q, org.id, current.id, current.providerId)));
}

/** A mandate that charged but should not exist (withdrawn, duplicate): stop it now. */
async function stopStrayMandate(ctx: Ctx, org: Org, sub: SubRow, checkout: Checkout | null): Promise<void> {
  if (org.subscriptionId === sub.id || sub.cancelScheduled) return;
  await ctx.q.query('UPDATE subscriptions SET cancel_scheduled = true, updated_at = now() WHERE id = $1', [sub.id]);
  if (checkout?.status === 'pending') {
    await ctx.q.query("UPDATE checkouts SET status = 'superseded', updated_at = now() WHERE id = $1", [checkout.id]);
  }
  ctx.actions.push(...(await enqueueCancels(ctx.q, org.id, [{ method: 'autopay', ref: sub.providerId }])));
}

/** Withdraw unpaid payment-link renewals (optionally keeping one): the period is paid another way. */
async function withdrawRenewalLinks(ctx: Ctx, orgId: string, keepCheckoutId?: string): Promise<void> {
  const res = await ctx.q.query(
    `UPDATE checkouts SET status = 'superseded', updated_at = now()
      WHERE org_id = $1 AND purpose = 'renewal' AND method = 'payment_link' AND status = 'pending'
        AND id IS DISTINCT FROM $2::uuid
      RETURNING provider_ref`,
    [orgId, keepCheckoutId ?? null],
  );
  const refs = res.rows
    .filter((r) => r.provider_ref !== null)
    .map((r) => ({ method: 'payment_link' as const, ref: String(r.provider_ref) }));
  ctx.actions.push(...(await enqueueCancels(ctx.q, orgId, refs)));
}

/**
 * Withdraw other replacement mandates that can no longer be wanted: all of them when a newer one
 * is authorised, or (with `startedBy`) those due to start by a cycle that is now being billed.
 */
async function cancelOtherReplacements(ctx: Ctx, org: Org, keepSubId: string, startedBy?: Date): Promise<void> {
  const res = await ctx.q.query(
    `UPDATE checkouts c SET status = 'superseded', updated_at = now()
       FROM subscriptions s
      WHERE s.checkout_id = c.id AND c.org_id = $1 AND c.purpose = 'renewal' AND c.status = 'pending'
        AND s.id <> $2 AND s.id IS DISTINCT FROM $3::uuid AND s.status IN ('created', 'authenticated', 'active')
        AND ($4::timestamptz IS NULL OR (s.start_at IS NOT NULL AND s.start_at <= $4::timestamptz))
      RETURNING s.provider_subscription_id`,
    [org.id, keepSubId, org.subscriptionId, startedBy ?? null],
  );
  const refs = res.rows.map((r) => ({ method: 'autopay' as const, ref: String(r.provider_subscription_id) }));
  ctx.actions.push(...(await enqueueCancels(ctx.q, org.id, refs)));
}

const fromUnix = (s: number | null | undefined): Date | null => (s ? new Date(s * 1000) : null);

async function invoiceOrAlert(
  ctx: Ctx,
  org: Org,
  build: () => InvoiceAmounts,
  payment: { id: string; amount: number; currency: string; checkoutId: string | null; at: Date },
  buyer?: RecipientSnapshot,
): Promise<void> {
  let amounts: InvoiceAmounts;
  try {
    amounts = build();
  } catch (err) {
    await raiseAlert(ctx.q, org.id, 'invoice_build_failed', { paymentId: payment.id, message: (err as Error).message });
    return;
  }
  if (payment.currency !== 'INR' || payment.amount !== amounts.totalPaise) {
    // Never issue a tax invoice that disagrees with the money received; a human resolves it.
    await raiseAlert(ctx.q, org.id, 'amount_mismatch', {
      paymentId: payment.id,
      received: payment.amount,
      currency: payment.currency,
      expected: amounts.totalPaise,
    });
    return;
  }
  await issueInvoice(ctx.q, ctx.deps, org, amounts, { id: payment.id, checkoutId: payment.checkoutId, at: payment.at }, buyer);
}

async function onSubscriptionCharged(ctx: Ctx, entity: SubscriptionEntity, payment: PaymentEntity): Promise<WebhookOutcome> {
  const { q, deps } = ctx;
  const locked = await lockSubscription(q, entity);
  if (!locked) {
    await raiseAlert(q, null, 'unknown_subscription_charged', { subscription: entity.id, paymentId: payment.id });
    return 'ignored';
  }
  const { org, sub, checkout } = locked;
  if (!isPlanKey(sub.planKey)) return 'ignored';
  const plan = getPlan(sub.planKey);
  const now = deps.now();
  const quantity = entity.quantity ?? sub.quantity;
  const start = fromUnix(entity.current_start) ?? now;
  const end = fromUnix(entity.current_end) ?? addCycle(start, plan.cycle);
  await setSubStatus(q, sub.id, entity.status);
  await q.query(
    `UPDATE subscriptions SET quantity = $2, current_start = $3, current_end = $4
      WHERE id = $1 AND (current_end IS NULL OR current_end < $4)`,
    [sub.id, quantity, start, end],
  );

  const isCurrent = org.subscriptionId === sub.id;
  const isReplacement = isLiveReplacement(checkout);
  // A purchase applies only while the org has no paid period, so two purchases paid back to back
  // never stack silently: the second raises an alert. A superseded replacement never applies.
  const isPurchase = checkout?.purpose === 'new_period' && !hasActivePeriod(org, now);
  const eligible = isCurrent || isReplacement || isPurchase;
  // A retried delivery of an older cycle must not pull the period back.
  const newer = !org.paidThrough || end > org.paidThrough;
  if (eligible && newer) {
    await q.query(
      `UPDATE orgs SET subscription_id = $2, plan_key = $3, plan_tier = $4, seat_limit = $5, renewal_seats = $5,
              status = 'active', collection_method = 'autopay', current_period_start = $6, paid_through = $7,
              updated_at = now()
        WHERE id = $1`,
      [org.id, sub.id, plan.key, plan.tier, quantity, start, end],
    );
    if (checkout?.status === 'pending') {
      await q.query("UPDATE checkouts SET status = 'paid', updated_at = now() WHERE id = $1", [checkout.id]);
    }
    // Safety net if the authentication webhook was missed: never leave two mandates running.
    if (!isCurrent) await retireCurrentMandate(ctx, org, sub.id);
    // Replacements meant to start by now were never authorised in time; withdraw them. The
    // period is paid by mandate, so any renewal link still out is withdrawn too.
    await cancelOtherReplacements(ctx, org, sub.id, start);
    await withdrawRenewalLinks(ctx, org.id);
  } else if (!eligible) {
    // E.g. a superseded mandate that was authorised anyway. Invoice the money, flag a refund,
    // and stop the mandate so it cannot charge again next cycle.
    await raiseAlert(q, org.id, 'duplicate_subscription_charge', { subscription: entity.id, paymentId: payment.id });
    await stopStrayMandate(ctx, org, sub, checkout);
  } else {
    // Eligible but not newer: a retried delivery (same payment, already invoiced) is fine;
    // a different payment for a cycle already covered needs a human, and a second mandate
    // charging for it is stopped.
    const seen = await q.query('SELECT 1 FROM invoices WHERE provider_payment_id = $1', [payment.id]);
    if (seen.rowCount === 0) {
      await raiseAlert(q, org.id, 'charge_for_past_cycle', { subscription: entity.id, paymentId: payment.id });
      await stopStrayMandate(ctx, org, sub, checkout);
    }
  }
  await invoiceOrAlert(ctx, org, () => periodAmounts(plan, quantity, quoteContext(deps, org)), {
    id: payment.id,
    amount: payment.amount,
    currency: payment.currency,
    checkoutId: checkout?.id ?? null,
    at: fromUnix(payment.created_at) ?? now,
  });
  return 'processed';
}

async function onSubscriptionAuthorised(ctx: Ctx, entity: SubscriptionEntity): Promise<WebhookOutcome> {
  const locked = await lockSubscription(ctx.q, entity);
  if (!locked) return 'ignored';
  await setSubStatus(ctx.q, locked.sub.id, entity.status);
  if (isLiveReplacement(locked.checkout)) {
    await retireCurrentMandate(ctx, locked.org, locked.sub.id);
    await cancelOtherReplacements(ctx, locked.org, locked.sub.id);
  }
  return 'processed';
}

async function onSubscriptionTrouble(ctx: Ctx, entity: SubscriptionEntity): Promise<WebhookOutcome> {
  const locked = await lockSubscription(ctx.q, entity);
  if (!locked) return 'ignored';
  await setSubStatus(ctx.q, locked.sub.id, entity.status);
  if (locked.org.subscriptionId === locked.sub.id) {
    await ctx.q.query("UPDATE orgs SET status = 'past_due', updated_at = now() WHERE id = $1 AND status = 'active'", [
      locked.org.id,
    ]);
  }
  return 'processed';
}

async function onSubscriptionEnded(ctx: Ctx, entity: SubscriptionEntity): Promise<WebhookOutcome> {
  const { q } = ctx;
  const locked = await lockSubscription(q, entity);
  if (!locked) return 'ignored';
  const { org, sub } = locked;
  await setSubStatus(q, sub.id, entity.status);
  if (org.subscriptionId !== sub.id || org.collectionMethod !== 'autopay') return 'processed';
  // The current mandate ended. Unless a replacement is lined up, the org is cancelled: it keeps
  // access until paid_through, without the past-due grace period.
  const others = await q.query(
    `SELECT 1 FROM subscriptions s JOIN checkouts c ON c.id = s.checkout_id
      WHERE s.org_id = $1 AND s.id <> $2 AND s.status IN ('authenticated', 'active') AND c.status IN ('pending', 'paid')`,
    [org.id, sub.id],
  );
  if (others.rowCount === 0) {
    await q.query("UPDATE orgs SET status = 'cancelled', updated_at = now() WHERE id = $1", [org.id]);
  }
  return 'processed';
}

async function onPaymentLinkPaid(ctx: Ctx, link: PaymentLinkEntity, payment: PaymentEntity | undefined): Promise<WebhookOutcome> {
  const { q, deps } = ctx;
  // Find the checkout without locking, lock its org, then lock the checkout (org-first order).
  let found = link.notes.checkout_id && UUID.test(link.notes.checkout_id)
    ? await q.query('SELECT id, org_id FROM checkouts WHERE id = $1', [link.notes.checkout_id])
    : null;
  if (!found?.rows[0]) found = await q.query('SELECT id, org_id FROM checkouts WHERE provider_ref = $1', [link.id]);
  const ref = found.rows[0];
  const org = ref ? await loadOrg(q, String(ref.org_id), { lock: true }) : null;
  const checkout = ref && org ? await lockCheckout(q, String(ref.id)) : null;
  if (!org || !checkout || checkout.method !== 'payment_link' || (checkout.providerRef && checkout.providerRef !== link.id)) {
    await raiseAlert(q, null, 'unknown_payment_link_paid', { paymentLink: link.id, paymentId: payment?.id ?? null });
    return 'ignored';
  }
  if (checkout.status === 'paid') return 'duplicate';

  const now = deps.now();
  const paymentId = payment?.id ?? `plink:${link.id}`;
  const amount = payment?.amount ?? link.amount_paid ?? 0;
  if (amount !== checkout.totalPaise) {
    await raiseAlert(q, org.id, 'amount_mismatch', { paymentId, received: amount, expected: checkout.totalPaise });
    return 'processed';
  }
  const plan = getPlan(checkout.planKey);
  const active = hasActivePeriod(org, now);
  const pending = checkout.status === 'pending';
  // A renewal is live only for the period it was issued for.
  const liveRenewal =
    checkout.purpose === 'renewal' &&
    pending &&
    checkout.renewsPaidThrough !== null &&
    org.paidThrough !== null &&
    checkout.renewsPaidThrough.getTime() === org.paidThrough.getTime();

  if (checkout.purpose === 'seat_topup') {
    if (pending && active && org.planKey === checkout.planKey) {
      await q.query('UPDATE orgs SET seat_limit = GREATEST(seat_limit, $2), updated_at = now() WHERE id = $1', [
        org.id,
        checkout.seats,
      ]);
    } else {
      await raiseAlert(q, org.id, 'payment_on_stale_checkout', { checkoutId: checkout.id, purpose: checkout.purpose, paymentId });
    }
  } else if (liveRenewal || !active) {
    // A live renewal extends from the current end (also within grace, since the org had access
    // meanwhile). Anything paid while the org has no active period starts a period now.
    const graceMs = deps.config.pastDueGraceDays * 86_400_000;
    const reach = liveRenewal ? graceMs : 0;
    const start = org.paidThrough && org.paidThrough.getTime() > now.getTime() - reach ? org.paidThrough : now;
    const end = addCycle(start, plan.cycle);
    await q.query(
      `UPDATE orgs SET plan_key = $2, plan_tier = $3, seat_limit = $4, renewal_seats = $4, status = 'active',
              collection_method = 'payment_link', subscription_id = NULL, current_period_start = $5,
              paid_through = $6, updated_at = now()
        WHERE id = $1`,
      [org.id, plan.key, plan.tier, checkout.seats, start, end],
    );
    // Billing for this period is settled by link: stop any mandate and other renewal links.
    ctx.actions.push(...(await stopLiveMandates(q, org.id)));
    await withdrawRenewalLinks(ctx, org.id, checkout.id);
  } else {
    // A superseded or second purchase paid while a period is already running: refund needed.
    await raiseAlert(q, org.id, 'payment_on_stale_checkout', { checkoutId: checkout.id, purpose: checkout.purpose, paymentId });
  }
  await q.query("UPDATE checkouts SET status = 'paid', updated_at = now() WHERE id = $1", [checkout.id]);
  const quote = checkout.quote;
  await invoiceOrAlert(
    ctx,
    org,
    () => quote,
    { id: paymentId, amount, currency: payment?.currency ?? 'INR', checkoutId: checkout.id, at: fromUnix(payment?.created_at) ?? now },
    quote.recipient,
  );
  return 'processed';
}
