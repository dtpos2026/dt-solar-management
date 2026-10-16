/**
 * Activity log helpers (pure — no Firebase imports, unit tested in tests/portal-admin.test.ts).
 * Firestore access lives in pages/ActivityLog.tsx and lib/audit.ts.
 */
import type { AuditCategory } from './types'

export const AUDIT_CATEGORIES: { id: AuditCategory; label: string }[] = [
  { id: 'security', label: 'Security' },
  { id: 'financial', label: 'Financial' },
  { id: 'license', label: 'License' },
  { id: 'client', label: 'Client' },
  { id: 'device', label: 'Device' },
  { id: 'support', label: 'Support' },
  { id: 'settings', label: 'Settings' },
  { id: 'general', label: 'General' }
]
const CATEGORY_IDS = AUDIT_CATEGORIES.map((c) => c.id) as string[]

/**
 * Protected audit trail: entries in these categories can never be deleted from the portal (the rules refuse it).
 * Every other category may be cleared by an admin holding audit.manage, at any age.
 */
export const PROTECTED_CATEGORIES: AuditCategory[] = ['security']
export const RETENTION_DAYS = 90
const DAY_MS = 86_400_000

export interface AuditRow {
  id: string
  action: string
  category: AuditCategory
  by: string
  byUid: string
  target: string
  targetType: string
  licenseId: string | null
  details: string
  meta: Record<string, unknown>
  status: 'success' | 'failure'
  /** Server time of the entry in epoch ms (null while the server timestamp is pending). */
  atMs: number | null
  archived: boolean
  archivedAtMs: number | null
  archivedBy: string
  /** v1.0 entry written before categories existed (shown as 'license'). */
  legacy: boolean
}

function toMs(v: unknown): number | null {
  if (v && typeof (v as { toMillis?: unknown }).toMillis === 'function') return (v as { toMillis: () => number }).toMillis()
  if (v instanceof Date) return v.getTime()
  if (typeof v === 'number' && Number.isFinite(v)) return v
  return null
}
const s = (v: unknown): string => (typeof v === 'string' ? v : v === null || v === undefined ? '' : String(v))

/** Maps raw Firestore data to a row. Legacy entries without a category are license entries. */
export function auditRowFromData(id: string, d: Record<string, unknown> | undefined | null): AuditRow {
  const data = d ?? {}
  const rawCat = s(data.category)
  const legacy = !rawCat
  const licenseId = data.licenseId ? s(data.licenseId) : null
  const meta = data.meta && typeof data.meta === 'object' && !Array.isArray(data.meta) ? (data.meta as Record<string, unknown>) : {}
  return {
    id,
    action: s(data.action),
    category: (CATEGORY_IDS.includes(rawCat) ? rawCat : legacy ? 'license' : 'general') as AuditCategory,
    by: s(data.by),
    byUid: s(data.byUid),
    target: s(data.target) || licenseId || '',
    targetType: s(data.targetType) || (licenseId ? 'license' : ''),
    licenseId,
    details: s(data.details),
    meta,
    status: data.status === 'failure' ? 'failure' : 'success',
    atMs: toMs(data.at),
    archived: data.archived === true,
    archivedAtMs: toMs(data.archivedAt),
    archivedBy: s(data.archivedBy),
    legacy
  }
}

export function actionLabel(action: string): string {
  const t = action.replace(/[_.]+/g, ' ').trim()
  return t ? t[0].toUpperCase() + t.slice(1) : '—'
}

export interface AuditFilters {
  search: string
  /** Inclusive range in epoch ms (null = open). */
  fromMs: number | null
  toMs: number | null
  by: string
  action: string
  category: string
  status: string
  showArchived: boolean
}

export const EMPTY_FILTERS: AuditFilters = { search: '', fromMs: null, toMs: null, by: '', action: '', category: '', status: '', showArchived: false }

export function filterAuditRows(rows: readonly AuditRow[], f: AuditFilters): AuditRow[] {
  const q = f.search.trim().toLowerCase()
  return rows.filter((r) => {
    if (!f.showArchived && r.archived) return false
    if (f.by && r.by !== f.by) return false
    if (f.action && r.action !== f.action) return false
    if (f.category && r.category !== f.category) return false
    if (f.status && r.status !== f.status) return false
    if (f.fromMs !== null && (r.atMs === null || r.atMs < f.fromMs)) return false
    if (f.toMs !== null && (r.atMs === null || r.atMs > f.toMs)) return false
    if (q) {
      const hay = `${r.action} ${actionLabel(r.action)} ${r.by} ${r.target} ${r.targetType} ${r.details} ${r.licenseId ?? ''} ${r.category} ${r.status}`.toLowerCase()
      if (!hay.includes(q)) return false
    }
    return true
  })
}

/** Distinct non-empty values of a field, sorted (for filter drop-downs). */
export function distinctValues(rows: readonly AuditRow[], key: 'by' | 'action'): string[] {
  return Array.from(new Set(rows.map((r) => r[key]).filter(Boolean))).sort((a, b) => a.localeCompare(b))
}

/* ------------------------------------------------ CSV ------------------------------------------------ */

/** RFC 4180 cell; cells that a spreadsheet would run as a formula are prefixed with ' (CSV injection guard). */
export function csvCell(v: unknown): string {
  let t = v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v)
  if (/^[=+\-@\t\r]/.test(t)) t = `'${t}`
  return /[",\r\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t
}

export const AUDIT_CSV_COLUMNS = ['Time (UTC)', 'Action', 'Category', 'Status', 'Admin', 'Target type', 'Target', 'License', 'Details', 'Archived', 'Meta', 'Id'] as const

export function auditCsv(rows: readonly AuditRow[]): string {
  const lines = [AUDIT_CSV_COLUMNS.map(csvCell).join(',')]
  for (const r of rows) {
    lines.push(
      [
        r.atMs === null ? '' : new Date(r.atMs).toISOString(),
        r.action,
        r.category,
        r.status,
        r.by,
        r.targetType,
        r.target,
        r.licenseId ?? '',
        r.details,
        r.archived ? 'yes' : 'no',
        Object.keys(r.meta).length ? r.meta : '',
        r.id
      ]
        .map(csvCell)
        .join(',')
    )
  }
  // BOM so Excel opens UTF-8 (Urdu names, ₨) correctly.
  return '﻿' + lines.join('\r\n') + '\r\n'
}

/* --------------------------------------------- retention --------------------------------------------- */

/** Cut-off for "older than N days" (the rules compare with request.time; `marginMs` absorbs clock skew). */
export function retentionCutoff(nowMs: number, days = RETENTION_DAYS, marginMs = 3_600_000): number {
  return nowMs - days * DAY_MS - marginMs
}

/** True when the owner may delete this entry under the retention policy. */
export function isRetentionDeletable(r: Pick<AuditRow, 'category' | 'atMs'>, nowMs: number, days = RETENTION_DAYS): boolean {
  if (PROTECTED_CATEGORIES.includes(r.category)) return false
  if (r.atMs === null) return false
  return r.atMs < retentionCutoff(nowMs, days)
}

/** Splits a list into chunks (Firestore batches hold at most 500 writes). */
export function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

/** yyyy-mm-dd (local) → start / end of that day in ms. */
export function dayStartMs(isoDay: string, offsetDays = 0): number | null {
  const m = isoDay.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (!m) return null
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + offsetDays, 0, 0, 0, 0).getTime()
}
export function dayEndMs(isoDay: string): number | null {
  const next = dayStartMs(isoDay, 1)
  return next === null ? null : next - 1
}

/* ------------------------------------------- clearing (delete) ------------------------------------------- */

/** Firestore batches hold at most 500 writes; stay well below so one clean-up entry can ride along. */
export const CLEAR_BATCH_SIZE = 450

/**
 * What an admin chose to clear. `category: ''` = every category except the protected ones.
 * `fromMs` / `toMs` are inclusive bounds on the entry time (null = open).
 */
export interface ClearScope {
  category: AuditCategory | ''
  fromMs: number | null
  toMs: number | null
}

export const ALL_NON_SECURITY: ClearScope = { category: '', fromMs: null, toMs: null }

/** Returns an error message for a scope that cannot be cleared, or null. */
export function validateClearScope(s: ClearScope): string | null {
  if (s.category && PROTECTED_CATEGORIES.includes(s.category)) return 'Security entries are the protected audit trail and can never be deleted.'
  if (s.category && !CATEGORY_IDS.includes(s.category)) return 'Choose a valid category.'
  if (s.fromMs !== null && !Number.isFinite(s.fromMs)) return 'The start date is not valid.'
  if (s.toMs !== null && !Number.isFinite(s.toMs)) return 'The end date is not valid.'
  if (s.fromMs !== null && s.toMs !== null && s.fromMs > s.toMs) return 'The start date must be on or before the end date.'
  return null
}

/** True when the entry falls inside the scope and is allowed to be deleted (never a protected category). */
export function clearScopeMatches(r: Pick<AuditRow, 'category' | 'atMs'>, s: ClearScope): boolean {
  if (PROTECTED_CATEGORIES.includes(r.category)) return false
  if (s.category && r.category !== s.category) return false
  if (s.fromMs !== null || s.toMs !== null) {
    if (r.atMs === null) return false
    if (s.fromMs !== null && r.atMs < s.fromMs) return false
    if (s.toMs !== null && r.atMs > s.toMs) return false
  }
  return true
}

/**
 * How the scope is fetched from Firestore without composite indexes: either an equality query on `category`
 * (ordered by document id) or a range scan on `at`. Legacy entries have no `category` field (they show as
 * 'license'), so the license category and every date-bounded scope use the `at` scan + client-side filter.
 */
export function clearScopeStrategy(s: ClearScope): { kind: 'category'; category: AuditCategory } | { kind: 'time'; fromMs: number | null; toMs: number | null } {
  if (s.category && s.category !== 'license' && s.fromMs === null && s.toMs === null) return { kind: 'category', category: s.category }
  return { kind: 'time', fromMs: s.fromMs, toMs: s.toMs }
}

/** Human description used in the confirmation and in the security log entry. */
export function describeClearScope(s: ClearScope, fmtDay: (ms: number) => string = (ms) => new Date(ms).toISOString().slice(0, 10)): string {
  const cat = s.category ? `${AUDIT_CATEGORIES.find((c) => c.id === s.category)?.label ?? s.category} entries` : 'all non-security entries'
  if (s.fromMs !== null && s.toMs !== null) return `${cat} from ${fmtDay(s.fromMs)} to ${fmtDay(s.toMs)}`
  if (s.fromMs !== null) return `${cat} from ${fmtDay(s.fromMs)} onwards`
  if (s.toMs !== null) return `${cat} up to ${fmtDay(s.toMs)}`
  return `${cat} of any date`
}

/** Splits ids into delete batches of at most CLEAR_BATCH_SIZE; the caller commits them in order. */
export function planClearBatches<T>(ids: readonly T[], size = CLEAR_BATCH_SIZE): T[][] {
  if (!Number.isInteger(size) || size < 1 || size > 500) throw new Error('Batch size must be 1–500.')
  return chunk(ids, size)
}

/** Removes deleted ids from already-loaded rows so they can never reappear from a stale page / cache. */
export function withoutIds<T extends { id: string }>(rows: readonly T[], deleted: ReadonlySet<string>): T[] {
  return deleted.size ? rows.filter((r) => !deleted.has(r.id)) : rows.slice()
}

/* ------------------------------------------- dashboard summary ------------------------------------------- */

/** Device activation events (online / offline activation, re-activation, rejected or failed requests). */
export function isActivationEvent(r: Pick<AuditRow, 'action'>): boolean {
  return /^(device_activated|device_reactivated|activation_[a-z_]+|offline_activation[a-z_]*)$/.test(r.action)
}

export interface RecentEventSummary {
  activations: number
  security: number
  failures: number
  /** True when the loaded window may not reach back to `sinceMs` (the counts are a lower bound). */
  truncated: boolean
}

/**
 * Counts activation / security / failed events since `sinceMs` in the newest-first `rows` (the latest `pageSize`
 * entries). When every loaded row is newer than `sinceMs` and the page was full, older matches may exist → truncated.
 */
export function summarizeRecentEvents(rows: readonly Pick<AuditRow, 'action' | 'category' | 'status' | 'atMs'>[], sinceMs: number, pageSize: number): RecentEventSummary {
  const out: RecentEventSummary = { activations: 0, security: 0, failures: 0, truncated: false }
  let oldest = Infinity
  for (const r of rows) {
    if (r.atMs !== null) oldest = Math.min(oldest, r.atMs)
    if (r.atMs === null || r.atMs < sinceMs) continue
    if (isActivationEvent(r)) out.activations++
    if (r.category === 'security') out.security++
    if (r.status === 'failure') out.failures++
  }
  out.truncated = rows.length >= pageSize && oldest >= sinceMs
  return out
}
