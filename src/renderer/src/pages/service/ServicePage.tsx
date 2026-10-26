/** Service and warranty tickets: open a ticket for a faulty item, follow it with calls and visits, close it with what was done. */
import { useState } from 'react'
import { Plus, ShieldCheck, Wrench } from 'lucide-react'
import { api } from '../../api'
import { useCan } from '../../store'
import { Badge, Button, Card, Empty, Field, Input, Loading, Modal, NumberInput, PageHeader, Select, StatCard, Tabs, Textarea, confirmDialog, toast } from '../../components/ui'
import { Combobox } from '../../components/Combobox'
import { DateInput } from '../../components/DateInput'
import { useLoad, useParties } from '../../lib/hooks'
import { date, dateTime, money, today } from '../../lib/format'

/* eslint-disable @typescript-eslint/no-explicit-any */
const STATUS_LABEL: Record<string, string> = { new: 'New', in_progress: 'In progress', waiting_parts: 'Waiting for parts', resolved: 'Resolved', closed: 'Closed' }
const STATUS_TONE: Record<string, string> = { new: 'info', in_progress: 'warn', waiting_parts: 'warn', resolved: 'ok', closed: 'muted' }
const PRIORITY_TONE: Record<string, string> = { low: 'muted', normal: 'info', high: 'warn', urgent: 'bad' }
const KIND_LABEL: Record<string, string> = { call: 'Call', visit: 'Visit', whatsapp: 'WhatsApp', parts: 'Parts', note: 'Note' }
type Tab = 'open' | 'all' | 'closed'

export function ServicePage(): JSX.Element {
  const can = useCan()
  const manage = can('service.manage')
  const [tab, setTab] = useState<Tab>('open')
  const [q, setQ] = useState('')
  const [tick, setTick] = useState(0)
  const [form, setForm] = useState<{ open: boolean; ticket?: any }>({ open: false })
  const [detail, setDetail] = useState<number | null>(null)
  const refresh = (): void => setTick((t) => t + 1)
  const sum = useLoad(() => api<any>('service.summary'), [tick])
  const list = useLoad(() => api<any[]>('service.list', { open: tab === 'open', q: q || undefined }), [tab, q, tick])
  const rows = (list.data ?? []).filter((r) => (tab === 'closed' ? r.status === 'resolved' || r.status === 'closed' : true))
  const s = sum.data

  return (
    <div className="space-y-4">
      <PageHeader
        title="Service and warranty"
        subtitle="Faulty items and complaints, from the first call to the fix."
        icon={<Wrench className="h-5 w-5" />}
        actions={manage && <Button variant="primary" icon={<Plus className="h-4 w-4" />} onClick={() => setForm({ open: true })}>New ticket</Button>}
      />
      {s && (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatCard label="Open tickets" value={s.open} sub={`${s.new} new, ${s.inProgress} in progress`} icon={<Wrench className="h-5 w-5" />} tone="info" />
          <StatCard label="Waiting for parts" value={s.waitingParts} icon={<Wrench className="h-5 w-5" />} tone="warn" />
          <StatCard label="Overdue" value={s.overdue} sub="Past the promised date" icon={<Wrench className="h-5 w-5" />} tone={s.overdue ? 'bad' : 'ok'} />
          <StatCard label="Under warranty" value={s.underWarrantyOpen} sub="Open, no charge" icon={<ShieldCheck className="h-5 w-5" />} tone="ok" />
        </div>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <Tabs value={tab} onChange={setTab} tabs={[{ key: 'open', label: 'Open' }, { key: 'all', label: 'All' }, { key: 'closed', label: 'Resolved / closed' }]} className="mb-0" />
        <Input sm className="w-64" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search ticket, customer, serial" aria-label="Search tickets" />
      </div>
      <Card pad={false}>
        {!list.data ? (
          <Loading />
        ) : rows.length === 0 ? (
          <Empty icon={<Wrench />} title="No tickets here">When a customer reports a problem, open a ticket and follow it until it is fixed.</Empty>
        ) : (
          <table className="tbl">
            <thead><tr><th>Ticket</th><th>Received</th><th>Customer</th><th>Item</th><th>Problem</th><th>Priority</th><th>Status</th><th>Technician</th></tr></thead>
            <tbody>
              {rows.map((t) => (
                <tr key={t.id} className="cursor-pointer" onClick={() => setDetail(t.id)}>
                  <td className="font-medium">{t.number}{t.under_warranty ? <div className="text-[12px] font-normal text-ok">Under warranty</div> : null}</td>
                  <td className={t.overdue ? 'font-semibold text-bad' : ''}>{date(t.received_date)}{t.overdue && <div className="text-[12px]">Promised {date(t.promised_date)}</div>}</td>
                  <td>{t.customer ?? '-'}</td>
                  <td>{t.item ?? '-'}{t.serial && <div className="text-[12px] text-muted">{t.serial}</div>}</td>
                  <td className="max-w-[260px] truncate">{t.issue}</td>
                  <td><Badge tone={PRIORITY_TONE[t.priority]}>{t.priority}</Badge></td>
                  <td><Badge tone={STATUS_TONE[t.status]}>{STATUS_LABEL[t.status]}</Badge></td>
                  <td>{t.technician ?? '-'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
      {form.open && <TicketForm ticket={form.ticket} onClose={() => setForm({ open: false })} onSaved={(id) => { refresh(); if (!form.ticket) setDetail(id) }} />}
      {detail !== null && <TicketDetail id={detail} manage={manage} onClose={() => setDetail(null)} onChanged={refresh} onEdit={(t) => { setDetail(null); setForm({ open: true, ticket: t }) }} />}
    </div>
  )
}

function TicketForm({ ticket, onClose, onSaved }: { ticket?: any; onClose: () => void; onSaved: (id: number) => void }): JSX.Element {
  const [f, setF] = useState<any>(
    ticket
      ? { id: ticket.id, partyId: ticket.party_id, customerName: ticket.customer_name ?? '', phone: ticket.phone ?? '', itemName: ticket.item_name ?? '', serial: ticket.serial ?? '', issue: ticket.issue, priority: ticket.priority, assignedTo: ticket.assigned_to, receivedDate: ticket.received_date, promisedDate: ticket.promised_date ?? '', charges: ticket.charges }
      : { partyId: null, customerName: '', phone: '', itemName: '', serial: '', issue: '', priority: 'normal', assignedTo: null, receivedDate: today(), promisedDate: '', charges: 0 }
  )
  const [busy, setBusy] = useState(false)
  const [warranty, setWarranty] = useState<any | null>(null)
  const { options: customers } = useParties('customer')
  const users = useLoad(() => api<Array<{ id: number; full_name: string }>>('users.basic'), [])
  const set = (k: string, v: unknown): void => setF((x: any) => ({ ...x, [k]: v }))

  const check = async (): Promise<void> => {
    if (!f.serial.trim()) return
    try {
      const w = await api<any>('service.warranty', { serial: f.serial.trim() })
      setWarranty(w)
      if (w.found) setF((x: any) => ({ ...x, partyId: x.partyId ?? w.partyId, itemName: x.itemName || w.productName }))
    } catch (e) {
      toast.error(e)
    }
  }

  return (
    <Modal open onClose={onClose} title={ticket ? `Edit ${ticket.number}` : 'New service ticket'} size="md" footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} onClick={async () => { setBusy(true); try { const id = await api<number>('service.save', { ...f, promisedDate: f.promisedDate || null }); toast.ok('Ticket saved.'); onSaved(id); onClose() } catch (e) { toast.error(e); setBusy(false) } }}>Save ticket</Button></>}>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Serial number" hint="If we sold it, the customer, item and warranty are found from this." className="col-span-2">
          <div className="flex gap-2">
            <Input className="flex-1" value={f.serial} onChange={(e) => { set('serial', e.target.value); setWarranty(null) }} onBlur={check} placeholder="Scan or type the serial" />
            <Button onClick={check} disabled={!f.serial.trim()}>Check warranty</Button>
          </div>
          {warranty && (
            <div className={`mt-2 rounded-lg px-3 py-2 text-[13px] ${warranty.found ? (warranty.underWarranty ? 'bg-ok/10 text-ok' : 'bg-warn/10 text-warn') : 'bg-surface-2 text-muted'}`}>
              {!warranty.found
                ? 'This serial was not sold from here. You can still open the ticket as a paid repair.'
                : `${warranty.productName}, sold to ${warranty.partyName ?? 'a customer'} on ${date(warranty.soldDate)}${warranty.documentNumber ? ` (${warranty.documentNumber})` : ''}. ${warranty.warrantyMonths > 0 ? (warranty.underWarranty ? `Under warranty until ${date(warranty.expires)}.` : `Warranty ended on ${date(warranty.expires)}.`) : 'No warranty period set on this product.'}`}
            </div>
          )}
        </Field>
        <Field label="Customer" className="col-span-2"><Combobox options={customers} value={f.partyId} onChange={(v) => set('partyId', v)} placeholder="Select a customer" allowClear /></Field>
        {!f.partyId && <Field label="Or write the name" required><Input value={f.customerName} onChange={(e) => set('customerName', e.target.value)} /></Field>}
        <Field label="Phone" className={f.partyId ? 'col-span-2' : ''}><Input value={f.phone} onChange={(e) => set('phone', e.target.value)} /></Field>
        <Field label="Item"><Input value={f.itemName} onChange={(e) => set('itemName', e.target.value)} placeholder="Inverter, panel, UPS..." /></Field>
        <Field label="Priority">
          <Select value={f.priority} onChange={(e) => set('priority', e.target.value)}>
            {['low', 'normal', 'high', 'urgent'].map((p) => <option key={p} value={p}>{p[0].toUpperCase() + p.slice(1)}</option>)}
          </Select>
        </Field>
        <Field label="What is wrong" required className="col-span-2"><Textarea rows={2} value={f.issue} onChange={(e) => set('issue', e.target.value)} /></Field>
        <Field label="Received on"><DateInput value={f.receivedDate} onChange={(e) => set('receivedDate', e.target.value)} /></Field>
        <Field label="Promised by"><DateInput clearable value={f.promisedDate} onChange={(e) => set('promisedDate', e.target.value)} /></Field>
        <Field label="Technician">
          <Select value={f.assignedTo ?? ''} onChange={(e) => set('assignedTo', e.target.value ? Number(e.target.value) : null)}>
            <option value="">Not assigned</option>
            {(users.data ?? []).map((u) => <option key={u.id} value={u.id}>{u.full_name}</option>)}
          </Select>
        </Field>
        <Field label="Charge to customer" hint="Leave 0 under warranty."><NumberInput value={f.charges} onChange={(v) => set('charges', v)} /></Field>
      </div>
    </Modal>
  )
}

function TicketDetail({ id, manage, onClose, onChanged, onEdit }: { id: number; manage: boolean; onClose: () => void; onChanged: () => void; onEdit: (t: any) => void }): JSX.Element {
  const [tick, setTick] = useState(0)
  const d = useLoad(() => api<any>('service.get', { id }), [id, tick])
  const [kind, setKind] = useState('call')
  const [text, setText] = useState('')
  const [finish, setFinish] = useState<{ status: string } | null>(null)
  const reload = (): void => { setTick((t) => t + 1); onChanged() }
  const t = d.data?.ticket

  const run = async (fn: () => Promise<unknown>, ok?: string): Promise<void> => {
    try {
      await fn()
      if (ok) toast.ok(ok)
      reload()
    } catch (e) {
      toast.error(e)
    }
  }

  return (
    <Modal open onClose={onClose} title={t ? `${t.number}, ${t.customer ?? ''}` : 'Ticket'} subtitle={t ? `${t.item ?? 'Item not named'}${t.serial ? ` · ${t.serial}` : ''}` : undefined} size="lg">
      {!t ? (
        <Loading />
      ) : (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={STATUS_TONE[t.status]}>{STATUS_LABEL[t.status]}</Badge>
            <Badge tone={PRIORITY_TONE[t.priority]}>{t.priority}</Badge>
            {t.under_warranty ? <Badge tone="ok">Under warranty</Badge> : null}
            {t.document_number && <span className="text-[13px] text-muted">Invoice {t.document_number}</span>}
          </div>
          <div className="rounded-xl bg-surface-2 p-3 text-[14px]">
            <div className="font-medium">{t.issue}</div>
            <div className="mt-1 grid grid-cols-2 gap-x-6 text-[13px] text-muted sm:grid-cols-4">
              <span>Received: {date(t.received_date)}</span>
              <span>Promised: {t.promised_date ? date(t.promised_date) : '-'}</span>
              <span>Technician: {t.technician ?? '-'}</span>
              <span>Phone: {t.phone ?? t.party_phone ?? '-'}</span>
            </div>
            {(t.resolution || t.charges > 0) && (
              <div className="mt-2 border-t border-line pt-2 text-[13px]">
                {t.resolution && <div><span className="text-muted">Fix: </span>{t.resolution}</div>}
                {t.charges > 0 && <div><span className="text-muted">Charge: </span><span className="num font-semibold">{money(t.charges)}</span></div>}
              </div>
            )}
          </div>
          {manage && t.status !== 'closed' && (
            <div className="flex flex-wrap items-center gap-2">
              {t.status === 'new' && <Button size="sm" variant="soft" onClick={() => run(() => api('service.status', { id, status: 'in_progress' }), 'Started.')}>Start work</Button>}
              {(t.status === 'new' || t.status === 'in_progress') && <Button size="sm" onClick={() => run(() => api('service.status', { id, status: 'waiting_parts' }), 'Waiting for parts.')}>Waiting for parts</Button>}
              {t.status === 'waiting_parts' && <Button size="sm" variant="soft" onClick={() => run(() => api('service.status', { id, status: 'in_progress' }), 'Back in progress.')}>Parts arrived</Button>}
              {t.status !== 'resolved' && <Button size="sm" variant="primary" onClick={() => setFinish({ status: 'resolved' })}>Mark resolved</Button>}
              {t.status === 'resolved' && <Button size="sm" variant="primary" onClick={() => setFinish({ status: 'closed' })}>Close ticket</Button>}
              <Button size="sm" variant="ghost" onClick={() => onEdit(t)}>Edit</Button>
              {t.status === 'new' && <Button size="sm" variant="ghost" className="text-bad" onClick={async () => { if (await confirmDialog({ title: 'Delete this ticket?', message: 'Only a ticket nobody has worked on can be deleted.', danger: true, confirmLabel: 'Delete' })) { try { await api('service.delete', { id }); toast.ok('Deleted.'); onChanged(); onClose() } catch (e) { toast.error(e) } } }}>Delete</Button>}
            </div>
          )}
          {manage && t.status === 'closed' && <Button size="sm" onClick={() => run(() => api('service.status', { id, status: 'in_progress' }), 'Reopened.')}>Reopen</Button>}
          {manage && t.status !== 'closed' && (
            <div className="flex gap-2">
              <Select sm className="w-32" value={kind} onChange={(e) => setKind(e.target.value)} aria-label="Kind of follow-up">
                {Object.entries(KIND_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
              </Select>
              <Input sm className="flex-1" value={text} onChange={(e) => setText(e.target.value)} placeholder="What happened? Called, visited, ordered parts..." onKeyDown={(e) => { if (e.key === 'Enter' && text.trim()) { run(() => api('service.activity', { id, kind, summary: text }).then(() => setText(''))) } }} />
              <Button size="sm" disabled={!text.trim()} onClick={() => run(() => api('service.activity', { id, kind, summary: text }).then(() => setText('')))}>Add</Button>
            </div>
          )}
          <div>
            <div className="mb-2 text-[13px] font-semibold text-muted">History</div>
            <ul className="space-y-2">
              {d.data.activities.map((a: any) => (
                <li key={a.id} className="flex gap-3 text-[13.5px]">
                  <Badge tone="muted" className="h-fit">{KIND_LABEL[a.kind] ?? a.kind}</Badge>
                  <div className="flex-1">{a.summary}<div className="text-[12px] text-muted">{a.username} · {dateTime(a.created_at)}</div></div>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
      {finish && t && <FinishForm ticket={t} status={finish.status} onClose={() => setFinish(null)} onDone={() => { setFinish(null); reload() }} />}
    </Modal>
  )
}

function FinishForm({ ticket, status, onClose, onDone }: { ticket: any; status: string; onClose: () => void; onDone: () => void }): JSX.Element {
  const [resolution, setResolution] = useState<string>(ticket.resolution ?? '')
  const [charges, setCharges] = useState<number>(ticket.charges ?? 0)
  const [busy, setBusy] = useState(false)
  return (
    <Modal open onClose={onClose} title={status === 'closed' ? 'Close the ticket' : 'Mark resolved'} size="sm" footer={<><Button onClick={onClose}>Back</Button><Button variant="primary" loading={busy} disabled={!resolution.trim()} onClick={async () => { setBusy(true); try { await api('service.status', { id: ticket.id, status, resolution, charges }); toast.ok(status === 'closed' ? 'Ticket closed.' : 'Marked resolved.'); onDone() } catch (e) { toast.error(e); setBusy(false) } }}>Save</Button></>}>
      <div className="space-y-3">
        <Field label="What was done to fix it" required><Textarea rows={3} autoFocus value={resolution} onChange={(e) => setResolution(e.target.value)} /></Field>
        <Field label="Charge to customer" hint={ticket.under_warranty ? 'Under warranty, normally nothing.' : undefined}><NumberInput value={charges} onChange={setCharges} /></Field>
      </div>
    </Modal>
  )
}
