import { ReactNode, useEffect, useRef, useState } from 'react'
import { NavLink, useNavigate } from 'react-router-dom'
import {
  BarChart3, CalendarCheck, LifeBuoy, Bell, Boxes, Building2, CalendarDays, ChevronDown, DatabaseBackup, FileText, KeyRound, Landmark,
  LayoutDashboard, Lock, LogOut, Palette, Receipt, Search, Settings, ShieldCheck, ShoppingBag, ShoppingCart, SunMedium, Truck, Users, Check, AlertTriangle
} from 'lucide-react'
import { api } from '../api'
import { useApp, useCan } from '../store'
import { Button, Field, Input, Modal, confirmDialog, cx, toast } from './ui'
import { THEMES, applyTheme, getTheme } from '../lib/theme'
import { date, label as nice } from '../lib/format'
import appIcon from '../assets/app-icon.png'
import { DtMark } from './Brand'
import { SETTINGS_ENTRY_PERMS } from '../pages/settings/sections'

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
  return (
    <div ref={ref} className="relative">
      <button type="button" onClick={() => setOpen(!open)} className="flex items-center gap-2.5 rounded-xl px-2 py-1 hover:bg-surface-2 cursor-pointer">
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
          <MenuItem icon={<Lock />} onClick={async () => { await api('auth.lock'); useApp.getState().setLocked(true); setOpen(false) }}>Lock screen</MenuItem>
          <div className="my-1 border-t border-line" />
          <MenuItem icon={<LogOut />} onClick={async () => { await api('auth.logout').catch(() => undefined); onLogout() }}>Sign out</MenuItem>
        </div>
      )}
      <ChangePassword open={pw || !!user?.mustChangePassword} forced={!!user?.mustChangePassword} onClose={() => setPw(false)} />
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

function ChangePassword({ open, forced, onClose }: { open: boolean; forced: boolean; onClose: () => void }): JSX.Element {
  const [f, setF] = useState({ old: '', next: '', confirm: '' })
  const [busy, setBusy] = useState(false)
  const submit = async (): Promise<void> => {
    if (f.next !== f.confirm) return toast.error('New passwords do not match.')
    setBusy(true)
    try {
      await api('auth.changePassword', { oldPassword: f.old, newPassword: f.next })
      await useApp.getState().refresh()
      toast.ok('Password changed.')
      setF({ old: '', next: '', confirm: '' })
      onClose()
    } catch (e) {
      toast.error(e)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Modal
      open={open}
      onClose={() => !forced && onClose()}
      title={forced ? 'Set a new password' : 'Change password'}
      subtitle={forced ? 'Your administrator requires you to choose a new password before continuing.' : undefined}
      size="sm"
      footer={
        <>
          {!forced && <Button onClick={onClose}>Cancel</Button>}
          <Button variant="primary" loading={busy} onClick={submit}>
            Save password
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <Field label="Current password">
          <Input type="password" value={f.old} onChange={(e) => setF({ ...f, old: e.target.value })} autoFocus />
        </Field>
        <Field label="New password" hint="At least 6 characters">
          <Input type="password" value={f.next} onChange={(e) => setF({ ...f, next: e.target.value })} />
        </Field>
        <Field label="Confirm new password">
          <Input type="password" value={f.confirm} onChange={(e) => setF({ ...f, confirm: e.target.value })} onKeyDown={(e) => e.key === 'Enter' && submit()} />
        </Field>
      </div>
    </Modal>
  )
}

function LockScreen({ onLogout }: { onLogout: () => void }): JSX.Element {
  const user = useApp((s) => s.user)
  const [pw, setPw] = useState('')
  const [busy, setBusy] = useState(false)
  const unlock = async (): Promise<void> => {
    setBusy(true)
    try {
      await api('auth.unlock', { password: pw })
      useApp.getState().setLocked(false)
      setPw('')
    } catch (e) {
      toast.error(e)
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-gradient-to-br from-side via-side to-brand-600 p-6">
      <div className="card fade-in w-full max-w-sm p-7 text-center shadow-2xl">
        <img src={appIcon} className="mx-auto mb-3 h-14 w-14 rounded-2xl" alt="" />
        <div className="text-[18px] font-bold">Session locked</div>
        <div className="mb-5 text-[13px] text-muted">Signed in as {user?.fullName}. Enter your password to continue.</div>
        <Input type="password" autoFocus placeholder="Password" value={pw} onChange={(e) => setPw(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && unlock()} />
        <Button variant="primary" className="mt-3 w-full" loading={busy} onClick={unlock} icon={<Lock className="h-4 w-4" />}>
          Unlock
        </Button>
        <button type="button" className="mt-4 text-[12.5px] text-muted hover:text-ink cursor-pointer" onClick={async () => { await api('auth.logout').catch(() => undefined); onLogout() }}>
          Sign out instead
        </button>
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
  const { locked, firm, settings } = useApp()
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
          {children}
        </main>
      </div>
      {locked && <LockScreen onLogout={onLogout} />}
    </div>
  )
}
