/** Public invoice verification page opened from the invoice QR code (/v/<token>). No login; reads only public documents. */
import { useEffect, useState } from 'react'
import { doc, getDoc, Timestamp } from 'firebase/firestore'
import { AlertTriangle, BadgeCheck, Ban, Loader2, ShieldX, WifiOff } from 'lucide-react'
import { db } from '../../firebase'
import { isValidToken, money } from '../../lib/billing'

interface PublicInvoice {
  number: string
  issuerName: string
  issuerPhone: string
  issuerEmail: string
  issuerAddress: string
  issuerLogo: string | null
  customerName: string
  issueDate: Date | null
  dueDate: Date | null
  currency: string
  total: number
  paymentStatus: 'paid' | 'partial' | 'unpaid'
  status: 'valid' | 'cancelled'
  lines: { description: string; qty: number; amount: number }[]
}
interface PublicBrand { companyName?: string; logo?: string | null; phone?: string; email?: string; website?: string; address?: string }

type State = { kind: 'loading' } | { kind: 'invalid' } | { kind: 'error' } | { kind: 'ok'; inv: PublicInvoice; brand: PublicBrand; at: Date }

const str = (v: unknown) => (typeof v === 'string' ? v : '')
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
const date = (v: unknown) => (v instanceof Timestamp ? v.toDate() : null)
const fmt = (d: Date | null) => (d ? d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '—')

function parse(d: Record<string, unknown>): PublicInvoice {
  return {
    number: str(d.number), issuerName: str(d.issuerName), issuerPhone: str(d.issuerPhone), issuerEmail: str(d.issuerEmail), issuerAddress: str(d.issuerAddress),
    issuerLogo: str(d.issuerLogo) || null, customerName: str(d.customerName), issueDate: date(d.issueDate), dueDate: date(d.dueDate), currency: str(d.currency) || 'PKR',
    total: num(d.total), paymentStatus: (['paid', 'partial'].includes(str(d.paymentStatus)) ? d.paymentStatus : 'unpaid') as PublicInvoice['paymentStatus'],
    status: d.status === 'cancelled' ? 'cancelled' : 'valid',
    lines: Array.isArray(d.lines) ? d.lines.map((l: Record<string, unknown>) => ({ description: str(l?.description), qty: num(l?.qty), amount: num(l?.amount) })) : []
  }
}

export function VerifyInvoice({ token }: { token: string }) {
  const [state, setState] = useState<State>({ kind: 'loading' })
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    document.title = 'Verify invoice · Digital Target'
    if (!isValidToken(token)) { setState({ kind: 'invalid' }); return }
    let alive = true
    setState({ kind: 'loading' })
    ;(async () => {
      try {
        const s = await getDoc(doc(db, 'publicInvoices', token))
        if (!s.exists()) { if (alive) setState({ kind: 'invalid' }); return }
        let brand: PublicBrand = {}
        try { const b = await getDoc(doc(db, 'publicSettings', 'branding')); brand = (b.data() as PublicBrand) ?? {} } catch { /* branding is optional */ }
        if (alive) setState({ kind: 'ok', inv: parse(s.data()), brand, at: new Date() })
      } catch (e) {
        const code = (e as { code?: string })?.code
        if (alive) setState(code === 'permission-denied' || code === 'invalid-argument' ? { kind: 'invalid' } : { kind: 'error' })
      }
    })()
    return () => { alive = false }
  }, [token, attempt])

  const brand = state.kind === 'ok' ? state.brand : {}
  const company = (state.kind === 'ok' && state.inv.issuerName) || brand.companyName || 'Digital Target'
  const logo = (state.kind === 'ok' && state.inv.issuerLogo) || brand.logo || null

  return (
    <div className="min-h-screen px-4 py-6 text-[#1d1530] sm:py-10" style={{ background: 'linear-gradient(180deg, #2a0650 0, #3d096d 220px, #f4effa 220px)' }}>
      <div className="mx-auto max-w-xl">
        <div className="mb-5 flex items-center gap-3 text-white">
          {logo ? <img src={logo} alt="" className="h-11 w-11 rounded-xl bg-white object-contain p-1" /> : <div className="grid h-11 w-11 place-items-center rounded-xl bg-white/15 text-[16px] font-black">DT</div>}
          <div>
            <div className="text-[17px] font-extrabold leading-tight">{company}</div>
            <div className="text-[12px] text-white/70">Invoice verification</div>
          </div>
        </div>

        <div className="overflow-hidden rounded-2xl bg-white shadow-xl">
          {state.kind === 'loading' && <div className="flex items-center justify-center gap-2 px-6 py-16 text-[14px] text-[#6b5d85]"><Loader2 className="h-5 w-5 animate-spin text-[#3d096d]" /> Checking invoice…</div>}
          {state.kind === 'invalid' && (
            <Banner tone="bad" icon={<ShieldX className="h-9 w-9" />} title="Invalid invoice" text="This code does not match any invoice issued by Digital Target. The document may be forged or the code damaged. Please contact us before making any payment." />
          )}
          {state.kind === 'error' && (
            <>
              <Banner tone="warn" icon={<WifiOff className="h-9 w-9" />} title="Could not check right now" text="We could not reach the verification service. Check your internet connection and try again." />
              <div className="p-4 text-center"><button className="btn btn-primary" onClick={() => setAttempt((a) => a + 1)}>Try again</button></div>
            </>
          )}
          {state.kind === 'ok' && (
            <>
              {state.inv.status === 'cancelled'
                ? <Banner tone="bad" icon={<Ban className="h-9 w-9" />} title="Cancelled invoice" text="This invoice was issued by Digital Target but has since been cancelled. It is no longer payable." />
                : <Banner tone="good" icon={<BadgeCheck className="h-9 w-9" />} title="Verified invoice" text={`This invoice is genuine and was issued by ${company}.`} />}
              <div className="space-y-4 p-5">
                <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-[13.5px]">
                  <Item k="Invoice number" v={<span className="font-mono font-bold">{state.inv.number}</span>} />
                  <Item k="Customer" v={state.inv.customerName || <span className="text-[#7a6d92]">Not published</span>} />
                  <Item k="Issue date" v={fmt(state.inv.issueDate)} />
                  <Item k="Due date" v={fmt(state.inv.dueDate)} />
                </dl>
                {state.inv.lines.length > 0 && (
                  <div className="rounded-xl border border-[#ece6f4]">
                    {state.inv.lines.map((l, i) => (
                      <div key={i} className="flex items-start justify-between gap-3 border-b border-[#f1ecf7] px-3.5 py-2 text-[13px] last:border-b-0">
                        <span>{l.description}{l.qty !== 1 && <span className="text-[#7a6d92]"> × {l.qty}</span>}</span>
                        <span className="shrink-0 font-semibold">{money(l.amount, '')}</span>
                      </div>
                    ))}
                  </div>
                )}
                <div className="flex items-center justify-between rounded-xl bg-[#f6f0fd] px-4 py-3">
                  <span className="font-semibold text-[#6b5d85]">Invoice total</span>
                  <span className="text-[20px] font-extrabold text-[#3d096d]">{money(state.inv.total, state.inv.currency)}</span>
                </div>
                <div className="rounded-xl border border-[#ece6f4] px-4 py-3">
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-[13px] font-semibold">Payment status</span>
                    <PayTag s={state.inv.status === 'cancelled' ? 'cancelled' : state.inv.paymentStatus} />
                  </div>
                  <div className="mt-1.5 flex gap-1.5 text-[11.5px] text-[#7a6d92]"><AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />Payment status as recorded by Digital Target. The QR code proves the invoice is authentic — not that it has been paid.</div>
                </div>
                <div className="text-center text-[11.5px] text-[#7a6d92]">Verified at {state.at.toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })}</div>
              </div>
            </>
          )}
        </div>

        <div className="mt-5 text-center text-[12px] text-[#6b5d85]">
          {[state.kind === 'ok' ? state.inv.issuerPhone || brand.phone : brand.phone, state.kind === 'ok' ? state.inv.issuerEmail || brand.email : brand.email, brand.website].filter(Boolean).join(' · ')}
          <div className="mt-1">DT Solar Pro · by Digital Target</div>
        </div>
      </div>
    </div>
  )
}

function Banner({ tone, icon, title, text }: { tone: 'good' | 'bad' | 'warn'; icon: React.ReactNode; title: string; text: string }) {
  const cls = tone === 'good' ? 'bg-green-50 text-green-800' : tone === 'bad' ? 'bg-red-50 text-red-800' : 'bg-amber-50 text-amber-900'
  return (
    <div className={`flex items-start gap-3 px-5 py-5 ${cls}`} role="status" data-verify-state={title}>
      <div className="shrink-0">{icon}</div>
      <div><div className="text-[19px] font-extrabold">{title}</div><div className="mt-0.5 text-[13px] opacity-90">{text}</div></div>
    </div>
  )
}

function Item({ k, v }: { k: string; v: React.ReactNode }) {
  return <div><dt className="text-[11.5px] font-semibold uppercase tracking-wide text-[#7a6d92]">{k}</dt><dd className="mt-0.5 font-semibold">{v}</dd></div>
}

function PayTag({ s }: { s: 'paid' | 'partial' | 'unpaid' | 'cancelled' }) {
  const m = { paid: ['Paid', 'bg-green-100 text-green-700'], partial: ['Partially paid', 'bg-sky-100 text-sky-700'], unpaid: ['Unpaid', 'bg-amber-100 text-amber-800'], cancelled: ['Cancelled', 'bg-slate-200 text-slate-700'] }[s]
  return <span className={`rounded-lg px-2.5 py-1 text-[12.5px] font-bold ${m[1]}`}>{m[0]}</span>
}
