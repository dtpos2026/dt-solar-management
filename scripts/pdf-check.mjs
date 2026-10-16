/**
 * PDF pagination check (release gate for A4 printing).
 *
 * Launches the BUILT Electron app with an isolated data folder, completes the first-run wizard with the demo data,
 * adds long generated documents (invoice with 120 lines + long descriptions, quotation with 60 lines, 200 statement
 * rows), then produces PDFs through the real code paths:
 *   - preview window → "Save PDF" button (route print.pdf, the save dialog is stubbed to a fixed path)
 *   - WhatsApp attachment (route whatsapp.prepare → renderToPdf in a hidden window)
 *   - the preview after switching the template to the 80 mm receipt and back (a thermal @page must not leak)
 * and checks every PDF: page count ('/Type /Page' objects) and /MediaBox per page.
 * A4 docs must be [0 0 595 842] (or 842 x 595 landscape); long docs > 1 page; short docs exactly 1 page.
 *
 * Usage: npx electron-vite build && xvfb-run -a node scripts/pdf-check.mjs [playwright-module-path]
 * Output: pdf-check-output/ (PDFs + results.json). Exit code 1 when a check fails.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { createRequire } from 'module'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { tmpdir } from 'os'

import { buildPayload, certificateToCode, decodeRequestCode, generateKeyPair, signPayload } from './license-core.mjs'
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const { _electron: electron } = require(process.argv[2] || 'playwright')

const out = join(root, 'pdf-check-output')
rmSync(out, { recursive: true, force: true })
mkdirSync(out, { recursive: true })
const userData = join(tmpdir(), `dtsp-pdf-${process.pid}`)
rmSync(userData, { recursive: true, force: true })

/** Page count and MediaBox of every page object (Chromium/Skia writes page dictionaries uncompressed). */
export function inspectPdf(buf) {
  const s = buf.toString('latin1')
  const pages = []
  const re = /\/Type\s*\/Page(?!s)\b/g
  let m
  while ((m = re.exec(s))) {
    // the MediaBox of this page object lies within its dictionary (search a window around the match)
    const start = s.lastIndexOf(' obj', m.index)
    const end = s.indexOf('endobj', m.index)
    const dict = s.slice(start, end)
    const mb = /\/MediaBox\s*\[\s*([\d.\s-]+)\]/.exec(dict)
    pages.push(mb ? mb[1].trim().split(/\s+/).map((n) => Math.round(Number(n))) : null)
  }
  if (pages.some((p) => !p)) {
    const inherited = /\/Type\s*\/Pages[\s\S]*?\/MediaBox\s*\[\s*([\d.\s-]+)\]/.exec(s)
    const box = inherited ? inherited[1].trim().split(/\s+/).map((n) => Math.round(Number(n))) : null
    for (let i = 0; i < pages.length; i++) if (!pages[i]) pages[i] = box
  }
  return { pages: pages.length, boxes: pages }
}

const isA4 = (b, landscape) => {
  if (!b) return false
  const w = b[2] - b[0]
  const h = b[3] - b[1]
  const near = (a, x) => Math.abs(a - x) <= 2
  return landscape ? near(w, 842) && near(h, 595) : near(w, 595) && near(h, 842)
}

const errors = []
// Throwaway test license key (never the real signing key); only honoured by unpackaged builds.
const testKeys = generateKeyPair()
const testPubFile = join(tmpdir(), `dtsp-pdf-key-${process.pid}.pem`)
writeFileSync(testPubFile, testKeys.publicPem)
const app = await electron.launch({
  executablePath: join(root, 'node_modules/electron/dist/electron'),
  args: [root, '--no-sandbox'],
  env: { ...process.env, DTSP_USER_DATA: userData, DTSP_LICENSE_PUBLIC_KEY_FILE: testPubFile, DTSP_CLOUD_DISABLED: '1' }
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

const page = await mainWindow()
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
// License step: offline activation with an activation code signed by the throwaway key.
await page.waitForSelector('text=Offline activation', { timeout: 30000 })
await page.click('[data-testid=lic-offline]')
await page.locator('input[placeholder="DTSP-XXXX-XXXX-XXXX-XXXX"]').fill('DTSPE2E0TEST0KEY0001')
await page.click('button:has-text("Generate request code")')
const req = decodeRequestCode(await page.locator('textarea[readonly]').inputValue({ timeout: 10000 }))
const cert = signPayload(
  buildPayload({ deviceId: req.deviceId ?? req.d, businessName: 'WETCO SOLAR SOLUTIONS', plan: 'trial', maxFirms: 5, maxUsers: 5, expiresAt: new Date(Date.now() + 15 * 86400000).toISOString() }),
  testKeys.privatePem
)
await page.fill('[data-testid=lic-code]', certificateToCode(cert))
await page.click('button:has-text("Install activation code")')
await page.waitForSelector('text=License activated', { timeout: 15000 })
await page.locator('button:has-text("Continue")').last().click()
await page.waitForSelector('text=Business details', { timeout: 30000 })
await page.waitForTimeout(800)
await page.click('button:has-text("Continue")')
await page.waitForSelector('text=Multiple firms')
await page.click('button:has-text("Continue")')
await page.locator('label:has-text("Full name") input').fill('Muhammad Waqas')
await page.locator('input[type=password]').nth(0).fill('admin123')
await page.locator('input[type=password]').nth(1).fill('admin123')
await page.click('button:has-text("Continue")')
await page.click('text=Load sample solar business data')
await page.click('button:has-text("Finish setup")')
await page.waitForSelector('text=Quick Actions', { timeout: 30000 })
await page.waitForTimeout(1000)

const call = (method, args) => page.evaluate(([m, a]) => window.dt.call(m, a), [method, args])

/* ------------------------------------------- demo + generated data ------------------------------------------- */
const today = new Date().toISOString().slice(0, 10)
const invoices = await call('docs.list', { docType: 'sale_invoice' })
const quotes = await call('docs.list', { docType: 'quotation' })
const payments = await call('payments.list', {})
const customers = await call('parties.list', { type: 'customer' })
const projects = await call('projects.list', {})
const project = projects.find((p) => p.status === 'in_progress') ?? projects[0]
const customer = customers[0]

const longText = (i) =>
  `Line ${i + 1}: Monocrystalline PERC half-cut solar module supplied with mounting hardware, MC4 connectors, earthing kit and ` +
  `installation by certified technicians. Includes transport to site, commissioning, performance test report and a ` +
  `${10 + (i % 15)}-year product warranty registered in the customer's name.`
const mkLines = (n) =>
  Array.from({ length: n }, (_, i) => ({ description: `Solar item ${i + 1} — 550 W panel bundle`, details: longText(i), unit: 'pcs', qty: 1 + (i % 7), rate: 1000 + i * 37 }))

const longInvoiceId = await call('docs.create', {
  docType: 'sale_invoice',
  date: today,
  partyId: customer.id,
  deductStock: false,
  lines: mkLines(120),
  notes: 'Generated by pdf-check: 120 lines with long descriptions.'
})
const longQuoteId = await call('docs.create', { docType: 'quotation', date: today, partyId: customer.id, lines: mkLines(60) })
// a customer with 200 statement rows
const stmtParty = await call('parties.save', { type: 'customer', name: 'PDF Check Statement Customer', phone: '03001234567' })
const stmtPartyId = typeof stmtParty === 'object' && stmtParty ? stmtParty.id : stmtParty
for (let i = 0; i < 200; i++) {
  await call('docs.create', { docType: 'sale_invoice', date: today, partyId: stmtPartyId, deductStock: false, lines: [{ description: `Service visit ${i + 1}`, unit: 'job', qty: 1, rate: 500 + i }] })
}
const idOf = (x) => (typeof x === 'object' && x ? x.id : x)

/* ------------------------------------------------- PDF paths ------------------------------------------------- */
async function stubDialog(file) {
  await app.evaluate(({ dialog, shell }, p) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: p })
    shell.openPath = async () => ''
  }, file)
}

async function openPreview(args) {
  const waitWin = app.waitForEvent('window', { timeout: 15000 })
  await call('print.open', args)
  const w = await waitWin
  w.on('pageerror', (e) => errors.push(`${args.kind} pageerror: ${e.message}`))
  await w.waitForSelector('[data-print-ready]', { timeout: 30000 })
  await w.waitForTimeout(800)
  return w
}

const previewPages = {}
/** Preview window → Save PDF button (route print.pdf). Also records the page count the preview toolbar shows. */
async function previewPdf(name, args, before) {
  const w = await openPreview(args)
  if (before) await before(w)
  const counted = await w
    .waitForSelector('[data-pages]', { timeout: 8000 })
    .then((el) => el.getAttribute('data-pages'))
    .catch(() => null)
  previewPages[name] = counted ? Number(counted) : null
  const file = join(out, `${name}.pdf`)
  await stubDialog(file)
  await w.click('button:has-text("Save PDF")')
  for (let i = 0; i < 120 && !existsSync(file); i++) await w.waitForTimeout(250)
  await w.waitForTimeout(300)
  await w.close()
  return file
}

/** WhatsApp attachment (route whatsapp.prepare → renderToPdf). */
async function whatsappPdf(name, entity, id, params) {
  const r = await call('whatsapp.prepare', { entity, id, params, phone: '03001234567', confirmDuplicate: true })
  const file = join(out, `${name}.pdf`)
  const src = await app.evaluate(async (_e, a) => {
    const fs = process.mainModule.require('fs')
    const path = process.mainModule.require('path')
    const dir = path.join(process.env.DTSP_USER_DATA, 'whatsapp-outbox')
    const f = fs.readdirSync(dir).map((n) => path.join(dir, n)).sort((x, y) => fs.statSync(y).mtimeMs - fs.statSync(x).mtimeMs)[0]
    return f ? fs.readFileSync(f).toString('base64') : null
  }, r)
  if (src) writeFileSync(file, Buffer.from(src, 'base64'))
  return file
}

const cases = [
  // name, producer, expectation: 'one' | 'many', landscape?
  ['invoice-demo', () => previewPdf('invoice-demo', { kind: 'doc', id: invoices[0].id }), 'one'],
  ['invoice-120-lines', () => previewPdf('invoice-120-lines', { kind: 'doc', id: idOf(longInvoiceId) }), 'many'],
  ['quotation-demo', () => previewPdf('quotation-demo', { kind: 'doc', id: quotes[0].id }), 'one'],
  ['quotation-60-lines', () => previewPdf('quotation-60-lines', { kind: 'doc', id: idOf(longQuoteId) }), 'many'],
  ['receipt-demo', () => previewPdf('receipt-demo', { kind: 'payment', id: payments[0].id }), 'one'],
  ['statement-demo', () => previewPdf('statement-demo', { kind: 'statement', id: customer.id, params: { from: '2000-01-01', to: '2099-12-31' } }), 'any'],
  ['statement-200-rows', () => previewPdf('statement-200-rows', { kind: 'statement', id: stmtPartyId, params: { from: '2000-01-01', to: '2099-12-31' } }), 'many'],
  ['project-statement', () => previewPdf('project-statement', { kind: 'project', id: project.id }), 'any'],
  ['stock-report', () => previewPdf('stock-report', { kind: 'stock', id: 0, params: {} }), 'any'],
  ['profit-loss', () => previewPdf('profit-loss', { kind: 'report', id: 0, params: { report: 'pl', from: '2000-01-01', to: '2099-12-31' } }), 'any'],
  ['sales-by-invoice', () => previewPdf('sales-by-invoice', { kind: 'report', id: 0, params: { report: 'sales', group: 'document', from: '2000-01-01', to: '2099-12-31' } }), 'many'],
  [
    'invoice-120-after-thermal',
    () =>
      previewPdf('invoice-120-after-thermal', { kind: 'doc', id: idOf(longInvoiceId) }, async (w) => {
        const sel = w.locator('[data-testid=template-select]')
        await sel.waitFor({ timeout: 15000 })
        await sel.selectOption('builtin:thermal80')
        await w.waitForTimeout(800)
        await sel.selectOption('builtin:classic')
        await w.waitForTimeout(800)
      }),
    'many'
  ],
  [
    'stock-report-landscape',
    () =>
      previewPdf('stock-report-landscape', { kind: 'stock', id: 0, params: {} }, async (w) => {
        await w.locator('[data-testid=orientation-select]').selectOption('landscape')
        await w.waitForTimeout(1500)
      }),
    'any',
    true
  ],
  [
    'receipt-thermal80',
    () =>
      previewPdf('receipt-thermal80', { kind: 'payment', id: payments[0].id }, async (w) => {
        await w.locator('[data-testid=template-select]').selectOption('builtin:thermal80')
        await w.waitForTimeout(1000)
      }),
    'thermal'
  ],
  ['whatsapp-invoice-120', () => whatsappPdf('whatsapp-invoice-120', 'document', idOf(longInvoiceId)), 'many'],
  ['whatsapp-statement-200', () => whatsappPdf('whatsapp-statement-200', 'statement', stmtPartyId, { from: '2000-01-01', to: '2099-12-31' }), 'many'],
  ['whatsapp-receipt', () => whatsappPdf('whatsapp-receipt', 'payment', payments[0].id), 'one']
]

const results = []
let failed = 0
for (const [name, produce, expect, landscape] of cases) {
  let file
  try {
    file = await produce()
  } catch (e) {
    results.push({ name, ok: false, error: e.message })
    failed++
    console.log(`FAIL ${name}: ${e.message}`)
    continue
  }
  if (!existsSync(file)) {
    results.push({ name, ok: false, error: 'no PDF written' })
    failed++
    console.log(`FAIL ${name}: no PDF written`)
    continue
  }
  const info = inspectPdf(readFileSync(file))
  // thermal 80 mm: one continuous strip, 80 mm (~227 pt) wide; sheets: A4 in the expected orientation
  const sizeOk =
    expect === 'thermal'
      ? info.pages === 1 && info.boxes.every((b) => b && Math.abs(b[2] - b[0] - 227) <= 2)
      : info.boxes.every((b) => isA4(b, !!landscape))
  const countOk = expect === 'one' || expect === 'thermal' ? info.pages === 1 : expect === 'many' ? info.pages > 1 : info.pages >= 1
  // preview == PDF: the page count shown in the preview toolbar equals the saved PDF (sheet prints only)
  const shown = previewPages[name]
  const previewOk = shown === undefined || expect === 'thermal' || shown === info.pages
  const ok = sizeOk && countOk && previewOk
  if (!ok) failed++
  const sizes = [...new Set(info.boxes.map((b) => (b ? `${b[2] - b[0]}x${b[3] - b[1]}` : '?')))].join(',')
  results.push({ name, ok, pages: info.pages, previewPages: shown ?? null, sizes, expect })
  console.log(
    `${ok ? 'ok  ' : 'FAIL'} ${name.padEnd(28)} pages=${String(info.pages).padStart(3)} preview=${String(shown ?? '-').padStart(3)} size=${sizes} expect=${expect}${landscape ? ' (landscape)' : ''}`
  )
}

/* Page view: the preview's "Page view" button opens the generated PDF in a viewer window. */
try {
  const w = await openPreview({ kind: 'doc', id: idOf(longInvoiceId) })
  const viewWin = app.waitForEvent('window', { timeout: 20000 })
  await w.click('button:has-text("Page view")')
  const v = await viewWin
  await v.waitForLoadState('load', { timeout: 20000 }).catch(() => undefined)
  const url = v.url()
  const ok = /page-view\.pdf$/.test(url)
  if (!ok) failed++
  results.push({ name: 'page-view-window', ok, url })
  console.log(`${ok ? 'ok  ' : 'FAIL'} page-view-window             url=${url}`)
  await v.waitForTimeout(3000)
  await v.screenshot({ path: join(out, 'page-view.png') }).catch(() => undefined)
  await v.close()
  await w.close()
} catch (e) {
  failed++
  results.push({ name: 'page-view-window', ok: false, error: e.message })
  console.log(`FAIL page-view-window: ${e.message}`)
}

writeFileSync(join(out, 'results.json'), JSON.stringify({ results, errors }, null, 2))
if (errors.length) console.log('page errors:\n - ' + errors.slice(0, 20).join('\n - '))
console.log(failed ? `${failed} check(s) FAILED` : 'All PDF checks passed.')
await app.close()
rmSync(userData, { recursive: true, force: true })
process.exit(failed ? 1 : 0)
