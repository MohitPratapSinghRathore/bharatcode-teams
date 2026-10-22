import type { AuthUser } from '../auth.js';
import type { OrgKind } from '../catalog.js';
import { num, date } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { isStateCode, istDate, validateGstin } from '../gst.js';
import { ENDED_SUBSCRIPTION, enqueueCancelAtCycleEnd } from './billing.js';
import { runProviderActions, stopLiveMandates } from './outbox.js';
import {
  ADMIN_ROLES,
  ANY_ROLE,
  ORG_COLUMNS,
  activeMemberCount,
  audit,
  isUniqueViolation,
  loadOrg,
  mapOrg,
  requireRole,
  type Deps,
  type Org,
  type Role,
} from './common.js';

export interface BillingInput {
  billingEmail?: string | null | undefined;
  legalName?: string | null | undefined;
  billingAddress?: string | null | undefined;
  billingStateCode?: string | null | undefined;
  gstin?: string | null | undefined;
}

interface NormalizedBilling {
  billingEmail: string | null;
  legalName: string | null;
  billingAddress: string | null;
  billingStateCode: string | null;
  gstin: string | null;
}

/** Merge a partial billing update onto current values; a GSTIN fixes the state to the GSTIN's state. */
export function normalizeBilling(current: NormalizedBilling, input: BillingInput): NormalizedBilling {
  const pick = (key: keyof NormalizedBilling): string | null => {
    const value: string | null | undefined = input[key];
    if (value === undefined) return current[key];
    if (value === null) return null;
    const trimmed = value.trim();
    return trimmed === '' ? null : trimmed;
  };
  const next: NormalizedBilling = {
    billingEmail: pick('billingEmail')?.toLowerCase() ?? null,
    legalName: pick('legalName'),
    billingAddress: pick('billingAddress'),
    billingStateCode: pick('billingStateCode'),
    gstin: pick('gstin'),
  };
  if (next.billingStateCode !== null && !isStateCode(next.billingStateCode)) {
    throw badRequest('billingStateCode is not a valid GST state code');
  }
  if (next.gstin !== null) {
    const check = validateGstin(next.gstin);
    if (!check.ok) throw badRequest(check.reason);
    next.gstin = check.gstin;
    if (input.billingStateCode && input.billingStateCode !== check.stateCode) {
      throw badRequest('billingStateCode must match the state in the GSTIN');
    }
    next.billingStateCode = check.stateCode;
  }
  return next;
}

export interface OrgView {
  id: string;
  name: string;
  kind: OrgKind;
  role: Role;
  memberCount: number;
  seatLimit: number;
  renewalSeats: number | null;
  status: Org['status'];
  planKey: Org['planKey'];
  planTier: Org['planTier'];
  collectionMethod: Org['collectionMethod'];
  autoRenew: boolean;
  currentPeriodStart: string | null;
  paidThrough: string | null;
  domainJoinEnabled: boolean;
  billing: NormalizedBilling | null;
  createdAt: string;
}

export function toView(org: Org, role: Role, memberCount: number): OrgView {
  const isAdmin = role === 'owner' || role === 'admin';
  return {
    id: org.id,
    name: org.name,
    kind: org.kind,
    role,
    memberCount,
    seatLimit: org.seatLimit,
    renewalSeats: org.renewalSeats,
    status: org.status,
    planKey: org.planKey,
    planTier: org.planTier,
    collectionMethod: org.collectionMethod,
    autoRenew: org.autoRenew,
    currentPeriodStart: org.currentPeriodStart?.toISOString() ?? null,
    paidThrough: org.paidThrough?.toISOString() ?? null,
    domainJoinEnabled: org.domainJoinEnabled,
    billing: isAdmin
      ? {
          billingEmail: org.billingEmail,
          legalName: org.legalName,
          billingAddress: org.billingAddress,
          billingStateCode: org.billingStateCode,
          gstin: org.gstin,
        }
      : null,
    createdAt: org.createdAt.toISOString(),
  };
}

export async function createOrg(
  deps: Deps,
  user: AuthUser,
  input: { name: string; kind: OrgKind; billing?: BillingInput | undefined },
): Promise<OrgView> {
  if (!user.email) throw badRequest('Your account needs an email address to create an organisation');
  const email = user.email;
  const billing = normalizeBilling(
    { billingEmail: email, legalName: null, billingAddress: null, billingStateCode: null, gstin: null },
    input.billing ?? {},
  );
  try {
    return await deps.db.tx(async (q) => {
      const res = await q.query(
        `INSERT INTO orgs (name, kind, billing_email, legal_name, billing_address, billing_state_code, gstin)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING ${ORG_COLUMNS}`,
        [
          input.name.trim(),
          input.kind,
          billing.billingEmail,
          billing.legalName,
          billing.billingAddress,
          billing.billingStateCode,
          billing.gstin,
        ],
      );
      const row = res.rows[0];
      if (!row) throw new Error('Insert returned no row');
      const org = mapOrg(row);
      await q.query("INSERT INTO org_members (org_id, user_id, email, role) VALUES ($1, $2, $3, 'owner')", [
        org.id,
        user.id,
        email,
      ]);
      await audit(q, org.id, user.id, 'org.created', { kind: input.kind });
      return toView(org, 'owner', 1);
    });
  } catch (err) {
    if (isUniqueViolation(err, 'org_members_one_active_org')) {
      throw conflict('You already belong to an organisation. Leave it before creating a new one.');
    }
    throw err;
  }
}

export async function getOrgView(deps: Deps, user: AuthUser, orgId: string): Promise<OrgView> {
  const member = await requireRole(deps.db, orgId, user, ANY_ROLE);
  const org = await loadOrg(deps.db, orgId);
  if (!org) throw notFound('Organisation not found');
  return toView(org, member.role, await activeMemberCount(deps.db, orgId));
}

export async function listMyOrgs(deps: Deps, user: AuthUser): Promise<OrgView[]> {
  const res = await deps.db.query(
    `SELECT ${ORG_COLUMNS.split(',').map((c) => `o.${c.trim()}`).join(', ')}, m.role,
            (SELECT count(*)::int FROM org_members x WHERE x.org_id = o.id AND x.status = 'active') AS member_count
       FROM org_members m JOIN orgs o ON o.id = m.org_id
      WHERE m.user_id = $1 AND m.status = 'active'
      ORDER BY o.created_at`,
    [user.id],
  );
  return res.rows.map((r) => toView(mapOrg(r), r.role as Role, num(r.member_count)));
}

export async function updateOrg(
  deps: Deps,
  user: AuthUser,
  orgId: string,
  input: { name?: string | undefined; autoRenew?: boolean | undefined; domainJoinEnabled?: boolean | undefined; billing?: BillingInput | undefined },
): Promise<OrgView> {
  const result = await deps.db.tx(async (q) => {
    const member = await requireRole(q, orgId, user, ADMIN_ROLES);
    const org = await loadOrg(q, orgId, { lock: true });
    if (!org) throw notFound('Organisation not found');
    const actions: number[] = [];
    if (input.autoRenew === false && org.autoRenew && org.collectionMethod === 'autopay') {
      // Turning auto-renew off must actually stop the debits: the current mandate ends after the
      // cycle already paid for, and any replacement is withdrawn. Turning it back on later
      // renews by payment link (the daily job sends one before the period ends).
      if (org.subscriptionId) {
        const sub = await q.query('SELECT id, provider_subscription_id, status, cancel_scheduled FROM subscriptions WHERE id = $1', [
          org.subscriptionId,
        ]);
        const row = sub.rows[0];
        if (row && !row.cancel_scheduled && !ENDED_SUBSCRIPTION.has(String(row.status))) {
          actions.push(...(await enqueueCancelAtCycleEnd(q, orgId, String(row.id), String(row.provider_subscription_id))));
        }
      }
      actions.push(...(await stopLiveMandates(q, orgId, org.subscriptionId ?? undefined)));
      await q.query("UPDATE orgs SET collection_method = 'payment_link' WHERE id = $1", [orgId]);
    }
    const billing = normalizeBilling(
      {
        billingEmail: org.billingEmail,
        legalName: org.legalName,
        billingAddress: org.billingAddress,
        billingStateCode: org.billingStateCode,
        gstin: org.gstin,
      },
      input.billing ?? {},
    );
    const res = await q.query(
      `UPDATE orgs SET name = $2, auto_renew = $3, domain_join_enabled = $4, billing_email = $5, legal_name = $6,
              billing_address = $7, billing_state_code = $8, gstin = $9, updated_at = now()
        WHERE id = $1 RETURNING ${ORG_COLUMNS}`,
      [
        orgId,
        input.name?.trim() ?? org.name,
        input.autoRenew ?? org.autoRenew,
        input.domainJoinEnabled ?? org.domainJoinEnabled,
        billing.billingEmail,
        billing.legalName,
        billing.billingAddress,
        billing.billingStateCode,
        billing.gstin,
      ],
    );
    const row = res.rows[0];
    if (!row) throw notFound('Organisation not found');
    await audit(q, orgId, user.id, 'org.updated', { fields: Object.keys(input) });
    return { view: toView(mapOrg(row), member.role, await activeMemberCount(q, orgId)), actions };
  });
  await runProviderActions(deps, result.actions);
  return result.view;
}

export interface MemberView {
  userId: string;
  email: string;
  role: Role;
  joinedAt: string;
  usage30d: { requests: number; inputTokens: number; outputTokens: number };
}

export async function listMembers(deps: Deps, user: AuthUser, orgId: string): Promise<MemberView[]> {
  await requireRole(deps.db, orgId, user, ADMIN_ROLES);
  const since = istDate(new Date(deps.now().getTime() - 30 * 86_400_000));
  const res = await deps.db.query(
    `SELECT m.user_id, m.email, m.role, m.joined_at,
            coalesce(sum(u.requests), 0) AS requests,
            coalesce(sum(u.input_tokens), 0) AS input_tokens,
            coalesce(sum(u.output_tokens), 0) AS output_tokens
       FROM org_members m
       LEFT JOIN usage_daily u ON u.org_id = m.org_id AND u.user_id = m.user_id AND u.day >= $2::date
      WHERE m.org_id = $1 AND m.status = 'active'
      GROUP BY m.user_id, m.email, m.role, m.joined_at
      ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, m.joined_at, m.user_id`,
    [orgId, since],
  );
  return res.rows.map((r) => ({
    userId: String(r.user_id),
    email: String(r.email),
    role: r.role as Role,
    joinedAt: date(r.joined_at).toISOString(),
    usage30d: { requests: num(r.requests), inputTokens: num(r.input_tokens), outputTokens: num(r.output_tokens) },
  }));
}

async function ownerCount(q: Parameters<typeof requireRole>[0], orgId: string): Promise<number> {
  const res = await q.query(
    "SELECT count(*)::int AS n FROM org_members WHERE org_id = $1 AND status = 'active' AND role = 'owner'",
    [orgId],
  );
  return num(res.rows[0]?.n ?? 0);
}

/** Remove a member (or yourself). Admins can remove members; only owners can remove admins/owners. */
export async function removeMember(deps: Deps, user: AuthUser, orgId: string, targetUserId: string): Promise<void> {
  await deps.db.tx(async (q) => {
    // Lock the org so concurrent removals cannot both pass the last-owner check.
    if (!(await loadOrg(q, orgId, { lock: true }))) throw notFound('Organisation not found');
    const self = targetUserId === user.id;
    const actor = await requireRole(q, orgId, user, self ? ANY_ROLE : ADMIN_ROLES);
    const res = await q.query(
      "SELECT role FROM org_members WHERE org_id = $1 AND user_id = $2 AND status = 'active'",
      [orgId, targetUserId],
    );
    const target = res.rows[0];
    if (!target) throw notFound('Member not found');
    const targetRole = target.role as Role;
    if (!self && targetRole !== 'member' && actor.role !== 'owner') {
      throw forbidden('Only owners can remove admins or owners');
    }
    if (targetRole === 'owner' && (await ownerCount(q, orgId)) <= 1) {
      throw conflict('An organisation needs at least one owner. Make someone else an owner first.');
    }
    await q.query(
      "UPDATE org_members SET status = 'removed', removed_at = now() WHERE org_id = $1 AND user_id = $2",
      [orgId, targetUserId],
    );
    await audit(q, orgId, user.id, self ? 'member.left' : 'member.removed', { userId: targetUserId });
  });
}

export async function changeRole(
  deps: Deps,
  user: AuthUser,
  orgId: string,
  targetUserId: string,
  role: Role,
): Promise<void> {
  await deps.db.tx(async (q) => {
    if (!(await loadOrg(q, orgId, { lock: true }))) throw notFound('Organisation not found');
    await requireRole(q, orgId, user, ['owner']);
    const res = await q.query(
      "SELECT role FROM org_members WHERE org_id = $1 AND user_id = $2 AND status = 'active'",
      [orgId, targetUserId],
    );
    const target = res.rows[0];
    if (!target) throw notFound('Member not found');
    if (target.role === 'owner' && role !== 'owner' && (await ownerCount(q, orgId)) <= 1) {
      throw conflict('An organisation needs at least one owner');
    }
    await q.query('UPDATE org_members SET role = $3 WHERE org_id = $1 AND user_id = $2', [orgId, targetUserId, role]);
    await audit(q, orgId, user.id, 'member.role_changed', { userId: targetUserId, from: target.role, to: role });
  });
}
