/**
 * Electron printing helpers (owner: access area): OS printer list, printing a WebContents with the OS result,
 * and the printer test page. Printer/paper rules live in services/printers.ts (pure, unit-tested).
 */
import { BrowserWindow, WebContents } from 'electron'
import { execFile } from 'child_process'
import { hostname } from 'os'
import {
  type OsPrinter,
  type PaperSize,
  type PrintPageSize,
  isThermal,
  normalizePrinters,
  parseLpstatDefault,
  parseWinPrinterJson,
  printPageSize,
  PAPER_LABELS,
  type WinPrinterFacts
} from './services/printers'

function run(cmd: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve) => {
    try {
      execFile(cmd, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 1024 * 1024 }, (err, stdout) => resolve(err ? '' : String(stdout ?? '')))
    } catch {
      resolve('')
    }
  })
}

let winCache: { at: number; facts: WinPrinterFacts[] } | null = null

/** Windows: default flag + online/offline status from Win32_Printer (best effort, cached 30 s). */
async function windowsPrinterFacts(): Promise<WinPrinterFacts[]> {
  if (process.platform !== 'win32') return []
  if (winCache && Date.now() - winCache.at < 30000) return winCache.facts
  const out = await run(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      'Get-CimInstance -ClassName Win32_Printer | Select-Object Name,Default,WorkOffline,PrinterStatus,PortName,Location | ConvertTo-Json -Compress'
    ],
    6000
  )
  const facts = parseWinPrinterJson(out)
  winCache = { at: Date.now(), facts }
  return facts
}

/** Linux/macOS (CUPS): the system default destination, when lpstat is installed. */
async function cupsDefault(): Promise<string | null> {
  if (process.platform === 'win32') return null
  return parseLpstatDefault(await run('lpstat', ['-d'], 2500))
}

/** Printers the operating system reports right now (never invented; empty when there are none). */
export async function listOsPrinters(wc: WebContents): Promise<OsPrinter[]> {
  const list = await wc.getPrintersAsync()
  if (!list.length) return []
  const [facts, def] = await Promise.all([windowsPrinterFacts(), cupsDefault()])
  return normalizePrinters(list as never, facts, def)
}

export interface PrintOutcome {
  ok: boolean
  /** Failure reason reported by the OS / Chromium ('' on success). */
  reason: string
}

/** Prints a WebContents and resolves with the OS callback result (never rejects). */
export function printWebContents(
  wc: WebContents,
  opts: { silent: boolean; deviceName?: string | null; pageSize: PrintPageSize; marginType: 'default' | 'none'; landscape?: boolean; timeoutMs?: number }
): Promise<PrintOutcome> {
  return new Promise((resolve) => {
    let done = false
    const finish = (o: PrintOutcome): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve(o)
    }
    const timer = setTimeout(() => finish({ ok: false, reason: 'The printer did not answer in time (timeout).' }), opts.timeoutMs ?? 120000)
    try {
      wc.print(
        {
          silent: opts.silent,
          printBackground: true,
          ...(opts.deviceName ? { deviceName: opts.deviceName } : {}),
          pageSize: opts.pageSize,
          landscape: !!opts.landscape,
          // 'default' keeps the print CSS margins (@page), so the paper matches Save PDF and the page view
          margins: { marginType: opts.marginType }
        },
        (success, failureReason) => finish({ ok: !!success, reason: success ? '' : String(failureReason ?? '') })
      )
    } catch (e) {
      finish({ ok: false, reason: (e as Error).message })
    }
  })
}

let pageViewWin: BrowserWindow | null = null

/**
 * Page view: shows a generated PDF (the exact pages Save PDF / Print produce) in Chromium's built-in PDF viewer.
 * The window has no preload, no Node and cannot navigate away or open other windows. One window is reused.
 */
export async function openPdfPageView(file: string, title: string, parent?: BrowserWindow | null): Promise<void> {
  if (!pageViewWin || pageViewWin.isDestroyed()) {
    pageViewWin = new BrowserWindow({
      width: 1000,
      height: 1000,
      minWidth: 600,
      minHeight: 500,
      title,
      autoHideMenuBar: true,
      backgroundColor: '#525659',
      ...(parent && !parent.isDestroyed() ? { parent } : {}),
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, devTools: false }
    })
    pageViewWin.setMenuBarVisibility(false)
    pageViewWin.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    pageViewWin.webContents.on('will-navigate', (e) => e.preventDefault())
    pageViewWin.on('closed', () => {
      pageViewWin = null
    })
  }
  pageViewWin.setTitle(title)
  await pageViewWin.loadFile(file)
  pageViewWin.show()
  pageViewWin.focus()
}

const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)

export function testPageHtml(printer: string, paper: PaperSize, appVersion: string): string {
  const thermal = isThermal(paper)
  const now = new Date().toLocaleString('en-GB')
  const ruler = thermal
    ? ''
    : `<div class="ruler">${Array.from({ length: 11 }, (_, i) => `<span style="left:${i}cm">${i}</span>`).join('')}</div><div class="cap">10 cm ruler — measure it to check the scale is 100%.</div>`
  return `<!doctype html><html><head><meta charset="utf-8"><title>Printer test</title><style>
@page { margin: ${thermal ? '2mm' : '12mm'}; }
* { box-sizing: border-box; }
body { margin: 0; font-family: 'Segoe UI', Arial, sans-serif; color: #000; font-size: ${thermal ? '9pt' : '11pt'}; }
.box { border: ${thermal ? '1px dashed #000' : '2px solid #000'}; padding: ${thermal ? '2mm' : '6mm'}; }
h1 { margin: 0 0 2mm; font-size: ${thermal ? '12pt' : '18pt'}; }
p { margin: 0 0 3mm; }
table { border-collapse: collapse; width: 100%; margin: 2mm 0 4mm; }
td { padding: 1mm 0; vertical-align: top; }
td:first-child { width: ${thermal ? '40%' : '30%'}; font-weight: 600; }
.ruler { position: relative; height: 8mm; width: 10cm; border-bottom: 1px solid #000; margin-top: 4mm; }
.ruler span { position: absolute; bottom: 0; border-left: 1px solid #000; height: 4mm; font-size: 7pt; padding-left: 1px; }
.cap { font-size: 8pt; margin-top: 1mm; }
.blocks { display: flex; gap: 2mm; margin-top: 4mm; }
.blocks div { flex: 1; height: ${thermal ? '5mm' : '10mm'}; }
</style></head><body><div class="box">
<h1>DT Solar Pro — printer test</h1>
<p>If you can read this page clearly, the printer is set up correctly.</p>
<table>
<tr><td>Printer</td><td>${esc(printer)}</td></tr>
<tr><td>Paper</td><td>${esc(PAPER_LABELS[paper])}</td></tr>
<tr><td>Printed</td><td>${esc(now)}</td></tr>
<tr><td>Computer</td><td>${esc(hostname())}</td></tr>
<tr><td>App</td><td>DT Solar Pro v${esc(appVersion)}</td></tr>
</table>
<div class="blocks"><div style="background:#000"></div><div style="background:#555"></div><div style="background:#999"></div><div style="background:#ddd"></div></div>
${ruler}
</div></body></html>`
}

/** Prints the test page to `printer` through a hidden window and returns the OS callback result. */
export async function printTestPage(printer: string, paper: PaperSize, appVersion: string): Promise<PrintOutcome> {
  const win = new BrowserWindow({
    show: false,
    width: 900,
    height: 1200,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, javascript: false, devTools: false }
  })
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', (e) => e.preventDefault())
  try {
    await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(testPageHtml(printer, paper, appVersion))}`)
    return await printWebContents(win.webContents, {
      silent: true,
      deviceName: printer,
      pageSize: printPageSize(paper),
      marginType: isThermal(paper) ? 'none' : 'default',
      timeoutMs: 90000
    })
  } finally {
    // Give the spooler a moment to take the job before the window goes away.
    setTimeout(() => {
      if (!win.isDestroyed()) win.destroy()
    }, 1500)
  }
}
