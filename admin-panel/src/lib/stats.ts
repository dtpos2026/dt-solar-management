/**
 * Pure metric helpers for the Super Admin dashboard, client and device pages.
 * No Firebase imports: everything here takes plain numbers (epoch milliseconds) so it is unit tested from the
 * root test suite (tests/portal-licensing.test.ts). Never fabricate numbers: callers pass `null` when a source
 * could not be read and the UI shows "—".
 */

/* ------------------------------------------------ online status ------------------------------------------------ */

/** A device is "online" when its last heartbeat is younger than this. */
export const ONLINE_MS = 30 * 60 * 1000
/** ... and "recent" when younger than this (otherwise "offline"). */
export const RECENT_MS = 24 * 60 * 60 * 1000
export const ONLINE_THRESHOLD_LABEL = 'online < 30 min · recent < 24 h · offline after that'

export type OnlineState = 'online' | 'recent' | 'offline' | 'never'

/** Online state from the heartbeat `lastSeen` (server time). A slightly future value (clock skew) counts as online. */
export function onlineState(lastSeenMs: number | null | undefined, now = Date.now()): OnlineState {
  if (lastSeenMs === null || lastSeenMs === undefined || !Number.isFinite(lastSeenMs) || lastSeenMs <= 0) return 'never'
  const age = now - lastSeenMs
  if (age < ONLINE_MS) return 'online'
  if (age < RECENT_MS) return 'recent'
  return 'offline'
}

export function countOnline(lastSeen: Array<number | null | undefined>, now = Date.now()): Record<OnlineState, number> {
  const out: Record<OnlineState, number> = { online: 0, recent: 0, offline: 0, never: 0 }
  for (const t of lastSeen) out[onlineState(t, now)]++
  return out
}

/* ------------------------------------------------ license buckets ------------------------------------------------ */

export type LicenseBucket = 'active' | 'suspended' | 'revoked' | 'expired' | 'pending'
export const LICENSE_BUCKETS: LicenseBucket[] = ['active', 'pending', 'suspended', 'revoked', 'expired']

export interface LicenseLike {
  status: string
  expiresAtMs: number | null
  activeDevices: number
  /** True when any device was ever activated (license.activatedAt set, or a device document exists). */
  everActivated: boolean
}

/**
 * Dashboard bucket of a license. Order matters: revoked / suspended win over expiry; an active license that
 * never had a device activated is "pending".
 */
export function licenseBucket(l: LicenseLike, now = Date.now()): LicenseBucket {
  if (l.status === 'revoked') return 'revoked'
  if (l.status === 'suspended') return 'suspended'
  if (l.expiresAtMs !== null && l.expiresAtMs <= now) return 'expired'
  if ((l.activeDevices ?? 0) <= 0 && !l.everActivated) return 'pending'
  return 'active'
}

export function countLicenseBuckets(list: LicenseLike[], now = Date.now()): Record<LicenseBucket, number> & { total: number } {
  const out = { active: 0, suspended: 0, revoked: 0, expired: 0, pending: 0, total: list.length }
  for (const l of list) out[licenseBucket(l, now)]++
  return out
}

/* ------------------------------------------------ billing ------------------------------------------------ */

export interface InvoiceLike {
  status: string
  total: number
  paid: number
  balance: number
  issueDateMs: number | null
  dueDateMs: number | null
  licenseId?: string
  clientId?: string
}

export interface PaymentLike {
  amount: number
  dateMs: number | null
  cancelled?: boolean
}

export interface BillingSummary {
  /** Sum of totals of all non-cancelled invoices ("total software sales"). */
  sales: number
  invoiceCount: number
  paidCount: number
  /** Money received on non-cancelled invoices (sum of `paid`). */
  collected: number
  outstandingCount: number
  /** Sum of open balances ("pending payments"). */
  outstanding: number
  overdueCount: number
  overdue: number
  /** Payments received in the calendar month of `now`; null when payments could not be read. */
  revenueThisMonth: number | null
  /** Invoiced (issue date) in the calendar month of `now`. */
  invoicedThisMonth: number
}

const money = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

export function monthStart(ms: number): number {
  const d = new Date(ms)
  return new Date(d.getFullYear(), d.getMonth(), 1).getTime()
}

export function nextMonthStart(ms: number): number {
  const d = new Date(ms)
  return new Date(d.getFullYear(), d.getMonth() + 1, 1).getTime()
}

export function billingSummary(invoices: InvoiceLike[], payments: PaymentLike[] | null, now = Date.now()): BillingSummary {
  const live = invoices.filter((i) => i.status !== 'cancelled')
  const m0 = monthStart(now)
  const m1 = nextMonthStart(now)
  const open = live.filter((i) => money(i.balance) > 0.005)
  const overdue = open.filter((i) => i.dueDateMs !== null && i.dueDateMs < now)
  return {
    sales: round2(live.reduce((a, i) => a + money(i.total), 0)),
    invoiceCount: live.length,
    paidCount: live.filter((i) => i.status === 'paid').length,
    collected: round2(live.reduce((a, i) => a + money(i.paid), 0)),
    outstandingCount: open.length,
    outstanding: round2(open.reduce((a, i) => a + money(i.balance), 0)),
    overdueCount: overdue.length,
    overdue: round2(overdue.reduce((a, i) => a + money(i.balance), 0)),
    revenueThisMonth:
      payments === null
        ? null
        : round2(payments.filter((p) => !p.cancelled && p.dateMs !== null && p.dateMs >= m0 && p.dateMs < m1).reduce((a, p) => a + money(p.amount), 0)),
    invoicedThisMonth: round2(live.filter((i) => i.issueDateMs !== null && i.issueDateMs >= m0 && i.issueDateMs < m1).reduce((a, i) => a + money(i.total), 0))
  }
}

/** Payment status of a license derived from its (non-cancelled) invoices. */
export function paymentStatusFromInvoices(invoices: InvoiceLike[]): 'paid' | 'partial' | 'unpaid' | 'none' {
  const live = invoices.filter((i) => i.status !== 'cancelled')
  if (!live.length) return 'none'
  if (live.every((i) => i.status === 'paid' || money(i.balance) <= 0.005)) return 'paid'
  if (live.some((i) => money(i.paid) > 0)) return 'partial'
  return 'unpaid'
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100
}

/* ------------------------------------------------ monthly series ------------------------------------------------ */

export interface MonthBucket {
  /** yyyy-mm (local time) */
  key: string
  label: string
  start: number
  value: number
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

export function monthKey(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

/** Every calendar month touched by [fromMs, toMs] (inclusive), oldest first. Capped at 120 months. */
export function monthRange(fromMs: number, toMs: number): MonthBucket[] {
  const out: MonthBucket[] = []
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs < fromMs) return out
  let cur = monthStart(fromMs)
  while (cur <= toMs && out.length < 120) {
    const d = new Date(cur)
    out.push({ key: monthKey(cur), label: `${MONTHS[d.getMonth()]} ${String(d.getFullYear()).slice(2)}`, start: cur, value: 0 })
    cur = nextMonthStart(cur)
  }
  return out
}

/** Sums `getValue` (default: count) per calendar month for items whose date falls inside [fromMs, toMs]. */
export function bucketByMonth<T>(items: T[], fromMs: number, toMs: number, getMs: (t: T) => number | null, getValue: (t: T) => number = () => 1): MonthBucket[] {
  const buckets = monthRange(fromMs, toMs)
  const idx = new Map(buckets.map((b, i) => [b.key, i]))
  for (const it of items) {
    const ms = getMs(it)
    if (ms === null || ms < fromMs || ms > toMs) continue
    const i = idx.get(monthKey(ms))
    if (i !== undefined) buckets[i].value = round2(buckets[i].value + money(getValue(it)))
  }
  return buckets
}

/** "Nice" upper bound for a chart axis (1, 2, 2.5, 5 × 10^n). */
export function niceMax(v: number): number {
  if (!Number.isFinite(v) || v <= 0) return 1
  const exp = Math.floor(Math.log10(v))
  const base = 10 ** exp
  for (const m of [1, 2, 2.5, 5, 10]) if (m * base >= v) return m * base
  return 10 * base
}

/* ------------------------------------------------ tables ------------------------------------------------ */

export function paginate<T>(list: T[], page: number, size: number): { rows: T[]; page: number; pages: number; from: number; to: number } {
  const pages = Math.max(1, Math.ceil(list.length / Math.max(1, size)))
  const p = Math.min(Math.max(1, Math.floor(page) || 1), pages)
  const from = (p - 1) * size
  const rows = list.slice(from, from + size)
  return { rows, page: p, pages, from: list.length ? from + 1 : 0, to: from + rows.length }
}
