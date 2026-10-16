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

describe.runIf(run)('Devices page read cost (300 licenses / 600 devices / 600 heartbeats)', () => {
  it('measures the fleet load', async () => {
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
    st.reads = 0
    st.queries = 0
    const t0 = performance.now()
    const licenses = await fleet.loadLicenses()
    await Promise.all([fleet.loadDevicesFor(licenses), fleet.loadHeartbeats()])
    const ms = Math.round(performance.now() - t0)
    console.log(`[perf] BEFORE (licenses + devices per license + heartbeats): ${st.queries} queries, ${st.reads} billed reads, ${ms} ms`)
    expect(licenses.length).toBe(300)
  }, 180_000)
})
