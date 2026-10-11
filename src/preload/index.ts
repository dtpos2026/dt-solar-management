import { contextBridge, ipcRenderer } from 'electron'

/**
 * The ONLY bridge between the UI and the main process. No Node.js APIs are exposed.
 * Every call goes through the whitelisted router in the main process.
 */
const api = {
  call: async <T = unknown>(method: string, args?: unknown): Promise<T> => {
    const res = (await ipcRenderer.invoke('dt:call', method, args)) as { ok: boolean; data?: T; error?: { message: string; code: string } }
    if (res.ok) return res.data as T
    const err = new Error(res.error?.message ?? 'Unknown error') as Error & { code?: string }
    err.code = res.error?.code
    throw err
  },
  onLicense: (cb: (status: unknown) => void): (() => void) => {
    const h = (_e: unknown, s: unknown): void => cb(s)
    ipcRenderer.on('dt:license', h)
    return () => ipcRenderer.removeListener('dt:license', h)
  },
  onSession: (cb: (event: string) => void): (() => void) => {
    const h = (_e: unknown, s: string): void => cb(s)
    ipcRenderer.on('dt:session', h)
    return () => ipcRenderer.removeListener('dt:session', h)
  }
}

contextBridge.exposeInMainWorld('dt', api)

export type DtApi = typeof api
