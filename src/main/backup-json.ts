/**
 * DT Solar Pro JSON backup - ".js1" (JSON snapshot, format version 1).
 *
 * A complete, human-auditable copy of every table of the business database:
 *   { format: 'dtsp-js1', version: 1, app, appVersion, schemaVersion, createdAt, source, counts, sha256, tables }
 *   tables[name] = { columns: string[], rows: unknown[][] }   (BLOB values are stored as { $b64: '...' })
 * sha256 is computed over the canonical JSON of `tables`, so any modification of the data is detected on restore.
 *
 * Restore never touches the live database directly: the snapshot is rebuilt into a NEW database file (created by the
 * app's own migrations, so the schema is always current), checked (row counts, foreign keys, integrity), and only then
 * handed to the normal restore flow (safety backup of the current data + file replacement).
 * The native .dtbak (SQLite) backup stays the authoritative everyday format; .js1 is fully equivalent and restorable.
 */
import Database from 'better-sqlite3'
import { createHash } from 'crypto'
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'fs'
import type { DB } from './db'
import { APP_DB_MARKER, configure, getSchemaVersion, migrate, validateDatabaseFile } from './db'
import { LATEST_SCHEMA_VERSION } from './db/migrations'

export const JS1_EXT = '.js1'
export const JS1_FORMAT = 'dtsp-js1'

export interface Js1Table {
  columns: string[]
  rows: unknown[][]
}

export interface Js1File {
  format: typeof JS1_FORMAT
  version: 1
  app: string
  appVersion: string
  schemaVersion: number
  createdAt: string
  source: Record<string, unknown>
  counts: Record<string, number>
  sha256: string
  tables: Record<string, Js1Table>
}

/** Tables that are rebuilt by the app itself and never exported. */
const SKIP_TABLES = new Set(['schema_migrations', 'sqlite_sequence'])

function userTables(db: DB): string[] {
  return (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ name: string }>)
    .map((r) => r.name)
    .filter((n) => !SKIP_TABLES.has(n))
}

function encodeValue(v: unknown): unknown {
  if (Buffer.isBuffer(v)) return { $b64: v.toString('base64') }
  if (typeof v === 'bigint') return Number(v)
  return v
}

function decodeValue(v: unknown): unknown {
  if (v && typeof v === 'object' && '$b64' in (v as Record<string, unknown>)) return Buffer.from(String((v as { $b64: string }).$b64), 'base64')
  return v
}

/** Canonical hash of the table data (table names sorted; rows kept in exported order = primary-key order). */
export function tablesHash(tables: Record<string, Js1Table>): string {
  const h = createHash('sha256')
  for (const name of Object.keys(tables).sort()) {
    const t = tables[name]
    h.update(JSON.stringify([name, t.columns, t.rows]))
  }
  return h.digest('hex')
}

export function exportJs1(db: DB, meta: { appVersion: string; source?: Record<string, unknown> }): Js1File {
  const tables: Record<string, Js1Table> = {}
  const counts: Record<string, number> = {}
  const read = db.transaction(() => {
    for (const name of userTables(db)) {
      const columns = (db.prepare(`PRAGMA table_info("${name}")`).all() as Array<{ name: string; pk: number }>).map((c) => c.name)
      const pk = (db.prepare(`PRAGMA table_info("${name}")`).all() as Array<{ name: string; pk: number }>).filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk)
      const order = pk.length ? pk.map((c) => `"${c.name}"`).join(', ') : 'rowid'
      const rows = (db.prepare(`SELECT * FROM "${name}" ORDER BY ${order}`).raw(true).all() as unknown[][]).map((r) => r.map(encodeValue))
      tables[name] = { columns, rows }
      counts[name] = rows.length
    }
  })
  read()
  return {
    format: JS1_FORMAT,
    version: 1,
    app: 'DT Solar Pro',
    appVersion: meta.appVersion,
    schemaVersion: getSchemaVersion(db),
    createdAt: new Date().toISOString(),
    source: meta.source ?? { kind: 'export' },
    counts,
    sha256: tablesHash(tables),
    tables
  }
}

export function writeJs1(file: string, data: Js1File): void {
  const tmp = `${file}.tmp`
  writeFileSync(tmp, JSON.stringify(data), 'utf8')
  renameSync(tmp, file)
}

/** Parses and verifies a .js1 file (format, version, schema, checksum, row counts). Throws a readable error. */
export function readJs1(file: string): Js1File {
  if (!existsSync(file)) throw new Error('Backup file not found.')
  let data: Js1File
  try {
    data = JSON.parse(readFileSync(file, 'utf8')) as Js1File
  } catch {
    throw new Error('This file is not a valid DT Solar Pro JSON backup (it could not be read as JSON).')
  }
  if (data?.format !== JS1_FORMAT || data.version !== 1 || typeof data.tables !== 'object' || !data.tables) {
    throw new Error('This file is not a DT Solar Pro JSON backup (.js1).')
  }
  if (!Number.isInteger(data.schemaVersion) || data.schemaVersion < 1) throw new Error('The backup does not state its schema version.')
  if (data.schemaVersion > LATEST_SCHEMA_VERSION) {
    throw new Error(`This backup was made by a newer version of DT Solar Pro (schema v${data.schemaVersion}). Update the app first.`)
  }
  for (const [name, t] of Object.entries(data.tables)) {
    if (!Array.isArray(t?.columns) || !Array.isArray(t?.rows)) throw new Error(`Table "${name}" in the backup is malformed.`)
    if (data.counts && data.counts[name] !== undefined && data.counts[name] !== t.rows.length) {
      throw new Error(`Table "${name}" has ${t.rows.length} rows but the backup header says ${data.counts[name]}. The file is incomplete.`)
    }
  }
  if (tablesHash(data.tables) !== data.sha256) throw new Error('The backup checksum does not match - the file was modified or is damaged.')
  return data
}

export interface Js1Summary {
  schemaVersion: number
  createdAt: string
  appVersion: string
  source: Record<string, unknown>
  counts: Record<string, number>
}

export function summarizeJs1(data: Js1File): Js1Summary {
  return { schemaVersion: data.schemaVersion, createdAt: data.createdAt, appVersion: data.appVersion, source: data.source, counts: data.counts }
}

/**
 * Rebuilds a .js1 snapshot into a NEW database file (never the live one). The schema comes from the app's migrations;
 * rows are inserted with their original ids. Returns the validation result of the new file.
 */
export function buildDatabaseFromJs1(data: Js1File, targetFile: string): { ok: true; counts: Record<string, number> } {
  for (const f of [targetFile, `${targetFile}-wal`, `${targetFile}-shm`]) if (existsSync(f)) unlinkSync(f)
  const db = new Database(targetFile)
  try {
    configure(db)
    migrate(db) // creates the current schema; seed data is NOT added - every row comes from the backup
    // Rows the migrations seed by themselves (app_meta) are replaced by the backup's own rows.
    db.prepare('DELETE FROM app_meta').run()
    db.pragma('foreign_keys = OFF')
    const known = new Set(userTables(db))
    const counts: Record<string, number> = {}
    const load = db.transaction(() => {
      for (const [name, t] of Object.entries(data.tables)) {
        if (SKIP_TABLES.has(name)) continue
        if (!known.has(name)) throw new Error(`The backup contains an unknown table "${name}". Update the app first.`)
        const have = new Set((db.prepare(`PRAGMA table_info("${name}")`).all() as Array<{ name: string }>).map((c) => c.name))
        for (const c of t.columns) if (!have.has(c)) throw new Error(`The backup contains an unknown column "${name}.${c}". Update the app first.`)
        if (t.rows.length === 0) {
          counts[name] = 0
          continue
        }
        const ins = db.prepare(`INSERT INTO "${name}" (${t.columns.map((c) => `"${c}"`).join(', ')}) VALUES (${t.columns.map(() => '?').join(', ')})`)
        for (const row of t.rows) {
          if (!Array.isArray(row) || row.length !== t.columns.length) throw new Error(`A row of "${name}" does not match its columns.`)
          ins.run(...row.map(decodeValue))
        }
        counts[name] = (db.prepare(`SELECT COUNT(*) AS c FROM "${name}"`).get() as { c: number }).c
        if (counts[name] !== t.rows.length) throw new Error(`Table "${name}": ${counts[name]} rows restored, ${t.rows.length} expected.`)
      }
    })
    load()
    db.pragma('foreign_keys = ON')
    const fk = db.prepare('PRAGMA foreign_key_check').all() as unknown[]
    if (fk.length) throw new Error(`The backup has ${fk.length} broken reference(s) between records; nothing was restored.`)
    const marker = db.prepare("SELECT value FROM app_meta WHERE key = 'app'").get() as { value: string } | undefined
    if (!marker) db.prepare("INSERT INTO app_meta (key, value) VALUES ('app', ?)").run(APP_DB_MARKER)
    db.pragma('wal_checkpoint(TRUNCATE)')
    db.pragma('journal_mode = DELETE')
    db.close()
  } catch (e) {
    db.close()
    for (const f of [targetFile, `${targetFile}-wal`, `${targetFile}-shm`]) if (existsSync(f)) unlinkSync(f)
    throw e
  }
  const check = validateDatabaseFile(targetFile)
  if (!check.ok) throw new Error(`The rebuilt database failed validation: ${check.error}`)
  return { ok: true, counts: Object.fromEntries(Object.entries(data.counts ?? {})) }
}
