/**
 * End-to-end smoke test: launches the built Electron app with an isolated data folder,
 * completes the first-run wizard (with demo data), visits every screen, takes screenshots,
 * opens print previews and renders them to PDF.
 *
 * Usage (Linux CI / headless):  npx electron-vite build && xvfb-run -a node scripts/e2e-smoke.mjs [playwright-module-path]
 * Output: e2e-output/ (screenshots, PDFs, console-errors.txt)
 *
 * Licensing: there is no local trial. The harness creates a THROWAWAY Ed25519 key pair, points the unpackaged app at its
 * public key (DTSP_LICENSE_PUBLIC_KEY_FILE — ignored by packaged builds) and activates offline with an activation code
 * signed by that throwaway key. Online features are disabled (DTSP_CLOUD_DISABLED=1) so nothing reaches the live service.
 */
import { mkdirSync, rmSync, writeFileSync } from 'fs'
import { createRequire } from 'module'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { tmpdir } from 'os'
import { createPrivateKey, pbkdf2Sync, randomBytes, sign as edSign } from 'node:crypto'
import { buildPayload, certificateToCode, decodeRequestCode, generateKeyPair, signPayload } from './license-core.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const { _electron: electron } = require(process.argv[2] || 'playwright')

const out = join(root, 'e2e-output')
rmSync(out, { recursive: true, force: true })
mkdirSync(out, { recursive: true })
const userData = join(tmpdir(), `dtsp-e2e-${process.pid}`)
rmSync(userData, { recursive: true, force: true })

const errors = []
// Throwaway test key (never the real signing key).
const testKeys = generateKeyPair()
const keyDir = join(tmpdir(), `dtsp-e2e-key-${process.pid}`)
mkdirSync(keyDir, { recursive: true })
const testPubFile = join(keyDir, 'test-license-public.pem')
writeFileSync(testPubFile, testKeys.publicPem)
const app = await electron.launch({
  executablePath: join(root, 'node_modules/electron/dist/electron'),
  args: [root, '--no-sandbox'],
  env: { ...process.env, DTSP_USER_DATA: userData, ELECTRON_ENABLE_LOGGING: '1', DTSP_LICENSE_PUBLIC_KEY_FILE: testPubFile, DTSP_CLOUD_DISABLED: '1' }
})

async function mainWindow() {
  for (let i = 0; i < 60; i++) {
    for (const w of app.windows()) {
      const url = w.url()
      if (url.includes('index.html') && !url.includes('/print/')) return w
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error('Main window did not open')
}

const splash = app.windows().find((w) => w.url().includes('splash')) ?? (await app.firstWindow())
await new Promise((r) => setTimeout(r, 1200))
try {
  await splash.screenshot({ path: join(out, '00-splash.png') })
} catch {
  /* splash may already be closed */
}

const page = await mainWindow()
page.on('pageerror', (e) => errors.push(`pageerror [${page.url().split('#')[1] ?? ''}]: ${e.message} | ${(e.stack ?? '').split('\n').slice(0, 4).join(' | ')}`))
page.on('console', (m) => (m.type() === 'error' || /useEffect|destroy/.test(m.text())) && errors.push(`console [${page.url().split('#')[1] ?? ''}]: ${m.text().slice(0, 900)}`))
await page.setViewportSize({ width: 1440, height: 900 }).catch(() => undefined)
// v1.2: the wizard starts with the License step — no local trial; activate offline with a throwaway-key activation code.
await page.waitForSelector('text=Offline activation', { timeout: 30000 })
await page.screenshot({ path: join(out, '01a-setup-license.png') })
if (await page.locator('button:has-text("Start 15-day trial")').count()) throw new Error('The wizard still offers a local trial')
const continueBtn = page.locator('button:has-text("Continue")').last()
if (!(await continueBtn.isDisabled())) throw new Error('The wizard can continue without a license')
await page.click('[data-testid=lic-offline]')
await page.locator('input[placeholder="DTSP-XXXX-XXXX-XXXX-XXXX"]').fill('DTSPE2E0TEST0KEY0001')
await page.click('button:has-text("Generate request code")')
const reqCode = await page.locator('textarea[readonly]').inputValue({ timeout: 10000 })
const req = decodeRequestCode(reqCode)
if (!req.deviceId && !req.d) throw new Error('Request code has no device id')
const cert = signPayload(
  buildPayload({ deviceId: req.deviceId ?? req.d, businessName: 'WETCO SOLAR SOLUTIONS', plan: 'trial', maxFirms: 5, maxUsers: 5, expiresAt: new Date(Date.now() + 15 * 86400000).toISOString() }),
  testKeys.privatePem
)
await page.fill('[data-testid=lic-code]', certificateToCode(cert))
await page.click('button:has-text("Install activation code")')
await page.waitForSelector('text=License activated', { timeout: 15000 })
await page.waitForSelector('text=/Trial — \\d+ day\\(s\\) left/', { timeout: 5000 })
await page.screenshot({ path: join(out, '01b-setup-license-activated.png') })
await continueBtn.click()
await page.waitForSelector('text=Business details', { timeout: 30000 })
await page.waitForTimeout(800)
await page.screenshot({ path: join(out, '01-setup-business.png') })
await page.click('button:has-text("Continue")')
await page.waitForSelector('text=Multiple firms')
await page.screenshot({ path: join(out, '02-setup-firms.png') })
await page.click('button:has-text("Continue")')
await page.locator('label:has-text("Full name") input').fill('Muhammad Waqas')
await page.locator('input[type=password]').nth(0).fill('admin123')
await page.locator('input[type=password]').nth(1).fill('admin123')
await page.click('button:has-text("Continue")')
await page.click('text=Load sample solar business data')
await page.screenshot({ path: join(out, '03-setup-finish.png') })
await page.click('button:has-text("Finish setup")')
await page.waitForSelector('text=Quick Actions', { timeout: 30000 })
await page.waitForTimeout(1500)
await page.screenshot({ path: join(out, '10-dashboard.png'), fullPage: true })

const screens = [
  ['11-sales', '#/sales'],
  ['12-quotations', '#/quotations'],
  ['13-purchases', '#/purchases'],
  ['14-inventory', '#/inventory'],
  ['15-stock', '#/inventory?tab=stock'],
  ['16-customers', '#/customers'],
  ['17-suppliers', '#/suppliers'],
  ['18-projects', '#/projects'],
  ['19-accounts', '#/accounts'],
  ['20-expenses', '#/expenses'],
  ['21-reports', '#/reports'],
  ['22-users', '#/users'],
  ['23-firms', '#/firms'],
  ['24-settings', '#/settings'],
  ['25-backup', '#/backup'],
  ['26-license', '#/settings?tab=license'],
  ['27-new-invoice', '#/doc/new/sale_invoice'],
  ['28-closing', '#/closing'],
  ['29-help', '#/help'],
  ['29a-settings-templates', '#/settings?tab=templates'],
  ['29b-settings-printers', '#/settings?tab=printers'],
  ['29c-settings-cloud', '#/settings?tab=cloud'],
  ['29d-settings-support', '#/settings?tab=support'],
  ['29e-settings-whatsapp', '#/settings?tab=whatsapp'],
  ['29f-firms', '#/firms'],
  ['29g-whatsapp', '#/whatsapp']
]
for (const [name, hash] of screens) {
  await page.evaluate((h) => (window.location.hash = h), hash)
  await page.waitForTimeout(1300)
  await page.screenshot({ path: join(out, `${name}.png`) })
}

// CSV import / export tab + an IPC dry run of a CSV import (nothing is written)
await page.evaluate(() => (window.location.hash = '#/backup'))
await page.waitForTimeout(800)
await page.getByRole('button', { name: 'CSV import / export' }).first().click()
await page.waitForTimeout(800)
await page.screenshot({ path: join(out, '25a-backup-csv.png'), fullPage: true })
const csvDry = await page.evaluate(() =>
  window.dt.call('import.analyze', { kind: 'customers', text: '\uFEFFName,Phone,Opening balance,Opening date\n"Ali, ""A""",0300,1500.5,31/01/2026\n', dateFormat: 'dmy', dryRun: true })
)
if (csvDry.errors.length || !csvDry.dryRun?.reconciliation.matched) throw new Error('CSV dry run failed: ' + JSON.stringify(csvDry.errors))
console.log('CSV dry run OK:', JSON.stringify(csvDry.counts))

// Project detail & a document view
const projects = await page.evaluate(() => window.dt.call('projects.list', {}))
const school = projects.find((p) => p.status === 'in_progress') ?? projects[0]
await page.evaluate((id) => (window.location.hash = `#/projects/${id}`), school.id)
await page.waitForTimeout(1500)
await page.screenshot({ path: join(out, '30-project-detail.png'), fullPage: true })

const invoices = await page.evaluate(() => window.dt.call('docs.list', { docType: 'sale_invoice' }))
const inv = invoices.find((d) => d.project_id) ?? invoices[0]
await page.evaluate((id) => (window.location.hash = `#/doc/${id}`), inv.id)
await page.waitForTimeout(1300)
await page.screenshot({ path: join(out, '31-invoice-view.png'), fullPage: true })

// Print previews -> screenshots + PDFs
const quotes = await page.evaluate(() => window.dt.call('docs.list', { docType: 'quotation' }))
const payments = await page.evaluate(() => window.dt.call('payments.list', {}))
const customers = await page.evaluate(() => window.dt.call('parties.list', { type: 'customer' }))
const prints = [
  ['40-print-invoice', { kind: 'doc', id: inv.id }],
  ['41-print-invoice-counter', { kind: 'doc', id: invoices[invoices.length - 1].id }],
  ['42-print-quotation', { kind: 'doc', id: quotes[0].id }],
  ['43-print-receipt', { kind: 'payment', id: payments[0].id }],
  ['44-print-statement', { kind: 'statement', id: customers[0].id, params: { from: '2000-01-01', to: '2099-12-31' } }],
  ['45-print-project', { kind: 'project', id: school.id }],
  ['46-print-stock', { kind: 'stock', id: 0, params: {} }],
  ['47-print-pl', { kind: 'report', id: 0, params: { report: 'pl', from: '2000-01-01', to: '2099-12-31' } }]
]
for (const [name, args] of prints) {
  const waitWin = app.waitForEvent('window', { timeout: 15000 })
  await page.evaluate((a) => window.dt.call('print.open', a), args)
  const w = await waitWin
  w.on('pageerror', (e) => errors.push(`${name} pageerror: ${e.message}`))
  w.on('console', (m) => m.type() === 'error' && errors.push(`${name} console: ${m.text()}`))
  await w.waitForLoadState('domcontentloaded')
  await w.waitForTimeout(2500)
  await w.screenshot({ path: join(out, `${name}.png`), fullPage: true })
  const b64 = await app.evaluate(async ({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().includes('/print/'))
    if (!win) return null
    const data = await win.webContents.printToPDF({ pageSize: 'A4', printBackground: true, preferCSSPageSize: true })
    win.close()
    return data.toString('base64')
  })
  if (b64) writeFileSync(join(out, `${name}.pdf`), Buffer.from(b64, 'base64'))
}

// ---- Administrator password reset sent by Digital Target (signed, device-bound, one-time) ----
{
  const b64u = (b) => Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  const lic = await page.evaluate(() => window.dt.call('license.status'))
  const TEMP = 'K7MQ-2WXP-9TDH-4RNC'
  const makeCode = (deviceId) => {
    const salt = randomBytes(16)
    const payload = b64u(JSON.stringify({ v: 1, type: 'admin_password_reset', licenseId: 'E2E', deviceId, nonce: b64u(randomBytes(16)), issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 86400000).toISOString(), kdf: { alg: 'pbkdf2-sha256', iter: 200000, salt: salt.toString('base64') }, verifier: pbkdf2Sync(TEMP.replace(/-/g, ''), salt, 200000, 32, 'sha256').toString('base64') }))
    return `${payload}.${b64u(edSign(null, Buffer.from('dtsp-cmd-v1.' + payload, 'utf8'), createPrivateKey(testKeys.privatePem)))}`
  }
  const call = (m, a) => page.evaluate(([m, a]) => window.dt.call(m, a).then((r) => ({ ok: true, r }), (e) => ({ ok: false, e: String(e?.message ?? e) })), [m, a])
  await page.evaluate(() => window.dt.call('auth.logout'))
  await page.reload()
  await page.waitForSelector('text=Welcome back', { timeout: 20000 })
  // the sign-in screen offers the offline route; a wrong code is refused with a clear message
  await page.click('text=Administrator locked out?')
  await page.waitForSelector('text=Reset code from Digital Target')
  await page.locator('textarea').fill('x'.repeat(60))
  await page.click('button:has-text("Apply reset code")')
  await page.waitForSelector('text=not a Digital Target reset code', { timeout: 5000 })
  await page.screenshot({ path: join(out, '50-admin-reset-dialog.png') })
  await page.keyboard.press('Escape')
  const bad = await call('auth.applyResetCode', { code: makeCode('SOME-OTHER-DEVICE-1234') })
  if (bad.ok || !/different computer/.test(bad.e)) throw new Error('reset code for another computer must be refused: ' + JSON.stringify(bad))
  const good = await call('auth.applyResetCode', { code: makeCode(lic.deviceId) })
  if (!good.ok) throw new Error('valid reset code refused: ' + good.e)
  const wrong = await call('auth.login', { username: 'admin', password: 'K7MQ-2WXP-9TDH-4RNX' })
  if (wrong.ok) throw new Error('a wrong temporary password signed in')
  const login = await call('auth.login', { username: 'admin', password: TEMP.toLowerCase() })
  if (!login.ok || !login.r.user.mustChangePassword) throw new Error('temporary password sign-in failed or did not force a change: ' + JSON.stringify(login))
  const blocked = await call('docs.list', { docType: 'sale_invoice' })
  if (blocked.ok) throw new Error('the forced password change was not enforced')
  const changed = await call('auth.changePassword', { oldPassword: TEMP, newPassword: 'Solar#Reset2026x' })
  if (!changed.ok) throw new Error('changing the temporary password failed: ' + changed.e)
  await call('auth.logout')
  if ((await call('auth.login', { username: 'admin', password: TEMP })).ok) throw new Error('the temporary password still works after the change')
  if (!(await call('auth.login', { username: 'admin', password: 'Solar#Reset2026x' })).ok) throw new Error('the new password does not sign in')
  const replay = await call('auth.applyResetCode', { code: makeCode(lic.deviceId) })
  console.log('Administrator reset OK: foreign code refused, temp password signs in once, change forced, a fresh code from Digital Target is accepted =', replay.ok)
}

writeFileSync(join(out, 'console-errors.txt'), errors.join('\n') || 'No console errors.')
console.log(`Screens captured in ${out}. Errors: ${errors.length}`)
for (const e of errors.slice(0, 40)) console.log(' -', e)
await app.close()
rmSync(userData, { recursive: true, force: true })
rmSync(keyDir, { recursive: true, force: true })
