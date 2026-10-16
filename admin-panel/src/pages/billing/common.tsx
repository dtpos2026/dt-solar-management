/** Shared billing hooks + small components. */
import { ReactNode, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { getDocs, onSnapshot, orderBy, query, collection } from 'firebase/firestore'
import { db } from '../../firebase'
import { clientFromSnap, invoiceFromSnap, invoicesCol, loadBranding } from '../../lib/invoices'
import { displayStatus, type DisplayStatus } from '../../lib/billing'
import { errorMessage, toDate } from '../../lib/format'
import { DEFAULT_BRANDING, type Branding, type Client, type Invoice } from '../../lib/types'
import { cx } from '../../components/ui'

export function useInvoices(): { invoices: Invoice[]; loading: boolean; error: string | null } {
  const [invoices, setInvoices] = useState<Invoice[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  useEffect(
    () =>
      onSnapshot(
        query(invoicesCol(), orderBy('createdAt', 'desc')),
        (r) => { setInvoices(r.docs.map(invoiceFromSnap)); setLoading(false) },
        (e) => { setError(errorMessage(e)); setLoading(false) }
      ),
    []
  )
  return { invoices, loading, error }
}

export function useClients(enabled: boolean): Client[] {
  const [clients, setClients] = useState<Client[]>([])
  useEffect(() => {
    if (!enabled) return
    getDocs(collection(db, 'clients'))
      .then((r) => setClients(r.docs.map(clientFromSnap).sort((a, b) => (a.company || '').localeCompare(b.company || ''))))
      .catch(() => setClients([]))
  }, [enabled])
  return clients
}

export function useBranding(): Branding {
  const [b, setB] = useState<Branding>(DEFAULT_BRANDING)
  useEffect(() => { loadBranding().then(setB) }, [])
  return b
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
