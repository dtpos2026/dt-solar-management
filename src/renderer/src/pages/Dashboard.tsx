import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  ShoppingCart, ShoppingBag, TrendingUp, Wallet, Users, Landmark, Boxes, FilePlus2, UserPlus, Truck, SunMedium, HandCoins, Receipt, AlertTriangle, BadgeDollarSign, Zap, Leaf, Sun, ArrowRight
} from 'lucide-react'
import { api } from '../api'
import { useApp, useCan } from '../store'
import { Badge, Button, Card, Empty, Loading, PeriodPicker, Progress, Select, StatCard, toast } from '../components/ui'
import { BarChart, Donut } from '../components/Charts'
import { date, label, money, monthStart, pct, qty, statusTone, today } from '../lib/format'

/* eslint-disable @typescript-eslint/no-explicit-any */
export function Dashboard(): JSX.Element {
  const can = useCan()
  const nav = useNavigate()
  const firm = useApp((s) => s.firm)
  const user = useApp((s) => s.user)
  const [from, setFrom] = useState(monthStart())
  const [to, setTo] = useState(today())
  const [scope, setScope] = useState<'firm' | 'all'>('firm')
  const [d, setD] = useState<any>(null)

  useEffect(() => {
    if (!can('dashboard.view')) return
    setD(null)
    api('reports.dashboard', { from, to, scope })
      .then(setD)
      .catch((e) => toast.error(e))
  }, [from, to, scope]) // eslint-disable-line react-hooks/exhaustive-deps

  if (!can('dashboard.view')) {
    return (
      <Card>
        <Empty icon={<Sun />} title={`Welcome, ${user?.fullName}`}>
          Use the menu on the left to get started.
        </Empty>
      </Card>
    )
  }

  const k = d?.kpis
  const hour = new Date().getHours()
  const greet = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening'
  const quick = [
    { label: 'New Sale', icon: <ShoppingCart />, to: '/doc/new/sale_invoice', perm: 'sales.create', tone: 'bg-blue-500' },
    { label: 'Create Quotation', icon: <FilePlus2 />, to: '/doc/new/quotation', perm: 'quotations.manage', tone: 'bg-emerald-500' },
    { label: 'Add Purchase', icon: <ShoppingBag />, to: '/doc/new/purchase_invoice', perm: 'purchases.create', tone: 'bg-orange-500' },
    { label: 'Receive Payment', icon: <HandCoins />, to: '/accounts?receive=1', perm: 'accounts.manage', tone: 'bg-teal-500' },
    { label: 'Add Customer', icon: <UserPlus />, to: '/customers?new=1', perm: 'customers.manage', tone: 'bg-violet-500' },
    { label: 'Add Supplier', icon: <Truck />, to: '/suppliers?new=1', perm: 'suppliers.manage', tone: 'bg-sky-500' },
    { label: 'New Project', icon: <SunMedium />, to: '/projects?new=1', perm: 'projects.manage', tone: 'bg-amber-500' },
    { label: 'Add Expense', icon: <Receipt />, to: '/expenses?new=1', perm: 'expenses.manage', tone: 'bg-rose-500' }
  ].filter((q) => can(q.perm))

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-[22px] font-bold tracking-tight">Dashboard</h1>
          <div className="text-[13px] text-muted">
            {greet}, {user?.fullName?.split(' ')[0]} · {scope === 'all' ? 'All firms (consolidated)' : firm?.name}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {can('reports.consolidated') && (useApp.getState().firms.length > 1) && (
            <Select sm className="w-44" value={scope} onChange={(e) => setScope(e.target.value as 'firm' | 'all')}>
              <option value="firm">This firm</option>
              <option value="all">All firms (consolidated)</option>
            </Select>
          )}
          <PeriodPicker from={from} to={to} onChange={(a, b) => { setFrom(a); setTo(b) }} />
        </div>
      </div>

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1fr)_300px]">
        <div className="space-y-5">
          {/* Hero */}
          <div className="relative overflow-hidden rounded-2xl bg-gradient-to-r from-[#0f2557] via-[#174a8f] to-[#1f7a4d] p-6 text-white shadow-md">
            <div className="absolute top-4 right-40 h-24 w-24 rounded-full bg-gradient-to-br from-[#ffe27a] to-[#f7931e] opacity-90 shadow-[0_0_60px_20px_rgba(255,177,43,0.35)]" />
            <div className="absolute right-0 bottom-0 grid w-[46%] origin-bottom-right -skew-x-12 grid-cols-6 gap-1.5 opacity-30">
              {Array.from({ length: 18 }).map((_, i) => (
                <div key={i} className="h-7 rounded-sm bg-gradient-to-br from-white to-blue-200" />
              ))}
            </div>
            <div className="relative flex flex-wrap items-end justify-between gap-6">
              <div>
                <div className="text-[30px] leading-tight font-extrabold">Clean Energy<br />Better Tomorrow</div>
                <div className="mt-2 text-[13.5px] text-white/80">Solar Solutions for Homes, Businesses &amp; Industries</div>
              </div>
              <div className="flex gap-6 text-[13px]">
                <div className="flex items-center gap-2"><Zap className="h-5 w-5 text-[#ffc24a]" /><div><div className="text-[18px] font-bold">{d ? qty(d.projectSummary.installedKw) : '—'} kW</div><div className="text-white/75">Installed capacity</div></div></div>
                <div className="flex items-center gap-2"><Sun className="h-5 w-5 text-[#ffc24a]" /><div><div className="text-[18px] font-bold">{d ? d.projectSummary.active : '—'}</div><div className="text-white/75">Active projects</div></div></div>
                <div className="flex items-center gap-2"><Leaf className="h-5 w-5 text-[#8bf00a]" /><div><div className="text-[18px] font-bold">{d ? qty(d.projectSummary.pipelineKw) : '—'} kW</div><div className="text-white/75">In pipeline</div></div></div>
              </div>
            </div>
          </div>

          {!d ? (
            <Loading />
          ) : (
            <>
              <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
                <StatCard label="Net Sales" value={money(k.sales)} icon={<ShoppingCart className="h-5 w-5" />} trend={k.salesTrend} sub="vs previous period" onClick={() => nav('/sales')} />
                <StatCard label="Net Purchases" value={money(k.purchases)} icon={<ShoppingBag className="h-5 w-5" />} tone="ok" trend={k.purchasesTrend} sub="vs previous period" onClick={() => nav('/purchases')} />
                {k.grossProfit !== null && <StatCard label="Gross Profit" value={money(k.grossProfit)} icon={<TrendingUp className="h-5 w-5" />} tone="sun" sub={k.grossMarginPct !== null ? `${pct(k.grossMarginPct)} margin` : undefined} />}
                {k.netProfit !== null && <StatCard label="Net Profit" value={<span className={k.netProfit < 0 ? 'text-bad' : ''}>{money(k.netProfit)}</span>} icon={<BadgeDollarSign className="h-5 w-5" />} tone={k.netProfit < 0 ? 'bad' : 'ok'} trend={k.netProfitTrend} sub="after expenses" />}
                <StatCard label="Customer Outstanding" value={money(k.receivables)} icon={<Users className="h-5 w-5" />} tone="info" sub={`${k.receivableCount} customer(s)${k.overdueInvoices ? ` · ${k.overdueInvoices} overdue` : ''}`} onClick={() => nav('/customers?due=1')} />
                <StatCard label="Supplier Payables" value={money(k.payables)} icon={<Truck className="h-5 w-5" />} tone="warn" onClick={() => nav('/suppliers?due=1')} />
                {k.cash !== null && <StatCard label="Cash & Bank" value={money((k.cash ?? 0) + (k.bank ?? 0))} icon={<Landmark className="h-5 w-5" />} tone="brand" sub={`Cash ${money(k.cash)} · Bank ${money(k.bank)}`} onClick={() => nav('/accounts')} />}
                {k.inventoryValue !== null && <StatCard label="Inventory Value" value={money(k.inventoryValue)} icon={<Boxes className="h-5 w-5" />} tone="info" sub="at average cost" onClick={() => nav('/inventory')} />}
              </div>

              <div className="grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
                <Card title="Sales & Purchases Overview" actions={<span className="text-[12px] text-muted">Last 12 months</span>}>
                  <BarChart
                    data={d.months}
                    series={[
                      { key: 'sales', label: 'Sales', color: 'var(--brand)' },
                      { key: 'purchases', label: 'Purchases', color: '#22c55e' },
                      ...(d.months[0]?.profit !== undefined ? [{ key: 'profit', label: 'Net profit', color: '#f7931e' }] : [])
                    ]}
                  />
                </Card>
                <Card title="Stock Status" actions={<Button size="sm" variant="ghost" onClick={() => nav('/inventory')}>View</Button>}>
                  <div className="flex items-center gap-4">
                    <Donut
                      center={String(d.stockStatus.total)}
                      sub="Total items"
                      parts={[
                        { label: 'In stock', value: d.stockStatus.inStock, color: '#22c55e' },
                        { label: 'Low', value: d.stockStatus.low, color: '#f59e0b' },
                        { label: 'Out', value: d.stockStatus.out, color: '#ef4444' }
                      ]}
                    />
                    <div className="flex-1 space-y-2.5 text-[13px]">
                      {[
                        ['In Stock', d.stockStatus.inStock, '#22c55e', ''],
                        ['Low Stock', d.stockStatus.low, '#f59e0b', 'low'],
                        ['Out of Stock', d.stockStatus.out, '#ef4444', 'out']
                      ].map(([l, v, c, f]) => (
                        <button key={String(l)} type="button" onClick={() => nav(`/inventory${f ? `?stock=${f}` : ''}`)} className="flex w-full items-center gap-2 rounded-lg px-2 py-1 hover:bg-surface-2 cursor-pointer">
                          <span className="h-2.5 w-2.5 rounded-full" style={{ background: String(c) }} />
                          <span className="flex-1 text-left">{l}</span>
                          <Badge>{String(v)}</Badge>
                        </button>
                      ))}
                    </div>
                  </div>
                  {d.alerts.length > 0 && (
                    <div className="mt-3 border-t border-line pt-3">
                      <div className="mb-1.5 flex items-center gap-1.5 text-[12px] font-semibold text-warn"><AlertTriangle className="h-3.5 w-3.5" /> Reorder soon</div>
                      {d.alerts.slice(0, 4).map((a: any) => (
                        <div key={a.id} className="flex justify-between py-0.5 text-[12.5px]">
                          <span className="truncate pr-2">{a.name}</span>
                          <span className={a.qty <= 0 ? 'font-semibold text-bad' : 'text-warn'}>{qty(a.qty)} {a.unit}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </Card>
              </div>

              <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
                {can('sales.view') && (
                  <Card title="Recent Sales" actions={<Button size="sm" variant="ghost" onClick={() => nav('/sales')}>View all</Button>} pad={false}>
                    <MiniDocs rows={d.recentSales} onOpen={(id) => nav(`/doc/${id}`)} />
                  </Card>
                )}
                {can('purchases.view') && (
                  <Card title="Recent Purchases" actions={<Button size="sm" variant="ghost" onClick={() => nav('/purchases')}>View all</Button>} pad={false}>
                    <MiniDocs rows={d.recentPurchases} onOpen={(id) => nav(`/doc/${id}`)} />
                  </Card>
                )}
              </div>

              <div className="grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
                {can('projects.view') && (
                  <Card title="Recent Solar Projects" actions={<Button size="sm" variant="ghost" onClick={() => nav('/projects')}>View all</Button>} pad={false}>
                    {d.recentProjects.length === 0 ? (
                      <Empty icon={<SunMedium />} title="No projects yet" />
                    ) : (
                      <table className="tbl">
                        <thead>
                          <tr><th>Project</th><th>Size</th><th>Status</th><th style={{ width: 130 }}>Progress</th>{d.recentProjects[0].netProfit !== null && <th className="text-right">Profit</th>}</tr>
                        </thead>
                        <tbody>
                          {d.recentProjects.map((p: any) => (
                            <tr key={p.id} className="clickable" onClick={() => nav(`/projects/${p.id}`)}>
                              <td><div className="font-medium">{p.name}</div><div className="text-[12px] text-muted">{p.code} · {p.customer_name ?? '—'}</div></td>
                              <td className="num">{qty(p.capacity_kw)} kW</td>
                              <td><Badge tone={statusTone(p.status)}>{label(p.status)}</Badge></td>
                              <td><div className="flex items-center gap-2"><Progress value={p.progress} tone={p.progress >= 100 ? 'ok' : 'brand'} /><span className="num w-9 text-right text-[12px] text-muted">{p.progress}%</span></div></td>
                              {p.netProfit !== null && <td className={`num text-right font-semibold ${p.netProfit < 0 ? 'text-bad' : 'text-ok'}`}>{money(p.netProfit)}</td>}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                  </Card>
                )}
                <Card title="Top Selling Products" pad={false}>
                  {d.topProducts.length === 0 ? (
                    <Empty title="No sales in this period" />
                  ) : (
                    <table className="tbl">
                      <thead><tr><th>Product</th><th className="text-right">Qty sold</th><th className="text-right">Amount</th></tr></thead>
                      <tbody>
                        {d.topProducts.map((p: any) => (
                          <tr key={p.name}><td className="font-medium">{p.name}</td><td className="num text-right">{qty(p.qty)} {p.unit ?? ''}</td><td className="num text-right">{money(p.amount)}</td></tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </Card>
              </div>
            </>
          )}
        </div>

        <div className="space-y-5">
          <Card title="Quick Actions">
            <div className="space-y-2">
              {quick.map((q) => (
                <button key={q.label} type="button" onClick={() => nav(q.to)} className="group flex w-full items-center gap-3 rounded-xl border border-line px-3 py-2.5 text-left transition hover:border-brand hover:bg-brand-soft cursor-pointer">
                  <span className={`flex h-9 w-9 items-center justify-center rounded-lg text-white [&>svg]:h-[18px] [&>svg]:w-[18px] ${q.tone}`}>{q.icon}</span>
                  <span className="flex-1 font-medium">{q.label}</span>
                  <ArrowRight className="h-4 w-4 text-muted opacity-0 transition group-hover:opacity-100" />
                </button>
              ))}
            </div>
          </Card>
          {d && (
            <Card title="Project Summary">
              {d.projectSummary.total === 0 ? (
                <Empty title="No projects yet" action={<Button size="sm" onClick={() => nav('/projects')}>Open projects</Button>}>
                  Solar projects you create appear here with their status and profit.
                </Empty>
              ) : (
                <>
                  <div className="grid grid-cols-2 gap-3 text-[13px]">
                    <div className="rounded-xl bg-surface-2 p-3"><div className="text-muted">Total projects</div><div className="text-[18px] font-bold">{d.projectSummary.total}</div></div>
                    <div className="rounded-xl bg-surface-2 p-3"><div className="text-muted">In progress</div><div className="text-[18px] font-bold">{d.projectSummary.inProgress}</div></div>
                    <div className="rounded-xl bg-surface-2 p-3"><div className="text-muted">Completed</div><div className="text-[18px] font-bold">{d.projectSummary.completed}</div></div>
                    <div className="rounded-xl bg-surface-2 p-3"><div className="text-muted">Installed capacity</div><div className="text-[18px] font-bold">{qty(d.projectSummary.installedKw)} kW</div></div>
                  </div>
                  {d.projectSummary.netProfit !== null && (d.projectSummary.revenue ?? 0) > 0 && (
                    <div className="mt-3 rounded-xl bg-gradient-to-br from-emerald-500 to-teal-600 p-4 text-white">
                      <div className="text-[12px] opacity-85">Net profit, all projects</div>
                      <div className="text-[22px] font-bold">{money(d.projectSummary.netProfit)}</div>
                      <div className="text-[12px] opacity-85">Revenue {money(d.projectSummary.revenue)}{d.projectSummary.marginPct !== null && <> · margin {pct(d.projectSummary.marginPct)}</>}</div>
                    </div>
                  )}
                </>
              )}
            </Card>
          )}
          {d && d.accounts.length > 0 && (
            <Card title="Cash & Bank" actions={<Wallet className="h-4 w-4 text-muted" />}>
              {d.accounts.map((a: any) => (
                <div key={a.id} className="flex items-center justify-between py-1.5 text-[13px]">
                  <span>{a.name}{d.scope === 'all' && <span className="text-muted"> · {a.firm_name}</span>}</span>
                  <span className={`num font-semibold ${a.balance < 0 ? 'text-bad' : ''}`}>{money(a.balance)}</span>
                </div>
              ))}
            </Card>
          )}
        </div>
      </div>
    </div>
  )
}

function MiniDocs({ rows, onOpen }: { rows: any[]; onOpen: (id: number) => void }): JSX.Element {
  if (!rows.length) return <Empty title="Nothing yet" />
  return (
    <table className="tbl">
      <thead><tr><th>Number</th><th>Party</th><th>Date</th><th className="text-right">Amount</th><th>Status</th></tr></thead>
      <tbody>
        {rows.map((r) => {
          const st = r.due <= 0.5 ? 'paid' : r.due < r.grand_total ? 'partial' : 'unpaid'
          return (
            <tr key={r.id} className="clickable" onClick={() => onOpen(r.id)}>
              <td className="font-medium">{r.number}</td>
              <td className="max-w-[160px] truncate">{r.party_name}</td>
              <td className="text-muted">{date(r.date)}</td>
              <td className="num text-right">{money(r.grand_total)}</td>
              <td><Badge tone={statusTone(st)}>{label(st)}</Badge></td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}
