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

/** Renders children into a body-level node that is the only thing printed (A4). */
export function PrintPortal({ children }: { children: ReactNode }) {
  return createPortal(
    <div className="dt-print-root">
      <style>{`
        .dt-print-root { display: none; }
        @media print {
          @page { size: A4; margin: 12mm; }
          body > *:not(.dt-print-root) { display: none !important; }
          body { background: #fff !important; }
          .dt-print-root { display: block; color: #1a1030; font-size: 12px; }
          .dt-print-root * { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
          .dt-print-root .dt-a4 { width: auto !important; min-height: 270mm !important; padding: 0 !important; box-shadow: none !important; }
          .dt-print-root .dt-a4 > .absolute.bottom-6 { left: 0; right: 0; bottom: 0; }
        }
      `}</style>
      {children}
    </div>,
    document.body
  )
}

export function downloadCsv(name: string, csv: string) {
  const a = document.createElement('a')
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }))
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 2000)
}
