/**
 * Settings, Simple / Customize: Standard or Editable mode, and the Vyapar-style screens (Transaction, Invoice Print, Item,
 * Party, Menu, Solar Projects) with an on/off switch or a value for every option. Each change is saved at once.
 */
import { useMemo, useState } from 'react'
import { ChevronRight, Info, Search, SlidersHorizontal } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { api } from '../../api'
import { useApp, useCan } from '../../store'
import { Badge, Card, Input, Select, Tabs, Toggle, cx, toast } from '../../components/ui'
import { OPTIONS, OPTION_PRESETS, OPTION_SCREENS, OptionDef, OptionScreen, optionOn, optionValue } from '@shared/options'

/** Rows that open another Settings screen (the Vyapar "more settings" rows). */
const LINKS: Array<{ screen: OptionScreen; section: string; label: string; hint: string; tab: string }> = [
  { screen: 'transaction', section: 'More Transaction Features', label: 'Set Terms & Conditions', hint: 'The default terms text of invoices and quotations.', tab: 'documents' },
  { screen: 'print', section: 'Themes', label: 'Change Theme and Colors', hint: 'Layout (classic, modern, compact, thermal) and colour of printed documents.', tab: 'templates' },
  { screen: 'print', section: 'Themes', label: 'Printers and paper', hint: 'Which printer prints what, and the paper size.', tab: 'printers' }
]

export function CustomizeSection(): JSX.Element {
  const settings = useApp((s) => s.settings)
  const mayManage = useCan()('settings.manage')
  const licenseWritable = useApp((s) => s.license?.canWrite ?? false)
  const nav = useNavigate()
  const canEdit = mayManage && licenseWritable
  const custom = settings.ui_mode === 'custom'
  const [busy, setBusy] = useState(false)
  const [screen, setScreen] = useState<OptionScreen>('transaction')
  const [q, setQ] = useState('')

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
  const setOne = (key: string, v: boolean | string | number): void => void save({ ui_options: { ...(settings.ui_options ?? {}), [key]: v } })
  const disabled = !canEdit || busy
  const locked = disabled || !custom

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

  const control = (o: OptionDef): JSX.Element => {
    if (o.kind === 'toggle') return <Toggle checked={optionOn(settings, o.key)} disabled={locked} onChange={(v) => setOne(o.key, v)} />
    if (o.kind === 'select') {
      return (
        <Select sm className="w-56" disabled={locked} value={String(optionValue(settings, o.key))} onChange={(e) => setOne(o.key, e.target.value)}>
          {o.choices.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
        </Select>
      )
    }
    if (o.kind === 'number') {
      return <NumberBox def={o} value={Number(optionValue(settings, o.key))} disabled={locked} onSave={(v) => setOne(o.key, v)} />
    }
    return <TextBox def={o} value={String(optionValue(settings, o.key))} disabled={locked} onSave={(v) => setOne(o.key, v)} />
  }

  const row = (o: OptionDef): JSX.Element => (
    <div key={o.key} className="flex items-center justify-between gap-6 py-2.5">
      <div className="flex min-w-0 items-center gap-2">
        <span className="font-medium">{o.label}</span>
        <span title={o.hint} className="cursor-help text-muted"><Info className="h-3.5 w-3.5" /></span>
      </div>
      {control(o)}
    </div>
  )

  const needle = q.trim().toLowerCase()
  const sections = useMemo(() => {
    const list = OPTIONS.filter((o) => (needle ? `${o.label} ${o.hint} ${o.section}`.toLowerCase().includes(needle) : o.screen === screen))
    const order: string[] = []
    for (const o of list) if (!order.includes(`${o.screen}|${o.section}`)) order.push(`${o.screen}|${o.section}`)
    return order.map((k) => ({ key: k, screen: k.split('|')[0] as OptionScreen, name: k.split('|')[1], items: list.filter((o) => `${o.screen}|${o.section}` === k) }))
  }, [needle, screen])
  const screenInfo = OPTION_SCREENS.find((s) => s.key === screen)!

  return (
    <div className="space-y-4">
      <Card title="Software mode" actions={<SlidersHorizontal className="h-4 w-4 text-muted" />}>
        <div className="flex flex-wrap gap-3">
          {modeCard('standard', 'Standard', 'The software exactly as it has always been. The switches below are ignored.')}
          {modeCard('custom', 'Editable', 'Every switch below works, as in the Vyapar settings: what the invoice asks for, what is printed, what an item or party has, which modules show.')}
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2 text-[13px]">
          <span className="font-medium">Quick setup:</span>
          {OPTION_PRESETS.map((p) => (
            <button key={p.key} type="button" title={p.hint} disabled={disabled} onClick={() => void save({ ui_mode: 'custom', ui_options: p.options })} className="rounded-lg border border-line px-3 py-1 font-medium transition hover:border-brand hover:text-brand cursor-pointer disabled:cursor-default disabled:opacity-60">
              {p.label}
            </button>
          ))}
          <span className="text-[12.5px] text-muted">switches Editable mode on and sets every option; change any of them afterwards.</span>
        </div>
        <div className="mt-2 text-[12.5px] text-muted">
          Switching changes only what is shown, asked or printed, never totals, stock or profit, and nothing is deleted. It applies to every user and firm on this computer.
        </div>
        {!canEdit && <div className="mt-2 text-[12.5px] font-medium text-warn">Only a user who may change settings, with an active license, can change these options.</div>}
      </Card>

      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1">
          <Tabs className="mb-0" value={needle ? '' : screen} onChange={(t) => { setQ(''); setScreen(t as OptionScreen) }} tabs={OPTION_SCREENS.map((s) => ({ key: s.key, label: s.label }))} />
        </div>
        <div className="relative w-64">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 h-4 w-4 -translate-y-1/2 text-muted" />
          <Input sm className="pl-8" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search settings" aria-label="Search settings" />
        </div>
      </div>
      <div className="text-[12.5px] text-muted">{needle ? `${sections.reduce((n, s) => n + s.items.length, 0)} setting(s) found` : screenInfo.hint}</div>
      {!custom && <div className="rounded-lg bg-info-soft px-3 py-2 text-[12.5px] text-info">Standard mode is on, so these switches show the standard behaviour and cannot be changed. Choose Editable above to change them.</div>}

      {sections.map((sec) => (
        <Card key={sec.key} title={needle ? `${OPTION_SCREENS.find((s) => s.key === sec.screen)!.label}: ${sec.name}` : sec.name} className={cx(!custom && 'opacity-60')}>
          <div className="divide-y divide-line">
            {sec.items.map(row)}
            {LINKS.filter((l) => l.screen === sec.screen && l.section === sec.name && (!needle || l.label.toLowerCase().includes(needle))).map((l) => (
              <button key={l.label} type="button" onClick={() => nav(`/settings?tab=${l.tab}`)} className="flex w-full items-center justify-between gap-6 py-2.5 text-left cursor-pointer hover:text-brand">
                <span className="flex items-center gap-2">
                  <span className="font-medium">{l.label}</span>
                  <span title={l.hint} className="text-muted"><Info className="h-3.5 w-3.5" /></span>
                </span>
                <ChevronRight className="h-4 w-4" />
              </button>
            ))}
          </div>
        </Card>
      ))}
      {needle && sections.length === 0 && <Card><div className="py-6 text-center text-muted">No setting matches "{q}".</div></Card>}
    </div>
  )
}

/** A number saved when the box is left or Enter is pressed (not on every keystroke). */
function NumberBox({ def, value, disabled, onSave }: { def: Extract<OptionDef, { kind: 'number' }>; value: number; disabled: boolean; onSave: (v: number) => void }): JSX.Element {
  const [text, setText] = useState<string | null>(null)
  const commit = (): void => {
    if (text === null) return
    const n = Number(text)
    setText(null)
    if (Number.isFinite(n) && Math.round(n) !== value) onSave(Math.min(def.max, Math.max(def.min, Math.round(n))))
  }
  return (
    <div className="flex items-center gap-2">
      <Input sm type="number" className="w-24 text-right" min={def.min} max={def.max} disabled={disabled} value={text ?? String(value)} onChange={(e) => setText(e.target.value)} onBlur={commit} onKeyDown={(e) => e.key === 'Enter' && commit()} />
      {def.unit && <span className="text-[12.5px] text-muted">{def.unit}</span>}
    </div>
  )
}

function TextBox({ def, value, disabled, onSave }: { def: Extract<OptionDef, { kind: 'text' }>; value: string; disabled: boolean; onSave: (v: string) => void }): JSX.Element {
  const [text, setText] = useState<string | null>(null)
  const commit = (): void => {
    if (text === null) return
    const t = text.trim()
    setText(null)
    if (t !== value) onSave(t)
  }
  return <Input sm className="w-56" maxLength={60} disabled={disabled} value={text ?? value} placeholder={def.placeholder} onChange={(e) => setText(e.target.value)} onBlur={commit} onKeyDown={(e) => e.key === 'Enter' && commit()} />
}
