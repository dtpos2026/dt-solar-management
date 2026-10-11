import { useEffect, useMemo, useState } from 'react'
import { api } from '../api'
import { Button, Field, Input, Modal, NumberInput, Select, Textarea, cx, toast } from './ui'
import { Combobox } from './Combobox'
import { useAccounts, useParties, useProjects } from '../lib/hooks'
import { PAYMENT_METHODS, PAYMENT_METHOD_LABELS } from '@shared/docTypes'
import { date, label, money, today } from '../lib/format'
import { round2 } from '@shared/money'

/* eslint-disable @typescript-eslint/no-explicit-any */
export interface PaymentPreset {
  direction: 'in' | 'out'
  partyId?: number | null
  documentId?: number | null
  projectId?: number | null
  amount?: number
}

export function PaymentModal({ open, onClose, onSaved, preset }: { open: boolean; onClose: () => void; onSaved?: (id: number) => void; preset: PaymentPreset }): JSX.Element {
  const accounts = useAccounts()
  const { options: partyOptions, parties } = useParties()
  const { options: projectOptions } = useProjects()
  const [f, setF] = useState<any>({})
  const [items, setItems] = useState<any[]>([])
  const [mode, setMode] = useState<'auto' | 'manual' | 'advance'>('auto')
  const [alloc, setAlloc] = useState<Record<string, number>>({})
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!open) return
    setF({ date: today(), direction: preset.direction, partyId: preset.partyId ?? null, accountId: null, amount: preset.amount ?? 0, method: 'cash', reference: '', projectId: preset.projectId ?? null, notes: '' })
    setMode(preset.documentId ? 'manual' : 'auto')
    setAlloc(preset.documentId && preset.amount ? { [`document-${preset.documentId}`]: preset.amount } : {})
  }, [open, preset.direction, preset.partyId, preset.documentId, preset.projectId, preset.amount]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (open && !f.accountId && accounts.length) setF((x: any) => ({ ...x, accountId: (accounts.find((a) => a.is_default) ?? accounts[0]).id }))
  }, [open, accounts, f.accountId])

  useEffect(() => {
    if (!open || !f.partyId) {
      setItems([])
      return
    }
    api<any[]>('payments.openItems', { partyId: f.partyId, direction: f.direction }).then(setItems).catch(() => setItems([]))
  }, [open, f.partyId, f.direction])

  const party = parties.find((p) => p.id === f.partyId)
  const allocated = useMemo(() => round2(Object.values(alloc).reduce((a, b) => a + (Number(b) || 0), 0)), [alloc])

  const save = async (): Promise<void> => {
    setBusy(true)
    try {
      const allocations =
        mode === 'manual'
          ? Object.entries(alloc)
              .filter(([, v]) => Number(v) > 0)
              .map(([k, v]) => {
                const [kind, id] = k.split('-')
                return kind === 'document' ? { documentId: Number(id), amount: Number(v) } : { expenseId: Number(id), amount: Number(v) }
              })
          : undefined
      if (mode === 'manual' && allocated > Number(f.amount) + 0.005) throw new Error('Allocated amount is more than the payment amount.')
      const id = await api<number>('payments.create', { ...f, allocations, autoAllocate: mode === 'auto' })
      toast.ok(f.direction === 'in' ? 'Payment received.' : 'Payment recorded.')
      onSaved?.(id)
      onClose()
    } catch (e) {
      toast.error(e)
    } finally {
      setBusy(false)
    }
  }

  const title = f.direction === 'in' ? 'Receive Payment' : 'Make Payment'
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      subtitle={f.direction === 'in' ? 'Money received from a customer (or refund from a supplier)' : 'Money paid to a supplier / contractor (or refund to a customer)'}
      size="lg"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={busy} onClick={save} disabled={!f.amount || !f.accountId}>
            Save {f.direction === 'in' ? 'receipt' : 'payment'}
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-3 gap-3">
        <Field label="Type">
          <Select value={f.direction} onChange={(e) => setF({ ...f, direction: e.target.value })}>
            <option value="in">Money IN (receipt)</option>
            <option value="out">Money OUT (payment)</option>
          </Select>
        </Field>
        <Field label="Customer / supplier" className="col-span-2">
          <Combobox options={partyOptions} value={f.partyId} onChange={(v) => setF({ ...f, partyId: v })} placeholder="Select party (optional for general payments)" allowClear />
        </Field>
        <Field label="Date">
          <Input type="date" value={f.date ?? ''} onChange={(e) => setF({ ...f, date: e.target.value })} />
        </Field>
        <Field label="Amount" required>
          <NumberInput value={f.amount} onChange={(v) => setF({ ...f, amount: v })} autoFocus />
        </Field>
        <Field label="Cash / bank account" required>
          <Select value={f.accountId ?? ''} onChange={(e) => setF({ ...f, accountId: Number(e.target.value) })}>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name} ({money(a.balance)})
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Method">
          <Select value={f.method} onChange={(e) => setF({ ...f, method: e.target.value })}>
            {PAYMENT_METHODS.map((m) => (
              <option key={m} value={m}>
                {PAYMENT_METHOD_LABELS[m]}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Reference (cheque / transaction no.)">
          <Input value={f.reference} onChange={(e) => setF({ ...f, reference: e.target.value })} />
        </Field>
        <Field label="Project (optional)">
          <Combobox options={projectOptions} value={f.projectId} onChange={(v) => setF({ ...f, projectId: v })} placeholder="Not linked to a project" allowClear />
        </Field>
        <Field label="Notes" className="col-span-3">
          <Textarea rows={2} value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} />
        </Field>
      </div>

      {f.partyId && (
        <div className="mt-4">
          <div className="mb-2 flex items-center justify-between">
            <div className="font-semibold">
              Settle against
              {party && <span className="ml-2 text-[12.5px] font-normal text-muted">Current balance: {money(party.balance)} {party.balance > 0 ? '(they owe us)' : party.balance < 0 ? '(we owe them)' : ''}</span>}
            </div>
            <div className="flex gap-1 rounded-lg border border-line p-0.5 text-[12.5px]">
              {(['auto', 'manual', 'advance'] as const).map((m) => (
                <button key={m} type="button" onClick={() => setMode(m)} className={cx('rounded-md px-2.5 py-1 cursor-pointer', mode === m ? 'bg-brand text-on-brand' : 'text-muted hover:text-ink')}>
                  {m === 'auto' ? 'Oldest first' : m === 'manual' ? 'Choose invoices' : 'Keep as advance'}
                </button>
              ))}
            </div>
          </div>
          {items.length === 0 ? (
            <div className="rounded-lg bg-surface-2 px-3 py-3 text-[13px] text-muted">No open invoices/bills. The amount will be kept as an advance / on-account balance.</div>
          ) : mode === 'manual' ? (
            <table className="tbl rounded-lg border border-line">
              <thead>
                <tr><th>Document</th><th>Date</th><th className="text-right">Total</th><th className="text-right">Outstanding</th><th style={{ width: 150 }} className="text-right">Settle now</th></tr>
              </thead>
              <tbody>
                {items.map((it) => {
                  const key = `${it.kind}-${it.id}`
                  return (
                    <tr key={key}>
                      <td><div className="font-medium">{it.number}</div><div className="text-[11.5px] text-muted">{label(it.doc_type)}{it.project_name ? ` · ${it.project_name}` : ''}</div></td>
                      <td>{date(it.date)}</td>
                      <td className="num text-right">{money(it.grand_total)}</td>
                      <td className="num text-right font-semibold">{money(it.due)}</td>
                      <td>
                        <div className="flex items-center gap-1">
                          <NumberInput sm value={alloc[key] ?? 0} onChange={(v) => setAlloc({ ...alloc, [key]: v })} />
                          <Button size="sm" variant="ghost" onClick={() => setAlloc({ ...alloc, [key]: it.due })}>Full</Button>
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
              <tfoot>
                <tr><td colSpan={4} className="text-right font-semibold">Allocated / unallocated (advance)</td><td className="num text-right font-semibold">{money(allocated)} / {money(round2(Number(f.amount || 0) - allocated))}</td></tr>
              </tfoot>
            </table>
          ) : (
            <div className="rounded-lg bg-surface-2 px-3 py-3 text-[13px] text-muted">
              {mode === 'auto'
                ? `${items.length} open item(s) totalling ${money(items.reduce((a, b) => a + b.due, 0))}. The payment will settle the oldest first; any extra is kept as an advance.`
                : 'The full amount will be kept as an advance and can be applied to future invoices.'}
            </div>
          )}
        </div>
      )}
    </Modal>
  )
}
