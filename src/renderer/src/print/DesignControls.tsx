/**
 * Layout + show/hide controls of a print design. Used by the template designer (Settings -> Invoice templates) and by
 * the "Customise this print" panel of the print preview. Only changes how a document looks — never its data.
 */
import { Field, Input, Textarea, Toggle, cx } from '../components/ui'
import { BoolOption, LAYOUTS, Layout, OPTION_GROUPS, TemplateOptions } from './design'

const HEX_RE = /^#[0-9a-f]{6}$/i
const SWATCHES = ['#0b5cad', '#1f7a4d', '#b7410e', '#6b21a8', '#0f766e', '#be123c', '#1f2937', '#c27c0e']

export interface DesignValue {
  layout: Layout
  options: TemplateOptions
}

export function DesignControls({
  value,
  onChange,
  layouts,
  disabled,
  dense
}: {
  value: DesignValue
  onChange: (v: DesignValue) => void
  /** Layouts allowed for the document kind (thermal80 only for sales invoices / payment receipts). */
  layouts: Layout[]
  disabled?: boolean
  /** Narrow panel (print preview) */
  dense?: boolean
}): JSX.Element {
  const o = value.options
  const setOpt = (patch: Partial<TemplateOptions>): void => onChange({ ...value, options: { ...o, ...patch } })
  const thermal = value.layout === 'thermal80'
  // Options that the 80 mm receipt does not print (it is black only, without signature images or stamps).
  const thermalHidden: BoolOption[] = ['showAuthorisedSignature', 'showStamp']
  return (
    <div className={cx('space-y-5', dense && 'text-[13px]')}>
      <div>
        <div className="mb-2 text-[12px] font-semibold tracking-wide text-muted uppercase">Layout</div>
        <div className={cx('grid gap-2', dense ? 'grid-cols-2' : 'sm:grid-cols-2')}>
          {LAYOUTS.filter((l) => layouts.includes(l.key)).map((l) => (
            <button
              key={l.key}
              type="button"
              disabled={disabled}
              onClick={() => onChange({ ...value, layout: l.key })}
              aria-pressed={value.layout === l.key}
              data-layout-option={l.key}
              className={cx(
                'rounded-xl border-2 px-3 py-2 text-left transition cursor-pointer disabled:cursor-default disabled:opacity-60',
                value.layout === l.key ? 'border-brand bg-brand-soft' : 'border-line hover:border-muted'
              )}
            >
              <LayoutThumb layout={l.key} accent={HEX_RE.test(o.accentColor) ? o.accentColor : '#0b5cad'} />
              <div className="mt-1.5 text-[12.5px] font-semibold">{l.label}</div>
              {!dense && <div className="text-[11.5px] leading-snug text-muted">{l.hint}</div>}
            </button>
          ))}
        </div>
      </div>

      <div className={cx('grid gap-3', !dense && 'sm:grid-cols-2')}>
        <Field label="Accent colour" hint={thermal ? 'Thermal receipts print in black only' : 'Title, table header and totals'}>
          <div className="flex flex-wrap items-center gap-1.5">
            {SWATCHES.map((c) => (
              <button
                key={c}
                type="button"
                title={c}
                disabled={disabled}
                onClick={() => setOpt({ accentColor: c })}
                className={cx('h-6 w-6 rounded-full border-2 cursor-pointer', o.accentColor.toLowerCase() === c ? 'border-ink' : 'border-transparent')}
                style={{ background: c }}
              />
            ))}
            <input
              type="color"
              aria-label="Custom accent colour"
              disabled={disabled}
              className="h-7 w-8 cursor-pointer border-0 bg-transparent p-0"
              value={HEX_RE.test(o.accentColor) ? o.accentColor : '#0b5cad'}
              onChange={(e) => setOpt({ accentColor: e.target.value })}
            />
            <Input
              sm
              className={cx('w-24 font-mono', !HEX_RE.test(o.accentColor) && '!border-bad')}
              value={o.accentColor}
              maxLength={7}
              disabled={disabled}
              onChange={(e) => setOpt({ accentColor: e.target.value.trim() })}
            />
          </div>
        </Field>
        <Field label="Document title" hint="Leave empty for the normal title (e.g. Invoice, Quotation)">
          <Input value={o.titleOverride} maxLength={60} disabled={disabled} placeholder="e.g. Proforma Invoice" onChange={(e) => setOpt({ titleOverride: e.target.value })} />
        </Field>
        <Field label="Footer note" hint="Printed at the bottom instead of the firm's invoice footer" className={dense ? undefined : 'sm:col-span-2'}>
          <Textarea rows={2} value={o.footerNote} maxLength={300} disabled={disabled} placeholder="e.g. Thank you for choosing solar energy!" onChange={(e) => setOpt({ footerNote: e.target.value })} />
        </Field>
      </div>

      {OPTION_GROUPS.map((g) => (
        <div key={g.title}>
          <div className="mb-1.5 text-[12px] font-semibold tracking-wide text-muted uppercase">{g.title}</div>
          <div className={cx('grid gap-x-6 gap-y-2', !dense && 'sm:grid-cols-2')}>
            {g.items.map((it) => {
              const na = thermal && thermalHidden.includes(it.key)
              return (
                <div key={it.key} data-option={it.key} className={na ? 'opacity-50' : undefined}>
                  <Toggle
                    checked={!!o[it.key]}
                    disabled={disabled || na}
                    onChange={(v) => setOpt({ [it.key]: v } as Partial<TemplateOptions>)}
                    label={<span className="text-[13px] font-normal">{it.label}</span>}
                    description={na ? 'Not printed on 80 mm receipts' : it.hint}
                  />
                </div>
              )
            })}
          </div>
        </div>
      ))}
    </div>
  )
}

/** Tiny schematic of a layout (no real data). */
function LayoutThumb({ layout, accent }: { layout: Layout; accent: string }): JSX.Element {
  if (layout === 'thermal80') {
    return (
      <div className="flex h-11 items-center justify-center">
        <div className="flex h-11 w-7 flex-col gap-[3px] rounded-sm border border-line bg-white p-[3px]">
          <div className="h-[3px] rounded bg-ink/70" />
          <div className="h-[2px] rounded bg-ink/30" />
          <div className="h-[2px] rounded bg-ink/30" />
          <div className="h-[2px] rounded bg-ink/30" />
          <div className="mt-auto h-[3px] rounded bg-ink/70" />
        </div>
      </div>
    )
  }
  return (
    <div className="flex h-11 flex-col gap-[3px] rounded-md border border-line bg-white p-1.5">
      {layout === 'modern' ? (
        <div className="h-[9px] rounded-sm" style={{ background: accent }} />
      ) : layout === 'compact' ? (
        <div className="h-[3px] rounded-sm" style={{ background: accent }} />
      ) : (
        <>
          <div className="h-[2px] rounded-sm" style={{ background: accent }} />
          <div className="flex gap-1">
            <div className="h-[5px] w-1/3 rounded-sm bg-ink/40" />
            <div className="ml-auto h-[5px] w-1/4 rounded-sm" style={{ background: accent }} />
          </div>
        </>
      )}
      <div className="h-[4px] rounded-sm" style={{ background: layout === 'modern' ? 'transparent' : accent, borderBottom: layout === 'modern' ? `2px solid ${accent}` : undefined }} />
      <div className={cx('rounded-sm bg-ink/15', layout === 'compact' ? 'h-[2px]' : 'h-[3px]')} />
      <div className={cx('rounded-sm bg-ink/15', layout === 'compact' ? 'h-[2px]' : 'h-[3px]')} />
      {layout === 'compact' && <div className="h-[2px] rounded-sm bg-ink/15" />}
    </div>
  )
}
