import { SignJWT } from 'jose';
import { describe, expect, it } from 'vitest';
import { bearerToken, createEmailConfirmer, safeEqual, supabaseVerifier, userFromClaims } from '../src/auth.js';
import { createRazorpayClient, RazorpayError, signWebhookBody, verifyWebhookSignature } from '../src/razorpay.js';
import { JWT_SECRET, SUPABASE_URL, makeUser, testConfig } from './helpers.js';

describe('webhook signatures', () => {
  const body = '{"event":"payment_link.paid"}';
  it('accepts the correct HMAC and rejects anything else', () => {
    const sig = signWebhookBody(body, 'secret-1234567890');
    expect(verifyWebhookSignature(body, sig, 'secret-1234567890')).toBe(true);
    expect(verifyWebhookSignature(body, sig.toUpperCase(), 'secret-1234567890')).toBe(true);
    expect(verifyWebhookSignature(`${body} `, sig, 'secret-1234567890')).toBe(false);
    expect(verifyWebhookSignature(body, sig, 'other-secret-12345')).toBe(false);
    expect(verifyWebhookSignature(body, undefined, 'secret-1234567890')).toBe(false);
    expect(verifyWebhookSignature(body, 'abc', 'secret-1234567890')).toBe(false);
  });
});

describe('razorpay client', () => {
  it('sends authenticated JSON requests and maps responses', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = ((url: string, init: RequestInit) => {
      calls.push({ url, init });
      return Promise.resolve(new Response(JSON.stringify({ id: 'plink_1', short_url: 'https://rzp.io/l/x' }), { status: 200 }));
    }) as unknown as typeof fetch;
    const client = createRazorpayClient({ keyId: 'k', keySecret: 's', apiBase: 'https://api.example', fetchImpl });
    const res = await client.createPaymentLink({
      amountPaise: 1000,
      description: 'd',
      referenceId: 'ref',
      customer: { email: 'a@b.in' },
      expireBy: 2_000_000_000,
      notes: { checkout_id: 'c' },
    });
    expect(res).toEqual({ id: 'plink_1', shortUrl: 'https://rzp.io/l/x' });
    const call = calls[0];
    expect(call?.url).toBe('https://api.example/v1/payment_links');
    const headers = call?.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Basic ${Buffer.from('k:s').toString('base64')}`);
    expect(JSON.parse(call?.init.body as string)).toMatchObject({
      amount: 1000,
      currency: 'INR',
      accept_partial: false,
      reference_id: 'ref',
      notify: { email: true, sms: false },
    });
  });

  it('turns provider errors into RazorpayError', async () => {
    const fetchImpl = (() =>
      Promise.resolve(
        new Response(JSON.stringify({ error: { code: 'BAD_REQUEST_ERROR', description: 'reference_id already exists' } }), {
          status: 400,
        }),
      )) as unknown as typeof fetch;
    const client = createRazorpayClient({ keyId: 'k', keySecret: 's', apiBase: 'https://api.example', fetchImpl });
    await expect(client.cancelSubscription('sub_1', true)).rejects.toMatchObject({
      name: 'RazorpayError',
      status: 400,
      providerCode: 'BAD_REQUEST_ERROR',
      message: 'reference_id already exists',
    });
    expect(new RazorpayError(500, undefined, 'x')).toBeInstanceOf(Error);
  });
});

describe('auth', () => {
  const verify = supabaseVerifier(SUPABASE_URL, JWT_SECRET);
  const key = new TextEncoder().encode(JWT_SECRET);
  const sign = (claims: Record<string, unknown>, sub = '6f1c2b8e-3a4d-4c5e-9f60-7a8b9c0d1e2f', issuer = `${SUPABASE_URL}/auth/v1`) =>
    new SignJWT(claims)
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(sub)
      .setIssuer(issuer)
      .setAudience('authenticated')
      .setExpirationTime('1h')
      .sign(key);

  it('accepts a valid Supabase session', async () => {
    const user = await makeUser('Dev@College.AC.IN');
    await expect(verify(user.token)).resolves.toEqual({ id: user.id, email: 'dev@college.ac.in' });
  });

  it('rejects anon tokens, wrong issuers, bad subjects and tampering', async () => {
    await expect(verify(await sign({ role: 'anon' }))).rejects.toMatchObject({ status: 401 });
    await expect(verify(await sign({ role: 'authenticated' }, undefined, 'https://evil.example/auth/v1'))).rejects.toMatchObject({ status: 401 });
    await expect(verify(await sign({ role: 'authenticated' }, 'not-a-uuid'))).rejects.toMatchObject({ status: 401 });
    const good = await sign({ role: 'authenticated' });
    await expect(verify(`${good.slice(0, -2)}xx`)).rejects.toMatchObject({ status: 401 });
    await expect(verify('garbage')).rejects.toMatchObject({ status: 401 });
  });

  it('rejects HS256 when no legacy secret is configured', async () => {
    const strict = supabaseVerifier(SUPABASE_URL);
    await expect(strict(await sign({ role: 'authenticated' }))).rejects.toMatchObject({ status: 401 });
  });

  it('never takes email verification from the (user-editable) token claims', () => {
    const base = { sub: '6f1c2b8e-3a4d-4c5e-9f60-7a8b9c0d1e2f', role: 'authenticated', email: 'A@B.in' };
    expect(userFromClaims({ ...base, user_metadata: { email_verified: true } })).toEqual({
      id: base.sub,
      email: 'a@b.in',
    });
  });

  it('confirms emails through the Supabase Admin API and caches only positive answers', async () => {
    const id = '6f1c2b8e-3a4d-4c5e-9f60-7a8b9c0d1e2f';
    let body: Record<string, unknown> = { email: 'a@college.ac.in', email_confirmed_at: null };
    let calls = 0;
    const seen: { url: string; headers: Record<string, string> }[] = [];
    const fetchImpl = ((url: string, init: RequestInit) => {
      calls++;
      seen.push({ url, headers: init.headers as Record<string, string> });
      return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
    }) as unknown as typeof fetch;
    const confirm = createEmailConfirmer({ supabaseUrl: SUPABASE_URL, serviceRoleKey: 'srk', fetchImpl });
    const user = { id, email: 'a@college.ac.in' };

    expect(await confirm(user)).toBe(false);
    body = { email: 'a@college.ac.in', email_confirmed_at: '2026-10-01T00:00:00Z' };
    expect(await confirm(user)).toBe(true);
    expect(await confirm(user)).toBe(true);
    expect(calls).toBe(2);
    expect(seen[0]?.url).toBe(`${SUPABASE_URL}/auth/v1/admin/users/${id}`);
    expect(seen[0]?.headers.apikey).toBe('srk');

    // A token whose email differs from the confirmed account email is not confirmed.
    expect(await confirm({ id, email: 'other@college.ac.in' })).toBe(false);
    expect(await confirm({ id, email: null })).toBe(false);
  });

  it('surfaces Admin API outages as 502 rather than a silent "not confirmed"', async () => {
    const fetchImpl = (() => Promise.resolve(new Response('oops', { status: 500 }))) as unknown as typeof fetch;
    const confirm = createEmailConfirmer({ supabaseUrl: SUPABASE_URL, serviceRoleKey: 'srk', fetchImpl });
    await expect(confirm({ id: '6f1c2b8e-3a4d-4c5e-9f60-7a8b9c0d1e2f', email: 'a@b.in' })).rejects.toMatchObject({ status: 502 });
  });

  it('parses bearer headers and compares secrets safely', () => {
    expect(bearerToken('Bearer abc')).toBe('abc');
    expect(bearerToken('bearer abc')).toBe('abc');
    expect(bearerToken('Basic abc')).toBeNull();
    expect(bearerToken(undefined)).toBeNull();
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
  });
});

describe('config', () => {
  it('loads a valid environment and derives the supplier state', () => {
    const config = testConfig();
    expect(config.supplier.stateCode).toBe('24');
    expect(config.razorpay.planIds).toEqual({ team_pro_monthly: 'plan_team_monthly' });
  });

  it('fails fast on a bad supplier GSTIN or short secrets', () => {
    expect(() => testConfig({ SUPPLIER_GSTIN: '24AAACG1234A1ZZ' })).toThrow(/SUPPLIER_GSTIN/);
    expect(() => testConfig({ INTERNAL_API_TOKEN: 'short' })).toThrow(/INTERNAL_API_TOKEN/);
    expect(() => testConfig({ SUPABASE_SERVICE_ROLE_KEY: '' })).toThrow(/SUPABASE_SERVICE_ROLE_KEY/);
  });
});
