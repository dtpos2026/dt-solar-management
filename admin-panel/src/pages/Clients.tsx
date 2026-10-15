/** Clients / companies: list with search, status + plan filters and pagination; /clients/:id shows the detail. */
import { useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { Building2, Plus } from 'lucide-react'
import { PageTitle } from '../components/ui'
import { CLIENT_STATUSES, clientSearchText, PLAN_TYPE_LABEL, PLAN_TYPES } from '../lib/clients'
import { useCan } from '../lib/auth'
import { fmtDate } from '../lib/format'
import type { PlanType } from '../lib/types'
import { Empty, Loading, Notice, Pager, Panel, Pill, SearchBox, usePaged, type NoticeMsg } from './licensing/kit'
import { useClients, useLicenses } from './licensing/hooks'
import { ClientForm } from './licensing/ClientForm'
import { ClientDetail } from './ClientDetail'

export function Clients() {
  const { id } = useParams()
  if (id) return <ClientDetail id={id} />
  return <ClientList />
}

function ClientList() {
  const nav = useNavigate()
  const can = useCan()
  const clients = useClients(can('clients.view'))
  const licenses = useLicenses()
  const [q, setQ] = useState('')
  const [status, setStatus] = useState('')
  const [plan, setPlan] = useState<'' | PlanType>('')
  const [form, setForm] = useState(false)
  const [msg, setMsg] = useState<NoticeMsg | null>(null)

  const licCount = useMemo(() => {
    const m = new Map<string, number>()
    for (const l of licenses.data) if (l.clientId) m.set(l.clientId, (m.get(l.clientId) ?? 0) + 1)
    return m
  }, [licenses.data])
  const list = useMemo(() => {
    const qq = q.trim().toLowerCase()
    return clients.data.filter((c) => (!status ? c.status !== 'archived' : status === 'all' || c.status === status) && (!plan || c.planType === plan) && (!qq || clientSearchText(c).includes(qq)))
  }, [clients.data, q, status, plan])
  const paged = usePaged(list, 15, `${q}|${status}|${plan}`)

  if (!can('clients.view')) return <Empty title="No access">You need the “View clients” permission.</Empty>
  return (
    <div>
      <PageTitle
        title="Clients"
        sub={clients.loading ? 'Loading…' : `${clients.data.length} client(s) / companies`}
        actions={can('clients.manage') && <button className="btn btn-primary" onClick={() => setForm(true)}><Plus className="h-4 w-4" />New client</button>}
      />
      <Notice msg={msg} onClose={() => setMsg(null)} className="mb-3" />
      {clients.error && <Notice msg={{ tone: 'error', text: clients.error }} className="mb-3" />}
      <Panel>
        <div className="flex flex-wrap items-center gap-2 border-b border-[#ece6f4] px-4 py-3">
          <SearchBox className="min-w-[240px] flex-1" value={q} onChange={setQ} placeholder="Search code, company, owner, phone, email, city…" />
          <select className="input w-auto" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">Active & suspended</option>
            {CLIENT_STATUSES.map((s) => <option key={s} value={s}>{s[0].toUpperCase() + s.slice(1)}</option>)}
            <option value="all">All (incl. archived)</option>
          </select>
          <select className="input w-auto" value={plan} onChange={(e) => setPlan(e.target.value as '' | PlanType)}>
            <option value="">Any plan</option>
            {PLAN_TYPES.map((p) => <option key={p} value={p}>{PLAN_TYPE_LABEL[p]}</option>)}
          </select>
        </div>
        {clients.loading ? <Loading /> : list.length === 0 ? (
          <Empty icon={<Building2 className="h-6 w-6" />} title={clients.data.length ? 'No client matches the filters' : 'No clients yet'}>Create a client, or use “Create client from license” on a license.</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-[13px]">
              <thead className="text-left text-[12px] text-[#7a6d92]">
                <tr><th className="px-4 py-2">Code</th><th className="px-4 py-2">Company</th><th className="px-4 py-2">Contact</th><th className="px-4 py-2">City</th><th className="px-4 py-2">Plan</th><th className="px-4 py-2">Licenses</th><th className="px-4 py-2">Registered</th><th className="px-4 py-2">Status</th></tr>
              </thead>
              <tbody>
                {paged.rows.map((c) => (
                  <tr key={c.id} className="cursor-pointer border-t border-[#f1ecf7] hover:bg-[#faf7fd]" onClick={() => nav(`/clients/${c.id}`)}>
                    <td className="px-4 py-2 font-mono font-bold">{c.code}</td>
                    <td className="px-4 py-2">
                      <div className="flex items-center gap-2">
                        {c.logo ? <img src={c.logo} alt="" className="h-7 w-7 rounded object-contain" /> : <div className="flex h-7 w-7 items-center justify-center rounded bg-[#efe4fb] text-[11px] font-bold text-[#3d096d]">{c.company.slice(0, 2).toUpperCase()}</div>}
                        <span className="font-semibold">{c.company}</span>
                      </div>
                    </td>
                    <td className="px-4 py-2">{c.ownerName}<div className="text-[11.5px] text-[#7a6d92]">{c.phone}</div></td>
                    <td className="px-4 py-2">{c.city || '—'}</td>
                    <td className="px-4 py-2">{c.plan || '—'} <Pill value={c.planType} /></td>
                    <td className="px-4 py-2">{licCount.get(c.id) ?? 0}</td>
                    <td className="px-4 py-2">{fmtDate(c.registeredAt ?? c.createdAt)}</td>
                    <td className="px-4 py-2"><Pill value={c.status} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <Pager {...paged} />
      </Panel>
      {form && <ClientForm open onClose={() => setForm(false)} onSaved={(cid, info) => { setForm(false); setMsg({ tone: 'success', text: `Client ${info.code ?? ''} created.` }); nav(`/clients/${cid}`) }} />}
    </div>
  )
}
