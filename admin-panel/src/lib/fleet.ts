/**
 * Loading helpers shared by the Dashboard, Clients, Devices and Device Map pages.
 * collectionGroup queries are not allowed by the rules. Devices come from the denormalised
 * license.devicesSummary (kept in sync by every device transaction), so the fleet costs one licenses query
 * plus one heartbeats query; only licenses without a summary yet (created before it existed) are read
 * license by license, and are backfilled once by an admin with devices.manage.
 */
import { Timestamp, collection, doc, getDoc, getDocs, query, where, type DocumentData, type QueryDocumentSnapshot } from 'firebase/firestore'
import { db } from '../firebase'
import { backfillSummary, deviceFromSnap, invalidateLicenses, licensesGeneration, devicesCol, licenseFromSnap, licensesCol } from './licenses'
import type { DeviceInfoLike, HeartbeatLike, LicenseInfo } from './devices'
import { normaliseDeviceStatus } from './devices'
import { validLocation } from './devices'
import type { InvoiceLike, PaymentLike } from './stats'
import { DEFAULT_BRANDING, type Branding, type Device, type Heartbeat, type License } from './types'

const str = (v: unknown) => (typeof v === 'string' ? v : '')
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
const ms = (v: unknown): number | null => (v instanceof Timestamp ? v.toMillis() : typeof v === 'string' && v ? Date.parse(v) || null : null)

export const heartbeatsCol = () => collection(db, 'heartbeats')

export function heartbeatFromSnap(s: QueryDocumentSnapshot<DocumentData>): Heartbeat {
  const d = s.data() ?? {}
  return {
    id: s.id,
    deviceId: str(d.deviceId),
    licenseId: str(d.licenseId),
    deviceName: str(d.deviceName),
    os: str(d.os),
    appVersion: str(d.appVersion),
    companyName: str(d.companyName),
    mode: str(d.mode),
    lastCheckAt: str(d.lastCheckAt),
    firms: num(d.firms),
    users: num(d.users),
    lastSeen: d.lastSeen instanceof Timestamp ? d.lastSeen : null,
    location: validLocation(d.location)
  }
}

export function heartbeatLike(h: Heartbeat): HeartbeatLike & { firms: number; users: number } {
  return { ...h, lastSeenMs: h.lastSeen ? h.lastSeen.toMillis() : null, firms: h.firms, users: h.users }
}

export function licenseInfo(l: License): LicenseInfo {
  return {
    id: l.id,
    licenseKey: l.licenseKey,
    businessName: l.businessName,
    customerName: l.customerName,
    clientId: l.clientId,
    status: l.status,
    expiresAtMs: l.expiresAt ? l.expiresAt.toMillis() : null,
    activeDevices: l.activeDevices,
    maxDevices: l.maxDevices,
    activatedAtMs: l.activatedAt ? l.activatedAt.toMillis() : null,
    detached: l.detached
  }
}

export function deviceInfo(d: Device): DeviceInfoLike {
  return {
    deviceId: d.deviceId,
    deviceName: d.deviceName,
    os: d.os,
    appVersion: d.appVersion,
    status: normaliseDeviceStatus(d.status),
    activatedAtMs: d.activatedAt ? d.activatedAt.toMillis() : null,
    activationType: d.activationType,
    statusNote: d.statusNote ?? ''
  }
}

/** Runs `fn` over items with at most `n` in flight. */
export async function mapLimit<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let i = 0
  const worker = async () => {
    while (i < items.length) {
      const k = i++
      out[k] = await fn(items[k])
    }
  }
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker))
  return out
}

/*
 * Short-lived cache of the licenses list, shared by pages opened one after another (Dashboard → Devices → Map)
 * and by concurrent callers (one request in flight). It is dropped by invalidateLicenses() after every portal
 * mutation (writeLog calls it) and bypassed by an explicit Refresh. The TTL is short so a license suspended by
 * another admin is not shown as active for long; pages that act on a license read it again in a transaction.
 */
export const LICENSES_CACHE_MS = 15_000
let licCache: { at: number; gen: number; data: License[] } | null = null
let licInflight: { gen: number; p: Promise<License[]> } | null = null
export { invalidateLicenses }

export async function loadLicenses(opts: { fresh?: boolean } = {}): Promise<License[]> {
  const gen = licensesGeneration()
  if (!opts.fresh && licCache && licCache.gen === gen && Date.now() - licCache.at < LICENSES_CACHE_MS) return licCache.data
  if (!opts.fresh && licInflight && licInflight.gen === gen) return licInflight.p
  const p = getDocs(licensesCol()).then((snap) => {
    const data = snap.docs.map(licenseFromSnap).sort((a, b) => (b.createdAt?.toMillis() ?? 0) - (a.createdAt?.toMillis() ?? 0))
    if (gen === licensesGeneration()) licCache = { at: Date.now(), gen, data }
    return data
  })
  licInflight = { gen, p }
  try {
    return await p
  } finally {
    if (licInflight?.p === p) licInflight = null
  }
}

/**
 * Device rows of every license: from license.devicesSummary when present (no extra read), otherwise from the
 * devices sub-collection (8 in parallel). With `backfill` (admin holds devices.manage) a license read that way
 * gets its summary written once, guarded by its updatedAt.
 */
export async function loadDeviceInfos(licenses: License[], opts: { backfill?: boolean } = {}): Promise<Record<string, DeviceInfoLike[]>> {
  const out: Record<string, DeviceInfoLike[]> = {}
  const missing: License[] = []
  for (const l of licenses) {
    if (l.devicesSummary === null) {
      missing.push(l)
      continue
    }
    out[l.id] = Object.entries(l.devicesSummary).map(([deviceId, d]) => ({
      deviceId,
      deviceName: d.deviceName,
      os: d.os,
      appVersion: d.appVersion,
      status: normaliseDeviceStatus(d.status),
      activatedAtMs: d.activatedAtMs,
      activationType: d.activationType,
      statusNote: d.statusNote
    }))
  }
  await mapLimit(missing, 8, async (l) => {
    const snap = await getDocs(devicesCol(l.id))
    out[l.id] = snap.docs.map(deviceFromSnap).map(deviceInfo)
    if (opts.backfill) await backfillSummary(l.id, snap.docs, l.updatedAt ? l.updatedAt.toMillis() : null).catch(() => false)
  })
  return out
}

export async function loadDevicesFor(licenses: License[]): Promise<Record<string, Device[]>> {
  const lists = await mapLimit(licenses, 8, async (l) => (await getDocs(devicesCol(l.id))).docs.map(deviceFromSnap))
  const out: Record<string, Device[]> = {}
  licenses.forEach((l, i) => (out[l.id] = lists[i]))
  return out
}

export async function loadHeartbeats(): Promise<Heartbeat[]> {
  const snap = await getDocs(heartbeatsCol())
  return snap.docs.map(heartbeatFromSnap)
}

export async function loadHeartbeatsForLicenses(licenseIds: string[]): Promise<Heartbeat[]> {
  const out: Heartbeat[] = []
  for (let i = 0; i < licenseIds.length; i += 30) {
    const chunk = licenseIds.slice(i, i + 30)
    const snap = await getDocs(query(heartbeatsCol(), where('licenseId', 'in', chunk)))
    out.push(...snap.docs.map(heartbeatFromSnap))
  }
  return out
}

/** settings/branding merged over the defaults (any admin may read it). */
export async function loadBranding(): Promise<Branding> {
  try {
    const s = await getDoc(doc(db, 'settings', 'branding'))
    return { ...DEFAULT_BRANDING, ...((s.exists() ? s.data() : {}) as Partial<Branding>) }
  } catch {
    return { ...DEFAULT_BRANDING }
  }
}

/* -------------------------------------------- billing (read-only) -------------------------------------------- */

export interface InvoiceRow extends InvoiceLike {
  id: string
  number: string
  clientName: string
  currency: string
  licenseId: string
  clientId: string
  createdAtMs: number | null
  lastPaymentAtMs: number | null
}

export function invoiceRow(s: QueryDocumentSnapshot<DocumentData>): InvoiceRow {
  const d = s.data() ?? {}
  return {
    id: s.id,
    number: str(d.number),
    clientName: str(d.clientName),
    currency: str(d.currency) || 'PKR',
    status: str(d.status) || 'unpaid',
    total: num(d.total),
    paid: num(d.paid),
    balance: num(d.balance),
    issueDateMs: ms(d.issueDate) ?? ms(d.createdAt),
    dueDateMs: ms(d.dueDate),
    licenseId: str(d.licenseId),
    clientId: str(d.clientId),
    createdAtMs: ms(d.createdAt),
    lastPaymentAtMs: ms(d.lastPaymentAt)
  }
}

export async function loadInvoices(filter?: { field: 'clientId' | 'licenseId'; value: string }): Promise<InvoiceRow[]> {
  const col = collection(db, 'invoices')
  const snap = await getDocs(filter ? query(col, where(filter.field, '==', filter.value)) : col)
  return snap.docs.map(invoiceRow).sort((a, b) => (b.issueDateMs ?? 0) - (a.issueDateMs ?? 0))
}

/** Payments of invoices that received money (payments are a sub-collection; no collectionGroup in the rules). */
export async function loadPayments(invoices: InvoiceRow[]): Promise<PaymentLike[]> {
  const withMoney = invoices.filter((i) => i.paid > 0)
  const lists = await mapLimit(withMoney, 8, async (inv) => {
    const snap = await getDocs(collection(db, 'invoices', inv.id, 'payments'))
    return snap.docs.map((p) => {
      const d = p.data() ?? {}
      return { amount: num(d.amount), dateMs: ms(d.date) ?? ms(d.createdAt), cancelled: d.cancelled === true }
    })
  })
  return lists.flat()
}

/* -------------------------------------------- support (read-only) -------------------------------------------- */

export interface ThreadRow {
  id: string
  licenseId: string
  companyName: string
  contactName: string
  status: string
  lastMessageAtMs: number | null
  lastMessageFrom: string
  lastMessagePreview: string
  unreadByAdmin: boolean
}

export function threadRow(s: QueryDocumentSnapshot<DocumentData>): ThreadRow {
  const d = s.data() ?? {}
  return {
    id: s.id,
    licenseId: str(d.licenseId),
    companyName: str(d.companyName),
    contactName: str(d.contactName),
    status: str(d.status) || 'open',
    lastMessageAtMs: ms(d.lastMessageAt),
    lastMessageFrom: str(d.lastMessageFrom),
    lastMessagePreview: str(d.lastMessagePreview),
    unreadByAdmin: d.unreadByAdmin === true
  }
}

export async function loadThreads(licenseIds?: string[]): Promise<ThreadRow[]> {
  const col = collection(db, 'supportThreads')
  if (!licenseIds) return (await getDocs(col)).docs.map(threadRow)
  const out: ThreadRow[] = []
  for (let i = 0; i < licenseIds.length; i += 30) {
    const snap = await getDocs(query(col, where('licenseId', 'in', licenseIds.slice(i, i + 30))))
    out.push(...snap.docs.map(threadRow))
  }
  return out.sort((a, b) => (b.lastMessageAtMs ?? 0) - (a.lastMessageAtMs ?? 0))
}
