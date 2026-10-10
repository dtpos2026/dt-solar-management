import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { getSchemaVersion, migrate, openDatabase, validateDatabaseFile } from '../src/main/db'
import { LATEST_SCHEMA_VERSION } from '../src/main/db/migrations'
import { hashPassword, login, verifyPassword } from '../src/main/services/auth'
import { createFirm, nextNumber } from '../src/main/services/firms'
import { createAdjustment, saveProduct } from '../src/main/services/inventory'
import { saveParty, partyBalance, partyLedger } from '../src/main/services/parties'
import { cancelDocument, computeTotals, createDocument, getDocument, listDocuments, updateDocument } from '../src/main/services/documents'
import { createPayment, docDue, accountBalance } from '../src/main/services/payments'
import { amountInWords } from '../src/shared/money'
import { avgCost, cashAccount, freshDb, qtyOf, setupCtx, userCtx, warehouse } from './helpers'

describe('database & migrations', () => {
  it('migrates to the latest version and is idempotent', () => {
    const db = freshDb()
    expect(getSchemaVersion(db)).toBe(LATEST_SCHEMA_VERSION)
    migrate(db)
    expect(getSchemaVersion(db)).toBe(LATEST_SCHEMA_VERSION)
  })

  it('validates a database file and rejects foreign files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dtsp-'))
    try {
      const file = join(dir, 'a.db')
      const db = openDatabase(file)
      db.close()
      const ok = validateDatabaseFile(file)
      expect(ok.ok).toBe(true)
      expect(ok.schemaVersion).toBe(LATEST_SCHEMA_VERSION)
      const bad = validateDatabaseFile(join(dir, 'missing.db'))
      expect(bad.ok).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('authentication', () => {
  it('hashes and verifies passwords', () => {
    const h = hashPassword('hello123')
    expect(h.startsWith('scrypt$')).toBe(true)
    expect(verifyPassword('hello123', h)).toBe(true)
    expect(verifyPassword('wrong', h)).toBe(false)
  })

  it('logs in and locks after repeated failures', () => {
    const ctx = setupCtx()
    expect(login(ctx.db, 'admin', 'secret123').user.isOwner).toBe(true)
    for (let i = 0; i < 5; i++) expect(() => login(ctx.db, 'admin', 'bad')).toThrow()
    expect(() => login(ctx.db, 'admin', 'secret123')).toThrow(/Too many failed attempts/)
  })
})

describe('totals', () => {
  it('computes line discounts, document discount and tax proportionally', () => {
    const { totals, lines } = computeTotals(
      [
        { qty: 2, rate: 1000, discountPct: 10, taxRate: 10 },
        { qty: 1, rate: 500, taxRate: 0 }
      ],
      200,
      100,
      0
    )
    expect(lines[0]).toMatchObject({ gross: 2000, discount: 200, net: 1800, tax: 180 })
    expect(totals.subtotal).toBe(2500)
    // net sum 2300, doc discount 200 -> factor 2100/2300 ; tax 180 * factor = 164.35
    expect(totals.taxTotal).toBe(164.35)
    expect(totals.netTotal).toBe(2200)
    expect(totals.grandTotal).toBe(2364.35)
  })

  it('writes amounts in words (lakh/crore)', () => {
    expect(amountInWords(1250000)).toBe('Twelve Lakh Fifty Thousand Rupees Only')
    expect(amountInWords(31500000.5)).toBe('Three Crore Fifteen Lakh Rupees and Fifty Paisa Only')
  })
})

describe('numbering', () => {
  it('never issues duplicate numbers', () => {
    const ctx = setupCtx()
    const seen = new Set<string>()
    for (let i = 0; i < 50; i++) seen.add(nextNumber(ctx.db, ctx.firmId, 'sale_invoice'))
    expect(seen.size).toBe(50)
    // change the counter back: numbering must skip existing numbers
    ctx.db.prepare("UPDATE doc_sequences SET next_no = 1 WHERE doc_type = 'receipt'").run()
    const acc = cashAccount(ctx)
    const party = saveParty(ctx, { type: 'customer', name: 'C' })
    createPayment(ctx, { date: '2026-01-01', direction: 'in', partyId: party, accountId: acc, amount: 10 })
    ctx.db.prepare("UPDATE doc_sequences SET next_no = 1 WHERE doc_type = 'receipt'").run()
    createPayment(ctx, { date: '2026-01-01', direction: 'in', partyId: party, accountId: acc, amount: 10 })
    const nums = ctx.db.prepare("SELECT number FROM payments").all() as Array<{ number: string }>
    expect(new Set(nums.map((n) => n.number)).size).toBe(2)
  })
})

describe('inventory (moving weighted average)', () => {
  it('averages purchase costs and charges COGS at average', () => {
    const ctx = setupCtx()
    const wh = warehouse(ctx)
    const sup = saveParty(ctx, { type: 'supplier', name: 'Sup' })
    const cust = saveParty(ctx, { type: 'customer', name: 'Cust' })
    const prod = saveProduct(ctx, { name: 'Panel', salePrice: 300 })
    createDocument(ctx, { docType: 'purchase_invoice', date: '2026-01-01', partyId: sup, warehouseId: wh, lines: [{ productId: prod, description: 'Panel', qty: 10, rate: 100 }] })
    createDocument(ctx, { docType: 'purchase_invoice', date: '2026-01-02', partyId: sup, warehouseId: wh, lines: [{ productId: prod, description: 'Panel', qty: 10, rate: 200 }] })
    expect(avgCost(ctx, prod)).toBe(150)
    expect(qtyOf(ctx, prod)).toBe(20)
    const inv = createDocument(ctx, { docType: 'sale_invoice', date: '2026-01-03', partyId: cust, warehouseId: wh, lines: [{ productId: prod, description: 'Panel', qty: 5, rate: 300 }] })
    const d = getDocument(ctx, inv)
    expect(d.cost_total).toBe(750)
    expect(qtyOf(ctx, prod)).toBe(15)
    expect(partyBalance(ctx, cust)).toBe(1500)
    expect(partyBalance(ctx, sup)).toBe(-3000)
  })

  it('blocks sales without stock', () => {
    const ctx = setupCtx()
    const cust = saveParty(ctx, { type: 'customer', name: 'Cust' })
    const prod = saveProduct(ctx, { name: 'Inverter', salePrice: 1000 })
    expect(() =>
      createDocument(ctx, { docType: 'sale_invoice', date: '2026-01-03', partyId: cust, lines: [{ productId: prod, description: 'Inverter', qty: 1, rate: 1000 }] })
    ).toThrow(/Insufficient stock/)
    // nothing persisted
    expect(listDocuments(ctx, { docType: 'sale_invoice' })).toHaveLength(0)
  })

  it('purchase return removes the original cost and re-averages', () => {
    const ctx = setupCtx()
    const wh = warehouse(ctx)
    const sup = saveParty(ctx, { type: 'supplier', name: 'Sup' })
    const prod = saveProduct(ctx, { name: 'Battery' })
    createDocument(ctx, { docType: 'purchase_invoice', date: '2026-01-01', partyId: sup, warehouseId: wh, lines: [{ productId: prod, description: 'B', qty: 10, rate: 100 }] })
    const pi2 = createDocument(ctx, { docType: 'purchase_invoice', date: '2026-01-02', partyId: sup, warehouseId: wh, lines: [{ productId: prod, description: 'B', qty: 10, rate: 200 }] })
    const line = (getDocument(ctx, pi2).lines as Array<{ id: number }>)[0]
    createDocument(ctx, { docType: 'purchase_return', date: '2026-01-03', partyId: sup, warehouseId: wh, refDocId: pi2, lines: [{ productId: prod, description: 'B', qty: 10, rate: 200, refLineId: line.id }] })
    expect(qtyOf(ctx, prod)).toBe(10)
    expect(avgCost(ctx, prod)).toBe(100)
    expect(partyBalance(ctx, sup)).toBe(-1000)
    expect(docDue(ctx.db, pi2)).toBe(0)
  })

  it('opening stock is not profit and adjustments are valued at average cost', () => {
    const ctx = setupCtx()
    const wh = warehouse(ctx)
    const prod = saveProduct(ctx, { name: 'Cable', unit: 'm' })
    createAdjustment(ctx, { date: '2026-01-01', warehouseId: wh, kind: 'opening', lines: [{ productId: prod, qty: 100, unitCost: 50 }] })
    createAdjustment(ctx, { date: '2026-01-05', warehouseId: wh, kind: 'adjustment', reason: 'Damaged', lines: [{ productId: prod, qty: -10 }] })
    expect(qtyOf(ctx, prod)).toBe(90)
    const adj = ctx.db.prepare("SELECT total_value FROM stock_adjustments WHERE kind = 'adjustment'").get() as { total_value: number }
    expect(adj.total_value).toBe(-500)
  })
})

describe('sales documents', () => {
  function stocked() {
    const ctx = setupCtx()
    const wh = warehouse(ctx)
    const prod = saveProduct(ctx, { name: 'Panel', salePrice: 300 })
    createAdjustment(ctx, { date: '2026-01-01', warehouseId: wh, kind: 'opening', lines: [{ productId: prod, qty: 50, unitCost: 100 }] })
    const cust = saveParty(ctx, { type: 'customer', name: 'Cust' })
    return { ctx, wh, prod, cust, acc: cashAccount(ctx) }
  }

  it('records payment at billing and computes due / status', () => {
    const { ctx, wh, prod, cust, acc } = stocked()
    const id = createDocument(ctx, {
      docType: 'sale_invoice', date: '2026-02-01', partyId: cust, warehouseId: wh,
      lines: [{ productId: prod, description: 'Panel', qty: 10, rate: 300 }],
      payment: { amount: 1000, accountId: acc }
    })
    const d = getDocument(ctx, id)
    expect(d.grand_total).toBe(3000)
    expect(d.paid).toBe(1000)
    expect(d.due).toBe(2000)
    expect(partyBalance(ctx, cust)).toBe(2000)
    expect(accountBalance(ctx.db, acc)).toBe(1000)
    const list = listDocuments(ctx, { docType: 'sale_invoice' }) as Array<{ pay_status: string }>
    expect(list[0].pay_status).toBe('partial')
  })

  it('walk-in sales must be fully paid', () => {
    const { ctx, wh, prod } = stocked()
    expect(() => createDocument(ctx, { docType: 'sale_invoice', date: '2026-02-01', warehouseId: wh, lines: [{ productId: prod, description: 'Panel', qty: 1, rate: 300 }] })).toThrow(/Walk-in/)
  })

  it('sales return restores stock at the original cost and reduces the balance', () => {
    const { ctx, wh, prod, cust } = stocked()
    const id = createDocument(ctx, { docType: 'sale_invoice', date: '2026-02-01', partyId: cust, warehouseId: wh, lines: [{ productId: prod, description: 'Panel', qty: 10, rate: 300 }] })
    const line = (getDocument(ctx, id).lines as Array<{ id: number }>)[0]
    createDocument(ctx, { docType: 'sale_return', date: '2026-02-02', partyId: cust, warehouseId: wh, refDocId: id, lines: [{ productId: prod, description: 'Panel', qty: 4, rate: 300, refLineId: line.id }] })
    expect(qtyOf(ctx, prod)).toBe(44)
    expect(avgCost(ctx, prod)).toBe(100)
    expect(partyBalance(ctx, cust)).toBe(1800)
    expect(docDue(ctx.db, id)).toBe(1800)
    expect(() =>
      createDocument(ctx, { docType: 'sale_return', date: '2026-02-02', partyId: cust, warehouseId: wh, refDocId: id, lines: [{ productId: prod, description: 'Panel', qty: 7, rate: 300, refLineId: line.id }] })
    ).toThrow(/Only 6 remain/)
  })

  it('cancel restores stock and releases payments as advance', () => {
    const { ctx, wh, prod, cust, acc } = stocked()
    const id = createDocument(ctx, { docType: 'sale_invoice', date: '2026-02-01', partyId: cust, warehouseId: wh, lines: [{ productId: prod, description: 'Panel', qty: 10, rate: 300 }], payment: { amount: 3000, accountId: acc } })
    expect(qtyOf(ctx, prod)).toBe(40)
    cancelDocument(ctx, id, 'test')
    expect(qtyOf(ctx, prod)).toBe(50)
    // money is still received: customer now has a credit (advance) of 3000
    expect(partyBalance(ctx, cust)).toBe(-3000)
    expect(accountBalance(ctx.db, acc)).toBe(3000)
  })

  it('editing an invoice re-posts stock exactly', () => {
    const { ctx, wh, prod, cust } = stocked()
    const id = createDocument(ctx, { docType: 'sale_invoice', date: '2026-02-01', partyId: cust, warehouseId: wh, lines: [{ productId: prod, description: 'Panel', qty: 10, rate: 300 }] })
    updateDocument(ctx, { id, docType: 'sale_invoice', date: '2026-02-01', partyId: cust, warehouseId: wh, lines: [{ productId: prod, description: 'Panel', qty: 3, rate: 300 }] })
    expect(qtyOf(ctx, prod)).toBe(47)
    expect(partyBalance(ctx, cust)).toBe(900)
    expect(getDocument(ctx, id).cost_total).toBe(300)
  })

  it('receipts auto-allocate to oldest invoices and the ledger balances', () => {
    const { ctx, wh, prod, cust, acc } = stocked()
    const a = createDocument(ctx, { docType: 'sale_invoice', date: '2026-02-01', partyId: cust, warehouseId: wh, lines: [{ productId: prod, description: 'Panel', qty: 2, rate: 300 }] })
    const b = createDocument(ctx, { docType: 'sale_invoice', date: '2026-02-02', partyId: cust, warehouseId: wh, lines: [{ productId: prod, description: 'Panel', qty: 2, rate: 300 }] })
    createPayment(ctx, { date: '2026-02-03', direction: 'in', partyId: cust, accountId: acc, amount: 900, autoAllocate: true })
    expect(docDue(ctx.db, a)).toBe(0)
    expect(docDue(ctx.db, b)).toBe(300)
    const ledger = partyLedger(ctx, cust)
    expect(ledger.closing).toBe(300)
    expect(ledger.totalDebit).toBe(1200)
    expect(ledger.totalCredit).toBe(900)
  })
})

describe('permissions & firm separation', () => {
  it('salesperson cannot create purchases or see cost', () => {
    const owner = setupCtx()
    const sp = userCtx(owner, 'Salesperson')
    const sup = saveParty(owner, { type: 'supplier', name: 'Sup' })
    expect(() => createDocument(sp, { docType: 'purchase_invoice', date: '2026-01-01', partyId: sup, lines: [{ description: 'x', qty: 1, rate: 1 }] })).toThrow(/permission/)
  })

  it('keeps documents per firm while sharing inventory and parties', () => {
    const ctx = setupCtx()
    const firm2 = createFirm(ctx, { name: 'LAZZAZ TRADERS' }, 5)
    const ctx2 = { ...ctx, firmId: firm2 }
    const wh = warehouse(ctx)
    const prod = saveProduct(ctx, { name: 'Panel' })
    createAdjustment(ctx, { date: '2026-01-01', warehouseId: wh, kind: 'opening', lines: [{ productId: prod, qty: 10, unitCost: 100 }] })
    const cust = saveParty(ctx, { type: 'customer', name: 'Shared Customer' })
    createDocument(ctx2, { docType: 'sale_invoice', date: '2026-01-02', partyId: cust, warehouseId: wh, lines: [{ productId: prod, description: 'Panel', qty: 4, rate: 200 }] })
    // shared stock decreased once
    expect(qtyOf(ctx, prod)).toBe(6)
    // financial records separate
    expect(listDocuments(ctx, { docType: 'sale_invoice' })).toHaveLength(0)
    expect(listDocuments(ctx2, { docType: 'sale_invoice' })).toHaveLength(1)
    expect(partyBalance(ctx, cust)).toBe(0)
    expect(partyBalance(ctx2, cust)).toBe(800)
    // cannot open firm 2 document from firm 1
    const id = (listDocuments(ctx2, { docType: 'sale_invoice' }) as Array<{ id: number }>)[0].id
    expect(() => getDocument(ctx, id)).toThrow(/not found/i)
  })

  it('enforces the firm limit', () => {
    const ctx = setupCtx()
    createFirm(ctx, { name: 'F2' }, 2)
    expect(() => createFirm(ctx, { name: 'F3' }, 2)).toThrow(/maximum 2/)
  })

  it('keeps inventory separate when sharing is off', () => {
    const ctx = setupCtx({ shareInventory: false, shareParties: false })
    const firm2 = createFirm(ctx, { name: 'F2' }, 5)
    const ctx2 = { ...ctx, firmId: firm2 }
    saveProduct(ctx, { name: 'Firm1 Product' })
    const p2 = saveProduct(ctx2, { name: 'Firm2 Product' })
    const list1 = (ctx.db.prepare('SELECT name FROM products WHERE firm_id = ?').all(ctx.firmId) as Array<{ name: string }>).map((r) => r.name)
    expect(list1).toEqual(['Firm1 Product'])
    const cust1 = saveParty(ctx, { type: 'customer', name: 'Only F1' })
    expect(() => createDocument(ctx2, { docType: 'quotation', date: '2026-01-01', partyId: cust1, lines: [{ productId: p2, description: 'x', qty: 1, rate: 1 }] })).toThrow(/not available/)
  })
})

describe('serial numbers', () => {
  it('requires serials for tracked items and prevents selling twice', () => {
    const ctx = setupCtx()
    const wh = warehouse(ctx)
    const sup = saveParty(ctx, { type: 'supplier', name: 'Sup' })
    const cust = saveParty(ctx, { type: 'customer', name: 'Cust' })
    const inv = saveProduct(ctx, { name: 'Inverter', trackSerial: true, salePrice: 100 })
    expect(() =>
      createDocument(ctx, { docType: 'purchase_invoice', date: '2026-01-01', partyId: sup, warehouseId: wh, lines: [{ productId: inv, description: 'Inverter', qty: 2, rate: 50, serials: 'A1' }] })
    ).toThrow(/exactly 2 serial/)
    createDocument(ctx, { docType: 'purchase_invoice', date: '2026-01-01', partyId: sup, warehouseId: wh, lines: [{ productId: inv, description: 'Inverter', qty: 2, rate: 50, serials: 'A1, A2' }] })
    createDocument(ctx, { docType: 'sale_invoice', date: '2026-01-02', partyId: cust, warehouseId: wh, lines: [{ productId: inv, description: 'Inverter', qty: 1, rate: 100, serials: 'A1' }] })
    expect(() =>
      createDocument(ctx, { docType: 'sale_invoice', date: '2026-01-02', partyId: cust, warehouseId: wh, lines: [{ productId: inv, description: 'Inverter', qty: 1, rate: 100, serials: 'A1' }] })
    ).toThrow(/not in stock/)
  })
})
