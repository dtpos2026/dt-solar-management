/** Create a license (secure key generation) or edit its customer details. Terms change via LicenseActions. */
import { useEffect, useMemo, useState } from 'react'
import { Loader2, Sparkles } from 'lucide-react'
import { Field, Modal } from '../components/ui'
import { createLicense, updateLicense, type LicenseInput } from '../lib/licenses'
import { DEFAULT_CHECKIN_DAYS, DEFAULT_GRACE_DAYS, FEATURES, PAID_PLANS, PLAN_PRESETS, type Client, type License, type Plan, type PlanType } from '../lib/types'
import { errorMessage, fromInputDate, toInputDate } from '../lib/format'
import { useAdminEmail, useCan } from '../lib/auth'
import { suggestExpiry, planTermsError } from '../lib/terms'
import { PLAN_TYPES, PLAN_TYPE_LABEL, clientDetailsFromLicense, findDuplicateClient, isValidClientPhone } from '../lib/clients'
import { clientSyncFor, loadClients } from '../lib/clientsDb'
import { loadBranding } from '../lib/fleet'
import { logActivitySafe } from '../lib/audit'

export interface LicenseFormProps {
  open: boolean
  license?: License
  /** Prefill for a new license created from a client page. */
  client?: Client | null
  onClose: () => void
  onSaved: (id: string, info: { created: boolean; certChange: boolean; licenseKey?: string; client?: { label: string; created: boolean } }) => void
}

type Errors = Partial<Record<'name' | 'email' | 'phone' | 'expiry' | 'limits' | 'form', string>>

export function LicenseForm({ open, license, client, onClose, onSaved }: LicenseFormProps) {
  const by = useAdminEmail()
  const can = useCan()
  const [clients, setClients] = useState<Client[] | null>(null)
  const blank = (): LicenseInput => ({
    customerName: '',
    businessName: '',
    phone: '',
    email: '',
    city: '',
    plan: 'professional',
    ...PLAN_PRESETS.professional,
    expiresAt: suggestExpiry('yearly', new Date()),
    checkinDays: DEFAULT_CHECKIN_DAYS,
    graceDays: DEFAULT_GRACE_DAYS,
    notes: '',
    clientId: '',
    planType: 'yearly',
    poweredBy: false
  })
  const [f, setF] = useState<LicenseInput>(blank())
  const [busy, setBusy] = useState(false)
  const [errs, setErrs] = useState<Errors>({})
  // Save the owner / company / phone typed here as a client record (matched by phone or company + owner, else created).
  const canSync = can('clients.manage') && can('clients.view')
  const [sync, setSync] = useState(true)

  useEffect(() => {
    if (!open) return
    setErrs({})
    setSync(true)
    if (license) {
      setF({
        customerName: license.customerName,
        businessName: license.businessName,
        phone: license.phone,
        email: license.email,
        city: license.city,
        plan: license.plan,
        maxDevices: license.maxDevices,
        maxFirms: license.maxFirms,
        maxUsers: license.maxUsers,
        features: license.features,
        expiresAt: license.expiresAt ? license.expiresAt.toDate() : null,
        checkinDays: license.checkinDays,
        graceDays: license.graceDays,
        notes: license.notes,
        clientId: license.clientId,
        planType: license.planType,
        poweredBy: license.poweredBy
      })
    } else {
      const b = blank()
      if (client) {
        const plan = (['standard', 'professional', 'enterprise'].includes(client.plan) ? client.plan : 'professional') as Plan
        Object.assign(b, {
          businessName: client.company,
          customerName: client.ownerName,
          phone: client.phone,
          email: client.email,
          city: client.city,
          clientId: client.id,
          plan,
          ...PLAN_PRESETS[plan],
          planType: client.planType,
          expiresAt: suggestExpiry(client.planType, new Date()),
          maxFirms: Math.max(1, client.allowedFirms || PLAN_PRESETS[plan].maxFirms),
          maxDevices: Math.max(1, client.allowedDevices || PLAN_PRESETS[plan].maxDevices)
        })
      }
      setF(b)
      // "Powered by Digital Target" default comes from Settings → Branding.
      loadBranding().then((br) => setF((x) => ({ ...x, poweredBy: br.poweredByDefault === true })))
    }
    if (can('clients.view')) {
      loadClients()
        .then(setClients)
        .catch(() => setClients([]))
    }
  }, [open, license, client]) // eslint-disable-line react-hooks/exhaustive-deps

  const set = (p: Partial<LicenseInput>) => setF((x) => ({ ...x, ...p }))
  const planType = f.planType ?? 'yearly'
  const pickableClients = useMemo(() => (clients ?? []).filter((c) => c.status !== 'archived' || c.id === f.clientId).sort((a, b) => a.company.localeCompare(b.company)), [clients, f.clientId])
  const syncing = canSync && sync
  const picked = (clients ?? []).find((c) => c.id === f.clientId) ?? null
  // Preview of what saving does to the client records (the save itself re-reads the clients).
  const syncHint = useMemo(() => {
    if (!syncing) return null
    if (picked) return `On save, empty fields of ${picked.code} · ${picked.company} are filled from these details (nothing is overwritten).`
    const d = clientDetailsFromLicense(f)
    if (!d.company) return 'Enter the business or customer name: a client record is created or matched on save.'
    const m = clients ? findDuplicateClient(clients, d) : null
    return m
      ? `On save, the license is linked to the existing client ${m.client.code} · ${m.client.company} (same ${m.by === 'phone' ? 'phone number' : 'company and owner name'}); its empty fields are filled from these details.`
      : 'On save, a new client is created from these details and linked (no client with the same phone or company + owner name exists).'
  }, [syncing, picked, clients, f])

  const validate = (): Errors => {
    const e: Errors = {}
    if (!f.businessName.trim() && !f.customerName.trim()) e.name = 'Enter the business name or the customer name.'
    if (f.email.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(f.email.trim())) e.email = 'Enter a valid email address.'
    if (syncing && f.phone.trim() && !isValidClientPhone(f.phone)) e.phone = 'Enter a valid phone number (digits, spaces, + - ( )) — it is saved on the client too.'
    if (!license) {
      const pe = planTermsError(planType, f.expiresAt ? f.expiresAt.getTime() : null)
      if (pe) e.expiry = pe
      else if (f.expiresAt && f.expiresAt.getTime() <= Date.now()) e.expiry = 'The expiry date must be in the future.'
      if (!(f.maxDevices >= 1 && f.maxFirms >= 1 && f.maxUsers >= 1)) e.limits = 'Limits must be at least 1.'
    } else if (!(f.maxUsers >= 1)) e.limits = 'Max users must be at least 1.'
    return e
  }

  const save = async () => {
    const e = validate()
    setErrs(e)
    if (Object.keys(e).length) return
    setBusy(true)
    try {
      // Client record from the details (fresh read of the clients so no duplicate is created), applied in the
      // same transaction as the license.
      const linker = syncing ? (await clientSyncFor(f, by)).linker : undefined
      if (license) {
        const certChange = await updateLicense(license, f, by, linker)
        onSaved(license.id, { created: false, certChange })
      } else {
        const r = await createLicense(f, by, undefined, linker)
        onSaved(r.id, { created: true, certChange: false, licenseKey: r.licenseKey, client: r.client })
      }
      onClose()
    } catch (err) {
      setErrs({ form: errorMessage(err) })
      logActivitySafe({ action: license ? 'license_update_failed' : 'license_create_failed', category: 'license', status: 'failure', licenseId: license?.id ?? null, details: errorMessage(err) })
    } finally {
      setBusy(false)
    }
  }

  const setPlanType = (pt: PlanType) => set({ planType: pt, expiresAt: suggestExpiry(pt, new Date()) })

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={license ? 'Edit license details' : 'New license'}
      wide
      footer={
        <>
          <button className="btn btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={busy} onClick={save}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : !license && <Sparkles className="h-4 w-4" />}
            {license ? 'Save changes' : 'Generate key & create license'}
          </button>
        </>
      }
    >
      <div className="grid grid-cols-2 gap-3">
        {can('clients.view') && (
          <Field label="Client (company)" className="col-span-2" hint={clients === null ? 'Loading clients…' : syncHint ?? 'Linking keeps billing, devices and support of one company together.'}>
            <select className="input" value={f.clientId ?? ''} onChange={(e) => {
              const c = (clients ?? []).find((x) => x.id === e.target.value)
              set(c && !license ? { clientId: c.id, businessName: f.businessName || c.company, customerName: f.customerName || c.ownerName, phone: f.phone || c.phone, email: f.email || c.email, city: f.city || c.city } : { clientId: e.target.value })
            }}>
              <option value="">{syncing ? '— Match or create from the details below —' : '— No client —'}</option>
              {pickableClients.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.code} · {c.company}
                  {c.status !== 'active' ? ` (${c.status})` : ''}
                </option>
              ))}
            </select>
          </Field>
        )}
        {canSync && (
          <label className="col-span-2 -mt-1 flex items-center gap-2 text-[13px]">
            <input type="checkbox" checked={sync} onChange={(e) => setSync(e.target.checked)} />
            Save the company, owner name and phone below as a client record (create or update it, no duplicates)
          </label>
        )}
        <Field label="Business name">
          <input className="input" value={f.businessName} onChange={(e) => set({ businessName: e.target.value })} autoFocus maxLength={200} />
        </Field>
        <Field label="Customer / owner name">
          <input className="input" value={f.customerName} onChange={(e) => set({ customerName: e.target.value })} maxLength={200} />
        </Field>
        {errs.name && <div className="col-span-2 -mt-1 text-[12.5px] text-red-600">{errs.name}</div>}
        <Field label="Phone" hint={errs.phone && <span className="text-red-600">{errs.phone}</span>}>
          <input className="input" value={f.phone} onChange={(e) => set({ phone: e.target.value })} maxLength={60} />
        </Field>
        <Field label="Email" hint={errs.email && <span className="text-red-600">{errs.email}</span>}>
          <input className="input" value={f.email} onChange={(e) => set({ email: e.target.value })} maxLength={200} />
        </Field>
        <Field label="City">
          <input className="input" value={f.city} onChange={(e) => set({ city: e.target.value })} maxLength={100} />
        </Field>
        {!license && (
          <Field label="Plan">
            <select className="input" value={f.plan} onChange={(e) => { const p = e.target.value as Plan; set({ plan: p, ...PLAN_PRESETS[p] }) }}>
              {(PAID_PLANS as Plan[]).map((p) => (
                <option key={p} value={p}>
                  {PLAN_PRESETS[p].label}
                </option>
              ))}
            </select>
          </Field>
        )}
        {!license && (
          <>
            <Field label="Billing cycle">
              <div className="flex gap-1.5">
                {PLAN_TYPES.map((pt) => (
                  <button key={pt} type="button" className={`btn btn-sm h-[38px] flex-1 justify-center ${planType === pt ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setPlanType(pt)}>
                    {PLAN_TYPE_LABEL[pt]}
                  </button>
                ))}
              </div>
            </Field>
            <Field label="Expiry" hint={errs.expiry ? <span className="text-red-600">{errs.expiry}</span> : planType === 'lifetime' ? 'Lifetime — no expiry.' : `Suggested: ${planType === 'monthly' ? '+1 month' : '+1 year'} from today. You can change it.`}>
              <input className="input" type="date" disabled={planType === 'lifetime'} value={toInputDate(f.expiresAt)} onChange={(e) => set({ expiresAt: fromInputDate(e.target.value) })} />
            </Field>
            <div className="col-span-2 grid grid-cols-3 gap-3">
              <Field label="Max computers">
                <input className="input" type="number" min={1} value={f.maxDevices} onChange={(e) => set({ maxDevices: Number(e.target.value) })} />
              </Field>
              <Field label="Max firms">
                <input className="input" type="number" min={1} value={f.maxFirms} onChange={(e) => set({ maxFirms: Number(e.target.value) })} />
              </Field>
              <Field label="Max users">
                <input className="input" type="number" min={1} value={f.maxUsers} onChange={(e) => set({ maxUsers: Number(e.target.value) })} />
              </Field>
            </div>
          </>
        )}
        {license && (
          <Field label="Max users" hint="Plan, expiry, firm and computer limits change through the license actions (with a reason).">
            <input className="input" type="number" min={1} value={f.maxUsers} onChange={(e) => set({ maxUsers: Number(e.target.value) })} />
          </Field>
        )}
        {errs.limits && <div className="col-span-2 -mt-1 text-[12.5px] text-red-600">{errs.limits}</div>}
        {!(license?.detached) && (
          <div className="grid grid-cols-2 gap-3">
            <Field label="Online check every (days)" hint="0 = never needs internet">
              <input className="input" type="number" min={0} value={f.checkinDays} onChange={(e) => set({ checkinDays: Number(e.target.value) })} />
            </Field>
            <Field label="Grace days">
              <input className="input" type="number" min={0} value={f.graceDays} onChange={(e) => set({ graceDays: Number(e.target.value) })} />
            </Field>
          </div>
        )}
        {!license && (
          <label className="col-span-2 flex items-center gap-2 rounded-lg border border-[#ece6f4] bg-[#faf8fd] px-3 py-2 text-[13px]">
            <input type="checkbox" checked={f.poweredBy === true} onChange={(e) => set({ poweredBy: e.target.checked })} />
            Show “Powered by Digital Target” on the customer’s printed documents
            <span className="ml-auto text-[11.5px] text-[#7a6d92]">default from Settings → Branding</span>
          </label>
        )}
        <div className="col-span-2 flex flex-wrap gap-4">
          {FEATURES.map((ft) => (
            <label key={ft.id} className="flex items-center gap-2 text-[13px]" title={ft.hint}>
              <input type="checkbox" checked={f.features.includes(ft.id)} onChange={(e) => set({ features: e.target.checked ? [...f.features, ft.id] : f.features.filter((x) => x !== ft.id) })} />
              {ft.label}
            </label>
          ))}
        </div>
        <Field label="Notes" className="col-span-2">
          <textarea className="input" rows={2} value={f.notes} onChange={(e) => set({ notes: e.target.value })} maxLength={2000} />
        </Field>
      </div>
      {errs.form && <div className="mt-3 rounded-lg bg-red-50 p-3 text-[13px] text-red-700">{errs.form}</div>}
    </Modal>
  )
}
