import { ReactNode, useEffect, useMemo, useState } from 'react'
import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight, Download, Search } from 'lucide-react'
import { Button, Empty, Input, Loading, Select, cx, toast } from './ui'
import { api } from '../api'

export interface Column<T> {
  key: string
  header: ReactNode
  render?: (row: T) => ReactNode
  /** Value used for sorting / searching / CSV export */
  value?: (row: T) => string | number | null | undefined
  align?: 'left' | 'right' | 'center'
  width?: string | number
  sortable?: boolean
  className?: string
  hidden?: boolean
  csv?: boolean
}

interface Props<T> {
  rows: T[]
  columns: Array<Column<T>>
  loading?: boolean
  onRowClick?: (row: T) => void
  searchable?: boolean
  searchPlaceholder?: string
  empty?: ReactNode
  pageSize?: number
  footer?: ReactNode
  toolbar?: ReactNode
  exportName?: string
  rowKey?: (row: T, i: number) => string | number
  dense?: boolean
  maxHeight?: string
  rowClassName?: (row: T) => string | undefined
}

/** Date / timestamp columns are right-aligned like amounts so they line up (tabular figures). */
const DATE_KEY = /^(date|due_date|last_date|created_at|updated_at|last_login_at|modified|closed_at|valid_until|expiry_date|start_date|end_date)$/
/** Short identifiers (document numbers, SKUs, codes) must not break across lines. */
/** The row-actions column (key "actions") stays pinned to the right edge when a wide table scrolls sideways. */
const ID_KEY = /^(number|code|sku|doc_number|ref|reference)$/
function alignOf<T>(c: Column<T>): 'left' | 'right' | 'center' {
  return c.align ?? (DATE_KEY.test(c.key) ? 'right' : 'left')
}

function rawValue<T>(c: Column<T>, row: T): string | number | null | undefined {
  if (c.value) return c.value(row)
  const v = (row as Record<string, unknown>)[c.key]
  return typeof v === 'number' || typeof v === 'string' ? v : v === null || v === undefined ? v : String(v)
}

export function DataTable<T>({ rows, columns, loading, onRowClick, searchable = true, searchPlaceholder = 'Search…', empty, pageSize = 50, footer, toolbar, exportName, rowKey, dense, maxHeight, rowClassName }: Props<T>): JSX.Element {
  const cols = columns.filter((c) => !c.hidden)
  const [q, setQ] = useState('')
  const [sort, setSort] = useState<{ key: string; dir: 1 | -1 } | null>(null)
  const [page, setPage] = useState(0)
  const [size, setSize] = useState(pageSize)

  useEffect(() => setPage(0), [q, rows, size])

  const filtered = useMemo(() => {
    let r = rows
    if (q.trim()) {
      const terms = q.toLowerCase().split(/\s+/).filter(Boolean)
      r = r.filter((row) => {
        const hay = cols.map((c) => String(rawValue(c, row) ?? '')).join(' ').toLowerCase()
        return terms.every((t) => hay.includes(t))
      })
    }
    if (sort) {
      const c = cols.find((x) => x.key === sort.key)
      if (c) {
        r = [...r].sort((a, b) => {
          const va = rawValue(c, a)
          const vb = rawValue(c, b)
          if (va === vb) return 0
          if (va === null || va === undefined) return 1
          if (vb === null || vb === undefined) return -1
          return (typeof va === 'number' && typeof vb === 'number' ? va - vb : String(va).localeCompare(String(vb))) * sort.dir
        })
      }
    }
    return r
  }, [rows, q, sort, cols])

  const pages = Math.max(1, Math.ceil(filtered.length / size))
  const visible = filtered.slice(page * size, page * size + size)

  const exportCsv = async (): Promise<void> => {
    try {
      const exportCols = cols.filter((c) => c.csv !== false && typeof c.header === 'string')
      const data = filtered.map((r) => Object.fromEntries(exportCols.map((c) => [c.key, rawValue(c, r)])))
      const file = await api('export.csv', { filename: exportName ?? 'export', columns: exportCols.map((c) => ({ key: c.key, label: c.header })), rows: data })
      if (file) toast.ok(`Exported to ${file}`)
    } catch (e) {
      toast.error(e)
    }
  }

  return (
    <div className="card overflow-hidden">
      {(searchable || toolbar || exportName) && (
        <div className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2.5">
          {searchable && (
            <div className="relative w-64 max-w-full min-w-[180px] shrink">
              <Search className="pointer-events-none absolute top-1/2 left-2.5 h-4 w-4 -translate-y-1/2 text-muted" />
              <Input sm className="pl-8" placeholder={searchPlaceholder} value={q} onChange={(e) => setQ(e.target.value)} />
            </div>
          )}
          <div className="flex flex-1 flex-wrap items-center gap-2">{toolbar}</div>
          {exportName && (
            <Button size="sm" variant="ghost" icon={<Download className="h-4 w-4" />} onClick={exportCsv} disabled={!filtered.length}>
              Export
            </Button>
          )}
        </div>
      )}
      <div className="overflow-auto" style={{ maxHeight: maxHeight ?? 'calc(100vh - 290px)' }}>
        {loading ? (
          <Loading />
        ) : filtered.length === 0 ? (
          empty ?? <Empty title={q ? 'No matching records' : 'No records yet'} />
        ) : (
          <table className="tbl">
            <thead>
              <tr>
                {cols.map((c) => (
                  <th
                    key={c.key}
                    style={{ width: c.width, textAlign: alignOf(c) }}
                    className={cx(c.sortable !== false && 'cursor-pointer select-none hover:text-ink', c.key === 'actions' && 'sticky-act')}
                    onClick={() => c.sortable !== false && setSort((s) => (s?.key === c.key ? (s.dir === 1 ? { key: c.key, dir: -1 } : null) : { key: c.key, dir: 1 }))}
                  >
                    <span className={cx('inline-flex items-center gap-1', alignOf(c) === 'right' && 'flex-row-reverse')}>
                      {c.header}
                      {sort?.key === c.key && (sort.dir === 1 ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />)}
                    </span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {visible.map((row, i) => (
                <tr key={rowKey ? rowKey(row, i) : ((row as { id?: number }).id ?? i)} className={cx(onRowClick && 'clickable', rowClassName?.(row))} onClick={() => onRowClick?.(row)}>
                  {cols.map((c) => (
                    <td key={c.key} className={cx(dense && '!py-1.5', alignOf(c) === 'right' && 'num text-right', alignOf(c) === 'center' && 'text-center', ID_KEY.test(c.key) && 'nowrap', c.key === 'actions' && 'sticky-act', c.className)}>
                      {c.render ? c.render(row) : ((rawValue(c, row) as ReactNode) ?? '-')}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
            {footer && <tfoot className="bg-surface-2 font-semibold">{footer}</tfoot>}
          </table>
        )}
      </div>
      {!loading && filtered.length > size && (
        <div className="num flex flex-wrap items-center justify-between gap-3 border-t border-line px-3 py-2 text-[12.5px] text-muted">
          <span>
            {page * size + 1}–{Math.min(filtered.length, (page + 1) * size)} of {filtered.length}
          </span>
          <div className="flex items-center gap-2">
            <Select sm className="w-24" value={size} onChange={(e) => setSize(Number(e.target.value))}>
              {[25, 50, 100, 250].map((n) => (
                <option key={n} value={n}>
                  {n} / page
                </option>
              ))}
            </Select>
            <Button size="sm" variant="ghost" disabled={page === 0} onClick={() => setPage(page - 1)} icon={<ChevronLeft className="h-4 w-4" />} />
            <span>
              {page + 1} / {pages}
            </span>
            <Button size="sm" variant="ghost" disabled={page >= pages - 1} onClick={() => setPage(page + 1)} icon={<ChevronRight className="h-4 w-4" />} />
          </div>
        </div>
      )}
    </div>
  )
}
