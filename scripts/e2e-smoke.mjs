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
await page.waitForSelector('text=/Trial - \\d+ day\\(s\\) left/', { timeout: 5000 })
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
// Location consent (owner, first licensed sign-in): asked once; "Not now" keeps sharing off and the question never returns.
await page.waitForSelector("text=Share this computer's location?", { timeout: 5000 })
await page.screenshot({ path: join(out, '10a-location-consent.png') })
await page.getByRole('button', { name: 'Not now' }).click()
await page.waitForSelector("text=Share this computer's location?", { state: 'detached', timeout: 5000 })
const loc = await page.evaluate(() => window.dt.call('cloud.overview'))
if (loc.location.mode !== 'off' || !loc.location.prompted) throw new Error('Declining location sharing was not remembered: ' + JSON.stringify(loc.location))
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
  ['29g-whatsapp', '#/whatsapp'],
  ['30-crm', '#/crm']
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

// ---- CRM: sample enquiries, follow-ups, stage changes, conversion to a customer, permissions ----
{
  const call = (m, a) => page.evaluate(([m, a]) => window.dt.call(m, a), [m, a])
  const sum = await call('crm.summary')
  if (sum.open !== 5 || sum.followUps.overdue !== 1 || sum.followUps.today !== 1 || sum.followUps.week !== 3 || sum.wonThisMonth.count !== 1 || sum.conversionPct !== 50) {
    throw new Error('CRM sample data summary is wrong: ' + JSON.stringify(sum))
  }
  // the screen: pipeline columns, the lead detail with its timeline, logging a call
  await page.evaluate(() => (window.location.hash = '#/crm'))
  await page.waitForSelector('text=Noor Textile Mills', { timeout: 10000 })
  await page.screenshot({ path: join(out, '30a-crm-pipeline.png') })
  await page.click('text=Noor Textile Mills')
  await page.waitForSelector('text=Log an activity', { timeout: 5000 })
  await page.screenshot({ path: join(out, '30b-crm-lead.png') })
  await page.locator('input[placeholder^="What happened"]').fill('Called the director, decision expected on Friday')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await page.waitForSelector('text=Called the director', { timeout: 5000 })
  await page.keyboard.press('Escape')
  const id = await call('crm.save', { name: 'E2E Lead', phone: '0300-0000000', city: 'Multan', expectedValue: 500000, nextFollowUp: '2099-01-01' })
  const lost = await page.evaluate(([i]) => window.dt.call('crm.setStage', { id: i, stage: 'lost' }).then(() => 'accepted', (e) => String(e?.message ?? e)), [id])
  if (lost === 'accepted') throw new Error('a lead was marked lost without a reason')
  const won = await call('crm.setStage', { id, stage: 'won' })
  if (!won.partyId) throw new Error('winning a lead did not create the customer')
  const party = (await call('parties.list', { type: 'customer' })).find((p) => p.id === won.partyId)
  if (!party || party.name !== 'E2E Lead') throw new Error('customer created from the lead is missing')
  await call('crm.delete', { id })
  console.log('CRM OK: summary, timeline, lost needs a reason, won creates the customer')
}

// ---- Editable mode (Vyapar-style settings): Standard by default, Simple shop, scan box, invoice print settings ----
{
  const call = (m, a) => page.evaluate(([m, a]) => window.dt.call(m, a), [m, a])
  const navHas = (text) => page.locator('aside a', { hasText: text }).count()
  if ((await call('settings.get')).ui_mode !== 'standard') throw new Error('a new installation must start in Standard mode')
  await page.evaluate(() => (window.location.hash = '#/settings?tab=customize'))
  await page.waitForSelector('text=Software mode', { timeout: 10000 })
  for (const t of ['Transaction Header', 'Items Table', 'Taxes, Discount & Total', 'More Transaction Features', 'Cash Sale by default', 'Round Off Transaction amount']) {
    if (!(await page.getByText(t, { exact: true }).count())) throw new Error(`Transaction screen lacks "${t}"`)
  }
  await page.getByText('More Transaction Features', { exact: true }).scrollIntoViewIfNeeded()
  await page.screenshot({ path: join(out, '31a1-customize-transaction.png') })
  await page.getByRole('button', { name: 'Invoice Print', exact: true }).click()
  for (const t of ['Print Company Info/Header', 'Totals & Taxes', 'Footer', 'Company Name Text Size', 'Total Item Quantity', 'Amount Grouping']) {
    if (!(await page.getByText(t, { exact: true }).count())) throw new Error(`Invoice Print screen lacks "${t}"`)
  }
  await page.getByText('Footer', { exact: true }).scrollIntoViewIfNeeded()
  await page.screenshot({ path: join(out, '31a2-customize-print.png') })
  await page.getByRole('button', { name: 'Item', exact: true }).click()
  for (const t of ['Enable Item', 'Stock maintenance', 'Update Sale Price from TXN']) if (!(await page.getByText(t, { exact: true }).count())) throw new Error(`Item screen lacks "${t}"`)
  await page.screenshot({ path: join(out, '31a-customize.png') })
  await page.getByRole('button', { name: /Simple shop/ }).click()
  await page.waitForFunction(() => !document.querySelector('aside a[href="#/crm"]'), null, { timeout: 10000 })
  if ((await call('settings.get')).ui_mode !== 'custom') throw new Error('Simple shop did not switch to Editable mode')
  for (const t of ['CRM & Leads', 'Solar Projects', 'Day Closing']) if (await navHas(t)) throw new Error(`${t} is still in the menu after Simple shop`)
  for (const t of ['Sales', 'Quotations', 'Purchases', 'Inventory', 'Customers', 'Accounts', 'Expenses', 'Reports']) if (!(await navHas(t))) throw new Error(`${t} vanished from the menu after Simple shop`)
  // the barcode scan box is a switch of its own
  await page.evaluate(() => (window.location.hash = '#/settings?tab=customize'))
  await page.getByLabel('Search settings').fill('Barcode scanning')
  await page.locator('[role=switch]').last().click()
  await page.waitForFunction(() => window.dt.call('settings.get').then((s) => s.ui_options['item.barcode'] === true), null, { timeout: 10000 })
  // automatic round off: nearest 100
  await page.getByLabel('Search settings').fill('Round off')
  await page.locator('[role=switch]').last().click()
  await page.waitForFunction(() => window.dt.call('settings.get').then((s) => s.ui_options['txn.round_off'] === true), null, { timeout: 10000 })
  await page.locator('select').nth(0).selectOption('nearest')
  await page.waitForFunction(() => window.dt.call('settings.get').then((s) => s.ui_options['txn.round_mode'] === 'nearest'), null, { timeout: 10000 })
  await page.locator('select').nth(1).selectOption('100')
  await page.waitForFunction(() => window.dt.call('settings.get').then((s) => s.ui_options['txn.round_to'] === '100'), null, { timeout: 10000 })
  const pid = await call('products.save', { name: 'E2E Scan Item', type: 'goods', unit: 'pcs', salePrice: 1234, barcode: '8901234567890' })
  await page.evaluate(() => (window.location.hash = '#/doc/new/sale_invoice'))
  await page.waitForSelector('text=Notes & terms', { timeout: 10000 })
  for (const t of ['Solar project (optional)', 'Warehouse', 'Customer PO / reference']) if (await page.getByText(t, { exact: true }).count()) throw new Error(`"${t}" is still on the invoice after Simple shop`)
  if (!(await page.getByText('Cash sale (full amount received now)').count())) throw new Error('Cash Sale by default did not add the cash sale box')
  await page.getByLabel('Scan barcode').fill('8901234567890')
  await page.getByLabel('Scan barcode').press('Enter')
  await page.waitForFunction(() => [...document.querySelectorAll('input[aria-label="Item name"]')].some((i) => i.value === 'E2E Scan Item'), null, { timeout: 5000 })
  await page.getByLabel('Scan barcode').fill('8901234567890')
  await page.getByLabel('Scan barcode').press('Enter')
  await page.waitForTimeout(300)
  const rowText = await page.locator('table.tbl tbody tr').first().innerText()
  if (!/2,468/.test(rowText)) throw new Error('scanning the same barcode twice did not make quantity 2 (line total 2,468): ' + rowText.replace(/\s+/g, ' ').slice(0, 200))
  const summary = await page.locator('text=Round off (nearest 100)').count()
  if (!summary) throw new Error('automatic round off did not show on the invoice')
  const body = await page.locator('body').innerText()
  if (!/Grand total\s+Rs\.\s*2,500/.test(body)) throw new Error('automatic round off nearest 100 did not make the grand total 2,500: ' + (body.match(/Grand total[^\n]*\n?[^\n]*/) ?? [''])[0])
  await page.screenshot({ path: join(out, '31b-simple-invoice.png') })
  await call('products.delete', { id: pid }).catch(() => undefined)
  await page.evaluate(() => (window.location.hash = '#/crm'))
  await page.waitForFunction(() => window.location.hash === '#/', null, { timeout: 5000 })

  // Invoice Print settings reach the printed document: no company name, another title, total quantity, no thousands separators
  await call('settings.update', { patch: { ui_options: { 'print.company_name': false, 'print.address': false, 'print.total_qty': true, 'print.grouping': false, 'print.min_rows': 0, 'print.title.sale_invoice': 'Tax Invoice', 'print.signature_text': 'Managing Director' } } })
  const printable = (await call('docs.list', { docType: 'sale_invoice' }))[0]
  const waitWin = app.waitForEvent('window', { timeout: 15000 })
  await call('print.open', { kind: 'doc', id: printable.id })
  const pw = await waitWin
  await pw.waitForLoadState('domcontentloaded')
  await pw.waitForSelector('.sheet', { timeout: 15000 })
  await pw.waitForTimeout(1500)
  const sheet = await pw.locator('.sheet').first().innerText()
  await pw.screenshot({ path: join(out, '31c-print-editable.png'), fullPage: true })
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().includes('/print/'))?.close())
  if (sheet.slice(0, 400).includes('WETCO SOLAR SOLUTIONS')) throw new Error('the company name is still printed in the header')
  if (!/tax invoice/i.test(sheet)) throw new Error('the printed name of the invoice did not change')
  if (!/Total quantity:/.test(sheet)) throw new Error('Total Item Quantity did not print')
  if (!/Managing Director/.test(sheet)) throw new Error('the custom signature text did not print')
  if (/\d,\d{3}/.test(sheet.replace(/\d{4}-\d{2}/g, ''))) throw new Error('Amount Grouping off still printed thousands separators: ' + (sheet.match(/\S*\d,\d{3}\S*/) ?? [''])[0])

  // Standard mode: everything is back, the switches are kept for later
  await page.evaluate(() => (window.location.hash = '#/settings?tab=customize'))
  await page.waitForSelector('text=Software mode', { timeout: 10000 })
  await page.getByRole('button', { name: /^Standard/ }).click()
  await page.waitForSelector('aside a[href="#/crm"]', { timeout: 10000 })
  if ((await call('settings.get')).ui_mode !== 'standard') throw new Error('Standard mode was not saved')
  await page.evaluate(() => (window.location.hash = '#/doc/new/sale_invoice'))
  await page.waitForSelector('text=Solar project (optional)', { timeout: 10000 })
  if (await page.getByLabel('Scan barcode').count()) throw new Error('the scan box shows in Standard mode')
  await page.evaluate(() => (window.location.hash = '#/'))
  console.log('EDITABLE OK: Vyapar screens and labels, Simple shop menu and invoice, cash sale box, barcode scan twice gives quantity 2, Invoice Print settings in the printed document, Standard restores')
}

// ---- POS: module switch, shift, scan or tap, cash with change, close the shift ----
{
  const call = (m, a) => page.evaluate(([m, a]) => window.dt.call(m, a), [m, a])
  if ((await page.locator('aside a', { hasText: 'POS Counter' }).count()) !== 0) throw new Error('POS shows in the menu before it is switched on')
  await call('settings.update', { patch: { pos_settings: { auto_print: false } } })
  await page.evaluate(() => (window.location.hash = '#/settings?tab=customize'))
  await page.waitForSelector('text=POS and ERP modules', { timeout: 10000 })
  await page.locator('[role=switch]').first().click()
  await page.waitForSelector('aside a:has-text("POS Counter")', { timeout: 10000 })
  await page.getByText('POS counter settings', { exact: true }).scrollIntoViewIfNeeded()
  await page.screenshot({ path: join(out, '32a-pos-settings.png') })
  const product = (await call('products.list', { limit: 500, active: 'active' })).rows.find((p) => p.type === 'goods' && p.stock >= 5 && p.sale_price > 0)
  await page.evaluate(() => (window.location.hash = '#/pos'))
  await page.waitForSelector('text=Open your shift', { timeout: 10000 })
  await page.getByTestId('pos-open-shift').click()
  await page.waitForSelector('[aria-label="Search items"]', { timeout: 10000 })
  await page.getByLabel('Search items').fill(product.name.slice(0, 8))
  await page.getByTestId('pos-tile').first().click()
  await page.getByLabel('Search items').fill('')
  const totalText = await page.getByTestId('pos-total').innerText()
  if (!/\d/.test(totalText)) throw new Error('the POS cart total is empty: ' + totalText)
  await page.screenshot({ path: join(out, '32b-pos-cart.png') })
  await page.getByTestId('pos-pay').click()
  await page.waitForSelector('text=Take payment', { timeout: 5000 })
  const tendered = Math.ceil(Number(totalText.replace(/[^\d.]/g, '')) / 1000) * 1000 + 1000
  await page.locator('input.input').filter({ hasNot: page.locator('select') }).last().fill(String(tendered)).catch(() => undefined)
  await page.getByRole('button', { name: String(tendered), exact: true }).click().catch(() => undefined)
  await page.screenshot({ path: join(out, '32c-pos-pay.png') })
  await page.getByTestId('pos-confirm').click()
  await page.waitForSelector('text=Sale complete', { timeout: 10000 })
  const change = await page.getByTestId('pos-change').innerText().catch(() => '')
  if (!/\d/.test(change)) throw new Error('no change was shown after paying more than the bill')
  await page.screenshot({ path: join(out, '32d-pos-done.png') })
  await page.getByRole('button', { name: 'New sale' }).click()
  const st = await call('pos.status')
  if (st.shift.sales.count !== 1) throw new Error('the POS sale is not in the shift: ' + JSON.stringify(st.shift.sales))
  const sale = (await call('pos.recent', {}))[0]
  if (!(sale.change_given > 0)) throw new Error('the change given was not recorded')
  // close the shift (the Z report opens in the print window)
  await page.getByRole('button', { name: 'Close shift' }).click()
  await page.waitForSelector('text=Close the shift', { timeout: 5000 })
  await page.locator('input.input').last().fill(String(st.shift.cash.expected))
  const waitZ = app.waitForEvent('window', { timeout: 15000 })
  await page.getByTestId('pos-close-confirm').click()
  const zw = await waitZ
  await zw.waitForLoadState('domcontentloaded')
  await zw.waitForSelector('.sheet', { timeout: 15000 })
  const zText = await zw.locator('.sheet').first().innerText()
  await zw.screenshot({ path: join(out, '32e-pos-shift-report.png'), fullPage: true })
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().includes('/print/'))?.close())
  if (!/Shift Report \(Z\)/i.test(zText) || !/drawer should hold/i.test(zText)) throw new Error('the shift report did not print: ' + zText.slice(0, 200))
  if ((await call('pos.status')).shift !== null) throw new Error('the shift is still open after closing')
  await page.evaluate(() => (window.location.hash = '#/'))
  console.log('POS OK: module switch, shift, tile add, cash with change, shift closed with a printed Z report')
}

// ---- ERP modules: switch on from Settings, then cheque, service ticket, salary sheet, reorder and barcode labels ----
{
  const call = (m, a) => page.evaluate(([m, a]) => window.dt.call(m, a), [m, a])
  for (const label of ['Staff & Salary', 'Cheques', 'Service & Warranty', 'Reorder Planning']) {
    if ((await page.locator('aside a', { hasText: label }).count()) !== 0) throw new Error(`${label} shows in the menu before it is switched on`)
  }
  await page.evaluate(() => (window.location.hash = '#/settings?tab=customize'))
  await page.waitForSelector('text=POS and ERP modules', { timeout: 10000 })
  // module order in the card: pos, hr, cheques, service, reorder (one at a time so each save sees the previous one)
  const sw = page.locator('[role=switch]')
  for (const [i, label] of [[1, 'Staff & Salary'], [2, 'Cheques'], [3, 'Service & Warranty'], [4, 'Reorder Planning']]) {
    await sw.nth(i).click()
    await page.waitForSelector(`aside a:has-text("${label}")`, { timeout: 10000 })
  }
  await page.screenshot({ path: join(out, '33a-erp-modules-on.png') })

  // --- Cheques: record a cheque received from a customer, then clear it into an account ---
  const customer = (await call('parties.list', { type: 'customer' }))[0]
  const accounts = await call('accounts.list')
  const bank = accounts.find((a) => a.type === 'bank') ?? accounts[0]
  await call('cheques.save', { direction: 'received', chequeNo: 'CHQ-E2E-1', bank: 'HBL', partyId: customer.id, amount: 15000, chequeDate: new Date(Date.now() - 86400000).toISOString().slice(0, 10) })
  await page.evaluate(() => (window.location.hash = '#/cheques'))
  await page.waitForSelector('text=CHQ-E2E-1', { timeout: 10000 })
  if (!(await page.locator('text=Overdue').count())) throw new Error('a cheque past its date was not shown as overdue')
  await page.screenshot({ path: join(out, '33b-cheques.png') })
  await page.getByRole('button', { name: 'Cleared' }).first().click()
  await page.waitForSelector('text=Book the payment', { timeout: 5000 })
  await page.locator('select').last().selectOption(String(bank.id))
  await page.getByRole('button', { name: 'Book the payment' }).click()
  await page.waitForSelector('text=Payment received and booked', { timeout: 10000 })
  const chq = (await call('cheques.list', {})).find((c) => c.cheque_no === 'CHQ-E2E-1')
  if (chq.status !== 'cleared') throw new Error('the cheque was not cleared: ' + chq.status)

  // --- Service: open a ticket, work it, resolve it ---
  await page.evaluate(() => (window.location.hash = '#/service'))
  await page.waitForSelector('text=Service and warranty', { timeout: 10000 })
  await page.getByRole('button', { name: 'New ticket' }).click()
  await page.getByLabel(/Or write the name/).fill('Walk-in Mr Tariq').catch(async () => {
    await page.locator('input.input').nth(2).fill('Walk-in Mr Tariq')
  })
  await page.locator('textarea').first().fill('Inverter shows E04 and stops after ten minutes')
  await page.getByRole('button', { name: 'Save ticket' }).click()
  await page.waitForSelector('text=Start work', { timeout: 10000 })
  await page.getByRole('button', { name: 'Start work' }).click()
  await page.getByPlaceholder(/What happened/).fill('Called the customer, visit fixed for tomorrow')
  await page.getByRole('button', { name: 'Add', exact: true }).click()
  await page.waitForSelector('text=Called the customer', { timeout: 5000 })
  await page.getByRole('button', { name: 'Mark resolved' }).click()
  await page.waitForSelector('text=What was done to fix it', { timeout: 5000 })
  await page.locator('textarea').last().fill('Replaced the cooling fan and updated the firmware')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await page.waitForSelector('text=Marked resolved', { timeout: 10000 })
  const ticket = (await call('service.list', {}))[0]
  if (ticket.status !== 'resolved' || !ticket.resolution) throw new Error('the ticket was not resolved: ' + JSON.stringify(ticket))
  await page.screenshot({ path: join(out, '33c-service.png') })
  await page.keyboard.press('Escape')

  // --- HR: add an employee in the screen, mark one absent day, prepare and pay the salary sheet ---
  await page.evaluate(() => (window.location.hash = '#/hr'))
  await page.waitForSelector('text=Staff and salary', { timeout: 10000 })
  await page.getByRole('button', { name: 'New employee' }).click()
  await page.getByRole('dialog').getByLabel('Name').fill('Bilal Ahmed')
  await page.getByRole('dialog').getByLabel('Salary per month').fill('30000')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await page.waitForSelector('td:has-text("Bilal Ahmed")', { timeout: 10000 })
  const emp = (await call('hr.employees', {})).find((e) => e.name === 'Bilal Ahmed')
  if (!emp || emp.salary !== 30000) throw new Error('the employee was not saved correctly: ' + JSON.stringify(emp))
  const month = new Date().toISOString().slice(0, 7)
  await call('hr.mark', { employeeId: emp.id, date: `${month}-01`, status: 'absent' })
  await page.getByRole('button', { name: 'Attendance', exact: true }).click()
  await page.waitForSelector('td:has-text("Bilal Ahmed")', { timeout: 10000 })
  await page.screenshot({ path: join(out, '33d-attendance.png') })
  await page.getByRole('button', { name: 'Salary sheet', exact: true }).click()
  await page.getByRole('button', { name: 'Prepare salary sheet' }).click()
  await page.waitForSelector('text=Pay the salaries', { timeout: 10000 })
  const days = new Date(Number(month.slice(0, 4)), Number(month.slice(5)), 0).getDate()
  const expectedNet = Math.round((30000 - 30000 / days) * 100) / 100
  const sheet = (await call('hr.payrolls'))[0]
  const detail = await call('hr.payroll', { id: sheet.id })
  const mine = detail.lines.find((l) => l.name === 'Bilal Ahmed')
  if (Math.abs(mine.net - expectedNet) > 0.01) throw new Error(`salary net is ${mine.net}, expected ${expectedNet}`)
  await page.screenshot({ path: join(out, '33e-salary-sheet.png') })
  await page.getByRole('button', { name: 'Pay the salaries' }).click()
  await page.getByRole('button', { name: /^Pay .*\d/ }).click()
  await page.waitForSelector('text=Salaries paid and booked', { timeout: 10000 })
  if ((await call('hr.payroll', { id: sheet.id })).run.status !== 'posted') throw new Error('the salary sheet was not posted')
  const waitPay = app.waitForEvent('window', { timeout: 15000 })
  await call('print.open', { kind: 'payroll', id: sheet.id })
  const payWin = await waitPay
  await payWin.waitForLoadState('domcontentloaded')
  await payWin.waitForSelector('.sheet', { timeout: 15000 })
  const payText = await payWin.locator('.sheet').first().innerText()
  await payWin.screenshot({ path: join(out, '33f-payroll-print.png'), fullPage: true })
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().includes('/print/'))?.close())
  if (!/Salary Sheet/i.test(payText) || !/Bilal Ahmed/.test(payText)) throw new Error('the salary sheet did not print: ' + payText.slice(0, 200))
  await page.keyboard.press('Escape')

  // --- Reorder: an item below its level shows with a supplier and becomes a purchase order ---
  const supplier = (await call('parties.list', { type: 'supplier' }))[0]
  const item = (await call('products.list', { limit: 500, active: 'active' })).rows.find((p) => p.type === 'goods' && p.sale_price > 0 && !p.track_serial)
  const full = await call('products.get', { id: item.id })
  const saveItem = (patch) => call('products.save', { id: item.id, name: full.name, type: full.type, unit: full.unit, categoryId: full.category_id, sku: full.sku ?? '', barcode: full.barcode ?? '', brand: full.brand ?? '', model: full.model ?? '', purchasePrice: full.purchase_price ?? 0, salePrice: full.sale_price, taxRate: full.tax_rate, warrantyMonths: full.warranty_months ?? 0, isActive: true, ...patch })
  await saveItem({ reorderLevel: Math.ceil(item.stock) + 10 })
  await page.evaluate(() => (window.location.hash = '#/reorder'))
  await page.waitForSelector(`td:has-text("${item.name}")`, { timeout: 10000 })
  await page.getByLabel(`Supplier for ${item.name}`).selectOption(String(supplier.id))
  await page.screenshot({ path: join(out, '33g-reorder.png') })
  const poBefore = (await call('docs.list', { docType: 'purchase_order' })).length
  const pickedOthers = await page.locator('input[type=checkbox][aria-label^="Order "]').count()
  for (let i = 0; i < pickedOthers; i++) {
    const box = page.locator('input[type=checkbox][aria-label^="Order "]').nth(i)
    if ((await box.getAttribute('aria-label')) !== `Order ${item.name}`) await box.uncheck()
  }
  await page.getByRole('button', { name: /Make purchase orders/ }).click()
  await page.waitForSelector('text=Purchase orders made', { timeout: 10000 })
  if ((await call('docs.list', { docType: 'purchase_order' })).length !== poBefore + 1) throw new Error('the purchase order was not made')

  // --- Barcode labels: the POS module is on, so Inventory can give barcodes and print the label sheet ---
  await saveItem({ barcode: '', reorderLevel: 0 })
  await page.evaluate(() => (window.location.hash = '#/inventory'))
  await page.getByLabel(`Select ${item.name}`).check({ timeout: 10000 })
  await page.getByRole('button', { name: 'Assign barcodes' }).click()
  await page.waitForSelector('text=got a barcode', { timeout: 10000 })
  const waitLab = app.waitForEvent('window', { timeout: 15000 })
  await page.getByLabel(`Select ${item.name}`).check().catch(() => undefined)
  await page.getByRole('button', { name: 'Print labels' }).click()
  const labWin = await waitLab
  await labWin.waitForLoadState('domcontentloaded')
  await labWin.waitForSelector('.sheet svg rect', { timeout: 15000 })
  await labWin.screenshot({ path: join(out, '33h-barcode-labels.png'), fullPage: true })
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().includes('/print/'))?.close())

  // --- switch every module off again: menu entries go, data stays ---
  await page.evaluate(() => (window.location.hash = '#/settings?tab=customize'))
  await page.waitForSelector('text=POS and ERP modules', { timeout: 10000 })
  for (const [i, label] of [[1, 'Staff & Salary'], [2, 'Cheques'], [3, 'Service & Warranty'], [4, 'Reorder Planning']]) {
    await page.locator('[role=switch]').nth(i).click()
    await page.waitForSelector(`aside a:has-text("${label}")`, { state: 'detached', timeout: 10000 })
  }
  const off = await page.evaluate(() => window.dt.call('cheques.list', {}).then(() => 'open', (e) => String(e?.message ?? e)))
  if (!/switched off/i.test(off)) throw new Error('the cheque screen still answers when the module is off: ' + off)
  await page.locator('[role=switch]').first().click()
  await page.waitForSelector('aside a:has-text("POS Counter")', { state: 'detached', timeout: 10000 })
  await page.evaluate(() => (window.location.hash = '#/'))
  console.log('ERP OK: modules switched on from Settings, cheque cleared into a bank account, service ticket opened and resolved, employee added, salary sheet paid and printed, reorder made a purchase order, barcode labels printed, all switched off again and refused by the server')
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
