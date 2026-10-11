/**
 * Cash / bank accounts, receipts, payments, allocations and transfers.
 *
 * - A payment is money moving IN (receipt) or OUT (payment) of a cash/bank account.
 * - Allocations link a payment to the invoices / bills / expenses it settles. The unallocated
 *   remainder of a payment is an advance (on-account) and can be applied later.
 * - Revenue and cost are NEVER derived from payments; payments only settle balances.
 */
import type { DB } from '../db'
import { EPS, num, round2 } from '../../shared/money'
import { PAYMENT_METHODS } from '../../shared/docTypes'
import { AppError, Ctx, audit, optId, optText, requireDate, requirePerm, requireText } from './context'
import { nextNumber } from './firms'
import { partyBalance } from './parties'

/* ------------------------------ Accounts ------------------------------ */

export const ACCOUNT_BALANCE_SQL = `
  a.opening_balance
  + COALESCE((SELECT SUM(CASE WHEN p.direction = 'in' THEN p.amount ELSE -p.amount END) FROM payments p
              WHERE p.account_id = a.id AND p.status <> 'cancelled' AND (@asOf IS NULL OR p.date <= @asOf)), 0)
  - COALESCE((SELECT SUM(e.amount) FROM expenses e WHERE e.account_id = a.id AND e.paid = 1 AND e.status <> 'cancelled'
              AND (@asOf IS NULL OR e.date <= @asOf)), 0)
  + COALESCE((SELECT SUM(t.amount) FROM account_transfers t WHERE t.to_account_id = a.id AND t.status <> 'cancelled'
              AND (@asOf IS NULL OR t.date <= @asOf)), 0)
  - COALESCE((SELECT SUM(t.amount) FROM account_transfers t WHERE t.from_account_id = a.id AND t.status <> 'cancelled'
              AND (@asOf IS NULL OR t.date <= @asOf)), 0)`

export function listAccounts(ctx: Ctx, f: { includeInactive?: boolean; firmId?: number } = {}): unknown[] {
  const rows = ctx.db
    .prepare(
      `SELECT a.*, ROUND(${ACCOUNT_BALANCE_SQL}, 2) AS balance FROM accounts a
       WHERE a.firm_id = @firmId ${f.includeInactive ? '' : 'AND a.is_active = 1'}
       ORDER BY a.is_default DESC, a.type, a.name`
    )
    .all({ firmId: f.firmId ?? ctx.firmId, asOf: null })
  return rows
}

export function accountBalance(db: DB, accountId: number, asOf?: string): number {
  const r = db.prepare(`SELECT ROUND(${ACCOUNT_BALANCE_SQL}, 2) AS b FROM accounts a WHERE a.id = @id`).get({ id: accountId, asOf: asOf ?? null }) as
    | { b: number }
    | undefined
  return r?.b ?? 0
}

export function assertAccount(ctx: Ctx, accountId: unknown): number {
  const id = optId(accountId)
  if (!id) throw new AppError('Select a cash / bank account.', 'VALIDATION')
  const a = ctx.db.prepare('SELECT id, is_active FROM accounts WHERE id = ? AND firm_id = ?').get(id, ctx.firmId) as
    | { id: number; is_active: number }
    | undefined
  if (!a) throw new AppError('The selected account does not belong to the active firm.', 'VALIDATION')
  if (!a.is_active) throw new AppError('The selected account is inactive.', 'VALIDATION')
  return id
}

export function saveAccount(
  ctx: Ctx,
  input: { id?: number; name: string; type: string; bankName?: string; accountTitle?: string; accountNo?: string; iban?: string; openingBalance?: number; isActive?: boolean; isDefault?: boolean }
): number {
  requirePerm(ctx, 'accounts.manage')
  const name = requireText(input.name, 'Account name', 80)
  const type = ['cash', 'bank', 'wallet'].includes(input.type) ? input.type : 'cash'
  const vals = {
    name,
    type,
    bank_name: optText(input.bankName, 80),
    account_title: optText(input.accountTitle, 120),
    account_no: optText(input.accountNo, 60),
    iban: optText(input.iban, 40),
    opening_balance: round2(num(input.openingBalance)),
    is_active: input.isActive === false ? 0 : 1
  }
  return ctx.db.transaction(() => {
    let id = input.id ?? 0
    if (id) {
      const a = ctx.db.prepare('SELECT * FROM accounts WHERE id = ? AND firm_id = ?').get(id, ctx.firmId) as
        | { opening_balance: number; is_default: number }
        | undefined
      if (!a) throw new AppError('Account not found.', 'NOT_FOUND')
      if (a.is_default && !vals.is_active) throw new AppError('The default account cannot be deactivated.', 'VALIDATION')
      ctx.db
        .prepare(
          `UPDATE accounts SET name=@name, type=@type, bank_name=@bank_name, account_title=@account_title, account_no=@account_no,
             iban=@iban, opening_balance=@opening_balance, is_active=@is_active WHERE id=@id`
        )
        .run({ ...vals, id })
      audit(ctx, 'update', 'account', id, `Updated account ${name}`, { openingBefore: a.opening_balance, openingAfter: vals.opening_balance })
    } else {
      id = Number(
        ctx.db
          .prepare(
            `INSERT INTO accounts (firm_id, name, type, bank_name, account_title, account_no, iban, opening_balance, is_active)
             VALUES (@firm_id, @name, @type, @bank_name, @account_title, @account_no, @iban, @opening_balance, @is_active)`
          )
          .run({ ...vals, firm_id: ctx.firmId }).lastInsertRowid
      )
      audit(ctx, 'create', 'account', id, `Created account ${name}`)
    }
    if (input.isDefault) {
      ctx.db.prepare('UPDATE accounts SET is_default = CASE WHEN id = ? THEN 1 ELSE 0 END WHERE firm_id = ?').run(id, ctx.firmId)
    }
    return id
  })()
}

export function defaultAccountId(ctx: Ctx): number | null {
  const a = ctx.db
    .prepare('SELECT id FROM accounts WHERE firm_id = ? AND is_active = 1 ORDER BY is_default DESC, id LIMIT 1')
    .get(ctx.firmId) as { id: number } | undefined
  return a?.id ?? null
}

/** Cash / bank book with running balance. */
export function accountLedger(ctx: Ctx, accountId: number, f: { from?: string; to?: string }): unknown {
  requirePerm(ctx, 'accounts.view')
  const acc = ctx.db.prepare('SELECT * FROM accounts WHERE id = ? AND firm_id = ?').get(accountId, ctx.firmId) as
    | Record<string, unknown>
    | undefined
  if (!acc) throw new AppError('Account not found.', 'NOT_FOUND')
  const opening = f.from
    ? accountBalance(ctx.db, accountId, new Date(Date.parse(f.from) - 86400000).toISOString().slice(0, 10))
    : Number(acc.opening_balance)
  const rows = ctx.db
    .prepare(
      `SELECT * FROM (
         SELECT p.date, p.id AS ref_id, p.number, CASE p.direction WHEN 'in' THEN 'receipt' ELSE 'payment' END AS kind,
                COALESCE(pa.name, 'General') || CASE WHEN p.notes IS NOT NULL THEN ' — ' || p.notes ELSE '' END AS description,
                CASE WHEN p.direction = 'in' THEN p.amount ELSE 0 END AS money_in,
                CASE WHEN p.direction = 'out' THEN p.amount ELSE 0 END AS money_out, p.created_at
           FROM payments p LEFT JOIN parties pa ON pa.id = p.party_id
          WHERE p.account_id = @id AND p.status <> 'cancelled'
         UNION ALL
         SELECT e.date, e.id, e.number, 'expense', ec.name || COALESCE(' — ' || e.payee_name, '') || COALESCE(' — ' || e.notes, ''),
                0, e.amount, e.created_at
           FROM expenses e JOIN expense_categories ec ON ec.id = e.category_id
          WHERE e.account_id = @id AND e.paid = 1 AND e.status <> 'cancelled'
         UNION ALL
         SELECT t.date, t.id, t.number, 'transfer_in', 'Transfer from ' || fa.name || COALESCE(' — ' || t.notes, ''), t.amount, 0, t.created_at
           FROM account_transfers t JOIN accounts fa ON fa.id = t.from_account_id
          WHERE t.to_account_id = @id AND t.status <> 'cancelled'
         UNION ALL
         SELECT t.date, t.id, t.number, 'transfer_out', 'Transfer to ' || ta.name || COALESCE(' — ' || t.notes, ''), 0, t.amount, t.created_at
           FROM account_transfers t JOIN accounts ta ON ta.id = t.to_account_id
          WHERE t.from_account_id = @id AND t.status <> 'cancelled'
       ) x WHERE (@from IS NULL OR x.date >= @from) AND (@to IS NULL OR x.date <= @to)
       ORDER BY x.date, x.created_at`
    )
    .all({ id: accountId, from: f.from ?? null, to: f.to ?? null }) as Array<{ money_in: number; money_out: number; balance?: number }>
  let bal = opening
  let tin = 0
  let tout = 0
  for (const r of rows) {
    tin += r.money_in
    tout += r.money_out
    bal = round2(bal + r.money_in - r.money_out)
    r.balance = bal
  }
  return { account: acc, opening: round2(opening), rows, closing: round2(bal), totalIn: round2(tin), totalOut: round2(tout) }
}

/* ------------------------------ Allocations ------------------------------ */

export function docAllocated(db: DB, documentId: number): number {
  const r = db
    .prepare(
      `SELECT COALESCE(SUM(a.amount),0) AS s FROM payment_allocations a JOIN payments p ON p.id = a.payment_id
       WHERE a.document_id = ? AND p.status <> 'cancelled'`
    )
    .get(documentId) as { s: number }
  return round2(r.s)
}

export function docReturned(db: DB, documentId: number): number {
  const r = db
    .prepare(
      `SELECT COALESCE(SUM(grand_total),0) AS s FROM documents WHERE ref_doc_id = ? AND status <> 'cancelled'
       AND doc_type IN ('sale_return','purchase_return')`
    )
    .get(documentId) as { s: number }
  return round2(r.s)
}

/**
 * Amount still outstanding on an invoice / bill / return document.
 * - Invoices/bills: total − payments allocated − returns against it (can be negative when goods were returned
 *   after payment; callers treat negatives as 0 and the matching return then shows the refund owed).
 * - Returns against an invoice: the part of the return that reduced that invoice's unpaid balance is already
 *   settled ("absorbed"); only the remainder is a refund owed, less refunds already allocated.
 */
export function docDue(db: DB, documentId: number): number {
  const d = db.prepare('SELECT id, grand_total, doc_type, status, ref_doc_id FROM documents WHERE id = ?').get(documentId) as
    | { id: number; grand_total: number; doc_type: string; status: string; ref_doc_id: number | null }
    | undefined
  if (!d || d.status === 'cancelled') return 0
  if (d.doc_type === 'sale_invoice' || d.doc_type === 'purchase_invoice') {
    return round2(d.grand_total - docAllocated(db, documentId) - docReturned(db, documentId))
  }
  let absorbed = 0
  if ((d.doc_type === 'sale_return' || d.doc_type === 'purchase_return') && d.ref_doc_id) {
    const inv = db.prepare("SELECT id, grand_total FROM documents WHERE id = ? AND status <> 'cancelled'").get(d.ref_doc_id) as
      | { id: number; grand_total: number }
      | undefined
    if (inv) {
      let left = Math.max(0, round2(inv.grand_total - docAllocated(db, inv.id)))
      const rets = db
        .prepare("SELECT id, grand_total FROM documents WHERE ref_doc_id = ? AND doc_type = ? AND status <> 'cancelled' ORDER BY id")
        .all(inv.id, d.doc_type) as Array<{ id: number; grand_total: number }>
      for (const r of rets) {
        const a = Math.min(left, r.grand_total)
        if (r.id === d.id) {
          absorbed = a
          break
        }
        left = round2(left - a)
      }
    }
  }
  return round2(d.grand_total - absorbed - docAllocated(db, documentId))
}

export function expenseAllocated(db: DB, expenseId: number): number {
  const r = db
    .prepare(
      `SELECT COALESCE(SUM(a.amount),0) AS s FROM payment_allocations a JOIN payments p ON p.id = a.payment_id
       WHERE a.expense_id = ? AND p.status <> 'cancelled'`
    )
    .get(expenseId) as { s: number }
  return round2(r.s)
}

export function expenseDue(db: DB, expenseId: number): number {
  const e = db.prepare('SELECT amount, paid, status, party_id FROM expenses WHERE id = ?').get(expenseId) as
    | { amount: number; paid: number; status: string; party_id: number | null }
    | undefined
  if (!e || e.status === 'cancelled' || e.paid) return 0
  return round2(e.amount - expenseAllocated(db, expenseId))
}

export function paymentUnallocated(db: DB, paymentId: number): number {
  const p = db.prepare('SELECT amount, status FROM payments WHERE id = ?').get(paymentId) as { amount: number; status: string } | undefined
  if (!p || p.status === 'cancelled') return 0
  const r = db.prepare('SELECT COALESCE(SUM(amount),0) AS s FROM payment_allocations WHERE payment_id = ?').get(paymentId) as { s: number }
  return round2(p.amount - r.s)
}

/** Which direction of payment settles which document type. */
function settlingDirection(docType: string): 'in' | 'out' {
  // Customer pays us for invoices (in); we refund credit notes (out); we pay suppliers (out); suppliers refund debit notes (in).
  return docType === 'sale_invoice' || docType === 'purchase_return' ? 'in' : 'out'
}

/** Applies a party's unallocated payments (advances) to a document, oldest first. Returns amount applied. */
export function applyAdvances(ctx: Ctx, documentId: number): number {
  const db = ctx.db
  const d = db.prepare('SELECT * FROM documents WHERE id = ? AND firm_id = ?').get(documentId, ctx.firmId) as
    | { id: number; party_id: number | null; doc_type: string; project_id: number | null; status: string }
    | undefined
  if (!d || !d.party_id || d.status === 'cancelled') return 0
  let due = docDue(db, documentId)
  if (due <= EPS) return 0
  const dir = settlingDirection(d.doc_type)
  const pays = db
    .prepare(
      `SELECT p.id, p.amount - COALESCE((SELECT SUM(a.amount) FROM payment_allocations a WHERE a.payment_id = p.id), 0) AS free
       FROM payments p WHERE p.firm_id = @firmId AND p.party_id = @partyId AND p.direction = @dir AND p.status <> 'cancelled'
         AND (@projectId IS NULL OR p.project_id IS NULL OR p.project_id = @projectId)
       ORDER BY (p.project_id IS NOT NULL AND p.project_id = @projectId) DESC, p.date, p.id`
    )
    .all({ firmId: ctx.firmId, partyId: d.party_id, dir, projectId: d.project_id }) as Array<{ id: number; free: number }>
  let applied = 0
  for (const p of pays) {
    if (due <= EPS) break
    const free = round2(p.free)
    if (free <= EPS) continue
    const amt = round2(Math.min(free, due))
    db.prepare('INSERT INTO payment_allocations (payment_id, document_id, amount) VALUES (?, ?, ?)').run(p.id, documentId, amt)
    due = round2(due - amt)
    applied = round2(applied + amt)
  }
  if (applied > 0) audit(ctx, 'allocate', 'document', documentId, `Applied advance ${applied} to document`)
  return applied
}

/* ------------------------------ Payments ------------------------------ */

export interface PaymentInput {
  id?: number
  date: string
  direction: 'in' | 'out'
  partyId?: number | null
  accountId: number
  amount: number
  method?: string
  reference?: string
  projectId?: number | null
  notes?: string
  /** Explicit allocations; if omitted and autoAllocate is true, oldest open documents are settled first. */
  allocations?: Array<{ documentId?: number; expenseId?: number; amount: number }>
  autoAllocate?: boolean
}

/** Low-level insert used by documents (payment at billing) and by the payment screen. Caller holds the transaction. */
export function insertPayment(ctx: Ctx, input: PaymentInput): number {
  const db = ctx.db
  const date = requireDate(input.date)
  const amount = round2(num(input.amount))
  if (amount <= 0) throw new AppError('Payment amount must be greater than zero.', 'VALIDATION')
  const accountId = assertAccount(ctx, input.accountId)
  const method = PAYMENT_METHODS.includes(input.method as (typeof PAYMENT_METHODS)[number]) ? input.method! : 'cash'
  const partyId = optId(input.partyId)
  if (partyId) {
    const ok = db.prepare('SELECT id FROM parties WHERE id = ? AND (firm_id IS NULL OR firm_id = ?)').get(partyId, ctx.firmId)
    if (!ok) throw new AppError('Customer/supplier is not available in this firm.', 'VALIDATION')
  }
  const projectId = optId(input.projectId)
  if (projectId) {
    const pr = db.prepare('SELECT id FROM projects WHERE id = ? AND firm_id = ?').get(projectId, ctx.firmId)
    if (!pr) throw new AppError('Project does not belong to the active firm.', 'VALIDATION')
  }
  if (input.direction === 'out' && !partyId && !input.notes) {
    throw new AppError('Enter a note describing this payment (or select a supplier).', 'VALIDATION')
  }
  const number = nextNumber(db, ctx.firmId, input.direction === 'in' ? 'receipt' : 'payment')
  const id = Number(
    db
      .prepare(
        `INSERT INTO payments (firm_id, number, date, direction, party_id, account_id, amount, method, reference, project_id, notes, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        ctx.firmId,
        number,
        date,
        input.direction,
        partyId,
        accountId,
        amount,
        method,
        optText(input.reference, 100),
        projectId,
        optText(input.notes, 500),
        ctx.user.id
      ).lastInsertRowid
  )
  let remaining = amount
  const allocate = (target: { documentId?: number; expenseId?: number }, amt: number): void => {
    const a = round2(amt)
    if (a <= EPS) return
    if (a > remaining + EPS) throw new AppError('Allocated amount is more than the payment amount.', 'VALIDATION')
    if (target.documentId) {
      const d = db.prepare('SELECT * FROM documents WHERE id = ? AND firm_id = ?').get(target.documentId, ctx.firmId) as
        | { party_id: number | null; doc_type: string; number: string; status: string }
        | undefined
      if (!d || d.status === 'cancelled') throw new AppError('Document to settle was not found.', 'VALIDATION')
      if (!['sale_invoice', 'sale_return', 'purchase_invoice', 'purchase_return'].includes(d.doc_type)) {
        throw new AppError('Only invoices, bills and returns can be settled.', 'VALIDATION')
      }
      if (settlingDirection(d.doc_type) !== input.direction) throw new AppError(`Payment direction does not match ${d.number}.`, 'VALIDATION')
      if (d.party_id !== partyId) throw new AppError(`${d.number} belongs to a different party.`, 'VALIDATION')
      const due = docDue(db, target.documentId)
      if (a > due + EPS) throw new AppError(`Amount for ${d.number} is more than its outstanding balance (${due}).`, 'VALIDATION')
      db.prepare('INSERT INTO payment_allocations (payment_id, document_id, amount) VALUES (?, ?, ?)').run(id, target.documentId, a)
    } else if (target.expenseId) {
      const e = db.prepare('SELECT * FROM expenses WHERE id = ? AND firm_id = ?').get(target.expenseId, ctx.firmId) as
        | { party_id: number | null; number: string }
        | undefined
      if (!e) throw new AppError('Expense to settle was not found.', 'VALIDATION')
      if (input.direction !== 'out' || e.party_id !== partyId) throw new AppError(`Payment does not match expense ${e.number}.`, 'VALIDATION')
      const due = expenseDue(db, target.expenseId)
      if (a > due + EPS) throw new AppError(`Amount for ${e.number} is more than its outstanding balance (${due}).`, 'VALIDATION')
      db.prepare('INSERT INTO payment_allocations (payment_id, expense_id, amount) VALUES (?, ?, ?)').run(id, target.expenseId, a)
    }
    remaining = round2(remaining - a)
  }
  if (input.allocations && input.allocations.length) {
    for (const al of input.allocations) allocate(al, num(al.amount))
  } else if (input.autoAllocate && partyId) {
    const docTypes = input.direction === 'in' ? ['sale_invoice', 'purchase_return'] : ['purchase_invoice', 'sale_return']
    const open = db
      .prepare(
        `SELECT id FROM documents WHERE firm_id = @firmId AND party_id = @partyId AND status <> 'cancelled'
           AND doc_type IN (${docTypes.map((t) => `'${t}'`).join(',')})
           AND (@projectId IS NULL OR project_id = @projectId)
         ORDER BY date, id`
      )
      .all({ firmId: ctx.firmId, partyId, projectId }) as Array<{ id: number }>
    for (const d of open) {
      if (remaining <= EPS) break
      const due = docDue(db, d.id)
      if (due > EPS) allocate({ documentId: d.id }, Math.min(due, remaining))
    }
    if (input.direction === 'out' && remaining > EPS) {
      const exps = db
        .prepare(
          `SELECT id FROM expenses WHERE firm_id = ? AND party_id = ? AND paid = 0 AND status <> 'cancelled' ORDER BY date, id`
        )
        .all(ctx.firmId, partyId) as Array<{ id: number }>
      for (const e of exps) {
        if (remaining <= EPS) break
        const due = expenseDue(db, e.id)
        if (due > EPS) allocate({ expenseId: e.id }, Math.min(due, remaining))
      }
    }
  }
  return id
}

export function createPayment(ctx: Ctx, input: PaymentInput): number {
  requirePerm(ctx, 'accounts.manage')
  return ctx.db.transaction(() => {
    const id = insertPayment(ctx, input)
    const p = ctx.db.prepare('SELECT number, amount FROM payments WHERE id = ?').get(id) as { number: string; amount: number }
    audit(ctx, 'create', 'payment', id, `${input.direction === 'in' ? 'Receipt' : 'Payment'} ${p.number} of ${p.amount}`, input)
    return id
  })()
}

export function cancelPayment(ctx: Ctx, id: number, reason?: string): void {
  requirePerm(ctx, 'accounts.manage')
  const db = ctx.db
  const p = db.prepare('SELECT * FROM payments WHERE id = ? AND firm_id = ?').get(id, ctx.firmId) as
    | { number: string; status: string; amount: number }
    | undefined
  if (!p) throw new AppError('Payment not found.', 'NOT_FOUND')
  if (p.status === 'cancelled') throw new AppError('Payment is already cancelled.', 'VALIDATION')
  db.transaction(() => {
    const allocs = db.prepare('SELECT * FROM payment_allocations WHERE payment_id = ?').all(id)
    db.prepare(
      "UPDATE payments SET status = 'cancelled', cancelled_by = ?, cancelled_at = datetime('now','localtime'), cancel_reason = ? WHERE id = ?"
    ).run(ctx.user.id, optText(reason, 300), id)
    db.prepare('DELETE FROM payment_allocations WHERE payment_id = ?').run(id)
    audit(ctx, 'cancel', 'payment', id, `Cancelled ${p.number} (${p.amount})`, { reason, allocations: allocs })
  })()
}

export function listPayments(
  ctx: Ctx,
  f: { direction?: 'in' | 'out'; from?: string; to?: string; partyId?: number; projectId?: number; accountId?: number; q?: string; includeCancelled?: boolean } = {}
): unknown[] {
  requirePerm(ctx, 'accounts.view')
  return ctx.db
    .prepare(
      `SELECT p.*, pa.name AS party_name, pa.type AS party_type, a.name AS account_name, pr.name AS project_name, u.full_name AS created_by_name,
         ROUND(p.amount - COALESCE((SELECT SUM(x.amount) FROM payment_allocations x WHERE x.payment_id = p.id), 0), 2) AS unallocated
       FROM payments p LEFT JOIN parties pa ON pa.id = p.party_id JOIN accounts a ON a.id = p.account_id
       LEFT JOIN projects pr ON pr.id = p.project_id LEFT JOIN users u ON u.id = p.created_by
       WHERE p.firm_id = @firmId AND (@dir IS NULL OR p.direction = @dir)
         AND (@from IS NULL OR p.date >= @from) AND (@to IS NULL OR p.date <= @to)
         AND (@partyId IS NULL OR p.party_id = @partyId) AND (@projectId IS NULL OR p.project_id = @projectId)
         AND (@accountId IS NULL OR p.account_id = @accountId)
         AND (@q IS NULL OR p.number LIKE @q OR pa.name LIKE @q OR p.reference LIKE @q OR p.notes LIKE @q)
         AND (@inclCancelled = 1 OR p.status <> 'cancelled')
       ORDER BY p.date DESC, p.id DESC LIMIT 2000`
    )
    .all({
      firmId: ctx.firmId,
      dir: f.direction ?? null,
      from: f.from ?? null,
      to: f.to ?? null,
      partyId: f.partyId ?? null,
      projectId: f.projectId ?? null,
      accountId: f.accountId ?? null,
      q: f.q ? `%${f.q}%` : null,
      inclCancelled: f.includeCancelled ? 1 : 0
    })
}

export function getPayment(ctx: Ctx, id: number): Record<string, unknown> {
  requirePerm(ctx, 'accounts.view')
  const p = ctx.db
    .prepare(
      `SELECT p.*, pa.name AS party_name, pa.phone AS party_phone, pa.address AS party_address, pa.type AS party_type,
         a.name AS account_name, a.type AS account_type, pr.name AS project_name, pr.code AS project_code, u.full_name AS created_by_name
       FROM payments p LEFT JOIN parties pa ON pa.id = p.party_id JOIN accounts a ON a.id = p.account_id
       LEFT JOIN projects pr ON pr.id = p.project_id LEFT JOIN users u ON u.id = p.created_by
       WHERE p.id = ? AND p.firm_id = ?`
    )
    .get(id, ctx.firmId) as Record<string, unknown> | undefined
  if (!p) throw new AppError('Payment not found.', 'NOT_FOUND')
  const allocations = ctx.db
    .prepare(
      `SELECT a.*, d.number AS document_number, d.doc_type, d.date AS document_date, d.grand_total AS document_total,
         e.number AS expense_number
       FROM payment_allocations a LEFT JOIN documents d ON d.id = a.document_id LEFT JOIN expenses e ON e.id = a.expense_id
       WHERE a.payment_id = ?`
    )
    .all(id)
  const balance = p.party_id ? partyBalance(ctx, Number(p.party_id)) : null
  return { ...p, allocations, unallocated: paymentUnallocated(ctx.db, id), party_balance: balance }
}

/** Open documents & expenses that a payment to/from this party could settle. */
export function openItemsForParty(ctx: Ctx, partyId: number, direction: 'in' | 'out'): unknown[] {
  requirePerm(ctx, 'accounts.view')
  const docTypes = direction === 'in' ? ['sale_invoice', 'purchase_return'] : ['purchase_invoice', 'sale_return']
  const docs = ctx.db
    .prepare(
      `SELECT d.id, d.doc_type, d.number, d.date, d.due_date, d.grand_total, d.project_id, pr.name AS project_name
       FROM documents d LEFT JOIN projects pr ON pr.id = d.project_id
       WHERE d.firm_id = ? AND d.party_id = ? AND d.status <> 'cancelled'
         AND d.doc_type IN (${docTypes.map((t) => `'${t}'`).join(',')}) ORDER BY d.date, d.id`
    )
    .all(ctx.firmId, partyId) as Array<{ id: number; due?: number }>
  const out: unknown[] = []
  for (const d of docs) {
    const due = docDue(ctx.db, d.id)
    if (due > EPS) out.push({ ...d, kind: 'document', due })
  }
  if (direction === 'out') {
    const exps = ctx.db
      .prepare(
        `SELECT e.id, e.number, e.date, e.amount AS grand_total, ec.name AS category_name, e.project_id
         FROM expenses e JOIN expense_categories ec ON ec.id = e.category_id
         WHERE e.firm_id = ? AND e.party_id = ? AND e.paid = 0 AND e.status <> 'cancelled' ORDER BY e.date, e.id`
      )
      .all(ctx.firmId, partyId) as Array<{ id: number }>
    for (const e of exps) {
      const due = expenseDue(ctx.db, e.id)
      if (due > EPS) out.push({ ...e, kind: 'expense', doc_type: 'expense', due })
    }
  }
  return out
}

/* ------------------------------ Transfers ------------------------------ */

export function createTransfer(
  ctx: Ctx,
  input: { date: string; fromAccountId: number; toAccountId: number; amount: number; notes?: string }
): number {
  requirePerm(ctx, 'accounts.manage')
  const date = requireDate(input.date)
  const from = assertAccount(ctx, input.fromAccountId)
  const to = assertAccount(ctx, input.toAccountId)
  if (from === to) throw new AppError('Select two different accounts.', 'VALIDATION')
  const amount = round2(num(input.amount))
  if (amount <= 0) throw new AppError('Amount must be greater than zero.', 'VALIDATION')
  return ctx.db.transaction(() => {
    const number = nextNumber(ctx.db, ctx.firmId, 'transfer')
    const id = Number(
      ctx.db
        .prepare(
          `INSERT INTO account_transfers (firm_id, number, date, from_account_id, to_account_id, amount, notes, created_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(ctx.firmId, number, date, from, to, amount, optText(input.notes, 300), ctx.user.id).lastInsertRowid
    )
    audit(ctx, 'create', 'transfer', id, `Transfer ${number} of ${amount}`)
    return id
  })()
}

export function listTransfers(ctx: Ctx, f: { from?: string; to?: string } = {}): unknown[] {
  requirePerm(ctx, 'accounts.view')
  return ctx.db
    .prepare(
      `SELECT t.*, fa.name AS from_name, ta.name AS to_name FROM account_transfers t
       JOIN accounts fa ON fa.id = t.from_account_id JOIN accounts ta ON ta.id = t.to_account_id
       WHERE t.firm_id = @firmId AND (@from IS NULL OR t.date >= @from) AND (@to IS NULL OR t.date <= @to)
       ORDER BY t.date DESC, t.id DESC LIMIT 1000`
    )
    .all({ firmId: ctx.firmId, from: f.from ?? null, to: f.to ?? null })
}

export function cancelTransfer(ctx: Ctx, id: number): void {
  requirePerm(ctx, 'accounts.manage')
  const r = ctx.db
    .prepare(
      "UPDATE account_transfers SET status = 'cancelled', cancelled_by = ?, cancelled_at = datetime('now','localtime') WHERE id = ? AND firm_id = ? AND status <> 'cancelled'"
    )
    .run(ctx.user.id, id, ctx.firmId)
  if (!r.changes) throw new AppError('Transfer not found or already cancelled.', 'NOT_FOUND')
  audit(ctx, 'cancel', 'transfer', id, 'Cancelled account transfer')
}
