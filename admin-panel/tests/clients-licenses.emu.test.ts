/**
 * Clients / licenses / devices clean-up against the Firestore emulator with the real rules and the portal's own code:
 * client delete (persists, unlinks, refuses while an active license is linked), license delete (devices, history,
 * status, pending requests), no duplicate client from license details, and "Remove device". Run under the emulator:
 *   firebase emulators:exec --only firestore "npx vitest run --dir tests"
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { assertFails, assertSucceeds, initializeTestEnvironment, type RulesTestEnvironment } from '@firebase/rules-unit-testing'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const st = vi.hoisted(() => ({ db: null as unknown, uid: 'owner' }))

vi.mock('../src/firebase', () => ({
  get db() {
    return st.db
  },
  auth: {
    get currentUser() {
      return { uid: st.uid, email: `${st.uid}@test` }
    }
  },
  app: {},
  firebaseConfig: {},
  BOOTSTRAP_OWNER_EMAIL: 'digitaltarget.digital@gmail.com'
}))

import { Timestamp, collection, deleteDoc, doc, getDoc, getDocs, query, setDoc, where, writeBatch, type Firestore } from 'firebase/firestore'
import { ROLE_PRESETS } from '../src/lib/perm'
import type { LicenseInput } from '../src/lib/licenses'

const run = !!process.env.FIRESTORE_EMULATOR_HOST
let env: RulesTestEnvironment

/** Acts as `uid` for the portal code (db + auth.currentUser). */
function actAs(uid: string): Firestore {
  st.uid = uid
  st.db = env.authenticatedContext(uid, { email: uid === 'owner' ? 'digitaltarget.digital@gmail.com' : `${uid}@test` }).firestore()
  return st.db as Firestore
}
/** Reads with the rules off (what is really stored). */
async function raw<T>(fn: (fs: Firestore) => Promise<T>): Promise<T> {
  let out: T
  await env.withSecurityRulesDisabled(async (c) => {
    out = await fn(c.firestore() as unknown as Firestore)
  })
  return out!
}

beforeAll(async () => {
  if (!run) return
  env = await initializeTestEnvironment({
    projectId: 'dt-clients-licenses-emu',
    firestore: { rules: readFileSync(resolve(__dirname, '../firestore.rules'), 'utf8') }
  })
  await env.clearFirestore()
  await raw(async (fs) => {
    await setDoc(doc(fs, 'admins', 'owner'), { email: 'digitaltarget.digital@gmail.com', role: 'owner', permissions: [], active: true })
    for (const r of ['sales', 'technical', 'support'] as const) {
      await setDoc(doc(fs, 'admins', r), { email: `${r}@test`, role: r, permissions: ROLE_PRESETS[r].permissions, active: true })
    }
  })
}, 60_000)
afterAll(async () => {
  await env?.cleanup()
})

async function seedLicense(id: string, key: string, o: Record<string, unknown> = {}) {
  await raw((fs) =>
    setDoc(doc(fs, 'licenses', id), {
      licenseKey: key,
      businessName: `Biz ${id}`,
      customerName: 'Cust',
      phone: '',
      email: '',
      city: '',
      plan: 'standard',
      planType: 'yearly',
      status: 'active',
      maxDevices: 2,
      maxFirms: 1,
      maxUsers: 3,
      features: [],
      activeDevices: 0,
      checkinDays: 30,
      graceDays: 15,
      expiresAt: Timestamp.fromMillis(Date.now() + 86400e3 * 100),
      activatedAt: null,
      devicesSummary: {},
      clientId: '',
      createdAt: Timestamp.now(),
      updatedAt: Timestamp.now(),
      ...o
    })
  )
}

function licenseInput(o: Partial<LicenseInput> = {}): LicenseInput {
  return {
    customerName: 'Imran Ali',
    businessName: 'Bright Solar Traders',
    phone: '0300-7654321',
    email: '',
    city: 'Multan',
    plan: 'standard',
    maxDevices: 1,
    maxFirms: 2,
    maxUsers: 3,
    features: ['projects'],
    expiresAt: new Date(Date.now() + 365 * 86400e3),
    checkinDays: 30,
    graceDays: 15,
    notes: '',
    clientId: '',
    planType: 'yearly',
    poweredBy: false,
    ...o
  }
}

describe.runIf(run)('client delete (emulator, real rules)', () => {
  it('is refused while an active license is linked; unlinks the others; persists for an admin with clients.manage', async () => {
    actAs('owner')
    const { createClient, clientDeletePreview, clientFromSnap, clientRef, deleteClient, unlinkClientLicenses } = await import('../src/lib/clientsDb')
    const { blankClient } = await import('../src/lib/clients')
    const { id } = await createClient({ ...blankClient(), company: 'Delete Me Co', phone: '0300 1111111' }, 'owner@test')
    const c = clientFromSnap(await getDoc(clientRef(id)))
    await seedLicense('delcActive', 'DTSP-DELC-AAAA-BBBB-0001', { clientId: id })
    await seedLicense('delcRevoked', 'DTSP-DELC-AAAA-BBBB-0002', { clientId: id, status: 'revoked' })
    await seedLicense('delcExpired', 'DTSP-DELC-AAAA-BBBB-0003', { clientId: id, expiresAt: Timestamp.fromMillis(Date.now() - 86400e3) })

    const opts = { canDelete: true, canUnlink: true, invoices: true, threads: true }
    const prev = await clientDeletePreview(c, opts)
    expect(prev.check.ok).toBe(false)
    expect(prev.check.active).toEqual(['delcActive'])
    expect(prev.check.unlink.sort()).toEqual(['delcExpired', 'delcRevoked'])
    await expect(deleteClient(c, 'owner@test', opts)).rejects.toThrow(/active license/)
    expect((await raw((fs) => getDoc(doc(fs, 'clients', id)))).exists()).toBe(true)

    // The dialog offers to unlink the active license; then a Sales agent (clients.manage, no owner) deletes the client.
    expect(await unlinkClientLicenses(c, ['delcActive'], 'owner@test')).toBe(1)
    actAs('sales')
    const r = await deleteClient(c, 'sales@test', { canDelete: true, canUnlink: true, invoices: true, threads: false })
    expect(r.unlinked).toBe(2)

    // Persisted: the document is really gone and every license is unlinked (and kept).
    expect((await raw((fs) => getDoc(doc(fs, 'clients', id)))).exists()).toBe(false)
    for (const lid of ['delcActive', 'delcRevoked', 'delcExpired']) {
      const l = await raw((fs) => getDoc(doc(fs, 'licenses', lid)))
      expect(l.exists()).toBe(true)
      expect(l.data()?.clientId).toBe('')
    }
    const audit = await raw((fs) => getDocs(query(collection(fs, 'auditLogs'), where('target', '==', id))))
    const del = audit.docs.map((d) => d.data()).find((a) => a.action === 'client_deleted')
    expect(del).toMatchObject({ category: 'client', byUid: 'sales', status: 'success' })
    expect(String(del?.details)).toMatch(/2 license\(s\) unlinked/)
    const hist = await raw((fs) => getDocs(collection(fs, 'licenses', 'delcRevoked', 'history')))
    expect(hist.docs.some((h) => h.data().action === 'client_unlinked')).toBe(true)
  }, 60_000)

  it('rules: clients.manage may delete a client, others may not', async () => {
    await raw((fs) => setDoc(doc(fs, 'clients', 'ruleClient'), { company: 'X', status: 'active' }))
    await assertFails(deleteDoc(doc(actAs('support'), 'clients', 'ruleClient')))
    await assertSucceeds(deleteDoc(doc(actAs('sales'), 'clients', 'ruleClient')))
  }, 30_000)
})

describe.runIf(run)('license delete (emulator, real rules)', () => {
  it('removes the license, its devices (active ones too), history, status, activation pass and answers pending requests', async () => {
    actAs('owner')
    const { createLicense, licenseFromSnap, licenseRef } = await import('../src/lib/licenses')
    const { deleteLicense, activationPassId } = await import('../src/lib/deletions')
    const created = await createLicense(licenseInput({ businessName: 'Doomed Solar', phone: '' }), 'owner@test')
    const id = created.id
    const key = created.licenseKey
    const ACTIVE = 'DEL-ACTIVE-0000-1111'
    await raw(async (fs) => {
      await setDoc(doc(fs, 'licenses', id, 'devices', ACTIVE), { deviceId: ACTIVE, deviceName: 'Front desk', status: 'active', activatedAt: Timestamp.now() })
      await setDoc(doc(fs, 'licenses', id, 'devices', 'DEL-RELEASED-0000-1111'), { deviceId: 'DEL-RELEASED-0000-1111', status: 'deactivated' })
      await setDoc(doc(fs, 'licenses', id, 'devices', 'DEL-SUSPENDED-000-1111'), { deviceId: 'DEL-SUSPENDED-000-1111', status: 'suspended' })
      // more history than one batch holds
      let b = writeBatch(fs)
      for (let i = 0; i < 450; i++) {
        b.set(doc(fs, 'licenses', id, 'history', `h${String(i).padStart(4, '0')}`), { action: 'x', by: 'seed', details: '' })
        if (i % 400 === 399) {
          await b.commit()
          b = writeBatch(fs)
        }
      }
      await b.commit()
      await setDoc(doc(fs, 'activationRequests', 'reqDelPending0000000000001'), { type: 'activate', licenseKey: key, deviceId: 'DEL-NEW-PC-0000-1111', status: 'pending', createdAt: Timestamp.now() })
      await setDoc(doc(fs, 'activationRequests', 'reqDelDone00000000000000002'), { type: 'activate', licenseKey: key, deviceId: 'DEL-OLD-PC-0000-1111', status: 'approved', createdAt: Timestamp.now() })
      await setDoc(doc(fs, 'activationPasses', await activationPassId(key)), { licenseId: id })
    })

    // While the license exists nobody may delete its ACTIVE device record — not even the owner.
    await assertFails(deleteDoc(doc(actAs('technical'), 'licenses', id, 'devices', ACTIVE)))
    await assertFails(deleteDoc(doc(actAs('owner'), 'licenses', id, 'devices', ACTIVE)))
    // Only the owner deletes licenses.
    const lic = licenseFromSnap(await getDoc(licenseRef(id)))
    actAs('technical')
    await expect(deleteLicense(lic, 'technical@test')).rejects.toThrow()
    expect((await raw((fs) => getDoc(doc(fs, 'licenses', id)))).exists()).toBe(true)

    actAs('owner')
    const r = await deleteLicense(lic, 'owner@test', 'test clean-up', { invoices: true })
    expect(r.devices).toBe(3)
    expect(r.history).toBeGreaterThanOrEqual(450)
    expect(r.requests).toBe(1)

    const after = await raw(async (fs) => ({
      license: (await getDoc(doc(fs, 'licenses', id))).exists(),
      status: (await getDoc(doc(fs, 'licenseStatus', id))).exists(),
      devices: (await getDocs(collection(fs, 'licenses', id, 'devices'))).size,
      history: (await getDocs(collection(fs, 'licenses', id, 'history'))).size,
      pending: (await getDoc(doc(fs, 'activationRequests', 'reqDelPending0000000000001'))).data(),
      done: (await getDoc(doc(fs, 'activationRequests', 'reqDelDone00000000000000002'))).data(),
      pass: (await getDoc(doc(fs, 'activationPasses', await activationPassId(key)))).exists(),
      audit: (await getDocs(query(collection(fs, 'auditLogs'), where('licenseId', '==', id)))).docs.map((d) => d.data())
    }))
    expect(after).toMatchObject({ license: false, status: false, devices: 0, history: 0 })
    expect(after.pending).toMatchObject({ status: 'rejected', processedBy: 'owner@test' })
    expect(String(after.pending?.message)).toMatch(/deleted/)
    expect(after.done?.status).toBe('approved')
    // The pass is removed when the rules allow it (activationPasses rules come with the activation-flow change);
    // otherwise the delete reports it instead of failing.
    if (r.activationPass) expect(after.pass).toBe(false)
    else expect(r.warnings.join(' ')).toMatch(/activation pass/)
    const audit = after.audit.find((a) => a.action === 'license_deleted')
    expect(audit).toMatchObject({ category: 'license', byUid: 'owner', status: 'success' })
    expect(String(audit?.details)).toMatch(/3 computer record\(s\) \(1 active\)/)
  }, 90_000)
})

describe.runIf(run)('license details → client record (emulator, real rules)', () => {
  it('creates the client once and reuses it for the same phone or the same company + owner; fills only empty fields', async () => {
    actAs('owner')
    const { createLicense, updateLicense, licenseFromSnap, licenseRef } = await import('../src/lib/licenses')
    const { clientSyncFor } = await import('../src/lib/clientsDb')
    const counter = async () => Number((await raw((fs) => getDoc(doc(fs, 'counters', 'clients')))).data()?.next ?? 1)
    const startNext = await counter()

    const in1 = licenseInput()
    const s1 = await clientSyncFor(in1, 'owner@test')
    expect(s1.kind).toBe('new')
    const a = await createLicense(in1, 'owner@test', undefined, s1.linker)
    expect(a.client?.created).toBe(true)
    expect(a.clientId).not.toBe('')

    // Same phone in another format, different spelling of the business, plus an e-mail the client lacks.
    const in2 = licenseInput({ businessName: 'BRIGHT SOLAR (Branch 2)', phone: '+92 300 7654321', email: 'imran@bright.pk', city: 'Lahore' })
    const s2 = await clientSyncFor(in2, 'owner@test')
    expect(s2).toMatchObject({ kind: 'matched', by: 'phone' })
    const b = await createLicense(in2, 'owner@test', undefined, s2.linker)
    expect(b.clientId).toBe(a.clientId)
    expect(b.client?.created).toBe(false)

    // No phone: same company + owner name, other case / spacing.
    const in3 = licenseInput({ phone: '', businessName: '  bright solar traders ', customerName: 'IMRAN  ALI' })
    const s3 = await clientSyncFor(in3, 'owner@test')
    expect(s3).toMatchObject({ kind: 'matched', by: 'name' })
    const c3 = await createLicense(in3, 'owner@test', undefined, s3.linker)
    expect(c3.clientId).toBe(a.clientId)

    // Editing a legacy license without a client links it to the same client (matched by phone).
    await seedLicense('legacyNoClient', 'DTSP-LEGA-CY00-0000-0001', { businessName: 'Bright Solar', customerName: 'Imran', phone: '03007654321' })
    const legacy = licenseFromSnap(await getDoc(licenseRef('legacyNoClient')))
    const in4 = { ...licenseInput({ businessName: legacy.businessName, customerName: legacy.customerName, phone: legacy.phone }), clientId: '' }
    await updateLicense(legacy, in4, 'owner@test', (await clientSyncFor(in4, 'owner@test')).linker)

    const stored = await raw(async (fs) => ({
      clients: (await getDocs(collection(fs, 'clients'))).docs.filter((d) => /bright/i.test(String(d.data().company))).map((d) => ({ id: d.id, ...d.data() })),
      links: await Promise.all([a.id, b.id, c3.id, 'legacyNoClient'].map(async (lid) => (await getDoc(doc(fs, 'licenses', lid))).data()?.clientId))
    }))
    expect(stored.clients).toHaveLength(1)
    expect(stored.clients[0]).toMatchObject({ id: a.clientId, company: 'Bright Solar Traders', ownerName: 'Imran Ali', phone: '0300-7654321', email: 'imran@bright.pk', city: 'Multan', status: 'active' })
    expect(stored.links).toEqual([a.clientId, a.clientId, a.clientId, a.clientId])
    expect(await counter()).toBe(startNext + 1)
  }, 60_000)
})

describe.runIf(run)('remove device (emulator, real rules)', () => {
  it('releases an active computer, then deletes its record and heartbeat (devices.manage)', async () => {
    const DEV = 'RM-ACTIVE-PC-0000-1111'
    const TOKEN = 'R'.repeat(40)
    await seedLicense('rmLic', 'DTSP-RMDE-VICE-0000-0001', {
      activeDevices: 1,
      activatedAt: Timestamp.now(),
      devicesSummary: { [DEV]: { deviceName: 'Old laptop', os: 'Windows 10', appVersion: '1.1.0', status: 'active', activatedAt: Timestamp.now(), activationType: 'online', statusNote: '' } }
    })
    await raw(async (fs) => {
      await setDoc(doc(fs, 'licenses', 'rmLic', 'devices', DEV), { deviceId: DEV, deviceName: 'Old laptop', os: 'Windows 10', appVersion: '1.1.0', status: 'active', activatedAt: Timestamp.now(), activationType: 'online' })
      await setDoc(doc(fs, 'licenseStatus', 'rmLic'), { status: 'active', deactivatedDevices: [] })
      await setDoc(doc(fs, 'heartbeats', TOKEN), { deviceId: DEV, licenseId: 'rmLic', deviceName: 'Old laptop', lastSeen: Timestamp.now(), location: { lat: 31.5, lng: 74.3, source: 'approximate', accuracyKm: 25, consent: true } })
    })
    actAs('technical')
    const { removeDevice } = await import('../src/lib/deletions')
    const r = await removeDevice('rmLic', DEV, 'technical@test', { deleteRecord: true, note: 'replaced' })
    expect(r).toMatchObject({ released: true, deleted: true, heartbeats: 1, warnings: [] })
    const after = await raw(async (fs) => ({
      lic: (await getDoc(doc(fs, 'licenses', 'rmLic'))).data(),
      dev: (await getDoc(doc(fs, 'licenses', 'rmLic', 'devices', DEV))).exists(),
      status: (await getDoc(doc(fs, 'licenseStatus', 'rmLic'))).data(),
      hb: (await getDoc(doc(fs, 'heartbeats', TOKEN))).exists(),
      history: (await getDocs(collection(fs, 'licenses', 'rmLic', 'history'))).docs.map((d) => String(d.data().action))
    }))
    expect(after.lic?.activeDevices).toBe(0)
    expect(Object.keys(after.lic?.devicesSummary ?? {})).not.toContain(DEV)
    expect(after.dev).toBe(false)
    expect(after.status?.deactivatedDevices).toContain(DEV)
    expect(after.hb).toBe(false)
    expect(after.history).toEqual(expect.arrayContaining(['device_released', 'device_removed']))
  }, 60_000)
})
