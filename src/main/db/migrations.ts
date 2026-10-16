/**
 * Database migrations.
 *
 * RULES (never break these — customer data depends on it):
 *  - Never edit a migration that has shipped. Add a new one with the next version.
 *  - Never DROP a table or column holding business data.
 *  - Each migration runs inside a transaction; a failure rolls back that migration only.
 *  - The app takes an automatic file backup before applying pending migrations.
 */
export interface Migration {
  version: number
  name: string
  sql: string
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'initial schema',
    sql: /* sql */ `
CREATE TABLE IF NOT EXISTS app_meta (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE firms (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  tagline TEXT,
  address TEXT,
  city TEXT,
  phone TEXT,
  phone2 TEXT,
  email TEXT,
  website TEXT,
  ntn TEXT,
  strn TEXT,
  logo TEXT,
  signature TEXT,
  stamp TEXT,
  bank_details TEXT,
  terms TEXT,
  invoice_footer TEXT,
  print_settings TEXT NOT NULL DEFAULT '{}',
  is_default INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  updated_at TEXT
);

CREATE TABLE doc_sequences (
  firm_id INTEGER NOT NULL REFERENCES firms(id),
  doc_type TEXT NOT NULL,
  prefix TEXT NOT NULL,
  next_no INTEGER NOT NULL DEFAULT 1,
  padding INTEGER NOT NULL DEFAULT 5,
  PRIMARY KEY (firm_id, doc_type)
);

CREATE TABLE roles (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  description TEXT,
  permissions TEXT NOT NULL DEFAULT '[]',
  is_system INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE users (
  id INTEGER PRIMARY KEY,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  full_name TEXT NOT NULL,
  email TEXT,
  phone TEXT,
  password_hash TEXT NOT NULL,
  role_id INTEGER NOT NULL REFERENCES roles(id),
  is_owner INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1,
  all_firms INTEGER NOT NULL DEFAULT 1,
  must_change_password INTEGER NOT NULL DEFAULT 0,
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT,
  last_login_at TEXT,
  last_firm_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  updated_at TEXT
);

CREATE TABLE user_firms (
  user_id INTEGER NOT NULL REFERENCES users(id),
  firm_id INTEGER NOT NULL REFERENCES firms(id),
  PRIMARY KEY (user_id, firm_id)
);

CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY,
  ts TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  user_id INTEGER,
  username TEXT,
  firm_id INTEGER,
  action TEXT NOT NULL,
  entity TEXT,
  entity_id INTEGER,
  summary TEXT,
  details TEXT
);
CREATE INDEX idx_audit_ts ON audit_log(ts);
CREATE INDEX idx_audit_entity ON audit_log(entity, entity_id);

CREATE TABLE warehouses (
  id INTEGER PRIMARY KEY,
  firm_id INTEGER REFERENCES firms(id),
  name TEXT NOT NULL,
  address TEXT,
  is_default INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE categories (
  id INTEGER PRIMARY KEY,
  firm_id INTEGER REFERENCES firms(id),
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'goods',
  is_active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE products (
  id INTEGER PRIMARY KEY,
  firm_id INTEGER REFERENCES firms(id),
  category_id INTEGER REFERENCES categories(id),
  name TEXT NOT NULL,
  sku TEXT,
  barcode TEXT,
  type TEXT NOT NULL DEFAULT 'goods' CHECK (type IN ('goods','service')),
  unit TEXT NOT NULL DEFAULT 'pcs',
  brand TEXT,
  model TEXT,
  description TEXT,
  purchase_price REAL NOT NULL DEFAULT 0,
  sale_price REAL NOT NULL DEFAULT 0,
  min_sale_price REAL NOT NULL DEFAULT 0,
  tax_rate REAL NOT NULL DEFAULT 0,
  avg_cost REAL NOT NULL DEFAULT 0,
  reorder_level REAL NOT NULL DEFAULT 0,
  track_serial INTEGER NOT NULL DEFAULT 0,
  warranty_months INTEGER NOT NULL DEFAULT 0,
  warranty_terms TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_by INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  updated_at TEXT
);
CREATE INDEX idx_products_name ON products(name);
CREATE UNIQUE INDEX idx_products_sku ON products(sku) WHERE sku IS NOT NULL AND sku <> '';

CREATE TABLE stock_levels (
  product_id INTEGER NOT NULL REFERENCES products(id),
  warehouse_id INTEGER NOT NULL REFERENCES warehouses(id),
  qty REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (product_id, warehouse_id)
);

CREATE TABLE stock_movements (
  id INTEGER PRIMARY KEY,
  date TEXT NOT NULL,
  firm_id INTEGER NOT NULL REFERENCES firms(id),
  product_id INTEGER NOT NULL REFERENCES products(id),
  warehouse_id INTEGER NOT NULL REFERENCES warehouses(id),
  qty_in REAL NOT NULL DEFAULT 0,
  qty_out REAL NOT NULL DEFAULT 0,
  unit_cost REAL NOT NULL DEFAULT 0,
  avg_cost_after REAL NOT NULL DEFAULT 0,
  ref_type TEXT NOT NULL,
  ref_id INTEGER,
  ref_line_id INTEGER,
  ref_number TEXT,
  project_id INTEGER,
  batch_no TEXT,
  is_reversal INTEGER NOT NULL DEFAULT 0,
  reversed INTEGER NOT NULL DEFAULT 0,
  notes TEXT,
  created_by INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX idx_mov_product ON stock_movements(product_id, date);
CREATE INDEX idx_mov_ref ON stock_movements(ref_type, ref_id);

CREATE TABLE stock_adjustments (
  id INTEGER PRIMARY KEY,
  firm_id INTEGER NOT NULL REFERENCES firms(id),
  number TEXT NOT NULL,
  date TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'adjustment' CHECK (kind IN ('opening','adjustment')),
  warehouse_id INTEGER NOT NULL REFERENCES warehouses(id),
  reason TEXT,
  notes TEXT,
  total_value REAL NOT NULL DEFAULT 0,
  created_by INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  UNIQUE (firm_id, number)
);

CREATE TABLE stock_adjustment_lines (
  id INTEGER PRIMARY KEY,
  adjustment_id INTEGER NOT NULL REFERENCES stock_adjustments(id),
  product_id INTEGER NOT NULL REFERENCES products(id),
  qty REAL NOT NULL,
  unit_cost REAL NOT NULL DEFAULT 0,
  value REAL NOT NULL DEFAULT 0,
  serials TEXT,
  batch_no TEXT
);

CREATE TABLE serials (
  id INTEGER PRIMARY KEY,
  product_id INTEGER NOT NULL REFERENCES products(id),
  serial TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'in_stock',
  warehouse_id INTEGER,
  in_ref_type TEXT,
  in_ref_id INTEGER,
  out_ref_type TEXT,
  out_ref_id INTEGER,
  party_id INTEGER,
  project_id INTEGER,
  out_date TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  UNIQUE (product_id, serial)
);
CREATE INDEX idx_serials_serial ON serials(serial);

CREATE TABLE parties (
  id INTEGER PRIMARY KEY,
  firm_id INTEGER REFERENCES firms(id),
  type TEXT NOT NULL CHECK (type IN ('customer','supplier','both')),
  name TEXT NOT NULL,
  contact_person TEXT,
  phone TEXT,
  phone2 TEXT,
  email TEXT,
  address TEXT,
  city TEXT,
  cnic TEXT,
  ntn TEXT,
  strn TEXT,
  opening_balance REAL NOT NULL DEFAULT 0,
  opening_firm_id INTEGER REFERENCES firms(id),
  opening_date TEXT,
  credit_limit REAL NOT NULL DEFAULT 0,
  payment_terms_days INTEGER NOT NULL DEFAULT 0,
  notes TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_by INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  updated_at TEXT
);
CREATE INDEX idx_parties_name ON parties(name);

CREATE TABLE projects (
  id INTEGER PRIMARY KEY,
  firm_id INTEGER NOT NULL REFERENCES firms(id),
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  customer_id INTEGER REFERENCES parties(id),
  contact_person TEXT,
  contact_phone TEXT,
  site_address TEXT,
  city TEXT,
  capacity_kw REAL NOT NULL DEFAULT 0,
  project_type TEXT NOT NULL DEFAULT 'residential',
  system_type TEXT NOT NULL DEFAULT 'on_grid',
  start_date TEXT,
  expected_end_date TEXT,
  completed_date TEXT,
  manager_user_id INTEGER REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'planning',
  progress INTEGER NOT NULL DEFAULT 0,
  quotation_id INTEGER,
  contract_amount REAL NOT NULL DEFAULT 0,
  overhead_amount REAL NOT NULL DEFAULT 0,
  warranty_info TEXT,
  notes TEXT,
  created_by INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  updated_at TEXT,
  UNIQUE (firm_id, code)
);

CREATE TABLE documents (
  id INTEGER PRIMARY KEY,
  firm_id INTEGER NOT NULL REFERENCES firms(id),
  doc_type TEXT NOT NULL,
  number TEXT NOT NULL,
  date TEXT NOT NULL,
  due_date TEXT,
  valid_until TEXT,
  party_id INTEGER REFERENCES parties(id),
  party_name TEXT,
  party_phone TEXT,
  party_address TEXT,
  project_id INTEGER REFERENCES projects(id),
  warehouse_id INTEGER REFERENCES warehouses(id),
  status TEXT NOT NULL DEFAULT 'final',
  is_tax_invoice INTEGER NOT NULL DEFAULT 0,
  deduct_stock INTEGER NOT NULL DEFAULT 1,
  direct_to_project INTEGER NOT NULL DEFAULT 0,
  subtotal REAL NOT NULL DEFAULT 0,
  line_discount_total REAL NOT NULL DEFAULT 0,
  doc_discount REAL NOT NULL DEFAULT 0,
  tax_total REAL NOT NULL DEFAULT 0,
  other_charges REAL NOT NULL DEFAULT 0,
  other_charges_label TEXT,
  round_off REAL NOT NULL DEFAULT 0,
  net_total REAL NOT NULL DEFAULT 0,
  grand_total REAL NOT NULL DEFAULT 0,
  cost_total REAL NOT NULL DEFAULT 0,
  ref_doc_id INTEGER REFERENCES documents(id),
  party_ref TEXT,
  notes TEXT,
  terms TEXT,
  created_by INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  updated_by INTEGER,
  updated_at TEXT,
  cancelled_by INTEGER,
  cancelled_at TEXT,
  cancel_reason TEXT,
  UNIQUE (firm_id, doc_type, number)
);
CREATE INDEX idx_docs_type_date ON documents(firm_id, doc_type, date);
CREATE INDEX idx_docs_party ON documents(party_id);
CREATE INDEX idx_docs_project ON documents(project_id);

CREATE TABLE document_lines (
  id INTEGER PRIMARY KEY,
  document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  line_no INTEGER NOT NULL DEFAULT 0,
  product_id INTEGER REFERENCES products(id),
  description TEXT NOT NULL,
  unit TEXT,
  qty REAL NOT NULL DEFAULT 0,
  rate REAL NOT NULL DEFAULT 0,
  discount_pct REAL NOT NULL DEFAULT 0,
  discount_amt REAL NOT NULL DEFAULT 0,
  tax_rate REAL NOT NULL DEFAULT 0,
  tax_amt REAL NOT NULL DEFAULT 0,
  net_amount REAL NOT NULL DEFAULT 0,
  line_total REAL NOT NULL DEFAULT 0,
  unit_cost REAL NOT NULL DEFAULT 0,
  cost_total REAL NOT NULL DEFAULT 0,
  serials TEXT,
  batch_no TEXT,
  warranty TEXT,
  ref_line_id INTEGER
);
CREATE INDEX idx_lines_doc ON document_lines(document_id);
CREATE INDEX idx_lines_product ON document_lines(product_id);

CREATE TABLE accounts (
  id INTEGER PRIMARY KEY,
  firm_id INTEGER NOT NULL REFERENCES firms(id),
  name TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'cash' CHECK (type IN ('cash','bank','wallet')),
  bank_name TEXT,
  account_title TEXT,
  account_no TEXT,
  iban TEXT,
  opening_balance REAL NOT NULL DEFAULT 0,
  is_default INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE payments (
  id INTEGER PRIMARY KEY,
  firm_id INTEGER NOT NULL REFERENCES firms(id),
  number TEXT NOT NULL,
  date TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('in','out')),
  party_id INTEGER REFERENCES parties(id),
  account_id INTEGER NOT NULL REFERENCES accounts(id),
  amount REAL NOT NULL CHECK (amount > 0),
  method TEXT NOT NULL DEFAULT 'cash',
  reference TEXT,
  project_id INTEGER REFERENCES projects(id),
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'final',
  created_by INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  updated_by INTEGER,
  updated_at TEXT,
  cancelled_by INTEGER,
  cancelled_at TEXT,
  cancel_reason TEXT,
  UNIQUE (firm_id, direction, number)
);
CREATE INDEX idx_payments_party ON payments(party_id);
CREATE INDEX idx_payments_date ON payments(firm_id, date);

CREATE TABLE expense_categories (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  cost_head TEXT NOT NULL DEFAULT 'overhead',
  is_active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE expenses (
  id INTEGER PRIMARY KEY,
  firm_id INTEGER NOT NULL REFERENCES firms(id),
  number TEXT NOT NULL,
  date TEXT NOT NULL,
  category_id INTEGER NOT NULL REFERENCES expense_categories(id),
  project_id INTEGER REFERENCES projects(id),
  amount REAL NOT NULL CHECK (amount > 0),
  paid INTEGER NOT NULL DEFAULT 1,
  account_id INTEGER REFERENCES accounts(id),
  party_id INTEGER REFERENCES parties(id),
  payee_name TEXT,
  method TEXT,
  reference TEXT,
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'final',
  created_by INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  updated_by INTEGER,
  updated_at TEXT,
  cancelled_by INTEGER,
  cancelled_at TEXT,
  cancel_reason TEXT,
  UNIQUE (firm_id, number)
);
CREATE INDEX idx_expenses_project ON expenses(project_id);

CREATE TABLE payment_allocations (
  id INTEGER PRIMARY KEY,
  payment_id INTEGER NOT NULL REFERENCES payments(id),
  document_id INTEGER REFERENCES documents(id),
  expense_id INTEGER REFERENCES expenses(id),
  amount REAL NOT NULL CHECK (amount > 0),
  CHECK ((document_id IS NOT NULL) <> (expense_id IS NOT NULL))
);
CREATE INDEX idx_alloc_payment ON payment_allocations(payment_id);
CREATE INDEX idx_alloc_doc ON payment_allocations(document_id);
CREATE INDEX idx_alloc_exp ON payment_allocations(expense_id);

CREATE TABLE account_transfers (
  id INTEGER PRIMARY KEY,
  firm_id INTEGER NOT NULL REFERENCES firms(id),
  number TEXT NOT NULL,
  date TEXT NOT NULL,
  from_account_id INTEGER NOT NULL REFERENCES accounts(id),
  to_account_id INTEGER NOT NULL REFERENCES accounts(id),
  amount REAL NOT NULL CHECK (amount > 0),
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'final',
  created_by INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  cancelled_by INTEGER,
  cancelled_at TEXT,
  UNIQUE (firm_id, number)
);

CREATE TABLE party_adjustments (
  id INTEGER PRIMARY KEY,
  firm_id INTEGER NOT NULL REFERENCES firms(id),
  number TEXT NOT NULL,
  date TEXT NOT NULL,
  party_id INTEGER NOT NULL REFERENCES parties(id),
  direction TEXT NOT NULL CHECK (direction IN ('debit','credit')),
  amount REAL NOT NULL CHECK (amount > 0),
  reason TEXT,
  project_id INTEGER REFERENCES projects(id),
  status TEXT NOT NULL DEFAULT 'final',
  created_by INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  cancelled_by INTEGER,
  cancelled_at TEXT,
  UNIQUE (firm_id, number)
);

CREATE TABLE material_moves (
  id INTEGER PRIMARY KEY,
  firm_id INTEGER NOT NULL REFERENCES firms(id),
  project_id INTEGER NOT NULL REFERENCES projects(id),
  direction TEXT NOT NULL CHECK (direction IN ('issue','return')),
  number TEXT NOT NULL,
  date TEXT NOT NULL,
  warehouse_id INTEGER NOT NULL REFERENCES warehouses(id),
  total_cost REAL NOT NULL DEFAULT 0,
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'final',
  created_by INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  cancelled_by INTEGER,
  cancelled_at TEXT,
  UNIQUE (firm_id, direction, number)
);

CREATE TABLE material_move_lines (
  id INTEGER PRIMARY KEY,
  move_id INTEGER NOT NULL REFERENCES material_moves(id),
  product_id INTEGER NOT NULL REFERENCES products(id),
  qty REAL NOT NULL CHECK (qty > 0),
  unit_cost REAL NOT NULL DEFAULT 0,
  cost_total REAL NOT NULL DEFAULT 0,
  serials TEXT,
  notes TEXT
);

CREATE TABLE attachments (
  id INTEGER PRIMARY KEY,
  entity TEXT NOT NULL,
  entity_id INTEGER NOT NULL,
  file_name TEXT NOT NULL,
  stored_name TEXT NOT NULL,
  size INTEGER NOT NULL DEFAULT 0,
  created_by INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX idx_attach_entity ON attachments(entity, entity_id);

CREATE TABLE tax_rates (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  rate REAL NOT NULL DEFAULT 0,
  is_default INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1
);
`
  },
  {
    version: 2,
    name: 'v1.1 business features: item details, PIN login, archive, day/month closing, templates, support queue, WhatsApp log, imports',
    sql: /* sql */ `
-- Item description printed under the item name (the existing "description" column holds the item name/line title).
ALTER TABLE document_lines ADD COLUMN details TEXT;

-- Optional PIN login (scrypt hash, never stored in plain text).
ALTER TABLE users ADD COLUMN pin_hash TEXT;
ALTER TABLE users ADD COLUMN pin_failed_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN pin_locked_until TEXT;

-- Archive instead of destructive delete for records with history.
ALTER TABLE projects ADD COLUMN is_archived INTEGER NOT NULL DEFAULT 0;
ALTER TABLE projects ADD COLUMN archived_at TEXT;
ALTER TABLE products ADD COLUMN archived_at TEXT;

-- Day / month closing. One row per firm + kind + period; re-closing a reopened period updates the same row.
CREATE TABLE day_closings (
  id INTEGER PRIMARY KEY,
  firm_id INTEGER NOT NULL REFERENCES firms(id),
  kind TEXT NOT NULL CHECK (kind IN ('day','month')),
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  opening_cash REAL NOT NULL DEFAULT 0,
  cash_in REAL NOT NULL DEFAULT 0,
  cash_out REAL NOT NULL DEFAULT 0,
  closing_cash REAL NOT NULL DEFAULT 0,
  counted_cash REAL,
  difference REAL NOT NULL DEFAULT 0,
  sales_total REAL NOT NULL DEFAULT 0,
  purchases_total REAL NOT NULL DEFAULT 0,
  expenses_total REAL NOT NULL DEFAULT 0,
  receipts_total REAL NOT NULL DEFAULT 0,
  payments_total REAL NOT NULL DEFAULT 0,
  summary TEXT NOT NULL DEFAULT '{}',
  notes TEXT,
  backup_file TEXT,
  status TEXT NOT NULL DEFAULT 'closed' CHECK (status IN ('closed','reopened')),
  closed_by INTEGER REFERENCES users(id),
  closed_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  reopened_by INTEGER REFERENCES users(id),
  reopened_at TEXT,
  reopen_reason TEXT,
  UNIQUE (firm_id, kind, period_start)
);
CREATE INDEX idx_closings_period ON day_closings(firm_id, kind, period_start);

-- Saved invoice / quotation print templates (layout + visible fields).
CREATE TABLE doc_templates (
  id INTEGER PRIMARY KEY,
  firm_id INTEGER REFERENCES firms(id),
  name TEXT NOT NULL,
  applies_to TEXT NOT NULL DEFAULT 'all',
  layout TEXT NOT NULL DEFAULT 'classic',
  options TEXT NOT NULL DEFAULT '{}',
  is_default INTEGER NOT NULL DEFAULT 0,
  created_by INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  updated_at TEXT
);

-- Support messages to / from Digital Target. Outgoing messages are queued offline and synced later.
CREATE TABLE support_messages (
  id INTEGER PRIMARY KEY,
  uid TEXT NOT NULL UNIQUE,
  direction TEXT NOT NULL CHECK (direction IN ('out','in')),
  body TEXT NOT NULL,
  author TEXT,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','sending','sent','failed','received')),
  error TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_by INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  sent_at TEXT,
  remote_at TEXT,
  read_at TEXT
);

-- WhatsApp send log (status + duplicate-send guard).
CREATE TABLE whatsapp_log (
  id INTEGER PRIMARY KEY,
  firm_id INTEGER REFERENCES firms(id),
  party_id INTEGER REFERENCES parties(id),
  phone TEXT NOT NULL,
  entity TEXT,
  entity_id INTEGER,
  file_name TEXT,
  method TEXT NOT NULL CHECK (method IN ('chat_link','cloud_api')),
  status TEXT NOT NULL,
  message_id TEXT,
  error TEXT,
  dedupe_key TEXT,
  created_by INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX idx_wa_dedupe ON whatsapp_log(dedupe_key, created_at);

-- Data import runs (CSV / external backup conversion) with reconciliation results.
CREATE TABLE import_runs (
  id INTEGER PRIMARY KEY,
  firm_id INTEGER REFERENCES firms(id),
  source TEXT NOT NULL,
  kind TEXT NOT NULL,
  file_name TEXT,
  mapping TEXT,
  total_rows INTEGER NOT NULL DEFAULT 0,
  imported INTEGER NOT NULL DEFAULT 0,
  skipped INTEGER NOT NULL DEFAULT 0,
  errors TEXT,
  reconciliation TEXT,
  created_by INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
`
  },
  {
    version: 8,
    name: 'assist: WhatsApp log supports the built-in WhatsApp Web module (method whatsapp_web); rows are copied, nothing is lost',
    sql: /* sql */ `
CREATE TABLE whatsapp_log_v8 (
  id INTEGER PRIMARY KEY,
  firm_id INTEGER REFERENCES firms(id),
  party_id INTEGER REFERENCES parties(id),
  phone TEXT NOT NULL,
  entity TEXT,
  entity_id INTEGER,
  file_name TEXT,
  method TEXT NOT NULL CHECK (method IN ('whatsapp_web','chat_link','cloud_api')),
  status TEXT NOT NULL,
  message_id TEXT,
  error TEXT,
  dedupe_key TEXT,
  created_by INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  updated_at TEXT
);
INSERT INTO whatsapp_log_v8 (id, firm_id, party_id, phone, entity, entity_id, file_name, method, status, message_id, error, dedupe_key, created_by, created_at)
  SELECT id, firm_id, party_id, phone, entity, entity_id, file_name, method, status, message_id, error, dedupe_key, created_by, created_at FROM whatsapp_log;
DROP INDEX IF EXISTS idx_wa_dedupe;
DROP TABLE whatsapp_log;
ALTER TABLE whatsapp_log_v8 RENAME TO whatsapp_log;
CREATE INDEX idx_wa_dedupe ON whatsapp_log(dedupe_key, created_at);
CREATE INDEX idx_wa_firm ON whatsapp_log(firm_id, created_at);
`
  },
  {
    version: 9,
    name: 'legacy imports (verbatim archive + id map) and document-linked party adjustments (payment discounts)',
    sql: /* sql */ `
-- One row per imported legacy backup (e.g. a Vyapar .vyb file).
CREATE TABLE legacy_sources (
  id INTEGER PRIMARY KEY,
  system TEXT NOT NULL,
  file_name TEXT,
  file_sha256 TEXT,
  imported_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  summary TEXT
);
-- Every source row, verbatim (JSON), so no original value is ever lost — including fields the new schema cannot represent.
CREATE TABLE legacy_records (
  id INTEGER PRIMARY KEY,
  source_id INTEGER NOT NULL REFERENCES legacy_sources(id),
  table_name TEXT NOT NULL,
  legacy_id TEXT,
  data TEXT NOT NULL
);
CREATE INDEX idx_legacy_records ON legacy_records(source_id, table_name, legacy_id);
-- Old id -> new row, for every entity whose id could not be kept identical.
CREATE TABLE legacy_id_map (
  source_id INTEGER NOT NULL REFERENCES legacy_sources(id),
  entity TEXT NOT NULL,
  legacy_id TEXT NOT NULL,
  new_table TEXT NOT NULL,
  new_id INTEGER NOT NULL,
  note TEXT,
  PRIMARY KEY (source_id, entity, legacy_id, new_table)
);
-- A party adjustment (e.g. discount given while receiving a payment) can settle part of a specific invoice / bill.
ALTER TABLE party_adjustments ADD COLUMN document_id INTEGER REFERENCES documents(id);
CREATE INDEX idx_padj_doc ON party_adjustments(document_id);
`
  }
]

export const LATEST_SCHEMA_VERSION = Math.max(...MIGRATIONS.map((m) => m.version))
