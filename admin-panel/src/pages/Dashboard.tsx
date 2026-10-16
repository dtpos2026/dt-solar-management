/**
 * Dashboard: summary cards, recent activity (searchable) and on-demand trends.
 *
 * Reads are kept small: licenses / clients / invoices come from shared live listeners (lib/liveData — one listener per
 * collection for every page, so status changes appear at once and moving between pages does not re-read), online
 * computers are aggregation counts on heartbeats, the activity table reads the latest 100 entries, and payment
 * sub-collections are only read for the charts when the admin opens them.
 */
import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { Timestamp, collection, getCountFromServer, getDocs, limit, orderBy, query, where } from 'firebase/firestore'
import {
  Activity,
  BadgeCheck,
  Ban,
  BarChart3,
  Building2,
  ChevronDown,
  ChevronRight,
  CircleDollarSign,
  Clock,
  Inbox,
  LayoutDashboard,
  LifeBuoy,
  MonitorSmartphone,
  PauseCircle,
  RefreshCw,
  ShieldAlert,
  Zap
} from 'lucide-react'
import { db } from '../firebase'
import { PageTitle, cx } from '../components/ui'
import { EmptyState, ErrorState, Notice, Pager, SearchBox, Section, SkeletonRows, StatCard, usePaged } from '../components/kit'
import { auditCol, licenseBucketOf, licenseFromSnap, licensesCol, requestsCol } from '../lib/licenses'
import { clientFromSnap, clientsCol } from '../lib/clientsDb'
import { heartbeatsCol, invoiceRow, loadPayments, threadRow, type ThreadRow } from '../lib/fleet'
import { billingSummary, bucketByMonth, monthStart, niceMax, ONLINE_MS, RECENT_MS, type MonthBucket } from '../lib/stats'
import { actionLabel, auditRowFromData, summarizeRecentEvents, type AuditRow } from '../lib/auditLog'
import { invoicesWithPaymentsSince } from '../lib/billingViews'
import { useSharedBranding, useCachedValue, useSharedDocs } from '../lib/liveData'
import { useCan } from '../lib/auth'
import { useSigningKey } from '../lib/signingKey'
import { fmtDateTime, timeAgo } from '../lib/format'
import { fmtCount, fmtMoney, Pill } from './licensing/kit'
import { BILLING_READ_PERMS, DEVICE_READ_PERMS, HEARTBEAT_READ_PERMS, LICENSE_READ_PERMS } from './licensing/hooks'

const DAY = 86_400_000
const RECENT_PAGE = 100
const monthInput = (ms: number) => { const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}` }
const fromMonthInput = (s: string): number | null => { const m = /^(\d{4})-(\d{2})$/.exec(s); return m ? new Date(Number(m[1]), Number(m[2]) - 1, 1).getTime() : null }

const CATEGORY_TONE: Record<string, string> = {
  security: 'bg-red-50 text-red-700', financial: 'bg-emerald-50 text-emerald-700', license: 'bg-[#f1e9fb] text-[#3d096d]', client: 'bg-sky-50 text-sky-700',
  device: 'bg-indigo-50 text-indigo-700', support: 'bg-amber-50 text-amber-800', settings: 'bg-slate-100 text-slate-700', general: 'bg-slate-100 text-slate-600'
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

/** Online / recent / total heartbeat counts (3 aggregation queries instead of reading every heartbeat). */
async function loadHeartbeatCounts(): Promise<{ online: number; recent: number; total: number }> {
  const now = Date.now()
  const c = (q: ReturnType<typeof query>) => getCountFromServer(q).then((s) => s.data().count)
  const [online, recent, total] = await Promise.all([
    c(query(heartbeatsCol(), where('lastSeen', '>=', Timestamp.fromMillis(now - ONLINE_MS)))),
    c(query(heartbeatsCol(), where('lastSeen', '>=', Timestamp.fromMillis(now - RECENT_MS)))),
    c(query(heartbeatsCol()))
  ])
  return { online, recent, total }
}

/** Support threads that need an answer: open ones and unread ones (two small equality queries, no composite index). */
async function loadAttention(): Promise<ThreadRow[]> {
  const col = collection(db, 'supportThreads')
  const [open, unread] = await Promise.all([getDocs(query(col, where('status', '==', 'open'), limit(20))), getDocs(query(col, where('unreadByAdmin', '==', true), limit(20)))])
  const m = new Map<string, ThreadRow>()
  for (const d of [...unread.docs, ...open.docs]) m.set(d.id, threadRow(d))
  return [...m.values()].sort((a, b) => Number(b.unreadByAdmin) - Number(a.unreadByAdmin) || (b.lastMessageAtMs ?? 0) - (a.lastMessageAtMs ?? 0))
}

async function loadRecent(): Promise<AuditRow[]> {
  const s = await getDocs(query(auditCol(), orderBy('at', 'desc'), limit(RECENT_PAGE)))
  return s.docs.map((d) => auditRowFromData(d.id, d.data()))
}

export function Dashboard() {
  const can = useCan()
  const any = (p: string[]) => p.some(can)
  const { key } = useSigningKey()
  const branding = useSharedBranding()
  const canLic = any(LICENSE_READ_PERMS)
  const canBilling = any(BILLING_READ_PERMS)
  const canDevices = any(DEVICE_READ_PERMS)
  const canHb = any(HEARTBEAT_READ_PERMS)
  const canClients = can('clients.view')
  const canRequests = can('devices.manage') || can('licenses.manage')
  const canAudit = can('audit.view')

  const lic = useSharedDocs('licenses', licensesCol, canLic)
  const cli = useSharedDocs('clients', clientsCol, canClients)
  const inv = useSharedDocs('invoices', () => collection(db, 'invoices'), canBilling)
  const req = useSharedDocs('requests:pending', () => query(requestsCol(), where('status', '==', 'pending')), canRequests)
  const hb = useCachedValue('heartbeats:counts', loadHeartbeatCounts, null, canHb, 60_000)
  const recent = useCachedValue('audit:recent', loadRecent, [] as AuditRow[], canAudit, 30_000)
  const attention = useCachedValue('support:attention', loadAttention, [] as ThreadRow[], can('support.manage'), 30_000)

  const licenses = useMemo(() => lic.docs.map(licenseFromSnap), [lic.docs])
  const clients = useMemo(() => cli.docs.map(clientFromSnap), [cli.docs])
  const invoices = useMemo(() => inv.docs.map(invoiceRow), [inv.docs])
  const now = Date.now()
  const thisMonth = monthStart(now)

  // Payments of this month only (invoices whose last payment is this month) for "Revenue this month".
  const monthInvoices = useMemo(() => invoicesWithPaymentsSince(invoices.filter((i) => i.status !== 'cancelled'), thisMonth), [invoices, thisMonth])
  const monthKeyStr = monthInvoices.map((i) => `${i.id}:${i.lastPaymentAtMs}`).join(',')
  const monthPay = useCachedValue(`payments:since:${thisMonth}:${monthKeyStr}`, () => loadPayments(monthInvoices), null, canBilling && !inv.loading, 60_000)

  const buckets = useMemo(() => {
    const out: Record<string, number> = { active: 0, pending: 0, suspended: 0, revoked: 0, expired: 0, detached: 0 }
    for (const l of licenses) { out[licenseBucketOf(l)]++; if (l.detached) out.detached++ }
    return out
  }, [licenses])
  const approvedDevices = useMemo(() => licenses.filter((l) => l.status !== 'revoked').reduce((s, l) => s + Math.max(0, l.activeDevices || 0), 0), [licenses])
  const sum = useMemo(() => billingSummary(invoices, monthPay.value, now), [invoices, monthPay.value, now])
  const events = useMemo(() => summarizeRecentEvents(recent.value, now - 7 * DAY, RECENT_PAGE), [recent.value, now])
  const cur = branding.currency || 'PKR'
  const plus = (n: number, truncated: boolean) => `${fmtCount(n)}${truncated ? '+' : ''}`
  const liveClients = clients.filter((c) => c.status !== 'archived')

  return (
    <div>
      <PageTitle icon={<LayoutDashboard />} title="Dashboard" sub={`Live overview · ${new Date(thisMonth).toLocaleString(undefined, { month: 'long', year: 'numeric' })}`} />
      {!key && canRequests && (
        <Notice tone="warn" className="mb-4">No signing key loaded — approvals and certificate publishing need it. <Link className="font-semibold underline" to="/key">Load key</Link></Notice>
      )}
      {[lic.error, cli.error, inv.error].filter(Boolean).map((e) => <Notice key={e} tone="error" className="mb-3">{e}</Notice>)}

      <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        {canClients && <StatCard icon={<Building2 />} label="Clients" value={fmtCount(liveClients.length)} sub={`${clients.filter((c) => c.status === 'suspended').length} suspended`} loading={cli.loading} to="/clients" />}
        {canLic && <StatCard icon={<BadgeCheck />} tone="green" label="Active licenses" value={fmtCount(buckets.active)} sub={`${buckets.pending} awaiting first activation`} loading={lic.loading} to="/licenses" />}
        {canLic && <StatCard icon={<PauseCircle />} tone="amber" label="Suspended licenses" value={fmtCount(buckets.suspended)} sub={buckets.detached ? `${buckets.detached} detached (lifetime)` : 'apps blocked until reactivated'} loading={lic.loading} to="/licenses" />}
        {canLic && <StatCard icon={<Ban />} tone="red" label="Expired / revoked" value={`${fmtCount(buckets.expired)} / ${fmtCount(buckets.revoked)}`} sub="renew or re-issue" loading={lic.loading} to="/licenses" />}
        {canDevices && (
          <StatCard
            icon={<MonitorSmartphone />}
            tone="sky"
            label="Approved devices"
            value={fmtCount(approvedDevices)}
            sub={hb.value ? `${hb.value.online} online now · ${hb.value.recent} in 24 h` : canHb ? (hb.error ? 'online status unavailable' : '…') : 'online status needs Devices'}
            loading={lic.loading}
            to="/devices"
            title="Active computers on non-revoked licenses (from the licenses’ device counters) · online = heartbeat in the last 30 minutes"
          />
        )}
        {canRequests && <StatCard icon={<Inbox />} tone={req.docs.length ? 'amber' : 'slate'} label="Pending device requests" value={fmtCount(req.docs.length)} sub="activation requests to approve" loading={req.loading} to="/licenses?tab=requests" />}
      </div>

      {(canAudit || canBilling) && (
        <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
          {canAudit && <StatCard icon={<Zap />} tone="green" label="Activations · 7 days" value={plus(events.activations, events.truncated)} sub="device activations & requests" loading={recent.loading && !recent.value.length} to="/activity" />}
          {canAudit && <StatCard icon={<ShieldAlert />} tone="red" label="Security events · 7 days" value={plus(events.security, events.truncated)} sub={`${events.failures} failed action(s)`} loading={recent.loading && !recent.value.length} to="/activity" />}
          {canBilling && <StatCard icon={<CircleDollarSign />} label="Total sales" value={fmtMoney(sum.sales, cur)} sub={`${sum.invoiceCount} invoice(s)`} loading={inv.loading} to="/billing" />}
          {canBilling && <StatCard icon={<CircleDollarSign />} tone="green" label="Revenue this month" value={sum.revenueThisMonth === null ? '—' : fmtMoney(sum.revenueThisMonth, cur)} sub="payments received" loading={inv.loading || monthPay.loading} to="/billing" />}
          {canBilling && <StatCard icon={<Clock />} tone="amber" label="Outstanding" value={fmtMoney(sum.outstanding, cur)} sub={`${sum.outstandingCount} open invoice(s)`} loading={inv.loading} to="/billing" />}
          {canBilling && <StatCard icon={<Clock />} tone="red" label="Overdue" value={fmtMoney(sum.overdue, cur)} sub={`${sum.overdueCount} invoice(s) past due`} loading={inv.loading} to="/billing" />}
        </div>
      )}

      <div className="grid gap-4 xl:grid-cols-3">
        {canAudit && (
          <div className="xl:col-span-2">
            <RecentActivity rows={recent.value} loading={recent.loading} error={recent.error} onRefresh={recent.reload} licenses={licenses} clients={clients} />
          </div>
        )}
        {can('support.manage') && (
          <Section title={<><LifeBuoy />Support needing attention</>} actions={<Link className="text-[12.5px] font-semibold text-[#3d096d] hover:underline" to="/support">Open support</Link>}>
            {attention.loading && !attention.value.length ? <SkeletonRows rows={4} cols={2} /> : attention.error ? <ErrorState error={attention.error} onRetry={attention.reload} /> : attention.value.length === 0 ? (
              <EmptyState icon={<LifeBuoy />} title="Nothing waiting" hint="Open or unread conversations appear here." />
            ) : (
              <ul className="divide-y divide-[#f1ecf7] text-[13px]">
                {attention.value.slice(0, 10).map((t) => (
                  <li key={t.id} className="px-4 py-2.5">
                    <div className="flex items-center justify-between gap-2">
                      <Link className="truncate font-semibold text-[#3d096d] hover:underline" to={`/support/${t.id}`}>{t.companyName || t.contactName || t.id}</Link>
                      {t.unreadByAdmin ? <Pill value="pending" label="unread" /> : <Pill value={t.status} />}
                    </div>
                    <div className="flex justify-between gap-2 text-[12px] text-[#7a6d92]"><span className="truncate">{t.lastMessagePreview}</span><span className="shrink-0">{timeAgo(t.lastMessageAtMs)}</span></div>
                  </li>
                ))}
              </ul>
            )}
          </Section>
        )}
      </div>

      {(canBilling || canLic) && <Trends canBilling={canBilling} canLic={canLic} invoices={invoices} licenses={licenses} currency={cur} />}
    </div>
  )
}

function RecentActivity({ rows, loading, error, onRefresh, licenses, clients }: { rows: AuditRow[]; loading: boolean; error: string | null; onRefresh: () => void; licenses: ReturnType<typeof licenseFromSnap>[]; clients: ReturnType<typeof clientFromSnap>[] }) {
  const [q, setQ] = useState('')
  const names = useMemo(() => {
    const m = new Map<string, string>()
    for (const c of clients) m.set(c.id, c.company)
    for (const l of licenses) m.set(l.id, l.businessName || l.customerName || l.licenseKey)
    return m
  }, [licenses, clients])
  const who = (r: AuditRow) => (r.licenseId && names.get(r.licenseId)) || names.get(r.target) || ''
  const list = useMemo(() => {
    const s = q.trim().toLowerCase()
    return s ? rows.filter((r) => `${actionLabel(r.action)} ${r.action} ${r.category} ${r.by} ${r.target} ${r.details} ${who(r)}`.toLowerCase().includes(s)) : rows
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, q, names])
  const paged = usePaged(list, 10, q)
  return (
    <Section
      title={<><Activity />Recent activity</>}
      sub={`Latest ${RECENT_PAGE} entries`}
      actions={
        <>
          <SearchBox className="w-56" value={q} onChange={setQ} placeholder="Search activity…" />
          <button className="btn btn-secondary btn-sm" onClick={onRefresh} disabled={loading} aria-label="Refresh activity"><RefreshCw className={cx('h-4 w-4', loading && 'animate-spin')} /></button>
          <Link className="text-[12.5px] font-semibold text-[#3d096d] hover:underline" to="/activity">View all</Link>
        </>
      }
    >
      {loading && !rows.length ? <SkeletonRows rows={6} cols={4} /> : error ? <ErrorState error={error} onRetry={onRefresh} /> : list.length === 0 ? (
        <EmptyState icon={<Activity />} title={rows.length ? 'Nothing matches the search' : 'No activity yet'} hint={rows.length ? 'Try another word.' : 'Admin and device actions appear here.'} />
      ) : (
        <>
          <div className="tbl-wrap">
            <table className="tbl">
              <thead><tr><th className="w-36">Time</th><th>Event</th><th>Client / device</th><th>By</th></tr></thead>
              <tbody>
                {paged.slice.map((r) => (
                  <tr key={r.id}>
                    <td className="text-[12.5px] whitespace-nowrap text-[#6b5d85]" title={fmtDateTime(r.atMs)}>{fmtDateTime(r.atMs)}</td>
                    <td>
                      <div className="flex items-center gap-2">
                        <span className="font-semibold">{actionLabel(r.action)}</span>
                        <span className={cx('rounded-md px-1.5 py-0.5 text-[10.5px] font-bold capitalize', CATEGORY_TONE[r.category] ?? CATEGORY_TONE.general)}>{r.category}</span>
                        {r.status === 'failure' && <Pill value="rejected" label="failed" />}
                      </div>
                      <div className="max-w-[420px] truncate text-[12px] text-[#7a6d92]" title={r.details}>{r.details}</div>
                    </td>
                    <td className="max-w-[200px]">
                      <div className="truncate">{who(r) || '—'}</div>
                      {(r.licenseId || r.target) && <div className="truncate font-mono text-[11px] text-[#7a6d92]">{r.licenseId || r.target}</div>}
                    </td>
                    <td className="max-w-[180px] truncate text-[12.5px]" title={r.by}>{r.by || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pager {...paged} noun="entries" />
        </>
      )}
    </Section>
  )
}

/** Monthly revenue + new licenses; payments are read only when this panel is opened. */
function Trends({ canBilling, canLic, invoices, licenses, currency }: { canBilling: boolean; canLic: boolean; invoices: ReturnType<typeof invoiceRow>[]; licenses: ReturnType<typeof licenseFromSnap>[]; currency: string }) {
  const read = () => { try { return localStorage.getItem('dtsp.dash.trends') === '1' } catch { return false } }
  const [open, setOpenState] = useState(read)
  const setOpen = (v: boolean) => { setOpenState(v); try { localStorage.setItem('dtsp.dash.trends', v ? '1' : '0') } catch { /* private mode */ } }
  const now = Date.now()
  const [from, setFrom] = useState(monthInput(new Date(new Date().getFullYear(), new Date().getMonth() - 11, 1).getTime()))
  const [to, setTo] = useState(monthInput(now))
  const fromMs = fromMonthInput(from) ?? 0
  const toMonth = fromMonthInput(to)
  const toMs = toMonth === null ? -1 : new Date(new Date(toMonth).getFullYear(), new Date(toMonth).getMonth() + 1, 1).getTime() - 1
  const need = useMemo(() => invoicesWithPaymentsSince(invoices.filter((i) => i.status !== 'cancelled'), fromMs), [invoices, fromMs])
  const pay = useCachedValue(`payments:since:${fromMs}:${need.map((i) => `${i.id}:${i.lastPaymentAtMs}`).join(',')}`, () => loadPayments(need), null, open && canBilling, 60_000)
  const revenue = useMemo(
    () => (pay.value ? bucketByMonth(pay.value.filter((p) => !p.cancelled), fromMs, toMs, (p) => p.dateMs, (p) => p.amount) : bucketByMonth(invoices.filter((i) => i.status !== 'cancelled'), fromMs, toMs, (i) => i.issueDateMs, (i) => i.total)),
    [pay.value, invoices, fromMs, toMs]
  )
  const newLic = useMemo(() => bucketByMonth(licenses, fromMs, toMs, (l) => l.createdAt?.toMillis() ?? null), [licenses, fromMs, toMs])
  return (
    <Section
      className="mt-4"
      title={<button className="flex items-center gap-2" onClick={() => setOpen(!open)} aria-expanded={open}>{open ? <ChevronDown /> : <ChevronRight />}<BarChart3 />Trends</button>}
      sub={open ? undefined : 'Monthly revenue and new licenses — opens on demand (reads payment records).'}
      actions={open && <div className="flex items-center gap-2 text-[12.5px]">From <input type="month" className="input h-8 w-auto" value={from} onChange={(e) => setFrom(e.target.value)} /> to <input type="month" className="input h-8 w-auto" value={to} onChange={(e) => setTo(e.target.value)} /></div>}
    >
      {open && (
        <div className="grid gap-4 px-4 py-3 lg:grid-cols-2">
          {canBilling && (
            <div>
              <div className="mb-1 text-[13px] font-semibold">Monthly revenue {pay.value ? '(payments received)' : pay.loading ? '(loading payments…)' : '(invoiced)'}</div>
              {pay.error && <Notice tone="error" className="mb-2">{pay.error}</Notice>}
              <BarChart data={revenue} money currency={currency} />
            </div>
          )}
          {canLic && <div><div className="mb-1 text-[13px] font-semibold">New licenses per month</div><BarChart data={newLic} line /></div>}
        </div>
      )}
    </Section>
  )
}
