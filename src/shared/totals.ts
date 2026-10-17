import { num, round2, round3, round4 } from './money'

export interface ComputedTotals {
  subtotal: number
  lineDiscountTotal: number
  docDiscount: number
  taxTotal: number
  otherCharges: number
  roundOff: number
  netTotal: number
  grandTotal: number
}

/** Pure totals calculation - also used by tests and mirrored in the UI. */
export function computeTotals(
  lines: Array<{ qty: number; rate: number; discountPct?: number; discountAmt?: number; taxRate?: number }>,
  docDiscount = 0,
  otherCharges = 0,
  roundOff = 0
): { lines: Array<{ gross: number; discount: number; net: number; tax: number; total: number }>; totals: ComputedTotals } {
  const out = lines.map((l) => {
    const qty = round3(num(l.qty))
    const rate = round4(num(l.rate))
    const gross = round2(qty * rate)
    const discAmt = num(l.discountAmt)
    const discount = round2(discAmt > 0 ? discAmt : (gross * num(l.discountPct)) / 100)
    const net = round2(gross - discount)
    const tax = round2((net * num(l.taxRate)) / 100)
    return { gross, discount, net, tax, total: round2(net + tax) }
  })
  const subtotal = round2(out.reduce((a, l) => a + l.gross, 0))
  const lineDiscountTotal = round2(out.reduce((a, l) => a + l.discount, 0))
  const netSum = round2(out.reduce((a, l) => a + l.net, 0))
  const dd = round2(Math.min(Math.max(0, num(docDiscount)), netSum))
  const factor = netSum > 0 ? (netSum - dd) / netSum : 1
  const taxTotal = round2(out.reduce((a, l) => a + l.tax, 0) * factor)
  const oc = round2(num(otherCharges))
  const ro = round2(num(roundOff))
  const netTotal = round2(netSum - dd + oc + ro)
  return {
    lines: out,
    totals: {
      subtotal,
      lineDiscountTotal,
      docDiscount: dd,
      taxTotal,
      otherCharges: oc,
      roundOff: ro,
      netTotal,
      grandTotal: round2(netTotal + taxTotal)
    }
  }
}

