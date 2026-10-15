import { useEffect, useState } from 'react'
import { ArrowLeft, KeyRound, LogIn, ShieldCheck, WifiOff, BarChart3, UserRound } from 'lucide-react'
import { api } from '../../api'
import { useApp } from '../../store'
import { Button, Field, Input, Spinner, cx } from '../../components/ui'
import { AppLogo, VendorLine } from '../../components/Brand'
import { Avatar, PIN_RE, PinInput } from '../users/PinInput'

/** Safe fields returned by the public `auth.users` route (no usernames, no hashes, active users only). */
interface Tile {
  id: number
  full_name: string
  role_name: string
  has_pin: boolean
}

type Mode = 'loading' | 'tiles' | 'user' | 'classic'

export function Login({ onDone }: { onDone: () => void }): JSX.Element {
  const license = useApp((s) => s.license)
  const version = useApp((s) => s.version)
  const [mode, setMode] = useState<Mode>('loading')
  const [tiles, setTiles] = useState<Tile[]>([])
  const [picked, setPicked] = useState<Tile | null>(null)
  const [method, setMethod] = useState<'pin' | 'password'>('password')
  const [u, setU] = useState('')
  const [p, setP] = useState('')
  const [pin, setPin] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    api<{ showUsers: boolean; users: Tile[] }>('auth.users')
      .then((r) => {
        const list = r.showUsers ? r.users : []
        setTiles(list)
        setMode(list.length ? 'tiles' : 'classic')
      })
      .catch(() => setMode('classic'))
  }, [])

  const reset = (): void => {
    setError(null)
    setP('')
    setPin('')
  }

  const pick = (t: Tile): void => {
    reset()
    setPicked(t)
    setMethod(t.has_pin ? 'pin' : 'password')
    setMode('user')
  }

  const go = (m: Mode): void => {
    reset()
    setPicked(null)
    setMode(m)
  }

  const submit = async (): Promise<void> => {
    setError(null)
    if (mode === 'classic' && (!u.trim() || !p)) return setError('Enter your username and password.')
    if (mode === 'user' && method === 'password' && !p) return setError('Enter your password.')
    if (mode === 'user' && method === 'pin' && !PIN_RE.test(pin)) return setError('Enter your 4–6 digit PIN.')
    setBusy(true)
    try {
      if (mode === 'classic') await api('auth.login', { username: u.trim(), password: p })
      else if (method === 'pin') await api('auth.pinLogin', { userId: picked!.id, pin })
      else await api('auth.login', { userId: picked!.id, password: p })
      onDone()
    } catch (e) {
      const msg = (e as Error).message
      setError(msg)
      setP('')
      setPin('')
      // After a PIN lock-out the password is the way in.
      if (method === 'pin' && /PIN is locked/i.test(msg)) setMethod('password')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex h-full">
      <div className="relative hidden flex-1 flex-col justify-between overflow-hidden bg-gradient-to-br from-[#3d096d] via-[#2a1b8f] to-[#0d60a6] p-10 text-white lg:flex">
        <div className="absolute top-16 right-20 h-40 w-40 rounded-full bg-gradient-to-br from-[#ffe27a] to-[#f7931e] shadow-[0_0_80px_30px_rgba(255,177,43,0.45)]" />
        <div className="absolute -bottom-10 -left-10 grid w-[130%] -rotate-6 grid-cols-10 gap-2 opacity-15">
          {Array.from({ length: 40 }).map((_, i) => (
            <div key={i} className="h-16 rounded bg-gradient-to-br from-white to-blue-200" />
          ))}
        </div>
        <AppLogo light size={52} />
        <div className="relative max-w-lg">
          <div className="text-[40px] leading-[1.1] font-extrabold">Clean Energy.<br />Clear Accounts.</div>
          <div className="mt-4 text-[15px] text-white/80">Sales, purchases, inventory, accounts and complete project-wise profit for solar businesses — fully offline on your computer.</div>
          <div className="mt-8 grid grid-cols-3 gap-3 text-[12.5px]">
            <div className="rounded-xl bg-white/10 p-3"><WifiOff className="mb-2 h-5 w-5 text-[#ffc24a]" />Works 100% offline</div>
            <div className="rounded-xl bg-white/10 p-3"><BarChart3 className="mb-2 h-5 w-5 text-[#ffc24a]" />Project-wise profit</div>
            <div className="rounded-xl bg-white/10 p-3"><ShieldCheck className="mb-2 h-5 w-5 text-[#ffc24a]" />Secure multi-user</div>
          </div>
        </div>
        <VendorLine light />
      </div>

      <div className="flex w-full max-w-[480px] flex-col overflow-y-auto px-12 py-8">
        <div className="my-auto">
          <div className="lg:hidden"><AppLogo /></div>

          {mode === 'loading' && (
            <div className="flex items-center gap-3 py-10 text-muted"><Spinner /> Loading…</div>
          )}

          {mode === 'tiles' && (
            <>
              <div className="mt-2 text-[26px] font-bold">Welcome back</div>
              <div className="mb-5 text-muted">Who is signing in?</div>
              <div className="grid max-h-[46vh] grid-cols-2 gap-2.5 overflow-y-auto p-0.5" role="list">
                {tiles.map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    role="listitem"
                    data-user-tile={t.id}
                    onClick={() => pick(t)}
                    className="group flex min-w-0 cursor-pointer items-center gap-3 rounded-xl border border-line bg-surface px-3 py-2.5 text-left transition hover:border-brand hover:shadow-md focus-visible:border-brand"
                  >
                    <Avatar name={t.full_name} id={t.id} size={40} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13.5px] font-semibold group-hover:text-brand" title={t.full_name}>{t.full_name}</span>
                      <span className="block truncate text-[11.5px] text-muted" title={t.role_name}>{t.role_name}</span>
                    </span>
                    {t.has_pin && <KeyRound className="h-3.5 w-3.5 shrink-0 text-muted" aria-label="PIN sign-in" />}
                  </button>
                ))}
              </div>
              <button type="button" className="mt-5 flex cursor-pointer items-center gap-2 text-[13px] font-medium text-brand hover:underline" onClick={() => go('classic')}>
                <UserRound className="h-4 w-4" /> Sign in with username
              </button>
            </>
          )}

          {mode === 'user' && picked && (
            <>
              <button type="button" className="mb-5 flex cursor-pointer items-center gap-1.5 text-[13px] text-muted hover:text-ink" onClick={() => go('tiles')}>
                <ArrowLeft className="h-4 w-4" /> Choose another user
              </button>
              <div className="flex items-center gap-4">
                <Avatar name={picked.full_name} id={picked.id} size={56} />
                <div className="min-w-0">
                  <div className="truncate text-[22px] font-bold" title={picked.full_name}>{picked.full_name}</div>
                  <div className="text-[13px] text-muted">{picked.role_name}</div>
                </div>
              </div>
              <form className="mt-6 space-y-4" onSubmit={(e) => { e.preventDefault(); submit() }}>
                {method === 'pin' ? (
                  <Field label="Enter your PIN">
                    <PinInput value={pin} onChange={setPin} autoFocus invalid={!!error} />
                  </Field>
                ) : (
                  <Field label="Password">
                    <Input type="password" autoFocus value={p} onChange={(e) => setP(e.target.value)} autoComplete="current-password" className={cx(error && 'border-bad')} />
                  </Field>
                )}
                {error && <div role="alert" className="rounded-lg bg-bad-soft px-3 py-2 text-[12.5px] text-bad">{error}</div>}
                <Button type="submit" variant="primary" size="lg" className="w-full" loading={busy} icon={<LogIn className="h-4 w-4" />}>
                  Sign in
                </Button>
              </form>
              {picked.has_pin && (
                <button
                  type="button"
                  className="mt-4 cursor-pointer text-[13px] font-medium text-brand hover:underline"
                  onClick={() => { reset(); setMethod(method === 'pin' ? 'password' : 'pin') }}
                >
                  {method === 'pin' ? 'Use password instead' : 'Use PIN instead'}
                </button>
              )}
            </>
          )}

          {mode === 'classic' && (
            <>
              <div className="mt-2 text-[26px] font-bold">Welcome back</div>
              <div className="mb-6 text-muted">Sign in to continue</div>
              <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); submit() }}>
                <Field label="Username">
                  <Input autoFocus value={u} onChange={(e) => setU(e.target.value)} autoComplete="username" />
                </Field>
                <Field label="Password">
                  <Input type="password" value={p} onChange={(e) => setP(e.target.value)} autoComplete="current-password" />
                </Field>
                {error && <div role="alert" className="rounded-lg bg-bad-soft px-3 py-2 text-[12.5px] text-bad">{error}</div>}
                <Button type="submit" variant="primary" size="lg" className="w-full" loading={busy} icon={<LogIn className="h-4 w-4" />}>
                  Sign in
                </Button>
              </form>
              {tiles.length > 0 && (
                <button type="button" className="mt-4 flex cursor-pointer items-center gap-1.5 text-[13px] font-medium text-brand hover:underline" onClick={() => go('tiles')}>
                  <ArrowLeft className="h-4 w-4" /> Back to the list of users
                </button>
              )}
            </>
          )}

          {license && license.mode !== 'active' && (
            <div className={`mt-6 rounded-xl px-4 py-3 text-[12.5px] ${license.canWrite ? 'bg-warn-soft text-warn' : 'bg-bad-soft text-bad'}`}>{license.message}</div>
          )}
          <div className="mt-10 text-[11.5px] text-muted">DT Solar Pro v{version} · Forgot your password or PIN? Ask the owner/administrator to reset it from Users &amp; Permissions.</div>
        </div>
      </div>
    </div>
  )
}
