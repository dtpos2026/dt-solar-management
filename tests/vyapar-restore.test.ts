/**
 * Restoring a converted Vyapar backup: the owner keeps their existing password (no temporary password), device settings stay,
 * automatic backup keeps working without a session, and no plain-text Vyapar passcode travels in the converted file.
 */
import Database from 'better-sqlite3'
import { mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, describe, expect, it } from 'vitest'
import { convertVyapar, createTargetDb } from '../src/main/legacy/vyapar'
import { carryOverInstallation } from '../src/main/legacy/carryOver'
import { buildDatabaseFromJs1, exportJs1, readJs1, writeJs1 } from '../src/main/backup-json'
import { autoBackupIfDue } from '../src/main/backup'
import { hashPassword, login, saveUser } from '../src/main/services/auth'
import { updateSettings } from '../src/main/services/settings'
import { openDatabase } from '../src/main/db'
import { fakeVyapar } from './fakeVyapar'
import { setupCtx } from './helpers'

const dir = mkdtempSync(join(tmpdir(), 'dtsp-vyapar-restore-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const TEMP = 'Dtsp-0a1b2c3d'
const OWN = 'My-Existing-Pass-77'

/** A converted .js1 exactly as the converter writes it (temporary owner password, must change it). */
function convertedJs1(withSecrets = false): string {
  const src = fakeVyapar()
  if (withSecrets) {
    src.exec(`ALTER TABLE urp_users ADD COLUMN user_passcode TEXT; UPDATE urp_users SET user_passcode = '4321';
      INSERT INTO kb_settings VALUES ('VYAPAR.PASSCODEENABLED','1'), ('VYAPAR.DELETEAUTHENABLED','1'), ('VYAPAR.DELETEAUTHPIN','9876'), ('passCodeForTransactionDelete','5555');`)
  }
  const out = createTargetDb(join(dir, `conv-${withSecrets ? 's' : 'n'}.db`))
  out.transaction(() => convertVyapar(src, out, { sourceFile: 'WETCO.vyb', sourceSha256: 'x', vypName: 'w.vyp' }, { ownerPassword: TEMP }))()
  const file = join(dir, `conv-${withSecrets ? 's' : 'n'}.js1`)
  writeJs1(file, exportJs1(out, { appVersion: 'test', source: { kind: 'vyapar-conversion', file: 'WETCO.vyb' } }))
  out.close()
  return file
}

/** An existing installation: its own owner password, a second user, a custom role, a restricted user and device settings. */
function liveInstall() {
  const ctx = setupCtx()
  const owner = ctx.db.prepare('SELECT id FROM users WHERE is_owner = 1').get() as { id: number }
  ctx.db.prepare('UPDATE users SET must_change_password = 0 WHERE id = ?').run(owner.id)
  // the owner of setupCtx signs in with 'secret123'; give the installation its own password the same legitimate way
  ctx.db.prepare('UPDATE users SET password_hash = ?, username = ? WHERE id = ?').run(hashPassword(OWN), 'waqas', owner.id)
  const accountant = (ctx.db.prepare("SELECT id FROM roles WHERE name = 'Accountant'").get() as { id: number }).id
  ctx.db.prepare("INSERT INTO roles (name, description, permissions, is_system) VALUES ('Branch Clerk', 'custom', '[\"sales.view\"]', 0)").run()
  const clerkRole = (ctx.db.prepare("SELECT id FROM roles WHERE name = 'Branch Clerk'").get() as { id: number }).id
  saveUser(ctx, { username: 'accounts1', fullName: 'Accounts One', roleId: accountant, password: 'Accounts-pass-1', allFirms: true })
  const firm = (ctx.db.prepare('SELECT id FROM firms LIMIT 1').get() as { id: number }).id
  saveUser(ctx, { username: 'clerk1', fullName: 'Clerk One', roleId: clerkRole, password: 'Clerk-pass-1', allFirms: false, firmIds: [firm] })
  updateSettings(ctx, { backup_auto: 'off', backup_dir: 'D:\\Backups', lock_minutes: 45 })
  return ctx
}

describe('restoring a converted backup keeps this installation sign-in', () => {
  it('the existing owner password works at once; the temporary one is gone; other users keep theirs; restricted users wait disabled', () => {
    const live = liveInstall()
    const staged = join(dir, 'staged-1.db')
    buildDatabaseFromJs1(readJs1(convertedJs1()), staged)
    // before: the converted file only knows the temporary password
    const before = openDatabase(staged)
    const counts = (d: Database.Database): unknown => d.prepare('SELECT (SELECT COUNT(*) FROM documents) docs, (SELECT ROUND(SUM(grand_total), 2) FROM documents) total, (SELECT COUNT(*) FROM payments) pay, (SELECT COUNT(*) FROM parties) parties, (SELECT COUNT(*) FROM legacy_records) legacy').get()
    const businessBefore = counts(before)
    expect(() => login(before, 'waqas', OWN)).toThrow()
    expect(login(before, 'admin', TEMP).user.mustChangePassword).toBe(true)
    before.close()

    const r = carryOverInstallation(live.db, staged)
    expect(r.owner).toBe(true)
    expect(r.ownerUsername).toBe('waqas')
    expect(r.users).toBe(2)
    expect(r.disabled).toEqual([expect.objectContaining({ username: 'clerk1' })])
    expect(r.settings).toEqual(expect.arrayContaining(['backup_auto', 'backup_dir', 'lock_minutes']))

    const db = openDatabase(staged)
    const owner = login(db, 'waqas', OWN)
    expect(owner.user.isOwner).toBe(true)
    expect(owner.user.mustChangePassword).toBe(false)
    expect(() => login(db, 'admin', TEMP)).toThrow() // the one-off password is not left behind
    expect(login(db, 'accounts1', 'Accounts-pass-1').user.roleName).toBe('Accountant')
    expect(() => login(db, 'clerk1', 'Clerk-pass-1')).toThrow(/disabled/i)
    expect((db.prepare("SELECT name FROM roles WHERE name = 'Branch Clerk'").get() as { name: string }).name).toBe('Branch Clerk')
    // device settings of this computer; automatic backup is on (it was off here, Vyapar had it on)
    const setting = (k: string): unknown => JSON.parse((db.prepare('SELECT value FROM settings WHERE key = ?').get(k) as { value: string }).value)
    expect(setting('backup_auto')).toBe('daily')
    expect(setting('backup_dir')).toBe('D:\\Backups')
    expect(setting('lock_minutes')).toBe(45)
    // the business data of the conversion is untouched
    expect(counts(db)).toEqual(businessBefore)
    expect((db.prepare("SELECT COUNT(*) AS c FROM audit_log WHERE action = 'carry_over'").get() as { c: number }).c).toBe(1)
    expect(db.pragma('integrity_check', { simple: true })).toBe('ok')
    db.close()
    // no plaintext password anywhere in the restored file
    const bytes = readFileSync(staged).toString('latin1')
    for (const pw of [OWN, TEMP, 'Accounts-pass-1', 'Clerk-pass-1']) expect(bytes.includes(pw)).toBe(false)
  })

  it('a computer without an owner keeps the temporary password; nothing else is changed', () => {
    const empty = new Database(':memory:')
    empty.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, is_owner INTEGER, is_active INTEGER)')
    const staged = join(dir, 'staged-2.db')
    buildDatabaseFromJs1(readJs1(convertedJs1()), staged)
    const r = carryOverInstallation(empty as never, staged)
    expect(r).toEqual({ owner: false, ownerUsername: null, users: 0, disabled: [], settings: [] })
    const db = openDatabase(staged)
    expect(login(db, 'admin', TEMP).user.mustChangePassword).toBe(true)
    db.close()
  })

  it('the converted file is rejected when the carry-over cannot be completed (no half restored accounts)', () => {
    const live = liveInstall()
    const staged = join(dir, 'staged-3.db')
    buildDatabaseFromJs1(readJs1(convertedJs1()), staged)
    const c = new Database(staged)
    c.prepare('DELETE FROM users').run() // a damaged file without any owner
    c.close()
    expect(() => carryOverInstallation(live.db, staged)).toThrow(/no owner account/)
  })
})

describe('automatic backup does not need a password or a signed-in user', () => {
  it('runs from the schedule alone, once a day, into the chosen folder', async () => {
    const live = setupCtx()
    live.db.prepare("UPDATE settings SET value = '\"daily\"' WHERE key = 'backup_auto'").run()
    const folder = join(dir, 'auto')
    live.db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('backup_dir', JSON.stringify(folder))
    const first = await autoBackupIfDue(live.db, folder)
    expect(first?.file).toBeTruthy()
    const second = await autoBackupIfDue(live.db, folder)
    expect(second).toBeNull() // already done today: no second copy, nothing asked
  })
})

describe('plain-text Vyapar passcodes are not copied into the converted file', () => {
  it('keeps the rows and the on/off flags but not the secrets', () => {
    const file = convertedJs1(true)
    const text = readFileSync(file, 'utf8')
    for (const secret of ['4321', '9876', '5555']) expect(text.includes(`"${secret}"`)).toBe(false)
    const db = new Database(':memory:')
    const staged = join(dir, 'staged-4.db')
    buildDatabaseFromJs1(readJs1(file), staged)
    const conv = new Database(staged, { readonly: true })
    const rows = conv.prepare("SELECT data FROM legacy_records WHERE table_name = 'kb_settings'").all() as Array<{ data: string }>
    const byKey = new Map(rows.map((r) => JSON.parse(r.data)).map((d: { setting_key: string; setting_value: string }) => [d.setting_key, d.setting_value]))
    expect(byKey.get('VYAPAR.DELETEAUTHPIN')).toBe('[not archived: secret]')
    expect(byKey.get('passCodeForTransactionDelete')).toBe('[not archived: secret]')
    expect(byKey.get('VYAPAR.PASSCODEENABLED')).toBe('1') // a flag, not a secret
    expect(byKey.get('VYAPAR.DELETEAUTHENABLED')).toBe('1')
    const u = JSON.parse((conv.prepare("SELECT data FROM legacy_records WHERE table_name = 'urp_users'").get() as { data: string }).data)
    expect(u.user_passcode).toBe('[not archived: secret]')
    expect(u.user_name).toBe('Admin')
    conv.close()
    db.close()
  })
})
