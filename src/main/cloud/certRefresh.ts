/**
 * Certificate refresh: licenseStatus/{licenseId}.certs[deviceId] carries a re-signed certificate after a renewal,
 * plan / limit change or lifetime detachment. It is installed only when it
 *  - parses and verifies with the built-in public key,
 *  - is issued for THIS device and the SAME license id,
 *  - differs from the installed certificate and is not older than it (no roll-back to a stale certificate).
 */
import type { LicenseCertificate, LicensePayload } from '../license/types'
import { parseCertificate, verifyCertificate } from '../license/verify'

export type CertUpdateDecision =
  | { install: true; cert: LicenseCertificate; payload: LicensePayload; summary: string }
  | { install: false; reason: 'none' | 'same' | 'invalid' | 'other_device' | 'other_license' | 'older'; message: string }

export function decideCertUpdate(input: {
  code: unknown
  publicKeyPem: string
  deviceId: string
  current: { cert: LicenseCertificate | null; payload: LicensePayload | null }
}): CertUpdateDecision {
  const { code, publicKeyPem, deviceId, current } = input
  if (typeof code !== 'string' || !code.trim()) return { install: false, reason: 'none', message: 'No updated certificate is published for this computer.' }
  if (!current.payload || !current.cert) return { install: false, reason: 'none', message: 'No license is installed on this computer.' }
  let cert: LicenseCertificate
  try {
    cert = parseCertificate(code)
  } catch {
    return { install: false, reason: 'invalid', message: 'The published certificate could not be read.' }
  }
  if (cert.payload === current.cert.payload && cert.signature === current.cert.signature) {
    return { install: false, reason: 'same', message: 'The installed certificate is up to date.' }
  }
  const r = verifyCertificate(cert, publicKeyPem, deviceId)
  if (!r.ok) {
    const otherDevice = /different computer/i.test(r.reason)
    return { install: false, reason: otherDevice ? 'other_device' : 'invalid', message: r.reason }
  }
  if (r.payload.licenseId !== current.payload.licenseId) {
    return { install: false, reason: 'other_license', message: 'The published certificate belongs to a different license.' }
  }
  const newIssued = Date.parse(r.payload.issuedAt) || 0
  const oldIssued = Date.parse(current.payload.issuedAt) || 0
  if (newIssued < oldIssued) return { install: false, reason: 'older', message: 'The published certificate is older than the installed one.' }
  return { install: true, cert, payload: r.payload, summary: describeChange(current.payload, r.payload) }
}

/** Human readable summary of what changed (shown in License & About and the log). */
export function describeChange(a: LicensePayload, b: LicensePayload): string {
  const out: string[] = []
  const exp = (p: LicensePayload): string => (p.expiresAt ? p.expiresAt.slice(0, 10) : 'lifetime')
  if (exp(a) !== exp(b)) out.push(`expiry ${exp(a)} → ${exp(b)}`)
  if (a.plan !== b.plan) out.push(`plan ${a.plan} → ${b.plan}`)
  if ((a.planType ?? '') !== (b.planType ?? '') && b.planType) out.push(`billing ${a.planType || '—'} → ${b.planType}`)
  if (a.maxFirms !== b.maxFirms) out.push(`firms ${a.maxFirms} → ${b.maxFirms}`)
  if (a.maxUsers !== b.maxUsers) out.push(`users ${a.maxUsers} → ${b.maxUsers}`)
  if (!!a.detached !== !!b.detached) out.push(b.detached ? 'detached lifetime license' : 'reconnected to Digital Target')
  if (!!a.poweredBy !== !!b.poweredBy) out.push(`“Powered by” ${b.poweredBy ? 'on' : 'off'}`)
  return out.length ? out.join(', ') : 'certificate re-issued'
}

/** A lifetime license detached from central management (no online check-ins). */
export function isDetached(p: LicensePayload | null | undefined): boolean {
  return !!p && p.detached === true && !p.expiresAt
}
