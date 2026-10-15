import { describe, expect, it } from 'vitest'
import {
  applyPayment, computeTotals, displayStatus, formatNumber, isValidToken, lineAmount, makeToken, maskName,
  publicCustomerName, rebalance, round2, statusFor, subtotalOf, sumBy, toCsv, voidPayment
} from '../admin-panel/src/lib/billing'
import { randomBytes } from 'node:crypto'

describe('portal billing maths', () => {
  it('rounds and computes line amounts', () => {
    expect(round2(1.005)).toBe(1.01)
    expect(lineAmount(3, 333.333)).toBe(1000)
    expect(lineAmount(-1, 50)).toBe(0)
    expect(subtotalOf([{ amount: 0.1 }, { amount: 0.2 }])).toBe(0.3)
  })
  it('computes subtotal, discount, tax and total', () => {
    const t = computeTotals(
      [
        { kind: 'plan', description: 'Yearly', qty: 1, rate: 20000 },
        { kind: 'extra_firm', description: 'Firm', qty: 2, rate: 2500 },
        { kind: 'extra_device', description: 'PC', qty: 1, rate: 1999.995 },
        { kind: 'other', description: '', qty: 1, rate: 0 }
      ],
      1000,
      17
    )
    expect(t.lines).toHaveLength(3)
    expect(t.subtotal).toBe(27000)
    expect(t.discount).toBe(1000)
    expect(t.taxAmount).toBe(4420)
    expect(t.total).toBe(30420)
    expect(computeTotals([{ kind: 'plan', description: 'x', qty: 1, rate: 100 }], 500, 0).total).toBe(0)
  })
  it('applies payments: partial, full, over-payment refused', () => {
    const p1 = applyPayment(1000, 0, 400)
    expect(p1).toEqual({ paid: 400, balance: 600, status: 'partial' })
    const p2 = applyPayment(1000, 400, 600)
    expect(p2).toEqual({ paid: 1000, balance: 0, status: 'paid' })
    expect(() => applyPayment(1000, 400, 600.01)).toThrow()
    expect(() => applyPayment(1000, 0, 0)).toThrow()
  })
  it('voids payments and rebalances', () => {
    expect(voidPayment(1000, 1000, 600)).toEqual({ paid: 400, balance: 600, status: 'partial' })
    expect(voidPayment(1000, 400, 400).status).toBe('unpaid')
    expect(rebalance(1500, 400).balance).toBe(1100)
    expect(() => rebalance(300, 400)).toThrow()
    expect(statusFor(0, 0)).toBe('unpaid')
  })
  it('derives overdue', () => {
    const now = new Date('2026-05-10')
    expect(displayStatus({ status: 'partial', balance: 10, dueDate: new Date('2026-05-01') }, now)).toBe('overdue')
    expect(displayStatus({ status: 'paid', balance: 0, dueDate: new Date('2026-05-01') }, now)).toBe('paid')
    expect(displayStatus({ status: 'cancelled', balance: 10, dueDate: new Date('2026-05-01') }, now)).toBe('cancelled')
    expect(displayStatus({ status: 'unpaid', balance: 10, dueDate: null }, now)).toBe('unpaid')
  })
  it('masks customer names', () => {
    expect(maskName('Waseem Solar Store')).toBe('W***** S**** S****')
    expect(publicCustomerName(' Ali  Khan ', 'full')).toBe('Ali  Khan')
    expect(publicCustomerName('Ali Khan', 'hidden')).toBe('')
    expect(publicCustomerName('A B', 'masked')).toBe('A B')
  })
  it('makes 32-char tokens and formats numbers', () => {
    const t = makeToken((n) => new Uint8Array(randomBytes(n)))
    expect(isValidToken(t)).toBe(true)
    expect(makeToken((n) => new Uint8Array(randomBytes(n)))).not.toBe(t)
    expect(isValidToken('abc')).toBe(false)
    expect(formatNumber('DT-INV-', 42)).toBe('DT-INV-00042')
    expect(formatNumber('R', 123456)).toBe('R123456')
  })
  it('csv + grouping', () => {
    expect(toCsv([['a', 'b,c'], [1, 'x"y']])).toBe('a,"b,c"\n1,"x""y"')
    expect(sumBy([{ k: 'b', v: 1 }, { k: 'a', v: 2 }, { k: 'b', v: 3 }], (x) => x.k, (x) => x.v)).toEqual([
      { key: 'a', value: 2, count: 1 },
      { key: 'b', value: 4, count: 2 }
    ])
  })
})
