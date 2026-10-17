import { useEffect, useState } from 'react'
import { MapPin } from 'lucide-react'
import { api } from '../api'
import { useApp } from '../store'
import { Button, Modal, toast } from './ui'
import { STATUS_TEXT, type LocationInfo } from '../pages/settings/CloudSection'

/**
 * Asked once, to the owner, at the first sign-in of a licensed installation. Plain words about what is shared, why, and that
 * Windows has the last word. Declining is respected and can be changed later in Settings. Nothing is shared before the answer.
 */
export function LocationConsent(): JSX.Element | null {
  const user = useApp((s) => s.user)
  const licensed = useApp((s) => !!s.license?.payload)
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<LocationInfo | null>(null)

  useEffect(() => {
    if (!user?.isOwner || !licensed) return
    let alive = true
    api<{ needed: boolean }>('cloud.locationPrompt')
      .then((r) => alive && r.needed && setOpen(true))
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [user?.id, user?.isOwner, licensed])

  const answer = async (allow: boolean): Promise<void> => {
    setBusy(true)
    try {
      const o = await api<{ location: LocationInfo }>('cloud.answerLocation', { allow })
      if (!allow) {
        setOpen(false)
        toast.ok('Location sharing is off. You can turn it on later in Settings.')
      } else if (o.location.status === 'sharing') {
        setOpen(false)
        toast.ok('Location sharing is on.')
      } else {
        // Windows did not give a position: explain why instead of closing silently.
        setResult(o.location)
      }
    } catch (e) {
      toast.error(e)
    } finally {
      setBusy(false)
    }
  }

  if (!open) return null
  const st = result ? STATUS_TEXT[result.status] : null
  const blocked = result?.status === 'os_denied' || result?.status === 'service_off'
  return (
    <Modal
      open
      onClose={() => undefined}
      size="sm"
      title={
        <span className="inline-flex items-center gap-2">
          <MapPin className="h-5 w-5 text-brand" /> Share this computer's location?
        </span>
      }
      footer={
        result ? (
          <>
            {blocked && <Button onClick={() => api('cloud.openLocationSettings').catch((e) => toast.error(e))}>Open Windows location settings</Button>}
            <Button variant="primary" onClick={() => setOpen(false)}>Continue</Button>
          </>
        ) : (
          <>
            <Button variant="ghost" disabled={busy} onClick={() => void answer(false)}>Not now</Button>
            <Button variant="primary" loading={busy} onClick={() => void answer(true)}>Allow</Button>
          </>
        )
      }
    >
      {!result ? (
        <div className="space-y-3 text-[13.5px]">
          <p>
            DT Solar Pro can send the position of this computer to <b>Digital Target</b>, who supply and support your software. It helps with on-site support and with protecting your license.
          </p>
          <ul className="list-disc space-y-1.5 pl-5 text-muted">
            <li>The position comes from the Windows location service (GPS or Wi-Fi positioning), with its real accuracy. It is never guessed from your internet address.</li>
            <li>It is updated automatically while the computer is online. Nothing is sent while it is offline.</li>
            <li>Windows decides whether the app may read the location. If Windows blocks it, the app shows how to turn it on and sends nothing.</li>
            <li>You can stop sharing at any time in Settings, Device location.</li>
          </ul>
        </div>
      ) : (
        <div className="space-y-2 text-[13.5px]">
          <p>
            Sharing is switched on, but no position is available yet: <b>{st?.label}</b>.
          </p>
          <p className="text-muted">{result.note}</p>
          <p className="text-muted">The app keeps trying automatically. You can also check again in Settings, Device location.</p>
        </div>
      )}
    </Modal>
  )
}
