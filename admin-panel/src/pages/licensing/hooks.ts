/** Live data hooks shared by the licensing pages. Each hook only subscribes when the admin may read the data. */
import { useMemo, useState } from 'react'
import { collection, query, where } from 'firebase/firestore'
import { db } from '../../firebase'
import { useCan } from '../../lib/auth'
import { invoiceRow, type InvoiceRow } from '../../lib/fleet'
import { useSharedBranding, useSharedClients, useSharedDocs, useSharedLicenses } from '../../lib/liveData'
import { isSharedLive } from '../../lib/queryCache'
import type { Branding, Client, License } from '../../lib/types'

export interface Live<T> {
  data: T
  loading: boolean
  error: string | null
}

export const LICENSE_READ_PERMS = ['licenses.view', 'licenses.manage', 'licenses.generate', 'devices.view', 'devices.manage', 'verify.use', 'billing.create', 'clients.view']
export const BILLING_READ_PERMS = ['billing.view', 'billing.create', 'billing.payments']
export const HEARTBEAT_READ_PERMS = ['devices.view', 'devices.manage', 'licenses.view']
export const DEVICE_READ_PERMS = ['licenses.view', 'licenses.manage', 'devices.view', 'devices.manage']

export function useCanAny(): (perms: string[]) => boolean {
  const can = useCan()
  return (perms: string[]) => perms.some(can)
}

/** All licenses, newest first (live). Shared listener (lib/liveData): pages opened one after another read it once. */
export function useLicenses(enabled = true): Live<License[]> {
  const s = useSharedLicenses(enabled)
  return useMemo(() => ({ data: s.data, loading: s.loading, error: s.error }), [s.data, s.loading, s.error])
}

/** All clients (live, shared) when the admin holds clients.view. */
export function useClients(enabled = true): Live<Client[]> {
  const s = useSharedClients(enabled)
  return useMemo(() => ({ data: s.data, loading: s.loading, error: s.error }), [s.data, s.loading, s.error])
}

/**
 * Invoices (read-only), optionally only those of one client / license. Live and shared: when the all-invoices
 * listener is already open (Dashboard / Billing visited in the last minute) the filter runs on it — no new read;
 * otherwise only the matching invoices are queried.
 */
export function useInvoices(enabled: boolean, filter?: { field: 'clientId' | 'licenseId'; value: string }): Live<InvoiceRow[]> {
  const field = filter?.field
  const value = filter?.value
  const [useAll] = useState(() => !field || isSharedLive('invoices'))
  const key = useAll ? 'invoices' : `invoices:${field}:${value}`
  const s = useSharedDocs(key, () => (useAll || !field || !value ? collection(db, 'invoices') : query(collection(db, 'invoices'), where(field, '==', value))), enabled && (!field || !!value))
  const data = useMemo(() => {
    const rows = s.docs.map(invoiceRow)
    return (field && value ? rows.filter((r) => r[field] === value) : rows).sort((a, b) => (b.issueDateMs ?? 0) - (a.issueDateMs ?? 0))
  }, [s.docs, field, value])
  return useMemo(() => ({ data, loading: s.loading, error: s.error }), [data, s.loading, s.error])
}

/** settings/branding merged over the defaults (cached for every page; Settings refreshes it on save). */
export function useBranding(): Branding {
  return useSharedBranding()
}
