/**
 * Save buttons must always finish. Firestore keeps a write that cannot reach the server queued on this device (it is
 * sent when the connection returns), so instead of waiting forever the UI stops waiting after `ms` and tells the admin.
 * Pure (no Firebase imports).
 */
export type Deadline<T> = { done: true; value: T } | { done: false; pending: Promise<T> }

/** Resolves with the result of `p`, or with `{ done: false, pending: p }` once `ms` passed. Rejections pass through. */
export function withDeadline<T>(p: Promise<T>, ms: number): Promise<Deadline<T>> {
  return new Promise<Deadline<T>>((resolve, reject) => {
    const t = setTimeout(() => resolve({ done: false, pending: p }), ms)
    p.then(
      (value) => {
        clearTimeout(t)
        resolve({ done: true, value })
      },
      (e) => {
        clearTimeout(t)
        reject(e)
      }
    )
  })
}

/** Default wait before a save reports "still uploading". */
export const SAVE_DEADLINE_MS = 15_000
