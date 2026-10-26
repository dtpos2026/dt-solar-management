/**
 * After-sales service and warranty tickets: a customer brings a faulty item (or calls), the shop opens a ticket, follows it with
 * calls / visits / notes, and closes it with what was done and any charge. The warranty is checked from the serial number that
 * was sold. The module is switched on in Settings, Simple / Customize.
 */
import { num, round2 } from '../../shared/money'
import { AppError, Ctx, audit, optId, optText, requireDate, requirePerm, requireText, today } from './context'
import { nextNumber } from './firms'
import { assertModule } from './moduleGate'

export const TICKET_STATUSES = ['new', 'in_progress', 'waiting_parts', 'resolved', 'closed'] as const
export const TICKET_PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const
export const ACTIVITY_KINDS = ['call', 'visit', 'whatsapp', 'parts', 'note'] as const

interface TicketRow {
  id: number
  firm_id: number
  number: string
  party_id: number | null
  customer_name: string | null
  phone: string | null
  product_id: number | null
  item_name: string | null
  serial: string | null
  document_id: number | null
  project_id: number | null
  issue: string
  priority: string
  status: string
  under_warranty: number
  assigned_to: number | null
  received_date: string
  promised_date: string | null
  resolved_date: string | null
  charges: number
  resolution: string | null
}

export interface TicketInput {
  id?: number
  partyId?: number | null
  customerName?: string
  phone?: string
  productId?: number | null
  itemName?: string
  serial?: string
  documentId?: number | null
  projectId?: number | null
  issue: string
  priority?: string
  assignedTo?: number | null
  receivedDate?: string
  promisedDate?: string | null
  charges?: number
}

const gate = (ctx: Ctx, perm: string): void => {
  assertModule(ctx, 'service')
  requirePerm(ctx, perm)
}

function getRow(ctx: Ctx, id: number): TicketRow {
  const t = ctx.db.prepare('SELECT * FROM service_tickets WHERE id = ? AND firm_id = ?').get(id, ctx.firmId) as TicketRow | undefined
  if (!t) throw new AppError('Ticket not found.', 'NOT_FOUND')
  return t
}

function addMonths(date: string, months: number): string {
  const d = new Date(`${date}T00:00:00`)
  d.setMonth(d.getMonth() + months)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** Was this serial sold by us, and is it still under warranty? */
export function warrantyCheck(ctx: Ctx, input: { serial: string }): Record<string, unknown> {
  gate(ctx, 'service.view')
  const serial = requireText(input.serial, 'Serial number', 100)
  const r = ctx.db
    .prepare(
      `SELECT s.serial, s.product_id, s.party_id, s.out_date, s.out_ref_id, s.out_ref_type, p.name AS product_name, p.warranty_months,
              pa.name AS party_name, d.number AS document_number, d.id AS document_id
         FROM serials s JOIN products p ON p.id = s.product_id LEFT JOIN parties pa ON pa.id = s.party_id
         LEFT JOIN documents d ON d.id = s.out_ref_id AND d.doc_type = s.out_ref_type AND d.firm_id = @firmId
        WHERE s.serial = @serial AND s.status = 'sold' ORDER BY s.id DESC LIMIT 1`
    )
    .get({ serial, firmId: ctx.firmId }) as
    | { serial: string; product_id: number; party_id: number | null; out_date: string | null; product_name: string; warranty_months: number; party_name: string | null; document_number: string | null; document_id: number | null }
    | undefined
  if (!r) return { found: false, serial }
  const months = r.warranty_months ?? 0
  const expires = r.out_date && months > 0 ? addMonths(r.out_date, months) : null
  return {
    found: true,
    serial: r.serial,
    productId: r.product_id,
    productName: r.product_name,
    partyId: r.party_id,
    partyName: r.party_name,
    documentId: r.document_id,
    documentNumber: r.document_number,
    soldDate: r.out_date,
    warrantyMonths: months,
    expires,
    underWarranty: !!expires && expires >= today()
  }
}

export function saveTicket(ctx: Ctx, input: TicketInput): number {
  gate(ctx, 'service.manage')
  const db = ctx.db
  const issue = requireText(input.issue, 'What is wrong', 1000)
  const priority = (TICKET_PRIORITIES as readonly string[]).includes(String(input.priority)) ? String(input.priority) : 'normal'
  let partyId = optId(input.partyId)
  let productId = optId(input.productId)
  let documentId = optId(input.documentId)
  const serial = optText(input.serial, 100)
  let underWarranty = 0
  if (serial) {
    const w = warrantyCheck(ctx, { serial }) as { found: boolean; partyId?: number | null; productId?: number; documentId?: number | null; underWarranty?: boolean }
    if (w.found) {
      partyId = partyId ?? w.partyId ?? null
      productId = productId ?? w.productId ?? null
      documentId = documentId ?? w.documentId ?? null
      underWarranty = w.underWarranty ? 1 : 0
    }
  }
  if (partyId && !db.prepare('SELECT 1 FROM parties WHERE id = ? AND (firm_id IS NULL OR firm_id = ?)').get(partyId, ctx.firmId)) throw new AppError('The customer is not available in this firm.', 'VALIDATION')
  const customerName = optText(input.customerName, 120)
  if (!partyId && !customerName) throw new AppError('Select the customer or write the name.', 'VALIDATION')
  const receivedDate = requireDate(input.receivedDate ?? today(), 'Received date')
  const promisedDate = input.promisedDate ? requireDate(input.promisedDate, 'Promised date') : null
  if (promisedDate && promisedDate < receivedDate) throw new AppError('The promised date is before the received date.', 'VALIDATION')
  const assigned = optId(input.assignedTo)
  if (assigned && !db.prepare('SELECT 1 FROM users WHERE id = ? AND is_active = 1').get(assigned)) throw new AppError('The technician is not an active user.', 'VALIDATION')
  const v = {
    party_id: partyId,
    customer_name: customerName,
    phone: optText(input.phone, 40),
    product_id: productId,
    item_name: optText(input.itemName, 150),
    serial,
    document_id: documentId,
    project_id: optId(input.projectId),
    issue,
    priority,
    under_warranty: underWarranty,
    assigned_to: assigned,
    received_date: receivedDate,
    promised_date: promisedDate,
    charges: Math.max(0, round2(num(input.charges)))
  }
  if (input.id) {
    const before = getRow(ctx, input.id)
    if (before.status === 'closed') throw new AppError('A closed ticket cannot be edited.', 'VALIDATION')
    db.prepare(
      `UPDATE service_tickets SET party_id=@party_id, customer_name=@customer_name, phone=@phone, product_id=@product_id, item_name=@item_name, serial=@serial,
         document_id=@document_id, project_id=@project_id, issue=@issue, priority=@priority, under_warranty=@under_warranty, assigned_to=@assigned_to,
         received_date=@received_date, promised_date=@promised_date, charges=@charges, updated_at=datetime('now','localtime') WHERE id=@id`
    ).run({ ...v, id: input.id })
    audit(ctx, 'update', 'service_ticket', input.id, `Edited service ticket ${before.number}`)
    return input.id
  }
  return db.transaction(() => {
    const number = nextNumber(db, ctx.firmId, 'service_ticket')
    const id = Number(
      db
        .prepare(
          `INSERT INTO service_tickets (firm_id, number, party_id, customer_name, phone, product_id, item_name, serial, document_id, project_id, issue, priority, under_warranty, assigned_to, received_date, promised_date, charges, created_by)
           VALUES (@firm_id, @number, @party_id, @customer_name, @phone, @product_id, @item_name, @serial, @document_id, @project_id, @issue, @priority, @under_warranty, @assigned_to, @received_date, @promised_date, @charges, @created_by)`
        )
        .run({ ...v, firm_id: ctx.firmId, number, created_by: ctx.user.id }).lastInsertRowid
    )
    logActivity(ctx, id, 'note', underWarranty ? 'Ticket opened, item is under warranty' : 'Ticket opened')
    audit(ctx, 'create', 'service_ticket', id, `Opened service ticket ${number}`)
    return id
  })()
}

function logActivity(ctx: Ctx, ticketId: number, kind: string, summary: string): void {
  ctx.db.prepare('INSERT INTO service_activities (ticket_id, kind, summary, user_id, username) VALUES (?, ?, ?, ?, ?)').run(ticketId, kind, summary, ctx.user.id, ctx.user.username)
}

export function addActivity(ctx: Ctx, id: number, input: { kind?: string; summary: string }): void {
  gate(ctx, 'service.manage')
  const t = getRow(ctx, id)
  if (t.status === 'closed') throw new AppError('A closed ticket cannot be changed.', 'VALIDATION')
  const kind = (ACTIVITY_KINDS as readonly string[]).includes(String(input.kind)) ? String(input.kind) : 'note'
  logActivity(ctx, id, kind, requireText(input.summary, 'What happened', 500))
}

export function setTicketStatus(ctx: Ctx, id: number, input: { status: string; resolution?: string; charges?: number }): void {
  gate(ctx, 'service.manage')
  const t = getRow(ctx, id)
  const next = String(input.status)
  if (!(TICKET_STATUSES as readonly string[]).includes(next)) throw new AppError('Unknown status.', 'VALIDATION')
  if (t.status === 'closed' && next !== 'in_progress') throw new AppError('A closed ticket can only be reopened.', 'VALIDATION')
  const resolution = optText(input.resolution, 1000) ?? t.resolution
  if ((next === 'resolved' || next === 'closed') && !resolution) throw new AppError('Write what was done to fix it.', 'VALIDATION')
  const charges = input.charges === undefined ? t.charges : Math.max(0, round2(num(input.charges)))
  ctx.db
    .prepare("UPDATE service_tickets SET status = ?, resolution = ?, charges = ?, resolved_date = ?, updated_at = datetime('now','localtime') WHERE id = ?")
    .run(next, resolution, charges, next === 'resolved' || next === 'closed' ? (t.resolved_date ?? today()) : null, id)
  logActivity(ctx, id, 'note', `Status: ${t.status} to ${next}${next === 'resolved' || next === 'closed' ? `. ${resolution}` : ''}`)
  audit(ctx, 'status', 'service_ticket', id, `Service ticket ${t.number} marked ${next}`, { from: t.status, to: next })
}

export function deleteTicket(ctx: Ctx, id: number): void {
  gate(ctx, 'service.manage')
  const t = getRow(ctx, id)
  const acts = (ctx.db.prepare("SELECT COUNT(*) AS c FROM service_activities WHERE ticket_id = ? AND summary NOT LIKE 'Ticket opened%'").get(id) as { c: number }).c
  if (t.status !== 'new' || acts > 0) throw new AppError('A ticket that has been worked on is kept for the history. Close it instead.', 'VALIDATION')
  ctx.db.transaction(() => {
    ctx.db.prepare('DELETE FROM service_activities WHERE ticket_id = ?').run(id)
    ctx.db.prepare('DELETE FROM service_tickets WHERE id = ?').run(id)
  })()
  audit(ctx, 'delete', 'service_ticket', id, `Deleted service ticket ${t.number}`)
}

export function listTickets(ctx: Ctx, f: { status?: string; open?: boolean; q?: string; assignedTo?: number } = {}): unknown[] {
  gate(ctx, 'service.view')
  const t = today()
  const rows = ctx.db
    .prepare(
      `SELECT s.*, COALESCE(pa.name, s.customer_name) AS customer, COALESCE(pr.name, s.item_name) AS item, u.full_name AS technician
         FROM service_tickets s LEFT JOIN parties pa ON pa.id = s.party_id LEFT JOIN products pr ON pr.id = s.product_id LEFT JOIN users u ON u.id = s.assigned_to
        WHERE s.firm_id = @firmId AND (@status IS NULL OR s.status = @status) AND (@open = 0 OR s.status NOT IN ('resolved','closed'))
          AND (@assigned IS NULL OR s.assigned_to = @assigned)
          AND (@q IS NULL OR s.number LIKE @q OR s.serial LIKE @q OR s.customer_name LIKE @q OR pa.name LIKE @q OR s.issue LIKE @q)
        ORDER BY CASE s.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END, s.received_date, s.id`
    )
    .all({ firmId: ctx.firmId, status: f.status || null, open: f.open ? 1 : 0, assigned: f.assignedTo ?? null, q: f.q ? `%${f.q}%` : null }) as Array<TicketRow & Record<string, unknown>>
  return rows.map((r) => ({ ...r, overdue: !!r.promised_date && r.promised_date < t && r.status !== 'resolved' && r.status !== 'closed' }))
}

export function getTicket(ctx: Ctx, id: number): { ticket: Record<string, unknown>; activities: unknown[] } {
  gate(ctx, 'service.view')
  getRow(ctx, id)
  const ticket = ctx.db
    .prepare(
      `SELECT s.*, COALESCE(pa.name, s.customer_name) AS customer, pa.phone AS party_phone, COALESCE(pr.name, s.item_name) AS item, u.full_name AS technician, d.number AS document_number
         FROM service_tickets s LEFT JOIN parties pa ON pa.id = s.party_id LEFT JOIN products pr ON pr.id = s.product_id LEFT JOIN users u ON u.id = s.assigned_to LEFT JOIN documents d ON d.id = s.document_id
        WHERE s.id = ?`
    )
    .get(id) as Record<string, unknown>
  return { ticket, activities: ctx.db.prepare('SELECT * FROM service_activities WHERE ticket_id = ? ORDER BY id DESC').all(id) }
}

export function ticketSummary(ctx: Ctx): Record<string, unknown> {
  gate(ctx, 'service.view')
  const t = today()
  const by = ctx.db.prepare('SELECT status, COUNT(*) AS n FROM service_tickets WHERE firm_id = ? GROUP BY status').all(ctx.firmId) as Array<{ status: string; n: number }>
  const n = (s: string): number => by.find((b) => b.status === s)?.n ?? 0
  const overdue = (ctx.db.prepare("SELECT COUNT(*) AS c FROM service_tickets WHERE firm_id = ? AND promised_date < ? AND status NOT IN ('resolved','closed')").get(ctx.firmId, t) as { c: number }).c
  const warranty = (ctx.db.prepare("SELECT COUNT(*) AS c FROM service_tickets WHERE firm_id = ? AND under_warranty = 1 AND status NOT IN ('resolved','closed')").get(ctx.firmId) as { c: number }).c
  return { new: n('new'), inProgress: n('in_progress'), waitingParts: n('waiting_parts'), resolved: n('resolved'), closed: n('closed'), open: n('new') + n('in_progress') + n('waiting_parts'), overdue, underWarrantyOpen: warranty }
}
