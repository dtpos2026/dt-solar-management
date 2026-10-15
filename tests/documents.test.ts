import { describe, expect, it } from 'vitest'
import { createAdjustment, saveProduct } from '../src/main/services/inventory'
import { saveParty, partyBalance } from '../src/main/services/parties'
import {
  cancelDocument,
  createDocument,
  deleteBlockReason,
  deleteDocument,
  getDocument,
  prepareConversion,
  prepareCopy,
  productDetails,
  updateDocument
} from '../src/main/services/documents'
import { createPayment } from '../src/main/services/payments'
import {
  deleteTemplate,
  duplicateTemplate,
  getTemplateDefaults,
  listTemplates,
  saveTemplate,
  setDefaultTemplate,
  templatesForKind
} from '../src/main/services/templates'
import type { Ctx } from '../src/main/services/context'
import { cashAccount, qtyOf, setupCtx, userCtx, warehouse } from './helpers'

function stocked() {
  const ctx = setupCtx()
  const wh = warehouse(ctx)
  const prod = saveProduct(ctx, {
    name: 'Jinko Tiger Neo 585W',
    brand: 'Jinko',
    model: 'JKM585N',
    salePrice: 30000,
    description: 'N-type bifacial module\n30-year linear power warranty'
  })
  const serialProd = saveProduct(ctx, { name: 'Growatt 6kW Inverter', salePrice: 150000, trackSerial: true })
  createAdjustment(ctx, {
    date: '2026-01-01',
    warehouseId: wh,
    kind: 'opening',
    lines: [
      { productId: prod, qty: 50, unitCost: 20000 },
      { productId: serialProd, qty: 2, unitCost: 100000, serials: 'GW-1, GW-2' }
    ]
  })
  const cust = saveParty(ctx, { type: 'customer', name: 'Ali Traders' })
  const sup = saveParty(ctx, { type: 'supplier', name: 'Solar Wholesale' })
  return { ctx, wh, prod, serialProd, cust, sup, acc: cashAccount(ctx) }
}

function lines(ctx: Ctx, id: number): Array<Record<string, unknown>> {
  return getDocument(ctx, id).lines as Array<Record<string, unknown>>
}

function closeDay(ctx: Ctx, date: string): void {
  ctx.db
    .prepare("INSERT INTO day_closings (firm_id, kind, period_start, period_end, status) VALUES (?, 'day', ?, ?, 'closed')")
    .run(ctx.firmId, date, date)
}

describe('item name + item description on document lines', () => {
  it('saves, updates and copies the description through conversions and duplicates', () => {
    const { ctx, wh, prod, cust } = stocked()
    const q = createDocument(ctx, {
      docType: 'quotation',
      date: '2026-03-01',
      partyId: cust,
      lines: [
        { productId: prod, description: 'Solar panel 585W', details: '  N-type bifacial\r\n30-year warranty  \n', qty: 10, rate: 30000 },
        { description: 'Installation', details: '', qty: 1, rate: 50000 }
      ]
    })
    let l = lines(ctx, q)
    expect(l[0].description).toBe('Solar panel 585W')
    expect(l[0].details).toBe('  N-type bifacial\n30-year warranty')
    expect(l[1].details).toBeNull()

    // update keeps / changes the description
    updateDocument(ctx, {
      id: q,
      docType: 'quotation',
      date: '2026-03-01',
      partyId: cust,
      lines: [
        { productId: prod, description: 'Solar panel 585W', details: 'N-type bifacial — edited', qty: 10, rate: 30000 },
        { description: 'Installation', details: 'Structure + wiring', qty: 1, rate: 50000 }
      ]
    })
    l = lines(ctx, q)
    expect(l[0].details).toBe('N-type bifacial — edited')
    expect(l[1].details).toBe('Structure + wiring')

    // quotation -> invoice keeps the descriptions
    const conv = prepareConversion(ctx, q, 'sale_invoice')
    expect(conv.lines.map((x) => x.details)).toEqual(['N-type bifacial — edited', 'Structure + wiring'])
    const inv = createDocument(ctx, { ...conv, warehouseId: wh })
    expect(lines(ctx, inv).map((x) => x.details)).toEqual(['N-type bifacial — edited', 'Structure + wiring'])
    expect(getDocument(ctx, q).status).toBe('converted')

    // quotation -> order / challan
    for (const target of ['sale_order', 'delivery_challan'] as const) {
      const c = prepareConversion(ctx, q, target)
      expect(c.lines[0].details).toBe('N-type bifacial — edited')
    }

    // invoice -> return keeps the descriptions
    const ret = prepareConversion(ctx, inv, 'sale_return')
    expect(ret.lines[0].details).toBe('N-type bifacial — edited')

    // duplicate keeps the descriptions but not the source link
    const copy = prepareCopy(ctx, inv)
    expect(copy.docType).toBe('sale_invoice')
    expect(copy.refDocId).toBeUndefined()
    expect(copy.lines.map((x) => x.details)).toEqual(['N-type bifacial — edited', 'Structure + wiring'])
    expect(() => prepareCopy(ctx, createDocument(ctx, { ...ret, warehouseId: wh, lines: [{ ...ret.lines[0], qty: 1 }] }))).toThrow(/Returns cannot be duplicated/)
  })

  it('returns product descriptions to pre-fill the editor', () => {
    const { ctx, prod } = stocked()
    const r = productDetails(ctx, [prod, 999999])
    expect(r).toHaveLength(1)
    expect(r[0]).toMatchObject({ id: prod, brand: 'Jinko', model: 'JKM585N' })
    expect(r[0].description).toContain('30-year')
  })
})

describe('permanent delete of invoices', () => {
  it('deletes an unpaid invoice: stock and serials restored, rows gone, audit snapshot kept', () => {
    const { ctx, wh, prod, serialProd, cust } = stocked()
    const inv = createDocument(ctx, {
      docType: 'sale_invoice',
      date: '2026-03-02',
      partyId: cust,
      warehouseId: wh,
      lines: [
        { productId: prod, description: 'Panel', details: 'Bifacial', qty: 5, rate: 30000 },
        { productId: serialProd, description: 'Inverter', qty: 1, rate: 150000, serials: 'GW-1' }
      ]
    })
    expect(qtyOf(ctx, prod)).toBe(45)
    expect(qtyOf(ctx, serialProd)).toBe(1)
    expect(partyBalance(ctx, cust)).toBe(300000)
    expect(getDocument(ctx, inv).delete_block).toBeNull()

    deleteDocument(ctx, inv)

    expect(qtyOf(ctx, prod)).toBe(50)
    expect(qtyOf(ctx, serialProd)).toBe(2)
    const serial = ctx.db.prepare("SELECT status FROM serials WHERE serial = 'GW-1'").get() as { status: string }
    expect(serial.status).toBe('in_stock')
    expect(ctx.db.prepare('SELECT COUNT(*) AS c FROM documents WHERE id = ?').get(inv)).toEqual({ c: 0 })
    expect(ctx.db.prepare('SELECT COUNT(*) AS c FROM document_lines WHERE document_id = ?').get(inv)).toEqual({ c: 0 })
    expect(partyBalance(ctx, cust)).toBe(0)
    // the stock card keeps the original movement and its reversal (net zero)
    const mov = ctx.db.prepare("SELECT SUM(qty_in) - SUM(qty_out) AS net, COUNT(*) AS n FROM stock_movements WHERE ref_type = 'sale_invoice' AND ref_id = ?").get(inv) as { net: number; n: number }
    expect(mov.net).toBe(0)
    expect(mov.n).toBe(4)
    const a = ctx.db.prepare("SELECT * FROM audit_log WHERE action = 'delete' AND entity = 'sale_invoice' AND entity_id = ?").get(inv) as { details: string; summary: string }
    expect(a.summary).toMatch(/permanently/)
    const details = JSON.parse(a.details)
    expect(details.snapshot.document.id).toBe(inv)
    expect(details.snapshot.document.grand_total).toBe(300000)
    expect(details.snapshot.lines).toHaveLength(2)
    expect(details.snapshot.lines[0].details).toBe('Bifacial')
  })

  it('deletes a purchase bill and removes its stock; refuses when the goods were already sold', () => {
    const { ctx, wh, prod, cust, sup } = stocked()
    const pi = createDocument(ctx, { docType: 'purchase_invoice', date: '2026-03-03', partyId: sup, warehouseId: wh, lines: [{ productId: prod, description: 'Panel', qty: 10, rate: 21000 }] })
    expect(qtyOf(ctx, prod)).toBe(60)
    deleteDocument(ctx, pi)
    expect(qtyOf(ctx, prod)).toBe(50)
    expect(partyBalance(ctx, sup)).toBe(0)

    const pi2 = createDocument(ctx, { docType: 'purchase_invoice', date: '2026-03-03', partyId: sup, warehouseId: wh, lines: [{ productId: prod, description: 'Panel', qty: 10, rate: 21000 }] })
    createDocument(ctx, { docType: 'sale_invoice', date: '2026-03-04', partyId: cust, warehouseId: wh, lines: [{ productId: prod, description: 'Panel', qty: 55, rate: 30000 }] })
    expect(() => deleteDocument(ctx, pi2)).toThrow()
    // nothing changed (one transaction)
    expect(getDocument(ctx, pi2).id).toBe(pi2)
    expect(qtyOf(ctx, prod)).toBe(5)
  })

  it('refuses paid invoices with a clear message', () => {
    const { ctx, wh, prod, cust, acc } = stocked()
    const inv = createDocument(ctx, {
      docType: 'sale_invoice', date: '2026-03-05', partyId: cust, warehouseId: wh,
      lines: [{ productId: prod, description: 'Panel', qty: 1, rate: 30000 }],
      payment: { amount: 10000, accountId: acc }
    })
    expect(getDocument(ctx, inv).delete_block).toMatch(/payments allocated/)
    expect(() => deleteDocument(ctx, inv)).toThrow(/Cancel \(void\) it instead, or create a Return/)
    // a later receipt allocated to an otherwise unpaid invoice also blocks the delete
    const inv2 = createDocument(ctx, { docType: 'sale_invoice', date: '2026-03-05', partyId: cust, warehouseId: wh, lines: [{ productId: prod, description: 'Panel', qty: 1, rate: 30000 }] })
    createPayment(ctx, { date: '2026-03-06', direction: 'in', partyId: cust, accountId: acc, amount: 5000, allocations: [{ documentId: inv2, amount: 5000 }] })
    expect(() => deleteDocument(ctx, inv2)).toThrow(/payments allocated/)
    expect(qtyOf(ctx, prod)).toBe(48)
  })

  it('refuses invoices referenced by a return (even a cancelled one), but the return itself can be deleted', () => {
    const { ctx, wh, prod, cust } = stocked()
    const inv = createDocument(ctx, { docType: 'sale_invoice', date: '2026-03-07', partyId: cust, warehouseId: wh, lines: [{ productId: prod, description: 'Panel', qty: 4, rate: 30000 }] })
    const conv = prepareConversion(ctx, inv, 'sale_return')
    const ret = createDocument(ctx, { ...conv, date: '2026-03-08', warehouseId: wh, lines: [{ ...conv.lines[0], qty: 1 }] })
    expect(() => deleteDocument(ctx, inv)).toThrow(/referenced by Sales Return/)
    cancelDocument(ctx, ret, 'test')
    expect(() => deleteDocument(ctx, inv)).toThrow(/\(cancelled\)/)
    // delete the (cancelled) return, then the invoice
    deleteDocument(ctx, ret)
    expect(qtyOf(ctx, prod)).toBe(46)
    deleteDocument(ctx, inv)
    expect(qtyOf(ctx, prod)).toBe(50)
  })

  it('a delivered return can be deleted: its stock goes back out', () => {
    const { ctx, wh, prod, cust } = stocked()
    const inv = createDocument(ctx, { docType: 'sale_invoice', date: '2026-03-07', partyId: cust, warehouseId: wh, lines: [{ productId: prod, description: 'Panel', qty: 4, rate: 30000 }] })
    const conv = prepareConversion(ctx, inv, 'sale_return')
    const ret = createDocument(ctx, { ...conv, date: '2026-03-08', warehouseId: wh, lines: [{ ...conv.lines[0], qty: 2 }] })
    expect(qtyOf(ctx, prod)).toBe(48)
    expect(partyBalance(ctx, cust)).toBe(60000)
    deleteDocument(ctx, ret)
    expect(qtyOf(ctx, prod)).toBe(46)
    expect(partyBalance(ctx, cust)).toBe(120000)
  })

  it('refuses documents dated in a closed period, and closed periods also block create / edit / cancel', () => {
    const { ctx, wh, prod, cust } = stocked()
    const inv = createDocument(ctx, { docType: 'sale_invoice', date: '2026-03-09', partyId: cust, warehouseId: wh, lines: [{ productId: prod, description: 'Panel', qty: 1, rate: 30000 }] })
    closeDay(ctx, '2026-03-09')
    expect(getDocument(ctx, inv).delete_block).toMatch(/is closed/)
    expect(() => deleteDocument(ctx, inv)).toThrow(/day 2026-03-09 is closed/)
    expect(() => cancelDocument(ctx, inv, 'x')).toThrow(/is closed/)
    expect(() =>
      updateDocument(ctx, { id: inv, docType: 'sale_invoice', date: '2026-03-10', partyId: cust, warehouseId: wh, lines: [{ productId: prod, description: 'Panel', qty: 2, rate: 30000 }] })
    ).toThrow(/is closed/)
    expect(() =>
      createDocument(ctx, { docType: 'sale_invoice', date: '2026-03-09', partyId: cust, warehouseId: wh, lines: [{ productId: prod, description: 'Panel', qty: 1, rate: 30000 }] })
    ).toThrow(/is closed/)
    // moving a document INTO a closed day is refused as well
    const other = createDocument(ctx, { docType: 'sale_invoice', date: '2026-03-11', partyId: cust, warehouseId: wh, lines: [{ productId: prod, description: 'Panel', qty: 1, rate: 30000 }] })
    expect(() =>
      updateDocument(ctx, { id: other, docType: 'sale_invoice', date: '2026-03-09', partyId: cust, warehouseId: wh, lines: [{ productId: prod, description: 'Panel', qty: 1, rate: 30000 }] })
    ).toThrow(/is closed/)
    expect(qtyOf(ctx, prod)).toBe(48)
  })

  it('refuses users without sales.delete / purchases.delete', () => {
    const { ctx, wh, prod, cust, sup } = stocked()
    const inv = createDocument(ctx, { docType: 'sale_invoice', date: '2026-03-12', partyId: cust, warehouseId: wh, lines: [{ productId: prod, description: 'Panel', qty: 1, rate: 30000 }] })
    const pi = createDocument(ctx, { docType: 'purchase_invoice', date: '2026-03-12', partyId: sup, warehouseId: wh, lines: [{ productId: prod, description: 'Panel', qty: 1, rate: 20000 }] })
    const sales = userCtx(ctx, 'Salesperson', 'sales1')
    expect(deleteBlockReason(sales, inv)).toMatch(/permission/)
    expect(() => deleteDocument(sales, inv)).toThrow(/do not have permission/)
    const store = userCtx(ctx, 'Inventory Manager', 'store1')
    expect(() => deleteDocument(store, pi)).toThrow(/do not have permission/)
    // the Administrator role received the new permissions
    const admin = userCtx(ctx, 'Administrator', 'admin2')
    deleteDocument(admin, inv)
    deleteDocument(admin, pi)
    expect(qtyOf(ctx, prod)).toBe(50)
  })

  it('reopens the source quotation when its converted invoice is deleted; quotations keep the draft rules', () => {
    const { ctx, wh, prod, cust } = stocked()
    const q = createDocument(ctx, { docType: 'quotation', date: '2026-03-13', partyId: cust, lines: [{ productId: prod, description: 'Panel', qty: 2, rate: 30000 }] })
    const inv = createDocument(ctx, { ...prepareConversion(ctx, q, 'sale_invoice'), warehouseId: wh })
    expect(getDocument(ctx, q).status).toBe('converted')
    expect(() => deleteDocument(ctx, q)).toThrow(/converted to/)
    deleteDocument(ctx, inv)
    expect(getDocument(ctx, q).status).toBe('accepted')
    deleteDocument(ctx, q)
    expect(ctx.db.prepare('SELECT COUNT(*) AS c FROM documents').get()).toEqual({ c: 0 })
  })
})

describe('print templates', () => {
  it('creates, edits, duplicates and deletes templates with validation', () => {
    const ctx = setupCtx()
    const id = saveTemplate(ctx, {
      name: 'Blue invoice',
      appliesTo: 'sale_invoice',
      layout: 'modern',
      options: { showLogo: false, accentColor: '#112233', titleOverride: 'Tax Invoice', footerNote: 'Thank you!', bogus: 1 }
    })
    let t = listTemplates(ctx)[0]
    expect(t).toMatchObject({ id, name: 'Blue invoice', applies_to: 'sale_invoice', layout: 'modern' })
    expect(t.options.showLogo).toBe(false)
    expect(t.options.showDescription).toBe(true)
    expect(t.options.accentColor).toBe('#112233')
    expect(t.options.titleOverride).toBe('Tax Invoice')
    expect('bogus' in t.options).toBe(false)

    expect(() => saveTemplate(ctx, { name: 'blue INVOICE', layout: 'classic' })).toThrow(/already exists/)
    expect(() => saveTemplate(ctx, { name: 'Bad colour', options: { accentColor: 'red' } })).toThrow(/Accent colour/)
    expect(() => saveTemplate(ctx, { name: 'Receipt', appliesTo: 'quotation', layout: 'thermal80' })).toThrow(/80 mm/)
    expect(() => saveTemplate(ctx, { name: 'Receipt', appliesTo: 'all', layout: 'thermal80' })).toThrow(/80 mm/)
    const thermal = saveTemplate(ctx, { name: 'Counter receipt', appliesTo: 'sale_invoice', layout: 'thermal80' })

    saveTemplate(ctx, { id, name: 'Blue invoice v2', appliesTo: 'all', layout: 'compact', options: { showUnit: false } })
    t = listTemplates(ctx).find((x) => x.id === id)!
    expect(t).toMatchObject({ name: 'Blue invoice v2', applies_to: 'all', layout: 'compact' })
    expect(t.options.showUnit).toBe(false)
    expect(t.options.showLogo).toBe(true)

    const copy = duplicateTemplate(ctx, id)
    expect(listTemplates(ctx).find((x) => x.id === copy)?.name).toBe('Copy of Blue invoice v2')
    const copy2 = duplicateTemplate(ctx, id)
    expect(listTemplates(ctx).find((x) => x.id === copy2)?.name).toBe('Copy of Blue invoice v2 (2)')

    // usable templates per kind: thermal only for sale invoices / receipts
    expect(listTemplates(ctx, { kind: 'quotation' }).map((x) => x.id)).not.toContain(thermal)
    expect(listTemplates(ctx, { kind: 'sale_invoice' }).map((x) => x.id)).toContain(thermal)

    deleteTemplate(ctx, copy)
    expect(listTemplates(ctx).some((x) => x.id === copy)).toBe(false)
    expect(ctx.db.prepare("SELECT COUNT(*) AS c FROM audit_log WHERE entity = 'doc_template'").get()).toEqual({ c: 6 })
  })

  it('selects a default per document kind and falls back to built-in Classic', () => {
    const ctx = setupCtx()
    expect(templatesForKind(ctx, 'sale_invoice').defaultRef).toBe('builtin:classic')
    const a = saveTemplate(ctx, { name: 'All docs', appliesTo: 'all', layout: 'modern' })
    const q = saveTemplate(ctx, { name: 'Quote only', appliesTo: 'quotation', layout: 'classic' })
    const r = saveTemplate(ctx, { name: 'Receipt', appliesTo: 'payment', layout: 'thermal80' })

    setDefaultTemplate(ctx, 'sale_invoice', a)
    setDefaultTemplate(ctx, 'quotation', q)
    setDefaultTemplate(ctx, 'payment', r)
    setDefaultTemplate(ctx, 'purchase_invoice', 'builtin:compact')
    expect(getTemplateDefaults(ctx)).toEqual({ sale_invoice: a, quotation: q, payment: r, purchase_invoice: 'builtin:compact' })
    expect(templatesForKind(ctx, 'quotation').defaultRef).toBe(q)
    expect(templatesForKind(ctx, 'purchase_invoice').defaultRef).toBe('builtin:compact')
    expect(listTemplates(ctx).find((t) => t.id === a)?.default_for).toEqual(['sale_invoice'])
    expect((ctx.db.prepare('SELECT is_default FROM doc_templates WHERE id = ?').get(a) as { is_default: number }).is_default).toBe(1)

    expect(() => setDefaultTemplate(ctx, 'sale_invoice', q)).toThrow(/cannot be used/)
    expect(() => setDefaultTemplate(ctx, 'quotation', 'builtin:thermal80')).toThrow(/cannot be used/)
    expect(() => setDefaultTemplate(ctx, 'nonsense', a)).toThrow(/Unknown document kind/)

    // editing a template so it no longer fits removes it as default; deleting does too
    saveTemplate(ctx, { id: q, name: 'Quote only', appliesTo: 'sale_order', layout: 'classic' })
    expect(templatesForKind(ctx, 'quotation').defaultRef).toBe('builtin:classic')
    deleteTemplate(ctx, a)
    expect(getTemplateDefaults(ctx).sale_invoice).toBeUndefined()
    setDefaultTemplate(ctx, 'payment', null)
    expect(templatesForKind(ctx, 'payment').defaultRef).toBe('builtin:classic')

    // defaults are per firm
    const other: Ctx = { ...ctx, firmId: 999 }
    expect(getTemplateDefaults(other)).toEqual({})
  })

  it('requires templates.manage to change templates', () => {
    const ctx = setupCtx()
    const sp = userCtx(ctx, 'Salesperson', 'sales1')
    expect(() => saveTemplate(sp, { name: 'X' })).toThrow(/permission/)
    const id = saveTemplate(ctx, { name: 'X' })
    expect(() => setDefaultTemplate(sp, 'sale_invoice', id)).toThrow(/permission/)
    expect(() => deleteTemplate(sp, id)).toThrow(/permission/)
    // but anyone signed in can read them to print
    expect(listTemplates(sp)).toHaveLength(1)
  })
})
