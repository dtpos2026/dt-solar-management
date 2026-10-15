/**
 * Print templates for customer documents (invoices, quotations, orders, challans, returns, purchase documents and
 * payment receipts). A template only changes how a document is printed — never the document data.
 *
 *  - Rows live in doc_templates (firm_id = the firm that created it; NULL rows are shared by every firm).
 *  - layout: classic | modern | compact | thermal80 (80 mm receipt — sale invoices and payment receipts only).
 *  - options: JSON of show/hide switches + accent colour, title override and footer note (see TEMPLATE_OPTION_KEYS).
 *  - The default template per document kind is stored per firm in the settings key `doc_template_defaults`
 *    ({ "<firmId>": { "<kind>": <templateId> | "builtin:<layout>" } }). No entry = built-in Classic.
 */
import { DOC_TYPES } from '../../shared/docTypes'
import { AppError, Ctx, audit, getSetting, optId, requirePerm, requireText, setSetting } from './context'

export const TEMPLATE_KINDS = [
  'sale_invoice',
  'quotation',
  'sale_order',
  'delivery_challan',
  'sale_return',
  'purchase_invoice',
  'purchase_order',
  'purchase_return',
  'payment'
] as const
export type TemplateKind = (typeof TEMPLATE_KINDS)[number]

export const TEMPLATE_LAYOUTS = ['classic', 'modern', 'compact', 'thermal80'] as const
export type TemplateLayout = (typeof TEMPLATE_LAYOUTS)[number]

/** Kinds that may be printed on an 80 mm thermal receipt printer. */
export const THERMAL_KINDS: TemplateKind[] = ['sale_invoice', 'payment']

export const TEMPLATE_OPTION_KEYS = [
  'showLogo',
  'showDescription',
  'showBrandModel',
  'showUnit',
  'showDiscount',
  'showTax',
  'showSerials',
  'showWarranty',
  'showTerms',
  'showBankDetails',
  'showAmountInWords',
  'showCustomerSignature',
  'showAuthorisedSignature',
  'showStamp',
  'showNotes',
  'showPreviousBalance'
] as const

export interface TemplateOptions {
  [k: string]: boolean | string
  accentColor: string
  titleOverride: string
  footerNote: string
}

export interface TemplateRow {
  id: number
  firm_id: number | null
  name: string
  applies_to: 'all' | TemplateKind
  layout: TemplateLayout
  options: TemplateOptions
  is_default: number
  created_by: number | null
  created_at: string
  updated_at: string | null
  /** Kinds this template is currently the default for (in the active firm). */
  default_for: TemplateKind[]
}

export interface TemplateInput {
  id?: number
  name: string
  appliesTo?: string
  layout?: string
  options?: Record<string, unknown>
}

const DEFAULTS_KEY = 'doc_template_defaults'
const HEX = /^#[0-9a-f]{6}$/i

export function kindLabel(kind: string): string {
  if (kind === 'all') return 'All documents'
  if (kind === 'payment') return 'Payment receipts / vouchers'
  return DOC_TYPES[kind as keyof typeof DOC_TYPES]?.label ?? kind
}

function isKind(k: unknown): k is TemplateKind {
  return typeof k === 'string' && (TEMPLATE_KINDS as readonly string[]).includes(k)
}

function isLayout(l: unknown): l is TemplateLayout {
  return typeof l === 'string' && (TEMPLATE_LAYOUTS as readonly string[]).includes(l)
}

/** Every switch on (the document data decides what exists), default accent, no overrides. */
export function defaultTemplateOptions(): TemplateOptions {
  const o: TemplateOptions = { accentColor: '#0b5cad', titleOverride: '', footerNote: '' }
  for (const k of TEMPLATE_OPTION_KEYS) o[k] = true
  return o
}

/** Keeps only known keys with valid values. */
export function sanitizeOptions(raw: unknown): TemplateOptions {
  const src = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const o = defaultTemplateOptions()
  for (const k of TEMPLATE_OPTION_KEYS) if (k in src) o[k] = !!src[k]
  const accent = typeof src.accentColor === 'string' ? src.accentColor.trim() : ''
  if (accent) {
    if (!HEX.test(accent)) throw new AppError('Accent colour must be a colour like #0b5cad.', 'VALIDATION')
    o.accentColor = accent.toLowerCase()
  }
  o.titleOverride = String(src.titleOverride ?? '').trim().slice(0, 60)
  o.footerNote = String(src.footerNote ?? '').trim().slice(0, 300)
  return o
}

function parseOptions(json: string | null): TemplateOptions {
  try {
    return sanitizeOptions(JSON.parse(json || '{}'))
  } catch {
    return defaultTemplateOptions()
  }
}

type DefaultsMap = Record<string, Record<string, number | string>>

function allDefaults(ctx: Ctx): DefaultsMap {
  const m = getSetting<DefaultsMap>(ctx.db, DEFAULTS_KEY, {})
  return m && typeof m === 'object' ? m : {}
}

/** Default template per kind for the active firm: template id, 'builtin:<layout>', or absent (= built-in classic). */
export function getTemplateDefaults(ctx: Ctx): Partial<Record<TemplateKind, number | string>> {
  const m = allDefaults(ctx)[String(ctx.firmId)] ?? {}
  const out: Partial<Record<TemplateKind, number | string>> = {}
  for (const [k, v] of Object.entries(m)) if (isKind(k)) out[k] = v
  return out
}

function writeDefaults(ctx: Ctx, firmMap: Record<string, number | string>): void {
  const all = allDefaults(ctx)
  all[String(ctx.firmId)] = firmMap
  setSetting(ctx.db, DEFAULTS_KEY, all)
  // is_default mirrors "default for at least one kind in this firm" so the column stays meaningful for exports.
  const ids = Object.values(firmMap).filter((v): v is number => typeof v === 'number')
  ctx.db.prepare('UPDATE doc_templates SET is_default = 0 WHERE firm_id IS NULL OR firm_id = ?').run(ctx.firmId)
  if (ids.length) ctx.db.prepare(`UPDATE doc_templates SET is_default = 1 WHERE id IN (${ids.map(() => '?').join(',')})`).run(...ids)
}

function rowToTemplate(r: Record<string, unknown>, defaults: Partial<Record<TemplateKind, number | string>>): TemplateRow {
  const id = Number(r.id)
  return {
    ...(r as unknown as TemplateRow),
    options: parseOptions(r.options as string),
    default_for: TEMPLATE_KINDS.filter((k) => defaults[k] === id)
  }
}

/** Whether a template may be used for a document kind. */
export function templateFits(t: { applies_to: string; layout: string }, kind: TemplateKind): boolean {
  if (t.layout === 'thermal80' && !THERMAL_KINDS.includes(kind)) return false
  return t.applies_to === 'all' || t.applies_to === kind
}

/** Templates visible in the active firm (optionally only those usable for one kind). Any signed-in user may read them (needed to print). */
export function listTemplates(ctx: Ctx, f: { kind?: string } = {}): TemplateRow[] {
  const defaults = getTemplateDefaults(ctx)
  const rows = ctx.db
    .prepare('SELECT * FROM doc_templates WHERE firm_id IS NULL OR firm_id = ? ORDER BY name COLLATE NOCASE, id')
    .all(ctx.firmId) as Array<Record<string, unknown>>
  const list = rows.map((r) => rowToTemplate(r, defaults))
  if (f.kind === undefined || f.kind === null || f.kind === '') return list
  if (!isKind(f.kind)) throw new AppError('Unknown document kind.', 'VALIDATION')
  return list.filter((t) => templateFits(t, f.kind as TemplateKind))
}

export function getTemplate(ctx: Ctx, id: number): TemplateRow {
  const r = ctx.db.prepare('SELECT * FROM doc_templates WHERE id = ? AND (firm_id IS NULL OR firm_id = ?)').get(id, ctx.firmId) as
    | Record<string, unknown>
    | undefined
  if (!r) throw new AppError('Template not found.', 'NOT_FOUND')
  return rowToTemplate(r, getTemplateDefaults(ctx))
}

/** What the print preview needs for one document kind: usable templates + the default reference. */
export function templatesForKind(ctx: Ctx, kind: string): { kind: TemplateKind; templates: TemplateRow[]; defaultRef: number | string } {
  if (!isKind(kind)) throw new AppError('Unknown document kind.', 'VALIDATION')
  const templates = listTemplates(ctx, { kind })
  const def = getTemplateDefaults(ctx)[kind]
  let defaultRef: number | string = 'builtin:classic'
  if (typeof def === 'number' && templates.some((t) => t.id === def)) defaultRef = def
  else if (typeof def === 'string' && isBuiltinFor(def, kind)) defaultRef = def
  return { kind, templates, defaultRef }
}

function isBuiltinFor(ref: string, kind: TemplateKind): boolean {
  const m = /^builtin:(\w+)$/.exec(ref)
  if (!m || !isLayout(m[1])) return false
  return m[1] !== 'thermal80' || THERMAL_KINDS.includes(kind)
}

function validate(ctx: Ctx, input: TemplateInput): { name: string; appliesTo: 'all' | TemplateKind; layout: TemplateLayout; options: TemplateOptions } {
  const name = requireText(input?.name, 'Template name', 80)
  const appliesTo = (input.appliesTo ?? 'all') as string
  if (appliesTo !== 'all' && !isKind(appliesTo)) throw new AppError('Choose which documents the template is for.', 'VALIDATION')
  const layout = (input.layout ?? 'classic') as string
  if (!isLayout(layout)) throw new AppError('Unknown layout.', 'VALIDATION')
  if (layout === 'thermal80' && !THERMAL_KINDS.includes(appliesTo as TemplateKind)) {
    throw new AppError('The 80 mm thermal layout is only for sales invoices or payment receipts. Choose one of them under "Use for".', 'VALIDATION')
  }
  const options = sanitizeOptions(input.options)
  const dup = ctx.db
    .prepare('SELECT id FROM doc_templates WHERE name = ? COLLATE NOCASE AND (firm_id IS NULL OR firm_id = ?) AND id <> ?')
    .get(name, ctx.firmId, input.id ?? 0)
  if (dup) throw new AppError(`A template named "${name}" already exists.`, 'VALIDATION')
  return { name, appliesTo: appliesTo as 'all' | TemplateKind, layout, options }
}

/** Defaults that no longer fit a template after it changed are removed (that kind falls back to built-in Classic). */
function pruneDefaults(ctx: Ctx): void {
  const map = { ...(allDefaults(ctx)[String(ctx.firmId)] ?? {}) }
  let changed = false
  for (const [kind, ref] of Object.entries(map)) {
    if (typeof ref !== 'number') continue
    const t = ctx.db.prepare('SELECT applies_to, layout FROM doc_templates WHERE id = ? AND (firm_id IS NULL OR firm_id = ?)').get(ref, ctx.firmId) as
      | { applies_to: string; layout: string }
      | undefined
    if (!t || !isKind(kind) || !templateFits(t, kind)) {
      delete map[kind]
      changed = true
    }
  }
  if (changed) writeDefaults(ctx, map)
}

export function saveTemplate(ctx: Ctx, input: TemplateInput): number {
  requirePerm(ctx, 'templates.manage')
  const db = ctx.db
  const v = validate(ctx, input)
  return db.transaction(() => {
    if (input.id) {
      const before = getTemplate(ctx, Number(input.id))
      db.prepare(
        `UPDATE doc_templates SET name = ?, applies_to = ?, layout = ?, options = ?, updated_at = datetime('now','localtime') WHERE id = ?`
      ).run(v.name, v.appliesTo, v.layout, JSON.stringify(v.options), before.id)
      pruneDefaults(ctx)
      audit(ctx, 'update', 'doc_template', before.id, `Edited print template "${v.name}"`, {
        before: { name: before.name, applies_to: before.applies_to, layout: before.layout, options: before.options },
        after: { name: v.name, applies_to: v.appliesTo, layout: v.layout, options: v.options }
      })
      return before.id
    }
    const id = Number(
      db
        .prepare('INSERT INTO doc_templates (firm_id, name, applies_to, layout, options, created_by) VALUES (?, ?, ?, ?, ?, ?)')
        .run(ctx.firmId, v.name, v.appliesTo, v.layout, JSON.stringify(v.options), ctx.user.id).lastInsertRowid
    )
    audit(ctx, 'create', 'doc_template', id, `Created print template "${v.name}" (${v.layout}, ${kindLabel(v.appliesTo)})`)
    return id
  })()
}

export function duplicateTemplate(ctx: Ctx, id: number): number {
  requirePerm(ctx, 'templates.manage')
  const t = getTemplate(ctx, id)
  let name = `Copy of ${t.name}`.slice(0, 80)
  for (let i = 2; ctx.db.prepare('SELECT 1 FROM doc_templates WHERE name = ? COLLATE NOCASE AND (firm_id IS NULL OR firm_id = ?)').get(name, ctx.firmId); i++) {
    name = `Copy of ${t.name} (${i})`.slice(0, 80)
  }
  return saveTemplate(ctx, { name, appliesTo: t.applies_to, layout: t.layout, options: t.options })
}

export function deleteTemplate(ctx: Ctx, id: number): void {
  requirePerm(ctx, 'templates.manage')
  const t = getTemplate(ctx, id)
  ctx.db.transaction(() => {
    ctx.db.prepare('DELETE FROM doc_templates WHERE id = ?').run(t.id)
    pruneDefaults(ctx)
    audit(ctx, 'delete', 'doc_template', t.id, `Deleted print template "${t.name}"`, { template: { ...t } })
  })()
}

/** Sets (or clears with ref = null) the default template of one document kind in the active firm. */
export function setDefaultTemplate(ctx: Ctx, kind: string, ref: number | string | null): void {
  requirePerm(ctx, 'templates.manage')
  if (!isKind(kind)) throw new AppError('Unknown document kind.', 'VALIDATION')
  const map = { ...(allDefaults(ctx)[String(ctx.firmId)] ?? {}) }
  let label = 'Built-in Classic'
  if (ref === null || ref === undefined || ref === '' || ref === 'builtin:classic') {
    delete map[kind]
  } else if (typeof ref === 'string' && ref.startsWith('builtin:')) {
    if (!isBuiltinFor(ref, kind)) throw new AppError('That built-in layout cannot be used for this document.', 'VALIDATION')
    map[kind] = ref
    label = `Built-in ${ref.slice(8)}`
  } else {
    const id = optId(ref)
    if (!id) throw new AppError('Choose a template.', 'VALIDATION')
    const t = getTemplate(ctx, id)
    if (!templateFits(t, kind)) throw new AppError(`"${t.name}" cannot be used for ${kindLabel(kind)}.`, 'VALIDATION')
    map[kind] = id
    label = t.name
  }
  ctx.db.transaction(() => {
    writeDefaults(ctx, map)
    audit(ctx, 'settings', 'doc_template', typeof map[kind] === 'number' ? (map[kind] as number) : null, `Default print template for ${kindLabel(kind)}: ${label}`)
  })()
}
