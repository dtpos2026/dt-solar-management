/**
 * Page rules for A4 / sheet prints (pure, no imports: unit-tested in tests/print.test.ts).
 */
export type Orientation = 'portrait' | 'landscape'
export type SheetPaper = 'A4' | 'A5' | 'Letter' | 'Legal'
/** Sheet sizes in mm (portrait width x height). */
export const SHEET_MM: Record<SheetPaper, [number, number]> = { A4: [210, 297], A5: [148, 210], Letter: [215.9, 279.4], Legal: [215.9, 355.6] }

/**
 * Page rules for sheet prints (never for the 80 mm receipt, which sets its own continuous @page).
 * Size + orientation, the margins every template is designed for, and a "Page x of y" footer in the bottom margin.
 * Save PDF / WhatsApp use preferCSSPageSize, so the PDF pages follow exactly these rules; Print passes the same
 * paper and orientation to the printer.
 */
export function sheetPageCss(paper: SheetPaper, orientation: Orientation): string {
  const [w, h] = SHEET_MM[paper]
  const [sw, sh] = orientation === 'landscape' ? [h, w] : [w, h]
  return `
@page {
  size: ${paper} ${orientation};
  margin: 10mm 0 12mm 0;
  @bottom-right {
    content: "Page " counter(page) " of " counter(pages);
    font-family: Arial, 'Segoe UI', sans-serif;
    font-size: 8pt;
    color: #718096;
    padding-right: 12mm;
    vertical-align: middle;
  }
}
.print-root .sheet { width: ${sw}mm; min-height: ${sh}mm; }
@media print {
  .print-root .sheet { width: auto; min-height: auto; }
}`
}
