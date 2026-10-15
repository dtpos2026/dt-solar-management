import Database from 'better-sqlite3'
import { DEFAULT_ROLES, PERMISSION_CATALOGUE_VERSION, PERMISSION_UPGRADES } from '../../shared/permissions'
import { MIGRATIONS, LATEST_SCHEMA_VERSION } from './migrations'

export type DB = Database.Database

export const APP_DB_MARKER = 'dt-solar-pro'

export interface OpenOptions {
  /** Called with the current version before pending migrations run on an existing database. */
  beforeMigrate?: (db: DB, fromVersion: number, toVersion: number) => void
}

export function openDatabase(file: string, opts: OpenOptions = {}): DB {
  const db = new Database(file)
  configure(db)
  migrate(db, opts)
  seedDefaults(db)
  return db
}

export function configure(db: DB): void {
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  db.pragma('synchronous = NORMAL')
  db.pragma('busy_timeout = 5000')
}

export function getSchemaVersion(db: DB): number {
  const hasTable = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_migrations'")
    .get()
  if (!hasTable) return 0
  const row = db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as { v: number | null }
  return row.v ?? 0
}

export function migrate(db: DB, opts: OpenOptions = {}): void {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  )`)
  const current = getSchemaVersion(db)
  if (current > LATEST_SCHEMA_VERSION) {
    throw new Error(
      `This database was created by a newer version of DT Solar Pro (schema v${current}). ` +
        `Please install the latest version. Your data has not been changed.`
    )
  }
  const pending = MIGRATIONS.filter((m) => m.version > current)
  if (pending.length === 0) return
  if (current > 0 && opts.beforeMigrate) opts.beforeMigrate(db, current, LATEST_SCHEMA_VERSION)
  for (const m of pending) {
    const run = db.transaction(() => {
      db.exec(m.sql)
      db.prepare('INSERT INTO schema_migrations (version, name) VALUES (?, ?)').run(m.version, m.name)
    })
    run()
  }
  db.prepare('INSERT OR REPLACE INTO app_meta (key, value) VALUES (?, ?)').run('app', APP_DB_MARKER)
  db.prepare('INSERT OR IGNORE INTO app_meta (key, value) VALUES (?, ?)').run('created_at', new Date().toISOString())
}

export const DEFAULT_SETTINGS: Record<string, unknown> = {
  multi_firm_enabled: true,
  max_firms: 5,
  share_inventory: true,
  share_parties: true,
  currency_symbol: 'Rs.',
  currency_code: 'PKR',
  currency_word: 'Rupees',
  money_decimals: 0,
  allow_negative_stock: false,
  purchase_tax_is_cost: false,
  overhead_method: 'none',
  overhead_percent: 0,
  lock_minutes: 15,
  backup_auto: 'daily',
  backup_dir: '',
  backup_keep: 15,
  last_auto_backup: '',
  show_vendor_branding: true,
  // v1.1
  login_show_users: true,
  print_direct: false,
  printer_default: '',
  printer_invoice: '',
  printer_quotation: '',
  printer_report: '',
  printer_receipt: '',
  paper_size: 'A4',
  location_sharing: 'off',
  location_manual: '',
  whatsapp_mode: 'chat_link',
  whatsapp_country_code: '92',
  whatsapp_cloud_phone_id: '',
  backup_on_day_close: true,
  default_invoice_terms:
    'Goods once sold will not be taken back without prior approval.\nWarranty is subject to manufacturer terms and conditions.\nPayment is due as per agreed terms.',
  default_quotation_terms:
    'This quotation is valid for 7 days.\n50% advance payment is required to confirm the order.\nInstallation will be completed within the agreed timeline after advance payment.\nPrices are subject to change according to market rates.'
}

const DEFAULT_PRODUCT_CATEGORIES: Array<[string, string]> = [
  ['Solar Panels', 'goods'],
  ['On-Grid Inverters', 'goods'],
  ['Off-Grid Inverters', 'goods'],
  ['Hybrid Inverters', 'goods'],
  ['Batteries', 'goods'],
  ['Mounting Structures', 'goods'],
  ['DC Cables', 'goods'],
  ['AC Cables', 'goods'],
  ['Breakers & Protection', 'goods'],
  ['Accessories', 'goods'],
  ['Installation Materials', 'goods'],
  ['Services & Labor', 'service']
]

const DEFAULT_EXPENSE_CATEGORIES: Array<[string, string]> = [
  ['Installation Labor', 'labor'],
  ['Contractor Charges', 'contractor'],
  ['Transportation & Delivery', 'transport'],
  ['Site Material (Direct Purchase)', 'material'],
  ['Other Project Cost', 'other'],
  ['Office Rent', 'overhead'],
  ['Salaries', 'overhead'],
  ['Utilities (Electricity, Internet)', 'overhead'],
  ['Fuel & Travel', 'overhead'],
  ['Marketing & Advertising', 'overhead'],
  ['Repairs & Maintenance', 'overhead'],
  ['Miscellaneous', 'overhead']
]

export function seedDefaults(db: DB): void {
  const tx = db.transaction(() => {
    const insSetting = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)')
    for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) insSetting.run(k, JSON.stringify(v))

    const roleCount = (db.prepare('SELECT COUNT(*) AS c FROM roles').get() as { c: number }).c
    if (roleCount === 0) {
      const ins = db.prepare('INSERT INTO roles (name, description, permissions, is_system) VALUES (?, ?, ?, 1)')
      for (const r of DEFAULT_ROLES) ins.run(r.name, r.description, JSON.stringify(r.permissions))
    }

    upgradeRolePermissions(db)

    const catCount = (db.prepare('SELECT COUNT(*) AS c FROM categories').get() as { c: number }).c
    if (catCount === 0) {
      const ins = db.prepare('INSERT INTO categories (name, kind, firm_id) VALUES (?, ?, NULL)')
      for (const [n, k] of DEFAULT_PRODUCT_CATEGORIES) ins.run(n, k)
    }

    const expCount = (db.prepare('SELECT COUNT(*) AS c FROM expense_categories').get() as { c: number }).c
    if (expCount === 0) {
      const ins = db.prepare('INSERT INTO expense_categories (name, cost_head) VALUES (?, ?)')
      for (const [n, h] of DEFAULT_EXPENSE_CATEGORIES) ins.run(n, h)
    }

    const taxCount = (db.prepare('SELECT COUNT(*) AS c FROM tax_rates').get() as { c: number }).c
    if (taxCount === 0) {
      db.prepare("INSERT INTO tax_rates (name, rate, is_default) VALUES ('No Tax', 0, 1)").run()
    }
  })
  tx()
}

/**
 * Adds permissions introduced in later versions to the built-in roles that ship with them (once per catalogue
 * version). Custom roles are never changed; the owner always has every permission anyway.
 */
function upgradeRolePermissions(db: DB): void {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'permissions_version'").get() as { value: string } | undefined
  const current = row ? Number(JSON.parse(row.value)) || 1 : 1
  if (current >= PERMISSION_CATALOGUE_VERSION) return
  const roles = db.prepare('SELECT id, name, permissions FROM roles WHERE is_system = 1').all() as Array<{ id: number; name: string; permissions: string }>
  const upd = db.prepare('UPDATE roles SET permissions = ? WHERE id = ?')
  for (const r of roles) {
    const def = DEFAULT_ROLES.find((d) => d.name === r.name)
    if (!def) continue
    let perms: string[] = []
    try {
      perms = JSON.parse(r.permissions) as string[]
    } catch {
      perms = []
    }
    const add = PERMISSION_UPGRADES.filter((u) => u.version > current)
      .flatMap((u) => u.perms)
      .filter((p) => def.permissions.includes(p) && !perms.includes(p))
    if (add.length) upd.run(JSON.stringify([...perms, ...add]), r.id)
  }
  db.prepare("INSERT INTO settings (key, value) VALUES ('permissions_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(
    JSON.stringify(PERMISSION_CATALOGUE_VERSION)
  )
}

/** Quick integrity validation used by backup/restore. */
export function validateDatabaseFile(file: string): {
  ok: boolean
  error?: string
  schemaVersion?: number
  summary?: Record<string, number | string>
} {
  let db: DB | null = null
  try {
    db = new Database(file, { readonly: true, fileMustExist: true })
    const integrity = db.pragma('integrity_check', { simple: true }) as string
    if (integrity !== 'ok') return { ok: false, error: `Integrity check failed: ${integrity}` }
    const marker = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='app_meta'").get()
    if (!marker) return { ok: false, error: 'This file is not a DT Solar Pro database.' }
    const app = db.prepare("SELECT value FROM app_meta WHERE key='app'").get() as { value: string } | undefined
    if (!app || app.value !== APP_DB_MARKER) return { ok: false, error: 'This file is not a DT Solar Pro database.' }
    const schemaVersion = getSchemaVersion(db)
    if (schemaVersion > LATEST_SCHEMA_VERSION) {
      return { ok: false, error: `Backup was made by a newer app version (schema v${schemaVersion}). Update the app first.` }
    }
    const count = (t: string): number => (db!.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get() as { c: number }).c
    const last = db
      .prepare("SELECT MAX(date) AS d FROM documents WHERE status <> 'cancelled'")
      .get() as { d: string | null }
    return {
      ok: true,
      schemaVersion,
      summary: {
        firms: count('firms'),
        users: count('users'),
        products: count('products'),
        parties: count('parties'),
        documents: count('documents'),
        projects: count('projects'),
        payments: count('payments'),
        lastTransactionDate: last.d ?? '—'
      }
    }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  } finally {
    db?.close()
  }
}
