import { useState } from 'react'
import { LogIn, ShieldCheck, WifiOff, BarChart3 } from 'lucide-react'
import { api } from '../../api'
import { useApp } from '../../store'
import { Button, Field, Input, toast } from '../../components/ui'
import { AppLogo, VendorLine } from '../../components/Brand'

export function Login({ onDone }: { onDone: () => void }): JSX.Element {
  const [u, setU] = useState('')
  const [p, setP] = useState('')
  const [busy, setBusy] = useState(false)
  const license = useApp((s) => s.license)
  const version = useApp((s) => s.version)
  const submit = async (): Promise<void> => {
    setBusy(true)
    try {
      await api('auth.login', { username: u, password: p })
      onDone()
    } catch (e) {
      toast.error(e)
      setP('')
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
      <div className="flex w-full max-w-[480px] flex-col justify-center px-12">
        <div className="lg:hidden"><AppLogo /></div>
        <div className="mt-6 text-[26px] font-bold">Welcome back</div>
        <div className="mb-6 text-muted">Sign in to continue</div>
        <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); submit() }}>
          <Field label="Username">
            <Input autoFocus value={u} onChange={(e) => setU(e.target.value)} autoComplete="username" />
          </Field>
          <Field label="Password">
            <Input type="password" value={p} onChange={(e) => setP(e.target.value)} autoComplete="current-password" />
          </Field>
          <Button type="submit" variant="primary" size="lg" className="w-full" loading={busy} icon={<LogIn className="h-4 w-4" />}>
            Sign in
          </Button>
        </form>
        {license && license.mode !== 'active' && (
          <div className={`mt-6 rounded-xl px-4 py-3 text-[12.5px] ${license.canWrite ? 'bg-warn-soft text-warn' : 'bg-bad-soft text-bad'}`}>{license.message}</div>
        )}
        <div className="mt-10 text-[11.5px] text-muted">DT Solar Pro v{version} · Forgot your password? Ask the owner/administrator to reset it from Users &amp; Permissions.</div>
      </div>
    </div>
  )
}
