/** Shared billing hooks + small components. */
import { ReactNode, useMemo } from 'react'
import { createPortal } from 'react-dom'
import { collection, getDocs } from 'firebase/firestore'
import { db } from '../../firebase'
import { clientFromSnap, invoiceFromSnap, paymentFromSnap, paymentsCol } from '../../lib/invoices'
import { useSharedBranding, useSharedDocs } from '../../lib/liveData'
import { cachedFetch } from '../../lib/queryCache'
import { displayStatus, type DisplayStatus } from '../../lib/billing'
import { toDate } from '../../lib/format'
import type { Branding, Client, Invoice, InvoicePayment } from '../../lib/types'
import { cx } from '../../components/ui'

/** All invoices, newest first — one shared live listener (also used by the Dashboard), so nothing is re-read on navigation. */
export function useInvoices(): { invoices: Invoice[]; loading: boolean; error: string | null; retry: () => void } {
  const s = useSharedDocs('invoices', () => collection(db, 'invoices'))
  const invoices = useMemo(() => s.docs.map(invoiceFromSnap).sort((a, b) => (b.createdAt?.toMillis() ?? 0) - (a.createdAt?.toMillis() ?? 0)), [s.docs])
  return { invoices, loading: s.loading, error: s.error, retry: s.retry }
}

/** Clients sorted by company (shared live listener). */
export function useClients(enabled: boolean): Client[] {
  const s = useSharedDocs('clients', () => collection(db, 'clients'), enabled)
  return useMemo(() => s.docs.map(clientFromSnap).sort((a, b) => (a.company || '').localeCompare(b.company || '')), [s.docs])
}

export function useBranding(): Branding {
  return useSharedBranding()
}

export interface PaymentRow extends InvoicePayment { invoiceId: string; invoiceNumber: string; clientName: string; currency: string }

/**
 * Payments of the given invoices (payments are sub-collections; the rules have no collection-group read), 6 in flight,
 * cached for 2 minutes under a key that changes whenever an invoice's paid amount or last payment changes.
 */
export function loadInvoicePayments(list: Invoice[]): Promise<PaymentRow[]> {
  const withPay = list.filter((i) => i.lastPaymentAt || i.paid > 0)
  const key = `payments:all:${withPay.map((i) => `${i.id}:${i.paid}:${i.lastPaymentAt?.toMillis() ?? 0}`).join(',')}`
  return cachedFetch(
    key,
    async () => {
      const out: PaymentRow[][] = new Array(withPay.length)
      let k = 0
      const worker = async () => {
        while (k < withPay.length) {
          const idx = k++
          const i = withPay[idx]
          const snap = await getDocs(paymentsCol(i.id))
          out[idx] = snap.docs.map((d) => ({ ...paymentFromSnap(d), invoiceId: i.id, invoiceNumber: i.number, clientName: i.clientName, currency: i.currency }))
        }
      }
      await Promise.all(Array.from({ length: Math.min(6, withPay.length) }, worker))
      return out.flat().sort((a, b) => (b.date?.toMillis() ?? 0) - (a.date?.toMillis() ?? 0))
    },
    120_000
  )
}

export function invStatus(i: Invoice): DisplayStatus {
  return displayStatus({ status: i.status, balance: i.balance, dueDate: toDate(i.dueDate) })
}

const STATUS_TONE: Record<string, string> = {
  paid: 'bg-green-100 text-green-700',
  partial: 'bg-sky-100 text-sky-700',
  unpaid: 'bg-amber-100 text-amber-700',
  overdue: 'bg-red-100 text-red-700',
  cancelled: 'bg-slate-200 text-slate-600'
}
export function StatusPill({ status }: { status: string }) {
  return <span className={cx('inline-block rounded-md px-2 py-0.5 text-[11.5px] font-bold capitalize', STATUS_TONE[status] ?? 'bg-[#f1e9fb] text-[#3d096d]')}>{status}</span>
}

export function ErrorBox({ children }: { children: ReactNode }) {
  return <div className="mt-3 rounded-lg bg-red-50 p-3 text-[13px] text-red-700">{children}</div>
}

export type Paper = 'a4' | '80mm'

/**
 * Renders children into a body-level node that is the only thing printed. `paper` selects the print CSS:
 * A4 (`@page size A4`) or an 80 mm thermal roll (`@page size 80mm auto`, no margins, 72 mm printable width).
 */
export function PrintPortal({ children, paper = 'a4' }: { children: ReactNode; paper?: Paper }) {
  const page = paper === '80mm' ? '@page { size: 80mm auto; margin: 0; }' : '@page { size: A4; margin: 0; }'
  return createPortal(
    <div className={`dt-print-root dt-paper-${paper}`}>
      <style>{`
        .dt-print-root { display: none; }
        @media print {
          ${page}
          html, body, #root { height: auto !important; overflow: visible !important; }
          body > *:not(.dt-print-root) { display: none !important; }
          body { background: #fff !important; margin: 0 !important; }
          .dt-print-root { display: block; color: #1a1030; font-size: 12px; }
          .dt-print-root * { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
          .dt-print-root .dt-a4 { width: 210mm !important; box-shadow: none !important; }
          .dt-paper-80mm .dt-thermal { width: 72mm !important; margin: 0 auto; padding: 3mm 0 6mm; color: #000; }
        }
      `}</style>
      {children}
    </div>,
    document.body
  )
}

/** Prints the current PrintPortal content; the document title becomes the suggested PDF file name ("Save as PDF"). */
export function printNow(title: string) {
  const prev = document.title
  document.title = title
  const restore = () => {
    document.title = prev
    window.removeEventListener('afterprint', restore)
  }
  window.addEventListener('afterprint', restore)
  // Let React commit the print content (and images decode) first.
  setTimeout(() => {
    window.print()
    setTimeout(restore, 1000)
  }, 200)
}

/** Copies text to the clipboard (with a fallback for non-secure contexts). */
export async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text)
  } catch {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    const ok = document.execCommand('copy')
    ta.remove()
    if (!ok) throw new Error('Copy is blocked by this browser — select the link and copy it manually.')
  }
}

/** International WhatsApp number from a Pakistani / international phone ("0300-1234567" → "923001234567"); '' if unusable. */
export function waNumber(phone: string): string {
  let d = (phone || '').replace(/\D/g, '')
  if (d.startsWith('00')) d = d.slice(2)
  if (d.startsWith('0')) d = '92' + d.slice(1)
  return /^\d{10,15}$/.test(d) ? d : ''
}

export function downloadCsv(name: string, csv: string) {
  const a = document.createElement('a')
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }))
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 2000)
}
