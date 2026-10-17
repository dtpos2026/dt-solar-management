/**
 * Pure billing maths (no firebase imports - unit tested from tests/portal-billing.test.ts).
 * All money values are rounded to 2 decimals.
 */
export type LineKind = 'plan' | 'extra_firm' | 'extra_device' | 'other'
export interface LineInput { kind: LineKind; description: string; qty: number; rate: number }
export interface Line extends LineInput { amount: number }
export interface Totals { lines: Line[]; subtotal: number; discount: number; taxRate: number; taxAmount: number; total: number }
export type BillStatus = 'unpaid' | 'partial' | 'paid' | 'cancelled'

export function round2(n: number): number {
  if (!Number.isFinite(n)) return 0
  return Math.round((n + Number.EPSILON) * 100) / 100
}

const nonNeg = (n: number) => (Number.isFinite(n) && n > 0 ? n : 0)

export function lineAmount(qty: number, rate: number): number {
  return round2(nonNeg(qty) * nonNeg(rate))
}

export function buildLines(lines: LineInput[]): Line[] {
  return lines
    .filter((l) => nonNeg(l.qty) > 0 && (l.description.trim() !== '' || nonNeg(l.rate) > 0))
    .map((l) => ({ kind: l.kind, description: l.description.trim(), qty: nonNeg(l.qty), rate: round2(nonNeg(l.rate)), amount: lineAmount(l.qty, l.rate) }))
}

export function subtotalOf(lines: Pick<Line, 'amount'>[]): number {
  return round2(lines.reduce((s, l) => s + l.amount, 0))
}

/** Discount is clamped to [0, subtotal]; tax applies to (subtotal - discount). */
export function computeTotals(input: LineInput[], discount: number, taxRate: number): Totals {
  const lines = buildLines(input)
  const subtotal = subtotalOf(lines)
  const disc = round2(Math.min(nonNeg(discount), subtotal))
  const rate = Math.min(nonNeg(taxRate), 100)
  const taxAmount = round2(((subtotal - disc) * rate) / 100)
  const total = round2(subtotal - disc + taxAmount)
  return { lines, subtotal, discount: disc, taxRate: rate, taxAmount, total }
}

export function statusFor(total: number, paid: number): Exclude<BillStatus, 'cancelled'> {
  if (paid <= 0) return 'unpaid'
  if (round2(total - paid) <= 0) return 'paid'
  return 'partial'
}

export interface PaymentResult { paid: number; balance: number; status: Exclude<BillStatus, 'cancelled'> }

/** Applies a payment. Throws on non-positive amounts and on over-payment. */
export function applyPayment(total: number, paid: number, amount: number): PaymentResult {
  const a = round2(amount)
  if (!(a > 0)) throw new Error('Payment amount must be greater than zero.')
  const balance = round2(total - paid)
  if (a > balance) throw new Error(`Payment exceeds the outstanding balance (${balance.toFixed(2)}).`)
  const p = round2(paid + a)
  return { paid: p, balance: round2(total - p), status: statusFor(total, p) }
}

/** Reverses a (voided) payment. */
export function voidPayment(total: number, paid: number, amount: number): PaymentResult {
  const p = Math.max(0, round2(paid - round2(amount)))
  return { paid: p, balance: round2(total - p), status: statusFor(total, p) }
}

/** Re-computes paid/balance/status after editing totals (paid is kept). */
export function rebalance(total: number, paid: number): PaymentResult {
  if (paid > total + 0.001) throw new Error('New total is lower than the amount already paid.')
  return { paid: round2(paid), balance: round2(total - paid), status: statusFor(total, paid) }
}

export type DisplayStatus = BillStatus | 'overdue'
export function displayStatus(inv: { status: BillStatus; balance: number; dueDate: Date | null }, now = new Date()): DisplayStatus {
  if (inv.status === 'cancelled') return 'cancelled'
  if (inv.balance > 0 && inv.dueDate && inv.dueDate.getTime() < now.getTime()) return 'overdue'
  return inv.status
}

/** "Waseem Solar Store" -> "W***** S**** S****" (first letter of each word kept). */
export function maskName(name: string): string {
  return name
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => (w.length <= 1 ? w : w[0] + '*'.repeat(w.length - 1)))
    .join(' ')
}

export function publicCustomerName(name: string, privacy: 'full' | 'masked' | 'hidden'): string {
  if (privacy === 'hidden') return ''
  if (privacy === 'full') return name.trim()
  return maskName(name)
}

const TOKEN_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
/** 32-char token from a random byte source (rejection sampling, no modulo bias). */
export function makeToken(randomBytes: (n: number) => Uint8Array, len = 32): string {
  let out = ''
  while (out.length < len) {
    for (const b of randomBytes(len * 2)) {
      if (b < 248 && out.length < len) out += TOKEN_ALPHABET[b % 62]
    }
  }
  return out
}
export function isValidToken(t: string): boolean {
  return /^[A-Za-z0-9]{32}$/.test(t)
}

export function formatNumber(prefix: string, n: number, pad = 5): string {
  return `${prefix}${String(Math.max(1, Math.floor(n))).padStart(pad, '0')}`
}

export function money(n: number, currency = 'PKR'): string {
  return `${currency} ${round2(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

/** Invoice style amount: "Rs 32,320" (decimals only when needed). Other currencies keep their code. */
export function rs(n: number, currency = 'PKR'): string {
  const v = round2(n)
  const text = v.toLocaleString('en-US', { minimumFractionDigits: Number.isInteger(v) ? 0 : 2, maximumFractionDigits: 2 })
  return `${currency === 'PKR' ? 'Rs' : currency} ${text}`
}

/** The same amount without a currency prefix, for table cells. */
export function plainAmount(n: number): string {
  const v = round2(n)
  return v.toLocaleString('en-US', { minimumFractionDigits: Number.isInteger(v) ? 0 : 2, maximumFractionDigits: 2 })
}

export function monthKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

export function toCsv(rows: (string | number)[][]): string {
  return rows.map((r) => r.map((c) => { const s = String(c); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s }).join(',')).join('\n')
}

/** Group-sum helper used by the reports. */
export function sumBy<T>(items: T[], key: (t: T) => string, val: (t: T) => number): { key: string; value: number; count: number }[] {
  const m = new Map<string, { value: number; count: number }>()
  for (const it of items) {
    const k = key(it)
    const e = m.get(k) ?? { value: 0, count: 0 }
    e.value = round2(e.value + val(it))
    e.count++
    m.set(k, e)
  }
  return [...m.entries()].map(([k, v]) => ({ key: k, ...v })).sort((a, b) => a.key.localeCompare(b.key))
}
