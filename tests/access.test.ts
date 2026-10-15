import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  PIN_MAX_FAILED,
  adminRemovePin,
  adminSetPin,
  adminUnlockUser,
  buildSessionUser,
  changeOwnPassword,
  listUsers,
  login,
  loginById,
  loginTiles,
  pinLogin,
  pinStatus,
  removeOwnPin,
  saveUser,
  setOwnPin,
  unlockSession,
  validatePassword,
  validatePin
} from '../src/main/services/auth'
import type { Ctx } from '../src/main/services/context'
import { setSetting } from '../src/main/services/context'
import {
  normalizePrinters,
  parseLpstatDefault,
  parsePrintUrl,
  parseWinPrinterJson,
  pdfPageSize,
  printFailureText,
  printPageSize,
  printerRoleFor,
  resolvePrintJob
} from '../src/main/services/printers'
import { runtime } from '../src/main/runtime'
import { accessRoutes, sessionGate, ALLOWED_DURING_PASSWORD_CHANGE } from '../src/main/ipc/routes/access'
import { dispatch, routes } from '../src/main/ipc/router'
import { setupCtx, userCtx } from './helpers'

const roleId = (ctx: Ctx, name: string): number => (ctx.db.prepare('SELECT id FROM roles WHERE name = ?').get(name) as { id: number }).id
const row = (ctx: Ctx, id: number): Record<string, unknown> => ctx.db.prepare('SELECT * FROM users WHERE id = ?').get(id) as Record<string, unknown>
const audits = (ctx: Ctx, action: string): number => (ctx.db.prepare('SELECT COUNT(*) AS c FROM audit_log WHERE action = ?').get(action) as { c: number }).c

/** A staff user who has already chosen their own password (no pending forced change). */
function staff(owner: Ctx, username = 'sana', role = 'Salesperson'): Ctx {
  const c = userCtx(owner, role, username)
  // Distinct display name so tests can prove the username is never exposed publicly.
  owner.db.prepare("UPDATE users SET must_change_password = 0, full_name = ? WHERE id = ?").run(`Staff ${username.toUpperCase()}`, c.user.id)
  return { ...c, user: buildSessionUser(owner.db, c.user.id) }
}

const fakeSender = { getURL: () => 'file:///app/index.html' } as never

/* ================================================== PIN ================================================== */

describe('PIN rules', () => {
  it('accepts 4–6 digit PINs and rejects weak or malformed ones', () => {
    expect(validatePin('4821')).toBe('4821')
    expect(validatePin('904417')).toBe('904417')
    for (const bad of ['', '123', '1234567', 'abcd', '12a4', '1234', '4321', '0000', '999999', '123456']) {
      expect(() => validatePin(bad), bad).toThrow()
    }
  })

  it('sets, verifies, locks after 5 wrong PINs, and resets', () => {
    const owner = setupCtx()
    const u = staff(owner)
    adminSetPin(owner, u.user.id, '4821')
    expect(pinLogin(owner.db, u.user.id, '4821').user.id).toBe(u.user.id)
    expect(audits(owner, 'pin_login')).toBe(1)

    for (let i = 1; i < PIN_MAX_FAILED; i++) {
      expect(() => pinLogin(owner.db, u.user.id, '1111')).toThrow(new RegExp(`${PIN_MAX_FAILED - i} attempts? left`))
    }
    expect(() => pinLogin(owner.db, u.user.id, '1111')).toThrow(/PIN is locked/)
    // Even the right PIN is refused while locked; the password still works.
    expect(() => pinLogin(owner.db, u.user.id, '4821')).toThrow(/PIN is locked/)
    expect(pinStatus(owner.db, u.user.id)).toMatchObject({ hasPin: true, pinLocked: true })
    expect(loginById(owner.db, u.user.id, 'secret123').user.id).toBe(u.user.id)
    expect(audits(owner, 'pin_locked')).toBe(1)
    expect(audits(owner, 'pin_login_failed')).toBeGreaterThanOrEqual(PIN_MAX_FAILED)

    // Lock expires after 5 minutes.
    owner.db.prepare('UPDATE users SET pin_locked_until = ? WHERE id = ?').run(new Date(Date.now() - 1000).toISOString(), u.user.id)
    expect(pinLogin(owner.db, u.user.id, '4821').user.id).toBe(u.user.id)

    // Admin reset clears a lock and replaces the PIN.
    for (let i = 0; i < PIN_MAX_FAILED; i++) expect(() => pinLogin(owner.db, u.user.id, '2580')).toThrow()
    adminSetPin(owner, u.user.id, '7395')
    expect(row(owner, u.user.id).pin_locked_until).toBeNull()
    expect(() => pinLogin(owner.db, u.user.id, '4821')).toThrow(/Incorrect PIN/)
    expect(pinLogin(owner.db, u.user.id, '7395').user.id).toBe(u.user.id)
    expect(audits(owner, 'pin_reset')).toBe(2)

    adminRemovePin(owner, u.user.id)
    expect(() => pinLogin(owner.db, u.user.id, '7395')).toThrow(/not set up/)
    expect(audits(owner, 'pin_removed')).toBe(1)
  })

  it('"Set my PIN" requires the current password; removal too', () => {
    const owner = setupCtx()
    const u = staff(owner)
    expect(() => setOwnPin(u, 'wrong-password', '4821')).toThrow(/Current password is incorrect/)
    setOwnPin(u, 'secret123', '4821')
    expect(pinStatus(owner.db, u.user.id).hasPin).toBe(true)
    expect(() => removeOwnPin(u, 'nope')).toThrow()
    removeOwnPin(u, 'secret123')
    expect(pinStatus(owner.db, u.user.id).hasPin).toBe(false)
  })

  it('a password lock-out also blocks PIN sign-in, and admin unlock clears both', () => {
    const owner = setupCtx()
    const u = staff(owner)
    adminSetPin(owner, u.user.id, '4821')
    for (let i = 0; i < 5; i++) expect(() => login(owner.db, 'sana', 'bad-password')).toThrow()
    expect(() => pinLogin(owner.db, u.user.id, '4821')).toThrow(/Too many failed attempts/)
    adminUnlockUser(owner, u.user.id)
    expect(pinLogin(owner.db, u.user.id, '4821').user.id).toBe(u.user.id)
  })

  it('only users.manage holders can manage PINs, and only the owner can change the owner PIN', () => {
    const owner = setupCtx()
    const sales = staff(owner, 'sales1')
    const admin = staff(owner, 'admin2', 'Administrator')
    expect(() => adminSetPin(sales, admin.user.id, '4821')).toThrow(/permission/)
    expect(() => adminSetPin(admin, owner.user.id, '4821')).toThrow(/Only the owner/)
    adminSetPin(admin, sales.user.id, '4821')
    adminSetPin(owner, owner.user.id, '4821')
  })

  it('disabled users cannot use their PIN', () => {
    const owner = setupCtx()
    const u = staff(owner)
    adminSetPin(owner, u.user.id, '4821')
    owner.db.prepare('UPDATE users SET is_active = 0 WHERE id = ?').run(u.user.id)
    expect(() => pinLogin(owner.db, u.user.id, '4821')).toThrow(/not available/)
  })
})

describe('PIN storage', () => {
  it('never stores the PIN in plain text (salted scrypt, like passwords)', () => {
    const owner = setupCtx()
    const a = staff(owner, 'aaa1')
    const b = staff(owner, 'bbb1')
    adminSetPin(owner, a.user.id, '582914')
    adminSetPin(owner, b.user.id, '582914')
    const ha = String(row(owner, a.user.id).pin_hash)
    const hb = String(row(owner, b.user.id).pin_hash)
    expect(ha.startsWith('scrypt$')).toBe(true)
    expect(ha).not.toContain('582914')
    expect(ha).not.toBe(hb) // random salt per user
    const dump = JSON.stringify(owner.db.prepare('SELECT * FROM audit_log').all())
    expect(dump).not.toContain('582914')
    const all = JSON.stringify(owner.db.prepare('SELECT * FROM users').all())
    expect(all).not.toContain('582914')
  })
})

/* ================================================== lock screen ================================================== */

describe('lock screen unlock', () => {
  it('unlocks with PIN or password and locks out after 5 wrong passwords', () => {
    const owner = setupCtx()
    const u = staff(owner)
    adminSetPin(owner, u.user.id, '4821')
    unlockSession(owner.db, u.user.id, { pin: '4821' })
    unlockSession(owner.db, u.user.id, { password: 'secret123' })
    expect(() => unlockSession(owner.db, u.user.id, { pin: '9999' })).toThrow(/Incorrect PIN/)
    for (let i = 0; i < 4; i++) expect(() => unlockSession(owner.db, u.user.id, { password: 'nope' })).toThrow(/Incorrect password/)
    expect(() => unlockSession(owner.db, u.user.id, { password: 'nope' })).toThrow(/Too many failed attempts/)
    expect(() => unlockSession(owner.db, u.user.id, { password: 'secret123' })).toThrow(/Too many failed attempts/)
    expect(audits(owner, 'unlock')).toBe(2)
  })
})

/* ================================================== user tiles ================================================== */

describe('sign-in user list', () => {
  let owner: Ctx
  beforeEach(() => {
    owner = setupCtx()
    runtime.db = owner.db
  })
  afterEach(() => {
    runtime.db = null
    runtime.session = null
  })

  it('exposes only id, name, role and has_pin of active users', () => {
    const a = staff(owner, 'ali')
    const d = staff(owner, 'disabled1')
    adminSetPin(owner, a.user.id, '4821')
    owner.db.prepare('UPDATE users SET is_active = 0 WHERE id = ?').run(d.user.id)

    const res = accessRoutes['auth.users'].handler({ ctx: null as never, sender: fakeSender }, {}) as { showUsers: boolean; users: Array<Record<string, unknown>> }
    expect(res.showUsers).toBe(true)
    expect(res.users.map((u) => u.id)).toEqual(expect.arrayContaining([owner.user.id, a.user.id]))
    expect(res.users.some((u) => u.id === d.user.id)).toBe(false)
    for (const u of res.users) expect(Object.keys(u).sort()).toEqual(['full_name', 'has_pin', 'id', 'role_name'])
    expect(res.users.find((u) => u.id === a.user.id)!.has_pin).toBe(true)
    const text = JSON.stringify(res)
    expect(text).not.toMatch(/scrypt|password|username|ali\b|disabled1/)
    expect(loginTiles(owner.db)).toEqual(res.users)
  })

  it('returns nothing when the sign-in screen user list is turned off, and refuses id/PIN sign-in', () => {
    const a = staff(owner, 'ali')
    adminSetPin(owner, a.user.id, '4821')
    setSetting(owner.db, 'login_show_users', false)
    const res = accessRoutes['auth.users'].handler({ ctx: null as never, sender: fakeSender }, {}) as { showUsers: boolean; users: unknown[] }
    expect(res).toEqual({ showUsers: false, users: [] })
    expect(() => accessRoutes['auth.pinLogin'].handler({ ctx: null as never, sender: fakeSender }, { userId: a.user.id, pin: '4821' })).toThrow(/turned off/)
    expect(() => accessRoutes['auth.login'].handler({ ctx: null as never, sender: fakeSender }, { userId: a.user.id, password: 'secret123' })).toThrow(/turned off/)
    // Classic username sign-in keeps working.
    const r = accessRoutes['auth.login'].handler({ ctx: null as never, sender: fakeSender }, { username: 'ali', password: 'secret123' }) as { user: { id: number } }
    expect(r.user.id).toBe(a.user.id)
  })

  it('tile sign-in with password or PIN starts a session', () => {
    const a = staff(owner, 'ali')
    adminSetPin(owner, a.user.id, '4821')
    const r1 = accessRoutes['auth.login'].handler({ ctx: null as never, sender: fakeSender }, { userId: a.user.id, password: 'secret123' }) as { user: { id: number }; firmId: number }
    expect(r1.user.id).toBe(a.user.id)
    expect(runtime.session?.user.id).toBe(a.user.id)
    runtime.session = null
    const r2 = accessRoutes['auth.pinLogin'].handler({ ctx: null as never, sender: fakeSender }, { userId: a.user.id, pin: '4821' }) as { user: { id: number } }
    expect(r2.user.id).toBe(a.user.id)
    expect((runtime.session as { firmId: number } | null)?.firmId).toBe(owner.firmId)
  })

  it('the users list for administrators never contains hashes', () => {
    const a = staff(owner, 'ali')
    adminSetPin(owner, a.user.id, '4821')
    const list = listUsers(owner) as Array<Record<string, unknown>>
    for (const u of list) {
      expect(u).not.toHaveProperty('password_hash')
      expect(u).not.toHaveProperty('pin_hash')
      expect(u).not.toHaveProperty('pin_locked_until')
    }
    expect(list.find((u) => u.id === a.user.id)).toMatchObject({ has_pin: true, pin_locked: false, login_locked: false })
  })
})

/* ================================================== forced password change ================================================== */

describe('forced password change', () => {
  let owner: Ctx
  beforeEach(() => {
    owner = setupCtx()
    runtime.db = owner.db
    runtime.license = { status: () => ({ canWrite: true, message: '' }) } as never
  })
  afterEach(() => {
    runtime.db = null
    runtime.session = null
    runtime.license = null
  })

  it('users created by an admin and password resets must change the password', () => {
    const id = saveUser(owner, { username: 'newbie', fullName: 'New Bie', roleId: roleId(owner, 'Salesperson'), password: 'temp1234' })
    expect(row(owner, id).must_change_password).toBe(1)
    expect(buildSessionUser(owner.db, id).mustChangePassword).toBe(true)
    const u: Ctx = { ...owner, user: buildSessionUser(owner.db, id) }
    changeOwnPassword(u, 'temp1234', 'mynewpass9')
    expect(row(owner, id).must_change_password).toBe(0)
    saveUser(owner, { id, username: 'newbie', fullName: 'New Bie', roleId: roleId(owner, 'Salesperson'), password: 'reset5678' })
    expect(row(owner, id).must_change_password).toBe(1)
    // The setup-wizard owner chose their own password: no forced change.
    expect(owner.user.mustChangePassword).toBe(false)
  })

  it('every route except the change-password basics refuses while the change is pending', async () => {
    const id = saveUser(owner, { username: 'newbie', fullName: 'New Bie', roleId: roleId(owner, 'Administrator'), password: 'temp1234' })
    const r = accessRoutes['auth.login'].handler({ ctx: null as never, sender: fakeSender }, { username: 'newbie', password: 'temp1234' }) as { user: { mustChangePassword: boolean } }
    expect(r.user.mustChangePassword).toBe(true)

    for (const m of ['products.list', 'docs.create', 'users.list', 'settings.update', 'auth.pinSet', 'backup.info', 'printers.list', 'reports.dashboard']) {
      await expect(dispatch(m, {}, fakeSender), m).rejects.toMatchObject({ code: 'PASSWORD_CHANGE_REQUIRED' })
    }
    // Every route that is still allowed must exist (no stale names in the allow-list).
    for (const m of ALLOWED_DURING_PASSWORD_CHANGE) expect(routes[m], m).toBeDefined()
    await expect(dispatch('auth.me', {}, fakeSender)).resolves.toBeTruthy()

    await expect(dispatch('auth.changePassword', { oldPassword: 'temp1234', newPassword: 'temp1234' }, fakeSender)).rejects.toThrow(/different/)
    await expect(dispatch('auth.changePassword', { oldPassword: 'temp1234', newPassword: '123456' }, fakeSender)).rejects.toThrow(/too easy/)
    await dispatch('auth.changePassword', { oldPassword: 'temp1234', newPassword: 'brightSun42' }, fakeSender)
    // The gate opens immediately for the same session.
    await expect(dispatch('products.list', {}, fakeSender)).resolves.toBeTruthy()
    expect(row(owner, id).must_change_password).toBe(0)
  })

  it('sessionGate only blocks users with a pending change', () => {
    const u = { ...owner.user, mustChangePassword: true }
    expect(() => sessionGate('docs.create', u)).toThrow(/new password/)
    expect(() => sessionGate('auth.changePassword', u)).not.toThrow()
    expect(() => sessionGate('docs.create', owner.user)).not.toThrow()
  })
})

describe('password strength', () => {
  it('refuses common, repeated, sequential and username passwords', () => {
    for (const bad of ['12345', '123456', 'password', 'Password', 'aaaaaa', 'abcdef', '654321', 'qwerty']) expect(() => validatePassword(bad), bad).toThrow()
    expect(() => validatePassword('waqas1', 'waqas1')).toThrow(/username/)
    expect(validatePassword('secret123')).toBe('secret123')
    expect(validatePassword('admin123')).toBe('admin123')
  })
})

/* ================================================== printers ================================================== */

describe('printer selection', () => {
  const base = {
    printer_default: 'HP LaserJet',
    printer_invoice: 'Invoice Printer',
    printer_quotation: 'Quote Printer',
    printer_report: '',
    printer_receipt: 'POS-80',
    paper_size: 'A4',
    print_direct: true
  }

  it('maps kinds and document types to printer roles', () => {
    expect(printerRoleFor('doc', 'sale_invoice')).toBe('invoice')
    expect(printerRoleFor('doc', 'purchase_invoice')).toBe('invoice')
    expect(printerRoleFor('doc', 'quotation')).toBe('quotation')
    expect(printerRoleFor('payment')).toBe('receipt')
    for (const k of ['report', 'stock', 'statement', 'project', 'material']) expect(printerRoleFor(k)).toBe('report')
    expect(printerRoleFor('unknown')).toBeNull()
  })

  it('picks the per-kind printer, else the default printer', () => {
    expect(resolvePrintJob({ kind: 'doc', docType: 'sale_invoice', settings: base })).toMatchObject({ printer: 'Invoice Printer', source: 'printer_invoice', silent: true, pageSize: 'A4' })
    expect(resolvePrintJob({ kind: 'doc', docType: 'quotation', settings: base })).toMatchObject({ printer: 'Quote Printer', role: 'quotation' })
    expect(resolvePrintJob({ kind: 'payment', settings: base })).toMatchObject({ printer: 'POS-80', role: 'receipt' })
    expect(resolvePrintJob({ kind: 'statement', settings: base })).toMatchObject({ printer: 'HP LaserJet', source: 'printer_default', role: 'report' })
    expect(resolvePrintJob({ kind: 'weird', settings: base })).toMatchObject({ printer: 'HP LaserJet', role: null })
  })

  it('prints silently only when print_direct is on AND a printer is configured and present', () => {
    expect(resolvePrintJob({ kind: 'doc', docType: 'sale_invoice', settings: { ...base, print_direct: false } }).silent).toBe(false)
    expect(resolvePrintJob({ kind: 'doc', settings: { print_direct: true } })).toMatchObject({ printer: null, silent: false })
    const missing = resolvePrintJob({ kind: 'doc', docType: 'sale_invoice', settings: base, available: ['HP LaserJet'] })
    expect(missing).toMatchObject({ printer: null, missing: 'Invoice Printer', silent: false })
    const present = resolvePrintJob({ kind: 'doc', docType: 'sale_invoice', settings: base, available: ['Invoice Printer'] })
    expect(present).toMatchObject({ printer: 'Invoice Printer', silent: true, missing: null })
  })

  it('page sizes: named sheets, thermal rolls in microns (print) and inches (PDF)', () => {
    expect(printPageSize('A5')).toBe('A5')
    expect(printPageSize('thermal80')).toEqual({ width: 80000, height: 297000 })
    expect(printPageSize('thermal58')).toEqual({ width: 58000, height: 297000 })
    const pdf = pdfPageSize('thermal80') as { width: number; height: number }
    expect(pdf.width).toBeCloseTo(80 / 25.4, 2)
    expect(pdf.height).toBeCloseTo(297 / 25.4, 2)
    expect(resolvePrintJob({ kind: 'payment', paper: 'thermal58', settings: base })).toMatchObject({ paper: 'thermal58', marginType: 'none', pageSize: { width: 58000, height: 297000 } })
  })

  it('uses the paper_size setting; thermal default does not apply to full-page reports', () => {
    const s = { ...base, paper_size: 'thermal80' }
    expect(resolvePrintJob({ kind: 'payment', settings: s }).paper).toBe('thermal80')
    expect(resolvePrintJob({ kind: 'doc', docType: 'sale_invoice', settings: s }).paper).toBe('thermal80')
    expect(resolvePrintJob({ kind: 'report', settings: s }).paper).toBe('A4')
    expect(resolvePrintJob({ kind: 'report', paper: 'thermal80', settings: s }).paper).toBe('thermal80')
    expect(resolvePrintJob({ kind: 'doc', paper: 'nonsense', settings: { paper_size: 'Letter' } }).paper).toBe('Letter')
  })

  it('reads the print target from the print window URL', () => {
    expect(parsePrintUrl('file:///C:/app/out/renderer/index.html#/print/doc/42?paper=thermal80')).toEqual({ kind: 'doc', id: 42 })
    expect(parsePrintUrl('file:///app/index.html#/')).toBeNull()
  })

  it('normalises the OS printer list without inventing printers', () => {
    expect(normalizePrinters([])).toEqual([])
    const list = normalizePrinters(
      [
        { name: 'POS80', displayName: 'POS-80 Thermal', description: '', options: {} },
        { name: 'HP_LJ', displayName: 'HP LaserJet', description: 'HP LaserJet Pro', options: { 'printer-state': '3' } }
      ],
      parseWinPrinterJson('[{"Name":"POS80","Default":true,"WorkOffline":true,"PrinterStatus":7},{"Name":"Ghost","Default":false}]')
    )
    expect(list.map((p) => p.name)).toEqual(['POS80', 'HP_LJ'])
    expect(list[0]).toMatchObject({ isDefault: true, status: 'Offline' })
    expect(list[1]).toMatchObject({ isDefault: false, status: 'Ready', description: 'HP LaserJet Pro' })
    expect(parseWinPrinterJson('{"Name":"Only","Default":true}')).toHaveLength(1)
    expect(parseWinPrinterJson('not json')).toEqual([])
    expect(parseLpstatDefault('system default destination: Office_HP\n')).toBe('Office_HP')
    expect(normalizePrinters([{ name: 'Office_HP', options: {} }], [], 'Office_HP')[0].isDefault).toBe(true)
  })

  it('explains print failures', () => {
    expect(printFailureText('Invalid deviceName provided')).toMatch(/not available/)
    expect(printFailureText('')).toMatch(/did not accept/)
  })
})
