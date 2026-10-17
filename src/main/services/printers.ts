/**
 * Printer selection and paper sizes (owner: access area).
 *
 * Pure functions only (no Electron imports) so the rules can be unit-tested:
 *  - which configured printer a print job goes to (by print kind and, for documents, the document type),
 *  - the page size handed to Electron for printing (microns) and for PDF export (inches),
 *  - whether the job may print silently (only when "print directly" is on AND a printer is configured and present).
 */

export const PAPER_SIZES = ['A4', 'A5', 'Letter', 'Legal', 'thermal80', 'thermal58'] as const
export type PaperSize = (typeof PAPER_SIZES)[number]

export const PAPER_LABELS: Record<PaperSize, string> = {
  A4: 'A4 (210 × 297 mm)',
  A5: 'A5 (148 × 210 mm)',
  Letter: 'Letter (8.5 × 11 in)',
  Legal: 'Legal (8.5 × 14 in)',
  thermal80: 'Thermal roll 80 mm',
  thermal58: 'Thermal roll 58 mm'
}

/** Which configured printer a job uses. */
export type PrinterRole = 'invoice' | 'quotation' | 'report' | 'receipt'

export const PRINTER_SETTING: Record<PrinterRole, string> = {
  invoice: 'printer_invoice',
  quotation: 'printer_quotation',
  report: 'printer_report',
  receipt: 'printer_receipt'
}

/** Print kinds rendered by the print window (src/renderer/src/print/PrintView.tsx). */
const REPORT_KINDS = new Set(['report', 'stock', 'statement', 'project', 'material', 'closing'])

export function isPaperSize(v: unknown): v is PaperSize {
  return typeof v === 'string' && (PAPER_SIZES as readonly string[]).includes(v)
}

export function isThermal(p: PaperSize): boolean {
  return p === 'thermal80' || p === 'thermal58'
}

/** 'doc' → invoice printer (quotation printer for quotations), 'payment' → receipt printer, reports → report printer. */
export function printerRoleFor(kind: string, docType?: string | null): PrinterRole | null {
  if (kind === 'doc') return docType === 'quotation' ? 'quotation' : 'invoice'
  if (kind === 'payment' || kind === 'receipt') return 'receipt'
  if (REPORT_KINDS.has(kind)) return 'report'
  return null
}

/** Thermal roll width in mm; height is one A4 length per page (drivers cut at the end of the job). */
const THERMAL_MM: Record<'thermal80' | 'thermal58', number> = { thermal80: 80, thermal58: 58 }
const ROLL_PAGE_MM = 297

export type PrintPageSize = 'A4' | 'A5' | 'Letter' | 'Legal' | { width: number; height: number }

/** Page size for webContents.print() - named sizes or { width, height } in MICRONS. */
export function printPageSize(paper: PaperSize): PrintPageSize {
  if (isThermal(paper)) return { width: THERMAL_MM[paper as 'thermal80' | 'thermal58'] * 1000, height: ROLL_PAGE_MM * 1000 }
  return paper as 'A4' | 'A5' | 'Letter' | 'Legal'
}

/** Page size for webContents.printToPDF() - named sizes or { width, height } in INCHES. */
export function pdfPageSize(paper: PaperSize): PrintPageSize {
  if (isThermal(paper)) {
    const w = THERMAL_MM[paper as 'thermal80' | 'thermal58'] / 25.4
    return { width: Math.round(w * 1000) / 1000, height: Math.round((ROLL_PAGE_MM / 25.4) * 1000) / 1000 }
  }
  return paper as 'A4' | 'A5' | 'Letter' | 'Legal'
}

export interface PrintJobInput {
  kind: string
  docType?: string | null
  /** Paper requested by the caller (print window ?paper=…); falls back to the paper_size setting. */
  paper?: unknown
  settings: Record<string, unknown>
  /** Printer names the operating system reports right now. When given, a configured printer missing from it is not used. */
  available?: string[] | null
  /** Page orientation chosen by the print window ('landscape' for wide reports); ignored for thermal rolls. */
  orientation?: unknown
}

export interface PrintJob {
  role: PrinterRole | null
  /** Setting the printer came from (printer_invoice …, printer_default) or null. */
  source: string | null
  /** Printer to send to (null → let the user choose in the print dialog). */
  printer: string | null
  /** A printer is configured but the OS does not list it. */
  missing: string | null
  paper: PaperSize
  pageSize: PrintPageSize
  pdfPageSize: PrintPageSize
  silent: boolean
  marginType: 'default' | 'none'
  /** A4/A5/Letter/Legal turned sideways (wide reports). Always false on thermal rolls. */
  landscape: boolean
}

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')

/**
 * Decides printer, paper and silent mode for one print job.
 * Thermal rolls apply to documents and receipts; reports/statements fall back to A4 unless the caller asked
 * for a specific paper, because their layout needs a full sheet.
 */
export function resolvePrintJob(input: PrintJobInput): PrintJob {
  const s = input.settings ?? {}
  const role = printerRoleFor(input.kind, input.docType)
  const roleKey = role ? PRINTER_SETTING[role] : null
  let printer: string | null = null
  let source: string | null = null
  if (roleKey && str(s[roleKey])) {
    printer = str(s[roleKey])
    source = roleKey
  } else if (str(s.printer_default)) {
    printer = str(s.printer_default)
    source = 'printer_default'
  }
  let missing: string | null = null
  if (printer && Array.isArray(input.available) && !input.available.includes(printer)) {
    missing = printer
    printer = null
  }

  let paper: PaperSize
  if (isPaperSize(input.paper)) paper = input.paper
  else {
    const def = isPaperSize(s.paper_size) ? s.paper_size : 'A4'
    paper = isThermal(def) && role === 'report' ? 'A4' : def
  }

  return {
    role,
    source,
    printer,
    missing,
    paper,
    pageSize: printPageSize(paper),
    pdfPageSize: pdfPageSize(paper),
    silent: !!s.print_direct && !!printer,
    marginType: isThermal(paper) ? 'none' : 'default',
    landscape: !isThermal(paper) && input.orientation === 'landscape'
  }
}

/**
 * Options for webContents.printToPDF(), shared by Save PDF (print.pdf), the page view and WhatsApp attachments
 * (renderToPdf) so every PDF path paginates the same way:
 *  - sheets (A4 …): the page size AND margins come from the print CSS (@page in the print window: size, orientation,
 *    margins and the "Page x of y" footer), so the PDF equals the preview's page view and the physical print;
 *  - thermal rolls: the receipt sets @page 80mm x <content height> (one continuous strip, by design) and no margins.
 */
export function pdfOptionsFor(job: Pick<PrintJob, 'paper' | 'pdfPageSize' | 'landscape'>): {
  pageSize: PrintPageSize
  printBackground: true
  preferCSSPageSize: true
  landscape: boolean
  margins?: { top: number; bottom: number; left: number; right: number }
} {
  const thermal = isThermal(job.paper)
  return {
    pageSize: job.pdfPageSize,
    printBackground: true,
    preferCSSPageSize: true,
    landscape: !thermal && job.landscape,
    ...(thermal ? { margins: { top: 0.08, bottom: 0.08, left: 0.08, right: 0.08 } } : {})
  }
}

/** Reads `#/print/<kind>/<id>` from a print window URL. */
export function parsePrintUrl(url: string): { kind: string; id: number } | null {
  const m = /#\/print\/([^/?#]+)\/(\d+)/.exec(url ?? '')
  if (!m) return null
  return { kind: decodeURIComponent(m[1]), id: Number(m[2]) }
}

/* ------------------------------------------------ OS printer list ------------------------------------------------ */

export interface OsPrinter {
  name: string
  displayName: string
  description: string
  isDefault: boolean
  /** Human readable status when the OS reports one (e.g. "Ready", "Offline", "Paused"). */
  status: string | null
  location: string | null
}

interface ElectronPrinterLike {
  name: string
  displayName?: string
  description?: string
  options?: Record<string, string> | unknown
  isDefault?: boolean
  status?: number
}

/** Extra facts from the Windows printer list (PowerShell Get-CimInstance Win32_Printer). */
export interface WinPrinterFacts {
  Name: string
  Default?: boolean
  WorkOffline?: boolean
  PrinterStatus?: number
  PortName?: string
  Location?: string | null
}

const CUPS_STATES: Record<string, string> = { '3': 'Ready', '4': 'Printing', '5': 'Stopped' }
/** Win32_Printer.PrinterStatus values. */
const WIN_STATUS: Record<number, string> = { 1: 'Other', 2: 'Unknown', 3: 'Ready', 4: 'Printing', 5: 'Warming up', 6: 'Stopped printing', 7: 'Offline' }

/** Parses the JSON printed by `Get-CimInstance Win32_Printer | ConvertTo-Json` (single object or array). */
export function parseWinPrinterJson(text: string): WinPrinterFacts[] {
  try {
    const v = JSON.parse(text) as unknown
    const arr = Array.isArray(v) ? v : v && typeof v === 'object' ? [v] : []
    return arr.filter((x): x is WinPrinterFacts => !!x && typeof (x as WinPrinterFacts).Name === 'string')
  } catch {
    return []
  }
}

/** Parses `lpstat -d` ("system default destination: NAME"). */
export function parseLpstatDefault(text: string): string | null {
  const m = /system default destination:\s*(\S+)/i.exec(text ?? '')
  return m ? m[1] : null
}

/**
 * Normalises the printers Electron reports, enriched with OS facts when available. Only printers the OS lists
 * are returned - nothing is ever invented.
 */
export function normalizePrinters(list: ElectronPrinterLike[], win: WinPrinterFacts[] = [], cupsDefault: string | null = null): OsPrinter[] {
  const facts = new Map(win.map((w) => [w.Name, w]))
  return (list ?? [])
    .filter((p) => p && typeof p.name === 'string' && p.name)
    .map((p) => {
      const opts = (p.options && typeof p.options === 'object' ? p.options : {}) as Record<string, string>
      const w = facts.get(p.name)
      let status: string | null = null
      if (w) status = w.WorkOffline ? 'Offline' : (w.PrinterStatus !== undefined && WIN_STATUS[w.PrinterStatus]) || null
      else if (opts['printer-state']) status = CUPS_STATES[String(opts['printer-state'])] ?? null
      const reasons = String(opts['printer-state-reasons'] ?? '')
      if (!w && reasons && reasons !== 'none' && /offline/i.test(reasons)) status = 'Offline'
      const isDefault = typeof p.isDefault === 'boolean' ? p.isDefault : w ? !!w.Default : cupsDefault ? cupsDefault === p.name : false
      return {
        name: p.name,
        displayName: p.displayName || p.name,
        description: p.description || opts['printer-make-and-model'] || '',
        isDefault,
        status,
        location: (w?.Location || opts['printer-location'] || '') || null
      }
    })
    .sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || a.displayName.localeCompare(b.displayName))
}

/** Friendly text for the failure reasons Chromium/Electron report from webContents.print(). */
export function printFailureText(reason: string | null | undefined): string {
  const r = String(reason ?? '').trim()
  if (!r) return 'The printer did not accept the job.'
  if (/invalid deviceName/i.test(r)) return 'The printer is not available on this computer (Windows does not list it).'
  if (/cancel/i.test(r)) return 'Printing was cancelled.'
  if (/Print job failed/i.test(r)) return 'The printer reported an error while printing (check that it is switched on, connected and has paper).'
  return r
}

/* ------------------------------------------------ PDF inspection ------------------------------------------------ */

/** Number of pages in a PDF produced by Chromium (counts '/Type /Page' objects, not the '/Type /Pages' tree). */
export function countPdfPages(pdf: Uint8Array): number {
  const s = Buffer.from(pdf).toString('latin1')
  return (s.match(/\/Type\s*\/Page(?![a-zA-Z])/g) ?? []).length
}

/** MediaBox [x0 y0 x1 y1] of each page (in points); a box inherited from the page tree is applied. */
export function pdfPageBoxes(pdf: Uint8Array): Array<[number, number, number, number] | null> {
  const s = Buffer.from(pdf).toString('latin1')
  const parse = (t: string): [number, number, number, number] => t.trim().split(/\s+/).map((n) => Math.round(Number(n))) as [number, number, number, number]
  const tree = /\/Type\s*\/Pages[^]*?\/MediaBox\s*\[([\d.\s-]+)\]/.exec(s)
  const out: Array<[number, number, number, number] | null> = []
  const re = /\/Type\s*\/Page(?![a-zA-Z])/g
  let m: RegExpExecArray | null
  while ((m = re.exec(s))) {
    const start = s.lastIndexOf(' obj', m.index)
    const end = s.indexOf('endobj', m.index)
    const box = /\/MediaBox\s*\[([\d.\s-]+)\]/.exec(s.slice(Math.max(0, start), end < 0 ? undefined : end))
    out.push(box ? parse(box[1]) : tree ? parse(tree[1]) : null)
  }
  return out
}
