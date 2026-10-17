/**
 * Activation requests sent by the desktop (online activation / release). Reachable as a tab of Licenses and
 * Devices and at /requests. Nothing is approved automatically: every computer needs an explicit approval by an
 * admin with devices.manage (a valid key alone never grants a slot). A computer that already holds an active slot
 * is re-issued its certificate; a new computer on a full license "needs reassignment": reject it or replace one
 * computer with it in one transaction. Approving signs the certificate in this browser (no server) and can create
 * or link the client from the registration details the desktop wizard sent.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { getDocs, limit, onSnapshot, orderBy, query, serverTimestamp, updateDoc, where } from 'firebase/firestore'
import { Building2, Check, Inbox, KeyRound, Loader2, Repeat, X } from 'lucide-react'
import { Field, Modal, PageTitle } from '../components/ui'
import { deviceFromSnap, devicesCol, findLicenseByKey, requestFromSnap, requestRef, requestsCol } from '../lib/licenses'
import { approveRequest, rejectRequest, type ApproveOutcome } from '../lib/approve'
import { loadLicenses } from '../lib/fleet'
import { classifyActivation, holdsSlot, maskDeviceId, type ActivationPlan } from '../lib/terms'
import { normaliseLicenseKey } from '../lib/crypto'
import { useSigningKey } from '../lib/signingKey'
import { useAdminEmail, useCan } from '../lib/auth'
import { fmtDateTime, errorMessage } from '../lib/format'
import { clientFromRegistration, matchClient } from '../lib/clients'
import { createClient } from '../lib/clientsDb'
import type { ActivationRequest, Device, License } from '../lib/types'
import { ConfirmDialog, Empty, Loading, Notice, Pager, Panel, Pill, shortId, usePaged, type ConfirmOptions, type NoticeMsg } from './licensing/kit'
import { useClients } from './licensing/hooks'
import { MaskedKey, ShortDevice } from './licenses/parts'

/** Pill shown for a pending activation (computed from the cached license list; the approval re-checks in a transaction). */
const PLAN_PILL: Record<ActivationPlan['kind'], { value: string; label: string }> = {
  reissue: { value: 'active', label: 're-issue (already active)' },
  new: { value: 'pending', label: 'new computer' },
  reassign: { value: 'suspended', label: 'needs reassignment' },
  invalid: { value: 'revoked', label: 'cannot approve' }
}

export function planForRequest(r: ActivationRequest, licenses: License[] | null, devices?: Device[]): ActivationPlan | null {
  if (r.type !== 'activate' || !licenses) return null
  const key = normaliseLicenseKey(r.licenseKey ?? '')
  const l = licenses.find((x) => x.licenseKey === key)
  if (!l) return { kind: 'invalid', reason: 'No license with this key' }
  let existing: string | null = null
  if (devices) existing = devices.find((d) => d.deviceId === r.deviceId)?.status ?? null
  else if (l.devicesSummary) existing = l.devicesSummary[r.deviceId]?.status ?? null
  else return null
  return classifyActivation({ status: l.status, expiresAtMs: l.expiresAt ? l.expiresAt.toMillis() : null, activeDevices: l.activeDevices, maxDevices: l.maxDevices }, existing)
}

function hasRegistration(r: ActivationRequest): boolean {
  return !!(r.companyName || r.ownerName || r.phone || r.address)
}

export function Requests({ embedded = false }: { embedded?: boolean }) {
  const can = useCan()
  const allowed = can('devices.manage') || can('licenses.manage')
  // Registering a computer needs devices.manage (also enforced by the Firestore rules).
  const canApprove = can('devices.manage')
  const [pending, setPending] = useState<ActivationRequest[]>([])
  const [done, setDone] = useState<ActivationRequest[]>([])
  const [loading, setLoading] = useState(allowed)
  const [busy, setBusy] = useState<string | null>(null)
  const [msg, setMsg] = useState<NoticeMsg | null>(null)
  const [approving, setApproving] = useState<ActivationRequest | null>(null)
  const [confirm, setConfirm] = useState<ConfirmOptions | null>(null)
  const [licenses, setLicenses] = useState<License[] | null>(null)
  const { key } = useSigningKey()
  const by = useAdminEmail()

  useEffect(() => {
    if (!allowed) return
    // Single-field query only (no composite index needed); newest first is sorted here.
    const a = onSnapshot(
      query(requestsCol(), where('status', '==', 'pending')),
      (s) => {
        setPending(s.docs.map(requestFromSnap).sort((x, y) => (y.createdAt?.toMillis() ?? 0) - (x.createdAt?.toMillis() ?? 0)))
        setLoading(false)
      },
      (e) => {
        setLoading(false)
        setMsg({ tone: 'error', text: errorMessage(e) })
      }
    )
    const b = onSnapshot(
      query(requestsCol(), orderBy('createdAt', 'desc'), limit(60)),
      (s) => setDone(s.docs.map(requestFromSnap).filter((r) => r.status !== 'pending')),
      () => undefined
    )
    return () => {
      a()
      b()
    }
  }, [allowed])

  // Licenses for the per-request outcome pill (cached list; reloaded when the pending list changes).
  const pendingKey = pending.map((r) => r.id).join(',')
  useEffect(() => {
    if (!allowed || !pending.some((r) => r.type === 'activate')) return
    let alive = true
    loadLicenses().then((l) => alive && setLicenses(l), () => alive && setLicenses(null))
    return () => {
      alive = false
    }
  }, [allowed, pendingKey]) // eslint-disable-line react-hooks/exhaustive-deps

  // A request whose computer meanwhile activated itself instantly (a slot was freed / the pass was published) needs
  // nothing more: close it so it does not wait in the queue.
  const closed = useRef(new Set<string>())
  useEffect(() => {
    if (!allowed || !licenses) return
    const byKey = new Map(licenses.map((l) => [l.licenseKey, l]))
    for (const r of pending) {
      if (r.type !== 'activate' || closed.current.has(r.id)) continue
      const l = byKey.get(normaliseLicenseKey(r.licenseKey ?? ''))
      if (l?.devicesSummary?.[r.deviceId]?.status !== 'active') continue
      closed.current.add(r.id)
      void updateDoc(requestRef(r.id), { status: 'processed', message: 'Activated instantly (valid key, free device slot).', licenseId: l.id, processedAt: serverTimestamp(), processedBy: by }).catch(() => closed.current.delete(r.id))
    }
  }, [allowed, licenses, pending, by])

  const quickApprove = async (r: ActivationRequest) => {
    if (!key) return setMsg({ tone: 'warn', text: 'Load the signing key first (Settings → Signing key).' })
    setBusy(r.id)
    const known = licenses?.find((l) => l.licenseKey === normaliseLicenseKey(r.licenseKey ?? ''))
    try {
      const res = await approveRequest(r, key, by, { ...(known ? { licenseId: known.id } : {}) })
      setMsg({ tone: res === 'rejected' ? 'warn' : 'success', text: `Request from ${r.deviceName || shortId(r.deviceId)} ${res}.` })
    } catch (e) {
      setMsg({ tone: 'error', text: errorMessage(e) })
    } finally {
      setBusy(null)
    }
  }

  const reject = (r: ActivationRequest) =>
    setConfirm({
      title: 'Reject activation request',
      body: (
        <div>
          The customer’s DT Solar Pro shows this message and stops waiting. Computer <b>{r.deviceName || maskDeviceId(r.deviceId)}</b>
          {r.licenseKey ? (
            <>
              {' '}
              · key <MaskedKey value={r.licenseKey} />
            </>
          ) : null}
          .
        </div>
      ),
      confirmLabel: 'Reject request',
      tone: 'danger',
      reason: true,
      reasonRequired: true,
      reasonLabel: 'Message to the customer',
      run: async (reason) => {
        // Recorded in the license history + activity log (license category) by rejectRequest.
        await rejectRequest(r, reason, by)
        setMsg({ tone: 'info', text: 'Request rejected.' })
      }
    })

  const paged = usePaged(done, 10)

  if (!allowed) {
    return (
      <div>
        {!embedded && <PageTitle title="Activation requests" />}
        <Panel>
          <Empty icon={<Inbox />} title="No access">
            Approving activations needs the “devices.manage” or “licenses.manage” permission.
          </Empty>
        </Panel>
      </div>
    )
  }

  return (
    <div>
      {!embedded && <PageTitle title="Activation requests" sub="Customers’ DT Solar Pro sends a request when they activate online. Approve to issue a signed license." />}
      <p className="mb-3 text-[12.5px] text-[#6b5d85]">
        Every new computer needs your explicit approval — a valid license key alone never grants access. A computer that already holds an active slot is re-issued its certificate (no new slot); a new computer on a full license needs a reassignment.
        {!canApprove && <b> Approving needs the “devices.manage” permission.</b>}
      </p>
      {!key && (
        <Notice
          msg={{
            tone: 'warn',
            text: (
              <>
                Signing key not loaded — requests cannot be approved. <Link className="font-bold underline" to="/key">Load the signing key</Link>.
              </>
            )
          }}
        />
      )}
      <Notice msg={msg} onClose={() => setMsg(null)} />
      <Panel title={`Pending (${pending.length})`} className="mb-5">
        {loading ? (
          <Loading />
        ) : pending.length === 0 ? (
          <Empty icon={<Inbox />} title="No pending requests">
            New online activations from DT Solar Pro appear here instantly.
          </Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Received</th>
                  <th>Type</th>
                  <th>License key</th>
                  <th>Computer</th>
                  <th>Registration</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {pending.map((r) => {
                  const plan = planForRequest(r, licenses)
                  return (
                  <tr key={r.id}>
                    <td className="whitespace-nowrap text-[12.5px]">{fmtDateTime(r.createdAt)}</td>
                    <td>
                      <Pill value={r.type === 'activate' ? 'active' : 'suspended'} label={r.type === 'activate' ? 'activate' : 'release'} />
                      {plan && <div className="mt-1"><Pill value={PLAN_PILL[plan.kind].value} label={PLAN_PILL[plan.kind].label} title={plan.kind === 'invalid' ? plan.reason : undefined} /></div>}
                    </td>
                    <td>{r.licenseKey ? <MaskedKey value={r.licenseKey} /> : <span className="font-mono text-[12px]">{r.licenseId ? shortId(r.licenseId) : '—'}</span>}</td>
                    <td>
                      <div className="font-semibold">{r.deviceName || '—'}</div>
                      <ShortDevice id={r.deviceId} />
                      <div className="text-[11.5px] text-[#7a6d92]">
                        {r.appVersion} · {r.os}
                      </div>
                    </td>
                    <td className="text-[12.5px]">
                      {hasRegistration(r) ? (
                        <div>
                          <div className="font-semibold">{r.companyName || '—'}</div>
                          <div className="text-[#6b5d85]">{[r.ownerName, r.phone].filter(Boolean).join(' · ')}</div>
                          {r.address && <div className="max-w-[220px] truncate text-[#7a6d92]" title={r.address}>{r.address}</div>}
                        </div>
                      ) : (
                        <span className="text-[#9a8fb0]">—</span>
                      )}
                    </td>
                    <td className="text-right">
                      {busy === r.id ? (
                        <Loader2 className="inline h-4 w-4 animate-spin" />
                      ) : (
                        <div className="flex justify-end gap-2">
                          <button
                            className="btn btn-success btn-sm"
                            disabled={!key || (r.type === 'activate' && !canApprove)}
                            title={!key ? 'Load the signing key first' : r.type === 'activate' && !canApprove ? 'Needs devices.manage' : ''}
                            onClick={() => (r.type === 'activate' ? setApproving(r) : quickApprove(r))}
                          >
                            {plan?.kind === 'reassign' ? <Repeat className="h-4 w-4" /> : <Check className="h-4 w-4" />}
                            {r.type === 'activate' ? (plan?.kind === 'reassign' ? 'Review reassignment' : 'Review & approve') : 'Process'}
                          </button>
                          <button className="btn btn-secondary btn-sm" onClick={() => reject(r)}>
                            <X className="h-4 w-4" />
                            Reject
                          </button>
                        </div>
                      )}
                    </td>
                  </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
      <Panel title="Recently processed">
        {done.length === 0 ? (
          <Empty title="Nothing processed yet" />
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Received</th>
                    <th>Type</th>
                    <th>Key</th>
                    <th>Computer</th>
                    <th>Company</th>
                    <th>Status</th>
                    <th>Message</th>
                    <th>By</th>
                  </tr>
                </thead>
                <tbody>
                  {paged.rows.map((r) => (
                    <tr key={r.id}>
                      <td className="whitespace-nowrap text-[12.5px]">{fmtDateTime(r.createdAt)}</td>
                      <td className="text-[12.5px]">{r.type === 'activate' ? 'activate' : 'release'}</td>
                      <td>{r.licenseKey ? <MaskedKey value={r.licenseKey} /> : <span className="font-mono text-[12px]">{r.licenseId ? shortId(r.licenseId) : ''}</span>}</td>
                      <td className="text-[12.5px]">{r.deviceName}</td>
                      <td className="text-[12.5px]">{r.companyName ?? ''}</td>
                      <td>
                        <Pill value={r.status} />
                      </td>
                      <td className="max-w-[260px] text-[12.5px]">{r.message ?? ''}</td>
                      <td className="text-[12px] text-[#6b5d85]">{r.processedBy ?? ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pager {...paged} />
          </>
        )}
      </Panel>
      <ApproveDialog req={approving} onClose={() => setApproving(null)} onDone={(m) => setMsg(m)} />
      <ConfirmDialog opts={confirm} onClose={() => setConfirm(null)} />
    </div>
  )
}

type ClientChoice = 'none' | 'link' | 'create' | 'keep'

/** Review one activation: license found by key, client create / link from the registration details, then approve. */
function ApproveDialog({ req, onClose, onDone }: { req: ActivationRequest | null; onClose: () => void; onDone: (m: NoticeMsg) => void }) {
  const can = useCan()
  const by = useAdminEmail()
  const { key } = useSigningKey()
  const canClients = can('clients.view')
  const clients = useClients(!!req && canClients)
  const [license, setLicense] = useState<License | null | undefined>(undefined)
  const [devices, setDevices] = useState<Device[]>([])
  const [choice, setChoice] = useState<ClientChoice>('none')
  const [linkId, setLinkId] = useState('')
  const [replaceId, setReplaceId] = useState('')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [reload, setReload] = useState(0)

  // Fresh license (by key) + its computers: the outcome shown here is what the approval transaction re-checks.
  useEffect(() => {
    setErr(null)
    setBusy(false)
    setLicense(undefined)
    setDevices([])
    if (!req) return
    let alive = true
    ;(async () => {
      const l = await findLicenseByKey(req.licenseKey ?? '')
      const devs = l ? (await getDocs(devicesCol(l.id))).docs.map(deviceFromSnap) : []
      if (!alive) return
      setDevices(devs)
      setLicense(l)
    })().catch((e) => {
      if (!alive) return
      setLicense(null)
      setErr(errorMessage(e))
    })
    return () => {
      alive = false
    }
  }, [req, reload])
  useEffect(() => {
    setReplaceId('')
    setNote('')
  }, [req])

  const plan = useMemo(() => (req && license ? planForRequest(req, [license], devices) : license === null ? ({ kind: 'invalid', reason: 'No license with this key' } as ActivationPlan) : null), [req, license, devices])
  const replaceable = useMemo(() => devices.filter((d) => holdsSlot(d.status) && d.deviceId !== req?.deviceId), [devices, req])

  const match = useMemo(() => (req ? matchClient(clients.data, req) : null), [clients.data, req])
  const linkedClient = license?.clientId ? clients.data.find((c) => c.id === license.clientId) : undefined

  useEffect(() => {
    if (!req || license === undefined) return
    if (license?.clientId) setChoice('keep')
    else if (match) {
      setChoice('link')
      setLinkId(match.id)
    } else if (hasRegistration(req) && can('clients.manage')) setChoice('create')
    else setChoice('none')
  }, [req, license, match]) // eslint-disable-line react-hooks/exhaustive-deps

  if (!req) return null
  const reg = clientFromRegistration(req)

  const go = async () => {
    if (!key) return setErr('Load the signing key first.')
    if (plan?.kind === 'reassign' && !replaceId) return setErr('Choose the computer this one replaces, or reject the request.')
    setBusy(true)
    setErr(null)
    try {
      const linkTo = choice === 'link' && linkId ? clients.data.find((c) => c.id === linkId) : undefined
      const res: ApproveOutcome = await approveRequest(req, key, by, {
        ...(license ? { licenseId: license.id } : {}),
        ...(linkTo ? { clientId: linkTo.id, clientLabel: `${linkTo.code} ${linkTo.company}` } : {}),
        ...(plan?.kind === 'reassign' ? { replaceDeviceId: replaceId, note } : {})
      })
      if (res === 'needs_reassignment') {
        // Another approval took the last slot meanwhile: show the computers again and let the admin decide.
        setErr('The device limit is full now (another computer was approved meanwhile). Choose a computer to replace or reject the request.')
        setReload((n) => n + 1)
        return
      }
      const ok = res === 'approved' || res === 'reassigned' || res === 'reissued'
      let extra = ''
      if (ok && choice === 'create' && license && !license.clientId) {
        const input = {
          ...reg,
          company: reg.company || license.businessName || license.customerName || 'New client',
          ownerName: reg.ownerName || license.customerName,
          phone: reg.phone || license.phone,
          email: license.email,
          city: license.city,
          plan: license.plan,
          planType: license.planType,
          allowedFirms: Math.max(1, license.maxFirms),
          allowedDevices: Math.max(1, license.maxDevices)
        }
        const c = await createClient(input, by, { license, reason: 'from the desktop registration on activation approval' })
        extra = ` Client ${c.code} created and linked.`
      } else if (ok && linkTo) extra = ` Linked to ${linkTo.code} ${linkTo.company}.`
      const name = req.deviceName || 'the computer'
      onDone({
        tone: ok ? 'success' : res === 'rejected' ? 'warn' : 'info',
        text:
          res === 'approved' ? `Activation approved — the certificate was sent to ${name}.${extra}`
            : res === 'reissued' ? `Certificate re-issued to ${name} (it already held an active slot; no new slot used).${extra}`
              : res === 'reassigned' ? `Computer replaced — ${name} took the released slot and received its certificate.${extra}`
                : res === 'rejected' ? 'The request could not be approved and was rejected (see the message in the list).'
                  : 'This request was already processed.'
      })
      onClose()
    } catch (e) {
      setErr(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      open
      onClose={() => !busy && onClose()}
      title="Approve activation"
      wide
      footer={
        <>
          <button className="btn btn-secondary" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-success" disabled={busy || !key || license === undefined || plan?.kind === 'invalid' || (plan?.kind === 'reassign' && !replaceId)} onClick={go}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : plan?.kind === 'reassign' ? <Repeat className="h-4 w-4" /> : <KeyRound className="h-4 w-4" />}
            {plan?.kind === 'reissue' ? 'Re-issue certificate' : plan?.kind === 'reassign' ? 'Replace & approve' : 'Approve & sign certificate'}
          </button>
        </>
      }
    >
      <div className="grid grid-cols-2 gap-4 text-[13.5px]">
        <div className="rounded-xl border border-[#ece6f4] bg-[#faf8fd] p-3">
          <div className="label">Computer</div>
          <div className="font-semibold">{req.deviceName || '—'}</div>
          <div className="font-mono text-[11.5px] text-[#6b5d85]" title="Device id">{req.deviceId}</div>
          <div className="text-[12px] text-[#7a6d92]">
            {req.appVersion} · {req.os}
          </div>
          <div className="mt-1 text-[12px] text-[#7a6d92]">Received {fmtDateTime(req.createdAt)}</div>
        </div>
        <div className="rounded-xl border border-[#ece6f4] bg-[#faf8fd] p-3">
          <div className="label">License</div>
          <MaskedKey value={req.licenseKey ?? ''} />
          {license === undefined ? (
            <div className="mt-1 flex items-center gap-1 text-[12px] text-[#7a6d92]">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> Looking up…
            </div>
          ) : license ? (
            <>
              <Link to={`/licenses/${license.id}`} className="font-semibold text-[#3d096d] hover:underline">
                {license.businessName || license.customerName}
              </Link>
              <div className="text-[12px] text-[#6b5d85]">
                {license.activeDevices} of {license.maxDevices} computer(s) used · {license.status}
              </div>
            </>
          ) : (
            <div className="mt-1 text-[12.5px] text-red-700">No license with this key — reject the request.</div>
          )}
        </div>
        {plan && (
          <div className={`col-span-2 rounded-xl border p-3 ${plan.kind === 'invalid' ? 'border-red-200 bg-red-50 text-red-800' : plan.kind === 'reassign' ? 'border-amber-200 bg-amber-50' : 'border-[#ece6f4] bg-[#faf8fd]'}`}>
            <div className="mb-1 flex items-center gap-2 font-semibold">
              <Pill value={PLAN_PILL[plan.kind].value} label={PLAN_PILL[plan.kind].label} />
              {plan.kind === 'reissue' && 'This computer already holds an active slot on this license — its certificate is re-issued, no new slot is used.'}
              {plan.kind === 'new' && `Takes a free slot (${plan.slotsUsed + 1} of ${plan.maxDevices} after approval).`}
              {plan.kind === 'reassign' && `Device limit full (${plan.slotsUsed} of ${plan.maxDevices}).`}
              {plan.kind === 'invalid' && plan.reason}
            </div>
            {plan.kind === 'reassign' && (
              <>
                <div className="mb-2 text-[12.5px] text-[#6b5d85]">Reject the request, or replace one computer with this one: the chosen computer is released and this one approved in one transaction.</div>
                <div className="space-y-1">
                  {replaceable.map((d) => (
                    <label key={d.deviceId} className="flex items-center gap-2 text-[13px]">
                      <input type="radio" name="replace" checked={replaceId === d.deviceId} onChange={() => setReplaceId(d.deviceId)} />
                      Replace <b>{d.deviceName || 'Device'}</b> <ShortDevice id={d.deviceId} /> <Pill value={d.status} /> <span className="text-[12px] text-[#7a6d92]">activated {fmtDateTime(d.activatedAt)} · {d.os || '—'}</span>
                    </label>
                  ))}
                  {replaceable.length === 0 && <div className="text-[12.5px] text-[#7a6d92]">No computer can be replaced.</div>}
                </div>
                <Field label="Note (recorded in the license history)" className="mt-2">
                  <input className="input" value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} placeholder="e.g. customer replaced the old laptop" />
                </Field>
              </>
            )}
          </div>
        )}
        <div className="col-span-2 rounded-xl border border-[#ece6f4] p-3">
          <div className="mb-1 flex items-center gap-2 font-semibold">
            <Building2 className="h-4 w-4 text-[#7c3aed]" /> Registration details sent by the customer
          </div>
          {hasRegistration(req) ? (
            <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-[13px]">
              <div>
                <span className="text-[#7a6d92]">Company:</span> {req.companyName || '—'}
              </div>
              <div>
                <span className="text-[#7a6d92]">Owner:</span> {req.ownerName || '—'}
              </div>
              <div>
                <span className="text-[#7a6d92]">Phone:</span> {req.phone || '—'}
              </div>
              <div>
                <span className="text-[#7a6d92]">Address:</span> {req.address || '—'}
              </div>
            </div>
          ) : (
            <div className="text-[12.5px] text-[#7a6d92]">None (older DT Solar Pro version or skipped).</div>
          )}
        </div>
        {license && canClients && (
          <div className="col-span-2 space-y-2">
            <div className="label">Client record</div>
            {license.clientId ? (
              <label className="flex items-center gap-2">
                <input type="radio" checked={choice === 'keep'} onChange={() => setChoice('keep')} />
                Keep the current client: <b>{linkedClient ? `${linkedClient.code} ${linkedClient.company}` : license.clientId}</b>
              </label>
            ) : (
              <>
                <label className="flex items-center gap-2">
                  <input type="radio" checked={choice === 'none'} onChange={() => setChoice('none')} />
                  Don’t link a client now
                </label>
                <label className="flex flex-wrap items-center gap-2">
                  <input type="radio" checked={choice === 'link'} onChange={() => setChoice('link')} disabled={!clients.data.length} />
                  Link to an existing client
                  <select className="input h-8 w-72" value={linkId} onChange={(e) => { setLinkId(e.target.value); setChoice('link') }} disabled={!clients.data.length}>
                    <option value="">— choose —</option>
                    {clients.data
                      .filter((c) => c.status !== 'archived')
                      .map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.code} · {c.company}
                          {match?.id === c.id ? ' (suggested match)' : ''}
                        </option>
                      ))}
                  </select>
                </label>
                {can('clients.manage') && (
                  <label className="flex items-center gap-2">
                    <input type="radio" checked={choice === 'create'} onChange={() => setChoice('create')} />
                    Create a new client from the registration details
                    {reg.company ? <b>({reg.company})</b> : <span className="text-[#7a6d92]">(company name taken from the license)</span>}
                  </label>
                )}
              </>
            )}
          </div>
        )}
      </div>
      {err && <div className="mt-3 rounded-lg bg-red-50 p-3 text-[13px] text-red-700">{err}</div>}
    </Modal>
  )
}
