/** A4 invoice + payment receipt layouts (used on screen as a preview and in print). Design: purple banner, detail cards, QR payment block, totals card, signature and footer band. */
import { useEffect, useState } from 'react'
import { displayStatus, money, plainAmount, rs } from '../../lib/billing'
import { fmtDate, toDate } from '../../lib/format'
import { qrDataUrl, verifyUrl } from '../../lib/qr'
import type { Branding, Client, Invoice, InvoicePayment } from '../../lib/types'

const C = { ink: '#1a1030', muted: '#6b5f84', brand: '#3d096d', dark: '#2a0650', mid: '#5b10a0', line: '#e7def3', soft: '#f6f1fb', band: '#ece3f8', ok: '#16803c', bad: '#c0262d' }
const PILL: Record<string, { bg: string; label: string }> = {
  paid: { bg: C.ok, label: 'PAID' },
  partial: { bg: '#0b6bcb', label: 'PARTIALLY PAID' },
  unpaid: { bg: C.bad, label: 'UNPAID' },
  overdue: { bg: C.bad, label: 'OVERDUE' },
  cancelled: { bg: '#5f6672', label: 'CANCELLED' }
}
const logoSrc = (b: Branding): string => b.logo || `${import.meta.env.BASE_URL}dt-logo.jpg`
const termLines = (terms: string): string[] => terms.split(/\r?\n/).map((t) => t.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').trim()).filter(Boolean)

/** Faint triangles behind the page content. */
function Triangles() {
  return (
    <svg aria-hidden className="pointer-events-none absolute bottom-0 right-0" width="360" height="360" viewBox="0 0 360 360" style={{ opacity: 0.06 }}>
      <polygon points="360,0 360,360 0,360" fill={C.brand} />
      <polygon points="360,120 360,360 120,360" fill={C.mid} />
    </svg>
  )
}

function Banner({ b, title, no, pill }: { b: Branding; title: string; no: string; pill?: { bg: string; label: string } }) {
  return (
    <div className="flex items-center gap-5 px-9 py-7 text-white" style={{ background: `linear-gradient(120deg, ${C.dark} 0%, ${C.brand} 55%, ${C.mid} 100%)` }}>
      <div className="grid h-[72px] w-[72px] shrink-0 place-items-center rounded-2xl bg-white p-1.5">
        <img src={logoSrc(b)} alt="" className="max-h-full max-w-full object-contain" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-[34px] font-black leading-none" style={{ letterSpacing: '0.28em' }}>{title}</div>
        <div className="mt-2 text-[14px] font-semibold tracking-wider text-white/85">{no}</div>
      </div>
      {pill && <div className="rounded-full px-4 py-1.5 text-[12.5px] font-extrabold tracking-wider text-white" style={{ background: pill.bg }}>{pill.label}</div>}
    </div>
  )
}

function Footer({ b }: { b: Branding }) {
  return (
    <div className="mt-auto flex items-center justify-between gap-4 px-9 py-3.5 text-[12px]" style={{ background: C.band, color: C.brand }}>
      <span className="font-bold">{b.invoiceFooter || 'Thank you for your business!'}</span>
      <span className="font-semibold">{[b.companyName, b.phone && `Phone: ${b.phone}`].filter(Boolean).join(' | ')}</span>
    </div>
  )
}

function Signature({ b }: { b: Branding }) {
  return (
    <div className="flex flex-col items-end">
      <div className="flex h-[58px] items-end">{b.signature && <img src={b.signature} alt="" className="max-h-[56px] max-w-[200px] object-contain" />}</div>
      <div className="mt-1 w-56 border-t-2 pt-1.5 text-center" style={{ borderColor: C.brand }}>
        <div className="text-[13px] font-bold">{b.signatoryName || b.companyName}</div>
        <div className="text-[11px]" style={{ color: C.muted }}>Authorized Signatory</div>
      </div>
    </div>
  )
}

function Party({ label, name, lines }: { label: string; name: string; lines: string[] }) {
  return (
    <div className="min-w-0">
      <div className="mb-1 text-[10.5px] font-extrabold tracking-[0.2em]" style={{ color: C.mid }}>{label}</div>
      <div className="text-[15px] font-bold leading-tight">{name}</div>
      <div className="mt-1 space-y-0.5 text-[12px] leading-snug" style={{ color: C.muted }}>{lines.filter(Boolean).map((l, i) => <div key={i}>{l}</div>)}</div>
    </div>
  )
}

function DetailRow({ k, v }: { k: string; v: string }) {
  return <div className="flex justify-between gap-6 py-[3px]"><span style={{ color: C.muted }}>{k}</span><span className="font-semibold">{v}</span></div>
}

export function InvoiceDoc({ inv, b, client, payments }: { inv: Invoice; b: Branding; client?: Client; payments: InvoicePayment[] }) {
  const [qr, setQr] = useState('')
  const url = verifyUrl(inv.verifyToken, b.verifyBaseUrl)
  useEffect(() => { qrDataUrl(url, 240).then(setQr).catch(() => setQr('')) }, [url])
  const cur = inv.currency
  const valid = payments.filter((p) => !p.cancelled)
  const status = displayStatus({ status: inv.status, balance: inv.balance, dueDate: toDate(inv.dueDate) })
  const due = inv.status === 'cancelled' ? 0 : inv.balance
  const dueText = inv.dueDate && inv.issueDate && inv.dueDate.toMillis() > inv.issueDate.toMillis() + 86_400_000 ? fmtDate(inv.dueDate) : 'On receipt'
  const pill = PILL[status === 'overdue' && dueText === 'On receipt' ? 'unpaid' : status] ?? PILL.unpaid
  const method = valid.length ? valid[valid.length - 1].method : b.bankName || b.bankAccount ? 'Bank transfer' : ''
  const hasBank = !!(b.bankName || b.bankTitle || b.bankAccount || b.iban)
  const terms = termLines(b.terms)
  return (
    <div className="dt-a4 relative mx-auto flex flex-col overflow-hidden bg-white text-[12.5px]" style={{ color: C.ink, width: '210mm', minHeight: '297mm', boxSizing: 'border-box' }} data-verify-url={url}>
      <Triangles />
      {inv.status === 'cancelled' && <div className="pointer-events-none absolute inset-0 z-10 grid place-items-center text-[110px] font-black text-red-500/15" style={{ transform: 'rotate(-25deg)' }}>CANCELLED</div>}
      <Banner b={b} title="INVOICE" no={inv.number} pill={pill} />

      <div className="relative flex-1 px-9 pb-6 pt-6">
        <div className="grid grid-cols-[1fr_1fr_270px] gap-6">
          <Party label="FROM" name={b.companyName} lines={[b.address, [b.phone, b.email].filter(Boolean).join('  |  '), b.website]} />
          <Party label="BILL TO" name={inv.clientName} lines={client ? [client.ownerName, [client.phone, client.email].filter(Boolean).join('  |  '), [client.address, client.city].filter(Boolean).join(', ')] : []} />
          <div className="rounded-2xl border px-4 py-3 text-[12px]" style={{ borderColor: C.line, background: C.soft }}>
            <DetailRow k="Invoice date" v={fmtDate(inv.issueDate)} />
            <DetailRow k="Due date" v={dueText} />
            {inv.planType && <DetailRow k="Service" v={`${inv.planType[0].toUpperCase()}${inv.planType.slice(1)} license`} />}
            {method && <DetailRow k="Payment method" v={method} />}
          </div>
        </div>

        <table className="mt-6 w-full border-collapse text-[12.5px]">
          <thead>
            <tr className="text-left text-white" style={{ background: C.brand }}>
              <th className="rounded-l-lg px-4 py-2.5 text-[11px] tracking-[0.14em]">#</th>
              <th className="px-3 py-2.5 text-[11px] tracking-[0.14em]">DESCRIPTION</th>
              <th className="px-3 py-2.5 text-right text-[11px] tracking-[0.14em]">QTY</th>
              <th className="px-3 py-2.5 text-right text-[11px] tracking-[0.14em]">RATE</th>
              <th className="rounded-r-lg px-4 py-2.5 text-right text-[11px] tracking-[0.14em]">AMOUNT</th>
            </tr>
          </thead>
          <tbody>
            {inv.lines.map((l, i) => (
              <tr key={i} style={{ borderBottom: `1px solid ${C.line}`, breakInside: 'avoid' }}>
                <td className="px-4 py-3">{i + 1}</td>
                <td className="px-3 py-3 font-medium">{l.description}</td>
                <td className="px-3 py-3 text-right">{l.qty}</td>
                <td className="px-3 py-3 text-right">{plainAmount(l.rate)}</td>
                <td className="px-4 py-3 text-right font-bold">{plainAmount(l.amount)}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <div className="mt-6 grid grid-cols-[1fr_270px] items-start gap-6" style={{ breakInside: 'avoid' }}>
          <div className="rounded-2xl border p-4" style={{ borderColor: C.line }}>
            <div className="mb-2 text-[10.5px] font-extrabold tracking-[0.2em]" style={{ color: C.mid }}>PAYMENT DETAILS</div>
            <div className="flex gap-4">
              <div className="min-w-0 flex-1 space-y-1 text-[12px]">
                {hasBank ? (
                  <>
                    {b.bankTitle && <div><span style={{ color: C.muted }}>Account title</span><div className="font-bold">{b.bankTitle}</div></div>}
                    {b.bankName && <div><span style={{ color: C.muted }}>Bank</span><div className="font-bold">{b.bankName}</div></div>}
                    {b.bankAccount && <div><span style={{ color: C.muted }}>Account number</span><div className="font-bold">{b.bankAccount}</div></div>}
                    {b.iban && <div><span style={{ color: C.muted }}>IBAN</span><div className="break-all font-bold">{b.iban}</div></div>}
                  </>
                ) : <div style={{ color: C.muted }}>Please contact {b.companyName} for payment details.</div>}
              </div>
              <div className="flex shrink-0 gap-3">
                {b.paymentQr && <div className="text-center"><img src={b.paymentQr} alt="Payment QR" className="h-[96px] w-[96px] rounded-lg border object-contain p-1" style={{ borderColor: C.line }} /><div className="mt-1 text-[10.5px] font-bold" style={{ color: C.brand }}>Scan to pay</div></div>}
                {qr && <div className="text-center"><img src={qr} alt="Verification QR code" className="h-[96px] w-[96px] rounded-lg border p-1" style={{ borderColor: C.line }} /><div className="mt-1 text-[10.5px] font-bold" style={{ color: C.brand }}>Scan to verify</div></div>}
              </div>
            </div>
          </div>

          <div className="overflow-hidden rounded-2xl border text-[12.5px]" style={{ borderColor: C.line }}>
            <div className="space-y-1 px-4 py-3">
              <div className="flex justify-between"><span style={{ color: C.muted }}>Subtotal</span><span className="font-semibold">{rs(inv.subtotal, cur)}</span></div>
              {inv.discount > 0 && <div className="flex justify-between"><span style={{ color: C.muted }}>Discount</span><span className="font-semibold">- {rs(inv.discount, cur)}</span></div>}
              {inv.taxAmount > 0 && <div className="flex justify-between"><span style={{ color: C.muted }}>{b.taxName || 'Tax'} ({inv.taxRate}%)</span><span className="font-semibold">{rs(inv.taxAmount, cur)}</span></div>}
            </div>
            <div className="flex items-center justify-between px-4 py-2.5 text-[14px] font-extrabold text-white" style={{ background: C.brand }}><span>Total</span><span>{rs(inv.total, cur)}</span></div>
            <div className="space-y-1 px-4 py-3">
              <div className="flex justify-between font-semibold" style={{ color: C.ok }}><span>Paid</span><span>{rs(inv.paid, cur)}</span></div>
              <div className="flex justify-between text-[14px] font-extrabold" style={{ color: due > 0 ? C.bad : C.ok }}><span>Balance Due</span><span>{rs(due, cur)}</span></div>
            </div>
          </div>
        </div>

        {valid.length > 0 && (
          <div className="mt-3 text-[11.5px]" style={{ color: C.muted }}>
            Payments received: {valid.map((p) => `${p.receiptNo} on ${fmtDate(p.date)}, ${rs(p.amount, cur)}`).join('; ')}
          </div>
        )}

        <div className="mt-6 grid grid-cols-[1fr_auto] items-end gap-6" style={{ breakInside: 'avoid' }}>
          <div className="text-[11.5px]">
            {(terms.length > 0 || inv.notes) && <div className="mb-1 text-[10.5px] font-extrabold tracking-[0.2em]" style={{ color: C.mid }}>TERMS &amp; CONDITIONS</div>}
            {terms.length > 0 && <ol className="list-decimal space-y-0.5 pl-4" style={{ color: C.muted }}>{terms.map((t, i) => <li key={i}>{t}</li>)}</ol>}
            {inv.notes && <div className="mt-2"><b>Notes:</b> {inv.notes}</div>}
          </div>
          <Signature b={b} />
        </div>
      </div>
      <Footer b={b} />
    </div>
  )
}

export function ReceiptDoc({ inv, pay, b }: { inv: Invoice; pay: InvoicePayment; b: Branding }) {
  const cur = inv.currency
  return (
    <div className="dt-a4 relative mx-auto flex flex-col overflow-hidden bg-white text-[13px]" style={{ color: C.ink, width: '210mm', minHeight: '148mm', boxSizing: 'border-box' }}>
      <Triangles />
      {pay.cancelled && <div className="pointer-events-none absolute inset-0 z-10 grid place-items-center text-[90px] font-black text-red-500/15" style={{ transform: 'rotate(-20deg)' }}>VOID</div>}
      <Banner b={b} title="RECEIPT" no={pay.receiptNo} pill={pay.cancelled ? PILL.cancelled : PILL.paid} />
      <div className="relative flex-1 px-9 py-6">
        <div className="grid grid-cols-[1fr_300px] gap-6">
          <Party label="FROM" name={b.companyName} lines={[b.address, [b.phone, b.email].filter(Boolean).join('  |  ')]} />
          <div className="rounded-2xl border px-4 py-3 text-[12.5px]" style={{ borderColor: C.line, background: C.soft }}>
            <DetailRow k="Payment date" v={fmtDate(pay.date)} />
            <DetailRow k="Against invoice" v={inv.number} />
            <DetailRow k="Method" v={`${pay.method[0]?.toUpperCase() ?? ''}${pay.method.slice(1)}${pay.reference ? ` (${pay.reference})` : ''}`} />
          </div>
        </div>
        <div className="mt-5 overflow-hidden rounded-2xl border" style={{ borderColor: C.line }}>
          <div className="flex items-center justify-between px-5 py-3"><span style={{ color: C.muted }}>Received from</span><span className="text-[15px] font-bold">{inv.clientName}</span></div>
          <div className="flex items-center justify-between px-5 py-3 text-[17px] font-extrabold text-white" style={{ background: C.brand }}><span>Amount received</span><span>{rs(pay.amount, cur)}</span></div>
          <div className="flex items-center justify-between px-5 py-3"><span style={{ color: C.muted }}>Invoice total</span><span className="font-semibold">{rs(inv.total, cur)}</span></div>
          <div className="flex items-center justify-between px-5 py-3 font-extrabold" style={{ color: (inv.status === 'cancelled' ? 0 : inv.balance) > 0 ? C.bad : C.ok }}><span>Balance now</span><span>{rs(inv.status === 'cancelled' ? 0 : inv.balance, cur)}</span></div>
        </div>
        <div className="mt-6 flex justify-end"><Signature b={b} /></div>
      </div>
      <Footer b={b} />
    </div>
  )
}

/* ------------------------------------------- 80 mm thermal receipts ------------------------------------------- */

const T = { fontFamily: "'Segoe UI', Arial, sans-serif", color: '#000' }
function ThermalHead({ b, title, no }: { b: Branding; title: string; no: string }) {
  return (
    <div style={{ textAlign: 'center', borderBottom: '1px dashed #000', paddingBottom: '2mm', marginBottom: '2mm' }}>
      {b.logo && <img src={b.logo} alt="" style={{ maxHeight: '14mm', maxWidth: '40mm', objectFit: 'contain', margin: '0 auto 1mm', display: 'block' }} />}
      <div style={{ fontSize: '14px', fontWeight: 800 }}>{b.companyName}</div>
      {b.address && <div style={{ fontSize: '10px' }}>{b.address}</div>}
      <div style={{ fontSize: '10px' }}>{[b.phone, b.email].filter(Boolean).join(', ')}</div>
      <div style={{ fontSize: '13px', fontWeight: 800, marginTop: '2mm', letterSpacing: '0.08em' }}>{title}</div>
      <div style={{ fontSize: '11px', fontWeight: 700 }}>{no}</div>
    </div>
  )
}
function TRow({ k, v, bold }: { k: string; v: string; bold?: boolean }) {
  return <div style={{ display: 'flex', justifyContent: 'space-between', gap: '2mm', fontSize: bold ? '12px' : '11px', fontWeight: bold ? 800 : 400 }}><span>{k}</span><span style={{ textAlign: 'right' }}>{v}</span></div>
}

/** Compact invoice for an 80 mm thermal printer (72 mm printable). */
export function ThermalInvoice({ inv, b }: { inv: Invoice; b: Branding }) {
  const [qr, setQr] = useState('')
  const url = verifyUrl(inv.verifyToken, b.verifyBaseUrl)
  useEffect(() => { qrDataUrl(url, 180).then(setQr).catch(() => setQr('')) }, [url])
  const cur = inv.currency
  return (
    <div className="dt-thermal" style={{ ...T, width: '72mm', fontSize: '11px' }}>
      <ThermalHead b={b} title={inv.status === 'cancelled' ? 'INVOICE - CANCELLED' : 'INVOICE'} no={inv.number} />
      <TRow k="Date" v={fmtDate(inv.issueDate)} />
      <TRow k="Due" v={fmtDate(inv.dueDate)} />
      <TRow k="Customer" v={inv.clientName} />
      <div style={{ borderTop: '1px dashed #000', margin: '2mm 0' }} />
      {inv.lines.map((l, i) => (
        <div key={i} style={{ marginBottom: '1mm' }}>
          <div>{l.description}</div>
          <TRow k={`${l.qty} × ${money(l.rate, '')}`} v={money(l.amount, '')} />
        </div>
      ))}
      <div style={{ borderTop: '1px dashed #000', margin: '2mm 0' }} />
      <TRow k="Subtotal" v={money(inv.subtotal, cur)} />
      {inv.discount > 0 && <TRow k="Discount" v={`− ${money(inv.discount, cur)}`} />}
      {inv.taxAmount > 0 && <TRow k={`${b.taxName || 'Tax'} (${inv.taxRate}%)`} v={money(inv.taxAmount, cur)} />}
      <TRow k="TOTAL" v={money(inv.total, cur)} bold />
      <TRow k="Paid" v={money(inv.paid, cur)} />
      <TRow k="Balance due" v={money(inv.status === 'cancelled' ? 0 : inv.balance, cur)} bold />
      {qr && <div style={{ textAlign: 'center', marginTop: '2mm' }}><img src={qr} alt="Verification QR code" style={{ width: '28mm', height: '28mm', display: 'block', margin: '0 auto' }} /><div style={{ fontSize: '9px' }}>Scan to verify</div></div>}
      <div style={{ fontSize: '9px', textAlign: 'center', marginTop: '1mm', wordBreak: 'break-all' }}>{url}</div>
      {b.invoiceFooter && <div style={{ fontSize: '9.5px', textAlign: 'center', marginTop: '2mm' }}>{b.invoiceFooter}</div>}
    </div>
  )
}

/** Payment receipt for an 80 mm thermal printer. */
export function ThermalReceipt({ inv, pay, b }: { inv: Invoice; pay: InvoicePayment; b: Branding }) {
  const cur = inv.currency
  return (
    <div className="dt-thermal" style={{ ...T, width: '72mm', fontSize: '11px' }}>
      <ThermalHead b={b} title={pay.cancelled ? 'RECEIPT - VOID' : 'PAYMENT RECEIPT'} no={pay.receiptNo} />
      <TRow k="Date" v={fmtDate(pay.date)} />
      <TRow k="Received from" v={inv.clientName} />
      <TRow k="Invoice" v={inv.number} />
      <TRow k="Method" v={pay.method || '-'} />
      {pay.reference && <TRow k="Reference" v={pay.reference} />}
      <div style={{ borderTop: '1px dashed #000', margin: '2mm 0' }} />
      <TRow k="AMOUNT" v={money(pay.amount, cur)} bold />
      <TRow k="Invoice total" v={money(inv.total, cur)} />
      <TRow k="Balance now" v={money(inv.status === 'cancelled' ? 0 : inv.balance, cur)} />
      <div style={{ borderTop: '1px dashed #000', margin: '2mm 0' }} />
      <div style={{ fontSize: '9.5px', textAlign: 'center' }}>{b.invoiceFooter || 'Thank you for your payment.'}</div>
    </div>
  )
}
