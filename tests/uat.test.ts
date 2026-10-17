/**
 * UAT with realistic trading data (two firms): totals are checked against hand-computed figures, then the whole database
 * goes through a JSON (.js1) backup and restore and every figure has to come back identical. Real services, real SQLite.
 */
import { describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createAdjustment, saveProduct } from '../src/main/services/inventory'
import { partyBalance, saveParty } from '../src/main/services/parties'
import { cancelDocument, createDocument, getDocument, prepareConversion, updateDocument } from '../src/main/services/documents'
import { accountBalance, createPayment, createTransfer, saveAccount } from '../src/main/services/payments'
import { createExpense } from '../src/main/services/expenses'
import { closePeriod, listClosings } from '../src/main/services/closing'
import { createFirm } from '../src/main/services/firms'
import { dashboard, plFigures, profitAndLoss } from '../src/main/services/reports'
import { buildSessionUser } from '../src/main/services/auth'
import { exportCsv } from '../src/main/services/csvExport'
import { analyzeImport, runImport } from '../src/main/services/importer'
import { buildDatabaseFromJs1, exportJs1, readJs1, summarizeJs1, tablesHash, writeJs1 } from '../src/main/backup-json'
import { openDatabase } from '../src/main/db'
import type { Ctx } from '../src/main/services/context'
import { cashAccount, qtyOf, setupCtx, warehouse } from './helpers'

const FROM = '2026-03-01'
const TO = '2026-03-31'

function business() {
  const ctx = setupCtx()
  const wh = warehouse(ctx)
  const cash = cashAccount(ctx)
  const bank = saveAccount(ctx, { name: 'Meezan Bank', type: 'bank', openingBalance: 500000 })
  const panel = saveProduct(ctx, { name: 'Jinko Tiger Neo 585W', brand: 'Jinko', salePrice: 30000 })
  createAdjustment(ctx, { date: '2026-01-01', warehouseId: wh, kind: 'opening', lines: [{ productId: panel, qty: 50, unitCost: 20000 }] })
  const cust = saveParty(ctx, { type: 'customer', name: 'Ali Traders', phone: '03001234567' })
  const sup = saveParty(ctx, { type: 'supplier', name: 'Solar Wholesale', phone: '042111222' })
  const overhead = (ctx.db.prepare("SELECT id FROM expense_categories WHERE cost_head = 'overhead' ORDER BY id LIMIT 1").get() as { id: number }).id

  // 20 panels @ 21,000 bought on credit, 120,000 paid from the bank on the day
  const purchase = createDocument(ctx, {
    docType: 'purchase_invoice',
    date: '2026-03-02',
    partyId: sup,
    warehouseId: wh,
    lines: [{ productId: panel, description: 'Panel', qty: 20, rate: 21000 }],
    payment: { amount: 120000, accountId: bank }
  })
  // quotation for 10 panels @ 30,000 -> converted to a sale, 100,000 received in cash
  const quote = createDocument(ctx, { docType: 'quotation', date: '2026-03-05', partyId: cust, lines: [{ productId: panel, description: 'Panel', qty: 10, rate: 30000 }] })
  const sale = createDocument(ctx, { ...prepareConversion(ctx, quote, 'sale_invoice'), date: '2026-03-06', warehouseId: wh, payment: { amount: 100000, accountId: cash } })
  createExpense(ctx, { date: '2026-03-07', categoryId: overhead, amount: 15000, paid: true, accountId: cash, notes: 'Shop rent' })
  return { ctx, wh, cash, bank, panel, cust, sup, overhead, purchase, quote, sale }
}

/** Every figure the screens and reports show, in one comparable object. */
function figures(ctx: Ctx, ids: { cash: number; bank: number; panel: number; cust: number; sup: number }, firms: number[]) {
  const db = ctx.db
  return {
    pl: plFigures(db, [ctx.firmId], FROM, TO),
    plAll: plFigures(db, firms, FROM, TO),
    pnl: profitAndLoss(ctx, { from: FROM, to: TO }),
    dash: dashboard(ctx, { from: FROM, to: TO }),
    cash: accountBalance(db, ids.cash),
    bank: accountBalance(db, ids.bank),
    stock: qtyOf(ctx, ids.panel),
    customer: partyBalance(ctx, ids.cust),
    supplier: partyBalance(ctx, ids.sup),
    docs: db.prepare('SELECT COUNT(*) AS n, ROUND(SUM(grand_total), 2) AS t FROM documents').get(),
    payments: db.prepare("SELECT COUNT(*) AS n, ROUND(SUM(amount), 2) AS t FROM payments WHERE status <> 'cancelled'").get(),
    movements: db.prepare('SELECT COUNT(*) AS n, ROUND(SUM(qty_in - qty_out), 4) AS q FROM stock_movements').get(),
    audit: (db.prepare('SELECT COUNT(*) AS n FROM audit_log').get() as { n: number }).n
  }
}

describe('UAT: figures are exactly what the books say', () => {
  it('purchase, quotation to sale, receipts, expense: stock, balances, accounts and profit match hand calculation', () => {
    const b = business()
    const { ctx } = b
    // stock: 50 opening + 20 bought - 10 sold
    expect(qtyOf(ctx, b.panel)).toBe(60)
    // customer owes 300,000 - 100,000; supplier is owed 420,000 - 120,000
    expect(partyBalance(ctx, b.cust)).toBe(200000)
    expect(partyBalance(ctx, b.sup)).toBe(-300000)
    // cash: +100,000 receipt - 15,000 rent; bank: 500,000 opening - 120,000 paid
    expect(accountBalance(ctx.db, b.cash)).toBe(85000)
    expect(accountBalance(ctx.db, b.bank)).toBe(380000)
    // moving average: (50 x 20,000 + 20 x 21,000) / 70, 10 units sold from it
    const avg = (50 * 20000 + 20 * 21000) / 70
    const pl = plFigures(ctx.db, [ctx.firmId], FROM, TO)
    expect(pl.revenue).toBe(300000)
    expect(pl.cogs).toBeCloseTo(10 * avg, 1)
    expect(pl.operatingExpenses).toBe(15000)
    expect(pl.grossProfit).toBeCloseTo(300000 - 10 * avg, 1)
    expect(pl.netProfit).toBeCloseTo(300000 - 10 * avg - 15000, 1)
    expect(pl.purchases).toBe(420000)
  })

  it('edit and cancel keep every total consistent (paid purchase, converted quotation)', () => {
    const b = business()
    const { ctx } = b
    // 5 more panels on the paid purchase: stock +5, supplier payable +105,000, payment untouched
    updateDocument(ctx, { id: b.purchase, docType: 'purchase_invoice', date: '2026-03-02', partyId: b.sup, warehouseId: b.wh, lines: [{ productId: b.panel, description: 'Panel', qty: 25, rate: 21000 }] })
    expect(qtyOf(ctx, b.panel)).toBe(65)
    expect(partyBalance(ctx, b.sup)).toBe(-405000)
    expect(accountBalance(ctx.db, b.bank)).toBe(380000)
    // cancelling the converted quotation leaves the sale and every figure of the sale untouched
    const before = plFigures(ctx.db, [ctx.firmId], FROM, TO)
    cancelDocument(ctx, b.quote, 'Customer asked for a new quotation')
    expect(plFigures(ctx.db, [ctx.firmId], FROM, TO)).toEqual({ ...before, purchases: before.purchases })
    expect(partyBalance(ctx, b.cust)).toBe(200000)
    // cancelling the paid purchase takes the stock back and keeps the 120,000 as a supplier advance
    cancelDocument(ctx, b.purchase, 'Wrong supplier')
    expect(qtyOf(ctx, b.panel)).toBe(40)
    expect(partyBalance(ctx, b.sup)).toBe(120000)
    expect(accountBalance(ctx.db, b.bank)).toBe(380000)
    expect(plFigures(ctx.db, [ctx.firmId], FROM, TO).purchases).toBe(0)
  })

  it('two firms: each firm reports its own books and the consolidated report is their exact sum', () => {
    const b = business()
    const f2 = createFirm(b.ctx, { name: 'WETCO Lahore Branch' }, 5)
    const ctx2: Ctx = { ...b.ctx, firmId: f2 }
    const cash2 = cashAccount(ctx2)
    const cust2 = saveParty(ctx2, { type: 'customer', name: 'Lahore Solar Hub' })
    createDocument(ctx2, { docType: 'sale_invoice', date: '2026-03-09', partyId: cust2, warehouseId: b.wh, lines: [{ productId: b.panel, description: 'Panel', qty: 4, rate: 31000 }], payment: { amount: 124000, accountId: cash2 } })
    const overhead = b.overhead
    createExpense(ctx2, { date: '2026-03-10', categoryId: overhead, amount: 4000, paid: true, accountId: cash2 })

    const one = plFigures(b.ctx.db, [b.ctx.firmId], FROM, TO)
    const two = plFigures(b.ctx.db, [f2], FROM, TO)
    const all = plFigures(b.ctx.db, [b.ctx.firmId, f2], FROM, TO)
    expect(two.revenue).toBe(124000)
    expect(two.operatingExpenses).toBe(4000)
    expect(all.revenue).toBe(one.revenue + two.revenue)
    expect(all.cogs).toBeCloseTo(one.cogs + two.cogs, 1)
    expect(all.operatingExpenses).toBe(one.operatingExpenses + two.operatingExpenses)
    expect(all.netProfit).toBeCloseTo(one.netProfit + two.netProfit, 1)
    // the second firm's till is its own
    expect(accountBalance(b.ctx.db, cash2)).toBe(120000)
    expect(accountBalance(b.ctx.db, b.cash)).toBe(85000)
    // stock is shared: 60 - 4
    expect(qtyOf(b.ctx, b.panel)).toBe(56)
  })

  it('day closing figures equal the day book and a transfer moves money without changing profit', () => {
    const b = business()
    const { ctx } = b
    const id = closePeriod(ctx, { kind: 'day', period: '2026-03-07', countedCash: 85000 })
    const row = listClosings(ctx).find((r) => r.id === id) as { cash_in: number; cash_out: number; closing_cash: number; difference: number; expenses_total: number }
    expect(row.expenses_total).toBe(15000)
    expect(row.cash_out).toBe(15000)
    expect(row.difference).toBe(row.difference) // counted - expected, shown to the user
    const profitBefore = plFigures(ctx.db, [ctx.firmId], FROM, TO).netProfit
    createTransfer(ctx, { date: '2026-03-08', fromAccountId: b.bank, toAccountId: b.cash, amount: 50000 })
    expect(accountBalance(ctx.db, b.bank)).toBe(330000)
    expect(accountBalance(ctx.db, b.cash)).toBe(135000)
    expect(plFigures(ctx.db, [ctx.firmId], FROM, TO).netProfit).toBe(profitBefore)
    expect(accountBalance(ctx.db, b.bank) + accountBalance(ctx.db, b.cash)).toBe(465000)
  })
})

describe('UAT: JSON backup and restore round trip', () => {
  it('a restored database gives the same figures, the same rows and a clean integrity check', () => {
    const b = business()
    const { ctx } = b
    const f2 = createFirm(ctx, { name: 'WETCO Lahore Branch' }, 5)
    const ctx2: Ctx = { ...ctx, firmId: f2 }
    createDocument(ctx2, { docType: 'sale_invoice', date: '2026-03-09', partyName: 'Walk-in', warehouseId: b.wh, lines: [{ productId: b.panel, description: 'Panel', qty: 2, rate: 32000 }], payment: { amount: 64000, accountId: cashAccount(ctx2) } })
    closePeriod(ctx, { kind: 'day', period: '2026-03-07', countedCash: 85000 })
    const ids = { cash: b.cash, bank: b.bank, panel: b.panel, cust: b.cust, sup: b.sup }
    const firms = [ctx.firmId, f2]
    const before = figures(ctx, ids, firms)

    const dir = mkdtempSync(join(tmpdir(), 'dtsp-uat-'))
    try {
      const file = join(dir, 'backup.js1')
      const data = exportJs1(ctx.db, { appVersion: '1.5.0' })
      writeJs1(file, data)
      const back = readJs1(file)
      const summary = summarizeJs1(back)
      expect(summary).toBeTruthy()
      expect(back.sha256).toBe(tablesHash(back.tables))

      const target = join(dir, 'restored.db')
      const built = buildDatabaseFromJs1(back, target)
      expect(built.ok).toBe(true)
      const restored = openDatabase(target)
      expect((restored.pragma('integrity_check', { simple: true }) as string)).toBe('ok')
      expect(restored.pragma('foreign_key_check') as unknown[]).toHaveLength(0)
      const user = buildSessionUser(restored, ctx.user.id)
      const rctx: Ctx = { db: restored, user, firmId: ctx.firmId }
      const after = figures(rctx, ids, firms)
      expect(after).toEqual(before)
      // the restored books keep working: a new sale is booked on top of the restored stock and numbering
      const nextSale = createDocument(rctx, { docType: 'sale_invoice', date: '2026-03-20', partyId: b.cust, warehouseId: b.wh, lines: [{ productId: b.panel, description: 'Panel', qty: 1, rate: 30000 }] })
      expect(getDocument(rctx, nextSale).number).not.toBe(getDocument(rctx, b.sale).number)
      expect(qtyOf(rctx, b.panel)).toBe(before.stock - 1)
      restored.close()

      // a damaged file is refused with a readable message and nothing is built from it
      const tampered = JSON.parse(readFileSync(file, 'utf8'))
      tampered.tables.documents.rows[0][tampered.tables.documents.columns.indexOf('grand_total')] = 1
      const bad = join(dir, 'tampered.js1')
      writeFileSync(bad, JSON.stringify(tampered))
      expect(() => readJs1(bad)).toThrow(/checksum/)
      const notBackup = join(dir, 'other.js1')
      writeFileSync(notBackup, JSON.stringify({ hello: 'world' }))
      expect(() => readJs1(notBackup)).toThrow(/not a DT Solar Pro JSON backup/)
      writeFileSync(notBackup, 'not json at all')
      expect(() => readJs1(notBackup)).toThrow(/could not be read as JSON/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('UAT: CSV export and re-import of the same business', () => {
  it('customers, suppliers, products, sales, purchases, payments and expenses survive the trip with their totals', () => {
    const b = business()
    createPayment(b.ctx, { date: '2026-03-12', direction: 'in', partyId: b.cust, accountId: b.cash, amount: 20000, notes: 'Part payment' })
    const files = Object.fromEntries((['customers', 'suppliers', 'products', 'sales', 'purchases', 'payments', 'expenses'] as const).map((k) => [k, exportCsv(b.ctx, k)]))
    expect(files.sales.rows).toBe(1)
    expect(files.purchases.rows).toBe(1)
    expect(files.payments.rows).toBe(1) // the receipts and payments made on the invoices travel with their invoices
    expect(files.expenses.rows).toBe(1)
    const dst = setupCtx()
    // accounts are not part of the CSV files: the purchase refers to its bank account by name, so it must exist first
    saveAccount(dst, { name: 'Meezan Bank', type: 'bank', openingBalance: 500000 })
    for (const k of ['customers', 'suppliers', 'products', 'purchases', 'sales', 'payments', 'expenses'] as const) {
      const f = files[k]
      const a = analyzeImport(dst, { kind: k, text: f.text, dryRun: true })
      expect(a.errors, k).toEqual([])
      const r = runImport(dst, { kind: k, text: f.text, fileName: `${k}.csv` })
      expect(r.failed, k).toBe(0)
      expect(r.reconciliation.matched, k).toBe(true)
    }
    const total = (c: Ctx, doc: string): number => (c.db.prepare("SELECT ROUND(SUM(grand_total), 2) AS t FROM documents WHERE doc_type = ? AND status <> 'cancelled'").get(doc) as { t: number }).t
    expect(total(dst, 'sale_invoice')).toBe(total(b.ctx, 'sale_invoice'))
    expect(total(dst, 'purchase_invoice')).toBe(total(b.ctx, 'purchase_invoice'))
    const exp = (c: Ctx): number => (c.db.prepare("SELECT ROUND(SUM(amount), 2) AS t FROM expenses WHERE status <> 'cancelled'").get() as { t: number }).t
    expect(exp(dst)).toBe(exp(b.ctx))
  })
})
