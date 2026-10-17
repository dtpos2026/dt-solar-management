/**
 * Sales & purchase documents: invoices, quotations, orders, delivery challans and returns.
 *
 * Totals (per line):  gross = qty*rate ; discount = amount or % of gross ; net = gross - discount ; tax = net * rate%
 * Document:           netSum = Σ net ; docDiscount reduces the taxable value proportionally (tax scaled by the same factor)
 *                     net_total (revenue / cost basis, EXCLUDING tax) = netSum - docDiscount + otherCharges + roundOff
 *                     grand_total = net_total + tax_total
 *
 * Stock effects (only for final, non-cancelled documents):
 *   sale_invoice (deduct_stock=1)  -> OUT at moving average cost (cost recorded on the line = COGS)
 *   sale_return                     -> IN  at the original sale cost (or current average if no reference)
 *   purchase_invoice                -> IN  at landed cost (net after discounts + share of other charges [+ tax if tax is a cost])
 *   purchase_invoice direct_to_project -> NO stock; landed cost charged directly to the project
 *   purchase_return                 -> OUT removing the original purchase cost
 * Quotations, orders and delivery challans never move stock or money.
 */
import { DOC_TYPES, DocType } from '../../shared/docTypes'
import { EPS, num, round2, round3, round4 } from '../../shared/money'
import { computeTotals, ComputedTotals } from '../../shared/totals'
import {
  AppError,
  Ctx,
  audit,
  can,
  getSetting,
  optId,
  optText,
  requireDate,
  requirePerm,
  visibleTo
} from './context'
import { nextNumber } from './firms'
import {
  assertWarehouseVisible,
  checkSerialCount,
  defaultWarehouseId,
  getProductRow,
  parseSerials,
  reverseMovements,
  reverseSerials,
  serialsIn,
  serialsOut,
  stockIn,
  stockOut
} from './inventory'
import { applyAdvances, docAdjusted, docAllocated, docDue, docReturned, insertPayment } from './payments'
import { partyBalance } from './parties'
import { assertPeriodOpen } from './closing'

export interface DocLineInput {
  productId?: number | null
  /** Item name / line title (printed in bold). */
  description: string
  /** Optional item description printed under the item name (multi-line). */
  details?: string | null
  unit?: string
  qty: number
  rate: number
  discountPct?: number
  discountAmt?: number
  taxRate?: number
  serials?: string
  batchNo?: string
  warranty?: string
  refLineId?: number | null
}

export interface DocInput {
  id?: number
  docType: DocType
  date: string
  dueDate?: string | null
  validUntil?: string | null
  partyId?: number | null
  partyName?: string
  partyPhone?: string
  partyAddress?: string
  projectId?: number | null
  warehouseId?: number | null
  isTaxInvoice?: boolean
  deductStock?: boolean
  directToProject?: boolean
  docDiscount?: number
  otherCharges?: number
  otherChargesLabel?: string
  roundOff?: number
  refDocId?: number | null
  partyRef?: string
  notes?: string
  terms?: string
  status?: string
  lines: DocLineInput[]
  payment?: { amount: number; accountId: number; method?: string; reference?: string } | null
  applyAdvance?: boolean
}

interface ComputedLine {
  productId: number | null
  description: string
  details: string | null
  unit: string | null
  qty: number
  rate: number
  discountPct: number
  discountAmt: number
  taxRate: number
  taxAmt: number
  net: number
  lineTotal: number
  serials: string[]
  batchNo: string | null
  warranty: string | null
  refLineId: number | null
  product: ReturnType<typeof getProductRow> | null
}

export { computeTotals } from '../../shared/totals'
export type { ComputedTotals } from '../../shared/totals'

function permPrefix(type: DocType): string {
  return DOC_TYPES[type].perm
}

/** Multi-line free text (item description): keeps line breaks, trims, caps length; empty -> null. */
function optMultiline(s: unknown, max: number): string | null {
  if (s === null || s === undefined) return null
  const v = String(s)
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((x) => x.replace(/\s+$/, ''))
    .join('\n')
    .replace(/^\n+|\n+$/g, '')
  return v.trim() ? v.slice(0, max) : null
}

/** Closed days / months freeze every document that affects the books (invoices, bills and returns). */
function assertOpenFor(ctx: Ctx, type: DocType, date: string): void {
  if (DOC_TYPES[type].financial) assertPeriodOpen(ctx.db, ctx.firmId, date)
}

function assertCanCreate(ctx: Ctx, type: DocType): void {
  const p = permPrefix(type)
  requirePerm(ctx, p === 'quotations' ? 'quotations.manage' : `${p}.create`)
}

function isLocked(ctx: Ctx, docId: number): boolean {
  return docAllocated(ctx.db, docId) > EPS || docReturned(ctx.db, docId) > EPS || docAdjusted(ctx.db, docId) > EPS
}

function assertCanEdit(ctx: Ctx, type: DocType, docId: number, action: 'edit' | 'cancel'): void {
  const p = permPrefix(type)
  if (p === 'quotations') return requirePerm(ctx, 'quotations.manage')
  requirePerm(ctx, action === 'edit' ? `${p}.edit` : `${p}.cancel`)
  if (isLocked(ctx, docId) && !can(ctx, `${p}.edit_locked`)) {
    throw new AppError(
      'This document has payments or returns recorded against it. Only users with the "edit paid documents" permission can change it.',
      'FORBIDDEN'
    )
  }
}

function validateAndCompute(ctx: Ctx, input: DocInput): { lines: ComputedLine[]; totals: ComputedTotals } {
  const meta = DOC_TYPES[input.docType]
  const db = ctx.db
  const rawLines = (input.lines ?? []).filter((l) => l && (l.description || l.productId))
  if (rawLines.length === 0) throw new AppError('Add at least one item.', 'VALIDATION')
  if (rawLines.length > 500) throw new AppError('Too many lines (max 500).', 'VALIDATION')
  const allowBelowMin = can(ctx, 'sales.discount')
  const lines: ComputedLine[] = rawLines.map((l, i) => {
    const productId = optId(l.productId)
    let product: ComputedLine['product'] = null
    if (productId) {
      const p = db.prepare(`SELECT id FROM products p WHERE id = @id AND ${visibleTo('p')}`).get({ id: productId, firmId: ctx.firmId })
      if (!p) throw new AppError(`Line ${i + 1}: product is not available in this firm.`, 'VALIDATION')
      product = getProductRow(db, productId)
    }
    const description = String(l.description || product?.name || '').trim()
    if (!description) throw new AppError(`Line ${i + 1}: description is required.`, 'VALIDATION')
    const qty = round3(num(l.qty))
    if (qty <= 0) throw new AppError(`Line ${i + 1} (${description}): quantity must be greater than zero.`, 'VALIDATION')
    const rate = round4(num(l.rate))
    if (rate < 0) throw new AppError(`Line ${i + 1} (${description}): rate cannot be negative.`, 'VALIDATION')
    const discountPct = round2(num(l.discountPct))
    const discountAmt = round2(num(l.discountAmt))
    if (discountPct < 0 || discountPct > 100 || discountAmt < 0) throw new AppError(`Line ${i + 1}: invalid discount.`, 'VALIDATION')
    if (round2(qty * rate) + EPS < discountAmt) throw new AppError(`Line ${i + 1}: discount is more than the line amount.`, 'VALIDATION')
    const taxRate = round2(num(l.taxRate))
    if (taxRate < 0 || taxRate > 100) throw new AppError(`Line ${i + 1}: tax rate must be 0–100.`, 'VALIDATION')
    if (meta.side === 'sales' && !allowBelowMin) {
      if (discountPct > 0 || discountAmt > 0) {
        throw new AppError('You do not have permission to give discounts.', 'FORBIDDEN')
      }
      if (product && product.sale_price > 0 && rate + EPS < product.sale_price && input.docType !== 'sale_return') {
        throw new AppError(`Line ${i + 1}: you cannot sell "${product.name}" below its sale price.`, 'FORBIDDEN')
      }
    }
    return {
      productId,
      description,
      details: optMultiline(l.details, 4000),
      unit: optText(l.unit, 20) ?? product?.unit ?? null,
      qty,
      rate,
      discountPct,
      discountAmt,
      taxRate,
      taxAmt: 0,
      net: 0,
      lineTotal: 0,
      serials: parseSerials(l.serials),
      batchNo: optText(l.batchNo, 60),
      warranty: optText(l.warranty, 200),
      refLineId: optId(l.refLineId),
      product
    }
  })
  const docDiscount = num(input.docDiscount)
  if (docDiscount > 0 && meta.side === 'sales' && !allowBelowMin) throw new AppError('You do not have permission to give discounts.', 'FORBIDDEN')
  const { lines: c, totals } = computeTotals(lines, docDiscount, num(input.otherCharges), num(input.roundOff))
  lines.forEach((l, i) => {
    l.discountAmt = c[i].discount
    l.net = c[i].net
    l.taxAmt = c[i].tax
    l.lineTotal = c[i].total
  })
  if (totals.grandTotal < 0) throw new AppError('Document total cannot be negative.', 'VALIDATION')
  return { lines, totals }
}

export interface DocRow {
  id: number
  firm_id: number
  doc_type: DocType
  number: string
  date: string
  party_id: number | null
  project_id: number | null
  warehouse_id: number | null
  status: string
  deduct_stock: number
  direct_to_project: number
  grand_total: number
  net_total: number
  ref_doc_id: number | null
  doc_discount: number
  other_charges: number
  tax_total: number
}

function getDocRow(ctx: Ctx, id: number): DocRow {
  const d = ctx.db.prepare('SELECT * FROM documents WHERE id = ? AND firm_id = ?').get(id, ctx.firmId) as DocRow | undefined
  if (!d) throw new AppError('Document not found in the active firm.', 'NOT_FOUND')
  return d
}

function defaultStatus(type: DocType): string {
  if (type === 'quotation') return 'draft'
  if (type === 'sale_order' || type === 'purchase_order') return 'open'
  return 'final'
}

const QUOTATION_STATUSES = ['draft', 'sent', 'accepted', 'rejected', 'converted']

/** Posts stock & serial effects for a saved document. Lines must already be inserted. */
export function postStock(ctx: Ctx, doc: DocRow): void {
  const db = ctx.db
  const meta = DOC_TYPES[doc.doc_type]
  if (meta.stock === 0 || doc.status === 'cancelled') return
  if ((doc.doc_type === 'sale_invoice' || doc.doc_type === 'sale_return') && !doc.deduct_stock) return
  if (doc.doc_type === 'purchase_invoice' && doc.direct_to_project) return
  if (doc.doc_type === 'purchase_return' && doc.direct_to_project) {
    // Goods bought directly for a project site and returned to the supplier: no stock effect,
    // the original landed cost is reversed out of the project.
    db.prepare(
      `UPDATE document_lines SET unit_cost = COALESCE((SELECT o.unit_cost FROM document_lines o WHERE o.id = document_lines.ref_line_id), 0),
         cost_total = ROUND(qty * COALESCE((SELECT o.unit_cost FROM document_lines o WHERE o.id = document_lines.ref_line_id), 0), 2)
       WHERE document_id = ?`
    ).run(doc.id)
    const c = db.prepare('SELECT COALESCE(SUM(cost_total),0) AS c FROM document_lines WHERE document_id = ?').get(doc.id) as { c: number }
    db.prepare('UPDATE documents SET cost_total = ? WHERE id = ?').run(round2(c.c), doc.id)
    return
  }
  const whId = doc.warehouse_id!
  const lines = db.prepare('SELECT * FROM document_lines WHERE document_id = ? ORDER BY line_no').all(doc.id) as Array<{
    id: number
    product_id: number | null
    qty: number
    unit_cost: number
    serials: string | null
    batch_no: string | null
    ref_line_id: number | null
  }>
  const base = { firmId: doc.firm_id, warehouseId: whId, date: doc.date, refType: doc.doc_type, refId: doc.id, refNumber: doc.number, projectId: doc.project_id, userId: ctx.user.id }
  for (const l of lines) {
    if (!l.product_id) continue
    const p = getProductRow(db, l.product_id)
    if (p.type === 'service') continue
    const serials = parseSerials(l.serials)
    const m = { ...base, productId: l.product_id, qty: l.qty, refLineId: l.id, batchNo: l.batch_no }
    if (doc.doc_type === 'sale_invoice') {
      const cost = stockOut(db, m)
      db.prepare('UPDATE document_lines SET unit_cost = ?, cost_total = ? WHERE id = ?').run(cost, round2(cost * l.qty), l.id)
      if (serials.length) serialsOut(db, p.id, serials, { refType: doc.doc_type, refId: doc.id, status: 'sold', partyId: doc.party_id, projectId: doc.project_id, date: doc.date, strict: !!p.track_serial })
    } else if (doc.doc_type === 'sale_return') {
      let cost = p.avg_cost
      if (l.ref_line_id) {
        const orig = db.prepare('SELECT unit_cost FROM document_lines WHERE id = ?').get(l.ref_line_id) as { unit_cost: number } | undefined
        if (orig) cost = orig.unit_cost
      }
      stockIn(db, { ...m, unitCost: cost })
      db.prepare('UPDATE document_lines SET unit_cost = ?, cost_total = ? WHERE id = ?').run(round4(cost), round2(cost * l.qty), l.id)
      if (serials.length) serialsIn(db, p.id, serials, { warehouseId: whId, refType: doc.doc_type, refId: doc.id, isReturn: true })
    } else if (doc.doc_type === 'purchase_invoice') {
      stockIn(db, { ...m, unitCost: l.unit_cost })
      if (serials.length) serialsIn(db, p.id, serials, { warehouseId: whId, refType: doc.doc_type, refId: doc.id })
    } else if (doc.doc_type === 'purchase_return') {
      let cost: number | undefined
      if (l.ref_line_id) {
        const orig = db.prepare('SELECT unit_cost FROM document_lines WHERE id = ?').get(l.ref_line_id) as { unit_cost: number } | undefined
        cost = orig?.unit_cost
      }
      const used = stockOut(db, { ...m, unitCost: cost }, { removeCost: cost !== undefined })
      db.prepare('UPDATE document_lines SET unit_cost = ?, cost_total = ? WHERE id = ?').run(used, round2(used * l.qty), l.id)
      if (serials.length) serialsOut(db, p.id, serials, { refType: doc.doc_type, refId: doc.id, status: 'returned', partyId: doc.party_id, date: doc.date, strict: !!p.track_serial })
    }
  }
  const cost = db.prepare('SELECT COALESCE(SUM(cost_total),0) AS c FROM document_lines WHERE document_id = ?').get(doc.id) as { c: number }
  db.prepare('UPDATE documents SET cost_total = ? WHERE id = ?').run(round2(cost.c), doc.id)
}

/** Keeps documents.cost_total equal to the sum of its line costs (used by P&L and project reports). */
export function refreshDocCost(ctx: Ctx, docId: number): void {
  ctx.db
    .prepare('UPDATE documents SET cost_total = ROUND((SELECT COALESCE(SUM(cost_total),0) FROM document_lines WHERE document_id = ?), 2) WHERE id = ?')
    .run(docId, docId)
}

function unpostStock(ctx: Ctx, doc: DocRow): void {
  reverseSerials(ctx.db, doc.doc_type, doc.id)
  reverseMovements(ctx.db, doc.doc_type, doc.id, ctx.user.id, doc.date)
}

/** Validates return quantities against the referenced invoice. */
function validateReturn(ctx: Ctx, input: DocInput, lines: ComputedLine[], excludeDocId?: number): void {
  if (input.docType !== 'sale_return' && input.docType !== 'purchase_return') return
  const refId = optId(input.refDocId)
  if (!refId) return
  const orig = getDocRow(ctx, refId)
  const expected = input.docType === 'sale_return' ? 'sale_invoice' : 'purchase_invoice'
  if (orig.doc_type !== expected || orig.status === 'cancelled') throw new AppError('The referenced invoice is not valid for this return.', 'VALIDATION')
  if (orig.party_id !== optId(input.partyId)) throw new AppError('The return must be for the same party as the original invoice.', 'VALIDATION')
  for (const l of lines) {
    if (!l.refLineId) continue
    const ol = ctx.db.prepare('SELECT * FROM document_lines WHERE id = ? AND document_id = ?').get(l.refLineId, refId) as
      | { qty: number; description: string; product_id: number | null }
      | undefined
    if (!ol) throw new AppError(`"${l.description}" is not on the original invoice.`, 'VALIDATION')
    if (ol.product_id !== l.productId) throw new AppError(`"${l.description}" does not match the original invoice line.`, 'VALIDATION')
    const already = ctx.db
      .prepare(
        `SELECT COALESCE(SUM(dl.qty),0) AS q FROM document_lines dl JOIN documents d ON d.id = dl.document_id
         WHERE dl.ref_line_id = ? AND d.status <> 'cancelled' AND d.id <> ?`
      )
      .get(l.refLineId, excludeDocId ?? 0) as { q: number }
    const remaining = round3(ol.qty - already.q)
    if (l.qty > remaining + EPS) {
      throw new AppError(`Cannot return ${l.qty} of "${l.description}". Only ${remaining} remain returnable.`, 'VALIDATION')
    }
  }
}

function landedCosts(ctx: Ctx, lines: ComputedLine[], totals: ComputedTotals): number[] {
  // Purchase landed cost per unit: net after line & document discount + share of other charges (+ tax if not recoverable).
  const taxIsCost = getSetting(ctx.db, 'purchase_tax_is_cost', false)
  const netSum = lines.reduce((a, l) => a + l.net, 0)
  const factor = netSum > 0 ? (netSum - totals.docDiscount) / netSum : 1
  const goodsNet = lines.reduce((a, l) => a + (l.product && l.product.type === 'goods' ? l.net : 0), 0)
  return lines.map((l) => {
    let total = l.net * factor + (taxIsCost ? l.taxAmt * factor : 0)
    if (totals.otherCharges && (goodsNet > 0 ? l.product?.type === 'goods' : netSum > 0)) {
      const base = goodsNet > 0 ? goodsNet : netSum
      total += (totals.otherCharges * l.net) / base
    }
    return l.qty > 0 ? round4(total / l.qty) : 0
  })
}

function insertLines(ctx: Ctx, docId: number, input: DocInput, lines: ComputedLine[], totals: ComputedTotals): void {
  const meta = DOC_TYPES[input.docType]
  const isPurchaseCost = input.docType === 'purchase_invoice' || input.docType === 'purchase_order'
  const costs = isPurchaseCost ? landedCosts(ctx, lines, totals) : lines.map(() => 0)
  const ins = ctx.db.prepare(
    `INSERT INTO document_lines (document_id, line_no, product_id, description, details, unit, qty, rate, discount_pct, discount_amt, tax_rate,
       tax_amt, net_amount, line_total, unit_cost, cost_total, serials, batch_no, warranty, ref_line_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
  lines.forEach((l, i) => {
    const stockAffecting =
      meta.stock !== 0 &&
      !((input.docType === 'sale_invoice' || input.docType === 'sale_return') && input.deductStock === false) &&
      !((input.docType === 'purchase_invoice' || input.docType === 'purchase_return') && input.directToProject)
    if (l.product && stockAffecting) checkSerialCount(l.product, l.qty, l.serials)
    let warranty = l.warranty
    if (!warranty && l.product?.warranty_months && meta.side === 'sales') {
      const m = l.product.warranty_months
      warranty = m % 12 === 0 ? `${m / 12} Year${m === 12 ? '' : 's'}` : `${m} Month${m === 1 ? '' : 's'}`
    }
    ins.run(
      docId,
      i + 1,
      l.productId,
      l.description,
      l.details,
      l.unit,
      l.qty,
      l.rate,
      l.discountPct,
      l.discountAmt,
      l.taxRate,
      l.taxAmt,
      l.net,
      l.lineTotal,
      costs[i],
      round2(costs[i] * l.qty),
      l.serials.join(', ') || null,
      l.batchNo,
      warranty,
      l.refLineId
    )
  })
}

function headerValues(ctx: Ctx, input: DocInput, totals: ComputedTotals): Record<string, unknown> {
  const meta = DOC_TYPES[input.docType]
  const db = ctx.db
  const date = requireDate(input.date)
  const partyId = optId(input.partyId)
  let partyName = optText(input.partyName, 150)
  let partyPhone = optText(input.partyPhone, 40)
  let partyAddress = optText(input.partyAddress, 500)
  if (partyId) {
    const p = db.prepare(`SELECT * FROM parties p WHERE id = @id AND ${visibleTo('p')}`).get({ id: partyId, firmId: ctx.firmId }) as
      | { name: string; phone: string | null; address: string | null; type: string; is_active: number }
      | undefined
    if (!p) throw new AppError('Customer/supplier is not available in this firm.', 'VALIDATION')
    if (meta.partyType === 'customer' && p.type === 'supplier') throw new AppError(`${p.name} is a supplier, not a customer.`, 'VALIDATION')
    if (meta.partyType === 'supplier' && p.type === 'customer') throw new AppError(`${p.name} is a customer, not a supplier.`, 'VALIDATION')
    partyName = partyName || p.name
    partyPhone = partyPhone || p.phone
    partyAddress = partyAddress || p.address
  } else {
    if (meta.side === 'purchase' && meta.financial) throw new AppError('Select a supplier.', 'VALIDATION')
    if (input.docType === 'sale_return') throw new AppError('Select the customer for this return.', 'VALIDATION')
    if (!partyName) partyName = meta.side === 'sales' ? 'Walk-in Customer' : null
  }
  const projectId = optId(input.projectId)
  if (projectId) {
    const pr = db.prepare('SELECT id, customer_id, status, name FROM projects WHERE id = ? AND firm_id = ?').get(projectId, ctx.firmId) as
      | { customer_id: number | null; status: string; name: string }
      | undefined
    if (!pr) throw new AppError('Project does not belong to the active firm.', 'VALIDATION')
    if (meta.side === 'sales' && pr.customer_id && partyId && pr.customer_id !== partyId) {
      throw new AppError(`Project "${pr.name}" belongs to a different customer.`, 'VALIDATION')
    }
  }
  if (input.directToProject && !projectId) throw new AppError('Select the project for a direct-to-site purchase.', 'VALIDATION')
  let warehouseId = optId(input.warehouseId)
  const needsWarehouse = meta.stock !== 0
  if (needsWarehouse) {
    warehouseId = warehouseId ?? defaultWarehouseId(ctx)
    assertWarehouseVisible(ctx, warehouseId)
  }
  let status = input.status && input.docType === 'quotation' && QUOTATION_STATUSES.includes(input.status) ? input.status : defaultStatus(input.docType)
  if (input.docType === 'quotation' && status === 'converted') status = 'accepted'
  return {
    firm_id: ctx.firmId,
    doc_type: input.docType,
    date,
    due_date: optText(input.dueDate, 10),
    valid_until: optText(input.validUntil, 10),
    party_id: partyId,
    party_name: partyName,
    party_phone: partyPhone,
    party_address: partyAddress,
    project_id: projectId,
    warehouse_id: warehouseId,
    status,
    is_tax_invoice: input.isTaxInvoice ? 1 : 0,
    deduct_stock: (input.docType === 'sale_invoice' || input.docType === 'sale_return') && input.deductStock === false ? 0 : 1,
    direct_to_project: (input.docType === 'purchase_invoice' || input.docType === 'purchase_return') && input.directToProject ? 1 : 0,
    subtotal: totals.subtotal,
    line_discount_total: totals.lineDiscountTotal,
    doc_discount: totals.docDiscount,
    tax_total: totals.taxTotal,
    other_charges: totals.otherCharges,
    other_charges_label: optText(input.otherChargesLabel, 60),
    round_off: totals.roundOff,
    net_total: totals.netTotal,
    grand_total: totals.grandTotal,
    ref_doc_id: optId(input.refDocId),
    party_ref: optText(input.partyRef, 80),
    notes: optText(input.notes, 3000),
    terms: optText(input.terms, 5000)
  }
}

function markSourceConverted(ctx: Ctx, refDocId: number | null, targetType: DocType): void {
  if (!refDocId) return
  const src = ctx.db.prepare('SELECT doc_type, status FROM documents WHERE id = ? AND firm_id = ?').get(refDocId, ctx.firmId) as
    | { doc_type: DocType; status: string }
    | undefined
  if (!src) return
  if (['quotation', 'sale_order', 'purchase_order', 'delivery_challan'].includes(src.doc_type) && src.doc_type !== targetType) {
    ctx.db.prepare("UPDATE documents SET status = 'converted' WHERE id = ?").run(refDocId)
  }
}

function handlePaymentAtBilling(ctx: Ctx, docId: number, input: DocInput): void {
  const meta = DOC_TYPES[input.docType]
  if (!meta.financial) return
  const d = getDocRow(ctx, docId)
  if (input.applyAdvance && d.party_id) applyAdvances(ctx, docId)
  const amt = round2(num(input.payment?.amount))
  if (amt > 0) {
    const due = docDue(ctx.db, docId)
    if (amt > due + EPS) throw new AppError(`Amount paid (${amt}) is more than the document balance (${due}).`, 'VALIDATION')
    requirePerm(ctx, 'accounts.manage')
    const direction = input.docType === 'sale_invoice' || input.docType === 'purchase_return' ? 'in' : 'out'
    insertPayment(ctx, {
      date: d.date,
      direction,
      partyId: d.party_id,
      accountId: input.payment!.accountId,
      amount: amt,
      method: input.payment!.method,
      reference: input.payment!.reference,
      projectId: d.project_id,
      notes: `Against ${d.number}`,
      allocations: [{ documentId: docId, amount: amt }]
    })
  }
  if (input.docType === 'sale_invoice' && !d.party_id && docDue(ctx.db, docId) > EPS) {
    throw new AppError('Walk-in sales must be fully paid. Select a customer to sell on credit.', 'VALIDATION')
  }
}

/** Returns inherit stock behaviour from the invoice they reverse. */
function inheritReturnFlags(ctx: Ctx, input: DocInput): DocInput {
  if (input.docType !== 'sale_return' && input.docType !== 'purchase_return') return input
  const refId = optId(input.refDocId)
  if (!refId) return { ...input, deductStock: true, directToProject: false }
  const ref = ctx.db.prepare('SELECT deduct_stock, direct_to_project, project_id FROM documents WHERE id = ? AND firm_id = ?').get(refId, ctx.firmId) as
    | { deduct_stock: number; direct_to_project: number; project_id: number | null }
    | undefined
  if (!ref) return input
  return {
    ...input,
    deductStock: input.docType === 'sale_return' ? !!ref.deduct_stock : true,
    directToProject: input.docType === 'purchase_return' ? !!ref.direct_to_project : false,
    projectId: input.projectId ?? ref.project_id
  }
}

export function createDocument(ctx: Ctx, rawInput: DocInput): number {
  if (!rawInput || !DOC_TYPES[rawInput.docType]) throw new AppError('Unknown document type.', 'VALIDATION')
  assertCanCreate(ctx, rawInput.docType)
  assertOpenFor(ctx, rawInput.docType, requireDate(rawInput.date))
  const input = inheritReturnFlags(ctx, rawInput)
  const db = ctx.db
  return db.transaction(() => {
    const { lines, totals } = validateAndCompute(ctx, input)
    validateReturn(ctx, input, lines)
    const h = headerValues(ctx, input, totals)
    const number = nextNumber(db, ctx.firmId, input.docType)
    const cols = Object.keys(h)
    const id = Number(
      db
        .prepare(
          `INSERT INTO documents (${cols.join(', ')}, number, created_by) VALUES (${cols.map((c) => '@' + c).join(', ')}, @number, @created_by)`
        )
        .run({ ...h, number, created_by: ctx.user.id }).lastInsertRowid
    )
    insertLines(ctx, id, input, lines, totals)
    postStock(ctx, getDocRow(ctx, id))
    refreshDocCost(ctx, id)
    markSourceConverted(ctx, optId(input.refDocId), input.docType)
    handlePaymentAtBilling(ctx, id, input)
    audit(ctx, 'create', input.docType, id, `${DOC_TYPES[input.docType].label} ${number} - ${totals.grandTotal}`, {
      party: h.party_name,
      project: h.project_id,
      total: totals.grandTotal
    })
    return id
  })()
}

export function updateDocument(ctx: Ctx, rawInput: DocInput): number {
  if (!rawInput?.id) throw new AppError('Document id missing.', 'VALIDATION')
  const db = ctx.db
  const before = getDocRow(ctx, rawInput.id)
  const input = inheritReturnFlags(ctx, { ...rawInput, refDocId: rawInput.refDocId ?? before.ref_doc_id })
  if (before.doc_type !== input.docType) throw new AppError('Document type cannot be changed.', 'VALIDATION')
  if (before.status === 'cancelled') throw new AppError('Cancelled documents cannot be edited.', 'VALIDATION')
  // A converted quotation may still be corrected: it is a separate document, the sale created from it keeps its own lines.
  if (before.status === 'converted' && before.doc_type !== 'quotation') throw new AppError('This document has already been converted and cannot be edited.', 'VALIDATION')
  assertCanEdit(ctx, before.doc_type, before.id, 'edit')
  assertOpenFor(ctx, before.doc_type, before.date)
  assertOpenFor(ctx, before.doc_type, requireDate(input.date))
  return db.transaction(() => {
    const snapshot = getDocument(ctx, before.id)
    unpostStock(ctx, before)
    const { lines, totals } = validateAndCompute(ctx, input)
    validateReturn(ctx, input, lines, before.id)
    const h = headerValues(ctx, { ...input, refDocId: input.refDocId ?? before.ref_doc_id }, totals)
    const allocated = docAllocated(db, before.id)
    const returned = ['sale_invoice', 'purchase_invoice'].includes(before.doc_type) ? docReturned(db, before.id) : 0
    if (totals.grandTotal + EPS < allocated + returned) {
      throw new AppError(
        `The new total (${totals.grandTotal}) is less than the amount already paid/returned (${round2(allocated + returned)}). Remove the payment allocation first.`,
        'VALIDATION'
      )
    }
    if (before.party_id && allocated > 0 && h.party_id !== before.party_id) {
      throw new AppError('Party cannot be changed on a document that has payments.', 'VALIDATION')
    }
    if (before.doc_type !== 'quotation' || before.status === 'converted') h.status = before.status
    const cols = Object.keys(h).filter((c) => !['firm_id', 'doc_type'].includes(c))
    db.prepare(
      `UPDATE documents SET ${cols.map((c) => `${c} = @${c}`).join(', ')}, updated_by = @uid, updated_at = datetime('now','localtime') WHERE id = @id`
    ).run({ ...h, uid: ctx.user.id, id: before.id })
    const refs = db
      .prepare(
        `SELECT 1 FROM document_lines dl JOIN documents d ON d.id = dl.document_id
         WHERE d.status <> 'cancelled' AND dl.ref_line_id IN (SELECT id FROM document_lines WHERE document_id = ?) LIMIT 1`
      )
      .get(before.id)
    if (refs) throw new AppError('This invoice has returns recorded against its items. Cancel the returns before editing.', 'VALIDATION')
    db.prepare('DELETE FROM document_lines WHERE document_id = ?').run(before.id)
    insertLines(ctx, before.id, input, lines, totals)
    postStock(ctx, getDocRow(ctx, before.id))
    refreshDocCost(ctx, before.id)
    handlePaymentAtBilling(ctx, before.id, { ...input, applyAdvance: input.applyAdvance })
    audit(ctx, 'update', before.doc_type, before.id, `Edited ${DOC_TYPES[before.doc_type].label} ${before.number}`, {
      before: { total: before.grand_total, lines: (snapshot as { lines: unknown[] }).lines },
      after: { total: totals.grandTotal, lines: input.lines }
    })
    return before.id
  })()
}

export function cancelDocument(ctx: Ctx, id: number, reason?: string): void {
  const db = ctx.db
  const d = getDocRow(ctx, id)
  if (d.status === 'cancelled') throw new AppError('Document is already cancelled.', 'VALIDATION')
  assertCanEdit(ctx, d.doc_type, d.id, 'cancel')
  assertOpenFor(ctx, d.doc_type, d.date)
  const returns = db
    .prepare("SELECT number FROM documents WHERE ref_doc_id = ? AND status <> 'cancelled' AND doc_type IN ('sale_return','purchase_return')")
    .all(id) as Array<{ number: string }>
  if (returns.length) throw new AppError(`Cancel the returns first: ${returns.map((r) => r.number).join(', ')}`, 'VALIDATION')
  db.transaction(() => {
    unpostStock(ctx, d)
    const allocs = db.prepare('SELECT * FROM payment_allocations WHERE document_id = ?').all(id)
    db.prepare('DELETE FROM payment_allocations WHERE document_id = ?').run(id)
    db.prepare(
      "UPDATE documents SET status = 'cancelled', cancelled_by = ?, cancelled_at = datetime('now','localtime'), cancel_reason = ? WHERE id = ?"
    ).run(ctx.user.id, optText(reason, 300), id)
    audit(ctx, 'cancel', d.doc_type, id, `Cancelled ${DOC_TYPES[d.doc_type].label} ${d.number}`, {
      reason,
      releasedAllocations: allocs
    })
  })()
}

export function setQuotationStatus(ctx: Ctx, id: number, status: string, reason?: string): void {
  requirePerm(ctx, 'quotations.manage')
  const d = getDocRow(ctx, id)
  if (d.doc_type !== 'quotation') throw new AppError('Not a quotation.', 'VALIDATION')
  if (!QUOTATION_STATUSES.includes(status) || status === 'converted') throw new AppError('Invalid status.', 'VALIDATION')
  if (d.status === 'cancelled') throw new AppError('A cancelled quotation cannot change status.', 'VALIDATION')
  if (d.status === 'converted') throw new AppError('This quotation was converted to a sale. Cancel it instead if it should no longer count.', 'VALIDATION')
  ctx.db.prepare('UPDATE documents SET status = ? WHERE id = ?').run(status, id)
  audit(ctx, 'status', 'quotation', id, `Quotation ${d.number} marked ${status}${status === 'rejected' && reason ? `. Reason: ${optText(reason, 300)}` : ''}`, { from: d.status, to: status, reason: optText(reason, 300) })
}

export function deleteDraft(ctx: Ctx, id: number): void {
  const d = getDocRow(ctx, id)
  if (!['quotation', 'sale_order', 'purchase_order', 'delivery_challan'].includes(d.doc_type)) {
    throw new AppError('Only quotations, orders and challans can be deleted. Cancel invoices instead.', 'VALIDATION')
  }
  const p = permPrefix(d.doc_type)
  requirePerm(ctx, p === 'quotations' ? 'quotations.manage' : `${p}.cancel`)
  const linked = ctx.db.prepare('SELECT number FROM documents WHERE ref_doc_id = ? LIMIT 1').get(id) as { number: string } | undefined
  if (linked) throw new AppError(`This document was converted to ${linked.number}; it cannot be deleted.`, 'VALIDATION')
  ctx.db.transaction(() => {
    ctx.db.prepare('UPDATE projects SET quotation_id = NULL WHERE quotation_id = ?').run(id)
    ctx.db.prepare('DELETE FROM document_lines WHERE document_id = ?').run(id)
    ctx.db.prepare('DELETE FROM documents WHERE id = ?').run(id)
  })()
  audit(ctx, 'delete', d.doc_type, id, `Deleted ${DOC_TYPES[d.doc_type].label} ${d.number}`)
}

const VOID_HINT = 'Cancel (void) it instead, or create a Return / credit note, so the books keep a record.'

/**
 * Why a document cannot be deleted permanently (null = it can). Invoices, bills and returns may be deleted only
 * by users with sales.delete / purchases.delete, when nothing is settled against them, nothing refers to them and
 * their date is in an open period. Stock reversal is checked when the delete runs (it rolls back on failure).
 */
export function deleteBlockReason(ctx: Ctx, id: number): string | null {
  return blockReason(ctx, getDocRow(ctx, id))?.message ?? null
}

function blockReason(ctx: Ctx, d: DocRow): { message: string; code: string } | null {
  const db = ctx.db
  const meta = DOC_TYPES[d.doc_type]
  const p = permPrefix(d.doc_type)
  if (!meta.financial) {
    if (!can(ctx, p === 'quotations' ? 'quotations.manage' : `${p}.cancel`)) {
      return { message: 'You do not have permission to delete this document.', code: 'FORBIDDEN' }
    }
    const linked = db.prepare('SELECT number FROM documents WHERE ref_doc_id = ? LIMIT 1').get(d.id) as { number: string } | undefined
    if (linked) return { message: `This document was converted to ${linked.number}; it cannot be deleted.`, code: 'VALIDATION' }
    return null
  }
  if (!can(ctx, `${p}.delete`)) {
    return {
      message: `You do not have permission to delete ${p === 'sales' ? 'sales' : 'purchase'} documents permanently. ${VOID_HINT}`,
      code: 'FORBIDDEN'
    }
  }
  const alloc = db
    .prepare(
      `SELECT p.number FROM payment_allocations a JOIN payments p ON p.id = a.payment_id WHERE a.document_id = ?
       ORDER BY p.id LIMIT 3`
    )
    .all(d.id) as Array<{ number: string }>
  // A paid purchase may be deleted: its payments are not lost, they become unallocated advance with the supplier (same as a cancel).
  if (alloc.length && d.doc_type !== 'purchase_invoice') {
    return {
      message: `${d.number} has payments allocated to it (${alloc.map((a) => a.number).join(', ')}), so it cannot be deleted. ${VOID_HINT}`,
      code: 'VALIDATION'
    }
  }
  const refs = db
    .prepare(
      `SELECT DISTINCT r.id, r.number, r.doc_type, r.status FROM documents r
       WHERE r.id <> @id AND (r.ref_doc_id = @id OR r.id IN (SELECT dl.document_id FROM document_lines dl
         WHERE dl.ref_line_id IN (SELECT id FROM document_lines WHERE document_id = @id)))
       ORDER BY r.id LIMIT 3`
    )
    .all({ id: d.id }) as Array<{ number: string; doc_type: DocType; status: string }>
  if (refs.length) {
    const list = refs.map((r) => `${DOC_TYPES[r.doc_type]?.label ?? 'Document'} ${r.number}${r.status === 'cancelled' ? ' (cancelled)' : ''}`).join(', ')
    return { message: `${d.number} is referenced by ${list}, so it cannot be deleted. ${VOID_HINT}`, code: 'VALIDATION' }
  }
  try {
    assertPeriodOpen(db, ctx.firmId, d.date)
  } catch (e) {
    return { message: (e as AppError).message, code: (e as AppError).code ?? 'PERIOD_CLOSED' }
  }
  return null
}

/** Source documents go back to their open status when the only document converted from them is deleted. */
function reopenSource(ctx: Ctx, d: DocRow): string | null {
  if (!d.ref_doc_id) return null
  const src = ctx.db.prepare('SELECT id, doc_type, status, number FROM documents WHERE id = ? AND firm_id = ?').get(d.ref_doc_id, ctx.firmId) as
    | { id: number; doc_type: DocType; status: string; number: string }
    | undefined
  if (!src || src.status !== 'converted') return null
  const other = ctx.db
    .prepare("SELECT 1 FROM documents WHERE ref_doc_id = ? AND id <> ? AND doc_type NOT IN ('sale_return','purchase_return') LIMIT 1")
    .get(src.id, d.id)
  if (other) return null
  const status = src.doc_type === 'quotation' ? 'accepted' : src.doc_type === 'delivery_challan' ? 'final' : 'open'
  ctx.db.prepare('UPDATE documents SET status = ? WHERE id = ?').run(status, src.id)
  return `${src.number} set back to ${status}`
}

/**
 * Permanently deletes a document. Quotations / orders / challans keep the draft rules (deleteDraft). Invoices, bills
 * and returns: stock and serials are reversed exactly like a cancel, then the lines and the document are removed, all
 * in one transaction, and the audit log keeps a full JSON snapshot of what was deleted.
 */
export function deleteDocument(ctx: Ctx, id: number): void {
  const d = getDocRow(ctx, id)
  if (!DOC_TYPES[d.doc_type].financial) return deleteDraft(ctx, id)
  const block = blockReason(ctx, d)
  if (block) throw new AppError(block.message, block.code)
  const db = ctx.db
  db.transaction(() => {
    const docRow = db.prepare('SELECT * FROM documents WHERE id = ?').get(id)
    const lineRows = db.prepare('SELECT * FROM document_lines WHERE document_id = ? ORDER BY line_no').all(id)
    if (d.status !== 'cancelled') unpostStock(ctx, d)
    const movements = db.prepare('SELECT * FROM stock_movements WHERE ref_type = ? AND ref_id = ? ORDER BY id').all(d.doc_type, id)
    // Payments that were settled against a deleted purchase stay as the supplier's advance; only the allocation goes.
    const releasedAllocations = db.prepare('SELECT * FROM payment_allocations WHERE document_id = ?').all(id)
    db.prepare('DELETE FROM payment_allocations WHERE document_id = ?').run(id)
    const reopened = reopenSource(ctx, d)
    db.prepare('DELETE FROM document_lines WHERE document_id = ?').run(id)
    db.prepare('DELETE FROM documents WHERE id = ?').run(id)
    audit(ctx, 'delete', d.doc_type, id, `Deleted ${DOC_TYPES[d.doc_type].label} ${d.number} permanently (${round2(d.grand_total)})`, {
      snapshot: { document: docRow, lines: lineRows },
      stockMovements: movements,
      releasedAllocations,
      sourceReopened: reopened
    })
  })()
}

/* ------------------------------ Queries ------------------------------ */

export function listDocuments(
  ctx: Ctx,
  f: { docType: DocType | DocType[]; from?: string; to?: string; partyId?: number; projectId?: number; q?: string; status?: string; payStatus?: 'paid' | 'unpaid' | 'partial'; limit?: number }
): unknown[] {
  const types = (Array.isArray(f.docType) ? f.docType : [f.docType]).filter((t) => t in DOC_TYPES)
  if (types.length === 0) throw new AppError('Unknown document type.', 'VALIDATION')
  for (const t of types) requirePerm(ctx, `${permPrefix(t)}.view`)
  const rows = ctx.db
    .prepare(
      `SELECT d.id, d.doc_type, d.number, d.date, d.due_date, d.valid_until, d.party_id, COALESCE(pa.name, d.party_name) AS party_name,
         pa.phone AS party_phone, d.project_id, pr.name AS project_name, pr.code AS project_code, d.status, d.grand_total, d.net_total,
         d.tax_total, d.cost_total, d.is_tax_invoice, d.party_ref, d.ref_doc_id, u.full_name AS created_by_name, d.created_at,
         COALESCE((SELECT SUM(a.amount) FROM payment_allocations a JOIN payments p ON p.id = a.payment_id
                   WHERE a.document_id = d.id AND p.status <> 'cancelled'), 0) AS paid,
         COALESCE((SELECT SUM(r.grand_total) FROM documents r WHERE r.ref_doc_id = d.id AND r.status <> 'cancelled'
                   AND r.doc_type IN ('sale_return','purchase_return')), 0) AS returned
       FROM documents d LEFT JOIN parties pa ON pa.id = d.party_id LEFT JOIN projects pr ON pr.id = d.project_id
       LEFT JOIN users u ON u.id = d.created_by
       WHERE d.firm_id = @firmId AND d.doc_type IN (${types.map((t) => `'${t}'`).join(',')})
         AND (@from IS NULL OR d.date >= @from) AND (@to IS NULL OR d.date <= @to)
         AND (@partyId IS NULL OR d.party_id = @partyId) AND (@projectId IS NULL OR d.project_id = @projectId)
         AND (@status IS NULL OR d.status = @status)
         AND (@q IS NULL OR d.number LIKE @q OR d.party_name LIKE @q OR pa.name LIKE @q OR d.party_ref LIKE @q OR pr.name LIKE @q)
       ORDER BY d.date DESC, d.id DESC LIMIT @limit`
    )
    .all({
      firmId: ctx.firmId,
      from: f.from ?? null,
      to: f.to ?? null,
      partyId: f.partyId ?? null,
      projectId: f.projectId ?? null,
      status: f.status ?? null,
      q: f.q ? `%${f.q}%` : null,
      limit: Math.min(f.limit ?? 1000, 10000)
    }) as Array<Record<string, number | string | null>>
  const showCost = can(ctx, 'reports.profit') || can(ctx, 'inventory.cost')
  const out = rows.map((r) => {
    const due = r.status === 'cancelled' ? 0 : round2(Number(r.grand_total) - Number(r.paid) - Number(r.returned))
    const pay_status = !DOC_TYPES[r.doc_type as DocType].financial
      ? null
      : r.status === 'cancelled'
        ? 'cancelled'
        : due <= EPS
          ? 'paid'
          : Number(r.paid) + Number(r.returned) > EPS
            ? 'partial'
            : 'unpaid'
    const isReturn = r.doc_type === 'sale_return' || r.doc_type === 'purchase_return'
    const finalDue = isReturn && r.status !== 'cancelled' ? Math.max(0, docDue(ctx.db, Number(r.id))) : Math.max(0, due)
    const status2 = isReturn && pay_status && pay_status !== 'cancelled' ? (finalDue <= EPS ? 'paid' : finalDue < Number(r.grand_total) - EPS ? 'partial' : 'unpaid') : pay_status
    return { ...r, due: finalDue, pay_status: status2, cost_total: showCost ? r.cost_total : null }
  })
  return f.payStatus ? out.filter((r) => r.pay_status === f.payStatus) : out
}

export function getDocument(ctx: Ctx, id: number): Record<string, unknown> {
  const d = ctx.db
    .prepare(
      `SELECT d.*, pa.name AS party_master_name, pa.phone AS party_master_phone, pa.address AS party_master_address, pa.city AS party_city,
         pa.ntn AS party_ntn, pa.strn AS party_strn, pa.cnic AS party_cnic, pa.email AS party_email,
         pr.name AS project_name, pr.code AS project_code, pr.capacity_kw AS project_capacity, pr.site_address AS project_site,
         w.name AS warehouse_name, u.full_name AS created_by_name, uu.full_name AS updated_by_name, rd.number AS ref_doc_number, rd.doc_type AS ref_doc_type,
         (SELECT c.number FROM documents c WHERE c.ref_doc_id = d.id AND c.doc_type NOT IN ('sale_return','purchase_return') ORDER BY c.id LIMIT 1) AS converted_to
       FROM documents d LEFT JOIN parties pa ON pa.id = d.party_id LEFT JOIN projects pr ON pr.id = d.project_id
       LEFT JOIN warehouses w ON w.id = d.warehouse_id LEFT JOIN users u ON u.id = d.created_by LEFT JOIN users uu ON uu.id = d.updated_by
       LEFT JOIN documents rd ON rd.id = d.ref_doc_id
       WHERE d.id = ? AND d.firm_id = ?`
    )
    .get(id, ctx.firmId) as (Record<string, unknown> & { doc_type: DocType }) | undefined
  if (!d) throw new AppError('Document not found in the active firm.', 'NOT_FOUND')
  requirePerm(ctx, `${permPrefix(d.doc_type)}.view`)
  const showCost = can(ctx, 'reports.profit') || can(ctx, 'inventory.cost')
  const lines = ctx.db
    .prepare(
      `SELECT l.*, p.name AS product_name, p.sku, p.type AS product_type, p.track_serial, p.brand, p.model,
         (SELECT COALESCE(SUM(rl.qty),0) FROM document_lines rl JOIN documents rd ON rd.id = rl.document_id
           WHERE rl.ref_line_id = l.id AND rd.status <> 'cancelled') AS returned_qty
       FROM document_lines l LEFT JOIN products p ON p.id = l.product_id WHERE l.document_id = ? ORDER BY l.line_no`
    )
    .all(id) as Array<Record<string, unknown>>
  if (!showCost) for (const l of lines) {
    l.unit_cost = null
    l.cost_total = null
  }
  const payments = ctx.db
    .prepare(
      `SELECT a.amount, p.id AS payment_id, p.number, p.date, p.method, p.reference, ac.name AS account_name, p.direction
       FROM payment_allocations a JOIN payments p ON p.id = a.payment_id JOIN accounts ac ON ac.id = p.account_id
       WHERE a.document_id = ? AND p.status <> 'cancelled' ORDER BY p.date, p.id`
    )
    .all(id)
  const returns = ctx.db
    .prepare(
      `SELECT id, number, date, grand_total, status FROM documents WHERE ref_doc_id = ? AND doc_type IN ('sale_return','purchase_return') ORDER BY date`
    )
    .all(id)
  const converted = ctx.db
    .prepare(`SELECT id, number, doc_type, date FROM documents WHERE ref_doc_id = ? AND doc_type NOT IN ('sale_return','purchase_return')`)
    .all(id)
  const paid = docAllocated(ctx.db, id)
  const returned = ['sale_invoice', 'purchase_invoice'].includes(d.doc_type) ? docReturned(ctx.db, id) : 0
  let previousBalance: number | null = null
  let currentBalance: number | null = null
  if (d.party_id && DOC_TYPES[d.doc_type].financial) {
    const all = partyBalance(ctx, Number(d.party_id))
    currentBalance = all
    const beforeDate = ctx.db
      .prepare('SELECT date(?, \'-1 day\') AS d')
      .get(d.date) as { d: string }
    previousBalance = partyBalance(ctx, Number(d.party_id), ctx.firmId, beforeDate.d)
  }
  return {
    ...d,
    cost_total: showCost ? d.cost_total : null,
    lines,
    payments,
    returns,
    converted,
    paid,
    returned,
    due: d.status === 'cancelled' ? 0 : Math.max(0, docDue(ctx.db, id)),
    locked: isLocked(ctx, id),
    previous_balance: previousBalance,
    current_balance: currentBalance,
    // Shown to the UI so the Delete button appears only when the delete would be accepted (re-checked on delete).
    delete_block: blockReason(ctx, d as unknown as DocRow)?.message ?? null
  }
}

/** Builds a pre-filled input for converting a document into another type (opened in the editor). */
export function prepareConversion(ctx: Ctx, id: number, target: DocType): DocInput {
  const src = getDocument(ctx, id) as Record<string, unknown> & { doc_type: DocType; lines: Array<Record<string, unknown>> }
  const allowed: Record<string, DocType[]> = {
    quotation: ['sale_invoice', 'sale_order', 'delivery_challan'],
    sale_order: ['sale_invoice', 'delivery_challan'],
    delivery_challan: ['sale_invoice'],
    sale_invoice: ['sale_return', 'delivery_challan'],
    purchase_order: ['purchase_invoice'],
    purchase_invoice: ['purchase_return']
  }
  if (!allowed[src.doc_type]?.includes(target)) throw new AppError('This conversion is not supported.', 'VALIDATION')
  const isReturn = target === 'sale_return' || target === 'purchase_return'
  const lines: DocLineInput[] = src.lines
    .map((l) => ({
      productId: (l.product_id as number) ?? null,
      description: String(l.description),
      details: (l.details as string) ?? null,
      unit: (l.unit as string) ?? undefined,
      qty: isReturn ? round3(Number(l.qty) - Number(l.returned_qty || 0)) : Number(l.qty),
      rate: Number(l.rate),
      discountPct: Number(l.discount_pct),
      discountAmt: Number(l.discount_pct) > 0 ? 0 : Number(l.discount_amt),
      taxRate: Number(l.tax_rate),
      serials: isReturn ? '' : ((l.serials as string) ?? ''),
      warranty: (l.warranty as string) ?? undefined,
      refLineId: isReturn ? (l.id as number) : null
    }))
    .filter((l) => l.qty > 0)
  return {
    docType: target,
    date: new Date().toISOString().slice(0, 10),
    partyId: (src.party_id as number) ?? null,
    partyName: (src.party_name as string) ?? undefined,
    partyPhone: (src.party_phone as string) ?? undefined,
    partyAddress: (src.party_address as string) ?? undefined,
    projectId: (src.project_id as number) ?? null,
    warehouseId: (src.warehouse_id as number) ?? null,
    isTaxInvoice: !!src.is_tax_invoice,
    docDiscount: isReturn ? 0 : Number(src.doc_discount),
    otherCharges: isReturn ? 0 : Number(src.other_charges),
    otherChargesLabel: (src.other_charges_label as string) ?? undefined,
    refDocId: id,
    notes: (src.notes as string) ?? undefined,
    terms: isReturn ? undefined : ((src.terms as string) ?? undefined),
    lines
  }
}

/** Builds a pre-filled input for duplicating a document as a new one of the same type (opened in the editor). */
export function prepareCopy(ctx: Ctx, id: number): DocInput {
  const src = getDocument(ctx, id) as Record<string, unknown> & { doc_type: DocType; lines: Array<Record<string, unknown>> }
  if (src.doc_type === 'sale_return' || src.doc_type === 'purchase_return') {
    throw new AppError('Returns cannot be duplicated. Create a new return from the invoice instead.', 'VALIDATION')
  }
  assertCanCreate(ctx, src.doc_type)
  const lines: DocLineInput[] = src.lines.map((l) => ({
    productId: (l.product_id as number) ?? null,
    description: String(l.description),
    details: (l.details as string) ?? null,
    unit: (l.unit as string) ?? undefined,
    qty: Number(l.qty),
    rate: Number(l.rate),
    discountPct: Number(l.discount_pct),
    discountAmt: Number(l.discount_pct) > 0 ? 0 : Number(l.discount_amt),
    taxRate: Number(l.tax_rate),
    // Serial numbers identify single units that were already sold / received, so they are never copied.
    serials: '',
    warranty: (l.warranty as string) ?? undefined,
    refLineId: null
  }))
  return {
    docType: src.doc_type,
    date: new Date().toISOString().slice(0, 10),
    partyId: (src.party_id as number) ?? null,
    partyName: src.party_id ? undefined : ((src.party_name as string) ?? undefined),
    partyPhone: src.party_id ? undefined : ((src.party_phone as string) ?? undefined),
    partyAddress: src.party_id ? undefined : ((src.party_address as string) ?? undefined),
    projectId: (src.project_id as number) ?? null,
    warehouseId: (src.warehouse_id as number) ?? null,
    isTaxInvoice: !!src.is_tax_invoice,
    deductStock: src.deduct_stock === undefined ? true : !!src.deduct_stock,
    directToProject: !!src.direct_to_project,
    docDiscount: Number(src.doc_discount),
    otherCharges: Number(src.other_charges),
    otherChargesLabel: (src.other_charges_label as string) ?? undefined,
    roundOff: Number(src.round_off),
    notes: (src.notes as string) ?? undefined,
    terms: (src.terms as string) ?? undefined,
    lines
  }
}

/** Item descriptions of products, used to pre-fill the "Item description" of a document line. */
export function productDetails(ctx: Ctx, ids: unknown): Array<{ id: number; description: string | null; brand: string | null; model: string | null }> {
  const list = (Array.isArray(ids) ? ids : [ids]).map((x) => optId(x)).filter((x): x is number => !!x).slice(0, 500)
  if (!list.length) return []
  return ctx.db
    .prepare(
      `SELECT p.id, p.description, p.brand, p.model FROM products p
       WHERE p.id IN (${list.map(() => '?').join(',')}) AND (p.firm_id IS NULL OR p.firm_id = ?)`
    )
    .all(...list, ctx.firmId) as Array<{ id: number; description: string | null; brand: string | null; model: string | null }>
}
