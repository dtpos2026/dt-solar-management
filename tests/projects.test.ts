import { describe, expect, it } from 'vitest'
import { createAdjustment, saveProduct } from '../src/main/services/inventory'
import { saveParty } from '../src/main/services/parties'
import { createDocument, getDocument } from '../src/main/services/documents'
import { createPayment } from '../src/main/services/payments'
import { cancelMaterialMove, createMaterialMove, materialUsage, projectFinancials, saveProject } from '../src/main/services/projects'
import { createExpense } from '../src/main/services/expenses'
import { plFigures, dashboard } from '../src/main/services/reports'
import { setSetting } from '../src/main/services/context'
import { cashAccount, qtyOf, setupCtx, warehouse } from './helpers'

function base() {
  const ctx = setupCtx()
  const wh = warehouse(ctx)
  const acc = cashAccount(ctx)
  const panel = saveProduct(ctx, { name: 'Panel', salePrice: 30000 })
  const inverter = saveProduct(ctx, { name: 'Inverter', salePrice: 300000 })
  const install = saveProduct(ctx, { name: 'Installation', type: 'service', salePrice: 5000 })
  createAdjustment(ctx, {
    date: '2026-01-01',
    warehouseId: wh,
    kind: 'opening',
    lines: [
      { productId: panel, qty: 100, unitCost: 25000 },
      { productId: inverter, qty: 5, unitCost: 250000 }
    ]
  })
  const cust = saveParty(ctx, { type: 'customer', name: 'School' })
  const contractor = saveParty(ctx, { type: 'supplier', name: 'Contractor' })
  const sup = saveParty(ctx, { type: 'supplier', name: 'Supplier' })
  const labor = (ctx.db.prepare("SELECT id FROM expense_categories WHERE cost_head = 'labor'").get() as { id: number }).id
  const transport = (ctx.db.prepare("SELECT id FROM expense_categories WHERE cost_head = 'transport'").get() as { id: number }).id
  const rent = (ctx.db.prepare("SELECT id FROM expense_categories WHERE name = 'Office Rent'").get() as { id: number }).id
  const project = saveProject(ctx, { name: '20kW School', customerId: cust, capacityKw: 20, contractAmount: 2500000, status: 'in_progress' })
  return { ctx, wh, acc, panel, inverter, install, cust, contractor, sup, labor, transport, rent, project }
}

describe('project profitability', () => {
  it('computes revenue, cost and profit without double counting', () => {
    const t = base()
    const { ctx } = t
    // advance received (cash, not revenue)
    createPayment(ctx, { date: '2026-02-01', direction: 'in', partyId: t.cust, accountId: t.acc, amount: 1000000, projectId: t.project })
    let f = projectFinancials(ctx.db, t.project)
    expect(f.revenue).toBe(0)
    expect(f.received).toBe(1000000)
    expect(f.customerOutstanding).toBe(-1000000)
    expect(f.netProfit).toBe(0)

    // materials issued from stock: 36 panels + 2 inverters = 36*25000 + 2*250000 = 1,400,000
    createMaterialMove(ctx, { projectId: t.project, direction: 'issue', date: '2026-02-02', warehouseId: t.wh, lines: [{ productId: t.panel, qty: 36 }, { productId: t.inverter, qty: 2 }] })
    expect(qtyOf(ctx, t.panel)).toBe(64)
    // labor on credit to contractor + transport paid
    createExpense(ctx, { date: '2026-02-03', categoryId: t.labor, projectId: t.project, amount: 120000, paid: false, partyId: t.contractor })
    createExpense(ctx, { date: '2026-02-03', categoryId: t.transport, projectId: t.project, amount: 15000, paid: true, accountId: t.acc })
    // direct-to-site purchase of structure (not into stock)
    const structure = saveProduct(ctx, { name: 'Structure' })
    createDocument(ctx, {
      docType: 'purchase_invoice', date: '2026-02-03', partyId: t.sup, projectId: t.project, directToProject: true,
      lines: [{ productId: structure, description: 'Structure', qty: 36, rate: 4000 }]
    })
    expect(qtyOf(ctx, structure)).toBe(0)

    // invoice for the system WITHOUT deducting stock (materials already issued), with sales tax
    const inv = createDocument(ctx, {
      docType: 'sale_invoice', date: '2026-02-10', partyId: t.cust, projectId: t.project, deductStock: false,
      lines: [
        { description: '20kW solar system supply', qty: 1, rate: 2300000, taxRate: 10 },
        { productId: t.install, description: 'Installation', qty: 20, rate: 5000 }
      ],
      applyAdvance: true
    })
    const d = getDocument(ctx, inv)
    expect(d.net_total).toBe(2400000)
    expect(d.tax_total).toBe(230000)
    expect(d.paid).toBe(1000000) // advance applied
    expect(qtyOf(ctx, t.panel)).toBe(64) // not deducted twice

    f = projectFinancials(ctx.db, t.project)
    expect(f.revenue).toBe(2400000) // excludes tax
    expect(f.taxCollected).toBe(230000)
    expect(f.materialIssued).toBe(1400000)
    expect(f.materialDirectPurchase).toBe(144000)
    expect(f.materialCost).toBe(1544000)
    expect(f.laborCost).toBe(120000)
    expect(f.otherCost).toBe(15000)
    expect(f.totalDirectCost).toBe(1679000)
    expect(f.grossProfit).toBe(721000)
    expect(f.netProfit).toBe(721000)
    expect(f.marginPct).toBe(30.04)
    expect(f.received).toBe(1000000)
    expect(f.customerOutstanding).toBe(1630000) // 2,630,000 invoiced - 1,000,000
    expect(f.supplierOutstanding).toBe(264000) // 144,000 structure + 120,000 contractor

    // business P&L includes the same project costs once
    const pl = plFigures(ctx.db, [ctx.firmId], '2026-01-01', '2026-12-31')
    expect(pl.revenue).toBe(2400000)
    expect(pl.projectMaterialIssues).toBe(1400000)
    expect(pl.directProjectPurchases).toBe(144000)
    expect(pl.directExpenses).toBe(135000)
    expect(pl.costOfSales).toBe(1679000)
    expect(pl.grossProfit).toBe(721000)

    // overhead allocation (percent of revenue)
    setSetting(ctx.db, 'overhead_method', 'percent_revenue')
    setSetting(ctx.db, 'overhead_percent', 5)
    f = projectFinancials(ctx.db, t.project)
    expect(f.overheads).toBe(120000)
    expect(f.netProfit).toBe(601000)
  })

  it('material returns reverse cost exactly and cannot exceed issued qty', () => {
    const t = base()
    const { ctx } = t
    createMaterialMove(ctx, { projectId: t.project, direction: 'issue', date: '2026-02-02', warehouseId: t.wh, lines: [{ productId: t.panel, qty: 10 }] })
    // average cost changes afterwards (new purchase at a higher price)
    createDocument(ctx, { docType: 'purchase_invoice', date: '2026-02-03', partyId: t.sup, warehouseId: t.wh, lines: [{ productId: t.panel, description: 'Panel', qty: 90, rate: 35000 }] })
    const ret = createMaterialMove(ctx, { projectId: t.project, direction: 'return', date: '2026-02-04', warehouseId: t.wh, lines: [{ productId: t.panel, qty: 4 }] })
    const f = projectFinancials(ctx.db, t.project)
    expect(f.materialIssued).toBe(6 * 25000)
    expect(() =>
      createMaterialMove(ctx, { projectId: t.project, direction: 'return', date: '2026-02-04', warehouseId: t.wh, lines: [{ productId: t.panel, qty: 7 }] })
    ).toThrow(/Only 6/)
    cancelMaterialMove(ctx, ret)
    expect(projectFinancials(ctx.db, t.project).materialIssued).toBe(250000)
    const usage = materialUsage(ctx, t.project) as Array<{ net_used: number }>
    expect(usage[0].net_used).toBe(10)
  })

  it('project invoices that deduct stock charge COGS to the project', () => {
    const t = base()
    const { ctx } = t
    createDocument(ctx, {
      docType: 'sale_invoice', date: '2026-02-10', partyId: t.cust, projectId: t.project, warehouseId: t.wh,
      lines: [{ productId: t.inverter, description: 'Inverter', qty: 1, rate: 300000 }]
    })
    const f = projectFinancials(ctx.db, t.project)
    expect(f.revenue).toBe(300000)
    expect(f.materialFromInvoices).toBe(250000)
    expect(f.grossProfit).toBe(50000)
    expect(qtyOf(ctx, t.inverter)).toBe(4)
  })

  it('rejects invoices for another customer on a project', () => {
    const t = base()
    const other = saveParty(t.ctx, { type: 'customer', name: 'Other' })
    expect(() =>
      createDocument(t.ctx, { docType: 'sale_invoice', date: '2026-02-10', partyId: other, projectId: t.project, deductStock: false, lines: [{ description: 'x', qty: 1, rate: 1 }] })
    ).toThrow(/different customer/)
  })

  it('general overheads reduce business net profit but not project gross profit', () => {
    const t = base()
    createExpense(t.ctx, { date: '2026-02-05', categoryId: t.rent, amount: 50000, paid: true, accountId: t.acc })
    const pl = plFigures(t.ctx.db, [t.ctx.firmId], '2026-01-01', '2026-12-31')
    expect(pl.operatingExpenses).toBe(50000)
    expect(pl.netProfit).toBe(-50000)
    expect(projectFinancials(t.ctx.db, t.project).totalDirectCost).toBe(0)
  })
})

describe('demo data & dashboard', () => {
  it('seeds demo data consistently and builds a dashboard', () => {
    const ctx = setupCtx({ demo: true })
    const dash = dashboard(ctx, { from: '2000-01-01', to: new Date().toISOString().slice(0, 10) }) as {
      kpis: { sales: number; receivables: number }
      months: unknown[]
      recentProjects: Array<{ netProfit: number }>
    }
    expect(dash.kpis.sales).toBeGreaterThan(0)
    expect(dash.months).toHaveLength(12)
    expect(dash.recentProjects.length).toBeGreaterThan(0)
    // stock never negative after seeding
    const neg = ctx.db.prepare('SELECT COUNT(*) AS c FROM stock_levels WHERE qty < 0').get() as { c: number }
    expect(neg.c).toBe(0)
  })
})
