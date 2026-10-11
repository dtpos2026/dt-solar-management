/** Typed access to the main-process router (through the preload bridge). */
export interface ApiError extends Error {
  code?: string
}

type Listener = (e: ApiError) => void
const listeners = new Set<Listener>()

export function onApiError(l: Listener): () => void {
  listeners.add(l)
  return () => listeners.delete(l)
}

export async function api<T = any>(method: string, args?: unknown): Promise<T> { // eslint-disable-line @typescript-eslint/no-explicit-any
  try {
    return await window.dt.call<T>(method, args)
  } catch (e) {
    const err = e as ApiError
    if (err.code === 'LOCKED' || err.code === 'AUTH_REQUIRED') for (const l of listeners) l(err)
    throw err
  }
}
