/* eslint-disable @typescript-eslint/no-explicit-any */
import { ReactNode, useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { AlertTriangle, Check, Coins, FileText, FolderKanban, Info, Lock, Package, Palette, Pencil, Plus, Printer, Save, Settings, Trash2, Undo2 } from 'lucide-react'
import { api } from '../../api'
import { useApp, useCan } from '../../store'
import { Badge, Button, Card, Checkbox, Field, IconButton, Input, Loading, Modal, NumberInput, PageHeader, Select, Tabs, Textarea, Toggle, confirmDialog, cx, toast } from '../../components/ui'
import { useLoad } from '../../lib/hooks'
import { THEMES, applyTheme, getTheme } from '../../lib/theme'
import { amountInWords, formatMoney } from '@shared/money'
import { EXTRA_SECTIONS } from './sections'

type TabKey = 'general' | 'inventory' | 'projects' | 'documents' | 'security' | 'appearance' | 'printing'

/** Settings keys edited on this page, grouped by tab (used for the "unsaved" counters). */
const TAB_KEYS: Record<TabKey, string[]> = {
  general: ['currency_symbol', 'currency_code', 'currency_word', 'money_decimals'],
  inventory: ['allow_negative_stock', 'purchase_tax_is_cost'],
  projects: ['overhead_method', 'overhead_percent'],
  documents: ['default_invoice_terms', 'default_quotation_terms'],
  security: ['lock_minutes'],
  appearance: [],
  printing: ['show_vendor_branding']
}
const ALL_KEYS = Object.values(TAB_KEYS).flat()
const TAB_ORDER: TabKey[] = ['general', 'inventory', 'projects', 'documents', 'security', 'appearance', 'printing']

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)

export function SettingsPage(): JSX.Element {
  const can = useCan()
  const canEdit = can('settings.manage')
  const licenseWritable = useApp((s) => s.license?.canWrite ?? false)
  const editable = canEdit && licenseWritable
  const [params, setParams] = useSearchParams()
  const extras = EXTRA_SECTIONS.filter((x) => x.perms.length === 0 || x.perms.some(can))
  const tabParam = params.get('tab')
  const builtIn = canEdit ? TAB_ORDER : []
  const allTabs: string[] = [...builtIn, ...extras.map((x) => x.key)]
  const tab: string = tabParam && allTabs.includes(tabParam) ? tabParam : allTabs[0] ?? 'license'
  const setTab = (t: string): void => setParams({ tab: t }, { replace: true })
  const extra = extras.find((x) => x.key === tab)

  const loaded = useLoad(() => api<Record<string, any>>('settings.get'), [])
  const [orig, setOrig] = useState<Record<string, any> | null>(null)
  const [draft, setDraft] = useState<Record<string, any>>({})
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (loaded.data) {
      setOrig(loaded.data)
      setDraft(loaded.data)
    }
  }, [loaded.data])

  const changed = useMemo(() => (orig ? ALL_KEYS.filter((k) => !same(draft[k], orig[k])) : []), [draft, orig])
  const set = (k: string, v: unknown): void => setDraft((d) => ({ ...d, [k]: v }))

  const validate = (): string | null => {
    if (changed.includes('currency_code') && !/^[A-Za-z]{2,5}$/.test(String(draft.currency_code ?? '').trim())) return 'Currency code must be 2–5 letters (for example PKR).'
    if (changed.includes('currency_word') && !String(draft.currency_word ?? '').trim()) return 'Enter the currency word used for amounts in words (for example Rupees).'
    const pctVal = Number(draft.overhead_percent)
    if (changed.includes('overhead_percent') && (!Number.isFinite(pctVal) || pctVal < 0 || pctVal > 100)) return 'Overhead percent must be between 0 and 100.'
    const lock = Number(draft.lock_minutes)
    if (changed.includes('lock_minutes') && (!Number.isFinite(lock) || lock < 0 || lock > 240)) return 'Auto-lock must be between 0 and 240 minutes.'
    return null
  }

  const save = async (): Promise<void> => {
    if (!orig || changed.length === 0) return
    const err = validate()
    if (err) return toast.error(err)
    const patch: Record<string, unknown> = {}
    for (const k of changed) {
      let v = draft[k]
      if (typeof v === 'string' && ['currency_symbol', 'currency_code', 'currency_word'].includes(k)) v = v.trim()
      patch[k] = v
    }
    setSaving(true)
    try {
      const next = await api<Record<string, any>>('settings.update', { patch })
      setOrig(next)
      setDraft(next)
      await useApp.getState().refresh()
      toast.ok(`Settings saved (${changed.length} change${changed.length === 1 ? '' : 's'}).`)
    } catch (e) {
      toast.error(e)
    } finally {
      setSaving(false)
    }
  }

  const discard = async (): Promise<void> => {
    if (!orig) return
    if (!(await confirmDialog({ title: 'Discard changes?', message: `You have ${changed.length} unsaved change(s). They will be lost.`, confirmLabel: 'Discard', danger: true }))) return
    setDraft(orig)
  }

  if (!orig) return <Loading label="Loading settings…" />

  const tabsBar = (
    <Tabs
      value={tab}
      onChange={setTab}
      tabs={[
        ...(canEdit
          ? [
              { key: 'general', label: 'General', count: count('general') },
              { key: 'inventory', label: 'Inventory & tax', count: count('inventory') },
              { key: 'projects', label: 'Projects', count: count('projects') },
              { key: 'documents', label: 'Documents', count: count('documents') },
              { key: 'security', label: 'Security', count: count('security') },
              { key: 'appearance', label: 'Appearance' },
              { key: 'printing', label: 'Printing', count: count('printing') }
            ]
          : []),
        ...extras.map((x) => ({ key: x.key, label: x.label }))
      ]}
    />
  )

  if (extra) {
    const Section = extra.component
    return (
      <div className="space-y-4">
        <PageHeader title="Settings" subtitle="Application-wide preferences for all firms on this computer" icon={<Settings className="h-5 w-5" />} />
        {tabsBar}
        <Section />
      </div>
    )
  }

  function count(t: TabKey): number | undefined {
    const n = TAB_KEYS[t].filter((k) => changed.includes(k)).length
    return n > 0 ? n : undefined
  }

  return (
    <div className="space-y-4">
      <PageHeader
        title="Settings"
        subtitle="Application-wide preferences for all firms on this computer"
        icon={<Settings className="h-5 w-5" />}
        actions={
          canEdit && (
            <>
              {changed.length > 0 && <Badge tone="warn">{changed.length} unsaved change{changed.length === 1 ? '' : 's'}</Badge>}
              <Button icon={<Undo2 className="h-4 w-4" />} disabled={changed.length === 0 || saving} onClick={discard}>
                Discard
              </Button>
              <Button variant="primary" icon={<Save className="h-4 w-4" />} loading={saving} disabled={changed.length === 0 || !licenseWritable} onClick={save}>
                Save changes
              </Button>
            </>
          )
        }
      />

      {!canEdit && (
        <Notice tone="info">You can view these settings but you do not have permission to change them. Ask the owner or an administrator (permission: “Change application settings”).</Notice>
      )}
      {canEdit && !licenseWritable && <Notice tone="warn">The license is currently read-only, so settings cannot be saved. Open Settings → “License &amp; About” to resolve the license problem — your data is safe.</Notice>}

      {tabsBar}

      {tab === 'general' && <GeneralTab draft={draft} set={set} editable={editable} />}
      {tab === 'inventory' && <InventoryTab draft={draft} set={set} editable={editable} canEdit={canEdit} licenseWritable={licenseWritable} />}
      {tab === 'projects' && <ProjectsTab draft={draft} set={set} editable={editable} />}
      {tab === 'documents' && <DocumentsTab draft={draft} set={set} editable={editable} />}
      {tab === 'security' && <SecurityTab draft={draft} set={set} editable={editable} />}
      {tab === 'appearance' && <AppearanceTab />}
      {tab === 'printing' && <PrintingTab draft={draft} set={set} editable={editable} />}
    </div>
  )
}

interface TabProps {
  draft: Record<string, any>
  set: (k: string, v: unknown) => void
  editable: boolean
}

function Notice({ tone, children, icon }: { tone: 'info' | 'warn' | 'bad' | 'ok'; children: ReactNode; icon?: ReactNode }): JSX.Element {
  const cls = { info: 'bg-info-soft text-info', warn: 'bg-warn-soft text-warn', bad: 'bg-bad-soft text-bad', ok: 'bg-ok-soft text-ok' }[tone]
  return (
    <div className={cx('flex items-start gap-2.5 rounded-xl px-3.5 py-2.5 text-[13px] leading-relaxed', cls)}>
      <span className="mt-0.5 shrink-0 [&>svg]:h-4 [&>svg]:w-4">{icon ?? (tone === 'info' ? <Info /> : <AlertTriangle />)}</span>
      <div>{children}</div>
    </div>
  )
}

function SectionTitle({ icon, title, subtitle }: { icon: ReactNode; title: string; subtitle?: string }): JSX.Element {
  return (
    <div className="flex items-center gap-2.5">
      <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand-soft text-brand [&>svg]:h-4 [&>svg]:w-4">{icon}</span>
      <div>
        <div className="font-semibold">{title}</div>
        {subtitle && <div className="text-[12px] font-normal text-muted">{subtitle}</div>}
      </div>
    </div>
  )
}

/* ------------------------------------------------ General ------------------------------------------------ */
function GeneralTab({ draft, set, editable }: TabProps): JSX.Element {
  const dec = Math.min(2, Math.max(0, Number(draft.money_decimals ?? 0)))
  const symbol = String(draft.currency_symbol ?? '')
  const word = String(draft.currency_word ?? '').trim() || 'Rupees'
  const sample = 1250750.5
  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_360px]">
      <Card title={<SectionTitle icon={<Coins />} title="Currency & money format" subtitle="Used on screens, reports and printed documents" />}>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Currency symbol" hint="Shown before amounts, e.g. Rs. or ₨">
            <Input value={symbol} maxLength={8} disabled={!editable} onChange={(e) => set('currency_symbol', e.target.value)} placeholder="Rs." />
          </Field>
          <Field label="Currency code" hint="International code, e.g. PKR">
            <Input value={String(draft.currency_code ?? '')} maxLength={5} disabled={!editable} onChange={(e) => set('currency_code', e.target.value.toUpperCase().replace(/[^A-Z]/g, ''))} placeholder="PKR" />
          </Field>
          <Field label="Currency word (amount in words)" hint="e.g. Rupees — printed as “… Rupees Only”">
            <Input value={String(draft.currency_word ?? '')} maxLength={30} disabled={!editable} onChange={(e) => set('currency_word', e.target.value)} placeholder="Rupees" />
          </Field>
          <Field label="Decimal places for money" hint="0 is typical for PKR; calculations are always exact to 2 decimals">
            <Select value={String(dec)} disabled={!editable} onChange={(e) => set('money_decimals', Number(e.target.value))}>
              <option value="0">0 — 1,250,751</option>
              <option value="1">1 — 1,250,750.5</option>
              <option value="2">2 — 1,250,750.50</option>
            </Select>
          </Field>
        </div>
      </Card>
      <Card title="Preview">
        <div className="space-y-3 text-[13px]">
          <div>
            <div className="text-[12px] text-muted">Amount</div>
            <div className="num text-[22px] font-bold tracking-tight">{formatMoney(sample, symbol, dec)}</div>
          </div>
          <div>
            <div className="text-[12px] text-muted">Amount in words (invoices)</div>
            <div className="font-medium">{amountInWords(sample, word)}</div>
          </div>
          <div className="text-[12px] text-muted">
            Code: <b className="text-ink">{String(draft.currency_code ?? '') || '—'}</b>
          </div>
        </div>
      </Card>
    </div>
  )
}

/* ------------------------------------------------ Inventory & tax ------------------------------------------------ */
function InventoryTab({ draft, set, editable, canEdit, licenseWritable }: TabProps & { canEdit: boolean; licenseWritable: boolean }): JSX.Element {
  return (
    <div className="space-y-4">
      <Card title={<SectionTitle icon={<Package />} title="Stock rules" />}>
        <div className="space-y-5">
          <div className="space-y-2">
            <Toggle
              checked={!!draft.allow_negative_stock}
              disabled={!editable}
              onChange={(v) => set('allow_negative_stock', v)}
              label="Allow negative stock"
              description="Let users sell or issue items even when the system shows not enough stock."
            />
            {draft.allow_negative_stock ? (
              <Notice tone="warn">
                Negative stock is allowed. Stock quantities and average cost can become inaccurate, and profit reports may be misleading until the missing purchases are entered. Keep this off unless you regularly sell before
                recording purchases.
              </Notice>
            ) : (
              <div className="text-[12px] text-muted">Recommended: off. Sales and material issues are blocked when stock is not available.</div>
            )}
          </div>
          <div className="border-t border-line pt-5">
            <Toggle
              checked={!!draft.purchase_tax_is_cost}
              disabled={!editable}
              onChange={(v) => set('purchase_tax_is_cost', v)}
              label="Purchase tax is a cost (not recoverable)"
              description="Turn on if you cannot claim back the sales tax paid on purchases (e.g. not registered for input tax). The tax is then added to the item cost, so profit is calculated correctly. Turn off if purchase tax is recoverable — it is then kept separately in the tax report."
            />
            <div className="mt-2 text-[12px] text-muted">Applies to purchases recorded after the change. Existing purchases keep the cost they were recorded with.</div>
          </div>
        </div>
      </Card>
      <TaxRatesCard canEdit={canEdit} licenseWritable={licenseWritable} />
    </div>
  )
}

interface TaxRate {
  id: number
  name: string
  rate: number
  is_default: number
  is_active: number
}

function TaxRatesCard({ canEdit, licenseWritable }: { canEdit: boolean; licenseWritable: boolean }): JSX.Element {
  const editable = canEdit && licenseWritable
  const rates = useLoad(() => api<TaxRate[]>('taxRates.list'), [])
  const [edit, setEdit] = useState<{ id?: number; name: string; rate: number; isActive: boolean; isDefault: boolean } | null>(null)
  const [busy, setBusy] = useState(false)
  const rows = rates.data ?? []

  const saveRate = async (): Promise<void> => {
    if (!edit) return
    if (!edit.name.trim()) return toast.error('Enter a name for the tax rate.')
    if (!(edit.rate >= 0 && edit.rate <= 100)) return toast.error('Tax rate must be between 0 and 100.')
    if (edit.isDefault && !edit.isActive) return toast.error('The default tax rate must be active.')
    setBusy(true)
    try {
      await api('taxRates.save', { id: edit.id, name: edit.name.trim(), rate: edit.rate, isActive: edit.isActive, isDefault: edit.isDefault })
      toast.ok(edit.id ? 'Tax rate updated.' : 'Tax rate added.')
      setEdit(null)
      await rates.reload()
    } catch (e) {
      toast.error(e)
    } finally {
      setBusy(false)
    }
  }

  const makeDefault = async (t: TaxRate): Promise<void> => {
    if (t.is_default) return
    try {
      await api('taxRates.save', { id: t.id, name: t.name, rate: t.rate, isActive: true, isDefault: true })
      toast.ok(`${t.name} is now the default tax rate.`)
      await rates.reload()
    } catch (e) {
      toast.error(e)
    }
  }

  const remove = async (t: TaxRate): Promise<void> => {
    const ok = await confirmDialog({
      title: 'Delete tax rate?',
      message: (
        <>
          Delete <b>{t.name} ({t.rate}%)</b>? Existing documents keep the tax they were saved with. If you only want to stop using it, edit it and mark it inactive instead.
        </>
      ),
      confirmLabel: 'Delete',
      danger: true
    })
    if (!ok) return
    try {
      await api('taxRates.delete', { id: t.id })
      toast.ok('Tax rate deleted.')
      await rates.reload()
    } catch (e) {
      toast.error(e)
    }
  }

  return (
    <Card
      pad={false}
      title={<SectionTitle icon={<Coins />} title="Tax rates" subtitle="Changes here are saved immediately" />}
      actions={
        canEdit && (
          <Button size="sm" variant="primary" icon={<Plus className="h-4 w-4" />} disabled={!licenseWritable} onClick={() => setEdit({ name: '', rate: 0, isActive: true, isDefault: rows.length === 0 })}>
            Add tax rate
          </Button>
        )
      }
    >
      {rates.loading && !rates.data ? (
        <Loading />
      ) : rows.length === 0 ? (
        <div className="px-4 py-8 text-center text-[13px] text-muted">No tax rates yet. Add one (for example “GST 18%” or “No tax 0%”).</div>
      ) : (
        <table className="tbl">
          <thead>
            <tr>
              <th style={{ width: 80 }} className="text-center">
                Default
              </th>
              <th>Name</th>
              <th className="text-right">Rate</th>
              <th>Status</th>
              <th style={{ width: 90 }} />
            </tr>
          </thead>
          <tbody>
            {rows.map((t) => (
              <tr key={t.id}>
                <td className="text-center">
                  <input
                    type="radio"
                    name="default-tax-rate"
                    className="h-4 w-4 cursor-pointer accent-[var(--brand)] disabled:cursor-not-allowed"
                    checked={!!t.is_default}
                    disabled={!editable || !t.is_active}
                    title={!t.is_active ? 'Inactive rates cannot be the default' : 'Make this the default tax rate'}
                    onChange={() => makeDefault(t)}
                  />
                </td>
                <td className="font-medium">
                  {t.name} {!!t.is_default && <Badge tone="brand">Default</Badge>}
                </td>
                <td className="num text-right">{Number(t.rate).toFixed(2).replace(/\.00$/, '')}%</td>
                <td>{t.is_active ? <Badge tone="ok">Active</Badge> : <Badge tone="muted">Inactive</Badge>}</td>
                <td className="text-right">
                  {canEdit && (
                    <div className="flex justify-end gap-1">
                      <IconButton title="Edit" disabled={!licenseWritable} onClick={() => setEdit({ id: t.id, name: t.name, rate: Number(t.rate), isActive: !!t.is_active, isDefault: !!t.is_default })}>
                        <Pencil className="h-4 w-4" />
                      </IconButton>
                      <IconButton title={t.is_default ? 'The default tax rate cannot be deleted' : 'Delete'} tone="bad" disabled={!licenseWritable || !!t.is_default} onClick={() => remove(t)}>
                        <Trash2 className="h-4 w-4" />
                      </IconButton>
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <Modal
        open={!!edit}
        onClose={() => setEdit(null)}
        title={edit?.id ? 'Edit tax rate' : 'Add tax rate'}
        size="sm"
        footer={
          <>
            <Button onClick={() => setEdit(null)}>Cancel</Button>
            <Button variant="primary" loading={busy} onClick={saveRate}>
              Save
            </Button>
          </>
        }
      >
        {edit && (
          <div className="space-y-4">
            <Field label="Name" required>
              <Input autoFocus value={edit.name} maxLength={60} placeholder="e.g. GST 18%" onChange={(e) => setEdit({ ...edit, name: e.target.value })} />
            </Field>
            <Field label="Rate (%)" required hint="Between 0 and 100">
              <NumberInput value={edit.rate} onChange={(v) => setEdit({ ...edit, rate: v })} />
            </Field>
            <Checkbox checked={edit.isActive} onChange={(v) => setEdit({ ...edit, isActive: v, isDefault: v ? edit.isDefault : false })} label="Active (available on documents and products)" />
            <div>
              <Checkbox checked={edit.isDefault} disabled={!edit.isActive} onChange={(v) => setEdit({ ...edit, isDefault: v })} label="Default tax rate for new products" />
            </div>
          </div>
        )}
      </Modal>
    </Card>
  )
}

/* ------------------------------------------------ Projects ------------------------------------------------ */
const OVERHEAD_METHODS: Array<{ key: string; title: string; text: string }> = [
  {
    key: 'none',
    title: 'No overhead allocation',
    text: 'Project profit shows direct costs only (materials, labour, transport and expenses charged to the project). General business overheads such as rent, salaries and electricity stay in the Profit & Loss report and are not charged to projects.'
  },
  {
    key: 'manual',
    title: 'Manual amount per project',
    text: 'Enter an overhead amount on each project (Projects → Edit project → Overhead amount). That amount is deducted from the project’s gross profit to give net profit. Best when overheads differ a lot between projects.'
  },
  {
    key: 'percent_revenue',
    title: 'Percent of project revenue',
    text: 'A fixed percentage of each project’s revenue is charged as overhead automatically. Example: at 5%, a project with revenue of 1,000,000 is charged 50,000 overhead. Simple and consistent across all projects.'
  }
]

function ProjectsTab({ draft, set, editable }: TabProps): JSX.Element {
  const method = String(draft.overhead_method ?? 'none')
  const pctVal = Number(draft.overhead_percent ?? 0)
  return (
    <Card title={<SectionTitle icon={<FolderKanban />} title="Overhead allocation" subtitle="How business overheads are charged when calculating project net profit" />}>
      <div className="grid gap-3 md:grid-cols-3">
        {OVERHEAD_METHODS.map((m) => (
          <button
            key={m.key}
            type="button"
            disabled={!editable}
            onClick={() => set('overhead_method', m.key)}
            className={cx(
              'flex flex-col items-start gap-2 rounded-xl border-2 p-4 text-left transition disabled:cursor-not-allowed',
              editable && 'cursor-pointer',
              method === m.key ? 'border-brand bg-brand-soft' : 'border-line hover:border-muted'
            )}
          >
            <span className="flex w-full items-center justify-between gap-2">
              <span className="font-semibold">{m.title}</span>
              <span className={cx('flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2', method === m.key ? 'border-brand bg-brand text-on-brand' : 'border-line')}>
                {method === m.key && <Check className="h-3 w-3" />}
              </span>
            </span>
            <span className="text-[12.5px] leading-relaxed text-muted">{m.text}</span>
          </button>
        ))}
      </div>
      {method === 'percent_revenue' && (
        <div className="mt-4 flex flex-wrap items-end gap-4 rounded-xl border border-line bg-surface-2 p-4">
          <Field label="Overhead percent of revenue" hint="0 – 100" className="w-48">
            <div className="flex items-center gap-2">
              <NumberInput value={pctVal} disabled={!editable} onChange={(v) => set('overhead_percent', v)} />
              <span className="text-muted">%</span>
            </div>
          </Field>
          <div className="pb-1 text-[13px] text-muted">
            Revenue 1,000,000 → overhead <b className="text-ink">{formatMoney((1000000 * (Number.isFinite(pctVal) ? pctVal : 0)) / 100, '', 0)}</b>
          </div>
        </div>
      )}
      <div className="mt-4 text-[12px] text-muted">The change applies to project profit reports immediately, for all projects (past and present). No transactions are modified.</div>
    </Card>
  )
}

/* ------------------------------------------------ Documents ------------------------------------------------ */
function DocumentsTab({ draft, set, editable }: TabProps): JSX.Element {
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card title={<SectionTitle icon={<FileText />} title="Default invoice terms" subtitle="Pre-filled on new sales invoices" />}>
        <Textarea
          rows={8}
          maxLength={5000}
          disabled={!editable}
          value={String(draft.default_invoice_terms ?? '')}
          onChange={(e) => set('default_invoice_terms', e.target.value)}
          placeholder="One term per line…"
        />
        <div className="mt-1.5 text-[12px] text-muted">One term per line. Users can still edit the terms on each invoice.</div>
      </Card>
      <Card title={<SectionTitle icon={<FileText />} title="Default quotation terms" subtitle="Pre-filled on new quotations" />}>
        <Textarea
          rows={8}
          maxLength={5000}
          disabled={!editable}
          value={String(draft.default_quotation_terms ?? '')}
          onChange={(e) => set('default_quotation_terms', e.target.value)}
          placeholder="One term per line…"
        />
        <div className="mt-1.5 text-[12px] text-muted">Validity, advance payment, delivery and price-change terms are common here.</div>
      </Card>
    </div>
  )
}

/* ------------------------------------------------ Security ------------------------------------------------ */
const LOCK_PRESETS = [0, 5, 10, 15, 30, 60, 120]

function SecurityTab({ draft, set, editable }: TabProps): JSX.Element {
  const minutes = Number(draft.lock_minutes ?? 15)
  return (
    <Card title={<SectionTitle icon={<Lock />} title="Automatic screen lock" subtitle="Protects your data when the computer is left unattended" />}>
      <div className="space-y-4">
        <div className="flex flex-wrap items-end gap-4">
          <Field label="Lock after (minutes of inactivity)" hint="0 = never lock automatically · maximum 240" className="w-56">
            <NumberInput value={minutes} disabled={!editable} onChange={(v) => set('lock_minutes', Math.floor(v))} />
          </Field>
          <div className="flex flex-wrap gap-1.5 pb-5">
            {LOCK_PRESETS.map((m) => (
              <button
                key={m}
                type="button"
                disabled={!editable}
                onClick={() => set('lock_minutes', m)}
                className={cx(
                  'h-8 rounded-lg border px-3 text-[12.5px] font-medium transition disabled:cursor-not-allowed disabled:opacity-60',
                  editable && 'cursor-pointer',
                  minutes === m ? 'border-brand bg-brand text-on-brand' : 'border-line bg-surface hover:bg-surface-2'
                )}
              >
                {m === 0 ? 'Never' : m < 60 ? `${m} min` : `${m / 60} hr`}
              </button>
            ))}
          </div>
        </div>
        {minutes === 0 ? (
          <Notice tone="warn">Automatic lock is off. Anyone with access to this computer can use the app while a user is signed in. Use the Lock button in the top bar when you step away.</Notice>
        ) : (
          <div className="text-[12.5px] text-muted">
            After {minutes} minute{minutes === 1 ? '' : 's'} without activity the screen locks and the signed-in user must enter their password to continue. Unsaved work on the open screen is kept.
          </div>
        )}
      </div>
    </Card>
  )
}

/* ------------------------------------------------ Appearance ------------------------------------------------ */
function AppearanceTab(): JSX.Element {
  const [current, setCurrent] = useState(getTheme())
  return (
    <Card title={<SectionTitle icon={<Palette />} title="Theme & appearance" subtitle="Applied instantly and remembered on this computer only (not part of “Save changes”)" />}>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {THEMES.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => {
              applyTheme(t.key)
              setCurrent(t.key)
            }}
            className={cx('flex items-center gap-3 rounded-xl border-2 p-3 text-left transition cursor-pointer', current === t.key ? 'border-brand bg-brand-soft' : 'border-line hover:border-muted')}
          >
            <span className="flex overflow-hidden rounded-lg shadow-sm">
              {t.swatch.map((c) => (
                <span key={c} className="h-10 w-5" style={{ background: c }} />
              ))}
            </span>
            <span className="flex-1">
              <span className="block font-semibold">{t.name}</span>
              <span className="text-[12px] text-muted">{t.dark ? 'Dark mode' : 'Light mode'}</span>
            </span>
            {current === t.key && <Check className="h-5 w-5 text-brand" />}
          </button>
        ))}
      </div>
    </Card>
  )
}

/* ------------------------------------------------ Printing ------------------------------------------------ */
function PrintingTab({ draft, set, editable }: TabProps): JSX.Element {
  return (
    <Card title={<SectionTitle icon={<Printer />} title="Printed documents" subtitle="Invoices, quotations, receipts, statements and reports" />}>
      <Toggle
        checked={!!draft.show_vendor_branding}
        disabled={!editable}
        onChange={(v) => set('show_vendor_branding', v)}
        label="Show “Powered by DT Solar Pro · Digital Target” on printed documents"
        description="A small line in the footer of printed and PDF documents. Your own firm name, logo and details are always shown regardless of this setting."
      />
    </Card>
  )
}
