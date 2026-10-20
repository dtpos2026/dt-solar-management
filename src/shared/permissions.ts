/** Permission catalogue. Every IPC route declares the permission it needs. */
export interface PermissionDef {
  key: string
  label: string
}
export interface PermissionGroup {
  group: string
  items: PermissionDef[]
}

export const PERMISSION_GROUPS: PermissionGroup[] = [
  {
    group: 'Dashboard',
    items: [
      { key: 'dashboard.view', label: 'View dashboard' },
      { key: 'dashboard.financials', label: 'See profit & financial totals on dashboard' }
    ]
  },
  {
    group: 'Sales',
    items: [
      { key: 'sales.view', label: 'View sales documents' },
      { key: 'sales.create', label: 'Create sales invoices, orders, challans & returns' },
      { key: 'sales.edit', label: 'Edit unpaid sales documents' },
      { key: 'sales.edit_locked', label: 'Edit / cancel paid or finalized sales documents' },
      { key: 'sales.cancel', label: 'Cancel sales documents' },
      { key: 'sales.discount', label: 'Give discounts / sell below sale price' },
      { key: 'sales.delete', label: 'Delete unpaid sales invoices permanently' }
    ]
  },
  {
    group: 'CRM',
    items: [
      { key: 'crm.view', label: 'View leads, pipeline and follow-ups' },
      { key: 'crm.manage', label: 'Add / edit leads, log calls and visits, move the pipeline, convert to customer' }
    ]
  },
  {
    group: 'Quotations',
    items: [
      { key: 'quotations.view', label: 'View quotations' },
      { key: 'quotations.manage', label: 'Create / edit / convert quotations' }
    ]
  },
  {
    group: 'Purchases',
    items: [
      { key: 'purchases.view', label: 'View purchases' },
      { key: 'purchases.create', label: 'Create purchases, orders & returns' },
      { key: 'purchases.edit', label: 'Edit unpaid purchases' },
      { key: 'purchases.edit_locked', label: 'Edit / cancel paid purchases' },
      { key: 'purchases.cancel', label: 'Cancel purchases' },
      { key: 'purchases.delete', label: 'Delete unpaid purchases permanently' }
    ]
  },
  {
    group: 'Inventory',
    items: [
      { key: 'inventory.view', label: 'View products & stock' },
      { key: 'inventory.manage', label: 'Create / edit products, categories, warehouses' },
      { key: 'inventory.adjust', label: 'Stock adjustments & opening stock' },
      { key: 'inventory.cost', label: 'See purchase cost & stock value' },
      { key: 'inventory.delete', label: 'Delete / archive products' }
    ]
  },
  {
    group: 'Customers & Suppliers',
    items: [
      { key: 'customers.view', label: 'View customers' },
      { key: 'customers.manage', label: 'Create / edit customers' },
      { key: 'suppliers.view', label: 'View suppliers' },
      { key: 'suppliers.manage', label: 'Create / edit suppliers' }
    ]
  },
  {
    group: 'Solar Projects',
    items: [
      { key: 'projects.view', label: 'View projects' },
      { key: 'projects.manage', label: 'Create / edit projects & issue materials' },
      { key: 'projects.financials', label: 'See project cost & profit' },
      { key: 'projects.delete', label: 'Delete / archive projects' }
    ]
  },
  {
    group: 'Accounts & Expenses',
    items: [
      { key: 'accounts.view', label: 'View cash / bank accounts & payments' },
      { key: 'accounts.manage', label: 'Receive / make payments, transfers, adjustments' },
      { key: 'expenses.view', label: 'View expenses' },
      { key: 'expenses.manage', label: 'Record / edit expenses' },
      { key: 'closing.manage', label: 'Day & month closing' },
      { key: 'closing.reopen', label: 'Reopen a closed day / month' }
    ]
  },
  {
    group: 'Reports',
    items: [
      { key: 'reports.view', label: 'View sales, purchase & stock reports' },
      { key: 'reports.profit', label: 'View profit & loss and margin reports' },
      { key: 'reports.consolidated', label: 'View consolidated (all firms) reports' }
    ]
  },
  {
    group: 'Administration',
    items: [
      { key: 'users.manage', label: 'Manage users & roles' },
      { key: 'audit.view', label: 'View audit log' },
      { key: 'firms.manage', label: 'Manage firms & multi-firm settings' },
      { key: 'settings.manage', label: 'Change application settings' },
      { key: 'backup.manage', label: 'Backup & restore' },
      { key: 'import.manage', label: 'Import data (CSV / other software backups)' },
      { key: 'printers.manage', label: 'Printer settings' },
      { key: 'templates.manage', label: 'Design invoice / quotation templates' },
      { key: 'whatsapp.send', label: 'Send documents on WhatsApp' },
      { key: 'support.use', label: 'Send support messages to Digital Target' },
      { key: 'license.view', label: 'View license information' },
      { key: 'license.manage', label: 'Activate / change license' }
    ]
  }
]

export const ALL_PERMISSIONS: string[] = PERMISSION_GROUPS.flatMap((g) => g.items.map((i) => i.key))

const without = (exclude: string[]): string[] => ALL_PERMISSIONS.filter((p) => !exclude.includes(p))

export interface DefaultRole {
  name: string
  description: string
  permissions: string[]
}

export const DEFAULT_ROLES: DefaultRole[] = [
  { name: 'Super Administrator', description: 'Business owner. Full access to everything.', permissions: ALL_PERMISSIONS },
  {
    name: 'Administrator',
    description: 'Full operational access except license management.',
    permissions: without(['license.manage'])
  },
  {
    name: 'Accountant',
    description: 'Accounts, payments, expenses and financial reports.',
    permissions: [
      'dashboard.view', 'dashboard.financials', 'sales.view', 'quotations.view', 'purchases.view', 'inventory.view',
      'inventory.cost', 'customers.view', 'customers.manage', 'suppliers.view', 'suppliers.manage', 'projects.view',
      'projects.financials', 'accounts.view', 'accounts.manage', 'expenses.view', 'expenses.manage', 'reports.view',
      'reports.profit', 'license.view', 'closing.manage', 'whatsapp.send'
    ]
  },
  {
    name: 'Salesperson',
    description: 'Quotations, sales invoices and customers.',
    permissions: [
      'dashboard.view', 'sales.view', 'sales.create', 'sales.edit', 'quotations.view', 'quotations.manage',
      'inventory.view', 'customers.view', 'customers.manage', 'projects.view', 'accounts.view', 'whatsapp.send', 'crm.view', 'crm.manage'
    ]
  },
  {
    name: 'Inventory Manager',
    description: 'Products, stock, warehouses and purchases.',
    permissions: [
      'dashboard.view', 'inventory.view', 'inventory.manage', 'inventory.adjust', 'inventory.cost', 'purchases.view',
      'purchases.create', 'purchases.edit', 'suppliers.view', 'suppliers.manage', 'projects.view', 'reports.view'
    ]
  },
  {
    name: 'Project Manager',
    description: 'Solar projects, material issues and project costs.',
    permissions: [
      'dashboard.view', 'projects.view', 'projects.manage', 'projects.financials', 'inventory.view', 'customers.view',
      'quotations.view', 'quotations.manage', 'sales.view', 'expenses.view', 'expenses.manage', 'reports.view', 'whatsapp.send', 'crm.view'
    ]
  }
]

export const OWNER_ROLE_NAME = 'Super Administrator'

/**
 * Permissions introduced after v1.0, by catalogue version. On upgrade they are added to the matching built-in
 * roles so existing installations get the new features without the owner editing every role.
 */
export const PERMISSION_UPGRADES: Array<{ version: number; perms: string[] }> = [
  {
    version: 2,
    perms: [
      'sales.delete', 'purchases.delete', 'inventory.delete', 'projects.delete', 'closing.manage', 'closing.reopen',
      'import.manage', 'printers.manage', 'templates.manage', 'whatsapp.send', 'support.use'
    ]
  },
  { version: 3, perms: ['crm.view', 'crm.manage'] }
]
export const PERMISSION_CATALOGUE_VERSION = 3
