/** Reorder planning and barcodes for shelf labels. Real services on a real SQLite database. */
import { describe, expect, it } from 'vitest'
import { assignBarcodes, createAdjustment, saveProduct } from '../src/main/services/inventory'
import { saveParty } from '../src/main/services/parties'
import { createDocument, getDocument } from '../src/main/services/documents'
import { updateSettings } from '../src/main/services/settings'
import { createOrders, suggestions } from '../src/main/services/reorder'
import { setupCtx, userCtx, warehouse } from './helpers'

function store() {
  const ctx = setupCtx()
  const wh = warehouse(ctx)
  const bulb = saveProduct(ctx, { name: 'LED Bulb 12W', salePrice: 250, reorderLevel: 10 })
  const wire = saveProduct(ctx, { name: 'Wire 7/29 coil', salePrice: 9000, reorderLevel: 5 })
  const plenty = saveProduct(ctx, { name: 'Switch 1 way', salePrice: 90, reorderLevel: 10 })
  const labour = saveProduct(ctx, { name: 'Wiring labour', type: 'service', salePrice: 500 })
  const none = saveProduct(ctx, { name: 'Fan 56 inch', salePrice: 9000 })
  createAdjustment(ctx, { date: '2026-01-01', warehouseId: wh, kind: 'opening', lines: [{ productId: bulb, qty: 100, unitCost: 150 }, { productId: wire, qty: 20, unitCost: 6000 }, { productId: plenty, qty: 100, unitCost: 50 }, { productId: none, qty: 2, unitCost: 7000 }] })
  const s1 = saveParty(ctx, { type: 'supplier', name: 'Lahore Lights' })
  const s2 = saveParty(ctx, { type: 'supplier', name: 'Pak Cables' })
  const cust = saveParty(ctx, { type: 'customer', name: 'Walk' })
  // buying history: the last supplier and price of each item
  createDocument(ctx, { docType: 'purchase_invoice', date: '2026-02-01', partyId: s1, warehouseId: wh, lines: [{ productId: bulb, description: 'Bulb', qty: 10, rate: 140 }] })
  createDocument(ctx, { docType: 'purchase_invoice', date: '2026-02-05', partyId: s2, warehouseId: wh, lines: [{ productId: wire, description: 'Wire', qty: 5, rate: 6100 }] })
  // sales bring the stock down: bulbs 110 -> 6, wires 25 -> 3
  createDocument(ctx, { docType: 'sale_invoice', date: '2026-03-01', partyId: cust, warehouseId: wh, lines: [{ productId: bulb, description: 'Bulb', qty: 104, rate: 250 }, { productId: wire, description: 'Wire', qty: 22, rate: 9000 }] })
  updateSettings(ctx, { erp_modules: { reorder: true } })
  return { ctx, wh, bulb, wire, plenty, labour, none, s1, s2 }
}

describe('reorder planning', () => {
  it('is off until the module is switched on', () => {
    const ctx = setupCtx()
    expect(() => suggestions(ctx)).toThrow(/switched off/)
  })

  it('lists goods at or below their low-stock level with a suggested quantity, the last supplier and price', () => {
    const { ctx, bulb, wire, s1, s2 } = store()
    const list = suggestions(ctx)
    expect(list.map((s) => s.name)).toEqual(['LED Bulb 12W', 'Wire 7/29 coil'])
    expect(list[0]).toMatchObject({ product_id: bulb, stock: 6, reorder_level: 10, suggested_qty: 14, supplier_id: s1, supplier_name: 'Lahore Lights', last_rate: 140, last_date: '2026-02-01', on_order: 0 })
    expect(list[1]).toMatchObject({ product_id: wire, stock: 3, suggested_qty: 7, supplier_id: s2, last_rate: 6100 })
    expect(suggestions(ctx, { cover: 3 })[0].suggested_qty).toBe(24)
  })

  it('does not suggest what is already on order', () => {
    const { ctx, bulb, s1 } = store()
    createOrders(ctx, { items: [{ productId: bulb, qty: 14, supplierId: s1 }] })
    expect(suggestions(ctx).map((s) => s.name)).toEqual(['Wire 7/29 coil'])
  })

  it('makes one purchase order per supplier and refuses lines without a supplier', () => {
    const { ctx, bulb, wire, s1, s2 } = store()
    expect(() => createOrders(ctx, { items: [] })).toThrow(/at least one item/)
    expect(() => createOrders(ctx, { items: [{ productId: bulb, qty: 14 }] })).toThrow(/Choose a supplier/)
    const made = createOrders(ctx, { items: [{ productId: bulb, qty: 14, supplierId: s1 }, { productId: wire, qty: 7, supplierId: s2, rate: 6200 }] })
    expect(made.map((m) => m.supplier).sort()).toEqual(['Lahore Lights', 'Pak Cables'])
    expect(made[0].number).toMatch(/^PO-/)
    const po = getDocument(ctx, made.find((m) => m.supplier === 'Pak Cables')!.id) as Record<string, any>
    expect(po).toMatchObject({ doc_type: 'purchase_order', party_name: 'Pak Cables', grand_total: 43400 })
    expect(po.lines[0]).toMatchObject({ qty: 7, rate: 6200 })
  })

  it('needs the purchase permission to make orders', () => {
    const { ctx, bulb, s1 } = store()
    expect(() => createOrders(userCtx(ctx, 'Salesperson', 'sales1'), { items: [{ productId: bulb, qty: 1, supplierId: s1 }] })).toThrow(/permission/i)
  })
})

describe('barcodes for labels', () => {
  it('gives products without a barcode their own code, keeps existing ones, and does it once', () => {
    const ctx = setupCtx()
    const a = saveProduct(ctx, { name: 'A', salePrice: 1 })
    const b = saveProduct(ctx, { name: 'B', salePrice: 1, barcode: '8901234567890' })
    expect(assignBarcodes(ctx, [a, b])).toBe(1)
    const code = (id: number): string => (ctx.db.prepare('SELECT barcode FROM products WHERE id = ?').get(id) as { barcode: string }).barcode
    expect(code(a)).toBe(`P${String(a).padStart(8, '0')}`)
    expect(code(b)).toBe('8901234567890')
    expect(assignBarcodes(ctx, [a, b, 9999])).toBe(0)
    expect(() => assignBarcodes(userCtx(ctx, 'Salesperson', 'sales1'), [a])).toThrow(/permission/i)
  })
})
