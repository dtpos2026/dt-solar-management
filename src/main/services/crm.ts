/**
 * CRM: leads (sales enquiries), follow-ups and the activity timeline. A lead becomes a customer when it is won.
 * Leads belong to the firm that works on them. Permissions: crm.view (read), crm.manage (change).
 */
import { AppError, Ctx, audit, can, optText, requireDate, requirePerm, requireText, today } from './context'
import { saveParty } from './parties'
import { ACTIVITY_KINDS, OPEN_STAGES, STAGES, stageLabel, type Stage } from '../../shared/crm'
export { ACTIVITY_KINDS, OPEN_STAGES, STAGES, type Stage }
const STAGE_KEYS = STAGES.map((s) => s.key) as string[]

/** Contact kinds: logging one means the customer was reached, so a "New" lead becomes "Contacted". */
const CONTACT_KINDS = ['call', 'whatsapp', 'visit', 'meeting']

export interface LeadInput {
  id?: number
  name: string
  phone?: string
  email?: string
  city?: string
  address?: string
  source?: string
  interest?: string
  systemKw?: number | null
  expectedValue?: number
  assignedTo?: number | null
  nextFollowUp?: string | null
  notes?: string
}

type Row = Record<string, unknown>

const money = (v: unknown): number => {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : 0
}

function leadRow(ctx: Ctx, id: number): Row {
  const r = ctx.db.prepare('SELECT * FROM leads WHERE id = ? AND firm_id = ?').get(id, ctx.firmId) as Row | undefined
  if (!r) throw new AppError('Lead not found.', 'NOT_FOUND')
  return r
}

function logActivity(ctx: Ctx, leadId: number, kind: string, summary: string): void {
  ctx.db.prepare('INSERT INTO lead_activities (lead_id, kind, summary, user_id, username) VALUES (?, ?, ?, ?, ?)').run(leadId, kind, summary, ctx.user.id, ctx.user.username)
}

function validAssignee(ctx: Ctx, v: unknown): number | null {
  if (v === null || v === undefined || v === '' || Number(v) === 0) return null
  const id = Number(v)
  const u = ctx.db.prepare('SELECT id FROM users WHERE id = ? AND is_active = 1').get(id)
  if (!u) throw new AppError('Choose an active user to assign this lead to.', 'VALIDATION')
  return id
}

export function saveLead(ctx: Ctx, input: LeadInput): number {
  requirePerm(ctx, 'crm.manage')
  const name = requireText(input.name, 'Name', 150)
  const expected = money(input.expectedValue)
  const kw = input.systemKw === null || input.systemKw === undefined || Number(input.systemKw) <= 0 ? null : Math.round(Number(input.systemKw) * 100) / 100
  const follow = input.nextFollowUp ? requireDate(input.nextFollowUp, 'Next follow-up date') : null
  const assigned = validAssignee(ctx, input.assignedTo)
  const vals = {
    name,
    phone: optText(input.phone, 40),
    email: optText(input.email, 120),
    city: optText(input.city, 80),
    address: optText(input.address, 300),
    source: optText(input.source, 60),
    interest: optText(input.interest, 200),
    system_kw: kw,
    expected_value: expected,
    assigned_to: assigned,
    next_follow_up: follow,
    notes: optText(input.notes, 2000)
  }
  return ctx.db.transaction(() => {
    if (input.id) {
      const before = leadRow(ctx, Number(input.id))
      ctx.db
        .prepare(
          `UPDATE leads SET name=@name, phone=@phone, email=@email, city=@city, address=@address, source=@source, interest=@interest, system_kw=@system_kw,
             expected_value=@expected_value, assigned_to=@assigned_to, next_follow_up=@next_follow_up, notes=@notes, updated_at=datetime('now','localtime') WHERE id=@id`
        )
        .run({ ...vals, id: input.id })
      audit(ctx, 'update', 'lead', Number(input.id), `Updated lead ${name}`, { before: { name: before.name, expected_value: before.expected_value, next_follow_up: before.next_follow_up } })
      return Number(input.id)
    }
    const id = Number(
      ctx.db
        .prepare(
          `INSERT INTO leads (firm_id, name, phone, email, city, address, source, interest, system_kw, expected_value, assigned_to, next_follow_up, notes, created_by)
           VALUES (@firm_id, @name, @phone, @email, @city, @address, @source, @interest, @system_kw, @expected_value, @assigned_to, @next_follow_up, @notes, @created_by)`
        )
        .run({ ...vals, firm_id: ctx.firmId, created_by: ctx.user.id }).lastInsertRowid
    )
    logActivity(ctx, id, 'note', 'Lead created')
    audit(ctx, 'create', 'lead', id, `Created lead ${name}`)
    return id
  })()
}

export interface LeadFilter {
  status?: 'open' | 'won' | 'lost' | 'all'
  stage?: string
  assignedTo?: number
  q?: string
  due?: 'overdue' | 'today' | 'week'
}

export function listLeads(ctx: Ctx, f: LeadFilter = {}): Row[] {
  requirePerm(ctx, 'crm.view')
  const where = ['l.firm_id = @firm']
  const p: Record<string, unknown> = { firm: ctx.firmId, today: today() }
  const status = f.status ?? 'all'
  if (status === 'open') where.push("l.stage NOT IN ('won','lost')")
  else if (status === 'won' || status === 'lost') where.push('l.stage = @status'), (p.status = status)
  if (f.stage && STAGE_KEYS.includes(f.stage)) where.push('l.stage = @stage'), (p.stage = f.stage)
  if (f.assignedTo) where.push('l.assigned_to = @assigned'), (p.assigned = Number(f.assignedTo))
  if (f.q && f.q.trim()) where.push('(l.name LIKE @q OR l.phone LIKE @q OR l.city LIKE @q OR l.interest LIKE @q OR l.source LIKE @q)'), (p.q = `%${f.q.trim()}%`)
  if (f.due) {
    where.push("l.stage NOT IN ('won','lost') AND l.next_follow_up IS NOT NULL")
    if (f.due === 'overdue') where.push('l.next_follow_up < @today')
    else if (f.due === 'today') where.push('l.next_follow_up = @today')
    else where.push("l.next_follow_up > @today AND l.next_follow_up <= date(@today, '+7 day')")
  }
  return ctx.db
    .prepare(
      `SELECT l.*, u.full_name AS assigned_name, pa.name AS party_name,
              (SELECT summary FROM lead_activities a WHERE a.lead_id = l.id AND a.kind <> 'stage' ORDER BY a.id DESC LIMIT 1) AS last_activity
         FROM leads l LEFT JOIN users u ON u.id = l.assigned_to LEFT JOIN parties pa ON pa.id = l.party_id
        WHERE ${where.join(' AND ')}
        ORDER BY CASE WHEN l.stage IN ('won','lost') THEN 1 ELSE 0 END, COALESCE(l.next_follow_up, '9999-12-31'), l.id DESC LIMIT 2000`
    )
    .all(p) as Row[]
}

export function getLead(ctx: Ctx, id: number): { lead: Row; activities: Row[] } {
  requirePerm(ctx, 'crm.view')
  leadRow(ctx, id)
  const lead = ctx.db
    .prepare('SELECT l.*, u.full_name AS assigned_name, pa.name AS party_name FROM leads l LEFT JOIN users u ON u.id = l.assigned_to LEFT JOIN parties pa ON pa.id = l.party_id WHERE l.id = ?')
    .get(id) as Row
  const activities = ctx.db.prepare('SELECT * FROM lead_activities WHERE lead_id = ? ORDER BY id DESC').all(id) as Row[]
  return { lead, activities }
}

/** Log a call / WhatsApp / visit / meeting / note, and optionally set the next follow-up date. */
export function addActivity(ctx: Ctx, id: number, input: { kind: string; summary: string; nextFollowUp?: string | null }): void {
  requirePerm(ctx, 'crm.manage')
  const lead = leadRow(ctx, id)
  const kind = (ACTIVITY_KINDS as readonly string[]).includes(input.kind) ? input.kind : 'note'
  const summary = requireText(input.summary, 'What happened', 500)
  const follow = input.nextFollowUp === undefined ? undefined : input.nextFollowUp ? requireDate(input.nextFollowUp, 'Next follow-up date') : null
  ctx.db.transaction(() => {
    logActivity(ctx, id, kind, summary)
    const contact = CONTACT_KINDS.includes(kind)
    ctx.db
      .prepare(
        `UPDATE leads SET last_contact_at = CASE WHEN @contact = 1 THEN datetime('now','localtime') ELSE last_contact_at END,
           next_follow_up = CASE WHEN @setFollow = 1 THEN @follow ELSE next_follow_up END, updated_at = datetime('now','localtime') WHERE id = @id`
      )
      .run({ id, contact: contact ? 1 : 0, setFollow: follow === undefined ? 0 : 1, follow: follow ?? null })
    if (contact && lead.stage === 'new') {
      ctx.db.prepare("UPDATE leads SET stage = 'contacted' WHERE id = ?").run(id)
      logActivity(ctx, id, 'stage', 'Stage: New to Contacted')
    }
  })()
}

/** Creates the customer of a won lead (or links the existing one). Needs the permission to manage customers. */
export function ensureCustomer(ctx: Ctx, id: number): number {
  const lead = leadRow(ctx, id)
  if (lead.party_id) return Number(lead.party_id)
  requirePerm(ctx, 'customers.manage')
  const partyId = saveParty(ctx, {
    type: 'customer',
    name: String(lead.name),
    phone: (lead.phone as string) ?? undefined,
    city: (lead.city as string) ?? undefined,
    address: (lead.address as string) ?? undefined,
    email: (lead.email as string) ?? undefined
  })
  ctx.db.prepare("UPDATE leads SET party_id = ?, updated_at = datetime('now','localtime') WHERE id = ?").run(partyId, id)
  logActivity(ctx, id, 'stage', 'Customer created from this lead')
  audit(ctx, 'convert', 'lead', id, `Lead ${lead.name} became a customer`, { partyId })
  return partyId
}

/** Move a lead to a stage. "Lost" needs a reason; "Won" creates (or links) the customer; an open stage re-opens a closed lead. */
export function setStage(ctx: Ctx, id: number, stage: string, opts: { reason?: string } = {}): { partyId: number | null } {
  requirePerm(ctx, 'crm.manage')
  if (!STAGE_KEYS.includes(stage)) throw new AppError('Choose a valid stage.', 'VALIDATION')
  const lead = leadRow(ctx, id)
  if (lead.stage === stage) return { partyId: (lead.party_id as number) ?? null }
  const reason = stage === 'lost' ? requireText(opts.reason, 'Reason for losing the lead', 300) : null
  return ctx.db.transaction(() => {
    ctx.db
      .prepare(
        `UPDATE leads SET stage = @stage, lost_reason = @reason, closed_at = CASE WHEN @closed = 1 THEN datetime('now','localtime') ELSE NULL END,
           next_follow_up = CASE WHEN @closed = 1 THEN NULL ELSE next_follow_up END, updated_at = datetime('now','localtime') WHERE id = @id`
      )
      .run({ id, stage, reason, closed: stage === 'won' || stage === 'lost' ? 1 : 0 })
    logActivity(ctx, id, 'stage', `Stage: ${stageLabel(String(lead.stage))} to ${stageLabel(stage)}${reason ? ` (${reason})` : ''}`)
    audit(ctx, 'stage', 'lead', id, `Lead ${lead.name}: ${stageLabel(String(lead.stage))} to ${stageLabel(stage)}`, reason ? { reason } : undefined)
    const partyId = stage === 'won' ? ensureCustomer(ctx, id) : ((lead.party_id as number) ?? null)
    return { partyId }
  })()
}

export function deleteLead(ctx: Ctx, id: number): void {
  requirePerm(ctx, 'crm.manage')
  const lead = leadRow(ctx, id)
  ctx.db.transaction(() => {
    ctx.db.prepare('DELETE FROM lead_activities WHERE lead_id = ?').run(id)
    ctx.db.prepare('DELETE FROM leads WHERE id = ?').run(id)
    audit(ctx, 'delete', 'lead', id, `Deleted lead ${lead.name}`, { stage: lead.stage, expected_value: lead.expected_value, phone: lead.phone })
  })()
}

export interface CrmSummary {
  open: number
  pipelineValue: number
  byStage: Array<{ stage: string; label: string; count: number; value: number }>
  followUps: { overdue: number; today: number; week: number }
  wonThisMonth: { count: number; value: number }
  conversionPct: number | null
}

export function followUpCounts(ctx: Ctx): { overdue: number; today: number; week: number } {
  const row = ctx.db
    .prepare(
      `SELECT SUM(CASE WHEN next_follow_up < @t THEN 1 ELSE 0 END) AS overdue,
              SUM(CASE WHEN next_follow_up = @t THEN 1 ELSE 0 END) AS today,
              SUM(CASE WHEN next_follow_up > @t AND next_follow_up <= date(@t, '+7 day') THEN 1 ELSE 0 END) AS week
         FROM leads WHERE firm_id = @f AND stage NOT IN ('won','lost') AND next_follow_up IS NOT NULL`
    )
    .get({ t: today(), f: ctx.firmId }) as { overdue: number | null; today: number | null; week: number | null }
  return { overdue: row.overdue ?? 0, today: row.today ?? 0, week: row.week ?? 0 }
}

/** Light summary for the notification bell (needs only crm.view). */
export function followUps(ctx: Ctx): { overdue: number; today: number; week: number } {
  if (!can(ctx, 'crm.view')) return { overdue: 0, today: 0, week: 0 }
  return followUpCounts(ctx)
}

export function summary(ctx: Ctx): CrmSummary {
  requirePerm(ctx, 'crm.view')
  const rows = ctx.db.prepare('SELECT stage, COUNT(*) AS count, COALESCE(SUM(expected_value), 0) AS value FROM leads WHERE firm_id = ? GROUP BY stage').all(ctx.firmId) as Array<{ stage: string; count: number; value: number }>
  const by = new Map(rows.map((r) => [r.stage, r]))
  const byStage = STAGES.map((s) => ({ stage: s.key, label: s.label, count: by.get(s.key)?.count ?? 0, value: Math.round((by.get(s.key)?.value ?? 0) * 100) / 100 }))
  const open = byStage.filter((s) => OPEN_STAGES.includes(s.stage as Stage))
  const month = today().slice(0, 7)
  const won = ctx.db
    .prepare("SELECT COUNT(*) AS c, COALESCE(SUM(expected_value), 0) AS v FROM leads WHERE firm_id = ? AND stage = 'won' AND substr(closed_at, 1, 7) = ?")
    .get(ctx.firmId, month) as { c: number; v: number }
  const wonAll = by.get('won')?.count ?? 0
  const lostAll = by.get('lost')?.count ?? 0
  return {
    open: open.reduce((a, s) => a + s.count, 0),
    pipelineValue: Math.round(open.reduce((a, s) => a + s.value, 0) * 100) / 100,
    byStage,
    followUps: followUpCounts(ctx),
    wonThisMonth: { count: won.c, value: Math.round(won.v * 100) / 100 },
    conversionPct: wonAll + lostAll > 0 ? Math.round((wonAll / (wonAll + lostAll)) * 1000) / 10 : null
  }
}
