/** "Issue trial": plan 'trial', 1 computer, expiry +15 days (editable). The computer still needs device approval. */
import { useEffect, useState } from 'react'
import { Loader2, TimerReset } from 'lucide-react'
import { Field, Modal } from '../../components/ui'
import { issueTrial } from '../../lib/licenses'
import { TRIAL_DAYS, TRIAL_MAX_DAYS, trialExpiry, trialExpiryError } from '../../lib/terms'
import { errorMessage, fromInputDate, toInputDate } from '../../lib/format'
import { useAdminEmail } from '../../lib/auth'
import type { Client } from '../../lib/types'

export function TrialDialog({ open, clients, onClose, onIssued }: { open: boolean; clients: Client[]; onClose: () => void; onIssued: (id: string, key: string) => void }) {
  const by = useAdminEmail()
  const [f, setF] = useState({ businessName: '', customerName: '', phone: '', email: '', city: '', clientId: '', expiry: '', notes: '' })
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  useEffect(() => {
    if (!open) return
    setF({ businessName: '', customerName: '', phone: '', email: '', city: '', clientId: '', expiry: toInputDate(trialExpiry(new Date())), notes: '' })
    setErr(null)
    setBusy(false)
  }, [open])
  if (!open) return null
  const set = (p: Partial<typeof f>) => setF((x) => ({ ...x, ...p }))
  const exp = fromInputDate(f.expiry)
  const expErr = trialExpiryError(exp ? exp.getTime() : null)

  const go = async () => {
    if (expErr) return setErr(expErr)
    if (!f.businessName.trim() && !f.customerName.trim()) return setErr('Enter the business name or customer name.')
    setBusy(true)
    setErr(null)
    try {
      const r = await issueTrial({ ...f, clientId: f.clientId || undefined, expiresAt: exp! }, by)
      onIssued(r.id, r.licenseKey)
      onClose()
    } catch (e) {
      setErr(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      open
      onClose={() => !busy && onClose()}
      title="Issue trial license"
      footer={
        <>
          <button className="btn btn-secondary" disabled={busy} onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={busy || !!expErr} onClick={go}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <TimerReset className="h-4 w-4" />}
            Issue trial
          </button>
        </>
      }
    >
      <p className="mb-3 text-[12.5px] text-[#6b5d85]">
        Trial plan, 1 computer, {TRIAL_DAYS} days by default (at most {TRIAL_MAX_DAYS}). The computer that activates it still needs your approval under Activation requests.
      </p>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Business name"><input className="input" value={f.businessName} onChange={(e) => set({ businessName: e.target.value })} /></Field>
        <Field label="Customer name"><input className="input" value={f.customerName} onChange={(e) => set({ customerName: e.target.value })} /></Field>
        <Field label="Phone"><input className="input" value={f.phone} onChange={(e) => set({ phone: e.target.value })} /></Field>
        <Field label="Email"><input className="input" type="email" value={f.email} onChange={(e) => set({ email: e.target.value })} /></Field>
        <Field label="City"><input className="input" value={f.city} onChange={(e) => set({ city: e.target.value })} /></Field>
        <Field label="Trial expires" hint={expErr ? <span className="text-red-600">{expErr}</span> : undefined}>
          <input className="input" type="date" value={f.expiry} onChange={(e) => set({ expiry: e.target.value })} aria-label="Trial expiry" />
        </Field>
        {clients.length > 0 && (
          <Field label="Client (optional)" className="col-span-2">
            <select className="input" value={f.clientId} onChange={(e) => set({ clientId: e.target.value })}>
              <option value="">No client</option>
              {clients.filter((c) => c.status !== 'archived').map((c) => <option key={c.id} value={c.id}>{c.code}, {c.company}</option>)}
            </select>
          </Field>
        )}
        <Field label="Notes" className="col-span-2"><input className="input" value={f.notes} onChange={(e) => set({ notes: e.target.value })} placeholder="Trial license" /></Field>
      </div>
      {err && <div className="mt-3 rounded-lg bg-red-50 p-3 text-[13px] text-red-700">{err}</div>}
    </Modal>
  )
}
