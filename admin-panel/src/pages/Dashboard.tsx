/** Dashboard: live metrics from Firestore (only what the admin may read), SVG charts, recent activity. */
import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { getDocs, limit, orderBy, query } from 'firebase/firestore'
import { Activity, BadgeCheck, Building2, CreditCard, Inbox, LifeBuoy, MonitorSmartphone } from 'lucide-react'
import { PageTitle } from '../components/ui'
import { auditCol, auditFromSnap, licenseBucketOf } from '../lib/licenses'
import { loadPayments, loadThreads, type ThreadRow } from '../lib/fleet'
import { billingSummary, bucketByMonth, countOnline, LICENSE_BUCKETS, monthStart, niceMax, ONLINE_THRESHOLD_LABEL, type MonthBucket, type PaymentLike } from '../lib/stats'
import { useCan } from '../lib/auth'
import { useSigningKey } from '../lib/signingKey'
import { fmtDateTime } from '../lib/format'
import type { AuditEntry } from '../lib/types'
import { fmtCount, fmtMoney, Panel, Pill } from './licensing/kit'
import { BILLING_READ_PERMS, DEVICE_READ_PERMS, LICENSE_READ_PERMS, useBranding, useClients, useInvoices, useLicenses } from './licensing/hooks'
import { useFleet } from './licensing/useFleet'
import { usePendingRequests } from './Licenses'

const monthInput = (ms: number) => { const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}` }
const fromMonthInput = (s: string): number | null => { const m = /^(\d{4})-(\d{2})$/.exec(s); return m ? new Date(Number(m[1]), Number(m[2]) - 1, 1).getTime() : null }

function Card({ icon, label, value, sub, to }: { icon: React.ReactNode; label: string; value: React.ReactNode; sub?: React.ReactNode; to?: string }) {
  const body = (
    <div className="card h-full px-4 py-3 transition hover:shadow-md">
      <div className="flex items-center gap-2 text-[12px] font-semibold uppercase tracking-wide text-[#7a6d92]">{icon}{label}</div>
      <div className="mt-1 text-[24px] font-extrabold text-[#2b0750]">{value}</div>
      {sub && <div className="mt-0.5 text-[12px] text-[#7a6d92]">{sub}</div>}
    </div>
  )
  return to ? <Link to={to}>{body}</Link> : body
}

function BarChart({ data, money, currency, line }: { data: MonthBucket[]; money?: boolean; currency?: string; line?: boolean }) {
  const W = 640, H = 220, P = { l: 56, r: 12, t: 12, b: 28 }
  const max = niceMax(Math.max(0, ...data.map((d) => d.value)))
  const iw = W - P.l - P.r, ih = H - P.t - P.b
  const bw = data.length ? iw / data.length : 0
  const y = (v: number) => P.t + ih - (v / max) * ih
  const fmt = (v: number) => (money ? fmtMoney(v, currency).replace(/\.00$/, '') : fmtCount(v))
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((t) => t * max)
  const step = Math.max(1, Math.ceil(data.length / 12))
  if (!data.length) return <div className="px-4 py-10 text-center text-[13px] text-[#7a6d92]">Choose a valid date range.</div>
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img">
      {ticks.map((t) => (
        <g key={t}>
          <line x1={P.l} x2={W - P.r} y1={y(t)} y2={y(t)} stroke="#eee8f5" />
          <text x={P.l - 6} y={y(t) + 4} textAnchor="end" fontSize="10" fill="#7a6d92">{money ? (t >= 1000 ? `${Math.round(t / 1000)}k` : Math.round(t)) : Math.round(t * 10) / 10}</text>
        </g>
      ))}
      {line ? (
        <>
          <polyline fill="none" stroke="#7c3aed" strokeWidth="2.5" points={data.map((d, i) => `${P.l + bw * i + bw / 2},${y(d.value)}`).join(' ')} />
          {data.map((d, i) => <circle key={d.key} cx={P.l + bw * i + bw / 2} cy={y(d.value)} r="3.5" fill="#3d096d"><title>{`${d.label}: ${fmt(d.value)}`}</title></circle>)}
        </>
      ) : (
        data.map((d, i) => (
          <rect key={d.key} x={P.l + bw * i + bw * 0.18} width={bw * 0.64} y={y(d.value)} height={Math.max(0, P.t + ih - y(d.value))} rx="3" fill="url(#g)"><title>{`${d.label}: ${fmt(d.value)}`}</title></rect>
        ))
      )}
      {data.map((d, i) => i % step === 0 && <text key={d.key} x={P.l + bw * i + bw / 2} y={H - 8} textAnchor="middle" fontSize="10" fill="#7a6d92">{d.label}</text>)}
      <defs><linearGradient id="g" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stopColor="#7c3aed" /><stop offset="1" stopColor="#3d096d" /></linearGradient></defs>
    </svg>
  )
}

export function Dashboard() {
  const can = useCan()
  const any = (p: string[]) => p.some(can)
  const { key } = useSigningKey()
  const branding = useBranding()
  const canLic = any(LICENSE_READ_PERMS)
  const canBilling = any(BILLING_READ_PERMS)
  const canDevices = any(DEVICE_READ_PERMS)
  const licenses = useLicenses(canLic)
  const clients = useClients(can('clients.view'))
  const invoices = useInvoices(canBilling)
  const fleet = useFleet(canDevices, true)
  const pending = usePendingRequests(can('devices.manage') || can('licenses.manage'))
  const [payments, setPayments] = useState<PaymentLike[] | null>(null)
  const [recent, setRecent] = useState<AuditEntry[] | null>(null)
  const [threads, setThreads] = useState<ThreadRow[] | null>(null)
  const now = Date.now()
  const [from, setFrom] = useState(monthInput(new Date(new Date().getFullYear(), new Date().getMonth() - 11, 1).getTime()))
  const [to, setTo] = useState(monthInput(now))

  useEffect(() => {
    if (!canBilling || invoices.loading) return
    let alive = true
    loadPayments(invoices.data).then((p) => alive && setPayments(p), () => alive && setPayments(null))
    return () => { alive = false }
  }, [canBilling, invoices.loading, invoices.data])
  useEffect(() => {
    if (can('audit.view')) getDocs(query(auditCol(), orderBy('at', 'desc'), limit(10))).then((s) => setRecent(s.docs.map(auditFromSnap)), () => setRecent([]))
    if (can('support.manage')) loadThreads().then(setThreads, () => setThreads(null))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const buckets = useMemo(() => {
    const out: Record<string, number> = { active: 0, pending: 0, suspended: 0, revoked: 0, expired: 0, detached: 0 }
    for (const l of licenses.data) { out[licenseBucketOf(l)]++; if (l.detached) out.detached++ }
    return out
  }, [licenses.data])
  const sum = useMemo(() => billingSummary(invoices.data, payments), [invoices.data, payments])
  const registered = fleet.rows.filter((r) => r.deviceStatus !== 'unregistered')
  const online = useMemo(() => countOnline(fleet.rows.map((r) => r.lastSeenMs), fleet.loadedAt || now), [fleet.rows, fleet.loadedAt, now])

  const fromMs = fromMonthInput(from) ?? 0
  const toMonth = fromMonthInput(to)
  const toMs = toMonth === null ? -1 : new Date(new Date(toMonth).getFullYear(), new Date(toMonth).getMonth() + 1, 1).getTime() - 1
  const revenue = useMemo(
    () => (payments ? bucketByMonth(payments.filter((p) => !p.cancelled), fromMs, toMs, (p) => p.dateMs, (p) => p.amount) : bucketByMonth(invoices.data.filter((i) => i.status !== 'cancelled'), fromMs, toMs, (i) => i.issueDateMs, (i) => i.total)),
    [payments, invoices.data, fromMs, toMs]
  )
  const newLic = useMemo(() => bucketByMonth(licenses.data, fromMs, toMs, (l) => l.createdAt?.toMillis() ?? null), [licenses.data, fromMs, toMs])
  const attention = threads?.filter((t) => t.unreadByAdmin || t.status === 'open') ?? null
  const dash = (loading: boolean, v: React.ReactNode) => (loading ? '—' : v)
  const cur = branding.currency || 'PKR'

  return (
    <div>
      <PageTitle title="Dashboard" sub={`Live figures from Firestore · ${new Date(monthStart(now)).toLocaleString(undefined, { month: 'long', year: 'numeric' })}`} />
      {!key && (can('licenses.manage') || can('devices.manage')) && (
        <div className="mb-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-2.5 text-[13px] text-amber-800">No signing key loaded — approvals and certificate publishing need it. <Link className="font-semibold underline" to="/key">Load key</Link></div>
      )}

      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        {can('clients.view') && <Card icon={<Building2 className="h-4 w-4" />} label="Clients / companies" value={dash(clients.loading, fmtCount(clients.data.filter((c) => c.status !== 'archived').length))} sub={clients.loading ? undefined : `${clients.data.filter((c) => c.status === 'suspended').length} suspended · ${clients.data.filter((c) => c.status === 'archived').length} archived`} to="/clients" />}
        {canLic && <Card icon={<BadgeCheck className="h-4 w-4" />} label="Licenses" value={dash(licenses.loading, fmtCount(licenses.data.length))} sub={licenses.loading ? undefined : `${buckets.active} active · ${buckets.pending} pending (no computer yet)`} to="/licenses" />}
        {canDevices && <Card icon={<MonitorSmartphone className="h-4 w-4" />} label="Registered computers" value={dash(fleet.loading, fmtCount(registered.length))} sub={fleet.loading ? undefined : `${registered.filter((r) => r.deviceStatus === 'active').length} active`} to="/devices" />}
        {(can('devices.manage') || can('licenses.manage')) && <Card icon={<Inbox className="h-4 w-4" />} label="Pending activation requests" value={fmtCount(pending)} to="/licenses?tab=requests" />}
      </div>

      {canLic && (
        <Panel className="mb-4" title="License status">
          <div className="grid grid-cols-3 gap-3 px-4 py-3 md:grid-cols-6">
            {[...LICENSE_BUCKETS, 'detached'].map((b) => (
              <div key={b} className="rounded-lg bg-[#faf7fd] px-3 py-2"><Pill value={b} /><div className="mt-1 text-[20px] font-extrabold">{dash(licenses.loading, buckets[b])}</div></div>
            ))}
          </div>
        </Panel>
      )}

      {canDevices && (
        <Panel className="mb-4" title="Computers online" sub={`From desktop heartbeats: ${ONLINE_THRESHOLD_LABEL}`}>
          {!fleet.heartbeats ? <div className="px-4 py-3 text-[13px] text-[#7a6d92]">You may not read heartbeats — online status unknown (—).</div> : (
            <div className="grid grid-cols-2 gap-3 px-4 py-3 md:grid-cols-4">
              {(['online', 'recent', 'offline', 'never'] as const).map((s) => (
                <div key={s} className="rounded-lg bg-[#faf7fd] px-3 py-2"><Pill value={s} /><div className="mt-1 text-[20px] font-extrabold">{dash(fleet.loading, online[s])}</div></div>
              ))}
            </div>
          )}
        </Panel>
      )}

      {canBilling && (
        <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Card icon={<CreditCard className="h-4 w-4" />} label="Total software sales" value={dash(invoices.loading, fmtMoney(sum.sales, cur))} sub={invoices.loading ? undefined : `${sum.invoiceCount} invoice(s)`} to="/billing" />
          <Card icon={<CreditCard className="h-4 w-4" />} label="Paid vs outstanding" value={dash(invoices.loading, `${sum.paidCount} / ${sum.outstandingCount}`)} sub={invoices.loading ? undefined : `${sum.overdueCount} overdue`} to="/billing" />
          <Card icon={<CreditCard className="h-4 w-4" />} label="Revenue this month" value={dash(invoices.loading, sum.revenueThisMonth === null ? '—' : fmtMoney(sum.revenueThisMonth, cur))} sub="payments received" />
          <Card icon={<CreditCard className="h-4 w-4" />} label="Pending payments" value={dash(invoices.loading, fmtMoney(sum.outstanding, cur))} sub={invoices.loading ? undefined : `overdue ${fmtMoney(sum.overdue, cur)}`} />
        </div>
      )}

      {(canBilling || canLic) && (
        <Panel
          className="mb-4"
          title="Trends"
          actions={<div className="flex items-center gap-2 text-[13px]">From <input type="month" className="input w-auto" value={from} onChange={(e) => setFrom(e.target.value)} /> to <input type="month" className="input w-auto" value={to} onChange={(e) => setTo(e.target.value)} /></div>}
        >
          <div className="grid gap-4 px-4 py-3 lg:grid-cols-2">
            {canBilling && <div><div className="mb-1 text-[13px] font-semibold">Monthly revenue {payments ? '(payments received)' : '(invoiced)'}</div><BarChart data={revenue} money currency={cur} /></div>}
            {canLic && <div><div className="mb-1 text-[13px] font-semibold">New licenses per month</div><BarChart data={newLic} line /></div>}
          </div>
        </Panel>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        {can('audit.view') && (
          <Panel title={<span className="flex items-center gap-2"><Activity className="h-4 w-4" />Recent activity</span>} actions={<Link className="text-[13px] text-[#3d096d] underline" to="/activity">All</Link>}>
            {recent === null ? <div className="px-4 py-3 text-[#7a6d92]">Loading…</div> : recent.length === 0 ? <div className="px-4 py-3 text-[#7a6d92]">No activity yet.</div> : (
              <ul className="divide-y divide-[#f1ecf7] text-[13px]">
                {recent.map((a) => <li key={a.id} className="px-4 py-2"><b>{a.action.replace(/_/g, ' ')}</b> <span className="text-[#7a6d92]">· {fmtDateTime(a.at)} · {a.by}</span><div className="truncate text-[#5d4f78]">{a.details}</div></li>)}
              </ul>
            )}
          </Panel>
        )}
        {can('support.manage') && (
          <Panel title={<span className="flex items-center gap-2"><LifeBuoy className="h-4 w-4" />Support needing attention</span>} actions={<Link className="text-[13px] text-[#3d096d] underline" to="/support">Open support</Link>}>
            {attention === null ? <div className="px-4 py-3 text-[#7a6d92]">—</div> : attention.length === 0 ? <div className="px-4 py-3 text-[#7a6d92]">Nothing waiting.</div> : (
              <ul className="divide-y divide-[#f1ecf7] text-[13px]">
                {attention.slice(0, 10).map((t) => (
                  <li key={t.id} className="px-4 py-2">
                    <div className="flex justify-between gap-2"><Link className="font-semibold text-[#3d096d] underline" to={`/support/${t.id}`}>{t.companyName || t.contactName || t.id}</Link>{t.unreadByAdmin && <Pill value="pending" label="unread" />}</div>
                    <div className="truncate text-[#5d4f78]">{t.lastMessagePreview}</div>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        )}
      </div>
    </div>
  )
}
