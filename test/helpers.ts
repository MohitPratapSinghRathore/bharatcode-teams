import { randomUUID } from 'node:crypto';
import { PGlite, type Transaction } from '@electric-sql/pglite';
import { SignJWT } from 'jose';
import pino from 'pino';
import { supabaseVerifier } from '../src/auth.js';
import { loadConfig, type Config } from '../src/config.js';
import { migrate, type Db, type Queryable, type QueryResult } from '../src/db.js';
import { gstinCheckChar } from '../src/gst.js';
import { createApp } from '../src/http/app.js';
import { signWebhookBody, type CreatePaymentLinkInput, type CreateSubscriptionInput, type RazorpayApi } from '../src/razorpay.js';
import type { Deps } from '../src/services/common.js';

type Runner = Pick<PGlite | Transaction, 'query' | 'exec'>;

function wrap(runner: Runner): Queryable {
  return {
    async query<T>(text: string, params?: readonly unknown[]): Promise<QueryResult<T>> {
      if (!params || params.length === 0) {
        // Parameterless text may hold several statements (migrations), like node-pg's simple protocol.
        const results = await runner.exec(text);
        const last = results.at(-1);
        const rows = (last?.rows ?? []) as T[];
        return { rows, rowCount: Math.max(last?.affectedRows ?? 0, rows.length) };
      }
      const res = await runner.query<T>(text, params as unknown[]);
      return { rows: res.rows, rowCount: Math.max(res.affectedRows ?? 0, res.rows.length) };
    },
  };
}

export async function createTestDb(): Promise<Db & { pg: PGlite }> {
  const pg = await PGlite.create();
  const base = wrap(pg);
  const db = {
    pg,
    query: base.query.bind(base),
    tx: <T>(fn: (q: Queryable) => Promise<T>) => pg.transaction((tx) => fn(wrap(tx))),
    ping: async () => {
      await pg.query('SELECT 1');
    },
    close: () => pg.close(),
  };
  await migrate(db);
  return db;
}

export const SUPABASE_URL = 'https://project.supabase.co';
export const JWT_SECRET = 'test-jwt-secret-that-is-at-least-32-chars';
export const INTERNAL_TOKEN = 'internal-token-that-is-at-least-32-characters';
export const WEBHOOK_SECRET = 'webhook-secret-123456';
// Supplier in Gujarat (24) so Gujarat buyers are intra-state and others inter-state.
export const SUPPLIER_GSTIN = (() => {
  const first14 = '24AAACG1234A1Z';
  return first14 + gstinCheckChar(first14);
})();

export function validGstin(stateCode: string, pan = 'ABCDE1234F'): string {
  const first14 = `${stateCode}${pan}1Z`;
  return first14 + gstinCheckChar(first14);
}

export function testConfig(overrides: Record<string, string> = {}): Config {
  return loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://unused',
    PUBLIC_APP_URL: 'https://bharatcode.ai',
    CORS_ORIGINS: 'https://bharatcode.ai',
    SUPABASE_URL,
    SUPABASE_JWT_SECRET: JWT_SECRET,
    INTERNAL_API_TOKEN: INTERNAL_TOKEN,
    RAZORPAY_KEY_ID: 'rzp_test_key',
    RAZORPAY_KEY_SECRET: 'rzp_test_secret',
    RAZORPAY_WEBHOOK_SECRET: WEBHOOK_SECRET,
    RAZORPAY_PLAN_TEAM_PRO_MONTHLY: 'plan_team_monthly',
    SUPABASE_SERVICE_ROLE_KEY: 'service-role-key-for-tests',
    SUPPLIER_LEGAL_NAME: 'Gupta Edtech Solutions Private Limited',
    SUPPLIER_ADDRESS: 'Ahmedabad, Gujarat',
    SUPPLIER_GSTIN,
    LOG_LEVEL: 'fatal',
    ...overrides,
  });
}

export class FakeRazorpay implements RazorpayApi {
  subscriptions: (CreateSubscriptionInput & { id: string })[] = [];
  links: (CreatePaymentLinkInput & { id: string })[] = [];
  cancelledSubscriptions: { id: string; atCycleEnd: boolean }[] = [];
  cancelledLinks: string[] = [];
  failNextCreate = false;
  private n = 0;

  createSubscription(input: CreateSubscriptionInput) {
    if (this.failNextCreate) {
      this.failNextCreate = false;
      return Promise.reject(new Error('razorpay down'));
    }
    const id = `sub_${++this.n}`;
    this.subscriptions.push({ ...input, id });
    return Promise.resolve({ id, shortUrl: `https://rzp.io/i/${id}`, status: 'created' });
  }
  failNextCancel = false;

  cancelSubscription(id: string, atCycleEnd: boolean) {
    if (this.failNextCancel) {
      this.failNextCancel = false;
      return Promise.reject(new Error('razorpay timeout'));
    }
    this.cancelledSubscriptions.push({ id, atCycleEnd });
    return Promise.resolve();
  }
  createPaymentLink(input: CreatePaymentLinkInput) {
    if (this.failNextCreate) {
      this.failNextCreate = false;
      return Promise.reject(new Error('razorpay down'));
    }
    const id = `plink_${++this.n}`;
    this.links.push({ ...input, id });
    return Promise.resolve({ id, shortUrl: `https://rzp.io/l/${id}` });
  }
  cancelPaymentLink(id: string) {
    this.cancelledLinks.push(id);
    return Promise.resolve();
  }
  fetchPlan() {
    return Promise.reject(new Error('not used in tests'));
  }
}

/** Users whose email the fake Supabase Admin API reports as confirmed. */
const confirmedUsers = new Set<string>();

export interface TestUser {
  id: string;
  email: string;
  token: string;
}

export async function makeUser(email: string, opts: { verified?: boolean } = {}): Promise<TestUser> {
  const id = randomUUID();
  if (opts.verified ?? true) confirmedUsers.add(id);
  // user_metadata.email_verified is user-editable in Supabase; set it to prove it is ignored.
  const token = await new SignJWT({
    role: 'authenticated',
    email,
    user_metadata: { email_verified: true },
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(id)
    .setIssuer(`${SUPABASE_URL}/auth/v1`)
    .setAudience('authenticated')
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(new TextEncoder().encode(JWT_SECRET));
  return { id, email, token };
}

export async function createHarness(overrides: Record<string, string> = {}) {
  const db = await createTestDb();
  const config = testConfig(overrides);
  const razorpay = new FakeRazorpay();
  const clock = { now: new Date('2026-10-22T06:00:00Z') };
  const txt = new Map<string, string[][]>();
  const deps: Deps = {
    db,
    config,
    razorpay,
    log: pino({ level: 'silent' }),
    now: () => new Date(clock.now.getTime()),
    resolveTxt: (host) => {
      const records = txt.get(host);
      if (!records) return Promise.reject(Object.assign(new Error('not found'), { code: 'ENOTFOUND' }));
      return Promise.resolve(records);
    },
    confirmEmail: (user) => Promise.resolve(confirmedUsers.has(user.id)),
  };
  const app = createApp(deps, supabaseVerifier(SUPABASE_URL, JWT_SECRET));
  let eventSeq = 0;

  async function call(method: string, path: string, opts: { user?: TestUser; body?: unknown; token?: string } = {}) {
    const headers: Record<string, string> = {};
    const bearer = opts.token ?? opts.user?.token;
    if (bearer) headers.Authorization = `Bearer ${bearer}`;
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await app.request(path, {
      method,
      headers,
      ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
    });
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = text;
    }
    // Tests read response fields dynamically.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return { status: res.status, body: json as any, headers: res.headers };
  }

  async function webhookRaw(raw: string, eventId: string, secret = WEBHOOK_SECRET) {
    const res = await app.request('/webhooks/razorpay', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Razorpay-Signature': signWebhookBody(raw, secret),
        'X-Razorpay-Event-Id': eventId,
      },
      body: raw,
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return { status: res.status, body: (await res.json()) as any };
  }

  async function webhook(event: string, payload: unknown, opts: { eventId?: string; secret?: string } = {}) {
    const eventId = opts.eventId ?? `evt_${++eventSeq}`;
    // Real deliveries of different events differ in body; include the id so test events do too.
    const raw = JSON.stringify({ entity: 'event', event, payload, account_id: eventId, created_at: unix(clock.now) });
    return webhookRaw(raw, eventId, opts.secret);
  }

  return { db, config, razorpay, clock, txt, deps, app, call, webhook, webhookRaw };
}

export type Harness = Awaited<ReturnType<typeof createHarness>>;

export const unix = (d: Date) => Math.floor(d.getTime() / 1000);
