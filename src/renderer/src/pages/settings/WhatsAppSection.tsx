/** Settings section — WhatsApp: mode, country code, notifications, linked device, send log (owner: assist area). */
import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { CheckCheck, LogOut, MessageCircle, RotateCcw, Save, XCircle } from 'lucide-react'
import { api } from '../../api'
import { useApp, useCan } from '../../store'
import { Badge, Button, Card, Field, Input, Select, Toggle, confirmDialog, promptDialog, toast } from '../../components/ui'
import { DataTable, Column } from '../../components/DataTable'
import { SendWhatsAppDialog, WhatsAppButtonProps } from '../../components/WhatsAppButton'

interface LogRow {
  id: number
  party_id: number | null
  party_name: string | null
  phone: string
  entity: WhatsAppButtonProps['entity'] | null
  entity_id: number | null
  file_name: string | null
  method: 'whatsapp_web' | 'chat_link' | 'cloud_api'
  status: 'prepared' | 'opened' | 'sent' | 'failed'
  error: string | null
  created_at: string
  updated_at: string | null
  created_by_name: string | null
}

const STATUS_TONE: Record<string, string> = { prepared: 'muted', opened: 'info', sent: 'ok', failed: 'bad' }
const ENTITY_LABEL: Record<string, string> = { document: 'Document', payment: 'Payment', statement: 'Statement', project: 'Project', material: 'Material note' }
const METHOD_LABEL: Record<string, string> = { whatsapp_web: 'WhatsApp Web', chat_link: 'Chat link', cloud_api: 'Cloud API' }

export function WhatsAppSection(): JSX.Element {
  const can = useCan()
  const nav = useNavigate()
  const { settings } = useApp()
  const editable = can('settings.manage')
  const [mode, setMode] = useState(String(settings.whatsapp_mode ?? 'web'))
  const [cc, setCc] = useState(String(settings.whatsapp_country_code ?? '92'))
  const [notif, setNotif] = useState(settings.whatsapp_notifications === true)
  const [saving, setSaving] = useState(false)
  const [rows, setRows] = useState<LogRow[]>([])
  const [loading, setLoading] = useState(true)
  const [f, setF] = useState({ status: '', entity: '', from: '', to: '' })
  const [reopen, setReopen] = useState<LogRow | null>(null)

  const load = useCallback(() => {
    if (!can('whatsapp.send')) return setLoading(false)
    setLoading(true)
    api<LogRow[]>('whatsapp.log', f)
      .then(setRows)
      .catch(toast.error)
      .finally(() => setLoading(false))
  }, [JSON.stringify(f)]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(load, [load])

  const save = async (): Promise<void> => {
    setSaving(true)
    try {
      const s = await api<Record<string, unknown>>('settings.update', { patch: { whatsapp_mode: mode, whatsapp_country_code: cc, whatsapp_notifications: notif } })
      useApp.setState({ settings: s })
      setCc(String(s.whatsapp_country_code))
      toast.ok('WhatsApp settings saved.')
    } catch (e) {
      toast.error(e)
    } finally {
      setSaving(false)
    }
  }

  const unlink = async (): Promise<void> => {
    if (
      !(await confirmDialog({
        title: 'Unlink WhatsApp from this computer?',
        message: 'WhatsApp Web will be logged out here and a new QR code will appear next time. Also remove the device on your phone: WhatsApp → Linked devices.',
        confirmLabel: 'Unlink / log out',
        danger: true
      }))
    )
      return
    try {
      await api('whatsapp.unlink')
      toast.ok('WhatsApp was logged out on this computer.')
    } catch (e) {
      toast.error(e)
    }
  }

  const markSent = async (r: LogRow): Promise<void> => {
    try {
      await api('whatsapp.markSent', { logId: r.id })
      load()
    } catch (e) {
      toast.error(e)
    }
  }

  const markFailed = async (r: LogRow): Promise<void> => {
    const reason = await promptDialog({ title: 'Mark as failed', input: { label: 'Reason', placeholder: 'e.g. number not on WhatsApp', required: true }, confirmLabel: 'Save' })
    if (!reason) return
    try {
      await api('whatsapp.markFailed', { logId: r.id, reason })
      load()
    } catch (e) {
      toast.error(e)
    }
  }

  const columns: Array<Column<LogRow>> = [
    { key: 'created_at', header: 'Date', width: 140, render: (r) => <span className="whitespace-nowrap">{r.created_at.slice(0, 16)}</span> },
    { key: 'party_name', header: 'Customer / supplier', render: (r) => r.party_name ?? '—' },
    { key: 'phone', header: 'Phone', render: (r) => <span className="num">+{r.phone}</span> },
    { key: 'file_name', header: 'Document', render: (r) => <span title={r.file_name ?? ''}>{ENTITY_LABEL[r.entity ?? ''] ?? r.entity} · {r.file_name}</span> },
    { key: 'method', header: 'Method', render: (r) => METHOD_LABEL[r.method] ?? r.method },
    {
      key: 'status',
      header: 'Status',
      render: (r) => (
        <span title={r.error ?? ''}>
          <Badge tone={STATUS_TONE[r.status]}>{r.status}</Badge>
          {r.error && <div className="mt-0.5 max-w-[200px] truncate text-[12px] text-bad">{r.error}</div>}
        </span>
      )
    },
    { key: 'created_by_name', header: 'By' },
    {
      key: 'actions',
      header: '',
      csv: false,
      sortable: false,
      render: (r) => (
        <div className="flex justify-end gap-1">
          {r.entity && r.entity_id && (
            <Button size="sm" variant="ghost" icon={<RotateCcw className="h-4 w-4" />} onClick={() => setReopen(r)} title="Prepare and open this chat again">
              Re-open
            </Button>
          )}
          {(r.status === 'prepared' || r.status === 'opened') && (
            <>
              <Button size="sm" variant="ghost" icon={<CheckCheck className="h-4 w-4 text-ok" />} onClick={() => markSent(r)}>
                Mark sent
              </Button>
              <Button size="sm" variant="ghost" icon={<XCircle className="h-4 w-4 text-bad" />} onClick={() => markFailed(r)}>
                Failed
              </Button>
            </>
          )}
        </div>
      )
    }
  ]

  return (
    <div className="space-y-4">
      <Card title="WhatsApp" actions={editable ? <Button variant="primary" size="sm" loading={saving} icon={<Save className="h-4 w-4" />} onClick={save}>Save</Button> : undefined}>
        <div className="grid gap-4 md:grid-cols-2">
          <Field label="How documents are sent" hint="WhatsApp Web inside the app works without the WhatsApp desktop app. Chat link opens wa.me in your browser / WhatsApp app.">
            <Select value={mode} onChange={(e) => setMode(e.target.value)} disabled={!editable}>
              <option value="web">WhatsApp Web inside the app (recommended)</option>
              <option value="chat_link">Chat link (desktop WhatsApp app / browser)</option>
            </Select>
          </Field>
          <Field label="Default country code" hint="Added to local numbers, e.g. 0300 1234567 becomes +92 300 1234567.">
            <Input value={cc} onChange={(e) => setCc(e.target.value.replace(/\D/g, '').slice(0, 4))} disabled={!editable} inputMode="numeric" className="w-32" />
          </Field>
          <div className="md:col-span-2">
            <Toggle checked={notif} onChange={setNotif} disabled={!editable} label="Desktop notifications from WhatsApp" description="When on, WhatsApp Web may show new-message notifications while the app is open." />
          </div>
        </div>
        {!editable && <p className="mt-3 text-[12px] text-muted">Only users with the “Settings” permission can change these options.</p>}
      </Card>

      <Card title="Linked device">
        <div className="space-y-2 text-[13px] text-muted">
          <p>
            The WhatsApp screen shows the real WhatsApp Web. Link your phone once: on the phone open WhatsApp → Settings (or ⋮) → <b>Linked devices</b> → <b>Link a device</b> and scan the QR code. It stays linked on this computer. The app never sends messages by itself — you always press Send in WhatsApp.
          </p>
          <p>WhatsApp Web needs internet. If the QR code does not load, press Reload on the WhatsApp screen.</p>
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          {can('whatsapp.send') && (
            <Button icon={<MessageCircle className="h-4 w-4 text-[#25D366]" />} onClick={() => nav('/whatsapp')}>
              Open WhatsApp
            </Button>
          )}
          {can('whatsapp.send') && (
            <Button variant="ghost" icon={<LogOut className="h-4 w-4" />} onClick={unlink}>
              Unlink / log out
            </Button>
          )}
        </div>
      </Card>

      {can('whatsapp.send') && (
        <Card title="Send log" pad={false}>
          <DataTable
            rows={rows}
            columns={columns}
            loading={loading}
            exportName="whatsapp-send-log"
            rowKey={(r) => r.id}
            dense
            empty="Nothing sent on WhatsApp yet."
            toolbar={
              <div className="flex flex-wrap items-center gap-2">
                <Select sm value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })} aria-label="Status">
                  <option value="">All statuses</option>
                  <option value="prepared">Prepared</option>
                  <option value="opened">Opened</option>
                  <option value="sent">Sent</option>
                  <option value="failed">Failed</option>
                </Select>
                <Select sm value={f.entity} onChange={(e) => setF({ ...f, entity: e.target.value })} aria-label="Type">
                  <option value="">All types</option>
                  {Object.entries(ENTITY_LABEL).map(([k, v]) => (
                    <option key={k} value={k}>
                      {v}
                    </option>
                  ))}
                </Select>
                <Input sm type="date" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} aria-label="From" />
                <Input sm type="date" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} aria-label="To" />
              </div>
            }
          />
        </Card>
      )}
      {reopen && reopen.entity && reopen.entity_id && (
        <SendWhatsAppDialog
          entity={reopen.entity}
          id={reopen.entity_id}
          phone={`+${reopen.phone}`}
          onClose={() => {
            setReopen(null)
            load()
          }}
        />
      )}
    </div>
  )
}
