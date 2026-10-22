import { z } from 'zod';
import type { PlanKey } from './catalog.js';
import { validateGstin } from './gst.js';

const secret = (min: number) => z.string().min(min, `must be at least ${min} characters`);

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  DATABASE_URL: z.string().min(1),
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
  MIGRATE_ON_START: z.enum(['true', 'false']).default('true'),
  /** Origin of the web app that hosts the /join page; invite links point here. */
  PUBLIC_APP_URL: z.url(),
  /** Comma-separated origins allowed to call the API from a browser. */
  CORS_ORIGINS: z.string().default(''),

  SUPABASE_URL: z.url(),
  /** Only for projects still on the legacy HS256 JWT secret; asymmetric keys use JWKS. */
  SUPABASE_JWT_SECRET: secret(32).optional(),
  /**
   * Check email_confirmed_at via the Supabase Admin API before domain joins, email invites and
   * campus joins. Needs SUPABASE_SERVICE_ROLE_KEY. Set false only if the project enforces email
   * confirmation and every sign-in provider returns verified emails.
   */
  REQUIRE_EMAIL_VERIFIED: z.enum(['true', 'false']).default('true'),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(20).optional(),
  /** Days a freed seat stays unavailable to someone new, to stop one seat being passed around. */
  SEAT_COOLDOWN_DAYS: z.coerce.number().int().min(0).max(60).default(7),

  /** Shared secret the model gateway uses for /internal routes. */
  INTERNAL_API_TOKEN: secret(32),

  RAZORPAY_KEY_ID: z.string().min(1),
  RAZORPAY_KEY_SECRET: z.string().min(1),
  RAZORPAY_WEBHOOK_SECRET: secret(16),
  RAZORPAY_API_BASE: z.url().default('https://api.razorpay.com'),
  /**
   * Razorpay subscription plan for UPI Autopay. Only Team Pro monthly can stay within the ₹15,000
   * e-mandate limit (up to 12 seats); every other plan's minimum charge is above it.
   */
  RAZORPAY_PLAN_TEAM_PRO_MONTHLY: z.string().optional(),

  SUPPLIER_LEGAL_NAME: z.string().min(2),
  SUPPLIER_ADDRESS: z.string().min(5),
  SUPPLIER_GSTIN: z.string(),
  INVOICE_PREFIX: z.string().regex(/^[A-Z0-9]{1,4}$/).default('BC'),
  /** SAC 997331: licensing services for the right to use computer software. Confirm with your CA. */
  GST_SAC: z.string().regex(/^\d{6}$/).default('997331'),
  PAST_DUE_GRACE_DAYS: z.coerce.number().int().min(0).max(30).default(7),
  RENEWAL_LEAD_DAYS: z.coerce.number().int().min(1).max(60).default(10),
});

export interface Supplier {
  legalName: string;
  address: string;
  gstin: string;
  stateCode: string;
}

export interface Config {
  env: 'development' | 'test' | 'production';
  port: number;
  logLevel: string;
  databaseUrl: string;
  databasePoolMax: number;
  migrateOnStart: boolean;
  publicAppUrl: string;
  corsOrigins: string[];
  supabaseUrl: string;
  supabaseJwtSecret: string | undefined;
  requireEmailVerified: boolean;
  supabaseServiceRoleKey: string | undefined;
  seatCooldownDays: number;
  internalApiToken: string;
  razorpay: {
    keyId: string;
    keySecret: string;
    webhookSecret: string;
    apiBase: string;
    planIds: Partial<Record<PlanKey, string>>;
  };
  supplier: Supplier;
  invoicePrefix: string;
  sac: string;
  pastDueGraceDays: number;
  renewalLeadDays: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid configuration:\n${problems}`);
  }
  const e = parsed.data;
  const gstin = validateGstin(e.SUPPLIER_GSTIN);
  if (!gstin.ok) throw new Error(`Invalid configuration:\n  SUPPLIER_GSTIN: ${gstin.reason}`);

  if (e.REQUIRE_EMAIL_VERIFIED === 'true' && !e.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error(
      'Invalid configuration:\n  SUPABASE_SERVICE_ROLE_KEY: required when REQUIRE_EMAIL_VERIFIED=true (used to check email_confirmed_at)',
    );
  }
  const planIds: Partial<Record<PlanKey, string>> = {};
  if (e.RAZORPAY_PLAN_TEAM_PRO_MONTHLY) planIds.team_pro_monthly = e.RAZORPAY_PLAN_TEAM_PRO_MONTHLY;

  return {
    env: e.NODE_ENV,
    port: e.PORT,
    logLevel: e.LOG_LEVEL,
    databaseUrl: e.DATABASE_URL,
    databasePoolMax: e.DATABASE_POOL_MAX,
    migrateOnStart: e.MIGRATE_ON_START === 'true',
    publicAppUrl: e.PUBLIC_APP_URL.replace(/\/+$/, ''),
    corsOrigins: e.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean),
    supabaseUrl: e.SUPABASE_URL.replace(/\/+$/, ''),
    supabaseJwtSecret: e.SUPABASE_JWT_SECRET,
    requireEmailVerified: e.REQUIRE_EMAIL_VERIFIED === 'true',
    supabaseServiceRoleKey: e.SUPABASE_SERVICE_ROLE_KEY,
    seatCooldownDays: e.SEAT_COOLDOWN_DAYS,
    internalApiToken: e.INTERNAL_API_TOKEN,
    razorpay: {
      keyId: e.RAZORPAY_KEY_ID,
      keySecret: e.RAZORPAY_KEY_SECRET,
      webhookSecret: e.RAZORPAY_WEBHOOK_SECRET,
      apiBase: e.RAZORPAY_API_BASE.replace(/\/+$/, ''),
      planIds,
    },
    supplier: {
      legalName: e.SUPPLIER_LEGAL_NAME,
      address: e.SUPPLIER_ADDRESS,
      gstin: gstin.gstin,
      stateCode: gstin.stateCode,
    },
    invoicePrefix: e.INVOICE_PREFIX,
    sac: e.GST_SAC,
    pastDueGraceDays: e.PAST_DUE_GRACE_DAYS,
    renewalLeadDays: e.RENEWAL_LEAD_DAYS,
  };
}
