/**
 * Super Admin permissions. Mirrors the checks in firestore.rules (the rules are the real enforcement; the UI
 * only hides what an admin cannot do). Owners have every permission.
 */
export interface AdminPermission {
  key: string
  label: string
}

export const ADMIN_PERMISSION_GROUPS: { group: string; items: AdminPermission[] }[] = [
  { group: 'Clients', items: [{ key: 'clients.view', label: 'View clients' }, { key: 'clients.manage', label: 'Create / edit / suspend / archive clients' }] },
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
  return isOwnerRole(admin.role) || (admin.permissions ?? []).includes(perm)
}
