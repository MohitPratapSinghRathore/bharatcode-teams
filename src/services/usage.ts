import type { AuthUser } from '../auth.js';
import type { PlanTier } from '../catalog.js';
import { date, dateOrNull, num, textOrNull } from '../db.js';
import { badRequest } from '../errors.js';
import { istDate } from '../gst.js';
import { ADMIN_ROLES, requireRole, type Deps, type OrgStatus } from './common.js';

export interface Entitlement {
  userId: string;
  entitled: boolean;
  tier: PlanTier | null;
  orgId: string | null;
  /** Paid Pro seats get Zero Data Retention, matching the individual Pro policy. */
  zdr: boolean;
  paidThrough: string | null;
  reason: 'ok' | 'no_org' | 'not_paid' | 'expired' | 'over_seat_limit';
}

/**
 * What the model gateway should grant a user through their org. When an org has more active
 * members than seats (after a seat reduction), owners, then admins, then the earliest joiners keep
 * access, so the outcome is deterministic.
 */
export async function getEntitlement(deps: Deps, userId: string): Promise<Entitlement> {
  const res = await deps.db.query(
    `WITH mine AS (
       SELECT org_id FROM org_members WHERE user_id = $1 AND status = 'active'
     ), ranked AS (
       SELECT m.user_id, m.org_id,
              row_number() OVER (
                PARTITION BY m.org_id
                ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, m.joined_at, m.user_id
              ) AS seat_rank
         FROM org_members m JOIN mine ON mine.org_id = m.org_id
        WHERE m.status = 'active'
     )
     SELECT o.id, o.plan_tier, o.status, o.paid_through, o.seat_limit, r.seat_rank
       FROM ranked r JOIN orgs o ON o.id = r.org_id
      WHERE r.user_id = $1`,
    [userId],
  );
  const row = res.rows[0];
  const none: Entitlement = { userId, entitled: false, tier: null, orgId: null, zdr: false, paidThrough: null, reason: 'no_org' };
  if (!row) return none;

  const orgId = String(row.id);
  const paidThrough = dateOrNull(row.paid_through);
  const tier = (row.plan_tier ?? null) as PlanTier | null;
  const base = { ...none, orgId, tier, paidThrough: paidThrough?.toISOString() ?? null };
  if (!paidThrough || !tier) return { ...base, reason: 'not_paid' };

  const status = row.status as OrgStatus;
  const graceMs = status === 'past_due' ? deps.config.pastDueGraceDays * 86_400_000 : 0;
  if (deps.now().getTime() >= paidThrough.getTime() + graceMs) return { ...base, reason: 'expired' };
  if (num(row.seat_rank) > num(row.seat_limit)) return { ...base, reason: 'over_seat_limit' };
  return { ...base, entitled: true, zdr: tier === 'pro', reason: 'ok' };
}

export interface UsageEvent {
  userId: string;
  at: Date;
  requests: number;
  inputTokens: number;
  outputTokens: number;
}

/**
 * Ingest a batch of usage from the gateway. Idempotent per batch id. Only users holding an
 * active seat are recorded; days are bucketed in IST so dashboards match what users see.
 */
export async function ingestUsage(
  deps: Deps,
  batchId: string,
  events: UsageEvent[],
): Promise<{ duplicate: boolean; recorded: number; skipped: number }> {
  return deps.db.tx(async (q) => {
    const fresh = await q.query(
      'INSERT INTO usage_batches (batch_id) VALUES ($1) ON CONFLICT (batch_id) DO NOTHING RETURNING batch_id',
      [batchId],
    );
    if (fresh.rowCount === 0) return { duplicate: true, recorded: 0, skipped: 0 };

    const userIds = [...new Set(events.map((e) => e.userId))];
    const seats = await q.query("SELECT user_id, org_id FROM org_members WHERE status = 'active' AND user_id = ANY($1::uuid[])", [
      userIds,
    ]);
    const orgOf = new Map(seats.rows.map((r) => [String(r.user_id), String(r.org_id)]));

    // Aggregate first: one upsert row per (org, user, day), which Postgres requires in a single statement.
    const agg = new Map<string, { orgId: string; userId: string; day: string; requests: number; input: number; output: number }>();
    let skipped = 0;
    for (const e of events) {
      const orgId = orgOf.get(e.userId);
      if (!orgId) {
        skipped++;
        continue;
      }
      const day = istDate(e.at);
      const key = `${orgId}|${e.userId}|${day}`;
      const cur = agg.get(key) ?? { orgId, userId: e.userId, day, requests: 0, input: 0, output: 0 };
      cur.requests += e.requests;
      cur.input += e.inputTokens;
      cur.output += e.outputTokens;
      agg.set(key, cur);
    }
    const rows = [...agg.values()];
    if (rows.length > 0) {
      await q.query(
        `INSERT INTO usage_daily (org_id, user_id, day, requests, input_tokens, output_tokens)
         SELECT * FROM unnest($1::uuid[], $2::uuid[], $3::date[], $4::bigint[], $5::bigint[], $6::bigint[])
         ON CONFLICT (org_id, user_id, day) DO UPDATE SET
           requests = usage_daily.requests + EXCLUDED.requests,
           input_tokens = usage_daily.input_tokens + EXCLUDED.input_tokens,
           output_tokens = usage_daily.output_tokens + EXCLUDED.output_tokens`,
        [
          rows.map((r) => r.orgId),
          rows.map((r) => r.userId),
          rows.map((r) => r.day),
          rows.map((r) => r.requests),
          rows.map((r) => r.input),
          rows.map((r) => r.output),
        ],
      );
    }
    return { duplicate: false, recorded: events.length - skipped, skipped };
  });
}

export interface UsageReport {
  from: string;
  to: string;
  totals: { requests: number; inputTokens: number; outputTokens: number };
  daily: { day: string; requests: number; inputTokens: number; outputTokens: number }[];
  members: { userId: string; email: string | null; requests: number; inputTokens: number; outputTokens: number; lastActive: string | null }[];
}

const MAX_RANGE_DAYS = 92;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

export async function usageReport(
  deps: Deps,
  user: AuthUser,
  orgId: string,
  range: { from?: string | undefined; to?: string | undefined },
): Promise<UsageReport> {
  await requireRole(deps.db, orgId, user, ADMIN_ROLES);
  const to = range.to ?? istDate(deps.now());
  const from = range.from ?? istDate(new Date(date(`${to}T00:00:00Z`).getTime() - 29 * 86_400_000));
  if (!DAY.test(from) || !DAY.test(to)) throw badRequest('from and to must be YYYY-MM-DD');
  const span = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000;
  if (!Number.isFinite(span) || span < 0) throw badRequest('from must be on or before to');
  if (span >= MAX_RANGE_DAYS) throw badRequest(`The range can cover at most ${MAX_RANGE_DAYS} days`);

  const daily = await deps.db.query(
    `SELECT day::text AS day, sum(requests) AS requests, sum(input_tokens) AS input_tokens, sum(output_tokens) AS output_tokens
       FROM usage_daily WHERE org_id = $1 AND day BETWEEN $2::date AND $3::date
      GROUP BY day ORDER BY day`,
    [orgId, from, to],
  );
  const members = await deps.db.query(
    `SELECT u.user_id, m.email, sum(u.requests) AS requests, sum(u.input_tokens) AS input_tokens,
            sum(u.output_tokens) AS output_tokens, max(u.day)::text AS last_active
       FROM usage_daily u LEFT JOIN org_members m ON m.org_id = u.org_id AND m.user_id = u.user_id
      WHERE u.org_id = $1 AND u.day BETWEEN $2::date AND $3::date
      GROUP BY u.user_id, m.email ORDER BY sum(u.input_tokens) + sum(u.output_tokens) DESC`,
    [orgId, from, to],
  );
  const dailyRows = daily.rows.map((r) => ({
    day: String(r.day),
    requests: num(r.requests),
    inputTokens: num(r.input_tokens),
    outputTokens: num(r.output_tokens),
  }));
  return {
    from,
    to,
    totals: dailyRows.reduce(
      (t, d) => ({
        requests: t.requests + d.requests,
        inputTokens: t.inputTokens + d.inputTokens,
        outputTokens: t.outputTokens + d.outputTokens,
      }),
      { requests: 0, inputTokens: 0, outputTokens: 0 },
    ),
    daily: dailyRows,
    members: members.rows.map((r) => ({
      userId: String(r.user_id),
      email: textOrNull(r.email),
      requests: num(r.requests),
      inputTokens: num(r.input_tokens),
      outputTokens: num(r.output_tokens),
      lastActive: textOrNull(r.last_active),
    })),
  };
}
