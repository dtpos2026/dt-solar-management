/**
 * Activation requests sent by the desktop (online activation / release). Reachable as a tab of Licenses and
 * Devices and at /requests. Approving signs the certificate in this browser (no server) and can create or link
 * the client from the registration details the desktop wizard sent (companyName, ownerName, phone, address).
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { limit, onSnapshot, orderBy, query, where } from 'firebase/firestore'
import { Building2, Check, Inbox, KeyRound, Loader2, X } from 'lucide-react'
import { Modal, PageTitle } from '../components/ui'
import { findLicenseByKey, requestFromSnap, requestsCol } from '../lib/licenses'
import { approveRequest, rejectRequest } from '../lib/approve'
import { useSigningKey } from '../lib/signingKey'
import { useAdminEmail, useCan } from '../lib/auth'
import { logActivitySafe } from '../lib/audit'
import { fmtDateTime, errorMessage } from '../lib/format'
import { clientFromRegistration, matchClient } from '../lib/clients'
import { createClient } from '../lib/clientsDb'
import type { ActivationRequest, License } from '../lib/types'
import { ConfirmDialog, Empty, Loading, Notice, Pager, Panel, Pill, shortId, usePaged, type ConfirmOptions, type NoticeMsg } from './licensing/kit'
import { useClients } from './licensing/hooks'

const AUTO_KEY = 'dtsp-admin.autoApprove'

function hasRegistration(r: ActivationRequest): boolean {
  return !!(r.companyName || r.ownerName || r.phone || r.address)
}

export function Requests({ embedded = false }: { embedded?: boolean }) {
  const can = useCan()
  const allowed = can('devices.manage') || can('licenses.manage')
  const [pending, setPending] = useState<ActivationRequest[]>([])
  const [done, setDone] = useState<ActivationRequest[]>([])
  const [loading, setLoading] = useState(allowed)
  const [busy, setBusy] = useState<string | null>(null)
  const [msg, setMsg] = useState<NoticeMsg | null>(null)
  const [approving, setApproving] = useState<ActivationRequest | null>(null)
  const [confirm, setConfirm] = useState<ConfirmOptions | null>(null)
  const [auto, setAuto] = useState(() => {
    try {
      return localStorage.getItem(AUTO_KEY) === '1'
    } catch {
      return false
    }
  })
  const { key } = useSigningKey()
  const by = useAdminEmail()
  const handled = useRef(new Set<string>())

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

  const quickApprove = async (r: ActivationRequest) => {
    if (!key) return setMsg({ tone: 'warn', text: 'Load the signing key first (Settings → Signing key).' })
    setBusy(r.id)
    try {
      const res = await approveRequest(r, key, by)
      setMsg({ tone: res === 'rejected' ? 'warn' : 'success', text: `Request from ${r.deviceName || shortId(r.deviceId)} ${res}.` })
    } catch (e) {
      setMsg({ tone: 'error', text: errorMessage(e) })
    } finally {
      setBusy(null)
    }
  }

  useEffect(() => {
    if (!auto || !key) return
    for (const r of pending) {
      if (handled.current.has(r.id)) continue
      handled.current.add(r.id)
      void quickApprove(r)
    }
  }, [auto, key, pending]) // eslint-disable-line react-hooks/exhaustive-deps

  const reject = (r: ActivationRequest) =>
    setConfirm({
      title: 'Reject activation request',
      body: (
        <div>
          The customer’s DT Solar Pro shows this message and stops waiting. Computer <b>{r.deviceName || r.deviceId}</b>
          {r.licenseKey ? (
            <>
              {' '}
              · key <span className="font-mono">{r.licenseKey}</span>
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
        await rejectRequest(r, reason, by)
        logActivitySafe({ action: 'activation_rejected', category: 'device', target: r.id, targetType: 'activationRequest', licenseId: r.licenseId ?? null, details: `${r.deviceName || r.deviceId}: ${reason}` })
        setMsg({ tone: 'info', text: 'Request rejected.' })
      }
    })

  const paged = usePaged(done, 10)

  const toggleAuto = (v: boolean) => {
    setAuto(v)
    try {
      localStorage.setItem(AUTO_KEY, v ? '1' : '0')
    } catch {
      /* storage blocked */
    }
  }

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
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 rounded-lg border border-[#ddd5ea] bg-white px-3 py-2 text-[13px] font-semibold">
          <input type="checkbox" checked={auto} onChange={(e) => toggleAuto(e.target.checked)} />
          Auto-approve valid requests while this page is open
        </label>
        <span className="text-[12px] text-[#7a6d92]">Auto-approval never creates or links clients — use “Review” for new registrations.</span>
      </div>
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
                {pending.map((r) => (
                  <tr key={r.id}>
                    <td className="whitespace-nowrap text-[12.5px]">{fmtDateTime(r.createdAt)}</td>
                    <td>
                      <Pill value={r.type === 'activate' ? 'active' : 'suspended'} label={r.type === 'activate' ? 'activate' : 'release'} />
                    </td>
                    <td className="font-mono text-[12px]">{r.licenseKey || (r.licenseId ? shortId(r.licenseId) : '—')}</td>
                    <td>
                      <div className="font-semibold">{r.deviceName || '—'}</div>
                      <div className="font-mono text-[11.5px] text-[#7a6d92]">{r.deviceId}</div>
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
                          <button className="btn btn-success btn-sm" disabled={!key} title={key ? '' : 'Load the signing key first'} onClick={() => (r.type === 'activate' ? setApproving(r) : quickApprove(r))}>
                            <Check className="h-4 w-4" />
                            {r.type === 'activate' ? 'Review & approve' : 'Process'}
                          </button>
                          <button className="btn btn-secondary btn-sm" onClick={() => reject(r)}>
                            <X className="h-4 w-4" />
                            Reject
                          </button>
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
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
                      <td className="font-mono text-[12px]">{r.licenseKey || (r.licenseId ? shortId(r.licenseId) : '')}</td>
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
  const [choice, setChoice] = useState<ClientChoice>('none')
  const [linkId, setLinkId] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    setErr(null)
    setBusy(false)
    setLicense(undefined)
    if (!req) return
    findLicenseByKey(req.licenseKey ?? '')
      .then((l) => setLicense(l))
      .catch((e) => {
        setLicense(null)
        setErr(errorMessage(e))
      })
  }, [req])

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
    setBusy(true)
    setErr(null)
    try {
      const linkTo = choice === 'link' && linkId ? clients.data.find((c) => c.id === linkId) : undefined
      const res = await approveRequest(req, key, by, linkTo ? { clientId: linkTo.id, clientLabel: `${linkTo.code} ${linkTo.company}` } : {})
      let extra = ''
      if (res === 'approved' && choice === 'create' && license && !license.clientId) {
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
      } else if (res === 'approved' && linkTo) extra = ` Linked to ${linkTo.code} ${linkTo.company}.`
      onDone({
        tone: res === 'approved' ? 'success' : res === 'rejected' ? 'warn' : 'info',
        text: res === 'approved' ? `Activation approved — the certificate was sent to ${req.deviceName || 'the computer'}.${extra}` : res === 'rejected' ? 'The request could not be approved and was rejected (see the message in the list).' : 'This request was already processed.'
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
          <button className="btn btn-success" disabled={busy || !key || license === undefined} onClick={go}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <KeyRound className="h-4 w-4" />}
            Approve & sign certificate
          </button>
        </>
      }
    >
      <div className="grid grid-cols-2 gap-4 text-[13.5px]">
        <div className="rounded-xl border border-[#ece6f4] bg-[#faf8fd] p-3">
          <div className="label">Computer</div>
          <div className="font-semibold">{req.deviceName || '—'}</div>
          <div className="font-mono text-[11.5px] text-[#6b5d85]">{req.deviceId}</div>
          <div className="text-[12px] text-[#7a6d92]">
            {req.appVersion} · {req.os}
          </div>
          <div className="mt-1 text-[12px] text-[#7a6d92]">Received {fmtDateTime(req.createdAt)}</div>
        </div>
        <div className="rounded-xl border border-[#ece6f4] bg-[#faf8fd] p-3">
          <div className="label">License</div>
          <div className="font-mono text-[12.5px]">{req.licenseKey}</div>
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
            <div className="mt-1 text-[12.5px] text-red-700">No license with this key — approving will reject the request.</div>
          )}
        </div>
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
