/**
 * Cheque register: cheques received from customers (often post-dated) and cheques issued to suppliers.
 * A cheque is only a promise until it clears: nothing is booked when it is recorded or deposited. Clearing books the payment
 * (receipt or voucher, method cheque) and settles the linked invoice or the oldest open ones; a cheque that bounces after it
 * was cleared cancels that payment again. The module is switched on in Settings, Simple / Customize.
 */
import { EPS, num, round2 } from '../../shared/money'
import { AppError, Ctx, audit, optId, optText, requireDate, requirePerm, requireText, today } from './context'
import { assertAccount, docDue, insertPayment, voidPayment } from './payments'
import { assertModule } from './moduleGate'

export const CHEQUE_STATUSES = ['pending', 'deposited', 'cleared', 'bounced', 'cancelled'] as const

interface ChequeRow {
  id: number
  firm_id: number
  direction: 'received' | 'issued'
  cheque_no: string
  bank: string | null
  party_id: number | null
  amount: number
  cheque_date: string
  received_date: string | null
  status: string
  account_id: number | null
  payment_id: number | null
  document_id: number | null
  notes: string | null
}

export interface ChequeInput {
  id?: number
  direction: string
  chequeNo: string
  bank?: string
  partyId?: number | null
  amount: number
  chequeDate: string
  receivedDate?: string | null
  accountId?: number | null
  documentId?: number | null
  notes?: string
}

const gate = (ctx: Ctx, perm: string): void => {
  assertModule(ctx, 'cheques')
  requirePerm(ctx, perm)
}

function getRow(ctx: Ctx, id: number): ChequeRow {
  const c = ctx.db.prepare('SELECT * FROM cheques WHERE id = ? AND firm_id = ?').get(id, ctx.firmId) as ChequeRow | undefined
  if (!c) throw new AppError('Cheque not found.', 'NOT_FOUND')
  return c
}

export function listCheques(ctx: Ctx, f: { status?: string; direction?: string; from?: string; to?: string; q?: string } = {}): unknown[] {
  gate(ctx, 'cheques.view')
  const t = today()
  const rows = ctx.db
    .prepare(
      `SELECT c.*, pa.name AS party_name, a.name AS account_name, d.number AS document_number
         FROM cheques c LEFT JOIN parties pa ON pa.id = c.party_id LEFT JOIN accounts a ON a.id = c.account_id LEFT JOIN documents d ON d.id = c.document_id
        WHERE c.firm_id = @firmId AND (@status IS NULL OR c.status = @status) AND (@direction IS NULL OR c.direction = @direction)
          AND (@from IS NULL OR c.cheque_date >= @from) AND (@to IS NULL OR c.cheque_date <= @to)
          AND (@q IS NULL OR c.cheque_no LIKE @q OR c.bank LIKE @q OR pa.name LIKE @q)
        ORDER BY c.cheque_date, c.id`
    )
    .all({ firmId: ctx.firmId, status: f.status || null, direction: f.direction || null, from: f.from || null, to: f.to || null, q: f.q ? `%${f.q}%` : null }) as Array<ChequeRow & Record<string, unknown>>
  return rows.map((r) => ({ ...r, overdue: (r.status === 'pending' || r.status === 'deposited') && r.cheque_date < t }))
}

export function chequeSummary(ctx: Ctx): Record<string, unknown> {
  gate(ctx, 'cheques.view')
  const t = today()
  const week = new Date()
  week.setDate(week.getDate() + 7)
  const p = (n: number): string => String(n).padStart(2, '0')
  const end = `${week.getFullYear()}-${p(week.getMonth() + 1)}-${p(week.getDate())}`
  const one = (sql: string, ...a: unknown[]): { n: number; total: number } => ctx.db.prepare(sql).get(...a) as { n: number; total: number }
  const open = "status IN ('pending','deposited')"
  return {
    receivedOpen: one(`SELECT COUNT(*) AS n, COALESCE(SUM(amount),0) AS total FROM cheques WHERE firm_id = ? AND direction = 'received' AND ${open}`, ctx.firmId),
    issuedOpen: one(`SELECT COUNT(*) AS n, COALESCE(SUM(amount),0) AS total FROM cheques WHERE firm_id = ? AND direction = 'issued' AND ${open}`, ctx.firmId),
    overdue: one(`SELECT COUNT(*) AS n, COALESCE(SUM(amount),0) AS total FROM cheques WHERE firm_id = ? AND ${open} AND cheque_date < ?`, ctx.firmId, t),
    dueThisWeek: one(`SELECT COUNT(*) AS n, COALESCE(SUM(amount),0) AS total FROM cheques WHERE firm_id = ? AND ${open} AND cheque_date >= ? AND cheque_date <= ?`, ctx.firmId, t, end),
    bounced: one("SELECT COUNT(*) AS n, COALESCE(SUM(amount),0) AS total FROM cheques WHERE firm_id = ? AND status = 'bounced'", ctx.firmId)
  }
}

/** Counts for the notification bell. Empty when the module is off or the user may not see cheques. */
export function chequeAlerts(ctx: Ctx): { overdue: number; today: number } {
  try {
    gate(ctx, 'cheques.view')
  } catch {
    return { overdue: 0, today: 0 }
  }
  const t = today()
  const q = (cmp: string): number => (ctx.db.prepare(`SELECT COUNT(*) AS c FROM cheques WHERE firm_id = ? AND status IN ('pending','deposited') AND cheque_date ${cmp} ?`).get(ctx.firmId, t) as { c: number }).c
  return { overdue: q('<'), today: q('=') }
}

export function saveCheque(ctx: Ctx, input: ChequeInput): number {
  gate(ctx, 'cheques.manage')
  const direction = input.direction === 'issued' ? 'issued' : input.direction === 'received' ? 'received' : ''
  if (!direction) throw new AppError('Is this a cheque received or issued?', 'VALIDATION')
  const chequeNo = requireText(input.chequeNo, 'Cheque number', 40)
  const amount = round2(num(input.amount))
  if (amount <= 0) throw new AppError('Enter the cheque amount.', 'VALIDATION')
  const chequeDate = requireDate(input.chequeDate, 'Cheque date')
  const receivedDate = input.receivedDate ? requireDate(input.receivedDate, 'Received date') : null
  const partyId = optId(input.partyId)
  if (partyId) {
    const p = ctx.db.prepare('SELECT type FROM parties WHERE id = ? AND (firm_id IS NULL OR firm_id = ?)').get(partyId, ctx.firmId) as { type: string } | undefined
    if (!p) throw new AppError('The customer or supplier is not available in this firm.', 'VALIDATION')
    if (direction === 'received' && p.type === 'supplier') throw new AppError('A cheque received comes from a customer.', 'VALIDATION')
    if (direction === 'issued' && p.type === 'customer') throw new AppError('A cheque issued goes to a supplier.', 'VALIDATION')
  } else if (direction === 'received' || !optText(input.notes, 500)) {
    throw new AppError(direction === 'received' ? 'Select the customer who gave the cheque.' : 'Select the supplier, or write who the cheque is for in the notes.', 'VALIDATION')
  }
  const accountId = optId(input.accountId) ? assertAccount(ctx, input.accountId) : null
  const documentId = optId(input.documentId)
  if (documentId) {
    const d = ctx.db.prepare('SELECT party_id, doc_type FROM documents WHERE id = ? AND firm_id = ?').get(documentId, ctx.firmId) as { party_id: number | null; doc_type: string } | undefined
    const want = direction === 'received' ? 'sale_invoice' : 'purchase_invoice'
    if (!d || d.doc_type !== want || d.party_id !== partyId) throw new AppError('The invoice does not belong to this party.', 'VALIDATION')
  }
  const dup = ctx.db.prepare("SELECT id FROM cheques WHERE firm_id = ? AND direction = ? AND cheque_no = ? AND COALESCE(bank,'') = ? AND status <> 'cancelled' AND id <> ?").get(ctx.firmId, direction, chequeNo, optText(input.bank, 80) ?? '', input.id ?? 0)
  if (dup) throw new AppError(`Cheque ${chequeNo} is already in the register.`, 'VALIDATION')
  const v = { direction, cheque_no: chequeNo, bank: optText(input.bank, 80), party_id: partyId, amount, cheque_date: chequeDate, received_date: receivedDate, account_id: accountId, document_id: documentId, notes: optText(input.notes, 500) }
  if (input.id) {
    const before = getRow(ctx, input.id)
    if (before.status !== 'pending') throw new AppError('Only a pending cheque can be edited.', 'VALIDATION')
    ctx.db.prepare('UPDATE cheques SET direction=@direction, cheque_no=@cheque_no, bank=@bank, party_id=@party_id, amount=@amount, cheque_date=@cheque_date, received_date=@received_date, account_id=@account_id, document_id=@document_id, notes=@notes, updated_at=datetime(\'now\',\'localtime\') WHERE id=@id').run({ ...v, id: input.id })
    audit(ctx, 'update', 'cheque', input.id, `Edited cheque ${chequeNo}`)
    return input.id
  }
  const id = Number(
    ctx.db
      .prepare('INSERT INTO cheques (firm_id, direction, cheque_no, bank, party_id, amount, cheque_date, received_date, account_id, document_id, notes, created_by) VALUES (@firm_id, @direction, @cheque_no, @bank, @party_id, @amount, @cheque_date, @received_date, @account_id, @document_id, @notes, @created_by)')
      .run({ ...v, firm_id: ctx.firmId, created_by: ctx.user.id }).lastInsertRowid
  )
  audit(ctx, 'create', 'cheque', id, `${direction === 'received' ? 'Received' : 'Issued'} cheque ${chequeNo} for ${amount}`)
  return id
}

/** pending to deposited / cleared / bounced / cancelled; deposited to cleared / bounced; cleared to bounced (the bank sent it back). */
export function setChequeStatus(ctx: Ctx, id: number, input: { status: string; accountId?: number | null; date?: string; reason?: string }): void {
  gate(ctx, 'cheques.manage')
  const c = getRow(ctx, id)
  const next = String(input.status)
  if (!(CHEQUE_STATUSES as readonly string[]).includes(next)) throw new AppError('Unknown cheque status.', 'VALIDATION')
  const allowed: Record<string, string[]> = {
    pending: ['deposited', 'cleared', 'bounced', 'cancelled'],
    deposited: ['cleared', 'bounced'],
    cleared: ['bounced'],
    bounced: [],
    cancelled: []
  }
  if (!allowed[c.status].includes(next)) throw new AppError(`A ${c.status} cheque cannot be marked ${next}.`, 'VALIDATION')
  if (next === 'deposited' && c.direction !== 'received') throw new AppError('Only a cheque received can be deposited.', 'VALIDATION')
  const db = ctx.db
  db.transaction(() => {
    if (next === 'deposited') {
      const acc = input.accountId ? assertAccount(ctx, input.accountId) : c.account_id
      db.prepare("UPDATE cheques SET status = 'deposited', account_id = ?, updated_at = datetime('now','localtime') WHERE id = ?").run(acc, id)
    } else if (next === 'cleared') {
      const accountId = assertAccount(ctx, input.accountId ?? c.account_id)
      const date = requireDate(input.date ?? today(), 'Clearing date')
      const direction = c.direction === 'received' ? 'in' : 'out'
      const reference = `Cheque ${c.cheque_no}${c.bank ? ` (${c.bank})` : ''}`
      let allocations: Array<{ documentId: number; amount: number }> | undefined
      if (c.document_id) {
        const due = docDue(db, c.document_id)
        if (due > EPS) allocations = [{ documentId: c.document_id, amount: round2(Math.min(due, c.amount)) }]
      }
      const paymentId = insertPayment(ctx, {
        date,
        direction,
        partyId: c.party_id,
        accountId,
        amount: c.amount,
        method: 'cheque',
        reference,
        notes: `${reference} cleared${c.notes ? `: ${c.notes}` : ''}`,
        allocations,
        autoAllocate: !allocations && !!c.party_id
      })
      db.prepare("UPDATE cheques SET status = 'cleared', account_id = ?, payment_id = ?, cleared_at = ?, updated_at = datetime('now','localtime') WHERE id = ?").run(accountId, paymentId, date, id)
    } else if (next === 'bounced') {
      const reason = optText(input.reason, 200)
      if (c.status === 'cleared' && c.payment_id) voidPayment(ctx, c.payment_id, `Cheque ${c.cheque_no} bounced${reason ? `: ${reason}` : ''}`)
      db.prepare("UPDATE cheques SET status = 'bounced', payment_id = NULL, bounce_reason = ?, updated_at = datetime('now','localtime') WHERE id = ?").run(reason, id)
    } else {
      db.prepare("UPDATE cheques SET status = 'cancelled', updated_at = datetime('now','localtime') WHERE id = ?").run(id)
    }
    audit(ctx, 'status', 'cheque', id, `Cheque ${c.cheque_no} marked ${next}`, { from: c.status, to: next, reason: input.reason })
  })()
}

export function deleteCheque(ctx: Ctx, id: number): void {
  gate(ctx, 'cheques.manage')
  const c = getRow(ctx, id)
  if (c.status === 'cleared' || c.status === 'deposited') throw new AppError('A deposited or cleared cheque cannot be deleted. Mark it bounced or cancelled if it did not go through.', 'VALIDATION')
  ctx.db.prepare('DELETE FROM cheques WHERE id = ?').run(id)
  audit(ctx, 'delete', 'cheque', id, `Deleted cheque ${c.cheque_no}`)
}
