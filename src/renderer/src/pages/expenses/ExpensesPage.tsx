/* eslint-disable @typescript-eslint/no-explicit-any */
import { ReactNode, useEffect, useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { AlertTriangle, Ban, Clock, Info, Pencil, Plus, Receipt, Tags, Wallet } from 'lucide-react'
import { api } from '../../api'
import { useCan } from '../../store'
import { Badge, Button, Checkbox, Empty, Field, IconButton, Input, Loading, Modal, NumberInput, PageHeader, PeriodPicker, Select, Tabs, Textarea, Toggle, cx, promptDialog, toast } from '../../components/ui'
import { DataTable, Column } from '../../components/DataTable'
import { Combobox, Option } from '../../components/Combobox'
import { PartyForm } from '../../components/PartyForm'
import { useLoad, useParties } from '../../lib/hooks'
import { date, money, statusTone, today, PERIODS } from '../../lib/format'
import { COST_HEADS, COST_HEAD_LABELS, PAYMENT_METHODS, PAYMENT_METHOD_LABELS } from '@shared/docTypes'
import { EPS } from '@shared/money'
import { DateInput } from '../../components/DateInput'

type Tab = 'expenses' | 'categories'

/** Permissions that may call `projects.options` (mirrors the router). */
const PROJECT_PICKER_PERMS = ['projects.view', 'sales.create', 'purchases.create', 'expenses.manage', 'accounts.manage', 'quotations.manage']

const headLabel = (h: string | null | undefined): string => (h && h in COST_HEAD_LABELS ? COST_HEAD_LABELS[h as keyof typeof COST_HEAD_LABELS] : 'Other')

/** Same rule as the P&L report: overhead linked to a project counts as that project's direct cost. */
const isDirect = (r: { cost_head: string; project_id: number | null }): boolean => r.cost_head !== 'overhead' || !!r.project_id

function expenseStatus(r: any): { tone: string; text: string } {
  if (r.status === 'cancelled') return { tone: statusTone('cancelled'), text: 'Cancelled' }
  if (r.paid) return { tone: statusTone('paid'), text: 'Paid' }
  const due = Number(r.due) || 0
  if (due <= EPS) return { tone: statusTone('paid'), text: 'Settled' }
  if (due < Number(r.amount) - EPS) return { tone: statusTone('partial'), text: 'Part paid' }
  return { tone: statusTone('unpaid'), text: 'Payable' }
}

function methodForAccount(type: string | undefined): string {
  return type === 'bank' ? 'bank_transfer' : type === 'wallet' ? 'online' : 'cash'
}

/** Category <option>s grouped by cost head. Inactive categories are only listed when `keepId` points at one. */
function CategoryOptions({ cats, keepId, includeInactive }: { cats: any[]; keepId?: number | null; includeInactive?: boolean }): JSX.Element {
  const visible = cats.filter((c) => includeInactive || c.is_active || c.id === keepId)
  const known = COST_HEADS as readonly string[]
  const groups: Array<{ key: string; label: string; items: any[] }> = COST_HEADS.map((h) => ({ key: h, label: COST_HEAD_LABELS[h], items: visible.filter((c) => c.cost_head === h) }))
  const rest = visible.filter((c) => !known.includes(c.cost_head))
  if (rest.length) groups.push({ key: 'rest', label: 'Other', items: rest })
  return (
    <>
      {groups
        .filter((g) => g.items.length)
        .map((g) => (
          <optgroup key={g.key} label={g.label}>
            {g.items.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
                {!c.is_active ? ' (inactive)' : ''}
              </option>
            ))}
          </optgroup>
        ))}
    </>
  )
}

/* ================================ Page ================================ */

export function ExpensesPage(): JSX.Element {
  const can = useCan()
  const canManage = can('expenses.manage')
  const [params, setParams] = useSearchParams()
  const tab: Tab = params.get('tab') === 'categories' ? 'categories' : 'expenses'
  const [form, setForm] = useState<{ open: boolean; expense?: any }>(() => ({ open: params.get('new') === '1' && canManage }))
  const [tick, setTick] = useState(0)
  const refresh = (): void => setTick((t) => t + 1)

  useEffect(() => {
    if (params.get('new') === '1') {
      const next = new URLSearchParams(params)
      next.delete('new')
      setParams(next, { replace: true })
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div>
      <PageHeader
        title="Expenses"
        subtitle="Project direct costs (labour, contractors, transport, site material) and general business overheads"
        icon={<Receipt className="h-5 w-5" />}
        actions={
          canManage && (
            <Button variant="primary" icon={<Plus className="h-4 w-4" />} onClick={() => setForm({ open: true })}>
              New expense
            </Button>
          )
        }
      />
      <Tabs
        value={tab}
        onChange={(t) => setParams(t === 'expenses' ? {} : { tab: t }, { replace: true })}
        tabs={[
          { key: 'expenses', label: 'Expenses' },
          { key: 'categories', label: 'Categories' }
        ]}
      />
      {tab === 'expenses' && <ExpensesTab tick={tick} onEdit={(e) => setForm({ open: true, expense: e })} />}
      {tab === 'categories' && <CategoriesTab />}
      <ExpenseForm open={form.open} expense={form.expense} onClose={() => setForm({ open: false })} onSaved={refresh} />
    </div>
  )
}

/* ============================== Expenses list ============================== */

function ExpensesTab({ tick, onEdit }: { tick: number; onEdit: (e: any) => void }): JSX.Element {
  const can = useCan()
  const nav = useNavigate()
  const canManage = can('expenses.manage')
  const canProjects = PROJECT_PICKER_PERMS.some((p) => can(p))
  const [range, setRange] = useState<[string, string]>(() => PERIODS.find((p) => p.key === 'month')!.range())
  const [cat, setCat] = useState('')
  const [head, setHead] = useState('')
  const [projectId, setProjectId] = useState<number | null>(null)
  const [inclCancelled, setInclCancelled] = useState(false)

  const cats = useLoad(() => api<any[]>('expenseCategories.list'), [tick])
  const projects = useLoad(() => (canProjects ? api<any[]>('projects.options') : Promise.resolve([] as any[])), [canProjects])
  const projectOptions: Option[] = (projects.data ?? []).map((p) => ({ value: p.id, label: `${p.code} - ${p.name}`, sub: String(p.status ?? '').replace('_', ' ') }))
  const { data, loading, reload } = useLoad(
    () =>
      api<any[]>('expenses.list', {
        from: range[0],
        to: range[1],
        categoryId: cat ? Number(cat) : undefined,
        costHead: head || undefined,
        projectId: projectId ?? undefined,
        includeCancelled: inclCancelled
      }),
    [range[0], range[1], cat, head, projectId, inclCancelled, tick]
  )
  const rows = data ?? []

  const totals = useMemo(() => {
    const t = { count: 0, total: 0, direct: 0, overhead: 0, payable: 0 }
    for (const r of rows) {
      if (r.status === 'cancelled') continue
      t.count++
      t.total += r.amount
      if (isDirect(r)) t.direct += r.amount
      else t.overhead += r.amount
      if (!r.paid) t.payable += Number(r.due) || 0
    }
    return t
  }, [rows])

  const cancel = async (r: any): Promise<void> => {
    const reason = await promptDialog({
      title: `Cancel expense ${r.number}?`,
      message: (
        <>
          {money(r.amount)} - {r.category_name}
          {r.project_name ? ` (${r.project_name})` : ''}. The expense stays in the records for audit but will no longer count in costs, cash balances or supplier payables.
        </>
      ),
      danger: true,
      confirmLabel: 'Cancel expense',
      input: { label: 'Reason for cancelling', placeholder: 'e.g. Entered twice', required: true }
    })
    if (reason === null) return
    try {
      await api('expenses.cancel', { id: r.id, reason })
      toast.ok(`Expense ${r.number} cancelled.`)
      reload()
    } catch (e) {
      toast.error(e)
    }
  }

  const cols: Array<Column<any>> = [
    { key: 'number', header: 'Number', render: (r) => <span className="font-semibold">{r.number}</span> },
    { key: 'date', header: 'Date', render: (r) => date(r.date) },
    {
      key: 'category_name',
      header: 'Category',
      value: (r) => `${r.category_name} (${isDirect(r) ? 'Direct' : 'Overhead'})`,
      render: (r) => (
        <div>
          <div className="font-medium">{r.category_name}</div>
          {isDirect(r) ? (
            <Badge tone="info" className="mt-0.5">
              {r.cost_head === 'overhead' ? 'Overhead → project cost' : `Direct, ${headLabel(r.cost_head)}`}
            </Badge>
          ) : (
            <Badge tone="muted" className="mt-0.5">
              General overhead
            </Badge>
          )}
        </div>
      )
    },
    {
      key: 'project_name',
      header: 'Project',
      value: (r) => (r.project_id ? `${r.project_code ?? ''} ${r.project_name ?? ''}`.trim() : ''),
      render: (r) =>
        r.project_id ? (
          can('projects.view') ? (
            <button
              type="button"
              className="text-left text-brand hover:underline cursor-pointer"
              onClick={(e) => {
                e.stopPropagation()
                nav(`/projects/${r.project_id}`)
              }}
            >
              <div className="text-[12px] text-muted">{r.project_code}</div>
              <div>{r.project_name}</div>
            </button>
          ) : (
            <div>
              <div className="text-[12px] text-muted">{r.project_code}</div>
              <div>{r.project_name}</div>
            </div>
          )
        ) : (
          <span className="text-muted">-</span>
        )
    },
    {
      key: 'payee',
      header: 'Payee',
      value: (r) => [r.party_name, r.payee_name].filter(Boolean).join(' - '),
      render: (r) =>
        r.party_name || r.payee_name ? (
          <div>
            <div>{r.party_name ?? r.payee_name}</div>
            {r.party_name && r.payee_name && <div className="text-[12px] text-muted">{r.payee_name}</div>}
          </div>
        ) : (
          <span className="text-muted">-</span>
        )
    },
    {
      key: 'account_name',
      header: 'Paid from',
      value: (r) => (r.paid ? r.account_name : 'Payable'),
      render: (r) => (r.paid ? r.account_name ?? '-' : <Badge tone="warn">Payable</Badge>)
    },
    { key: 'amount', header: 'Amount', align: 'right', render: (r) => <span className="font-semibold">{money(r.amount)}</span> },
    {
      key: 'due',
      header: 'Due',
      align: 'right',
      value: (r) => (r.paid || r.status === 'cancelled' ? 0 : Number(r.due) || 0),
      render: (r) => (!r.paid && r.status !== 'cancelled' && Number(r.due) > EPS ? <span className="text-bad">{money(r.due)}</span> : <span className="text-muted">-</span>)
    },
    {
      key: 'status',
      header: 'Status',
      value: (r) => expenseStatus(r).text,
      render: (r) => {
        const s = expenseStatus(r)
        return (
          <span title={r.status === 'cancelled' && r.cancel_reason ? `Reason: ${r.cancel_reason}` : undefined}>
            <Badge tone={s.tone}>{s.text}</Badge>
          </span>
        )
      }
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
            <IconButton title="Edit expense" onClick={() => onEdit(r)}>
              <Pencil className="h-4 w-4" />
            </IconButton>
            <IconButton title="Cancel expense" tone="bad" onClick={() => cancel(r)}>
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
      exportName="Expenses"
      searchPlaceholder="Search number, payee, notes…"
      onRowClick={canManage ? (r: any) => r.status !== 'cancelled' && onEdit(r) : undefined}
      rowClassName={(r: any) => (r.status === 'cancelled' ? 'opacity-50' : undefined)}
      empty={
        <Empty icon={<Receipt className="h-6 w-6" />} title="No expenses in this period">
          Try a different period or filter{canManage ? ', or record a new expense' : ''}.
        </Empty>
      }
      toolbar={
        <>
          <PeriodPicker from={range[0]} to={range[1]} onChange={(a, b) => setRange([a, b])} />
          <Select sm className="w-48" value={cat} onChange={(e) => setCat(e.target.value)} aria-label="Category">
            <option value="">All categories</option>
            <CategoryOptions cats={cats.data ?? []} includeInactive />
          </Select>
          <Select sm className="w-48" value={head} onChange={(e) => setHead(e.target.value)} aria-label="Cost head">
            <option value="">All cost heads</option>
            {COST_HEADS.map((h) => (
              <option key={h} value={h}>
                {COST_HEAD_LABELS[h]}
              </option>
            ))}
          </Select>
          {canProjects && (
            <div className="w-56">
              <Combobox sm options={projectOptions} value={projectId} onChange={(v) => setProjectId(v === null || v === undefined ? null : Number(v))} placeholder="All projects" allowClear />
            </div>
          )}
          <Checkbox checked={inclCancelled} onChange={setInclCancelled} label="Include cancelled" />
          <div className="flex w-full flex-wrap items-center gap-x-5 gap-y-1 text-[12.5px] text-muted">
            <span>
              {totals.count} expense{totals.count === 1 ? '' : 's'}
            </span>
            <span>
              Total <b className="num text-ink">{money(totals.total)}</b>
            </span>
            <span title="Project-linked expenses and direct cost heads (material, labour, contractor, transport, other)">
              Project / direct <b className="num text-info">{money(totals.direct)}</b>
            </span>
            <span title="General overhead categories not linked to a project">
              General overhead <b className="num text-ink">{money(totals.overhead)}</b>
            </span>
            {totals.payable > EPS && (
              <span>
                Still payable <b className="num text-bad">{money(totals.payable)}</b>
              </span>
            )}
          </div>
        </>
      }
    />
  )
}

/* ============================== Categories ============================== */

function CategoriesTab(): JSX.Element {
  const can = useCan()
  const canManage = can('expenses.manage')
  const { data, loading, reload } = useLoad(() => api<any[]>('expenseCategories.list'), [])
  const [edit, setEdit] = useState<any>(null)
  const [busy, setBusy] = useState(false)

  const save = async (): Promise<void> => {
    if (!edit.name.trim()) {
      toast.error('Enter a category name.')
      return
    }
    setBusy(true)
    try {
      await api('expenseCategories.save', { id: edit.id, name: edit.name.trim(), costHead: edit.costHead, isActive: edit.isActive })
      toast.ok(`Category "${edit.name.trim()}" saved.`)
      setEdit(null)
      reload()
    } catch (e) {
      toast.error(e)
    } finally {
      setBusy(false)
    }
  }

  const cols: Array<Column<any>> = [
    {
      key: 'name',
      header: 'Category',
      render: (r) => (
        <div className="flex items-center gap-2">
          <Tags className="h-4 w-4 text-muted" />
          <span className="font-medium">{r.name}</span>
          {!r.is_active && <Badge tone="bad">Inactive</Badge>}
        </div>
      )
    },
    {
      key: 'cost_head',
      header: 'Cost head',
      value: (r) => headLabel(r.cost_head),
      render: (r) => <Badge tone={r.cost_head === 'overhead' ? 'muted' : 'info'}>{headLabel(r.cost_head)}</Badge>
    },
    {
      key: 'kind',
      header: 'Counts as',
      value: (r) => (r.cost_head === 'overhead' ? 'General overhead' : 'Project direct cost'),
      render: (r) => (
        <span className="text-[12.5px] text-muted">
          {r.cost_head === 'overhead' ? 'General overhead (project cost when linked to a project)' : 'Project direct cost'}
        </span>
      )
    },
    { key: 'usage', header: 'Expenses', align: 'right', value: (r) => Number(r.usage) || 0 },
    {
      key: 'is_active',
      header: 'Status',
      value: (r) => (r.is_active ? 'Active' : 'Inactive'),
      render: (r) => <Badge tone={r.is_active ? 'ok' : 'muted'}>{r.is_active ? 'Active' : 'Inactive'}</Badge>
    },
    {
      key: 'actions',
      header: '',
      sortable: false,
      csv: false,
      hidden: !canManage,
      render: (r) => (
        <div className="flex justify-end">
          <IconButton title="Edit category" onClick={() => setEdit({ id: r.id, name: r.name, costHead: r.cost_head, isActive: !!r.is_active, usage: Number(r.usage) || 0, originalHead: r.cost_head })}>
            <Pencil className="h-4 w-4" />
          </IconButton>
        </div>
      )
    }
  ]

  return (
    <>
      <DataTable
        rows={data ?? []}
        loading={loading}
        columns={cols}
        exportName="Expense categories"
        searchPlaceholder="Search categories…"
        onRowClick={canManage ? (r: any) => setEdit({ id: r.id, name: r.name, costHead: r.cost_head, isActive: !!r.is_active, usage: Number(r.usage) || 0, originalHead: r.cost_head }) : undefined}
        rowClassName={(r: any) => (!r.is_active ? 'opacity-60' : undefined)}
        toolbar={
          canManage && (
            <Button size="sm" variant="primary" icon={<Plus className="h-4 w-4" />} onClick={() => setEdit({ name: '', costHead: 'overhead', isActive: true, usage: 0 })}>
              New category
            </Button>
          )
        }
      />
      <Modal
        open={!!edit}
        onClose={() => setEdit(null)}
        title={edit?.id ? 'Edit expense category' : 'New expense category'}
        size="sm"
        footer={
          <>
            <Button onClick={() => setEdit(null)}>Cancel</Button>
            <Button variant="primary" loading={busy} onClick={save}>
              Save
            </Button>
          </>
        }
      >
        {edit && (
          <div className="space-y-3">
            <Field label="Name" required>
              <Input autoFocus value={edit.name} maxLength={80} onChange={(e) => setEdit({ ...edit, name: e.target.value })} onKeyDown={(e) => e.key === 'Enter' && save()} placeholder="e.g. Installation labour" />
            </Field>
            <Field label="Cost head" hint={edit.costHead === 'overhead' ? 'General business overhead (rent, salaries, utilities…). If an expense in this category is linked to a project, it counts as that project’s other direct cost.' : 'Project direct cost - expenses linked to a project are added to that project’s cost and reduce its profit.'}>
              <Select value={edit.costHead} onChange={(e) => setEdit({ ...edit, costHead: e.target.value })}>
                {COST_HEADS.map((h) => (
                  <option key={h} value={h}>
                    {COST_HEAD_LABELS[h]}
                  </option>
                ))}
              </Select>
            </Field>
            {edit.id && edit.usage > 0 && edit.costHead !== edit.originalHead && (
              <div className="flex gap-2 rounded-lg bg-warn-soft px-3 py-2 text-[12.5px] text-warn">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                <span>
                  {edit.usage} existing expense{edit.usage === 1 ? '' : 's'} will be re-classified under {headLabel(edit.costHead)} in project costs and reports.
                </span>
              </div>
            )}
            {edit.id && <Toggle checked={edit.isActive} onChange={(v) => setEdit({ ...edit, isActive: v })} label="Active" description="Inactive categories are hidden when recording new expenses but keep their history." />}
          </div>
        )}
      </Modal>
    </>
  )
}

/* ============================== Expense form ============================== */

interface ExpenseFormProps {
  open: boolean
  expense?: any
  preset?: { projectId?: number | null; partyId?: number | null }
  onClose: () => void
  onSaved: (id?: number) => void
}

/** Record or edit an expense. Mounted lazily so pick-lists are fresh each time it opens. */
export function ExpenseForm({ open, expense, preset, onClose, onSaved }: ExpenseFormProps): JSX.Element | null {
  if (!open) return null
  return <ExpenseFormBody open expense={expense} preset={preset} onClose={onClose} onSaved={onSaved} />
}

function fromExpense(e: any): any {
  return {
    date: e.date ?? today(),
    categoryId: e.category_id ?? null,
    amount: Number(e.amount) || 0,
    projectId: e.project_id ?? null,
    paid: !!e.paid,
    accountId: e.account_id ?? null,
    method: e.method || 'cash',
    reference: e.reference ?? '',
    partyId: e.party_id ?? null,
    payeeName: e.payee_name ?? '',
    notes: e.notes ?? ''
  }
}

function ExpenseFormBody({ expense, preset, onClose, onSaved }: ExpenseFormProps): JSX.Element {
  const can = useCan()
  const editing = !!expense?.id
  const cats = useLoad(() => api<any[]>('expenseCategories.list'), [])
  const accts = useLoad(() => api<any[]>('accounts.list'), [])
  const { options: supplierOptions, reload: reloadParties } = useParties('supplier')
  const projects = useLoad(() => api<any[]>('projects.options'), [])
  const [f, setF] = useState<any>(() =>
    editing
      ? fromExpense(expense)
      : { date: today(), categoryId: null, amount: 0, projectId: preset?.projectId ?? null, paid: true, accountId: null, method: 'cash', reference: '', partyId: preset?.partyId ?? null, payeeName: '', notes: '' }
  )
  const [allocated, setAllocated] = useState(0)
  const [loadingExp, setLoadingExp] = useState(editing)
  const [busy, setBusy] = useState(false)
  const [newParty, setNewParty] = useState<string | null>(null)
  const set = (k: string, v: unknown): void => setF((x: any) => ({ ...x, [k]: v }))

  // Fresh copy (and amount already settled by supplier payments) when editing.
  useEffect(() => {
    if (!editing) return
    let alive = true
    api<any>('expenses.get', { id: expense.id })
      .then((e) => {
        if (!alive) return
        setF(fromExpense(e))
        setAllocated(Number(e.allocated) || 0)
      })
      .catch((e) => toast.error(e))
      .finally(() => alive && setLoadingExp(false))
    return () => {
      alive = false
    }
  }, [editing, expense?.id])

  const accounts = accts.data ?? []
  const defaultAccount = accounts.find((a) => a.is_default) ?? accounts[0]

  // New expense: preselect the default cash / bank account once accounts load.
  useEffect(() => {
    if (editing || !defaultAccount) return
    setF((x: any) => (x.accountId ? x : { ...x, accountId: defaultAccount.id, method: methodForAccount(defaultAccount.type) }))
  }, [editing, defaultAccount?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  const categories = cats.data ?? []
  const category = categories.find((c) => c.id === Number(f.categoryId))
  const lockedToCredit = allocated > EPS // supplier payments already settle this expense

  const projectOptions: Option[] = useMemo(() => {
    const opts: Option[] = (projects.data ?? []).map((p) => ({ value: p.id, label: `${p.code} - ${p.name}`, sub: String(p.status ?? '').replace('_', ' ') }))
    if (f.projectId && !opts.some((o) => Number(o.value) === Number(f.projectId)) && expense?.project_id === f.projectId && expense?.project_name) {
      opts.unshift({ value: f.projectId, label: expense.project_code ? `${expense.project_code} - ${expense.project_name}` : expense.project_name })
    }
    return opts
  }, [projects.data, f.projectId, expense])

  const partyOptions: Option[] = useMemo(() => {
    if (f.partyId && !supplierOptions.some((o) => Number(o.value) === Number(f.partyId)) && expense?.party_id === f.partyId && expense?.party_name) {
      return [{ value: f.partyId, label: expense.party_name }, ...supplierOptions]
    }
    return supplierOptions
  }, [supplierOptions, f.partyId, expense])

  const accountMissing = !!accts.data && !!f.paid && !!f.accountId && !accounts.some((a) => a.id === Number(f.accountId))

  const setMode = (paid: boolean): void => {
    if (paid && lockedToCredit) return
    setF((x: any) => {
      if (!paid) return { ...x, paid: false }
      const acc = x.accountId ? x.accountId : defaultAccount?.id ?? null
      const accType = accounts.find((a) => a.id === Number(acc))?.type
      return { ...x, paid: true, accountId: acc, method: x.method || methodForAccount(accType) }
    })
  }

  const save = async (): Promise<void> => {
    if (!f.date) return toast.error('Enter the expense date.')
    if (!f.categoryId) return toast.error('Select an expense category.')
    if (!(Number(f.amount) > 0)) return toast.error('Enter an amount greater than zero.')
    if (lockedToCredit && Number(f.amount) + EPS < allocated) return toast.error(`Amount cannot be less than ${money(allocated)} already paid against this expense.`)
    if (f.paid && !f.accountId) return toast.error('Select the cash / bank account the money was paid from.')
    if (!f.paid && !f.partyId) return toast.error('Select the supplier / contractor this amount is payable to.')
    setBusy(true)
    try {
      const payload = {
        id: editing ? expense.id : undefined,
        date: f.date,
        categoryId: Number(f.categoryId),
        projectId: f.projectId ? Number(f.projectId) : null,
        amount: Number(f.amount),
        paid: !!f.paid,
        accountId: f.paid ? Number(f.accountId) : null,
        partyId: f.partyId ? Number(f.partyId) : null,
        payeeName: f.payeeName,
        method: f.paid ? f.method : '',
        reference: f.reference,
        notes: f.notes
      }
      const id = await api<number>(editing ? 'expenses.update' : 'expenses.create', payload)
      toast.ok(editing ? 'Expense updated.' : f.paid ? 'Expense recorded.' : 'Expense recorded as payable to the supplier / contractor.')
      onSaved(id)
      onClose()
    } catch (e) {
      toast.error(e)
    } finally {
      setBusy(false)
    }
  }

  let hint: { direct: boolean; text: ReactNode } | null = null
  if (category) {
    if (category.cost_head === 'overhead') {
      hint = f.projectId
        ? { direct: true, text: 'General overhead category, but linked to a project - it will be charged to that project as other direct cost and reduce its profit.' }
        : { direct: false, text: 'General overhead - shown under operating expenses in Profit & Loss and not charged to any project.' }
    } else {
      hint = f.projectId
        ? { direct: true, text: `Project direct cost - added to the project’s ${headLabel(category.cost_head).toLowerCase()} and reduces its profit.` }
        : { direct: true, text: `Direct cost (${headLabel(category.cost_head)}). Link it to a project so it is included in that project’s cost and profit.` }
    }
  }

  return (
    <>
      <Modal
        open
        onClose={onClose}
        title={editing ? `Edit expense ${expense.number ?? ''}` : 'New expense'}
        subtitle="Labour, contractor, transport, site material and general business expenses"
        size="lg"
        footer={
          <>
            <Button onClick={onClose}>Cancel</Button>
            <Button variant="primary" loading={busy} disabled={loadingExp} onClick={save}>
              {editing ? 'Save changes' : 'Save expense'}
            </Button>
          </>
        }
      >
        {loadingExp ? (
          <Loading />
        ) : (
          <div className="grid grid-cols-3 gap-3">
            {lockedToCredit && (
              <div className="col-span-3 flex gap-2 rounded-lg bg-warn-soft px-3 py-2 text-[12.5px] text-warn">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                <span>
                  {money(allocated)} has already been paid against this expense. The supplier / contractor and payment mode cannot be changed, and the amount cannot go below what was paid, until those payments are cancelled.
                </span>
              </div>
            )}
            <Field label="Date" required>
              <DateInput value={f.date} onChange={(e) => set('date', e.target.value)} />
            </Field>
            <Field label="Category" required className="col-span-2">
              <Select value={f.categoryId ?? ''} onChange={(e) => set('categoryId', e.target.value ? Number(e.target.value) : null)} autoFocus={!editing}>
                <option value="">Select category…</option>
                <CategoryOptions cats={categories} keepId={f.categoryId} />
              </Select>
            </Field>
            {hint && (
              <div className={cx('col-span-3 -mt-1 flex gap-2 rounded-lg px-3 py-2 text-[12.5px]', hint.direct ? 'bg-info-soft text-info' : 'bg-surface-2 text-muted')}>
                <Info className="mt-0.5 h-4 w-4 shrink-0" />
                <span>{hint.text}</span>
              </div>
            )}
            <Field label="Amount" required hint={lockedToCredit ? `Minimum ${money(allocated)} (already paid)` : undefined}>
              <NumberInput value={f.amount} onChange={(v) => set('amount', v)} />
            </Field>
            <Field label="Project (optional)" className="col-span-2">
              <Combobox options={projectOptions} value={f.projectId} onChange={(v) => set('projectId', v === null || v === undefined ? null : Number(v))} placeholder="Not linked to a project (general expense)" allowClear />
            </Field>

            <div className="col-span-3">
              <div className="mb-1 text-[12.5px] font-medium text-muted">Payment</div>
              <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="Payment">
                {[
                  { paid: true, title: 'Paid now', desc: 'Paid from a cash / bank account', icon: <Wallet className="h-4 w-4" /> },
                  { paid: false, title: 'On credit - payable', desc: 'Payable to a supplier / contractor, settled later with a supplier payment', icon: <Clock className="h-4 w-4" /> }
                ].map((o) => {
                  const active = !!f.paid === o.paid
                  return (
                    <button
                      key={String(o.paid)}
                      type="button"
                      role="radio"
                      aria-checked={active}
                      disabled={o.paid && lockedToCredit}
                      onClick={() => setMode(o.paid)}
                      className={cx('flex items-start gap-3 rounded-xl border p-3 text-left transition cursor-pointer disabled:cursor-not-allowed disabled:opacity-50', active ? 'border-brand bg-brand-soft' : 'border-line hover:bg-surface-2')}
                    >
                      <span className={cx('mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg', active ? 'bg-brand text-on-brand' : 'bg-surface-2 text-muted')}>{o.icon}</span>
                      <span>
                        <span className="block font-semibold">{o.title}</span>
                        <span className="block text-[12px] text-muted">{o.desc}</span>
                      </span>
                    </button>
                  )
                })}
              </div>
            </div>

            <Field
              label={f.paid ? 'Paid to - supplier / contractor (optional)' : 'Payable to - supplier / contractor'}
              required={!f.paid}
              className="col-span-2"
              hint={f.paid ? 'Select one to keep this expense in their ledger.' : 'The amount is added to what you owe them. Pay it later from Accounts → Make payment.'}
            >
              <Combobox
                options={partyOptions}
                value={f.partyId}
                onChange={(v) => set('partyId', v === null || v === undefined ? null : Number(v))}
                placeholder="Select supplier / contractor"
                allowClear={!lockedToCredit}
                disabled={lockedToCredit}
                onCreate={can('suppliers.manage') && !lockedToCredit ? (text) => setNewParty(text) : undefined}
                createLabel="New supplier / contractor"
              />
            </Field>
            <Field label="Payee name" hint="Free text, e.g. labourer or driver name">
              <Input value={f.payeeName} maxLength={120} onChange={(e) => set('payeeName', e.target.value)} />
            </Field>

            {f.paid ? (
              <>
                <Field label="Paid from account" required error={accountMissing ? 'This account is inactive - choose another.' : undefined}>
                  {accounts.length === 0 && !accts.loading ? (
                    <div className="rounded-lg bg-warn-soft px-3 py-2 text-[12.5px] text-warn">No active cash / bank account. Add one in Accounts first.</div>
                  ) : (
                    <Select
                      value={f.accountId ?? ''}
                      onChange={(e) => {
                        const acc = accounts.find((a) => a.id === Number(e.target.value))
                        setF((x: any) => ({ ...x, accountId: acc ? acc.id : null, method: acc ? methodForAccount(acc.type) : x.method }))
                      }}
                    >
                      {!f.accountId && <option value="">Select account…</option>}
                      {accountMissing && <option value={f.accountId}>{expense?.account_name ?? 'Inactive account'} (inactive)</option>}
                      {accounts.map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.name} ({money(a.balance)})
                        </option>
                      ))}
                    </Select>
                  )}
                </Field>
                <Field label="Method">
                  <Select value={f.method} onChange={(e) => set('method', e.target.value)}>
                    {PAYMENT_METHODS.map((m) => (
                      <option key={m} value={m}>
                        {PAYMENT_METHOD_LABELS[m]}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Reference" hint="Cheque / transaction / receipt no.">
                  <Input value={f.reference} maxLength={100} onChange={(e) => set('reference', e.target.value)} />
                </Field>
              </>
            ) : (
              <Field label="Supplier bill / reference no." className="col-span-3">
                <Input value={f.reference} maxLength={100} onChange={(e) => set('reference', e.target.value)} placeholder="Optional" />
              </Field>
            )}

            <Field label="Notes" className="col-span-3">
              <Textarea rows={2} value={f.notes} maxLength={1000} onChange={(e) => set('notes', e.target.value)} placeholder="What was this for?" />
            </Field>
          </div>
        )}
      </Modal>
      <PartyForm
        open={newParty !== null}
        type="supplier"
        initialName={newParty ?? ''}
        onClose={() => setNewParty(null)}
        onSaved={async (id) => {
          await reloadParties()
          set('partyId', id)
        }}
      />
    </>
  )
}
