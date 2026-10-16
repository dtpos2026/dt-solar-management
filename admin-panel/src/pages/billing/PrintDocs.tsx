/** A4 invoice + payment receipt layouts (used on screen as a preview and in print). */
import { useEffect, useState } from 'react'
import { money } from '../../lib/billing'
import { fmtDate } from '../../lib/format'
import { qrDataUrl, verifyUrl } from '../../lib/qr'
import type { Branding, Client, Invoice, InvoicePayment } from '../../lib/types'

const C = { ink: '#1a1030', muted: '#6b5f84', brand: '#3d096d', line: '#e7def3' }

function Header({ b, title, sub }: { b: Branding; title: string; sub: string }) {
  return (
    <div className="flex items-start justify-between gap-6 border-b-4 pb-4" style={{ borderColor: C.brand }}>
      <div className="flex items-center gap-3">
        {b.logo ? <img src={b.logo} alt="" className="h-16 w-16 object-contain" /> : <div className="grid h-14 w-14 place-items-center rounded-xl text-[20px] font-black text-white" style={{ background: `linear-gradient(135deg, #5b10a0, ${C.brand})` }}>DT</div>}
        <div>
          <div className="text-[20px] font-extrabold" style={{ color: C.brand }}>{b.companyName}</div>
          <div className="text-[11.5px] leading-snug" style={{ color: C.muted }}>
            {b.address && <div>{b.address}</div>}
            <div>{[b.phone, b.email].filter(Boolean).join(' · ')}</div>
            {b.website && <div>{b.website}</div>}
          </div>
        </div>
      </div>
      <div className="text-right">
        <div className="text-[26px] font-black tracking-wide" style={{ color: C.brand }}>{title}</div>
        <div className="text-[13px] font-bold">{sub}</div>
      </div>
    </div>
  )
}

export function InvoiceDoc({ inv, b, client, payments }: { inv: Invoice; b: Branding; client?: Client; payments: InvoicePayment[] }) {
  const [qr, setQr] = useState('')
  const url = verifyUrl(inv.verifyToken, b.verifyBaseUrl)
  useEffect(() => { qrDataUrl(url).then(setQr).catch(() => setQr('')) }, [url])
  const cur = inv.currency
  const valid = payments.filter((p) => !p.cancelled)
  return (
    <div className="dt-a4 relative mx-auto bg-white p-8 text-[12.5px]" style={{ color: C.ink, width: '210mm', minHeight: '297mm', boxSizing: 'border-box' }} data-verify-url={url}>
      {inv.status === 'cancelled' && <div className="pointer-events-none absolute inset-0 grid place-items-center text-[110px] font-black text-red-500/15" style={{ transform: 'rotate(-25deg)' }}>CANCELLED</div>}
      <Header b={b} title="INVOICE" sub={inv.number} />
      <div className="mt-5 grid grid-cols-[1fr_auto] gap-6">
        <div>
          <div className="text-[11px] font-bold uppercase tracking-wider" style={{ color: C.muted }}>Bill to</div>
          <div className="text-[15px] font-bold">{inv.clientName}</div>
          {client && <div className="text-[12px]" style={{ color: C.muted }}>{[client.ownerName, client.phone, client.email].filter(Boolean).join(' · ')}<br />{[client.address, client.city].filter(Boolean).join(', ')}</div>}
        </div>
        <table className="text-[12px]"><tbody>
          <tr><td className="pr-4" style={{ color: C.muted }}>Issue date</td><td className="font-semibold">{fmtDate(inv.issueDate)}</td></tr>
          <tr><td className="pr-4" style={{ color: C.muted }}>Due date</td><td className="font-semibold">{fmtDate(inv.dueDate)}</td></tr>
          {inv.planType && <tr><td className="pr-4" style={{ color: C.muted }}>Plan</td><td className="font-semibold capitalize">{inv.planType}</td></tr>}
          <tr><td className="pr-4" style={{ color: C.muted }}>Status</td><td className="font-semibold capitalize">{inv.status}</td></tr>
        </tbody></table>
      </div>
      <table className="mt-5 w-full border-collapse text-[12.5px]">
        <thead><tr className="text-left text-white" style={{ background: C.brand }}>
          <th className="px-3 py-2">#</th><th className="px-3 py-2">Description</th><th className="px-3 py-2 text-right">Qty</th><th className="px-3 py-2 text-right">Rate</th><th className="px-3 py-2 text-right">Amount</th>
        </tr></thead>
        <tbody>{inv.lines.map((l, i) => (
          <tr key={i} style={{ borderBottom: `1px solid ${C.line}` }}>
            <td className="px-3 py-2">{i + 1}</td><td className="px-3 py-2">{l.description}</td><td className="px-3 py-2 text-right">{l.qty}</td>
            <td className="px-3 py-2 text-right">{money(l.rate, '')}</td><td className="px-3 py-2 text-right font-semibold">{money(l.amount, '')}</td>
          </tr>
        ))}</tbody>
      </table>
      <div className="mt-4 flex justify-between gap-6">
        <div className="flex items-start gap-3">
          {qr && <div className="text-center"><img src={qr} alt="Verification QR code" className="h-[110px] w-[110px]" /><div className="text-[10.5px] font-bold" style={{ color: C.brand }}>Scan to verify</div></div>}
          {b.paymentQr && <div className="text-center"><img src={b.paymentQr} alt="Payment QR" className="h-[110px] w-[110px] object-contain" /><div className="text-[10.5px] font-bold" style={{ color: C.muted }}>Pay here</div></div>}
        </div>
        <table className="w-[270px] text-[12.5px]"><tbody>
          <tr><td className="py-0.5">Subtotal</td><td className="text-right">{money(inv.subtotal, cur)}</td></tr>
          {inv.discount > 0 && <tr><td className="py-0.5">Discount</td><td className="text-right">− {money(inv.discount, cur)}</td></tr>}
          {inv.taxAmount > 0 && <tr><td className="py-0.5">{b.taxName || 'Tax'} ({inv.taxRate}%)</td><td className="text-right">{money(inv.taxAmount, cur)}</td></tr>}
          <tr className="text-[14px] font-extrabold" style={{ borderTop: `2px solid ${C.brand}` }}><td className="py-1">Total</td><td className="text-right">{money(inv.total, cur)}</td></tr>
          <tr><td className="py-0.5">Paid</td><td className="text-right">{money(inv.paid, cur)}</td></tr>
          <tr className="text-[14px] font-extrabold" style={{ color: C.brand }}><td className="py-1">Amount due</td><td className="text-right">{money(inv.status === 'cancelled' ? 0 : inv.balance, cur)}</td></tr>
        </tbody></table>
      </div>
      {valid.length > 0 && (
        <div className="mt-3 text-[11.5px]" style={{ color: C.muted }}>
          Payments received: {valid.map((p) => `${p.receiptNo} ${fmtDate(p.date)} ${money(p.amount, cur)}`).join(' · ')}
        </div>
      )}
      <div className="mt-6 grid grid-cols-2 gap-6 text-[11.5px]">
        <div>
          {(b.bankName || b.bankAccount || b.iban) && (<>
            <div className="font-bold uppercase tracking-wider" style={{ color: C.muted }}>Bank details</div>
            {b.bankName && <div>Bank: {b.bankName}</div>}{b.bankTitle && <div>Title: {b.bankTitle}</div>}
            {b.bankAccount && <div>Account: {b.bankAccount}</div>}{b.iban && <div>IBAN: {b.iban}</div>}
          </>)}
          {inv.notes && <div className="mt-2"><b>Notes:</b> {inv.notes}</div>}
          {b.terms && <div className="mt-2" style={{ color: C.muted }}><b>Terms:</b> {b.terms}</div>}
        </div>
        <div className="flex flex-col items-end justify-end">
          {b.signature && <img src={b.signature} alt="" className="h-14 object-contain" />}
          <div className="mt-1 w-48 border-t pt-1 text-center" style={{ borderColor: C.ink }}>Authorised signature</div>
        </div>
      </div>
      <div className="absolute bottom-6 left-8 right-8 border-t pt-2 text-center text-[10.5px]" style={{ borderColor: C.line, color: C.muted }}>
        {b.invoiceFooter} · Verify this invoice at {url}
      </div>
    </div>
  )
}

export function ReceiptDoc({ inv, pay, b }: { inv: Invoice; pay: InvoicePayment; b: Branding }) {
  return (
    <div className="dt-a4 relative mx-auto bg-white p-8 text-[13px]" style={{ color: C.ink, width: '210mm', minHeight: '140mm', boxSizing: 'border-box' }}>
      {pay.cancelled && <div className="pointer-events-none absolute inset-0 grid place-items-center text-[90px] font-black text-red-500/15" style={{ transform: 'rotate(-20deg)' }}>VOID</div>}
      <Header b={b} title="RECEIPT" sub={pay.receiptNo} />
      <table className="mt-6 w-full text-[13px]"><tbody>
        <tr><td className="w-48 py-1" style={{ color: C.muted }}>Received from</td><td className="font-bold">{inv.clientName}</td></tr>
        <tr><td className="py-1" style={{ color: C.muted }}>Payment date</td><td>{fmtDate(pay.date)}</td></tr>
        <tr><td className="py-1" style={{ color: C.muted }}>Against invoice</td><td>{inv.number}</td></tr>
        <tr><td className="py-1" style={{ color: C.muted }}>Method</td><td className="capitalize">{pay.method}{pay.reference ? ` — ${pay.reference}` : ''}</td></tr>
        <tr><td className="py-1" style={{ color: C.muted }}>Amount received</td><td className="text-[18px] font-extrabold" style={{ color: C.brand }}>{money(pay.amount, inv.currency)}</td></tr>
        <tr><td className="py-1" style={{ color: C.muted }}>Invoice balance now</td><td>{money(inv.balance, inv.currency)}</td></tr>
      </tbody></table>
      <div className="mt-10 flex justify-end">
        <div className="text-center">
          {b.signature && <img src={b.signature} alt="" className="mx-auto h-14 object-contain" />}
          <div className="w-48 border-t pt-1" style={{ borderColor: C.ink }}>Authorised signature</div>
        </div>
      </div>
      <div className="mt-6 text-center text-[10.5px]" style={{ color: C.muted }}>{b.invoiceFooter}</div>
    </div>
  )
}
