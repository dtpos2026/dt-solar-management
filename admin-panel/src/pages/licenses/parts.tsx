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
  if (!value) return <span className="text-[#9a8fb0]">—</span>
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
  return <code className="text-[11px] text-[#7a6d92]">{maskDeviceId(id)}</code>
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
      <span className="text-[11.5px] text-[#7a6d92]">
        {LOCATION_SOURCE_LABEL[src]}
        {acc && ` · ${acc}`}
        {!compact && Number.isFinite(updated) && ` · updated ${fmtDateTime(updated)} (${timeAgo(updated)})`}
      </span>
    </span>
  )
}
