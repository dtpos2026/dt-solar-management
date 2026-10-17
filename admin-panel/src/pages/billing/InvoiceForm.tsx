/** Create / edit invoice modal. Totals come only from lib/billing.ts. */
import { useEffect, useMemo, useState } from 'react'
import { getDocs, query, where } from 'firebase/firestore'
import { Plus, Trash2 } from 'lucide-react'
import { Field, Modal } from '../../components/ui'
import { computeTotals, money, type LineInput, type LineKind } from '../../lib/billing'
import { createInvoice, updateInvoice, type InvoiceInput } from '../../lib/invoices'
import { licenseFromSnap, licensesCol } from '../../lib/licenses'
import { errorMessage, fromInputDate, toDate, toInputDate } from '../../lib/format'
import { useAdminEmail } from '../../lib/auth'
import type { Branding, Client, Invoice, License, PlanType } from '../../lib/types'
import { ErrorBox } from './common'

interface Extra { qty: number; rate: number }
interface Other { description: string; qty: number; rate: number }

const PLAN_LABEL: Record<PlanType, string> = { monthly: 'Monthly', yearly: 'Yearly', lifetime: 'Lifetime', trial: 'Trial' }

export function InvoiceForm({ open, invoice, clients, branding, onClose, onSaved }: { open: boolean; invoice?: Invoice; clients: Client[]; branding: Branding; onClose: () => void; onSaved: (id: string) => void }) {
  const by = useAdminEmail()
  const [clientId, setClientId] = useState('')
  const [licenseId, setLicenseId] = useState('')
  const [licenses, setLicenses] = useState<License[]>([])
  const [planType, setPlanType] = useState<PlanType | ''>('yearly')
  const [planDesc, setPlanDesc] = useState('DT Solar Pro license')
  const [planPrice, setPlanPrice] = useState(0)
  const [firms, setFirms] = useState<Extra>({ qty: 0, rate: 0 })
  const [devices, setDevices] = useState<Extra>({ qty: 0, rate: 0 })
  const [others, setOthers] = useState<Other[]>([])
  const [discount, setDiscount] = useState(0)
  const [taxRate, setTaxRate] = useState(0)
  const [issue, setIssue] = useState('')
  const [due, setDue] = useState('')
  const [notes, setNotes] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setErr(null)
    if (invoice) {
      const plan = invoice.lines.find((l) => l.kind === 'plan')
      const f = invoice.lines.find((l) => l.kind === 'extra_firm')
      const d = invoice.lines.find((l) => l.kind === 'extra_device')
      setClientId(invoice.clientId); setLicenseId(invoice.licenseId); setPlanType(invoice.planType)
      setPlanDesc((plan?.description ?? 'DT Solar Pro license').replace(/ \((Monthly|Yearly|Lifetime)\)$/, '')); setPlanPrice(plan?.rate ?? 0)
      setFirms({ qty: f?.qty ?? 0, rate: f?.rate ?? 0 }); setDevices({ qty: d?.qty ?? 0, rate: d?.rate ?? 0 })
      setOthers(invoice.lines.filter((l) => l.kind === 'other').map((l) => ({ description: l.description, qty: l.qty, rate: l.rate })))
      setDiscount(invoice.discount); setTaxRate(invoice.taxRate)
      setIssue(toInputDate(toDate(invoice.issueDate))); setDue(toInputDate(toDate(invoice.dueDate))); setNotes(invoice.notes)
    } else {
      const now = new Date()
      setClientId(''); setLicenseId(''); setPlanType('yearly'); setPlanDesc('DT Solar Pro license'); setPlanPrice(0)
      setFirms({ qty: 0, rate: 0 }); setDevices({ qty: 0, rate: 0 }); setOthers([]); setDiscount(0); setTaxRate(branding.taxRate || 0)
      setIssue(toInputDate(now)); setDue(toInputDate(new Date(now.getTime() + 7 * 86400000))); setNotes('')
    }
  }, [open, invoice, branding.taxRate])

  useEffect(() => {
    if (!open || !clientId) { setLicenses([]); return }
    getDocs(query(licensesCol(), where('clientId', '==', clientId)))
      .then((r) => setLicenses(r.docs.map(licenseFromSnap)))
      .catch(() => setLicenses([]))
  }, [open, clientId])

  const client = clients.find((c) => c.id === clientId)
  const lines = useMemo<LineInput[]>(() => {
    const out: LineInput[] = []
    if (planType && planPrice > 0) out.push({ kind: 'plan', description: `${planDesc.trim() || 'DT Solar Pro license'} (${PLAN_LABEL[planType]})`, qty: 1, rate: planPrice })
    if (firms.qty > 0) out.push({ kind: 'extra_firm' as LineKind, description: 'Additional firms', qty: firms.qty, rate: firms.rate })
    if (devices.qty > 0) out.push({ kind: 'extra_device' as LineKind, description: 'Additional devices', qty: devices.qty, rate: devices.rate })
    for (const o of others) out.push({ kind: 'other', description: o.description, qty: o.qty, rate: o.rate })
    return out
  }, [planType, planDesc, planPrice, firms, devices, others])
  const t = computeTotals(lines, discount, taxRate)
  const cur = branding.currency || 'PKR'

  const save = async () => {
    setErr(null)
    const issueDate = fromInputDate(issue)
    const dueDate = fromInputDate(due)
    if (!clientId) return setErr('Select a client.')
    if (!issueDate) return setErr('Enter the issue date.')
    if (dueDate && dueDate < issueDate) return setErr('Due date cannot be before the issue date.')
    if (t.lines.length === 0 || t.total <= 0) return setErr('Add at least one priced line item.')
    if (others.some((o) => !o.description.trim())) return setErr('Every other line needs a description.')
    if (discount < 0 || discount > t.subtotal) return setErr('Discount must be between 0 and the subtotal.')
    const f: InvoiceInput = { clientId, clientName: client?.company || invoice?.clientName || '', licenseId, planType, lines, discount, taxRate, issueDate, dueDate, notes: notes.trim() }
    setBusy(true)
    try {
      if (invoice) { await updateInvoice(invoice, f, branding, by); onSaved(invoice.id) } else { const r = await createInvoice(f, branding, by); onSaved(r.id) }
      onClose()
    } catch (e) {
      setErr(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  const numIn = (v: number, set: (n: number) => void, min = 0) => <input className="input" type="number" min={min} step="any" value={Number.isFinite(v) ? v : 0} onChange={(e) => set(Number(e.target.value))} />

  return (
    <Modal open={open} onClose={onClose} wide title={invoice ? `Edit invoice ${invoice.number}` : 'New invoice'}
      footer={<><button className="btn btn-secondary" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={busy} onClick={save}>{busy ? 'Saving…' : invoice ? 'Save changes' : 'Create invoice'}</button></>}>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Client *">
          <select className="input" value={clientId} onChange={(e) => { setClientId(e.target.value); setLicenseId('') }} autoFocus>
            <option value="">Select a client…</option>
            {clients.map((c) => <option key={c.id} value={c.id}>{c.company}{c.code ? ` (${c.code})` : ''}</option>)}
            {invoice && !clients.some((c) => c.id === invoice.clientId) && <option value={invoice.clientId}>{invoice.clientName}</option>}
          </select>
        </Field>
        <Field label="License (optional)" hint={clientId && licenses.length === 0 ? 'No licenses linked to this client' : undefined}>
          <select className="input" value={licenseId} onChange={(e) => setLicenseId(e.target.value)} disabled={!clientId}>
            <option value="">None</option>
            {licenses.map((l) => <option key={l.id} value={l.id}>{l.licenseKey} - {l.businessName || l.customerName}</option>)}
          </select>
        </Field>

        <div className="col-span-2 mt-1 text-[13px] font-bold text-[#3d096d]">Plan</div>
        <Field label="Plan type">
          <select className="input" value={planType} onChange={(e) => setPlanType(e.target.value as PlanType | '')}>
            <option value="">No plan line</option>
            <option value="monthly">Monthly</option>
            <option value="yearly">Yearly</option>
            <option value="lifetime">Lifetime</option>
          </select>
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Description"><input className="input" value={planDesc} onChange={(e) => setPlanDesc(e.target.value)} disabled={!planType} /></Field>
          <Field label={`Price (${cur})`}>{numIn(planPrice, setPlanPrice)}</Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Additional firms (qty)">{numIn(firms.qty, (q) => setFirms({ ...firms, qty: q }))}</Field>
          <Field label="Rate per firm">{numIn(firms.rate, (r) => setFirms({ ...firms, rate: r }))}</Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Additional devices (qty)">{numIn(devices.qty, (q) => setDevices({ ...devices, qty: q }))}</Field>
          <Field label="Rate per device">{numIn(devices.rate, (r) => setDevices({ ...devices, rate: r }))}</Field>
        </div>

        <div className="col-span-2 mt-1 flex items-center justify-between">
          <span className="text-[13px] font-bold text-[#3d096d]">Other lines</span>
          <button className="btn btn-secondary btn-sm" onClick={() => setOthers([...others, { description: '', qty: 1, rate: 0 }])}><Plus className="h-4 w-4" /> Add line</button>
        </div>
        {others.map((o, i) => (
          <div key={i} className="col-span-2 grid grid-cols-[1fr_90px_130px_36px] items-end gap-2">
            <Field label="Description"><input className="input" value={o.description} onChange={(e) => setOthers(others.map((x, j) => (j === i ? { ...x, description: e.target.value } : x)))} /></Field>
            <Field label="Qty">{numIn(o.qty, (q) => setOthers(others.map((x, j) => (j === i ? { ...x, qty: q } : x))))}</Field>
            <Field label="Rate">{numIn(o.rate, (r) => setOthers(others.map((x, j) => (j === i ? { ...x, rate: r } : x))))}</Field>
            <button className="btn btn-secondary btn-sm h-[38px]" title="Remove" onClick={() => setOthers(others.filter((_, j) => j !== i))}><Trash2 className="h-4 w-4" /></button>
          </div>
        ))}

        <div className="grid grid-cols-2 gap-3">
          <Field label={`Discount (${cur})`}>{numIn(discount, setDiscount)}</Field>
          <Field label={`${branding.taxName || 'Tax'} rate (%)`}>{numIn(taxRate, setTaxRate)}</Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Issue date *"><input className="input" type="date" value={issue} onChange={(e) => setIssue(e.target.value)} /></Field>
          <Field label="Due date"><input className="input" type="date" value={due} onChange={(e) => setDue(e.target.value)} /></Field>
        </div>
        <Field label="Notes" className="col-span-2"><textarea className="input" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>

        <div className="col-span-2 rounded-xl bg-[#f7f2fd] p-3 text-[13px]">
          <div className="flex justify-between"><span>Subtotal</span><b>{money(t.subtotal, cur)}</b></div>
          <div className="flex justify-between"><span>Discount</span><b>− {money(t.discount, cur)}</b></div>
          <div className="flex justify-between"><span>{branding.taxName || 'Tax'} ({t.taxRate}%)</span><b>{money(t.taxAmount, cur)}</b></div>
          <div className="mt-1 flex justify-between border-t border-[#e4d8f3] pt-1 text-[15px]"><span className="font-bold">Total</span><b className="text-[#3d096d]">{money(t.total, cur)}</b></div>
        </div>
      </div>
      {err && <ErrorBox>{err}</ErrorBox>}
    </Modal>
  )
}
