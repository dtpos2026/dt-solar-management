/** Verify Key — check a DT Solar Pro license key (Module 4). */
import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { doc, getDoc, getDocs, limit, query, where, collection } from 'firebase/firestore'
import { BadgeCheck, CircleAlert, Clock3, KeyRound, Loader2, SearchCheck, ShieldX, Timer } from 'lucide-react'
import { db } from '../firebase'
import { Badge, PageTitle, cx } from '../components/ui'
import { NoAccess, Notice } from '../components/kit'
import { findLicenseByKey } from '../lib/licenses'
import { logActivitySafe } from '../lib/audit'
import { useCan } from '../lib/auth'
import { fmtDate, fmtDateTime, daysUntil, errorMessage } from '../lib/format'
import { checkKeyFormat, deriveVerdict, isoToMs, KEY_PLACEHOLDER, latestOf, maskKey, rateLimit, verdictInfo, VERIFY_LIMIT, type KeyVerdict, type VerdictInfo } from '../lib/verify'
import type { License } from '../lib/types'

const HISTORY_KEY = 'dtsp-admin.verifyLookups'

function readHistory(): number[] {
  try {
    const v = JSON.parse(sessionStorage.getItem(HISTORY_KEY) ?? '[]')
    return Array.isArray(v) ? v.filter((x) => typeof x === 'number') : []
  } catch {
    return []
  }
}
function writeHistory(h: number[]) {
  try {
    sessionStorage.setItem(HISTORY_KEY, JSON.stringify(h))
  } catch {
    /* in-memory only */
  }
}

interface Usage {
  installations: number
  lastCheckMs: number | null
  lastSeenMs: number | null
}

interface Result {
  key: string
  info: VerdictInfo
  license: License | null
  client: { company: string; code: string } | null
  usage: Usage | null
  usageNote: string | null
  at: number
}

export function VerifyKey() {
  const can = useCan()
  const allowed = can('verify.use') || can('licenses.view')
  const showCustomer = can('licenses.view') || can('clients.view')
  const canHeartbeats = can('devices.view') || can('devices.manage') || can('licenses.view')
  const [input, setInput] = useState('')
  const [touched, setTouched] = useState(false)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<Result | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [recent, setRecent] = useState<{ at: number; key: string; verdict: KeyVerdict }[]>([])
  const [history, setHistory] = useState<number[]>(readHistory)
  const [now, setNow] = useState(Date.now())
  const blockedLogged = useRef(0)
  const inputRef = useRef<HTMLInputElement>(null)

  const fmt = checkKeyFormat(input)
  const decision = useMemo(() => rateLimit(history, now), [history, now])
  const cooling = !decision.allowed

  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(t)
  }, [])

  if (!allowed) return <NoAccess what="Verify Key" need="Verify license keys" />

  const record = (key: string, verdict: KeyVerdict) => setRecent((r) => [{ at: Date.now(), key, verdict }, ...r].slice(0, 10))

  const verify = async (e?: FormEvent) => {
    e?.preventDefault()
    setTouched(true)
    setError(null)
    const f = checkKeyFormat(input)
    if (!f.ok) {
      setResult({ key: f.key, info: verdictInfo('invalid_format'), license: null, client: null, usage: null, usageNote: null, at: Date.now() })
      record(f.key || '(empty)', 'invalid_format')
      logActivitySafe({ action: 'key_verify', category: 'license', status: 'failure', target: maskKey(f.key), targetType: 'license_key', details: `Invalid key format: ${f.error}` })
      return
    }
    const d = rateLimit(readHistory(), Date.now())
    if (!d.allowed) {
      setHistory(d.history)
      if (Date.now() - blockedLogged.current > 60_000) {
        blockedLogged.current = Date.now()
        logActivitySafe({ action: 'key_verify_rate_limited', category: 'security', status: 'failure', target: maskKey(f.key), targetType: 'license_key', details: `More than ${VERIFY_LIMIT} lookups in one minute (browser throttle)` })
      }
      return
    }
    writeHistory(d.history)
    setHistory(d.history)
    setBusy(true)
    try {
      const lic = await findLicenseByKey(f.key)
      if (!lic) {
        setResult({ key: f.key, info: verdictInfo('not_found'), license: null, client: null, usage: null, usageNote: null, at: Date.now() })
        record(f.key, 'not_found')
        logActivitySafe({ action: 'key_verify', category: 'license', status: 'failure', target: maskKey(f.key), targetType: 'license_key', details: `${maskKey(f.key)} → not found` })
        return
      }
      const nowMs = Date.now()
      const verdict = deriveVerdict(
        {
          status: lic.status,
          expiresAtMs: lic.expiresAt ? lic.expiresAt.toMillis() : null,
          activeDevices: lic.activeDevices,
          activatedAtMs: lic.activatedAt ? lic.activatedAt.toMillis() : null,
          lastVerifiedAtMs: lic.lastVerifiedAt ? lic.lastVerifiedAt.toMillis() : null,
          detached: lic.detached
        },
        nowMs
      )
      let usage: Usage | null = null
      let usageNote: string | null = null
      if (canHeartbeats) {
        try {
          const hb = await getDocs(query(collection(db, 'heartbeats'), where('licenseId', '==', lic.id), limit(200)))
          const checks = hb.docs.map((x) => isoToMs(x.data().lastCheckAt))
          const seen = hb.docs.map((x) => {
            const v = x.data().lastSeen
            return v && typeof v.toMillis === 'function' ? (v.toMillis() as number) : null
          })
          usage = { installations: hb.size, lastCheckMs: latestOf(...checks), lastSeenMs: latestOf(...seen) }
        } catch (err) {
          usageNote = `Heartbeats could not be read: ${errorMessage(err)}`
        }
      } else usageNote = 'Installation heartbeats need the “View devices” or “View licenses” permission.'
      let client: Result['client'] = null
      if (lic.clientId && can('clients.view')) {
        const c = await getDoc(doc(db, 'clients', lic.clientId)).catch(() => null)
        if (c?.exists()) client = { company: String(c.data().company ?? ''), code: String(c.data().code ?? '') }
      }
      const info = verdictInfo(verdict)
      setResult({ key: f.key, info, license: lic, client, usage, usageNote, at: nowMs })
      record(f.key, verdict)
      logActivitySafe({
        action: 'key_verify',
        category: 'license',
        status: 'success',
        licenseId: lic.id,
        target: maskKey(f.key),
        targetType: 'license_key',
        details: `${maskKey(f.key)} → ${info.label}`,
        meta: { verdict }
      })
    } catch (err) {
      setError(errorMessage(err))
      logActivitySafe({ action: 'key_verify', category: 'license', status: 'failure', target: maskKey(f.key), targetType: 'license_key', details: `Lookup failed: ${errorMessage(err)}` })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="max-w-5xl">
      <PageTitle title="Verify Key" sub="Check whether a DT Solar Pro license key is genuine and what it allows." />

      <form className="card p-5" onSubmit={verify} noValidate>
        <label className="label" htmlFor="verify-key">License key</label>
        <div className="flex flex-wrap gap-2">
          <div className="relative min-w-[320px] flex-1">
            <KeyRound className="pointer-events-none absolute top-2.5 left-3 h-4 w-4 text-[#7a6d92]" />
            <input
              id="verify-key"
              ref={inputRef}
              className={cx('input pl-9 font-mono text-[15px] tracking-wider uppercase', touched && input && !fmt.ok && 'border-red-400')}
              placeholder={KEY_PLACEHOLDER}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onBlur={() => input && setTouched(true)}
              autoComplete="off"
              spellCheck={false}
              maxLength={64}
              autoFocus
            />
          </div>
          <button className="btn btn-primary h-[38px]" disabled={busy || cooling}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <SearchCheck className="h-4 w-4" />}Verify
          </button>
        </div>
        <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-[12px]">
          <span className={cx(touched && input && !fmt.ok ? 'font-medium text-red-600' : 'text-[#7a6d92]')}>
            {input && fmt.ok && fmt.key !== input.trim() ? <>Will check <span className="font-mono font-semibold">{fmt.key}</span></> : touched && input && !fmt.ok ? fmt.error : 'Spaces, dashes and lower case are fine — the key is normalised automatically.'}
          </span>
          <span className="text-[#7a6d92]">{cooling ? '' : `${decision.allowed ? VERIFY_LIMIT - decision.history.length + 1 : 0} of ${VERIFY_LIMIT} lookups left this minute`}</span>
        </div>
        {cooling && (
          <Notice tone="warn" className="mt-3">
            Too many lookups — {VERIFY_LIMIT} per minute are allowed. Try again in {Math.ceil(decision.retryAfterMs / 1000)} s.
          </Notice>
        )}
      </form>

      {error && <Notice tone="error" className="mt-4">{error}</Notice>}
      {result && <ResultCard r={result} showCustomer={showCustomer} canOpen={can('licenses.view')} />}

      <div className="mt-5 grid gap-4 xl:grid-cols-[1fr_340px]">
        <div className="card">
          <div className="border-b border-[#ece6f4] px-4 py-3 font-bold">Checks in this session</div>
          {recent.length === 0 ? (
            <div className="px-4 py-6 text-center text-[13px] text-[#7a6d92]">No keys checked yet. Every check is also recorded in the Activity Log.</div>
          ) : (
            <table className="tbl">
              <tbody>
                {recent.map((r) => (
                  <tr key={r.at + r.key}>
                    <td className="w-40 text-[12.5px] text-[#7a6d92]">{fmtDateTime(r.at)}</td>
                    <td className="font-mono text-[12.5px]">{r.verdict === 'invalid_format' ? r.key.slice(0, 32) : maskKey(r.key)}</td>
                    <td className="text-right"><Badge tone={verdictInfo(r.verdict).tone}>{verdictInfo(r.verdict).label}</Badge></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        <div className="card p-4 text-[12.5px] text-[#5b4b78]">
          <div className="mb-1 flex items-center gap-2 font-bold text-[#1d1530]"><Timer className="h-4 w-4 text-[#7c3aed]" />About rate limiting</div>
          This page allows {VERIFY_LIMIT} lookups per minute per browser session. It is a browser-side throttle only: real server-side rate limiting needs Cloud Functions, which
          the free Spark plan does not have. Keys have about 8×10²⁴ combinations, so guessing them is not feasible.
        </div>
      </div>
    </div>
  )
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="rounded-xl border border-[#ece6f4] bg-[#fcfbfe] px-3.5 py-2.5">
      <div className="text-[11.5px] font-semibold tracking-wide text-[#7a6d92] uppercase">{label}</div>
      <div className="mt-0.5 text-[14px] font-semibold">{children}</div>
    </div>
  )
}

function ResultCard({ r, showCustomer, canOpen }: { r: Result; showCustomer: boolean; canOpen: boolean }) {
  const l = r.license
  const tone = r.info.valid ? (r.info.verdict === 'pending' ? 'amber' : 'green') : 'red'
  const icon = r.info.valid ? (r.info.verdict === 'pending' ? <Clock3 className="h-7 w-7" /> : <BadgeCheck className="h-7 w-7" />) : r.info.verdict === 'not_found' || r.info.verdict === 'invalid_format' ? <CircleAlert className="h-7 w-7" /> : <ShieldX className="h-7 w-7" />
  const banner = { green: 'from-green-600 to-emerald-500', amber: 'from-amber-500 to-orange-500', red: 'from-red-600 to-rose-500' }[tone]
  const left = l ? daysUntil(l.expiresAt) : null
  const lastVerifiedMs = l ? latestOf(l.lastVerifiedAt?.toMillis() ?? null, r.usage?.lastCheckMs ?? null) : null
  return (
    <div className="card mt-4 overflow-hidden" data-testid="verify-result">
      <div className={cx('flex items-center gap-4 bg-gradient-to-r px-5 py-4 text-white', banner)}>
        {icon}
        <div className="min-w-0">
          <div className="text-[18px] font-extrabold" data-testid="verify-verdict">{r.info.label}</div>
          <div className="text-[13px] opacity-90">{r.info.explanation}</div>
        </div>
        <div className="ml-auto font-mono text-[13px] opacity-90">{r.key}</div>
      </div>
      {l && (
        <div className="grid grid-cols-2 gap-3 p-5 xl:grid-cols-4">
          {showCustomer ? (
            <Fact label="Customer">
              {r.client ? `${r.client.company}${r.client.code ? ` (${r.client.code})` : ''}` : l.businessName || l.customerName || '—'}
              {r.client && (l.businessName || l.customerName) && <div className="text-[12px] font-normal text-[#7a6d92]">{l.businessName || l.customerName}</div>}
            </Fact>
          ) : (
            <Fact label="Customer"><span className="text-[13px] font-normal text-[#7a6d92]">Hidden — needs “View licenses” or “View clients”</span></Fact>
          )}
          <Fact label="Plan">{showCustomer ? <span className="capitalize">{l.plan}</span> : '—'} <span className="text-[12px] font-normal text-[#7a6d92] capitalize">· {l.planType}</span></Fact>
          <Fact label="Expiry">
            {l.expiresAt ? fmtDate(l.expiresAt) : 'Lifetime'}
            {left !== null && <div className={cx('text-[12px] font-normal', left < 0 ? 'text-red-600' : left <= 30 ? 'text-amber-600' : 'text-[#7a6d92]')}>{left < 0 ? `${-left} day(s) ago` : `${left} day(s) left`}</div>}
          </Fact>
          <Fact label="Cloud status"><Badge>{l.status}</Badge>{l.detached && <span className="ml-1 text-[12px] font-normal text-[#7a6d92]">detached</span>}</Fact>
          <Fact label="Devices in use">{l.activeDevices} of {l.maxDevices}{r.usage && <div className="text-[12px] font-normal text-[#7a6d92]">{r.usage.installations} installation(s) reporting</div>}</Fact>
          <Fact label="Firm limit">{l.maxFirms}</Fact>
          <Fact label="User limit">{l.maxUsers}</Fact>
          <Fact label="Last verification">
            {lastVerifiedMs ? fmtDateTime(lastVerifiedMs) : 'Never'}
            {r.usage?.lastSeenMs && <div className="text-[12px] font-normal text-[#7a6d92]">last heartbeat {fmtDateTime(r.usage.lastSeenMs)}</div>}
          </Fact>
        </div>
      )}
      {(r.usageNote || (l && canOpen)) && (
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-[#ece6f4] px-5 py-3 text-[12.5px] text-[#7a6d92]">
          <span>{r.usageNote ?? `Checked ${fmtDateTime(r.at)}`}</span>
          {l && canOpen && <Link className="btn btn-secondary btn-sm" to={`/licenses/${l.id}`}>Open license</Link>}
        </div>
      )}
    </div>
  )
}
