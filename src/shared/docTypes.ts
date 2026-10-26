/** Metadata for every business document type. */
export type SalesDocType = 'sale_invoice' | 'quotation' | 'sale_order' | 'delivery_challan' | 'sale_return'
export type PurchaseDocType = 'purchase_invoice' | 'purchase_order' | 'purchase_return'
export type DocType = SalesDocType | PurchaseDocType

/** Every numbered entity (documents + vouchers). */
export type SequenceType =
  | DocType
  | 'receipt'
  | 'payment'
  | 'expense'
  | 'transfer'
  | 'adjustment'
  | 'project'
  | 'material_issue'
  | 'material_return'
  | 'party_adjustment'
  | 'service_ticket'
  | 'employee'

export interface DocTypeMeta {
  type: DocType
  label: string
  plural: string
  side: 'sales' | 'purchase'
  partyType: 'customer' | 'supplier'
  /** +1 stock in, -1 stock out, 0 no stock effect */
  stock: 1 | -1 | 0
  /** Affects party ledger & profit */
  financial: boolean
  /** Permission prefix */
  perm: 'sales' | 'quotations' | 'purchases'
}

export const DOC_TYPES: Record<DocType, DocTypeMeta> = {
  sale_invoice: { type: 'sale_invoice', label: 'Sales Invoice', plural: 'Sales Invoices', side: 'sales', partyType: 'customer', stock: -1, financial: true, perm: 'sales' },
  quotation: { type: 'quotation', label: 'Quotation', plural: 'Quotations', side: 'sales', partyType: 'customer', stock: 0, financial: false, perm: 'quotations' },
  sale_order: { type: 'sale_order', label: 'Sales Order', plural: 'Sales Orders', side: 'sales', partyType: 'customer', stock: 0, financial: false, perm: 'sales' },
  delivery_challan: { type: 'delivery_challan', label: 'Delivery Challan', plural: 'Delivery Challans', side: 'sales', partyType: 'customer', stock: 0, financial: false, perm: 'sales' },
  sale_return: { type: 'sale_return', label: 'Sales Return / Credit Note', plural: 'Sales Returns', side: 'sales', partyType: 'customer', stock: 1, financial: true, perm: 'sales' },
  purchase_invoice: { type: 'purchase_invoice', label: 'Purchase Invoice', plural: 'Purchase Invoices', side: 'purchase', partyType: 'supplier', stock: 1, financial: true, perm: 'purchases' },
  purchase_order: { type: 'purchase_order', label: 'Purchase Order', plural: 'Purchase Orders', side: 'purchase', partyType: 'supplier', stock: 0, financial: false, perm: 'purchases' },
  purchase_return: { type: 'purchase_return', label: 'Purchase Return / Debit Note', plural: 'Purchase Returns', side: 'purchase', partyType: 'supplier', stock: -1, financial: true, perm: 'purchases' }
}

export const DEFAULT_PREFIXES: Record<SequenceType, string> = {
  sale_invoice: 'INV-',
  quotation: 'QT-',
  sale_order: 'SO-',
  delivery_challan: 'DC-',
  sale_return: 'CN-',
  purchase_invoice: 'PI-',
  purchase_order: 'PO-',
  purchase_return: 'DN-',
  receipt: 'RV-',
  payment: 'PV-',
  expense: 'EXP-',
  transfer: 'TRF-',
  adjustment: 'ADJ-',
  project: 'PRJ-',
  material_issue: 'MI-',
  material_return: 'MR-',
  party_adjustment: 'JV-',
  service_ticket: 'SRV-',
  employee: 'EMP-'
}

export const SEQUENCE_LABELS: Record<SequenceType, string> = {
  sale_invoice: 'Sales Invoice',
  quotation: 'Quotation',
  sale_order: 'Sales Order',
  delivery_challan: 'Delivery Challan',
  sale_return: 'Sales Return (Credit Note)',
  purchase_invoice: 'Purchase Invoice',
  purchase_order: 'Purchase Order',
  purchase_return: 'Purchase Return (Debit Note)',
  receipt: 'Payment Receipt',
  payment: 'Payment Voucher',
  expense: 'Expense',
  transfer: 'Account Transfer',
  adjustment: 'Stock Adjustment',
  project: 'Solar Project',
  material_issue: 'Material Issue',
  material_return: 'Material Return',
  party_adjustment: 'Party Adjustment (Journal)',
  service_ticket: 'Service Ticket',
  employee: 'Employee Code'
}

export const PROJECT_STATUSES = ['planning', 'quoted', 'in_progress', 'on_hold', 'completed', 'cancelled'] as const
export type ProjectStatus = (typeof PROJECT_STATUSES)[number]
export const PROJECT_STATUS_LABELS: Record<ProjectStatus, string> = {
  planning: 'Planning',
  quoted: 'Quoted',
  in_progress: 'In Progress',
  on_hold: 'On Hold',
  completed: 'Completed',
  cancelled: 'Cancelled'
}
export const PROJECT_TYPES = ['residential', 'commercial', 'industrial', 'agricultural', 'other'] as const
export const SYSTEM_TYPES = ['on_grid', 'off_grid', 'hybrid'] as const
export const SYSTEM_TYPE_LABELS: Record<string, string> = { on_grid: 'On-Grid', off_grid: 'Off-Grid', hybrid: 'Hybrid' }

export const COST_HEADS = ['material', 'labor', 'contractor', 'transport', 'other', 'overhead'] as const
export type CostHead = (typeof COST_HEADS)[number]
export const COST_HEAD_LABELS: Record<CostHead, string> = {
  material: 'Direct Material',
  labor: 'Installation Labor',
  contractor: 'Contractor Charges',
  transport: 'Transportation & Delivery',
  other: 'Other Direct Cost',
  overhead: 'General / Overhead'
}

export const PAYMENT_METHODS = ['cash', 'bank_transfer', 'cheque', 'online', 'card', 'other'] as const
export const PAYMENT_METHOD_LABELS: Record<string, string> = {
  cash: 'Cash',
  bank_transfer: 'Bank Transfer',
  cheque: 'Cheque',
  online: 'Online / Mobile Wallet',
  card: 'Card',
  other: 'Other'
}
