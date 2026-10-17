/** Small UI building blocks shared by the licensing pages (Dashboard, Clients, Licenses, Devices, Map). */
import { useEffect, useState, type ReactNode } from 'react'
import { AlertTriangle, CheckCircle2, ChevronLeft, ChevronRight, Info, Loader2, Search, X, XCircle } from 'lucide-react'
import { Modal, cx } from '../../components/ui'
import { paginate } from '../../lib/stats'

/* ------------------------------------------------ notices ------------------------------------------------ */

export type NoticeTone = 'success' | 'error' | 'warn' | 'info'
export interface NoticeMsg {
  tone: NoticeTone
  text: ReactNode
}

const NOTICE: Record<NoticeTone, { cls: string; icon: ReactNode }> = {
  success: { cls: 'border-green-200 bg-green-50 text-green-800', icon: <CheckCircle2 className="h-4 w-4 shrink-0" /> },
  error: { cls: 'border-red-200 bg-red-50 text-red-700', icon: <XCircle className="h-4 w-4 shrink-0" /> },
  warn: { cls: 'border-amber-200 bg-amber-50 text-amber-800', icon: <AlertTriangle className="h-4 w-4 shrink-0" /> },
  info: { cls: 'border-[#e2d6f3] bg-[#f6f0fd] text-[#3d096d]', icon: <Info className="h-4 w-4 shrink-0" /> }
}

export function Notice({ msg, onClose, className }: { msg: NoticeMsg | null; onClose?: () => void; className?: string }) {
  if (!msg) return null
  const n = NOTICE[msg.tone]
  return (
    <div role={msg.tone === 'error' ? 'alert' : 'status'} className={cx('mb-4 flex items-start gap-2 rounded-xl border px-3.5 py-2.5 text-[13.5px]', n.cls, className)}>
      <span className="mt-0.5">{n.icon}</span>
      <div className="flex-1">{msg.text}</div>
      {onClose && (
        <button className="rounded p-0.5 opacity-60 hover:opacity-100" onClick={onClose} aria-label="Dismiss">
          <X className="h-4 w-4" />
        </button>
      )}
    </div>
  )
}

/* ------------------------------------------------ status pills ------------------------------------------------ */

const PILL: Record<string, string> = {
  active: 'bg-green-100 text-green-700',
  approved: 'bg-green-100 text-green-700',
  paid: 'bg-green-100 text-green-700',
  online: 'bg-green-100 text-green-700',
  resolved: 'bg-green-100 text-green-700',
  pending: 'bg-sky-100 text-sky-700',
  recent: 'bg-amber-100 text-amber-700',
  partial: 'bg-amber-100 text-amber-700',
  suspended: 'bg-amber-100 text-amber-700',
  open: 'bg-amber-100 text-amber-700',
  unpaid: 'bg-red-100 text-red-700',
  revoked: 'bg-red-100 text-red-700',
  rejected: 'bg-red-100 text-red-700',
  expired: 'bg-red-100 text-red-700',
  overdue: 'bg-red-100 text-red-700',
  offline: 'bg-slate-200 text-slate-600',
  never: 'bg-slate-100 text-slate-500',
  deactivated: 'bg-slate-100 text-slate-600',
  released: 'bg-slate-100 text-slate-600',
  archived: 'bg-slate-100 text-slate-600',
  cancelled: 'bg-slate-100 text-slate-600',
  processed: 'bg-slate-100 text-slate-600',
  none: 'bg-slate-100 text-slate-500',
  unregistered: 'bg-slate-100 text-slate-500',
  detached: 'bg-fuchsia-100 text-fuchsia-700',
  lifetime: 'bg-[#efe4fb] text-[#3d096d]',
  monthly: 'bg-[#efe4fb] text-[#3d096d]',
  yearly: 'bg-[#efe4fb] text-[#3d096d]'
}

const PILL_LABEL: Record<string, string> = { deactivated: 'released', unregistered: 'not activated', never: 'no heartbeat', none: '-' }

export function Pill({ value, label, title }: { value: string; label?: string; title?: string }) {
  return (
    <span title={title} className={cx('inline-flex items-center gap-1 whitespace-nowrap rounded-md px-2 py-0.5 text-[12px] font-bold capitalize', PILL[value] ?? 'bg-[#f1e9fb] text-[#3d096d]')}>
      {(value === 'online' || value === 'recent' || value === 'offline') && (
        <span className={cx('inline-block h-1.5 w-1.5 rounded-full', value === 'online' ? 'bg-green-500' : value === 'recent' ? 'bg-amber-500' : 'bg-slate-400')} />
      )}
      {label ?? PILL_LABEL[value] ?? value}
    </span>
  )
}

/* ------------------------------------------------ layout ------------------------------------------------ */

export function Panel({ title, actions, children, className, sub }: { title?: ReactNode; sub?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cx('card', className)}>
      {(title || actions) && (
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#ece6f4] px-4 py-3">
          <div>
            <div className="font-bold">{title}</div>
            {sub && <div className="text-[12px] text-[#7a6d92]">{sub}</div>}
          </div>
          {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
        </div>
      )}
      {children}
    </section>
  )
}

export function Tabs<T extends string>({ tabs, value, onChange }: { tabs: { id: T; label: ReactNode }[]; value: T; onChange: (v: T) => void }) {
  return (
    <div className="mb-4 flex flex-wrap gap-1 rounded-xl border border-[#e7e1f0] bg-white p-1" role="tablist">
      {tabs.map((t) => (
        <button
          key={t.id}
          role="tab"
          aria-selected={value === t.id}
          className={cx('flex h-8 items-center gap-1.5 rounded-lg px-3 text-[13px] font-semibold', value === t.id ? 'bg-gradient-to-r from-[#7c3aed] to-[#c026d3] text-white shadow' : 'text-[#5b4d75] hover:bg-[#f5f0fb]')}
          onClick={() => onChange(t.id)}
        >
          {t.label}
        </button>
      ))}
    </div>
  )
}

export function SearchBox({ value, onChange, placeholder, className }: { value: string; onChange: (v: string) => void; placeholder: string; className?: string }) {
  return (
    <div className={cx('relative', className ?? 'w-72')}>
      <Search className="pointer-events-none absolute top-2.5 left-3 h-4 w-4 text-[#7a6d92]" />
      <input className="input pl-9" placeholder={placeholder} value={value} onChange={(e) => onChange(e.target.value)} aria-label={placeholder} />
    </div>
  )
}

export function Empty({ icon, title, children }: { icon?: ReactNode; title: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-10 text-center">
      {icon && <div className="mb-2 text-[#b9a6d6] [&>svg]:h-9 [&>svg]:w-9">{icon}</div>}
      <div className="font-semibold text-[#4a3d63]">{title}</div>
      {children && <div className="mt-1 max-w-md text-[13px] text-[#7a6d92]">{children}</div>}
    </div>
  )
}

export function Loading({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-2 py-10 text-[13px] text-[#7a6d92]">
      <Loader2 className="h-5 w-5 animate-spin text-[#7c3aed]" />
      {label}
    </div>
  )
}

/* ------------------------------------------------ pagination ------------------------------------------------ */

export function usePaged<T>(list: T[], size = 15, resetKey = '') {
  const [page, setPage] = useState(1)
  useEffect(() => setPage(1), [resetKey])
  const p = paginate(list, page, size)
  return { ...p, total: list.length, setPage }
}

export function Pager({ page, pages, from, to, total, setPage }: { page: number; pages: number; from: number; to: number; total: number; setPage: (p: number) => void }) {
  if (total === 0) return null
  return (
    <div className="flex items-center justify-between border-t border-[#ece6f4] px-4 py-2.5 text-[12.5px] text-[#6b5d85]">
      <div>
        {from}–{to} of {total}
      </div>
      <div className="flex items-center gap-1">
        <button className="btn btn-secondary btn-sm px-2" disabled={page <= 1} onClick={() => setPage(page - 1)} aria-label="Previous page">
          <ChevronLeft className="h-4 w-4" />
        </button>
        <span className="px-2 font-semibold">
          Page {page} / {pages}
        </span>
        <button className="btn btn-secondary btn-sm px-2" disabled={page >= pages} onClick={() => setPage(page + 1)} aria-label="Next page">
          <ChevronRight className="h-4 w-4" />
        </button>
      </div>
    </div>
  )
}

/* ------------------------------------------------ confirmation ------------------------------------------------ */

export interface ConfirmOptions {
  title: string
  body?: ReactNode
  confirmLabel: string
  tone?: 'primary' | 'danger' | 'success'
  /** Ask for a reason (required when `reasonRequired`). */
  reason?: boolean
  reasonRequired?: boolean
  reasonLabel?: string
  /** Require typing this word (e.g. REVOKE, DELETE, DETACH). */
  typeToConfirm?: string
  /** Extra form controls (rendered above the reason). */
  extra?: ReactNode
  run: (reason: string) => Promise<void>
}

/** Confirmation dialog with an optional reason and typed confirmation. Errors stay inside the dialog. */
export function ConfirmDialog({ opts, onClose }: { opts: ConfirmOptions | null; onClose: () => void }) {
  const [reason, setReason] = useState('')
  const [typed, setTyped] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  // Reset when a dialog opens / closes / switches - not on every re-render of the parent (opts is rebuilt each render,
  // which used to wipe the typed confirmation and re-enable the button while an action was running).
  const openKey = opts ? opts.title : null
  useEffect(() => {
    setReason('')
    setTyped('')
    setErr(null)
    setBusy(false)
  }, [openKey])
  if (!opts) return null
  const typedOk = !opts.typeToConfirm || typed.trim() === opts.typeToConfirm
  const reasonOk = !opts.reasonRequired || reason.trim().length >= 3
  const go = async () => {
    if (!typedOk) return setErr(`Type ${opts.typeToConfirm} to confirm.`)
    if (!reasonOk) return setErr('Enter a reason (at least 3 characters).')
    setBusy(true)
    setErr(null)
    try {
      await opts.run(reason.trim())
      onClose()
    } catch (e) {
      setErr((e as Error).message || String(e))
    } finally {
      setBusy(false)
    }
  }
  const btn = opts.tone === 'danger' ? 'btn-danger' : opts.tone === 'success' ? 'btn-success' : 'btn-primary'
  return (
    <Modal
      open
      onClose={() => !busy && onClose()}
      title={opts.title}
      footer={
        <>
          <button className="btn btn-secondary" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button className={cx('btn', btn)} disabled={busy || !typedOk || !reasonOk} onClick={go}>
            {busy && <Loader2 className="h-4 w-4 animate-spin" />}
            {opts.confirmLabel}
          </button>
        </>
      }
    >
      <div className="space-y-3 text-[13.5px]">
        {opts.body}
        {opts.extra}
        {opts.reason && (
          <label className="block">
            <span className="label">
              {opts.reasonLabel ?? 'Reason'} {opts.reasonRequired ? <span className="text-red-600">*</span> : <span className="font-normal">(optional)</span>}
            </span>
            <textarea className="input" rows={2} value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} autoFocus={!opts.typeToConfirm} />
          </label>
        )}
        {opts.typeToConfirm && (
          <label className="block">
            <span className="label">
              Type <b className="font-mono text-[#3d096d]">{opts.typeToConfirm}</b> to confirm
            </span>
            <input className="input font-mono" value={typed} onChange={(e) => setTyped(e.target.value)} autoFocus aria-label={`Type ${opts.typeToConfirm} to confirm`} />
          </label>
        )}
        {err && <div className="rounded-lg bg-red-50 p-2.5 text-[13px] text-red-700">{err}</div>}
      </div>
    </Modal>
  )
}

/* ------------------------------------------------ formatting ------------------------------------------------ */

export function fmtMoney(v: number | null | undefined, currency = 'PKR'): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '-'
  return `${currency} ${v.toLocaleString('en-PK', { maximumFractionDigits: 0 })}`
}

export function fmtCount(v: number | null | undefined): string {
  return v === null || v === undefined || !Number.isFinite(v) ? '-' : v.toLocaleString('en-PK')
}

/** Shows the last 6 characters of a long id (device ids / tokens are never shown in full in lists). */
export function shortId(id: string, n = 9): string {
  return id.length > n + 1 ? `…${id.slice(-n)}` : id
}

/** Re-render every `ms` so relative times / online badges stay current. */
export function useNow(ms = 60_000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms)
    return () => clearInterval(t)
  }, [ms])
  return now
}
