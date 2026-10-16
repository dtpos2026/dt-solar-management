/**
 * Firestore data access for licenses (admin side).
 * Every change that affects what the desktop app sees also updates licenseStatus/{licenseId}.
 * Certificate re-signing after a change of terms lives in approve.ts (it needs the signing key).
 */
import {
  Timestamp,
  arrayRemove,
  arrayUnion,
  collection,
  deleteField,
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
import type { ActivationRequest, AuditCategory, AuditEntry, Device, DeviceSummary, HistoryEntry, License, LicenseState, Plan, PlanType } from './types'
import { DEFAULT_CHECKIN_DAYS, DEFAULT_GRACE_DAYS, PLAN_PRESETS } from './types'
import { fmtDate } from './format'
import { detachEligibility, deviceLimitGuard, firmLimitGuard, holdsSlot, maskDeviceId, planTermsError, trialExpiryError } from './terms'
import { licenseBucket, type LicenseBucket } from './stats'

/* ------------------------------------------------ cache generation ------------------------------------------------ */

let licGen = 0
/** Bumped by every portal mutation (writeLog): cached license lists of an older generation are discarded (fleet.ts). */
export function invalidateLicenses(): void {
  licGen++
}
export const licensesGeneration = () => licGen

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
/** 'instant' = the computer registered itself with an activation pass (within the device limit). */
const actType = (v: unknown): 'online' | 'offline' | 'instant' => (v === 'offline' || v === 'instant' ? v : 'online')
const ts = (v: unknown): Timestamp | null => (v instanceof Timestamp ? v : null)

export function licenseFromSnap(s: Snap): License {
  const d = s.data() ?? {}
  return {
    id: s.id,
    clientId: str(d.clientId),
    planType: (['monthly', 'yearly', 'lifetime', 'trial'].includes(d.planType) ? d.planType : d.expiresAt ? 'yearly' : 'lifetime') as License['planType'],
    // Customer documents are white-label unless "Powered by" was explicitly switched on (desktop default false).
    poweredBy: d.poweredBy === true,
    detached: d.detached === true,
    detachedAt: ts(d.detachedAt),
    detachedBy: str(d.detachedBy),
    paymentStatus: (['paid', 'partial', 'unpaid', 'none'].includes(d.paymentStatus) ? d.paymentStatus : 'none') as License['paymentStatus'],
    activatedAt: ts(d.activatedAt),
    lastVerifiedAt: ts(d.lastVerifiedAt),
    licenseKey: str(d.licenseKey),
    customerName: str(d.customerName),
    businessName: str(d.businessName),
    phone: str(d.phone),
    email: str(d.email),
    city: str(d.city),
    plan: (['standard', 'professional', 'enterprise', 'trial'].includes(d.plan) ? d.plan : 'standard') as Plan,
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
    createdBy: str(d.createdBy),
    devicesSummary: summaryFromData(d.devicesSummary),
    passHash: str(d.passHash)
  }
}

/** Parses license.devicesSummary (null when the license has none yet → the caller reads the sub-collection). */
export function summaryFromData(v: unknown): Record<string, DeviceSummary> | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null
  const out: Record<string, DeviceSummary> = {}
  for (const [id, raw] of Object.entries(v as Record<string, unknown>)) {
    if (!raw || typeof raw !== 'object') continue
    const e = raw as Record<string, unknown>
    out[id] = {
      deviceName: str(e.deviceName),
      os: str(e.os),
      appVersion: str(e.appVersion),
      status: (['suspended', 'revoked', 'deactivated'].includes(e.status as string) ? e.status : 'active') as DeviceSummary['status'],
      activatedAtMs: e.activatedAt instanceof Timestamp ? e.activatedAt.toMillis() : null,
      activationType: actType(e.activationType),
      statusNote: str(e.statusNote)
    }
  }
  return out
}

/** Device summary entry written onto the license in the same transaction as the device document. */
export function summaryEntry(d: { deviceName?: string; os?: string; appVersion?: string; status: string; activatedAt?: unknown; activationType?: string; statusNote?: string }): Record<string, unknown> {
  return {
    deviceName: (d.deviceName ?? '').slice(0, 200),
    os: (d.os ?? '').slice(0, 200),
    appVersion: (d.appVersion ?? '').slice(0, 40),
    status: d.status,
    activatedAt: d.activatedAt ?? null,
    activationType: actType(d.activationType),
    statusNote: (d.statusNote ?? '').slice(0, 300)
  }
}

/**
 * License patch that rewrites the whole devicesSummary map with `changes` applied (no dotted field paths, so any
 * device id is safe). Returns {} while the license has no summary yet: a partial map would hide the devices that
 * are not in it, so such licenses keep being read from the sub-collection until backfillSummary writes a full one.
 */
export function summaryPatch(lic: Pick<License, 'devicesSummary'>, changes: Record<string, Record<string, unknown>>): Record<string, unknown> {
  if (lic.devicesSummary === null) return {}
  const out: Record<string, unknown> = {}
  for (const [id, e] of Object.entries(lic.devicesSummary)) out[id] = summaryEntry({ ...e, activatedAt: e.activatedAtMs === null ? null : Timestamp.fromMillis(e.activatedAtMs) })
  return { devicesSummary: { ...out, ...changes } }
}

/** Short, log-safe label of a computer: name + masked id (full device ids are never logged). */
export function deviceLabel(name: string, deviceId: string): string {
  return `${name || 'Device'} (${maskDeviceId(deviceId)})`
}

export function deviceFromSnap(s: Snap): Device {
  const d = s.data() ?? {}
  return {
    id: s.id,
    deviceId: str(d.deviceId, s.id),
    deviceName: str(d.deviceName),
    os: str(d.os),
    appVersion: str(d.appVersion),
    status: (['suspended', 'revoked', 'deactivated'].includes(d.status) ? d.status : 'active') as Device['status'],
    activatedAt: ts(d.activatedAt),
    activationType: actType(d.activationType),
    lastIssuedAt: ts(d.lastIssuedAt),
    deactivatedAt: ts(d.deactivatedAt),
    statusNote: str(d.statusNote),
    statusChangedAt: ts(d.statusChangedAt),
    statusBy: str(d.statusBy)
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
  const opt = (v: unknown) => (typeof v === 'string' && v ? v : undefined)
  return {
    id: s.id,
    type: d.type === 'deactivate' ? 'deactivate' : 'activate',
    licenseKey: opt(d.licenseKey),
    licenseId: opt(d.licenseId),
    deviceId: str(d.deviceId),
    deviceName: str(d.deviceName),
    appVersion: str(d.appVersion),
    os: str(d.os),
    status: (['pending', 'approved', 'rejected', 'processed'].includes(d.status) ? d.status : 'pending') as ActivationRequest['status'],
    createdAt: ts(d.createdAt),
    processedAt: ts(d.processedAt),
    processedBy: opt(d.processedBy),
    message: opt(d.message),
    certificate: opt(d.certificate),
    companyName: opt(d.companyName),
    ownerName: opt(d.ownerName),
    phone: opt(d.phone),
    address: opt(d.address),
    installToken: opt(d.installToken)
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

/** Dashboard bucket incl. "pending" (no device ever activated). `deviceCount` = known device documents. */
export function licenseBucketOf(l: License, deviceCount?: number, now = Date.now()): LicenseBucket {
  return licenseBucket(
    { status: l.status, expiresAtMs: l.expiresAt ? l.expiresAt.toMillis() : null, activeDevices: l.activeDevices, everActivated: !!l.activatedAt || (deviceCount ?? 0) > 0 },
    now
  )
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
  devices?: { add?: string[]; remove?: string[] },
  extra?: { poweredBy?: boolean; detached?: boolean; dropCerts?: string[] }
): Record<string, unknown> {
  let deactivatedDevices: FieldValue
  if (devices?.add?.length) deactivatedDevices = arrayUnion(...devices.add)
  else if (devices?.remove?.length) deactivatedDevices = arrayRemove(...devices.remove)
  else deactivatedDevices = arrayUnion() // keeps the existing list, creates [] when missing
  const out: Record<string, unknown> = { status, expiresAt, deactivatedDevices, updatedAt: serverTimestamp() }
  if (extra?.poweredBy !== undefined) out.poweredBy = extra.poweredBy
  if (extra?.detached !== undefined) out.detached = extra.detached
  if (extra?.dropCerts?.length) out.certs = Object.fromEntries(extra.dropCerts.map((id) => [id, deleteField()]))
  return out
}

/** licenseStatus patch carrying everything the desktop reads from the license (status, expiry, poweredBy, detached). */
export function licenseStatusPatch(
  l: Pick<License, 'status' | 'expiresAt' | 'poweredBy' | 'detached'>,
  devices?: { add?: string[]; remove?: string[] },
  dropCerts?: string[]
): Record<string, unknown> {
  return statusPatch(l.status, l.expiresAt, devices, { poweredBy: l.poweredBy, detached: l.detached, dropCerts })
}

type Writer = Pick<WriteBatch, 'set' | 'update'> | Pick<Transaction, 'set' | 'update'>

export function writeHistory(w: Writer, licenseId: string, action: string, by: string, details: string): void {
  ;(w as WriteBatch).set(doc(historyCol(licenseId)), { action, by, at: serverTimestamp(), details })
}

export function writeAudit(w: Writer, action: string, by: string, licenseId: string | null, details: string, category: AuditCategory = 'license'): void {
  writeAuditEntry(w, { action, by, licenseId, details, category })
}

/** Audit entry with an explicit target (e.g. a client) — for use inside batches / transactions. */
export function writeAuditEntry(
  w: Writer,
  a: { action: string; by: string; category: AuditCategory; details: string; licenseId?: string | null; target?: string; targetType?: string; meta?: Record<string, unknown> }
): void {
  const licenseId = a.licenseId ?? null
  ;(w as WriteBatch).set(doc(auditCol()), {
    action: a.action,
    category: a.category,
    by: a.by,
    byUid: auth.currentUser?.uid ?? '',
    target: a.target ?? licenseId ?? '',
    targetType: a.targetType ?? (licenseId ? 'license' : ''),
    licenseId,
    details: a.details,
    meta: a.meta ?? {},
    status: 'success',
    archived: false,
    at: serverTimestamp()
  })
}

/** Writes a history entry on the license AND an audit log entry. */
export function writeLog(w: Writer, licenseId: string, action: string, by: string, details: string, category: AuditCategory = 'license'): void {
  invalidateLicenses()
  writeHistory(w, licenseId, action, by, details)
  writeAudit(w, action, by, licenseId, details, category)
}

const withReason = (text: string, reason: string) => (reason.trim() ? `${text}. Reason: ${reason.trim()}` : text)

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
  /** v1.1 (optional for older callers) */
  clientId?: string
  planType?: PlanType
  poweredBy?: boolean
}

const intIn = (v: number, min: number, max: number) => Math.min(max, Math.max(min, Math.round(Number.isFinite(v) ? v : min)))

function cleanInput(i: LicenseInput) {
  const expiresAt = i.expiresAt ? Timestamp.fromDate(i.expiresAt) : null
  return {
    customerName: i.customerName.trim(),
    businessName: i.businessName.trim(),
    phone: i.phone.trim(),
    email: i.email.trim(),
    city: i.city.trim(),
    plan: i.plan,
    maxDevices: intIn(i.maxDevices, 1, 1000),
    maxFirms: intIn(i.maxFirms, 1, 1000),
    maxUsers: intIn(i.maxUsers, 1, 10000),
    features: Array.from(new Set(i.features)),
    expiresAt,
    checkinDays: intIn(i.checkinDays, 0, 3650),
    graceDays: intIn(i.graceDays, 0, 365),
    notes: i.notes.trim(),
    clientId: (i.clientId ?? '').trim(),
    planType: (i.planType ?? (expiresAt ? 'yearly' : 'lifetime')) as PlanType,
    poweredBy: i.poweredBy === true
  }
}

export async function createLicense(input: LicenseInput, by: string, action = 'license_created'): Promise<{ id: string; licenseKey: string }> {
  const data = cleanInput(input)
  if (!data.businessName && !data.customerName) throw new Error('Enter the business name or customer name.')
  const planErr = planTermsError(data.planType, data.expiresAt ? data.expiresAt.toMillis() : null)
  if (planErr) throw new Error(planErr)
  const licenseKey = await generateUniqueKey()
  const ref = doc(licensesCol())
  const batch = writeBatch(db)
  batch.set(ref, {
    licenseKey,
    ...data,
    status: 'active',
    detached: false,
    paymentStatus: 'none',
    activatedAt: null,
    activeDevices: 0,
    devicesSummary: {},
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
    createdBy: by
  })
  batch.set(licenseStatusRef(ref.id), { status: 'active', expiresAt: data.expiresAt, deactivatedDevices: [], poweredBy: data.poweredBy, detached: false, updatedAt: serverTimestamp() })
  writeLog(
    batch,
    ref.id,
    action,
    by,
    `${data.plan} (${data.planType}) license ${licenseKey} for ${data.businessName || data.customerName}; ${data.maxDevices} device(s), ${data.maxFirms} firm(s), ${data.maxUsers} user(s); expires ${data.expiresAt ? fmtDate(data.expiresAt) : 'never (lifetime)'}${data.clientId ? `; client ${data.clientId}` : ''}`
  )
  await batch.commit()
  return { id: ref.id, licenseKey }
}

/**
 * Edits customer details, features, check-in / grace days, notes and the linked client.
 * Plan, expiry and limits change through the dedicated actions (changeTerms) so each change has a reason.
 * Returns true when a field that is part of the certificates changed (re-signing is needed).
 */
export async function updateLicense(current: License, input: LicenseInput, by: string): Promise<boolean> {
  const data = cleanInput(input)
  if (!data.businessName && !data.customerName) throw new Error('Enter the business name or customer name.')
  const changes: string[] = []
  let certChange = false
  const cmp = (label: string, a: unknown, b: unknown, cert = true) => {
    if (JSON.stringify(a) !== JSON.stringify(b)) {
      changes.push(`${label}: ${fmt(a)} → ${fmt(b)}`)
      if (cert) certChange = true
    }
  }
  const fmt = (v: unknown) => (Array.isArray(v) ? v.join(', ') || 'none' : String(v ?? '') || '—')
  cmp('Customer', current.customerName, data.customerName)
  cmp('Business', current.businessName, data.businessName)
  cmp('Phone', current.phone, data.phone)
  cmp('Email', current.email, data.email)
  cmp('City', current.city, data.city, false)
  cmp('Max users', current.maxUsers, data.maxUsers)
  cmp('Features', [...current.features].sort(), [...data.features].sort())
  cmp('Client', current.clientId, data.clientId)
  if (!current.detached) {
    cmp('Check-in days', current.checkinDays, data.checkinDays)
    cmp('Grace days', current.graceDays, data.graceDays)
  }
  if (current.notes !== data.notes) changes.push('Notes updated')
  const patch: Record<string, unknown> = {
    customerName: data.customerName,
    businessName: data.businessName,
    phone: data.phone,
    email: data.email,
    city: data.city,
    maxUsers: data.maxUsers,
    features: data.features,
    notes: data.notes,
    clientId: data.clientId,
    updatedAt: serverTimestamp()
  }
  if (!current.detached) {
    patch.checkinDays = data.checkinDays
    patch.graceDays = data.graceDays
  }
  const batch = writeBatch(db)
  batch.update(licenseRef(current.id), patch)
  writeLog(batch, current.id, 'license_updated', by, changes.length ? changes.join('; ') : 'No changes')
  await batch.commit()
  return certChange
}

export async function setLicenseState(l: License, status: LicenseState, by: string, reason: string): Promise<void> {
  if (l.detached && status !== 'active') throw new Error('This license is detached from central management — it can no longer be suspended or revoked remotely.')
  const action = status === 'active' ? 'license_reactivated' : status === 'suspended' ? 'license_suspended' : 'license_revoked'
  const batch = writeBatch(db)
  batch.update(licenseRef(l.id), { status, updatedAt: serverTimestamp() })
  batch.set(licenseStatusRef(l.id), licenseStatusPatch({ ...l, status }), { merge: true })
  writeLog(batch, l.id, action, by, withReason(`Status ${l.status} → ${status}`, reason))
  await batch.commit()
}

/* ------------------------------------------ change of terms ------------------------------------------ */

export type TermsKind = 'renew' | 'plan' | 'firms' | 'devices' | 'poweredBy'

export interface TermsChange {
  kind: TermsKind
  expiresAt?: Date | null
  plan?: Plan
  planType?: PlanType
  maxFirms?: number
  maxDevices?: number
  maxUsers?: number
  features?: string[]
  poweredBy?: boolean
}

const TERMS_ACTION: Record<TermsKind, string> = {
  renew: 'license_renewed',
  plan: 'plan_changed',
  firms: 'firm_limit_changed',
  devices: 'device_limit_changed',
  poweredBy: 'powered_by_changed'
}

/**
 * Applies a change of terms in a transaction (fresh read, guards, license + licenseStatus + history + audit).
 * Returns the updated license so the caller can re-sign certificates for its active devices.
 */
export async function changeTerms(licenseId: string, c: TermsChange, reason: string, by: string): Promise<License> {
  return runTransaction(db, async (tx) => {
    const snap = await tx.get(licenseRef(licenseId))
    if (!snap.exists()) throw new Error('License not found.')
    const l = licenseFromSnap(snap)
    const patch: Record<string, unknown> = {}
    const changes: string[] = []
    if (l.status === 'revoked') throw new Error('This license is revoked. Reactivate it before changing its terms.')
    if (l.detached && (c.kind === 'renew' || c.kind === 'plan')) {
      throw new Error('A detached lifetime license cannot be renewed or moved to another plan.')
    }
    const next = { ...l }
    if (c.kind === 'renew' || c.kind === 'plan') {
      const planType = c.planType ?? l.planType
      const expiresAt = c.expiresAt === undefined ? l.expiresAt : c.expiresAt ? Timestamp.fromDate(c.expiresAt) : null
      const err = planTermsError(planType, expiresAt ? expiresAt.toMillis() : null)
      if (err) throw new Error(err)
      if (expiresAt && expiresAt.toMillis() <= Date.now()) throw new Error('The new expiry date must be in the future.')
      if ((expiresAt?.toMillis() ?? null) !== (l.expiresAt?.toMillis() ?? null)) {
        changes.push(`Expiry ${expiryLabel(l)} → ${expiresAt ? fmtDate(expiresAt) : 'Lifetime'}`)
        patch.expiresAt = expiresAt
        next.expiresAt = expiresAt
      }
      if (planType !== l.planType) {
        changes.push(`Billing cycle ${l.planType} → ${planType}`)
        patch.planType = planType
        next.planType = planType
      }
    }
    if (c.kind === 'plan') {
      if (c.plan && c.plan !== l.plan) {
        changes.push(`Plan ${l.plan} → ${c.plan}`)
        patch.plan = c.plan
        next.plan = c.plan
      }
      if (c.features) {
        const f = Array.from(new Set(c.features))
        if ([...f].sort().join(',') !== [...l.features].sort().join(',')) {
          changes.push(`Features ${l.features.join(', ') || 'none'} → ${f.join(', ') || 'none'}`)
          patch.features = f
          next.features = f
        }
      }
      if (c.maxUsers !== undefined && c.maxUsers !== l.maxUsers) {
        const u = intIn(c.maxUsers, 1, 10000)
        changes.push(`Max users ${l.maxUsers} → ${u}`)
        patch.maxUsers = u
        next.maxUsers = u
      }
    }
    if ((c.kind === 'firms' || c.kind === 'plan') && c.maxFirms !== undefined && c.maxFirms !== l.maxFirms) {
      const g = firmLimitGuard(c.maxFirms)
      if (!g.ok) throw new Error(g.reason)
      changes.push(`Firm limit ${l.maxFirms} → ${c.maxFirms}`)
      patch.maxFirms = c.maxFirms
      next.maxFirms = c.maxFirms
    }
    if ((c.kind === 'devices' || c.kind === 'plan') && c.maxDevices !== undefined && c.maxDevices !== l.maxDevices) {
      const g = deviceLimitGuard(c.maxDevices, l.activeDevices)
      if (!g.ok) throw new Error(g.reason)
      changes.push(`Computer limit ${l.maxDevices} → ${c.maxDevices}`)
      patch.maxDevices = c.maxDevices
      next.maxDevices = c.maxDevices
    }
    if (c.kind === 'poweredBy' && c.poweredBy !== undefined && c.poweredBy !== l.poweredBy) {
      changes.push(`"Powered by Digital Target" ${l.poweredBy ? 'on' : 'off'} → ${c.poweredBy ? 'on' : 'off'}`)
      patch.poweredBy = c.poweredBy
      next.poweredBy = c.poweredBy
    }
    if (!changes.length) throw new Error('Nothing changed.')
    tx.update(licenseRef(l.id), { ...patch, updatedAt: serverTimestamp() })
    tx.set(licenseStatusRef(l.id), licenseStatusPatch(next), { merge: true })
    writeLog(tx, l.id, TERMS_ACTION[c.kind], by, withReason(changes.join('; '), reason))
    return next
  })
}

/** Kept for older callers: renew to a new expiry (or lifetime). */
export async function renewLicense(l: License, newExpiry: Date | null, by: string, reason = ''): Promise<License> {
  return changeTerms(l.id, { kind: 'renew', expiresAt: newExpiry, planType: newExpiry ? (l.planType === 'lifetime' ? 'yearly' : l.planType) : 'lifetime' }, reason, by)
}

/**
 * Lifetime detachment (Module 8): marks the license detached. The caller signs and publishes the detached
 * certificates (approve.ts publishCertificates) — detachment is only offered while the signing key is loaded.
 */
export async function detachLicense(licenseId: string, reason: string, by: string): Promise<License> {
  return runTransaction(db, async (tx) => {
    const snap = await tx.get(licenseRef(licenseId))
    if (!snap.exists()) throw new Error('License not found.')
    const l = licenseFromSnap(snap)
    const el = detachEligibility({ planType: l.planType, expiresAtMs: l.expiresAt ? l.expiresAt.toMillis() : null, status: l.status, detached: l.detached })
    if (!el.ok) throw new Error(el.reasons.join(' '))
    const next: License = { ...l, detached: true, checkinDays: 0, detachedBy: by }
    tx.update(licenseRef(l.id), { detached: true, detachedAt: serverTimestamp(), detachedBy: by, checkinDays: 0, updatedAt: serverTimestamp() })
    tx.set(licenseStatusRef(l.id), licenseStatusPatch(next), { merge: true })
    writeLog(tx, l.id, 'license_detached', by, withReason(`Lifetime license detached from central management (${l.activeDevices} computer(s)); no further remote suspension or revocation`, reason))
    return next
  })
}

/** Re-publishes licenseStatus/{id} from the license (repair tool). */
export async function republishStatus(l: License, by: string): Promise<void> {
  const batch = writeBatch(db)
  batch.set(licenseStatusRef(l.id), licenseStatusPatch(l), { merge: true })
  writeLog(batch, l.id, 'status_published', by, `licenseStatus re-published (status ${l.status}, expiry ${expiryLabel(l)}, powered by ${l.poweredBy ? 'on' : 'off'}${l.detached ? ', detached' : ''})`)
  await batch.commit()
}

/** Links (or unlinks with '') a license to a client record. */
export async function linkLicenseClient(l: License, clientId: string, clientLabel: string, by: string): Promise<void> {
  const batch = writeBatch(db)
  batch.update(licenseRef(l.id), { clientId, updatedAt: serverTimestamp() })
  writeLog(batch, l.id, clientId ? 'client_linked' : 'client_unlinked', by, clientId ? `License linked to client ${clientLabel}` : 'License unlinked from its client', 'client')
  await batch.commit()
}

/* -------------------------------------------- devices -------------------------------------------- */

/**
 * Releases a device inside a transaction (all reads must already be done by the caller): the device stops
 * holding a slot and is added to deactivatedDevices. Returns true when the device held a slot.
 */
export function deactivateDeviceInTx(
  tx: Transaction,
  lic: License,
  devSnap: DocumentSnapshot<DocumentData>,
  deviceId: string,
  by: string,
  how: string,
  note = ''
): boolean {
  if (!devSnap.exists() || !holdsSlot(String(devSnap.data()?.status ?? 'active'))) return false
  const dev = deviceFromSnap(devSnap)
  tx.update(deviceRef(lic.id, deviceId), { status: 'deactivated', deactivatedAt: serverTimestamp(), statusChangedAt: serverTimestamp(), statusBy: by, statusNote: note.trim() })
  tx.update(licenseRef(lic.id), {
    activeDevices: Math.max(0, lic.activeDevices - 1),
    ...summaryPatch(lic, { [deviceId]: summaryEntry({ ...dev, activatedAt: devSnap.data()?.activatedAt ?? null, status: 'deactivated', statusNote: note.trim() }) }),
    updatedAt: serverTimestamp()
  })
  tx.set(licenseStatusRef(lic.id), licenseStatusPatch(lic, { add: [deviceId] }, [deviceId]), { merge: true })
  writeLog(tx, lic.id, 'device_released', by, withReason(`${deviceLabel(dev.deviceName, deviceId)} released ${how} — slot freed`, note), 'license')
  return true
}

export type DeviceAction = 'suspend' | 'revoke' | 'release' | 'reactivate'

/**
 * Device lifecycle (devices.manage):
 *  - suspend / revoke: the computer keeps its slot, is added to deactivatedDevices (read-only at its next check-in)
 *  - release: the slot is freed (the computer can be replaced by another one)
 *  - reactivate: suspended / revoked computers come back; a released one needs a free slot
 * Returns the license (for re-signing certificates after a reactivation).
 */
export async function setDeviceState(licenseId: string, deviceId: string, action: DeviceAction, note: string, by: string): Promise<License> {
  return runTransaction(db, async (tx) => {
    const licSnap = await tx.get(licenseRef(licenseId))
    const devSnap = await tx.get(deviceRef(licenseId, deviceId))
    if (!licSnap.exists()) throw new Error('License not found.')
    if (!devSnap.exists()) throw new Error('Device not found.')
    const lic = licenseFromSnap(licSnap)
    const dev = deviceFromSnap(devSnap)
    const label = deviceLabel(dev.deviceName, deviceId)
    const meta = { statusChangedAt: serverTimestamp(), statusBy: by, statusNote: note.trim() }
    const summary = (status: string) => summaryPatch(lic, { [deviceId]: summaryEntry({ ...dev, activatedAt: devSnap.data()?.activatedAt ?? null, status, statusNote: note.trim() }) })
    if (action === 'release') {
      if (!deactivateDeviceInTx(tx, lic, devSnap, deviceId, by, 'by admin', note)) throw new Error('This computer does not hold a slot (already released).')
      return { ...lic, activeDevices: Math.max(0, lic.activeDevices - 1) }
    }
    if (action === 'suspend' || action === 'revoke') {
      if (action === 'suspend' && dev.status !== 'active') throw new Error('Only an active computer can be suspended.')
      if (action === 'revoke' && !['active', 'suspended'].includes(dev.status)) throw new Error('Only an active or suspended computer can be revoked.')
      if (action === 'revoke' && !note.trim()) throw new Error('Enter a note explaining the revocation.')
      const status = action === 'suspend' ? 'suspended' : 'revoked'
      tx.update(deviceRef(licenseId, deviceId), { status, ...meta })
      tx.update(licenseRef(licenseId), { ...summary(status), updatedAt: serverTimestamp() })
      tx.set(licenseStatusRef(licenseId), licenseStatusPatch(lic, { add: [deviceId] }, [deviceId]), { merge: true })
      writeLog(tx, licenseId, `device_${status}`, by, withReason(`${label} ${status} by admin (keeps its slot)`, note), 'license')
      return lic
    }
    // reactivate
    if (dev.status === 'active') throw new Error('This computer is already active.')
    if (lic.status !== 'active') throw new Error(`The license is ${lic.status}. Reactivate the license first.`)
    let activeDevices = lic.activeDevices
    if (dev.status === 'deactivated') {
      if (lic.activeDevices >= lic.maxDevices) {
        throw new Error(`Computer limit reached (${lic.activeDevices} of ${lic.maxDevices}). Release another computer or raise the limit first.`)
      }
      activeDevices = lic.activeDevices + 1
    }
    tx.update(licenseRef(licenseId), { activeDevices, ...summary('active'), updatedAt: serverTimestamp(), ...(lic.activatedAt ? {} : { activatedAt: serverTimestamp() }) })
    tx.update(deviceRef(licenseId, deviceId), { status: 'active', deactivatedAt: null, ...meta })
    tx.set(licenseStatusRef(licenseId), licenseStatusPatch(lic, { remove: [deviceId] }), { merge: true })
    writeLog(tx, licenseId, 'device_reactivated', by, withReason(`${label} reactivated by admin (was ${dev.status === 'deactivated' ? 'released' : dev.status})`, note), 'license')
    return { ...lic, activeDevices }
  })
}

export async function adminDeactivateDevice(licenseId: string, deviceId: string, by: string, note = ''): Promise<void> {
  await setDeviceState(licenseId, deviceId, 'release', note, by)
}

export async function adminReactivateDevice(licenseId: string, deviceId: string, by: string, note = ''): Promise<void> {
  await setDeviceState(licenseId, deviceId, 'reactivate', note, by)
}

/** Recounts devices holding a slot from the devices sub-collection and fixes activeDevices (repair tool). */
export async function recountActiveDevices(licenseId: string, by: string): Promise<number> {
  const snap = await getDocs(devicesCol(licenseId))
  const n = snap.docs.filter((d) => holdsSlot(String(d.data().status ?? 'active'))).length
  const summary = buildSummary(snap.docs)
  await runTransaction(db, async (tx) => {
    const licSnap = await tx.get(licenseRef(licenseId))
    if (!licSnap.exists()) throw new Error('License not found.')
    const before = num(licSnap.data()?.activeDevices, 0)
    tx.update(licenseRef(licenseId), { activeDevices: n, devicesSummary: summary, updatedAt: serverTimestamp() })
    writeLog(tx, licenseId, 'devices_recounted', by, `Computers holding a slot recounted: ${before} → ${n}`, 'device')
  })
  return n
}

/** devicesSummary map built from device documents (backfill of licenses created before the summary existed). */
export function buildSummary(docs: Array<QueryDocumentSnapshot<DocumentData>>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const s of docs) {
    const raw = s.data()
    const d = deviceFromSnap(s)
    out[d.deviceId] = summaryEntry({ ...d, activatedAt: raw.activatedAt ?? null })
  }
  return out
}

/**
 * Writes devicesSummary on a license that has none (one-time backfill by an admin who may manage devices).
 * `docs` were read after the license version whose updatedAt is `seenUpdatedAtMs`; every device change bumps
 * updatedAt, so the transaction skips the write when anything changed in between (no stale or partial summary).
 */
export async function backfillSummary(licenseId: string, docs: Array<QueryDocumentSnapshot<DocumentData>>, seenUpdatedAtMs: number | null): Promise<boolean> {
  const summary = buildSummary(docs)
  return runTransaction(db, async (tx) => {
    const snap = await tx.get(licenseRef(licenseId))
    if (!snap.exists() || snap.data()?.devicesSummary) return false
    const u = snap.data()?.updatedAt
    if ((u instanceof Timestamp ? u.toMillis() : null) !== seenUpdatedAtMs) return false
    tx.update(licenseRef(licenseId), { devicesSummary: summary, updatedAt: serverTimestamp() })
    return true
  })
}

/* --------------------------------------------- trial license --------------------------------------------- */

export interface TrialInput {
  customerName: string
  businessName: string
  phone: string
  email: string
  city: string
  clientId?: string
  expiresAt: Date
  notes?: string
}

/**
 * Issues a trial license (plan 'trial', planType 'trial', one computer, default 15 days). The computer that
 * activates it still needs an explicit device approval like any other license.
 */
export async function issueTrial(t: TrialInput, by: string): Promise<{ id: string; licenseKey: string }> {
  const err = trialExpiryError(t.expiresAt.getTime())
  if (err) throw new Error(err)
  const p = PLAN_PRESETS.trial
  return createLicense(
    {
      customerName: t.customerName,
      businessName: t.businessName,
      phone: t.phone,
      email: t.email,
      city: t.city,
      clientId: t.clientId,
      plan: 'trial',
      planType: 'trial',
      maxDevices: 1,
      maxFirms: p.maxFirms,
      maxUsers: p.maxUsers,
      features: p.features,
      expiresAt: t.expiresAt,
      checkinDays: DEFAULT_CHECKIN_DAYS,
      graceDays: 0,
      notes: (t.notes ?? '').trim() || 'Trial license',
      poweredBy: false
    },
    by,
    'trial_issued'
  )
}
