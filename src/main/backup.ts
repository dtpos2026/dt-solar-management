/**
 * Backup & restore. Backups are complete SQLite copies made with SQLite's online backup API
 * (consistent even while the app is running) and verified with PRAGMA integrity_check.
 * Restore never overwrites the current data without first taking a safety backup.
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, statSync, unlinkSync } from 'fs'
import { basename, join } from 'path'
import type { DB } from './db'
import { validateDatabaseFile } from './db'
import { getSetting, setSetting } from './services/context'

export const BACKUP_EXT = '.dtbak'

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

export async function createBackup(db: DB, dir: string, kind: 'manual' | 'auto' | 'pre-restore' | 'pre-migration' = 'manual'): Promise<BackupResult> {
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `DTSolarPro-${kind}-${stamp()}${BACKUP_EXT}`)
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
  return { file, size: statSync(file).size, summary: check.summary }
}

export function listBackups(dir: string): Array<{ file: string; name: string; size: number; modified: string }> {
  if (!dir || !existsSync(dir)) return []
  return readdirSync(dir)
    .filter((f) => f.endsWith(BACKUP_EXT))
    .map((f) => {
      const full = join(dir, f)
      const st = statSync(full)
      return { file: full, name: f, size: st.size, modified: st.mtime.toISOString() }
    })
    .sort((a, b) => b.modified.localeCompare(a.modified))
}

export function pruneAutoBackups(dir: string, keep: number): void {
  const autos = listBackups(dir).filter((b) => b.name.startsWith('DTSolarPro-auto-'))
  for (const b of autos.slice(Math.max(1, keep))) {
    try {
      unlinkSync(b.file)
    } catch {
      /* ignore */
    }
  }
}

export async function autoBackupIfDue(db: DB, defaultDir: string): Promise<BackupResult | null> {
  const mode = getSetting(db, 'backup_auto', 'off')
  if (mode === 'off') return null
  const last = Date.parse(getSetting(db, 'last_auto_backup', '') || '1970-01-01')
  const interval = mode === 'weekly' ? 7 * 86400000 : 86400000
  if (Date.now() - last < interval) return null
  const dir = getSetting(db, 'backup_dir', '') || defaultDir
  const r = await createBackup(db, dir, 'auto')
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
