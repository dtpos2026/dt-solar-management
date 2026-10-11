import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { getDocs, limit, onSnapshot, orderBy, query, where } from 'firebase/firestore'
import { PageTitle, Stat } from '../components/ui'
import { auditCol, auditFromSnap, effectiveStatus, licenseFromSnap, licensesCol, requestsCol } from '../lib/licenses'
import { daysUntil, fmtDateTime } from '../lib/format'
import type { AuditEntry, License } from '../lib/types'
import { useSigningKey } from '../lib/signingKey'

export function Dashboard() {
  const [lics, setLics] = useState<License[]>([])
  const [pending, setPending] = useState(0)
  const [recent, setRecent] = useState<AuditEntry[]>([])
  const { key } = useSigningKey()
  useEffect(() => {
    getDocs(licensesCol()).then((s) => setLics(s.docs.map(licenseFromSnap))).catch(() => undefined)
    getDocs(query(auditCol(), orderBy('at', 'desc'), limit(10))).then((s) => setRecent(s.docs.map(auditFromSnap))).catch(() => undefined)
    return onSnapshot(query(requestsCol(), where('status', '==', 'pending')), (s) => setPending(s.size), () => undefined)
  }, [])
  const count = (st: string) => lics.filter((l) => effectiveStatus(l) === st).length
  const expiring = lics.filter((l) => { const d = daysUntil(l.expiresAt); return d !== null && d >= 0 && d <= 30 }).length
  return (
    <div>
      <PageTitle title="Dashboard" sub="DT Solar Pro licenses at a glance" />
      {!key && <div className="mb-4 rounded-xl bg-amber-50 p-4 text-[13.5px] text-amber-800">No signing key loaded — you cannot approve activations yet. <Link to="/key" className="font-bold underline">Load the signing key</Link>.</div>}
      {pending > 0 && <Link to="/requests" className="mb-4 block rounded-xl bg-[#3d096d] p-4 font-semibold text-white">{pending} activation request(s) waiting for approval →</Link>}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat label="Total licenses" value={lics.length} />
        <Stat label="Active" value={count('active')} tone="text-green-700" />
        <Stat label="Suspended / revoked" value={count('suspended') + count('revoked')} tone="text-red-600" />
        <Stat label="Expired" value={count('expired')} tone="text-red-600" />
        <Stat label="Expiring in 30 days" value={expiring} tone="text-amber-600" />
        <Stat label="Active devices" value={lics.reduce((a, l) => a + l.activeDevices, 0)} />
        <Stat label="Pending requests" value={pending} tone="text-[#3d096d]" />
      </div>
      <div className="card mt-5">
        <div className="border-b border-[#ece6f4] px-4 py-3 font-bold">Recent activity</div>
        <table className="tbl"><tbody>
          {recent.map((a) => <tr key={a.id}><td className="w-44 text-[12.5px] text-[#7a6d92]">{fmtDateTime(a.at)}</td><td className="font-semibold">{a.action.replace(/_/g, ' ')}</td><td className="text-[13px]">{a.details}</td></tr>)}
          {recent.length === 0 && <tr><td className="py-6 text-center text-[#7a6d92]">No activity yet.</td></tr>}
        </tbody></table>
      </div>
    </div>
  )
}
