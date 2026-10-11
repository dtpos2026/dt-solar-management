import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { limit, onSnapshot, orderBy, query, where } from 'firebase/firestore'
import { Check, Loader2, X } from 'lucide-react'
import { Badge, PageTitle } from '../components/ui'
import { requestFromSnap, requestsCol } from '../lib/licenses'
import { approveRequest, rejectRequest } from '../lib/approve'
import { useSigningKey } from '../lib/signingKey'
import { useAdminEmail } from '../lib/auth'
import { fmtDateTime, errorMessage } from '../lib/format'
import type { ActivationRequest } from '../lib/types'

const AUTO_KEY = 'dtsp-admin.autoApprove'

export function Requests() {
  const [pending, setPending] = useState<ActivationRequest[]>([])
  const [done, setDone] = useState<ActivationRequest[]>([])
  const [busy, setBusy] = useState<string | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  const [auto, setAuto] = useState(() => { try { return localStorage.getItem(AUTO_KEY) === '1' } catch { return false } })
  const { key } = useSigningKey()
  const by = useAdminEmail()
  const handled = useRef(new Set<string>())

  useEffect(() => {
    const a = onSnapshot(query(requestsCol(), where('status', '==', 'pending'), orderBy('createdAt', 'desc')), (s) => setPending(s.docs.map(requestFromSnap)), (e) => setMsg(errorMessage(e)))
    const b = onSnapshot(query(requestsCol(), orderBy('createdAt', 'desc'), limit(40)), (s) => setDone(s.docs.map(requestFromSnap).filter((r) => r.status !== 'pending')), () => undefined)
    return () => { a(); b() }
  }, [])

  const approve = async (r: ActivationRequest) => {
    if (!key) return setMsg('Load the signing key first (Signing key page).')
    setBusy(r.id)
    try {
      const res = await approveRequest(r, key, by)
      setMsg(`Request ${r.id.slice(0, 8)}… ${res}.`)
    } catch (e) {
      setMsg(errorMessage(e))
    } finally {
      setBusy(null)
    }
  }

  useEffect(() => {
    if (!auto || !key) return
    for (const r of pending) {
      if (handled.current.has(r.id)) continue
      handled.current.add(r.id)
      approve(r)
    }
  }, [auto, key, pending]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div>
      <PageTitle
        title="Activation requests"
        sub="Customers' DT Solar Pro sends a request when they activate online. Approve to issue a signed license."
        actions={
          <label className="flex items-center gap-2 rounded-lg border border-[#ddd5ea] bg-white px-3 py-2 text-[13px] font-semibold">
            <input type="checkbox" checked={auto} onChange={(e) => { setAuto(e.target.checked); try { localStorage.setItem(AUTO_KEY, e.target.checked ? '1' : '0') } catch { /* ignore */ } }} />
            Auto-approve valid requests while this page is open
          </label>
        }
      />
      {!key && <div className="mb-4 rounded-xl bg-amber-50 p-3 text-[13.5px] text-amber-800">Signing key not loaded. <Link className="font-bold underline" to="/key">Load it</Link> to approve requests.</div>}
      {msg && <div className="mb-4 rounded-xl bg-[#f1e9fb] p-3 text-[13.5px]">{msg}</div>}
      <div className="card mb-6">
        <div className="border-b border-[#ece6f4] px-4 py-3 font-bold">Pending ({pending.length})</div>
        <table className="tbl">
          <thead><tr><th>Received</th><th>Type</th><th>License key / ID</th><th>Computer</th><th>App</th><th /></tr></thead>
          <tbody>
            {pending.map((r) => (
              <tr key={r.id}>
                <td>{fmtDateTime(r.createdAt)}</td>
                <td><Badge tone={r.type === 'activate' ? 'active' : 'suspended'}>{r.type}</Badge></td>
                <td className="font-mono text-[12.5px]">{r.licenseKey || r.licenseId}</td>
                <td><div className="font-semibold">{r.deviceName}</div><div className="font-mono text-[11.5px] text-[#7a6d92]">{r.deviceId}</div></td>
                <td className="text-[12px]">{r.appVersion} · {r.os}</td>
                <td className="text-right">
                  {busy === r.id ? <Loader2 className="inline h-4 w-4 animate-spin" /> : (
                    <div className="flex justify-end gap-2">
                      <button className="btn btn-success btn-sm" disabled={!key} onClick={() => approve(r)}><Check className="h-4 w-4" />Approve</button>
                      <button className="btn btn-secondary btn-sm" onClick={async () => { const m = prompt('Reason for rejection', 'Please contact Digital Target'); if (m !== null) await rejectRequest(r, m, by).catch((e) => setMsg(errorMessage(e))) }}><X className="h-4 w-4" />Reject</button>
                    </div>
                  )}
                </td>
              </tr>
            ))}
            {pending.length === 0 && <tr><td colSpan={6} className="py-8 text-center text-[#7a6d92]">No pending requests.</td></tr>}
          </tbody>
        </table>
      </div>
      <div className="card">
        <div className="border-b border-[#ece6f4] px-4 py-3 font-bold">Recently processed</div>
        <table className="tbl">
          <thead><tr><th>Received</th><th>Type</th><th>Key / ID</th><th>Computer</th><th>Status</th><th>Message</th><th>By</th></tr></thead>
          <tbody>
            {done.map((r) => (
              <tr key={r.id}>
                <td>{fmtDateTime(r.createdAt)}</td><td>{r.type}</td><td className="font-mono text-[12px]">{r.licenseKey || r.licenseId}</td>
                <td>{r.deviceName}</td><td><Badge>{r.status}</Badge></td><td className="text-[12.5px]">{r.message ?? ''}</td><td className="text-[12px]">{r.processedBy ?? ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
