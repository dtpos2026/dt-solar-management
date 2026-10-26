/**
 * Database migrations.
 *
 * RULES (never break these - customer data depends on it):
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
-- Every source row, verbatim (JSON), so no original value is ever lost - including fields the new schema cannot represent.
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
  },
  {
    version: 10,
    name: 'CRM: leads, follow-ups and activity timeline',
    sql: /* sql */ `
-- A sales enquiry before it becomes a customer. Belongs to the firm that is working on it.
CREATE TABLE leads (
  id INTEGER PRIMARY KEY,
  firm_id INTEGER NOT NULL REFERENCES firms(id),
  name TEXT NOT NULL,
  phone TEXT,
  email TEXT,
  city TEXT,
  address TEXT,
  source TEXT,
  interest TEXT,
  system_kw REAL,
  expected_value REAL NOT NULL DEFAULT 0,
  stage TEXT NOT NULL DEFAULT 'new',
  assigned_to INTEGER REFERENCES users(id) ON DELETE SET NULL,
  next_follow_up TEXT,
  last_contact_at TEXT,
  notes TEXT,
  lost_reason TEXT,
  party_id INTEGER REFERENCES parties(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  created_by INTEGER,
  updated_at TEXT,
  closed_at TEXT
);
CREATE INDEX idx_leads_stage ON leads(firm_id, stage);
CREATE INDEX idx_leads_follow ON leads(firm_id, next_follow_up);
-- Calls, WhatsApp chats, site visits, notes and stage changes of a lead, newest last.
CREATE TABLE lead_activities (
  id INTEGER PRIMARY KEY,
  lead_id INTEGER NOT NULL REFERENCES leads(id),
  kind TEXT NOT NULL,
  summary TEXT NOT NULL,
  at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  user_id INTEGER,
  username TEXT
);
CREATE INDEX idx_lead_act ON lead_activities(lead_id, at);
`
  },
  {
    version: 11,
    name: 'Billing name of a customer or supplier (printed instead of the usual name when the option is on)',
    sql: /* sql */ `
ALTER TABLE parties ADD COLUMN billing_name TEXT;
`
  },
  {
    version: 12,
    name: 'POS (shifts, counter sales, held bills), cheques, service tickets, HR and payroll',
    sql: /* sql */ `
-- Point of sale: one cash drawer shift per cashier, the counter sales made in it, drawer cash in and out, parked bills.
CREATE TABLE pos_shifts (
  id INTEGER PRIMARY KEY,
  firm_id INTEGER NOT NULL REFERENCES firms(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  opened_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  opening_cash REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'open',
  closed_at TEXT,
  expected_cash REAL,
  counted_cash REAL,
  difference REAL,
  notes TEXT
);
CREATE INDEX idx_pos_shifts ON pos_shifts(firm_id, user_id, status);
CREATE TABLE pos_sales (
  document_id INTEGER PRIMARY KEY REFERENCES documents(id),
  shift_id INTEGER REFERENCES pos_shifts(id),
  cashier_id INTEGER REFERENCES users(id),
  tendered REAL NOT NULL DEFAULT 0,
  change_given REAL NOT NULL DEFAULT 0,
  cash_in REAL NOT NULL DEFAULT 0
);
CREATE INDEX idx_pos_sales_shift ON pos_sales(shift_id);
CREATE TABLE pos_cash_moves (
  id INTEGER PRIMARY KEY,
  shift_id INTEGER NOT NULL REFERENCES pos_shifts(id),
  kind TEXT NOT NULL,
  amount REAL NOT NULL,
  reason TEXT,
  at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  user_id INTEGER
);
CREATE TABLE pos_holds (
  id INTEGER PRIMARY KEY,
  firm_id INTEGER NOT NULL REFERENCES firms(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  label TEXT,
  cart TEXT NOT NULL,
  total REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

-- Cheque register: received (post-dated) and issued cheques; clearing one books the payment.
CREATE TABLE cheques (
  id INTEGER PRIMARY KEY,
  firm_id INTEGER NOT NULL REFERENCES firms(id),
  direction TEXT NOT NULL,
  cheque_no TEXT NOT NULL,
  bank TEXT,
  party_id INTEGER REFERENCES parties(id),
  amount REAL NOT NULL,
  cheque_date TEXT NOT NULL,
  received_date TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  account_id INTEGER REFERENCES accounts(id),
  payment_id INTEGER REFERENCES payments(id),
  document_id INTEGER REFERENCES documents(id),
  notes TEXT,
  cleared_at TEXT,
  bounce_reason TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  created_by INTEGER,
  updated_at TEXT
);
CREATE INDEX idx_cheques ON cheques(firm_id, status, cheque_date);

-- After-sales service and warranty tickets with their activity timeline.
CREATE TABLE service_tickets (
  id INTEGER PRIMARY KEY,
  firm_id INTEGER NOT NULL REFERENCES firms(id),
  number TEXT NOT NULL,
  party_id INTEGER REFERENCES parties(id),
  customer_name TEXT,
  phone TEXT,
  product_id INTEGER REFERENCES products(id),
  item_name TEXT,
  serial TEXT,
  document_id INTEGER REFERENCES documents(id),
  project_id INTEGER REFERENCES projects(id),
  issue TEXT NOT NULL,
  priority TEXT NOT NULL DEFAULT 'normal',
  status TEXT NOT NULL DEFAULT 'new',
  under_warranty INTEGER NOT NULL DEFAULT 0,
  assigned_to INTEGER REFERENCES users(id),
  received_date TEXT NOT NULL,
  promised_date TEXT,
  resolved_date TEXT,
  charges REAL NOT NULL DEFAULT 0,
  resolution TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  created_by INTEGER,
  updated_at TEXT,
  UNIQUE (firm_id, number)
);
CREATE INDEX idx_service_status ON service_tickets(firm_id, status);
CREATE TABLE service_activities (
  id INTEGER PRIMARY KEY,
  ticket_id INTEGER NOT NULL REFERENCES service_tickets(id),
  kind TEXT NOT NULL,
  summary TEXT NOT NULL,
  at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  user_id INTEGER,
  username TEXT
);
CREATE INDEX idx_service_act ON service_activities(ticket_id, at);

-- HR and payroll: employees, daily attendance, advances and recoveries, monthly salary sheets.
CREATE TABLE employees (
  id INTEGER PRIMARY KEY,
  firm_id INTEGER NOT NULL REFERENCES firms(id),
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  phone TEXT,
  cnic TEXT,
  designation TEXT,
  department TEXT,
  join_date TEXT,
  salary REAL NOT NULL DEFAULT 0,
  pay_type TEXT NOT NULL DEFAULT 'monthly',
  status TEXT NOT NULL DEFAULT 'active',
  left_date TEXT,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  created_by INTEGER,
  updated_at TEXT,
  UNIQUE (firm_id, code)
);
CREATE TABLE attendance (
  id INTEGER PRIMARY KEY,
  employee_id INTEGER NOT NULL REFERENCES employees(id),
  date TEXT NOT NULL,
  status TEXT NOT NULL,
  overtime_hours REAL NOT NULL DEFAULT 0,
  note TEXT,
  UNIQUE (employee_id, date)
);
CREATE INDEX idx_attendance_date ON attendance(date);
CREATE TABLE employee_ledger (
  id INTEGER PRIMARY KEY,
  firm_id INTEGER NOT NULL REFERENCES firms(id),
  employee_id INTEGER NOT NULL REFERENCES employees(id),
  date TEXT NOT NULL,
  kind TEXT NOT NULL,
  amount REAL NOT NULL,
  notes TEXT,
  expense_id INTEGER REFERENCES expenses(id),
  run_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  created_by INTEGER
);
CREATE INDEX idx_employee_ledger ON employee_ledger(employee_id, date);
CREATE TABLE payroll_runs (
  id INTEGER PRIMARY KEY,
  firm_id INTEGER NOT NULL REFERENCES firms(id),
  month TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  account_id INTEGER REFERENCES accounts(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  created_by INTEGER,
  posted_at TEXT,
  posted_by INTEGER,
  UNIQUE (firm_id, month)
);
CREATE TABLE payroll_lines (
  id INTEGER PRIMARY KEY,
  run_id INTEGER NOT NULL REFERENCES payroll_runs(id),
  employee_id INTEGER NOT NULL REFERENCES employees(id),
  base REAL NOT NULL DEFAULT 0,
  paid_days REAL NOT NULL DEFAULT 0,
  absent_days REAL NOT NULL DEFAULT 0,
  overtime_hours REAL NOT NULL DEFAULT 0,
  overtime_pay REAL NOT NULL DEFAULT 0,
  bonus REAL NOT NULL DEFAULT 0,
  deductions REAL NOT NULL DEFAULT 0,
  advance_recovery REAL NOT NULL DEFAULT 0,
  net REAL NOT NULL DEFAULT 0,
  expense_id INTEGER REFERENCES expenses(id),
  notes TEXT,
  UNIQUE (run_id, employee_id)
);
`
  }
]

export const LATEST_SCHEMA_VERSION = Math.max(...MIGRATIONS.map((m) => m.version))
