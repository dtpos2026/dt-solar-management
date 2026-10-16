/**
 * Day / month closing (owner: data area). Shared helper: assertPeriodOpen is called by every service that
 * creates, edits, cancels or deletes a dated transaction, so closed periods stay unchanged.
 */
import type { DB } from '../db'
import { AppError, Ctx, audit, optText, requireDate, requirePerm, requireText } from './context'

/** Throws when `date` (YYYY-MM-DD) falls in a closed day or month of the firm. */
export function assertPeriodOpen(db: DB, firmId: number, date: string): void {
  const row = db
    .prepare(
      `SELECT kind, period_start, period_end FROM day_closings
       WHERE firm_id = ? AND status = 'closed' AND ? BETWEEN period_start AND period_end
       ORDER BY kind = 'month' DESC LIMIT 1`
    )
    .get(firmId, date) as { kind: string; period_start: string; period_end: string } | undefined
  if (row) {
    const what = row.kind === 'month' ? `month ${row.period_start.slice(0, 7)}` : `day ${row.period_start}`
    throw new AppError(`The ${what} is closed. Ask an authorised user to reopen it before changing transactions dated ${date}.`, 'PERIOD_CLOSED')
  }
}

/* ------------------------------------------------------------------ figures ------------------------------------------------------------------ */

const r2 = (n: number): number => Math.round((Number(n) || 0) * 100) / 100

export interface AccountFigure {
  accountId: number
  name: string
  type: string
  opening: number
  inflow: number
  outflow: number
  closing: number
}

export interface CashGroup {
  opening: number
  cashIn: number
  cashOut: number
  expected: number
}

export interface PeriodFigures {
  from: string
  to: string
  accounts: AccountFigure[]
  /** cash-type accounts */
  cash: CashGroup
  /** bank + wallet accounts */
  bank: CashGroup
  sales: number
  purchases: number
  saleReturns: number
  purchaseReturns: number
  returns: number
  expenses: number
  receipts: number
  payments: number
  counts: { sales: number; purchases: number; expenses: number; receipts: number; payments: number }
}

function prevDay(date: string): string {
  const d = new Date(date + 'T00:00:00Z')
  d.setUTCDate(d.getUTCDate() - 1)
  return d.toISOString().slice(0, 10)
}

export function monthBounds(month: string): { from: string; to: string } {
  if (!/^\d{4}-\d{2}$/.test(String(month))) throw new AppError('Month is invalid (use YYYY-MM).', 'VALIDATION')
  const [y, m] = month.split('-').map(Number)
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate()
  return { from: `${month}-01`, to: `${month}-${String(last).padStart(2, '0')}` }
}

/** All closing figures for a firm between two dates (inclusive), computed from the books. */
export function computeFigures(db: DB, firmId: number, from: string, to: string): PeriodFigures {
  const p = { firmId, from, to }
  const before = prevDay(from)
  const accounts = db.prepare('SELECT id, name, type, opening_balance FROM accounts WHERE firm_id = ? ORDER BY type, name').all(firmId) as Array<{
    id: number
    name: string
    type: string
    opening_balance: number
  }>
  const sum = (sql: string, args: Record<string, unknown>): number => (db.prepare(sql).get(args) as { v: number | null }).v ?? 0
  const flow = (id: number, a: string, b: string): { inflow: number; outflow: number } => {
    const q = { id, a, b }
    const inflow =
      sum(`SELECT SUM(amount) v FROM payments WHERE account_id=@id AND direction='in' AND status<>'cancelled' AND date BETWEEN @a AND @b`, q) +
      sum(`SELECT SUM(amount) v FROM account_transfers WHERE to_account_id=@id AND status<>'cancelled' AND date BETWEEN @a AND @b`, q)
    const outflow =
      sum(`SELECT SUM(amount) v FROM payments WHERE account_id=@id AND direction='out' AND status<>'cancelled' AND date BETWEEN @a AND @b`, q) +
      sum(`SELECT SUM(amount) v FROM expenses WHERE account_id=@id AND paid=1 AND status<>'cancelled' AND date BETWEEN @a AND @b`, q) +
      sum(`SELECT SUM(amount) v FROM account_transfers WHERE from_account_id=@id AND status<>'cancelled' AND date BETWEEN @a AND @b`, q)
    return { inflow: r2(inflow), outflow: r2(outflow) }
  }
  const figs: AccountFigure[] = accounts.map((a) => {
    const prior = flow(a.id, '0000-01-01', before)
    const opening = r2(a.opening_balance + prior.inflow - prior.outflow)
    const f = flow(a.id, from, to)
    return { accountId: a.id, name: a.name, type: a.type, opening, inflow: f.inflow, outflow: f.outflow, closing: r2(opening + f.inflow - f.outflow) }
  })
  const group = (cash: boolean): CashGroup => {
    const g = figs.filter((f) => (f.type === 'cash') === cash)
    const opening = r2(g.reduce((s, f) => s + f.opening, 0))
    const cashIn = r2(g.reduce((s, f) => s + f.inflow, 0))
    const cashOut = r2(g.reduce((s, f) => s + f.outflow, 0))
    return { opening, cashIn, cashOut, expected: r2(opening + cashIn - cashOut) }
  }
  const docSum = (type: string): { v: number; c: number } =>
    db
      .prepare(
        `SELECT COALESCE(SUM(grand_total),0) v, COUNT(*) c FROM documents WHERE firm_id=@firmId AND doc_type=@type
         AND status NOT IN ('cancelled','draft') AND date BETWEEN @from AND @to`
      )
      .get({ ...p, type }) as { v: number; c: number }
  const payAgg = (dir: string): { v: number; c: number } =>
    db
      .prepare(
        `SELECT COALESCE(SUM(amount),0) v, COUNT(*) c FROM payments WHERE firm_id=@firmId AND direction=@dir AND status<>'cancelled' AND date BETWEEN @from AND @to`
      )
      .get({ ...p, dir }) as { v: number; c: number }
  const exp = db
    .prepare(`SELECT COALESCE(SUM(amount),0) v, COUNT(*) c FROM expenses WHERE firm_id=@firmId AND status<>'cancelled' AND date BETWEEN @from AND @to`)
    .get(p) as { v: number; c: number }
  const sales = docSum('sale_invoice')
  const purchases = docSum('purchase_invoice')
  const sr = docSum('sale_return')
  const pr = docSum('purchase_return')
  const rin = payAgg('in')
  const rout = payAgg('out')
  return {
    from,
    to,
    accounts: figs,
    cash: group(true),
    bank: group(false),
    sales: r2(sales.v),
    purchases: r2(purchases.v),
    saleReturns: r2(sr.v),
    purchaseReturns: r2(pr.v),
    returns: r2(sr.v + pr.v),
    expenses: r2(exp.v),
    receipts: r2(rin.v),
    payments: r2(rout.v),
    counts: { sales: sales.c, purchases: purchases.c, expenses: exp.c, receipts: rin.c, payments: rout.c }
  }
}

/* ------------------------------------------------------------------ closing ------------------------------------------------------------------ */

export interface ClosingRow {
  id: number
  firm_id: number
  kind: 'day' | 'month'
  period_start: string
  period_end: string
  status: string
  [k: string]: unknown
}

function existing(db: DB, firmId: number, kind: string, start: string): ClosingRow | undefined {
  return db.prepare('SELECT * FROM day_closings WHERE firm_id = ? AND kind = ? AND period_start = ?').get(firmId, kind, start) as ClosingRow | undefined
}

export function previewDay(ctx: Ctx, date: string): { figures: PeriodFigures; closing: ClosingRow | null } {
  requirePerm(ctx, 'closing.manage')
  const d = requireDate(date)
  return { figures: computeFigures(ctx.db, ctx.firmId, d, d), closing: existing(ctx.db, ctx.firmId, 'day', d) ?? null }
}

export interface DayRow {
  date: string
  sales: number
  purchases: number
  returns: number
  expenses: number
  receipts: number
  payments: number
  cashIn: number
  cashOut: number
  closed: boolean
}

export interface MonthPreview {
  month: string
  figures: PeriodFigures
  days: DayRow[]
  closing: ClosingRow | null
}

function monthDays(db: DB, firmId: number, month: string): DayRow[] {
  const { from, to } = monthBounds(month)
  const closedDays = new Set(
    (
      db
        .prepare("SELECT period_start FROM day_closings WHERE firm_id = ? AND kind = 'day' AND status = 'closed' AND period_start BETWEEN ? AND ?")
        .all(firmId, from, to) as Array<{ period_start: string }>
    ).map((r) => r.period_start)
  )
  const days: DayRow[] = []
  const last = Number(to.slice(8))
  for (let i = 1; i <= last; i++) {
    const date = `${month}-${String(i).padStart(2, '0')}`
    const f = computeFigures(db, firmId, date, date)
    days.push({
      date,
      sales: f.sales,
      purchases: f.purchases,
      returns: f.returns,
      expenses: f.expenses,
      receipts: f.receipts,
      payments: f.payments,
      cashIn: f.cash.cashIn,
      cashOut: f.cash.cashOut,
      closed: closedDays.has(date)
    })
  }
  return days
}

export function previewMonth(ctx: Ctx, month: string): MonthPreview {
  requirePerm(ctx, 'closing.manage')
  const { from, to } = monthBounds(month)
  return {
    month,
    figures: computeFigures(ctx.db, ctx.firmId, from, to),
    days: monthDays(ctx.db, ctx.firmId, month),
    closing: existing(ctx.db, ctx.firmId, 'month', from) ?? null
  }
}

export interface CloseInput {
  kind: 'day' | 'month'
  /** YYYY-MM-DD for a day, YYYY-MM for a month */
  period: string
  countedCash?: number | string | null
  notes?: string
}

/** Closes a day or month. Re-closing a reopened period refreshes the stored figures. Returns the closing id. */
export function closePeriod(ctx: Ctx, input: CloseInput): number {
  requirePerm(ctx, 'closing.manage')
  const db = ctx.db
  const kind = input.kind === 'month' ? 'month' : 'day'
  const { from, to } = kind === 'month' ? monthBounds(String(input.period)) : { from: requireDate(input.period), to: String(input.period) }
  const prior = existing(db, ctx.firmId, kind, from)
  if (prior && prior.status === 'closed') throw new AppError(`This ${kind} is already closed.`, 'VALIDATION')
  const f = computeFigures(db, ctx.firmId, from, to)
  const raw = input.countedCash
  const counted = raw === null || raw === undefined || raw === '' ? null : r2(Number(raw))
  if (counted !== null && (!Number.isFinite(counted) || counted < 0)) throw new AppError('Counted cash must be zero or more.', 'VALIDATION')
  const difference = counted === null ? 0 : r2(counted - f.cash.expected)
  const summary = kind === 'month' ? { ...f, days: monthDays(db, ctx.firmId, String(input.period)) } : f
  const vals = {
    firm_id: ctx.firmId,
    kind,
    period_start: from,
    period_end: to,
    opening_cash: f.cash.opening,
    cash_in: f.cash.cashIn,
    cash_out: f.cash.cashOut,
    closing_cash: f.cash.expected,
    counted_cash: counted,
    difference,
    sales_total: f.sales,
    purchases_total: f.purchases,
    expenses_total: f.expenses,
    receipts_total: f.receipts,
    payments_total: f.payments,
    summary: JSON.stringify(summary),
    notes: optText(input.notes, 1000),
    uid: ctx.user.id
  }
  return db.transaction(() => {
    let id: number
    if (prior) {
      db.prepare(
        `UPDATE day_closings SET period_end=@period_end, opening_cash=@opening_cash, cash_in=@cash_in, cash_out=@cash_out, closing_cash=@closing_cash,
           counted_cash=@counted_cash, difference=@difference, sales_total=@sales_total, purchases_total=@purchases_total, expenses_total=@expenses_total,
           receipts_total=@receipts_total, payments_total=@payments_total, summary=@summary, notes=@notes, backup_file=NULL, status='closed',
           closed_by=@uid, closed_at=datetime('now','localtime') WHERE id=@id`
      ).run({ ...vals, id: prior.id })
      id = prior.id
    } else {
      id = Number(
        db
          .prepare(
            `INSERT INTO day_closings (firm_id, kind, period_start, period_end, opening_cash, cash_in, cash_out, closing_cash, counted_cash, difference,
               sales_total, purchases_total, expenses_total, receipts_total, payments_total, summary, notes, closed_by)
             VALUES (@firm_id, @kind, @period_start, @period_end, @opening_cash, @cash_in, @cash_out, @closing_cash, @counted_cash, @difference,
               @sales_total, @purchases_total, @expenses_total, @receipts_total, @payments_total, @summary, @notes, @uid)`
          )
          .run(vals).lastInsertRowid
      )
    }
    const label = kind === 'month' ? `month ${from.slice(0, 7)}` : `day ${from}`
    audit(ctx, 'close', 'day_closing', id, `Closed ${label}${counted !== null ? ` (counted ${counted}, difference ${difference})` : ''}`, {
      expected: f.cash.expected,
      counted,
      difference
    })
    return id
  })()
}

export function setClosingBackup(ctx: Ctx, id: number, file: string): void {
  ctx.db.prepare('UPDATE day_closings SET backup_file = ? WHERE id = ? AND firm_id = ?').run(file, id, ctx.firmId)
}

export function reopenPeriod(ctx: Ctx, id: number, reason: string): void {
  requirePerm(ctx, 'closing.reopen')
  const why = requireText(reason, 'Reason', 500)
  const row = ctx.db.prepare('SELECT * FROM day_closings WHERE id = ? AND firm_id = ?').get(id, ctx.firmId) as ClosingRow | undefined
  if (!row) throw new AppError('Closing not found.', 'NOT_FOUND')
  if (row.status !== 'closed') throw new AppError('This period is not closed.', 'VALIDATION')
  ctx.db
    .prepare("UPDATE day_closings SET status='reopened', reopened_by=?, reopened_at=datetime('now','localtime'), reopen_reason=? WHERE id=?")
    .run(ctx.user.id, why, id)
  audit(ctx, 'reopen', 'day_closing', id, `Reopened ${row.kind} ${row.kind === 'month' ? row.period_start.slice(0, 7) : row.period_start}: ${why}`)
}

export function listClosings(ctx: Ctx, f: { kind?: string; from?: string; to?: string } = {}): Array<Record<string, unknown>> {
  requirePerm(ctx, 'closing.manage')
  return ctx.db
    .prepare(
      `SELECT c.id, c.kind, c.period_start, c.period_end, c.opening_cash, c.cash_in, c.cash_out, c.closing_cash, c.counted_cash, c.difference,
              c.sales_total, c.purchases_total, c.expenses_total, c.receipts_total, c.payments_total, c.notes, c.backup_file, c.status,
              c.closed_at, c.reopened_at, c.reopen_reason, u.full_name AS closed_by_name, r.full_name AS reopened_by_name
         FROM day_closings c LEFT JOIN users u ON u.id = c.closed_by LEFT JOIN users r ON r.id = c.reopened_by
        WHERE c.firm_id = @firmId AND (@kind IS NULL OR c.kind = @kind) AND (@from IS NULL OR c.period_start >= @from) AND (@to IS NULL OR c.period_start <= @to)
        ORDER BY c.period_start DESC, c.kind LIMIT 1000`
    )
    .all({ firmId: ctx.firmId, kind: f.kind || null, from: f.from || null, to: f.to || null }) as Array<Record<string, unknown>>
}

export function getClosing(ctx: Ctx, id: number): Record<string, unknown> {
  requirePerm(ctx, 'closing.manage')
  const row = ctx.db.prepare('SELECT * FROM day_closings WHERE id = ? AND firm_id = ?').get(id, ctx.firmId) as Record<string, unknown> | undefined
  if (!row) throw new AppError('Closing not found.', 'NOT_FOUND')
  return { ...row, summary: JSON.parse(String(row.summary || '{}')) }
}

export const CLOSING_CSV_COLUMNS: Array<[string, string]> = [
  ['kind', 'Kind'],
  ['period_start', 'From'],
  ['period_end', 'To'],
  ['status', 'Status'],
  ['opening_cash', 'Opening cash'],
  ['cash_in', 'Cash in'],
  ['cash_out', 'Cash out'],
  ['closing_cash', 'Expected cash'],
  ['counted_cash', 'Counted cash'],
  ['difference', 'Difference'],
  ['sales_total', 'Sales'],
  ['purchases_total', 'Purchases'],
  ['expenses_total', 'Expenses'],
  ['receipts_total', 'Receipts'],
  ['payments_total', 'Payments'],
  ['closed_by_name', 'Closed by'],
  ['closed_at', 'Closed at'],
  ['reopen_reason', 'Reopen reason'],
  ['notes', 'Notes']
]
