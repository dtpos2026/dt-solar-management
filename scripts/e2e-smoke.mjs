/**
 * End-to-end smoke test: launches the built Electron app with an isolated data folder,
 * completes the first-run wizard (with demo data), visits every screen, takes screenshots,
 * opens print previews and renders them to PDF.
 *
 * Usage (Linux CI / headless):  npx electron-vite build && xvfb-run -a node scripts/e2e-smoke.mjs [playwright-module-path]
 * Output: e2e-output/ (screenshots, PDFs, console-errors.txt)
 */
import { mkdirSync, rmSync, writeFileSync } from 'fs'
import { createRequire } from 'module'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { tmpdir } from 'os'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const { _electron: electron } = require(process.argv[2] || 'playwright')

const out = join(root, 'e2e-output')
rmSync(out, { recursive: true, force: true })
mkdirSync(out, { recursive: true })
const userData = join(tmpdir(), `dtsp-e2e-${process.pid}`)
rmSync(userData, { recursive: true, force: true })

const errors = []
const app = await electron.launch({
  executablePath: join(root, 'node_modules/electron/dist/electron'),
  args: [root, '--no-sandbox'],
  env: { ...process.env, DTSP_USER_DATA: userData, ELECTRON_ENABLE_LOGGING: '1' }
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
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
page.on('console', (m) => m.type() === 'error' && errors.push(`console: ${m.text()}`))
await page.setViewportSize({ width: 1440, height: 900 }).catch(() => undefined)
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
  ['26-license', '#/license'],
  ['27-new-invoice', '#/doc/new/sale_invoice']
]
for (const [name, hash] of screens) {
  await page.evaluate((h) => (window.location.hash = h), hash)
  await page.waitForTimeout(1300)
  await page.screenshot({ path: join(out, `${name}.png`) })
}

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

writeFileSync(join(out, 'console-errors.txt'), errors.join('\n') || 'No console errors.')
console.log(`Screens captured in ${out}. Errors: ${errors.length}`)
for (const e of errors.slice(0, 40)) console.log(' -', e)
await app.close()
rmSync(userData, { recursive: true, force: true })
