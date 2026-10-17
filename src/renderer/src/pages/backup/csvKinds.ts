/** Entity picker shared by the CSV import and export cards (owner: data area). Keys match importer.IMPORT_KINDS. */
export type CsvKind = 'products' | 'categories' | 'customers' | 'suppliers' | 'sales' | 'purchases' | 'payments' | 'expenses' | 'stock'

export const CSV_KINDS: Array<{ key: CsvKind; label: string; importNote: string; exportNote: string }> = [
  { key: 'categories', label: 'Product categories', importNote: 'Name and kind (goods / service).', exportNote: '' },
  {
    key: 'products',
    label: 'Products (with opening stock)',
    importNote: 'Opening stock of new products goes to the default warehouse at the opening unit cost (or the purchase price). Existing products never change stock here - use “Stock levels”.',
    exportNote: 'Opening qty / cost are the opening-stock entries only; current stock is in the “Stock levels” export.'
  },
  {
    key: 'customers',
    label: 'Customers (with opening balance)',
    importNote: 'Opening balance: positive = the customer owes you, negative = advance. Matched by name + phone.',
    exportNote: 'Opening balance: positive = the customer owes you.'
  },
  {
    key: 'suppliers',
    label: 'Suppliers (with opening balance)',
    importNote: 'Opening balance: positive = you owe the supplier, negative = advance paid. Matched by name + phone.',
    exportNote: 'Opening balance: positive = you owe the supplier.'
  },
  {
    key: 'sales',
    label: 'Sales invoices (one row per line)',
    importNote:
      'One row per invoice line; rows with the same invoice no form one invoice. Items link to products by SKU, then by name (unknown items become text lines). Stock and the customer balance are updated like a normal invoice. Existing invoice numbers are skipped, never changed.',
    exportNote: '“Paid amount” is only the payment taken at billing; all other receipts are in the Payments export.'
  },
  {
    key: 'purchases',
    label: 'Purchase invoices (one row per line)',
    importNote: 'One row per invoice line, grouped by invoice no. Stock, average cost and the supplier balance are updated like a normal purchase. Existing invoice numbers are skipped.',
    exportNote: '“Paid amount” is only the payment made at billing; all other payments are in the Payments export.'
  },
  {
    key: 'payments',
    label: 'Payments & receipts',
    importNote: 'Direction in / out, party by name (+ phone), account by name. “Against” settles invoices / expenses: INV-0001:500; INV-0002:250. Import invoices first.',
    exportNote: 'Payments taken at billing are exported with their invoice instead.'
  },
  { key: 'expenses', label: 'Expenses', importNote: 'Missing expense categories are created. An unpaid expense needs a supplier / contractor.', exportNote: '' },
  {
    key: 'stock',
    label: 'Stock levels (stock count)',
    importNote: 'Sets the counted qty per product + warehouse through a stock adjustment dated today (the difference only). Import products first.',
    exportNote: 'Current qty on hand per warehouse at the average cost.'
  }
]

export const RECOMMENDED_ORDER = 'categories → products → customers → suppliers → purchases → sales → expenses → payments → stock levels'
