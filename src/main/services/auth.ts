import { randomBytes, scryptSync, timingSafeEqual } from 'crypto'
import type { DB } from '../db'
import { ALL_PERMISSIONS, OWNER_ROLE_NAME, PERMISSION_GROUPS } from '../../shared/permissions'
import { AppError, Ctx, SessionUser, audit, optText, requirePerm, requireText } from './context'
import { canonicalTemp, consumeReset, getPendingReset, matchTemporaryPassword } from './adminReset'

const SCRYPT_N = 16384
const SCRYPT_R = 8
const SCRYPT_P = 1
const KEYLEN = 64
const MAX_FAILED = 5
const LOCK_MINUTES = 5

export function hashPassword(password: string): string {
  const salt = randomBytes(16)
  const hash = scryptSync(password, salt, KEYLEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P })
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('base64')}$${hash.toString('base64')}`
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split('$')
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false
  const [, n, r, p, saltB64, hashB64] = parts
  const expected = Buffer.from(hashB64, 'base64')
  const actual = scryptSync(password, Buffer.from(saltB64, 'base64'), expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p)
  })
  return expected.length === actual.length && timingSafeEqual(expected, actual)
}

/** Passwords that are refused outright (most common choices; checked case-insensitively). */
const COMMON_PASSWORDS = new Set([
  'password', 'password1', 'passw0rd', 'p@ssword', '123456', '1234567', '12345678', '123456789', '1234567890', '654321',
  '111111', '000000', '123123', 'abc123', 'qwerty', 'qwerty123', 'iloveyou', 'admin', 'admin1', 'welcome', 'letmein',
  'pakistan', 'solar123'
])

/** True when the text is one character repeated or a straight run such as 123456 / abcdef / 654321. */
function isTrivialSequence(v: string): boolean {
  if (v.length < 2) return true
  if (/^(.)\1+$/.test(v)) return true
  const codes = [...v.toLowerCase()].map((c) => c.charCodeAt(0))
  const step = codes[1] - codes[0]
  if (Math.abs(step) !== 1) return false
  return codes.every((c, i) => i === 0 || c - codes[i - 1] === step)
}

/**
 * Password strength check used for every password a person chooses (setup wizard owner, new users, resets,
 * own change). Kept deliberately simple so staff can follow it: 6+ characters, not a common password, not a
 * repeated character or a straight sequence, and not the same as the username.
 */
export function validatePassword(pw: unknown, username?: string | null): string {
  if (typeof pw !== 'string' || pw.length < 6) throw new AppError('Password must be at least 6 characters.', 'VALIDATION')
  if (pw.length > 128) throw new AppError('Password is too long.', 'VALIDATION')
  const lower = pw.toLowerCase()
  if (COMMON_PASSWORDS.has(lower) || isTrivialSequence(pw)) {
    throw new AppError('This password is too easy to guess. Use a mix of letters and numbers (for example a word plus a few digits).', 'VALIDATION')
  }
  if (username && lower === String(username).trim().toLowerCase()) throw new AppError('The password must not be the same as the username.', 'VALIDATION')
  return pw
}

/* ---------------------------- PIN ---------------------------- */

export const PIN_MAX_FAILED = 5
export const PIN_LOCK_MINUTES = 5

/** PIN rules: 4–6 digits, not one digit repeated (0000) and not a straight run (1234 / 4321). */
export function validatePin(pin: unknown): string {
  const v = typeof pin === 'string' ? pin.trim() : typeof pin === 'number' ? String(pin) : ''
  if (!/^\d{4,6}$/.test(v)) throw new AppError('PIN must be 4 to 6 digits.', 'VALIDATION')
  if (isTrivialSequence(v)) throw new AppError('This PIN is too easy to guess (like 1234 or 0000). Choose another one.', 'VALIDATION')
  return v
}

/** PINs are hashed exactly like passwords (scrypt with a random salt) — never stored in plain text. */
export function hashPin(pin: string): string {
  return hashPassword(validatePin(pin))
}

interface UserRow {
  id: number
  username: string
  full_name: string
  email: string | null
  phone: string | null
  password_hash: string
  role_id: number
  role_name: string
  role_permissions: string
  is_owner: number
  is_active: number
  all_firms: number
  must_change_password: number
  failed_attempts: number
  locked_until: string | null
  last_login_at: string | null
  last_firm_id: number | null
  created_at: string
  pin_hash: string | null
  pin_failed_attempts: number
  pin_locked_until: string | null
}

const USER_SELECT = `SELECT u.*, r.name AS role_name, r.permissions AS role_permissions
  FROM users u JOIN roles r ON r.id = u.role_id`

export function buildSessionUser(db: DB, userId: number): SessionUser {
  const u = db.prepare(`${USER_SELECT} WHERE u.id = ?`).get(userId) as UserRow | undefined
  if (!u) throw new AppError('User not found.', 'NOT_FOUND')
  const firmIds = (db.prepare('SELECT firm_id FROM user_firms WHERE user_id = ?').all(userId) as { firm_id: number }[]).map(
    (r) => r.firm_id
  )
  let permissions: string[] = []
  try {
    permissions = JSON.parse(u.role_permissions)
  } catch {
    permissions = []
  }
  return {
    id: u.id,
    username: u.username,
    fullName: u.full_name,
    roleId: u.role_id,
    roleName: u.role_name,
    isOwner: !!u.is_owner,
    permissions: u.is_owner ? ALL_PERMISSIONS : permissions.filter((p) => ALL_PERMISSIONS.includes(p)),
    allFirms: !!u.all_firms || !!u.is_owner,
    firmIds,
    mustChangePassword: !!u.must_change_password
  }
}

export function userCount(db: DB): number {
  return (db.prepare('SELECT COUNT(*) AS c FROM users').get() as { c: number }).c
}

/** Audit row for events that happen without a signed-in context (sign-in, PIN, unlock). */
function auditRaw(db: DB, userId: number | null, username: string, action: string, summary: string): void {
  db.prepare(`INSERT INTO audit_log (user_id, username, action, entity, entity_id, summary) VALUES (?, ?, ?, 'user', ?, ?)`).run(
    userId,
    username,
    action,
    userId,
    summary
  )
}

const isFuture = (ts: string | null): boolean => !!ts && new Date(ts).getTime() > Date.now()

function minutesLeft(ts: string | null): number {
  return ts ? Math.max(1, Math.ceil((new Date(ts).getTime() - Date.now()) / 60000)) : 0
}

/**
 * Checks a password for a known user row and keeps the failed-attempt counter (5 wrong passwords lock the
 * account for 5 minutes — shared by sign-in and the lock screen). Throws AppError('AUTH') on failure.
 */
function checkPasswordAttempt(db: DB, u: UserRow, password: string, failAction: string, auditName: string, failMsg: string): void {
  const fail = (msg: string): never => {
    auditRaw(db, u.id, auditName, failAction, msg)
    throw new AppError(msg, 'AUTH')
  }
  if (!u.is_active) return fail('This user account is disabled. Contact your administrator.')
  if (isFuture(u.locked_until)) return fail(`Too many failed attempts. Try again in ${minutesLeft(u.locked_until)} minute(s).`)
  if (!verifyPassword(password, u.password_hash)) {
    const attempts = u.failed_attempts + 1
    const lockedUntil = attempts >= MAX_FAILED ? new Date(Date.now() + LOCK_MINUTES * 60000).toISOString() : null
    db.prepare('UPDATE users SET failed_attempts = ?, locked_until = ? WHERE id = ?').run(attempts >= MAX_FAILED ? 0 : attempts, lockedUntil, u.id)
    if (lockedUntil) {
      auditRaw(db, u.id, auditName, 'account_locked', `Account locked for ${LOCK_MINUTES} minutes after ${MAX_FAILED} wrong passwords`)
      return fail(`Too many failed attempts. Try again in ${LOCK_MINUTES} minute(s).`)
    }
    return fail(failMsg)
  }
  db.prepare('UPDATE users SET failed_attempts = 0, locked_until = NULL WHERE id = ?').run(u.id)
}

/**
 * Administrator password reset sent by Digital Target: the owner signs in with the temporary password the Super Admin relayed
 * (verified against the signed command's PBKDF2 verifier — no plaintext is stored anywhere). The account then gets a normal
 * hash and must choose a new password; a locked or failed-attempt state is cleared because recovery is the point.
 */
function tryAdminResetLogin(db: DB, u: UserRow, password: string): boolean {
  if (!u.is_owner) return false
  const pending = getPendingReset(db)
  if (!pending || !matchTemporaryPassword(pending, password)) return false
  db.transaction(() => {
    db.prepare("UPDATE users SET password_hash = ?, must_change_password = 1, failed_attempts = 0, locked_until = NULL, is_active = 1, updated_at = datetime('now','localtime') WHERE id = ?").run(
      hashPassword(canonicalTemp(password)),
      u.id
    )
    consumeReset(db, pending)
    auditRaw(db, u.id, u.username, 'password_reset', 'Administrator password reset by Digital Target; a new password must be chosen')
  })()
  return true
}

function completeLogin(db: DB, u: UserRow, method: 'password' | 'pin'): { user: SessionUser; lastFirmId: number | null } {
  db.prepare("UPDATE users SET last_login_at = datetime('now','localtime') WHERE id = ?").run(u.id)
  auditRaw(db, u.id, u.username, method === 'pin' ? 'pin_login' : 'login', method === 'pin' ? 'Signed in with PIN' : 'Signed in')
  return { user: buildSessionUser(db, u.id), lastFirmId: u.last_firm_id }
}

export function login(db: DB, username: unknown, password: unknown): { user: SessionUser; lastFirmId: number | null } {
  const name = String(username ?? '').trim()
  const pw = String(password ?? '')
  if (!name || !pw) throw new AppError('Enter username and password.', 'VALIDATION')
  const u = db.prepare(`${USER_SELECT} WHERE u.username = ?`).get(name) as UserRow | undefined
  if (!u) {
    auditRaw(db, null, name, 'login_failed', 'Invalid username or password.')
    throw new AppError('Invalid username or password.', 'AUTH')
  }
  if (tryAdminResetLogin(db, u, pw)) return completeLogin(db, u, 'password')
  checkPasswordAttempt(db, u, pw, 'login_failed', name, 'Invalid username or password.')
  return completeLogin(db, u, 'password')
}

function userById(db: DB, userId: unknown): UserRow {
  const id = Number(userId)
  const u = Number.isInteger(id) && id > 0 ? (db.prepare(`${USER_SELECT} WHERE u.id = ?`).get(id) as UserRow | undefined) : undefined
  if (!u || !u.is_active) throw new AppError('This user is not available. Choose another user or sign in with your username.', 'AUTH')
  return u
}

/** Sign-in after picking a user tile on the sign-in screen, with that user's password. */
export function loginById(db: DB, userId: unknown, password: unknown): { user: SessionUser; lastFirmId: number | null } {
  const pw = String(password ?? '')
  if (!pw) throw new AppError('Enter your password.', 'VALIDATION')
  const u = userById(db, userId)
  if (tryAdminResetLogin(db, u, pw)) return completeLogin(db, u, 'password')
  checkPasswordAttempt(db, u, pw, 'login_failed', u.username, 'Incorrect password.')
  return completeLogin(db, u, 'password')
}

/**
 * Checks a PIN for a user and keeps the PIN failure counter: 5 wrong PINs lock PIN sign-in for 5 minutes
 * (the password still works). A password lock-out also blocks the PIN so the PIN cannot bypass it.
 */
function checkPinAttempt(db: DB, u: UserRow, pin: unknown, context: 'login' | 'unlock'): void {
  const fail = (msg: string, action = context === 'login' ? 'pin_login_failed' : 'pin_unlock_failed'): never => {
    auditRaw(db, u.id, u.username, action, msg)
    throw new AppError(msg, 'AUTH')
  }
  if (!u.is_active) return fail('This user account is disabled. Contact your administrator.')
  if (!u.pin_hash) return fail('PIN sign-in is not set up for this user. Use the password.')
  if (isFuture(u.locked_until)) return fail(`Too many failed attempts. Try again in ${minutesLeft(u.locked_until)} minute(s).`)
  if (isFuture(u.pin_locked_until)) {
    return fail(`PIN is locked after ${PIN_MAX_FAILED} wrong attempts. Try again in ${minutesLeft(u.pin_locked_until)} minute(s) or use your password.`)
  }
  const v = typeof pin === 'string' || typeof pin === 'number' ? String(pin).trim() : ''
  if (!/^\d{4,6}$/.test(v) || !verifyPassword(v, u.pin_hash)) {
    const attempts = u.pin_failed_attempts + 1
    if (attempts >= PIN_MAX_FAILED) {
      const until = new Date(Date.now() + PIN_LOCK_MINUTES * 60000).toISOString()
      db.prepare('UPDATE users SET pin_failed_attempts = 0, pin_locked_until = ? WHERE id = ?').run(until, u.id)
      auditRaw(db, u.id, u.username, 'pin_locked', `PIN locked for ${PIN_LOCK_MINUTES} minutes after ${PIN_MAX_FAILED} wrong attempts`)
      return fail(`PIN is locked after ${PIN_MAX_FAILED} wrong attempts. Try again in ${PIN_LOCK_MINUTES} minute(s) or use your password.`)
    }
    db.prepare('UPDATE users SET pin_failed_attempts = ? WHERE id = ?').run(attempts, u.id)
    const left = PIN_MAX_FAILED - attempts
    return fail(`Incorrect PIN. ${left} attempt${left === 1 ? '' : 's'} left before the PIN is locked.`)
  }
  db.prepare('UPDATE users SET pin_failed_attempts = 0, pin_locked_until = NULL WHERE id = ?').run(u.id)
}

/** Sign-in with a PIN after picking a user tile. */
export function pinLogin(db: DB, userId: unknown, pin: unknown): { user: SessionUser; lastFirmId: number | null } {
  const u = userById(db, userId)
  checkPinAttempt(db, u, pin, 'login')
  return completeLogin(db, u, 'pin')
}

/** Lock screen: unlock with the session user's PIN or password (same lock-out rules as sign-in). */
export function unlockSession(db: DB, userId: number, input: { pin?: unknown; password?: unknown }): void {
  const u = db.prepare(`${USER_SELECT} WHERE u.id = ?`).get(userId) as UserRow | undefined
  if (!u || !u.is_active) throw new AppError('This user account is no longer active. Sign out and sign in again.', 'AUTH')
  if (input.pin !== undefined && input.pin !== null && input.pin !== '') {
    checkPinAttempt(db, u, input.pin, 'unlock')
    auditRaw(db, u.id, u.username, 'unlock', 'Unlocked the screen with PIN')
    return
  }
  const pw = String(input.password ?? '')
  if (!pw) throw new AppError('Enter your password.', 'VALIDATION')
  checkPasswordAttempt(db, u, pw, 'unlock_failed', u.username, 'Incorrect password.')
  auditRaw(db, u.id, u.username, 'unlock', 'Unlocked the screen with password')
}

/** Users shown as tiles on the sign-in screen: only safe, non-secret fields of ACTIVE users. */
export interface LoginTile {
  id: number
  full_name: string
  role_name: string
  has_pin: boolean
}

export function loginTiles(db: DB): LoginTile[] {
  const rows = db
    .prepare(
      `SELECT u.id, u.full_name, r.name AS role_name, CASE WHEN u.pin_hash IS NULL THEN 0 ELSE 1 END AS has_pin
       FROM users u JOIN roles r ON r.id = u.role_id
       WHERE u.is_active = 1 ORDER BY u.is_owner DESC, u.full_name COLLATE NOCASE`
    )
    .all() as Array<{ id: number; full_name: string; role_name: string; has_pin: number }>
  return rows.map((r) => ({ id: r.id, full_name: r.full_name, role_name: r.role_name, has_pin: !!r.has_pin }))
}

/** PIN status for one user (no secrets). */
export function pinStatus(db: DB, userId: number): { hasPin: boolean; pinLocked: boolean; pinLockedMinutes: number } {
  const r = db.prepare('SELECT pin_hash, pin_locked_until FROM users WHERE id = ?').get(userId) as
    | { pin_hash: string | null; pin_locked_until: string | null }
    | undefined
  const locked = !!r && isFuture(r.pin_locked_until)
  return { hasPin: !!r?.pin_hash, pinLocked: locked, pinLockedMinutes: locked ? minutesLeft(r!.pin_locked_until) : 0 }
}

/** "Set my PIN": the signed-in user confirms with the current password. */
export function setOwnPin(ctx: Ctx, currentPassword: unknown, pin: unknown): void {
  if (!verifyUserPassword(ctx.db, ctx.user.id, currentPassword)) throw new AppError('Current password is incorrect.', 'AUTH')
  const hash = hashPin(validatePin(pin))
  ctx.db
    .prepare("UPDATE users SET pin_hash = ?, pin_failed_attempts = 0, pin_locked_until = NULL, updated_at = datetime('now','localtime') WHERE id = ?")
    .run(hash, ctx.user.id)
  audit(ctx, 'pin_set', 'user', ctx.user.id, 'Set own sign-in PIN')
}

export function removeOwnPin(ctx: Ctx, currentPassword: unknown): void {
  if (!verifyUserPassword(ctx.db, ctx.user.id, currentPassword)) throw new AppError('Current password is incorrect.', 'AUTH')
  ctx.db.prepare('UPDATE users SET pin_hash = NULL, pin_failed_attempts = 0, pin_locked_until = NULL WHERE id = ?').run(ctx.user.id)
  audit(ctx, 'pin_removed', 'user', ctx.user.id, 'Removed own sign-in PIN')
}

function managedUser(ctx: Ctx, userId: unknown): { id: number; username: string; is_owner: number } {
  requirePerm(ctx, 'users.manage')
  const id = Number(userId)
  const u = ctx.db.prepare('SELECT id, username, is_owner FROM users WHERE id = ?').get(id) as { id: number; username: string; is_owner: number } | undefined
  if (!u) throw new AppError('User not found.', 'NOT_FOUND')
  if (u.is_owner && !ctx.user.isOwner) throw new AppError('Only the owner can change the owner account.', 'FORBIDDEN')
  return u
}

/** Administrator sets or resets a user's PIN (also clears a PIN lock-out). */
export function adminSetPin(ctx: Ctx, userId: unknown, pin: unknown): void {
  const u = managedUser(ctx, userId)
  const hash = hashPin(validatePin(pin))
  ctx.db
    .prepare("UPDATE users SET pin_hash = ?, pin_failed_attempts = 0, pin_locked_until = NULL, updated_at = datetime('now','localtime') WHERE id = ?")
    .run(hash, u.id)
  audit(ctx, u.id === ctx.user.id ? 'pin_set' : 'pin_reset', 'user', u.id, `Set sign-in PIN for ${u.username}`)
}

export function adminRemovePin(ctx: Ctx, userId: unknown): void {
  const u = managedUser(ctx, userId)
  ctx.db.prepare('UPDATE users SET pin_hash = NULL, pin_failed_attempts = 0, pin_locked_until = NULL WHERE id = ?').run(u.id)
  audit(ctx, 'pin_removed', 'user', u.id, `Removed sign-in PIN for ${u.username}`)
}

/** Clears password and PIN lock-outs (e.g. a user locked themselves out at the counter). */
export function adminUnlockUser(ctx: Ctx, userId: unknown): void {
  const u = managedUser(ctx, userId)
  ctx.db.prepare('UPDATE users SET failed_attempts = 0, locked_until = NULL, pin_failed_attempts = 0, pin_locked_until = NULL WHERE id = ?').run(u.id)
  audit(ctx, 'unlock_user', 'user', u.id, `Cleared sign-in lock-out for ${u.username}`)
}

export function verifyUserPassword(db: DB, userId: number, password: unknown): boolean {
  const row = db.prepare('SELECT password_hash FROM users WHERE id = ? AND is_active = 1').get(userId) as
    | { password_hash: string }
    | undefined
  if (!row) return false
  return verifyPassword(String(password ?? ''), row.password_hash)
}

export function changeOwnPassword(ctx: Ctx, oldPassword: unknown, newPassword: unknown): void {
  // After an Administrator reset the current password is the temporary one, which may be typed in any case, with or without dashes.
  const known = verifyUserPassword(ctx.db, ctx.user.id, oldPassword) || (ctx.user.mustChangePassword && verifyUserPassword(ctx.db, ctx.user.id, canonicalTemp(String(oldPassword ?? ''))))
  if (!known) throw new AppError('Current password is incorrect.', 'AUTH')
  const pw = validatePassword(newPassword, ctx.user.username)
  if (pw === String(oldPassword ?? '')) throw new AppError('Choose a new password that is different from the current one.', 'VALIDATION')
  ctx.db
    .prepare("UPDATE users SET password_hash = ?, must_change_password = 0, updated_at = datetime('now','localtime') WHERE id = ?")
    .run(hashPassword(pw), ctx.user.id)
  audit(ctx, 'password_change', 'user', ctx.user.id, 'Changed own password')
}

/* ---------------------------- Users ---------------------------- */

export function listUsers(ctx: Ctx): unknown[] {
  requirePerm(ctx, 'users.manage')
  const rows = ctx.db
    .prepare(
      `SELECT u.id, u.username, u.full_name, u.email, u.phone, u.role_id, r.name AS role_name, u.is_owner, u.is_active,
              u.all_firms, u.last_login_at, u.created_at, u.must_change_password, u.locked_until, u.pin_locked_until,
              CASE WHEN u.pin_hash IS NULL THEN 0 ELSE 1 END AS has_pin,
              (SELECT GROUP_CONCAT(firm_id) FROM user_firms uf WHERE uf.user_id = u.id) AS firm_ids
       FROM users u JOIN roles r ON r.id = u.role_id ORDER BY u.is_owner DESC, u.full_name`
    )
    .all() as Array<Record<string, unknown>>
  // Never return password or PIN hashes; lock-outs are reported as flags only.
  return rows.map(({ locked_until, pin_locked_until, ...r }) => ({
    ...r,
    has_pin: !!r.has_pin,
    must_change_password: !!r.must_change_password,
    login_locked: isFuture((locked_until as string | null) ?? null),
    pin_locked: isFuture((pin_locked_until as string | null) ?? null),
    firm_ids: r.firm_ids ? String(r.firm_ids).split(',').map(Number) : []
  }))
}

export interface UserInput {
  id?: number
  username: string
  fullName: string
  email?: string
  phone?: string
  roleId: number
  isActive?: boolean
  allFirms?: boolean
  firmIds?: number[]
  password?: string
}

export function saveUser(ctx: Ctx, input: UserInput): number {
  requirePerm(ctx, 'users.manage')
  const db = ctx.db
  const username = requireText(input.username, 'Username', 50).toLowerCase()
  if (!/^[a-z0-9._-]{3,50}$/.test(username)) {
    throw new AppError('Username may contain letters, numbers, dot, dash and underscore (min 3).', 'VALIDATION')
  }
  const fullName = requireText(input.fullName, 'Full name', 100)
  const role = db.prepare('SELECT id, name FROM roles WHERE id = ?').get(input.roleId) as { id: number; name: string } | undefined
  if (!role) throw new AppError('Select a valid role.', 'VALIDATION')
  const dup = db.prepare('SELECT id FROM users WHERE username = ? AND id <> ?').get(username, input.id ?? 0)
  if (dup) throw new AppError('This username is already taken.', 'VALIDATION')
  const firmIds = Array.isArray(input.firmIds) ? input.firmIds.map(Number).filter((n) => n > 0) : []
  const allFirms = input.allFirms !== false
  if (!allFirms && firmIds.length === 0) throw new AppError('Select at least one firm for this user.', 'VALIDATION')

  return db.transaction(() => {
    let id = input.id ?? 0
    if (id) {
      const existing = db.prepare('SELECT * FROM users WHERE id = ?').get(id) as { is_owner: number } | undefined
      if (!existing) throw new AppError('User not found.', 'NOT_FOUND')
      if (existing.is_owner && !ctx.user.isOwner) throw new AppError('Only the owner can edit the owner account.', 'FORBIDDEN')
      const isActive = existing.is_owner ? 1 : input.isActive === false ? 0 : 1
      if (id === ctx.user.id && !isActive) throw new AppError('You cannot disable your own account.', 'VALIDATION')
      db.prepare(
        `UPDATE users SET username = ?, full_name = ?, email = ?, phone = ?, role_id = ?, is_active = ?, all_firms = ?,
           updated_at = datetime('now','localtime') WHERE id = ?`
      ).run(
        username,
        fullName,
        optText(input.email, 120),
        optText(input.phone, 40),
        existing.is_owner ? (db.prepare('SELECT role_id FROM users WHERE id = ?').get(id) as { role_id: number }).role_id : role.id,
        isActive,
        existing.is_owner ? 1 : allFirms ? 1 : 0,
        id
      )
      if (input.password) {
        db.prepare('UPDATE users SET password_hash = ?, must_change_password = 1 WHERE id = ?').run(
          hashPassword(validatePassword(input.password, username)),
          id
        )
        audit(ctx, 'password_reset', 'user', id, `Reset password for ${username}`)
      }
      audit(ctx, 'update', 'user', id, `Updated user ${username}`, { role: role.name, allFirms, firmIds })
    } else {
      const pw = validatePassword(input.password, username)
      id = Number(
        db
          .prepare(
            `INSERT INTO users (username, full_name, email, phone, password_hash, role_id, is_active, all_firms, must_change_password)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`
          )
          .run(
            username,
            fullName,
            optText(input.email, 120),
            optText(input.phone, 40),
            hashPassword(pw),
            role.id,
            input.isActive === false ? 0 : 1,
            allFirms ? 1 : 0
          ).lastInsertRowid
      )
      audit(ctx, 'create', 'user', id, `Created user ${username}`, { role: role.name, allFirms, firmIds })
    }
    db.prepare('DELETE FROM user_firms WHERE user_id = ?').run(id)
    if (!allFirms) {
      const ins = db.prepare('INSERT OR IGNORE INTO user_firms (user_id, firm_id) VALUES (?, ?)')
      for (const f of firmIds) ins.run(id, f)
    }
    return id
  })()
}

/* ---------------------------- Roles ---------------------------- */

export function listRoles(ctx: Ctx): unknown[] {
  const rows = ctx.db
    .prepare(
      `SELECT r.*, (SELECT COUNT(*) FROM users u WHERE u.role_id = r.id) AS user_count FROM roles r ORDER BY r.id`
    )
    .all() as Array<{ permissions: string }>
  return rows.map((r) => ({ ...r, permissions: JSON.parse(r.permissions) as string[] }))
}

export function saveRole(ctx: Ctx, input: { id?: number; name: string; description?: string; permissions: string[] }): number {
  requirePerm(ctx, 'users.manage')
  const db = ctx.db
  const name = requireText(input.name, 'Role name', 60)
  const perms = (Array.isArray(input.permissions) ? input.permissions : []).filter((p) => ALL_PERMISSIONS.includes(p))
  const dup = db.prepare('SELECT id FROM roles WHERE name = ? AND id <> ?').get(name, input.id ?? 0)
  if (dup) throw new AppError('A role with this name already exists.', 'VALIDATION')
  if (input.id) {
    const role = db.prepare('SELECT * FROM roles WHERE id = ?').get(input.id) as { name: string } | undefined
    if (!role) throw new AppError('Role not found.', 'NOT_FOUND')
    if (role.name === OWNER_ROLE_NAME) throw new AppError('The Super Administrator role always has full access.', 'VALIDATION')
    db.prepare('UPDATE roles SET name = ?, description = ?, permissions = ? WHERE id = ?').run(
      name,
      optText(input.description, 300),
      JSON.stringify(perms),
      input.id
    )
    audit(ctx, 'update', 'role', input.id, `Updated role ${name}`, { permissions: perms })
    return input.id
  }
  const id = Number(
    db
      .prepare('INSERT INTO roles (name, description, permissions, is_system) VALUES (?, ?, ?, 0)')
      .run(name, optText(input.description, 300), JSON.stringify(perms)).lastInsertRowid
  )
  audit(ctx, 'create', 'role', id, `Created role ${name}`, { permissions: perms })
  return id
}

export function deleteRole(ctx: Ctx, id: number): void {
  requirePerm(ctx, 'users.manage')
  const role = ctx.db.prepare('SELECT * FROM roles WHERE id = ?').get(id) as { name: string; is_system: number } | undefined
  if (!role) throw new AppError('Role not found.', 'NOT_FOUND')
  if (role.is_system) throw new AppError('Built-in roles cannot be deleted. You can edit their permissions instead.', 'VALIDATION')
  const used = ctx.db.prepare('SELECT COUNT(*) AS c FROM users WHERE role_id = ?').get(id) as { c: number }
  if (used.c > 0) throw new AppError('This role is assigned to users. Change their role first.', 'VALIDATION')
  ctx.db.prepare('DELETE FROM roles WHERE id = ?').run(id)
  audit(ctx, 'delete', 'role', id, `Deleted role ${role.name}`)
}

export function permissionCatalogue(): typeof PERMISSION_GROUPS {
  return PERMISSION_GROUPS
}

/** Enable / disable a user's sign-in. The owner and the signed-in user cannot be disabled. */
export function setUserActive(ctx: Ctx, id: number, active: boolean): void {
  requirePerm(ctx, 'users.manage')
  const u = ctx.db.prepare('SELECT username, full_name, is_owner, is_active FROM users WHERE id = ?').get(id) as
    | { username: string; full_name: string; is_owner: number; is_active: number }
    | undefined
  if (!u) throw new AppError('User not found.', 'NOT_FOUND')
  if (!active && u.is_owner) throw new AppError('The owner account cannot be disabled.', 'VALIDATION')
  if (!active && id === ctx.user.id) throw new AppError('You cannot disable your own account.', 'VALIDATION')
  if (!!u.is_active === active) return
  ctx.db.prepare("UPDATE users SET is_active = ?, updated_at = datetime('now','localtime') WHERE id = ?").run(active ? 1 : 0, id)
  audit(ctx, active ? 'activate' : 'deactivate', 'user', id, `${active ? 'Enabled' : 'Disabled'} user ${u.username}`)
}

/**
 * Deletes a user who has no responsibilities left. Business records only store the user's name in the audit trail,
 * so they stay intact; a user who manages a project or closed / reopened a period must be disabled instead.
 */
export function deleteUser(ctx: Ctx, id: number): void {
  requirePerm(ctx, 'users.manage')
  const db = ctx.db
  const u = db.prepare('SELECT username, full_name, is_owner FROM users WHERE id = ?').get(id) as
    | { username: string; full_name: string; is_owner: number }
    | undefined
  if (!u) throw new AppError('User not found.', 'NOT_FOUND')
  if (u.is_owner) throw new AppError('The owner account cannot be deleted.', 'VALIDATION')
  if (id === ctx.user.id) throw new AppError('You cannot delete the account you are signed in with.', 'VALIDATION')
  const projects = (db.prepare('SELECT COUNT(*) AS c FROM projects WHERE manager_user_id = ?').get(id) as { c: number }).c
  const closings = (db.prepare('SELECT COUNT(*) AS c FROM day_closings WHERE closed_by = ? OR reopened_by = ?').get(id, id) as { c: number }).c
  const parts: string[] = []
  if (projects) parts.push(`${projects} project${projects > 1 ? 's' : ''} to manage`)
  if (closings) parts.push(`${closings} day / month closing${closings > 1 ? 's' : ''}`)
  if (parts.length) throw new AppError(`${u.full_name} cannot be deleted because they have ${parts.join(' and ')}. Disable the user instead.`, 'VALIDATION')
  db.transaction(() => {
    db.prepare('DELETE FROM user_firms WHERE user_id = ?').run(id)
    db.prepare('DELETE FROM users WHERE id = ?').run(id)
    audit(ctx, 'delete', 'user', id, `Deleted user ${u.username} (${u.full_name})`)
  })()
}

/* ---------------------------- Audit ---------------------------- */

export function listAudit(
  ctx: Ctx,
  f: { from?: string; to?: string; userId?: number; entity?: string; q?: string; limit?: number; offset?: number }
): { rows: unknown[]; total: number } {
  requirePerm(ctx, 'audit.view')
  const where: string[] = ['1=1']
  const p: Record<string, unknown> = {}
  if (f.from) {
    where.push('date(ts) >= @from')
    p.from = f.from
  }
  if (f.to) {
    where.push('date(ts) <= @to')
    p.to = f.to
  }
  if (f.userId) {
    where.push('user_id = @userId')
    p.userId = f.userId
  }
  if (f.entity) {
    where.push('entity = @entity')
    p.entity = f.entity
  }
  if (f.q) {
    where.push("(summary LIKE @q OR action LIKE @q OR username LIKE @q)")
    p.q = `%${f.q}%`
  }
  const w = where.join(' AND ')
  const total = (ctx.db.prepare(`SELECT COUNT(*) AS c FROM audit_log WHERE ${w}`).get(p) as { c: number }).c
  const rows = ctx.db
    .prepare(
      `SELECT a.*, f.name AS firm_name FROM audit_log a LEFT JOIN firms f ON f.id = a.firm_id WHERE ${w}
       ORDER BY a.id DESC LIMIT @limit OFFSET @offset`
    )
    .all({ ...p, limit: Math.min(f.limit ?? 100, 500), offset: f.offset ?? 0 })
  return { rows, total }
}


/** Audit rows as CSV (used for the automatic copy that is saved before anything is removed from the log). */
export function auditCsv(rows: Array<Record<string, unknown>>): string {
  const cell = (v: unknown): string => `"${String(v ?? '').replace(/"/g, '""')}"`
  const head = ['id', 'time', 'user', 'firm_id', 'action', 'entity', 'entity_id', 'summary', 'details']
  return [head.join(','), ...rows.map((r) => [r.id, r.ts, r.username, r.firm_id, r.action, r.entity, r.entity_id, r.summary, r.details].map(cell).join(','))].join('\r\n')
}

export interface AuditClearInput {
  /** 'selected' removes the given ids, 'before' removes everything up to and including a date, 'all' empties the log. */
  mode: 'selected' | 'before' | 'all'
  ids?: number[]
  before?: string
}

/**
 * Removes entries from the audit log. Only the owner may do it. The caller saves the removed rows first
 * (see auditCsv) and passes the file name; one permanent entry then records who removed how many entries and when.
 */
export function clearAudit(ctx: Ctx, input: AuditClearInput, savedAs: string): number {
  requirePerm(ctx, 'audit.view')
  if (!ctx.user.isOwner) throw new AppError('Only the owner can remove entries from the audit log.', 'FORBIDDEN')
  const db = ctx.db
  let removed = 0
  db.transaction(() => {
    if (input.mode === 'all') removed = db.prepare('DELETE FROM audit_log').run().changes
    else if (input.mode === 'before') {
      const d = typeof input.before === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(input.before) ? input.before : ''
      if (!d) throw new AppError('Choose a valid date.', 'VALIDATION')
      removed = db.prepare('DELETE FROM audit_log WHERE date(ts) <= ?').run(d).changes
    } else {
      const ids = (input.ids ?? []).map(Number).filter((n) => Number.isInteger(n) && n > 0)
      if (!ids.length) throw new AppError('Select at least one entry.', 'VALIDATION')
      const del = db.prepare('DELETE FROM audit_log WHERE id = ?')
      for (const id of ids) removed += del.run(id).changes
    }
    audit(ctx, 'clear', 'audit_log', null, `Removed ${removed} audit log entr${removed === 1 ? 'y' : 'ies'} (${input.mode})`, { mode: input.mode, before: input.before ?? null, savedAs })
  })()
  return removed
}

/** The rows a clear request would remove (for the pre-clear copy). */
export function auditRowsFor(ctx: Ctx, input: AuditClearInput): Array<Record<string, unknown>> {
  if (input.mode === 'all') return ctx.db.prepare('SELECT * FROM audit_log ORDER BY id').all() as Array<Record<string, unknown>>
  if (input.mode === 'before') return ctx.db.prepare('SELECT * FROM audit_log WHERE date(ts) <= ? ORDER BY id').all(String(input.before ?? '')) as Array<Record<string, unknown>>
  const ids = (input.ids ?? []).map(Number).filter((n) => Number.isInteger(n) && n > 0)
  if (!ids.length) return []
  return ctx.db.prepare(`SELECT * FROM audit_log WHERE id IN (${ids.map(() => '?').join(',')}) ORDER BY id`).all(...ids) as Array<Record<string, unknown>>
}
