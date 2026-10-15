/** Live data hooks shared by the licensing pages. Each hook only subscribes when the admin may read the data. */
import { useEffect, useState } from 'react'
import { collection, onSnapshot, query, where } from 'firebase/firestore'
import { db } from '../../firebase'
import { useCan } from '../../lib/auth'
import { clientFromSnap, clientsCol } from '../../lib/clientsDb'
import { invoiceRow, loadBranding, type InvoiceRow } from '../../lib/fleet'
import { errorMessage } from '../../lib/format'
import { licenseFromSnap, licensesCol } from '../../lib/licenses'
import { DEFAULT_BRANDING, type Branding, type Client, type License } from '../../lib/types'

export interface Live<T> {
  data: T
  loading: boolean
  error: string | null
}

const byCreatedDesc = <T extends { createdAt: { toMillis(): number } | null }>(a: T, b: T) => (b.createdAt?.toMillis() ?? 0) - (a.createdAt?.toMillis() ?? 0)

export const LICENSE_READ_PERMS = ['licenses.view', 'licenses.manage', 'licenses.generate', 'devices.view', 'devices.manage', 'verify.use', 'billing.create', 'clients.view']
export const BILLING_READ_PERMS = ['billing.view', 'billing.create', 'billing.payments']
export const HEARTBEAT_READ_PERMS = ['devices.view', 'devices.manage', 'licenses.view']
export const DEVICE_READ_PERMS = ['licenses.view', 'licenses.manage', 'devices.view', 'devices.manage']

export function useCanAny(): (perms: string[]) => boolean {
  const can = useCan()
  return (perms: string[]) => perms.some(can)
}

/** All licenses, newest first (live). Sorted client-side so documents without createdAt are not dropped. */
export function useLicenses(enabled = true): Live<License[]> {
  const [s, set] = useState<Live<License[]>>({ data: [], loading: enabled, error: null })
  useEffect(() => {
    if (!enabled) return set({ data: [], loading: false, error: null })
    return onSnapshot(
      licensesCol(),
      (snap) => set({ data: snap.docs.map(licenseFromSnap).sort(byCreatedDesc), loading: false, error: null }),
      (e) => set({ data: [], loading: false, error: errorMessage(e) })
    )
  }, [enabled])
  return s
}

/** All clients (live) when the admin holds clients.view. */
export function useClients(enabled = true): Live<Client[]> {
  const [s, set] = useState<Live<Client[]>>({ data: [], loading: enabled, error: null })
  useEffect(() => {
    if (!enabled) return set({ data: [], loading: false, error: null })
    return onSnapshot(
      clientsCol(),
      (snap) => set({ data: snap.docs.map(clientFromSnap).sort(byCreatedDesc), loading: false, error: null }),
      (e) => set({ data: [], loading: false, error: errorMessage(e) })
    )
  }, [enabled])
  return s
}

/** Invoices (read-only), optionally only those of one client / license. */
export function useInvoices(enabled: boolean, filter?: { field: 'clientId' | 'licenseId'; value: string }): Live<InvoiceRow[]> {
  const [s, set] = useState<Live<InvoiceRow[]>>({ data: [], loading: enabled, error: null })
  const field = filter?.field
  const value = filter?.value
  useEffect(() => {
    if (!enabled || (field && !value)) return set({ data: [], loading: false, error: null })
    const col = collection(db, 'invoices')
    return onSnapshot(
      field && value ? query(col, where(field, '==', value)) : col,
      (snap) => set({ data: snap.docs.map(invoiceRow).sort((a, b) => (b.issueDateMs ?? 0) - (a.issueDateMs ?? 0)), loading: false, error: null }),
      (e) => set({ data: [], loading: false, error: errorMessage(e) })
    )
  }, [enabled, field, value])
  return s
}

/** settings/branding merged over the defaults (read once). */
export function useBranding(): Branding {
  const [b, setB] = useState<Branding>(DEFAULT_BRANDING)
  useEffect(() => {
    let alive = true
    loadBranding().then((x) => alive && setB(x))
    return () => {
      alive = false
    }
  }, [])
  return b
}
