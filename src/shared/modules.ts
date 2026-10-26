/**
 * POS and ERP modules that are switched on or off as a whole (Settings, Simple / Customize, "POS and ERP modules").
 * They are independent of Standard / Editable mode and all start OFF, so an installation that never switches one on
 * looks and works exactly as before. A module that is off has no menu entry, no dashboard shortcut and no screen; its
 * data is kept and comes back when it is switched on again.
 */
export interface ModuleDef {
  key: string
  label: string
  hint: string
  /** Menu route of the module */
  route: string
}

export const MODULES: ModuleDef[] = [
  { key: 'pos', label: 'Point of Sale (POS)', hint: 'A fast counter screen for shops: scan or search items, a cart, hold bills, cash / card / split payment with change, shifts with cash drawer count, 80 mm receipts.', route: '/pos' },
  { key: 'hr', label: 'HR and Payroll', hint: 'Employees, daily attendance, salary advances and the monthly salary sheet, paid from a cash or bank account and booked as an expense.', route: '/hr' },
  { key: 'cheques', label: 'Cheques', hint: 'Register of received (post-dated) and issued cheques. Clearing a cheque books the payment; a bounced one does not.', route: '/cheques' },
  { key: 'service', label: 'Service and Warranty', hint: 'After-sales tickets for repairs and warranty claims, with warranty check from the sold serial number and a timeline.', route: '/service' },
  { key: 'reorder', label: 'Reorder Planning', hint: 'Items at or below their low-stock level with a suggested quantity and supplier, and one click to make the purchase orders.', route: '/reorder' }
]

const KEYS = new Set(MODULES.map((m) => m.key))

export interface ModuleSettings {
  erp_modules?: unknown
}

/** Whether a module is switched on. Nothing is on until the owner switches it on. */
export function moduleOn(s: ModuleSettings | undefined | null, key: string): boolean {
  const m = s?.erp_modules
  return !!m && typeof m === 'object' && (m as Record<string, unknown>)[key] === true
}

export function normalizeModules(v: unknown): Record<string, boolean> {
  const out: Record<string, boolean> = {}
  if (!v || typeof v !== 'object') return out
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) if (KEYS.has(k) && typeof val === 'boolean') out[k] = val
  return out
}

/* ------------------------------------------------------------------ POS settings */

export interface PosOptionDef {
  key: string
  label: string
  hint: string
  kind: 'toggle' | 'select'
  standard: boolean | string
  choices?: Array<[string, string]>
}

export const POS_OPTIONS: PosOptionDef[] = [
  { key: 'require_shift', label: 'Open a shift before selling', hint: 'Every counter sale belongs to a cash drawer shift that is opened with the cash in the drawer and closed with a count.', kind: 'toggle', standard: true },
  { key: 'allow_discount', label: 'Cashier can give discount', hint: 'Discount on a line or on the whole bill (the user also needs the "Give discounts" permission).', kind: 'toggle', standard: true },
  { key: 'allow_price_change', label: 'Cashier can change the price', hint: 'Edit the rate of an item at the counter (below the minimum price still needs the "Give discounts" permission).', kind: 'toggle', standard: false },
  { key: 'allow_credit', label: 'Allow credit sale to a customer', hint: 'Part or all of a bill left on the account of a selected customer. Walk-in customers always pay in full.', kind: 'toggle', standard: true },
  { key: 'auto_print', label: 'Print the receipt after each sale', hint: 'Sends the receipt to the receipt printer at once (Settings, Printers decides which printer).', kind: 'toggle', standard: true },
  { key: 'receipt', label: 'Receipt', hint: 'Layout of the printed receipt.', kind: 'select', standard: 'thermal80', choices: [['thermal80', '80 mm thermal receipt'], ['classic', 'A4 invoice']] },
  { key: 'default_method', label: 'Default payment method', hint: 'The method that is selected first when taking payment.', kind: 'select', standard: 'cash', choices: [['cash', 'Cash'], ['card', 'Card'], ['bank_transfer', 'Bank transfer'], ['online', 'Online / wallet']] },
  { key: 'round_to', label: 'Round the bill to', hint: 'Automatic cash rounding of the bill total (the difference is shown as round off).', kind: 'select', standard: 'off', choices: [['off', 'No rounding'], ['1', 'Nearest 1'], ['5', 'Nearest 5'], ['10', 'Nearest 10'], ['50', 'Nearest 50'], ['100', 'Nearest 100']] },
  { key: 'show_grid', label: 'Show item tiles', hint: 'Tap-to-add tiles below the search box.', kind: 'toggle', standard: true },
  { key: 'show_stock', label: 'Show stock on item tiles', hint: 'Quantity in stock on each tile and in the search results.', kind: 'toggle', standard: true }
]

const POS_BY_KEY = new Map(POS_OPTIONS.map((o) => [o.key, o]))
export const POS_METHODS = ['cash', 'card', 'bank_transfer', 'online'] as const

export interface PosSettings {
  pos_settings?: unknown
}

/** A POS option (its standard value when never set). */
export function posOption(s: PosSettings | undefined | null, key: string): boolean | string {
  const def = POS_BY_KEY.get(key)
  if (!def) return false
  const v = s?.pos_settings && typeof s.pos_settings === 'object' ? (s.pos_settings as Record<string, unknown>)[key] : undefined
  if (def.kind === 'toggle') return typeof v === 'boolean' ? v : (def.standard as boolean)
  return typeof v === 'string' && def.choices!.some(([c]) => c === v) ? v : (def.standard as string)
}

/** The account that takes a payment method at the counter (null = decided by the service from the account types). */
export function posAccountFor(s: PosSettings | undefined | null, method: string): number | null {
  const a = s?.pos_settings && typeof s.pos_settings === 'object' ? (s.pos_settings as { accounts?: Record<string, unknown> }).accounts : undefined
  const id = a && typeof a === 'object' ? Number(a[method]) : NaN
  return Number.isInteger(id) && id > 0 ? id : null
}

export function normalizePosSettings(v: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if (!v || typeof v !== 'object') return out
  const src = v as Record<string, unknown>
  for (const def of POS_OPTIONS) {
    const val = src[def.key]
    if (def.kind === 'toggle' && typeof val === 'boolean') out[def.key] = val
    if (def.kind === 'select' && typeof val === 'string' && def.choices!.some(([c]) => c === val)) out[def.key] = val
  }
  if (src.accounts && typeof src.accounts === 'object') {
    const accounts: Record<string, number> = {}
    for (const m of POS_METHODS) {
      const id = Number((src.accounts as Record<string, unknown>)[m])
      if (Number.isInteger(id) && id > 0) accounts[m] = id
    }
    if (Object.keys(accounts).length) out.accounts = accounts
  }
  return out
}
