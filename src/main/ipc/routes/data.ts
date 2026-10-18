/** IPC routes - Backup, day/month closing, imports (owner: data area). Owns: backup.*, closing.*, import.*. */
import { BrowserWindow, dialog } from 'electron'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'fs'
import { basename, join } from 'path'
import { type RouteMap, ownerOnly, saveDialog, openFileDialog, csvEscape } from '../common'
import { runtime } from '../../runtime'
import { AppError, audit, getSetting, today } from '../../services/context'
import { validateDatabaseFile } from '../../db'
import { createBackup, exportBackup, exportFirmData, listBackups, replaceDatabaseFile, verifyBackup, whoFromCtx } from '../../backup'
import { reopenDatabase } from '../../database'
import * as auth from '../../services/auth'
import { restoreResetState, snapshotResetState } from '../../services/adminReset'
import * as closing from '../../services/closing'
import * as importer from '../../services/importer'
import { exportCsv } from '../../services/csvExport'

const backupDir = (db: Parameters<typeof getSetting>[0]): string => getSetting(db, 'backup_dir', '') || runtime.paths.backups
const safetyDir = (): string => join(runtime.paths.backups, 'safety')

export const dataRoutes: RouteMap = {
  /* ---------------- audit log: remove entries (owner only, after a copy is saved) ---------------- */
  'audit.clear': {
    perm: 'audit.view',
    write: true,
    handler: async (c, a) => {
      const input = { mode: a.mode as 'selected' | 'before' | 'all', ids: Array.isArray(a.ids) ? (a.ids as number[]) : [], before: typeof a.before === 'string' ? a.before : undefined }
      if (!['selected', 'before', 'all'].includes(input.mode)) throw new AppError('Choose what to remove.', 'VALIDATION')
      if (!c.ctx.user.isOwner) throw new AppError('Only the owner can remove entries from the audit log.', 'FORBIDDEN')
      const rows = auth.auditRowsFor(c.ctx, input)
      if (!rows.length) return { removed: 0, savedAs: null }
      const dir = join(runtime.paths.backups, 'audit-log')
      mkdirSync(dir, { recursive: true })
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
      const file = join(dir, `audit-log-removed-${stamp}.csv`)
      writeFileSync(file, '\uFEFF' + auth.auditCsv(rows), 'utf8')
      // A full database copy as well when the whole log is emptied.
      if (input.mode === 'all') await createBackup(c.ctx.db, safetyDir(), 'pre-restore', whoFromCtx(c.ctx, 'Before clearing the audit log'))
      return { removed: auth.clearAudit(c.ctx, input, file), savedAs: file }
    }
  },

  /* ---------------- backup (overrides the core keys) ---------------- */
  'backup.info': {
    perm: 'backup.manage',
    handler: (c) => {
      const dir = backupDir(c.ctx.db)
      const dirs = [dir, join(dir, 'day-close'), runtime.paths.backups, join(runtime.paths.backups, 'day-close'), safetyDir()]
      return {
        dir,
        defaultDir: runtime.paths.backups,
        dbFile: runtime.paths.dbFile,
        backups: listBackups(dirs),
        lastAuto: getSetting(c.ctx.db, 'last_auto_backup', ''),
        schedule: getSetting(c.ctx.db, 'backup_auto', 'off')
      }
    }
  },
  'backup.create': {
    perm: 'backup.manage',
    handler: async (c, a) => {
      let dir = backupDir(c.ctx.db)
      if (a.chooseFolder) {
        const win = BrowserWindow.fromWebContents(c.sender) ?? undefined
        const r = await dialog.showOpenDialog(win!, { properties: ['openDirectory', 'createDirectory'], title: 'Choose backup folder (USB / external drive recommended)' })
        if (r.canceled || !r.filePaths[0]) return null
        dir = r.filePaths[0]
      }
      const res = await createBackup(c.ctx.db, dir, 'manual', whoFromCtx(c.ctx))
      audit(c.ctx, 'backup', 'system', null, `Manual backup created: ${res.file}`)
      return res
    }
  },
  'backup.verify': {
    perm: 'backup.manage',
    handler: (c, a) => {
      const file = String(a.file ?? '')
      const r = verifyBackup(file)
      audit(c.ctx, 'verify', 'backup', null, `Verified backup ${basename(file)}: ${r.ok ? 'OK' : r.error}`)
      return { file, ...r }
    }
  },
  'backup.export': {
    perm: 'backup.manage',
    handler: async (c, a) => {
      const file = String(a.file ?? '')
      if (!existsSync(file)) throw new AppError('Backup file not found.', 'VALIDATION')
      const dest = await saveDialog(c.sender, basename(file), [{ name: 'DT Solar Pro Backup', extensions: ['dtbak'] }])
      if (!dest) return null
      try {
        const r = exportBackup(file, dest)
        audit(c.ctx, 'export', 'backup', null, `Exported backup ${basename(file)} to ${dest}`)
        return r
      } catch (e) {
        throw new AppError((e as Error).message, 'BACKUP')
      }
    }
  },
  'backup.exportFirm': {
    perm: 'backup.manage',
    handler: async (c) => {
      const data = exportFirmData(c.ctx)
      const firmName = String((data.firm as { name?: string } | undefined)?.name ?? 'firm').replace(/[^\w-]+/g, '_')
      const dest = await saveDialog(c.sender, `${firmName}-export-${today()}.json`, [{ name: 'JSON', extensions: ['json'] }])
      if (!dest) return null
      writeFileSync(dest, JSON.stringify(data, null, 2))
      return { file: dest, size: statSync(dest).size }
    }
  },
  'backup.restore': {
    perm: 'backup.manage',
    handler: async (c, a) => {
      ownerOnly(c)
      const file = String(a.file ?? '')
      const check = validateDatabaseFile(file)
      if (!check.ok) throw new AppError(check.error ?? 'Invalid backup.', 'VALIDATION')
      if (a.confirm !== 'RESTORE') throw new AppError('Type RESTORE to confirm.', 'VALIDATION')
      // Safety copy of the current data first - never lose the existing database.
      const safety = await createBackup(c.ctx.db, safetyDir(), 'pre-restore', whoFromCtx(c.ctx, `Before restoring ${basename(file)}`))
      audit(c.ctx, 'restore', 'system', null, `Restoring backup ${file}. Safety copy: ${safety.file}`)
      const resetState = snapshotResetState(c.ctx.db)
      runtime.db!.close()
      runtime.db = null
      try {
        replaceDatabaseFile(runtime.paths.dbFile, file)
      } catch (e) {
        replaceDatabaseFile(runtime.paths.dbFile, safety.file)
        reopenDatabase()
        throw new AppError(`Restore failed and your previous data was put back: ${(e as Error).message}`, 'RESTORE')
      }
      reopenDatabase()
      restoreResetState(runtime.db!, resetState)
      runtime.session = null
      return { restored: true, safety: safety.file }
    }
  },

  /* ---------------- closing ---------------- */
  'closing.previewDay': { perm: 'closing.manage', handler: (c, a) => closing.previewDay(c.ctx, String(a.date ?? today())) },
  'closing.previewMonth': { perm: 'closing.manage', handler: (c, a) => closing.previewMonth(c.ctx, String(a.month ?? today().slice(0, 7))) },
  'closing.close': {
    perm: 'closing.manage',
    write: true,
    handler: async (c, a) => {
      const id = closing.closePeriod(c.ctx, { kind: a.kind, period: String(a.period ?? ''), countedCash: a.countedCash, notes: a.notes })
      let backup: string | null = null
      let backupError: string | null = null
      if (getSetting(c.ctx.db, 'backup_on_day_close', true)) {
        try {
          const r = await createBackup(c.ctx.db, join(backupDir(c.ctx.db), 'day-close'), 'day-close', whoFromCtx(c.ctx, `${a.kind === 'month' ? 'Month' : 'Day'} close ${a.period}`))
          closing.setClosingBackup(c.ctx, id, r.file)
          backup = r.file
        } catch (e) {
          backupError = (e as Error).message
          audit(c.ctx, 'backup', 'day_closing', id, `Day-close backup failed: ${backupError}`)
        }
      }
      return { id, backup, backupError }
    }
  },
  'closing.reopen': { perm: 'closing.reopen', write: true, handler: (c, a) => closing.reopenPeriod(c.ctx, Number(a.id), String(a.reason ?? '')) },
  'closing.list': { perm: 'closing.manage', handler: (c, a) => closing.listClosings(c.ctx, a ?? {}) },
  'closing.get': { perm: 'closing.manage', handler: (c, a) => closing.getClosing(c.ctx, Number(a.id)) },
  'closing.exportCsv': {
    perm: 'closing.manage',
    handler: async (c, a) => {
      const rows = closing.listClosings(c.ctx, a ?? {})
      const dest = await saveDialog(c.sender, `closings-${today()}.csv`, [{ name: 'CSV', extensions: ['csv'] }])
      if (!dest) return null
      const cols = closing.CLOSING_CSV_COLUMNS
      const csv = [cols.map(([, l]) => csvEscape(l)).join(','), ...rows.map((r) => cols.map(([k]) => csvEscape(r[k])).join(','))].join('\r\n')
      writeFileSync(dest, '﻿' + csv)
      return { file: dest, rows: rows.length }
    }
  },

  /* ---------------- import ---------------- */
  'import.fields': { perm: 'import.manage', handler: (_c, a) => importer.importFields(a.kind) },
  'import.pickFile': {
    perm: 'import.manage',
    handler: async (c) => {
      const file = await openFileDialog(c.sender, 'Select a CSV file', [{ name: 'CSV', extensions: ['csv', 'txt'] }])
      if (!file) return null
      if (statSync(file).size > 20 * 1024 * 1024) throw new AppError('The file is larger than 20 MB.', 'VALIDATION')
      return { fileName: basename(file), text: readFileSync(file, 'utf8') }
    }
  },
  'import.analyze': { perm: 'import.manage', handler: (c, a) => importer.analyzeImport(c.ctx, { ...importOpts(a), dryRun: !!a.dryRun }) },
  'import.run': {
    perm: 'import.manage',
    write: true,
    handler: (c, a) => importer.runImport(c.ctx, { ...importOpts(a), fileName: a.fileName ? String(a.fileName) : undefined })
  },
  'import.runs': { perm: 'import.manage', handler: (c) => importer.listImportRuns(c.ctx) },
  'import.template': {
    perm: 'import.manage',
    handler: async (c, a) => {
      const dest = await saveDialog(c.sender, `${a.kind}-template.csv`, [{ name: 'CSV', extensions: ['csv'] }])
      if (!dest) return null
      writeFileSync(dest, importer.importTemplate(a.kind))
      return { file: dest }
    }
  },
  /* ---------------- CSV export (same columns as the import, so a file round-trips) ---------------- */
  'csv.export': {
    perm: 'backup.manage',
    handler: async (c, a) => {
      const r = exportCsv(c.ctx, a.kind, { from: a.from ? String(a.from) : undefined, to: a.to ? String(a.to) : undefined })
      const dest = await saveDialog(c.sender, `${r.kind}-${today()}.csv`, [{ name: 'CSV', extensions: ['csv'] }])
      if (!dest) return null
      writeFileSync(dest, r.text, 'utf8')
      audit(c.ctx, 'export', 'csv', null, `Exported ${r.rows} ${r.kind} row(s) to CSV: ${basename(dest)}`)
      return { file: dest, rows: r.rows }
    }
  }
}

function importOpts(a: Record<string, unknown>): importer.ImportOptions {
  return {
    kind: importer.assertKind(a.kind),
    text: String(a.text ?? ''),
    mapping: a.mapping && typeof a.mapping === 'object' ? (a.mapping as importer.Mapping) : undefined,
    dateFormat: a.dateFormat === 'dmy' ? 'dmy' : 'ymd',
    duplicates: a.duplicates === 'update' ? 'update' : 'skip',
    skipInvalid: !!a.skipInvalid
  }
}
