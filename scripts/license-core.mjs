/** Shared license helpers (CLI + tests). Format matches src/main/license/verify.ts and the admin panel. */
import { createPrivateKey, generateKeyPairSync, randomBytes, sign } from 'crypto'

export const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
export const b64urlDecode = (s) => Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64')

export function generateKeyPair() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  return {
    privatePem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicPem: publicKey.export({ type: 'spki', format: 'pem' }).toString()
  }
}

export function newLicenseId() {
  return 'LIC-' + randomBytes(6).toString('hex').toUpperCase()
}

export function buildPayload(o) {
  if (!o.deviceId) throw new Error('deviceId is required')
  if (!o.businessName) throw new Error('businessName is required')
  return {
    v: 1,
    licenseId: o.licenseId || newLicenseId(),
    customerName: o.customerName || o.businessName,
    businessName: o.businessName,
    phone: o.phone || '',
    email: o.email || '',
    deviceId: o.deviceId,
    plan: o.plan || 'professional',
    maxFirms: Number(o.maxFirms ?? 5),
    maxUsers: Number(o.maxUsers ?? 10),
    features: o.features || ['multi_firm', 'projects', 'advanced_reports'],
    issuedAt: o.issuedAt || new Date().toISOString(),
    expiresAt: o.expiresAt ?? null,
    leaseUntil: null,
    graceDays: Number(o.graceDays ?? 15),
    checkinDays: Number(o.checkinDays ?? 0)
  }
}

export function signPayload(payloadObject, privatePem) {
  const payload = b64url(Buffer.from(JSON.stringify(payloadObject), 'utf8'))
  const signature = b64url(sign(null, Buffer.from(payload, 'utf8'), createPrivateKey(privatePem)))
  return { format: 'dtsp-license', version: 1, payload, signature }
}

export const certificateToCode = (cert) => `${cert.payload}.${cert.signature}`

/** Desktop "request code": base64url(JSON {k, d, n, a, o, t}) */
export function decodeRequestCode(code) {
  const obj = JSON.parse(b64urlDecode(String(code).trim()).toString('utf8'))
  if (!obj.d) throw new Error('Invalid request code (no device id).')
  return { licenseKey: obj.k, deviceId: obj.d, deviceName: obj.n, appVersion: obj.a, os: obj.o, time: obj.t }
}
