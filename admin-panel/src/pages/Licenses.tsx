/** Licenses: list (search / filters / pagination) with tabs for activation requests and offline activation. */
import { useEffect, useMemo, useState } from 'react'
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom'
import { BadgeCheck, Inbox, KeyRound, Sparkles, TimerReset, WifiOff } from 'lucide-react'
import { onSnapshot, query, where } from 'firebase/firestore'
import { PageTitle, copy } from '../components/ui'
import { expiryLabel, licenseBucketOf, requestsCol } from '../lib/licenses'
import { PLAN_TYPE_LABEL, PLAN_TYPES } from '../lib/clients'
import { paymentStatusFromInvoices } from '../lib/stats'
import { daysUntil } from '../lib/format'
import { useCan } from '../lib/auth'
import type { InvoiceRow } from '../lib/fleet'
import type { License, PlanType } from '../lib/types'
import { Empty, Loading, Notice, Pager, Panel, Pill, SearchBox, Tabs, usePaged } from './licensing/kit'
import { BILLING_READ_PERMS, useClients, useInvoices, useLicenses } from './licensing/hooks'
import { LicenseForm } from './LicenseForm'
import { Requests } from './Requests'
import { Offline } from './Offline'
import { MaskedKey } from './licenses/parts'
import { TrialDialog } from './licenses/TrialDialog'

type Tab = 'list' | 'requests' | 'offline'
type StatusFilter = '' | 'active' | 'pending' | 'suspended' | 'revoked' | 'expired' | 'detached' | 'expiring' | 'trial'

/** Number of pending activation requests (live) for the tab badge; 0 when the admin may not list them. */
export function usePendingRequests(enabled: boolean): number {
  const [n, setN] = useState(0)
  useEffect(() => {
    if (!enabled) return setN(0)
    return onSnapshot(query(requestsCol(), where('status', '==', 'pending')), (s) => setN(s.size), () => setN(0))
  }, [enabled])
  return n
}

export function licenseDisplayStatus(l: License): string {
  return l.detached ? 'detached' : licenseBucketOf(l)
}

export function Licenses() {
  const nav = useNavigate()
  const can = useCan()
  const [params, setParams] = useSearchParams()
  const tab = (['list', 'requests', 'offline'].includes(params.get('tab') ?? '') ? params.get('tab') : 'list') as Tab
  const setTab = (t: Tab) => setParams(t === 'list' ? {} : { tab: t }, { replace: true })
  const canRequests = can('devices.manage') || can('licenses.manage')
  const canCreate = can('licenses.generate') || can('licenses.manage')
  const pendingCount = usePendingRequests(canRequests)
  const licenses = useLicenses()
  const clients = useClients(can('clients.view'))
  const billing = BILLING_READ_PERMS.some(can)
  const invoices = useInvoices(billing)
  const [q, setQ] = useState('')
  const [status, setStatus] = useState<StatusFilter>('')
  const [planType, setPlanType] = useState<'' | PlanType>('')
  const [clientId, setClientId] = useState('')
  const [form, setForm] = useState(false)
  const [trial, setTrial] = useState(false)
  const [created, setCreated] = useState<{ id: string; key: string; client?: { label: string; created: boolean } } | null>(null)
  // Notice handed over by the license page after "Delete license" (shown once, then dropped from the history entry).
  const loc = useLocation()
  const handed = (loc.state as { notice?: string; tone?: 'success' | 'warn' } | null) ?? null
  const [deletedMsg, setDeletedMsg] = useState(handed?.notice ? { tone: handed.tone ?? 'success', text: handed.notice } : null)
  useEffect(() => {
    if (handed?.notice) nav({ pathname: loc.pathname, search: loc.search }, { replace: true, state: null })
  }, [handed?.notice]) // eslint-disable-line react-hooks/exhaustive-deps

  const clientById = useMemo(() => new Map(clients.data.map((c) => [c.id, c])), [clients.data])
  const invByLicense = useMemo(() => {
    const m = new Map<string, InvoiceRow[]>()
    for (const i of invoices.data) if (i.licenseId) m.set(i.licenseId, [...(m.get(i.licenseId) ?? []), i])
    return m
  }, [invoices.data])

  const list = useMemo(() => {
    const qq = q.trim().toLowerCase()
    return licenses.data.filter((l) => {
      const st = licenseDisplayStatus(l)
      if (status === 'trial') {
        if (l.planType !== 'trial' && l.plan !== 'trial') return false
      } else if (status === 'expiring') {
        const d = daysUntil(l.expiresAt)
        if (!(d !== null && d >= 0 && d <= 30 && l.status === 'active')) return false
      } else if (status && st !== status) return false
      if (planType && l.planType !== planType) return false
      if (clientId === '__none' ? !!l.clientId : clientId && l.clientId !== clientId) return false
      if (qq) {
        const c = clientById.get(l.clientId)
        const t = `${l.businessName} ${l.customerName} ${l.licenseKey} ${l.phone} ${l.email} ${l.city} ${c?.code ?? ''} ${c?.company ?? ''}`.toLowerCase()
        if (!t.includes(qq)) return false
      }
      return true
    })
  }, [licenses.data, q, status, planType, clientId, clientById])
  const paged = usePaged(list, 15, `${q}|${status}|${planType}|${clientId}`)

  return (
    <div>
      <PageTitle
        title="Licenses"
        sub={licenses.loading ? 'Loading…' : `${licenses.data.length} license(s) · keys are generated with a cryptographically secure random source`}
        actions={
          canCreate && (
            <>
              <button className="btn btn-secondary" onClick={() => setTrial(true)}>
                <TimerReset className="h-4 w-4" />
                Issue trial
              </button>
              <button className="btn btn-primary" onClick={() => setForm(true)}>
                <Sparkles className="h-4 w-4" />
                Generate key / new license
              </button>
            </>
          )
        }
      />
      <Tabs<Tab>
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'list', label: <><BadgeCheck className="h-4 w-4" />Licenses</> },
          ...(canRequests
            ? [
                { id: 'requests' as Tab, label: <><Inbox className="h-4 w-4" />Activation requests{pendingCount > 0 && <span className="ml-1 rounded-full bg-amber-400 px-1.5 text-[11px] text-[#2b0750]">{pendingCount}</span>}</> },
                { id: 'offline' as Tab, label: <><WifiOff className="h-4 w-4" />Offline activation</> }
              ]
            : [])
        ]}
      />
      {tab === 'requests' && canRequests ? (
        <Requests embedded />
      ) : tab === 'offline' && canRequests ? (
        <Offline embedded />
      ) : (
        <>
          {created && (
            <Notice
              msg={{
                tone: 'success',
                text: (
                  <span>
                    License created. Key <b className="font-mono">{created.key}</b>{' '}
                    <button className="underline" onClick={() => copy(created.key)}>
                      copy
                    </button>{' '}
                    ·{' '}
                    <Link className="font-bold underline" to={`/licenses/${created.id}`}>
                      open license
                    </Link>
                    {created.client && <> · client {created.client.label}{created.client.created ? ' (new)' : ''}</>}
                  </span>
                )
              }}
              onClose={() => setCreated(null)}
            />
          )}
          <Notice msg={deletedMsg} onClose={() => setDeletedMsg(null)} />
          <Notice msg={licenses.error ? { tone: 'error', text: licenses.error } : null} />
          <div className="mb-4 flex flex-wrap items-center gap-2">
            <SearchBox value={q} onChange={setQ} placeholder="Search business, customer, key, phone, client…" className="w-80" />
            <select className="input w-44" value={status} onChange={(e) => setStatus(e.target.value as StatusFilter)} aria-label="Status filter">
              <option value="">All statuses</option>
              <option value="active">Active</option>
              <option value="pending">Pending (no device yet)</option>
              <option value="expiring">Expiring in 30 days</option>
              <option value="suspended">Suspended</option>
              <option value="revoked">Revoked</option>
              <option value="expired">Expired</option>
              <option value="detached">Detached (lifetime)</option>
              <option value="trial">Trial</option>
            </select>
            <select className="input w-40" value={planType} onChange={(e) => setPlanType(e.target.value as PlanType | '')} aria-label="Billing cycle filter">
              <option value="">All billing cycles</option>
              {PLAN_TYPES.map((p) => (
                <option key={p} value={p}>
                  {PLAN_TYPE_LABEL[p]}
                </option>
              ))}
            </select>
            {can('clients.view') && (
              <select className="input w-56" value={clientId} onChange={(e) => setClientId(e.target.value)} aria-label="Client filter">
                <option value="">All clients</option>
                <option value="__none">— Without client —</option>
                {clients.data.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.code} · {c.company}
                  </option>
                ))}
              </select>
            )}
            <div className="ml-auto text-[12.5px] text-[#7a6d92]">{list.length} shown</div>
          </div>
          <Panel>
            {licenses.loading ? (
              <Loading />
            ) : list.length === 0 ? (
              <Empty icon={<KeyRound />} title={licenses.data.length ? 'No license matches the filters' : 'No licenses yet'}>
                {licenses.data.length ? 'Clear the search or filters.' : canCreate ? 'Click “Generate key / new license” to create the first one.' : ''}
              </Empty>
            ) : (
              <>
                <div className="overflow-x-auto">
                  <table className="tbl">
                    <thead>
                      <tr>
                        <th>Business / customer</th>
                        <th>License key</th>
                        <th>Plan</th>
                        <th>Computers</th>
                        <th>Firms / users</th>
                        <th>Expiry</th>
                        {billing && <th>Payment</th>}
                        <th>Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {paged.rows.map((l) => {
                        const c = clientById.get(l.clientId)
                        const d = daysUntil(l.expiresAt)
                        return (
                          <tr key={l.id} className="click" onClick={() => nav(`/licenses/${l.id}`)}>
                            <td>
                              <div className="font-semibold">{l.businessName || l.customerName}</div>
                              <div className="text-[12px] text-[#7a6d92]">
                                {c ? (
                                  <span className="mr-1 rounded bg-[#f1e9fb] px-1 font-semibold text-[#3d096d]">{c.code}</span>
                                ) : l.clientId ? null : can('clients.view') ? (
                                  <span className="mr-1 text-amber-700">no client ·</span>
                                ) : null}
                                {[l.customerName, l.phone, l.city].filter(Boolean).join(' · ')}
                              </div>
                            </td>
                            <td>
                              <MaskedKey value={l.licenseKey} />
                            </td>
                            <td>
                              <div className="capitalize">{l.plan}</div>
                              <Pill value={l.planType} />
                            </td>
                            <td>
                              {l.activeDevices} / {l.maxDevices}
                            </td>
                            <td>
                              {l.maxFirms} / {l.maxUsers}
                            </td>
                            <td className="whitespace-nowrap">
                              {expiryLabel(l)}
                              {d !== null && d >= 0 && d <= 30 && <div className="text-[11.5px] font-semibold text-amber-700">in {d} day(s)</div>}
                            </td>
                            {billing && (
                              <td>
                                <Pill value={paymentStatusFromInvoices(invByLicense.get(l.id) ?? [])} label={invByLicense.get(l.id)?.length ? undefined : 'no invoice'} />
                              </td>
                            )}
                            <td>
                              <Pill value={licenseDisplayStatus(l)} />
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
                <Pager {...paged} />
              </>
            )}
          </Panel>
        </>
      )}
      <TrialDialog open={trial} clients={clients.data} onClose={() => setTrial(false)} onIssued={(id, key) => setCreated({ id, key })} />
      <LicenseForm
        open={form}
        onClose={() => setForm(false)}
        onSaved={(id, info) => {
          if (info.licenseKey) setCreated({ id, key: info.licenseKey, client: info.client })
        }}
      />
    </div>
  )
}
