/**
 * Keeps this installation's sign-in accounts and device settings when a converted (Vyapar) backup replaces the data.
 *
 * Why: a conversion has no password of the owner to carry (Vyapar has no exportable password), so the converted file holds a
 * one-off temporary password. Restoring it replaced every account, so the owner's existing password stopped working and a
 * password change was forced. The owner who restores is already signed in and has confirmed the restore, so the accounts of
 * THIS installation can legitimately be kept: their PBKDF2 hashes are copied as they are (no plaintext is ever read, shown
 * or stored, nothing is reset, nothing is bypassed). The backup itself is not changed in any other way.
 */
import Database from 'better-sqlite3'
import type { DB } from '../db'

/** Device level settings that belong to this computer, not to the business that was converted. */
export const DEVICE_SETTING_KEYS = [
  'lock_minutes',
  'backup_auto',
  'backup_dir',
  'backup_keep',
  'last_auto_backup',
  'backup_on_day_close',
  'login_show_users',
  'print_direct',
  'printer_default',
  'printer_invoice',
  'printer_quotation',
  'printer_report',
  'printer_receipt',
  'paper_size',
  'location_sharing',
  'location_prompted',
  'whatsapp_mode',
  'whatsapp_country_code',
  'whatsapp_notifications'
]

export interface CarryOverResult {
  /** The owner of this installation keeps their username and password in the restored data. */
  owner: boolean
  /** Other accounts carried over (enabled ones keep their password too). */
  users: number
  /** Accounts that were carried over disabled, with the reason. */
  disabled: Array<{ username: string; reason: string }>
  settings: string[]
}

type Row = Record<string, unknown>

const columnsOf = (db: Database.Database, table: string): string[] => (db.prepare(`PRAGMA table_info("${table}")`).all() as Array<{ name: string }>).map((c) => c.name)

/**
 * Copies the accounts and device settings of `live` into the staged (restored) database file. Does nothing when the live
 * database has no active owner (a fresh installation restoring its first backup keeps the temporary password).
 */
export function carryOverInstallation(live: DB, stagedFile: string): CarryOverResult {
  const result: CarryOverResult = { owner: false, users: 0, disabled: [], settings: [] }
  const liveOwner = live.prepare('SELECT * FROM users WHERE is_owner = 1 AND is_active = 1 ORDER BY id LIMIT 1').get() as Row | undefined
  if (!liveOwner) return result

  const out = new Database(stagedFile)
  try {
    out.pragma('foreign_keys = ON')
    const liveCols = new Set(columnsOf(live, 'users'))
    const outCols = columnsOf(out, 'users')
    const common = outCols.filter((c) => liveCols.has(c))
    // The restored data decides: its own ids, role, firm access and creation time.
    const KEEP_OWN = new Set(['id', 'role_id', 'is_owner', 'all_firms', 'last_firm_id', 'created_at'])
    const copyCols = common.filter((c) => !KEEP_OWN.has(c))

    out.transaction(() => {
      const outOwner = out.prepare('SELECT id FROM users WHERE is_owner = 1 ORDER BY id LIMIT 1').get() as { id: number } | undefined
      if (!outOwner) throw new Error('The converted backup has no owner account to attach the current sign-in to.')

      // Free the username first when a different (non-owner) account of the backup already uses it.
      out.prepare('DELETE FROM user_firms WHERE user_id IN (SELECT id FROM users WHERE username = ? AND id <> ?)').run(liveOwner.username, outOwner.id)
      out.prepare('DELETE FROM users WHERE username = ? COLLATE NOCASE AND id <> ?').run(liveOwner.username, outOwner.id)
      out.prepare(`UPDATE users SET ${copyCols.map((c) => `"${c}" = @${c}`).join(', ')} WHERE id = @__id`).run({ ...pick(liveOwner, copyCols), __id: outOwner.id })
      result.owner = true

      // The other accounts of this installation: same hashes, roles matched by name (created when missing).
      const liveRoles = new Map((live.prepare('SELECT * FROM roles').all() as Row[]).map((r) => [Number(r.id), r]))
      const roleId = (liveRoleId: number): number => {
        const lr = liveRoles.get(liveRoleId)
        if (!lr) throw new Error('A user has a role that does not exist.')
        const found = out.prepare('SELECT id FROM roles WHERE name = ? COLLATE NOCASE').get(String(lr.name)) as { id: number } | undefined
        if (found) return found.id
        return Number(out.prepare('INSERT INTO roles (name, description, permissions, is_system) VALUES (?, ?, ?, 0)').run(lr.name, lr.description ?? null, lr.permissions).lastInsertRowid)
      }
      const others = live.prepare('SELECT * FROM users WHERE id <> ? ORDER BY id').all(liveOwner.id) as Row[]
      for (const u of others) {
        if (u.is_owner) continue
        if (out.prepare('SELECT 1 FROM users WHERE username = ? COLLATE NOCASE').get(u.username)) continue
        const restricted = !u.all_firms
        const cols = [...copyCols, 'role_id', 'all_firms']
        const values: Row = { ...pick(u, copyCols), role_id: roleId(Number(u.role_id)), all_firms: restricted ? 0 : 1 }
        if (restricted) {
          // Firm access cannot be mapped to the converted firms, so the account waits disabled for the owner to assign firms.
          values.is_active = 0
          result.disabled.push({ username: String(u.username), reason: 'was limited to specific firms; assign firms and enable it again' })
        }
        out.prepare(`INSERT INTO users (${cols.map((c) => `"${c}"`).join(', ')}) VALUES (${cols.map((c) => '@' + c).join(', ')})`).run(values)
        result.users++
      }

      // Device settings of this computer.
      const set = out.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)')
      for (const key of DEVICE_SETTING_KEYS) {
        const r = live.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined
        if (!r) continue
        // Vyapar's backup had automatic backup on; an installation that had it off gets it switched on.
        const value = key === 'backup_auto' && isOff(r.value) ? JSON.stringify('daily') : r.value
        set.run(key, value)
        result.settings.push(key)
      }

      out
        .prepare("INSERT INTO audit_log (user_id, username, action, entity, summary, details) VALUES (?, ?, 'carry_over', 'system', ?, ?)")
        .run(outOwner.id, String(liveOwner.username), 'Kept the sign-in accounts and device settings of this installation while restoring a converted backup', JSON.stringify({ users: result.users + 1, disabled: result.disabled, settings: result.settings }))
    })()
    // Only the tables touched here: the rest of the converted data keeps whatever the conversion validated.
    const check = [...(out.pragma('foreign_key_check(users)') as unknown[]), ...(out.pragma('foreign_key_check(user_firms)') as unknown[]), ...(out.pragma('foreign_key_check(roles)') as unknown[])]
    if (check.length) throw new Error('The restored data failed its consistency check after keeping the accounts.')
  } finally {
    out.close()
  }
  return result
}

function isOff(stored: string): boolean {
  try {
    return JSON.parse(stored) === 'off'
  } catch {
    return false
  }
}

function pick(row: Row, cols: string[]): Row {
  const o: Row = {}
  for (const c of cols) o[c] = row[c] ?? null
  return o
}
