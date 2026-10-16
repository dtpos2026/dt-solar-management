/**
 * Minimal Firestore REST client (no SDK, no sign-in — API key only). Used by licensing, heartbeats and support messages.
 *
 *  - Typed value encoding/decoding (stringValue, integerValue as string, doubleValue, booleanValue, mapValue, arrayValue,
 *    nullValue, timestampValue).
 *  - Writes go through `documents:commit` so server timestamps can be set with `setToServerValue: REQUEST_TIME`
 *    (firestore.rules require `lastSeen` / `lastMessageAt` / `at` == request.time).
 *  - Every network problem becomes a FirestoreError with `offline: true`, so callers can keep work queued.
 *  - The base URL can point at the local Firestore emulator (env DTSP_FIRESTORE_EMULATOR=host:port) for tests;
 *    production always uses https://firestore.googleapis.com.
 */

export type FsValue =
  | { stringValue: string }
  | { integerValue: string }
  | { doubleValue: number }
  | { booleanValue: boolean }
  | { nullValue: null }
  | { timestampValue: string }
  | { mapValue: { fields?: Record<string, FsValue> } }
  | { arrayValue: { values?: FsValue[] } }

export type FsFields = Record<string, FsValue>

export interface FsDocument {
  /** Full resource name: projects/{p}/databases/(default)/documents/{path} */
  name: string
  /** Path relative to the documents root, e.g. "heartbeats/abc" */
  path: string
  /** Last path segment */
  id: string
  data: Record<string, unknown>
  createTime?: string
  updateTime?: string
}

/** Forces a number to be written as doubleValue (plain integers are written as integerValue). */
export class FsDouble {
  constructor(readonly value: number) {}
}
/** Writes a Firestore timestamp (plain strings are always stringValue). */
export class FsTimestamp {
  constructor(readonly iso: string) {}
}
export const double = (n: number): FsDouble => new FsDouble(n)
export const timestamp = (d: Date | string): FsTimestamp => new FsTimestamp(typeof d === 'string' ? d : d.toISOString())

export function encodeValue(v: unknown): FsValue {
  if (v === null) return { nullValue: null }
  if (v instanceof FsDouble) {
    if (!Number.isFinite(v.value)) throw new Error('Cannot store a non-finite number.')
    return { doubleValue: v.value }
  }
  if (v instanceof FsTimestamp) return { timestampValue: v.iso }
  if (v instanceof Date) return { timestampValue: v.toISOString() }
  switch (typeof v) {
    case 'string':
      return { stringValue: v }
    case 'boolean':
      return { booleanValue: v }
    case 'bigint':
      return { integerValue: v.toString() }
    case 'number':
      if (!Number.isFinite(v)) throw new Error('Cannot store a non-finite number.')
      return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v }
    case 'object': {
      if (Array.isArray(v)) return { arrayValue: { values: v.filter((x) => x !== undefined).map(encodeValue) } }
      return { mapValue: { fields: encodeFields(v as Record<string, unknown>) } }
    }
    default:
      throw new Error(`Cannot store a value of type ${typeof v}.`)
  }
}

/** Encodes a plain object. `undefined` properties are skipped (they are not written at all). */
export function encodeFields(obj: Record<string, unknown>): FsFields {
  const out: FsFields = {}
  for (const [k, v] of Object.entries(obj ?? {})) {
    if (v === undefined) continue
    out[k] = encodeValue(v)
  }
  return out
}

export function decodeValue(v: unknown): unknown {
  if (!v || typeof v !== 'object') return undefined
  const o = v as Record<string, unknown>
  if ('stringValue' in o) return o.stringValue
  if ('integerValue' in o) return Number(o.integerValue)
  if ('doubleValue' in o) return Number(o.doubleValue)
  if ('booleanValue' in o) return !!o.booleanValue
  if ('nullValue' in o) return null
  if ('timestampValue' in o) return String(o.timestampValue)
  if ('mapValue' in o) return decodeFields(((o.mapValue as { fields?: FsFields }) ?? {}).fields)
  if ('arrayValue' in o) return (((o.arrayValue as { values?: FsValue[] }) ?? {}).values ?? []).map(decodeValue)
  if ('referenceValue' in o) return String(o.referenceValue)
  if ('geoPointValue' in o) return o.geoPointValue
  if ('bytesValue' in o) return o.bytesValue
  return undefined
}

export function decodeFields(fields: FsFields | Record<string, unknown> | undefined | null): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(fields ?? {})) out[k] = decodeValue(v)
  return out
}

export class FirestoreError extends Error {
  /** HTTP status (0 = no response) */
  readonly status: number
  /** gRPC style status, e.g. PERMISSION_DENIED, NOT_FOUND, UNAVAILABLE */
  readonly code: string
  /** True when the server could not be reached (offline, DNS, timeout) — safe to retry later. */
  readonly offline: boolean
  constructor(message: string, status: number, code: string, offline = false) {
    super(message)
    this.status = status
    this.code = code
    this.offline = offline
  }
  /** Worth retrying automatically (network problems, rate limits, server errors). */
  get transient(): boolean {
    return this.offline || this.status === 429 || this.status >= 500 || this.code === 'ABORTED' || this.code === 'UNAVAILABLE' || this.code === 'DEADLINE_EXCEEDED'
  }
}

export interface FirestoreConfig {
  projectId: string
  apiKey: string
  /** e.g. https://firestore.googleapis.com/v1/projects/p/databases/(default)/documents */
  baseUrl: string
  emulator: boolean
}

/**
 * Builds the connection settings. Environment overrides (tests only):
 *  - DTSP_FIRESTORE_EMULATOR=127.0.0.1:8080  → http://127.0.0.1:8080/v1/projects/<id>/databases/(default)/documents
 *  - DTSP_FIRESTORE_PROJECT=<id>             → project id override (emulator)
 *  - DTSP_CLOUD_DISABLED=1                   → no online features at all (returns null)
 */
export function resolveFirestoreConfig(base: { projectId: string; apiKey: string } | null, env: Record<string, string | undefined> = process.env): FirestoreConfig | null {
  if (env.DTSP_CLOUD_DISABLED === '1' || env.DTSP_CLOUD_DISABLED === 'true') return null
  const emu = (env.DTSP_FIRESTORE_EMULATOR ?? '').trim()
  const projectId = (env.DTSP_FIRESTORE_PROJECT ?? '').trim() || base?.projectId || ''
  if (emu) {
    if (!/^[\w.-]+:\d{2,5}$/.test(emu)) throw new Error(`DTSP_FIRESTORE_EMULATOR must be host:port, got "${emu}"`)
    if (!projectId) return null
    return {
      projectId,
      apiKey: base?.apiKey || 'emulator',
      baseUrl: `http://${emu}/v1/projects/${encodeURIComponent(projectId)}/databases/(default)/documents`,
      emulator: true
    }
  }
  if (!base?.projectId || !base?.apiKey) return null
  return {
    projectId: base.projectId,
    apiKey: base.apiKey,
    baseUrl: `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(base.projectId)}/databases/(default)/documents`,
    emulator: false
  }
}

export interface Write {
  /** Document path relative to the documents root, e.g. "heartbeats/abc" */
  path: string
  /** Field values (plain JS, encoded with encodeFields). */
  fields: Record<string, unknown>
  /** Only these fields are written (merge). Omit to replace the whole document. */
  mask?: string[]
  /** Fields set to the server's request time (rules can require `== request.time`). */
  serverTime?: string[]
  /** Precondition: true = must exist (update), false = must not exist (create). */
  exists?: boolean
  /** Integer fields incremented by the server (field path → amount). */
  increment?: Record<string, number>
}

type FetchLike = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{ status: number; ok?: boolean; json: () => Promise<unknown>; text?: () => Promise<string> }>

export interface RestOptions {
  timeoutMs?: number
  fetchImpl?: FetchLike
  /** Extra headers (tests: `Authorization: Bearer owner` acts as an admin on the emulator). */
  headers?: Record<string, string>
}

const SEGMENT_RE = /^[^/]+$/

/** Validates and URL-encodes a relative document / collection path. */
export function encodePath(path: string): string {
  const parts = String(path).split('/')
  if (!parts.length || parts.some((p) => !p || !SEGMENT_RE.test(p) || p === '.' || p === '..')) throw new Error(`Invalid Firestore path: ${path}`)
  return parts.map(encodeURIComponent).join('/')
}

export class FirestoreRest {
  readonly cfg: FirestoreConfig
  private timeoutMs: number
  private fetchImpl: FetchLike
  private headers: Record<string, string>

  constructor(cfg: FirestoreConfig, opts: RestOptions = {}) {
    this.cfg = cfg
    this.timeoutMs = opts.timeoutMs ?? 15000
    this.fetchImpl = opts.fetchImpl ?? (globalThis.fetch as unknown as FetchLike)
    this.headers = opts.headers ?? {}
  }

  /** projects/{p}/databases/(default)/documents */
  get rootName(): string {
    return `projects/${this.cfg.projectId}/databases/(default)/documents`
  }

  docName(path: string): string {
    encodePath(path)
    return `${this.rootName}/${path}`
  }

  private url(rel: string, query: Record<string, string | string[] | undefined> = {}): string {
    const params = new URLSearchParams()
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined) continue
      for (const x of Array.isArray(v) ? v : [v]) params.append(k, x)
    }
    if (!this.cfg.emulator || this.cfg.apiKey) params.append('key', this.cfg.apiKey)
    const qs = params.toString()
    return `${this.cfg.baseUrl}${rel}${qs ? `?${qs}` : ''}`
  }

  private async request(method: 'GET' | 'POST' | 'PATCH', url: string, body?: unknown): Promise<unknown> {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs)
    let res: Awaited<ReturnType<FetchLike>>
    try {
      res = await this.fetchImpl(url, {
        method,
        headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...this.headers },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: ctrl.signal
      })
    } catch (e) {
      const aborted = (e as Error)?.name === 'AbortError'
      throw new FirestoreError(
        aborted ? 'Digital Target’s online service did not respond in time. Check your internet connection.' : 'Could not reach Digital Target’s online service. Check your internet connection.',
        0,
        aborted ? 'DEADLINE_EXCEEDED' : 'UNAVAILABLE',
        true
      )
    } finally {
      clearTimeout(timer)
    }
    const json = (await res.json().catch(() => null)) as Record<string, unknown> | null
    if (res.status >= 200 && res.status < 300) return json
    const err = (Array.isArray(json) ? (json[0] as Record<string, unknown>)?.error : json?.error) as { message?: string; status?: string } | undefined
    const code = err?.status || (res.status === 404 ? 'NOT_FOUND' : res.status === 403 ? 'PERMISSION_DENIED' : `HTTP_${res.status}`)
    throw new FirestoreError(friendly(res.status, code, err?.message), res.status, code)
  }

  /** Reads one document. Returns null when it does not exist. */
  async get(path: string): Promise<FsDocument | null> {
    try {
      const json = (await this.request('GET', this.url(`/${encodePath(path)}`))) as Record<string, unknown>
      return this.toDoc(json)
    } catch (e) {
      if (e instanceof FirestoreError && e.status === 404) return null
      throw e
    }
  }

  /** Creates a document with a chosen id (fails with ALREADY_EXISTS when it exists). Client timestamps only. */
  async create(collectionPath: string, id: string, fields: Record<string, unknown>): Promise<FsDocument> {
    const json = (await this.request('POST', this.url(`/${encodePath(collectionPath)}`, { documentId: id }), { fields: encodeFields(fields) })) as Record<string, unknown>
    return this.toDoc(json)
  }

  /** Lists a (sub)collection. */
  async list(collectionPath: string, opts: { pageSize?: number; orderBy?: string; pageToken?: string } = {}): Promise<{ docs: FsDocument[]; nextPageToken?: string }> {
    const json = (await this.request(
      'GET',
      this.url(`/${encodePath(collectionPath)}`, { pageSize: opts.pageSize ? String(opts.pageSize) : undefined, orderBy: opts.orderBy, pageToken: opts.pageToken })
    )) as { documents?: Array<Record<string, unknown>>; nextPageToken?: string } | null
    return { docs: (json?.documents ?? []).map((d) => this.toDoc(d)), nextPageToken: json?.nextPageToken }
  }

  /** Runs a structured query on a collection under `parentPath` ('' = root). */
  async runQuery(parentPath: string, structuredQuery: Record<string, unknown>): Promise<FsDocument[]> {
    const rel = parentPath ? `/${encodePath(parentPath)}:runQuery` : ':runQuery'
    const json = (await this.request('POST', this.url(rel), { structuredQuery })) as Array<{ document?: Record<string, unknown> }> | null
    return (Array.isArray(json) ? json : []).filter((r) => r.document).map((r) => this.toDoc(r.document!))
  }

  /** Atomic batch of writes through documents:commit. */
  async commit(writes: Write[]): Promise<{ commitTime?: string }> {
    const body = {
      writes: writes.map((w) => {
        const out: Record<string, unknown> = { update: { name: this.docName(w.path), fields: encodeFields(w.fields) } }
        if (w.mask) out.updateMask = { fieldPaths: w.mask }
        const transforms: Array<Record<string, unknown>> = (w.serverTime ?? []).map((fieldPath) => ({ fieldPath, setToServerValue: 'REQUEST_TIME' }))
        for (const [fieldPath, n] of Object.entries(w.increment ?? {})) transforms.push({ fieldPath, increment: { integerValue: String(Math.trunc(n)) } })
        if (transforms.length) out.updateTransforms = transforms
        if (w.exists !== undefined) out.currentDocument = { exists: w.exists }
        return out
      })
    }
    const json = (await this.request('POST', this.url(':commit'), body)) as { commitTime?: string } | null
    return { commitTime: json?.commitTime }
  }

  /** Raw PATCH (used by tests acting as an admin). */
  async patch(path: string, fields: Record<string, unknown>, mask?: string[]): Promise<FsDocument> {
    const json = (await this.request('PATCH', this.url(`/${encodePath(path)}`, { 'updateMask.fieldPaths': mask }), { fields: encodeFields(fields) })) as Record<string, unknown>
    return this.toDoc(json)
  }

  private toDoc(json: Record<string, unknown>): FsDocument {
    const name = String(json?.name ?? '')
    const marker = '/documents/'
    const i = name.indexOf(marker)
    const path = i >= 0 ? name.slice(i + marker.length) : name
    return {
      name,
      path,
      id: path.split('/').pop() ?? '',
      data: decodeFields(json?.fields as FsFields | undefined),
      createTime: json?.createTime as string | undefined,
      updateTime: json?.updateTime as string | undefined
    }
  }
}

function friendly(status: number, code: string, raw?: string): string {
  if (status === 403 || code === 'PERMISSION_DENIED') return 'Digital Target’s online service refused the request.'
  if (status === 404 || code === 'NOT_FOUND') return 'The requested record was not found online.'
  if (status === 409 || code === 'ALREADY_EXISTS' || code === 'FAILED_PRECONDITION') return 'The online record changed meanwhile. Please try again.'
  if (status === 429 || code === 'RESOURCE_EXHAUSTED') return 'Digital Target’s online service is busy. It will be retried automatically.'
  if (status >= 500) return 'Digital Target’s online service is temporarily unavailable. It will be retried automatically.'
  if (status === 400) return `The online service rejected the data${raw ? ` (${raw.slice(0, 160)})` : ''}.`
  return `Online service error (${status}).`
}
