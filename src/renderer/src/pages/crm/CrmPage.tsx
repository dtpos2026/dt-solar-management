/** CRM: leads, pipeline board and follow-ups. A won lead becomes a customer; a quotation can be started from any lead. */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { CalendarClock, FileText, MapPin, MessageCircle, Pencil, Phone, Plus, Search, Target, Trash2, TrendingUp, Trophy, UserCheck } from 'lucide-react'
import { api } from '../../api'
import { useCan } from '../../store'
import { Badge, Button, Card, Empty, Field, Input, Loading, Modal, NumberInput, PageHeader, Select, StatCard, Tabs, Textarea, confirmDialog, cx, promptDialog, toast } from '../../components/ui'
import { DataTable } from '../../components/DataTable'
import { DateInput } from '../../components/DateInput'
import { date, money, today } from '../../lib/format'
import { ACTIVITY_KINDS, ACTIVITY_LABEL, LEAD_SOURCES, OPEN_STAGES, STAGES, stageLabel } from '../../../../shared/crm'

interface Lead {
  id: number
  name: string
  phone: string | null
  email: string | null
  city: string | null
  address: string | null
  source: string | null
  interest: string | null
  system_kw: number | null
  expected_value: number
  stage: string
  assigned_to: number | null
  assigned_name: string | null
  next_follow_up: string | null
  last_contact_at: string | null
  notes: string | null
  lost_reason: string | null
  party_id: number | null
  party_name: string | null
  last_activity: string | null
  created_at: string
}
interface Activity {
  id: number
  kind: string
  summary: string
  at: string
  username: string | null
}
interface Summary {
  open: number
  pipelineValue: number
  byStage: Array<{ stage: string; label: string; count: number; value: number }>
  followUps: { overdue: number; today: number; week: number }
  wonThisMonth: { count: number; value: number }
  conversionPct: number | null
}
interface UserOpt {
  id: number
  full_name: string
}
type Tab = 'pipeline' | 'list' | 'followups'

const addDays = (n: number): string => {
  const d = new Date()
  d.setDate(d.getDate() + n)
  const p = (x: number): string => String(x).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}
const STAGE_TONE: Record<string, string> = { new: 'muted', contacted: 'info', site_visit: 'info', quoted: 'brand', negotiation: 'warn', won: 'ok', lost: 'bad' }

function FollowUp({ d, closed }: { d: string | null; closed?: boolean }): JSX.Element {
  if (!d || closed) return <span className="text-muted">No date</span>
  const t = today()
  if (d < t) return <Badge tone="bad">Overdue, {date(d)}</Badge>
  if (d === t) return <Badge tone="warn">Today</Badge>
  return <span>{date(d)}</span>
}

export function CrmPage(): JSX.Element {
  const can = useCan()
  const manage = can('crm.manage')
  const [tab, setTab] = useState<Tab>('pipeline')
  const [summary, setSummary] = useState<Summary | null>(null)
  const [leads, setLeads] = useState<Lead[] | null>(null)
  const [users, setUsers] = useState<UserOpt[]>([])
  const [form, setForm] = useState<{ open: boolean; lead?: Lead }>({ open: false })
  const [detail, setDetail] = useState<number | null>(null)
  const [q, setQ] = useState('')
  const [status, setStatus] = useState<'open' | 'won' | 'lost' | 'all'>('open')
  const [assignee, setAssignee] = useState('')
  const [dragId, setDragId] = useState<number | null>(null)
  const [overStage, setOverStage] = useState<string | null>(null)

  const reload = useCallback(async (): Promise<void> => {
    try {
      const [s, l] = await Promise.all([api<Summary>('crm.summary'), api<Lead[]>('crm.list', { status: 'all' })])
      setSummary(s)
      setLeads(l)
    } catch (e) {
      toast.error(e)
    }
  }, [])
  useEffect(() => {
    void reload()
    api<UserOpt[]>('users.basic').then(setUsers).catch(() => undefined)
  }, [reload])

  const changeStage = async (lead: Lead, stage: string): Promise<void> => {
    if (lead.stage === stage) return
    let reason: string | undefined
    if (stage === 'lost') {
      const r = await promptDialog({
        title: `Why was ${lead.name} lost?`,
        confirmLabel: 'Mark as lost',
        danger: true,
        message: 'The reason is kept in the lead history, so you can learn why enquiries are not converting.',
        input: { label: 'Reason', placeholder: 'For example: price too high, chose another company', required: true }
      })
      if (!r) return
      reason = r
    }
    try {
      const res = await api<{ partyId: number | null }>('crm.setStage', { id: lead.id, stage, reason })
      if (stage === 'won') toast.ok(`${lead.name} is now a customer. Congratulations!`)
      await reload()
      return void res
    } catch (e) {
      toast.error(e)
    }
  }

  const open = (leads ?? []).filter((l) => OPEN_STAGES.includes(l.stage as never))
  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return (leads ?? []).filter((l) => {
      if (status === 'open' && !OPEN_STAGES.includes(l.stage as never)) return false
      if ((status === 'won' || status === 'lost') && l.stage !== status) return false
      if (assignee && String(l.assigned_to ?? '') !== assignee) return false
      if (needle && ![l.name, l.phone, l.city, l.interest, l.source].some((v) => (v ?? '').toLowerCase().includes(needle))) return false
      return true
    })
  }, [leads, q, status, assignee])

  if (!leads || !summary) return <Loading label="Loading CRM…" />
  const t = today()
  const due = (pred: (d: string) => boolean): Lead[] => open.filter((l) => l.next_follow_up && pred(l.next_follow_up))
  const overdue = due((d) => d < t)
  const dueToday = due((d) => d === t)
  const soon = due((d) => d > t && d <= addDays(7))
  const stageSummary = (k: string): { count: number; value: number } => summary.byStage.find((s) => s.stage === k) ?? { count: 0, value: 0 }

  const Card1 = ({ l }: { l: Lead }): JSX.Element => (
    <div
      draggable={manage}
      onDragStart={() => setDragId(l.id)}
      onDragEnd={() => {
        setDragId(null)
        setOverStage(null)
      }}
      onClick={() => setDetail(l.id)}
      className={cx('cursor-pointer rounded-xl border border-line bg-surface p-3 text-[13px] shadow-sm transition hover:border-brand hover:shadow-md', dragId === l.id && 'opacity-50')}
    >
      <div className="font-semibold">{l.name}</div>
      <div className="mt-0.5 text-[12px] text-muted">{[l.interest, l.system_kw ? `${l.system_kw} kW` : null].filter(Boolean).join(', ') || 'No details yet'}</div>
      <div className="mt-2 flex items-center justify-between gap-2">
        <span className="num font-semibold text-brand">{money(l.expected_value)}</span>
        {l.city && (
          <span className="inline-flex items-center gap-1 text-[12px] text-muted">
            <MapPin className="h-3 w-3" />
            {l.city}
          </span>
        )}
      </div>
      <div className="mt-2 flex items-center justify-between gap-2 text-[12px]">
        <FollowUp d={l.next_follow_up} />
        {l.assigned_name && <span className="truncate text-muted">{l.assigned_name}</span>}
      </div>
    </div>
  )

  return (
    <div className="space-y-4">
      <PageHeader
        title="CRM"
        subtitle="Enquiries, follow-ups and the sales pipeline, from the first call to a won customer"
        icon={<Target className="h-5 w-5" />}
        actions={manage && <Button variant="primary" icon={<Plus className="h-4 w-4" />} onClick={() => setForm({ open: true })}>New lead</Button>}
      />

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        <StatCard label="Open leads" value={String(summary.open)} icon={<Target className="h-4 w-4" />} sub="in the pipeline" />
        <StatCard label="Pipeline value" value={money(summary.pipelineValue)} icon={<TrendingUp className="h-4 w-4" />} tone="info" sub="expected, open leads" />
        <StatCard
          label="Follow-ups due"
          value={String(summary.followUps.overdue + summary.followUps.today)}
          icon={<CalendarClock className="h-4 w-4" />}
          tone={summary.followUps.overdue ? 'bad' : 'warn'}
          sub={`${summary.followUps.overdue} overdue, ${summary.followUps.today} today`}
          onClick={() => setTab('followups')}
        />
        <StatCard label="Won this month" value={String(summary.wonThisMonth.count)} icon={<Trophy className="h-4 w-4" />} tone="ok" sub={money(summary.wonThisMonth.value)} />
        <StatCard label="Conversion" value={summary.conversionPct === null ? 'n/a' : `${summary.conversionPct}%`} icon={<UserCheck className="h-4 w-4" />} tone="sun" sub="won of won plus lost" />
      </div>

      <Tabs<Tab>
        value={tab}
        onChange={setTab}
        tabs={[
          { key: 'pipeline', label: 'Pipeline' },
          { key: 'list', label: 'All leads', count: leads.length },
          { key: 'followups', label: 'Follow-ups', count: overdue.length + dueToday.length || undefined }
        ]}
      />

      {tab === 'pipeline' && (
        <div className="space-y-3">
          <div className="grid gap-3 xl:grid-cols-5">
            {OPEN_STAGES.map((st) => {
              const col = open.filter((l) => l.stage === st)
              const sum = stageSummary(st)
              return (
                <div
                  key={st}
                  onDragOver={(e) => {
                    if (!manage) return
                    e.preventDefault()
                    setOverStage(st)
                  }}
                  onDragLeave={() => setOverStage((o) => (o === st ? null : o))}
                  onDrop={() => {
                    const l = leads.find((x) => x.id === dragId)
                    setOverStage(null)
                    if (l) void changeStage(l, st)
                  }}
                  className={cx('min-h-40 rounded-2xl border border-line bg-surface-2 p-2.5 transition', overStage === st && 'border-brand bg-brand-soft')}
                >
                  <div className="mb-2 flex items-center justify-between px-1">
                    <span className="text-[13px] font-bold">{stageLabel(st)}</span>
                    <Badge tone={STAGE_TONE[st]}>{sum.count}</Badge>
                  </div>
                  <div className="mb-2 px-1 text-[12px] text-muted num">{money(sum.value)}</div>
                  <div className="space-y-2">{col.map((l) => <Card1 key={l.id} l={l} />)}</div>
                  {col.length === 0 && <div className="px-1 py-6 text-center text-[12px] text-muted">{manage ? 'Drop a lead here' : 'No leads'}</div>}
                </div>
              )
            })}
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            {(['won', 'lost'] as const).map((st) => {
              const sum = stageSummary(st)
              return (
                <div
                  key={st}
                  onDragOver={(e) => {
                    if (!manage) return
                    e.preventDefault()
                    setOverStage(st)
                  }}
                  onDragLeave={() => setOverStage((o) => (o === st ? null : o))}
                  onDrop={() => {
                    const l = leads.find((x) => x.id === dragId)
                    setOverStage(null)
                    if (l) void changeStage(l, st)
                  }}
                  className={cx('flex items-center justify-between rounded-2xl border border-dashed p-4 transition', st === 'won' ? 'border-ok/50 bg-ok-soft' : 'border-bad/50 bg-bad-soft', overStage === st && 'ring-2 ring-brand')}
                >
                  <div>
                    <div className="text-[14px] font-bold">{st === 'won' ? 'Won' : 'Lost'}</div>
                    <div className="text-[12px] text-muted">{manage ? (st === 'won' ? 'Drop here to win the lead and create the customer' : 'Drop here to close the lead with a reason') : `${sum.count} lead(s)`}</div>
                  </div>
                  <button type="button" className="text-right cursor-pointer" onClick={() => { setStatus(st); setTab('list') }}>
                    <div className="text-[20px] font-bold num">{sum.count}</div>
                    <div className="text-[12px] text-muted num">{money(sum.value)}</div>
                  </button>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {tab === 'list' && (
        <Card pad={false}>
          <div className="flex flex-wrap items-center gap-2 px-3 py-2.5">
            <div className="relative w-64 max-w-full">
              <Search className="pointer-events-none absolute top-1/2 left-2.5 h-4 w-4 -translate-y-1/2 text-muted" />
              <Input sm className="pl-8" placeholder="Search name, phone, city…" value={q} onChange={(e) => setQ(e.target.value)} />
            </div>
            <Select sm className="w-40" value={status} onChange={(e) => setStatus(e.target.value as typeof status)}>
              <option value="open">Open leads</option>
              <option value="won">Won</option>
              <option value="lost">Lost</option>
              <option value="all">All</option>
            </Select>
            <Select sm className="w-48" value={assignee} onChange={(e) => setAssignee(e.target.value)}>
              <option value="">Everyone</option>
              {users.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.full_name}
                </option>
              ))}
            </Select>
          </div>
          <DataTable<Lead>
            rows={filtered}
            searchable={false}
            dense
            rowKey={(r) => r.id}
            onRowClick={(r) => setDetail(r.id)}
            empty={<Empty icon={<Target />} title="No leads found">{manage ? 'Add your first enquiry with New lead.' : 'Nothing matches the filters.'}</Empty>}
            columns={[
              { key: 'name', header: 'Lead', value: (r) => r.name, render: (r) => <div><div className="font-semibold">{r.name}</div><div className="text-[12px] text-muted">{[r.phone, r.city].filter(Boolean).join(', ')}</div></div> },
              { key: 'stage', header: 'Stage', value: (r) => r.stage, render: (r) => <Badge tone={STAGE_TONE[r.stage]}>{stageLabel(r.stage)}</Badge> },
              { key: 'interest', header: 'Interest', value: (r) => r.interest ?? '', render: (r) => <span>{[r.interest, r.system_kw ? `${r.system_kw} kW` : null].filter(Boolean).join(', ') || '-'}</span> },
              { key: 'expected_value', header: 'Expected', align: 'right', render: (r) => <span className="num">{money(r.expected_value)}</span> },
              { key: 'next_follow_up', header: 'Next follow-up', value: (r) => r.next_follow_up ?? '', render: (r) => <FollowUp d={r.next_follow_up} closed={r.stage === 'won' || r.stage === 'lost'} /> },
              { key: 'assigned_name', header: 'Assigned to', value: (r) => r.assigned_name ?? '', render: (r) => <span>{r.assigned_name ?? '-'}</span> },
              { key: 'last_activity', header: 'Last activity', value: (r) => r.last_activity ?? '', render: (r) => <span className="block max-w-[260px] truncate text-muted" title={r.last_activity ?? ''}>{r.last_activity ?? '-'}</span> }
            ]}
          />
        </Card>
      )}

      {tab === 'followups' && (
        <div className="grid gap-4 xl:grid-cols-3">
          {([
            ['Overdue', overdue, 'bad'],
            ['Today', dueToday, 'warn'],
            ['Next 7 days', soon, 'info']
          ] as const).map(([title, rows, tone]) => (
            <Card key={title} title={<span className="inline-flex items-center gap-2">{title} <Badge tone={tone}>{rows.length}</Badge></span>}>
              {rows.length === 0 ? (
                <div className="py-6 text-center text-[13px] text-muted">Nothing here.</div>
              ) : (
                <div className="space-y-2">
                  {rows.map((l) => (
                    <button key={l.id} type="button" onClick={() => setDetail(l.id)} className="block w-full cursor-pointer rounded-xl border border-line p-3 text-left text-[13px] hover:border-brand">
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-semibold">{l.name}</span>
                        <FollowUp d={l.next_follow_up} />
                      </div>
                      <div className="mt-0.5 text-[12px] text-muted">{[l.phone, l.interest].filter(Boolean).join(', ')}</div>
                      {l.last_activity && <div className="mt-1 truncate text-[12px]">Last: {l.last_activity}</div>}
                    </button>
                  ))}
                </div>
              )}
            </Card>
          ))}
        </div>
      )}

      {form.open && (
        <LeadForm
          lead={form.lead}
          users={users}
          onClose={() => setForm({ open: false })}
          onSaved={(id) => {
            setForm({ open: false })
            void reload()
            if (!form.lead) setDetail(id)
          }}
        />
      )}
      {detail !== null && (
        <LeadDetail
          id={detail}
          manage={manage}
          onClose={() => setDetail(null)}
          onChanged={reload}
          onEdit={(l) => {
            setDetail(null)
            setForm({ open: true, lead: l })
          }}
          onStage={changeStage}
        />
      )}
    </div>
  )
}

/* ------------------------------------------------ add / edit ------------------------------------------------ */

function LeadForm({ lead, users, onClose, onSaved }: { lead?: Lead; users: UserOpt[]; onClose: () => void; onSaved: (id: number) => void }): JSX.Element {
  const [f, setF] = useState({
    name: lead?.name ?? '',
    phone: lead?.phone ?? '',
    email: lead?.email ?? '',
    city: lead?.city ?? '',
    address: lead?.address ?? '',
    source: lead?.source ?? '',
    interest: lead?.interest ?? '',
    systemKw: lead?.system_kw ?? 0,
    expectedValue: lead?.expected_value ?? 0,
    assignedTo: lead?.assigned_to ? String(lead.assigned_to) : '',
    nextFollowUp: lead?.next_follow_up ?? '',
    notes: lead?.notes ?? ''
  })
  const [busy, setBusy] = useState(false)
  const set = (k: string, v: unknown): void => setF((x) => ({ ...x, [k]: v }))
  const save = async (): Promise<void> => {
    if (!f.name.trim()) return toast.error('Enter the name of the person or company.')
    setBusy(true)
    try {
      const id = await api<number>('crm.save', { id: lead?.id, ...f, assignedTo: f.assignedTo ? Number(f.assignedTo) : null, nextFollowUp: f.nextFollowUp || null, systemKw: f.systemKw || null })
      toast.ok(lead ? 'Lead saved.' : 'Lead added.')
      onSaved(id)
    } catch (e) {
      toast.error(e)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Modal
      open
      onClose={onClose}
      size="lg"
      title={lead ? `Edit ${lead.name}` : 'New lead'}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={busy} onClick={save}>{lead ? 'Save lead' : 'Add lead'}</Button>
        </>
      }
    >
      <div className="grid grid-cols-2 gap-3">
        <Field label="Name" required className="col-span-2 sm:col-span-1"><Input autoFocus value={f.name} maxLength={150} onChange={(e) => set('name', e.target.value)} placeholder="Person or company" /></Field>
        <Field label="Phone / WhatsApp"><Input value={f.phone} maxLength={40} onChange={(e) => set('phone', e.target.value)} placeholder="0300 1234567" /></Field>
        <Field label="City"><Input value={f.city} maxLength={80} onChange={(e) => set('city', e.target.value)} /></Field>
        <Field label="Email"><Input value={f.email} maxLength={120} onChange={(e) => set('email', e.target.value)} /></Field>
        <Field label="Address" className="col-span-2"><Input value={f.address} maxLength={300} onChange={(e) => set('address', e.target.value)} /></Field>
        <Field label="Interested in"><Input value={f.interest} maxLength={200} onChange={(e) => set('interest', e.target.value)} placeholder="For example: 10 kW on-grid for a shop" /></Field>
        <Field label="System size (kW)"><NumberInput value={f.systemKw} onChange={(v) => set('systemKw', v)} /></Field>
        <Field label="Expected value"><NumberInput value={f.expectedValue} onChange={(v) => set('expectedValue', v)} /></Field>
        <Field label="Source">
          <Select value={LEAD_SOURCES.includes(f.source) ? f.source : f.source ? '__other' : ''} onChange={(e) => set('source', e.target.value === '__other' ? 'Other' : e.target.value)}>
            <option value="">Not set</option>
            {LEAD_SOURCES.map((s) => <option key={s} value={s}>{s}</option>)}
          </Select>
        </Field>
        <Field label="Assigned to">
          <Select value={f.assignedTo} onChange={(e) => set('assignedTo', e.target.value)}>
            <option value="">Nobody</option>
            {users.map((u) => <option key={u.id} value={u.id}>{u.full_name}</option>)}
          </Select>
        </Field>
        <Field label="Next follow-up"><DateInput value={f.nextFollowUp} min={undefined} onChange={(e) => set('nextFollowUp', e.target.value)} /></Field>
        <Field label="Notes" className="col-span-2"><Textarea rows={3} value={f.notes} maxLength={2000} onChange={(e) => set('notes', e.target.value)} /></Field>
      </div>
    </Modal>
  )
}

/* ------------------------------------------------ detail + timeline ------------------------------------------------ */

function LeadDetail({ id, manage, onClose, onChanged, onEdit, onStage }: { id: number; manage: boolean; onClose: () => void; onChanged: () => Promise<void>; onEdit: (l: Lead) => void; onStage: (l: Lead, stage: string) => Promise<void> }): JSX.Element {
  const nav = useNavigate()
  const can = useCan()
  const [data, setData] = useState<{ lead: Lead; activities: Activity[] } | null>(null)
  const [kind, setKind] = useState<string>('call')
  const [text, setText] = useState('')
  const [next, setNext] = useState('')
  const [busy, setBusy] = useState(false)

  const load = useCallback(async (): Promise<void> => {
    try {
      setData(await api<{ lead: Lead; activities: Activity[] }>('crm.get', { id }))
    } catch (e) {
      toast.error(e)
      onClose()
    }
  }, [id, onClose])
  useEffect(() => {
    void load()
  }, [load])
  if (!data) return <Modal open onClose={onClose} title="Lead" size="lg"><Loading /></Modal>
  const l = data.lead
  const closed = l.stage === 'won' || l.stage === 'lost'

  const log = async (): Promise<void> => {
    if (!text.trim()) return toast.error('Write what happened.')
    setBusy(true)
    try {
      await api('crm.activity', { id, kind, summary: text, ...(next ? { nextFollowUp: next } : {}) })
      setText('')
      setNext('')
      await load()
      await onChanged()
      toast.ok('Saved to the timeline.')
    } catch (e) {
      toast.error(e)
    } finally {
      setBusy(false)
    }
  }
  const startQuotation = async (): Promise<void> => {
    const ok = await confirmDialog({
      title: 'Start a quotation for this lead?',
      confirmLabel: 'Create customer and open quotation',
      message: l.party_id ? `${l.name} is already a customer. A new quotation will open for them.` : `${l.name} is added to your customers first (name, phone, city and address are copied), then a new quotation opens.`
    })
    if (!ok) return
    try {
      const r = await api<{ partyId: number }>('crm.convert', { id })
      if (l.stage === 'new' || l.stage === 'contacted' || l.stage === 'site_visit') await api('crm.setStage', { id, stage: 'quoted' }).catch(() => undefined)
      await onChanged()
      onClose()
      nav(`/doc/new/quotation?party=${r.partyId}`)
    } catch (e) {
      toast.error(e)
    }
  }
  const whatsapp = (): void => {
    api('whatsapp.openChat', { phone: l.phone }).then(() => onClose()).catch((e) => toast.error(e))
  }
  const remove = async (): Promise<void> => {
    const ok = await confirmDialog({ title: `Delete ${l.name}?`, danger: true, confirmLabel: 'Delete lead', message: 'The lead and its timeline are removed. A customer created from it is not deleted.' })
    if (!ok) return
    try {
      await api('crm.delete', { id })
      toast.ok('Lead deleted.')
      await onChanged()
      onClose()
    } catch (e) {
      toast.error(e)
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      size="xl"
      title={<span className="inline-flex items-center gap-2">{l.name} <Badge tone={STAGE_TONE[l.stage]}>{stageLabel(l.stage)}</Badge></span>}
      subtitle={[l.phone, l.city].filter(Boolean).join(', ') || undefined}
      footer={
        <>
          {manage && <Button variant="ghost" className="mr-auto text-bad" icon={<Trash2 className="h-4 w-4" />} onClick={remove}>Delete</Button>}
          {manage && <Button icon={<Pencil className="h-4 w-4" />} onClick={() => onEdit(l)}>Edit</Button>}
          <Button onClick={onClose}>Close</Button>
        </>
      }
    >
      <div className="grid gap-5 lg:grid-cols-[1fr_1.15fr]">
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-[13px]">
            <Info k="Interested in" v={[l.interest, l.system_kw ? `${l.system_kw} kW` : null].filter(Boolean).join(', ') || '-'} />
            <Info k="Expected value" v={money(l.expected_value)} />
            <Info k="Source" v={l.source || '-'} />
            <Info k="Assigned to" v={l.assigned_name || '-'} />
            <Info k="Next follow-up" v={<FollowUp d={l.next_follow_up} closed={closed} />} />
            <Info k="Last contact" v={l.last_contact_at ? date(l.last_contact_at.slice(0, 10)) : 'Never'} />
            {l.email && <Info k="Email" v={l.email} />}
            {l.address && <Info k="Address" v={l.address} />}
            {l.party_id && <Info k="Customer" v={<button type="button" className="cursor-pointer font-semibold text-brand underline" onClick={() => { onClose(); nav(`/party/${l.party_id}`) }}>{l.party_name}</button>} />}
            {l.lost_reason && <Info k="Lost because" v={l.lost_reason} />}
          </div>
          {l.notes && <div className="rounded-xl bg-surface-2 p-3 text-[13px] whitespace-pre-wrap">{l.notes}</div>}

          {manage && (
            <div>
              <div className="mb-1.5 text-[12px] font-semibold tracking-wide text-muted uppercase">Move to stage</div>
              <div className="flex flex-wrap gap-1.5">
                {STAGES.map((s) => (
                  <button
                    key={s.key}
                    type="button"
                    disabled={s.key === l.stage}
                    onClick={() => onStage(l, s.key).then(load)}
                    className={cx('cursor-pointer rounded-lg border px-2.5 py-1 text-[12.5px] font-medium transition', s.key === l.stage ? 'border-brand bg-brand text-on-brand' : 'border-line hover:border-brand')}
                  >
                    {s.label}
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className="flex flex-wrap gap-2">
            {l.phone && can('whatsapp.send') && <Button icon={<MessageCircle className="h-4 w-4" />} onClick={whatsapp}>WhatsApp</Button>}
            {manage && can('quotations.manage') && !closed && <Button variant="primary" icon={<FileText className="h-4 w-4" />} onClick={startQuotation}>Create quotation</Button>}
          </div>
        </div>

        <div className="space-y-3">
          {manage && (
            <div className="rounded-xl border border-line p-3">
              <div className="mb-2 flex items-center gap-2 text-[13px] font-bold"><Phone className="h-4 w-4 text-brand" /> Log an activity</div>
              <div className="grid grid-cols-[9rem_1fr] gap-2">
                <Select value={kind} onChange={(e) => setKind(e.target.value)}>
                  {ACTIVITY_KINDS.map((k) => <option key={k} value={k}>{ACTIVITY_LABEL[k]}</option>)}
                </Select>
                <Input value={text} maxLength={500} onChange={(e) => setText(e.target.value)} placeholder="What happened? For example: wants a quotation for 10 kW" onKeyDown={(e) => e.key === 'Enter' && void log()} />
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <span className="text-[12.5px] text-muted">Next follow-up</span>
                <DateInput sm className="num w-[9.5rem]" value={next} onChange={(e) => setNext(e.target.value)} />
                {[['Tomorrow', 1], ['In 3 days', 3], ['Next week', 7]].map(([label, n]) => (
                  <button key={String(label)} type="button" className="cursor-pointer rounded-md border border-line px-2 py-0.5 text-[12px] hover:border-brand" onClick={() => setNext(addDays(Number(n)))}>{label}</button>
                ))}
                <Button variant="primary" size="sm" className="ml-auto" loading={busy} onClick={log}>Save</Button>
              </div>
            </div>
          )}
          <div className="max-h-[22rem] space-y-2 overflow-y-auto pr-1">
            {data.activities.map((a) => (
              <div key={a.id} className="flex gap-3 text-[13px]">
                <div className={cx('mt-1 h-2.5 w-2.5 shrink-0 rounded-full', a.kind === 'stage' ? 'bg-warn' : 'bg-brand')} />
                <div className="min-w-0 flex-1">
                  <div>{a.summary}</div>
                  <div className="text-[12px] text-muted">{ACTIVITY_LABEL[a.kind] ?? a.kind}, {a.at.slice(0, 16).replace('T', ' ')}{a.username ? `, ${a.username}` : ''}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </Modal>
  )
}

function Info({ k, v }: { k: string; v: React.ReactNode }): JSX.Element {
  return (
    <div>
      <div className="text-[12px] text-muted">{k}</div>
      <div className="font-medium">{v}</div>
    </div>
  )
}
