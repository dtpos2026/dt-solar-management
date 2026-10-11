import type { DB } from './db'
import type { LicenseService } from './license/service'
import type { SessionUser } from './services/context'

export interface Session {
  user: SessionUser
  firmId: number
  locked: boolean
  lastActivity: number
}

export interface Paths {
  userData: string
  dataDir: string
  dbFile: string
  backups: string
  attachments: string
  licenseDir: string
}

export const runtime: {
  db: DB | null
  dbError: string | null
  session: Session | null
  license: LicenseService | null
  paths: Paths
  appVersion: string
  isDev: boolean
} = {
  db: null,
  dbError: null,
  session: null,
  license: null,
  paths: { userData: '', dataDir: '', dbFile: '', backups: '', attachments: '', licenseDir: '' },
  appVersion: '0.0.0',
  isDev: false
}

export function getDb(): DB {
  if (!runtime.db) throw new Error(runtime.dbError || 'Database is not open.')
  return runtime.db
}
