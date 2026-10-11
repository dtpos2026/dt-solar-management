import { useEffect, useState } from 'react'
import { Building2, Check, ChevronLeft, ChevronRight, Database, ImagePlus, Rocket, ShieldCheck, Sparkles, Users } from 'lucide-react'
import { api } from '../../api'
import { Button, Field, Input, Textarea, Toggle, cx, readImageFile, toast } from '../../components/ui'
import { AppLogo, VendorLine } from '../../components/Brand'
import wetcoLogo from '../../assets/wetco-logo.jpg'

/** Demo branding for this build (WETCO SOLAR SOLUTIONS, Multan). Every field stays editable. */
const WETCO = {
  name: 'WETCO SOLAR SOLUTIONS',
  tagline:
    'We deal in Domestic, Commercial & Industrial projects, including On-Grid, Off-Grid & Hybrid Solar Systems, PV genset, LT/HT Panels, Power Factor Panels, Building Wiring, Fire alarm, fire fighting, Electrical Load Calculation, and complete electrical solutions with professional installation and after-sales support.',
  address: 'Office Number 7-8, Hadi Commercial Center, M.A Jinnah Road, Near Niagara Chowk',
  city: 'Multan',
  phone: '0300-7341433',
  email: 'wetcosolarsolution@gmail.com'
}

async function assetToDataUrl(url: string): Promise<string> {
  const blob = await (await fetch(url)).blob()
  return new Promise((resolve) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result))
    r.readAsDataURL(blob)
  })
}

export function SetupWizard({ onDone }: { onDone: () => void }): JSX.Element {
  const [step, setStep] = useState(0)
  const [busy, setBusy] = useState(false)
  const [firm, setFirm] = useState({ ...WETCO, phone2: '', website: '', ntn: '', strn: '', logo: '' as string | null })
  const [opts, setOpts] = useState({ multiFirm: true, shareInventory: true, shareParties: true, currencySymbol: 'Rs.', extraFirms: ['LAZZAZ TRADERS', 'XAVIAR SOLUTIONS'] })
  const [owner, setOwner] = useState({ fullName: '', username: 'admin', password: '', confirm: '', phone: '', email: '' })
  const [demo, setDemo] = useState(false)

  useEffect(() => {
    assetToDataUrl(wetcoLogo).then((logo) => setFirm((f) => ({ ...f, logo })))
  }, [])

  const steps = [
    { icon: <Building2 />, title: 'Business' },
    { icon: <Users />, title: 'Firms' },
    { icon: <ShieldCheck />, title: 'Owner account' },
    { icon: <Database />, title: 'Finish' }
  ]

  const validate = (): string | null => {
    if (step === 0 && !firm.name.trim()) return 'Enter the business / firm name.'
    if (step === 2) {
      if (!owner.fullName.trim()) return 'Enter the owner name.'
      if (!/^[a-z0-9._-]{3,50}$/i.test(owner.username)) return 'Username must be at least 3 letters/numbers.'
      if (owner.password.length < 6) return 'Password must be at least 6 characters.'
      if (owner.password !== owner.confirm) return 'Passwords do not match.'
    }
    return null
  }

  const next = (): void => {
    const err = validate()
    if (err) return toast.error(err)
    setStep(step + 1)
  }

  const finish = async (): Promise<void> => {
    setBusy(true)
    try {
      await api('auth.setup', {
        firm: { ...firm, logo: firm.logo || null },
        owner: { username: owner.username, fullName: owner.fullName, password: owner.password, phone: owner.phone, email: owner.email },
        multiFirm: opts.multiFirm,
        shareInventory: opts.shareInventory,
        shareParties: opts.shareParties,
        currencySymbol: opts.currencySymbol,
        extraFirms: opts.multiFirm ? opts.extraFirms.filter((s) => s.trim()) : [],
        demoData: demo
      })
      toast.ok('Setup complete. Welcome to DT Solar Pro!')
      onDone()
    } catch (e) {
      toast.error(e)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex h-full">
      <div className="relative hidden w-[380px] shrink-0 flex-col justify-between overflow-hidden bg-gradient-to-br from-[#3d096d] via-[#2a1b8f] to-[#0d60a6] p-8 text-white lg:flex">
        <div className="absolute -top-16 -right-16 h-64 w-64 rounded-full bg-[#ffb12b]/30 blur-3xl" />
        <AppLogo light />
        <div className="relative space-y-4">
          <div className="text-[26px] leading-tight font-bold">Let's set up your solar business</div>
          <div className="text-[14px] text-white/80">Everything is stored securely on this computer and works fully offline.</div>
          <div className="mt-6 space-y-2">
            {steps.map((s, i) => (
              <div key={s.title} className={cx('flex items-center gap-3 rounded-xl px-3 py-2.5 transition', i === step ? 'bg-white/15' : 'opacity-70')}>
                <span className={cx('flex h-8 w-8 items-center justify-center rounded-lg [&>svg]:h-4 [&>svg]:w-4', i < step ? 'bg-[#8bf00a] text-[#123]' : 'bg-white/15')}>{i < step ? <Check /> : s.icon}</span>
                <span className="font-medium">{s.title}</span>
              </div>
            ))}
          </div>
        </div>
        <VendorLine light />
      </div>

      <div className="flex flex-1 flex-col overflow-y-auto">
        <div className="mx-auto w-full max-w-2xl flex-1 px-8 py-10">
          {step === 0 && (
            <div className="fade-in space-y-4">
              <div>
                <div className="text-[22px] font-bold">Business details</div>
                <div className="text-muted">These appear on your invoices, quotations and receipts. You can change them anytime.</div>
              </div>
              <div className="flex items-center gap-4">
                <label className="group relative flex h-24 w-32 cursor-pointer items-center justify-center overflow-hidden rounded-xl border-2 border-dashed border-line bg-surface hover:border-brand">
                  {firm.logo ? <img src={firm.logo} className="h-full w-full object-contain" alt="logo" /> : <ImagePlus className="h-7 w-7 text-muted" />}
                  <input
                    type="file"
                    accept="image/*"
                    className="hidden"
                    onChange={async (e) => {
                      const f = e.target.files?.[0]
                      if (f) setFirm({ ...firm, logo: await readImageFile(f).catch((er) => (toast.error(er), firm.logo)) })
                    }}
                  />
                </label>
                <div className="text-[13px] text-muted">
                  Firm logo (PNG/JPG). Pre-filled with the WETCO demo branding.
                  <div className="mt-2 flex gap-2">
                    <Button size="sm" variant="soft" onClick={async () => setFirm({ ...firm, ...WETCO, logo: await assetToDataUrl(wetcoLogo) })}>
                      Use WETCO details
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setFirm({ name: '', tagline: '', address: '', city: '', phone: '', phone2: '', email: '', website: '', ntn: '', strn: '', logo: null })}>
                      Clear
                    </Button>
                  </div>
                </div>
              </div>
              <Field label="Firm / business name" required>
                <Input value={firm.name} onChange={(e) => setFirm({ ...firm, name: e.target.value })} autoFocus />
              </Field>
              <Field label="Services / tagline (printed under the name)">
                <Textarea rows={3} value={firm.tagline} onChange={(e) => setFirm({ ...firm, tagline: e.target.value })} />
              </Field>
              <div className="grid grid-cols-3 gap-3">
                <Field label="Address" className="col-span-2">
                  <Input value={firm.address} onChange={(e) => setFirm({ ...firm, address: e.target.value })} />
                </Field>
                <Field label="City">
                  <Input value={firm.city} onChange={(e) => setFirm({ ...firm, city: e.target.value })} />
                </Field>
                <Field label="Phone">
                  <Input value={firm.phone} onChange={(e) => setFirm({ ...firm, phone: e.target.value })} />
                </Field>
                <Field label="Email">
                  <Input value={firm.email} onChange={(e) => setFirm({ ...firm, email: e.target.value })} />
                </Field>
                <Field label="NTN (optional)">
                  <Input value={firm.ntn} onChange={(e) => setFirm({ ...firm, ntn: e.target.value })} />
                </Field>
              </div>
            </div>
          )}

          {step === 1 && (
            <div className="fade-in space-y-5">
              <div>
                <div className="text-[22px] font-bold">Multiple firms</div>
                <div className="text-muted">Run several firms for the same business. Each firm keeps its own invoices, ledgers and reports.</div>
              </div>
              <div className="card space-y-5 p-5">
                <Toggle checked={opts.multiFirm} onChange={(v) => setOpts({ ...opts, multiFirm: v })} label="Enable Multiple Firms" description="Allows you to create multiple firms where inventory and parties can be shared." />
                {opts.multiFirm && (
                  <>
                    <Toggle checked={opts.shareInventory} onChange={(v) => setOpts({ ...opts, shareInventory: v })} label="Share inventory between firms" description="One stock pool. Each firm still has separate sales, purchases and profit." />
                    <Toggle checked={opts.shareParties} onChange={(v) => setOpts({ ...opts, shareParties: v })} label="Share customers & suppliers between firms" description="Same customer list; balances are still kept per firm." />
                    <Field label="Additional firms to create now (optional)" hint="You can add or rename firms later in Multi-Firm Settings.">
                      <div className="space-y-2">
                        {opts.extraFirms.map((n, i) => (
                          <Input key={i} value={n} onChange={(e) => setOpts({ ...opts, extraFirms: opts.extraFirms.map((x, j) => (j === i ? e.target.value : x)) })} placeholder={`Firm ${i + 2} name`} />
                        ))}
                        {opts.extraFirms.length < 4 && (
                          <Button size="sm" variant="ghost" onClick={() => setOpts({ ...opts, extraFirms: [...opts.extraFirms, ''] })}>
                            + Add another firm
                          </Button>
                        )}
                      </div>
                    </Field>
                  </>
                )}
              </div>
              <Field label="Currency symbol" className="w-40">
                <Input value={opts.currencySymbol} onChange={(e) => setOpts({ ...opts, currencySymbol: e.target.value })} />
              </Field>
            </div>
          )}

          {step === 2 && (
            <div className="fade-in space-y-4">
              <div>
                <div className="text-[22px] font-bold">Owner account</div>
                <div className="text-muted">The Super Administrator has full access, including users, permissions, backup and license.</div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Full name" required className="col-span-2">
                  <Input value={owner.fullName} onChange={(e) => setOwner({ ...owner, fullName: e.target.value })} autoFocus />
                </Field>
                <Field label="Username" required>
                  <Input value={owner.username} onChange={(e) => setOwner({ ...owner, username: e.target.value.toLowerCase() })} />
                </Field>
                <Field label="Mobile">
                  <Input value={owner.phone} onChange={(e) => setOwner({ ...owner, phone: e.target.value })} />
                </Field>
                <Field label="Password" required hint="At least 6 characters. Keep it safe — it protects your financial data.">
                  <Input type="password" value={owner.password} onChange={(e) => setOwner({ ...owner, password: e.target.value })} />
                </Field>
                <Field label="Confirm password" required>
                  <Input type="password" value={owner.confirm} onChange={(e) => setOwner({ ...owner, confirm: e.target.value })} />
                </Field>
              </div>
            </div>
          )}

          {step === 3 && (
            <div className="fade-in space-y-4">
              <div>
                <div className="text-[22px] font-bold">Ready to go</div>
                <div className="text-muted">Choose how you want to start.</div>
              </div>
              <button type="button" onClick={() => setDemo(false)} className={cx('card flex w-full items-start gap-4 p-5 text-left cursor-pointer', !demo && 'ring-2 ring-brand')}>
                <Rocket className="mt-0.5 h-6 w-6 text-brand" />
                <div>
                  <div className="font-semibold">Start with a clean database (recommended)</div>
                  <div className="text-[13px] text-muted">For real business use. Add your products, opening stock, customers and suppliers.</div>
                </div>
              </button>
              <button type="button" onClick={() => setDemo(true)} className={cx('card flex w-full items-start gap-4 p-5 text-left cursor-pointer', demo && 'ring-2 ring-brand')}>
                <Sparkles className="mt-0.5 h-6 w-6 text-sun" />
                <div>
                  <div className="font-semibold">Load sample solar business data</div>
                  <div className="text-[13px] text-muted">For demonstrations and training only: sample products, suppliers, customers, invoices and a 25 kW project with full costing.</div>
                </div>
              </button>
              <div className="card space-y-1 p-4 text-[13px]">
                <div><b>Firm:</b> {firm.name}</div>
                {opts.multiFirm && opts.extraFirms.filter(Boolean).length > 0 && <div><b>Also creating:</b> {opts.extraFirms.filter(Boolean).join(', ')}</div>}
                <div><b>Owner:</b> {owner.fullName} ({owner.username})</div>
                <div className="flex items-center gap-2 pt-1 text-muted">
                  <Check className="h-4 w-4 text-ok" /> Automatic daily backup to Documents\DT Solar Pro Backups
                </div>
              </div>
            </div>
          )}
        </div>
        <div className="sticky bottom-0 flex items-center justify-between border-t border-line bg-surface px-8 py-4">
          <Button variant="ghost" disabled={step === 0} onClick={() => setStep(step - 1)} icon={<ChevronLeft className="h-4 w-4" />}>
            Back
          </Button>
          {step < 3 ? (
            <Button variant="primary" onClick={next}>
              Continue <ChevronRight className="h-4 w-4" />
            </Button>
          ) : (
            <Button variant="primary" loading={busy} onClick={finish} icon={<Check className="h-4 w-4" />}>
              Finish setup
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}
