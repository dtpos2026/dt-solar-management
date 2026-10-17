/* eslint-disable @typescript-eslint/no-explicit-any */
import { ReactNode, useEffect, useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { ArrowLeftRight, ArrowRight, ArrowUpRight, Ban, Banknote, BookOpen, Download, HandCoins, Info, Landmark, Pencil, Plus, Printer, Scale, Smartphone, Star, Wallet } from 'lucide-react'
import { api } from '../../api'
import { useCan } from '../../store'
import { Badge, Button, Card, Checkbox, Empty, Field, IconButton, Input, Kv, Loading, Modal, NumberInput, PageHeader, PeriodPicker, Select, StatCard, Tabs, Textarea, Toggle, confirmDialog, cx, promptDialog, toast } from '../../components/ui'
import { DataTable, Column } from '../../components/DataTable'
import { PaymentModal } from '../../components/PaymentModal'
import { useLoad } from '../../lib/hooks'
import { date, dateTime, label, money, today, PERIODS } from '../../lib/format'
import { DOC_TYPES, PAYMENT_METHOD_LABELS } from '@shared/docTypes'
import { EPS, round2 } from '@shared/money'
import { DateInput } from '../../components/DateInput'

type Tab = 'cash' | 'receipts' | 'payments' | 'transfers' | 'adjustments'
const TAB_KEYS: Tab[] = ['cash', 'receipts', 'payments', 'transfers', 'adjustments']

const thisMonth = (): [string, string] => PERIODS.find((p) => p.key === 'month')!.range()

const ACCOUNT_TYPES: Record<string, { label: string; icon: ReactNode; tone: string }> = {
  cash: { label: 'Cash in hand', icon: <Banknote className="h-5 w-5" />, tone: 'bg-ok-soft text-ok' },
  bank: { label: 'Bank account', icon: <Landmark className="h-5 w-5" />, tone: 'bg-info-soft text-info' },
  wallet: { label: 'Mobile wallet', icon: <Smartphone className="h-5 w-5" />, tone: 'bg-warn-soft text-warn' }
}
const accountType = (t: string): { label: string; icon: ReactNode; tone: string } => ACCOUNT_TYPES[t] ?? ACCOUNT_TYPES.cash

const methodLabel = (m: string | null | undefined): string => (m ? PAYMENT_METHOD_LABELS[m] ?? label(m) : '—')

/* ================================ Page ================================ */

export function AccountsPage(): JSX.Element {
  const can = useCan()
  const canManage = can('accounts.manage')
  const [params, setParams] = useSearchParams()
  const tabParam = params.get('tab') as Tab | null
  const tab: Tab = tabParam && TAB_KEYS.includes(tabParam) ? tabParam : 'cash'
  const [pay, setPay] = useState<'in' | 'out' | null>(() => (params.get('receive') === '1' && canManage ? 'in' : null))
  const [transfer, setTransfer] = useState(false)
  const [tick, setTick] = useState(0)
  const refresh = (): void => setTick((t) => t + 1)

  useEffect(() => {
    if (params.get('receive') === '1') {
      const next = new URLSearchParams(params)
      next.delete('receive')
      setParams(next, { replace: true })
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div>
      <PageHeader
        title="Accounts"
        subtitle="Cash in hand, bank & wallet balances, receipts, payments and transfers"
        icon={<Landmark className="h-5 w-5" />}
        actions={
          canManage && (
            <>
              <Button icon={<ArrowLeftRight className="h-4 w-4" />} onClick={() => setTransfer(true)}>
                Transfer
              </Button>
              <Button icon={<ArrowUpRight className="h-4 w-4" />} onClick={() => setPay('out')}>
                Make payment
              </Button>
              <Button variant="success" icon={<HandCoins className="h-4 w-4" />} onClick={() => setPay('in')}>
                Receive payment
              </Button>
            </>
          )
        }
      />
      <Tabs
        value={tab}
        onChange={(t) => setParams(t === 'cash' ? {} : { tab: t }, { replace: true })}
        tabs={[
          { key: 'cash', label: 'Cash & Bank' },
          { key: 'receipts', label: 'Receipts' },
          { key: 'payments', label: 'Payments' },
          { key: 'transfers', label: 'Transfers' },
          { key: 'adjustments', label: 'Journal adjustments' }
        ]}
      />
      {tab === 'cash' && <CashBankTab tick={tick} />}
      {tab === 'receipts' && <PaymentsTab direction="in" tick={tick} onChanged={refresh} />}
      {tab === 'payments' && <PaymentsTab direction="out" tick={tick} onChanged={refresh} />}
      {tab === 'transfers' && <TransfersTab tick={tick} onNew={canManage ? () => setTransfer(true) : undefined} onChanged={refresh} />}
      {tab === 'adjustments' && <AdjustmentsTab tick={tick} />}

      {pay && <PaymentModal open onClose={() => setPay(null)} onSaved={refresh} preset={{ direction: pay }} />}
      {transfer && <TransferModal onClose={() => setTransfer(false)} onSaved={refresh} />}
    </div>
  )
}

/* ============================== Cash & bank ============================== */

function CashBankTab({ tick }: { tick: number }): JSX.Element {
  const can = useCan()
  const canManage = can('accounts.manage')
  const [showInactive, setShowInactive] = useState(false)
  const [localTick, setLocalTick] = useState(0)
  const { data, loading } = useLoad(() => api<any[]>('accounts.list', { includeInactive: true }), [tick, localTick])
  const [ledger, setLedger] = useState<any>(null)
  const [form, setForm] = useState<{ open: boolean; account?: any }>({ open: false })

  const all = data ?? []
  const active = all.filter((a) => a.is_active)
  const shown = showInactive ? all : active
  const inactiveCount = all.length - active.length
  const cash = round2(active.filter((a) => a.type === 'cash').reduce((s, a) => s + a.balance, 0))
  const bank = round2(active.filter((a) => a.type !== 'cash').reduce((s, a) => s + a.balance, 0))

  if (loading && !data) return <Loading />

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <StatCard label="Cash in hand" value={<span className={cash < -EPS ? 'text-bad' : ''}>{money(cash)}</span>} icon={<Banknote className="h-5 w-5" />} tone="ok" sub={`${active.filter((a) => a.type === 'cash').length} cash account(s)`} />
        <StatCard label="Bank & wallets" value={<span className={bank < -EPS ? 'text-bad' : ''}>{money(bank)}</span>} icon={<Landmark className="h-5 w-5" />} tone="info" sub={`${active.filter((a) => a.type !== 'cash').length} bank / wallet account(s)`} />
        <StatCard label="Total funds" value={<span className={cash + bank < -EPS ? 'text-bad' : ''}>{money(round2(cash + bank))}</span>} icon={<Wallet className="h-5 w-5" />} tone="brand" sub="Active accounts" />
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        {inactiveCount > 0 ? <Checkbox checked={showInactive} onChange={setShowInactive} label={`Show inactive accounts (${inactiveCount})`} /> : <span />}
        {canManage && (
          <Button variant="primary" size="sm" icon={<Plus className="h-4 w-4" />} onClick={() => setForm({ open: true })}>
            Add account
          </Button>
        )}
      </div>

      {shown.length === 0 ? (
        <Card>
          <Empty
            icon={<Landmark className="h-6 w-6" />}
            title="No cash or bank accounts"
            action={
              canManage && (
                <Button variant="primary" icon={<Plus className="h-4 w-4" />} onClick={() => setForm({ open: true })}>
                  Add account
                </Button>
              )
            }
          >
            Add your cash in hand, bank accounts and mobile wallets to record receipts, payments and expenses.
          </Empty>
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {shown.map((a) => {
            const t = accountType(a.type)
            const negative = a.balance < -EPS
            return (
              <div key={a.id} className={cx('card fade-in flex flex-col p-4', !a.is_active && 'opacity-60')}>
                <div className="flex items-start gap-3">
                  <div className={cx('flex h-11 w-11 shrink-0 items-center justify-center rounded-xl', t.tone)}>{t.icon}</div>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="truncate font-semibold">{a.name}</span>
                      {!!a.is_default && (
                        <Badge tone="brand">
                          <Star className="h-3 w-3" />
                          Default
                        </Badge>
                      )}
                      {!a.is_active && <Badge tone="bad">Inactive</Badge>}
                    </div>
                    <div className="text-[12px] text-muted">
                      {t.label}
                      {a.bank_name ? ` · ${a.bank_name}` : ''}
                    </div>
                  </div>
                </div>
                {(a.account_title || a.account_no || a.iban) && (
                  <div className="mt-3 space-y-0.5 rounded-lg bg-surface-2 px-3 py-2 text-[12px]">
                    {a.account_title && (
                      <div className="truncate">
                        <span className="text-muted">Title: </span>
                        {a.account_title}
                      </div>
                    )}
                    {a.account_no && (
                      <div className="truncate">
                        <span className="text-muted">A/C no: </span>
                        <span className="num">{a.account_no}</span>
                      </div>
                    )}
                    {a.iban && (
                      <div className="truncate">
                        <span className="text-muted">IBAN: </span>
                        <span className="num">{a.iban}</span>
                      </div>
                    )}
                  </div>
                )}
                <div className="mt-auto pt-3">
                  <div className="text-[12px] text-muted">{negative ? 'Balance (overdrawn)' : 'Current balance'}</div>
                  <div className={cx('num truncate text-[24px] font-bold tracking-tight', negative && 'text-bad')}>{money(a.balance)}</div>
                  <div className="text-[12px] text-muted">Opening balance {money(a.opening_balance)}</div>
                </div>
                <div className="mt-3 flex gap-2 border-t border-line pt-3">
                  <Button size="sm" variant="soft" icon={<BookOpen className="h-4 w-4" />} onClick={() => setLedger(a)}>
                    Ledger
                  </Button>
                  {canManage && (
                    <Button size="sm" variant="ghost" icon={<Pencil className="h-4 w-4" />} onClick={() => setForm({ open: true, account: a })}>
                      Edit
                    </Button>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}

      {ledger && <AccountLedgerModal account={ledger} onClose={() => setLedger(null)} />}
      {form.open && <AccountForm account={form.account} onClose={() => setForm({ open: false })} onSaved={() => setLocalTick((t) => t + 1)} />}
    </div>
  )
}

const LEDGER_KINDS: Record<string, { text: string; tone: string }> = {
  receipt: { text: 'Receipt', tone: 'ok' },
  payment: { text: 'Payment', tone: 'warn' },
  expense: { text: 'Expense', tone: 'bad' },
  transfer_in: { text: 'Transfer in', tone: 'info' },
  transfer_out: { text: 'Transfer out', tone: 'muted' }
}

function AccountLedgerModal({ account, onClose }: { account: any; onClose: () => void }): JSX.Element {
  const [range, setRange] = useState<[string, string]>(thisMonth)
  const { data: L, loading } = useLoad(() => api<any>('accounts.ledger', { id: account.id, from: range[0], to: range[1] }), [account.id, range[0], range[1]])

  const exportCsv = async (): Promise<void> => {
    if (!L) return
    try {
      const rows = [
        { date: range[0], number: '', kind: '', description: 'Opening balance', money_in: '', money_out: '', balance: L.opening },
        ...L.rows.map((r: any) => ({ date: r.date, number: r.number, kind: LEDGER_KINDS[r.kind]?.text ?? label(r.kind), description: r.description, money_in: r.money_in || '', money_out: r.money_out || '', balance: r.balance })),
        { date: range[1], number: '', kind: '', description: 'Closing balance', money_in: L.totalIn, money_out: L.totalOut, balance: L.closing }
      ]
      const file = await api('export.csv', {
        filename: `${account.name} ledger ${range[0]} to ${range[1]}`,
        columns: [
          { key: 'date', label: 'Date' },
          { key: 'number', label: 'Number' },
          { key: 'kind', label: 'Type' },
          { key: 'description', label: 'Description' },
          { key: 'money_in', label: 'Money in' },
          { key: 'money_out', label: 'Money out' },
          { key: 'balance', label: 'Balance' }
        ],
        rows
      })
      if (file) toast.ok(`Exported to ${file}`)
    } catch (e) {
      toast.error(e)
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      size="xl"
      title={`${account.name} — cash book`}
      subtitle={`${accountType(account.type).label}${account.bank_name ? ` · ${account.bank_name}` : ''}${account.account_no ? ` · ${account.account_no}` : ''}`}
      footer={
        <>
          <Button icon={<Download className="h-4 w-4" />} onClick={exportCsv} disabled={!L}>
            Export CSV
          </Button>
          <Button onClick={onClose}>Close</Button>
        </>
      }
    >
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <PeriodPicker from={range[0]} to={range[1]} onChange={(a, b) => setRange([a, b])} />
        {L && (
          <div className="flex flex-wrap gap-x-5 gap-y-1 text-[12.5px] text-muted">
            <span>
              In <b className="num text-ok">{money(L.totalIn)}</b>
            </span>
            <span>
              Out <b className="num text-bad">{money(L.totalOut)}</b>
            </span>
            <span>
              Closing <b className={cx('num', L.closing < -EPS ? 'text-bad' : 'text-ink')}>{money(L.closing)}</b>
            </span>
          </div>
        )}
      </div>
      {!L || loading ? (
        <Loading />
      ) : (
        <div className="overflow-hidden rounded-lg border border-line">
          <table className="tbl">
            <thead>
              <tr>
                <th>Date</th>
                <th>Number</th>
                <th>Type</th>
                <th>Description</th>
                <th className="text-right">Money in</th>
                <th className="text-right">Money out</th>
                <th className="text-right">Balance</th>
              </tr>
            </thead>
            <tbody>
              <tr className="bg-surface-2 font-medium">
                <td>{date(range[0])}</td>
                <td colSpan={5}>Opening balance</td>
                <td className={cx('num text-right', L.opening < -EPS && 'text-bad')}>{money(L.opening)}</td>
              </tr>
              {L.rows.map((r: any, i: number) => {
                const k = LEDGER_KINDS[r.kind] ?? { text: label(r.kind), tone: 'muted' }
                return (
                  <tr key={`${r.kind}-${r.ref_id}-${i}`}>
                    <td className="whitespace-nowrap">{date(r.date)}</td>
                    <td className="font-medium whitespace-nowrap">{r.number}</td>
                    <td>
                      <Badge tone={k.tone}>{k.text}</Badge>
                    </td>
                    <td className="max-w-[380px] truncate text-muted" title={r.description}>
                      {r.description}
                    </td>
                    <td className="num text-right text-ok">{r.money_in ? money(r.money_in) : ''}</td>
                    <td className="num text-right text-bad">{r.money_out ? money(r.money_out) : ''}</td>
                    <td className={cx('num text-right font-semibold', r.balance < -EPS && 'text-bad')}>{money(r.balance)}</td>
                  </tr>
                )
              })}
              {L.rows.length === 0 && (
                <tr>
                  <td colSpan={7} className="py-6 text-center text-muted">
                    No transactions in this period.
                  </td>
                </tr>
              )}
            </tbody>
            <tfoot>
              <tr className="bg-surface-2 font-semibold">
                <td>{date(range[1])}</td>
                <td colSpan={3}>Closing balance</td>
                <td className="num text-right text-ok">{money(L.totalIn)}</td>
                <td className="num text-right text-bad">{money(L.totalOut)}</td>
                <td className={cx('num text-right', L.closing < -EPS && 'text-bad')}>{money(L.closing)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </Modal>
  )
}

function AccountForm({ account, onClose, onSaved }: { account?: any; onClose: () => void; onSaved: () => void }): JSX.Element {
  const editing = !!account?.id
  const isDefault = !!account?.is_default
  const [f, setF] = useState<any>(() =>
    editing
      ? {
          id: account.id,
          name: account.name ?? '',
          type: account.type ?? 'cash',
          bankName: account.bank_name ?? '',
          accountTitle: account.account_title ?? '',
          accountNo: account.account_no ?? '',
          iban: account.iban ?? '',
          openingBalance: Number(account.opening_balance) || 0,
          isDefault,
          isActive: !!account.is_active
        }
      : { name: '', type: 'cash', bankName: '', accountTitle: '', accountNo: '', iban: '', openingBalance: 0, isDefault: false, isActive: true }
  )
  const [busy, setBusy] = useState(false)
  const set = (k: string, v: unknown): void => setF((x: any) => ({ ...x, [k]: v }))
  const openingChanged = editing && round2(Number(f.openingBalance) || 0) !== round2(Number(account.opening_balance) || 0)

  const save = async (): Promise<void> => {
    if (!f.name.trim()) {
      toast.error('Enter an account name.')
      return
    }
    if (openingChanged) {
      const ok = await confirmDialog({
        title: 'Change opening balance?',
        message: `The opening balance changes from ${money(account.opening_balance)} to ${money(f.openingBalance)}. Every running balance of this account will shift by ${money(round2(f.openingBalance - account.opening_balance))}. The change is recorded in the audit log.`,
        confirmLabel: 'Change opening balance'
      })
      if (!ok) return
    }
    setBusy(true)
    try {
      const bankish = f.type !== 'cash'
      await api('accounts.save', {
        ...f,
        name: f.name.trim(),
        bankName: bankish ? f.bankName : '',
        accountTitle: bankish ? f.accountTitle : '',
        accountNo: bankish ? f.accountNo : '',
        iban: f.type === 'bank' ? f.iban : '',
        openingBalance: Number(f.openingBalance) || 0
      })
      toast.ok(`${f.name.trim()} saved.`)
      onSaved()
      onClose()
    } catch (e) {
      toast.error(e)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={editing ? `Edit ${account.name}` : 'Add cash / bank account'}
      size="md"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={busy} onClick={save}>
            Save account
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-2 gap-3">
        <Field label="Account name" required>
          <Input autoFocus value={f.name} maxLength={80} onChange={(e) => set('name', e.target.value)} placeholder="e.g. Cash in hand, Meezan Bank" />
        </Field>
        <Field label="Type">
          <Select value={f.type} onChange={(e) => set('type', e.target.value)}>
            <option value="cash">Cash in hand</option>
            <option value="bank">Bank account</option>
            <option value="wallet">Mobile wallet (JazzCash / Easypaisa)</option>
          </Select>
        </Field>
        {f.type !== 'cash' && (
          <>
            <Field label={f.type === 'wallet' ? 'Wallet provider' : 'Bank name'}>
              <Input value={f.bankName} maxLength={80} onChange={(e) => set('bankName', e.target.value)} />
            </Field>
            <Field label="Account title">
              <Input value={f.accountTitle} maxLength={120} onChange={(e) => set('accountTitle', e.target.value)} />
            </Field>
            <Field label={f.type === 'wallet' ? 'Wallet / mobile number' : 'Account number'}>
              <Input value={f.accountNo} maxLength={60} onChange={(e) => set('accountNo', e.target.value)} />
            </Field>
            {f.type === 'bank' && (
              <Field label="IBAN">
                <Input value={f.iban} maxLength={40} onChange={(e) => set('iban', e.target.value.toUpperCase())} placeholder="PK00XXXX0000000000000000" />
              </Field>
            )}
          </>
        )}
        <Field label="Opening balance" className="col-span-2" hint="Money in this account before you started using DT Solar Pro (negative if overdrawn).">
          <NumberInput value={f.openingBalance} onChange={(v) => set('openingBalance', v)} />
        </Field>
        <div className="col-span-2 space-y-3 rounded-lg border border-line p-3">
          <Toggle
            checked={!!f.isDefault}
            disabled={isDefault}
            onChange={(v) => setF((x: any) => ({ ...x, isDefault: v, isActive: v ? true : x.isActive }))}
            label="Default account"
            description={isDefault ? 'This is the default account. To change it, mark another account as default.' : 'Pre-selected when receiving payments and recording expenses.'}
          />
          {editing && (
            <Toggle
              checked={!!f.isActive}
              disabled={isDefault || !!f.isDefault}
              onChange={(v) => set('isActive', v)}
              label="Active"
              description={isDefault || f.isDefault ? 'The default account cannot be deactivated.' : 'Inactive accounts are hidden from pick-lists but keep their history.'}
            />
          )}
        </div>
      </div>
    </Modal>
  )
}

/* ============================== Receipts / payments ============================== */

async function cancelPayment(r: { id: number; number: string; amount: number; direction: string; party_name?: string | null; account_name?: string | null }): Promise<boolean> {
  const noun = r.direction === 'in' ? 'receipt' : 'payment'
  const reason = await promptDialog({
    title: `Cancel ${noun} ${r.number}?`,
    message: (
      <>
        {money(r.amount)} {r.direction === 'in' ? 'received from' : 'paid to'} {r.party_name ?? 'general'}
        {r.account_name ? ` (${r.account_name})` : ''}. The amount is reversed from the account and any invoices, bills or expenses it settled become outstanding again. This is recorded in the audit log.
      </>
    ),
    danger: true,
    confirmLabel: `Cancel ${noun}`,
    input: { label: 'Reason (optional)', placeholder: r.direction === 'in' ? 'e.g. Cheque bounced' : 'e.g. Entered twice' }
  })
  if (reason === null) return false
  try {
    await api('payments.cancel', { id: r.id, reason: reason || undefined })
    toast.ok(`${r.direction === 'in' ? 'Receipt' : 'Payment'} ${r.number} cancelled.`)
    return true
  } catch (e) {
    toast.error(e)
    return false
  }
}

function PaymentsTab({ direction, tick, onChanged }: { direction: 'in' | 'out'; tick: number; onChanged: () => void }): JSX.Element {
  const can = useCan()
  const nav = useNavigate()
  const canManage = can('accounts.manage')
  const canParty = can('customers.view') || can('suppliers.view')
  const [range, setRange] = useState<[string, string]>(thisMonth)
  const [detail, setDetail] = useState<number | null>(null)
  const { data, loading } = useLoad(() => api<any[]>('payments.list', { direction, from: range[0], to: range[1], includeCancelled: true }), [direction, range[0], range[1], tick])
  const rows = data ?? []
  const isIn = direction === 'in'

  const totals = useMemo(() => {
    let count = 0
    let amount = 0
    let advance = 0
    for (const r of rows) {
      if (r.status === 'cancelled') continue
      count++
      amount += r.amount
      if (r.unallocated > EPS) advance += r.unallocated
    }
    return { count, amount: round2(amount), advance: round2(advance) }
  }, [rows])

  const cols: Array<Column<any>> = [
    { key: 'number', header: 'Number', render: (r) => <span className="font-semibold">{r.number}</span> },
    { key: 'date', header: 'Date', render: (r) => date(r.date) },
    {
      key: 'party_name',
      header: isIn ? 'Received from' : 'Paid to',
      value: (r) => r.party_name ?? 'General',
      render: (r) =>
        r.party_id ? (
          canParty ? (
            <button
              type="button"
              className="text-left text-brand hover:underline cursor-pointer"
              onClick={(e) => {
                e.stopPropagation()
                nav(`/party/${r.party_id}`)
              }}
            >
              {r.party_name}
            </button>
          ) : (
            r.party_name
          )
        ) : (
          <span className="text-muted">General{r.notes ? ` — ${r.notes}` : ''}</span>
        )
    },
    { key: 'account_name', header: 'Account' },
    { key: 'method', header: 'Method', value: (r) => methodLabel(r.method) },
    { key: 'reference', header: 'Reference', render: (r) => r.reference || <span className="text-muted">—</span> },
    { key: 'project_name', header: 'Project', render: (r) => r.project_name || <span className="text-muted">—</span> },
    { key: 'amount', header: 'Amount', align: 'right', render: (r) => <span className={cx('font-semibold', r.status !== 'cancelled' && (isIn ? 'text-ok' : 'text-bad'))}>{money(r.amount)}</span> },
    {
      key: 'unallocated',
      header: 'Advance',
      align: 'right',
      value: (r) => (r.status === 'cancelled' ? 0 : Number(r.unallocated) || 0),
      render: (r) => (r.status !== 'cancelled' && r.unallocated > EPS ? <span className="text-info" title="Not yet applied to any invoice / bill (on-account)">{money(r.unallocated)}</span> : <span className="text-muted">—</span>)
    },
    {
      key: 'status',
      header: 'Status',
      value: (r) => (r.status === 'cancelled' ? 'Cancelled' : 'Posted'),
      render: (r) =>
        r.status === 'cancelled' ? (
          <span title={r.cancel_reason ? `Reason: ${r.cancel_reason}` : undefined}>
            <Badge tone="bad">Cancelled</Badge>
          </span>
        ) : (
          <Badge tone="ok">Posted</Badge>
        )
    },
    {
      key: 'actions',
      header: '',
      sortable: false,
      csv: false,
      render: (r) => (
        <div className="flex justify-end">
          <IconButton title="Print voucher" onClick={() => api('print.open', { kind: 'payment', id: r.id }).catch(toast.error)}>
            <Printer className="h-4 w-4" />
          </IconButton>
          {canManage && r.status !== 'cancelled' && (
            <IconButton title={`Cancel ${isIn ? 'receipt' : 'payment'}`} tone="bad" onClick={async () => (await cancelPayment(r)) && onChanged()}>
              <Ban className="h-4 w-4" />
            </IconButton>
          )}
        </div>
      )
    }
  ]

  return (
    <>
      <DataTable
        rows={rows}
        loading={loading}
        columns={cols}
        exportName={isIn ? 'Receipts' : 'Payments'}
        searchPlaceholder="Search number, party, reference…"
        onRowClick={(r: any) => setDetail(r.id)}
        rowClassName={(r: any) => (r.status === 'cancelled' ? 'opacity-50' : undefined)}
        empty={
          <Empty icon={isIn ? <HandCoins className="h-6 w-6" /> : <ArrowUpRight className="h-6 w-6" />} title={isIn ? 'No receipts in this period' : 'No payments in this period'}>
            {isIn ? 'Money received from customers (and refunds from suppliers) appears here.' : 'Money paid to suppliers and contractors (and refunds to customers) appears here.'}
          </Empty>
        }
        toolbar={
          <>
            <PeriodPicker from={range[0]} to={range[1]} onChange={(a, b) => setRange([a, b])} />
            <div className="ml-auto flex flex-wrap items-center gap-x-5 gap-y-1 text-[12.5px] text-muted">
              <span>
                {totals.count} {isIn ? 'receipt' : 'payment'}
                {totals.count === 1 ? '' : 's'}
              </span>
              <span>
                Total <b className={cx('num', isIn ? 'text-ok' : 'text-bad')}>{money(totals.amount)}</b>
              </span>
              {totals.advance > EPS && (
                <span title="Unallocated amounts kept as advance / on-account">
                  Advances <b className="num text-info">{money(totals.advance)}</b>
                </span>
              )}
            </div>
          </>
        }
      />
      {detail !== null && <PaymentDetailModal id={detail} onClose={() => setDetail(null)} onChanged={onChanged} />}
    </>
  )
}

function PaymentDetailModal({ id, onClose, onChanged }: { id: number; onClose: () => void; onChanged: () => void }): JSX.Element {
  const can = useCan()
  const nav = useNavigate()
  const { data: p, loading } = useLoad(() => api<any>('payments.get', { id }), [id])
  const isIn = p?.direction === 'in'
  const allocated = p ? round2(p.amount - (Number(p.unallocated) || 0)) : 0
  const cancelled = p?.status === 'cancelled'
  return (
    <Modal
      open
      onClose={onClose}
      size="lg"
      title={p ? `${isIn ? 'Receipt' : 'Payment'} ${p.number}` : 'Payment'}
      subtitle={p ? `${date(p.date)} · ${isIn ? 'Money in' : 'Money out'}` : undefined}
      footer={
        p && (
          <>
            {can('accounts.manage') && !cancelled && (
              <Button
                variant="danger"
                icon={<Ban className="h-4 w-4" />}
                onClick={async () => {
                  if (await cancelPayment(p)) {
                    onChanged()
                    onClose()
                  }
                }}
              >
                Cancel {isIn ? 'receipt' : 'payment'}
              </Button>
            )}
            <Button icon={<Printer className="h-4 w-4" />} onClick={() => api('print.open', { kind: 'payment', id: p.id }).catch(toast.error)}>
              Print voucher
            </Button>
            <Button onClick={onClose}>Close</Button>
          </>
        )
      }
    >
      {!p || loading ? (
        <Loading />
      ) : (
        <div className="space-y-4">
          {cancelled && (
            <div className="rounded-lg bg-bad-soft px-3 py-2 text-[13px] text-bad">
              Cancelled{p.cancelled_at ? ` on ${dateTime(p.cancelled_at)}` : ''}
              {p.cancel_reason ? ` — ${p.cancel_reason}` : ''}. It no longer affects balances.
            </div>
          )}
          <div className="grid grid-cols-1 gap-x-8 md:grid-cols-2">
            <div className="text-[13.5px]">
              <Kv label={isIn ? 'Received from' : 'Paid to'}>
                {p.party_id && (can('customers.view') || can('suppliers.view')) ? (
                  <button
                    type="button"
                    className="text-brand hover:underline cursor-pointer"
                    onClick={() => {
                      onClose()
                      nav(`/party/${p.party_id}`)
                    }}
                  >
                    {p.party_name}
                  </button>
                ) : (
                  p.party_name ?? 'General'
                )}
              </Kv>
              <Kv label="Account">{p.account_name}</Kv>
              <Kv label="Method">{methodLabel(p.method)}</Kv>
              <Kv label="Reference">{p.reference || '—'}</Kv>
              <Kv label="Project">{p.project_name ? `${p.project_code ? p.project_code + ' — ' : ''}${p.project_name}` : '—'}</Kv>
            </div>
            <div className="text-[13.5px]">
              <Kv label="Amount">
                <b className="text-[15px]">{money(p.amount)}</b>
              </Kv>
              <Kv label="Applied to invoices / bills">{money(allocated)}</Kv>
              <Kv label="Advance (unallocated)">
                <span className={p.unallocated > EPS ? 'text-info' : ''}>{money(p.unallocated)}</span>
              </Kv>
              {p.party_balance !== null && p.party_balance !== undefined && (
                <Kv label="Party balance now">
                  {money(Math.abs(p.party_balance))} {p.party_balance > EPS ? '(they owe us)' : p.party_balance < -EPS ? '(we owe them)' : ''}
                </Kv>
              )}
              <Kv label="Recorded by">
                {p.created_by_name ?? '—'}
                {p.created_at ? <span className="ml-1 text-[12px] font-normal text-muted">{dateTime(p.created_at)}</span> : null}
              </Kv>
            </div>
          </div>
          {p.notes && <div className="rounded-lg bg-surface-2 px-3 py-2 text-[13px] whitespace-pre-wrap text-muted">{p.notes}</div>}
          <div>
            <div className="mb-2 font-semibold">Settled items</div>
            {p.allocations.length === 0 ? (
              <div className="rounded-lg bg-surface-2 px-3 py-3 text-[13px] text-muted">{cancelled ? 'Allocations were released when this was cancelled.' : 'Not applied to any invoice, bill or expense — the full amount is an advance / on-account balance.'}</div>
            ) : (
              <div className="overflow-hidden rounded-lg border border-line">
                <table className="tbl">
                  <thead>
                    <tr>
                      <th>Item</th>
                      <th>Type</th>
                      <th>Date</th>
                      <th className="text-right">Item total</th>
                      <th className="text-right">Settled</th>
                    </tr>
                  </thead>
                  <tbody>
                    {p.allocations.map((a: any) => (
                      <tr
                        key={a.id}
                        className={a.document_id ? 'clickable' : undefined}
                        onClick={() => {
                          if (!a.document_id) return
                          onClose()
                          nav(`/doc/${a.document_id}`)
                        }}
                      >
                        <td className="font-medium">{a.document_number ?? a.expense_number ?? '—'}</td>
                        <td>{a.document_id ? DOC_TYPES[a.doc_type as keyof typeof DOC_TYPES]?.label ?? label(a.doc_type) : 'Expense'}</td>
                        <td>{a.document_date ? date(a.document_date) : '—'}</td>
                        <td className="num text-right">{a.document_total !== null && a.document_total !== undefined ? money(a.document_total) : '—'}</td>
                        <td className="num text-right font-semibold">{money(a.amount)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}
    </Modal>
  )
}

/* ============================== Transfers ============================== */

function TransfersTab({ tick, onNew, onChanged }: { tick: number; onNew?: () => void; onChanged: () => void }): JSX.Element {
  const can = useCan()
  const canManage = can('accounts.manage')
  const [range, setRange] = useState<[string, string]>(thisMonth)
  const { data, loading } = useLoad(() => api<any[]>('transfers.list', { from: range[0], to: range[1] }), [range[0], range[1], tick])
  const rows = data ?? []
  const total = round2(rows.filter((r) => r.status !== 'cancelled').reduce((s, r) => s + r.amount, 0))

  const cancel = async (r: any): Promise<void> => {
    const ok = await confirmDialog({
      title: `Cancel transfer ${r.number}?`,
      message: `${money(r.amount)} from ${r.from_name} to ${r.to_name} will be reversed: ${r.from_name} goes up and ${r.to_name} goes down by this amount. This is recorded in the audit log.`,
      danger: true,
      confirmLabel: 'Cancel transfer'
    })
    if (!ok) return
    try {
      await api('transfers.cancel', { id: r.id })
      toast.ok(`Transfer ${r.number} cancelled.`)
      onChanged()
    } catch (e) {
      toast.error(e)
    }
  }

  const cols: Array<Column<any>> = [
    { key: 'number', header: 'Number', render: (r) => <span className="font-semibold">{r.number}</span> },
    { key: 'date', header: 'Date', render: (r) => date(r.date) },
    { key: 'from_name', header: 'From account' },
    { key: 'arrow', header: '', sortable: false, csv: false, width: 28, render: () => <ArrowRight className="h-4 w-4 text-muted" /> },
    { key: 'to_name', header: 'To account' },
    { key: 'amount', header: 'Amount', align: 'right', render: (r) => <span className="font-semibold">{money(r.amount)}</span> },
    { key: 'notes', header: 'Notes', render: (r) => (r.notes ? <span className="text-muted">{r.notes}</span> : <span className="text-muted">—</span>) },
    {
      key: 'status',
      header: 'Status',
      value: (r) => (r.status === 'cancelled' ? 'Cancelled' : 'Posted'),
      render: (r) => <Badge tone={r.status === 'cancelled' ? 'bad' : 'ok'}>{r.status === 'cancelled' ? 'Cancelled' : 'Posted'}</Badge>
    },
    {
      key: 'actions',
      header: '',
      sortable: false,
      csv: false,
      hidden: !canManage,
      render: (r) =>
        r.status !== 'cancelled' && (
          <div className="flex justify-end">
            <IconButton title="Cancel transfer" tone="bad" onClick={() => cancel(r)}>
              <Ban className="h-4 w-4" />
            </IconButton>
          </div>
        )
    }
  ]

  return (
    <DataTable
      rows={rows}
      loading={loading}
      columns={cols}
      exportName="Account transfers"
      searchPlaceholder="Search transfers…"
      rowClassName={(r: any) => (r.status === 'cancelled' ? 'opacity-50' : undefined)}
      empty={
        <Empty icon={<ArrowLeftRight className="h-6 w-6" />} title="No transfers in this period" action={onNew && <Button variant="primary" icon={<Plus className="h-4 w-4" />} onClick={onNew}>New transfer</Button>}>
          Move money between cash, bank and wallet accounts — e.g. cash deposited into the bank.
        </Empty>
      }
      toolbar={
        <>
          <PeriodPicker from={range[0]} to={range[1]} onChange={(a, b) => setRange([a, b])} />
          <span className="ml-auto text-[12.5px] text-muted">
            Total moved <b className="num text-ink">{money(total)}</b>
          </span>
          {onNew && (
            <Button size="sm" variant="primary" icon={<Plus className="h-4 w-4" />} onClick={onNew}>
              New transfer
            </Button>
          )}
        </>
      }
    />
  )
}

function TransferModal({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }): JSX.Element {
  const { data } = useLoad(() => api<any[]>('accounts.list'), [])
  const accounts = data ?? []
  const [f, setF] = useState<any>({ date: today(), fromAccountId: null, toAccountId: null, amount: 0, notes: '' })
  const [busy, setBusy] = useState(false)
  const set = (k: string, v: unknown): void => setF((x: any) => ({ ...x, [k]: v }))

  // Sensible defaults: from the default (usually cash) account to the first other account.
  useEffect(() => {
    if (!accounts.length) return
    setF((x: any) => {
      if (x.fromAccountId) return x
      const from = accounts.find((a) => a.is_default) ?? accounts[0]
      const to = accounts.find((a) => a.id !== from.id)
      return { ...x, fromAccountId: from.id, toAccountId: to?.id ?? null }
    })
  }, [data]) // eslint-disable-line react-hooks/exhaustive-deps

  const from = accounts.find((a) => a.id === Number(f.fromAccountId))
  const to = accounts.find((a) => a.id === Number(f.toAccountId))
  const amount = Number(f.amount) || 0

  const save = async (): Promise<void> => {
    if (!f.fromAccountId || !f.toAccountId) return toast.error('Select both accounts.')
    if (Number(f.fromAccountId) === Number(f.toAccountId)) return toast.error('Select two different accounts.')
    if (!(amount > 0)) return toast.error('Enter an amount greater than zero.')
    if (from && amount > from.balance + EPS) {
      const ok = await confirmDialog({
        title: 'Not enough balance',
        message: `${from.name} has ${money(from.balance)}. Transferring ${money(amount)} will make it negative (${money(round2(from.balance - amount))}). Continue anyway?`,
        confirmLabel: 'Transfer anyway'
      })
      if (!ok) return
    }
    setBusy(true)
    try {
      await api('transfers.create', { date: f.date, fromAccountId: Number(f.fromAccountId), toAccountId: Number(f.toAccountId), amount, notes: f.notes })
      toast.ok(`Transferred ${money(amount)} to ${to?.name ?? 'account'}.`)
      onSaved()
      onClose()
    } catch (e) {
      toast.error(e)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title="Transfer between accounts"
      subtitle="e.g. cash deposited into the bank, or bank withdrawal to cash"
      size="md"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={busy} onClick={save} disabled={accounts.length < 2}>
            Save transfer
          </Button>
        </>
      }
    >
      {data && accounts.length < 2 ? (
        <Empty icon={<ArrowLeftRight className="h-6 w-6" />} title="At least two active accounts are needed">
          Add another cash, bank or wallet account on the Cash & Bank tab first.
        </Empty>
      ) : (
        <div className="grid grid-cols-2 gap-3">
          <Field label="Date" required>
            <DateInput value={f.date} onChange={(e) => set('date', e.target.value)} />
          </Field>
          <Field label="Amount" required>
            <NumberInput value={f.amount} onChange={(v) => set('amount', v)} autoFocus />
          </Field>
          <Field label="From account" required hint={from ? `Balance ${money(from.balance)}${amount > 0 ? ` → ${money(round2(from.balance - amount))}` : ''}` : undefined}>
            <Select value={f.fromAccountId ?? ''} onChange={(e) => set('fromAccountId', e.target.value ? Number(e.target.value) : null)}>
              <option value="">Select account…</option>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name} ({money(a.balance)})
                </option>
              ))}
            </Select>
          </Field>
          <Field
            label="To account"
            required
            error={f.fromAccountId && Number(f.fromAccountId) === Number(f.toAccountId) ? 'Choose a different account.' : undefined}
            hint={to ? `Balance ${money(to.balance)}${amount > 0 ? ` → ${money(round2(to.balance + amount))}` : ''}` : undefined}
          >
            <Select value={f.toAccountId ?? ''} onChange={(e) => set('toAccountId', e.target.value ? Number(e.target.value) : null)}>
              <option value="">Select account…</option>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name} ({money(a.balance)})
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Notes" className="col-span-2">
            <Textarea rows={2} value={f.notes} maxLength={300} onChange={(e) => set('notes', e.target.value)} placeholder="e.g. Deposit slip no." />
          </Field>
        </div>
      )}
    </Modal>
  )
}

/* ============================== Journal adjustments ============================== */

function AdjustmentsTab({ tick }: { tick: number }): JSX.Element {
  const can = useCan()
  const nav = useNavigate()
  const canManage = can('accounts.manage')
  const canParty = can('customers.view') || can('suppliers.view')
  const [localTick, setLocalTick] = useState(0)
  const { data, loading } = useLoad(() => api<any[]>('partyAdjustments.list'), [tick, localTick])

  const cancel = async (r: any): Promise<void> => {
    const ok = await confirmDialog({
      title: `Cancel adjustment ${r.number}?`,
      message: `The ${r.direction} of ${money(r.amount)} on ${r.party_name}'s balance will be reversed. This is recorded in the audit log.`,
      danger: true,
      confirmLabel: 'Cancel adjustment'
    })
    if (!ok) return
    try {
      await api('partyAdjustments.cancel', { id: r.id })
      toast.ok(`Adjustment ${r.number} cancelled.`)
      setLocalTick((t) => t + 1)
    } catch (e) {
      toast.error(e)
    }
  }

  const cols: Array<Column<any>> = [
    { key: 'number', header: 'Number', render: (r) => <span className="font-semibold">{r.number}</span> },
    { key: 'date', header: 'Date', render: (r) => date(r.date) },
    {
      key: 'party_name',
      header: 'Customer / supplier',
      render: (r) =>
        canParty ? (
          <button
            type="button"
            className="text-left text-brand hover:underline cursor-pointer"
            onClick={(e) => {
              e.stopPropagation()
              nav(`/party/${r.party_id}`)
            }}
          >
            {r.party_name}
          </button>
        ) : (
          r.party_name
        )
    },
    {
      key: 'direction',
      header: 'Type',
      value: (r) => (r.direction === 'debit' ? 'Debit' : 'Credit'),
      render: (r) => (
        <div>
          <Badge tone={r.direction === 'debit' ? 'warn' : 'ok'}>{r.direction === 'debit' ? 'Debit' : 'Credit'}</Badge>
          <div className="mt-0.5 text-[12px] text-muted">{r.direction === 'debit' ? 'Balance increased' : 'Balance reduced'}</div>
        </div>
      )
    },
    { key: 'amount', header: 'Amount', align: 'right', render: (r) => <span className="font-semibold">{money(r.amount)}</span> },
    { key: 'reason', header: 'Reason', render: (r) => (r.reason ? <span className="text-muted">{r.reason}</span> : <span className="text-muted">—</span>) },
    { key: 'created_by_name', header: 'Recorded by' },
    {
      key: 'status',
      header: 'Status',
      value: (r) => (r.status === 'cancelled' ? 'Cancelled' : 'Posted'),
      render: (r) => <Badge tone={r.status === 'cancelled' ? 'bad' : 'ok'}>{r.status === 'cancelled' ? 'Cancelled' : 'Posted'}</Badge>
    },
    {
      key: 'actions',
      header: '',
      sortable: false,
      csv: false,
      hidden: !canManage,
      render: (r) =>
        r.status !== 'cancelled' && (
          <div className="flex justify-end">
            <IconButton title="Cancel adjustment" tone="bad" onClick={() => cancel(r)}>
              <Ban className="h-4 w-4" />
            </IconButton>
          </div>
        )
    }
  ]

  return (
    <DataTable
      rows={data ?? []}
      loading={loading}
      columns={cols}
      exportName="Journal adjustments"
      searchPlaceholder="Search party, number, reason…"
      rowClassName={(r: any) => (r.status === 'cancelled' ? 'opacity-50' : undefined)}
      empty={
        <Empty icon={<Scale className="h-6 w-6" />} title="No journal adjustments">
          Discounts allowed after invoicing, write-offs and balance corrections appear here.
        </Empty>
      }
      toolbar={
        <span className="inline-flex items-center gap-1.5 text-[12.5px] text-muted">
          <Info className="h-4 w-4" />
          Create adjustments from a customer’s or supplier’s page (Adjustment button).
        </span>
      }
    />
  )
}
