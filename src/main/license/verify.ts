import { createPublicKey, verify } from 'crypto'
import type { LicenseCertificate, LicenseMode, LicensePayload } from './types'
import { TRIAL_DAYS } from './types'

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

export function verifyCertificate(
  cert: LicenseCertificate,
  publicKeyPem: string,
  deviceId: string
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
  if (payload.deviceId !== deviceId) return { ok: false, reason: 'This license was issued for a different computer.' }
  return { ok: true, payload }
}

export interface EvalInput {
  now: number
  payload: LicensePayload | null
  certError: string | null
  trialStartedAt: number
  lastSeenAt: number
  remoteStatus: string | null
  /** Last successful online verification (ms), null if never. */
  lastCheckAt?: number | null
}

const DAY = 86400000

/** Pure license-mode evaluation (unit tested). */
export function evaluate(i: EvalInput): { mode: LicenseMode; message: string; trialDaysLeft: number | null; daysLeft: number | null; graceDaysLeft: number | null } {
  const none = { trialDaysLeft: null, daysLeft: null, graceDaysLeft: null }
  if (i.lastSeenAt && i.now < i.lastSeenAt - DAY) {
    return { mode: 'clock_error', message: 'Your computer date/time appears to have been moved backwards. Correct the system clock to continue.', ...none }
  }
  if (!i.payload) {
    if (i.certError) return { mode: 'invalid', message: i.certError, ...none }
    const left = Math.ceil((i.trialStartedAt + TRIAL_DAYS * DAY - i.now) / DAY)
    if (left > 0) return { mode: 'trial', message: `Trial version — ${left} day(s) left. Activate a license to continue after the trial.`, trialDaysLeft: left, daysLeft: null, graceDaysLeft: null }
    return { mode: 'trial_expired', message: 'The trial period has ended. Your data is safe — activate a license to continue adding records.', trialDaysLeft: 0, daysLeft: null, graceDaysLeft: null }
  }
  const p = i.payload
  // A lifetime license detached from central management ignores remote status and check-in requirements.
  const detached = p.detached === true && !p.expiresAt
  if (!detached && i.remoteStatus === 'revoked') return { mode: 'revoked', message: 'This license has been revoked. Contact Digital Target. Your data is safe and can be viewed, printed and backed up.', ...none }
  if (!detached && i.remoteStatus === 'suspended') return { mode: 'suspended', message: 'This license is suspended. Contact Digital Target to restore access. Your data is safe.', ...none }
  const daysLeft = p.expiresAt ? Math.ceil((Date.parse(p.expiresAt) - i.now) / DAY) : null
  if (daysLeft !== null && daysLeft <= 0) {
    return { mode: 'expired', message: 'Your license has expired. Renew it to continue adding records. Your data is safe.', trialDaysLeft: null, daysLeft: 0, graceDaysLeft: null }
  }
  if (!detached && p.leaseUntil && i.now > Date.parse(p.leaseUntil)) {
    const graceEnd = Date.parse(p.leaseUntil) + Math.max(0, p.graceDays) * DAY
    const graceLeft = Math.ceil((graceEnd - i.now) / DAY)
    if (graceLeft > 0) {
      return { mode: 'grace', message: `Please connect to the internet so the license can be verified (${graceLeft} day(s) left).`, trialDaysLeft: null, daysLeft, graceDaysLeft: graceLeft }
    }
    return { mode: 'lease_expired', message: 'License verification is overdue. Connect to the internet and click "Check license now".', trialDaysLeft: null, daysLeft, graceDaysLeft: 0 }
  }
  if (!detached && p.checkinDays && p.checkinDays > 0) {
    const baseline = Math.max(i.lastCheckAt ?? 0, Date.parse(p.issuedAt) || 0)
    const due = baseline + p.checkinDays * DAY
    if (i.now > due) {
      const graceLeft = Math.ceil((due + Math.max(0, p.graceDays) * DAY - i.now) / DAY)
      if (graceLeft > 0) {
        return { mode: 'grace', message: `Please connect to the internet so the license can be verified (${graceLeft} day(s) left).`, trialDaysLeft: null, daysLeft, graceDaysLeft: graceLeft }
      }
      return { mode: 'lease_expired', message: 'License verification is overdue. Connect to the internet and click "Check license now".', trialDaysLeft: null, daysLeft, graceDaysLeft: 0 }
    }
  }
  const warn = daysLeft !== null && daysLeft <= 15 ? ` License expires in ${daysLeft} day(s).` : ''
  return { mode: 'active', message: `Licensed to ${p.businessName}.${warn}`, trialDaysLeft: null, daysLeft, graceDaysLeft: null }
}

export const WRITE_MODES: LicenseMode[] = ['trial', 'active', 'grace']
