/**
 * Backup & restore (owner: data area). Backups are complete SQLite copies made with SQLite's online backup API
 * (consistent even while the app is running) and verified with PRAGMA integrity_check.
 * Restore never overwrites the current data without first taking a safety backup.
 * Each backup gets a small `<file>.json` sidecar (kind, firm, user, integrity) that survives restores of the live DB.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'fs'
import { basename, join } from 'path'
import type { DB } from './db'
import { validateDatabaseFile } from './db'
import { Ctx, audit, getSetting, requirePerm, setSetting } from './services/context'

export const BACKUP_EXT = '.dtbak'

export type BackupKind = 'manual' | 'auto' | 'day-close' | 'pre-restore' | 'pre-migration'

function stamp(): string {
  const d = new Date()
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

export interface BackupResult {
  file: string
  size: number
  summary?: Record<string, unknown>
}

export interface BackupWho {
  firmId?: number | null
  firmName?: string | null
  userId?: number | null
  userName?: string | null
  note?: string | null
}

export interface BackupMeta extends BackupWho {
  kind: BackupKind
  createdAt: string
  integrity?: 'ok' | 'failed'
  integrityError?: string | null
  verifiedAt?: string
  schemaVersion?: number
}

const metaFile = (file: string): string => file + '.json'

export function readMeta(file: string): BackupMeta | null {
  try {
    return JSON.parse(readFileSync(metaFile(file), 'utf8')) as BackupMeta
  } catch {
    return null
  }
}

function writeMeta(file: string, meta: BackupMeta): void {
  try {
    writeFileSync(metaFile(file), JSON.stringify(meta, null, 2))
  } catch {
    /* read-only media: metadata is optional */
  }
}

export function kindFromName(name: string): BackupKind | 'unknown' {
  const m = /^DTSolarPro-(manual|auto|day-close|pre-restore|pre-migration)-/.exec(name)
  return m ? (m[1] as BackupKind) : 'unknown'
}

/** Who is making a backup, from a session context (firm + user names for the history list). */
export function whoFromCtx(ctx: Ctx, note?: string): BackupWho {
  const firm = ctx.firmId ? (ctx.db.prepare('SELECT name FROM firms WHERE id = ?').get(ctx.firmId) as { name: string } | undefined) : undefined
  return { firmId: ctx.firmId || null, firmName: firm?.name ?? null, userId: ctx.user.id, userName: ctx.user.fullName || ctx.user.username, note: note ?? null }
}

export async function createBackup(db: DB, dir: string, kind: BackupKind = 'manual', who?: BackupWho): Promise<BackupResult> {
  mkdirSync(dir, { recursive: true })
  let file = join(dir, `DTSolarPro-${kind}-${stamp()}${BACKUP_EXT}`)
  for (let i = 2; existsSync(file); i++) file = join(dir, `DTSolarPro-${kind}-${stamp()}-${i}${BACKUP_EXT}`)
  await db.backup(file)
  const check = validateDatabaseFile(file)
  if (!check.ok) {
    try {
      unlinkSync(file)
    } catch {
      /* ignore */
    }
    throw new Error(`Backup verification failed: ${check.error}. Try another folder or free disk space.`)
  }
  const now = new Date().toISOString()
  writeMeta(file, { kind, createdAt: now, ...who, integrity: 'ok', verifiedAt: now, schemaVersion: check.schemaVersion })
  return { file, size: statSync(file).size, summary: check.summary }
}

export interface BackupEntry {
  file: string
  name: string
  size: number
  modified: string
  kind: BackupKind | 'unknown'
  meta: BackupMeta | null
}

/** Backups in one or more folders (newest first). Folders are scanned non-recursively. */
export function listBackups(dir: string | string[]): BackupEntry[] {
  const dirs = (Array.isArray(dir) ? dir : [dir]).filter((d, i, a) => !!d && a.indexOf(d) === i && existsSync(d))
  const out: BackupEntry[] = []
  for (const d of dirs) {
    for (const f of readdirSync(d)) {
      if (!f.endsWith(BACKUP_EXT)) continue
      const full = join(d, f)
      const st = statSync(full)
      const meta = readMeta(full)
      out.push({ file: full, name: f, size: st.size, modified: st.mtime.toISOString(), kind: meta?.kind ?? kindFromName(f), meta })
    }
  }
  return out.sort((a, b) => b.modified.localeCompare(a.modified))
}

/** Full integrity check of a backup file; the result is remembered in the backup's metadata. */
export function verifyBackup(file: string): ReturnType<typeof validateDatabaseFile> {
  if (!existsSync(file)) return { ok: false, error: 'Backup file not found.' }
  const r = validateDatabaseFile(file)
  const prev = readMeta(file)
  const k = kindFromName(basename(file))
  writeMeta(file, {
    ...(prev ?? { kind: k === 'unknown' ? 'manual' : k, createdAt: statSync(file).mtime.toISOString() }),
    integrity: r.ok ? 'ok' : 'failed',
    integrityError: r.ok ? null : (r.error ?? null),
    verifiedAt: new Date().toISOString(),
    schemaVersion: r.schemaVersion ?? prev?.schemaVersion
  })
  return r
}

/** Copies a verified backup (and its metadata) to a location chosen by the user, then verifies the copy. */
export function exportBackup(file: string, dest: string): { file: string; size: number } {
  const r = validateDatabaseFile(file)
  if (!r.ok) throw new Error(r.error ?? 'Backup failed the integrity check and was not exported.')
  copyFileSync(file, dest)
  const check = validateDatabaseFile(dest)
  if (!check.ok) {
    try {
      unlinkSync(dest)
    } catch {
      /* ignore */
    }
    throw new Error(`The exported copy failed verification: ${check.error}`)
  }
  const meta = readMeta(file)
  if (meta) writeMeta(dest, meta)
  return { file: dest, size: statSync(dest).size }
}

export function pruneAutoBackups(dir: string, keep: number): void {
  const autos = listBackups(dir).filter((b) => b.kind === 'auto')
  for (const b of autos.slice(Math.max(1, keep))) {
    for (const f of [b.file, metaFile(b.file)]) {
      try {
        if (existsSync(f)) unlinkSync(f)
      } catch {
        /* ignore */
      }
    }
  }
}

/** Runs the scheduled backup when it is due. Called at start-up and by a timer while the app stays open. */
export async function autoBackupIfDue(db: DB, defaultDir: string): Promise<BackupResult | null> {
  const mode = getSetting(db, 'backup_auto', 'off')
  if (mode === 'off') return null
  const last = Date.parse(getSetting(db, 'last_auto_backup', '') || '1970-01-01')
  const interval = mode === 'weekly' ? 7 * 86400000 : 86400000
  if (Date.now() - last < interval) return null
  const dir = getSetting(db, 'backup_dir', '') || defaultDir
  const r = await createBackup(db, dir, 'auto', { userName: 'Scheduled backup' })
  setSetting(db, 'last_auto_backup', new Date().toISOString())
  pruneAutoBackups(dir, getSetting(db, 'backup_keep', 15))
  return r
}

/**
 * Replace the live database with a verified backup.
 * The caller must close the current DB handle before calling and reopen it afterwards.
 */
export function replaceDatabaseFile(dbFile: string, backupFile: string): void {
  const check = validateDatabaseFile(backupFile)
  if (!check.ok) throw new Error(check.error)
  for (const ext of ['-wal', '-shm']) {
    if (existsSync(dbFile + ext)) unlinkSync(dbFile + ext)
  }
  const tmp = dbFile + '.restoring'
  copyFileSync(backupFile, tmp)
  renameSync(tmp, dbFile)
}

export function backupName(file: string): string {
  return basename(file)
}

/* ------------------------------------------------------------- firm data export ------------------------------------------------------------- */

/**
 * JSON export of everything that belongs to the active firm (for archiving / hand-over). Read-only.
 * Shared catalog rows (products, parties with firm_id NULL) are included because the firm's documents refer to them.
 */
export function exportFirmData(ctx: Ctx): Record<string, unknown> {
  requirePerm(ctx, 'backup.manage')
  const db = ctx.db
  const f = ctx.firmId
  const all = (sql: string): unknown[] => db.prepare(sql).all(sql.includes('?') ? [f] : [])
  const data = {
    format: 'dt-solar-pro-firm-export',
    version: 1,
    exportedAt: new Date().toISOString(),
    exportedBy: ctx.user.username,
    firm: db.prepare('SELECT * FROM firms WHERE id = ?').get(f),
    accounts: all('SELECT * FROM accounts WHERE firm_id = ?'),
    parties: all('SELECT * FROM parties WHERE firm_id IS NULL OR firm_id = ?'),
    categories: all('SELECT * FROM categories'),
    products: all('SELECT * FROM products WHERE firm_id IS NULL OR firm_id = ?'),
    documents: all('SELECT * FROM documents WHERE firm_id = ? ORDER BY date, id'),
    documentLines: all('SELECT l.* FROM document_lines l JOIN documents d ON d.id = l.document_id WHERE d.firm_id = ? ORDER BY l.document_id, l.id'),
    payments: all('SELECT * FROM payments WHERE firm_id = ? ORDER BY date, id'),
    paymentAllocations: all('SELECT a.* FROM payment_allocations a JOIN payments p ON p.id = a.payment_id WHERE p.firm_id = ?'),
    accountTransfers: all('SELECT * FROM account_transfers WHERE firm_id = ?'),
    partyAdjustments: all('SELECT * FROM party_adjustments WHERE firm_id = ?'),
    expenseCategories: all('SELECT * FROM expense_categories'),
    expenses: all('SELECT * FROM expenses WHERE firm_id = ? ORDER BY date, id'),
    projects: all('SELECT * FROM projects WHERE firm_id = ?'),
    materialMoves: all('SELECT * FROM material_moves WHERE firm_id = ?'),
    materialMoveLines: all('SELECT l.* FROM material_move_lines l JOIN material_moves m ON m.id = l.move_id WHERE m.firm_id = ?'),
    closings: all('SELECT * FROM day_closings WHERE firm_id = ? ORDER BY period_start')
  }
  audit(ctx, 'export', 'firm', f, 'Exported firm data (JSON)')
  return data
}
