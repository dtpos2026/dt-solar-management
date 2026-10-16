/**
 * Performance measurement on the emulators (portal-core pages).
 *   node perf/seed-and-measure.mjs <fsPort> <authPort> <baseUrl> <label> [--no-seed]
 * Seeds a large dataset (300 licenses, 600 devices, 5000 audit entries, 500 invoices + payments, 150 clients,
 * 300 heartbeats, 40 support threads), signs in as the bootstrap owner, then for every page records the
 * Firestore documents read (window.__reads from perf/meter.ts) and the time to first data.
 * The portal must be served with perf/vite.meter.config.ts and VITE_USE_EMULATORS=1.
 */
import { createRequire } from 'module'
import { readFileSync, writeFileSync } from 'fs'
const require = createRequire(new URL('../package.json', import.meta.url))
const { initializeTestEnvironment } = require('@firebase/rules-unit-testing')
const { doc, writeBatch, Timestamp } = require('firebase/firestore')
const { chromium } = require('/opt/node22/lib/node_modules/playwright')

const [fsPort, authPort, BASE, label] = process.argv.slice(2)
const seed = !process.argv.includes('--no-seed')
const P = 'dt-soalr-mangement'
const DAY = 86_400_000
const now = Date.now()
const ts = (ms) => Timestamp.fromMillis(ms)

if (seed) {
  const env = await initializeTestEnvironment({ projectId: P, firestore: { rules: readFileSync(new URL('../firestore.rules', import.meta.url), 'utf8'), host: '127.0.0.1', port: Number(fsPort) } })
  await env.withSecurityRulesDisabled(async (c) => {
    const db = c.firestore()
    let b = writeBatch(db)
    let n = 0
    const put = async (path, data) => {
      b.set(doc(db, path), data)
      if (++n % 450 === 0) { await b.commit(); b = writeBatch(db) }
    }
    const cats = ['financial', 'license', 'client', 'device', 'support', 'settings', 'general', 'security']
    for (let i = 0; i < 150; i++) {
      await put(`clients/c${i}`, { code: `CL-${String(i + 1).padStart(4, '0')}`, company: `Company ${i} Solar`, ownerName: `Owner ${i}`, phone: `0300${String(i).padStart(7, '0')}`, email: `c${i}@example.com`, address: 'Street', city: ['Multan', 'Lahore', 'Karachi'][i % 3], logo: null, status: i % 17 === 0 ? 'suspended' : 'active', plan: 'professional', planType: ['monthly', 'yearly', 'lifetime'][i % 3], allowedFirms: 3, allowedDevices: 2, notes: '', registeredAt: ts(now - i * DAY), createdAt: ts(now - i * DAY), updatedAt: ts(now), createdBy: 'seed' })
    }
    for (let i = 0; i < 300; i++) {
      const status = i % 23 === 0 ? 'revoked' : i % 11 === 0 ? 'suspended' : 'active'
      await put(`licenses/L${i}`, { licenseKey: `DTSP-AB12-CD34-EF56-${String(i).padStart(4, '0')}`, clientId: `c${i % 150}`, customerName: `Owner ${i % 150}`, businessName: `Company ${i % 150} Solar`, phone: '0300', email: '', city: 'Multan', plan: 'professional', planType: ['monthly', 'yearly', 'lifetime'][i % 3], status, maxDevices: 2, maxFirms: 3, maxUsers: 5, features: ['projects'], expiresAt: ts(now + (i % 40 === 0 ? -5 : 200) * DAY), checkinDays: 30, graceDays: 15, notes: '', activeDevices: 2, poweredBy: false, detached: false, paymentStatus: 'paid', createdAt: ts(now - i * DAY), updatedAt: ts(now), createdBy: 'seed' })
      await put(`licenseStatus/L${i}`, { status, expiresAt: null, deactivatedDevices: [], poweredBy: false, detached: false, updatedAt: ts(now) })
      for (let d = 0; d < 2; d++) {
        const id = `DEV${String(i).padStart(4, '0')}-${d}`
        await put(`licenses/L${i}/devices/${id}`, { deviceId: id, deviceName: `PC-${i}-${d}`, os: 'win32 10.0', appVersion: '1.1.0', status: d === 1 && i % 5 === 0 ? 'deactivated' : 'active', activatedAt: ts(now - i * DAY), activationType: 'online', lastIssuedAt: ts(now - i * DAY) })
      }
      const tok = `h${String(i).padStart(39, '0')}`
      await put(`heartbeats/${tok}`, { deviceId: `DEV${String(i).padStart(4, '0')}-0`, licenseId: `L${i}`, deviceName: `PC-${i}-0`, os: 'win32 10.0', appVersion: '1.1.0', companyName: `Company ${i % 150} Solar`, mode: 'active', lastCheckAt: new Date(now).toISOString(), firms: 2, users: 3, lastSeen: ts(now - (i % 50) * 3_600_000) })
      if (i < 40) await put(`supportThreads/${tok}`, { deviceId: `DEV${String(i).padStart(4, '0')}-0`, licenseId: `L${i}`, companyName: `Company ${i} Solar`, contactName: 'X', phone: '0300', status: i % 3 ? 'resolved' : 'open', lastMessageAt: ts(now - i * 3_600_000), lastMessageFrom: 'customer', lastMessagePreview: 'Hello', unreadByAdmin: i % 3 === 0, unreadByCustomer: false, createdAt: ts(now - i * DAY) })
    }
    for (let i = 0; i < 5000; i++) {
      const cat = cats[i % cats.length]
      await put(`auditLogs/a${String(i).padStart(5, '0')}`, { action: `${cat}_event`, category: cat, by: 'seed@example.com', byUid: 'seed', target: `L${i % 300}`, targetType: 'license', licenseId: `L${i % 300}`, details: `Seeded entry ${i}`, meta: {}, status: 'success', at: ts(now - i * 600_000), archived: false })
    }
    for (let i = 0; i < 500; i++) {
      const total = 60000
      const paid = i % 3 === 0 ? total : i % 3 === 1 ? 20000 : 0
      await put(`invoices/I${i}`, { number: `DT-INV-${String(i + 1).padStart(4, '0')}`, clientId: `c${i % 150}`, clientName: `Company ${i % 150} Solar`, licenseId: `L${i % 300}`, planType: 'yearly', issueDate: ts(now - i * DAY), dueDate: ts(now - i * DAY + 15 * DAY), currency: 'PKR', lines: [{ kind: 'plan', description: 'DT Solar Pro — yearly', qty: 1, rate: total, amount: total }], subtotal: total, discount: 0, taxRate: 0, taxAmount: 0, total, paid, balance: total - paid, status: paid === total ? 'paid' : paid ? 'partial' : 'unpaid', verifyToken: `v${String(i).padStart(31, '0')}`, notes: '', createdAt: ts(now - i * DAY), createdBy: 'seed', updatedAt: ts(now), cancelledAt: null, cancelReason: '', lastPaymentAt: paid ? ts(now - i * DAY) : null })
      if (paid) await put(`invoices/I${i}/payments/p1`, { amount: paid, method: 'bank', reference: 'TX', date: ts(now - i * DAY), receiptNo: `DT-RCP-${i}`, createdAt: ts(now - i * DAY), createdBy: 'seed' })
    }
    await b.commit()
    console.log('seeded', n, 'documents')
  })
  await env.cleanup()
  await fetch(`http://127.0.0.1:${authPort}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=any`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'digitaltarget.digital@gmail.com', password: 'secret123', returnSecureToken: true }) })
}

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
const errors = []
page.on('pageerror', (e) => errors.push(`pageerror [${page.url()}]: ${e.message}`))
page.on('console', (m) => m.type() === 'error' && errors.push(`console [${page.url()}]: ${m.text().slice(0, 300)}`))
await page.goto(BASE + '/')
await page.fill('input[type=email]', 'digitaltarget.digital@gmail.com').catch(() => undefined)
await page.fill('input[type=password]', 'secret123')
await page.click('button:has-text("Sign in")')
const NAV = 'nav a[href="#/clients"]'
const init = await page.waitForSelector(`button:has-text("Initialise Super Admin"), ${NAV}`, { timeout: 30000 }).catch(async (e) => { await page.screenshot({ path: 'login-fail.png' }); throw e })
if ((await init.textContent())?.includes('Initialise')) { await init.click(); await page.waitForSelector(NAV, { timeout: 30000 }) }

/** Waits until no new read for `quietMs`, returns { reads, queries, firstMs, settledMs }. */
async function settle(t0, quietMs = 2500, maxMs = 60000) {
  let last = -1, lastChange = Date.now()
  for (;;) {
    const n = await page.evaluate(() => window.__reads?.n ?? 0)
    if (n !== last) { last = n; lastChange = Date.now() }
    if (Date.now() - lastChange > quietMs || Date.now() - t0 > maxMs) break
    await page.waitForTimeout(150)
  }
  return page.evaluate((t0p) => {
    const r = window.__reads
    const times = r.log.map((l) => Number(l.split(' ')[0]))
    return { reads: r.n, queries: r.q, firstMs: times.length ? Math.round(times[0] - t0p) : null, settledMs: times.length ? Math.round(times[times.length - 1] - t0p) : null, log: r.log.slice(0, 40) }
  }, await page.evaluate(() => 0))
}

const routes = (process.env.ROUTES || '/,/clients,/clients/c1,/billing,/activity,/support,/verify,/settings,/admins').split(',')
const results = {}
// Cold: full reload per page (new Firestore client), counts everything the page + shell read.
for (const r of routes) {
  await page.goto(BASE + '/#' + r)
  await page.reload()
  await page.waitForSelector(NAV, { timeout: 30000 })
  const t0 = Date.now()
  const res = await settle(t0)
  results[r] = { reads: res.reads, queries: res.queries, firstDataMs: res.firstMs, settledMs: res.settledMs }
  if (process.env.LOG) console.log(r, res.log.join('\n'))
}
// Warm: in-app navigation Dashboard → Clients → Billing → Dashboard → Clients (no reloads).
await page.goto(BASE + '/#/')
await page.reload()
await page.waitForSelector(NAV, { timeout: 30000 })
await settle(Date.now())
const before = await page.evaluate(() => window.__reads.n)
for (const r of ['/clients', '/billing', '/', '/clients', '/']) {
  await page.click(`nav a[href="#${r}"]`)
  await settle(Date.now(), 1500)
}
const warm = (await page.evaluate(() => window.__reads.n)) - before
const out = { label, at: new Date().toISOString(), cold: results, warmNavReads: warm, errors }
console.log(JSON.stringify(out, null, 1))
writeFileSync(`perf-${label}.json`, JSON.stringify(out, null, 1))
await browser.close()
