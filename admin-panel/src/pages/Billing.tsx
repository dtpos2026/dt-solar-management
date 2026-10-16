/** Billing — software sales invoices, payments, receipts and reports (Modules 1.6 / 3). */
import { useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { AlertTriangle, BarChart3, Building2, CalendarClock, CheckCircle2, CircleDollarSign, CreditCard, FileText, Layers, Plus, Receipt, Wallet } from 'lucide-react'
import { PageTitle } from '../components/ui'
import { EmptyState, ErrorState, NoAccess, Pager, SearchBox, SkeletonRows, StatCard, Tabs, usePaged } from '../components/kit'
import { billingByClient, billingByPlan, type BillInvoice } from '../lib/billingViews'
import { useCachedValue } from '../lib/liveData'
import { money, monthKey, round2 } from '../lib/billing'
import { fmtDate, fromInputDate, toDate } from '../lib/format'
import { useCan } from '../lib/auth'
import { InvoiceForm } from './billing/InvoiceForm'
import { InvoiceDetail } from './billing/InvoiceDetail'
import { BillingReports } from './billing/Reports'
import { StatusPill, invStatus, loadInvoicePayments, useBranding, useClients, useInvoices, type PaymentRow } from './billing/common'
import type { Invoice } from '../lib/types'

type Tab = 'invoices' | 'clients' | 'plans' | 'payments' | 'reports'
const STATUSES = ['unpaid', 'partial', 'paid', 'overdue', 'cancelled'] as const

export function Billing() {
  const can = useCan()
  const { id } = useParams()
  const nav = useNavigate()
  const allowed = can('billing.view') || can('billing.create') || can('billing.payments')
  const branding = useBranding()
  const clients = useClients(allowed && can('clients.view'))
  if (!allowed) return <NoAccess what="Billing" need="View billing" />
  if (id) return <InvoiceDetail id={id} clients={clients} branding={branding} />
  return <BillingHome clients={clients} branding={branding} onOpen={(i) => nav(`/billing/${i}`)} />
}

function BillingHome({ clients, branding, onOpen }: { clients: ReturnType<typeof useClients>; branding: ReturnType<typeof useBranding>; onOpen: (id: string) => void }) {
  const can = useCan()
  const { invoices, loading, error, retry } = useInvoices()
  const [tab, setTab] = useState<Tab>('invoices')
  const [q, setQ] = useState('')
  const [status, setStatus] = useState('')
  const [clientId, setClientId] = useState('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [form, setForm] = useState(false)
  const cur = branding.currency || 'PKR'

  const summary = useMemo(() => {
    const live = invoices.filter((i) => i.status !== 'cancelled')
    const mk = monthKey(new Date())
    const overdue = live.filter((i) => invStatus(i) === 'overdue')
    const month = live.filter((i) => { const d = toDate(i.issueDate); return d && monthKey(d) === mk })
    const sum = (l: typeof live, f: (i: (typeof live)[number]) => number) => round2(l.reduce((s, i) => s + f(i), 0))
    return {
      sales: sum(live, (i) => i.total), count: live.length, paid: sum(live, (i) => i.paid), outstanding: sum(live, (i) => i.balance),
      overdue: sum(overdue, (i) => i.balance), overdueCount: overdue.length, month: sum(month, (i) => i.total), monthCount: month.length
    }
  }, [invoices])

  const clientOptions = useMemo(() => {
    const m = new Map<string, string>()
    for (const i of invoices) if (i.clientId) m.set(i.clientId, i.clientName)
    return [...m.entries()].sort((a, b) => a[1].localeCompare(b[1]))
  }, [invoices])

  const list = useMemo(() => {
    const s = q.trim().toLowerCase()
    const f = fromInputDate(from)
    const t = fromInputDate(to)
    return invoices.filter((i) => {
      if (s && !`${i.number} ${i.clientName} ${i.notes}`.toLowerCase().includes(s)) return false
      if (status && invStatus(i) !== status) return false
      if (clientId && i.clientId !== clientId) return false
      const d = toDate(i.issueDate)
      if (f && (!d || d < f)) return false
      if (t && (!d || d.getTime() > t.getTime() + 86400000 - 1)) return false
      return true
    })
  }, [invoices, q, status, clientId, from, to])
  const paged = usePaged(list, 15, `${q}|${status}|${clientId}|${from}|${to}`)

  return (
    <div>
      <PageTitle
        icon={<CreditCard />}
        title="Billing"
        sub="Software sales invoices, payments and receipts"
        actions={can('billing.create') && <button className="btn btn-primary" onClick={() => setForm(true)} disabled={!can('clients.view')} title={can('clients.view') ? '' : 'Needs “View clients” to pick a client'}><Plus className="h-4 w-4" /> New invoice</button>}
      />
      <div className="mb-5 grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
        <StatCard icon={<CircleDollarSign />} label="Total sales" value={money(summary.sales, cur)} sub={`${summary.count} invoice(s)`} loading={loading} />
        <StatCard icon={<CheckCircle2 />} tone="green" label="Paid" value={money(summary.paid, cur)} sub="received on these invoices" loading={loading} />
        <StatCard icon={<Wallet />} tone="amber" label="Outstanding" value={money(summary.outstanding, cur)} sub="open balances" loading={loading} />
        <StatCard icon={<AlertTriangle />} tone="red" label="Overdue" value={money(summary.overdue, cur)} sub={`${summary.overdueCount} invoice(s) past due`} loading={loading} />
        <StatCard icon={<CalendarClock />} tone="sky" label="Invoiced this month" value={money(summary.month, cur)} sub={`${summary.monthCount} invoice(s)`} loading={loading} />
      </div>
      <Tabs
        tabs={[
          { id: 'invoices', label: 'Invoices', icon: <FileText /> },
          { id: 'clients', label: 'By client', icon: <Building2 /> },
          { id: 'plans', label: 'By plan', icon: <Layers /> },
          { id: 'payments', label: 'Payment history', icon: <Receipt /> },
          { id: 'reports', label: 'Reports', icon: <BarChart3 /> }
        ]}
        active={tab}
        onChange={setTab}
      />
      {error ? <div className="card"><ErrorState error={error} onRetry={retry} /></div> : tab === 'reports' ? <BillingReports invoices={invoices} currency={cur} /> : tab === 'clients' ? <ClientTable invoices={invoices} currency={cur} loading={loading} /> : tab === 'plans' ? <PlanTable invoices={invoices} currency={cur} loading={loading} /> : tab === 'payments' ? <PaymentHistory invoices={invoices} loading={loading} onOpen={onOpen} /> : (
        <div className="card">
          <div className="flex flex-wrap items-center gap-2 border-b border-[#ece6f4] px-4 py-3">
            <SearchBox className="min-w-[220px] flex-1" value={q} onChange={setQ} placeholder="Search invoice no, client, notes…" />
            <select className="input w-auto" value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status">
              <option value="">All statuses</option>
              {STATUSES.map((s) => <option key={s} value={s}>{s[0].toUpperCase() + s.slice(1)}</option>)}
            </select>
            <select className="input w-auto max-w-[220px]" value={clientId} onChange={(e) => setClientId(e.target.value)} aria-label="Client">
              <option value="">All clients</option>
              {clientOptions.map(([cid, name]) => <option key={cid} value={cid}>{name}</option>)}
            </select>
            <input className="input w-auto" type="date" value={from} onChange={(e) => setFrom(e.target.value)} aria-label="Issued from" title="Issued from" />
            <span className="text-[12px] text-[#7a6d92]">to</span>
            <input className="input w-auto" type="date" value={to} onChange={(e) => setTo(e.target.value)} aria-label="Issued to" title="Issued to" />
          </div>
          {loading ? <SkeletonRows rows={8} cols={8} label="Loading invoices…" /> : list.length === 0 ? (
            <EmptyState icon={<Receipt />} title={invoices.length ? 'No invoice matches the filters' : 'No invoices yet'} hint={invoices.length ? 'Change the search or filters.' : 'Create the first invoice for a client.'} />
          ) : (
            <div className="tbl-wrap">
              <table className="tbl">
                <thead><tr><th>Number</th><th>Client</th><th>Issued</th><th>Due</th><th className="num">Total</th><th className="num">Paid</th><th className="num">Balance</th><th>Status</th></tr></thead>
                <tbody>
                  {paged.slice.map((i) => (
                    <tr key={i.id} className="click" onClick={() => onOpen(i.id)}>
                      <td className="font-mono font-bold">{i.number}</td>
                      <td className="font-semibold">{i.clientName}{i.planType && <div className="text-[11.5px] font-normal capitalize text-[#7a6d92]">{i.planType}</div>}</td>
                      <td>{fmtDate(i.issueDate)}</td>
                      <td>{fmtDate(i.dueDate)}</td>
                      <td className="num">{money(i.total, i.currency)}</td>
                      <td className="num">{money(i.paid, '')}</td>
                      <td className="num font-semibold">{money(i.status === 'cancelled' ? 0 : i.balance, '')}</td>
                      <td><StatusPill status={invStatus(i)} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <Pager {...paged} noun="invoices" />
        </div>
      )}
      {form && <InvoiceForm open clients={clients} branding={branding} onClose={() => setForm(false)} onSaved={(nid) => onOpen(nid)} />}
    </div>
  )
}

const ms = (t: { toMillis(): number } | null) => (t ? t.toMillis() : null)
function toBill(i: Invoice): BillInvoice {
  return { id: i.id, clientId: i.clientId, clientName: i.clientName, planType: i.planType, status: i.status, total: i.total, paid: i.paid, balance: i.balance, issueDateMs: ms(i.issueDate), dueDateMs: ms(i.dueDate), lastPaymentAtMs: ms(i.lastPaymentAt) }
}

/** Per-client billing: plans, amounts, billing period, payment status, next due date, last payment. */
function ClientTable({ invoices, currency, loading }: { invoices: Invoice[]; currency: string; loading: boolean }) {
  const [q, setQ] = useState('')
  const [state, setState] = useState('')
  const rows = useMemo(() => billingByClient(invoices.map(toBill)), [invoices])
  const list = useMemo(() => {
    const s = q.trim().toLowerCase()
    return rows.filter((r) => (!state || r.state === state) && (!s || r.clientName.toLowerCase().includes(s)))
  }, [rows, q, state])
  const paged = usePaged(list, 15, `${q}|${state}`)
  return (
    <div className="card">
      <div className="flex flex-wrap items-center gap-2 border-b border-[#ece6f4] px-4 py-3">
        <SearchBox className="min-w-[220px] flex-1" value={q} onChange={setQ} placeholder="Search client…" />
        <select className="input w-auto" value={state} onChange={(e) => setState(e.target.value)} aria-label="Payment status">
          <option value="">Any payment status</option>
          {['overdue', 'unpaid', 'partial', 'paid'].map((s) => <option key={s} value={s}>{s[0].toUpperCase() + s.slice(1)}</option>)}
        </select>
      </div>
      {loading ? <SkeletonRows rows={8} cols={8} /> : list.length === 0 ? <EmptyState icon={<Building2 />} title={rows.length ? 'No client matches' : 'No billed clients yet'} /> : (
        <div className="tbl-wrap">
          <table className="tbl">
            <thead><tr><th>Client</th><th>Plan</th><th>Billing period</th><th className="num">Invoices</th><th className="num">Invoiced</th><th className="num">Paid</th><th className="num">Balance</th><th>Next due</th><th>Last payment</th><th>Status</th></tr></thead>
            <tbody>
              {paged.slice.map((r) => (
                <tr key={r.clientId || r.clientName}>
                  <td className="font-semibold">{r.clientName}</td>
                  <td className="capitalize">{r.planTypes.join(', ') || '—'}</td>
                  <td className="text-[12.5px] whitespace-nowrap">{fmtDate(r.firstIssueMs)} – {fmtDate(r.lastIssueMs)}</td>
                  <td className="num">{r.invoices}</td>
                  <td className="num">{money(r.total, currency)}</td>
                  <td className="num">{money(r.paid, '')}</td>
                  <td className="num font-semibold">{money(r.balance, '')}</td>
                  <td className={r.overdue > 0 ? 'font-semibold text-red-600' : ''}>{fmtDate(r.nextDueMs)}</td>
                  <td>{fmtDate(r.lastPaymentAtMs)}</td>
                  <td><StatusPill status={r.state === 'none' ? 'no balance' : r.state} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Pager {...paged} noun="clients" />
    </div>
  )
}

function PlanTable({ invoices, currency, loading }: { invoices: Invoice[]; currency: string; loading: boolean }) {
  const rows = useMemo(() => billingByPlan(invoices.map(toBill)), [invoices])
  return (
    <div className="card overflow-hidden">
      {loading ? <SkeletonRows rows={3} cols={5} /> : rows.length === 0 ? <EmptyState icon={<Layers />} title="No invoices yet" /> : (
        <table className="tbl">
          <thead><tr><th>Plan</th><th className="num">Invoices</th><th className="num">Invoiced</th><th className="num">Paid</th><th className="num">Outstanding</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.planType}>
                <td className="font-semibold capitalize">{r.planType}</td>
                <td className="num">{r.invoices}</td>
                <td className="num">{money(r.total, currency)}</td>
                <td className="num">{money(r.paid, '')}</td>
                <td className="num font-semibold">{money(r.balance, '')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}

/** Every payment / receipt (read from the invoices' payment records when this tab is opened; cached briefly). */
function PaymentHistory({ invoices, loading, onOpen }: { invoices: Invoice[]; loading: boolean; onOpen: (id: string) => void }) {
  const key = invoices.filter((i) => i.lastPaymentAt || i.paid > 0).map((i) => `${i.id}:${i.paid}:${i.lastPaymentAt?.toMillis() ?? 0}`).join(',')
  const pay = useCachedValue(`payments:view:${key}`, () => loadInvoicePayments(invoices), [] as PaymentRow[], !loading, 120_000)
  const [q, setQ] = useState('')
  const [showVoid, setShowVoid] = useState(false)
  const list = useMemo(() => {
    const s = q.trim().toLowerCase()
    return pay.value.filter((p) => (showVoid || !p.cancelled) && (!s || `${p.receiptNo} ${p.invoiceNumber} ${p.clientName} ${p.method} ${p.reference}`.toLowerCase().includes(s)))
  }, [pay.value, q, showVoid])
  const paged = usePaged(list, 20, `${q}|${showVoid}`)
  return (
    <div className="card">
      <div className="flex flex-wrap items-center gap-2 border-b border-[#ece6f4] px-4 py-3">
        <SearchBox className="min-w-[220px] flex-1" value={q} onChange={setQ} placeholder="Search receipt, invoice, client, reference…" />
        <label className="flex h-9 items-center gap-2 rounded-lg border border-[#ddd5ea] bg-white px-3 text-[13px]"><input type="checkbox" checked={showVoid} onChange={(e) => setShowVoid(e.target.checked)} />Show voided</label>
      </div>
      {loading || (pay.loading && !pay.value.length) ? <SkeletonRows rows={8} cols={7} label="Loading payments…" /> : pay.error ? <ErrorState error={pay.error} onRetry={pay.reload} /> : list.length === 0 ? (
        <EmptyState icon={<Receipt />} title={pay.value.length ? 'No payment matches' : 'No payments recorded yet'} />
      ) : (
        <div className="tbl-wrap">
          <table className="tbl">
            <thead><tr><th>Date</th><th>Receipt</th><th>Invoice</th><th>Client</th><th>Method</th><th>Reference</th><th className="num">Amount</th><th>Status</th></tr></thead>
            <tbody>
              {paged.slice.map((p) => (
                <tr key={`${p.invoiceId}/${p.id}`} className={p.cancelled ? 'click opacity-60' : 'click'} onClick={() => onOpen(p.invoiceId)}>
                  <td className="whitespace-nowrap">{fmtDate(p.date)}</td>
                  <td className="font-mono text-[12.5px]">{p.receiptNo || '—'}</td>
                  <td className="font-mono text-[12.5px] font-bold">{p.invoiceNumber}</td>
                  <td>{p.clientName}</td>
                  <td className="capitalize">{p.method || '—'}</td>
                  <td className="max-w-[160px] truncate">{p.reference || '—'}</td>
                  <td className="num font-semibold">{money(p.amount, p.currency)}</td>
                  <td><StatusPill status={p.cancelled ? 'cancelled' : 'paid'} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Pager {...paged} noun="payments" />
    </div>
  )
}
