/** Small shared pieces of the licensing pages: masked key with copy, masked device id, location line. */
import { useState } from 'react'
import { Check, Copy, MapPin } from 'lucide-react'
import { copy } from '../../components/ui'
import { maskDeviceId, maskLicenseKey } from '../../lib/terms'
import { LOCATION_SOURCE_LABEL, accuracyText, locationSource } from '../../lib/devices'
import { fmtDateTime, timeAgo } from '../../lib/format'
import type { HeartbeatLocation } from '../../lib/types'

/** Masked license key (lists); the copy button copies the full key. */
export function MaskedKey({ value, className = '' }: { value: string; className?: string }) {
  const [done, setDone] = useState(false)
  if (!value) return <span className="text-[#9a8fb0]">-</span>
  return (
    <span className={`inline-flex items-center gap-1 whitespace-nowrap font-mono text-[12px] ${className}`}>
      {maskLicenseKey(value)}
      <button
        type="button"
        className="rounded p-0.5 text-[#7a6d92] hover:bg-[#f1e9fb] hover:text-[#3d096d]"
        title="Copy full license key"
        aria-label="Copy full license key"
        onClick={(e) => {
          e.stopPropagation()
          copy(value)
          setDone(true)
          setTimeout(() => setDone(false), 1200)
        }}
      >
        {done ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
      </button>
    </span>
  )
}

/** Device id shortened for lists (full id in the tooltip of the detail page only). */
export function ShortDevice({ id }: { id: string }) {
  return <code className="text-[12px] text-[#7a6d92]">{maskDeviceId(id)}</code>
}

/** Last known location with its SOURCE label, accuracy and last update; "Unavailable" when none was shared. */
export function LocationLine({ loc, compact = false }: { loc: HeartbeatLocation | null; compact?: boolean }) {
  const src = locationSource(loc)
  if (!loc) return <span className="text-[#9a8fb0]">{LOCATION_SOURCE_LABEL.unavailable}</span>
  const acc = accuracyText(loc)
  const updated = loc.updatedAt ? Date.parse(loc.updatedAt) : NaN
  return (
    <span className="inline-flex flex-col">
      <span className="inline-flex items-center gap-1">
        <MapPin className="h-3.5 w-3.5 text-[#7c3aed]" />
        {loc.label || `${loc.lat.toFixed(src === 'device' ? 4 : 1)}, ${loc.lng.toFixed(src === 'device' ? 4 : 1)}`}
      </span>
      <span className="text-[12px] text-[#7a6d92]">
        {LOCATION_SOURCE_LABEL[src]}
        {acc && `, ${acc}`}
        {!compact && Number.isFinite(updated) && `, updated ${fmtDateTime(updated)} (${timeAgo(updated)})`}
      </span>
    </span>
  )
}

/** Plain-language explanation of the check-in interval and the grace period, with the real numbers of the license. */
export function GraceExplainer({ checkinDays, graceDays, detached = false, className = '' }: { checkinDays: number; graceDays: number; detached?: boolean; className?: string }) {
  if (detached || checkinDays <= 0) {
    return (
      <div className={`rounded-xl border border-[#e2d6f3] bg-[#f6f0fd] px-3.5 py-3 text-[13px] text-[#3d096d] ${className}`}>
        <b>No online check-in is required for this license.</b> The software never needs to reach Digital Target after activation, so the grace period does not apply. Only the expiry date of the license counts.
      </div>
    )
  }
  return (
    <div className={`rounded-xl border border-[#e2d6f3] bg-[#f6f0fd] px-3.5 py-3 text-[13px] leading-relaxed text-[#3d096d] ${className}`}>
      <div className="mb-1 font-bold">How check-in and grace days work</div>
      <ul className="list-disc space-y-1 pl-5">
        <li>
          <b>Check-in every {checkinDays} day{checkinDays === 1 ? '' : 's'}.</b> When the computer is online, the software verifies the license with Digital Target, so a suspension or renewal reaches it within minutes. The number is how long a computer may stay without any successful check.
        </li>
        <li>
          <b>Grace period of {graceDays} day{graceDays === 1 ? '' : 's'}.</b> If a computer could not verify for {checkinDays} days (for example it was offline), the software keeps working for {graceDays} more day{graceDays === 1 ? '' : 's'}. It shows the days left, and the Devices page shows the same countdown.
        </li>
        <li>
          <b>When grace ends</b>, the software stops and shows that verification is required. Everything returns as soon as the computer connects and verifies. Data is never deleted.
        </li>
        <li>
          <b>Expiry is different.</b> At the expiry date of the license the software stops, with no grace period. Renew the license to continue.
        </li>
        <li>A suspended or revoked license is enforced at the next check, with no grace.</li>
      </ul>
    </div>
  )
}
