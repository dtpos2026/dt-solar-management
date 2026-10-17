/**
 * Customers & suppliers ("parties") and their firm-specific ledgers.
 *
 * Balance sign convention: POSITIVE = the party owes us (receivable), NEGATIVE = we owe the party (payable).
 *   Sales invoice  -> debit      Sales return / credit note   -> credit
 *   Purchase bill  -> credit     Purchase return / debit note -> debit
 *   Receipt (in)   -> credit     Payment (out)                -> debit
 *   Expense billed to party -> credit, paid immediately -> debit
 *   Journal adjustment debit/credit as entered.
 * Even when parties are shared between firms, each firm has its own ledger.
 */
import { num, round2 } from '../../shared/money'
import { AppError, Ctx, audit, can, getSetting, like, optId, optText, requireDate, requirePerm, requireText, visibleTo } from './context'
import { nextNumber } from './firms'

/** One row per ledger event; parameters: none (filter outside). */
export const LEDGER_SQL = `
  SELECT p.id AS party_id, p.opening_firm_id AS firm_id, COALESCE(p.opening_date, date(p.created_at)) AS date,
         'opening' AS kind, NULL AS ref_id, 'Opening Balance' AS number, 'Opening balance' AS description,
         CASE WHEN p.opening_balance > 0 THEN p.opening_balance ELSE 0 END AS debit,
         CASE WHEN p.opening_balance < 0 THEN -p.opening_balance ELSE 0 END AS credit, NULL AS project_id, 0 AS sort
    FROM parties p WHERE p.opening_balance <> 0 AND p.opening_firm_id IS NOT NULL
  UNION ALL
  SELECT d.party_id, d.firm_id, d.date, d.doc_type, d.id, d.number,
         CASE d.doc_type WHEN 'sale_invoice' THEN 'Sales Invoice' WHEN 'sale_return' THEN 'Sales Return'
                         WHEN 'purchase_invoice' THEN 'Purchase Invoice' ELSE 'Purchase Return' END,
         CASE WHEN d.doc_type IN ('sale_invoice','purchase_return') THEN d.grand_total ELSE 0 END,
         CASE WHEN d.doc_type IN ('sale_return','purchase_invoice') THEN d.grand_total ELSE 0 END, d.project_id, 1
    FROM documents d
   WHERE d.status <> 'cancelled' AND d.party_id IS NOT NULL
     AND d.doc_type IN ('sale_invoice','sale_return','purchase_invoice','purchase_return')
  UNION ALL
  SELECT py.party_id, py.firm_id, py.date, CASE py.direction WHEN 'in' THEN 'receipt' ELSE 'payment' END, py.id, py.number,
         CASE py.direction WHEN 'in' THEN 'Payment received' ELSE 'Payment made' END ||
           CASE WHEN py.reference IS NOT NULL THEN ' (' || py.reference || ')' ELSE '' END,
         CASE WHEN py.direction = 'out' THEN py.amount ELSE 0 END,
         CASE WHEN py.direction = 'in' THEN py.amount ELSE 0 END, py.project_id, 2
    FROM payments py WHERE py.status <> 'cancelled' AND py.party_id IS NOT NULL
  UNION ALL
  SELECT e.party_id, e.firm_id, e.date, 'expense', e.id, e.number, 'Expense bill: ' || ec.name, 0, e.amount, e.project_id, 1
    FROM expenses e JOIN expense_categories ec ON ec.id = e.category_id
   WHERE e.status <> 'cancelled' AND e.party_id IS NOT NULL
  UNION ALL
  SELECT e.party_id, e.firm_id, e.date, 'expense_paid', e.id, e.number, 'Expense paid at billing', e.amount, 0, e.project_id, 2
    FROM expenses e WHERE e.status <> 'cancelled' AND e.party_id IS NOT NULL AND e.paid = 1
  UNION ALL
  SELECT a.party_id, a.firm_id, a.date, 'adjustment', a.id, a.number, COALESCE(a.reason, 'Balance adjustment'),
         CASE WHEN a.direction = 'debit' THEN a.amount ELSE 0 END,
         CASE WHEN a.direction = 'credit' THEN a.amount ELSE 0 END, a.project_id, 3
    FROM party_adjustments a WHERE a.status <> 'cancelled'
`

export function partyBalance(ctx: Ctx, partyId: number, firmId = ctx.firmId, upTo?: string): number {
  const r = ctx.db
    .prepare(
      `SELECT COALESCE(SUM(debit - credit), 0) AS b FROM (${LEDGER_SQL}) l
       WHERE l.party_id = ? AND l.firm_id = ? AND (? IS NULL OR l.date <= ?)`
    )
    .get(partyId, firmId, upTo ?? null, upTo ?? null) as { b: number }
  return round2(r.b)
}

export interface PartyInput {
  id?: number
  type: 'customer' | 'supplier' | 'both'
  name: string
  contactPerson?: string
  phone?: string
  phone2?: string
  email?: string
  address?: string
  city?: string
  cnic?: string
  ntn?: string
  strn?: string
  openingBalance?: number
  openingType?: 'receivable' | 'payable'
  openingDate?: string
  creditLimit?: number
  paymentTermsDays?: number
  notes?: string
  isActive?: boolean
}

function permFor(type: string, action: 'view' | 'manage'): string {
  return type === 'supplier' ? `suppliers.${action}` : `customers.${action}`
}

export function listParties(
  ctx: Ctx,
  f: { type?: 'customer' | 'supplier'; q?: string; active?: 'all' | 'active' | 'inactive'; withBalance?: boolean; onlyDue?: boolean } = {}
): unknown[] {
  if (f.type && !can(ctx, permFor(f.type, 'view'))) {
    // Users who create transactions may pick parties even without full customer/supplier access.
    const pickers = ['sales.create', 'purchases.create', 'quotations.manage', 'projects.manage', 'expenses.manage', 'accounts.manage']
    if (!pickers.some((p) => can(ctx, p))) requirePerm(ctx, permFor(f.type, 'view'))
  }
  const where = [visibleTo('p')]
  const params: Record<string, unknown> = { firmId: ctx.firmId }
  if (f.type === 'customer') where.push("p.type IN ('customer','both')")
  if (f.type === 'supplier') where.push("p.type IN ('supplier','both')")
  if (f.q) {
    where.push("(p.name LIKE @q ESCAPE '\\' OR p.phone LIKE @q ESCAPE '\\' OR p.city LIKE @q ESCAPE '\\' OR p.contact_person LIKE @q ESCAPE '\\')")
    params.q = like(f.q)
  }
  if (f.active !== 'all') where.push(f.active === 'inactive' ? 'p.is_active = 0' : 'p.is_active = 1')
  const balanceJoin = f.withBalance !== false
  const rows = ctx.db
    .prepare(
      `SELECT p.*, ${balanceJoin ? 'COALESCE(b.balance, 0)' : '0'} AS balance, b.last_date
       FROM parties p
       ${balanceJoin ? `LEFT JOIN (SELECT party_id, ROUND(SUM(debit - credit), 2) AS balance, MAX(date) AS last_date
                                  FROM (${LEDGER_SQL}) WHERE firm_id = @firmId GROUP BY party_id) b ON b.party_id = p.id` : ''}
       WHERE ${where.join(' AND ')} ORDER BY p.name LIMIT 5000`
    )
    .all(params) as Array<{ balance: number }>
  return f.onlyDue ? rows.filter((r) => Math.abs(r.balance) > 0.005) : rows
}

export function getParty(ctx: Ctx, id: number): Record<string, unknown> {
  const p = ctx.db.prepare(`SELECT * FROM parties p WHERE p.id = @id AND ${visibleTo('p')}`).get({ id, firmId: ctx.firmId }) as
    | Record<string, unknown>
    | undefined
  if (!p) throw new AppError('Customer/supplier not found.', 'NOT_FOUND')
  requirePerm(ctx, permFor(String(p.type), 'view'))
  const stats = ctx.db
    .prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN doc_type = 'sale_invoice' THEN grand_total END), 0) AS total_sales,
         COALESCE(SUM(CASE WHEN doc_type = 'sale_return' THEN grand_total END), 0) AS total_sale_returns,
         COALESCE(SUM(CASE WHEN doc_type = 'purchase_invoice' THEN grand_total END), 0) AS total_purchases,
         COALESCE(SUM(CASE WHEN doc_type = 'purchase_return' THEN grand_total END), 0) AS total_purchase_returns,
         COUNT(CASE WHEN doc_type IN ('sale_invoice','purchase_invoice') THEN 1 END) AS invoice_count
       FROM documents WHERE party_id = ? AND firm_id = ? AND status <> 'cancelled'`
    )
    .get(id, ctx.firmId)
  return { ...p, balance: partyBalance(ctx, id), stats }
}

export function saveParty(ctx: Ctx, input: PartyInput): number {
  const type = input.type === 'supplier' ? 'supplier' : input.type === 'both' ? 'both' : 'customer'
  requirePerm(ctx, permFor(type === 'both' ? 'customer' : type, 'manage'))
  const db = ctx.db
  const name = requireText(input.name, 'Name', 150)
  const opening = round2(Math.abs(num(input.openingBalance)))
  const signedOpening = input.openingType === 'payable' ? -opening : opening
  const vals = {
    type,
    name,
    contact_person: optText(input.contactPerson, 100),
    phone: optText(input.phone, 40),
    phone2: optText(input.phone2, 40),
    email: optText(input.email, 120),
    address: optText(input.address, 500),
    city: optText(input.city, 80),
    cnic: optText(input.cnic, 20),
    ntn: optText(input.ntn, 30),
    strn: optText(input.strn, 30),
    opening_balance: signedOpening,
    opening_date: optText(input.openingDate, 10),
    credit_limit: round2(num(input.creditLimit)),
    payment_terms_days: Math.max(0, Math.floor(num(input.paymentTermsDays))),
    notes: optText(input.notes, 2000),
    is_active: input.isActive === false ? 0 : 1
  }
  if (input.id) {
    const existing = db.prepare(`SELECT * FROM parties p WHERE id = @id AND ${visibleTo('p')}`).get({ id: input.id, firmId: ctx.firmId }) as
      | { opening_balance: number; opening_firm_id: number | null; name: string }
      | undefined
    if (!existing) throw new AppError('Customer/supplier not found.', 'NOT_FOUND')
    db.prepare(
      `UPDATE parties SET type=@type, name=@name, contact_person=@contact_person, phone=@phone, phone2=@phone2, email=@email,
         address=@address, city=@city, cnic=@cnic, ntn=@ntn, strn=@strn, opening_balance=@opening_balance,
         opening_firm_id=COALESCE(opening_firm_id, @firmId), opening_date=@opening_date, credit_limit=@credit_limit,
         payment_terms_days=@payment_terms_days, notes=@notes, is_active=@is_active, updated_at=datetime('now','localtime')
       WHERE id=@id`
    ).run({ ...vals, id: input.id, firmId: ctx.firmId })
    audit(ctx, 'update', 'party', input.id, `Updated ${type} ${name}`, {
      openingBefore: existing.opening_balance,
      openingAfter: signedOpening
    })
    return input.id
  }
  const shared = getSetting(db, 'share_parties', true)
  const id = Number(
    db
      .prepare(
        `INSERT INTO parties (firm_id, type, name, contact_person, phone, phone2, email, address, city, cnic, ntn, strn,
           opening_balance, opening_firm_id, opening_date, credit_limit, payment_terms_days, notes, is_active, created_by)
         VALUES (@firm_id, @type, @name, @contact_person, @phone, @phone2, @email, @address, @city, @cnic, @ntn, @strn,
           @opening_balance, @firmId, @opening_date, @credit_limit, @payment_terms_days, @notes, @is_active, @created_by)`
      )
      .run({ ...vals, firm_id: shared ? null : ctx.firmId, firmId: ctx.firmId, created_by: ctx.user.id }).lastInsertRowid
  )
  audit(ctx, 'create', 'party', id, `Created ${type} ${name}`)
  return id
}

export interface PartyDependencies {
  documents: number
  payments: number
  expenses: number
  projects: number
  adjustments: number
  /** The party carries an opening balance. */
  openingBalance: boolean
  /** Nothing refers to the party: it may be deleted. */
  deletable: boolean
  /** Plain-words list of what refers to the party ("12 invoices and bills, 5 payments"). */
  summary: string
}

/** Everything that refers to a customer / supplier, so a delete is refused with a clear reason (never silently turned into something else). */
export function partyDependencies(ctx: Ctx, id: number): PartyDependencies {
  const p = getParty(ctx, id)
  const db = ctx.db
  const n = (sql: string): number => (db.prepare(sql).get(id) as { c: number }).c
  const documents = n('SELECT COUNT(*) AS c FROM documents WHERE party_id = ?')
  const payments = n('SELECT COUNT(*) AS c FROM payments WHERE party_id = ?')
  const expenses = n('SELECT COUNT(*) AS c FROM expenses WHERE party_id = ?')
  const projects = n('SELECT COUNT(*) AS c FROM projects WHERE customer_id = ?')
  const adjustments = n('SELECT COUNT(*) AS c FROM party_adjustments WHERE party_id = ?')
  const openingBalance = Number(p.opening_balance) !== 0
  const parts = [
    documents && `${documents} invoice${documents === 1 ? '' : 's'}, bill${documents === 1 ? '' : 's'} or quotation${documents === 1 ? '' : 's'}`,
    payments && `${payments} payment${payments === 1 ? '' : 's'}`,
    expenses && `${expenses} expense${expenses === 1 ? '' : 's'}`,
    projects && `${projects} project${projects === 1 ? '' : 's'}`,
    adjustments && `${adjustments} balance adjustment${adjustments === 1 ? '' : 's'}`,
    openingBalance && 'an opening balance'
  ].filter(Boolean) as string[]
  return { documents, payments, expenses, projects, adjustments, openingBalance, deletable: parts.length === 0, summary: parts.join(', ') }
}

/** Deactivate (hide from new documents, keep every record) or reactivate a customer / supplier. */
export function setPartyActive(ctx: Ctx, id: number, active: boolean): void {
  const p = getParty(ctx, id)
  requirePerm(ctx, permFor(String(p.type) === 'supplier' ? 'supplier' : 'customer', 'manage'))
  ctx.db.prepare("UPDATE parties SET is_active = ?, updated_at = datetime('now','localtime') WHERE id = ?").run(active ? 1 : 0, id)
  audit(ctx, active ? 'reactivate' : 'deactivate', 'party', id, `${active ? 'Reactivated' : 'Deactivated'} ${String(p.name)}`)
}

/** Permanent delete: only when nothing refers to the party. Otherwise it is refused with the reason; deactivate instead. */
export function deleteParty(ctx: Ctx, id: number): { deleted: boolean } {
  const p = getParty(ctx, id)
  requirePerm(ctx, permFor(String(p.type) === 'supplier' ? 'supplier' : 'customer', 'manage'))
  const dep = partyDependencies(ctx, id)
  if (!dep.deletable) {
    throw new AppError(`${String(p.name)} cannot be deleted because it has ${dep.summary}. Deactivate it instead: it is hidden from new documents and all records stay.`, 'VALIDATION')
  }
  ctx.db.prepare('DELETE FROM parties WHERE id = ?').run(id)
  audit(ctx, 'delete', 'party', id, `Deleted ${String(p.name)}`, { snapshot: p })
  return { deleted: true }
}

export interface LedgerRow {
  date: string
  kind: string
  ref_id: number | null
  number: string
  description: string
  debit: number
  credit: number
  balance: number
  project_id: number | null
}

export function partyLedger(
  ctx: Ctx,
  partyId: number,
  f: { from?: string; to?: string; projectId?: number } = {}
): { party: Record<string, unknown>; opening: number; rows: LedgerRow[]; closing: number; totalDebit: number; totalCredit: number } {
  const party = getParty(ctx, partyId)
  const params = { partyId, firmId: ctx.firmId, from: f.from ?? null, to: f.to ?? null, projectId: f.projectId ?? null }
  const opening = f.from
    ? round2(
        (
          ctx.db
            .prepare(
              `SELECT COALESCE(SUM(debit - credit),0) AS b FROM (${LEDGER_SQL}) l
               WHERE l.party_id = @partyId AND l.firm_id = @firmId AND l.date < @from
                 AND (@projectId IS NULL OR l.project_id = @projectId)`
            )
            .get(params) as { b: number }
        ).b
      )
    : 0
  const rows = ctx.db
    .prepare(
      `SELECT * FROM (${LEDGER_SQL}) l
       WHERE l.party_id = @partyId AND l.firm_id = @firmId
         AND (@from IS NULL OR l.date >= @from) AND (@to IS NULL OR l.date <= @to)
         AND (@projectId IS NULL OR l.project_id = @projectId)
       ORDER BY l.date, l.sort, l.ref_id`
    )
    .all(params) as LedgerRow[]
  let bal = opening
  let td = 0
  let tc = 0
  for (const r of rows) {
    r.debit = round2(r.debit)
    r.credit = round2(r.credit)
    td += r.debit
    tc += r.credit
    bal = round2(bal + r.debit - r.credit)
    r.balance = bal
  }
  return { party, opening, rows, closing: bal, totalDebit: round2(td), totalCredit: round2(tc) }
}

/** Receivable / payable aging buckets based on open invoices. */
export function agingReport(ctx: Ctx, side: 'customer' | 'supplier', asOf: string): unknown[] {
  requirePerm(ctx, side === 'customer' ? 'customers.view' : 'suppliers.view')
  const docType = side === 'customer' ? 'sale_invoice' : 'purchase_invoice'
  const rows = ctx.db
    .prepare(
      `SELECT d.id, d.number, d.date, COALESCE(d.due_date, d.date) AS due_date, d.grand_total, d.party_id, p.name AS party_name, p.phone,
         d.grand_total
           - COALESCE((SELECT SUM(a.amount) FROM payment_allocations a JOIN payments py ON py.id = a.payment_id
                        WHERE a.document_id = d.id AND py.status <> 'cancelled'), 0)
           - COALESCE((SELECT SUM(r.grand_total) FROM documents r WHERE r.ref_doc_id = d.id AND r.status <> 'cancelled'
                        AND r.doc_type IN ('sale_return','purchase_return')), 0) AS due
       FROM documents d JOIN parties p ON p.id = d.party_id
       WHERE d.firm_id = @firmId AND d.doc_type = @docType AND d.status <> 'cancelled' AND d.date <= @asOf`
    )
    .all({ firmId: ctx.firmId, docType, asOf }) as Array<{ party_id: number; party_name: string; phone: string; due: number; due_date: string }>
  const byParty = new Map<number, { party_id: number; party_name: string; phone: string; current: number; d30: number; d60: number; d90: number; over90: number; total: number }>()
  const asOfMs = Date.parse(asOf)
  for (const r of rows) {
    if (r.due <= 0.005) continue
    const days = Math.floor((asOfMs - Date.parse(r.due_date)) / 86400000)
    const e = byParty.get(r.party_id) ?? { party_id: r.party_id, party_name: r.party_name, phone: r.phone, current: 0, d30: 0, d60: 0, d90: 0, over90: 0, total: 0 }
    const k = days <= 0 ? 'current' : days <= 30 ? 'd30' : days <= 60 ? 'd60' : days <= 90 ? 'd90' : 'over90'
    e[k] = round2(e[k] + r.due)
    e.total = round2(e.total + r.due)
    byParty.set(r.party_id, e)
  }
  return Array.from(byParty.values()).sort((a, b) => b.total - a.total)
}

/* ---------------------- Journal adjustments (debit / credit notes) ---------------------- */

export function createPartyAdjustment(
  ctx: Ctx,
  input: { date: string; partyId: number; direction: 'debit' | 'credit'; amount: number; reason?: string; projectId?: number | null }
): number {
  requirePerm(ctx, 'accounts.manage')
  getParty(ctx, input.partyId)
  const amount = round2(num(input.amount))
  if (amount <= 0) throw new AppError('Amount must be greater than zero.', 'VALIDATION')
  if (input.direction !== 'debit' && input.direction !== 'credit') throw new AppError('Select debit or credit.', 'VALIDATION')
  const projectId = optId(input.projectId)
  if (projectId && !ctx.db.prepare('SELECT 1 FROM projects WHERE id = ? AND firm_id = ?').get(projectId, ctx.firmId)) {
    throw new AppError('Project does not belong to the active firm.', 'VALIDATION')
  }
  return ctx.db.transaction(() => {
    const number = nextNumber(ctx.db, ctx.firmId, 'party_adjustment')
    const id = Number(
      ctx.db
        .prepare(
          `INSERT INTO party_adjustments (firm_id, number, date, party_id, direction, amount, reason, project_id, created_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(ctx.firmId, number, requireDate(input.date), input.partyId, input.direction, amount, optText(input.reason, 300), projectId, ctx.user.id)
        .lastInsertRowid
    )
    audit(ctx, 'create', 'party_adjustment', id, `${input.direction === 'debit' ? 'Debit' : 'Credit'} adjustment ${number} of ${amount}`)
    return id
  })()
}

export function listPartyAdjustments(ctx: Ctx, f: { partyId?: number } = {}): unknown[] {
  requirePerm(ctx, 'accounts.view')
  return ctx.db
    .prepare(
      `SELECT a.*, p.name AS party_name, u.full_name AS created_by_name FROM party_adjustments a JOIN parties p ON p.id = a.party_id
       LEFT JOIN users u ON u.id = a.created_by
       WHERE a.firm_id = @firmId AND (@partyId IS NULL OR a.party_id = @partyId) ORDER BY a.date DESC, a.id DESC LIMIT 1000`
    )
    .all({ firmId: ctx.firmId, partyId: f.partyId ?? null })
}

export function cancelPartyAdjustment(ctx: Ctx, id: number): void {
  requirePerm(ctx, 'accounts.manage')
  const r = ctx.db.prepare("UPDATE party_adjustments SET status = 'cancelled', cancelled_by = ?, cancelled_at = datetime('now','localtime') WHERE id = ? AND firm_id = ? AND status <> 'cancelled'").run(ctx.user.id, id, ctx.firmId)
  if (!r.changes) throw new AppError('Adjustment not found or already cancelled.', 'NOT_FOUND')
  audit(ctx, 'cancel', 'party_adjustment', id, 'Cancelled party adjustment')
}
