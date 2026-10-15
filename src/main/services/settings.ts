import type { DB } from '../db'
import { DEFAULT_SETTINGS } from '../db'
import { num, round2 } from '../../shared/money'
import { AppError, Ctx, audit, getSetting, optText, requirePerm, requireText, setSetting } from './context'

/** Settings a user may change, with validators. */
const VALIDATORS: Record<string, (v: unknown) => unknown> = {
  multi_firm_enabled: (v) => !!v,
  max_firms: (v) => Math.min(100, Math.max(1, Math.floor(num(v, 5)))),
  share_inventory: (v) => !!v,
  share_parties: (v) => !!v,
  currency_symbol: (v) => String(v ?? 'Rs.').slice(0, 8),
  currency_code: (v) => String(v ?? 'PKR').slice(0, 5).toUpperCase(),
  currency_word: (v) => String(v ?? 'Rupees').slice(0, 30),
  money_decimals: (v) => Math.min(2, Math.max(0, Math.floor(num(v, 0)))),
  allow_negative_stock: (v) => !!v,
  purchase_tax_is_cost: (v) => !!v,
  overhead_method: (v) => (['none', 'manual', 'percent_revenue'].includes(String(v)) ? String(v) : 'none'),
  overhead_percent: (v) => Math.min(100, Math.max(0, round2(num(v)))),
  lock_minutes: (v) => Math.min(240, Math.max(0, Math.floor(num(v, 15)))),
  backup_auto: (v) => (['off', 'daily', 'weekly'].includes(String(v)) ? String(v) : 'off'),
  backup_dir: (v) => String(v ?? '').slice(0, 500),
  backup_keep: (v) => Math.min(200, Math.max(1, Math.floor(num(v, 15)))),
  show_vendor_branding: (v) => !!v,
  default_invoice_terms: (v) => String(v ?? '').slice(0, 5000),
  default_quotation_terms: (v) => String(v ?? '').slice(0, 5000),
  // v1.1
  login_show_users: (v) => !!v,
  print_direct: (v) => !!v,
  printer_default: (v) => String(v ?? '').slice(0, 300),
  printer_invoice: (v) => String(v ?? '').slice(0, 300),
  printer_quotation: (v) => String(v ?? '').slice(0, 300),
  printer_report: (v) => String(v ?? '').slice(0, 300),
  printer_receipt: (v) => String(v ?? '').slice(0, 300),
  paper_size: (v) => (['A4', 'A5', 'Letter', 'Legal', 'thermal80', 'thermal58'].includes(String(v)) ? String(v) : 'A4'),
  location_sharing: (v) => (['off', 'approximate', 'manual'].includes(String(v)) ? String(v) : 'off'),
  location_manual: (v) => String(v ?? '').slice(0, 200),
  whatsapp_mode: (v) => (['chat_link', 'cloud_api'].includes(String(v)) ? String(v) : 'chat_link'),
  whatsapp_country_code: (v) => String(v ?? '92').replace(/\D/g, '').slice(0, 4) || '92',
  whatsapp_cloud_phone_id: (v) => String(v ?? '').replace(/\D/g, '').slice(0, 30),
  backup_on_day_close: (v) => !!v
}

/** Which permission is needed to change a setting (default: settings.manage). */
const SETTING_PERMS: Record<string, string> = {
  multi_firm_enabled: 'firms.manage',
  max_firms: 'firms.manage',
  share_inventory: 'firms.manage',
  share_parties: 'firms.manage',
  backup_auto: 'backup.manage',
  backup_dir: 'backup.manage',
  backup_keep: 'backup.manage',
  backup_on_day_close: 'backup.manage',
  print_direct: 'printers.manage',
  printer_default: 'printers.manage',
  printer_invoice: 'printers.manage',
  printer_quotation: 'printers.manage',
  printer_report: 'printers.manage',
  printer_receipt: 'printers.manage',
  paper_size: 'printers.manage'
}

export function getAllSettings(db: DB): Record<string, unknown> {
  const out: Record<string, unknown> = { ...DEFAULT_SETTINGS }
  const rows = db.prepare('SELECT key, value FROM settings').all() as Array<{ key: string; value: string }>
  for (const r of rows) {
    try {
      out[r.key] = JSON.parse(r.value)
    } catch {
      /* ignore malformed */
    }
  }
  return out
}

export function updateSettings(ctx: Ctx, patch: Record<string, unknown>): Record<string, unknown> {
  const keys = Object.keys(patch ?? {})
  for (const k of keys) {
    if (!(k in VALIDATORS)) throw new AppError(`Unknown setting: ${k}`, 'VALIDATION')
    requirePerm(ctx, SETTING_PERMS[k] ?? 'settings.manage')
  }
  const before: Record<string, unknown> = {}
  ctx.db.transaction(() => {
    for (const k of keys) {
      before[k] = getSetting(ctx.db, k, null)
      setSetting(ctx.db, k, VALIDATORS[k](patch[k]))
    }
  })()
  const firmCount = (ctx.db.prepare('SELECT COUNT(*) AS c FROM firms').get() as { c: number }).c
  if (getSetting(ctx.db, 'max_firms', 5) < firmCount) {
    setSetting(ctx.db, 'max_firms', firmCount)
  }
  audit(ctx, 'update', 'settings', null, `Changed settings: ${keys.join(', ')}`, { before, after: patch })
  return getAllSettings(ctx.db)
}

export function listTaxRates(ctx: Ctx): unknown[] {
  return ctx.db.prepare('SELECT * FROM tax_rates ORDER BY is_default DESC, rate').all()
}

export function saveTaxRate(ctx: Ctx, input: { id?: number; name: string; rate: number; isDefault?: boolean; isActive?: boolean }): number {
  requirePerm(ctx, 'settings.manage')
  const name = requireText(input.name, 'Tax name', 60)
  const rate = round2(num(input.rate))
  if (rate < 0 || rate > 100) throw new AppError('Tax rate must be between 0 and 100.', 'VALIDATION')
  return ctx.db.transaction(() => {
    let id = input.id ?? 0
    if (id) ctx.db.prepare('UPDATE tax_rates SET name = ?, rate = ?, is_active = ? WHERE id = ?').run(name, rate, input.isActive === false ? 0 : 1, id)
    else id = Number(ctx.db.prepare('INSERT INTO tax_rates (name, rate) VALUES (?, ?)').run(name, rate).lastInsertRowid)
    if (input.isDefault) ctx.db.prepare('UPDATE tax_rates SET is_default = CASE WHEN id = ? THEN 1 ELSE 0 END').run(id)
    audit(ctx, input.id ? 'update' : 'create', 'tax_rate', id, `Tax rate ${name} ${rate}%`)
    return id
  })()
}

export function deleteTaxRate(ctx: Ctx, id: number): void {
  requirePerm(ctx, 'settings.manage')
  const r = ctx.db.prepare('SELECT is_default FROM tax_rates WHERE id = ?').get(id) as { is_default: number } | undefined
  if (!r) throw new AppError('Tax rate not found.', 'NOT_FOUND')
  if (r.is_default) throw new AppError('The default tax rate cannot be deleted.', 'VALIDATION')
  ctx.db.prepare('DELETE FROM tax_rates WHERE id = ?').run(id)
  audit(ctx, 'delete', 'tax_rate', id, 'Deleted tax rate')
}

export function cleanBackupDir(v: unknown): string {
  return optText(v, 500) ?? ''
}
