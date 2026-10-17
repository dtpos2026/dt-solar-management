/** Settings section: connection with Digital Target and device location sharing (owner consent, precise Windows location only). */
import { useCallback, useEffect, useState } from 'react'
import { MapPin, Wifi, WifiOff } from 'lucide-react'
import { api } from '../../api'
import { Badge, Button, Card, Kv, Loading, confirmDialog, toast } from '../../components/ui'

export type LocStatus = 'sharing' | 'not_asked' | 'declined' | 'os_denied' | 'service_off' | 'unavailable' | 'waiting'

interface Loc {
  lat: number
  lng: number
  accuracyKm: number
  source: string
  label: string
  consent: true
  updatedAt: string
}
export interface LocationInfo {
  mode: 'off' | 'device'
  prompted: boolean
  status: LocStatus
  location: Loc | null
  note: string | null
  device: { accuracyKm: number; fetchedAt: string } | null
  deviceError: string | null
}
interface Overview {
  online: boolean
  emulator: boolean
  background: boolean
  installId: string
  everyMinutes: number
  location: LocationInfo
  preview: Record<string, unknown>
  heartbeat: { lastAttemptAt: string | null; lastOkAt: string | null; ok: boolean | null; error: string | null }
}

const when = (iso: string | null | undefined): string => (iso ? new Date(iso).toLocaleString() : 'Never')
const accuracy = (km: number): string => (!km ? 'not reported' : km < 1 ? `about ${Math.round(km * 1000)} m` : `about ${Math.round(km * 10) / 10} km`)

export const STATUS_TEXT: Record<LocStatus, { label: string; tone: 'ok' | 'warn' | 'muted' | 'bad' }> = {
  sharing: { label: 'Sharing', tone: 'ok' },
  not_asked: { label: 'Not set up', tone: 'muted' },
  declined: { label: 'Off', tone: 'muted' },
  os_denied: { label: 'Blocked by Windows', tone: 'bad' },
  service_off: { label: 'Windows location is off', tone: 'bad' },
  unavailable: { label: 'Position not available', tone: 'warn' },
  waiting: { label: 'Reading position', tone: 'warn' }
}

export function CloudSection(): JSX.Element {
  const [ov, setOv] = useState<Overview | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  const load = useCallback(async (): Promise<void> => {
    try {
      setOv(await api<Overview>('cloud.overview'))
    } catch (e) {
      toast.error(e)
    }
  }, [])
  useEffect(() => {
    void load()
  }, [load])

  if (!ov) return <Loading label="Loading online settings…" />

  const loc = ov.location
  const on = loc.mode === 'device'
  const st = STATUS_TEXT[loc.status]
  const blockedByWindows = loc.status === 'os_denied' || loc.status === 'service_off'

  const answer = async (allow: boolean): Promise<void> => {
    if (!allow) {
      const ok = await confirmDialog({
        title: 'Stop sharing the location?',
        confirmLabel: 'Stop sharing',
        danger: true,
        message: 'Digital Target will no longer receive the position of this computer. The last position is removed with the next status update.'
      })
      if (!ok) return
    }
    setBusy('answer')
    try {
      const o = await api<Overview>('cloud.answerLocation', { allow })
      setOv(o)
      toast.ok(allow ? 'Location sharing is on.' : 'Location sharing is off.')
    } catch (e) {
      toast.error(e)
    } finally {
      setBusy(null)
    }
  }
  const openWindows = (): void => {
    api('cloud.openLocationSettings').catch((e) => toast.error(e))
  }

  return (
    <div className="space-y-4">
      <Card
        title={
          <span className="inline-flex items-center gap-2">
            {ov.online ? <Wifi className="h-4 w-4 text-ok" /> : <WifiOff className="h-4 w-4 text-muted" />} Connection with Digital Target
          </span>
        }
      >
        <p className="mb-3 text-[13px] text-muted">
          When this computer is online, DT Solar Pro sends a short status to Digital Target at start-up and every {ov.everyMinutes} minutes, so your license, renewals and support work smoothly.
          It contains only the details listed under Exactly what is sent. Your customers, invoices, stock and accounts are never sent.
        </p>
        <div className="grid gap-x-8 text-[13px] sm:grid-cols-2">
          <Kv label="Internet">{ov.online ? <Badge tone="ok">Online</Badge> : <Badge tone="muted">Offline</Badge>}</Kv>
          <Kv label="Installation ID">
            <span className="font-mono text-[12px]">{ov.installId}</span>
          </Kv>
          <Kv label="Last status sent">{when(ov.heartbeat.lastOkAt)}</Kv>
          <Kv label="Last result">
            {ov.heartbeat.ok === null ? 'Not sent yet' : ov.heartbeat.ok ? <Badge tone="ok">Sent</Badge> : <span className="text-bad">{ov.heartbeat.error || 'Failed'}</span>}
          </Kv>
        </div>
        {ov.emulator && <div className="mt-2 text-[12.5px] text-warn">Connected to a local test server, not the live Digital Target service.</div>}
      </Card>

      <Card title={<span className="inline-flex items-center gap-2"><MapPin className="h-4 w-4 text-brand" /> Device location</span>}>
        <div className="space-y-3">
          <p className="text-[13px] text-muted">
            With your consent, this computer shares its position with Digital Target, read from the Windows location service (GPS or Wi-Fi positioning). It is updated automatically while the computer is online and
            helps Digital Target support you and protect your license. The position is never guessed from the internet address, and Windows always decides whether the app may read it.
          </p>
          <div className="grid gap-x-8 rounded-xl border border-line p-3 text-[13px] sm:grid-cols-2">
            <Kv label="Sharing">
              <Badge tone={st.tone}>{st.label}</Badge>
            </Kv>
            <Kv label="Connection">{ov.online ? 'Online. Updates are sent automatically.' : 'Offline. The position is sent when the computer is online again.'}</Kv>
            <Kv label="Last position">{loc.location ? when(loc.location.updatedAt) : loc.device ? when(loc.device.fetchedAt) : 'None yet'}</Kv>
            <Kv label="Accuracy">{loc.location ? accuracy(loc.location.accuracyKm) : 'Not available'}</Kv>
          </div>
          {loc.note && loc.status !== 'sharing' && <div className="text-[13px] text-warn">{loc.note}</div>}
          <div className="flex flex-wrap gap-2">
            {on ? (
              <Button variant="ghost" className="text-bad" loading={busy === 'answer'} disabled={!!busy} onClick={() => answer(false)}>
                Stop sharing
              </Button>
            ) : (
              <Button variant="primary" loading={busy === 'answer'} disabled={!!busy} onClick={() => answer(true)}>
                Share this computer's location
              </Button>
            )}
            {on && blockedByWindows && (
              <Button onClick={openWindows}>Open Windows location settings</Button>
            )}
            {on && (loc.status === 'unavailable' || blockedByWindows) && (
              <Button loading={busy === 'answer'} disabled={!!busy} onClick={() => answer(true)}>
                Check again
              </Button>
            )}
          </div>
        </div>
      </Card>

      <Card title="Exactly what is sent">
        <pre className="max-h-80 overflow-auto rounded-xl border border-line bg-surface-2 p-3 text-[12.5px] whitespace-pre-wrap">{JSON.stringify(ov.preview, null, 2)}</pre>
      </Card>
    </div>
  )
}
