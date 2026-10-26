/** HR and payroll: employees, daily attendance, salary advances and the monthly salary sheet. */
import { useState } from 'react'
import { ChevronLeft, ChevronRight, Plus, Printer, UserCog } from 'lucide-react'
import { api } from '../../api'
import { useCan } from '../../store'
import { Badge, Button, Card, Empty, Field, Input, Loading, Modal, NumberInput, PageHeader, Select, StatCard, Tabs, Textarea, confirmDialog, toast } from '../../components/ui'
import { DateInput } from '../../components/DateInput'
import { useAccounts, useLoad } from '../../lib/hooks'
import { date, money, today } from '../../lib/format'

/* eslint-disable @typescript-eslint/no-explicit-any */
type Tab = 'employees' | 'attendance' | 'salary'
const ST_LABEL: Record<string, string> = { present: 'P', absent: 'A', leave: 'L', half: 'H', holiday: 'O' }
const ST_NAME: Record<string, string> = { present: 'Present', absent: 'Absent', leave: 'Paid leave', half: 'Half day', holiday: 'Holiday' }
const ST_TONE: Record<string, string> = { present: 'text-ok', absent: 'text-bad', leave: 'text-info', half: 'text-warn', holiday: 'text-muted' }
const thisMonth = (): string => today().slice(0, 7)
const shiftMonth = (m: string, by: number): string => {
  const [y, mo] = m.split('-').map(Number)
  const d = new Date(y, mo - 1 + by, 1)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}
const monthName = (m: string): string => new Date(`${m}-01T00:00:00`).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' })

export function HrPage(): JSX.Element {
  const [tab, setTab] = useState<Tab>('employees')
  return (
    <div className="space-y-4">
      <PageHeader title="Staff and salary" subtitle="Employees, daily attendance, advances and the monthly salary sheet." icon={<UserCog className="h-5 w-5" />} />
      <Tabs value={tab} onChange={setTab} tabs={[{ key: 'employees', label: 'Employees' }, { key: 'attendance', label: 'Attendance' }, { key: 'salary', label: 'Salary sheet' }]} />
      {tab === 'employees' && <Employees />}
      {tab === 'attendance' && <Attendance />}
      {tab === 'salary' && <Salary />}
    </div>
  )
}

/* ---------------------------------------------------------------- employees */

function Employees(): JSX.Element {
  const can = useCan()
  const manage = can('hr.manage')
  const [q, setQ] = useState('')
  const [showLeft, setShowLeft] = useState(false)
  const [tick, setTick] = useState(0)
  const [form, setForm] = useState<{ open: boolean; emp?: any }>({ open: false })
  const [detail, setDetail] = useState<number | null>(null)
  const list = useLoad(() => api<any[]>('hr.employees', { q: q || undefined, status: showLeft ? undefined : 'active' }), [q, showLeft, tick])
  const refresh = (): void => setTick((t) => t + 1)
  const active = (list.data ?? []).filter((e) => e.status === 'active')
  const payroll = active.reduce((a, e) => a + (e.pay_type === 'monthly' ? e.salary : 0), 0)
  const advances = (list.data ?? []).reduce((a, e) => a + e.advance_balance, 0)

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Active employees" value={active.length} icon={<UserCog className="h-5 w-5" />} tone="info" />
        <StatCard label="Monthly salaries" value={money(payroll)} sub="Fixed monthly pay only" icon={<UserCog className="h-5 w-5" />} tone="brand" />
        <StatCard label="Advances to take back" value={money(advances)} icon={<UserCog className="h-5 w-5" />} tone={advances > 0 ? 'warn' : 'ok'} />
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Input sm className="w-64" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name, code, designation" aria-label="Search employees" />
        <label className="flex items-center gap-2 text-[13px]"><input type="checkbox" checked={showLeft} onChange={(e) => setShowLeft(e.target.checked)} />Show who left</label>
        <div className="flex-1" />
        {manage && <Button variant="primary" icon={<Plus className="h-4 w-4" />} onClick={() => setForm({ open: true })}>New employee</Button>}
      </div>
      <Card pad={false}>
        {!list.data ? (
          <Loading />
        ) : list.data.length === 0 ? (
          <Empty icon={<UserCog />} title="No employees yet">Add the people who work for you to keep their attendance and pay their salary from here.</Empty>
        ) : (
          <table className="tbl">
            <thead><tr><th>Code</th><th>Name</th><th>Designation</th><th>Pay</th><th className="text-right">Salary</th><th className="text-right">Advance owed</th><th>Status</th></tr></thead>
            <tbody>
              {list.data.map((e) => (
                <tr key={e.id} className="cursor-pointer" onClick={() => setDetail(e.id)}>
                  <td className="text-muted">{e.code}</td>
                  <td className="font-medium">{e.name}</td>
                  <td>{e.designation ?? '-'}</td>
                  <td>{e.pay_type === 'daily' ? 'Daily' : 'Monthly'}</td>
                  <td className="num text-right">{money(e.salary)}{e.pay_type === 'daily' ? ' / day' : ''}</td>
                  <td className="num text-right">{e.advance_balance > 0 ? money(e.advance_balance) : '-'}</td>
                  <td><Badge tone={e.status === 'active' ? 'ok' : 'muted'}>{e.status === 'active' ? 'Active' : 'Left'}</Badge></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
      {form.open && <EmployeeForm emp={form.emp} onClose={() => setForm({ open: false })} onSaved={refresh} />}
      {detail !== null && <EmployeeDetail id={detail} manage={manage} onClose={() => setDetail(null)} onChanged={refresh} onEdit={(e) => { setDetail(null); setForm({ open: true, emp: e }) }} />}
    </div>
  )
}

function EmployeeForm({ emp, onClose, onSaved }: { emp?: any; onClose: () => void; onSaved: () => void }): JSX.Element {
  const [f, setF] = useState<any>(
    emp
      ? { id: emp.id, name: emp.name, phone: emp.phone ?? '', cnic: emp.cnic ?? '', designation: emp.designation ?? '', department: emp.department ?? '', joinDate: emp.join_date ?? '', salary: emp.salary, payType: emp.pay_type, notes: emp.notes ?? '' }
      : { name: '', phone: '', cnic: '', designation: '', department: '', joinDate: today(), salary: 0, payType: 'monthly', notes: '' }
  )
  const [busy, setBusy] = useState(false)
  const set = (k: string, v: unknown): void => setF((x: any) => ({ ...x, [k]: v }))
  return (
    <Modal open onClose={onClose} title={emp ? `Edit ${emp.name}` : 'New employee'} size="md" footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} onClick={async () => { setBusy(true); try { await api('hr.saveEmployee', { ...f, joinDate: f.joinDate || null }); toast.ok('Employee saved.'); onSaved(); onClose() } catch (e) { toast.error(e); setBusy(false) } }}>Save</Button></>}>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Name" required className="col-span-2"><Input autoFocus value={f.name} onChange={(e) => set('name', e.target.value)} /></Field>
        <Field label="Phone"><Input value={f.phone} onChange={(e) => set('phone', e.target.value)} /></Field>
        <Field label="CNIC"><Input value={f.cnic} onChange={(e) => set('cnic', e.target.value)} /></Field>
        <Field label="Designation"><Input value={f.designation} onChange={(e) => set('designation', e.target.value)} placeholder="Salesman, electrician..." /></Field>
        <Field label="Department"><Input value={f.department} onChange={(e) => set('department', e.target.value)} /></Field>
        <Field label="Paid"><Select value={f.payType} onChange={(e) => set('payType', e.target.value)}><option value="monthly">Monthly salary</option><option value="daily">Daily wage</option></Select></Field>
        <Field label={f.payType === 'daily' ? 'Wage per day' : 'Salary per month'} required><NumberInput value={f.salary} onChange={(v) => set('salary', v)} /></Field>
        <Field label="Joined on"><DateInput clearable value={f.joinDate} onChange={(e) => set('joinDate', e.target.value)} /></Field>
        <Field label="Notes" className="col-span-2"><Textarea rows={2} value={f.notes} onChange={(e) => set('notes', e.target.value)} /></Field>
      </div>
    </Modal>
  )
}

function EmployeeDetail({ id, manage, onClose, onChanged, onEdit }: { id: number; manage: boolean; onClose: () => void; onChanged: () => void; onEdit: (e: any) => void }): JSX.Element {
  const [tick, setTick] = useState(0)
  const d = useLoad(() => api<any>('hr.employee', { id }), [id, tick])
  const [advance, setAdvance] = useState(false)
  const reload = (): void => { setTick((t) => t + 1); onChanged() }
  const e = d.data?.employee
  return (
    <Modal open onClose={onClose} title={e ? `${e.name} (${e.code})` : 'Employee'} subtitle={e ? `${e.designation ?? 'No designation'} · ${e.pay_type === 'daily' ? 'Daily' : 'Monthly'} ${money(e.salary)}` : undefined} size="lg">
      {!e ? (
        <Loading />
      ) : (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={e.status === 'active' ? 'ok' : 'muted'}>{e.status === 'active' ? 'Active' : `Left ${date(e.left_date)}`}</Badge>
            {e.phone && <span className="text-[13px] text-muted">{e.phone}</span>}
            <div className="flex-1" />
            {manage && e.status === 'active' && <Button size="sm" variant="soft" onClick={() => setAdvance(true)}>Give advance</Button>}
            {manage && <Button size="sm" onClick={() => onEdit(e)}>Edit</Button>}
            {manage && e.status === 'active' && <Button size="sm" variant="ghost" onClick={async () => { if (await confirmDialog({ title: `${e.name} has left?`, message: 'They stay in the records and their old salary sheets, but are not added to new ones.', confirmLabel: 'Mark as left' })) { try { await api('hr.employeeStatus', { id, status: 'left' }); toast.ok('Marked as left.'); reload() } catch (x) { toast.error(x) } } }}>Mark as left</Button>}
            {manage && e.status === 'left' && <Button size="sm" onClick={async () => { try { await api('hr.employeeStatus', { id, status: 'active' }); toast.ok('Back on the team.'); reload() } catch (x) { toast.error(x) } }}>Rejoin</Button>}
            {manage && <Button size="sm" variant="ghost" className="text-bad" onClick={async () => { if (await confirmDialog({ title: 'Delete this employee?', message: 'Only an employee with no attendance, advances or salary can be deleted.', danger: true, confirmLabel: 'Delete' })) { try { await api('hr.deleteEmployee', { id }); toast.ok('Deleted.'); onChanged(); onClose() } catch (x) { toast.error(x) } } }}>Delete</Button>}
          </div>
          <div className="rounded-xl bg-surface-2 p-3 text-center">
            <div className="text-[12.5px] text-muted">Advance still to be taken back</div>
            <div className="num text-[22px] font-extrabold">{money(e.advance_balance)}</div>
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            <div>
              <div className="mb-2 text-[13px] font-semibold text-muted">Advances and recoveries</div>
              {d.data.ledger.length === 0 ? <div className="text-[13px] text-muted">None.</div> : (
                <table className="tbl"><tbody>
                  {d.data.ledger.map((l: any) => (
                    <tr key={l.id}><td>{date(l.date)}</td><td>{l.kind === 'advance' ? 'Advance given' : 'Taken back'}{l.notes && <div className="text-[12px] text-muted">{l.notes}</div>}</td><td className={`num text-right ${l.kind === 'advance' ? 'text-warn' : 'text-ok'}`}>{l.kind === 'advance' ? '+' : '-'}{money(l.amount)}</td></tr>
                  ))}
                </tbody></table>
              )}
            </div>
            <div>
              <div className="mb-2 text-[13px] font-semibold text-muted">Salary history</div>
              {d.data.payslips.length === 0 ? <div className="text-[13px] text-muted">None.</div> : (
                <table className="tbl"><tbody>
                  {d.data.payslips.map((p: any) => (
                    <tr key={p.id}><td>{monthName(p.month)}</td><td><Badge tone={p.run_status === 'posted' ? 'ok' : 'warn'}>{p.run_status === 'posted' ? 'Paid' : 'Draft'}</Badge></td><td className="num text-right font-medium">{money(p.net)}</td></tr>
                  ))}
                </tbody></table>
              )}
            </div>
          </div>
        </div>
      )}
      {advance && e && <AdvanceForm emp={e} onClose={() => setAdvance(false)} onDone={() => { setAdvance(false); reload() }} />}
    </Modal>
  )
}

function AdvanceForm({ emp, onClose, onDone }: { emp: any; onClose: () => void; onDone: () => void }): JSX.Element {
  const accounts = useAccounts()
  const [amount, setAmount] = useState(0)
  const [accountId, setAccountId] = useState<number | null>(null)
  const [when, setWhen] = useState(today())
  const [notes, setNotes] = useState('')
  const [busy, setBusy] = useState(false)
  const acc = accountId ?? accounts.find((a) => a.is_default)?.id ?? accounts[0]?.id ?? null
  return (
    <Modal open onClose={onClose} title={`Advance for ${emp.name}`} size="sm" footer={<><Button onClick={onClose}>Back</Button><Button variant="primary" loading={busy} disabled={amount <= 0 || !acc} onClick={async () => { setBusy(true); try { await api('hr.advance', { employeeId: emp.id, amount, accountId: acc, date: when, notes }); toast.ok('Advance given and booked.'); onDone() } catch (e) { toast.error(e); setBusy(false) } }}>Give advance</Button></>}>
      <div className="space-y-3">
        <Field label="Amount" required><NumberInput autoFocus value={amount} onChange={setAmount} /></Field>
        <Field label="Paid from"><Select value={acc ?? ''} onChange={(e) => setAccountId(Number(e.target.value))}>{accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</Select></Field>
        <Field label="Date"><DateInput value={when} onChange={(e) => setWhen(e.target.value)} /></Field>
        <Field label="Note"><Input value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
        <div className="text-[12.5px] text-muted">It is booked as a salary expense now. When the salary sheet is made, the advance is taken back from the pay.</div>
      </div>
    </Modal>
  )
}

/* ---------------------------------------------------------------- attendance */

function Attendance(): JSX.Element {
  const can = useCan()
  const manage = can('hr.manage')
  const [month, setMonth] = useState(thisMonth())
  const [tick, setTick] = useState(0)
  const [cell, setCell] = useState<{ emp: any; day: string } | null>(null)
  const [markAll, setMarkAll] = useState(false)
  const d = useLoad(() => api<any>('hr.attendance', { month }), [month, tick])
  const refresh = (): void => setTick((t) => t + 1)
  const days: number[] = d.data ? Array.from({ length: d.data.days }, (_, i) => i + 1) : []
  const dayKey = (n: number): string => `${month}-${String(n).padStart(2, '0')}`

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" aria-label="Previous month" icon={<ChevronLeft className="h-4 w-4" />} onClick={() => setMonth(shiftMonth(month, -1))} />
        <div className="min-w-[140px] text-center text-[15px] font-semibold">{monthName(month)}</div>
        <Button size="sm" aria-label="Next month" icon={<ChevronRight className="h-4 w-4" />} onClick={() => setMonth(shiftMonth(month, 1))} />
        <div className="flex-1" />
        {manage && <Button variant="soft" onClick={() => setMarkAll(true)}>Mark a whole day</Button>}
      </div>
      <div className="text-[12.5px] text-muted">P present, A absent, L paid leave, H half day, O holiday. Click a day to mark it. A day left blank counts as worked for monthly pay.</div>
      <Card pad={false}>
        {!d.data ? (
          <Loading />
        ) : d.data.employees.length === 0 ? (
          <Empty icon={<UserCog />} title="No employees">Add employees first.</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="tbl" style={{ minWidth: 900 }}>
              <thead>
                <tr>
                  <th className="sticky left-0 bg-surface">Employee</th>
                  {days.map((n) => <th key={n} className="px-1 text-center">{n}</th>)}
                  <th className="text-center">P</th><th className="text-center">A</th><th className="text-center">OT hrs</th>
                </tr>
              </thead>
              <tbody>
                {d.data.employees.map((e: any) => (
                  <tr key={e.id}>
                    <td className="sticky left-0 whitespace-nowrap bg-surface font-medium">{e.name}{e.status !== 'active' && <span className="ml-1 text-[12px] text-muted">(left)</span>}</td>
                    {days.map((n) => {
                      const r = e.records[dayKey(n)]
                      return (
                        <td key={n} className="p-0 text-center">
                          <button type="button" disabled={!manage} title={r ? `${ST_NAME[r.status]}${r.overtime_hours ? `, ${r.overtime_hours} h overtime` : ''}` : 'Not marked'} onClick={() => setCell({ emp: e, day: dayKey(n) })} className={`h-8 w-7 text-[12.5px] font-bold hover:bg-surface-2 ${r ? ST_TONE[r.status] : 'text-faint'}`}>
                            {r ? ST_LABEL[r.status] : '·'}
                          </button>
                        </td>
                      )
                    })}
                    <td className="num text-center">{e.counts.present + e.counts.half * 0.5}</td>
                    <td className="num text-center">{e.counts.absent + e.counts.half * 0.5}</td>
                    <td className="num text-center">{e.counts.overtime || '-'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      {cell && <MarkDay emp={cell.emp} day={cell.day} rec={cell.emp.records[cell.day]} onClose={() => setCell(null)} onDone={() => { setCell(null); refresh() }} />}
      {markAll && <MarkAllForm onClose={() => setMarkAll(false)} onDone={() => { setMarkAll(false); refresh() }} />}
    </div>
  )
}

function MarkDay({ emp, day, rec, onClose, onDone }: { emp: any; day: string; rec?: any; onClose: () => void; onDone: () => void }): JSX.Element {
  const [status, setStatus] = useState<string>(rec?.status ?? 'present')
  const [ot, setOt] = useState<number>(rec?.overtime_hours ?? 0)
  const [busy, setBusy] = useState(false)
  const save = async (s: string | null): Promise<void> => {
    setBusy(true)
    try {
      await api('hr.mark', { employeeId: emp.id, date: day, status: s, overtimeHours: s ? ot : 0 })
      onDone()
    } catch (e) {
      toast.error(e)
      setBusy(false)
    }
  }
  return (
    <Modal open onClose={onClose} title={`${emp.name}, ${date(day)}`} size="sm" footer={<>{rec && <Button variant="ghost" className="text-bad" disabled={busy} onClick={() => save(null)}>Clear</Button>}<Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} onClick={() => save(status)}>Save</Button></>}>
      <div className="space-y-3">
        <div className="grid grid-cols-5 gap-2">
          {Object.keys(ST_NAME).map((s) => (
            <button key={s} type="button" onClick={() => setStatus(s)} className={`rounded-lg border px-1 py-2 text-[12px] font-semibold ${status === s ? 'border-brand bg-brand/10' : 'border-line'}`}>{ST_NAME[s]}</button>
          ))}
        </div>
        <Field label="Overtime hours"><NumberInput value={ot} onChange={setOt} min={0} step="0.5" /></Field>
      </div>
    </Modal>
  )
}

function MarkAllForm({ onClose, onDone }: { onClose: () => void; onDone: () => void }): JSX.Element {
  const [when, setWhen] = useState(today())
  const [status, setStatus] = useState('present')
  const [busy, setBusy] = useState(false)
  return (
    <Modal open onClose={onClose} title="Mark a whole day" size="sm" footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} onClick={async () => { setBusy(true); try { const n = await api<number>('hr.markDay', { date: when, status }); toast.ok(`${n} employee(s) marked.`); onDone() } catch (e) { toast.error(e); setBusy(false) } }}>Mark everyone</Button></>}>
      <div className="space-y-3">
        <Field label="Day"><DateInput value={when} onChange={(e) => setWhen(e.target.value)} /></Field>
        <Field label="Everyone active is"><Select value={status} onChange={(e) => setStatus(e.target.value)}>{Object.entries(ST_NAME).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select></Field>
        <div className="text-[12.5px] text-muted">Then click the few people who were absent and change them.</div>
      </div>
    </Modal>
  )
}

/* ---------------------------------------------------------------- salary sheet */

function Salary(): JSX.Element {
  const can = useCan()
  const pay = can('hr.payroll')
  const [month, setMonth] = useState(shiftMonth(thisMonth(), 0))
  const [tick, setTick] = useState(0)
  const [open, setOpen] = useState<number | null>(null)
  const runs = useLoad(() => api<any[]>('hr.payrolls'), [tick])
  const refresh = (): void => setTick((t) => t + 1)
  const prepare = async (): Promise<void> => {
    try {
      const id = await api<number>('hr.preparePayroll', { month })
      refresh()
      setOpen(id)
    } catch (e) {
      toast.error(e)
    }
  }
  return (
    <div className="space-y-4">
      {pay && (
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" aria-label="Previous month" icon={<ChevronLeft className="h-4 w-4" />} onClick={() => setMonth(shiftMonth(month, -1))} />
          <div className="min-w-[140px] text-center text-[15px] font-semibold">{monthName(month)}</div>
          <Button size="sm" aria-label="Next month" icon={<ChevronRight className="h-4 w-4" />} onClick={() => setMonth(shiftMonth(month, 1))} />
          <Button variant="primary" onClick={prepare}>Prepare salary sheet</Button>
        </div>
      )}
      <Card pad={false}>
        {!runs.data ? (
          <Loading />
        ) : runs.data.length === 0 ? (
          <Empty icon={<UserCog />} title="No salary sheets yet">Pick a month and prepare the sheet. It takes the attendance, overtime and advances into account.</Empty>
        ) : (
          <table className="tbl">
            <thead><tr><th>Month</th><th>Employees</th><th className="text-right">Net pay</th><th>Status</th></tr></thead>
            <tbody>
              {runs.data.map((r) => (
                <tr key={r.id} className="cursor-pointer" onClick={() => setOpen(r.id)}>
                  <td className="font-medium">{monthName(r.month)}</td>
                  <td>{r.employees}</td>
                  <td className="num text-right font-semibold">{money(r.net_total)}</td>
                  <td><Badge tone={r.status === 'posted' ? 'ok' : 'warn'}>{r.status === 'posted' ? `Paid ${date(String(r.posted_at ?? '').slice(0, 10))}` : 'Draft'}</Badge></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
      {open !== null && <PayrollSheet id={open} pay={pay} onClose={() => setOpen(null)} onChanged={refresh} />}
    </div>
  )
}

function PayrollSheet({ id, pay, onClose, onChanged }: { id: number; pay: boolean; onClose: () => void; onChanged: () => void }): JSX.Element {
  const [tick, setTick] = useState(0)
  const d = useLoad(() => api<any>('hr.payroll', { id }), [id, tick])
  const [posting, setPosting] = useState(false)
  const reload = (): void => { setTick((t) => t + 1); onChanged() }
  const run = d.data?.run
  const draft = run?.status !== 'posted'

  const saveLine = async (l: any, patch: Record<string, number>): Promise<void> => {
    try {
      await api('hr.updateLine', { lineId: l.id, ...patch })
      reload()
    } catch (e) {
      toast.error(e)
    }
  }

  return (
    <Modal open onClose={onClose} title={run ? `Salary sheet, ${monthName(run.month)}` : 'Salary sheet'} subtitle={run ? (draft ? 'Draft. Change bonus, deductions or advance recovery, then pay.' : `Paid on ${date(String(run.posted_at ?? '').slice(0, 10))}`) : undefined} size="xl"
      footer={run && (
        <>
          <Button icon={<Printer className="h-4 w-4" />} onClick={() => api('print.open', { kind: 'payroll', id }).catch(toast.error)}>Print</Button>
          {pay && draft && <Button variant="ghost" className="text-bad" onClick={async () => { if (await confirmDialog({ title: 'Delete this draft?', message: 'The salary sheet is removed. Nothing has been paid yet.', danger: true, confirmLabel: 'Delete draft' })) { try { await api('hr.deletePayroll', { id }); onChanged(); onClose() } catch (e) { toast.error(e) } } }}>Delete draft</Button>}
          {pay && draft && <Button variant="soft" onClick={reload}>Recalculate from attendance</Button>}
          {pay && !draft && <Button variant="ghost" className="text-bad" onClick={async () => { if (await confirmDialog({ title: 'Undo this payment?', message: 'The salary expenses are cancelled and the advances come back. You can then change the sheet and pay again.', danger: true, confirmLabel: 'Undo payment' })) { try { await api('hr.undoPayroll', { id }); toast.ok('Payment undone.'); reload() } catch (e) { toast.error(e) } } }}>Undo payment</Button>}
          {pay && draft && <Button variant="primary" onClick={() => setPosting(true)}>Pay the salaries</Button>}
        </>
      )}>
      {!d.data ? (
        <Loading />
      ) : (
        <div className="space-y-3">
          <div className="overflow-x-auto">
            <table className="tbl">
              <thead><tr><th>Employee</th><th className="text-right">Days paid</th><th className="text-right">Basic</th><th className="text-right">Overtime</th><th className="text-right">Bonus</th><th className="text-right">Deductions</th><th className="text-right">Advance back</th><th className="text-right">Net</th></tr></thead>
              <tbody>
                {d.data.lines.map((l: any) => (
                  <tr key={l.id}>
                    <td className="font-medium">{l.name}<div className="text-[12px] font-normal text-muted">{l.pay_type === 'daily' ? 'Daily' : 'Monthly'} {money(l.salary)}{l.advance_balance > 0 && draft ? ` · advance owed ${money(l.advance_balance)}` : ''}</div></td>
                    <td className="num text-right">{l.paid_days}</td>
                    <td className="num text-right">{money(l.base)}</td>
                    <td className="num text-right">{l.overtime_pay > 0 ? `${money(l.overtime_pay)} (${l.overtime_hours} h)` : '-'}</td>
                    {(['bonus', 'deductions', 'advance_recovery'] as const).map((k) => (
                      <td key={k} className="text-right">
                        {pay && draft ? <LineInput value={l[k]} onCommit={(v) => saveLine(l, { [k === 'advance_recovery' ? 'advanceRecovery' : k]: v })} label={`${k} for ${l.name}`} /> : <span className="num">{l[k] > 0 ? money(l[k]) : '-'}</span>}
                      </td>
                    ))}
                    <td className="num text-right font-semibold">{money(l.net)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="font-bold"><td>Total</td><td /><td className="num text-right">{money(d.data.totals.base)}</td><td className="num text-right">{money(d.data.totals.overtime)}</td><td className="num text-right">{money(d.data.totals.bonus)}</td><td className="num text-right">{money(d.data.totals.deductions)}</td><td className="num text-right">{money(d.data.totals.recovery)}</td><td className="num text-right">{money(d.data.totals.net)}</td></tr>
              </tfoot>
            </table>
          </div>
        </div>
      )}
      {posting && run && <PayForm id={id} month={monthName(run.month)} total={d.data.totals.net} onClose={() => setPosting(false)} onDone={() => { setPosting(false); reload() }} />}
    </Modal>
  )
}

/** A number box that saves when the user leaves it, so each keystroke does not hit the database. */
function LineInput({ value, onCommit, label }: { value: number; onCommit: (v: number) => void; label: string }): JSX.Element {
  const [v, setV] = useState<string>(String(value || ''))
  return (
    <input
      aria-label={label}
      className="input num h-8 w-24 text-right"
      value={v}
      inputMode="decimal"
      placeholder="0"
      onChange={(e) => setV(e.target.value)}
      onBlur={() => {
        const n = Number(v || 0)
        if (Number.isFinite(n) && n !== value) onCommit(n)
        else setV(String(value || ''))
      }}
    />
  )
}

function PayForm({ id, month, total, onClose, onDone }: { id: number; month: string; total: number; onClose: () => void; onDone: () => void }): JSX.Element {
  const accounts = useAccounts()
  const [accountId, setAccountId] = useState<number | null>(null)
  const [when, setWhen] = useState(today())
  const [busy, setBusy] = useState(false)
  const acc = accountId ?? accounts.find((a) => a.is_default)?.id ?? accounts[0]?.id ?? null
  return (
    <Modal open onClose={onClose} title={`Pay the salaries of ${month}`} size="sm" footer={<><Button onClick={onClose}>Back</Button><Button variant="primary" loading={busy} disabled={!acc} onClick={async () => { setBusy(true); try { await api('hr.postPayroll', { id, accountId: acc, date: when }); toast.ok('Salaries paid and booked.'); onDone() } catch (e) { toast.error(e); setBusy(false) } }}>Pay {money(total)}</Button></>}>
      <div className="space-y-3">
        <Field label="Paid from"><Select value={acc ?? ''} onChange={(e) => setAccountId(Number(e.target.value))}>{accounts.map((a) => <option key={a.id} value={a.id}>{a.name} ({money(a.balance)})</option>)}</Select></Field>
        <Field label="Pay date"><DateInput value={when} onChange={(e) => setWhen(e.target.value)} /></Field>
        <div className="text-[12.5px] text-muted">One salary expense is booked for each employee. Advances taken back are cleared from their balance.</div>
      </div>
    </Modal>
  )
}
