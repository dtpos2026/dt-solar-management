/**
 * Pure (Firestore-free) part of the Administrator password reset: temporary password, PBKDF2 verifier and the signed command.
 * See passwordReset.ts for the publishing side and src/main/services/adminReset.ts (desktop) for the verifying side.
 */
import { bytesToBase64, bytesToBase64Url, signCommand, verifyCommandCode, type LoadedKey } from './crypto'

export const RESET_TYPE = 'admin_password_reset'
export const RESET_VALID_HOURS = 72
export const PBKDF2_ITERATIONS = 200_000
/** No 0/O, 1/I/L: the password is read out over the phone or WhatsApp. 31 symbols x 16 = about 79 bits. */
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'

/** What the customer may type: dashes, spaces and case do not matter (same normalisation as the desktop app). */
export const normalizeTemp = (s: string): string => s.replace(/[\s-]/g, '').toUpperCase()

function randomBytes(n: number): Uint8Array {
  const b = new Uint8Array(n)
  crypto.getRandomValues(b)
  return b
}

/** Random temporary password "XXXX-XXXX-XXXX-XXXX" (rejection sampling: no modulo bias). */
export function generateTempPassword(groups = 4): string {
  const limit = 256 - (256 % ALPHABET.length)
  const chars: string[] = []
  while (chars.length < groups * 4) {
    for (const b of randomBytes(32)) {
      if (b < limit && chars.length < groups * 4) chars.push(ALPHABET[b % ALPHABET.length])
    }
  }
  return Array.from({ length: groups }, (_, i) => chars.slice(i * 4, i * 4 + 4).join('')).join('-')
}

export async function pbkdf2Sha256(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits'])
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: salt as unknown as ArrayBuffer, iterations }, key, 256))
}

export interface ResetCommand {
  /** Paste-able signed code (payload.signature). */
  code: string
  /** The temporary password: show once, never store. */
  password: string
  nonce: string
  issuedAt: Date
  expiresAt: Date
}

export async function buildResetCommand(input: { licenseId: string; deviceId: string; key: LoadedKey; now?: number; validHours?: number; password?: string }): Promise<ResetCommand> {
  const now = input.now ?? Date.now()
  const password = input.password ?? generateTempPassword()
  const salt = randomBytes(16)
  const verifier = await pbkdf2Sha256(normalizeTemp(password), salt, PBKDF2_ITERATIONS)
  const nonce = bytesToBase64Url(randomBytes(16))
  const issuedAt = new Date(now)
  const expiresAt = new Date(now + (input.validHours ?? RESET_VALID_HOURS) * 3600_000)
  const signed = await signCommand(
    {
      v: 1,
      type: RESET_TYPE,
      licenseId: input.licenseId,
      deviceId: input.deviceId,
      nonce,
      issuedAt: issuedAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
      kdf: { alg: 'pbkdf2-sha256', iter: PBKDF2_ITERATIONS, salt: bytesToBase64(salt) },
      verifier: bytesToBase64(verifier)
    },
    input.key.seed
  )
  if (!(await verifyCommandCode(signed.code, input.key.publicKey))) throw new Error('Signature self-check failed. Reload the signing key.')
  return { code: signed.code, password, nonce, issuedAt, expiresAt }
}

/** "<nonce>:received|used" reported by the computer → readable status for the Super Admin. */
export function resetProgress(resetState: string, nonce: string | null): 'none' | 'waiting' | 'received' | 'used' {
  if (!nonce) return 'none'
  if (resetState === `${nonce}:used`) return 'used'
  if (resetState === `${nonce}:received`) return 'received'
  return 'waiting'
}
