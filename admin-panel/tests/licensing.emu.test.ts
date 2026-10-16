/**
 * Licensing integration tests against the Firestore emulator with the real rules and the portal's own code
 * (approve / reassign race, trial issuance, Devices page read cost). Run under the emulator:
 *   FIRESTORE_EMULATOR_HOST=127.0.0.1:<port> npx vitest run --dir tests
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { initializeTestEnvironment, type RulesTestEnvironment } from '@firebase/rules-unit-testing'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const st = vi.hoisted(() => ({ db: null as unknown, reads: 0, queries: 0 }))

vi.mock('../src/firebase', () => ({
  get db() {
    return st.db
  },
  auth: { currentUser: { uid: 'owner' } },
  app: {},
  firebaseConfig: {},
  BOOTSTRAP_OWNER_EMAIL: 'digitaltarget.digital@gmail.com'
}))

// Counts billed reads (a query returning nothing still costs one read).
vi.mock('firebase/firestore', async (orig) => {
  const m = await orig<typeof import('firebase/firestore')>()
  return {
    ...m,
    getDocs: async (...a: Parameters<typeof m.getDocs>) => {
      const s = await m.getDocs(...a)
      st.queries++
      st.reads += Math.max(1, s.size)
      return s
    },
    getDoc: async (...a: Parameters<typeof m.getDoc>) => {
      const s = await m.getDoc(...a)
      st.queries++
      st.reads++
      return s
    }
  }
})

import { Timestamp, doc, setDoc, writeBatch, type Firestore } from 'firebase/firestore'

const run = !!process.env.FIRESTORE_EMULATOR_HOST
let env: RulesTestEnvironment

beforeAll(async () => {
  if (!run) return
  env = await initializeTestEnvironment({
    projectId: 'dt-licensing-emu',
    firestore: { rules: readFileSync(resolve(__dirname, '../firestore.rules'), 'utf8') }
  })
  await env.clearFirestore()
  await env.withSecurityRulesDisabled(async (c) => {
    await setDoc(doc(c.firestore() as unknown as Firestore, 'admins', 'owner'), { email: 'digitaltarget.digital@gmail.com', role: 'owner', permissions: [], active: true })
  })
  st.db = env.authenticatedContext('owner', { email: 'digitaltarget.digital@gmail.com' }).firestore()
}, 60_000)
afterAll(async () => {
  await env?.cleanup()
})

const SEC_DEV = (n: string) => `${n}-0000-1111-2222-3333`

async function signingKey() {
  const { generateKeyPairSync } = await import('node:crypto')
  const { privateKey } = generateKeyPairSync('ed25519')
  const { loadKey } = await import('../src/lib/crypto')
  return loadKey(privateKey.export({ type: 'pkcs8', format: 'pem' }).toString())
}

async function seedLicense(id: string, key: string, o: Record<string, unknown> = {}) {
  await env.withSecurityRulesDisabled(async (c) => {
    await setDoc(doc(c.firestore() as unknown as Firestore, 'licenses', id), {
      licenseKey: key,
      businessName: `Biz ${id}`,
      customerName: 'Cust',
      plan: 'standard',
      planType: 'yearly',
      status: 'active',
      maxDevices: 1,
      maxFirms: 1,
      maxUsers: 3,
      features: [],
      activeDevices: 0,
      expiresAt: Timestamp.fromMillis(Date.now() + 86400e3 * 100),
      activatedAt: null,
      devicesSummary: {},
      createdAt: Timestamp.now(),
      updatedAt: Timestamp.now(),
      ...o
    })
  })
}

async function seedRequest(id: string, licenseKey: string, deviceId: string) {
  await env.withSecurityRulesDisabled(async (c) => {
    await setDoc(doc(c.firestore() as unknown as Firestore, 'activationRequests', id), {
      type: 'activate', licenseKey, deviceId, deviceName: `PC ${deviceId.slice(0, 4)}`, appVersion: '1.2.0', os: 'Windows 11 Pro 23H2', status: 'pending', createdAt: Timestamp.now()
    })
  })
  const { requestFromSnap, requestRef } = await import('../src/lib/licenses')
  const { getDoc } = await import('firebase/firestore')
  return requestFromSnap(await getDoc(requestRef(id)))
}

async function licState(id: string) {
  const { licenseFromSnap, licenseRef, devicesCol, deviceFromSnap, historyCol } = await import('../src/lib/licenses')
  const { getDoc, getDocs } = await import('firebase/firestore')
  const l = licenseFromSnap(await getDoc(licenseRef(id)))
  const devices = (await getDocs(devicesCol(id))).docs.map(deviceFromSnap)
  const history = (await getDocs(historyCol(id))).docs.map((d) => String(d.data().action) + ': ' + String(d.data().details))
  return { l, devices, history }
}

describe.runIf(run)('device approval on the emulator (real rules, portal code)', () => {
  it('two approvals racing for the last slot: exactly one wins, the other needs reassignment', async () => {
    const { approveRequest } = await import('../src/lib/approve')
    const key = await signingKey()
    const K = 'DTSP-RACE-AAAA-BBBB-CCCC'
    await seedLicense('race1', K)
    const r1 = await seedRequest('reqRaceOne00000000000001', K, SEC_DEV('DEVA'))
    const r2 = await seedRequest('reqRaceTwo00000000000002', K, SEC_DEV('DEVB'))
    const out = await Promise.all([approveRequest(r1, key, 'owner@test'), approveRequest(r2, key, 'owner@test')])
    expect(out.sort()).toEqual(['approved', 'needs_reassignment'])
    const st = await licState('race1')
    expect(st.l.activeDevices).toBe(1)
    expect(st.devices.filter((d) => d.status === 'active')).toHaveLength(1)
    expect(Object.values(st.l.devicesSummary ?? {}).filter((d) => d.status === 'active')).toHaveLength(1)
    expect(st.history.some((h) => h.startsWith('device_activated'))).toBe(true)
    // full device ids are never written to the history
    expect(st.history.join('\n')).not.toContain(SEC_DEV('DEVA'))
    expect(st.history.join('\n')).not.toContain(SEC_DEV('DEVB'))

    // the active computer asks again: re-issued, no new slot
    const winner = st.devices.find((d) => d.status === 'active')!.deviceId
    const loser = winner === SEC_DEV('DEVA') ? r2 : r1
    const again = await seedRequest('reqRaceAgain000000000003', K, winner)
    expect(await approveRequest(again, key, 'owner@test')).toBe('reissued')
    expect((await licState('race1')).l.activeDevices).toBe(1)

    // two admins replace the same computer at once: only one replacement succeeds, the other is refused
    const other = await seedRequest('reqRaceThree000000000004', K, SEC_DEV('DEVC'))
    const res = await Promise.all([
      approveRequest(loser, key, 'owner@test', { replaceDeviceId: winner, note: 'new laptop' }),
      approveRequest(other, key, 'owner@test', { replaceDeviceId: winner })
    ])
    expect(res.sort()).toEqual(['reassigned', 'rejected'])
    const end = await licState('race1')
    expect(end.l.activeDevices).toBe(1)
    expect(end.devices.filter((d) => d.status === 'active')).toHaveLength(1)
    expect(end.devices.find((d) => d.deviceId === winner)?.status).toBe('deactivated')
    expect(end.history.some((h) => h.startsWith('device_reassigned'))).toBe(true)
    expect(end.history.some((h) => h.startsWith('activation_rejected'))).toBe(true)
  }, 60_000)

  it('a suspended license cannot get a computer approved (request rejected and recorded)', async () => {
    const { approveRequest } = await import('../src/lib/approve')
    const key = await signingKey()
    const K = 'DTSP-SUSP-AAAA-BBBB-CCCC'
    await seedLicense('susp1', K, { status: 'suspended' })
    const r = await seedRequest('reqSuspOne00000000000001', K, SEC_DEV('DEVS'))
    expect(await approveRequest(r, key, 'owner@test')).toBe('rejected')
    const st = await licState('susp1')
    expect(st.l.activeDevices).toBe(0)
    expect(st.devices).toHaveLength(0)
    expect(st.history.some((h) => h.startsWith('activation_rejected'))).toBe(true)
  }, 30_000)

  it('issues a 15-day trial license (1 computer) that still needs device approval', async () => {
    const { issueTrial } = await import('../src/lib/licenses')
    const { trialExpiry } = await import('../src/lib/terms')
    const exp = trialExpiry(new Date())
    const { id, licenseKey } = await issueTrial({ customerName: 'Trial Co', businessName: 'Trial Biz', phone: '', email: '', city: 'Lahore', expiresAt: exp }, 'owner@test')
    expect(licenseKey).toMatch(/^DTSP(-[A-Z0-9]{4}){4}$/)
    const st = await licState(id)
    expect(st.l).toMatchObject({ plan: 'trial', planType: 'trial', maxDevices: 1, status: 'active', activeDevices: 0 })
    expect(st.l.devicesSummary).toEqual({})
    expect(Math.abs(st.l.expiresAt!.toMillis() - exp.getTime())).toBeLessThan(1000)
    expect(st.history.some((h) => h.startsWith('trial_issued'))).toBe(true)
    await expect(issueTrial({ customerName: 'X', businessName: '', phone: '', email: '', city: '', expiresAt: new Date(Date.now() + 200 * 86400e3) }, 'owner@test')).rejects.toThrow(/at most 90/)
  }, 30_000)

  it('rules: registering a computer needs devices.manage (licenses.manage alone is not enough)', async () => {
    await env.withSecurityRulesDisabled(async (c) => {
      await setDoc(doc(c.firestore() as unknown as Firestore, 'admins', 'licmgr'), { email: 'lm@test', role: 'custom', permissions: ['licenses.view', 'licenses.manage'], active: true })
    })
    const { assertFails, assertSucceeds } = await import('@firebase/rules-unit-testing')
    const lm = env.authenticatedContext('licmgr', { email: 'lm@test' }).firestore() as unknown as Firestore
    await assertFails(setDoc(doc(lm, 'licenses', 'race1', 'devices', 'SNEAKY-DEVICE-0001'), { deviceId: 'SNEAKY-DEVICE-0001', status: 'active' }))
    const ow = st.db as Firestore
    await assertSucceeds(setDoc(doc(ow, 'licenses', 'race1', 'devices', 'OWNER-DEVICE-00001'), { deviceId: 'OWNER-DEVICE-00001', status: 'deactivated' }))
  }, 30_000)
})

describe.runIf(run)('Devices page read cost (300 licenses / 600 devices / 600 heartbeats)', () => {
  it('measures the fleet load before (N+1) and after (devicesSummary)', async () => {
    await env.clearFirestore()
    await env.withSecurityRulesDisabled(async (c) => {
      await setDoc(doc(c.firestore() as unknown as Firestore, 'admins', 'owner'), { email: 'digitaltarget.digital@gmail.com', role: 'owner', permissions: [], active: true })
    })
    await env.withSecurityRulesDisabled(async (c) => {
      const fs = c.firestore() as unknown as Firestore
      let b = writeBatch(fs)
      let n = 0
      const flush = async () => {
        await b.commit()
        b = writeBatch(fs)
        n = 0
      }
      for (let i = 0; i < 300; i++) {
        const id = `perfLic${String(i).padStart(4, '0')}`
        const devs = [0, 1].map((k) => `PERF-${String(i).padStart(4, '0')}-DEV${k}-XXXX-XXXX`)
        b.set(doc(fs, 'licenses', id), {
          licenseKey: `DTSP-PERF-${String(i).padStart(4, '0')}-AAAA-BBBB`,
          businessName: `Biz ${i}`,
          customerName: `Cust ${i}`,
          plan: 'standard',
          planType: 'yearly',
          status: 'active',
          maxDevices: 2,
          activeDevices: 2,
          expiresAt: Timestamp.fromMillis(Date.now() + 86400e3 * 100),
          activatedAt: Timestamp.now(),
          createdAt: Timestamp.now(),
          devicesSummary: Object.fromEntries(devs.map((d) => [d, { deviceName: `PC ${d}`, os: 'Windows 11', appVersion: '1.1.0', status: 'active', activatedAt: Timestamp.now(), activationType: 'online', statusNote: '' }]))
        })
        n++
        for (const d of devs) {
          b.set(doc(fs, 'licenses', id, 'devices', d), { deviceId: d, deviceName: `PC ${d}`, os: 'Windows 11', appVersion: '1.1.0', status: 'active', activatedAt: Timestamp.now(), activationType: 'online' })
          b.set(doc(fs, 'heartbeats', `${d}-TOKEN-0000000000000000`), { deviceId: d, licenseId: id, deviceName: `PC ${d}`, os: 'Windows 11', appVersion: '1.1.0', lastCheckAt: new Date().toISOString(), lastSeen: Timestamp.now() })
          n += 2
        }
        if (n > 400) await flush()
      }
      await flush()
    })
    const fleet = await import('../src/lib/fleet')
    const { licenseFromSnap, licensesCol } = await import('../src/lib/licenses')
    const { getDocs } = await import('firebase/firestore')
    // BEFORE: the previous Devices page — all licenses, then each devices sub-collection (8 in flight), then heartbeats.
    st.reads = 0
    st.queries = 0
    let t0 = performance.now()
    const before = (await getDocs(licensesCol())).docs.map(licenseFromSnap)
    const [devs] = await Promise.all([fleet.loadDevicesFor(before), fleet.loadHeartbeats()])
    const b = { q: st.queries, r: st.reads, ms: Math.round(performance.now() - t0) }
    console.log(`[perf] BEFORE (licenses + devices per license + heartbeats): ${b.q} queries, ${b.r} billed reads, ${b.ms} ms`)
    expect(Object.values(devs).flat()).toHaveLength(600)

    // AFTER: licenses (with devicesSummary) and heartbeats in parallel; no per-license read.
    fleet.invalidateLicenses()
    st.reads = 0
    st.queries = 0
    t0 = performance.now()
    const [licenses, hbs] = await Promise.all([fleet.loadLicenses({ fresh: true }), fleet.loadHeartbeats()])
    const infos = await fleet.loadDeviceInfos(licenses)
    const a = { q: st.queries, r: st.reads, ms: Math.round(performance.now() - t0) }
    console.log(`[perf] AFTER (licenses with devicesSummary + heartbeats, parallel): ${a.q} queries, ${a.r} billed reads, ${a.ms} ms`)
    expect(licenses.length).toBe(300)
    expect(hbs.length).toBe(600)
    expect(Object.values(infos).flat()).toHaveLength(600)
    expect(a.q).toBe(2)
    expect(a.r).toBeLessThan(b.r)

    // Cached second load (navigation between pages) costs nothing; a mutation (writeLog) invalidates it.
    st.reads = 0
    await fleet.loadLicenses()
    expect(st.reads).toBe(0)
    const { invalidateLicenses } = await import('../src/lib/licenses')
    invalidateLicenses()
    await fleet.loadLicenses()
    expect(st.reads).toBe(300)
  }, 180_000)

  it('a license without devicesSummary is read from its sub-collection and backfilled once', async () => {
    const fleet = await import('../src/lib/fleet')
    await env.withSecurityRulesDisabled(async (c) => {
      const fs = c.firestore() as unknown as Firestore
      await setDoc(doc(fs, 'licenses', 'legacy1'), { licenseKey: 'DTSP-LEGA-CYAA-BBBB-CCCC', businessName: 'Legacy', plan: 'standard', planType: 'yearly', status: 'active', maxDevices: 2, activeDevices: 1, createdAt: Timestamp.now(), updatedAt: Timestamp.fromMillis(1000) })
      await setDoc(doc(fs, 'licenses', 'legacy1', 'devices', 'LEGACY-DEVICE-0001'), { deviceId: 'LEGACY-DEVICE-0001', deviceName: 'Old PC', os: 'Windows 10', appVersion: '1.0.0', status: 'active', activatedAt: Timestamp.now(), activationType: 'offline' })
    })
    const one = (await fleet.loadLicenses({ fresh: true })).filter((l) => l.id === 'legacy1')
    expect(one[0].devicesSummary).toBeNull()
    const infos = await fleet.loadDeviceInfos(one, { backfill: true })
    expect(infos.legacy1.map((d) => d.deviceName)).toEqual(['Old PC'])
    const again = (await fleet.loadLicenses({ fresh: true })).find((l) => l.id === 'legacy1')!
    expect(Object.keys(again.devicesSummary ?? {})).toEqual(['LEGACY-DEVICE-0001'])
    expect(again.devicesSummary!['LEGACY-DEVICE-0001']).toMatchObject({ status: 'active', activationType: 'offline', os: 'Windows 10' })
  }, 60_000)

  it('publishes an activation pass per active license (instant activation), re-signs on change, withdraws on suspend', async () => {
    const { syncPasses, licenseKeyHash, passRef, PASS_DEVICE } = await import('../src/lib/activationPass')
    const { licenseFromSnap, licenseRef } = await import('../src/lib/licenses')
    const { verifyCode, base64UrlToUtf8 } = await import('../src/lib/crypto')
    const { getDoc, updateDoc } = await import('firebase/firestore')
    const key = await signingKey()
    const K = 'DTSP-PASS-AAAA-BBBB-CCCC'
    await seedLicense('pass1', K, { maxDevices: 3 })
    const lic = async () => licenseFromSnap(await getDoc(licenseRef('pass1')))
    await syncPasses([await lic()], key, 'owner@test')
    const hash = await licenseKeyHash(K)
    expect(hash).toMatch(/^[0-9a-f]{64}$/)
    const p1 = await getDoc(passRef(hash))
    expect(p1.exists()).toBe(true)
    expect(p1.data()!.licenseId).toBe('pass1')
    expect(await verifyCode(p1.data()!.cert, key.publicKey)).toBe(true)
    const payload = JSON.parse(base64UrlToUtf8(String(p1.data()!.cert).split('.')[0]))
    expect(payload.deviceId).toBe(PASS_DEVICE)
    expect(payload.maxDevices).toBe(3)
    const h1 = (await lic()).passHash
    expect(h1).not.toBe('')
    // unchanged terms: nothing re-signed
    await syncPasses([await lic()], key, 'owner@test')
    expect((await getDoc(passRef(hash))).data()!.cert).toBe(p1.data()!.cert)
    // terms change -> new pass
    await updateDoc(licenseRef('pass1'), { maxUsers: 9 })
    await syncPasses([await lic()], key, 'owner@test')
    expect((await lic()).passHash).not.toBe(h1)
    expect(JSON.parse(base64UrlToUtf8(String((await getDoc(passRef(hash))).data()!.cert).split('.')[0])).maxUsers).toBe(9)
    // suspended -> withdrawn
    await updateDoc(licenseRef('pass1'), { status: 'suspended' })
    await syncPasses([await lic()], key, 'owner@test')
    expect((await getDoc(passRef(hash))).exists()).toBe(false)
    expect((await lic()).passHash).toBe('')
  })

  it('rules: activation passes are public by id, never listable, written only by license admins', async () => {
    const { collection, getDocs, getDoc, setDoc: set, doc: d } = await import('firebase/firestore')
    const anon = env.unauthenticatedContext().firestore() as unknown as Firestore
    const id = 'a'.repeat(64)
    await env.withSecurityRulesDisabled(async (c) => set(d(c.firestore() as unknown as Firestore, 'activationPasses', id), { licenseId: 'x', cert: 'y' }))
    expect((await getDoc(d(anon, 'activationPasses', id))).exists()).toBe(true)
    await expect(getDocs(collection(anon, 'activationPasses'))).rejects.toThrow()
    await expect(set(d(anon, 'activationPasses', 'b'.repeat(64)), { licenseId: 'x', cert: 'y' })).rejects.toThrow()
  })
})

