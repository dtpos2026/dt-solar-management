/**
 * Interface options: the on/off switches of "Customizable" mode.
 *
 * Two modes (setting `ui_mode`):
 *  - "standard"   : the software exactly as before; every option below keeps its standard value and the switches are ignored.
 *  - "custom"     : each option follows its own switch (setting `ui_options`); an option never set keeps its standard value.
 *
 * Options only change what is shown or asked. They never change how money, stock or profit is calculated, and hidden
 * fields keep the values they already have, so switching an option off and on again loses nothing.
 */

export type OptionGroup = 'modules' | 'documents' | 'items' | 'parties' | 'projects' | 'data'

export interface OptionDef {
  key: string
  group: OptionGroup
  label: string
  hint: string
  /** Value in Standard mode (the behaviour before this feature existed). */
  standard: boolean
}

export const OPTION_GROUPS: Array<{ key: OptionGroup; label: string; hint: string }> = [
  { key: 'modules', label: 'Menu and modules', hint: 'Hide the parts of the software this business does not use. Data is kept and comes back when switched on.' },
  { key: 'documents', label: 'Sales and purchase documents', hint: 'What the invoice, quotation and bill screens ask for.' },
  { key: 'items', label: 'Products and services', hint: 'What the product form asks for.' },
  { key: 'parties', label: 'Customers and suppliers', hint: 'What the customer and supplier form asks for.' },
  { key: 'projects', label: 'Solar projects', hint: 'From a simple job record to full costing and profit.' },
  { key: 'data', label: 'Editing and deleting', hint: 'How freely entries can be removed.' }
]

const on = (key: string, group: OptionGroup, label: string, hint: string, standard = true): OptionDef => ({ key, group, label, hint, standard })

export const OPTIONS: OptionDef[] = [
  // modules
  on('mod.crm', 'modules', 'CRM and Leads', 'Enquiries, pipeline and follow-ups.'),
  on('mod.quotations', 'modules', 'Quotations', 'Quotations and estimates.'),
  on('mod.purchases', 'modules', 'Purchases', 'Purchase bills, orders and returns.'),
  on('mod.projects', 'modules', 'Solar Projects', 'Projects and their dashboard figures.'),
  on('mod.accounts', 'modules', 'Accounts', 'Cash, bank and wallet accounts and transfers.'),
  on('mod.expenses', 'modules', 'Expenses', 'Expense entries and categories.'),
  on('mod.closing', 'modules', 'Day Closing', 'Daily and monthly closing with cash count.'),
  on('mod.reports', 'modules', 'Reports', 'All reports.'),
  on('mod.whatsapp', 'modules', 'WhatsApp', 'WhatsApp window in the menu.'),

  // documents
  on('doc.project_link', 'documents', 'Solar project on a document', 'Link an invoice or quotation to a project.'),
  on('doc.warehouse', 'documents', 'Warehouse', 'Choose the warehouse on each document (the default one is used when hidden).'),
  on('doc.party_ref', 'documents', 'Customer PO / supplier invoice number', 'Reference number of the other side.'),
  on('doc.due_date', 'documents', 'Due date', 'Payment due date on invoices and bills.'),
  on('doc.item_details', 'documents', 'Item description under the item name', 'Longer text printed below each item.'),
  on('doc.discount', 'documents', 'Discount', 'Discount on each line and on the whole document.'),
  on('doc.tax', 'documents', 'Sales tax', 'Tax column and the Sales Tax Invoice format (shown anyway when a line already has tax).'),
  on('doc.serial_warranty', 'documents', 'Warranty on each item', 'Warranty box under items that have a warranty. Items that track serial numbers always ask for them.'),
  on('doc.stock_hints', 'documents', 'Stock and cost hints', 'In stock, average cost and below-cost warnings under each item.'),
  on('doc.other_charges', 'documents', 'Freight / other charges', 'Extra charge line in the totals.'),
  on('doc.round_off', 'documents', 'Round off', 'Round off amount in the totals.'),
  on('doc.notes_terms', 'documents', 'Notes and terms', 'Notes and terms and conditions boxes.'),
  on('doc.payment_now', 'documents', 'Payment received or paid now', 'Record the payment while saving the document.'),
  on('doc.amount_words', 'documents', 'Amount in words', 'Total in words under the grand total.'),

  // items
  on('item.codes', 'items', 'SKU and barcode', 'Item code fields.'),
  on('item.brand_model', 'items', 'Brand and model', 'Brand and model / specification.'),
  on('item.tax', 'items', 'Tax rate', 'Tax rate of the item.'),
  on('item.min_price', 'items', 'Minimum sale price', 'Lowest price a user without discount permission may sell at.'),
  on('item.reorder', 'items', 'Low-stock level', 'Reorder level for the low-stock alert.'),
  on('item.warranty', 'items', 'Warranty', 'Warranty months and warranty terms.'),
  on('item.serials', 'items', 'Serial number tracking', 'Track serial numbers of inverters, batteries and similar items.'),
  on('item.description', 'items', 'Description', 'Description of the item.'),

  // parties
  on('party.contact_extra', 'parties', 'Contact person, second phone and email', 'More ways to reach the customer or supplier.'),
  on('party.tax_ids', 'parties', 'CNIC, NTN and STRN', 'Identity and tax numbers.'),
  on('party.opening_balance', 'parties', 'Opening balance', 'Balance carried from before using the software.'),
  on('party.credit', 'parties', 'Credit limit and payment terms', 'Credit limit and days allowed to pay.'),

  // projects
  on('project.details', 'projects', 'Project details', 'Site contact, project and system type, dates, manager, warranty and overhead.'),
  on('project.costing', 'projects', 'Costing and profit', 'Material issue, labor and other costs, ledger, profit and margin. Off gives a simple project record.'),

  // data
  on('data.easy_delete', 'data', 'Delete invoices and bills even after payments', 'The payment is kept as the customer or supplier advance and the stock is put back. Every deletion is recorded in the audit log. Closed days and permissions still apply.', false)
]

export type OptionKey = (typeof OPTIONS)[number]['key']

const BY_KEY = new Map(OPTIONS.map((o) => [o.key, o]))

export interface OptionSettings {
  ui_mode?: unknown
  ui_options?: unknown
}

export const isCustomMode = (s: OptionSettings | undefined | null): boolean => s?.ui_mode === 'custom'

/** Whether an option is on. Standard mode always returns the standard value. */
export function optionOn(s: OptionSettings | undefined | null, key: string): boolean {
  const def = BY_KEY.get(key)
  if (!def) return true
  if (!isCustomMode(s)) return def.standard
  const v = s?.ui_options && typeof s.ui_options === 'object' ? (s.ui_options as Record<string, unknown>)[key] : undefined
  return typeof v === 'boolean' ? v : def.standard
}

/** Keeps only known keys with boolean values (what is stored). */
export function normalizeOptions(v: unknown): Record<string, boolean> {
  const out: Record<string, boolean> = {}
  if (!v || typeof v !== 'object') return out
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) if (BY_KEY.has(k) && typeof val === 'boolean') out[k] = val
  return out
}

export const OPTION_PRESETS: Array<{ key: string; label: string; hint: string; options: Record<string, boolean> }> = [
  { key: 'full', label: 'Everything', hint: 'All options as in Standard mode, so nothing is hidden.', options: Object.fromEntries(OPTIONS.map((o) => [o.key, o.standard])) },
  {
    key: 'simple',
    label: 'Simple shop',
    hint: 'A small business that bills customers and keeps stock: no CRM, projects, closing, serial numbers or costing, and invoices can be deleted easily.',
    options: {
      ...Object.fromEntries(OPTIONS.map((o) => [o.key, o.standard])),
      'mod.crm': false,
      'mod.projects': false,
      'mod.closing': false,
      'doc.project_link': false,
      'doc.warehouse': false,
      'doc.party_ref': false,
      'doc.discount': true,
      'doc.tax': false,
      'doc.serial_warranty': false,
      'doc.stock_hints': false,
      'doc.other_charges': false,
      'doc.round_off': false,
      'item.codes': false,
      'item.brand_model': false,
      'item.tax': false,
      'item.min_price': false,
      'item.reorder': false,
      'item.warranty': false,
      'item.serials': false,
      'party.contact_extra': false,
      'party.tax_ids': false,
      'party.credit': false,
      'project.details': false,
      'project.costing': false,
      'data.easy_delete': true
    }
  }
]
