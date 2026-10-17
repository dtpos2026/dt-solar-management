/**
 * Final update: quotations (edit / cancel / reject, also after conversion), paid purchases (edit / cancel / delete with stock and
 * accounting adjustments). Real services on a real SQLite database.
 */
import { describe, expect, it } from 'vitest'
import { createAdjustment, saveProduct } from '../src/main/services/inventory'
import { partyBalance, saveParty } from '../src/main/services/parties'
import { cancelDocument, createDocument, deleteDocument, getDocument, prepareConversion, setQuotationStatus, updateDocument } from '../src/main/services/documents'
import { createPayment } from '../src/main/services/payments'
import type { Ctx } from '../src/main/services/context'
import { cashAccount, qtyOf, setupCtx, userCtx, warehouse } from './helpers'

function shop() {
  const ctx = setupCtx()
  const wh = warehouse(ctx)
  const prod = saveProduct(ctx, { name: 'Jinko Tiger Neo 585W', brand: 'Jinko', salePrice: 30000 })
  createAdjustment(ctx, { date: '2026-01-01', warehouseId: wh, kind: 'opening', lines: [{ productId: prod, qty: 50, unitCost: 20000 }] })
  const cust = saveParty(ctx, { type: 'customer', name: 'Ali Traders' })
  const sup = saveParty(ctx, { type: 'supplier', name: 'Solar Wholesale' })
  return { ctx, wh, prod, cust, sup, acc: cashAccount(ctx) }
}

const auditOf = (ctx: Ctx, entity: string, id: number): Array<{ action: string; summary: string; details: string | null }> =>
  ctx.db.prepare('SELECT action, summary, details FROM audit_log WHERE entity = ? AND entity_id = ? ORDER BY id').all(entity, id) as Array<{ action: string; summary: string; details: string | null }>

describe('quotations: edit, cancel, reject, delete', () => {
  it('a converted quotation can be edited and cancelled; the sale made from it is untouched and the audit keeps both', () => {
    const { ctx, wh, prod, cust } = shop()
    const q = createDocument(ctx, { docType: 'quotation', date: '2026-03-13', partyId: cust, lines: [{ productId: prod, description: 'Panel', qty: 2, rate: 30000 }] })
    const sale = createDocument(ctx, { ...prepareConversion(ctx, q, 'sale_invoice'), warehouseId: wh })
    expect(getDocument(ctx, q).status).toBe('converted')
    const saleBefore = getDocument(ctx, sale)

    // edit after conversion: new quantity and rate, still converted, link to the sale intact
    updateDocument(ctx, { id: q, docType: 'quotation', date: '2026-03-14', partyId: cust, lines: [{ productId: prod, description: 'Panel', qty: 3, rate: 29000 }] })
    const edited = getDocument(ctx, q)
    expect(edited.status).toBe('converted')
    expect(edited.grand_total).toBe(87000)
    expect(edited.converted_to).toBe(saleBefore.number)
    // the sale did not change at all
    const saleAfter = getDocument(ctx, sale)
    expect(saleAfter.grand_total).toBe(saleBefore.grand_total)
    expect(saleAfter.ref_doc_id).toBe(q)
    expect(qtyOf(ctx, prod)).toBe(48)

    // reject is not offered for a converted quotation, cancel is
    expect(() => setQuotationStatus(ctx, q, 'rejected')).toThrow(/converted to a sale/)
    cancelDocument(ctx, q, 'Customer changed the order')
    const cancelled = getDocument(ctx, q)
    expect(cancelled.status).toBe('cancelled')
    expect(cancelled.cancel_reason).toBe('Customer changed the order')
    expect(getDocument(ctx, sale).status).not.toBe('cancelled')
    expect(qtyOf(ctx, prod)).toBe(48)
    expect(() => updateDocument(ctx, { id: q, docType: 'quotation', date: '2026-03-14', partyId: cust, lines: [{ productId: prod, description: 'Panel', qty: 1, rate: 1 }] })).toThrow(/Cancelled documents cannot be edited/)
    // permanent delete of a converted quotation stays refused: the sale refers to it
    expect(() => deleteDocument(ctx, q)).toThrow(/converted to/)
    // audit history: edit + cancel are both there with their details
    const trail = auditOf(ctx, 'quotation', q).map((a) => a.action)
    expect(trail).toEqual(expect.arrayContaining(['create', 'update', 'cancel']))
  })

  it('reject keeps the quotation on file with the reason; delete of an open quotation is permanent and audited', () => {
    const { ctx, prod, cust } = shop()
    const q = createDocument(ctx, { docType: 'quotation', date: '2026-03-13', partyId: cust, lines: [{ productId: prod, description: 'Panel', qty: 1, rate: 30000 }] })
    setQuotationStatus(ctx, q, 'sent')
    setQuotationStatus(ctx, q, 'rejected', 'Price too high')
    expect(getDocument(ctx, q).status).toBe('rejected')
    expect(auditOf(ctx, 'quotation', q).some((a) => /Reason: Price too high/.test(a.summary))).toBe(true)
    // a rejected quotation can still be corrected and cancelled
    updateDocument(ctx, { id: q, docType: 'quotation', date: '2026-03-13', partyId: cust, status: 'rejected', lines: [{ productId: prod, description: 'Panel', qty: 1, rate: 27000 }] })
    expect(getDocument(ctx, q).grand_total).toBe(27000)
    cancelDocument(ctx, q, 'Lost')
    expect(() => setQuotationStatus(ctx, q, 'sent')).toThrow(/cancelled/)
    const q2 = createDocument(ctx, { docType: 'quotation', date: '2026-03-15', partyId: cust, lines: [{ productId: prod, description: 'Panel', qty: 1, rate: 30000 }] })
    deleteDocument(ctx, q2)
    expect(ctx.db.prepare('SELECT COUNT(*) AS c FROM documents WHERE id = ?').get(q2)).toEqual({ c: 0 })
    expect(auditOf(ctx, 'quotation', q2).map((a) => a.action)).toContain('delete')
  })

  it('needs the quotation permission to edit, cancel, reject or delete', () => {
    const { ctx, prod, cust } = shop()
    const q = createDocument(ctx, { docType: 'quotation', date: '2026-03-13', partyId: cust, lines: [{ productId: prod, description: 'Panel', qty: 1, rate: 30000 }] })
    const viewer = userCtx(ctx, 'Accountant', 'viewer1')
    expect(() => setQuotationStatus(viewer, q, 'rejected')).toThrow(/permission/i)
    expect(() => cancelDocument(viewer, q, 'x')).toThrow(/permission/i)
    expect(() => deleteDocument(viewer, q)).toThrow(/permission/i)
    expect(() => updateDocument(viewer, { id: q, docType: 'quotation', date: '2026-03-13', partyId: cust, lines: [{ productId: prod, description: 'Panel', qty: 2, rate: 1 }] })).toThrow(/permission/i)
  })
})

describe('purchases: paid or unpaid, edit / cancel / delete with stock and accounting adjustments', () => {
  const bill = (c: ReturnType<typeof shop>, qty: number, rate: number, pay?: number) =>
    createDocument(c.ctx, {
      docType: 'purchase_invoice',
      date: '2026-03-03',
      partyId: c.sup,
      warehouseId: c.wh,
      lines: [{ productId: c.prod, description: 'Panel', qty, rate }],
      ...(pay ? { payment: { amount: pay, accountId: c.acc } } : {})
    })

  it('edit of a PAID purchase adjusts stock, supplier balance and keeps the payment', () => {
    const c = shop()
    const pi = bill(c, 10, 21000, 100000) // 210,000 bill, 100,000 paid at billing
    expect(qtyOf(c.ctx, c.prod)).toBe(60)
    expect(partyBalance(c.ctx, c.sup)).toBe(-110000)
    updateDocument(c.ctx, { id: pi, docType: 'purchase_invoice', date: '2026-03-03', partyId: c.sup, warehouseId: c.wh, lines: [{ productId: c.prod, description: 'Panel', qty: 12, rate: 21000 }] })
    expect(qtyOf(c.ctx, c.prod)).toBe(62)
    expect(getDocument(c.ctx, pi).grand_total).toBe(252000)
    expect(partyBalance(c.ctx, c.sup)).toBe(-152000)
    // a new total below what is already paid is refused (the money would have no bill)
    expect(() => updateDocument(c.ctx, { id: pi, docType: 'purchase_invoice', date: '2026-03-03', partyId: c.sup, warehouseId: c.wh, lines: [{ productId: c.prod, description: 'Panel', qty: 1, rate: 21000 }] })).toThrow(/less than the amount already paid/)
    expect(qtyOf(c.ctx, c.prod)).toBe(62)
  })

  it('CANCEL of a paid purchase reverses the stock and leaves the payment as the supplier advance', () => {
    const c = shop()
    const pi = bill(c, 10, 21000, 100000)
    cancelDocument(c.ctx, pi, 'Wrong supplier')
    expect(qtyOf(c.ctx, c.prod)).toBe(50)
    expect(getDocument(c.ctx, pi).status).toBe('cancelled')
    // the 100,000 that left the cash account is still the supplier's, as an advance
    expect(partyBalance(c.ctx, c.sup)).toBe(100000)
  })

  it('DELETE of a paid purchase: stock reversed, payment kept as advance, nothing referenced is lost, audit snapshot kept', () => {
    const c = shop()
    const pi = bill(c, 10, 21000, 100000)
    const number = getDocument(c.ctx, pi).number
    expect(getDocument(c.ctx, pi).delete_block).toBeNull()
    deleteDocument(c.ctx, pi)
    expect(qtyOf(c.ctx, c.prod)).toBe(50)
    expect(c.ctx.db.prepare('SELECT COUNT(*) AS n FROM documents WHERE id = ?').get(pi)).toEqual({ n: 0 })
    expect(c.ctx.db.prepare('SELECT COUNT(*) AS n FROM payment_allocations').get()).toEqual({ n: 0 })
    expect(partyBalance(c.ctx, c.sup)).toBe(100000)
    expect(c.ctx.db.prepare("SELECT COUNT(*) AS n FROM payments WHERE status <> 'cancelled'").get()).toEqual({ n: 1 })
    const del = auditOf(c.ctx, 'purchase_invoice', pi).find((a) => a.action === 'delete')!
    expect(del.summary).toContain(number)
    expect(JSON.parse(del.details ?? '{}').releasedAllocations).toHaveLength(1)
    // the advance can be applied to the next bill
    const pi2 = bill(c, 2, 21000)
    createPayment(c.ctx, { date: '2026-03-04', direction: 'out', partyId: c.sup, accountId: c.acc, amount: 10000, allocations: [{ documentId: pi2, amount: 10000 }] })
    expect(partyBalance(c.ctx, c.sup)).toBe(100000 - 42000 + 10000)
  })

  it('DELETE of an unpaid purchase and of a partly paid one (receipt allocated later); sold goods still block it', () => {
    const c = shop()
    const unpaid = bill(c, 5, 21000)
    deleteDocument(c.ctx, unpaid)
    expect(qtyOf(c.ctx, c.prod)).toBe(50)
    expect(partyBalance(c.ctx, c.sup)).toBe(0)
    const part = bill(c, 10, 21000)
    createPayment(c.ctx, { date: '2026-03-05', direction: 'out', partyId: c.sup, accountId: c.acc, amount: 50000, allocations: [{ documentId: part, amount: 50000 }] })
    expect(partyBalance(c.ctx, c.sup)).toBe(-160000)
    deleteDocument(c.ctx, part)
    expect(partyBalance(c.ctx, c.sup)).toBe(50000)
    // goods already sold: the delete (and its stock reversal) is refused as one unit
    const sold = bill(c, 10, 21000, 21000)
    createDocument(c.ctx, { docType: 'sale_invoice', date: '2026-03-06', partyId: c.cust, warehouseId: c.wh, lines: [{ productId: c.prod, description: 'Panel', qty: 58, rate: 30000 }] })
    expect(() => deleteDocument(c.ctx, sold)).toThrow()
    expect(getDocument(c.ctx, sold).id).toBe(sold)
    expect(qtyOf(c.ctx, c.prod)).toBe(2)
  })

  it('needs purchases.delete / purchases.edit_locked for paid purchases', () => {
    const c = shop()
    const pi = bill(c, 10, 21000, 100000)
    const accountant = userCtx(c.ctx, 'Accountant', 'clerk1')
    expect(() => deleteDocument(accountant, pi)).toThrow(/permission/i)
    expect(() => cancelDocument(accountant, pi, 'x')).toThrow(/permission/i)
    // a purchaser may edit an unpaid bill but not one that already has a payment
    const buyer = userCtx(c.ctx, 'Inventory Manager', 'buyer1')
    expect(() => updateDocument(buyer, { id: pi, docType: 'purchase_invoice', date: '2026-03-03', partyId: c.sup, warehouseId: c.wh, lines: [{ productId: c.prod, description: 'Panel', qty: 11, rate: 21000 }] })).toThrow(/edit paid documents/)
    const unpaid = bill(c, 2, 21000)
    updateDocument(buyer, { id: unpaid, docType: 'purchase_invoice', date: '2026-03-03', partyId: c.sup, warehouseId: c.wh, lines: [{ productId: c.prod, description: 'Panel', qty: 3, rate: 21000 }] })
    expect(getDocument(c.ctx, unpaid).grand_total).toBe(63000)
  })
})
