/**
 * WhatsApp module (owner: assist area): the real WhatsApp Web inside the app. The main process paints a WebContentsView
 * exactly over the placeholder below; this page reports its bounds and hides the view whenever an app overlay
 * (modal, dropdown, toast, lock screen) is open, because the view paints above the page.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { AlertTriangle, CheckCircle2, Loader2, LogOut, MessageCircle, RefreshCw, Send, Settings as SettingsIcon } from 'lucide-react'
import { api } from '../../api'
import { useApp, useCan } from '../../store'
import { Badge, Button, Input, Toggle, confirmDialog, toast } from '../../components/ui'
import { AttachTile, OutboxItem, looksLikePhone } from '../../components/WhatsAppButton'

interface WaStatus {
  state: 'idle' | 'loading' | 'ready' | 'failed'
  error: string | null
  started: boolean
  visible: boolean
  url: string | null
  testMode: boolean
  current: OutboxItem | null
}

function overlayOpen(): boolean {
  return !!document.querySelector('[data-overlay]')
}

export function WhatsAppPage(): JSX.Element {
  const nav = useNavigate()
  const loc = useLocation()
  const can = useCan()
  const { locked, settings } = useApp()
  const holder = useRef<HTMLDivElement>(null)
  const last = useRef<string>('')
  const raf = useRef<number>(0)
  const [st, setSt] = useState<WaStatus | null>(null)
  const [phone, setPhone] = useState('')
  const [text, setText] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const lockedRef = useRef(locked)
  lockedRef.current = locked

  /** Shows the view over the placeholder, or hides it when something is drawn above the page. */
  const sync = useCallback(() => {
    cancelAnimationFrame(raf.current)
    raf.current = requestAnimationFrame(() => {
      const el = holder.current
      const hide = !el || lockedRef.current || overlayOpen() || document.visibilityState === 'hidden'
      if (hide) {
        if (last.current !== 'hidden') {
          last.current = 'hidden'
          api('whatsapp.hide').catch(() => undefined)
        }
        return
      }
      const r = el!.getBoundingClientRect()
      const b = { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) }
      const key = `${b.x},${b.y},${b.width},${b.height}`
      if (key === last.current) return
      last.current = key
      api('whatsapp.show', b).catch(() => undefined)
    })
  }, [])

  useEffect(() => {
    sync()
    const ro = new ResizeObserver(sync)
    if (holder.current) ro.observe(holder.current)
    const mo = new MutationObserver(sync)
    mo.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-overlay', 'class', 'style'] })
    window.addEventListener('resize', sync)
    window.addEventListener('scroll', sync, true)
    document.addEventListener('visibilitychange', sync)
    return () => {
      ro.disconnect()
      mo.disconnect()
      window.removeEventListener('resize', sync)
      window.removeEventListener('scroll', sync, true)
      document.removeEventListener('visibilitychange', sync)
      cancelAnimationFrame(raf.current)
      last.current = ''
      api('whatsapp.hide').catch(() => undefined)
    }
  }, [sync])

  useEffect(() => {
    last.current = ''
    sync()
  }, [locked, sync])

  const refresh = useCallback(() => {
    api<WaStatus>('whatsapp.status')
      .then(setSt)
      .catch(() => undefined)
  }, [])

  useEffect(() => {
    refresh()
    const t = setInterval(refresh, 1500)
    return () => clearInterval(t)
  }, [refresh])

  // Coming from "Send on WhatsApp": open the prepared chat once.
  const openLogId = (loc.state as { openLogId?: number } | null)?.openLogId
  useEffect(() => {
    if (!openLogId) return
    nav('/whatsapp', { replace: true, state: null })
    api<OutboxItem>('whatsapp.openCurrent', { logId: openLogId })
      .then(() => refresh())
      .catch(toast.error)
  }, [openLogId]) // eslint-disable-line react-hooks/exhaustive-deps

  const reload = async (): Promise<void> => {
    setBusy('reload')
    try {
      await api('whatsapp.reload')
      refresh()
    } catch (e) {
      toast.error(e)
    } finally {
      setBusy(null)
    }
  }

  const openChat = async (): Promise<void> => {
    setBusy('chat')
    try {
      await api('whatsapp.openChat', { phone, text })
      setText('')
      refresh()
    } catch (e) {
      toast.error(e)
    } finally {
      setBusy(null)
    }
  }

  const unlink = async (): Promise<void> => {
    const ok = await confirmDialog({
      title: 'Unlink WhatsApp from this computer?',
      message: 'WhatsApp Web will be logged out here and a new QR code will appear. To remove it completely, also open WhatsApp on your phone → Linked devices and log out this device.',
      confirmLabel: 'Unlink / log out',
      danger: true
    })
    if (!ok) return
    setBusy('unlink')
    try {
      await api('whatsapp.unlink')
      toast.ok('WhatsApp was logged out on this computer.')
      refresh()
    } catch (e) {
      toast.error(e)
    } finally {
      setBusy(null)
    }
  }

  const setNotifications = async (v: boolean): Promise<void> => {
    try {
      const s = await api<Record<string, unknown>>('settings.update', { patch: { whatsapp_notifications: v } })
      useApp.setState({ settings: s })
    } catch (e) {
      toast.error(e)
    }
  }

  const state = st?.state ?? 'loading'
  const badge =
    state === 'ready' ? (
      <Badge tone="ok">
        <CheckCircle2 className="mr-1 h-3.5 w-3.5" /> Ready
      </Badge>
    ) : state === 'failed' ? (
      <Badge tone="bad">
        <AlertTriangle className="mr-1 h-3.5 w-3.5" /> Could not load
      </Badge>
    ) : (
      <Badge tone="info">
        <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> Loading
      </Badge>
    )

  return (
    <div className="flex flex-col gap-3">
      <div className="card flex flex-wrap items-center gap-2 px-3 py-2">
        <MessageCircle className="h-5 w-5 text-[#25D366]" />
        <div className="text-[15px] font-semibold">WhatsApp</div>
        {badge}
        {st?.testMode && <Badge tone="warn">Test page</Badge>}
        {state === 'failed' && (
          <span className="max-w-[320px] truncate text-[12px] text-bad" title={st?.error ?? ''}>
            {st?.error} — check the internet and press Reload.
          </span>
        )}
        <div className="ms-auto flex flex-wrap items-center gap-2">
          <Input sm className="w-40" placeholder="Phone e.g. 0300 1234567" value={phone} onChange={(e) => setPhone(e.target.value)} inputMode="tel" aria-label="Phone number" />
          <Input sm className="w-48" placeholder="Message (optional)" value={text} onChange={(e) => setText(e.target.value)} aria-label="Message" onKeyDown={(e) => e.key === 'Enter' && looksLikePhone(phone) && openChat()} />
          <Button size="sm" icon={<Send className="h-4 w-4" />} disabled={!looksLikePhone(phone)} loading={busy === 'chat'} onClick={openChat}>
            Open chat
          </Button>
          <Button size="sm" icon={<RefreshCw className="h-4 w-4" />} loading={busy === 'reload'} onClick={reload}>
            {state === 'failed' ? 'Retry' : 'Reload'}
          </Button>
          <Button size="sm" variant="ghost" icon={<LogOut className="h-4 w-4" />} loading={busy === 'unlink'} onClick={unlink}>
            Unlink / log out
          </Button>
        </div>
      </div>

      <div className="flex min-h-0 gap-3">
        <div className="min-w-0 flex-1">
          <div ref={holder} className="relative h-[calc(100vh-150px)] min-h-[440px] overflow-hidden rounded-xl border border-line bg-white" data-testid="wa-holder">
            {/* Shown only while the WhatsApp view is hidden (e.g. a dialog is open) or still starting. */}
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-center text-[13px] text-neutral-500">
              {state === 'failed' ? <AlertTriangle className="h-8 w-8 text-bad" /> : <Loader2 className="h-8 w-8 animate-spin text-[#25D366]" />}
              <div>{state === 'failed' ? 'WhatsApp Web could not load. Check the internet and press Retry.' : 'Opening WhatsApp Web…'}</div>
            </div>
          </div>
        </div>
        <aside className="hidden w-[270px] shrink-0 flex-col gap-3 lg:flex">
          {st?.current ? (
            <AttachTile item={st.current} compact onDone={refresh} />
          ) : (
            <div className="card p-3 text-[12.5px] text-muted">
              <div className="mb-1 font-semibold text-ink">Send a document</div>
              Open an invoice, quotation, customer statement or project and click <b>Send on WhatsApp</b>. The PDF will appear here to drag into the chat.
            </div>
          )}
          <div className="card space-y-2 p-3 text-[12.5px] text-muted">
            <div className="font-semibold text-ink">Link your phone (first time)</div>
            <ol className="list-decimal space-y-1 ps-4">
              <li>On your phone open WhatsApp → Settings (or ⋮) → Linked devices.</li>
              <li>Tap “Link a device” and scan the QR code shown here.</li>
              <li>It stays linked while you use this computer. Messages are only sent when you press Send in WhatsApp.</li>
            </ol>
          </div>
          {can('settings.manage') && (
            <div className="card space-y-2 p-3">
              <Toggle checked={settings.whatsapp_notifications === true} onChange={setNotifications} label="Desktop notifications" description="Allow WhatsApp to show new-message notifications." />
              <Button size="sm" variant="ghost" className="w-full" icon={<SettingsIcon className="h-4 w-4" />} onClick={() => nav('/settings?tab=whatsapp')}>
                WhatsApp settings & send log
              </Button>
            </div>
          )}
          {settings.whatsapp_mode === 'chat_link' && (
            <div className="rounded-lg border border-warn/40 bg-warn/10 p-3 text-[12px]">
              Chat link mode is on: “Send on WhatsApp” opens chats in your WhatsApp app instead of this screen. Change it in Settings → WhatsApp.
            </div>
          )}
        </aside>
      </div>
    </div>
  )
}
