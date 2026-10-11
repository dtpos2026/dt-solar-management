import { describe, expect, it } from 'vitest'
// @ts-expect-error — plain ESM helper without types
import { buildPayload, certificateToCode, generateKeyPair, signPayload } from '../scripts/license-core.mjs'
import { evaluate, parseCertificate, verifyCertificate } from '../src/main/license/verify'

const DAY = 86400000
const keys = generateKeyPair()

describe('license certificates', () => {
  const payload = buildPayload({ deviceId: 'ABCD-1234-EF56-7890-AAAA-BBBB', businessName: 'WETCO SOLAR SOLUTIONS' })
  const cert = signPayload(payload, keys.privatePem)

  it('verifies a valid certificate and its compact code', () => {
    expect(verifyCertificate(cert, keys.publicPem, payload.deviceId).ok).toBe(true)
    expect(verifyCertificate(parseCertificate(certificateToCode(cert)), keys.publicPem, payload.deviceId).ok).toBe(true)
    expect(verifyCertificate(parseCertificate(JSON.stringify(cert)), keys.publicPem, payload.deviceId).ok).toBe(true)
  })
  it('rejects tampering, wrong device and wrong key', () => {
    const tampered = { ...cert, payload: cert.payload.slice(0, -2) + 'AA' }
    expect(verifyCertificate(tampered, keys.publicPem, payload.deviceId).ok).toBe(false)
    expect(verifyCertificate(cert, keys.publicPem, 'OTHER-DEVICE').ok).toBe(false)
    expect(verifyCertificate(cert, generateKeyPair().publicPem, payload.deviceId).ok).toBe(false)
  })
})

describe('license evaluation', () => {
  const now = Date.parse('2026-10-11T12:00:00Z')
  const base = { now, certError: null, trialStartedAt: now, lastSeenAt: now, remoteStatus: null }
  const p = (o: Record<string, unknown> = {}) => buildPayload({ deviceId: 'D-1234567890', businessName: 'B', issuedAt: new Date(now - 10 * DAY).toISOString(), ...o })
  it('trial and trial expiry', () => {
    expect(evaluate({ ...base, payload: null }).mode).toBe('trial')
    expect(evaluate({ ...base, payload: null, trialStartedAt: now - 20 * DAY }).mode).toBe('trial_expired')
  })
  it('active, expired, suspended, revoked, clock error', () => {
    expect(evaluate({ ...base, payload: p() }).mode).toBe('active')
    expect(evaluate({ ...base, payload: p({ expiresAt: new Date(now - DAY).toISOString() }) }).mode).toBe('expired')
    expect(evaluate({ ...base, payload: p(), remoteStatus: 'suspended' }).mode).toBe('suspended')
    expect(evaluate({ ...base, payload: p(), remoteStatus: 'revoked' }).mode).toBe('revoked')
    expect(evaluate({ ...base, payload: p(), lastSeenAt: now + 3 * DAY }).mode).toBe('clock_error')
  })
  it('check-in interval with grace period', () => {
    expect(evaluate({ ...base, payload: p({ checkinDays: 30 }) }).mode).toBe('active')
    expect(evaluate({ ...base, payload: p({ checkinDays: 5, graceDays: 15 }) }).mode).toBe('grace')
    expect(evaluate({ ...base, payload: p({ checkinDays: 5, graceDays: 2 }) }).mode).toBe('lease_expired')
    expect(evaluate({ ...base, payload: p({ checkinDays: 5, graceDays: 2 }), lastCheckAt: now - DAY }).mode).toBe('active')
    expect(evaluate({ ...base, payload: p({ checkinDays: 0 }) }).mode).toBe('active')
  })
})
