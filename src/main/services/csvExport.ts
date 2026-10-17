/**
 * CSV export (owner: data area). Writes the same tabular kinds the CSV importer reads, with the importer's field labels as
 * column headers, so an exported file maps itself automatically when it is imported again (round trip).
 *
 * Format: UTF-8 with BOM (Excel opens Urdu text correctly), RFC-4180 quoting (commas, quotes, newlines), CRLF rows,
 * ISO dates (yyyy-mm-dd), '.' decimals, empty cell = no value. Text cells that a spreadsheet would run as a formula
 * (= + - @) get a leading apostrophe; the importer removes it again.
 *
 * Sales / purchase invoices are one flat line-level file: one row per invoice line, the invoice header repeated on every
 * line and keyed by the invoice number. "Paid amount" is only the payment taken at billing (its own payment is left out
 * of the payments export so it is not counted twice); every other payment is in the payments export with its
 * "Against" allocations. Cancelled documents / payments / expenses are not exported.
 *
 * CSV is NOT a full backup: settings, users, images, projects, returns, stock movement history, cancelled records are
 * not included - use the full backup for that.
 */
import { AppError, Ctx, isValidDate, requirePerm } from './context'
import { assertKind, importFields, type ImportKind } from './importer'

export interface CsvExportOptions {
  /** Only documents / payments / expenses dated from .. to (yyyy-mm-dd, inclusive). */
  from?: string
  to?: string
}

export interface CsvExportResult {
  kind: ImportKind
  text: string
  rows: number
}

type Cell = string | number | boolean | null | undefined
type Row = Record<string, Cell>

const r2 = (n: number): number => Math.round(n * 100) / 100
const r3 = (n: number): number => Math.round(n * 1000) / 1000

/** One CSV cell (RFC-4180) with the spreadsheet formula guard for text. */
export function csvCell(v: Cell): string {
  if (v === null || v === undefined) return ''
  let s: string
  if (typeof v === 'number') s = Number.isFinite(v) ? String(Object.is(v, -0) ? 0 : v) : ''
  else if (typeof v === 'boolean') s = v ? 'Yes' : 'No'
  else {
    s = v
    if (/^'?[=+\-@\t\r]/.test(s)) s = `'${s}`
  }
  return /[",\n\r]/.test(s) || /^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export function toCsv(headers: string[], rows: Cell[][]): string {
  return '﻿' + [headers.map(csvCell).join(','), ...rows.map((r) => r.map(csvCell).join(','))].join('\r\n') + '\r\n'
}

function dateRange(opts: CsvExportOptions, col: string): { sql: string; args: string[] } {
  const parts: string[] = []
  const args: string[] = []
  for (const [k, op] of [['from', '>='], ['to', '<=']] as const) {
    const v = opts[k]
    if (v === undefined || v === null || v === '') continue
    if (!isValidDate(String(v))) throw new AppError(`"${k === 'from' ? 'From' : 'To'}" date must be yyyy-mm-dd.`, 'VALIDATION')
    parts.push(`${col} ${op} ?`)
    args.push(String(v))
  }
  return { sql: parts.length ? ` AND ${parts.join(' AND ')}` : '', args }
}

/** Payment taken at billing for a document: notes "Against <number>" and a single allocation to that document. */
const BILLING_PAYMENT = `p.status <> 'cancelled' AND p.notes = 'Against ' || d.number
  AND (SELECT COUNT(*) FROM payment_allocations x WHERE x.payment_id = p.id) = 1`

function rowsFor(ctx: Ctx, kind: ImportKind, opts: CsvExportOptions): Row[] {
  const db = ctx.db
  const firm = ctx.firmId
  switch (kind) {
    case 'products':
      return (
        db
          .prepare(
            `SELECT p.*, c.name AS category,
                    (SELECT COALESCE(SUM(m.qty_in), 0) FROM stock_movements m WHERE m.product_id = p.id AND m.ref_type = 'opening' AND m.firm_id = ?) AS oq,
                    (SELECT COALESCE(SUM(m.qty_in * m.unit_cost), 0) FROM stock_movements m WHERE m.product_id = p.id AND m.ref_type = 'opening' AND m.firm_id = ?) AS ov
               FROM products p LEFT JOIN categories c ON c.id = p.category_id
              WHERE (p.firm_id IS NULL OR p.firm_id = ?) ORDER BY p.name COLLATE NOCASE, p.id`
          )
          .all(firm, firm, firm) as Array<Record<string, unknown>>
      ).map((p) => ({
        name: p.name as string,
        sku: p.sku as string | null,
        barcode: p.barcode as string | null,
        type: p.type as string,
        category: p.category as string | null,
        unit: p.unit as string | null,
        brand: p.brand as string | null,
        model: p.model as string | null,
        description: p.description as string | null,
        purchasePrice: p.purchase_price as number,
        salePrice: p.sale_price as number,
        minSalePrice: p.min_sale_price as number,
        taxRate: p.tax_rate as number,
        reorderLevel: p.reorder_level as number,
        warrantyMonths: p.warranty_months as number,
        openingQty: Number(p.oq) ? r3(Number(p.oq)) : null,
        openingCost: Number(p.oq) ? r2(Number(p.ov) / Number(p.oq)) : null
      }))
    case 'categories':
      return (db.prepare('SELECT name, kind FROM categories WHERE (firm_id IS NULL OR firm_id = ?) ORDER BY name COLLATE NOCASE').all(firm) as Row[]).map((c) => ({ ...c }))
    case 'customers':
    case 'suppliers': {
      const type = kind === 'customers' ? 'customer' : 'supplier'
      return (
        db
          .prepare(`SELECT * FROM parties WHERE type IN (?, 'both') AND (firm_id IS NULL OR firm_id = ?) ORDER BY name COLLATE NOCASE, id`)
          .all(type, firm) as Array<Record<string, unknown>>
      ).map((p) => {
        // Stored: positive = receivable. Customers file: positive = they owe us. Suppliers file: positive = we owe them.
        const bal = Number(p.opening_balance) || 0
        return {
          name: p.name as string,
          contactPerson: p.contact_person as string | null,
          phone: p.phone as string | null,
          phone2: p.phone2 as string | null,
          email: p.email as string | null,
          address: p.address as string | null,
          city: p.city as string | null,
          cnic: p.cnic as string | null,
          ntn: p.ntn as string | null,
          openingBalance: bal === 0 ? null : r2(type === 'customer' ? bal : -bal),
          openingDate: p.opening_date as string | null,
          creditLimit: p.credit_limit as number,
          paymentTermsDays: p.payment_terms_days as number,
          notes: p.notes as string | null
        }
      })
    }
    case 'sales':
    case 'purchases': {
      const docType = kind === 'sales' ? 'sale_invoice' : 'purchase_invoice'
      const range = dateRange(opts, 'd.date')
      const docs = db
        .prepare(
          `SELECT d.*, pt.name AS pname, pt.phone AS pphone,
                  (SELECT COALESCE(SUM(a.amount), 0) FROM payment_allocations a JOIN payments p ON p.id = a.payment_id WHERE a.document_id = d.id AND ${BILLING_PAYMENT}) AS paid,
                  (SELECT ac.name FROM payment_allocations a JOIN payments p ON p.id = a.payment_id JOIN accounts ac ON ac.id = p.account_id
                    WHERE a.document_id = d.id AND ${BILLING_PAYMENT} ORDER BY p.id LIMIT 1) AS account
             FROM documents d LEFT JOIN parties pt ON pt.id = d.party_id
            WHERE d.firm_id = ? AND d.doc_type = ? AND d.status <> 'cancelled'${range.sql}
            ORDER BY d.date, d.id`
        )
        .all(firm, docType, ...range.args) as Array<Record<string, unknown>>
      const lineStmt = db.prepare(
        `SELECT l.*, pr.sku AS psku, pr.name AS pname FROM document_lines l LEFT JOIN products pr ON pr.id = l.product_id WHERE l.document_id = ? ORDER BY l.line_no, l.id`
      )
      const out: Row[] = []
      for (const d of docs) {
        const head: Row = {
          number: d.number as string,
          date: d.date as string,
          party: d.party_id ? (d.pname as string) : null,
          partyPhone: d.party_id ? (d.pphone as string | null) : null,
          walkInName: !d.party_id && d.party_name !== 'Walk-in Customer' ? (d.party_name as string | null) : null,
          dueDate: d.due_date as string | null,
          partyRef: d.party_ref as string | null,
          notes: d.notes as string | null,
          docDiscount: (d.doc_discount as number) || null,
          otherCharges: (d.other_charges as number) || null,
          roundOff: (d.round_off as number) || null,
          paidAmount: Number(d.paid) ? r2(Number(d.paid)) : null,
          account: Number(d.paid) ? (d.account as string | null) : null
        }
        if (kind === 'purchases') delete head.walkInName
        for (const l of lineStmt.all(d.id) as Array<Record<string, unknown>>) {
          out.push({
            ...head,
            itemSku: l.product_id ? (l.psku as string | null) : null,
            // Without a SKU the importer links a line to its product by name, so use the product name then.
            itemName: l.product_id && !l.psku ? (l.pname as string) : (l.description as string) || (l.pname as string),
            itemDetails: l.details as string | null,
            unit: l.unit as string | null,
            qty: l.qty as number,
            rate: l.rate as number,
            discountPct: (l.discount_pct as number) || null,
            discountAmt: (l.discount_amt as number) || null,
            taxRate: (l.tax_rate as number) || null,
            serials: l.serials as string | null
          })
        }
      }
      return out
    }
    case 'payments': {
      const range = dateRange(opts, 'p.date')
      const pays = db
        .prepare(
          `SELECT p.*, pt.name AS pname, pt.phone AS pphone, ac.name AS account FROM payments p
             LEFT JOIN parties pt ON pt.id = p.party_id LEFT JOIN accounts ac ON ac.id = p.account_id
            WHERE p.firm_id = ? AND p.status <> 'cancelled'${range.sql}
              AND NOT EXISTS (SELECT 1 FROM payment_allocations a JOIN documents d ON d.id = a.document_id
                               WHERE a.payment_id = p.id AND d.doc_type IN ('sale_invoice','purchase_invoice') AND d.status <> 'cancelled' AND ${BILLING_PAYMENT})
            ORDER BY p.date, p.id`
        )
        .all(firm, ...range.args) as Array<Record<string, unknown>>
      const allocStmt = db.prepare(
        `SELECT COALESCE(d.number, e.number) AS number, a.amount FROM payment_allocations a
           LEFT JOIN documents d ON d.id = a.document_id LEFT JOIN expenses e ON e.id = a.expense_id WHERE a.payment_id = ? ORDER BY a.id`
      )
      return pays.map((p) => {
        const al = allocStmt.all(p.id) as Array<{ number: string; amount: number }>
        return {
          number: p.number as string,
          date: p.date as string,
          direction: p.direction as string,
          party: p.pname as string | null,
          partyPhone: p.party_id ? (p.pphone as string | null) : null,
          account: p.account as string,
          amount: p.amount as number,
          method: p.method as string,
          reference: p.reference as string | null,
          notes: p.notes as string | null,
          against: al.length ? al.map((x) => `${x.number}:${r2(x.amount)}`).join('; ') : null
        }
      })
    }
    case 'expenses': {
      const range = dateRange(opts, 'e.date')
      return (
        db
          .prepare(
            `SELECT e.*, c.name AS category, ac.name AS account, pt.name AS pname, pt.phone AS pphone FROM expenses e
               JOIN expense_categories c ON c.id = e.category_id LEFT JOIN accounts ac ON ac.id = e.account_id LEFT JOIN parties pt ON pt.id = e.party_id
              WHERE e.firm_id = ? AND e.status <> 'cancelled'${range.sql} ORDER BY e.date, e.id`
          )
          .all(firm, ...range.args) as Array<Record<string, unknown>>
      ).map((e) => ({
        number: e.number as string,
        date: e.date as string,
        category: e.category as string,
        amount: e.amount as number,
        paid: !!e.paid,
        account: e.paid ? (e.account as string | null) : null,
        party: e.pname as string | null,
        partyPhone: e.party_id ? (e.pphone as string | null) : null,
        payee: e.payee_name as string | null,
        method: e.method as string | null,
        reference: e.reference as string | null,
        notes: e.notes as string | null
      }))
    }
    case 'stock':
      return (
        db
          .prepare(
            `SELECT p.sku, p.name, w.name AS warehouse, s.qty, p.avg_cost FROM stock_levels s
               JOIN products p ON p.id = s.product_id JOIN warehouses w ON w.id = s.warehouse_id
              WHERE p.type = 'goods' AND (p.firm_id IS NULL OR p.firm_id = ?) AND (w.firm_id IS NULL OR w.firm_id = ?) AND ABS(s.qty) > 0.0005
              ORDER BY p.name COLLATE NOCASE, w.name`
          )
          .all(firm, firm) as Array<Record<string, unknown>>
      ).map((s) => ({ sku: s.sku as string | null, name: s.name as string, warehouse: s.warehouse as string, qty: r3(Number(s.qty)), unitCost: r2(Number(s.avg_cost)) }))
  }
}

/** Builds the CSV text for one kind (columns = the importer's field labels, in the same order). */
export function exportCsv(ctx: Ctx, kindIn: unknown, opts: CsvExportOptions = {}): CsvExportResult {
  // Exporting the books is a data export: same right as making / exporting a backup.
  requirePerm(ctx, 'backup.manage')
  const kind = assertKind(kindIn)
  const fields = importFields(kind)
  const rows = rowsFor(ctx, kind, opts ?? {})
  return { kind, rows: rows.length, text: toCsv(fields.map((f) => f.label), rows.map((r) => fields.map((f) => r[f.key]))) }
}
