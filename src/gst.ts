/**
 * Indian GST rules used for invoicing: GSTIN validation, state codes, place-of-supply tax split,
 * financial-year numbering. All amounts are integer paise.
 */

export const GST_RATE_PERCENT = 18;

/** GST state/UT codes in current use (25 and 28 were retired in favour of 26 and 37). */
export const STATE_CODES: Readonly<Record<string, string>> = {
  '01': 'Jammu and Kashmir',
  '02': 'Himachal Pradesh',
  '03': 'Punjab',
  '04': 'Chandigarh',
  '05': 'Uttarakhand',
  '06': 'Haryana',
  '07': 'Delhi',
  '08': 'Rajasthan',
  '09': 'Uttar Pradesh',
  '10': 'Bihar',
  '11': 'Sikkim',
  '12': 'Arunachal Pradesh',
  '13': 'Nagaland',
  '14': 'Manipur',
  '15': 'Mizoram',
  '16': 'Tripura',
  '17': 'Meghalaya',
  '18': 'Assam',
  '19': 'West Bengal',
  '20': 'Jharkhand',
  '21': 'Odisha',
  '22': 'Chhattisgarh',
  '23': 'Madhya Pradesh',
  '24': 'Gujarat',
  '26': 'Dadra and Nagar Haveli and Daman and Diu',
  '27': 'Maharashtra',
  '29': 'Karnataka',
  '30': 'Goa',
  '31': 'Lakshadweep',
  '32': 'Kerala',
  '33': 'Tamil Nadu',
  '34': 'Puducherry',
  '35': 'Andaman and Nicobar Islands',
  '36': 'Telangana',
  '37': 'Andhra Pradesh',
  '38': 'Ladakh',
  '97': 'Other Territory',
};

export function isStateCode(code: string): boolean {
  return Object.hasOwn(STATE_CODES, code);
}

export function stateName(code: string): string {
  const name = STATE_CODES[code];
  if (name === undefined) throw new Error(`Unknown GST state code: ${code}`);
  return name;
}

const GSTIN_CHARSET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
// Regular taxpayer GSTIN: state(2) + PAN(10) + entity number(1) + 'Z' + checksum(1).
const GSTIN_PATTERN = /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

/** Checksum character for the first 14 characters of a GSTIN (GSTN's mod-36 algorithm). */
export function gstinCheckChar(first14: string): string {
  if (first14.length !== 14) throw new Error('GSTIN checksum needs exactly 14 characters');
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const value = GSTIN_CHARSET.indexOf(first14.charAt(i));
    if (value < 0) throw new Error('GSTIN contains an invalid character');
    const product = value * (i % 2 === 0 ? 1 : 2);
    sum += Math.floor(product / 36) + (product % 36);
  }
  return GSTIN_CHARSET.charAt((36 - (sum % 36)) % 36);
}

export type GstinCheck = { ok: true; gstin: string; stateCode: string } | { ok: false; reason: string };

export function validateGstin(input: string): GstinCheck {
  const gstin = input.trim().toUpperCase();
  if (!GSTIN_PATTERN.test(gstin)) return { ok: false, reason: 'GSTIN must be 15 characters in the standard format' };
  const stateCode = gstin.slice(0, 2);
  if (!isStateCode(stateCode)) return { ok: false, reason: `GSTIN state code ${stateCode} is not valid` };
  if (gstinCheckChar(gstin.slice(0, 14)) !== gstin.charAt(14)) {
    return { ok: false, reason: 'GSTIN checksum does not match' };
  }
  return { ok: true, gstin, stateCode };
}

/** Round a non-negative integer × percent / 100 half-up, in exact integer arithmetic. */
export function percentOf(paise: number, percent: number): number {
  if (!Number.isSafeInteger(paise) || paise < 0) throw new Error('Amount must be a non-negative integer of paise');
  return Math.floor((paise * percent + 50) / 100);
}

export interface TaxSplit {
  supplyType: 'intra' | 'inter';
  cgstPaise: number;
  sgstPaise: number;
  igstPaise: number;
  taxPaise: number;
}

/**
 * Intra-state supply (supplier state == place of supply) attracts CGST + SGST at half rate each;
 * inter-state supply attracts IGST at the full rate.
 */
export function splitTax(taxablePaise: number, supplierState: string, placeOfSupply: string): TaxSplit {
  if (supplierState === placeOfSupply) {
    const half = percentOf(taxablePaise, GST_RATE_PERCENT / 2);
    return { supplyType: 'intra', cgstPaise: half, sgstPaise: half, igstPaise: 0, taxPaise: half * 2 };
  }
  const igst = percentOf(taxablePaise, GST_RATE_PERCENT);
  return { supplyType: 'inter', cgstPaise: 0, sgstPaise: 0, igstPaise: igst, taxPaise: igst };
}

const IST_OFFSET_MS = 330 * 60 * 1000;

/** Calendar parts of an instant as seen in India Standard Time. */
export function istParts(at: Date): { year: number; month: number; day: number } {
  const shifted = new Date(at.getTime() + IST_OFFSET_MS);
  return { year: shifted.getUTCFullYear(), month: shifted.getUTCMonth() + 1, day: shifted.getUTCDate() };
}

/** YYYY-MM-DD of an instant in IST. */
export function istDate(at: Date): string {
  const { year, month, day } = istParts(at);
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** Indian financial year (April–March, IST) as a 4-digit code, e.g. 1 May 2026 → "2627". */
export function financialYear(at: Date): string {
  const { year, month } = istParts(at);
  const start = month >= 4 ? year : year - 1;
  return `${String(start % 100).padStart(2, '0')}${String((start + 1) % 100).padStart(2, '0')}`;
}

/**
 * Invoice number: PREFIX/FY/SEQ, e.g. BC/2627/000042. GST Rule 46 caps it at 16 characters and
 * requires it to be unique and consecutive within a financial year.
 */
export function formatInvoiceNumber(prefix: string, fy: string, seq: number): string {
  if (!/^[A-Z0-9]{1,4}$/.test(prefix)) throw new Error('Invoice prefix must be 1-4 uppercase letters or digits');
  if (!Number.isSafeInteger(seq) || seq < 1 || seq > 999_999) throw new Error('Invoice sequence out of range');
  const number = `${prefix}/${fy}/${String(seq).padStart(6, '0')}`;
  if (number.length > 16) throw new Error('Invoice number exceeds 16 characters');
  return number;
}

/** "₹1,23,456.78" (Indian digit grouping). */
export function formatInr(paise: number): string {
  const negative = paise < 0;
  const abs = Math.abs(paise);
  const rupees = Math.floor(abs / 100);
  const fraction = String(abs % 100).padStart(2, '0');
  const digits = String(rupees);
  const lastThree = digits.slice(-3);
  const rest = digits.slice(0, -3);
  const grouped = rest ? `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${lastThree}` : lastThree;
  return `${negative ? '-' : ''}₹${grouped}.${fraction}`;
}
