/** Editable mode (Settings, Simple / Customize): option logic, settings validation and the services behind the options. Real services on a real SQLite database. */
import { describe, expect, it } from 'vitest'
import { OPTIONS, OPTION_PRESETS, OPTION_SCREENS, TITLE_DOCS, autoRoundOff, normalizeOptions, optionOn, optionValue, printOverrides } from '../src/shared/options'
import { amountInWords } from '../src/shared/money'
import { getAllSettings, updateSettings } from '../src/main/services/settings'
import { createAdjustment, saveProduct } from '../src/main/services/inventory'
import { partyBalance, getParty, saveParty } from '../src/main/services/parties'
import { cancelDocument, createDocument, deleteDocument, getDocument, lastSalePrices } from '../src/main/services/documents'
import { LATEST_SCHEMA_VERSION } from '../src/main/db/migrations'
import { cashAccount, qtyOf, setupCtx, userCtx, warehouse } from './helpers'

const custom = (options: Record<string, unknown>) => ({ ui_mode: 'custom', ui_options: options })

describe('option catalogue (Vyapar screens and labels)', () => {
  it('has unique keys, valid screens, sections, labels, explanations and consistent standard values', () => {
    const keys = OPTIONS.map((o) => o.key)
    expect(new Set(keys).size).toBe(keys.length)
    const screens = new Set(OPTION_SCREENS.map((s) => s.key))
    for (const o of OPTIONS) {
      expect(screens.has(o.screen)).toBe(true)
      expect(o.section.length).toBeGreaterThan(1)
      expect(o.label.length).toBeGreaterThan(2)
      expect(o.hint.length).toBeGreaterThan(5)
      if (o.kind === 'select') expect(o.choices.map((c) => c.value)).toContain(o.standard)
      if (o.kind === 'number') expect(o.standard).toBeGreaterThanOrEqual(o.min), expect(o.standard).toBeLessThanOrEqual(o.max)
    }
  })

  it('uses the Vyapar section names and labels', () => {
    const sections = (screen: string): string[] => [...new Set(OPTIONS.filter((o) => o.screen === screen).map((o) => o.section))]
    expect(sections('transaction')).toEqual(['Transaction Header', 'Items Table', 'Taxes, Discount & Total', 'More Transaction Features'])
    expect(sections('print')).toEqual(['Print Company Info/Header', 'Change Transaction Names', 'Item Table Customization', 'Totals & Taxes', 'Footer'])
    expect(sections('item')).toEqual(['Item'])
    const labels = new Set(OPTIONS.map((o) => o.label))
    for (const l of [
      'Cash Sale by default', 'Billing name of Parties', 'PO Details (of customer)', 'Add Time On Transactions', 'Barcode scanning for items', 'Display Purchase Price',
      'Show Last 5 Sale Price of Items', 'Transaction wise Discount', 'Round Off Transaction amount', 'Enable Invoice Preview', 'Terms & Conditions',
      'Print Company Name', 'Company Name Text Size', 'Company logo', 'Address', 'Email', 'Phone number', 'Extra spaces on top of PDF', 'Min. No. of rows in Item Table',
      'Total Item Quantity', 'Amount with Decimal (eg 0.00)', 'Received amount', 'Balance amount', 'Amount Grouping', 'Amount in words format', 'You Saved',
      'Print Received by details', 'Print Signature Text', 'Set Custom Signature Text', 'Payment mode',
      'Enable Item', 'Item Type', 'Stock maintenance', 'Item Units', 'Default Unit', 'Item Category', 'Item wise tax', 'Item wise discount', 'Update Sale Price from TXN', 'Description'
    ]) expect(labels.has(l), l).toBe(true)
  })

  it('has a printed-name box for every document type', () => {
    for (const [doc] of TITLE_DOCS) expect(OPTIONS.some((o) => o.key === `print.title.${doc}`)).toBe(true)
  })
})

describe('option resolution', () => {
  it('Standard mode ignores everything stored and gives the standard value; only the new features are off in Standard', () => {
    const switched = Object.fromEntries(OPTIONS.map((o) => [o.key, o.kind === 'toggle' ? !o.standard : o.kind === 'number' ? 7 : 'x']))
    for (const o of OPTIONS) {
      const s = { ui_mode: 'standard', ui_options: switched }
      if (o.kind === 'toggle') expect(optionOn(s, o.key)).toBe(o.standard)
      else expect(optionValue(s, o.key)).toBe(o.standard)
      expect(optionOn(undefined, o.key)).toBe(o.kind === 'toggle' ? o.standard : true)
    }
    expect(OPTIONS.filter((o) => o.kind === 'toggle' && !o.standard).map((o) => o.key)).toEqual([
      'txn.cash_sale', 'txn.billing_name', 'txn.time', 'item.barcode', 'txn.last_prices', 'txn.preview', 'data.easy_delete', 'print.total_qty', 'print.you_saved', 'item.update_sale_price'
    ].sort((a, b) => OPTIONS.findIndex((o) => o.key === a) - OPTIONS.findIndex((o) => o.key === b)))
  })

  it('Editable mode follows each switch and value; an option never set keeps its standard value; invalid stored values are ignored', () => {
    const s = custom({ 'mod.crm': false, 'txn.round_mode': 'nearest', 'txn.round_to': '10', 'print.min_rows': 9, 'item.default_unit': 'kW', 'item.tax': 'no', 'txn.round_to_bad': 1 })
    expect(optionOn(s, 'mod.crm')).toBe(false)
    expect(optionOn(s, 'item.tax')).toBe(true)
    expect(optionOn(s, 'mod.quotations')).toBe(true)
    expect(optionOn(s, 'does.not.exist')).toBe(true)
    expect(optionValue(s, 'txn.round_mode')).toBe('nearest')
    expect(optionValue(s, 'txn.round_to')).toBe('10')
    expect(optionValue(s, 'print.min_rows')).toBe(9)
    expect(optionValue(s, 'item.default_unit')).toBe('kW')
    expect(optionValue(custom({ 'txn.round_mode': 'sideways' }), 'txn.round_mode')).toBe('manual')
  })

  it('stores only known keys with valid values: toggles boolean, choices from the list, numbers clamped, text trimmed', () => {
    expect(normalizeOptions({ 'mod.crm': false, bogus: true, 'item.tax': 1, 'txn.round_mode': 'up', 'txn.round_to': 50, 'print.top_space': 999, 'print.min_rows': -3, 'item.default_unit': '  kW  ', 'print.company_name_size': 'huge' })).toEqual({
      'mod.crm': false, 'txn.round_mode': 'up', 'txn.round_to': '50', 'print.top_space': 80, 'print.min_rows': 0, 'item.default_unit': 'kW'
    })
    expect(normalizeOptions(null)).toEqual({})
    expect(normalizeOptions('x')).toEqual({})
  })

  it('presets only name real options with valid values; Everything equals Standard; Simple shop hides CRM, projects and costing and turns on easy delete', () => {
    const known = new Map(OPTIONS.map((o) => [o.key, o]))
    for (const p of OPTION_PRESETS) {
      for (const [k, v] of Object.entries(p.options)) {
        expect(known.has(k), k).toBe(true)
        expect(normalizeOptions({ [k]: v })[k]).toBeDefined()
      }
    }
    const full = OPTION_PRESETS.find((p) => p.key === 'full')!
    for (const o of OPTIONS) {
      if (o.kind === 'toggle') expect(optionOn(custom(full.options), o.key)).toBe(o.standard)
      else expect(optionValue(custom(full.options), o.key)).toBe(o.standard)
    }
    const simple = custom(OPTION_PRESETS.find((p) => p.key === 'simple')!.options)
    for (const k of ['mod.crm', 'mod.projects', 'project.costing', 'project.details', 'txn.project_link', 'item.serials']) expect(optionOn(simple, k)).toBe(false)
    for (const k of ['mod.quotations', 'mod.purchases', 'mod.accounts', 'mod.reports', 'txn.payment_now', 'txn.notes', 'data.easy_delete', 'txn.cash_sale', 'txn.last_prices']) expect(optionOn(simple, k)).toBe(true)
  })
})

describe('Invoice Print settings become a design override only in Editable mode', () => {
  it('is empty in Standard mode and when nothing was set', () => {
    expect(printOverrides({ ui_mode: 'standard', ui_options: { 'print.company_name': false } })).toEqual({})
    expect(printOverrides(custom({}))).toEqual({})
  })

  it('maps each Invoice Print setting to the print option it controls', () => {
    const o = printOverrides(custom({
      'print.company_name': false, 'print.address': false, 'print.tax_id': false, 'print.logo': true, 'print.total_qty': true, 'print.received': false,
      'print.company_name_size': 'small', 'print.top_space': 20, 'print.min_rows': 0, 'print.words_format': 'international', 'print.signature_text': 'Director',
      'print.title.sale_invoice': 'Tax Invoice', 'print.title.quotation': '  '
    }))
    expect(o).toEqual({
      showCompanyName: false, showAddress: false, showTaxId: false, showLogo: true, showTotalQty: true, showReceived: false,
      companyNameSize: 'small', topSpaceMm: 20, minRows: 0, wordsFormat: 'international', signatureText: 'Director', titles: { sale_invoice: 'Tax Invoice' }
    })
  })
})

describe('automatic round off and amount in words', () => {
  it('rounds the total to the chosen step: nearest, up or down; manual and exact totals add nothing', () => {
    expect(autoRoundOff(1237, 'nearest', 10)).toBe(3)
    expect(autoRoundOff(1234, 'nearest', 10)).toBe(-4)
    expect(autoRoundOff(1231, 'up', 10)).toBe(9)
    expect(autoRoundOff(1239, 'down', 10)).toBe(-9)
    expect(autoRoundOff(1236.4, 'nearest', 1)).toBe(-0.4)
    expect(autoRoundOff(1236.4, 'up', 5)).toBe(3.6)
    expect(autoRoundOff(1240, 'up', 10)).toBe(0)
    expect(autoRoundOff(1240, 'down', 10)).toBe(0)
    expect(autoRoundOff(1237, 'manual', 10)).toBe(0)
  })

  it('says amounts in lakh and crore (default) or million and billion', () => {
    expect(amountInWords(1250000)).toBe('Twelve Lakh Fifty Thousand Rupees Only')
    expect(amountInWords(1250000, 'Rupees', 'international')).toBe('One Million Two Hundred Fifty Thousand Rupees Only')
    expect(amountInWords(2345678901.5, 'Rupees', 'international')).toBe('Two Billion Three Hundred Forty Five Million Six Hundred Seventy Eight Thousand Nine Hundred One Rupees and Fifty Paisa Only')
    expect(amountInWords(0, 'Rupees', 'international')).toBe('Zero Rupees Only')
  })
})

describe('settings: mode and options are stored, validated and audited', () => {
  it('starts in Standard mode; saves mode and options; drops unknown keys and invalid values; an invalid mode falls back to Standard', () => {
    const ctx = setupCtx()
    expect(getAllSettings(ctx.db)).toMatchObject({ ui_mode: 'standard', ui_options: {} })
    updateSettings(ctx, { ui_mode: 'custom', ui_options: { 'mod.crm': false, junk: true, 'item.tax': 'x', 'txn.round_mode': 'nearest', 'txn.round_to': 'seven' } })
    expect(getAllSettings(ctx.db)).toMatchObject({ ui_mode: 'custom', ui_options: { 'mod.crm': false, 'txn.round_mode': 'nearest' } })
    expect(Object.keys(getAllSettings(ctx.db).ui_options as object).sort()).toEqual(['mod.crm', 'txn.round_mode'])
    updateSettings(ctx, { ui_mode: 'whatever' })
    expect(getAllSettings(ctx.db).ui_mode).toBe('standard')
    updateSettings(ctx, { ui_mode: 'custom' })
    expect(optionOn(getAllSettings(ctx.db), 'mod.crm')).toBe(false)
    updateSettings(ctx, { ui_mode: 'standard' })
    expect(optionOn(getAllSettings(ctx.db), 'mod.crm')).toBe(true)
    expect(ctx.db.prepare("SELECT COUNT(*) AS c FROM audit_log WHERE entity = 'settings' AND summary LIKE '%ui_mode%'").get()).toMatchObject({ c: 4 })
  })

  it('needs the settings permission', () => {
    const ctx = setupCtx()
    expect(() => updateSettings(userCtx(ctx, 'Salesperson', 'sales1'), { ui_mode: 'custom' })).toThrow(/permission/i)
  })
})

function shop() {
  const ctx = setupCtx()
  const wh = warehouse(ctx)
  const prod = saveProduct(ctx, { name: 'Panel 585W', salePrice: 30000 })
  createAdjustment(ctx, { date: '2026-01-01', warehouseId: wh, kind: 'opening', lines: [{ productId: prod, qty: 20, unitCost: 20000 }] })
  const cust = saveParty(ctx, { type: 'customer', name: 'Ali Traders' })
  const other = saveParty(ctx, { type: 'customer', name: 'Bilal Solar' })
  const sell = (partyId: number | null, rate: number, qty = 1, date = '2026-03-05', pay = 0) =>
    createDocument(ctx, { docType: 'sale_invoice', date, partyId, warehouseId: wh, lines: [{ productId: prod, description: 'Panel', qty, rate }], ...(pay ? { payment: { amount: pay, accountId: cashAccount(ctx) } } : {}) })
  return { ctx, wh, prod, cust, other, sell }
}

describe('easy delete: an invoice with payments can be deleted in Editable mode only', () => {
  it('Standard mode refuses with the reason (as before)', () => {
    const { ctx, cust, sell } = shop()
    const inv = sell(cust, 30000, 4, '2026-03-05', 50000)
    expect(() => deleteDocument(ctx, inv)).toThrow(/has payments allocated/)
    expect(getDocument(ctx, inv).status).not.toBe('cancelled')
  })

  it('Editable mode with the option off still refuses', () => {
    const { ctx, cust, sell } = shop()
    const inv = sell(cust, 30000, 4, '2026-03-05', 50000)
    updateSettings(ctx, { ui_mode: 'custom', ui_options: { 'data.easy_delete': false } })
    expect(() => deleteDocument(ctx, inv)).toThrow(/has payments allocated/)
  })

  it('Editable mode with the option on deletes it: stock back, payment kept as the customer advance, audit snapshot written', () => {
    const { ctx, prod, cust, sell } = shop()
    const inv = sell(cust, 30000, 4, '2026-03-05', 50000)
    expect(qtyOf(ctx, prod)).toBe(16)
    expect(partyBalance(ctx, cust)).toBe(70000)
    updateSettings(ctx, { ui_mode: 'custom', ui_options: { 'data.easy_delete': true } })
    deleteDocument(ctx, inv)
    expect(ctx.db.prepare('SELECT COUNT(*) AS c FROM documents WHERE id = ?').get(inv)).toEqual({ c: 0 })
    expect(qtyOf(ctx, prod)).toBe(20)
    expect(partyBalance(ctx, cust)).toBe(-50000)
    expect(ctx.db.prepare('SELECT COUNT(*) AS c FROM payment_allocations WHERE document_id = ?').get(inv)).toEqual({ c: 0 })
    const log = ctx.db.prepare("SELECT details FROM audit_log WHERE entity = 'sale_invoice' AND entity_id = ? AND action = 'delete'").get(inv) as { details: string }
    expect(JSON.parse(log.details).releasedAllocations).toHaveLength(1)
  })

  it('switching back to Standard refuses again; the delete permission still applies', () => {
    const { ctx, cust, sell } = shop()
    const inv = sell(cust, 30000, 4, '2026-03-05', 50000)
    updateSettings(ctx, { ui_mode: 'custom', ui_options: { 'data.easy_delete': true } })
    expect(() => deleteDocument(userCtx(ctx, 'Accountant', 'viewer1'), inv)).toThrow(/permission/i)
    updateSettings(ctx, { ui_mode: 'standard' })
    expect(() => deleteDocument(ctx, inv)).toThrow(/has payments allocated/)
  })
})

describe('Show Last 5 Sale Price of Items', () => {
  it('lists the last five sale rates, the chosen customer first, and leaves out cancelled invoices', () => {
    const { ctx, prod, cust, other, sell } = shop()
    sell(cust, 29000, 1, '2026-01-10')
    sell(other, 30500, 1, '2026-02-01')
    sell(cust, 29500, 1, '2026-02-15')
    sell(other, 31000, 1, '2026-03-01')
    const gone = sell(other, 99999, 1, '2026-03-02')
    cancelDocument(ctx, gone, 'wrong')
    sell(null, 28000, 1, '2026-03-03', 28000)
    sell(other, 30800, 1, '2026-03-04')
    const rows = lastSalePrices(ctx, { productId: prod, partyId: cust })
    expect(rows).toHaveLength(5)
    expect(rows.map((r) => r.rate)).toEqual([29500, 29000, 30800, 28000, 31000])
    expect(rows.map((r) => r.same_party)).toEqual([1, 1, 0, 0, 0])
    expect(rows.some((r) => r.rate === 99999)).toBe(false)
    // without a customer it is simply the newest first
    expect(lastSalePrices(ctx, { productId: prod }).map((r) => r.rate).slice(0, 2)).toEqual([30800, 28000])
    expect(() => lastSalePrices(userCtx(ctx, 'Inventory Manager', 'inv1'), { productId: prod })).toThrow(/permission/i)
  })
})

describe('Update Sale Price from TXN', () => {
  const salePrice = (ctx: ReturnType<typeof setupCtx>, id: number): number => (ctx.db.prepare('SELECT sale_price FROM products WHERE id = ?').get(id) as { sale_price: number }).sale_price

  it('does nothing in Standard mode, and a sales invoice sets the item sale price when the option is on (not purchases or quotations)', () => {
    const { ctx, wh, prod, cust, sell } = shop()
    sell(cust, 28000)
    expect(salePrice(ctx, prod)).toBe(30000)
    updateSettings(ctx, { ui_mode: 'custom', ui_options: { 'item.update_sale_price': true } })
    createDocument(ctx, { docType: 'quotation', date: '2026-03-06', partyId: cust, lines: [{ productId: prod, description: 'Panel', qty: 1, rate: 1 }] })
    createDocument(ctx, { docType: 'purchase_invoice', date: '2026-03-06', partyId: saveParty(ctx, { type: 'supplier', name: 'Wholesale' }), warehouseId: wh, lines: [{ productId: prod, description: 'Panel', qty: 1, rate: 2 }] })
    expect(salePrice(ctx, prod)).toBe(30000)
    sell(cust, 28500)
    expect(salePrice(ctx, prod)).toBe(28500)
    expect(ctx.db.prepare("SELECT COUNT(*) AS c FROM audit_log WHERE entity = 'product' AND summary LIKE 'Sale price set to 28500%'").get()).toEqual({ c: 1 })
  })
})

describe('Stock maintenance off', () => {
  it('Standard mode refuses to sell more than the stock; with the option off the sale goes through and the movement is still recorded', () => {
    const { ctx, prod, cust, sell } = shop()
    expect(() => sell(cust, 30000, 25)).toThrow(/Insufficient stock/)
    updateSettings(ctx, { ui_mode: 'custom', ui_options: { 'item.stock': false } })
    sell(cust, 30000, 25)
    expect(qtyOf(ctx, prod)).toBe(-5)
    updateSettings(ctx, { ui_mode: 'standard' })
    expect(() => sell(cust, 30000, 1)).toThrow(/Insufficient stock/)
  })
})

describe('Billing name of Parties', () => {
  it('is stored, kept when a caller does not send it, cleared when sent empty, and comes with the document for printing', () => {
    const { ctx, cust, sell } = shop()
    expect(LATEST_SCHEMA_VERSION).toBeGreaterThanOrEqual(11)
    saveParty(ctx, { id: cust, type: 'customer', name: 'Ali Traders', billingName: 'Ali Traders (Pvt) Ltd' })
    expect(getParty(ctx, cust).billing_name).toBe('Ali Traders (Pvt) Ltd')
    saveParty(ctx, { id: cust, type: 'customer', name: 'Ali Traders', phone: '0300-1' })
    expect(getParty(ctx, cust).billing_name).toBe('Ali Traders (Pvt) Ltd')
    const inv = sell(cust, 30000)
    expect(getDocument(ctx, inv).party_billing_name).toBe('Ali Traders (Pvt) Ltd')
    saveParty(ctx, { id: cust, type: 'customer', name: 'Ali Traders', billingName: '' })
    expect(getParty(ctx, cust).billing_name).toBeNull()
  })
})
