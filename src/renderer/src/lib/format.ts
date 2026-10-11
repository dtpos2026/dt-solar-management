import { useApp } from '../store'
import { formatMoney, formatQty, round2 } from '@shared/money'

export function money(n: number | null | undefined, opts: { symbol?: boolean; decimals?: number } = {}): string {
  if (n === null || n === undefined || Number.isNaN(n)) return '—'
  const s = useApp.getState().settings
  const dec = opts.decimals ?? Number(s.money_decimals ?? 0)
  return formatMoney(n, opts.symbol === false ? '' : String(s.currency_symbol ?? 'Rs.'), dec)
}

export function moneyFull(n: number | null | undefined): string {
  return money(n, { decimals: 2 })
}

export function qty(n: number | null | undefined): string {
  if (n === null || n === undefined) return '—'
  return formatQty(n)
}

export function pct(n: number | null | undefined): string {
  if (n === null || n === undefined) return '—'
  return `${round2(n).toFixed(1)}%`
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

export function date(s: string | null | undefined): string {
  if (!s) return '—'
  const [y, m, d] = s.slice(0, 10).split('-')
  if (!y || !m || !d) return s
  return `${d} ${MONTHS[Number(m) - 1]} ${y}`
}

export function dateTime(s: string | null | undefined): string {
  if (!s) return '—'
  return `${date(s)} ${s.slice(11, 16)}`
}

export function today(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export function addDays(iso: string, days: number): string {
  const d = new Date(iso + 'T00:00:00')
  d.setDate(d.getDate() + days)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export function monthStart(): string {
  return today().slice(0, 8) + '01'
}

export function yearStart(): string {
  return today().slice(0, 5) + '01-01'
}

export const PERIODS: Array<{ key: string; label: string; range: () => [string, string] }> = [
  { key: 'today', label: 'Today', range: () => [today(), today()] },
  { key: 'week', label: 'Last 7 days', range: () => [addDays(today(), -6), today()] },
  { key: 'month', label: 'This month', range: () => [monthStart(), today()] },
  {
    key: 'lastmonth',
    label: 'Last month',
    range: () => {
      const d = new Date()
      const s = new Date(d.getFullYear(), d.getMonth() - 1, 1)
      const e = new Date(d.getFullYear(), d.getMonth(), 0)
      const f = (x: Date): string => `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`
      return [f(s), f(e)]
    }
  },
  { key: 'quarter', label: 'Last 90 days', range: () => [addDays(today(), -89), today()] },
  { key: 'year', label: 'This year', range: () => [yearStart(), today()] },
  { key: 'all', label: 'All time', range: () => ['2000-01-01', today()] }
]

export function statusTone(s: string | null | undefined): 'ok' | 'warn' | 'bad' | 'info' | 'muted' | 'brand' {
  switch (s) {
    case 'paid':
    case 'completed':
    case 'accepted':
    case 'active':
    case 'converted':
    case 'final':
      return 'ok'
    case 'partial':
    case 'in_progress':
    case 'sent':
    case 'open':
    case 'grace':
    case 'trial':
      return 'warn'
    case 'unpaid':
    case 'cancelled':
    case 'rejected':
    case 'overdue':
      return 'bad'
    case 'planning':
    case 'quoted':
    case 'draft':
      return 'info'
    default:
      return 'muted'
  }
}

export function label(s: string | null | undefined): string {
  if (!s) return '—'
  return s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}
