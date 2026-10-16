/**
 * Built-in WhatsApp Web (owner: assist area).
 * One WebContentsView with its own persistent, sandboxed partition shows https://web.whatsapp.com/ inside the main
 * window, positioned over the placeholder of the /whatsapp page. The customer links their phone by scanning the QR code
 * (Linked devices). The app never automates WhatsApp: it only loads chat URLs; the user attaches files and presses Send.
 */
import { BrowserWindow, WebContentsView, app, nativeImage, session, shell } from 'electron'
import { existsSync, mkdirSync } from 'fs'
import { extname, join, basename } from 'path'
import { runtime } from '../runtime'
import { getSetting } from '../services/context'
import { log } from '../log'
import { CHROME_UA, DragTokens, WHATSAPP_WEB_URL, buildSendUrl, isAllowedWhatsAppUrl } from './core'

export const WA_PARTITION = 'persist:whatsapp'

export type ViewState = 'idle' | 'loading' | 'ready' | 'failed'

let view: WebContentsView | null = null
let host: BrowserWindow | null = null
let state: ViewState = 'idle'
let lastError: string | null = null
let visible = false
let sessionReady = false
let guardTimer: NodeJS.Timeout | null = null

export const dragTokens = new DragTokens()

/** Test override (DTSP_WHATSAPP_URL); production always uses https://web.whatsapp.com/. */
export function testOverrideUrl(): string | null {
  const o = process.env.DTSP_WHATSAPP_URL
  if (!o || !/^https?:\/\/[^\s]+$/i.test(o)) return null
  return o
}

export function baseUrl(): string {
  return testOverrideUrl() ?? WHATSAPP_WEB_URL
}

function notificationsAllowed(): boolean {
  try {
    return !!runtime.db && getSetting<boolean>(runtime.db, 'whatsapp_notifications', false) === true
  } catch {
    return false
  }
}

function uniqueDownloadPath(name: string): string {
  const dir = app.getPath('downloads')
  mkdirSync(dir, { recursive: true })
  const safe = basename(name || 'download').replace(/[<>:"/\\|?*\x00-\x1f]+/g, '_') || 'download'
  const ext = extname(safe)
  const stem = safe.slice(0, safe.length - ext.length)
  let p = join(dir, safe)
  for (let i = 1; existsSync(p) && i < 1000; i++) p = join(dir, `${stem} (${i})${ext}`)
  return p
}

function setupSession(): Electron.Session {
  const ses = session.fromPartition(WA_PARTITION)
  if (sessionReady) return ses
  sessionReady = true
  ses.setUserAgent(CHROME_UA, 'en-US,en')
  ses.setPermissionRequestHandler((_wc, permission, cb) => cb(permission === 'notifications' && notificationsAllowed()))
  ses.setPermissionCheckHandler((_wc, permission) => permission === 'notifications' && notificationsAllowed())
  ses.setDevicePermissionHandler(() => false)
  ses.on('will-download', (_e, item) => {
    const p = uniqueDownloadPath(item.getFilename())
    item.setSavePath(p)
    item.once('done', (_ev, st) => {
      if (st === 'completed') log('info', `WhatsApp download saved: ${p}`)
    })
  })
  return ses
}

function setState(s: ViewState, err: string | null = null): void {
  state = s
  lastError = err
}

function createView(win: BrowserWindow): WebContentsView {
  setupSession()
  const v = new WebContentsView({
    webPreferences: {
      partition: WA_PARTITION,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      webSecurity: true,
      spellcheck: true,
      devTools: runtime.isDev
    }
  })
  const wc = v.webContents
  wc.setUserAgent(CHROME_UA)
  wc.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })
  const guard = (e: Electron.Event, url: string): void => {
    if (isAllowedWhatsAppUrl(url, testOverrideUrl())) return
    e.preventDefault()
    if (/^https?:\/\//i.test(url)) shell.openExternal(url)
  }
  wc.on('will-navigate', guard)
  wc.on('will-redirect', guard)
  wc.on('did-start-loading', () => setState('loading'))
  wc.on('did-stop-loading', () => {
    if (state === 'loading') setState('ready')
  })
  wc.on('did-fail-load', (_e, code, desc, _url, isMainFrame) => {
    if (isMainFrame && code !== -3) setState('failed', `${desc || 'Network error'} (${code})`)
  })
  wc.on('render-process-gone', (_e, d) => setState('failed', `WhatsApp page stopped (${d.reason}). Press Reload.`))
  v.setBackgroundColor('#ffffff')
  v.setVisible(false)
  win.contentView.addChildView(v)
  win.on('closed', () => {
    view = null
    host = null
    visible = false
  })
  host = win
  if (!guardTimer) {
    // Safety net: never leave the view above the lock screen or after sign-out.
    guardTimer = setInterval(() => {
      if (visible && (!runtime.session || runtime.session.locked)) hide()
    }, 700)
    guardTimer.unref?.()
  }
  return v
}

/** Creates the view on first use (lazy) and keeps it alive while the app runs, so WhatsApp stays linked. */
export function ensureView(win: BrowserWindow): WebContentsView {
  if (view && !view.webContents.isDestroyed() && host === win) return view
  view = createView(win)
  setState('loading')
  view.webContents.loadURL(baseUrl(), { userAgent: CHROME_UA }).catch((e: Error) => setState('failed', e.message))
  return view
}

export interface Bounds {
  x: number
  y: number
  width: number
  height: number
}

export function show(win: BrowserWindow, b: Bounds): void {
  const v = ensureView(win)
  const z = win.webContents.getZoomFactor() || 1
  const [cw, ch] = win.getContentSize()
  const x = Math.max(0, Math.round(b.x * z))
  const y = Math.max(0, Math.round(b.y * z))
  const width = Math.max(0, Math.min(cw - x, Math.round(b.width * z)))
  const height = Math.max(0, Math.min(ch - y, Math.round(b.height * z)))
  v.setBounds({ x, y, width, height })
  // keep it on top of other child views
  win.contentView.addChildView(v)
  v.setVisible(width > 0 && height > 0)
  visible = width > 0 && height > 0
}

export function hide(): void {
  if (view && !view.webContents.isDestroyed()) view.setVisible(false)
  visible = false
}

export function status(): { state: ViewState; error: string | null; started: boolean; visible: boolean; url: string | null; testMode: boolean } {
  const alive = !!view && !view.webContents.isDestroyed()
  let url: string | null = null
  if (alive) {
    try {
      const u = new URL(view!.webContents.getURL())
      url = `${u.origin}${u.pathname}` // never expose chat text / query
    } catch {
      url = null
    }
  }
  return { state: alive ? state : 'idle', error: lastError, started: alive, visible, url, testMode: !!testOverrideUrl() }
}

export function reload(win: BrowserWindow): void {
  const v = ensureView(win)
  setState('loading')
  const cur = v.webContents.getURL()
  if (!cur || !isAllowedWhatsAppUrl(cur, testOverrideUrl())) v.webContents.loadURL(baseUrl(), { userAgent: CHROME_UA }).catch((e: Error) => setState('failed', e.message))
  else v.webContents.reload()
}

/** Opens a chat (send?phone=&text=). The user still presses Send in WhatsApp. */
export function openChat(win: BrowserWindow, phone: string, text = ''): string {
  const v = ensureView(win)
  const url = buildSendUrl(phone, text, baseUrl())
  setState('loading')
  v.webContents.loadURL(url, { userAgent: CHROME_UA }).catch((e: Error) => setState('failed', e.message))
  return url
}

/** Logs out locally: clears the partition storage, then reloads so a new QR code appears. */
export async function unlink(win: BrowserWindow | null): Promise<void> {
  const ses = setupSession()
  await ses.clearStorageData()
  await ses.clearCache()
  if (win && view && !view.webContents.isDestroyed()) {
    setState('loading')
    await view.webContents.loadURL(baseUrl(), { userAgent: CHROME_UA }).catch((e: Error) => setState('failed', e.message))
  }
}

let dragIcon: Electron.NativeImage | null = null
export function getDragIcon(): Electron.NativeImage {
  if (dragIcon && !dragIcon.isEmpty()) return dragIcon
  const candidates = [join(__dirname, '../../resources/icon.png'), join(process.resourcesPath ?? '', 'icon.png')]
  for (const c of candidates) {
    if (c && existsSync(c)) {
      const img = nativeImage.createFromPath(c)
      if (!img.isEmpty()) {
        dragIcon = img.resize({ width: 48, height: 48 })
        return dragIcon
      }
    }
  }
  dragIcon = nativeImage.createFromDataURL(
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAKUlEQVR42mNkYPhfz0AEYBxVSF+FjP8Z6hmIUUhWBaMKR2Mo2aIYAgBMNw8RpgGZXAAAAABJRU5ErkJggg=='
  )
  return dragIcon
}
