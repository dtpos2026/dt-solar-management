/** Settings section: Standard / Customizable mode and the on/off options (see shared/options.ts). Every change is saved at once. */
import { useState } from 'react'
import { SlidersHorizontal } from 'lucide-react'
import { api } from '../../api'
import { useApp, useCan } from '../../store'
import { Badge, Card, Toggle, cx, toast } from '../../components/ui'
import { OPTIONS, OPTION_GROUPS, OPTION_PRESETS, optionOn } from '@shared/options'

export function CustomizeSection(): JSX.Element {
  const settings = useApp((s) => s.settings)
  const mayManage = useCan()('settings.manage')
  const licenseWritable = useApp((s) => s.license?.canWrite ?? false)
  const canEdit = mayManage && licenseWritable
  const custom = settings.ui_mode === 'custom'
  const [busy, setBusy] = useState(false)

  const save = async (patch: Record<string, unknown>): Promise<void> => {
    setBusy(true)
    try {
      await api('settings.update', { patch })
      await useApp.getState().refresh()
    } catch (e) {
      toast.error(e)
    } finally {
      setBusy(false)
    }
  }
  const setMode = (mode: 'standard' | 'custom'): void => {
    if (mode !== (custom ? 'custom' : 'standard')) void save({ ui_mode: mode })
  }
  const setOne = (key: string, v: boolean): void => void save({ ui_options: { ...(settings.ui_options ?? {}), [key]: v } })
  const applyPreset = (options: Record<string, boolean>): void => void save({ ui_mode: 'custom', ui_options: options })

  const disabled = !canEdit || busy
  const modeCard = (mode: 'standard' | 'custom', title: string, text: string): JSX.Element => {
    const active = (mode === 'custom') === custom
    return (
      <button
        type="button"
        disabled={disabled}
        onClick={() => setMode(mode)}
        className={cx('flex-1 rounded-xl border p-4 text-left transition cursor-pointer disabled:cursor-default', active ? 'border-brand bg-brand-soft' : 'border-line hover:border-brand')}
        aria-pressed={active}
      >
        <div className="flex items-center gap-2">
          <span className={cx('flex h-5 w-5 items-center justify-center rounded-full border-2', active ? 'border-brand' : 'border-line')}>{active && <span className="h-2.5 w-2.5 rounded-full bg-brand" />}</span>
          <span className="text-[15px] font-semibold">{title}</span>
          {active && <Badge tone="ok">In use</Badge>}
        </div>
        <div className="mt-2 text-[13px] text-muted">{text}</div>
      </button>
    )
  }

  return (
    <div className="space-y-4">
      <Card title="Software mode" actions={<SlidersHorizontal className="h-4 w-4 text-muted" />}>
        <div className="flex flex-wrap gap-3">
          {modeCard('standard', 'Standard', 'The software exactly as it has always been, with every screen, field and rule. The switches below are ignored.')}
          {modeCard('custom', 'Customizable', 'You decide what is shown. Switch off the modules, fields and details this business does not need, and allow invoices to be deleted easily.')}
        </div>
        <div className="mt-3 text-[12.5px] text-muted">
          Switching changes only what is shown. It never changes totals, stock or profit, and nothing is deleted: a switch turned back on brings everything back. It applies to every user and every firm on this computer.
        </div>
        {!canEdit && <div className="mt-2 text-[12.5px] font-medium text-warn">Only a user who may change settings, with an active license, can change these options.</div>}
      </Card>

      <Card title="Quick setups">
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {OPTION_PRESETS.map((p) => (
            <button key={p.key} type="button" disabled={disabled} onClick={() => applyPreset(p.options)} className="rounded-xl border border-line p-4 text-left transition hover:border-brand cursor-pointer disabled:cursor-default disabled:opacity-60">
              <div className="font-semibold">{p.label}</div>
              <div className="mt-1 text-[12.5px] text-muted">{p.hint}</div>
            </button>
          ))}
        </div>
        <div className="mt-2 text-[12.5px] text-muted">A quick setup turns Customizable mode on and sets all switches; you can change any switch afterwards.</div>
      </Card>

      {OPTION_GROUPS.map((g) => (
        <Card key={g.key} title={g.label} className={cx(!custom && 'opacity-60')}>
          <div className="mb-2 text-[12.5px] text-muted">{g.hint}</div>
          <div className="divide-y divide-line">
            {OPTIONS.filter((o) => o.group === g.key).map((o) => (
              <div key={o.key} className="py-2.5">
                <Toggle checked={optionOn(settings, o.key)} disabled={disabled || !custom} onChange={(v) => setOne(o.key, v)} label={o.label} description={o.hint} />
              </div>
            ))}
          </div>
        </Card>
      ))}
      <div className="text-[12.5px] text-muted">What an invoice, quotation or receipt prints (logo, tax, signature, terms, bank details, amount in words) is set per template in "Invoice templates".</div>
    </div>
  )
}
