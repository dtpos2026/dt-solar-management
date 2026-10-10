/**
 * Expenses — general business (overhead) expenses and project-specific direct costs
 * (labor, contractors, transport, site material, other).
 *
 * An expense is either PAID immediately from a cash/bank account, or recorded as PAYABLE to a
 * supplier/contractor (then settled later with a supplier payment). Never both.
 */
import { COST_HEADS } from '../../shared/docTypes'
import { EPS, num, round2 } from '../../shared/money'
import { AppError, Ctx, audit, optId, optText, requireDate, requirePerm, requireText } from './context'
import { nextNumber } from './firms'
import { assertAccount, expenseAllocated } from './payments'

export interface ExpenseInput {
  id?: number
  date: string
  categoryId: number
  projectId?: number | null
  amount: number
  paid: boolean
  accountId?: number | null
  partyId?: number | null
  payeeName?: string
  method?: string
  reference?: string
  notes?: string
}

function validate(ctx: Ctx, input: ExpenseInput): Record<string, unknown> {
  const db = ctx.db
  const date = requireDate(input.date)
  const amount = round2(num(input.amount))
  if (amount <= 0) throw new AppError('Amount must be greater than zero.', 'VALIDATION')
  const cat = db.prepare('SELECT id, is_active FROM expense_categories WHERE id = ?').get(input.categoryId) as { is_active: number } | undefined
  if (!cat) throw new AppError('Select an expense category.', 'VALIDATION')
  const projectId = optId(input.projectId)
  if (projectId && !db.prepare('SELECT 1 FROM projects WHERE id = ? AND firm_id = ?').get(projectId, ctx.firmId)) {
    throw new AppError('Project does not belong to the active firm.', 'VALIDATION')
  }
  const partyId = optId(input.partyId)
  if (partyId) {
    const p = db.prepare("SELECT type FROM parties WHERE id = ? AND (firm_id IS NULL OR firm_id = ?)").get(partyId, ctx.firmId) as
      | { type: string }
      | undefined
    if (!p) throw new AppError('Supplier/contractor is not available in this firm.', 'VALIDATION')
  }
  const paid = !!input.paid
  let accountId: number | null = null
  if (paid) accountId = assertAccount(ctx, input.accountId)
  else if (!partyId) throw new AppError('Unpaid expenses must be billed to a supplier / contractor so the payable can be tracked.', 'VALIDATION')
  return {
    date,
    category_id: input.categoryId,
    project_id: projectId,
    amount,
    paid: paid ? 1 : 0,
    account_id: accountId,
    party_id: partyId,
    payee_name: optText(input.payeeName, 120),
    method: optText(input.method, 30),
    reference: optText(input.reference, 100),
    notes: optText(input.notes, 1000)
  }
}

export function createExpense(ctx: Ctx, input: ExpenseInput): number {
  requirePerm(ctx, 'expenses.manage')
  const v = validate(ctx, input)
  return ctx.db.transaction(() => {
    const number = nextNumber(ctx.db, ctx.firmId, 'expense')
    const cols = Object.keys(v)
    const id = Number(
      ctx.db
        .prepare(
          `INSERT INTO expenses (firm_id, number, ${cols.join(', ')}, created_by) VALUES (@firm_id, @number, ${cols.map((c) => '@' + c).join(', ')}, @created_by)`
        )
        .run({ ...v, firm_id: ctx.firmId, number, created_by: ctx.user.id }).lastInsertRowid
    )
    audit(ctx, 'create', 'expense', id, `Expense ${number} — ${v.amount}`, input)
    return id
  })()
}

export function updateExpense(ctx: Ctx, input: ExpenseInput): number {
  requirePerm(ctx, 'expenses.manage')
  if (!input.id) throw new AppError('Expense id missing.', 'VALIDATION')
  const before = ctx.db.prepare('SELECT * FROM expenses WHERE id = ? AND firm_id = ?').get(input.id, ctx.firmId) as
    | Record<string, unknown>
    | undefined
  if (!before) throw new AppError('Expense not found.', 'NOT_FOUND')
  if (before.status === 'cancelled') throw new AppError('Cancelled expenses cannot be edited.', 'VALIDATION')
  const allocated = expenseAllocated(ctx.db, input.id)
  const v = validate(ctx, input)
  if (allocated > EPS) {
    if (v.paid || v.party_id !== before.party_id || Number(v.amount) + EPS < allocated) {
      throw new AppError('Payments are recorded against this expense. Cancel those payments before changing payee, amount or paid status.', 'VALIDATION')
    }
  }
  const cols = Object.keys(v)
  ctx.db
    .prepare(
      `UPDATE expenses SET ${cols.map((c) => `${c} = @${c}`).join(', ')}, updated_by = @uid, updated_at = datetime('now','localtime') WHERE id = @id`
    )
    .run({ ...v, uid: ctx.user.id, id: input.id })
  audit(ctx, 'update', 'expense', input.id, `Edited expense ${String(before.number)}`, { before, after: v })
  return input.id
}

export function cancelExpense(ctx: Ctx, id: number, reason?: string): void {
  requirePerm(ctx, 'expenses.manage')
  const e = ctx.db.prepare('SELECT * FROM expenses WHERE id = ? AND firm_id = ?').get(id, ctx.firmId) as
    | { number: string; status: string }
    | undefined
  if (!e) throw new AppError('Expense not found.', 'NOT_FOUND')
  if (e.status === 'cancelled') throw new AppError('Already cancelled.', 'VALIDATION')
  if (expenseAllocated(ctx.db, id) > EPS) throw new AppError('Cancel the payments made against this expense first.', 'VALIDATION')
  ctx.db
    .prepare("UPDATE expenses SET status = 'cancelled', cancelled_by = ?, cancelled_at = datetime('now','localtime'), cancel_reason = ? WHERE id = ?")
    .run(ctx.user.id, optText(reason, 300), id)
  audit(ctx, 'cancel', 'expense', id, `Cancelled expense ${e.number}`, { reason })
}

export function listExpenses(
  ctx: Ctx,
  f: { from?: string; to?: string; categoryId?: number; projectId?: number; partyId?: number; costHead?: string; q?: string; includeCancelled?: boolean } = {}
): unknown[] {
  requirePerm(ctx, 'expenses.view')
  return ctx.db
    .prepare(
      `SELECT e.*, ec.name AS category_name, ec.cost_head, pr.name AS project_name, pr.code AS project_code, pa.name AS party_name,
         a.name AS account_name, u.full_name AS created_by_name,
         CASE WHEN e.paid = 1 THEN 0 ELSE ROUND(e.amount - COALESCE((SELECT SUM(x.amount) FROM payment_allocations x
           JOIN payments p ON p.id = x.payment_id WHERE x.expense_id = e.id AND p.status <> 'cancelled'), 0), 2) END AS due
       FROM expenses e JOIN expense_categories ec ON ec.id = e.category_id LEFT JOIN projects pr ON pr.id = e.project_id
       LEFT JOIN parties pa ON pa.id = e.party_id LEFT JOIN accounts a ON a.id = e.account_id LEFT JOIN users u ON u.id = e.created_by
       WHERE e.firm_id = @firmId AND (@from IS NULL OR e.date >= @from) AND (@to IS NULL OR e.date <= @to)
         AND (@cat IS NULL OR e.category_id = @cat) AND (@projectId IS NULL OR e.project_id = @projectId)
         AND (@partyId IS NULL OR e.party_id = @partyId) AND (@head IS NULL OR ec.cost_head = @head)
         AND (@q IS NULL OR e.number LIKE @q OR e.payee_name LIKE @q OR e.notes LIKE @q OR pa.name LIKE @q OR ec.name LIKE @q)
         AND (@inclCancelled = 1 OR e.status <> 'cancelled')
       ORDER BY e.date DESC, e.id DESC LIMIT 5000`
    )
    .all({
      firmId: ctx.firmId,
      from: f.from ?? null,
      to: f.to ?? null,
      cat: f.categoryId ?? null,
      projectId: f.projectId ?? null,
      partyId: f.partyId ?? null,
      head: f.costHead ?? null,
      q: f.q ? `%${f.q}%` : null,
      inclCancelled: f.includeCancelled ? 1 : 0
    })
}

export function getExpense(ctx: Ctx, id: number): unknown {
  requirePerm(ctx, 'expenses.view')
  const e = ctx.db
    .prepare(
      `SELECT e.*, ec.name AS category_name, ec.cost_head, pr.name AS project_name, pa.name AS party_name, a.name AS account_name
       FROM expenses e JOIN expense_categories ec ON ec.id = e.category_id LEFT JOIN projects pr ON pr.id = e.project_id
       LEFT JOIN parties pa ON pa.id = e.party_id LEFT JOIN accounts a ON a.id = e.account_id WHERE e.id = ? AND e.firm_id = ?`
    )
    .get(id, ctx.firmId)
  if (!e) throw new AppError('Expense not found.', 'NOT_FOUND')
  return { ...(e as object), allocated: expenseAllocated(ctx.db, id) }
}

export function listExpenseCategories(ctx: Ctx): unknown[] {
  return ctx.db
    .prepare('SELECT c.*, (SELECT COUNT(*) FROM expenses e WHERE e.category_id = c.id) AS usage FROM expense_categories c ORDER BY c.cost_head, c.name')
    .all()
}

export function saveExpenseCategory(ctx: Ctx, input: { id?: number; name: string; costHead: string; isActive?: boolean }): number {
  requirePerm(ctx, 'expenses.manage')
  const name = requireText(input.name, 'Category name', 80)
  const head = (COST_HEADS as readonly string[]).includes(input.costHead) ? input.costHead : 'overhead'
  const dup = ctx.db.prepare('SELECT id FROM expense_categories WHERE name = ? AND id <> ?').get(name, input.id ?? 0)
  if (dup) throw new AppError('A category with this name exists.', 'VALIDATION')
  if (input.id) {
    ctx.db.prepare('UPDATE expense_categories SET name = ?, cost_head = ?, is_active = ? WHERE id = ?').run(name, head, input.isActive === false ? 0 : 1, input.id)
    audit(ctx, 'update', 'expense_category', input.id, `Updated expense category ${name}`)
    return input.id
  }
  const id = Number(ctx.db.prepare('INSERT INTO expense_categories (name, cost_head) VALUES (?, ?)').run(name, head).lastInsertRowid)
  audit(ctx, 'create', 'expense_category', id, `Created expense category ${name}`)
  return id
}
