/** IPC routes - JSON backups (.js1) and legacy software imports (owner: integrator). Owns: jsonBackup.*, legacy.* */
import Database from 'better-sqlite3'
import { randomBytes } from 'crypto'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { shell } from 'electron'
import type { RouteMap } from '../common'
import { openFileDialog, ownerOnly, saveDialog } from '../common'
import { runtime } from '../../runtime'
import { AppError, audit, requirePerm } from '../../services/context'
import { JS1_EXT, buildDatabaseFromJs1, exportJs1, readJs1, summarizeJs1, writeJs1 } from '../../backup-json'
import { createBackup, replaceDatabaseFile } from '../../backup'
import { reopenDatabase } from '../../database'
import { convertVyapar, createTargetDb, extractVyp } from '../../legacy/vyapar'
import { carryOverInstallation, type CarryOverResult } from '../../legacy/carryOver'
import { validateDatabaseFile } from '../../db'
import { restoreResetState, snapshotResetState } from '../../services/adminReset'
import { renderReport, validateConversion } from '../../legacy/vyaparValidate'

const stamp = (): string => new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')

/** The most recent converted / inspected .js1 files the user picked (only these may be restored by path). */
const allowedJs1 = new Set<string>()

export const legacyRoutes: RouteMap = {
  'jsonBackup.export': {
    perm: 'backup.manage',
    handler: async (c) => {
      const file = await saveDialog(c.sender, `DTSolarPro-${stamp()}${JS1_EXT}`, [{ name: 'DT Solar Pro JSON backup', extensions: ['js1'] }])
      if (!file) return null
      const data = exportJs1(c.ctx.db, { appVersion: runtime.appVersion, source: { kind: 'export', by: c.ctx.user.username } })
      writeJs1(file, data)
      readJs1(file) // verify what was written (checksum + counts)
      audit(c.ctx, 'backup', 'system', null, `JSON backup exported: ${file}`)
      return { file, counts: data.counts }
    }
  },

  'jsonBackup.inspect': {
    perm: 'backup.manage',
    handler: async (c, a) => {
      let file = typeof a.file === 'string' && allowedJs1.has(a.file) ? a.file : null
      if (!file) file = await openFileDialog(c.sender, 'Select a DT Solar Pro JSON backup', [{ name: 'DT Solar Pro JSON backup', extensions: ['js1', 'json'] }])
      if (!file) return null
      const data = readJs1(file)
      allowedJs1.add(file)
      const s = summarizeJs1(data)
      const n = (t: string): number => s.counts[t] ?? 0
      return {
        file,
        ...s,
        summary: { firms: n('firms'), users: n('users'), parties: n('parties'), products: n('products'), documents: n('documents'), payments: n('payments'), expenses: n('expenses') }
      }
    }
  },

  'jsonBackup.restore': {
    perm: 'backup.manage',
    handler: async (c, a) => {
      ownerOnly(c)
      const file = String(a.file ?? '')
      if (!allowedJs1.has(file) || !existsSync(file)) throw new AppError('Select the JSON backup again.', 'VALIDATION')
      if (a.confirm !== 'RESTORE') throw new AppError('Type RESTORE to confirm.', 'VALIDATION')
      const data = readJs1(file)
      // Rebuild into a separate file first; the live database is untouched until everything checked out.
      const staging = join(runtime.paths.dataDir, `restore-staging-${randomBytes(4).toString('hex')}.db`)
      buildDatabaseFromJs1(data, staging)
      // A converted backup holds only a one-off temporary password. The owner who restores is already signed in and has confirmed,
      // so this installation's accounts (hashes copied as they are) and device settings are kept: the existing password keeps working.
      let carried: CarryOverResult | null = null
      try {
        if (data.source?.kind === 'vyapar-conversion' && a.keepAccounts !== false) carried = carryOverInstallation(c.ctx.db, staging)
        const check = validateDatabaseFile(staging)
        if (!check.ok) throw new Error(check.error ?? 'integrity check failed')
      } catch (e) {
        rmSync(staging, { force: true })
        throw new AppError(`The restored data did not pass its checks, so nothing was changed: ${(e as Error).message}`, 'RESTORE')
      }
      const safety = await createBackup(c.ctx.db, join(runtime.paths.backups, 'safety'), 'pre-restore')
      audit(c.ctx, 'restore', 'system', null, `Restoring JSON backup ${file}. Safety copy: ${safety.file}`)
      const resetState = snapshotResetState(c.ctx.db)
      runtime.db!.close()
      runtime.db = null
      try {
        replaceDatabaseFile(runtime.paths.dbFile, staging)
      } catch (e) {
        replaceDatabaseFile(runtime.paths.dbFile, safety.file)
        reopenDatabase()
        throw new AppError(`Restore failed and your previous data was put back: ${(e as Error).message}`, 'RESTORE')
      } finally {
        rmSync(staging, { force: true })
      }
      reopenDatabase()
      restoreResetState(runtime.db!, resetState)
      runtime.session = null
      return { restored: true, safety: safety.file, carried }
    }
  },

  'legacy.convertVyapar': {
    perm: 'import.manage',
    handler: async (c) => {
      requirePerm(c.ctx, 'backup.manage')
      const vyb = await openFileDialog(c.sender, 'Select a Vyapar backup (.vyb)', [{ name: 'Vyapar backup', extensions: ['vyb'] }])
      if (!vyb) return null
      const target = await saveDialog(c.sender, vyb.replace(/\.vyb$/i, '') + `_DTSolarPro${JS1_EXT}`, [{ name: 'DT Solar Pro JSON backup', extensions: ['js1'] }])
      if (!target) return null
      const work = join(runtime.paths.dataDir, `vyapar-${randomBytes(4).toString('hex')}`)
      mkdirSync(work, { recursive: true })
      const ex = extractVyp(vyb)
      const password = `Dtsp-${randomBytes(4).toString('hex')}`
      try {
        const src = new Database(ex.vypPath, { readonly: true, fileMustExist: true })
        const out = createTargetDb(join(work, 'converted.db'))
        try {
          const result = out.transaction(() => convertVyapar(src, out, { sourceFile: vyb, sourceSha256: ex.sha256, vypName: ex.vypName }, { ownerPassword: password }))()
          const validation = validateConversion(src, out, result)
          const data = exportJs1(out, { appVersion: runtime.appVersion, source: { kind: 'vyapar-conversion', file: vyb.split(/[\\/]/).pop(), sha256: ex.sha256 } })
          writeJs1(target, data)
          readJs1(target)
          const reportFile = target.replace(/\.js1$/i, '') + '-conversion-report.md'
          writeFileSync(reportFile, renderReport(result, validation, { restoredValidationPassed: 'not run in app', identical: 'not run in app', dtbakValid: 'n/a' }, { js1: target.split(/[\\/]/).pop()!, dtbak: '(not created in the app)', password }))
          allowedJs1.add(target)
          audit(c.ctx, 'import', 'system', null, `Vyapar backup converted: ${vyb} -> ${target} (${validation.checks.length} checks, ${validation.failed} failed)`)
          return {
            file: target,
            report: reportFile,
            password,
            checks: validation.checks.length,
            failed: validation.failed,
            failedChecks: validation.checks.filter((x) => !x.pass).map((x) => `${x.name}: expected ${x.expected}, got ${x.actual}`),
            warnings: result.notes.filter((n) => n.level !== 'info').map((n) => n.message),
            counts: data.counts
          }
        } finally {
          src.close()
          out.close()
        }
      } finally {
        ex.cleanup()
        rmSync(work, { recursive: true, force: true })
      }
    }
  },

  'legacy.openReport': {
    perm: 'backup.manage',
    handler: (_c, a) => {
      const f = String(a.file ?? '')
      if (!/-conversion-report\.md$/i.test(f) || !existsSync(f)) throw new AppError('Report not found.', 'NOT_FOUND')
      return shell.openPath(f)
    }
  }
}
