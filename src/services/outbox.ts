import { num, textOrNull, type Queryable } from '../db.js';
import { RazorpayError } from '../razorpay.js';
import { raiseAlert, type CollectionMethod, type Deps } from './common.js';

/**
 * Transactional outbox for Razorpay cancellations. A cancellation is recorded in the same
 * transaction as the decision that requires it, executed right after commit, and retried by
 * a job until it succeeds, so a crash or a provider outage can never leave a mandate charging.
 */

export interface ProviderRef {
  method: CollectionMethod;
  ref: string;
}

const MAX_ATTEMPTS = 8;

export async function enqueueCancels(
  q: Queryable,
  orgId: string | null,
  refs: ProviderRef[],
  opts: { atCycleEnd?: boolean } = {},
): Promise<number[]> {
  const ids: number[] = [];
  for (const r of refs) {
    const res = await q.query(
      'INSERT INTO provider_actions (org_id, method, ref, at_cycle_end) VALUES ($1, $2, $3, $4) RETURNING id',
      [orgId, r.method, r.ref, opts.atCycleEnd ?? false],
    );
    ids.push(num(res.rows[0]?.id));
  }
  return ids;
}

export interface ActionRunResult {
  done: number;
  failed: number;
  retrying: number;
}

/**
 * Execute pending actions (only `onlyIds` if given). Rows are claimed with SKIP LOCKED and a
 * lease, so concurrent runners never execute the same action twice at once. A 4xx from Razorpay
 * is permanent; anything else is retried with exponential backoff, then raised as an alert.
 */
export async function runProviderActions(deps: Deps, onlyIds?: number[]): Promise<ActionRunResult> {
  const result: ActionRunResult = { done: 0, failed: 0, retrying: 0 };
  if (onlyIds?.length === 0) return result;
  const claimed = await deps.db.query(
    `UPDATE provider_actions SET attempts = attempts + 1, locked_until = now() + interval '5 minutes'
      WHERE id IN (
        SELECT id FROM provider_actions
         WHERE done_at IS NULL AND failed_at IS NULL AND (locked_until IS NULL OR locked_until < now())
           AND ($1::bigint[] IS NULL OR id = ANY($1::bigint[]))
         ORDER BY id LIMIT 200
         FOR UPDATE SKIP LOCKED)
      RETURNING id, org_id, method, ref, at_cycle_end, attempts`,
    [onlyIds ?? null],
  );
  const rows = [...claimed.rows].sort((a, b) => num(a.id) - num(b.id));
  for (const row of rows) {
    const id = num(row.id);
    const ref = String(row.ref);
    try {
      if (row.method === 'autopay') await deps.razorpay.cancelSubscription(ref, Boolean(row.at_cycle_end));
      else await deps.razorpay.cancelPaymentLink(ref);
      await deps.db.query('UPDATE provider_actions SET done_at = now(), locked_until = NULL, last_error = NULL WHERE id = $1', [id]);
      result.done++;
    } catch (err) {
      const attempts = num(row.attempts);
      const permanent = err instanceof RazorpayError && err.status >= 400 && err.status < 500;
      const giveUp = permanent || attempts >= MAX_ATTEMPTS;
      const message = err instanceof Error ? err.message : String(err);
      await deps.db.query(
        `UPDATE provider_actions
            SET last_error = $2,
                failed_at = CASE WHEN $3 THEN now() END,
                locked_until = CASE WHEN $3 THEN NULL ELSE now() + interval '1 minute' * power(2, $4::int) END
          WHERE id = $1`,
        [id, message.slice(0, 500), giveUp, Math.min(attempts, 10)],
      );
      deps.log.error({ err, actionId: id, ref }, 'provider action failed');
      if (giveUp) {
        await raiseAlert(deps.db, textOrNull(row.org_id), 'provider_action_failed', {
          actionId: id,
          method: row.method,
          ref,
          atCycleEnd: Boolean(row.at_cycle_end),
          error: message,
        });
        result.failed++;
      } else {
        result.retrying++;
      }
    }
  }
  return result;
}

/**
 * Stop every mandate of an org that could still charge (optionally keeping one), and withdraw
 * their unpaid checkouts. Used when billing moves to payment links or a period is paid by link.
 */
export async function stopLiveMandates(q: Queryable, orgId: string, keepSubId?: string): Promise<number[]> {
  const subs = await q.query(
    `SELECT id, provider_subscription_id, checkout_id FROM subscriptions
      WHERE org_id = $1 AND status IN ('created', 'authenticated', 'active') AND NOT cancel_scheduled
        AND id IS DISTINCT FROM $2::uuid`,
    [orgId, keepSubId ?? null],
  );
  if (subs.rows.length === 0) return [];
  await q.query(
    `UPDATE subscriptions SET cancel_scheduled = true, updated_at = now()
      WHERE id = ANY($1::uuid[])`,
    [subs.rows.map((r) => String(r.id))],
  );
  await q.query(
    `UPDATE checkouts SET status = 'superseded', updated_at = now()
      WHERE id = ANY($1::uuid[]) AND status = 'pending'`,
    [subs.rows.map((r) => textOrNull(r.checkout_id)).filter((v): v is string => v !== null)],
  );
  return enqueueCancels(
    q,
    orgId,
    subs.rows.map((r) => ({ method: 'autopay', ref: String(r.provider_subscription_id) })),
  );
}
