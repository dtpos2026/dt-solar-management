/**
 * Device map: only heartbeats that carry a consented location (the latest heartbeat of each computer); colour = online
 * status. No invented coordinates and no geocoding: computers without a location are listed as "Location unavailable".
 * Every marker says where its point comes from: IP points are approximate (usually the ISP's city) and drawn with
 * their accuracy circle; device-service points show their accuracy in metres. "Remove device" works from the popup
 * and from the list and takes the marker off the map at once.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { MapPinOff, RefreshCw, Trash2 } from 'lucide-react'
import { PageTitle } from '../components/ui'
import { DEVICE_STATUS_LABEL, LOCATION_SOURCE_LABEL, accuracyMetres, accuracyText, filterDeviceRows, type DeviceFilter, type DeviceRow } from '../lib/devices'
import { maskDeviceId } from '../lib/terms'
import { ONLINE_THRESHOLD_LABEL } from '../lib/stats'
import { fmtDateTime, timeAgo } from '../lib/format'
import { useCan } from '../lib/auth'
import { Empty, Loading, Notice, Panel, Pill, SearchBox, type NoticeMsg } from './licensing/kit'
import { useBranding } from './licensing/hooks'
import { useFleet } from './licensing/useFleet'
import { RemoveDeviceDialog, useRemovedRows } from './licensing/RemoveDevice'

const COLOR: Record<string, string> = { online: '#16a34a', recent: '#f59e0b', offline: '#64748b', never: '#94a3b8' }

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)

function popupHtml(r: DeviceRow, canRemove: boolean): string {
  const loc = r.location!
  const updated = loc.updatedAt && Number.isFinite(Date.parse(loc.updatedAt)) ? Date.parse(loc.updatedAt) : null
  const acc = accuracyText(loc)
  const digits = loc.source === 'device' ? 4 : 1
  const links = [
    r.licenseId ? `<a href="#/licenses/${esc(r.licenseId)}">Open license</a>` : '',
    canRemove ? `<button type="button" data-remove="1" style="color:#b91c1c;font-weight:600;text-decoration:underline">Remove device</button>` : ''
  ].filter(Boolean)
  return `<div style="font-size:12.5px;line-height:1.5;min-width:230px">
    <b>${esc(r.deviceName || 'Computer')}</b> <span style="color:#7a6d92">${esc(maskDeviceId(r.deviceId))}</span><br/>
    Company: ${esc(r.company || '—')}<br/>
    Last seen: ${esc(r.lastSeenMs ? `${fmtDateTime(r.lastSeenMs)} (${timeAgo(r.lastSeenMs)})` : '—')}<br/>
    Location: ${esc(loc.label || `${loc.lat.toFixed(digits)}, ${loc.lng.toFixed(digits)}`)}<br/>
    Location time: ${esc(updated ? `${fmtDateTime(updated)} (${timeAgo(updated)})` : 'unknown')}<br/>
    Accuracy: ${esc(acc || 'unknown')}<br/>
    Source: ${esc(LOCATION_SOURCE_LABEL[loc.source])}<br/>
    Device: ${esc(DEVICE_STATUS_LABEL[r.deviceStatus])} · License: ${esc(r.licenseStatus === 'none' ? '—' : r.licenseStatus)}
    ${links.length ? `<div style="margin-top:4px;display:flex;gap:12px">${links.join('')}</div>` : ''}
  </div>`
}

/** Why a computer is not on the map: what it reported itself, otherwise the honest default. Never a guessed position. */
function unavailableReason(r: DeviceRow): string {
  if (r.locationNote) return `Location unavailable: ${r.locationNote}`
  if (!r.lastSeenMs) return 'Location unavailable: this computer has not connected yet.'
  return 'Location unavailable: this computer has not shared a position (older app version or sharing off).'
}

export function DeviceMap() {
  const branding = useBranding()
  const can = useCan()
  const manage = can('devices.manage')
  const fleet = useFleet(true, true)
  const [f, setF] = useState<DeviceFilter>({ q: '', online: '', deviceStatus: '', licenseStatus: '' })
  const [msg, setMsg] = useState<NoticeMsg | null>(null)
  const [removing, setRemoving] = useState<DeviceRow | null>(null)
  const el = useRef<HTMLDivElement>(null)
  const map = useRef<L.Map | null>(null)
  const layer = useRef<L.LayerGroup | null>(null)
  const tiles = useRef<L.TileLayer | null>(null)
  // The view is fitted to the markers when they change, except after a removal (the map must not jump).
  const fittedKeys = useRef('')
  const justRemoved = useRef(false)
  // A removed computer's marker / list entry disappears at once.
  const { visible, hide } = useRemovedRows(fleet.rows, fleet.loading)

  const rows = useMemo(() => filterDeviceRows(visible, f), [visible, f])
  const located = useMemo(() => rows.filter((r) => r.location), [rows])
  const hidden = useMemo(() => rows.filter((r) => !r.location), [rows])

  useEffect(() => {
    if (!el.current || map.current) return
    map.current = L.map(el.current, { center: [30.3753, 69.3451], zoom: 5, worldCopyJump: true })
    layer.current = L.layerGroup().addTo(map.current)
    return () => {
      map.current?.remove()
      map.current = null
    }
  }, [])

  useEffect(() => {
    if (!map.current) return
    tiles.current?.remove()
    tiles.current = L.tileLayer(branding.mapTileUrl || 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: branding.mapAttribution || '&copy; OpenStreetMap contributors',
      maxZoom: 18
    }).addTo(map.current)
  }, [branding.mapTileUrl, branding.mapAttribution])

  useEffect(() => {
    const g = layer.current
    if (!g || !map.current) return
    g.clearLayers()
    const pts: L.LatLngExpression[] = []
    for (const r of located) {
      const loc = r.location!
      const c = COLOR[r.online] ?? COLOR.never
      // Accuracy circle (IP points are kilometres wide; a device fix is usually tens of metres).
      const m = accuracyMetres(loc)
      if (m) L.circle([loc.lat, loc.lng], { radius: m, color: c, weight: 1, fillOpacity: loc.source === 'approximate' ? 0.06 : 0.12, dashArray: loc.source === 'approximate' ? '4 4' : undefined }).addTo(g)
      const when = loc.updatedAt && Number.isFinite(Date.parse(loc.updatedAt)) ? timeAgo(Date.parse(loc.updatedAt)) : r.lastSeenMs ? timeAgo(r.lastSeenMs) : ''
      L.circleMarker([loc.lat, loc.lng], { radius: 8, color: '#fff', weight: 2, fillColor: c, fillOpacity: 0.95, dashArray: loc.source === 'approximate' ? '2 2' : undefined })
        .bindTooltip(`${esc(r.deviceName || r.company || 'Device')}${r.company && r.deviceName ? ` · ${esc(r.company)}` : ''}${loc.source === 'approximate' ? ' · approximate' : ''}${when ? ` · ${esc(when)}` : ''}`)
        .bindPopup(popupHtml(r, manage))
        .on('popupopen', (e) => {
          const btn = (e as L.PopupEvent).popup.getElement()?.querySelector<HTMLButtonElement>('[data-remove]')
          if (btn) btn.onclick = () => setRemoving(r)
        })
        .addTo(g)
      pts.push([loc.lat, loc.lng])
    }
    const keys = located.map((r) => r.key).sort().join('|')
    const refit = keys !== fittedKeys.current && !justRemoved.current
    fittedKeys.current = keys
    justRemoved.current = false
    if (!refit) return
    if (pts.length === 1) map.current.setView(pts[0], 9)
    else if (pts.length > 1) map.current.fitBounds(L.latLngBounds(pts), { padding: [40, 40], maxZoom: 11 })
  }, [located, manage])

  return (
    <div>
      <PageTitle
        title="Device map"
        sub={`Only computers whose owner enabled location sharing · IP locations are approximate (usually the ISP’s city) · ${ONLINE_THRESHOLD_LABEL}`}
        actions={<button className="btn btn-secondary" onClick={fleet.refresh} disabled={fleet.loading}><RefreshCw className="h-4 w-4" />Refresh</button>}
      />
      <Notice msg={msg} onClose={() => setMsg(null)} className="mb-3" />
      {fleet.error && <Notice msg={{ tone: 'error', text: fleet.error }} className="mb-3" />}
      {!fleet.heartbeats && <Notice msg={{ tone: 'info', text: 'You may not read heartbeats, so no locations can be shown.' }} className="mb-3" />}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <SearchBox className="min-w-[240px] flex-1" value={f.q} onChange={(q) => setF({ ...f, q })} placeholder="Search company or computer…" />
        <select className="input w-auto" value={f.online} onChange={(e) => setF({ ...f, online: e.target.value as DeviceFilter['online'] })}>
          <option value="">Any connection</option><option value="online">Online</option><option value="recent">Recent</option><option value="offline">Offline</option>
        </select>
        <select className="input w-auto" value={f.licenseStatus} onChange={(e) => setF({ ...f, licenseStatus: e.target.value as DeviceFilter['licenseStatus'] })}>
          <option value="">Any license status</option><option value="active">Active</option><option value="pending">Pending</option><option value="suspended">Suspended</option><option value="revoked">Revoked</option><option value="expired">Expired</option><option value="detached">Detached</option><option value="none">No license</option>
        </select>
        <div className="flex gap-2 text-[12px]">
          {(['online', 'recent', 'offline'] as const).map((s) => <span key={s} className="flex items-center gap-1"><span className="inline-block h-3 w-3 rounded-full" style={{ background: COLOR[s] }} />{s}</span>)}
        </div>
      </div>
      <div className="grid gap-4 xl:grid-cols-[1fr_320px]">
        <div className="card relative overflow-hidden">
          <div ref={el} className="h-[560px] w-full" />
          {fleet.loading && <div className="absolute inset-0 z-[500] flex items-center justify-center bg-white/60"><Loading /></div>}
          {!fleet.loading && located.length === 0 && (
            <div className="pointer-events-none absolute inset-x-0 top-3 z-[500] mx-auto w-fit rounded-lg bg-white/90 px-3 py-1.5 text-[13px] shadow">No computer with a shared location matches.</div>
          )}
        </div>
        <Panel title={`Location unavailable (${hidden.length})`} sub="No shared location (sharing off or no position yet) — these computers are not on the map">
          {hidden.length === 0 ? <Empty icon={<MapPinOff className="h-5 w-5" />} title="None" /> : (
            <ul className="max-h-[500px] divide-y divide-[#f1ecf7] overflow-y-auto text-[13px]">
              {hidden.map((r) => (
                <li key={r.key} className="flex items-center justify-between gap-2 px-4 py-2">
                  <div className="min-w-0">
                    <div className="truncate font-semibold">{r.company || '—'}</div>
                    <div className="truncate text-[11.5px] text-[#7a6d92]">{r.deviceName || maskDeviceId(r.deviceId)}{r.licenseId && <> · <Link className="underline" to={`/licenses/${r.licenseId}`}>license</Link></>}</div>
                    <div className="text-[11.5px] text-[#9a8fb0]">{unavailableReason(r)}{r.lastSeenMs ? ` · seen ${timeAgo(r.lastSeenMs)}` : ''}</div>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <Pill value={r.online} />
                    {manage && (
                      <button className="rounded p-1 text-[#9a8fb0] hover:bg-red-50 hover:text-red-700" title="Remove device" aria-label={`Remove device ${r.deviceName || r.deviceId}`} onClick={() => setRemoving(r)}>
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>
      <RemoveDeviceDialog
        row={removing}
        onClose={() => setRemoving(null)}
        onDone={(info) => {
          map.current?.closePopup()
          if (info.deleted) {
            if (info.row.location) justRemoved.current = true
            hide(info.row.key)
          }
          setMsg({ tone: info.tone, text: info.text })
          fleet.refresh()
        }}
      />
    </div>
  )
}
