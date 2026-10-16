/**
 * CSV import pipeline (owner: data area).
 * Kinds: products, categories, customers, suppliers, sales / purchase invoices (flat line-level CSV keyed by invoice no),
 * payments, expenses, stock levels.
 *
 * parse -> header auto-mapping (user can override) -> per-row validation (types, required fields, in-file duplicates,
 * duplicates already in the books, unknown references; nothing written) -> optional dry run (every record goes through
 * the normal services inside a transaction that is then rolled back) -> commit in ONE transaction -> import_runs row.
 *
 * Every write goes through the existing service functions (saveProduct, saveParty, createDocument, createPayment,
 * createExpense, createAdjustment ...) so permissions, period locks, stock movements, average cost and party balances
 * stay consistent. Existing invoices / payments / expenses are never changed by an import (duplicates are skipped).
 */
import { AppError, Ctx, audit, isValidDate, requirePerm } from './context'
import { saveCategory, saveProduct, defaultWarehouseId, createAdjustment, warehouseQty, type ProductInput } from './inventory'
import { saveParty, type PartyInput } from './parties'
import { createDocument, type DocLineInput } from './documents'
import { createPayment, defaultAccountId } from './payments'
import { createExpense, saveExpenseCategory } from './expenses'
import { computeTotals } from '../../shared/totals'

export const IMPORT_KINDS = ['products', 'categories', 'customers', 'suppliers', 'sales', 'purchases', 'payments', 'expenses', 'stock'] as const
export type ImportKind = (typeof IMPORT_KINDS)[number]
export type DupPolicy = 'skip' | 'update'
export type DateFormat = 'ymd' | 'dmy'

export interface ImportField {
  key: string
  label: string
  required?: boolean
  type: 'text' | 'number' | 'date' | 'bool'
  aliases: string[]
}

const f = (key: string, label: string, type: ImportField['type'], aliases: string[], required = false): ImportField => ({ key, label, type, aliases, required })

const PARTY_ALIASES = ['party', 'party name', 'customer', 'customer name', 'supplier', 'supplier name', 'vendor', 'client']

const FIELDS: Record<ImportKind, ImportField[]> = {
  products: [
    f('name', 'Name', 'text', ['name', 'product', 'product name', 'item', 'item name', 'description1', 'title'], true),
    f('sku', 'SKU / code', 'text', ['sku', 'code', 'item code', 'product code', 'sku code']),
    f('barcode', 'Barcode', 'text', ['barcode', 'bar code', 'ean']),
    f('type', 'Type', 'text', ['type', 'product type', 'item type']),
    f('category', 'Category', 'text', ['category', 'group', 'item group', 'category name']),
    f('unit', 'Unit', 'text', ['unit', 'uom', 'units']),
    f('brand', 'Brand', 'text', ['brand', 'make', 'manufacturer']),
    f('model', 'Model', 'text', ['model', 'model no', 'model number']),
    f('description', 'Description', 'text', ['description', 'details', 'specification', 'specs']),
    f('purchasePrice', 'Purchase price', 'number', ['purchase price', 'cost', 'cost price', 'buy price', 'purchase rate']),
    f('salePrice', 'Sale price', 'number', ['sale price', 'price', 'selling price', 'rate', 'sale rate', 'retail price']),
    f('minSalePrice', 'Min sale price', 'number', ['min sale price', 'minimum sale price', 'min price']),
    f('taxRate', 'Tax rate %', 'number', ['tax rate', 'tax', 'gst', 'gst rate', 'tax rate %']),
    f('reorderLevel', 'Reorder level', 'number', ['reorder level', 'reorder', 'min stock', 'minimum stock']),
    f('warrantyMonths', 'Warranty months', 'number', ['warranty months', 'warranty']),
    f('openingQty', 'Opening qty', 'number', ['opening qty', 'opening quantity', 'qty', 'quantity', 'stock', 'opening stock']),
    f('openingCost', 'Opening unit cost', 'number', ['opening cost', 'opening unit cost', 'unit cost', 'opening rate'])
  ],
  categories: [f('name', 'Name', 'text', ['name', 'category', 'category name', 'group'], true), f('kind', 'Kind', 'text', ['kind', 'type'])],
  customers: [],
  suppliers: [],
  sales: [],
  purchases: [],
  payments: [
    f('number', 'Number', 'text', ['number', 'no', 'receipt no', 'payment no', 'voucher no', 'voucher']),
    f('date', 'Date', 'date', ['date', 'payment date', 'receipt date'], true),
    f('direction', 'Direction', 'text', ['direction', 'type', 'in out'], true),
    f('party', 'Party', 'text', PARTY_ALIASES),
    f('partyPhone', 'Party phone', 'text', ['party phone', 'phone', 'mobile', 'customer phone', 'supplier phone']),
    f('account', 'Account', 'text', ['account', 'account name', 'cash bank', 'bank']),
    f('amount', 'Amount', 'number', ['amount', 'paid', 'received', 'total'], true),
    f('method', 'Method', 'text', ['method', 'payment method', 'mode']),
    f('reference', 'Reference', 'text', ['reference', 'ref', 'cheque no', 'transaction id']),
    f('notes', 'Notes', 'text', ['notes', 'note', 'remarks', 'narration']),
    f('against', 'Against', 'text', ['against', 'allocations', 'invoices', 'settles', 'against invoice'])
  ],
  expenses: [
    f('number', 'Number', 'text', ['number', 'no', 'expense no', 'voucher no']),
    f('date', 'Date', 'date', ['date', 'expense date'], true),
    f('category', 'Category', 'text', ['category', 'expense category', 'head', 'expense head'], true),
    f('amount', 'Amount', 'number', ['amount', 'total'], true),
    f('paid', 'Paid', 'bool', ['paid', 'is paid', 'status']),
    f('account', 'Account', 'text', ['account', 'account name', 'paid from']),
    f('party', 'Supplier', 'text', ['supplier', 'supplier name', 'contractor', 'party', 'vendor']),
    f('partyPhone', 'Supplier phone', 'text', ['supplier phone', 'party phone', 'phone']),
    f('payee', 'Payee', 'text', ['payee', 'paid to', 'payee name']),
    f('method', 'Method', 'text', ['method', 'payment method', 'mode']),
    f('reference', 'Reference', 'text', ['reference', 'ref']),
    f('notes', 'Notes', 'text', ['notes', 'note', 'remarks', 'narration', 'description'])
  ],
  stock: [
    f('sku', 'SKU / code', 'text', ['sku', 'code', 'item code', 'product code']),
    f('name', 'Product', 'text', ['product', 'name', 'product name', 'item', 'item name']),
    f('warehouse', 'Warehouse', 'text', ['warehouse', 'store', 'godown', 'location']),
    f('qty', 'Qty', 'number', ['qty', 'quantity', 'stock', 'counted qty', 'on hand'], true),
    f('unitCost', 'Unit cost', 'number', ['unit cost', 'cost', 'avg cost', 'average cost'])
  ]
}
for (const k of ['customers', 'suppliers'] as const) {
  FIELDS[k] = [
    f('name', 'Name', 'text', ['name', 'customer', 'customer name', 'supplier', 'supplier name', 'party', 'party name', 'vendor'], true),
    f('contactPerson', 'Contact person', 'text', ['contact person', 'contact name']),
    f('phone', 'Phone', 'text', ['phone', 'mobile', 'cell', 'contact', 'phone no', 'mobile no', 'contact no']),
    f('phone2', 'Phone 2', 'text', ['phone 2', 'phone2', 'other phone', 'landline']),
    f('email', 'Email', 'text', ['email', 'e mail', 'email address']),
    f('address', 'Address', 'text', ['address', 'street', 'location']),
    f('city', 'City', 'text', ['city', 'town']),
    f('cnic', 'CNIC', 'text', ['cnic', 'nic', 'id card']),
    f('ntn', 'NTN', 'text', ['ntn', 'tax no']),
    f('openingBalance', 'Opening balance', 'number', ['opening balance', 'opening', 'balance', 'opening bal', 'previous balance']),
    f('openingDate', 'Opening date', 'date', ['opening date', 'balance date']),
    f('creditLimit', 'Credit limit', 'number', ['credit limit', 'limit']),
    f('paymentTermsDays', 'Payment terms (days)', 'number', ['payment terms days', 'payment terms', 'terms days', 'credit days']),
    f('notes', 'Notes', 'text', ['notes', 'note', 'remarks'])
  ]
}
for (const k of ['sales', 'purchases'] as const) {
  const partyLabel = k === 'sales' ? 'Customer' : 'Supplier'
  FIELDS[k] = [
    f('number', 'Invoice no', 'text', ['invoice no', 'invoice number', 'invoice', 'bill no', 'bill number', 'number', 'doc no', 'document no'], true),
    f('date', 'Date', 'date', ['date', 'invoice date', 'bill date'], true),
    f('party', partyLabel, 'text', PARTY_ALIASES),
    f('partyPhone', `${partyLabel} phone`, 'text', ['customer phone', 'supplier phone', 'party phone', 'phone', 'mobile']),
    ...(k === 'sales' ? [f('walkInName', 'Walk-in name', 'text', ['walk in name', 'walkin name', 'cash customer'])] : []),
    f('dueDate', 'Due date', 'date', ['due date', 'due']),
    f('partyRef', 'Reference', 'text', ['reference', 'ref', 'party ref', 'po no', 'supplier invoice no']),
    f('notes', 'Notes', 'text', ['notes', 'note', 'remarks']),
    f('docDiscount', 'Invoice discount', 'number', ['invoice discount', 'doc discount', 'bill discount', 'overall discount']),
    f('otherCharges', 'Other charges', 'number', ['other charges', 'charges', 'freight', 'delivery charges']),
    f('roundOff', 'Round off', 'number', ['round off', 'rounding']),
    f('paidAmount', 'Paid amount', 'number', ['paid amount', 'amount paid', 'paid', 'received amount']),
    f('account', 'Paid into account', 'text', ['paid into account', 'account', 'account name', 'paid from account']),
    f('itemSku', 'Item SKU', 'text', ['item sku', 'sku', 'item code', 'product code', 'code']),
    f('itemName', 'Item name', 'text', ['item name', 'item', 'product', 'product name', 'description'], true),
    f('itemDetails', 'Item details', 'text', ['item details', 'details', 'item description']),
    f('unit', 'Unit', 'text', ['unit', 'uom']),
    f('qty', 'Qty', 'number', ['qty', 'quantity'], true),
    f('rate', 'Rate', 'number', ['rate', 'price', 'unit price'], true),
    f('discountPct', 'Discount %', 'number', ['discount %', 'discount pct', 'disc %', 'discount percent']),
    f('discountAmt', 'Discount amount', 'number', ['discount amount', 'discount', 'disc']),
    f('taxRate', 'Tax %', 'number', ['tax %', 'tax rate', 'gst %', 'tax']),
    f('serials', 'Serials', 'text', ['serials', 'serial no', 'serial numbers', 'serial'])
  ]
}

const KIND_LABELS: Record<ImportKind, string> = {
  products: 'products',
  categories: 'categories',
  customers: 'customers',
  suppliers: 'suppliers',
  sales: 'sales invoices',
  purchases: 'purchase invoices',
  payments: 'payments',
  expenses: 'expenses',
  stock: 'stock levels'
}

export function importFields(kind: ImportKind): ImportField[] {
  return FIELDS[assertKind(kind)]
}

export function assertKind(kind: unknown): ImportKind {
  if ((IMPORT_KINDS as readonly unknown[]).includes(kind)) return kind as ImportKind
  throw new AppError('Choose what to import.', 'VALIDATION')
}

/* ------------------------------------------------------------------ parsing ------------------------------------------------------------------ */

/** RFC-4180 CSV parser (quotes, escaped quotes, newlines inside quotes, CRLF, BOM). Also accepts ; or tab separated files. */
export function parseCsv(text: string): string[][] {
  const src = String(text ?? '').replace(/^﻿/, '')
  const firstLine = src.split(/\r?\n/, 1)[0] ?? ''
  const count = (ch: string): number => firstLine.split(ch).length - 1
  const sep = count('\t') > count(',') && count('\t') >= count(';') ? '\t' : count(';') > count(',') ? ';' : ','
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let q = false
  let quoted = false
  for (let i = 0; i < src.length; i++) {
    const c = src[i]
    if (q) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          cell += '"'
          i++
        } else q = false
      } else cell += c
    } else if (c === '"' && cell === '' && !quoted) {
      q = true
      quoted = true
    } else if (c === sep) {
      row.push(cell)
      cell = ''
      quoted = false
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++
      row.push(cell)
      rows.push(row)
      row = []
      cell = ''
      quoted = false
    } else cell += c
  }
  if (cell !== '' || row.length) {
    row.push(cell)
    rows.push(row)
  }
  return rows.filter((r) => r.some((v) => v.trim() !== ''))
}

const norm = (s: string): string =>
  String(s ?? '')
    .toLowerCase()
    .replace(/[_\-./]+/g, ' ')
    .replace(/[^a-z0-9% ]/g, '')
    .replace(/\s+/g, ' ')
    .trim()

/** field key -> column index (or null) */
export type Mapping = Record<string, number | null>

export function autoMap(headers: string[], kind: ImportKind): Mapping {
  const fields = importFields(kind)
  const h = headers.map(norm)
  const used = new Set<number>()
  const map: Mapping = {}
  // Pass 1: exact matches on the label (what our own export writes), key or an alias — for every field first,
  // so a loose match for one field never steals the exact column of another.
  // Pass 0: the exact label wins (our own export), so an alias of an earlier field never takes a later field's column.
  for (const fl of fields) {
    const idx = h.findIndex((x, i) => !used.has(i) && x === norm(fl.label))
    map[fl.key] = idx >= 0 ? idx : null
    if (idx >= 0) used.add(idx)
  }
  for (const fl of fields) {
    if (map[fl.key] !== null) continue
    const idx = h.findIndex((x, i) => !used.has(i) && (x === norm(fl.key) || fl.aliases.includes(x)))
    map[fl.key] = idx >= 0 ? idx : null
    if (idx >= 0) used.add(idx)
  }
  // Pass 2: contains-match for the fields still unmapped.
  for (const fl of fields) {
    if (map[fl.key] !== null) continue
    const idx = h.findIndex((x, i) => !used.has(i) && fl.aliases.some((a) => a.length > 3 && x.includes(a)))
    map[fl.key] = idx >= 0 ? idx : null
    if (idx >= 0) used.add(idx)
  }
  return map
}

/**
 * Number cell: '.' is the decimal mark. Thousands separators (1,234,567.5), an Rs / PKR prefix and accounting
 * negatives (1,000) are accepted. Empty -> null. Anything else (e.g. "1,5") is rejected instead of being misread.
 */
export function parseNumber(v: unknown): number | null | undefined {
  let s = String(v ?? '').trim().replace(/^(rs\.?|pkr)\s*/i, '').trim()
  if (s === '') return null
  const neg = /^\(.*\)$/.test(s)
  if (neg) s = s.slice(1, -1).trim()
  if (s.includes(',')) {
    if (!/^[-+]?\d{1,3}(,\d{3})+(\.\d+)?$/.test(s)) return undefined
    s = s.replace(/,/g, '')
  }
  if (!/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(s)) return undefined
  const n = Number(s)
  if (!Number.isFinite(n)) return undefined
  return neg ? -n : n
}

/** Date cell -> ISO yyyy-mm-dd. The user picks the format explicitly (dd/mm/yyyy vs yyyy-mm-dd); an ISO date is always accepted. */
export function parseDate(v: unknown, fmt: DateFormat): string | null | undefined {
  const s = String(v ?? '').trim().replace(/[ T]\d{1,2}:\d{2}(:\d{2})?(\.\d+)?\s*(am|pm)?$/i, '')
  if (s === '') return null
  let y: number, m: number, d: number
  const ymd = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(s)
  const dmy = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/.exec(s)
  if (ymd) [y, m, d] = [Number(ymd[1]), Number(ymd[2]), Number(ymd[3])]
  else if (dmy && fmt === 'dmy') [d, m, y] = [Number(dmy[1]), Number(dmy[2]), Number(dmy[3])]
  else return undefined
  const iso = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
  const dt = new Date(Date.UTC(y, m - 1, d))
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d || !isValidDate(iso)) return undefined
  return iso
}

export function parseBool(v: unknown): boolean | null | undefined {
  const s = String(v ?? '').trim().toLowerCase()
  if (s === '') return null
  if (['yes', 'y', 'true', '1', 'paid', 'ha', 'haan'].includes(s)) return true
  if (['no', 'n', 'false', '0', 'unpaid', 'credit', 'nahi'].includes(s)) return false
  return undefined
}

/** Undo the spreadsheet formula guard our export adds ('=..., '+..., '-..., '@...). */
const unguard = (s: string): string => (/^'[=+\-@\t\r]/.test(s) ? s.slice(1) : s)

/* ------------------------------------------------------------------ model ------------------------------------------------------------------ */

export interface RowError {
  row: number
  field?: string
  message: string
}

export interface Reconciliation {
  rows: number
  valid: number
  openingQty: number
  openingValue: number
  openingBalance: number
  amount: number
}

export interface ImportCounts {
  rows: number
  records: number
  create: number
  update: number
  skip: number
  invalid: number
}

export interface ExecResult {
  imported: number
  updated: number
  skipped: number
  failed: number
  failures: RowError[]
  skippedReasons: RowError[]
  reconciliation: { file: Reconciliation; imported: Totals; matched: boolean }
}

export interface Analysis {
  kind: ImportKind
  headers: string[]
  fields: ImportField[]
  mapping: Mapping
  dateFormat: DateFormat
  duplicates: DupPolicy
  preview: Array<Record<string, unknown>>
  errors: RowError[]
  warnings: RowError[]
  counts: ImportCounts
  reconciliation: Reconciliation
  dryRun?: ExecResult
}

export interface ImportOptions {
  kind: ImportKind
  text: string
  mapping?: Mapping
  dateFormat?: DateFormat
  duplicates?: DupPolicy
  /** Import the valid records and report the invalid / failing ones instead of refusing the whole file. */
  skipInvalid?: boolean
  dryRun?: boolean
  fileName?: string
}

type Values = Record<string, string | number | boolean | null>

interface Rec {
  row: number
  rows: number[]
  label: string
  action: 'create' | 'update' | 'skip'
  reason?: string
  existingId?: number
  data: Values
  lines?: Values[]
}

interface Totals {
  rows: number
  openingQty: number
  openingValue: number
  openingBalance: number
  amount: number
}

interface Prepared {
  analysis: Analysis
  records: Rec[]
  invalidRows: Set<number>
}

const r2 = (n: number): number => Math.round(n * 100) / 100
const r3 = (n: number): number => Math.round(n * 1000) / 1000
const n0 = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
const s0 = (v: unknown): string => (v === null || v === undefined ? '' : String(v))
const orUndef = (v: unknown): string | undefined => (v === null || v === undefined || v === '' ? undefined : String(v))
const lc = (s: unknown): string => s0(s).trim().toLowerCase()

/* ---------------------------------------------------------- reference lookups (firm-scoped) ---------------------------------------------------------- */

type PartyType = 'customer' | 'supplier'

function findParties(ctx: Ctx, type: PartyType, name: string, phone: string): Array<{ id: number }> {
  const rows = ctx.db
    .prepare(
      `SELECT id, phone FROM parties WHERE name = ? COLLATE NOCASE AND type IN (?, 'both') AND (firm_id IS NULL OR firm_id = ?) ORDER BY id`
    )
    .all(name, type, ctx.firmId) as Array<{ id: number; phone: string | null }>
  if (!phone) return rows
  return rows.filter((r) => (r.phone ?? '').replace(/\s+/g, '') === phone.replace(/\s+/g, ''))
}

/** Resolve a party reference (name + optional phone). Returns an id or an error message. */
function resolveParty(ctx: Ctx, type: PartyType, name: string, phone: string): { id?: number; error?: string } {
  const label = type === 'customer' ? 'Customer' : 'Supplier'
  const found = findParties(ctx, type, name, phone)
  if (found.length === 1) return { id: found[0].id }
  if (found.length > 1) return { error: `${label} "${name}" matches ${found.length} records — add the phone number column to tell them apart.` }
  return { error: `${label} "${name}"${phone ? ` (${phone})` : ''} was not found — import ${type}s first.` }
}

function resolveAccount(ctx: Ctx, name: string): { id?: number; error?: string } {
  if (!name) {
    const id = defaultAccountId(ctx)
    return id ? { id } : { error: 'No cash / bank account exists in this firm.' }
  }
  const a = ctx.db.prepare('SELECT id FROM accounts WHERE name = ? COLLATE NOCASE AND firm_id = ? ORDER BY is_active DESC, id LIMIT 1').get(name, ctx.firmId) as
    | { id: number }
    | undefined
  return a ? { id: a.id } : { error: `Account "${name}" was not found in this firm.` }
}

function findProduct(ctx: Ctx, sku: string, name: string): { id?: number; error?: string } {
  if (sku) {
    const p = ctx.db.prepare('SELECT id FROM products WHERE sku = ? COLLATE NOCASE AND (firm_id IS NULL OR firm_id = ?)').get(sku, ctx.firmId) as { id: number } | undefined
    return p ? { id: p.id } : { error: `Product with SKU "${sku}" was not found.` }
  }
  if (!name) return {}
  const rows = ctx.db.prepare('SELECT id FROM products WHERE name = ? COLLATE NOCASE AND (firm_id IS NULL OR firm_id = ?)').all(name, ctx.firmId) as Array<{ id: number }>
  if (rows.length > 1) return { error: `Product name "${name}" matches ${rows.length} products — add the SKU column.` }
  return rows.length ? { id: rows[0].id } : {}
}

function findWarehouse(ctx: Ctx, name: string): { id?: number; error?: string } {
  if (!name) return { id: defaultWarehouseId(ctx) }
  const w = ctx.db.prepare('SELECT id FROM warehouses WHERE name = ? COLLATE NOCASE AND (firm_id IS NULL OR firm_id = ?) LIMIT 1').get(name, ctx.firmId) as
    | { id: number }
    | undefined
  return w ? { id: w.id } : { error: `Warehouse "${name}" was not found.` }
}

const DOC_TYPE: Record<'sales' | 'purchases', 'sale_invoice' | 'purchase_invoice'> = { sales: 'sale_invoice', purchases: 'purchase_invoice' }

/** "INV-0001:500; INV-0002:250" (or a single number = the whole amount) -> allocations. */
function parseAgainst(s: string, amount: number): { items: Array<{ number: string; amount: number }>; error?: string } {
  const items: Array<{ number: string; amount: number }> = []
  const parts = s.split(/[;|\n]+/).map((x) => x.trim()).filter(Boolean)
  for (const p of parts) {
    const m = /^(.+?)\s*[:=]\s*(.+)$/.exec(p)
    if (!m) {
      if (parts.length > 1) return { items, error: `"${p}": write the amount for each document (e.g. INV-0001:500; INV-0002:250).` }
      items.push({ number: p, amount })
      continue
    }
    const amt = parseNumber(m[2])
    if (amt === undefined || amt === null || amt <= 0) return { items, error: `"${p}": amount is not a valid number.` }
    items.push({ number: m[1].trim(), amount: amt })
  }
  return { items }
}

function resolveAllocation(ctx: Ctx, number: string): { documentId?: number; expenseId?: number } | null {
  const d = ctx.db
    .prepare(
      `SELECT id FROM documents WHERE firm_id = ? AND number = ? COLLATE NOCASE AND status <> 'cancelled'
         AND doc_type IN ('sale_invoice','sale_return','purchase_invoice','purchase_return') ORDER BY id LIMIT 1`
    )
    .get(ctx.firmId, number) as { id: number } | undefined
  if (d) return { documentId: d.id }
  const e = ctx.db.prepare(`SELECT id FROM expenses WHERE firm_id = ? AND number = ? COLLATE NOCASE AND status <> 'cancelled'`).get(ctx.firmId, number) as
    | { id: number }
    | undefined
  return e ? { expenseId: e.id } : null
}

const dirOf = (v: string): 'in' | 'out' | null => {
  const s = lc(v)
  if (['in', 'received', 'receipt', 'receive', 'r', 'incoming', 'credit'].includes(s)) return 'in'
  if (['out', 'paid', 'payment', 'pay', 'p', 'outgoing', 'debit'].includes(s)) return 'out'
  return null
}

const METHOD_ALIASES: Record<string, string> = {
  cash: 'cash',
  'bank transfer': 'bank_transfer',
  bank_transfer: 'bank_transfer',
  bank: 'bank_transfer',
  transfer: 'bank_transfer',
  cheque: 'cheque',
  check: 'cheque',
  online: 'online',
  card: 'card',
  other: 'other'
}

/* ------------------------------------------------------------------ prepare ------------------------------------------------------------------ */

function prepare(ctx: Ctx, opts: ImportOptions): Prepared {
  const kind = assertKind(opts.kind)
  const dateFormat: DateFormat = opts.dateFormat === 'dmy' ? 'dmy' : 'ymd'
  const duplicates: DupPolicy = opts.duplicates === 'update' ? 'update' : 'skip'
  const all = parseCsv(opts.text)
  if (all.length < 2) throw new AppError('The file has no data rows (the first row must be the column headers).', 'VALIDATION')
  if (all.length > 20001) throw new AppError('The file has more than 20,000 rows. Split it into smaller files.', 'VALIDATION')
  const headers = all[0].map((h) => h.trim())
  const fields = importFields(kind)
  const mapping: Mapping = {}
  const auto = autoMap(headers, kind)
  for (const fl of fields) {
    const m = opts.mapping && fl.key in opts.mapping ? opts.mapping[fl.key] : auto[fl.key]
    mapping[fl.key] = m === null || m === undefined || (m as unknown) === '' || !Number.isInteger(Number(m)) || Number(m) < 0 || Number(m) >= headers.length ? null : Number(m)
  }
  const errors: RowError[] = []
  const warnings: RowError[] = []
  for (const fl of fields) if (fl.required && mapping[fl.key] === null) errors.push({ row: 0, field: fl.key, message: `Map a column to "${fl.label}".` })
  if (kind === 'stock' && mapping.sku === null && mapping.name === null) errors.push({ row: 0, field: 'sku', message: 'Map a column to "SKU / code" or "Product".' })
  const invalidRows = new Set<number>()
  const fail = (row: number, message: string, field?: string): void => {
    errors.push({ row, field, message })
    invalidRows.add(row)
  }
  const warn = (row: number, message: string, field?: string): void => {
    if (warnings.length < 200) warnings.push({ row, field, message })
  }

  // 1. cell parsing + types
  const parsed: Array<{ row: number; v: Values }> = []
  if (!errors.length) {
    for (let i = 1; i < all.length; i++) {
      const line = all[i]
      const row = i + 1 // spreadsheet row number (header = row 1)
      const v: Values = {}
      for (const fl of fields) {
        const idx = mapping[fl.key]
        const raw = idx === null ? '' : unguard(String(line[idx] ?? '').trim())
        if (fl.type === 'number') {
          const n = parseNumber(raw)
          if (n === undefined) fail(row, `${fl.label} "${raw}" is not a number (use . for decimals).`, fl.key)
          v[fl.key] = n ?? null
        } else if (fl.type === 'date') {
          const d = parseDate(raw, dateFormat)
          if (d === undefined) fail(row, `${fl.label} "${raw}" is not a valid date (${dateFormat === 'dmy' ? 'dd/mm/yyyy' : 'yyyy-mm-dd'}).`, fl.key)
          v[fl.key] = d ?? null
        } else if (fl.type === 'bool') {
          const b = parseBool(raw)
          if (b === undefined) fail(row, `${fl.label} "${raw}" must be Yes or No.`, fl.key)
          v[fl.key] = b ?? null
        } else v[fl.key] = raw === '' ? null : raw
        if (fl.required && (v[fl.key] === null || v[fl.key] === '') && !invalidRows.has(row)) fail(row, `${fl.label} is empty.`, fl.key)
      }
      parsed.push({ row, v })
    }
  }

  // 2. kind-specific checks -> records
  const records: Rec[] = []
  const seen = new Map<string, number>()
  const dupInFile = (key: string, row: number, label: string): boolean => {
    const k = key.toLowerCase()
    if (seen.has(k)) {
      fail(row, `${label} repeats row ${seen.get(k)}.`)
      return true
    }
    seen.set(k, row)
    return false
  }
  const db = ctx.db
  const ok = (row: number): boolean => !invalidRows.has(row)
  const nonNeg = (row: number, v: Values, keys: string[]): void => {
    for (const k of keys) if (n0(v[k]) < 0) fail(row, `${fields.find((x) => x.key === k)!.label} cannot be negative.`, k)
  }

  if (kind === 'sales' || kind === 'purchases') {
    const docType = DOC_TYPE[kind]
    const partyType: PartyType = kind === 'sales' ? 'customer' : 'supplier'
    const groups = new Map<string, { first: number; rows: Array<{ row: number; v: Values }> }>()
    for (const p of parsed) {
      const key = lc(p.v.number)
      if (!key) continue
      if (!groups.has(key)) groups.set(key, { first: p.row, rows: [] })
      groups.get(key)!.rows.push(p)
    }
    const HEADER_KEYS = ['date', 'party', 'partyPhone', 'walkInName', 'dueDate', 'partyRef', 'notes', 'docDiscount', 'otherCharges', 'roundOff', 'paidAmount', 'account']
    for (const [, g] of groups) {
      const head: Values = { number: s0(g.rows[0].v.number) }
      for (const k of HEADER_KEYS) {
        for (const r of g.rows) {
          const val = r.v[k]
          if (val === null || val === undefined || val === '') continue
          if (head[k] === undefined || head[k] === null) head[k] = val
          else if (String(head[k]) !== String(val) && ['date', 'party', 'partyPhone'].includes(k)) {
            fail(r.row, `Invoice ${head.number}: ${fields.find((x) => x.key === k)!.label} differs from row ${g.first}.`, k)
          }
        }
        if (head[k] === undefined) head[k] = null
      }
      const rec: Rec = { row: g.first, rows: g.rows.map((r) => r.row), label: `Invoice ${head.number}`, action: 'create', data: head, lines: [] }
      const exists = db.prepare('SELECT id FROM documents WHERE firm_id = ? AND doc_type = ? AND number = ? COLLATE NOCASE').get(ctx.firmId, docType, head.number) as
        | { id: number }
        | undefined
      if (exists) {
        rec.action = 'skip'
        rec.existingId = exists.id
        rec.reason = `Invoice ${head.number} already exists${duplicates === 'update' ? ' — existing invoices are never changed by an import' : ''}.`
      }
      nonNeg(g.first, head, ['docDiscount', 'otherCharges', 'paidAmount'])
      if (rec.action !== 'skip') {
        if (head.party) {
          const r = resolveParty(ctx, partyType, s0(head.party), s0(head.partyPhone))
          if (r.error) fail(g.first, r.error, 'party')
          else head.partyId = r.id!
        } else if (kind === 'purchases') fail(g.first, 'Supplier is empty.', 'party')
        else if (!(n0(head.paidAmount) > 0)) warn(g.first, `Invoice ${head.number} has no customer: a walk-in sale must be fully paid (Paid amount + account).`)
        if (n0(head.paidAmount) > 0) {
          const a = resolveAccount(ctx, s0(head.account))
          if (a.error) fail(g.first, a.error, 'account')
          else head.accountId = a.id!
        }
        for (const r of g.rows) {
          const v = r.v
          nonNeg(r.row, v, ['rate', 'discountPct', 'discountAmt', 'taxRate'])
          if (v.qty !== null && n0(v.qty) <= 0) fail(r.row, 'Qty must be greater than zero.', 'qty')
          const pr = findProduct(ctx, s0(v.itemSku), s0(v.itemName))
          if (pr.error) fail(r.row, pr.error, 'itemSku')
          else if (!pr.id && ok(r.row)) warn(r.row, `"${s0(v.itemName)}" is not a product in the list — imported as a text line (no stock effect).`)
          rec.lines!.push({ ...v, productId: pr.id ?? null })
        }
      }
      if (rec.rows.some((x) => invalidRows.has(x))) for (const x of rec.rows) invalidRows.add(x)
      records.push(rec)
    }
  } else {
    for (const { row, v } of parsed) {
      if (!ok(row)) continue
      const rec: Rec = { row, rows: [row], label: s0(v.name ?? v.number ?? `Row ${row}`), action: 'create', data: v }
      if (kind === 'products') {
        nonNeg(row, v, ['purchasePrice', 'salePrice', 'minSalePrice', 'taxRate', 'reorderLevel', 'warrantyMonths', 'openingQty', 'openingCost'])
        if (n0(v.taxRate) > 100) fail(row, 'Tax rate must be 0–100.', 'taxRate')
        const t = lc(v.type)
        if (t && !['goods', 'good', 'product', 'item', 'stock', 'service', 'services'].includes(t)) fail(row, `Type "${v.type}" must be goods or service.`, 'type')
        v.type = t.startsWith('service') ? 'service' : 'goods'
        const name = s0(v.name)
        if (name.length > 200) fail(row, 'Name is longer than 200 characters.', 'name')
        const sku = s0(v.sku)
        if (sku && dupInFile(`sku:${sku}`, row, `SKU "${sku}"`)) continue
        if (dupInFile(`name:${name}`, row, `Product "${name}"`)) continue
        let existing: { id: number } | undefined
        if (sku) existing = db.prepare('SELECT id FROM products WHERE sku = ? COLLATE NOCASE').get(sku) as { id: number } | undefined
        if (!existing) {
          const byName = db.prepare('SELECT id, sku FROM products WHERE name = ? COLLATE NOCASE AND (firm_id IS NULL OR firm_id = ?)').all(name, ctx.firmId) as Array<{ id: number; sku: string | null }>
          if (byName.length > 1) {
            fail(row, `Product "${name}" matches ${byName.length} products — add the SKU column.`, 'name')
            continue
          }
          existing = byName[0]
          if (existing && sku && byName[0].sku && lc(byName[0].sku) !== lc(sku)) {
            fail(row, `Product "${name}" already exists with a different SKU (${byName[0].sku}).`, 'sku')
            continue
          }
        }
        if (existing) {
          const visible = db.prepare('SELECT 1 FROM products WHERE id = ? AND (firm_id IS NULL OR firm_id = ?)').get(existing.id, ctx.firmId)
          if (!visible) {
            fail(row, `SKU "${sku}" is used by a product of another firm.`, 'sku')
            continue
          }
          rec.existingId = existing.id
          rec.action = duplicates === 'update' ? 'update' : 'skip'
          rec.reason = `Product "${name}" already exists.`
          if (rec.action === 'update' && n0(v.openingQty) > 0) warn(row, `"${name}" exists: opening qty is not changed for existing products — use the Stock levels import.`)
        }
        if (!v.openingCost && n0(v.openingQty) > 0) v.openingCost = n0(v.purchasePrice)
      } else if (kind === 'categories') {
        const name = s0(v.name)
        const k = lc(v.kind)
        if (k && !['goods', 'service'].includes(k)) fail(row, `Kind "${v.kind}" must be goods or service.`, 'kind')
        if (dupInFile(name, row, `Category "${name}"`)) continue
        const ex = db.prepare('SELECT id FROM categories WHERE name = ? COLLATE NOCASE AND (firm_id IS NULL OR firm_id = ?)').get(name, ctx.firmId) as { id: number } | undefined
        if (ex) {
          rec.existingId = ex.id
          rec.action = duplicates === 'update' ? 'update' : 'skip'
          rec.reason = `Category "${name}" already exists.`
        }
      } else if (kind === 'customers' || kind === 'suppliers') {
        const type: PartyType = kind === 'customers' ? 'customer' : 'supplier'
        const name = s0(v.name)
        if (name.length > 150) fail(row, 'Name is longer than 150 characters.', 'name')
        nonNeg(row, v, ['creditLimit', 'paymentTermsDays'])
        const phone = s0(v.phone)
        if (dupInFile(`${name}|${phone}`, row, `"${name}"${phone ? ` (${phone})` : ''}`)) continue
        const ex = findParties(ctx, type, name, phone)
        if (ex.length > 1) {
          fail(row, `"${name}" matches ${ex.length} existing records — add the phone number to tell them apart.`, 'name')
          continue
        }
        if (ex.length === 1) {
          rec.existingId = ex[0].id
          rec.action = duplicates === 'update' ? 'update' : 'skip'
          rec.reason = `"${name}"${phone ? ` (${phone})` : ''} already exists.`
        }
      } else if (kind === 'payments') {
        const dir = dirOf(s0(v.direction))
        if (!dir) fail(row, `Direction "${v.direction}" must be Received (in) or Paid (out).`, 'direction')
        if (v.amount !== null && n0(v.amount) <= 0) fail(row, 'Amount must be greater than zero.', 'amount')
        if (v.method && !METHOD_ALIASES[lc(v.method).replace(/_/g, ' ')] && !METHOD_ALIASES[lc(v.method)]) fail(row, `Method "${v.method}" is not known (cash, bank transfer, cheque, online, card, other).`, 'method')
        v.direction = dir
        const num = s0(v.number)
        if (num) {
          if (dupInFile(`${dir}|${num}`, row, `Payment ${num}`)) continue
          const ex = db.prepare('SELECT id FROM payments WHERE firm_id = ? AND direction = ? AND number = ? COLLATE NOCASE').get(ctx.firmId, dir, num) as { id: number } | undefined
          if (ex) {
            rec.existingId = ex.id
            rec.action = 'skip'
            rec.reason = `Payment ${num} already exists — existing payments are never changed by an import.`
          }
        }
        if (rec.action !== 'skip' && dir) {
          if (v.party) {
            const r = resolveParty(ctx, dir === 'in' ? 'customer' : 'supplier', s0(v.party), s0(v.partyPhone))
            // A receipt can come from a supplier (refund) and a payment can go to a customer (refund): try the other side too.
            const r2nd = r.error ? resolveParty(ctx, dir === 'in' ? 'supplier' : 'customer', s0(v.party), s0(v.partyPhone)) : r
            if (r2nd.error) fail(row, r.error!, 'party')
            else v.partyId = r2nd.id!
          }
          const a = resolveAccount(ctx, s0(v.account))
          if (a.error) fail(row, a.error, 'account')
          else v.accountId = a.id!
          if (v.against) {
            const al = parseAgainst(s0(v.against), n0(v.amount))
            if (al.error) fail(row, al.error, 'against')
            else {
              const sum = r2(al.items.reduce((s, x) => s + x.amount, 0))
              if (sum > n0(v.amount) + 0.001) fail(row, `Against amounts (${sum}) are more than the payment amount.`, 'against')
              for (const it of al.items) if (!resolveAllocation(ctx, it.number)) fail(row, `Document "${it.number}" was not found — import the invoices / expenses first.`, 'against')
              v.allocations = JSON.stringify(al.items)
            }
          }
        }
      } else if (kind === 'expenses') {
        if (v.amount !== null && n0(v.amount) <= 0) fail(row, 'Amount must be greater than zero.', 'amount')
        if (v.method && !METHOD_ALIASES[lc(v.method).replace(/_/g, ' ')] && !METHOD_ALIASES[lc(v.method)]) fail(row, `Method "${v.method}" is not known (cash, bank transfer, cheque, online, card, other).`, 'method')
        const num = s0(v.number)
        if (num) {
          if (dupInFile(num, row, `Expense ${num}`)) continue
          const ex = db.prepare('SELECT id FROM expenses WHERE firm_id = ? AND number = ? COLLATE NOCASE').get(ctx.firmId, num) as { id: number } | undefined
          if (ex) {
            rec.existingId = ex.id
            rec.action = 'skip'
            rec.reason = `Expense ${num} already exists — existing expenses are never changed by an import.`
          }
        }
        if (rec.action !== 'skip') {
          const cat = s0(v.category)
          if (cat && !db.prepare('SELECT 1 FROM expense_categories WHERE name = ? COLLATE NOCASE').get(cat)) warn(row, `Expense category "${cat}" does not exist and will be created.`)
          const paid = v.paid !== false
          v.paid = paid
          if (v.party) {
            const r = resolveParty(ctx, 'supplier', s0(v.party), s0(v.partyPhone))
            if (r.error) fail(row, r.error, 'party')
            else v.partyId = r.id!
          } else if (!paid) fail(row, 'An unpaid expense needs a supplier / contractor.', 'party')
          if (paid) {
            const a = resolveAccount(ctx, s0(v.account))
            if (a.error) fail(row, a.error, 'account')
            else v.accountId = a.id!
          }
        }
      } else if (kind === 'stock') {
        if (n0(v.qty) < 0) fail(row, 'Qty cannot be negative.', 'qty')
        nonNeg(row, v, ['unitCost'])
        const pr = findProduct(ctx, s0(v.sku), s0(v.name))
        if (pr.error) fail(row, pr.error, 'sku')
        else if (!pr.id) fail(row, `Product "${s0(v.name)}" was not found — import products first.`, 'name')
        const wh = findWarehouse(ctx, s0(v.warehouse))
        if (wh.error) fail(row, wh.error, 'warehouse')
        if (pr.id && wh.id) {
          if (dupInFile(`${pr.id}|${wh.id}`, row, 'This product + warehouse')) continue
          const p = db.prepare('SELECT type, name FROM products WHERE id = ?').get(pr.id) as { type: string; name: string }
          if (p.type === 'service') fail(row, `"${p.name}" is a service and has no stock.`, 'sku')
          v.productId = pr.id
          v.warehouseId = wh.id
          rec.label = p.name
          if (ok(row) && Math.abs(warehouseQty(db, pr.id, wh.id) - n0(v.qty)) < 0.0005) {
            rec.action = 'skip'
            rec.reason = `"${p.name}": stock already ${n0(v.qty)}.`
          }
        }
      }
      records.push(rec)
    }
  }

  // 3. counts + file totals
  const valid = records.filter((r) => r.rows.every((x) => !invalidRows.has(x)))
  const counts: ImportCounts = {
    rows: all.length - 1,
    records: records.length,
    create: valid.filter((r) => r.action === 'create').length,
    update: valid.filter((r) => r.action === 'update').length,
    skip: valid.filter((r) => r.action === 'skip').length,
    invalid: records.length - valid.length + parsed.filter((p) => invalidRows.has(p.row) && !records.some((r) => r.rows.includes(p.row))).length
  }
  const rec: Reconciliation = { rows: all.length - 1, valid: 0, openingQty: 0, openingValue: 0, openingBalance: 0, amount: 0 }
  for (const r of valid) {
    rec.valid += r.rows.length
    if (r.action === 'skip') continue
    const t = expectedTotals(kind, r)
    rec.openingQty = r3(rec.openingQty + t.openingQty)
    rec.openingValue = r2(rec.openingValue + t.openingValue)
    rec.openingBalance = r2(rec.openingBalance + t.openingBalance)
    rec.amount = r2(rec.amount + t.amount)
  }
  const shownKeys = fields.map((x) => x.key)
  const preview = parsed.slice(0, 20).map((p) => {
    const o: Record<string, unknown> = { row: p.row }
    for (const k of shownKeys) o[k] = p.v[k]
    const r = records.find((x) => x.rows.includes(p.row))
    o._status = invalidRows.has(p.row) ? 'invalid' : (r?.action ?? 'invalid')
    return o
  })
  return {
    analysis: { kind, headers, fields, mapping, dateFormat, duplicates, preview, errors: errors.slice(0, 500), warnings, counts, reconciliation: rec },
    records,
    invalidRows
  }
}

/** What a record should add to the books (file side of the reconciliation). */
function expectedTotals(kind: ImportKind, r: Rec): Totals {
  const v = r.data
  const t: Totals = { rows: 1, openingQty: 0, openingValue: 0, openingBalance: 0, amount: 0 }
  if (kind === 'products' && r.action === 'create' && v.type !== 'service') {
    t.openingQty = r3(n0(v.openingQty))
    t.openingValue = r2(n0(v.openingQty) * n0(v.openingCost))
  } else if ((kind === 'customers' || kind === 'suppliers') && (r.action === 'create' || v.openingBalance !== null)) {
    t.openingBalance = r2(n0(v.openingBalance))
  } else if (kind === 'sales' || kind === 'purchases') {
    t.amount = computeTotals(
      (r.lines ?? []).map((l) => ({ qty: n0(l.qty), rate: n0(l.rate), discountPct: n0(l.discountPct), discountAmt: n0(l.discountAmt), taxRate: n0(l.taxRate) })),
      n0(v.docDiscount),
      n0(v.otherCharges),
      n0(v.roundOff)
    ).totals.grandTotal
  } else if (kind === 'payments' || kind === 'expenses') t.amount = r2(n0(v.amount))
  else if (kind === 'stock') t.openingQty = r3(n0(v.qty))
  return t
}

/* ------------------------------------------------------------------ apply ------------------------------------------------------------------ */

function categoryIdFor(ctx: Ctx, name: string): number | null {
  if (!name) return null
  const found = ctx.db.prepare('SELECT id FROM categories WHERE name = ? COLLATE NOCASE AND (firm_id IS NULL OR firm_id = ?)').get(name, ctx.firmId) as { id: number } | undefined
  return found?.id ?? saveCategory(ctx, { name })
}

const pick = <T>(csv: unknown, existing: T): T | string | number => (csv === null || csv === undefined || csv === '' ? existing : (csv as string | number))

/** Writes one record through the normal services. Returns the id of the created / updated row. */
function applyRecord(ctx: Ctx, kind: ImportKind, r: Rec): number {
  const db = ctx.db
  const v = r.data
  switch (kind) {
    case 'products': {
      if (r.action === 'update') {
        // Merge: an empty cell keeps the existing value. Stock is never changed here (use the Stock levels import).
        const e = db.prepare('SELECT * FROM products WHERE id = ?').get(r.existingId) as Record<string, unknown>
        const input: ProductInput = {
          id: r.existingId,
          name: String(pick(v.name, e.name)),
          sku: orUndef(pick(v.sku, e.sku)),
          barcode: orUndef(pick(v.barcode, e.barcode)),
          type: (v.type && db.prepare('SELECT 1 FROM products WHERE id = ?').get(r.existingId) && (r.data.type as string)) === 'service' ? 'service' : (e.type as 'goods' | 'service'),
          categoryId: v.category ? categoryIdFor(ctx, s0(v.category)) : (e.category_id as number | null),
          unit: orUndef(pick(v.unit, e.unit)),
          brand: orUndef(pick(v.brand, e.brand)),
          model: orUndef(pick(v.model, e.model)),
          description: orUndef(pick(v.description, e.description)),
          purchasePrice: Number(pick(v.purchasePrice, e.purchase_price)),
          salePrice: Number(pick(v.salePrice, e.sale_price)),
          minSalePrice: Number(pick(v.minSalePrice, e.min_sale_price)),
          taxRate: Number(pick(v.taxRate, e.tax_rate)),
          reorderLevel: Number(pick(v.reorderLevel, e.reorder_level)),
          trackSerial: !!e.track_serial,
          warrantyMonths: Number(pick(v.warrantyMonths, e.warranty_months)),
          warrantyTerms: orUndef(e.warranty_terms)
        }
        if (v.type === null) input.type = e.type as 'goods' | 'service'
        return saveProduct(ctx, input)
      }
      return saveProduct(ctx, {
        name: s0(v.name),
        sku: orUndef(v.sku),
        barcode: orUndef(v.barcode),
        type: v.type === 'service' ? 'service' : 'goods',
        categoryId: categoryIdFor(ctx, s0(v.category)),
        unit: orUndef(v.unit),
        brand: orUndef(v.brand),
        model: orUndef(v.model),
        description: orUndef(v.description),
        purchasePrice: n0(v.purchasePrice),
        salePrice: n0(v.salePrice),
        minSalePrice: n0(v.minSalePrice),
        taxRate: n0(v.taxRate),
        reorderLevel: n0(v.reorderLevel),
        warrantyMonths: n0(v.warrantyMonths),
        openingQty: v.type === 'service' ? 0 : n0(v.openingQty),
        openingCost: n0(v.openingCost)
      })
    }
    case 'categories': {
      const kindVal = lc(v.kind) === 'service' ? 'service' : lc(v.kind) === 'goods' ? 'goods' : undefined
      if (r.action === 'update') {
        const e = db.prepare('SELECT name, kind FROM categories WHERE id = ?').get(r.existingId) as { name: string; kind: string }
        return saveCategory(ctx, { id: r.existingId, name: s0(v.name) || e.name, kind: kindVal ?? e.kind })
      }
      return saveCategory(ctx, { name: s0(v.name), kind: kindVal })
    }
    case 'customers':
    case 'suppliers': {
      const type: PartyType = kind === 'customers' ? 'customer' : 'supplier'
      let e: Record<string, unknown> = {}
      if (r.action === 'update') e = db.prepare('SELECT * FROM parties WHERE id = ?').get(r.existingId) as Record<string, unknown>
      // Customers: positive = they owe us (receivable). Suppliers: positive = we owe them (payable).
      const existingBal = r.action === 'update' ? (type === 'customer' ? n0(e.opening_balance) : -n0(e.opening_balance)) : 0
      const bal = v.openingBalance === null ? existingBal : n0(v.openingBalance)
      const input: PartyInput = {
        id: r.action === 'update' ? r.existingId : undefined,
        type: r.action === 'update' ? (e.type as PartyInput['type']) : type,
        name: String(pick(v.name, e.name)),
        contactPerson: orUndef(pick(v.contactPerson, e.contact_person)),
        phone: orUndef(pick(v.phone, e.phone)),
        phone2: orUndef(pick(v.phone2, e.phone2)),
        email: orUndef(pick(v.email, e.email)),
        address: orUndef(pick(v.address, e.address)),
        city: orUndef(pick(v.city, e.city)),
        cnic: orUndef(pick(v.cnic, e.cnic)),
        ntn: orUndef(pick(v.ntn, e.ntn)),
        strn: orUndef(e.strn),
        openingBalance: Math.abs(bal),
        openingType: (bal < 0) === (type === 'customer') ? 'payable' : 'receivable',
        openingDate: orUndef(pick(v.openingDate, e.opening_date)),
        creditLimit: Number(pick(v.creditLimit, e.credit_limit ?? 0)),
        paymentTermsDays: Number(pick(v.paymentTermsDays, e.payment_terms_days ?? 0)),
        notes: orUndef(pick(v.notes, e.notes)),
        isActive: r.action === 'update' ? e.is_active !== 0 : true
      }
      if (bal === 0) input.openingType = 'receivable'
      return saveParty(ctx, input)
    }
    case 'sales':
    case 'purchases': {
      const docType = DOC_TYPE[kind]
      const lines: DocLineInput[] = (r.lines ?? []).map((l) => ({
        productId: (l.productId as number | null) ?? null,
        description: s0(l.itemName),
        details: orUndef(l.itemDetails) ?? null,
        unit: orUndef(l.unit),
        qty: n0(l.qty),
        rate: n0(l.rate),
        discountPct: n0(l.discountPct),
        discountAmt: n0(l.discountAmt),
        taxRate: n0(l.taxRate),
        serials: orUndef(l.serials)
      }))
      const id = createDocument(ctx, {
        docType,
        date: s0(v.date),
        dueDate: orUndef(v.dueDate) ?? null,
        partyId: (v.partyId as number | undefined) ?? null,
        partyName: v.partyId ? undefined : orUndef(v.walkInName),
        partyRef: orUndef(v.partyRef),
        notes: orUndef(v.notes),
        docDiscount: n0(v.docDiscount),
        otherCharges: n0(v.otherCharges),
        roundOff: n0(v.roundOff),
        lines,
        payment: n0(v.paidAmount) > 0 ? { amount: n0(v.paidAmount), accountId: v.accountId as number } : null
      })
      keepNumber(ctx, 'documents', id, s0(v.number))
      return id
    }
    case 'payments': {
      const items = v.allocations ? (JSON.parse(String(v.allocations)) as Array<{ number: string; amount: number }>) : []
      const allocations = items.map((it) => {
        const t = resolveAllocation(ctx, it.number)
        if (!t) throw new AppError(`Document "${it.number}" was not found.`, 'VALIDATION')
        return { ...t, amount: it.amount }
      })
      const methodKey = lc(v.method)
      const id = createPayment(ctx, {
        date: s0(v.date),
        direction: v.direction as 'in' | 'out',
        partyId: (v.partyId as number | undefined) ?? null,
        accountId: v.accountId as number,
        amount: n0(v.amount),
        method: METHOD_ALIASES[methodKey] ?? METHOD_ALIASES[methodKey.replace(/_/g, ' ')] ?? 'cash',
        reference: orUndef(v.reference),
        notes: orUndef(v.notes),
        allocations
      })
      keepNumber(ctx, 'payments', id, s0(v.number))
      return id
    }
    case 'expenses': {
      const cat = s0(v.category)
      const c = db.prepare('SELECT id FROM expense_categories WHERE name = ? COLLATE NOCASE').get(cat) as { id: number } | undefined
      const categoryId = c?.id ?? saveExpenseCategory(ctx, { name: cat, costHead: 'overhead' })
      const methodKey = lc(v.method)
      const id = createExpense(ctx, {
        date: s0(v.date),
        categoryId,
        amount: n0(v.amount),
        paid: v.paid !== false,
        accountId: (v.accountId as number | undefined) ?? null,
        partyId: (v.partyId as number | undefined) ?? null,
        payeeName: orUndef(v.payee),
        method: v.method ? (METHOD_ALIASES[methodKey] ?? METHOD_ALIASES[methodKey.replace(/_/g, ' ')]) : undefined,
        reference: orUndef(v.reference),
        notes: orUndef(v.notes)
      })
      keepNumber(ctx, 'expenses', id, s0(v.number))
      return id
    }
    case 'stock': {
      const productId = v.productId as number
      const warehouseId = v.warehouseId as number
      const diff = r3(n0(v.qty) - warehouseQty(db, productId, warehouseId))
      const p = db.prepare('SELECT avg_cost, purchase_price FROM products WHERE id = ?').get(productId) as { avg_cost: number; purchase_price: number }
      createAdjustment(ctx, {
        date: new Date().toISOString().slice(0, 10),
        warehouseId,
        kind: 'adjustment',
        reason: 'Stock levels imported from CSV',
        lines: [{ productId, qty: diff, unitCost: v.unitCost === null ? p.avg_cost || p.purchase_price : n0(v.unitCost) }]
      })
      return productId
    }
  }
}

/** Keep the original document / payment / expense number from the file (it was checked to be unused). */
function keepNumber(ctx: Ctx, table: 'documents' | 'payments' | 'expenses', id: number, wanted: string): void {
  const number = wanted.trim().slice(0, 40)
  if (!number) return
  const db = ctx.db
  const cur = db.prepare(`SELECT number FROM ${table} WHERE id = ?`).get(id) as { number: string }
  if (cur.number === number) return
  db.prepare(`UPDATE ${table} SET number = ? WHERE id = ?`).run(number, id)
  if (table === 'documents') {
    const d = db.prepare('SELECT doc_type FROM documents WHERE id = ?').get(id) as { doc_type: string }
    db.prepare('UPDATE stock_movements SET ref_number = ? WHERE ref_type = ? AND ref_id = ?').run(number, d.doc_type, id)
    // the payment taken at billing says "Against <number>"
    db.prepare(`UPDATE payments SET notes = ? WHERE notes = ? AND id IN (SELECT payment_id FROM payment_allocations WHERE document_id = ?)`).run(
      `Against ${number}`,
      `Against ${cur.number}`,
      id
    )
  }
}

/** What the books now hold for the written records (imported side of the reconciliation). */
function measuredTotals(ctx: Ctx, kind: ImportKind, done: Array<{ rec: Rec; id: number }>): Totals {
  const t: Totals = { rows: done.length, openingQty: 0, openingValue: 0, openingBalance: 0, amount: 0 }
  const db = ctx.db
  for (const { rec, id } of done) {
    if (kind === 'products' && rec.action === 'create') {
      const s = db.prepare(`SELECT COALESCE(SUM(qty_in),0) q, COALESCE(SUM(qty_in * unit_cost),0) v FROM stock_movements WHERE ref_type = 'opening' AND product_id = ?`).get(id) as { q: number; v: number }
      t.openingQty = r3(t.openingQty + s.q)
      t.openingValue = r2(t.openingValue + r2(s.v))
    } else if ((kind === 'customers' || kind === 'suppliers') && (rec.action === 'create' || rec.data.openingBalance !== null)) {
      const b = (db.prepare('SELECT opening_balance b FROM parties WHERE id = ?').get(id) as { b: number }).b
      t.openingBalance = r2(t.openingBalance + (kind === 'customers' ? b : -b))
    } else if (kind === 'sales' || kind === 'purchases') {
      t.amount = r2(t.amount + (db.prepare('SELECT grand_total g FROM documents WHERE id = ?').get(id) as { g: number }).g)
    } else if (kind === 'payments') {
      t.amount = r2(t.amount + (db.prepare('SELECT amount a FROM payments WHERE id = ?').get(id) as { a: number }).a)
    } else if (kind === 'expenses') {
      t.amount = r2(t.amount + (db.prepare('SELECT amount a FROM expenses WHERE id = ?').get(id) as { a: number }).a)
    } else if (kind === 'stock') {
      t.openingQty = r3(t.openingQty + warehouseQty(db, id, rec.data.warehouseId as number))
    }
  }
  return t
}

class Rollback extends Error {}

/**
 * Runs every record through the services inside ONE transaction. Each record has its own savepoint so a failing record
 * is reported (row + reason) without leaving half-written data. The transaction is rolled back for a dry run, when any
 * record failed (unless skipInvalid), or when the reconciliation does not match.
 */
function execute(ctx: Ctx, prep: Prepared, opts: { commit: boolean; skipInvalid: boolean; onCommit?: (r: ExecResult) => void }): ExecResult {
  const { analysis, records, invalidRows } = prep
  const kind = analysis.kind
  const db = ctx.db
  let result: ExecResult | null = null
  try {
    db.transaction(() => {
      const failures: RowError[] = []
      const skippedReasons: RowError[] = []
      const done: Array<{ rec: Rec; id: number }> = []
      const file: Totals = { rows: 0, openingQty: 0, openingValue: 0, openingBalance: 0, amount: 0 }
      let imported = 0
      let updated = 0
      let skipped = 0
      for (const r of records) {
        if (r.rows.some((x) => invalidRows.has(x))) continue
        if (r.action === 'skip') {
          skipped++
          if (skippedReasons.length < 500) skippedReasons.push({ row: r.row, message: r.reason ?? 'Skipped.' })
          continue
        }
        try {
          const id = db.transaction(() => applyRecord(ctx, kind, r))()
          done.push({ rec: r, id })
          const t = expectedTotals(kind, r)
          file.rows++
          file.openingQty = r3(file.openingQty + t.openingQty)
          file.openingValue = r2(file.openingValue + t.openingValue)
          file.openingBalance = r2(file.openingBalance + t.openingBalance)
          file.amount = r2(file.amount + t.amount)
          if (r.action === 'update') updated++
          else imported++
        } catch (e) {
          if (failures.length < 500) failures.push({ row: r.row, message: `${r.label}: ${(e as Error).message}` })
        }
      }
      const measured = measuredTotals(ctx, kind, done)
      const matched =
        measured.rows === file.rows &&
        Math.abs(measured.openingQty - file.openingQty) < 0.001 &&
        Math.abs(measured.openingValue - file.openingValue) < 0.01 &&
        Math.abs(measured.openingBalance - file.openingBalance) < 0.01 &&
        Math.abs(measured.amount - file.amount) < 0.01
      const invalidCount = analysis.counts.invalid
      result = {
        imported,
        updated,
        skipped,
        failed: failures.length + invalidCount,
        failures,
        skippedReasons,
        reconciliation: { file: { ...analysis.reconciliation, ...file, rows: analysis.reconciliation.rows, valid: analysis.reconciliation.valid }, imported: measured, matched }
      }
      if (!opts.commit) throw new Rollback()
      if (failures.length && !opts.skipInvalid) throw new Rollback()
      if (!matched) throw new AppError('Imported totals do not match the file totals — the import was rolled back.', 'RECONCILE')
      opts.onCommit?.(result)
    })()
  } catch (e) {
    if (!(e instanceof Rollback)) throw e
  }
  return result!
}

/* ------------------------------------------------------------------ public API ------------------------------------------------------------------ */

/** Validation (+ optional dry run through the services, always rolled back). Never writes anything. */
export function analyzeImport(ctx: Ctx, input: ImportOptions): Analysis {
  requirePerm(ctx, 'import.manage')
  const prep = prepare(ctx, input)
  if (input.dryRun && !prep.analysis.errors.some((e) => e.row === 0)) {
    prep.analysis.dryRun = execute(ctx, prep, { commit: false, skipInvalid: !!input.skipInvalid })
  }
  return prep.analysis
}

export interface ImportResult {
  runId: number
  imported: number
  updated: number
  skipped: number
  failed: number
  failures: RowError[]
  skippedReasons: RowError[]
  reconciliation: ExecResult['reconciliation']
}

/** Imports in ONE transaction. Invalid / failing rows => nothing is written unless skipInvalid (a failed run is still logged). */
export function runImport(ctx: Ctx, input: ImportOptions): ImportResult {
  requirePerm(ctx, 'import.manage')
  const kind = assertKind(input.kind)
  const db = ctx.db
  const skipInvalid = !!input.skipInvalid
  const prep = prepare(ctx, input)
  const { analysis } = prep
  const logRun = (res: Partial<ExecResult> & { errors: RowError[] }): number =>
    Number(
      db
        .prepare(
          `INSERT INTO import_runs (firm_id, source, kind, file_name, mapping, total_rows, imported, skipped, errors, reconciliation, created_by)
           VALUES (?, 'csv', ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          ctx.firmId,
          kind,
          input.fileName ? String(input.fileName).slice(0, 200) : null,
          JSON.stringify(Object.fromEntries(Object.entries(analysis.mapping).map(([k, v]) => [k, v === null ? null : analysis.headers[v]]))),
          analysis.reconciliation.rows,
          (res.imported ?? 0) + (res.updated ?? 0),
          analysis.reconciliation.rows - (res.imported ?? 0) - (res.updated ?? 0),
          res.errors.length ? JSON.stringify(res.errors.slice(0, 500)) : null,
          JSON.stringify({
            counts: { imported: res.imported ?? 0, updated: res.updated ?? 0, skipped: res.skipped ?? 0, failed: res.failed ?? res.errors.length },
            options: { duplicates: analysis.duplicates, dateFormat: analysis.dateFormat, skipInvalid },
            ...(res.reconciliation ?? { file: analysis.reconciliation, imported: null, matched: false })
          }),
          ctx.user.id
        ).lastInsertRowid
    )
  const structural = analysis.errors.filter((e) => e.row === 0)
  if (structural.length || (analysis.errors.length && !skipInvalid)) {
    logRun({ errors: analysis.errors, failed: analysis.counts.invalid })
    throw new AppError(`Nothing was imported: ${analysis.errors.length} problem(s) found. Fix the file or the column mapping and try again.`, 'VALIDATION')
  }
  let runId = 0
  let res: ExecResult
  try {
    res = execute(ctx, prep, {
      commit: true,
      skipInvalid,
      onCommit: (r) => {
        runId = logRun({ ...r, errors: [...analysis.errors, ...r.failures] })
        audit(ctx, 'import', 'import_run', runId, `Imported ${r.imported} new / ${r.updated} updated ${KIND_LABELS[kind]} from ${input.fileName ?? 'CSV'}`, {
          skipped: r.skipped,
          failed: r.failed,
          reconciliation: r.reconciliation
        })
      }
    })
  } catch (e) {
    logRun({ errors: [{ row: 0, message: (e as Error).message }] })
    throw e
  }
  if (!runId) {
    logRun({ ...res, imported: 0, updated: 0, errors: res.failures })
    const first = res.failures[0]
    throw new AppError(
      `Nothing was imported: ${res.failures.length} record(s) failed. ${first ? `Row ${first.row}: ${first.message}` : ''}`.trim(),
      'VALIDATION'
    )
  }
  return { runId, ...res }
}

export function listImportRuns(ctx: Ctx): unknown[] {
  requirePerm(ctx, 'import.manage')
  return ctx.db
    .prepare(
      `SELECT r.*, u.full_name AS created_by_name FROM import_runs r LEFT JOIN users u ON u.id = r.created_by
        WHERE r.firm_id = ? OR r.firm_id IS NULL ORDER BY r.id DESC LIMIT 200`
    )
    .all(ctx.firmId)
}

/** CSV template with the expected headers for a kind (UTF-8 BOM so Excel opens Urdu text correctly). */
export function importTemplate(kind: ImportKind): string {
  return '﻿' + importFields(kind).map((x) => x.label).join(',') + '\r\n'
}
