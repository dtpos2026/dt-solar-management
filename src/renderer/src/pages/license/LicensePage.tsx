import { CSSProperties, ReactNode, useCallback, useEffect, useRef, useState } from 'react'
import { AlertTriangle, BadgeCheck, CheckCircle2, ClipboardPaste, Copy, Cpu, FileUp, Fingerprint, Info, KeyRound, Loader2, Mail, MessageCircle, Phone, RefreshCw, ShieldCheck, Unplug, Wifi, WifiOff, X } from 'lucide-react'
import { api } from '../../api'
import { LicenseStatus, useApp, useCan } from '../../store'
import { Badge, Button, Card, Field, Input, Kv, Loading, PageHeader, Tabs, Textarea, confirmDialog, cx, toast } from '../../components/ui'
import { date } from '../../lib/format'
import { VENDOR } from '@shared/branding'
import appIcon from '../../assets/app-icon.png'
import dtLogo from '../../assets/dt-logo.jpg'
import { pollDelay } from './pollDelay'

/* ------------------------------------------------ types ------------------------------------------------ */
interface LicPayload {
  licenseId: string
  customerName: string
  businessName: string
  phone?: string
  email?: string
  plan: string
  maxFirms: number
  maxUsers: number
  features: string[]
  issuedAt: string
  expiresAt: string | null
  leaseUntil: string | null
  graceDays?: number
  checkinDays?: number
}

interface Reg {
  companyName: string
  ownerName: string
  phone: string
  address: string
}

interface Lic extends Omit<LicenseStatus, 'payload'> {
  payload: LicPayload | null
  detached?: boolean
  registration?: Reg | null
  installId?: string
  certUpdate?: { at: string; summary: string } | null
  lastCheckError?: string | null
  pendingRequestId?: string | null
  pendingReason?: string | null
}

interface ActivationResult {
  pending: boolean
  requestId: string | null
  message: string
  status: Lic
}

const KEY_RE = /^DTSP(-[A-Z0-9]{4}){4}$/
/** Inline styles: form controls inherit the font from an unlayered rule, so utility classes cannot change it. */
const MONO: CSSProperties = { fontFamily: 'ui-monospace, SFMono-Regular, Consolas, "Courier New", monospace' }
const MONO_SM: CSSProperties = { ...MONO, fontSize: '11.5px' }

const MODES: Record<string, { label: string; tone: 'ok' | 'info' | 'warn' | 'bad' }> = {
  not_activated: { label: 'Not activated', tone: 'warn' },
  device_deactivated: { label: 'Device deactivated', tone: 'bad' },
  active: { label: 'Active', tone: 'ok' },
  trial: { label: 'Trial', tone: 'info' },
  grace: { label: 'Grace period', tone: 'warn' },
  trial_expired: { label: 'Trial ended', tone: 'bad' },
  expired: { label: 'Expired', tone: 'bad' },
  suspended: { label: 'Suspended', tone: 'bad' },
  revoked: { label: 'Revoked', tone: 'bad' },
  lease_expired: { label: 'Verification overdue', tone: 'bad' },
  clock_error: { label: 'Clock error', tone: 'bad' },
  invalid: { label: 'Invalid license', tone: 'bad' }
}

/* ------------------------------------------------ helpers ------------------------------------------------ */
const pad = (n: number): string => String(n).padStart(2, '0')
const ymd = (d: Date): string => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`

function localDate(iso: string | null | undefined): string {
  if (!iso) return '—'
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? String(iso) : date(ymd(d))
}

function localDateTime(iso: string | null | undefined): string {
  if (!iso) return '—'
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? String(iso) : `${date(ymd(d))} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function formatKey(v: string): string {
  const raw = v.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 20)
  return raw.match(/.{1,4}/g)?.join('-') ?? ''
}

function limit(n: number | null | undefined): string {
  return !n || n <= 0 ? 'Unlimited' : String(n)
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

async function copyText(text: string, what: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text)
    toast.ok(`${what} copied to clipboard.`)
  } catch {
    toast.error('Could not copy to the clipboard. Select the text and press Ctrl+C.')
  }
}

function openExternal(url: string): void {
  api('app.openExternal', { url }).catch((e) => toast.error(e))
}

/** When the next online verification is due (lease date, or last check + check-in interval). */
function nextCheckIn(l: Lic): string {
  const p = l.payload
  if (!p) return '—'
  if (p.leaseUntil) return localDate(p.leaseUntil)
  if (p.checkinDays && p.checkinDays > 0) {
    const base = Math.max(l.lastCheckAt ? Date.parse(l.lastCheckAt) || 0 : 0, Date.parse(p.issuedAt) || 0)
    return base ? localDate(new Date(base + p.checkinDays * 86400000).toISOString()) : '—'
  }
  return 'Not required'
}

/* ------------------------------------------------ page ------------------------------------------------ */
export function LicensePage({ embedded = false }: { embedded?: boolean } = {}): JSX.Element {
  const can = useCan()
  const user = useApp((s) => s.user)
  const version = useApp((s) => s.version)
  const lic = useApp((s) => s.license) as Lic | null
  const canManage = !user || can('license.manage')

  const [loaded, setLoaded] = useState(false)
  const [pendingId, setPendingId] = useState<string | null>(null)
  const pendingRef = useRef<string | null>(null)
  const inFlight = useRef(false)
  const [lastPoll, setLastPoll] = useState<number | null>(null)
  const [pollError, setPollError] = useState<string | null>(null)
  const [activated, setActivated] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [method, setMethod] = useState<'online' | 'offline'>('online')
  const [key, setKey] = useState('')
  const [reqCode, setReqCode] = useState('')
  const [pasted, setPasted] = useState('')
  const [reg, setReg] = useState<Reg>({ companyName: '', ownerName: '', phone: '', address: '' })

  const setLic = useCallback((s: Lic): void => useApp.getState().setLicense(s as unknown as LicenseStatus), [])

  const startPending = useCallback((id: string | null): void => {
    pendingRef.current = id
    setPendingId(id)
    setPollError(null)
  }, [])

  // Initial status (and resume polling for a request sent earlier).
  useEffect(() => {
    let alive = true
    api<Lic>('license.status')
      .then((s) => {
        if (!alive) return
        setLic(s)
        if (s.registration) setReg(s.registration)
        else if (s.payload) setReg({ companyName: s.payload.businessName ?? '', ownerName: s.payload.customerName ?? '', phone: s.payload.phone ?? '', address: '' })
        if (s.pendingRequestId) startPending(s.pendingRequestId)
        if (!s.onlineConfigured) setMethod('offline')
      })
      .catch((e) => toast.error(e))
      .finally(() => alive && setLoaded(true))
    return () => {
      alive = false
    }
  }, [setLic, startPending])

  const onActivated = useCallback(
    (r: ActivationResult): void => {
      startPending(null)
      setActivated(r.status.payload ? `Licensed to ${r.status.payload.businessName}.` : r.message)
      toast.ok(r.message)
      setKey('')
      setReqCode('')
      setPasted('')
    },
    [startPending]
  )

  const pollOnce = useCallback(async (force = false): Promise<void> => {
    if (inFlight.current || !pendingRef.current) return
    inFlight.current = true
    try {
      const r = await api<ActivationResult>('license.pollActivation', { force })
      if (!pendingRef.current) return // cancelled meanwhile
      setLic(r.status)
      setLastPoll(Date.now())
      setPollError(null)
      if (!r.pending) {
        if (r.status.payload && !/^No activation request/i.test(r.message)) onActivated(r)
        else startPending(null)
      }
    } catch (e) {
      if (!pendingRef.current) return
      // Rejected / not found clear the request on the backend; a network problem keeps it (keep polling).
      const st = await api<Lic>('license.status').catch(() => null)
      if (st) setLic(st)
      if (st && !st.pendingRequestId) {
        startPending(null)
        toast.error(e)
      } else {
        setPollError(errText(e))
        setLastPoll(Date.now())
      }
    } finally {
      inFlight.current = false
    }
  }, [setLic, onActivated, startPending])

  useEffect(() => {
    if (!pendingId) return
    const started = Date.now()
    let timer: ReturnType<typeof setTimeout>
    let stopped = false
    const next = (delay: number): void => {
      timer = setTimeout(async () => {
        await pollOnce()
        if (!stopped) next(pollDelay(Date.now() - started))
      }, delay)
    }
    next(800) // resume quickly when the page opens with a pending request
    return () => {
      stopped = true
      clearTimeout(timer)
    }
  }, [pendingId, pollOnce])

  const run = async <T,>(name: string, fn: () => Promise<T>): Promise<T | undefined> => {
    setBusy(name)
    try {
      return await fn()
    } catch (e) {
      toast.error(e)
      return undefined
    } finally {
      setBusy(null)
    }
  }

  const confirmReplace = async (): Promise<boolean> => {
    if (!lic?.payload || lic.mode !== 'active') return true
    return confirmDialog({
      title: 'Replace the current license?',
      message: (
        <>
          This computer already has an active license for <b>{lic.payload.businessName}</b>. Activating another key replaces it. Your business data is not affected.
        </>
      ),
      confirmLabel: 'Continue'
    })
  }

  const activateOnline = async (): Promise<void> => {
    if (!KEY_RE.test(key)) return toast.error('Enter a valid license key (DTSP-XXXX-XXXX-XXXX-XXXX).')
    if (!reg.companyName.trim() || !reg.ownerName.trim() || !reg.phone.trim()) return toast.error('Enter the company name, owner name and phone for the registration.')
    if (!(await confirmReplace())) return
    const r = await run('activate', () => api<ActivationResult>('license.activate', { licenseKey: key, registration: reg }))
    if (!r) {
      // The request may have been cleared (rejected / not found) — keep the store in sync.
      api<Lic>('license.status').then(setLic).catch(() => undefined)
      return
    }
    setLic(r.status)
    if (r.pending) {
      setActivated(null)
      startPending(r.requestId ?? r.status.pendingRequestId ?? 'pending')
      setLastPoll(Date.now())
      toast.info(r.message)
    } else onActivated(r)
  }

  const cancelPending = async (): Promise<void> => {
    const ok = await confirmDialog({
      title: 'Cancel activation request?',
      message: 'The app will stop waiting for approval. If Digital Target approves the request later, simply activate again with the same key.',
      confirmLabel: 'Cancel request',
      danger: true
    })
    if (!ok) return
    const st = await run('cancel', () => api<Lic>('license.cancelPending'))
    if (!st) return
    startPending(null)
    setLic(st)
    toast.info('Activation request cancelled.')
  }

  const generateCode = async (): Promise<void> => {
    if (!KEY_RE.test(key)) return toast.error('Enter a valid license key (DTSP-XXXX-XXXX-XXXX-XXXX).')
    const code = await run('code', () => api<string>('license.requestCode', { licenseKey: key }))
    if (code) {
      setReqCode(code)
      toast.ok('Request code generated. Send it to Digital Target.')
    }
  }

  const install = async (text?: string): Promise<void> => {
    if (text !== undefined && !text.trim()) return toast.error('Paste the activation code you received from Digital Target.')
    if (!(await confirmReplace())) return
    const st = await run(text ? 'paste' : 'file', () => api<Lic | null>('license.install', text ? { text: text.trim() } : {}))
    if (!st) return // cancelled or failed (error already shown)
    setLic(st)
    startPending(null)
    setActivated(st.payload ? `Licensed to ${st.payload.businessName}.` : st.message)
    setReqCode('')
    setPasted('')
    toast.ok(st.mode === 'active' ? 'License installed and activated.' : `License installed. ${st.message}`)
  }

  const checkNow = async (): Promise<void> => {
    setBusy('check')
    try {
      const st = await api<Lic>('license.checkIn')
      setLic(st)
      if (st.pendingRequestId) startPending(st.pendingRequestId)
      toast.ok(st.payload ? 'License verified online.' : 'License status refreshed.')
    } catch (e) {
      toast.error(e)
      const st = await api<Lic>('license.status').catch(() => null)
      if (st) setLic(st)
    } finally {
      setBusy(null)
    }
  }

  const reconnect = async (): Promise<void> => {
    const r = await run('reconnect', () => api<{ installed: boolean; message: string; status?: Lic }>('license.reconnect'))
    if (!r) return
    if (r.status) setLic(r.status)
    else api<Lic>('license.status').then(setLic).catch(() => undefined)
    if (r.installed) toast.ok(r.message)
    else toast.info(r.message)
  }

  if (!lic && !loaded) return <Loading label="Loading license…" />

  const checkBtn = (
    <Button icon={<RefreshCw className="h-4 w-4" />} loading={busy === 'check'} disabled={!!busy && busy !== 'check'} onClick={checkNow}>
      Check license now
    </Button>
  )

  return (
    <div className="space-y-4">
      {embedded ? (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="text-[13px] text-muted">License status and product information</div>
          {checkBtn}
        </div>
      ) : (
        <PageHeader title="License & About" subtitle="License status and product information" icon={<BadgeCheck className="h-5 w-5" />} actions={checkBtn} />
      )}

      {lic?.detached && (
        <Card title={<span className="inline-flex items-center gap-2"><Unplug className="h-4 w-4 text-brand" /> Detached lifetime license</span>}>
          <div className="space-y-2 text-[13px]">
            <p>
              This lifetime license works fully offline and no longer checks in with Digital Target. Your data and every feature stay available; the app still sends its anonymous status
              heartbeat when online.
            </p>
            <p className="text-muted">
              <b>Reconnect to Digital Target:</b> if Digital Target re-issues a connected certificate for this computer (for example after an upgrade or for support), click below while online to install it.
            </p>
            {canManage && (
              <Button size="sm" icon={<RefreshCw className="h-4 w-4" />} loading={busy === 'reconnect'} disabled={!!busy && busy !== 'reconnect'} onClick={reconnect}>
                Reconnect to Digital Target
              </Button>
            )}
          </div>
        </Card>
      )}
      {lic?.certUpdate && (
        <div className="flex items-start gap-2 rounded-xl bg-info-soft px-3 py-2 text-[12.5px] text-info">
          <Info className="mt-0.5 h-4 w-4 shrink-0" /> Updated license received {localDateTime(lic.certUpdate.at)}: {lic.certUpdate.summary}
        </div>
      )}

      {activated && (
        <div className="fade-in flex items-start gap-3 rounded-[14px] border border-ok bg-ok-soft p-4 text-ok">
          <CheckCircle2 className="mt-0.5 h-6 w-6 shrink-0" />
          <div className="flex-1">
            <div className="text-[15px] font-semibold">License activated successfully</div>
            <div className="text-[13px]">{activated} Thank you for choosing DT Solar Pro.</div>
          </div>
          <button type="button" className="cursor-pointer rounded-lg p-1 hover:bg-white/30" title="Dismiss" aria-label="Dismiss" onClick={() => setActivated(null)}>
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      {pendingId && (
        <div className="fade-in rounded-[14px] border-2 border-info bg-surface p-5 shadow-sm">
          <div className="flex flex-wrap items-start gap-4">
            <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-info-soft text-info">
              <Loader2 className="h-6 w-6 animate-spin" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-[16px] font-semibold">Waiting for approval from Digital Target…</div>
              {lic?.pendingReason && <div className="mt-1 text-[13px] font-medium text-warn">Why approval is needed: {lic.pendingReason}</div>}
              <div className="mt-0.5 text-[13px] text-muted">
                Your activation request has been sent. This page checks automatically (every few seconds at first) — the license installs itself as soon as it is approved or a device slot is free. You can keep working or close this page;
                checking resumes when you come back.
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px] text-muted">
                <span>
                  Request ID: <span className="font-mono text-ink select-all">{pendingId}</span>
                </span>
                {lastPoll && <span>Last checked {new Date(lastPoll).toLocaleTimeString()}</span>}
              </div>
              {pollError && (
                <div className="mt-2 flex items-start gap-1.5 text-[12px] text-warn">
                  <WifiOff className="mt-0.5 h-3.5 w-3.5 shrink-0" /> {pollError} Still retrying…
                </div>
              )}
              <div className="mt-2 text-[12px] text-muted">
                Taking long? Contact Digital Target on WhatsApp {VENDOR.phone} and mention the request ID.
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" icon={<RefreshCw className="h-4 w-4" />} onClick={() => void pollOnce(true)}>
                Check now
              </Button>
              <Button size="sm" icon={<MessageCircle className="h-4 w-4" />} onClick={() => openExternal(`${VENDOR.whatsapp}?text=${encodeURIComponent(`DT Solar Pro activation request ID: ${pendingId}\nDevice ID: ${lic?.deviceId ?? ''}`)}`)}>
                WhatsApp
              </Button>
              {canManage && (
                <Button size="sm" variant="ghost" className="text-bad" loading={busy === 'cancel'} onClick={cancelPending}>
                  Cancel request
                </Button>
              )}
            </div>
          </div>
        </div>
      )}

      {lic ? <StatusSection lic={lic} /> : <Card>Could not load the license status.</Card>}

      {/* ------------------------------ Activation (only while no license is installed; renewals come from Digital Target) ------------------------------ */}
      {!lic?.payload && (
      <Card title={<span className="inline-flex items-center gap-2"><KeyRound className="h-4 w-4 text-brand" /> Activate your license</span>}>
        {!canManage ? (
          <div className="flex items-start gap-2 text-[13px] text-muted">
            <Info className="mt-0.5 h-4 w-4 shrink-0" /> Only users with the “Activate / change license” permission can activate or change the license. Please ask the owner.
          </div>
        ) : (
          <div className="space-y-4">
            <Field label="License key" hint="Format: DTSP-XXXX-XXXX-XXXX-XXXX — you received it from Digital Target">
              <Input
                value={key}
                placeholder="DTSP-XXXX-XXXX-XXXX-XXXX"
                className="max-w-sm tracking-wider"
                style={MONO}
                spellCheck={false}
                onChange={(e) => {
                  setKey(formatKey(e.target.value))
                  setReqCode('')
                }}
                onKeyDown={(e) => e.key === 'Enter' && method === 'online' && KEY_RE.test(key) && !busy && !pendingId && void activateOnline()}
              />
            </Field>

            <Tabs
              className="mb-0 w-fit"
              value={method}
              onChange={setMethod}
              tabs={[
                { key: 'online', label: <span className="inline-flex items-center gap-1.5"><Wifi className="h-3.5 w-3.5" /> Online activation</span> },
                { key: 'offline', label: <span className="inline-flex items-center gap-1.5"><WifiOff className="h-3.5 w-3.5" /> Offline activation</span> }
              ]}
            />

            {method === 'online' ? (
              <div className="space-y-3">
                <ol className="list-decimal space-y-1 pl-5 text-[13px] text-muted">
                  <li>Enter your license key above and click Activate. Internet is needed only once, for activation.</li>
                  <li>Your request is sent to Digital Target for approval together with this computer’s Device ID.</li>
                  <li>When it is approved, the license installs automatically on this computer.</li>
                </ol>
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label="Company name" required>
                    <Input value={reg.companyName} maxLength={200} onChange={(e) => setReg({ ...reg, companyName: e.target.value })} />
                  </Field>
                  <Field label="Owner name" required>
                    <Input value={reg.ownerName} maxLength={200} onChange={(e) => setReg({ ...reg, ownerName: e.target.value })} />
                  </Field>
                  <Field label="Phone" required>
                    <Input value={reg.phone} maxLength={60} onChange={(e) => setReg({ ...reg, phone: e.target.value })} />
                  </Field>
                  <Field label="Address">
                    <Input value={reg.address} maxLength={300} onChange={(e) => setReg({ ...reg, address: e.target.value })} />
                  </Field>
                </div>
                {!lic?.onlineConfigured && (
                  <div className="flex items-start gap-2 rounded-xl bg-warn-soft px-3 py-2 text-[12.5px] text-warn">
                    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /> Online activation is not available in this build. Please use Offline activation.
                  </div>
                )}
                <Button
                  variant="primary"
                  icon={<Wifi className="h-4 w-4" />}
                  loading={busy === 'activate'}
                  disabled={!KEY_RE.test(key) || !!pendingId || !lic?.onlineConfigured || (!!busy && busy !== 'activate')}
                  onClick={activateOnline}
                >
                  Activate
                </Button>
                {pendingId && <div className="text-[12px] text-muted">A request is already waiting for approval (see above). Cancel it first to use a different key.</div>}
              </div>
            ) : (
              <div className="grid gap-5 lg:grid-cols-2">
                <div className="space-y-3">
                  <div className="font-semibold">Step 1 — Send a request code</div>
                  <Button icon={<KeyRound className="h-4 w-4" />} loading={busy === 'code'} disabled={!KEY_RE.test(key) || (!!busy && busy !== 'code')} onClick={generateCode}>
                    Generate request code
                  </Button>
                  {reqCode && (
                    <div className="space-y-2">
                      <Textarea readOnly rows={5} value={reqCode} className="break-all" style={MONO_SM} onFocus={(e) => e.target.select()} />
                      <div className="flex flex-wrap gap-2">
                        <Button size="sm" icon={<Copy className="h-4 w-4" />} onClick={() => copyText(reqCode, 'Request code')}>
                          Copy
                        </Button>
                        <Button size="sm" variant="success" icon={<MessageCircle className="h-4 w-4" />} onClick={() => openExternal(`${VENDOR.whatsapp}?text=${encodeURIComponent(`DT Solar Pro offline activation\nLicense key: ${key}\nRequest code:\n${reqCode}`)}`)}>
                          Send by WhatsApp
                        </Button>
                        <Button
                          size="sm"
                          icon={<Mail className="h-4 w-4" />}
                          onClick={() =>
                            openExternal(`mailto:${VENDOR.email}?subject=${encodeURIComponent(`DT Solar Pro activation request — ${key}`)}&body=${encodeURIComponent(`License key: ${key}\nDevice ID: ${lic?.deviceId ?? ''}\n\nRequest code:\n${reqCode}`)}`)
                          }
                        >
                          Send by email
                        </Button>
                      </div>
                    </div>
                  )}
                  <div className="text-[12.5px] leading-relaxed text-muted">
                    Send the request code to Digital Target by WhatsApp ({VENDOR.phone}) or email ({VENDOR.email}). You will receive a license file (.dtlic) or an activation code for this computer.
                  </div>
                </div>
                <div className="space-y-3">
                  <div className="font-semibold">Step 2 — Install the license you received</div>
                  <Button icon={<FileUp className="h-4 w-4" />} loading={busy === 'file'} disabled={!!busy && busy !== 'file'} onClick={() => install()}>
                    Install license file…
                  </Button>
                  <div className="text-[12px] text-muted">or paste the activation code:</div>
                  <Textarea rows={4} value={pasted} placeholder="Paste the activation code here…" className="break-all" style={MONO_SM} spellCheck={false} onChange={(e) => setPasted(e.target.value)} />
                  <Button variant="primary" icon={<ClipboardPaste className="h-4 w-4" />} loading={busy === 'paste'} disabled={!pasted.trim() || (!!busy && busy !== 'paste')} onClick={() => install(pasted)}>
                    Activate with code
                  </Button>
                </div>
              </div>
            )}
            {lic && !lic.signingConfigured && <div className="text-[12px] text-warn">Note: license verification is not configured in this build, so license files cannot be installed. Contact Digital Target for an updated installer.</div>}
          </div>
        )}
      </Card>
      )}

      {/* ------------------------------ About ------------------------------ */}
      <About version={version} />
    </div>
  )
}

/* ------------------------------------------------ status ------------------------------------------------ */
function StatusSection({ lic }: { lic: Lic }): JSX.Element {
  const m = MODES[lic.mode] ?? { label: lic.mode, tone: 'bad' as const }
  const p = lic.payload
  const daysLeft = lic.mode === 'trial' || lic.mode === 'trial_expired' ? lic.trialDaysLeft : lic.mode === 'grace' || lic.mode === 'lease_expired' ? lic.graceDaysLeft : lic.daysLeft
  const daysLabel = lic.mode === 'trial' || lic.mode === 'trial_expired' ? 'Trial days left' : lic.mode === 'grace' || lic.mode === 'lease_expired' ? 'Grace days left' : 'Days left'
  const heroIcon = { ok: 'bg-ok text-white', info: 'bg-info text-white', warn: 'bg-warn text-white', bad: 'bg-bad text-white' }[m.tone]
  return (
    <div className="grid gap-4 lg:grid-cols-[1.5fr_1fr]">
      <div className="card overflow-hidden">
        <div className={cx('flex items-start gap-4 border-b border-line p-5', { ok: 'bg-ok-soft', info: 'bg-info-soft', warn: 'bg-warn-soft', bad: 'bg-bad-soft' }[m.tone])}>
          <div className={cx('flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl shadow-sm', heroIcon)}>{m.tone === 'ok' ? <ShieldCheck className="h-6 w-6" /> : <AlertTriangle className="h-6 w-6" />}</div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[17px] font-bold">{p ? p.businessName : 'DT Solar Pro'}</span>
              <Badge tone={m.tone}>{m.label}</Badge>
              {lic.canWrite ? <Badge tone="muted">Full access</Badge> : <Badge tone="bad">Read-only</Badge>}
            </div>
            <div className="mt-1 text-[13px]">{lic.message}</div>
          </div>
          {daysLeft !== null && daysLeft !== undefined && (
            <div className="text-right">
              <div className="num text-[26px] leading-none font-bold">{Math.max(0, daysLeft)}</div>
              <div className="text-[11.5px] text-muted">{daysLabel}</div>
            </div>
          )}
        </div>
        <div className="grid gap-x-8 p-5 text-[13px] sm:grid-cols-2">
          <Kv label="Licensed business">{p?.businessName ?? '—'}</Kv>
          <Kv label="Customer">{p?.customerName ?? '—'}</Kv>
          <Kv label="Plan">{p ? p.plan : lic.mode === 'trial' || lic.mode === 'trial_expired' ? 'Trial' : '—'}</Kv>
          <Kv label="License ID">{p ? <span className="font-mono text-[12px]">{p.licenseId}</span> : '—'}</Kv>
          <Kv label="Max firms">{limit(lic.maxFirms)}</Kv>
          <Kv label="Max users">{limit(lic.maxUsers)}</Kv>
          <Kv label="Issued">{p ? localDate(p.issuedAt) : '—'}</Kv>
          <Kv label="Expires">{p ? (p.expiresAt ? localDate(p.expiresAt) : 'Lifetime') : '—'}</Kv>
          <Kv label="Next online check-in">{nextCheckIn(lic)}</Kv>
          <Kv label="Last check-in">{lic.lastCheckAt ? localDateTime(lic.lastCheckAt) : 'Never'}</Kv>
        </div>
        {(lic.lastCheckError || (p && p.features?.length > 0)) && (
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line px-5 py-3">
            <div className="min-w-0 space-y-1">
              {p && p.features?.length > 0 && (
                <div className="flex flex-wrap gap-1">
                  {p.features.map((f) => (
                    <Badge key={f} tone="brand">
                      {f}
                    </Badge>
                  ))}
                </div>
              )}
              {lic.lastCheckError && (
                <div className="flex items-start gap-1.5 text-[12px] text-muted" title={lic.lastCheckError}>
                  <WifiOff className="mt-0.5 h-3.5 w-3.5 shrink-0" /> Last online check did not complete: {lic.lastCheckError}
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      <div className="space-y-4">
        <Card title={<span className="inline-flex items-center gap-2"><Fingerprint className="h-4 w-4 text-brand" /> This computer</span>}>
          <div className="text-[12px] text-muted">Device ID</div>
          <div className="mt-1 flex items-center gap-2">
            <span className="flex-1 rounded-lg border border-line bg-surface-2 px-3 py-2 font-mono text-[14px] font-semibold tracking-wider select-all">{lic.deviceId}</span>
            <Button size="sm" icon={<Copy className="h-4 w-4" />} onClick={() => copyText(lic.deviceId, 'Device ID')}>
              Copy
            </Button>
          </div>
          <div className="mt-2 flex items-center gap-1.5 text-[12px] text-muted">
            <Cpu className="h-3.5 w-3.5" /> Computer name: <span className="text-ink">{lic.deviceName || '—'}</span>
          </div>
          <div className="mt-1 text-[11.5px] text-muted">A license is tied to this Device ID. Share it with Digital Target when asked.</div>
        </Card>
        <Card title={<span className="inline-flex items-center gap-2"><ShieldCheck className="h-4 w-4 text-brand" /> How licensing works</span>}>
          <ul className="list-disc space-y-1.5 pl-5 text-[13px] leading-relaxed text-muted">
            <li>
              <b className="text-ink">Managed by Digital Target.</b> Activation, renewal, suspension and the limits of your plan are handled by Digital Target. A renewal reaches this computer automatically.
            </li>
            <li>
              <b className="text-ink">Works offline.</b> The app keeps working without internet and verifies the license whenever it is online.
            </li>
            <li>
              <b className="text-ink">Grace period.</b> If the license cannot be verified for the allowed number of days, a grace period begins and the days left are shown here. Connect to the internet and press Check license now.
            </li>
            <li>
              <b className="text-ink">Your data is never deleted.</b> If access is stopped, the screen explains why and you can still take a backup.
            </li>
          </ul>
        </Card>
      </div>
    </div>
  )
}

/* ------------------------------------------------ about ------------------------------------------------ */
function About({ version }: { version: string }): JSX.Element {
  const tel = `tel:${VENDOR.phone.replace(/[^\d+]/g, '')}`
  return (
    <Card title={<span className="inline-flex items-center gap-2"><Info className="h-4 w-4 text-brand" /> About</span>}>
      <div className="grid gap-6 md:grid-cols-2">
        <div className="flex items-start gap-4">
          <img src={appIcon} alt="DT Solar Pro" className="h-16 w-16 rounded-2xl shadow-md" />
          <div>
            <div className="text-[20px] font-extrabold">
              DT Solar <span className="text-sun">Pro</span>
            </div>
            <div className="text-[12.5px] text-muted">{VENDOR.tagline}</div>
            <div className="mt-2 flex flex-wrap gap-2 text-[12.5px]">
              <Badge tone="brand">Version {version || '—'}</Badge>
              <Badge tone="muted">Offline desktop edition</Badge>
            </div>
            <div className="mt-2 text-[12px] text-muted">© {new Date().getFullYear()} {VENDOR.company}. All rights reserved.</div>
          </div>
        </div>
        <div className="flex items-start gap-4">
          <img src={dtLogo} alt="Digital Target" className="h-16 w-16 rounded-2xl bg-white object-contain shadow-md" />
          <div className="min-w-0">
            <div className="text-[12px] text-muted">Developed by</div>
            <div className="text-[16px] font-bold tracking-wide">{VENDOR.company.toUpperCase()}</div>
            <div className="mt-1 space-y-0.5 text-[12.5px] text-muted">
              <ContactLine icon={<Mail className="h-3.5 w-3.5" />}>{VENDOR.email}</ContactLine>
              <ContactLine icon={<Phone className="h-3.5 w-3.5" />}>{VENDOR.phone}</ContactLine>
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              <Button size="sm" icon={<Mail className="h-4 w-4" />} onClick={() => openExternal(`mailto:${VENDOR.email}?subject=${encodeURIComponent('DT Solar Pro support')}`)}>
                Email
              </Button>
              <Button size="sm" icon={<Phone className="h-4 w-4" />} onClick={() => openExternal(tel)}>
                Call
              </Button>
              <Button size="sm" variant="success" icon={<MessageCircle className="h-4 w-4" />} onClick={() => openExternal(VENDOR.whatsapp)}>
                WhatsApp
              </Button>
            </div>
          </div>
        </div>
      </div>
    </Card>
  )
}

function ContactLine({ icon, children }: { icon: ReactNode; children: ReactNode }): JSX.Element {
  return (
    <div className="flex items-center gap-1.5">
      {icon}
      <span className="select-all">{children}</span>
    </div>
  )
}
