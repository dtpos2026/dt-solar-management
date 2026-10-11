import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Badge, PageTitle, copy, download } from '../components/ui'
import { decodeOfflineRequest, type OfflineRequest } from '../lib/crypto'
import { issueForDevice } from '../lib/approve'
import { useSigningKey } from '../lib/signingKey'
import { useAdminEmail } from '../lib/auth'
import { errorMessage } from '../lib/format'

export function Offline() {
  const { key } = useSigningKey()
  const by = useAdminEmail()
  const [code, setCode] = useState('')
  const [req, setReq] = useState<OfflineRequest | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [out, setOut] = useState<{ code: string; file: string; name: string; business: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const decode = () => {
    setErr(null)
    setOut(null)
    try { setReq(decodeOfflineRequest(code)) } catch (e) { setReq(null); setErr(errorMessage(e)) }
  }
  const approve = async () => {
    if (!req || !key) return
    setBusy(true)
    setErr(null)
    try {
      const { license, cert } = await issueForDevice(req.k, { deviceId: req.d, deviceName: req.n ?? '', os: req.o ?? '', appVersion: req.a ?? '' }, key, by, 'offline')
      setOut({ code: cert.code, file: cert.fileContents, business: license.businessName, name: `${(license.businessName || 'license').replace(/[^\w-]+/g, '_')}-${req.d.slice(0, 9)}.dtlic` })
    } catch (e) {
      setErr(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="max-w-3xl">
      <PageTitle title="Offline activation" sub="For computers without internet: the customer sends you the request code from their License page." />
      {!key && <div className="mb-4 rounded-xl bg-amber-50 p-3 text-[13.5px] text-amber-800">Signing key not loaded. <Link className="font-bold underline" to="/key">Load it</Link> first.</div>}
      <div className="card p-4">
        <span className="label">Request code</span>
        <textarea className="input font-mono text-[12px]" rows={4} value={code} onChange={(e) => setCode(e.target.value)} placeholder="Paste the request code here" />
        <button className="btn btn-secondary mt-2" onClick={decode}>Read request</button>
        {req && (
          <div className="mt-4 rounded-xl bg-[#faf8fd] p-4 text-[13.5px]">
            <div><b>License key:</b> <span className="font-mono">{req.k}</span></div>
            <div><b>Computer:</b> {req.n} <span className="font-mono text-[12px]">({req.d})</span></div>
            <div><b>App / OS:</b> {req.a} · {req.o}</div>
            <button className="btn btn-primary mt-3" disabled={!key || busy} onClick={approve}>Approve & create activation code</button>
          </div>
        )}
        {err && <div className="mt-3 rounded-lg bg-red-50 p-3 text-[13px] text-red-700">{err}</div>}
        {out && (
          <div className="mt-4">
            <div className="mb-1 flex items-center gap-2"><Badge tone="active">approved</Badge><span className="text-[13px]">{out.business}</span></div>
            <span className="label">Activation code — send this to the customer (WhatsApp / email)</span>
            <textarea className="input font-mono text-[11.5px]" rows={5} readOnly value={out.code} />
            <div className="mt-2 flex gap-2"><button className="btn btn-secondary btn-sm" onClick={() => copy(out.code)}>Copy code</button><button className="btn btn-secondary btn-sm" onClick={() => download(out.name, out.file)}>Download .dtlic file</button></div>
          </div>
        )}
      </div>
    </div>
  )
}
