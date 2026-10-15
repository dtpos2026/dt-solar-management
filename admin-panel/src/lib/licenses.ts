/**
 * Firestore data access for licenses (admin side).
 * Every change that affects what the desktop app sees also updates licenseStatus/{licenseId}.
 */
import {
  Timestamp,
  arrayRemove,
  arrayUnion,
  collection,
  doc,
  getDocs,
  limit,
  query,
  runTransaction,
  serverTimestamp,
  where,
  writeBatch,
  type DocumentData,
  type DocumentSnapshot,
  type FieldValue,
  type QueryDocumentSnapshot,
  type Transaction,
  type WriteBatch
} from 'firebase/firestore'
import { auth, db } from '../firebase'
import { generateLicenseKey, normaliseLicenseKey } from './crypto'
import type { ActivationRequest, AuditCategory, AuditEntry, Device, HistoryEntry, License, LicenseState, Plan } from './types'
import { DEFAULT_CHECKIN_DAYS, DEFAULT_GRACE_DAYS } from './types'
import { fmtDate } from './format'

/* ------------------------------------------------ refs ------------------------------------------------ */

export const licensesCol = () => collection(db, 'licenses')
export const licenseRef = (id: string) => doc(db, 'licenses', id)
export const devicesCol = (licenseId: string) => collection(db, 'licenses', licenseId, 'devices')
export const deviceRef = (licenseId: string, deviceId: string) => doc(db, 'licenses', licenseId, 'devices', deviceId)
export const historyCol = (licenseId: string) => collection(db, 'licenses', licenseId, 'history')
export const licenseStatusRef = (licenseId: string) => doc(db, 'licenseStatus', licenseId)
export const requestsCol = () => collection(db, 'activationRequests')
export const requestRef = (id: string) => doc(db, 'activationRequests', id)
export const auditCol = () => collection(db, 'auditLogs')

/* ---------------------------------------------- mapping ---------------------------------------------- */

type Snap = DocumentSnapshot<DocumentData> | QueryDocumentSnapshot<DocumentData>

const str = (v: unknown, d = ''): string => (typeof v === 'string' ? v : v === undefined || v === null ? d : String(v))
const num = (v: unknown, d = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : d)
const ts = (v: unknown): Timestamp | null => (v instanceof Timestamp ? v : null)

export function licenseFromSnap(s: Snap): License {
  const d = s.data() ?? {}
  return {
    id: s.id,
    clientId: str(d.clientId),
    planType: (['monthly', 'yearly', 'lifetime'].includes(d.planType) ? d.planType : d.expiresAt ? 'yearly' : 'lifetime') as License['planType'],
    poweredBy: d.poweredBy !== false,
    detached: d.detached === true,
    paymentStatus: (['paid', 'partial', 'unpaid', 'none'].includes(d.paymentStatus) ? d.paymentStatus : 'none') as License['paymentStatus'],
    activatedAt: ts(d.activatedAt),
    lastVerifiedAt: ts(d.lastVerifiedAt),
    licenseKey: str(d.licenseKey),
    customerName: str(d.customerName),
    businessName: str(d.businessName),
    phone: str(d.phone),
    email: str(d.email),
    city: str(d.city),
    plan: (['standard', 'professional', 'enterprise'].includes(d.plan) ? d.plan : 'standard') as Plan,
    status: (['active', 'suspended', 'revoked'].includes(d.status) ? d.status : 'active') as LicenseState,
    maxDevices: num(d.maxDevices, 1),
    maxFirms: num(d.maxFirms, 1),
    maxUsers: num(d.maxUsers, 1),
    features: Array.isArray(d.features) ? d.features.filter((f: unknown) => typeof f === 'string') : [],
    expiresAt: ts(d.expiresAt),
    checkinDays: num(d.checkinDays, DEFAULT_CHECKIN_DAYS),
    graceDays: num(d.graceDays, DEFAULT_GRACE_DAYS),
    notes: str(d.notes),
    activeDevices: num(d.activeDevices, 0),
    createdAt: ts(d.createdAt),
    updatedAt: ts(d.updatedAt),
    createdBy: str(d.createdBy)
  }
}

export function deviceFromSnap(s: Snap): Device {
  const d = s.data() ?? {}
  return {
    id: s.id,
    deviceId: str(d.deviceId, s.id),
    deviceName: str(d.deviceName),
    os: str(d.os),
    appVersion: str(d.appVersion),
    status: d.status === 'deactivated' ? 'deactivated' : 'active',
    activatedAt: ts(d.activatedAt),
    activationType: d.activationType === 'offline' ? 'offline' : 'online',
    lastIssuedAt: ts(d.lastIssuedAt),
    deactivatedAt: ts(d.deactivatedAt)
  }
}

export function historyFromSnap(s: Snap): HistoryEntry {
  const d = s.data() ?? {}
  return { id: s.id, action: str(d.action), by: str(d.by), at: ts(d.at), details: str(d.details) }
}

export function auditFromSnap(s: Snap): AuditEntry {
  const d = s.data() ?? {}
  return {
    id: s.id,
    action: str(d.action),
    by: str(d.by),
    at: ts(d.at),
    licenseId: d.licenseId ? str(d.licenseId) : null,
    details: str(d.details),
    category: (str(d.category, 'license') || 'license') as AuditEntry['category'],
    byUid: str(d.byUid),
    target: str(d.target, d.licenseId ? str(d.licenseId) : ''),
    targetType: str(d.targetType, d.licenseId ? 'license' : ''),
    status: d.status === 'failure' ? 'failure' : 'success',
    archived: d.archived === true
  }
}

export function requestFromSnap(s: Snap): ActivationRequest {
  const d = s.data() ?? {}
  return {
    id: s.id,
    type: d.type === 'deactivate' ? 'deactivate' : 'activate',
    licenseKey: d.licenseKey ? str(d.licenseKey) : undefined,
    licenseId: d.licenseId ? str(d.licenseId) : undefined,
    deviceId: str(d.deviceId),
    deviceName: str(d.deviceName),
    appVersion: str(d.appVersion),
    os: str(d.os),
    status: (['pending', 'approved', 'rejected', 'processed'].includes(d.status) ? d.status : 'pending') as ActivationRequest['status'],
    createdAt: ts(d.createdAt),
    processedAt: ts(d.processedAt),
    processedBy: d.processedBy ? str(d.processedBy) : undefined,
    message: d.message ? str(d.message) : undefined,
    certificate: d.certificate ? str(d.certificate) : undefined
  }
}

/* --------------------------------------------- helpers --------------------------------------------- */

export function isExpired(l: Pick<License, 'expiresAt'>, now = Date.now()): boolean {
  return !!l.expiresAt && l.expiresAt.toMillis() <= now
}

/** "Effective" status for display: active licenses past their expiry show as expired. */
export function effectiveStatus(l: License): LicenseState | 'expired' {
  if (l.status === 'active' && isExpired(l)) return 'expired'
  return l.status
}

export function expiryLabel(l: Pick<License, 'expiresAt'>): string {
  return l.expiresAt ? fmtDate(l.expiresAt) : 'Lifetime'
}

/** Device ids from the desktop look like XXXX-XXXX-XXXX-XXXX-XXXX-XXXX; anything usable as a Firestore id segment is accepted. */
export function isValidDeviceId(id: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_-]{2,79}$/.test(id)
}

export function isValidDocId(id: string): boolean {
  return /^[A-Za-z0-9_-]{1,128}$/.test(id)
}

/** Builds the licenseStatus/{id} document data (merge write). */
export function statusPatch(
  status: LicenseState,
  expiresAt: Timestamp | null,
  devices?: { add?: string[]; remove?: string[] }
): Record<string, unknown> {
  let deactivatedDevices: FieldValue
  if (devices?.add?.length) deactivatedDevices = arrayUnion(...devices.add)
  else if (devices?.remove?.length) deactivatedDevices = arrayRemove(...devices.remove)
  else deactivatedDevices = arrayUnion() // keeps the existing list, creates [] when missing
  return { status, expiresAt, deactivatedDevices, updatedAt: serverTimestamp() }
}

type Writer = Pick<WriteBatch, 'set' | 'update'> | Pick<Transaction, 'set' | 'update'>

export function writeHistory(w: Writer, licenseId: string, action: string, by: string, details: string): void {
  ;(w as WriteBatch).set(doc(historyCol(licenseId)), { action, by, at: serverTimestamp(), details })
}

export function writeAudit(w: Writer, action: string, by: string, licenseId: string | null, details: string, category: AuditCategory = 'license'): void {
  ;(w as WriteBatch).set(doc(auditCol()), {
    action,
    category,
    by,
    byUid: auth.currentUser?.uid ?? '',
    target: licenseId ?? '',
    targetType: licenseId ? 'license' : '',
    licenseId,
    details,
    status: 'success',
    archived: false,
    at: serverTimestamp()
  })
}

/** Writes a history entry on the license AND an audit log entry. */
export function writeLog(w: Writer, licenseId: string, action: string, by: string, details: string): void {
  writeHistory(w, licenseId, action, by, details)
  writeAudit(w, action, by, licenseId, details)
}

export async function findLicenseByKey(key: string): Promise<License | null> {
  const k = normaliseLicenseKey(key)
  if (!k) return null
  const snap = await getDocs(query(licensesCol(), where('licenseKey', '==', k), limit(1)))
  return snap.empty ? null : licenseFromSnap(snap.docs[0])
}

async function generateUniqueKey(): Promise<string> {
  for (let i = 0; i < 6; i++) {
    const k = generateLicenseKey()
    const existing = await findLicenseByKey(k)
    if (!existing) return k
  }
  throw new Error('Could not generate a unique license key. Please try again.')
}

/* ------------------------------------------ license CRUD ------------------------------------------ */

export interface LicenseInput {
  customerName: string
  businessName: string
  phone: string
  email: string
  city: string
  plan: Plan
  maxDevices: number
  maxFirms: number
  maxUsers: number
  features: string[]
  expiresAt: Date | null
  checkinDays: number
  graceDays: number
  notes: string
}

function cleanInput(i: LicenseInput) {
  const int = (v: number, min: number, max: number) => Math.min(max, Math.max(min, Math.round(Number.isFinite(v) ? v : min)))
  return {
    customerName: i.customerName.trim(),
    businessName: i.businessName.trim(),
    phone: i.phone.trim(),
    email: i.email.trim(),
    city: i.city.trim(),
    plan: i.plan,
    maxDevices: int(i.maxDevices, 1, 1000),
    maxFirms: int(i.maxFirms, 1, 1000),
    maxUsers: int(i.maxUsers, 1, 10000),
    features: Array.from(new Set(i.features)),
    expiresAt: i.expiresAt ? Timestamp.fromDate(i.expiresAt) : null,
    checkinDays: int(i.checkinDays, 0, 3650),
    graceDays: int(i.graceDays, 0, 365),
    notes: i.notes.trim()
  }
}

export async function createLicense(input: LicenseInput, by: string): Promise<{ id: string; licenseKey: string }> {
  const data = cleanInput(input)
  if (!data.businessName && !data.customerName) throw new Error('Enter the business name or customer name.')
  const licenseKey = await generateUniqueKey()
  const ref = doc(licensesCol())
  const batch = writeBatch(db)
  batch.set(ref, {
    licenseKey,
    ...data,
    status: 'active',
    activeDevices: 0,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
    createdBy: by
  })
  batch.set(licenseStatusRef(ref.id), { status: 'active', expiresAt: data.expiresAt, deactivatedDevices: [], updatedAt: serverTimestamp() })
  writeLog(
    batch,
    ref.id,
    'license_created',
    by,
    `${data.plan} license for ${data.businessName || data.customerName}; ${data.maxDevices} device(s), ${data.maxFirms} firm(s), ${data.maxUsers} user(s); expires ${data.expiresAt ? fmtDate(data.expiresAt) : 'never (lifetime)'}`
  )
  await batch.commit()
  return { id: ref.id, licenseKey }
}

export async function updateLicense(current: License, input: LicenseInput, by: string): Promise<void> {
  const data = cleanInput(input)
  if (!data.businessName && !data.customerName) throw new Error('Enter the business name or customer name.')
  const changes: string[] = []
  const cmp = (label: string, a: unknown, b: unknown) => {
    if (JSON.stringify(a) !== JSON.stringify(b)) changes.push(`${label}: ${fmt(a)} → ${fmt(b)}`)
  }
  const fmt = (v: unknown) => (v instanceof Timestamp ? fmtDate(v) : v === null ? 'lifetime' : Array.isArray(v) ? v.join(', ') || 'none' : String(v ?? ''))
  cmp('Customer', current.customerName, data.customerName)
  cmp('Business', current.businessName, data.businessName)
  cmp('Phone', current.phone, data.phone)
  cmp('Email', current.email, data.email)
  cmp('City', current.city, data.city)
  cmp('Plan', current.plan, data.plan)
  cmp('Max devices', current.maxDevices, data.maxDevices)
  cmp('Max firms', current.maxFirms, data.maxFirms)
  cmp('Max users', current.maxUsers, data.maxUsers)
  cmp('Features', [...current.features].sort(), [...data.features].sort())
  cmp('Expiry', current.expiresAt ? current.expiresAt.toMillis() : null, data.expiresAt ? data.expiresAt.toMillis() : null)
  cmp('Check-in days', current.checkinDays, data.checkinDays)
  cmp('Grace days', current.graceDays, data.graceDays)
  if (current.notes !== data.notes) changes.push('Notes updated')
  const batch = writeBatch(db)
  batch.update(licenseRef(current.id), { ...data, updatedAt: serverTimestamp() })
  batch.set(licenseStatusRef(current.id), statusPatch(current.status, data.expiresAt), { merge: true })
  writeLog(batch, current.id, 'license_updated', by, changes.length ? changes.join('; ').replace(/\d{13}/g, (m) => fmtDate(Number(m))) : 'No changes')
  await batch.commit()
}

export async function setLicenseState(l: License, status: LicenseState, by: string, reason: string): Promise<void> {
  const action = status === 'active' ? 'license_reactivated' : status === 'suspended' ? 'license_suspended' : 'license_revoked'
  const batch = writeBatch(db)
  batch.update(licenseRef(l.id), { status, updatedAt: serverTimestamp() })
  batch.set(licenseStatusRef(l.id), statusPatch(status, l.expiresAt), { merge: true })
  writeLog(batch, l.id, action, by, `Status ${l.status} → ${status}${reason.trim() ? `. Reason: ${reason.trim()}` : ''}`)
  await batch.commit()
}

export async function renewLicense(l: License, newExpiry: Date | null, by: string): Promise<void> {
  const expiresAt = newExpiry ? Timestamp.fromDate(newExpiry) : null
  const batch = writeBatch(db)
  batch.update(licenseRef(l.id), { expiresAt, updatedAt: serverTimestamp() })
  batch.set(licenseStatusRef(l.id), statusPatch(l.status, expiresAt), { merge: true })
  writeLog(batch, l.id, 'license_renewed', by, `Expiry ${expiryLabel(l)} → ${newExpiry ? fmtDate(newExpiry) : 'Lifetime'}`)
  await batch.commit()
}

/** Re-publishes licenseStatus/{id} from the license (repair tool). */
export async function republishStatus(l: License, by: string): Promise<void> {
  const batch = writeBatch(db)
  batch.set(licenseStatusRef(l.id), statusPatch(l.status, l.expiresAt), { merge: true })
  writeLog(batch, l.id, 'status_published', by, `licenseStatus re-published (status ${l.status}, expiry ${expiryLabel(l)})`)
  await batch.commit()
}

/* -------------------------------------------- devices -------------------------------------------- */

/**
 * Deactivates a device inside a transaction (all reads must already be done by the caller).
 * Returns true when the device was active and is now deactivated.
 */
export function deactivateDeviceInTx(
  tx: Transaction,
  lic: License,
  devSnap: DocumentSnapshot<DocumentData>,
  deviceId: string,
  by: string,
  how: string
): boolean {
  if (!devSnap.exists() || devSnap.data()?.status !== 'active') return false
  const dev = deviceFromSnap(devSnap)
  tx.update(deviceRef(lic.id, deviceId), { status: 'deactivated', deactivatedAt: serverTimestamp() })
  tx.update(licenseRef(lic.id), { activeDevices: Math.max(0, lic.activeDevices - 1), updatedAt: serverTimestamp() })
  tx.set(licenseStatusRef(lic.id), statusPatch(lic.status, lic.expiresAt, { add: [deviceId] }), { merge: true })
  writeLog(tx, lic.id, 'device_deactivated', by, `${dev.deviceName || 'Device'} (${deviceId}) deactivated ${how}`)
  return true
}

export async function adminDeactivateDevice(licenseId: string, deviceId: string, by: string): Promise<void> {
  await runTransaction(db, async (tx) => {
    const licSnap = await tx.get(licenseRef(licenseId))
    const devSnap = await tx.get(deviceRef(licenseId, deviceId))
    if (!licSnap.exists()) throw new Error('License not found.')
    const ok = deactivateDeviceInTx(tx, licenseFromSnap(licSnap), devSnap, deviceId, by, 'by admin')
    if (!ok) throw new Error('This device is not active.')
  })
}

export async function adminReactivateDevice(licenseId: string, deviceId: string, by: string): Promise<void> {
  await runTransaction(db, async (tx) => {
    const licSnap = await tx.get(licenseRef(licenseId))
    const devSnap = await tx.get(deviceRef(licenseId, deviceId))
    if (!licSnap.exists()) throw new Error('License not found.')
    if (!devSnap.exists()) throw new Error('Device not found.')
    const lic = licenseFromSnap(licSnap)
    const dev = deviceFromSnap(devSnap)
    if (dev.status === 'active') throw new Error('This device is already active.')
    if (lic.activeDevices >= lic.maxDevices) {
      throw new Error(`Device limit reached (${lic.activeDevices} of ${lic.maxDevices}). Deactivate another device or raise the limit first.`)
    }
    tx.update(deviceRef(licenseId, deviceId), { status: 'active', deactivatedAt: null })
    tx.update(licenseRef(licenseId), { activeDevices: lic.activeDevices + 1, updatedAt: serverTimestamp() })
    tx.set(licenseStatusRef(licenseId), statusPatch(lic.status, lic.expiresAt, { remove: [deviceId] }), { merge: true })
    writeLog(tx, licenseId, 'device_reactivated', by, `${dev.deviceName || 'Device'} (${deviceId}) reactivated by admin`)
  })
}

/** Recounts active devices from the devices sub-collection and fixes activeDevices (repair tool). */
export async function recountActiveDevices(licenseId: string, by: string): Promise<number> {
  const snap = await getDocs(devicesCol(licenseId))
  const n = snap.docs.filter((d) => d.data().status === 'active').length
  await runTransaction(db, async (tx) => {
    const licSnap = await tx.get(licenseRef(licenseId))
    if (!licSnap.exists()) throw new Error('License not found.')
    const before = num(licSnap.data()?.activeDevices, 0)
    tx.update(licenseRef(licenseId), { activeDevices: n, updatedAt: serverTimestamp() })
    writeLog(tx, licenseId, 'devices_recounted', by, `Active devices recounted: ${before} → ${n}`)
  })
  return n
}
