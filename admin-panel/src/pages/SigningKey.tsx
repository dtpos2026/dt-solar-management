import { useState } from 'react'
import { Navigate } from 'react-router-dom'
import { Copy, KeyRound, ShieldAlert, Trash2, Upload } from 'lucide-react'
import { copy } from '../components/ui'
import { useSigningKey } from '../lib/signingKey'
import { errorMessage } from '../lib/format'
import { logActivitySafe } from '../lib/audit'

/** The old /key route: the signing key now lives in Settings → Signing key. */
export function SigningKeyPage() {
  return <Navigate to="/settings?tab=key" replace />
}

/** Load / forget the Ed25519 license signing key (kept in this browser only). Shown in Settings → Signing key. */
export function SigningKeyPanel() {
  const { key, restoring, remembered, load, setRemember, forget } = useSigningKey()
  const [text, setText] = useState('')
  const [remember, setRem] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const doLoad = async (t: string) => {
    setErr(null)
    setBusy(true)
    try {
      const k = await load(t, remember)
      setText('')
      logActivitySafe({ action: 'signing_key_loaded', category: 'security', target: k.fingerprint, targetType: 'signing_key', details: `Signing key loaded in this browser${remember ? ' (remembered)' : ''}. Fingerprint ${k.fingerprint}` })
    } catch (e) {
      setErr(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="space-y-4">
      <div className="card flex gap-3 border-amber-200 bg-amber-50 p-4 text-[13px] text-amber-900">
        <ShieldAlert className="h-5 w-5 shrink-0" />
        <div>
          Licenses are signed here, in your browser — the private key is never uploaded anywhere. The key was created automatically the first time you ran{' '}
          <code className="rounded bg-white px-1">npm run build</code> in the DT Solar Pro (desktop) folder: select the file <b>keys\license-private.pem</b> from that
          folder below. Keep a USB backup of it and never share it. Do not create a new key — installers already given to customers only accept licenses signed with this one.
        </div>
      </div>
      {restoring ? (
        <div className="card p-4 text-[13px] text-[#7a6d92]">Restoring the remembered key…</div>
      ) : key ? (
        <div className="card p-5">
          <div className="flex items-center gap-2 font-bold text-green-700"><KeyRound className="h-5 w-5" />Signing key loaded</div>
          <div className="mt-2 text-[13px]">Fingerprint: <span className="font-mono">{key.fingerprint}</span></div>
          <div className="mt-3">
            <span className="label">Matching public key (must equal resources/license-public.pem in the app build)</span>
            <textarea className="input font-mono text-[11.5px]" rows={3} readOnly value={key.publicPem} />
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <button className="btn btn-secondary btn-sm" onClick={() => copy(key.publicPem)}><Copy className="h-4 w-4" />Copy public key</button>
            <label className="flex items-center gap-2 text-[13px]"><input type="checkbox" checked={remembered} onChange={(e) => setRemember(e.target.checked)} />Remember on this computer</label>
            <button
              className="btn btn-danger btn-sm"
              onClick={() => {
                logActivitySafe({ action: 'signing_key_forgotten', category: 'security', target: key.fingerprint, targetType: 'signing_key', details: `Signing key removed from this browser. Fingerprint ${key.fingerprint}` })
                forget()
              }}
            >
              <Trash2 className="h-4 w-4" />Forget key
            </button>
          </div>
        </div>
      ) : (
        <div className="card p-5">
          <span className="label">Load keys/license-private.pem</span>
          <label className="btn btn-secondary btn-sm">
            <Upload className="h-4 w-4" />Choose file…
            <input
              type="file"
              accept=".pem,.txt"
              className="hidden"
              onChange={async (e) => {
                const f = e.target.files?.[0]
                e.target.value = ''
                if (f) await doLoad(await f.text())
              }}
            />
          </label>
          <div className="my-3 text-[12px] text-[#7a6d92]">or paste it</div>
          <textarea className="input font-mono text-[11.5px]" rows={5} value={text} onChange={(e) => setText(e.target.value)} placeholder="-----BEGIN PRIVATE KEY-----" aria-label="Private key PEM" />
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <button className="btn btn-primary" disabled={!text.trim() || busy} onClick={() => doLoad(text)}>Load key</button>
            <label className="flex items-center gap-2 text-[13px]"><input type="checkbox" checked={remember} onChange={(e) => setRem(e.target.checked)} />Remember on this computer (only on your own PC)</label>
          </div>
          {err && <div className="mt-3 rounded-lg bg-red-50 p-3 text-[13px] text-red-700">{err}</div>}
        </div>
      )}
    </div>
  )
}
