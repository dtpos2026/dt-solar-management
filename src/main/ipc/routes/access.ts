/**
 * IPC routes — Login, PIN, users, lock screen, printers (owner: access area).
 * Owns: auth.login, auth.unlock, auth.changePassword, auth.users, auth.pin*, users.*, printers.*, print.run, print.pdf.
 */
import { BrowserWindow, shell } from 'electron'
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { RouteMap } from '../common'
import { saveDialog } from '../common'
import { runtime, getDb } from '../../runtime'
import type { DB } from '../../db'
import { AppError, SessionUser, audit, getSetting, setSetting } from '../../services/context'
import * as auth from '../../services/auth'
import { applyResetCodeOrThrow } from '../../services/adminReset'
import * as firms from '../../services/firms'
import { getAllSettings, updateSettings } from '../../services/settings'
import { PAPER_SIZES, countPdfPages, isPaperSize, parsePrintUrl, pdfOptionsFor, printFailureText, resolvePrintJob, type PaperSize } from '../../services/printers'
import { listOsPrinters, openPdfPageView, printTestPage, printWebContents } from '../../printing'

/* ------------------------------------------------ session gates ------------------------------------------------ */

/**
 * Routes that stay available while the signed-in user must still replace a temporary password. Everything else is
 * refused by the router (see sessionGate) so the forced change cannot be bypassed from the UI or a crafted call.
 */
export const ALLOWED_DURING_PASSWORD_CHANGE = new Set([
  'app.info',
  'app.activity',
  'auth.me',
  'auth.changePassword',
  'auth.logout',
  'auth.lock',
  'auth.unlock',
  'auth.pinStatus',
  'firms.list',
  'license.status'
])

/** Called by the router for every signed-in (non-public) call. */
export function sessionGate(method: string, user: SessionUser): void {
  if (user.mustChangePassword && !ALLOWED_DURING_PASSWORD_CHANGE.has(method)) {
    throw new AppError('You must choose a new password before you can continue.', 'PASSWORD_CHANGE_REQUIRED')
  }
}

/* ------------------------------------------------ helpers ------------------------------------------------ */

/** Starts the session after a successful sign-in (picks the firm exactly like the classic sign-in). */
function startSession(db: DB, r: { user: SessionUser; lastFirmId: number | null }): { user: SessionUser; firmId: number } {
  const { user, lastFirmId } = r
  const accessible = firms.listFirms(db, user) as Array<{ id: number; is_default: number; is_active: number }>
  const active = accessible.filter((f) => f.is_active)
  if (active.length === 0) throw new AppError('You do not have access to any active firm. Contact your administrator.', 'FORBIDDEN')
  const multi = getSetting(db, 'multi_firm_enabled', true)
  const def = active.find((f) => f.is_default) ?? active[0]
  const firmId = multi && lastFirmId && active.some((f) => f.id === lastFirmId) ? lastFirmId : def.id
  runtime.session = { user, firmId, locked: false, lastActivity: Date.now() }
  return { user, firmId }
}

const userSelectionOn = (db: DB): boolean => getSetting<unknown>(db, 'login_show_users', true) !== false

const PRINTER_KEYS = ['printer_default', 'printer_invoice', 'printer_quotation', 'printer_report', 'printer_receipt', 'paper_size', 'print_direct']

function printerSettings(db: DB): Record<string, unknown> {
  const all = getAllSettings(db)
  return Object.fromEntries(PRINTER_KEYS.map((k) => [k, all[k]]))
}

function docTypeOf(db: DB, id: number): string | null {
  if (!id) return null
  const r = db.prepare('SELECT doc_type FROM documents WHERE id = ?').get(id) as { doc_type: string } | undefined
  return r?.doc_type ?? null
}

/* ------------------------------------------------ routes ------------------------------------------------ */

export const accessRoutes: RouteMap = {
  /* ---------- sign-in ---------- */
  'auth.users': {
    public: true,
    // Only safe fields of ACTIVE users (id, name, role, has_pin) — never usernames or hashes. Empty when turned off.
    handler: () => {
      const db = getDb()
      if (auth.userCount(db) === 0) return { showUsers: false, users: [] }
      const show = userSelectionOn(db)
      return { showUsers: show, users: show ? auth.loginTiles(db) : [] }
    }
  },
  'auth.login': {
    public: true,
    handler: (_c, a) => {
      const db = getDb()
      if (a.userId !== undefined && a.userId !== null && a.userId !== '') {
        if (!userSelectionOn(db)) throw new AppError('User selection is turned off. Sign in with your username.', 'VALIDATION')
        return startSession(db, auth.loginById(db, a.userId, a.password))
      }
      return startSession(db, auth.login(db, a.username, a.password))
    }
  },
  'auth.pinLogin': {
    public: true,
    handler: (_c, a) => {
      const db = getDb()
      if (!userSelectionOn(db)) throw new AppError('User selection is turned off. Sign in with your username and password.', 'VALIDATION')
      return startSession(db, auth.pinLogin(db, a.userId, a.pin))
    }
  },
  'auth.unlock': {
    public: true,
    handler: (_c, a) => {
      const s = runtime.session
      if (!s) throw new AppError('Please sign in.', 'AUTH_REQUIRED')
      auth.unlockSession(getDb(), s.user.id, { pin: a.pin, password: a.password })
      s.locked = false
      s.lastActivity = Date.now()
      return true
    }
  },
  /** PIN state of the signed-in user (lock screen + user menu). Public so the lock screen can ask while locked. */
  /**
   * Offline delivery of an Administrator password reset: the signed code from Digital Target is pasted on the sign-in screen.
   * Public (nobody is signed in) but it only accepts a code signed by Digital Target for THIS computer, once, before it expires.
   */
  'auth.applyResetCode': {
    public: true,
    handler: (_c, a) => {
      const lic = runtime.license
      if (!lic) throw new AppError('The license service is not ready.', 'ERROR')
      return { message: applyResetCodeOrThrow(getDb(), String(a.code ?? ''), { publicKeyPem: lic.verificationKey, deviceId: lic.deviceId }) }
    }
  },
  'auth.pinStatus': {
    public: true,
    handler: () => {
      const s = runtime.session
      if (!s) return null
      return { userId: s.user.id, fullName: s.user.fullName, ...auth.pinStatus(getDb(), s.user.id) }
    }
  },
  'auth.pinSet': { write: true, handler: (c, a) => auth.setOwnPin(c.ctx, a.currentPassword, a.pin) },
  'auth.pinRemove': { write: true, handler: (c, a) => auth.removeOwnPin(c.ctx, a.currentPassword) },
  'auth.changePassword': {
    handler: (c, a) => {
      auth.changeOwnPassword(c.ctx, a.oldPassword, a.newPassword)
      // Refresh the cached session so the forced-change gate opens immediately.
      if (runtime.session && runtime.session.user.id === c.ctx.user.id) runtime.session.user = auth.buildSessionUser(c.ctx.db, c.ctx.user.id)
      return true
    }
  },

  /* ---------- user administration (PIN, lock-outs, sign-in screen) ---------- */
  'users.setPin': { perm: 'users.manage', write: true, handler: (c, a) => auth.adminSetPin(c.ctx, a.id, a.pin) },
  'users.removePin': { perm: 'users.manage', write: true, handler: (c, a) => auth.adminRemovePin(c.ctx, a.id) },
  'users.unlock': { perm: 'users.manage', write: true, handler: (c, a) => auth.adminUnlockUser(c.ctx, a.id) },
  'users.setLoginOptions': {
    perm: ['users.manage', 'settings.manage'],
    write: true,
    handler: (c, a) => {
      const show = !!a.showUsers
      setSetting(c.ctx.db, 'login_show_users', show)
      audit(c.ctx, 'update', 'settings', null, show ? 'Sign-in screen shows the list of users' : 'Sign-in screen asks for username (user list hidden)')
      return { showUsers: show }
    }
  },

  /* ---------- printers ---------- */
  'printers.list': {
    perm: 'printers.manage',
    handler: async (c) => ({
      printers: await listOsPrinters(c.sender),
      settings: printerSettings(c.ctx.db),
      papers: PAPER_SIZES,
      platform: process.platform
    })
  },
  'printers.save': {
    perm: 'printers.manage',
    write: true,
    handler: (c, a) => {
      const patch = (a.patch ?? {}) as Record<string, unknown>
      const clean: Record<string, unknown> = {}
      for (const k of Object.keys(patch)) {
        if (!PRINTER_KEYS.includes(k)) throw new AppError(`Unknown printer setting: ${k}`, 'VALIDATION')
        clean[k] = patch[k]
      }
      if (Object.keys(clean).length) updateSettings(c.ctx, clean)
      return printerSettings(c.ctx.db)
    }
  },
  'printers.test': {
    perm: 'printers.manage',
    handler: async (c, a) => {
      const printer = String(a.printer ?? '').trim()
      if (!printer) throw new AppError('Choose a printer to test.', 'VALIDATION')
      const paper: PaperSize = isPaperSize(a.paper) ? a.paper : (getSetting(c.ctx.db, 'paper_size', 'A4') as PaperSize)
      const listed = (await listOsPrinters(c.sender)).some((p) => p.name === printer)
      // Always ask the OS: its callback is the honest answer (a missing printer is reported as a failure).
      const r = await printTestPage(printer, isPaperSize(paper) ? paper : 'A4', runtime.appVersion)
      const message = r.ok
        ? `The test page was sent to “${printer}”. Check that it printed correctly.`
        : `Test print failed: ${printFailureText(r.reason)}${listed ? '' : ' This printer is not in the list Windows reports.'}`
      audit(c.ctx, 'printer_test', 'settings', null, `Test print to ${printer}: ${r.ok ? 'sent' : `failed (${r.reason})`}`)
      return { ok: r.ok, reason: r.reason, listed, message }
    }
  },

  /* ---------- printing from the print preview window ---------- */
  'print.run': {
    handler: async (c, a) => {
      const db = c.ctx.db
      const target = parsePrintUrl(c.sender.getURL())
      const kind = String(a.kind ?? target?.kind ?? 'doc')
      const id = Number(a.id ?? target?.id ?? 0) || 0
      const available = (await c.sender.getPrintersAsync()).map((p) => p.name)
      const job = resolvePrintJob({ kind, docType: kind === 'doc' ? docTypeOf(db, id) : null, paper: a.paper, orientation: a.orientation, settings: getAllSettings(db), available })
      const r = await printWebContents(c.sender, { silent: job.silent, deviceName: job.printer, pageSize: job.pageSize, marginType: job.marginType, landscape: job.landscape })
      if (r.ok || /cancel/i.test(r.reason)) {
        return { ok: r.ok, cancelled: !r.ok, printer: job.printer, silent: job.silent, paper: job.paper, missingPrinter: job.missing }
      }
      throw new AppError(`Printing failed: ${printFailureText(r.reason)}`, 'PRINT')
    }
  },
  /** Save PDF; with view: true the same PDF is shown in the in-app page view instead (exact pages, no save dialog). */
  'print.pdf': {
    handler: async (c, a) => {
      const db = c.ctx.db
      const target = parsePrintUrl(c.sender.getURL())
      const kind = String(a.kind ?? target?.kind ?? 'doc')
      const id = Number(a.id ?? target?.id ?? 0) || 0
      const job = resolvePrintJob({ kind, docType: kind === 'doc' ? docTypeOf(db, id) : null, paper: a.paper, orientation: a.orientation, settings: getAllSettings(db) })
      const name = String(a.filename || 'document').replace(/[^\w\- .]+/g, '').trim() || 'document'
      // count: page count of the PDF the preview would produce (shown in the preview toolbar); nothing is saved
      if (a.count === true) return { pages: countPdfPages(await c.sender.printToPDF(pdfOptionsFor(job))) }
      if (a.view === true) {
        const data = await c.sender.printToPDF(pdfOptionsFor(job))
        const dir = join(runtime.paths.userData, 'print-preview')
        mkdirSync(dir, { recursive: true })
        const file = join(dir, 'page-view.pdf')
        writeFileSync(file, data)
        await openPdfPageView(file, `${name} — page view`, BrowserWindow.fromWebContents(c.sender))
        return { pages: countPdfPages(data) }
      }
      const file = await saveDialog(c.sender, `${name}.pdf`, [{ name: 'PDF', extensions: ['pdf'] }])
      if (!file) return null
      const data = await c.sender.printToPDF(pdfOptionsFor(job))
      writeFileSync(file, data)
      shell.openPath(file)
      return file
    }
  }
}
