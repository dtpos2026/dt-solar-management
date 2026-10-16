/**
 * License detail: key + id, client, plan, status, limits, lifecycle actions (with reason + history + audit),
 * certificates, assigned computers with heartbeat (version, last verification, location with its source),
 * pending activation requests and the lazily loaded, paginated history.
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { getDocs, onSnapshot, query, where } from 'firebase/firestore'
import { ArrowLeft, Ban, CalendarClock, Copy, Download, FileSignature, Link2, Pause, Pencil, Play, Unplug, UserPlus } from 'lucide-react'
import { Field, PageTitle, Stat, copy, download } from '../components/ui'
import {
  changeTerms, detachLicense, deviceFromSnap, devicesCol, expiryLabel, licenseFromSnap,
  licenseRef, licenseStatusRef, linkLicenseClient, republishStatus, requestFromSnap, requestsCol, setDeviceState, setLicenseState, type DeviceAction, type TermsChange
} from '../lib/licenses'
import { certTermsOf, issueForDevice, publishCertificates, type PublishedCert } from '../lib/approve'
import { clientFromLicense, PLAN_TYPE_LABEL, PLAN_TYPES } from '../lib/clients'
import { certificateFreshness, deviceLimitGuard, detachEligibility, suggestRenewal } from '../lib/terms'
import { latestHeartbeats, slotsUsed as slotsUsedOf } from '../lib/devices'
import { heartbeatLike, loadHeartbeatsForLicenses } from '../lib/fleet'
import { maskDeviceId } from '../lib/terms'
import { paymentStatusFromInvoices } from '../lib/stats'
import { useAdminEmail, useCan } from '../lib/auth'
import { useSigningKey } from '../lib/signingKey'
import { errorMessage, fmtDate, fmtDateTime, fromInputDate, timeAgo, toInputDate } from '../lib/format'
import { PAID_PLANS, PLAN_PRESETS, type ActivationRequest, type Device, type Heartbeat, type License, type Plan, type PlanType } from '../lib/types'
import { ConfirmDialog, Empty, Loading, Notice, Panel, Pill, type ConfirmOptions, type NoticeMsg } from './licensing/kit'
import { BILLING_READ_PERMS, HEARTBEAT_READ_PERMS, useClients, useInvoices } from './licensing/hooks'
import { HistoryPanel } from './licenses/HistoryPanel'
import { LocationLine } from './licenses/parts'
import { LicenseForm } from './LicenseForm'
import { ClientForm } from './licensing/ClientForm'
import { licenseDisplayStatus } from './Licenses'

type Dlg =
  | { k: 'state'; to: 'active' | 'suspended' | 'revoked' }
  | { k: 'renew' }
  | { k: 'plan' }
  | { k: 'firms' }
  | { k: 'devices' }
  | { k: 'poweredBy' }
  | { k: 'detach' }
  | { k: 'publish' }
  | { k: 'device'; d: Device; action: DeviceAction }
  | { k: 'link' }

export function LicenseDetail() {
  const { id = '' } = useParams()
  const nav = useNavigate()
  const by = useAdminEmail()
  const can = useCan()
  const { key } = useSigningKey()
  const [l, setL] = useState<License | null | undefined>(undefined)
  const [devices, setDevices] = useState<Device[]>([])
  const [heartbeats, setHeartbeats] = useState<Heartbeat[] | null>(null)
  const [requests, setRequests] = useState<ActivationRequest[]>([])
  const [published, setPublished] = useState<Record<string, unknown> | null>(null)
  const [edit, setEdit] = useState(false)
  const [clientForm, setClientForm] = useState(false)
  const [msg, setMsg] = useState<NoticeMsg | null>(null)
  const [dlg, setDlg] = useState<Dlg | null>(null)
  const [certs, setCerts] = useState<PublishedCert[]>([])
  // dialog fields
  const [fExpiry, setFExpiry] = useState('')
  const [fPlanType, setFPlanType] = useState<PlanType>('yearly')
  const [fPlan, setFPlan] = useState<Plan>('standard')
  const [fNum, setFNum] = useState(1)
  const [fBool, setFBool] = useState(true)
  const [fClient, setFClient] = useState('')

  const manage = can('licenses.manage')
  const devManage = can('devices.manage')
  const clients = useClients(can('clients.view'))
  const invoices = useInvoices(BILLING_READ_PERMS.some(can), { field: 'licenseId', value: id })

  useEffect(() => {
    const a = onSnapshot(licenseRef(id), (s) => setL(s.exists() ? licenseFromSnap(s) : null), (e) => { setL(null); setMsg({ tone: 'error', text: errorMessage(e) }) })
    const b = onSnapshot(devicesCol(id), (s) => setDevices(s.docs.map(deviceFromSnap)), () => setDevices([]))
    const d = onSnapshot(licenseStatusRef(id), (s) => setPublished((s.data()?.certs as Record<string, unknown>) ?? null), () => setPublished(null))
    return () => { a(); b(); d() }
  }, [id])
  // Every change of the license or its computers bumps updatedAt: reload the per-license reads then.
  const ver = l?.updatedAt?.toMillis() ?? 0

  // Heartbeats of this license only (one query) — version, last verification, last seen, consented location.
  const canHb = HEARTBEAT_READ_PERMS.some(can)
  useEffect(() => {
    if (!canHb) return setHeartbeats(null)
    let alive = true
    loadHeartbeatsForLicenses([id]).then((h) => alive && setHeartbeats(h), () => alive && setHeartbeats(null))
    return () => { alive = false }
  }, [id, canHb, ver])
  const hbByDevice = useMemo(() => latestHeartbeats((heartbeats ?? []).map(heartbeatLike)), [heartbeats])

  // Pending activation requests for this key (approval status of computers not registered yet).
  const canReq = can('devices.manage') || can('licenses.manage')
  const licKey = l?.licenseKey ?? ''
  useEffect(() => {
    if (!canReq || !licKey) return setRequests([])
    let alive = true
    getDocs(query(requestsCol(), where('licenseKey', '==', licKey)))
      .then((s) => alive && setRequests(s.docs.map(requestFromSnap).filter((r) => r.status === 'pending')), () => alive && setRequests([]))
    return () => { alive = false }
  }, [canReq, licKey, ver])

  const fresh = useMemo(() => (l ? certificateFreshness(certTermsOf(l), devices.filter((d) => d.status === 'active').map((d) => d.deviceId), published) : []), [l, devices, published])
  const client = l ? clients.data.find((c) => c.id === l.clientId) ?? null : null

  if (l === undefined) return <Loading />
  if (l === null) return <Empty title="License not found">{msg && <Notice msg={msg} />}<Link className="text-[#3d096d] underline" to="/licenses">Back to licenses</Link></Empty>
  const lic = l

  /** After a change of terms: re-sign + publish certificates when the key is loaded, otherwise warn. */
  const afterTerms = async (reason: string, okText: string) => {
    if (!lic.activeDevices && !devices.some((d) => d.status === 'active')) return setMsg({ tone: 'success', text: okText })
    if (!key) return setMsg({ tone: 'warn', text: <>{okText} No signing key is loaded, so the certificates of the active computers still carry the old terms. Load the key on the <Link className="underline" to="/key">Signing key</Link> page and click “Publish certificates”.</> })
    const r = await publishCertificates(lic.id, key, by, reason)
    setCerts(r.certs)
    setMsg({ tone: 'success', text: `${okText} ${r.certs.length} certificate(s) re-signed and published.` })
  }
  const terms = async (c: TermsChange, reason: string, okText: string) => {
    await changeTerms(lic.id, c, reason, by)
    await afterTerms(reason || okText, okText)
  }

  const open = (d: Dlg) => {
    // A trial is converted to a paid plan by Renew / Change plan (trial is not offered there).
    const pt: PlanType = lic.planType === 'trial' ? 'yearly' : lic.planType
    setFExpiry(toInputDate(suggestRenewal(pt, lic.planType === 'trial' ? null : lic.expiresAt?.toMillis() ?? null)))
    setFPlanType(pt)
    setFPlan(lic.plan === 'trial' ? 'standard' : lic.plan)
    setFBool(!lic.poweredBy)
    setFClient(lic.clientId)
    setFNum(d.k === 'firms' ? lic.maxFirms : lic.maxDevices)
    setDlg(d)
  }

  const slots = slotsUsedOf(devices)
  const detachEl = detachEligibility({ planType: lic.planType, expiresAtMs: lic.expiresAt?.toMillis() ?? null, status: lic.status, detached: lic.detached })
  const payStatus = invoices.data.length ? paymentStatusFromInvoices(invoices.data) : lic.paymentStatus

  const opts = ((): ConfirmOptions | null => {
    if (!dlg) return null
    switch (dlg.k) {
      case 'state': {
        const label = dlg.to === 'active' ? (lic.status === 'active' ? 'Activate' : 'Reactivate') : dlg.to === 'suspended' ? 'Suspend' : 'Revoke'
        return {
          title: `${label} license`,
          body: dlg.to === 'active' ? 'The customer’s computers become fully usable again at their next check-in.' : dlg.to === 'suspended' ? 'Computers switch to read-only at their next check-in. You can reactivate later.' : 'Revocation is meant to be permanent: every computer switches to read-only at its next check-in.',
          confirmLabel: label, tone: dlg.to === 'active' ? 'success' : 'danger', reason: true, reasonRequired: dlg.to !== 'active',
          typeToConfirm: dlg.to === 'revoked' ? 'REVOKE' : undefined,
          run: async (reason) => { await setLicenseState(lic, dlg.to, by, reason); setMsg({ tone: 'success', text: `License ${dlg.to === 'active' ? 'activated' : dlg.to}.` }) }
        }
      }
      case 'renew':
        return {
          title: 'Renew license', confirmLabel: 'Renew', reason: true,
          body: `Current expiry: ${expiryLabel(lic)}. The suggested date extends the current term by one ${lic.planType === 'monthly' ? 'month' : 'year'}.`,
          extra: (
            <div className="grid grid-cols-2 gap-3">
              <Field label="Billing cycle"><select className="input" value={fPlanType} onChange={(e) => { const p = e.target.value as PlanType; setFPlanType(p); setFExpiry(toInputDate(suggestRenewal(p, lic.expiresAt?.toMillis() ?? null))) }}>{PLAN_TYPES.map((p) => <option key={p} value={p}>{PLAN_TYPE_LABEL[p]}</option>)}</select></Field>
              <Field label="New expiry">{fPlanType === 'lifetime' ? <div className="input flex items-center text-[#7a6d92]">No expiry (lifetime)</div> : <input type="date" className="input" value={fExpiry} onChange={(e) => setFExpiry(e.target.value)} />}</Field>
            </div>
          ),
          run: async (reason) => {
            const exp = fPlanType === 'lifetime' ? null : fromInputDate(fExpiry)
            if (fPlanType !== 'lifetime' && !exp) throw new Error('Choose the new expiry date.')
            await terms({ kind: 'renew', planType: fPlanType, expiresAt: exp }, reason, 'License renewed.')
          }
        }
      case 'plan':
        return {
          title: 'Change plan', confirmLabel: 'Change plan', reason: true,
          body: 'Applies the plan’s firm, computer and user limits and features. The device limit cannot drop below the computers holding a slot.',
          extra: (
            <div className="grid grid-cols-2 gap-3">
              <Field label="Plan"><select className="input" value={fPlan} onChange={(e) => setFPlan(e.target.value as Plan)}>{(PAID_PLANS as Plan[]).map((p) => <option key={p} value={p}>{PLAN_PRESETS[p].label}</option>)}</select></Field>
              <Field label="Billing cycle"><select className="input" value={fPlanType} onChange={(e) => setFPlanType(e.target.value as PlanType)}>{PLAN_TYPES.map((p) => <option key={p} value={p}>{PLAN_TYPE_LABEL[p]}</option>)}</select></Field>
              <div className="col-span-2 text-[12px] text-[#7a6d92]">{PLAN_PRESETS[fPlan].maxFirms} firm(s) · {PLAN_PRESETS[fPlan].maxDevices} computer(s) · {PLAN_PRESETS[fPlan].maxUsers} user(s)</div>
            </div>
          ),
          run: async (reason) => {
            const p = PLAN_PRESETS[fPlan]
            const planChanged = fPlanType !== lic.planType
            const exp = planChanged ? (fPlanType === 'lifetime' ? null : suggestRenewal(fPlanType, null)) : undefined
            await terms({ kind: 'plan', plan: fPlan, planType: fPlanType, expiresAt: exp, maxFirms: p.maxFirms, maxDevices: Math.max(p.maxDevices, slots), maxUsers: p.maxUsers, features: p.features }, reason, 'Plan changed.')
          }
        }
      case 'firms':
      case 'devices': {
        const isDev = dlg.k === 'devices'
        const g = isDev ? deviceLimitGuard(fNum, slots) : { ok: fNum >= 1, reason: 'At least 1 firm.' }
        return {
          title: isDev ? 'Change computer limit' : 'Change firm limit', confirmLabel: 'Save limit', reason: true,
          body: isDev ? `${slots} computer(s) currently hold a slot. Release computers first to go below that.` : undefined,
          extra: (
            <Field label={isDev ? 'Max computers' : 'Max firms'} hint={!g.ok ? <span className="text-red-600">{g.reason}</span> : undefined}>
              <input type="number" min={1} className="input" value={fNum} onChange={(e) => setFNum(Number(e.target.value))} />
            </Field>
          ),
          run: async (reason) => {
            if (!g.ok) throw new Error(g.reason)
            await terms(isDev ? { kind: 'devices', maxDevices: fNum } : { kind: 'firms', maxFirms: fNum }, reason, 'Limit changed.')
          }
        }
      }
      case 'poweredBy':
        return {
          title: fBool ? 'Show “Powered by Digital Target”' : 'Hide “Powered by Digital Target”', confirmLabel: 'Save', reason: true,
          body: 'Controls the footer line on the customer’s printed documents. Takes effect when the new certificate is installed.',
          run: async (reason) => terms({ kind: 'poweredBy', poweredBy: fBool }, reason, 'Branding setting changed.')
        }
      case 'detach':
        return {
          title: 'Detach lifetime license', confirmLabel: 'Detach permanently', tone: 'danger', reason: true, reasonRequired: true, typeToConfirm: 'DETACH',
          body: (
            <ul className="list-disc space-y-1 pl-5 text-[13px]">
              <li>The installation stops checking in: it can <b>never again be suspended or revoked remotely</b>.</li>
              <li>Certificates are re-signed with <code>detached: true</code> and no check-in, then published for the {devices.filter((d) => d.status === 'active').length} active computer(s).</li>
              <li>Support and updates are separate entitlements and are not part of the detachment.</li>
              <li>Hand the .dtlic files to the customer for offline installation (download offered afterwards).</li>
            </ul>
          ),
          run: async (reason) => {
            if (!key) throw new Error('Load the signing key first — detached certificates must be signed now.')
            await detachLicense(lic.id, reason, by)
            const r = await publishCertificates(lic.id, key, by, `detached: ${reason}`)
            setCerts(r.certs)
            setMsg({ tone: 'success', text: `License detached. ${r.certs.length} detached certificate(s) published — download them below for the offline hand-over.` })
          }
        }
      case 'publish':
        return {
          title: 'Publish certificates', confirmLabel: 'Sign & publish',
          body: 'Re-signs a certificate for every active computer with the loaded key and publishes it; the desktop installs it at its next check-in.',
          run: async (reason) => {
            if (!key) throw new Error('No signing key loaded.')
            const r = await publishCertificates(lic.id, key, by, reason || 'manual publish')
            setCerts(r.certs)
            setMsg({ tone: 'success', text: `${r.certs.length} certificate(s) published.` })
          }
        }
      case 'device': {
        const { d, action } = dlg
        const label = { suspend: 'Suspend', revoke: 'Revoke', release: 'Release', reactivate: 'Reactivate' }[action]
        return {
          title: `${label} computer “${d.deviceName || d.deviceId}”`, confirmLabel: label, tone: action === 'reactivate' ? 'success' : 'danger', reason: true,
          reasonRequired: action === 'revoke', reasonLabel: 'Note',
          body: action === 'release' ? 'The computer switches to read-only and its slot is freed for another computer.' : action === 'reactivate' ? 'The computer becomes usable again (a released computer needs a free slot).' : 'The computer switches to read-only at its next check-in but keeps its slot.',
          run: async (note) => {
            await setDeviceState(lic.id, d.deviceId, action, note, by)
            if (action === 'reactivate' && key) {
              const r = await publishCertificates(lic.id, key, by, `computer ${d.deviceName || 'Device'} (${maskDeviceId(d.deviceId)}) reactivated`)
              setCerts(r.certs)
            }
            setMsg({ tone: action === 'reactivate' && !key ? 'warn' : 'success', text: `Computer ${label.toLowerCase()}d.${action === 'reactivate' && !key ? ' Load the signing key and publish certificates so it receives a current certificate.' : ''}` })
          }
        }
      }
      case 'link':
        return {
          title: 'Link to client', confirmLabel: 'Save link',
          extra: (
            <Field label="Client">
              <select className="input" value={fClient} onChange={(e) => setFClient(e.target.value)}>
                <option value="">— No client —</option>
                {clients.data.filter((c) => c.status !== 'archived' || c.id === lic.clientId).map((c) => <option key={c.id} value={c.id}>{c.code} · {c.company}</option>)}
              </select>
            </Field>
          ),
          run: async () => {
            const c = clients.data.find((x) => x.id === fClient)
            await linkLicenseClient(lic, fClient, c ? `${c.code} ${c.company}` : '', by)
            setMsg({ tone: 'success', text: fClient ? 'License linked to the client.' : 'License unlinked.' })
          }
        }
    }
  })()

  const issue = async (d: Device) => {
    if (!key) return setMsg({ tone: 'warn', text: 'Load the signing key first.' })
    try {
      const r = await issueForDevice(lic.licenseKey, { deviceId: d.deviceId, deviceName: d.deviceName, os: d.os, appVersion: d.appVersion }, key, by, d.activationType)
      download(`${(lic.businessName || lic.customerName || 'license').replace(/[^\w-]+/g, '_')}-${d.deviceId.slice(0, 8)}.dtlic`, r.cert.fileContents)
      setMsg({ tone: 'success', text: 'Certificate issued and downloaded.' })
    } catch (e) {
      setMsg({ tone: 'error', text: errorMessage(e) })
    }
  }

  const st = licenseDisplayStatus(lic)
  const btn = (show: boolean, label: string, icon: ReactNode, d: Dlg, cls = 'btn-secondary') => show && <button className={`btn btn-sm ${cls}`} onClick={() => open(d)}>{icon}{label}</button>
  const outdated = fresh.filter((f) => f.state !== 'current').length

  return (
    <div>
      <button className="mb-3 flex items-center gap-1 text-[13px] text-[#6b5d85] hover:underline" onClick={() => nav('/licenses')}><ArrowLeft className="h-4 w-4" />All licenses</button>
      <PageTitle
        title={lic.businessName || lic.customerName || 'License'}
        sub={`${lic.customerName}${lic.city ? ` · ${lic.city}` : ''}${lic.phone ? ` · ${lic.phone}` : ''}`}
        actions={manage && <button className="btn btn-secondary" onClick={() => setEdit(true)}><Pencil className="h-4 w-4" />Edit</button>}
      />
      <Notice msg={msg} onClose={() => setMsg(null)} className="mb-4" />

      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-5">
        <Stat label="Status" value={<Pill value={st} />} />
        <Stat label="Plan" value={<span className="text-[15px]">{PLAN_PRESETS[lic.plan]?.label ?? lic.plan} · {PLAN_TYPE_LABEL[lic.planType]}</span>} />
        <Stat label="Expiry" value={<span className="text-[15px]">{expiryLabel(lic)}</span>} />
        <Stat label="Computers" value={`${slots} / ${lic.maxDevices}`} />
        <Stat label="Payment" value={<Pill value={payStatus} label={payStatus === 'none' ? 'no invoice' : payStatus} />} />
      </div>

      <Panel
        className="mb-4"
        title="License key"
        actions={<button className="btn btn-sm btn-secondary" onClick={() => copy(lic.licenseKey)}><Copy className="h-4 w-4" />Copy</button>}
      >
        <div className="grid gap-x-6 gap-y-2 px-4 py-3 text-[13px] md:grid-cols-3">
          <div><span className="text-[#7a6d92]">Key: </span><code className="font-bold">{lic.licenseKey}</code></div>
          <div className="flex items-center gap-1"><span className="text-[#7a6d92]">License id: </span><code>{lic.id}</code><button className="rounded p-0.5 text-[#7a6d92] hover:text-[#3d096d]" title="Copy license id" aria-label="Copy license id" onClick={() => copy(lic.id)}><Copy className="h-3.5 w-3.5" /></button></div>
          <div><span className="text-[#7a6d92]">Product / plan: </span>DT Solar Pro · {PLAN_PRESETS[lic.plan]?.label ?? lic.plan} · {PLAN_TYPE_LABEL[lic.planType]}</div>
          <div><span className="text-[#7a6d92]">Device limit: </span>{lic.maxDevices} computer(s) · new computers need approval</div>
          <div><span className="text-[#7a6d92]">Firms: </span>{lic.maxFirms} · <span className="text-[#7a6d92]">Users: </span>{lic.maxUsers}</div>
          <div><span className="text-[#7a6d92]">Check-in: </span>{lic.detached ? 'none (detached)' : `every ${lic.checkinDays} d, grace ${lic.graceDays} d`}</div>
          <div><span className="text-[#7a6d92]">Powered by line: </span>{lic.poweredBy ? 'shown' : 'hidden'}</div>
          <div><span className="text-[#7a6d92]">Created: </span>{fmtDateTime(lic.createdAt)}</div>
          <div><span className="text-[#7a6d92]">First activation: </span>{fmtDateTime(lic.activatedAt)}</div>
          <div>
            <span className="text-[#7a6d92]">Client: </span>
            {client ? <Link className="font-semibold text-[#3d096d] underline" to={`/clients/${client.id}`}>{client.code} · {client.company}</Link> : lic.clientId ? <code>{lic.clientId}</code> : 'not linked'}
          </div>
          {lic.detached && <div className="md:col-span-2"><span className="text-[#7a6d92]">Detached: </span>{fmtDateTime(lic.detachedAt)} by {lic.detachedBy}</div>}
          {lic.notes && <div className="md:col-span-3"><span className="text-[#7a6d92]">Notes: </span>{lic.notes}</div>}
        </div>
        {manage && (
          <div className="flex flex-wrap gap-2 border-t border-[#ece6f4] px-4 py-3">
            {btn(lic.status !== 'active', lic.status === 'revoked' ? 'Reactivate' : 'Activate', <Play className="h-4 w-4" />, { k: 'state', to: 'active' })}
            {btn(lic.status === 'active' && !lic.detached, 'Suspend', <Pause className="h-4 w-4" />, { k: 'state', to: 'suspended' })}
            {btn(lic.status !== 'revoked' && !lic.detached, 'Revoke', <Ban className="h-4 w-4" />, { k: 'state', to: 'revoked' })}
            {btn(!lic.detached && lic.status !== 'revoked', 'Renew', <CalendarClock className="h-4 w-4" />, { k: 'renew' })}
            {btn(!lic.detached && lic.status !== 'revoked', 'Change plan', null, { k: 'plan' })}
            {btn(lic.status !== 'revoked', 'Firm limit', null, { k: 'firms' })}
            {btn(lic.status !== 'revoked', 'Computer limit', null, { k: 'devices' })}
            {btn(lic.status !== 'revoked', lic.poweredBy ? 'Hide “Powered by”' : 'Show “Powered by”', null, { k: 'poweredBy' })}
            {can('clients.view') && btn(true, 'Link client', <Link2 className="h-4 w-4" />, { k: 'link' })}
            {!lic.clientId && can('clients.manage') && <button className="btn btn-sm btn-secondary" onClick={() => setClientForm(true)}><UserPlus className="h-4 w-4" />Create client from license</button>}
            {detachEl.ok && <button className="btn btn-sm btn-danger" disabled={!key} title={key ? '' : 'Load the signing key first'} onClick={() => open({ k: 'detach' })}><Unplug className="h-4 w-4" />Detach (lifetime)</button>}
            <button className="btn btn-sm btn-secondary" onClick={() => republishStatus(lic, by).then(() => setMsg({ tone: 'success', text: 'Status re-published.' }), (e) => setMsg({ tone: 'error', text: errorMessage(e) }))}>Re-publish status</button>
          </div>
        )}
      </Panel>

      <Panel
        className="mb-4"
        title="Certificates"
        sub={fresh.length ? (outdated ? `${outdated} of ${fresh.length} active computer(s) need a new certificate` : 'All active computers have a current certificate') : 'No active computers'}
        actions={(manage || devManage) && fresh.length > 0 && <button className="btn btn-sm btn-primary" disabled={!key} title={key ? '' : 'Load the signing key first'} onClick={() => open({ k: 'publish' })}><FileSignature className="h-4 w-4" />Publish certificates</button>}
      >
        {!key && outdated > 0 && <div className="px-4 py-2 text-[13px] text-amber-700">No signing key loaded — load it on the <Link className="underline" to="/key">Signing key</Link> page to publish.</div>}
        {fresh.length > 0 && (
          <table className="w-full text-[13px]">
            <tbody>
              {fresh.map((f) => (
                <tr key={f.deviceId} className="border-t border-[#f1ecf7]">
                  <td className="px-4 py-2"><code title={f.deviceId}>{devices.find((d) => d.deviceId === f.deviceId)?.deviceName || 'Device'} · {maskDeviceId(f.deviceId)}</code></td>
                  <td className="px-4 py-2"><Pill value={f.state === 'current' ? 'active' : f.state === 'missing' ? 'pending' : 'expired'} label={f.state} /></td>
                  <td className="px-4 py-2 text-[#7a6d92]">{f.diff.length ? `differs: ${f.diff.join(', ')}` : f.issuedAt ? `issued ${fmtDateTime(f.issuedAt)}` : ''}</td>
                  <td className="px-4 py-2 text-right">
                    {certs.find((c) => c.deviceId === f.deviceId) && (
                      <button className="btn btn-sm btn-secondary" onClick={() => { const c = certs.find((x) => x.deviceId === f.deviceId)!; download(c.fileName, c.fileContents) }}><Download className="h-4 w-4" />.dtlic</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>

      <Panel className="mb-4" title={`Computers (${devices.length})`} sub={`${slots} of ${lic.maxDevices} slot(s) used — active, suspended and revoked computers hold a slot; released ones do not`}>
        {devices.length === 0 ? <Empty title="No computer activated yet" /> : (
          <div className="overflow-x-auto">
            <table className="w-full text-[13px]">
              <thead className="text-left text-[12px] text-[#7a6d92]"><tr><th className="px-4 py-2">Computer</th><th className="px-4 py-2">Windows · app version</th><th className="px-4 py-2">Activated</th><th className="px-4 py-2">Last verification</th><th className="px-4 py-2">Last known location</th><th className="px-4 py-2">Approval / status</th><th className="px-4 py-2" /></tr></thead>
              <tbody>
                {devices.map((d) => {
                  const hb = hbByDevice.get(d.deviceId)
                  return (
                  <tr key={d.deviceId} className="border-t border-[#f1ecf7] align-top">
                    <td className="px-4 py-2"><div className="font-semibold">{d.deviceName || '—'}</div><code className="text-[11px] text-[#7a6d92]" title={d.deviceId}>{maskDeviceId(d.deviceId)}</code><button className="ml-1 rounded p-0.5 text-[#7a6d92] hover:text-[#3d096d]" title="Copy device id" aria-label="Copy device id" onClick={() => copy(d.deviceId)}><Copy className="inline h-3 w-3" /></button></td>
                    <td className="px-4 py-2">{hb?.os || d.os || '—'}<div className="text-[11.5px] text-[#7a6d92]">v{hb?.appVersion || d.appVersion || '—'}</div></td>
                    <td className="px-4 py-2">{fmtDateTime(d.activatedAt)} <div className="text-[11.5px] text-[#7a6d92]">{d.activationType}</div></td>
                    <td className="px-4 py-2">{hb?.lastCheckAt ? fmtDateTime(hb.lastCheckAt) : heartbeats === null ? <span className="text-[#9a8fb0]">not visible</span> : '—'}{hb?.lastSeenMs ? <div className="text-[11.5px] text-[#7a6d92]">seen {timeAgo(hb.lastSeenMs)}</div> : null}</td>
                    <td className="px-4 py-2 text-[12.5px]"><LocationLine loc={hb?.location ?? null} /></td>
                    <td className="px-4 py-2"><div className="text-[11.5px] text-[#7a6d92]">approved</div><Pill value={d.status} />{d.statusNote && <div className="text-[11px] text-[#7a6d92]">{d.statusNote}</div>}</td>
                    <td className="px-4 py-2 text-right">
                      <div className="flex justify-end gap-1">
                        {devManage && d.status === 'active' && <button className="btn btn-sm btn-secondary" onClick={() => issue(d)} disabled={!key}>Issue .dtlic</button>}
                        {devManage && !lic.detached && d.status === 'active' && <button className="btn btn-sm btn-secondary" onClick={() => open({ k: 'device', d, action: 'suspend' })}>Suspend</button>}
                        {devManage && !lic.detached && ['active', 'suspended'].includes(d.status) && <button className="btn btn-sm btn-secondary" onClick={() => open({ k: 'device', d, action: 'revoke' })}>Revoke</button>}
                        {devManage && d.status !== 'deactivated' && <button className="btn btn-sm btn-secondary" onClick={() => open({ k: 'device', d, action: 'release' })}>Release</button>}
                        {devManage && d.status !== 'active' && <button className="btn btn-sm btn-secondary" onClick={() => open({ k: 'device', d, action: 'reactivate' })}>Reactivate</button>}
                      </div>
                    </td>
                  </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
        {requests.length > 0 && (
          <div className="border-t border-[#ece6f4] px-4 py-3 text-[13px]">
            <b>Awaiting approval ({requests.length}):</b>{' '}
            {requests.map((r) => `${r.deviceName || 'Device'} (${maskDeviceId(r.deviceId)})`).join(', ')} —{' '}
            <Link className="font-semibold text-[#3d096d] underline" to="/licenses?tab=requests">review activation requests</Link>
          </div>
        )}
      </Panel>

      {invoices.data.length > 0 && (
        <Panel className="mb-4" title="Invoices">
          <table className="w-full text-[13px]"><tbody>
            {invoices.data.map((i) => (
              <tr key={i.id} className="border-t border-[#f1ecf7]">
                <td className="px-4 py-2"><Link className="font-semibold text-[#3d096d] underline" to={`/billing/${i.id}`}>{i.number || i.id}</Link></td>
                <td className="px-4 py-2">{fmtDate(i.issueDateMs)}</td>
                <td className="px-4 py-2"><Pill value={i.status} /></td>
                <td className="px-4 py-2 text-right">{i.total.toLocaleString()}</td>
              </tr>
            ))}
          </tbody></table>
        </Panel>
      )}

      <HistoryPanel licenseId={lic.id} refreshKey={ver} />

      <ConfirmDialog opts={opts} onClose={() => setDlg(null)} />
      {edit && <LicenseForm open license={lic} onClose={() => setEdit(false)} onSaved={async (_id, info) => { setEdit(false); if (info.certChange) await afterTerms('license edited', 'License saved.').catch((e) => setMsg({ tone: 'error', text: errorMessage(e) })); else setMsg({ tone: 'success', text: 'License saved.' }) }} />}
      {clientForm && <ClientForm open prefill={clientFromLicense(lic)} linkLicense={lic} onClose={() => setClientForm(false)} onSaved={(_cid, info) => { setClientForm(false); setMsg({ tone: 'success', text: `Client ${info.code ?? ''} created and linked.` }) }} />}
    </div>
  )
}
