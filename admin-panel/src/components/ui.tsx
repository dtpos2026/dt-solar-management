import { ReactNode, useEffect } from 'react'
import { X } from 'lucide-react'

export function cx(...c: Array<string | false | null | undefined>): string {
  return c.filter(Boolean).join(' ')
}

export function Field({ label, children, hint, className }: { label: string; children: ReactNode; hint?: ReactNode; className?: string }) {
  return (
    <label className={cx('block', className)}>
      <span className="label">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-[12px] text-[#7a6d92]">{hint}</span>}
    </label>
  )
}

const TONES: Record<string, string> = {
  active: 'bg-green-100 text-green-700',
  approved: 'bg-green-100 text-green-700',
  processed: 'bg-slate-100 text-slate-600',
  pending: 'bg-amber-100 text-amber-700',
  suspended: 'bg-amber-100 text-amber-700',
  revoked: 'bg-red-100 text-red-700',
  rejected: 'bg-red-100 text-red-700',
  expired: 'bg-red-100 text-red-700',
  deactivated: 'bg-slate-100 text-slate-600'
}
export function Badge({ children, tone }: { children: ReactNode; tone?: string }) {
  return <span className={cx('inline-block rounded-md px-2 py-0.5 text-[11.5px] font-bold capitalize', TONES[tone ?? String(children)] ?? 'bg-[#f1e9fb] text-[#3d096d]')}>{children}</span>
}

export function Modal({ open, onClose, title, children, footer, wide }: { open: boolean; onClose: () => void; title: string; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    if (open) window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [open, onClose])
  if (!open) return null
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4 pt-[6vh]" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={cx('card w-full shadow-2xl', wide ? 'max-w-3xl' : 'max-w-lg')}>
        <div className="flex items-center justify-between border-b border-[#ece6f4] px-5 py-3.5">
          <div className="text-[16px] font-bold">{title}</div>
          <button className="rounded-lg p-1 hover:bg-[#f5f0fb]" onClick={onClose}><X className="h-5 w-5" /></button>
        </div>
        <div className="max-h-[72vh] overflow-y-auto px-5 py-4">{children}</div>
        {footer && <div className="flex justify-end gap-2 border-t border-[#ece6f4] px-5 py-3">{footer}</div>}
      </div>
    </div>
  )
}

/** Page header: title + short subtitle on the left, actions (primary last) on the right. */
export function PageTitle({ title, sub, actions, icon }: { title: string; sub?: ReactNode; actions?: ReactNode; icon?: ReactNode }) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3 border-b border-[#ebe5f3] pb-4">
      <div className="flex min-w-0 items-center gap-3">
        {icon && <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[#f1e9fb] text-[#3d096d] [&>svg]:h-5 [&>svg]:w-5">{icon}</span>}
        <div className="min-w-0">
          <h1 className="text-[22px] leading-tight font-extrabold tracking-tight">{title}</h1>
          {sub && <div className="mt-0.5 text-[13px] text-[#7a6d92]">{sub}</div>}
        </div>
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  )
}

export function Stat({ label, value, tone }: { label: string; value: ReactNode; tone?: string }) {
  return (
    <div className="card p-4">
      <div className="text-[12.5px] font-semibold text-[#7a6d92]">{label}</div>
      <div className={cx('mt-1 text-[24px] font-extrabold', tone)}>{value}</div>
    </div>
  )
}

export function copy(text: string) {
  navigator.clipboard.writeText(text).catch(() => undefined)
}

export function download(name: string, contents: string) {
  const a = document.createElement('a')
  a.href = URL.createObjectURL(new Blob([contents], { type: 'application/json' }))
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 2000)
}
