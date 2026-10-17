/**
 * "Send on WhatsApp" (owner: assist area). Prepares the PDF in the WhatsApp outbox and opens the customer's chat in the
 * built-in WhatsApp Web module (or a wa.me chat link). The user drags the PDF into the chat and presses Send in
 * WhatsApp - the app never sends anything by itself and never claims a message was sent.
 */
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { AlertTriangle, CheckCheck, FileText, FolderOpen, GripVertical, MessageCircle, X } from 'lucide-react'
import { api } from '../api'
import { useCan } from '../store'
import { Button, Field, Input, Loading, Modal, Textarea, confirmDialog, promptDialog, toast } from './ui'

export interface WhatsAppButtonProps {
  /** What is being sent. 'statement' uses partyId + optional from/to params. */
  entity: 'document' | 'payment' | 'project' | 'statement' | 'material'
  id: number
  partyId?: number | null
  phone?: string | null
  params?: Record<string, unknown>
  size?: 'sm' | 'md'
  label?: string
}

export interface OutboxItem {
  logId: number
  token: string
  fileName: string
  size: number
  phone: string
  message: string
  entity: string
  entityId: number
  label: string
  method: 'whatsapp_web' | 'chat_link'
}

interface Draft {
  phone: string
  phoneRaw: string
  message: string
  fileName: string
  label: string
  partyName: string | null
  mode: 'web' | 'chat_link'
  countryCode: string
  duplicate: LogLite | null
}

interface LogLite {
  id: number
  status: string
  phone: string
  created_at: string
  updated_at: string | null
}

/** Client-side check only for instant feedback; the main process validates again. */
export function looksLikePhone(v: string): boolean {
  const d = v.replace(/\D/g, '')
  return d.length >= 9 && d.length <= 15
}

export function formatSize(n: number): string {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${Math.max(1, Math.round(n / 1024))} KB`
}

function duplicateText(d: LogLite): string {
  return `This was already ${d.status === 'sent' ? 'marked as sent' : 'opened'} to +${d.phone} at ${(d.updated_at ?? d.created_at).slice(11, 16)}. Send it again?`
}

export function WhatsAppButton({ entity, id, phone, params, size = 'md', label }: WhatsAppButtonProps): JSX.Element | null {
  const can = useCan()
  const [open, setOpen] = useState(false)
  if (!can('whatsapp.send') || !id) return null
  return (
    <>
      <Button size={size} icon={<MessageCircle className="h-4 w-4 text-[#25D366]" />} onClick={() => setOpen(true)}>
        {label ?? 'Send on WhatsApp'}
      </Button>
      {open && <SendWhatsAppDialog entity={entity} id={id} phone={phone} params={params} onClose={() => setOpen(false)} />}
    </>
  )
}

/** Dialog: phone + message -> prepare PDF -> open chat. Reused by Settings -> WhatsApp send log ("Re-open"). */
export function SendWhatsAppDialog({ entity, id, phone, params, onClose }: { entity: WhatsAppButtonProps['entity']; id: number; phone?: string | null; params?: Record<string, unknown>; onClose: () => void }): JSX.Element {
  const nav = useNavigate()
  const [draft, setDraft] = useState<Draft | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [to, setTo] = useState('')
  const [msg, setMsg] = useState('')
  const [busy, setBusy] = useState(false)
  const [prepared, setPrepared] = useState<OutboxItem | null>(null)

  useEffect(() => {
    api<Draft>('whatsapp.draft', { entity, id, params })
      .then((d) => {
        setDraft(d)
        setTo(phone && looksLikePhone(phone) ? phone : d.phone ? `+${d.phone}` : d.phoneRaw || phone || '')
        setMsg(d.message)
      })
      .catch((e) => setErr((e as Error).message))
  }, [entity, id, JSON.stringify(params ?? {})]) // eslint-disable-line react-hooks/exhaustive-deps

  const phoneOk = looksLikePhone(to)

  const go = async (confirmDuplicate = false): Promise<void> => {
    setBusy(true)
    try {
      const r = await api<{ duplicate?: LogLite; item?: OutboxItem; mode?: 'web' | 'chat_link' }>('whatsapp.prepare', { entity, id, params, phone: to, message: msg, confirmDuplicate })
      if (r.duplicate) {
        setBusy(false)
        if (await confirmDialog({ title: 'Send again?', message: duplicateText(r.duplicate), confirmLabel: 'Send again' })) await go(true)
        return
      }
      if (!r.item) return
      if (r.mode === 'chat_link') {
        setPrepared(r.item)
        toast.info('The chat opened in WhatsApp. Drag the PDF into the chat, then press Send in WhatsApp.')
      } else {
        onClose()
        nav('/whatsapp', { state: { openLogId: r.item.logId } })
      }
    } catch (e) {
      toast.error(e)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title="Send on WhatsApp"
      subtitle={draft ? `${draft.label}${draft.partyName ? `, ${draft.partyName}` : ''}` : undefined}
      size="md"
      footer={
        prepared ? (
          <Button onClick={onClose}>Close</Button>
        ) : (
          <>
            <Button onClick={onClose}>Cancel</Button>
            <Button variant="primary" loading={busy} disabled={!draft || !phoneOk || busy} icon={<MessageCircle className="h-4 w-4" />} onClick={() => go(false)}>
              Prepare & open chat
            </Button>
          </>
        )
      }
    >
      {err ? (
        <div className="flex items-start gap-2 text-[13px] text-bad">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /> {err}
        </div>
      ) : !draft ? (
        <Loading />
      ) : prepared ? (
        <div className="space-y-3">
          <p className="text-[13px] text-muted">The chat was opened with your WhatsApp app (chat link mode). Drag the PDF into the chat, then press Send in WhatsApp.</p>
          <AttachTile item={prepared} onDone={onClose} />
        </div>
      ) : (
        <div className="space-y-3">
          {draft.duplicate && (
            <div className="flex items-start gap-2 rounded-lg border border-warn/40 bg-warn/10 px-3 py-2 text-[12.5px]">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warn" /> {duplicateText(draft.duplicate).replace(' Send it again?', '')}
            </div>
          )}
          <Field label="WhatsApp number" required hint={`Local numbers get country code +${draft.countryCode}. Example: 0300 1234567 or +92 300 1234567.`} error={to && !phoneOk ? 'Enter a valid mobile number.' : undefined}>
            <Input autoFocus value={to} onChange={(e) => setTo(e.target.value)} placeholder="0300 1234567" inputMode="tel" />
          </Field>
          <Field label="Message">
            <Textarea rows={6} value={msg} maxLength={2000} onChange={(e) => setMsg(e.target.value)} dir="auto" />
          </Field>
          <div className="flex items-center gap-2 rounded-lg bg-surface-2 px-3 py-2 text-[12.5px]">
            <FileText className="h-4 w-4 shrink-0 text-bad" />
            <span className="min-w-0 flex-1 truncate">{draft.fileName}</span>
            <span className="text-muted">PDF</span>
          </div>
          <p className="text-[12px] text-muted">
            {draft.mode === 'web'
              ? 'The PDF is prepared and the chat opens in the WhatsApp screen of this app. You drag the PDF into the chat and press Send yourself.'
              : 'The PDF is prepared and the chat opens in your WhatsApp app / browser (wa.me). You attach the PDF and press Send yourself.'}
          </p>
        </div>
      )}
    </Modal>
  )
}

/** The "Attach document" tile: drag the PDF into the WhatsApp chat, show it in the folder, mark as sent. */
export function AttachTile({ item, onDone, compact }: { item: OutboxItem; onDone?: () => void; compact?: boolean }): JSX.Element {
  const [busy, setBusy] = useState(false)
  const mark = async (): Promise<void> => {
    setBusy(true)
    try {
      await api('whatsapp.markSent', { logId: item.logId })
      toast.ok('Marked as sent in the WhatsApp log.')
      onDone?.()
    } catch (e) {
      toast.error(e)
    } finally {
      setBusy(false)
    }
  }
  const fail = async (): Promise<void> => {
    const reason = await promptDialog({ title: 'Could not send', input: { label: 'What went wrong?', placeholder: 'e.g. number not on WhatsApp', required: true }, confirmLabel: 'Save' })
    if (!reason) return
    try {
      await api('whatsapp.markFailed', { logId: item.logId, reason })
      toast.info('Saved as failed in the WhatsApp log.')
      onDone?.()
    } catch (e) {
      toast.error(e)
    }
  }
  return (
    <div className="rounded-xl border border-[#25D366]/50 bg-[#25D366]/5 p-3" data-testid="wa-attach">
      <div className="text-[12px] font-semibold tracking-wide text-muted uppercase">Attach document</div>
      <div
        draggable
        onDragStart={(e) => {
          e.preventDefault()
          window.dt.startDrag(item.token)
        }}
        title="Drag me into the WhatsApp chat"
        className="mt-2 flex cursor-grab items-center gap-2 rounded-lg border border-line bg-surface px-3 py-2 shadow-sm active:cursor-grabbing"
      >
        <GripVertical className="h-4 w-4 shrink-0 text-muted" />
        <FileText className="h-6 w-6 shrink-0 text-bad" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-medium">{item.fileName}</div>
          <div className="text-[12px] text-muted">
            {formatSize(item.size)}, to +{item.phone}
          </div>
        </div>
      </div>
      <p className="mt-2 text-[12.5px] font-medium">Drag the PDF into the chat, then press Send in WhatsApp.</p>
      <div className={compact ? 'mt-2 grid gap-1.5' : 'mt-2 flex flex-wrap gap-2'}>
        <Button size="sm" icon={<FolderOpen className="h-4 w-4" />} onClick={() => api('whatsapp.showInFolder', { token: item.token }).catch(toast.error)}>
          Show in folder
        </Button>
        <Button size="sm" variant="success" loading={busy} icon={<CheckCheck className="h-4 w-4" />} onClick={mark}>
          Mark as sent
        </Button>
        <Button size="sm" variant="ghost" icon={<X className="h-4 w-4" />} onClick={fail}>
          Could not send
        </Button>
      </div>
    </div>
  )
}
