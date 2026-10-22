import { randomBytes } from 'node:crypto';
import type { AuthUser } from '../auth.js';
import { date, dateOrNull, num } from '../db.js';
import { AppError, badRequest, conflict, forbidden, notFound } from '../errors.js';
import {
  ADMIN_ROLES,
  addMemberLocked,
  audit,
  isUniqueViolation,
  loadOrg,
  requireConfirmedEmail,
  requireRole,
  type Deps,
} from './common.js';

const MAX_DOMAINS = 20;

const DOMAIN_PATTERN = /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/** Shared mailbox providers can never identify an organisation. */
const PUBLIC_EMAIL_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'yahoo.com', 'yahoo.co.in', 'yahoo.in', 'outlook.com', 'hotmail.com',
  'live.com', 'msn.com', 'icloud.com', 'me.com', 'rediffmail.com', 'proton.me', 'protonmail.com',
  'zoho.com', 'zohomail.in', 'aol.com', 'gmx.com', 'yandex.com', 'mail.com',
]);

/** Campus plans are priced for academic institutions, so a campus org needs one of these domains. */
const ACADEMIC_SUFFIXES = ['.ac.in', '.edu.in', '.res.in', '.edu'];

export function isAcademicDomain(domain: string): boolean {
  return ACADEMIC_SUFFIXES.some((s) => domain.endsWith(s));
}

export function normalizeDomain(input: string): string {
  const domain = input.trim().toLowerCase().replace(/\.$/, '');
  if (!DOMAIN_PATTERN.test(domain)) throw badRequest('Enter a valid domain such as example.ac.in');
  if (PUBLIC_EMAIL_DOMAINS.has(domain)) throw badRequest('Public email providers cannot be used as an organisation domain');
  return domain;
}

export function emailDomain(email: string): string | null {
  const at = email.lastIndexOf('@');
  return at > 0 ? email.slice(at + 1).toLowerCase() : null;
}

export function domainMatches(emailDom: string, domain: string, includeSubdomains: boolean): boolean {
  return emailDom === domain || (includeSubdomains && emailDom.endsWith(`.${domain}`));
}

export const verificationHost = (domain: string) => `_bharatcode-verify.${domain}`;
export const verificationValue = (token: string) => `bharatcode-verify=${token}`;

export interface DomainView {
  id: string;
  domain: string;
  includeSubdomains: boolean;
  verified: boolean;
  verifiedAt: string | null;
  dns: { type: 'TXT'; host: string; value: string };
  createdAt: string;
}

function mapDomain(r: Record<string, unknown>): DomainView {
  const domain = String(r.domain);
  const verifiedAt = dateOrNull(r.verified_at);
  return {
    id: String(r.id),
    domain,
    includeSubdomains: Boolean(r.include_subdomains),
    verified: verifiedAt !== null,
    verifiedAt: verifiedAt?.toISOString() ?? null,
    dns: { type: 'TXT', host: verificationHost(domain), value: verificationValue(String(r.verification_token)) },
    createdAt: date(r.created_at).toISOString(),
  };
}

const DOMAIN_COLUMNS = 'id, domain, include_subdomains, verification_token, verified_at, created_at';

export async function addDomain(
  deps: Deps,
  user: AuthUser,
  orgId: string,
  input: { domain: string; includeSubdomains?: boolean | undefined },
): Promise<DomainView> {
  const domain = normalizeDomain(input.domain);
  return deps.db.tx(async (q) => {
    await requireRole(q, orgId, user, ADMIN_ROLES);
    const org = await loadOrg(q, orgId, { lock: true });
    if (!org) throw notFound('Organisation not found');
    const existing = await q.query('SELECT count(*)::int AS n FROM org_domains WHERE org_id = $1', [orgId]);
    if (num(existing.rows[0]?.n ?? 0) >= MAX_DOMAINS) throw conflict(`An organisation can have at most ${MAX_DOMAINS} domains`);
    if (org.kind === 'campus' && !isAcademicDomain(domain)) {
      throw badRequest(`Campus organisations need an academic domain (${ACADEMIC_SUFFIXES.join(', ')})`);
    }
    try {
      const res = await q.query(
        `INSERT INTO org_domains (org_id, domain, include_subdomains, verification_token)
         VALUES ($1, $2, $3, $4) RETURNING ${DOMAIN_COLUMNS}`,
        [orgId, domain, input.includeSubdomains ?? false, randomBytes(16).toString('hex')],
      );
      const row = res.rows[0];
      if (!row) throw new Error('Insert returned no row');
      await audit(q, orgId, user.id, 'domain.added', { domain });
      return mapDomain(row);
    } catch (err) {
      if (isUniqueViolation(err)) throw conflict('This domain is already added');
      throw err;
    }
  });
}

export async function listDomains(deps: Deps, user: AuthUser, orgId: string): Promise<DomainView[]> {
  await requireRole(deps.db, orgId, user, ADMIN_ROLES);
  const res = await deps.db.query(`SELECT ${DOMAIN_COLUMNS} FROM org_domains WHERE org_id = $1 ORDER BY created_at`, [
    orgId,
  ]);
  return res.rows.map(mapDomain);
}

export async function removeDomain(deps: Deps, user: AuthUser, orgId: string, domainId: string): Promise<void> {
  await deps.db.tx(async (q) => {
    await requireRole(q, orgId, user, ADMIN_ROLES);
    const org = await loadOrg(q, orgId, { lock: true });
    if (!org) throw notFound('Organisation not found');
    const res = await q.query('DELETE FROM org_domains WHERE id = $1 AND org_id = $2 RETURNING domain', [domainId, orgId]);
    if (res.rowCount === 0) throw notFound('Domain not found');
    // A paid campus must keep an academic domain: it is what makes the campus price legitimate.
    if (org.kind === 'campus' && org.paidThrough && org.paidThrough > deps.now()) {
      const left = await q.query('SELECT domain FROM org_domains WHERE org_id = $1 AND verified_at IS NOT NULL', [orgId]);
      if (!left.rows.some((r) => isAcademicDomain(String(r.domain)))) {
        throw conflict('A campus with an active plan must keep at least one verified academic domain');
      }
    }
    await audit(q, orgId, user.id, 'domain.removed', { domain: res.rows[0]?.domain });
  });
}

export async function verifyDomain(deps: Deps, user: AuthUser, orgId: string, domainId: string): Promise<DomainView> {
  await requireRole(deps.db, orgId, user, ADMIN_ROLES);
  const found = await deps.db.query(`SELECT ${DOMAIN_COLUMNS} FROM org_domains WHERE id = $1 AND org_id = $2`, [
    domainId,
    orgId,
  ]);
  const row = found.rows[0];
  if (!row) throw notFound('Domain not found');
  if (row.verified_at !== null) return mapDomain(row);

  const domain = String(row.domain);
  const expected = verificationValue(String(row.verification_token));
  let records: string[][];
  try {
    records = await deps.resolveTxt(verificationHost(domain));
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === 'ENOTFOUND' || code === 'ENODATA' || code === 'ESERVFAIL' || code === 'ETIMEOUT') {
      throw new AppError(422, 'bad_request', `No TXT record found at ${verificationHost(domain)} yet. DNS changes can take up to an hour.`);
    }
    throw err;
  }
  // Long TXT values arrive split into chunks; each record is the concatenation of its chunks.
  if (!records.some((chunks) => chunks.join('').trim() === expected)) {
    throw new AppError(422, 'bad_request', `The TXT record at ${verificationHost(domain)} does not contain ${expected}`);
  }
  try {
    return await deps.db.tx(async (q) => {
      const res = await q.query(
        `UPDATE org_domains SET verified_at = now() WHERE id = $1 AND org_id = $2 RETURNING ${DOMAIN_COLUMNS}`,
        [domainId, orgId],
      );
      const updated = res.rows[0];
      if (!updated) throw notFound('Domain not found');
      await audit(q, orgId, user.id, 'domain.verified', { domain });
      return mapDomain(updated);
    });
  } catch (err) {
    if (isUniqueViolation(err, 'org_domains_verified_unique')) {
      throw conflict('This domain is already verified by another organisation');
    }
    throw err;
  }
}

/** Organisations the user may join because their confirmed email matches a verified domain. */
export async function eligibleOrgs(deps: Deps, user: AuthUser): Promise<{ orgId: string; name: string; kind: string }[]> {
  if (!user.email) return [];
  const dom = emailDomain(user.email);
  if (!dom) return [];
  const res = await deps.db.query(
    `SELECT DISTINCT o.id, o.name, o.kind, d.domain, d.include_subdomains
       FROM org_domains d JOIN orgs o ON o.id = d.org_id
      WHERE d.verified_at IS NOT NULL AND o.domain_join_enabled
        AND (d.domain = $1 OR (d.include_subdomains AND $1 LIKE '%.' || d.domain))`,
    [dom],
  );
  const matches = res.rows
    .filter((r) => domainMatches(dom, String(r.domain), Boolean(r.include_subdomains)))
    .map((r) => ({ orgId: String(r.id), name: String(r.name), kind: String(r.kind) }));
  // Only pay for the Admin API lookup when there is something to offer.
  if (matches.length === 0 || (deps.config.requireEmailVerified && !(await deps.confirmEmail(user)))) return [];
  return matches;
}

export async function joinByDomain(deps: Deps, user: AuthUser, orgId: string): Promise<void> {
  const email = await requireConfirmedEmail(deps, user);
  const dom = emailDomain(email);
  await deps.db.tx(async (q) => {
    const org = await loadOrg(q, orgId, { lock: true });
    if (!org?.domainJoinEnabled) throw notFound('Organisation not found');
    const res = await q.query(
      'SELECT domain, include_subdomains FROM org_domains WHERE org_id = $1 AND verified_at IS NOT NULL',
      [orgId],
    );
    const allowed = dom !== null && res.rows.some((r) => domainMatches(dom, String(r.domain), Boolean(r.include_subdomains)));
    if (!allowed) throw forbidden('Your email domain is not allowed to join this organisation');
    await addMemberLocked(q, org, { id: user.id, email }, 'member', deps.now(), deps.config.seatCooldownDays);
    await audit(q, orgId, user.id, 'member.joined_by_domain', { domain: dom });
  });
}
