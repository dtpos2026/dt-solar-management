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
      export { FirestoreRest, resolveFirestoreConfig, FirestoreError } from './src/main/cloud/firestore'
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

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
