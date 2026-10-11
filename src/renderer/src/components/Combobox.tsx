import { ReactNode, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ChevronDown, Plus, Search, X } from 'lucide-react'
import { cx } from './ui'

export interface Option {
  value: number | string
  label: string
  sub?: ReactNode
  search?: string
  disabled?: boolean
}

interface Props {
  options: Option[]
  value: number | string | null | undefined
  onChange: (value: any, option: Option | null) => void // eslint-disable-line @typescript-eslint/no-explicit-any
  placeholder?: string
  sm?: boolean
  className?: string
  allowClear?: boolean
  disabled?: boolean
  onCreate?: (text: string) => void
  createLabel?: string
  autoFocus?: boolean
}

/** Keyboard-friendly searchable select (used for products, customers, suppliers, projects). */
export function Combobox({ options, value, onChange, placeholder = 'Select…', sm, className, allowClear, disabled, onCreate, createLabel = 'Create', autoFocus }: Props): JSX.Element {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const [hi, setHi] = useState(0)
  const btn = useRef<HTMLButtonElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const [rect, setRect] = useState<DOMRect | null>(null)
  const selected = options.find((o) => String(o.value) === String(value)) ?? null

  const filtered = useMemo(() => {
    const t = q.trim().toLowerCase()
    if (!t) return options.slice(0, 300)
    const terms = t.split(/\s+/)
    return options.filter((o) => terms.every((x) => `${o.label} ${o.search ?? ''}`.toLowerCase().includes(x))).slice(0, 300)
  }, [options, q])

  useEffect(() => setHi(0), [q, open])
  useEffect(() => {
    if (!open) return
    const update = (): void => setRect(btn.current?.getBoundingClientRect() ?? null)
    update()
    const close = (e: MouseEvent): void => {
      if (!listRef.current?.contains(e.target as Node) && !btn.current?.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('resize', update)
    window.addEventListener('scroll', update, true)
    window.addEventListener('mousedown', close)
    return () => {
      window.removeEventListener('resize', update)
      window.removeEventListener('scroll', update, true)
      window.removeEventListener('mousedown', close)
    }
  }, [open])

  const pick = (o: Option | null): void => {
    if (o?.disabled) return
    onChange(o ? o.value : null, o)
    setOpen(false)
    setQ('')
    btn.current?.focus()
  }

  const below = rect ? window.innerHeight - rect.bottom > 300 : true
  return (
    <>
      <button
        ref={btn}
        type="button"
        disabled={disabled}
        autoFocus={autoFocus}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' || e.key === 'Enter' || (e.key.length === 1 && !e.ctrlKey && !e.metaKey)) {
            if (!open) {
              setOpen(true)
              if (e.key.length === 1) setQ(e.key)
              e.preventDefault()
            }
          }
        }}
        className={cx('input flex items-center justify-between gap-2 text-left cursor-pointer', sm && 'input-sm', className)}
      >
        <span className={cx('truncate', !selected && 'text-muted')}>{selected ? selected.label : placeholder}</span>
        <span className="flex items-center gap-1 text-muted">
          {allowClear && selected && !disabled && (
            <X
              className="h-3.5 w-3.5 hover:text-bad"
              onClick={(e) => {
                e.stopPropagation()
                pick(null)
              }}
            />
          )}
          <ChevronDown className="h-4 w-4" />
        </span>
      </button>
      {open &&
        rect &&
        createPortal(
          <div
            ref={listRef}
            className="card fade-in fixed z-[80] flex flex-col overflow-hidden shadow-xl"
            style={{
              left: rect.left,
              width: Math.max(rect.width, 320),
              ...(below ? { top: rect.bottom + 4 } : { bottom: window.innerHeight - rect.top + 4 }),
              maxHeight: 320
            }}
          >
            <div className="relative border-b border-line p-2">
              <Search className="pointer-events-none absolute top-1/2 left-4 h-4 w-4 -translate-y-1/2 text-muted" />
              <input
                autoFocus
                className="input input-sm pl-8"
                placeholder="Type to search…"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'ArrowDown') {
                    setHi((h) => Math.min(h + 1, filtered.length - 1))
                    e.preventDefault()
                  } else if (e.key === 'ArrowUp') {
                    setHi((h) => Math.max(h - 1, 0))
                    e.preventDefault()
                  } else if (e.key === 'Enter') {
                    e.preventDefault()
                    if (filtered[hi]) pick(filtered[hi])
                    else if (onCreate && q.trim()) {
                      onCreate(q.trim())
                      setOpen(false)
                    }
                  } else if (e.key === 'Escape') setOpen(false)
                }}
              />
            </div>
            <div className="flex-1 overflow-y-auto py-1">
              {filtered.length === 0 && <div className="px-3 py-3 text-[13px] text-muted">No matches</div>}
              {filtered.map((o, i) => (
                <div
                  key={String(o.value)}
                  onMouseEnter={() => setHi(i)}
                  onMouseDown={(e) => {
                    e.preventDefault()
                    pick(o)
                  }}
                  className={cx('cursor-pointer px-3 py-1.5', i === hi && 'bg-brand-soft', String(o.value) === String(value) && 'font-semibold', o.disabled && 'opacity-50')}
                >
                  <div className="truncate text-[13.5px]">{o.label}</div>
                  {o.sub && <div className="truncate text-[11.5px] text-muted">{o.sub}</div>}
                </div>
              ))}
            </div>
            {onCreate && (
              <button
                type="button"
                className="flex items-center gap-2 border-t border-line px-3 py-2 text-left text-[13px] font-medium text-brand hover:bg-brand-soft cursor-pointer"
                onMouseDown={(e) => {
                  e.preventDefault()
                  onCreate(q.trim())
                  setOpen(false)
                }}
              >
                <Plus className="h-4 w-4" /> {createLabel}
                {q.trim() ? ` "${q.trim()}"` : ''}
              </button>
            )}
          </div>,
          document.body
        )}
    </>
  )
}
