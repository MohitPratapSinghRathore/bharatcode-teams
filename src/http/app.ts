import { Hono, type Context, type MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { cors } from 'hono/cors';
import { HTTPException } from 'hono/http-exception';
import { requestId } from 'hono/request-id';
import { routePath } from 'hono/route';
import { secureHeaders } from 'hono/secure-headers';
import { z } from 'zod';
import { bearerToken, safeEqual, type AuthUser, type TokenVerifier } from '../auth.js';
import { PLANS, PLAN_KEYS, inclusivePerSeatPaise } from '../catalog.js';
import { AppError, badRequest, notFound, unauthorized } from '../errors.js';
import { changeSeats, getQuote, runRenewals, startCheckout } from '../services/billing.js';
import type { Deps } from '../services/common.js';
import { addDomain, eligibleOrgs, joinByDomain, listDomains, removeDomain, verifyDomain } from '../services/domains.js';
import { acceptInvite, createInvite, listInvites, previewInvite, revokeInvite } from '../services/invites.js';
import { runProviderActions } from '../services/outbox.js';
import { getInvoice, listInvoices, renderInvoiceHtml } from '../services/invoices.js';
import {
  changeRole,
  createOrg,
  getOrgView,
  listMembers,
  listMyOrgs,
  removeMember,
  updateOrg,
} from '../services/orgs.js';
import { getEntitlement, ingestUsage, usageReport } from '../services/usage.js';
import { handleRazorpayWebhook } from '../services/webhooks.js';

type Env = { Variables: { user: AuthUser; requestId: string } };

const id = z.guid();
const billingSchema = z
  .object({
    billingEmail: z.email().max(254).nullable().optional(),
    legalName: z.string().max(200).nullable().optional(),
    billingAddress: z.string().max(500).nullable().optional(),
    billingStateCode: z.string().regex(/^\d{2}$/).nullable().optional(),
    gstin: z.string().max(20).nullable().optional(),
  })
  .strict();

const schemas = {
  createOrg: z
    .object({ name: z.string().trim().min(2).max(120), kind: z.enum(['team', 'campus']), billing: billingSchema.optional() })
    .strict(),
  updateOrg: z
    .object({
      name: z.string().trim().min(2).max(120).optional(),
      autoRenew: z.boolean().optional(),
      domainJoinEnabled: z.boolean().optional(),
      billing: billingSchema.optional(),
    })
    .strict(),
  role: z.object({ role: z.enum(['owner', 'admin', 'member']) }).strict(),
  createInvite: z
    .object({
      email: z.email().max(254).optional(),
      role: z.enum(['admin', 'member']).optional(),
      maxUses: z.number().int().min(1).max(10_000).optional(),
      expiresInDays: z.number().int().min(1).max(90).optional(),
    })
    .strict(),
  acceptInvite: z.object({ token: z.string().min(20).max(100) }).strict(),
  addDomain: z.object({ domain: z.string().min(4).max(253), includeSubdomains: z.boolean().optional() }).strict(),
  checkout: z.object({ planKey: z.enum(PLAN_KEYS), seats: z.number().int().min(1).max(100_000) }).strict(),
  seats: z.object({ seats: z.number().int().min(1).max(100_000) }).strict(),
  usage: z
    .object({
      batchId: z.string().min(8).max(128),
      events: z
        .array(
          z
            .object({
              userId: id,
              at: z.iso.datetime({ offset: true }),
              requests: z.number().int().min(0).max(1_000_000),
              inputTokens: z.number().int().min(0).max(1e12),
              outputTokens: z.number().int().min(0).max(1e12),
            })
            .strict(),
        )
        .max(5000),
    })
    .strict(),
};

async function body<T extends z.ZodType>(c: Context, schema: T): Promise<z.infer<T>> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw badRequest('Request body must be JSON');
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw badRequest(
      'Invalid request',
      parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    );
  }
  return parsed.data;
}

/** A path id that is not a UUID can never match a row, so treat it as not found. */
function param(c: Context, name: string): string {
  const value = c.req.param(name);
  if (!value || !id.safeParse(value).success) throw notFound();
  return value.toLowerCase();
}

export function createApp(deps: Deps, verify: TokenVerifier): Hono<Env> {
  const app = new Hono<Env>();

  app.use('*', requestId());
  app.use('*', secureHeaders());
  app.use('*', async (c, next) => {
    const started = performance.now();
    await next();
    deps.log.info(
      {
        requestId: c.get('requestId'),
        method: c.req.method,
        // Route pattern, not the raw path: raw paths carry invite tokens and ids.
        route: routePath(c as unknown as Context),
        status: c.res.status,
        ms: Math.round(performance.now() - started),
      },
      'request',
    );
  });

  app.onError((err, c) => {
    if (err instanceof AppError) {
      return c.json({ error: { code: err.code, message: err.message, details: err.details } }, err.status);
    }
    if (err instanceof HTTPException) {
      const status = err.status;
      return c.json({ error: { code: status === 413 ? 'payload_too_large' : 'bad_request', message: err.message } }, status);
    }
    // Log message/code/stack only: driver errors carry a `detail` field that can include emails.
    const e = err as Error & { code?: unknown };
    deps.log.error({ err: { name: e.name, message: e.message, code: e.code, stack: e.stack }, requestId: c.get('requestId') }, 'unhandled error');
    return c.json({ error: { code: 'internal', message: 'Something went wrong. Please try again.' } }, 500);
  });
  app.notFound((c) => c.json({ error: { code: 'not_found', message: 'Not found' } }, 404));

  app.get('/healthz', (c) => c.json({ ok: true }));
  app.get('/readyz', async (c) => {
    try {
      await deps.db.ping();
      return c.json({ ok: true });
    } catch (err) {
      deps.log.error({ err }, 'readiness check failed');
      return c.json({ ok: false }, 503);
    }
  });

  // --- Razorpay webhooks (authenticated by HMAC signature over the raw body) ---
  app.post('/webhooks/razorpay', bodyLimit({ maxSize: 1024 * 1024 }), async (c) => {
    const raw = await c.req.text();
    const outcome = await handleRazorpayWebhook(
      deps,
      raw,
      c.req.header('x-razorpay-signature'),
      c.req.header('x-razorpay-event-id'),
    );
    return c.json({ ok: true, outcome });
  });

  // --- Internal API for the model gateway and schedulers (shared bearer token) ---
  const internal = new Hono<Env>();
  internal.use('*', async (c, next) => {
    const token = bearerToken(c.req.header('authorization'));
    if (!token || !safeEqual(token, deps.config.internalApiToken)) throw unauthorized('Invalid internal token');
    await next();
  });
  internal.get('/entitlements/:userId', async (c) => {
    const ent = await getEntitlement(deps, param(c, 'userId'));
    c.header('Cache-Control', 'private, max-age=60');
    return c.json(ent);
  });
  internal.post('/usage', bodyLimit({ maxSize: 2 * 1024 * 1024 }), async (c) => {
    const input = await body(c, schemas.usage);
    const result = await ingestUsage(
      deps,
      input.batchId,
      input.events.map((e) => ({ ...e, userId: e.userId.toLowerCase(), at: new Date(e.at) })),
    );
    return c.json(result);
  });
  internal.post('/jobs/renewals', async (c) => c.json(await runRenewals(deps)));
  internal.post('/jobs/provider-actions', async (c) => c.json(await runProviderActions(deps)));
  app.route('/internal/v1', internal);

  // --- Public API (Supabase session) ---
  const api = new Hono<Env>();
  const allowed = new Set(deps.config.corsOrigins);
  api.use(
    '*',
    cors({
      origin: (origin) => (allowed.has(origin) ? origin : null),
      allowMethods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
      allowHeaders: ['Authorization', 'Content-Type'],
      maxAge: 600,
    }),
  );
  api.use('*', bodyLimit({ maxSize: 64 * 1024 }));

  const auth: MiddlewareHandler<Env> = async (c, next) => {
    const token = bearerToken(c.req.header('authorization'));
    if (!token) throw unauthorized();
    c.set('user', await verify(token));
    await next();
  };

  api.get('/plans', (c) =>
    c.json(
      Object.values(PLANS).map((p) => ({
        key: p.key,
        name: p.name,
        tier: p.tier,
        cycle: p.cycle,
        orgKinds: p.orgKinds,
        minSeats: p.minSeats,
        maxSeats: p.maxSeats,
        pricePerSeatPaise: p.pricePerSeatPaise,
        pricePerSeatInclGstPaise: inclusivePerSeatPaise(p),
      })),
    ),
  );
  api.get('/invites/:token', async (c) => {
    const token = c.req.param('token');
    if (token.length < 20 || token.length > 100) throw notFound('This invite link is invalid or has expired');
    return c.json(await previewInvite(deps, token));
  });

  api.get('/me/orgs', auth, async (c) => c.json(await listMyOrgs(deps, c.get('user'))));
  api.get('/me/eligible-orgs', auth, async (c) => c.json(await eligibleOrgs(deps, c.get('user'))));

  api.post('/orgs', auth, async (c) => c.json(await createOrg(deps, c.get('user'), await body(c, schemas.createOrg)), 201));
  api.get('/orgs/:orgId', auth, async (c) => c.json(await getOrgView(deps, c.get('user'), param(c, 'orgId'))));
  api.patch('/orgs/:orgId', auth, async (c) =>
    c.json(await updateOrg(deps, c.get('user'), param(c, 'orgId'), await body(c, schemas.updateOrg))),
  );

  api.get('/orgs/:orgId/members', auth, async (c) => c.json(await listMembers(deps, c.get('user'), param(c, 'orgId'))));
  api.delete('/orgs/:orgId/members/:userId', auth, async (c) => {
    await removeMember(deps, c.get('user'), param(c, 'orgId'), param(c, 'userId'));
    return c.body(null, 204);
  });
  api.patch('/orgs/:orgId/members/:userId', auth, async (c) => {
    const { role } = await body(c, schemas.role);
    await changeRole(deps, c.get('user'), param(c, 'orgId'), param(c, 'userId'), role);
    return c.body(null, 204);
  });

  api.post('/orgs/:orgId/invites', auth, async (c) =>
    c.json(await createInvite(deps, c.get('user'), param(c, 'orgId'), await body(c, schemas.createInvite)), 201),
  );
  api.get('/orgs/:orgId/invites', auth, async (c) => c.json(await listInvites(deps, c.get('user'), param(c, 'orgId'))));
  api.delete('/orgs/:orgId/invites/:inviteId', auth, async (c) => {
    await revokeInvite(deps, c.get('user'), param(c, 'orgId'), param(c, 'inviteId'));
    return c.body(null, 204);
  });
  api.post('/invites/accept', auth, async (c) => {
    const { token } = await body(c, schemas.acceptInvite);
    return c.json(await acceptInvite(deps, c.get('user'), token));
  });

  api.post('/orgs/:orgId/domains', auth, async (c) =>
    c.json(await addDomain(deps, c.get('user'), param(c, 'orgId'), await body(c, schemas.addDomain)), 201),
  );
  api.get('/orgs/:orgId/domains', auth, async (c) => c.json(await listDomains(deps, c.get('user'), param(c, 'orgId'))));
  api.post('/orgs/:orgId/domains/:domainId/verify', auth, async (c) =>
    c.json(await verifyDomain(deps, c.get('user'), param(c, 'orgId'), param(c, 'domainId'))),
  );
  api.delete('/orgs/:orgId/domains/:domainId', auth, async (c) => {
    await removeDomain(deps, c.get('user'), param(c, 'orgId'), param(c, 'domainId'));
    return c.body(null, 204);
  });
  api.post('/orgs/:orgId/join', auth, async (c) => {
    await joinByDomain(deps, c.get('user'), param(c, 'orgId'));
    return c.json({ orgId: param(c, 'orgId') });
  });

  api.get('/orgs/:orgId/quote', auth, async (c) => {
    const plan = c.req.query('plan') ?? '';
    const seats = Number(c.req.query('seats'));
    if (!Number.isSafeInteger(seats)) throw badRequest('seats must be an integer');
    return c.json(await getQuote(deps, c.get('user'), param(c, 'orgId'), plan, seats));
  });
  api.post('/orgs/:orgId/checkout', auth, async (c) =>
    c.json(await startCheckout(deps, c.get('user'), param(c, 'orgId'), await body(c, schemas.checkout)), 201),
  );
  api.post('/orgs/:orgId/seats', auth, async (c) => {
    const { seats } = await body(c, schemas.seats);
    return c.json(await changeSeats(deps, c.get('user'), param(c, 'orgId'), seats));
  });

  api.get('/orgs/:orgId/usage', auth, async (c) =>
    c.json(
      await usageReport(deps, c.get('user'), param(c, 'orgId'), { from: c.req.query('from'), to: c.req.query('to') }),
    ),
  );
  api.get('/orgs/:orgId/invoices', auth, async (c) => c.json(await listInvoices(deps, c.get('user'), param(c, 'orgId'))));
  api.get('/orgs/:orgId/invoices/:invoiceId', auth, async (c) => {
    const invoice = await getInvoice(deps, c.get('user'), param(c, 'orgId'), param(c, 'invoiceId'));
    if (c.req.query('format') === 'html') {
      c.header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'");
      return c.html(renderInvoiceHtml(invoice));
    }
    return c.json(invoice);
  });

  app.route('/v1', api);
  return app;
}
