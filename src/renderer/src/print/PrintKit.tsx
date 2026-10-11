/**
 * Shared building blocks for A4 print templates.
 * Every template renders inside <Sheet>; screen-only UI must use the `no-print` class.
 */
import { CSSProperties, ReactNode } from 'react'
import { VENDOR } from '@shared/branding'
import { formatMoney, formatQty } from '@shared/money'

/* eslint-disable @typescript-eslint/no-explicit-any */
export interface PrintSettings {
  accentColor: string
  showLogo: boolean
  showSignature: boolean
  showStamp: boolean
  showWarranty: boolean
  showSerials: boolean
  showAmountInWords: boolean
  showBankDetails: boolean
  showPreviousBalance: boolean
  showTaxColumns: 'auto' | 'always' | 'never'
  signatureLabel: string
  receiverLabel: string
}

export interface PrintContext {
  firm: any
  settings: Record<string, any>
  ps: PrintSettings
}

export interface TemplateProps {
  id: number
  params: Record<string, string>
  ctx: PrintContext
  /** Sets the window title and default PDF file name */
  setTitle: (t: string) => void
}

export function pm(ctx: PrintContext, n: number | null | undefined, decimals?: number): string {
  if (n === null || n === undefined) return '—'
  return formatMoney(n, '', decimals ?? Math.max(0, Math.min(2, Number(ctx.settings.money_decimals ?? 0))))
}

export function pmSym(ctx: PrintContext, n: number | null | undefined, decimals?: number): string {
  if (n === null || n === undefined) return '—'
  return formatMoney(n, String(ctx.settings.currency_symbol ?? 'Rs.'), decimals ?? Math.max(0, Math.min(2, Number(ctx.settings.money_decimals ?? 0))))
}

export function pq(n: number | null | undefined): string {
  return n === null || n === undefined ? '—' : formatQty(n)
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
export function pd(s: string | null | undefined): string {
  if (!s) return '—'
  const [y, m, d] = s.slice(0, 10).split('-')
  return y && m && d ? `${d}-${MONTHS[Number(m) - 1]}-${y}` : s
}

export function accentStyle(ctx: PrintContext): CSSProperties {
  return { ['--pc' as string]: ctx.ps.accentColor || '#0b5cad' }
}

export function Sheet({ ctx, children, watermark }: { ctx: PrintContext; children: ReactNode; watermark?: { text: string; color: string } | null }): JSX.Element {
  return (
    <div className="sheet relative" style={accentStyle(ctx)}>
      {watermark && (
        <div className="pointer-events-none absolute inset-0 z-0 flex items-center justify-center print:fixed">
          <div className="-rotate-[28deg] rounded-xl border-[6px] px-10 py-3 text-[64px] font-black tracking-[0.2em] opacity-[0.13]" style={{ color: watermark.color, borderColor: watermark.color }}>
            {watermark.text}
          </div>
        </div>
      )}
      <div className="relative z-10">{children}</div>
    </div>
  )
}

/** Letterhead: logo + firm details on the left, document title block on the right. */
export function Letterhead({ ctx, title, meta, subtitle }: { ctx: PrintContext; title: string; subtitle?: string; meta?: Array<[string, ReactNode]> }): JSX.Element {
  const f = ctx.firm
  const contact = [f.phone, f.phone2].filter(Boolean).join(' / ')
  return (
    <div className="avoid-break">
      <div className="mb-3 h-[5px] rounded-full" style={{ background: 'linear-gradient(90deg, var(--pc), color-mix(in srgb, var(--pc) 35%, #f7931e))' }} />
      <div className="flex items-start justify-between gap-5">
        <div className="flex min-w-0 flex-1 items-start gap-4">
          {ctx.ps.showLogo && f.logo && <img src={f.logo} alt="" className="max-h-[78px] max-w-[150px] shrink-0 rounded-md object-contain" />}
          <div className="min-w-0">
            <div className="text-[21px] leading-tight font-extrabold tracking-tight" style={{ color: 'var(--pc)' }}>{f.name}</div>
            {f.tagline && <div className="mt-0.5 text-[9.3px] leading-snug text-[#4a5568]">{f.tagline}</div>}
            <div className="mt-1 text-[10px] leading-snug text-[#2d3748]">
              {[f.address, f.city].filter(Boolean).join(', ')}
              {(contact || f.email) && (
                <div>
                  {contact && <span><b>Phone:</b> {contact}</span>}
                  {contact && f.email && <span className="mx-1.5">|</span>}
                  {f.email && <span><b>Email:</b> {f.email}</span>}
                  {f.website && <span className="mx-1.5">| {f.website}</span>}
                </div>
              )}
              {(f.ntn || f.strn) && (
                <div>
                  {f.ntn && <span><b>NTN:</b> {f.ntn}</span>}
                  {f.ntn && f.strn && <span className="mx-1.5">|</span>}
                  {f.strn && <span><b>STRN:</b> {f.strn}</span>}
                </div>
              )}
            </div>
          </div>
        </div>
        <div className="shrink-0 text-right">
          <div className="text-[19px] font-black tracking-[0.08em] uppercase" style={{ color: 'var(--pc)' }}>{title}</div>
          {subtitle && <div className="text-[9.5px] text-[#4a5568]">{subtitle}</div>}
          {meta && meta.length > 0 && (
            <table className="mt-1.5 ml-auto text-[10.5px]">
              <tbody>
                {meta.map(([k, v]) => (
                  <tr key={k}>
                    <td className="pr-2 text-right text-[#4a5568]">{k}</td>
                    <td className="text-right font-semibold">{v}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
      <div className="mt-3 mb-3 border-b-2" style={{ borderColor: 'var(--pc)' }} />
    </div>
  )
}

/** A labelled info box (Bill To, Project, etc.). */
export function InfoBox({ title, children, className }: { title: string; children: ReactNode; className?: string }): JSX.Element {
  return (
    <div className={`avoid-break rounded-md border border-[#e2e8f0] ${className ?? ''}`}>
      <div className="rounded-t-md px-2.5 py-1 text-[9.5px] font-bold tracking-wider text-white uppercase" style={{ background: 'var(--pc)' }}>{title}</div>
      <div className="px-2.5 py-1.5 text-[10.5px] leading-snug">{children}</div>
    </div>
  )
}

/** Signature & stamp area. */
export function Signatures({ ctx, left, right, showReceiver = true }: { ctx: PrintContext; left?: string; right?: string; showReceiver?: boolean }): JSX.Element {
  const f = ctx.firm
  return (
    <div className="avoid-break mt-8 flex items-end justify-between gap-10">
      {showReceiver ? (
        <div className="w-[38%] text-center">
          <div className="h-[62px]" />
          <div className="border-t border-[#2d3748] pt-1 text-[10px] font-semibold">{left ?? ctx.ps.receiverLabel}</div>
        </div>
      ) : (
        <div />
      )}
      <div className="relative w-[42%] text-center">
        <div className="relative flex h-[66px] items-end justify-center">
          {ctx.ps.showStamp && f.stamp && <img src={f.stamp} alt="" className="absolute right-2 bottom-0 max-h-[78px] max-w-[110px] rotate-[-8deg] object-contain opacity-80" />}
          {ctx.ps.showSignature && f.signature && <img src={f.signature} alt="" className="relative max-h-[60px] max-w-[170px] object-contain" />}
        </div>
        <div className="border-t border-[#2d3748] pt-1 text-[10px] font-semibold">{right ?? ctx.ps.signatureLabel}</div>
        <div className="text-[9px] text-[#4a5568]">For {f.name}</div>
      </div>
    </div>
  )
}

export function PrintFooter({ ctx, note }: { ctx: PrintContext; note?: string | null }): JSX.Element {
  const footer = note ?? ctx.firm.invoice_footer
  const vendor = ctx.settings.show_vendor_branding !== false
  return (
    <div className="avoid-break mt-6 border-t border-[#e2e8f0] pt-2 text-center text-[9px] text-[#718096]">
      {footer && <div className="mb-0.5 text-[9.5px] text-[#2d3748]">{footer}</div>}
      <div>This is a computer-generated document{ctx.firm.phone ? ` · For queries call ${ctx.firm.phone}` : ''}.</div>
      {vendor && (
        <div className="mt-0.5 opacity-80">
          Powered by {VENDOR.product} · {VENDOR.company} · {VENDOR.phone}
        </div>
      )}
    </div>
  )
}

/** Standard table styles for printed tables (header in accent colour, repeated on each page). */
export function PrintTable({ head, children, foot, className }: { head: ReactNode; children: ReactNode; foot?: ReactNode; className?: string }): JSX.Element {
  return (
    <table className={`doc-table ${className ?? ''}`}>
      <thead>
        <tr className="text-white" style={{ background: 'var(--pc)' }}>{head}</tr>
      </thead>
      <tbody className="[&>tr:nth-child(even)>td]:bg-[#f7f9fc]">{children}</tbody>
      {foot && <tfoot>{foot}</tfoot>}
    </table>
  )
}

export function TotalsBox({ rows }: { rows: Array<{ label: string; value: string; strong?: boolean; accent?: boolean; danger?: boolean } | null | false> }): JSX.Element {
  return (
    <table className="avoid-break w-full text-[11px]">
      <tbody>
        {rows.filter(Boolean).map((r) => {
          const row = r as { label: string; value: string; strong?: boolean; accent?: boolean; danger?: boolean }
          return (
            <tr key={row.label} className={row.accent ? 'text-white' : ''} style={row.accent ? { background: 'var(--pc)' } : undefined}>
              <td className={`px-2.5 py-1 ${row.strong || row.accent ? 'font-bold' : 'text-[#4a5568]'} ${row.accent ? 'text-[12.5px]' : ''}`}>{row.label}</td>
              <td className={`num px-2.5 py-1 text-right ${row.strong || row.accent ? 'font-bold' : 'font-semibold'} ${row.accent ? 'text-[13px]' : ''} ${row.danger ? 'text-[#c53030]' : ''}`}>{row.value}</td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}
