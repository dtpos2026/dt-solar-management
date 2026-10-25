/**
 * 80 mm thermal receipt layout (POS printers) for sales invoices and payment receipts.
 * Black only, 72 mm printable width. The page height follows the content so the receipt prints as one strip
 * (@page size 80mm x <content height>), both from the Print button and in Save PDF.
 */
import { ReactNode, useLayoutEffect, useRef, useState } from 'react'
import { PAYMENT_METHOD_LABELS } from '@shared/docTypes'
import { amountInWords, round2 } from '@shared/money'
import { PrintContext, pd, pm, pq, poweredByLine } from './PrintKit'
import type { TemplateOptions } from './design'
import type { DocView } from './DocumentPrint'

/* eslint-disable @typescript-eslint/no-explicit-any */
const PX_PER_MM = 96 / 25.4

function useReceiptPage(): { ref: React.RefObject<HTMLDivElement | null>; css: string } {
  const ref = useRef<HTMLDivElement | null>(null)
  const [heightMm, setHeightMm] = useState(200)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const measure = (): void => {
      // content height + a little feed so the cutter does not cut through the last line
      const mm = Math.ceil(el.scrollHeight / PX_PER_MM) + 8
      setHeightMm((h) => (Math.abs(h - mm) > 1 ? mm : h))
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  const css = `
@page { size: 80mm ${Math.max(60, heightMm)}mm; margin: 0; }
.sheet.thermal-sheet { width: 80mm; min-height: 0; padding: 4mm 4mm 5mm; font-size: 10.5px; line-height: 1.35; color: #000; font-family: Arial, 'Segoe UI', sans-serif; }
@media print {
  .sheet.thermal-sheet { width: 80mm !important; padding: 2mm 4mm 4mm !important; margin: 0 !important; }
}`
  return { ref, css }
}

function Rule({ strong }: { strong?: boolean }): JSX.Element {
  return <div className={`my-1.5 border-t ${strong ? 'border-black' : 'border-dashed border-black/70'}`} />
}

function Row({ k, v, bold, big }: { k: ReactNode; v: ReactNode; bold?: boolean; big?: boolean }): JSX.Element {
  return (
    <div className={`flex justify-between gap-2 ${bold ? 'font-bold' : ''} ${big ? 'text-[13px]' : ''}`}>
      <span>{k}</span>
      <span className="num text-right">{v}</span>
    </div>
  )
}

function Header({ ctx, o, title, lines }: { ctx: PrintContext; o: TemplateOptions; title: string; lines: Array<[string, ReactNode]> }): JSX.Element {
  const f = ctx.firm
  const contact = [f.phone, f.phone2].filter(Boolean).join(' / ')
  return (
    <div className="text-center">
      {o.showLogo && f.logo && <img src={f.logo} alt="" className="mx-auto mb-1 max-h-[46px] max-w-[46mm] object-contain grayscale" />}
      {o.showCompanyName !== false && <div className="text-[14px] leading-tight font-extrabold">{f.name}</div>}
      {f.tagline && <div className="text-[9px]">{f.tagline}</div>}
      <div className="text-[9.5px] leading-snug">
        {o.showAddress === false ? null : [f.address, f.city].filter(Boolean).join(', ')}
        {contact && o.showPhone !== false && <div>Ph: {contact}</div>}
        {o.showTaxId !== false && (f.ntn || f.strn) && <div>{[f.ntn && `NTN: ${f.ntn}`, f.strn && `STRN: ${f.strn}`].filter(Boolean).join(', ')}</div>}
      </div>
      <Rule strong />
      <div className="text-[12.5px] font-black tracking-[0.12em] uppercase">{title}</div>
      <div className="mt-0.5 text-left text-[10px]">
        {lines.map(([k, val]) => (
          <Row key={k} k={k} v={val} />
        ))}
      </div>
    </div>
  )
}

function Footer({ ctx, note, terms }: { ctx: PrintContext; note?: string; terms?: string | null }): JSX.Element {
  const footer = note || ctx.firm.invoice_footer
  return (
    <>
      {terms && (
        <>
          <Rule />
          <div className="text-[8.8px] leading-snug">
            <div className="font-bold uppercase">Terms</div>
            {String(terms)
              .split(/\n+/)
              .map((s) => s.trim())
              .filter(Boolean)
              .map((s, i) => (
                <div key={i}>{s}</div>
              ))}
          </div>
        </>
      )}
      <Rule />
      <div className="text-center text-[9.5px] leading-snug">
        {footer ? <div className="whitespace-pre-line">{footer}</div> : <div className="font-semibold">Thank you for your business!</div>}
        {ctx.poweredBy === true && <div className="mt-1 text-[8.5px]" data-powered-by="1">{poweredByLine()}</div>}
      </div>
    </>
  )
}

/** Sales invoice (or credit note) as an 80 mm receipt. */
export function ThermalDocument({ v, ctx }: { v: DocView; ctx: PrintContext }): JSX.Element {
  const { ref, css } = useReceiptPage()
  const d = v.d
  const o = v.o
  const lines: Array<[string, ReactNode]> = [
    ['No.', <b key="n">{d.number}</b>],
    ['Date', pd(d.date)],
    [v.isSales ? 'Customer' : 'Supplier', v.partyName]
  ]
  if (v.partyPhone) lines.push(['Phone', v.partyPhone])
  if (d.project_id) lines.push(['Project', `${d.project_code} ${d.project_name ?? ''}`.trim()])
  if (d.ref_doc_number) lines.push([v.isReturn ? 'Against' : 'Ref.', d.ref_doc_number])
  return (
    <div ref={ref} className="sheet thermal-sheet relative" data-layout="thermal80">
      <style>{css}</style>
      {v.cancelled && <div className="mb-1 border border-black py-0.5 text-center text-[12px] font-black tracking-[0.2em]">CANCELLED</div>}
      <Header ctx={ctx} o={o} title={v.title} lines={lines} />
      <Rule strong />
      <div className="space-y-1.5">
        {d.lines.map((l: any, i: number) => (
          <div key={l.id} className="avoid-break">
            <div className="font-bold leading-tight">
              {i + 1}. {l.description}
            </div>
            {o.showBrandModel && (l.brand || l.model) && l.description !== l.product_name && <div className="text-[9px]">{[l.brand, l.model].filter(Boolean).join(', ')}</div>}
            {o.showDescription && l.details && (
              <div className="text-[9.3px] leading-snug whitespace-pre-line" data-item-details="1">
                {l.details}
              </div>
            )}
            {o.showSerials && l.serials && <div className="text-[9px]">S/N: {l.serials}</div>}
            {o.showWarranty && l.warranty && v.isSales && <div className="text-[9px]">Warranty: {l.warranty}</div>}
            <div className="flex justify-between gap-2">
              <span className="num">
                {pq(l.qty)}
                {o.showUnit && l.unit ? ` ${l.unit}` : ''} x {pm(ctx, l.rate, 2)}
                {v.hasDisc && l.discount_amt > 0 ? ` - ${pm(ctx, l.discount_amt, 2)}` : ''}
                {v.hasTax && l.tax_amt > 0 ? ` + tax ${pm(ctx, l.tax_amt, 2)}` : ''}
              </span>
              <span className="num font-semibold">{pm(ctx, l.line_total, 2)}</span>
            </div>
          </div>
        ))}
      </div>
      <Rule strong />
      <div className="space-y-0.5 text-[10.5px]">
        <Row k="Subtotal" v={pm(ctx, d.subtotal, 2)} />
        {d.line_discount_total > 0 && <Row k="Item discounts" v={`- ${pm(ctx, d.line_discount_total, 2)}`} />}
        {d.doc_discount > 0 && <Row k="Discount" v={`- ${pm(ctx, d.doc_discount, 2)}`} />}
        {d.other_charges !== 0 && <Row k={d.other_charges_label || 'Other charges'} v={pm(ctx, d.other_charges, 2)} />}
        {d.tax_total !== 0 && <Row k="Sales tax" v={pm(ctx, d.tax_total, 2)} />}
        {d.round_off !== 0 && <Row k="Round off" v={pm(ctx, d.round_off, 2)} />}
        <div className="my-1 border-y border-black py-0.5">
          <Row k={`TOTAL ${ctx.settings.currency_symbol ?? 'Rs.'}`} v={pm(ctx, d.grand_total, 2)} bold big />
        </div>
        {v.financial && !v.cancelled && d.paid > 0 && <Row k={v.isReturn ? 'Settled' : 'Paid'} v={pm(ctx, d.paid, 2)} />}
        {v.financial && !v.cancelled && d.returned > 0 && <Row k="Returned" v={pm(ctx, d.returned, 2)} />}
        {v.financial && !v.cancelled && <Row k="Balance due" v={pm(ctx, d.due, 2)} bold />}
        {v.showPrev && <Row k="Previous balance" v={pm(ctx, d.previous_balance, 2)} />}
        {v.showPrev && <Row k="Account balance" v={pm(ctx, round2(d.previous_balance + d.due), 2)} bold />}
      </div>
      {o.showAmountInWords && <div className="mt-1 text-[9.3px] leading-snug italic">{amountInWords(d.grand_total, v.word)}</div>}
      {v.financial && d.payments?.length > 0 && (
        <>
          <Rule />
          <div className="text-[9.5px]">
            {d.payments.map((p: any) => (
              <Row key={p.payment_id} k={`${p.number} · ${PAYMENT_METHOD_LABELS[p.method] ?? p.method}`} v={pm(ctx, p.amount, 2)} />
            ))}
          </div>
        </>
      )}
      {o.showBankDetails && ctx.firm.bank_details && v.isSales && !v.isReturn && (
        <>
          <Rule />
          <div className="text-[9px] leading-snug whitespace-pre-line">{ctx.firm.bank_details}</div>
        </>
      )}
      {o.showNotes && d.notes && (
        <>
          <Rule />
          <div className="text-[9.5px] whitespace-pre-line">{d.notes}</div>
        </>
      )}
      {o.showCustomerSignature && v.isSales && (
        <div className="mt-6 border-t border-black pt-0.5 text-center text-[9px]">{ctx.ps.receiverLabel}</div>
      )}
      <Footer ctx={ctx} note={o.footerNote} terms={v.terms} />
    </div>
  )
}

/** Payment receipt / voucher as an 80 mm receipt. */
export function ThermalPayment({ p, ctx, o }: { p: any; ctx: PrintContext; o: TemplateOptions }): JSX.Element {
  const { ref, css } = useReceiptPage()
  const isIn = p.direction === 'in'
  const cancelled = p.status === 'cancelled'
  const allocations: any[] = p.allocations ?? []
  const allocated = round2(allocations.reduce((a, r) => a + Number(r.amount || 0), 0))
  const unallocated = round2(Number(p.amount) - allocated)
  const word = String(ctx.settings.currency_word ?? 'Rupees')
  const bal = p.party_balance === null || p.party_balance === undefined ? null : Number(p.party_balance)
  const title = o.titleOverride?.trim() || (isIn ? 'Payment Receipt' : 'Payment Voucher')
  const lines: Array<[string, ReactNode]> = [
    [isIn ? 'Receipt #' : 'Voucher #', <b key="n">{p.number}</b>],
    ['Date', pd(p.date)],
    [isIn ? 'From' : 'To', p.party_name ?? (isIn ? 'Cash receipt' : 'Cash payment')]
  ]
  if (p.party_phone) lines.push(['Phone', p.party_phone])
  return (
    <div ref={ref} className="sheet thermal-sheet relative" data-layout="thermal80">
      <style>{css}</style>
      {cancelled && <div className="mb-1 border border-black py-0.5 text-center text-[12px] font-black tracking-[0.2em]">CANCELLED</div>}
      <Header ctx={ctx} o={o} title={title} lines={lines} />
      <Rule strong />
      <div className="text-center">
        <div className="text-[9.5px] font-bold uppercase">{isIn ? 'Amount received' : 'Amount paid'}</div>
        <div className="num text-[18px] font-black">
          {ctx.settings.currency_symbol ?? 'Rs.'} {pm(ctx, p.amount, 2)}
        </div>
        {o.showAmountInWords && <div className="text-[9.3px] italic">{amountInWords(p.amount, word)}</div>}
      </div>
      <Rule />
      <div className="space-y-0.5 text-[10px]">
        <Row k="Method" v={PAYMENT_METHOD_LABELS[p.method] ?? String(p.method ?? '').replace(/_/g, ' ')} />
        {p.reference && <Row k="Reference" v={p.reference} />}
        {p.account_name && <Row k={isIn ? 'Deposited to' : 'Paid from'} v={p.account_name} />}
        {p.project_id && <Row k="Project" v={[p.project_code, p.project_name].filter(Boolean).join(' ')} />}
      </div>
      {allocations.length > 0 && (
        <>
          <Rule />
          <div className="text-[9.5px] font-bold uppercase">{isIn ? 'Settled against' : 'Paid against'}</div>
          <div className="space-y-0.5 text-[10px]">
            {allocations.map((a, i) => (
              <Row key={a.id ?? i} k={a.document_number ?? a.expense_number ?? '-'} v={pm(ctx, a.amount, 2)} />
            ))}
          </div>
        </>
      )}
      {unallocated > 0.005 && <Row k="Advance / on account" v={pm(ctx, unallocated, 2)} />}
      {bal !== null && !cancelled && (
        <>
          <Rule />
          <Row k={Math.abs(bal) < 0.005 ? 'Account settled' : bal > 0 ? 'Balance receivable' : 'Balance payable'} v={pm(ctx, Math.abs(bal), 2)} bold />
        </>
      )}
      {o.showNotes && p.notes && (
        <>
          <Rule />
          <div className="text-[9.5px] whitespace-pre-line">{p.notes}</div>
        </>
      )}
      {o.showCustomerSignature && <div className="mt-6 border-t border-black pt-0.5 text-center text-[9px]">{isIn ? 'Paid by (signature)' : 'Received by (signature)'}</div>}
      <Footer ctx={ctx} note={o.footerNote} />
    </div>
  )
}
