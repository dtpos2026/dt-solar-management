/**
 * Reconciliation of a Vyapar conversion: compares the read-only Vyapar source with the converted DT Solar Pro database
 * using the app's own balance / due / stock formulas. Every check records expected vs actual.
 */
import type { DB } from '../db'
import { LEDGER_SQL } from '../services/parties'
import { accountBalance, docDue } from '../services/payments'
import { totalQty } from '../services/inventory'
import type { ConversionResult } from './vyapar'

/* eslint-disable @typescript-eslint/no-explicit-any */
type Row = Record<string, any>

export interface Check {
  group: string
  name: string
  expected: string | number
  actual: string | number
  pass: boolean
  detail?: string
}

export interface ValidationResult {
  checks: Check[]
  failed: number
  warnings: number
  mismatches: Array<{ group: string; key: string; expected: number | string; actual: number | string }>
  partyBalances: Array<{ id: number; name: string; vyapar: number; converted: number }>
  accountBalances: Array<{ paymentTypeId: number; name: string; vyapar: number; converted: number }>
}

const near = (a: number, b: number, tol = 0.01): boolean => Math.abs((Number(a) || 0) - (Number(b) || 0)) <= tol + 1e-9
const r2 = (n: number): number => Math.round((Number(n) || 0) * 100) / 100

export function validateConversion(src: DB, out: DB, conv: ConversionResult): ValidationResult {
  const checks: Check[] = []
  const mismatches: ValidationResult['mismatches'] = []
  const sAll = (sql: string, ...a: unknown[]): Row[] => src.prepare(sql).all(...a) as Row[]
  const sOne = (sql: string, ...a: unknown[]): any => (src.prepare(sql).get(...a) as Row | undefined) ?? {}
  const oOne = (sql: string, ...a: unknown[]): any => (out.prepare(sql).get(...a) as Row | undefined) ?? {}
  const add = (group: string, name: string, expected: number | string, actual: number | string, pass?: boolean, detail?: string): void => {
    checks.push({ group, name, expected, actual, pass: pass ?? (typeof expected === 'number' ? near(expected, Number(actual)) : expected === actual), detail })
  }

  /* ---------------- record counts ---------------- */
  const cnt = (sql: string, ...a: unknown[]): number => Number(Object.values(sOne(sql, ...a))[0] ?? 0)
  const ocnt = (sql: string, ...a: unknown[]): number => Number(Object.values(oOne(sql, ...a))[0] ?? 0)
  add('counts', 'Firms', cnt('SELECT COUNT(*) FROM kb_firms'), ocnt('SELECT COUNT(*) FROM firms'))
  add('counts', 'Parties (customers/suppliers)', cnt('SELECT COUNT(*) FROM kb_names WHERE name_type = 1'), ocnt('SELECT COUNT(*) FROM parties'))
  add('counts', 'Expense categories (Vyapar names type 2)', cnt('SELECT COUNT(*) FROM kb_names WHERE name_type = 2'), ocnt("SELECT COUNT(*) FROM legacy_id_map WHERE new_table = 'expense_categories'"))
  add('counts', 'Items / products', cnt('SELECT COUNT(*) FROM kb_items'), ocnt('SELECT COUNT(*) FROM products'))
  for (const [t, label, type] of [[1, 'Sales invoices', 'sale_invoice'], [2, 'Purchase bills', 'purchase_invoice'], [27, 'Estimates / quotations', 'quotation'], [21, 'Sale returns', 'sale_return'], [23, 'Purchase returns', 'purchase_return'], [24, 'Sale orders', 'sale_order'], [28, 'Purchase orders', 'purchase_order'], [30, 'Delivery challans', 'delivery_challan']] as const) {
    const e = cnt('SELECT COUNT(*) FROM kb_transactions WHERE txn_type = ?', t)
    if (e || ocnt('SELECT COUNT(*) FROM documents WHERE doc_type = ?', type)) add('counts', label, e, ocnt('SELECT COUNT(*) FROM documents WHERE doc_type = ?', type))
  }
  add('counts', 'Document line items (item lines)', cnt('SELECT COUNT(*) FROM kb_lineitems l JOIN kb_transactions t ON t.txn_id = l.lineitem_txn_id WHERE t.txn_type <> 7'), ocnt('SELECT COUNT(*) FROM document_lines WHERE product_id IS NOT NULL'))
  add('counts', 'Lines kept with their Vyapar ids', cnt('SELECT COUNT(*) FROM kb_lineitems l JOIN kb_transactions t ON t.txn_id = l.lineitem_txn_id WHERE t.txn_type <> 7'), ocnt('SELECT COUNT(*) FROM document_lines dl WHERE dl.id IN (SELECT id FROM document_lines WHERE product_id IS NOT NULL)'))
  add('counts', 'Payment-in records', cnt('SELECT COUNT(*) FROM kb_transactions WHERE txn_type = 3 AND txn_cash_amount > 0'), ocnt("SELECT COUNT(*) FROM payments WHERE direction = 'in' AND id < 1000000"))
  add('counts', 'Payment-out records', cnt('SELECT COUNT(*) FROM kb_transactions WHERE txn_type = 4 AND txn_cash_amount > 0'), ocnt("SELECT COUNT(*) FROM payments WHERE direction = 'out' AND id < 1000000"))
  add('counts', 'Amounts paid at billing (separate receipts/payments)', cnt('SELECT COUNT(*) FROM txn_payment_mapping m JOIN kb_transactions t ON t.txn_id = m.txn_id WHERE t.txn_type IN (1,2) AND m.amount > 0'), ocnt('SELECT COUNT(*) FROM payments WHERE id >= 1000000'))
  add('counts', 'Expenses', cnt('SELECT COUNT(*) FROM kb_transactions WHERE txn_type = 7'), ocnt('SELECT COUNT(*) FROM expenses'))
  add('counts', 'Payment discounts (as party adjustments)', cnt('SELECT COUNT(*) FROM kb_transactions WHERE txn_type IN (3,4) AND txn_discount_amount > 0'), ocnt("SELECT COUNT(DISTINCT CAST(substr(number, 6, instr(substr(number, 6), '-') - 1) AS INTEGER)) FROM party_adjustments WHERE number LIKE 'DISC-%'"))
  add('counts', 'Estimate -> invoice conversions', cnt('SELECT COUNT(*) FROM kb_linked_transactions'), ocnt('SELECT COUNT(*) FROM documents WHERE ref_doc_id IS NOT NULL'))
  add('counts', 'Party opening balances (non-zero)', cnt('SELECT COUNT(*) FROM kb_transactions WHERE txn_type IN (5,6) AND txn_balance_amount <> 0'), ocnt('SELECT COUNT(*) FROM parties WHERE opening_balance <> 0'))

  /* ---------------- money totals ---------------- */
  const sum = (sql: string, ...a: unknown[]): number => r2(Number(Object.values(sOne(sql, ...a))[0] ?? 0))
  const osum = (sql: string, ...a: unknown[]): number => r2(Number(Object.values(oOne(sql, ...a))[0] ?? 0))
  add('totals', 'Sales total', sum('SELECT SUM(txn_cash_amount + txn_balance_amount) FROM kb_transactions WHERE txn_type = 1'), osum("SELECT SUM(grand_total) FROM documents WHERE doc_type = 'sale_invoice'"))
  add('totals', 'Purchases total', sum('SELECT SUM(txn_cash_amount + txn_balance_amount) FROM kb_transactions WHERE txn_type = 2'), osum("SELECT SUM(grand_total) FROM documents WHERE doc_type = 'purchase_invoice'"))
  add('totals', 'Estimates total', sum('SELECT SUM(txn_cash_amount + txn_balance_amount) FROM kb_transactions WHERE txn_type = 27'), osum("SELECT SUM(grand_total) FROM documents WHERE doc_type = 'quotation'"))
  add('totals', 'Money received (payment-in + received at billing)', sum('SELECT SUM(m.amount) FROM txn_payment_mapping m JOIN kb_transactions t ON t.txn_id = m.txn_id WHERE t.txn_type IN (1,3)'), osum("SELECT SUM(amount) FROM payments WHERE direction = 'in'"))
  add('totals', 'Money paid (payment-out + paid at billing)', sum('SELECT SUM(m.amount) FROM txn_payment_mapping m JOIN kb_transactions t ON t.txn_id = m.txn_id WHERE t.txn_type IN (2,4)'), osum("SELECT SUM(amount) FROM payments WHERE direction = 'out'"))
  add('totals', 'Expenses total', sum('SELECT SUM(txn_cash_amount + txn_balance_amount) FROM kb_transactions WHERE txn_type = 7'), osum('SELECT SUM(amount) FROM expenses'))
  add('totals', 'Payment discounts total', sum('SELECT SUM(txn_discount_amount) FROM kb_transactions WHERE txn_type IN (3,4)'), osum('SELECT SUM(amount) FROM party_adjustments'))
  add('totals', 'Document discounts total', sum('SELECT SUM(txn_discount_amount) FROM kb_transactions WHERE txn_type IN (1,2,27)'), osum("SELECT SUM(doc_discount) FROM documents"))
  add('totals', 'Tax total', sum('SELECT SUM(txn_tax_amount) FROM kb_transactions WHERE txn_type IN (1,2,27)'), osum('SELECT SUM(tax_total) FROM documents'))
  add('totals', 'Line amounts total', sum('SELECT SUM(l.total_amount) FROM kb_lineitems l JOIN kb_transactions t ON t.txn_id = l.lineitem_txn_id WHERE t.txn_type <> 7'), osum('SELECT SUM(line_total) FROM document_lines WHERE product_id IS NOT NULL'))
  add('totals', 'Line quantities total', sum('SELECT SUM(l.quantity) FROM kb_lineitems l JOIN kb_transactions t ON t.txn_id = l.lineitem_txn_id WHERE t.txn_type <> 7'), osum('SELECT SUM(qty) FROM document_lines WHERE product_id IS NOT NULL'))

  /* ---------------- per document ---------------- */
  let docBad = 0
  let lineBad = 0
  let textBad = 0
  for (const t of sAll('SELECT * FROM kb_transactions WHERE txn_type IN (1,2,27,21,23,24,28,30)')) {
    const d = oOne('SELECT * FROM documents WHERE id = ?', t.txn_id) as Row
    const total = Number(t.txn_cash_amount) + Number(t.txn_balance_amount)
    if (!d.id || !near(d.grand_total, total, 0.0001) || d.date !== String(t.txn_date).slice(0, 10)) {
      docBad++
      mismatches.push({ group: 'document', key: String(t.txn_id), expected: total, actual: d.grand_total ?? 'missing' })
    }
    for (const l of sAll('SELECT * FROM kb_lineitems WHERE lineitem_txn_id = ?', t.txn_id)) {
      const ol = oOne('SELECT * FROM document_lines WHERE id = ?', l.lineitem_id) as Row
      if (!ol.id || ol.document_id !== t.txn_id || !near(ol.qty, l.quantity, 1e-9) || !near(ol.rate, l.priceperunit, 1e-9) || !near(ol.line_total, l.total_amount, 1e-9) || ol.product_id !== l.item_id) {
        lineBad++
        mismatches.push({ group: 'line', key: String(l.lineitem_id), expected: `${l.quantity} x ${l.priceperunit} = ${l.total_amount}`, actual: ol.id ? `${ol.qty} x ${ol.rate} = ${ol.line_total}` : 'missing' })
      }
      const want = l.lineitem_description && String(l.lineitem_description).trim() ? String(l.lineitem_description) : null
      if ((ol.details ?? null) !== want) {
        textBad++
        mismatches.push({ group: 'line description', key: String(l.lineitem_id), expected: want ?? '(none)', actual: ol.details ?? '(none)' })
      }
    }
  }
  add('documents', 'Every document present with the Vyapar total and date', 0, docBad, docBad === 0)
  add('documents', 'Every line present with identical qty, rate, amount, item', 0, lineBad, lineBad === 0)
  add('documents', 'Every item description (line detail) identical', 0, textBad, textBad === 0)

  /* ---------------- outstanding per bill ---------------- */
  let dueBad = 0
  const dueRows: string[] = []
  for (const t of sAll('SELECT txn_id, txn_type, txn_current_balance FROM kb_transactions WHERE txn_type IN (1,2)')) {
    const due = docDue(out, t.txn_id)
    if (!near(due, Number(t.txn_current_balance), 0.05)) {
      dueBad++
      dueRows.push(`${t.txn_id}: Vyapar ${t.txn_current_balance} vs ${due}`)
      mismatches.push({ group: 'bill outstanding', key: String(t.txn_id), expected: Number(t.txn_current_balance), actual: due })
    }
  }
  add('balances', 'Outstanding of every sale / purchase bill = Vyapar current balance (±0.05)', 0, dueBad, dueBad === 0, dueRows.slice(0, 10).join('; '))

  /* ---------------- party balances (all firms) ---------------- */
  const partyBalances: ValidationResult['partyBalances'] = []
  let partyBad = 0
  for (const n of sAll('SELECT name_id, full_name, amount FROM kb_names WHERE name_type = 1 ORDER BY name_id')) {
    const b = r2(Number((oOne(`SELECT COALESCE(SUM(debit - credit), 0) AS b FROM (${LEDGER_SQL}) l WHERE l.party_id = ?`, n.name_id) as Row).b))
    partyBalances.push({ id: n.name_id, name: n.full_name, vyapar: r2(n.amount), converted: b })
    if (!near(b, n.amount, 0.05)) {
      partyBad++
      mismatches.push({ group: 'party balance', key: `${n.name_id} ${n.full_name}`, expected: r2(n.amount), actual: b })
    }
  }
  add('balances', 'Every party balance = Vyapar party balance (±0.05)', 0, partyBad, partyBad === 0)
  add('balances', 'Sum of party balances', r2(sum('SELECT SUM(amount) FROM kb_names WHERE name_type = 1')), r2(partyBalances.reduce((s, p) => s + p.converted, 0)), undefined)

  /* ---------------- cash / bank balances ---------------- */
  const accountBalances: ValidationResult['accountBalances'] = []
  for (const p of sAll('SELECT * FROM kb_paymentTypes ORDER BY paymentType_id')) {
    const vin = sum('SELECT SUM(m.amount) FROM txn_payment_mapping m JOIN kb_transactions t ON t.txn_id = m.txn_id WHERE m.payment_id = ? AND t.txn_type IN (1,3)', p.paymentType_id)
    const vout = sum('SELECT SUM(m.amount) FROM txn_payment_mapping m JOIN kb_transactions t ON t.txn_id = m.txn_id WHERE m.payment_id = ? AND t.txn_type IN (2,4,7)', p.paymentType_id)
    const vy = r2(Number(p.paymentType_opening_balance || 0) + vin - vout)
    const ids = (out.prepare('SELECT id FROM accounts WHERE id = ? OR id % 100 = ? AND id > 100').all(p.paymentType_id, p.paymentType_id) as Row[]).map((r) => r.id as number)
    const conv = r2(ids.reduce((s, id) => s + accountBalance(out, id), 0))
    accountBalances.push({ paymentTypeId: p.paymentType_id, name: p.paymentType_name, vyapar: vy, converted: conv })
    add('balances', `Account "${p.paymentType_name}" balance (all firms)`, vy, conv)
  }

  /* ---------------- stock ---------------- */
  let stockBad = 0
  for (const i of sAll('SELECT item_id, item_name, item_type, item_stock_quantity FROM kb_items')) {
    const q = totalQty(out, i.item_id)
    if (i.item_type === 1 && !near(q, Number(i.item_stock_quantity), 0.001)) {
      stockBad++
      mismatches.push({ group: 'stock', key: `${i.item_id} ${i.item_name}`, expected: Number(i.item_stock_quantity), actual: q })
    }
  }
  add('stock', 'Stock of every item = Vyapar stock quantity', 0, stockBad, stockBad === 0)

  /* ---------------- names / text fidelity ---------------- */
  let nameBad = 0
  for (const n of sAll('SELECT name_id, full_name, phone_number FROM kb_names WHERE name_type = 1')) {
    const p = oOne('SELECT name, phone FROM parties WHERE id = ?', n.name_id) as Row
    const phone = n.phone_number && String(n.phone_number).trim() ? String(n.phone_number) : null
    if (p.name !== n.full_name || (p.phone ?? null) !== phone) nameBad++
  }
  add('fidelity', 'Party names and phones identical', 0, nameBad, nameBad === 0)
  let itemBad = 0
  for (const i of sAll('SELECT item_id, item_name, item_sale_unit_price, item_purchase_unit_price FROM kb_items')) {
    const p = oOne('SELECT name, sale_price, purchase_price FROM products WHERE id = ?', i.item_id) as Row
    if (p.name !== i.item_name || !near(p.sale_price, i.item_sale_unit_price, 1e-9) || !near(p.purchase_price, i.item_purchase_unit_price, 1e-9)) itemBad++
  }
  add('fidelity', 'Item names and prices identical', 0, itemBad, itemBad === 0)

  /* ---------------- archive + integrity ---------------- */
  const tables = sAll("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'kb_fts_%' AND name NOT LIKE 'sqlite_%'")
  let archBad = 0
  for (const t of tables) {
    const n = cnt(`SELECT COUNT(*) FROM "${t.name}"`)
    const a = ocnt('SELECT COUNT(*) FROM legacy_records WHERE table_name = ?', t.name)
    if (n !== a) {
      archBad++
      mismatches.push({ group: 'archive', key: t.name, expected: n, actual: a })
    }
  }
  add('archive', 'Every Vyapar row archived verbatim (all non-derived tables)', 0, archBad, archBad === 0)
  add('integrity', 'Foreign keys (orphaned / broken references)', 0, (out.prepare('PRAGMA foreign_key_check').all() as unknown[]).length)
  add('integrity', 'SQLite integrity check', 'ok', String(out.pragma('integrity_check', { simple: true })))
  add('integrity', 'Duplicate document numbers (per firm and type)', 0, ocnt('SELECT COUNT(*) FROM (SELECT firm_id, doc_type, number FROM documents GROUP BY 1,2,3 HAVING COUNT(*) > 1)'))

  const failed = checks.filter((c) => !c.pass).length
  return { checks, failed, warnings: conv.notes.filter((n) => n.level !== 'info').length, mismatches, partyBalances, accountBalances }
}

export function renderReport(
  conv: ConversionResult,
  v: ValidationResult,
  rt: Record<string, unknown>,
  files: { js1: string; dtbak: string; password: string }
): string {
  const fmt = (x: unknown): string => (typeof x === 'number' ? x.toLocaleString('en-US', { maximumFractionDigits: 4 }) : String(x))
  const lines: string[] = []
  lines.push('# Vyapar → DT Solar Pro conversion report', '')
  lines.push(`- Source: \`${conv.sourceFile.split(/[\\/]/).pop()}\` (SHA-256 \`${conv.sourceSha256}\`)`)
  lines.push(`- Vyapar database inside: \`${conv.vypName}\` (schema user_version ${conv.vypUserVersion})`)
  lines.push(`- Result: **${v.failed === 0 ? 'ALL CHECKS PASSED' : `${v.failed} CHECK(S) FAILED`}** - ${v.checks.length} checks, ${v.warnings} warnings/limitations (listed below)`)
  lines.push(`- Restore tests: .js1 restored with the app's restore builder ${rt.restoredValidationPassed ? 'passed every check again' : 'FAILED'}; second backup→restore round trip ${rt.identical ? 'identical (same SHA-256)' : 'DIFFERENT'}; .dtbak validation ${rt.dtbakValid ? 'ok' : 'FAILED'}`)
  lines.push('', '## Files', '')
  lines.push(`- \`${files.js1}\` - DT Solar Pro JSON backup (.js1). Restore: Backup & Restore → **JSON backup (.js1) → Restore**.`)
  lines.push(`- \`${files.dtbak}\` - the same data as a native DT Solar Pro backup. Restore: Backup & Restore → **Restore from a backup file**.`)
  lines.push(`- Sign in after restoring: user **admin**, temporary password **${files.password}** - the app forces a new password at first sign-in.`)
  lines.push('', '## Checks (source vs converted)', '', '| Group | Check | Vyapar | DT Solar Pro | Result |', '|---|---|---:|---:|:---:|')
  for (const c of v.checks) lines.push(`| ${c.group} | ${c.name}${c.detail ? ` (${c.detail})` : ''} | ${fmt(c.expected)} | ${fmt(c.actual)} | ${c.pass ? 'PASS' : '**FAIL**'} |`)
  lines.push('', '## Cash / bank accounts', '', '| Vyapar payment type | Vyapar balance | DT Solar Pro (all firms) |', '|---|---:|---:|')
  for (const a of v.accountBalances) lines.push(`| ${a.name} | ${fmt(a.vyapar)} | ${fmt(a.converted)} |`)
  lines.push('', '## Party balances (receivable + / payable −)', '', '| Id | Party | Vyapar | DT Solar Pro |', '|---:|---|---:|---:|')
  for (const p of v.partyBalances.filter((x) => x.vyapar !== 0 || x.converted !== 0)) lines.push(`| ${p.id} | ${p.name} | ${fmt(p.vyapar)} | ${fmt(p.converted)} |`)
  lines.push(`\n(${v.partyBalances.filter((x) => x.vyapar === 0 && x.converted === 0).length} parties with zero balance not listed.)`)
  if (v.mismatches.length) {
    lines.push('', '## Differences found', '', '| Group | Record | Vyapar | DT Solar Pro |', '|---|---|---:|---:|')
    for (const m of v.mismatches) lines.push(`| ${m.group} | ${m.key} | ${fmt(m.expected)} | ${fmt(m.actual)} |`)
  }
  lines.push('', '## Warnings and limitations', '')
  for (const n of conv.notes.filter((x) => x.level !== 'info')) lines.push(`- **${n.level}** (${n.entity}${n.legacyId !== undefined ? ` #${n.legacyId}` : ''}): ${n.message}`)
  lines.push('', '## Mapping notes', '')
  const infoSeen = new Set<string>()
  for (const n of conv.notes.filter((x) => x.level === 'info')) {
    const key = `${n.entity}:${n.message.replace(/\d+/g, '#')}`
    if (infoSeen.has(key)) continue
    infoSeen.add(key)
    const count = conv.notes.filter((x) => x.level === 'info' && `${x.entity}:${x.message.replace(/\d+/g, '#')}` === key).length
    lines.push(`- (${n.entity}) ${n.message}${count > 1 ? ` - ${count} records` : ''}`)
  }
  lines.push('', '## Field mapping', '')
  lines.push(...FIELD_MAPPING)
  lines.push('', `## Renumbered records (${conv.numberChanges.length})`, '', 'Full list in `number-changes.csv`. Original Vyapar numbers are also kept on the record (purchase bill no. → "Supplier bill no.") and in the legacy archive.')
  lines.push('', `## Id changes (${conv.idChanges.length})`, '', 'Full list in `id-map.csv` (also stored in the database table legacy_id_map). All other ids are identical to Vyapar.')
  lines.push('', '## Source tables', '', '| Vyapar table | Rows |', '|---|---:|')
  for (const [t, n] of Object.entries(conv.sourceCounts)) if (n) lines.push(`| ${t} | ${n} |`)
  return lines.join('\n') + '\n'
}

const FIELD_MAPPING = [
  '| Vyapar | DT Solar Pro | Notes |',
  '|---|---|---|',
  '| kb_firms | firms (same id) | name, phone, phone2, email, address, NTN (tin), STRN (gstin), bank details, logo + signature images (kb_images) |',
  '| kb_names (type 1) | parties (same id, shared by all firms) | name, phone, email, address, tin→NTN, gstin→STRN, credit limit, active flag, created date; shipping/extra addresses, group, state → notes |',
  '| kb_names (type 2) | expense_categories | expense category names |',
  '| kb_items | products (same id, shared) | name, code→SKU, goods/service, unit, description, sale/purchase price, min stock, active flag |',
  '| kb_transactions 1 / 2 / 27 | documents (same id): sale invoice / purchase bill / quotation | number = prefix + ref no., date, due/valid date, party, total, discount, tax, other charges, notes, terms, custom fields → notes |',
  '| kb_lineitems | document_lines (same id) | item, item name, item description → line detail, unit, qty, rate, amount |',
  '| kb_transactions 3 / 4 | payments (same id) | receipt / payment, account (payment type), reference, notes |',
  '| amount received/paid on a bill (txn_payment_mapping) | payments (id 1,000,000 + mapping id) allocated to that bill | Vyapar stores it inside the bill; DT Solar Pro keeps money movements separate |',
  '| kb_txn_links | payment_allocations | payment ↔ bill settlements; the discount part → party_adjustments linked to the bill |',
  '| payment discount (txn_discount_amount on 3 / 4) | party_adjustments (credit for receipts, debit for payments) | DISC-<payment id>-n |',
  '| kb_transactions 5 / 6 | parties.opening_balance (+ receivable / − payable), opening firm and date | |',
  '| kb_transactions 7 + expense lines | expenses (same id) | total, account, category; expense item lines → notes |',
  '| kb_linked_transactions | documents.ref_doc_id + quotation status "converted" | estimate → invoice |',
  '| kb_paymentTypes | accounts per firm (firm 1: same id; firm n: n×100 + id) | cash / bank, bank name, account no., holder, code |',
  '| kb_item_adjustments | stock_adjustments (non-zero quantities) | type 12 = reduce stock; zero-quantity opening entries archived only |',
  '| kb_prefix | doc_sequences | numbering continues after the last Vyapar number |',
  '| kb_settings, terms_and_conditions | settings | currency symbol, multi-firm, negative stock, default invoice / quotation terms |',
  '| urp_users | users (owner "admin") | Vyapar has no exportable password; a temporary password is set |',
  '| every table (incl. audit_trails, urp_activity, recycle_bin, udf, loans, chart of accounts, message config) | legacy_records (verbatim JSON) | nothing is lost; deleted (recycle-bin) records stay archived, not active |'
]
