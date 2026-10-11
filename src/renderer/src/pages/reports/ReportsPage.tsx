import { ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import {
  BookOpen,
  Boxes,
  ChartColumn,
  Clock,
  Coins,
  Download,
  Hourglass,
  Info,
  Landmark,
  Percent,
  Printer,
  Receipt,
  RefreshCw,
  ShoppingBag,
  ShoppingCart,
  SunMedium,
  TrendingUp,
  Truck,
  Users
} from 'lucide-react'
import { api } from '../../api'
import { useApp, useCan } from '../../store'
import { Badge, Button, Card, Checkbox, Empty, Input, Loading, PageHeader, PeriodPicker, Select, StatCard, Tabs, cx, toast } from '../../components/ui'
import { Column, DataTable } from '../../components/DataTable'
import { BarChart, Donut, HBar } from '../../components/Charts'
import { useLoad } from '../../lib/hooks'
import { date, label, money, monthStart, pct, qty, today } from '../../lib/format'
import { PROJECT_STATUSES, PROJECT_STATUS_LABELS } from '@shared/docTypes'
import { round2 } from '@shared/money'
import {
  GroupBy,
  PlLine,
  RCol,
  REPORTS,
  REPORT_GROUPS,
  ReportKey,
  ReportModel,
  ReportOptions,
  RSection,
  RTable,
  buildReportModel,
  effectiveGroupBy,
  fetchReport,
  isNumeric,
  monthLabel,
  parseReportParams,
  periodText,
  plDisplay,
  rawValue,
  reportCsv,
  reportDef,
  reportFileTitle,
  reportParams,
  totalsLead
} from '../../print/ReportPrint'

/* eslint-disable @typescript-eslint/no-explicit-any */

const ICONS: Record<ReportKey, ReactNode> = {
  pl: <TrendingUp className="h-4 w-4" />,
  tax: <Percent className="h-4 w-4" />,
  daybook: <BookOpen className="h-4 w-4" />,
  cashbook: <Landmark className="h-4 w-4" />,
  sales: <ShoppingCart className="h-4 w-4" />,
  item_profit: <Coins className="h-4 w-4" />,
  purchases: <ShoppingBag className="h-4 w-4" />,
  stock: <Boxes className="h-4 w-4" />,
  aging_customer: <Hourglass className="h-4 w-4" />,
  aging_supplier: <Clock className="h-4 w-4" />,
  balances_customer: <Users className="h-4 w-4" />,
  balances_supplier: <Truck className="h-4 w-4" />,
  projects: <SunMedium className="h-4 w-4" />,
  expenses: <Receipt className="h-4 w-4" />
}

/** Categorical chart palette (fixed order, folded into "Other" after 7 slices). */
const PALETTE = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#6250d6', '#e34948']
const OTHER = '#9aa3b2'
const AGING_COLORS = ['#1baf7a', '#eda100', '#eb6834', '#e34948', '#a61b1b']
const DOC_KINDS = new Set(['sale_invoice', 'quotation', 'sale_order', 'delivery_challan', 'sale_return', 'purchase_invoice', 'purchase_order', 'purchase_return'])

/* ------------------------------------------------------------------------------------------------ */
/*                                       Screen formatting                                          */
/* ------------------------------------------------------------------------------------------------ */

function cellText(c: RCol, v: any, r?: any): string {
  if (v === null || v === undefined || v === '') return c.type && c.type !== 'text' ? '—' : ''
  switch (c.type) {
    case 'money':
      return money(Number(v))
    case 'qty': {
      const u = r && c.unit ? c.unit(r) : null
      return `${qty(Number(v))}${u ? ` ${u}` : ''}`
    }
    case 'pct':
      return pct(Number(v))
    case 'int':
      return Number(v).toLocaleString('en-PK')
    case 'date':
      return date(String(v))
    case 'month':
      return monthLabel(String(v))
    default:
      return String(v)
  }
}

function compact(n: number): string {
  const a = Math.abs(n)
  if (a >= 10000000) return `${(n / 10000000).toFixed(1)}Cr`
  if (a >= 100000) return `${(n / 100000).toFixed(1)}L`
  if (a >= 1000) return `${(n / 1000).toFixed(0)}K`
  return String(Math.round(n))
}

function shortMonth(ym: string): string {
  return monthLabel(ym).replace(/ (\d{2})(\d{2})$/, " '$2")
}

function plAmount(l: PlLine): string {
  return plDisplay(l, (n) => money(n))
}

function summaryValue(s: ReportModel['summary'][number]): string {
  if (s.value === null || s.value === undefined) return '—'
  if (s.type === 'money') return money(s.value)
  if (s.type === 'pct') return pct(s.value)
  if (s.type === 'qty') return qty(s.value)
  return Number(s.value).toLocaleString('en-PK')
}

/* ------------------------------------------------------------------------------------------------ */
/*                                            Page                                                  */
/* ------------------------------------------------------------------------------------------------ */

export function ReportsPage(): JSX.Element {
  const can = useCan()
  const nav = useNavigate()
  const firm = useApp((s) => s.firm)
  const firms = useApp((s) => s.firms)
  const [search, setSearch] = useSearchParams()

  const allowed = REPORTS.filter((r) => r.perms.every((p) => can(p)))
  const key: ReportKey | null = (allowed.find((r) => r.key === search.get('r')) ?? allowed[0])?.key ?? null
  const def = key ? reportDef(key) : undefined

  const [range, setRange] = useState<[string, string]>([monthStart(), today()])
  const [asOf, setAsOf] = useState(today())
  const [scope, setScope] = useState<'firm' | 'all'>('firm')
  const [salesGroup, setSalesGroup] = useState<GroupBy>('document')
  const [purchaseGroup, setPurchaseGroup] = useState<GroupBy>('document')
  const [accountId, setAccountId] = useState<number | null>(null)
  const [warehouseId, setWarehouseId] = useState<number | null>(null)
  const [includeZero, setIncludeZero] = useState(false)
  const [status, setStatus] = useState('')
  const [datedOnly, setDatedOnly] = useState(false)

  const isCash = key === 'cashbook'
  const isStock = key === 'stock'
  const accounts = useLoad<any[]>(() => (isCash ? api<any[]>('accounts.list', { includeInactive: true }) : Promise.resolve([])), [isCash])
  const warehouses = useLoad<any[]>(() => (isStock ? api<any[]>('warehouses.list', { includeInactive: true }) : Promise.resolve([])), [isStock])
  const accountList = accounts.data ?? []
  const warehouseList = warehouses.data ?? []

  // Pick the default account once accounts are known.
  useEffect(() => {
    if (!isCash || !accountList.length) return
    if (!accountId || !accountList.some((a) => a.id === accountId)) setAccountId((accountList.find((a) => a.is_default && a.is_active) ?? accountList[0]).id)
  }, [isCash, accountList, accountId])

  const canScope = can('reports.consolidated') && firms.length > 1
  const opts: ReportOptions = {
    from: range[0],
    to: range[1],
    asOf,
    scope: def?.scope && canScope ? scope : 'firm',
    groupBy: key === 'purchases' ? purchaseGroup : salesGroup,
    accountId,
    warehouseId,
    warehouseName: warehouseList.find((w) => w.id === warehouseId)?.name ?? '',
    includeZero,
    status,
    datedOnly
  }
  const sig = key ? JSON.stringify(reportParams(key, opts)) : ''

  /* ---------- data ---------- */
  const [res, setRes] = useState<{ sig: string; data?: any; error?: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const seq = useRef(0)
  const load = useCallback(async (s: string) => {
    if (!s) return
    const { key: k, opts: o } = parseReportParams(JSON.parse(s))
    if (!k) return
    const my = ++seq.current
    setBusy(true)
    try {
      const data = await fetchReport(k, o)
      if (my === seq.current) setRes({ sig: s, data })
    } catch (e) {
      if (my === seq.current) {
        setRes({ sig: s, error: e instanceof Error ? e.message : String(e) })
        toast.error(e)
      }
    } finally {
      if (my === seq.current) setBusy(false)
    }
  }, [])
  useEffect(() => {
    load(sig)
  }, [sig, load])

  const ready = !!res && res.sig === sig
  const model = useMemo<ReportModel | null>(() => {
    if (!key || !res || res.sig !== sig || res.data === null || res.data === undefined) return null
    try {
      return buildReportModel(key, res.data, parseReportParams(JSON.parse(sig)).opts)
    } catch (e) {
      toast.error(e)
      return null
    }
  }, [key, res, sig])

  /* ---------- actions ---------- */
  const print = async (): Promise<void> => {
    if (!key) return
    try {
      await api('print.open', { kind: 'report', id: 0, params: reportParams(key, opts) })
    } catch (e) {
      toast.error(e)
    }
  }
  const exportCsv = async (): Promise<void> => {
    if (!key || !model) return
    const { columns, rows } = reportCsv(model)
    if (!rows.length) {
      toast.info('There is nothing to export for this selection.')
      return
    }
    try {
      const file = await api<string | null>('export.csv', { filename: reportFileTitle(key, opts, res?.data), columns, rows })
      if (file) toast.ok(`Exported to ${file}`)
    } catch (e) {
      toast.error(e)
    }
  }
  const select = (k: ReportKey): void => setSearch({ r: k }, { replace: true })

  if (!key || !def) {
    return (
      <div>
        <PageHeader title="Reports" icon={<ChartColumn className="h-5 w-5" />} />
        <Card>
          <Empty icon={<ChartColumn />} title="No reports available">
            Your role does not include any report permissions. Ask the owner or an administrator for access.
          </Empty>
        </Card>
      </div>
    )
  }

  const gb = effectiveGroupBy(key, opts)
  const showPeriod = def.period === 'range' && (key !== 'projects' || datedOnly)

  return (
    <div>
      <PageHeader
        title="Reports"
        subtitle={`${opts.scope === 'all' ? 'All firms (consolidated)' : firm?.name ?? ''} · financial, sales, stock, party and project reports`}
        icon={<ChartColumn className="h-5 w-5" />}
      />
      <div className="grid grid-cols-1 items-start gap-5 lg:grid-cols-[240px_minmax(0,1fr)]">
        {/* ---------------- menu ---------------- */}
        <nav className="card p-2 lg:sticky lg:top-0" aria-label="Reports">
          {REPORT_GROUPS.map((g) => {
            const items = allowed.filter((r) => r.group === g)
            if (!items.length) return null
            return (
              <div key={g} className="mb-1.5 last:mb-0">
                <div className="px-2.5 pt-2 pb-1 text-[11px] font-semibold tracking-wider text-muted uppercase">{g}</div>
                {items.map((r) => (
                  <button
                    key={r.key}
                    type="button"
                    aria-current={r.key === key ? 'page' : undefined}
                    onClick={() => select(r.key)}
                    className={cx(
                      'flex w-full cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[13px] transition',
                      r.key === key ? 'bg-brand-soft font-semibold text-brand' : 'text-ink hover:bg-surface-2'
                    )}
                  >
                    <span className={r.key === key ? 'text-brand' : 'text-muted'}>{ICONS[r.key]}</span>
                    <span className="truncate">{r.title}</span>
                  </button>
                ))}
              </div>
            )
          })}
        </nav>

        {/* ---------------- report ---------------- */}
        <div className="min-w-0 space-y-4">
          <div className="card p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="flex min-w-0 items-start gap-3">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-brand-soft text-brand">{ICONS[key]}</div>
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 className="text-[17px] font-bold tracking-tight">{def.title}</h2>
                    {opts.scope === 'all' && <Badge tone="brand">All firms</Badge>}
                    {model?.subtitle && <Badge>{model.subtitle}</Badge>}
                  </div>
                  <div className="max-w-2xl text-[12.5px] text-muted">{def.description}</div>
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Button size="sm" variant="ghost" icon={<RefreshCw className={cx('h-4 w-4', busy && 'animate-spin')} />} onClick={() => load(sig)} disabled={busy} title="Reload this report">
                  Refresh
                </Button>
                <Button size="sm" icon={<Download className="h-4 w-4" />} onClick={exportCsv} disabled={!model || busy}>
                  Export CSV
                </Button>
                <Button size="sm" variant="primary" icon={<Printer className="h-4 w-4" />} onClick={print} disabled={!model || busy}>
                  Print / PDF
                </Button>
              </div>
            </div>

            <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-line pt-3">
              {showPeriod && <PeriodPicker from={range[0]} to={range[1]} onChange={(a, b) => setRange([a, b])} />}
              {def.period === 'asOf' && (
                <label className="flex items-center gap-2 text-[13px] text-muted">
                  As of
                  <Input sm type="date" className="w-40" value={asOf} onChange={(e) => e.target.value && setAsOf(e.target.value)} />
                </label>
              )}
              {def.period === 'none' && <span className="text-[12.5px] text-muted">Current position as of {date(today())}</span>}
              {def.scope && canScope && (
                <Select sm className="w-52" value={scope} onChange={(e) => setScope(e.target.value as 'firm' | 'all')} aria-label="Firm scope">
                  <option value="firm">This firm</option>
                  <option value="all">All firms (consolidated)</option>
                </Select>
              )}
              {isCash && (
                <Select sm className="w-64" value={accountId ?? ''} onChange={(e) => setAccountId(e.target.value ? Number(e.target.value) : null)} aria-label="Account">
                  {!accountList.length && <option value="">{accounts.loading ? 'Loading accounts…' : 'No accounts'}</option>}
                  {accountList.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name} · {label(a.type)}
                      {a.is_active ? '' : ' (inactive)'}
                    </option>
                  ))}
                </Select>
              )}
              {isStock && (
                <>
                  <Select sm className="w-52" value={warehouseId ?? ''} onChange={(e) => setWarehouseId(e.target.value ? Number(e.target.value) : null)} aria-label="Warehouse">
                    <option value="">All warehouses</option>
                    {warehouseList.map((w) => (
                      <option key={w.id} value={w.id}>
                        {w.name}
                        {w.is_active === 0 ? ' (inactive)' : ''}
                      </option>
                    ))}
                  </Select>
                  <Checkbox checked={includeZero} onChange={setIncludeZero} label="Include zero-stock items" />
                </>
              )}
              {key === 'projects' && (
                <>
                  <Select sm className="w-44" value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Project status">
                    <option value="">Any status</option>
                    {PROJECT_STATUSES.map((s) => (
                      <option key={s} value={s}>
                        {PROJECT_STATUS_LABELS[s]}
                      </option>
                    ))}
                  </Select>
                  <Checkbox checked={datedOnly} onChange={setDatedOnly} label="Only projects started in a period" />
                </>
              )}
              {def.groupBys && (
                <Tabs<GroupBy>
                  className="mb-0"
                  tabs={def.groupBys.map((g) => ({ key: g.key, label: g.label }))}
                  value={gb}
                  onChange={(g) => (key === 'purchases' ? setPurchaseGroup(g) : setSalesGroup(g))}
                />
              )}
            </div>
          </div>

          {!ready ? (
            <Card>
              <Loading label="Preparing report…" />
            </Card>
          ) : res?.error ? (
            <Card>
              <Empty icon={<Info />} title="This report could not be loaded" action={<Button onClick={() => load(sig)}>Try again</Button>}>
                {res.error}
              </Empty>
            </Card>
          ) : isCash && !model ? (
            <Card>
              <Empty icon={<Landmark />} title={accountList.length ? 'Choose an account' : 'No cash or bank accounts yet'}>
                {accountList.length ? 'Select a cash or bank account above to see its book.' : 'Create a cash or bank account in Accounts first.'}
              </Empty>
            </Card>
          ) : model ? (
            <div className={cx('space-y-4 transition-opacity', busy && 'opacity-60')}>
              <ReportBody k={key} model={model} data={res?.data} opts={opts} gb={gb} nav={nav} />
              <div className="text-right text-[11.5px] text-muted">{periodText(key, opts, date)}</div>
            </div>
          ) : (
            <Card>
              <Empty icon={<Info />} title="No data" />
            </Card>
          )}
        </div>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------------------------------------ */
/*                                          Report body                                             */
/* ------------------------------------------------------------------------------------------------ */

export function ReportBody({ k, model, data, opts, gb, nav }: { k: ReportKey; model: ReportModel; data: any; opts: ReportOptions; gb: GroupBy; nav: (to: string) => void }): JSX.Element {
  const onRow = rowHandler(k, gb, opts, nav)
  const sections = model.sections.filter((s) => s.screen !== false)
  return (
    <>
      {model.summary.length > 0 && (
        <div className={cx('grid grid-cols-2 gap-3', model.summary.length >= 5 ? 'lg:grid-cols-3 2xl:grid-cols-5' : model.summary.length === 3 ? 'md:grid-cols-3' : 'lg:grid-cols-4')}>
          {model.summary.map((s) => (
            <StatCard
              key={s.label}
              label={s.label}
              tone={s.tone}
              value={<span className={s.negativeBad && (s.value ?? 0) < 0 ? 'text-bad' : ''}>{summaryValue(s)}</span>}
              sub={s.sub}
            />
          ))}
        </div>
      )}

      {model.pl ? <PlView pl={model.pl} /> : <ReportCharts k={k} data={data} model={model} gb={gb} />}

      {sections.map((s) => (
        <SectionTable key={s.id} sec={s} title={model.title} onRowClick={onRow?.(s)} />
      ))}

      <Notes notes={model.notes} />
    </>
  )
}

function rowHandler(k: ReportKey, gb: GroupBy, o: ReportOptions, nav: (to: string) => void): ((s: RSection) => ((r: any) => void) | undefined) | null {
  const printVoucher = (kind: 'payment' | 'material', id: number): void => {
    api('print.open', { kind, id }).catch((e) => toast.error(e))
  }
  switch (k) {
    case 'sales':
    case 'purchases':
      // Documents of other firms cannot be opened from the active firm.
      return gb === 'document' && o.scope === 'firm' ? () => (r) => r.id && nav(`/doc/${r.id}`) : null
    case 'daybook':
      return (s) =>
        s.id === 'entries'
          ? (r) => {
              if (DOC_KINDS.has(r.kind)) nav(`/doc/${r.ref_id}`)
              else if (r.kind === 'receipt' || r.kind === 'payment') printVoucher('payment', r.ref_id)
              else if (r.kind === 'material_issue' || r.kind === 'material_return') printVoucher('material', r.ref_id)
              else toast.info(`${label(r.kind)} ${r.number ?? ''} — open it from its own module.`.trim())
            }
          : undefined
    case 'cashbook':
      return () => (r) => {
        if (r._opening) return
        if (r.kind === 'receipt' || r.kind === 'payment') printVoucher('payment', r.ref_id)
        else toast.info(`${label(r.kind)} ${r.number ?? ''} — open it from Accounts or Expenses.`.trim())
      }
    case 'aging_customer':
    case 'aging_supplier':
      return () => (r) => nav(`/party/${r.party_id}`)
    case 'balances_customer':
    case 'balances_supplier':
      return () => (r) => nav(`/party/${r.id}`)
    case 'projects':
      return () => (r) => nav(`/projects/${r.id}`)
    default:
      return null
  }
}

/* ------------------------------------------------------------------------------------------------ */
/*                                        Generic table                                             */
/* ------------------------------------------------------------------------------------------------ */

function toColumns(t: RTable): Array<Column<any>> {
  return t.columns.map((c) => ({
    key: c.key,
    header: c.label,
    align: isNumeric(c) ? 'right' : undefined,
    sortable: t.fixedOrder ? false : undefined,
    value: (r: any) => {
      const v = rawValue(c, r)
      return typeof v === 'number' || typeof v === 'string' ? v : v === null || v === undefined ? v : String(v)
    },
    render: (r: any) => {
      const v = rawValue(c, r)
      const text = cellText(c, v, r)
      const sub = c.sub?.(r)
      const neg = c.signed && typeof v === 'number' && v < -0.004
      const main =
        c.badge && text ? (
          <Badge tone={c.badge(r)}>{text}</Badge>
        ) : (
          <span className={cx((c.strong || t.isSpecial?.(r)) && 'font-semibold', neg && 'text-bad', (isNumeric(c) || c.nowrap) && 'whitespace-nowrap')}>{text}</span>
        )
      return sub ? (
        <div className="min-w-0">
          {main}
          <div className="text-[11.5px] text-muted">{sub}</div>
        </div>
      ) : (
        main
      )
    }
  }))
}

function SectionTable({ sec, title, onRowClick }: { sec: RSection; title: string; onRowClick?: (r: any) => void }): JSX.Element {
  const t = sec.table
  const cols = toColumns(t)
  const totals = t.totals
  const lead = totalsLead(t)
  const footer =
    totals && t.rows.length > 0 ? (
      <tr>
        <td colSpan={lead} className="px-3 py-2">
          {t.totalLabel ?? 'Total'}
        </td>
        {t.columns.slice(lead).map((c) => {
          const v = totals[c.key]
          const neg = c.signed && typeof v === 'number' && v < -0.004
          return (
            <td key={c.key} className={cx('px-3 py-2', isNumeric(c) && 'num text-right whitespace-nowrap', neg && 'text-bad')}>
              {v === undefined || v === null ? '' : cellText(c, v)}
            </td>
          )
        })}
      </tr>
    ) : undefined
  return (
    <div className="space-y-2">
      {sec.title && (
        <div className="flex items-baseline justify-between gap-3 px-1">
          <h3 className="text-[14px] font-semibold">{sec.title}</h3>
          <span className="text-[12px] text-muted">
            {t.rows.length} row{t.rows.length === 1 ? '' : 's'}
          </span>
        </div>
      )}
      <DataTable
        rows={t.rows}
        columns={cols}
        footer={footer}
        searchable={!t.fixedOrder && t.rows.length > 8}
        exportName={sec.csv === false ? `${title} - ${sec.title ?? 'details'}` : undefined}
        onRowClick={onRowClick}
        rowClassName={(r) => cx(t.isMuted?.(r) && 'line-through opacity-55', t.isSpecial?.(r) && 'bg-surface-2')}
        pageSize={t.fixedOrder ? 250 : 50}
        maxHeight="calc(100vh - 220px)"
        empty={<Empty icon={<Info />} title="No records for this selection">Try a different period or filter.</Empty>}
      />
    </div>
  )
}

function Notes({ notes }: { notes: string[] }): JSX.Element | null {
  if (!notes.length) return null
  return (
    <div className="flex gap-3 rounded-xl border border-line bg-info-soft px-4 py-3 text-[12.5px] leading-relaxed text-ink">
      <Info className="mt-0.5 h-4 w-4 shrink-0 text-info" />
      <div className="space-y-1">
        {notes.map((n, i) => (
          <p key={i}>{n}</p>
        ))}
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------------------------------------ */
/*                                          Profit & Loss                                           */
/* ------------------------------------------------------------------------------------------------ */

function PlView({ pl }: { pl: NonNullable<ReportModel['pl']> }): JSX.Element {
  const f = pl.figures
  const rev = Number(f.revenue) || 0
  const parts = [
    { label: 'Cost of sales', value: Math.max(0, Number(f.costOfSales) || 0), color: PALETTE[0] },
    { label: 'Operating expenses', value: Math.max(0, Number(f.operatingExpenses) || 0), color: PALETTE[1] },
    ...(f.netProfit > 0 ? [{ label: 'Net profit', value: Number(f.netProfit), color: PALETTE[2] }] : [])
  ]
  const opex = ((f.operatingByCategory ?? []) as Array<{ name: string; amount: number }>).slice(0, 6).map((c) => ({ label: c.name, value: c.amount }))
  return (
    <div className="grid grid-cols-1 items-start gap-4 xl:grid-cols-[minmax(0,1fr)_320px]">
      <div className="space-y-4">
        <Card title="Income statement" pad={false} actions={<span className="text-[12px] text-muted">Accrual basis</span>}>
          <table className="w-full text-[13px]">
            <thead>
              <tr className="text-[12px] text-muted">
                <th className="border-b border-line px-4 py-2.5 text-left font-semibold">Particulars</th>
                <th className="w-40 border-b border-line px-4 py-2.5 text-right font-semibold">Amount</th>
                <th className="w-32 border-b border-line px-4 py-2.5 text-right font-semibold">% of net sales</th>
              </tr>
            </thead>
            <tbody>
              {pl.statement.map((l, i) => (
                <PlRow key={i} l={l} />
              ))}
            </tbody>
          </table>
        </Card>
        <Card title="Memo — not part of profit" pad={false}>
          <table className="w-full text-[13px]">
            <tbody>
              {pl.memo.map((l) => (
                <tr key={l.label} className={cx(l.kind === 'subtotal' && 'bg-surface-2 font-semibold')}>
                  <td className="border-b border-line px-4 py-2">{l.label}</td>
                  <td className={cx('num w-40 border-b border-line px-4 py-2 text-right whitespace-nowrap', (l.amount ?? 0) < 0 && 'text-bad')}>{plAmount(l)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      </div>
      <div className="space-y-4">
        <Card title="Where net sales went">
          {rev > 0 ? (
            <div className="flex flex-col items-center gap-3">
              <Donut parts={parts} center={compact(rev)} sub="Net sales" size={160} />
              <Legend items={parts.map((p) => ({ ...p, share: (p.value / rev) * 100 }))} />
              {f.netProfit < 0 && <div className="text-center text-[12px] font-medium text-bad">Costs exceed sales — net loss of {money(Math.abs(f.netProfit))}</div>}
            </div>
          ) : (
            <Empty title="No sales in this period">The chart appears once sales are invoiced.</Empty>
          )}
        </Card>
        {opex.length > 0 && (
          <Card title="Operating expenses">
            <HBar items={opex} color={PALETTE[1]} />
          </Card>
        )}
        {(f.directByHead ?? []).length > 0 && (
          <Card title="Direct expenses by cost head">
            <HBar items={(pl.statement.filter((l) => l.kind === 'detail') as PlLine[]).map((l) => ({ label: l.label, value: Number(l.amount) || 0 }))} color={PALETTE[0]} />
          </Card>
        )}
      </div>
    </div>
  )
}

function PlRow({ l }: { l: PlLine }): JSX.Element {
  if (l.kind === 'section') {
    return (
      <tr>
        <td colSpan={3} className="px-4 pt-4 pb-1.5 text-[11.5px] font-bold tracking-wider text-brand uppercase">
          {l.label}
        </td>
      </tr>
    )
  }
  const neg = (l.amount ?? 0) < -0.004
  const row = cx(
    l.kind === 'subtotal' && 'font-semibold',
    l.kind === 'total' && 'bg-brand-soft text-[14px] font-bold',
    l.kind === 'grand' && (neg ? 'bg-bad text-[15px] font-bold text-white' : 'bg-brand text-[15px] font-bold text-on-brand')
  )
  const cell = cx('py-2', l.kind === 'subtotal' ? 'border-t border-line' : '', l.kind === 'detail' && 'text-[12.5px] text-muted')
  return (
    <tr className={row}>
      <td className={cx(cell, 'pr-4', l.kind === 'item' ? 'pl-8' : l.kind === 'detail' ? 'pl-12' : 'pl-4')}>{l.label}</td>
      <td className={cx(cell, 'num px-4 text-right whitespace-nowrap', l.kind !== 'grand' && neg && 'text-bad')}>{plAmount(l)}</td>
      <td className={cx(cell, 'num px-4 text-right text-[12.5px] whitespace-nowrap', l.kind !== 'grand' && l.kind !== 'total' && 'text-muted')}>
        {l.pct === null || l.pct === undefined ? '' : pct(l.pct)}
      </td>
    </tr>
  )
}

/* ------------------------------------------------------------------------------------------------ */
/*                                             Charts                                               */
/* ------------------------------------------------------------------------------------------------ */

function Legend({ items }: { items: Array<{ label: string; value: number; color: string; share?: number | null }> }): JSX.Element {
  return (
    <div className="w-full space-y-1.5">
      {items.map((p) => (
        <div key={p.label} className="flex items-center gap-2 text-[12.5px]">
          <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: p.color }} />
          <span className="min-w-0 flex-1 truncate">{p.label}</span>
          <span className="num font-semibold">{money(p.value)}</span>
          {p.share !== undefined && <span className="num w-12 text-right text-muted">{p.share === null ? '—' : pct(p.share)}</span>}
        </div>
      ))}
    </div>
  )
}

/** Fold a long list into the first 7 + "Other" so colours stay distinguishable. */
function slices(items: Array<{ label: string; value: number }>): Array<{ label: string; value: number; color: string }> {
  const sorted = [...items].filter((i) => i.value > 0).sort((a, b) => b.value - a.value)
  const head = sorted.slice(0, sorted.length > 8 ? 7 : 8).map((i, n) => ({ ...i, color: PALETTE[n] }))
  const rest = sorted.slice(head.length)
  if (rest.length) head.push({ label: `Other (${rest.length})`, value: round2(rest.reduce((a, i) => a + i.value, 0)), color: OTHER })
  return head
}

function DonutCard({ title, items, center }: { title: string; items: Array<{ label: string; value: number }>; center: string }): JSX.Element {
  const parts = slices(items)
  const total = parts.reduce((a, p) => a + p.value, 0)
  return (
    <Card title={title}>
      {total > 0 ? (
        <div className="flex flex-col items-center gap-4 sm:flex-row">
          <Donut parts={parts} center={compact(total)} sub={center} size={150} />
          <Legend items={parts.map((p) => ({ ...p, share: (p.value / total) * 100 }))} />
        </div>
      ) : (
        <Empty title="Nothing to chart for this selection" />
      )}
    </Card>
  )
}

function topN(rows: any[], valueOf: (r: any) => number, labelOf: (r: any) => string, n = 8): Array<{ label: string; value: number }> {
  return [...rows]
    .map((r) => ({ label: labelOf(r) || '—', value: round2(Number(valueOf(r)) || 0) }))
    .filter((i) => Math.abs(i.value) > 0.004)
    .sort((a, b) => Math.abs(b.value) - Math.abs(a.value))
    .slice(0, n)
}

function ReportCharts({ k, data, model, gb }: { k: ReportKey; data: any; model: ReportModel; gb: GroupBy }): JSX.Element | null {
  const rows: any[] = model.sections[0]?.table.rows ?? []
  if (!rows.length) return null
  switch (k) {
    case 'sales':
    case 'purchases': {
      const isSales = k === 'sales'
      if (gb === 'month') {
        const months = rows.slice(-24).map((r) => ({ label: shortMonth(r.name), month: monthLabel(r.name), net: r.net, ...(data.showProfit ? { profit: r.profit } : {}) }))
        return (
          <Card title={isSales ? 'Net sales by month' : 'Net purchases by month'}>
            <BarChart
              data={months}
              series={[
                { key: 'net', label: isSales ? 'Net sales' : 'Net purchases', color: 'var(--brand)' },
                ...(data.showProfit ? [{ key: 'profit', label: 'Gross profit', color: '#f7931e' }] : [])
              ]}
            />
          </Card>
        )
      }
      if (gb === 'document') return null
      const what = gb === 'party' ? (isSales ? 'customers' : 'suppliers') : gb === 'product' ? 'products' : 'categories'
      return (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <Card title={`Top ${what} by net ${isSales ? 'sales' : 'purchases'}`}>
            <HBar items={topN(rows, (r) => r.net, (r) => r.name)} />
          </Card>
          {data.showProfit ? (
            <Card title={`Top ${what} by gross profit`}>
              <HBar items={topN(rows, (r) => r.profit, (r) => r.name)} color="#f7931e" />
            </Card>
          ) : (
            <DonutCard title={`Share of net ${isSales ? 'sales' : 'purchases'}`} items={rows.map((r) => ({ label: String(r.name ?? '—'), value: Number(r.net) || 0 }))} center="Net total" />
          )}
        </div>
      )
    }
    case 'item_profit':
      return (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <Card title="Most profitable items">
            <HBar items={topN(rows.filter((r) => r.profit > 0), (r) => r.profit, (r) => r.name)} color="#f7931e" />
          </Card>
          <Card title="Top items by net sales">
            <HBar items={topN(rows, (r) => r.net, (r) => r.name)} />
          </Card>
        </div>
      )
    case 'stock': {
      const showCost = data.totalValue !== null && data.totalValue !== undefined
      const byCat = new Map<string, number>()
      for (const r of rows) byCat.set(r.category_name ?? 'Uncategorised', round2((byCat.get(r.category_name ?? 'Uncategorised') ?? 0) + Number(showCost ? r.value : r.sale_value)))
      const items = Array.from(byCat.entries()).map(([label, value]) => ({ label, value }))
      return (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <DonutCard title={showCost ? 'Stock value at cost by category' : 'Stock value at sale price by category'} items={items} center="Stock value" />
          <Card title={showCost ? 'Highest value items (at cost)' : 'Highest value items (at sale price)'}>
            <HBar items={topN(rows, (r) => (showCost ? r.value : r.sale_value), (r) => r.name)} />
          </Card>
        </div>
      )
    }
    case 'aging_customer':
    case 'aging_supplier': {
      const t = model.sections[0].table.totals ?? {}
      const buckets = [
        { label: 'Current', value: Number(t.current) || 0 },
        { label: '1–30 days', value: Number(t.d30) || 0 },
        { label: '31–60 days', value: Number(t.d60) || 0 },
        { label: '61–90 days', value: Number(t.d90) || 0 },
        { label: '90+ days', value: Number(t.over90) || 0 }
      ].map((b, i) => ({ ...b, color: AGING_COLORS[i] }))
      const total = buckets.reduce((a, b) => a + b.value, 0)
      return (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <Card title="Outstanding by age">
            <div className="flex flex-col items-center gap-4 sm:flex-row">
              <Donut parts={buckets} center={compact(total)} sub="Outstanding" size={150} />
              <Legend items={buckets.map((b) => ({ ...b, share: total > 0 ? (b.value / total) * 100 : null }))} />
            </div>
          </Card>
          <Card title={`Largest ${k === 'aging_customer' ? 'receivables' : 'payables'}`}>
            <HBar items={topN(rows, (r) => r.total, (r) => r.party_name)} color={k === 'aging_customer' ? 'var(--brand)' : '#eb6834'} />
          </Card>
        </div>
      )
    }
    case 'balances_customer':
    case 'balances_supplier': {
      const cust = k === 'balances_customer'
      const items = topN(rows, (r) => (cust ? Math.max(0, r.balance) : Math.max(0, -r.balance)), (r) => r.name)
      if (!items.length) return null
      return (
        <Card title={cust ? 'Customers who owe the most' : 'Suppliers we owe the most'}>
          <HBar items={items} color={cust ? 'var(--brand)' : '#eb6834'} />
        </Card>
      )
    }
    case 'projects':
      return (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <Card title="Net profit by project">
            <HBar items={topN(rows, (r) => r.financials?.netProfit, (r) => `${r.code} · ${r.name}`)} color="#1baf7a" />
          </Card>
          <Card title="Customer dues by project">
            {topN(rows, (r) => r.financials?.customerOutstanding, (r) => `${r.code} · ${r.name}`).length ? (
              <HBar items={topN(rows, (r) => r.financials?.customerOutstanding, (r) => `${r.code} · ${r.name}`)} color="#eb6834" />
            ) : (
              <Empty title="All project dues collected" />
            )}
          </Card>
        </div>
      )
    case 'expenses': {
      const months: any[] = data.byMonth ?? []
      return (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <DonutCard title="Expenses by category" items={rows.map((r) => ({ label: String(r.name), value: Number(r.amount) || 0 }))} center="Total" />
          <Card title="Expenses by month">
            {months.length ? (
              <BarChart data={months.slice(-24).map((m) => ({ label: shortMonth(m.month), month: monthLabel(m.month), amount: m.amount }))} series={[{ key: 'amount', label: 'Expenses', color: '#eb6834' }]} height={220} />
            ) : (
              <Empty title="No expenses in this period" />
            )}
          </Card>
        </div>
      )
    }
    default:
      return null
  }
}
