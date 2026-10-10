import { randomBytes, scryptSync, timingSafeEqual } from 'crypto'
import type { DB } from '../db'
import { ALL_PERMISSIONS, OWNER_ROLE_NAME, PERMISSION_GROUPS } from '../../shared/permissions'
import { AppError, Ctx, SessionUser, audit, optText, requirePerm, requireText } from './context'

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

export function validatePassword(pw: unknown): string {
  if (typeof pw !== 'string' || pw.length < 6) throw new AppError('Password must be at least 6 characters.', 'VALIDATION')
  if (pw.length > 128) throw new AppError('Password is too long.', 'VALIDATION')
  return pw
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

export function login(db: DB, username: unknown, password: unknown): { user: SessionUser; lastFirmId: number | null } {
  const name = String(username ?? '').trim()
  const pw = String(password ?? '')
  if (!name || !pw) throw new AppError('Enter username and password.', 'VALIDATION')
  const u = db.prepare(`${USER_SELECT} WHERE u.username = ?`).get(name) as UserRow | undefined
  const fail = (msg = 'Invalid username or password.'): never => {
    db.prepare(
      `INSERT INTO audit_log (user_id, username, action, entity, summary) VALUES (?, ?, 'login_failed', 'user', ?)`
    ).run(u?.id ?? null, name, msg)
    throw new AppError(msg, 'AUTH')
  }
  if (!u) return fail()
  if (!u.is_active) return fail('This user account is disabled. Contact your administrator.')
  if (u.locked_until && new Date(u.locked_until).getTime() > Date.now()) {
    return fail('Too many failed attempts. Try again in a few minutes.')
  }
  if (!verifyPassword(pw, u.password_hash)) {
    const attempts = u.failed_attempts + 1
    const lockedUntil = attempts >= MAX_FAILED ? new Date(Date.now() + LOCK_MINUTES * 60000).toISOString() : null
    db.prepare('UPDATE users SET failed_attempts = ?, locked_until = ? WHERE id = ?').run(
      attempts >= MAX_FAILED ? 0 : attempts,
      lockedUntil,
      u.id
    )
    return fail()
  }
  db.prepare(
    "UPDATE users SET failed_attempts = 0, locked_until = NULL, last_login_at = datetime('now','localtime') WHERE id = ?"
  ).run(u.id)
  db.prepare(`INSERT INTO audit_log (user_id, username, action, entity, entity_id, summary) VALUES (?, ?, 'login', 'user', ?, 'Signed in')`).run(
    u.id,
    u.username,
    u.id
  )
  return { user: buildSessionUser(db, u.id), lastFirmId: u.last_firm_id }
}

export function verifyUserPassword(db: DB, userId: number, password: unknown): boolean {
  const row = db.prepare('SELECT password_hash FROM users WHERE id = ? AND is_active = 1').get(userId) as
    | { password_hash: string }
    | undefined
  if (!row) return false
  return verifyPassword(String(password ?? ''), row.password_hash)
}

export function changeOwnPassword(ctx: Ctx, oldPassword: unknown, newPassword: unknown): void {
  if (!verifyUserPassword(ctx.db, ctx.user.id, oldPassword)) throw new AppError('Current password is incorrect.', 'AUTH')
  const pw = validatePassword(newPassword)
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
              u.all_firms, u.last_login_at, u.created_at,
              (SELECT GROUP_CONCAT(firm_id) FROM user_firms uf WHERE uf.user_id = u.id) AS firm_ids
       FROM users u JOIN roles r ON r.id = u.role_id ORDER BY u.is_owner DESC, u.full_name`
    )
    .all() as Array<Record<string, unknown>>
  return rows.map((r) => ({
    ...r,
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
          hashPassword(validatePassword(input.password)),
          id
        )
        audit(ctx, 'password_reset', 'user', id, `Reset password for ${username}`)
      }
      audit(ctx, 'update', 'user', id, `Updated user ${username}`, { role: role.name, allFirms, firmIds })
    } else {
      const pw = validatePassword(input.password)
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
