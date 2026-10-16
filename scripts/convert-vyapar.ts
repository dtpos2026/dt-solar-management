/**
 * Converts a Vyapar backup (.vyb) into DT Solar Pro backups and a reconciliation report.
 *
 *   npx vite-node scripts/convert-vyapar.ts -- <backup.vyb> <output-folder> [--password <temporary owner password>]
 *
 * Outputs (in the output folder):
 *   <name>.js1                DT Solar Pro JSON backup (restore: Backup & Restore -> JSON backup -> Restore)
 *   <name>.dtbak              the same data as a native DT Solar Pro backup (restore: Backup & Restore -> Restore)
 *   conversion-report.md      counts, totals, balances, field mapping, exceptions
 *   validation.json           machine-readable validation results
 *   id-map.csv, number-changes.csv, notes.csv
 * The source file is opened read-only and never modified. No live database is touched.
 */
import Database from 'better-sqlite3'
import { randomBytes } from 'crypto'
import { copyFileSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs'
import { basename, join, resolve } from 'path'
import { createTargetDb, convertVyapar, extractVyp } from '../src/main/legacy/vyapar'
import { validateConversion, renderReport } from '../src/main/legacy/vyaparValidate'
import { buildDatabaseFromJs1, exportJs1, readJs1, tablesHash, writeJs1 } from '../src/main/backup-json'
import { validateDatabaseFile } from '../src/main/db'

const argv = process.argv.slice(2).filter((a) => a !== '--')
const vyb = argv[0]
const outDir = argv[1]
const pwIdx = argv.indexOf('--password')
if (!vyb || !outDir) {
  console.error('Usage: vite-node scripts/convert-vyapar.ts -- <backup.vyb> <output-folder> [--password <pw>]')
  process.exit(2)
}
const password = pwIdx > 0 ? argv[pwIdx + 1] : `Dtsp-${randomBytes(4).toString('hex')}`
const appVersion = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8')).version as string

mkdirSync(outDir, { recursive: true })
const stem = basename(vyb).replace(/\.vyb$/i, '').replace(/[^\w.-]+/g, '_') + '_DTSolarPro'
const work = join(outDir, '.work')
rmSync(work, { recursive: true, force: true })
mkdirSync(work, { recursive: true })

const ex = extractVyp(resolve(vyb))
try {
  const src = new Database(ex.vypPath, { readonly: true, fileMustExist: true })
  const dbFile = join(work, 'converted.db')
  const out = createTargetDb(dbFile)
  const result = out.transaction(() => convertVyapar(src, out, { sourceFile: resolve(vyb), sourceSha256: ex.sha256, vypName: ex.vypName }, { ownerPassword: password }))()
  out.pragma('wal_checkpoint(TRUNCATE)')

  // 1) JSON backup (.js1)
  const js1 = exportJs1(out, { appVersion, source: { kind: 'vyapar-conversion', file: basename(vyb), sha256: ex.sha256, vyp: ex.vypName } })
  const js1File = join(outDir, `${stem}.js1`)
  writeJs1(js1File, js1)
  // 2) native backup (.dtbak) via SQLite online backup
  const dtbak = join(outDir, `${stem}.dtbak`)
  rmSync(dtbak, { force: true })
  out.close()
  {
    const tmp = new Database(dbFile)
    tmp.pragma('journal_mode = DELETE')
    tmp.close()
  }
  copyFileSync(dbFile, dtbak)

  // 3) validation against the source, on the converted DB
  const conv = new Database(dbFile, { readonly: true })
  const validation = validateConversion(src, conv, result)
  conv.close()

  // 4) restore tests: .js1 -> fresh DB (app's restore builder) -> compare; second export -> identical hash
  const restored = join(work, 'restored-from-js1.db')
  buildDatabaseFromJs1(readJs1(js1File), restored)
  const r = new Database(restored, { readonly: true })
  const js1b = exportJs1(r, { appVersion })
  const restoredValidation = validateConversion(src, r, result)
  r.close()
  const restored2 = join(work, 'restored-twice.db')
  buildDatabaseFromJs1(js1b, restored2)
  const r2 = new Database(restored2, { readonly: true })
  const js1c = exportJs1(r2, { appVersion })
  r2.close()
  const dtbakCheck = validateDatabaseFile(dtbak)
  const roundTrip = {
    js1Sha256: js1.sha256,
    afterFirstRestore: js1b.sha256,
    afterSecondRestore: js1c.sha256,
    identical: js1.sha256 === js1b.sha256 && js1b.sha256 === js1c.sha256,
    restoredValidationPassed: restoredValidation.failed === 0,
    dtbakValid: dtbakCheck.ok,
    dtbakSummary: dtbakCheck.summary ?? null,
    js1Bytes: statSync(js1File).size,
    dtbakBytes: statSync(dtbak).size
  }
  writeFileSync(join(outDir, 'validation.json'), JSON.stringify({ validation, roundTrip, tablesHash: tablesHash(js1.tables) }, null, 2))
  const csv = (rows: Array<Record<string, unknown>>): string => {
    if (!rows.length) return ''
    const cols = Object.keys(rows[0])
    const esc = (v: unknown): string => {
      const s = v === null || v === undefined ? '' : String(v)
      return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
    }
    return '﻿' + [cols.join(','), ...rows.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\r\n')
  }
  writeFileSync(join(outDir, 'id-map.csv'), csv(result.idChanges))
  writeFileSync(join(outDir, 'number-changes.csv'), csv(result.numberChanges))
  writeFileSync(join(outDir, 'notes.csv'), csv(result.notes as unknown as Array<Record<string, unknown>>))
  writeFileSync(join(outDir, 'conversion-report.md'), renderReport(result, validation, roundTrip, { js1: basename(js1File), dtbak: basename(dtbak), password }))
  src.close()
  console.log(JSON.stringify({ checks: validation.checks.length, failed: validation.failed, warnings: validation.warnings, roundTrip }, null, 2))
  process.exitCode = validation.failed ? 1 : 0
} finally {
  ex.cleanup()
  rmSync(work, { recursive: true, force: true })
}
