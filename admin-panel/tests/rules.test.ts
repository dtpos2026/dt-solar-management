/**
 * Firestore security rules suite (admin-panel/firestore.rules) — run under the Firestore emulator:
 *   npm run test:rules        (needs firebase-tools installed globally: npm i -g firebase-tools, and Java)
 * Every collection in DATA_MODEL.md is covered for: owner, each preset role, an admins.manage delegate,
 * a disabled admin, a signed-in non-admin and the unauthenticated desktop client (REST shapes + forged writes).
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  type RulesTestEnvironment
} from '@firebase/rules-unit-testing'
import {
  Timestamp,
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  serverTimestamp,
  setDoc,
  updateDoc,
  type Firestore
} from 'firebase/firestore'
import { ROLE_PRESETS } from '../src/lib/perm'

const OWNER_EMAIL = 'digitaltarget.digital@gmail.com'
const ROLES = ['manager', 'sales', 'billing', 'support', 'technical', 'custom'] as const
const ACTORS = ['owner', ...ROLES, 'disabled', 'stranger', 'anon'] as const
type Actor = (typeof ACTORS)[number]

const KEY = 'DTSP-AB12-CD34-EF56-GH78'
const TOKEN = 'T'.repeat(40) // installToken (≥ 32 chars)
const LIC = 'lic1'

let env: RulesTestEnvironment
let seq = 0
const uid = () => `x${Date.now().toString(36)}${(seq++).toString(36)}`.padEnd(30, '0')

function db(actor: Actor | 'delegate'): Firestore {
  if (actor === 'anon') return env.unauthenticatedContext().firestore() as unknown as Firestore
  const email = actor === 'owner' ? OWNER_EMAIL : `${actor}@example.com`
  return env.authenticatedContext(actor, { email }).firestore() as unknown as Firestore
}

/** Runs op for every actor; succeeds exactly for `allowed`. */
async function matrix(allowed: Actor[], op: (d: Firestore, a: Actor) => Promise<unknown>) {
  for (const a of ACTORS) {
    const p = op(db(a), a)
    try {
      if (allowed.includes(a)) await assertSucceeds(p)
      else await assertFails(p)
    } catch (e) {
      throw new Error(`actor "${a}" expected ${allowed.includes(a) ? 'ALLOW' : 'DENY'}: ${(e as Error).message}`)
    }
  }
}

const ADMINS_READ: Actor[] = ['owner', ...ROLES]
const old = () => Timestamp.fromMillis(Date.now() - 100 * 86400000)

function heartbeat(extra: Record<string, unknown> = {}) {
  return {
    deviceId: 'DEVICE-0000000001', licenseId: LIC, deviceName: 'PC', os: 'Windows 11', appVersion: '1.1.0',
    companyName: 'Sun Co', mode: 'licensed', lastCheckAt: new Date().toISOString(), firms: 1, users: 2,
    lastSeen: serverTimestamp(), ...extra
  }
}
function thread(extra: Record<string, unknown> = {}) {
  return {
    deviceId: 'DEVICE-0000000001', licenseId: LIC, companyName: 'Sun Co', contactName: 'Ali', phone: '0300',
    status: 'open', lastMessageAt: serverTimestamp(), lastMessageFrom: 'customer', lastMessagePreview: 'Hi',
    unreadByAdmin: true, unreadByCustomer: false, createdAt: serverTimestamp(), ...extra
  }
}
function activation(extra: Record<string, unknown> = {}) {
  return {
    type: 'activate', licenseKey: KEY, licenseId: LIC, deviceId: 'DEVICE-0000000001', deviceName: 'PC',
    appVersion: '1.1.0', os: 'Windows', status: 'pending', createdAt: serverTimestamp(),
    companyName: 'Sun Co', ownerName: 'Ali', phone: '0300', address: 'Lahore', installToken: TOKEN, ...extra
  }
}
function invoice(extra: Record<string, unknown> = {}) {
  return {
    number: 'INV-1', clientId: 'c1', total: 100, paid: 0, balance: 100, status: 'unpaid',
    lines: [{ kind: 'plan', description: 'Plan', qty: 1, rate: 100, amount: 100 }], verifyToken: 'V'.repeat(32), ...extra
  }
}

beforeAll(async () => {
  env = await initializeTestEnvironment({
    projectId: 'dt-rules-test',
    firestore: { rules: readFileSync(resolve(__dirname, '../firestore.rules'), 'utf8') }
  })
})
afterAll(async () => { await env?.cleanup() })

beforeEach(async () => {
  await env.clearFirestore()
  await env.withSecurityRulesDisabled(async (ctx) => {
    const d = ctx.firestore()
    await setDoc(doc(d, 'admins/owner'), { email: OWNER_EMAIL, role: 'owner', permissions: [], active: true })
    for (const r of ROLES) await setDoc(doc(d, `admins/${r}`), { email: `${r}@example.com`, role: r, permissions: ROLE_PRESETS[r].permissions, active: true })
    await setDoc(doc(d, 'admins/disabled'), { email: 'disabled@example.com', role: 'manager', permissions: ROLE_PRESETS.manager.permissions, active: false })
    await setDoc(doc(d, 'admins/delegate'), { email: 'delegate@example.com', role: 'custom', permissions: ['admins.manage'], active: true })
    await setDoc(doc(d, 'clients/c1'), { company: 'Sun Co', status: 'active' })
    await setDoc(doc(d, `licenses/${LIC}`), { licenseKey: KEY, status: 'active', activeDevices: 0, maxDevices: 1 })
    await setDoc(doc(d, `licenses/${LIC}/devices/d1`), { deviceId: 'd1' })
    await setDoc(doc(d, `licenses/${LIC}/history/h1`), { action: 'created' })
    await setDoc(doc(d, `licenseStatus/${LIC}`), { status: 'active', deactivatedDevices: [] })
    await setDoc(doc(d, `activationRequests/${'R'.repeat(28)}`), activation({ createdAt: Timestamp.now() }))
    await setDoc(doc(d, `heartbeats/${TOKEN}`), heartbeat({ lastSeen: Timestamp.now() }))
    await setDoc(doc(d, `supportThreads/${TOKEN}`), thread({ lastMessageAt: Timestamp.now(), createdAt: Timestamp.now() }))
    await setDoc(doc(d, `supportThreads/${TOKEN}/messages/m0000001`), { from: 'customer', body: 'Hi', at: Timestamp.now() })
    await setDoc(doc(d, 'invoices/i1'), invoice())
    await setDoc(doc(d, 'invoices/i1/payments/p1'), { amount: 10 })
    await setDoc(doc(d, `publicInvoices/${'V'.repeat(32)}`), { number: 'INV-1', status: 'valid' })
    await setDoc(doc(d, 'counters/invoices'), { next: 2 })
    await setDoc(doc(d, 'settings/branding'), { companyName: 'Digital Target' })
    await setDoc(doc(d, 'publicSettings/branding'), { companyName: 'Digital Target' })
    await setDoc(doc(d, 'auditLogs/oldGeneral'), { action: 'x', category: 'general', at: old(), archived: false })
    await setDoc(doc(d, 'auditLogs/oldSecurity'), { action: 'x', category: 'security', at: old(), archived: false })
    await setDoc(doc(d, 'auditLogs/oldLegacy'), { action: 'license.create', at: old(), archived: false })
    await setDoc(doc(d, 'auditLogs/newGeneral'), { action: 'x', category: 'general', at: Timestamp.now(), archived: false })
  })
})

/* ------------------------------------------------ admins ------------------------------------------------ */
describe('admins', () => {
  it('get: own record or any active admin; list: admins.manage', async () => {
    await matrix(['owner', ...ROLES, 'disabled'], (d, a) => getDoc(doc(d, `admins/${a === 'anon' || a === 'stranger' ? 'owner' : a}`)))
    await assertSucceeds(getDoc(doc(db('stranger'), 'admins/stranger')))
    await matrix(['owner'], (d) => getDocs(collection(d, 'admins')))
    await assertSucceeds(getDocs(collection(db('delegate'), 'admins')))
  })
  it('create: owner creates anyone; delegate only non-privileged; bootstrap by owner e-mail only', async () => {
    await matrix(['owner'], (d) => setDoc(doc(d, `admins/${uid()}`), { email: 'n@x.com', role: 'sales', permissions: ['clients.view'], active: true }))
    const del = db('delegate')
    await assertSucceeds(setDoc(doc(del, 'admins/n1'), { role: 'sales', permissions: ['clients.view'], active: true }))
    await assertFails(setDoc(doc(del, 'admins/n2'), { role: 'owner', permissions: [], active: true }))
    await assertFails(setDoc(doc(del, 'admins/n3'), { role: 'custom', permissions: ['admins.manage'], active: true }))
    await env.withSecurityRulesDisabled((c) => deleteDoc(doc(c.firestore(), 'admins/owner')))
    await assertSucceeds(setDoc(doc(db('owner'), 'admins/owner'), { email: OWNER_EMAIL, role: 'owner', permissions: [], active: true }))
    await assertFails(setDoc(doc(db('stranger'), 'admins/stranger'), { role: 'owner', permissions: [], active: true }))
  })
  it('update: nobody escalates themselves; only owners touch owners / admins.manage', async () => {
    await assertSucceeds(updateDoc(doc(db('manager'), 'admins/manager'), { name: 'M' }))
    await assertFails(updateDoc(doc(db('manager'), 'admins/manager'), { permissions: ['admins.manage'] }))
    await assertFails(updateDoc(doc(db('owner'), 'admins/owner'), { role: 'sales' }))
    await assertFails(updateDoc(doc(db('disabled'), 'admins/disabled'), { active: true }))
    await assertSucceeds(updateDoc(doc(db('owner'), 'admins/sales'), { permissions: ['admins.manage'] }))
    await assertSucceeds(updateDoc(doc(db('delegate'), 'admins/support'), { active: false }))
    await assertFails(updateDoc(doc(db('delegate'), 'admins/owner'), { active: false }))
    await assertFails(updateDoc(doc(db('delegate'), 'admins/billing'), { permissions: ['admins.manage'] }))
    await assertFails(updateDoc(doc(db('delegate'), 'admins/billing'), { role: 'owner' }))
    await assertFails(updateDoc(doc(db('manager'), 'admins/sales'), { active: false }))
  })
  it('delete: owner only, never self', async () => {
    await matrix(['owner'], (d, a) => deleteDoc(doc(d, `admins/${a === 'owner' ? 'custom' : 'support'}`)))
    await assertFails(deleteDoc(doc(db('owner'), 'admins/owner')))
    await assertFails(deleteDoc(doc(db('delegate'), 'admins/sales')))
  })
})

/* ------------------------------------------------ clients / licenses ------------------------------------------------ */
describe('clients', () => {
  it('read clients.view, write clients.manage, delete owner', async () => {
    await matrix(ADMINS_READ.filter((a) => a !== 'custom'), (d) => getDoc(doc(d, 'clients/c1')))
    await matrix(['owner', 'manager', 'sales'], (d) => setDoc(doc(d, `clients/${uid()}`), { company: 'A', status: 'active' }))
    await assertFails(setDoc(doc(db('owner'), 'clients/bad'), { company: 'A', status: 'deleted' }))
    await matrix(['owner'], (d, a) => deleteDoc(doc(d, a === 'owner' ? 'clients/c1' : 'clients/zz')))
  })
})

describe('licenses', () => {
  const readers: Actor[] = ['owner', 'manager', 'sales', 'billing', 'support', 'technical']
  it('read / create / update / delete', async () => {
    await matrix(readers, (d) => getDoc(doc(d, `licenses/${LIC}`)))
    await matrix(['owner', 'manager', 'sales', 'technical'], (d) => setDoc(doc(d, `licenses/${uid()}`), { licenseKey: KEY, status: 'active' }))
    await assertFails(setDoc(doc(db('owner'), 'licenses/bad'), { licenseKey: 'dtsp-1234', status: 'active' }))
    await assertFails(setDoc(doc(db('owner'), 'licenses/bad2'), { licenseKey: KEY, status: 'expired' }))
    await matrix(['owner', 'manager', 'technical'], async (d) => {
      await env.withSecurityRulesDisabled((c) => updateDoc(doc(c.firestore(), `licenses/${LIC}`), { status: 'active' }))
      return updateDoc(doc(d, `licenses/${LIC}`), { status: 'suspended' })
    })
    await assertSucceeds(updateDoc(doc(db('sales'), `licenses/${LIC}`), { activeDevices: 1 }))
    await assertFails(updateDoc(doc(db('owner'), `licenses/${LIC}`), { licenseKey: 'DTSP-0000-0000-0000-0000' }))
    await matrix(['owner'], (d, a) => deleteDoc(doc(d, a === 'owner' ? `licenses/${LIC}` : 'licenses/none')))
  })
  it('devices / history subcollections', async () => {
    await matrix(['owner', 'manager', 'sales', 'billing', 'support', 'technical'], (d) => getDoc(doc(d, `licenses/${LIC}/devices/d1`)))
    await matrix(['owner', 'manager', 'technical'], (d) => setDoc(doc(d, `licenses/${LIC}/devices/${uid()}`), { deviceId: 'x' }))
    await matrix(['owner', 'manager', 'sales', 'technical'], (d) => setDoc(doc(d, `licenses/${LIC}/history/${uid()}`), { action: 'x' }))
    await assertFails(updateDoc(doc(db('owner'), `licenses/${LIC}/history/h1`), { action: 'forged' }))
    await assertFails(deleteDoc(doc(db('owner'), `licenses/${LIC}/history/h1`)))
  })
  it('licenseStatus: public get, no public list or write', async () => {
    await matrix([...ACTORS], (d) => getDoc(doc(d, `licenseStatus/${LIC}`)))
    await assertFails(getDocs(collection(db('anon'), 'licenseStatus')))
    await matrix(['owner', 'manager', 'sales', 'technical'], (d) => setDoc(doc(d, `licenseStatus/${LIC}`), { status: 'active' }, { merge: true }))
  })
})

/* ------------------------------------------------ desktop → cloud ------------------------------------------------ */
describe('activationRequests (desktop REST, unauthenticated)', () => {
  it('desktop creates a pending request with registration fields and reads it back by id', async () => {
    const anon = db('anon')
    const id = 'A'.repeat(28)
    await assertSucceeds(setDoc(doc(anon, `activationRequests/${id}`), activation()))
    await assertSucceeds(getDoc(doc(anon, `activationRequests/${id}`)))
    await assertSucceeds(setDoc(doc(anon, `activationRequests/${'D'.repeat(28)}`), { type: 'deactivate', deviceId: 'DEVICE-0000000001', licenseId: LIC, status: 'pending', createdAt: serverTimestamp() }))
  })
  it('forged requests are rejected', async () => {
    const anon = db('anon')
    await assertFails(setDoc(doc(anon, `activationRequests/${'B'.repeat(28)}`), activation({ status: 'approved' })))
    await assertFails(setDoc(doc(anon, `activationRequests/${'C'.repeat(28)}`), activation({ certificate: 'forged' })))
    await assertFails(setDoc(doc(anon, 'activationRequests/short'), activation()))
    await assertFails(setDoc(doc(anon, `activationRequests/${'E'.repeat(28)}`), activation({ licenseKey: 'NOPE' })))
    await assertFails(setDoc(doc(anon, `activationRequests/${'F'.repeat(28)}`), activation({ deviceId: 'short' })))
    await assertFails(setDoc(doc(anon, `activationRequests/${'G'.repeat(28)}`), activation({ address: 'x'.repeat(301) })))
    await assertFails(updateDoc(doc(anon, `activationRequests/${'R'.repeat(28)}`), { status: 'approved' }))
    await assertFails(getDocs(collection(anon, 'activationRequests')))
  })
  it('admins with devices.manage / licenses.manage process requests', async () => {
    await matrix(['owner', 'manager', 'technical'], (d) => getDocs(collection(d, 'activationRequests')))
    await matrix(['owner', 'manager', 'technical'], (d) => updateDoc(doc(d, `activationRequests/${'R'.repeat(28)}`), { status: 'approved' }))
  })
})

describe('heartbeats (desktop REST, unauthenticated)', () => {
  it('valid heartbeat with consented location is accepted (create + update)', async () => {
    const anon = db('anon')
    const tok = 'H'.repeat(40)
    await assertSucceeds(setDoc(doc(anon, `heartbeats/${tok}`), heartbeat()))
    await assertSucceeds(setDoc(doc(anon, `heartbeats/${tok}`), heartbeat({
      location: { lat: 31.5, lng: 74.3, accuracyKm: 25, source: 'approximate', label: 'Lahore', consent: true, updatedAt: new Date().toISOString() }
    })))
    await assertSucceeds(setDoc(doc(anon, `heartbeats/${tok}`), heartbeat({ location: null })))
  })
  it('forged heartbeats are rejected', async () => {
    const anon = db('anon')
    const tok = 'J'.repeat(40)
    await assertFails(setDoc(doc(anon, `heartbeats/${tok}`), heartbeat({ lastSeen: Timestamp.fromMillis(Date.now() + 864e5) })))
    await assertFails(setDoc(doc(anon, `heartbeats/${tok}`), heartbeat({ admin: true })))
    await assertFails(setDoc(doc(anon, 'heartbeats/shorttoken'), heartbeat()))
    await assertFails(setDoc(doc(anon, `heartbeats/${tok}`), heartbeat({ firms: 'many' })))
    await assertFails(setDoc(doc(anon, `heartbeats/${tok}`), heartbeat({ location: { lat: 31, lng: 74, source: 'gps', consent: true } })))
    await assertFails(setDoc(doc(anon, `heartbeats/${tok}`), heartbeat({ location: { lat: 31, lng: 74, source: 'manual', consent: false } })))
    await assertFails(setDoc(doc(anon, `heartbeats/${tok}`), heartbeat({ location: { lat: 99, lng: 74, source: 'manual', consent: true } })))
  })
  it('read: device / license viewers; delete: devices.manage', async () => {
    await matrix(['owner', 'manager', 'sales', 'billing', 'support', 'technical'], (d) => getDoc(doc(d, `heartbeats/${TOKEN}`)))
    await matrix(['owner', 'manager', 'sales', 'billing', 'support', 'technical'], (d) => getDocs(collection(d, 'heartbeats')))
    await matrix(['owner', 'manager', 'technical'], (d) => deleteDoc(doc(d, `heartbeats/${uid()}`)))
  })
})

describe('supportThreads + messages (desktop REST, unauthenticated)', () => {
  it('customer opens a thread, posts, reads replies', async () => {
    const anon = db('anon')
    const tok = 'S'.repeat(40)
    await assertSucceeds(setDoc(doc(anon, `supportThreads/${tok}`), thread()))
    await assertSucceeds(updateDoc(doc(anon, `supportThreads/${tok}`), { lastMessageAt: serverTimestamp(), lastMessagePreview: 'Again', unreadByAdmin: true }))
    await assertSucceeds(updateDoc(doc(anon, `supportThreads/${TOKEN}`), { unreadByCustomer: false }))
    await assertSucceeds(setDoc(doc(anon, `supportThreads/${tok}/messages/m1234567`), { from: 'customer', body: 'Help', authorName: 'Ali', at: serverTimestamp() }))
    await assertSucceeds(getDocs(collection(anon, `supportThreads/${TOKEN}/messages`)))
    await assertSucceeds(getDoc(doc(anon, `supportThreads/${TOKEN}`)))
  })
  it('forged customer writes are rejected', async () => {
    const anon = db('anon')
    await assertFails(setDoc(doc(anon, `supportThreads/${'U'.repeat(40)}`), thread({ status: 'resolved' })))
    await assertFails(setDoc(doc(anon, `supportThreads/${'U'.repeat(40)}`), thread({ lastMessageFrom: 'admin' })))
    await assertFails(setDoc(doc(anon, 'supportThreads/short'), thread()))
    await assertFails(updateDoc(doc(anon, `supportThreads/${TOKEN}`), { status: 'resolved' }))
    await assertFails(updateDoc(doc(anon, `supportThreads/${TOKEN}`), { lastMessageFrom: 'admin' }))
    await assertFails(updateDoc(doc(anon, `supportThreads/${TOKEN}`), { unreadByAdmin: false }))
    await assertFails(setDoc(doc(anon, `supportThreads/${TOKEN}/messages/m7654321`), { from: 'admin', body: 'Fake', at: serverTimestamp() }))
    await assertFails(setDoc(doc(anon, `supportThreads/${TOKEN}/messages/m7654322`), { from: 'customer', body: 'x', at: Timestamp.now() }))
    await assertFails(setDoc(doc(anon, `supportThreads/${TOKEN}/messages/m7654323`), { from: 'customer', body: '', at: serverTimestamp() }))
    await assertFails(setDoc(doc(anon, `supportThreads/${TOKEN}/messages/m7654324`), { from: 'customer', body: 'x'.repeat(4001), at: serverTimestamp() }))
    await assertFails(updateDoc(doc(anon, `supportThreads/${TOKEN}/messages/m0000001`), { body: 'edited' }))
    await assertFails(getDocs(collection(anon, 'supportThreads')))
  })
  it('support.manage admins list and reply', async () => {
    await matrix(['owner', 'manager', 'support'], (d) => getDocs(collection(d, 'supportThreads')))
    await matrix(['owner', 'manager', 'support'], (d) => setDoc(doc(d, `supportThreads/${TOKEN}/messages/${uid()}`), { from: 'admin', body: 'Reply', at: serverTimestamp() }))
    await matrix(['owner', 'manager', 'support'], async (d) => {
      await env.withSecurityRulesDisabled((c) => updateDoc(doc(c.firestore(), `supportThreads/${TOKEN}`), { status: 'open' }))
      return updateDoc(doc(d, `supportThreads/${TOKEN}`), { status: 'resolved' })
    })
  })
})

/* ------------------------------------------------ billing ------------------------------------------------ */
describe('invoices / payments / publicInvoices / counters', () => {
  it('invoices', async () => {
    await matrix(['owner', 'manager', 'sales', 'billing'], (d) => getDoc(doc(d, 'invoices/i1')))
    await matrix(['owner', 'manager', 'sales', 'billing'], (d) => setDoc(doc(d, `invoices/${uid()}`), invoice()))
    await assertFails(setDoc(doc(db('owner'), 'invoices/paid'), invoice({ paid: 100, balance: 0, status: 'paid' })))
    await assertFails(setDoc(doc(db('owner'), 'invoices/short'), invoice({ verifyToken: 'abc' })))
    await assertSucceeds(updateDoc(doc(db('billing'), 'invoices/i1'), { paid: 50, balance: 50, status: 'partial' }))
    await assertFails(updateDoc(doc(db('billing'), 'invoices/i1'), { paid: 500 }))
    await assertFails(updateDoc(doc(db('owner'), 'invoices/i1'), { number: 'INV-9' }))
    await assertFails(deleteDoc(doc(db('owner'), 'invoices/i1')))
  })
  it('payments append-only', async () => {
    await matrix(['owner', 'manager', 'billing'], (d) => setDoc(doc(d, `invoices/i1/payments/${uid()}`), { amount: 5 }))
    await assertFails(setDoc(doc(db('owner'), 'invoices/i1/payments/neg'), { amount: -5 }))
    await assertSucceeds(updateDoc(doc(db('billing'), 'invoices/i1/payments/p1'), { cancelled: true, cancelReason: 'typo' }))
    await assertFails(updateDoc(doc(db('billing'), 'invoices/i1/payments/p1'), { amount: 1 }))
    await assertFails(deleteDoc(doc(db('owner'), 'invoices/i1/payments/p1')))
  })
  it('publicInvoices: public get only', async () => {
    await matrix([...ACTORS], (d) => getDoc(doc(d, `publicInvoices/${'V'.repeat(32)}`)))
    await assertFails(getDocs(collection(db('owner'), 'publicInvoices')))
    await matrix(['owner', 'manager', 'sales', 'billing'], (d) => setDoc(doc(d, `publicInvoices/${'W'.repeat(32)}`), { status: 'valid' }))
    await assertFails(setDoc(doc(db('owner'), 'publicInvoices/short'), { status: 'valid' }))
    await assertFails(deleteDoc(doc(db('owner'), `publicInvoices/${'V'.repeat(32)}`)))
  })
  it('counters', async () => {
    await matrix(['owner', 'manager', 'sales', 'billing', 'technical'], (d) => setDoc(doc(d, 'counters/invoices'), { next: 3 }))
  })
})

/* ------------------------------------------------ settings ------------------------------------------------ */
describe('settings / publicSettings', () => {
  it('settings: active admins read, branding.manage writes', async () => {
    await matrix(ADMINS_READ, (d) => getDoc(doc(d, 'settings/branding')))
    await matrix(['owner'], (d) => setDoc(doc(d, 'settings/branding'), { companyName: 'DT' }, { merge: true }))
    await matrix(['owner'], (d) => setDoc(doc(d, 'settings/portal'), { sessionTimeoutMin: 30 }))
  })
  it('publicSettings: public get, no list, branding.manage writes', async () => {
    await matrix([...ACTORS], (d) => getDoc(doc(d, 'publicSettings/branding')))
    await assertFails(getDocs(collection(db('anon'), 'publicSettings')))
    await matrix(['owner'], (d) => setDoc(doc(d, 'publicSettings/branding'), { companyName: 'DT' }))
  })
})

/* ------------------------------------------------ audit log ------------------------------------------------ */
describe('auditLogs', () => {
  const entry = (byUid: string, extra: Record<string, unknown> = {}) => ({ action: 'x', category: 'general', by: 'e', byUid, status: 'success', at: serverTimestamp(), archived: false, ...extra })
  it('create: any active admin, as itself, at server time, not pre-archived', async () => {
    await matrix(ADMINS_READ, (d, a) => setDoc(doc(d, `auditLogs/${uid()}`), entry(a)))
    await assertFails(setDoc(doc(db('sales'), 'auditLogs/f1'), entry('owner')))
    await assertFails(setDoc(doc(db('sales'), 'auditLogs/f2'), entry('sales', { at: old() })))
    await assertFails(setDoc(doc(db('sales'), 'auditLogs/f3'), entry('sales', { archived: true })))
  })
  it('read: audit.view; archive: audit.manage (one-way)', async () => {
    await matrix(['owner', 'manager', 'technical'], (d) => getDocs(collection(d, 'auditLogs')))
    await matrix(['owner', 'manager'], (d) => updateDoc(doc(d, 'auditLogs/newGeneral'), { archived: true, archivedBy: 'x' }))
    await env.withSecurityRulesDisabled((c) => updateDoc(doc(c.firestore(), 'auditLogs/oldGeneral'), { archived: true }))
    await assertFails(updateDoc(doc(db('owner'), 'auditLogs/oldGeneral'), { archived: false }))
    await assertFails(updateDoc(doc(db('owner'), 'auditLogs/newGeneral'), { action: 'tampered' }))
  })
  it('delete: owner only, > 90 days, never security / financial / license / legacy', async () => {
    for (const a of ACTORS.filter((x) => x !== 'owner')) await assertFails(deleteDoc(doc(db(a), 'auditLogs/oldGeneral')))
    await assertSucceeds(deleteDoc(doc(db('owner'), 'auditLogs/oldGeneral')))
    await assertFails(deleteDoc(doc(db('owner'), 'auditLogs/oldSecurity')))
    await assertFails(deleteDoc(doc(db('owner'), 'auditLogs/oldLegacy')))
    await assertFails(deleteDoc(doc(db('owner'), 'auditLogs/newGeneral')))
  })
})

describe('disabled admin', () => {
  it('is blocked everywhere a live admin would be allowed', async () => {
    const d = db('disabled')
    for (const p of ['clients/c1', `licenses/${LIC}`, 'invoices/i1', 'settings/branding', `heartbeats/${TOKEN}`]) {
      await assertFails(getDoc(doc(d, p)))
    }
    await assertFails(setDoc(doc(d, 'auditLogs/dis'), entryFor('disabled')))
  })
})
function entryFor(byUid: string) { return { action: 'x', byUid, at: serverTimestamp(), archived: false } }

it('suite sanity', () => { expect(ACTORS.length).toBe(10) })
