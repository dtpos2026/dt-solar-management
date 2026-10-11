/* eslint-disable @typescript-eslint/no-explicit-any */
import { CSSProperties, ReactNode, useEffect, useMemo, useRef, useState } from 'react'
import { Building2, Check, FileText, Hash, ImageOff, Info, Lock, Palette, Pencil, Plus, Printer, Save, Stamp, Signature, Upload, Trash2, Store } from 'lucide-react'
import { api } from '../../api'
import { useApp, useCan } from '../../store'
import { Badge, Button, Card, Empty, Field, IconButton, Input, Loading, Modal, NumberInput, PageHeader, Select, Tabs, Textarea, Toggle, confirmDialog, cx, readImageFile, toast } from '../../components/ui'
import { useLoad } from '../../lib/hooks'
import { money } from '../../lib/format'

/* ------------------------------------------------------------------------------------------------ */

interface FirmRow {
  id: number
  name: string
  tagline: string | null
  address: string | null
  city: string | null
  phone: string | null
  phone2: string | null
  email: string | null
  website: string | null
  ntn: string | null
  strn: string | null
  is_default: number
  is_active: number
  has_logo: number
}

interface Limits {
  licenseMax: number
  allowed: number
  count: number
}

interface PrintSettings {
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
  [k: string]: unknown
}

/** Mirrors DEFAULT_PRINT_SETTINGS in src/main/services/firms.ts */
const DEFAULT_PS: PrintSettings = {
  accentColor: '#0b5cad',
  showLogo: true,
  showSignature: true,
  showStamp: true,
  showWarranty: true,
  showSerials: true,
  showAmountInWords: true,
  showBankDetails: true,
  showPreviousBalance: true,
  showTaxColumns: 'auto',
  signatureLabel: 'Authorized Signature',
  receiverLabel: "Customer's Signature"
}

interface FirmForm {
  name: string
  tagline: string
  address: string
  city: string
  phone: string
  phone2: string
  email: string
  website: string
  ntn: string
  strn: string
  logo: string | null
  signature: string | null
  stamp: string | null
  bankDetails: string
  terms: string
  invoiceFooter: string
  isActive: boolean
  printSettings: PrintSettings
}

interface SeqRow {
  doc_type: string
  label: string
  prefix: string
  next_no: number
  padding: number
}

const EMPTY_FORM: FirmForm = {
  name: '',
  tagline: '',
  address: '',
  city: '',
  phone: '',
  phone2: '',
  email: '',
  website: '',
  ntn: '',
  strn: '',
  logo: null,
  signature: null,
  stamp: null,
  bankDetails: '',
  terms: '',
  invoiceFooter: '',
  isActive: true,
  printSettings: DEFAULT_PS
}

const SWATCHES: Array<{ color: string; name: string }> = [
  { color: '#0b5cad', name: 'Classic blue' },
  { color: '#0f766e', name: 'Teal' },
  { color: '#15803d', name: 'Green' },
  { color: '#c2410c', name: 'Solar orange' },
  { color: '#b91c1c', name: 'Red' },
  { color: '#6d28d9', name: 'Purple' }
]

const PREFIX_RE = /^[A-Za-z0-9/_\-.#]*$/
const HEX_RE = /^#[0-9a-fA-F]{6}$/

const CHECKER: CSSProperties = {
  backgroundColor: '#ffffff',
  backgroundImage: 'repeating-conic-gradient(#e5e7eb 0% 25%, #ffffff 0% 50%)',
  backgroundSize: '16px 16px'
}

const formatNo = (prefix: string, next: number, padding: number): string => `${prefix}${String(Math.max(1, Math.floor(next || 1))).padStart(Math.min(10, Math.max(1, Math.floor(padding || 1))), '0')}`

/** Loads the logo of every firm that has one (firms.all only returns a has_logo flag). */
function useFirmLogos(firms: FirmRow[] | undefined): Record<number, string> {
  const [logos, setLogos] = useState<Record<number, string>>({})
  useEffect(() => {
    if (!firms) return
    let alive = true
    Promise.all(
      firms
        .filter((f) => f.has_logo)
        .map((f) =>
          api<any>('firms.get', { id: f.id })
            .then((r) => [f.id, String(r.logo ?? '')] as [number, string])
            .catch(() => null)
        )
    ).then((list) => {
      if (alive) setLogos(Object.fromEntries(list.filter((x): x is [number, string] => !!x && !!x[1])))
    })
    return () => {
      alive = false
    }
  }, [firms])
  return logos
}

/* ================================================================================================ */

export function MultiFirmPage(): JSX.Element {
  const can = useCan()
  const allowed = can('firms.manage')
  const settings = useApp((s) => s.settings)
  const activeFirm = useApp((s) => s.firm)
  const license = useApp((s) => s.license)
  const firms = useLoad(() => (allowed ? api<FirmRow[]>('firms.all') : Promise.resolve([] as FirmRow[])), [allowed])
  const limits = useLoad(() => api<Limits>('firms.limits'), [])
  const logos = useFirmLogos(firms.data)
  const [editor, setEditor] = useState<{ open: boolean; id?: number }>({ open: false })
  const [busy, setBusy] = useState<string | null>(null)
  const [maxFirms, setMaxFirms] = useState<number>(Number(settings.max_firms ?? 5))

  useEffect(() => setMaxFirms(Number(settings.max_firms ?? 5)), [settings.max_firms])

  if (!allowed) {
    return (
      <div>
        <PageHeader title="Multi-Firm settings" icon={<Building2 className="h-5 w-5" />} />
        <Card>
          <Empty icon={<Lock className="h-6 w-6" />} title="You do not have access to this section">
            Ask your administrator for the “Manage firms & multi-firm settings” permission.
          </Empty>
        </Card>
      </div>
    )
  }

  const multi = settings.multi_firm_enabled !== false
  const shareInventory = settings.share_inventory !== false
  const shareParties = settings.share_parties !== false
  const L = limits.data
  const list = firms.data ?? []
  const count = L?.count ?? list.length
  const licenseMax = L?.licenseMax ?? license?.maxFirms ?? 1
  const allowedFirms = L?.allowed ?? 1
  const maxCap = licenseMax > 0 ? Math.min(100, licenseMax) : 100

  const reloadAll = async (): Promise<void> => {
    await Promise.all([firms.reload(), limits.reload(), useApp.getState().refresh()])
  }

  const saveSetting = async (key: string, patch: Record<string, unknown>, okText: string): Promise<void> => {
    setBusy(key)
    try {
      await api('settings.update', { patch })
      await useApp.getState().refresh()
      await limits.reload()
      toast.ok(okText)
    } catch (e) {
      toast.error(e)
    } finally {
      setBusy(null)
    }
  }

  const toggleMulti = async (v: boolean): Promise<void> => {
    if (!v && count > 1) {
      const ok = await confirmDialog({
        title: 'Turn off multiple firms?',
        message: (
          <>
            Your existing firms and all their data are kept. Users will sign in to the <b>default firm</b> and will not be able to switch firms or add new ones until you turn this on again.
          </>
        ),
        confirmLabel: 'Turn off',
        danger: true
      })
      if (!ok) return
    }
    await saveSetting('multi', { multi_firm_enabled: v }, v ? 'Multiple firms enabled.' : 'Multiple firms disabled.')
  }

  const saveMax = async (): Promise<void> => {
    const n = Math.floor(Number(maxFirms) || 0)
    if (n < Math.max(1, count)) return toast.error(`Maximum firms cannot be less than the ${count} firm${count === 1 ? '' : 's'} you already have.`)
    if (n > maxCap) return toast.error(licenseMax > 0 ? `Your license allows up to ${licenseMax} firms.` : 'Maximum is 100 firms.')
    await saveSetting('max', { max_firms: n }, `Maximum firms set to ${n}.`)
  }

  const makeDefault = async (f: FirmRow): Promise<void> => {
    if (f.is_default) return
    if (!f.is_active) return toast.error('Activate this firm before making it the default.')
    const ok = await confirmDialog({
      title: `Make ${f.name} the default firm?`,
      message: 'The default firm is opened automatically when users sign in (unless they last worked in another firm) and is used when multiple firms are turned off. It cannot be deactivated.',
      confirmLabel: 'Make default'
    })
    if (!ok) return
    try {
      await api('firms.setDefault', { id: f.id })
      await reloadAll()
      toast.ok(`${f.name} is now the default firm.`)
    } catch (e) {
      toast.error(e)
    }
  }

  const addBlocked: string | null = !multi && count >= 1 ? 'Turn on “Enable Multiple Firms” to add another firm.' : count >= allowedFirms ? `You have reached the maximum of ${allowedFirms} firm${allowedFirms === 1 ? '' : 's'}.${licenseMax > 0 && allowedFirms >= licenseMax ? ' Upgrade your license to add more.' : ' Increase “Maximum firms” above to add more.'}` : null

  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader title="Multi-Firm settings" subtitle="Run several businesses or branches from one installation" icon={<Building2 className="h-5 w-5" />} />

      {license && !license.canWrite && (
        <div className="mb-4 flex items-start gap-3 rounded-xl bg-warn-soft px-4 py-3 text-[13px]">
          <Lock className="mt-0.5 h-4 w-4 shrink-0 text-warn" />
          <div>{license.message || 'Your license is read-only. Changes cannot be saved.'}</div>
        </div>
      )}

      <Card className="mb-4">
        <div className="space-y-4">
          <Toggle
            checked={multi}
            disabled={busy === 'multi'}
            onChange={toggleMulti}
            label={<span className="text-[15px]">Enable Multiple Firms</span>}
            description="Allows you to create multiple firms for the same business where inventory and parties are shared across firms."
          />
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
            <div className="font-semibold text-info">
              You can create maximum {allowedFirms} firm{allowedFirms === 1 ? '' : 's'}.
            </div>
            <div className="text-[12.5px] text-muted">
              {count} created · license allows {licenseMax > 0 ? `up to ${licenseMax}` : 'unlimited'} firm{licenseMax === 1 ? '' : 's'}
            </div>
          </div>
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-2">
            <div className={cx('h-full rounded-full transition-all', count >= allowedFirms ? 'bg-warn' : 'bg-info')} style={{ width: `${Math.min(100, (count / Math.max(1, allowedFirms)) * 100)}%` }} />
          </div>

          <div className={cx('space-y-4 border-t border-line pt-4', !multi && 'opacity-60')}>
            <Toggle
              checked={shareInventory}
              disabled={!multi || busy === 'inv'}
              onChange={(v) => saveSetting('inv', { share_inventory: v }, v ? 'Inventory will be shared between firms.' : 'New products and warehouses will belong to one firm.')}
              label="Share inventory between firms"
              description="Products, categories and warehouses created from now on are visible to every firm. Existing items keep their current sharing."
            />
            <Toggle
              checked={shareParties}
              disabled={!multi || busy === 'parties'}
              onChange={(v) => saveSetting('parties', { share_parties: v }, v ? 'Customers & suppliers will be shared between firms.' : 'New customers & suppliers will belong to one firm.')}
              label="Share customers & suppliers between firms"
              description="Customers and suppliers created from now on are available in every firm. Balances are always kept per firm."
            />
            <div className="flex flex-wrap items-end justify-between gap-4">
              <div>
                <div className="font-medium">Maximum firms</div>
                <div className="mt-0.5 text-[12.5px] text-muted">
                  Between {Math.max(1, count)} and {maxCap}
                  {licenseMax > 0 ? ' (your license limit)' : ''}.
                </div>
              </div>
              <div className="flex items-center gap-2">
                <NumberInput className="w-24" value={maxFirms} min={1} disabled={!multi} onChange={(v) => setMaxFirms(v)} />
                <Button variant="soft" icon={<Save className="h-4 w-4" />} loading={busy === 'max'} disabled={!multi || Math.floor(maxFirms) === Number(settings.max_firms ?? 5)} onClick={saveMax}>
                  Save
                </Button>
              </div>
            </div>
          </div>
        </div>
      </Card>

      <Card
        pad={false}
        title={
          <span className="flex items-center gap-2">
            Firms <Badge tone="muted">{list.length}</Badge>
          </span>
        }
      >
        {firms.loading && !firms.data ? (
          <Loading />
        ) : list.length === 0 ? (
          <Empty icon={<Store />} title="No firms yet" />
        ) : (
          <div>
            {list.map((f) => {
              const isActiveNow = activeFirm?.id === f.id
              return (
                <div key={f.id} className={cx('flex items-center gap-4 border-b border-line px-4 py-3 last:border-b-0 hover:bg-surface-2', !f.is_active && 'opacity-70')}>
                  <button
                    type="button"
                    role="radio"
                    aria-checked={!!f.is_default}
                    title={f.is_default ? 'Default firm' : f.is_active ? 'Make this the default firm' : 'Inactive firms cannot be the default'}
                    disabled={!f.is_active && !f.is_default}
                    onClick={() => makeDefault(f)}
                    className={cx('flex h-6 w-6 shrink-0 items-center justify-center rounded-full border-2 transition disabled:cursor-not-allowed disabled:opacity-40', f.is_default ? 'border-brand' : 'cursor-pointer border-line hover:border-brand')}
                  >
                    {!!f.is_default && <span className="h-3 w-3 rounded-full bg-brand" />}
                  </button>
                  <div className="flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-xl border border-line bg-white">
                    {logos[f.id] ? <img src={logos[f.id]} alt="" className="max-h-full max-w-full object-contain p-1" /> : <Building2 className="h-6 w-6 text-slate-400" />}
                  </div>
                  <button type="button" className="min-w-0 flex-1 cursor-pointer text-left" onClick={() => setEditor({ open: true, id: f.id })}>
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="truncate text-[14.5px] font-bold tracking-wide uppercase">{f.name}</span>
                      {!!f.is_default && <Badge tone="brand">DEFAULT</Badge>}
                      {!f.is_active && <Badge tone="bad">Inactive</Badge>}
                      {isActiveNow && <Badge tone="ok">Active now</Badge>}
                    </div>
                    <div className="truncate text-[12.5px] text-muted">{[f.city, f.phone, f.email].filter(Boolean).join(' · ') || f.tagline || 'No contact details yet'}</div>
                  </button>
                  <IconButton title="Edit firm" onClick={() => setEditor({ open: true, id: f.id })}>
                    <Pencil className="h-4 w-4" />
                  </IconButton>
                </div>
              )
            })}
          </div>
        )}
      </Card>

      <div className="mt-4 flex items-start gap-3 rounded-xl bg-info-soft px-4 py-3 text-[13px]">
        <Info className="mt-0.5 h-4 w-4 shrink-0 text-info" />
        <div>
          The selected radio button marks the <b>default firm</b>. To <b>switch the firm you are working in</b>, use the firm selector in the top bar — every new invoice, payment and report is recorded under the active firm.
        </div>
      </div>

      <div className="mt-6 mb-2 flex flex-col items-center gap-2">
        <span title={addBlocked ?? 'Create a new firm'}>
          <Button variant="primary" size="lg" className="rounded-full px-8 shadow-lg" icon={<Plus className="h-5 w-5" />} disabled={!!addBlocked || !L} onClick={() => setEditor({ open: true })}>
            Add Firm
          </Button>
        </span>
        {addBlocked && <div className="max-w-md text-center text-[12.5px] text-muted">{addBlocked}</div>}
      </div>

      <FirmEditor open={editor.open} firmId={editor.id} onClose={() => setEditor({ open: false })} onSaved={reloadAll} />
    </div>
  )
}

/* ============================================ Firm editor ============================================ */

type EditorTab = 'details' | 'branding' | 'documents' | 'print'

function toForm(r: any): FirmForm {
  return {
    name: r.name ?? '',
    tagline: r.tagline ?? '',
    address: r.address ?? '',
    city: r.city ?? '',
    phone: r.phone ?? '',
    phone2: r.phone2 ?? '',
    email: r.email ?? '',
    website: r.website ?? '',
    ntn: r.ntn ?? '',
    strn: r.strn ?? '',
    logo: r.logo || null,
    signature: r.signature || null,
    stamp: r.stamp || null,
    bankDetails: r.bank_details ?? '',
    terms: r.terms ?? '',
    invoiceFooter: r.invoice_footer ?? '',
    isActive: !!r.is_active,
    printSettings: { ...DEFAULT_PS, ...(r.print_settings ?? {}) }
  }
}

function FirmEditor({ open, firmId, onClose, onSaved }: { open: boolean; firmId?: number; onClose: () => void; onSaved: () => Promise<void> | void }): JSX.Element {
  const settings = useApp((s) => s.settings)
  const [id, setId] = useState<number | undefined>(firmId)
  const [tab, setTab] = useState<EditorTab>('details')
  const [f, setF] = useState<FirmForm>(EMPTY_FORM)
  const [meta, setMeta] = useState<{ isDefault: boolean; wasActive: boolean }>({ isDefault: false, wasActive: true })
  const [seqs, setSeqs] = useState<SeqRow[]>([])
  const [origSeqs, setOrigSeqs] = useState<SeqRow[]>([])
  const [orig, setOrig] = useState('')
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)

  const load = async (fid: number): Promise<void> => {
    setLoading(true)
    try {
      const [r, s] = await Promise.all([api<any>('firms.get', { id: fid }), api<SeqRow[]>('firms.sequences', { firmId: fid })])
      const form = toForm(r)
      setF(form)
      setOrig(JSON.stringify(form))
      setMeta({ isDefault: !!r.is_default, wasActive: !!r.is_active })
      setSeqs(s)
      setOrigSeqs(s)
    } catch (e) {
      toast.error(e)
      onClose()
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (!open) return
    setTab('details')
    setId(firmId)
    if (firmId) load(firmId)
    else {
      setF(EMPTY_FORM)
      setOrig(JSON.stringify(EMPTY_FORM))
      setMeta({ isDefault: false, wasActive: true })
      setSeqs([])
      setOrigSeqs([])
    }
  }, [open, firmId]) // eslint-disable-line react-hooks/exhaustive-deps

  const set = <K extends keyof FirmForm>(k: K, v: FirmForm[K]): void => setF((x) => ({ ...x, [k]: v }))
  const setPs = (patch: Partial<PrintSettings>): void => setF((x) => ({ ...x, printSettings: { ...x.printSettings, ...patch } }))

  const dirtySeqs = seqs.filter((s) => {
    const o = origSeqs.find((x) => x.doc_type === s.doc_type)
    return !o || o.prefix !== s.prefix || Number(o.next_no) !== Number(s.next_no) || Number(o.padding) !== Number(s.padding)
  })
  const dirty = JSON.stringify(f) !== orig || dirtySeqs.length > 0

  const requestClose = async (): Promise<void> => {
    if (busy) return
    if (dirty && !(await confirmDialog({ title: 'Discard unsaved changes?', message: 'You have made changes to this firm that are not saved yet.', confirmLabel: 'Discard changes', danger: true }))) return
    onClose()
  }

  const save = async (): Promise<void> => {
    if (!f.name.trim()) {
      setTab('details')
      return toast.error('Firm name is required.')
    }
    if (!HEX_RE.test(f.printSettings.accentColor)) {
      setTab('print')
      return toast.error('Accent colour must be a hex colour like #0b5cad.')
    }
    const badSeq = seqs.find((s) => !PREFIX_RE.test(s.prefix.trim()))
    if (badSeq) {
      setTab('documents')
      return toast.error(`${badSeq.label}: prefix may contain letters, numbers and - / _ . # only.`)
    }
    if (id && meta.wasActive && !f.isActive) {
      const ok = await confirmDialog({
        title: `Deactivate ${f.name}?`,
        message: 'Users will no longer be able to switch to this firm. All of its documents, payments and history are kept and you can activate it again at any time.',
        confirmLabel: 'Deactivate firm',
        danger: true
      })
      if (!ok) return
    }
    setBusy(true)
    try {
      const payload = {
        name: f.name.trim(),
        tagline: f.tagline,
        address: f.address,
        city: f.city,
        phone: f.phone,
        phone2: f.phone2,
        email: f.email,
        website: f.website,
        ntn: f.ntn,
        strn: f.strn,
        logo: f.logo,
        signature: f.signature,
        stamp: f.stamp,
        bankDetails: f.bankDetails,
        terms: f.terms,
        invoiceFooter: f.invoiceFooter,
        printSettings: f.printSettings,
        isActive: f.isActive
      }
      let fid = id
      if (fid) await api('firms.update', { id: fid, ...payload })
      else fid = await api<number>('firms.create', payload)
      for (const s of dirtySeqs) {
        await api('firms.updateSequence', { firmId: fid, docType: s.doc_type, prefix: s.prefix.trim(), nextNo: Math.max(1, Math.floor(Number(s.next_no) || 1)), padding: Math.min(10, Math.max(1, Math.floor(Number(s.padding) || 5))) })
      }
      await onSaved()
      if (!id && fid) {
        // Stay open on the new firm so numbering and branding can be reviewed straight away.
        toast.ok(`${payload.name} created. Review its document numbering below if needed.`)
        setId(fid)
        await load(fid)
        setTab('documents')
      } else {
        toast.ok('Firm saved.')
        onClose()
      }
    } catch (e) {
      toast.error(e)
    } finally {
      setBusy(false)
    }
  }

  const invoiceNo = useMemo(() => {
    const s = seqs.find((x) => x.doc_type === 'sale_invoice')
    return s ? formatNo(s.prefix, s.next_no, s.padding) : 'INV-00001'
  }, [seqs])

  return (
    <Modal
      open={open}
      onClose={requestClose}
      size="xl"
      title={id ? `Edit firm — ${f.name || '…'}` : 'Add firm'}
      subtitle={id ? (meta.isDefault ? 'Default firm' : undefined) : 'A new firm gets its own document numbering, cash account and (if inventory is not shared) its own store.'}
      footer={
        <>
          {dirty && <span className="mr-auto text-[12.5px] text-warn">Unsaved changes</span>}
          <Button onClick={requestClose} disabled={busy}>
            {id && !dirty ? 'Close' : 'Cancel'}
          </Button>
          <Button variant="primary" icon={<Save className="h-4 w-4" />} loading={busy} disabled={loading || (!!id && !dirty)} onClick={save}>
            {id ? 'Save changes' : 'Create firm'}
          </Button>
        </>
      }
    >
      {loading ? (
        <Loading />
      ) : (
        <>
          <Tabs
            value={tab}
            onChange={setTab}
            tabs={[
              { key: 'details', label: 'Business details' },
              { key: 'branding', label: 'Branding' },
              { key: 'documents', label: 'Invoice & documents' },
              { key: 'print', label: 'Print settings' }
            ]}
          />

          {tab === 'details' && (
            <div className="grid grid-cols-2 gap-4">
              <Field label="Firm name" required className="col-span-2">
                <Input autoFocus value={f.name} onChange={(e) => set('name', e.target.value)} placeholder="e.g. Sunrise Solar Energy" />
              </Field>
              <Field label="Tagline / services" className="col-span-2" hint="Printed under the firm name, e.g. “Solar panels · Inverters · Batteries · Installation”.">
                <Textarea rows={2} value={f.tagline} onChange={(e) => set('tagline', e.target.value)} />
              </Field>
              <Field label="Address" className="col-span-2">
                <Textarea rows={2} value={f.address} onChange={(e) => set('address', e.target.value)} />
              </Field>
              <Field label="City">
                <Input value={f.city} onChange={(e) => set('city', e.target.value)} />
              </Field>
              <Field label="Email">
                <Input type="email" value={f.email} onChange={(e) => set('email', e.target.value)} />
              </Field>
              <Field label="Phone">
                <Input value={f.phone} onChange={(e) => set('phone', e.target.value)} />
              </Field>
              <Field label="Phone 2">
                <Input value={f.phone2} onChange={(e) => set('phone2', e.target.value)} />
              </Field>
              <Field label="Website">
                <Input value={f.website} onChange={(e) => set('website', e.target.value)} placeholder="www.example.com" />
              </Field>
              <div />
              <Field label="NTN">
                <Input value={f.ntn} onChange={(e) => set('ntn', e.target.value)} />
              </Field>
              <Field label="STRN">
                <Input value={f.strn} onChange={(e) => set('strn', e.target.value)} />
              </Field>
              {id && (
                <div className="col-span-2 rounded-xl border border-line px-4 py-3">
                  <Toggle
                    checked={f.isActive}
                    disabled={meta.isDefault}
                    onChange={(v) => set('isActive', v)}
                    label="Active"
                    description={meta.isDefault ? 'The default firm cannot be deactivated. Make another firm the default first.' : f.isActive ? 'Users with access can switch to this firm.' : 'Hidden from the firm selector. All data is kept.'}
                  />
                </div>
              )}
            </div>
          )}

          {tab === 'branding' && <BrandingTab f={f} set={set} />}

          {tab === 'documents' && (
            <div className="space-y-5">
              <div className="grid grid-cols-2 gap-4">
                <Field label="Bank details" hint="Printed on sales invoices when “Bank details” is enabled in Print settings.">
                  <Textarea rows={5} value={f.bankDetails} onChange={(e) => set('bankDetails', e.target.value)} placeholder={'Bank: Meezan Bank\nTitle: Sunrise Solar Energy\nA/C: 0123-4567890\nIBAN: PK00MEZN0000000000000000'} />
                </Field>
                <Field label="Default terms & conditions" hint="Used on invoices and quotations that do not have their own terms.">
                  <Textarea rows={5} value={f.terms} onChange={(e) => set('terms', e.target.value)} placeholder={String(settings.default_invoice_terms ?? '')} />
                </Field>
                <Field label="Invoice footer text" className="col-span-2" hint="A short line at the bottom of every printed page, e.g. “Thank you for choosing solar energy!”">
                  <Input value={f.invoiceFooter} onChange={(e) => set('invoiceFooter', e.target.value)} />
                </Field>
              </div>

              <div>
                <div className="mb-2 flex items-center gap-2 font-semibold">
                  <Hash className="h-4 w-4 text-brand" /> Document numbering
                </div>
                {!id ? (
                  <div className="rounded-xl border border-dashed border-line px-4 py-6 text-center text-[13px] text-muted">Document numbering is set up when the firm is created. It starts at 1 with the standard prefixes (INV-, QT-, PI-, …) and you can change it right after creating the firm.</div>
                ) : (
                  <div className="overflow-hidden rounded-xl border border-line">
                    <table className="tbl">
                      <thead>
                        <tr>
                          <th>Document type</th>
                          <th style={{ width: 150 }}>Prefix</th>
                          <th style={{ width: 130 }} className="text-right">
                            Next number
                          </th>
                          <th style={{ width: 110 }} className="text-right">
                            Digits
                          </th>
                          <th style={{ width: 170 }}>Next document</th>
                        </tr>
                      </thead>
                      <tbody>
                        {seqs.map((s, i) => {
                          const bad = !PREFIX_RE.test(s.prefix.trim())
                          const changed = dirtySeqs.includes(s)
                          const upd = (patch: Partial<SeqRow>): void => setSeqs((rows) => rows.map((r, j) => (j === i ? { ...r, ...patch } : r)))
                          return (
                            <tr key={s.doc_type}>
                              <td className="font-medium">
                                {s.label}
                                {changed && <span className="ml-2 text-[11px] font-semibold text-warn">edited</span>}
                              </td>
                              <td>
                                <Input sm className={cx('font-mono', bad && '!border-bad')} value={s.prefix} maxLength={20} onChange={(e) => upd({ prefix: e.target.value })} title={bad ? 'Letters, numbers and - / _ . # only' : undefined} />
                              </td>
                              <td>
                                <NumberInput sm value={s.next_no} min={1} onChange={(v) => upd({ next_no: v })} />
                              </td>
                              <td>
                                <Select sm value={s.padding} onChange={(e) => upd({ padding: Number(e.target.value) })}>
                                  {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => (
                                    <option key={n} value={n}>
                                      {n}
                                    </option>
                                  ))}
                                </Select>
                              </td>
                              <td>
                                <span className="rounded-md bg-surface-2 px-2 py-1 font-mono text-[12.5px] font-semibold">{formatNo(s.prefix.trim(), s.next_no, s.padding)}</span>
                              </td>
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
                {id && <div className="mt-2 text-[12px] text-muted">If a number already exists (for example after lowering the next number), the next free number is used automatically — numbers are never duplicated.</div>}
              </div>
            </div>
          )}

          {tab === 'print' && (
            <div className="grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
              <div className="space-y-5">
                <div>
                  <div className="mb-2 flex items-center gap-2 font-semibold">
                    <Palette className="h-4 w-4 text-brand" /> Accent colour
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    {SWATCHES.map((s) => {
                      const sel = f.printSettings.accentColor.toLowerCase() === s.color
                      return (
                        <button
                          key={s.color}
                          type="button"
                          title={s.name}
                          onClick={() => setPs({ accentColor: s.color })}
                          className={cx('flex h-9 w-9 cursor-pointer items-center justify-center rounded-full ring-offset-2 ring-offset-[var(--surface)] transition', sel ? 'ring-2 ring-[var(--text)]' : 'hover:scale-110')}
                          style={{ background: s.color }}
                        >
                          {sel && <Check className="h-4 w-4 text-white" />}
                        </button>
                      )
                    })}
                    <label className="ml-2 flex cursor-pointer items-center gap-2 rounded-lg border border-line px-2 py-1" title="Custom colour">
                      <input type="color" className="h-7 w-8 cursor-pointer border-0 bg-transparent p-0" value={HEX_RE.test(f.printSettings.accentColor) ? f.printSettings.accentColor : '#0b5cad'} onChange={(e) => setPs({ accentColor: e.target.value })} />
                      <span className="text-[12.5px] text-muted">Custom</span>
                    </label>
                    <Input sm className={cx('w-28 font-mono', !HEX_RE.test(f.printSettings.accentColor) && '!border-bad')} value={f.printSettings.accentColor} maxLength={7} onChange={(e) => setPs({ accentColor: e.target.value.trim() })} />
                  </div>
                </div>

                <div className="rounded-xl border border-line">
                  <div className="border-b border-line bg-surface-2 px-4 py-2 text-[12.5px] font-semibold text-muted uppercase">Show on printed documents</div>
                  <div className="space-y-3 px-4 py-3">
                    <PsToggle k="showLogo" f={f} setPs={setPs} label="Firm logo" />
                    <PsToggle k="showSignature" f={f} setPs={setPs} label="Authorized signature image" />
                    <PsToggle k="showStamp" f={f} setPs={setPs} label="Company stamp" />
                    <PsToggle k="showWarranty" f={f} setPs={setPs} label="Warranty period on items" />
                    <PsToggle k="showSerials" f={f} setPs={setPs} label="Serial numbers on items" />
                    <PsToggle k="showAmountInWords" f={f} setPs={setPs} label="Amount in words" />
                    <PsToggle k="showBankDetails" f={f} setPs={setPs} label="Bank details (sales invoices)" />
                    <PsToggle k="showPreviousBalance" f={f} setPs={setPs} label="Customer previous balance" />
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <Field label="Tax columns" className="col-span-2">
                    <Select value={f.printSettings.showTaxColumns} onChange={(e) => setPs({ showTaxColumns: e.target.value as PrintSettings['showTaxColumns'] })}>
                      <option value="auto">Automatic — only when the document has tax</option>
                      <option value="always">Always show tax columns</option>
                      <option value="never">Never show tax columns</option>
                    </Select>
                  </Field>
                  <Field label="Signature label">
                    <Input value={f.printSettings.signatureLabel} onChange={(e) => setPs({ signatureLabel: e.target.value })} />
                  </Field>
                  <Field label="Receiver label">
                    <Input value={f.printSettings.receiverLabel} onChange={(e) => setPs({ receiverLabel: e.target.value })} />
                  </Field>
                </div>
              </div>

              <div>
                <div className="mb-2 flex items-center gap-2 font-semibold">
                  <Printer className="h-4 w-4 text-brand" /> Live preview
                </div>
                <div className="lg:sticky lg:top-0">
                  <InvoicePreview f={f} invoiceNo={invoiceNo} />
                  <div className="mt-2 text-[11.5px] text-muted">A simplified preview of the invoice layout. Open any invoice and use Print / PDF to see the full A4 document.</div>
                </div>
              </div>
            </div>
          )}
        </>
      )}
    </Modal>
  )
}

function PsToggle({ k, f, setPs, label }: { k: keyof PrintSettings; f: FirmForm; setPs: (p: Partial<PrintSettings>) => void; label: string }): JSX.Element {
  return <Toggle checked={!!f.printSettings[k]} onChange={(v) => setPs({ [k]: v } as Partial<PrintSettings>)} label={<span className="text-[13.5px] font-normal">{label}</span>} />
}

/* ------------------------------------------- Branding ------------------------------------------- */

function BrandingTab({ f, set }: { f: FirmForm; set: <K extends keyof FirmForm>(k: K, v: FirmForm[K]) => void }): JSX.Element {
  const [bg, setBg] = useState<'checker' | 'white'>('checker')
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="text-[13px] text-muted">
          Images are resized automatically to keep the database small. Use a <b>transparent PNG</b> for the signature and stamp so they sit naturally on the paper.
        </div>
        <div className="flex items-center gap-1 rounded-lg border border-line p-0.5 text-[12.5px]">
          {(['checker', 'white'] as const).map((b) => (
            <button key={b} type="button" onClick={() => setBg(b)} className={cx('cursor-pointer rounded-md px-2.5 py-1 font-medium', bg === b ? 'bg-brand text-on-brand' : 'text-muted hover:bg-surface-2')}>
              {b === 'checker' ? 'Checkerboard' : 'White'}
            </button>
          ))}
        </div>
      </div>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <ImageSlot title="Logo" icon={<Building2 className="h-7 w-7" />} value={f.logo} onChange={(v) => set('logo', v)} maxSize={600} bg={bg} hint="PNG, JPG or WEBP. Shown on the top-left of every document and in the top bar." />
        <ImageSlot title="Authorized signature" icon={<Signature className="h-7 w-7" />} value={f.signature} onChange={(v) => set('signature', v)} maxSize={600} bg={bg} hint="Transparent PNG recommended. Printed above the signature label." />
        <ImageSlot title="Company stamp" icon={<Stamp className="h-7 w-7" />} value={f.stamp} onChange={(v) => set('stamp', v)} maxSize={500} bg={bg} hint="Transparent PNG recommended. Printed next to the signature." />
      </div>
    </div>
  )
}

function ImageSlot({ title, icon, value, onChange, maxSize, bg, hint }: { title: string; icon: ReactNode; value: string | null; onChange: (v: string | null) => void; maxSize: number; bg: 'checker' | 'white'; hint: string }): JSX.Element {
  const ref = useRef<HTMLInputElement>(null)
  const [over, setOver] = useState(false)
  const pick = async (file?: File | null): Promise<void> => {
    if (!file) return
    try {
      onChange(await readImageFile(file, maxSize))
    } catch (e) {
      toast.error(e)
    }
  }
  return (
    <div className="rounded-xl border border-line p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="font-semibold">{title}</div>
        {value ? <Badge tone="ok">Uploaded</Badge> : <Badge tone="muted">None</Badge>}
      </div>
      <div
        className={cx('flex h-40 cursor-pointer items-center justify-center overflow-hidden rounded-lg border-2 border-dashed transition', over ? 'border-brand' : 'border-line')}
        style={bg === 'checker' ? CHECKER : { backgroundColor: '#ffffff' }}
        onClick={() => ref.current?.click()}
        onDragOver={(e) => {
          e.preventDefault()
          setOver(true)
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault()
          setOver(false)
          pick(e.dataTransfer.files?.[0])
        }}
        title="Click or drop an image here"
      >
        {value ? (
          <img src={value} alt={title} className="max-h-full max-w-full object-contain p-2" />
        ) : (
          <div className="flex flex-col items-center gap-1 text-center text-slate-400">
            {icon}
            <span className="text-[12px]">Click or drop an image</span>
          </div>
        )}
      </div>
      <div className="mt-2 min-h-[32px] text-[11.5px] text-muted">{hint}</div>
      <div className="mt-2 flex gap-2">
        <Button size="sm" variant={value ? 'secondary' : 'soft'} icon={<Upload className="h-4 w-4" />} onClick={() => ref.current?.click()}>
          {value ? 'Replace' : 'Upload'}
        </Button>
        {value && (
          <Button size="sm" variant="ghost" className="text-bad" icon={<Trash2 className="h-4 w-4" />} onClick={() => onChange(null)}>
            Remove
          </Button>
        )}
      </div>
      <input
        ref={ref}
        type="file"
        hidden
        accept="image/png,image/jpeg,image/webp,image/svg+xml"
        onChange={(e) => {
          pick(e.target.files?.[0])
          e.target.value = ''
        }}
      />
    </div>
  )
}

/* ------------------------------------------- Mini preview ------------------------------------------- */

function InvoicePreview({ f, invoiceNo }: { f: FirmForm; invoiceNo: string }): JSX.Element {
  const ps = f.printSettings
  const c = HEX_RE.test(ps.accentColor) ? ps.accentColor : '#0b5cad'
  const contact = [f.phone, f.phone2].filter(Boolean).join(' / ')
  const showTax = ps.showTaxColumns === 'always'
  const lines = [
    { d: '585W Mono PERC Solar Panel', q: 10, a: 350000, s: 'S/N: JA585-001 … JA585-010', w: '12 years' },
    { d: '6kW Hybrid Inverter', q: 1, a: 185000, s: 'S/N: INV6K-20931', w: '5 years' }
  ]
  const total = lines.reduce((t, l) => t + l.a, 0)
  return (
    <div className="overflow-hidden rounded-xl border border-line bg-white p-4 text-[#1a2233] shadow-sm" style={{ fontSize: 9 }}>
      <div className="mb-2 h-[4px] rounded-full" style={{ background: `linear-gradient(90deg, ${c}, color-mix(in srgb, ${c} 35%, #f7931e))` }} />
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-2.5">
          {ps.showLogo && f.logo && <img src={f.logo} alt="" className="max-h-[46px] max-w-[84px] shrink-0 object-contain" />}
          <div className="min-w-0">
            <div className="truncate text-[15px] leading-tight font-extrabold tracking-tight" style={{ color: c }}>
              {f.name || 'Your Firm Name'}
            </div>
            {f.tagline && <div className="mt-0.5 line-clamp-2 text-[8px] leading-snug text-[#4a5568]">{f.tagline}</div>}
            <div className="mt-0.5 text-[8px] leading-snug text-[#2d3748]">
              {[f.address, f.city].filter(Boolean).join(', ') || 'Address, City'}
              {(contact || f.email) && <div>{[contact && `Phone: ${contact}`, f.email && `Email: ${f.email}`].filter(Boolean).join(' | ')}</div>}
              {(f.ntn || f.strn) && <div>{[f.ntn && `NTN: ${f.ntn}`, f.strn && `STRN: ${f.strn}`].filter(Boolean).join(' | ')}</div>}
            </div>
          </div>
        </div>
        <div className="shrink-0 text-right">
          <div className="text-[13px] font-black tracking-[0.08em] uppercase" style={{ color: c }}>
            Invoice
          </div>
          <div className="text-[8.5px]">
            <span className="text-[#4a5568]">No.</span> <b>{invoiceNo}</b>
          </div>
          <div className="text-[8.5px]">
            <span className="text-[#4a5568]">Date</span> <b>{new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })}</b>
          </div>
        </div>
      </div>
      <div className="my-2 border-b-2" style={{ borderColor: c }} />

      <div className="mb-2 w-1/2 rounded border border-[#e2e8f0]">
        <div className="rounded-t px-2 py-0.5 text-[7.5px] font-bold tracking-wider text-white uppercase" style={{ background: c }}>
          Bill to
        </div>
        <div className="px-2 py-1 text-[8.5px]">
          <b>Customer name</b>
          <div className="text-[#4a5568]">Customer address</div>
        </div>
      </div>

      <table className="w-full border-collapse text-[8.5px]">
        <thead>
          <tr className="text-white" style={{ background: c }}>
            <th className="px-1.5 py-1 text-left font-semibold">Description</th>
            <th className="px-1.5 py-1 text-right font-semibold">Qty</th>
            {showTax && <th className="px-1.5 py-1 text-right font-semibold">Tax</th>}
            <th className="px-1.5 py-1 text-right font-semibold">Amount</th>
          </tr>
        </thead>
        <tbody>
          {lines.map((l) => (
            <tr key={l.d} className="border-b border-[#e2e8f0] align-top">
              <td className="px-1.5 py-1">
                <div className="font-semibold">{l.d}</div>
                {ps.showSerials && <div className="text-[7.5px] text-[#4a5568]">{l.s}</div>}
                {ps.showWarranty && <div className="text-[7.5px] text-[#4a5568]">Warranty: {l.w}</div>}
              </td>
              <td className="px-1.5 py-1 text-right">{l.q}</td>
              {showTax && <td className="px-1.5 py-1 text-right">—</td>}
              <td className="px-1.5 py-1 text-right">{money(l.a, { symbol: false })}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="mt-2 flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1 space-y-1.5">
          {ps.showAmountInWords && (
            <div className="text-[8px]">
              <b>Amount in words:</b> <span className="text-[#4a5568]">Five Lakh Thirty-Five Thousand Only</span>
            </div>
          )}
          {ps.showBankDetails && f.bankDetails && (
            <div className="rounded border border-[#e2e8f0] px-2 py-1 text-[7.5px] whitespace-pre-line">
              <div className="font-bold" style={{ color: c }}>
                Bank details
              </div>
              {f.bankDetails.split('\n').slice(0, 4).join('\n')}
            </div>
          )}
        </div>
        <div className="w-[46%] shrink-0 text-[8.5px]">
          <div className="flex justify-between py-0.5">
            <span>Total</span>
            <b>{money(total, { symbol: false })}</b>
          </div>
          {ps.showPreviousBalance && (
            <div className="flex justify-between py-0.5 text-[#4a5568]">
              <span>Previous balance</span>
              <span>{money(25000, { symbol: false })}</span>
            </div>
          )}
          <div className="mt-0.5 flex justify-between rounded px-1.5 py-1 font-bold text-white" style={{ background: c }}>
            <span>{ps.showPreviousBalance ? 'Total due' : 'Grand total'}</span>
            <span>{money(total + (ps.showPreviousBalance ? 25000 : 0))}</span>
          </div>
        </div>
      </div>

      <div className="mt-4 flex items-end justify-between gap-4 text-[8px]">
        <div className="w-1/3 border-t border-[#4a5568] pt-0.5 text-center text-[#4a5568]">{ps.receiverLabel || "Customer's Signature"}</div>
        <div className="flex items-end gap-2">
          {ps.showStamp && f.stamp && <img src={f.stamp} alt="" className="max-h-[42px] max-w-[60px] object-contain opacity-90" />}
          <div className="w-[110px] text-center">
            <div className="flex h-[30px] items-end justify-center">{ps.showSignature && f.signature ? <img src={f.signature} alt="" className="max-h-[30px] max-w-[100px] object-contain" /> : null}</div>
            <div className="border-t border-[#4a5568] pt-0.5 text-[#4a5568]">{ps.signatureLabel || 'Authorized Signature'}</div>
          </div>
        </div>
      </div>
      {f.invoiceFooter && <div className="mt-3 border-t border-[#e2e8f0] pt-1 text-center text-[7.5px] text-[#4a5568]">{f.invoiceFooter}</div>}
      {(ps.showLogo && !f.logo) || (ps.showSignature && !f.signature) || (ps.showStamp && !f.stamp) ? (
        <div className="mt-2 flex items-center gap-1 text-[8px] text-[#94a3b8]">
          <ImageOff className="h-3 w-3" /> Upload images in the Branding tab to see them here.
        </div>
      ) : null}
      <div className="sr-only">
        <FileText />
      </div>
    </div>
  )
}
