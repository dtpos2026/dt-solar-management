/**
 * Shared types and helpers for IPC routes. Feature areas register their routes in ./routes/*.ts; the router
 * merges them after the core routes (an area file may re-define a core route to extend it — each route key is
 * owned by exactly one file, see the header of each area file).
 */
import { BrowserWindow, WebContents, dialog } from 'electron'
import { runtime, getDb } from '../runtime'
import { AppError, Ctx } from '../services/context'

export type Args = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any

export interface CallContext {
  ctx: Ctx
  sender: WebContents
}

export interface Route {
  /** Route works without login */
  public?: boolean
  /** Any of these permissions is required */
  perm?: string | string[]
  /** Mutates business data (blocked when license is read-only) */
  write?: boolean
  handler: (c: CallContext, a: Args) => unknown | Promise<unknown>
}

export type RouteMap = Record<string, Route>

export const ownerOnly = (c: CallContext): void => {
  if (!c.ctx.user.isOwner) throw new AppError('Only the owner can do this.', 'FORBIDDEN')
}

export function licenseLimits(): { maxFirms: number; maxUsers: number } {
  const st = runtime.license?.status()
  return { maxFirms: st?.maxFirms ?? 1, maxUsers: st?.maxUsers ?? 1 }
}

export function publicCtx(): Ctx {
  // A minimal context for public routes that need the DB (never used for business data).
  return { db: getDb(), user: { id: 0, username: 'system', fullName: 'System', roleId: 0, roleName: '', isOwner: false, permissions: [], allFirms: false, firmIds: [], mustChangePassword: false }, firmId: 0 }
}

export async function saveDialog(sender: WebContents, defaultPath: string, filters: Electron.FileFilter[]): Promise<string | null> {
  const win = BrowserWindow.fromWebContents(sender) ?? undefined
  const r = await dialog.showSaveDialog(win!, { defaultPath, filters })
  return r.canceled || !r.filePath ? null : r.filePath
}

export async function openFileDialog(sender: WebContents, title: string, filters: Electron.FileFilter[]): Promise<string | null> {
  const win = BrowserWindow.fromWebContents(sender) ?? undefined
  const r = await dialog.showOpenDialog(win!, { properties: ['openFile'], title, filters })
  return r.canceled || !r.filePaths[0] ? null : r.filePaths[0]
}

export function csvEscape(v: unknown): string {
  const s = v === null || v === undefined ? '' : String(v)
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}
