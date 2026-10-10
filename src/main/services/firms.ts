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

export function createFirm(ctx: Ctx, input: FirmInput, licenseMaxFirms: number): number {
  requirePerm(ctx, 'firms.manage')
  const db = ctx.db
  const multi = getSetting(db, 'multi_firm_enabled', true)
  const count = (db.prepare('SELECT COUNT(*) AS c FROM firms').get() as { c: number }).c
  if (!multi && count >= 1) throw new AppError('Enable Multiple Firms in Multi-Firm settings first.', 'VALIDATION')
  const max = maxFirmsAllowed(db, licenseMaxFirms)
  if (count >= max) throw new AppError(`You can create maximum ${max} firms with the current settings/license.`, 'LIMIT')
  return db.transaction(() => {
    const id = insertFirm(db, input, count === 0)
    audit(ctx, 'create', 'firm', id, `Created firm ${input.name}`)
    return id
  })()
}

export function updateFirm(ctx: Ctx, input: FirmInput): void {
  requirePerm(ctx, 'firms.manage')
  const db = ctx.db
  if (!input.id) throw new AppError('Firm id missing.', 'VALIDATION')
  const existing = getFirm(db, input.id)
  const name = requireText(input.name, 'Firm name', 150)
  const ps = { ...(existing.print_settings as object), ...(input.printSettings ?? {}) }
  db.prepare(
    `UPDATE firms SET name=@name, tagline=@tagline, address=@address, city=@city, phone=@phone, phone2=@phone2, email=@email,
       website=@website, ntn=@ntn, strn=@strn, logo=@logo, signature=@signature, stamp=@stamp, bank_details=@bank_details,
       terms=@terms, invoice_footer=@invoice_footer, print_settings=@print_settings, is_active=@is_active,
       updated_at=datetime('now','localtime')
     WHERE id=@id`
  ).run({
    id: input.id,
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
    print_settings: JSON.stringify(ps),
    is_active: existing.is_default ? 1 : input.isActive === false ? 0 : 1
  })
  audit(ctx, 'update', 'firm', input.id, `Updated firm ${name}`)
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
