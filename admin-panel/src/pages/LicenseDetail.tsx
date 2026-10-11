import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { onSnapshot, orderBy, query } from 'firebase/firestore'
import { ArrowLeft, Copy, Pencil } from 'lucide-react'
import { Badge, PageTitle, Stat, copy, download } from '../components/ui'
import { adminDeactivateDevice, adminReactivateDevice, deviceFromSnap, devicesCol, effectiveStatus, expiryLabel, historyCol, historyFromSnap, licenseFromSnap, licenseRef, renewLicense, republishStatus, setLicenseState } from '../lib/licenses'
import { issueForDevice } from '../lib/approve'
import { useAdminEmail } from '../lib/auth'
import { useSigningKey } from '../lib/signingKey'
import { addYears, errorMessage, fmtDate, fmtDateTime } from '../lib/format'
import type { Device, HistoryEntry, License } from '../lib/types'
import { LicenseForm } from './Licenses'

export function LicenseDetail() {
  const { id = '' } = useParams()
  const nav = useNavigate()
  const by = useAdminEmail()
  const { key } = useSigningKey()
  const [l, setL] = useState<License | null>(null)
  const [devices, setDevices] = useState<Device[]>([])
  const [history, setHistory] = useState<HistoryEntry[]>([])
  const [edit, setEdit] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [issued, setIssued] = useState<{ code: string; file: string; name: string } | null>(null)
  useEffect(() => {
    const a = onSnapshot(licenseRef(id), (s) => setL(s.exists() ? licenseFromSnap(s) : null))
    const b = onSnapshot(devicesCol(id), (s) => setDevices(s.docs.map(deviceFromSnap)))
    const c = onSnapshot(query(historyCol(id), orderBy('at', 'desc')), (s) => setHistory(s.docs.map(historyFromSnap)))
    return () => { a(); b(); c() }
  }, [id])
  if (!l) return <div className="text-[#7a6d92]">Loading…</div>
  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setMsg(null)
    try { await fn(); setMsg(ok) } catch (e) { setMsg(errorMessage(e)) }
  }
  const state = effectiveStatus(l)
  return (
    <div>
      <button className="mb-3 flex items-center gap-1 text-[13px] text-[#6b5d85] hover:underline" onClick={() => nav('/licenses')}><ArrowLeft className="h-4 w-4" />All licenses</button>
      <PageTitle
        title={l.businessName || l.customerName}
        sub={`${l.customerName} · ${l.phone} ${l.email} ${l.city}`}
        actions={
          <>
            <button className="btn btn-secondary" onClick={() => setEdit(true)}><Pencil className="h-4 w-4" />Edit</button>
            <button className="btn btn-secondary" onClick={() => run(() => renewLicense(l, addYears(l.expiresAt ? l.expiresAt.toDate() : new Date(), 1), by), 'Renewed for one more year.')}>Renew +1 year</button>
            {l.status === 'active' ? (
              <button className="btn btn-secondary" onClick={() => { const r = prompt('Reason for suspension'); if (r !== null) run(() => setLicenseState(l, 'suspended', by, r), 'License suspended.') }}>Suspend</button>
            ) : (
              <button className="btn btn-success" onClick={() => run(() => setLicenseState(l, 'active', by, ''), 'License reactivated.')}>Reactivate</button>
            )}
            {l.status !== 'revoked' && <button className="btn btn-danger" onClick={() => { const r = prompt('Type REVOKE to permanently revoke this license'); if (r === 'REVOKE') run(() => setLicenseState(l, 'revoked', by, 'Revoked by admin'), 'License revoked.') }}>Revoke</button>}
          </>
        }
      />
      {msg && <div className="mb-4 rounded-xl bg-[#f1e9fb] p-3 text-[13.5px]">{msg}</div>}
      <div className="card mb-4 flex flex-wrap items-center gap-4 p-4">
        <div><div className="label">License key (give this to the customer)</div><div className="font-mono text-[20px] font-bold tracking-wider text-[#3d096d]">{l.licenseKey}</div></div>
        <button className="btn btn-secondary btn-sm" onClick={() => copy(l.licenseKey)}><Copy className="h-4 w-4" />Copy</button>
        <div className="ml-auto"><Badge>{state}</Badge></div>
      </div>
      <div className="mb-4 grid grid-cols-2 gap-4 lg:grid-cols-5">
        <Stat label="Plan" value={<span className="capitalize">{l.plan}</span>} />
        <Stat label="Computers" value={`${l.activeDevices} / ${l.maxDevices}`} />
        <Stat label="Firms / users" value={`${l.maxFirms} / ${l.maxUsers}`} />
        <Stat label="Expiry" value={<span className="text-[18px]">{expiryLabel(l)}</span>} />
        <Stat label="Online check" value={<span className="text-[18px]">{l.checkinDays ? `every ${l.checkinDays}d (+${l.graceDays})` : 'Not required'}</span>} />
      </div>
      <div className="card mb-4">
        <div className="flex items-center justify-between border-b border-[#ece6f4] px-4 py-3"><div className="font-bold">Computers</div><button className="btn btn-secondary btn-sm" onClick={() => run(() => republishStatus(l, by), 'Status re-published.')}>Re-publish status</button></div>
        <table className="tbl">
          <thead><tr><th>Computer</th><th>Device ID</th><th>App / OS</th><th>Activated</th><th>Type</th><th>Status</th><th /></tr></thead>
          <tbody>
            {devices.map((d) => (
              <tr key={d.id}>
                <td className="font-semibold">{d.deviceName}</td><td className="font-mono text-[12px]">{d.deviceId}</td><td className="text-[12px]">{d.appVersion} · {d.os}</td>
                <td>{fmtDate(d.activatedAt)}</td><td>{d.activationType}</td><td><Badge>{d.status}</Badge></td>
                <td className="text-right">
                  <div className="flex justify-end gap-2">
                    {d.status === 'active' && <button className="btn btn-secondary btn-sm" disabled={!key} title={key ? '' : 'Load the signing key first'} onClick={() => run(async () => {
                      const { cert } = await issueForDevice(l.licenseKey, d, key!, by, d.activationType)
                      setIssued({ code: cert.code, file: cert.fileContents, name: `${(l.businessName || 'license').replace(/[^\w-]+/g, '_')}-${d.deviceId.slice(0, 9)}.dtlic` })
                    }, 'Certificate issued.')}>Issue certificate</button>}
                    {d.status === 'active'
                      ? <button className="btn btn-secondary btn-sm" onClick={() => confirm('Deactivate this computer? It becomes read-only at its next online check.') && run(() => adminDeactivateDevice(l.id, d.deviceId, by), 'Computer deactivated.')}>Deactivate</button>
                      : <button className="btn btn-secondary btn-sm" onClick={() => run(() => adminReactivateDevice(l.id, d.deviceId, by), 'Computer reactivated.')}>Reactivate</button>}
                  </div>
                </td>
              </tr>
            ))}
            {devices.length === 0 && <tr><td colSpan={7} className="py-6 text-center text-[#7a6d92]">No computers activated yet.</td></tr>}
          </tbody>
        </table>
      </div>
      {issued && (
        <div className="card mb-4 p-4">
          <div className="label">Activation code — the customer pastes this on the DT Solar Pro License page</div>
          <textarea className="input font-mono text-[11.5px]" rows={4} readOnly value={issued.code} />
          <div className="mt-2 flex gap-2"><button className="btn btn-secondary btn-sm" onClick={() => copy(issued.code)}>Copy code</button><button className="btn btn-secondary btn-sm" onClick={() => download(issued.name, issued.file)}>Download .dtlic</button></div>
        </div>
      )}
      <div className="card">
        <div className="border-b border-[#ece6f4] px-4 py-3 font-bold">History</div>
        <table className="tbl"><tbody>
          {history.map((h) => <tr key={h.id}><td className="w-44 text-[12.5px] text-[#7a6d92]">{fmtDateTime(h.at)}</td><td className="font-semibold">{h.action.replace(/_/g, ' ')}</td><td className="text-[13px]">{h.details}</td><td className="text-[12px] text-[#7a6d92]">{h.by}</td></tr>)}
        </tbody></table>
      </div>
      <LicenseForm open={edit} license={l} onClose={() => setEdit(false)} onSaved={() => setMsg('License updated.')} />
    </div>
  )
}
