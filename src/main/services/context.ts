import type { DB } from '../db'

export class AppError extends Error {
  code: string
  constructor(message: string, code = 'APP_ERROR') {
    super(message)
    this.code = code
  }
}

export interface SessionUser {
  id: number
  username: string
  fullName: string
  roleId: number
  roleName: string
  isOwner: boolean
  permissions: string[]
  allFirms: boolean
  firmIds: number[]
  mustChangePassword: boolean
}

export interface Ctx {
  db: DB
  user: SessionUser
  firmId: number
}

export function can(ctx: Ctx, perm: string): boolean {
  return ctx.user.isOwner || ctx.user.permissions.includes(perm)
}

export function requirePerm(ctx: Ctx, perm: string): void {
  if (!can(ctx, perm)) throw new AppError('You do not have permission to perform this action.', 'FORBIDDEN')
}

export function canAccessFirm(user: SessionUser, firmId: number): boolean {
  return user.isOwner || user.allFirms || user.firmIds.includes(firmId)
}

export function audit(
  ctx: Ctx,
  action: string,
  entity: string | null,
  entityId: number | null,
  summary: string,
  details?: unknown
): void {
  ctx.db
    .prepare(
      `INSERT INTO audit_log (user_id, username, firm_id, action, entity, entity_id, summary, details)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      ctx.user.id,
      ctx.user.username,
      ctx.firmId || null,
      action,
      entity,
      entityId,
      summary,
      details === undefined ? null : JSON.stringify(details)
    )
}

export function today(): string {
  const d = new Date()
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

export function nowStamp(): string {
  const d = new Date()
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${today()} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

export function isValidDate(s: unknown): s is string {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s))
}

export function requireDate(s: unknown, label = 'Date'): string {
  if (!isValidDate(s)) throw new AppError(`${label} is invalid.`, 'VALIDATION')
  return s
}

export function requireText(s: unknown, label: string, max = 500): string {
  const v = typeof s === 'string' ? s.trim() : ''
  if (!v) throw new AppError(`${label} is required.`, 'VALIDATION')
  if (v.length > max) throw new AppError(`${label} is too long (max ${max} characters).`, 'VALIDATION')
  return v
}

export function optText(s: unknown, max = 5000): string | null {
  if (s === null || s === undefined) return null
  const v = String(s).trim()
  if (!v) return null
  return v.slice(0, max)
}

export function optId(v: unknown): number | null {
  if (v === null || v === undefined || v === '' || v === 0 || v === '0') return null
  const n = Number(v)
  return Number.isInteger(n) && n > 0 ? n : null
}

export function getSetting<T>(db: DB, key: string, fallback: T): T {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined
  if (!row) return fallback
  try {
    return JSON.parse(row.value) as T
  } catch {
    return fallback
  }
}

export function setSetting(db: DB, key: string, value: unknown): void {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(
    key,
    JSON.stringify(value)
  )
}

/** SQL fragment: rows owned by the firm or shared (firm_id NULL). */
export function visibleTo(alias: string): string {
  return `(${alias}.firm_id IS NULL OR ${alias}.firm_id = @firmId)`
}

export function like(q: unknown): string {
  return `%${String(q ?? '').trim().replace(/[%_]/g, (m) => '\\' + m)}%`
}
