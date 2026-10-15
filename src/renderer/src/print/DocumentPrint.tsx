import { ReactNode, useEffect, useState } from 'react'
import { api } from '../api'
import { CompactHeader, InfoBox, Letterhead, ModernHeader, PrintContext, PrintFooter, PrintTable, Sheet, Signatures, TemplateProps, TotalsBox, pd, pm, pq } from './PrintKit'
import { TemplateOptions, firmOptions } from './design'
import { ThermalDocument } from './ThermalPrint'
import { amountInWords, round2 } from '@shared/money'

/* eslint-disable @typescript-eslint/no-explicit-any */
export const DOC_TITLES: Record<string, string> = {
  sale_invoice: 'Invoice',
  quotation: 'Quotation',
  sale_order: 'Sales Order',
  delivery_challan: 'Delivery Challan',
  sale_return: 'Credit Note',
  purchase_invoice: 'Purchase Invoice',
  purchase_order: 'Purchase Order',
  purchase_return: 'Debit Note'
}

/** Everything a layout needs, computed once from the document + the chosen options. */
export interface DocView {
  d: any
  t: string
  o: TemplateOptions
  isSales: boolean
  isChallan: boolean
  isQuote: boolean
  isReturn: boolean
  financial: boolean
  cancelled: boolean
  title: string
  hasTax: boolean
  hasDisc: boolean
  watermark: { text: string; color: string } | null
  partyLabel: string
  partyName: string
  partyAddr: string
  partyPhone: string | null
  meta: Array<[string, string]>
  terms: string | null
  word: string
  showPrev: boolean
  statusText: string
}

export function buildDocView(d: any, ctx: PrintContext, o: TemplateOptions): DocView {
  const ps = ctx.ps
  const t = d.doc_type as string
  const isSales = !t.startsWith('purchase')
  const isChallan = t === 'delivery_challan'
  const isQuote = t === 'quotation'
  const isReturn = t.includes('return')
  const financial = ['sale_invoice', 'sale_return', 'purchase_invoice', 'purchase_return'].includes(t)
  const baseTitle = t === 'sale_invoice' && d.is_tax_invoice ? 'Sales Tax Invoice' : t === 'quotation' && d.is_tax_invoice ? 'Quotation (Tax)' : DOC_TITLES[t]
  const docHasTax = !!d.is_tax_invoice || d.lines.some((l: any) => l.tax_amt > 0)
  const hasTax = !isChallan && o.showTax && (ps.showTaxColumns === 'always' || docHasTax)
  const hasDisc = !isChallan && o.showDiscount && d.lines.some((l: any) => l.discount_amt > 0)
  const cancelled = d.status === 'cancelled'
  const paidFull = financial && !cancelled && d.due <= 0.5 && d.grand_total > 0
  const watermark = cancelled ? { text: 'CANCELLED', color: '#c53030' } : t === 'sale_invoice' && paidFull ? { text: 'PAID', color: '#2f855a' } : null
  const meta: Array<[string, string]> = [
    [isQuote ? 'Quotation #' : isChallan ? 'Challan #' : 'Number', d.number],
    ['Date', pd(d.date)]
  ]
  if (d.due_date && financial) meta.push(['Due date', pd(d.due_date)])
  if (d.valid_until) meta.push(['Valid until', pd(d.valid_until)])
  if (d.ref_doc_number) meta.push([isReturn ? 'Against' : 'Ref. doc', d.ref_doc_number])
  if (d.party_ref) meta.push([isSales ? 'Your ref.' : 'Supplier inv.', d.party_ref])
  const terms = o.showTerms ? d.terms || ((financial && isSales) || isQuote ? ctx.firm.terms : null) || null : null
  return {
    d,
    t,
    o,
    isSales,
    isChallan,
    isQuote,
    isReturn,
    financial,
    cancelled,
    title: o.titleOverride?.trim() || baseTitle,
    hasTax,
    hasDisc,
    watermark,
    partyLabel: isSales ? (isChallan ? 'Deliver To' : isQuote ? 'Prepared For' : 'Bill To') : 'Supplier',
    partyName: d.party_master_name ?? d.party_name ?? (isSales ? 'Walk-in Customer' : '—'),
    partyAddr: [d.party_master_address ?? d.party_address, d.party_city].filter(Boolean).join(', '),
    partyPhone: d.party_master_phone ?? d.party_phone ?? null,
    meta,
    terms,
    word: String(ctx.settings.currency_word ?? 'Rupees'),
    showPrev: o.showPreviousBalance && t === 'sale_invoice' && !!d.party_id && d.previous_balance !== null && d.previous_balance !== undefined,
    statusText: cancelled ? 'Cancelled' : d.due <= 0.5 ? 'Paid' : d.paid > 0 ? 'Partially paid' : 'Unpaid'
  }
}

/** Item name in bold with the item description (and brand / model, serials, warranty) beneath it. */
export function ItemCell({ l, v, size = 'md' }: { l: any; v: DocView; size?: 'md' | 'sm' }): JSX.Element {
  const o = v.o
  const sub = size === 'sm' ? 'text-[8.6px]' : 'text-[9.5px]'
  return (
    <>
      <div className="font-bold">{l.description}</div>
      {o.showBrandModel && (l.brand || l.model) && l.description !== l.product_name && <div className={`${sub} text-[#4a5568]`}>{[l.brand, l.model].filter(Boolean).join(' · ')}</div>}
      {o.showDescription && l.details && (
        <div className={`${size === 'sm' ? 'text-[8.8px]' : 'text-[9.8px]'} leading-snug whitespace-pre-line text-[#2d3748]`} data-item-details="1">
          {l.details}
        </div>
      )}
      {o.showSerials && l.serials && <div className={`${sub} text-[#4a5568]`}>S/N: {l.serials}</div>}
      {o.showWarranty && l.warranty && v.isSales && <div className={`${sub} font-medium`} style={{ color: 'var(--pc)' }}>Warranty: {l.warranty}</div>}
    </>
  )
}

function totalsRows(v: DocView, ctx: PrintContext): Parameters<typeof TotalsBox>[0]['rows'] {
  const d = v.d
  return [
    { label: 'Subtotal', value: pm(ctx, d.subtotal, 2) },
    d.line_discount_total > 0 && { label: 'Item discounts', value: `- ${pm(ctx, d.line_discount_total, 2)}` },
    d.doc_discount > 0 && { label: 'Discount', value: `- ${pm(ctx, d.doc_discount, 2)}` },
    d.other_charges !== 0 && { label: d.other_charges_label || 'Other charges', value: pm(ctx, d.other_charges, 2) },
    d.tax_total !== 0 && { label: 'Sales tax', value: pm(ctx, d.tax_total, 2) },
    d.round_off !== 0 && { label: 'Round off', value: pm(ctx, d.round_off, 2) },
    { label: `Total (${ctx.settings.currency_symbol ?? 'Rs.'})`, value: pm(ctx, d.grand_total, 2), accent: true },
    v.financial && !v.cancelled && d.paid > 0 && { label: v.isReturn ? 'Settled' : 'Paid / advance', value: pm(ctx, d.paid, 2) },
    v.financial && !v.cancelled && d.returned > 0 && { label: 'Returned', value: pm(ctx, d.returned, 2) },
    v.financial && !v.cancelled && { label: 'Balance due', value: pm(ctx, d.due, 2), strong: true, danger: d.due > 0.5 },
    v.showPrev && { label: 'Previous balance', value: pm(ctx, d.previous_balance, 2) },
    v.showPrev && { label: 'Total account balance', value: pm(ctx, round2(d.previous_balance + d.due), 2), strong: true }
  ]
}

function Caption({ children }: { children: ReactNode }): JSX.Element {
  return <div className="text-[9px] font-bold tracking-wider text-[#718096] uppercase">{children}</div>
}

/** Amount in words, bank details, notes and payments (left of the totals). */
function SideNotes({ v, ctx, size = 'md' }: { v: DocView; ctx: PrintContext; size?: 'md' | 'sm' }): JSX.Element {
  const d = v.d
  const o = v.o
  return (
    <div className={`${size === 'sm' ? 'space-y-1.5 text-[9.5px]' : 'space-y-2.5 text-[10.5px]'}`}>
      {o.showAmountInWords && (
        <div className="rounded-md bg-[#f7f9fc] px-2.5 py-2">
          <Caption>Amount in words</Caption>
          <div className="font-semibold">{amountInWords(d.grand_total, v.word)}</div>
        </div>
      )}
      {o.showBankDetails && ctx.firm.bank_details && v.isSales && !v.isReturn && (
        <div>
          <Caption>Bank details for payment</Caption>
          <div className="whitespace-pre-line">{ctx.firm.bank_details}</div>
        </div>
      )}
      {o.showNotes && d.notes && (
        <div>
          <Caption>Notes</Caption>
          <div className="whitespace-pre-line">{d.notes}</div>
        </div>
      )}
      {v.financial && d.payments?.length > 0 && (
        <div>
          <Caption>Payments received</Caption>
          {d.payments.map((p: any) => (
            <div key={p.payment_id}>
              {pd(p.date)} · {p.number} · {p.method?.replace('_', ' ')}
              {p.reference ? ` (${p.reference})` : ''} — <b>{pm(ctx, p.amount)}</b>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function Terms({ v, size = 'md' }: { v: DocView; size?: 'md' | 'sm' }): JSX.Element | null {
  if (!v.terms) return null
  return (
    <div className={`avoid-break ${size === 'sm' ? 'mt-2.5 text-[8.8px]' : 'mt-4 text-[9.8px]'} leading-relaxed`}>
      <div className="mb-0.5 text-[9px] font-bold tracking-wider text-[#718096] uppercase">Terms &amp; conditions</div>
      <ol className="list-decimal pl-4 text-[#2d3748]">
        {String(v.terms)
          .split(/\n+/)
          .map((s) => s.replace(/^\s*(\d+[.)]|[-•*])\s*/, '').trim())
          .filter(Boolean)
          .map((s, i) => (
            <li key={i}>{s}</li>
          ))}
      </ol>
    </div>
  )
}

function DocSignatures({ v, ctx, compact }: { v: DocView; ctx: PrintContext; compact?: boolean }): JSX.Element {
  const ps = ctx.ps
  return (
    <Signatures
      ctx={ctx}
      compact={compact}
      left={v.isChallan ? 'Received by (name & signature)' : v.isSales ? ps.receiverLabel : 'Received by'}
      right={v.isChallan ? 'Delivered by / Authorized Signature' : ps.signatureLabel}
      showReceiver={(v.isSales || v.t === 'purchase_order') && v.o.showCustomerSignature}
      showSignature={v.o.showAuthorisedSignature}
      showStamp={v.o.showStamp}
    />
  )
}

/** Items table shared by the A4 layouts. */
function ItemsTable({ v, ctx, variant }: { v: DocView; ctx: PrintContext; variant: 'classic' | 'modern' | 'compact' }): JSX.Element {
  const d = v.d
  const o = v.o
  const money = !v.isChallan
  const colCount = 3 + (o.showUnit ? 1 : 0) + (money ? 2 : 0) + (v.hasDisc ? 1 : 0) + (v.hasTax ? 1 : 0)
  const head = (
    <>
      <th style={{ width: variant === 'compact' ? 20 : 26 }}>#</th>
      <th>Item &amp; description</th>
      <th style={{ width: variant === 'compact' ? 50 : 62 }} className="!text-right">Qty</th>
      {o.showUnit && <th style={{ width: 42 }}>Unit</th>}
      {money && <th style={{ width: 80 }} className="!text-right">Rate</th>}
      {v.hasDisc && <th style={{ width: 66 }} className="!text-right">Disc.</th>}
      {v.hasTax && <th style={{ width: 74 }} className="!text-right">Tax</th>}
      {money && <th style={{ width: 92 }} className="!text-right">Amount</th>}
    </>
  )
  const rows = (
    <>
      {d.lines.map((l: any, i: number) => (
        <tr key={l.id}>
          <td className="text-[#718096]">{i + 1}</td>
          <td>
            <ItemCell l={l} v={v} size={variant === 'compact' ? 'sm' : 'md'} />
          </td>
          <td className="num text-right">{pq(l.qty)}</td>
          {o.showUnit && <td>{l.unit ?? ''}</td>}
          {money && <td className="num text-right">{pm(ctx, l.rate, 2)}</td>}
          {v.hasDisc && <td className="num text-right">{l.discount_amt > 0 ? pm(ctx, l.discount_amt, 2) : '—'}</td>}
          {v.hasTax && (
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
          {money && <td className="num text-right font-semibold">{pm(ctx, l.line_total, 2)}</td>}
        </tr>
      ))}
      {variant !== 'compact' &&
        d.lines.length < 4 &&
        Array.from({ length: 4 - d.lines.length }).map((_, i) => (
          <tr key={`pad${i}`}>
            <td colSpan={colCount} className="h-6" />
          </tr>
        ))}
    </>
  )
  if (variant === 'classic') return <PrintTable head={head}>{rows}</PrintTable>
  if (variant === 'modern') {
    return (
      <table className="doc-table doc-modern">
        <thead>
          <tr className="text-[#1b2333]" style={{ borderBottom: '2px solid var(--pc)' }}>{head}</tr>
        </thead>
        <tbody>{rows}</tbody>
      </table>
    )
  }
  return (
    <table className="doc-table doc-compact text-[9.6px] [&_td]:!px-[5px] [&_td]:!py-[3px] [&_th]:!px-[5px] [&_th]:!py-[4px] [&_th]:!text-[9px]">
      <thead>
        <tr className="text-white" style={{ background: 'var(--pc)' }}>{head}</tr>
      </thead>
      <tbody className="[&>tr:nth-child(even)>td]:bg-[#f7f9fc]">{rows}</tbody>
    </table>
  )
}

function ChallanSummary({ v }: { v: DocView }): JSX.Element {
  const d = v.d
  return (
    <div className="avoid-break mt-3 text-[10.5px]">
      Total items: <b>{d.lines.length}</b> · Total quantity: <b>{pq(d.lines.reduce((a: number, l: any) => a + l.qty, 0))}</b>
      <div className="mt-1 text-[#4a5568]">Goods received in good condition. Please check all items and serial numbers at the time of delivery.</div>
    </div>
  )
}

/* ------------------------------------------ Classic ------------------------------------------ */
function ClassicLayout({ v, ctx }: { v: DocView; ctx: PrintContext }): JSX.Element {
  const d = v.d
  return (
    <Sheet ctx={ctx} watermark={v.watermark} accent={v.o.accentColor}>
      <Letterhead ctx={ctx} title={v.title} meta={v.meta} showLogo={v.o.showLogo} />
      <div className="mb-3 grid grid-cols-2 gap-3">
        <InfoBox title={v.partyLabel}>
          <PartyLines v={v} />
        </InfoBox>
        {d.project_id ? (
          <InfoBox title="Solar Project">
            <ProjectLines d={d} />
          </InfoBox>
        ) : (
          <InfoBox title="Details">
            <DetailsGrid v={v} />
          </InfoBox>
        )}
      </div>
      <ItemsTable v={v} ctx={ctx} variant="classic" />
      {v.isChallan ? (
        <ChallanSummary v={v} />
      ) : (
        <div className="avoid-break mt-3 grid grid-cols-[1fr_270px] gap-5">
          <SideNotes v={v} ctx={ctx} />
          <div className="overflow-hidden rounded-md border border-[#e2e8f0]">
            <TotalsBox rows={totalsRows(v, ctx)} />
          </div>
        </div>
      )}
      {v.isChallan && v.o.showNotes && d.notes && (
        <div className="avoid-break mt-3 text-[10.5px]">
          <Caption>Notes</Caption>
          <div className="whitespace-pre-line">{d.notes}</div>
        </div>
      )}
      <Terms v={v} />
      <DocSignatures v={v} ctx={ctx} />
      <PrintFooter ctx={ctx} note={v.o.footerNote || undefined} />
    </Sheet>
  )
}

function PartyLines({ v }: { v: DocView }): JSX.Element {
  const d = v.d
  return (
    <>
      <div className="text-[12px] font-bold">{v.partyName}</div>
      {v.partyAddr && <div>{v.partyAddr}</div>}
      {v.partyPhone && <div>Phone: {v.partyPhone}</div>}
      {(d.party_ntn || d.party_strn || d.party_cnic) && (
        <div className="text-[10px] text-[#4a5568]">
          {[d.party_ntn && `NTN: ${d.party_ntn}`, d.party_strn && `STRN: ${d.party_strn}`, d.party_cnic && `CNIC: ${d.party_cnic}`].filter(Boolean).join(' · ')}
        </div>
      )}
    </>
  )
}

function ProjectLines({ d }: { d: any }): JSX.Element {
  return (
    <>
      <div className="text-[12px] font-bold">{d.project_name}</div>
      <div>
        Project # {d.project_code}
        {d.project_capacity ? ` · System size ${pq(d.project_capacity)} kW` : ''}
      </div>
      {d.project_site && <div>Site: {d.project_site}</div>}
    </>
  )
}

function DetailsGrid({ v }: { v: DocView }): JSX.Element {
  const d = v.d
  return (
    <div className="grid grid-cols-[auto_1fr] gap-x-3">
      <span className="text-[#4a5568]">Prepared by</span>
      <span>{d.created_by_name ?? '—'}</span>
      {d.warehouse_name && !v.isQuote && (
        <>
          <span className="text-[#4a5568]">Warehouse</span>
          <span>{d.warehouse_name}</span>
        </>
      )}
      {v.financial && (
        <>
          <span className="text-[#4a5568]">Status</span>
          <span className="font-semibold">{v.statusText}</span>
        </>
      )}
    </div>
  )
}

/* ------------------------------------------ Modern ------------------------------------------ */
function ModernLayout({ v, ctx }: { v: DocView; ctx: PrintContext }): JSX.Element {
  const d = v.d
  return (
    <Sheet ctx={ctx} watermark={v.watermark} accent={v.o.accentColor}>
      <ModernHeader ctx={ctx} title={v.title} number={d.number} date={pd(d.date)} showLogo={v.o.showLogo} />

      <div className="avoid-break mb-4 grid grid-cols-[1.3fr_1fr_1fr] gap-5 text-[10.5px] leading-snug">
        <div>
          <div className="mb-1 text-[9px] font-bold tracking-[0.12em] uppercase" style={{ color: 'var(--pc)' }}>{v.partyLabel}</div>
          <PartyLines v={v} />
        </div>
        <div>
          <div className="mb-1 text-[9px] font-bold tracking-[0.12em] uppercase" style={{ color: 'var(--pc)' }}>{d.project_id ? 'Solar project' : 'Details'}</div>
          {d.project_id ? <ProjectLines d={d} /> : <DetailsGrid v={v} />}
        </div>
        <div>
          <div className="mb-1 text-[9px] font-bold tracking-[0.12em] uppercase" style={{ color: 'var(--pc)' }}>Document</div>
          <div className="grid grid-cols-[auto_1fr] gap-x-3">
            {v.meta.map(([k, val]) => (
              <FragmentRow key={k} k={k} v={val} />
            ))}
          </div>
        </div>
      </div>

      <ItemsTable v={v} ctx={ctx} variant="modern" />

      {v.isChallan ? (
        <ChallanSummary v={v} />
      ) : (
        <div className="avoid-break mt-4 grid grid-cols-[1fr_260px] gap-6">
          <SideNotes v={v} ctx={ctx} />
          <div className="text-[11px]">
            <TotalsBox rows={totalsRows(v, ctx)} />
          </div>
        </div>
      )}
      {v.isChallan && v.o.showNotes && d.notes && (
        <div className="avoid-break mt-3 text-[10.5px]">
          <Caption>Notes</Caption>
          <div className="whitespace-pre-line">{d.notes}</div>
        </div>
      )}
      <Terms v={v} />
      <DocSignatures v={v} ctx={ctx} />
      <PrintFooter ctx={ctx} note={v.o.footerNote || undefined} />
    </Sheet>
  )
}

function FragmentRow({ k, v }: { k: string; v: string }): JSX.Element {
  return (
    <>
      <span className="text-[#4a5568]">{k}</span>
      <span className="font-semibold">{v}</span>
    </>
  )
}

/* ------------------------------------------ Compact ------------------------------------------ */
function CompactLayout({ v, ctx }: { v: DocView; ctx: PrintContext }): JSX.Element {
  const d = v.d
  return (
    <Sheet ctx={ctx} watermark={v.watermark} accent={v.o.accentColor} className="!text-[10px]">
      <CompactHeader ctx={ctx} title={v.title} number={d.number} date={pd(d.date)} showLogo={v.o.showLogo} />
      <div className="avoid-break my-2 grid grid-cols-[1.4fr_1fr] gap-4 text-[9.5px] leading-snug">
        <div>
          <span className="font-bold tracking-wider text-[#718096] uppercase">{v.partyLabel}: </span>
          <b>{v.partyName}</b>
          {v.partyAddr && <span> · {v.partyAddr}</span>}
          {v.partyPhone && <span> · Ph: {v.partyPhone}</span>}
          {d.project_id && (
            <div>
              <span className="font-bold tracking-wider text-[#718096] uppercase">Project: </span>
              {d.project_code} · {d.project_name}
              {d.project_capacity ? ` · ${pq(d.project_capacity)} kW` : ''}
            </div>
          )}
        </div>
        <div className="text-right">
          {v.meta.slice(2).map(([k, val]) => (
            <span key={k} className="ml-3 inline-block">
              <span className="text-[#4a5568]">{k}:</span> <b>{val}</b>
            </span>
          ))}
          {v.financial && (
            <span className="ml-3 inline-block">
              <span className="text-[#4a5568]">Status:</span> <b>{v.statusText}</b>
            </span>
          )}
        </div>
      </div>
      <ItemsTable v={v} ctx={ctx} variant="compact" />
      {v.isChallan ? (
        <ChallanSummary v={v} />
      ) : (
        <div className="avoid-break mt-2 grid grid-cols-[1fr_230px] gap-4">
          <SideNotes v={v} ctx={ctx} size="sm" />
          <div className="overflow-hidden rounded border border-[#e2e8f0] [&_td]:!py-0.5 [&_td]:!text-[10px]">
            <TotalsBox rows={totalsRows(v, ctx)} />
          </div>
        </div>
      )}
      {v.isChallan && v.o.showNotes && d.notes && (
        <div className="avoid-break mt-2 text-[9.5px]">
          <Caption>Notes</Caption>
          <div className="whitespace-pre-line">{d.notes}</div>
        </div>
      )}
      <Terms v={v} size="sm" />
      <DocSignatures v={v} ctx={ctx} compact />
      <PrintFooter ctx={ctx} note={v.o.footerNote || undefined} className="!mt-3" />
    </Sheet>
  )
}

/** Every sales / purchase document in the chosen layout (classic, modern, compact A4 or 80 mm thermal receipt). */
export function DocumentPrint({ id, ctx, setTitle, design, onKind, data }: TemplateProps): JSX.Element | null {
  const [d, setD] = useState<any>(data ?? null)
  const [err, setErr] = useState<string | null>(null)
  useEffect(() => {
    if (data) {
      setD(data)
      return
    }
    api<any>('docs.get', { id })
      .then((doc) => {
        setD(doc)
        setTitle(`${DOC_TITLES[doc.doc_type] ?? 'Document'} ${doc.number} - ${doc.party_master_name ?? doc.party_name ?? ''}`.trim())
        onKind?.(doc.doc_type)
      })
      .catch((e) => setErr(e.message))
  }, [id, data]) // eslint-disable-line react-hooks/exhaustive-deps
  if (err) return <div className="no-print mx-auto max-w-[210mm] rounded bg-red-100 p-4 text-red-800">{err}</div>
  if (!d || design === null) return null

  const layout = design?.layout ?? 'classic'
  const v = buildDocView(d, ctx, design?.options ?? firmOptions(ctx.ps))
  // The 80 mm receipt exists for sales invoices only (and payment receipts, see PaymentPrint).
  if (layout === 'thermal80' && v.t === 'sale_invoice') return <ThermalDocument v={v} ctx={ctx} />
  if (layout === 'modern') return <ModernLayout v={v} ctx={ctx} />
  if (layout === 'compact') return <CompactLayout v={v} ctx={ctx} />
  return <ClassicLayout v={v} ctx={ctx} />
}
