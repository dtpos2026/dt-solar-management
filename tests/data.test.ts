import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { openDatabase, seedDefaults, DB } from '../src/main/db'
import { buildSessionUser } from '../src/main/services/auth'
import type { Ctx } from '../src/main/services/context'
import { runSetup } from '../src/main/services/setup'
import { saveProduct } from '../src/main/services/inventory'
import { saveParty } from '../src/main/services/parties'
import { createDocument } from '../src/main/services/documents'
import { cancelPayment, createPayment, createTransfer } from '../src/main/services/payments'
import { cancelExpense, createExpense, updateExpense } from '../src/main/services/expenses'
import { assertPeriodOpen, closePeriod, getClosing, listClosings, previewDay, previewMonth, reopenPeriod } from '../src/main/services/closing'
import { createBackup, exportBackup, exportFirmData, listBackups, replaceDatabaseFile, verifyBackup } from '../src/main/backup'
import { analyzeImport, autoMap, parseCsv, runImport } from '../src/main/services/importer'
import { cashAccount, qtyOf, setupCtx, avgCost } from './helpers'

function expenseCat(ctx: Ctx): number {
  return (ctx.db.prepare('SELECT id FROM expense_categories ORDER BY id LIMIT 1').get() as { id: number }).id
}

/** A day with known sales / receipts / expenses / payments on 2026-03-10 (and one receipt the day before). */
function seedDay(ctx: Ctx): { acc: number; cust: number; sup: number; r0: number; exp: number } {
  const acc = cashAccount(ctx)
  ctx.db.prepare('UPDATE accounts SET opening_balance = 10000 WHERE id = ?').run(acc)
  const prod = saveProduct(ctx, { name: 'Panel 550W', purchasePrice: 100, salePrice: 300, openingQty: 50, openingCost: 100 })
  const cust = saveParty(ctx, { type: 'customer', name: 'Ali' })
  const sup = saveParty(ctx, { type: 'supplier', name: 'Supplier Co' })
  const r0 = createPayment(ctx, { date: '2026-03-09', direction: 'in', partyId: cust, accountId: acc, amount: 500 })
  createDocument(ctx, { docType: 'sale_invoice', date: '2026-03-10', partyId: cust, lines: [{ productId: prod, description: 'Panel', qty: 5, rate: 300 }] })
  createPayment(ctx, { date: '2026-03-10', direction: 'in', partyId: cust, accountId: acc, amount: 1000 })
  createPayment(ctx, { date: '2026-03-10', direction: 'out', partyId: sup, accountId: acc, amount: 300 })
  const exp = createExpense(ctx, { date: '2026-03-10', categoryId: expenseCat(ctx), amount: 200, paid: true, accountId: acc })
  return { acc, cust, sup, r0, exp }
}

describe('day & month closing', () => {
  it('computes exact day figures from the books', () => {
    const ctx = setupCtx()
    seedDay(ctx)
    const { figures: f } = previewDay(ctx, '2026-03-10')
    expect(f.cash.opening).toBe(10500)
    expect(f.cash.cashIn).toBe(1000)
    expect(f.cash.cashOut).toBe(500)
    expect(f.cash.expected).toBe(11000)
    expect(f.sales).toBe(1500)
    expect(f.receipts).toBe(1000)
    expect(f.payments).toBe(300)
    expect(f.expenses).toBe(200)
    expect(f.purchases).toBe(0)
    expect(f.counts.sales).toBe(1)
    const id = closePeriod(ctx, { kind: 'day', period: '2026-03-10', countedCash: 10950, notes: 'short 50' })
    const row = getClosing(ctx, id)
    expect(row.closing_cash).toBe(11000)
    expect(row.counted_cash).toBe(10950)
    expect(row.difference).toBe(-50)
    expect((row.summary as { accounts: unknown[] }).accounts.length).toBeGreaterThan(0)
    expect(() => closePeriod(ctx, { kind: 'day', period: '2026-03-10' })).toThrow(/already closed/)
  })

  it('blocks changes in a closed day and allows them after reopening', () => {
    const ctx = setupCtx()
    const { acc, cust, exp } = seedDay(ctx)
    const p10 = createPayment(ctx, { date: '2026-03-10', direction: 'in', partyId: cust, accountId: acc, amount: 50 })
    const id = closePeriod(ctx, { kind: 'day', period: '2026-03-10' })
    expect(() => createPayment(ctx, { date: '2026-03-10', direction: 'in', partyId: cust, accountId: acc, amount: 10 })).toThrow(/closed/)
    expect(() => cancelPayment(ctx, p10)).toThrow(/closed/)
    expect(() => createExpense(ctx, { date: '2026-03-10', categoryId: expenseCat(ctx), amount: 5, paid: true, accountId: acc })).toThrow(/closed/)
    expect(() => updateExpense(ctx, { id: exp, date: '2026-03-11', categoryId: expenseCat(ctx), amount: 5, paid: true, accountId: acc })).toThrow(/closed/)
    expect(() => cancelExpense(ctx, exp)).toThrow(/closed/)
    expect(() => createTransfer(ctx, { date: '2026-03-10', fromAccountId: acc, toAccountId: acc, amount: 1 })).toThrow(/closed/)
    // other days stay open
    expect(() => createPayment(ctx, { date: '2026-03-11', direction: 'in', partyId: cust, accountId: acc, amount: 10 })).not.toThrow()
    expect(() => reopenPeriod(ctx, id, '')).toThrow(/Reason/)
    reopenPeriod(ctx, id, 'Missed a receipt')
    expect(() => createPayment(ctx, { date: '2026-03-10', direction: 'in', partyId: cust, accountId: acc, amount: 10 })).not.toThrow()
    // re-close refreshes the figures
    closePeriod(ctx, { kind: 'day', period: '2026-03-10' })
    expect(getClosing(ctx, id).cash_in).toBe(1060)
    const audits = ctx.db.prepare("SELECT action FROM audit_log WHERE entity = 'day_closing' ORDER BY id").all() as Array<{ action: string }>
    expect(audits.map((a) => a.action)).toEqual(['close', 'reopen', 'close'])
  })

  it('closes a month with per-day totals', () => {
    const ctx = setupCtx()
    const { acc, cust } = seedDay(ctx)
    createPayment(ctx, { date: '2026-03-25', direction: 'in', partyId: cust, accountId: acc, amount: 700 })
    const m = previewMonth(ctx, '2026-03')
    expect(m.days).toHaveLength(31)
    expect(m.figures.receipts).toBe(2200)
    expect(m.days.reduce((s, d) => s + d.receipts, 0)).toBe(2200)
    expect(m.days.find((d) => d.date === '2026-03-10')!.sales).toBe(1500)
    const id = closePeriod(ctx, { kind: 'month', period: '2026-03' })
    expect(() => assertPeriodOpen(ctx.db, ctx.firmId, '2026-03-25')).toThrow(/month 2026-03/)
    expect(() => assertPeriodOpen(ctx.db, ctx.firmId, '2026-04-01')).not.toThrow()
    expect(listClosings(ctx, { kind: 'month' })).toHaveLength(1)
    reopenPeriod(ctx, id, 'Correction')
    expect(() => assertPeriodOpen(ctx.db, ctx.firmId, '2026-03-25')).not.toThrow()
  })
})

describe('backup & restore', () => {
  it('restore brings the books back exactly', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dtsp-data-'))
    const dbFile = join(dir, 'live.db')
    let db: DB = openDatabase(dbFile)
    seedDefaults(db)
    const { userId, firmId } = runSetup(db, {
      firm: { name: 'Backup Firm', phone: '0300', city: 'Multan' },
      owner: { username: 'admin', fullName: 'Owner', password: 'secret123' }
    })
    let ctx: Ctx = { db, user: buildSessionUser(db, userId), firmId }
    seedDay(ctx)
    closePeriod(ctx, { kind: 'day', period: '2026-03-10', countedCash: 11000 })
    const totals = (d: DB): unknown =>
      d
        .prepare(
          `SELECT (SELECT COUNT(*) FROM documents) docs, (SELECT ROUND(SUM(grand_total),2) FROM documents) gt,
                  (SELECT ROUND(SUM(amount),2) FROM payments WHERE status <> 'cancelled') pay, (SELECT COUNT(*) FROM day_closings) cl`
        )
        .get()
    const before = totals(db)
    const b = await createBackup(db, join(dir, 'b'), 'day-close', { firmId, firmName: 'Backup Firm', userName: 'Owner' })
    const list = listBackups([join(dir, 'b'), join(dir, 'missing')])
    expect(list).toHaveLength(1)
    expect(list[0].kind).toBe('day-close')
    expect(list[0].meta?.integrity).toBe('ok')
    expect(verifyBackup(b.file).ok).toBe(true)
    const copy = exportBackup(b.file, join(dir, 'exported.dtbak'))
    expect(verifyBackup(copy.file).ok).toBe(true)
    // modify after backup
    reopenPeriod(ctx, 1, 'test')
    createPayment(ctx, { date: '2026-03-12', direction: 'in', accountId: cashAccount(ctx), amount: 999, notes: 'x' })
    createDocument(ctx, { docType: 'quotation', date: '2026-03-12', partyName: 'Walk-in', lines: [{ description: 'Service', qty: 1, rate: 5000 }] })
    expect(totals(db)).not.toEqual(before)
    db.close()
    replaceDatabaseFile(dbFile, copy.file)
    db = openDatabase(dbFile)
    ctx = { db, user: buildSessionUser(db, userId), firmId }
    expect(totals(db)).toEqual(before)
    expect(listClosings(ctx)[0].status).toBe('closed')
    const data = exportFirmData(ctx) as Record<string, unknown[]>
    expect(data.documents.length).toBe((before as { docs: number }).docs)
    expect(data.closings).toHaveLength(1)
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('verify reports a corrupt file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dtsp-bad-'))
    const f = join(dir, 'DTSolarPro-manual-x.dtbak')
    require('fs').writeFileSync(f, 'not a database')
    expect(verifyBackup(f).ok).toBe(false)
    expect(listBackups(dir)[0].meta?.integrity).toBe('failed')
    rmSync(dir, { recursive: true, force: true })
  })
})

describe('CSV import', () => {
  const PRODUCTS = 'Product Name,SKU,Category,Unit,Brand,Cost Price,Sale Price,Opening Qty,Opening Cost\n' +
    '"Panel 550W, mono",P550,Panels,pcs,Longi,100,150,10,95\n' +
    'Inverter 6kW,INV6,Inverters,pcs,Growatt,"1,000",1500,2,\n'

  it('parses, auto-maps and reconciles', () => {
    const ctx = setupCtx()
    expect(parseCsv(PRODUCTS)[1][0]).toBe('Panel 550W, mono')
    const map = autoMap(parseCsv(PRODUCTS)[0], 'products')
    expect(map.name).toBe(0)
    expect(map.purchasePrice).toBe(5)
    expect(map.openingQty).toBe(7)
    const a = analyzeImport(ctx, { kind: 'products', text: PRODUCTS })
    expect(a.errors).toEqual([])
    expect(a.reconciliation).toEqual({ rows: 2, valid: 2, openingQty: 12, openingValue: 2950, openingBalance: 0 })
    const before = (ctx.db.prepare('SELECT COUNT(*) c FROM products').get() as { c: number }).c
    const r = runImport(ctx, { kind: 'products', text: PRODUCTS, fileName: 'p.csv' })
    expect(r.imported).toBe(2)
    expect(r.reconciliation.matched).toBe(true)
    expect((ctx.db.prepare('SELECT COUNT(*) c FROM products').get() as { c: number }).c).toBe(before + 2)
    const inv = ctx.db.prepare("SELECT id FROM products WHERE sku = 'INV6'").get() as { id: number }
    expect(qtyOf(ctx, inv.id)).toBe(2)
    expect(avgCost(ctx, inv.id)).toBe(1000)
    const run = ctx.db.prepare('SELECT * FROM import_runs WHERE id = ?').get(r.runId) as { imported: number; mapping: string }
    expect(run.imported).toBe(2)
    expect(JSON.parse(run.mapping).name).toBe('Product Name')
    // importing the same file again is rejected (duplicates)
    expect(() => runImport(ctx, { kind: 'products', text: PRODUCTS })).toThrow(/Nothing was imported/)
  })

  it('validation errors write nothing', () => {
    const ctx = setupCtx()
    const bad = 'Name,Phone,City,Opening Balance\nAhmed,0300,Multan,abc\n,0301,Lahore,10\nZara,0302,Multan,500\n'
    const a = analyzeImport(ctx, { kind: 'customers', text: bad })
    expect(a.errors.map((e) => e.row)).toEqual([2, 3])
    expect(a.reconciliation.valid).toBe(1)
    const n = (ctx.db.prepare('SELECT COUNT(*) c FROM parties').get() as { c: number }).c
    expect(() => runImport(ctx, { kind: 'customers', text: bad })).toThrow(/2 problem/)
    expect((ctx.db.prepare('SELECT COUNT(*) c FROM parties').get() as { c: number }).c).toBe(n)
    const run = ctx.db.prepare('SELECT * FROM import_runs ORDER BY id DESC LIMIT 1').get() as { imported: number; errors: string }
    expect(run.imported).toBe(0)
    expect(JSON.parse(run.errors)).toHaveLength(2)
  })

  it('imports customers / suppliers with opening balances and rolls back everything on a failing row', () => {
    const ctx = setupCtx()
    const ok = 'Customer Name,Mobile,Address,City,Opening Balance\nAhmed,0300,St 1,Multan,"1,500"\nBilal,0301,,Lahore,-200\n'
    const r = runImport(ctx, { kind: 'customers', text: ok })
    expect(r.reconciliation.file.openingBalance).toBe(1300)
    expect(r.reconciliation.imported.openingBalance).toBe(1300)
    const sup = runImport(ctx, { kind: 'suppliers', text: 'Supplier,Phone,Opening Balance\nSolar Traders,042,2500\n' })
    expect(sup.reconciliation.matched).toBe(true)
    const st = ctx.db.prepare("SELECT type, opening_balance FROM parties WHERE name = 'Solar Traders'").get() as { type: string; opening_balance: number }
    expect(st).toEqual({ type: 'supplier', opening_balance: -2500 })
    // second row passes validation but fails inside the service (name > 150) -> whole file rolled back
    const n = (ctx.db.prepare('SELECT COUNT(*) c FROM parties').get() as { c: number }).c
    const failing = `Name,Phone\nGood One,1\n${'X'.repeat(160)},2\n`
    expect(() => runImport(ctx, { kind: 'customers', text: failing })).toThrow(/Row 3/)
    expect((ctx.db.prepare('SELECT COUNT(*) c FROM parties').get() as { c: number }).c).toBe(n)
    expect(ctx.db.prepare("SELECT 1 FROM parties WHERE name = 'Good One'").get()).toBeUndefined()
  })
})
