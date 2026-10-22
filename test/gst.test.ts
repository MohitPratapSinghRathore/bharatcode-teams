import { describe, expect, it } from 'vitest';
import {
  financialYear,
  formatInr,
  formatInvoiceNumber,
  gstinCheckChar,
  istDate,
  percentOf,
  splitTax,
  validateGstin,
} from '../src/gst.js';

describe('GSTIN validation', () => {
  it('accepts a published valid GSTIN', () => {
    // Widely published sample GSTIN with a correct checksum.
    expect(validateGstin('27AAPFU0939F1ZV')).toEqual({ ok: true, gstin: '27AAPFU0939F1ZV', stateCode: '27' });
  });

  it('normalises case and whitespace', () => {
    expect(validateGstin(' 27aapfu0939f1zv ')).toMatchObject({ ok: true, gstin: '27AAPFU0939F1ZV' });
  });

  it('rejects a wrong checksum', () => {
    expect(validateGstin('27AAPFU0939F1ZW')).toMatchObject({ ok: false, reason: expect.stringMatching(/checksum/) });
  });

  it('rejects retired and unknown state codes', () => {
    const first14 = '28AAPFU0939F1Z';
    expect(validateGstin(first14 + gstinCheckChar(first14))).toMatchObject({ ok: false });
    const bad = '99AAPFU0939F1Z';
    expect(validateGstin(bad + gstinCheckChar(bad))).toMatchObject({ ok: false });
  });

  it('rejects malformed input', () => {
    for (const s of ['', '27AAPFU0939F1Z', '27AAPFU0939F1XV', '27AAPF00939F1ZV', '27AAPFU0939F0ZV']) {
      expect(validateGstin(s).ok).toBe(false);
    }
  });
});

describe('tax split', () => {
  it('splits intra-state supply into equal CGST and SGST', () => {
    expect(splitTax(99_900, '24', '24')).toEqual({
      supplyType: 'intra',
      cgstPaise: 8_991,
      sgstPaise: 8_991,
      igstPaise: 0,
      taxPaise: 17_982,
    });
  });

  it('charges IGST on inter-state supply', () => {
    expect(splitTax(99_900, '24', '27')).toEqual({
      supplyType: 'inter',
      cgstPaise: 0,
      sgstPaise: 0,
      igstPaise: 17_982,
      taxPaise: 17_982,
    });
  });

  it('rounds half up in exact integer arithmetic', () => {
    expect(percentOf(150, 9)).toBe(14); // 13.5 → 14
    expect(percentOf(149, 9)).toBe(13); // 13.41 → 13
    expect(percentOf(0, 18)).toBe(0);
    expect(() => percentOf(1.5, 18)).toThrow();
    expect(() => percentOf(-1, 18)).toThrow();
  });
});

describe('financial year and dates (IST)', () => {
  it('rolls over at midnight IST on 1 April, not UTC', () => {
    // 31 Mar 2027 18:29 UTC = 23:59 IST → still FY 26-27.
    expect(financialYear(new Date('2027-03-31T18:29:00Z'))).toBe('2627');
    // 31 Mar 2027 18:30 UTC = 1 Apr 00:00 IST → FY 27-28.
    expect(financialYear(new Date('2027-03-31T18:30:00Z'))).toBe('2728');
    expect(financialYear(new Date('2026-10-22T06:00:00Z'))).toBe('2627');
    expect(financialYear(new Date('2099-06-01T00:00:00Z'))).toBe('9900');
  });

  it('formats IST calendar dates', () => {
    expect(istDate(new Date('2026-10-21T18:29:59Z'))).toBe('2026-10-21');
    expect(istDate(new Date('2026-10-21T18:30:00Z'))).toBe('2026-10-22');
  });
});

describe('invoice numbers', () => {
  it('fits the 16-character limit', () => {
    const n = formatInvoiceNumber('BCTM', '2627', 999_999);
    expect(n).toBe('BCTM/2627/999999');
    expect(n.length).toBe(16);
    expect(formatInvoiceNumber('BC', '2627', 42)).toBe('BC/2627/000042');
  });

  it('rejects bad prefixes and sequences', () => {
    expect(() => formatInvoiceNumber('bc', '2627', 1)).toThrow();
    expect(() => formatInvoiceNumber('TOOLONG', '2627', 1)).toThrow();
    expect(() => formatInvoiceNumber('BC', '2627', 0)).toThrow();
    expect(() => formatInvoiceNumber('BC', '2627', 1_000_000)).toThrow();
  });
});

describe('formatInr', () => {
  it('uses Indian digit grouping', () => {
    expect(formatInr(12_345_678)).toBe('₹1,23,456.78');
    expect(formatInr(99_900)).toBe('₹999.00');
    expect(formatInr(5)).toBe('₹0.05');
    expect(formatInr(1_000_000_000)).toBe('₹1,00,00,000.00');
  });
});
