/**
 * WhatsApp outbox (owner: assist area): renders the PDF into userData/whatsapp-outbox, hands the renderer a short
 * random token (never a file path) and serves native drags of that file into the WhatsApp chat.
 */
import { BrowserWindow, IpcMainEvent, ipcMain, shell } from 'electron'
import { existsSync, mkdirSync, statSync, writeFileSync } from 'fs'
import { join, resolve, sep } from 'path'
import { runtime } from '../runtime'
import { getMainWindow, isTrustedSender, renderToPdf } from '../windows'
import { log } from '../log'
import { dragTokens, getDragIcon } from './web'
import type { Draft } from './service'

export interface OutboxItem {
  logId: number
  token: string
  fileName: string
  size: number
  phone: string
  message: string
  entity: string
  entityId: number
  label: string
  method: 'whatsapp_web' | 'chat_link'
}

/** The last prepared item (shown as the "Attach document" tile until marked sent or dismissed). */
let current: OutboxItem | null = null

export function outboxDir(): string {
  const d = join(runtime.paths.userData, 'whatsapp-outbox')
  mkdirSync(d, { recursive: true })
  return d
}

export function isInOutbox(file: string): boolean {
  const dir = resolve(outboxDir()) + sep
  return resolve(file).startsWith(dir)
}

export async function renderPdfToOutbox(d: Draft): Promise<{ file: string; size: number }> {
  const data = await renderToPdf(d.printKind, d.id, d.params)
  if (!data || data.length < 200) throw new Error('The PDF came out empty.')
  const file = join(outboxDir(), d.fileName)
  writeFileSync(file, data)
  return { file, size: data.length }
}

export function setCurrent(item: OutboxItem | null): void {
  current = item
}

export function getCurrent(): OutboxItem | null {
  if (!current) return null
  const file = dragTokens.resolve(current.token)
  if (!file || !existsSync(file)) return null
  return current
}

export function fileForToken(token: unknown): string | null {
  const f = dragTokens.resolve(token)
  if (!f || !isInOutbox(f) || !existsSync(f)) return null
  return f
}

export function showInFolder(token: unknown): boolean {
  const f = fileForToken(token)
  if (!f) return false
  shell.showItemInFolder(f)
  return true
}

export function fileSize(file: string): number {
  try {
    return statSync(file).size
  } catch {
    return 0
  }
}

/** ipcMain 'dt:startDrag': only the main window's app page may drag, only files it got a token for. */
export function registerDragHandler(): void {
  ipcMain.on('dt:startDrag', (event: IpcMainEvent, token: unknown) => {
    try {
      const win: BrowserWindow | null = getMainWindow()
      if (!win || win.isDestroyed() || event.sender !== win.webContents) return
      if (!isTrustedSender(event.senderFrame?.url ?? '')) return
      if (!runtime.session || runtime.session.locked) return
      const file = fileForToken(token)
      if (!file) return
      event.sender.startDrag({ file, icon: getDragIcon() })
    } catch (e) {
      log('error', `WhatsApp drag failed: ${(e as Error).message}`)
    }
  })
}
