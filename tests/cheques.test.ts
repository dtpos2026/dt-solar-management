/** Cheque register: received and issued cheques, clearing books the payment, bouncing takes it back. Real services on a real SQLite database. */
import { describe, expect, it } from 'vitest'
import { createAdjustment, saveProduct } from '../src/main/services/inventory'
import { saveParty } from '../src/main/services/parties'
import { createDocument } from '../src/main/services/documents'
import { accountBalance, docDue } from '../src/main/services/payments'
import { updateSettings } from '../src/main/services/settings'
import { chequeAlerts, chequeSummary, deleteCheque, listCheques, saveCheque, setChequeStatus } from '../src/main/services/cheques'
import { today } from '../src/main/services/context'
import { cashAccount, setupCtx, userCtx, warehouse } from './helpers'

const day = (offset: number): string => {
  const d = new Date()
  d.setDate(d.getDate() + offset)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

function shop() {
  const ctx = setupCtx()
  const wh = warehouse(ctx)
  const prod = saveProduct(ctx, { name: 'Breaker 32A', salePrice: 1000 })
  createAdjustment(ctx, { date: '2026-01-01', warehouseId: wh, kind: 'opening', lines: [{ productId: prod, qty: 100, unitCost: 600 }] })
  const cust = saveParty(ctx, { type: 'customer', name: 'Rana Electric' })
  const sup = saveParty(ctx, { type: 'supplier', name: 'Pak Cables' })
  const sale = createDocument(ctx, { docType: 'sale_invoice', date: '2026-03-01', partyId: cust, warehouseId: wh, lines: [{ productId: prod, description: 'Breaker', qty: 50, rate: 1000 }] })
  const bill = createDocument(ctx, { docType: 'purchase_invoice', date: '2026-03-01', partyId: sup, warehouseId: wh, lines: [{ productId: prod, description: 'Breaker', qty: 40, rate: 600 }] })
  updateSettings(ctx, { erp_modules: { cheques: true } })
  return { ctx, cust, sup, sale, bill, acc: cashAccount(ctx) }
}

describe('cheque register', () => {
  it('is off until the module is switched on', () => {
    const ctx = setupCtx()
    expect(() => listCheques(ctx)).toThrow(/switched off/)
    expect(chequeAlerts(ctx)).toEqual({ overdue: 0, today: 0 })
  })

  it('a received cheque books nothing until it clears; clearing settles the linked invoice and puts the money in the account', () => {
    const { ctx, cust, sale, acc } = shop()
    const id = saveCheque(ctx, { direction: 'received', chequeNo: '004512', bank: 'HBL', partyId: cust, amount: 30000, chequeDate: day(10), documentId: sale })
    expect(docDue(ctx.db, sale)).toBe(50000)
    const before = accountBalance(ctx.db, acc)
    setChequeStatus(ctx, id, { status: 'deposited', accountId: acc })
    expect(docDue(ctx.db, sale)).toBe(50000)
    expect(accountBalance(ctx.db, acc)).toBe(before)
    setChequeStatus(ctx, id, { status: 'cleared', accountId: acc, date: day(0) })
    expect(docDue(ctx.db, sale)).toBe(20000)
    expect(accountBalance(ctx.db, acc)).toBe(before + 30000)
    const row = (listCheques(ctx) as Array<Record<string, any>>)[0]
    expect(row).toMatchObject({ status: 'cleared', payment_id: expect.any(Number), cleared_at: day(0) })
    expect(ctx.db.prepare('SELECT method, reference, direction FROM payments WHERE id = ?').get(row.payment_id)).toEqual({ method: 'cheque', reference: 'Cheque 004512 (HBL)', direction: 'in' })
    expect(() => setChequeStatus(ctx, id, { status: 'cleared', accountId: acc })).toThrow(/cannot be marked/)
    expect(() => deleteCheque(ctx, id)).toThrow(/cannot be deleted/)
  })

  it('a cheque that bounces after clearing takes the payment back; a pending one just changes status', () => {
    const { ctx, cust, sale, acc } = shop()
    const a = saveCheque(ctx, { direction: 'received', chequeNo: '1', partyId: cust, amount: 50000, chequeDate: day(-1), documentId: sale })
    setChequeStatus(ctx, a, { status: 'cleared', accountId: acc })
    expect(docDue(ctx.db, sale)).toBe(0)
    const balance = accountBalance(ctx.db, acc)
    setChequeStatus(ctx, a, { status: 'bounced', reason: 'Insufficient funds' })
    expect(docDue(ctx.db, sale)).toBe(50000)
    expect(accountBalance(ctx.db, acc)).toBe(balance - 50000)
    expect((listCheques(ctx, { status: 'bounced' }) as Array<Record<string, any>>)[0]).toMatchObject({ bounce_reason: 'Insufficient funds', payment_id: null })
    const b = saveCheque(ctx, { direction: 'received', chequeNo: '2', partyId: cust, amount: 1000, chequeDate: day(5) })
    setChequeStatus(ctx, b, { status: 'bounced' })
    expect(ctx.db.prepare('SELECT COUNT(*) AS c FROM payments').get()).toEqual({ c: 1 })
    expect(() => setChequeStatus(ctx, b, { status: 'cleared', accountId: acc })).toThrow(/cannot be marked/)
    deleteCheque(ctx, b)
  })

  it('an issued cheque pays the supplier when it clears', () => {
    const { ctx, sup, bill, acc } = shop()
    const id = saveCheque(ctx, { direction: 'issued', chequeNo: '778801', bank: 'Meezan', partyId: sup, amount: 10000, chequeDate: day(3), accountId: acc, documentId: bill })
    expect(docDue(ctx.db, bill)).toBe(24000)
    const before = accountBalance(ctx.db, acc)
    setChequeStatus(ctx, id, { status: 'cleared' })
    expect(docDue(ctx.db, bill)).toBe(14000)
    expect(accountBalance(ctx.db, acc)).toBe(before - 10000)
    expect(() => setChequeStatus(ctx, saveCheque(ctx, { direction: 'issued', chequeNo: '9', partyId: sup, amount: 1, chequeDate: day(1) }), { status: 'deposited' })).toThrow(/Only a cheque received can be deposited/)
  })

  it('checks the input: party, duplicates, amount, linked invoice, edit rules', () => {
    const { ctx, cust, sup, sale, bill } = shop()
    expect(() => saveCheque(ctx, { direction: 'received', chequeNo: '1', amount: 100, chequeDate: day(1) })).toThrow(/Select the customer/)
    expect(() => saveCheque(ctx, { direction: 'received', chequeNo: '1', partyId: sup, amount: 100, chequeDate: day(1) })).toThrow(/comes from a customer/)
    expect(() => saveCheque(ctx, { direction: 'issued', chequeNo: '1', partyId: cust, amount: 100, chequeDate: day(1) })).toThrow(/goes to a supplier/)
    expect(() => saveCheque(ctx, { direction: 'received', chequeNo: '1', partyId: cust, amount: 0, chequeDate: day(1) })).toThrow(/amount/)
    expect(() => saveCheque(ctx, { direction: 'received', chequeNo: '1', partyId: cust, amount: 5, chequeDate: 'soon' })).toThrow(/invalid/i)
    expect(() => saveCheque(ctx, { direction: 'received', chequeNo: '1', partyId: cust, amount: 5, chequeDate: day(1), documentId: bill })).toThrow(/does not belong/)
    const id = saveCheque(ctx, { direction: 'received', chequeNo: '55', bank: 'HBL', partyId: cust, amount: 500, chequeDate: day(2), documentId: sale })
    expect(() => saveCheque(ctx, { direction: 'received', chequeNo: '55', bank: 'HBL', partyId: cust, amount: 600, chequeDate: day(2) })).toThrow(/already in the register/)
    saveCheque(ctx, { id, direction: 'received', chequeNo: '55', bank: 'HBL', partyId: cust, amount: 700, chequeDate: day(4), documentId: sale })
    expect((listCheques(ctx) as Array<Record<string, any>>)[0]).toMatchObject({ amount: 700, cheque_date: day(4) })
    setChequeStatus(ctx, id, { status: 'cancelled' })
    expect(() => saveCheque(ctx, { id, direction: 'received', chequeNo: '55', bank: 'HBL', partyId: cust, amount: 1, chequeDate: day(4) })).toThrow(/Only a pending cheque can be edited/)
  })

  it('summarises open, overdue and due-this-week cheques and counts alerts for the bell', () => {
    const { ctx, cust, sup } = shop()
    saveCheque(ctx, { direction: 'received', chequeNo: 'a', partyId: cust, amount: 1000, chequeDate: day(-3) })
    saveCheque(ctx, { direction: 'received', chequeNo: 'b', partyId: cust, amount: 2000, chequeDate: today() })
    saveCheque(ctx, { direction: 'received', chequeNo: 'c', partyId: cust, amount: 4000, chequeDate: day(5) })
    saveCheque(ctx, { direction: 'received', chequeNo: 'd', partyId: cust, amount: 8000, chequeDate: day(40) })
    saveCheque(ctx, { direction: 'issued', chequeNo: 'e', partyId: sup, amount: 500, chequeDate: day(2) })
    const s = chequeSummary(ctx) as Record<string, { n: number; total: number }>
    expect(s.receivedOpen).toEqual({ n: 4, total: 15000 })
    expect(s.issuedOpen).toEqual({ n: 1, total: 500 })
    expect(s.overdue).toEqual({ n: 1, total: 1000 })
    expect(s.dueThisWeek).toEqual({ n: 3, total: 6500 })
    expect(chequeAlerts(ctx)).toEqual({ overdue: 1, today: 1 })
    expect((listCheques(ctx, { direction: 'issued' }) as unknown[]).length).toBe(1)
  })

  it('needs the cheque permissions: an Accountant works with cheques, a Salesperson cannot', () => {
    const { ctx, cust } = shop()
    const accountant = userCtx(ctx, 'Accountant', 'acct1')
    expect(saveCheque(accountant, { direction: 'received', chequeNo: 'z', partyId: cust, amount: 100, chequeDate: day(1) })).toBeGreaterThan(0)
    const sales = userCtx(ctx, 'Salesperson', 'sales1')
    expect(() => listCheques(sales)).toThrow(/permission/i)
    expect(chequeAlerts(sales)).toEqual({ overdue: 0, today: 0 })
  })
})
