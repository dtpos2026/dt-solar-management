import type { DB } from '../db'
import { DEFAULT_PREFIXES, SEQUENCE_LABELS, SequenceType } from '../../shared/docTypes'
import { AppError, Ctx, audit, canAccessFirm, getSetting, optText, requirePerm, requireText, SessionUser } from './context'

export interface FirmInput {
  id?: number
  name: string
  tagline?: string
  address?: string
  city?: string
  phone?: string
  phone2?: string
  email?: string
  website?: string
  ntn?: string
  strn?: string
  logo?: string | null
  signature?: string | null
  stamp?: string | null
  bankDetails?: string
  terms?: string
  invoiceFooter?: string
  printSettings?: Record<string, unknown>
  isActive?: boolean
}

export const DEFAULT_PRINT_SETTINGS = {
  accentColor: '#0b5cad',
  template: 'modern',
  showLogo: true,
  showSignature: true,
  showStamp: true,
  showWarranty: true,
  showSerials: true,
  showAmountInWords: true,
  showBankDetails: true,
  showPreviousBalance: true,
  showTaxColumns: 'auto',
  signatureLabel: 'Authorized Signature',
  receiverLabel: "Customer's Signature",
  paperSize: 'A4'
}

const MAX_IMAGE_CHARS = 3_000_000

function cleanImage(v: unknown): string | null {
  if (v === null || v === undefined || v === '') return null
  const s = String(v)
  if (!/^data:image\/(png|jpe?g|webp|gif|svg\+xml);base64,/.test(s)) {
    throw new AppError('Images must be PNG, JPG, WEBP or SVG.', 'VALIDATION')
  }
  if (s.length > MAX_IMAGE_CHARS) throw new AppError('Image is too large. Please use an image under 2 MB.', 'VALIDATION')
  return s
}

export function maxFirmsAllowed(db: DB, licenseMaxFirms: number): number {
  const configured = Number(getSetting(db, 'max_firms', 5)) || 1
  return Math.max(1, Math.min(configured, licenseMaxFirms > 0 ? licenseMaxFirms : configured))
}

export function listFirms(db: DB, user?: SessionUser): unknown[] {
  const rows = db
    .prepare(
      `SELECT id, name, tagline, address, city, phone, phone2, email, website, ntn, strn, is_default, is_active, created_at,
              CASE WHEN logo IS NULL THEN 0 ELSE 1 END AS has_logo
       FROM firms ORDER BY is_default DESC, id`
    )
    .all() as Array<{ id: number }>
  return user ? rows.filter((f) => canAccessFirm(user, f.id)) : rows
}

export function getFirm(db: DB, id: number): Record<string, unknown> {
  const f = db.prepare('SELECT * FROM firms WHERE id = ?').get(id) as Record<string, unknown> | undefined
  if (!f) throw new AppError('Firm not found.', 'NOT_FOUND')
  let ps: Record<string, unknown> = {}
  try {
    ps = JSON.parse(String(f.print_settings || '{}'))
  } catch {
    ps = {}
  }
  return { ...f, print_settings: { ...DEFAULT_PRINT_SETTINGS, ...ps } }
}

/** Creates a firm with its sequences, default cash account and (if needed) warehouse. Used by setup & UI. */
export function insertFirm(db: DB, input: FirmInput, makeDefault: boolean): number {
  const name = requireText(input.name, 'Firm name', 150)
  const id = Number(
    db
      .prepare(
        `INSERT INTO firms (name, tagline, address, city, phone, phone2, email, website, ntn, strn, logo, signature, stamp,
           bank_details, terms, invoice_footer, print_settings, is_default, is_active)
         VALUES (@name, @tagline, @address, @city, @phone, @phone2, @email, @website, @ntn, @strn, @logo, @signature, @stamp,
           @bank_details, @terms, @invoice_footer, @print_settings, @is_default, 1)`
      )
      .run({
        name,
        tagline: optText(input.tagline, 600),
        address: optText(input.address, 500),
        city: optText(input.city, 80),
        phone: optText(input.phone, 60),
        phone2: optText(input.phone2, 60),
        email: optText(input.email, 120),
        website: optText(input.website, 120),
        ntn: optText(input.ntn, 40),
        strn: optText(input.strn, 40),
        logo: cleanImage(input.logo),
        signature: cleanImage(input.signature),
        stamp: cleanImage(input.stamp),
        bank_details: optText(input.bankDetails, 1000),
        terms: optText(input.terms, 3000),
        invoice_footer: optText(input.invoiceFooter, 500),
        print_settings: JSON.stringify({ ...DEFAULT_PRINT_SETTINGS, ...(input.printSettings ?? {}) }),
        is_default: makeDefault ? 1 : 0
      }).lastInsertRowid
  )
  if (makeDefault) db.prepare('UPDATE firms SET is_default = 0 WHERE id <> ?').run(id)
  ensureSequences(db, id)
  db.prepare("INSERT INTO accounts (firm_id, name, type, is_default) VALUES (?, 'Cash in Hand', 'cash', 1)").run(id)
  const shared = getSetting(db, 'share_inventory', true)
  const sharedWh = db.prepare('SELECT id FROM warehouses WHERE firm_id IS NULL AND is_active = 1').get()
  if (shared) {
    if (!sharedWh) db.prepare("INSERT INTO warehouses (firm_id, name, is_default) VALUES (NULL, 'Main Warehouse', 1)").run()
  } else {
    db.prepare("INSERT INTO warehouses (firm_id, name, is_default) VALUES (?, 'Main Store', 1)").run(id)
  }
  return id
}

export function ensureSequences(db: DB, firmId: number): void {
  const ins = db.prepare('INSERT OR IGNORE INTO doc_sequences (firm_id, doc_type, prefix, next_no, padding) VALUES (?, ?, ?, 1, 5)')
  for (const [t, prefix] of Object.entries(DEFAULT_PREFIXES)) ins.run(firmId, t, prefix)
}

export function activeFirmCount(db: DB): number {
  return (db.prepare('SELECT COUNT(*) AS c FROM firms WHERE is_active = 1').get() as { c: number }).c
}

/** "x of y firms used": only ACTIVE firms count against the license / max_firms limit. */
export function firmLimits(
  db: DB,
  licenseMaxFirms: number
): { licenseMax: number; allowed: number; count: number; active: number; inactive: number; total: number } {
  const total = (db.prepare('SELECT COUNT(*) AS c FROM firms').get() as { c: number }).c
  const active = activeFirmCount(db)
  return { licenseMax: licenseMaxFirms, allowed: maxFirmsAllowed(db, licenseMaxFirms), count: active, active, inactive: total - active, total }
}

function assertFirmSlot(db: DB, licenseMaxFirms: number, action: string): void {
  const active = activeFirmCount(db)
  const multi = getSetting(db, 'multi_firm_enabled', true)
  if (!multi && active >= 1) throw new AppError(`Enable Multiple Firms in Multi-Firm settings before you ${action}.`, 'VALIDATION')
  const max = maxFirmsAllowed(db, licenseMaxFirms)
  if (active >= max) {
    const byLicense = licenseMaxFirms > 0 && max >= licenseMaxFirms
    throw new AppError(
      `You are using ${active} of ${max} active firm${max === 1 ? '' : 's'} (maximum ${max} allowed by ${byLicense ? 'your license' : 'the Maximum firms setting'}). ${
        byLicense ? 'Upgrade the license or deactivate another firm' : 'Increase "Maximum firms" or deactivate another firm'
      } to ${action}.`,
      'LIMIT'
    )
  }
}

export function createFirm(ctx: Ctx, input: FirmInput, licenseMaxFirms: number): number {
  requirePerm(ctx, 'firms.manage')
  const db = ctx.db
  return db.transaction(() => {
    assertFirmSlot(db, licenseMaxFirms, 'add a firm')
    const total = (db.prepare('SELECT COUNT(*) AS c FROM firms').get() as { c: number }).c
    const id = insertFirm(db, input, total === 0)
    audit(ctx, 'create', 'firm', id, `Created firm ${input.name}`)
    return id
  })()
}

export function updateFirm(ctx: Ctx, input: FirmInput, licenseMaxFirms?: number): void {
  requirePerm(ctx, 'firms.manage')
  const db = ctx.db
  if (!input.id) throw new AppError('Firm id missing.', 'VALIDATION')
  const firmId = input.id
  const existing = getFirm(db, firmId)
  const name = requireText(input.name, 'Firm name', 150)
  const ps = { ...(existing.print_settings as object), ...(input.printSettings ?? {}) }
  db.transaction(() => {
    db.prepare(
      `UPDATE firms SET name=@name, tagline=@tagline, address=@address, city=@city, phone=@phone, phone2=@phone2, email=@email,
         website=@website, ntn=@ntn, strn=@strn, logo=@logo, signature=@signature, stamp=@stamp, bank_details=@bank_details,
         terms=@terms, invoice_footer=@invoice_footer, print_settings=@print_settings,
         updated_at=datetime('now','localtime')
       WHERE id=@id`
    ).run({
      id: firmId,
      name,
      tagline: optText(input.tagline, 600),
      address: optText(input.address, 500),
      city: optText(input.city, 80),
      phone: optText(input.phone, 60),
      phone2: optText(input.phone2, 60),
      email: optText(input.email, 120),
      website: optText(input.website, 120),
      ntn: optText(input.ntn, 40),
      strn: optText(input.strn, 40),
      logo: input.logo === undefined ? existing.logo : cleanImage(input.logo),
      signature: input.signature === undefined ? existing.signature : cleanImage(input.signature),
      stamp: input.stamp === undefined ? existing.stamp : cleanImage(input.stamp),
      bank_details: optText(input.bankDetails, 1000),
      terms: optText(input.terms, 3000),
      invoice_footer: optText(input.invoiceFooter, 500),
      print_settings: JSON.stringify(ps)
    })
    audit(ctx, 'update', 'firm', firmId, `Updated firm ${name}`)
    // Activation follows the same rules as the Activate / Deactivate action (limit, default firm, current firm).
    if (typeof input.isActive === 'boolean' && input.isActive !== !!existing.is_active) {
      if (typeof licenseMaxFirms !== 'number') throw new AppError('Use Activate / Deactivate in the firm list to change whether a firm is active.', 'VALIDATION')
      setFirmActive(ctx, firmId, input.isActive, licenseMaxFirms)
    }
  })()
}

/* ------------------------------ Activate / deactivate ------------------------------ */

interface UserFirmRow {
  id: number
  username: string
  full_name: string
  is_owner: number
  all_firms: number
  last_firm_id: number | null
}

export interface DeactivationImpact {
  firm: { id: number; name: string; is_default: number; is_active: number }
  canDeactivate: boolean
  blockedReason: string | null
  defaultFirm: { id: number; name: string } | null
  lastFirmUsers: Array<{ id: number; username: string; full_name: string }>
  strandedUsers: Array<{ id: number; username: string; full_name: string }>
}

/** Users affected by deactivating a firm: those who last worked in it, and restricted users left with no active firm. */
export function firmDeactivationImpact(ctx: Ctx, id: number): DeactivationImpact {
  requirePerm(ctx, 'firms.manage')
  const db = ctx.db
  const f = getFirm(db, id) as unknown as { id: number; name: string; is_default: number; is_active: number }
  const def = db.prepare('SELECT id, name FROM firms WHERE is_default = 1 AND is_active = 1 AND id <> ?').get(id) as
    | { id: number; name: string }
    | undefined
  let blockedReason: string | null = null
  if (f.is_default) blockedReason = 'The default firm cannot be deactivated. Make another firm the default first.'
  else if (id === ctx.firmId) blockedReason = 'You are working in this firm right now. Switch to another firm from the top bar, then deactivate it.'
  else if (!f.is_active) blockedReason = 'This firm is already inactive.'
  const users = db.prepare('SELECT id, username, full_name, is_owner, all_firms, last_firm_id FROM users WHERE is_active = 1').all() as UserFirmRow[]
  const brief = (u: UserFirmRow): { id: number; username: string; full_name: string } => ({ id: u.id, username: u.username, full_name: u.full_name })
  const lastFirmUsers = users.filter((u) => u.last_firm_id === id).map(brief)
  const otherActive = db.prepare(
    'SELECT COUNT(*) AS c FROM user_firms uf JOIN firms f ON f.id = uf.firm_id WHERE uf.user_id = ? AND f.is_active = 1 AND f.id <> ?'
  )
  const hasThis = db.prepare('SELECT 1 FROM user_firms WHERE user_id = ? AND firm_id = ?')
  const strandedUsers = users
    .filter((u) => !u.is_owner && !u.all_firms && !!hasThis.get(u.id, id) && (otherActive.get(u.id, id) as { c: number }).c === 0)
    .map(brief)
  return {
    firm: { id: f.id, name: f.name, is_default: f.is_default, is_active: f.is_active },
    canDeactivate: !blockedReason,
    blockedReason,
    defaultFirm: def ?? null,
    lastFirmUsers,
    strandedUsers
  }
}

/**
 * Activate or deactivate a firm. Rules:
 *  - the default firm and the firm the current user is working in cannot be deactivated;
 *  - users whose last firm is deactivated fall back to the default firm (restricted users who would be left
 *    without any active firm are given access to the default firm, unless grantDefaultAccess is false);
 *  - reactivating counts against the license / max_firms limit exactly like creating a firm.
 * Nothing is deleted: the firm's documents, payments and history stay as they are.
 */
export function setFirmActive(
  ctx: Ctx,
  id: number,
  active: boolean,
  licenseMaxFirms: number,
  opts: { grantDefaultAccess?: boolean } = {}
): { active: boolean; movedUsers: number; grantedUsers: number } {
  requirePerm(ctx, 'firms.manage')
  const db = ctx.db
  return db.transaction(() => {
    const f = getFirm(db, id) as unknown as { id: number; name: string; is_default: number; is_active: number }
    if (active) {
      if (f.is_active) return { active: true, movedUsers: 0, grantedUsers: 0 }
      assertFirmSlot(db, licenseMaxFirms, 'reactivate this firm')
      db.prepare("UPDATE firms SET is_active = 1, updated_at = datetime('now','localtime') WHERE id = ?").run(id)
      audit(ctx, 'activate', 'firm', id, `Reactivated firm ${f.name}`)
      return { active: true, movedUsers: 0, grantedUsers: 0 }
    }
    if (!f.is_active) return { active: false, movedUsers: 0, grantedUsers: 0 }
    const impact = firmDeactivationImpact(ctx, id)
    if (!impact.canDeactivate) throw new AppError(impact.blockedReason ?? 'This firm cannot be deactivated.', 'VALIDATION')
    const def = impact.defaultFirm
    if (!def) throw new AppError('There is no active default firm to fall back to.', 'VALIDATION')
    db.prepare("UPDATE firms SET is_active = 0, updated_at = datetime('now','localtime') WHERE id = ?").run(id)
    const movedUsers = db.prepare('UPDATE users SET last_firm_id = ? WHERE last_firm_id = ?').run(def.id, id).changes
    let grantedUsers = 0
    const grant = opts.grantDefaultAccess !== false
    if (grant) {
      const ins = db.prepare('INSERT OR IGNORE INTO user_firms (user_id, firm_id) VALUES (?, ?)')
      for (const u of impact.strandedUsers) grantedUsers += ins.run(u.id, def.id).changes
    }
    audit(ctx, 'deactivate', 'firm', id, `Deactivated firm ${f.name}`, {
      fallbackFirm: def,
      movedUsers: impact.lastFirmUsers,
      grantedDefaultAccess: grant ? impact.strandedUsers : [],
      leftWithoutActiveFirm: grant ? [] : impact.strandedUsers
    })
    return { active: false, movedUsers, grantedUsers }
  })()
}

/** Business records a firm owns; a firm that has any of them can only be deactivated. */
const FIRM_RECORD_TABLES: Array<[table: string, label: string]> = [
  ['documents', 'document'],
  ['payments', 'payment'],
  ['expenses', 'expense'],
  ['projects', 'project'],
  ['stock_movements', 'stock movement'],
  ['stock_adjustments', 'stock adjustment'],
  ['material_moves', 'material move'],
  ['account_transfers', 'account transfer'],
  ['party_adjustments', 'party adjustment'],
  ['day_closings', 'day / month closing'],
  ['products', 'product'],
  ['parties', 'customer / supplier'],
  ['leads', 'CRM lead'],
  ['pos_shifts', 'POS shift'],
  ['cheques', 'cheque'],
  ['service_tickets', 'service ticket'],
  ['employees', 'employee']
]

export function firmDeleteImpact(ctx: Ctx, id: number): { canDelete: boolean; blockedReason: string | null; records: Array<{ label: string; count: number }> } {
  requirePerm(ctx, 'firms.manage')
  const f = getFirm(ctx.db, id) as unknown as { name: string; is_default: number; is_active: number }
  const records = FIRM_RECORD_TABLES.map(([t, label]) => ({ label, count: (ctx.db.prepare(`SELECT COUNT(*) AS c FROM ${t} WHERE firm_id = ?`).get(id) as { c: number }).c })).filter((r) => r.count > 0)
  let blockedReason: string | null = null
  if (f.is_default) blockedReason = 'The default firm cannot be deleted. Make another firm the default first.'
  else if (id === ctx.firmId) blockedReason = 'You are working in this firm right now. Switch to another firm first.'
  else if (f.is_active) blockedReason = 'Deactivate the firm first, then delete it.'
  else if (records.length) {
    blockedReason = `${f.name} has ${records.map((r) => `${r.count} ${r.label}${r.count > 1 ? 's' : ''}`).join(', ')}. A firm with records is kept (inactive) so the history stays complete.`
  }
  return { canDelete: !blockedReason, blockedReason, records }
}

/** Permanently removes an inactive, empty firm together with its own accounts, sequences and user links. */
export function deleteFirm(ctx: Ctx, id: number): void {
  requirePerm(ctx, 'firms.manage')
  const db = ctx.db
  const impact = firmDeleteImpact(ctx, id)
  if (!impact.canDelete) throw new AppError(impact.blockedReason ?? 'This firm cannot be deleted.', 'VALIDATION')
  const f = getFirm(db, id) as unknown as { name: string }
  db.transaction(() => {
    db.prepare('DELETE FROM doc_sequences WHERE firm_id = ?').run(id)
    db.prepare('DELETE FROM user_firms WHERE firm_id = ?').run(id)
    db.prepare('DELETE FROM accounts WHERE firm_id = ?').run(id)
    db.prepare('DELETE FROM stock_levels WHERE warehouse_id IN (SELECT id FROM warehouses WHERE firm_id = ?)').run(id)
    for (const t of ['warehouses', 'categories', 'doc_templates', 'whatsapp_log', 'import_runs']) db.prepare(`DELETE FROM ${t} WHERE firm_id = ?`).run(id)
    db.prepare('UPDATE users SET last_firm_id = NULL WHERE last_firm_id = ?').run(id)
    db.prepare('DELETE FROM firms WHERE id = ?').run(id)
    audit(ctx, 'delete', 'firm', id, `Deleted firm ${f.name}`)
  })()
}

/* ------------------------------ Shared records → firms ------------------------------ */

export interface SharedAssignmentPlan {
  shareInventory: boolean
  shareParties: boolean
  defaultFirm: { id: number; name: string }
  products: { toFirm: Array<{ firmId: number; firmName: string; count: number }>; unused: number; staysShared: Array<{ id: number; name: string; firms: string[] }> }
  parties: { toFirm: Array<{ firmId: number; firmName: string; count: number }>; unused: number; staysShared: Array<{ id: number; name: string; firms: string[] }> }
  assignments: { products: Array<{ id: number; firmId: number }>; parties: Array<{ id: number; firmId: number }> }
}

const PRODUCT_FIRMS_SQL = `
  SELECT m.product_id AS id, m.firm_id FROM stock_movements m
  UNION SELECT l.product_id, d.firm_id FROM document_lines l JOIN documents d ON d.id = l.document_id WHERE l.product_id IS NOT NULL
  UNION SELECT l.product_id, a.firm_id FROM stock_adjustment_lines l JOIN stock_adjustments a ON a.id = l.adjustment_id
  UNION SELECT l.product_id, mm.firm_id FROM material_move_lines l JOIN material_moves mm ON mm.id = l.move_id`

const PARTY_FIRMS_SQL = `
  SELECT party_id AS id, firm_id FROM documents WHERE party_id IS NOT NULL
  UNION SELECT party_id, firm_id FROM payments WHERE party_id IS NOT NULL
  UNION SELECT party_id, firm_id FROM expenses WHERE party_id IS NOT NULL
  UNION SELECT party_id, firm_id FROM party_adjustments
  UNION SELECT customer_id, firm_id FROM projects WHERE customer_id IS NOT NULL
  UNION SELECT id, opening_firm_id FROM parties WHERE opening_balance <> 0 AND opening_firm_id IS NOT NULL`

/**
 * Plan for "Assign shared records to firms" (only for the kinds whose sharing is turned OFF):
 * shared products / parties used by exactly one firm go to that firm, unused ones go to the default firm,
 * and those used by several firms stay shared (listed). Transactions are never moved between firms.
 */
export function planSharedAssignment(ctx: Ctx): SharedAssignmentPlan {
  requirePerm(ctx, 'firms.manage')
  const db = ctx.db
  const shareInventory = getSetting(db, 'share_inventory', true)
  const shareParties = getSetting(db, 'share_parties', true)
  const def = db.prepare('SELECT id, name FROM firms WHERE is_default = 1').get() as { id: number; name: string } | undefined
  if (!def) throw new AppError('No default firm is set.', 'VALIDATION')
  const firmNames = new Map((db.prepare('SELECT id, name FROM firms').all() as Array<{ id: number; name: string }>).map((f) => [f.id, f.name]))
  const build = (
    table: 'products' | 'parties',
    usageSql: string,
    enabled: boolean
  ): { summary: SharedAssignmentPlan['products']; list: Array<{ id: number; firmId: number }> } => {
    const summary: SharedAssignmentPlan['products'] = { toFirm: [], unused: 0, staysShared: [] }
    const list: Array<{ id: number; firmId: number }> = []
    if (!enabled) return { summary, list }
    const rows = db.prepare(`SELECT id, name FROM ${table} WHERE firm_id IS NULL ORDER BY name`).all() as Array<{ id: number; name: string }>
    const usage = db.prepare(`SELECT DISTINCT u.firm_id FROM (${usageSql}) u WHERE u.id = ? AND u.firm_id IS NOT NULL ORDER BY u.firm_id`)
    const counts = new Map<number, number>()
    for (const r of rows) {
      const firms = (usage.all(r.id) as Array<{ firm_id: number }>).map((x) => x.firm_id)
      if (firms.length === 0) {
        list.push({ id: r.id, firmId: def.id })
        summary.unused++
        counts.set(def.id, (counts.get(def.id) ?? 0) + 1)
      } else if (firms.length === 1) {
        list.push({ id: r.id, firmId: firms[0] })
        counts.set(firms[0], (counts.get(firms[0]) ?? 0) + 1)
      } else {
        summary.staysShared.push({ id: r.id, name: r.name, firms: firms.map((f) => firmNames.get(f) ?? `Firm #${f}`) })
      }
    }
    summary.toFirm = Array.from(counts.entries()).map(([firmId, count]) => ({ firmId, firmName: firmNames.get(firmId) ?? `Firm #${firmId}`, count }))
    return { summary, list }
  }
  const prod = build('products', PRODUCT_FIRMS_SQL, !shareInventory)
  const part = build('parties', PARTY_FIRMS_SQL, !shareParties)
  return {
    shareInventory,
    shareParties,
    defaultFirm: def,
    products: prod.summary,
    parties: part.summary,
    assignments: { products: prod.list, parties: part.list }
  }
}

/** Apply the plan in one transaction with one audit entry. Only the owning firm of master records changes. */
export function assignSharedRecords(ctx: Ctx): { products: number; parties: number; productsShared: number; partiesShared: number } {
  requirePerm(ctx, 'firms.manage')
  const db = ctx.db
  return db.transaction(() => {
    const plan = planSharedAssignment(ctx)
    if (plan.shareInventory && plan.shareParties) {
      throw new AppError('Turn off sharing of inventory and/or customers & suppliers first. While sharing is on, shared records stay shared.', 'VALIDATION')
    }
    const upProduct = db.prepare("UPDATE products SET firm_id = ?, updated_at = datetime('now','localtime') WHERE id = ? AND firm_id IS NULL")
    const upParty = db.prepare("UPDATE parties SET firm_id = ?, updated_at = datetime('now','localtime') WHERE id = ? AND firm_id IS NULL")
    let products = 0
    let parties = 0
    for (const a of plan.assignments.products) products += upProduct.run(a.firmId, a.id).changes
    for (const a of plan.assignments.parties) parties += upParty.run(a.firmId, a.id).changes
    audit(ctx, 'assign_shared', 'firm', null, `Assigned shared records to firms: ${products} product(s), ${parties} customer(s)/supplier(s)`, {
      products: plan.products,
      parties: plan.parties,
      productAssignments: plan.assignments.products,
      partyAssignments: plan.assignments.parties
    })
    return { products, parties, productsShared: plan.products.staysShared.length, partiesShared: plan.parties.staysShared.length }
  })()
}

export function setDefaultFirm(ctx: Ctx, id: number): void {
  requirePerm(ctx, 'firms.manage')
  const f = getFirm(ctx.db, id)
  if (!f.is_active) throw new AppError('Activate the firm before making it default.', 'VALIDATION')
  ctx.db.transaction(() => {
    ctx.db.prepare('UPDATE firms SET is_default = CASE WHEN id = ? THEN 1 ELSE 0 END').run(id)
  })()
  audit(ctx, 'update', 'firm', id, `Set ${String(f.name)} as default firm`)
}

/* ---------------------------- Sequences ---------------------------- */

export function nextNumber(db: DB, firmId: number, type: SequenceType): string {
  let seq = db.prepare('SELECT * FROM doc_sequences WHERE firm_id = ? AND doc_type = ?').get(firmId, type) as
    | { prefix: string; next_no: number; padding: number }
    | undefined
  if (!seq) {
    ensureSequences(db, firmId)
    seq = db.prepare('SELECT * FROM doc_sequences WHERE firm_id = ? AND doc_type = ?').get(firmId, type) as {
      prefix: string
      next_no: number
      padding: number
    }
  }
  let n = seq.next_no
  let number = ''
  // Skip any number that already exists (e.g. after a prefix change) so numbers are never duplicated.
  for (let guard = 0; guard < 100000; guard++) {
    number = `${seq.prefix}${String(n).padStart(seq.padding, '0')}`
    if (!numberExists(db, firmId, type, number)) break
    n++
  }
  db.prepare('UPDATE doc_sequences SET next_no = ? WHERE firm_id = ? AND doc_type = ?').run(n + 1, firmId, type)
  return number
}

function numberExists(db: DB, firmId: number, type: SequenceType, number: string): boolean {
  const q = (sql: string, ...args: unknown[]): boolean => !!db.prepare(sql).get(...args)
  switch (type) {
    case 'receipt':
      return q("SELECT 1 FROM payments WHERE firm_id = ? AND direction = 'in' AND number = ?", firmId, number)
    case 'payment':
      return q("SELECT 1 FROM payments WHERE firm_id = ? AND direction = 'out' AND number = ?", firmId, number)
    case 'expense':
      return q('SELECT 1 FROM expenses WHERE firm_id = ? AND number = ?', firmId, number)
    case 'transfer':
      return q('SELECT 1 FROM account_transfers WHERE firm_id = ? AND number = ?', firmId, number)
    case 'adjustment':
      return q('SELECT 1 FROM stock_adjustments WHERE firm_id = ? AND number = ?', firmId, number)
    case 'project':
      return q('SELECT 1 FROM projects WHERE firm_id = ? AND code = ?', firmId, number)
    case 'material_issue':
      return q("SELECT 1 FROM material_moves WHERE firm_id = ? AND direction = 'issue' AND number = ?", firmId, number)
    case 'material_return':
      return q("SELECT 1 FROM material_moves WHERE firm_id = ? AND direction = 'return' AND number = ?", firmId, number)
    case 'party_adjustment':
      return q('SELECT 1 FROM party_adjustments WHERE firm_id = ? AND number = ?', firmId, number)
    case 'service_ticket':
      return q('SELECT 1 FROM service_tickets WHERE firm_id = ? AND number = ?', firmId, number)
    case 'employee':
      return q('SELECT 1 FROM employees WHERE firm_id = ? AND code = ?', firmId, number)
    default:
      return q('SELECT 1 FROM documents WHERE firm_id = ? AND doc_type = ? AND number = ?', firmId, type, number)
  }
}

export function listSequences(ctx: Ctx, firmId: number): unknown[] {
  ensureSequences(ctx.db, firmId)
  const rows = ctx.db.prepare('SELECT * FROM doc_sequences WHERE firm_id = ? ORDER BY doc_type').all(firmId) as Array<{
    doc_type: SequenceType
  }>
  return rows
    .filter((r) => r.doc_type in SEQUENCE_LABELS)
    .map((r) => ({ ...r, label: SEQUENCE_LABELS[r.doc_type] }))
}

export function updateSequence(
  ctx: Ctx,
  firmId: number,
  input: { docType: SequenceType; prefix: string; nextNo: number; padding: number }
): void {
  requirePerm(ctx, 'firms.manage')
  if (!(input.docType in SEQUENCE_LABELS)) throw new AppError('Unknown document type.', 'VALIDATION')
  const prefix = String(input.prefix ?? '').trim().slice(0, 20)
  if (!/^[A-Za-z0-9/_\-.#]*$/.test(prefix)) throw new AppError('Prefix may contain letters, numbers and - / _ . #', 'VALIDATION')
  const nextNo = Math.max(1, Math.floor(Number(input.nextNo) || 1))
  const padding = Math.min(10, Math.max(1, Math.floor(Number(input.padding) || 5)))
  ensureSequences(ctx.db, firmId)
  ctx.db
    .prepare('UPDATE doc_sequences SET prefix = ?, next_no = ?, padding = ? WHERE firm_id = ? AND doc_type = ?')
    .run(prefix, nextNo, padding, firmId, input.docType)
  audit(ctx, 'update', 'sequence', firmId, `Numbering for ${SEQUENCE_LABELS[input.docType]} set to ${prefix}${nextNo}`)
}
