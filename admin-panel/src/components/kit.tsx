/** Small reusable building blocks for portal pages (pagination, confirmations, drawers, tabs, notices). */
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { AlertTriangle, CheckCircle2, ChevronLeft, ChevronRight, Info, Loader2, Lock, Search, X, XCircle } from 'lucide-react'
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
