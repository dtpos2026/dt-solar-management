/**
 * Ed25519 signing helpers for DT Solar Pro license certificates.
 *
 * Everything here runs in the admin's browser. The private key is NEVER sent anywhere.
 * Output is byte-compatible with the desktop verifier (src/main/license/verify.ts):
 *   payload   = base64url(UTF-8 JSON.stringify(payloadObject))
 *   signature = base64url(Ed25519(UTF-8 bytes of the payload STRING))
 *   code      = payload + '.' + signature
 */
import * as ed from '@noble/ed25519'

/* ----------------------------------------- base64 / base64url ----------------------------------------- */

export function bytesToBase64(bytes: Uint8Array): string {
  let bin = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(bin)
}

export function base64ToBytes(b64: string): Uint8Array {
  const clean = b64.replace(/\s+/g, '')
  const bin = atob(clean)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

export function bytesToBase64Url(bytes: Uint8Array): string {
  return bytesToBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function base64UrlToBytes(s: string): Uint8Array {
  let b64 = s.replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/')
  while (b64.length % 4 !== 0) b64 += '='
  return base64ToBytes(b64)
}

export function utf8ToBase64Url(text: string): string {
  return bytesToBase64Url(new TextEncoder().encode(text))
}

export function base64UrlToUtf8(s: string): string {
  return new TextDecoder().decode(base64UrlToBytes(s))
}

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.replace(/[^0-9a-f]/gi, '')
  if (clean.length % 2 !== 0) throw new Error('Invalid hex string.')
  const out = new Uint8Array(clean.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16)
  return out
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const len = parts.reduce((n, p) => n + p.length, 0)
  const out = new Uint8Array(len)
  let off = 0
  for (const p of parts) {
    out.set(p, off)
    off += p.length
  }
  return out
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

/* --------------------------------------------- PEM / DER --------------------------------------------- */

/** DER prefix of an Ed25519 PKCS#8 private key (RFC 8410), followed by the 32-byte seed. */
export const PKCS8_ED25519_PREFIX = hexToBytes('302e020100300506032b657004220420')
/** DER prefix of an Ed25519 SubjectPublicKeyInfo, followed by the 32-byte public key. */
export const SPKI_ED25519_PREFIX = hexToBytes('302a300506032b6570032100')

function pemBody(pem: string, label: string): Uint8Array | null {
  const re = new RegExp(`-----BEGIN ${label}-----([\\s\\S]*?)-----END ${label}-----`)
  const m = pem.match(re)
  if (!m) return null
  return base64ToBytes(m[1])
}

function wrapPem(der: Uint8Array, label: string): string {
  const b64 = bytesToBase64(der)
  const lines = b64.match(/.{1,64}/g) ?? []
  return `-----BEGIN ${label}-----\n${lines.join('\n')}\n-----END ${label}-----\n`
}

/**
 * Extracts the 32-byte Ed25519 seed from a PKCS#8 PEM ("BEGIN PRIVATE KEY").
 * Also accepts raw base64 of the DER, or a 64-char hex seed, for convenience.
 */
export function parsePrivateKeyPem(text: string): Uint8Array {
  const input = (text ?? '').trim()
  if (!input) throw new Error('The key is empty. Choose keys/license-private.pem or paste its contents.')
  if (/BEGIN (ENCRYPTED PRIVATE KEY|OPENSSH PRIVATE KEY|EC PRIVATE KEY|RSA PRIVATE KEY)/.test(input)) {
    throw new Error('Unsupported key type. Use the unencrypted Ed25519 PKCS#8 key created automatically by "npm run build" in the DT Solar Pro folder.')
  }
  if (input.includes('BEGIN PUBLIC KEY')) {
    throw new Error('This is the PUBLIC key. Load keys/license-private.pem (the private key) instead.')
  }
  let der: Uint8Array | null = pemBody(input, 'PRIVATE KEY')
  if (!der) {
    if (/^[0-9a-f]{64}$/i.test(input)) return hexToBytes(input)
    try {
      der = base64ToBytes(input)
    } catch {
      throw new Error('Not a PEM private key. Expected "-----BEGIN PRIVATE KEY-----".')
    }
  }
  if (der.length !== 48 || !equalBytes(der.subarray(0, 16), PKCS8_ED25519_PREFIX)) {
    throw new Error('This is not an Ed25519 PKCS#8 private key. Use keys/license-private.pem created automatically by "npm run build" in the DT Solar Pro folder.')
  }
  return der.slice(16)
}

export function publicKeyToSpkiPem(pub: Uint8Array): string {
  return wrapPem(concatBytes(SPKI_ED25519_PREFIX, pub), 'PUBLIC KEY')
}

export function seedToPkcs8Pem(seed: Uint8Array): string {
  return wrapPem(concatBytes(PKCS8_ED25519_PREFIX, seed), 'PRIVATE KEY')
}

/** Extracts the raw 32-byte public key from an SPKI PEM ("BEGIN PUBLIC KEY"). */
export function parsePublicKeyPem(text: string): Uint8Array {
  const der = pemBody(text.trim(), 'PUBLIC KEY')
  if (!der || der.length !== 44 || !equalBytes(der.subarray(0, 12), SPKI_ED25519_PREFIX)) {
    throw new Error('Not an Ed25519 public key PEM.')
  }
  return der.slice(12)
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as unknown as ArrayBuffer)
  return bytesToHex(new Uint8Array(digest))
}

/** Fingerprint = SHA-256 of the SPKI DER of the public key, shown as colon-separated hex pairs. */
export async function publicKeyFingerprint(pub: Uint8Array): Promise<string> {
  const hex = await sha256Hex(concatBytes(SPKI_ED25519_PREFIX, pub))
  return hex.toUpperCase().match(/.{2}/g)!.join(':')
}

export interface LoadedKey {
  seed: Uint8Array
  publicKey: Uint8Array
  publicPem: string
  fingerprint: string
}

export async function loadKey(text: string): Promise<LoadedKey> {
  const seed = parsePrivateKeyPem(text)
  const publicKey = await ed.getPublicKeyAsync(seed)
  return { seed, publicKey, publicPem: publicKeyToSpkiPem(publicKey), fingerprint: await publicKeyFingerprint(publicKey) }
}

/* ------------------------------------------- certificates ------------------------------------------- */

export interface LicensePayload {
  v: 1
  licenseId: string
  customerName: string
  businessName: string
  phone: string
  email: string
  deviceId: string
  plan: string
  maxFirms: number
  maxUsers: number
  features: string[]
  issuedAt: string
  expiresAt: string | null
  leaseUntil: null
  graceDays: number
  checkinDays: number
  /** v1.1 (src/main/license/types.ts) - optional so older certificates stay valid. */
  planType?: string
  clientId?: string
  maxDevices?: number
  /** "Powered by Digital Target" on customer documents. */
  poweredBy?: boolean
  /** Lifetime license detached from central management (only with expiresAt null and checkinDays 0). */
  detached?: boolean
}

export interface SignedCertificate {
  payload: string
  signature: string
  /** Compact activation code: payload.signature */
  code: string
  /** Contents of a .dtlic file */
  fileContents: string
}

export async function signPayload(payloadObject: LicensePayload, seed: Uint8Array): Promise<SignedCertificate> {
  const payload = utf8ToBase64Url(JSON.stringify(payloadObject))
  const sig = await ed.signAsync(new TextEncoder().encode(payload), seed)
  const signature = bytesToBase64Url(sig)
  return {
    payload,
    signature,
    code: `${payload}.${signature}`,
    fileContents: JSON.stringify({ format: 'dtsp-license', version: 1, payload, signature }, null, 2)
  }
}

/**
 * Commands to a computer (e.g. Administrator password reset) use the same key but sign `COMMAND_DOMAIN + payload`, so a command
 * can never be installed as a license certificate and a certificate can never be replayed as a command.
 * Matches src/main/license/verify.ts (desktop).
 */
export const COMMAND_DOMAIN = 'dtsp-cmd-v1.'

export async function signCommand(payloadObject: Record<string, unknown>, seed: Uint8Array): Promise<{ payload: string; signature: string; code: string }> {
  const payload = utf8ToBase64Url(JSON.stringify(payloadObject))
  const sig = await ed.signAsync(new TextEncoder().encode(COMMAND_DOMAIN + payload), seed)
  const signature = bytesToBase64Url(sig)
  return { payload, signature, code: `${payload}.${signature}` }
}

export async function verifyCommandCode(code: string, publicKey: Uint8Array): Promise<boolean> {
  const [payload, signature] = code.split('.')
  if (!payload || !signature) return false
  try {
    return await ed.verifyAsync(base64UrlToBytes(signature), new TextEncoder().encode(COMMAND_DOMAIN + payload), publicKey)
  } catch {
    return false
  }
}

/** Self-check: verifies a signature against a public key (used after signing, to be safe). */
export async function verifyCode(code: string, publicKey: Uint8Array): Promise<boolean> {
  const [payload, signature] = code.split('.')
  if (!payload || !signature) return false
  try {
    return await ed.verifyAsync(base64UrlToBytes(signature), new TextEncoder().encode(payload), publicKey)
  } catch {
    return false
  }
}

/* --------------------------------------- offline request codes --------------------------------------- */

export interface OfflineRequest {
  k: string
  d: string
  n?: string
  a?: string
  o?: string
  t?: string
}

/** Decodes the desktop's offline request code = base64url(JSON {k, d, n, a, o, t}). */
export function decodeOfflineRequest(code: string): OfflineRequest {
  const clean = (code ?? '').replace(/\s+/g, '')
  if (!clean) throw new Error('Paste the request code shown in the customer\'s DT Solar Pro.')
  let obj: unknown
  try {
    obj = JSON.parse(base64UrlToUtf8(clean))
  } catch {
    throw new Error('This request code could not be read. Ask the customer to copy the whole code again.')
  }
  const r = obj as Partial<OfflineRequest>
  if (!r || typeof r.k !== 'string' || typeof r.d !== 'string' || !r.k || !r.d) {
    throw new Error('The request code is missing the license key or the device id.')
  }
  return {
    k: r.k.trim().toUpperCase(),
    d: r.d.trim(),
    n: typeof r.n === 'string' ? r.n : '',
    a: typeof r.a === 'string' ? r.a : '',
    o: typeof r.o === 'string' ? r.o : '',
    t: typeof r.t === 'string' ? r.t : ''
  }
}

/* --------------------------------------------- license keys --------------------------------------------- */

const KEY_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

/** DTSP-XXXX-XXXX-XXXX-XXXX using crypto.getRandomValues (32-char alphabet, so no modulo bias). */
export function generateLicenseKey(): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  const chars = Array.from(bytes, (b) => KEY_ALPHABET[b % KEY_ALPHABET.length])
  const groups = [0, 1, 2, 3].map((g) => chars.slice(g * 4, g * 4 + 4).join(''))
  return `DTSP-${groups.join('-')}`
}

export function normaliseLicenseKey(key: string): string {
  return (key ?? '').trim().toUpperCase().replace(/\s+/g, '')
}

export const LICENSE_KEY_RE = /^DTSP(-[A-Z0-9]{4}){4}$/
