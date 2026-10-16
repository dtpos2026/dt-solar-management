/**
 * Vyapar (.vyb) -> DT Solar Pro conversion.
 *
 * A .vyb file is a ZIP archive holding one SQLite database (.vyp, Vyapar schema "user version" ~106). The converter:
 *  1. extracts and opens the .vyp READ-ONLY (the original file is never modified);
 *  2. builds a brand-new DT Solar Pro database with the app's own migrations and seed data;
 *  3. maps every business entity, keeping Vyapar ids wherever the DT Solar Pro table has a one-to-one meaning
 *     (firms, parties, items, transactions -> documents / payments / expenses, line items) and recording every id that
 *     had to change in legacy_id_map;
 *  4. posts stock through the app's own stock engine (moving average cost) in chronological order;
 *  5. copies EVERY source row verbatim into legacy_records (JSON), so fields the new schema cannot represent are kept;
 *  6. returns a reconciliation report (counts, totals, balances, outstanding amounts, stock) — see validateConversion.
 *
 * Vyapar transaction types used here (from the data and Vyapar's TxnType constants):
 *   1 sale, 2 purchase, 3 payment-in, 4 payment-out, 5 party opening (receivable), 6 party opening (payable),
 *   7 expense, 21 sale return, 23 purchase return, 24 sale order, 27 estimate/quotation, 28 purchase order,
 *   30 delivery challan. kb_txn_links = payment <-> bill settlements; kb_linked_transactions = estimate -> invoice.
 */
import Database from 'better-sqlite3'
import { createHash, randomBytes } from 'crypto'
import { mkdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { basename, join } from 'path'
import type { DB } from '../db'
import { configure, migrate, seedDefaults } from '../db'
import { buildSessionUser, hashPassword } from '../services/auth'
import type { Ctx } from '../services/context'
import { setSetting } from '../services/context'
import { ensureSequences } from '../services/firms'
import { createAdjustment } from '../services/inventory'
import { postStock, type DocRow } from '../services/documents'
import { readZipEntry, readZipFile } from './zip'

/* eslint-disable @typescript-eslint/no-explicit-any */
type Row = Record<string, any>

export interface ConversionOptions {
  /** Temporary password for the owner account of the converted database (must be changed at first sign-in). */
  ownerPassword: string
  ownerUsername?: string
}

export interface ConversionNote {
  level: 'info' | 'warning' | 'limitation'
  entity: string
  legacyId?: string | number
  message: string
}

export interface ConversionResult {
  sourceFile: string
  sourceSha256: string
  vypName: string
  vypUserVersion: number
  notes: ConversionNote[]
  idChanges: Array<{ entity: string; legacyId: string; newTable: string; newId: number; note: string }>
  numberChanges: Array<{ entity: string; legacyId: number; original: string; number: string; reason: string }>
  sourceCounts: Record<string, number>
}

const DOC_TYPE: Record<number, string> = {
  1: 'sale_invoice',
  2: 'purchase_invoice',
  21: 'sale_return',
  23: 'purchase_return',
  24: 'sale_order',
  27: 'quotation',
  28: 'purchase_order',
  30: 'delivery_challan'
}
const SEQ_FOR_TYPE: Record<number, string> = {
  1: 'sale_invoice',
  2: 'purchase_invoice',
  3: 'receipt',
  4: 'payment',
  7: 'expense',
  21: 'sale_return',
  23: 'purchase_return',
  24: 'sale_order',
  27: 'quotation',
  28: 'purchase_order',
  30: 'delivery_challan'
}

const r2 = (n: number): number => Math.round((Number(n) || 0) * 100) / 100
const r4 = (n: number): number => Math.round((Number(n) || 0) * 10000) / 10000
const day = (s: unknown): string | null => (typeof s === 'string' && /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null)
/** Original text unchanged (no trimming); null only when the value is empty / whitespace. */
const str = (v: unknown): string | null => {
  if (v === null || v === undefined) return null
  const t = String(v)
  return t.trim() ? t : null
}

function imageDataUrl(buf: Buffer | null | undefined): string | null {
  if (!buf || !buf.length) return null
  const mime = buf[0] === 0x89 && buf[1] === 0x50 ? 'image/png' : buf[0] === 0xff && buf[1] === 0xd8 ? 'image/jpeg' : buf[0] === 0x47 ? 'image/gif' : 'image/png'
  return `data:${mime};base64,${buf.toString('base64')}`
}

/** Extracts the .vyp database from a .vyb archive into a private temp folder; returns its path. */
export function extractVyp(vybFile: string): { vypPath: string; vypName: string; cleanup: () => void; sha256: string } {
  const { buf, entries } = readZipFile(vybFile)
  const entry = entries.find((e) => /\.vyp$/i.test(e.name))
  if (!entry) throw new Error('This .vyb file does not contain a Vyapar database (.vyp).')
  const data = readZipEntry(buf, entry)
  if (data.subarray(0, 15).toString('latin1') !== 'SQLite format 3') throw new Error('The Vyapar database inside the backup is encrypted or not SQLite.')
  const dir = join(tmpdir(), `dtsp-vyapar-${process.pid}-${randomBytes(4).toString('hex')}`)
  mkdirSync(dir, { recursive: true })
  const vypPath = join(dir, 'source.vyp')
  writeFileSync(vypPath, data)
  return { vypPath, vypName: basename(entry.name), sha256: createHash('sha256').update(buf).digest('hex'), cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

/** Builds the DT Solar Pro database at `outFile` from an extracted Vyapar .vyp. */
export function convertVyapar(src: DB, out: DB, meta: { sourceFile: string; sourceSha256: string; vypName: string }, opts: ConversionOptions): ConversionResult {
  const notes: ConversionNote[] = []
  const idChanges: ConversionResult['idChanges'] = []
  const numberChanges: ConversionResult['numberChanges'] = []
  const all = (sql: string, ...a: unknown[]): Row[] => src.prepare(sql).all(...a) as Row[]
  const note = (level: ConversionNote['level'], entity: string, message: string, legacyId?: string | number): void => {
    notes.push({ level, entity, message, legacyId })
  }

  const sourceCounts: Record<string, number> = {}
  for (const t of all("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")) {
    sourceCounts[t.name] = (src.prepare(`SELECT COUNT(*) AS c FROM "${t.name}"`).get() as { c: number }).c
  }

  const settingsRows = all('SELECT setting_key, setting_value FROM kb_settings')
  const vset = (k: string): string | null => {
    const r = settingsRows.find((x) => x.setting_key === k)
    return r ? r.setting_value : null
  }

  const firms = all('SELECT * FROM kb_firms ORDER BY firm_id')
  const defaultFirmId = Number(vset('VYAPAR.DEFAULTFIRMID')) || firms[0]?.firm_id || 1
  const images = new Map<number, Buffer>(all('SELECT image_id, image_bitmap FROM kb_images').map((r) => [r.image_id, r.image_bitmap]))
  const paymentTypes = all('SELECT * FROM kb_paymentTypes ORDER BY paymentType_id')
  const units = new Map<number, string>(all('SELECT unit_id, unit_short_name FROM kb_item_units').map((r) => [r.unit_id, r.unit_short_name]))
  const prefixes = new Map<number, Row>(all('SELECT * FROM kb_prefix').map((r) => [r.prefix_id, r]))
  const tnc = new Map<number, Row>(all('SELECT * FROM terms_and_conditions').map((r) => [r.tnc_id, r]))
  const txns = all('SELECT * FROM kb_transactions ORDER BY txn_id')
  const txnById = new Map<number, Row>(txns.map((t) => [t.txn_id, t]))
  const lines = all('SELECT * FROM kb_lineitems ORDER BY lineitem_txn_id, lineitem_id')
  const linesByTxn = new Map<number, Row[]>()
  for (const l of lines) {
    if (!linesByTxn.has(l.lineitem_txn_id)) linesByTxn.set(l.lineitem_txn_id, [])
    linesByTxn.get(l.lineitem_txn_id)!.push(l)
  }
  const payMap = all('SELECT * FROM txn_payment_mapping ORDER BY id')
  const payByTxn = new Map<number, Row[]>()
  for (const m of payMap) {
    if (!payByTxn.has(m.txn_id)) payByTxn.set(m.txn_id, [])
    payByTxn.get(m.txn_id)!.push(m)
  }
  const links = all('SELECT * FROM kb_txn_links ORDER BY txn_links_id')
  const estimateLinks = all('SELECT * FROM kb_linked_transactions ORDER BY linked_id')
  const udfFields = new Map<number, Row>(all('SELECT * FROM kb_udf_fields').map((r) => [r.udf_field_id, r]))
  const udfValues = all("SELECT * FROM kb_udf_values WHERE COALESCE(udf_value, '') <> '' ORDER BY udf_value_field_id")
  const items = all('SELECT * FROM kb_items ORDER BY item_id')
  const itemById = new Map<number, Row>(items.map((i) => [i.item_id, i]))
  const names = all('SELECT * FROM kb_names ORDER BY name_id')
  const nameById = new Map<number, Row>(names.map((n) => [n.name_id, n]))
  const addresses = all('SELECT * FROM kb_address ORDER BY address_id')
  const groups = new Map<number, string>(all('SELECT * FROM kb_party_groups').map((g) => [g.party_group_id, g.party_group_name]))

  const firmOf = (t: Row): number => {
    const f = Number(t.txn_firm_id)
    if (f && firms.some((x) => x.firm_id === f)) return f
    note('info', 'transaction', `Transaction has no firm in Vyapar; recorded under the default firm (${defaultFirmId}).`, t.txn_id)
    return defaultFirmId
  }

  /* ------------------------------------------------ settings ------------------------------------------------ */
  setSetting(out, 'multi_firm_enabled', vset('VYAPAR.MULTIFIRMENABLED') !== '0')
  setSetting(out, 'share_inventory', true) // Vyapar items are shared by all firms of the company file
  setSetting(out, 'share_parties', true) // Vyapar parties are shared by all firms
  setSetting(out, 'allow_negative_stock', vset('VYAPAR.PREVENTNEGATIVESTOCKSALE') !== '1')
  setSetting(out, 'max_firms', Math.max(5, firms.length))
  if (vset('VYAPAR.CURRENCYSYMBOL')) setSetting(out, 'currency_symbol', String(vset('VYAPAR.CURRENCYSYMBOL')))
  const tncText = (header: string): string | null => {
    const r = [...tnc.values()].find((x) => x.is_active && String(x.header ?? '').toLowerCase() === header.toLowerCase())
    return r ? str(r.description) : null
  }
  const invTerms = tncText('Sale Invoice')
  const qtTerms = tncText('Estimate Quotation')
  if (invTerms) setSetting(out, 'default_invoice_terms', invTerms)
  if (qtTerms) setSetting(out, 'default_quotation_terms', qtTerms)
  note('info', 'settings', 'Mapped Vyapar settings: currency symbol, multi-firm, negative stock (PREVENTNEGATIVESTOCKSALE), default invoice and quotation terms. All 402 Vyapar settings are kept verbatim in the legacy archive.')

  /* ------------------------------------------------ firms ------------------------------------------------ */
  const insFirm = out.prepare(
    `INSERT INTO firms (id, name, tagline, address, phone, phone2, email, ntn, strn, logo, signature, bank_details, print_settings, is_default, is_active, created_at)
     VALUES (@id, @name, @tagline, @address, @phone, @phone2, @email, @ntn, @strn, @logo, @signature, @bank, @ps, @def, 1, datetime('now','localtime'))`
  )
  for (const f of firms) {
    const bank = [str(f.firm_bank_name), str(f.firm_bank_account_number) && `A/C ${f.firm_bank_account_number}`, str(f.firm_bank_ifsc_code) && `Code ${f.firm_bank_ifsc_code}`]
      .filter(Boolean)
      .join('\n')
    insFirm.run({
      id: f.firm_id,
      name: f.firm_name,
      tagline: str(f.firm_description),
      address: str(f.firm_address),
      phone: str(f.firm_phone),
      phone2: str(f.firm_phone_secondary),
      email: str(f.firm_email),
      ntn: str(f.firm_tin_number),
      strn: str(f.firm_gstin_number),
      logo: f.firm_logo ? imageDataUrl(images.get(Number(f.firm_logo))) : null,
      signature: f.firm_signature ? imageDataUrl(images.get(Number(f.firm_signature))) : null,
      bank: bank || null,
      ps: JSON.stringify({}),
      def: f.firm_id === defaultFirmId ? 1 : 0
    })
    ensureSequences(out, f.firm_id)
  }
  // Shared main warehouse (Vyapar has one stock pool per company file).
  const whId = Number(out.prepare("INSERT INTO warehouses (firm_id, name, is_default) VALUES (NULL, 'Main Warehouse', 1)").run().lastInsertRowid)

  /* ------------------------------------------------ accounts ------------------------------------------------ */
  // Vyapar payment types are global; DT Solar Pro accounts belong to a firm. Firm 1 keeps the Vyapar ids, other firms
  // get <firm>*100 + id. Opening balances are kept once (on the default firm) so totals are not doubled.
  const accountId = (firmId: number, ptId: number): number => (firmId === defaultFirmId ? ptId : firmId * 100 + ptId)
  const insAcc = out.prepare(
    `INSERT INTO accounts (id, firm_id, name, type, bank_name, account_title, account_no, iban, opening_balance, is_default, is_active, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, COALESCE(?, datetime('now','localtime')))`
  )
  for (const f of firms) {
    for (const p of paymentTypes) {
      const type = p.paymentType_type === 'CASH' ? 'cash' : 'bank'
      const id = accountId(f.firm_id, p.paymentType_id)
      const opening = f.firm_id === defaultFirmId ? Number(p.paymentType_opening_balance) || 0 : 0
      insAcc.run(id, f.firm_id, p.paymentType_name, type, str(p.paymentType_bankName), str(p.pt_bank_account_holder_name), str(p.paymentType_accountNumber), str(p.pt_bank_ifsc_code), opening, p.paymentType_type === 'CASH' ? 1 : 0, p.paymentType_opening_date ?? null)
      if (id !== p.paymentType_id) idChanges.push({ entity: 'kb_paymentTypes', legacyId: `${p.paymentType_id}@firm${f.firm_id}`, newTable: 'accounts', newId: id, note: `${p.paymentType_name} for firm ${f.firm_id}` })
    }
  }
  if (paymentTypes.some((p) => p.paymentType_type === 'CHEQUE')) {
    note('limitation', 'kb_paymentTypes', 'Vyapar "Cheque" payment mode has no separate cheque-clearing module in DT Solar Pro; it is kept as a bank-type account named "Cheque".')
  }
  const methodOf = (ptId: number): string => {
    const p = paymentTypes.find((x) => x.paymentType_id === ptId)
    return p?.paymentType_type === 'CASH' ? 'cash' : p?.paymentType_type === 'CHEQUE' ? 'cheque' : 'bank'
  }

  /* ------------------------------------------------ owner user ------------------------------------------------ */
  const urp = all('SELECT * FROM urp_users ORDER BY 1 LIMIT 1')[0]
  const ownerRole = out.prepare("SELECT id FROM roles WHERE name = 'Super Administrator'").get() as { id: number }
  const ownerId = Number(
    out
      .prepare(
        `INSERT INTO users (username, full_name, phone, password_hash, role_id, is_owner, is_active, all_firms, must_change_password, last_firm_id)
         VALUES (?, ?, ?, ?, ?, 1, 1, 1, 1, ?)`
      )
      .run(opts.ownerUsername ?? 'admin', str(urp?.user_name ?? urp?.name) ?? 'Admin', str(urp?.user_phone ?? urp?.phone) ?? null, hashPassword(opts.ownerPassword), ownerRole.id, defaultFirmId).lastInsertRowid
  )
  const ctxFor = (firmId: number): Ctx => ({ db: out, user: buildSessionUser(out, ownerId), firmId })

  /* ------------------------------------------------ parties ------------------------------------------------ */
  const partyUse = new Map<number, Set<string>>()
  const use = (id: number | null, k: string): void => {
    if (!id) return
    if (!partyUse.has(id)) partyUse.set(id, new Set())
    partyUse.get(id)!.add(k)
  }
  for (const t of txns) {
    if ([1, 3, 5, 21, 24, 27, 30].includes(t.txn_type)) use(t.txn_name_id, 'customer')
    if ([2, 4, 6, 23, 28].includes(t.txn_type)) use(t.txn_name_id, 'supplier')
  }
  const openings = new Map<number, Row>()
  for (const t of txns.filter((x) => x.txn_type === 5 || x.txn_type === 6)) {
    if (openings.has(t.txn_name_id)) note('warning', 'opening balance', `Party ${t.txn_name_id} has more than one opening balance entry; amounts were added.`, t.txn_id)
    const prev = openings.get(t.txn_name_id)
    const amount = (t.txn_type === 5 ? 1 : -1) * (Number(t.txn_balance_amount) || 0)
    openings.set(t.txn_name_id, { ...t, amount: (prev?.amount ?? 0) + amount })
  }
  const expenseCats = names.filter((n) => n.name_type === 2)
  const insParty = out.prepare(
    `INSERT INTO parties (id, firm_id, type, name, contact_person, phone, email, address, ntn, strn, opening_balance, opening_firm_id, opening_date,
       credit_limit, notes, is_active, created_by, created_at, updated_at)
     VALUES (@id, NULL, @type, @name, @contact, @phone, @email, @address, @ntn, @strn, @ob, @obFirm, @obDate, @credit, @notes, @active, @by, COALESCE(@created, datetime('now','localtime')), @updated)`
  )
  let unusedParties = 0
  for (const n of names.filter((x) => x.name_type === 1)) {
    const u = partyUse.get(n.name_id)
    const type = u?.has('customer') && u?.has('supplier') ? 'both' : u?.has('supplier') ? 'supplier' : 'customer'
    if (!u) unusedParties++
    const ob = openings.get(n.name_id)
    const extra = addresses.filter((a) => a.name_id === n.name_id).map((a) => `${a.address_type === 2 ? 'Shipping' : 'Address'}: ${[a.address, a.city, a.state_name].filter((x) => str(x)).join(', ')}`)
    const noteLines = [
      str(n.name_shipping_address) && `Shipping address: ${n.name_shipping_address}`,
      ...extra,
      str(n.party_billing_name) && `Billing name: ${n.party_billing_name}`,
      n.name_group_id && groups.get(n.name_group_id) && `Group: ${groups.get(n.name_group_id)}`,
      str(n.name_state) && `State: ${n.name_state}`
    ].filter(Boolean)
    insParty.run({
      id: n.name_id,
      type,
      name: n.full_name,
      contact: null,
      phone: str(n.phone_number),
      email: str(n.email),
      address: str(n.address),
      ntn: str(n.name_tin_number),
      strn: str(n.name_gstin_number),
      ob: r2(ob?.amount ?? 0),
      obFirm: ob && r2(ob.amount) !== 0 ? firmOf(ob) : null,
      obDate: ob && r2(ob.amount) !== 0 ? day(ob.txn_date) : null,
      credit: n.credit_limit_enabled ? Number(n.credit_limit) || 0 : 0,
      notes: noteLines.length ? noteLines.join('\n') : null,
      active: n.name_is_active === 0 ? 0 : 1,
      by: ownerId,
      created: n.date_created ?? null,
      updated: n.date_modified ?? null
    })
  }
  if (unusedParties) note('info', 'kb_names', `${unusedParties} parties have no transactions in Vyapar; they were imported as customers (Vyapar does not store a customer/supplier type).`)
  note('info', 'kb_names', 'Party type is derived from usage: sales / receipts / receivable openings = customer, purchases / payments / payable openings = supplier, both = "both".')

  /* ------------------------------------------------ expense categories ------------------------------------------------ */
  const expCatId = new Map<number, number>()
  for (const c of expenseCats) {
    const existing = out.prepare('SELECT id FROM expense_categories WHERE name = ? COLLATE NOCASE').get(c.full_name) as { id: number } | undefined
    const id = existing?.id ?? Number(out.prepare("INSERT INTO expense_categories (name, cost_head) VALUES (?, 'overhead')").run(c.full_name).lastInsertRowid)
    expCatId.set(c.name_id, id)
    idChanges.push({ entity: 'kb_names (expense category)', legacyId: String(c.name_id), newTable: 'expense_categories', newId: id, note: c.full_name })
  }

  /* ------------------------------------------------ products ------------------------------------------------ */
  const insProduct = out.prepare(
    `INSERT INTO products (id, firm_id, category_id, name, sku, type, unit, description, purchase_price, sale_price, reorder_level, is_active, created_by, created_at, updated_at)
     VALUES (@id, NULL, NULL, @name, @sku, @type, @unit, @desc, @pp, @sp, @reorder, @active, @by, COALESCE(@created, datetime('now','localtime')), @updated)`
  )
  for (const i of items) {
    insProduct.run({
      id: i.item_id,
      name: i.item_name,
      sku: str(i.item_code),
      type: i.item_type === 1 ? 'goods' : 'service',
      unit: (i.base_unit_id && units.get(i.base_unit_id)) || 'pcs',
      desc: str(i.item_description),
      pp: Number(i.item_purchase_unit_price) || 0,
      sp: Number(i.item_sale_unit_price) || 0,
      reorder: Number(i.item_min_stock_quantity) || 0,
      active: i.item_is_active === 0 ? 0 : 1,
      by: ownerId,
      created: i.item_date_created ?? null,
      updated: i.item_date_modified ?? null
    })
  }
  note('info', 'kb_items', 'Vyapar item type 1 = goods (stock tracked); other types (expense/service items) = service products.')

  /* ------------------------------------------------ numbering ------------------------------------------------ */
  const used = new Map<string, Set<string>>()
  const uniqueNumber = (scope: string, wanted: string, txnId: number, entity: string, original: string, reason: string): string => {
    if (!used.has(scope)) used.set(scope, new Set())
    const set = used.get(scope)!
    let n = wanted
    if (set.has(n)) {
      n = `${wanted}-${txnId}`
      numberChanges.push({ entity, legacyId: txnId, original, number: n, reason: `Duplicate number "${wanted}" in Vyapar; Vyapar transaction id appended.` })
    } else if (reason) {
      numberChanges.push({ entity, legacyId: txnId, original, number: n, reason })
    }
    set.add(n)
    return n
  }
  const vyNumber = (t: Row): string => {
    const ref = str(t.txn_ref_number_char) ?? ''
    const pre = t.txn_prefix_id ? str(prefixes.get(t.txn_prefix_id)?.prefix_value) ?? '' : str(t.txn_invoice_prefix) ?? ''
    return ref ? `${pre}${ref}` : ''
  }

  /* ------------------------------------------------ notes / custom fields ------------------------------------------------ */
  const udfByRef = new Map<number, string[]>()
  for (const v of udfValues) {
    const f = udfFields.get(v.udf_value_field_id)
    if (!f) continue
    // Field types 3 = transaction fields (udf_txn_type), 1/2 = party/item fields in Vyapar.
    if (!udfByRef.has(v.udf_ref_id)) udfByRef.set(v.udf_ref_id, [])
    udfByRef.get(v.udf_ref_id)!.push(`${String(f.udf_field_name ?? 'Detail').trim()}: ${String(v.udf_value).trim()}`)
  }
  const txnNotes = (t: Row, extra: string[] = []): string | null => {
    const parts = [str(t.txn_description), ...(t.txn_type !== 7 ? udfByRef.get(t.txn_id) ?? [] : []), ...extra].filter(Boolean)
    return parts.length ? parts.join('\n') : null
  }

  /* ------------------------------------------------ documents ------------------------------------------------ */
  const insDoc = out.prepare(
    `INSERT INTO documents (id, firm_id, doc_type, number, date, due_date, valid_until, party_id, party_name, party_phone, party_address, warehouse_id,
       status, is_tax_invoice, deduct_stock, subtotal, line_discount_total, doc_discount, tax_total, other_charges, other_charges_label, round_off,
       net_total, grand_total, cost_total, ref_doc_id, party_ref, notes, terms, created_by, created_at, updated_at)
     VALUES (@id, @firm, @type, @number, @date, @due, @valid, @party, @pname, @pphone, @paddr, @wh, @status, @tax_inv, 1, @subtotal, 0, @disc, @tax,
       @other, @other_label, @round, @net, @grand, 0, NULL, @party_ref, @notes, @terms, @by, COALESCE(@created, datetime('now','localtime')), @updated)`
  )
  const insLine = out.prepare(
    `INSERT INTO document_lines (id, document_id, line_no, product_id, description, details, unit, qty, rate, discount_pct, discount_amt, tax_rate, tax_amt,
       net_amount, line_total, unit_cost, cost_total, serials, batch_no)
     VALUES (@id, @doc, @no, @product, @desc, @details, @unit, @qty, @rate, @dpct, @damt, 0, @tax, @net, @total, @ucost, 0, @serial, @batch)`
  )
  const linkedEstimates = new Map<number, number>() // estimate id -> sale id
  for (const l of estimateLinks) linkedEstimates.set(l.txn_source_id, l.txn_destination_id)
  const docTxns = txns.filter((t) => DOC_TYPE[t.txn_type])
  for (const t of docTxns) {
    const type = DOC_TYPE[t.txn_type]
    const firmId = firmOf(t)
    const party = t.txn_name_id ? nameById.get(t.txn_name_id) : null
    const ls = linesByTxn.get(t.txn_id) ?? []
    const total = (Number(t.txn_cash_amount) || 0) + (Number(t.txn_balance_amount) || 0)
    const disc = Number(t.txn_discount_amount) || 0
    const tax = Number(t.txn_tax_amount) || 0
    const other = (Number(t.txn_ac1_amount) || 0) + (Number(t.txn_ac2_amount) || 0) + (Number(t.txn_ac3_amount) || 0)
    const otherLabel = [t.ac1_name, t.ac2_name, t.ac3_name].filter((x, i) => str(x) && Number(t[`txn_ac${i + 1}_amount`])).join(', ') || null
    let lineRows = ls
    if (ls.length === 0 && total !== 0) {
      lineRows = [{ synthetic: true }]
      note('warning', 'transaction', `${type} has an amount (${total}) but no item lines in Vyapar; one line "Amount as recorded in Vyapar (no item lines)" was added so the total is visible and printable.`, t.txn_id)
    }
    const subtotal = lineRows.reduce((s, l) => s + (l.synthetic ? total : Number(l.total_amount) || 0), 0)
    const net = subtotal - disc
    const roundOff = r4(total - (net + tax + other) + (Number(t.txn_round_off_amount) || 0) - (Number(t.txn_round_off_amount) || 0))
    if (Math.abs(roundOff) > 0.0001) note('info', 'transaction', `Vyapar stored total ${total} differs from lines - discount + tax by ${roundOff} (Vyapar rounding); kept as round-off so the document total is exactly the Vyapar total.`, t.txn_id)
    const original = vyNumber(t)
    let number: string
    if (type === 'purchase_invoice') {
      number = original
        ? uniqueNumber(`${firmId}:${type}`, original, t.txn_id, 'purchase', original, '')
        : uniqueNumber(`${firmId}:${type}`, `PB-${t.txn_id}`, t.txn_id, 'purchase', '', 'No bill number in Vyapar; number made from the Vyapar transaction id.')
    } else {
      number = original
        ? uniqueNumber(`${firmId}:${type}`, original, t.txn_id, type, original, '')
        : uniqueNumber(`${firmId}:${type}`, `VYP-${t.txn_id}`, t.txn_id, type, '', 'No number in Vyapar; number made from the Vyapar transaction id.')
    }
    let status = 'final'
    if (type === 'quotation') {
      status = linkedEstimates.has(t.txn_id) ? 'converted' : t.txn_status === 4 ? 'accepted' : 'sent'
    }
    const terms = t.tnc_id ? str(tnc.get(t.tnc_id)?.description) : null
    insDoc.run({
      id: t.txn_id,
      firm: firmId,
      type,
      number,
      date: day(t.txn_date),
      due: type !== 'quotation' ? day(t.txn_due_date) : null,
      valid: type === 'quotation' ? day(t.txn_due_date) : null,
      party: party && party.name_type === 1 ? party.name_id : null,
      pname: party?.full_name ?? null,
      pphone: str(t.mobile_no) ?? str(party?.phone_number),
      paddr: str(t.txn_billing_address) ?? str(party?.address),
      wh: whId,
      status,
      tax_inv: tax > 0 ? 1 : 0,
      subtotal: r4(subtotal),
      disc: r4(disc),
      tax: r4(tax),
      other: r4(other),
      other_label: otherLabel,
      round: roundOff,
      net: r4(net),
      grand: r4(total),
      party_ref: type === 'purchase_invoice' && original ? original : null,
      notes: txnNotes(t, str(t.txn_shipping_address) ? [`Shipping address: ${t.txn_shipping_address}`] : []),
      terms,
      by: ownerId,
      created: t.txn_date_created ?? null,
      updated: t.txn_date_modified ?? null
    })
    let no = 0
    const factor = subtotal > 0 ? net / subtotal : 1
    for (const l of lineRows) {
      no++
      if (l.synthetic) {
        // Explicit id outside the Vyapar line-id range so it can never collide with a real line.
        idChanges.push({ entity: 'kb_transactions (no item lines)', legacyId: String(t.txn_id), newTable: 'document_lines', newId: 9_000_000 + t.txn_id, note: 'synthetic line carrying the Vyapar total' })
        insLine.run({ id: 9_000_000 + t.txn_id, doc: t.txn_id, no, product: null, desc: 'Amount as recorded in Vyapar (no item lines)', details: null, unit: null, qty: 1, rate: total, dpct: 0, damt: 0, tax: 0, net: total, total, ucost: 0, serial: null, batch: null })
        continue
      }
      const item = itemById.get(l.item_id)
      const qty = Number(l.quantity) || 0
      const rate = Number(l.priceperunit) || 0
      const lt = Number(l.total_amount) || 0
      insLine.run({
        id: l.lineitem_id,
        doc: t.txn_id,
        no,
        product: item ? item.item_id : null,
        desc: item?.item_name ?? str(l.lineitem_description) ?? 'Item',
        details: str(l.lineitem_description),
        unit: (l.lineitem_unit_id && units.get(l.lineitem_unit_id)) || (item?.base_unit_id && units.get(item.base_unit_id)) || null,
        qty,
        rate,
        dpct: Number(l.lineitem_discount_percent) || 0,
        damt: Number(l.lineitem_discount_amount) || 0,
        tax: Number(l.lineitem_tax_amount) || 0,
        net: r4(qty * rate - (Number(l.lineitem_discount_amount) || 0)),
        total: lt,
        // purchase landed cost per unit: line amount after its share of the document discount
        ucost: type === 'purchase_invoice' && qty > 0 ? r4((lt * factor) / qty) : 0,
        serial: str(l.lineitem_serial_number),
        batch: str(l.lineitem_batch_number)
      })
    }
  }
  // Estimate -> invoice conversions
  for (const [est, sale] of linkedEstimates) {
    if (txnById.get(sale) && txnById.get(est)) out.prepare('UPDATE documents SET ref_doc_id = ? WHERE id = ?').run(est, sale)
    else note('warning', 'kb_linked_transactions', `Estimate link ${est} -> ${sale} points to a missing transaction.`)
  }

  /* ------------------------------------------------ payments ------------------------------------------------ */
  const insPay = out.prepare(
    `INSERT INTO payments (id, firm_id, number, date, direction, party_id, account_id, amount, method, reference, notes, status, created_by, created_at, updated_at)
     VALUES (@id, @firm, @number, @date, @dir, @party, @account, @amount, @method, @ref, @notes, 'final', @by, COALESCE(@created, datetime('now','localtime')), @updated)`
  )
  const insAlloc = out.prepare('INSERT INTO payment_allocations (payment_id, document_id, amount) VALUES (?, ?, ?)')
  const insAdj = out.prepare(
    `INSERT INTO party_adjustments (firm_id, number, date, party_id, direction, amount, reason, status, created_by, created_at, document_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'final', ?, COALESCE(?, datetime('now','localtime')), ?)`
  )
  const GENERATED_BASE = 1_000_000
  // (a) money received / paid together with a sale / purchase (Vyapar "Received" / "Paid" on the bill)
  for (const t of docTxns.filter((x) => x.txn_type === 1 || x.txn_type === 2)) {
    const maps = (payByTxn.get(t.txn_id) ?? []).filter((m) => Number(m.amount) > 0)
    const docNo = (out.prepare('SELECT number FROM documents WHERE id = ?').get(t.txn_id) as { number: string }).number
    const firmId = firmOf(t)
    maps.forEach((m, i) => {
      const id = GENERATED_BASE + Number(m.id)
      const dir = t.txn_type === 1 ? 'in' : 'out'
      const number = uniqueNumber(`${firmId}:pay:${dir}`, maps.length > 1 ? `${docNo}-PAID-${i + 1}` : `${docNo}-PAID`, t.txn_id, 'payment with bill', '', 'Amount paid at billing in Vyapar; recorded as a separate receipt/payment linked to the bill.')
      insPay.run({
        id,
        firm: firmId,
        number,
        date: day(t.txn_date),
        dir,
        party: t.txn_name_id && nameById.get(t.txn_name_id)?.name_type === 1 ? t.txn_name_id : null,
        account: accountId(firmId, Number(m.payment_id) || 1),
        amount: r4(Number(m.amount)),
        method: methodOf(Number(m.payment_id)),
        ref: str(m.payment_reference) ?? str(t.txn_payment_reference),
        notes: `${dir === 'in' ? 'Received with' : 'Paid with'} ${t.txn_type === 1 ? 'sales invoice' : 'purchase bill'} ${docNo} (Vyapar)`,
        by: ownerId,
        created: t.txn_date_created ?? null,
        updated: t.txn_date_modified ?? null
      })
      insAlloc.run(id, t.txn_id, r4(Number(m.amount)))
      idChanges.push({ entity: 'txn_payment_mapping', legacyId: String(m.id), newTable: 'payments', newId: id, note: `Paid amount of Vyapar transaction ${t.txn_id}` })
    })
  }
  // (b) payment-in / payment-out transactions (ids kept)
  const payTxns = txns.filter((t) => t.txn_type === 3 || t.txn_type === 4)
  const remainingCash = new Map<number, number>()
  const remainingDisc = new Map<number, number>()
  for (const t of payTxns) {
    const firmId = firmOf(t)
    const maps = payByTxn.get(t.txn_id) ?? []
    const cash = Number(t.txn_cash_amount) || 0
    const dir = t.txn_type === 3 ? 'in' : 'out'
    const original = vyNumber(t)
    const number = original
      ? uniqueNumber(`${firmId}:pay:${dir}`, original, t.txn_id, dir === 'in' ? 'payment-in' : 'payment-out', original, '')
      : uniqueNumber(`${firmId}:pay:${dir}`, `${dir === 'in' ? 'RV' : 'PV'}-VYP-${t.txn_id}`, t.txn_id, dir === 'in' ? 'payment-in' : 'payment-out', '', 'No number in Vyapar; number made from the Vyapar transaction id.')
    if (maps.length > 1) note('warning', 'txn_payment_mapping', 'Split payment across several modes: recorded on the first mode only.', t.txn_id)
    if (cash <= 0) {
      note('warning', 'transaction', `Payment ${number} has no cash amount (only discount ${t.txn_discount_amount}); recorded as a party adjustment only.`, t.txn_id)
    } else {
      insPay.run({
        id: t.txn_id,
        firm: firmId,
        number,
        date: day(t.txn_date),
        dir,
        party: t.txn_name_id && nameById.get(t.txn_name_id)?.name_type === 1 ? t.txn_name_id : null,
        account: accountId(firmId, Number(maps[0]?.payment_id) || 1),
        amount: r4(cash),
        method: methodOf(Number(maps[0]?.payment_id) || 1),
        ref: str(maps[0]?.payment_reference) ?? str(t.txn_payment_reference),
        notes: txnNotes(t),
        by: ownerId,
        created: t.txn_date_created ?? null,
        updated: t.txn_date_modified ?? null
      })
    }
    remainingCash.set(t.txn_id, cash)
    remainingDisc.set(t.txn_id, Number(t.txn_discount_amount) || 0)
  }
  // (c) settlements: kb_txn_links (payment <-> bill). Discount parts become document-linked party adjustments.
  let adjSeq = 0
  const adjNumber = (firmId: number, payId: number): string => uniqueNumber(`${firmId}:adj`, `DISC-${payId}-${++adjSeq}`, payId, 'discount', '', '')
  const addDiscount = (pay: Row, amount: number, docId: number | null): void => {
    const firmId = firmOf(pay)
    const dir = pay.txn_type === 3 ? 'credit' : 'debit'
    const payNo = (out.prepare('SELECT number FROM payments WHERE id = ?').get(pay.txn_id) as { number: string } | undefined)?.number ?? String(pay.txn_id)
    insAdj.run(firmId, adjNumber(firmId, pay.txn_id), day(pay.txn_date), pay.txn_name_id, dir, r4(amount), `Discount ${pay.txn_type === 3 ? 'allowed on receipt' : 'received on payment'} ${payNo} (Vyapar)`, ownerId, pay.txn_date_created ?? null, docId)
  }
  const unrepresentable: string[] = []
  for (const k of links) {
    const a = txnById.get(k.txn_links_txn_1_id)
    const b = txnById.get(k.txn_links_txn_2_id)
    if (!a || !b) {
      note('warning', 'kb_txn_links', `Settlement ${k.txn_links_id} points to a missing transaction.`, k.txn_links_id)
      continue
    }
    const pay = [3, 4].includes(a.txn_type) && [1, 2].includes(b.txn_type) ? a : [3, 4].includes(b.txn_type) && [1, 2].includes(a.txn_type) ? b : null
    const bill = pay === a ? b : pay === b ? a : null
    if (!pay || !bill) {
      unrepresentable.push(`${k.txn_links_id} (${a.txn_type}->${b.txn_type}, ${k.txn_links_amount})`)
      continue
    }
    let amount = Number(k.txn_links_amount) || 0
    const cashLeft = remainingCash.get(pay.txn_id) ?? 0
    const fromCash = Math.min(cashLeft, amount)
    if (fromCash > 0) {
      insAlloc.run(pay.txn_id, bill.txn_id, r4(fromCash))
      remainingCash.set(pay.txn_id, r4(cashLeft - fromCash))
      amount = r4(amount - fromCash)
    }
    if (amount > 0.0001) {
      const discLeft = remainingDisc.get(pay.txn_id) ?? 0
      const fromDisc = Math.min(discLeft, amount)
      if (fromDisc > 0) {
        addDiscount(pay, fromDisc, bill.txn_id)
        remainingDisc.set(pay.txn_id, r4(discLeft - fromDisc))
        amount = r4(amount - fromDisc)
      }
      if (amount > 0.01) note('warning', 'kb_txn_links', `Settlement ${k.txn_links_id} exceeds the payment amount + discount by ${amount}; the excess was not allocated.`, k.txn_links_id)
    }
  }
  for (const [payId, disc] of remainingDisc) {
    if (disc > 0.0001) addDiscount(txnById.get(payId)!, disc, null)
  }
  if (unrepresentable.length) {
    note(
      'limitation',
      'kb_txn_links',
      `${unrepresentable.length} Vyapar settlements link a payment to an opening balance or to another payment (refund). DT Solar Pro allocates payments only to invoices/bills, so these payments stay unallocated; party balances are unaffected. Links: ${unrepresentable.join('; ')}`
    )
  }

  /* ------------------------------------------------ expenses ------------------------------------------------ */
  const insExp = out.prepare(
    `INSERT INTO expenses (id, firm_id, number, date, category_id, amount, paid, account_id, party_id, payee_name, method, reference, notes, status, created_by, created_at, updated_at)
     VALUES (@id, @firm, @number, @date, @cat, @amount, @paid, @account, @party, NULL, @method, @ref, @notes, 'final', @by, COALESCE(@created, datetime('now','localtime')), @updated)`
  )
  let generalCat: number | null = null
  for (const t of txns.filter((x) => x.txn_type === 7)) {
    const firmId = firmOf(t)
    const maps = payByTxn.get(t.txn_id) ?? []
    const total = (Number(t.txn_cash_amount) || 0) + (Number(t.txn_balance_amount) || 0)
    let cat = t.txn_category_id ? expCatId.get(t.txn_category_id) : undefined
    if (!cat) {
      if (!generalCat) generalCat = (out.prepare("SELECT id FROM expense_categories WHERE name = 'Miscellaneous'").get() as { id: number } | undefined)?.id ?? null
      cat = generalCat ?? undefined
      note('warning', 'expense', 'Expense without a category in Vyapar; recorded under "Miscellaneous".', t.txn_id)
    }
    const ls = (linesByTxn.get(t.txn_id) ?? []).map((l) => {
      const item = itemById.get(l.item_id)
      return `• ${item?.item_name ?? 'Item'}${str(l.lineitem_description) ? ` — ${String(l.lineitem_description).trim()}` : ''}: ${l.quantity} × ${l.priceperunit} = ${l.total_amount}`
    })
    const original = vyNumber(t)
    const number = original
      ? uniqueNumber(`${firmId}:exp`, original, t.txn_id, 'expense', original, '')
      : uniqueNumber(`${firmId}:exp`, `EXP-VYP-${t.txn_id}`, t.txn_id, 'expense', '', 'No number in Vyapar; number made from the Vyapar transaction id.')
    const paid = (Number(t.txn_balance_amount) || 0) <= 0.0001
    if (!paid) note('warning', 'expense', `Expense ${number} was partly unpaid in Vyapar (balance ${t.txn_balance_amount}); recorded as unpaid.`, t.txn_id)
    insExp.run({
      id: t.txn_id,
      firm: firmId,
      number,
      date: day(t.txn_date),
      cat,
      amount: r4(total),
      paid: paid ? 1 : 0,
      account: paid ? accountId(firmId, Number(maps[0]?.payment_id) || 1) : null,
      party: t.txn_name_id && nameById.get(t.txn_name_id)?.name_type === 1 ? t.txn_name_id : null,
      method: paid ? methodOf(Number(maps[0]?.payment_id) || 1) : null,
      ref: str(maps[0]?.payment_reference) ?? str(t.txn_payment_reference),
      notes: [txnNotes(t), ls.length ? `Expense items (Vyapar):\n${ls.join('\n')}` : null, ...(udfByRef.get(t.txn_id) ?? [])].filter(Boolean).join('\n') || null,
      by: ownerId,
      created: t.txn_date_created ?? null,
      updated: t.txn_date_modified ?? null
    })
  }

  /* ------------------------------------------------ unsupported transaction types ------------------------------------------------ */
  const handled = new Set([1, 2, 3, 4, 5, 6, 7, 21, 23, 24, 27, 28, 30])
  const others = txns.filter((t) => !handled.has(t.txn_type))
  if (others.length) note('limitation', 'kb_transactions', `${others.length} transactions of unsupported Vyapar types (${[...new Set(others.map((t) => t.txn_type))].join(', ')}) are kept in the legacy archive only.`)

  /* ------------------------------------------------ stock (chronological, app stock engine) ------------------------------------------------ */
  type Ev = { date: string; created: string; id: number; kind: 'doc' | 'adj'; row: Row }
  const events: Ev[] = []
  for (const t of docTxns.filter((x) => x.txn_type === 1 || x.txn_type === 2 || x.txn_type === 21 || x.txn_type === 23)) {
    events.push({ date: day(t.txn_date) ?? '', created: String(t.txn_date_created ?? ''), id: t.txn_id, kind: 'doc', row: t })
  }
  const adjustments = all('SELECT * FROM kb_item_adjustments ORDER BY item_adj_id')
  for (const a of adjustments) {
    const q = Number(a.item_adj_quantity) || 0
    if (Math.abs(q) < 1e-9) continue
    events.push({ date: day(a.item_adj_date) ?? '', created: String(a.item_adj_date_created ?? ''), id: a.item_adj_id, kind: 'adj', row: a })
  }
  events.sort((x, y) => (x.date < y.date ? -1 : x.date > y.date ? 1 : x.created < y.created ? -1 : x.created > y.created ? 1 : x.id - y.id))
  for (const e of events) {
    if (e.kind === 'doc') {
      const d = out.prepare('SELECT * FROM documents WHERE id = ?').get(e.id) as DocRow
      postStock(ctxFor(d.firm_id), d)
    } else {
      const a = e.row
      // Vyapar item_adj_type: 10 = opening stock, 11 = add stock, 12 = reduce stock
      const sign = a.item_adj_type === 12 ? -1 : 1
      const id = createAdjustment(ctxFor(defaultFirmId), {
        date: day(a.item_adj_date)!,
        warehouseId: whId,
        kind: a.item_adj_type === 10 ? 'opening' : 'adjustment',
        reason: str(a.item_adj_description) ?? (sign < 0 ? 'Stock reduced (Vyapar adjustment)' : 'Stock added (Vyapar adjustment)'),
        notes: `Vyapar item adjustment ${a.item_adj_id}`,
        lines: [{ productId: a.item_adj_item_id, qty: sign * Math.abs(Number(a.item_adj_quantity)), unitCost: Number(a.item_adj_atprice) > 0 ? Number(a.item_adj_atprice) : undefined }]
      })
      idChanges.push({ entity: 'kb_item_adjustments', legacyId: String(a.item_adj_id), newTable: 'stock_adjustments', newId: id, note: 'stock adjustment' })
    }
  }
  const zeroAdj = adjustments.filter((a) => Math.abs(Number(a.item_adj_quantity) || 0) < 1e-9).length
  if (zeroAdj) note('info', 'kb_item_adjustments', `${zeroAdj} Vyapar opening-stock entries have quantity 0; they have no stock effect and are kept in the legacy archive.`)

  /* ------------------------------------------------ sequences (continue numbering after the imported numbers) ------------------------------------------------ */
  for (const f of firms) {
    for (const [txnType, seqType] of Object.entries(SEQ_FOR_TYPE)) {
      const p = all('SELECT prefix_value FROM kb_prefix WHERE prefix_firm_id = ? AND prefix_txn_type = ? AND prefix_is_default = 1', f.firm_id, Number(txnType))[0]
      if (!p) continue
      const refs = txns
        .filter((t) => t.txn_type === Number(txnType) && firmOf(t) === f.firm_id && prefixes.get(t.txn_prefix_id)?.prefix_value === p.prefix_value)
        .map((t) => Number(t.txn_ref_number_char))
        .filter((n) => Number.isInteger(n))
      const next = (refs.length ? Math.max(...refs) : 0) + 1
      out.prepare('UPDATE doc_sequences SET prefix = ?, next_no = ?, padding = 0 WHERE firm_id = ? AND doc_type = ?').run(p.prefix_value, next, f.firm_id, seqType)
    }
  }
  note('info', 'kb_prefix', 'Numbering continues from the last Vyapar number per firm and type, with the Vyapar default prefixes (no zero padding).')

  /* ------------------------------------------------ legacy archive ------------------------------------------------ */
  const sourceId = Number(
    out
      .prepare('INSERT INTO legacy_sources (system, file_name, file_sha256, summary) VALUES (?, ?, ?, ?)')
      .run('vyapar', basename(meta.sourceFile), meta.sourceSha256, JSON.stringify({ vyp: meta.vypName, tables: sourceCounts }))
      .lastInsertRowid
  )
  const insRec = out.prepare('INSERT INTO legacy_records (source_id, table_name, legacy_id, data) VALUES (?, ?, ?, ?)')
  const DERIVED = /^(kb_fts_|sqlite_)/
  for (const name of Object.keys(sourceCounts)) {
    if (DERIVED.test(name) || sourceCounts[name] === 0) continue
    const cols = src.prepare(`PRAGMA table_info("${name}")`).all() as Array<{ name: string; pk: number }>
    const pk = cols.find((c) => c.pk === 1)?.name ?? cols[0].name
    for (const r of all(`SELECT * FROM "${name}"`)) {
      const data: Row = {}
      for (const c of cols) {
        const v = r[c.name]
        data[c.name] = Buffer.isBuffer(v) ? { $b64: v.toString('base64') } : v
      }
      insRec.run(sourceId, name, r[pk] === null || r[pk] === undefined ? null : String(r[pk]), JSON.stringify(data))
    }
  }
  note('info', 'archive', 'Every row of every Vyapar table is kept verbatim in legacy_records (JSON); derived full-text-search tables (kb_fts_*) and sqlite_sequence are not copied because Vyapar rebuilds them from the other tables.')
  const insMap = out.prepare('INSERT OR REPLACE INTO legacy_id_map (source_id, entity, legacy_id, new_table, new_id, note) VALUES (?, ?, ?, ?, ?, ?)')
  for (const c of idChanges) insMap.run(sourceId, c.entity, c.legacyId, c.newTable, c.newId, c.note)
  for (const c of numberChanges) insMap.run(sourceId, `number:${c.entity}`, String(c.legacyId), 'documents/payments/expenses', c.legacyId, `${c.original || '(none)'} -> ${c.number}: ${c.reason}`)

  return {
    sourceFile: meta.sourceFile,
    sourceSha256: meta.sourceSha256,
    vypName: meta.vypName,
    vypUserVersion: Number(src.pragma('user_version', { simple: true })),
    notes,
    idChanges,
    numberChanges,
    sourceCounts
  }
}

/** Opens a fresh target database (schema + seed) for a conversion. */
export function createTargetDb(file: string): DB {
  for (const f of [file, `${file}-wal`, `${file}-shm`]) rmSync(f, { force: true })
  const db = new Database(file)
  configure(db)
  migrate(db)
  seedDefaults(db)
  return db
}
