import { timingSafeEqual } from 'node:crypto';
import { createRemoteJWKSet, decodeProtectedHeader, jwtVerify, type JWTPayload, type JWTVerifyOptions } from 'jose';
import { AppError, unauthorized } from './errors.js';

export interface AuthUser {
  id: string;
  email: string | null;
}

export type TokenVerifier = (token: string) => Promise<AuthUser>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function userFromClaims(payload: JWTPayload): AuthUser {
  const sub = payload.sub;
  if (typeof sub !== 'string' || !UUID.test(sub)) throw unauthorized('Invalid session');
  // Supabase issues `anon` tokens to signed-out clients; only real sessions may use this API.
  if (payload.role !== 'authenticated') throw unauthorized('Invalid session');
  const email = typeof payload.email === 'string' && payload.email.includes('@') ? payload.email.toLowerCase() : null;
  // Deliberately no "email verified" flag from the token: user_metadata is user-editable in
  // Supabase, so confirmation is checked server-side (see createEmailConfirmer).
  return { id: sub.toLowerCase(), email };
}

/** Returns true when the user's current email address has been confirmed. */
export type EmailConfirmer = (user: AuthUser) => Promise<boolean>;

/**
 * Confirms emails through the Supabase Admin API (email_confirmed_at), which users cannot edit.
 * Positive answers are cached briefly; the address must still match the token's email.
 */
export function createEmailConfirmer(opts: {
  supabaseUrl: string;
  serviceRoleKey: string;
  fetchImpl?: typeof fetch;
  ttlMs?: number;
  now?: () => number;
}): EmailConfirmer {
  const doFetch = opts.fetchImpl ?? fetch;
  const ttl = opts.ttlMs ?? 10 * 60_000;
  const now = opts.now ?? Date.now;
  const cache = new Map<string, number>();
  return async (user) => {
    if (!user.email) return false;
    const key = `${user.id}|${user.email}`;
    const until = cache.get(key);
    if (until !== undefined && until > now()) return true;
    const res = await doFetch(`${opts.supabaseUrl}/auth/v1/admin/users/${encodeURIComponent(user.id)}`, {
      headers: { apikey: opts.serviceRoleKey, Authorization: `Bearer ${opts.serviceRoleKey}` },
      signal: AbortSignal.timeout(5_000),
    });
    if (res.status === 404) return false;
    if (!res.ok) throw new AppError(502, 'internal', 'Could not verify your email right now. Please try again.');
    const body = (await res.json()) as { email?: unknown; email_confirmed_at?: unknown };
    const confirmed =
      typeof body.email === 'string' && body.email.toLowerCase() === user.email && typeof body.email_confirmed_at === 'string';
    if (confirmed) {
      if (cache.size > 50_000) cache.clear();
      cache.set(key, now() + ttl);
    }
    return confirmed;
  };
}

/**
 * Verifies Supabase access tokens. Asymmetric signing keys (RS256/ES256) are checked against the
 * project's JWKS; HS256 is accepted only when the legacy JWT secret is configured.
 */
export function supabaseVerifier(supabaseUrl: string, legacySecret?: string): TokenVerifier {
  const issuer = `${supabaseUrl}/auth/v1`;
  const jwks = createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks.json`), {
    cooldownDuration: 30_000,
    cacheMaxAge: 10 * 60_000,
  });
  const hsKey = legacySecret ? new TextEncoder().encode(legacySecret) : null;
  const base: JWTVerifyOptions = { issuer, audience: 'authenticated', clockTolerance: 30 };

  return async (token) => {
    let alg: string | undefined;
    try {
      alg = decodeProtectedHeader(token).alg;
    } catch {
      throw unauthorized('Invalid session');
    }
    try {
      if (alg === 'HS256') {
        if (!hsKey) throw unauthorized('Invalid session');
        const { payload } = await jwtVerify(token, hsKey, { ...base, algorithms: ['HS256'] });
        return userFromClaims(payload);
      }
      const { payload } = await jwtVerify(token, jwks, { ...base, algorithms: ['RS256', 'ES256'] });
      return userFromClaims(payload);
    } catch (err) {
      if (err instanceof AppError) throw err;
      throw unauthorized('Invalid or expired session');
    }
  };
}

export function bearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(\S+)$/i.exec(header);
  return match?.[1] ?? null;
}

/** Constant-time string comparison for shared secrets. */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) {
    // Compare against itself so the timing does not reveal the length mismatch early.
    timingSafeEqual(ab, ab);
    return false;
  }
  return timingSafeEqual(ab, bb);
}
