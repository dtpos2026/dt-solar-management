import { describe, expect, it } from 'vitest'
import type { Ctx } from '../src/main/services/context'
import { setSetting } from '../src/main/services/context'
import {
  archiveProducts,
  changeProductsCategory,
  createAdjustment,
  deleteCategory,
  deleteProduct,
  getProduct,
  getProductUsage,
  listCategories,
  listMovements,
  listProducts,
  listWarehouses,
  lookupSerial,
  restoreProducts,
  saveCategory,
  saveProduct,
  saveWarehouse,
  stockReport,
  transferStock
} from '../src/main/services/inventory'
import { createPartyAdjustment, getParty, listParties, partyBalance, partyLedger, saveParty } from '../src/main/services/parties'
import { createDocument, getDocument, listDocuments } from '../src/main/services/documents'
import { accountLedger, createPayment, getPayment, listAccounts, listPayments } from '../src/main/services/payments'
import { createExpense, getExpense, listExpenses } from '../src/main/services/expenses'
import {
  cancelProject,
  createMaterialMove,
  deleteProject,
  getMaterialMove,
  getProject,
  getProjectLinks,
  listMaterialMoves,
  listProjects,
  materialUsage,
  projectLedger,
  projectOptions,
  projectProfitReport,
  saveProject,
  setProjectArchived
} from '../src/main/services/projects'
import {
  assignSharedRecords,
  createFirm,
  firmDeactivationImpact,
  firmLimits,
  listFirms,
  planSharedAssignment,
  setDefaultFirm,
  setFirmActive,
  updateFirm
} from '../src/main/services/firms'
import { plFigures } from '../src/main/services/reports'
import { buildSessionUser, saveUser } from '../src/main/services/auth'
import { cashAccount, qtyOf, setupCtx, userCtx, warehouse } from './helpers'

const ids = (rows: unknown): number[] => (rows as Array<{ id: number }>).map((r) => r.id).sort((a, b) => a - b)
const listIds = (r: { rows: unknown[] }): number[] => ids(r.rows)
const firmWarehouse = (ctx: Ctx): number =>
  (ctx.db.prepare('SELECT id FROM warehouses WHERE firm_id = ? ORDER BY id LIMIT 1').get(ctx.firmId) as { id: number }).id
const firmAccount = (ctx: Ctx): number =>
  (ctx.db.prepare('SELECT id FROM accounts WHERE firm_id = ? ORDER BY id LIMIT 1').get(ctx.firmId) as { id: number }).id
const expenseCategory = (ctx: Ctx): number => (ctx.db.prepare('SELECT id FROM expense_categories ORDER BY id LIMIT 1').get() as { id: number }).id
const auditActions = (ctx: Ctx, entity: string): string[] =>
  (ctx.db.prepare('SELECT action FROM audit_log WHERE entity = ? ORDER BY id').all(entity) as Array<{ action: string }>).map((r) => r.action)

/* ===================================================================================================== */

describe('products: delete vs archive, restore', () => {
  it('deletes a never-used product permanently', () => {
    const ctx = setupCtx()
    const p = saveProduct(ctx, { name: 'Unused panel', salePrice: 100 })
    expect(getProductUsage(ctx, p).used).toBe(false)
    const r = deleteProduct(ctx, p)
    expect(r.deleted).toBe(true)
    expect(r.archived).toBe(false)
    expect(ctx.db.prepare('SELECT 1 FROM products WHERE id = ?').get(p)).toBeUndefined()
    expect(auditActions(ctx, 'product')).toContain('delete')
  })

  it('archives a used product instead of deleting it and keeps stock, movements and documents', () => {
    const ctx = setupCtx()
    const wh = warehouse(ctx)
    const p = saveProduct(ctx, { name: 'Inverter 6kW', salePrice: 200 })
    createAdjustment(ctx, { date: '2026-01-01', warehouseId: wh, kind: 'opening', lines: [{ productId: p, qty: 5, unitCost: 100 }] })
    const cust = saveParty(ctx, { type: 'customer', name: 'Cust' })
    const inv = createDocument(ctx, { docType: 'sale_invoice', date: '2026-01-02', partyId: cust, warehouseId: wh, lines: [{ productId: p, description: 'Inverter 6kW', qty: 2, rate: 200 }] })
    const movesBefore = (ctx.db.prepare('SELECT COUNT(*) AS c FROM stock_movements WHERE product_id = ?').get(p) as { c: number }).c
    const pl = plFigures(ctx.db, [ctx.firmId], '2026-01-01', '2026-12-31')

    const r = deleteProduct(ctx, p)
    expect(r.deleted).toBe(false)
    expect(r.archived).toBe(true)
    expect(r.message).toMatch(/not deleted because it has history/)
    expect(r.message).toMatch(/stock movement/)
    expect(r.message).toMatch(/archived/)
    const row = ctx.db.prepare('SELECT is_active, archived_at FROM products WHERE id = ?').get(p) as { is_active: number; archived_at: string | null }
    expect(row.is_active).toBe(0)
    expect(row.archived_at).toBeTruthy()
    // books unchanged
    expect(qtyOf(ctx, p)).toBe(3)
    expect((ctx.db.prepare('SELECT COUNT(*) AS c FROM stock_movements WHERE product_id = ?').get(p) as { c: number }).c).toBe(movesBefore)
    expect(plFigures(ctx.db, [ctx.firmId], '2026-01-01', '2026-12-31')).toEqual(pl)
    // history still shows it
    const d = getDocument(ctx, inv) as { lines: Array<{ product_name: string }> }
    expect(d.lines[0].product_name).toBe('Inverter 6kW')
    // hidden from pickers, visible under "archived"
    expect(listIds(listProducts(ctx, {}))).not.toContain(p)
    expect(listIds(listProducts(ctx, { active: 'archived' }))).toContain(p)
    expect(listIds(listProducts(ctx, { active: 'all' }))).toContain(p)
  })

  it('archives a product that only appears on a quotation (no stock effect)', () => {
    const ctx = setupCtx()
    const p = saveProduct(ctx, { name: 'Battery', salePrice: 50 })
    createDocument(ctx, { docType: 'quotation', date: '2026-01-01', partyName: 'Walk in', lines: [{ productId: p, description: 'Battery', qty: 1, rate: 50 }] })
    const r = deleteProduct(ctx, p)
    expect(r.archived).toBe(true)
    expect(r.usage.documents).toBe(1)
    expect(ctx.db.prepare('SELECT 1 FROM products WHERE id = ?').get(p)).toBeTruthy()
  })

  it('restores archived products; editing an archived product does not restore it by accident', () => {
    const ctx = setupCtx()
    const wh = warehouse(ctx)
    const a = saveProduct(ctx, { name: 'A' })
    const b = saveProduct(ctx, { name: 'B' })
    createAdjustment(ctx, { date: '2026-01-01', warehouseId: wh, kind: 'opening', lines: [{ productId: a, qty: 2, unitCost: 10 }] })
    const res = archiveProducts(ctx, [a, b])
    expect(res.archived).toBe(2)
    expect(res.withStock).toEqual([{ id: a, name: 'A', qty: 2 }])
    saveProduct(ctx, { id: a, name: 'A renamed' })
    expect((ctx.db.prepare('SELECT is_active FROM products WHERE id = ?').get(a) as { is_active: number }).is_active).toBe(0)
    expect(restoreProducts(ctx, [a, b]).restored).toBe(2)
    const row = ctx.db.prepare('SELECT is_active, archived_at, name FROM products WHERE id = ?').get(a) as { is_active: number; archived_at: string | null; name: string }
    expect(row).toEqual({ is_active: 1, archived_at: null, name: 'A renamed' })
    expect(listIds(listProducts(ctx, {}))).toEqual(expect.arrayContaining([a, b]))
    expect(auditActions(ctx, 'product')).toEqual(expect.arrayContaining(['archive', 'restore']))
  })

  it('archived products cannot be issued to projects, but issued material can still be returned', () => {
    const ctx = setupCtx()
    const wh = warehouse(ctx)
    const p = saveProduct(ctx, { name: 'Cable' })
    createAdjustment(ctx, { date: '2026-01-01', warehouseId: wh, kind: 'opening', lines: [{ productId: p, qty: 10, unitCost: 10 }] })
    const pr = saveProject(ctx, { name: 'Site' })
    createMaterialMove(ctx, { projectId: pr, direction: 'issue', date: '2026-01-02', warehouseId: wh, lines: [{ productId: p, qty: 4 }] })
    archiveProducts(ctx, [p])
    expect(() => createMaterialMove(ctx, { projectId: pr, direction: 'issue', date: '2026-01-03', warehouseId: wh, lines: [{ productId: p, qty: 1 }] })).toThrow(/archived/)
    createMaterialMove(ctx, { projectId: pr, direction: 'return', date: '2026-01-03', warehouseId: wh, lines: [{ productId: p, qty: 1 }] })
    expect(qtyOf(ctx, p)).toBe(7)
  })

  it('requires the inventory.delete permission (owner always allowed)', () => {
    const owner = setupCtx()
    const p = saveProduct(owner, { name: 'X' })
    const im = userCtx(owner, 'Inventory Manager', 'invmgr')
    expect(im.user.permissions).not.toContain('inventory.delete')
    expect(() => deleteProduct(im, p)).toThrow(/permission/)
    expect(() => archiveProducts(im, [p])).toThrow(/permission/)
    expect(() => saveProduct(im, { id: p, name: 'X', isActive: false })).toThrow(/permission/)
    const admin = userCtx(owner, 'Administrator', 'admin2')
    expect(deleteProduct(admin, p).deleted).toBe(true)
  })
})

/* ===================================================================================================== */

describe('categories: change, rename, delete with reassign', () => {
  function stockState(ctx: Ctx, from = '2026-01-01', to = '2026-12-31'): unknown {
    const rep = stockReport(ctx, { includeZero: true }) as { totalValue: number; rows: Array<{ id: number; qty: number; value: number }> }
    return {
      totalValue: rep.totalValue,
      perProduct: rep.rows.map((r) => [r.id, r.qty, r.value]).sort((a, b) => Number(a[0]) - Number(b[0])),
      pl: plFigures(ctx.db, [ctx.firmId], from, to),
      moves: (ctx.db.prepare('SELECT COUNT(*) AS c, SUM(qty_in) AS i, SUM(qty_out) AS o FROM stock_movements').get() as object)
    }
  }

  function seed(): { ctx: Ctx; panels: number; inverters: number; p1: number; p2: number; p3: number } {
    const ctx = setupCtx()
    const wh = warehouse(ctx)
    const panels = saveCategory(ctx, { name: 'Test Panels' })
    const inverters = saveCategory(ctx, { name: 'Test Inverters' })
    const p1 = saveProduct(ctx, { name: 'Panel 1', categoryId: panels, salePrice: 30 })
    const p2 = saveProduct(ctx, { name: 'Panel 2', categoryId: panels, salePrice: 30 })
    const p3 = saveProduct(ctx, { name: 'Inverter', categoryId: inverters, salePrice: 300 })
    createAdjustment(ctx, { date: '2026-01-01', warehouseId: wh, kind: 'opening', lines: [{ productId: p1, qty: 10, unitCost: 20 }, { productId: p2, qty: 5, unitCost: 22 }, { productId: p3, qty: 2, unitCost: 250 }] })
    const cust = saveParty(ctx, { type: 'customer', name: 'C' })
    createDocument(ctx, { docType: 'sale_invoice', date: '2026-02-01', partyId: cust, warehouseId: wh, lines: [{ productId: p1, description: 'Panel 1', qty: 3, rate: 30 }] })
    return { ctx, panels, inverters, p1, p2, p3 }
  }

  it('changing a product category (form or bulk) keeps stock and reports identical', () => {
    const { ctx, inverters, p1, p2 } = seed()
    const before = stockState(ctx)
    saveProduct(ctx, { id: p1, name: 'Panel 1', categoryId: inverters, salePrice: 30 })
    expect((getProduct(ctx, p1) as { category_name: string }).category_name).toBe('Test Inverters')
    expect(changeProductsCategory(ctx, [p1, p2], null).changed).toBe(2)
    expect(changeProductsCategory(ctx, [p1, p2], inverters).changed).toBe(2)
    expect(stockState(ctx)).toEqual(before)
    const cats = listCategories(ctx) as Array<{ id: number; product_count: number }>
    expect(cats.find((c) => c.id === inverters)?.product_count).toBe(3)
    expect(stockReport(ctx, { categoryId: inverters }) as { rows: unknown[] }).toMatchObject({ rows: expect.any(Array) })
    expect((stockReport(ctx, { categoryId: inverters }) as { rows: unknown[] }).rows).toHaveLength(3)
  })

  it('renames and changes the kind of a category', () => {
    const { ctx, panels } = seed()
    saveCategory(ctx, { id: panels, name: 'PV Modules', kind: 'service' })
    const c = (listCategories(ctx) as Array<{ id: number; name: string; kind: string }>).find((x) => x.id === panels)
    expect(c).toMatchObject({ name: 'PV Modules', kind: 'service' })
    expect(() => saveCategory(ctx, { name: 'pv modules' })).toThrow(/already exists/)
  })

  it('deletes an empty category, refuses one with products until a destination is chosen, then moves them in one step', () => {
    const { ctx, panels, inverters, p1, p2 } = seed()
    const empty = saveCategory(ctx, { name: 'Empty' })
    expect(deleteCategory(ctx, empty).moved).toBe(0)
    const before = stockState(ctx)
    expect(() => deleteCategory(ctx, panels)).toThrow(/Choose a category/)
    expect(() => deleteCategory(ctx, panels, { moveToCategoryId: panels })).toThrow(/different category/)
    expect(ctx.db.prepare('SELECT 1 FROM categories WHERE id = ?').get(panels)).toBeTruthy()
    const r = deleteCategory(ctx, panels, { moveToCategoryId: inverters })
    expect(r.moved).toBe(2)
    expect(ctx.db.prepare('SELECT 1 FROM categories WHERE id = ?').get(panels)).toBeUndefined()
    for (const p of [p1, p2]) expect((ctx.db.prepare('SELECT category_id FROM products WHERE id = ?').get(p) as { category_id: number }).category_id).toBe(inverters)
    expect(stockState(ctx)).toEqual(before)
    // "no category" destination
    const r2 = deleteCategory(ctx, inverters, { clearCategory: true })
    expect(r2.moved).toBe(3)
    expect((ctx.db.prepare('SELECT COUNT(*) AS c FROM products WHERE category_id IS NULL AND id IN (?, ?)').get(p1, p2) as { c: number }).c).toBe(2)
    expect(stockState(ctx)).toEqual(before)
  })
})

/* ===================================================================================================== */

describe('projects: delete vs archive', () => {
  it('deletes a project with no linked records', () => {
    const ctx = setupCtx()
    const pr = saveProject(ctx, { name: 'Empty project' })
    expect(getProjectLinks(ctx, pr).total).toBe(0)
    expect(deleteProject(ctx, pr)).toEqual({ deleted: true })
    expect(ctx.db.prepare('SELECT 1 FROM projects WHERE id = ?').get(pr)).toBeUndefined()
    expect(auditActions(ctx, 'project')).toContain('delete')
  })

  it('refuses to delete a project with records, archives and restores it, never touching the records', () => {
    const ctx = setupCtx()
    const wh = warehouse(ctx)
    const cust = saveParty(ctx, { type: 'customer', name: 'Cust' })
    const pr = saveProject(ctx, { name: 'Site A', customerId: cust })
    const p = saveProduct(ctx, { name: 'Panel' })
    createAdjustment(ctx, { date: '2026-01-01', warehouseId: wh, kind: 'opening', lines: [{ productId: p, qty: 10, unitCost: 100 }] })
    createMaterialMove(ctx, { projectId: pr, direction: 'issue', date: '2026-01-02', warehouseId: wh, lines: [{ productId: p, qty: 4 }] })
    const pay = createPayment(ctx, { date: '2026-01-03', direction: 'in', partyId: cust, accountId: cashAccount(ctx), amount: 1000, projectId: pr })
    const links = getProjectLinks(ctx, pr)
    expect(links.payments).toBe(1)
    expect(links.materialMoves).toBe(1)
    const profitBefore = (projectProfitReport(ctx) as { totals: unknown }).totals

    expect(() => deleteProject(ctx, pr)).toThrow(/cannot be deleted.*1 payment.*Archive/)
    expect(ctx.db.prepare('SELECT 1 FROM projects WHERE id = ?').get(pr)).toBeTruthy()
    expect(getPayment(ctx, pay)).toBeTruthy()

    setProjectArchived(ctx, pr, true)
    expect(ids(listProjects(ctx))).not.toContain(pr)
    expect(ids(listProjects(ctx, { archived: 'only' }))).toEqual([pr])
    expect(ids(listProjects(ctx, { archived: 'all' }))).toContain(pr)
    expect(ids(projectOptions(ctx))).not.toContain(pr)
    expect((getProject(ctx, pr) as { is_archived: number }).is_archived).toBe(1)
    // reports unchanged, records intact, no new material moves on an archived project
    expect((projectProfitReport(ctx) as { totals: unknown }).totals).toEqual(profitBefore)
    expect(qtyOf(ctx, p)).toBe(6)
    expect(() => createMaterialMove(ctx, { projectId: pr, direction: 'issue', date: '2026-01-04', warehouseId: wh, lines: [{ productId: p, qty: 1 }] })).toThrow(/archived/)

    setProjectArchived(ctx, pr, false)
    expect(ids(listProjects(ctx))).toContain(pr)
    expect(ids(projectOptions(ctx))).toContain(pr)
    expect(auditActions(ctx, 'project')).toEqual(expect.arrayContaining(['archive', 'restore']))
  })

  it('a project with only an attached file or a party adjustment is not deleted', () => {
    const ctx = setupCtx()
    const cust = saveParty(ctx, { type: 'customer', name: 'Cust' })
    const a = saveProject(ctx, { name: 'With file' })
    ctx.db.prepare("INSERT INTO attachments (entity, entity_id, file_name, stored_name) VALUES ('project', ?, 'site.jpg', 'x.jpg')").run(a)
    expect(() => deleteProject(ctx, a)).toThrow(/attached file/)
    const b = saveProject(ctx, { name: 'With adjustment' })
    createPartyAdjustment(ctx, { date: '2026-01-01', partyId: cust, direction: 'debit', amount: 50, projectId: b })
    expect(() => deleteProject(ctx, b)).toThrow(/balance adjustment/)
  })

  it('cancels a project (excluded from pickers) and checks permissions', () => {
    const owner = setupCtx()
    const pr = saveProject(owner, { name: 'To cancel', status: 'in_progress' })
    cancelProject(owner, pr, 'Customer withdrew')
    expect((getProject(owner, pr) as { status: string }).status).toBe('cancelled')
    expect(ids(projectOptions(owner))).not.toContain(pr)
    expect(() => cancelProject(owner, pr)).toThrow(/already cancelled/)
    const done = saveProject(owner, { name: 'Done', status: 'completed' })
    expect(() => cancelProject(owner, done)).toThrow(/completed/)
    const pm = userCtx(owner, 'Project Manager', 'pm1')
    expect(() => deleteProject(pm, done)).toThrow(/permission/)
    expect(() => setProjectArchived(pm, done, true)).toThrow(/permission/)
  })
})

/* ===================================================================================================== */

describe('firms: license limit, activation rules', () => {
  it('counts only active firms against the limit on create AND reactivate', () => {
    const ctx = setupCtx()
    const f2 = createFirm(ctx, { name: 'F2' }, 2)
    expect(() => createFirm(ctx, { name: 'F3' }, 2)).toThrow(/2 of 2 active firms/)
    setFirmActive(ctx, f2, false, 2)
    expect(firmLimits(ctx.db, 2)).toMatchObject({ allowed: 2, active: 1, inactive: 1, total: 2 })
    const f3 = createFirm(ctx, { name: 'F3' }, 2)
    expect(() => setFirmActive(ctx, f2, true, 2)).toThrow(/maximum 2/)
    setFirmActive(ctx, f3, false, 2)
    expect(setFirmActive(ctx, f2, true, 2).active).toBe(true)
    // the max_firms setting is applied too (lower than the license)
    setSetting(ctx.db, 'max_firms', 2)
    expect(() => setFirmActive(ctx, f3, true, 10)).toThrow(/Maximum firms/)
    expect(() => createFirm(ctx, { name: 'F4' }, 10)).toThrow(/maximum 2/)
  })

  it('refuses to deactivate the default firm or the firm the user is working in', () => {
    const ctx = setupCtx()
    const f2 = createFirm(ctx, { name: 'F2' }, 5)
    expect(() => setFirmActive(ctx, ctx.firmId, false, 5)).toThrow(/default firm cannot be deactivated/)
    const inF2 = { ...ctx, firmId: f2 }
    expect(() => setFirmActive(inF2, f2, false, 5)).toThrow(/working in this firm/)
    expect(firmDeactivationImpact(inF2, f2).canDeactivate).toBe(false)
    // an inactive firm cannot become the default
    setFirmActive(ctx, f2, false, 5)
    expect(() => setDefaultFirm(ctx, f2)).toThrow(/Activate/)
  })

  it('moves users whose last firm is deactivated to the default firm and keeps restricted users able to sign in', () => {
    const owner = setupCtx()
    const f2 = createFirm(owner, { name: 'F2' }, 5)
    const role = (owner.db.prepare("SELECT id FROM roles WHERE name = 'Salesperson'").get() as { id: number }).id
    const onlyF2 = saveUser(owner, { username: 'only2', fullName: 'Only F2', roleId: role, password: 'secret123', allFirms: false, firmIds: [f2] })
    const both = saveUser(owner, { username: 'both', fullName: 'Both', roleId: role, password: 'secret123', allFirms: true })
    const keepOut = saveUser(owner, { username: 'keepout', fullName: 'Keep out', roleId: role, password: 'secret123', allFirms: false, firmIds: [f2] })
    owner.db.prepare('UPDATE users SET last_firm_id = ? WHERE id IN (?, ?, ?)').run(f2, onlyF2, both, keepOut)
    const impact = firmDeactivationImpact(owner, f2)
    expect(impact.canDeactivate).toBe(true)
    expect(impact.lastFirmUsers.map((u) => u.username).sort()).toEqual(['both', 'keepout', 'only2'])
    expect(impact.strandedUsers.map((u) => u.username).sort()).toEqual(['keepout', 'only2'])

    // documents of the firm stay untouched
    const ctx2 = { ...owner, firmId: f2 }
    const cust = saveParty(owner, { type: 'customer', name: 'C' })
    createDocument(ctx2, { docType: 'quotation', date: '2026-01-01', partyId: cust, lines: [{ description: 'x', qty: 1, rate: 10 }] })
    // grant only "only2": deactivate with grant, then remove keepout's grant to show the opt-out path separately
    const r = setFirmActive(owner, f2, false, 5)
    expect(r).toMatchObject({ active: false, movedUsers: 3, grantedUsers: 2 })
    for (const u of [onlyF2, both, keepOut]) expect((owner.db.prepare('SELECT last_firm_id FROM users WHERE id = ?').get(u) as { last_firm_id: number }).last_firm_id).toBe(owner.firmId)
    const su = buildSessionUser(owner.db, onlyF2)
    const visible = (listFirms(owner.db, su) as Array<{ id: number; is_active: number }>).filter((f) => f.is_active)
    expect(visible.map((f) => f.id)).toEqual([owner.firmId])
    expect((owner.db.prepare('SELECT COUNT(*) AS c FROM documents WHERE firm_id = ?').get(f2) as { c: number }).c).toBe(1)
    expect(auditActions(owner, 'firm')).toContain('deactivate')

    // opt-out of granting access
    setFirmActive(owner, f2, true, 5)
    owner.db.prepare('DELETE FROM user_firms WHERE user_id = ? AND firm_id = ?').run(keepOut, owner.firmId)
    const r2 = setFirmActive(owner, f2, false, 5, { grantDefaultAccess: false })
    expect(r2.grantedUsers).toBe(0)
    expect(owner.db.prepare('SELECT 1 FROM user_firms WHERE user_id = ? AND firm_id = ?').get(keepOut, owner.firmId)).toBeUndefined()
  })

  it('activation through the firm editor follows the same rules', () => {
    const ctx = setupCtx()
    const f2 = createFirm(ctx, { name: 'F2' }, 2)
    expect(() => updateFirm(ctx, { id: f2, name: 'F2', isActive: false })).toThrow(/Activate \/ Deactivate/)
    updateFirm(ctx, { id: f2, name: 'F2 renamed', isActive: false }, 2)
    expect((ctx.db.prepare('SELECT is_active, name FROM firms WHERE id = ?').get(f2) as object)).toEqual({ is_active: 0, name: 'F2 renamed' })
    expect(() => updateFirm(ctx, { id: ctx.firmId, name: 'Main', isActive: false }, 2)).toThrow(/default firm/)
  })
})

/* ===================================================================================================== */

describe('firm isolation with sharing off', () => {
  function twoFirms(): Record<string, number> & { c1: Ctx; c2: Ctx } {
    const c1 = setupCtx({ shareInventory: false, shareParties: false })
    const f2 = createFirm(c1, { name: 'SECOND FIRM' }, 5)
    const c2: Ctx = { ...c1, firmId: f2 }
    const out: Record<string, number> = {}
    for (const [k, ctx] of [['1', c1], ['2', c2]] as Array<[string, Ctx]>) {
      const wh = firmWarehouse(ctx)
      const cat = saveCategory(ctx, { name: `Cat ${k}` })
      const extraWh = saveWarehouse(ctx, { name: `Store ${k}` })
      const prod = saveProduct(ctx, { name: `Product ${k}`, categoryId: cat, salePrice: 100, trackSerial: true })
      createAdjustment(ctx, { date: '2026-01-01', warehouseId: wh, kind: 'opening', lines: [{ productId: prod, qty: 2, unitCost: 50, serials: `SN${k}A, SN${k}B` }] })
      const cust = saveParty(ctx, { type: 'customer', name: `Customer ${k}` })
      const sup = saveParty(ctx, { type: 'supplier', name: `Supplier ${k}` })
      const proj = saveProject(ctx, { name: `Project ${k}`, customerId: cust })
      createMaterialMove(ctx, { projectId: proj, direction: 'issue', date: '2026-01-02', warehouseId: wh, lines: [{ productId: prod, qty: 1, serials: `SN${k}A` }] })
      const move = (ctx.db.prepare('SELECT id FROM material_moves WHERE project_id = ?').get(proj) as { id: number }).id
      const doc = createDocument(ctx, { docType: 'sale_invoice', date: '2026-01-03', partyId: cust, projectId: proj, warehouseId: wh, lines: [{ productId: prod, description: `Product ${k}`, qty: 1, rate: 100, serials: `SN${k}B` }] })
      const pay = createPayment(ctx, { date: '2026-01-04', direction: 'in', partyId: cust, accountId: firmAccount(ctx), amount: 60, projectId: proj })
      const exp = createExpense(ctx, { date: '2026-01-05', categoryId: expenseCategory(ctx), amount: 10, paid: true, accountId: firmAccount(ctx), projectId: proj })
      Object.assign(out, { [`wh${k}`]: wh, [`cat${k}`]: cat, [`extraWh${k}`]: extraWh, [`prod${k}`]: prod, [`cust${k}`]: cust, [`sup${k}`]: sup, [`proj${k}`]: proj, [`move${k}`]: move, [`doc${k}`]: doc, [`pay${k}`]: pay, [`exp${k}`]: exp, [`acc${k}`]: firmAccount(ctx) })
    }
    return { ...out, c1, c2 } as Record<string, number> & { c1: Ctx; c2: Ctx }
  }

  it('lists only the active firm records', () => {
    const t = twoFirms()
    for (const [me, other, ctx] of [['1', '2', t.c1], ['2', '1', t.c2]] as Array<[string, string, Ctx]>) {
      const m = (k: string): number => t[`${k}${me}`]
      const o = (k: string): number => t[`${k}${other}`]
      expect(listIds(listProducts(ctx, { active: 'all' }))).toEqual([m('prod')])
      const cats = ids(listCategories(ctx))
      expect(cats).toContain(m('cat'))
      expect(cats).not.toContain(o('cat'))
      const whs = ids(listWarehouses(ctx, true))
      expect(whs).toEqual(expect.arrayContaining([m('wh'), m('extraWh')]))
      expect(whs).not.toContain(o('wh'))
      expect(whs).not.toContain(o('extraWh'))
      expect(ids(listParties(ctx, { active: 'all' }))).toEqual([m('cust'), m('sup')].sort((a, b) => a - b))
      expect(ids(listProjects(ctx, { archived: 'all' }))).toEqual([m('proj')])
      expect(ids(projectOptions(ctx))).toEqual([m('proj')])
      expect(ids(listDocuments(ctx, { docType: ['sale_invoice', 'quotation', 'purchase_invoice'] }))).toEqual([m('doc')])
      expect(ids(listPayments(ctx))).toEqual([m('pay')])
      expect(ids(listExpenses(ctx))).toEqual([m('exp')])
      expect(ids(listAccounts(ctx, { includeInactive: true }))).toEqual([m('acc')])
      expect(ids(listMaterialMoves(ctx))).toEqual([m('move')])
      const moves = listMovements(ctx, {}) as Array<{ product_id: number; firm_id: number }>
      expect(moves.length).toBeGreaterThan(0)
      expect(moves.every((mv) => mv.product_id === m('prod') && mv.firm_id === ctx.firmId)).toBe(true)
      expect((stockReport(ctx, { includeZero: true }) as { rows: Array<{ id: number }> }).rows.map((r) => r.id)).toEqual([m('prod')])
      expect(lookupSerial(ctx, `SN${other}A`)).toEqual([])
      expect(lookupSerial(ctx, `SN${me}A`)).toHaveLength(1)
    }
  })

  it('refuses get-by-id and changes on another firm records', () => {
    const t = twoFirms()
    const c1 = t.c1
    const nf = /not found|not available|does not belong/i
    expect(() => getProduct(c1, t.prod2)).toThrow(nf)
    expect(() => getProductUsage(c1, t.prod2)).toThrow(nf)
    expect(() => deleteProduct(c1, t.prod2)).toThrow(nf)
    expect(() => archiveProducts(c1, [t.prod2])).toThrow(nf)
    expect(() => restoreProducts(c1, [t.prod2])).toThrow(nf)
    expect(() => changeProductsCategory(c1, [t.prod2], null)).toThrow(nf)
    expect(() => changeProductsCategory(c1, [t.prod1], t.cat2)).toThrow(nf)
    expect(() => saveProduct(c1, { id: t.prod2, name: 'hack' })).toThrow(nf)
    expect(() => saveProduct(c1, { name: 'new', categoryId: t.cat2 })).toThrow(nf)
    expect(() => saveCategory(c1, { id: t.cat2, name: 'hack' })).toThrow(nf)
    expect(() => deleteCategory(c1, t.cat2)).toThrow(nf)
    expect(() => saveWarehouse(c1, { id: t.wh2, name: 'hack' })).toThrow(nf)
    expect(() => createAdjustment(c1, { date: '2026-02-01', warehouseId: t.wh1, lines: [{ productId: t.prod2, qty: 1, unitCost: 1 }] })).toThrow(nf)
    expect(() => transferStock(c1, { date: '2026-02-01', fromWarehouseId: t.wh1, toWarehouseId: t.extraWh1, lines: [{ productId: t.prod2, qty: 1 }] })).toThrow(nf)
    expect(() => getParty(c1, t.cust2)).toThrow(nf)
    expect(() => partyLedger(c1, t.cust2)).toThrow(nf)
    expect(() => createPartyAdjustment(c1, { date: '2026-02-01', partyId: t.cust1, direction: 'debit', amount: 5, projectId: t.proj2 })).toThrow(nf)
    expect(() => getProject(c1, t.proj2)).toThrow(nf)
    expect(() => projectLedger(c1, t.proj2)).toThrow(nf)
    expect(() => materialUsage(c1, t.proj2)).toThrow(nf)
    expect(() => getProjectLinks(c1, t.proj2)).toThrow(nf)
    expect(() => deleteProject(c1, t.proj2)).toThrow(nf)
    expect(() => setProjectArchived(c1, t.proj2, true)).toThrow(nf)
    expect(() => cancelProject(c1, t.proj2)).toThrow(nf)
    expect(() => getMaterialMove(c1, t.move2)).toThrow(nf)
    expect(() => getDocument(c1, t.doc2)).toThrow(nf)
    expect(() => getPayment(c1, t.pay2)).toThrow(nf)
    expect(() => getExpense(c1, t.exp2)).toThrow(nf)
    expect(() => accountLedger(c1, t.acc2, {})).toThrow(nf)
    // nothing of firm 2 changed
    expect((c1.db.prepare('SELECT name, is_active FROM products WHERE id = ?').get(t.prod2) as object)).toEqual({ name: 'Product 2', is_active: 1 })
    expect(c1.db.prepare('SELECT 1 FROM projects WHERE id = ?').get(t.proj2)).toBeTruthy()
  })
})

/* ===================================================================================================== */

describe('assign shared records to firms', () => {
  it('assigns single-firm and unused shared records, keeps multi-firm ones shared, never moves transactions', () => {
    const c1 = setupCtx() // sharing on
    const f2 = createFirm(c1, { name: 'F2' }, 5)
    const c2: Ctx = { ...c1, firmId: f2 }
    const wh = warehouse(c1)
    const onlyF1 = saveProduct(c1, { name: 'Only F1', salePrice: 10 })
    const onlyF2 = saveProduct(c1, { name: 'Only F2', salePrice: 10 })
    const both = saveProduct(c1, { name: 'Both firms', salePrice: 10 })
    const unused = saveProduct(c1, { name: 'Unused', salePrice: 10 })
    createAdjustment(c1, { date: '2026-01-01', warehouseId: wh, kind: 'opening', lines: [{ productId: onlyF1, qty: 5, unitCost: 5 }, { productId: both, qty: 5, unitCost: 5 }] })
    createAdjustment(c2, { date: '2026-01-01', warehouseId: wh, kind: 'opening', lines: [{ productId: onlyF2, qty: 5, unitCost: 5 }] })
    const custF1 = saveParty(c1, { type: 'customer', name: 'Cust F1' })
    const custF2 = saveParty(c1, { type: 'customer', name: 'Cust F2' })
    const custBoth = saveParty(c1, { type: 'customer', name: 'Cust both' })
    const custUnused = saveParty(c1, { type: 'customer', name: 'Cust unused' })
    const custOpening = saveParty(c2, { type: 'customer', name: 'Opening in F2', openingBalance: 500 })
    createDocument(c1, { docType: 'sale_invoice', date: '2026-01-02', partyId: custF1, warehouseId: wh, lines: [{ productId: both, description: 'Both', qty: 1, rate: 10 }] })
    createDocument(c2, { docType: 'sale_invoice', date: '2026-01-02', partyId: custBoth, warehouseId: wh, lines: [{ productId: both, description: 'Both', qty: 1, rate: 10 }] })
    createDocument(c1, { docType: 'quotation', date: '2026-01-02', partyId: custBoth, lines: [{ description: 'x', qty: 1, rate: 1 }] })
    createPayment(c2, { date: '2026-01-03', direction: 'in', partyId: custF2, accountId: firmAccount(c2), amount: 10 })

    const snapshot = (): unknown => ({
      docs: c1.db.prepare('SELECT id, firm_id, party_id, grand_total FROM documents ORDER BY id').all(),
      moves: c1.db.prepare('SELECT id, firm_id, product_id, qty_in, qty_out FROM stock_movements ORDER BY id').all(),
      pays: c1.db.prepare('SELECT id, firm_id, party_id, amount FROM payments ORDER BY id').all(),
      balances: [custF1, custF2, custBoth, custOpening].map((p) => [partyBalance(c1, p), partyBalance(c2, p)]),
      stock: [onlyF1, onlyF2, both].map((p) => qtyOf(c1, p))
    })
    const before = snapshot()

    // while sharing is on, nothing is assigned
    expect(() => assignSharedRecords(c1)).toThrow(/Turn off sharing/)
    setSetting(c1.db, 'share_inventory', false)
    setSetting(c1.db, 'share_parties', false)
    const plan = planSharedAssignment(c1)
    expect(plan.products.unused).toBe(1)
    expect(plan.products.staysShared.map((p) => p.name)).toEqual(['Both firms'])
    expect(plan.parties.staysShared.map((p) => p.name)).toEqual(['Cust both'])

    const r = assignSharedRecords(c1)
    expect(r).toEqual({ products: 3, parties: 4, productsShared: 1, partiesShared: 1 })
    const firmOf = (table: string, id: number): number | null => (c1.db.prepare(`SELECT firm_id FROM ${table} WHERE id = ?`).get(id) as { firm_id: number | null }).firm_id
    expect(firmOf('products', onlyF1)).toBe(c1.firmId)
    expect(firmOf('products', onlyF2)).toBe(f2)
    expect(firmOf('products', both)).toBeNull()
    expect(firmOf('products', unused)).toBe(c1.firmId) // default firm
    expect(firmOf('parties', custF1)).toBe(c1.firmId)
    expect(firmOf('parties', custF2)).toBe(f2)
    expect(firmOf('parties', custBoth)).toBeNull()
    expect(firmOf('parties', custUnused)).toBe(c1.firmId)
    expect(firmOf('parties', custOpening)).toBe(f2)
    // transactions, balances and stock untouched
    expect(snapshot()).toEqual(before)
    // visibility follows the new owner
    expect(listIds(listProducts(c1, { active: 'all' }))).toEqual([onlyF1, both, unused].sort((a, b) => a - b))
    expect(listIds(listProducts(c2, { active: 'all' }))).toEqual([onlyF2, both].sort((a, b) => a - b))
    const audit = c1.db.prepare("SELECT summary, details FROM audit_log WHERE action = 'assign_shared'").all() as Array<{ summary: string; details: string }>
    expect(audit).toHaveLength(1)
    expect(audit[0].summary).toMatch(/3 product\(s\), 4 customer/)
    // running again changes nothing
    expect(assignSharedRecords(c1)).toEqual({ products: 0, parties: 0, productsShared: 1, partiesShared: 1 })
  })

  it('only touches the kinds whose sharing is off', () => {
    const c1 = setupCtx()
    const p = saveProduct(c1, { name: 'Shared product' })
    const c = saveParty(c1, { type: 'customer', name: 'Shared customer' })
    setSetting(c1.db, 'share_parties', false)
    const r = assignSharedRecords(c1)
    expect(r.products).toBe(0)
    expect(r.parties).toBe(1)
    expect((c1.db.prepare('SELECT firm_id FROM products WHERE id = ?').get(p) as { firm_id: number | null }).firm_id).toBeNull()
    expect((c1.db.prepare('SELECT firm_id FROM parties WHERE id = ?').get(c) as { firm_id: number | null }).firm_id).toBe(c1.firmId)
  })
})
