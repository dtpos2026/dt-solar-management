import { createHash, createPublicKey, verify, type KeyObject } from 'crypto'
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

const PEM_BLOCK = /-----BEGIN PUBLIC KEY-----[\s\S]*?-----END PUBLIC KEY-----/g

/**
 * The public keys this build trusts. resources/license-public.pem normally holds one key; a build made on a computer that used
 * several signing keys earlier (each fresh source folder used to create its own) holds all of them, so a license signed by any of
 * the owner's keys verifies. Every key in the file is a key the owner created.
 */
export function publicKeysOf(publicKeyPem: string): KeyObject[] {
  const out: KeyObject[] = []
  for (const block of (publicKeyPem || '').match(PEM_BLOCK) ?? []) {
    try {
      out.push(createPublicKey(block))
    } catch {
      /* a damaged block never verifies anything */
    }
  }
  return out
}

const idOf = (k: KeyObject): string => createHash('sha256').update(k.export({ type: 'spki', format: 'der' }) as Buffer).digest('hex').slice(0, 16).toUpperCase()

/**
 * Short identifier of the license public key(s) ("A1B2C3D4E5F60718"): the first 8 bytes of SHA-256 over the SPKI DER, the same value
 * the Super Admin panel shows for its signing key (first 16 hex digits of the key fingerprint). Several trusted keys are listed
 * separated by commas. Not a secret.
 */
export function publicKeyId(publicKeyPem: string): string {
  return publicKeysOf(publicKeyPem).map(idOf).join(',')
}

/** True when `key` (any of the keys of the pem) verifies the signature. */
function anyKeyVerifies(publicKeyPem: string, message: Buffer, signature: Buffer): boolean {
  for (const k of publicKeysOf(publicKeyPem)) {
    try {
      if (verify(null, message, k, signature)) return true
    } catch {
      /* try the next key */
    }
  }
  return false
}

export const SIGNATURE_INVALID = 'License signature is invalid. The license file may have been modified.'

/** What a signature failure means for the person looking at the screen: almost always a build made with another signing key. */
export function keyMismatchMessage(publicKeyPem: string): string {
  const id = publicKeyId(publicKeyPem)
  return `This installation was built with a different license key (key ID ${id || 'unknown'}) than the one Digital Target signs licenses with, so no license or activation pass can be verified here. Waiting will not fix it: install the official DT Solar Pro build from Digital Target, or ask Digital Target to rebuild it with the matching key.`
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
    valid = anyKeyVerifies(publicKeyPem, Buffer.from(cert.payload, 'utf8'), b64urlDecode(cert.signature))
  } catch {
    valid = false
  }
  if (!valid) return { ok: false, reason: SIGNATURE_INVALID }
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
  /** Legacy (v1.0 local trial start). Ignored - kept so old state files and callers stay valid. */
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
export const LEGACY_TRIAL_MESSAGE = `Activate your license - the built-in trial is no longer available. ${SAFE}`

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
    return { mode: 'trial', message: left !== null ? `Trial - ${left} day(s) left. Licensed to ${p.businessName}.` : `Trial license for ${p.businessName}.`, trialDaysLeft: left, daysLeft, graceDaysLeft: null }
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

/* ------------------------------------------------ signed commands ------------------------------------------------ */

/**
 * A command from Digital Target (for example "reset the Administrator password of this computer"). Same Ed25519 key as the
 * licenses, but signed over `COMMAND_DOMAIN + payload`, so a command can never be installed as a license certificate and a
 * license certificate can never be replayed as a command.
 */
export const COMMAND_DOMAIN = 'dtsp-cmd-v1.'

export interface SignedCommand {
  format: 'dtsp-command'
  version: 1
  payload: string
  signature: string
}

/** Accepts the JSON file or the compact "payload.signature" code. */
export function parseCommand(text: string): SignedCommand {
  const raw = String(text ?? '').trim()
  if (!raw.startsWith('{') && raw.includes('.')) {
    const [payload, signature] = raw.replace(/\s+/g, '').split('.')
    if (payload && signature) return { format: 'dtsp-command', version: 1, payload, signature }
  }
  try {
    const obj = JSON.parse(raw) as SignedCommand
    if (obj.format === 'dtsp-command' && typeof obj.payload === 'string' && typeof obj.signature === 'string') return obj
  } catch {
    /* fall through */
  }
  throw new Error('This is not a Digital Target reset code.')
}

export function verifyCommand(cmd: SignedCommand, publicKeyPem: string): { ok: true; payload: Record<string, unknown> } | { ok: false; reason: string } {
  if (!publicKeyPem || !publicKeyPem.includes('BEGIN PUBLIC KEY')) return { ok: false, reason: 'Verification key is not configured in this build.' }
  let valid = false
  try {
    valid = anyKeyVerifies(publicKeyPem, Buffer.from(COMMAND_DOMAIN + cmd.payload, 'utf8'), b64urlDecode(cmd.signature))
  } catch {
    valid = false
  }
  if (!valid) return { ok: false, reason: 'The reset code is not valid (signature check failed).' }
  try {
    const payload = JSON.parse(b64urlDecode(cmd.payload).toString('utf8')) as Record<string, unknown>
    if (!payload || typeof payload !== 'object') throw new Error('shape')
    return { ok: true, payload }
  } catch {
    return { ok: false, reason: 'The reset code is corrupt.' }
  }
}
