/** Billing — software sales invoices, payments, receipts and reports (Modules 1.6 / 3). */
import { useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { BarChart3, FileText, Plus, Receipt } from 'lucide-react'
import { PageTitle, Stat } from '../components/ui'
import { EmptyState, Loading, NoAccess, Notice, Pager, SearchBox, Tabs, usePaged } from '../components/kit'
import { money, monthKey, round2 } from '../lib/billing'
import { fmtDate, fromInputDate, toDate } from '../lib/format'
import { useCan } from '../lib/auth'
import { InvoiceForm } from './billing/InvoiceForm'
import { InvoiceDetail } from './billing/InvoiceDetail'
import { BillingReports } from './billing/Reports'
import { StatusPill, invStatus, useBranding, useClients, useInvoices } from './billing/common'

type Tab = 'invoices' | 'reports'
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
  const { invoices, loading, error } = useInvoices()
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
        title="Billing"
        sub="Software sales invoices, payments and receipts"
        actions={can('billing.create') && <button className="btn btn-primary" onClick={() => setForm(true)} disabled={!can('clients.view')} title={can('clients.view') ? '' : 'Needs “View clients” to pick a client'}><Plus className="h-4 w-4" /> New invoice</button>}
      />
      {error && <Notice tone="error" className="mb-3">{error}</Notice>}
      <div className="mb-5 grid grid-cols-5 gap-3">
        <Stat label={`Total sales (${summary.count})`} value={money(summary.sales, cur)} />
        <Stat label="Paid" value={money(summary.paid, cur)} tone="text-green-700" />
        <Stat label="Outstanding" value={money(summary.outstanding, cur)} tone="text-amber-700" />
        <Stat label={`Overdue (${summary.overdueCount})`} value={money(summary.overdue, cur)} tone="text-red-600" />
        <Stat label={`This month (${summary.monthCount})`} value={money(summary.month, cur)} tone="text-[#3d096d]" />
      </div>
      <Tabs tabs={[{ id: 'invoices', label: 'Invoices', icon: <FileText /> }, { id: 'reports', label: 'Reports', icon: <BarChart3 /> }]} active={tab} onChange={setTab} />
      {tab === 'reports' ? <BillingReports invoices={invoices} currency={cur} /> : (
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
          {loading ? <Loading label="Loading invoices…" /> : list.length === 0 ? (
            <EmptyState icon={<Receipt />} title={invoices.length ? 'No invoice matches the filters' : 'No invoices yet'} hint={invoices.length ? 'Change the search or filters.' : 'Create the first invoice for a client.'} />
          ) : (
            <div className="overflow-x-auto">
              <table className="tbl text-[13px]">
                <thead><tr><th>Number</th><th>Client</th><th>Issued</th><th>Due</th><th className="text-right">Total</th><th className="text-right">Paid</th><th className="text-right">Balance</th><th>Status</th></tr></thead>
                <tbody>
                  {paged.slice.map((i) => (
                    <tr key={i.id} className="click" onClick={() => onOpen(i.id)}>
                      <td className="font-mono font-bold">{i.number}</td>
                      <td className="font-semibold">{i.clientName}{i.planType && <div className="text-[11.5px] font-normal capitalize text-[#7a6d92]">{i.planType}</div>}</td>
                      <td>{fmtDate(i.issueDate)}</td>
                      <td>{fmtDate(i.dueDate)}</td>
                      <td className="text-right">{money(i.total, i.currency)}</td>
                      <td className="text-right">{money(i.paid, '')}</td>
                      <td className="text-right font-semibold">{money(i.status === 'cancelled' ? 0 : i.balance, '')}</td>
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
