/**
 * Editable mode: the on/off switches and values of "Settings, Simple / Customize".
 *
 * The screens, section headings and labels follow the Vyapar settings (Transaction, Invoice Print, Item) the users already
 * know, plus Party, Menu and Solar Projects for what DT Solar Pro has beyond Vyapar. Every switch listed here does something;
 * Vyapar settings with no meaning in this software are not listed (see docs/VYAPAR_SETTINGS_MAP.md).
 *
 * Two modes (setting `ui_mode`):
 *  - "standard" : the software exactly as before; every option keeps its standard value and the stored values are ignored.
 *  - "custom"   : each option follows its stored value (setting `ui_options`); an option never set keeps its standard value.
 *
 * Options change what is shown, asked or printed. They never change how money, stock or profit is calculated, and hidden
 * fields keep the values they have, so switching an option off and on again loses nothing.
 */

export type OptionScreen = 'transaction' | 'print' | 'item' | 'party' | 'menu' | 'project'

export const OPTION_SCREENS: Array<{ key: OptionScreen; label: string; hint: string }> = [
  { key: 'transaction', label: 'Transaction', hint: 'What the invoice, quotation and bill screens ask for.' },
  { key: 'print', label: 'Invoice Print', hint: 'What every printed or PDF document shows. Layout and colours stay in Invoice templates.' },
  { key: 'item', label: 'Item', hint: 'Products and services.' },
  { key: 'party', label: 'Party', hint: 'Customers and suppliers.' },
  { key: 'menu', label: 'Menu and modules', hint: 'Hide the parts of the software this business does not use. The data is kept.' },
  { key: 'project', label: 'Solar Projects', hint: 'From a simple job record to full costing and profit.' }
]

interface Base {
  key: string
  screen: OptionScreen
  /** Heading inside the screen (the Vyapar section names where one exists). */
  section: string
  label: string
  hint: string
}
export interface ToggleDef extends Base {
  kind: 'toggle'
  /** Value in Standard mode (the behaviour before this existed). */
  standard: boolean
}
export interface ChoiceDef extends Base {
  kind: 'select'
  standard: string
  choices: Array<{ value: string; label: string }>
}
export interface NumberDef extends Base {
  kind: 'number'
  standard: number
  min: number
  max: number
  unit?: string
}
export interface TextDef extends Base {
  kind: 'text'
  standard: string
  placeholder?: string
}
export type OptionDef = ToggleDef | ChoiceDef | NumberDef | TextDef

const T = (key: string, screen: OptionScreen, section: string, label: string, hint: string, standard = true): ToggleDef => ({ kind: 'toggle', key, screen, section, label, hint, standard })
const S = (key: string, screen: OptionScreen, section: string, label: string, hint: string, standard: string, choices: Array<[string, string]>): ChoiceDef => ({
  kind: 'select', key, screen, section, label, hint, standard, choices: choices.map(([value, label]) => ({ value, label }))
})
const N = (key: string, screen: OptionScreen, section: string, label: string, hint: string, standard: number, min: number, max: number, unit?: string): NumberDef => ({ kind: 'number', key, screen, section, label, hint, standard, min, max, unit })
const X = (key: string, screen: OptionScreen, section: string, label: string, hint: string, standard = '', placeholder?: string): TextDef => ({ kind: 'text', key, screen, section, label, hint, standard, placeholder })

/** Documents that can be given another printed name ("Change Transaction Names"). */
export const TITLE_DOCS: Array<[string, string]> = [
  ['sale_invoice', 'Sales invoice'],
  ['quotation', 'Quotation'],
  ['sale_order', 'Sales order'],
  ['delivery_challan', 'Delivery challan'],
  ['sale_return', 'Credit note'],
  ['purchase_invoice', 'Purchase invoice'],
  ['purchase_order', 'Purchase order'],
  ['purchase_return', 'Debit note']
]

const TX = 'transaction'
const PR = 'print'
const IT = 'item'

export const OPTIONS: OptionDef[] = [
  // ---------------------------------------------------------------- Transaction
  T('txn.cash_sale', TX, 'Transaction Header', 'Cash Sale by default', 'A new sales invoice starts as a walk-in cash sale: no customer needed and the full amount is taken as received. Change either on the invoice.', false),
  T('txn.billing_name', TX, 'Transaction Header', 'Billing name of Parties', 'Give a customer or supplier a separate billing name (for example the company name) that is printed on documents instead of the usual name.', false),
  T('txn.po_details', TX, 'Transaction Header', 'PO Details (of customer)', 'Customer PO number on sales documents, supplier invoice number on purchases.'),
  T('txn.time', TX, 'Transaction Header', 'Add Time On Transactions', 'Show the time a document was made next to its date on the screen and in print.', false),
  T('txn.project_link', TX, 'Transaction Header', 'Solar project', 'Link a document to a solar project.'),
  T('txn.warehouse', TX, 'Transaction Header', 'Warehouse', 'Choose the warehouse on each document. The default warehouse is used when hidden.'),

  T('item.barcode', TX, 'Items Table', 'Barcode scanning for items', 'A scan box on the document: scan or type a barcode or item code and press Enter to add the item.', false),
  T('txn.item_description', TX, 'Items Table', 'Item description', 'Longer text printed below each item name.'),
  T('txn.purchase_price', TX, 'Items Table', 'Display Purchase Price', 'Average cost and the below-cost warning under each item on sales documents (only for users who may see costs).'),
  T('txn.last_prices', TX, 'Items Table', 'Show Last 5 Sale Price of Items', 'A small list of the last five prices an item was sold at (to this customer first) under each item. Click one to use it.', false),
  T('txn.warranty', TX, 'Items Table', 'Warranty on each item', 'Warranty box under items that have a warranty. Items that track serial numbers always ask for them.'),

  T('item.discount', TX, 'Taxes, Discount & Total', 'Item wise discount', 'Discount percentage on each line.'),
  T('txn.discount', TX, 'Taxes, Discount & Total', 'Transaction wise Discount', 'One discount amount on the whole document.'),
  T('item.tax', TX, 'Taxes, Discount & Total', 'Item wise tax', 'Tax column and the Sales Tax Invoice format. Shown anyway when a line already has tax.'),
  T('txn.other_charges', TX, 'Taxes, Discount & Total', 'Freight / other charges', 'Extra charge line in the totals.'),
  T('txn.round_off', TX, 'Taxes, Discount & Total', 'Round Off Transaction amount', 'Round off line in the totals.'),
  S('txn.round_mode', TX, 'Taxes, Discount & Total', 'Round off how', 'Manual: type the amount yourself. The other choices round the total automatically.', 'manual', [['manual', 'Manual entry'], ['nearest', 'Nearest'], ['up', 'Always up'], ['down', 'Always down']]),
  S('txn.round_to', TX, 'Taxes, Discount & Total', 'Round off to', 'The step the total is rounded to when rounding is automatic.', '1', [['1', '1'], ['5', '5'], ['10', '10'], ['50', '50'], ['100', '100']]),
  T('txn.amount_words', TX, 'Taxes, Discount & Total', 'Amount in words', 'Total in words under the grand total.'),

  T('txn.payment_now', TX, 'More Transaction Features', 'Payment received or paid now', 'Record the payment while saving the document.'),
  T('txn.due_date', TX, 'More Transaction Features', 'Due Dates and Payment terms', 'Due date on invoices and bills.'),
  T('txn.preview', TX, 'More Transaction Features', 'Enable Invoice Preview', 'Open the print preview after a new sales invoice or quotation is saved.', false),
  T('txn.notes', TX, 'More Transaction Features', 'Notes', 'Notes box.'),
  T('txn.terms', TX, 'More Transaction Features', 'Terms & Conditions', 'Terms and conditions box (the default text is set in Settings, Documents).'),
  T('data.easy_delete', TX, 'More Transaction Features', 'Delete invoices and bills even after payments', 'The payment is kept as the customer or supplier advance and the stock is put back. Every deletion is recorded in the audit log. Closed days, returns, converted documents and permissions still apply.', false),

  // ---------------------------------------------------------------- Invoice Print
  S('print.company_name_size', PR, 'Print Company Info/Header', 'Company Name Text Size', 'Size of the firm name at the top.', 'large', [['small', 'Small'], ['medium', 'Medium'], ['large', 'Large']]),
  T('print.company_name', PR, 'Print Company Info/Header', 'Print Company Name', 'Firm name in the header.'),
  T('print.logo', PR, 'Print Company Info/Header', 'Company logo', 'Firm logo in the header.'),
  T('print.address', PR, 'Print Company Info/Header', 'Address', 'Firm address in the header.'),
  T('print.email', PR, 'Print Company Info/Header', 'Email', 'Firm email in the header.'),
  T('print.phone', PR, 'Print Company Info/Header', 'Phone number', 'Firm phone numbers in the header.'),
  T('print.tax_id', PR, 'Print Company Info/Header', 'TIN on Sale (NTN / STRN)', 'Firm NTN and STRN in the header.'),
  N('print.top_space', PR, 'Print Company Info/Header', 'Extra spaces on top of PDF', 'Empty space at the top of every page, for pre-printed letterhead paper.', 0, 0, 80, 'mm'),
  ...TITLE_DOCS.map(([doc, name]) => X(`print.title.${doc}`, PR, 'Change Transaction Names', name, `Printed title of a ${name.toLowerCase()}. Empty keeps the standard name.`, '', name)),

  T('print.unit', PR, 'Item Table Customization', 'Unit column', 'Unit next to the quantity.'),
  T('print.item_description', PR, 'Item Table Customization', 'Item description', 'Description printed under the item name.'),
  T('print.brand_model', PR, 'Item Table Customization', 'Brand / model', 'Brand and model under the item name.'),
  T('print.discount_col', PR, 'Item Table Customization', 'Discount column', 'Only when the document has discounts.'),
  T('print.tax_col', PR, 'Item Table Customization', 'Tax details', 'Tax column and tax rows. Only when the document has sales tax.'),
  T('print.serials', PR, 'Item Table Customization', 'Serial numbers', 'Serial numbers under the item.'),
  T('print.warranty', PR, 'Item Table Customization', 'Warranty', 'Warranty under the item.'),
  N('print.min_rows', PR, 'Totals & Taxes', 'Min. No. of rows in Item Table', 'Empty rows are added until the table has at least this many (classic and modern layouts).', 4, 0, 30),
  T('print.total_qty', PR, 'Totals & Taxes', 'Total Item Quantity', 'Total quantity under the item table.', false),
  T('print.decimals', PR, 'Totals & Taxes', 'Amount with Decimal (eg 0.00)', 'Show paisa in the totals.'),
  T('print.grouping', PR, 'Totals & Taxes', 'Amount Grouping', 'Thousands separators in amounts (1,250,000).'),
  T('print.received', PR, 'Totals & Taxes', 'Received amount', 'Paid or received amount row.'),
  T('print.balance', PR, 'Totals & Taxes', 'Balance amount', 'Balance due row.'),
  T('print.prev_balance', PR, 'Totals & Taxes', 'Previous balance', 'Customer balance before and after the invoice.'),
  T('print.you_saved', PR, 'Totals & Taxes', 'You Saved', 'A line with the total of all discounts given.', false),
  T('print.amount_words', PR, 'Totals & Taxes', 'Amount in words', 'Total in words.'),
  S('print.words_format', PR, 'Totals & Taxes', 'Amount in words format', 'South Asian: lakh and crore. International: million and billion.', 'south_asia', [['south_asia', 'Lakh / crore (1,00,000)'], ['international', 'Million / billion (1,000,000)']]),

  T('print.notes', PR, 'Footer', 'Print description (notes)', 'The notes typed on the document.'),
  T('print.terms', PR, 'Footer', 'Terms & Conditions', 'Terms and conditions of the document.'),
  T('print.bank', PR, 'Footer', 'Bank details', 'Firm bank details for payment.'),
  T('print.payments', PR, 'Footer', 'Payment mode', 'The payments received, with date, number and method.'),
  T('print.received_by', PR, 'Footer', 'Print Received by details', 'Customer signature box.'),
  T('print.signature', PR, 'Footer', 'Print Signature Text', 'Authorised signature (the firm signature image and its caption).'),
  X('print.signature_text', PR, 'Footer', 'Set Custom Signature Text', 'Caption under the authorised signature. Empty keeps the firm setting.', '', 'Authorized Signature'),
  T('print.stamp', PR, 'Footer', 'Stamp', 'Firm stamp image.'),

  // ---------------------------------------------------------------- Item
  T('item.enabled', IT, 'Item', 'Enable Item', 'Off: no product list and no product picker. Documents are typed line by line (name, quantity, rate), as for a service business.'),
  S('item.type_mode', IT, 'Item', 'Item Type', 'What kinds of items can be created.', 'both', [['both', 'Products and Services'], ['goods', 'Products only'], ['service', 'Services only']]),
  T('item.stock', IT, 'Item', 'Stock maintenance', 'Off: stock numbers are not shown and never stop a sale. Stock movements are still recorded quietly, so switching it on later gives correct stock.'),
  T('item.category', IT, 'Item', 'Item Category', 'Category of an item, and the category filter.'),
  T('item.units', IT, 'Item', 'Item Units', 'Unit of an item (pcs, kW, m, set, job).'),
  X('item.default_unit', IT, 'Item', 'Default Unit', 'Unit given to a new product.', 'pcs', 'pcs'),
  T('item.codes', IT, 'Item', 'Item code (SKU) and barcode', 'Item code and barcode fields.'),
  T('item.brand_model', IT, 'Item', 'Brand and model', 'Brand and model / specification.'),
  T('item.min_price', IT, 'Item', 'Minimum sale price', 'Lowest price a user without discount permission may sell at.'),
  T('item.reorder', IT, 'Item', 'Low-stock level', 'Reorder level for the low-stock alert.'),
  T('item.warranty', IT, 'Item', 'Warranty', 'Warranty months and warranty terms.'),
  T('item.serials', IT, 'Item', 'Serial number tracking', 'Track serial numbers of inverters, batteries and similar items.'),
  T('item.description', IT, 'Item', 'Description', 'Description of the item.'),
  T('item.update_sale_price', IT, 'Item', 'Update Sale Price from TXN', 'When a sales invoice is saved with another rate, the item sale price becomes that rate.', false),

  // ---------------------------------------------------------------- Party
  T('party.contact_extra', 'party', 'Party', 'Contact person, second phone and email', 'More ways to reach the customer or supplier.'),
  T('party.tax_ids', 'party', 'Party', 'CNIC, NTN and STRN', 'Identity and tax numbers.'),
  T('party.opening_balance', 'party', 'Party', 'Opening balance', 'Balance carried from before using the software.'),
  T('party.credit', 'party', 'Party', 'Credit limit and payment terms', 'Credit limit and days allowed to pay.'),

  // ---------------------------------------------------------------- Menu
  T('mod.crm', 'menu', 'Menu', 'CRM and Leads', 'Enquiries, pipeline and follow-ups.'),
  T('mod.quotations', 'menu', 'Menu', 'Quotations', 'Quotations and estimates.'),
  T('mod.purchases', 'menu', 'Menu', 'Purchases', 'Purchase bills, orders and returns.'),
  T('mod.projects', 'menu', 'Menu', 'Solar Projects', 'Projects and their dashboard figures.'),
  T('mod.accounts', 'menu', 'Menu', 'Accounts', 'Cash, bank and wallet accounts and transfers.'),
  T('mod.expenses', 'menu', 'Menu', 'Expenses', 'Expense entries and categories.'),
  T('mod.closing', 'menu', 'Menu', 'Day Closing', 'Daily and monthly closing with cash count.'),
  T('mod.reports', 'menu', 'Menu', 'Reports', 'All reports.'),
  T('mod.whatsapp', 'menu', 'Menu', 'WhatsApp', 'WhatsApp window in the menu.'),

  // ---------------------------------------------------------------- Solar projects
  T('project.details', 'project', 'Solar Projects', 'Project details', 'Site contact, project and system type, dates, manager, warranty and overhead.'),
  T('project.costing', 'project', 'Solar Projects', 'Costing and profit', 'Material issue, labor and other costs, ledger, profit and margin. Off gives a simple project record: customer, site, capacity, status, contract amount, invoices, payments and files.')
]

const BY_KEY = new Map(OPTIONS.map((o) => [o.key, o]))
export const optionDef = (key: string): OptionDef | undefined => BY_KEY.get(key)

export interface OptionSettings {
  ui_mode?: unknown
  ui_options?: unknown
}

export const isCustomMode = (s: OptionSettings | undefined | null): boolean => s?.ui_mode === 'custom'

function stored(s: OptionSettings | undefined | null, key: string): unknown {
  return s?.ui_options && typeof s.ui_options === 'object' ? (s.ui_options as Record<string, unknown>)[key] : undefined
}

/** Whether a switch is on. Standard mode always returns the standard value; an unknown key is on. */
export function optionOn(s: OptionSettings | undefined | null, key: string): boolean {
  const def = BY_KEY.get(key)
  if (!def || def.kind !== 'toggle') return true
  if (!isCustomMode(s)) return def.standard
  const v = stored(s, key)
  return typeof v === 'boolean' ? v : def.standard
}

/** The value of a choice, number or text option (its standard value in Standard mode or when never set). */
export function optionValue(s: OptionSettings | undefined | null, key: string): string | number {
  const def = BY_KEY.get(key)
  if (!def || def.kind === 'toggle') return ''
  if (!isCustomMode(s)) return def.standard
  const v = stored(s, key)
  const c = clean(def, v)
  return typeof c === 'boolean' || c === undefined ? def.standard : c
}

function clean(def: OptionDef, v: unknown): boolean | string | number | undefined {
  switch (def.kind) {
    case 'toggle':
      return typeof v === 'boolean' ? v : undefined
    case 'select': {
      const sv = typeof v === 'number' ? String(v) : v
      return typeof sv === 'string' && def.choices.some((c) => c.value === sv) ? sv : undefined
    }
    case 'number': {
      const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN
      return Number.isFinite(n) ? Math.min(def.max, Math.max(def.min, Math.round(n))) : undefined
    }
    case 'text':
      return typeof v === 'string' ? v.trim().slice(0, 60) : undefined
  }
}

/** Keeps only known keys with valid values (what is stored). */
export function normalizeOptions(v: unknown): Record<string, boolean | string | number> {
  const out: Record<string, boolean | string | number> = {}
  if (!v || typeof v !== 'object') return out
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    const def = BY_KEY.get(k)
    if (!def) continue
    const c = clean(def, val)
    if (c !== undefined) out[k] = c
  }
  return out
}

/** The "Invoice Print" settings as a design override: print option name -> value. Empty in Standard mode. */
export const PRINT_TOGGLE_MAP: Record<string, string> = {
  'print.company_name': 'showCompanyName',
  'print.logo': 'showLogo',
  'print.address': 'showAddress',
  'print.email': 'showEmail',
  'print.phone': 'showPhone',
  'print.tax_id': 'showTaxId',
  'print.unit': 'showUnit',
  'print.item_description': 'showDescription',
  'print.brand_model': 'showBrandModel',
  'print.discount_col': 'showDiscount',
  'print.tax_col': 'showTax',
  'print.serials': 'showSerials',
  'print.warranty': 'showWarranty',
  'print.total_qty': 'showTotalQty',
  'print.decimals': 'showDecimals',
  'print.grouping': 'groupDigits',
  'print.received': 'showReceived',
  'print.balance': 'showBalance',
  'print.prev_balance': 'showPreviousBalance',
  'print.you_saved': 'showYouSaved',
  'print.amount_words': 'showAmountInWords',
  'print.notes': 'showNotes',
  'print.terms': 'showTerms',
  'print.bank': 'showBankDetails',
  'print.payments': 'showPayments',
  'print.received_by': 'showCustomerSignature',
  'print.signature': 'showAuthorisedSignature',
  'print.stamp': 'showStamp'
}

export function printOverrides(s: OptionSettings | undefined | null): Record<string, boolean | string | number | Record<string, string>> {
  if (!isCustomMode(s)) return {}
  const out: Record<string, boolean | string | number | Record<string, string>> = {}
  for (const [key, opt] of Object.entries(PRINT_TOGGLE_MAP)) {
    const v = stored(s, key)
    if (typeof v === 'boolean') out[opt] = v
  }
  const size = optionValue(s, 'print.company_name_size')
  if (size !== 'large') out.companyNameSize = size
  const top = Number(optionValue(s, 'print.top_space'))
  if (top > 0) out.topSpaceMm = top
  const rows = stored(s, 'print.min_rows')
  if (rows !== undefined) out.minRows = Number(optionValue(s, 'print.min_rows'))
  if (optionValue(s, 'print.words_format') !== 'south_asia') out.wordsFormat = 'international'
  const sig = String(optionValue(s, 'print.signature_text'))
  if (sig) out.signatureText = sig
  const titles: Record<string, string> = {}
  for (const [doc] of TITLE_DOCS) {
    const t = String(optionValue(s, `print.title.${doc}`)).trim()
    if (t) titles[doc] = t
  }
  if (Object.keys(titles).length) out.titles = titles
  return out
}

export const OPTION_PRESETS: Array<{ key: string; label: string; hint: string; options: Record<string, boolean | string | number> }> = [
  { key: 'full', label: 'Everything', hint: 'All options as in Standard mode, so nothing is hidden.', options: Object.fromEntries(OPTIONS.map((o) => [o.key, o.standard])) },
  {
    key: 'simple',
    label: 'Simple shop',
    hint: 'A small business that bills customers and keeps stock: cash sale by default, invoice preview, last prices, no CRM, projects, closing, serial numbers or costing, and invoices can be deleted easily.',
    options: {
      ...Object.fromEntries(OPTIONS.map((o) => [o.key, o.standard])),
      'mod.crm': false,
      'mod.projects': false,
      'mod.closing': false,
      'project.details': false,
      'project.costing': false,
      'txn.cash_sale': true,
      'txn.preview': true,
      'txn.last_prices': true,
      'txn.project_link': false,
      'txn.warehouse': false,
      'txn.po_details': false,
      'txn.other_charges': false,
      'txn.round_off': false,
      'txn.purchase_price': false,
      'txn.warranty': false,
      'item.tax': false,
      'item.codes': false,
      'item.brand_model': false,
      'item.min_price': false,
      'item.reorder': false,
      'item.warranty': false,
      'item.serials': false,
      'party.contact_extra': false,
      'party.tax_ids': false,
      'party.credit': false,
      'data.easy_delete': true
    }
  }
]

/** Automatic round off: the amount to add to `total` so it lands on a multiple of `step` (mode nearest / up / down). */
export function autoRoundOff(total: number, mode: string, step: number): number {
  if (mode === 'manual' || !(step > 0)) return 0
  const q = total / step
  const r = mode === 'up' ? Math.ceil(q - 1e-9) : mode === 'down' ? Math.floor(q + 1e-9) : Math.round(q)
  return Math.round((r * step - total) * 100) / 100
}
