/** Small reusable building blocks for portal pages (pagination, confirmations, drawers, tabs, notices). */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { AlertTriangle, CheckCircle2, ChevronLeft, ChevronRight, Info, Loader2, Lock, RefreshCw, Search, X, XCircle } from 'lucide-react'
import { Modal, cx } from './ui'

/* ------------------------------------------------ paging ------------------------------------------------ */

export function usePaged<T>(items: readonly T[], pageSize: number, resetKey?: unknown) {
  const [page, setPage] = useState(1)
  const pages = Math.max(1, Math.ceil(items.length / pageSize))
  useEffect(() => setPage(1), [resetKey])
  useEffect(() => {
    if (page > pages) setPage(pages)
  }, [page, pages])
  const slice = useMemo(() => items.slice((page - 1) * pageSize, page * pageSize), [items, page, pageSize])
  return { page: Math.min(page, pages), pages, setPage, slice, total: items.length, pageSize }
}

export function Pager({ page, pages, total, pageSize, setPage, noun = 'rows' }: { page: number; pages: number; total: number; pageSize: number; setPage: (p: number) => void; noun?: string }) {
  if (total === 0) return null
  const from = (page - 1) * pageSize + 1
  const to = Math.min(total, page * pageSize)
  return (
    <div className="flex items-center justify-between gap-3 border-t border-[#ece6f4] px-4 py-2.5 text-[12.5px] text-[#6b5d85]">
      <div>
        {from}–{to} of {total} {noun}
      </div>
      <div className="flex items-center gap-1">
        <button className="btn btn-secondary btn-sm" disabled={page <= 1} onClick={() => setPage(page - 1)} aria-label="Previous page"><ChevronLeft className="h-4 w-4" /></button>
        <span className="px-2">Page {page} of {pages}</span>
        <button className="btn btn-secondary btn-sm" disabled={page >= pages} onClick={() => setPage(page + 1)} aria-label="Next page"><ChevronRight className="h-4 w-4" /></button>
      </div>
    </div>
  )
}

/* ----------------------------------------------- notices ----------------------------------------------- */

const NOTICE: Record<string, { cls: string; icon: ReactNode }> = {
  info: { cls: 'border-[#e2d6f3] bg-[#f6f0fd] text-[#3d096d]', icon: <Info className="h-4 w-4" /> },
  warn: { cls: 'border-amber-200 bg-amber-50 text-amber-900', icon: <AlertTriangle className="h-4 w-4" /> },
  error: { cls: 'border-red-200 bg-red-50 text-red-700', icon: <XCircle className="h-4 w-4" /> },
  success: { cls: 'border-green-200 bg-green-50 text-green-800', icon: <CheckCircle2 className="h-4 w-4" /> }
}

export function Notice({ tone = 'info', children, className, onClose }: { tone?: 'info' | 'warn' | 'error' | 'success'; children: ReactNode; className?: string; onClose?: () => void }) {
  const n = NOTICE[tone]
  return (
    <div role={tone === 'error' ? 'alert' : 'status'} className={cx('flex items-start gap-2.5 rounded-xl border px-3.5 py-2.5 text-[13px]', n.cls, className)}>
      <span className="mt-0.5 shrink-0">{n.icon}</span>
      <div className="min-w-0 flex-1">{children}</div>
      {onClose && <button className="shrink-0 opacity-60 hover:opacity-100" onClick={onClose} aria-label="Dismiss"><X className="h-4 w-4" /></button>}
    </div>
  )
}

export function FieldError({ msg }: { msg?: string | null }) {
  return msg ? <span className="mt-1 block text-[12px] font-medium text-red-600">{msg}</span> : null
}

/* -------------------------------------------- empty / loading -------------------------------------------- */

export function EmptyState({ icon, title, hint, children }: { icon?: ReactNode; title: string; hint?: ReactNode; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-12 text-center">
      {icon && <div className="mb-3 rounded-2xl bg-[#f1e9fb] p-3 text-[#3d096d] [&>svg]:h-6 [&>svg]:w-6">{icon}</div>}
      <div className="font-bold">{title}</div>
      {hint && <div className="mt-1 max-w-md text-[13px] text-[#7a6d92]">{hint}</div>}
      {children && <div className="mt-4">{children}</div>}
    </div>
  )
}

export function Loading({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-2 py-12 text-[13px] text-[#7a6d92]">
      <Loader2 className="h-5 w-5 animate-spin text-[#3d096d]" />
      {label}
    </div>
  )
}

export function NoAccess({ what, need }: { what: string; need: string }) {
  return (
    <div className="card">
      <EmptyState icon={<Lock />} title={`You cannot open ${what}`} hint={`This needs the “${need}” permission. Ask the owner if you need it.`} />
    </div>
  )
}

/* --------------------------------------------- search box --------------------------------------------- */

export function SearchBox({ value, onChange, placeholder, className }: { value: string; onChange: (v: string) => void; placeholder: string; className?: string }) {
  return (
    <div className={cx('relative', className)}>
      <Search className="pointer-events-none absolute top-2.5 left-3 h-4 w-4 text-[#7a6d92]" />
      <input className="input pr-8 pl-9" placeholder={placeholder} value={value} onChange={(e) => onChange(e.target.value)} aria-label={placeholder} />
      {value && (
        <button className="absolute top-2.5 right-2.5 text-[#7a6d92] hover:text-[#1d1530]" onClick={() => onChange('')} aria-label="Clear search">
          <X className="h-4 w-4" />
        </button>
      )}
    </div>
  )
}

/* ------------------------------------------------ dialogs ------------------------------------------------ */

export function ConfirmDialog({
  open,
  title,
  children,
  confirmLabel,
  danger,
  busy,
  disabled,
  error,
  onConfirm,
  onClose
}: {
  open: boolean
  title: string
  children: ReactNode
  confirmLabel: string
  danger?: boolean
  busy?: boolean
  disabled?: boolean
  error?: string | null
  onConfirm: () => void
  onClose: () => void
}) {
  return (
    <Modal
      open={open}
      onClose={() => !busy && onClose()}
      title={title}
      footer={
        <>
          <button className="btn btn-secondary" onClick={onClose} disabled={busy}>Cancel</button>
          <button className={cx('btn', danger ? 'btn-danger' : 'btn-primary')} onClick={onConfirm} disabled={busy || disabled}>
            {busy && <Loader2 className="h-4 w-4 animate-spin" />}
            {confirmLabel}
          </button>
        </>
      }
    >
      <div className="space-y-3 text-[13.5px]">{children}</div>
      {error && <Notice tone="error" className="mt-3">{error}</Notice>}
    </Modal>
  )
}

export function Drawer({ open, onClose, title, children }: { open: boolean; onClose: () => void; title: string; children: ReactNode }) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    if (open) window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [open, onClose])
  if (!open) return null
  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/30" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <aside className="flex h-full w-full max-w-lg flex-col bg-white shadow-2xl" role="dialog" aria-label={title}>
        <div className="flex items-center justify-between border-b border-[#ece6f4] px-5 py-3.5">
          <div className="text-[16px] font-bold">{title}</div>
          <button className="rounded-lg p-1 hover:bg-[#f5f0fb]" onClick={onClose} aria-label="Close"><X className="h-5 w-5" /></button>
        </div>
        <div className="flex-1 overflow-y-auto px-5 py-4">{children}</div>
      </aside>
    </div>
  )
}

/* ------------------------------------------------- tabs ------------------------------------------------- */

export function Tabs<T extends string>({ tabs, active, onChange }: { tabs: { id: T; label: string; icon?: ReactNode }[]; active: T; onChange: (t: T) => void }) {
  return (
    <div className="mb-5 flex flex-wrap gap-1 rounded-xl border border-[#e7e1f0] bg-white p-1" role="tablist">
      {tabs.map((t) => (
        <button
          key={t.id}
          role="tab"
          aria-selected={active === t.id}
          className={cx(
            'flex h-9 items-center gap-2 rounded-lg px-3.5 text-[13.5px] font-semibold [&>svg]:h-4 [&>svg]:w-4',
            active === t.id ? 'bg-gradient-to-r from-[#7c3aed] to-[#c026d3] text-white shadow-sm' : 'text-[#6b5d85] hover:bg-[#f5f0fb] hover:text-[#1d1530]'
          )}
          onClick={() => onChange(t.id)}
        >
          {t.icon}
          {t.label}
        </button>
      ))}
    </div>
  )
}

/** Small icon button with a tooltip. */
export function IconButton({ title, onClick, children, danger, disabled }: { title: string; onClick: () => void; children: ReactNode; danger?: boolean; disabled?: boolean }) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      disabled={disabled}
      onClick={onClick}
      className={cx(
        'inline-flex h-8 w-8 items-center justify-center rounded-lg border border-transparent disabled:cursor-not-allowed disabled:opacity-40 [&>svg]:h-4 [&>svg]:w-4',
        danger ? 'text-red-600 hover:border-red-200 hover:bg-red-50' : 'text-[#5b4b78] hover:border-[#e2d6f3] hover:bg-[#f6f0fd]'
      )}
    >
      {children}
    </button>
  )
}

/** Triggers a browser download of text content. */
export function downloadText(name: string, contents: string, type = 'text/plain;charset=utf-8') {
  const a = document.createElement('a')
  a.href = URL.createObjectURL(new Blob([contents], { type }))
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(a.href), 2000)
}

/* ------------------------------------------- skeletons / errors ------------------------------------------- */

/** Shimmering placeholder block. */
export function Skeleton({ className, style }: { className?: string; style?: CSSProperties }) {
  return <span aria-hidden className={cx('skeleton', className ?? 'h-4 w-full')} style={style} />
}

/** Table-shaped loading placeholder for one section. */
export function SkeletonRows({ rows = 6, cols = 5, label = 'Loading…' }: { rows?: number; cols?: number; label?: string }) {
  return (
    <div className="px-4 py-3" role="status" aria-label={label}>
      {Array.from({ length: rows }, (_, r) => (
        <div key={r} className="flex gap-4 border-b border-[#f3eff8] py-2.5 last:border-0">
          {Array.from({ length: cols }, (_, c) => <Skeleton key={c} className="h-3.5" style={{ flex: c === 1 ? 2 : 1, opacity: 1 - r * 0.08 }} />)}
        </div>
      ))}
    </div>
  )
}

/** Section error with a retry button. */
export function ErrorState({ title = 'Could not load this section', error, onRetry }: { title?: string; error: string; onRetry?: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-10 text-center" role="alert">
      <div className="mb-3 rounded-2xl bg-red-50 p-3 text-red-600"><XCircle className="h-6 w-6" /></div>
      <div className="font-bold">{title}</div>
      <div className="mt-1 max-w-md text-[12.5px] break-words text-[#7a6d92]">{error}</div>
      {onRetry && <button className="btn btn-secondary btn-sm mt-4" onClick={onRetry}><RefreshCw className="h-4 w-4" />Try again</button>}
    </div>
  )
}

/* ------------------------------------------------ stat card ------------------------------------------------ */

const STAT_TONES = {
  brand: 'bg-[#f1e9fb] text-[#3d096d]',
  green: 'bg-green-50 text-green-700',
  amber: 'bg-amber-50 text-amber-700',
  red: 'bg-red-50 text-red-600',
  sky: 'bg-sky-50 text-sky-700',
  slate: 'bg-slate-100 text-slate-600'
} as const
export type StatTone = keyof typeof STAT_TONES

/** Summary card: icon, label, big value, optional sub line; `loading` shows a skeleton; `to` makes it a link. */
export function StatCard({ icon, label, value, sub, tone = 'brand', loading, to, title }: { icon?: ReactNode; label: string; value: ReactNode; sub?: ReactNode; tone?: StatTone; loading?: boolean; to?: string; title?: string }) {
  const body = (
    <div className={cx('card h-full px-4 py-3.5', to && 'transition hover:border-[#d9c9f0] hover:shadow-md')} title={title}>
      <div className="flex items-center gap-2.5">
        {icon && <span className={cx('flex h-8 w-8 shrink-0 items-center justify-center rounded-lg [&>svg]:h-4 [&>svg]:w-4', STAT_TONES[tone])}>{icon}</span>}
        <span className="min-w-0 text-[12.5px] leading-tight font-semibold text-[#6b5d85]">{label}</span>
      </div>
      <div className="mt-2 text-[22px] leading-tight font-extrabold text-[#1d1530] tabular-nums">{loading ? <Skeleton className="h-6 w-20" /> : value}</div>
      {sub !== undefined && <div className="mt-0.5 min-h-[18px] text-[12px] text-[#7a6d92]">{loading ? <Skeleton className="mt-1 h-3 w-28" /> : sub}</div>}
    </div>
  )
  return to ? <Link to={to} className="block h-full">{body}</Link> : body
}

/** Card with a header row (title, optional sub + actions) used for page sections. */
export function Section({ title, sub, actions, children, className, bodyClass }: { title?: ReactNode; sub?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string; bodyClass?: string }) {
  return (
    <section className={cx('card overflow-hidden', className)}>
      {(title || actions) && (
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#ece6f4] px-4 py-3">
          <div className="min-w-0">
            {title && <h2 className="flex items-center gap-2 text-[15px] font-bold [&>svg]:h-4 [&>svg]:w-4">{title}</h2>}
            {sub && <div className="text-[12px] text-[#7a6d92]">{sub}</div>}
          </div>
          {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
        </div>
      )}
      <div className={bodyClass}>{children}</div>
    </section>
  )
}

/* ------------------------------------------------- toasts ------------------------------------------------- */

export type ToastTone = 'success' | 'error' | 'info'
interface ToastItem { id: number; tone: ToastTone; text: ReactNode }
type ToastFn = (text: ReactNode, tone?: ToastTone) => void
const ToastCtx = createContext<ToastFn | null>(null)

/** Short-lived confirmation messages (bottom right). Wrap the app once. */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([])
  const seq = useRef(0)
  const close = useCallback((id: number) => setItems((l) => l.filter((t) => t.id !== id)), [])
  const push = useCallback<ToastFn>((text, tone = 'success') => {
    const id = ++seq.current
    setItems((l) => [...l.slice(-3), { id, tone, text }])
    setTimeout(() => close(id), tone === 'error' ? 8000 : 4500)
  }, [close])
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="pointer-events-none fixed right-4 bottom-4 z-[60] flex w-[360px] max-w-[calc(100vw-2rem)] flex-col gap-2" aria-live="polite">
        {items.map((t) => (
          <div key={t.id} role={t.tone === 'error' ? 'alert' : 'status'} className={cx('toast-in pointer-events-auto flex items-start gap-2.5 rounded-xl border bg-white px-3.5 py-3 text-[13px] shadow-lg', t.tone === 'error' ? 'border-red-200' : t.tone === 'success' ? 'border-green-200' : 'border-[#e2d6f3]')}>
            <span className={cx('mt-0.5 shrink-0 [&>svg]:h-4 [&>svg]:w-4', t.tone === 'error' ? 'text-red-600' : t.tone === 'success' ? 'text-green-600' : 'text-[#3d096d]')}>{t.tone === 'error' ? <XCircle /> : t.tone === 'success' ? <CheckCircle2 /> : <Info />}</span>
            <div className="min-w-0 flex-1">{t.text}</div>
            <button className="shrink-0 opacity-50 hover:opacity-100" onClick={() => close(t.id)} aria-label="Dismiss"><X className="h-4 w-4" /></button>
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  )
}

/** Returns the toast function (a no-op outside ToastProvider, e.g. in isolated renders). */
export function useToast(): ToastFn {
  return useContext(ToastCtx) ?? (() => undefined)
}
