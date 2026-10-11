import { useState } from 'react'
import { KeyRound, ShieldAlert } from 'lucide-react'
import { PageTitle, copy } from '../components/ui'
import { useSigningKey } from '../lib/signingKey'
import { errorMessage } from '../lib/format'

export function SigningKeyPage() {
  const { key, remembered, load, setRemember, forget } = useSigningKey()
  const [text, setText] = useState('')
  const [remember, setRem] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const doLoad = async (t: string) => {
    setErr(null)
    try { await load(t, remember); setText('') } catch (e) { setErr(errorMessage(e)) }
  }
  return (
    <div className="max-w-3xl">
      <PageTitle title="Signing key" sub="Licenses are signed here, in your browser. The private key is never uploaded anywhere." />
      <div className="card mb-4 flex gap-3 bg-amber-50 p-4 text-[13px] text-amber-900">
        <ShieldAlert className="h-5 w-5 shrink-0" />
        <div>Create the key once on your computer with <code className="rounded bg-white px-1">npm run license:keygen</code> (in the DT Solar Pro folder). It creates <b>keys/license-private.pem</b> (secret — keep a USB backup) and <b>resources/license-public.pem</b> (built into the app). Load the private key file below on this computer.</div>
      </div>
      {key ? (
        <div className="card p-4">
          <div className="flex items-center gap-2 font-bold text-green-700"><KeyRound className="h-5 w-5" />Signing key loaded</div>
          <div className="mt-2 text-[13px]">Fingerprint: <span className="font-mono">{key.fingerprint}</span></div>
          <div className="mt-3"><span className="label">Matching public key (must equal resources/license-public.pem in the app build)</span><textarea className="input font-mono text-[11.5px]" rows={3} readOnly value={key.publicPem} /></div>
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <button className="btn btn-secondary btn-sm" onClick={() => copy(key.publicPem)}>Copy public key</button>
            <label className="flex items-center gap-2 text-[13px]"><input type="checkbox" checked={remembered} onChange={(e) => setRemember(e.target.checked)} />Remember on this computer</label>
            <button className="btn btn-danger btn-sm" onClick={forget}>Forget key</button>
          </div>
        </div>
      ) : (
        <div className="card p-4">
          <span className="label">Load keys/license-private.pem</span>
          <input type="file" accept=".pem,.txt" onChange={async (e) => { const f = e.target.files?.[0]; if (f) doLoad(await f.text()) }} />
          <div className="my-3 text-center text-[12px] text-[#7a6d92]">or paste it</div>
          <textarea className="input font-mono text-[11.5px]" rows={5} value={text} onChange={(e) => setText(e.target.value)} placeholder="-----BEGIN PRIVATE KEY-----" />
          <div className="mt-3 flex items-center gap-3">
            <button className="btn btn-primary" disabled={!text.trim()} onClick={() => doLoad(text)}>Load key</button>
            <label className="flex items-center gap-2 text-[13px]"><input type="checkbox" checked={remember} onChange={(e) => setRem(e.target.checked)} />Remember on this computer (only on your own PC)</label>
          </div>
          {err && <div className="mt-3 rounded-lg bg-red-50 p-3 text-[13px] text-red-700">{err}</div>}
        </div>
      )}
    </div>
  )
}
