import { describe, expect, it } from 'vitest'
import type { Ctx } from '../src/main/services/context'
import { saveCategory, saveProduct, createAdjustment } from '../src/main/services/inventory'
import { partyBalance, saveParty } from '../src/main/services/parties'
import { createDocument } from '../src/main/services/documents'
import { createPayment } from '../src/main/services/payments'
import { createExpense } from '../src/main/services/expenses'
import { analyzeImport, parseCsv, parseDate, parseNumber, runImport, IMPORT_KINDS, type ImportKind } from '../src/main/services/importer'
import { csvCell, exportCsv } from '../src/main/services/csvExport'
import { cashAccount, qtyOf, setupCtx, userCtx, warehouse } from './helpers'

const URDU = 'سولر پینل ۵۵۰ واٹ'

function seed(ctx: Ctx): void {
  const acc = cashAccount(ctx)
  const cat = saveCategory(ctx, { name: 'Panels, "Mono"' })
  const p1 = saveProduct(ctx, { name: URDU, sku: 'P-550', categoryId: cat, unit: 'pcs', brand: 'Longi', purchasePrice: 100.25, salePrice: 150.5, taxRate: 0, openingQty: 20, openingCost: 99.5 })
  const p2 = saveProduct(ctx, { name: 'Inverter "Hybrid", 6kW', purchasePrice: 1000, salePrice: 1500, openingQty: 0, description: 'Line 1\nLine 2' })
  saveProduct(ctx, { name: 'Installation', type: 'service', salePrice: 5000 })
  const cust = saveParty(ctx, { type: 'customer', name: 'علی احمد', phone: '+923001234567', city: 'ملتان', openingBalance: 1500.75, openingType: 'receivable', openingDate: '2026-01-01' })
  saveParty(ctx, { type: 'customer', name: 'Zara, "Z"', notes: '=SUM(A1)' })
  const sup = saveParty(ctx, { type: 'supplier', name: 'Solar Traders', phone: '042', openingBalance: 2500, openingType: 'payable' })
  createDocument(ctx, { docType: 'purchase_invoice', date: '2026-02-03', partyId: sup, partyRef: 'ST-77', lines: [{ productId: p2, description: 'Inverter "Hybrid", 6kW', qty: 3, rate: 1000 }] })
  createDocument(ctx, {
    docType: 'sale_invoice',
    date: '2026-02-10',
    partyId: cust,
    notes: 'Roof, 2nd floor',
    docDiscount: 10,
    lines: [
      { productId: p1, description: URDU, qty: 4, rate: 150.5, discountPct: 5 },
      { productId: p2, description: 'Inverter "Hybrid", 6kW', qty: 1, rate: 1500 },
      { productId: null, description: 'Wiring (text line)', qty: 1, rate: 250 }
    ]
  })
  createDocument(ctx, {
    docType: 'sale_invoice',
    date: '2026-02-11',
    partyName: 'Walk-in Bilal',
    lines: [{ productId: p1, description: URDU, qty: 1, rate: 160 }],
    payment: { amount: 160, accountId: acc }
  })
  const inv = ctx.db.prepare("SELECT number FROM documents WHERE doc_type = 'sale_invoice' AND party_id = ?").get(cust) as { number: string }
  const allocTo = ctx.db.prepare("SELECT id FROM documents WHERE number = ? AND doc_type = 'sale_invoice'").get(inv.number) as { id: number }
  createPayment(ctx, { date: '2026-02-12', direction: 'in', partyId: cust, accountId: acc, amount: 500.5, method: 'bank_transfer', reference: 'TX,1', allocations: [{ documentId: allocTo.id, amount: 400 }] })
  createPayment(ctx, { date: '2026-02-13', direction: 'out', partyId: sup, accountId: acc, amount: 1200, notes: 'part payment' })
  const ec = (ctx.db.prepare('SELECT id FROM expense_categories ORDER BY id LIMIT 1').get() as { id: number }).id
  createExpense(ctx, { date: '2026-02-14', categoryId: ec, amount: 350.4, paid: true, accountId: acc, payeeName: 'رکشہ والا' })
  createExpense(ctx, { date: '2026-02-15', categoryId: ec, amount: 800, paid: false, partyId: sup })
  createAdjustment(ctx, { date: '2026-02-16', warehouseId: warehouse(ctx), kind: 'adjustment', reason: 'count', lines: [{ productId: p1, qty: -2, unitCost: 99.5 }] })
}

const ORDER: ImportKind[] = ['categories', 'products', 'customers', 'suppliers', 'purchases', 'sales', 'expenses', 'payments', 'stock']

function snapshot(ctx: Ctx): Record<string, unknown> {
  const db = ctx.db
  const prods = db.prepare('SELECT id, name, sku, type, unit, brand, description, purchase_price, sale_price, avg_cost FROM products ORDER BY name').all() as Array<Record<string, unknown>>
  const parties = db.prepare('SELECT id, name, type, phone, city, notes, opening_date FROM parties ORDER BY name').all() as Array<Record<string, unknown>>
  return {
    products: prods.map(({ id, ...p }) => ({ ...p, qty: qtyOf(ctx, Number(id)) })),
    categories: db.prepare('SELECT name, kind FROM categories ORDER BY name').all(),
    parties: parties.map(({ id, ...p }) => ({ ...p, balance: partyBalance(ctx, Number(id)) })),
    docs: db
      .prepare(
        `SELECT d.doc_type, d.number, d.date, d.party_name, d.party_ref, d.notes, d.doc_discount, d.grand_total, p.name AS party,
                (SELECT GROUP_CONCAT(l.description || '|' || l.qty || '|' || l.rate || '|' || l.discount_pct || '|' || COALESCE(l.product_id IS NOT NULL, 0), ';') FROM document_lines l WHERE l.document_id = d.id) AS lines
           FROM documents d LEFT JOIN parties p ON p.id = d.party_id ORDER BY d.doc_type, d.number`
      )
      .all(),
    payments: db.prepare(`SELECT p.direction, p.date, p.amount, p.method, p.reference, (SELECT SUM(amount) FROM payment_allocations a WHERE a.payment_id = p.id) AS alloc FROM payments p ORDER BY p.date, p.amount`).all(),
    expenses: db.prepare('SELECT number, date, amount, paid, payee_name, party_id IS NOT NULL AS has_party FROM expenses ORDER BY number').all()
  }
}

describe('CSV cells & parsing', () => {
  it('quotes RFC-4180 cells and guards formulas', () => {
    expect(csvCell('a,b')).toBe('"a,b"')
    expect(csvCell('say "hi"')).toBe('"say ""hi"""')
    expect(csvCell('x\ny')).toBe('"x\ny"')
    expect(csvCell('=1+1')).toBe("'=1+1")
    expect(csvCell(-5)).toBe('-5')
    expect(csvCell(null)).toBe('')
    expect(parseCsv('﻿a,b\r\n"1,2","x""y"\r\n"multi\nline",\r\n')).toEqual([['a', 'b'], ['1,2', 'x"y'], ['multi\nline', '']])
  })
  it('parses dates in the chosen format and decimals with a dot', () => {
    expect(parseDate('05/03/2026', 'dmy')).toBe('2026-03-05')
    expect(parseDate('05/03/2026', 'ymd')).toBeUndefined()
    expect(parseDate('2026-03-05', 'dmy')).toBe('2026-03-05')
    expect(parseDate('31/02/2026', 'dmy')).toBeUndefined()
    expect(parseDate('', 'dmy')).toBeNull()
    expect(parseNumber('1,234.50')).toBe(1234.5)
    expect(parseNumber('1,5')).toBeUndefined()
    expect(parseNumber('(200)')).toBe(-200)
    expect(parseNumber('')).toBeNull()
  })
})

describe('CSV export -> import round trip', () => {
  it('exports every kind and re-imports into a fresh database with the same values', () => {
    const src = setupCtx()
    seed(src)
    const files = Object.fromEntries(IMPORT_KINDS.map((k) => [k, exportCsv(src, k)])) as Record<ImportKind, ReturnType<typeof exportCsv>>
    expect(files.products.text.startsWith('﻿')).toBe(true)
    expect(files.products.text).toContain(URDU)
    expect(files.sales.rows).toBe(4) // 3 lines + 1 walk-in line
    expect(files.payments.rows).toBe(2) // the walk-in billing payment travels with its invoice
    expect(files.customers.text).toContain("'+923001234567")

    const dst = setupCtx()
    for (const k of ORDER) {
      const f = files[k]
      if (!f.rows) continue
      const a = analyzeImport(dst, { kind: k, text: f.text, dryRun: true })
      expect(a.errors, k).toEqual([])
      expect(a.dryRun?.reconciliation.matched, k).toBe(true)
      const r = runImport(dst, { kind: k, text: f.text, fileName: `${k}.csv` })
      expect(r.failed, k).toBe(0)
      expect(r.reconciliation.matched, k).toBe(true)
    }
    const a = snapshot(src)
    const b = snapshot(dst)
    expect(b.products).toEqual(a.products)
    expect(b.categories).toEqual(a.categories)
    expect(b.parties).toEqual(a.parties)
    expect(b.docs).toEqual(a.docs)
    expect(b.payments).toEqual(a.payments)
    expect(b.expenses).toEqual(a.expenses)

    // second import of the same files: everything is a duplicate and is skipped
    const again = analyzeImport(dst, { kind: 'customers', text: files.customers.text })
    expect(again.counts.skip).toBe(files.customers.rows)
    const r = runImport(dst, { kind: 'sales', text: files.sales.text, skipInvalid: true })
    expect(r.imported).toBe(0)
    expect(r.skipped).toBe(2)
  })

  it('duplicate policy update merges; empty cells keep existing values; dd/mm/yyyy dates', () => {
    const ctx = setupCtx()
    runImport(ctx, { kind: 'customers', text: 'Name,Phone,City\nAhmed,0300,Multan\n' })
    const csv = 'Name,Phone,City,Opening balance,Opening date\nAhmed,0300,,750.5,15/01/2026\nNew One,0301,Lahore,,\n'
    const skip = runImport(ctx, { kind: 'customers', text: csv, duplicates: 'skip', dateFormat: 'dmy' })
    expect([skip.imported, skip.updated, skip.skipped]).toEqual([1, 0, 1])
    const upd = runImport(ctx, { kind: 'customers', text: csv.replace('New One', 'Newer'), duplicates: 'update', dateFormat: 'dmy' })
    expect([upd.imported, upd.updated]).toEqual([1, 1])
    const p = ctx.db.prepare("SELECT city, opening_balance, opening_date FROM parties WHERE name = 'Ahmed'").get()
    expect(p).toEqual({ city: 'Multan', opening_balance: 750.5, opening_date: '2026-01-15' })
    expect(() => runImport(ctx, { kind: 'customers', text: 'Name,Opening date\nX,15/01/2026\n', dateFormat: 'ymd' })).toThrow(/Nothing was imported/)
  })

  it('reports unknown references and in-file duplicates; skipInvalid imports the rest in one transaction', () => {
    const ctx = setupCtx()
    const csv = 'Invoice no,Date,Customer,Item name,Qty,Rate\nS-1,2026-03-01,Nobody,Thing,1,10\nS-2,2026-03-01,,Cash item,1,10\n'
    const a = analyzeImport(ctx, { kind: 'sales', text: csv })
    expect(a.errors.some((e) => e.row === 2 && /not found/.test(e.message))).toBe(true)
    const pr = analyzeImport(ctx, { kind: 'products', text: 'Name,SKU\nA,X1\nB,X1\n' })
    expect(pr.errors[0].message).toMatch(/repeats row 2/)
    const r = runImport(ctx, { kind: 'products', text: 'Name,SKU,Sale price\nA,X1,5\nB,X1,6\nC,,abc\nD,,7\n', skipInvalid: true })
    expect([r.imported, r.failed]).toEqual([2, 2])
    expect(ctx.db.prepare("SELECT COUNT(*) c FROM products WHERE name IN ('A','D')").get()).toEqual({ c: 2 })
  })

  it('needs the backup right to export and the import right to import', () => {
    const owner = setupCtx()
    const sales = userCtx(owner, 'Inventory Manager', 'inv1')
    expect(() => exportCsv(sales, 'customers')).toThrow()
    expect(() => runImport(sales, { kind: 'customers', text: 'Name\nX\n' })).toThrow()
  })
})
