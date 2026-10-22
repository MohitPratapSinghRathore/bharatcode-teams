import { createHash, randomBytes } from 'node:crypto';
import type { AuthUser } from '../auth.js';
import { date, dateOrNull, num, textOrNull } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import {
  ADMIN_ROLES,
  addMemberLocked,
  audit,
  loadOrg,
  requireConfirmedEmail,
  requireRole,
  type Deps,
  type Role,
} from './common.js';

const DEFAULT_EXPIRY_DAYS = 14;
const MAX_OPEN_INVITES = 200;

export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export interface InviteView {
  id: string;
  email: string | null;
  role: Exclude<Role, 'owner'>;
  maxUses: number;
  uses: number;
  expiresAt: string;
  createdAt: string;
}

function mapInvite(r: Record<string, unknown>): InviteView {
  return {
    id: String(r.id),
    email: textOrNull(r.email),
    role: r.role as Exclude<Role, 'owner'>,
    maxUses: num(r.max_uses),
    uses: num(r.uses),
    expiresAt: date(r.expires_at).toISOString(),
    createdAt: date(r.created_at).toISOString(),
  };
}

export interface CreatedInvite {
  invite: InviteView;
  /** Shown once; only its hash is stored. */
  url: string;
  whatsappUrl: string;
}

export async function createInvite(
  deps: Deps,
  user: AuthUser,
  orgId: string,
  input: {
    email?: string | undefined;
    role?: Exclude<Role, 'owner'> | undefined;
    maxUses?: number | undefined;
    expiresInDays?: number | undefined;
  },
): Promise<CreatedInvite> {
  const email = input.email?.trim().toLowerCase() || null;
  const role = input.role ?? 'member';
  const maxUses = email ? 1 : (input.maxUses ?? 1);
  if (email && input.maxUses !== undefined && input.maxUses !== 1) {
    throw badRequest('An invite for a specific email can be used once');
  }
  if (role === 'admin' && maxUses !== 1) throw badRequest('Admin invites must be single-use');
  const days = input.expiresInDays ?? DEFAULT_EXPIRY_DAYS;
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(deps.now().getTime() + days * 86_400_000);

  return deps.db.tx(async (q) => {
    const actor = await requireRole(q, orgId, user, ADMIN_ROLES);
    if (role === 'admin' && actor.role !== 'owner') throw forbidden('Only owners can invite admins');
    const org = await loadOrg(q, orgId, { lock: true });
    if (!org) throw notFound('Organisation not found');
    const open = await q.query(
      'SELECT count(*)::int AS n FROM org_invites WHERE org_id = $1 AND revoked_at IS NULL AND expires_at > $2 AND uses < max_uses',
      [orgId, deps.now()],
    );
    if (num(open.rows[0]?.n ?? 0) >= MAX_OPEN_INVITES) {
      throw conflict(`An organisation can have at most ${MAX_OPEN_INVITES} open invites. Revoke some first.`);
    }
    const res = await q.query(
      `INSERT INTO org_invites (org_id, email, role, token_hash, max_uses, expires_at, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, email, role, max_uses, uses, expires_at, created_at`,
      [orgId, email, role, hashToken(token), maxUses, expiresAt, user.id],
    );
    const row = res.rows[0];
    if (!row) throw new Error('Insert returned no row');
    await audit(q, orgId, user.id, 'invite.created', { inviteId: row.id, email, role, maxUses });
    const url = `${deps.config.publicAppUrl}/join?invite=${token}`;
    const message = `Join ${org.name} on BharatCode: ${url}`;
    return { invite: mapInvite(row), url, whatsappUrl: `https://wa.me/?text=${encodeURIComponent(message)}` };
  });
}

export async function listInvites(deps: Deps, user: AuthUser, orgId: string): Promise<InviteView[]> {
  await requireRole(deps.db, orgId, user, ADMIN_ROLES);
  const res = await deps.db.query(
    `SELECT id, email, role, max_uses, uses, expires_at, created_at FROM org_invites
      WHERE org_id = $1 AND revoked_at IS NULL AND expires_at > $2 AND uses < max_uses
      ORDER BY created_at DESC`,
    [orgId, deps.now()],
  );
  return res.rows.map(mapInvite);
}

export async function revokeInvite(deps: Deps, user: AuthUser, orgId: string, inviteId: string): Promise<void> {
  await deps.db.tx(async (q) => {
    await requireRole(q, orgId, user, ADMIN_ROLES);
    const res = await q.query(
      'UPDATE org_invites SET revoked_at = now() WHERE id = $1 AND org_id = $2 AND revoked_at IS NULL RETURNING id',
      [inviteId, orgId],
    );
    if (res.rowCount === 0) throw notFound('Invite not found');
    await audit(q, orgId, user.id, 'invite.revoked', { inviteId });
  });
}

/** Public preview for the join page; the token itself is the credential. */
export async function previewInvite(
  deps: Deps,
  token: string,
): Promise<{ orgName: string; orgKind: string; role: string; emailRestricted: boolean }> {
  const res = await deps.db.query(
    `SELECT o.name, o.kind, i.role, i.email, i.expires_at, i.revoked_at, i.uses, i.max_uses
       FROM org_invites i JOIN orgs o ON o.id = i.org_id WHERE i.token_hash = $1`,
    [hashToken(token)],
  );
  const r = res.rows[0];
  if (!r || dateOrNull(r.revoked_at) || date(r.expires_at) <= deps.now() || num(r.uses) >= num(r.max_uses)) {
    throw notFound('This invite link is invalid or has expired');
  }
  return { orgName: String(r.name), orgKind: String(r.kind), role: String(r.role), emailRestricted: r.email !== null };
}

export async function acceptInvite(deps: Deps, user: AuthUser, token: string): Promise<{ orgId: string }> {
  if (!user.email) throw badRequest('Your account needs an email address to join an organisation');
  const email = user.email;
  // Email confirmation is a network call, so decide whether it is needed before locking rows.
  const peek = await deps.db.query(
    'SELECT i.email, o.kind FROM org_invites i JOIN orgs o ON o.id = i.org_id WHERE i.token_hash = $1',
    [hashToken(token)],
  );
  const target = peek.rows[0];
  if (target && (target.email !== null || target.kind === 'campus')) await requireConfirmedEmail(deps, user);

  return deps.db.tx(async (q) => {
    const res = await q.query(
      `SELECT id, org_id, email, role, expires_at, revoked_at, uses, max_uses
         FROM org_invites WHERE token_hash = $1 FOR UPDATE`,
      [hashToken(token)],
    );
    const inv = res.rows[0];
    const now = deps.now();
    if (!inv || dateOrNull(inv.revoked_at) || date(inv.expires_at) <= now || num(inv.uses) >= num(inv.max_uses)) {
      throw notFound('This invite link is invalid or has expired');
    }
    if (inv.email !== null && textOrNull(inv.email) !== email) {
      throw forbidden('This invite was sent to a different email address');
    }
    const orgId = String(inv.org_id);
    const org = await loadOrg(q, orgId, { lock: true });
    if (!org) throw notFound('This invite link is invalid or has expired');
    await addMemberLocked(q, org, { id: user.id, email }, inv.role as Role, now, deps.config.seatCooldownDays);
    await q.query('UPDATE org_invites SET uses = uses + 1 WHERE id = $1', [inv.id]);
    await audit(q, orgId, user.id, 'invite.accepted', { inviteId: inv.id });
    return { orgId };
  });
}
