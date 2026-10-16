import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
// @ts-expect-error — plain ESM helper without types
import { buildPayload, certificateToCode, generateKeyPair, signPayload } from '../scripts/license-core.mjs'
import { blockReasonOf, evaluate, parseCertificate, verifyCertificate } from '../src/main/license/verify'
import { FRESH_MS, LicenseService, RETRY_AFTER_FAILURE_MS, computeDeviceId, remoteDecision } from '../src/main/license/service'
import { encodeFields } from '../src/main/cloud/firestore'
import type { RemoteRecord } from '../src/main/license/types'

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
  const base = { now, certError: null, lastSeenAt: now, remoteStatus: null }
  const p = (o: Record<string, unknown> = {}) => buildPayload({ deviceId: 'D-1234567890', businessName: 'B', issuedAt: new Date(now - 10 * DAY).toISOString(), ...o })
  it('no local trial: without a certificate the app is not activated (read-only), also for old trial state', () => {
    const fresh = evaluate({ ...base, payload: null })
    expect(fresh.mode).toBe('not_activated')
    expect(fresh.message).toMatch(/not activated/i)
    // An old state file with a trial start (even a recent one) never yields a trial.
    const legacy = evaluate({ ...base, payload: null, trialStartedAt: now - DAY, legacyTrial: true })
    expect(legacy.mode).toBe('not_activated')
    expect(legacy.message).toMatch(/Activate your license/)
    expect(blockReasonOf('not_activated')).toBe('activation')
    expect(evaluate({ ...base, payload: null, certError: 'License signature is invalid.' }).mode).toBe('invalid')
  })
  it('a Super Admin trial license shows the days left from the certificate', () => {
    const t = evaluate({ ...base, payload: p({ plan: 'trial', expiresAt: new Date(now + 15 * DAY).toISOString() }) })
    expect(t.mode).toBe('trial')
    expect(t.trialDaysLeft).toBe(15)
    expect(t.message).toContain('Trial — 15 day(s) left')
    expect(evaluate({ ...base, payload: p({ plan: 'trial', expiresAt: new Date(now - DAY).toISOString() }) }).mode).toBe('trial_expired')
  })
  it('active, expired, suspended, revoked, device deactivated, clock error', () => {
    expect(evaluate({ ...base, payload: p() }).mode).toBe('active')
    expect(evaluate({ ...base, payload: p({ expiresAt: new Date(now - DAY).toISOString() }) }).mode).toBe('expired')
    expect(evaluate({ ...base, payload: p(), remoteStatus: 'suspended' }).mode).toBe('suspended')
    expect(evaluate({ ...base, payload: p(), remoteStatus: 'revoked' }).mode).toBe('revoked')
    const dev = evaluate({ ...base, payload: p(), remoteStatus: 'deactivated' })
    expect(dev.mode).toBe('device_deactivated')
    expect(dev.message).toMatch(/This computer has been deactivated/)
    expect(blockReasonOf('device_deactivated')).toBe('device')
    expect(blockReasonOf('suspended')).toBe('license')
    expect(blockReasonOf('lease_expired')).toBe('connectivity')
    expect(evaluate({ ...base, payload: p(), lastSeenAt: now + 3 * DAY }).mode).toBe('clock_error')
  })
  it('check-in interval with grace period', () => {
    expect(evaluate({ ...base, payload: p({ checkinDays: 30 }) }).mode).toBe('active')
    expect(evaluate({ ...base, payload: p({ checkinDays: 5, graceDays: 15 }) }).mode).toBe('grace')
    expect(evaluate({ ...base, payload: p({ checkinDays: 5, graceDays: 2 }) }).mode).toBe('lease_expired')
    expect(evaluate({ ...base, payload: p({ checkinDays: 5, graceDays: 2 }), lastCheckAt: now - DAY }).mode).toBe('active')
    expect(evaluate({ ...base, payload: p({ checkinDays: 0 }) }).mode).toBe('active')
  })
  it('remote decision from licenseStatus', () => {
    expect(remoteDecision({ status: 'active' }, 'DEV')).toBeNull()
    expect(remoteDecision({ status: 'suspended' }, 'DEV')).toBe('suspended')
    expect(remoteDecision({ status: 'revoked', deactivatedDevices: ['DEV'] }, 'DEV')).toBe('revoked')
    expect(remoteDecision({ status: 'active', deactivatedDevices: ['OTHER', 'DEV'] }, 'DEV')).toBe('deactivated')
  })
})

/* ------------------------------------------------ LicenseService with injected fetch + clock ------------------------------------------------ */

const MACHINE = 'test-machine-0001'
const DEVICE = computeDeviceId(MACHINE)
const LIC = 'LICTEST000000000001'

interface Harness {
  lic: LicenseService
  dir: string
  clock: { t: number }
  remote: { status: string; deactivatedDevices: string[]; certs?: Record<string, string> } | null
  calls: { get: number; commit: number }
  net: { mode: 'ok' | 'down' | 'hang' }
  db: { rec: RemoteRecord | null }
  certAt: (issuedAt: number, o?: Record<string, unknown>) => string
  make: () => LicenseService
}

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function harness(): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'lic-test-'))
  dirs.push(dir)
  const clock = { t: Date.parse('2026-10-16T08:00:00Z') }
  const h = {
    dir,
    clock,
    remote: { status: 'active', deactivatedDevices: [] as string[] } as Harness['remote'],
    calls: { get: 0, commit: 0 },
    net: { mode: 'ok' as 'ok' | 'down' | 'hang' },
    db: { rec: null as RemoteRecord | null }
  } as Harness
  const fetchImpl = async (url: string, init?: { method?: string; signal?: AbortSignal }) => {
    if (h.net.mode === 'down') throw new TypeError('fetch failed')
    if (h.net.mode === 'hang') {
      return new Promise<never>((_r, rej) => init?.signal?.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' }))))
    }
    if (init?.method === 'POST') {
      h.calls.commit++
      return { status: 200, json: async () => ({ commitTime: new Date(clock.t).toISOString() }) }
    }
    h.calls.get++
    const path = decodeURIComponent(new URL(url).pathname.split('/documents/')[1] ?? '')
    if (path === `licenseStatus/${LIC}` && h.remote) {
      return { status: 200, json: async () => ({ name: `projects/p/databases/(default)/documents/${path}`, fields: encodeFields(h.remote as Record<string, unknown>) }) }
    }
    return { status: 404, json: async () => ({ error: { status: 'NOT_FOUND' } }) }
  }
  h.certAt = (issuedAt: number, o: Record<string, unknown> = {}) =>
    certificateToCode(signPayload(buildPayload({ deviceId: DEVICE, businessName: 'WETCO', licenseId: LIC, issuedAt: new Date(issuedAt).toISOString(), expiresAt: new Date(issuedAt + 300 * DAY).toISOString(), checkinDays: 7, graceDays: 3, ...o }), keys.privatePem))
  h.make = () =>
    new LicenseService({
      dir,
      publicKeyPem: keys.publicPem,
      firestore: { projectId: 'p', apiKey: 'k' },
      appVersion: '1.2.0',
      machineId: MACHINE,
      now: () => clock.t,
      env: {},
      rest: { fetchImpl: fetchImpl as never, timeoutMs: 10_000 },
      getDbRemote: () => h.db.rec,
      setDbRemote: (r) => {
        h.db.rec = r
      },
      log: () => undefined
    })
  h.lic = h.make()
  return h
}

describe('license service: activation state', () => {
  it('fresh install is not activated and writes are blocked; a certificate activates it', () => {
    const h = harness()
    const st = h.lic.status(true)
    expect(st.mode).toBe('not_activated')
    expect(st.canWrite).toBe(false)
    expect(st.legacyTrial).toBe(false)
    h.lic.install(h.certAt(h.clock.t - DAY))
    expect(h.lic.status(true)).toMatchObject({ mode: 'active', canWrite: true, blockReason: null })
  })
  it('an old state file from the former local trial stays readable but is not activated', () => {
    const h = harness()
    writeFileSync(join(h.dir, 'state.json'), JSON.stringify({ trialStartedAt: h.clock.t - DAY, lastSeenAt: h.clock.t - DAY, remoteStatus: null }))
    const st = h.make().status(true)
    expect(st.mode).toBe('not_activated')
    expect(st.legacyTrial).toBe(true)
    expect(st.message).toMatch(/Activate your license/)
  })
})

describe('license service: write gating', () => {
  it('checks before a write when the last verification is older than 5 minutes, caches 5 minutes, coalesces', async () => {
    const h = harness()
    h.lic.install(h.certAt(h.clock.t - DAY))
    expect((await h.lic.ensureFresh()).canWrite).toBe(true)
    expect(h.calls.get).toBe(1)
    h.clock.t += 60_000
    await h.lic.ensureFresh()
    expect(h.calls.get).toBe(1) // fresh for 5 minutes
    h.clock.t += FRESH_MS
    await Promise.all([h.lic.ensureFresh(), h.lic.ensureFresh(), h.lic.ensureFresh(), h.lic.checkIn(true)])
    expect(h.calls.get).toBe(2) // concurrent checks share one request
  })
  it('suspension and device deactivation block the next write with distinct messages', async () => {
    const h = harness()
    h.lic.install(h.certAt(h.clock.t - DAY))
    await h.lic.ensureFresh()
    h.remote!.status = 'suspended'
    h.clock.t += FRESH_MS + 1000
    const s1 = await h.lic.ensureFresh()
    expect(s1).toMatchObject({ mode: 'suspended', canWrite: false, blockReason: 'license' })
    h.remote!.status = 'active'
    h.remote!.deactivatedDevices = [DEVICE]
    h.clock.t += FRESH_MS + 1000
    const s2 = await h.lic.ensureFresh()
    expect(s2).toMatchObject({ mode: 'device_deactivated', canWrite: false, blockReason: 'device' })
    expect(s2.message).not.toBe(s1.message)
    h.remote!.deactivatedDevices = []
    h.clock.t += FRESH_MS + 1000
    expect((await h.lic.ensureFresh()).mode).toBe('active') // re-approved online
  })
  it('network failure never clears a stored suspension; offline policy applies; failures are not retried on every write', async () => {
    const h = harness()
    h.lic.install(h.certAt(h.clock.t - DAY))
    h.remote!.status = 'suspended'
    await h.lic.ensureFresh()
    h.net.mode = 'down'
    h.clock.t += FRESH_MS + 1000
    const st = await h.lic.ensureFresh()
    expect(st.mode).toBe('suspended')
    expect(st.lastCheckError).toMatch(/internet/i)
    const before = h.calls.get
    h.clock.t += 1000
    await h.lic.ensureFresh()
    expect(h.calls.get).toBe(before) // within RETRY_AFTER_FAILURE_MS: no new request
    expect(RETRY_AFTER_FAILURE_MS).toBeGreaterThan(0)
  })
  it('offline: the signed check-in deadline + grace decides; a hanging network delays a write by at most the wait limit', async () => {
    const h = harness()
    h.lic.install(h.certAt(h.clock.t - DAY))
    await h.lic.ensureFresh()
    h.net.mode = 'hang'
    h.clock.t += 8 * DAY // checkinDays 7 → grace (3 days)
    const t0 = Date.now()
    const st = await h.lic.ensureFresh(150)
    expect(Date.now() - t0).toBeLessThan(2000)
    expect(st.mode).toBe('grace')
    expect(st.canWrite).toBe(true)
    h.clock.t += 3 * DAY
    expect(h.lic.status(true)).toMatchObject({ mode: 'lease_expired', blockReason: 'connectivity', canWrite: false })
  })
})

describe('license service: persisted remote decision', () => {
  it('deleting the state file does not lift a suspension (business DB copy), and vice versa', async () => {
    const h = harness()
    h.lic.install(h.certAt(h.clock.t - DAY))
    h.remote!.status = 'revoked'
    await h.lic.checkIn(true)
    expect(h.db.rec).toMatchObject({ licenseId: LIC, status: 'revoked' })
    unlinkSync(join(h.dir, 'state.json'))
    expect(h.make().status(true).mode).toBe('revoked')
    // The other way round: DB copy lost, state file still blocks.
    await h.lic.checkIn(true)
    h.db.rec = null
    expect(h.make().status(true).mode).toBe('revoked')
  })
  it('re-installing an older certificate (also after deactivate) cannot lift a block; a newer one issued after re-approval can', async () => {
    const h = harness()
    const old = h.certAt(h.clock.t - DAY)
    h.lic.install(old)
    h.remote!.status = 'suspended'
    await h.lic.checkIn(true)
    expect(() => h.lic.install(old)).toThrow(/suspended/)
    await h.lic.deactivate()
    expect(h.lic.status(true).mode).toBe('not_activated')
    expect(() => h.lic.install(old)).toThrow(/cannot restore access/)
    h.clock.t += 60_000
    h.lic.install(h.certAt(h.clock.t))
    expect(h.lic.status(true).mode).toBe('active')
    expect(h.db.rec).toBeNull()
  })
  it('never installs certs[deviceId] from a suspended licenseStatus or one that deactivates this device', async () => {
    const h = harness()
    h.lic.install(h.certAt(h.clock.t - 2 * DAY))
    const issuedBefore = h.lic.status(true).payload!.issuedAt
    h.remote = { status: 'suspended', deactivatedDevices: [], certs: { [DEVICE]: h.certAt(h.clock.t, { maxUsers: 99 }) } }
    await h.lic.checkIn(true)
    expect(h.lic.status(true).payload!.issuedAt).toBe(issuedBefore)
    h.remote = { status: 'active', deactivatedDevices: [DEVICE], certs: { [DEVICE]: h.certAt(h.clock.t, { maxUsers: 99 }) } }
    await h.lic.checkIn(true)
    expect(h.lic.status(true).payload!.maxUsers).not.toBe(99)
    expect((await h.lic.fetchPublishedCertificate()).installed).toBe(false)
    h.remote = { status: 'active', deactivatedDevices: [], certs: { [DEVICE]: h.certAt(h.clock.t, { maxUsers: 99 }) } }
    await h.lic.checkIn(true)
    expect(h.lic.status(true)).toMatchObject({ mode: 'active' })
    expect(h.lic.status(true).payload!.maxUsers).toBe(99)
  })
})
