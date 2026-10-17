import { useEffect, useState } from 'react'
import { api } from '../api'
import { Button, Field, Input, Modal, NumberInput, Select, Textarea, Toggle, toast } from './ui'
import { DateInput } from './DateInput'

/* eslint-disable @typescript-eslint/no-explicit-any */
export function PartyForm({ open, onClose, onSaved, type, party, initialName }: { open: boolean; onClose: () => void; onSaved: (id: number) => void; type: 'customer' | 'supplier'; party?: any; initialName?: string }): JSX.Element {
  const blank = { type, name: initialName ?? '', contactPerson: '', phone: '', phone2: '', email: '', address: '', city: '', cnic: '', ntn: '', strn: '', openingBalance: 0, openingType: type === 'supplier' ? 'payable' : 'receivable', openingDate: '', creditLimit: 0, paymentTermsDays: 0, notes: '', isActive: true }
  const [f, setF] = useState<any>(blank)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (!open) return
    if (party) {
      setF({
        id: party.id,
        type: party.type,
        name: party.name ?? '',
        contactPerson: party.contact_person ?? '',
        phone: party.phone ?? '',
        phone2: party.phone2 ?? '',
        email: party.email ?? '',
        address: party.address ?? '',
        city: party.city ?? '',
        cnic: party.cnic ?? '',
        ntn: party.ntn ?? '',
        strn: party.strn ?? '',
        openingBalance: Math.abs(party.opening_balance ?? 0),
        openingType: (party.opening_balance ?? 0) < 0 ? 'payable' : 'receivable',
        openingDate: party.opening_date ?? '',
        creditLimit: party.credit_limit ?? 0,
        paymentTermsDays: party.payment_terms_days ?? 0,
        notes: party.notes ?? '',
        isActive: !!party.is_active
      })
    } else setF({ ...blank, name: initialName ?? '' })
  }, [open, party, initialName]) // eslint-disable-line react-hooks/exhaustive-deps
  const set = (k: string, v: unknown): void => setF((x: any) => ({ ...x, [k]: v }))
  const save = async (): Promise<void> => {
    setBusy(true)
    try {
      const id = await api<number>('parties.save', f)
      toast.ok(`${f.name} saved.`)
      onSaved(id)
      onClose()
    } catch (e) {
      toast.error(e)
    } finally {
      setBusy(false)
    }
  }
  const noun = f.type === 'supplier' ? 'Supplier / Contractor' : 'Customer'
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={party ? `Edit ${noun}` : `New ${noun}`}
      size="lg"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={busy} onClick={save}>
            Save
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-3 gap-3">
        <Field label="Name" required className="col-span-2">
          <Input autoFocus value={f.name} onChange={(e) => set('name', e.target.value)} />
        </Field>
        <Field label="Type">
          <Select value={f.type} onChange={(e) => set('type', e.target.value)}>
            <option value="customer">Customer</option>
            <option value="supplier">Supplier / Contractor</option>
            <option value="both">Both (customer & supplier)</option>
          </Select>
        </Field>
        <Field label="Contact person">
          <Input value={f.contactPerson} onChange={(e) => set('contactPerson', e.target.value)} />
        </Field>
        <Field label="Mobile / phone">
          <Input value={f.phone} onChange={(e) => set('phone', e.target.value)} />
        </Field>
        <Field label="Alternate phone">
          <Input value={f.phone2} onChange={(e) => set('phone2', e.target.value)} />
        </Field>
        <Field label="Address" className="col-span-2">
          <Input value={f.address} onChange={(e) => set('address', e.target.value)} />
        </Field>
        <Field label="City">
          <Input value={f.city} onChange={(e) => set('city', e.target.value)} />
        </Field>
        <Field label="Email">
          <Input value={f.email} onChange={(e) => set('email', e.target.value)} />
        </Field>
        <Field label="CNIC">
          <Input value={f.cnic} onChange={(e) => set('cnic', e.target.value)} placeholder="00000-0000000-0" />
        </Field>
        <Field label="NTN / STRN">
          <div className="flex gap-2">
            <Input value={f.ntn} onChange={(e) => set('ntn', e.target.value)} placeholder="NTN" />
            <Input value={f.strn} onChange={(e) => set('strn', e.target.value)} placeholder="STRN" />
          </div>
        </Field>
        <Field label="Opening balance" hint="Balance carried from before using this software (for the active firm).">
          <div className="flex gap-2">
            <NumberInput value={f.openingBalance} onChange={(v) => set('openingBalance', v)} />
            <Select className="w-40" value={f.openingType} onChange={(e) => set('openingType', e.target.value)}>
              <option value="receivable">They owe us</option>
              <option value="payable">We owe them</option>
            </Select>
          </div>
        </Field>
        <Field label="Opening balance date">
          <DateInput value={f.openingDate} onChange={(e) => set('openingDate', e.target.value)} />
        </Field>
        <Field label="Credit limit / payment terms (days)">
          <div className="flex gap-2">
            <NumberInput value={f.creditLimit} onChange={(v) => set('creditLimit', v)} />
            <NumberInput value={f.paymentTermsDays} onChange={(v) => set('paymentTermsDays', v)} className="w-24" />
          </div>
        </Field>
        <Field label="Notes" className="col-span-3">
          <Textarea rows={2} value={f.notes} onChange={(e) => set('notes', e.target.value)} />
        </Field>
        {party && (
          <div className="col-span-3">
            <Toggle checked={f.isActive} onChange={(v) => set('isActive', v)} label="Active" description="Inactive parties are hidden from selection lists but keep their history." />
          </div>
        )}
      </div>
    </Modal>
  )
}
