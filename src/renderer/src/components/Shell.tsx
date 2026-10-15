import { ReactNode, useEffect, useRef, useState } from 'react'
import { NavLink, useNavigate } from 'react-router-dom'
import {
  BarChart3, CalendarCheck, LifeBuoy, Bell, Boxes, Building2, CalendarDays, ChevronDown, DatabaseBackup, FileText, KeyRound, Landmark,
  LayoutDashboard, Lock, LogOut, Palette, Receipt, Search, Settings, ShieldCheck, ShoppingBag, ShoppingCart, SunMedium, Truck, Users, Check, AlertTriangle,
  RectangleEllipsis
} from 'lucide-react'
import { api } from '../api'
import { useApp, useCan } from '../store'
import { Button, Field, Input, Modal, confirmDialog, cx, toast } from './ui'
import { THEMES, applyTheme, getTheme } from '../lib/theme'
import { date, label as nice } from '../lib/format'
import appIcon from '../assets/app-icon.png'
import { DtMark } from './Brand'
import { SETTINGS_ENTRY_PERMS } from '../pages/settings/sections'
import { PIN_RE, PinInput } from '../pages/users/PinInput'

const NAV: Array<{ to: string; label: string; icon: ReactNode; perm?: string | string[]; section?: string }> = [
  { to: '/', label: 'Dashboard', icon: <LayoutDashboard />, perm: 'dashboard.view' },
  { to: '/sales', label: 'Sales', icon: <ShoppingCart />, perm: 'sales.view', section: 'Trading' },
  { to: '/quotations', label: 'Quotations', icon: <FileText />, perm: 'quotations.view' },
  { to: '/purchases', label: 'Purchases', icon: <ShoppingBag />, perm: 'purchases.view' },
  { to: '/inventory', label: 'Inventory', icon: <Boxes />, perm: 'inventory.view' },
  { to: '/customers', label: 'Customers', icon: <Users />, perm: 'customers.view', section: 'Parties' },
  { to: '/suppliers', label: 'Suppliers', icon: <Truck />, perm: 'suppliers.view' },
  { to: '/projects', label: 'Solar Projects', icon: <SunMedium />, perm: 'projects.view', section: 'Projects & Money' },
  { to: '/accounts', label: 'Accounts', icon: <Landmark />, perm: 'accounts.view' },
  { to: '/expenses', label: 'Expenses', icon: <Receipt />, perm: 'expenses.view' },
  { to: '/closing', label: 'Day Closing', icon: <CalendarCheck />, perm: 'closing.manage' },
  { to: '/reports', label: 'Reports', icon: <BarChart3 />, perm: ['reports.view', 'reports.profit'] },
  { to: '/users', label: 'Users & Permissions', icon: <ShieldCheck />, perm: ['users.manage', 'audit.view'], section: 'Administration' },
  { to: '/firms', label: 'Multi-Firm Settings', icon: <Building2 />, perm: 'firms.manage' },
  { to: '/backup', label: 'Backup & Restore', icon: <DatabaseBackup />, perm: ['backup.manage', 'import.manage'] },
  { to: '/settings', label: 'Settings', icon: <Settings />, perm: SETTINGS_ENTRY_PERMS },
  { to: '/help', label: 'Help & Support', icon: <LifeBuoy /> }
]

function Sidebar(): JSX.Element {
  const can = useCan()
  const firm = useApp((s) => s.firm)
  const items = NAV.filter((n) => !n.perm || (Array.isArray(n.perm) ? n.perm.some(can) : can(n.perm)))
  let lastSection = ''
  return (
    <aside className="no-print flex w-[232px] shrink-0 flex-col bg-side text-side-ink">
      {/* White-label: the licensed business (active firm) is shown here; Digital Target stays in the footer. */}
      <div className="flex items-center gap-3 px-5 pt-5 pb-4">
        {firm?.logo ? (
          <img src={firm.logo} className="h-10 w-10 shrink-0 rounded-xl bg-white object-contain p-0.5 shadow-lg" alt="" />
        ) : (
          <img src={appIcon} className="h-10 w-10 shrink-0 rounded-xl shadow-lg" alt="" />
        )}
        <div className="min-w-0 leading-tight">
          {firm?.name ? (
            <div className="line-clamp-2 text-[14px] font-extrabold break-words text-white" title={firm.name}>{firm.name}</div>
          ) : (
            <div className="text-[17px] font-extrabold text-white">
              DT Solar <span className="text-sun">Pro</span>
            </div>
          )}
          <div className="text-[10.5px] opacity-70">{firm?.name ? 'DT Solar Pro' : 'Powering a Greener Future'}</div>
        </div>
      </div>
      <nav className="flex-1 overflow-y-auto px-3 pb-3">
        {items.map((n) => {
          const header = n.section && n.section !== lastSection ? n.section : null
          if (n.section) lastSection = n.section
          return (
            <div key={n.to}>
              {header && <div className="mt-4 mb-1 px-3 text-[10.5px] font-semibold tracking-wider uppercase opacity-50">{header}</div>}
              <NavLink
                to={n.to}
                end={n.to === '/'}
                className={({ isActive }) =>
                  cx(
                    'mb-0.5 flex h-9 items-center gap-3 rounded-lg px-3 text-[13.5px] font-medium transition [&>svg]:h-[18px] [&>svg]:w-[18px]',
                    isActive ? 'bg-side-active text-white shadow-md' : 'hover:bg-white/8 hover:text-white'
                  )
                }
              >
                {n.icon}
                {n.label}
              </NavLink>
            </div>
          )
        })}
      </nav>
      <div className="border-t border-white/10 px-5 py-3 text-[11px] opacity-70">
        <div className="flex items-center gap-2">
          <DtMark className="h-3.5 w-3.5" />
          <span>
            DT Solar Pro by <b className="tracking-wider">DIGITAL TARGET</b>
          </span>
        </div>
      </div>
    </aside>
  )
}

function FirmSwitcher(): JSX.Element {
  const { firm, firms, settings, refresh } = useApp()
  const [open, setOpen] = useState(false)
  const nav = useNavigate()
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const h = (e: MouseEvent): void => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', h)
    return () => window.removeEventListener('mousedown', h)
  }, [])
  const multi = settings.multi_firm_enabled !== false && firms.filter((f) => f.is_active).length > 1
  const switchTo = async (id: number, name: string): Promise<void> => {
    setOpen(false)
    if (id === firm?.id) return
    const ok = await confirmDialog({
      title: 'Switch active firm?',
      message: (
        <>
          All new sales, purchases, payments and reports will be recorded under <b>{name}</b>. Any unsaved form will be closed.
        </>
      ),
      confirmLabel: `Switch to ${name}`
    })
    if (!ok) return
    try {
      await api('firms.switch', { id })
      await refresh()
      nav('/')
      toast.ok(`Active firm: ${name}`)
    } catch (e) {
      toast.error(e)
    }
  }
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => multi && setOpen(!open)}
        className={cx('flex items-center gap-3 rounded-xl border border-line bg-surface px-3 py-1.5 text-left', multi && 'cursor-pointer hover:border-brand')}
        title={multi ? 'Switch firm' : 'Active firm'}
      >
        {firm?.logo ? <img src={firm.logo} className="h-8 w-8 rounded-lg object-contain" alt="" /> : <Building2 className="h-8 w-8 rounded-lg bg-brand-soft p-1.5 text-brand" />}
        <div className="max-w-[220px] leading-tight">
          <div className="text-[10.5px] font-semibold tracking-wide text-muted uppercase">Active firm</div>
          <div className="truncate text-[13.5px] font-semibold">{firm?.name}</div>
        </div>
        {multi && <ChevronDown className="h-4 w-4 text-muted" />}
      </button>
      {open && (
        <div className="card fade-in absolute right-0 z-40 mt-2 w-72 p-1 shadow-xl">
          {firms
            .filter((f) => f.is_active)
            .map((f) => (
              <button key={f.id} type="button" onClick={() => switchTo(f.id, f.name)} className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left hover:bg-surface-2 cursor-pointer">
                <span className={cx('flex h-5 w-5 items-center justify-center rounded-full border-2', f.id === firm?.id ? 'border-brand' : 'border-line')}>
                  {f.id === firm?.id && <span className="h-2.5 w-2.5 rounded-full bg-brand" />}
                </span>
                <span className="flex-1 truncate font-medium">{f.name}</span>
                {f.is_default ? <span className="text-[10.5px] font-semibold text-muted">DEFAULT</span> : null}
              </button>
            ))}
        </div>
      )}
    </div>
  )
}

function GlobalSearch(): JSX.Element {
  const [q, setQ] = useState('')
  const [results, setResults] = useState<Array<Record<string, any>>>([]) // eslint-disable-line @typescript-eslint/no-explicit-any
  const [open, setOpen] = useState(false)
  const nav = useNavigate()
  useEffect(() => {
    if (q.trim().length < 2) {
      setResults([])
      return
    }
    const t = setTimeout(() => {
      api<Array<Record<string, unknown>>>('search.global', { q }).then(setResults).catch(() => setResults([]))
    }, 220)
    return () => clearTimeout(t)
  }, [q])
  const go = (r: Record<string, any>): void => { // eslint-disable-line @typescript-eslint/no-explicit-any
    setOpen(false)
    setQ('')
    if (r.result === 'document') nav(`/doc/${r.id}`)
    else if (r.result === 'party') nav(`/party/${r.id}`)
    else if (r.result === 'product') nav(`/inventory?product=${r.id}`)
    else if (r.result === 'serial') nav(`/inventory?tab=serials&serial=${encodeURIComponent(r.serial)}`)
    else if (r.result === 'project') nav(`/projects/${r.id}`)
  }
  return (
    <div className="relative w-[420px] max-w-[40vw]">
      <Search className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-muted" />
      <input
        className="input h-10 rounded-xl pl-9"
        placeholder="Search invoices, customers, products, serials, projects…"
        value={q}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && results[0] && go(results[0])}
      />
      {open && results.length > 0 && (
        <div className="card fade-in absolute z-40 mt-2 max-h-[60vh] w-full overflow-y-auto p-1 shadow-xl">
          {results.map((r, i) => (
            <button key={i} type="button" onMouseDown={() => go(r)} className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left hover:bg-surface-2 cursor-pointer">
              <span className="w-20 shrink-0 text-[10.5px] font-semibold text-muted uppercase">{r.result === 'document' ? nice(r.doc_type) : r.result}</span>
              <span className="flex-1 truncate">
                {r.result === 'document' ? `${r.number} — ${r.party_name ?? ''}` : r.result === 'serial' ? `${r.serial} — ${r.name}` : r.result === 'project' ? `${r.code} ${r.name}` : r.name}
              </span>
              <span className="text-[11.5px] text-muted">{r.result === 'document' ? date(r.date) : r.phone ?? r.sku ?? r.status ?? ''}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function Notifications(): JSX.Element {
  const can = useCan()
  const license = useApp((s) => s.license)
  const firm = useApp((s) => s.firm)
  const [items, setItems] = useState<Array<{ text: string; to: string; tone: string }>>([])
  const [open, setOpen] = useState(false)
  const nav = useNavigate()
  useEffect(() => {
    const load = async (): Promise<void> => {
      const out: Array<{ text: string; to: string; tone: string }> = []
      if (license && license.mode !== 'active') out.push({ text: license.message, to: '/settings?tab=license', tone: license.canWrite ? 'warn' : 'bad' })
      if (can('inventory.view')) {
        try {
          const low = await api<{ total: number }>('products.list', { stock: 'low', limit: 1 })
          const out0 = await api<{ total: number }>('products.list', { stock: 'out', limit: 1 })
          if (low.total) out.push({ text: `${low.total} product(s) are running low on stock`, to: '/inventory?stock=low', tone: 'warn' })
          if (out0.total) out.push({ text: `${out0.total} product(s) are out of stock`, to: '/inventory?stock=out', tone: 'bad' })
        } catch {
          /* ignore */
        }
      }
      setItems(out)
    }
    load()
    const t = setInterval(load, 120000)
    return () => clearInterval(t)
  }, [license, firm?.id]) // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="relative">
      <button type="button" className="relative flex h-10 w-10 items-center justify-center rounded-xl border border-line bg-surface hover:border-brand cursor-pointer" onClick={() => setOpen(!open)} onBlur={() => setTimeout(() => setOpen(false), 150)} title="Notifications">
        <Bell className="h-[18px] w-[18px]" />
        {items.length > 0 && <span className="absolute -top-1 -right-1 flex h-5 min-w-5 items-center justify-center rounded-full bg-bad px-1 text-[10.5px] font-bold text-white">{items.length}</span>}
      </button>
      {open && (
        <div className="card fade-in absolute right-0 z-40 mt-2 w-80 p-1 shadow-xl">
          {items.length === 0 && <div className="px-3 py-4 text-center text-[13px] text-muted">All clear — no alerts.</div>}
          {items.map((n, i) => (
            <button key={i} type="button" onMouseDown={() => nav(n.to)} className="flex w-full items-start gap-3 rounded-lg px-3 py-2.5 text-left hover:bg-surface-2 cursor-pointer">
              <AlertTriangle className={cx('mt-0.5 h-4 w-4 shrink-0', n.tone === 'bad' ? 'text-bad' : 'text-warn')} />
              <span className="text-[13px]">{n.text}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function UserMenu({ onLogout }: { onLogout: () => void }): JSX.Element {
  const user = useApp((s) => s.user)
  const [open, setOpen] = useState(false)
  const [pw, setPw] = useState(false)
  const [pinOpen, setPinOpen] = useState(false)
  const [themeOpen, setThemeOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const h = (e: MouseEvent): void => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', h)
    return () => window.removeEventListener('mousedown', h)
  }, [])
  const initials = (user?.fullName ?? '?').split(' ').map((p) => p[0]).slice(0, 2).join('').toUpperCase()
  const signOut = async (): Promise<void> => {
    await api('auth.logout').catch(() => undefined)
    onLogout()
  }
  return (
    <div ref={ref} className="relative">
      <button type="button" onClick={() => setOpen(!open)} className="flex items-center gap-2.5 rounded-xl px-2 py-1 hover:bg-surface-2 cursor-pointer" aria-label="User menu">
        <span className="flex h-9 w-9 items-center justify-center rounded-full bg-gradient-to-br from-brand to-brand-600 text-[13px] font-bold text-on-brand">{initials}</span>
        <span className="text-left leading-tight">
          <span className="block max-w-[140px] truncate text-[13px] font-semibold">{user?.fullName}</span>
          <span className="block text-[11px] text-muted">{user?.roleName}</span>
        </span>
        <ChevronDown className="h-4 w-4 text-muted" />
      </button>
      {open && (
        <div className="card fade-in absolute right-0 z-40 mt-2 w-60 p-1 shadow-xl">
          <MenuItem icon={<Palette />} onClick={() => { setThemeOpen(true); setOpen(false) }}>Theme & appearance</MenuItem>
          <MenuItem icon={<KeyRound />} onClick={() => { setPw(true); setOpen(false) }}>Change password</MenuItem>
          <MenuItem icon={<RectangleEllipsis />} onClick={() => { setPinOpen(true); setOpen(false) }}>Set my PIN</MenuItem>
          <MenuItem icon={<Lock />} onClick={async () => { await api('auth.lock'); useApp.getState().setLocked(true); setOpen(false) }}>Lock screen</MenuItem>
          <div className="my-1 border-t border-line" />
          <MenuItem icon={<LogOut />} onClick={signOut}>Sign out</MenuItem>
        </div>
      )}
      <ChangePassword open={pw || !!user?.mustChangePassword} forced={!!user?.mustChangePassword} onClose={() => setPw(false)} onSignOut={signOut} />
      <MyPinDialog open={pinOpen} onClose={() => setPinOpen(false)} />
      <ThemePicker open={themeOpen} onClose={() => setThemeOpen(false)} />
    </div>
  )
}

function MenuItem({ icon, children, onClick }: { icon: ReactNode; children: ReactNode; onClick: () => void }): JSX.Element {
  return (
    <button type="button" onClick={onClick} className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-[13.5px] hover:bg-surface-2 cursor-pointer [&>svg]:h-4 [&>svg]:w-4 [&>svg]:text-muted">
      {icon}
      {children}
    </button>
  )
}

export function ThemePicker({ open, onClose }: { open: boolean; onClose: () => void }): JSX.Element {
  const [current, setCurrent] = useState(getTheme())
  return (
    <Modal open={open} onClose={onClose} title="Theme & appearance" subtitle="Choose a colour theme for this computer" size="md">
      <div className="grid grid-cols-2 gap-3">
        {THEMES.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => {
              applyTheme(t.key)
              setCurrent(t.key)
            }}
            className={cx('flex items-center gap-3 rounded-xl border-2 p-3 text-left transition cursor-pointer', current === t.key ? 'border-brand bg-brand-soft' : 'border-line hover:border-muted')}
          >
            <span className="flex overflow-hidden rounded-lg shadow-sm">
              {t.swatch.map((c) => (
                <span key={c} className="h-10 w-5" style={{ background: c }} />
              ))}
            </span>
            <span className="flex-1">
              <span className="block font-semibold">{t.name}</span>
              <span className="text-[12px] text-muted">{t.dark ? 'Dark mode' : 'Light mode'}</span>
            </span>
            {current === t.key && <Check className="h-5 w-5 text-brand" />}
          </button>
        ))}
      </div>
    </Modal>
  )
}

/** Client-side mirror of the server password rules (the server is authoritative). */
function passwordProblem(pw: string, username?: string): string | null {
  if (!pw) return null
  if (pw.length < 6) return 'At least 6 characters.'
  const lower = pw.toLowerCase()
  const codes = [...lower].map((c) => c.charCodeAt(0))
  const step = codes[1] - codes[0]
  const sequence = Math.abs(step) === 1 && codes.every((c, i) => i === 0 || c - codes[i - 1] === step)
  if (/^(.)\1+$/.test(pw) || sequence || ['password', 'password1', 'qwerty', 'qwerty123', 'abc123', 'admin', 'welcome', 'letmein', 'iloveyou'].includes(lower)) {
    return 'Too easy to guess — mix letters and numbers.'
  }
  if (username && lower === username.toLowerCase()) return 'Must not be the same as your username.'
  return null
}

function ChangePassword({ open, forced, onClose, onSignOut }: { open: boolean; forced: boolean; onClose: () => void; onSignOut: () => void }): JSX.Element {
  const user = useApp((s) => s.user)
  const [f, setF] = useState({ old: '', next: '', confirm: '' })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const weak = passwordProblem(f.next, user?.username)
  const submit = async (): Promise<void> => {
    setError(null)
    if (!f.old) return setError(forced ? 'Enter the temporary password you signed in with.' : 'Enter your current password.')
    if (weak || !f.next) return setError(weak ?? 'Enter a new password.')
    if (f.next !== f.confirm) return setError('New passwords do not match.')
    if (f.next === f.old) return setError('Choose a new password that is different from the current one.')
    setBusy(true)
    try {
      await api('auth.changePassword', { oldPassword: f.old, newPassword: f.next })
      await useApp.getState().refresh()
      toast.ok('Password changed.')
      setF({ old: '', next: '', confirm: '' })
      onClose()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Modal
      open={open}
      onClose={() => !forced && onClose()}
      title={forced ? 'Set a new password' : 'Change password'}
      subtitle={forced ? 'Your administrator gave you a temporary password. Choose your own password before continuing.' : undefined}
      size="sm"
      footer={
        <>
          {forced ? (
            <Button variant="ghost" icon={<LogOut className="h-4 w-4" />} onClick={onSignOut} className="mr-auto">
              Sign out
            </Button>
          ) : (
            <Button onClick={onClose}>Cancel</Button>
          )}
          <Button variant="primary" loading={busy} onClick={submit}>
            Save password
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <Field label={forced ? 'Temporary password' : 'Current password'}>
          <Input type="password" value={f.old} onChange={(e) => setF({ ...f, old: e.target.value })} autoFocus autoComplete="current-password" />
        </Field>
        <Field label="New password" hint={weak ? undefined : 'At least 6 characters — a word plus a few numbers works well.'} error={weak ?? undefined}>
          <Input type="password" value={f.next} onChange={(e) => setF({ ...f, next: e.target.value })} autoComplete="new-password" />
        </Field>
        <Field label="Confirm new password" error={f.confirm && f.confirm !== f.next ? 'Passwords do not match.' : undefined}>
          <Input type="password" value={f.confirm} onChange={(e) => setF({ ...f, confirm: e.target.value })} onKeyDown={(e) => e.key === 'Enter' && submit()} autoComplete="new-password" />
        </Field>
        {error && <div role="alert" className="rounded-lg bg-bad-soft px-3 py-2 text-[12.5px] text-bad">{error}</div>}
      </div>
    </Modal>
  )
}

interface PinState {
  hasPin: boolean
  pinLocked: boolean
  pinLockedMinutes: number
}

/** "Set my PIN" — confirm with the current password, then choose a 4–6 digit PIN (or remove it). */
function MyPinDialog({ open, onClose }: { open: boolean; onClose: () => void }): JSX.Element {
  const [st, setSt] = useState<PinState | null>(null)
  const [f, setF] = useState({ password: '', pin: '', confirm: '' })
  const [busy, setBusy] = useState<'save' | 'remove' | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    if (!open) return
    setF({ password: '', pin: '', confirm: '' })
    setError(null)
    api<PinState | null>('auth.pinStatus').then(setSt).catch(() => setSt(null))
  }, [open])
  const save = async (): Promise<void> => {
    setError(null)
    if (!f.password) return setError('Enter your current password to confirm it is you.')
    if (!PIN_RE.test(f.pin)) return setError('The PIN must be 4 to 6 digits.')
    if (f.pin !== f.confirm) return setError('The two PINs do not match.')
    setBusy('save')
    try {
      await api('auth.pinSet', { currentPassword: f.password, pin: f.pin })
      toast.ok('Your PIN is set. Pick your name on the sign-in screen or lock screen and enter the PIN.')
      onClose()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(null)
    }
  }
  const remove = async (): Promise<void> => {
    setError(null)
    if (!f.password) return setError('Enter your current password to remove the PIN.')
    setBusy('remove')
    try {
      await api('auth.pinRemove', { currentPassword: f.password })
      toast.ok('PIN removed. Sign in with your password.')
      onClose()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(null)
    }
  }
  return (
    <Modal
      open={open}
      onClose={onClose}
      size="sm"
      title={st?.hasPin ? 'Change my PIN' : 'Set my PIN'}
      subtitle="A 4–6 digit PIN for quick sign-in and unlocking on this computer"
      footer={
        <>
          {st?.hasPin && (
            <Button variant="ghost" className="mr-auto text-bad" loading={busy === 'remove'} disabled={!!busy} onClick={remove}>
              Remove PIN
            </Button>
          )}
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={busy === 'save'} disabled={!!busy} onClick={save}>
            {st?.hasPin ? 'Change PIN' : 'Set PIN'}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        {st?.pinLocked && (
          <div className="rounded-lg bg-warn-soft px-3 py-2 text-[12.5px] text-warn">Your PIN is locked for {st.pinLockedMinutes} more minute(s) after wrong attempts. Setting a new PIN unlocks it.</div>
        )}
        <Field label="Current password">
          <Input type="password" value={f.password} autoFocus onChange={(e) => setF({ ...f, password: e.target.value })} autoComplete="current-password" />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="New PIN" hint="4–6 digits, not 1234 or 0000">
            <PinInput size="md" label="PIN" value={f.pin} onChange={(v) => setF({ ...f, pin: v })} />
          </Field>
          <Field label="Repeat PIN">
            <PinInput size="md" label="PIN" value={f.confirm} onChange={(v) => setF({ ...f, confirm: v })} onEnter={save} />
          </Field>
        </div>
        {error && <div role="alert" className="rounded-lg bg-bad-soft px-3 py-2 text-[12.5px] text-bad">{error}</div>}
      </div>
    </Modal>
  )
}

function LockScreen({ onLogout }: { onLogout: () => void }): JSX.Element {
  const user = useApp((s) => s.user)
  const [st, setSt] = useState<PinState | null>(null)
  const [method, setMethod] = useState<'pin' | 'password' | null>(null)
  const [pw, setPw] = useState('')
  const [pin, setPin] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    api<PinState | null>('auth.pinStatus')
      .then((s) => {
        setSt(s)
        setMethod(s?.hasPin && !s.pinLocked ? 'pin' : 'password')
        if (s?.pinLocked) setError(`PIN is locked for ${s.pinLockedMinutes} more minute(s). Use your password.`)
      })
      .catch(() => setMethod('password'))
  }, [])
  const unlock = async (): Promise<void> => {
    setError(null)
    if (method === 'pin' && !PIN_RE.test(pin)) return setError('Enter your 4–6 digit PIN.')
    if (method === 'password' && !pw) return setError('Enter your password.')
    setBusy(true)
    try {
      await api('auth.unlock', method === 'pin' ? { pin } : { password: pw })
      useApp.getState().setLocked(false)
      setPw('')
      setPin('')
    } catch (e) {
      const msg = (e as Error).message
      setError(msg)
      setPw('')
      setPin('')
      if (method === 'pin' && /PIN is locked/i.test(msg)) setMethod('password')
    } finally {
      setBusy(false)
    }
  }
  const switchTo = (m: 'pin' | 'password'): void => {
    setError(null)
    setPw('')
    setPin('')
    setMethod(m)
  }
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-gradient-to-br from-side via-side to-brand-600 p-6">
      <div className="card fade-in w-full max-w-sm p-7 text-center shadow-2xl">
        <img src={appIcon} className="mx-auto mb-3 h-14 w-14 rounded-2xl" alt="" />
        <div className="text-[18px] font-bold">Session locked</div>
        <div className="mb-5 text-[13px] text-muted">
          Signed in as <b className="text-ink">{user?.fullName}</b>. {method === 'pin' ? 'Enter your PIN to continue.' : 'Enter your password to continue.'}
        </div>
        {method === 'pin' && <PinInput value={pin} onChange={setPin} onEnter={unlock} autoFocus invalid={!!error} />}
        {method === 'password' && (
          <Input type="password" autoFocus placeholder="Password" value={pw} onChange={(e) => setPw(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && unlock()} />
        )}
        {error && <div role="alert" className="mt-3 rounded-lg bg-bad-soft px-3 py-2 text-left text-[12.5px] text-bad">{error}</div>}
        <Button variant="primary" className="mt-3 w-full" loading={busy} disabled={!method} onClick={unlock} icon={<Lock className="h-4 w-4" />}>
          Unlock
        </Button>
        {st?.hasPin && method && (
          <button type="button" className="mt-3 text-[12.5px] font-medium text-brand hover:underline cursor-pointer" onClick={() => switchTo(method === 'pin' ? 'password' : 'pin')}>
            {method === 'pin' ? 'Use password instead' : 'Use PIN instead'}
          </button>
        )}
        <div>
          <button type="button" className="mt-3 text-[12.5px] text-muted hover:text-ink cursor-pointer" onClick={async () => { await api('auth.logout').catch(() => undefined); onLogout() }}>
            Sign out instead
          </button>
        </div>
      </div>
    </div>
  )
}

function LicenseBanner(): JSX.Element | null {
  const license = useApp((s) => s.license)
  const nav = useNavigate()
  if (!license || license.mode === 'active') return null
  const bad = !license.canWrite
  return (
    <div className={cx('no-print flex items-center gap-3 px-6 py-2 text-[13px]', bad ? 'bg-bad text-white' : 'bg-warn-soft text-warn')}>
      <AlertTriangle className="h-4 w-4 shrink-0" />
      <span className="flex-1">
        {license.message}
        {bad && ' Read-only mode: you can view, print and back up, but not add or change records.'}
      </span>
      <button type="button" className="font-semibold underline cursor-pointer" onClick={() => nav('/settings?tab=license')}>
        Activate / renew
      </button>
    </div>
  )
}

export function Shell({ children, onLogout }: { children: ReactNode; onLogout: () => void }): JSX.Element {
  const { locked, firm, settings, user } = useApp()
  const lastActivity = useRef(Date.now())
  const lastPing = useRef(Date.now())

  useEffect(() => {
    const mark = (): void => {
      lastActivity.current = Date.now()
    }
    window.addEventListener('mousemove', mark)
    window.addEventListener('keydown', mark)
    const t = setInterval(() => {
      const st = useApp.getState()
      if (st.locked) return
      const lockMin = Number(st.settings.lock_minutes ?? 15)
      const idle = Date.now() - lastActivity.current
      if (lockMin > 0 && idle > lockMin * 60000) {
        api('auth.lock').catch(() => undefined)
        st.setLocked(true)
      } else if (lastActivity.current > lastPing.current) {
        lastPing.current = Date.now()
        api('app.activity').catch(() => undefined)
      }
    }, 30000)
    return () => {
      window.removeEventListener('mousemove', mark)
      window.removeEventListener('keydown', mark)
      clearInterval(t)
    }
  }, [settings.lock_minutes])

  return (
    <div className="flex h-full">
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="no-print flex h-[68px] shrink-0 items-center gap-4 border-b border-line bg-surface px-6">
          <GlobalSearch />
          <div className="flex-1" />
          <div className="hidden items-center gap-2 rounded-xl border border-line px-3 py-1.5 xl:flex">
            <CalendarDays className="h-[18px] w-[18px] text-brand" />
            <div className="leading-tight">
              <div className="text-[13px] font-semibold">{new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })}</div>
              <div className="text-[11px] text-muted">{new Date().toLocaleDateString('en-GB', { weekday: 'long' })}</div>
            </div>
          </div>
          <Notifications />
          <FirmSwitcher />
          <UserMenu onLogout={onLogout} />
        </header>
        <LicenseBanner />
        <main key={firm?.id} className="flex-1 overflow-y-auto p-6">
          {user?.mustChangePassword ? null : children}
        </main>
      </div>
      {locked && <LockScreen onLogout={onLogout} />}
    </div>
  )
}
