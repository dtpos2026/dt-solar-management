/** One invoice: A4 preview, payments, receipts, edit / cancel / record payment / void, print & save as PDF. */
import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { doc, getDoc, onSnapshot, orderBy, query } from 'firebase/firestore'
import { ArrowLeft, Ban, Copy, FileText, MessageCircle, Pencil, Printer, Receipt, Trash2, Undo2, Wallet } from 'lucide-react'
import { db } from '../../firebase'
import { Field, Modal, PageTitle } from '../../components/ui'
import { ConfirmDialog, EmptyState, IconButton, Loading, Notice, useToast } from '../../components/kit'
import { applyPayment, money, round2 } from '../../lib/billing'
import { canDeleteInvoice, cancelInvoice, clientFromSnap, deleteInvoice, invoiceFromSnap, invoiceRef, paymentFromSnap, paymentsCol, recordPayment, voidInvoicePayment } from '../../lib/invoices'
import { peekShared } from '../../lib/queryCache'
import { verifyUrl } from '../../lib/qr'
import type { DocumentData, QueryDocumentSnapshot } from 'firebase/firestore'
import { errorMessage, fmtDate, fmtDateTime, fromInputDate, toInputDate } from '../../lib/format'
import { useAdminEmail, useCan } from '../../lib/auth'
import type { Branding, Client, Invoice, InvoicePayment } from '../../lib/types'
import { InvoiceForm } from './InvoiceForm'
import { InvoiceDoc, ReceiptDoc, ThermalInvoice, ThermalReceipt } from './PrintDocs'
import { PrintPortal, StatusPill, copyText, invStatus, printNow, waNumber, type Paper } from './common'

export const PAYMENT_METHODS = ['Cash', 'Bank transfer', 'Cheque', 'JazzCash', 'EasyPaisa', 'Card', 'Online', 'Other']

type Msg = { tone: 'success' | 'error'; text: string } | null

export function InvoiceDetail({ id, clients, branding }: { id: string; clients: Client[]; branding: Branding }) {
  const can = useCan()
  const by = useAdminEmail()
  const nav = useNavigate()
  const toast = useToast()
  // Opened from the list (or just created): show the invoice from the shared live list at once.
  const [inv, setInv] = useState<Invoice | null>(() => {
    const d = peekShared<QueryDocumentSnapshot<DocumentData>[]>('invoices')?.find((x) => x.id === id)
    return d ? invoiceFromSnap(d) : null
  })
  const [missing, setMissing] = useState(false)
  const [loadErr, setLoadErr] = useState<string | null>(null)
  const [payments, setPayments] = useState<InvoicePayment[]>([])
  const [client, setClient] = useState<Client | undefined>()
  const [msg, setMsg] = useState<Msg>(null)
  const [edit, setEdit] = useState(false)
  const [payOpen, setPayOpen] = useState(false)
  const [cancelOpen, setCancelOpen] = useState(false)
  const [voidPay, setVoidPay] = useState<InvoicePayment | null>(null)
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [dlgErr, setDlgErr] = useState<string | null>(null)
  const [printPay, setPrintPay] = useState<InvoicePayment | null>(null)
  const [paper, setPaper] = useState<Paper>('a4')
  const [delOpen, setDelOpen] = useState(false)
  const deleting = useRef(false)

  useEffect(() => {
    setMissing(false); setLoadErr(null)
    setInv((cur) => (cur?.id === id ? cur : null))
    const u1 = onSnapshot(invoiceRef(id), (s) => { if (s.exists()) setInv(invoiceFromSnap(s)); else if (!deleting.current) setMissing(true) }, (e) => setLoadErr(errorMessage(e)))
    const u2 = onSnapshot(query(paymentsCol(id), orderBy('createdAt', 'asc')), (r) => setPayments(r.docs.map(paymentFromSnap)), () => setPayments([]))
    return () => { u1(); u2() }
  }, [id])

  const clientId = inv?.clientId ?? ''
  useEffect(() => {
    if (!clientId) return
    const known = clients.find((c) => c.id === clientId)
    if (known) { setClient(known); return }
    if (!can('clients.view')) return
    getDoc(doc(db, 'clients', clientId)).then((s) => s.exists() && setClient(clientFromSnap(s))).catch(() => undefined)
  }, [clientId, clients, can])

  useEffect(() => {
    const after = () => setPrintPay(null)
    window.addEventListener('afterprint', after)
    return () => window.removeEventListener('afterprint', after)
  }, [])

  if (loadErr && !inv) return <Notice tone="error">{loadErr}</Notice>
  if (missing) return <div className="card"><EmptyState icon={<FileText />} title="Invoice not found" hint="It may have been removed or the link is wrong."><Link className="btn btn-secondary" to="/billing">Back to billing</Link></EmptyState></div>
  if (!inv) return <Loading label="Loading invoice…" />

  const cancelled = inv.status === 'cancelled'
  const st = invStatus(inv)
  const printReceipt = (p: InvoicePayment, size: Paper) => { setPrintPay(p); setPaper(size); printNow(`Receipt ${p.receiptNo}`) }
  const printInvoice = (size: Paper) => { setPrintPay(null); setPaper(size); printNow(`Invoice ${inv.number}`) }
  const link = verifyUrl(inv.verifyToken, branding.verifyBaseUrl)
  const shareText = [
    `Invoice ${inv.number} from ${branding.companyName}`,
    `Customer: ${inv.clientName}`,
    `Total: ${money(inv.total, inv.currency)}`,
    cancelled ? 'Status: CANCELLED' : `Balance due: ${money(inv.balance, inv.currency)}${inv.dueDate ? ` (due ${fmtDate(inv.dueDate)})` : ''}`,
    `Verify / view: ${link}`
  ].join('\n')
  const waHref = `https://wa.me/${waNumber(client?.phone ?? '')}?text=${encodeURIComponent(shareText)}`
  const copyLink = async () => {
    try { await copyText(link); toast('Verification link copied.') } catch (e) { toast(errorMessage(e), 'error') }
  }
  const doDelete = async () => {
    setBusy(true); setDlgErr(null)
    deleting.current = true
    try {
      await deleteInvoice(inv, by)
      setDelOpen(false)
      toast(`Invoice ${inv.number} deleted.`)
      nav('/billing', { replace: true })
    } catch (e) { deleting.current = false; setDlgErr(errorMessage(e)) } finally { setBusy(false) }
  }

  const doCancel = async () => {
    setBusy(true); setDlgErr(null)
    try { await cancelInvoice(inv, reason, branding, by); setCancelOpen(false); setMsg({ tone: 'success', text: `Invoice ${inv.number} cancelled.` }) } catch (e) { setDlgErr(errorMessage(e)) } finally { setBusy(false) }
  }
  const doVoid = async () => {
    if (!voidPay) return
    setBusy(true); setDlgErr(null)
    try { await voidInvoicePayment(inv, voidPay, reason, by); setMsg({ tone: 'success', text: `Payment ${voidPay.receiptNo} voided.` }); setVoidPay(null) } catch (e) { setDlgErr(errorMessage(e)) } finally { setBusy(false) }
  }

  return (
    <div>
      <PageTitle
        title={`Invoice ${inv.number}`}
        sub={`${inv.clientName} · issued ${fmtDate(inv.issueDate)} · created by ${inv.createdBy || '—'}`}
        actions={<>
          <Link className="btn btn-secondary" to="/billing"><ArrowLeft className="h-4 w-4" /> All invoices</Link>
          {can('billing.create') && !cancelled && inv.paid === 0 && <button className="btn btn-secondary" onClick={() => setEdit(true)}><Pencil className="h-4 w-4" /> Edit</button>}
          {can('billing.create') && !cancelled && <button className="btn btn-secondary text-red-600" onClick={() => { setReason(''); setDlgErr(null); setCancelOpen(true) }}><Ban className="h-4 w-4" /> Cancel invoice</button>}
          {can('billing.create') && canDeleteInvoice(inv) && <button className="btn btn-secondary text-red-600" onClick={() => { setDlgErr(null); setDelOpen(true) }}><Trash2 className="h-4 w-4" /> Delete</button>}
          {can('billing.payments') && !cancelled && inv.balance > 0 && <button className="btn btn-success" onClick={() => setPayOpen(true)}><Wallet className="h-4 w-4" /> Record payment</button>}
          <a className="btn btn-secondary" href={waHref} target="_blank" rel="noreferrer" title={client?.phone ? `Send to ${client.phone} on WhatsApp` : 'Share on WhatsApp'}><MessageCircle className="h-4 w-4" /> WhatsApp</a>
          <button className="btn btn-secondary" onClick={copyLink} title={link}><Copy className="h-4 w-4" /> Copy link</button>
          <button className="btn btn-secondary" onClick={() => printInvoice('80mm')} title="Compact invoice for an 80 mm thermal printer"><Receipt className="h-4 w-4" /> 80 mm</button>
          <button className="btn btn-primary" onClick={() => printInvoice('a4')} title="Print A4, or choose “Save as PDF” as the printer to download a PDF"><Printer className="h-4 w-4" /> Print / PDF (A4)</button>
        </>}
      />
      {msg && <Notice tone={msg.tone} className="mb-3" onClose={() => setMsg(null)}>{msg.text}</Notice>}
      {cancelled && <Notice tone="warn" className="mb-3">Cancelled {fmtDateTime(inv.cancelledAt)} — {inv.cancelReason || 'no reason given'}. The public verification page shows this invoice as cancelled.</Notice>}

      <div className="grid grid-cols-[minmax(0,1fr)_340px] gap-4">
        <div className="card overflow-auto bg-[#efeaf6] p-4">
          <div className="origin-top-left" style={{ width: '210mm' }}>
            <div className="shadow-lg"><InvoiceDoc inv={inv} b={branding} client={client} payments={payments} /></div>
          </div>
        </div>
        <div className="space-y-4">
          <div className="card p-4 text-[13px]">
            <div className="mb-2 flex items-center justify-between"><span className="font-bold">Summary</span><StatusPill status={st} /></div>
            <Row k="Total" v={money(inv.total, inv.currency)} />
            <Row k="Paid" v={money(inv.paid, inv.currency)} />
            <Row k="Balance" v={<b className="text-[#3d096d]">{money(cancelled ? 0 : inv.balance, inv.currency)}</b>} />
            <Row k="Due date" v={fmtDate(inv.dueDate)} />
            {inv.licenseId && <Row k="License" v={<Link className="font-semibold text-[#3d096d] hover:underline" to={`/licenses/${inv.licenseId}`}>Open license</Link>} />}
            {inv.clientId && can('clients.view') && <Row k="Client" v={<Link className="font-semibold text-[#3d096d] hover:underline" to={`/clients/${inv.clientId}`}>{inv.clientName}</Link>} />}
          </div>
          <div className="card">
            <div className="flex items-center gap-2 border-b border-[#ece6f4] px-4 py-3 font-bold"><Receipt className="h-4 w-4 text-[#3d096d]" /> Payments</div>
            {payments.length === 0 ? <div className="px-4 py-6 text-center text-[13px] text-[#7a6d92]">No payments recorded yet.</div> : (
              <ul className="divide-y divide-[#f0ebf6]">
                {payments.map((p) => (
                  <li key={p.id} className={p.cancelled ? 'px-4 py-2.5 text-[13px] opacity-60' : 'px-4 py-2.5 text-[13px]'}>
                    <div className="flex items-center justify-between gap-2">
                      <div>
                        <div className="font-semibold">{money(p.amount, inv.currency)} {p.cancelled && <span className="ml-1 rounded bg-red-100 px-1.5 text-[11px] font-bold text-red-700">VOID</span>}</div>
                        <div className="text-[12px] text-[#7a6d92]">{p.receiptNo} · {fmtDate(p.date)} · {p.method}{p.reference ? ` · ${p.reference}` : ''}</div>
                        {p.cancelled && p.cancelReason && <div className="text-[12px] text-red-700">Void: {p.cancelReason}</div>}
                      </div>
                      <div className="flex shrink-0">
                        <IconButton title="Print receipt (A4 / PDF)" onClick={() => printReceipt(p, 'a4')}><Printer /></IconButton>
                        <IconButton title="Thermal receipt (80 mm)" onClick={() => printReceipt(p, '80mm')}><Receipt /></IconButton>
                        {can('billing.payments') && !p.cancelled && !cancelled && <IconButton danger title="Void payment" onClick={() => { setReason(''); setDlgErr(null); setVoidPay(p) }}><Undo2 /></IconButton>}
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </div>

      <PrintPortal paper={paper}>
        {printPay
          ? paper === '80mm' ? <ThermalReceipt inv={inv} pay={printPay} b={branding} /> : <ReceiptDoc inv={inv} pay={printPay} b={branding} />
          : paper === '80mm' ? <ThermalInvoice inv={inv} b={branding} /> : <InvoiceDoc inv={inv} b={branding} client={client} payments={payments} />}
      </PrintPortal>

      {edit && <InvoiceForm open invoice={inv} clients={clients} branding={branding} onClose={() => setEdit(false)} onSaved={() => setMsg({ tone: 'success', text: 'Invoice updated; public verification copy re-synced.' })} />}
      {payOpen && <PaymentModal inv={inv} branding={branding} by={by} onClose={() => setPayOpen(false)} onDone={(r) => setMsg({ tone: 'success', text: `Payment recorded — receipt ${r}.` })} />}
      <ConfirmDialog open={cancelOpen} title={`Cancel invoice ${inv.number}?`} confirmLabel="Cancel invoice" danger busy={busy} disabled={!reason.trim()} error={dlgErr} onConfirm={doCancel} onClose={() => setCancelOpen(false)}>
        <p>The invoice is kept (never deleted) and marked cancelled. Anyone scanning its QR code will see “Cancelled”.</p>
        <Field label="Reason *"><textarea className="input" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} autoFocus /></Field>
      </ConfirmDialog>
      <ConfirmDialog open={delOpen} title={`Delete invoice ${inv.number}?`} confirmLabel="Delete permanently" danger busy={busy} error={dlgErr} onConfirm={doDelete} onClose={() => setDelOpen(false)}>
        <p>This permanently removes the invoice{payments.length ? `, its ${payments.length} payment record(s)` : ''} and its public verification copy (the QR code will show “Invalid invoice”). It cannot be undone. The deletion is recorded in the activity log.</p>
        {!cancelled && <p className="text-[12.5px] text-[#7a6d92]">Allowed because no payment is recorded on it. To keep a record instead, cancel the invoice.</p>}
      </ConfirmDialog>
      <ConfirmDialog open={!!voidPay} title={`Void payment ${voidPay?.receiptNo ?? ''}?`} confirmLabel="Void payment" danger busy={busy} disabled={!reason.trim()} error={dlgErr} onConfirm={doVoid} onClose={() => setVoidPay(null)}>
        <p>{voidPay && money(voidPay.amount, inv.currency)} will be removed from the paid amount. The payment record stays (marked void) for the audit trail.</p>
        <Field label="Reason *"><textarea className="input" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} autoFocus /></Field>
      </ConfirmDialog>
    </div>
  )
}

function Row({ k, v }: { k: string; v: React.ReactNode }) {
  return <div className="flex justify-between gap-3 py-1"><span className="text-[#7a6d92]">{k}</span><span className="text-right">{v}</span></div>
}

function PaymentModal({ inv, branding, by, onClose, onDone }: { inv: Invoice; branding: Branding; by: string; onClose: () => void; onDone: (receiptNo: string) => void }) {
  const [amount, setAmount] = useState(String(round2(inv.balance)))
  const [method, setMethod] = useState(PAYMENT_METHODS[0])
  const [reference, setReference] = useState('')
  const [date, setDate] = useState(toInputDate(new Date()))
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const save = async () => {
    setErr(null)
    const a = Number(amount)
    const d = fromInputDate(date)
    if (!d) return setErr('Enter the payment date.')
    if (d.getTime() > Date.now() + 86400000) return setErr('Payment date cannot be in the future.')
    try { applyPayment(inv.total, inv.paid, a) } catch (e) { return setErr(errorMessage(e)) }
    setBusy(true)
    try { const r = await recordPayment(inv, { amount: a, method, reference: reference.trim(), date: d }, branding, by); onDone(r.receiptNo); onClose() } catch (e) { setErr(errorMessage(e)) } finally { setBusy(false) }
  }
  return (
    <Modal open onClose={() => !busy && onClose()} title={`Record payment — ${inv.number}`}
      footer={<><button className="btn btn-secondary" onClick={onClose} disabled={busy}>Cancel</button><button className="btn btn-success" onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Record payment'}</button></>}>
      <div className="mb-3 rounded-xl bg-[#f7f2fd] p-3 text-[13px]">Outstanding balance: <b>{money(inv.balance, inv.currency)}</b></div>
      <div className="grid grid-cols-2 gap-3">
        <Field label={`Amount (${inv.currency}) *`}><input className="input" type="number" min="0" step="any" value={amount} onChange={(e) => setAmount(e.target.value)} autoFocus /></Field>
        <Field label="Payment date *"><input className="input" type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
        <Field label="Method"><select className="input" value={method} onChange={(e) => setMethod(e.target.value)}>{PAYMENT_METHODS.map((m) => <option key={m}>{m}</option>)}</select></Field>
        <Field label="Reference"><input className="input" value={reference} maxLength={120} onChange={(e) => setReference(e.target.value)} placeholder="Txn id, cheque no…" /></Field>
      </div>
      {err && <Notice tone="error" className="mt-3">{err}</Notice>}
    </Modal>
  )
}
