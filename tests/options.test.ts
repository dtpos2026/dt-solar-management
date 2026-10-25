/** Customizable mode: option logic, settings validation and "delete even after payments". Real services on a real SQLite database. */
import { describe, expect, it } from 'vitest'
import { normalizeOptions, optionOn, OPTIONS, OPTION_GROUPS, OPTION_PRESETS } from '../src/shared/options'
import { getAllSettings, updateSettings } from '../src/main/services/settings'
import { createAdjustment, saveProduct } from '../src/main/services/inventory'
import { partyBalance, saveParty } from '../src/main/services/parties'
import { createDocument, deleteDocument, getDocument } from '../src/main/services/documents'
import { cashAccount, qtyOf, setupCtx, userCtx, warehouse } from './helpers'

describe('option catalogue and resolution', () => {
  it('has unique keys, known groups and an explanation for every option', () => {
    const keys = OPTIONS.map((o) => o.key)
    expect(new Set(keys).size).toBe(keys.length)
    const groups = new Set(OPTION_GROUPS.map((g) => g.key))
    for (const o of OPTIONS) {
      expect(groups.has(o.group)).toBe(true)
      expect(o.label.length).toBeGreaterThan(2)
      expect(o.hint.length).toBeGreaterThan(5)
    }
  })

  it('Standard mode ignores every switch and gives the standard value; only easy delete is off by standard', () => {
    const switchedOff = Object.fromEntries(OPTIONS.map((o) => [o.key, false]))
    for (const o of OPTIONS) {
      expect(optionOn({ ui_mode: 'standard', ui_options: switchedOff }, o.key)).toBe(o.standard)
      expect(optionOn({}, o.key)).toBe(o.standard)
      expect(optionOn(undefined, o.key)).toBe(o.standard)
    }
    expect(OPTIONS.filter((o) => !o.standard).map((o) => o.key)).toEqual(['data.easy_delete'])
  })

  it('Customizable mode follows each switch; an option never set keeps its standard value; unknown keys are on', () => {
    const s = { ui_mode: 'custom', ui_options: { 'mod.crm': false, 'data.easy_delete': true, 'doc.tax': 'no' } }
    expect(optionOn(s, 'mod.crm')).toBe(false)
    expect(optionOn(s, 'data.easy_delete')).toBe(true)
    expect(optionOn(s, 'doc.tax')).toBe(true) // not a boolean: ignored
    expect(optionOn(s, 'mod.quotations')).toBe(true) // never set
    expect(optionOn(s, 'does.not.exist')).toBe(true)
  })

  it('stores only known keys with boolean values', () => {
    expect(normalizeOptions({ 'mod.crm': false, bogus: true, 'doc.tax': 1, 'item.tax': true })).toEqual({ 'mod.crm': false, 'item.tax': true })
    expect(normalizeOptions(null)).toEqual({})
    expect(normalizeOptions('x')).toEqual({})
  })

  it('presets only name real options; Everything equals Standard; Simple shop hides CRM, projects and costing and allows easy delete', () => {
    const known = new Set(OPTIONS.map((o) => o.key))
    for (const p of OPTION_PRESETS) for (const k of Object.keys(p.options)) expect(known.has(k)).toBe(true)
    const full = OPTION_PRESETS.find((p) => p.key === 'full')!
    for (const o of OPTIONS) expect(optionOn({ ui_mode: 'custom', ui_options: full.options }, o.key)).toBe(o.standard)
    const simple = { ui_mode: 'custom', ui_options: OPTION_PRESETS.find((p) => p.key === 'simple')!.options }
    for (const k of ['mod.crm', 'mod.projects', 'project.costing', 'project.details', 'doc.project_link', 'item.serials']) expect(optionOn(simple, k)).toBe(false)
    for (const k of ['mod.quotations', 'mod.purchases', 'mod.accounts', 'mod.reports', 'doc.payment_now', 'doc.notes_terms', 'data.easy_delete']) expect(optionOn(simple, k)).toBe(true)
  })
})

describe('settings: mode and options are stored, validated and audited', () => {
  it('starts in Standard mode; saves mode and options; drops unknown keys; an invalid mode falls back to Standard', () => {
    const ctx = setupCtx()
    expect(getAllSettings(ctx.db)).toMatchObject({ ui_mode: 'standard', ui_options: {} })
    updateSettings(ctx, { ui_mode: 'custom', ui_options: { 'mod.crm': false, junk: true, 'doc.tax': 'x' } })
    expect(getAllSettings(ctx.db)).toMatchObject({ ui_mode: 'custom', ui_options: { 'mod.crm': false } })
    expect(Object.keys(getAllSettings(ctx.db).ui_options as object)).toEqual(['mod.crm'])
    updateSettings(ctx, { ui_mode: 'whatever' })
    expect(getAllSettings(ctx.db).ui_mode).toBe('standard')
    // switching back to Standard keeps the chosen switches for later
    updateSettings(ctx, { ui_mode: 'custom' })
    expect(optionOn(getAllSettings(ctx.db), 'mod.crm')).toBe(false)
    updateSettings(ctx, { ui_mode: 'standard' })
    expect(optionOn(getAllSettings(ctx.db), 'mod.crm')).toBe(true)
    expect(ctx.db.prepare("SELECT COUNT(*) AS c FROM audit_log WHERE entity = 'settings' AND summary LIKE '%ui_mode%'").get()).toMatchObject({ c: 4 })
  })

  it('needs the settings permission', () => {
    const ctx = setupCtx()
    const sales = userCtx(ctx, 'Salesperson', 'sales1')
    expect(() => updateSettings(sales, { ui_mode: 'custom' })).toThrow(/permission/i)
  })
})

describe('easy delete: an invoice with payments can be deleted in Customizable mode only', () => {
  function sale() {
    const ctx = setupCtx()
    const wh = warehouse(ctx)
    const prod = saveProduct(ctx, { name: 'Panel 585W', salePrice: 30000 })
    createAdjustment(ctx, { date: '2026-01-01', warehouseId: wh, kind: 'opening', lines: [{ productId: prod, qty: 20, unitCost: 20000 }] })
    const cust = saveParty(ctx, { type: 'customer', name: 'Ali Traders' })
    const inv = createDocument(ctx, {
      docType: 'sale_invoice',
      date: '2026-03-05',
      partyId: cust,
      warehouseId: wh,
      lines: [{ productId: prod, description: 'Panel', qty: 4, rate: 30000 }],
      payment: { amount: 50000, accountId: cashAccount(ctx) }
    })
    return { ctx, prod, cust, inv }
  }

  it('Standard mode refuses with the reason (as before)', () => {
    const { ctx, inv } = sale()
    expect(() => deleteDocument(ctx, inv)).toThrow(/has payments allocated/)
    expect(getDocument(ctx, inv).status).not.toBe('cancelled')
  })

  it('Customizable mode with the option off still refuses', () => {
    const { ctx, inv } = sale()
    updateSettings(ctx, { ui_mode: 'custom', ui_options: { 'data.easy_delete': false } })
    expect(() => deleteDocument(ctx, inv)).toThrow(/has payments allocated/)
  })

  it('Customizable mode with the option on deletes it: stock back, payment kept as the customer advance, audit snapshot written', () => {
    const { ctx, prod, cust, inv } = sale()
    expect(qtyOf(ctx, prod)).toBe(16)
    expect(partyBalance(ctx, cust)).toBe(70000)
    updateSettings(ctx, { ui_mode: 'custom', ui_options: { 'data.easy_delete': true } })
    deleteDocument(ctx, inv)
    expect(ctx.db.prepare('SELECT COUNT(*) AS c FROM documents WHERE id = ?').get(inv)).toEqual({ c: 0 })
    expect(qtyOf(ctx, prod)).toBe(20)
    // the 50,000 received is still on the books as an advance (the customer owes nothing, we hold their money)
    expect(partyBalance(ctx, cust)).toBe(-50000)
    expect(ctx.db.prepare("SELECT COUNT(*) AS c FROM payment_allocations WHERE document_id = ?").get(inv)).toEqual({ c: 0 })
    const log = ctx.db.prepare("SELECT action, details FROM audit_log WHERE entity = 'sale_invoice' AND entity_id = ? AND action = 'delete'").get(inv) as { action: string; details: string }
    expect(JSON.parse(log.details).releasedAllocations).toHaveLength(1)
  })

  it('switching back to Standard refuses again; the delete permission still applies', () => {
    const { ctx, inv } = sale()
    updateSettings(ctx, { ui_mode: 'custom', ui_options: { 'data.easy_delete': true } })
    const viewer = userCtx(ctx, 'Accountant', 'viewer1')
    expect(() => deleteDocument(viewer, inv)).toThrow(/permission/i)
    updateSettings(ctx, { ui_mode: 'standard' })
    expect(() => deleteDocument(ctx, inv)).toThrow(/has payments allocated/)
  })
})
