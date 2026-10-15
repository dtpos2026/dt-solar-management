/**
 * Shared building blocks for A4 print templates.
 * Every template renders inside <Sheet>; screen-only UI must use the `no-print` class.
 */
import { CSSProperties, ReactNode } from 'react'
import { VENDOR } from '@shared/branding'
import { formatMoney, formatQty } from '@shared/money'
import type { PrintDesign, TemplateKind } from './design'

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
  /**
   * Print "Powered by Digital Target" on customer documents. Controlled ONLY by the Super Admin through the license
   * (license.status().poweredBy); default false = white-label.
   */
  poweredBy?: boolean
}

export interface TemplateProps {
  id: number
  params: Record<string, string>
  ctx: PrintContext
  /** Sets the window title and default PDF file name */
  setTitle: (t: string) => void
  /**
   * Layout + show/hide options (customer documents and receipts). undefined = built-in Classic from the firm print
   * settings; null = the print window is still resolving the template, so render nothing yet.
   */
  design?: PrintDesign | null
  /** Called once the record is loaded, so the print window can offer the templates of that document kind. */
  onKind?: (kind: TemplateKind) => void
  /** Pre-loaded record (template designer preview) instead of fetching by id. */
  data?: any
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

export function accentStyle(ctx: PrintContext, accent?: string): CSSProperties {
  return { ['--pc' as string]: accent || ctx.ps.accentColor || '#0b5cad' }
}

export function Sheet({ ctx, children, watermark, accent, className }: { ctx: PrintContext; children: ReactNode; watermark?: { text: string; color: string } | null; accent?: string; className?: string }): JSX.Element {
  return (
    <div className={`sheet relative ${className ?? ''}`} style={accentStyle(ctx, accent)}>
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
export function Letterhead({ ctx, title, meta, subtitle, showLogo }: { ctx: PrintContext; title: string; subtitle?: string; meta?: Array<[string, ReactNode]>; showLogo?: boolean }): JSX.Element {
  const f = ctx.firm
  const contact = [f.phone, f.phone2].filter(Boolean).join(' / ')
  return (
    <div className="avoid-break">
      <div className="mb-3 h-[5px] rounded-full" style={{ background: 'linear-gradient(90deg, var(--pc), color-mix(in srgb, var(--pc) 35%, #f7931e))' }} />
      <div className="flex items-start justify-between gap-5">
        <div className="flex min-w-0 flex-1 items-start gap-4">
          {(showLogo ?? ctx.ps.showLogo) && f.logo && <img src={f.logo} alt="" className="max-h-[78px] max-w-[150px] shrink-0 rounded-md object-contain" />}
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

/** Modern layout header: bold colour band with the firm on the left and the document title / number on the right. */
export function ModernHeader({ ctx, title, number, date, showLogo, subtitle }: { ctx: PrintContext; title: string; number: string; date: string; showLogo: boolean; subtitle?: string }): JSX.Element {
  const f = ctx.firm
  const contact = [f.phone, f.phone2].filter(Boolean).join(' / ')
  return (
    <div className="avoid-break mb-4 rounded-xl px-5 py-4 text-white" style={{ background: 'linear-gradient(120deg, var(--pc), color-mix(in srgb, var(--pc) 70%, #000))' }}>
      <div className="flex items-start justify-between gap-6">
        <div className="flex min-w-0 items-center gap-4">
          {showLogo && f.logo && (
            <div className="shrink-0 rounded-lg bg-white p-1.5">
              <img src={f.logo} alt="" className="max-h-[60px] max-w-[120px] object-contain" />
            </div>
          )}
          <div className="min-w-0">
            <div className="text-[22px] leading-tight font-extrabold tracking-tight">{f.name}</div>
            {f.tagline && <div className="text-[9.5px] text-white/80">{f.tagline}</div>}
            <div className="mt-1 text-[9.8px] leading-snug text-white/90">
              {[f.address, f.city].filter(Boolean).join(', ')}
              {(contact || f.email) && <div>{[contact && `Phone: ${contact}`, f.email, f.website].filter(Boolean).join('  ·  ')}</div>}
              {(f.ntn || f.strn) && <div>{[f.ntn && `NTN: ${f.ntn}`, f.strn && `STRN: ${f.strn}`].filter(Boolean).join('  ·  ')}</div>}
            </div>
          </div>
        </div>
        <div className="shrink-0 text-right">
          <div className="text-[26px] leading-none font-black tracking-[0.06em] uppercase">{title}</div>
          {subtitle && <div className="mt-1 text-[9.5px] text-white/80">{subtitle}</div>}
          <div className="mt-2 text-[12px] font-bold">{number}</div>
          <div className="text-[10px] text-white/85">{date}</div>
        </div>
      </div>
    </div>
  )
}

/** Compact layout header: one tight row with a coloured rule. */
export function CompactHeader({ ctx, title, number, date, showLogo }: { ctx: PrintContext; title: string; number: string; date: string; showLogo: boolean }): JSX.Element {
  const f = ctx.firm
  const contact = [f.phone, f.phone2].filter(Boolean).join(' / ')
  return (
    <div className="avoid-break flex items-center justify-between gap-4 border-b-2 pb-2" style={{ borderColor: 'var(--pc)' }}>
      <div className="flex min-w-0 items-center gap-3">
        {showLogo && f.logo && <img src={f.logo} alt="" className="max-h-[40px] max-w-[90px] object-contain" />}
        <div className="min-w-0">
          <div className="text-[15px] leading-tight font-extrabold" style={{ color: 'var(--pc)' }}>{f.name}</div>
          <div className="text-[8.8px] leading-snug text-[#2d3748]">
            {[[f.address, f.city].filter(Boolean).join(', '), contact && `Ph: ${contact}`, f.email, f.ntn && `NTN: ${f.ntn}`, f.strn && `STRN: ${f.strn}`].filter(Boolean).join(' · ')}
          </div>
        </div>
      </div>
      <div className="shrink-0 text-right">
        <div className="text-[14px] font-black tracking-[0.06em] uppercase" style={{ color: 'var(--pc)' }}>{title}</div>
        <div className="text-[9.5px]">
          <b>{number}</b> · {date}
        </div>
      </div>
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
export function Signatures({
  ctx,
  left,
  right,
  showReceiver = true,
  showSignature,
  showStamp,
  compact
}: {
  ctx: PrintContext
  left?: string
  right?: string
  showReceiver?: boolean
  /** Firm signature image (default: firm print settings) */
  showSignature?: boolean
  showStamp?: boolean
  compact?: boolean
}): JSX.Element {
  const f = ctx.firm
  const sig = showSignature ?? ctx.ps.showSignature
  const stamp = showStamp ?? ctx.ps.showStamp
  return (
    <div className={`avoid-break ${compact ? 'mt-4' : 'mt-8'} flex items-end justify-between gap-10`}>
      {showReceiver ? (
        <div className="w-[38%] text-center">
          <div className={compact ? 'h-[44px]' : 'h-[62px]'} />
          <div className="border-t border-[#2d3748] pt-1 text-[10px] font-semibold">{left ?? ctx.ps.receiverLabel}</div>
        </div>
      ) : (
        <div />
      )}
      <div className="relative w-[42%] text-center">
        <div className={`relative flex ${compact ? 'h-[48px]' : 'h-[66px]'} items-end justify-center`}>
          {stamp && f.stamp && <img src={f.stamp} alt="" className="absolute right-2 bottom-0 max-h-[78px] max-w-[110px] rotate-[-8deg] object-contain opacity-80" />}
          {sig && f.signature && <img src={f.signature} alt="" className="relative max-h-[60px] max-w-[170px] object-contain" />}
        </div>
        <div className="border-t border-[#2d3748] pt-1 text-[10px] font-semibold">{right ?? ctx.ps.signatureLabel}</div>
        <div className="text-[9px] text-[#4a5568]">For {f.name}</div>
      </div>
    </div>
  )
}

/** The vendor line printed on customer documents only when the Super Admin enabled it for this license. */
export function poweredByLine(): string {
  return `Powered by ${VENDOR.company} · ${VENDOR.phone}`
}

export function PrintFooter({ ctx, note, className }: { ctx: PrintContext; note?: string | null; className?: string }): JSX.Element {
  const footer = note ?? ctx.firm.invoice_footer
  return (
    <div className={`avoid-break mt-6 border-t border-[#e2e8f0] pt-2 text-center text-[9px] text-[#718096] ${className ?? ''}`}>
      {footer && <div className="mb-0.5 text-[9.5px] whitespace-pre-line text-[#2d3748]">{footer}</div>}
      <div>This is a computer-generated document{ctx.firm.phone ? ` · For queries call ${ctx.firm.phone}` : ''}.</div>
      {ctx.poweredBy === true && <div className="mt-0.5 opacity-80" data-powered-by="1">{poweredByLine()}</div>}
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
