/**
 * Point of sale: cash drawer shifts, counter checkout with split payment and change, held bills, shift reports.
 * A counter sale is an ordinary sales invoice (stock, accounts, party balance and reports all stay correct); the POS only adds
 * the shift it belongs to, what the customer handed over and the change given back.
 * The module is switched on in Settings, Simple / Customize ("POS and ERP modules"); when it is off every call here is refused.
 */
import type { DB } from '../db'
import { EPS, num, round2 } from '../../shared/money'
import { computeTotals } from '../../shared/totals'
import { autoRoundOff } from '../../shared/options'
import { POS_METHODS, moduleOn, posAccountFor, posOption } from '../../shared/modules'
import { AppError, Ctx, audit, can, getSetting, optId, optText, requirePerm, today } from './context'
import { assertAccount, docDue } from './payments'
import { createDocument } from './documents'

interface ShiftRow {
  id: number
  firm_id: number
  user_id: number
  opened_at: string
  opening_cash: number
  status: 'open' | 'closed'
  closed_at: string | null
  expected_cash: number | null
  counted_cash: number | null
  difference: number | null
  notes: string | null
}

export interface CartLine {
  productId?: number | null
  description?: string
  details?: string
  unit?: string
  qty: number
  rate: number
  discountPct?: number
  taxRate?: number
  serials?: string
}
export interface Tender {
  method: string
  amount: number
  accountId?: number | null
  reference?: string
}
export interface CheckoutInput {
  partyId?: number | null
  lines: CartLine[]
  docDiscount?: number
  tenders: Tender[]
  notes?: string
  holdId?: number | null
}

const settingsOf = (db: DB): { erp_modules: unknown; pos_settings: unknown } => ({ erp_modules: getSetting(db, 'erp_modules', {}), pos_settings: getSetting(db, 'pos_settings', {}) })

export function posEnabled(db: DB): boolean {
  return moduleOn(settingsOf(db), 'pos')
}

function assertPos(ctx: Ctx, perm = 'pos.use'): void {
  if (!posEnabled(ctx.db)) throw new AppError('The POS module is switched off. Switch it on in Settings, Simple / Customize.', 'VALIDATION')
  requirePerm(ctx, perm)
}

const openShiftOf = (ctx: Ctx): ShiftRow | undefined =>
  ctx.db.prepare("SELECT * FROM pos_shifts WHERE firm_id = ? AND user_id = ? AND status = 'open' ORDER BY id DESC LIMIT 1").get(ctx.firmId, ctx.user.id) as ShiftRow | undefined

/** Totals of one shift: what was sold, how it was paid, cash that should be in the drawer. */
export function shiftSummary(db: DB, shift: ShiftRow): Record<string, unknown> {
  const sales = db
    .prepare(
      `SELECT COUNT(*) AS n, COALESCE(SUM(d.grand_total), 0) AS total, COALESCE(SUM(d.line_discount_total + d.doc_discount), 0) AS discount,
              COALESCE(SUM(d.tax_total), 0) AS tax, COALESCE(SUM(d.round_off), 0) AS round_off
         FROM pos_sales s JOIN documents d ON d.id = s.document_id WHERE s.shift_id = ? AND d.status <> 'cancelled'`
    )
    .get(shift.id) as { n: number; total: number; discount: number; tax: number; round_off: number }
  const cancelled = db
    .prepare("SELECT COUNT(*) AS n, COALESCE(SUM(d.grand_total), 0) AS total FROM pos_sales s JOIN documents d ON d.id = s.document_id WHERE s.shift_id = ? AND d.status = 'cancelled'")
    .get(shift.id) as { n: number; total: number }
  const byMethod = db
    .prepare(
      `SELECT p.method AS method, ROUND(SUM(a.amount), 2) AS amount FROM payment_allocations a
         JOIN payments p ON p.id = a.payment_id JOIN pos_sales s ON s.document_id = a.document_id JOIN documents d ON d.id = s.document_id
        WHERE s.shift_id = ? AND d.status <> 'cancelled' AND p.status <> 'cancelled' GROUP BY p.method ORDER BY amount DESC`
    )
    .all(shift.id) as Array<{ method: string; amount: number }>
  const docs = db.prepare("SELECT s.document_id AS id FROM pos_sales s JOIN documents d ON d.id = s.document_id WHERE s.shift_id = ? AND d.status <> 'cancelled'").all(shift.id) as Array<{ id: number }>
  const credit = round2(docs.reduce((a, d) => a + Math.max(0, docDue(db, d.id)), 0))
  const items = db
    .prepare("SELECT COALESCE(SUM(l.qty), 0) AS qty FROM pos_sales s JOIN documents d ON d.id = s.document_id JOIN document_lines l ON l.document_id = d.id WHERE s.shift_id = ? AND d.status <> 'cancelled'")
    .get(shift.id) as { qty: number }
  const cashIn = (db.prepare('SELECT COALESCE(SUM(cash_in), 0) AS c FROM pos_sales WHERE shift_id = ?').get(shift.id) as { c: number }).c
  const moves = db.prepare("SELECT kind, COALESCE(SUM(amount), 0) AS amount FROM pos_cash_moves WHERE shift_id = ? GROUP BY kind").all(shift.id) as Array<{ kind: string; amount: number }>
  const movesIn = moves.find((m) => m.kind === 'in')?.amount ?? 0
  const movesOut = moves.find((m) => m.kind === 'out')?.amount ?? 0
  const expected = round2(shift.opening_cash + cashIn + movesIn - movesOut)
  const cashier = (db.prepare('SELECT full_name FROM users WHERE id = ?').get(shift.user_id) as { full_name: string } | undefined)?.full_name ?? ''
  return {
    shift,
    cashier,
    sales: { count: sales.n, total: round2(sales.total), discount: round2(sales.discount), tax: round2(sales.tax), roundOff: round2(sales.round_off), items: round2(items.qty) },
    cancelled: { count: cancelled.n, total: round2(cancelled.total) },
    byMethod,
    credit,
    cash: { opening: shift.opening_cash, sales: round2(cashIn), in: round2(movesIn), out: round2(movesOut), expected },
    moves: db.prepare('SELECT kind, amount, reason, at FROM pos_cash_moves WHERE shift_id = ? ORDER BY id').all(shift.id)
  }
}

/** The counter state: whether the module is on and the signed-in cashier's open shift. */
export function status(ctx: Ctx): Record<string, unknown> {
  const enabled = posEnabled(ctx.db)
  if (!enabled || !can(ctx, 'pos.use')) return { enabled, shift: null, holds: 0 }
  const shift = openShiftOf(ctx)
  const holds = (ctx.db.prepare('SELECT COUNT(*) AS c FROM pos_holds WHERE firm_id = ?').get(ctx.firmId) as { c: number }).c
  return { enabled, shift: shift ? shiftSummary(ctx.db, shift) : null, holds }
}

export function openShift(ctx: Ctx, input: { openingCash?: number }): number {
  assertPos(ctx, 'pos.shift')
  if (openShiftOf(ctx)) throw new AppError('You already have an open shift. Close it first.', 'VALIDATION')
  const opening = round2(num(input.openingCash))
  if (opening < 0) throw new AppError('Opening cash cannot be negative.', 'VALIDATION')
  const id = Number(ctx.db.prepare('INSERT INTO pos_shifts (firm_id, user_id, opening_cash) VALUES (?, ?, ?)').run(ctx.firmId, ctx.user.id, opening).lastInsertRowid)
  audit(ctx, 'create', 'pos_shift', id, `Opened POS shift with ${opening} in the drawer`)
  return id
}

export function cashMove(ctx: Ctx, input: { kind: string; amount: number; reason?: string }): void {
  assertPos(ctx, 'pos.shift')
  const shift = openShiftOf(ctx)
  if (!shift) throw new AppError('Open a shift first.', 'VALIDATION')
  const kind = input.kind === 'in' ? 'in' : input.kind === 'out' ? 'out' : ''
  if (!kind) throw new AppError('Cash in or cash out?', 'VALIDATION')
  const amount = round2(num(input.amount))
  if (amount <= 0) throw new AppError('Enter the amount.', 'VALIDATION')
  const reason = optText(input.reason, 200)
  if (kind === 'out' && !reason) throw new AppError('Write what the cash taken out is for.', 'VALIDATION')
  ctx.db.prepare('INSERT INTO pos_cash_moves (shift_id, kind, amount, reason, user_id) VALUES (?, ?, ?, ?, ?)').run(shift.id, kind, amount, reason, ctx.user.id)
  audit(ctx, 'create', 'pos_shift', shift.id, `Drawer cash ${kind} ${amount}${reason ? `: ${reason}` : ''}`)
}

export function closeShift(ctx: Ctx, input: { countedCash: number; notes?: string }): Record<string, unknown> {
  assertPos(ctx, 'pos.shift')
  const shift = openShiftOf(ctx)
  if (!shift) throw new AppError('There is no open shift.', 'VALIDATION')
  const counted = round2(num(input.countedCash))
  if (counted < 0) throw new AppError('Counted cash cannot be negative.', 'VALIDATION')
  const sum = shiftSummary(ctx.db, shift) as { cash: { expected: number } }
  const expected = sum.cash.expected
  const diff = round2(counted - expected)
  ctx.db
    .prepare("UPDATE pos_shifts SET status = 'closed', closed_at = datetime('now','localtime'), expected_cash = ?, counted_cash = ?, difference = ?, notes = ? WHERE id = ?")
    .run(expected, counted, diff, optText(input.notes, 500), shift.id)
  audit(ctx, 'update', 'pos_shift', shift.id, `Closed POS shift: expected ${expected}, counted ${counted}, difference ${diff}`)
  return shiftReport(ctx, shift.id)
}

/** One shift for the screen and the printed X / Z report. A cashier sees their own; pos.reports sees every shift. */
export function shiftReport(ctx: Ctx, id: number): Record<string, unknown> {
  assertPos(ctx)
  const shift = ctx.db.prepare('SELECT * FROM pos_shifts WHERE id = ? AND firm_id = ?').get(id, ctx.firmId) as ShiftRow | undefined
  if (!shift) throw new AppError('Shift not found.', 'NOT_FOUND')
  if (shift.user_id !== ctx.user.id) requirePerm(ctx, 'pos.reports')
  return shiftSummary(ctx.db, shift)
}

export function listShifts(ctx: Ctx, f: { limit?: number } = {}): unknown[] {
  assertPos(ctx, 'pos.shift')
  const all = can(ctx, 'pos.reports')
  return ctx.db
    .prepare(
      `SELECT s.*, u.full_name AS cashier,
              (SELECT COUNT(*) FROM pos_sales x JOIN documents d ON d.id = x.document_id WHERE x.shift_id = s.id AND d.status <> 'cancelled') AS sales_count,
              (SELECT COALESCE(SUM(d.grand_total), 0) FROM pos_sales x JOIN documents d ON d.id = x.document_id WHERE x.shift_id = s.id AND d.status <> 'cancelled') AS sales_total
         FROM pos_shifts s JOIN users u ON u.id = s.user_id
        WHERE s.firm_id = @firmId AND (@all = 1 OR s.user_id = @userId) ORDER BY s.id DESC LIMIT @limit`
    )
    .all({ firmId: ctx.firmId, all: all ? 1 : 0, userId: ctx.user.id, limit: Math.min(Math.max(1, Math.floor(num(f.limit, 50))), 500) })
}

/* ------------------------------------------------------------------ checkout */

/** The account that takes a payment method: the one chosen on the tender, then the one set in the POS settings, then by account type. */
function accountFor(ctx: Ctx, method: string, explicit?: number | null): number {
  if (explicit) return assertAccount(ctx, explicit)
  const mapped = posAccountFor(settingsOf(ctx.db), method)
  if (mapped) {
    const ok = ctx.db.prepare('SELECT 1 FROM accounts WHERE id = ? AND firm_id = ? AND is_active = 1').get(mapped, ctx.firmId)
    if (ok) return mapped
  }
  const pick = (types: string[]): number | null => {
    for (const t of types) {
      const r = ctx.db.prepare('SELECT id FROM accounts WHERE firm_id = ? AND is_active = 1 AND type = ? ORDER BY is_default DESC, id LIMIT 1').get(ctx.firmId, t) as { id: number } | undefined
      if (r) return r.id
    }
    return null
  }
  const id = method === 'cash' ? pick(['cash']) : method === 'online' ? pick(['wallet', 'bank', 'cash']) : pick(['bank', 'wallet', 'cash'])
  if (!id) throw new AppError('No cash or bank account is available to take this payment.', 'VALIDATION')
  return id
}

export function checkout(ctx: Ctx, input: CheckoutInput): Record<string, unknown> {
  assertPos(ctx)
  requirePerm(ctx, 'sales.create')
  const db = ctx.db
  const s = settingsOf(db)
  const shift = openShiftOf(ctx)
  if (posOption(s, 'require_shift') && !shift) throw new AppError('Open a shift before selling.', 'VALIDATION')
  const rawLines = (input.lines ?? []).filter((l) => l && (optId(l.productId) || String(l.description ?? '').trim()))
  if (rawLines.length === 0) throw new AppError('The cart is empty.', 'VALIDATION')
  const partyId = optId(input.partyId)

  const usesDiscount = num(input.docDiscount) > 0 || rawLines.some((l) => num(l.discountPct) > 0)
  if (usesDiscount) {
    if (!posOption(s, 'allow_discount')) throw new AppError('Discounts are switched off at the counter.', 'FORBIDDEN')
    requirePerm(ctx, 'sales.discount')
  }
  // Price: an item sells at its sale price unless the counter may change prices.
  const priceOk = posOption(s, 'allow_price_change') === true
  const lines = rawLines.map((l, i) => {
    const productId = optId(l.productId)
    const p = productId ? (db.prepare('SELECT id, name, unit, sale_price, tax_rate FROM products WHERE id = ?').get(productId) as { id: number; name: string; unit: string; sale_price: number; tax_rate: number } | undefined) : undefined
    if (productId && !p) throw new AppError(`Line ${i + 1}: item not found.`, 'VALIDATION')
    const qty = num(l.qty)
    const rate = num(l.rate)
    if (!(qty > 0)) throw new AppError(`Line ${i + 1}: quantity must be more than zero.`, 'VALIDATION')
    if (rate < 0) throw new AppError(`Line ${i + 1}: price cannot be negative.`, 'VALIDATION')
    if (!priceOk && (!p || Math.abs(rate - p.sale_price) > 0.005)) {
      throw new AppError(`Line ${i + 1}: the price of ${p?.name ?? 'this item'} cannot be changed at the counter.`, 'FORBIDDEN')
    }
    return {
      productId: p?.id ?? null,
      description: String(l.description ?? '').trim() || p?.name || 'Item',
      details: l.details,
      unit: l.unit || p?.unit,
      qty,
      rate,
      discountPct: num(l.discountPct),
      taxRate: l.taxRate === undefined ? (p?.tax_rate ?? 0) : num(l.taxRate),
      serials: l.serials
    }
  })

  const docDiscount = round2(num(input.docDiscount))
  const roundTo = String(posOption(s, 'round_to'))
  const pre = computeTotals(lines, docDiscount, 0, 0).totals.grandTotal
  const roundOff = roundTo === 'off' ? 0 : autoRoundOff(pre, 'nearest', Number(roundTo))
  const total = round2(pre + roundOff)
  if (!(total > 0)) throw new AppError('The bill total must be more than zero.', 'VALIDATION')

  // Tenders: card, bank and wallet cannot be more than what is left; cash takes the rest and gives change.
  const tenders = (input.tenders ?? [])
    .map((t) => ({ method: String(t.method), amount: round2(num(t.amount)), accountId: optId(t.accountId), reference: optText(t.reference, 100) ?? undefined }))
    .filter((t) => t.amount > 0)
  for (const t of tenders) if (!(POS_METHODS as readonly string[]).includes(t.method)) throw new AppError(`Unknown payment method: ${t.method}.`, 'VALIDATION')
  const ordered = [...tenders.filter((t) => t.method !== 'cash'), ...tenders.filter((t) => t.method === 'cash')]
  let remaining = total
  let cashApplied = 0
  const cashTendered = round2(tenders.filter((t) => t.method === 'cash').reduce((a, t) => a + t.amount, 0))
  const payments: Array<{ amount: number; accountId: number; method: string; reference?: string }> = []
  for (const t of ordered) {
    if (t.method !== 'cash' && t.amount > remaining + EPS) throw new AppError(`The ${t.method.replace('_', ' ')} amount is more than what is left to pay (${remaining}).`, 'VALIDATION')
    const use = round2(Math.min(t.amount, remaining))
    if (use <= 0) continue
    payments.push({ amount: use, accountId: accountFor(ctx, t.method, t.accountId), method: t.method, reference: t.reference })
    remaining = round2(remaining - use)
    if (t.method === 'cash') cashApplied = round2(cashApplied + use)
  }
  const tendered = round2(tenders.reduce((a, t) => a + t.amount, 0))
  const change = round2(Math.max(0, cashTendered - cashApplied))
  if (remaining > EPS) {
    if (!partyId) throw new AppError(`Walk-in sales must be paid in full: ${remaining} is still to pay. Select a customer to leave it on credit.`, 'VALIDATION')
    if (!posOption(s, 'allow_credit')) throw new AppError(`Credit sales are switched off at the counter: ${remaining} is still to pay.`, 'VALIDATION')
  }

  return db.transaction(() => {
    const id = createDocument(ctx, {
      docType: 'sale_invoice',
      date: today(),
      partyId,
      lines,
      docDiscount,
      roundOff,
      deductStock: true,
      notes: optText(input.notes, 500) ?? undefined,
      payments
    })
    db.prepare('INSERT INTO pos_sales (document_id, shift_id, cashier_id, tendered, change_given, cash_in) VALUES (?, ?, ?, ?, ?, ?)').run(id, shift?.id ?? null, ctx.user.id, tendered, change, cashApplied)
    const holdId = optId(input.holdId)
    if (holdId) db.prepare('DELETE FROM pos_holds WHERE id = ? AND firm_id = ?').run(holdId, ctx.firmId)
    const doc = db.prepare('SELECT number, grand_total FROM documents WHERE id = ?').get(id) as { number: string; grand_total: number }
    if (Math.abs(doc.grand_total - total) > 0.01) throw new AppError('The bill total changed while saving. Please try again.', 'VALIDATION')
    audit(ctx, 'create', 'pos_sale', id, `POS sale ${doc.number} of ${total}${change > 0 ? `, change ${change}` : ''}`)
    return { id, number: doc.number, total, paid: round2(total - remaining), change, due: remaining }
  })()
}

/* ------------------------------------------------------------------ held bills and recent sales */

export function holdCart(ctx: Ctx, input: { label?: string; cart: unknown; total?: number }): number {
  assertPos(ctx)
  const json = JSON.stringify(input.cart ?? null)
  if (!input.cart || json.length > 200000) throw new AppError('There is nothing to hold.', 'VALIDATION')
  const id = Number(
    ctx.db.prepare('INSERT INTO pos_holds (firm_id, user_id, label, cart, total) VALUES (?, ?, ?, ?, ?)').run(ctx.firmId, ctx.user.id, optText(input.label, 80), json, round2(num(input.total))).lastInsertRowid
  )
  audit(ctx, 'create', 'pos_hold', id, 'Held a POS bill')
  return id
}

export function listHolds(ctx: Ctx): unknown[] {
  assertPos(ctx)
  const rows = ctx.db
    .prepare('SELECT h.id, h.label, h.cart, h.total, h.created_at, u.full_name AS cashier FROM pos_holds h JOIN users u ON u.id = h.user_id WHERE h.firm_id = ? ORDER BY h.id DESC')
    .all(ctx.firmId) as Array<{ id: number; label: string | null; cart: string; total: number; created_at: string; cashier: string }>
  return rows.map((r) => ({ ...r, cart: JSON.parse(r.cart) }))
}

export function deleteHold(ctx: Ctx, id: number): void {
  assertPos(ctx)
  ctx.db.prepare('DELETE FROM pos_holds WHERE id = ? AND firm_id = ?').run(id, ctx.firmId)
}

/** The latest counter sales (a cashier sees their own, pos.reports sees all). */
export function recentSales(ctx: Ctx, f: { limit?: number } = {}): unknown[] {
  assertPos(ctx)
  const all = can(ctx, 'pos.reports')
  return ctx.db
    .prepare(
      `SELECT d.id, d.number, d.date, d.created_at, d.grand_total, d.status, COALESCE(pa.name, d.party_name, 'Walk-in') AS party_name,
              s.tendered, s.change_given, s.shift_id, u.full_name AS cashier
         FROM pos_sales s JOIN documents d ON d.id = s.document_id LEFT JOIN parties pa ON pa.id = d.party_id LEFT JOIN users u ON u.id = s.cashier_id
        WHERE d.firm_id = @firmId AND (@all = 1 OR s.cashier_id = @userId) ORDER BY d.id DESC LIMIT @limit`
    )
    .all({ firmId: ctx.firmId, all: all ? 1 : 0, userId: ctx.user.id, limit: Math.min(Math.max(1, Math.floor(num(f.limit, 30))), 200) })
}
