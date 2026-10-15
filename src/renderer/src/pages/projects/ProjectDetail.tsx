import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import {
  ArrowLeft, Pencil, Printer, PackageMinus, PackagePlus, FilePlus2, ShoppingBag, Receipt, HandCoins, Paperclip, ExternalLink, Trash2, Zap, MapPin, Phone, User, CalendarDays, Plus, Ban
} from 'lucide-react'
import { api } from '../../api'
import { WhatsAppButton } from '../../components/WhatsAppButton'
import { useCan } from '../../store'
import { Badge, Button, Card, Empty, Field, IconButton, Input, Kv, Loading, Modal, NumberInput, Progress, Select, StatCard, Tabs, confirmDialog, cx, toast } from '../../components/ui'
import { DataTable } from '../../components/DataTable'
import { Combobox } from '../../components/Combobox'
import { HBar } from '../../components/Charts'
import { PaymentModal } from '../../components/PaymentModal'
import { ExpenseForm } from '../expenses/ExpensesPage'
import { ProjectForm } from './ProjectsPage'
import { useLoad, useProducts, useWarehouses } from '../../lib/hooks'
import { date, label, money, pct, qty, statusTone, today } from '../../lib/format'
import { PROJECT_STATUS_LABELS, SYSTEM_TYPE_LABELS } from '@shared/docTypes'

/* eslint-disable @typescript-eslint/no-explicit-any */
type Tab = 'overview' | 'ledger' | 'materials' | 'documents' | 'files'

export function ProjectDetail(): JSX.Element {
  const { id } = useParams()
  const nav = useNavigate()
  const can = useCan()
  const [tab, setTab] = useState<Tab>('overview')
  const [edit, setEdit] = useState(false)
  const [move, setMove] = useState<'issue' | 'return' | null>(null)
  const [pay, setPay] = useState<'in' | 'out' | null>(null)
  const [expense, setExpense] = useState(false)
  const { data: p, reload } = useLoad(() => api<any>('projects.get', { id: Number(id) }), [id])
  const [tick, setTick] = useState(0)
  const refresh = (): void => {
    reload()
    setTick((t) => t + 1)
  }
  if (!p) return <Loading />
  const f = p.financials
  const fin = f.netProfit !== undefined
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <IconButton title="Back" onClick={() => nav('/projects')}><ArrowLeft className="h-5 w-5" /></IconButton>
        <div className="mr-auto">
          <div className="flex items-center gap-2">
            <h1 className="text-[20px] font-bold">{p.name}</h1>
            <Badge tone={statusTone(p.status)}>{PROJECT_STATUS_LABELS[p.status as keyof typeof PROJECT_STATUS_LABELS]}</Badge>
          </div>
          <div className="flex flex-wrap gap-4 text-[12.5px] text-muted">
            <span>{p.code}</span>
            <span className="inline-flex items-center gap-1"><Zap className="h-3.5 w-3.5 text-sun" />{qty(p.capacity_kw)} kW · {SYSTEM_TYPE_LABELS[p.system_type]} · {label(p.project_type)}</span>
            {p.customer_name && <span className="inline-flex items-center gap-1"><User className="h-3.5 w-3.5" /><button type="button" className="text-brand hover:underline cursor-pointer" onClick={() => nav(`/party/${p.customer_id}`)}>{p.customer_name}</button></span>}
            {(p.contact_phone || p.customer_phone) && <span className="inline-flex items-center gap-1"><Phone className="h-3.5 w-3.5" />{p.contact_phone || p.customer_phone}</span>}
            {(p.site_address || p.city) && <span className="inline-flex items-center gap-1"><MapPin className="h-3.5 w-3.5" />{[p.site_address, p.city].filter(Boolean).join(', ')}</span>}
          </div>
        </div>
        <Button icon={<Printer className="h-4 w-4" />} onClick={() => api('print.open', { kind: 'project', id: p.id })}>Project statement</Button>
        <WhatsAppButton entity="project" id={p.id} partyId={p.customer_id} phone={p.contact_phone || p.customer_phone} />
        {can('projects.manage') && <Button icon={<Pencil className="h-4 w-4" />} onClick={() => setEdit(true)}>Edit</Button>}
      </div>

      <Card>
        <div className="flex flex-wrap items-center gap-2">
          <span className="mr-2 text-[13px] font-semibold">Record for this project:</span>
          {can('quotations.manage') && <Button size="sm" variant="soft" icon={<FilePlus2 className="h-4 w-4" />} onClick={() => nav(`/doc/new/quotation?project=${p.id}&party=${p.customer_id ?? ''}`)}>Quotation</Button>}
          {can('sales.create') && <Button size="sm" variant="soft" icon={<FilePlus2 className="h-4 w-4" />} onClick={() => nav(`/doc/new/sale_invoice?project=${p.id}&party=${p.customer_id ?? ''}`)}>Sales invoice</Button>}
          {can('accounts.manage') && <Button size="sm" variant="soft" icon={<HandCoins className="h-4 w-4" />} onClick={() => setPay('in')}>Customer payment / advance</Button>}
          {can('projects.manage') && <Button size="sm" variant="soft" icon={<PackageMinus className="h-4 w-4" />} onClick={() => setMove('issue')}>Issue materials</Button>}
          {can('projects.manage') && <Button size="sm" variant="ghost" icon={<PackagePlus className="h-4 w-4" />} onClick={() => setMove('return')}>Return materials</Button>}
          {can('purchases.create') && <Button size="sm" variant="soft" icon={<ShoppingBag className="h-4 w-4" />} onClick={() => nav(`/doc/new/purchase_invoice?project=${p.id}`)}>Purchase for site</Button>}
          {can('expenses.manage') && <Button size="sm" variant="soft" icon={<Receipt className="h-4 w-4" />} onClick={() => setExpense(true)}>Labor / expense</Button>}
          {can('accounts.manage') && <Button size="sm" variant="ghost" icon={<HandCoins className="h-4 w-4" />} onClick={() => setPay('out')}>Pay supplier / contractor</Button>}
        </div>
      </Card>

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard label="Contract value" value={money(f.contractValue)} icon={<FilePlus2 className="h-5 w-5" />} sub={f.unbilledContract > 0 ? `${money(f.unbilledContract)} not yet invoiced` : 'Fully invoiced'} />
        {fin && <StatCard label="Revenue (excl. tax)" value={money(f.revenue)} icon={<Zap className="h-5 w-5" />} tone="info" sub={f.taxCollected ? `Tax collected ${money(f.taxCollected)}` : undefined} />}
        <StatCard label="Received from customer" value={money(f.received)} icon={<HandCoins className="h-5 w-5" />} tone="ok" sub={`Invoiced ${money(f.invoicedTotal)}`} />
        <StatCard label={f.customerOutstanding >= 0 ? 'Customer outstanding' : 'Customer advance'} value={<span className={f.customerOutstanding > 0.5 ? 'text-bad' : 'text-ok'}>{money(Math.abs(f.customerOutstanding))}</span>} icon={<User className="h-5 w-5" />} tone={f.customerOutstanding > 0.5 ? 'bad' : 'ok'} />
        {fin && <StatCard label="Total direct cost" value={money(f.totalDirectCost)} icon={<PackageMinus className="h-5 w-5" />} tone="warn" sub={`Material ${money(f.materialCost)}`} />}
        {fin && <StatCard label="Gross profit" value={<span className={f.grossProfit < 0 ? 'text-bad' : ''}>{money(f.grossProfit)}</span>} icon={<Zap className="h-5 w-5" />} tone="sun" />}
        {fin && <StatCard label="Net profit" value={<span className={f.netProfit < 0 ? 'text-bad' : 'text-ok'}>{money(f.netProfit)}</span>} icon={<Zap className="h-5 w-5" />} tone={f.netProfit < 0 ? 'bad' : 'ok'} sub={`Margin ${pct(f.marginPct)}`} />}
        <StatCard label="Supplier / contractor dues" value={money(f.supplierOutstanding)} icon={<ShoppingBag className="h-5 w-5" />} tone="warn" sub={f.pendingPurchaseOrders ? `${f.pendingPurchaseOrders} open PO (${money(f.pendingPurchaseValue)})` : undefined} />
      </div>

      <Tabs value={tab} onChange={setTab} tabs={[{ key: 'overview', label: 'Overview' }, { key: 'ledger', label: 'Project ledger' }, { key: 'materials', label: 'Material usage' }, { key: 'documents', label: 'Issues & returns' }, { key: 'files', label: 'Documents & files', count: p.attachments.length }]} />

      {tab === 'overview' && (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          {fin ? (
            <Card title="Profit calculation" className="lg:col-span-2">
              <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
                <div className="text-[13.5px]">
                  <Kv label="Project revenue (excl. tax)"><b>{money(f.revenue)}</b></Kv>
                  <div className="my-1 border-t border-dashed border-line" />
                  <Kv label="Materials on invoices (stock cost)">{money(f.materialFromInvoices)}</Kv>
                  <Kv label="Materials issued from stock (net)">{money(f.materialIssued)}</Kv>
                  <Kv label="Bought direct to site">{money(f.materialDirectPurchase)}</Kv>
                  <Kv label="Site material expenses">{money(f.materialExpenses)}</Kv>
                  <Kv label="= Direct material cost"><b>{money(f.materialCost)}</b></Kv>
                  <Kv label="Labor & contractor cost">{money(f.laborCost)}</Kv>
                  <Kv label="Transport & other direct cost">{money(f.otherCost)}</Kv>
                  <Kv label="= Total direct cost"><b>{money(f.totalDirectCost)}</b></Kv>
                  <div className="my-1 border-t border-dashed border-line" />
                  <Kv label="Gross project profit"><b className={f.grossProfit < 0 ? 'text-bad' : ''}>{money(f.grossProfit)}</b></Kv>
                  <Kv label="Allocated overheads">{money(f.overheads)}</Kv>
                  <Kv label="Net project profit"><b className={cx('text-[16px]', f.netProfit < 0 ? 'text-bad' : 'text-ok')}>{money(f.netProfit)}</b></Kv>
                  <Kv label="Profit margin">{pct(f.marginPct)}</Kv>
                </div>
                <div>
                  <div className="mb-2 text-[12.5px] font-semibold text-muted">Cost & revenue breakdown</div>
                  <HBar
                    items={[
                      { label: 'Revenue', value: f.revenue },
                      { label: 'Material', value: f.materialCost },
                      { label: 'Labor & contractors', value: f.laborCost },
                      { label: 'Transport & other', value: f.otherCost },
                      { label: 'Overheads', value: f.overheads },
                      { label: 'Net profit', value: f.netProfit }
                    ]}
                  />
                  <div className="mt-4 rounded-xl bg-surface-2 p-3 text-[12px] text-muted">
                    Profit is based on invoiced revenue and incurred costs — not on cash received or paid. Customer payments, supplier dues and profit are shown separately.
                  </div>
                </div>
              </div>
            </Card>
          ) : (
            <Card className="lg:col-span-2"><Empty title="Profit details are hidden">You do not have permission to view project costs and profit.</Empty></Card>
          )}
          <Card title="Project info">
            <div className="mb-3"><div className="mb-1 flex justify-between text-[12.5px]"><span className="text-muted">Progress</span><span className="font-semibold">{p.progress}%</span></div><Progress value={p.progress} tone={p.progress >= 100 ? 'ok' : 'brand'} /></div>
            <Kv label={<span className="inline-flex items-center gap-1"><CalendarDays className="h-3.5 w-3.5" />Start</span>}>{date(p.start_date)}</Kv>
            <Kv label="Expected completion">{date(p.expected_end_date)}</Kv>
            {p.completed_date && <Kv label="Completed">{date(p.completed_date)}</Kv>}
            <Kv label="Project manager">{p.manager_name ?? '—'}</Kv>
            {p.quotation_number && <Kv label="Quotation"><button type="button" className="text-brand hover:underline cursor-pointer" onClick={() => nav(`/doc/${p.quotation_id}`)}>{p.quotation_number}</button></Kv>}
            <Kv label="Created by">{p.created_by_name ?? '—'}</Kv>
            {p.warranty_info && <div className="mt-3 rounded-lg bg-surface-2 p-3 text-[12.5px]"><div className="mb-1 font-semibold">Warranty</div><div className="whitespace-pre-wrap text-muted">{p.warranty_info}</div></div>}
            {p.notes && <div className="mt-3 rounded-lg bg-surface-2 p-3 text-[12.5px]"><div className="mb-1 font-semibold">Notes</div><div className="whitespace-pre-wrap text-muted">{p.notes}</div></div>}
          </Card>
        </div>
      )}
      {tab === 'ledger' && <ProjectLedger key={tick} id={p.id} />}
      {tab === 'materials' && <MaterialUsage key={tick} id={p.id} />}
      {tab === 'documents' && <MaterialMoves key={tick} projectId={p.id} onChanged={refresh} />}
      {tab === 'files' && <Attachments project={p} onChanged={reload} />}

      <ProjectForm open={edit} project={p} onClose={() => setEdit(false)} onSaved={refresh} />
      <MaterialMoveForm open={!!move} direction={move ?? 'issue'} projectId={p.id} onClose={() => setMove(null)} onSaved={refresh} />
      <PaymentModal open={!!pay} onClose={() => setPay(null)} onSaved={refresh} preset={{ direction: pay ?? 'in', partyId: pay === 'in' ? p.customer_id : null, projectId: p.id }} />
      <ExpenseForm open={expense} preset={{ projectId: p.id }} onClose={() => setExpense(false)} onSaved={refresh} />
    </div>
  )
}

function ProjectLedger({ id }: { id: number }): JSX.Element {
  const nav = useNavigate()
  const { data, loading } = useLoad(() => api<any[]>('projects.ledger', { id }), [id])
  const rows = (data ?? []).filter((r) => r.status !== 'cancelled')
  const showCost = rows.some((r) => r.cost !== null)
  const t = rows.reduce((a, r) => ({ revenue: a.revenue + r.revenue, cost: a.cost + (r.cost ?? 0), cin: a.cin + r.cash_in, cout: a.cout + r.cash_out }), { revenue: 0, cost: 0, cin: 0, cout: 0 })
  const open = (r: any): void => {
    if (['sale_invoice', 'sale_return', 'purchase_invoice', 'purchase_return', 'quotation', 'sale_order', 'purchase_order', 'delivery_challan'].includes(r.kind)) nav(`/doc/${r.ref_id}`)
    else if (r.kind === 'receipt' || r.kind === 'payment') api('print.open', { kind: 'payment', id: r.ref_id })
    else if (r.kind.startsWith('material')) api('print.open', { kind: 'material', id: r.ref_id })
  }
  return (
    <DataTable
      rows={data ?? []}
      loading={loading}
      exportName="Project ledger"
      onRowClick={open}
      rowClassName={(r: any) => (r.status === 'cancelled' ? 'opacity-45 line-through' : undefined)}
      columns={[
        { key: 'date', header: 'Date', render: (r: any) => date(r.date) },
        { key: 'kind', header: 'Type', render: (r: any) => <Badge tone={r.revenue ? 'info' : r.cost ? 'warn' : r.cash_in ? 'ok' : 'muted'}>{label(r.kind)}</Badge> },
        { key: 'number', header: 'Number', render: (r: any) => <span className="font-medium">{r.number}</span> },
        { key: 'party', header: 'Party / location' },
        { key: 'description', header: 'Description', render: (r: any) => <span className="text-muted">{r.description}</span> },
        { key: 'revenue', header: 'Revenue', align: 'right', render: (r: any) => (r.revenue ? money(r.revenue) : '') },
        { key: 'cost', header: 'Cost', align: 'right', hidden: !showCost, render: (r: any) => (r.cost ? money(r.cost) : '') },
        { key: 'cash_in', header: 'Cash in', align: 'right', render: (r: any) => (r.cash_in ? <span className="text-ok">{money(r.cash_in)}</span> : '') },
        { key: 'cash_out', header: 'Cash out', align: 'right', render: (r: any) => (r.cash_out ? <span className="text-bad">{money(r.cash_out)}</span> : '') }
      ]}
      footer={
        <tr>
          <td colSpan={5} className="px-3 py-2">Totals (excluding cancelled)</td>
          <td className="num px-3 py-2 text-right">{money(t.revenue)}</td>
          {showCost && <td className="num px-3 py-2 text-right">{money(t.cost)}</td>}
          <td className="num px-3 py-2 text-right">{money(t.cin)}</td>
          <td className="num px-3 py-2 text-right">{money(t.cout)}</td>
        </tr>
      }
    />
  )
}

function MaterialUsage({ id }: { id: number }): JSX.Element {
  const { data, loading } = useLoad(() => api<any[]>('projects.materials', { id }), [id])
  const rows = data ?? []
  const showCost = rows.some((r) => r.cost !== null)
  return (
    <DataTable
      rows={rows}
      loading={loading}
      exportName="Material usage"
      columns={[
        { key: 'product_name', header: 'Material' },
        { key: 'issued', header: 'Issued from stock', align: 'right', render: (r: any) => (r.issued ? `${qty(r.issued)} ${r.unit}` : '—') },
        { key: 'returned', header: 'Returned to stock', align: 'right', render: (r: any) => (r.returned ? `${qty(r.returned)} ${r.unit}` : '—') },
        { key: 'invoiced', header: 'On invoices (stock)', align: 'right', render: (r: any) => (r.invoiced ? `${qty(r.invoiced)} ${r.unit}` : '—') },
        { key: 'direct', header: 'Bought for site', align: 'right', render: (r: any) => (r.direct ? `${qty(r.direct)} ${r.unit}` : '—') },
        { key: 'net_used', header: 'Net used', align: 'right', render: (r: any) => <b>{qty(r.net_used)} {r.unit}</b> },
        { key: 'cost', header: 'Cost', align: 'right', hidden: !showCost, render: (r: any) => money(r.cost) }
      ]}
      empty={<Empty icon={<PackageMinus />} title="No materials yet">Issue materials from stock, invoice stock items or purchase directly for this site.</Empty>}
    />
  )
}

function MaterialMoves({ projectId, onChanged }: { projectId: number; onChanged: () => void }): JSX.Element {
  const can = useCan()
  const { data, loading, reload } = useLoad(() => api<any[]>('materials.list', { projectId }), [projectId])
  return (
    <DataTable
      rows={data ?? []}
      loading={loading}
      rowClassName={(r: any) => (r.status === 'cancelled' ? 'opacity-45' : undefined)}
      onRowClick={(r: any) => api('print.open', { kind: 'material', id: r.id })}
      columns={[
        { key: 'number', header: 'Number', render: (r: any) => <span className="font-semibold">{r.number}</span> },
        { key: 'date', header: 'Date', render: (r: any) => date(r.date) },
        { key: 'direction', header: 'Type', render: (r: any) => <Badge tone={r.direction === 'issue' ? 'warn' : 'ok'}>{r.direction === 'issue' ? 'Issued to site' : 'Returned to stock'}</Badge> },
        { key: 'warehouse_name', header: 'Warehouse' },
        { key: 'total_cost', header: 'Cost', align: 'right', render: (r: any) => (r.total_cost === null ? '—' : money(r.total_cost)) },
        { key: 'notes', header: 'Notes' },
        { key: 'status', header: 'Status', render: (r: any) => (r.status === 'cancelled' ? <Badge tone="bad">Cancelled</Badge> : <Badge tone="ok">Posted</Badge>) },
        {
          key: 'a', header: '', sortable: false,
          render: (r: any) => (
            <div className="flex justify-end">
              <IconButton title="Print" onClick={() => api('print.open', { kind: 'material', id: r.id })}><Printer className="h-4 w-4" /></IconButton>
              {can('projects.manage') && r.status !== 'cancelled' && (
                <IconButton title="Cancel" tone="bad" onClick={async () => {
                  if (!(await confirmDialog({ title: `Cancel ${r.number}?`, message: 'Stock and project cost will be reversed.', danger: true, confirmLabel: 'Cancel movement' }))) return
                  try { await api('materials.cancel', { id: r.id }); toast.ok('Cancelled.'); reload(); onChanged() } catch (e) { toast.error(e) }
                }}><Ban className="h-4 w-4" /></IconButton>
              )}
            </div>
          )
        }
      ]}
    />
  )
}

function MaterialMoveForm({ open, direction, projectId, onClose, onSaved }: { open: boolean; direction: 'issue' | 'return'; projectId: number; onClose: () => void; onSaved: () => void }): JSX.Element {
  const { products, options } = useProducts()
  const warehouses = useWarehouses()
  const [f, setF] = useState<any>({})
  const [lines, setLines] = useState<any[]>([])
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (open) {
      setF({ date: today(), warehouseId: (warehouses.find((w) => w.is_default) ?? warehouses[0])?.id, notes: '' })
      setLines([{ k: 1, productId: null, qty: 0, serials: '' }])
    }
  }, [open, warehouses])
  const goods = options.filter((o) => products.find((p) => p.id === o.value)?.type === 'goods')
  const save = async (): Promise<void> => {
    setBusy(true)
    try {
      await api('materials.create', { ...f, projectId, direction, lines: lines.filter((l) => l.productId && l.qty > 0) })
      toast.ok(direction === 'issue' ? 'Materials issued to project.' : 'Materials returned to stock.')
      onSaved()
      onClose()
    } catch (e) {
      toast.error(e)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Modal open={open} onClose={onClose} title={direction === 'issue' ? 'Issue materials to project' : 'Return materials from project'} subtitle={direction === 'issue' ? 'Stock leaves the warehouse and its average cost is charged to this project (once).' : 'Unused material comes back to stock and its cost is removed from the project.'} size="lg" footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} onClick={save}>{direction === 'issue' ? 'Issue materials' : 'Return materials'}</Button></>}>
      <div className="mb-3 grid grid-cols-3 gap-3">
        <Field label="Date"><Input type="date" value={f.date ?? ''} onChange={(e) => setF({ ...f, date: e.target.value })} /></Field>
        <Field label="Warehouse"><Select value={f.warehouseId ?? ''} onChange={(e) => setF({ ...f, warehouseId: Number(e.target.value) })}>{warehouses.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}</Select></Field>
        <Field label="Notes"><Input value={f.notes ?? ''} onChange={(e) => setF({ ...f, notes: e.target.value })} placeholder="Vehicle, receiver…" /></Field>
      </div>
      <table className="tbl">
        <thead><tr><th>Material</th><th style={{ width: 120 }}>Quantity</th><th style={{ width: 40 }} /></tr></thead>
        <tbody>
          {lines.map((l, i) => {
            const p = products.find((x) => x.id === l.productId)
            return (
              <tr key={l.k}>
                <td>
                  <Combobox sm options={goods} value={l.productId} onChange={(v) => setLines(lines.map((x, j) => (j === i ? { ...x, productId: v } : x)))} />
                  {p && <div className={cx('mt-1 text-[11.5px]', direction === 'issue' && l.qty > p.stock ? 'font-semibold text-bad' : 'text-muted')}>In stock: {qty(p.stock)} {p.unit}{p.avg_cost !== null && ` · avg cost ${money(p.avg_cost)}`}</div>}
                  {p?.track_serial ? <Input sm className="mt-1" placeholder="Serial numbers (comma separated)" value={l.serials} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, serials: e.target.value } : x)))} /> : null}
                </td>
                <td><NumberInput sm value={l.qty} onChange={(v) => setLines(lines.map((x, j) => (j === i ? { ...x, qty: v } : x)))} /></td>
                <td><IconButton title="Remove" tone="bad" onClick={() => setLines(lines.filter((_, j) => j !== i))}><Trash2 className="h-4 w-4" /></IconButton></td>
              </tr>
            )
          })}
        </tbody>
      </table>
      <Button size="sm" variant="soft" className="mt-2" icon={<Plus className="h-4 w-4" />} onClick={() => setLines([...lines, { k: Date.now(), productId: null, qty: 0, serials: '' }])}>Add material</Button>
    </Modal>
  )
}

function Attachments({ project, onChanged }: { project: any; onChanged: () => void }): JSX.Element {
  const can = useCan()
  return (
    <Card title="Documents & files" actions={can('projects.manage') && <Button size="sm" variant="primary" icon={<Paperclip className="h-4 w-4" />} onClick={async () => { try { const r = await api<number[]>('attachments.add', { projectId: project.id }); if (r.length) { toast.ok(`${r.length} file(s) attached.`); onChanged() } } catch (e) { toast.error(e) } }}>Attach files</Button>} pad={false}>
      {project.attachments.length === 0 ? (
        <Empty icon={<Paperclip />} title="No files attached">Attach site photos, contracts, net-metering papers, drawings or warranty cards. Files are stored locally with your data.</Empty>
      ) : (
        <table className="tbl">
          <tbody>
            {project.attachments.map((a: any) => (
              <tr key={a.id}>
                <td className="font-medium">{a.file_name}</td>
                <td className="text-muted">{(a.size / 1024).toFixed(0)} KB</td>
                <td className="text-muted">{date(a.created_at)}</td>
                <td className="text-right">
                  <IconButton title="Open" onClick={() => api('attachments.open', { id: a.id }).catch(toast.error)}><ExternalLink className="h-4 w-4" /></IconButton>
                  {can('projects.manage') && <IconButton title="Remove" tone="bad" onClick={async () => { if (await confirmDialog({ title: 'Remove attachment?', danger: true, confirmLabel: 'Remove' })) { await api('attachments.delete', { id: a.id }).catch(toast.error); onChanged() } }}><Trash2 className="h-4 w-4" /></IconButton>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  )
}

