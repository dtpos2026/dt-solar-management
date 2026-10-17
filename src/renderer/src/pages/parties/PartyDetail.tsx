import { useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { ArrowLeft, HandCoins, Pencil, Phone, Plus, Printer, MapPin, Mail, Scale, Trash2 } from 'lucide-react'
import { api } from '../../api'
import { WhatsAppButton } from '../../components/WhatsAppButton'
import { useCan } from '../../store'
import { Badge, Button, Card, Field, IconButton, Input, Kv, Loading, Modal, NumberInput, PeriodPicker, Select, StatCard, Tabs, confirmDialog, toast } from '../../components/ui'
import { DataTable } from '../../components/DataTable'
import { PartyForm } from '../../components/PartyForm'
import { PaymentModal } from '../../components/PaymentModal'
import { useLoad } from '../../lib/hooks'
import { date, label, money, today, statusTone, PERIODS } from '../../lib/format'
import { DateInput } from '../../components/DateInput'

/* eslint-disable @typescript-eslint/no-explicit-any */
export function PartyDetail(): JSX.Element {
  const { id } = useParams()
  const nav = useNavigate()
  const can = useCan()
  const [tab, setTab] = useState<'ledger' | 'docs' | 'payments'>('ledger')
  const [range, setRange] = useState<[string, string]>(PERIODS.find((p) => p.key === 'year')!.range())
  const [edit, setEdit] = useState(false)
  const [pay, setPay] = useState<'in' | 'out' | null>(null)
  const [adj, setAdj] = useState(false)
  const party = useLoad(() => api<any>('parties.get', { id: Number(id) }), [id])
  const ledger = useLoad(() => api<any>('parties.ledger', { id: Number(id), from: range[0], to: range[1] }), [id, range[0], range[1]])
  const p = party.data
  if (!p) return <Loading />
  const isCust = p.type !== 'supplier'
  const docTypes = p.type === 'supplier' ? ['purchase_invoice', 'purchase_return', 'purchase_order'] : p.type === 'customer' ? ['sale_invoice', 'sale_return', 'quotation', 'sale_order'] : ['sale_invoice', 'sale_return', 'purchase_invoice', 'purchase_return']
  const reloadAll = (): void => {
    party.reload()
    ledger.reload()
  }
  const L = ledger.data
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <IconButton title="Back" onClick={() => nav(-1)}><ArrowLeft className="h-5 w-5" /></IconButton>
        <div className="mr-auto">
          <div className="flex items-center gap-2"><h1 className="text-[20px] font-bold">{p.name}</h1><Badge tone="brand">{p.type === 'both' ? 'Customer & supplier' : label(p.type)}</Badge>{!p.is_active && <Badge tone="bad">Inactive</Badge>}</div>
          <div className="flex flex-wrap gap-4 text-[12.5px] text-muted">
            {p.phone && <span className="inline-flex items-center gap-1"><Phone className="h-3.5 w-3.5" />{p.phone}</span>}
            {p.email && <span className="inline-flex items-center gap-1"><Mail className="h-3.5 w-3.5" />{p.email}</span>}
            {(p.address || p.city) && <span className="inline-flex items-center gap-1"><MapPin className="h-3.5 w-3.5" />{[p.address, p.city].filter(Boolean).join(', ')}</span>}
          </div>
        </div>
        <Button icon={<Printer className="h-4 w-4" />} onClick={() => api('print.open', { kind: 'statement', id: p.id, params: { from: range[0], to: range[1] } })}>Print statement</Button>
        <WhatsAppButton entity="statement" id={p.id} partyId={p.id} phone={p.phone} params={{ from: range[0], to: range[1] }} />
        {can('accounts.manage') && <Button icon={<Scale className="h-4 w-4" />} onClick={() => setAdj(true)}>Adjustment</Button>}
        {can('accounts.manage') && (
          <Button variant="success" icon={<HandCoins className="h-4 w-4" />} onClick={() => setPay(isCust ? 'in' : 'out')}>
            {isCust ? 'Receive payment' : 'Pay supplier'}
          </Button>
        )}
        {can(isCust ? 'customers.manage' : 'suppliers.manage') && <Button icon={<Pencil className="h-4 w-4" />} onClick={() => setEdit(true)}>Edit</Button>}
      </div>

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard label={p.balance >= 0 ? 'Balance — they owe us' : 'Balance — we owe them'} value={<span className={p.balance > 0.5 ? 'text-bad' : p.balance < -0.5 ? 'text-ok' : ''}>{money(Math.abs(p.balance))}</span>} tone={p.balance > 0 ? 'bad' : 'ok'} icon={<Scale className="h-5 w-5" />} />
        {p.type !== 'supplier' && <StatCard label="Total sales (net of returns)" value={money(p.stats.total_sales - p.stats.total_sale_returns)} icon={<Plus className="h-5 w-5" />} />}
        {p.type !== 'customer' && <StatCard label="Total purchases (net of returns)" value={money(p.stats.total_purchases - p.stats.total_purchase_returns)} icon={<Plus className="h-5 w-5" />} tone="warn" />}
        <StatCard label="Invoices / bills" value={p.stats.invoice_count} tone="info" icon={<Plus className="h-5 w-5" />} />
        {p.credit_limit > 0 && <StatCard label="Credit limit" value={money(p.credit_limit)} tone={p.balance > p.credit_limit ? 'bad' : 'ok'} sub={p.balance > p.credit_limit ? 'Exceeded' : 'Within limit'} />}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <Tabs className="mb-0" value={tab} onChange={setTab} tabs={[{ key: 'ledger', label: 'Ledger / statement' }, { key: 'docs', label: 'Documents' }, { key: 'payments', label: 'Payments' }]} />
        <PeriodPicker from={range[0]} to={range[1]} onChange={(a, b) => setRange([a, b])} />
      </div>

      {tab === 'ledger' && (
        <Card pad={false}>
          {!L ? (
            <Loading />
          ) : (
            <table className="tbl">
              <thead><tr><th>Date</th><th>Type</th><th>Number</th><th>Description</th><th className="text-right">Debit</th><th className="text-right">Credit</th><th className="text-right">Balance</th></tr></thead>
              <tbody>
                <tr className="bg-surface-2 font-medium"><td colSpan={6}>Opening balance</td><td className="num text-right">{money(L.opening)}</td></tr>
                {L.rows.map((r: any, i: number) => (
                  <tr key={i} className={r.ref_id && ['sale_invoice', 'sale_return', 'purchase_invoice', 'purchase_return'].includes(r.kind) ? 'clickable' : ''} onClick={() => r.ref_id && ['sale_invoice', 'sale_return', 'purchase_invoice', 'purchase_return'].includes(r.kind) && nav(`/doc/${r.ref_id}`)}>
                    <td>{date(r.date)}</td>
                    <td><Badge tone={r.debit > 0 ? 'warn' : 'ok'}>{label(r.kind)}</Badge></td>
                    <td className="font-medium">{r.number}</td>
                    <td className="max-w-[320px] truncate text-muted">{r.description}</td>
                    <td className="num text-right">{r.debit ? money(r.debit) : ''}</td>
                    <td className="num text-right">{r.credit ? money(r.credit) : ''}</td>
                    <td className="num text-right font-semibold">{money(r.balance)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="bg-surface-2 font-semibold"><td colSpan={4}>Closing balance {L.closing > 0 ? '(receivable)' : L.closing < 0 ? '(payable)' : ''}</td><td className="num text-right">{money(L.totalDebit)}</td><td className="num text-right">{money(L.totalCredit)}</td><td className="num text-right">{money(L.closing)}</td></tr>
              </tfoot>
            </table>
          )}
        </Card>
      )}
      {tab === 'docs' && <PartyDocs partyId={p.id} types={docTypes} range={range} />}
      {tab === 'payments' && <PartyPayments partyId={p.id} range={range} onChanged={reloadAll} />}

      <PartyForm open={edit} party={p} type={isCust ? 'customer' : 'supplier'} onClose={() => setEdit(false)} onSaved={reloadAll} />
      <PaymentModal open={!!pay} onClose={() => setPay(null)} onSaved={reloadAll} preset={{ direction: pay ?? 'in', partyId: p.id }} />
      <AdjustmentModal open={adj} partyId={p.id} onClose={() => setAdj(false)} onSaved={reloadAll} />
    </div>
  )
}

function PartyDocs({ partyId, types, range }: { partyId: number; types: string[]; range: [string, string] }): JSX.Element {
  const nav = useNavigate()
  const can = useCan()
  const allowed = types.filter((t) => can(t === 'quotation' ? 'quotations.view' : t.startsWith('purchase') ? 'purchases.view' : 'sales.view'))
  const { data, loading } = useLoad(() => (allowed.length ? api<any[]>('docs.list', { docType: allowed, partyId, from: range[0], to: range[1] }) : Promise.resolve([])), [partyId, range[0], range[1]])
  return (
    <DataTable
      rows={data ?? []}
      loading={loading}
      onRowClick={(r: any) => nav(`/doc/${r.id}`)}
      exportName="Party documents"
      columns={[
        { key: 'doc_type', header: 'Type', render: (r: any) => label(r.doc_type) },
        { key: 'number', header: 'Number', render: (r: any) => <span className="font-semibold">{r.number}</span> },
        { key: 'date', header: 'Date', render: (r: any) => date(r.date) },
        { key: 'project_name', header: 'Project' },
        { key: 'grand_total', header: 'Total', align: 'right', render: (r: any) => money(r.grand_total) },
        { key: 'due', header: 'Balance', align: 'right', render: (r: any) => (r.due !== undefined ? money(r.due) : '') },
        { key: 'status', header: 'Status', render: (r: any) => <Badge tone={statusTone(r.status === 'cancelled' ? 'cancelled' : r.pay_status ?? r.status)}>{label(r.status === 'cancelled' ? 'cancelled' : r.pay_status ?? r.status)}</Badge> }
      ]}
    />
  )
}

function PartyPayments({ partyId, range, onChanged }: { partyId: number; range: [string, string]; onChanged: () => void }): JSX.Element {
  const can = useCan()
  const { data, loading, reload } = useLoad(() => (can('accounts.view') ? api<any[]>('payments.list', { partyId, from: range[0], to: range[1], includeCancelled: true }) : Promise.resolve([])), [partyId, range[0], range[1]])
  return (
    <DataTable
      rows={data ?? []}
      loading={loading}
      exportName="Party payments"
      rowClassName={(r: any) => (r.status === 'cancelled' ? 'opacity-50' : undefined)}
      columns={[
        { key: 'number', header: 'Voucher', render: (r: any) => <span className="font-semibold">{r.number}</span> },
        { key: 'date', header: 'Date', render: (r: any) => date(r.date) },
        { key: 'direction', header: 'Type', render: (r: any) => <Badge tone={r.direction === 'in' ? 'ok' : 'warn'}>{r.direction === 'in' ? 'Received' : 'Paid'}</Badge> },
        { key: 'account_name', header: 'Account' },
        { key: 'method', header: 'Method', render: (r: any) => label(r.method) },
        { key: 'reference', header: 'Reference' },
        { key: 'amount', header: 'Amount', align: 'right', render: (r: any) => money(r.amount) },
        { key: 'unallocated', header: 'Unallocated', align: 'right', render: (r: any) => (r.unallocated > 0.5 ? <span className="text-info">{money(r.unallocated)}</span> : '—') },
        {
          key: 'a', header: '', sortable: false, csv: false,
          render: (r: any) => (
            <div className="flex justify-end">
              <IconButton title="Print receipt" onClick={() => api('print.open', { kind: 'payment', id: r.id })}><Printer className="h-4 w-4" /></IconButton>
              {can('accounts.manage') && r.status !== 'cancelled' && (
                <IconButton title="Cancel payment" tone="bad" onClick={async () => {
                  if (!(await confirmDialog({ title: `Cancel ${r.number}?`, message: 'The payment and its allocations will be reversed. This is recorded in the audit log.', danger: true, confirmLabel: 'Cancel payment' }))) return
                  try { await api('payments.cancel', { id: r.id }); toast.ok('Payment cancelled.'); reload(); onChanged() } catch (e) { toast.error(e) }
                }}><Trash2 className="h-4 w-4" /></IconButton>
              )}
            </div>
          )
        }
      ]}
    />
  )
}

function AdjustmentModal({ open, partyId, onClose, onSaved }: { open: boolean; partyId: number; onClose: () => void; onSaved: () => void }): JSX.Element {
  const [f, setF] = useState<any>({ date: today(), direction: 'credit', amount: 0, reason: '' })
  const [busy, setBusy] = useState(false)
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Balance adjustment (journal)"
      subtitle="Use for discounts allowed after invoicing, write-offs or corrections. Recorded in the ledger and audit log."
      size="sm"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={busy} onClick={async () => {
            setBusy(true)
            try { await api('partyAdjustments.create', { ...f, partyId }); toast.ok('Adjustment saved.'); onSaved(); onClose() } catch (e) { toast.error(e) } finally { setBusy(false) }
          }}>Save</Button>
        </>
      }
    >
      <div className="space-y-3">
        <Field label="Date"><DateInput value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} /></Field>
        <Field label="Type">
          <Select value={f.direction} onChange={(e) => setF({ ...f, direction: e.target.value })}>
            <option value="credit">Credit — reduce what they owe us / increase what we owe</option>
            <option value="debit">Debit — increase what they owe us / reduce what we owe</option>
          </Select>
        </Field>
        <Field label="Amount"><NumberInput value={f.amount} onChange={(v) => setF({ ...f, amount: v })} /></Field>
        <Field label="Reason"><Input value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} placeholder="e.g. Discount allowed on settlement" /></Field>
        <Kv label="Effect">{f.direction === 'credit' ? 'Balance decreases' : 'Balance increases'}</Kv>
      </div>
    </Modal>
  )
}
