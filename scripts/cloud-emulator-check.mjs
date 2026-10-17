#!/usr/bin/env node
/**
 * Proves that the desktop app's REAL Firestore REST calls are accepted by the REAL admin-panel/firestore.rules, and that
 * forged writes are rejected. Runs against the Firestore emulator.
 *
 *   node scripts/cloud-emulator-check.mjs
 *     → starts the emulator itself (firebase-tools: FIREBASE_BIN or `firebase` on PATH; port FIRESTORE_PORT, default 8093)
 *   FIRESTORE_EMULATOR_HOST=127.0.0.1:8093 node scripts/cloud-emulator-check.mjs
 *     → uses an emulator that is already running (with admin-panel/firestore.rules loaded)
 *
 * The app modules (license service, Firestore REST client, heartbeat, support sync) are bundled with esbuild from src/.
 */
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PROJECT = process.env.FIRESTORE_PROJECT || 'dt-soalr-mangement'

if (!process.env.FIRESTORE_EMULATOR_HOST) {
  const port = process.env.FIRESTORE_PORT || '8093'
  const dir = mkdtempSync(join(tmpdir(), 'cloud-emu-'))
  copyFileSync(join(root, 'admin-panel/firestore.rules'), join(dir, 'firestore.rules'))
  writeFileSync(join(dir, 'firebase.json'), JSON.stringify({ firestore: { rules: 'firestore.rules' }, emulators: { firestore: { host: '127.0.0.1', port: Number(port) }, ui: { enabled: false } } }))
  const bin = process.env.FIREBASE_BIN || 'firebase'
  const r = spawnSync(bin, ['emulators:exec', '--only', 'firestore', '--project', PROJECT, `node "${fileURLToPath(import.meta.url)}"`], { cwd: dir, stdio: 'inherit', shell: process.platform === 'win32' })
  process.exit(r.status ?? 1)
}

/* ------------------------------------------------ bundle the app modules ------------------------------------------------ */
const { build } = await import(pathToFileURL(join(root, 'node_modules/esbuild/lib/main.js')).href).catch(() => import('esbuild'))
// Inside the project so the bundle resolves better-sqlite3 from node_modules.
const outDir = join(root, 'node_modules/.cache/cloud-check')
mkdirSync(outDir, { recursive: true })
const outfile = join(outDir, 'mods.mjs')
await build({
  stdin: {
    contents: `
      export { LicenseService } from './src/main/license/service'
      export { FirestoreRest, resolveFirestoreConfig, FirestoreError, timestamp } from './src/main/cloud/firestore'
      export { buildHeartbeat, heartbeatWrite } from './src/main/cloud/heartbeat'
      export { buildLocation, parseGeoIp } from './src/main/cloud/location'
      export * as support from './src/main/cloud/support'
      export { configure, migrate, seedDefaults } from './src/main/db'
    `,
    resolveDir: root,
    loader: 'ts'
  },
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile,
  external: ['better-sqlite3', 'electron'],
  banner: { js: "import { createRequire as __cr } from 'module'; const require = __cr(import.meta.url);" },
  logLevel: 'error'
})
const M = await import(pathToFileURL(outfile).href)
const core = await import(pathToFileURL(join(root, 'scripts/license-core.mjs')).href)
const { default: Database } = await import(pathToFileURL(join(root, 'node_modules/better-sqlite3/lib/index.js')).href)

/* ------------------------------------------------ helpers ------------------------------------------------ */
const host = process.env.FIRESTORE_EMULATOR_HOST
const env = { DTSP_FIRESTORE_EMULATOR: host, DTSP_FIRESTORE_PROJECT: PROJECT }
const cfg = M.resolveFirestoreConfig({ projectId: PROJECT, apiKey: 'emulator' }, env)
const admin = new M.FirestoreRest(cfg, { headers: { Authorization: 'Bearer owner' } }) // bypasses rules (acts as the portal)
const anon = new M.FirestoreRest(cfg)

let passed = 0
let failed = 0
const ok = (cond, label) => {
  if (cond) {
    passed++
    console.log(`  ✓ ${label}`)
  } else {
    failed++
    console.log(`  ✗ ${label}`)
  }
}
const accepted = async (label, fn) => {
  try {
    await fn()
    ok(true, `ACCEPTED: ${label}`)
  } catch (e) {
    ok(false, `ACCEPTED: ${label} — ${e.message}`)
  }
}
const rejected = async (label, fn) => {
  try {
    await fn()
    ok(false, `REJECTED: ${label} — but it was accepted`)
  } catch (e) {
    ok(e.code === 'PERMISSION_DENIED' || e.status === 403, `REJECTED: ${label} (${e.code || e.message})`)
  }
}

/* ------------------------------------------------ 1. activation with registration ------------------------------------------------ */
console.log('\nActivation request (Module 9 registration)')
const keys = core.generateKeyPair()
const dir = mkdtempSync(join(tmpdir(), 'cloud-lic-'))
const lic = new M.LicenseService({ dir, publicKeyPem: keys.publicPem, firestore: { projectId: PROJECT, apiKey: 'emulator' }, appVersion: '1.1.0', env })
const reg = { companyName: 'WETCO SOLAR SOLUTIONS', ownerName: 'Test Owner', phone: '0300-7341433', address: 'Multan' }
const key = 'DTSP-AB12-CD34-EF56-GH78'
let act
await accepted('activationRequests create with registration fields + installToken', async () => {
  act = await lic.activateOnline(key, reg)
})
ok(act?.state === 'pending', 'request is pending')
const reqDoc = act?.requestId ? await admin.get(`activationRequests/${act.requestId}`) : null
ok(reqDoc?.data.companyName === reg.companyName && reqDoc?.data.ownerName === reg.ownerName && reqDoc?.data.phone === reg.phone && reqDoc?.data.address === reg.address, 'registration fields stored')
ok(reqDoc?.data.installToken === lic.installToken && typeof reqDoc?.data.createdAt === 'string', 'installToken + server createdAt stored')

const licenseId = 'LIC-EMU-0001'
const p1 = core.buildPayload({ deviceId: lic.deviceId, businessName: reg.companyName, licenseId, issuedAt: new Date(Date.now() - 86400000).toISOString(), expiresAt: new Date(Date.now() + 200 * 86400000).toISOString() })
await admin.patch(`activationRequests/${act.requestId}`, { status: 'approved', certificate: core.certificateToCode(core.signPayload(p1, keys.privatePem)) }, ['status', 'certificate'])
let polled
await accepted('activation poll reads the approved request (public get)', async () => {
  polled = await lic.pollActivation()
})
ok(polled?.state === 'approved' && lic.status(true).mode === 'active', 'license installed after approval')

/* ------------------------------------------------ 2. licenseStatus check-in + cert refresh ------------------------------------------------ */
console.log('\nLicense check-in (licenseStatus)')
const p2 = { ...p1, issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 565 * 86400000).toISOString(), maxUsers: 9 }
await admin.patch(`licenseStatus/${licenseId}`, { status: 'active', poweredBy: true, certs: { [lic.deviceId]: core.certificateToCode(core.signPayload(p2, keys.privatePem)) } })
let st
await accepted('licenseStatus get (public)', async () => {
  st = await lic.checkIn(false)
})
ok(st?.poweredBy === true, 'poweredBy applied')
ok(!!st?.certUpdate && st.maxUsers === 9, `renewed certificate installed (${st?.certUpdate?.summary})`)

/* ------------------------------------------------ 2b. write gating (suspend / device deactivated) ------------------------------------------------ */
console.log('\nWrite gating against the emulator (suspend, device deactivated)')
{
  // The business-DB copy of the remote decision (settings.license_remote in the app).
  let dbRemote = null
  let offset = 0
  // A protected write re-verifies when the last success is older than 5 minutes: move a test clock forward each step.
  const svc = (online = true) =>
    new M.LicenseService({
      dir,
      publicKeyPem: keys.publicPem,
      firestore: online ? { projectId: PROJECT, apiKey: 'emulator' } : null,
      appVersion: '1.1.0',
      env: online ? env : { DTSP_CLOUD_DISABLED: '1' },
      now: () => Date.now() + offset,
      getDbRemote: () => dbRemote,
      setDbRemote: (r) => (dbRemote = r)
    })
  const step = () => (offset += 6 * 60_000)
  step()
  let g = await svc().ensureFresh()
  ok(g.canWrite && g.mode === 'active', `active license: write allowed after a fresh check (${g.mode})`)
  await admin.patch(`licenseStatus/${licenseId}`, { status: 'suspended' }, ['status'])
  const p3 = { ...p2, issuedAt: new Date(Date.now() + offset).toISOString(), maxUsers: 11 }
  await admin.patch(`licenseStatus/${licenseId}`, { certs: { [lic.deviceId]: core.certificateToCode(core.signPayload(p3, keys.privatePem)) } }, ['certs'])
  step()
  g = await svc().ensureFresh()
  ok(!g.canWrite && g.mode === 'suspended' && g.blockReason === 'license', `suspend -> next write blocked with the license message (${g.mode}: ${g.message.slice(0, 60)}…)`)
  ok(g.maxUsers === 9, 'certificate published while suspended was NOT installed')
  ok(dbRemote?.status === 'suspended', 'suspension also stored in the business DB copy')
  // Network failure never clears the stored suspension.
  step()
  const off = svc(false)
  ok(!off.status(true).canWrite, 'offline (no service) still blocked by the stored suspension')
  await admin.patch(`licenseStatus/${licenseId}`, { status: 'active', certs: {} }, ['status', 'certs'])
  step()
  g = await svc().ensureFresh()
  ok(g.canWrite && dbRemote === null, `re-activated by Digital Target -> writes allowed again, DB copy cleared (${g.mode})`)
  await admin.patch(`licenseStatus/${licenseId}`, { deactivatedDevices: [lic.deviceId] }, ['deactivatedDevices'])
  step()
  const s5 = svc()
  g = await s5.ensureFresh()
  ok(!g.canWrite && g.mode === 'device_deactivated' && g.blockReason === 'device', `device deactivated -> blocked with the device message (${g.message.slice(0, 60)}…)`)
  ok(/computer/i.test(g.message) && !/license is suspended/i.test(g.message), 'device message differs from the license message')
  // Deleting the license-folder state does not lift it: the business DB copy still blocks.
  const { rmSync } = await import('node:fs')
  rmSync(join(dir, 'state.json'), { force: true })
  ok(svc(false).status(true).mode === 'device_deactivated', 'state.json deleted -> DB copy still blocks')
  await admin.patch(`licenseStatus/${licenseId}`, { deactivatedDevices: [] }, ['deactivatedDevices'])
  step()
  g = await svc().ensureFresh()
  ok(g.canWrite, `device re-approved -> writes allowed (${g.mode})`)
}

/* ------------------------------------------------ 3. heartbeats ------------------------------------------------ */
console.log('\nHeartbeats')
const token = lic.installToken
const base = { deviceId: lic.deviceId, licenseId, deviceName: 'EMU-PC', os: 'Windows 11', appVersion: '1.1.0', companyName: reg.companyName, mode: 'active', lastCheckAt: new Date().toISOString(), firms: 2, users: 3 }
await accepted('heartbeat create without location', () => lic.client.commit([M.heartbeatWrite(token, M.buildHeartbeat(base))]))
let hb = await admin.get(`heartbeats/${token}`)
ok(hb && !('location' in hb.data) && typeof hb.data.lastSeen === 'string', 'stored without location, lastSeen = server time')
await accepted('heartbeat update with manual location', () =>
  lic.client.commit([M.heartbeatWrite(token, M.buildHeartbeat({ ...base, location: M.buildLocation('manual', { manual: '30.1979, 71.4697 | Office', manualAt: new Date().toISOString() }) }))])
)
const geo = M.parseGeoIp({ success: true, latitude: 30, longitude: 71, city: 'Multan', region: 'Punjab', country: 'Pakistan' })
await accepted('heartbeat update with approximate location (integer coords)', () =>
  lic.client.commit([M.heartbeatWrite(token, M.buildHeartbeat({ ...base, location: M.buildLocation('approximate', { geo }) }))])
)
hb = await admin.get(`heartbeats/${token}`)
ok(hb?.data.location?.source === 'approximate' && hb.data.location.consent === true, 'location stored with consent')
await accepted('heartbeat update with Windows location service (device) location', () =>
  lic.client.commit([
    M.heartbeatWrite(token, M.buildHeartbeat({ ...base, location: M.buildLocation('device', { device: { lat: 30.0457, lng: 72.3489, accuracyKm: 0.035, fetchedAt: new Date().toISOString() } }) }))
  ])
)
hb = await admin.get(`heartbeats/${token}`)
ok(hb?.data.location?.source === 'device' && hb.data.location.label === 'Windows location service' && hb.data.location.accuracyKm === 0.035, 'device location stored with its accuracy')
await accepted('heartbeat update after withdrawing consent', () => lic.client.commit([M.heartbeatWrite(token, M.buildHeartbeat(base))]))
hb = await admin.get(`heartbeats/${token}`)
ok(hb && !('location' in hb.data), 'location removed from the cloud')

/* ------------------------------------------------ 4. support ------------------------------------------------ */
console.log('\nSupport messages')
const db = new Database(':memory:')
M.configure(db)
M.migrate(db)
M.seedDefaults(db)
const thread = { deviceId: lic.deviceId, licenseId, companyName: reg.companyName, contactName: reg.ownerName, phone: reg.phone }
const deps = { db, client: lic.client, token, thread, state: {}, backoff: new Map(), force: true }
const m1 = M.support.queueMessage(db, { body: 'Hello from the emulator check', author: 'Test Owner', userId: 1 })
let r = await M.support.syncSupport(deps)
ok(r.sent === 1 && M.support.getMessage(db, m1.uid).status === 'sent', `thread create + first customer message (${r.error ?? 'ok'})`)
const m2 = M.support.queueMessage(db, { body: 'Second message', author: 'Test Owner', userId: 1 })
r = await M.support.syncSupport(deps)
ok(r.sent === 1 && M.support.getMessage(db, m2.uid).status === 'sent', `thread update + second message (${r.error ?? r.warning ?? 'ok'})`)
const th = await admin.get(`supportThreads/${token}`)
ok(th?.data.unreadByAdmin === true && th.data.lastMessagePreview === 'Second message', 'thread summary updated')
// The portal replies.
await admin.commit([
  { path: `supportThreads/${token}/messages/admreply01`, fields: { from: 'admin', body: 'Hi, how can we help?', authorName: 'Digital Target' }, serverTime: ['at'], exists: false },
  { path: `supportThreads/${token}`, fields: { unreadByCustomer: true, lastMessageFrom: 'admin' }, mask: ['unreadByCustomer', 'lastMessageFrom'], exists: true }
])
r = await M.support.syncSupport(deps)
ok(r.received.length === 1 && M.support.counts(db).unread === 1, `admin reply pulled (${r.error ?? 'ok'})`)
r = await M.support.syncSupport(deps)
ok(r.received.length === 0, 'reply not pulled twice')
M.support.markAllRead(db)
deps.state.pendingRemoteRead = true
r = await M.support.syncSupport(deps)
ok(r.ok && (await admin.get(`supportThreads/${token}`))?.data.unreadByCustomer === false, `mark read (unreadByCustomer=false) accepted (${r.error ?? 'ok'})`)

/* ------------------------------------------------ 5. forged writes ------------------------------------------------ */
console.log('\nForged writes')
await rejected('customer message posing as admin', () =>
  anon.commit([{ path: `supportThreads/${token}/messages/forged0001`, fields: { from: 'admin', body: 'fake' }, serverTime: ['at'], exists: false }])
)
await rejected('customer message with client-chosen "at"', () =>
  anon.commit([{ path: `supportThreads/${token}/messages/forged0002`, fields: { from: 'customer', body: 'x', at: new Date() }, exists: false }])
)
await rejected('customer message with an extra field', () =>
  anon.commit([{ path: `supportThreads/${token}/messages/forged0003`, fields: { from: 'customer', body: 'x', priority: 'high' }, serverTime: ['at'], exists: false }])
)
await rejected('heartbeat with client lastSeen', () => anon.commit([{ path: `heartbeats/${token}`, fields: { ...M.buildHeartbeat(base), lastSeen: new Date() } }]))
await rejected('heartbeat with an extra field', () => anon.commit([{ path: `heartbeats/${token}`, fields: { ...M.buildHeartbeat(base), isAdmin: true }, serverTime: ['lastSeen'] }]))
await rejected('heartbeat location without consent', () =>
  anon.commit([{ path: `heartbeats/${token}`, fields: { ...M.buildHeartbeat(base), location: { lat: 1.5, lng: 2.5, source: 'manual', consent: false } }, serverTime: ['lastSeen'] }])
)
await rejected('customer resolving its own thread', () =>
  anon.commit([{ path: `supportThreads/${token}`, fields: { status: 'resolved' }, mask: ['status'], exists: true }])
)
await rejected('activation request with an extra field', () =>
  anon.commit([{ path: 'activationRequests/forgedRequest0000001', fields: { type: 'activate', licenseKey: key, deviceId: lic.deviceId, status: 'pending', plan: 'lifetime' }, serverTime: ['createdAt'], exists: false }])
)
await rejected('activation request pre-approved', () =>
  anon.commit([{ path: 'activationRequests/forgedRequest0000002', fields: { type: 'activate', licenseKey: key, deviceId: lic.deviceId, status: 'approved' }, serverTime: ['createdAt'], exists: false }])
)
await rejected('licenseStatus write by a customer', () => anon.commit([{ path: `licenseStatus/${licenseId}`, fields: { status: 'active', poweredBy: false } }]))

/* ------------------------------------------------ 5. instant activation (activation pass) ------------------------------------------------ */
console.log('\nInstant activation (valid key -> active at once within the device limit)')
{
  const { createHash } = await import('node:crypto')
  const key2 = 'DTSP-IN57-ANT0-0000-0001'
  const lid2 = 'LIC-INST-0001'
  const exp = new Date(Date.now() + 300 * 86400000)
  const passPayload = core.buildPayload({ deviceId: '*', businessName: 'Instant Solar', licenseId: lid2, issuedAt: new Date(Date.now() - 60000).toISOString(), expiresAt: exp.toISOString() })
  await admin.patch(`licenses/${lid2}`, { licenseKey: key2, businessName: 'Instant Solar', status: 'active', maxDevices: 2, activeDevices: 0, devicesSummary: {}, expiresAt: M.timestamp(exp) })
  await admin.patch(`licenseStatus/${lid2}`, { status: 'active', expiresAt: M.timestamp(exp), deactivatedDevices: [] })
  await admin.patch(`activationPasses/${createHash('sha256').update(key2).digest('hex')}`, { licenseId: lid2, cert: core.certificateToCode(core.signPayload(passPayload, keys.privatePem)) })
  const pc = (name) => new M.LicenseService({ dir: mkdtempSync(join(tmpdir(), `inst-${name}-`)), machineId: `machine-${name}`, publicKeyPem: keys.publicPem, firestore: { projectId: PROJECT, apiKey: 'emulator' }, appVersion: '1.2.0', env })
  const tryAct = async (svc) => {
    try {
      return await svc.activateOnline(key2, reg)
    } catch (e) {
      return { error: e }
    }
  }
  const A = pc('A')
  const rA = await tryAct(A)
  ok(rA.state === 'approved' && A.status(true).mode === 'active' && A.status(true).canWrite, `computer A activated instantly (${rA.message ?? rA.error?.message})`)
  let L = await admin.get(`licenses/${lid2}`)
  ok(L?.data.activeDevices === 1 && L?.data.devicesSummary?.[A.deviceId]?.activationType === 'instant', 'slot counted + summary entry written')
  ok((await admin.get(`licenses/${lid2}/devices/${A.deviceId}`))?.data.status === 'active', 'device record created')
  ok((await A.checkIn(false)).mode === 'active', 'check-in of the instantly activated computer')
  const B = pc('B')
  ok((await tryAct(B)).state === 'approved', 'computer B activated instantly (2 of 2)')
  const C = pc('C')
  const rC = await tryAct(C)
  ok(rC.state === 'pending' && /slot/i.test(rC.message) && C.status(true).pendingReason, `limit full -> approval request with reason (${rC.message})`)
  L = await admin.get(`licenses/${lid2}`)
  ok(L?.data.activeDevices === 2, 'no slot over the limit')
  const A2 = new M.LicenseService({ dir: mkdtempSync(join(tmpdir(), 'inst-A2-')), machineId: 'machine-A', publicKeyPem: keys.publicPem, firestore: { projectId: PROJECT, apiKey: 'emulator' }, appVersion: '1.2.0', env })
  const rA2 = await tryAct(A2)
  ok(rA2.state === 'approved' && /no new slot/i.test(rA2.message) && (await admin.get(`licenses/${lid2}`))?.data.activeDevices === 2, 'same computer re-installed -> active, no new slot')
  const D = pc('D')
  let copied = null
  try {
    D.install(core.certificateToCode(core.signPayload(passPayload, keys.privatePem)))
  } catch (e) {
    copied = e
  }
  ok(!!copied && D.status(true).mode === 'not_activated', 'pass copied to another computer is refused offline')
  await rejected('forged slot (counter only, no device record)', () =>
    anon.commit([{ path: `licenses/${lid2}`, fields: { selfActivatedDevice: 'FORGED-0000-0000-0000' }, mask: ['selfActivatedDevice'], increment: { activeDevices: 1 }, serverTime: ['updatedAt'], exists: true }])
  )
  await rejected('customer raising maxDevices', () => anon.commit([{ path: `licenses/${lid2}`, fields: { maxDevices: 50 }, mask: ['maxDevices'], exists: true }]))
  // Admin releases B -> C (still pending) activates by itself at the next check; B now needs approval.
  await admin.patch(`licenses/${lid2}/devices/${B.deviceId}`, { status: 'deactivated' }, ['status'])
  await admin.patch(`licenses/${lid2}`, { activeDevices: 1, devicesSummary: { [A.deviceId]: L.data.devicesSummary[A.deviceId], [B.deviceId]: { ...L.data.devicesSummary[B.deviceId], status: 'deactivated' } } }, ['activeDevices', 'devicesSummary'])
  await admin.patch(`licenseStatus/${lid2}`, { deactivatedDevices: [B.deviceId] }, ['deactivatedDevices'])
  const pC = await C.pollActivation(true)
  ok(pC.state === 'approved' && C.status(true).mode === 'active', 'pending computer C activates as soon as a slot is free')
  const B2 = new M.LicenseService({ dir: mkdtempSync(join(tmpdir(), 'inst-B2-')), machineId: 'machine-B', publicKeyPem: keys.publicPem, firestore: { projectId: PROJECT, apiKey: 'emulator' }, appVersion: '1.2.0', env })
  const rB2 = await tryAct(B2)
  ok(rB2.state === 'pending' && /released or deactivated/i.test(rB2.message), 'released computer needs approval again')
  await admin.patch(`licenseStatus/${lid2}`, { status: 'suspended' }, ['status'])
  await admin.patch(`licenses/${lid2}`, { status: 'suspended' }, ['status'])
  const rE = await tryAct(pc('E'))
  ok(!!rE.error && /suspended/i.test(rE.error.message), 'suspended license refused without a request')
  const unknown = pc('F')
  let rF
  try {
    rF = await unknown.activateOnline('DTSP-ZZZZ-ZZZZ-ZZZZ-ZZZZ', reg)
  } catch (e) {
    rF = { error: e }
  }
  ok(rF.state === 'pending' && /not enabled for instant/i.test(rF.message), 'unknown key -> request for review (no pass)')
}

/* ------------------------------------------------ 6. deactivate -> reactivate (stale cached block) ------------------------------------------------ */
console.log('\nReactivation after a block (admin releases, then reactivates; the customer retries)')
{
  const { createHash } = await import('node:crypto')
  const key3 = 'DTSP-RE57-ACT0-0000-0003'
  const lid3 = 'LIC-REACT-0003'
  const exp = new Date(Date.now() + 300 * 86400000)
  const pass = core.certificateToCode(core.signPayload(core.buildPayload({ deviceId: '*', businessName: 'React Solar', licenseId: lid3, issuedAt: new Date(Date.now() - 60000).toISOString(), expiresAt: exp.toISOString() }), keys.privatePem))
  await admin.patch(`licenses/${lid3}`, { licenseKey: key3, businessName: 'React Solar', status: 'active', maxDevices: 3, activeDevices: 0, devicesSummary: {}, expiresAt: M.timestamp(exp) })
  await admin.patch(`licenseStatus/${lid3}`, { status: 'active', expiresAt: M.timestamp(exp), deactivatedDevices: [] })
  await admin.patch(`activationPasses/${createHash('sha256').update(key3).digest('hex')}`, { licenseId: lid3, cert: pass })
  const G = new M.LicenseService({ dir: mkdtempSync(join(tmpdir(), 'react-G-')), machineId: 'machine-G', publicKeyPem: keys.publicPem, firestore: { projectId: PROJECT, apiKey: 'emulator' }, appVersion: '1.3.0', env })
  const r0 = await G.activateOnline(key3, reg)
  ok(r0.state === 'approved' && G.status(true).canWrite, 'computer G activated instantly')
  const sumOf = async () => (await admin.get(`licenses/${lid3}`)).data.devicesSummary
  const setG = async (status) => {
    const sm = await sumOf()
    await admin.patch(`licenses/${lid3}/devices/${G.deviceId}`, { status }, ['status'])
    await admin.patch(`licenses/${lid3}`, { activeDevices: status === 'active' ? 1 : 0, devicesSummary: { ...sm, [G.deviceId]: { ...sm[G.deviceId], status } } }, ['activeDevices', 'devicesSummary'])
    await admin.patch(`licenseStatus/${lid3}`, { deactivatedDevices: status === 'active' ? [] : [G.deviceId] }, ['deactivatedDevices'])
  }
  await setG('deactivated')
  const blocked = await G.checkIn(true)
  ok(blocked.mode === 'device_deactivated' && !blocked.canWrite, 'released computer is blocked at its next check')
  // The customer releases it locally too (certificate removed, decision kept) and asks again with the key.
  await G.deactivate()
  const rBack = await G.activateOnline(key3, reg)
  ok(rBack.state === 'pending' && /released or deactivated/i.test(rBack.message), 'a released computer waits for approval (with the reason)')
  await setG('active')
  const back = await G.pollActivation(true)
  ok(back.state === 'approved' && G.status(true).mode === 'active' && G.status(true).canWrite, 'after reactivation the retry activates at once (stale block cleared by online proof)')
  // Plain reactivation (certificate kept): the next check unblocks it.
  await setG('deactivated')
  ok((await G.checkIn(true)).mode === 'device_deactivated', 'blocked again')
  await setG('active')
  ok(G.needsCheck() === false, 'two retries within 8 s share one check (a blocked computer is not hammered)')
  await new Promise((r) => setTimeout(r, 8300))
  ok(G.needsCheck() === true, 'a blocked computer re-verifies at the next retry / unlock after 8 s (not after the 5 minute window)')
  const st3 = await G.ensureFresh()
  ok(st3.mode === 'active' && st3.canWrite, 'ensureFresh unblocks it right after reactivation')
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
