/** "Reset Administrator password" for one computer: create, show the one-time temporary password, follow delivery, withdraw. */
import { useEffect, useState } from 'react'
import { Copy, KeyRound, ShieldAlert } from 'lucide-react'
import { Modal } from '../../components/ui'
import { useToast } from '../../components/kit'
import { cancelAdminPasswordReset, issueAdminPasswordReset, resetProgress, type ResetCommand } from '../../lib/passwordReset'
import { useSharedLicenses } from '../../lib/liveData'
import { useSigningKey } from '../../lib/signingKey'
import { useAdminEmail } from '../../lib/auth'
import { errorMessage, fmtDateTime } from '../../lib/format'
import { maskDeviceId } from '../../lib/terms'
import type { DeviceRow } from '../../lib/devices'
import { Notice, type NoticeMsg } from './kit'

const PROGRESS_TEXT = {
  waiting: 'Waiting for the computer. An online computer picks the reset up at its next check-in (within about 5 minutes while the app is open); an offline one needs the code below.',
  received: 'Received by the computer. The Administrator can sign in now with the temporary password and will be asked to choose a new one.',
  used: 'Used. The Administrator signed in with the temporary password and must now choose a new password.'
} as const

export function ResetPasswordDialog({ row, resetState, onClose }: { row: DeviceRow | null; resetState: string; onClose: () => void }) {
  const by = useAdminEmail()
  const { key } = useSigningKey()
  const toast = useToast()
  const licenses = useSharedLicenses(!!row)
  const [typed, setTyped] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<NoticeMsg | null>(null)
  const [cmd, setCmd] = useState<ResetCommand | null>(null)
  const [withdrawn, setWithdrawn] = useState(false)
  useEffect(() => {
    setTyped('')
    setMsg(null)
    setCmd(null)
    setWithdrawn(false)
  }, [row?.key])
  if (!row) return null
  const license = licenses.data.find((l) => l.id === row.licenseId)
  const device = { deviceId: row.deviceId, deviceName: row.deviceName }
  const progress = resetProgress(resetState, cmd?.nonce ?? null)
  const copy = (text: string, what: string) => navigator.clipboard.writeText(text).then(() => toast(`${what} copied.`), () => toast('Copy failed. Select the text and copy it manually.'))

  const create = async () => {
    if (!key || !license) return
    setMsg(null)
    setBusy(true)
    try {
      setCmd(await issueAdminPasswordReset(license, device, key, by))
    } catch (e) {
      setMsg({ tone: 'error', text: errorMessage(e) })
    } finally {
      setBusy(false)
    }
  }
  const withdraw = async () => {
    if (!license) return
    setBusy(true)
    try {
      await cancelAdminPasswordReset(license, device, by)
      setWithdrawn(true)
      setMsg({ tone: 'success', text: 'The reset was withdrawn. A computer that has not applied it yet will ignore it.' })
    } catch (e) {
      setMsg({ tone: 'error', text: errorMessage(e) })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={`Reset Administrator password · ${row.deviceName || maskDeviceId(row.deviceId)}`}
      wide
      footer={
        cmd ? (
          <>
            {!withdrawn && progress !== 'used' && <button className="btn btn-secondary" onClick={withdraw} disabled={busy}>Withdraw reset</button>}
            <button className="btn btn-primary" onClick={onClose}>Done</button>
          </>
        ) : (
          <>
            <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
            <button className="btn btn-primary" onClick={create} disabled={busy || !key || !license || typed.trim().toUpperCase() !== 'RESET'}>
              <KeyRound className="h-4 w-4" />{busy ? 'Creating…' : 'Create reset'}
            </button>
          </>
        )
      }
    >
      <Notice msg={msg} onClose={() => setMsg(null)} />
      {!cmd ? (
        <div className="space-y-3 text-[13.5px]">
          <p>
            Creates a one-time temporary password for the <b>Administrator</b> of <b>{row.company || 'this client'}</b>’s DT Solar Pro on this computer. The old password stops working only after the
            Administrator signs in with the temporary one, and a new password must be chosen straight away. Other users, PINs and all business data are not touched.
          </p>
          <ul className="list-disc space-y-1 pl-5 text-[13px] text-[#6b5d85]">
            <li>The temporary password is generated in your browser and shown <b>once</b>; it is not stored anywhere. Only a salted hash of it travels with the signed reset.</li>
            <li>The reset works only on this computer, only once, and expires in 72 hours.</li>
            <li>Verify the customer’s identity before you give them the password.</li>
          </ul>
          {!key && <Notice msg={{ tone: 'warn', text: 'Load the signing key first (Settings → Signing key): the reset is signed in your browser.' }} />}
          {key && !license && <Notice msg={{ tone: licenses.loading ? 'info' : 'error', text: licenses.loading ? 'Loading the license…' : 'The license of this computer was not found.' }} />}
          <label className="block text-[13px] font-semibold text-[#6b5d85]">Type RESET to confirm
            <input className="input mt-1 w-48" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" />
          </label>
        </div>
      ) : (
        <div className="space-y-4 text-[13.5px]">
          <Notice msg={{ tone: 'warn', text: <><ShieldAlert className="mr-1 inline h-4 w-4" />Give the customer this temporary password now. It cannot be shown again once you close this window.</> }} />
          <div>
            <div className="label">Temporary password</div>
            <div className="flex items-center gap-2">
              <code className="rounded-lg bg-[#f6f0fd] px-3 py-2 text-[20px] font-bold tracking-wider text-[#3d096d] select-all">{cmd.password}</code>
              <button className="btn btn-secondary btn-sm" onClick={() => copy(cmd.password, 'Password')}><Copy className="h-4 w-4" />Copy</button>
            </div>
            <div className="mt-1 text-[12px] text-[#7a6d92]">Valid until {fmtDateTime(cmd.expiresAt)} · one use · capitals and dashes do not matter when typing.</div>
          </div>
          <div className={withdrawn ? 'opacity-60' : ''}>
            <div className="label">Delivery</div>
            <div className="text-[13px]">{withdrawn ? 'Withdrawn.' : PROGRESS_TEXT[progress === 'none' ? 'waiting' : progress]}</div>
          </div>
          <details>
            <summary className="cursor-pointer text-[13px] font-semibold text-[#3d096d]">Computer offline? Send this reset code</summary>
            <p className="mt-2 text-[12.5px] text-[#6b5d85]">
              On the sign-in screen the customer clicks <b>Administrator locked out?</b>, pastes this code, then signs in as the Administrator with the temporary password.
            </p>
            <textarea className="input mt-2 font-mono text-[11px]" rows={4} readOnly value={cmd.code} onFocus={(e) => e.currentTarget.select()} aria-label="Reset code" />
            <button className="btn btn-secondary btn-sm mt-2" onClick={() => copy(cmd.code, 'Reset code')}><Copy className="h-4 w-4" />Copy code</button>
          </details>
        </div>
      )}
    </Modal>
  )
}
