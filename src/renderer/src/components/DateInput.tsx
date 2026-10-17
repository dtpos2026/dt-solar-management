import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { CalendarDays, ChevronLeft, ChevronRight, X } from 'lucide-react'
import { cx } from './ui'

/**
 * Date field with its own calendar (month navigation, year list, Today). It does not depend on the operating system's
 * date popup. The value is always an ISO date (YYYY-MM-DD) and onChange has the same shape as an <input> event, so it is a
 * drop-in replacement for <Input type="date">.
 */
export interface DateInputProps {
  value: string
  onChange: (e: { target: { value: string } }) => void
  min?: string
  max?: string
  sm?: boolean
  className?: string
  disabled?: boolean
  /** Shows a Clear button (optional dates). */
  clearable?: boolean
  placeholder?: string
  autoFocus?: boolean
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
const SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const DAYS = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su']

const pad = (n: number): string => String(n).padStart(2, '0')
const iso = (y: number, m: number, d: number): string => `${y}-${pad(m + 1)}-${pad(d)}`
const parse = (s: string): { y: number; m: number; d: number } | null => {
  const x = /^(\d{4})-(\d{2})-(\d{2})/.exec(s ?? '')
  if (!x) return null
  const y = Number(x[1])
  const m = Number(x[2]) - 1
  const d = Number(x[3])
  return m >= 0 && m < 12 && d >= 1 && d <= 31 ? { y, m, d } : null
}
const todayIso = (): string => {
  const t = new Date()
  return iso(t.getFullYear(), t.getMonth(), t.getDate())
}
export const formatDate = (s: string): string => {
  const p = parse(s)
  return p ? `${pad(p.d)} ${SHORT[p.m]} ${p.y}` : ''
}

/** The 6 x 7 grid of a month (Monday first): ISO dates, with the days outside the month included. */
export function monthGrid(y: number, m: number): string[] {
  const first = new Date(y, m, 1)
  const lead = (first.getDay() + 6) % 7
  const out: string[] = []
  for (let i = 0; i < 42; i++) {
    const d = new Date(y, m, 1 - lead + i)
    out.push(iso(d.getFullYear(), d.getMonth(), d.getDate()))
  }
  return out
}

export function DateInput({ value, onChange, min, max, sm, className, disabled, clearable, placeholder, autoFocus }: DateInputProps): JSX.Element {
  const [open, setOpen] = useState(false)
  const btn = useRef<HTMLButtonElement>(null)
  const pop = useRef<HTMLDivElement>(null)
  const cur = parse(value)
  const base = cur ?? parse(todayIso())!
  const [view, setView] = useState({ y: base.y, m: base.m })
  const [pos, setPos] = useState({ top: 0, left: 0, up: false })

  useEffect(() => {
    if (open) setView({ y: base.y, m: base.m })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  useLayoutEffect(() => {
    if (!open || !btn.current) return
    const r = btn.current.getBoundingClientRect()
    const h = 340
    const up = r.bottom + h > window.innerHeight && r.top > h
    const left = Math.max(8, Math.min(r.left, window.innerWidth - 292))
    setPos({ top: up ? r.top - 6 : r.bottom + 6, left, up })
  }, [open])

  useEffect(() => {
    if (!open) return
    const down = (e: MouseEvent): void => {
      const t = e.target as Node
      if (!pop.current?.contains(t) && !btn.current?.contains(t)) setOpen(false)
    }
    const key = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        setOpen(false)
        btn.current?.focus()
      }
    }
    const close = (): void => setOpen(false)
    document.addEventListener('mousedown', down)
    window.addEventListener('keydown', key, true)
    window.addEventListener('resize', close)
    return () => {
      document.removeEventListener('mousedown', down)
      window.removeEventListener('keydown', key, true)
      window.removeEventListener('resize', close)
    }
  }, [open])

  const grid = useMemo(() => monthGrid(view.y, view.m), [view])
  const today = todayIso()
  const blocked = (d: string): boolean => (!!min && d < min) || (!!max && d > max)
  const shift = (n: number): void => setView((v) => {
    const d = new Date(v.y, v.m + n, 1)
    return { y: d.getFullYear(), m: d.getMonth() }
  })
  const pick = (d: string): void => {
    onChange({ target: { value: d } })
    setOpen(false)
    btn.current?.focus()
  }
  const years = useMemo(() => {
    const c = new Date().getFullYear()
    const lo = Math.min(c - 12, view.y)
    const hi = Math.max(c + 8, view.y)
    return Array.from({ length: hi - lo + 1 }, (_, i) => lo + i)
  }, [view.y])

  return (
    <>
      <div className={cx('relative', className)}>
        <button
          ref={btn}
          type="button"
          disabled={disabled}
          autoFocus={autoFocus}
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
          className={cx('input flex items-center justify-between gap-2 text-left disabled:cursor-not-allowed', sm && 'input-sm', !cur && 'text-muted', clearable && cur && 'pr-8')}
        >
          <span className="num truncate">{cur ? formatDate(value) : placeholder ?? 'Select date'}</span>
          <CalendarDays className="h-4 w-4 shrink-0 text-muted" />
        </button>
        {clearable && cur && !disabled && (
          <button type="button" aria-label="Clear date" className="absolute top-1/2 right-8 -translate-y-1/2 cursor-pointer rounded p-0.5 text-muted hover:text-ink" onClick={() => onChange({ target: { value: '' } })}>
            <X className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
      {open &&
        createPortal(
          <div
            ref={pop}
            role="dialog"
            aria-label="Choose a date"
            data-overlay="dropdown"
            style={{ position: 'fixed', top: pos.top, left: pos.left, transform: pos.up ? 'translateY(-100%)' : undefined, zIndex: 80 }}
            className="card fade-in w-[280px] p-3 shadow-xl"
          >
            <div className="mb-2 flex items-center gap-1.5">
              <button type="button" aria-label="Previous month" className="flex h-8 w-8 cursor-pointer items-center justify-center rounded-lg hover:bg-surface-2" onClick={() => shift(-1)}>
                <ChevronLeft className="h-4 w-4" />
              </button>
              <div className="flex flex-1 items-center justify-center gap-1">
                <span className="text-[13.5px] font-semibold">{MONTHS[view.m]}</span>
                <select
                  aria-label="Year"
                  className="cursor-pointer rounded-md border-0 bg-transparent py-0.5 text-[13.5px] font-semibold outline-none hover:bg-surface-2"
                  value={view.y}
                  onChange={(e) => setView((v) => ({ ...v, y: Number(e.target.value) }))}
                >
                  {years.map((y) => (
                    <option key={y} value={y}>{y}</option>
                  ))}
                </select>
              </div>
              <button type="button" aria-label="Next month" className="flex h-8 w-8 cursor-pointer items-center justify-center rounded-lg hover:bg-surface-2" onClick={() => shift(1)}>
                <ChevronRight className="h-4 w-4" />
              </button>
            </div>
            <div className="grid grid-cols-7 text-center text-[12px] font-medium text-muted">
              {DAYS.map((d) => (
                <div key={d} className="py-1">{d}</div>
              ))}
            </div>
            <div className="grid grid-cols-7 gap-0.5" role="grid">
              {grid.map((d) => {
                const inMonth = parse(d)!.m === view.m
                const sel = d === value
                const off = blocked(d)
                return (
                  <button
                    key={d}
                    type="button"
                    role="gridcell"
                    aria-selected={sel}
                    disabled={off}
                    data-date={d}
                    onClick={() => pick(d)}
                    className={cx(
                      'num h-9 cursor-pointer rounded-lg text-[13px] transition',
                      sel ? 'bg-brand font-semibold text-white' : d === today ? 'border border-brand font-semibold text-brand hover:bg-brand-soft' : inMonth ? 'hover:bg-surface-2' : 'text-muted/60 hover:bg-surface-2',
                      off && 'cursor-not-allowed opacity-35 hover:bg-transparent'
                    )}
                  >
                    {parse(d)!.d}
                  </button>
                )
              })}
            </div>
            <div className="mt-2 flex items-center justify-between border-t border-line pt-2">
              <button type="button" disabled={blocked(today)} className="cursor-pointer rounded-lg px-2 py-1 text-[13px] font-medium text-brand hover:bg-brand-soft disabled:opacity-40" onClick={() => pick(today)}>
                Today
              </button>
              {clearable && cur && (
                <button type="button" className="cursor-pointer rounded-lg px-2 py-1 text-[13px] text-muted hover:bg-surface-2" onClick={() => { onChange({ target: { value: '' } }); setOpen(false) }}>
                  Clear
                </button>
              )}
            </div>
          </div>,
          document.body
        )}
    </>
  )
}
