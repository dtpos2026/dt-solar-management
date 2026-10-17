/** Settings section — Online connection, device heartbeat and location sharing consent (owner: cloud area). */
import { useCallback, useEffect, useState } from 'react'
import { MapPin, RefreshCw, Send, Wifi, WifiOff } from 'lucide-react'
import { api } from '../../api'
import { Badge, Button, Card, Field, Input, Kv, Loading, Toggle, cx, toast } from '../../components/ui'

type Mode = 'off' | 'device' | 'approximate' | 'manual'
interface Loc {
  lat: number
  lng: number
  accuracyKm: number
  source: string
  label: string
  consent: true
  updatedAt: string
}
interface Overview {
  online: boolean
  emulator: boolean
  background: boolean
  installId: string
  everyMinutes: number
  location: { mode: Mode; manual: string; manualError: string | null; location: Loc | null; note: string | null; geo: { label: string; fetchedAt: string } | null; geoError: string | null; device?: { accuracyKm: number; fetchedAt: string } | null; deviceError?: string | null }
  preview: Record<string, unknown>
  heartbeat: { lastAttemptAt: string | null; lastOkAt: string | null; ok: boolean | null; error: string | null }
}
interface Preview {
  location: Loc | null
  note: string | null
  manualError: string | null
}

const when = (iso: string | null | undefined): string => (iso ? new Date(iso).toLocaleString() : 'Never')

const SOURCE_LABEL: Record<string, string> = {
  device: "This computer's location service (Windows)",
  approximate: "Approximate (from your internet address, city level)",
  manual: 'Entered manually'
}
const accuracy = (km: number): string => (!km ? 'unknown' : km < 1 ? `about ${Math.round(km * 1000)} m` : `about ${Math.round(km * 10) / 10} km`)

export function CloudSection(): JSX.Element {
  const [ov, setOv] = useState<Overview | null>(null)
  const [mode, setMode] = useState<Mode>('off')
  const [manual, setManual] = useState('')
  const [preview, setPreview] = useState<Preview | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  const load = useCallback(async (): Promise<void> => {
    try {
      const o = await api<Overview>('cloud.overview')
      setOv(o)
      setMode(o.location.mode)
      setManual(o.location.manual)
    } catch (e) {
      toast.error(e)
    }
  }, [])
  useEffect(() => {
    void load()
  }, [load])

  // Live preview of exactly what would be sent with the draft choice (no network, nothing saved).
  useEffect(() => {
    const t = setTimeout(() => {
      api<Preview>('cloud.previewLocation', { mode, manual })
        .then(setPreview)
        .catch(() => setPreview(null))
    }, 250)
    return () => clearTimeout(t)
  }, [mode, manual])

  if (!ov) return <Loading label="Loading online settings…" />

  const dirty = mode !== ov.location.mode || manual.trim() !== ov.location.manual
  const save = async (): Promise<void> => {
    setBusy('save')
    try {
      const o = await api<Overview>('cloud.setLocation', { mode, manual })
      setOv(o)
      setMode(o.location.mode)
      setManual(o.location.manual)
      toast.ok(mode === 'off' ? 'Location sharing is off.' : 'Location sharing saved.')
    } catch (e) {
      toast.error(e)
    } finally {
      setBusy(null)
    }
  }
  const sendNow = async (): Promise<void> => {
    setBusy('send')
    try {
      const o = await api<Overview>('cloud.heartbeat')
      setOv(o)
      if (o.heartbeat.ok) toast.ok('Status sent to Digital Target.')
      else toast.error(o.heartbeat.error || 'Could not send the status.')
    } catch (e) {
      toast.error(e)
    } finally {
      setBusy(null)
    }
  }

  const sharing = mode !== 'off'
  const sent = { ...ov.preview, location: preview?.location ?? undefined }
  if (!sharing || !preview?.location) delete (sent as Record<string, unknown>).location

  return (
    <div className="space-y-4">
      <Card
        title={
          <span className="inline-flex items-center gap-2">
            {ov.online ? <Wifi className="h-4 w-4 text-ok" /> : <WifiOff className="h-4 w-4 text-muted" />} Connection with Digital Target
          </span>
        }
        actions={
          <Button size="sm" icon={<Send className="h-4 w-4" />} loading={busy === 'send'} disabled={!!busy} onClick={sendNow}>
            Send now
          </Button>
        }
      >
        <p className="mb-3 text-[13px] text-muted">
          When this computer is online, DT Solar Pro sends a short status (a “heartbeat”) to Digital Target at start-up and every {ov.everyMinutes} minutes, so your license, renewals and
          support work smoothly. It contains only the details listed under “Exactly what is sent” — never your customers, invoices, stock or accounts.
        </p>
        <div className="grid gap-x-8 text-[13px] sm:grid-cols-2">
          <Kv label="Internet">{ov.online ? <Badge tone="ok">Online</Badge> : <Badge tone="muted">Offline</Badge>}</Kv>
          <Kv label="Installation ID">
            <span className="font-mono text-[12px]">{ov.installId}</span>
          </Kv>
          <Kv label="Last attempt">{when(ov.heartbeat.lastAttemptAt)}</Kv>
          <Kv label="Last successful heartbeat">{when(ov.heartbeat.lastOkAt)}</Kv>
          <Kv label="Last result">
            {ov.heartbeat.ok === null ? '—' : ov.heartbeat.ok ? <Badge tone="ok">Sent</Badge> : <span className="text-bad">{ov.heartbeat.error || 'Failed'}</span>}
          </Kv>
          <Kv label="Automatic heartbeats">{ov.background ? `Every ${ov.everyMinutes} minutes` : 'Off in this development build (Send now still works)'}</Kv>
        </div>
        {ov.emulator && <div className="mt-2 text-[12px] text-warn">Connected to a local test server (emulator), not the live Digital Target service.</div>}
      </Card>

      <Card title={<span className="inline-flex items-center gap-2"><MapPin className="h-4 w-4 text-brand" /> Location sharing</span>}>
        <div className="space-y-3">
          <p className="text-[13px] text-muted">
            Optional. If you agree, the heartbeat also contains your business location so Digital Target can show installations on its service map and plan on-site support near you. It is
            off by default, you can turn it off at any time (the location is removed with the next heartbeat), and coordinates are never guessed.
          </p>
          <Toggle
            checked={sharing}
            onChange={(v) => setMode(v ? (mode === 'off' ? 'approximate' : mode) : 'off')}
            label="I agree to share this business's location with Digital Target"
            description="Consent can be withdrawn at any time."
          />
          {sharing && (
            <div className="grid gap-3 sm:grid-cols-2">
              {(
                [
                  ['device', "Use this computer's location service", 'Reads the Windows location service (GPS / Wi-Fi positioning) with its real accuracy. Windows location must be on (Settings → Privacy → Location). Refreshed at most every 6 hours. If it is unavailable, nothing is sent.'],
                  ['approximate', "Approximate (from your internet address, city level)", 'Looked up from your internet address via ipwho.is, about 25 km accurate or worse. Refreshed at most once a day.'],
                  ['manual', 'Exact (I enter it)', 'Type the latitude and longitude of your office, e.g. from Google Maps.']
                ] as const
              ).map(([k, t, d]) => (
                <button key={k} type="button" onClick={() => setMode(k)} className={cx('card cursor-pointer p-4 text-left', mode === k && 'ring-2 ring-brand')}>
                  <div className="font-semibold">{t}</div>
                  <div className="text-[12.5px] text-muted">{d}</div>
                </button>
              ))}
            </div>
          )}
          {sharing && mode === 'manual' && (
            <Field label="Coordinates" hint='Latitude and longitude, optionally followed by a label: 30.1979, 71.4697 | Head office' error={preview?.manualError ?? undefined}>
              <Input value={manual} maxLength={200} placeholder="30.1979, 71.4697 | Head office" onChange={(e) => setManual(e.target.value)} />
            </Field>
          )}
          {sharing && mode === ov.location.mode && (
            <div className="grid gap-x-8 rounded-xl border border-line p-3 text-[13px] sm:grid-cols-2">
              <Kv label="Source">{SOURCE_LABEL[mode] ?? mode}</Kv>
              <Kv label="Status">
                {ov.location.location ? <Badge tone="ok">Shared</Badge> : <Badge tone="warn">{mode === 'device' && ov.location.deviceError ? 'Unavailable' : 'Not available yet'}</Badge>}
              </Kv>
              <Kv label="Accuracy">{ov.location.location ? accuracy(ov.location.location.accuracyKm) : '—'}</Kv>
              <Kv label="Last update">{ov.location.location ? when(ov.location.location.updatedAt) : mode === 'device' && ov.location.device ? when(ov.location.device.fetchedAt) : '—'}</Kv>
            </div>
          )}
          {mode === 'device' && mode === ov.location.mode && ov.location.note && <div className="text-[12.5px] text-warn">{ov.location.note}</div>}
          {preview?.note && mode === 'device' && mode !== ov.location.mode && <div className="text-[12.5px] text-muted">{preview.note}</div>}
          {ov.location.geoError && mode === 'approximate' && <div className="text-[12.5px] text-warn">Last lookup failed: {ov.location.geoError}</div>}
          {preview?.note && mode === 'approximate' && <div className="text-[12.5px] text-muted">{preview.note}</div>}
          <div className="flex gap-2">
            <Button variant="primary" loading={busy === 'save'} disabled={!dirty || !!busy || (mode === 'manual' && !!preview?.manualError)} onClick={save}>
              Save choice
            </Button>
            {dirty && (
              <Button variant="ghost" icon={<RefreshCw className="h-4 w-4" />} onClick={() => (setMode(ov.location.mode), setManual(ov.location.manual))}>
                Undo
              </Button>
            )}
          </div>
        </div>
      </Card>

      <Card title="Exactly what is sent">
        <div className="mb-2 text-[12.5px] text-muted">{dirty ? 'Preview with your unsaved choice:' : 'With the current settings:'}</div>
        <pre className="max-h-80 overflow-auto rounded-xl border border-line bg-surface-2 p-3 text-[12px] whitespace-pre-wrap">{JSON.stringify(sent, null, 2)}</pre>
      </Card>
    </div>
  )
}
