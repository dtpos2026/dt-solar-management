import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { onSnapshot, orderBy, query } from 'firebase/firestore'
import { Plus, Search } from 'lucide-react'
import { Badge, Field, Modal, PageTitle } from '../components/ui'
import { createLicense, effectiveStatus, expiryLabel, licenseFromSnap, licensesCol, updateLicense, type LicenseInput } from '../lib/licenses'
import { DEFAULT_CHECKIN_DAYS, DEFAULT_GRACE_DAYS, FEATURES, PLAN_PRESETS, type License, type Plan } from '../lib/types'
import { addYears, errorMessage, fromInputDate, toInputDate } from '../lib/format'
import { useAdminEmail } from '../lib/auth'

export function Licenses() {
  const nav = useNavigate()
  const [rows, setRows] = useState<License[]>([])
  const [q, setQ] = useState('')
  const [status, setStatus] = useState('')
  const [form, setForm] = useState(false)
  useEffect(() => onSnapshot(query(licensesCol(), orderBy('createdAt', 'desc')), (s) => setRows(s.docs.map(licenseFromSnap)), () => undefined), [])
  const list = useMemo(() => rows.filter((l) => {
    const t = `${l.businessName} ${l.customerName} ${l.licenseKey} ${l.phone} ${l.city}`.toLowerCase()
    return (!q || t.includes(q.toLowerCase())) && (!status || effectiveStatus(l) === status)
  }), [rows, q, status])
  return (
    <div>
      <PageTitle title="Licenses" sub={`${rows.length} license(s)`} actions={<button className="btn btn-primary" onClick={() => setForm(true)}><Plus className="h-4 w-4" />New license</button>} />
      <div className="mb-4 flex flex-wrap gap-2">
        <div className="relative w-80"><Search className="absolute top-2.5 left-3 h-4 w-4 text-[#7a6d92]" /><input className="input pl-9" placeholder="Search business, customer, key, phone…" value={q} onChange={(e) => setQ(e.target.value)} /></div>
        <select className="input w-44" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">All statuses</option><option value="active">Active</option><option value="suspended">Suspended</option><option value="revoked">Revoked</option><option value="expired">Expired</option>
        </select>
      </div>
      <div className="card">
        <table className="tbl">
          <thead><tr><th>Business / customer</th><th>License key</th><th>Plan</th><th>Devices</th><th>Firms / users</th><th>Expiry</th><th>Status</th></tr></thead>
          <tbody>
            {list.map((l) => (
              <tr key={l.id} className="click" onClick={() => nav(`/licenses/${l.id}`)}>
                <td><div className="font-semibold">{l.businessName}</div><div className="text-[12px] text-[#7a6d92]">{l.customerName} · {l.phone} {l.city && `· ${l.city}`}</div></td>
                <td className="font-mono text-[12.5px]">{l.licenseKey}</td>
                <td className="capitalize">{l.plan}</td>
                <td>{l.activeDevices} / {l.maxDevices}</td>
                <td>{l.maxFirms} / {l.maxUsers}</td>
                <td>{expiryLabel(l)}</td>
                <td><Badge>{effectiveStatus(l)}</Badge></td>
              </tr>
            ))}
            {list.length === 0 && <tr><td colSpan={7} className="py-8 text-center text-[#7a6d92]">No licenses yet. Click “New license”.</td></tr>}
          </tbody>
        </table>
      </div>
      <LicenseForm open={form} onClose={() => setForm(false)} onSaved={(id) => nav(`/licenses/${id}`)} />
    </div>
  )
}

export function LicenseForm({ open, license, onClose, onSaved }: { open: boolean; license?: License; onClose: () => void; onSaved: (id: string) => void }) {
  const by = useAdminEmail()
  const blank = (): LicenseInput => ({ customerName: '', businessName: '', phone: '', email: '', city: '', plan: 'professional', ...PLAN_PRESETS.professional, expiresAt: addYears(new Date(), 1), checkinDays: DEFAULT_CHECKIN_DAYS, graceDays: DEFAULT_GRACE_DAYS, notes: '' })
  const [f, setF] = useState<LicenseInput>(blank())
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  useEffect(() => {
    if (!open) return
    setErr(null)
    setF(license ? { customerName: license.customerName, businessName: license.businessName, phone: license.phone, email: license.email, city: license.city, plan: license.plan, maxDevices: license.maxDevices, maxFirms: license.maxFirms, maxUsers: license.maxUsers, features: license.features, expiresAt: license.expiresAt ? license.expiresAt.toDate() : null, checkinDays: license.checkinDays, graceDays: license.graceDays, notes: license.notes } : blank())
  }, [open, license]) // eslint-disable-line react-hooks/exhaustive-deps
  const set = (p: Partial<LicenseInput>) => setF((x) => ({ ...x, ...p }))
  const save = async () => {
    setBusy(true)
    setErr(null)
    try {
      if (license) { await updateLicense(license, f, by); onSaved(license.id) } else { const r = await createLicense(f, by); onSaved(r.id) }
      onClose()
    } catch (e) {
      setErr(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Modal open={open} onClose={onClose} title={license ? 'Edit license' : 'New license'} wide footer={<><button className="btn btn-secondary" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={busy} onClick={save}>{license ? 'Save changes' : 'Create license'}</button></>}>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Business name"><input className="input" value={f.businessName} onChange={(e) => set({ businessName: e.target.value })} autoFocus /></Field>
        <Field label="Customer / owner name"><input className="input" value={f.customerName} onChange={(e) => set({ customerName: e.target.value })} /></Field>
        <Field label="Phone"><input className="input" value={f.phone} onChange={(e) => set({ phone: e.target.value })} /></Field>
        <Field label="Email"><input className="input" value={f.email} onChange={(e) => set({ email: e.target.value })} /></Field>
        <Field label="City"><input className="input" value={f.city} onChange={(e) => set({ city: e.target.value })} /></Field>
        <Field label="Plan">
          <select className="input" value={f.plan} onChange={(e) => { const p = e.target.value as Plan; set({ plan: p, ...PLAN_PRESETS[p] }) }}>
            {(Object.keys(PLAN_PRESETS) as Plan[]).map((p) => <option key={p} value={p}>{PLAN_PRESETS[p].label}</option>)}
          </select>
        </Field>
        <div className="col-span-2 grid grid-cols-3 gap-3">
          <Field label="Max computers"><input className="input" type="number" min={1} value={f.maxDevices} onChange={(e) => set({ maxDevices: Number(e.target.value) })} /></Field>
          <Field label="Max firms"><input className="input" type="number" min={1} value={f.maxFirms} onChange={(e) => set({ maxFirms: Number(e.target.value) })} /></Field>
          <Field label="Max users"><input className="input" type="number" min={1} value={f.maxUsers} onChange={(e) => set({ maxUsers: Number(e.target.value) })} /></Field>
        </div>
        <Field label="Expiry" hint={f.expiresAt ? undefined : 'Lifetime license'}>
          <div className="flex gap-2">
            <input className="input" type="date" value={toInputDate(f.expiresAt)} onChange={(e) => set({ expiresAt: fromInputDate(e.target.value) })} />
            <button className="btn btn-secondary btn-sm h-[38px]" onClick={() => set({ expiresAt: addYears(new Date(), 1) })}>+1 yr</button>
            <button className="btn btn-secondary btn-sm h-[38px]" onClick={() => set({ expiresAt: null })}>Lifetime</button>
          </div>
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Online check every (days)" hint="0 = never needs internet"><input className="input" type="number" min={0} value={f.checkinDays} onChange={(e) => set({ checkinDays: Number(e.target.value) })} /></Field>
          <Field label="Grace days"><input className="input" type="number" min={0} value={f.graceDays} onChange={(e) => set({ graceDays: Number(e.target.value) })} /></Field>
        </div>
        <div className="col-span-2 flex flex-wrap gap-4">
          {FEATURES.map((ft) => (
            <label key={ft.id} className="flex items-center gap-2 text-[13px]" title={ft.hint}>
              <input type="checkbox" checked={f.features.includes(ft.id)} onChange={(e) => set({ features: e.target.checked ? [...f.features, ft.id] : f.features.filter((x) => x !== ft.id) })} />{ft.label}
            </label>
          ))}
        </div>
        <Field label="Notes" className="col-span-2"><textarea className="input" rows={2} value={f.notes} onChange={(e) => set({ notes: e.target.value })} /></Field>
      </div>
      {err && <div className="mt-3 rounded-lg bg-red-50 p-3 text-[13px] text-red-700">{err}</div>}
    </Modal>
  )
}
