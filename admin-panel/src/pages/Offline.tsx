/**
 * Offline activation: decode the request code shown by a computer without internet and sign its certificate.
 * Same policy as online requests: explicit approval by an admin with devices.manage; a full license needs the
 * admin to replace one computer (released + approved in one transaction).
 */
import { useState } from 'react'
import { getDocs } from 'firebase/firestore'
import { Link } from 'react-router-dom'
import { ClipboardPaste, Download, KeyRound, Loader2 } from 'lucide-react'
import { PageTitle, copy, download } from '../components/ui'
import { decodeOfflineRequest, type OfflineRequest } from '../lib/crypto'
import { NeedsReassignmentError, dtlicName, issueForDevice } from '../lib/approve'
import { deviceFromSnap, devicesCol, findLicenseByKey } from '../lib/licenses'
import { holdsSlot, maskDeviceId, maskLicenseKey } from '../lib/terms'
import type { Device } from '../lib/types'
import { ShortDevice } from './licenses/parts'
import { useSigningKey } from '../lib/signingKey'
import { useAdminEmail, useCan } from '../lib/auth'
import { logActivitySafe } from '../lib/audit'
import { errorMessage, fmtDateTime } from '../lib/format'
import { Notice, Panel, Pill } from './licensing/kit'

export function Offline({ embedded = false }: { embedded?: boolean }) {
  const { key } = useSigningKey()
  const can = useCan()
  const allowed = can('devices.manage')
  const by = useAdminEmail()
  const [code, setCode] = useState('')
  const [req, setReq] = useState<OfflineRequest | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [out, setOut] = useState<{ code: string; file: string; name: string; business: string; licenseId: string } | null>(null)
  const [busy, setBusy] = useState(false)
  /** Computers that may be replaced when the license is full (null = not needed). */
  const [full, setFull] = useState<{ devices: Device[]; text: string } | null>(null)
  const [replaceId, setReplaceId] = useState('')
  const decode = () => {
    setErr(null)
    setOut(null)
    setFull(null)
    setReplaceId('')
    try {
      setReq(decodeOfflineRequest(code))
    } catch (e) {
      setReq(null)
      setErr(errorMessage(e))
    }
  }
  const approve = async () => {
    if (!req || !key) return
    setBusy(true)
    setErr(null)
    try {
      const { license, cert } = await issueForDevice(req.k, { deviceId: req.d, deviceName: req.n ?? '', os: req.o ?? '', appVersion: req.a ?? '' }, key, by, 'offline', full && replaceId ? { replaceDeviceId: replaceId, note: 'offline activation' } : {})
      setOut({ code: cert.code, file: cert.fileContents, business: license.businessName || license.customerName, name: dtlicName(license, req.d), licenseId: license.id })
      setFull(null)
    } catch (e) {
      if (e instanceof NeedsReassignmentError) {
        const l = await findLicenseByKey(req.k).catch(() => null)
        const devs = l ? (await getDocs(devicesCol(l.id))).docs.map(deviceFromSnap).filter((d) => holdsSlot(d.status) && d.deviceId !== req.d) : []
        setFull({ devices: devs, text: e.message })
        setReplaceId('')
        return
      }
      setErr(errorMessage(e))
      logActivitySafe({ action: 'offline_activation_failed', category: 'license', status: 'failure', target: maskDeviceId(req.d), targetType: 'device', details: `${maskLicenseKey(req.k)} / ${req.n || maskDeviceId(req.d)}: ${errorMessage(e)}` })
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="max-w-3xl">
      {!embedded && <PageTitle title="Offline activation" sub="For computers without internet: the customer sends you the request code from their License page." />}
      {!allowed && <Notice msg={{ tone: 'warn', text: 'Approving a computer needs the “devices.manage” permission.' }} />}
      {allowed && !key && (
        <Notice
          msg={{
            tone: 'warn',
            text: (
              <>
                Signing key not loaded. <Link className="font-bold underline" to="/key">Load it</Link> first.
              </>
            )
          }}
        />
      )}
      <Panel title="Request code" sub="The customer copies it from DT Solar Pro → Settings → License → Offline activation.">
        <div className="p-4">
          <textarea className="input font-mono text-[12px]" rows={4} value={code} onChange={(e) => setCode(e.target.value)} placeholder="Paste the request code here" aria-label="Request code" />
          <button className="btn btn-secondary mt-2" onClick={decode} disabled={!code.trim()}>
            <ClipboardPaste className="h-4 w-4" />
            Read request
          </button>
          {req && (
            <div className="mt-4 rounded-xl border border-[#ece6f4] bg-[#faf8fd] p-4 text-[13.5px]">
              <div>
                <b>License key:</b> <span className="font-mono">{req.k}</span>
              </div>
              <div>
                <b>Computer:</b> {req.n || '-'} <span className="font-mono text-[12px]">({req.d})</span>
              </div>
              <div>
                <b>App / OS:</b> {req.a || '-'}, {req.o || '-'}
              </div>
              {req.t && (
                <div>
                  <b>Created:</b> {fmtDateTime(req.t)}
                </div>
              )}
              {full && (
                <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3">
                  <div className="mb-1 font-semibold">Needs reassignment - {full.text}</div>
                  {full.devices.map((d) => (
                    <label key={d.deviceId} className="flex items-center gap-2 text-[13px]">
                      <input type="radio" name="offline-replace" checked={replaceId === d.deviceId} onChange={() => setReplaceId(d.deviceId)} />
                      Replace <b>{d.deviceName || 'Device'}</b> <ShortDevice id={d.deviceId} /> <span className="text-[12px] text-[#7a6d92]">{d.status}, activated {fmtDateTime(d.activatedAt)}</span>
                    </label>
                  ))}
                  {full.devices.length === 0 && <div className="text-[12.5px]">No computer can be replaced.</div>}
                </div>
              )}
              <button className="btn btn-primary mt-3" disabled={!key || busy || !allowed || (!!full && !replaceId)} onClick={approve}>
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <KeyRound className="h-4 w-4" />}
                {full ? 'Replace & create activation code' : 'Approve & create activation code'}
              </button>
            </div>
          )}
          {err && <div className="mt-3 rounded-lg bg-red-50 p-3 text-[13px] text-red-700">{err}</div>}
          {out && (
            <div className="mt-4">
              <div className="mb-1 flex items-center gap-2">
                <Pill value="approved" />
                <Link className="text-[13px] font-semibold text-[#3d096d] hover:underline" to={`/licenses/${out.licenseId}`}>
                  {out.business}
                </Link>
              </div>
              <span className="label">Activation code - send this to the customer (WhatsApp / email)</span>
              <textarea className="input font-mono text-[12px]" rows={5} readOnly value={out.code} />
              <div className="mt-2 flex gap-2">
                <button className="btn btn-secondary btn-sm" onClick={() => copy(out.code)}>
                  Copy code
                </button>
                <button className="btn btn-secondary btn-sm" onClick={() => download(out.name, out.file)}>
                  <Download className="h-4 w-4" />
                  Download .dtlic file
                </button>
              </div>
            </div>
          )}
        </div>
      </Panel>
    </div>
  )
}
