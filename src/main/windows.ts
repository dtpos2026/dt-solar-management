import { BrowserWindow, app, shell } from 'electron'
import { join } from 'path'
import { runtime } from './runtime'

let mainWindow: BrowserWindow | null = null

const iconPath = join(__dirname, '../../resources/icon.png')

function rendererUrl(page: 'index' | 'splash'): { url?: string; file?: string } {
  if (!app.isPackaged && process.env['ELECTRON_RENDERER_URL']) return { url: `${process.env['ELECTRON_RENDERER_URL']}/${page}.html` }
  return { file: join(__dirname, `../renderer/${page}.html`) }
}

function secureWebPreferences(): Electron.WebPreferences {
  return {
    preload: join(__dirname, '../preload/index.js'),
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    webSecurity: true,
    spellcheck: false,
    devTools: runtime.isDev
  }
}

function harden(win: BrowserWindow): void {
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e, url) => {
    const allowed = url.startsWith('file://') || (process.env['ELECTRON_RENDERER_URL'] && url.startsWith(process.env['ELECTRON_RENDERER_URL']))
    if (!allowed) e.preventDefault()
  })
}

export function isTrustedSender(url: string): boolean {
  if (url.startsWith('file://')) return true
  const dev = process.env['ELECTRON_RENDERER_URL']
  return !!dev && !app.isPackaged && url.startsWith(dev)
}

function load(win: BrowserWindow, page: 'index' | 'splash', hash?: string): void {
  const t = rendererUrl(page)
  if (t.url) win.loadURL(hash ? `${t.url}#${hash}` : t.url)
  else win.loadFile(t.file!, hash ? { hash } : undefined)
}

export function createSplash(): BrowserWindow {
  const splash = new BrowserWindow({
    width: 560,
    height: 360,
    frame: false,
    transparent: true,
    resizable: false,
    movable: true,
    alwaysOnTop: true,
    skipTaskbar: false,
    center: true,
    show: true,
    icon: iconPath,
    backgroundColor: '#00000000',
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, devTools: false }
  })
  harden(splash)
  load(splash, 'splash')
  return splash
}

export function createMainWindow(): BrowserWindow {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 680,
    show: false,
    title: 'DT Solar Pro',
    icon: iconPath,
    backgroundColor: '#f4f7fb',
    autoHideMenuBar: true,
    webPreferences: secureWebPreferences()
  })
  mainWindow.setMenuBarVisibility(false)
  harden(mainWindow)
  load(mainWindow, 'index')
  mainWindow.on('closed', () => {
    mainWindow = null
  })
  return mainWindow
}

export function getMainWindow(): BrowserWindow | null {
  return mainWindow
}

export function openPrintWindow(kind: string, id: number, params: Record<string, unknown>): BrowserWindow {
  const win = new BrowserWindow({
    width: 1000,
    height: 1000,
    minWidth: 800,
    minHeight: 600,
    title: 'Print Preview — DT Solar Pro',
    icon: iconPath,
    parent: mainWindow ?? undefined,
    autoHideMenuBar: true,
    backgroundColor: '#525659',
    webPreferences: secureWebPreferences()
  })
  win.setMenuBarVisibility(false)
  harden(win)
  const q = new URLSearchParams()
  for (const [k, v] of Object.entries(params ?? {})) if (v !== undefined && v !== null) q.set(k, String(v))
  load(win, 'index', `/print/${encodeURIComponent(kind)}/${id}${q.toString() ? `?${q}` : ''}`)
  return win
}

export function broadcast(channel: string, payload: unknown): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send(channel, payload)
  }
}
