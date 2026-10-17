import { useEffect, useState } from 'react'
import { Download, Mail, MessageCircle, Phone, RefreshCw, ShieldAlert } from 'lucide-react'
import { VENDOR } from '@shared/branding'
import { BLOCK_TITLE } from '@shared/licenseBlock'
import { api } from '../../api'
import { LicenseStatus, useApp } from '../../store'
import { Button, Kv, toast } from '../../components/ui'
import { AppLogo, VendorLine } from '../../components/Brand'
import { date } from '../../lib/format'

const STATUS_LABEL: Record<string, string> = {
  suspended: 'Suspended',
  revoked: 'Revoked',
  device_deactivated: 'Computer deactivated',
  expired: 'Expired',
  trial_expired: 'Trial ended',
  lease_expired: 'Verification overdue',
  clock_error: 'Date and time problem',
  invalid: 'Invalid license'
}

const NEXT_STEP: Record<string, string> = {
  expired: 'Contact Digital Target to renew your license. Access returns automatically after the renewal.',
  trial_expired: 'Contact Digital Target to buy a license. Access returns automatically after activation.',
  lease_expired: 'Connect this computer to the internet. The license is verified automatically and access returns at once.',
  clock_error: 'Correct the date and time of this computer. Access returns automatically.',
  invalid: 'Contact Digital Target with the details below.'
}

function when(iso: string | null | undefined): string {
  if (!iso) return 'Not yet'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return String(iso)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${date(`${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`)} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/**
 * Shown instead of the application whenever the installation is blocked (suspended, revoked, computer deactivated, expired,
 * verification overdue). The main process refuses every protected route meanwhile, so this is not only a cover. It re-checks
 * with Digital Target by itself (every 30 s) and on request, and opens the application again as soon as access is restored.
 */
export function LicenseBlockedScreen({ license, onLogout }: { license: LicenseStatus; onLogout: () => void }): JSX.Element {
  const [checking, setChecking] = useState(false)
  const [backingUp, setBackingUp] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const p = license.payload
  const title = BLOCK_TITLE[license.mode] ?? 'Access is blocked'
  const statusText = STATUS_LABEL[license.mode] ?? license.mode
  const info = license as LicenseStatus & { lastCheckError?: string | null }

  // The main process checks every 30 s while blocked; this keeps the clock of "last checked" honest on screen.
  const [, tick] = useState(0)
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 15000)
    return () => clearInterval(t)
  }, [])

  const check = async (): Promise<void> => {
    setChecking(true)
    setNote(null)
    try {
      const st = await api<LicenseStatus>('license.checkIn')
      useApp.getState().setLicense(st)
      if (!st.canWrite) setNote(info.lastCheckError && /reach|internet|respond/i.test(info.lastCheckError) ? 'Could not reach Digital Target. Check the internet connection.' : `Checked just now: still ${statusText.toLowerCase()}.`)
    } catch (e) {
      setNote((e as Error).message)
    } finally {
      setChecking(false)
    }
  }

  const backup = async (): Promise<void> => {
    setBackingUp(true)
    try {
      const r = await api<{ file: string } | null>('jsonBackup.export')
      if (r) toast.ok(`Backup saved: ${r.file}`)
    } catch (e) {
      toast.error(e)
    } finally {
      setBackingUp(false)
    }
  }

  const open = (url: string): void => {
    api('app.openExternal', { url }).catch((e) => toast.error(e))
  }

  return (
    <div className="flex h-full items-center justify-center overflow-y-auto bg-surface-2 p-6" data-testid="license-blocked">
      <div className="card w-full max-w-[640px] overflow-hidden">
        <div className="flex items-center justify-between gap-3 border-b border-line px-6 py-4">
          <AppLogo size={36} />
          <button type="button" className="cursor-pointer text-[13px] text-muted hover:text-ink" onClick={onLogout}>
            Sign out
          </button>
        </div>
        <div className="px-6 py-6">
          <div className="flex items-start gap-4">
            <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl bg-bad-soft text-bad">
              <ShieldAlert className="h-7 w-7" />
            </div>
            <div className="min-w-0">
              <h1 className="text-[22px] leading-tight font-bold">{title}</h1>
              <p className="mt-1 text-[14px]">{license.message}</p>
              <p className="mt-2 text-[14px] font-semibold text-bad">{NEXT_STEP[license.mode] ?? 'Contact Digital Target to restore access.'}</p>
            </div>
          </div>

          <div className="mt-5 grid gap-x-8 rounded-xl border border-line bg-surface-2 px-4 py-3 text-[13px] sm:grid-cols-2">
            <Kv label="Status">
              <span className="font-semibold text-bad">{statusText}</span>
            </Kv>
            <Kv label="Licensed business">{p?.businessName ?? 'Not available'}</Kv>
            <Kv label="License ID">{p ? <span className="font-mono text-[12px]">{p.licenseId}</span> : 'Not available'}</Kv>
            <Kv label="Expiry">{p ? (p.expiresAt ? when(p.expiresAt).slice(0, 11) : 'Lifetime') : 'Not available'}</Kv>
            <Kv label="Computer ID">
              <span className="font-mono text-[12px] select-all">{license.deviceId}</span>
            </Kv>
            <Kv label="Last verified">{when(license.lastCheckAt)}</Kv>
          </div>

          <div className="mt-5">
            <div className="mb-2 text-[13px] font-semibold">Contact Digital Target</div>
            <div className="flex flex-wrap gap-2">
              <Button variant="success" icon={<MessageCircle className="h-4 w-4" />} onClick={() => open(`${VENDOR.whatsapp}?text=${encodeURIComponent(`DT Solar Pro: ${statusText}\nLicense: ${p?.licenseId ?? ''}\nComputer: ${license.deviceId}`)}`)}>
                WhatsApp
              </Button>
              <Button icon={<Phone className="h-4 w-4" />} onClick={() => open(`tel:${VENDOR.phone.replace(/[^\d+]/g, '')}`)}>
                {VENDOR.phone}
              </Button>
              <Button icon={<Mail className="h-4 w-4" />} onClick={() => open(`mailto:${VENDOR.email}?subject=${encodeURIComponent(`DT Solar Pro ${statusText}`)}`)}>
                {VENDOR.email}
              </Button>
            </div>
          </div>

          <div className="mt-6 flex flex-wrap items-center gap-3 border-t border-line pt-4">
            <Button variant="primary" icon={<RefreshCw className={`h-4 w-4 ${checking ? 'animate-spin' : ''}`} />} disabled={checking} onClick={() => void check()}>
              Check again
            </Button>
            <Button icon={<Download className="h-4 w-4" />} loading={backingUp} onClick={() => void backup()}>
              Back up my data
            </Button>
            <div className="text-[12.5px] text-muted">
              {note ?? 'Checked automatically every 30 seconds. Access returns as soon as Digital Target restores it.'}
            </div>
          </div>
          <p className="mt-4 text-[12.5px] text-muted">Your business data has not been deleted. It stays safe on this computer, and you can take a backup at any time.</p>
        </div>
        <div className="border-t border-line px-6 py-3">
          <VendorLine />
        </div>
      </div>
    </div>
  )
}
