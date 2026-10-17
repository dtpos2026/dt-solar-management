import { useState, type ReactNode } from 'react'
import { HashRouter, NavLink, Navigate, Route, Routes } from 'react-router-dom'
import { Activity, BadgeCheck, Building2, CreditCard, KeyRound, LayoutDashboard, LifeBuoy, LogOut, Map, MonitorSmartphone, Settings as SettingsIcon, ShieldCheck, Users, Loader2 } from 'lucide-react'
import { AuthProvider, useAuth, useCan } from './lib/auth'
import { SigningKeyProvider, useSigningKey } from './lib/signingKey'
import { cx } from './components/ui'
import { ToastProvider } from './components/kit'
import { Dashboard } from './pages/Dashboard'
import { Clients } from './pages/Clients'
import { Licenses } from './pages/Licenses'
import { LicenseDetail } from './pages/LicenseDetail'
import { Devices } from './pages/Devices'
import { DeviceMap } from './pages/DeviceMap'
import { Billing } from './pages/Billing'
import { Support } from './pages/Support'
import { VerifyKey } from './pages/VerifyKey'
import { ActivityLog } from './pages/ActivityLog'
import { Admins } from './pages/Admins'
import { Settings } from './pages/Settings'
import { Requests } from './pages/Requests'
import { Offline } from './pages/Offline'
import { SigningKeyPage } from './pages/SigningKey'
import { PassSync } from './components/PassSync'

function Login() {
  const { state, notice, signIn, signOut, resetPassword, initialiseSuperAdmin } = useAuth()
  const [email, setEmail] = useState('digitaltarget.digital@gmail.com')
  const [pw, setPw] = useState('')
  const [name, setName] = useState('Digital Target')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const run = async (fn: () => Promise<void>) => {
    setBusy(true)
    setMsg(null)
    try {
      await fn()
    } catch (e) {
      setMsg((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="flex min-h-full items-center justify-center bg-gradient-to-br from-[#2b0750] via-[#4c1d95] to-[#7c3aed] p-6">
      <div className="card w-full max-w-md p-7">
        <div className="mb-5 flex items-center gap-3">
          <img src="/icon.png" className="h-12 w-12 rounded-xl" alt="" />
          <div>
            <div className="text-[19px] font-extrabold">DT Solar Pro - Super Admin</div>
            <div className="text-[12.5px] text-[#7a6d92]">Licensing, billing & support, Digital Target</div>
          </div>
        </div>
        {state.phase === 'bootstrap' ? (
          <div className="space-y-3">
            <div className="rounded-lg bg-[#f1e9fb] p-3 text-[13px]">Welcome {state.user.email}. This owner account is not a super admin yet. Initialise it now (one time).</div>
            <label className="block"><span className="label">Your name</span><input className="input" value={name} onChange={(e) => setName(e.target.value)} /></label>
            <button className="btn btn-primary w-full justify-center" disabled={busy} onClick={() => run(() => initialiseSuperAdmin(name))}>Initialise Super Admin</button>
            <button className="btn btn-secondary w-full justify-center" onClick={() => signOut()}>Sign out</button>
          </div>
        ) : state.phase === 'loading' || state.phase === 'checking' ? (
          <div className="flex justify-center py-6"><Loader2 className="h-6 w-6 animate-spin text-[#3d096d]" /></div>
        ) : (
          <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); run(() => signIn(email, pw)) }}>
            <label className="block"><span className="label">Email</span><input className="input" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" /></label>
            <label className="block"><span className="label">Password</span><input className="input" type="password" value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="current-password" autoFocus /></label>
            <button className="btn btn-primary w-full justify-center" disabled={busy}>{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null} Sign in</button>
            <button type="button" className="w-full text-center text-[12.5px] text-[#6b5d85] hover:underline" onClick={() => run(async () => { await resetPassword(email); setMsg('Password reset email sent.') })}>Forgot password?</button>
          </form>
        )}
        {(msg || notice) && <div className="mt-4 rounded-lg bg-red-50 p-3 text-[13px] text-red-700">{msg || notice}</div>}
        <div className="mt-6 text-center text-[12px] text-[#7a6d92]">Create the owner account first in Firebase Console → Authentication → Add user.</div>
      </div>
    </div>
  )
}

/** Sidebar (information architecture per the reference design). `perms`: any of them shows the item; empty = all admins. */
const NAV: { to: string; label: string; icon: ReactNode; perms: string[] }[] = [
  { to: '/', label: 'Dashboard', icon: <LayoutDashboard />, perms: [] },
  { to: '/clients', label: 'Clients', icon: <Building2 />, perms: ['clients.view'] },
  { to: '/licenses', label: 'Licenses', icon: <BadgeCheck />, perms: ['licenses.view', 'licenses.generate', 'licenses.manage'] },
  { to: '/devices', label: 'Devices', icon: <MonitorSmartphone />, perms: ['devices.view', 'devices.manage'] },
  { to: '/map', label: 'Device Map', icon: <Map />, perms: ['devices.view', 'devices.manage'] },
  { to: '/billing', label: 'Billing', icon: <CreditCard />, perms: ['billing.view', 'billing.create', 'billing.payments'] },
  { to: '/support', label: 'Support', icon: <LifeBuoy />, perms: ['support.manage'] },
  { to: '/verify', label: 'Verify Key', icon: <KeyRound />, perms: ['verify.use', 'licenses.view'] },
  { to: '/activity', label: 'Activity Log', icon: <Activity />, perms: ['audit.view'] },
  { to: '/admins', label: 'Admins', icon: <Users />, perms: ['admins.manage'] },
  { to: '/settings', label: 'Settings', icon: <SettingsIcon />, perms: [] }
]

function Shell() {
  const { state, signOut } = useAuth()
  const { key, restoring } = useSigningKey()
  const can = useCan()
  const items = NAV.filter((n) => n.perms.length === 0 || n.perms.some(can))
  return (
    <div className="flex h-full">
      <PassSync />
      <aside className="flex w-60 shrink-0 flex-col bg-gradient-to-b from-[#1e0538] to-[#2b0750] text-[#dacdf2]">
        <div className="flex items-center gap-3 px-5 py-5">
          <img src="/icon.png" className="h-10 w-10 rounded-xl" alt="" />
          <div className="leading-tight"><div className="font-extrabold text-white">Super Admin</div><div className="text-[12px] opacity-70">DT Solar Pro, Digital Target</div></div>
        </div>
        <nav className="flex-1 space-y-0.5 overflow-y-auto px-3">
          {items.map((n) => (
            <NavLink
              key={n.to}
              to={n.to}
              end={n.to === '/'}
              className={({ isActive }) =>
                cx(
                  'flex h-9 items-center gap-3 rounded-lg px-3 text-[13.5px] font-medium [&>svg]:h-[18px] [&>svg]:w-[18px]',
                  isActive ? 'bg-gradient-to-r from-[#7c3aed] to-[#c026d3] text-white shadow-md shadow-purple-900/40' : 'hover:bg-white/10 hover:text-white'
                )
              }
            >
              {n.icon}
              {n.label}
            </NavLink>
          ))}
        </nav>
        <div className="border-t border-white/10 px-5 py-3 text-[12px]">
          <div className={cx('mb-2 flex items-center gap-2', key ? 'text-green-300' : restoring ? 'text-white/70' : 'text-amber-300')}><ShieldCheck className="h-4 w-4" />{key ? 'Signing key loaded' : restoring ? 'Restoring signing key' : 'No signing key'}</div>
          <div className="truncate opacity-80">{state.phase === 'admin' ? state.user.email : ''}</div>
          <button className="mt-2 flex items-center gap-2 hover:text-white" onClick={() => signOut()}><LogOut className="h-4 w-4" />Sign out</button>
          <div className="mt-3 text-[12px] opacity-60">© Digital Target, +92 345 1873354</div>
        </div>
      </aside>
      <main className="min-w-0 flex-1 overflow-y-auto px-7 py-6">
        <div className="mx-auto max-w-[1440px]">
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/clients" element={<Clients />} />
          <Route path="/clients/:id" element={<Clients />} />
          <Route path="/licenses" element={<Licenses />} />
          <Route path="/licenses/:id" element={<LicenseDetail />} />
          <Route path="/devices" element={<Devices />} />
          <Route path="/map" element={<DeviceMap />} />
          <Route path="/billing" element={<Billing />} />
          <Route path="/billing/:id" element={<Billing />} />
          <Route path="/support" element={<Support />} />
          <Route path="/support/:id" element={<Support />} />
          <Route path="/verify" element={<VerifyKey />} />
          <Route path="/activity" element={<ActivityLog />} />
          <Route path="/admins" element={<Admins />} />
          <Route path="/settings" element={<Settings />} />
          {/* Reached from the Licenses / Devices / Settings pages */}
          <Route path="/requests" element={<Requests />} />
          <Route path="/offline" element={<Offline />} />
          <Route path="/key" element={<SigningKeyPage />} />
          <Route path="/audit" element={<Navigate to="/activity" replace />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
        </div>
      </main>
    </div>
  )
}

function Gate() {
  const { state } = useAuth()
  return state.phase === 'admin' ? <Shell /> : <Login />
}

export function App() {
  return (
    <AuthProvider>
      <SigningKeyProvider>
        <HashRouter>
          <ToastProvider>
            <Gate />
          </ToastProvider>
        </HashRouter>
      </SigningKeyProvider>
    </AuthProvider>
  )
}
