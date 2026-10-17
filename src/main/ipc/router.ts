/**
 * Single, whitelisted IPC entry point. The renderer can ONLY call the methods listed here.
 * Each route declares whether it needs a session, which permission(s) it requires and whether it writes data
 * (writes are refused while the license is read-only). Services perform their own finer checks as well.
 */
import { BrowserWindow, WebContents, dialog, shell } from 'electron'
import { type Args, type Route, ownerOnly, licenseLimits, publicCtx, saveDialog, csvEscape } from './common'
import { documentRoutes } from './routes/documents'
import { catalogRoutes } from './routes/catalog'
import { dataRoutes } from './routes/data'
import { accessRoutes, sessionGate } from './routes/access'
import { cloudRoutes } from './routes/cloud'
import { assistRoutes } from './routes/assist'
import { legacyRoutes } from './routes/legacy'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { runtime, getDb } from '../runtime'
import { AppError, Ctx, canAccessFirm, getSetting, audit } from '../services/context'
import * as auth from '../services/auth'
import * as firms from '../services/firms'
import * as settings from '../services/settings'
import * as inv from '../services/inventory'
import * as parties from '../services/parties'
import * as docs from '../services/documents'
import * as pay from '../services/payments'
import * as exp from '../services/expenses'
import * as proj from '../services/projects'
import * as rep from '../services/reports'
import { runSetup } from '../services/setup'
import { autoBackupIfDue, createBackup, listBackups, replaceDatabaseFile } from '../backup'
import { validateDatabaseFile } from '../db'
import { openPrintWindow } from '../windows'
import { reopenDatabase } from '../database'
import { VENDOR } from '../../shared/branding'

const coreRoutes: Record<string, Route> = {
  /* ---------------- app & session ---------------- */
  'app.info': {
    public: true,
    handler: () => {
      const db = runtime.db
      return {
        version: runtime.appVersion,
        vendor: VENDOR,
        dbError: runtime.dbError,
        hasUsers: db ? auth.userCount(db) > 0 : false,
        license: runtime.license?.status(true) ?? null,
        session: runtime.session ? { locked: runtime.session.locked } : null,
        platform: process.platform
      }
    }
  },
  'app.activity': { handler: () => true },
  'app.openExternal': {
    public: true,
    handler: (_c, a) => {
      const url = String(a.url ?? '')
      if (!/^(https:\/\/|mailto:|tel:|https:\/\/wa\.me\/)/.test(url)) throw new AppError('Link not allowed.', 'VALIDATION')
      return shell.openExternal(url)
    }
  },
  'auth.setup': {
    public: true,
    handler: (_c, a) => {
      const db = getDb()
      if (a.demoData && !runtime.license?.status(true).canWrite) throw new AppError('Activate a license first.', 'LICENSE')
      const r = runSetup(db, a as never)
      const user = auth.buildSessionUser(db, r.userId)
      runtime.session = { user, firmId: r.firmId, locked: false, lastActivity: Date.now() }
      return { user, firmId: r.firmId }
    }
  },
  'auth.login': {
    public: true,
    handler: (_c, a) => {
      const db = getDb()
      const { user, lastFirmId } = auth.login(db, a.username, a.password)
      const accessible = firms.listFirms(db, user) as Array<{ id: number; is_default: number; is_active: number }>
      const active = accessible.filter((f) => f.is_active)
      if (active.length === 0) throw new AppError('You do not have access to any active firm. Contact your administrator.', 'FORBIDDEN')
      const multi = getSetting(db, 'multi_firm_enabled', true)
      const def = active.find((f) => f.is_default) ?? active[0]
      const firmId = multi && lastFirmId && active.some((f) => f.id === lastFirmId) ? lastFirmId : def.id
      runtime.session = { user, firmId, locked: false, lastActivity: Date.now() }
      return { user, firmId }
    }
  },
  'auth.unlock': {
    public: true,
    handler: (_c, a) => {
      const s = runtime.session
      if (!s) throw new AppError('Please sign in.', 'AUTH_REQUIRED')
      if (!auth.verifyUserPassword(getDb(), s.user.id, a.password)) throw new AppError('Incorrect password.', 'AUTH')
      s.locked = false
      s.lastActivity = Date.now()
      return true
    }
  },
  'auth.logout': {
    handler: (c) => {
      audit(c.ctx, 'logout', 'user', c.ctx.user.id, 'Signed out')
      runtime.session = null
      return true
    }
  },
  'auth.lock': {
    handler: () => {
      if (runtime.session) runtime.session.locked = true
      return true
    }
  },
  'auth.me': {
    handler: (c) => {
      const db = getDb()
      const user = auth.buildSessionUser(db, c.ctx.user.id)
      runtime.session!.user = user
      const firm = firms.getFirm(db, c.ctx.firmId)
      return { user, firm: { id: firm.id, name: firm.name, has_logo: !!firm.logo, logo: firm.logo }, firmId: c.ctx.firmId, settings: settings.getAllSettings(db) }
    }
  },
  'auth.changePassword': { handler: (c, a) => auth.changeOwnPassword(c.ctx, a.oldPassword, a.newPassword) },

  /* ---------------- firms ---------------- */
  'firms.list': { handler: (c) => firms.listFirms(c.ctx.db, c.ctx.user) },
  'firms.all': { perm: 'firms.manage', handler: (c) => firms.listFirms(c.ctx.db) },
  'firms.get': {
    handler: (c, a) => {
      const id = Number(a.id ?? c.ctx.firmId)
      if (!canAccessFirm(c.ctx.user, id)) throw new AppError('No access to this firm.', 'FORBIDDEN')
      return firms.getFirm(c.ctx.db, id)
    }
  },
  'firms.create': { perm: 'firms.manage', write: true, handler: (c, a) => firms.createFirm(c.ctx, a as never, licenseLimits().maxFirms) },
  'firms.update': { perm: 'firms.manage', write: true, handler: (c, a) => firms.updateFirm(c.ctx, a as never) },
  'firms.setDefault': { perm: 'firms.manage', write: true, handler: (c, a) => firms.setDefaultFirm(c.ctx, Number(a.id)) },
  'firms.limits': {
    handler: (c) => ({
      licenseMax: licenseLimits().maxFirms,
      allowed: firms.maxFirmsAllowed(c.ctx.db, licenseLimits().maxFirms),
      count: (c.ctx.db.prepare('SELECT COUNT(*) AS c FROM firms').get() as { c: number }).c
    })
  },
  'firms.switch': {
    handler: (c, a) => {
      const id = Number(a.id)
      const db = c.ctx.db
      if (!getSetting(db, 'multi_firm_enabled', true)) throw new AppError('Multiple firms are disabled.', 'VALIDATION')
      if (!canAccessFirm(c.ctx.user, id)) throw new AppError('You do not have access to this firm.', 'FORBIDDEN')
      const f = firms.getFirm(db, id)
      if (!f.is_active) throw new AppError('This firm is inactive.', 'VALIDATION')
      runtime.session!.firmId = id
      db.prepare('UPDATE users SET last_firm_id = ? WHERE id = ?').run(id, c.ctx.user.id)
      audit({ ...c.ctx, firmId: id }, 'switch_firm', 'firm', id, `Switched active firm to ${String(f.name)}`)
      return { firmId: id }
    }
  },
  'firms.sequences': { perm: 'firms.manage', handler: (c, a) => firms.listSequences(c.ctx, Number(a.firmId ?? c.ctx.firmId)) },
  'firms.updateSequence': { perm: 'firms.manage', write: true, handler: (c, a) => firms.updateSequence(c.ctx, Number(a.firmId ?? c.ctx.firmId), a as never) },

  /* ---------------- settings ---------------- */
  'settings.get': { handler: (c) => settings.getAllSettings(c.ctx.db) },
  'settings.update': { write: true, handler: (c, a) => settings.updateSettings(c.ctx, a.patch ?? {}) },
  'taxRates.list': { handler: (c) => settings.listTaxRates(c.ctx) },
  'taxRates.save': { perm: 'settings.manage', write: true, handler: (c, a) => settings.saveTaxRate(c.ctx, a as never) },
  'taxRates.delete': { perm: 'settings.manage', write: true, handler: (c, a) => settings.deleteTaxRate(c.ctx, Number(a.id)) },

  /* ---------------- users ---------------- */
  'users.list': { perm: 'users.manage', handler: (c) => auth.listUsers(c.ctx) },
  'users.save': {
    perm: 'users.manage',
    write: true,
    handler: (c, a) => {
      if (!a.id) {
        const count = (c.ctx.db.prepare('SELECT COUNT(*) AS c FROM users WHERE is_active = 1').get() as { c: number }).c
        const max = licenseLimits().maxUsers
        if (max > 0 && count >= max) throw new AppError(`Your license allows ${max} active user(s).`, 'LIMIT')
      }
      return auth.saveUser(c.ctx, a as never)
    }
  },
  'users.basic': {
    handler: (c) => c.ctx.db.prepare('SELECT id, full_name, username FROM users WHERE is_active = 1 ORDER BY full_name').all()
  },
  'roles.list': { perm: 'users.manage', handler: (c) => auth.listRoles(c.ctx) },
  'roles.save': { perm: 'users.manage', write: true, handler: (c, a) => auth.saveRole(c.ctx, a as never) },
  'roles.delete': { perm: 'users.manage', write: true, handler: (c, a) => auth.deleteRole(c.ctx, Number(a.id)) },
  'permissions.catalogue': { handler: () => auth.permissionCatalogue() },
  'audit.list': { perm: 'audit.view', handler: (c, a) => auth.listAudit(c.ctx, a) },

  /* ---------------- inventory ---------------- */
  'products.list': {
    perm: ['inventory.view', 'sales.create', 'purchases.create', 'quotations.manage', 'projects.manage'],
    handler: (c, a) => inv.listProducts(c.ctx, a)
  },
  'products.get': { perm: ['inventory.view', 'sales.create', 'purchases.create', 'quotations.manage'], handler: (c, a) => inv.getProduct(c.ctx, Number(a.id)) },
  'products.save': { perm: 'inventory.manage', write: true, handler: (c, a) => inv.saveProduct(c.ctx, a as never) },
  'products.delete': { perm: 'inventory.manage', write: true, handler: (c, a) => inv.deleteProduct(c.ctx, Number(a.id)) },
  'categories.list': { handler: (c) => inv.listCategories(c.ctx) },
  'categories.save': { perm: 'inventory.manage', write: true, handler: (c, a) => inv.saveCategory(c.ctx, a as never) },
  'categories.delete': { perm: 'inventory.manage', write: true, handler: (c, a) => inv.deleteCategory(c.ctx, Number(a.id)) },
  'warehouses.list': { handler: (c, a) => inv.listWarehouses(c.ctx, !!a.includeInactive) },
  'warehouses.save': { perm: 'inventory.manage', write: true, handler: (c, a) => inv.saveWarehouse(c.ctx, a as never) },
  'stock.adjust': { perm: 'inventory.adjust', write: true, handler: (c, a) => inv.createAdjustment(c.ctx, a as never) },
  'stock.adjustments': { perm: 'inventory.view', handler: (c, a) => inv.listAdjustments(c.ctx, a) },
  'stock.adjustment': { perm: 'inventory.view', handler: (c, a) => inv.getAdjustment(c.ctx, Number(a.id)) },
  'stock.movements': { perm: 'inventory.view', handler: (c, a) => inv.listMovements(c.ctx, a) },
  'stock.transfer': { perm: 'inventory.adjust', write: true, handler: (c, a) => inv.transferStock(c.ctx, a as never) },
  'stock.report': { perm: 'inventory.view', handler: (c, a) => inv.stockReport(c.ctx, a) },
  'serials.lookup': { perm: ['inventory.view', 'sales.view'], handler: (c, a) => inv.lookupSerial(c.ctx, a.serial) },

  /* ---------------- parties ---------------- */
  'parties.list': {
    perm: ['customers.view', 'suppliers.view', 'sales.create', 'purchases.create', 'quotations.manage', 'projects.manage', 'expenses.manage', 'accounts.manage'],
    handler: (c, a) => parties.listParties(c.ctx, a as never)
  },
  'parties.get': { handler: (c, a) => parties.getParty(c.ctx, Number(a.id)) },
  'parties.save': { write: true, handler: (c, a) => parties.saveParty(c.ctx, a as never) },
  'parties.delete': { write: true, handler: (c, a) => parties.deleteParty(c.ctx, Number(a.id)) },
  'parties.ledger': { handler: (c, a) => parties.partyLedger(c.ctx, Number(a.id), a) },
  'parties.aging': { handler: (c, a) => parties.agingReport(c.ctx, a.side, a.asOf) },
  'partyAdjustments.create': { perm: 'accounts.manage', write: true, handler: (c, a) => parties.createPartyAdjustment(c.ctx, a as never) },
  'partyAdjustments.list': { perm: 'accounts.view', handler: (c, a) => parties.listPartyAdjustments(c.ctx, a) },
  'partyAdjustments.cancel': { perm: 'accounts.manage', write: true, handler: (c, a) => parties.cancelPartyAdjustment(c.ctx, Number(a.id)) },

  /* ---------------- documents ---------------- */
  'docs.list': { handler: (c, a) => docs.listDocuments(c.ctx, a as never) },
  'docs.get': { handler: (c, a) => docs.getDocument(c.ctx, Number(a.id)) },
  'docs.create': { write: true, handler: (c, a) => docs.createDocument(c.ctx, a as never) },
  'docs.update': { write: true, handler: (c, a) => docs.updateDocument(c.ctx, a as never) },
  'docs.cancel': { write: true, handler: (c, a) => docs.cancelDocument(c.ctx, Number(a.id), a.reason) },
  'docs.deleteDraft': { write: true, handler: (c, a) => docs.deleteDraft(c.ctx, Number(a.id)) },
  'docs.convert': { handler: (c, a) => docs.prepareConversion(c.ctx, Number(a.id), a.target) },
  'docs.setQuotationStatus': { write: true, handler: (c, a) => docs.setQuotationStatus(c.ctx, Number(a.id), a.status) },
  'docs.applyAdvances': { perm: 'accounts.manage', write: true, handler: (c, a) => c.ctx.db.transaction(() => pay.applyAdvances(c.ctx, Number(a.id)))() },

  /* ---------------- payments & accounts ---------------- */
  'payments.list': { handler: (c, a) => pay.listPayments(c.ctx, a) },
  'payments.get': { handler: (c, a) => pay.getPayment(c.ctx, Number(a.id)) },
  'payments.create': { write: true, handler: (c, a) => pay.createPayment(c.ctx, a as never) },
  'payments.cancel': { write: true, handler: (c, a) => pay.cancelPayment(c.ctx, Number(a.id), a.reason) },
  'payments.openItems': { handler: (c, a) => pay.openItemsForParty(c.ctx, Number(a.partyId), a.direction) },
  'accounts.list': {
    perm: ['accounts.view', 'sales.create', 'purchases.create', 'expenses.manage'],
    handler: (c, a) => pay.listAccounts(c.ctx, a)
  },
  'accounts.save': { perm: 'accounts.manage', write: true, handler: (c, a) => pay.saveAccount(c.ctx, a as never) },
  'accounts.ledger': { perm: 'accounts.view', handler: (c, a) => pay.accountLedger(c.ctx, Number(a.id), a) },
  'transfers.list': { perm: 'accounts.view', handler: (c, a) => pay.listTransfers(c.ctx, a) },
  'transfers.create': { perm: 'accounts.manage', write: true, handler: (c, a) => pay.createTransfer(c.ctx, a as never) },
  'transfers.cancel': { perm: 'accounts.manage', write: true, handler: (c, a) => pay.cancelTransfer(c.ctx, Number(a.id)) },

  /* ---------------- expenses ---------------- */
  'expenses.list': { handler: (c, a) => exp.listExpenses(c.ctx, a) },
  'expenses.get': { handler: (c, a) => exp.getExpense(c.ctx, Number(a.id)) },
  'expenses.create': { write: true, handler: (c, a) => exp.createExpense(c.ctx, a as never) },
  'expenses.update': { write: true, handler: (c, a) => exp.updateExpense(c.ctx, a as never) },
  'expenses.cancel': { write: true, handler: (c, a) => exp.cancelExpense(c.ctx, Number(a.id), a.reason) },
  'expenseCategories.list': { handler: (c) => exp.listExpenseCategories(c.ctx) },
  'expenseCategories.save': { perm: 'expenses.manage', write: true, handler: (c, a) => exp.saveExpenseCategory(c.ctx, a as never) },

  /* ---------------- projects ---------------- */
  'projects.list': { handler: (c, a) => proj.listProjects(c.ctx, a) },
  'projects.options': {
    perm: ['projects.view', 'sales.create', 'purchases.create', 'expenses.manage', 'accounts.manage', 'quotations.manage'],
    handler: (c) =>
      c.ctx.db
        .prepare("SELECT id, code, name, customer_id, status FROM projects WHERE firm_id = ? AND status <> 'cancelled' ORDER BY id DESC")
        .all(c.ctx.firmId)
  },
  'projects.get': { handler: (c, a) => proj.getProject(c.ctx, Number(a.id)) },
  'projects.save': { write: true, handler: (c, a) => proj.saveProject(c.ctx, a as never) },
  'projects.ledger': { handler: (c, a) => proj.projectLedger(c.ctx, Number(a.id)) },
  'projects.materials': { handler: (c, a) => proj.materialUsage(c.ctx, Number(a.id)) },
  'projects.profitReport': { handler: (c, a) => proj.projectProfitReport(c.ctx, a) },
  'materials.list': { handler: (c, a) => proj.listMaterialMoves(c.ctx, a) },
  'materials.get': { handler: (c, a) => proj.getMaterialMove(c.ctx, Number(a.id)) },
  'materials.create': { write: true, handler: (c, a) => proj.createMaterialMove(c.ctx, a as never) },
  'materials.cancel': { write: true, handler: (c, a) => proj.cancelMaterialMove(c.ctx, Number(a.id), a.reason) },
  'attachments.add': {
    perm: 'projects.manage',
    write: true,
    handler: async (c, a) => {
      const win = BrowserWindow.fromWebContents(c.sender) ?? undefined
      const r = await dialog.showOpenDialog(win!, { properties: ['openFile', 'multiSelections'], title: 'Attach documents to project' })
      if (r.canceled) return []
      return r.filePaths.map((f) => proj.addAttachment(c.ctx, runtime.paths.attachments, 'project', Number(a.projectId), f))
    }
  },
  'attachments.open': { perm: 'projects.view', handler: (c, a) => shell.openPath(proj.attachmentPath(c.ctx, runtime.paths.attachments, Number(a.id))) },
  'attachments.delete': { perm: 'projects.manage', write: true, handler: (c, a) => proj.deleteAttachment(c.ctx, runtime.paths.attachments, Number(a.id)) },

  /* ---------------- reports ---------------- */
  'reports.dashboard': { perm: 'dashboard.view', handler: (c, a) => rep.dashboard(c.ctx, a as never) },
  'reports.pl': { perm: 'reports.profit', handler: (c, a) => rep.profitAndLoss(c.ctx, a as never) },
  'reports.register': { perm: 'reports.view', handler: (c, a) => rep.registerReport(c.ctx, a as never) },
  'reports.tax': { perm: 'reports.view', handler: (c, a) => rep.taxReport(c.ctx, a as never) },
  'reports.expenses': { perm: ['reports.view', 'expenses.view'], handler: (c, a) => rep.expenseReport(c.ctx, a as never) },
  'reports.daybook': { perm: 'reports.view', handler: (c, a) => rep.dayBook(c.ctx, a as never) },
  'search.global': { handler: (c, a) => rep.globalSearch(c.ctx, a.q) },

  /* ---------------- export ---------------- */
  'export.csv': {
    handler: async (c, a) => {
      const columns = (a.columns ?? []) as Array<{ key: string; label: string }>
      const rows = (a.rows ?? []) as Array<Record<string, unknown>>
      const file = await saveDialog(c.sender, `${String(a.filename || 'report').replace(/[^\w\- ]+/g, '')}.csv`, [{ name: 'CSV (Excel)', extensions: ['csv'] }])
      if (!file) return null
      const lines = [columns.map((col) => csvEscape(col.label)).join(',')]
      for (const r of rows) lines.push(columns.map((col) => csvEscape(r[col.key])).join(','))
      writeFileSync(file, '﻿' + lines.join('\r\n'), 'utf8')
      return file
    }
  },

  /* ---------------- printing ---------------- */
  'print.open': {
    handler: (_c, a) => {
      openPrintWindow(String(a.kind), Number(a.id ?? 0), a.params ?? {})
      return true
    }
  },
  'print.run': {
    handler: (c) =>
      new Promise((resolve, reject) => {
        c.sender.print({ printBackground: true, silent: false, margins: { marginType: 'default' }, pageSize: 'A4' }, (ok, reason) => {
          if (ok || reason === 'cancelled') resolve(ok)
          else reject(new AppError(`Printing failed: ${reason}`, 'PRINT'))
        })
      })
  },
  'print.pdf': {
    handler: async (c, a) => {
      const file = await saveDialog(c.sender, `${String(a.filename || 'document').replace(/[^\w\- .]+/g, '')}.pdf`, [{ name: 'PDF', extensions: ['pdf'] }])
      if (!file) return null
      const data = await c.sender.printToPDF({ pageSize: 'A4', printBackground: true, preferCSSPageSize: true })
      writeFileSync(file, data)
      shell.openPath(file)
      return file
    }
  },

  /* ---------------- backup ---------------- */
  'backup.info': {
    perm: 'backup.manage',
    handler: (c) => {
      const dir = getSetting(c.ctx.db, 'backup_dir', '') || runtime.paths.backups
      return { dir, defaultDir: runtime.paths.backups, dbFile: runtime.paths.dbFile, backups: listBackups(dir), lastAuto: getSetting(c.ctx.db, 'last_auto_backup', '') }
    }
  },
  'backup.create': {
    perm: 'backup.manage',
    handler: async (c, a) => {
      let dir = getSetting(c.ctx.db, 'backup_dir', '') || runtime.paths.backups
      if (a.chooseFolder) {
        const win = BrowserWindow.fromWebContents(c.sender) ?? undefined
        const r = await dialog.showOpenDialog(win!, { properties: ['openDirectory', 'createDirectory'], title: 'Choose backup folder (USB / external drive recommended)' })
        if (r.canceled || !r.filePaths[0]) return null
        dir = r.filePaths[0]
      }
      const res = await createBackup(c.ctx.db, dir, 'manual')
      audit(c.ctx, 'backup', 'system', null, `Manual backup created: ${res.file}`)
      return res
    }
  },
  'backup.chooseDir': {
    perm: 'backup.manage',
    handler: async (c) => {
      const win = BrowserWindow.fromWebContents(c.sender) ?? undefined
      const r = await dialog.showOpenDialog(win!, { properties: ['openDirectory', 'createDirectory'], title: 'Choose automatic backup folder' })
      if (r.canceled || !r.filePaths[0]) return null
      settings.updateSettings(c.ctx, { backup_dir: r.filePaths[0] })
      return r.filePaths[0]
    }
  },
  'backup.runAuto': { perm: 'backup.manage', handler: (c) => autoBackupIfDue(c.ctx.db, runtime.paths.backups) },
  'backup.openFolder': {
    perm: 'backup.manage',
    handler: (c) => shell.openPath(getSetting(c.ctx.db, 'backup_dir', '') || runtime.paths.backups)
  },
  'backup.inspect': {
    perm: 'backup.manage',
    handler: async (c, a) => {
      let file = a.file as string | undefined
      if (!file) {
        const win = BrowserWindow.fromWebContents(c.sender) ?? undefined
        const r = await dialog.showOpenDialog(win!, { properties: ['openFile'], title: 'Select a DT Solar Pro backup', filters: [{ name: 'DT Solar Pro Backup', extensions: ['dtbak', 'db', 'sqlite'] }] })
        if (r.canceled || !r.filePaths[0]) return null
        file = r.filePaths[0]
      }
      if (!existsSync(file)) throw new AppError('Backup file not found.', 'VALIDATION')
      return { file, ...validateDatabaseFile(file) }
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
      // Safety copy of the current data first — never lose the existing database.
      const safety = await createBackup(c.ctx.db, join(runtime.paths.backups, 'safety'), 'pre-restore')
      audit(c.ctx, 'restore', 'system', null, `Restoring backup ${file}. Safety copy: ${safety.file}`)
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
      runtime.session = null
      return { restored: true, safety: safety.file }
    }
  },

  /* ---------------- license ---------------- */
  'license.status': { public: true, handler: () => runtime.license!.status(true) },
  'license.activate': { public: true, handler: (_c, a) => runtime.license!.activateOnline(String(a.licenseKey ?? '')) },
  'license.pollActivation': { public: true, handler: () => runtime.license!.pollActivation() },
  'license.cancelPending': { public: true, handler: () => runtime.license!.cancelPending() },
  'license.requestCode': { public: true, handler: (_c, a) => runtime.license!.requestCode(String(a.licenseKey ?? '')) },
  'license.install': {
    public: true,
    handler: async (c, a) => {
      let text = a.text as string | undefined
      if (!text) {
        const win = BrowserWindow.fromWebContents(c.sender) ?? undefined
        const r = await dialog.showOpenDialog(win!, { properties: ['openFile'], title: 'Select license file', filters: [{ name: 'License', extensions: ['dtlic', 'json', 'txt'] }] })
        if (r.canceled || !r.filePaths[0]) return null
        text = readFileSync(r.filePaths[0], 'utf8')
      }
      return runtime.license!.install(text)
    }
  },
  'license.checkIn': { public: true, handler: () => runtime.license!.checkIn(false) },
  'license.deactivate': { perm: 'license.manage', handler: () => runtime.license!.deactivate() }
}

/** Feature areas are merged after the core routes (an area may re-define a core route it owns). */
export const routes: Record<string, Route> = {
  ...coreRoutes,
  ...documentRoutes,
  ...catalogRoutes,
  ...dataRoutes,
  ...accessRoutes,
  ...cloudRoutes,
  ...assistRoutes,
  ...legacyRoutes
}

/* ------------------------------------------------------------------------------------------ */

const SIGN_IN_ROUTES = new Set(['auth.login', 'auth.pinLogin', 'auth.unlock'])
const PUBLIC_WHILE_LOCKED = new Set(['app.info', 'auth.unlock', 'auth.logout', 'license.status'])

export async function dispatch(method: string, args: unknown, sender: WebContents): Promise<unknown> {
  const route = Object.prototype.hasOwnProperty.call(routes, method) ? routes[method] : undefined
  if (!route) throw new AppError(`Unknown action: ${method}`, 'NOT_FOUND')
  const a = (args && typeof args === 'object' ? args : {}) as Args
  if (route.public) {
    // Sign-in: verify the license in the background (never delays signing in).
    if (SIGN_IN_ROUTES.has(method)) runtime.license?.refreshInBackground()
    return route.handler({ ctx: runtime.db ? publicCtx() : (null as unknown as Ctx), sender }, a)
  }
  const s = runtime.session
  if (!s) throw new AppError('Please sign in.', 'AUTH_REQUIRED')
  const db = getDb()
  const lockMinutes = getSetting(db, 'lock_minutes', 15)
  if (!s.locked && lockMinutes > 0 && Date.now() - s.lastActivity > lockMinutes * 60000) s.locked = true
  if (s.locked && !PUBLIC_WHILE_LOCKED.has(method)) throw new AppError('Session locked. Enter your password to continue.', 'LOCKED')
  sessionGate(method, s.user) // forced password change: only the change-password route and session basics work
  s.lastActivity = Date.now()
  const ctx: Ctx = { db, user: s.user, firmId: s.firmId }
  if (!canAccessFirm(s.user, s.firmId)) throw new AppError('You no longer have access to the active firm.', 'FORBIDDEN')
  if (route.perm) {
    const perms = Array.isArray(route.perm) ? route.perm : [route.perm]
    if (!s.user.isOwner && !perms.some((p) => s.user.permissions.includes(p))) {
      throw new AppError('You do not have permission to perform this action.', 'FORBIDDEN')
    }
  }
  if (route.write) {
    // Protected write: re-verify online when the last successful check is older than 5 minutes (waits <= 4 s; offline
    // falls back to the signed offline policy). License, device and connectivity problems have distinct messages.
    const st = await runtime.license!.ensureFresh()
    if (!st.canWrite) throw new AppError(st.message, st.blockReason === 'device' ? 'LICENSE_DEVICE' : 'LICENSE')
  }
  return route.handler({ ctx, sender }, a)
}
