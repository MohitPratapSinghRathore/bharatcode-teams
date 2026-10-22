// End-to-end smoke test: the built bharatcode-teams server, over real HTTP, against a real
// Postgres wire-protocol server (PGlite socket), with local stand-ins for Razorpay and Supabase.
// Run with `npm run build && npm run smoke`.
import { spawn } from 'node:child_process';
import { createHmac, randomUUID } from 'node:crypto';
import http from 'node:http';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { SignJWT } from 'jose';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const SERVER = join(REPO, 'dist', 'server.js');
const { gstinCheckChar } = await import(pathToFileURL(join(REPO, 'dist', 'gst.js')).href);

const DB_PORT = 55432;
const STUB_PORT = 54010;
const APP_PORT = 58080;
const STUB = `http://127.0.0.1:${STUB_PORT}`;
const APP = `http://127.0.0.1:${APP_PORT}`;
const JWT_SECRET = 'e2e-jwt-secret-that-is-at-least-32-chars!!';
const INTERNAL = 'e2e-internal-token-that-is-at-least-32-chars';
const WEBHOOK_SECRET = 'e2e-webhook-secret-123';
const SUPPLIER_GSTIN = '24AAACG1234A1Z' + gstinCheckChar('24AAACG1234A1Z');

// ---------- stubs: Razorpay + Supabase Admin API ----------
const calls = [];
const confirmed = new Map(); // userId -> email
let n = 0;
const stub = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const send = (code, obj) => {
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(obj));
    };
    calls.push({ method: req.method, url: req.url, body: body ? JSON.parse(body) : null });
    const url = req.url ?? '';
    if (url.startsWith('/auth/v1/admin/users/')) {
      const id = decodeURIComponent(url.split('/').pop());
      const email = confirmed.get(id);
      return email ? send(200, { id, email, email_confirmed_at: '2026-10-01T00:00:00Z' }) : send(404, {});
    }
    if (req.method === 'GET' && url === '/v1/plans/plan_team_monthly') {
      return send(200, { id: 'plan_team_monthly', period: 'monthly', interval: 1, item: { amount: 117882, currency: 'INR' } });
    }
    if (req.method === 'POST' && url === '/v1/subscriptions') {
      const id = `sub_${++n}`;
      return send(200, { id, short_url: `https://rzp.io/i/${id}`, status: 'created' });
    }
    if (req.method === 'POST' && url === '/v1/payment_links') {
      const id = `plink_${++n}`;
      return send(200, { id, short_url: `https://rzp.io/l/${id}` });
    }
    if (req.method === 'POST' && /\/cancel$/.test(url)) return send(200, {});
    send(404, { error: { description: 'not stubbed' } });
  });
});
await new Promise((r) => stub.listen(STUB_PORT, '127.0.0.1', r));

// ---------- real Postgres protocol server ----------
const pglite = await PGlite.create();
const pgServer = new PGLiteSocketServer({ db: pglite, port: DB_PORT, host: '127.0.0.1' });
await pgServer.start();

// ---------- the actual built service ----------
const env = {
  ...process.env,
  NODE_ENV: 'production',
  PORT: String(APP_PORT),
  LOG_LEVEL: 'warn',
  DATABASE_URL: `postgres://postgres@127.0.0.1:${DB_PORT}/postgres?sslmode=disable`,
  DATABASE_POOL_MAX: '1',
  PUBLIC_APP_URL: 'https://bharatcode.ai',
  CORS_ORIGINS: 'https://bharatcode.ai',
  SUPABASE_URL: STUB,
  SUPABASE_JWT_SECRET: JWT_SECRET,
  SUPABASE_SERVICE_ROLE_KEY: 'e2e-service-role-key-xxxxxxxx',
  INTERNAL_API_TOKEN: INTERNAL,
  RAZORPAY_KEY_ID: 'rzp_test',
  RAZORPAY_KEY_SECRET: 'secret',
  RAZORPAY_WEBHOOK_SECRET: WEBHOOK_SECRET,
  RAZORPAY_API_BASE: STUB,
  RAZORPAY_PLAN_TEAM_PRO_MONTHLY: 'plan_team_monthly',
  SUPPLIER_LEGAL_NAME: 'Gupta Edtech Solutions Private Limited',
  SUPPLIER_ADDRESS: 'Ahmedabad, Gujarat',
  SUPPLIER_GSTIN,
};
const server = spawn(process.execPath, [SERVER], { env, stdio: ['ignore', 'pipe', 'pipe'] });
let serverLog = '';
server.stdout.on('data', (d) => (serverLog += d));
server.stderr.on('data', (d) => (serverLog += d));

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `  -> ${detail}`}`);
}

async function api(method, path, { token, body, raw, headers = {} } = {}) {
  const res = await fetch(`${APP}${path}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined || raw !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...headers,
    },
    body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: res.status, body: json, headers: res.headers };
}

async function user(email, isConfirmed = true) {
  const id = randomUUID();
  if (isConfirmed) confirmed.set(id, email);
  const token = await new SignJWT({ role: 'authenticated', email })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(id)
    .setIssuer(`${STUB}/auth/v1`)
    .setAudience('authenticated')
    .setExpirationTime('1h')
    .sign(new TextEncoder().encode(JWT_SECRET));
  return { id, email, token };
}

async function webhook(event, payload, eventId = randomUUID(), secret = WEBHOOK_SECRET) {
  const raw = JSON.stringify({ entity: 'event', event, payload, created_at: Math.floor(Date.now() / 1000) });
  const sig = createHmac('sha256', secret).update(raw).digest('hex');
  return api('POST', '/webhooks/razorpay', {
    raw,
    headers: { 'X-Razorpay-Signature': sig, 'X-Razorpay-Event-Id': eventId },
  });
}

try {
  // wait for boot
  let up = false;
  for (let i = 0; i < 100 && !up; i++) {
    try {
      up = (await fetch(`${APP}/healthz`)).ok;
    } catch {
      await new Promise((r) => setTimeout(r, 300));
    }
  }
  check('server boots, runs migrations, verifies the Razorpay plan', up, serverLog.slice(-500));
  if (!up) throw new Error('server did not start');

  check('readiness probe reaches Postgres', (await api('GET', '/readyz')).status === 200);
  check('plan check hit Razorpay', calls.some((c) => c.url === '/v1/plans/plan_team_monthly'));

  const plans = await api('GET', '/v1/plans');
  check('plans list with GST-inclusive prices', plans.body.find((p) => p.key === 'team_pro_monthly')?.pricePerSeatInclGstPaise === 117882);

  check('API rejects missing session', (await api('GET', '/v1/me/orgs')).status === 401);
  check('internal API rejects missing token', (await api('GET', `/internal/v1/entitlements/${randomUUID()}`)).status === 401);

  const owner = await user('owner@acme.in');
  const created = await api('POST', '/v1/orgs', {
    token: owner.token,
    body: { name: 'Acme Labs', kind: 'team', billing: { legalName: 'Acme Labs Pvt Ltd', billingStateCode: '27', billingAddress: 'Pune' } },
  });
  check('owner creates a team org', created.status === 201, JSON.stringify(created.body));
  const orgId = created.body.id;

  const quote = await api('GET', `/v1/orgs/${orgId}/quote?plan=team_pro_monthly&seats=2`, { token: owner.token });
  check('quote: 2 seats = ₹2,357.64 incl. IGST, via autopay', quote.body.quote?.totalPaise === 235764 && quote.body.method === 'autopay', JSON.stringify(quote.body));

  const checkout = await api('POST', `/v1/orgs/${orgId}/checkout`, { token: owner.token, body: { planKey: 'team_pro_monthly', seats: 2 } });
  check('checkout creates a UPI Autopay subscription', checkout.status === 201 && checkout.body.url === 'https://rzp.io/i/sub_1', JSON.stringify(checkout.body));
  const subCall = calls.find((c) => c.url === '/v1/subscriptions');
  check('subscription sent to Razorpay with right plan and quantity', subCall?.body.plan_id === 'plan_team_monthly' && subCall?.body.quantity === 2);

  const now = Math.floor(Date.now() / 1000);
  const charged = {
    subscription: { entity: { id: 'sub_1', status: 'active', quantity: 2, current_start: now, current_end: now + 31 * 86400, notes: { checkout_id: checkout.body.checkoutId } } },
    payment: { entity: { id: 'pay_e2e_1', amount: 235764, currency: 'INR', status: 'captured', created_at: now } },
  };
  check('signed charge webhook is processed', (await webhook('subscription.charged', charged, 'evt_1')).body.outcome === 'processed');
  check('replayed webhook is de-duplicated', (await webhook('subscription.charged', charged, 'evt_1')).body.outcome === 'duplicate');
  check('forged webhook signature is rejected', (await webhook('subscription.charged', charged, 'evt_2', 'wrong-secret-xyz')).status === 401);

  const org = await api('GET', `/v1/orgs/${orgId}`, { token: owner.token });
  check('org is active with 2 seats', org.body.status === 'active' && org.body.seatLimit === 2, JSON.stringify(org.body));

  const invoices = await api('GET', `/v1/orgs/${orgId}/invoices`, { token: owner.token });
  const inv = invoices.body[0];
  check('GST invoice issued: BC/2627/000001, IGST ₹359.64', inv?.invoiceNumber === 'BC/2627/000001' && inv?.igstPaise === 35964, JSON.stringify(invoices.body));
  const html = await fetch(`${APP}/v1/orgs/${orgId}/invoices/${inv.id}?format=html`, { headers: { Authorization: `Bearer ${owner.token}` } });
  const htmlText = await html.text();
  check('printable invoice renders with strict CSP', html.status === 200 && htmlText.includes('IGST @ 18%') && (html.headers.get('content-security-policy') ?? '').includes("default-src 'none'"));

  const inviteRes = await api('POST', `/v1/orgs/${orgId}/invites`, { token: owner.token, body: { maxUses: 3 } });
  const inviteToken = new URL(inviteRes.body.url).searchParams.get('invite');
  check('invite link with WhatsApp share URL', inviteRes.status === 201 && inviteRes.body.whatsappUrl.startsWith('https://wa.me/'));
  const dev = await user('dev@acme.in');
  check('teammate accepts the invite', (await api('POST', '/v1/invites/accept', { token: dev.token, body: { token: inviteToken } })).status === 200);
  const third = await user('third@acme.in');
  const full = await api('POST', '/v1/invites/accept', { token: third.token, body: { token: inviteToken } });
  check('seat limit enforced for a third person', full.status === 409 && full.body.error?.code === 'seat_limit_reached');

  const ent = await api('GET', `/internal/v1/entitlements/${dev.id}`, { token: INTERNAL });
  check('gateway entitlement: Pro with Zero Data Retention', ent.body.entitled === true && ent.body.tier === 'pro' && ent.body.zdr === true, JSON.stringify(ent.body));

  const usage = await api('POST', '/internal/v1/usage', {
    token: INTERNAL,
    body: { batchId: 'e2e-batch-1', events: [{ userId: dev.id, at: new Date().toISOString(), requests: 4, inputTokens: 5000, outputTokens: 400 }] },
  });
  check('usage batch ingested', usage.body.recorded === 1, JSON.stringify(usage.body));
  check('usage batch is idempotent', (await api('POST', '/internal/v1/usage', { token: INTERNAL, body: { batchId: 'e2e-batch-1', events: [] } })).body.duplicate === true);
  const report = await api('GET', `/v1/orgs/${orgId}/usage`, { token: owner.token });
  check('admin usage report shows the teammate', report.body.totals?.inputTokens === 5000 && report.body.members?.[0]?.email === 'dev@acme.in', JSON.stringify(report.body));

  const seats = await api('POST', `/v1/orgs/${orgId}/seats`, { token: owner.token, body: { seats: 3 } });
  check('seat increase: prorated top-up link + new mandate to authorise', seats.status === 200 && seats.body.topup?.url?.includes('plink_') && seats.body.renewalAuthorizationUrl?.includes('sub_'), JSON.stringify(seats.body));
  const replacementId = seats.body.renewalAuthorizationUrl.split('/').pop();
  check('old mandate NOT cancelled before the new one is authorised', !calls.some((c) => c.url === '/v1/subscriptions/sub_1/cancel'));
  await webhook('subscription.authenticated', { subscription: { entity: { id: replacementId, status: 'authenticated', notes: [] } } });
  const cancelCall = calls.find((c) => c.url === '/v1/subscriptions/sub_1/cancel');
  check('after authorisation the old mandate is set to cancel at cycle end', cancelCall?.body?.cancel_at_cycle_end === 1, JSON.stringify(cancelCall));

  const campusOwner = await user('tpo@e2e-college.ac.in');
  const campus = await api('POST', '/v1/orgs', { token: campusOwner.token, body: { name: 'E2E College', kind: 'campus', billing: { legalName: 'E2E College', billingStateCode: '29' } } });
  const dom = await api('POST', `/v1/orgs/${campus.body.id}/domains`, { token: campusOwner.token, body: { domain: 'e2e-college.ac.in' } });
  check('campus adds its domain and gets a TXT record to publish', dom.status === 201 && dom.body.dns?.host === '_bharatcode-verify.e2e-college.ac.in');
  const verify = await api('POST', `/v1/orgs/${campus.body.id}/domains/${dom.body.id}/verify`, { token: campusOwner.token });
  check('verification does a real DNS lookup and explains a missing record', verify.status === 422 && /TXT record/.test(verify.body.error?.message ?? ''), JSON.stringify(verify.body));
  check('campus checkout blocked until the domain is verified', (await api('POST', `/v1/orgs/${campus.body.id}/checkout`, { token: campusOwner.token, body: { planKey: 'campus_lite_annual', seats: 50 } })).status === 409);

  const off = await api('PATCH', `/v1/orgs/${orgId}`, { token: owner.token, body: { autoRenew: false } });
  check('turning auto-renew off is accepted', off.status === 200 && off.body.autoRenew === false);

  const renewals = await api('POST', '/internal/v1/jobs/renewals', { token: INTERNAL });
  check('daily renewal job runs', renewals.status === 200 && renewals.body.failures === 0, JSON.stringify(renewals.body));
  const outbox = await api('POST', '/internal/v1/jobs/provider-actions', { token: INTERNAL });
  check('provider-actions job runs with nothing stuck', outbox.status === 200 && outbox.body.failed === 0, JSON.stringify(outbox.body));

  check('no server errors logged', !/"level":50|unhandled error/.test(serverLog), serverLog.slice(-800));
} catch (err) {
  check('journey completed without exceptions', false, String(err?.stack ?? err));
} finally {
  server.kill();
  await pgServer.stop();
  await pglite.close();
  stub.close();
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exit(failed ? 1 : 0);
}
