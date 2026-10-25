import { ReactNode, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { ArrowLeft, Ban, Copy, CopyPlus, FileDown, Info, HandCoins, Pencil, Printer, RefreshCcw, Trash2, Undo2, Truck, FileCheck2, CheckCircle2, XCircle, Send } from 'lucide-react'
import { api } from '../../api'
import { WhatsAppButton } from '../../components/WhatsAppButton'
import { useApp, useCan } from '../../store'
import { optionOn } from '@shared/options'
import { Badge, Button, Card, IconButton, Kv, Loading, promptDialog, confirmDialog, toast } from '../../components/ui'
import { PaymentModal } from '../../components/PaymentModal'
import { useLoad } from '../../lib/hooks'
import { date, dateTime, label, money, moneyFull, qty, statusTone } from '../../lib/format'
import { DOC_TYPES, DocType } from '@shared/docTypes'
import { round2 } from '@shared/money'

/* eslint-disable @typescript-eslint/no-explicit-any */
export function DocumentView(): JSX.Element {
  const settings = useApp((st) => st.settings)
  const { id } = useParams()
  const nav = useNavigate()
  const can = useCan()
  const [payOpen, setPayOpen] = useState(false)
  const { data: d, loading, reload } = useLoad(() => api<any>('docs.get', { id: Number(id) }), [id])

  if (loading && !d) return <Loading />
  if (!d) return <div />
  const meta = DOC_TYPES[d.doc_type as DocType]
  const p = meta.perm
  const cancelled = d.status === 'cancelled'
  const isQuote = d.doc_type === 'quotation'
  // A converted quotation can still be corrected or cancelled; the sale made from it is a separate document and stays as it is.
  const canEdit = !cancelled && (isQuote ? can('quotations.manage') : d.status !== 'converted' && can(`${p}.edit`) && (!d.locked || can(`${p}.edit_locked`)))
  const canCancel = !cancelled && (isQuote ? can('quotations.manage') : meta.financial && can(`${p}.cancel`) && (!d.locked || can(`${p}.edit_locked`)))
  // The server explains why a document cannot be deleted (permission, payments, references, closed period); the
  // button is shown only when the delete would be accepted.
  const canDelete = !d.delete_block
  const canCopy = !d.doc_type.includes('return') && (p === 'quotations' ? can('quotations.manage') : can(`${p}.create`))
  const printDoc = (): void => {
    api('print.open', { kind: 'doc', id: d.id }).catch(toast.error)
  }
  const convert = (target: DocType): void => nav(`/doc/new/${target}?from=${d.id}`)
  const conversions: Array<{ target: DocType; label: string; icon: ReactNode; perm: string }> = []
  if (!cancelled && d.status !== 'converted') {
    if (d.doc_type === 'quotation') {
      conversions.push({ target: 'sale_invoice', label: 'Convert to Invoice', icon: <FileCheck2 className="h-4 w-4" />, perm: 'sales.create' })
      conversions.push({ target: 'sale_order', label: 'Convert to Sales Order', icon: <Copy className="h-4 w-4" />, perm: 'sales.create' })
    }
    if (d.doc_type === 'sale_order') conversions.push({ target: 'sale_invoice', label: 'Create Invoice', icon: <FileCheck2 className="h-4 w-4" />, perm: 'sales.create' })
    if (d.doc_type === 'sale_order' || d.doc_type === 'quotation') conversions.push({ target: 'delivery_challan', label: 'Delivery Challan', icon: <Truck className="h-4 w-4" />, perm: 'sales.create' })
    if (d.doc_type === 'delivery_challan') conversions.push({ target: 'sale_invoice', label: 'Create Invoice', icon: <FileCheck2 className="h-4 w-4" />, perm: 'sales.create' })
    if (d.doc_type === 'purchase_order') conversions.push({ target: 'purchase_invoice', label: 'Receive / Create Bill', icon: <FileCheck2 className="h-4 w-4" />, perm: 'purchases.create' })
  }
  if (!cancelled && d.doc_type === 'sale_invoice') {
    conversions.push({ target: 'delivery_challan', label: 'Delivery Challan', icon: <Truck className="h-4 w-4" />, perm: 'sales.create' })
    conversions.push({ target: 'sale_return', label: 'Sales Return', icon: <Undo2 className="h-4 w-4" />, perm: 'sales.create' })
  }
  if (!cancelled && d.doc_type === 'purchase_invoice') conversions.push({ target: 'purchase_return', label: 'Purchase Return', icon: <Undo2 className="h-4 w-4" />, perm: 'purchases.create' })

  const doCancel = async (): Promise<void> => {
    const reason = await promptDialog({
      title: `Cancel ${meta.label} ${d.number}?`,
      message: isQuote
        ? `The quotation is marked cancelled and can no longer be edited or converted.${d.status === 'converted' ? ` The sale created from it (${d.converted_to ?? 'linked document'}) is not changed.` : ''} This is recorded in the audit log.`
        : 'Stock movements will be reversed. Any payments recorded against it will remain as advance (unallocated) balance. This is recorded in the audit log.',
      confirmLabel: 'Cancel document',
      danger: true,
      input: { label: 'Reason for cancellation', required: true }
    })
    if (!reason) return
    try {
      await api('docs.cancel', { id: d.id, reason })
      toast.ok('Document cancelled.')
      reload()
    } catch (e) {
      toast.error(e)
    }
  }
  const doDelete = async (): Promise<void> => {
    const message = meta.financial
      ? `${meta.label} ${d.number} (${moneyFull(d.grand_total)}) will be removed permanently.${meta.stock !== 0 && !cancelled ? ' Its stock movements and serial numbers are reversed exactly like a cancellation.' : ''}${d.paid > 0 && meta.financial ? ` The ${moneyFull(d.paid)} already ${d.doc_type === 'purchase_invoice' ? 'paid is kept as an advance with the supplier' : 'received is kept as an advance with the customer'}.` : ''} A full copy is kept in the audit log. This cannot be undone.`
      : `${meta.label} ${d.number} will be removed permanently. This cannot be undone.`
    if (!(await confirmDialog({ title: `Delete ${d.number} permanently?`, message, danger: true, confirmLabel: 'Delete permanently' }))) return
    try {
      await api('docs.delete', { id: d.id })
      toast.ok(`${d.number} deleted.`)
      nav(-1)
    } catch (e) {
      toast.error(e)
      reload()
    }
  }
  const setStatus = async (status: string): Promise<void> => {
    let reason: string | undefined
    if (status === 'rejected') {
      const r = await promptDialog({ title: `Reject quotation ${d.number}?`, message: 'The customer did not accept it. You can note why; the quotation stays on file as rejected.', confirmLabel: 'Reject quotation', danger: true, input: { label: 'Reason (optional)' } })
      if (r === null || r === undefined) return
      reason = r
    }
    try {
      await api('docs.setQuotationStatus', { id: d.id, status, reason })
      reload()
    } catch (e) {
      toast.error(e)
    }
  }
  const applyAdvance = async (): Promise<void> => {
    try {
      const n = await api<number>('docs.applyAdvances', { id: d.id })
      toast.ok(n > 0 ? `Applied ${money(n)} from advances.` : 'No unallocated advances found for this party.')
      reload()
    } catch (e) {
      toast.error(e)
    }
  }

  const settleDir = d.doc_type === 'sale_invoice' || d.doc_type === 'purchase_return' ? 'in' : 'out'
  const profit = d.cost_total !== null && d.doc_type === 'sale_invoice' && d.deduct_stock ? round2(d.net_total - d.cost_total) : null

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <IconButton title="Back" onClick={() => nav(-1)}>
          <ArrowLeft className="h-5 w-5" />
        </IconButton>
        <div className="mr-auto">
          <div className="flex items-center gap-2">
            <h1 className="text-[20px] font-bold">{meta.label} {d.number}</h1>
            {cancelled ? <Badge tone="bad">Cancelled</Badge> : meta.financial ? <Badge tone={statusTone(d.due <= 0.5 ? 'paid' : d.paid + d.returned > 0 ? 'partial' : 'unpaid')}>{d.due <= 0.5 ? 'Paid' : d.paid + d.returned > 0 ? 'Partially paid' : 'Unpaid'}</Badge> : <Badge tone={statusTone(d.status)}>{label(d.status)}</Badge>}
            {d.is_tax_invoice ? <Badge tone="info">Sales Tax Invoice</Badge> : null}
          </div>
          <div className="text-[12.5px] text-muted">
            Created by {d.created_by_name} on {dateTime(d.created_at)}
            {d.updated_at && `, edited by ${d.updated_by_name} on ${dateTime(d.updated_at)}`}
          </div>
        </div>
        <Button icon={<Printer className="h-4 w-4" />} variant="primary" onClick={printDoc}>Print / PDF</Button>
        <WhatsAppButton entity="document" id={d.id} partyId={d.party_id} phone={d.party_phone} />
        {canEdit && <Button icon={<Pencil className="h-4 w-4" />} onClick={() => nav(`/doc/${d.id}/edit`)}>Edit</Button>}
        {meta.financial && !cancelled && d.due > 0.5 && can('accounts.manage') && (
          <Button icon={<HandCoins className="h-4 w-4" />} variant="success" onClick={() => setPayOpen(true)}>
            {settleDir === 'in' ? 'Receive payment' : 'Make payment'}
          </Button>
        )}
        {canCancel && <Button icon={<Ban className="h-4 w-4" />} variant="ghost" className="text-bad" onClick={doCancel}>Cancel</Button>}
        {canCopy && <Button icon={<CopyPlus className="h-4 w-4" />} variant="ghost" onClick={() => nav(`/doc/new/${d.doc_type}?copy=${d.id}`)}>Duplicate</Button>}
        {canDelete && <Button icon={<Trash2 className="h-4 w-4" />} variant="ghost" className="text-bad" onClick={doDelete}>Delete</Button>}
      </div>

      {(conversions.some((c) => can(c.perm)) || d.doc_type === 'quotation') && (
        <div className="flex flex-wrap items-center gap-2">
          {conversions.filter((c) => can(c.perm)).map((c) => (
            <Button key={c.target + c.label} size="sm" variant="soft" icon={c.icon} onClick={() => convert(c.target)}>{c.label}</Button>
          ))}
          {d.doc_type === 'quotation' && !cancelled && d.status !== 'converted' && can('quotations.manage') && (
            <>
              <span className="mx-1 h-5 w-px bg-line" />
              <Button size="sm" variant="ghost" icon={<Send className="h-4 w-4" />} onClick={() => setStatus('sent')}>Mark sent</Button>
              <Button size="sm" variant="ghost" icon={<CheckCircle2 className="h-4 w-4 text-ok" />} onClick={() => setStatus('accepted')}>Accepted</Button>
              <Button size="sm" variant="ghost" icon={<XCircle className="h-4 w-4 text-bad" />} onClick={() => setStatus('rejected')}>Rejected</Button>
            </>
          )}
          {meta.financial && !cancelled && d.due > 0.5 && d.party_id && can('accounts.manage') && (
            <Button size="sm" variant="ghost" icon={<RefreshCcw className="h-4 w-4" />} onClick={applyAdvance}>Apply advances</Button>
          )}
        </div>
      )}

      {cancelled && <div className="rounded-xl bg-bad-soft px-4 py-3 text-[13px] text-bad">Cancelled on {dateTime(d.cancelled_at)}. Reason: {d.cancel_reason ?? '-'}</div>}
      {meta.financial && d.delete_block && can(`${p}.delete`) && (
        <div className="flex items-start gap-2 rounded-xl bg-surface-2 px-4 py-2.5 text-[12.5px] text-muted">
          <Info className="mt-0.5 h-4 w-4 shrink-0" />
          <span>Permanent delete is not available: {d.delete_block}</span>
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card title={meta.partyType === 'customer' ? 'Customer' : 'Supplier'}>
          <div className="font-semibold">
            {d.party_id ? (
              <button type="button" className="text-brand hover:underline cursor-pointer" onClick={() => nav(`/party/${d.party_id}`)}>{d.party_master_name}</button>
            ) : (
              d.party_name
            )}
          </div>
          <div className="mt-1 text-[13px] text-muted">{d.party_master_phone ?? d.party_phone}</div>
          <div className="text-[13px] text-muted">{d.party_master_address ?? d.party_address}</div>
          {d.current_balance !== null && <Kv label="Party balance (this firm)" className="mt-2 border-t border-line pt-2">{money(d.current_balance)}</Kv>}
        </Card>
        <Card title="Details">
          <Kv label="Date">{date(d.date)}</Kv>
          {optionOn(settings, 'txn.time') && /\d\d:\d\d/.test(d.created_at ?? '') && <Kv label="Time">{String(d.created_at).slice(11, 16)}</Kv>}
          {d.due_date && <Kv label="Due date">{date(d.due_date)}</Kv>}
          {d.valid_until && <Kv label="Valid until">{date(d.valid_until)}</Kv>}
          {d.project_id && (
            <Kv label="Project">
              <button type="button" className="text-brand hover:underline cursor-pointer" onClick={() => nav(`/projects/${d.project_id}`)}>{d.project_code}, {d.project_name}</button>
            </Kv>
          )}
          {d.warehouse_name && <Kv label="Warehouse">{d.warehouse_name}</Kv>}
          {d.party_ref && <Kv label="Reference">{d.party_ref}</Kv>}
          {d.ref_doc_number && (
            <Kv label="Source">
              <button type="button" className="text-brand hover:underline cursor-pointer" onClick={() => nav(`/doc/${d.ref_doc_id}`)}>{d.ref_doc_number}</button>
            </Kv>
          )}
          {d.doc_type === 'sale_invoice' && !d.deduct_stock && <div className="mt-1 text-[12px] text-info">Stock not deducted (materials costed through project issues)</div>}
          {d.direct_to_project ? <div className="mt-1 text-[12px] text-info">Delivered directly to project site - cost charged to project</div> : null}
        </Card>
        <Card title="Amounts">
          <Kv label="Net (excl. tax)">{moneyFull(d.net_total)}</Kv>
          {d.tax_total !== 0 && <Kv label="Sales tax">{moneyFull(d.tax_total)}</Kv>}
          <Kv label="Grand total"><span className="text-[16px] font-bold text-brand">{moneyFull(d.grand_total)}</span></Kv>
          {meta.financial && (
            <>
              <Kv label="Paid / settled">{moneyFull(d.paid)}</Kv>
              {d.returned > 0 && <Kv label="Returned">{moneyFull(d.returned)}</Kv>}
              <Kv label="Balance due"><span className={d.due > 0.5 ? 'font-bold text-bad' : 'text-ok'}>{moneyFull(d.due)}</span></Kv>
            </>
          )}
          {profit !== null && (
            <Kv label="Gross profit (on stock cost)" className="mt-1 border-t border-line pt-2">
              <span className={profit < 0 ? 'text-bad' : 'text-ok'}>{money(profit)} ({d.net_total > 0 ? ((profit / d.net_total) * 100).toFixed(1) : '0'}%)</span>
            </Kv>
          )}
        </Card>
      </div>

      <Card pad={false} title="Items">
        <table className="tbl">
          <thead>
            <tr>
              <th>#</th><th>Description</th><th className="text-right">Qty</th><th className="text-right">Rate</th><th className="text-right">Discount</th><th className="text-right">Tax</th><th className="text-right">Amount</th>
              {d.lines[0]?.unit_cost !== null && meta.stock !== 0 && <th className="text-right">Cost</th>}
            </tr>
          </thead>
          <tbody>
            {d.lines.map((l: any) => (
              <tr key={l.id}>
                <td className="text-muted">{l.line_no}</td>
                <td>
                  <div className="font-semibold">{l.description}</div>
                  {(l.brand || l.model) && l.description !== l.product_name && <div className="text-[12px] text-muted">{[l.brand, l.model].filter(Boolean).join(', ')}</div>}
                  {l.details && <div className="mt-0.5 max-w-[640px] text-[12.5px] leading-snug whitespace-pre-line text-ink/80">{l.details}</div>}
                  <div className="text-[12px] text-muted">
                    {[l.sku, l.serials && `S/N: ${l.serials}`, l.warranty && `Warranty: ${l.warranty}`, l.returned_qty > 0 && `Returned: ${qty(l.returned_qty)}`].filter(Boolean).join(', ')}
                  </div>
                </td>
                <td className="num text-right">{qty(l.qty)} {l.unit}</td>
                <td className="num text-right">{moneyFull(l.rate)}</td>
                <td className="num text-right">{l.discount_amt > 0 ? moneyFull(l.discount_amt) : '-'}</td>
                <td className="num text-right">{l.tax_amt > 0 ? `${moneyFull(l.tax_amt)} (${l.tax_rate}%)` : '-'}</td>
                <td className="num text-right font-semibold">{moneyFull(l.line_total)}</td>
                {l.unit_cost !== null && meta.stock !== 0 && <td className="num text-right text-muted">{money(l.cost_total)}</td>}
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {meta.financial && (
          <Card title="Payments" pad={false}>
            {d.payments.length === 0 ? (
              <div className="px-4 py-6 text-center text-[13px] text-muted">No payments recorded against this document.</div>
            ) : (
              <table className="tbl">
                <thead><tr><th>Voucher</th><th>Date</th><th>Account</th><th>Method</th><th className="text-right">Amount</th></tr></thead>
                <tbody>
                  {d.payments.map((p: any) => (
                    <tr key={p.payment_id} className="clickable" onClick={() => api('print.open', { kind: 'payment', id: p.payment_id })}>
                      <td className="font-medium">{p.number}</td><td>{date(p.date)}</td><td>{p.account_name}</td><td>{label(p.method)}</td><td className="num text-right">{money(p.amount)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>
        )}
        {(d.returns.length > 0 || d.converted.length > 0) && (
          <Card title="Linked documents" pad={false}>
            <table className="tbl">
              <tbody>
                {[...d.returns.map((r: any) => ({ ...r, doc_type: meta.side === 'sales' ? 'sale_return' : 'purchase_return' })), ...d.converted].map((r: any) => (
                  <tr key={r.id} className="clickable" onClick={() => nav(`/doc/${r.id}`)}>
                    <td>{DOC_TYPES[r.doc_type as DocType]?.label}</td><td className="font-medium">{r.number}</td><td>{date(r.date)}</td><td className="num text-right">{r.grand_total !== undefined ? money(r.grand_total) : ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        )}
        {(d.notes || d.terms) && (
          <Card title="Notes & terms">
            {d.notes && <div className="mb-2 text-[13px] whitespace-pre-wrap">{d.notes}</div>}
            {d.terms && <div className="text-[12.5px] whitespace-pre-wrap text-muted">{d.terms}</div>}
          </Card>
        )}
      </div>

      <div className="flex justify-end">
        <Button variant="ghost" size="sm" icon={<FileDown className="h-4 w-4" />} onClick={printDoc}>
          Save as PDF from the print preview
        </Button>
      </div>

      <PaymentModal
        open={payOpen}
        onClose={() => setPayOpen(false)}
        onSaved={() => reload()}
        preset={{ direction: settleDir, partyId: d.party_id, documentId: d.id, projectId: d.project_id, amount: d.due }}
      />
    </div>
  )
}
