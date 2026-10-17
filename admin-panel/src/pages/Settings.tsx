/** Settings - Digital Target branding, invoices, bank & payment, support contacts, portal options and the signing key. */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useSearchParams } from 'react-router-dom'
import {
  Building2,
  Check,
  Clock,
  CreditCard,
  Download,
  ExternalLink,
  FileText,
  ImageOff,
  ImagePlus,
  KeyRound,
  LifeBuoy,
  Loader2,
  Lock,
  MonitorCog,
  RotateCcw,
  Save,
  ShieldCheck
} from 'lucide-react'
import { Field, PageTitle, cx } from '../components/ui'
import { FieldError, Loading, Notice, Tabs } from '../components/kit'
import { useCan } from '../lib/auth'
import { saveSettings, useSettingsDocs } from '../lib/brandingStore'
import {
  MAX_IMAGE_BYTES,
  MAX_SESSION_TIMEOUT_MIN,
  MIN_SESSION_TIMEOUT_MIN,
  PUBLIC_BRANDING_FIELDS,
  changedBrandingFields,
  cleanBranding,
  dataUrlStoredBytes,
  formatBytes,
  maskName,
  validateBranding,
  type ImageField
} from '../lib/branding'
import { compressImageFile, type CompressOptions } from '../lib/imageFile'
import { errorMessage, fmtDateTime } from '../lib/format'
import { SAVE_DEADLINE_MS, withDeadline } from '../lib/deadline'
import { DEFAULT_BRANDING, type Branding } from '../lib/types'
import { SigningKeyPanel } from './SigningKey'
import { VersionPanel } from './VersionPanel'

type TabId = 'branding' | 'invoices' | 'bank' | 'support' | 'portal' | 'version' | 'key'

const TABS: { id: TabId; label: string; icon: ReactNode }[] = [
  { id: 'branding', label: 'Branding', icon: <Building2 /> },
  { id: 'invoices', label: 'Invoices', icon: <FileText /> },
  { id: 'bank', label: 'Bank & payment', icon: <CreditCard /> },
  { id: 'support', label: 'Support', icon: <LifeBuoy /> },
  { id: 'portal', label: 'Portal', icon: <MonitorCog /> },
  { id: 'version', label: 'Software version', icon: <Download /> },
  { id: 'key', label: 'Signing key', icon: <KeyRound /> }
]

/** Which tab shows each validated field (used to point at the tab holding an error). */
const FIELD_TAB: Record<string, TabId> = {
  companyName: 'branding',
  website: 'branding',
  email: 'branding',
  phone: 'branding',
  address: 'branding',
  logo: 'branding',
  currency: 'invoices',
  invoicePrefix: 'invoices',
  receiptPrefix: 'invoices',
  taxName: 'invoices',
  taxRate: 'invoices',
  invoiceFooter: 'invoices',
  terms: 'invoices',
  signature: 'invoices',
  verifyBaseUrl: 'invoices',
  bankName: 'bank',
  bankTitle: 'bank',
  bankAccount: 'bank',
  iban: 'bank',
  paymentQr: 'bank',
  supportPhone: 'support',
  supportWhatsapp: 'support',
  supportEmail: 'support',
  sessionTimeoutMin: 'portal',
  mapTileUrl: 'portal',
  mapAttribution: 'portal'
}

const IMAGE_OPTS: Record<ImageField, CompressOptions & { title: string; hint: string; box: string }> = {
  logo: { maxWidth: 512, maxHeight: 512, title: 'Logo', hint: 'Square or wide PNG with a transparent background works best.', box: 'h-24 w-40' },
  signature: { maxWidth: 600, maxHeight: 220, title: 'Invoice signature', hint: 'Scan of the authorised signature (printed on invoices and receipts).', box: 'h-20 w-56' },
  paymentQr: { maxWidth: 600, maxHeight: 600, title: 'Payment QR code', hint: 'Bank / wallet QR printed on invoices. Keep it sharp: upload the original image.', box: 'h-36 w-36' }
}

type TextKey = {
  [K in keyof Branding]: Branding[K] extends string ? K : never
}[keyof Branding]

export function Settings() {
  const can = useCan()
  const canEdit = can('branding.manage')
  const st = useSettingsDocs()
  const [params, setParams] = useSearchParams()
  const tabParam = params.get('tab') as TabId | null
  const tab: TabId = TABS.some((t) => t.id === tabParam) ? (tabParam as TabId) : 'branding'
  const setTab = (t: TabId) => setParams(t === 'branding' ? {} : { tab: t }, { replace: true })

  // `base` = the stored values the form was last synced from. Unsaved edits are measured against it (not against the
  // live documents), so loading the stored settings never counts as an edit and always fills the form.
  const [base, setBase] = useState<{ b: Branding; t: number }>(() => ({ b: st.branding, t: st.sessionTimeoutMin }))
  const [draft, setDraft] = useState<Branding>(() => st.branding)
  const [timeout, setTimeoutMin] = useState(st.sessionTimeoutMin)
  const [tried, setTried] = useState(false)
  const [busy, setBusy] = useState(false)
  const [savedTick, setSavedTick] = useState(false)
  const [flash, setFlash] = useState<{ tone: 'success' | 'error' | 'warn'; text: string } | null>(null)

  const clean = useMemo(() => cleanBranding(draft), [draft])
  const baseClean = useMemo(() => cleanBranding(base.b), [base.b])
  const changed = useMemo(() => changedBrandingFields(baseClean, clean), [baseClean, clean])
  const dirty = changed.length > 0 || timeout !== base.t
  const dirtyRef = useRef(false)
  dirtyRef.current = dirty

  // Follow the stored settings while the form has no unsaved edits (initial load, saves from another tab / admin).
  useEffect(() => {
    if (dirtyRef.current) return
    setBase({ b: st.branding, t: st.sessionTimeoutMin })
    setDraft(st.branding)
    setTimeoutMin(st.sessionTimeoutMin)
  }, [st.loading, st.branding, st.sessionTimeoutMin])

  useEffect(() => {
    if (!savedTick) return
    const t = setTimeout(() => setSavedTick(false), 2500)
    return () => clearTimeout(t)
  }, [savedTick])

  // Warn before leaving the page with unsaved edits.
  useEffect(() => {
    if (!dirty) return
    const h = (e: BeforeUnloadEvent) => {
      e.preventDefault()
    }
    window.addEventListener('beforeunload', h)
    return () => window.removeEventListener('beforeunload', h)
  }, [dirty])

  const errors = useMemo(() => validateBranding(draft, timeout), [draft, timeout])
  const shown: Record<string, string> = tried ? errors : {}
  const errorTabs = Array.from(new Set(Object.keys(errors).map((k) => FIELD_TAB[k]).filter(Boolean)))
  const set = <K extends keyof Branding>(k: K, v: Branding[K]) => setDraft((d) => ({ ...d, [k]: v }))

  const save = async () => {
    setTried(true)
    setFlash(null)
    if (Object.keys(errors).length) {
      const first = errorTabs[0]
      if (first && first !== tab) setTab(first)
      setFlash({ tone: 'error', text: `Fix the highlighted fields first (${errorTabs.map((t) => TABS.find((x) => x.id === t)?.label).join(', ')}).` })
      return
    }
    setBusy(true)
    setSavedTick(false)
    const savedText = (fields: string[]) =>
      fields.length ? `Settings saved (${fields.length} change${fields.length === 1 ? '' : 's'}). The public copy for the invoice verification page was updated too.` : 'Settings saved.'
    try {
      const r = await withDeadline(saveSettings(st.branding, draft, st.sessionTimeoutMin, timeout, { full: !st.saved }), SAVE_DEADLINE_MS)
      setBase({ b: clean, t: timeout })
      setDraft(clean)
      setTried(false)
      if (r.done) {
        setSavedTick(true)
        setFlash({ tone: 'success', text: savedText(r.value) })
      } else {
        setFlash({ tone: 'warn', text: 'Saving is taking longer than usual (slow or no connection). The changes are kept in this tab and upload automatically when the connection is back - keep the tab open.' })
        r.pending.then(
          (fields) => { setSavedTick(true); setFlash({ tone: 'success', text: savedText(fields) }) },
          (e) => setFlash({ tone: 'error', text: `Settings could not be saved: ${errorMessage(e)}` })
        )
      }
    } catch (e) {
      setFlash({ tone: 'error', text: errorMessage(e) })
    } finally {
      setBusy(false)
    }
  }

  const discard = () => {
    setBase({ b: st.branding, t: st.sessionTimeoutMin })
    setDraft(st.branding)
    setTimeoutMin(st.sessionTimeoutMin)
    setTried(false)
    setFlash(null)
  }

  const text = (k: TextKey, label: string, opts: { hint?: ReactNode; placeholder?: string; className?: string; mono?: boolean; area?: number; max?: number; type?: string } = {}) => (
    <Field label={label} hint={opts.hint} className={opts.className}>
      {opts.area ? (
        <textarea
          className={cx('input', shown[k] && 'border-red-400')}
          rows={opts.area}
          value={draft[k] as string}
          placeholder={opts.placeholder}
          maxLength={opts.max}
          onChange={(e) => set(k, e.target.value as Branding[typeof k])}
        />
      ) : (
        <input
          className={cx('input', opts.mono && 'font-mono', shown[k] && 'border-red-400')}
          type={opts.type ?? 'text'}
          value={draft[k] as string}
          placeholder={opts.placeholder}
          maxLength={opts.max ?? 300}
          onChange={(e) => set(k, e.target.value as Branding[typeof k])}
        />
      )}
      <FieldError msg={shown[k]} />
    </Field>
  )

  const image = (k: ImageField) => <ImageInput field={k} value={draft[k]} disabled={!canEdit} error={shown[k]} onChange={(v) => set(k, v)} />

  const origin = typeof window !== 'undefined' ? window.location.origin : ''
  const verifyBase = clean.verifyBaseUrl || origin

  return (
    <div className="max-w-6xl pb-20">
      <PageTitle
        icon={<MonitorCog />}
        title="Settings"
        sub={
          st.loading
            ? st.cached ? 'Refreshing…' : 'Loading…'
            : st.updatedAt
              ? `Digital Target branding, invoices, payments, support and portal options, last saved ${fmtDateTime(st.updatedAt)}${st.updatedBy ? ` by ${st.updatedBy}` : ''}`
              : 'Digital Target branding, invoices, payments, support and portal options'
        }
        actions={
          canEdit && tab !== 'key' ? (
            <>
              <button className="btn btn-secondary" onClick={discard} disabled={!dirty || busy}><RotateCcw className="h-4 w-4" />Discard</button>
              <button className="btn btn-primary" onClick={save} disabled={!dirty || busy || st.loading} aria-live="polite">
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : savedTick && !dirty ? <Check className="h-4 w-4" /> : <Save className="h-4 w-4" />}
                {busy ? 'Saving…' : savedTick && !dirty ? 'Saved' : 'Save changes'}
              </button>
            </>
          ) : null
        }
      />

      {flash && <Notice tone={flash.tone} className="mb-4" onClose={() => setFlash(null)}>{flash.text}</Notice>}
      {st.error && <Notice tone="error" className="mb-4">Settings could not be loaded: {st.error}</Notice>}
      {!canEdit && tab !== 'key' && tab !== 'version' && (
        <Notice tone="info" className="mb-4">
          <span className="inline-flex items-center gap-1.5"><Lock className="h-3.5 w-3.5" />Read only - changing these settings needs the “Branding, invoice & portal settings” permission.</span>
        </Notice>
      )}
      {!st.loading && !st.saved && canEdit && tab !== 'key' && (
        <Notice tone="warn" className="mb-4">These settings have never been saved - the defaults below are in use. Review them and press “Save changes”.</Notice>
      )}

      <Tabs tabs={TABS.map((t) => ({ ...t, label: tried && errorTabs.includes(t.id) ? `${t.label} •` : t.label }))} active={tab} onChange={setTab} />

      {tab === 'key' ? (
        <SigningKeyPanel />
      ) : tab === 'version' ? (
        <VersionPanel />
      ) : st.loading && !st.cached ? (
        <div className="card"><Loading label="Loading settings…" /></div>
      ) : (
        <fieldset disabled={!canEdit || busy || st.loading} className="min-w-0" aria-busy={st.loading}>
          {tab === 'branding' && (
            <div className="grid gap-4 xl:grid-cols-[1fr_360px]">
              <Section title="Company" sub="Digital Target’s details on invoices, receipts and the public invoice verification page.">
                <div className="grid grid-cols-2 gap-3">
                  {text('companyName', 'Company name', { max: 120 })}
                  {text('website', 'Website', { placeholder: 'digitaltarget.pk' })}
                  {text('phone', 'Phone', { max: 60 })}
                  {text('email', 'E-mail', { type: 'email', max: 120 })}
                  {text('address', 'Address', { area: 2, className: 'col-span-2', max: 300 })}
                </div>
                <div className="mt-4">{image('logo')}</div>
              </Section>
              <div className="space-y-4">
                <Section title="Preview" sub="Invoice / receipt header">
                  <div className="rounded-xl border border-[#ece6f4] bg-white p-4">
                    <div className="flex items-start gap-3">
                      {clean.logo ? <img src={clean.logo} alt="Logo" className="h-12 max-w-[96px] object-contain" /> : <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-[#f1e9fb] text-[12px] text-[#7a6d92]">Logo</div>}
                      <div className="min-w-0 text-[12px] leading-snug">
                        <div className="truncate text-[15px] font-extrabold text-[#3d096d]">{clean.companyName || '-'}</div>
                        {clean.address && <div className="text-[#5b4b78]">{clean.address}</div>}
                        <div className="text-[#5b4b78]">{[clean.phone, clean.email, clean.website].filter(Boolean).join(', ')}</div>
                      </div>
                    </div>
                  </div>
                  <p className="mt-2 text-[12px] text-[#7a6d92]">
                    Public copy (anyone with an invoice QR link can read it): {PUBLIC_BRANDING_FIELDS.join(', ')}. Bank details, terms and all other settings stay private to admins.
                  </p>
                </Section>
                <Section title="“Powered by Digital Target”" sub="Footer line printed by the desktop app">
                  <Toggle
                    checked={draft.poweredByDefault}
                    onChange={(v) => set('poweredByDefault', v)}
                    label="Show “Powered by Digital Target” on new licenses"
                    hint="New licenses start with this choice. Each license can still be switched on or off on the Licenses page; existing licenses are not changed."
                  />
                </Section>
              </div>
            </div>
          )}

          {tab === 'invoices' && (
            <div className="grid gap-4 xl:grid-cols-2">
              <Section title="Numbering & tax" sub="Used for Digital Target’s license invoices and receipts.">
                <div className="grid grid-cols-2 gap-3">
                  {text('currency', 'Currency', { mono: true, max: 3, hint: '3-letter code, e.g. PKR' })}
                  <div />
                  {text('invoicePrefix', 'Invoice number prefix', { mono: true, max: 12, hint: <>Next invoice: <span className="font-mono">{clean.invoicePrefix || '…'}0001</span></> })}
                  {text('receiptPrefix', 'Receipt number prefix', { mono: true, max: 12, hint: <>Next receipt: <span className="font-mono">{clean.receiptPrefix || '…'}0001</span></> })}
                  {text('taxName', 'Tax name', { max: 40, placeholder: 'GST' })}
                  <Field label="Tax rate (%)" hint="0 = no tax line on invoices.">
                    <input
                      className={cx('input', shown.taxRate && 'border-red-400')}
                      type="number"
                      min={0}
                      max={100}
                      step="0.01"
                      value={Number.isFinite(draft.taxRate) ? draft.taxRate : ''}
                      onChange={(e) => set('taxRate', e.target.value === '' ? Number.NaN : Number(e.target.value))}
                    />
                    <FieldError msg={shown.taxRate} />
                  </Field>
                </div>
              </Section>
              <Section title="Footer, terms & signature">
                <div className="space-y-3">
                  {text('invoiceFooter', 'Invoice footer', { area: 2, max: 500, hint: `${draft.invoiceFooter.length}/500` })}
                  {text('terms', 'Terms & conditions', { area: 4, max: 3000, hint: `${draft.terms.length}/3000` })}
                  {text('signatoryName', 'Signatory name', { max: 80 })}
                  {image('signature')}
                </div>
              </Section>
              <Section title="Public invoice verification (QR)" sub="Every invoice carries a QR code that opens a public verification page." className="xl:col-span-2">
                <div className="grid gap-4 xl:grid-cols-2">
                  <div className="space-y-3">
                    {text('verifyBaseUrl', 'Verification base URL', {
                      placeholder: origin,
                      hint: <>Leave empty to use this portal’s address ({origin}). QR links look like <span className="font-mono">{verifyBase}/v/…</span></>
                    })}
                  </div>
                  <div>
                    <span className="label">Customer name on the public page</span>
                    <div className="space-y-1.5">
                      {(
                        [
                          ['full', 'Show in full', 'Wetco Solar Traders'],
                          ['masked', 'Masked (recommended)', maskName('Wetco Solar Traders')],
                          ['hidden', 'Hidden', 'not shown']
                        ] as const
                      ).map(([v, label, example]) => (
                        <label key={v} className={cx('flex cursor-pointer items-center gap-3 rounded-xl border px-3 py-2 text-[13px]', draft.customerPrivacy === v ? 'border-[#7c3aed] bg-[#f6f0fd]' : 'border-[#e7e1f0] bg-white')}>
                          <input type="radio" name="privacy" checked={draft.customerPrivacy === v} onChange={() => set('customerPrivacy', v)} />
                          <span className="flex-1 font-semibold">{label}</span>
                          <span className="font-mono text-[12px] text-[#7a6d92]">{example}</span>
                        </label>
                      ))}
                    </div>
                    <p className="mt-1.5 text-[12px] text-[#7a6d92]">Applies when an invoice’s public copy is published or updated.</p>
                  </div>
                </div>
              </Section>
            </div>
          )}

          {tab === 'bank' && (
            <div className="grid gap-4 xl:grid-cols-[1fr_380px]">
              <Section title="Bank account" sub="Printed on invoices so customers can pay by bank transfer.">
                <div className="grid grid-cols-2 gap-3">
                  {text('bankName', 'Bank name', { max: 120, placeholder: 'Meezan Bank' })}
                  {text('bankTitle', 'Account title', { max: 120, placeholder: 'Digital Target' })}
                  {text('bankAccount', 'Account number', { mono: true, max: 40 })}
                  {text('iban', 'IBAN', { mono: true, max: 40, placeholder: 'PK36SCBL0000001123456702' })}
                </div>
              </Section>
              <Section title="Payment QR">{image('paymentQr')}</Section>
            </div>
          )}

          {tab === 'support' && (
            <div className="grid gap-4 xl:grid-cols-[1fr_360px]">
              <Section title="Support contacts" sub="Shown to customers on invoices and in the desktop app’s Help / About pages.">
                <div className="grid grid-cols-2 gap-3">
                  {text('supportPhone', 'Support phone', { max: 60 })}
                  {text('supportWhatsapp', 'WhatsApp number', { mono: true, max: 15, hint: 'International format, digits only (923451873354).' })}
                  {text('supportEmail', 'Support e-mail', { type: 'email', max: 120, className: 'col-span-2' })}
                </div>
              </Section>
              <Section title="Check the links">
                <div className="space-y-2 text-[13px]">
                  <LinkRow label="WhatsApp" href={/^\d{10,15}$/.test(clean.supportWhatsapp) ? `https://wa.me/${clean.supportWhatsapp}` : null} />
                  <LinkRow label="E-mail" href={clean.supportEmail ? `mailto:${clean.supportEmail}` : null} />
                  <LinkRow label="Phone" href={clean.supportPhone ? `tel:${clean.supportPhone.replace(/[^\d+]/g, '')}` : null} />
                </div>
              </Section>
            </div>
          )}

          {tab === 'portal' && (
            <div className="grid gap-4 xl:grid-cols-2">
              <Section title="Session" sub="Used by every admin’s portal session (automatic sign-out after inactivity).">
                <Field label="Sign out after inactivity (minutes)" hint={`Between ${MIN_SESSION_TIMEOUT_MIN} and ${MAX_SESSION_TIMEOUT_MIN} minutes. Admins get a one-minute warning first.`}>
                  <div className="flex items-center gap-2">
                    <Clock className="h-4 w-4 text-[#7a6d92]" />
                    <input
                      className={cx('input w-32', shown.sessionTimeoutMin && 'border-red-400')}
                      type="number"
                      min={MIN_SESSION_TIMEOUT_MIN}
                      max={MAX_SESSION_TIMEOUT_MIN}
                      value={Number.isFinite(timeout) ? timeout : ''}
                      onChange={(e) => setTimeoutMin(e.target.value === '' ? Number.NaN : Number(e.target.value))}
                      aria-label="Session timeout in minutes"
                    />
                  </div>
                  <FieldError msg={shown.sessionTimeoutMin} />
                </Field>
                <div className="mt-4 space-y-2 rounded-xl border border-[#ece6f4] bg-[#fcfbfe] p-3 text-[12.5px] text-[#5b4b78]">
                  <div className="flex items-center gap-1.5 font-bold text-[#1d1530]"><ShieldCheck className="h-4 w-4 text-[#7c3aed]" />What the free Spark plan can and cannot do</div>
                  <p>Sign-in attempts are throttled by Firebase Authentication. Disabling an admin blocks them in the security rules at once and closes their open portal sessions.</p>
                  <p>“Sign out everywhere” (revoking refresh tokens) and deleting a login need server code, which the Spark plan does not have - delete the user in Firebase Console → Authentication when needed.</p>
                  <p>Two-factor authentication needs the paid Firebase Identity Platform upgrade and is not enabled.</p>
                </div>
              </Section>
              <Section title="Device map tiles" sub="Used only by the Device Map page (map background). Leave the default unless you have your own tile service.">
                <div className="space-y-3">
                  {text('mapTileUrl', 'Tile URL', { mono: true, hint: 'https URL with {z}, {x} and {y} ({s} for sub-domains is optional).' })}
                  {text('mapAttribution', 'Attribution', { max: 300, hint: 'Required by the tile provider’s terms.' })}
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    disabled={draft.mapTileUrl === DEFAULT_BRANDING.mapTileUrl && draft.mapAttribution === DEFAULT_BRANDING.mapAttribution}
                    onClick={() => setDraft((d) => ({ ...d, mapTileUrl: DEFAULT_BRANDING.mapTileUrl, mapAttribution: DEFAULT_BRANDING.mapAttribution }))}
                  >
                    <RotateCcw className="h-4 w-4" />Use OpenStreetMap
                  </button>
                </div>
              </Section>
            </div>
          )}
        </fieldset>
      )}

      {canEdit && dirty && tab !== 'key' && (
        <div className="fixed right-6 bottom-5 z-40 flex items-center gap-3 rounded-xl border border-[#e2d6f3] bg-white px-4 py-2.5 shadow-xl" role="status">
          <span className="text-[13px] font-semibold text-[#3d096d]">Unsaved changes{changed.length ? ` (${changed.length + (timeout !== base.t ? 1 : 0)})` : ''}</span>
          <button className="btn btn-secondary btn-sm" onClick={discard} disabled={busy}>Discard</button>
          <button className="btn btn-primary btn-sm" onClick={save} disabled={busy || st.loading}>{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}{busy ? 'Saving…' : 'Save'}</button>
        </div>
      )}
    </div>
  )
}

/* ---------------------------------------------- pieces ---------------------------------------------- */

function Section({ title, sub, children, className }: { title: string; sub?: string; children: ReactNode; className?: string }) {
  return (
    <section className={cx('card p-5', className)}>
      <div className="mb-3">
        <div className="font-bold">{title}</div>
        {sub && <div className="text-[12.5px] text-[#7a6d92]">{sub}</div>}
      </div>
      {children}
    </section>
  )
}

function Toggle({ checked, onChange, label, hint }: { checked: boolean; onChange: (v: boolean) => void; label: string; hint?: string }) {
  return (
    <label className="flex cursor-pointer items-start gap-3">
      <input type="checkbox" className="peer sr-only" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span
        aria-hidden
        className={cx(
          'relative mt-0.5 h-5 w-9 shrink-0 rounded-full transition-colors peer-focus-visible:ring-2 peer-focus-visible:ring-[#c4b0e6] peer-disabled:opacity-50',
          checked ? 'bg-[#7c3aed]' : 'bg-[#d9d0e6]'
        )}
      >
        <span className={cx('absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-all', checked ? 'left-[18px]' : 'left-0.5')} />
      </span>
      <span className="text-[13px]">
        <span className="font-semibold">{label}</span>
        {hint && <span className="mt-0.5 block text-[12px] text-[#7a6d92]">{hint}</span>}
      </span>
    </label>
  )
}

function LinkRow({ label, href }: { label: string; href: string | null }) {
  return (
    <div className="flex items-center justify-between rounded-lg border border-[#ece6f4] px-3 py-2">
      <span className="font-semibold">{label}</span>
      {href ? (
        <a className="inline-flex max-w-[220px] items-center gap-1 truncate text-[12.5px] text-[#6d28d9] hover:underline" href={href} target="_blank" rel="noreferrer">
          {href.replace(/^(mailto:|tel:|https:\/\/)/, '')}
          <ExternalLink className="h-3.5 w-3.5 shrink-0" />
        </a>
      ) : (
        <span className="text-[12.5px] text-[#9a8db3]">not set</span>
      )}
    </div>
  )
}

function ImageInput({ field, value, disabled, error, onChange }: { field: ImageField; value: string | null; disabled: boolean; error?: string; onChange: (v: string | null) => void }) {
  const o = IMAGE_OPTS[field]
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const pick = async (file: File | undefined) => {
    if (!file) return
    setBusy(true)
    setErr(null)
    try {
      onChange(await compressImageFile(file, { maxWidth: o.maxWidth, maxHeight: o.maxHeight, maxBytes: MAX_IMAGE_BYTES }))
    } catch (e) {
      setErr(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div>
      <span className="label">{o.title}</span>
      <div className="flex items-start gap-4">
        <div
          className={cx('flex shrink-0 items-center justify-center overflow-hidden rounded-xl border border-dashed border-[#d9cdea] bg-[length:16px_16px]', o.box)}
          style={{ backgroundImage: 'repeating-conic-gradient(#f4f0fa 0% 25%, #ffffff 0% 50%)' }}
        >
          {value ? <img src={value} alt={o.title} className="max-h-full max-w-full object-contain" /> : <ImageOff className="h-6 w-6 text-[#c4b6da]" />}
        </div>
        <div className="min-w-0 space-y-2 text-[12px] text-[#7a6d92]">
          <div>{o.hint}</div>
          <div>{value ? `Stored size ${formatBytes(dataUrlStoredBytes(value))} of ${formatBytes(MAX_IMAGE_BYTES)} max.` : `Resized automatically and kept under ${formatBytes(MAX_IMAGE_BYTES)}.`}</div>
          {!disabled && (
            <div className="flex flex-wrap gap-2">
              <label className={cx('btn btn-secondary btn-sm', busy && 'pointer-events-none opacity-60')}>
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <ImagePlus className="h-4 w-4" />}
                {value ? 'Replace…' : 'Upload…'}
                <input
                  type="file"
                  accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml"
                  className="hidden"
                  aria-label={`Upload ${o.title}`}
                  onChange={(e) => {
                    const f = e.target.files?.[0]
                    e.target.value = ''
                    void pick(f)
                  }}
                />
              </label>
              {value && (
                <button type="button" className="btn btn-secondary btn-sm text-red-700" onClick={() => onChange(null)}>
                  <ImageOff className="h-4 w-4" />Remove
                </button>
              )}
            </div>
          )}
        </div>
      </div>
      <FieldError msg={err ?? error} />
    </div>
  )
}
