import { useState } from 'react'
import { money } from '../lib/format'

function niceMax(v: number): number {
  if (v <= 0) return 1
  const p = Math.pow(10, Math.floor(Math.log10(v)))
  const n = v / p
  const step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10
  return step * p
}

function short(n: number): string {
  const a = Math.abs(n)
  if (a >= 10000000) return `${(n / 10000000).toFixed(1)}Cr`
  if (a >= 100000) return `${(n / 100000).toFixed(1)}L`
  if (a >= 1000) return `${(n / 1000).toFixed(0)}K`
  return String(Math.round(n))
}

export interface Series {
  key: string
  label: string
  color: string
}

/** Grouped bar chart (pure SVG — works offline, prints well). */
export function BarChart({ data, series, height = 240 }: { data: Array<Record<string, number | string>>; series: Series[]; height?: number }): JSX.Element {
  const [hover, setHover] = useState<number | null>(null)
  const W = 640
  const H = height
  const pad = { l: 46, r: 8, t: 12, b: 26 }
  const values = data.flatMap((d) => series.map((s) => Number(d[s.key]) || 0))
  const max = niceMax(Math.max(0, ...values))
  const min = Math.min(0, ...values)
  const range = max - (min < 0 ? niceMax(-min) * -1 : 0)
  const lo = max - range
  const y = (v: number): number => pad.t + ((max - v) / (range || 1)) * (H - pad.t - pad.b)
  const bw = (W - pad.l - pad.r) / Math.max(1, data.length)
  const barW = Math.min(16, (bw * 0.7) / series.length)
  const ticks = 5
  return (
    <div className="relative">
      <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" onMouseLeave={() => setHover(null)}>
        {Array.from({ length: ticks + 1 }).map((_, i) => {
          const v = lo + (range * i) / ticks
          return (
            <g key={i}>
              <line x1={pad.l} x2={W - pad.r} y1={y(v)} y2={y(v)} stroke="var(--border)" strokeDasharray={v === 0 ? '' : '3 4'} />
              <text x={pad.l - 6} y={y(v) + 4} textAnchor="end" fontSize="12.5" fill="var(--muted)">
                {short(v)}
              </text>
            </g>
          )
        })}
        {data.map((d, i) => {
          const x0 = pad.l + i * bw + (bw - barW * series.length - 3 * (series.length - 1)) / 2
          return (
            <g key={i} onMouseEnter={() => setHover(i)}>
              <rect x={pad.l + i * bw} y={pad.t} width={bw} height={H - pad.t - pad.b} fill={hover === i ? 'var(--surface-2)' : 'transparent'} />
              {series.map((s, j) => {
                const v = Number(d[s.key]) || 0
                const top = y(Math.max(v, 0))
                const h = Math.abs(y(v) - y(0))
                return <rect key={s.key} x={x0 + j * (barW + 3)} y={top} width={barW} height={Math.max(h, v ? 1 : 0)} rx={3} fill={s.color} opacity={hover === null || hover === i ? 1 : 0.55} />
              })}
              <text x={pad.l + i * bw + bw / 2} y={H - 8} textAnchor="middle" fontSize="12.5" fill="var(--muted)">
                {String(d.label ?? '')}
              </text>
            </g>
          )
        })}
      </svg>
      {hover !== null && data[hover] && (
        <div className="pointer-events-none absolute top-1 right-2 rounded-lg border border-line bg-surface px-3 py-2 text-[12px] shadow-lg">
          <div className="mb-1 font-semibold">{String(data[hover].month ?? data[hover].label)}</div>
          {series.map((s) => (
            <div key={s.key} className="flex items-center gap-2">
              <span className="h-2 w-2 rounded-full" style={{ background: s.color }} />
              <span className="text-muted">{s.label}</span>
              <span className="num ml-auto pl-3 font-medium">{money(Number(data[hover][s.key]) || 0)}</span>
            </div>
          ))}
        </div>
      )}
      <div className="mt-1 flex flex-wrap items-center gap-4 text-[12px] text-muted">
        {series.map((s) => (
          <span key={s.key} className="inline-flex items-center gap-1.5">
            <span className="h-2.5 w-2.5 rounded-full" style={{ background: s.color }} /> {s.label}
          </span>
        ))}
      </div>
    </div>
  )
}

export function Donut({ parts, size = 170, center, sub }: { parts: Array<{ label: string; value: number; color: string }>; size?: number; center?: string; sub?: string }): JSX.Element {
  const total = parts.reduce((a, p) => a + Math.max(0, p.value), 0)
  const r = 15.9155
  let acc = 0
  return (
    <svg viewBox="0 0 42 42" width={size} height={size}>
      <circle cx="21" cy="21" r={r} fill="transparent" stroke="var(--surface-2)" strokeWidth="5" />
      {total > 0 &&
        parts.map((p) => {
          const pctv = (Math.max(0, p.value) / total) * 100
          const el = (
            <circle key={p.label} cx="21" cy="21" r={r} fill="transparent" stroke={p.color} strokeWidth="5" strokeDasharray={`${pctv} ${100 - pctv}`} strokeDashoffset={25 - acc} />
          )
          acc += pctv
          return el
        })}
      <text x="21" y="20" textAnchor="middle" fontSize="3" fill="var(--muted)">
        {sub}
      </text>
      <text x="21" y="25" textAnchor="middle" fontSize="5.2" fontWeight="700" fill="var(--text)">
        {center}
      </text>
    </svg>
  )
}

export function HBar({ items, color = 'var(--brand)', format = money }: { items: Array<{ label: string; value: number; sub?: string }>; color?: string; format?: (n: number) => string }): JSX.Element {
  const max = Math.max(1, ...items.map((i) => Math.abs(i.value)))
  return (
    <div className="space-y-2.5">
      {items.map((i) => (
        <div key={i.label}>
          <div className="mb-1 flex items-center justify-between gap-3 text-[12.5px]">
            <span className="truncate">{i.label}</span>
            <span className="num font-semibold">{format(i.value)}</span>
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-surface-2">
            <div className="h-full rounded-full" style={{ width: `${(Math.abs(i.value) / max) * 100}%`, background: color }} />
          </div>
        </div>
      ))}
    </div>
  )
}
