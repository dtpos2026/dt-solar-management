/**
 * Solar Projects - project records, material issues/returns, and project profitability.
 *
 * PROFIT RULES (accrual based - never "cash received minus cash paid"):
 *   Revenue            = Σ project sales invoices net_total (EXCLUDING tax) − Σ project sales returns net_total
 *   Direct material    = COGS of stock items on project invoices (deduct_stock)  − COGS of their returns
 *                      + cost of materials issued from stock                      − cost of materials returned to stock
 *                      + landed cost of goods bought direct-to-site               − cost of direct-purchase returns
 *                      + project expenses with cost head "material"
 *   Labor              = project expenses (labor, contractor) + direct-to-site purchases of services
 *   Other direct       = project expenses (transport, other, and any overhead category charged to the project)
 *   Total direct cost  = material + labor + other
 *   Gross profit       = revenue − total direct cost
 *   Overheads          = only if an allocation method is configured (manual amount or % of revenue)
 *   Net profit         = gross profit − overheads ; Margin = net / revenue × 100 (revenue > 0)
 *
 * Each physical unit leaves stock exactly once (either on an invoice OR via a material issue), so cost is never
 * double counted. Normal purchases into stock are inventory, NOT project cost, until issued/invoiced.
 * Cash received / paid is reported separately and never mixed with profit.
 */
import { copyFileSync, existsSync, mkdirSync, statSync, unlinkSync } from 'fs'
import { basename, extname, join } from 'path'
import { PROJECT_STATUSES, PROJECT_TYPES, SYSTEM_TYPES } from '../../shared/docTypes'
import { EPS, num, round2, round3, round4 } from '../../shared/money'
import type { DB } from '../db'
import { AppError, Ctx, audit, can, getSetting, optId, optText, requireDate, requirePerm, requireText } from './context'
import { nextNumber } from './firms'
import {
  assertWarehouseVisible,
  checkSerialCount,
  getProductRow,
  parseSerials,
  reverseMovements,
  reverseSerials,
  serialsIn,
  serialsOut,
  stockIn,
  stockOut
} from './inventory'
import { docDue, expenseDue } from './payments'

export interface ProjectInput {
  id?: number
  name: string
  customerId?: number | null
  contactPerson?: string
  contactPhone?: string
  siteAddress?: string
  city?: string
  capacityKw?: number
  projectType?: string
  systemType?: string
  startDate?: string
  expectedEndDate?: string
  completedDate?: string
  managerUserId?: number | null
  status?: string
  progress?: number
  quotationId?: number | null
  contractAmount?: number
  overheadAmount?: number
  warrantyInfo?: string
  notes?: string
}

export interface ProjectFinancials {
  contractValue: number
  revenue: number
  invoicedTotal: number
  taxCollected: number
  received: number
  customerOutstanding: number
  materialFromInvoices: number
  materialIssued: number
  materialDirectPurchase: number
  materialExpenses: number
  materialCost: number
  laborCost: number
  otherCost: number
  totalDirectCost: number
  grossProfit: number
  overheads: number
  netProfit: number
  marginPct: number | null
  supplierOutstanding: number
  pendingPurchaseOrders: number
  pendingPurchaseValue: number
  unbilledContract: number
}

const n = (db: DB, sql: string, ...args: unknown[]): number => {
  const r = db.prepare(sql).get(...args) as { v: number | null } | undefined
  return round2(r?.v ?? 0)
}

export function projectFinancials(db: DB, projectId: number): ProjectFinancials {
  const pr = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId) as
    | { contract_amount: number; overhead_amount: number; customer_id: number | null; firm_id: number }
    | undefined
  if (!pr) throw new AppError('Project not found.', 'NOT_FOUND')
  const docSum = (col: string, type: string, extra = ''): number =>
    n(db, `SELECT SUM(${col}) AS v FROM documents WHERE project_id = ? AND doc_type = ? AND status <> 'cancelled' ${extra}`, projectId, type)
  const lineCost = (type: string, extra: string): number =>
    n(
      db,
      `SELECT SUM(l.cost_total) AS v FROM document_lines l JOIN documents d ON d.id = l.document_id
       LEFT JOIN products p ON p.id = l.product_id
       WHERE d.project_id = ? AND d.doc_type = ? AND d.status <> 'cancelled' ${extra}`,
      projectId,
      type
    )

  const revenue = round2(docSum('net_total', 'sale_invoice') - docSum('net_total', 'sale_return'))
  const invoicedTotal = round2(docSum('grand_total', 'sale_invoice') - docSum('grand_total', 'sale_return'))
  const taxCollected = round2(docSum('tax_total', 'sale_invoice') - docSum('tax_total', 'sale_return'))

  // Cash received from the customer for this project (receipts tagged to the project, plus receipts
  // without a project tag that were allocated to this project's invoices), less refunds.
  const receivedTagged = n(db, "SELECT SUM(amount) AS v FROM payments WHERE project_id = ? AND direction = 'in' AND status <> 'cancelled'", projectId)
  const receivedAllocated = n(
    db,
    `SELECT SUM(a.amount) AS v FROM payment_allocations a JOIN payments p ON p.id = a.payment_id JOIN documents d ON d.id = a.document_id
     WHERE d.project_id = ? AND d.doc_type = 'sale_invoice' AND p.direction = 'in' AND p.status <> 'cancelled'
       AND (p.project_id IS NULL OR p.project_id <> d.project_id)`,
    projectId
  )
  const refunds = pr.customer_id
    ? n(
        db,
        "SELECT SUM(amount) AS v FROM payments WHERE project_id = ? AND direction = 'out' AND party_id = ? AND status <> 'cancelled'",
        projectId,
        pr.customer_id
      )
    : 0
  const received = round2(receivedTagged + receivedAllocated - refunds)
  const custAdj = pr.customer_id
    ? n(
        db,
        `SELECT SUM(CASE WHEN direction = 'debit' THEN amount ELSE -amount END) AS v FROM party_adjustments
         WHERE project_id = ? AND party_id = ? AND status <> 'cancelled'`,
        projectId,
        pr.customer_id
      )
    : 0
  const customerOutstanding = round2(invoicedTotal - received + custAdj)

  const materialFromInvoices = round2(lineCost('sale_invoice', 'AND d.deduct_stock = 1') - lineCost('sale_return', 'AND d.deduct_stock = 1'))
  const issued = n(
    db,
    `SELECT SUM(CASE WHEN m.direction = 'issue' THEN l.cost_total ELSE -l.cost_total END) AS v
     FROM material_move_lines l JOIN material_moves m ON m.id = l.move_id WHERE m.project_id = ? AND m.status <> 'cancelled'`,
    projectId
  )
  const directGoods = round2(
    lineCost('purchase_invoice', "AND d.direct_to_project = 1 AND (p.type IS NULL OR p.type = 'goods')") -
      lineCost('purchase_return', "AND d.direct_to_project = 1 AND (p.type IS NULL OR p.type = 'goods')")
  )
  const directServices = round2(
    lineCost('purchase_invoice', "AND d.direct_to_project = 1 AND p.type = 'service'") -
      lineCost('purchase_return', "AND d.direct_to_project = 1 AND p.type = 'service'")
  )
  const exp = (heads: string[]): number =>
    n(
      db,
      `SELECT SUM(e.amount) AS v FROM expenses e JOIN expense_categories c ON c.id = e.category_id
       WHERE e.project_id = ? AND e.status <> 'cancelled' AND c.cost_head IN (${heads.map((h) => `'${h}'`).join(',')})`,
      projectId
    )
  const materialExpenses = exp(['material'])
  const materialCost = round2(materialFromInvoices + issued + directGoods + materialExpenses)
  const laborCost = round2(exp(['labor', 'contractor']) + directServices)
  const otherCost = exp(['transport', 'other', 'overhead'])
  const totalDirectCost = round2(materialCost + laborCost + otherCost)
  const grossProfit = round2(revenue - totalDirectCost)

  const method = getSetting<string>(db, 'overhead_method', 'none')
  let overheads = 0
  if (method === 'manual') overheads = round2(pr.overhead_amount)
  else if (method === 'percent_revenue') overheads = round2((revenue * num(getSetting(db, 'overhead_percent', 0))) / 100)
  const netProfit = round2(grossProfit - overheads)

  // Supplier / contractor payables linked to this project
  let supplierOutstanding = 0
  const bills = db
    .prepare("SELECT id FROM documents WHERE project_id = ? AND doc_type = 'purchase_invoice' AND status <> 'cancelled'")
    .all(projectId) as Array<{ id: number }>
  for (const b of bills) supplierOutstanding += Math.max(0, docDue(db, b.id))
  const exps = db
    .prepare("SELECT id FROM expenses WHERE project_id = ? AND paid = 0 AND status <> 'cancelled'")
    .all(projectId) as Array<{ id: number }>
  for (const e of exps) supplierOutstanding += Math.max(0, expenseDue(db, e.id))

  const po = db
    .prepare("SELECT COUNT(*) AS c, COALESCE(SUM(grand_total),0) AS v FROM documents WHERE project_id = ? AND doc_type = 'purchase_order' AND status = 'open'")
    .get(projectId) as { c: number; v: number }

  return {
    contractValue: round2(pr.contract_amount),
    revenue,
    invoicedTotal,
    taxCollected,
    received,
    customerOutstanding,
    materialFromInvoices,
    materialIssued: issued,
    materialDirectPurchase: directGoods,
    materialExpenses,
    materialCost,
    laborCost,
    otherCost,
    totalDirectCost,
    grossProfit,
    overheads,
    netProfit,
    marginPct: revenue > EPS ? round2((netProfit / revenue) * 100) : null,
    supplierOutstanding: round2(supplierOutstanding),
    pendingPurchaseOrders: po.c,
    pendingPurchaseValue: round2(po.v),
    unbilledContract: round2(Math.max(0, pr.contract_amount - invoicedTotal))
  }
}

function hideFinancials(ctx: Ctx, f: ProjectFinancials): Partial<ProjectFinancials> {
  if (can(ctx, 'projects.financials')) return f
  return {
    contractValue: f.contractValue,
    invoicedTotal: f.invoicedTotal,
    received: f.received,
    customerOutstanding: f.customerOutstanding,
    pendingPurchaseOrders: f.pendingPurchaseOrders
  }
}

export function listProjects(
  ctx: Ctx,
  f: { q?: string; status?: string; customerId?: number; from?: string; to?: string; archived?: 'hide' | 'only' | 'all' } = {}
): unknown[] {
  requirePerm(ctx, 'projects.view')
  const archived = f.archived === 'only' ? 1 : f.archived === 'all' ? null : 0
  const rows = ctx.db
    .prepare(
      `SELECT pr.*, pa.name AS customer_name, pa.phone AS customer_phone, u.full_name AS manager_name
       FROM projects pr LEFT JOIN parties pa ON pa.id = pr.customer_id LEFT JOIN users u ON u.id = pr.manager_user_id
       WHERE pr.firm_id = @firmId AND (@status IS NULL OR pr.status = @status) AND (@cust IS NULL OR pr.customer_id = @cust)
         AND (@archived IS NULL OR pr.is_archived = @archived)
         AND (@from IS NULL OR COALESCE(pr.start_date, date(pr.created_at)) >= @from)
         AND (@to IS NULL OR COALESCE(pr.start_date, date(pr.created_at)) <= @to)
         AND (@q IS NULL OR pr.name LIKE @q OR pr.code LIKE @q OR pa.name LIKE @q OR pr.city LIKE @q OR pr.site_address LIKE @q)
       ORDER BY pr.id DESC LIMIT 2000`
    )
    .all({
      firmId: ctx.firmId,
      status: f.status ?? null,
      cust: f.customerId ?? null,
      archived,
      from: f.from ?? null,
      to: f.to ?? null,
      q: f.q ? `%${f.q}%` : null
    }) as Array<{ id: number }>
  return rows.map((r) => ({ ...r, financials: hideFinancials(ctx, projectFinancials(ctx.db, r.id)) }))
}

/** Projects offered in pickers (documents, payments, expenses): active firm, not archived, not cancelled. */
export function projectOptions(ctx: Ctx): unknown[] {
  return ctx.db
    .prepare(
      `SELECT id, code, name, customer_id, status FROM projects
       WHERE firm_id = ? AND status <> 'cancelled' AND is_archived = 0 ORDER BY id DESC`
    )
    .all(ctx.firmId)
}

/** The project row if it belongs to the active firm. */
function projectInFirm(ctx: Ctx, id: number): Record<string, unknown> & { id: number; code: string; name: string; status: string; is_archived: number } {
  const pr = ctx.db.prepare('SELECT * FROM projects WHERE id = ? AND firm_id = ?').get(id, ctx.firmId) as
    | (Record<string, unknown> & { id: number; code: string; name: string; status: string; is_archived: number })
    | undefined
  if (!pr) throw new AppError('Project not found in the active firm.', 'NOT_FOUND')
  return pr
}

export function saveProject(ctx: Ctx, input: ProjectInput): number {
  requirePerm(ctx, 'projects.manage')
  const db = ctx.db
  const name = requireText(input.name, 'Project name', 150)
  const customerId = optId(input.customerId)
  if (customerId) {
    const c = db.prepare("SELECT type FROM parties WHERE id = ? AND (firm_id IS NULL OR firm_id = ?)").get(customerId, ctx.firmId) as
      | { type: string }
      | undefined
    if (!c) throw new AppError('Customer is not available in this firm.', 'VALIDATION')
    if (c.type === 'supplier') throw new AppError('Select a customer (not a supplier) for the project.', 'VALIDATION')
  }
  const status = (PROJECT_STATUSES as readonly string[]).includes(input.status ?? '') ? input.status! : 'planning'
  const progress = Math.min(100, Math.max(0, Math.round(num(input.progress))))
  const capacity = round3(num(input.capacityKw))
  if (capacity < 0) throw new AppError('System capacity cannot be negative.', 'VALIDATION')
  const managerId = optId(input.managerUserId)
  if (managerId && !db.prepare('SELECT 1 FROM users WHERE id = ?').get(managerId)) throw new AppError('Project manager not found.', 'VALIDATION')
  const vals = {
    name,
    customer_id: customerId,
    contact_person: optText(input.contactPerson, 100),
    contact_phone: optText(input.contactPhone, 40),
    site_address: optText(input.siteAddress, 500),
    city: optText(input.city, 80),
    capacity_kw: capacity,
    project_type: (PROJECT_TYPES as readonly string[]).includes(input.projectType ?? '') ? input.projectType : 'residential',
    system_type: (SYSTEM_TYPES as readonly string[]).includes(input.systemType ?? '') ? input.systemType : 'on_grid',
    start_date: optText(input.startDate, 10),
    expected_end_date: optText(input.expectedEndDate, 10),
    completed_date: status === 'completed' ? optText(input.completedDate, 10) ?? new Date().toISOString().slice(0, 10) : optText(input.completedDate, 10),
    manager_user_id: managerId,
    status,
    progress: status === 'completed' ? 100 : progress,
    quotation_id: optId(input.quotationId),
    contract_amount: round2(num(input.contractAmount)),
    overhead_amount: round2(num(input.overheadAmount)),
    warranty_info: optText(input.warrantyInfo, 2000),
    notes: optText(input.notes, 5000)
  }
  if (vals.quotation_id) {
    const q = db.prepare("SELECT 1 FROM documents WHERE id = ? AND firm_id = ? AND doc_type = 'quotation'").get(vals.quotation_id, ctx.firmId)
    if (!q) throw new AppError('Linked quotation not found in this firm.', 'VALIDATION')
  }
  return db.transaction(() => {
    if (input.id) {
      const before = db.prepare('SELECT * FROM projects WHERE id = ? AND firm_id = ?').get(input.id, ctx.firmId) as
        | Record<string, unknown>
        | undefined
      if (!before) throw new AppError('Project not found.', 'NOT_FOUND')
      if (before.customer_id && before.customer_id !== customerId) {
        const hasDocs = db.prepare("SELECT 1 FROM documents WHERE project_id = ? AND doc_type IN ('sale_invoice','sale_return') AND status <> 'cancelled'").get(input.id)
        if (hasDocs) throw new AppError('Customer cannot be changed after invoices are issued for this project.', 'VALIDATION')
      }
      const cols = Object.keys(vals)
      db.prepare(`UPDATE projects SET ${cols.map((c) => `${c} = @${c}`).join(', ')}, updated_at = datetime('now','localtime') WHERE id = @id`).run({
        ...vals,
        id: input.id
      })
      const changed = cols.filter((c) => String(before[c] ?? '') !== String((vals as Record<string, unknown>)[c] ?? ''))
      audit(ctx, 'update', 'project', input.id, `Updated project ${String(before.code)} ${name}`, {
        changed: Object.fromEntries(changed.map((c) => [c, { from: before[c], to: (vals as Record<string, unknown>)[c] }]))
      })
      return input.id
    }
    const code = nextNumber(db, ctx.firmId, 'project')
    const cols = Object.keys(vals)
    const id = Number(
      db
        .prepare(
          `INSERT INTO projects (firm_id, code, ${cols.join(', ')}, created_by) VALUES (@firm_id, @code, ${cols.map((c) => '@' + c).join(', ')}, @created_by)`
        )
        .run({ ...vals, firm_id: ctx.firmId, code, created_by: ctx.user.id }).lastInsertRowid
    )
    audit(ctx, 'create', 'project', id, `Created project ${code} ${name}`)
    return id
  })()
}

export function getProject(ctx: Ctx, id: number): Record<string, unknown> {
  requirePerm(ctx, 'projects.view')
  const db = ctx.db
  const pr = db
    .prepare(
      `SELECT pr.*, pa.name AS customer_name, pa.phone AS customer_phone, pa.address AS customer_address, pa.email AS customer_email,
         u.full_name AS manager_name, q.number AS quotation_number, cu.full_name AS created_by_name
       FROM projects pr LEFT JOIN parties pa ON pa.id = pr.customer_id LEFT JOIN users u ON u.id = pr.manager_user_id
       LEFT JOIN documents q ON q.id = pr.quotation_id LEFT JOIN users cu ON cu.id = pr.created_by
       WHERE pr.id = ? AND pr.firm_id = ?`
    )
    .get(id, ctx.firmId) as Record<string, unknown> | undefined
  if (!pr) throw new AppError('Project not found in the active firm.', 'NOT_FOUND')
  const financials = hideFinancials(ctx, projectFinancials(db, id))
  const attachments = db.prepare("SELECT * FROM attachments WHERE entity = 'project' AND entity_id = ? ORDER BY id DESC").all(id)
  return { ...pr, financials, attachments }
}

/** Every transaction linked to the project, in date order. */
export function projectLedger(ctx: Ctx, id: number): unknown[] {
  requirePerm(ctx, 'projects.view')
  projectInFirm(ctx, id)
  const showCost = can(ctx, 'projects.financials')
  const db = ctx.db
  const rows = db
    .prepare(
      `SELECT * FROM (
         SELECT d.date, d.id AS ref_id, d.doc_type AS kind, d.number, COALESCE(pa.name, d.party_name) AS party,
                CASE d.doc_type
                  WHEN 'sale_invoice' THEN 'Sales invoice' || CASE WHEN d.deduct_stock = 0 THEN ' (stock not deducted)' ELSE '' END
                  WHEN 'sale_return' THEN 'Sales return / credit note'
                  WHEN 'purchase_invoice' THEN CASE WHEN d.direct_to_project = 1 THEN 'Purchase - delivered direct to site' ELSE 'Purchase into stock (cost charged when issued)' END
                  WHEN 'purchase_return' THEN 'Purchase return'
                  WHEN 'quotation' THEN 'Quotation (' || d.status || ')'
                  WHEN 'sale_order' THEN 'Sales order (' || d.status || ')'
                  WHEN 'purchase_order' THEN 'Purchase order (' || d.status || ')'
                  ELSE 'Delivery challan' END AS description,
                CASE WHEN d.doc_type = 'sale_invoice' THEN d.net_total WHEN d.doc_type = 'sale_return' THEN -d.net_total ELSE 0 END AS revenue,
                CASE WHEN d.doc_type = 'sale_invoice' AND d.deduct_stock = 1 THEN d.cost_total
                     WHEN d.doc_type = 'sale_return' AND d.deduct_stock = 1 THEN -d.cost_total
                     WHEN d.doc_type = 'purchase_invoice' AND d.direct_to_project = 1 THEN d.cost_total
                     WHEN d.doc_type = 'purchase_return' AND d.direct_to_project = 1 THEN -d.cost_total ELSE 0 END AS cost,
                0 AS cash_in, 0 AS cash_out, d.grand_total AS doc_total, d.status, d.created_at
           FROM documents d LEFT JOIN parties pa ON pa.id = d.party_id WHERE d.project_id = @id
         UNION ALL
         SELECT m.date, m.id, 'material_' || m.direction, m.number, w.name,
                CASE m.direction WHEN 'issue' THEN 'Materials issued from stock' ELSE 'Materials returned to stock' END,
                0, CASE m.direction WHEN 'issue' THEN m.total_cost ELSE -m.total_cost END, 0, 0, NULL, m.status, m.created_at
           FROM material_moves m JOIN warehouses w ON w.id = m.warehouse_id WHERE m.project_id = @id
         UNION ALL
         SELECT e.date, e.id, 'expense', e.number, COALESCE(pa.name, e.payee_name), ec.name || CASE WHEN e.paid = 0 THEN ' (payable)' ELSE '' END,
                0, e.amount, 0, CASE WHEN e.paid = 1 THEN e.amount ELSE 0 END, e.amount, e.status, e.created_at
           FROM expenses e JOIN expense_categories ec ON ec.id = e.category_id LEFT JOIN parties pa ON pa.id = e.party_id
          WHERE e.project_id = @id
         UNION ALL
         SELECT p.date, p.id, CASE p.direction WHEN 'in' THEN 'receipt' ELSE 'payment' END, p.number, pa.name,
                CASE p.direction WHEN 'in' THEN 'Payment received' ELSE 'Payment made' END || COALESCE(' (' || p.method || ')', ''),
                0, 0, CASE p.direction WHEN 'in' THEN p.amount ELSE 0 END, CASE p.direction WHEN 'out' THEN p.amount ELSE 0 END,
                p.amount, p.status, p.created_at
           FROM payments p LEFT JOIN parties pa ON pa.id = p.party_id WHERE p.project_id = @id
         UNION ALL
         SELECT a.date, a.id, 'adjustment', a.number, pa.name, COALESCE(a.reason, 'Balance adjustment') || ' (' || a.direction || ')',
                0, 0, 0, 0, a.amount, a.status, a.created_at
           FROM party_adjustments a JOIN parties pa ON pa.id = a.party_id WHERE a.project_id = @id
       ) x ORDER BY x.date, x.created_at`
    )
    .all({ id }) as Array<Record<string, unknown>>
  return rows.map((r) => (showCost ? r : { ...r, cost: null }))
}

/** Product-wise material usage for a project. */
export function materialUsage(ctx: Ctx, id: number): unknown[] {
  requirePerm(ctx, 'projects.view')
  projectInFirm(ctx, id)
  const showCost = can(ctx, 'projects.financials')
  const rows = ctx.db
    .prepare(
      `SELECT product_id, p.name AS product_name, p.unit,
         ROUND(SUM(issued), 3) AS issued, ROUND(SUM(returned), 3) AS returned, ROUND(SUM(invoiced), 3) AS invoiced,
         ROUND(SUM(direct), 3) AS direct, ROUND(SUM(cost), 2) AS cost
       FROM (
         SELECT l.product_id, CASE WHEN m.direction = 'issue' THEN l.qty ELSE 0 END AS issued,
                CASE WHEN m.direction = 'return' THEN l.qty ELSE 0 END AS returned, 0 AS invoiced, 0 AS direct,
                CASE WHEN m.direction = 'issue' THEN l.cost_total ELSE -l.cost_total END AS cost
           FROM material_move_lines l JOIN material_moves m ON m.id = l.move_id WHERE m.project_id = @id AND m.status <> 'cancelled'
         UNION ALL
         SELECT l.product_id, 0, 0, CASE WHEN d.doc_type = 'sale_invoice' THEN l.qty ELSE -l.qty END, 0,
                CASE WHEN d.doc_type = 'sale_invoice' THEN l.cost_total ELSE -l.cost_total END
           FROM document_lines l JOIN documents d ON d.id = l.document_id
          WHERE d.project_id = @id AND d.doc_type IN ('sale_invoice','sale_return') AND d.deduct_stock = 1 AND d.status <> 'cancelled'
            AND l.product_id IS NOT NULL
         UNION ALL
         SELECT l.product_id, 0, 0, 0, CASE WHEN d.doc_type = 'purchase_invoice' THEN l.qty ELSE -l.qty END,
                CASE WHEN d.doc_type = 'purchase_invoice' THEN l.cost_total ELSE -l.cost_total END
           FROM document_lines l JOIN documents d ON d.id = l.document_id
          WHERE d.project_id = @id AND d.doc_type IN ('purchase_invoice','purchase_return') AND d.direct_to_project = 1 AND d.status <> 'cancelled'
            AND l.product_id IS NOT NULL
       ) x JOIN products p ON p.id = x.product_id
       GROUP BY product_id ORDER BY p.name`
    )
    .all({ id }) as Array<Record<string, number | string>>
  return rows.map((r) => ({
    ...r,
    net_used: round3(Number(r.issued) - Number(r.returned) + Number(r.invoiced) + Number(r.direct)),
    cost: showCost ? r.cost : null
  }))
}

/* --------------------------- Material issues / returns --------------------------- */

export interface MaterialMoveInput {
  projectId: number
  direction: 'issue' | 'return'
  date: string
  warehouseId: number
  notes?: string
  lines: Array<{ productId: number; qty: number; serials?: string; notes?: string }>
}

function issuedBalance(db: DB, projectId: number, productId: number, excludeMoveId = 0): { qty: number; cost: number } {
  const r = db
    .prepare(
      `SELECT COALESCE(SUM(CASE WHEN m.direction = 'issue' THEN l.qty ELSE -l.qty END), 0) AS qty,
              COALESCE(SUM(CASE WHEN m.direction = 'issue' THEN l.cost_total ELSE -l.cost_total END), 0) AS cost
       FROM material_move_lines l JOIN material_moves m ON m.id = l.move_id
       WHERE m.project_id = ? AND l.product_id = ? AND m.status <> 'cancelled' AND m.id <> ?`
    )
    .get(projectId, productId, excludeMoveId) as { qty: number; cost: number }
  return { qty: round3(r.qty), cost: round2(r.cost) }
}

export function createMaterialMove(ctx: Ctx, input: MaterialMoveInput): number {
  requirePerm(ctx, 'projects.manage')
  const db = ctx.db
  const date = requireDate(input.date)
  const direction = input.direction === 'return' ? 'return' : 'issue'
  const project = db.prepare('SELECT * FROM projects WHERE id = ? AND firm_id = ?').get(input.projectId, ctx.firmId) as
    | { id: number; code: string; customer_id: number | null; status: string; is_archived: number }
    | undefined
  if (!project) throw new AppError('Project not found in the active firm.', 'VALIDATION')
  if (project.status === 'cancelled') throw new AppError('Project is cancelled.', 'VALIDATION')
  if (project.is_archived) throw new AppError('Project is archived. Restore it before issuing or returning materials.', 'VALIDATION')
  assertWarehouseVisible(ctx, input.warehouseId)
  const lines = (input.lines ?? []).filter((l) => l && l.productId && num(l.qty) > 0)
  if (lines.length === 0) throw new AppError('Add at least one product with a quantity.', 'VALIDATION')
  return db.transaction(() => {
    const type = direction === 'issue' ? 'material_issue' : 'material_return'
    const number = nextNumber(db, ctx.firmId, type)
    const id = Number(
      db
        .prepare(
          `INSERT INTO material_moves (firm_id, project_id, direction, number, date, warehouse_id, notes, created_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(ctx.firmId, project.id, direction, number, date, input.warehouseId, optText(input.notes, 1000), ctx.user.id).lastInsertRowid
    )
    let total = 0
    for (const l of lines) {
      const p = getProductRow(db, l.productId)
      if (p.type === 'service') throw new AppError(`"${p.name}" is a service and cannot be issued from stock.`, 'VALIDATION')
      const visible = db.prepare('SELECT 1 FROM products WHERE id = ? AND (firm_id IS NULL OR firm_id = ?)').get(p.id, ctx.firmId)
      if (!visible) throw new AppError(`"${p.name}" is not available in this firm.`, 'VALIDATION')
      // Archived products cannot be issued; returning already-issued material of an archived product is allowed.
      if (direction === 'issue' && !p.is_active) throw new AppError(`"${p.name}" is archived. Restore it in Inventory before issuing it.`, 'VALIDATION')
      const qty = round3(num(l.qty))
      const serials = parseSerials(l.serials)
      checkSerialCount(p, qty, serials)
      const lineId = Number(
        db
          .prepare('INSERT INTO material_move_lines (move_id, product_id, qty, serials, notes) VALUES (?, ?, ?, ?, ?)')
          .run(id, p.id, qty, serials.join(', ') || null, optText(l.notes, 300)).lastInsertRowid
      )
      const m = { firmId: ctx.firmId, productId: p.id, warehouseId: input.warehouseId, qty, date, refType: type, refId: id, refLineId: lineId, refNumber: number, projectId: project.id, userId: ctx.user.id }
      let unitCost: number
      if (direction === 'issue') {
        unitCost = stockOut(db, m)
        if (serials.length) serialsOut(db, p.id, serials, { refType: type, refId: id, status: 'issued', partyId: project.customer_id, projectId: project.id, date, strict: !!p.track_serial })
      } else {
        const bal = issuedBalance(db, project.id, p.id, id)
        if (qty > bal.qty + EPS) throw new AppError(`Only ${bal.qty} ${p.unit} of "${p.name}" is issued to this project; cannot return ${qty}.`, 'VALIDATION')
        // Return at the project's average issue cost so the project cost reverses exactly.
        unitCost = bal.qty > EPS ? round4(bal.cost / bal.qty) : p.avg_cost
        stockIn(db, { ...m, unitCost })
        if (serials.length) serialsIn(db, p.id, serials, { warehouseId: input.warehouseId, refType: type, refId: id, isReturn: true })
      }
      const cost = round2(unitCost * qty)
      total += cost
      db.prepare('UPDATE material_move_lines SET unit_cost = ?, cost_total = ? WHERE id = ?').run(unitCost, cost, lineId)
    }
    db.prepare('UPDATE material_moves SET total_cost = ? WHERE id = ?').run(round2(total), id)
    audit(ctx, 'create', type, id, `${direction === 'issue' ? 'Issued' : 'Returned'} materials ${number} for project ${project.code}`, { lines })
    return id
  })()
}

export function cancelMaterialMove(ctx: Ctx, id: number, reason?: string): void {
  requirePerm(ctx, 'projects.manage')
  const db = ctx.db
  const m = db.prepare('SELECT * FROM material_moves WHERE id = ? AND firm_id = ?').get(id, ctx.firmId) as
    | { id: number; direction: string; number: string; status: string; date: string; project_id: number }
    | undefined
  if (!m) throw new AppError('Material movement not found.', 'NOT_FOUND')
  if (m.status === 'cancelled') throw new AppError('Already cancelled.', 'VALIDATION')
  const type = m.direction === 'issue' ? 'material_issue' : 'material_return'
  db.transaction(() => {
    if (m.direction === 'issue') {
      // Cannot cancel an issue if that would leave more returned than issued.
      const lines = db.prepare('SELECT product_id, qty FROM material_move_lines WHERE move_id = ?').all(id) as Array<{ product_id: number; qty: number }>
      for (const l of lines) {
        const bal = issuedBalance(db, m.project_id, l.product_id, id)
        if (bal.qty < -EPS) throw new AppError('Some of these materials were returned already. Cancel the return first.', 'VALIDATION')
      }
    }
    reverseSerials(db, type, id)
    reverseMovements(db, type, id, ctx.user.id, m.date)
    db.prepare("UPDATE material_moves SET status = 'cancelled', cancelled_by = ?, cancelled_at = datetime('now','localtime') WHERE id = ?").run(ctx.user.id, id)
    audit(ctx, 'cancel', type, id, `Cancelled ${m.number}`, { reason })
  })()
}

export function listMaterialMoves(ctx: Ctx, f: { projectId?: number; from?: string; to?: string } = {}): unknown[] {
  requirePerm(ctx, 'projects.view')
  const showCost = can(ctx, 'projects.financials')
  const rows = ctx.db
    .prepare(
      `SELECT m.*, pr.name AS project_name, pr.code AS project_code, w.name AS warehouse_name, u.full_name AS created_by_name
       FROM material_moves m JOIN projects pr ON pr.id = m.project_id JOIN warehouses w ON w.id = m.warehouse_id
       LEFT JOIN users u ON u.id = m.created_by
       WHERE m.firm_id = @firmId AND (@projectId IS NULL OR m.project_id = @projectId)
         AND (@from IS NULL OR m.date >= @from) AND (@to IS NULL OR m.date <= @to)
       ORDER BY m.date DESC, m.id DESC LIMIT 2000`
    )
    .all({ firmId: ctx.firmId, projectId: f.projectId ?? null, from: f.from ?? null, to: f.to ?? null }) as Array<Record<string, unknown>>
  return rows.map((r) => (showCost ? r : { ...r, total_cost: null }))
}

export function getMaterialMove(ctx: Ctx, id: number): unknown {
  requirePerm(ctx, 'projects.view')
  const m = ctx.db
    .prepare(
      `SELECT m.*, pr.name AS project_name, pr.code AS project_code, pr.site_address, pa.name AS customer_name, w.name AS warehouse_name,
         u.full_name AS created_by_name
       FROM material_moves m JOIN projects pr ON pr.id = m.project_id LEFT JOIN parties pa ON pa.id = pr.customer_id
       JOIN warehouses w ON w.id = m.warehouse_id LEFT JOIN users u ON u.id = m.created_by WHERE m.id = ? AND m.firm_id = ?`
    )
    .get(id, ctx.firmId)
  if (!m) throw new AppError('Material movement not found.', 'NOT_FOUND')
  const lines = ctx.db
    .prepare('SELECT l.*, p.name AS product_name, p.unit, p.sku FROM material_move_lines l JOIN products p ON p.id = l.product_id WHERE l.move_id = ?')
    .all(id)
  return { ...(m as object), lines }
}

/* ------------------------------ Attachments ------------------------------ */

const MAX_ATTACHMENT = 25 * 1024 * 1024

export function addAttachment(ctx: Ctx, dir: string, entity: string, entityId: number, sourcePath: string): number {
  requirePerm(ctx, 'projects.manage')
  if (entity !== 'project') throw new AppError('Unsupported attachment target.', 'VALIDATION')
  if (!ctx.db.prepare('SELECT 1 FROM projects WHERE id = ? AND firm_id = ?').get(entityId, ctx.firmId)) throw new AppError('Project not found.', 'NOT_FOUND')
  if (!existsSync(sourcePath)) throw new AppError('File not found.', 'VALIDATION')
  const st = statSync(sourcePath)
  if (!st.isFile()) throw new AppError('Select a file.', 'VALIDATION')
  if (st.size > MAX_ATTACHMENT) throw new AppError('File is larger than 25 MB.', 'VALIDATION')
  mkdirSync(dir, { recursive: true })
  const stored = `${entity}-${entityId}-${Date.now()}${extname(sourcePath).toLowerCase().replace(/[^.a-z0-9]/g, '')}`
  copyFileSync(sourcePath, join(dir, stored))
  const id = Number(
    ctx.db
      .prepare('INSERT INTO attachments (entity, entity_id, file_name, stored_name, size, created_by) VALUES (?, ?, ?, ?, ?, ?)')
      .run(entity, entityId, basename(sourcePath).slice(0, 200), stored, st.size, ctx.user.id).lastInsertRowid
  )
  audit(ctx, 'attach', entity, entityId, `Attached ${basename(sourcePath)}`)
  return id
}

export function attachmentPath(ctx: Ctx, dir: string, id: number): string {
  requirePerm(ctx, 'projects.view')
  const a = ctx.db
    .prepare("SELECT a.* FROM attachments a JOIN projects p ON p.id = a.entity_id AND a.entity = 'project' WHERE a.id = ? AND p.firm_id = ?")
    .get(id, ctx.firmId) as { stored_name: string } | undefined
  if (!a) throw new AppError('Attachment not found.', 'NOT_FOUND')
  const full = join(dir, basename(a.stored_name))
  if (!existsSync(full)) throw new AppError('The attachment file is missing from disk.', 'NOT_FOUND')
  return full
}

export function deleteAttachment(ctx: Ctx, dir: string, id: number): void {
  requirePerm(ctx, 'projects.manage')
  const full = attachmentPath(ctx, dir, id)
  ctx.db.prepare('DELETE FROM attachments WHERE id = ?').run(id)
  try {
    unlinkSync(full)
  } catch {
    /* file already gone */
  }
  audit(ctx, 'delete', 'attachment', id, 'Removed project attachment')
}

/* --------------------------- Delete / archive / cancel --------------------------- */

export interface ProjectLinks {
  documents: number
  quotations: number
  invoices: number
  purchases: number
  payments: number
  expenses: number
  materialMoves: number
  partyAdjustments: number
  attachments: number
  stockMovements: number
  serials: number
  total: number
  summary: string[]
}

/** Every record that points at a project. A project with any of these is never deleted (only archived / cancelled). */
export function projectLinks(db: DB, projectId: number): ProjectLinks {
  const c = (sql: string): number => (db.prepare(sql).get(projectId) as { c: number }).c
  const documents = c('SELECT COUNT(*) AS c FROM documents WHERE project_id = ?')
  const quotations = c("SELECT COUNT(*) AS c FROM documents WHERE project_id = ? AND doc_type = 'quotation'")
  const invoices = c("SELECT COUNT(*) AS c FROM documents WHERE project_id = ? AND doc_type IN ('sale_invoice','sale_return','sale_order','delivery_challan')")
  const purchases = c("SELECT COUNT(*) AS c FROM documents WHERE project_id = ? AND doc_type IN ('purchase_invoice','purchase_return','purchase_order')")
  const payments = c('SELECT COUNT(*) AS c FROM payments WHERE project_id = ?')
  const expenses = c('SELECT COUNT(*) AS c FROM expenses WHERE project_id = ?')
  const materialMoves = c('SELECT COUNT(*) AS c FROM material_moves WHERE project_id = ?')
  const partyAdjustments = c('SELECT COUNT(*) AS c FROM party_adjustments WHERE project_id = ?')
  const attachments = c("SELECT COUNT(*) AS c FROM attachments WHERE entity = 'project' AND entity_id = ?")
  const stockMovements = c('SELECT COUNT(*) AS c FROM stock_movements WHERE project_id = ?')
  const serials = c('SELECT COUNT(*) AS c FROM serials WHERE project_id = ?')
  const n = (v: number, one: string, many = `${one}s`): string => `${v} ${v === 1 ? one : many}`
  const summary: string[] = []
  if (quotations) summary.push(n(quotations, 'quotation'))
  if (invoices) summary.push(n(invoices, 'sales document') + ' (invoices, returns, orders or challans)')
  if (purchases) summary.push(n(purchases, 'purchase document'))
  if (payments) summary.push(n(payments, 'payment / receipt', 'payments / receipts'))
  if (expenses) summary.push(n(expenses, 'expense'))
  if (materialMoves) summary.push(n(materialMoves, 'material issue / return', 'material issues / returns'))
  if (partyAdjustments) summary.push(n(partyAdjustments, 'balance adjustment'))
  if (attachments) summary.push(n(attachments, 'attached file'))
  if (!materialMoves && !documents && stockMovements) summary.push(n(stockMovements, 'stock movement'))
  if (!materialMoves && !documents && serials) summary.push(n(serials, 'serial number record'))
  const total = documents + payments + expenses + materialMoves + partyAdjustments + attachments + stockMovements + serials
  return { documents, quotations, invoices, purchases, payments, expenses, materialMoves, partyAdjustments, attachments, stockMovements, serials, total, summary }
}

export function getProjectLinks(ctx: Ctx, id: number): ProjectLinks & { id: number; code: string; name: string; status: string; is_archived: number } {
  requirePerm(ctx, 'projects.view')
  const pr = projectInFirm(ctx, id)
  return { id: pr.id, code: pr.code, name: pr.name, status: pr.status, is_archived: pr.is_archived, ...projectLinks(ctx.db, id) }
}

/**
 * Permanently delete a project - only when nothing is linked to it. Projects with documents, payments,
 * expenses, material moves, adjustments or files are refused (archive or cancel them instead); financial
 * records are never cascade-deleted.
 */
export function deleteProject(ctx: Ctx, id: number): { deleted: true } {
  requirePerm(ctx, 'projects.delete')
  const db = ctx.db
  return db.transaction(() => {
    const pr = projectInFirm(ctx, id)
    const links = projectLinks(db, id)
    if (links.total > 0) {
      throw new AppError(
        `Project ${pr.code} cannot be deleted because it has ${links.summary.join(', ')}. Archive it to hide it from lists and pickers (all records stay intact)${pr.status !== 'cancelled' && pr.status !== 'completed' ? ', or mark it as cancelled' : ''}.`,
        'HAS_RECORDS'
      )
    }
    // A quotation may point back at the project only through projects.quotation_id (the project row itself).
    db.prepare('DELETE FROM projects WHERE id = ?').run(id)
    audit(ctx, 'delete', 'project', id, `Deleted project ${pr.code} ${pr.name} permanently (no linked records)`, { project: pr })
    return { deleted: true as const }
  })()
}

/** Archive (hide from lists and pickers, keep everything) or restore a project. */
export function setProjectArchived(ctx: Ctx, id: number, archived: boolean): { archived: boolean } {
  requirePerm(ctx, 'projects.delete')
  const pr = projectInFirm(ctx, id)
  if (!!pr.is_archived === archived) return { archived }
  ctx.db
    .prepare("UPDATE projects SET is_archived = ?, archived_at = CASE WHEN ? = 1 THEN datetime('now','localtime') ELSE NULL END, updated_at = datetime('now','localtime') WHERE id = ?")
    .run(archived ? 1 : 0, archived ? 1 : 0, id)
  audit(ctx, archived ? 'archive' : 'restore', 'project', id, `${archived ? 'Archived' : 'Restored'} project ${pr.code} ${pr.name}`)
  return { archived }
}

/** Mark a project as cancelled (keeps all its records; no new material issues can be posted). */
export function cancelProject(ctx: Ctx, id: number, reason?: string): void {
  requirePerm(ctx, 'projects.manage')
  const pr = projectInFirm(ctx, id)
  if (pr.status === 'cancelled') throw new AppError('Project is already cancelled.', 'VALIDATION')
  if (pr.status === 'completed') throw new AppError('A completed project cannot be cancelled. Archive it instead.', 'VALIDATION')
  ctx.db.prepare("UPDATE projects SET status = 'cancelled', updated_at = datetime('now','localtime') WHERE id = ?").run(id)
  audit(ctx, 'cancel', 'project', id, `Cancelled project ${pr.code} ${pr.name}`, { reason: optText(reason, 300), previousStatus: pr.status })
}

/** Profitability comparison across projects. */
export function projectProfitReport(ctx: Ctx, f: { status?: string; from?: string; to?: string; archived?: 'hide' | 'only' | 'all' } = {}): unknown {
  requirePerm(ctx, 'projects.financials')
  // Archiving only hides a project from day-to-day lists: profit reports keep including it unless asked otherwise.
  const rows = listProjects(ctx, { ...f, archived: f.archived ?? 'all' }) as Array<{ financials: ProjectFinancials; capacity_kw: number }>
  const totals = rows.reduce(
    (a, r) => {
      a.contract += r.financials.contractValue
      a.revenue += r.financials.revenue
      a.cost += r.financials.totalDirectCost
      a.gross += r.financials.grossProfit
      a.net += r.financials.netProfit
      a.received += r.financials.received
      a.outstanding += r.financials.customerOutstanding
      a.kw += r.capacity_kw || 0
      return a
    },
    { contract: 0, revenue: 0, cost: 0, gross: 0, net: 0, received: 0, outstanding: 0, kw: 0 }
  )
  for (const k of Object.keys(totals) as Array<keyof typeof totals>) totals[k] = round2(totals[k])
  return {
    rows: rows.map((r) => ({
      ...r,
      profit_per_kw: r.capacity_kw > 0 ? round2(r.financials.netProfit / r.capacity_kw) : null
    })),
    totals: { ...totals, marginPct: totals.revenue > 0 ? round2((totals.net / totals.revenue) * 100) : null }
  }
}
