import { useEffect, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { Plus, SunMedium, LayoutGrid, List, MapPin, Zap, Archive, ArchiveRestore, Trash2 } from 'lucide-react'
import { api } from '../../api'
import { useCan } from '../../store'
import { Badge, Button, Empty, Field, IconButton, Input, Loading, Modal, NumberInput, PageHeader, Progress, Select, Textarea, cx, toast } from '../../components/ui'
import { DataTable, Column } from '../../components/DataTable'
import { Combobox } from '../../components/Combobox'
import { PartyForm } from '../../components/PartyForm'
import { useLoad, useParties } from '../../lib/hooks'
import { date, label, money, pct, qty, statusTone } from '../../lib/format'
import { PROJECT_STATUSES, PROJECT_STATUS_LABELS, PROJECT_TYPES, SYSTEM_TYPES, SYSTEM_TYPE_LABELS } from '@shared/docTypes'
import { ProjectDeleteDialog, archiveProjectFlow, restoreProjectFlow } from './projectActions'
import { DateInput } from '../../components/DateInput'

/* eslint-disable @typescript-eslint/no-explicit-any */
export function ProjectsPage(): JSX.Element {
  const can = useCan()
  const nav = useNavigate()
  const [params, setParams] = useSearchParams()
  const [status, setStatus] = useState('')
  const [view, setView] = useState<'cards' | 'table'>('cards')
  const [q, setQ] = useState('')
  const [archived, setArchived] = useState<'hide' | 'only' | 'all'>('hide')
  const [del, setDel] = useState<any>(null)
  const [form, setForm] = useState<{ open: boolean; project?: any }>({ open: params.get('new') === '1' })
  useEffect(() => {
    if (params.get('new') === '1') setParams({}, { replace: true })
  }, []) // eslint-disable-line react-hooks/exhaustive-deps
  const { data, loading, reload } = useLoad(() => api<any[]>('projects.list', { status: status || undefined, archived }), [status, archived])
  const rows = (data ?? []).filter((r) => !q || `${r.code} ${r.name} ${r.customer_name ?? ''} ${r.city ?? ''}`.toLowerCase().includes(q.toLowerCase()))
  const showFin = rows.some((r) => r.financials?.netProfit !== undefined)
  const canDelete = can('projects.delete')
  const actions = (r: any): JSX.Element | null =>
    canDelete ? (
      <div className="flex justify-end">
        {r.is_archived
          ? <IconButton title="Restore project" onClick={async () => { if (await restoreProjectFlow(r)) reload() }}><ArchiveRestore className="h-4 w-4" /></IconButton>
          : <IconButton title="Archive project" onClick={async () => { if (await archiveProjectFlow(r)) reload() }}><Archive className="h-4 w-4" /></IconButton>}
        <IconButton title="Delete project" tone="bad" onClick={() => setDel(r)}><Trash2 className="h-4 w-4" /></IconButton>
      </div>
    ) : null
  const statusBadges = (r: any): JSX.Element => (
    <span className="inline-flex flex-wrap items-center gap-1">
      <Badge tone={statusTone(r.status)}>{PROJECT_STATUS_LABELS[r.status as keyof typeof PROJECT_STATUS_LABELS]}</Badge>
      {!!r.is_archived && <Badge tone="warn">Archived</Badge>}
    </span>
  )
  const cols: Array<Column<any>> = [
    { key: 'code', header: 'Project', render: (r) => <div><div className="font-semibold">{r.name}</div><div className="text-[12px] text-muted">{r.code} · {r.customer_name ?? '—'}</div></div>, value: (r) => `${r.code} ${r.name}` },
    { key: 'capacity_kw', header: 'Size', align: 'right', render: (r) => `${qty(r.capacity_kw)} kW` },
    { key: 'system_type', header: 'System', render: (r) => SYSTEM_TYPE_LABELS[r.system_type] },
    { key: 'status', header: 'Status', render: statusBadges },
    { key: 'progress', header: 'Progress', render: (r) => <div className="flex w-28 items-center gap-2"><Progress value={r.progress} /><span className="text-[12px] text-muted">{r.progress}%</span></div> },
    { key: 'contract', header: 'Contract', align: 'right', value: (r) => r.financials.contractValue, render: (r) => money(r.financials.contractValue) },
    { key: 'revenue', header: 'Revenue', align: 'right', hidden: !showFin, value: (r) => r.financials.revenue, render: (r) => money(r.financials.revenue) },
    { key: 'cost', header: 'Direct cost', align: 'right', hidden: !showFin, value: (r) => r.financials.totalDirectCost, render: (r) => money(r.financials.totalDirectCost) },
    { key: 'profit', header: 'Net profit', align: 'right', hidden: !showFin, value: (r) => r.financials.netProfit, render: (r) => <span className={r.financials.netProfit < 0 ? 'font-semibold text-bad' : 'font-semibold text-ok'}>{money(r.financials.netProfit)}</span> },
    { key: 'margin', header: 'Margin', align: 'right', hidden: !showFin, value: (r) => r.financials.marginPct, render: (r) => pct(r.financials.marginPct) },
    { key: 'outstanding', header: 'Customer due', align: 'right', value: (r) => r.financials.customerOutstanding, render: (r) => <span className={r.financials.customerOutstanding > 0.5 ? 'text-bad' : ''}>{money(r.financials.customerOutstanding)}</span> },
    { key: 'actions', header: '', sortable: false, csv: false, hidden: !canDelete, render: actions }
  ]
  return (
    <div>
      <PageHeader
        title="Solar Projects"
        subtitle="Every installation with its own revenue, material, labor and profit — no double counting"
        icon={<SunMedium className="h-5 w-5" />}
        actions={
          <>
            <div className="flex rounded-lg border border-line p-0.5">
              <button type="button" className={cx('rounded-md p-1.5 cursor-pointer', view === 'cards' && 'bg-brand-soft text-brand')} onClick={() => setView('cards')} title="Cards"><LayoutGrid className="h-4 w-4" /></button>
              <button type="button" className={cx('rounded-md p-1.5 cursor-pointer', view === 'table' && 'bg-brand-soft text-brand')} onClick={() => setView('table')} title="Table"><List className="h-4 w-4" /></button>
            </div>
            {can('projects.manage') && <Button variant="primary" icon={<Plus className="h-4 w-4" />} onClick={() => setForm({ open: true })}>New project</Button>}
          </>
        }
      />
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Input className="w-72" placeholder="Search projects, customers, city…" value={q} onChange={(e) => setQ(e.target.value)} />
        <Select className="w-44" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">All statuses</option>
          {PROJECT_STATUSES.map((s) => <option key={s} value={s}>{PROJECT_STATUS_LABELS[s]}</option>)}
        </Select>
        <Select className="w-48" value={archived} onChange={(e) => setArchived(e.target.value as 'hide' | 'only' | 'all')} aria-label="Archived filter">
          <option value="hide">Hide archived</option>
          <option value="only">Show archived</option>
          <option value="all">Active + archived</option>
        </Select>
        <span className="ml-auto text-[13px] text-muted">{rows.length} project(s) · {qty(rows.reduce((a, r) => a + (r.capacity_kw || 0), 0))} kW</span>
      </div>
      {loading ? (
        <Loading />
      ) : rows.length === 0 ? (
        archived === 'only' ? (
          <div className="card"><Empty icon={<Archive />} title="No archived projects">Projects you archive are hidden from the list and from pickers but keep all their records. They appear here and can be restored.</Empty></div>
        ) : q || status ? (
          <div className="card"><Empty icon={<SunMedium />} title="No matching projects">Change the search or status filter.</Empty></div>
        ) : (
          <div className="card"><Empty icon={<SunMedium />} title="No projects yet" action={can('projects.manage') && <Button variant="primary" onClick={() => setForm({ open: true })}>Create your first project</Button>}>Create a project for each installation to track its quotation, invoices, materials, labor, payments and profit.</Empty></div>
        )
      ) : view === 'table' ? (
        <DataTable rows={rows} columns={cols} searchable={false} exportName="Projects" onRowClick={(r) => nav(`/projects/${r.id}`)} />
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 2xl:grid-cols-3">
          {rows.map((r) => (
            <div key={r.id} role="link" tabIndex={0} onClick={() => nav(`/projects/${r.id}`)} onKeyDown={(e) => e.key === 'Enter' && nav(`/projects/${r.id}`)} className={cx('card fade-in p-4 text-left transition hover:-translate-y-0.5 hover:shadow-md cursor-pointer', !!r.is_archived && 'opacity-75')}>
              <div className="flex items-start justify-between gap-2">
                <div>
                  <div className="text-[12px] font-semibold text-muted">{r.code}</div>
                  <div className="text-[15px] font-semibold">{r.name}</div>
                  <div className="text-[12.5px] text-muted">{r.customer_name ?? 'No customer'}</div>
                </div>
                {statusBadges(r)}
              </div>
              <div className="mt-3 flex flex-wrap gap-3 text-[12.5px] text-muted">
                <span className="inline-flex items-center gap-1"><Zap className="h-3.5 w-3.5 text-sun" />{qty(r.capacity_kw)} kW {SYSTEM_TYPE_LABELS[r.system_type]}</span>
                {r.city && <span className="inline-flex items-center gap-1"><MapPin className="h-3.5 w-3.5" />{r.city}</span>}
                <span>{label(r.project_type)}</span>
              </div>
              <div className="mt-3 flex items-center gap-2"><Progress value={r.progress} tone={r.progress >= 100 ? 'ok' : 'brand'} /><span className="text-[12px] text-muted">{r.progress}%</span></div>
              <div className="mt-3 grid grid-cols-3 gap-2 border-t border-line pt-3 text-[12px]">
                <div><div className="text-muted">Contract</div><div className="num font-semibold">{money(r.financials.contractValue)}</div></div>
                {r.financials.netProfit !== undefined ? (
                  <div><div className="text-muted">Net profit</div><div className={cx('num font-semibold', r.financials.netProfit < 0 ? 'text-bad' : 'text-ok')}>{money(r.financials.netProfit)}</div></div>
                ) : (
                  <div><div className="text-muted">Received</div><div className="num font-semibold">{money(r.financials.received)}</div></div>
                )}
                <div><div className="text-muted">Customer due</div><div className={cx('num font-semibold', r.financials.customerOutstanding > 0.5 && 'text-bad')}>{money(r.financials.customerOutstanding)}</div></div>
              </div>
              {canDelete && <div className="-mb-2 mt-2 flex justify-end border-t border-line pt-1">{actions(r)}</div>}
            </div>
          ))}
        </div>
      )}
      <ProjectDeleteDialog project={del} onClose={() => setDel(null)} onDone={() => reload()} />
      <ProjectForm open={form.open} project={form.project} onClose={() => setForm({ open: false })} onSaved={(id) => { reload(); if (!form.project) nav(`/projects/${id}`) }} />
    </div>
  )
}

export function ProjectForm({ open, project, onClose, onSaved }: { open: boolean; project?: any; onClose: () => void; onSaved: (id: number) => void }): JSX.Element {
  const { options: customerOptions, reload: reloadParties } = useParties('customer')
  const users = useLoad(() => api<any[]>('users.basic'), [])
  const quotes = useLoad(() => api<any[]>('docs.list', { docType: 'quotation' }).catch(() => []), [open])
  const [f, setF] = useState<any>({})
  const [busy, setBusy] = useState(false)
  const [newCust, setNewCust] = useState<{ open: boolean; name?: string }>({ open: false })
  useEffect(() => {
    if (!open) return
    setF(
      project
        ? { id: project.id, name: project.name, customerId: project.customer_id, contactPerson: project.contact_person ?? '', contactPhone: project.contact_phone ?? '', siteAddress: project.site_address ?? '', city: project.city ?? '', capacityKw: project.capacity_kw, projectType: project.project_type, systemType: project.system_type, startDate: project.start_date ?? '', expectedEndDate: project.expected_end_date ?? '', completedDate: project.completed_date ?? '', managerUserId: project.manager_user_id, status: project.status, progress: project.progress, quotationId: project.quotation_id, contractAmount: project.contract_amount, overheadAmount: project.overhead_amount, warrantyInfo: project.warranty_info ?? '', notes: project.notes ?? '' }
        : { name: '', customerId: null, contactPerson: '', contactPhone: '', siteAddress: '', city: '', capacityKw: 0, projectType: 'residential', systemType: 'on_grid', startDate: new Date().toISOString().slice(0, 10), expectedEndDate: '', managerUserId: null, status: 'planning', progress: 0, quotationId: null, contractAmount: 0, overheadAmount: 0, warrantyInfo: '', notes: '' }
    )
  }, [open, project])
  const set = (k: string, v: unknown): void => setF((x: any) => ({ ...x, [k]: v }))
  const save = async (): Promise<void> => {
    setBusy(true)
    try {
      const id = await api<number>('projects.save', f)
      toast.ok('Project saved.')
      onSaved(id)
      onClose()
    } catch (e) {
      toast.error(e)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Modal open={open} onClose={onClose} title={project ? `Edit project ${project.code}` : 'New solar project'} size="lg" footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} onClick={save}>Save project</Button></>}>
      <div className="grid grid-cols-4 gap-3">
        <Field label="Project name" required className="col-span-2"><Input autoFocus value={f.name ?? ''} onChange={(e) => set('name', e.target.value)} placeholder="e.g. Ahmed Residence 10kW Hybrid" /></Field>
        <Field label="Customer" className="col-span-2">
          <Combobox options={customerOptions} value={f.customerId} onChange={(v) => set('customerId', v)} allowClear placeholder="Select customer" onCreate={(name) => setNewCust({ open: true, name })} createLabel="New customer" />
        </Field>
        <Field label="Contact person"><Input value={f.contactPerson ?? ''} onChange={(e) => set('contactPerson', e.target.value)} /></Field>
        <Field label="Contact phone"><Input value={f.contactPhone ?? ''} onChange={(e) => set('contactPhone', e.target.value)} /></Field>
        <Field label="Site address" className="col-span-2"><Input value={f.siteAddress ?? ''} onChange={(e) => set('siteAddress', e.target.value)} /></Field>
        <Field label="City"><Input value={f.city ?? ''} onChange={(e) => set('city', e.target.value)} /></Field>
        <Field label="System capacity (kW)"><NumberInput value={f.capacityKw} onChange={(v) => set('capacityKw', v)} /></Field>
        <Field label="Project type">
          <Select value={f.projectType} onChange={(e) => set('projectType', e.target.value)}>{PROJECT_TYPES.map((t) => <option key={t} value={t}>{label(t)}</option>)}</Select>
        </Field>
        <Field label="System type">
          <Select value={f.systemType} onChange={(e) => set('systemType', e.target.value)}>{SYSTEM_TYPES.map((t) => <option key={t} value={t}>{SYSTEM_TYPE_LABELS[t]}</option>)}</Select>
        </Field>
        <Field label="Start date"><DateInput clearable value={f.startDate ?? ''} onChange={(e) => set('startDate', e.target.value)} /></Field>
        <Field label="Expected completion"><DateInput clearable value={f.expectedEndDate ?? ''} onChange={(e) => set('expectedEndDate', e.target.value)} /></Field>
        <Field label="Status">
          <Select value={f.status} onChange={(e) => set('status', e.target.value)}>{PROJECT_STATUSES.map((s) => <option key={s} value={s}>{PROJECT_STATUS_LABELS[s]}</option>)}</Select>
        </Field>
        <Field label={`Progress (${f.progress ?? 0}%)`}>
          <input type="range" min={0} max={100} step={5} value={f.progress ?? 0} onChange={(e) => set('progress', Number(e.target.value))} className="mt-2 w-full accent-[var(--brand)]" />
        </Field>
        <Field label="Project manager">
          <Select value={f.managerUserId ?? ''} onChange={(e) => set('managerUserId', e.target.value ? Number(e.target.value) : null)}>
            <option value="">— Not assigned —</option>
            {(users.data ?? []).map((u) => <option key={u.id} value={u.id}>{u.full_name}</option>)}
          </Select>
        </Field>
        <Field label="Linked quotation">
          <Select value={f.quotationId ?? ''} onChange={(e) => set('quotationId', e.target.value ? Number(e.target.value) : null)}>
            <option value="">— None —</option>
            {(quotes.data ?? []).filter((q) => !f.customerId || q.party_id === f.customerId).map((q) => <option key={q.id} value={q.id}>{q.number} · {money(q.grand_total)}</option>)}
          </Select>
        </Field>
        <Field label="Contract / quoted amount" hint="For reference; revenue comes from invoices."><NumberInput value={f.contractAmount} onChange={(v) => set('contractAmount', v)} /></Field>
        <Field label="Allocated overhead" hint="Used when overhead method is 'manual' (Settings)."><NumberInput value={f.overheadAmount} onChange={(v) => set('overheadAmount', v)} /></Field>
        <Field label="Warranty information" className="col-span-2"><Textarea rows={2} value={f.warrantyInfo ?? ''} onChange={(e) => set('warrantyInfo', e.target.value)} /></Field>
        <Field label="Notes" className="col-span-2"><Textarea rows={2} value={f.notes ?? ''} onChange={(e) => set('notes', e.target.value)} /></Field>
      </div>
      {project && f.status === 'completed' && <div className="mt-2 text-[12px] text-muted">Completed on {date(f.completedDate || new Date().toISOString().slice(0, 10))}</div>}
      <PartyForm open={newCust.open} type="customer" initialName={newCust.name} onClose={() => setNewCust({ open: false })} onSaved={async (id) => { await reloadParties(); set('customerId', id) }} />
    </Modal>
  )
}
