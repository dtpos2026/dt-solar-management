/** Cheque register: cheques received (often post-dated) and issued. Clearing a cheque books the payment; a bounced one does not. */
import { useState } from 'react'
import { FileCheck2, Plus } from 'lucide-react'
import { api } from '../../api'
import { useCan } from '../../store'
import { Badge, Button, Card, Empty, Field, Input, Loading, Modal, NumberInput, PageHeader, Select, StatCard, Tabs, Textarea, confirmDialog, promptDialog, toast } from '../../components/ui'
import { Combobox } from '../../components/Combobox'
import { DateInput } from '../../components/DateInput'
import { useAccounts, useLoad, useParties } from '../../lib/hooks'
import { date, money, today } from '../../lib/format'

/* eslint-disable @typescript-eslint/no-explicit-any */
const STATUS_TONE: Record<string, string> = { pending: 'warn', deposited: 'info', cleared: 'ok', bounced: 'bad', cancelled: 'muted' }
type Tab = 'all' | 'received' | 'issued'

export function ChequesPage(): JSX.Element {
  const can = useCan()
  const manage = can('cheques.manage')
  const [tab, setTab] = useState<Tab>('all')
  const [status, setStatus] = useState('')
  const [q, setQ] = useState('')
  const [tick, setTick] = useState(0)
  const [form, setForm] = useState<{ open: boolean; cheque?: any }>({ open: false })
  const [clearing, setClearing] = useState<any | null>(null)
  const sum = useLoad(() => api<any>('cheques.summary'), [tick])
  const list = useLoad(() => api<any[]>('cheques.list', { direction: tab === 'all' ? undefined : tab, status: status || undefined, q: q || undefined }), [tab, status, q, tick])
  const refresh = (): void => setTick((t) => t + 1)

  const act = async (fn: () => Promise<unknown>, ok: string): Promise<void> => {
    try {
      await fn()
      toast.ok(ok)
      refresh()
    } catch (e) {
      toast.error(e)
    }
  }
  const s = sum.data

  return (
    <div className="space-y-4">
      <PageHeader
        title="Cheques"
        subtitle="Cheques received and issued. Nothing is booked until a cheque clears."
        icon={<FileCheck2 className="h-5 w-5" />}
        actions={manage && <Button variant="primary" icon={<Plus className="h-4 w-4" />} onClick={() => setForm({ open: true })}>New cheque</Button>}
      />
      {s && (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
          <StatCard label="Received, waiting" value={money(s.receivedOpen.total)} sub={`${s.receivedOpen.n} cheque(s)`} icon={<FileCheck2 className="h-5 w-5" />} tone="ok" />
          <StatCard label="Issued, waiting" value={money(s.issuedOpen.total)} sub={`${s.issuedOpen.n} cheque(s)`} icon={<FileCheck2 className="h-5 w-5" />} tone="warn" />
          <StatCard label="Due in 7 days" value={money(s.dueThisWeek.total)} sub={`${s.dueThisWeek.n} cheque(s)`} icon={<FileCheck2 className="h-5 w-5" />} tone="info" />
          <StatCard label="Overdue" value={money(s.overdue.total)} sub={`${s.overdue.n} cheque(s)`} icon={<FileCheck2 className="h-5 w-5" />} tone={s.overdue.n ? 'bad' : 'ok'} />
          <StatCard label="Bounced" value={money(s.bounced.total)} sub={`${s.bounced.n} cheque(s)`} icon={<FileCheck2 className="h-5 w-5" />} tone={s.bounced.n ? 'bad' : 'ok'} />
        </div>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <Tabs value={tab} onChange={setTab} tabs={[{ key: 'all', label: 'All' }, { key: 'received', label: 'Received' }, { key: 'issued', label: 'Issued' }]} className="mb-0" />
        <Select sm className="w-40" value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status filter">
          <option value="">Any status</option>
          {['pending', 'deposited', 'cleared', 'bounced', 'cancelled'].map((x) => <option key={x} value={x}>{x[0].toUpperCase() + x.slice(1)}</option>)}
        </Select>
        <Input sm className="w-56" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search number, bank, party" aria-label="Search cheques" />
      </div>
      <Card pad={false}>
        {!list.data ? (
          <Loading />
        ) : list.data.length === 0 ? (
          <Empty icon={<FileCheck2 />} title="No cheques here">Record a cheque when a customer gives you one, or when you write one to a supplier.</Empty>
        ) : (
          <table className="tbl">
            <thead><tr><th>Cheque date</th><th>Cheque no.</th><th>Bank</th><th>Party</th><th>Type</th><th className="text-right">Amount</th><th>Status</th><th /></tr></thead>
            <tbody>
              {list.data.map((c) => (
                <tr key={c.id}>
                  <td className={c.overdue ? 'font-semibold text-bad' : ''}>{date(c.cheque_date)}{c.overdue && <div className="text-[12px]">Overdue</div>}</td>
                  <td className="font-medium">{c.cheque_no}{c.document_number && <div className="text-[12px] font-normal text-muted">for {c.document_number}</div>}</td>
                  <td>{c.bank ?? '-'}</td>
                  <td>{c.party_name ?? '-'}</td>
                  <td><Badge tone={c.direction === 'received' ? 'ok' : 'warn'}>{c.direction === 'received' ? 'Received' : 'Issued'}</Badge></td>
                  <td className="num text-right font-semibold">{money(c.amount)}</td>
                  <td><Badge tone={STATUS_TONE[c.status]}>{c.status}</Badge>{c.bounce_reason && <div className="text-[12px] text-bad">{c.bounce_reason}</div>}</td>
                  <td className="whitespace-nowrap text-right">
                    {manage && c.status === 'pending' && c.direction === 'received' && <Button size="sm" variant="ghost" onClick={() => act(() => api('cheques.status', { id: c.id, status: 'deposited' }), 'Marked deposited.')}>Deposited</Button>}
                    {manage && (c.status === 'pending' || c.status === 'deposited') && <Button size="sm" variant="soft" onClick={() => setClearing(c)}>Cleared</Button>}
                    {manage && (c.status === 'pending' || c.status === 'deposited' || c.status === 'cleared') && (
                      <Button size="sm" variant="ghost" className="text-bad" onClick={async () => { const r = await promptDialog({ title: `Cheque ${c.cheque_no} bounced`, message: 'Why was it returned?', input: { label: 'Reason', placeholder: 'Insufficient funds' }, confirmLabel: 'Mark bounced' }); if (r !== null) act(() => api('cheques.status', { id: c.id, status: 'bounced', reason: r }), 'Marked bounced.') }}>Bounced</Button>
                    )}
                    {manage && c.status === 'pending' && <Button size="sm" variant="ghost" onClick={() => setForm({ open: true, cheque: c })}>Edit</Button>}
                    {manage && c.status === 'pending' && <Button size="sm" variant="ghost" onClick={async () => { if (await confirmDialog({ title: 'Cancel this cheque?', message: `Cheque ${c.cheque_no} stays in the list as cancelled.`, confirmLabel: 'Cancel cheque' })) act(() => api('cheques.status', { id: c.id, status: 'cancelled' }), 'Cancelled.') }}>Cancel</Button>}
                    {manage && (c.status === 'pending' || c.status === 'cancelled' || c.status === 'bounced') && <Button size="sm" variant="ghost" className="text-bad" onClick={async () => { if (await confirmDialog({ title: 'Delete this cheque?', message: 'It is removed from the register.', danger: true, confirmLabel: 'Delete' })) act(() => api('cheques.delete', { id: c.id }), 'Deleted.') }}>Delete</Button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
      {form.open && <ChequeForm cheque={form.cheque} onClose={() => setForm({ open: false })} onSaved={refresh} />}
      {clearing && <ClearForm cheque={clearing} onClose={() => setClearing(null)} onDone={refresh} />}
    </div>
  )
}

function ChequeForm({ cheque, onClose, onSaved }: { cheque?: any; onClose: () => void; onSaved: () => void }): JSX.Element {
  const [f, setF] = useState<any>(
    cheque
      ? { id: cheque.id, direction: cheque.direction, chequeNo: cheque.cheque_no, bank: cheque.bank ?? '', partyId: cheque.party_id, amount: cheque.amount, chequeDate: cheque.cheque_date, receivedDate: cheque.received_date ?? '', documentId: cheque.document_id, accountId: cheque.account_id, notes: cheque.notes ?? '' }
      : { direction: 'received', chequeNo: '', bank: '', partyId: null, amount: 0, chequeDate: today(), receivedDate: today(), documentId: null, accountId: null, notes: '' }
  )
  const [busy, setBusy] = useState(false)
  const { options: customers } = useParties('customer')
  const { options: suppliers } = useParties('supplier')
  const accounts = useAccounts()
  const docs = useLoad(() => (f.partyId ? api<any[]>('docs.list', { docType: f.direction === 'received' ? 'sale_invoice' : 'purchase_invoice', partyId: f.partyId }) : Promise.resolve([])), [f.partyId, f.direction])
  const set = (k: string, v: unknown): void => setF((x: any) => ({ ...x, [k]: v }))
  const open = (docs.data ?? []).filter((d) => d.status !== 'cancelled' && d.due > 0.005)
  return (
    <Modal open onClose={onClose} title={cheque ? 'Edit cheque' : 'New cheque'} size="md" footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} onClick={async () => { setBusy(true); try { await api('cheques.save', { ...f, receivedDate: f.receivedDate || null }); toast.ok('Cheque saved.'); onSaved(); onClose() } catch (e) { toast.error(e); setBusy(false) } }}>Save</Button></>}>
      <div className="grid grid-cols-2 gap-3">
        <Field label="This cheque is"><Select value={f.direction} onChange={(e) => setF({ ...f, direction: e.target.value, partyId: null, documentId: null })}><option value="received">Received from a customer</option><option value="issued">Issued to a supplier</option></Select></Field>
        <Field label="Cheque number" required><Input autoFocus value={f.chequeNo} onChange={(e) => set('chequeNo', e.target.value)} /></Field>
        <Field label={f.direction === 'received' ? 'Customer' : 'Supplier'} className="col-span-2">
          <Combobox options={f.direction === 'received' ? customers : suppliers} value={f.partyId} onChange={(v) => setF({ ...f, partyId: v, documentId: null })} placeholder="Select" allowClear />
        </Field>
        <Field label="Bank"><Input value={f.bank} onChange={(e) => set('bank', e.target.value)} placeholder="HBL, Meezan..." /></Field>
        <Field label="Amount" required><NumberInput value={f.amount} onChange={(v) => set('amount', v)} /></Field>
        <Field label="Cheque date" hint="The date written on the cheque."><DateInput value={f.chequeDate} onChange={(e) => set('chequeDate', e.target.value)} /></Field>
        <Field label={f.direction === 'received' ? 'Received on' : 'Given on'}><DateInput clearable value={f.receivedDate} onChange={(e) => set('receivedDate', e.target.value)} /></Field>
        <Field label={f.direction === 'received' ? 'Invoice it pays (optional)' : 'Bill it pays (optional)'} className="col-span-2">
          <Select value={f.documentId ?? ''} onChange={(e) => set('documentId', e.target.value ? Number(e.target.value) : null)} disabled={!f.partyId}>
            <option value="">{f.partyId ? 'Oldest open ones, when it clears' : 'Select the party first'}</option>
            {open.map((d) => <option key={d.id} value={d.id}>{d.number}, balance {money(d.due)}</option>)}
          </Select>
        </Field>
        <Field label={f.direction === 'received' ? 'Deposit in account' : 'Paid from account'} className="col-span-2">
          <Select value={f.accountId ?? ''} onChange={(e) => set('accountId', e.target.value ? Number(e.target.value) : null)}>
            <option value="">Choose when it clears</option>
            {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </Select>
        </Field>
        <Field label="Notes" className="col-span-2"><Textarea rows={2} value={f.notes} onChange={(e) => set('notes', e.target.value)} /></Field>
      </div>
    </Modal>
  )
}

function ClearForm({ cheque, onClose, onDone }: { cheque: any; onClose: () => void; onDone: () => void }): JSX.Element {
  const accounts = useAccounts()
  const [accountId, setAccountId] = useState<number | null>(cheque.account_id)
  const [when, setWhen] = useState(today())
  const [busy, setBusy] = useState(false)
  const received = cheque.direction === 'received'
  return (
    <Modal open onClose={onClose} title={`Cheque ${cheque.cheque_no} cleared`} size="sm" footer={<><Button onClick={onClose}>Back</Button><Button variant="primary" loading={busy} disabled={!accountId} onClick={async () => { setBusy(true); try { await api('cheques.status', { id: cheque.id, status: 'cleared', accountId, date: when }); toast.ok(received ? 'Payment received and booked.' : 'Payment made and booked.'); onDone(); onClose() } catch (e) { toast.error(e); setBusy(false) } }}>Book the payment</Button></>}>
      <div className="space-y-3">
        <div className="rounded-xl bg-surface-2 p-3 text-center"><div className="text-[12.5px] text-muted">{received ? 'Money received' : 'Money paid'}</div><div className="num text-[24px] font-extrabold">{money(cheque.amount)}</div></div>
        <Field label={received ? 'Money came into account' : 'Money went out of account'} required>
          <Select value={accountId ?? ''} onChange={(e) => setAccountId(e.target.value ? Number(e.target.value) : null)}>
            <option value="">Choose the account</option>
            {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </Select>
        </Field>
        <Field label="Cleared on"><DateInput value={when} onChange={(e) => setWhen(e.target.value)} /></Field>
        <div className="text-[12.5px] text-muted">{cheque.document_number ? `It settles ${cheque.document_number}.` : 'It settles the oldest open invoices of this party.'}</div>
      </div>
    </Modal>
  )
}
