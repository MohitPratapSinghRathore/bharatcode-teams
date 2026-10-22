import type { AuthUser } from '../auth.js';
import type { InvoiceLine } from '../catalog.js';
import { date, num, type Queryable } from '../db.js';
import { notFound } from '../errors.js';
import { financialYear, formatInr, formatInvoiceNumber, stateName, type TaxSplit } from '../gst.js';
import { ADMIN_ROLES, requireRole, type Deps, type Org } from './common.js';

export interface InvoiceParty {
  legalName: string;
  address: string | null;
  gstin: string | null;
  stateCode: string;
  stateName: string;
  email?: string | null;
}

export interface Invoice {
  id: string;
  orgId: string;
  invoiceNumber: string;
  issuedAt: string;
  providerPaymentId: string;
  supplier: InvoiceParty;
  recipient: InvoiceParty;
  placeOfSupply: string;
  supplyType: 'intra' | 'inter';
  lines: InvoiceLine[];
  taxablePaise: number;
  cgstPaise: number;
  sgstPaise: number;
  igstPaise: number;
  totalPaise: number;
}

const INVOICE_COLUMNS = `id, org_id, invoice_number, issued_at, provider_payment_id, supplier, recipient, place_of_supply,
  supply_type, lines, taxable_paise, cgst_paise, sgst_paise, igst_paise, total_paise`;

// pg returns jsonb parsed; other drivers may return the JSON text.
function parseJson(value: unknown): unknown {
  return typeof value === 'string' ? (JSON.parse(value) as unknown) : value;
}

function mapInvoice(r: Record<string, unknown>): Invoice {
  return {
    id: String(r.id),
    orgId: String(r.org_id),
    invoiceNumber: String(r.invoice_number),
    issuedAt: date(r.issued_at).toISOString(),
    providerPaymentId: String(r.provider_payment_id),
    supplier: parseJson(r.supplier) as InvoiceParty,
    recipient: parseJson(r.recipient) as InvoiceParty,
    placeOfSupply: String(r.place_of_supply).trim(),
    supplyType: r.supply_type as 'intra' | 'inter',
    lines: parseJson(r.lines) as InvoiceLine[],
    taxablePaise: num(r.taxable_paise),
    cgstPaise: num(r.cgst_paise),
    sgstPaise: num(r.sgst_paise),
    igstPaise: num(r.igst_paise),
    totalPaise: num(r.total_paise),
  };
}

/** Buyer details captured when a checkout was quoted, so the invoice matches the quote. */
export interface RecipientSnapshot {
  legalName: string;
  address: string | null;
  gstin: string | null;
  email: string | null;
}

export function recipientOf(org: Org): RecipientSnapshot {
  return { legalName: org.legalName ?? org.name, address: org.billingAddress, gstin: org.gstin, email: org.billingEmail };
}

export interface InvoiceAmounts extends TaxSplit {
  placeOfSupply: string;
  lines: InvoiceLine[];
  taxablePaise: number;
  totalPaise: number;
}

/**
 * Issue the tax invoice for a captured payment. Idempotent per payment id. Numbers come from a
 * per-financial-year counter row updated inside the caller's transaction, so they are consecutive
 * with no gaps (a rolled-back transaction also rolls back its increment).
 */
export async function issueInvoice(
  q: Queryable,
  deps: Deps,
  org: Org,
  amounts: InvoiceAmounts,
  payment: { id: string; checkoutId: string | null; at: Date },
  buyer: RecipientSnapshot = recipientOf(org),
): Promise<Invoice> {
  const existing = await q.query(`SELECT ${INVOICE_COLUMNS} FROM invoices WHERE provider_payment_id = $1`, [payment.id]);
  if (existing.rows[0]) return mapInvoice(existing.rows[0]);

  const fy = financialYear(payment.at);
  const seqRes = await q.query(
    `INSERT INTO invoice_sequences (fy, last_seq) VALUES ($1, 1)
     ON CONFLICT (fy) DO UPDATE SET last_seq = invoice_sequences.last_seq + 1
     RETURNING last_seq`,
    [fy],
  );
  const seq = num(seqRes.rows[0]?.last_seq);
  const invoiceNumber = formatInvoiceNumber(deps.config.invoicePrefix, fy, seq);
  const s = deps.config.supplier;
  const supplier: InvoiceParty = {
    legalName: s.legalName,
    address: s.address,
    gstin: s.gstin,
    stateCode: s.stateCode,
    stateName: stateName(s.stateCode),
  };
  const recipient: InvoiceParty = {
    legalName: buyer.legalName,
    address: buyer.address,
    gstin: buyer.gstin,
    stateCode: amounts.placeOfSupply,
    stateName: stateName(amounts.placeOfSupply),
    email: buyer.email,
  };
  const res = await q.query(
    `INSERT INTO invoices (org_id, checkout_id, invoice_number, fy, seq, issued_at, provider_payment_id, supplier,
                           recipient, place_of_supply, supply_type, lines, taxable_paise, cgst_paise, sgst_paise,
                           igst_paise, total_paise)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
     RETURNING ${INVOICE_COLUMNS}`,
    [
      org.id,
      payment.checkoutId,
      invoiceNumber,
      fy,
      seq,
      payment.at,
      payment.id,
      JSON.stringify(supplier),
      JSON.stringify(recipient),
      amounts.placeOfSupply,
      amounts.supplyType,
      JSON.stringify(amounts.lines),
      amounts.taxablePaise,
      amounts.cgstPaise,
      amounts.sgstPaise,
      amounts.igstPaise,
      amounts.totalPaise,
    ],
  );
  const row = res.rows[0];
  if (!row) throw new Error('Insert returned no row');
  return mapInvoice(row);
}

export async function listInvoices(deps: Deps, user: AuthUser, orgId: string): Promise<Invoice[]> {
  await requireRole(deps.db, orgId, user, ADMIN_ROLES);
  const res = await deps.db.query(
    `SELECT ${INVOICE_COLUMNS} FROM invoices WHERE org_id = $1 ORDER BY issued_at DESC, seq DESC LIMIT 500`,
    [orgId],
  );
  return res.rows.map(mapInvoice);
}

export async function getInvoice(deps: Deps, user: AuthUser, orgId: string, invoiceId: string): Promise<Invoice> {
  await requireRole(deps.db, orgId, user, ADMIN_ROLES);
  const res = await deps.db.query(`SELECT ${INVOICE_COLUMNS} FROM invoices WHERE id = $1 AND org_id = $2`, [
    invoiceId,
    orgId,
  ]);
  const row = res.rows[0];
  if (!row) throw notFound('Invoice not found');
  return mapInvoice(row);
}

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ESCAPES[c] ?? c);
}

function party(title: string, p: InvoiceParty): string {
  const e = escapeHtml;
  return `<section class="party"><h3>${e(title)}</h3>
    <p><strong>${e(p.legalName)}</strong></p>
    ${p.address ? `<p>${e(p.address)}</p>` : ''}
    <p>GSTIN: ${p.gstin ? e(p.gstin) : 'Unregistered'}</p>
    <p>State: ${e(p.stateName)} (${e(p.stateCode)})</p></section>`;
}

/** Printable tax invoice with the particulars GST Rule 46 requires. */
export function renderInvoiceHtml(inv: Invoice): string {
  const e = escapeHtml;
  const issued = new Date(inv.issuedAt).toLocaleDateString('en-IN', {
    timeZone: 'Asia/Kolkata',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
  const rows = inv.lines
    .map(
      (l) => `<tr><td>${e(l.description)}</td><td>${e(l.sac)}</td><td class="n">${l.quantity}</td>
        <td class="n">${formatInr(l.unitPricePaise)}</td><td class="n">${formatInr(l.taxablePaise)}</td></tr>`,
    )
    .join('');
  const taxRows =
    inv.supplyType === 'intra'
      ? `<tr><td colspan="4">CGST @ 9%</td><td class="n">${formatInr(inv.cgstPaise)}</td></tr>
         <tr><td colspan="4">SGST/UTGST @ 9%</td><td class="n">${formatInr(inv.sgstPaise)}</td></tr>`
      : `<tr><td colspan="4">IGST @ 18%</td><td class="n">${formatInr(inv.igstPaise)}</td></tr>`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Tax Invoice ${e(inv.invoiceNumber)}</title>
<style>
body{font:14px/1.5 system-ui,sans-serif;color:#111;background:#fff;margin:0;padding:24px;max-width:860px}
h1{font-size:20px;margin:0 0 4px}h3{font-size:13px;text-transform:uppercase;color:#555;margin:0 0 4px}
.meta,.parties{display:flex;flex-wrap:wrap;gap:24px;margin:16px 0}.party{flex:1 1 280px}.party p{margin:2px 0}
table{width:100%;border-collapse:collapse;margin-top:16px}th,td{border:1px solid #ccc;padding:6px 8px;text-align:left}
th{background:#f4f4f4}.n{text-align:right;white-space:nowrap}tfoot td{font-weight:600}
footer{margin-top:24px;color:#555;font-size:12px}@media print{body{padding:0}}
</style></head><body>
<h1>Tax Invoice</h1>
<div class="meta"><div><strong>Invoice no.</strong> ${e(inv.invoiceNumber)}</div><div><strong>Date</strong> ${e(issued)}</div>
<div><strong>Place of supply</strong> ${e(inv.recipient.stateName)} (${e(inv.placeOfSupply)})</div>
<div><strong>Reverse charge</strong> No</div></div>
<div class="parties">${party('Supplier', inv.supplier)}${party('Bill to', inv.recipient)}</div>
<table><thead><tr><th>Description</th><th>SAC</th><th class="n">Qty</th><th class="n">Rate</th><th class="n">Taxable value</th></tr></thead>
<tbody>${rows}</tbody>
<tfoot><tr><td colspan="4">Taxable value</td><td class="n">${formatInr(inv.taxablePaise)}</td></tr>${taxRows}
<tr><td colspan="4">Total (incl. GST)</td><td class="n">${formatInr(inv.totalPaise)}</td></tr></tfoot></table>
<footer><p>Paid via Razorpay, payment reference ${e(inv.providerPaymentId)}.</p>
<p>This is a computer-generated invoice and does not require a physical signature.</p></footer>
</body></html>`;
}
