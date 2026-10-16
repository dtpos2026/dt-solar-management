/** Create / edit a client (company). Also used for "Create client from license" on legacy licenses. */
import { useEffect, useRef, useState } from 'react'
import { ImagePlus, Loader2, Trash2 } from 'lucide-react'
import { Field, Modal } from '../../components/ui'
import { CLIENT_STATUSES, PLAN_TYPE_LABEL, PLAN_TYPES, blankClient, validateClient, type ClientInput } from '../../lib/clients'
import { clientToInput, compressLogo, createClient, updateClient } from '../../lib/clientsDb'
import { useAdminEmail } from '../../lib/auth'
import { logActivitySafe } from '../../lib/audit'
import { errorMessage, toInputDate } from '../../lib/format'
import { PAID_PLANS, PLAN_PRESETS, type Client, type License, type Plan } from '../../lib/types'

export interface ClientFormProps {
  open: boolean
  client?: Client | null
  /** Prefill for a new client (e.g. from a legacy license or registration details). */
  prefill?: ClientInput | null
  /** When set, the new client is linked to this license in the same transaction. */
  linkLicense?: License | null
  onClose: () => void
  onSaved: (id: string, info: { created: boolean; code?: string }) => void
}

export function ClientForm({ open, client, prefill, linkLicense, onClose, onSaved }: ClientFormProps) {
  const by = useAdminEmail()
  const [f, setF] = useState<ClientInput>(blankClient())
  const [errs, setErrs] = useState<Partial<Record<keyof ClientInput, string>>>({})
  const [formErr, setFormErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [logoBusy, setLogoBusy] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!open) return
    setErrs({})
    setFormErr(null)
    setF(client ? clientToInput(client) : { ...blankClient(), registeredAt: toInputDate(new Date()), ...(prefill ?? {}) })
  }, [open, client, prefill])

  const set = (p: Partial<ClientInput>) => setF((x) => ({ ...x, ...p }))
  const err = (k: keyof ClientInput) => errs[k] && <span className="text-red-600">{errs[k]}</span>

  const pickLogo = async (file: File | undefined) => {
    if (!file) return
    setLogoBusy(true)
    setErrs((e) => ({ ...e, logo: undefined }))
    try {
      set({ logo: await compressLogo(file) })
    } catch (e) {
      setErrs((x) => ({ ...x, logo: errorMessage(e) }))
    } finally {
      setLogoBusy(false)
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  const save = async () => {
    const e = validateClient(f)
    setErrs(e)
    if (Object.keys(e).length) return
    setBusy(true)
    setFormErr(null)
    try {
      if (client) {
        await updateClient(client, f, by)
        onSaved(client.id, { created: false })
      } else {
        const r = await createClient(f, by, linkLicense ? { license: linkLicense, reason: 'created from the license' } : undefined)
        onSaved(r.id, { created: true, code: r.code })
      }
      onClose()
    } catch (x) {
      setFormErr(errorMessage(x))
      logActivitySafe({ action: client ? 'client_update_failed' : 'client_create_failed', category: 'client', status: 'failure', target: client?.id ?? '', targetType: 'client', details: errorMessage(x) })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      open={open}
      onClose={() => !busy && onClose()}
      title={client ? `Edit client ${client.code}` : linkLicense ? 'Create client from license' : 'New client'}
      wide
      footer={
        <>
          <button className="btn btn-secondary" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={busy || logoBusy} onClick={save}>
            {busy && <Loader2 className="h-4 w-4 animate-spin" />}
            {client ? 'Save changes' : linkLicense ? 'Create & link client' : 'Create client'}
          </button>
        </>
      }
    >
      {linkLicense && (
        <div className="mb-3 rounded-lg bg-[#f6f0fd] p-3 text-[13px] text-[#3d096d]">
          The new client gets the next client code and license <b className="font-mono">{linkLicense.licenseKey}</b> is linked to it.
        </div>
      )}
      <div className="grid grid-cols-2 gap-3">
        <div className="col-span-2 flex items-center gap-4">
          <div className="flex h-20 w-20 shrink-0 items-center justify-center overflow-hidden rounded-xl border border-[#e7e1f0] bg-[#faf8fd]">
            {logoBusy ? <Loader2 className="h-5 w-5 animate-spin text-[#7c3aed]" /> : f.logo ? <img src={f.logo} alt="Logo" className="h-full w-full object-contain" /> : <ImagePlus className="h-7 w-7 text-[#b9a6d6]" />}
          </div>
          <div className="text-[12.5px] text-[#6b5d85]">
            <div className="flex gap-2">
              <button type="button" className="btn btn-secondary btn-sm" onClick={() => fileRef.current?.click()} disabled={logoBusy}>
                <ImagePlus className="h-4 w-4" />
                {f.logo ? 'Change logo' : 'Upload logo'}
              </button>
              {f.logo && (
                <button type="button" className="btn btn-secondary btn-sm" onClick={() => set({ logo: null })}>
                  <Trash2 className="h-4 w-4" />
                  Remove
                </button>
              )}
            </div>
            <div className="mt-1">PNG / JPEG / WebP — resized and compressed in the browser (stored inline, max 200 KB).</div>
            {err('logo')}
          </div>
          <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp" className="hidden" onChange={(e) => pickLogo(e.target.files?.[0])} aria-label="Logo file" />
        </div>
        <Field label="Company name *" hint={err('company')}>
          <input className="input" value={f.company} onChange={(e) => set({ company: e.target.value })} maxLength={200} autoFocus />
        </Field>
        <Field label="Owner name" hint={err('ownerName')}>
          <input className="input" value={f.ownerName} onChange={(e) => set({ ownerName: e.target.value })} maxLength={200} />
        </Field>
        <Field label="Phone" hint={err('phone')}>
          <input className="input" value={f.phone} onChange={(e) => set({ phone: e.target.value })} maxLength={30} placeholder="+92 300 1234567" />
        </Field>
        <Field label="Email" hint={err('email')}>
          <input className="input" value={f.email} onChange={(e) => set({ email: e.target.value })} maxLength={200} />
        </Field>
        <Field label="Address" hint={err('address')} className="col-span-2">
          <input className="input" value={f.address} onChange={(e) => set({ address: e.target.value })} maxLength={300} />
        </Field>
        <Field label="City">
          <input className="input" value={f.city} onChange={(e) => set({ city: e.target.value })} maxLength={100} />
        </Field>
        <Field label="Registered on" hint={err('registeredAt')}>
          <input className="input" type="date" value={f.registeredAt} onChange={(e) => set({ registeredAt: e.target.value })} />
        </Field>
        <Field label="Plan">
          <select
            className="input"
            value={f.plan}
            onChange={(e) => {
              const p = e.target.value as Plan
              set({ plan: p, ...(PLAN_PRESETS[p] ? { allowedFirms: PLAN_PRESETS[p].maxFirms, allowedDevices: PLAN_PRESETS[p].maxDevices } : {}) })
            }}
          >
            {(PAID_PLANS as Plan[]).map((p) => (
              <option key={p} value={p}>
                {PLAN_PRESETS[p].label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Billing cycle" hint={err('planType')}>
          <select className="input" value={f.planType} onChange={(e) => set({ planType: e.target.value as ClientInput['planType'] })}>
            {PLAN_TYPES.map((p) => (
              <option key={p} value={p}>
                {PLAN_TYPE_LABEL[p]}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Allowed firms" hint={err('allowedFirms')}>
          <input className="input" type="number" min={1} max={1000} value={f.allowedFirms} onChange={(e) => set({ allowedFirms: Number(e.target.value) })} />
        </Field>
        <Field label="Allowed computers" hint={err('allowedDevices')}>
          <input className="input" type="number" min={1} max={1000} value={f.allowedDevices} onChange={(e) => set({ allowedDevices: Number(e.target.value) })} />
        </Field>
        {client && (
          <Field label="Status" hint="Use Suspend / Reactivate / Archive on the client page to also update its licenses.">
            <select className="input" value={f.status} onChange={(e) => set({ status: e.target.value as ClientInput['status'] })} disabled>
              {CLIENT_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </Field>
        )}
        <Field label="Notes" hint={err('notes')} className="col-span-2">
          <textarea className="input" rows={3} value={f.notes} onChange={(e) => set({ notes: e.target.value })} maxLength={4000} />
        </Field>
      </div>
      {formErr && <div className="mt-3 rounded-lg bg-red-50 p-3 text-[13px] text-red-700">{formErr}</div>}
    </Modal>
  )
}
