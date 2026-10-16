/**
 * Pure license-terms logic: plan expiry suggestions, limit guards, lifetime detachment eligibility and the
 * certificate payload (v1.1) signed for each device. No Firebase imports — unit tested from the root suite,
 * where the signed payload is verified with the desktop's own verifier (src/main/license/verify.ts).
 */
import type { LicensePayload } from './crypto'
import type { PlanType } from './types'

/* ------------------------------------------------ expiry ------------------------------------------------ */

/** Licenses are valid through the END of their expiry day (local time). */
export function endOfDay(d: Date): Date {
  const x = new Date(d.getTime())
  x.setHours(23, 59, 59, 0)
  return x
}

/** Adds calendar months, clamping to the last day of the target month (31 Jan + 1 month = 28/29 Feb). */
export function addMonthsClamped(base: Date, months: number): Date {
  const y = base.getFullYear()
  const m = base.getMonth() + months
  const lastDay = new Date(y, m + 1, 0).getDate()
  const d = new Date(y, m, Math.min(base.getDate(), lastDay), base.getHours(), base.getMinutes(), base.getSeconds(), 0)
  return d
}

/** Suggested expiry for a plan starting at `from`: monthly +1 month, yearly +1 year, lifetime none. */
export function suggestExpiry(planType: PlanType, from: Date): Date | null {
  if (planType === 'lifetime') return null
  if (planType === 'trial') return trialExpiry(from)
  return endOfDay(addMonthsClamped(from, planType === 'monthly' ? 1 : 12))
}

/** Renewal extends from the current expiry when it is still in the future, otherwise from today. */
export function suggestRenewal(planType: PlanType, currentExpiryMs: number | null, now = Date.now()): Date | null {
  const base = currentExpiryMs !== null && currentExpiryMs > now ? new Date(currentExpiryMs) : new Date(now)
  return suggestExpiry(planType, base)
}

/** Plan type and expiry must agree: lifetime has no expiry, monthly / yearly need one. */
export function planTermsError(planType: PlanType, expiresAtMs: number | null): string | null {
  if (planType === 'lifetime' && expiresAtMs !== null) return 'A lifetime license has no expiry date. Clear the expiry or choose monthly / yearly.'
  if (planType !== 'lifetime' && expiresAtMs === null) return `A ${planType} license needs an expiry date.`
  return null
}

/* ------------------------------------------------ limits ------------------------------------------------ */

/** Device statuses that occupy a slot of the license's device limit (a released device frees its slot). */
export const SLOT_STATUSES = ['active', 'suspended', 'revoked'] as const

export function holdsSlot(status: string): boolean {
  return (SLOT_STATUSES as readonly string[]).includes(status)
}

/** A device limit can never go below the computers currently holding a slot. */
export function deviceLimitGuard(newLimit: number, slotsUsed: number): { ok: boolean; reason: string } {
  if (!Number.isInteger(newLimit) || newLimit < 1 || newLimit > 1000) return { ok: false, reason: 'The computer limit must be a whole number from 1 to 1000.' }
  if (newLimit < slotsUsed) {
    const n = slotsUsed - newLimit
    return { ok: false, reason: `${slotsUsed} computer(s) currently hold a slot. Release ${n} computer(s) first, then lower the limit to ${newLimit}.` }
  }
  return { ok: true, reason: '' }
}

export function firmLimitGuard(newLimit: number): { ok: boolean; reason: string } {
  if (!Number.isInteger(newLimit) || newLimit < 1 || newLimit > 1000) return { ok: false, reason: 'The firm limit must be a whole number from 1 to 1000.' }
  return { ok: true, reason: '' }
}

/* ------------------------------------------------ detachment ------------------------------------------------ */

export interface DetachInput {
  planType: PlanType
  expiresAtMs: number | null
  status: string
  detached: boolean
}

/**
 * Lifetime detachment (Module 8) is only possible for a valid, active lifetime license without expiry.
 * After detachment the installation never checks in again, so it can no longer be suspended or revoked remotely.
 */
export function detachEligibility(l: DetachInput, now = Date.now()): { ok: boolean; reasons: string[] } {
  const reasons: string[] = []
  if (l.detached) reasons.push('This license is already detached.')
  if (l.planType !== 'lifetime') reasons.push('Only lifetime licenses can be detached (change the plan to lifetime first).')
  if (l.expiresAtMs !== null) reasons.push(l.expiresAtMs <= now ? 'The license has expired.' : 'The license has an expiry date — lifetime licenses have none.')
  if (l.status !== 'active') reasons.push(`The license is ${l.status}. Only active licenses can be detached.`)
  return { ok: reasons.length === 0, reasons }
}

/* ------------------------------------------------ certificates ------------------------------------------------ */

/** Everything a certificate carries, independent of Firestore types. */
export interface CertTerms {
  licenseId: string
  customerName: string
  businessName: string
  phone: string
  email: string
  plan: string
  planType: PlanType
  clientId: string
  maxFirms: number
  maxUsers: number
  maxDevices: number
  features: string[]
  expiresAtMs: number | null
  graceDays: number
  checkinDays: number
  poweredBy: boolean
  detached: boolean
}

/**
 * Certificate payload for one device (format v1, compatible with src/main/license/verify.ts).
 * A detached license is always lifetime (expiresAt null) with checkinDays 0 so the desktop never needs to check in.
 */
export function buildCertPayload(t: CertTerms, deviceId: string, issuedAt: Date = new Date()): LicensePayload {
  const detached = t.detached === true
  if (detached && t.expiresAtMs !== null) throw new Error('A detached license must be a lifetime license without expiry.')
  const payload: LicensePayload = {
    v: 1,
    licenseId: t.licenseId,
    customerName: t.customerName || t.businessName,
    businessName: t.businessName || t.customerName,
    phone: t.phone,
    email: t.email,
    deviceId,
    plan: t.plan,
    maxFirms: t.maxFirms,
    maxUsers: t.maxUsers,
    features: [...t.features],
    issuedAt: issuedAt.toISOString(),
    expiresAt: t.expiresAtMs === null ? null : new Date(t.expiresAtMs).toISOString(),
    leaseUntil: null,
    graceDays: t.graceDays,
    checkinDays: detached ? 0 : t.checkinDays,
    planType: t.planType,
    maxDevices: t.maxDevices,
    poweredBy: t.poweredBy === true,
    detached
  }
  if (t.clientId) payload.clientId = t.clientId
  return payload
}

/** Fields of the terms that end up in certificates — a change in any of them requires re-signing. */
export function certTermsChanged(a: CertTerms, b: CertTerms): string[] {
  const out: string[] = []
  const keys: (keyof CertTerms)[] = ['customerName', 'businessName', 'phone', 'email', 'plan', 'planType', 'clientId', 'maxFirms', 'maxUsers', 'maxDevices', 'expiresAtMs', 'graceDays', 'checkinDays', 'poweredBy', 'detached']
  for (const k of keys) if (a[k] !== b[k]) out.push(k)
  if ([...a.features].sort().join(',') !== [...b.features].sort().join(',')) out.push('features')
  return out
}

/* ------------------------------------------- published certificates ------------------------------------------- */

/** Decodes the payload of a compact activation code (`payload.signature`) without verifying it. */
export function decodeCertPayload(code: string | null | undefined): Record<string, unknown> | null {
  if (typeof code !== 'string' || !code.includes('.')) return null
  try {
    let b64 = code.split('.')[0].replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/')
    while (b64.length % 4 !== 0) b64 += '='
    const bin = atob(b64)
    const bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
    const obj = JSON.parse(new TextDecoder().decode(bytes))
    return obj && typeof obj === 'object' ? (obj as Record<string, unknown>) : null
  } catch {
    return null
  }
}

export type CertFreshness = 'current' | 'outdated' | 'missing'
export interface CertCheck {
  deviceId: string
  state: CertFreshness
  /** Payload fields that differ from the current license terms. */
  diff: string[]
  issuedAt: string | null
}

const COMPARED_FIELDS = ['licenseId', 'deviceId', 'customerName', 'businessName', 'phone', 'email', 'plan', 'planType', 'clientId', 'maxFirms', 'maxUsers', 'maxDevices', 'expiresAt', 'graceDays', 'checkinDays', 'poweredBy', 'detached'] as const

/**
 * Compares the certificates published in licenseStatus.certs with the current license terms, for every device
 * that holds an ACTIVE slot. "missing" = no certificate published yet (e.g. activated before v1.1, or a publish is
 * pending), "outdated" = a certificate exists but carries older terms → "Publish certificates" fixes both.
 */
export function certificateFreshness(terms: CertTerms, activeDeviceIds: string[], published: Record<string, unknown> | null | undefined): CertCheck[] {
  return activeDeviceIds.map((deviceId) => {
    const code = published?.[deviceId]
    const p = decodeCertPayload(typeof code === 'string' ? code : null)
    if (!p) return { deviceId, state: 'missing' as const, diff: [], issuedAt: null }
    const want = buildCertPayload(terms, deviceId) as unknown as Record<string, unknown>
    const diff: string[] = []
    for (const k of COMPARED_FIELDS) {
      const a = p[k] ?? (k === 'clientId' ? '' : k === 'poweredBy' || k === 'detached' ? false : null)
      const b = want[k] ?? (k === 'clientId' ? '' : k === 'poweredBy' || k === 'detached' ? false : null)
      if (k === 'expiresAt') {
        const am = typeof a === 'string' ? Date.parse(a) : null
        const bm = typeof b === 'string' ? Date.parse(b) : null
        if (am !== bm) diff.push(k)
        continue
      }
      if (a !== b) diff.push(k)
    }
    const fa = Array.isArray(p.features) ? [...(p.features as string[])].sort().join(',') : ''
    if (fa !== [...terms.features].sort().join(',')) diff.push('features')
    return { deviceId, state: diff.length ? ('outdated' as const) : ('current' as const), diff, issuedAt: typeof p.issuedAt === 'string' ? p.issuedAt : null }
  })
}

/* ------------------------------------------------ trial ------------------------------------------------ */

/** Default length of a portal-issued trial license (editable when issuing, 1 – TRIAL_MAX_DAYS days). */
export const TRIAL_DAYS = 15
export const TRIAL_MAX_DAYS = 90

/** Trial expiry: end of the day `days` days after `from`. */
export function trialExpiry(from: Date, days = TRIAL_DAYS): Date {
  const d = new Date(from.getTime())
  d.setDate(d.getDate() + days)
  return endOfDay(d)
}

/** Validates a trial expiry chosen by the admin (future, at most TRIAL_MAX_DAYS ahead). */
export function trialExpiryError(expiresAtMs: number | null, now = Date.now()): string | null {
  if (expiresAtMs === null || !Number.isFinite(expiresAtMs)) return 'A trial needs an expiry date.'
  if (expiresAtMs <= now) return 'The trial expiry must be in the future.'
  if (expiresAtMs > endOfDay(new Date(now + TRIAL_MAX_DAYS * 86400e3)).getTime()) return `A trial can last at most ${TRIAL_MAX_DAYS} days.`
  return null
}

/* --------------------------------------------- activation policy --------------------------------------------- */

/**
 * What approving an activation request would do. Nothing is ever approved automatically: every outcome below
 * is shown to an admin with devices.manage, who approves, reassigns or rejects explicitly.
 *  - reissue:  the computer already holds an ACTIVE slot on this license → a new certificate, no new slot
 *  - new:      a free slot exists → the computer takes it
 *  - reassign: the limit is full → the admin may reject, or replace one computer holding a slot with this one
 *  - invalid:  cannot be approved (license suspended / revoked / expired, computer suspended / revoked)
 */
export type ActivationPlan =
  | { kind: 'reissue' }
  | { kind: 'new'; slotsUsed: number; maxDevices: number }
  | { kind: 'reassign'; slotsUsed: number; maxDevices: number }
  | { kind: 'invalid'; reason: string }

export function classifyActivation(
  lic: { status: string; expiresAtMs: number | null; activeDevices: number; maxDevices: number },
  existingStatus: string | null,
  now = Date.now()
): ActivationPlan {
  if (lic.status === 'suspended') return { kind: 'invalid', reason: 'License is suspended' }
  if (lic.status === 'revoked') return { kind: 'invalid', reason: 'License is revoked' }
  if (lic.status !== 'active') return { kind: 'invalid', reason: `License is ${lic.status}` }
  if (lic.expiresAtMs !== null && lic.expiresAtMs <= now) return { kind: 'invalid', reason: 'License expired' }
  if (existingStatus === 'suspended') return { kind: 'invalid', reason: 'This computer is suspended. Contact Digital Target.' }
  if (existingStatus === 'revoked') return { kind: 'invalid', reason: 'This computer has been revoked. Contact Digital Target.' }
  if (existingStatus === 'active') return { kind: 'reissue' }
  if (lic.activeDevices >= lic.maxDevices) return { kind: 'reassign', slotsUsed: lic.activeDevices, maxDevices: lic.maxDevices }
  return { kind: 'new', slotsUsed: lic.activeDevices, maxDevices: lic.maxDevices }
}

/** A computer may be replaced only when it holds a slot and is not the requesting computer itself. */
export function replaceableError(replaced: { deviceId: string; status: string } | null, newDeviceId: string): string | null {
  if (!replaced) return 'The computer to replace no longer exists on this license.'
  if (replaced.deviceId === newDeviceId) return 'A computer cannot replace itself.'
  if (!holdsSlot(replaced.status)) return 'The computer to replace no longer holds a slot (already released).'
  return null
}

/* ------------------------------------------------ masking ------------------------------------------------ */

/** DTSP-AB12-CD34-EF56-GH78 → DTSP-AB12-••••-••••-GH78 (lists show the masked key; copy gives the full key). */
export function maskLicenseKey(key: string): string {
  const p = key.split('-')
  if (p.length !== 5) return key.length > 8 ? `${key.slice(0, 4)}…${key.slice(-4)}` : key
  return `${p[0]}-${p[1]}-••••-••••-${p[4]}`
}

/** Device ids are never written in full to logs: first 4 + last 4 characters. */
export function maskDeviceId(id: string): string {
  if (!id) return ''
  return id.length <= 10 ? `${id.slice(0, 2)}…` : `${id.slice(0, 4)}…${id.slice(-4)}`
}
