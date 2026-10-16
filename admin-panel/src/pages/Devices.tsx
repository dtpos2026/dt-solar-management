/** Devices: every registered computer across licenses merged with heartbeats; actions; activation requests tab. */
import { useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { Inbox, Map as MapIcon, MonitorSmartphone, RefreshCw, WifiOff } from 'lucide-react'
import { PageTitle } from '../components/ui'
import { setDeviceState, type DeviceAction } from '../lib/licenses'
import { publishCertificates } from '../lib/approve'
import { DEVICE_STATUS_LABEL, filterDeviceRows, sortDeviceRows, type DeviceFilter, type DeviceRow } from '../lib/devices'
import { countOnline, ONLINE_THRESHOLD_LABEL } from '../lib/stats'
import { useAdminEmail, useCan } from '../lib/auth'
import { useSigningKey } from '../lib/signingKey'
import { fmtDateTime, timeAgo } from '../lib/format'
import { ConfirmDialog, Empty, Loading, Notice, Pager, Panel, Pill, SearchBox, Tabs, usePaged, type ConfirmOptions, type NoticeMsg } from './licensing/kit'
import { useFleet } from './licensing/useFleet'
import { maskDeviceId, maskLicenseKey } from '../lib/terms'
import { copy } from '../components/ui'
import { Copy } from 'lucide-react'

function MaskedCopy({ value }: { value: string }) {
  return <button className="rounded p-0.5 text-[#7a6d92] hover:text-[#3d096d]" title="Copy full license key" aria-label="Copy full license key" onClick={() => copy(value)}><Copy className="h-3 w-3" /></button>
}
import { usePendingRequests } from './Licenses'
import { Requests } from './Requests'
import { Offline } from './Offline'

type Tab = 'list' | 'requests' | 'offline'
const ACTION_LABEL: Record<DeviceAction, string> = { suspend: 'Suspend', revoke: 'Revoke', release: 'Release', reactivate: 'Activate' }

export function Devices() {
  const can = useCan()
  const by = useAdminEmail()
  const { key } = useSigningKey()
  const [params, setParams] = useSearchParams()
  const tab = (['list', 'requests', 'offline'].includes(params.get('tab') ?? '') ? params.get('tab') : 'list') as Tab
  const setTab = (t: Tab) => setParams(t === 'list' ? {} : { tab: t }, { replace: true })
  const manage = can('devices.manage')
  const canRequests = manage || can('licenses.manage')
  const pending = usePendingRequests(canRequests)
  const fleet = useFleet(tab === 'list')
  const [f, setF] = useState<DeviceFilter>({ q: '', online: '', deviceStatus: '', licenseStatus: '' })
  const [msg, setMsg] = useState<NoticeMsg | null>(null)
  const [act, setAct] = useState<{ r: DeviceRow; a: DeviceAction } | null>(null)

  const list = useMemo(() => sortDeviceRows(filterDeviceRows(fleet.rows, f)), [fleet.rows, f])
  const paged = usePaged(list, 20, JSON.stringify(f))
  const counts = useMemo(() => countOnline(fleet.rows.map((r) => r.lastSeenMs), fleet.loadedAt || Date.now()), [fleet.rows, fleet.loadedAt])

  const opts: ConfirmOptions | null = act && {
    title: `${ACTION_LABEL[act.a]} “${act.r.deviceName || maskDeviceId(act.r.deviceId)}”`,
    confirmLabel: ACTION_LABEL[act.a],
    tone: act.a === 'reactivate' ? 'success' : 'danger',
    reason: true,
    reasonRequired: act.a === 'revoke',
    reasonLabel: 'Note',
    body:
      act.a === 'suspend' ? 'Deactivates the computer: it is added to the deactivated list and becomes read-only at its next check-in. It keeps its slot.'
        : act.a === 'revoke' ? 'Like suspend, with a note explaining the revocation. The computer keeps its slot until released.'
          : act.a === 'release' ? 'Deactivates the computer and frees its slot so another computer can be activated.'
            : 'Activates the computer again (a released computer needs a free slot on the license).',
    run: async (note) => {
      const r = act.r
      await setDeviceState(r.licenseId!, r.deviceId, act.a, note, by)
      let extra = ''
      if (act.a === 'reactivate') {
        if (key) extra = ` ${(await publishCertificates(r.licenseId!, key, by, `computer ${r.deviceName || 'Device'} (${maskDeviceId(r.deviceId)}) reactivated`)).certs.length} certificate(s) published.`
        else extra = ' Load the signing key and publish certificates on the license page so it gets a current certificate.'
      }
      setMsg({ tone: act.a === 'reactivate' && !key ? 'warn' : 'success', text: `${ACTION_LABEL[act.a]}: done.${extra}` })
      fleet.refresh()
    }
  }

  const sel = (k: keyof DeviceFilter, opts: [string, string][]) => (
    <select className="input w-auto" value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })}>
      {opts.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
    </select>
  )

  return (
    <div>
      <PageTitle
        title="Devices"
        sub={`Registered computers across all licenses · ${ONLINE_THRESHOLD_LABEL}`}
        actions={<>
          <Link className="btn btn-secondary" to="/map"><MapIcon className="h-4 w-4" />Map</Link>
          {tab === 'list' && <button className="btn btn-secondary" onClick={fleet.refresh} disabled={fleet.loading}><RefreshCw className="h-4 w-4" />Refresh</button>}
        </>}
      />
      <Tabs<Tab>
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'list', label: <><MonitorSmartphone className="h-4 w-4" />Devices</> },
          ...(canRequests ? [
            { id: 'requests' as Tab, label: <><Inbox className="h-4 w-4" />Activation requests{pending > 0 && <span className="ml-1 rounded-full bg-amber-400 px-1.5 text-[11px] text-[#2b0750]">{pending}</span>}</> },
            { id: 'offline' as Tab, label: <><WifiOff className="h-4 w-4" />Offline activation</> }
          ] : [])
        ]}
      />
      {tab === 'requests' && canRequests ? <Requests embedded /> : tab === 'offline' && canRequests ? <Offline embedded /> : (
        <>
          <Notice msg={msg} onClose={() => setMsg(null)} className="mb-3" />
          {fleet.error && <Notice msg={{ tone: 'error', text: fleet.error }} className="mb-3" />}
          {!fleet.heartbeats && <Notice msg={{ tone: 'info', text: 'You may not read heartbeats, so online status and last-seen times are unknown.' }} className="mb-3" />}
          <div className="mb-3 flex flex-wrap gap-2 text-[13px]">
            <Pill value="online" label={`online ${counts.online}`} />
            <Pill value="recent" label={`recent ${counts.recent}`} />
            <Pill value="offline" label={`offline ${counts.offline}`} />
            <Pill value="never" label={`no heartbeat ${counts.never}`} />
          </div>
          <Panel>
            <div className="flex flex-wrap items-center gap-2 border-b border-[#ece6f4] px-4 py-3">
              <SearchBox className="min-w-[240px] flex-1" value={f.q} onChange={(q) => setF({ ...f, q })} placeholder="Search company, computer, device id, key, OS…" />
              {sel('online', [['', 'Any connection'], ['online', 'Online'], ['recent', 'Recent'], ['offline', 'Offline'], ['never', 'No heartbeat']])}
              {sel('deviceStatus', [['', 'Any device status'], ...(['active', 'suspended', 'revoked', 'deactivated', 'unregistered'] as const).map((s) => [s, DEVICE_STATUS_LABEL[s]] as [string, string])])}
              {sel('licenseStatus', [['', 'Any license status'], ['active', 'Active'], ['pending', 'Pending'], ['suspended', 'Suspended'], ['revoked', 'Revoked'], ['expired', 'Expired'], ['detached', 'Detached'], ['none', 'No license']])}
            </div>
            {fleet.loading && !fleet.rows.length ? <Loading /> : list.length === 0 ? (
              <Empty icon={<MonitorSmartphone className="h-6 w-6" />} title={fleet.rows.length ? 'No device matches the filters' : 'No devices yet'}>Computers appear here once they activate a license or send a heartbeat.</Empty>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-[13px]">
                  <thead className="text-left text-[12px] text-[#7a6d92]">
                    <tr>
                      <th className="px-3 py-2">Computer</th><th className="px-3 py-2">Company / license</th><th className="px-3 py-2">OS · version</th>
                      <th className="px-3 py-2">Registered</th><th className="px-3 py-2">Last seen</th><th className="px-3 py-2">Last verified</th>
                      <th className="px-3 py-2">Status</th><th className="px-3 py-2" />
                    </tr>
                  </thead>
                  <tbody>
                    {paged.rows.map((r) => (
                      <tr key={r.key} className="border-t border-[#f1ecf7] align-top">
                        <td className="px-3 py-2"><div className="font-semibold">{r.deviceName || '—'}</div><code className="text-[11px] text-[#7a6d92]">{maskDeviceId(r.deviceId)}</code></td>
                        <td className="px-3 py-2">
                          <div>{r.company || '—'}</div>
                          {r.licenseId ? <span className="flex items-center gap-1"><Link className="text-[11.5px] text-[#3d096d] underline" to={`/licenses/${r.licenseId}`}>{r.licenseKey ? maskLicenseKey(r.licenseKey) : 'license'}</Link>{r.licenseKey && <MaskedCopy value={r.licenseKey} />}</span> : <span className="text-[11.5px] text-[#7a6d92]">no license</span>}
                        </td>
                        <td className="px-3 py-2">{r.os || '—'}<div className="text-[11.5px] text-[#7a6d92]">{r.appVersion || '—'}{r.mode ? ` · ${r.mode}` : ''}</div></td>
                        <td className="px-3 py-2">{fmtDateTime(r.registeredMs)}</td>
                        <td className="px-3 py-2"><Pill value={r.online} />{r.lastSeenMs && <div className="text-[11.5px] text-[#7a6d92]" title={fmtDateTime(r.lastSeenMs)}>{timeAgo(r.lastSeenMs)}</div>}</td>
                        <td className="px-3 py-2">{r.lastCheckAt ? fmtDateTime(r.lastCheckAt) : '—'}</td>
                        <td className="px-3 py-2">
                          <div className="flex flex-col items-start gap-1"><Pill value={r.deviceStatus} title="Device status" /><Pill value={r.licenseStatus} title="License status" label={`license: ${r.licenseStatus === 'none' ? '—' : r.licenseStatus}`} /></div>
                          {r.statusNote && <div className="text-[11px] text-[#7a6d92]">{r.statusNote}</div>}
                        </td>
                        <td className="px-3 py-2">
                          {manage && r.licenseId && r.deviceStatus !== 'unregistered' && (
                            <div className="flex flex-wrap justify-end gap-1">
                              {r.deviceStatus !== 'active' && <button className="btn btn-sm btn-success" onClick={() => setAct({ r, a: 'reactivate' })}>Activate</button>}
                              {r.deviceStatus === 'active' && r.licenseStatus !== 'detached' && <button className="btn btn-sm btn-secondary" onClick={() => setAct({ r, a: 'suspend' })}>Suspend</button>}
                              {['active', 'suspended'].includes(r.deviceStatus) && r.licenseStatus !== 'detached' && <button className="btn btn-sm btn-secondary" onClick={() => setAct({ r, a: 'revoke' })}>Revoke</button>}
                              {r.deviceStatus !== 'deactivated' && <button className="btn btn-sm btn-secondary" onClick={() => setAct({ r, a: 'release' })}>Release</button>}
                            </div>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <Pager {...paged} />
          </Panel>
        </>
      )}
      <ConfirmDialog opts={opts} onClose={() => setAct(null)} />
    </div>
  )
}
