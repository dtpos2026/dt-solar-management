/**
 * Print design = layout + show/hide options used to render a customer document. It comes from a saved template
 * (Settings -> Invoice templates), a built-in layout, or temporary changes in the print preview. A design only
 * changes how a document looks on paper - never the document data.
 */
import type { PrintSettings } from './PrintKit'
import { printOverrides } from '@shared/options'

/* eslint-disable @typescript-eslint/no-explicit-any */
export type Layout = 'classic' | 'modern' | 'compact' | 'thermal80'
export type TemplateKind =
  | 'sale_invoice'
  | 'quotation'
  | 'sale_order'
  | 'delivery_challan'
  | 'sale_return'
  | 'purchase_invoice'
  | 'purchase_order'
  | 'purchase_return'
  | 'payment'

export const TEMPLATE_KINDS: TemplateKind[] = [
  'sale_invoice',
  'quotation',
  'sale_order',
  'delivery_challan',
  'sale_return',
  'purchase_invoice',
  'purchase_order',
  'purchase_return',
  'payment'
]

export const KIND_LABELS: Record<TemplateKind | 'all', string> = {
  all: 'All documents',
  sale_invoice: 'Sales invoices',
  quotation: 'Quotations',
  sale_order: 'Sales orders',
  delivery_challan: 'Delivery challans',
  sale_return: 'Sales returns / credit notes',
  purchase_invoice: 'Purchase invoices',
  purchase_order: 'Purchase orders',
  purchase_return: 'Purchase returns / debit notes',
  payment: 'Payment receipts / vouchers'
}

/** Kinds that may use the 80 mm thermal receipt layout. */
export const THERMAL_KINDS: TemplateKind[] = ['sale_invoice', 'payment']

export const LAYOUTS: Array<{ key: Layout; label: string; hint: string }> = [
  { key: 'classic', label: 'Classic (A4)', hint: 'Letterhead with colour bar, boxed customer details and a coloured table header.' },
  { key: 'modern', label: 'Modern (A4)', hint: 'Bold colour header band, airy table and a highlighted total.' },
  { key: 'compact', label: 'Compact (A4)', hint: 'Small header and tight rows - fits long invoices on fewer pages.' },
  { key: 'thermal80', label: 'Thermal receipt (80 mm)', hint: 'Narrow receipt for 80 mm POS printers - sales invoices and payment receipts.' }
]

export const LAYOUT_LABEL: Record<Layout, string> = { classic: 'Classic', modern: 'Modern', compact: 'Compact', thermal80: 'Thermal 80 mm' }

export interface TemplateOptions {
  showLogo: boolean
  showDescription: boolean
  showBrandModel: boolean
  showUnit: boolean
  showDiscount: boolean
  showTax: boolean
  showSerials: boolean
  showWarranty: boolean
  showTerms: boolean
  showBankDetails: boolean
  showAmountInWords: boolean
  showCustomerSignature: boolean
  showAuthorisedSignature: boolean
  showStamp: boolean
  showNotes: boolean
  showPreviousBalance: boolean
  accentColor: string
  titleOverride: string
  footerNote: string
  // Invoice Print settings (Editable mode). Every default below equals the standard print.
  showCompanyName: boolean
  companyNameSize: 'small' | 'medium' | 'large'
  showAddress: boolean
  showEmail: boolean
  showPhone: boolean
  showTaxId: boolean
  /** Empty space at the top of the page, for pre-printed letterhead paper */
  topSpaceMm: number
  /** Empty rows are added until the item table has at least this many rows (classic and modern) */
  minRows: number
  showTotalQty: boolean
  showDecimals: boolean
  groupDigits: boolean
  showReceived: boolean
  showBalance: boolean
  showYouSaved: boolean
  showPayments: boolean
  wordsFormat: 'south_asia' | 'international'
  signatureText: string
  /** Printed name of a document type, by document type */
  titles: Record<string, string>
}

export type BoolOption = { [K in keyof TemplateOptions]: TemplateOptions[K] extends boolean ? K : never }[keyof TemplateOptions]

/** Show/hide switches, grouped for the designer and the "Customise this print" panel. */
export const OPTION_GROUPS: Array<{ title: string; items: Array<{ key: BoolOption; label: string; hint?: string }> }> = [
  {
    title: 'Header',
    items: [{ key: 'showLogo', label: 'Firm logo' }]
  },
  {
    title: 'Items',
    items: [
      { key: 'showDescription', label: 'Item description', hint: 'Printed under the item name' },
      { key: 'showBrandModel', label: 'Brand / model' },
      { key: 'showUnit', label: 'Unit column' },
      { key: 'showDiscount', label: 'Discount column', hint: 'Only when the document has discounts' },
      { key: 'showTax', label: 'Tax column', hint: 'Only when the document has sales tax' },
      { key: 'showSerials', label: 'Serial numbers' },
      { key: 'showWarranty', label: 'Warranty' }
    ]
  },
  {
    title: 'Totals & notes',
    items: [
      { key: 'showAmountInWords', label: 'Amount in words' },
      { key: 'showPreviousBalance', label: 'Previous balance (sales invoices)' },
      { key: 'showBankDetails', label: 'Bank details' },
      { key: 'showNotes', label: 'Notes' },
      { key: 'showTerms', label: 'Terms & conditions' }
    ]
  },
  {
    title: 'Signatures',
    items: [
      { key: 'showCustomerSignature', label: 'Customer signature box' },
      { key: 'showAuthorisedSignature', label: 'Authorised signature (firm signature image)' },
      { key: 'showStamp', label: 'Stamp' }
    ]
  }
]

export interface PrintDesign {
  /** Saved template id, or 'builtin:<layout>' */
  ref: number | string
  name: string
  layout: Layout
  options: TemplateOptions
}

export interface SavedTemplate {
  id: number
  name: string
  applies_to: TemplateKind | 'all'
  layout: Layout
  options: TemplateOptions
  default_for: TemplateKind[]
  created_at?: string
  updated_at?: string | null
}

/** The firm's own print settings expressed as template options (used by built-in layouts and new templates). */
export function firmOptions(ps: Partial<PrintSettings> | undefined): TemplateOptions {
  const p = ps ?? {}
  return {
    showLogo: p.showLogo !== false,
    showDescription: true,
    showBrandModel: true,
    showUnit: true,
    showDiscount: true,
    showTax: p.showTaxColumns !== 'never',
    showSerials: p.showSerials !== false,
    showWarranty: p.showWarranty !== false,
    showTerms: true,
    showBankDetails: p.showBankDetails !== false,
    showAmountInWords: p.showAmountInWords !== false,
    showCustomerSignature: true,
    showAuthorisedSignature: p.showSignature !== false,
    showStamp: p.showStamp !== false,
    showNotes: true,
    showPreviousBalance: p.showPreviousBalance !== false,
    accentColor: p.accentColor || '#0b5cad',
    titleOverride: '',
    footerNote: '',
    showCompanyName: true,
    companyNameSize: 'large',
    showAddress: true,
    showEmail: true,
    showPhone: true,
    showTaxId: true,
    topSpaceMm: 0,
    minRows: 4,
    showTotalQty: false,
    showDecimals: true,
    groupDigits: true,
    showReceived: true,
    showBalance: true,
    showYouSaved: false,
    showPayments: true,
    wordsFormat: 'south_asia',
    signatureText: '',
    titles: {}
  }
}

/** Editable mode: the "Invoice Print" settings laid over a design (they apply to every template and built-in layout). */
export function withPrintSettings(design: PrintDesign, settings: Record<string, any> | undefined): PrintDesign {
  const over = printOverrides(settings)
  return Object.keys(over).length ? { ...design, options: { ...design.options, ...over } as TemplateOptions } : design
}

export function builtinDesign(layout: Layout, ps: Partial<PrintSettings> | undefined): PrintDesign {
  return { ref: `builtin:${layout}`, name: `Built-in ${LAYOUT_LABEL[layout]}`, layout, options: firmOptions(ps) }
}

export function designFromTemplate(t: SavedTemplate): PrintDesign {
  return { ref: t.id, name: t.name, layout: t.layout, options: { ...firmOptions(undefined), ...t.options } }
}

export function templateFits(t: { applies_to: string; layout: string }, kind: TemplateKind): boolean {
  if (t.layout === 'thermal80' && !THERMAL_KINDS.includes(kind)) return false
  return t.applies_to === 'all' || t.applies_to === kind
}

/** Built-in layouts usable for a kind. */
export function builtinLayouts(kind: TemplateKind): Layout[] {
  return THERMAL_KINDS.includes(kind) ? ['classic', 'modern', 'compact', 'thermal80'] : ['classic', 'modern', 'compact']
}

/** Resolves a reference (template id / builtin key) to a design, falling back to built-in Classic. */
export function resolveDesign(ref: string | number | null | undefined, templates: SavedTemplate[], kind: TemplateKind, ps: Partial<PrintSettings> | undefined): PrintDesign {
  if (ref !== null && ref !== undefined && ref !== '') {
    const s = String(ref)
    const m = /^builtin:(\w+)$/.exec(s)
    if (m && (builtinLayouts(kind) as string[]).includes(m[1])) return builtinDesign(m[1] as Layout, ps)
    const t = templates.find((x) => String(x.id) === s)
    if (t && templateFits(t, kind)) return designFromTemplate(t)
  }
  return builtinDesign('classic', ps)
}

export function sameOptions(a: TemplateOptions, b: TemplateOptions): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

/** Document kind for a print route (doc type for documents, 'payment' for receipts / vouchers). */
export function kindOf(printKind: string, doc: any): TemplateKind | null {
  if (printKind === 'payment') return 'payment'
  if (printKind === 'doc' && doc?.doc_type && (TEMPLATE_KINDS as string[]).includes(doc.doc_type)) return doc.doc_type as TemplateKind
  return null
}
