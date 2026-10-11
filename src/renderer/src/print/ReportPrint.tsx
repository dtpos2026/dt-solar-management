/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * A4 report template + the shared report model used by the Reports page.
 *
 * Every report the Reports page offers is described once here (catalogue, data loading, columns, totals,
 * summary figures and notes) so the screen, the CSV export and the printed page always show the same numbers.
 * The Reports page opens this template with:
 *   api('print.open', { kind: 'report', id: 0, params: reportParams(key, options) })
 */
import { CSSProperties, Fragment, ReactNode, useEffect, useState } from 'react'
import { api } from '../api'
import { COST_HEAD_LABELS, DOC_TYPES, PROJECT_STATUS_LABELS } from '@shared/docTypes'
import { round2, round3 } from '@shared/money'
import { label as titleCase, statusTone } from '../lib/format'
import { Letterhead, PrintContext, PrintFooter, PrintTable, Sheet, Signatures, TemplateProps, pd, pm, pq } from './PrintKit'


/* ================================================================================================ */
/*                                       Report catalogue                                           */
/* ================================================================================================ */

export type ReportKey =
  | 'pl'
  | 'tax'
  | 'daybook'
  | 'cashbook'
  | 'sales'
  | 'item_profit'
  | 'purchases'
  | 'stock'
  | 'aging_customer'
  | 'aging_supplier'
  | 'balances_customer'
  | 'balances_supplier'
  | 'projects'
  | 'expenses'

export type GroupBy = 'document' | 'party' | 'product' | 'category' | 'month'
export type ReportGroup = 'Financial' | 'Sales' | 'Purchases' | 'Inventory' | 'Parties' | 'Projects' | 'Expenses'

export interface ReportDef {
  key: ReportKey
  group: ReportGroup
  title: string
  description: string
  /** All of these permissions are required to see the report */
  perms: string[]
  /** Date filter: a from/to range, a single "as of" date, or current position (none) */
  period: 'range' | 'asOf' | 'none'
  /** Supports the consolidated (all firms) scope */
  scope?: boolean
  groupBys?: Array<{ key: GroupBy; label: string }>
}

export const REPORT_GROUPS: ReportGroup[] = ['Financial', 'Sales', 'Purchases', 'Inventory', 'Parties', 'Projects', 'Expenses']

export const REPORTS: ReportDef[] = [
  {
    key: 'pl',
    group: 'Financial',
    title: 'Profit & Loss',
    description: 'Accrual-based income statement — net sales, cost of sales, gross profit, operating expenses and net profit for the period.',
    perms: ['reports.profit'],
    period: 'range',
    scope: true
  },
  {
    key: 'tax',
    group: 'Financial',
    title: 'Tax Summary',
    description: 'Sales tax charged on sales (output tax) and paid on purchases (input tax), document by document, with the net position.',
    perms: ['reports.view'],
    period: 'range'
  },
  {
    key: 'daybook',
    group: 'Financial',
    title: 'Day Book',
    description: 'Every entry recorded in the period — documents, receipts, payments, expenses, transfers, material and stock entries.',
    perms: ['reports.view'],
    period: 'range'
  },
  {
    key: 'cashbook',
    group: 'Financial',
    title: 'Cash / Bank Book',
    description: 'Money in and out of one cash or bank account with a running balance, opening and closing balance.',
    perms: ['accounts.view'],
    period: 'range'
  },
  {
    key: 'sales',
    group: 'Sales',
    title: 'Sales Register',
    description: 'Sales invoices less sales returns for the period. Amounts exclude cancelled documents; returns are shown as negative.',
    perms: ['reports.view', 'sales.view'],
    period: 'range',
    scope: true,
    groupBys: [
      { key: 'document', label: 'By invoice' },
      { key: 'party', label: 'By customer' },
      { key: 'product', label: 'By product' },
      { key: 'category', label: 'By category' },
      { key: 'month', label: 'By month' }
    ]
  },
  {
    key: 'item_profit',
    group: 'Sales',
    title: 'Item-wise Profit',
    description: 'Quantity sold, net sales, cost of goods sold and gross profit for every product and service.',
    perms: ['reports.view', 'sales.view', 'reports.profit'],
    period: 'range',
    scope: true
  },
  {
    key: 'purchases',
    group: 'Purchases',
    title: 'Purchase Register',
    description: 'Purchase bills less purchase returns for the period. Amounts exclude cancelled documents; returns are shown as negative.',
    perms: ['reports.view', 'purchases.view'],
    period: 'range',
    scope: true,
    groupBys: [
      { key: 'document', label: 'By bill' },
      { key: 'party', label: 'By supplier' },
      { key: 'product', label: 'By product' },
      { key: 'month', label: 'By month' }
    ]
  },
  {
    key: 'stock',
    group: 'Inventory',
    title: 'Stock Valuation',
    description: 'Quantity on hand and value of stock at average cost and at sale price.',
    perms: ['reports.view', 'inventory.view'],
    period: 'none'
  },
  {
    key: 'aging_customer',
    group: 'Parties',
    title: 'Receivables Aging',
    description: 'Unpaid customer invoices grouped by how many days they are past their due date.',
    perms: ['reports.view', 'customers.view'],
    period: 'asOf'
  },
  {
    key: 'aging_supplier',
    group: 'Parties',
    title: 'Payables Aging',
    description: 'Unpaid supplier bills grouped by how many days they are past their due date.',
    perms: ['reports.view', 'suppliers.view'],
    period: 'asOf'
  },
  {
    key: 'balances_customer',
    group: 'Parties',
    title: 'Customer Balances',
    description: 'Current ledger balance of every customer with an open balance (receivables and advances).',
    perms: ['reports.view', 'customers.view'],
    period: 'none'
  },
  {
    key: 'balances_supplier',
    group: 'Parties',
    title: 'Supplier Balances',
    description: 'Current ledger balance of every supplier with an open balance (payables and advances).',
    perms: ['reports.view', 'suppliers.view'],
    period: 'none'
  },
  {
    key: 'projects',
    group: 'Projects',
    title: 'Project Profitability',
    description: 'Side-by-side comparison of solar projects — revenue, direct cost, gross and net profit, margin, profit per kW and collections.',
    perms: ['projects.view', 'projects.financials'],
    period: 'range'
  },
  {
    key: 'expenses',
    group: 'Expenses',
    title: 'Expense Analysis',
    description: 'Expenses by category and by month, split between project (direct) costs and general overheads.',
    perms: ['expenses.view'],
    period: 'range'
  }
]

export function reportDef(key: string | null | undefined): ReportDef | undefined {
  return REPORTS.find((r) => r.key === key)
}

/* ================================================================================================ */
/*                                     Options & parameters                                         */
/* ================================================================================================ */

export interface ReportOptions {
  from: string
  to: string
  asOf: string
  scope: 'firm' | 'all'
  groupBy: GroupBy
  accountId: number | null
  warehouseId: number | null
  warehouseName: string
  includeZero: boolean
  /** projects: '' = any status */
  status: string
  /** projects: only projects whose start date falls inside from/to */
  datedOnly: boolean
}

function isoToday(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export function effectiveGroupBy(key: ReportKey, o: Pick<ReportOptions, 'groupBy'>): GroupBy {
  if (key === 'item_profit') return 'product'
  const def = reportDef(key)
  if (!def?.groupBys) return 'document'
  return def.groupBys.some((g) => g.key === o.groupBy) ? o.groupBy : def.groupBys[0].key
}

/** Only the options that matter for a report, as strings (print window URL params; also a cache signature). */
export function reportParams(key: ReportKey, o: ReportOptions): Record<string, string> {
  const def = reportDef(key)!
  const p: Record<string, string> = { report: key }
  if (def.period === 'range' && (key !== 'projects' || o.datedOnly)) {
    p.from = o.from
    p.to = o.to
  }
  if (def.period === 'asOf') p.asOf = o.asOf
  if (def.scope && o.scope === 'all') p.scope = 'all'
  if (def.groupBys) p.groupBy = effectiveGroupBy(key, o)
  if (key === 'cashbook' && o.accountId) p.accountId = String(o.accountId)
  if (key === 'stock') {
    if (o.warehouseId) {
      p.warehouseId = String(o.warehouseId)
      if (o.warehouseName) p.warehouseName = o.warehouseName
    }
    if (o.includeZero) p.includeZero = '1'
  }
  if (key === 'projects') {
    if (o.status) p.status = o.status
    if (o.datedOnly) p.datedOnly = '1'
  }
  return p
}

export function parseReportParams(params: Record<string, string>): { key: ReportKey | null; opts: ReportOptions } {
  const t = isoToday()
  const key = reportDef(params.report)?.key ?? null
  const opts: ReportOptions = {
    from: params.from || `${t.slice(0, 8)}01`,
    to: params.to || t,
    asOf: params.asOf || t,
    scope: params.scope === 'all' ? 'all' : 'firm',
    groupBy: (params.groupBy as GroupBy) || 'document',
    accountId: params.accountId ? Number(params.accountId) : null,
    warehouseId: params.warehouseId ? Number(params.warehouseId) : null,
    warehouseName: params.warehouseName ?? '',
    includeZero: params.includeZero === '1' || params.includeZero === 'true',
    status: params.status ?? '',
    datedOnly: params.datedOnly === '1' || params.datedOnly === 'true'
  }
  return { key, opts }
}

/** Fetch the raw data of a report. Returns null when a required choice is missing (cash book without account). */
export async function fetchReport(key: ReportKey, o: ReportOptions): Promise<any> {
  const { from, to, asOf, scope } = o
  switch (key) {
    case 'pl':
      return api('reports.pl', { from, to, scope })
    case 'tax':
      return api('reports.tax', { from, to })
    case 'daybook':
      return api('reports.daybook', { from, to })
    case 'cashbook':
      return o.accountId ? api('accounts.ledger', { id: o.accountId, from, to }) : null
    case 'sales':
    case 'item_profit':
      return api('reports.register', { side: 'sales', from, to, groupBy: effectiveGroupBy(key, o), scope })
    case 'purchases':
      return api('reports.register', { side: 'purchase', from, to, groupBy: effectiveGroupBy(key, o), scope })
    case 'stock':
      return api('stock.report', { warehouseId: o.warehouseId ?? undefined, includeZero: o.includeZero })
    case 'aging_customer':
      return api('parties.aging', { side: 'customer', asOf })
    case 'aging_supplier':
      return api('parties.aging', { side: 'supplier', asOf })
    case 'balances_customer':
      return api('parties.list', { type: 'customer', onlyDue: true, active: 'all' })
    case 'balances_supplier':
      return api('parties.list', { type: 'supplier', onlyDue: true, active: 'all' })
    case 'projects':
      return api('projects.profitReport', { status: o.status || undefined, from: o.datedOnly ? from : undefined, to: o.datedOnly ? to : undefined })
    case 'expenses':
      return api('reports.expenses', { from, to })
  }
}

/* ================================================================================================ */
/*                                        Report model                                              */
/* ================================================================================================ */

export type CellType = 'text' | 'money' | 'qty' | 'pct' | 'int' | 'date' | 'month'
export type Tone = 'ok' | 'warn' | 'bad' | 'info' | 'brand' | 'muted'

export interface RCol {
  key: string
  label: string
  type?: CellType
  /** Raw value (sorting, searching, CSV). Defaults to row[key]. */
  get?: (r: any) => any
  /** Secondary line under the value (screen & print, not exported) */
  sub?: (r: any) => string | null | undefined
  /** Unit text after a quantity */
  unit?: (r: any) => string | null | undefined
  /** Show negative numbers in red */
  signed?: boolean
  /** Render as a badge on screen */
  badge?: (r: any) => Tone
  /** Emphasise (bold) */
  strong?: boolean
  /** Keep on one line (codes, document numbers) */
  nowrap?: boolean
}

export interface RTable {
  columns: RCol[]
  rows: any[]
  totals?: Record<string, number | string | null> | null
  totalLabel?: string
  /** Keep the given row order (no sorting / searching on screen) — e.g. a running-balance book */
  fixedOrder?: boolean
  /** Rows that are informational (opening balance) and must be styled differently */
  isSpecial?: (r: any) => boolean
  /** Rows that are cancelled (struck through) */
  isMuted?: (r: any) => boolean
  /** Narrower column set for the A4 page (same data, some columns folded into sub-lines). Totals use the same keys. */
  printColumns?: RCol[]
}

export interface RSection {
  id: string
  title?: string
  table: RTable
  /** Include in the main CSV export (default true). Sections excluded get their own export button on screen. */
  csv?: boolean
  /** Print only (hidden on screen) or screen only */
  screen?: boolean
  print?: boolean
}

export interface RSummary {
  label: string
  value: number | null
  type: 'money' | 'pct' | 'int' | 'qty'
  tone?: 'brand' | 'ok' | 'warn' | 'bad' | 'info' | 'sun'
  sub?: string
  negativeBad?: boolean
}

export interface PlLine {
  kind: 'section' | 'item' | 'detail' | 'subtotal' | 'total' | 'grand'
  label: string
  amount?: number | null
  pct?: number | null
  /** A deduction — printed in brackets */
  less?: boolean
}

export interface ReportModel {
  title: string
  subtitle?: string
  summary: RSummary[]
  sections: RSection[]
  notes: string[]
  pl?: { statement: PlLine[]; memo: PlLine[]; figures: any; perFirm: any[] }
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
export function monthLabel(ym: string | null | undefined): string {
  if (!ym) return '—'
  const [y, m] = String(ym).split('-')
  return y && m ? `${MONTHS[Number(m) - 1] ?? m} ${y}` : String(ym)
}

const KIND_LABELS: Record<string, string> = {
  receipt: 'Receipt',
  payment: 'Payment',
  expense: 'Expense',
  transfer: 'Transfer',
  transfer_in: 'Transfer in',
  transfer_out: 'Transfer out',
  material_issue: 'Material issue',
  material_return: 'Material return',
  stock_adjustment: 'Stock adjustment',
  stock_opening: 'Opening stock',
  stock_transfer: 'Stock transfer'
}
export function kindLabel(k: string | null | undefined): string {
  if (!k) return '—'
  return KIND_LABELS[k] ?? DOC_TYPES[k as keyof typeof DOC_TYPES]?.label ?? titleCase(k)
}
export function kindTone(k: string): Tone {
  if (k === 'sale_invoice' || k === 'receipt' || k === 'transfer_in') return 'ok'
  if (k === 'purchase_invoice') return 'info'
  if (k === 'payment' || k === 'expense' || k === 'transfer_out') return 'bad'
  if (k.endsWith('_return')) return 'warn'
  if (k === 'quotation' || k === 'sale_order' || k === 'purchase_order' || k === 'delivery_challan') return 'brand'
  return 'muted'
}

const sumBy = (rows: any[], f: (r: any) => number): number => round2(rows.reduce((a, r) => a + (Number(f(r)) || 0), 0))
const pctOf = (part: number, whole: number): number | null => (whole > 0 ? round2((part / whole) * 100) : null)

export function rawValue(c: RCol, r: any): any {
  return c.get ? c.get(r) : r?.[c.key]
}

export function isNumeric(c: RCol): boolean {
  return c.type === 'money' || c.type === 'qty' || c.type === 'pct' || c.type === 'int'
}

/** Number of leading columns the totals label may span (columns before the first one that carries a total). */
export function totalsLead(t: RTable): number {
  const tot = t.totals ?? {}
  const i = t.columns.findIndex((c, idx) => idx > 0 && tot[c.key] !== undefined)
  return i === -1 ? t.columns.length : i
}

/** Accounting display of a P&L amount: deductions and negatives in brackets. */
export function plDisplay(l: PlLine, fmt: (n: number) => string): string {
  if (l.amount === undefined || l.amount === null) return ''
  const v = Number(l.amount)
  if (Math.abs(v) < 0.005) return fmt(0)
  if (l.less || v < 0) return `(${fmt(Math.abs(v))})`
  return fmt(v)
}

/* ------------------------------------------ P&L ------------------------------------------------ */

export function plLines(f: any): { statement: PlLine[]; memo: PlLine[] } {
  const rev = Number(f.revenue) || 0
  const p = (v: number): number | null => pctOf(v, rev)
  const statement: PlLine[] = [
    { kind: 'section', label: 'Revenue' },
    { kind: 'item', label: 'Gross sales (excluding sales tax)', amount: f.salesGross },
    { kind: 'item', label: 'Less: sales returns / credit notes', amount: f.salesReturns, less: true },
    { kind: 'subtotal', label: 'Net sales', amount: f.revenue, pct: rev > 0 ? 100 : null },
    { kind: 'section', label: 'Cost of sales' },
    { kind: 'item', label: 'Cost of stock items invoiced (COGS)', amount: f.cogs, pct: p(f.cogs) },
    { kind: 'item', label: 'Materials issued to projects (net of returns)', amount: f.projectMaterialIssues, pct: p(f.projectMaterialIssues) },
    { kind: 'item', label: 'Direct-to-site project purchases', amount: f.directProjectPurchases, pct: p(f.directProjectPurchases) },
    { kind: 'item', label: 'Direct expenses', amount: f.directExpenses, pct: p(f.directExpenses) },
    ...((f.directByHead ?? []) as Array<{ head: string; amount: number }>).map(
      (h): PlLine => ({ kind: 'detail', label: COST_HEAD_LABELS[h.head as keyof typeof COST_HEAD_LABELS] ?? titleCase(h.head), amount: h.amount, pct: p(h.amount) })
    ),
    { kind: 'subtotal', label: 'Total cost of sales', amount: f.costOfSales, pct: p(f.costOfSales) },
    { kind: 'total', label: f.grossProfit < 0 ? 'Gross loss' : 'Gross profit', amount: f.grossProfit, pct: f.grossMarginPct },
    { kind: 'section', label: 'Operating expenses (overheads)' },
    ...(f.operatingByCategory?.length
      ? (f.operatingByCategory as Array<{ name: string; amount: number }>).map((c): PlLine => ({ kind: 'item', label: c.name, amount: c.amount, pct: p(c.amount) }))
      : [{ kind: 'item', label: 'No operating expenses recorded', amount: 0 } as PlLine]),
    { kind: 'subtotal', label: 'Total operating expenses', amount: f.operatingExpenses, pct: p(f.operatingExpenses) },
    { kind: 'section', label: 'Other items' },
    { kind: 'item', label: 'Stock adjustments — gain / (loss) from stock counts', amount: f.stockAdjustments, pct: p(f.stockAdjustments) },
    { kind: 'grand', label: f.netProfit < 0 ? 'Net loss' : 'Net profit', amount: f.netProfit, pct: f.netMarginPct }
  ]
  const memo: PlLine[] = [
    { kind: 'item', label: 'Purchases into stock, net of returns (inventory asset — not an expense)', amount: f.purchases },
    { kind: 'item', label: 'Sales tax collected on sales (output tax)', amount: f.taxCollected },
    { kind: 'item', label: 'Sales tax paid on purchases (input tax)', amount: f.taxPaid },
    { kind: 'subtotal', label: 'Net sales tax position (output − input)', amount: round2((Number(f.taxCollected) || 0) - (Number(f.taxPaid) || 0)) }
  ]
  return { statement, memo }
}

export const PL_NOTE =
  'Profit is calculated on an accrual basis, not on cash: sales count when invoiced (excluding sales tax) and costs count when goods are sold or issued to a project, ' +
  'or when an expense is recorded — not when money is received or paid. Purchases into stock are an inventory asset until sold or issued, so they appear only as a memo line.'

/* ---------------------------------------- builders --------------------------------------------- */

export function reportSubtitle(key: ReportKey, o: ReportOptions): string | undefined {
  const def = reportDef(key)
  if (def?.groupBys) return def.groupBys.find((g) => g.key === effectiveGroupBy(key, o))?.label
  return undefined
}

/** Human readable period (screen & print). */
export function periodText(key: ReportKey, o: ReportOptions, fmt: (d: string) => string): string {
  const def = reportDef(key)!
  if (def.period === 'asOf') return `As of ${fmt(o.asOf)}`
  if (def.period === 'none') return `As of ${fmt(isoToday())}`
  if (key === 'projects' && !o.datedOnly) return 'All projects (any start date)'
  return `${fmt(o.from)} to ${fmt(o.to)}`
}

/** Window / PDF file name: "<Report name> <from> to <to>". */
export function reportFileTitle(key: ReportKey, o: ReportOptions, data?: any): string {
  const def = reportDef(key)!
  const sub = reportSubtitle(key, o)
  let name = def.title.replace(/\s*&\s*/g, ' and ').replace(/\s*\/\s*/g, '-')
  if (sub) name += ` ${sub.toLowerCase()}`
  if (key === 'cashbook' && data?.account?.name) name += ` - ${String(data.account.name)}`
  if (key === 'stock' && o.warehouseName) name += ` - ${o.warehouseName}`
  if (o.scope === 'all' && def.scope) name += ' (all firms)'
  if (def.period === 'asOf') return `${name} as of ${o.asOf}`
  if (def.period === 'none') return `${name} ${isoToday()}`
  if (key === 'projects' && !o.datedOnly) return `${name} ${isoToday()}`
  return `${name} ${o.from} to ${o.to}`
}

function registerModel(key: ReportKey, data: any, o: ReportOptions): Pick<ReportModel, 'summary' | 'sections' | 'notes'> {
  const isSales = key !== 'purchases'
  const gb = effectiveGroupBy(key, o)
  const ret = isSales ? 'sale_return' : 'purchase_return'
  const rows: any[] = data.rows ?? []
  const t = data.totals ?? {}
  const showProfit = !!data.showProfit
  const partyLabel = isSales ? 'Customer' : 'Supplier'
  const countLabel = isSales ? 'Invoices' : 'Bills'
  const cols: RCol[] = []
  if (gb === 'document') {
    cols.push(
      { key: 'date', label: 'Date', type: 'date' },
      { key: 'number', label: 'Number', strong: true, nowrap: true, sub: (r) => (r.doc_type === ret ? 'Return' : null) },
      { key: 'party_name', label: partyLabel, get: (r) => r.party_name ?? (isSales ? 'Walk-in customer' : '—') },
      { key: 'project_name', label: 'Project' }
    )
  } else if (gb === 'party') {
    cols.push({ key: 'name', label: partyLabel, strong: true }, { key: 'count', label: countLabel, type: 'int' })
  } else if (gb === 'month') {
    cols.push({ key: 'name', label: 'Month', type: 'month', strong: true }, { key: 'count', label: countLabel, type: 'int' })
  } else if (gb === 'product') {
    cols.push({ key: 'name', label: 'Product / service', strong: true }, { key: 'qty', label: 'Qty', type: 'qty', unit: (r) => r.unit })
  } else {
    cols.push({ key: 'name', label: 'Category', strong: true }, { key: 'qty', label: 'Qty', type: 'qty' })
  }
  const totals: Record<string, number | null> = {}
  if (key === 'item_profit') {
    cols.push(
      { key: 'avg_price', label: 'Avg price', type: 'money', get: (r) => (Math.abs(Number(r.qty)) > 0.0005 ? round2(Number(r.net) / Number(r.qty)) : null) },
      { key: 'net', label: 'Net sales', type: 'money', signed: true },
      { key: 'cost', label: 'Cost of sales', type: 'money', signed: true },
      { key: 'profit', label: 'Gross profit', type: 'money', signed: true, strong: true },
      { key: 'margin', label: 'Margin', type: 'pct', signed: true }
    )
    Object.assign(totals, { net: t.net, cost: t.cost, profit: t.profit, margin: pctOf(Number(t.profit) || 0, Number(t.net) || 0) })
  } else {
    cols.push(
      { key: 'net', label: 'Net (excl. tax)', type: 'money', signed: true },
      { key: 'tax', label: 'Tax', type: 'money', signed: true },
      { key: 'total', label: 'Total', type: 'money', signed: true, strong: true }
    )
    Object.assign(totals, { net: t.net, tax: t.tax, total: t.total })
    if (showProfit) {
      cols.push(
        { key: 'cost', label: 'Cost', type: 'money', signed: true },
        { key: 'profit', label: 'Profit', type: 'money', signed: true },
        { key: 'margin', label: 'Margin', type: 'pct', signed: true }
      )
      Object.assign(totals, { cost: t.cost, profit: t.profit, margin: pctOf(Number(t.profit) || 0, Number(t.net) || 0) })
    }
  }
  if (gb === 'party' || gb === 'month') totals.count = sumBy(rows, (r) => r.count)

  const docCount = gb === 'document' ? rows.filter((r) => r.doc_type !== ret).length : gb === 'party' || gb === 'month' ? totals.count : null
  const summary: RSummary[] =
    key === 'item_profit'
      ? [
          { label: 'Net sales', value: t.net, type: 'money', tone: 'brand' },
          { label: 'Cost of sales', value: t.cost, type: 'money', tone: 'warn' },
          { label: 'Gross profit', value: t.profit, type: 'money', tone: (t.profit ?? 0) < 0 ? 'bad' : 'ok', negativeBad: true },
          { label: 'Gross margin', value: pctOf(Number(t.profit) || 0, Number(t.net) || 0), type: 'pct', tone: 'sun', sub: `${rows.length} item(s)` }
        ]
      : [
          { label: isSales ? 'Net sales (excl. tax)' : 'Net purchases (excl. tax)', value: t.net, type: 'money', tone: 'brand' },
          { label: isSales ? 'Sales tax charged' : 'Sales tax paid', value: t.tax, type: 'money', tone: 'info' },
          { label: 'Total incl. tax', value: t.total, type: 'money', tone: 'sun' },
          showProfit
            ? { label: 'Gross profit', value: t.profit, type: 'money', tone: (t.profit ?? 0) < 0 ? 'bad' : 'ok', negativeBad: true, sub: `Margin ${fmtPct(pctOf(Number(t.profit) || 0, Number(t.net) || 0))}` }
            : docCount !== null
              ? { label: isSales ? 'Invoices' : 'Bills', value: docCount, type: 'int', tone: 'ok' }
              : { label: gb === 'product' ? 'Products' : 'Categories', value: rows.length, type: 'int', tone: 'ok' }
        ]
  const notes: string[] = []
  if (data.note) notes.push(String(data.note))
  if (gb === 'product') notes.push('Quantities are net of returns and shown in each product’s own unit; they are not added together.')
  if (gb === 'category') notes.push('Quantities are net of returns. A category quantity adds up all units in it (pieces, metres, etc.), so treat it as indicative only.')
  return {
    summary,
    sections: [{ id: 'main', table: { columns: cols, rows, totals, totalLabel: `Total (${rows.length} ${rows.length === 1 ? 'row' : 'rows'})` } }],
    notes
  }
}

function fmtPct(n: number | null | undefined): string {
  return n === null || n === undefined ? '—' : `${round2(n).toFixed(1)}%`
}

/** Build everything a report shows from its raw data. */
export function buildReportModel(key: ReportKey, data: any, o: ReportOptions): ReportModel {
  const def = reportDef(key)!
  const base = { title: def.title, subtitle: reportSubtitle(key, o) }
  switch (key) {
    case 'pl': {
      const f = data.figures
      const { statement, memo } = plLines(f)
      const perFirm: any[] = data.perFirm ?? []
      const sections: RSection[] = []
      if (perFirm.length > 0) {
        sections.push({
          id: 'perFirm',
          title: 'Comparison by firm',
          csv: false,
          table: {
            columns: [
              { key: 'firmName', label: 'Firm', strong: true },
              { key: 'revenue', label: 'Net sales', type: 'money' },
              { key: 'costOfSales', label: 'Cost of sales', type: 'money' },
              { key: 'grossProfit', label: 'Gross profit', type: 'money', signed: true },
              { key: 'grossMarginPct', label: 'GM %', type: 'pct', signed: true },
              { key: 'operatingExpenses', label: 'Operating exp.', type: 'money' },
              { key: 'stockAdjustments', label: 'Stock adj.', type: 'money', signed: true },
              { key: 'netProfit', label: 'Net profit', type: 'money', signed: true, strong: true },
              { key: 'netMarginPct', label: 'NM %', type: 'pct', signed: true }
            ],
            rows: perFirm,
            totals: {
              revenue: f.revenue,
              costOfSales: f.costOfSales,
              grossProfit: f.grossProfit,
              grossMarginPct: f.grossMarginPct,
              operatingExpenses: f.operatingExpenses,
              stockAdjustments: f.stockAdjustments,
              netProfit: f.netProfit,
              netMarginPct: f.netMarginPct
            },
            totalLabel: 'Consolidated'
          }
        })
      }
      return {
        ...base,
        summary: [
          { label: 'Net sales', value: f.revenue, type: 'money', tone: 'brand', sub: f.salesReturns > 0 ? 'after sales returns' : 'excluding sales tax' },
          { label: f.grossProfit < 0 ? 'Gross loss' : 'Gross profit', value: f.grossProfit, type: 'money', tone: f.grossProfit < 0 ? 'bad' : 'sun', negativeBad: true, sub: `Margin ${fmtPct(f.grossMarginPct)}` },
          { label: 'Operating expenses', value: f.operatingExpenses, type: 'money', tone: 'warn', sub: `${fmtPct(pctOf(f.operatingExpenses, f.revenue))} of sales` },
          { label: f.netProfit < 0 ? 'Net loss' : 'Net profit', value: f.netProfit, type: 'money', tone: f.netProfit < 0 ? 'bad' : 'ok', negativeBad: true, sub: `Margin ${fmtPct(f.netMarginPct)}` }
        ],
        sections,
        notes: [PL_NOTE],
        pl: { statement, memo, figures: f, perFirm }
      }
    }

    case 'tax': {
      const rows: any[] = (data.rows ?? []).map((r: any) => {
        const s = String(r.doc_type).endsWith('_return') ? -1 : 1
        return { ...r, net: round2(s * r.net_total), tax: round2(s * r.tax_total), total: round2(s * r.grand_total) }
      })
      const typeName: Record<string, string> = { sale_invoice: 'Invoice', sale_return: 'Credit note', purchase_invoice: 'Bill', purchase_return: 'Debit note' }
      const cols: RCol[] = [
        { key: 'date', label: 'Date', type: 'date' },
        { key: 'number', label: 'Number', strong: true, nowrap: true },
        { key: 'doc_type', label: 'Type', get: (r) => typeName[r.doc_type] ?? kindLabel(r.doc_type), badge: (r) => (String(r.doc_type).endsWith('_return') ? 'warn' : 'muted') },
        { key: 'party_name', label: 'Party' },
        { key: 'ntn', label: 'NTN / STRN', get: (r) => [r.ntn && `NTN ${r.ntn}`, r.strn && `STRN ${r.strn}`].filter(Boolean).join(' · ') || null },
        { key: 'net', label: 'Value excl. tax', type: 'money', signed: true },
        { key: 'tax', label: 'Sales tax', type: 'money', signed: true, strong: true },
        { key: 'total', label: 'Value incl. tax', type: 'money', signed: true }
      ]
      const out = rows.filter((r) => String(r.doc_type).startsWith('sale'))
      const inp = rows.filter((r) => String(r.doc_type).startsWith('purchase'))
      const tot = (rs: any[]): Record<string, number> => ({ net: sumBy(rs, (r) => r.net), tax: sumBy(rs, (r) => r.tax), total: sumBy(rs, (r) => r.total) })
      const net = Number(data.net) || 0
      return {
        ...base,
        summary: [
          { label: 'Output tax (on sales)', value: data.outputTax, type: 'money', tone: 'brand', sub: `${out.length} document(s)` },
          { label: 'Input tax (on purchases)', value: data.inputTax, type: 'money', tone: 'info', sub: `${inp.length} document(s)` },
          { label: net >= 0 ? 'Net tax payable' : 'Net tax refundable', value: Math.abs(net), type: 'money', tone: net >= 0 ? 'warn' : 'ok', sub: 'output − input' }
        ],
        sections: [
          { id: 'output', title: 'Output tax — sales invoices & credit notes', table: { columns: cols, rows: out, totals: tot(out), totalLabel: 'Total output tax' } },
          { id: 'input', title: 'Input tax — purchase bills & debit notes', table: { columns: cols, rows: inp, totals: tot(inp), totalLabel: 'Total input tax' } }
        ],
        notes: ['Only documents that carry sales tax are listed. Credit notes and debit notes reduce the tax of their side. Cancelled documents are excluded.']
      }
    }

    case 'daybook': {
      const rows: any[] = Array.isArray(data) ? data : []
      const live = rows.filter((r) => r.status !== 'cancelled')
      const byKind = new Map<string, { kind: string; count: number; amount: number }>()
      for (const r of live) {
        const e = byKind.get(r.kind) ?? { kind: r.kind, count: 0, amount: 0 }
        e.count += 1
        e.amount = round2(e.amount + (Number(r.amount) || 0))
        byKind.set(r.kind, e)
      }
      const kindSum = (k: string): number => byKind.get(k)?.amount ?? 0
      return {
        ...base,
        summary: [
          { label: 'Sales invoiced', value: kindSum('sale_invoice'), type: 'money', tone: 'brand', sub: `${byKind.get('sale_invoice')?.count ?? 0} invoice(s)` },
          { label: 'Purchases billed', value: kindSum('purchase_invoice'), type: 'money', tone: 'info', sub: `${byKind.get('purchase_invoice')?.count ?? 0} bill(s)` },
          { label: 'Money received', value: kindSum('receipt'), type: 'money', tone: 'ok', sub: `${byKind.get('receipt')?.count ?? 0} receipt(s)` },
          { label: 'Payments & expenses', value: round2(kindSum('payment') + kindSum('expense')), type: 'money', tone: 'warn', sub: `${(byKind.get('payment')?.count ?? 0) + (byKind.get('expense')?.count ?? 0)} entr(ies)` }
        ],
        sections: [
          {
            id: 'byType',
            title: 'Summary by type',
            csv: false,
            table: {
              columns: [
                { key: 'kind', label: 'Type', get: (r) => kindLabel(r.kind), badge: (r) => kindTone(r.kind) },
                { key: 'count', label: 'Entries', type: 'int' },
                { key: 'amount', label: 'Amount', type: 'money', strong: true }
              ],
              rows: Array.from(byKind.values()).sort((a, b) => b.amount - a.amount)
            }
          },
          {
            id: 'entries',
            title: 'Transactions',
            table: {
              columns: [
                { key: 'date', label: 'Date', type: 'date' },
                { key: 'kind', label: 'Type', get: (r) => kindLabel(r.kind), badge: (r) => kindTone(r.kind) },
                { key: 'number', label: 'Number', strong: true, nowrap: true },
                { key: 'party', label: 'Party / details' },
                { key: 'amount', label: 'Amount', type: 'money' },
                { key: 'status', label: 'Status', get: (r) => titleCase(r.status), badge: (r) => statusTone(r.status) as Tone }
              ],
              rows,
              isMuted: (r) => r.status === 'cancelled',
              totalLabel: `${rows.length} entr${rows.length === 1 ? 'y' : 'ies'}${rows.length >= 5000 ? ' (first 5,000 shown)' : ''} · ${rows.length - live.length} cancelled`,
              totals: {}
            }
          }
        ],
        notes: ['The day book lists everything entered in the period, including quotations, orders and cancelled entries (struck through). Summary figures exclude cancelled entries.']
      }
    }

    case 'cashbook': {
      const rows: any[] = data.rows ?? []
      const acc = data.account ?? {}
      const all = [{ _opening: true, date: o.from, kind: 'opening', description: 'Opening balance', balance: data.opening }, ...rows]
      return {
        ...base,
        subtitle: acc.name ? `${acc.name}${acc.type ? ` · ${titleCase(acc.type)}` : ''}` : undefined,
        summary: [
          { label: 'Opening balance', value: data.opening, type: 'money', tone: 'info', negativeBad: true },
          { label: 'Money in', value: data.totalIn, type: 'money', tone: 'ok', sub: `${rows.filter((r) => r.money_in > 0).length} entr(ies)` },
          { label: 'Money out', value: data.totalOut, type: 'money', tone: 'bad', sub: `${rows.filter((r) => r.money_out > 0).length} entr(ies)` },
          { label: 'Closing balance', value: data.closing, type: 'money', tone: 'brand', negativeBad: true }
        ],
        sections: [
          {
            id: 'book',
            table: {
              columns: [
                { key: 'date', label: 'Date', type: 'date' },
                { key: 'number', label: 'Number', strong: true, nowrap: true },
                { key: 'kind', label: 'Type', get: (r) => (r._opening ? '' : kindLabel(r.kind)), badge: (r) => kindTone(r.kind) },
                { key: 'description', label: 'Description' },
                { key: 'money_in', label: 'Money in', type: 'money', get: (r) => (r._opening ? null : r.money_in || null) },
                { key: 'money_out', label: 'Money out', type: 'money', get: (r) => (r._opening ? null : r.money_out || null) },
                { key: 'balance', label: 'Balance', type: 'money', signed: true, strong: true }
              ],
              rows: all,
              fixedOrder: true,
              isSpecial: (r) => !!r._opening,
              totals: { money_in: data.totalIn, money_out: data.totalOut, balance: data.closing },
              totalLabel: 'Totals / closing balance'
            }
          }
        ],
        notes: ['Cash and bank movements come from receipts, payments, paid expenses and transfers. Cancelled entries are excluded.']
      }
    }

    case 'sales':
    case 'item_profit':
    case 'purchases':
      return { ...base, ...registerModel(key, data, o) }

    case 'stock': {
      const rows: any[] = data.rows ?? []
      const showCost = data.totalValue !== null && data.totalValue !== undefined
      const cols: RCol[] = [
        { key: 'name', label: 'Product', strong: true, sub: (r) => r.sku },
        { key: 'category_name', label: 'Category' },
        { key: 'qty', label: 'Quantity', type: 'qty', unit: (r) => r.unit, signed: true }
      ]
      if (showCost) cols.push({ key: 'avg_cost', label: 'Avg cost', type: 'money' }, { key: 'value', label: 'Value at cost', type: 'money', strong: true })
      cols.push({ key: 'sale_price', label: 'Sale price', type: 'money' }, { key: 'sale_value', label: 'Value at sale price', type: 'money' })
      const potential = showCost ? round2(Number(data.totalSaleValue) - Number(data.totalValue)) : null
      return {
        ...base,
        subtitle: o.warehouseName || (o.warehouseId ? 'Selected warehouse' : 'All warehouses'),
        summary: [
          { label: 'Stock items', value: rows.length, type: 'int', tone: 'info', sub: `${rows.filter((r) => r.qty <= 0).length} at or below zero` },
          ...(showCost ? [{ label: 'Stock value at cost', value: data.totalValue, type: 'money', tone: 'brand' } as RSummary] : []),
          { label: 'Value at sale price', value: data.totalSaleValue, type: 'money', tone: 'sun' },
          ...(showCost ? [{ label: 'Potential gross margin', value: potential, type: 'money', tone: 'ok', sub: fmtPct(pctOf(potential ?? 0, Number(data.totalSaleValue) || 0)) } as RSummary] : [])
        ],
        sections: [{ id: 'stock', table: { columns: cols, rows, totals: { value: showCost ? data.totalValue : null, sale_value: data.totalSaleValue }, totalLabel: `Total (${rows.length} items)` } }],
        notes: [
          `Valuation method: ${data.method ?? 'Moving weighted average cost'}. Items with negative stock are valued at zero.`,
          ...(showCost ? [] : ['Cost values are hidden because your role cannot see purchase cost.'])
        ]
      }
    }

    case 'aging_customer':
    case 'aging_supplier': {
      const rows: any[] = Array.isArray(data) ? data : []
      const cust = key === 'aging_customer'
      const totals = {
        current: sumBy(rows, (r) => r.current),
        d30: sumBy(rows, (r) => r.d30),
        d60: sumBy(rows, (r) => r.d60),
        d90: sumBy(rows, (r) => r.d90),
        over90: sumBy(rows, (r) => r.over90),
        total: sumBy(rows, (r) => r.total)
      }
      const overdue = round2(totals.d30 + totals.d60 + totals.d90 + totals.over90)
      return {
        ...base,
        summary: [
          { label: cust ? 'Total receivable' : 'Total payable', value: totals.total, type: 'money', tone: 'brand', sub: `${rows.length} ${cust ? 'customer' : 'supplier'}(s)` },
          { label: 'Current (not yet due)', value: totals.current, type: 'money', tone: 'ok' },
          { label: 'Overdue', value: overdue, type: 'money', tone: 'warn', sub: fmtPct(pctOf(overdue, totals.total)) + ' of total' },
          { label: 'Over 90 days', value: totals.over90, type: 'money', tone: 'bad' }
        ],
        sections: [
          {
            id: 'aging',
            table: {
              columns: [
                { key: 'party_name', label: cust ? 'Customer' : 'Supplier', strong: true, sub: (r) => r.phone },
                { key: 'current', label: 'Current', type: 'money' },
                { key: 'd30', label: '1–30 days', type: 'money' },
                { key: 'd60', label: '31–60 days', type: 'money' },
                { key: 'd90', label: '61–90 days', type: 'money' },
                { key: 'over90', label: '90+ days', type: 'money', signed: true },
                { key: 'total', label: 'Total due', type: 'money', strong: true }
              ],
              rows,
              totals,
              totalLabel: 'Total'
            }
          }
        ],
        notes: [
          `Ages are counted from each ${cust ? 'invoice' : 'bill'}'s due date (or its date when no due date is set) to ${pd(o.asOf)}. ` +
            `Only unpaid ${cust ? 'invoices' : 'bills'} are included — opening balances, unallocated advances and journal adjustments are not; see ${cust ? 'Customer' : 'Supplier'} Balances for full ledger balances.`
        ]
      }
    }

    case 'balances_customer':
    case 'balances_supplier': {
      const cust = key === 'balances_customer'
      const rows: any[] = Array.isArray(data) ? data : []
      // Positive balance = the party owes us; negative = we owe the party.
      const owesUs = (r: any): number => (r.balance > 0 ? round2(r.balance) : 0)
      const weOwe = (r: any): number => (r.balance < 0 ? round2(-r.balance) : 0)
      const a = sumBy(rows, owesUs)
      const b = sumBy(rows, weOwe)
      const cols: RCol[] = [
        { key: 'name', label: cust ? 'Customer' : 'Supplier', strong: true, sub: (r) => r.contact_person },
        { key: 'phone', label: 'Phone' },
        { key: 'city', label: 'City' },
        { key: 'last_date', label: 'Last activity', type: 'date' }
      ]
      if (cust) {
        cols.push(
          { key: 'credit_limit', label: 'Credit limit', type: 'money', get: (r) => (r.credit_limit > 0 ? r.credit_limit : null) },
          { key: 'owes_us', label: 'Receivable', type: 'money', get: owesUs, strong: true },
          { key: 'we_owe', label: 'Advance / credit', type: 'money', get: weOwe }
        )
      } else {
        cols.push({ key: 'we_owe', label: 'Payable', type: 'money', get: weOwe, strong: true }, { key: 'owes_us', label: 'Advance / debit', type: 'money', get: owesUs })
      }
      return {
        ...base,
        summary: cust
          ? [
              { label: 'Total receivable', value: a, type: 'money', tone: 'brand', sub: `${rows.filter((r) => r.balance > 0.005).length} customer(s) owe us` },
              { label: 'Customer advances', value: b, type: 'money', tone: 'info', sub: `${rows.filter((r) => r.balance < -0.005).length} customer(s) in credit` },
              { label: 'Net receivable', value: round2(a - b), type: 'money', tone: 'sun', negativeBad: true },
              { label: 'Over credit limit', value: rows.filter((r) => r.credit_limit > 0 && r.balance > r.credit_limit).length, type: 'int', tone: 'bad' }
            ]
          : [
              { label: 'Total payable', value: b, type: 'money', tone: 'brand', sub: `${rows.filter((r) => r.balance < -0.005).length} supplier(s) we owe` },
              { label: 'Advances to suppliers', value: a, type: 'money', tone: 'info', sub: `${rows.filter((r) => r.balance > 0.005).length} supplier(s)` },
              { label: 'Net payable', value: round2(b - a), type: 'money', tone: 'sun', negativeBad: true }
            ],
        sections: [{ id: 'balances', table: { columns: cols, rows, totals: { owes_us: a, we_owe: b }, totalLabel: `Total (${rows.length})` } }],
        notes: ['Balances are the full ledger balance for this firm today — invoices, returns, receipts, payments, expense bills, opening balances and journal adjustments.']
      }
    }

    case 'projects': {
      const rows: any[] = data.rows ?? []
      const t = data.totals ?? {}
      const fin = (k: string) => (r: any) => r.financials?.[k] ?? null
      const statusText = (r: any): string => PROJECT_STATUS_LABELS[r.status as keyof typeof PROJECT_STATUS_LABELS] ?? titleCase(r.status)
      const cols: RCol[] = [
        { key: 'code', label: 'Code', nowrap: true },
        { key: 'name', label: 'Project', strong: true, sub: (r) => r.city },
        { key: 'customer_name', label: 'Customer' },
        { key: 'capacity_kw', label: 'kW', type: 'qty' },
        { key: 'status', label: 'Status', get: statusText, badge: (r) => statusTone(r.status) as Tone },
        { key: 'contract', label: 'Contract', type: 'money', get: fin('contractValue') },
        { key: 'revenue', label: 'Revenue', type: 'money', get: fin('revenue') },
        { key: 'cost', label: 'Direct cost', type: 'money', get: fin('totalDirectCost') },
        { key: 'gross', label: 'Gross profit', type: 'money', signed: true, get: fin('grossProfit') },
        { key: 'net', label: 'Net profit', type: 'money', signed: true, strong: true, get: fin('netProfit') },
        { key: 'margin', label: 'Margin', type: 'pct', signed: true, get: fin('marginPct') },
        { key: 'ppkw', label: 'Profit / kW', type: 'money', signed: true, get: (r) => r.profit_per_kw },
        { key: 'received', label: 'Received', type: 'money', get: fin('received') },
        { key: 'due', label: 'Customer due', type: 'money', get: fin('customerOutstanding') }
      ]
      // 14 columns do not fit a portrait A4 page: code, customer and status move under the project name.
      const printCols: RCol[] = [
        { key: 'name', label: 'Project', strong: true, sub: (r) => [r.code, r.customer_name, statusText(r)].filter(Boolean).join(' · ') },
        ...cols.filter((c) => !['code', 'name', 'customer_name', 'status'].includes(c.key))
      ]
      return {
        ...base,
        subtitle: o.status ? PROJECT_STATUS_LABELS[o.status as keyof typeof PROJECT_STATUS_LABELS] ?? titleCase(o.status) : undefined,
        summary: [
          { label: 'Projects', value: rows.length, type: 'int', tone: 'info', sub: `${round2(Number(t.kw) || 0).toLocaleString('en-PK')} kW in total` },
          { label: 'Revenue (excl. tax)', value: t.revenue, type: 'money', tone: 'brand', sub: 'invoiced, net of returns' },
          { label: 'Direct cost', value: t.cost, type: 'money', tone: 'warn', sub: `Gross margin ${fmtPct(pctOf(Number(t.gross) || 0, Number(t.revenue) || 0))}` },
          { label: 'Net profit', value: t.net, type: 'money', tone: (t.net ?? 0) < 0 ? 'bad' : 'ok', negativeBad: true, sub: `Margin ${fmtPct(t.marginPct)}` },
          { label: 'Customer due', value: t.outstanding, type: 'money', tone: 'warn', sub: 'still to collect' }
        ],
        sections: [
          {
            id: 'projects',
            table: {
              columns: cols,
              printColumns: printCols,
              rows,
              totals: {
                capacity_kw: t.kw,
                contract: t.contract,
                revenue: t.revenue,
                cost: t.cost,
                gross: t.gross,
                net: t.net,
                margin: t.marginPct,
                ppkw: Number(t.kw) > 0 ? round2(Number(t.net) / Number(t.kw)) : null,
                received: t.received,
                due: t.outstanding
              },
              totalLabel: `Total (${rows.length})`
            }
          }
        ],
        notes: [
          'Revenue excludes sales tax. Direct cost = materials (invoiced, issued from stock, bought direct-to-site, material expenses) + labour + other direct project costs. ' +
            'Net profit is after allocated overheads where an allocation method is configured. Cash received is shown separately and is never used to calculate profit.'
        ]
      }
    }

    case 'expenses': {
      const cats: any[] = (data.byCategory ?? []).map((c: any) => ({ ...c, general: round2(c.amount - c.project_amount) }))
      const months: any[] = data.byMonth ?? []
      const total = Number(data.total) || 0
      const projectTotal = sumBy(cats, (c) => c.project_amount)
      const count = cats.reduce((a, c) => a + (Number(c.count) || 0), 0)
      return {
        ...base,
        summary: [
          { label: 'Total expenses', value: total, type: 'money', tone: 'brand', sub: `${count} entr${count === 1 ? 'y' : 'ies'}` },
          { label: 'Charged to projects', value: projectTotal, type: 'money', tone: 'sun', sub: `${fmtPct(pctOf(projectTotal, total))} — part of project cost` },
          { label: 'General / overheads', value: round2(total - projectTotal), type: 'money', tone: 'warn' },
          { label: 'Categories used', value: cats.length, type: 'int', tone: 'info' }
        ],
        sections: [
          {
            id: 'byCategory',
            title: 'By category',
            table: {
              columns: [
                { key: 'name', label: 'Category', strong: true },
                { key: 'cost_head', label: 'Cost head', get: (r) => COST_HEAD_LABELS[r.cost_head as keyof typeof COST_HEAD_LABELS] ?? titleCase(r.cost_head) },
                { key: 'count', label: 'Entries', type: 'int' },
                { key: 'project_amount', label: 'Charged to projects', type: 'money' },
                { key: 'general', label: 'General', type: 'money' },
                { key: 'amount', label: 'Total', type: 'money', strong: true },
                { key: 'share', label: 'Share', type: 'pct', get: (r) => pctOf(r.amount, total) }
              ],
              rows: cats,
              totals: { count, project_amount: projectTotal, general: round2(total - projectTotal), amount: total, share: total > 0 ? 100 : null },
              totalLabel: 'Total'
            }
          },
          {
            id: 'byMonth',
            title: 'By month',
            csv: false,
            table: {
              columns: [
                { key: 'month', label: 'Month', type: 'month', strong: true },
                { key: 'amount', label: 'Amount', type: 'money' },
                { key: 'share', label: 'Share', type: 'pct', get: (r) => pctOf(r.amount, total) }
              ],
              rows: months,
              totals: { amount: total, share: total > 0 ? 100 : null },
              totalLabel: 'Total'
            }
          }
        ],
        notes: [
          'Expenses with a direct cost head (material, labour, contractor, transport, other) or charged to a project are part of cost of sales in Profit & Loss; the rest are operating overheads. Cancelled expenses are excluded.'
        ]
      }
    }
  }
}

/* ------------------------------------------- CSV ----------------------------------------------- */

function csvValue(c: RCol, v: any): unknown {
  if (v === null || v === undefined) return ''
  if (c.type === 'money') return round2(Number(v))
  if (c.type === 'qty') return round3(Number(v))
  if (c.type === 'pct') return round2(Number(v))
  return v
}

/** Rows & columns for api('export.csv'): the P&L statement, or every exportable section (with a totals row). */
export function reportCsv(m: ReportModel): { columns: Array<{ key: string; label: string }>; rows: Array<Record<string, unknown>> } {
  if (m.pl) {
    const line = (l: PlLine): Record<string, unknown> => ({
      label: `${l.kind === 'detail' ? '    ' : l.kind === 'item' ? '  ' : ''}${l.kind === 'section' ? l.label.toUpperCase() : l.label}`,
      amount: l.amount === undefined || l.amount === null ? '' : round2(l.less ? -l.amount : l.amount),
      pct: l.pct === undefined || l.pct === null ? '' : round2(l.pct)
    })
    return {
      columns: [
        { key: 'label', label: 'Particulars' },
        { key: 'amount', label: 'Amount' },
        { key: 'pct', label: '% of net sales' }
      ],
      rows: [...m.pl.statement.map(line), { label: '', amount: '', pct: '' }, { label: 'MEMO (NOT PART OF PROFIT)', amount: '', pct: '' }, ...m.pl.memo.map(line)]
    }
  }
  const secs = m.sections.filter((s) => s.csv !== false)
  if (!secs.length) return { columns: [], rows: [] }
  const cols = secs[0].table.columns
  const multi = secs.length > 1
  const columns = [...(multi ? [{ key: '__section', label: 'Section' }] : []), ...cols.map((c) => ({ key: c.key, label: c.label }))]
  const rows: Array<Record<string, unknown>> = []
  for (const s of secs) {
    for (const r of s.table.rows) {
      const o: Record<string, unknown> = multi ? { __section: s.title ?? '' } : {}
      for (const c of cols) o[c.key] = csvValue(c, rawValue(c, r))
      rows.push(o)
    }
    const t = s.table.totals
    if (t && Object.keys(t).length) {
      const o: Record<string, unknown> = multi ? { __section: s.title ?? '' } : {}
      cols.forEach((c, i) => {
        o[c.key] = i === 0 ? (s.table.totalLabel ?? 'Total').toUpperCase() : c.key in t ? csvValue(c, t[c.key]) : ''
      })
      rows.push(o)
    }
  }
  return { columns, rows }
}

/* ================================================================================================ */
/*                                       Print template                                             */
/* ================================================================================================ */

function printCell(ctx: PrintContext, c: RCol, v: any, r?: any): string {
  if (v === null || v === undefined || v === '') return c.type && c.type !== 'text' ? '—' : ''
  switch (c.type) {
    case 'money':
      return pm(ctx, Number(v))
    case 'qty': {
      const u = r && c.unit ? c.unit(r) : null
      return `${pq(Number(v))}${u ? ` ${u}` : ''}`
    }
    case 'pct':
      return fmtPct(Number(v))
    case 'int':
      return Number(v).toLocaleString('en-PK')
    case 'date':
      return pd(String(v))
    case 'month':
      return monthLabel(String(v))
    default:
      return String(v)
  }
}

function plAmount(ctx: PrintContext, l: PlLine): string {
  return plDisplay(l, (n) => pm(ctx, n))
}

function sizing(n: number): { th: CSSProperties; td: CSSProperties; sub: CSSProperties } {
  const fs = n >= 12 ? 8.4 : n >= 9 ? 9.2 : n >= 7 ? 10 : 10.8
  const pad = n >= 12 ? '4px 3px' : n >= 9 ? '4.5px 4px' : '5px 6px'
  return {
    th: { fontSize: fs - 0.6, padding: pad, letterSpacing: n >= 9 ? 0 : undefined, lineHeight: 1.25, verticalAlign: 'bottom' },
    td: { fontSize: fs, padding: pad, lineHeight: 1.3 },
    sub: { fontSize: Math.max(7.6, fs - 1.6), color: '#718096' }
  }
}

function PrintSectionTable({ ctx, sec }: { ctx: PrintContext; sec: RSection }): JSX.Element {
  const table: RTable = sec.table.printColumns ? { ...sec.table, columns: sec.table.printColumns } : sec.table
  const { columns: cols, rows, totals, totalLabel } = table
  const s = sizing(cols.length)
  const align = (c: RCol): 'left' | 'right' => (isNumeric(c) ? 'right' : 'left')
  const hasTotals = !!totals && (Object.keys(totals).length > 0 || !!totalLabel)
  const lead = totalsLead(table)
  return (
    <div className="mb-4">
      {sec.title && (
        <div className="avoid-break mb-1 text-[10px] font-bold tracking-wider uppercase" style={{ color: 'var(--pc)' }}>
          {sec.title}
        </div>
      )}
      <PrintTable
        head={cols.map((c) => (
          <th key={c.key} style={{ ...s.th, textAlign: align(c) }}>
            {c.label}
          </th>
        ))}
      >
        {rows.length === 0 ? (
          <tr>
            <td colSpan={cols.length} style={{ ...s.td, textAlign: 'center', color: '#718096', padding: '10px 6px' }}>
              No records for this selection.
            </td>
          </tr>
        ) : (
          rows.map((r, i) => {
            const special = table.isSpecial?.(r)
            const muted = table.isMuted?.(r)
            return (
              <tr key={i} style={muted ? { color: '#a0aec0', textDecoration: 'line-through' } : undefined}>
                {cols.map((c) => {
                  const v = rawValue(c, r)
                  const neg = c.signed && typeof v === 'number' && v < -0.004
                  const sub = c.sub?.(r)
                  return (
                    <td
                      key={c.key}
                      className={isNumeric(c) ? 'num' : undefined}
                      style={{
                        ...s.td,
                        textAlign: align(c),
                        fontWeight: special || c.strong ? 600 : undefined,
                        color: neg && !muted ? '#c53030' : undefined,
                        background: special ? '#edf2f7' : undefined,
                        whiteSpace: isNumeric(c) || c.type === 'date' || c.nowrap ? 'nowrap' : undefined
                      }}
                    >
                      {printCell(ctx, c, v, r)}
                      {sub && <div style={s.sub}>{sub}</div>}
                    </td>
                  )
                })}
              </tr>
            )
          })
        )}
        {hasTotals && rows.length > 0 && (
          <tr>
            <td colSpan={lead} style={{ ...s.td, fontWeight: 700, background: '#e9eef6', borderTop: '1.5px solid var(--pc)' }}>
              {totalLabel ?? 'Total'}
            </td>
            {cols.slice(lead).map((c) => {
              const v = totals?.[c.key]
              const neg = c.signed && typeof v === 'number' && v < -0.004
              return (
                <td
                  key={c.key}
                  className={isNumeric(c) ? 'num' : undefined}
                  style={{
                    ...s.td,
                    textAlign: align(c),
                    fontWeight: 700,
                    background: '#e9eef6',
                    borderTop: '1.5px solid var(--pc)',
                    color: neg ? '#c53030' : undefined,
                    whiteSpace: 'nowrap'
                  }}
                >
                  {v === undefined ? '' : printCell(ctx, c, v)}
                </td>
              )
            })}
          </tr>
        )}
      </PrintTable>
    </div>
  )
}

function PrintSummary({ ctx, items }: { ctx: PrintContext; items: RSummary[] }): JSX.Element | null {
  if (!items.length) return null
  const fmt = (s: RSummary): string =>
    s.value === null || s.value === undefined
      ? '—'
      : s.type === 'money'
        ? pm(ctx, s.value)
        : s.type === 'pct'
          ? fmtPct(s.value)
          : s.type === 'qty'
            ? pq(s.value)
            : Number(s.value).toLocaleString('en-PK')
  return (
    <div className="avoid-break mb-3 grid gap-2" style={{ gridTemplateColumns: `repeat(${Math.min(items.length, 5)}, minmax(0, 1fr))` }}>
      {items.map((s) => (
        <div key={s.label} className="rounded-md border border-[#e2e8f0] px-2.5 py-1.5" style={{ borderTop: '2.5px solid var(--pc)' }}>
          <div className="text-[8.6px] font-bold tracking-wider text-[#718096] uppercase">{s.label}</div>
          <div className="num text-[13px] font-extrabold" style={{ color: s.negativeBad && (s.value ?? 0) < 0 ? '#c53030' : '#1b2333' }}>
            {fmt(s)}
          </div>
          {s.sub && <div className="text-[8.6px] text-[#4a5568]">{s.sub}</div>}
        </div>
      ))}
    </div>
  )
}

function PlRows({ ctx, lines }: { ctx: PrintContext; lines: PlLine[] }): JSX.Element {
  return (
    <>
      {lines.map((l, i) => {
        const base: CSSProperties = { padding: '4px 8px', fontSize: 10.8, background: '#fff' }
        if (l.kind === 'section') {
          return (
            <tr key={i}>
              <td colSpan={3} style={{ ...base, paddingTop: 9, fontSize: 9.8, fontWeight: 800, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--pc)', borderBottom: '1px solid #cbd5e0' }}>
                {l.label}
              </td>
            </tr>
          )
        }
        const neg = (l.amount ?? 0) < -0.004
        let style: CSSProperties = { ...base }
        if (l.kind === 'item') style = { ...style, paddingLeft: 20 }
        if (l.kind === 'detail') style = { ...style, paddingLeft: 36, fontSize: 9.8, color: '#4a5568' }
        if (l.kind === 'subtotal') style = { ...style, fontWeight: 700, borderTop: '1px solid #a0aec0' }
        if (l.kind === 'total') style = { ...style, fontWeight: 800, background: '#e9eef6', fontSize: 11.5 }
        if (l.kind === 'grand') style = { ...style, fontWeight: 800, fontSize: 12.5, color: '#fff', background: neg ? '#c53030' : 'var(--pc)' }
        const amtColor = l.kind !== 'grand' && neg ? '#c53030' : undefined
        return (
          <tr key={i}>
            <td style={style}>{l.label}</td>
            <td className="num" style={{ ...style, paddingLeft: 8, textAlign: 'right', whiteSpace: 'nowrap', color: amtColor ?? style.color }}>
              {plAmount(ctx, l)}
            </td>
            <td className="num" style={{ ...style, paddingLeft: 8, textAlign: 'right', whiteSpace: 'nowrap', fontSize: l.kind === 'grand' ? 11 : 9.8 }}>
              {l.pct === null || l.pct === undefined ? '' : fmtPct(l.pct)}
            </td>
          </tr>
        )
      })}
    </>
  )
}

function PrintPl({ ctx, pl }: { ctx: PrintContext; pl: NonNullable<ReportModel['pl']> }): JSX.Element {
  const head = (
    <>
      <th>Particulars</th>
      <th style={{ width: 130, textAlign: 'right' }}>Amount</th>
      <th style={{ width: 104, textAlign: 'right', whiteSpace: 'nowrap' }}>% of net sales</th>
    </>
  )
  return (
    <>
      <div className="mb-4">
        <PrintTable head={head}>
          <PlRows ctx={ctx} lines={pl.statement} />
        </PrintTable>
      </div>
      <div className="avoid-break mb-4">
        <div className="mb-1 text-[10px] font-bold tracking-wider uppercase" style={{ color: 'var(--pc)' }}>
          Memo — not part of profit
        </div>
        <table className="w-full border border-[#e2e8f0] text-[10.5px]">
          <tbody>
            {pl.memo.map((l) => (
              <tr key={l.label} style={l.kind === 'subtotal' ? { fontWeight: 700, background: '#f7f9fc' } : undefined}>
                <td className="px-2 py-1">{l.label}</td>
                <td className="num px-2 py-1 text-right whitespace-nowrap" style={{ width: 130 }}>
                  {plAmount(ctx, l)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  )
}

function PrintNotes({ notes }: { notes: string[] }): JSX.Element | null {
  if (!notes.length) return null
  return (
    <div className="avoid-break mt-1 rounded-md bg-[#f7f9fc] px-3 py-2 text-[9.4px] leading-relaxed text-[#2d3748]">
      <div className="mb-0.5 text-[8.6px] font-bold tracking-wider text-[#718096] uppercase">Notes</div>
      {notes.map((n, i) => (
        <div key={i}>{n}</div>
      ))}
    </div>
  )
}

/** A4 print template for every report on the Reports page. Params: report=<key> plus the report's filters. */
export function ReportPrint({ params, ctx, setTitle }: TemplateProps): JSX.Element | null {
  const paramKey = JSON.stringify(params)
  const [state, setState] = useState<{ key: ReportKey; opts: ReportOptions; model: ReportModel } | null>(null)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    const { key, opts } = parseReportParams(params)
    if (!key) {
      setErr('Unknown report. Please print it again from the Reports page.')
      return
    }
    setTitle(reportFileTitle(key, opts))
    fetchReport(key, opts)
      .then((data) => {
        if (!alive) return
        if (data === null || data === undefined) throw new Error('Choose a cash / bank account on the Reports page before printing.')
        const model = buildReportModel(key, data, opts)
        setState({ key, opts, model })
        setTitle(reportFileTitle(key, opts, data))
      })
      .catch((e) => alive && setErr(e instanceof Error ? e.message : String(e)))
    return () => {
      alive = false
    }
  }, [paramKey]) // eslint-disable-line react-hooks/exhaustive-deps

  if (err) return <div className="no-print mx-auto max-w-[210mm] rounded bg-red-100 p-4 text-red-800">{err}</div>
  if (!state) return <div className="no-print py-20 text-center text-[13px] text-white/70">Preparing report…</div>

  return <ReportSheet ctx={ctx} reportKey={state.key} opts={state.opts} model={state.model} />
}

/** The printed A4 page of a report (pure — data already loaded). */
export function ReportSheet({ ctx, reportKey: key, opts, model }: { ctx: PrintContext; reportKey: ReportKey; opts: ReportOptions; model: ReportModel }): JSX.Element {
  const def = reportDef(key)!
  const meta: Array<[string, ReactNode]> = []
  if (key === 'projects' && !opts.datedOnly) meta.push(['Projects', 'All start dates'])
  else if (def.period === 'range') meta.push(['Period', `${pd(opts.from)} to ${pd(opts.to)}`])
  else meta.push(['As of', pd(def.period === 'asOf' ? opts.asOf : isoToday())])
  if (key === 'projects' && opts.datedOnly) meta[0][0] = 'Started'
  if (def.scope && opts.scope === 'all') meta.push(['Scope', 'All firms (consolidated)'])
  if (key === 'stock' && opts.includeZero) meta.push(['Includes', 'Zero-stock items'])
  meta.push(['Printed', pd(isoToday())])

  return (
    <Sheet ctx={ctx}>
      <Letterhead ctx={ctx} title={model.title} subtitle={model.subtitle} meta={meta} />
      <PrintSummary ctx={ctx} items={model.summary} />
      {model.pl && <PrintPl ctx={ctx} pl={model.pl} />}
      {model.sections
        .filter((s) => s.print !== false)
        .map((s) => (
          <Fragment key={s.id}>
            <PrintSectionTable ctx={ctx} sec={s} />
          </Fragment>
        ))}
      <PrintNotes notes={model.notes} />
      <Signatures ctx={ctx} left="Prepared by" />
      <PrintFooter ctx={ctx} note="" />
    </Sheet>
  )
}
