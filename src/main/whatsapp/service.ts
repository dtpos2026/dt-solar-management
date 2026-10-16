/**
 * WhatsApp send flow — database side (owner: assist area). No Electron imports so it can be unit tested.
 * Builds the default phone/message for an entity, guards duplicates and keeps the whatsapp_log
 * (prepared -> opened -> sent / failed). The app never claims a message was sent: 'sent' is only set
 * when the user clicks "Mark as sent".
 */
import { DOC_TYPES, DocType } from '../../shared/docTypes'
import { formatMoney } from '../../shared/money'
import { AppError, Ctx, audit, can, getSetting, isValidDate, requirePerm } from '../services/context'
import { getDocument } from '../services/documents'
import { getParty, partyBalance } from '../services/parties'
import { getPayment } from '../services/payments'
import { getMaterialMove, getProject, projectFinancials } from '../services/projects'
import { getFirm } from '../services/firms'
import { DEDUPE_MINUTES, PRINT_KIND, WA_ENTITIES, WaEntity, dedupeKey, isRecentDuplicate, messageTemplate, normalizePhone, safeFileName } from './core'

export type WaMode = 'web' | 'chat_link'
export type WaStatus = 'prepared' | 'opened' | 'sent' | 'failed'

export interface SendTarget {
  entity: WaEntity
  id: number
  params: Record<string, string>
}

export interface Draft extends SendTarget {
  partyId: number | null
  partyName: string | null
  phone: string
  phoneRaw: string
  message: string
  fileName: string
  label: string
  printKind: string
  mode: WaMode
  countryCode: string
}

export function waMode(ctx: Ctx): WaMode {
  return getSetting<string>(ctx.db, 'whatsapp_mode', 'web') === 'chat_link' ? 'chat_link' : 'web'
}

export function countryCode(ctx: Ctx): string {
  return String(getSetting(ctx.db, 'whatsapp_country_code', '92')).replace(/\D/g, '') || '92'
}

/** Validates what the renderer asked to send (never trusted). */
export function parseTarget(a: Record<string, unknown>): SendTarget {
  const entity = String(a.entity ?? '') as WaEntity
  if (!WA_ENTITIES.includes(entity)) throw new AppError('Unknown document type for WhatsApp.', 'VALIDATION')
  const id = Number(a.id)
  if (!Number.isInteger(id) || id <= 0) throw new AppError('Invalid record.', 'VALIDATION')
  const params: Record<string, string> = {}
  const p = (a.params ?? {}) as Record<string, unknown>
  if (entity === 'statement') {
    if (p.from !== undefined && p.from !== null && p.from !== '') {
      if (!isValidDate(p.from)) throw new AppError('Invalid statement start date.', 'VALIDATION')
      params.from = String(p.from)
    }
    if (p.to !== undefined && p.to !== null && p.to !== '') {
      if (!isValidDate(p.to)) throw new AppError('Invalid statement end date.', 'VALIDATION')
      params.to = String(p.to)
    }
  }
  return { entity, id, params }
}

/** Default phone, message and file name for an entity (permission checks are done by the entity getters). */
export function buildDraft(ctx: Ctx, t: SendTarget): Draft {
  requirePerm(ctx, 'whatsapp.send')
  const settings = {
    sym: String(getSetting(ctx.db, 'currency_symbol', 'Rs.')),
    dec: Number(getSetting(ctx.db, 'money_decimals', 0)) || 0
  }
  const money = (n: unknown): string => formatMoney(Number(n) || 0, settings.sym, settings.dec)
  const firmName = String((getFirm(ctx.db, ctx.firmId) as { name?: string }).name ?? '')
  let partyId: number | null = null
  let partyName: string | null = null
  let phoneRaw = ''
  let label = ''
  let number: string | null = null
  let message = ''

  switch (t.entity) {
    case 'document': {
      const d = getDocument(ctx, t.id) as Record<string, unknown>
      const meta = DOC_TYPES[d.doc_type as DocType]
      label = meta?.label ?? 'Document'
      number = String(d.number ?? '')
      partyId = d.party_id ? Number(d.party_id) : null
      partyName = (d.party_name as string) || null
      phoneRaw = String(d.party_phone ?? '')
      if (!phoneRaw && partyId) phoneRaw = String((ctx.db.prepare('SELECT phone FROM parties WHERE id = ?').get(partyId) as { phone?: string } | undefined)?.phone ?? '')
      const due = Number(d.due ?? 0)
      message = messageTemplate('document', {
        firmName,
        partyName,
        label,
        number,
        amount: money(d.grand_total),
        balance: meta?.financial && due > 0 ? money(due) : null
      })
      break
    }
    case 'payment': {
      const p = getPayment(ctx, t.id)
      label = p.direction === 'in' ? 'Receipt' : 'Payment Voucher'
      number = String(p.number ?? '')
      partyId = p.party_id ? Number(p.party_id) : null
      partyName = (p.party_name as string) || null
      phoneRaw = String(p.party_phone ?? '')
      message = messageTemplate('payment', { firmName, partyName, label, number, amount: money(p.amount) })
      break
    }
    case 'statement': {
      const p = getParty(ctx, t.id)
      label = 'Account Statement'
      partyId = t.id
      partyName = String(p.name ?? '') || null
      phoneRaw = String(p.phone ?? '')
      number = partyName
      const bal = partyBalance(ctx, t.id, ctx.firmId, t.params.to)
      message = messageTemplate('statement', { firmName, partyName, label, from: t.params.from, to: t.params.to, balance: bal ? money(Math.abs(bal)) + (bal < 0 ? ' (credit)' : '') : null })
      break
    }
    case 'project': {
      const p = getProject(ctx, t.id)
      label = 'Project Statement'
      number = String(p.code ?? '')
      partyId = p.customer_id ? Number(p.customer_id) : null
      partyName = (p.customer_name as string) || null
      phoneRaw = String(p.contact_phone || p.customer_phone || '')
      let balance: string | null = null
      if (can(ctx, 'projects.financials')) {
        const f = projectFinancials(ctx.db, t.id)
        if (f.customerOutstanding > 0) balance = money(f.customerOutstanding)
      }
      message = messageTemplate('project', { firmName, partyName, label, number: `${number} ${p.name ?? ''}`.trim(), balance })
      break
    }
    case 'material': {
      const m = getMaterialMove(ctx, t.id) as Record<string, unknown>
      label = m.direction === 'return' ? 'Material Return' : 'Material Issue'
      number = String(m.number ?? '')
      partyName = (m.customer_name as string) || null
      const pr = ctx.db.prepare('SELECT pr.customer_id, pr.contact_phone, pa.phone FROM projects pr LEFT JOIN parties pa ON pa.id = pr.customer_id WHERE pr.id = ?').get(m.project_id) as
        | { customer_id: number | null; contact_phone: string | null; phone: string | null }
        | undefined
      partyId = pr?.customer_id ?? null
      phoneRaw = String(pr?.contact_phone || pr?.phone || '')
      message = messageTemplate('material', { firmName, partyName, label, number })
      break
    }
  }
  const cc = countryCode(ctx)
  return {
    ...t,
    partyId,
    partyName,
    phoneRaw,
    phone: normalizePhone(phoneRaw, cc) ?? '',
    message,
    fileName: safeFileName(`${label}-${number ?? t.id}`),
    label,
    printKind: PRINT_KIND[t.entity],
    mode: waMode(ctx),
    countryCode: cc
  }
}

export interface LogRow {
  id: number
  firm_id: number | null
  party_id: number | null
  phone: string
  entity: string | null
  entity_id: number | null
  file_name: string | null
  method: string
  status: WaStatus
  message_id: string | null
  error: string | null
  dedupe_key: string | null
  created_by: number | null
  created_at: string
  updated_at: string | null
}

/** Last opened/sent attempt for the same entity + phone within the guard window, or null. */
export function recentDuplicate(ctx: Ctx, entity: string, id: number, phone: string, now = new Date()): LogRow | null {
  const rows = ctx.db
    .prepare(`SELECT * FROM whatsapp_log WHERE dedupe_key = ? AND (firm_id = ? OR firm_id IS NULL) ORDER BY id DESC LIMIT 10`)
    .all(dedupeKey(entity, id, phone), ctx.firmId) as LogRow[]
  const check = rows.map((r) => ({ ...r, created_at: r.updated_at ?? r.created_at }))
  if (!isRecentDuplicate(check, now, DEDUPE_MINUTES)) return null
  return rows.find((r) => r.status === 'opened' || r.status === 'sent') ?? null
}

export function insertLog(
  ctx: Ctx,
  d: { entity: string; id: number; partyId: number | null; phone: string; fileName: string | null; method: 'whatsapp_web' | 'chat_link'; status: WaStatus; error?: string | null }
): number {
  const r = ctx.db
    .prepare(
      `INSERT INTO whatsapp_log (firm_id, party_id, phone, entity, entity_id, file_name, method, status, error, dedupe_key, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(ctx.firmId || null, d.partyId, d.phone, d.entity, d.id, d.fileName, d.method, d.status, d.error ?? null, dedupeKey(d.entity, d.id, d.phone), ctx.user.id)
  return Number(r.lastInsertRowid)
}

export function getLog(ctx: Ctx, id: number): LogRow {
  const r = ctx.db.prepare('SELECT * FROM whatsapp_log WHERE id = ? AND (firm_id = ? OR firm_id IS NULL)').get(Number(id), ctx.firmId) as LogRow | undefined
  if (!r) throw new AppError('WhatsApp log entry not found.', 'NOT_FOUND')
  return r
}

const NEXT: Record<WaStatus, WaStatus[]> = {
  prepared: ['opened', 'sent', 'failed'],
  opened: ['opened', 'sent', 'failed'],
  failed: ['opened', 'failed'],
  sent: []
}

/** Moves a log entry to a new status; 'sent' is final and only set by the user. */
export function setLogStatus(ctx: Ctx, id: number, status: WaStatus, error?: string | null): LogRow {
  requirePerm(ctx, 'whatsapp.send')
  const row = getLog(ctx, id)
  if (row.status === status && status !== 'opened') return row
  if (!NEXT[row.status].includes(status)) throw new AppError(`This entry is already "${row.status}".`, 'VALIDATION')
  ctx.db
    .prepare("UPDATE whatsapp_log SET status = ?, error = ?, updated_at = datetime('now','localtime') WHERE id = ?")
    .run(status, status === 'failed' ? String(error ?? 'Failed').slice(0, 300) : null, id)
  if (status === 'sent') audit(ctx, 'whatsapp_sent', row.entity, row.entity_id, `Marked as sent on WhatsApp to ${row.phone} (${row.file_name ?? ''})`)
  return getLog(ctx, id)
}

export function listLog(
  ctx: Ctx,
  f: { status?: string; entity?: string; q?: string; from?: string; to?: string; limit?: number } = {}
): Array<LogRow & { party_name: string | null; created_by_name: string | null }> {
  requirePerm(ctx, 'whatsapp.send')
  const where = ['(w.firm_id = @firmId OR w.firm_id IS NULL)']
  const p: Record<string, unknown> = { firmId: ctx.firmId, limit: Math.min(1000, Math.max(1, Number(f.limit) || 300)) }
  if (f.status && ['prepared', 'opened', 'sent', 'failed'].includes(f.status)) {
    where.push('w.status = @status')
    p.status = f.status
  }
  if (f.entity && (WA_ENTITIES as string[]).includes(f.entity)) {
    where.push('w.entity = @entity')
    p.entity = f.entity
  }
  if (isValidDate(f.from)) {
    where.push('date(w.created_at) >= @from')
    p.from = f.from
  }
  if (isValidDate(f.to)) {
    where.push('date(w.created_at) <= @to')
    p.to = f.to
  }
  if (f.q && String(f.q).trim()) {
    where.push('(w.phone LIKE @q OR w.file_name LIKE @q OR pa.name LIKE @q)')
    p.q = `%${String(f.q).trim().slice(0, 60)}%`
  }
  return ctx.db
    .prepare(
      `SELECT w.*, pa.name AS party_name, u.full_name AS created_by_name FROM whatsapp_log w
       LEFT JOIN parties pa ON pa.id = w.party_id LEFT JOIN users u ON u.id = w.created_by
       WHERE ${where.join(' AND ')} ORDER BY w.id DESC LIMIT @limit`
    )
    .all(p) as Array<LogRow & { party_name: string | null; created_by_name: string | null }>
}
