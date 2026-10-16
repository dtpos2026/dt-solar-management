import { ReactNode, useEffect, useRef, useState, ButtonHTMLAttributes, InputHTMLAttributes, SelectHTMLAttributes, TextareaHTMLAttributes, forwardRef } from 'react'
import { createPortal } from 'react-dom'
import { create } from 'zustand'
import { AlertTriangle, CheckCircle2, Info, Loader2, X, XCircle, ArrowDownRight, ArrowUpRight } from 'lucide-react'
import { PERIODS } from '../lib/format'

export function cx(...c: Array<string | false | null | undefined>): string {
  return c.filter(Boolean).join(' ')
}

/* ------------------------------ Button ------------------------------ */
type BtnVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'soft' | 'success'
interface BtnProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: BtnVariant
  size?: 'sm' | 'md' | 'lg'
  icon?: ReactNode
  loading?: boolean
}
const VARIANTS: Record<BtnVariant, string> = {
  primary: 'bg-brand text-on-brand hover:bg-brand-600 shadow-sm',
  secondary: 'bg-surface text-ink border border-line hover:bg-surface-2',
  ghost: 'text-ink hover:bg-surface-2',
  danger: 'bg-bad text-white hover:opacity-90',
  soft: 'bg-brand-soft text-brand hover:brightness-95',
  success: 'bg-ok text-white hover:opacity-90'
}
export const Button = forwardRef<HTMLButtonElement, BtnProps>(function Button(
  { variant = 'secondary', size = 'md', icon, loading, className, children, disabled, ...rest },
  ref
) {
  return (
    <button
      ref={ref}
      disabled={disabled || loading}
      className={cx(
        'inline-flex items-center justify-center gap-2 rounded-[9px] font-medium transition select-none whitespace-nowrap disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer',
        size === 'sm' ? 'h-8 px-3 text-[13px]' : size === 'lg' ? 'h-11 px-5 text-[15px]' : 'h-9 px-4',
        VARIANTS[variant],
        className
      )}
      {...rest}
    >
      {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : icon}
      {children}
    </button>
  )
})

export function IconButton({ title, onClick, children, className, disabled, tone }: { title: string; onClick?: () => void; children: ReactNode; className?: string; disabled?: boolean; tone?: 'bad' }): JSX.Element {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation()
        onClick?.()
      }}
      className={cx('inline-flex h-8 w-8 items-center justify-center rounded-lg text-muted hover:bg-surface-2 hover:text-ink disabled:opacity-40 cursor-pointer', tone === 'bad' && 'hover:text-bad', className)}
    >
      {children}
    </button>
  )
}

/* ------------------------------ Form controls ------------------------------ */
export function Field({ label, hint, error, children, className, required }: { label?: ReactNode; hint?: ReactNode; error?: string; children: ReactNode; className?: string; required?: boolean }): JSX.Element {
  return (
    <label className={cx('block', className)}>
      {label && (
        <span className="mb-1 block text-[12.5px] font-medium text-muted">
          {label}
          {required && <span className="text-bad"> *</span>}
        </span>
      )}
      {children}
      {hint && !error && <span className="mt-1 block text-[12px] leading-snug text-muted">{hint}</span>}
      {error && (
        <span role="alert" className="mt-1 flex items-start gap-1 text-[12px] leading-snug font-medium text-bad">
          <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" />
          {error}
        </span>
      )}
    </label>
  )
}

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement> & { sm?: boolean }>(function Input({ className, sm, ...rest }, ref) {
  return <input ref={ref} className={cx('input', sm && 'input-sm', className)} {...rest} />
})

export function NumberInput({ value, onChange, className, sm, min, step, placeholder, disabled, autoFocus }: { value: number | string | null | undefined; onChange: (v: number) => void; className?: string; sm?: boolean; min?: number; step?: number | string; placeholder?: string; disabled?: boolean; autoFocus?: boolean }): JSX.Element {
  const [text, setText] = useState<string>(value === null || value === undefined ? '' : String(value))
  const focused = useRef(false)
  useEffect(() => {
    if (!focused.current) setText(value === null || value === undefined ? '' : String(value))
  }, [value])
  return (
    <input
      type="text"
      inputMode="decimal"
      className={cx('input num text-right', sm && 'input-sm', className)}
      value={text}
      placeholder={placeholder ?? '0'}
      disabled={disabled}
      autoFocus={autoFocus}
      min={min}
      step={step}
      onFocus={(e) => {
        focused.current = true
        e.target.select()
      }}
      onBlur={() => {
        focused.current = false
        const n = Number(text.replace(/,/g, ''))
        setText(text === '' ? '' : Number.isFinite(n) ? String(n) : '')
      }}
      onChange={(e) => {
        const t = e.target.value.replace(/[^\d.,-]/g, '')
        setText(t)
        const n = Number(t.replace(/,/g, ''))
        onChange(Number.isFinite(n) ? n : 0)
      }}
    />
  )
}

export function Textarea({ className, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement>): JSX.Element {
  return <textarea className={cx('input', className)} rows={3} {...rest} />
}

export function Select({ className, children, sm, ...rest }: SelectHTMLAttributes<HTMLSelectElement> & { sm?: boolean }): JSX.Element {
  return (
    <select className={cx('input cursor-pointer pr-8', sm && 'input-sm', className)} {...rest}>
      {children}
    </select>
  )
}

export function Toggle({ checked, onChange, disabled, label, description }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; label?: ReactNode; description?: ReactNode }): JSX.Element {
  const btn = (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cx('relative h-6 w-11 shrink-0 rounded-full transition cursor-pointer disabled:opacity-50', checked ? 'bg-brand' : 'bg-line')}
    >
      <span className={cx('absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all', checked ? 'left-[22px]' : 'left-0.5')} />
    </button>
  )
  if (!label) return btn
  return (
    <div className="flex items-start justify-between gap-6">
      <div>
        <div className="font-medium">{label}</div>
        {description && <div className="mt-0.5 text-[12.5px] text-muted">{description}</div>}
      </div>
      {btn}
    </div>
  )
}

export function Checkbox({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: ReactNode; disabled?: boolean }): JSX.Element {
  return (
    <label className={cx('inline-flex cursor-pointer items-center gap-2 select-none', disabled && 'opacity-60')}>
      <input type="checkbox" className="h-4 w-4 accent-[var(--brand)]" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span>{label}</span>
    </label>
  )
}

/* ------------------------------ Layout bits ------------------------------ */
export function Card({ children, className, title, actions, pad = true }: { children: ReactNode; className?: string; title?: ReactNode; actions?: ReactNode; pad?: boolean }): JSX.Element {
  return (
    <div className={cx('card', className)}>
      {(title || actions) && (
        <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-3">
          <div className="font-semibold">{title}</div>
          <div className="flex items-center gap-2">{actions}</div>
        </div>
      )}
      <div className={pad ? 'p-4' : 'min-w-0 overflow-x-auto'}>{children}</div>
    </div>
  )
}

export function PageHeader({ title, subtitle, actions, icon }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode; icon?: ReactNode }): JSX.Element {
  return (
    <div className="mb-4 flex flex-wrap items-center gap-x-4 gap-y-3">
      <div className="flex min-w-0 flex-[1_1_320px] items-center gap-3">
        {icon && <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-brand-soft text-brand">{icon}</div>}
        <div className="min-w-0">
          <h1 className="text-[20px] leading-tight font-bold tracking-tight">{title}</h1>
          {subtitle && <div className="mt-0.5 text-[13px] text-muted">{subtitle}</div>}
        </div>
      </div>
      {actions && <div className="ml-auto flex flex-wrap items-center justify-end gap-2">{actions}</div>}
    </div>
  )
}

const TONES: Record<string, string> = {
  ok: 'bg-ok-soft text-ok',
  warn: 'bg-warn-soft text-warn',
  bad: 'bg-bad-soft text-bad',
  info: 'bg-info-soft text-info',
  brand: 'bg-brand-soft text-brand',
  muted: 'bg-surface-2 text-muted border border-line'
}
export function Badge({ tone = 'muted', children, className }: { tone?: string; children: ReactNode; className?: string }): JSX.Element {
  return <span className={cx('inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[12px] leading-[18px] font-semibold whitespace-nowrap', TONES[tone] ?? TONES.muted, className)}>{children}</span>
}

export function Spinner({ className }: { className?: string }): JSX.Element {
  return <Loader2 className={cx('h-5 w-5 animate-spin text-brand', className)} />
}

export function Loading({ label = 'Loading…' }: { label?: string }): JSX.Element {
  return (
    <div className="flex items-center justify-center gap-3 py-16 text-muted">
      <Spinner /> {label}
    </div>
  )
}

export function Empty({ icon, title, children, action }: { icon?: ReactNode; title: string; children?: ReactNode; action?: ReactNode }): JSX.Element {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-14 text-center">
      {icon && <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-brand-soft text-brand">{icon}</div>}
      <div className="font-semibold">{title}</div>
      {children && <div className="mt-1 max-w-md text-[13px] text-muted">{children}</div>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  )
}

export function Tabs<T extends string>({ tabs, value, onChange, className }: { tabs: Array<{ key: T; label: ReactNode; count?: number; hidden?: boolean }>; value: T; onChange: (k: T) => void; className?: string }): JSX.Element {
  return (
    <div className={cx('mb-4 flex flex-wrap gap-1 rounded-xl border border-line bg-surface p-1', className)}>
      {tabs
        .filter((t) => !t.hidden)
        .map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => onChange(t.key)}
            className={cx('flex h-8 items-center gap-2 rounded-lg px-3 text-[13px] font-medium transition cursor-pointer', value === t.key ? 'bg-brand text-on-brand shadow-sm' : 'text-muted hover:bg-surface-2 hover:text-ink')}
          >
            {t.label}
            {t.count !== undefined && <span className={cx('num rounded px-1.5 text-[12px]', value === t.key ? 'bg-white/20' : 'bg-surface-2')}>{t.count}</span>}
          </button>
        ))}
    </div>
  )
}

export function StatCard({ label, value, icon, tone = 'brand', trend, sub, onClick }: { label: string; value: ReactNode; icon?: ReactNode; tone?: 'brand' | 'ok' | 'warn' | 'bad' | 'info' | 'sun'; trend?: number | null; sub?: ReactNode; onClick?: () => void }): JSX.Element {
  const toneBg: Record<string, string> = {
    brand: 'from-brand to-brand-600',
    ok: 'from-emerald-500 to-emerald-600',
    warn: 'from-amber-500 to-orange-500',
    bad: 'from-rose-500 to-red-600',
    info: 'from-sky-500 to-cyan-600',
    sun: 'from-orange-400 to-amber-500'
  }
  return (
    <div onClick={onClick} className={cx('card fade-in p-4', onClick && 'cursor-pointer transition hover:-translate-y-0.5 hover:shadow-md')}>
      <div className="flex items-center gap-3">
        {icon && <div className={cx('flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br text-white shadow-sm [&>svg]:h-5 [&>svg]:w-5', toneBg[tone])}>{icon}</div>}
        <div className="min-w-0 flex-1 text-[13px] leading-tight font-medium text-muted">{label}</div>
      </div>
      <div className="num mt-2.5 text-[19px] leading-snug font-bold tracking-tight [overflow-wrap:anywhere]">{value}</div>
      {(trend !== undefined || sub) && (
        <div className="mt-1.5 flex flex-wrap items-center justify-between gap-x-2 text-[12px]">
          {trend !== undefined && trend !== null ? (
            <span className={cx('inline-flex items-center gap-0.5 font-semibold', trend >= 0 ? 'text-ok' : 'text-bad')}>
              {trend >= 0 ? <ArrowUpRight className="h-3.5 w-3.5" /> : <ArrowDownRight className="h-3.5 w-3.5" />}
              {Math.abs(trend).toFixed(1)}%
            </span>
          ) : (
            <span />
          )}
          {sub && <span className="text-muted">{sub}</span>}
        </div>
      )}
    </div>
  )
}

/* ------------------------------ Modal ------------------------------ */
export function Modal({ open, onClose, title, children, footer, size = 'md', subtitle }: { open: boolean; onClose: () => void; title: ReactNode; subtitle?: ReactNode; children: ReactNode; footer?: ReactNode; size?: 'sm' | 'md' | 'lg' | 'xl' | 'full' }): JSX.Element | null {
  useEffect(() => {
    if (!open) return
    const h = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [open, onClose])
  if (!open) return null
  const w = { sm: 'max-w-md', md: 'max-w-2xl', lg: 'max-w-4xl', xl: 'max-w-6xl', full: 'max-w-[1400px]' }[size]
  return createPortal(
    <div data-overlay="modal" className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/45 p-3 pt-[3vh] backdrop-blur-[2px] sm:p-4" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={cx('card fade-in flex max-h-[94vh] w-full flex-col shadow-2xl', w)} role="dialog" aria-modal="true">
        <div className="flex items-start justify-between gap-4 border-b border-line px-5 py-4">
          <div>
            <div className="text-[16px] leading-snug font-semibold">{title}</div>
            {subtitle && <div className="mt-0.5 text-[12.5px] text-muted">{subtitle}</div>}
          </div>
          <IconButton title="Close" onClick={onClose}>
            <X className="h-5 w-5" />
          </IconButton>
        </div>
        <div className="flex-1 overflow-y-auto px-5 py-4">{children}</div>
        {footer && <div className="flex flex-wrap items-center justify-end gap-2 border-t border-line px-5 py-3">{footer}</div>}
      </div>
    </div>,
    document.body
  )
}

/* ------------------------------ Toasts ------------------------------ */
interface Toast {
  id: number
  tone: 'ok' | 'bad' | 'info' | 'warn'
  text: string
}
const useToasts = create<{ items: Toast[]; push: (t: Omit<Toast, 'id'>) => void; remove: (id: number) => void }>((set) => ({
  items: [],
  push: (t) => {
    const id = Date.now() + Math.random()
    set((s) => ({ items: [...s.items, { ...t, id }] }))
    setTimeout(() => set((s) => ({ items: s.items.filter((x) => x.id !== id) })), t.tone === 'bad' ? 7000 : 3500)
  },
  remove: (id) => set((s) => ({ items: s.items.filter((x) => x.id !== id) }))
}))

export const toast = {
  ok: (text: string): void => useToasts.getState().push({ tone: 'ok', text }),
  error: (e: unknown): void => useToasts.getState().push({ tone: 'bad', text: e instanceof Error ? e.message : String(e) }),
  info: (text: string): void => useToasts.getState().push({ tone: 'info', text }),
  warn: (text: string): void => useToasts.getState().push({ tone: 'warn', text })
}

export function Toaster(): JSX.Element {
  const { items, remove } = useToasts()
  const icon = { ok: <CheckCircle2 className="h-5 w-5 text-ok" />, bad: <XCircle className="h-5 w-5 text-bad" />, info: <Info className="h-5 w-5 text-info" />, warn: <AlertTriangle className="h-5 w-5 text-warn" /> }
  return createPortal(
    <div className="no-print fixed right-4 bottom-4 z-[70] flex w-[380px] max-w-[calc(100vw-2rem)] flex-col gap-2">
      {items.map((t) => (
        <div key={t.id} data-overlay="toast" className="card fade-in flex items-start gap-3 px-4 py-3 shadow-lg" onClick={() => remove(t.id)}>
          {icon[t.tone]}
          <div className="flex-1 text-[13px]">{t.text}</div>
        </div>
      ))}
    </div>,
    document.body
  )
}

/* ------------------------------ Confirm / prompt ------------------------------ */
interface DialogReq {
  title: string
  message?: ReactNode
  confirmLabel?: string
  danger?: boolean
  input?: { label: string; placeholder?: string; required?: boolean; mustEqual?: string }
  resolve: (v: string | boolean | null) => void
}
const useDialog = create<{ req: DialogReq | null; set: (r: DialogReq | null) => void }>((set) => ({ req: null, set: (req) => set({ req }) }))

export function confirmDialog(opts: Omit<DialogReq, 'resolve' | 'input'>): Promise<boolean> {
  return new Promise((resolve) => useDialog.getState().set({ ...opts, resolve: (v) => resolve(!!v) }))
}

export function promptDialog(opts: Omit<DialogReq, 'resolve'> & { input: NonNullable<DialogReq['input']> }): Promise<string | null> {
  return new Promise((resolve) => useDialog.getState().set({ ...opts, resolve: (v) => resolve(typeof v === 'string' ? v : null) }))
}

export function DialogHost(): JSX.Element | null {
  const { req, set } = useDialog()
  const [text, setText] = useState('')
  useEffect(() => setText(''), [req])
  if (!req) return null
  const close = (v: string | boolean | null): void => {
    req.resolve(v)
    set(null)
  }
  const invalid = !!req.input && ((req.input.required && !text.trim()) || (req.input.mustEqual !== undefined && text.trim() !== req.input.mustEqual))
  return (
    <Modal
      open
      onClose={() => close(null)}
      title={req.title}
      size="sm"
      footer={
        <>
          <Button onClick={() => close(null)}>Cancel</Button>
          <Button variant={req.danger ? 'danger' : 'primary'} disabled={invalid} onClick={() => close(req.input ? text.trim() : true)} autoFocus={!req.input}>
            {req.confirmLabel ?? 'Confirm'}
          </Button>
        </>
      }
    >
      {req.message && <div className="text-[13.5px] leading-relaxed text-muted">{req.message}</div>}
      {req.input && (
        <Field label={req.input.label} className="mt-3">
          <Input autoFocus value={text} placeholder={req.input.placeholder} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && !invalid && close(text.trim())} />
        </Field>
      )}
    </Modal>
  )
}

/* ------------------------------ Period picker ------------------------------ */
export function PeriodPicker({ from, to, onChange }: { from: string; to: string; onChange: (from: string, to: string) => void }): JSX.Element {
  const current = PERIODS.find((p) => {
    const [a, b] = p.range()
    return a === from && b === to
  })
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Select
        sm
        className="w-36"
        value={current?.key ?? 'custom'}
        onChange={(e) => {
          const p = PERIODS.find((x) => x.key === e.target.value)
          if (p) onChange(...p.range())
        }}
      >
        {PERIODS.map((p) => (
          <option key={p.key} value={p.key}>
            {p.label}
          </option>
        ))}
        <option value="custom">Custom range</option>
      </Select>
      <Input sm type="date" className="num w-[9.5rem]" value={from} onChange={(e) => e.target.value && onChange(e.target.value, to)} />
      <span className="text-muted">→</span>
      <Input sm type="date" className="num w-[9.5rem]" value={to} onChange={(e) => e.target.value && onChange(from, e.target.value)} />
    </div>
  )
}

/* ------------------------------ Misc ------------------------------ */
export function Kv({ label, children, className }: { label: ReactNode; children: ReactNode; className?: string }): JSX.Element {
  return (
    <div className={cx('flex items-baseline justify-between gap-4 py-1.5', className)}>
      <span className="text-muted">{label}</span>
      <span className="num text-right font-medium">{children}</span>
    </div>
  )
}

export function Progress({ value, tone = 'brand' }: { value: number; tone?: 'brand' | 'ok' | 'warn' }): JSX.Element {
  const c = { brand: 'bg-brand', ok: 'bg-ok', warn: 'bg-warn' }[tone]
  return (
    <div className="h-2 w-full overflow-hidden rounded-full bg-surface-2">
      <div className={cx('h-full rounded-full transition-all', c)} style={{ width: `${Math.max(0, Math.min(100, value))}%` }} />
    </div>
  )
}

/** Resize an image file client-side and return a data URL (keeps the database small). */
export function readImageFile(file: File, maxSize = 600): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!/^image\/(png|jpe?g|webp|gif|svg\+xml)$/.test(file.type)) return reject(new Error('Please choose a PNG, JPG or WEBP image.'))
    if (file.size > 8 * 1024 * 1024) return reject(new Error('Image is larger than 8 MB.'))
    const reader = new FileReader()
    reader.onerror = () => reject(new Error('Could not read the image.'))
    reader.onload = () => {
      const src = String(reader.result)
      if (file.type === 'image/svg+xml') return resolve(src)
      const img = new Image()
      img.onload = () => {
        const scale = Math.min(1, maxSize / Math.max(img.width, img.height))
        const c = document.createElement('canvas')
        c.width = Math.round(img.width * scale)
        c.height = Math.round(img.height * scale)
        const g = c.getContext('2d')!
        g.drawImage(img, 0, 0, c.width, c.height)
        resolve(c.toDataURL('image/png'))
      }
      img.onerror = () => reject(new Error('Invalid image file.'))
      img.src = src
    }
    reader.readAsDataURL(file)
  })
}
