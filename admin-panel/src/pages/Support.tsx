/** Support — live customer conversations from the desktop app (supportThreads/{installToken} + messages). */
import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { getDoc, onSnapshot, orderBy, query } from 'firebase/firestore'
import { Building2, KeyRound, LifeBuoy, MessageSquare, Monitor, Phone, Send } from 'lucide-react'
import { PageTitle } from '../components/ui'
import { EmptyState, Loading, NoAccess, Notice, SearchBox } from '../components/kit'
import { markThreadRead, messageFromSnap, messagesCol, replyToThread, setThreadStatus, threadFromSnap, threadsCol } from '../lib/support'
import { licenseRef } from '../lib/licenses'
import { errorMessage, fmtDateTime, timeAgo, toDate } from '../lib/format'
import { useAdmin, useAdminEmail, useCan } from '../lib/auth'
import { cx } from '../components/ui'
import type { SupportMessage, SupportThread } from '../lib/types'

const STATUS_TONE: Record<SupportThread['status'], string> = {
  open: 'bg-amber-100 text-amber-800',
  pending: 'bg-sky-100 text-sky-700',
  resolved: 'bg-green-100 text-green-700'
}
const STATUSES: SupportThread['status'][] = ['open', 'pending', 'resolved']

function StatusTag({ s }: { s: SupportThread['status'] }) {
  return <span className={cx('rounded-md px-1.5 py-0.5 text-[11px] font-bold capitalize', STATUS_TONE[s])}>{s}</span>
}

export function Support() {
  const can = useCan()
  const { id } = useParams()
  const nav = useNavigate()
  const [threads, setThreads] = useState<SupportThread[]>([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [q, setQ] = useState('')
  const [status, setStatus] = useState('')
  const allowed = can('support.manage')

  useEffect(() => {
    if (!allowed) return
    return onSnapshot(threadsCol(), (r) => { setThreads(r.docs.map(threadFromSnap)); setLoading(false) }, (e) => { setErr(errorMessage(e)); setLoading(false) })
  }, [allowed])

  const list = useMemo(() => {
    const s = q.trim().toLowerCase()
    return threads
      .filter((t) => (!status || t.status === status) && (!s || `${t.companyName} ${t.contactName} ${t.phone} ${t.deviceId}`.toLowerCase().includes(s)))
      .sort((a, b) => Number(b.unreadByAdmin) - Number(a.unreadByAdmin) || (toDate(b.lastMessageAt)?.getTime() ?? 0) - (toDate(a.lastMessageAt)?.getTime() ?? 0))
  }, [threads, q, status])

  if (!allowed) return <NoAccess what="Support" need="Manage support" />
  const unread = threads.filter((t) => t.unreadByAdmin).length
  const current = threads.find((t) => t.id === id)

  return (
    <div>
      <PageTitle title="Support" sub={loading ? 'Loading…' : `${threads.length} conversation(s) · ${unread} unread · ${threads.filter((t) => t.status === 'open').length} open`} />
      {err && <Notice tone="error" className="mb-3">{err}</Notice>}
      <div className="grid h-[calc(100vh-170px)] min-h-[520px] grid-cols-[360px_minmax(0,1fr)] gap-4">
        <div className="card flex min-h-0 flex-col">
          <div className="space-y-2 border-b border-[#ece6f4] p-3">
            <SearchBox value={q} onChange={setQ} placeholder="Search company, contact, phone, device…" />
            <div className="flex gap-1">
              {['', ...STATUSES].map((s) => (
                <button key={s || 'all'} className={cx('btn btn-sm flex-1 capitalize', status === s ? 'btn-primary' : 'btn-secondary')} onClick={() => setStatus(s)}>{s || 'All'}</button>
              ))}
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {loading ? <Loading /> : list.length === 0 ? (
              <EmptyState icon={<LifeBuoy />} title={threads.length ? 'No conversation matches' : 'No support conversations yet'} hint={threads.length ? undefined : 'Messages sent from the desktop app’s Support page appear here live.'} />
            ) : list.map((t) => (
              <button key={t.id} onClick={() => nav(`/support/${t.id}`)} className={cx('block w-full border-b border-[#f1ecf7] px-3.5 py-3 text-left hover:bg-[#faf7fd]', t.id === id && 'bg-[#f3ebfc]')}>
                <div className="flex items-center justify-between gap-2">
                  <span className={cx('truncate text-[13.5px]', t.unreadByAdmin ? 'font-extrabold' : 'font-semibold')}>{t.companyName || t.contactName || 'Unknown customer'}</span>
                  <span className="shrink-0 text-[11px] text-[#7a6d92]">{t.lastMessageAt ? timeAgo(t.lastMessageAt) : ''}</span>
                </div>
                <div className="mt-0.5 flex items-center gap-2">
                  {t.unreadByAdmin && <span className="h-2 w-2 shrink-0 rounded-full bg-fuchsia-600" aria-label="unread" />}
                  <span className={cx('truncate text-[12.5px]', t.unreadByAdmin ? 'text-[#1d1530]' : 'text-[#7a6d92]')}>{t.lastMessageFrom === 'admin' ? 'You: ' : ''}{t.lastMessagePreview || '—'}</span>
                </div>
                <div className="mt-1 flex items-center gap-2 text-[11px] text-[#7a6d92]"><StatusTag s={t.status} />{t.phone && <span>{t.phone}</span>}</div>
              </button>
            ))}
          </div>
        </div>
        {current ? <Conversation key={current.id} t={current} /> : (
          <div className="card grid place-items-center"><EmptyState icon={<MessageSquare />} title={id && !loading ? 'Conversation not found' : 'Select a conversation'} hint="Pick a customer on the left to read and reply." /></div>
        )}
      </div>
    </div>
  )
}

function Conversation({ t }: { t: SupportThread }) {
  const can = useCan()
  const admin = useAdmin()
  const by = useAdminEmail()
  const [messages, setMessages] = useState<SupportMessage[] | null>(null)
  const [body, setBody] = useState('')
  const [after, setAfter] = useState<SupportThread['status']>('pending')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [clientId, setClientId] = useState('')
  const endRef = useRef<HTMLDivElement>(null)

  useEffect(() => onSnapshot(query(messagesCol(t.id), orderBy('at', 'asc')), (r) => setMessages(r.docs.map(messageFromSnap)), (e) => { setErr(errorMessage(e)); setMessages([]) }), [t.id])
  useEffect(() => { endRef.current?.scrollIntoView({ block: 'end' }) }, [messages])
  useEffect(() => { if (t.unreadByAdmin) markThreadRead(t).catch(() => undefined) }, [t])
  useEffect(() => {
    setClientId('')
    if (!t.licenseId || !(can('licenses.view') || can('clients.view'))) return
    getDoc(licenseRef(t.licenseId)).then((s) => setClientId(typeof s.data()?.clientId === 'string' ? s.data()!.clientId : '')).catch(() => undefined)
  }, [t.licenseId, can])

  const send = async () => {
    setErr(null); setBusy(true)
    try { await replyToThread(t, body, admin?.name || 'Digital Target Support', after, by); setBody('') } catch (e) { setErr(errorMessage(e)) } finally { setBusy(false) }
  }
  const changeStatus = async (s: SupportThread['status']) => {
    if (s === t.status) return
    setErr(null)
    try { await setThreadStatus(t, s, by) } catch (e) { setErr(errorMessage(e)) }
  }

  return (
    <div className="card flex min-h-0 flex-col">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-[#ece6f4] px-4 py-3">
        <div className="min-w-0">
          <div className="text-[16px] font-bold">{t.companyName || 'Unknown customer'}</div>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-[#7a6d92]">
            {t.contactName && <span>{t.contactName}</span>}
            {t.phone && <span className="flex items-center gap-1"><Phone className="h-3.5 w-3.5" />{t.phone}</span>}
            <span className="flex items-center gap-1 font-mono" title="Device id"><Monitor className="h-3.5 w-3.5" />{can('devices.view') ? <Link className="hover:underline" to="/devices">{t.deviceId}</Link> : t.deviceId}</span>
            {t.licenseId && (can('licenses.view') ? <Link className="flex items-center gap-1 text-[#3d096d] hover:underline" to={`/licenses/${t.licenseId}`}><KeyRound className="h-3.5 w-3.5" />License</Link> : <span className="flex items-center gap-1"><KeyRound className="h-3.5 w-3.5" />Licensed</span>)}
            {clientId && can('clients.view') && <Link className="flex items-center gap-1 text-[#3d096d] hover:underline" to={`/clients/${clientId}`}><Building2 className="h-3.5 w-3.5" />Client</Link>}
            <span>Started {fmtDateTime(t.createdAt)}</span>
          </div>
        </div>
        <label className="flex items-center gap-2 text-[12.5px] font-semibold text-[#6b5d85]">Status
          <select className="input h-8 w-auto py-0" value={t.status} onChange={(e) => changeStatus(e.target.value as SupportThread['status'])}>
            {STATUSES.map((s) => <option key={s} value={s}>{s[0].toUpperCase() + s.slice(1)}</option>)}
          </select>
        </label>
      </div>
      <div className="min-h-0 flex-1 space-y-2.5 overflow-y-auto bg-[#faf8fd] px-4 py-4">
        {messages === null ? <Loading /> : messages.length === 0 ? <div className="py-10 text-center text-[13px] text-[#7a6d92]">No messages yet.</div> : messages.map((m) => (
          <div key={m.id} className={cx('flex', m.from === 'admin' ? 'justify-end' : 'justify-start')}>
            <div className={cx('max-w-[72%] rounded-2xl px-3.5 py-2 text-[13.5px] shadow-sm', m.from === 'admin' ? 'rounded-br-md bg-gradient-to-br from-[#5b10a0] to-[#3d096d] text-white' : 'rounded-bl-md border border-[#ece6f4] bg-white')}>
              <div className="whitespace-pre-wrap break-words">{m.body}</div>
              <div className={cx('mt-1 text-[10.5px]', m.from === 'admin' ? 'text-white/70' : 'text-[#7a6d92]')}>{m.authorName || (m.from === 'admin' ? 'Digital Target' : 'Customer')} · {m.at ? fmtDateTime(m.at) : 'sending…'}</div>
            </div>
          </div>
        ))}
        <div ref={endRef} />
      </div>
      <div className="border-t border-[#ece6f4] p-3">
        {err && <Notice tone="error" className="mb-2" onClose={() => setErr(null)}>{err}</Notice>}
        <textarea className="input" rows={3} maxLength={4000} placeholder="Type a reply… (Ctrl+Enter to send)" value={body} onChange={(e) => setBody(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && body.trim() && !busy) send() }} />
        <div className="mt-2 flex items-center justify-between gap-2">
          <span className="text-[11.5px] text-[#7a6d92]">{body.length}/4000</span>
          <div className="flex items-center gap-2">
            <label className="flex items-center gap-1.5 text-[12.5px] text-[#6b5d85]">After sending
              <select className="input h-8 w-auto py-0" value={after} onChange={(e) => setAfter(e.target.value as SupportThread['status'])}>
                {STATUSES.map((s) => <option key={s} value={s}>mark {s}</option>)}
              </select>
            </label>
            <button className="btn btn-primary" disabled={busy || !body.trim()} onClick={send}><Send className="h-4 w-4" /> {busy ? 'Sending…' : 'Send reply'}</button>
          </div>
        </div>
      </div>
    </div>
  )
}
