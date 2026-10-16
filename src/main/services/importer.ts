/**
 * CSV import pipeline (owner: data area): products and customers / suppliers.
 * parse -> header auto-mapping (user can override) -> per-row validation (nothing written) -> dry-run reconciliation
 * -> import in ONE transaction through the normal services (saveProduct / saveParty, so opening stock goes through the
 * opening-stock adjustment path and keeps stock + average cost consistent) -> import_runs row.
 * If anything fails, or the imported totals do not match the file totals, the whole import is rolled back.
 */
import { AppError, Ctx, audit, requirePerm } from './context'
import { saveCategory, saveProduct } from './inventory'
import { saveParty } from './parties'

export type ImportKind = 'products' | 'customers' | 'suppliers'

export interface ImportField {
  key: string
  label: string
  required?: boolean
  type: 'text' | 'number'
  aliases: string[]
}

const PRODUCT_FIELDS: ImportField[] = [
  { key: 'name', label: 'Name', required: true, type: 'text', aliases: ['name', 'product', 'product name', 'item', 'item name', 'description1', 'title'] },
  { key: 'sku', label: 'SKU / code', type: 'text', aliases: ['sku', 'code', 'item code', 'product code', 'barcode'] },
  { key: 'category', label: 'Category', type: 'text', aliases: ['category', 'group', 'item group', 'type'] },
  { key: 'unit', label: 'Unit', type: 'text', aliases: ['unit', 'uom', 'units'] },
  { key: 'brand', label: 'Brand', type: 'text', aliases: ['brand', 'make', 'manufacturer'] },
  { key: 'model', label: 'Model', type: 'text', aliases: ['model', 'model no', 'model number'] },
  { key: 'description', label: 'Description', type: 'text', aliases: ['description', 'details', 'specification', 'specs'] },
  { key: 'purchasePrice', label: 'Purchase price', type: 'number', aliases: ['purchase price', 'cost', 'cost price', 'buy price', 'purchase rate'] },
  { key: 'salePrice', label: 'Sale price', type: 'number', aliases: ['sale price', 'price', 'selling price', 'rate', 'sale rate', 'retail price'] },
  { key: 'openingQty', label: 'Opening qty', type: 'number', aliases: ['opening qty', 'opening quantity', 'qty', 'quantity', 'stock', 'opening stock'] },
  { key: 'openingCost', label: 'Opening unit cost', type: 'number', aliases: ['opening cost', 'opening unit cost', 'unit cost', 'opening rate'] }
]

const PARTY_FIELDS: ImportField[] = [
  { key: 'name', label: 'Name', required: true, type: 'text', aliases: ['name', 'customer', 'customer name', 'supplier', 'supplier name', 'party', 'party name', 'vendor'] },
  { key: 'phone', label: 'Phone', type: 'text', aliases: ['phone', 'mobile', 'cell', 'contact', 'phone no', 'mobile no', 'contact no'] },
  { key: 'address', label: 'Address', type: 'text', aliases: ['address', 'street', 'location'] },
  { key: 'city', label: 'City', type: 'text', aliases: ['city', 'town'] },
  { key: 'openingBalance', label: 'Opening balance', type: 'number', aliases: ['opening balance', 'opening', 'balance', 'opening bal', 'previous balance'] }
]

export function importFields(kind: ImportKind): ImportField[] {
  return kind === 'products' ? PRODUCT_FIELDS : PARTY_FIELDS
}

function assertKind(kind: unknown): ImportKind {
  if (kind === 'products' || kind === 'customers' || kind === 'suppliers') return kind
  throw new AppError('Choose what to import: products, customers or suppliers.', 'VALIDATION')
}

/** RFC-4180 style CSV parser (quotes, escaped quotes, CRLF, BOM). Also accepts ; or tab separated files. */
export function parseCsv(text: string): string[][] {
  const src = String(text ?? '').replace(/^﻿/, '')
  const firstLine = src.split(/\r?\n/, 1)[0] ?? ''
  const count = (ch: string): number => firstLine.split(ch).length - 1
  const sep = count('\t') > count(',') && count('\t') >= count(';') ? '\t' : count(';') > count(',') ? ';' : ','
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let q = false
  for (let i = 0; i < src.length; i++) {
    const c = src[i]
    if (q) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          cell += '"'
          i++
        } else q = false
      } else cell += c
    } else if (c === '"' && cell === '') q = true
    else if (c === sep) {
      row.push(cell)
      cell = ''
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++
      row.push(cell)
      rows.push(row)
      row = []
      cell = ''
    } else cell += c
  }
  if (cell !== '' || row.length) {
    row.push(cell)
    rows.push(row)
  }
  return rows.filter((r) => r.some((v) => v.trim() !== ''))
}

const norm = (s: string): string => s.toLowerCase().replace(/[_\-./]+/g, ' ').replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim()

/** field key -> column index (or null) */
export type Mapping = Record<string, number | null>

export function autoMap(headers: string[], kind: ImportKind): Mapping {
  const fields = importFields(kind)
  const h = headers.map(norm)
  const used = new Set<number>()
  const map: Mapping = {}
  for (const f of fields) {
    let idx = h.findIndex((x, i) => !used.has(i) && (x === norm(f.key) || x === norm(f.label) || f.aliases.includes(x)))
    if (idx < 0) idx = h.findIndex((x, i) => !used.has(i) && f.aliases.some((a) => a.length > 3 && x.includes(a)))
    map[f.key] = idx >= 0 ? idx : null
    if (idx >= 0) used.add(idx)
  }
  return map
}

export function parseNumber(v: string): number | null {
  const s = String(v ?? '').trim().replace(/,/g, '').replace(/^(rs\.?|pkr)\s*/i, '')
  if (s === '') return 0
  const neg = /^\(.*\)$/.test(s)
  const n = Number(neg ? s.slice(1, -1) : s)
  return Number.isFinite(n) ? (neg ? -n : n) : null
}

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
}

export interface Analysis {
  kind: ImportKind
  headers: string[]
  fields: ImportField[]
  mapping: Mapping
  preview: Array<Record<string, unknown>>
  errors: RowError[]
  reconciliation: Reconciliation
}

interface Prepared {
  row: number
  values: Record<string, string | number>
}

const r2 = (n: number): number => Math.round(n * 100) / 100
const r3 = (n: number): number => Math.round(n * 1000) / 1000

function prepare(ctx: Ctx, kind: ImportKind, text: string, mappingIn?: Mapping): { analysis: Analysis; rows: Prepared[] } {
  const all = parseCsv(text)
  if (all.length < 2) throw new AppError('The file has no data rows (the first row must be the column headers).', 'VALIDATION')
  if (all.length > 20001) throw new AppError('The file has more than 20,000 rows. Split it into smaller files.', 'VALIDATION')
  const headers = all[0].map((h) => h.trim())
  const fields = importFields(kind)
  const mapping: Mapping = {}
  const auto = autoMap(headers, kind)
  for (const f of fields) {
    const m = mappingIn && f.key in mappingIn ? mappingIn[f.key] : auto[f.key]
    mapping[f.key] = m === null || m === undefined || (m as unknown) === '' || Number(m) < 0 || Number(m) >= headers.length ? null : Number(m)
  }
  const errors: RowError[] = []
  for (const f of fields) if (f.required && mapping[f.key] === null) errors.push({ row: 0, field: f.key, message: `Map a column to "${f.label}".` })
  const rows: Prepared[] = []
  const seenSku = new Map<string, number>()
  const seenName = new Map<string, number>()
  const rec: Reconciliation = { rows: all.length - 1, valid: 0, openingQty: 0, openingValue: 0, openingBalance: 0 }
  const db = ctx.db
  for (let i = 1; i < all.length; i++) {
    const line = all[i]
    const rowNo = i + 1 // spreadsheet row number (header = row 1)
    const values: Record<string, string | number> = {}
    const before = errors.length
    for (const f of fields) {
      const idx = mapping[f.key]
      const raw = idx === null ? '' : String(line[idx] ?? '').trim()
      if (f.type === 'number') {
        const n = parseNumber(raw)
        if (n === null) errors.push({ row: rowNo, field: f.key, message: `${f.label} "${raw}" is not a number.` })
        else values[f.key] = n
      } else values[f.key] = raw
    }
    const name = String(values.name ?? '')
    if (!name) errors.push({ row: rowNo, field: 'name', message: 'Name is empty.' })
    else if (name.length > 200) errors.push({ row: rowNo, field: 'name', message: 'Name is longer than 200 characters.' })
    if (kind === 'products') {
      for (const k of ['purchasePrice', 'salePrice', 'openingQty', 'openingCost']) {
        if (Number(values[k] ?? 0) < 0) errors.push({ row: rowNo, field: k, message: `${fields.find((f) => f.key === k)!.label} cannot be negative.` })
      }
      const sku = String(values.sku ?? '')
      if (sku) {
        const k = sku.toLowerCase()
        if (seenSku.has(k)) errors.push({ row: rowNo, field: 'sku', message: `SKU "${sku}" repeats row ${seenSku.get(k)}.` })
        else seenSku.set(k, rowNo)
        if (db.prepare('SELECT 1 FROM products WHERE sku = ? COLLATE NOCASE').get(sku)) errors.push({ row: rowNo, field: 'sku', message: `SKU "${sku}" already exists.` })
      }
      if (name) {
        const k = name.toLowerCase()
        if (seenName.has(k)) errors.push({ row: rowNo, field: 'name', message: `Product "${name}" repeats row ${seenName.get(k)}.` })
        else seenName.set(k, rowNo)
        if (db.prepare('SELECT 1 FROM products WHERE name = ? COLLATE NOCASE AND (firm_id IS NULL OR firm_id = ?)').get(name, ctx.firmId)) {
          errors.push({ row: rowNo, field: 'name', message: `Product "${name}" already exists.` })
        }
      }
      if (!values.openingCost && Number(values.openingQty) > 0) values.openingCost = Number(values.purchasePrice ?? 0)
    } else {
      if (name) {
        const phone = String(values.phone ?? '')
        const k = `${name.toLowerCase()}|${phone}`
        if (seenName.has(k)) errors.push({ row: rowNo, field: 'name', message: `"${name}" repeats row ${seenName.get(k)}.` })
        else seenName.set(k, rowNo)
        const dup = db
          .prepare(`SELECT 1 FROM parties WHERE name = ? COLLATE NOCASE AND COALESCE(phone,'') = ? AND (firm_id IS NULL OR firm_id = ?)`)
          .get(name, phone, ctx.firmId)
        if (dup) errors.push({ row: rowNo, field: 'name', message: `"${name}"${phone ? ` (${phone})` : ''} already exists.` })
      }
    }
    if (errors.length === before) {
      rec.valid++
      rec.openingQty = r3(rec.openingQty + Number(values.openingQty ?? 0))
      rec.openingValue = r2(rec.openingValue + r2(Number(values.openingQty ?? 0) * Number(values.openingCost ?? 0)))
      rec.openingBalance = r2(rec.openingBalance + Number(values.openingBalance ?? 0))
      rows.push({ row: rowNo, values })
    }
  }
  return {
    analysis: { kind, headers, fields, mapping, preview: rows.slice(0, 20).map((r) => ({ row: r.row, ...r.values })), errors: errors.slice(0, 500), reconciliation: rec },
    rows
  }
}

/** Validation + dry-run reconciliation. Never writes anything. */
export function analyzeImport(ctx: Ctx, input: { kind: ImportKind; text: string; mapping?: Mapping }): Analysis {
  requirePerm(ctx, 'import.manage')
  return prepare(ctx, assertKind(input.kind), input.text, input.mapping).analysis
}

export interface ImportResult {
  runId: number
  imported: number
  reconciliation: { file: Reconciliation; imported: { rows: number; openingQty: number; openingValue: number; openingBalance: number }; matched: boolean }
}

/** Imports every row in ONE transaction. Any invalid row => nothing is written (a failed run is still logged). */
export function runImport(ctx: Ctx, input: { kind: ImportKind; text: string; mapping?: Mapping; fileName?: string }): ImportResult {
  requirePerm(ctx, 'import.manage')
  const kind = assertKind(input.kind)
  const db = ctx.db
  const { analysis, rows } = prepare(ctx, kind, input.text, input.mapping)
  const logRun = (imported: number, errors: RowError[], reconciliation: unknown): number =>
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
          imported,
          analysis.reconciliation.rows - imported,
          errors.length ? JSON.stringify(errors.slice(0, 500)) : null,
          JSON.stringify(reconciliation),
          ctx.user.id
        ).lastInsertRowid
    )
  if (analysis.errors.length) {
    logRun(0, analysis.errors, { file: analysis.reconciliation, imported: null, matched: false })
    throw new AppError(`Nothing was imported: ${analysis.errors.length} problem(s) found. Fix the file or the column mapping and try again.`, 'VALIDATION')
  }
  try {
    return db.transaction(() => {
      const ids: number[] = []
      const catCache = new Map<string, number>()
      for (const r of rows) {
        const v = r.values
        try {
          if (kind === 'products') {
            let categoryId: number | null = null
            const cat = String(v.category ?? '').trim()
            if (cat) {
              const key = cat.toLowerCase()
              if (!catCache.has(key)) {
                const found = db
                  .prepare('SELECT id FROM categories WHERE name = ? COLLATE NOCASE AND (firm_id IS NULL OR firm_id = ?)')
                  .get(cat, ctx.firmId) as { id: number } | undefined
                catCache.set(key, found?.id ?? saveCategory(ctx, { name: cat }))
              }
              categoryId = catCache.get(key)!
            }
            ids.push(
              saveProduct(ctx, {
                name: String(v.name),
                sku: String(v.sku || '') || undefined,
                categoryId,
                unit: String(v.unit || '') || undefined,
                brand: String(v.brand || '') || undefined,
                model: String(v.model || '') || undefined,
                description: String(v.description || '') || undefined,
                purchasePrice: Number(v.purchasePrice ?? 0),
                salePrice: Number(v.salePrice ?? 0),
                openingQty: Number(v.openingQty ?? 0),
                openingCost: Number(v.openingCost ?? 0)
              })
            )
          } else {
            const bal = Number(v.openingBalance ?? 0)
            // Customers: positive = they owe us (receivable). Suppliers: positive = we owe them (payable).
            const positiveType = kind === 'customers' ? 'receivable' : 'payable'
            const negativeType = kind === 'customers' ? 'payable' : 'receivable'
            ids.push(
              saveParty(ctx, {
                type: kind === 'customers' ? 'customer' : 'supplier',
                name: String(v.name),
                phone: String(v.phone || '') || undefined,
                address: String(v.address || '') || undefined,
                city: String(v.city || '') || undefined,
                openingBalance: Math.abs(bal),
                openingType: bal < 0 ? negativeType : positiveType
              })
            )
          }
        } catch (e) {
          throw new AppError(`Row ${r.row}: ${(e as Error).message}`, 'VALIDATION')
        }
      }
      // Reconcile what is now in the books against the file totals.
      const imported = { rows: ids.length, openingQty: 0, openingValue: 0, openingBalance: 0 }
      if (ids.length) {
        const inList = ids.join(',')
        if (kind === 'products') {
          const s = db
            .prepare(
              `SELECT COALESCE(SUM(qty_in),0) q, COALESCE(SUM(qty_in * unit_cost),0) v FROM stock_movements WHERE ref_type = 'opening' AND product_id IN (${inList})`
            )
            .get() as { q: number; v: number }
          imported.openingQty = r3(s.q)
          imported.openingValue = r2(s.v)
        } else {
          const s = db.prepare(`SELECT COALESCE(SUM(opening_balance),0) b FROM parties WHERE id IN (${inList})`).get() as { b: number }
          imported.openingBalance = r2(kind === 'customers' ? s.b : -s.b)
        }
      }
      const f = analysis.reconciliation
      const matched =
        imported.rows === f.valid &&
        Math.abs(imported.openingQty - f.openingQty) < 0.001 &&
        Math.abs(imported.openingValue - f.openingValue) < 0.01 &&
        Math.abs(imported.openingBalance - f.openingBalance) < 0.01
      if (!matched) throw new AppError('Imported totals do not match the file totals — the import was rolled back.', 'RECONCILE')
      const reconciliation = { file: f, imported, matched }
      const runId = logRun(ids.length, [], reconciliation)
      audit(ctx, 'import', 'import_run', runId, `Imported ${ids.length} ${kind} from ${input.fileName ?? 'CSV'}`, reconciliation)
      return { runId, imported: ids.length, reconciliation }
    })()
  } catch (e) {
    logRun(0, [{ row: 0, message: (e as Error).message }], { file: analysis.reconciliation, imported: null, matched: false })
    throw e
  }
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

/** CSV template with the expected headers for a kind. */
export function importTemplate(kind: ImportKind): string {
  return importFields(assertKind(kind))
    .map((f) => f.label)
    .join(',') + '\n'
}
