/**
 * Operations on the emulator with the real rules and the portal's own code: one-transaction approval, reactivation with a
 * published certificate, Clear / Delete chat, Clear all activity, activity de-duplication, Administrator password reset
 * publishing and its authorisation. Run under the emulator:
 *   FIRESTORE_EMULATOR_HOST=127.0.0.1:<port> npx vitest run --dir tests
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { initializeTestEnvironment, type RulesTestEnvironment } from '@firebase/rules-unit-testing'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const st = vi.hoisted(() => ({ db: null as unknown, tx: 0, getDocs: 0, getDoc: 0 }))

vi.mock('../src/firebase', () => ({
  get db() {
    return st.db
  },
  auth: { currentUser: { uid: 'owner', email: 'digitaltarget.digital@gmail.com' } },
  app: {},
  firebaseConfig: {},
  BOOTSTRAP_OWNER_EMAIL: 'digitaltarget.digital@gmail.com'
}))

vi.mock('firebase/firestore', async (orig) => {
  const m = await orig<typeof import('firebase/firestore')>()
  return {
    ...m,
    runTransaction: (...a: Parameters<typeof m.runTransaction>) => {
      st.tx++
      return m.runTransaction(...a)
    },
    getDocs: (...a: Parameters<typeof m.getDocs>) => {
      st.getDocs++
      return m.getDocs(...a)
    },
    getDoc: (...a: Parameters<typeof m.getDoc>) => {
      st.getDoc++
      return m.getDoc(...a)
    }
  }
})

import { Timestamp, doc, getDoc, getDocs, collection, setDoc, updateDoc, deleteDoc, serverTimestamp, type Firestore } from 'firebase/firestore'

const run = !!process.env.FIRESTORE_EMULATOR_HOST
let env: RulesTestEnvironment
const admin = (c: { firestore(): unknown }) => c.firestore() as unknown as Firestore

beforeAll(async () => {
  if (!run) return
  env = await initializeTestEnvironment({ projectId: 'dt-ops-emu', firestore: { rules: readFileSync(resolve(__dirname, '../firestore.rules'), 'utf8') } })
  await env.clearFirestore()
  await env.withSecurityRulesDisabled(async (c) => {
    const d = admin(c)
    await setDoc(doc(d, 'admins', 'owner'), { email: 'digitaltarget.digital@gmail.com', role: 'owner', permissions: [], active: true })
    await setDoc(doc(d, 'admins', 'supporter'), { email: 's@x.com', role: 'support', permissions: ['support.manage'], active: true })
    await setDoc(doc(d, 'admins', 'both'), { email: 'b@x.com', role: 'custom', permissions: ['devices.manage', 'licenses.manage'], active: true })
    await setDoc(doc(d, 'admins', 'devonly'), { email: 'd@x.com', role: 'custom', permissions: ['devices.manage'], active: true })
    await setDoc(doc(d, 'admins', 'generator'), { email: 'g@x.com', role: 'custom', permissions: ['licenses.generate'], active: true })
  })
  st.db = env.authenticatedContext('owner', { email: 'digitaltarget.digital@gmail.com' }).firestore()
}, 60_000)
afterAll(async () => {
  await env?.cleanup()
})

const ctxOf = (uid: string) => env.authenticatedContext(uid, { email: `${uid}@x.com` }).firestore() as unknown as Firestore

async function signingKey() {
  const { generateKeyPairSync } = await import('node:crypto')
  const { privateKey } = generateKeyPairSync('ed25519')
  const { loadKey } = await import('../src/lib/crypto')
  return loadKey(privateKey.export({ type: 'pkcs8', format: 'pem' }).toString())
}

async function seedLicense(id: string, key: string, o: Record<string, unknown> = {}) {
  await env.withSecurityRulesDisabled(async (c) => {
    const d = admin(c)
    await setDoc(doc(d, 'licenses', id), {
      licenseKey: key, businessName: `Biz ${id}`, customerName: 'Cust', plan: 'standard', planType: 'yearly', status: 'active', maxDevices: 2, maxFirms: 1, maxUsers: 3,
      features: [], activeDevices: 0, expiresAt: Timestamp.fromMillis(Date.now() + 86400e3 * 100), activatedAt: null, devicesSummary: {}, createdAt: Timestamp.now(), updatedAt: Timestamp.now(), ...o
    })
    await setDoc(doc(d, 'licenseStatus', id), { status: 'active', deactivatedDevices: [], updatedAt: Timestamp.now() })
  })
}

const DEV = (n: string) => `${n}-0000-1111-2222-3333`

describe.runIf(run)('operations on the emulator (real rules, portal code)', () => {
  it('approving a request is ONE transaction: slot, device, certificate in licenseStatus and the request answer together', async () => {
    const { approveRequest } = await import('../src/lib/approve')
    const { requestFromSnap, requestRef } = await import('../src/lib/licenses')
    const { verifyCode } = await import('../src/lib/crypto')
    const key = await signingKey()
    await seedLicense('ap1', 'DTSP-APPR-AAAA-BBBB-CCCC')
    await env.withSecurityRulesDisabled(async (c) =>
      setDoc(doc(admin(c), 'activationRequests', 'reqApprove000000000000001'), { type: 'activate', licenseKey: 'DTSP-APPR-AAAA-BBBB-CCCC', deviceId: DEV('APPR'), deviceName: 'PC-1', appVersion: '1.3.0', os: 'Windows 11', status: 'pending', createdAt: Timestamp.now() })
    )
    const req = requestFromSnap(await getDoc(requestRef('reqApprove000000000000001')))
    st.tx = 0
    st.getDocs = 0
    st.getDoc = 0
    expect(await approveRequest(req, key, 'owner@test')).toBe('approved')
    // 1 license lookup by key + 1 transaction; no separate reads or follow-up writes
    expect({ tx: st.tx, getDocs: st.getDocs, getDoc: st.getDoc }).toEqual({ tx: 1, getDocs: 1, getDoc: 0 })
    const d = admin({ firestore: () => st.db })
    const r = (await getDoc(doc(d, 'activationRequests', 'reqApprove000000000000001'))).data()!
    const s = (await getDoc(doc(d, 'licenseStatus', 'ap1'))).data()!
    expect(r.status).toBe('approved')
    expect(typeof r.certificate).toBe('string')
    expect(s.certs[DEV('APPR')]).toBe(r.certificate)
    expect(await verifyCode(r.certificate, key.publicKey)).toBe(true)
    const l = (await getDoc(doc(d, 'licenses', 'ap1'))).data()!
    expect(l.activeDevices).toBe(1)
    expect(l.devicesSummary[DEV('APPR')].status).toBe('active')
    expect((await getDoc(doc(d, 'licenses', 'ap1', 'devices', DEV('APPR')))).data()!.status).toBe('active')
    // an answered request is not answered twice
    expect(await approveRequest(req, key, 'owner@test')).toBe('processed')
  })

  it('approving with the license already known needs no lookup query at all, and a wrong key is still refused', async () => {
    const { approveRequest } = await import('../src/lib/approve')
    const { requestFromSnap, requestRef } = await import('../src/lib/licenses')
    const key = await signingKey()
    await seedLicense('ap2', 'DTSP-APP2-AAAA-BBBB-CCCC')
    const seedReq = async (id: string, licenseKey: string, dev: string) =>
      env.withSecurityRulesDisabled(async (c) => setDoc(doc(admin(c), 'activationRequests', id), { type: 'activate', licenseKey, deviceId: DEV(dev), deviceName: 'PC', appVersion: '1.3.0', os: 'Windows 11', status: 'pending', createdAt: Timestamp.now() }))
    await seedReq('reqApprove000000000000002', 'DTSP-APP2-AAAA-BBBB-CCCC', 'APP2')
    const req = requestFromSnap(await getDoc(requestRef('reqApprove000000000000002')))
    st.tx = 0
    st.getDocs = 0
    expect(await approveRequest(req, key, 'owner@test', { licenseId: 'ap2' })).toBe('approved')
    expect({ tx: st.tx, getDocs: st.getDocs }).toEqual({ tx: 1, getDocs: 0 })
    // a hint pointing at another license cannot approve a key that is not that license's
    await seedReq('reqApprove000000000000003', 'DTSP-ZZZZ-AAAA-BBBB-CCCC', 'APP3')
    const bad = requestFromSnap(await getDoc(requestRef('reqApprove000000000000003')))
    expect(await approveRequest(bad, key, 'owner@test', { licenseId: 'ap2' })).toBe('rejected')
    expect((await getDoc(doc(admin({ firestore: () => st.db }), 'licenses', 'ap2'))).data()!.activeDevices).toBe(1)
  })

  it('reactivating a computer publishes its certificate in the same transaction and clears the block', async () => {
    const { setDeviceState, deviceFromSnap } = await import('../src/lib/licenses')
    const { deviceCertSigner } = await import('../src/lib/approve')
    const { verifyCode } = await import('../src/lib/crypto')
    const key = await signingKey()
    await seedLicense('re1', 'DTSP-REAC-AAAA-BBBB-CCCC', { activeDevices: 1, devicesSummary: { [DEV('REAC')]: { deviceName: 'PC', os: '', appVersion: '', status: 'suspended', activatedAt: null, activationType: 'online', statusNote: '' } } })
    await env.withSecurityRulesDisabled(async (c) => {
      await setDoc(doc(admin(c), 'licenses', 're1', 'devices', DEV('REAC')), { deviceId: DEV('REAC'), deviceName: 'PC', status: 'suspended', activationType: 'online' })
      await updateDoc(doc(admin(c), 'licenseStatus', 're1'), { deactivatedDevices: [DEV('REAC')] })
    })
    st.tx = 0
    await setDeviceState('re1', DEV('REAC'), 'reactivate', '', 'owner@test', deviceCertSigner(key, DEV('REAC')))
    expect(st.tx).toBe(1)
    const d = admin({ firestore: () => st.db })
    const s = (await getDoc(doc(d, 'licenseStatus', 're1'))).data()!
    expect(s.deactivatedDevices).toEqual([])
    expect(await verifyCode(s.certs[DEV('REAC')], key.publicKey)).toBe(true)
    expect(deviceFromSnap(await getDoc(doc(d, 'licenses', 're1', 'devices', DEV('REAC')))).status).toBe('active')
  })

  it('Clear chat keeps the conversation, Delete chat removes it; only support + audit management may do either', async () => {
    const { clearChat, deleteChat, threadFromSnap, messagesCol, threadRef } = await import('../src/lib/support')
    const T = 'T'.repeat(40)
    const seedThread = async (id: string, n: number) =>
      env.withSecurityRulesDisabled(async (c) => {
        const d = admin(c)
        await setDoc(doc(d, 'supportThreads', id), { deviceId: DEV('CHAT'), licenseId: 'x', companyName: 'WETCO', contactName: 'Ali', phone: '1', status: 'open', lastMessageAt: Timestamp.now(), lastMessageFrom: 'customer', lastMessagePreview: 'hello', unreadByAdmin: true, unreadByCustomer: false, createdAt: Timestamp.now() })
        for (let i = 0; i < n; i++) await setDoc(doc(d, 'supportThreads', id, 'messages', `m${String(i).padStart(8, '0')}`), { from: i % 2 ? 'admin' : 'customer', body: `message ${i}`, authorName: 'x', at: Timestamp.now() })
      })
    await seedThread(T, 6)
    const d = admin({ firestore: () => st.db })
    const thread = threadFromSnap(await getDoc(threadRef(T)))
    // rules: a support agent without audit.manage may reply but not clear or delete
    const sup = ctxOf('supporter')
    await expect(deleteDoc(doc(sup, 'supportThreads', T, 'messages', 'm00000000'))).rejects.toThrow()
    await expect(deleteDoc(doc(sup, 'supportThreads', T))).rejects.toThrow()
    expect(await clearChat(thread, 'owner@test')).toBe(6)
    expect((await getDocs(messagesCol(T))).size).toBe(0)
    const kept = (await getDoc(doc(d, 'supportThreads', T))).data()!
    expect(kept.companyName).toBe('WETCO')
    expect(kept.lastMessagePreview).toBe('')
    // more than one batch (450 > 400)
    const U = 'U'.repeat(40)
    await seedThread(U, 450)
    expect(await deleteChat(threadFromSnap(await getDoc(threadRef(U))), 'owner@test')).toBe(450)
    expect((await getDoc(doc(d, 'supportThreads', U))).exists()).toBe(false)
    expect((await getDocs(collection(d, 'supportThreads', U, 'messages'))).size).toBe(0)
  }, 60_000)

  it('Clear all deletes every non-security activity entry and archives the security trail; nothing else is touched and the clean-up itself is recorded', async () => {
    const { planClearAllActivity, runClearAllActivity } = await import('../src/lib/clearing')
    const { auditCol } = await import('../src/lib/licenses')
    await env.withSecurityRulesDisabled(async (c) => {
      const d = admin(c)
      for (let i = 0; i < 30; i++) await setDoc(doc(d, 'auditLogs', `a${i}`), { action: 'x', category: ['license', 'client', 'device', 'financial', 'support'][i % 5], by: 'o', byUid: 'owner', target: '', details: '', status: 'success', archived: false, at: Timestamp.fromMillis(Date.now() - i * 1000) })
      for (let i = 0; i < 3; i++) await setDoc(doc(d, 'auditLogs', `s${i}`), { action: 'admin_signed_in', category: 'security', by: 'o', byUid: 'owner', target: '', details: '', status: 'success', archived: false, at: Timestamp.fromMillis(Date.now() - i * 1000) })
      await setDoc(doc(d, 'clients', 'c1'), { company: 'Keep me', status: 'active' })
    })
    const plan = await planClearAllActivity()
    expect(plan.refs.length).toBeGreaterThanOrEqual(30)
    // protected security entries are archived (hidden from every list and count), never deleted
    expect(plan.archiveRefs?.length ?? 0).toBeGreaterThanOrEqual(3)
    expect(plan.kept).toBe(plan.archiveRefs?.length ?? 0)
    expect(await runClearAllActivity(plan)).toBe(plan.refs.length + (plan.archiveRefs?.length ?? 0))
    const left = (await getDocs(auditCol())).docs.map((x) => x.data())
    // nothing but security entries is left, every one of them archived except the new record of the clean-up itself
    expect(left.every((x) => x.category === 'security')).toBe(true)
    const record = left.filter((x) => x.action === 'audit_cleared' && x.archived === false)
    expect(record.length).toBe(1)
    expect(String(record[0].details)).toMatch(/security entr(y|ies) archived/)
    expect(left.filter((x) => x.archived === false).length).toBe(1)
    expect(left.filter((x) => x.archived === true).length).toBeGreaterThanOrEqual(3)
    // a second run finds nothing left to delete or archive except the clean-up record's own archive
    const again = await planClearAllActivity()
    expect(again.refs.length).toBe(0)
    const d = admin({ firestore: () => st.db })
    expect((await getDoc(doc(d, 'clients', 'c1'))).exists()).toBe(true)
    expect((await getDoc(doc(d, 'licenses', 'ap1'))).exists()).toBe(true)
    // a security entry can never be deleted from the portal
    await expect(deleteDoc(doc(d, 'auditLogs', 's0'))).rejects.toThrow()
  }, 60_000)

  it('the same activity entry written twice within seconds is one entry', async () => {
    const { logActivity } = await import('../src/lib/audit')
    const { auditCol } = await import('../src/lib/licenses')
    const mark = `dup-${Date.now()}`
    await Promise.all([logActivity({ action: 'dup_test', category: 'general', target: mark, details: 'same' }), logActivity({ action: 'dup_test', category: 'general', target: mark, details: 'same' })])
    await logActivity({ action: 'dup_test', category: 'general', target: mark, details: 'same' })
    const n = (await getDocs(auditCol())).docs.filter((x) => x.data().target === mark).length
    expect(n).toBe(1)
    await logActivity({ action: 'dup_test', category: 'general', target: mark, details: 'different' })
    expect((await getDocs(auditCol())).docs.filter((x) => x.data().target === mark).length).toBe(2)
  })

  it('Administrator password reset: published for one computer, signed, authorised by device + license management, withdrawable', async () => {
    const { issueAdminPasswordReset, cancelAdminPasswordReset } = await import('../src/lib/passwordReset')
    const { licenseFromSnap, licenseRef } = await import('../src/lib/licenses')
    const { verifyCommandCode, verifyCode } = await import('../src/lib/crypto')
    const key = await signingKey()
    await seedLicense('pw1', 'DTSP-PWRE-AAAA-BBBB-CCCC')
    const lic = licenseFromSnap(await getDoc(licenseRef('pw1')))
    const cmd = await issueAdminPasswordReset(lic, { deviceId: DEV('PWRE'), deviceName: 'PC' }, key, 'owner@test')
    const d = admin({ firestore: () => st.db })
    const pub = (await getDoc(doc(d, 'licenseStatus', 'pw1'))).data()!
    expect(pub.commands[DEV('PWRE')]).toBe(cmd.code)
    expect(await verifyCommandCode(cmd.code, key.publicKey)).toBe(true)
    // the command is NOT a license certificate (domain separation)
    expect(await verifyCode(cmd.code, key.publicKey)).toBe(false)
    // no plaintext password anywhere in Firestore
    const dump = JSON.stringify([(await getDocs(collection(d, 'licenses', 'pw1', 'history'))).docs.map((x) => x.data()), pub])
    expect(dump).not.toContain(cmd.password)
    expect(dump).not.toContain(cmd.password.replace(/-/g, ''))
    // security log entry (protected category)
    const logs = (await getDocs(collection(d, 'auditLogs'))).docs.map((x) => x.data()).filter((x) => x.action === 'admin_password_reset_issued')
    expect(logs).toHaveLength(1)
    expect(logs[0].category).toBe('security')
    // rules: only device + license management together may set `commands`; other licenseStatus writes stay as before
    const set = (uid: string, data: Record<string, unknown>) => setDoc(doc(ctxOf(uid), 'licenseStatus', 'pw1'), { ...data, updatedAt: serverTimestamp() }, { merge: true })
    await expect(set('devonly', { commands: { [DEV('PWRE')]: 'forged' } })).rejects.toThrow()
    await expect(set('generator', { commands: { [DEV('PWRE')]: 'forged' } })).rejects.toThrow()
    await expect(set('supporter', { status: 'active' })).rejects.toThrow()
    await set('devonly', { poweredBy: true })
    await set('both', { commands: { [DEV('PWRE')]: cmd.code } })
    // withdrawn
    await cancelAdminPasswordReset(lic, { deviceId: DEV('PWRE'), deviceName: 'PC' }, 'owner@test')
    expect(((await getDoc(doc(d, 'licenseStatus', 'pw1'))).data()!.commands ?? {})[DEV('PWRE')]).toBeUndefined()
  })

  it('heartbeats may carry the location note and the reset progress (and nothing else new)', async () => {
    const anon = env.unauthenticatedContext().firestore() as unknown as Firestore
    const token = 'H'.repeat(40)
    const base = { deviceId: DEV('HBHB'), licenseId: '', deviceName: 'PC', os: 'Windows', appVersion: '1.3.0', companyName: 'WETCO', mode: 'active', lastCheckAt: '', firms: 1, users: 2, lastSeen: serverTimestamp() }
    await setDoc(doc(anon, 'heartbeats', token), { ...base, locationNote: 'Location sharing is turned off on this computer.', resetState: 'abc123:received' })
    await expect(setDoc(doc(anon, 'heartbeats', token), { ...base, isAdmin: true })).rejects.toThrow()
    await expect(setDoc(doc(anon, 'heartbeats', token), { ...base, resetState: 'x'.repeat(200) })).rejects.toThrow()
  })
})
