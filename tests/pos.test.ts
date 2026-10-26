/** POS: shifts, counter checkout with split payment and change, credit, rules, held bills, permissions. Real services on a real SQLite database. */
import { describe, expect, it } from 'vitest'
import { createAdjustment, saveProduct } from '../src/main/services/inventory'
import { partyBalance, saveParty } from '../src/main/services/parties'
import { cancelDocument, getDocument } from '../src/main/services/documents'
import { accountBalance, saveAccount } from '../src/main/services/payments'
import { updateSettings } from '../src/main/services/settings'
import { checkout, closeShift, cashMove, deleteHold, holdCart, listHolds, listShifts, openShift, recentSales, shiftReport, status } from '../src/main/services/pos'
import { cashAccount, qtyOf, setupCtx, userCtx, warehouse } from './helpers'

function counter(pos: Record<string, unknown> = {}) {
  const ctx = setupCtx()
  const wh = warehouse(ctx)
  const bulb = saveProduct(ctx, { name: 'LED Bulb 12W', salePrice: 250, barcode: '8901111000012' })
  const cable = saveProduct(ctx, { name: 'Cable 7/29 (coil)', salePrice: 12000, taxRate: 0 })
  createAdjustment(ctx, { date: '2026-01-01', warehouseId: wh, kind: 'opening', lines: [{ productId: bulb, qty: 200, unitCost: 150 }, { productId: cable, qty: 10, unitCost: 9000 }] })
  const cust = saveParty(ctx, { type: 'customer', name: 'Rana Electric Works' })
  updateSettings(ctx, { erp_modules: { pos: true }, pos_settings: pos })
  return { ctx, wh, bulb, cable, cust, cash: cashAccount(ctx) }
}
const line = (productId: number, qty: number, rate: number, extra: Record<string, unknown> = {}) => ({ productId, qty, rate, ...extra })

describe('POS module switch', () => {
  it('is off until the owner switches it on: nothing can be sold and the status says so', () => {
    const ctx = setupCtx()
    expect(status(ctx)).toMatchObject({ enabled: false, shift: null })
    expect(() => openShift(ctx, { openingCash: 1000 })).toThrow(/switched off/)
    expect(() => checkout(ctx, { lines: [], tenders: [] })).toThrow(/switched off/)
    updateSettings(ctx, { erp_modules: { pos: true } })
    expect(status(ctx)).toMatchObject({ enabled: true, shift: null, holds: 0 })
  })
})

describe('POS shifts and checkout', () => {
  it('needs an open shift (a setting) and one open shift per cashier', () => {
    const { ctx, bulb } = counter()
    expect(() => checkout(ctx, { lines: [line(bulb, 1, 250)], tenders: [{ method: 'cash', amount: 250 }] })).toThrow(/Open a shift/)
    openShift(ctx, { openingCash: 5000 })
    expect(() => openShift(ctx, { openingCash: 0 })).toThrow(/already have an open shift/)
    expect(status(ctx)).toMatchObject({ enabled: true, shift: { cash: { opening: 5000, expected: 5000 } } })
    const r = checkout(ctx, { lines: [line(bulb, 2, 250)], tenders: [{ method: 'cash', amount: 500 }] })
    expect(r).toMatchObject({ total: 500, paid: 500, change: 0, due: 0 })
    // with the setting off a sale needs no shift
    const loose = counter({ require_shift: false })
    expect(checkout(loose.ctx, { lines: [line(loose.bulb, 1, 250)], tenders: [{ method: 'cash', amount: 250 }] }).total).toBe(250)
  })

  it('makes an ordinary sales invoice: stock out, cash in the account, paid in full, linked to the shift', () => {
    const { ctx, bulb, cash } = counter()
    const shiftId = openShift(ctx, { openingCash: 1000 })
    const before = accountBalance(ctx.db, cash)
    const r = checkout(ctx, { lines: [line(bulb, 4, 250)], tenders: [{ method: 'cash', amount: 1000 }], notes: 'Counter 1' }) as { id: number; number: string }
    const doc = getDocument(ctx, r.id)
    expect(doc).toMatchObject({ doc_type: 'sale_invoice', grand_total: 1000, status: expect.any(String), deduct_stock: 1 })
    expect(qtyOf(ctx, bulb)).toBe(196)
    expect(accountBalance(ctx.db, cash)).toBe(before + 1000)
    expect(ctx.db.prepare('SELECT shift_id, cashier_id, tendered, change_given, cash_in FROM pos_sales WHERE document_id = ?').get(r.id)).toEqual({ shift_id: shiftId, cashier_id: ctx.user.id, tendered: 1000, change_given: 0, cash_in: 1000 })
    expect(r.number).toMatch(/^INV-/)
  })

  it('gives change on cash and splits a bill between card and cash', () => {
    const { ctx, bulb, cable, cash } = counter()
    openShift(ctx, { openingCash: 0 })
    const bank = saveAccount(ctx, { name: 'Meezan Bank', type: 'bank' } as never)
    const over = checkout(ctx, { lines: [line(cable, 1, 12000)], tenders: [{ method: 'cash', amount: 15000 }] })
    expect(over).toMatchObject({ total: 12000, paid: 12000, change: 3000, due: 0 })
    expect(ctx.db.prepare('SELECT SUM(amount) AS a FROM payments WHERE id IN (SELECT payment_id FROM payment_allocations WHERE document_id = ?)').get(over.id)).toEqual({ a: 12000 })
    // 3,000 bill: 1,000 on the card, the rest in cash with change
    const split = checkout(ctx, { lines: [line(bulb, 12, 250)], tenders: [{ method: 'card', amount: 1000 }, { method: 'cash', amount: 2500 }] })
    expect(split).toMatchObject({ total: 3000, paid: 3000, change: 500 })
    const methods = ctx.db.prepare('SELECT p.method, p.account_id, SUM(a.amount) AS amt FROM payment_allocations a JOIN payments p ON p.id = a.payment_id WHERE a.document_id = ? GROUP BY p.method ORDER BY p.method').all(split.id)
    expect(methods).toEqual([{ method: 'card', account_id: bank, amt: 1000 }, { method: 'cash', account_id: cash, amt: 2000 }])
    expect(ctx.db.prepare('SELECT tendered, change_given, cash_in FROM pos_sales WHERE document_id = ?').get(split.id)).toEqual({ tendered: 3500, change_given: 500, cash_in: 2000 })
    // a card cannot pay more than the bill
    expect(() => checkout(ctx, { lines: [line(bulb, 1, 250)], tenders: [{ method: 'card', amount: 300 }] })).toThrow(/more than what is left/)
  })

  it('walk-in customers pay in full; a chosen customer can leave a balance on credit when the setting allows it', () => {
    const { ctx, bulb, cust } = counter()
    openShift(ctx, { openingCash: 0 })
    expect(() => checkout(ctx, { lines: [line(bulb, 4, 250)], tenders: [{ method: 'cash', amount: 400 }] })).toThrow(/Walk-in sales must be paid in full/)
    const r = checkout(ctx, { partyId: cust, lines: [line(bulb, 4, 250)], tenders: [{ method: 'cash', amount: 400 }] })
    expect(r).toMatchObject({ total: 1000, paid: 400, due: 600 })
    expect(partyBalance(ctx, cust)).toBe(600)
    updateSettings(ctx, { pos_settings: { allow_credit: false } })
    expect(() => checkout(ctx, { partyId: cust, lines: [line(bulb, 4, 250)], tenders: [{ method: 'cash', amount: 400 }] })).toThrow(/Credit sales are switched off/)
    expect(() => checkout(ctx, { lines: [line(bulb, 1, 250)], tenders: [] })).toThrow(/Walk-in sales must be paid in full|Credit sales/)
  })

  it('applies the counter rules: discount, price change, empty cart, unknown method', () => {
    const { ctx, bulb } = counter()
    openShift(ctx, { openingCash: 0 })
    // discount: needs the setting and the permission
    const d = checkout(ctx, { lines: [line(bulb, 4, 250, { discountPct: 10 })], tenders: [{ method: 'cash', amount: 900 }] })
    expect(d.total).toBe(900)
    expect(checkout(ctx, { lines: [line(bulb, 4, 250)], docDiscount: 100, tenders: [{ method: 'cash', amount: 900 }] }).total).toBe(900)
    updateSettings(ctx, { pos_settings: { allow_discount: false } })
    expect(() => checkout(ctx, { lines: [line(bulb, 4, 250, { discountPct: 10 })], tenders: [{ method: 'cash', amount: 900 }] })).toThrow(/Discounts are switched off/)
    // price change
    expect(() => checkout(ctx, { lines: [line(bulb, 1, 200)], tenders: [{ method: 'cash', amount: 200 }] })).toThrow(/cannot be changed at the counter/)
    updateSettings(ctx, { pos_settings: { allow_price_change: true } })
    expect(checkout(ctx, { lines: [line(bulb, 1, 200)], tenders: [{ method: 'cash', amount: 200 }] }).total).toBe(200)
    expect(checkout(ctx, { lines: [{ description: 'Wiring labour', qty: 1, rate: 1500 }], tenders: [{ method: 'cash', amount: 1500 }] }).total).toBe(1500)
    expect(() => checkout(ctx, { lines: [], tenders: [] })).toThrow(/cart is empty/)
    expect(() => checkout(ctx, { lines: [line(bulb, 1, 200)], tenders: [{ method: 'cheque', amount: 200 }] })).toThrow(/Unknown payment method/)
    expect(() => checkout(ctx, { lines: [line(bulb, 500, 200)], tenders: [{ method: 'cash', amount: 100000 }] })).toThrow(/Insufficient stock/)
  })

  it('rounds the bill to the chosen step and shows the difference as round off', () => {
    const { ctx, bulb } = counter({ round_to: '10', allow_price_change: true })
    openShift(ctx, { openingCash: 0 })
    const r = checkout(ctx, { lines: [line(bulb, 3, 253)], tenders: [{ method: 'cash', amount: 760 }] })
    expect(r).toMatchObject({ total: 760, paid: 760, change: 0 })
    expect(getDocument(ctx, r.id as number)).toMatchObject({ grand_total: 760, round_off: 1 })
  })
})

describe('POS shift report and closing', () => {
  it('adds up sales by payment method, cash in and out, the expected drawer cash and the difference at closing', () => {
    const { ctx, bulb, cable, cust } = counter()
    const bank = saveAccount(ctx, { name: 'Meezan Bank', type: 'bank' } as never)
    openShift(ctx, { openingCash: 2000 })
    checkout(ctx, { lines: [line(bulb, 4, 250)], tenders: [{ method: 'cash', amount: 1000 }] }) // 1,000 cash
    checkout(ctx, { lines: [line(cable, 1, 12000)], tenders: [{ method: 'card', amount: 12000, accountId: bank }] }) // 12,000 card
    checkout(ctx, { partyId: cust, lines: [line(bulb, 8, 250)], tenders: [{ method: 'cash', amount: 500 }] }) // 500 cash, 1,500 on credit
    cashMove(ctx, { kind: 'in', amount: 300, reason: 'Change float' })
    expect(() => cashMove(ctx, { kind: 'out', amount: 100 })).toThrow(/what the cash taken out is for/)
    cashMove(ctx, { kind: 'out', amount: 200, reason: 'Tea and cartons' })
    const s = status(ctx) as { shift: Record<string, any> }
    expect(s.shift.sales).toMatchObject({ count: 3, total: 15000, items: 13 })
    expect(s.shift.byMethod).toEqual([{ method: 'card', amount: 12000 }, { method: 'cash', amount: 1500 }])
    expect(s.shift.credit).toBe(1500)
    expect(s.shift.cash).toMatchObject({ opening: 2000, sales: 1500, in: 300, out: 200, expected: 3600 })
    const closed = closeShift(ctx, { countedCash: 3550, notes: 'Short by fifty' }) as { shift: Record<string, any> }
    expect(closed.shift).toMatchObject({ status: 'closed', expected_cash: 3600, counted_cash: 3550, difference: -50 })
    expect(() => closeShift(ctx, { countedCash: 1 })).toThrow(/no open shift/)
    expect(() => checkout(ctx, { lines: [line(bulb, 1, 250)], tenders: [{ method: 'cash', amount: 250 }] })).toThrow(/Open a shift/)
    expect(status(ctx)).toMatchObject({ shift: null })
  })

  it('keeps the cash of a cancelled sale in the expected drawer total until it is paid back as cash out', () => {
    const { ctx, bulb } = counter()
    openShift(ctx, { openingCash: 0 })
    const a = checkout(ctx, { lines: [line(bulb, 4, 250)], tenders: [{ method: 'cash', amount: 1000 }] })
    checkout(ctx, { lines: [line(bulb, 2, 250)], tenders: [{ method: 'cash', amount: 500 }] })
    cancelDocument(ctx, a.id as number, 'Customer returned the bulbs')
    const s = status(ctx) as { shift: Record<string, any> }
    expect(s.shift.sales).toMatchObject({ count: 1, total: 500 })
    expect(s.shift.cancelled).toEqual({ count: 1, total: 1000 })
    expect(s.shift.cash.expected).toBe(1500)
    cashMove(ctx, { kind: 'out', amount: 1000, reason: 'Refund INV cancelled' })
    expect((status(ctx) as { shift: Record<string, any> }).shift.cash.expected).toBe(500)
  })
})

describe('held bills and recent sales', () => {
  it('holds a cart, lists it for every cashier, and a checkout from it removes the hold', () => {
    const { ctx, bulb } = counter()
    openShift(ctx, { openingCash: 0 })
    const id = holdCart(ctx, { label: 'Customer at the door', cart: { lines: [{ productId: bulb, qty: 3, rate: 250 }], partyId: null }, total: 750 })
    expect(status(ctx)).toMatchObject({ holds: 1 })
    const list = listHolds(ctx) as Array<{ id: number; label: string; total: number; cart: { lines: unknown[] } }>
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ id, label: 'Customer at the door', total: 750 })
    expect(list[0].cart.lines).toHaveLength(1)
    expect(() => holdCart(ctx, { cart: null })).toThrow(/nothing to hold/)
    checkout(ctx, { holdId: id, lines: [line(bulb, 3, 250)], tenders: [{ method: 'cash', amount: 750 }] })
    expect(listHolds(ctx)).toHaveLength(0)
    const other = holdCart(ctx, { cart: { lines: [] }, total: 0 })
    deleteHold(ctx, other)
    expect(listHolds(ctx)).toHaveLength(0)
  })

  it('lists the latest counter sales: a cashier sees their own, pos.reports sees all', () => {
    const { ctx, bulb } = counter()
    const cashier = userCtx(ctx, 'Salesperson', 'cashier1')
    openShift(ctx, { openingCash: 0 })
    openShift(cashier, { openingCash: 100 })
    checkout(ctx, { lines: [line(bulb, 1, 250)], tenders: [{ method: 'cash', amount: 250 }] })
    checkout(cashier, { lines: [line(bulb, 2, 250)], tenders: [{ method: 'cash', amount: 500 }] })
    expect((recentSales(ctx) as unknown[]).length).toBe(2)
    expect((recentSales(cashier) as unknown[]).length).toBe(1)
    expect((listShifts(ctx) as unknown[]).length).toBe(2)
    expect((listShifts(cashier) as unknown[]).length).toBe(1)
  })
})

describe('POS permissions', () => {
  it('a Salesperson can sell and run their own shift but cannot read another cashier shift; roles without POS rights are refused', () => {
    const { ctx, bulb } = counter()
    const cashier = userCtx(ctx, 'Salesperson', 'cashier1')
    const shiftId = openShift(ctx, { openingCash: 0 })
    openShift(cashier, { openingCash: 0 })
    expect(checkout(cashier, { lines: [line(bulb, 1, 250)], tenders: [{ method: 'cash', amount: 250 }] }).total).toBe(250)
    expect(() => shiftReport(cashier, shiftId)).toThrow(/permission/i)
    expect(shiftReport(ctx, shiftId)).toMatchObject({ cashier: 'Owner' })
    const stock = userCtx(ctx, 'Inventory Manager', 'stock1')
    expect(() => openShift(stock, { openingCash: 0 })).toThrow(/permission/i)
    expect(() => checkout(stock, { lines: [line(bulb, 1, 250)], tenders: [{ method: 'cash', amount: 250 }] })).toThrow(/permission/i)
    expect(status(stock)).toMatchObject({ enabled: true, shift: null })
  })
})
