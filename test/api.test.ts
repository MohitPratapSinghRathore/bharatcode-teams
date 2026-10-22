import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { INTERNAL_TOKEN, createHarness, makeUser, unix, validGstin, type Harness, type TestUser } from './helpers.js';

const DAY = 86_400_000;

let h: Harness;
let owner: TestUser;

beforeEach(async () => {
  h = await createHarness();
  owner = await makeUser('owner@acme.in');
});

async function createTeam(user = owner, billing: Record<string, unknown> = {}) {
  const res = await h.call('POST', '/v1/orgs', {
    user,
    body: {
      name: 'Acme Labs',
      kind: 'team',
      billing: { legalName: 'Acme Labs Pvt Ltd', billingStateCode: '27', billingAddress: 'Pune', ...billing },
    },
  });
  expect(res.status).toBe(201);
  return res.body.id as string;
}

/** Buy Team Pro monthly via autopay and deliver the first charge webhook. */
async function activateAutopay(orgId: string, seats = 2) {
  const checkout = await h.call('POST', `/v1/orgs/${orgId}/checkout`, { user: owner, body: { planKey: 'team_pro_monthly', seats } });
  expect(checkout.status).toBe(201);
  expect(checkout.body.method).toBe('autopay');
  const sub = h.razorpay.subscriptions.at(-1);
  if (!sub) throw new Error('no subscription created');
  const start = h.clock.now;
  const end = new Date(start.getTime() + 31 * DAY);
  const res = await h.webhook('subscription.charged', {
    subscription: {
      entity: {
        id: sub.id,
        status: 'active',
        quantity: seats,
        current_start: unix(start),
        current_end: unix(end),
        notes: { checkout_id: checkout.body.checkoutId },
      },
    },
    payment: { entity: { id: `pay_${randomUUID().slice(0, 8)}`, amount: checkout.body.quote.totalPaise, currency: 'INR', status: 'captured' } },
  });
  expect(res.body.outcome).toBe('processed');
  return { checkout: checkout.body, sub, end };
}

async function payLink(linkIndex = -1, amountOverride?: number) {
  const link = h.razorpay.links.at(linkIndex);
  if (!link) throw new Error('no payment link created');
  return h.webhook('payment_link.paid', {
    payment_link: { entity: { id: link.id, amount: link.amountPaise, amount_paid: link.amountPaise, status: 'paid', notes: link.notes } },
    payment: { entity: { id: `pay_${link.id}`, amount: amountOverride ?? link.amountPaise, currency: 'INR', status: 'captured' } },
  });
}

async function invite(orgId: string, body: Record<string, unknown> = {}, user = owner) {
  const res = await h.call('POST', `/v1/orgs/${orgId}/invites`, { user, body });
  expect(res.status).toBe(201);
  return new URL(res.body.url as string).searchParams.get('invite') ?? '';
}

describe('organisations', () => {
  it('creates an org with the creator as owner and hides it from non-members', async () => {
    const orgId = await createTeam();
    const mine = await h.call('GET', '/v1/me/orgs', { user: owner });
    expect(mine.body).toHaveLength(1);
    expect(mine.body[0]).toMatchObject({ id: orgId, role: 'owner', memberCount: 1, status: 'pending' });

    const stranger = await makeUser('x@other.in');
    expect((await h.call('GET', `/v1/orgs/${orgId}`, { user: stranger })).status).toBe(404);
    expect((await h.call('GET', '/v1/orgs/not-a-uuid', { user: owner })).status).toBe(404);
  });

  it('allows one active organisation per user', async () => {
    await createTeam();
    const again = await h.call('POST', '/v1/orgs', { user: owner, body: { name: 'Second', kind: 'team' } });
    expect(again.status).toBe(409);
  });

  it('validates GSTIN and derives the billing state from it', async () => {
    const bad = await h.call('POST', '/v1/orgs', {
      user: owner,
      body: { name: 'Acme', kind: 'team', billing: { gstin: '27AAPFU0939F1ZW' } },
    });
    expect(bad.status).toBe(400);
    const mismatch = await h.call('POST', '/v1/orgs', {
      user: owner,
      body: { name: 'Acme', kind: 'team', billing: { gstin: validGstin('29'), billingStateCode: '27' } },
    });
    expect(mismatch.status).toBe(400);
    const ok = await h.call('POST', '/v1/orgs', {
      user: owner,
      body: { name: 'Acme', kind: 'team', billing: { gstin: validGstin('29').toLowerCase(), legalName: 'Acme' } },
    });
    expect(ok.status).toBe(201);
    expect(ok.body.billing).toMatchObject({ gstin: validGstin('29'), billingStateCode: '29', billingEmail: 'owner@acme.in' });
  });

  it('rejects unknown fields and unauthenticated calls', async () => {
    expect((await h.call('POST', '/v1/orgs', { user: owner, body: { name: 'Acme', kind: 'team', admin: true } })).status).toBe(400);
    expect((await h.call('GET', '/v1/me/orgs')).status).toBe(401);
    expect((await h.call('GET', '/v1/me/orgs', { token: 'nope' })).status).toBe(401);
  });

  it('publishes plans with GST-inclusive prices', async () => {
    const res = await h.call('GET', '/v1/plans');
    expect(res.status).toBe(200);
    expect(res.body.find((p: { key: string }) => p.key === 'team_pro_monthly')).toMatchObject({
      pricePerSeatPaise: 99_900,
      pricePerSeatInclGstPaise: 117_882,
    });
  });
});

describe('autopay checkout and webhooks', () => {
  it('activates the org, issues an inter-state GST invoice and is idempotent', async () => {
    const orgId = await createTeam();
    const quote = await h.call('GET', `/v1/orgs/${orgId}/quote?plan=team_pro_monthly&seats=2`, { user: owner });
    expect(quote.body).toMatchObject({ method: 'autopay', quote: { totalPaise: 235_764, igstPaise: 35_964, supplyType: 'inter' } });

    const { sub, end } = await activateAutopay(orgId);
    expect(sub).toMatchObject({ planId: 'plan_team_monthly', quantity: 2, totalCount: 120 });

    const org = await h.call('GET', `/v1/orgs/${orgId}`, { user: owner });
    expect(org.body).toMatchObject({ status: 'active', seatLimit: 2, planTier: 'pro', collectionMethod: 'autopay' });
    expect(org.body.paidThrough).toBe(new Date(unix(end) * 1000).toISOString());

    const invoices = await h.call('GET', `/v1/orgs/${orgId}/invoices`, { user: owner });
    expect(invoices.body).toHaveLength(1);
    expect(invoices.body[0]).toMatchObject({
      invoiceNumber: 'BC/2627/000001',
      placeOfSupply: '27',
      supplyType: 'inter',
      taxablePaise: 199_800,
      igstPaise: 35_964,
      cgstPaise: 0,
      totalPaise: 235_764,
      supplier: { gstin: h.config.supplier.gstin, stateCode: '24' },
      recipient: { legalName: 'Acme Labs Pvt Ltd', stateCode: '27' },
    });
  });

  it('de-duplicates a replayed body even under a new event id', async () => {
    const orgId = await createTeam();
    await activateAutopay(orgId);
    const raw = JSON.stringify({ event: 'subscription.halted', payload: { subscription: { entity: { id: 'sub_1', status: 'halted', notes: [] } } } });
    expect((await h.webhookRaw(raw, 'evt_a')).body.outcome).toBe('processed');
    expect((await h.webhookRaw(raw, 'evt_b')).body.outcome).toBe('duplicate');
  });

  it('ignores an out-of-order delivery of an older cycle', async () => {
    const orgId = await createTeam();
    const { end } = await activateAutopay(orgId);
    const later = new Date(end.getTime() + 30 * DAY);
    await h.webhook('subscription.charged', {
      subscription: { entity: { id: 'sub_1', status: 'active', quantity: 2, current_start: unix(end), current_end: unix(later), notes: [] } },
      payment: { entity: { id: 'pay_c2', amount: 235_764, currency: 'INR' } },
    });
    await h.webhook('subscription.charged', {
      subscription: { entity: { id: 'sub_1', status: 'active', quantity: 2, current_start: unix(h.clock.now), current_end: unix(end), notes: [] } },
      payment: { entity: { id: 'pay_c1_retry', amount: 235_764, currency: 'INR' } },
    });
    const org = (await h.call('GET', `/v1/orgs/${orgId}`, { user: owner })).body;
    expect(org.paidThrough).toBe(new Date(unix(later) * 1000).toISOString());
    expect(org.currentPeriodStart).toBe(new Date(unix(end) * 1000).toISOString());
  });

  it('rate-limits payment requests per organisation', async () => {
    const orgId = await createTeam();
    for (let i = 0; i < 10; i++) {
      expect((await h.call('POST', `/v1/orgs/${orgId}/checkout`, { user: owner, body: { planKey: 'team_pro_monthly', seats: 2 } })).status).toBe(201);
    }
    const limited = await h.call('POST', `/v1/orgs/${orgId}/checkout`, { user: owner, body: { planKey: 'team_pro_monthly', seats: 2 } });
    expect(limited.status).toBe(429);
    expect(limited.body.error.code).toBe('rate_limited');
  });

  it('a fresh purchase withdraws a stale renewal link for the lapsed period', async () => {
    const orgId = await createTeam();
    await h.call('POST', `/v1/orgs/${orgId}/checkout`, { user: owner, body: { planKey: 'team_pro_annual', seats: 5 } });
    await payLink();
    h.clock.now = new Date('2027-10-15T06:00:00Z');
    await h.call('POST', '/internal/v1/jobs/renewals', { token: INTERNAL_TOKEN });
    const renewal = h.razorpay.links.at(-1);
    h.clock.now = new Date('2027-11-15T06:00:00Z'); // lapsed past grace
    await h.call('POST', `/v1/orgs/${orgId}/checkout`, { user: owner, body: { planKey: 'team_pro_annual', seats: 3 } });
    expect(h.razorpay.cancelledLinks).toContain(renewal?.id);
  });

  it('ignores replayed events and rejects bad signatures', async () => {
    const orgId = await createTeam();
    await activateAutopay(orgId);
    const sub = h.razorpay.subscriptions[0];
    const payload = {
      subscription: { entity: { id: sub?.id, status: 'halted', notes: [] } },
    };
    expect((await h.webhook('subscription.halted', payload, { eventId: 'evt_same' })).body.outcome).toBe('processed');
    expect((await h.webhook('subscription.halted', payload, { eventId: 'evt_same' })).body.outcome).toBe('duplicate');
    expect((await h.webhook('subscription.halted', payload, { secret: 'wrong-secret-123456' })).status).toBe(401);
    const org = await h.call('GET', `/v1/orgs/${orgId}`, { user: owner });
    expect(org.body.status).toBe('past_due');
  });

  it('uses CGST + SGST for buyers in the supplier state', async () => {
    const orgId = await createTeam(owner, { billingStateCode: '24' });
    await activateAutopay(orgId);
    const [inv] = (await h.call('GET', `/v1/orgs/${orgId}/invoices`, { user: owner })).body;
    expect(inv).toMatchObject({ supplyType: 'intra', cgstPaise: 17_982, sgstPaise: 17_982, igstPaise: 0, totalPaise: 235_764 });
  });

  it('flags an amount mismatch instead of issuing a wrong invoice', async () => {
    const orgId = await createTeam();
    const checkout = await h.call('POST', `/v1/orgs/${orgId}/checkout`, { user: owner, body: { planKey: 'team_pro_monthly', seats: 2 } });
    const sub = h.razorpay.subscriptions[0];
    await h.webhook('subscription.charged', {
      subscription: { entity: { id: sub?.id, status: 'active', quantity: 2, current_start: unix(h.clock.now), current_end: unix(h.clock.now) + 2_678_400, notes: { checkout_id: checkout.body.checkoutId } } },
      payment: { entity: { id: 'pay_wrong', amount: 100, currency: 'INR' } },
    });
    expect((await h.call('GET', `/v1/orgs/${orgId}/invoices`, { user: owner })).body).toHaveLength(0);
    const alerts = await h.db.query("SELECT kind FROM billing_alerts WHERE kind = 'amount_mismatch'");
    expect(alerts.rowCount).toBe(1);
    // Access follows the provider's charge; finance resolves the discrepancy.
    expect((await h.call('GET', `/v1/orgs/${orgId}`, { user: owner })).body.status).toBe('active');
  });

  it('requires billing details and refuses a second checkout while active', async () => {
    const res = await h.call('POST', '/v1/orgs', { user: owner, body: { name: 'Bare', kind: 'team' } });
    const orgId = res.body.id as string;
    const noBilling = await h.call('POST', `/v1/orgs/${orgId}/checkout`, { user: owner, body: { planKey: 'team_pro_monthly', seats: 2 } });
    expect(noBilling.status).toBe(400);
    await h.call('PATCH', `/v1/orgs/${orgId}`, { user: owner, body: { billing: { legalName: 'Bare Co', billingStateCode: '07' } } });
    await activateAutopay(orgId);
    const again = await h.call('POST', `/v1/orgs/${orgId}/checkout`, { user: owner, body: { planKey: 'team_pro_monthly', seats: 3 } });
    expect(again.status).toBe(409);
  });

  it('cancels the row and returns 502 when Razorpay fails', async () => {
    const orgId = await createTeam();
    h.razorpay.failNextCreate = true;
    const res = await h.call('POST', `/v1/orgs/${orgId}/checkout`, { user: owner, body: { planKey: 'team_pro_monthly', seats: 2 } });
    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe('payment_provider_error');
    const rows = await h.db.query("SELECT status FROM checkouts WHERE org_id = $1", [orgId]);
    expect(rows.rows).toEqual([{ status: 'cancelled' }]);
  });

  it('supersedes and cancels an earlier unpaid checkout', async () => {
    const orgId = await createTeam();
    await h.call('POST', `/v1/orgs/${orgId}/checkout`, { user: owner, body: { planKey: 'team_pro_monthly', seats: 2 } });
    await h.call('POST', `/v1/orgs/${orgId}/checkout`, { user: owner, body: { planKey: 'team_pro_monthly', seats: 3 } });
    expect(h.razorpay.cancelledSubscriptions).toEqual([{ id: 'sub_1', atCycleEnd: false }]);
  });

  it('handles the charge webhook arriving before the subscription row is saved', async () => {
    const orgId = await createTeam();
    const checkout = await h.call('POST', `/v1/orgs/${orgId}/checkout`, { user: owner, body: { planKey: 'team_pro_monthly', seats: 2 } });
    await h.db.query('DELETE FROM subscriptions');
    await h.db.query('UPDATE checkouts SET provider_ref = NULL');
    const res = await h.webhook('subscription.charged', {
      subscription: { entity: { id: 'sub_1', status: 'active', quantity: 2, current_start: unix(h.clock.now), current_end: unix(h.clock.now) + 2_678_400, notes: { checkout_id: checkout.body.checkoutId } } },
      payment: { entity: { id: 'pay_race', amount: 235_764, currency: 'INR' } },
    });
    expect(res.body.outcome).toBe('processed');
    expect((await h.call('GET', `/v1/orgs/${orgId}`, { user: owner })).body.status).toBe('active');
  });
});

describe('payment-link checkout (above the e-mandate limit)', () => {
  it('uses a payment link, activates for a year and numbers invoices consecutively', async () => {
    const orgId = await createTeam();
    const res = await h.call('POST', `/v1/orgs/${orgId}/checkout`, { user: owner, body: { planKey: 'team_pro_annual', seats: 5 } });
    expect(res.body).toMatchObject({ method: 'payment_link', quote: { totalPaise: 5_894_100 } });
    expect(h.razorpay.links[0]).toMatchObject({ amountPaise: 5_894_100, referenceId: res.body.checkoutId, customer: { email: 'owner@acme.in' } });

    expect((await payLink()).body.outcome).toBe('processed');
    expect((await payLink()).body.outcome).toBe('duplicate');
    const org = (await h.call('GET', `/v1/orgs/${orgId}`, { user: owner })).body;
    expect(org).toMatchObject({ status: 'active', seatLimit: 5, collectionMethod: 'payment_link', paidThrough: '2027-10-22T06:00:00.000Z' });

    // A second org's payment takes the next number in the same financial year.
    const other = await makeUser('boss@beta.in');
    const otherOrg = await createTeam(other);
    await h.call('POST', `/v1/orgs/${otherOrg}/checkout`, { user: other, body: { planKey: 'team_pro_annual', seats: 2 } });
    await payLink();
    const numbers = await h.db.query<{ invoice_number: string }>('SELECT invoice_number FROM invoices ORDER BY seq');
    expect(numbers.rows.map((r) => r.invoice_number)).toEqual(['BC/2627/000001', 'BC/2627/000002']);
  });

  it('does not apply a payment whose amount differs from the checkout', async () => {
    const orgId = await createTeam();
    await h.call('POST', `/v1/orgs/${orgId}/checkout`, { user: owner, body: { planKey: 'team_pro_annual', seats: 5 } });
    await payLink(-1, 100);
    expect((await h.call('GET', `/v1/orgs/${orgId}`, { user: owner })).body.status).toBe('pending');
    expect((await h.call('GET', `/v1/orgs/${orgId}/invoices`, { user: owner })).body).toHaveLength(0);
    const alerts = await h.db.query("SELECT kind FROM billing_alerts WHERE kind = 'amount_mismatch'");
    expect(alerts.rowCount).toBe(1);
  });
});

describe('seats, invites and entitlements', () => {
  it('fills seats through invites and then refuses more', async () => {
    const orgId = await createTeam();
    const before = await h.call('POST', '/v1/invites/accept', { user: await makeUser('early@acme.in'), body: { token: await invite(orgId) } });
    expect(before.status).toBe(409); // no plan yet

    await activateAutopay(orgId, 2);
    const token = await invite(orgId, { maxUses: 5 });
    const preview = await h.call('GET', `/v1/invites/${token}`);
    expect(preview.body).toMatchObject({ orgName: 'Acme Labs', role: 'member', emailRestricted: false });

    const dev = await makeUser('dev@acme.in');
    expect((await h.call('POST', '/v1/invites/accept', { user: dev, body: { token } })).status).toBe(200);
    expect((await h.call('POST', '/v1/invites/accept', { user: dev, body: { token } })).status).toBe(409);

    const third = await makeUser('third@acme.in');
    const full = await h.call('POST', '/v1/invites/accept', { user: third, body: { token } });
    expect(full.status).toBe(409);
    expect(full.body.error.code).toBe('seat_limit_reached');

    const members = await h.call('GET', `/v1/orgs/${orgId}/members`, { user: owner });
    expect(members.body.map((m: { email: string }) => m.email)).toEqual(['owner@acme.in', 'dev@acme.in']);
  });

  it('binds email invites to the address and to verified emails', async () => {
    const orgId = await createTeam();
    await activateAutopay(orgId, 3);
    const token = await invite(orgId, { email: 'Priya@Acme.in' });
    expect((await h.call('POST', '/v1/invites/accept', { user: await makeUser('other@acme.in'), body: { token } })).status).toBe(403);
    expect((await h.call('POST', '/v1/invites/accept', { user: await makeUser('priya@acme.in', { verified: false }), body: { token } })).status).toBe(403);
    expect((await h.call('POST', '/v1/invites/accept', { user: await makeUser('priya@acme.in'), body: { token } })).status).toBe(200);
  });

  it('returns a WhatsApp share link and lets admins revoke invites', async () => {
    const orgId = await createTeam();
    const res = await h.call('POST', `/v1/orgs/${orgId}/invites`, { user: owner, body: { maxUses: 10 } });
    expect(res.body.whatsappUrl).toMatch(/^https:\/\/wa\.me\/\?text=Join%20Acme%20Labs/);
    expect((await h.call('GET', `/v1/orgs/${orgId}/invites`, { user: owner })).body).toHaveLength(1);
    expect((await h.call('DELETE', `/v1/orgs/${orgId}/invites/${res.body.invite.id as string}`, { user: owner })).status).toBe(204);
    expect((await h.call('GET', `/v1/orgs/${orgId}/invites`, { user: owner })).body).toHaveLength(0);
    const token = new URL(res.body.url as string).searchParams.get('invite') ?? '';
    expect((await h.call('GET', `/v1/invites/${token}`)).status).toBe(404);
  });

  it('serves entitlements to the gateway, including grace and expiry', async () => {
    const orgId = await createTeam();
    const { end } = await activateAutopay(orgId, 2);
    const dev = await makeUser('dev@acme.in');
    await h.call('POST', '/v1/invites/accept', { user: dev, body: { token: await invite(orgId) } });

    const get = (userId: string, token = INTERNAL_TOKEN) => h.call('GET', `/internal/v1/entitlements/${userId}`, { token });
    expect((await get(dev.id, 'wrong-token')).status).toBe(401);
    expect((await get(dev.id)).body).toMatchObject({ entitled: true, tier: 'pro', zdr: true, orgId, reason: 'ok' });
    expect((await get(randomUUID())).body).toMatchObject({ entitled: false, reason: 'no_org' });

    h.clock.now = new Date(end.getTime() + DAY);
    expect((await get(dev.id)).body).toMatchObject({ entitled: false, reason: 'expired' });
    await h.db.query("UPDATE orgs SET status = 'past_due'");
    expect((await get(dev.id)).body).toMatchObject({ entitled: true });
    h.clock.now = new Date(end.getTime() + 8 * DAY);
    expect((await get(dev.id)).body).toMatchObject({ entitled: false, reason: 'expired' });
  });

  it('keeps owners and earliest members when an org is over its seat limit', async () => {
    const orgId = await createTeam();
    await activateAutopay(orgId, 3);
    const a = await makeUser('a@acme.in');
    const b = await makeUser('b@acme.in');
    const token = await invite(orgId, { maxUses: 5 });
    await h.call('POST', '/v1/invites/accept', { user: a, body: { token } });
    h.clock.now = new Date(h.clock.now.getTime() + 1000);
    await h.call('POST', '/v1/invites/accept', { user: b, body: { token } });
    await h.db.query('UPDATE orgs SET seat_limit = 2');
    const ent = async (u: TestUser) => (await h.call('GET', `/internal/v1/entitlements/${u.id}`, { token: INTERNAL_TOKEN })).body;
    expect((await ent(owner)).entitled).toBe(true);
    expect((await ent(a)).entitled).toBe(true);
    expect(await ent(b)).toMatchObject({ entitled: false, reason: 'over_seat_limit' });
  });

  it('enforces member-management rules', async () => {
    const orgId = await createTeam();
    await activateAutopay(orgId, 3);
    const admin = await makeUser('admin@acme.in');
    const member = await makeUser('m@acme.in');
    await h.call('POST', '/v1/invites/accept', { user: admin, body: { token: await invite(orgId, { role: 'admin' }) } });
    await h.call('POST', '/v1/invites/accept', { user: member, body: { token: await invite(orgId) } });

    expect((await h.call('DELETE', `/v1/orgs/${orgId}/members/${owner.id}`, { user: owner })).status).toBe(409); // last owner
    expect((await h.call('DELETE', `/v1/orgs/${orgId}/members/${owner.id}`, { user: admin })).status).toBe(403);
    expect((await h.call('PATCH', `/v1/orgs/${orgId}/members/${member.id}`, { user: admin, body: { role: 'admin' } })).status).toBe(403);
    expect((await h.call('GET', `/v1/orgs/${orgId}/members`, { user: member })).status).toBe(403);
    expect((await h.call('DELETE', `/v1/orgs/${orgId}/members/${member.id}`, { user: admin })).status).toBe(204);
    expect((await h.call('DELETE', `/v1/orgs/${orgId}/members/${admin.id}`, { user: admin })).status).toBe(204); // leave

    // A removed member can rejoin, and the freed seat is reusable.
    expect((await h.call('POST', '/v1/invites/accept', { user: member, body: { token: await invite(orgId) } })).status).toBe(200);
  });
});

describe('seat changes', () => {
  it('sells extra seats via a prorated top-up and applies them on payment', async () => {
    const orgId = await createTeam();
    await h.call('POST', `/v1/orgs/${orgId}/checkout`, { user: owner, body: { planKey: 'team_pro_annual', seats: 5 } });
    await payLink();
    h.clock.now = new Date('2027-04-22T18:00:00Z'); // about half the year left

    const res = await h.call('POST', `/v1/orgs/${orgId}/seats`, { user: owner, body: { seats: 7 } });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ seatLimit: 5, renewalSeats: 7, renewalAuthorizationUrl: null });
    const taxable = res.body.topup.quote.taxablePaise as number;
    expect(taxable).toBeGreaterThan(900_000);
    expect(taxable).toBeLessThan(1_100_000);
    expect(taxable % 100).toBe(0);

    await payLink();
    const org = (await h.call('GET', `/v1/orgs/${orgId}`, { user: owner })).body;
    expect(org).toMatchObject({ seatLimit: 7, renewalSeats: 7, paidThrough: '2027-10-22T06:00:00.000Z' });
    expect((await h.call('GET', `/v1/orgs/${orgId}/invoices`, { user: owner })).body).toHaveLength(2);
  });

  it('holds a freed seat for a cooldown so it cannot be rotated', async () => {
    const orgId = await createTeam();
    await activateAutopay(orgId, 2);
    const dev = await makeUser('dev@acme.in');
    const token = await invite(orgId, { maxUses: 5 });
    await h.call('POST', '/v1/invites/accept', { user: dev, body: { token } });
    await h.call('DELETE', `/v1/orgs/${orgId}/members/${dev.id}`, { user: owner });

    const newcomer = await makeUser('new@acme.in');
    const blocked = await h.call('POST', '/v1/invites/accept', { user: newcomer, body: { token } });
    expect(blocked.body.error?.code).toBe('seat_limit_reached');
    // The same person may come back straight away.
    expect((await h.call('POST', '/v1/invites/accept', { user: dev, body: { token } })).status).toBe(200);
  });

  it('refuses to go below the current member count', async () => {
    const orgId = await createTeam();
    await activateAutopay(orgId, 2);
    await h.call('POST', '/v1/invites/accept', { user: await makeUser('d@acme.in'), body: { token: await invite(orgId) } });
    expect((await h.call('POST', `/v1/orgs/${orgId}/seats`, { user: owner, body: { seats: 1 } })).status).toBe(400);
  });

  it('retires the old autopay mandate only after the replacement is authorised', async () => {
    const orgId = await createTeam();
    const { end } = await activateAutopay(orgId, 2);
    const res = await h.call('POST', `/v1/orgs/${orgId}/seats`, { user: owner, body: { seats: 3 } });
    expect(res.body.renewalAuthorizationUrl).toBe('https://rzp.io/i/sub_3');
    expect(res.body.topup.url).toMatch(/plink_2$/);
    expect(h.razorpay.subscriptions.at(-1)).toMatchObject({ quantity: 3, startAt: unix(end) });
    expect(h.razorpay.cancelledSubscriptions).toEqual([]); // the paying mandate is untouched so far

    const authorised = { subscription: { entity: { id: 'sub_3', status: 'authenticated', notes: [] } } };
    await h.webhook('subscription.authenticated', authorised);
    expect(h.razorpay.cancelledSubscriptions).toEqual([{ id: 'sub_1', atCycleEnd: true }]);

    // Going back to 2 seats needs another mandate. The authorised 3-seat replacement stays live
    // until the new one is authorised, so ignoring the new link can never end the plan.
    const back = await h.call('POST', `/v1/orgs/${orgId}/seats`, { user: owner, body: { seats: 2 } });
    expect(back.body.renewalAuthorizationUrl).toBe('https://rzp.io/i/sub_4');
    expect(h.razorpay.cancelledSubscriptions).toEqual([{ id: 'sub_1', atCycleEnd: true }]);
    expect(h.razorpay.cancelledLinks).toEqual(['plink_2']); // the unpaid top-up is withdrawn
    await h.webhook('subscription.authenticated', { subscription: { entity: { id: 'sub_4', status: 'authenticated', notes: [] } } });
    expect(h.razorpay.cancelledSubscriptions).toEqual([
      { id: 'sub_1', atCycleEnd: true }, // not cancelled twice
      { id: 'sub_3', atCycleEnd: false }, // the older replacement is withdrawn now
    ]);

    // The replacement's first charge moves the org onto it.
    h.clock.now = end;
    const next = new Date(end.getTime() + 30 * DAY);
    await h.webhook('subscription.charged', {
      subscription: { entity: { id: 'sub_4', status: 'active', quantity: 2, current_start: unix(end), current_end: unix(next), notes: [] } },
      payment: { entity: { id: 'pay_renew', amount: 235_764, currency: 'INR' } },
    });
    await h.webhook('subscription.cancelled', { subscription: { entity: { id: 'sub_1', status: 'cancelled', notes: [] } } });
    const org = (await h.call('GET', `/v1/orgs/${orgId}`, { user: owner })).body;
    expect(org).toMatchObject({ status: 'active', seatLimit: 2, paidThrough: new Date(unix(next) * 1000).toISOString() });
  });

  it('keeps renewing on the old mandate if the admin never authorises the new one', async () => {
    const orgId = await createTeam();
    const { end } = await activateAutopay(orgId, 2);
    await h.call('POST', `/v1/orgs/${orgId}/seats`, { user: owner, body: { seats: 3 } });
    h.clock.now = end;
    const next = new Date(end.getTime() + 30 * DAY);
    await h.webhook('subscription.charged', {
      subscription: { entity: { id: 'sub_1', status: 'active', quantity: 2, current_start: unix(end), current_end: unix(next), notes: [] } },
      payment: { entity: { id: 'pay_cycle2', amount: 235_764, currency: 'INR' } },
    });
    // The paying mandate is untouched; only the never-authorised replacement (due to start at
    // this cycle) is withdrawn so it cannot start later and double-bill.
    expect(h.razorpay.cancelledSubscriptions).toEqual([{ id: 'sub_3', atCycleEnd: false }]);
    const org = (await h.call('GET', `/v1/orgs/${orgId}`, { user: owner })).body;
    expect(org).toMatchObject({ status: 'active', seatLimit: 2, paidThrough: new Date(unix(next) * 1000).toISOString() });
  });

  it('keeps an authorised replacement when a later seat change is never authorised', async () => {
    const orgId = await createTeam();
    const { end } = await activateAutopay(orgId, 2);
    await h.call('POST', `/v1/orgs/${orgId}/seats`, { user: owner, body: { seats: 3 } }); // sub_3
    await h.webhook('subscription.authenticated', { subscription: { entity: { id: 'sub_3', status: 'authenticated', notes: [] } } });
    await h.call('POST', `/v1/orgs/${orgId}/seats`, { user: owner, body: { seats: 4 } }); // sub_5, ignored

    h.clock.now = end;
    const next = new Date(end.getTime() + 30 * DAY);
    await h.webhook('subscription.cancelled', { subscription: { entity: { id: 'sub_1', status: 'cancelled', notes: [] } } });
    expect((await h.call('GET', `/v1/orgs/${orgId}`, { user: owner })).body.status).toBe('active');
    await h.webhook('subscription.charged', {
      subscription: { entity: { id: 'sub_3', status: 'active', quantity: 3, current_start: unix(end), current_end: unix(next), notes: [] } },
      payment: { entity: { id: 'pay_r1', amount: 353_646, currency: 'INR' } },
    });
    const org = (await h.call('GET', `/v1/orgs/${orgId}`, { user: owner })).body;
    expect(org).toMatchObject({ status: 'active', seatLimit: 3, paidThrough: new Date(unix(next) * 1000).toISOString() });
    // The never-authorised 4-seat mandate, due to start at the same time, is withdrawn.
    expect(h.razorpay.cancelledSubscriptions).toContainEqual({ id: 'sub_5', atCycleEnd: false });
  });

  it('flags a second first-purchase charge instead of stacking it', async () => {
    const orgId = await createTeam();
    const a = await h.call('POST', `/v1/orgs/${orgId}/checkout`, { user: owner, body: { planKey: 'team_pro_monthly', seats: 2 } });
    const b = await h.call('POST', `/v1/orgs/${orgId}/checkout`, { user: owner, body: { planKey: 'team_pro_monthly', seats: 3 } });
    const end = unix(h.clock.now) + 31 * 86_400;
    // A was withdrawn but its mandate still charges first (cancel raced).
    await h.webhook('subscription.charged', {
      subscription: { entity: { id: 'sub_1', status: 'active', quantity: 2, current_start: unix(h.clock.now), current_end: end, notes: { checkout_id: a.body.checkoutId } } },
      payment: { entity: { id: 'pay_a', amount: 235_764, currency: 'INR' } },
    });
    await h.webhook('subscription.charged', {
      subscription: { entity: { id: 'sub_2', status: 'active', quantity: 3, current_start: unix(h.clock.now), current_end: end + 60, notes: { checkout_id: b.body.checkoutId } } },
      payment: { entity: { id: 'pay_b', amount: 353_646, currency: 'INR' } },
    });
    const alerts = await h.db.query("SELECT kind FROM billing_alerts WHERE kind = 'duplicate_subscription_charge'");
    expect(alerts.rowCount).toBe(1);
    expect((await h.call('GET', `/v1/orgs/${orgId}`, { user: owner })).body.seatLimit).toBe(2);
    // The stray mandate is stopped so it cannot debit again next month.
    expect(h.razorpay.cancelledSubscriptions).toContainEqual({ id: 'sub_2', atCycleEnd: false });
  });

  it('stops autopay debits when auto-renew is turned off', async () => {
    const orgId = await createTeam();
    await activateAutopay(orgId, 2);
    const res = await h.call('PATCH', `/v1/orgs/${orgId}`, { user: owner, body: { autoRenew: false } });
    expect(res.body).toMatchObject({ autoRenew: false, collectionMethod: 'payment_link' });
    expect(h.razorpay.cancelledSubscriptions).toEqual([{ id: 'sub_1', atCycleEnd: true }]);
    // The paid cycle is honoured.
    const ent = await h.call('GET', `/internal/v1/entitlements/${owner.id}`, { token: INTERNAL_TOKEN });
    expect(ent.body.entitled).toBe(true);
  });

  it('retries a failed cancellation from the outbox until it succeeds', async () => {
    const orgId = await createTeam();
    await activateAutopay(orgId, 2);
    h.razorpay.failNextCancel = true;
    await h.call('PATCH', `/v1/orgs/${orgId}`, { user: owner, body: { autoRenew: false } });
    expect(h.razorpay.cancelledSubscriptions).toEqual([]);
    const pending = await h.db.query('SELECT attempts, last_error FROM provider_actions WHERE done_at IS NULL');
    expect(pending.rows).toEqual([{ attempts: 1, last_error: 'razorpay timeout' }]);

    await h.db.query("UPDATE provider_actions SET locked_until = now() - interval '1 second'"); // backoff elapsed
    const run = await h.call('POST', '/internal/v1/jobs/provider-actions', { token: INTERNAL_TOKEN });
    expect(run.body).toEqual({ done: 1, failed: 0, retrying: 0 });
    expect(h.razorpay.cancelledSubscriptions).toEqual([{ id: 'sub_1', atCycleEnd: true }]);
  });

  it('records a withdrawn renewal link that is paid anyway, with an alert', async () => {
    const orgId = await createTeam();
    await h.call('POST', `/v1/orgs/${orgId}/checkout`, { user: owner, body: { planKey: 'team_pro_annual', seats: 5 } });
    await payLink();
    h.clock.now = new Date('2027-10-15T06:00:00Z');
    await h.call('POST', '/internal/v1/jobs/renewals', { token: INTERNAL_TOKEN });
    const r1 = h.razorpay.links.length - 1;
    await h.call('POST', `/v1/orgs/${orgId}/seats`, { user: owner, body: { seats: 4 } }); // withdraws R1
    await h.call('POST', '/internal/v1/jobs/renewals', { token: INTERNAL_TOKEN }); // R2
    await payLink(); // R2 paid: renews
    const res = await payLink(r1); // R1 paid anyway
    expect(res.status).toBe(200);
    const alerts = await h.db.query("SELECT kind FROM billing_alerts WHERE kind = 'payment_on_stale_checkout'");
    expect(alerts.rowCount).toBe(1);
    expect((await h.call('GET', `/v1/orgs/${orgId}`, { user: owner })).body).toMatchObject({ seatLimit: 4, paidThrough: '2028-10-22T06:00:00.000Z' });
  });

  it('flags a superseded replacement that is charged anyway', async () => {
    const orgId = await createTeam();
    const { end } = await activateAutopay(orgId, 2);
    await h.call('POST', `/v1/orgs/${orgId}/seats`, { user: owner, body: { seats: 3 } }); // sub_3
    await h.call('POST', `/v1/orgs/${orgId}/seats`, { user: owner, body: { seats: 4 } }); // supersedes sub_3
    const next = new Date(end.getTime() + 30 * DAY);
    h.clock.now = end;
    await h.webhook('subscription.charged', {
      subscription: { entity: { id: 'sub_3', status: 'active', quantity: 3, current_start: unix(end), current_end: unix(next), notes: [] } },
      payment: { entity: { id: 'pay_stale', amount: 353_646, currency: 'INR' } },
    });
    const alerts = await h.db.query("SELECT kind FROM billing_alerts WHERE kind = 'duplicate_subscription_charge'");
    expect(alerts.rowCount).toBe(1);
    expect((await h.call('GET', `/v1/orgs/${orgId}`, { user: owner })).body.paidThrough).toBe(new Date(unix(end) * 1000).toISOString());
  });

  it('does not apply a superseded top-up', async () => {
    const orgId = await createTeam();
    await h.call('POST', `/v1/orgs/${orgId}/checkout`, { user: owner, body: { planKey: 'team_pro_annual', seats: 5 } });
    await payLink();
    await h.call('POST', `/v1/orgs/${orgId}/seats`, { user: owner, body: { seats: 8 } });
    const staleIndex = h.razorpay.links.length - 1;
    await h.call('POST', `/v1/orgs/${orgId}/seats`, { user: owner, body: { seats: 6 } });
    await payLink(staleIndex);
    expect((await h.call('GET', `/v1/orgs/${orgId}`, { user: owner })).body.seatLimit).toBe(5);
    const alerts = await h.db.query("SELECT kind FROM billing_alerts WHERE kind = 'payment_on_stale_checkout'");
    expect(alerts.rowCount).toBe(1);
  });

  it('caps top-up link lifetime and refuses top-ups on the last day', async () => {
    const orgId = await createTeam();
    await h.call('POST', `/v1/orgs/${orgId}/checkout`, { user: owner, body: { planKey: 'team_pro_annual', seats: 5 } });
    await payLink();
    await h.call('POST', `/v1/orgs/${orgId}/seats`, { user: owner, body: { seats: 6 } });
    expect(h.razorpay.links.at(-1)?.expireBy).toBe(unix(new Date(h.clock.now.getTime() + 7 * DAY)));
    h.clock.now = new Date('2027-10-21T12:00:00Z');
    expect((await h.call('POST', `/v1/orgs/${orgId}/seats`, { user: owner, body: { seats: 7 } })).status).toBe(409);
  });

  it('withdraws an unpaid renewal link when seats change, and the job re-issues it', async () => {
    const orgId = await createTeam();
    await h.call('POST', `/v1/orgs/${orgId}/checkout`, { user: owner, body: { planKey: 'team_pro_annual', seats: 5 } });
    await payLink();
    h.clock.now = new Date('2027-10-15T06:00:00Z');
    await h.call('POST', '/internal/v1/jobs/renewals', { token: INTERNAL_TOKEN });
    const oldRenewal = h.razorpay.links.at(-1);
    expect(oldRenewal?.amountPaise).toBe(5_894_100);

    await h.call('POST', `/v1/orgs/${orgId}/seats`, { user: owner, body: { seats: 4 } });
    expect(h.razorpay.cancelledLinks).toContain(oldRenewal?.id);
    expect((await h.call('POST', '/internal/v1/jobs/renewals', { token: INTERNAL_TOKEN })).body.linksCreated).toBe(1);
    expect(h.razorpay.links.at(-1)?.amountPaise).toBe(4_715_280);
  });

  it('marks the org cancelled when its only mandate ends', async () => {
    const orgId = await createTeam();
    await activateAutopay(orgId, 2);
    await h.webhook('subscription.cancelled', { subscription: { entity: { id: 'sub_1', status: 'cancelled', notes: [] } } });
    expect((await h.call('GET', `/v1/orgs/${orgId}`, { user: owner })).body.status).toBe('cancelled');
  });
});

describe('campus domains', () => {
  let tpo: TestUser;
  let campusId: string;

  beforeEach(async () => {
    tpo = await makeUser('tpo@iitx.ac.in');
    const res = await h.call('POST', '/v1/orgs', {
      user: tpo,
      body: { name: 'IIT X', kind: 'campus', billing: { legalName: 'IIT X', billingStateCode: '27' } },
    });
    campusId = res.body.id as string;
  });

  async function verifiedDomain(user = tpo, orgId = campusId, domain = 'iitx.ac.in') {
    const added = await h.call('POST', `/v1/orgs/${orgId}/domains`, { user, body: { domain, includeSubdomains: true } });
    expect(added.status).toBe(201);
    h.txt.set(added.body.dns.host as string, [['some-other-record'], [String(added.body.dns.value).slice(0, 10), String(added.body.dns.value).slice(10)]]);
    return h.call('POST', `/v1/orgs/${orgId}/domains/${added.body.id as string}/verify`, { user });
  }

  it('requires a verified academic domain before campus checkout', async () => {
    const res = await h.call('POST', `/v1/orgs/${campusId}/checkout`, { user: tpo, body: { planKey: 'campus_lite_annual', seats: 100 } });
    expect(res.status).toBe(409);
    expect((await h.call('POST', `/v1/orgs/${campusId}/domains`, { user: tpo, body: { domain: 'acme.com' } })).status).toBe(400);
    expect((await h.call('POST', `/v1/orgs/${campusId}/domains`, { user: tpo, body: { domain: 'gmail.com' } })).status).toBe(400);

    expect((await verifiedDomain()).body).toMatchObject({ verified: true, domain: 'iitx.ac.in' });
    const ok = await h.call('POST', `/v1/orgs/${campusId}/checkout`, { user: tpo, body: { planKey: 'campus_lite_annual', seats: 100 } });
    expect(ok.status).toBe(201);
    expect(ok.body).toMatchObject({ method: 'payment_link', quote: { taxablePaise: 19_990_000, totalPaise: 23_588_200 } });
    expect((await h.call('POST', `/v1/orgs/${campusId}/checkout`, { user: tpo, body: { planKey: 'team_pro_monthly', seats: 100 } })).status).toBe(400);
  });

  it('reports a missing or wrong TXT record clearly', async () => {
    const added = await h.call('POST', `/v1/orgs/${campusId}/domains`, { user: tpo, body: { domain: 'iitx.ac.in' } });
    const verify = () => h.call('POST', `/v1/orgs/${campusId}/domains/${added.body.id as string}/verify`, { user: tpo });
    expect((await verify()).status).toBe(422);
    h.txt.set(added.body.dns.host as string, [['bharatcode-verify=wrong']]);
    expect((await verify()).status).toBe(422);
  });

  it('only seats emails on the campus domains, even through invites', async () => {
    await verifiedDomain();
    await h.call('POST', `/v1/orgs/${campusId}/checkout`, { user: tpo, body: { planKey: 'campus_lite_annual', seats: 50 } });
    await payLink();
    const token = await invite(campusId, { maxUses: 10 }, tpo);
    const employee = await makeUser('dev@bigcorp.com');
    expect((await h.call('POST', '/v1/invites/accept', { user: employee, body: { token } })).status).toBe(403);
    const unconfirmed = await makeUser('fresh@iitx.ac.in', { verified: false });
    expect((await h.call('POST', '/v1/invites/accept', { user: unconfirmed, body: { token } })).status).toBe(403);
    const student = await makeUser('s1@iitx.ac.in');
    expect((await h.call('POST', '/v1/invites/accept', { user: student, body: { token } })).status).toBe(200);
  });

  it('keeps the last academic domain while the campus plan is active', async () => {
    const verified = await verifiedDomain();
    await h.call('POST', `/v1/orgs/${campusId}/checkout`, { user: tpo, body: { planKey: 'campus_lite_annual', seats: 50 } });
    await payLink();
    const res = await h.call('DELETE', `/v1/orgs/${campusId}/domains/${verified.body.id as string}`, { user: tpo });
    expect(res.status).toBe(409);
  });

  it('lets one org own a verified domain', async () => {
    await verifiedDomain();
    const rival = await makeUser('rival@iitx.ac.in');
    const r = await h.call('POST', '/v1/orgs', { user: rival, body: { name: 'Rival', kind: 'campus' } });
    expect((await verifiedDomain(rival, r.body.id as string)).status).toBe(409);
  });

  it('lets students with verified college emails discover and join', async () => {
    await verifiedDomain();
    await h.call('POST', `/v1/orgs/${campusId}/checkout`, { user: tpo, body: { planKey: 'campus_lite_annual', seats: 50 } });
    await payLink();

    const student = await makeUser('student@cse.iitx.ac.in');
    expect((await h.call('GET', '/v1/me/eligible-orgs', { user: student })).body).toEqual([{ orgId: campusId, name: 'IIT X', kind: 'campus' }]);
    expect((await h.call('POST', `/v1/orgs/${campusId}/join`, { user: student })).status).toBe(200);
    const ent = await h.call('GET', `/internal/v1/entitlements/${student.id}`, { token: INTERNAL_TOKEN });
    expect(ent.body).toMatchObject({ entitled: true, tier: 'lite', zdr: false });

    const unverified = await makeUser('new@iitx.ac.in', { verified: false });
    expect((await h.call('GET', '/v1/me/eligible-orgs', { user: unverified })).body).toEqual([]);
    expect((await h.call('POST', `/v1/orgs/${campusId}/join`, { user: unverified })).status).toBe(403);
    const outsider = await makeUser('kid@iitxac.in');
    expect((await h.call('POST', `/v1/orgs/${campusId}/join`, { user: outsider })).status).toBe(403);

    await h.call('PATCH', `/v1/orgs/${campusId}`, { user: tpo, body: { domainJoinEnabled: false } });
    expect((await h.call('POST', `/v1/orgs/${campusId}/join`, { user: await makeUser('late@iitx.ac.in') })).status).toBe(404);
  });
});

describe('usage', () => {
  it('ingests idempotently, buckets by IST day and reports per member', async () => {
    const orgId = await createTeam();
    await activateAutopay(orgId, 2);
    const outsider = randomUUID();
    const batch = {
      batchId: 'batch-0001',
      events: [
        { userId: owner.id, at: '2026-10-21T20:00:00Z', requests: 3, inputTokens: 1000, outputTokens: 100 }, // 22 Oct IST
        { userId: owner.id, at: '2026-10-22T01:00:00+05:30', requests: 2, inputTokens: 500, outputTokens: 50 }, // 22 Oct IST
        { userId: owner.id, at: '2026-10-21T10:00:00Z', requests: 1, inputTokens: 10, outputTokens: 1 }, // 21 Oct IST
        { userId: outsider, at: '2026-10-21T10:00:00Z', requests: 9, inputTokens: 9, outputTokens: 9 },
      ],
    };
    const post = (body: unknown, token = INTERNAL_TOKEN) => h.call('POST', '/internal/v1/usage', { token, body });
    expect((await post(batch, 'bad')).status).toBe(401);
    expect((await post(batch)).body).toEqual({ duplicate: false, recorded: 3, skipped: 1 });
    expect((await post(batch)).body).toEqual({ duplicate: true, recorded: 0, skipped: 0 });

    const report = await h.call('GET', `/v1/orgs/${orgId}/usage?from=2026-10-21&to=2026-10-22`, { user: owner });
    expect(report.body.daily).toEqual([
      { day: '2026-10-21', requests: 1, inputTokens: 10, outputTokens: 1 },
      { day: '2026-10-22', requests: 5, inputTokens: 1500, outputTokens: 150 },
    ]);
    expect(report.body.totals).toEqual({ requests: 6, inputTokens: 1510, outputTokens: 151 });
    expect(report.body.members).toEqual([
      { userId: owner.id, email: 'owner@acme.in', requests: 6, inputTokens: 1510, outputTokens: 151, lastActive: '2026-10-22' },
    ]);
    const members = await h.call('GET', `/v1/orgs/${orgId}/members`, { user: owner });
    expect(members.body[0].usage30d).toEqual({ requests: 6, inputTokens: 1510, outputTokens: 151 });

    expect((await h.call('GET', `/v1/orgs/${orgId}/usage?from=2026-01-01&to=2026-10-22`, { user: owner })).status).toBe(400);
    expect((await h.call('GET', `/v1/orgs/${orgId}/usage?from=2026-10-23&to=2026-10-22`, { user: owner })).status).toBe(400);
  });

  it('validates usage payloads', async () => {
    const res = await h.call('POST', '/internal/v1/usage', {
      token: INTERNAL_TOKEN,
      body: { batchId: 'batch-0002', events: [{ userId: owner.id, at: 'yesterday', requests: -1, inputTokens: 0, outputTokens: 0 }] },
    });
    expect(res.status).toBe(400);
  });
});

describe('renewals job', () => {
  it('sends one renewal link inside the lead window and marks lapsed orgs past due', async () => {
    const orgId = await createTeam();
    await h.call('POST', `/v1/orgs/${orgId}/checkout`, { user: owner, body: { planKey: 'team_pro_annual', seats: 5 } });
    await payLink();
    const run = () => h.call('POST', '/internal/v1/jobs/renewals', { token: INTERNAL_TOKEN });

    expect((await run()).body).toEqual({ markedPastDue: 0, linksCreated: 0, failures: 0 });
    h.clock.now = new Date('2027-10-15T06:00:00Z');
    expect((await run()).body).toMatchObject({ linksCreated: 1 });
    expect((await run()).body).toMatchObject({ linksCreated: 0 });
    expect(h.razorpay.links.at(-1)).toMatchObject({ amountPaise: 5_894_100, expireBy: unix(new Date('2027-10-29T06:00:00Z')) });

    h.clock.now = new Date('2027-10-23T06:00:00Z');
    expect((await run()).body).toMatchObject({ markedPastDue: 1, linksCreated: 0 });
    const ent = await h.call('GET', `/internal/v1/entitlements/${owner.id}`, { token: INTERNAL_TOKEN });
    expect(ent.body.entitled).toBe(true); // within grace

    // Paying late continues from the old period end, not from the payment date.
    await payLink();
    const org = (await h.call('GET', `/v1/orgs/${orgId}`, { user: owner })).body;
    expect(org).toMatchObject({ status: 'active', paidThrough: '2028-10-22T06:00:00.000Z' });
  });
});

describe('invoices', () => {
  it('renders a printable, escaped invoice for admins only', async () => {
    const orgId = await createTeam(owner, { legalName: '<script>alert(1)</script> Pvt Ltd' });
    await activateAutopay(orgId, 2);
    const [inv] = (await h.call('GET', `/v1/orgs/${orgId}/invoices`, { user: owner })).body;
    const html = await h.app.request(`/v1/orgs/${orgId}/invoices/${inv.id as string}?format=html`, {
      headers: { Authorization: `Bearer ${owner.token}` },
    });
    expect(html.status).toBe(200);
    expect(html.headers.get('content-security-policy')).toContain("default-src 'none'");
    const text = await html.text();
    expect(text).toContain('BC/2627/000001');
    expect(text).toContain('IGST @ 18%');
    expect(text).toContain('₹2,357.64');
    expect(text).not.toContain('<script>');
    expect(text).toContain('&lt;script&gt;');

    const member = await makeUser('m@acme.in');
    await h.call('POST', '/v1/invites/accept', { user: member, body: { token: await invite(orgId) } });
    expect((await h.call('GET', `/v1/orgs/${orgId}/invoices`, { user: member })).status).toBe(403);
  });
});

describe('operational endpoints', () => {
  it('serves health checks and JSON 404s', async () => {
    expect((await h.call('GET', '/healthz')).body).toEqual({ ok: true });
    expect((await h.call('GET', '/readyz')).body).toEqual({ ok: true });
    expect((await h.call('GET', '/nope')).status).toBe(404);
  });

  it('only allows configured CORS origins', async () => {
    const ok = await h.app.request('/v1/plans', { headers: { Origin: 'https://bharatcode.ai' } });
    expect(ok.headers.get('access-control-allow-origin')).toBe('https://bharatcode.ai');
    const bad = await h.app.request('/v1/plans', { headers: { Origin: 'https://evil.example' } });
    expect(bad.headers.get('access-control-allow-origin')).toBeNull();
  });
});
