/**
 * Print / PDF pagination contract: A4 sheets paginate with CSS page rules ("Page x of y", orientation),
 * the 80 mm thermal roll stays a single strip and never leaks into sheet prints.
 */
import { describe, expect, it } from 'vitest'
import { countPdfPages, pdfOptionsFor, pdfPageBoxes, resolvePrintJob } from '../src/main/services/printers'

// renderer module (outside the node tsconfig): loaded by path so the node typecheck does not pull in renderer sources
const rendererModule = '../src/renderer/src/print/pageRules'
const { sheetPageCss } = (await import(rendererModule)) as { sheetPageCss: (paper: string, orientation: 'portrait' | 'landscape') => string }

const pdf = (pages: Array<string | null>, tree = '0 0 595 842'): Uint8Array => {
  const objs = pages.map((box, i) => `${i + 3} 0 obj\n<</Type /Page\n/Parent 2 0 R${box ? `\n/MediaBox [${box}]` : ''}>>\nendobj`)
  return Buffer.from(`%PDF-1.4\n2 0 obj\n<</Type /Pages\n/Count ${pages.length}\n/MediaBox [${tree}]>>\nendobj\n${objs.join('\n')}\n%%EOF`, 'latin1')
}

describe('PDF inspection', () => {
  it('counts page objects, not the page tree', () => {
    expect(countPdfPages(pdf(['0 0 595 842', '0 0 595 842', '0 0 595 842']))).toBe(3)
    expect(countPdfPages(pdf([]))).toBe(0)
  })
  it('reads each MediaBox and falls back to the inherited one', () => {
    expect(pdfPageBoxes(pdf(['0 0 842 595', null]))).toEqual([
      [0, 0, 842, 595],
      [0, 0, 595, 842]
    ])
    expect(pdfPageBoxes(pdf(['0 0 595.28 841.89']))).toEqual([[0, 0, 595, 842]])
  })
})

describe('print jobs', () => {
  const settings = { paper_size: 'A4' }
  it('A4 sheets: CSS page size, landscape on request, default margins', () => {
    const job = resolvePrintJob({ kind: 'report', settings, orientation: 'landscape' })
    expect(job).toMatchObject({ paper: 'A4', pageSize: 'A4', landscape: true, marginType: 'default' })
    expect(pdfOptionsFor(job)).toEqual({ pageSize: 'A4', printBackground: true, preferCSSPageSize: true, landscape: true })
    expect(resolvePrintJob({ kind: 'doc', settings }).landscape).toBe(false)
  })
  it('thermal rolls never turn landscape and print without margins', () => {
    const job = resolvePrintJob({ kind: 'payment', paper: 'thermal80', settings, orientation: 'landscape' })
    expect(job.landscape).toBe(false)
    expect(job.marginType).toBe('none')
    const o = pdfOptionsFor(job)
    expect(o.landscape).toBe(false)
    expect(o.margins).toEqual({ top: 0.08, bottom: 0.08, left: 0.08, right: 0.08 })
  })
  it('a thermal default paper does not apply to reports (they need a full sheet)', () => {
    expect(resolvePrintJob({ kind: 'statement', settings: { paper_size: 'thermal80' } }).paper).toBe('A4')
    expect(resolvePrintJob({ kind: 'closing', settings: { paper_size: 'thermal80' } }).paper).toBe('A4')
  })
})

describe('sheet page rules', () => {
  it('sets size + orientation, margins and a "Page x of y" footer', () => {
    const css = sheetPageCss('A4', 'portrait')
    expect(css).toContain('size: A4 portrait')
    expect(css).toContain('margin: 10mm 0 12mm 0')
    expect(css).toContain('counter(page)')
    expect(css).toContain('counter(pages)')
    expect(css).toContain('width: 210mm; min-height: 297mm')
  })
  it('landscape swaps the on-screen sheet', () => {
    const css = sheetPageCss('A4', 'landscape')
    expect(css).toContain('size: A4 landscape')
    expect(css).toContain('width: 297mm; min-height: 210mm')
  })
  it('never sets a fixed sheet height in print (pages must flow)', () => {
    const print = sheetPageCss('A4', 'portrait').split('@media print')[1]
    expect(print).toContain('min-height: auto')
  })
})
