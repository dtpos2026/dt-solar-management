/**
 * Administrator password reset sent by Digital Target (Super Admin portal).
 *
 * Security model (no server, no plaintext password anywhere):
 *  - The portal creates a random temporary password in the browser and signs a command that contains only a salted
 *    PBKDF2-SHA256 verifier of it (never the password), the computer's device id, a random nonce and an expiry.
 *  - The command reaches this computer online (licenseStatus, picked up at check-in) or offline (pasted on the sign-in screen).
 *    It is verified with the license public key, is bound to this computer, expires, and works once (nonce).
 *  - It does NOT change the account by itself. The Administrator signs in once with the temporary password the Super Admin
 *    relays (never stored on this computer); the app then replaces it with a normal scrypt hash and forces a new password.
 */
import { pbkdf2Sync, timingSafeEqual } from 'crypto'
import type { DB } from '../db'
import { parseCommand, verifyCommand } from '../license/verify'
import { AppError, getSetting, setSetting } from './context'

export const RESET_TYPE = 'admin_password_reset'
const PENDING_KEY = 'admin_reset_pending'
const USED_KEY = 'admin_reset_nonces'
const STATE_KEY = 'admin_reset_state'
const MAX_VALIDITY_MS = 8 * 86400000
const MAX_FUTURE_SKEW_MS = 24 * 3600000
const MIN_ITER = 100_000
const MAX_ITER = 1_000_000

export interface PendingReset {
  nonce: string
  issuedAt: string
  expiresAt: string
  iter: number
  salt: string
  verifier: string
}

/** What the Administrator typed, normalised the same way the portal normalised the generated password. */
export const normalizeTemp = (s: string): string => String(s ?? '').replace(/[\s-]/g, '').toUpperCase()

/** The one stored form of a temporary password: capitals in groups of four ("K7MQ-2WXP-9TDH-4RNC"), however it was typed. */
export const canonicalTemp = (s: string): string => normalizeTemp(s).replace(/(.{4})(?=.)/g, '$1-')

export function getPendingReset(db: DB, now = Date.now()): PendingReset | null {
  const p = getSetting<PendingReset | null>(db, PENDING_KEY, null)
  if (!p || typeof p.verifier !== 'string') return null
  if (!(Date.parse(p.expiresAt) > now)) return null
  return p
}

export function resetState(db: DB): string {
  return String(getSetting<string>(db, STATE_KEY, '') ?? '').slice(0, 80)
}

/** True when `password` is the temporary password this pending reset was created for. */
export function matchTemporaryPassword(p: PendingReset, password: string): boolean {
  const pw = normalizeTemp(password)
  if (pw.length < 8 || pw.length > 64) return false
  const actual = pbkdf2Sync(pw, Buffer.from(p.salt, 'base64'), p.iter, 32, 'sha256')
  const expected = Buffer.from(p.verifier, 'base64')
  return expected.length === actual.length && timingSafeEqual(expected, actual)
}

/** The reset was used (the Administrator signed in with the temporary password): nonce burnt, nothing left pending. */
export function consumeReset(db: DB, p: PendingReset): void {
  db.prepare('DELETE FROM settings WHERE key = ?').run(PENDING_KEY)
  const used = getSetting<string[]>(db, USED_KEY, [])
  setSetting(db, USED_KEY, [...used.filter((n) => n !== p.nonce), p.nonce].slice(-50))
  setSetting(db, STATE_KEY, `${p.nonce}:used`)
}

export type ApplyResult = { status: 'received' | 'duplicate' | 'rejected'; message: string }

/**
 * Verifies a reset command and stores it as pending. Never throws for the benign repeat (the online channel offers the
 * same command at every check-in); `rejected` carries the reason.
 */
export function applyResetCommand(db: DB, code: string, ctx: { publicKeyPem: string; deviceId: string; now?: number }): ApplyResult {
  const now = ctx.now ?? Date.now()
  const reject = (message: string): ApplyResult => ({ status: 'rejected', message })
  let cmd
  try {
    cmd = parseCommand(code)
  } catch (e) {
    return reject((e as Error).message)
  }
  const v = verifyCommand(cmd, ctx.publicKeyPem)
  if (!v.ok) return reject(v.reason)
  const p = v.payload
  if (p.type !== RESET_TYPE || p.v !== 1) return reject('This code is not an Administrator password reset.')
  if (p.deviceId !== ctx.deviceId) return reject('This reset code was issued for a different computer.')
  const nonce = typeof p.nonce === 'string' && /^[A-Za-z0-9_-]{16,64}$/.test(p.nonce) ? p.nonce : ''
  const issued = Date.parse(String(p.issuedAt))
  const expires = Date.parse(String(p.expiresAt))
  const kdf = (p.kdf ?? {}) as { alg?: unknown; iter?: unknown; salt?: unknown }
  const iter = Number(kdf.iter)
  const salt = typeof kdf.salt === 'string' ? kdf.salt : ''
  const verifier = typeof p.verifier === 'string' ? p.verifier : ''
  if (!nonce || !Number.isFinite(issued) || !Number.isFinite(expires) || kdf.alg !== 'pbkdf2-sha256' || !Number.isInteger(iter) || iter < MIN_ITER || iter > MAX_ITER || !salt || !verifier) {
    return reject('The reset code is malformed.')
  }
  if (expires - issued > MAX_VALIDITY_MS) return reject('The reset code has an invalid validity period.')
  if (issued > now + MAX_FUTURE_SKEW_MS) return reject('The reset code is dated in the future. Check this computer’s date and time.')
  if (expires <= now) return reject('This reset code has expired. Ask Digital Target for a new one.')
  const used = getSetting<string[]>(db, USED_KEY, [])
  if (used.includes(nonce)) return { status: 'duplicate', message: 'This reset code was already used.' }
  const cur = getSetting<PendingReset | null>(db, PENDING_KEY, null)
  if (cur && cur.nonce === nonce) return { status: 'duplicate', message: 'This reset code was already received.' }
  setSetting(db, PENDING_KEY, { nonce, issuedAt: new Date(issued).toISOString(), expiresAt: new Date(expires).toISOString(), iter, salt, verifier } satisfies PendingReset)
  setSetting(db, STATE_KEY, `${nonce}:received`)
  return { status: 'received', message: 'Reset code accepted. Sign in as the Administrator with the temporary password from Digital Target; you will then choose a new password.' }
}

/** Manual entry (sign-in screen): anything but "received" is an error for the person typing. */
export function applyResetCodeOrThrow(db: DB, code: string, ctx: { publicKeyPem: string; deviceId: string; now?: number }): string {
  const r = applyResetCommand(db, code, ctx)
  if (r.status === 'rejected') throw new AppError(r.message, 'VALIDATION')
  return r.message
}
