import { create } from 'zustand'
import { api } from './api'

export interface SessionUser {
  id: number
  username: string
  fullName: string
  roleName: string
  isOwner: boolean
  permissions: string[]
  allFirms: boolean
  firmIds: number[]
  mustChangePassword: boolean
}

export interface FirmLite {
  id: number
  name: string
  logo?: string | null
}

export interface LicenseStatus {
  mode: string
  canWrite: boolean
  message: string
  deviceId: string
  deviceName: string
  payload: null | {
    licenseId: string
    customerName: string
    businessName: string
    plan: string
    maxFirms: number
    maxUsers: number
    expiresAt: string | null
    leaseUntil: string | null
    issuedAt: string
    features: string[]
  }
  trialDaysLeft: number | null
  daysLeft: number | null
  graceDaysLeft: number | null
  lastCheckAt: string | null
  onlineConfigured: boolean
  signingConfigured: boolean
  maxFirms: number
  maxUsers: number
  poweredBy?: boolean
  detached?: boolean
  /** Why writes are blocked: license, device, connectivity, activation or clock (null = allowed). */
  blockReason?: 'license' | 'device' | 'connectivity' | 'activation' | 'clock' | null
  /** Old installation that used the former local trial (read-only until activated). */
  legacyTrial?: boolean
}

interface State {
  user: SessionUser | null
  firm: FirmLite | null
  firms: Array<{ id: number; name: string; is_default: number; is_active: number }>
  settings: Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
  license: LicenseStatus | null
  locked: boolean
  version: string
  refresh: () => Promise<void>
  setLicense: (l: LicenseStatus) => void
  setLocked: (v: boolean) => void
  clear: () => void
}

export const useApp = create<State>((set) => ({
  user: null,
  firm: null,
  firms: [],
  settings: {},
  license: null,
  locked: false,
  version: '',
  refresh: async () => {
    const me = await api<{ user: SessionUser; firm: FirmLite; settings: Record<string, unknown> }>('auth.me')
    const firms = await api<State['firms']>('firms.list')
    const license = await api<LicenseStatus>('license.status')
    set({ user: me.user, firm: me.firm, settings: me.settings, firms, license })
  },
  setLicense: (license) => set({ license }),
  setLocked: (locked) => set({ locked }),
  clear: () => set({ user: null, firm: null, firms: [], settings: {}, locked: false })
}))

export function can(perm: string): boolean {
  const u = useApp.getState().user
  return !!u && (u.isOwner || u.permissions.includes(perm))
}

export function useCan(): (perm: string) => boolean {
  const user = useApp((s) => s.user)
  return (perm: string) => !!user && (user.isOwner || user.permissions.includes(perm))
}

export function canWrite(): boolean {
  return useApp.getState().license?.canWrite ?? false
}
