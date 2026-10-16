import { JsonBackupCard } from './JsonBackupCard'
import { ReactNode, useEffect, useState } from 'react'
import { AlertTriangle, CalendarClock, Download, FileJson, CheckCircle2, DatabaseBackup, FileUp, FolderOpen, FolderSync, HardDrive, LifeBuoy, Mail, MessageCircle, PlayCircle, RefreshCw, RotateCcw, ShieldCheck, Usb, XCircle } from 'lucide-react'
import { api } from '../../api'
import { useApp, useCan } from '../../store'
import { Badge, Button, Card, Empty, Field, Kv, Loading, Modal, NumberInput, PageHeader, Select, Tabs, cx, promptDialog, toast } from '../../components/ui'
import { ImportPanel } from './ImportPanel'
import { DataTable } from '../../components/DataTable'
import { useLoad } from '../../lib/hooks'
import { date } from '../../lib/format'
import { VENDOR } from '@shared/branding'

interface BackupFile {
  file: string
  name: string
  size: number
  modified: string
  kind: string
  meta: { firmName?: string | null; userName?: string | null; note?: string | null; integrity?: 'ok' | 'failed'; integrityError?: string | null; verifiedAt?: string } | null
}

interface BackupInfo {
  dir: string
  defaultDir: string
  dbFile: string
  backups: BackupFile[]
  lastAuto: string
}

interface BackupResult {
  file: string
  size: number
  summary?: Record<string, unknown>
}

interface InspectResult {
  file: string
  ok: boolean
  error?: string
  schemaVersion?: number
  summary?: Record<string, number | string>
}

/** Human readable file size. */
function fmtSize(bytes: number | null | undefined): string {
  const b = Number(bytes ?? 0)
  if (b < 1024) return `${b} B`
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`
  if (b < 1024 * 1024 * 1024) return `${(b / 1024 / 1024).toFixed(1)} MB`
  return `${(b / 1024 / 1024 / 1024).toFixed(2)} GB`
}

/** ISO timestamp (UTC) -> local "dd Mon yyyy HH:MM". */
function localDateTime(iso: string | null | undefined): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return String(iso)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${date(`${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`)} ${p(d.getHours())}:${p(d.getMinutes())}`
}

function sinceText(iso: string | null | undefined): string {
  if (!iso) return ''
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return ''
  const mins = Math.round((Date.now() - t) / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins} min ago`
  const hrs = Math.round(mins / 60)
  if (hrs < 48) return `${hrs} hour${hrs === 1 ? '' : 's'} ago`
  const days = Math.round(hrs / 24)
  return `${days} days ago`
}

function backupKind(kind: string): { label: string; tone: string } {
  switch (kind) {
    case 'day-close':
      return { label: 'Day close', tone: 'ok' }
    case 'manual':
      return { label: 'Manual', tone: 'brand' }
    case 'auto':
      return { label: 'Automatic', tone: 'info' }
    case 'pre-restore':
      return { label: 'Safety (before restore)', tone: 'warn' }
    case 'pre-migration':
      return { label: 'Safety (before update)', tone: 'warn' }
    default:
      return { label: 'Backup', tone: 'muted' }
  }
}

function joinPath(dir: string, name: string): string {
  if (!dir) return name
  const sep = dir.includes('\\') ? '\\' : '/'
  return dir.endsWith(sep) ? dir + name : dir + sep + name
}

function parentDir(file: string): string {
  const i = Math.max(file.lastIndexOf('\\'), file.lastIndexOf('/'))
  return i > 0 ? file.slice(0, i) : file
}

const SUMMARY_LABELS: Array<[string, string]> = [
  ['firms', 'Firms'],
  ['users', 'Users'],
  ['products', 'Products'],
  ['parties', 'Customers & suppliers'],
  ['documents', 'Documents'],
  ['projects', 'Projects'],
  ['payments', 'Payments']
]

type PageTab = 'backup' | 'import'

export function BackupPage(): JSX.Element {
  const can = useCan()
  const canBackup = can('backup.manage')
  const canImport = can('import.manage')
  const [tab, setTab] = useState<PageTab>(canBackup || !canImport ? 'backup' : 'import')
  return (
    <div className="space-y-4">
      <PageHeader title="Backup & Restore" subtitle="Keep a copy of your business data safe, export it, and import data from CSV files" icon={<DatabaseBackup className="h-5 w-5" />} />
      {canImport && (
        <Tabs<PageTab>
          tabs={[
            { key: 'backup', label: 'Backups' },
            { key: 'import', label: 'Import data' }
          ]}
          value={tab}
          onChange={setTab}
        />
      )}
      {tab === 'import' && canImport ? <ImportPanel /> : <BackupPanel />}
      {tab !== 'import' && canBackup && <JsonBackupCard />}
    </div>
  )
}

function BackupPanel(): JSX.Element {
  const can = useCan()
  const user = useApp((s) => s.user)
  const settings = useApp((s) => s.settings)
  const licenseWritable = useApp((s) => s.license?.canWrite ?? false)
  const isOwner = !!user?.isOwner
  const allowed = can('backup.manage')

  const info = useLoad(() => (allowed ? api<BackupInfo>('backup.info') : Promise.resolve(undefined as unknown as BackupInfo)), [allowed])
  const [busy, setBusy] = useState<string | null>(null)
  const [keep, setKeep] = useState<number>(Number(settings.backup_keep ?? 15))
  const [inspect, setInspect] = useState<InspectResult | null>(null)
  const [restoring, setRestoring] = useState(false)
  const [restored, setRestored] = useState(false)

  useEffect(() => setKeep(Number(settings.backup_keep ?? 15)), [settings.backup_keep])

  if (!allowed) {
    return (
      <div className="space-y-4">
        <Card>
          <Empty icon={<ShieldCheck className="h-6 w-6" />} title="No access">
            You do not have permission to manage backups. Ask the owner or an administrator (permission: “Backup &amp; restore”).
          </Empty>
        </Card>
      </div>
    )
  }

  const I = info.data
  const schedule = String(settings.backup_auto ?? 'off')
  const keepSaved = Number(settings.backup_keep ?? 15)

  const run = async <T,>(key: string, fn: () => Promise<T>): Promise<T | undefined> => {
    setBusy(key)
    try {
      return await fn()
    } catch (e) {
      toast.error(e)
      return undefined
    } finally {
      setBusy(null)
    }
  }

  const backupNow = async (chooseFolder: boolean): Promise<void> => {
    const r = await run(chooseFolder ? 'usb' : 'now', () => api<BackupResult | null>('backup.create', { chooseFolder }))
    if (r === undefined) return
    if (r === null) return // folder dialog cancelled
    toast.ok(`Backup created and verified (${fmtSize(r.size)}): ${r.file}`)
    await info.reload()
  }

  const saveSetting = async (patch: Record<string, unknown>, msg: string): Promise<boolean> => {
    const ok = await run('setting', async () => {
      await api('settings.update', { patch })
      await useApp.getState().refresh()
      return true
    })
    if (ok) {
      toast.ok(msg)
      await info.reload()
    }
    return !!ok
  }

  const changeFolder = async (): Promise<void> => {
    const dir = await run('dir', () => api<string | null>('backup.chooseDir'))
    if (!dir) return
    toast.ok(`Backup folder changed to ${dir}`)
    await useApp.getState().refresh().catch(() => undefined)
    await info.reload()
  }

  const openFolder = async (): Promise<void> => {
    const err = await run('open', () => api<string>('backup.openFolder'))
    if (err) toast.error(`Could not open the folder: ${err}`)
  }

  const runAuto = async (): Promise<void> => {
    if (schedule === 'off') return toast.warn('Automatic backup is turned off. Choose Daily or Weekly first, or use “Back up now”.')
    const r = await run('auto', () => api<BackupResult | null>('backup.runAuto', { force: true }))
    if (r === undefined) return
    if (r === null) {
      toast.info(`An automatic backup is not due yet (last one: ${localDateTime(I?.lastAuto)}). Use “Back up now” for an immediate copy.`)
      return
    }
    toast.ok(`Automatic backup created (${fmtSize(r.size)}): ${r.file}`)
    await useApp.getState().refresh().catch(() => undefined)
    await info.reload()
  }

  /** Step 1 of restore: validate the file (opens a file dialog when no file is given). */
  const startInspect = async (file?: string): Promise<void> => {
    const r = await run(file ? `inspect:${file}` : 'inspect', () => api<InspectResult | null>('backup.inspect', file ? { file } : {}))
    if (!r) return
    setInspect(r)
  }

  /** Step 2: typed confirmation and restore. */
  const doRestore = async (): Promise<void> => {
    if (!inspect?.ok || !isOwner) return
    const typed = await promptDialog({
      title: 'Restore this backup?',
      danger: true,
      confirmLabel: 'Restore now',
      message: (
        <div className="space-y-2">
          <p>
            All current data on this computer (every firm, document, payment and setting) will be <b className="text-bad">replaced</b> with the contents of:
          </p>
          <p className="break-all rounded-lg bg-surface-2 px-2 py-1 font-mono text-[12px] text-ink">{inspect.file}</p>
          <p>
            A <b>safety copy of the current data is created first</b> in the “safety” backup folder, so you can go back if needed. After restoring, everyone is signed out and must sign in again with the
            passwords stored in the backup.
          </p>
          <p>
            Type <b className="text-ink">RESTORE</b> to confirm.
          </p>
        </div>
      ),
      input: { label: 'Type RESTORE to confirm', placeholder: 'RESTORE', mustEqual: 'RESTORE', required: true }
    })
    if (typed !== 'RESTORE') return
    setRestoring(true)
    try {
      const r = await api<{ restored: boolean; safety: string }>('backup.restore', { file: inspect.file, confirm: 'RESTORE' })
      setRestored(true)
      toast.ok(`Backup restored. Safety copy of the previous data: ${r.safety}. Please sign in again.`)
      setTimeout(() => window.location.reload(), 1800)
    } catch (e) {
      setRestoring(false)
      toast.error(e)
    }
  }

  const verify = async (file: string): Promise<void> => {
    const r = await run(`verify:${file}`, () => api<{ ok: boolean; error?: string }>('backup.verify', { file }))
    if (!r) return
    if (r.ok) toast.ok('Integrity check passed — this backup can be restored.')
    else toast.error(`Integrity check failed: ${r.error ?? 'the backup is damaged.'}`)
    await info.reload()
  }

  const exportOne = async (file: string): Promise<void> => {
    const r = await run(`export:${file}`, () => api<{ file: string; size: number } | null>('backup.export', { file }))
    if (r) toast.ok(`Backup exported and verified: ${r.file}`)
  }

  const exportFirm = async (): Promise<void> => {
    const r = await run('firm', () => api<{ file: string; size: number } | null>('backup.exportFirm'))
    if (r) toast.ok(`Firm data exported (${fmtSize(r.size)}): ${r.file}`)
  }

  const safetyDir = I ? joinPath(I.defaultDir, 'safety') : ''
  const lastAutoTime = I?.lastAuto ? `${localDateTime(I.lastAuto)} (${sinceText(I.lastAuto)})` : 'Never'

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-end gap-2">
        <Button icon={<FileJson className="h-4 w-4" />} loading={busy === 'firm'} disabled={!!busy && busy !== 'firm'} onClick={exportFirm}>
          Export firm data (JSON)…
        </Button>
        <Button icon={<RefreshCw className="h-4 w-4" />} onClick={() => info.reload()} loading={info.loading && !!I}>
          Refresh
        </Button>
      </div>

      {!I && info.loading ? (
        <Loading label="Loading backup information…" />
      ) : !I ? (
        <Card>
          <Empty icon={<AlertTriangle className="h-6 w-6" />} title="Could not load backup information" action={<Button onClick={() => info.reload()}>Try again</Button>} />
        </Card>
      ) : (
        <>
          {/* ------------------------------ Back up now ------------------------------ */}
          <div className="grid gap-4 lg:grid-cols-2">
            <div className="card flex flex-col gap-4 p-5">
              <div className="flex items-start gap-3">
                <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-brand text-on-brand shadow-sm">
                  <HardDrive className="h-6 w-6" />
                </div>
                <div className="min-w-0">
                  <div className="text-[16px] font-semibold">Back up now</div>
                  <div className="text-[12.5px] text-muted">Creates a complete, verified copy of all data in the backup folder.</div>
                  <div className="mt-1 truncate font-mono text-[11.5px] text-muted" title={I.dir}>
                    {I.dir}
                  </div>
                </div>
              </div>
              <Button size="lg" variant="primary" className="w-full" icon={<DatabaseBackup className="h-5 w-5" />} loading={busy === 'now'} disabled={!!busy && busy !== 'now'} onClick={() => backupNow(false)}>
                Back up now
              </Button>
            </div>
            <div className="card flex flex-col gap-4 p-5">
              <div className="flex items-start gap-3">
                <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-ok text-white shadow-sm">
                  <Usb className="h-6 w-6" />
                </div>
                <div className="min-w-0">
                  <div className="text-[16px] font-semibold">Back up to USB / another folder</div>
                  <div className="text-[12.5px] text-muted">Recommended weekly: keep a copy away from this computer in case it is lost, stolen or damaged.</div>
                </div>
              </div>
              <Button size="lg" variant="success" className="w-full" icon={<Usb className="h-5 w-5" />} loading={busy === 'usb'} disabled={!!busy && busy !== 'usb'} onClick={() => backupNow(true)}>
                Back up to USB / another folder…
              </Button>
            </div>
          </div>

          <div className="grid gap-4 xl:grid-cols-[1fr_1.4fr]">
            {/* ------------------------------ Automatic backup ------------------------------ */}
            <Card title={<span className="inline-flex items-center gap-2"><CalendarClock className="h-4 w-4 text-brand" /> Automatic backup</span>}>
              <div className="space-y-4">
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label="Schedule" hint={schedule === 'off' ? 'Not recommended — you may lose data' : 'Runs when the app is open and a backup is due'}>
                    <Select
                      value={schedule}
                      disabled={!!busy || !licenseWritable}
                      onChange={(e) => saveSetting({ backup_auto: e.target.value }, e.target.value === 'off' ? 'Automatic backup turned off.' : `Automatic backup set to ${e.target.value}.`)}
                    >
                      <option value="daily">Daily</option>
                      <option value="weekly">Weekly</option>
                      <option value="off">Off</option>
                    </Select>
                  </Field>
                  <Field label="Keep the last" hint="Older automatic backups are deleted (manual ones are kept)">
                    <div className="flex items-center gap-2">
                      <div className="w-24">
                        <NumberInput value={keep} disabled={!licenseWritable} onChange={(v) => setKeep(Math.floor(v))} />
                      </div>
                      <span className="text-muted">backups</span>
                      {keep !== keepSaved && (
                        <Button
                          size="sm"
                          variant="primary"
                          loading={busy === 'setting'}
                          onClick={() => {
                            if (!(keep >= 1 && keep <= 200)) return toast.error('Keep between 1 and 200 backups.')
                            saveSetting({ backup_keep: keep }, `Will keep the last ${keep} automatic backups.`)
                          }}
                        >
                          Save
                        </Button>
                      )}
                    </div>
                  </Field>
                </div>
                {!licenseWritable && <div className="text-[12px] text-warn">The license is read-only, so the schedule cannot be changed. Manual backups still work.</div>}
                {schedule === 'off' && (
                  <div className="flex items-start gap-2 rounded-xl bg-warn-soft px-3 py-2 text-[12.5px] text-warn">
                    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /> Automatic backup is off. Turn it on so a recent copy always exists.
                  </div>
                )}

                <div>
                  <div className="mb-1 text-[12.5px] font-medium text-muted">Backup folder</div>
                  <div className="break-all rounded-lg border border-line bg-surface-2 px-3 py-2 font-mono text-[12px]">{I.dir}</div>
                  {I.dir !== I.defaultDir && <div className="mt-1 text-[11.5px] text-muted">Default folder: {I.defaultDir}</div>}
                  <div className="mt-2 flex flex-wrap gap-2">
                    <Button size="sm" icon={<FolderSync className="h-4 w-4" />} loading={busy === 'dir'} disabled={!!busy && busy !== 'dir'} onClick={changeFolder}>
                      Change…
                    </Button>
                    <Button size="sm" icon={<FolderOpen className="h-4 w-4" />} loading={busy === 'open'} onClick={openFolder}>
                      Open folder
                    </Button>
                    {I.dir !== I.defaultDir && (
                      <Button size="sm" variant="ghost" disabled={!!busy || !licenseWritable} onClick={() => saveSetting({ backup_dir: '' }, 'Backup folder reset to the default folder.')}>
                        Use default folder
                      </Button>
                    )}
                  </div>
                </div>

                <div className="rounded-xl border border-line p-3">
                  <Kv label="Last automatic backup">{lastAutoTime}</Kv>
                  <Kv label="Backups in folder">{I.backups.length}</Kv>
                  <Button className="mt-2 w-full" icon={<PlayCircle className="h-4 w-4" />} loading={busy === 'auto'} disabled={!!busy && busy !== 'auto'} onClick={runAuto}>
                    Run automatic backup now
                  </Button>
                </div>
              </div>
            </Card>

            {/* ------------------------------ Backups list ------------------------------ */}
            <Card
              pad={false}
              title={<span className="inline-flex items-center gap-2"><RotateCcw className="h-4 w-4 text-brand" /> Backup history</span>}
              actions={
                <Button size="sm" variant={isOwner ? 'soft' : 'secondary'} icon={<FileUp className="h-4 w-4" />} loading={busy === 'inspect'} disabled={!!busy && busy !== 'inspect'} onClick={() => startInspect()}>
                  {isOwner ? 'Restore from file…' : 'Verify a backup file…'}
                </Button>
              }
            >
              {!isOwner && (
                <div className="flex items-start gap-2 border-b border-line bg-info-soft px-4 py-2.5 text-[12.5px] text-info">
                  <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" /> Only the owner account can restore a backup, because restoring replaces all data. You can still create and verify backups.
                </div>
              )}
              <DataTable<BackupFile>
                rows={I.backups}
                dense
                pageSize={10}
                searchPlaceholder="Search backups…"
                rowKey={(r) => r.file}
                empty={
                  <Empty icon={<DatabaseBackup className="h-6 w-6" />} title="No backups in this folder yet">
                    Click “Back up now” to create your first backup.
                  </Empty>
                }
                columns={[
                  {
                    key: 'name',
                    header: 'Backup',
                    render: (r) => {
                      const k = backupKind(r.kind)
                      return (
                        <div className="min-w-0">
                          <div className="truncate font-medium" title={r.file}>
                            {r.name}
                          </div>
                          <Badge tone={k.tone} className="mt-0.5">
                            {k.label}
                          </Badge>
                        </div>
                      )
                    }
                  },
                  { key: 'modified', header: 'Date', render: (r) => <span className="whitespace-nowrap">{localDateTime(r.modified)}</span>, value: (r) => r.modified },
                  { key: 'size', header: 'Size', align: 'right', render: (r) => <span className="num whitespace-nowrap">{fmtSize(r.size)}</span>, value: (r) => r.size },
                  {
                    key: 'integrity',
                    header: 'Integrity',
                    value: (r) => r.meta?.integrity ?? 'not checked',
                    render: (r) =>
                      r.meta?.integrity === 'ok' ? (
                        <Badge tone="ok">Verified</Badge>
                      ) : r.meta?.integrity === 'failed' ? (
                        <span title={r.meta.integrityError ?? ''}>
                          <Badge tone="bad">Failed</Badge>
                        </span>
                      ) : (
                        <Badge tone="muted">Not checked</Badge>
                      )
                  },
                  {
                    key: 'who',
                    header: 'Firm / user',
                    value: (r) => [r.meta?.firmName, r.meta?.userName].filter(Boolean).join(' / '),
                    render: (r) => (
                      <div className="min-w-0 text-[12px]">
                        <div className="truncate">{r.meta?.firmName || '—'}</div>
                        <div className="truncate text-muted">{r.meta?.userName || (r.kind === 'auto' ? 'Scheduled' : '')}</div>
                      </div>
                    )
                  },
                  {
                    key: 'actions',
                    header: '',
                    align: 'right',
                    sortable: false,
                    csv: false,
                    render: (r) => (
                      <div className="flex justify-end gap-1">
                        <Button size="sm" variant="ghost" icon={<ShieldCheck className="h-3.5 w-3.5" />} loading={busy === `verify:${r.file}`} disabled={!!busy && busy !== `verify:${r.file}`} onClick={() => verify(r.file)}>
                          Verify
                        </Button>
                        <Button size="sm" variant="ghost" icon={<Download className="h-3.5 w-3.5" />} loading={busy === `export:${r.file}`} disabled={!!busy && busy !== `export:${r.file}`} onClick={() => exportOne(r.file)}>
                          Export
                        </Button>
                        {isOwner && (
                          <Button size="sm" variant="secondary" icon={<RotateCcw className="h-3.5 w-3.5" />} loading={busy === `inspect:${r.file}`} disabled={!!busy && busy !== `inspect:${r.file}`} onClick={() => startInspect(r.file)}>
                            Restore…
                          </Button>
                        )}
                      </div>
                    )
                  }
                ]}
              />
            </Card>
          </div>

          {/* ------------------------------ Recovery guidance ------------------------------ */}
          <Card title={<span className="inline-flex items-center gap-2"><LifeBuoy className="h-4 w-4 text-brand" /> Recovery guidance</span>}>
            <div className="grid gap-5 text-[13px] leading-relaxed md:grid-cols-2">
              <Guide title="If a backup fails">
                <li>Choose another folder with “Back up to USB / another folder…” or “Change…”.</li>
                <li>Check there is enough free space on the drive (a backup is about the size of your data file).</li>
                <li>If using a USB drive, make sure it is plugged in, not write-protected, and try a different port or drive.</li>
                <li>Close other programs that may be using the backup file, then try again.</li>
              </Guide>
              <Guide title="Where backups are kept">
                <li>
                  Manual &amp; automatic backups: <Path>{I.dir}</Path>
                </li>
                <li>
                  Safety copies made automatically before every restore: <Path>{safetyDir}</Path>
                </li>
                <li>
                  Your live data file: <Path>{I.dbFile}</Path>
                </li>
                <li>Backup files end with “.dtbak” and contain all firms, users and settings.</li>
              </Guide>
              <Guide title="Important" tone="bad">
                <li>
                  <b>Never delete or move the data folder</b> (<Path>{parentDir(I.dbFile)}</Path>) — it holds all your business records.
                </li>
                <li>Do not open or edit backup files with other programs.</li>
                <li>Keep at least one recent backup outside this computer (USB, external disk or another PC).</li>
              </Guide>
              <Guide title="Need help?">
                <li>Contact Digital Target before restoring if you are unsure which backup to use — we can help you recover your data.</li>
                <li className="list-none pt-1">
                  <div className="flex flex-wrap gap-2">
                    <Button size="sm" icon={<Mail className="h-4 w-4" />} onClick={() => api('app.openExternal', { url: `mailto:${VENDOR.email}?subject=${encodeURIComponent('DT Solar Pro backup / restore help')}` }).catch(toast.error)}>
                      {VENDOR.email}
                    </Button>
                    <Button size="sm" variant="success" icon={<MessageCircle className="h-4 w-4" />} onClick={() => api('app.openExternal', { url: VENDOR.whatsapp }).catch(toast.error)}>
                      WhatsApp {VENDOR.phone}
                    </Button>
                  </div>
                </li>
              </Guide>
            </div>
          </Card>
        </>
      )}

      {/* ------------------------------ Restore: validation result ------------------------------ */}
      <Modal
        open={!!inspect}
        onClose={() => !restoring && setInspect(null)}
        title={isOwner ? 'Restore backup' : 'Verify backup'}
        subtitle="Step 1 of 2 — check the backup file"
        size="md"
        footer={
          inspect && (
            <>
              <Button disabled={restoring} onClick={() => setInspect(null)}>
                {inspect.ok && isOwner ? 'Cancel' : 'Close'}
              </Button>
              {inspect.ok && isOwner && (
                <Button variant="danger" icon={<RotateCcw className="h-4 w-4" />} loading={restoring} onClick={doRestore}>
                  Restore this backup…
                </Button>
              )}
            </>
          )
        }
      >
        {inspect && (
          <div className="space-y-4">
            <div>
              <div className="text-[12px] font-medium text-muted">Backup file</div>
              <div className="break-all font-mono text-[12px]">{inspect.file}</div>
            </div>
            {inspect.ok ? (
              <>
                <div className="flex items-start gap-3 rounded-xl bg-ok-soft px-4 py-3 text-ok">
                  <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0" />
                  <div>
                    <div className="font-semibold">Integrity check passed</div>
                    <div className="text-[12.5px]">This is a valid DT Solar Pro backup (database schema version {inspect.schemaVersion ?? '—'}).</div>
                  </div>
                </div>
                <div>
                  <div className="mb-2 text-[12.5px] font-medium text-muted">What this backup contains</div>
                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                    {SUMMARY_LABELS.map(([k, l]) => (
                      <div key={k} className="rounded-xl border border-line bg-surface-2 px-3 py-2">
                        <div className="text-[11.5px] text-muted">{l}</div>
                        <div className="num text-[18px] font-bold">{inspect.summary?.[k] ?? '—'}</div>
                      </div>
                    ))}
                    <div className="rounded-xl border border-line bg-surface-2 px-3 py-2">
                      <div className="text-[11.5px] text-muted">Last transaction</div>
                      <div className="text-[14px] font-bold">{inspect.summary?.lastTransactionDate && inspect.summary.lastTransactionDate !== '—' ? date(String(inspect.summary.lastTransactionDate)) : '—'}</div>
                    </div>
                  </div>
                </div>
                {isOwner ? (
                  <div className="flex items-start gap-2 rounded-xl bg-bad-soft px-4 py-3 text-[12.5px] text-bad">
                    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                    <div>
                      Restoring <b>replaces all current data</b> with this backup. Anything entered after the backup date will not be in the restored data. A safety copy of the current data is created first.
                    </div>
                  </div>
                ) : (
                  <div className="text-[12.5px] text-muted">Only the owner account can restore backups.</div>
                )}
              </>
            ) : (
              <div className="flex items-start gap-3 rounded-xl bg-bad-soft px-4 py-3 text-bad">
                <XCircle className="mt-0.5 h-5 w-5 shrink-0" />
                <div>
                  <div className="font-semibold">This file cannot be restored</div>
                  <div className="text-[12.5px]">{inspect.error ?? 'The backup is damaged or is not a DT Solar Pro backup.'}</div>
                  <div className="mt-1 text-[12px]">Try another backup file. Your current data has not been changed.</div>
                </div>
              </div>
            )}
          </div>
        )}
      </Modal>

      {restoring && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 backdrop-blur-sm">
          <div className="flex items-center gap-3 rounded-[14px] border border-line bg-surface px-6 py-5 shadow-2xl">
            {restored ? <CheckCircle2 className="h-5 w-5 text-ok" /> : <RefreshCw className="h-5 w-5 animate-spin text-brand" />}
            <div>
              <div className="font-semibold">{restored ? 'Backup restored' : 'Restoring backup…'}</div>
              <div className="text-[12.5px] text-muted">{restored ? 'Restarting — please sign in again.' : 'Please do not close the application.'}</div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function Guide({ title, children, tone }: { title: string; children: ReactNode; tone?: 'bad' }): JSX.Element {
  return (
    <div>
      <div className={cx('mb-1.5 font-semibold', tone === 'bad' && 'text-bad')}>{title}</div>
      <ul className="list-disc space-y-1 pl-5 text-muted">{children}</ul>
    </div>
  )
}

function Path({ children }: { children: ReactNode }): JSX.Element {
  return <span className="break-all rounded bg-surface-2 px-1 font-mono text-[11.5px] text-ink">{children}</span>
}
