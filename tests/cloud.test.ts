import { describe, expect, it } from 'vitest'
// @ts-expect-error — plain ESM helper without types
import { buildPayload, certificateToCode, generateKeyPair, signPayload } from '../scripts/license-core.mjs'
import { decodeFields, double, encodeFields, encodeValue, FirestoreError, resolveFirestoreConfig } from '../src/main/cloud/firestore'
import { buildHeartbeat, heartbeatWrite } from '../src/main/cloud/heartbeat'
import { buildLocation, normalizeMode, parseDeviceLocationOutput, parseGeoIp, parseManualLocation, readDeviceLocation } from '../src/main/cloud/location'
import { CloudService } from '../src/main/cloud/service'
import { setSetting } from '../src/main/services/context'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { decideCertUpdate, isDetached } from '../src/main/cloud/certRefresh'
import { maskToken, randomToken, TOKEN_RE } from '../src/main/cloud/install'
import * as support from '../src/main/cloud/support'
import { evaluate } from '../src/main/license/verify'
import { freshDb } from './helpers'

describe('firestore REST values', () => {
  it('encodes typed values', () => {
    expect(encodeValue('a')).toEqual({ stringValue: 'a' })
    expect(encodeValue(5)).toEqual({ integerValue: '5' })
    expect(encodeValue(1.5)).toEqual({ doubleValue: 1.5 })
    expect(encodeValue(double(2))).toEqual({ doubleValue: 2 })
    expect(encodeValue(true)).toEqual({ booleanValue: true })
    expect(encodeValue(null)).toEqual({ nullValue: null })
    expect(encodeValue({ x: 1 })).toEqual({ mapValue: { fields: { x: { integerValue: '1' } } } })
    expect(encodeValue([1, 'b'])).toEqual({ arrayValue: { values: [{ integerValue: '1' }, { stringValue: 'b' }] } })
    expect(() => encodeValue(NaN)).toThrow()
    expect(encodeFields({ a: undefined, b: 1 })).toEqual({ b: { integerValue: '1' } })
  })
  it('round-trips through decode', () => {
    const obj = { s: 'x', n: 7, d: 1.25, b: false, z: null, m: { k: [1, 2] } }
    expect(decodeFields(encodeFields(obj))).toEqual(obj)
    expect(decodeFields({ t: { timestampValue: '2026-01-01T00:00:00Z' } })).toEqual({ t: '2026-01-01T00:00:00Z' })
  })
  it('emulator base URL override; production by default', () => {
    const base = { projectId: 'p1', apiKey: 'k' }
    expect(resolveFirestoreConfig(base, {})?.baseUrl).toBe('https://firestore.googleapis.com/v1/projects/p1/databases/(default)/documents')
    const emu = resolveFirestoreConfig(base, { DTSP_FIRESTORE_EMULATOR: '127.0.0.1:8093' })
    expect(emu?.baseUrl).toBe('http://127.0.0.1:8093/v1/projects/p1/databases/(default)/documents')
    expect(emu?.emulator).toBe(true)
    expect(resolveFirestoreConfig(base, { DTSP_CLOUD_DISABLED: '1' })).toBeNull()
  })
  it('installation token', () => {
    const t = randomToken()
    expect(TOKEN_RE.test(t)).toBe(true)
    expect(maskToken(t)).not.toContain(t.slice(6, 30))
  })
})

describe('heartbeat payload', () => {
  const base = { deviceId: 'D1', licenseId: '', deviceName: 'PC', os: 'Windows', appVersion: '1.1.0', companyName: 'WETCO', mode: 'trial', lastCheckAt: '', firms: 2, users: 3 }
  it('has no location when sharing is off', () => {
    const p = buildHeartbeat({ ...base, location: buildLocation('off', { manual: '30.1,71.4' }) })
    expect(p.location).toBeUndefined()
    const w = heartbeatWrite('T'.repeat(40), p)
    expect(w.path).toBe(`heartbeats/${'T'.repeat(40)}`)
    expect(w.serverTime).toContain('lastSeen')
    expect(w.mask).toBeUndefined()
  })
  it('manual and approximate shapes', () => {
    const m = buildHeartbeat({ ...base, location: buildLocation('manual', { manual: '30.1979, 71.4697 | Office', manualAt: '2026-10-01T00:00:00Z' }) })
    expect(m.location).toMatchObject({ lat: 30.1979, lng: 71.4697, source: 'manual', label: 'Office', consent: true, updatedAt: '2026-10-01T00:00:00Z' })
    const geo = parseGeoIp({ success: true, latitude: 30.2, longitude: 71.5, city: 'Multan', region: 'Punjab', country: 'Pakistan' })
    expect(geo).not.toBeNull()
    const a = buildHeartbeat({ ...base, location: buildLocation('approximate', { geo }) })
    expect(a.location).toMatchObject({ lat: 30.2, lng: 71.5, source: 'approximate', accuracyKm: 25, consent: true })
    expect(a.location?.label.toLowerCase()).toContain('approximate')
    // No lookup result → no coordinates invented.
    expect(buildLocation('approximate', { geo: null })).toBeNull()
    expect(parseGeoIp({ success: false })).toBeNull()
  })
  it('validates manual input', () => {
    expect(parseManualLocation('30.15,71.52').ok).toBe(true)
    expect(parseManualLocation('').ok).toBe(false)
    expect(parseManualLocation('91,10').ok).toBe(false)
    expect(parseManualLocation('10,181').ok).toBe(false)
    expect(parseManualLocation('0,0').ok).toBe(false)
    expect(parseManualLocation('Multan').ok).toBe(false)
    expect(buildLocation('manual', { manual: 'bad' })).toBeNull()
  })
})

describe('certificate refresh', () => {
  const keys = generateKeyPair()
  const deviceId = 'ABCD-1234-EF56-7890-AAAA-BBBB'
  const cur = buildPayload({ deviceId, businessName: 'B', licenseId: 'LIC-1', issuedAt: '2026-01-01T00:00:00Z', expiresAt: '2026-12-31T00:00:00Z' })
  const curCert = signPayload(cur, keys.privatePem)
  const current = { cert: curCert, payload: cur }
  const code = (o: Record<string, unknown>, priv = keys.privatePem): string =>
    certificateToCode(signPayload({ ...buildPayload({ deviceId, businessName: 'B', licenseId: 'LIC-1', issuedAt: '2026-06-01T00:00:00Z', expiresAt: '2027-12-31T00:00:00Z' }), ...o }, priv))

  it('accepts a valid newer certificate for this device and license', () => {
    const d = decideCertUpdate({ code: code({}), publicKeyPem: keys.publicPem, deviceId, current })
    expect(d.install).toBe(true)
    if (d.install) expect(d.summary).toContain('expiry')
  })
  it('ignores the same certificate and missing ones', () => {
    expect(decideCertUpdate({ code: certificateToCode(curCert), publicKeyPem: keys.publicPem, deviceId, current })).toMatchObject({ install: false, reason: 'same' })
    expect(decideCertUpdate({ code: undefined, publicKeyPem: keys.publicPem, deviceId, current })).toMatchObject({ install: false, reason: 'none' })
  })
  it('rejects other device, other license, bad signature, older', () => {
    expect(decideCertUpdate({ code: code({ deviceId: 'OTHER-DEVICE-0000' }), publicKeyPem: keys.publicPem, deviceId, current }).install).toBe(false)
    expect(decideCertUpdate({ code: code({ licenseId: 'LIC-2' }), publicKeyPem: keys.publicPem, deviceId, current })).toMatchObject({ install: false, reason: 'other_license' })
    expect(decideCertUpdate({ code: code({}, generateKeyPair().privatePem), publicKeyPem: keys.publicPem, deviceId, current })).toMatchObject({ install: false, reason: 'invalid' })
    expect(decideCertUpdate({ code: code({ issuedAt: '2025-01-01T00:00:00Z' }), publicKeyPem: keys.publicPem, deviceId, current })).toMatchObject({ install: false, reason: 'older' })
    expect(decideCertUpdate({ code: 'garbage', publicKeyPem: keys.publicPem, deviceId, current })).toMatchObject({ install: false, reason: 'invalid' })
  })
  it('detached lifetime evaluation ignores remote status and check-ins', () => {
    const now = Date.parse('2026-10-11T12:00:00Z')
    const p = { ...buildPayload({ deviceId, businessName: 'B', issuedAt: '2026-01-01T00:00:00Z', checkinDays: 7 }), expiresAt: null, detached: true }
    expect(isDetached(p)).toBe(true)
    const base = { now, certError: null, trialStartedAt: now, lastSeenAt: now }
    expect(evaluate({ ...base, payload: p, remoteStatus: 'revoked' }).mode).toBe('active')
    expect(evaluate({ ...base, payload: { ...p, detached: false }, remoteStatus: 'revoked' }).mode).toBe('revoked')
    expect(isDetached({ ...p, expiresAt: '2027-01-01T00:00:00Z' })).toBe(false)
  })
})

describe('support queue', () => {
  const thread = { deviceId: 'D1', licenseId: '', companyName: 'WETCO', contactName: 'Owner', phone: '0300' }
  const token = 'A'.repeat(40)
  type Doc = { id: string; path: string; name: string; data: Record<string, unknown>; updateTime?: string }

  function fakeClient(mode: { offline?: boolean; deny?: boolean } = {}) {
    const docs = new Map<string, Doc>()
    let commits = 0
    const fail = (): never => {
      if (mode.offline) throw new FirestoreError('offline', 0, 'UNAVAILABLE', true)
      throw new FirestoreError('denied', 403, 'PERMISSION_DENIED')
    }
    const client = {
      async get(path: string) {
        if (mode.offline) fail()
        return docs.get(path) ?? null
      },
      async commit(writes: Array<{ path: string; fields: Record<string, unknown>; exists?: boolean; mask?: string[] }>) {
        if (mode.offline || mode.deny) fail()
        for (const w of writes) {
          const ex = docs.get(w.path)
          if (w.exists === false && ex) throw new FirestoreError('exists', 409, 'ALREADY_EXISTS')
          if (w.exists === true && !ex) throw new FirestoreError('missing', 404, 'NOT_FOUND')
          docs.set(w.path, { id: w.path.split('/').pop()!, path: w.path, name: w.path, data: { ...(ex?.data ?? {}), ...w.fields, at: '2026-10-15T10:00:00Z' } })
        }
        commits++
        return { commitTime: '2026-10-15T10:00:00Z' }
      },
      async runQuery() {
        return [...docs.values()].filter((d) => d.path.startsWith(`supportThreads/${token}/messages/`))
      }
    }
    return { client, docs, commits: () => commits }
  }
  const deps = (db: ReturnType<typeof freshDb>, client: unknown) => ({ db, client: client as never, token, thread, state: {}, backoff: new Map<string, number>(), force: true })

  it('queued -> sent, dedupe by uid, admin replies come in', async () => {
    const db = freshDb()
    const m = support.queueMessage(db, { body: 'Hello', author: 'Owner', userId: 1 })
    expect(m.status).toBe('queued')
    expect(() => support.queueMessage(db, { body: '   ' })).toThrow()
    const f = fakeClient()
    const r = await support.syncSupport(deps(db, f.client))
    expect(r.sent).toBe(1)
    expect(support.getMessage(db, m.uid)?.status).toBe('sent')
    expect(f.docs.get(`supportThreads/${token}/messages/${m.uid}`)?.data.from).toBe('customer')
    // A second sync does not send it again.
    await support.syncSupport(deps(db, f.client))
    expect(f.commits()).toBe(1)
    // Admin reply is pulled once.
    f.docs.set(`supportThreads/${token}/messages/adm1`, { id: 'adm1', path: `supportThreads/${token}/messages/adm1`, name: '', data: { from: 'admin', body: 'Hi!', at: '2026-10-15T11:00:00Z' } })
    const r2 = await support.syncSupport(deps(db, f.client))
    expect(r2.received.length).toBe(1)
    expect(support.counts(db).unread).toBe(1)
    await support.syncSupport(deps(db, f.client))
    expect(support.listMessages(db).filter((x) => x.direction === 'in').length).toBe(1)
    expect(support.markAllRead(db)).toBe(1)
    expect(support.counts(db).unread).toBe(0)
  })

  it('offline keeps the message queued; permanent error -> failed -> retry', async () => {
    const db = freshDb()
    const m = support.queueMessage(db, { body: 'Need help' })
    const off = await support.syncSupport(deps(db, fakeClient({ offline: true }).client))
    expect(off.offline).toBe(true)
    expect(support.getMessage(db, m.uid)?.status).toBe('queued')
    await support.syncSupport(deps(db, fakeClient({ deny: true }).client))
    expect(support.getMessage(db, m.uid)?.status).toBe('failed')
    expect(support.retryMessage(db, m.uid).status).toBe('queued')
    const ok = fakeClient()
    await support.syncSupport(deps(db, ok.client))
    expect(support.getMessage(db, m.uid)?.status).toBe('sent')
  })

  it('a message delivered earlier (timeout after store) is marked sent, not duplicated', async () => {
    const db = freshDb()
    const m = support.queueMessage(db, { body: 'Again' })
    const f = fakeClient()
    f.docs.set(`supportThreads/${token}/messages/${m.uid}`, { id: m.uid, path: '', name: '', data: { from: 'customer', at: '2026-10-15T09:00:00Z' } })
    const orig = f.client.commit
    f.client.commit = async () => {
      throw new FirestoreError('exists', 409, 'ALREADY_EXISTS')
    }
    await support.syncSupport(deps(db, f.client))
    expect(support.getMessage(db, m.uid)?.status).toBe('sent')
    f.client.commit = orig
  })

  it('backoff grows and is capped', () => {
    expect(support.backoffMs(1)).toBe(30_000)
    expect(support.backoffMs(2)).toBe(60_000)
    expect(support.backoffMs(20)).toBe(30 * 60_000)
  })
})

describe('Windows location service (device source)', () => {
  const ok = JSON.stringify({ started: true, status: 'Ready', permission: 'Granted', unknown: false, lat: '30.0457', lng: '72.3489', acc: '35' })
  it('parses the PowerShell helper output; failures are reported as unavailable', () => {
    const r = parseDeviceLocationOutput(`noise\r\n${ok}\r\n`, new Date('2026-10-16T00:00:00Z'))
    expect(r).toEqual({ ok: true, fix: { lat: 30.0457, lng: 72.3489, accuracyKm: 0.035, fetchedAt: '2026-10-16T00:00:00.000Z' } })
    const bad = (o: Record<string, unknown>) => parseDeviceLocationOutput(JSON.stringify({ started: true, status: 'Ready', permission: 'Granted', unknown: false, lat: '30', lng: '72', acc: '10', ...o }))
    expect(bad({ permission: 'Denied' })).toMatchObject({ ok: false, error: expect.stringMatching(/unavailable.*denied/i) })
    expect(bad({ status: 'Disabled' })).toMatchObject({ ok: false, error: expect.stringMatching(/turned off/) })
    expect(bad({ started: false, status: 'NoData' })).toMatchObject({ ok: false, error: expect.stringMatching(/no location provider/) })
    expect(bad({ unknown: true, lat: 'NaN', lng: 'NaN' })).toMatchObject({ ok: false, error: expect.stringMatching(/no position/) })
    expect(parseDeviceLocationOutput('{"error":"boom"}')).toMatchObject({ ok: false, error: expect.stringMatching(/unavailable: boom/) })
    expect(parseDeviceLocationOutput('')).toMatchObject({ ok: false })
    const fix = (r as { fix: Parameters<typeof buildLocation>[1]['device'] }).fix
    expect(buildLocation('device', { device: fix })).toMatchObject({ source: 'device', accuracyKm: 0.035, label: 'Windows location service', consent: true, updatedAt: '2026-10-16T00:00:00.000Z' })
    expect(buildLocation('device', { device: null })).toBeNull()
    expect(normalizeMode('device')).toBe('device')
  })
  it('runs PowerShell hidden with a timeout, and only on Windows', async () => {
    await expect(readDeviceLocation({ platform: 'linux' })).rejects.toThrow(/only available on Windows/)
    const calls: Array<{ file: string; opts: { timeout: number; windowsHide: boolean } }> = []
    const fix = await readDeviceLocation({ platform: 'win32', exec: async (file, args, opts) => (calls.push({ file, opts }), expect(args.join(' ')).toContain('GeoCoordinateWatcher'), ok) })
    expect(fix.lat).toBe(30.0457)
    expect(calls[0]).toMatchObject({ file: 'powershell.exe', opts: { windowsHide: true } })
    expect(calls[0].opts.timeout).toBeGreaterThan(10_000)
    await expect(readDeviceLocation({ platform: 'win32', exec: async () => Promise.reject(Object.assign(new Error('t'), { killed: true })) })).rejects.toThrow(/did not answer in time/)
  })
  it('caches a fix for 6 h, retries a failure after 1 h, never falls back to another source', async () => {
    const db = freshDb()
    setSetting(db, 'location_sharing', 'device')
    const dir = mkdtempSync(join(tmpdir(), 'dtsp-loc-'))
    let now = Date.parse('2026-10-16T00:00:00Z')
    let calls = 0
    let fail = false
    const lic = { deviceId: 'D', deviceName: 'PC', installToken: 'T'.repeat(40), os: 'win', appVersion: '1', client: {} as never, status: () => ({}) as never, registration: () => null }
    const cloud = new CloudService({
      dir,
      license: lic,
      getDb: () => db,
      now: () => now,
      geoFetch: async () => { throw new Error('IP lookup must not be used') },
      deviceLocate: async () => {
        calls++
        if (fail) throw new Error('Windows location is unavailable: the Windows location service is turned off.')
        return { lat: 30.05, lng: 72.35, accuracyKm: 0.02, fetchedAt: new Date(now).toISOString() }
      }
    })
    let info = await cloud.location(true)
    expect(info.location).toMatchObject({ source: 'device', lat: 30.05 })
    await cloud.location(true)
    now += 5 * 3600_000
    await cloud.location(true)
    expect(calls).toBe(1)
    now += 2 * 3600_000
    fail = true
    info = await cloud.location(true)
    expect(calls).toBe(2)
    expect(info.location).toBeNull()
    expect(info.deviceError).toMatch(/unavailable/)
    expect(info.note).toMatch(/No location is sent/)
    now += 30 * 60_000
    await cloud.location(true)
    expect(calls).toBe(2)
    now += 31 * 60_000
    fail = false
    info = await cloud.location(true)
    expect(calls).toBe(3)
    expect(info.location?.source).toBe('device')
    // overview / preview never trigger a lookup
    await cloud.location(false)
    expect(calls).toBe(3)
  })
})
