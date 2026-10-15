import { useEffect, useState } from 'react'
import { api } from '../api'
import { today } from '../lib/format'
import { DOC_TYPES, DocType, PAYMENT_METHOD_LABELS } from '@shared/docTypes'
import { amountInWords, round2 } from '@shared/money'
import { CompactHeader, InfoBox, Letterhead, ModernHeader, PrintFooter, PrintTable, Sheet, Signatures, TemplateProps, pd, pm, pmSym } from './PrintKit'
import { firmOptions } from './design'
import { ThermalPayment } from './ThermalPrint'

/* eslint-disable @typescript-eslint/no-explicit-any */
const ALLOC_TYPES: Record<string, string> = {
  sale_invoice: 'Sales Invoice',
  sale_return: 'Credit Note',
  purchase_invoice: 'Purchase Invoice',
  purchase_return: 'Debit Note'
}

function allocType(a: any): string {
  if (a.expense_id) return 'Expense bill'
  return ALLOC_TYPES[a.doc_type] ?? DOC_TYPES[a.doc_type as DocType]?.label ?? 'Document'
}

/**
 * Payment Receipt (money in) / Payment Voucher (money out) — compact, half-page when short.
 * Layouts: classic / modern / compact (A4) and thermal80 (80 mm receipt); the template options decide what is shown.
 */
export function PaymentPrint({ id, ctx, setTitle, design, onKind, data }: TemplateProps): JSX.Element | null {
  const [p, setP] = useState<any>(data ?? null)
  const [err, setErr] = useState<string | null>(null)
  useEffect(() => {
    if (data) {
      setP(data)
      return
    }
    api<any>('payments.get', { id })
      .then((r) => {
        setP(r)
        setTitle(`${r.direction === 'in' ? 'Payment Receipt' : 'Payment Voucher'} ${r.number}${r.party_name ? ` - ${r.party_name}` : ''}`)
        onKind?.('payment')
      })
      .catch((e) => setErr(e.message))
  }, [id, data]) // eslint-disable-line react-hooks/exhaustive-deps
  if (err) return <div className="no-print mx-auto max-w-[210mm] rounded bg-red-100 p-4 text-red-800">{err}</div>
  if (!p || design === null) return null

  const o = design?.options ?? firmOptions(ctx.ps)
  const layout = design?.layout ?? 'classic'
  if (layout === 'thermal80') return <ThermalPayment p={p} ctx={ctx} o={o} />
  const compact = layout === 'compact'
  const isIn = p.direction === 'in'
  const title = o.titleOverride?.trim() || (isIn ? 'Payment Receipt' : 'Payment Voucher')
  const subtitle = isIn ? 'Acknowledgement of money received' : 'Record of money paid'
  const cancelled = p.status === 'cancelled'
  const allocations: any[] = p.allocations ?? []
  const allocated = round2(allocations.reduce((a, r) => a + Number(r.amount || 0), 0))
  // Computed from the document itself so a cancelled voucher still prints its original split.
  const unallocated = round2(Number(p.amount) - allocated)
  const word = String(ctx.settings.currency_word ?? 'Rupees')
  const method = PAYMENT_METHOD_LABELS[p.method] ?? String(p.method ?? '').replace(/_/g, ' ')
  const bal = p.party_balance === null || p.party_balance === undefined ? null : Number(p.party_balance)

  const meta: Array<[string, string]> = [
    [isIn ? 'Receipt #' : 'Voucher #', p.number],
    ['Date', pd(p.date)]
  ]
  if (cancelled) meta.push(['Status', 'Cancelled'])

  const details: Array<[string, string]> = [
    ['Payment method', method || '—'],
    [p.method === 'cheque' ? 'Cheque / ref. #' : 'Reference', p.reference || '—'],
    [isIn ? 'Deposited to' : 'Paid from', p.account_name ? `${p.account_name}${p.account_type ? ` (${p.account_type === 'bank' ? 'Bank' : p.account_type === 'wallet' ? 'Wallet' : 'Cash'})` : ''}` : '—']
  ]
  if (p.project_id) details.push(['Project', [p.project_code, p.project_name].filter(Boolean).join(' · ')])
  if (p.created_by_name) details.push(['Prepared by', p.created_by_name])

  return (
    <Sheet ctx={ctx} watermark={cancelled ? { text: 'CANCELLED', color: '#c53030' } : null} accent={o.accentColor} className={compact ? '!text-[10px]' : undefined}>
      {layout === 'modern' ? (
        <ModernHeader ctx={ctx} title={title} subtitle={subtitle} number={p.number} date={pd(p.date)} showLogo={o.showLogo} />
      ) : compact ? (
        <div className="mb-2">
          <CompactHeader ctx={ctx} title={title} number={p.number} date={pd(p.date)} showLogo={o.showLogo} />
        </div>
      ) : (
        <Letterhead ctx={ctx} title={title} subtitle={subtitle} meta={meta} showLogo={o.showLogo} />
      )}

      <div className={`${compact ? 'mb-2' : 'mb-3'} grid grid-cols-[1fr_300px] gap-3`}>
        <InfoBox title={isIn ? 'Received From' : 'Paid To'}>
          <div className="text-[12.5px] font-bold">{p.party_name ?? (isIn ? 'Walk-in / cash receipt' : 'Cash payment')}</div>
          {p.party_address && <div>{p.party_address}</div>}
          {p.party_phone && <div>Phone: {p.party_phone}</div>}
          {p.party_type && <div className="text-[9.5px] text-[#718096]">{p.party_type === 'both' ? 'Customer & supplier' : p.party_type === 'supplier' ? 'Supplier' : 'Customer'}</div>}
        </InfoBox>
        <div className="avoid-break flex flex-col justify-center rounded-md border-2 px-3 py-2 text-center" style={{ borderColor: 'var(--pc)', background: 'color-mix(in srgb, var(--pc) 7%, #fff)' }}>
          <div className="text-[9.5px] font-bold tracking-wider text-[#4a5568] uppercase">{isIn ? 'Amount Received' : 'Amount Paid'}</div>
          <div className={`num ${compact ? 'text-[20px]' : 'text-[26px]'} leading-tight font-black`} style={{ color: 'var(--pc)' }}>{pmSym(ctx, p.amount, 2)}</div>
          {o.showAmountInWords && <div className="mt-0.5 text-[9.8px] leading-snug font-semibold text-[#2d3748]">{amountInWords(p.amount, word)}</div>}
        </div>
      </div>

      <div className="avoid-break mb-3 grid grid-cols-3 gap-x-4 gap-y-1.5 rounded-md bg-[#f7f9fc] px-3 py-2 text-[10.5px]">
        {details.map(([k, v]) => (
          <div key={k} className="min-w-0">
            <div className="text-[8.8px] font-bold tracking-wider text-[#718096] uppercase">{k}</div>
            <div className="font-semibold break-words">{v}</div>
          </div>
        ))}
      </div>

      {allocations.length > 0 ? (
        <>
          <div className="mb-1 text-[9px] font-bold tracking-wider text-[#718096] uppercase">{isIn ? 'Settled against' : 'Paid against'}</div>
          <PrintTable
            head={
              <>
                <th style={{ width: 26 }}>#</th>
                <th>Document</th>
                <th style={{ width: 120 }}>Type</th>
                <th style={{ width: 84 }}>Doc. date</th>
                <th style={{ width: 96 }} className="!text-right">Doc. total</th>
                <th style={{ width: 100 }} className="!text-right">Amount settled</th>
              </>
            }
          >
            {allocations.map((a, i) => (
              <tr key={a.id ?? i}>
                <td className="text-[#718096]">{i + 1}</td>
                <td className="font-semibold">{a.document_number ?? a.expense_number ?? '—'}</td>
                <td>{allocType(a)}</td>
                <td>{a.document_date ? pd(a.document_date) : '—'}</td>
                <td className="num text-right">{a.document_total !== null && a.document_total !== undefined ? pm(ctx, a.document_total, 2) : '—'}</td>
                <td className="num text-right font-semibold">{pm(ctx, a.amount, 2)}</td>
              </tr>
            ))}
            <tr>
              <td colSpan={5} className="text-right font-bold" style={{ background: '#eef2f7' }}>Total settled</td>
              <td className="num text-right font-bold" style={{ background: '#eef2f7' }}>{pm(ctx, allocated, 2)}</td>
            </tr>
            {unallocated > 0.005 && (
              <tr>
                <td colSpan={5} className="text-right font-semibold" style={{ background: '#fff' }}>Unallocated (advance / on account)</td>
                <td className="num text-right font-semibold" style={{ background: '#fff' }}>{pm(ctx, unallocated, 2)}</td>
              </tr>
            )}
          </PrintTable>
        </>
      ) : (
        <div className="avoid-break rounded-md border border-dashed border-[#cbd5e0] px-3 py-1.5 text-[10.5px]">
          <b>Unallocated (advance):</b> {pm(ctx, unallocated, 2)} — {isIn ? 'kept on account / as advance against future invoices.' : 'paid on account / as advance against future bills.'}
        </div>
      )}

      <div className="avoid-break mt-3 grid grid-cols-[1fr_300px] gap-3 text-[10.5px]">
        <div className="space-y-2">
          {o.showNotes && p.notes && (
            <div>
              <div className="text-[9px] font-bold tracking-wider text-[#718096] uppercase">Notes</div>
              <div className="whitespace-pre-line">{p.notes}</div>
            </div>
          )}
          {cancelled && (
            <div className="rounded-md bg-[#fff5f5] px-2.5 py-1.5 text-[#c53030]">
              <b>This {isIn ? 'receipt' : 'voucher'} has been cancelled</b>
              {p.cancelled_at ? ` on ${pd(p.cancelled_at)}` : ''}
              {p.cancel_reason ? ` — ${p.cancel_reason}` : ''}. It has no effect on the account.
            </div>
          )}
        </div>
        {bal !== null && !cancelled && (
          <div className="overflow-hidden rounded-md border border-[#e2e8f0]">
            <div className="flex items-center justify-between px-2.5 py-1.5 text-white" style={{ background: 'var(--pc)' }}>
              <span className="text-[10.5px] font-bold">Account balance</span>
              <span className="num text-[12.5px] font-bold">{pm(ctx, Math.abs(bal), 2)}</span>
            </div>
            <div className="px-2.5 py-1 text-[9.5px] text-[#4a5568]">
              {Math.abs(bal) < 0.005 ? 'Account fully settled' : bal > 0 ? '(Receivable) — balance due from the party' : '(Payable) — balance due to the party'}
              {` · including this payment, as on ${pd(today())}`}
            </div>
          </div>
        )}
      </div>

      <Signatures
        ctx={ctx}
        compact={compact}
        left={isIn ? 'Paid by (depositor signature)' : 'Received by (payee signature)'}
        right={isIn ? 'Received by / Authorized Signature' : ctx.ps.signatureLabel}
        showReceiver={o.showCustomerSignature}
        showSignature={o.showAuthorisedSignature}
        showStamp={o.showStamp}
      />
      <PrintFooter ctx={ctx} note={o.footerNote || undefined} className={compact ? '!mt-3' : undefined} />
    </Sheet>
  )
}
