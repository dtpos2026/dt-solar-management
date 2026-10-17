/** Settings section — Support messages to Digital Target with offline queue (owner: cloud area). */
import { useCallback, useEffect, useRef, useState } from 'react'
import { Eraser, MessageCircle, RefreshCw, RotateCcw, Send, Trash2, WifiOff } from 'lucide-react'
import { api } from '../../api'
import { Badge, Button, Card, Empty, Loading, Textarea, confirmDialog, cx, toast } from '../../components/ui'

interface Msg {
  id: number
  uid: string
  direction: 'out' | 'in'
  body: string
  author: string | null
  status: 'queued' | 'sending' | 'sent' | 'failed' | 'received'
  error: string | null
  attempts: number
  created_at: string
  sent_at: string | null
  remote_at: string | null
  read_at: string | null
}
interface Overview {
  online: boolean
  background: boolean
  messages: Msg[]
  counts: { unread: number; queued: number; failed: number; sending: number; total: number }
  sync: { lastSyncAt: string | null; lastOkAt: string | null; ok: boolean | null; offline: boolean; error: string | null; warning: string | null; syncing: boolean }
}

const SYNC_OPEN_MS = 2 * 60_000
const MAX = 4000
const STATUS: Record<Msg['status'], { label: string; tone: string }> = {
  queued: { label: 'Queued', tone: 'muted' },
  sending: { label: 'Sending', tone: 'info' },
  sent: { label: 'Sent', tone: 'ok' },
  failed: { label: 'Failed', tone: 'bad' },
  received: { label: 'Received', tone: 'brand' }
}
const when = (iso: string | null | undefined): string => (iso ? new Date(iso).toLocaleString() : '')

export function SupportSection(): JSX.Element {
  const [ov, setOv] = useState<Overview | null>(null)
  const [text, setText] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const bottom = useRef<HTMLDivElement>(null)

  const refresh = useCallback(async (): Promise<void> => {
    try {
      setOv(await api<Overview>('support.overview'))
    } catch (e) {
      toast.error(e)
    }
  }, [])

  const sync = useCallback(async (manual = false): Promise<void> => {
    if (manual) setBusy('sync')
    try {
      const r = await api<{ overview: Overview }>('support.sync')
      setOv(r.overview)
      if (r.overview.counts.unread > 0) {
        await api('support.markRead').catch(() => undefined)
        setOv(await api<Overview>('support.overview'))
      }
    } catch (e) {
      if (manual) toast.error(e)
    } finally {
      if (manual) setBusy(null)
    }
  }, [])

  useEffect(() => {
    void refresh().then(() => sync())
    const t = setInterval(() => void sync(), SYNC_OPEN_MS)
    // Short refresh while something is on its way so statuses (Queued → Sending → Sent) stay current.
    const r = setInterval(() => void refresh(), 5000)
    return () => {
      clearInterval(t)
      clearInterval(r)
    }
  }, [refresh, sync])

  const count = ov?.messages.length ?? 0
  useEffect(() => {
    bottom.current?.scrollIntoView({ block: 'end' })
  }, [count])

  if (!ov) return <Loading label="Loading messages…" />

  const send = async (): Promise<void> => {
    const body = text.trim()
    if (!body) return
    setBusy('send')
    try {
      await api('support.send', { body })
      setText('')
      await refresh()
    } catch (e) {
      toast.error(e)
    } finally {
      setBusy(null)
    }
  }
  const retry = async (uid: string): Promise<void> => {
    try {
      await api('support.retry', { uid })
      await refresh()
    } catch (e) {
      toast.error(e)
    }
  }

  const clear = async (mode: 'messages' | 'conversation'): Promise<void> => {
    const del = mode === 'conversation'
    const ok = await confirmDialog({
      title: del ? 'Delete this conversation?' : 'Clear the messages?',
      danger: true,
      confirmLabel: del ? 'Delete conversation' : 'Clear messages',
      message: del
        ? 'The whole conversation with Digital Target support is removed from this computer, including messages that are still waiting to be sent. Digital Target keeps its own copy. You can write to support again at any time.'
        : 'All messages are removed from this computer. Messages that are still waiting to be sent stay in the list. Digital Target keeps its own copy of the conversation.'
    })
    if (!ok) return
    setBusy(mode)
    try {
      const r = await api<{ removed: number; overview: Overview }>('support.clear', { mode })
      setOv(r.overview)
      toast.ok(del ? 'Conversation deleted.' : `${r.removed} message${r.removed === 1 ? '' : 's'} cleared.`)
    } catch (e) {
      toast.error(e)
    } finally {
      setBusy(null)
    }
  }

  const s = ov.sync
  return (
    <Card
      title={<span className="inline-flex items-center gap-2"><MessageCircle className="h-4 w-4 text-brand" /> Messages with Digital Target support</span>}
      actions={
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" icon={<Eraser className="h-4 w-4" />} loading={busy === 'messages'} disabled={!!busy || ov.messages.length === 0} onClick={() => clear('messages')}>
            Clear chat
          </Button>
          <Button size="sm" variant="ghost" className="text-bad" icon={<Trash2 className="h-4 w-4" />} loading={busy === 'conversation'} disabled={!!busy || ov.messages.length === 0} onClick={() => clear('conversation')}>
            Delete chat
          </Button>
          <Button size="sm" icon={<RefreshCw className="h-4 w-4" />} loading={busy === 'sync' || s.syncing} disabled={!!busy} onClick={() => sync(true)}>
            Check for replies
          </Button>
        </div>
      }
    >
      <div className="mb-3 flex flex-wrap items-center gap-2 text-[12.5px] text-muted">
        {ov.online ? <Badge tone="ok">Online</Badge> : <Badge tone="muted"><WifiOff className="mr-1 inline h-3 w-3" />Offline</Badge>}
        <span>Last checked: {when(s.lastOkAt) || 'never'}</span>
        {ov.counts.queued > 0 && <span>· {ov.counts.queued} waiting to be sent</span>}
        {s.error && !s.offline && <span className="text-bad">· {s.error}</span>}
        {s.warning && <span className="text-warn">· {s.warning}</span>}
      </div>
      <p className="mb-3 text-[12.5px] text-muted">
        Messages are saved on this computer first and are sent automatically when you are online — nothing is lost while offline. Replies are checked every 2 minutes while this page is open
        {ov.background ? ' and every 15 minutes in the background' : ''}.
      </p>

      <div className="max-h-[52vh] min-h-[200px] space-y-2 overflow-y-auto rounded-xl border border-line bg-surface-2 p-3">
        {ov.messages.length === 0 ? (
          <Empty icon={<MessageCircle />} title="No messages yet">Write your question below — Digital Target replies here.</Empty>
        ) : (
          ov.messages.map((m) => {
            const out = m.direction === 'out'
            const st = STATUS[m.status]
            return (
              <div key={m.uid} className={cx('flex', out ? 'justify-end' : 'justify-start')}>
                <div className={cx('max-w-[78%] rounded-2xl px-3 py-2 text-[13.5px] shadow-sm', out ? 'bg-brand-soft' : 'border border-line bg-surface')}>
                  <div className="mb-0.5 text-[12px] font-semibold text-muted">{out ? m.author || 'You' : 'Digital Target'}</div>
                  <div className="break-words whitespace-pre-wrap">{m.body}</div>
                  <div className="mt-1 flex flex-wrap items-center justify-end gap-2 text-[12px] text-muted">
                    <span>{when(m.remote_at || m.sent_at || m.created_at)}</span>
                    {out && <Badge tone={st.tone}>{st.label}</Badge>}
                    {out && m.status === 'failed' && (
                      <button type="button" className="inline-flex cursor-pointer items-center gap-1 text-brand hover:underline" onClick={() => retry(m.uid)}>
                        <RotateCcw className="h-3 w-3" /> Retry
                      </button>
                    )}
                  </div>
                  {out && m.error && m.status !== 'sent' && <div className="mt-0.5 text-right text-[12px] text-muted">{m.error}</div>}
                </div>
              </div>
            )
          })
        )}
        <div ref={bottom} />
      </div>

      <div className="mt-3 flex items-end gap-2">
        <Textarea
          rows={3}
          className="flex-1"
          maxLength={MAX}
          placeholder="Type your message to Digital Target…"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void send()
          }}
        />
        <Button variant="primary" icon={<Send className="h-4 w-4" />} loading={busy === 'send'} disabled={!text.trim() || !!busy} onClick={send}>
          Send
        </Button>
      </div>
      <div className="mt-1 text-right text-[12px] text-muted">
        {text.length}/{MAX} · Ctrl+Enter to send
      </div>
    </Card>
  )
}
