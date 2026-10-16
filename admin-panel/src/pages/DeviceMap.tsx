/**
 * Device map: only heartbeats that carry a consented location; colour = online status. No invented coordinates
 * and no geocoding. Every marker says where its point comes from: IP points are approximate (usually the ISP's
 * city) and drawn with their accuracy circle; device-service points show their accuracy in metres.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { MapPinOff, RefreshCw } from 'lucide-react'
import { PageTitle } from '../components/ui'
import { DEVICE_STATUS_LABEL, LOCATION_SOURCE_LABEL, accuracyMetres, accuracyText, filterDeviceRows, type DeviceFilter, type DeviceRow } from '../lib/devices'
import { maskDeviceId } from '../lib/terms'
import { ONLINE_THRESHOLD_LABEL } from '../lib/stats'
import { fmtDateTime, timeAgo } from '../lib/format'
import { Empty, Loading, Notice, Panel, Pill, SearchBox } from './licensing/kit'
import { useBranding } from './licensing/hooks'
import { useFleet } from './licensing/useFleet'

const COLOR: Record<string, string> = { online: '#16a34a', recent: '#f59e0b', offline: '#64748b', never: '#94a3b8' }

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)

function popupHtml(r: DeviceRow): string {
  const loc = r.location!
  return `<div style="font-size:12.5px;line-height:1.45">
    <b>${esc(r.company || '—')}</b><br/>
    ${esc(r.deviceName || maskDeviceId(r.deviceId))}<br/>
    Last seen: ${esc(r.lastSeenMs ? `${fmtDateTime(r.lastSeenMs)} (${timeAgo(r.lastSeenMs)})` : '—')}<br/>
    Device: ${esc(DEVICE_STATUS_LABEL[r.deviceStatus])} · License: ${esc(r.licenseStatus === 'none' ? '—' : r.licenseStatus)}<br/>
    Location: ${esc(LOCATION_SOURCE_LABEL[loc.source])}${accuracyText(loc) ? ` · ${esc(accuracyText(loc))}` : ''}${loc.label ? ` · ${esc(loc.label)}` : ''}<br/>
    Location updated: ${esc(loc.updatedAt && Number.isFinite(Date.parse(loc.updatedAt)) ? `${fmtDateTime(Date.parse(loc.updatedAt))} (${timeAgo(Date.parse(loc.updatedAt))})` : 'unknown')}
    ${r.licenseId ? `<br/><a href="#/licenses/${esc(r.licenseId)}">Open license</a>` : ''}
  </div>`
}

export function DeviceMap() {
  const branding = useBranding()
  const fleet = useFleet(true, true)
  const [f, setF] = useState<DeviceFilter>({ q: '', online: '', deviceStatus: '', licenseStatus: '' })
  const el = useRef<HTMLDivElement>(null)
  const map = useRef<L.Map | null>(null)
  const layer = useRef<L.LayerGroup | null>(null)
  const tiles = useRef<L.TileLayer | null>(null)

  const rows = useMemo(() => filterDeviceRows(fleet.rows, f), [fleet.rows, f])
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
        .bindTooltip(`${esc(r.company || r.deviceName || 'Device')}${loc.source === 'approximate' ? ' · approximate' : ''}${when ? ` · ${esc(when)}` : ''}`)
        .bindPopup(popupHtml(r))
        .addTo(g)
      pts.push([loc.lat, loc.lng])
    }
    if (pts.length === 1) map.current.setView(pts[0], 9)
    else if (pts.length > 1) map.current.fitBounds(L.latLngBounds(pts), { padding: [40, 40], maxZoom: 11 })
  }, [located])

  return (
    <div>
      <PageTitle
        title="Device map"
        sub={`Only computers whose owner enabled location sharing · IP locations are approximate (usually the ISP’s city) · ${ONLINE_THRESHOLD_LABEL}`}
        actions={<button className="btn btn-secondary" onClick={fleet.refresh} disabled={fleet.loading}><RefreshCw className="h-4 w-4" />Refresh</button>}
      />
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
        <Panel title={`Location sharing off (${hidden.length})`} sub="These computers are not on the map">
          {hidden.length === 0 ? <Empty icon={<MapPinOff className="h-5 w-5" />} title="None" /> : (
            <ul className="max-h-[500px] divide-y divide-[#f1ecf7] overflow-y-auto text-[13px]">
              {hidden.map((r) => (
                <li key={r.key} className="flex items-center justify-between gap-2 px-4 py-2">
                  <div className="min-w-0">
                    <div className="truncate font-semibold">{r.company || '—'}</div>
                    <div className="truncate text-[11.5px] text-[#7a6d92]">{r.deviceName || r.deviceId}{r.licenseId && <> · <Link className="underline" to={`/licenses/${r.licenseId}`}>license</Link></>}</div>
                  </div>
                  <Pill value={r.online} />
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>
    </div>
  )
}
