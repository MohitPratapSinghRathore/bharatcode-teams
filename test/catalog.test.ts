import { describe, expect, it } from 'vitest';
import {
  AUTOPAY_MAX_PAISE,
  PLANS,
  addCycle,
  getPlan,
  inclusivePerSeatPaise,
  quotePeriod,
  quoteSeatTopup,
} from '../src/catalog.js';

const intra = { supplierState: '24', placeOfSupply: '24', sac: '997331' };
const inter = { supplierState: '24', placeOfSupply: '29', sac: '997331' };

describe('plan catalogue', () => {
  it('prices every plan in whole rupees so GST splits are exact', () => {
    for (const plan of Object.values(PLANS)) {
      expect(plan.pricePerSeatPaise % 100).toBe(0);
      expect(plan.minSeats).toBeGreaterThanOrEqual(1);
      expect(plan.maxSeats).toBeGreaterThan(plan.minSeats);
    }
  });

  it('a quote total always equals the Razorpay per-seat amount × seats', () => {
    for (const plan of Object.values(PLANS)) {
      for (const seats of [plan.minSeats, plan.minSeats + 7, plan.maxSeats]) {
        for (const ctx of [intra, inter]) {
          const q = quotePeriod(plan, seats, ctx);
          expect(q.totalPaise).toBe(inclusivePerSeatPaise(plan) * seats);
          expect(q.cgstPaise + q.sgstPaise + q.igstPaise).toBe(q.taxPaise);
          expect(q.taxablePaise + q.taxPaise).toBe(q.totalPaise);
        }
      }
    }
  });

  it('quotes Team Pro monthly for 2 seats', () => {
    const q = quotePeriod(getPlan('team_pro_monthly'), 2, inter);
    expect(q.taxablePaise).toBe(199_800);
    expect(q.igstPaise).toBe(35_964);
    expect(q.totalPaise).toBe(235_764);
    expect(q.lines).toEqual([
      { description: 'BharatCode Team Pro (monthly), 2 seats', sac: '997331', quantity: 2, unitPricePaise: 99_900, taxablePaise: 199_800 },
    ]);
  });

  it('enforces seat ranges', () => {
    expect(() => quotePeriod(getPlan('team_pro_monthly'), 1, intra)).toThrow(RangeError);
    expect(() => quotePeriod(getPlan('campus_lite_annual'), 49, intra)).toThrow(RangeError);
    expect(() => quotePeriod(getPlan('team_pro_monthly'), 2.5, intra)).toThrow(RangeError);
  });

  it('the autopay ceiling sits between small and large teams', () => {
    const plan = getPlan('team_pro_monthly');
    expect(quotePeriod(plan, 12, intra).totalPaise).toBeLessThanOrEqual(AUTOPAY_MAX_PAISE);
    expect(quotePeriod(plan, 13, intra).totalPaise).toBeGreaterThan(AUTOPAY_MAX_PAISE);
  });
});

describe('seat top-ups', () => {
  const plan = getPlan('team_pro_annual');
  const period = { start: new Date('2026-04-01T00:00:00Z'), end: new Date('2027-04-01T00:00:00Z') };

  it('prorates by remaining time, in whole rupees', () => {
    const halfway = new Date((period.start.getTime() + period.end.getTime()) / 2);
    const q = quoteSeatTopup(plan, 5, 7, period, halfway, inter);
    expect(q.taxablePaise).toBe(999_000); // 2 seats × ₹9,990 × 0.5
    expect(q.taxablePaise % 100).toBe(0);
    expect(q.seats).toBe(7);
    const line = q.lines[0];
    expect(line).toBeDefined();
    expect((line?.quantity ?? 0) * (line?.unitPricePaise ?? 0)).toBe(q.taxablePaise);
  });

  it('charges at least ₹1 near the period end', () => {
    const q = quoteSeatTopup(plan, 5, 6, period, new Date(period.end.getTime() - 1000), intra);
    expect(q.taxablePaise).toBe(100);
  });

  it('keeps quantity × rate equal to the taxable value when it does not divide evenly', () => {
    const q = quoteSeatTopup(plan, 5, 8, period, new Date('2026-10-22T06:00:00Z'), intra);
    const line = q.lines[0];
    expect((line?.quantity ?? 0) * (line?.unitPricePaise ?? 0)).toBe(q.taxablePaise);
    expect(Number.isInteger(line?.unitPricePaise)).toBe(true);
  });

  it('rejects non-increases and ended periods', () => {
    expect(() => quoteSeatTopup(plan, 5, 5, period, period.start, intra)).toThrow(RangeError);
    expect(() => quoteSeatTopup(plan, 5, 6, period, period.end, intra)).toThrow(RangeError);
  });
});

describe('addCycle', () => {
  it('adds calendar months and clamps to month end', () => {
    expect(addCycle(new Date('2026-01-31T10:00:00Z'), 'monthly').toISOString()).toBe('2026-02-28T10:00:00.000Z');
    expect(addCycle(new Date('2028-01-31T10:00:00Z'), 'monthly').toISOString()).toBe('2028-02-29T10:00:00.000Z');
    expect(addCycle(new Date('2026-12-15T00:00:00Z'), 'monthly').toISOString()).toBe('2027-01-15T00:00:00.000Z');
    expect(addCycle(new Date('2028-02-29T00:00:00Z'), 'annual').toISOString()).toBe('2029-02-28T00:00:00.000Z');
  });
});
