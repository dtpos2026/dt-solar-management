/** Day & month closing (owner: data area). */
import { ReactNode, useState } from 'react'
import { CalendarCheck, CalendarRange, Download, History, Lock, Printer, RefreshCw, Unlock } from 'lucide-react'
import { api } from '../../api'
import { useCan } from '../../store'
import { Badge, Button, Card, Empty, Field, Input, Loading, NumberInput, PageHeader, Select, Tabs, Textarea, cx, promptDialog, toast } from '../../components/ui'
import { DataTable } from '../../components/DataTable'
import { useLoad } from '../../lib/hooks'
import { date, money, today } from '../../lib/format'
import { DateInput } from '../../components/DateInput'

interface CashGroup {
  opening: number
  cashIn: number
  cashOut: number
  expected: number
}
interface AccountFigure {
  accountId: number
  name: string
  type: string
  opening: number
  inflow: number
  outflow: number
  closing: number
}
interface Figures {
  from: string
  to: string
  accounts: AccountFigure[]
  cash: CashGroup
  bank: CashGroup
  sales: number
  purchases: number
  saleReturns: number
  purchaseReturns: number
  returns: number
  expenses: number
  receipts: number
  payments: number
  counts: { sales: number; purchases: number; expenses: number; receipts: number; payments: number }
}
interface ClosingRow {
  id: number
  kind: 'day' | 'month'
  period_start: string
  period_end: string
  status: string
  counted_cash: number | null
  difference: number
  closing_cash: number
  backup_file: string | null
  closed_at: string
  closed_by_name?: string
  reopen_reason?: string | null
  reopened_by_name?: string | null
  notes?: string | null
  sales_total: number
  receipts_total: number
  expenses_total: number
  payments_total: number
  opening_cash: number
  cash_in: number
  cash_out: number
}
interface DayRow {
  date: string
  sales: number
  purchases: number
  returns: number
  expenses: number
  receipts: number
  payments: number
  cashIn: number
  cashOut: number
  closed: boolean
}

type Tab = 'day' | 'month' | 'history'

export function ClosingPage(): JSX.Element {
  const can = useCan()
  const [tab, setTab] = useState<Tab>('day')
  if (!can('closing.manage')) {
    return (
      <div className="space-y-4">
        <PageHeader title="Day & Month Closing" icon={<CalendarCheck className="h-5 w-5" />} />
        <Card>
          <Empty icon={<Lock className="h-6 w-6" />} title="No access">
            You do not have permission to close days or months. Ask the owner or an administrator.
          </Empty>
        </Card>
      </div>
    )
  }
  return (
    <div className="space-y-4">
      <PageHeader title="Day & Month Closing" subtitle="Count the cash, close the day and keep a closing backup" icon={<CalendarCheck className="h-5 w-5" />} />
      <Tabs<Tab>
        tabs={[
          { key: 'day', label: 'Day closing' },
          { key: 'month', label: 'Month closing' },
          { key: 'history', label: 'History' }
        ]}
        value={tab}
        onChange={setTab}
      />
      {tab === 'day' && <DayClosing />}
      {tab === 'month' && <MonthClosing />}
      {tab === 'history' && <ClosingHistory />}
    </div>
  )
}

function Fig({ label, value, tone, sub }: { label: string; value: ReactNode; tone?: 'ok' | 'bad' | 'warn'; sub?: ReactNode }): JSX.Element {
  return (
    <div className="rounded-xl border border-line bg-surface-2 px-3 py-2">
      <div className="text-[12px] text-muted">{label}</div>
      <div className={cx('num text-[17px] font-bold', tone === 'ok' && 'text-ok', tone === 'bad' && 'text-bad', tone === 'warn' && 'text-warn')}>{value}</div>
      {sub && <div className="text-[12px] text-muted">{sub}</div>}
    </div>
  )
}

function StatusBanner({ closing, onReopen }: { closing: ClosingRow | null; onReopen: () => void }): JSX.Element | null {
  const can = useCan()
  if (!closing) return null
  if (closing.status === 'closed')
    return (
      <div className="flex flex-wrap items-center gap-3 rounded-xl bg-ok-soft px-4 py-3 text-[13px] text-ok">
        <Lock className="h-4 w-4 shrink-0" />
        <div className="mr-auto">
          Closed on {closing.closed_at}
          {closing.closed_by_name ? ` by ${closing.closed_by_name}` : ''}. Transactions dated in this period cannot be added, edited or cancelled.
          {closing.backup_file && <div className="break-all text-[12px]">Closing backup: {closing.backup_file}</div>}
        </div>
        {can('closing.reopen') && (
          <Button size="sm" icon={<Unlock className="h-4 w-4" />} onClick={onReopen}>
            Reopen…
          </Button>
        )}
      </div>
    )
  return (
    <div className="flex items-center gap-3 rounded-xl bg-warn-soft px-4 py-3 text-[13px] text-warn">
      <Unlock className="h-4 w-4 shrink-0" /> Reopened{closing.reopen_reason ? `: ${closing.reopen_reason}` : ''}. You can close it again below.
    </div>
  )
}

async function reopen(closing: ClosingRow, after: () => Promise<void>): Promise<void> {
  const label = closing.kind === 'month' ? closing.period_start.slice(0, 7) : date(closing.period_start)
  const reason = await promptDialog({
    title: `Reopen ${closing.kind} ${label}?`,
    message: 'Reopening allows transactions in this period to be changed again. The reason is recorded in the audit log.',
    confirmLabel: 'Reopen',
    danger: true,
    input: { label: 'Reason', placeholder: 'Why is this period being reopened?', required: true }
  })
  if (!reason) return
  try {
    await api('closing.reopen', { id: closing.id, reason })
    toast.ok('Period reopened.')
    await after()
  } catch (e) {
    toast.error(e)
  }
}

function closeToast(r: { backup: string | null; backupError: string | null }, what: string): void {
  if (r.backup) toast.ok(`${what} closed. Closing backup saved: ${r.backup}`)
  else if (r.backupError) toast.warn(`${what} closed, but the closing backup failed: ${r.backupError}`)
  else toast.ok(`${what} closed.`)
}

function DayClosing(): JSX.Element {
  const [day, setDay] = useState(today())
  const [counted, setCounted] = useState<number | null>(null)
  const [notes, setNotes] = useState('')
  const [busy, setBusy] = useState(false)
  const p = useLoad(() => api<{ figures: Figures; closing: ClosingRow | null }>('closing.previewDay', { date: day }), [day])
  const f = p.data?.figures
  const closing = p.data?.closing ?? null
  const isClosed = closing?.status === 'closed'
  const diff = counted === null || !f ? null : Math.round((counted - f.cash.expected) * 100) / 100

  const close = async (): Promise<void> => {
    setBusy(true)
    try {
      const r = await api<{ id: number; backup: string | null; backupError: string | null }>('closing.close', { kind: 'day', period: day, countedCash: counted, notes })
      closeToast(r, `Day ${date(day)}`)
      setNotes('')
      await p.reload()
    } catch (e) {
      toast.error(e)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-4">
      <Card>
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Date">
            <DateInput value={day} max={today()} onChange={(e) => e.target.value && setDay(e.target.value)} />
          </Field>
          <Button icon={<RefreshCw className="h-4 w-4" />} onClick={() => p.reload()} loading={p.loading && !!f}>
            Refresh
          </Button>
          {closing && closing.status === 'closed' && (
            <Button icon={<Printer className="h-4 w-4" />} onClick={() => api('print.open', { kind: 'closing', id: closing.id }).catch(toast.error)}>
              Print
            </Button>
          )}
        </div>
      </Card>
      <StatusBanner closing={closing} onReopen={() => closing && reopen(closing, p.reload)} />
      {!f ? (
        <Loading label="Computing the day from the books…" />
      ) : (
        <>
          <div className="grid gap-4 xl:grid-cols-2">
            <Card title="Cash (cash accounts)">
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                <Fig label="Opening cash" value={money(f.cash.opening)} />
                <Fig label="Cash in" value={money(f.cash.cashIn)} tone="ok" />
                <Fig label="Cash out" value={money(f.cash.cashOut)} tone="bad" />
                <Fig label="Expected closing" value={money(f.cash.expected)} />
              </div>
            </Card>
            <Card title="Bank & wallets">
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                <Fig label="Opening" value={money(f.bank.opening)} />
                <Fig label="In" value={money(f.bank.cashIn)} tone="ok" />
                <Fig label="Out" value={money(f.bank.cashOut)} tone="bad" />
                <Fig label="Closing" value={money(f.bank.expected)} />
              </div>
            </Card>
          </div>
          <Card title="Business activity">
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
              <Fig label="Sales" value={money(f.sales)} sub={`${f.counts.sales} invoice(s)`} />
              <Fig label="Purchases" value={money(f.purchases)} sub={`${f.counts.purchases} bill(s)`} />
              <Fig label="Returns" value={money(f.returns)} sub={`Sales ${money(f.saleReturns)}, Purch. ${money(f.purchaseReturns)}`} />
              <Fig label="Expenses" value={money(f.expenses)} sub={`${f.counts.expenses} expense(s)`} />
              <Fig label="Receipts" value={money(f.receipts)} sub={`${f.counts.receipts} receipt(s)`} />
              <Fig label="Payments" value={money(f.payments)} sub={`${f.counts.payments} payment(s)`} />
            </div>
          </Card>
          <Card title="Per account" pad={false}>
            <DataTable<AccountFigure>
              rows={f.accounts}
              dense
              searchable={false}
              rowKey={(r) => r.accountId}
              columns={[
                { key: 'name', header: 'Account' },
                { key: 'type', header: 'Type', render: (r) => <Badge tone={r.type === 'cash' ? 'ok' : 'info'}>{r.type}</Badge> },
                { key: 'opening', header: 'Opening', align: 'right', render: (r) => <span className="num">{money(r.opening)}</span>, value: (r) => r.opening },
                { key: 'inflow', header: 'In', align: 'right', render: (r) => <span className="num">{money(r.inflow)}</span>, value: (r) => r.inflow },
                { key: 'outflow', header: 'Out', align: 'right', render: (r) => <span className="num">{money(r.outflow)}</span>, value: (r) => r.outflow },
                { key: 'closing', header: 'Closing', align: 'right', render: (r) => <span className="num font-semibold">{money(r.closing)}</span>, value: (r) => r.closing }
              ]}
            />
          </Card>
          {!isClosed && (
            <Card title="Close the day">
              <div className="grid gap-4 md:grid-cols-[220px_220px_minmax(0,1fr)]">
                <Field label="Counted cash" hint="Count the cash in hand (cash accounts)">
                  <NumberInput value={counted ?? ''} min={0} placeholder={String(f.cash.expected)} onChange={(v) => setCounted(Number.isFinite(v) ? v : null)} />
                </Field>
                <Fig label="Difference (counted − expected)" value={diff === null ? '-' : money(diff)} tone={diff === null ? undefined : diff === 0 ? 'ok' : diff < 0 ? 'bad' : 'warn'} sub={diff === null ? 'Enter counted cash' : diff === 0 ? 'Cash matches' : diff < 0 ? 'Short' : 'Excess'} />
                <Field label="Notes">
                  <Textarea rows={2} value={notes} maxLength={1000} onChange={(e) => setNotes(e.target.value)} placeholder="Optional" />
                </Field>
              </div>
              <div className="mt-4 flex justify-end">
                <Button variant="primary" icon={<Lock className="h-4 w-4" />} loading={busy} onClick={close}>
                  Close day {date(day)}
                </Button>
              </div>
            </Card>
          )}
        </>
      )}
    </div>
  )
}

function MonthClosing(): JSX.Element {
  const [month, setMonth] = useState(today().slice(0, 7))
  const [notes, setNotes] = useState('')
  const [busy, setBusy] = useState(false)
  const p = useLoad(() => api<{ month: string; figures: Figures; days: DayRow[]; closing: ClosingRow | null }>('closing.previewMonth', { month }), [month])
  const d = p.data
  const closing = d?.closing ?? null
  const close = async (): Promise<void> => {
    setBusy(true)
    try {
      const r = await api<{ id: number; backup: string | null; backupError: string | null }>('closing.close', { kind: 'month', period: month, notes })
      closeToast(r, `Month ${month}`)
      setNotes('')
      await p.reload()
    } catch (e) {
      toast.error(e)
    } finally {
      setBusy(false)
    }
  }
  const m = (k: keyof DayRow) => (r: DayRow) => <span className="num">{money(Number(r[k]))}</span>
  return (
    <div className="space-y-4">
      <Card>
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Month">
            <Input type="month" value={month} max={today().slice(0, 7)} onChange={(e) => e.target.value && setMonth(e.target.value)} />
          </Field>
          <Button icon={<RefreshCw className="h-4 w-4" />} onClick={() => p.reload()} loading={p.loading && !!d}>
            Refresh
          </Button>
          {closing && closing.status === 'closed' && (
            <Button icon={<Printer className="h-4 w-4" />} onClick={() => api('print.open', { kind: 'closing', id: closing.id }).catch(toast.error)}>
              Print
            </Button>
          )}
        </div>
      </Card>
      <StatusBanner closing={closing} onReopen={() => closing && reopen(closing, p.reload)} />
      {!d ? (
        <Loading label="Computing the month…" />
      ) : (
        <>
          <Card title={<span className="inline-flex items-center gap-2"><CalendarRange className="h-4 w-4 text-brand" /> Month totals</span>}>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-8">
              <Fig label="Opening cash" value={money(d.figures.cash.opening)} />
              <Fig label="Closing cash" value={money(d.figures.cash.expected)} />
              <Fig label="Sales" value={money(d.figures.sales)} />
              <Fig label="Purchases" value={money(d.figures.purchases)} />
              <Fig label="Returns" value={money(d.figures.returns)} />
              <Fig label="Expenses" value={money(d.figures.expenses)} />
              <Fig label="Receipts" value={money(d.figures.receipts)} />
              <Fig label="Payments" value={money(d.figures.payments)} />
            </div>
          </Card>
          <Card title="Per day" pad={false}>
            <DataTable<DayRow>
              rows={d.days}
              dense
              searchable={false}
              pageSize={31}
              rowKey={(r) => r.date}
              exportName={`month-${month}`}
              columns={[
                { key: 'date', header: 'Date', render: (r) => <span className="whitespace-nowrap">{date(r.date)}</span> },
                { key: 'sales', header: 'Sales', align: 'right', render: m('sales'), value: (r) => r.sales },
                { key: 'purchases', header: 'Purchases', align: 'right', render: m('purchases'), value: (r) => r.purchases },
                { key: 'returns', header: 'Returns', align: 'right', render: m('returns'), value: (r) => r.returns },
                { key: 'expenses', header: 'Expenses', align: 'right', render: m('expenses'), value: (r) => r.expenses },
                { key: 'receipts', header: 'Receipts', align: 'right', render: m('receipts'), value: (r) => r.receipts },
                { key: 'payments', header: 'Payments', align: 'right', render: m('payments'), value: (r) => r.payments },
                { key: 'cashIn', header: 'Cash in', align: 'right', render: m('cashIn'), value: (r) => r.cashIn },
                { key: 'cashOut', header: 'Cash out', align: 'right', render: m('cashOut'), value: (r) => r.cashOut },
                { key: 'closed', header: 'Day', value: (r) => (r.closed ? 'Closed' : 'Open'), render: (r) => (r.closed ? <Badge tone="ok">Closed</Badge> : <Badge tone="muted">Open</Badge>) }
              ]}
            />
          </Card>
          {closing?.status !== 'closed' && (
            <Card title="Close the month">
              <Field label="Notes">
                <Textarea rows={2} value={notes} maxLength={1000} onChange={(e) => setNotes(e.target.value)} placeholder="Optional" />
              </Field>
              <div className="mt-4 flex justify-end">
                <Button variant="primary" icon={<Lock className="h-4 w-4" />} loading={busy} onClick={close}>
                  Close month {month}
                </Button>
              </div>
            </Card>
          )}
        </>
      )}
    </div>
  )
}

function ClosingHistory(): JSX.Element {
  const can = useCan()
  const [kind, setKind] = useState<'' | 'day' | 'month'>('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const filter = { kind: kind || undefined, from: from || undefined, to: to || undefined }
  const list = useLoad(() => api<ClosingRow[]>('closing.list', filter), [kind, from, to])
  const exportCsv = async (): Promise<void> => {
    try {
      const r = await api<{ file: string; rows: number } | null>('closing.exportCsv', filter)
      if (r) toast.ok(`Exported ${r.rows} closing(s) to ${r.file}`)
    } catch (e) {
      toast.error(e)
    }
  }
  return (
    <Card
      pad={false}
      title={<span className="inline-flex items-center gap-2"><History className="h-4 w-4 text-brand" /> Closings</span>}
      actions={
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[12.5px] text-muted">From</span>
          <DateInput sm className="num w-[9.5rem]" value={from} onChange={(e) => setFrom(e.target.value)} max={to || undefined} />
          <span className="text-[12.5px] text-muted">to</span>
          <DateInput sm className="num w-[9.5rem]" value={to} onChange={(e) => setTo(e.target.value)} min={from || undefined} />
          {(from || to) && (
            <Button size="sm" variant="ghost" onClick={() => { setFrom(''); setTo('') }}>
              Clear dates
            </Button>
          )}
          <Select sm value={kind} onChange={(e) => setKind(e.target.value as '' | 'day' | 'month')} aria-label="Kind">
            <option value="">All</option>
            <option value="day">Days</option>
            <option value="month">Months</option>
          </Select>
          <Button size="sm" icon={<Download className="h-4 w-4" />} onClick={exportCsv} disabled={!list.data?.length}>
            Export CSV
          </Button>
        </div>
      }
    >
      <DataTable<ClosingRow>
        rows={list.data ?? []}
        loading={list.loading}
        dense
        searchable={false}
        rowKey={(r) => r.id}
        empty={<Empty icon={<CalendarCheck className="h-6 w-6" />} title="No closings yet" />}
        columns={[
          { key: 'period', header: 'Period', value: (r) => r.period_start, render: (r) => <span className="whitespace-nowrap font-medium">{r.kind === 'month' ? r.period_start.slice(0, 7) : date(r.period_start)}</span> },
          { key: 'kind', header: 'Kind', render: (r) => <Badge tone={r.kind === 'month' ? 'info' : 'brand'}>{r.kind}</Badge> },
          { key: 'sales_total', header: 'Sales', align: 'right', render: (r) => <span className="num">{money(r.sales_total)}</span> },
          { key: 'closing_cash', header: 'Expected cash', align: 'right', render: (r) => <span className="num">{money(r.closing_cash)}</span> },
          { key: 'counted_cash', header: 'Counted', align: 'right', render: (r) => <span className="num">{r.counted_cash === null ? '-' : money(r.counted_cash)}</span> },
          { key: 'difference', header: 'Difference', align: 'right', render: (r) => <span className={cx('num', r.difference < 0 && 'text-bad', r.difference > 0 && 'text-warn')}>{money(r.difference)}</span> },
          {
            key: 'status',
            header: 'Status',
            render: (r) => (r.status === 'closed' ? <Badge tone="ok">Closed</Badge> : <span title={r.reopen_reason ?? ''}><Badge tone="warn">Reopened</Badge></span>)
          },
          { key: 'closed_by_name', header: 'Closed by', render: (r) => <div className="text-[12px]"><div>{r.closed_by_name ?? '-'}</div><div className="text-muted">{r.closed_at}</div></div> },
          { key: 'backup', header: 'Backup', value: (r) => r.backup_file ?? '', render: (r) => (r.backup_file ? <Badge tone="ok">Saved</Badge> : <Badge tone="muted">None</Badge>) },
          {
            key: 'actions',
            header: '',
            align: 'right',
            sortable: false,
            render: (r) => (
              <div className="flex justify-end gap-1">
                <Button size="sm" variant="ghost" icon={<Printer className="h-3.5 w-3.5" />} onClick={() => api('print.open', { kind: 'closing', id: r.id }).catch(toast.error)}>
                  Print
                </Button>
                {r.status === 'closed' && can('closing.reopen') && (
                  <Button size="sm" variant="ghost" icon={<Unlock className="h-3.5 w-3.5" />} onClick={() => reopen(r, list.reload)}>
                    Reopen
                  </Button>
                )}
              </div>
            )
          }
        ]}
      />
    </Card>
  )
}
