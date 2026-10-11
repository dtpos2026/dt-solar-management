import { appendFileSync, mkdirSync, statSync, renameSync } from 'fs'
import { join } from 'path'

let logDir = ''

export function initLog(dir: string): void {
  logDir = dir
  mkdirSync(dir, { recursive: true })
}

/** Minimal file logger. Never pass passwords, keys or license secrets here. */
export function log(level: 'info' | 'warn' | 'error', message: string): void {
  const line = `${new Date().toISOString()} [${level.toUpperCase()}] ${message.replace(/password\S*/gi, '[redacted]')}\n`
  if (level === 'error') console.error(line.trim())
  if (!logDir) return
  try {
    const file = join(logDir, 'app.log')
    try {
      if (statSync(file).size > 5 * 1024 * 1024) renameSync(file, join(logDir, 'app.old.log'))
    } catch {
      /* no file yet */
    }
    appendFileSync(file, line)
  } catch {
    /* logging must never crash the app */
  }
}
