/**
 * Final update: quotations (edit / cancel / reject, also after conversion), paid purchases (edit / cancel / delete with stock and
 * accounting adjustments). Real services on a real SQLite database.
 */
import { describe, expect, it } from 'vitest'
import { createAdjustment, saveProduct } from '../src/main/services/inventory'
import { partyBalance, saveParty } from '../src/main/services/parties'
import { cancelDocument, createDocument, deleteDocument, getDocument, prepareConversion, setQuotationStatus, updateDocument } from '../src/main/services/documents'
import { createPayment, createTransfer, deleteAccount, saveAccount, setAccountActive } from '../src/main/services/payments'
import { createExpense } from '../src/main/services/expenses'
import { closePeriod } from '../src/main/services/closing'
import { createFirm, deleteFirm, firmDeleteImpact, setFirmActive } from '../src/main/services/firms'
import { auditCsv, auditRowsFor, clearAudit, deleteUser, saveUser, setUserActive } from '../src/main/services/auth'
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


describe('accounts: deactivate and delete', () => {
  it('an unused account can be deleted; one with payments, expenses or transfers can only be deactivated', () => {
    const { ctx, cust, acc } = shop()
    const bank = saveAccount(ctx, { name: 'Meezan Bank', type: 'bank', openingBalance: 5000 })
    const spare = saveAccount(ctx, { name: 'Spare wallet', type: 'wallet' })
    // default account: never deleted or deactivated
    expect(() => deleteAccount(ctx, acc)).toThrow(/default account cannot be deleted/)
    expect(() => setAccountActive(ctx, acc, false)).toThrow(/default account cannot be deactivated/)
    // used by a transfer -> blocked, history stays
    createTransfer(ctx, { date: '2026-03-05', fromAccountId: bank, toAccountId: spare, amount: 100 })
    expect(() => deleteAccount(ctx, bank)).toThrow(/has 1 transfer/)
    expect(() => deleteAccount(ctx, spare)).toThrow(/has 1 transfer/)
    // used by a customer receipt and an expense -> blocked with both counts
    const cat = (ctx.db.prepare('SELECT id FROM expense_categories ORDER BY id LIMIT 1').get() as { id: number }).id
    createPayment(ctx, { direction: 'in', partyId: cust, amount: 1000, accountId: bank, date: '2026-03-05' } as never)
    createExpense(ctx, { date: '2026-03-06', categoryId: cat, amount: 50, paid: true, accountId: bank })
    expect(() => deleteAccount(ctx, bank)).toThrow(/1 payment, 1 expense, 1 transfer/)
    // deactivate keeps everything; it cannot then be chosen for a new entry; reactivate works
    setAccountActive(ctx, bank, false)
    expect(() => createExpense(ctx, { date: '2026-03-07', categoryId: cat, amount: 10, paid: true, accountId: bank })).toThrow(/inactive/)
    setAccountActive(ctx, bank, true)
    // a never-used account is deleted for good, with an audit entry
    const unused = saveAccount(ctx, { name: 'Unused', type: 'cash' })
    deleteAccount(ctx, unused)
    expect(ctx.db.prepare('SELECT id FROM accounts WHERE id = ?').get(unused)).toBeUndefined()
    expect(auditOf(ctx, 'account', unused).map((a) => a.action)).toEqual(['create', 'delete'])
    expect(() => deleteAccount(userCtx(ctx, 'Salesperson', 'seller1'), spare)).toThrow(/permission/i)
  })
})

describe('users: disable and delete', () => {
  it('guards the owner and yourself, refuses a user with responsibilities, and deletes a clean user', () => {
    const { ctx } = shop()
    const role = (ctx.db.prepare("SELECT id FROM roles WHERE name = 'Accountant'").get() as { id: number }).id
    const u = saveUser(ctx, { username: 'clerk2', fullName: 'Clerk Two', roleId: role, password: 'secret123', allFirms: true })
    const owner = ctx.user.id
    expect(() => deleteUser(ctx, owner)).toThrow(/owner account cannot be deleted/)
    expect(() => setUserActive(ctx, owner, false)).toThrow(/owner account cannot be disabled/)
    setUserActive(ctx, u, false)
    expect((ctx.db.prepare('SELECT is_active FROM users WHERE id = ?').get(u) as { is_active: number }).is_active).toBe(0)
    setUserActive(ctx, u, true)
    // a user who closed a day cannot be deleted
    const closer = saveUser(ctx, { username: 'closer1', fullName: 'Closer One', roleId: (ctx.db.prepare("SELECT id FROM roles WHERE name = 'Administrator'").get() as { id: number }).id, password: 'secret123', allFirms: true })
    const closerCtx = { ...ctx, user: { ...ctx.user, id: closer, isOwner: false, permissions: ['closing.manage'] } } as Ctx
    closePeriod(closerCtx, { kind: 'day', period: '2026-03-03' })
    expect(() => deleteUser(ctx, closer)).toThrow(/closing/)
    // the signed-in user cannot delete themselves; the clean user can be deleted and the audit keeps the name
    expect(() => deleteUser(userCtx(ctx, 'Administrator', 'boss2'), (ctx.db.prepare("SELECT id FROM users WHERE username = 'boss2'").get() as { id: number }).id)).toThrow(/signed in/)
    deleteUser(ctx, u)
    expect(ctx.db.prepare('SELECT id FROM users WHERE id = ?').get(u)).toBeUndefined()
    expect(auditOf(ctx, 'user', u).map((a) => a.action)).toEqual(['create', 'deactivate', 'activate', 'delete'])
  })
})

describe('firms: delete only when inactive and empty', () => {
  it('blocks the default, active and used firms; removes an inactive empty one with its own rows', () => {
    const { ctx } = shop()
    const f2 = createFirm(ctx, { name: 'Branch Lahore' }, 5)
    const f3 = createFirm(ctx, { name: 'Branch Karachi' }, 5)
    expect(firmDeleteImpact(ctx, ctx.firmId).blockedReason).toMatch(/default firm cannot be deleted/)
    expect(() => deleteFirm(ctx, f2)).toThrow(/Deactivate the firm first/)
    // a firm that has a closing is kept even when inactive
    closePeriod({ ...ctx, firmId: f3 }, { kind: 'day', period: '2026-03-03' })
    setFirmActive(ctx, f3, false, 5)
    expect(() => deleteFirm(ctx, f3)).toThrow(/1 day \/ month closing/)
    // the empty inactive firm is deleted together with its seeded account, sequences and warehouse
    setFirmActive(ctx, f2, false, 5)
    expect(firmDeleteImpact(ctx, f2).canDelete).toBe(true)
    deleteFirm(ctx, f2)
    for (const t of ['firms', 'accounts', 'doc_sequences', 'warehouses']) {
      const col = t === 'firms' ? 'id' : 'firm_id'
      expect((ctx.db.prepare(`SELECT COUNT(*) AS c FROM ${t} WHERE ${col} = ?`).get(f2) as { c: number }).c).toBe(0)
    }
    expect(auditOf(ctx, 'firm', f2).map((a) => a.action)).toEqual(['create', 'deactivate', 'delete'])
    // the firm that still has records is untouched
    expect(ctx.db.prepare('SELECT id FROM firms WHERE id = ?').get(f3)).toBeTruthy()
  })
})

describe('audit log: remove entries', () => {
  it('owner only; by date, selected or all; the removed rows are exported and the removal itself is recorded', () => {
    const { ctx } = shop()
    ctx.db.prepare("UPDATE audit_log SET ts = '2025-01-10 10:00:00' WHERE id IN (SELECT id FROM audit_log ORDER BY id LIMIT 3)").run()
    const admin = userCtx(ctx, 'Administrator', 'clerk3')
    const total = (ctx.db.prepare('SELECT COUNT(*) AS c FROM audit_log').get() as { c: number }).c
    expect(() => clearAudit(admin, { mode: 'all' }, 'x.csv')).toThrow(/Only the owner/)
    const old = auditRowsFor(ctx, { mode: 'before', before: '2025-12-31' })
    expect(old).toHaveLength(3)
    const csv = auditCsv(old)
    expect(csv.split('\r\n')).toHaveLength(4)
    expect(csv.startsWith('id,time,user')).toBe(true)
    expect(clearAudit(ctx, { mode: 'before', before: '2025-12-31' }, 'old.csv')).toBe(3)
    const rest = (ctx.db.prepare('SELECT COUNT(*) AS c FROM audit_log').get() as { c: number }).c
    expect(rest).toBe(total - 3 + 1) // + the entry that records the removal
    const rec = ctx.db.prepare("SELECT summary, details FROM audit_log WHERE action = 'clear' ORDER BY id DESC LIMIT 1").get() as { summary: string; details: string }
    expect(rec.summary).toMatch(/Removed 3 audit log entries/)
    expect(JSON.parse(rec.details)).toMatchObject({ mode: 'before', savedAs: 'old.csv' })
    // selected ids
    const ids = (ctx.db.prepare('SELECT id FROM audit_log ORDER BY id LIMIT 2').all() as Array<{ id: number }>).map((r) => r.id)
    expect(clearAudit(ctx, { mode: 'selected', ids }, 's.csv')).toBe(2)
    expect(() => clearAudit(ctx, { mode: 'selected', ids: [] }, 's.csv')).toThrow(/Select at least one/)
    expect(() => clearAudit(ctx, { mode: 'before', before: 'nonsense' }, 's.csv')).toThrow(/valid date/)
    // everything: only the removal record remains
    clearAudit(ctx, { mode: 'all' }, 'all.csv')
    expect((ctx.db.prepare('SELECT COUNT(*) AS c FROM audit_log').get() as { c: number }).c).toBe(1)
  })
})
