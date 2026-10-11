import { useEffect, useState } from 'react'
import { api } from '../api'
import { InfoBox, Letterhead, PrintFooter, PrintTable, Sheet, Signatures, TemplateProps, TotalsBox, pd, pm, pq } from './PrintKit'
import { amountInWords, round2 } from '@shared/money'

/* eslint-disable @typescript-eslint/no-explicit-any */
const TITLES: Record<string, string> = {
  sale_invoice: 'Invoice',
  quotation: 'Quotation',
  sale_order: 'Sales Order',
  delivery_challan: 'Delivery Challan',
  sale_return: 'Credit Note',
  purchase_invoice: 'Purchase Invoice',
  purchase_order: 'Purchase Order',
  purchase_return: 'Debit Note'
}

/** Professional A4 template for every sales / purchase document. */
export function DocumentPrint({ id, ctx, setTitle }: TemplateProps): JSX.Element | null {
  const [d, setD] = useState<any>(null)
  const [err, setErr] = useState<string | null>(null)
  useEffect(() => {
    api<any>('docs.get', { id })
      .then((doc) => {
        setD(doc)
        setTitle(`${TITLES[doc.doc_type] ?? 'Document'} ${doc.number} - ${doc.party_master_name ?? doc.party_name ?? ''}`.trim())
      })
      .catch((e) => setErr(e.message))
  }, [id]) // eslint-disable-line react-hooks/exhaustive-deps
  if (err) return <div className="no-print mx-auto max-w-[210mm] rounded bg-red-100 p-4 text-red-800">{err}</div>
  if (!d) return null

  const ps = ctx.ps
  const t = d.doc_type as string
  const isSales = !t.startsWith('purchase')
  const isChallan = t === 'delivery_challan'
  const isQuote = t === 'quotation'
  const financial = ['sale_invoice', 'sale_return', 'purchase_invoice', 'purchase_return'].includes(t)
  const title = t === 'sale_invoice' && d.is_tax_invoice ? 'Sales Tax Invoice' : t === 'quotation' && d.is_tax_invoice ? 'Quotation (Tax)' : TITLES[t]
  const hasTax = ps.showTaxColumns === 'always' || (ps.showTaxColumns !== 'never' && (d.is_tax_invoice || d.lines.some((l: any) => l.tax_amt > 0)))
  const hasDisc = d.lines.some((l: any) => l.discount_amt > 0)
  const cancelled = d.status === 'cancelled'
  const paidFull = financial && !cancelled && d.due <= 0.5 && d.grand_total > 0
  const watermark = cancelled ? { text: 'CANCELLED', color: '#c53030' } : t === 'sale_invoice' && paidFull ? { text: 'PAID', color: '#2f855a' } : null

  const partyName = d.party_master_name ?? d.party_name ?? (isSales ? 'Walk-in Customer' : '—')
  const partyAddr = [d.party_master_address ?? d.party_address, d.party_city].filter(Boolean).join(', ')
  const partyPhone = d.party_master_phone ?? d.party_phone

  const meta: Array<[string, string]> = [
    [isQuote ? 'Quotation #' : isChallan ? 'Challan #' : 'Number', d.number],
    ['Date', pd(d.date)]
  ]
  if (d.due_date && financial) meta.push(['Due date', pd(d.due_date)])
  if (d.valid_until) meta.push(['Valid until', pd(d.valid_until)])
  if (d.ref_doc_number) meta.push([t.includes('return') ? 'Against' : 'Ref. doc', d.ref_doc_number])
  if (d.party_ref) meta.push([isSales ? 'Your ref.' : 'Supplier inv.', d.party_ref])

  const terms = d.terms || (financial && isSales ? ctx.firm.terms : isQuote ? ctx.firm.terms : null)
  const word = String(ctx.settings.currency_word ?? 'Rupees')
  const showPrev = ps.showPreviousBalance && financial && isSales && d.party_id && d.previous_balance !== null && t === 'sale_invoice'
  const colCount = 4 + (isChallan ? 0 : 2) + (hasDisc && !isChallan ? 1 : 0) + (hasTax && !isChallan ? 1 : 0)

  return (
    <Sheet ctx={ctx} watermark={watermark}>
      <Letterhead ctx={ctx} title={title} meta={meta} />

      <div className="mb-3 grid grid-cols-2 gap-3">
        <InfoBox title={isSales ? (isChallan ? 'Deliver To' : isQuote ? 'Prepared For' : 'Bill To') : 'Supplier'}>
          <div className="text-[12px] font-bold">{partyName}</div>
          {partyAddr && <div>{partyAddr}</div>}
          {partyPhone && <div>Phone: {partyPhone}</div>}
          {(d.party_ntn || d.party_strn || d.party_cnic) && (
            <div className="text-[10px] text-[#4a5568]">
              {[d.party_ntn && `NTN: ${d.party_ntn}`, d.party_strn && `STRN: ${d.party_strn}`, d.party_cnic && `CNIC: ${d.party_cnic}`].filter(Boolean).join(' · ')}
            </div>
          )}
        </InfoBox>
        {d.project_id ? (
          <InfoBox title="Solar Project">
            <div className="text-[12px] font-bold">{d.project_name}</div>
            <div>
              Project # {d.project_code}
              {d.project_capacity ? ` · System size ${pq(d.project_capacity)} kW` : ''}
            </div>
            {d.project_site && <div>Site: {d.project_site}</div>}
          </InfoBox>
        ) : (
          <InfoBox title="Details">
            <div className="grid grid-cols-[auto_1fr] gap-x-3">
              <span className="text-[#4a5568]">Prepared by</span>
              <span>{d.created_by_name ?? '—'}</span>
              {d.warehouse_name && !isQuote && (
                <>
                  <span className="text-[#4a5568]">Warehouse</span>
                  <span>{d.warehouse_name}</span>
                </>
              )}
              {financial && (
                <>
                  <span className="text-[#4a5568]">Status</span>
                  <span className="font-semibold">{cancelled ? 'Cancelled' : d.due <= 0.5 ? 'Paid' : d.paid > 0 ? 'Partially paid' : 'Unpaid'}</span>
                </>
              )}
            </div>
          </InfoBox>
        )}
      </div>

      <PrintTable
        head={
          <>
            <th style={{ width: 26 }}>#</th>
            <th>Description</th>
            <th style={{ width: 62 }} className="!text-right">Qty</th>
            <th style={{ width: 42 }}>Unit</th>
            {!isChallan && <th style={{ width: 80 }} className="!text-right">Rate</th>}
            {!isChallan && hasDisc && <th style={{ width: 66 }} className="!text-right">Disc.</th>}
            {!isChallan && hasTax && <th style={{ width: 74 }} className="!text-right">Tax</th>}
            {!isChallan && <th style={{ width: 92 }} className="!text-right">Amount</th>}
          </>
        }
      >
        {d.lines.map((l: any, i: number) => (
          <tr key={l.id}>
            <td className="text-[#718096]">{i + 1}</td>
            <td>
              <div className="font-semibold">{l.description}</div>
              {(l.brand || l.model) && l.description !== l.product_name && <div className="text-[9.5px] text-[#4a5568]">{[l.brand, l.model].filter(Boolean).join(' · ')}</div>}
              {ps.showSerials && l.serials && <div className="text-[9.5px] text-[#4a5568]">S/N: {l.serials}</div>}
              {ps.showWarranty && l.warranty && isSales && <div className="text-[9.5px] font-medium" style={{ color: 'var(--pc)' }}>Warranty: {l.warranty}</div>}
            </td>
            <td className="num text-right">{pq(l.qty)}</td>
            <td>{l.unit ?? ''}</td>
            {!isChallan && <td className="num text-right">{pm(ctx, l.rate, 2)}</td>}
            {!isChallan && hasDisc && <td className="num text-right">{l.discount_amt > 0 ? pm(ctx, l.discount_amt, 2) : '—'}</td>}
            {!isChallan && hasTax && (
              <td className="num text-right">
                {l.tax_amt > 0 ? (
                  <>
                    {pm(ctx, l.tax_amt, 2)}
                    <div className="text-[9px] text-[#718096]">@{l.tax_rate}%</div>
                  </>
                ) : (
                  '—'
                )}
              </td>
            )}
            {!isChallan && <td className="num text-right font-semibold">{pm(ctx, l.line_total, 2)}</td>}
          </tr>
        ))}
        {d.lines.length < 4 &&
          Array.from({ length: 4 - d.lines.length }).map((_, i) => (
            <tr key={`pad${i}`}>
              <td colSpan={colCount} className="h-6" />
            </tr>
          ))}
      </PrintTable>

      {isChallan ? (
        <div className="avoid-break mt-3 text-[10.5px]">
          Total items: <b>{d.lines.length}</b> · Total quantity: <b>{pq(d.lines.reduce((a: number, l: any) => a + l.qty, 0))}</b>
          <div className="mt-1 text-[#4a5568]">Goods received in good condition. Please check all items and serial numbers at the time of delivery.</div>
        </div>
      ) : (
        <div className="avoid-break mt-3 grid grid-cols-[1fr_270px] gap-5">
          <div className="space-y-2.5 text-[10.5px]">
            {ps.showAmountInWords && (
              <div className="rounded-md bg-[#f7f9fc] px-2.5 py-2">
                <div className="text-[9px] font-bold tracking-wider text-[#718096] uppercase">Amount in words</div>
                <div className="font-semibold">{amountInWords(d.grand_total, word)}</div>
              </div>
            )}
            {ps.showBankDetails && ctx.firm.bank_details && isSales && !t.includes('return') && (
              <div>
                <div className="text-[9px] font-bold tracking-wider text-[#718096] uppercase">Bank details for payment</div>
                <div className="whitespace-pre-line">{ctx.firm.bank_details}</div>
              </div>
            )}
            {d.notes && (
              <div>
                <div className="text-[9px] font-bold tracking-wider text-[#718096] uppercase">Notes</div>
                <div className="whitespace-pre-line">{d.notes}</div>
              </div>
            )}
            {financial && d.payments?.length > 0 && (
              <div>
                <div className="text-[9px] font-bold tracking-wider text-[#718096] uppercase">Payments received</div>
                {d.payments.map((p: any) => (
                  <div key={p.payment_id}>
                    {pd(p.date)} · {p.number} · {p.method?.replace('_', ' ')}
                    {p.reference ? ` (${p.reference})` : ''} — <b>{pm(ctx, p.amount)}</b>
                  </div>
                ))}
              </div>
            )}
          </div>
          <div className="overflow-hidden rounded-md border border-[#e2e8f0]">
            <TotalsBox
              rows={[
                { label: 'Subtotal', value: pm(ctx, d.subtotal, 2) },
                d.line_discount_total > 0 && { label: 'Item discounts', value: `- ${pm(ctx, d.line_discount_total, 2)}` },
                d.doc_discount > 0 && { label: 'Discount', value: `- ${pm(ctx, d.doc_discount, 2)}` },
                d.other_charges !== 0 && { label: d.other_charges_label || 'Other charges', value: pm(ctx, d.other_charges, 2) },
                d.tax_total !== 0 && { label: 'Sales tax', value: pm(ctx, d.tax_total, 2) },
                d.round_off !== 0 && { label: 'Round off', value: pm(ctx, d.round_off, 2) },
                { label: `Total (${ctx.settings.currency_symbol ?? 'Rs.'})`, value: pm(ctx, d.grand_total, 2), accent: true },
                financial && !cancelled && d.paid > 0 && { label: t.includes('return') ? 'Settled' : 'Paid / advance', value: pm(ctx, d.paid, 2) },
                financial && !cancelled && d.returned > 0 && { label: 'Returned', value: pm(ctx, d.returned, 2) },
                financial && !cancelled && { label: 'Balance due', value: pm(ctx, d.due, 2), strong: true, danger: d.due > 0.5 },
                showPrev && { label: 'Previous balance', value: pm(ctx, d.previous_balance, 2) },
                showPrev && { label: 'Total account balance', value: pm(ctx, round2(d.previous_balance + d.due), 2), strong: true }
              ]}
            />
          </div>
        </div>
      )}

      {terms && (
        <div className="avoid-break mt-4 text-[9.8px] leading-relaxed">
          <div className="mb-0.5 text-[9px] font-bold tracking-wider text-[#718096] uppercase">Terms &amp; conditions</div>
          <ol className="list-decimal pl-4 text-[#2d3748]">
            {String(terms)
              .split(/\n+/)
              .map((s) => s.replace(/^\s*(\d+[.)]|[-•*])\s*/, '').trim())
              .filter(Boolean)
              .map((s, i) => (
                <li key={i}>{s}</li>
              ))}
          </ol>
        </div>
      )}

      <Signatures
        ctx={ctx}
        left={isChallan ? 'Received by (name & signature)' : isSales ? ps.receiverLabel : 'Received by'}
        right={isChallan ? 'Delivered by / Authorized Signature' : ps.signatureLabel}
        showReceiver={isSales || t === 'purchase_order'}
      />
      <PrintFooter ctx={ctx} />
    </Sheet>
  )
}
