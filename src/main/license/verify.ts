import { createPublicKey, verify } from 'crypto'
import type { BlockReason, LicenseCertificate, LicenseMode, LicensePayload } from './types'

export function b64urlDecode(s: string): Buffer {
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64')
}

export function parseCertificate(text: string): LicenseCertificate {
  let raw = text.trim()
  // Accept either the JSON file or a compact "payload.signature" activation code.
  if (!raw.startsWith('{') && raw.includes('.')) {
    const [payload, signature] = raw.replace(/\s+/g, '').split('.')
    return { format: 'dtsp-license', version: 1, payload, signature }
  }
  const obj = JSON.parse(raw) as LicenseCertificate
  if (obj.format !== 'dtsp-license' || typeof obj.payload !== 'string' || typeof obj.signature !== 'string') {
    throw new Error('This is not a DT Solar Pro license file.')
  }
  return obj
}

/** Device id of an activation pass: signed for any computer, valid only once this computer registered with it. */
export const PASS_DEVICE = '*'

export function verifyCertificate(
  cert: LicenseCertificate,
  publicKeyPem: string,
  deviceId: string,
  /** Accepts an activation pass of this license (true only after this computer registered on it online). */
  passBound: (licenseId: string) => boolean = () => false
): { ok: true; payload: LicensePayload } | { ok: false; reason: string } {
  if (!publicKeyPem || !publicKeyPem.includes('BEGIN PUBLIC KEY')) return { ok: false, reason: 'License verification key is not configured in this build.' }
  let valid = false
  try {
    const key = createPublicKey(publicKeyPem)
    valid = verify(null, Buffer.from(cert.payload, 'utf8'), key, b64urlDecode(cert.signature))
  } catch {
    valid = false
  }
  if (!valid) return { ok: false, reason: 'License signature is invalid. The license file may have been modified.' }
  let payload: LicensePayload
  try {
    payload = JSON.parse(b64urlDecode(cert.payload).toString('utf8')) as LicensePayload
  } catch {
    return { ok: false, reason: 'License data is corrupt.' }
  }
  if (payload.v !== 1) return { ok: false, reason: 'Unsupported license version. Please update the application.' }
  if (payload.deviceId === PASS_DEVICE) {
    if (!passBound(String(payload.licenseId))) return { ok: false, reason: 'This activation pass is not registered on this computer. Activate online with the license key.' }
    return { ok: true, payload }
  }
  if (payload.deviceId !== deviceId) return { ok: false, reason: 'This license was issued for a different computer.' }
  return { ok: true, payload }
}

export interface EvalInput {
  now: number
  payload: LicensePayload | null
  certError: string | null
  /** Legacy (v1.0 local trial start). Ignored — kept so old state files and callers stay valid. */
  trialStartedAt?: number
  /** An old installation that used the former local trial (only changes the wording). */
  legacyTrial?: boolean
  lastSeenAt: number
  /** Remote decision (licenseStatus): 'suspended' | 'revoked' | 'deactivated' (this device), null = none. */
  remoteStatus: string | null
  /** Last successful online verification (ms), null if never. */
  lastCheckAt?: number | null
}

const DAY = 86400000

export type EvalResult = { mode: LicenseMode; message: string; trialDaysLeft: number | null; daysLeft: number | null; graceDaysLeft: number | null }

const SAFE = 'Your data is safe and can still be viewed, printed, exported and backed up.'

export const NOT_ACTIVATED_MESSAGE = `DT Solar Pro is not activated on this computer. Activate your license to add or change records. ${SAFE}`
export const LEGACY_TRIAL_MESSAGE = `Activate your license — the built-in trial is no longer available. ${SAFE}`

/** Pure license-mode evaluation (unit tested). There is no local trial: without a certificate the app is not activated. */
export function evaluate(i: EvalInput): EvalResult {
  const none = { trialDaysLeft: null, daysLeft: null, graceDaysLeft: null }
  if (i.lastSeenAt && i.now < i.lastSeenAt - DAY) {
    return { mode: 'clock_error', message: 'Your computer date/time appears to have been moved backwards. Correct the system clock to continue.', ...none }
  }
  if (!i.payload) {
    if (i.certError) return { mode: 'invalid', message: `${i.certError} ${SAFE}`, ...none }
    return { mode: 'not_activated', message: i.legacyTrial ? LEGACY_TRIAL_MESSAGE : NOT_ACTIVATED_MESSAGE, ...none }
  }
  const p = i.payload
  const isTrial = String(p.plan ?? '').toLowerCase() === 'trial'
  // A lifetime license detached from central management ignores remote status and check-in requirements.
  const detached = p.detached === true && !p.expiresAt
  if (!detached && i.remoteStatus === 'revoked') return { mode: 'revoked', message: `This license has been revoked by Digital Target. Contact Digital Target. ${SAFE}`, ...none }
  if (!detached && i.remoteStatus === 'suspended') return { mode: 'suspended', message: `This license is suspended by Digital Target. Contact Digital Target to restore access. ${SAFE}`, ...none }
  if (!detached && i.remoteStatus === 'deactivated') {
    return { mode: 'device_deactivated', message: `This computer has been deactivated for this license by Digital Target (device suspended or released). Contact Digital Target to approve it again. ${SAFE}`, ...none }
  }
  const daysLeft = p.expiresAt ? Math.ceil((Date.parse(p.expiresAt) - i.now) / DAY) : null
  if (daysLeft !== null && daysLeft <= 0) {
    if (isTrial) return { mode: 'trial_expired', message: `Your trial license has ended. Activate a full license to continue adding records. ${SAFE}`, trialDaysLeft: 0, daysLeft: 0, graceDaysLeft: null }
    return { mode: 'expired', message: `Your license has expired. Renew it to continue adding records. ${SAFE}`, trialDaysLeft: null, daysLeft: 0, graceDaysLeft: null }
  }
  const trialLeft = isTrial ? daysLeft : null
  const overdue = (graceEnd: number): EvalResult => {
    const graceLeft = Math.ceil((graceEnd - i.now) / DAY)
    if (graceLeft > 0) {
      return { mode: 'grace', message: `Please connect to the internet so the license can be verified (${graceLeft} day(s) left).`, trialDaysLeft: trialLeft, daysLeft, graceDaysLeft: graceLeft }
    }
    return { mode: 'lease_expired', message: `License verification is overdue. Connect to the internet and click "Check license now". ${SAFE}`, trialDaysLeft: trialLeft, daysLeft, graceDaysLeft: 0 }
  }
  if (!detached && p.leaseUntil && i.now > Date.parse(p.leaseUntil)) {
    return overdue(Date.parse(p.leaseUntil) + Math.max(0, p.graceDays) * DAY)
  }
  if (!detached && p.checkinDays && p.checkinDays > 0) {
    const baseline = Math.max(i.lastCheckAt ?? 0, Date.parse(p.issuedAt) || 0)
    const due = baseline + p.checkinDays * DAY
    if (i.now > due) return overdue(due + Math.max(0, p.graceDays) * DAY)
  }
  if (isTrial) {
    const left = daysLeft ?? null
    return { mode: 'trial', message: left !== null ? `Trial — ${left} day(s) left. Licensed to ${p.businessName}.` : `Trial license for ${p.businessName}.`, trialDaysLeft: left, daysLeft, graceDaysLeft: null }
  }
  const warn = daysLeft !== null && daysLeft <= 15 ? ` License expires in ${daysLeft} day(s).` : ''
  return { mode: 'active', message: `Licensed to ${p.businessName}.${warn}`, trialDaysLeft: null, daysLeft, graceDaysLeft: null }
}

export const WRITE_MODES: LicenseMode[] = ['trial', 'active', 'grace']

/** Which kind of problem blocks writes (null = writes allowed). Drives distinct license / device / connectivity messages. */
export function blockReasonOf(mode: LicenseMode): BlockReason | null {
  switch (mode) {
    case 'trial':
    case 'active':
    case 'grace':
      return null
    case 'device_deactivated':
      return 'device'
    case 'lease_expired':
      return 'connectivity'
    case 'clock_error':
      return 'clock'
    case 'not_activated':
    case 'invalid':
      return 'activation'
    default:
      return 'license'
  }
}
