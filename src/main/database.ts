import { copyFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { openDatabase } from './db'
import { runtime } from './runtime'
import { log } from './log'

export function openAppDatabase(): void {
  const file = runtime.paths.dbFile
  try {
    mkdirSync(runtime.paths.dataDir, { recursive: true })
    runtime.db = openDatabase(file, {
      beforeMigrate: (db, from, to) => {
        // File-level safety copy before upgrading the schema of existing customer data.
        const dir = join(runtime.paths.backups, 'safety')
        mkdirSync(dir, { recursive: true })
        db.pragma('wal_checkpoint(TRUNCATE)')
        const dest = join(dir, `DTSolarPro-pre-migration-v${from}-to-v${to}-${Date.now()}.dtbak`)
        copyFileSync(file, dest)
        log('info', `Pre-migration backup created: ${dest}`)
      }
    })
    runtime.dbError = null
  } catch (e) {
    runtime.db = null
    runtime.dbError = `Could not open the database: ${(e as Error).message}`
    log('error', runtime.dbError)
  }
}

export function reopenDatabase(): void {
  try {
    runtime.db?.close()
  } catch {
    /* ignore */
  }
  runtime.db = null
  openAppDatabase()
}

export function closeDatabase(): void {
  try {
    runtime.db?.pragma('wal_checkpoint(TRUNCATE)')
    runtime.db?.close()
  } catch {
    /* ignore */
  }
  runtime.db = null
}
