/** Client detail: profile, licenses, devices, billing history, support history, activity. */
import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { getDocs, onSnapshot, query, where } from 'firebase/firestore'
import { Archive, ArrowLeft, Pause, Pencil, Play, Plus, Trash2 } from 'lucide-react'
import { PageTitle, Stat } from '../components/ui'
import { clientFromSnap, clientRef, clientLinks, deleteClient, setClientStatus } from '../lib/clientsDb'
import { auditCol, auditFromSnap, expiryLabel } from '../lib/licenses'
import { deviceInfo, heartbeatLike, licenseInfo, loadDevicesFor, loadHeartbeatsForLicenses, loadThreads, type ThreadRow } from '../lib/fleet'
import { mergeDeviceRows, type DeviceRow } from '../lib/devices'
import { hardDeleteGuard, PLAN_TYPE_LABEL } from '../lib/clients'
import { billingSummary } from '../lib/stats'
import { useAdmin, useAdminEmail, useCan } from '../lib/auth'
import { errorMessage, fmtDate, fmtDateTime, timeAgo } from '../lib/format'
import type { AuditEntry, Client } from '../lib/types'
import { ConfirmDialog, Empty, fmtMoney, Loading, Notice, Panel, Pill, type ConfirmOptions, type NoticeMsg } from './licensing/kit'
import { BILLING_READ_PERMS, HEARTBEAT_READ_PERMS, useInvoices, useLicenses } from './licensing/hooks'
import { ClientForm } from './licensing/ClientForm'
import { LicenseForm } from './LicenseForm'
import { licenseDisplayStatus } from './Licenses'

type Dlg = 'suspended' | 'active' | 'archived' | 'delete'

export function ClientDetail({ id }: { id: string }) {
  const nav = useNavigate()
  const can = useCan()
  const admin = useAdmin()
  const by = useAdminEmail()
  const [c, setC] = useState<Client | null | undefined>(undefined)
  const [msg, setMsg] = useState<NoticeMsg | null>(null)
  const [edit, setEdit] = useState(false)
  const [newLic, setNewLic] = useState(false)
  const [dlg, setDlg] = useState<Dlg | null>(null)
  const [cascade, setCascade] = useState(true)
  const [devices, setDevices] = useState<DeviceRow[] | null>(null)
  const [threads, setThreads] = useState<ThreadRow[] | null>(null)
  const [activity, setActivity] = useState<AuditEntry[] | null>(null)
  const allLicenses = useLicenses()
  const licenses = useMemo(() => allLicenses.data.filter((l) => l.clientId === id), [allLicenses.data, id])
  const licKey = licenses.map((l) => l.id).join(',')
  const billing = BILLING_READ_PERMS.some(can)
  const invoices = useInvoices(billing, { field: 'clientId', value: id })
  const manage = can('clients.manage')

  useEffect(() => onSnapshot(clientRef(id), (s) => setC(s.exists() ? clientFromSnap(s) : null), (e) => { setC(null); setMsg({ tone: 'error', text: errorMessage(e) }) }), [id])

  useEffect(() => {
    if (allLicenses.loading) return
    let alive = true
    ;(async () => {
      const devs = await loadDevicesFor(licenses)
      const hbs = HEARTBEAT_READ_PERMS.some(can) && licenses.length ? await loadHeartbeatsForLicenses(licenses.map((l) => l.id)) : []
      const byLic: Record<string, ReturnType<typeof deviceInfo>[]> = {}
      for (const [k, v] of Object.entries(devs)) byLic[k] = v.map(deviceInfo)
      if (alive) setDevices(mergeDeviceRows(licenses.map(licenseInfo), byLic, hbs.map(heartbeatLike)))
    })().catch(() => alive && setDevices([]))
    if (can('support.manage')) loadThreads(licenses.map((l) => l.id)).then((t) => alive && setThreads(licenses.length ? t : []), () => alive && setThreads([]))
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [licKey, allLicenses.loading])

  useEffect(() => {
    if (!can('audit.view')) return
    getDocs(query(auditCol(), where('target', '==', id)))
      .then((s) => setActivity(s.docs.map(auditFromSnap).sort((a, b) => (b.at?.toMillis() ?? 0) - (a.at?.toMillis() ?? 0)).slice(0, 50)))
      .catch(() => setActivity([]))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id])

  const sum = useMemo(() => billingSummary(invoices.data, null), [invoices.data])

  if (c === undefined) return <Loading />
  if (c === null) return <Empty title="Client not found">{msg && <Notice msg={msg} />}<Link className="underline" to="/clients">Back to clients</Link></Empty>
  const client = c

  const opts: ConfirmOptions | null = !dlg ? null : dlg === 'delete'
    ? {
        title: `Delete ${client.code} permanently`, confirmLabel: 'Delete', tone: 'danger', typeToConfirm: 'DELETE',
        body: 'Only possible when no license, invoice or support thread links to this client. Prefer archiving.',
        run: async () => {
          const links = await clientLinks(client.id, licenses.map((l) => l.id), { invoices: billing, threads: can('support.manage') })
          const g = hardDeleteGuard({ isOwner: !!admin?.isOwner, linkedLicenses: links.licenses, linkedInvoices: links.invoices, linkedThreads: links.threads })
          if (!g.ok) throw new Error(g.reason)
          await deleteClient(client, by, !!admin?.isOwner)
          nav('/clients')
        }
      }
    : {
        title: dlg === 'active' ? 'Reactivate client' : dlg === 'suspended' ? 'Suspend client' : 'Archive client',
        confirmLabel: dlg === 'active' ? 'Reactivate' : dlg === 'suspended' ? 'Suspend' : 'Archive',
        tone: dlg === 'active' ? 'success' : 'danger', reason: true, reasonRequired: dlg !== 'active',
        body: dlg === 'archived' ? 'Archived clients are hidden from the default list; records and links are kept.' : undefined,
        extra: dlg !== 'archived' && can('licenses.manage') && licenses.length > 0 && (
          <label className="flex items-center gap-2 text-[13px]">
            <input type="checkbox" checked={cascade} onChange={(e) => setCascade(e.target.checked)} />
            Also {dlg === 'active' ? 'reactivate suspended' : 'suspend active'} licenses of this client (detached licenses are never touched)
          </label>
        ),
        run: async (reason) => {
          const n = await setClientStatus(client, dlg, reason, by, cascade && dlg !== 'archived' && can('licenses.manage') ? licenses : [])
          setMsg({ tone: 'success', text: `Client ${dlg === 'active' ? 'reactivated' : dlg}.${n ? ` ${n} license(s) updated.` : ''}` })
        }
      }

  return (
    <div>
      <button className="mb-3 flex items-center gap-1 text-[13px] text-[#6b5d85] hover:underline" onClick={() => nav('/clients')}><ArrowLeft className="h-4 w-4" />All clients</button>
      <PageTitle
        title={`${client.company}`}
        sub={`${client.code} · ${client.ownerName}${client.city ? ` · ${client.city}` : ''}`}
        actions={manage && <>
          <button className="btn btn-secondary" onClick={() => setEdit(true)}><Pencil className="h-4 w-4" />Edit</button>
          {client.status === 'active' && <button className="btn btn-secondary" onClick={() => setDlg('suspended')}><Pause className="h-4 w-4" />Suspend</button>}
          {client.status !== 'active' && <button className="btn btn-secondary" onClick={() => setDlg('active')}><Play className="h-4 w-4" />Reactivate</button>}
          {client.status !== 'archived' && <button className="btn btn-secondary" onClick={() => setDlg('archived')}><Archive className="h-4 w-4" />Archive</button>}
          {admin?.isOwner && <button className="btn btn-danger" onClick={() => setDlg('delete')}><Trash2 className="h-4 w-4" />Delete</button>}
        </>}
      />
      <Notice msg={msg} onClose={() => setMsg(null)} className="mb-4" />
      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-5">
        <Stat label="Status" value={<Pill value={client.status} />} />
        <Stat label="Licenses" value={licenses.length} />
        <Stat label="Computers" value={devices ? devices.filter((d) => d.deviceStatus === 'active').length : '—'} />
        <Stat label="Invoiced" value={billing ? fmtMoney(sum.sales) : '—'} />
        <Stat label="Outstanding" value={billing ? fmtMoney(sum.outstanding) : '—'} />
      </div>

      <div className="mb-4 grid gap-4 lg:grid-cols-[1fr_2fr]">
        <Panel title="Profile">
          <div className="space-y-1.5 px-4 py-3 text-[13px]">
            {client.logo && <img src={client.logo} alt="logo" className="mb-2 h-16 max-w-[200px] object-contain" />}
            {([['Owner', client.ownerName], ['Phone', client.phone], ['Email', client.email], ['Address', client.address], ['City', client.city], ['Plan', `${client.plan || '—'} · ${PLAN_TYPE_LABEL[client.planType]}`], ['Allowed firms', client.allowedFirms], ['Allowed computers', client.allowedDevices], ['Registered', fmtDate(client.registeredAt)], ['Created', `${fmtDateTime(client.createdAt)}${client.createdBy ? ` by ${client.createdBy}` : ''}`]] as [string, unknown][]).map(([k, v]) => (
              <div key={k} className="flex gap-2"><span className="w-32 shrink-0 text-[#7a6d92]">{k}</span><span>{String(v || '—')}</span></div>
            ))}
            {client.notes && <div className="pt-2 text-[#5d4f78]">{client.notes}</div>}
          </div>
        </Panel>
        <Panel title="Licenses" actions={(can('licenses.generate') || can('licenses.manage')) && client.status !== 'archived' && <button className="btn btn-sm btn-primary" onClick={() => setNewLic(true)}><Plus className="h-4 w-4" />Create license</button>}>
          {licenses.length === 0 ? <Empty title="No license yet" /> : (
            <table className="w-full text-[13px]"><tbody>
              {licenses.map((l) => (
                <tr key={l.id} className="border-t border-[#f1ecf7] first:border-t-0">
                  <td className="px-4 py-2"><Link className="font-mono font-semibold text-[#3d096d] underline" to={`/licenses/${l.id}`}>{l.licenseKey}</Link></td>
                  <td className="px-4 py-2">{l.plan} · {PLAN_TYPE_LABEL[l.planType]}</td>
                  <td className="px-4 py-2">{expiryLabel(l)}</td>
                  <td className="px-4 py-2">{l.activeDevices}/{l.maxDevices}</td>
                  <td className="px-4 py-2"><Pill value={licenseDisplayStatus(l)} /></td>
                </tr>
              ))}
            </tbody></table>
          )}
        </Panel>
      </div>

      <Panel className="mb-4" title="Computers">
        {devices === null ? <Loading /> : devices.length === 0 ? <Empty title="No computer activated" /> : (
          <table className="w-full text-[13px]"><tbody>
            {devices.map((d) => (
              <tr key={d.key} className="border-t border-[#f1ecf7] first:border-t-0">
                <td className="px-4 py-2"><b>{d.deviceName || '—'}</b> <code className="text-[11px] text-[#7a6d92]">{d.deviceId}</code></td>
                <td className="px-4 py-2">{d.os} · {d.appVersion}</td>
                <td className="px-4 py-2"><Pill value={d.online} /> <span className="text-[11.5px] text-[#7a6d92]">{d.lastSeenMs ? timeAgo(d.lastSeenMs) : ''}</span></td>
                <td className="px-4 py-2"><Pill value={d.deviceStatus} /></td>
              </tr>
            ))}
          </tbody></table>
        )}
      </Panel>

      <div className="grid gap-4 lg:grid-cols-2">
        {billing && (
          <Panel title="Billing history" sub="Read-only — manage invoices on the Billing page">
            {invoices.loading ? <Loading /> : invoices.data.length === 0 ? <Empty title="No invoices" /> : (
              <table className="w-full text-[13px]"><tbody>
                {invoices.data.map((i) => (
                  <tr key={i.id} className="border-t border-[#f1ecf7] first:border-t-0">
                    <td className="px-4 py-2"><Link className="font-semibold text-[#3d096d] underline" to={`/billing/${i.id}`}>{i.number || i.id}</Link></td>
                    <td className="px-4 py-2">{fmtDate(i.issueDateMs)}</td>
                    <td className="px-4 py-2 text-right">{fmtMoney(i.total, i.currency || 'PKR')}</td>
                    <td className="px-4 py-2"><Pill value={i.status} /></td>
                  </tr>
                ))}
              </tbody></table>
            )}
          </Panel>
        )}
        {can('support.manage') && (
          <Panel title="Support conversations" sub="Read-only — reply on the Support page">
            {threads === null ? <Loading /> : threads.length === 0 ? <Empty title="No conversations" /> : (
              <ul className="divide-y divide-[#f1ecf7] text-[13px]">
                {threads.map((t) => (
                  <li key={t.id} className="px-4 py-2">
                    <div className="flex justify-between gap-2"><Link className="font-semibold text-[#3d096d] underline" to={`/support/${t.id}`}>{t.contactName || t.companyName || t.id}</Link><Pill value={t.status} /></div>
                    <div className="truncate text-[#5d4f78]">{t.lastMessagePreview}</div>
                    <div className="text-[11.5px] text-[#7a6d92]">{fmtDateTime(t.lastMessageAtMs)}{t.unreadByAdmin ? ' · unread' : ''}</div>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        )}
        {can('audit.view') && (
          <Panel title="Activity">
            {activity === null ? <Loading /> : activity.length === 0 ? <Empty title="No activity recorded" /> : (
              <ul className="divide-y divide-[#f1ecf7] text-[13px]">
                {activity.map((a) => (
                  <li key={a.id} className="px-4 py-2"><b>{a.action.replace(/_/g, ' ')}</b> <span className="text-[#7a6d92]">· {fmtDateTime(a.at)} · {a.by}</span><div className="text-[#5d4f78]">{a.details}</div></li>
                ))}
              </ul>
            )}
          </Panel>
        )}
      </div>

      <ConfirmDialog opts={opts} onClose={() => setDlg(null)} />
      {edit && <ClientForm open client={client} onClose={() => setEdit(false)} onSaved={() => { setEdit(false); setMsg({ tone: 'success', text: 'Client saved.' }) }} />}
      {newLic && <LicenseForm open client={client} onClose={() => setNewLic(false)} onSaved={(lid, info) => { setNewLic(false); setMsg({ tone: 'success', text: <>License <Link className="underline" to={`/licenses/${lid}`}>{info.licenseKey ?? lid}</Link> created.</> }) }} />}
    </div>
  )
}
