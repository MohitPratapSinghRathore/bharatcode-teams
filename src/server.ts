import { resolveTxt } from 'node:dns/promises';
import { serve } from '@hono/node-server';
import pino from 'pino';
import { createEmailConfirmer, supabaseVerifier, type EmailConfirmer } from './auth.js';
import { inclusivePerSeatPaise, getPlan, PLAN_KEYS } from './catalog.js';
import { loadConfig, type Config } from './config.js';
import { createPgDb, migrate } from './db.js';
import { createApp } from './http/app.js';
import { createRazorpayClient, type RazorpayApi } from './razorpay.js';
import type { Deps } from './services/common.js';

/**
 * Check each configured Razorpay plan charges exactly the GST-inclusive seat price for the right
 * cycle. A misconfigured plan is dropped, so those checkouts fall back to payment links instead of
 * charging a wrong amount.
 */
async function verifyRazorpayPlans(config: Config, razorpay: RazorpayApi, log: pino.Logger): Promise<void> {
  const verified: Config['razorpay']['planIds'] = {};
  for (const key of PLAN_KEYS) {
    const planId = config.razorpay.planIds[key];
    if (!planId) continue;
    const plan = getPlan(key);
    try {
      const remote = await razorpay.fetchPlan(planId);
      const expectedPeriod = plan.cycle === 'monthly' ? 'monthly' : 'yearly';
      const expectedAmount = inclusivePerSeatPaise(plan);
      if (
        remote.amountPaise !== expectedAmount ||
        remote.currency !== 'INR' ||
        remote.period !== expectedPeriod ||
        remote.interval !== 1
      ) {
        log.error({ key, planId, remote, expectedAmount, expectedPeriod }, 'razorpay plan mismatch; autopay disabled for it');
        continue;
      }
      verified[key] = planId;
    } catch (err) {
      log.error({ err, key, planId }, 'could not verify razorpay plan; autopay disabled for it');
    }
  }
  config.razorpay.planIds = verified;
}

async function main(): Promise<void> {
  const config = loadConfig();
  const log = pino({
    level: config.logLevel,
    redact: ['req.headers.authorization', '*.authorization', '*.token', '*.keySecret', '*.serviceRoleKey'],
  });
  const db = createPgDb(config.databaseUrl, config.databasePoolMax);
  if (config.migrateOnStart) {
    const applied = await migrate(db);
    if (applied.length) log.info({ applied }, 'migrations applied');
  }
  const razorpay = createRazorpayClient(config.razorpay);
  await verifyRazorpayPlans(config, razorpay, log);

  const serviceRoleKey = config.supabaseServiceRoleKey;
  const confirmEmail: EmailConfirmer = serviceRoleKey
    ? createEmailConfirmer({ supabaseUrl: config.supabaseUrl, serviceRoleKey })
    : () => Promise.resolve(true); // only reachable with REQUIRE_EMAIL_VERIFIED=false
  const deps: Deps = { db, config, razorpay, log, now: () => new Date(), resolveTxt, confirmEmail };
  const app = createApp(deps, supabaseVerifier(config.supabaseUrl, config.supabaseJwtSecret));
  const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
    log.info({ port: info.port }, 'bharatcode-teams listening');
  });

  let stopping = false;
  const shutdown = (signal: string) => {
    if (stopping) return;
    stopping = true;
    log.info({ signal }, 'shutting down');
    const force = setTimeout(() => {
      process.exit(1);
    }, 15_000);
    force.unref();
    server.close(() => {
      db.close()
        .catch((err: unknown) => {
          log.error({ err }, 'error closing database');
        })
        .finally(() => {
          process.exit(0);
        });
    });
  };
  process.on('SIGTERM', () => {
    shutdown('SIGTERM');
  });
  process.on('SIGINT', () => {
    shutdown('SIGINT');
  });
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
