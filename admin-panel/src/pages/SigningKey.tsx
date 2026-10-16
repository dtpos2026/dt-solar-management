import { useState } from 'react'
import { Navigate } from 'react-router-dom'
import { Copy, KeyRound, ShieldAlert, Trash2, Upload, UserRound, Globe, FileKey2, ShieldCheck } from 'lucide-react'
import type { ReactNode } from 'react'
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
      <KeysExplained />
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

function KeyCard({ icon, title, where, children, tone }: { icon: ReactNode; title: string; where: string; children: ReactNode; tone: 'secret' | 'public' }) {
  return (
    <div className="rounded-xl border border-[#ece6f4] bg-white p-3.5">
      <div className="flex items-center gap-2 text-[13.5px] font-bold">
        <span className="text-[#7c3aed] [&>svg]:h-4 [&>svg]:w-4">{icon}</span>
        {title}
        <span className={tone === 'secret' ? 'ml-auto rounded-md bg-red-50 px-2 py-0.5 text-[11px] font-bold text-red-700' : 'ml-auto rounded-md bg-green-50 px-2 py-0.5 text-[11px] font-bold text-green-700'}>
          {tone === 'secret' ? 'Secret' : 'Public by design'}
        </span>
      </div>
      <div className="mt-1 text-[11.5px] font-semibold text-[#7a6d92]">{where}</div>
      <div className="mt-1.5 text-[12.5px] leading-relaxed text-[#4a3d63]">{children}</div>
    </div>
  )
}

/** Explains the four kinds of keys / credentials so nobody mixes them up. */
export function KeysExplained() {
  return (
    <section className="card p-5" aria-labelledby="keys-explained">
      <h2 id="keys-explained" className="text-[15px] font-bold">Keys and credentials — what is what</h2>
      <p className="mt-0.5 text-[12.5px] text-[#7a6d92]">Four different things. Only two are secret, and none of the secrets is ever stored in Firebase.</p>
      <div className="mt-3 grid gap-3 lg:grid-cols-2">
        <KeyCard icon={<UserRound />} title="Admin sign-in (e-mail + password)" where="Firebase Authentication · each admin" tone="secret">
          Lets a person open this portal. What they may do is decided by their role in Admins and enforced by the Firestore security rules. Change it with
          “Forgot password” on the sign-in page. It cannot sign licenses.
        </KeyCard>
        <KeyCard icon={<Globe />} title="Firebase web config / API key" where="Built into this portal and the desktop app" tone="public">
          Only identifies the Firebase project (it starts with “AIza…”). It is visible in every browser by design and is not a password: all access is checked
          by the security rules. Nothing to rotate or hide.
        </KeyCard>
        <KeyCard icon={<FileKey2 />} title="License signing key (private, Ed25519)" where="keys\license-private.pem on the owner’s PC" tone="secret">
          Created once by <code className="rounded bg-[#f6f0fd] px-1">npm run build</code> in the desktop (DT Solar Pro) folder. It signs every license and
          activation. It is loaded below into this browser only — never uploaded, never stored in Firestore, never committed to git (the keys folder is ignored).
          Keep a USB backup. If it leaks, anyone could forge licenses: build a new key pair, ship a new installer and re-issue licenses.
        </KeyCard>
        <KeyCard icon={<ShieldCheck />} title="Public verification key" where="resources/license-public.pem inside the desktop app" tone="public">
          The matching half of the signing key. The desktop app uses it to check that a license really came from you; it cannot create licenses. After loading the
          signing key below, its public key must equal the one in the app build.
        </KeyCard>
      </div>
    </section>
  )
}
