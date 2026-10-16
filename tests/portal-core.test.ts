/**
 * Super Admin portal — portal-core area (pure logic, no Firebase): activity-log clearing scope / batching and the
 * shared data cache (live sources + cached one-shot reads with invalidation).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ALL_NON_SECURITY,
  CLEAR_BATCH_SIZE,
  auditRowFromData,
  clearScopeMatches,
  clearScopeStrategy,
  describeClearScope,
  planClearBatches,
  validateClearScope,
  withoutIds,
  type ClearScope
} from '../admin-panel/src/lib/auditLog'
import { cachedFetch, invalidate, openSourceCount, resetCache, setCacheClock, subscribeShared } from '../admin-panel/src/lib/queryCache'

const DAY = 86_400_000
const T0 = Date.UTC(2026, 9, 1)

describe('activity log clearing scope', () => {
  it('never matches security entries, whatever the scope', () => {
    for (const s of [ALL_NON_SECURITY, { category: '', fromMs: T0 - DAY, toMs: T0 + DAY } as ClearScope]) {
      expect(clearScopeMatches({ category: 'security', atMs: T0 }, s)).toBe(false)
      expect(clearScopeMatches({ category: 'general', atMs: T0 }, s)).toBe(true)
      expect(clearScopeMatches({ category: 'financial', atMs: T0 }, s)).toBe(true)
    }
    expect(validateClearScope({ category: 'security', fromMs: null, toMs: null })).toMatch(/protected/)
  })

  it('all non-security clears every age, including entries without a time and legacy entries', () => {
    expect(clearScopeMatches({ category: 'support', atMs: T0 - 3650 * DAY }, ALL_NON_SECURITY)).toBe(true)
    expect(clearScopeMatches({ category: 'support', atMs: null }, ALL_NON_SECURITY)).toBe(true)
    const legacy = auditRowFromData('x', { action: 'license.create', at: { toMillis: () => T0 } })
    expect(legacy.category).toBe('license')
    expect(clearScopeMatches(legacy, ALL_NON_SECURITY)).toBe(true)
  })

  it('category and inclusive date range filters', () => {
    const s: ClearScope = { category: 'device', fromMs: T0, toMs: T0 + DAY - 1 }
    expect(clearScopeMatches({ category: 'device', atMs: T0 }, s)).toBe(true)
    expect(clearScopeMatches({ category: 'device', atMs: T0 + DAY - 1 }, s)).toBe(true)
    expect(clearScopeMatches({ category: 'device', atMs: T0 + DAY }, s)).toBe(false)
    expect(clearScopeMatches({ category: 'device', atMs: T0 - 1 }, s)).toBe(false)
    expect(clearScopeMatches({ category: 'client', atMs: T0 }, s)).toBe(false)
    expect(clearScopeMatches({ category: 'device', atMs: null }, s)).toBe(false)
    expect(validateClearScope({ category: '', fromMs: T0 + 1, toMs: T0 })).toMatch(/before/)
    expect(validateClearScope(s)).toBeNull()
  })

  it('query strategy avoids composite indexes and keeps legacy license entries', () => {
    expect(clearScopeStrategy({ category: 'device', fromMs: null, toMs: null })).toEqual({ kind: 'category', category: 'device' })
    expect(clearScopeStrategy({ category: 'license', fromMs: null, toMs: null }).kind).toBe('time')
    expect(clearScopeStrategy({ category: 'device', fromMs: T0, toMs: null })).toEqual({ kind: 'time', fromMs: T0, toMs: null })
    expect(clearScopeStrategy(ALL_NON_SECURITY).kind).toBe('time')
  })

  it('describes the scope for the confirmation and the security record', () => {
    expect(describeClearScope(ALL_NON_SECURITY)).toBe('all non-security entries of any date')
    expect(describeClearScope({ category: 'support', fromMs: T0, toMs: T0 + DAY })).toBe('Support entries from 2026-10-01 to 2026-10-02')
    expect(describeClearScope({ category: '', fromMs: null, toMs: T0 })).toBe('all non-security entries up to 2026-10-01')
  })

  it('plans batches of at most 450 deletes and drops deleted rows', () => {
    const ids = Array.from({ length: 1000 }, (_, i) => `id${i}`)
    const b = planClearBatches(ids)
    expect(CLEAR_BATCH_SIZE).toBe(450)
    expect(b.map((x) => x.length)).toEqual([450, 450, 100])
    expect(b.flat()).toEqual(ids)
    expect(planClearBatches([])).toEqual([])
    expect(() => planClearBatches(ids, 501)).toThrow()
    const rows = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]
    expect(withoutIds(rows, new Set(['b']))).toEqual([{ id: 'a' }, { id: 'c' }])
  })
})

describe('shared data cache', () => {
  let now = 0
  beforeEach(() => {
    resetCache()
    now = 1_000
    setCacheClock(() => now)
  })
  afterEach(() => {
    vi.useRealTimers()
    resetCache()
  })

  it('cachedFetch de-duplicates in-flight loads and honours the TTL', async () => {
    const load = vi.fn(async () => 'v')
    const [a, b] = await Promise.all([cachedFetch('k', load, 1000), cachedFetch('k', load, 1000)])
    expect([a, b]).toEqual(['v', 'v'])
    expect(load).toHaveBeenCalledTimes(1)
    now += 999
    await cachedFetch('k', load, 1000)
    expect(load).toHaveBeenCalledTimes(1)
    now += 2
    await cachedFetch('k', load, 1000)
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('invalidate drops the key and its sub-keys only; failures are not cached', async () => {
    const load = vi.fn(async () => 1)
    await cachedFetch('audit', load)
    await cachedFetch('audit:recent', load)
    await cachedFetch('auditx', load)
    invalidate('audit')
    await cachedFetch('audit', load)
    await cachedFetch('audit:recent', load)
    await cachedFetch('auditx', load)
    expect(load).toHaveBeenCalledTimes(5)
    const bad = vi.fn(async () => { throw new Error('x') })
    await expect(cachedFetch('b', bad)).rejects.toThrow('x')
    await expect(cachedFetch('b', bad)).rejects.toThrow('x')
    expect(bad).toHaveBeenCalledTimes(2)
  })

  it('an invalidation during a load is not overwritten by the stale result', async () => {
    let resolve!: (v: string) => void
    const slow = () => new Promise<string>((r) => (resolve = r))
    const p = cachedFetch('lic', slow)
    invalidate('lic')
    resolve('stale')
    await p
    const fresh = vi.fn(async () => 'fresh')
    expect(await cachedFetch('lic', fresh)).toBe('fresh')
  })

  it('live sources share one listener, deliver updates to all, and linger before closing', () => {
    vi.useFakeTimers()
    let emit!: (v: string) => void
    const stop = vi.fn()
    const start = vi.fn((e: (v: string) => void) => { emit = e; return stop })
    const seenA: (string | undefined)[] = []
    const seenB: (string | undefined)[] = []
    const ua = subscribeShared('licenses', start, (s) => seenA.push(s.data), 500)
    const ub = subscribeShared('licenses', start, (s) => seenB.push(s.data), 500)
    expect(start).toHaveBeenCalledTimes(1)
    emit('suspended')
    expect(seenA.at(-1)).toBe('suspended')
    expect(seenB.at(-1)).toBe('suspended')
    ua()
    ub()
    expect(stop).not.toHaveBeenCalled()
    // re-subscribing inside the linger window reuses the open listener and its latest data
    const seenC: (string | undefined)[] = []
    const uc = subscribeShared('licenses', start, (s) => seenC.push(s.data), 500)
    expect(start).toHaveBeenCalledTimes(1)
    expect(seenC[0]).toBe('suspended')
    uc()
    vi.advanceTimersByTime(501)
    expect(stop).toHaveBeenCalledTimes(1)
    expect(openSourceCount()).toBe(0)
  })

  it('a failed live source reports the error and restarts for the next subscriber', () => {
    let fail!: (e: string) => void
    const start = vi.fn((_e: (v: number) => void, f: (e: string) => void) => { fail = f; return () => undefined })
    const states: { error: string | null; loading: boolean }[] = []
    const u = subscribeShared('x', start, (s) => states.push(s), 10)
    fail('permission-denied')
    expect(states.at(-1)).toEqual(expect.objectContaining({ error: 'permission-denied', loading: false }))
    const u2 = subscribeShared('x', start, () => undefined, 10)
    expect(start).toHaveBeenCalledTimes(2)
    u()
    u2()
  })
})
