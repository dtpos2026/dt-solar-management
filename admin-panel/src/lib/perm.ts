/**
 * Super Admin permissions. Mirrors the checks in firestore.rules (the rules are the real enforcement; the UI
 * only hides what an admin cannot do). Owners have every permission.
 */
export interface AdminPermission {
  key: string
  label: string
}

export const ADMIN_PERMISSION_GROUPS: { group: string; items: AdminPermission[] }[] = [
  { group: 'Clients', items: [{ key: 'clients.view', label: 'View clients' }, { key: 'clients.manage', label: 'Create / edit / suspend / archive / delete clients' }] },
  {
    group: 'Licenses',
    items: [
      { key: 'licenses.view', label: 'View licenses' },
      { key: 'licenses.generate', label: 'Generate license keys' },
      { key: 'licenses.manage', label: 'Suspend / revoke / renew / change plan & limits / detach' }
    ]
  },
  { group: 'Devices', items: [{ key: 'devices.view', label: 'View devices & map' }, { key: 'devices.manage', label: 'Approve activations, suspend / release devices' }] },
  {
    group: 'Billing',
    items: [
      { key: 'billing.view', label: 'View invoices & revenue' },
      { key: 'billing.create', label: 'Create / edit / cancel invoices' },
      { key: 'billing.payments', label: 'Record payments & receipts' }
    ]
  },
  { group: 'Support', items: [{ key: 'support.manage', label: 'Read & reply to support messages' }] },
  { group: 'Activity log', items: [{ key: 'audit.view', label: 'View activity log' }, { key: 'audit.manage', label: 'Archive / export activity log' }] },
  {
    group: 'Administration',
    items: [
      { key: 'verify.use', label: 'Verify license keys' },
      { key: 'branding.manage', label: 'Branding, invoice & portal settings' },
      { key: 'admins.manage', label: 'Manage admin users (non-owner)' }
    ]
  }
]

export const ALL_ADMIN_PERMISSIONS = ADMIN_PERMISSION_GROUPS.flatMap((g) => g.items.map((i) => i.key))

export type AdminRole = 'owner' | 'manager' | 'sales' | 'billing' | 'support' | 'technical' | 'custom'

export const ROLE_PRESETS: Record<AdminRole, { label: string; permissions: string[] }> = {
  owner: { label: 'Owner', permissions: ALL_ADMIN_PERMISSIONS },
  manager: { label: 'Manager', permissions: ALL_ADMIN_PERMISSIONS.filter((p) => !['admins.manage', 'branding.manage'].includes(p)) },
  sales: { label: 'Sales Agent', permissions: ['clients.view', 'clients.manage', 'licenses.view', 'licenses.generate', 'devices.view', 'billing.view', 'billing.create', 'verify.use'] },
  billing: { label: 'Billing Operator', permissions: ['clients.view', 'licenses.view', 'billing.view', 'billing.create', 'billing.payments', 'verify.use'] },
  support: { label: 'Support Agent', permissions: ['clients.view', 'licenses.view', 'devices.view', 'support.manage', 'verify.use'] },
  technical: { label: 'Technical Administrator', permissions: ['clients.view', 'licenses.view', 'licenses.generate', 'licenses.manage', 'devices.view', 'devices.manage', 'verify.use', 'audit.view'] },
  custom: { label: 'Custom', permissions: [] }
}

export function isOwnerRole(role: string | undefined | null): boolean {
  return role === 'owner' || role === 'superadmin'
}

export function hasPerm(admin: { role?: string; permissions?: string[] } | null | undefined, perm: string): boolean {
  if (!admin) return false
  return isOwnerRole(admin.role) || (Array.isArray(admin.permissions) ? admin.permissions : []).includes(perm)
}

/** True when the admin holds at least one of `perms`. */
export function hasAnyPerm(admin: { role?: string; permissions?: string[] } | null | undefined, perms: readonly string[]): boolean {
  return perms.some((p) => hasPerm(admin, p))
}

/* ------------------------------------------- admin management ------------------------------------------- */

/** Display order of the role picker. */
export const ADMIN_ROLES: AdminRole[] = ['owner', 'manager', 'sales', 'billing', 'support', 'technical', 'custom']

/** Permissions only an owner may grant (the rules enforce the same). */
export const OWNER_ONLY_PERMISSIONS = ['admins.manage']

export function roleLabel(role: string | undefined | null): string {
  if (isOwnerRole(role)) return 'Owner'
  return (ROLE_PRESETS as Record<string, { label: string }>)[role ?? '']?.label ?? (role ? role : 'Custom')
}

/** Keeps only known permission keys, without duplicates, in the canonical (checkbox) order. */
export function sanitisePermissions(perms: readonly unknown[] | null | undefined): string[] {
  const set = new Set((Array.isArray(perms) ? perms : []).filter((p): p is string => typeof p === 'string'))
  return ALL_ADMIN_PERMISSIONS.filter((p) => set.has(p))
}

/** Permissions stored for a role preset (owners store [] — they have every permission implicitly). */
export function presetPermissions(role: AdminRole): string[] {
  if (role === 'owner') return []
  return sanitisePermissions(ROLE_PRESETS[role].permissions)
}

/** The non-owner preset whose permission set equals `perms`, or 'custom'. */
export function matchPreset(perms: readonly string[]): AdminRole {
  const want = sanitisePermissions(perms).join(',')
  for (const r of ADMIN_ROLES) {
    if (r === 'owner' || r === 'custom') continue
    if (presetPermissions(r).join(',') === want) return r
  }
  return 'custom'
}

/** Effective permissions of an admin record (owners: all). */
export function effectivePermissions(admin: { role?: string; permissions?: string[] } | null | undefined): string[] {
  if (!admin) return []
  return isOwnerRole(admin.role) ? [...ALL_ADMIN_PERMISSIONS] : sanitisePermissions(admin.permissions)
}

export function permissionCountLabel(admin: { role?: string; permissions?: string[] }): string {
  if (isOwnerRole(admin.role)) return 'All (owner)'
  return `${sanitisePermissions(admin.permissions).length} of ${ALL_ADMIN_PERMISSIONS.length}`
}

export interface AdminRef {
  uid: string
  role?: string
  permissions?: string[]
}

export interface AdminActions {
  edit: boolean
  toggleActive: boolean
  remove: boolean
  resetPassword: boolean
  /** Why something is not possible (shown as a tooltip). */
  reason: string | null
}

/**
 * What `actor` may do to `target` on the Admins page. Mirrors firestore.rules → match /admins/{uid}:
 * nobody changes their own role / permissions / active flag; owner records and admins holding admins.manage
 * can only be changed by an owner; only owners delete records (never their own).
 */
export function adminActions(actor: AdminRef | null | undefined, target: AdminRef): AdminActions {
  const none = (reason: string): AdminActions => ({ edit: false, toggleActive: false, remove: false, resetPassword: false, reason })
  if (!actor || !hasPerm(actor, 'admins.manage')) return none('You do not have the “Manage admin users” permission.')
  const actorOwner = isOwnerRole(actor.role)
  if (actor.uid === target.uid) {
    return { edit: false, toggleActive: false, remove: false, resetPassword: true, reason: 'You cannot change your own role, permissions or status.' }
  }
  const targetPrivileged = isOwnerRole(target.role) || sanitisePermissions(target.permissions).some((p) => OWNER_ONLY_PERMISSIONS.includes(p))
  if (targetPrivileged && !actorOwner) return none('Only an owner can change owners or admins who manage admins.')
  return { edit: true, toggleActive: true, remove: actorOwner, resetPassword: true, reason: actorOwner ? null : 'Only an owner can delete admin records.' }
}

/** Roles the actor may assign (Owner only for owners). */
export function assignableRoles(actorIsOwner: boolean): AdminRole[] {
  return ADMIN_ROLES.filter((r) => r !== 'owner' || actorIsOwner)
}

export function canGrantPermission(actorIsOwner: boolean, perm: string): boolean {
  return actorIsOwner || !OWNER_ONLY_PERMISSIONS.includes(perm)
}

export interface AdminDraft {
  name: string
  email: string
  password: string
  role: AdminRole
  permissions: string[]
}

export const MIN_ADMIN_PASSWORD = 8
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/

export function isValidEmail(email: string): boolean {
  return EMAIL_RE.test(email.trim())
}

/**
 * Validates the create / edit admin form. Returns field → message (an empty object means valid).
 * `isNew` adds the e-mail / password checks; `linkExisting` = the login already exists (password = its current one).
 */
export function validateAdminDraft(d: AdminDraft, actorIsOwner: boolean, isNew: boolean, linkExisting = false): Record<string, string> {
  const e: Record<string, string> = {}
  if (!d.name.trim()) e.name = 'Enter the admin’s name.'
  else if (d.name.trim().length > 120) e.name = 'Keep the name under 120 characters.'
  if (isNew) {
    if (!isValidEmail(d.email)) e.email = 'Enter a valid e-mail address.'
    if (linkExisting) {
      if (!d.password) e.password = 'Enter the current password of the existing login.'
    } else if (d.password.length < MIN_ADMIN_PASSWORD) {
      e.password = `Use at least ${MIN_ADMIN_PASSWORD} characters.`
    } else if (!(/[A-Za-z]/.test(d.password) && /[0-9]/.test(d.password))) {
      e.password = 'Use both letters and numbers.'
    }
  }
  if (!ADMIN_ROLES.includes(d.role)) e.role = 'Choose a role.'
  else if (d.role === 'owner' && !actorIsOwner) e.role = 'Only an owner can create or promote owners.'
  if (d.role !== 'owner') {
    const perms = sanitisePermissions(d.permissions)
    if (perms.length === 0) e.permissions = 'Tick at least one permission.'
    else if (!actorIsOwner && perms.some((p) => OWNER_ONLY_PERMISSIONS.includes(p))) e.permissions = 'Only an owner can grant “Manage admin users”.'
  }
  return e
}

/** Random temporary password (letters + digits, no look-alike characters). `rand(n)` → 0..n-1, injectable for tests. */
export function generateTempPassword(length = 12, rand: (n: number) => number = cryptoRandomInt): string {
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz'
  const digits = '23456789'
  const all = letters + digits
  const n = Math.max(MIN_ADMIN_PASSWORD, length)
  const out: string[] = []
  for (let i = 0; i < n; i++) out.push(all[rand(all.length)])
  // Guarantee at least one letter and one digit (positions 0 and 1 are as random as any other).
  if (!out.some((c) => digits.includes(c))) out[1] = digits[rand(digits.length)]
  if (!out.some((c) => letters.includes(c))) out[0] = letters[rand(letters.length)]
  return out.join('')
}

function cryptoRandomInt(n: number): number {
  const a = new Uint32Array(1)
  globalThis.crypto.getRandomValues(a)
  return a[0] % n
}
