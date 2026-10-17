/**
 * Billing overview tables (pure - no Firebase imports, unit tested in tests/portal-core.test.ts):
 * per-client totals and payment status, built only from existing invoice documents.
 */
export interface BillInvoice {
  id: string
  clientId: string
  clientName: string
  planType: string
  status: string
  total: number
  paid: number
  balance: number
  issueDateMs: number | null
  dueDateMs: number | null
  lastPaymentAtMs: number | null
}

export type PayState = 'paid' | 'partial' | 'unpaid' | 'overdue' | 'none'

export interface ClientBilling {
  clientId: string
  clientName: string
  planTypes: string[]
  invoices: number
  total: number
  paid: number
  balance: number
  overdue: number
  /** Earliest due date among invoices with a balance (null = nothing due). */
  nextDueMs: number | null
  lastPaymentAtMs: number | null
  /** First and last issue date (billing period covered). */
  firstIssueMs: number | null
  lastIssueMs: number | null
  state: PayState
}

const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100

/** True when an open invoice is past its due date. */
export function isOverdue(i: Pick<BillInvoice, 'status' | 'balance' | 'dueDateMs'>, now: number): boolean {
  return i.status !== 'cancelled' && i.balance > 0 && i.dueDateMs !== null && i.dueDateMs < now
}

/** Groups non-cancelled invoices per client; sorted by outstanding balance (highest first), then name. */
export function billingByClient(invoices: readonly BillInvoice[], now = Date.now()): ClientBilling[] {
  const m = new Map<string, ClientBilling>()
  for (const i of invoices) {
    if (i.status === 'cancelled') continue
    const key = i.clientId || `name:${i.clientName}`
    let c = m.get(key)
    if (!c) {
      c = { clientId: i.clientId, clientName: i.clientName || '-', planTypes: [], invoices: 0, total: 0, paid: 0, balance: 0, overdue: 0, nextDueMs: null, lastPaymentAtMs: null, firstIssueMs: null, lastIssueMs: null, state: 'none' }
      m.set(key, c)
    }
    c.invoices++
    c.total = r2(c.total + i.total)
    c.paid = r2(c.paid + i.paid)
    c.balance = r2(c.balance + Math.max(0, i.balance))
    if (isOverdue(i, now)) c.overdue = r2(c.overdue + i.balance)
    if (i.planType && !c.planTypes.includes(i.planType)) c.planTypes.push(i.planType)
    if (i.balance > 0 && i.dueDateMs !== null && (c.nextDueMs === null || i.dueDateMs < c.nextDueMs)) c.nextDueMs = i.dueDateMs
    if (i.lastPaymentAtMs !== null && (c.lastPaymentAtMs === null || i.lastPaymentAtMs > c.lastPaymentAtMs)) c.lastPaymentAtMs = i.lastPaymentAtMs
    if (i.issueDateMs !== null) {
      if (c.firstIssueMs === null || i.issueDateMs < c.firstIssueMs) c.firstIssueMs = i.issueDateMs
      if (c.lastIssueMs === null || i.issueDateMs > c.lastIssueMs) c.lastIssueMs = i.issueDateMs
    }
  }
  const out = [...m.values()]
  for (const c of out) c.state = c.overdue > 0 ? 'overdue' : c.total <= 0 ? 'none' : c.balance <= 0 ? 'paid' : c.paid > 0 ? 'partial' : 'unpaid'
  return out.sort((a, b) => b.balance - a.balance || a.clientName.localeCompare(b.clientName))
}

/** Totals per plan type (non-cancelled invoices). */
export function billingByPlan(invoices: readonly BillInvoice[]): { planType: string; invoices: number; total: number; paid: number; balance: number }[] {
  const m = new Map<string, { planType: string; invoices: number; total: number; paid: number; balance: number }>()
  for (const i of invoices) {
    if (i.status === 'cancelled') continue
    const k = i.planType || 'other'
    const p = m.get(k) ?? { planType: k, invoices: 0, total: 0, paid: 0, balance: 0 }
    p.invoices++
    p.total = r2(p.total + i.total)
    p.paid = r2(p.paid + i.paid)
    p.balance = r2(p.balance + Math.max(0, i.balance))
    m.set(k, p)
  }
  return [...m.values()].sort((a, b) => b.total - a.total)
}

/** Invoices whose payments must be read to know every payment dated on/after `sinceMs` (lastPaymentAt ≥ payment date). */
export function invoicesWithPaymentsSince<T extends Pick<BillInvoice, 'paid' | 'lastPaymentAtMs'>>(invoices: readonly T[], sinceMs: number | null): T[] {
  return invoices.filter((i) => i.paid > 0 && (sinceMs === null || i.lastPaymentAtMs === null || i.lastPaymentAtMs >= sinceMs))
}
