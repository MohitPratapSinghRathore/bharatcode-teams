import { GST_RATE_PERCENT, percentOf, splitTax, type TaxSplit } from './gst.js';

export type OrgKind = 'team' | 'campus';
export type PlanTier = 'lite' | 'pro';
export type Cycle = 'monthly' | 'annual';

export interface PlanDef {
  key: PlanKey;
  name: string;
  tier: PlanTier;
  cycle: Cycle;
  /** Per seat per cycle, exclusive of GST. Whole rupees so GST splits are exact in paise. */
  pricePerSeatPaise: number;
  minSeats: number;
  maxSeats: number;
  orgKinds: readonly OrgKind[];
}

export const PLAN_KEYS = ['team_pro_monthly', 'team_pro_annual', 'campus_lite_annual', 'campus_pro_annual'] as const;
export type PlanKey = (typeof PLAN_KEYS)[number];

/**
 * B2B prices are quoted exclusive of GST: a GST-registered buyer claims the 18% back as input
 * tax credit, so a team seat costs the same as an individual Pro plan.
 */
export const PLANS: Readonly<Record<PlanKey, PlanDef>> = {
  team_pro_monthly: {
    key: 'team_pro_monthly',
    name: 'BharatCode Team Pro (monthly)',
    tier: 'pro',
    cycle: 'monthly',
    pricePerSeatPaise: 999_00,
    minSeats: 2,
    maxSeats: 500,
    orgKinds: ['team'],
  },
  team_pro_annual: {
    key: 'team_pro_annual',
    name: 'BharatCode Team Pro (annual)',
    tier: 'pro',
    cycle: 'annual',
    pricePerSeatPaise: 9_990_00,
    minSeats: 2,
    maxSeats: 500,
    orgKinds: ['team'],
  },
  campus_lite_annual: {
    key: 'campus_lite_annual',
    name: 'BharatCode Campus Lite (annual)',
    tier: 'lite',
    cycle: 'annual',
    pricePerSeatPaise: 1_999_00,
    minSeats: 50,
    maxSeats: 20_000,
    orgKinds: ['campus'],
  },
  campus_pro_annual: {
    key: 'campus_pro_annual',
    name: 'BharatCode Campus Pro (annual)',
    tier: 'pro',
    cycle: 'annual',
    pricePerSeatPaise: 5_999_00,
    minSeats: 10,
    maxSeats: 5_000,
    orgKinds: ['campus'],
  },
};

/** RBI e-mandate ceiling for recurring debits (UPI Autopay / cards) without extra authentication. */
export const AUTOPAY_MAX_PAISE = 15_000_00;

/** Razorpay's minimum charge. */
export const MIN_CHARGE_PAISE = 1_00;

export function isPlanKey(value: string): value is PlanKey {
  return (PLAN_KEYS as readonly string[]).includes(value);
}

export function getPlan(key: string): PlanDef {
  if (!isPlanKey(key)) throw new Error(`Unknown plan: ${key}`);
  return PLANS[key];
}

/** Per-seat amount Razorpay must charge for a plan (GST-inclusive). Configure Razorpay plans with this. */
export function inclusivePerSeatPaise(plan: PlanDef): number {
  return plan.pricePerSeatPaise + percentOf(plan.pricePerSeatPaise, GST_RATE_PERCENT);
}

export interface InvoiceLine {
  description: string;
  sac: string;
  quantity: number;
  unitPricePaise: number;
  taxablePaise: number;
}

export interface Quote extends TaxSplit {
  planKey: PlanKey;
  seats: number;
  placeOfSupply: string;
  lines: InvoiceLine[];
  taxablePaise: number;
  totalPaise: number;
}

export interface QuoteContext {
  supplierState: string;
  placeOfSupply: string;
  sac: string;
}

function buildQuote(plan: PlanDef, seats: number, lines: InvoiceLine[], ctx: QuoteContext): Quote {
  const taxablePaise = lines.reduce((sum, line) => sum + line.taxablePaise, 0);
  const tax = splitTax(taxablePaise, ctx.supplierState, ctx.placeOfSupply);
  return {
    planKey: plan.key,
    seats,
    placeOfSupply: ctx.placeOfSupply,
    lines,
    taxablePaise,
    ...tax,
    totalPaise: taxablePaise + tax.taxPaise,
  };
}

export function assertSeats(plan: PlanDef, seats: number): void {
  if (!Number.isSafeInteger(seats) || seats < plan.minSeats || seats > plan.maxSeats) {
    throw new RangeError(`${plan.name} needs between ${plan.minSeats} and ${plan.maxSeats} seats`);
  }
}

/** Quote one full billing cycle for `seats` seats. */
export function quotePeriod(plan: PlanDef, seats: number, ctx: QuoteContext): Quote {
  assertSeats(plan, seats);
  return periodAmounts(plan, seats, ctx);
}

/** Amounts for one cycle without seat-range checks (used to invoice what the provider actually charged). */
export function periodAmounts(plan: PlanDef, seats: number, ctx: QuoteContext): Quote {
  if (!Number.isSafeInteger(seats) || seats < 1) throw new RangeError('Seat count must be a positive integer');
  const line: InvoiceLine = {
    description: `${plan.name}, ${seats} seat${seats === 1 ? '' : 's'}`,
    sac: ctx.sac,
    quantity: seats,
    unitPricePaise: plan.pricePerSeatPaise,
    taxablePaise: plan.pricePerSeatPaise * seats,
  };
  return buildQuote(plan, seats, [line], ctx);
}

/**
 * Quote for adding seats mid-period, prorated by the time left in the period. The taxable amount
 * is rounded to whole rupees (minimum ₹1) so the CGST/SGST split stays exact.
 */
export function quoteSeatTopup(
  plan: PlanDef,
  currentSeats: number,
  newSeats: number,
  period: { start: Date; end: Date },
  now: Date,
  ctx: QuoteContext,
): Quote {
  assertSeats(plan, newSeats);
  const extra = newSeats - currentSeats;
  if (extra <= 0) throw new RangeError('A seat top-up must add at least one seat');
  const periodMs = period.end.getTime() - period.start.getTime();
  const remainingMs = period.end.getTime() - now.getTime();
  if (periodMs <= 0 || remainingMs <= 0) throw new RangeError('The current billing period has ended');
  const fraction = Math.min(1, remainingMs / periodMs);
  const raw = plan.pricePerSeatPaise * extra * fraction;
  const taxablePaise = Math.max(MIN_CHARGE_PAISE, Math.round(raw / 100) * 100);
  // Keep quantity × unit price == taxable value; bill as one unit when it does not divide evenly.
  const quantity = taxablePaise % extra === 0 ? extra : 1;
  const line: InvoiceLine = {
    description: `${plan.name}, ${extra} additional seat${extra === 1 ? '' : 's'} (prorated to ${period.end.toISOString().slice(0, 10)})`,
    sac: ctx.sac,
    quantity,
    unitPricePaise: taxablePaise / quantity,
    taxablePaise,
  };
  return buildQuote(plan, newSeats, [line], ctx);
}

const IST_OFFSET_MS = 330 * 60 * 1000;

/** Add one billing cycle (calendar months in IST, clamped to month end). */
export function addCycle(from: Date, cycle: Cycle): Date {
  const months = cycle === 'monthly' ? 1 : 12;
  // Work on IST wall-clock time so a period that starts on the 1st in India ends on the 1st.
  const d = new Date(from.getTime() + IST_OFFSET_MS);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, lastDay));
  return new Date(d.getTime() - IST_OFFSET_MS);
}
