/**
 * Financial reports and dashboard.
 *
 * Profit & Loss (accrual):
 *   Net sales            = Σ sales invoices net_total (excl. tax) − Σ sales returns net_total
 *   Cost of sales        = COGS of invoiced stock (moving average)  − COGS of returned stock
 *                        + materials issued to projects (net of returns)
 *                        + direct-to-site project purchases (net of returns)
 *                        + direct expenses (labor, contractor, transport, material, other, or any expense charged to a project)
 *   Gross profit         = Net sales − Cost of sales
 *   Operating expenses   = overhead expenses not charged to a project
 *   Stock adjustments    = gains (+) / losses (−) from stock counts (opening stock excluded)
 *   Net profit           = Gross profit − Operating expenses + Stock adjustments
 * Purchases into stock are an inventory asset, not an expense; they become cost only when sold/issued.
 */
import { round2, round3 } from '../../shared/money'
import type { DB } from '../db'
import { AppError, Ctx, can, canAccessFirm, requirePerm } from './context'
import { ACCOUNT_BALANCE_SQL } from './payments'
import { LEDGER_SQL } from './parties'
import { projectFinancials } from './projects'

function firmScope(ctx: Ctx, scope?: 'firm' | 'all'): number[] {
  if (scope === 'all') {
    requirePerm(ctx, 'reports.consolidated')
    const ids = (ctx.db.prepare('SELECT id FROM firms').all() as Array<{ id: number }>).map((r) => r.id)
    return ids.filter((id) => canAccessFirm(ctx.user, id))
  }
  return [ctx.firmId]
}

const inList = (ids: number[]): string => {
  if (!ids.length) throw new AppError('No firm selected.', 'VALIDATION')
  return ids.map((i) => Number(i)).join(',')
}

export interface PLFigures {
  revenue: number
  salesGross: number
  salesReturns: number
  cogs: number
  projectMaterialIssues: number
  directProjectPurchases: number
  directExpenses: number
  costOfSales: number
  grossProfit: number
  operatingExpenses: number
  operatingByCategory: Array<{ name: string; amount: number }>
  directByHead: Array<{ head: string; amount: number }>
  stockAdjustments: number
  netProfit: number
  purchases: number
  taxCollected: number
  taxPaid: number
  grossMarginPct: number | null
  netMarginPct: number | null
}

export function plFigures(db: DB, firmIds: number[], from: string, to: string): PLFigures {
  const f = inList(firmIds)
  const v = (sql: string): number => round2(((db.prepare(sql).get({ from, to }) as { v: number | null }).v ?? 0))
  const docs = `FROM documents d WHERE d.firm_id IN (${f}) AND d.status <> 'cancelled' AND d.date BETWEEN @from AND @to`
  const salesGross = v(`SELECT SUM(d.net_total) AS v ${docs} AND d.doc_type = 'sale_invoice'`)
  const salesReturns = v(`SELECT SUM(d.net_total) AS v ${docs} AND d.doc_type = 'sale_return'`)
  const revenue = round2(salesGross - salesReturns)
  const cogs = round2(
    v(`SELECT SUM(d.cost_total) AS v ${docs} AND d.doc_type = 'sale_invoice' AND d.deduct_stock = 1`) -
      v(`SELECT SUM(d.cost_total) AS v ${docs} AND d.doc_type = 'sale_return' AND d.deduct_stock = 1`)
  )
  const projectMaterialIssues = v(
    `SELECT SUM(CASE WHEN m.direction = 'issue' THEN m.total_cost ELSE -m.total_cost END) AS v FROM material_moves m
     WHERE m.firm_id IN (${f}) AND m.status <> 'cancelled' AND m.date BETWEEN @from AND @to`
  )
  const directProjectPurchases = round2(
    v(`SELECT SUM(d.cost_total) AS v ${docs} AND d.doc_type = 'purchase_invoice' AND d.direct_to_project = 1`) -
      v(`SELECT SUM(d.cost_total) AS v ${docs} AND d.doc_type = 'purchase_return' AND d.direct_to_project = 1`)
  )
  const expBase = `FROM expenses e JOIN expense_categories c ON c.id = e.category_id
     WHERE e.firm_id IN (${f}) AND e.status <> 'cancelled' AND e.date BETWEEN @from AND @to`
  const directExpenses = v(`SELECT SUM(e.amount) AS v ${expBase} AND (c.cost_head <> 'overhead' OR e.project_id IS NOT NULL)`)
  const directByHead = (
    db
      .prepare(
        `SELECT CASE WHEN c.cost_head = 'overhead' THEN 'other' ELSE c.cost_head END AS head, ROUND(SUM(e.amount), 2) AS amount ${expBase}
         AND (c.cost_head <> 'overhead' OR e.project_id IS NOT NULL) GROUP BY 1 ORDER BY 2 DESC`
      )
      .all({ from, to }) as Array<{ head: string; amount: number }>
  )
  const operatingByCategory = db
    .prepare(
      `SELECT c.name, ROUND(SUM(e.amount), 2) AS amount ${expBase} AND c.cost_head = 'overhead' AND e.project_id IS NULL
       GROUP BY c.id ORDER BY amount DESC`
    )
    .all({ from, to }) as Array<{ name: string; amount: number }>
  const operatingExpenses = round2(operatingByCategory.reduce((a, r) => a + r.amount, 0))
  const stockAdjustments = v(
    `SELECT SUM(a.total_value) AS v FROM stock_adjustments a WHERE a.firm_id IN (${f}) AND a.kind = 'adjustment' AND a.date BETWEEN @from AND @to`
  )
  const costOfSales = round2(cogs + projectMaterialIssues + directProjectPurchases + directExpenses)
  const grossProfit = round2(revenue - costOfSales)
  const netProfit = round2(grossProfit - operatingExpenses + stockAdjustments)
  const purchases = round2(
    v(`SELECT SUM(d.net_total) AS v ${docs} AND d.doc_type = 'purchase_invoice'`) -
      v(`SELECT SUM(d.net_total) AS v ${docs} AND d.doc_type = 'purchase_return'`)
  )
  const taxCollected = round2(
    v(`SELECT SUM(d.tax_total) AS v ${docs} AND d.doc_type = 'sale_invoice'`) - v(`SELECT SUM(d.tax_total) AS v ${docs} AND d.doc_type = 'sale_return'`)
  )
  const taxPaid = round2(
    v(`SELECT SUM(d.tax_total) AS v ${docs} AND d.doc_type = 'purchase_invoice'`) -
      v(`SELECT SUM(d.tax_total) AS v ${docs} AND d.doc_type = 'purchase_return'`)
  )
  return {
    revenue,
    salesGross,
    salesReturns,
    cogs,
    projectMaterialIssues,
    directProjectPurchases,
    directExpenses,
    costOfSales,
    grossProfit,
    operatingExpenses,
    operatingByCategory,
    directByHead,
    stockAdjustments,
    netProfit,
    purchases,
    taxCollected,
    taxPaid,
    grossMarginPct: revenue > 0 ? round2((grossProfit / revenue) * 100) : null,
    netMarginPct: revenue > 0 ? round2((netProfit / revenue) * 100) : null
  }
}

export function profitAndLoss(ctx: Ctx, f: { from: string; to: string; scope?: 'firm' | 'all' }): unknown {
  requirePerm(ctx, 'reports.profit')
  const ids = firmScope(ctx, f.scope)
  const figures = plFigures(ctx.db, ids, f.from, f.to)
  const perFirm =
    ids.length > 1
      ? ids.map((id) => ({
          firmId: id,
          firmName: (ctx.db.prepare('SELECT name FROM firms WHERE id = ?').get(id) as { name: string }).name,
          ...plFigures(ctx.db, [id], f.from, f.to)
        }))
      : []
  return { from: f.from, to: f.to, scope: f.scope ?? 'firm', figures, perFirm }
}

/* ------------------------------ Sales / purchase registers ------------------------------ */

export function registerReport(
  ctx: Ctx,
  f: { side: 'sales' | 'purchase'; from: string; to: string; groupBy: 'document' | 'party' | 'product' | 'month' | 'category'; scope?: 'firm' | 'all' }
): unknown {
  requirePerm(ctx, 'reports.view')
  if (f.side === 'sales') requirePerm(ctx, 'sales.view')
  else requirePerm(ctx, 'purchases.view')
  const ids = firmScope(ctx, f.scope)
  const inv = f.side === 'sales' ? 'sale_invoice' : 'purchase_invoice'
  const ret = f.side === 'sales' ? 'sale_return' : 'purchase_return'
  const showProfit = can(ctx, 'reports.profit') && f.side === 'sales'
  const params = { from: f.from, to: f.to }
  const base = `d.firm_id IN (${inList(ids)}) AND d.status <> 'cancelled' AND d.date BETWEEN @from AND @to AND d.doc_type IN ('${inv}','${ret}')`
  const sign = `CASE WHEN d.doc_type = '${ret}' THEN -1 ELSE 1 END`
  let rows: Array<Record<string, unknown>>
  if (f.groupBy === 'document') {
    rows = ctx.db
      .prepare(
        `SELECT d.id, d.doc_type, d.number, d.date, COALESCE(pa.name, d.party_name) AS party_name, pr.name AS project_name,
           ${sign} * d.net_total AS net, ${sign} * d.tax_total AS tax, ${sign} * d.grand_total AS total, ${sign} * d.cost_total AS cost
         FROM documents d LEFT JOIN parties pa ON pa.id = d.party_id LEFT JOIN projects pr ON pr.id = d.project_id
         WHERE ${base} ORDER BY d.date, d.id`
      )
      .all(params) as Array<Record<string, unknown>>
  } else if (f.groupBy === 'party') {
    rows = ctx.db
      .prepare(
        `SELECT COALESCE(pa.name, d.party_name, 'Walk-in') AS name, COUNT(CASE WHEN d.doc_type = '${inv}' THEN 1 END) AS count,
           SUM(${sign} * d.net_total) AS net, SUM(${sign} * d.tax_total) AS tax, SUM(${sign} * d.grand_total) AS total,
           SUM(${sign} * d.cost_total) AS cost
         FROM documents d LEFT JOIN parties pa ON pa.id = d.party_id WHERE ${base} GROUP BY 1 ORDER BY total DESC`
      )
      .all(params) as Array<Record<string, unknown>>
  } else if (f.groupBy === 'month') {
    rows = ctx.db
      .prepare(
        `SELECT substr(d.date, 1, 7) AS name, COUNT(CASE WHEN d.doc_type = '${inv}' THEN 1 END) AS count,
           SUM(${sign} * d.net_total) AS net, SUM(${sign} * d.tax_total) AS tax, SUM(${sign} * d.grand_total) AS total,
           SUM(${sign} * d.cost_total) AS cost
         FROM documents d WHERE ${base} GROUP BY 1 ORDER BY 1`
      )
      .all(params) as Array<Record<string, unknown>>
  } else {
    const key = f.groupBy === 'category' ? "COALESCE(c.name, 'Uncategorised')" : 'COALESCE(p.name, l.description)'
    rows = ctx.db
      .prepare(
        `SELECT ${key} AS name, ${f.groupBy === 'product' ? 'p.unit,' : ''} SUM(${sign} * l.qty) AS qty,
           SUM(${sign} * l.net_amount) AS net, SUM(${sign} * l.tax_amt) AS tax, SUM(${sign} * l.line_total) AS total,
           SUM(${sign} * l.cost_total) AS cost
         FROM document_lines l JOIN documents d ON d.id = l.document_id LEFT JOIN products p ON p.id = l.product_id
         LEFT JOIN categories c ON c.id = p.category_id
         WHERE ${base} GROUP BY 1 ORDER BY total DESC`
      )
      .all(params) as Array<Record<string, unknown>>
  }
  const out = rows.map((r) => {
    const net = round2(Number(r.net))
    const cost = round2(Number(r.cost))
    const o: Record<string, unknown> = { ...r, net, tax: round2(Number(r.tax)), total: round2(Number(r.total)) }
    if (r.qty !== undefined) o.qty = round3(Number(r.qty))
    if (showProfit) {
      o.cost = cost
      o.profit = round2(net - cost)
      o.margin = net > 0 ? round2(((net - cost) / net) * 100) : null
    } else delete o.cost
    return o
  })
  const totals = {
    net: round2(out.reduce((a, r) => a + Number(r.net), 0)),
    tax: round2(out.reduce((a, r) => a + Number(r.tax), 0)),
    total: round2(out.reduce((a, r) => a + Number(r.total), 0)),
    cost: showProfit ? round2(out.reduce((a, r) => a + Number(r.cost ?? 0), 0)) : null,
    profit: showProfit ? round2(out.reduce((a, r) => a + Number(r.profit ?? 0), 0)) : null
  }
  return { rows: out, totals, showProfit, note: f.side === 'sales' && showProfit ? 'Profit shown is gross profit on stock items (sale price − moving average cost). Items sold without deducting stock (project invoices) show cost through the project instead.' : null }
}

export function taxReport(ctx: Ctx, f: { from: string; to: string }): unknown {
  requirePerm(ctx, 'reports.view')
  const rows = ctx.db
    .prepare(
      `SELECT d.doc_type, d.number, d.date, COALESCE(pa.name, d.party_name) AS party_name, pa.ntn, pa.strn,
         d.net_total, d.tax_total, d.grand_total, d.is_tax_invoice
       FROM documents d LEFT JOIN parties pa ON pa.id = d.party_id
       WHERE d.firm_id = @firmId AND d.status <> 'cancelled' AND d.date BETWEEN @from AND @to AND d.tax_total <> 0
         AND d.doc_type IN ('sale_invoice','sale_return','purchase_invoice','purchase_return')
       ORDER BY d.date, d.id`
    )
    .all({ firmId: ctx.firmId, from: f.from, to: f.to }) as Array<{ doc_type: string; tax_total: number }>
  const sum = (types: string[]): number => round2(rows.filter((r) => types.includes(r.doc_type)).reduce((a, r) => a + r.tax_total, 0))
  const output = round2(sum(['sale_invoice']) - sum(['sale_return']))
  const input = round2(sum(['purchase_invoice']) - sum(['purchase_return']))
  return { rows, outputTax: output, inputTax: input, net: round2(output - input) }
}

export function expenseReport(ctx: Ctx, f: { from: string; to: string }): unknown {
  requirePerm(ctx, 'expenses.view')
  const byCategory = ctx.db
    .prepare(
      `SELECT c.name, c.cost_head, COUNT(*) AS count, ROUND(SUM(e.amount), 2) AS amount,
         ROUND(SUM(CASE WHEN e.project_id IS NOT NULL THEN e.amount ELSE 0 END), 2) AS project_amount
       FROM expenses e JOIN expense_categories c ON c.id = e.category_id
       WHERE e.firm_id = @firmId AND e.status <> 'cancelled' AND e.date BETWEEN @from AND @to GROUP BY c.id ORDER BY amount DESC`
    )
    .all({ firmId: ctx.firmId, from: f.from, to: f.to }) as Array<{ amount: number }>
  const byMonth = ctx.db
    .prepare(
      `SELECT substr(e.date, 1, 7) AS month, ROUND(SUM(e.amount), 2) AS amount FROM expenses e
       WHERE e.firm_id = @firmId AND e.status <> 'cancelled' AND e.date BETWEEN @from AND @to GROUP BY 1 ORDER BY 1`
    )
    .all({ firmId: ctx.firmId, from: f.from, to: f.to })
  return { byCategory, byMonth, total: round2(byCategory.reduce((a, r) => a + r.amount, 0)) }
}

/** All transactions for a period (day book). */
export function dayBook(ctx: Ctx, f: { from: string; to: string }): unknown[] {
  requirePerm(ctx, 'reports.view')
  return ctx.db
    .prepare(
      `SELECT * FROM (
         SELECT d.date, d.created_at, d.doc_type AS kind, d.id AS ref_id, d.number, COALESCE(pa.name, d.party_name) AS party, d.grand_total AS amount, d.status
           FROM documents d LEFT JOIN parties pa ON pa.id = d.party_id WHERE d.firm_id = @firmId AND d.date BETWEEN @from AND @to
         UNION ALL
         SELECT p.date, p.created_at, CASE p.direction WHEN 'in' THEN 'receipt' ELSE 'payment' END, p.id, p.number, COALESCE(pa.name, p.notes), p.amount, p.status
           FROM payments p LEFT JOIN parties pa ON pa.id = p.party_id WHERE p.firm_id = @firmId AND p.date BETWEEN @from AND @to
         UNION ALL
         SELECT e.date, e.created_at, 'expense', e.id, e.number, COALESCE(pa.name, e.payee_name, c.name), e.amount, e.status
           FROM expenses e JOIN expense_categories c ON c.id = e.category_id LEFT JOIN parties pa ON pa.id = e.party_id
          WHERE e.firm_id = @firmId AND e.date BETWEEN @from AND @to
         UNION ALL
         SELECT t.date, t.created_at, 'transfer', t.id, t.number, NULL, t.amount, t.status FROM account_transfers t
          WHERE t.firm_id = @firmId AND t.date BETWEEN @from AND @to
         UNION ALL
         SELECT m.date, m.created_at, 'material_' || m.direction, m.id, m.number, pr.name, m.total_cost, m.status
           FROM material_moves m JOIN projects pr ON pr.id = m.project_id WHERE m.firm_id = @firmId AND m.date BETWEEN @from AND @to
         UNION ALL
         SELECT a.date, a.created_at, 'stock_' || a.kind, a.id, a.number, a.reason, a.total_value, 'final'
           FROM stock_adjustments a WHERE a.firm_id = @firmId AND a.date BETWEEN @from AND @to
       ) x ORDER BY x.date DESC, x.created_at DESC LIMIT 5000`
    )
    .all({ firmId: ctx.firmId, from: f.from, to: f.to })
}

/* ------------------------------ Dashboard ------------------------------ */

function monthStart(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`
}

export function dashboard(ctx: Ctx, f: { from: string; to: string; scope?: 'firm' | 'all' }): unknown {
  requirePerm(ctx, 'dashboard.view')
  const db = ctx.db
  const ids = f.scope === 'all' && can(ctx, 'reports.consolidated') ? firmScope(ctx, 'all') : [ctx.firmId]
  const fl = inList(ids)
  const showFin = can(ctx, 'dashboard.financials')
  const pl = plFigures(db, ids, f.from, f.to)

  // previous period of equal length for trend arrows
  const len = Math.max(1, Math.round((Date.parse(f.to) - Date.parse(f.from)) / 86400000) + 1)
  const prevTo = new Date(Date.parse(f.from) - 86400000).toISOString().slice(0, 10)
  const prevFrom = new Date(Date.parse(f.from) - len * 86400000).toISOString().slice(0, 10)
  const prev = plFigures(db, ids, prevFrom, prevTo)
  const trend = (cur: number, before: number): number | null => (before > 0 ? round2(((cur - before) / before) * 100) : null)

  const balances = db
    .prepare(`SELECT party_id, ROUND(SUM(debit - credit), 2) AS b FROM (${LEDGER_SQL}) WHERE firm_id IN (${fl}) GROUP BY party_id`)
    .all() as Array<{ party_id: number; b: number }>
  const receivables = round2(balances.filter((r) => r.b > 0).reduce((a, r) => a + r.b, 0))
  const payables = round2(balances.filter((r) => r.b < 0).reduce((a, r) => a - r.b, 0))
  const receivableCount = balances.filter((r) => r.b > 0.005).length

  const accounts = db
    .prepare(`SELECT a.id, a.name, a.type, f.name AS firm_name, ROUND(${ACCOUNT_BALANCE_SQL}, 2) AS balance FROM accounts a JOIN firms f ON f.id = a.firm_id
              WHERE a.firm_id IN (${fl}) AND a.is_active = 1 ORDER BY a.type, a.name`)
    .all({ asOf: null }) as Array<{ type: string; balance: number }>
  const cash = round2(accounts.filter((a) => a.type === 'cash').reduce((s, a) => s + a.balance, 0))
  const bank = round2(accounts.filter((a) => a.type !== 'cash').reduce((s, a) => s + a.balance, 0))

  const stockRows = db
    .prepare(
      `SELECT p.id, p.name, p.unit, p.reorder_level, p.avg_cost,
         COALESCE((SELECT SUM(sl.qty) FROM stock_levels sl JOIN warehouses w ON w.id = sl.warehouse_id
                   WHERE sl.product_id = p.id AND (w.firm_id IS NULL OR w.firm_id IN (${fl}))), 0) AS qty
       FROM products p WHERE p.type = 'goods' AND p.is_active = 1 AND (p.firm_id IS NULL OR p.firm_id IN (${fl}))`
    )
    .all() as Array<{ id: number; name: string; unit: string; reorder_level: number; avg_cost: number; qty: number }>
  const inventoryValue = round2(stockRows.reduce((a, r) => a + Math.max(0, r.qty) * r.avg_cost, 0))
  const out = stockRows.filter((r) => r.qty <= 0.0005)
  const low = stockRows.filter((r) => r.qty > 0.0005 && r.reorder_level > 0 && r.qty <= r.reorder_level)
  const stockStatus = { total: stockRows.length, inStock: stockRows.length - out.length - low.length, low: low.length, out: out.length }
  const alerts = [...low, ...out]
    .sort((a, b) => a.qty - b.qty)
    .slice(0, 8)
    .map((r) => ({ id: r.id, name: r.name, qty: round3(r.qty), unit: r.unit, reorder: r.reorder_level }))

  // last 12 months chart
  const now = new Date(Date.parse(f.to))
  const months: Array<{ month: string; label: string; sales: number; purchases: number; profit?: number }> = []
  for (let i = 11; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1)
    const s = monthStart(d)
    const e = new Date(d.getFullYear(), d.getMonth() + 1, 0)
    const end = `${e.getFullYear()}-${String(e.getMonth() + 1).padStart(2, '0')}-${String(e.getDate()).padStart(2, '0')}`
    const figs = plFigures(db, ids, s, end)
    months.push({
      month: s.slice(0, 7),
      label: d.toLocaleString('en', { month: 'short' }),
      sales: figs.revenue,
      purchases: figs.purchases,
      ...(showFin ? { profit: figs.netProfit } : {})
    })
  }

  const recent = (types: string): unknown[] =>
    db
      .prepare(
        `SELECT d.id, d.doc_type, d.number, d.date, COALESCE(pa.name, d.party_name) AS party_name, d.grand_total, d.status,
           d.grand_total - COALESCE((SELECT SUM(a.amount) FROM payment_allocations a JOIN payments p ON p.id = a.payment_id
             WHERE a.document_id = d.id AND p.status <> 'cancelled'), 0)
             - COALESCE((SELECT SUM(r.grand_total) FROM documents r WHERE r.ref_doc_id = d.id AND r.status <> 'cancelled'
             AND r.doc_type IN ('sale_return','purchase_return')), 0) AS due
         FROM documents d LEFT JOIN parties pa ON pa.id = d.party_id
         WHERE d.firm_id IN (${fl}) AND d.doc_type = '${types}' AND d.status <> 'cancelled' ORDER BY d.date DESC, d.id DESC LIMIT 6`
      )
      .all()

  const topProducts = db
    .prepare(
      `SELECT COALESCE(p.name, l.description) AS name, p.unit, ROUND(SUM(l.qty), 3) AS qty, ROUND(SUM(l.net_amount), 2) AS amount
       FROM document_lines l JOIN documents d ON d.id = l.document_id LEFT JOIN products p ON p.id = l.product_id
       WHERE d.firm_id IN (${fl}) AND d.doc_type = 'sale_invoice' AND d.status <> 'cancelled' AND d.date BETWEEN @from AND @to
         AND (p.type IS NULL OR p.type = 'goods')
       GROUP BY 1 ORDER BY qty DESC LIMIT 6`
    )
    .all({ from: f.from, to: f.to })

  const projects = db
    .prepare(
      `SELECT pr.id, pr.code, pr.name, pr.capacity_kw, pr.status, pr.progress, pr.city, pa.name AS customer_name
       FROM projects pr LEFT JOIN parties pa ON pa.id = pr.customer_id WHERE pr.firm_id IN (${fl})
       ORDER BY CASE pr.status WHEN 'in_progress' THEN 0 WHEN 'planning' THEN 1 WHEN 'quoted' THEN 2 ELSE 3 END, pr.id DESC LIMIT 6`
    )
    .all() as Array<{ id: number }>
  const canProjFin = can(ctx, 'projects.financials')
  const recentProjects = projects.map((p) => {
    const fin = projectFinancials(db, p.id)
    return {
      ...p,
      revenue: canProjFin ? fin.revenue : null,
      netProfit: canProjFin ? fin.netProfit : null,
      marginPct: canProjFin ? fin.marginPct : null,
      outstanding: fin.customerOutstanding
    }
  })
  const allProjects = db.prepare(`SELECT id, status, capacity_kw FROM projects WHERE firm_id IN (${fl})`).all() as Array<{
    id: number
    status: string
    capacity_kw: number
  }>
  let projProfit = 0
  let projRevenue = 0
  if (canProjFin) {
    for (const p of allProjects) {
      if (p.status === 'cancelled') continue
      const fin = projectFinancials(db, p.id)
      projProfit += fin.netProfit
      projRevenue += fin.revenue
    }
  }
  const projectSummary = {
    total: allProjects.length,
    active: allProjects.filter((p) => ['planning', 'quoted', 'in_progress', 'on_hold'].includes(p.status)).length,
    inProgress: allProjects.filter((p) => p.status === 'in_progress').length,
    completed: allProjects.filter((p) => p.status === 'completed').length,
    installedKw: round2(allProjects.filter((p) => p.status === 'completed').reduce((a, p) => a + (p.capacity_kw || 0), 0)),
    pipelineKw: round2(allProjects.filter((p) => ['planning', 'quoted', 'in_progress', 'on_hold'].includes(p.status)).reduce((a, p) => a + (p.capacity_kw || 0), 0)),
    netProfit: canProjFin ? round2(projProfit) : null,
    revenue: canProjFin ? round2(projRevenue) : null,
    marginPct: canProjFin && projRevenue > 0 ? round2((projProfit / projRevenue) * 100) : null
  }

  const today = new Date().toISOString().slice(0, 10)
  const overdue = db
    .prepare(
      `SELECT COUNT(*) AS c FROM documents d WHERE d.firm_id IN (${fl}) AND d.doc_type = 'sale_invoice' AND d.status <> 'cancelled'
         AND d.due_date IS NOT NULL AND d.due_date < @today
         AND d.grand_total - COALESCE((SELECT SUM(a.amount) FROM payment_allocations a JOIN payments p ON p.id = a.payment_id
           WHERE a.document_id = d.id AND p.status <> 'cancelled'), 0) > 0.5`
    )
    .get({ today }) as { c: number }
  const counts = db
    .prepare(
      `SELECT (SELECT COUNT(*) FROM parties WHERE type IN ('customer','both') AND is_active = 1 AND (firm_id IS NULL OR firm_id IN (${fl}))) AS customers,
              (SELECT COUNT(*) FROM parties WHERE type IN ('supplier','both') AND is_active = 1 AND (firm_id IS NULL OR firm_id IN (${fl}))) AS suppliers,
              (SELECT COUNT(*) FROM products WHERE is_active = 1 AND (firm_id IS NULL OR firm_id IN (${fl}))) AS products,
              (SELECT COUNT(*) FROM documents WHERE doc_type = 'quotation' AND status IN ('draft','sent') AND firm_id IN (${fl})) AS openQuotations`
    )
    .get()

  return {
    period: { from: f.from, to: f.to },
    scope: ids.length > 1 ? 'all' : 'firm',
    kpis: {
      sales: pl.revenue,
      salesTrend: trend(pl.revenue, prev.revenue),
      purchases: pl.purchases,
      purchasesTrend: trend(pl.purchases, prev.purchases),
      grossProfit: showFin ? pl.grossProfit : null,
      netProfit: showFin ? pl.netProfit : null,
      netProfitTrend: showFin ? trend(pl.netProfit, prev.netProfit) : null,
      grossMarginPct: showFin ? pl.grossMarginPct : null,
      expenses: showFin ? round2(pl.operatingExpenses + pl.directExpenses) : null,
      receivables,
      receivableCount,
      payables,
      cash: showFin ? cash : null,
      bank: showFin ? bank : null,
      inventoryValue: can(ctx, 'inventory.cost') ? inventoryValue : null,
      overdueInvoices: overdue.c
    },
    accounts: showFin ? accounts : [],
    stockStatus,
    alerts,
    months,
    recentSales: can(ctx, 'sales.view') ? recent('sale_invoice') : [],
    recentPurchases: can(ctx, 'purchases.view') ? recent('purchase_invoice') : [],
    topProducts,
    recentProjects: can(ctx, 'projects.view') ? recentProjects : [],
    projectSummary,
    counts
  }
}

/** Global search across the active firm. */
export function globalSearch(ctx: Ctx, q: string): unknown[] {
  const term = String(q ?? '').trim()
  if (term.length < 2) return []
  const like = `%${term}%`
  const out: unknown[] = []
  if (can(ctx, 'sales.view') || can(ctx, 'purchases.view') || can(ctx, 'quotations.view')) {
    const docs = ctx.db
      .prepare(
        `SELECT d.id, d.doc_type, d.number, d.date, COALESCE(pa.name, d.party_name) AS party_name, d.grand_total FROM documents d
         LEFT JOIN parties pa ON pa.id = d.party_id WHERE d.firm_id = ? AND (d.number LIKE ? OR pa.name LIKE ? OR d.party_name LIKE ?)
         ORDER BY d.date DESC LIMIT 8`
      )
      .all(ctx.firmId, like, like, like) as Array<{ doc_type: string }>
    for (const d of docs) {
      const perm = d.doc_type === 'quotation' ? 'quotations.view' : d.doc_type.startsWith('purchase') ? 'purchases.view' : 'sales.view'
      if (can(ctx, perm)) out.push({ result: 'document', ...d })
    }
  }
  if (can(ctx, 'customers.view') || can(ctx, 'suppliers.view')) {
    const parties = ctx.db
      .prepare(
        `SELECT id, name, type, phone, city FROM parties WHERE (firm_id IS NULL OR firm_id = ?) AND (name LIKE ? OR phone LIKE ? OR cnic LIKE ?) LIMIT 8`
      )
      .all(ctx.firmId, like, like, like) as Array<{ type: string }>
    for (const p of parties) {
      if (can(ctx, p.type === 'supplier' ? 'suppliers.view' : 'customers.view')) out.push({ result: 'party', ...p })
    }
  }
  if (can(ctx, 'inventory.view')) {
    const products = ctx.db
      .prepare(
        `SELECT id, name, sku, sale_price FROM products WHERE (firm_id IS NULL OR firm_id = ?) AND (name LIKE ? OR sku LIKE ? OR barcode LIKE ? OR model LIKE ?) LIMIT 8`
      )
      .all(ctx.firmId, like, like, like, like)
    for (const p of products) out.push({ result: 'product', ...(p as object) })
    const serials = ctx.db
      .prepare(`SELECT s.serial, s.status, p.id AS product_id, p.name FROM serials s JOIN products p ON p.id = s.product_id WHERE s.serial LIKE ? LIMIT 5`)
      .all(like)
    for (const s of serials) out.push({ result: 'serial', ...(s as object) })
  }
  if (can(ctx, 'projects.view')) {
    const projects = ctx.db
      .prepare(`SELECT id, code, name, status, city FROM projects WHERE firm_id = ? AND (name LIKE ? OR code LIKE ? OR site_address LIKE ? OR city LIKE ?) LIMIT 8`)
      .all(ctx.firmId, like, like, like, like)
    for (const p of projects) out.push({ result: 'project', ...(p as object) })
  }
  return out
}
