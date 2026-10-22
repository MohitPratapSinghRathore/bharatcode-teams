import type { Logger } from 'pino';
import type { AuthUser, EmailConfirmer } from '../auth.js';
import type { OrgKind, PlanKey, PlanTier } from '../catalog.js';
import type { Config } from '../config.js';
import { date, dateOrNull, num, textOrNull, type Db, type Queryable } from '../db.js';
import { AppError, conflict, forbidden, notFound } from '../errors.js';
import type { RazorpayApi } from '../razorpay.js';

export interface Deps {
  db: Db;
  config: Config;
  razorpay: RazorpayApi;
  log: Logger;
  now: () => Date;
  resolveTxt: (hostname: string) => Promise<string[][]>;
  confirmEmail: EmailConfirmer;
}

/** Throws unless the user's email is confirmed (or confirmation checks are disabled by config). */
export async function requireConfirmedEmail(deps: Deps, user: AuthUser): Promise<string> {
  if (!user.email) throw forbidden('Your account needs an email address');
  if (deps.config.requireEmailVerified && !(await deps.confirmEmail(user))) {
    throw forbidden('Confirm your email address first');
  }
  return user.email;
}

export type Role = 'owner' | 'admin' | 'member';
export type OrgStatus = 'pending' | 'active' | 'past_due' | 'cancelled';
export type CollectionMethod = 'autopay' | 'payment_link';

export interface Org {
  id: string;
  name: string;
  kind: OrgKind;
  billingEmail: string | null;
  legalName: string | null;
  billingAddress: string | null;
  billingStateCode: string | null;
  gstin: string | null;
  planKey: PlanKey | null;
  planTier: PlanTier | null;
  seatLimit: number;
  renewalSeats: number | null;
  status: OrgStatus;
  collectionMethod: CollectionMethod | null;
  subscriptionId: string | null;
  autoRenew: boolean;
  currentPeriodStart: Date | null;
  paidThrough: Date | null;
  domainJoinEnabled: boolean;
  createdAt: Date;
}

export const ORG_COLUMNS = `id, name, kind, billing_email, legal_name, billing_address, billing_state_code, gstin,
  plan_key, plan_tier, seat_limit, renewal_seats, status, collection_method, subscription_id, auto_renew,
  current_period_start, paid_through, domain_join_enabled, created_at`;

type Row = Record<string, unknown>;

const str = (v: unknown): string | null => textOrNull(v)?.trim() ?? null;

export function mapOrg(r: Row): Org {
  return {
    id: String(r.id),
    name: String(r.name),
    kind: r.kind as OrgKind,
    billingEmail: str(r.billing_email),
    legalName: str(r.legal_name),
    billingAddress: str(r.billing_address),
    billingStateCode: str(r.billing_state_code),
    gstin: str(r.gstin),
    planKey: (r.plan_key ?? null) as PlanKey | null,
    planTier: (r.plan_tier ?? null) as PlanTier | null,
    seatLimit: num(r.seat_limit),
    renewalSeats: r.renewal_seats === null ? null : num(r.renewal_seats),
    status: r.status as OrgStatus,
    collectionMethod: (r.collection_method ?? null) as CollectionMethod | null,
    subscriptionId: str(r.subscription_id),
    autoRenew: Boolean(r.auto_renew),
    currentPeriodStart: dateOrNull(r.current_period_start),
    paidThrough: dateOrNull(r.paid_through),
    domainJoinEnabled: Boolean(r.domain_join_enabled),
    createdAt: date(r.created_at),
  };
}

export async function loadOrg(q: Queryable, orgId: string, opts: { lock?: boolean } = {}): Promise<Org | null> {
  const res = await q.query(`SELECT ${ORG_COLUMNS} FROM orgs WHERE id = $1${opts.lock ? ' FOR UPDATE' : ''}`, [orgId]);
  const row = res.rows[0];
  return row ? mapOrg(row) : null;
}

export interface Member {
  orgId: string;
  userId: string;
  email: string;
  role: Role;
  joinedAt: Date;
}

/**
 * The caller's active membership of an org. Non-members get 404 so org ids cannot be probed;
 * members without the needed role get 403.
 */
export async function requireRole(q: Queryable, orgId: string, user: AuthUser, roles: readonly Role[]): Promise<Member> {
  const res = await q.query(
    "SELECT org_id, user_id, email, role, joined_at FROM org_members WHERE org_id = $1 AND user_id = $2 AND status = 'active'",
    [orgId, user.id],
  );
  const row = res.rows[0];
  if (!row) throw notFound('Organisation not found');
  const member: Member = {
    orgId: String(row.org_id),
    userId: String(row.user_id),
    email: String(row.email),
    role: row.role as Role,
    joinedAt: date(row.joined_at),
  };
  if (!roles.includes(member.role)) throw forbidden('Only organisation admins can do this');
  return member;
}

export const ADMIN_ROLES: readonly Role[] = ['owner', 'admin'];

/** Record something about money that needs a human (see docs/INTEGRATION.md for the kinds). */
export async function raiseAlert(
  q: Queryable,
  orgId: string | null,
  kind: string,
  details: Record<string, unknown>,
): Promise<void> {
  await q.query('INSERT INTO billing_alerts (org_id, kind, details) VALUES ($1, $2, $3)', [
    orgId,
    kind,
    JSON.stringify(details),
  ]);
}
export const ANY_ROLE: readonly Role[] = ['owner', 'admin', 'member'];

interface PgLikeError {
  code?: string;
  constraint?: string;
  message?: string;
}

export function isUniqueViolation(err: unknown, constraint?: string): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as PgLikeError;
  if (e.code !== '23505') return false;
  if (!constraint) return true;
  return e.constraint === constraint || (e.message ?? '').includes(constraint);
}

export async function audit(
  q: Queryable,
  orgId: string | null,
  actor: string | null,
  action: string,
  details: Record<string, unknown> = {},
): Promise<void> {
  await q.query('INSERT INTO audit_log (org_id, actor, action, details) VALUES ($1, $2, $3, $4)', [
    orgId,
    actor,
    action,
    JSON.stringify(details),
  ]);
}

export async function activeMemberCount(q: Queryable, orgId: string): Promise<number> {
  const res = await q.query("SELECT count(*)::int AS n FROM org_members WHERE org_id = $1 AND status = 'active'", [orgId]);
  return num(res.rows[0]?.n ?? 0);
}

/** True if the email's domain matches one of the org's verified domains. */
export async function emailMatchesOrgDomain(q: Queryable, orgId: string, email: string): Promise<boolean> {
  const at = email.lastIndexOf('@');
  if (at <= 0) return false;
  const dom = email.slice(at + 1).toLowerCase();
  const res = await q.query('SELECT domain, include_subdomains FROM org_domains WHERE org_id = $1 AND verified_at IS NOT NULL', [
    orgId,
  ]);
  return res.rows.some((r) => {
    const d = String(r.domain);
    return dom === d || (Boolean(r.include_subdomains) && dom.endsWith(`.${d}`));
  });
}

/**
 * Give `user` an active seat in an org the caller has already locked (SELECT ... FOR UPDATE), so
 * concurrent joins cannot overfill it.
 *
 * - Campus seats are priced for students, so every campus member needs an email on one of the
 *   campus's verified domains (callers confirm the email before the transaction).
 * - A seat freed in the last `cooldownDays` stays taken for newcomers (the same person may
 *   rejoin), so one seat cannot be rotated between many people.
 */
export async function addMemberLocked(
  q: Queryable,
  org: Org,
  user: { id: string; email: string },
  role: Role,
  now: Date,
  cooldownDays: number,
): Promise<void> {
  if (!org.paidThrough || org.paidThrough.getTime() <= now.getTime()) {
    throw new AppError(409, 'seat_limit_reached', 'This organisation has no active plan yet');
  }
  if (org.kind === 'campus' && !(await emailMatchesOrgDomain(q, org.id, user.email))) {
    throw forbidden("Campus seats are only for email addresses on the institution's verified domains");
  }
  const res = await q.query(
    `SELECT count(*)::int AS n FROM org_members
      WHERE org_id = $1 AND (status = 'active' OR (removed_at > $2 AND user_id <> $3))`,
    [org.id, new Date(now.getTime() - cooldownDays * 86_400_000), user.id],
  );
  const count = num(res.rows[0]?.n ?? 0);
  if (count >= org.seatLimit) {
    throw new AppError(409, 'seat_limit_reached', 'All seats in this organisation are taken. Ask an admin to add seats.');
  }
  try {
    const res = await q.query(
      `INSERT INTO org_members (org_id, user_id, email, role) VALUES ($1, $2, $3, $4)
       ON CONFLICT (org_id, user_id) DO UPDATE
         SET status = 'active', role = EXCLUDED.role, email = EXCLUDED.email, joined_at = now(), removed_at = NULL
         WHERE org_members.status = 'removed'
       RETURNING user_id`,
      [org.id, user.id, user.email, role],
    );
    if (res.rowCount === 0) throw conflict('You are already a member of this organisation');
  } catch (err) {
    if (isUniqueViolation(err, 'org_members_one_active_org')) {
      throw conflict('You already have a seat in another organisation. Leave it before joining this one.');
    }
    throw err;
  }
}
