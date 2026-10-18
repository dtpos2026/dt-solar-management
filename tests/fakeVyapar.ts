import Database from 'better-sqlite3'

/** A tiny Vyapar-shaped database (only the columns the converter reads). */
export function fakeVyapar(): Database.Database {
  const v = new Database(':memory:')
  v.exec(`
    CREATE TABLE kb_settings (setting_key TEXT, setting_value TEXT);
    CREATE TABLE kb_firms (firm_id INTEGER PRIMARY KEY, firm_name TEXT, firm_phone TEXT, firm_address TEXT, firm_logo INTEGER, firm_signature INTEGER);
    CREATE TABLE kb_images (image_id INTEGER PRIMARY KEY, image_bitmap BLOB);
    CREATE TABLE kb_paymentTypes (paymentType_id INTEGER PRIMARY KEY, paymentType_type TEXT, paymentType_name TEXT, paymentType_bankName TEXT, paymentType_opening_balance REAL, paymentType_opening_date TEXT);
    CREATE TABLE kb_item_units (unit_id INTEGER PRIMARY KEY, unit_name TEXT, unit_short_name TEXT);
    CREATE TABLE kb_prefix (prefix_id INTEGER PRIMARY KEY, prefix_firm_id INTEGER, prefix_txn_type INTEGER, prefix_value TEXT, prefix_is_default INTEGER);
    CREATE TABLE terms_and_conditions (tnc_id INTEGER PRIMARY KEY, header TEXT, description TEXT, is_active INTEGER);
    CREATE TABLE kb_names (name_id INTEGER PRIMARY KEY, full_name TEXT, phone_number TEXT, address TEXT, amount REAL, name_type INTEGER, name_is_active INTEGER, date_created TEXT);
    CREATE TABLE kb_items (item_id INTEGER PRIMARY KEY, item_name TEXT, item_type INTEGER, item_code TEXT, base_unit_id INTEGER, item_sale_unit_price REAL, item_purchase_unit_price REAL, item_stock_quantity REAL, item_is_active INTEGER, item_description TEXT);
    CREATE TABLE kb_transactions (txn_id INTEGER PRIMARY KEY, txn_type INTEGER, txn_name_id INTEGER, txn_firm_id INTEGER, txn_date TEXT, txn_date_created TEXT, txn_cash_amount REAL, txn_balance_amount REAL, txn_current_balance REAL,
      txn_discount_amount REAL DEFAULT 0, txn_tax_amount REAL DEFAULT 0, txn_ref_number_char TEXT, txn_prefix_id INTEGER, txn_status INTEGER DEFAULT 1, txn_description TEXT, txn_category_id INTEGER, txn_due_date TEXT, tnc_id INTEGER);
    CREATE TABLE kb_lineitems (lineitem_id INTEGER PRIMARY KEY, lineitem_txn_id INTEGER, item_id INTEGER, quantity REAL, priceperunit REAL, total_amount REAL, lineitem_unit_id INTEGER, lineitem_description TEXT);
    CREATE TABLE txn_payment_mapping (id INTEGER PRIMARY KEY, payment_id INTEGER, txn_id INTEGER, amount REAL, payment_reference TEXT);
    CREATE TABLE kb_txn_links (txn_links_id INTEGER PRIMARY KEY, txn_links_txn_1_id INTEGER, txn_links_txn_2_id INTEGER, txn_links_amount REAL, txn_links_txn_1_type INTEGER, txn_links_txn_2_type INTEGER);
    CREATE TABLE kb_linked_transactions (linked_id INTEGER PRIMARY KEY, txn_source_id INTEGER, txn_destination_id INTEGER);
    CREATE TABLE kb_udf_fields (udf_field_id INTEGER PRIMARY KEY, udf_field_name TEXT);
    CREATE TABLE kb_udf_values (udf_value_id INTEGER PRIMARY KEY, udf_value_field_id INTEGER, udf_ref_id INTEGER, udf_value TEXT);
    CREATE TABLE kb_address (address_id INTEGER PRIMARY KEY, name_id INTEGER, address_type INTEGER, address TEXT, city TEXT, state_name TEXT);
    CREATE TABLE kb_party_groups (party_group_id INTEGER PRIMARY KEY, party_group_name TEXT);
    CREATE TABLE urp_users (user_id INTEGER PRIMARY KEY, user_name TEXT, user_phone TEXT);
    CREATE TABLE kb_item_adjustments (item_adj_id INTEGER PRIMARY KEY, item_adj_item_id INTEGER, item_adj_type INTEGER, item_adj_quantity REAL, item_adj_date TEXT, item_adj_date_created TEXT, item_adj_atprice REAL, item_adj_description TEXT);
    INSERT INTO kb_settings VALUES ('VYAPAR.DEFAULTFIRMID','1'), ('VYAPAR.CURRENCYSYMBOL','₨'), ('VYAPAR.PREVENTNEGATIVESTOCKSALE','0');
    INSERT INTO kb_firms VALUES (1, 'WETCO SOLAR SOLUTIONS', '03007341433', 'Multan', NULL, NULL);
    INSERT INTO kb_paymentTypes VALUES (1, 'CASH', 'Cash', '', 0, '2026-01-01'), (3, 'BANK', 'Askari', 'ASKARI BANK', 0, '2026-01-01');
    INSERT INTO kb_item_units VALUES (14, 'NUMBERS', 'NOS');
    INSERT INTO kb_prefix VALUES (15, 1, 1, 'WSS', 1), (18, 1, 3, 'WSS', 1);
    INSERT INTO kb_names VALUES (1, 'Customer "Ali", Multan — علی', '+923001112233', 'Gulgasht', 1150, 1, 1, '2026-01-01'),
                                (2, 'Supplier One', '+923004445566', '', -600, 1, 1, '2026-01-01'), (78, 'MONTHLY EXPENSE', NULL, NULL, 0, 2, 1, '2026-01-01');
    INSERT INTO kb_items VALUES (1, 'SOLAR PANELS', 1, '001', 14, 150, 100, 6, 1, NULL);
    INSERT INTO urp_users VALUES (1, 'Admin', '3007341433');
    -- opening receivable 1000 for party 1
    INSERT INTO kb_transactions (txn_id, txn_type, txn_name_id, txn_firm_id, txn_date, txn_date_created, txn_cash_amount, txn_balance_amount, txn_current_balance) VALUES (10, 5, 1, 1, '2026-01-01 00:00:00', '2026-01-01 09:00:00', 0, 1000, 1000);
    -- purchase 10 x 100 = 1000, paid 400 at billing
    INSERT INTO kb_transactions (txn_id, txn_type, txn_name_id, txn_firm_id, txn_date, txn_date_created, txn_cash_amount, txn_balance_amount, txn_current_balance, txn_ref_number_char) VALUES (11, 2, 2, 1, '2026-02-01 00:00:00', '2026-02-01 09:00:00', 400, 600, 600, 'BILL-7');
    INSERT INTO kb_lineitems VALUES (100, 11, 1, 10, 100, 1000, 14, NULL);
    INSERT INTO txn_payment_mapping VALUES (1, 1, 11, 400, NULL);
    -- estimate 4 x 150, converted to the sale
    INSERT INTO kb_transactions (txn_id, txn_type, txn_name_id, txn_firm_id, txn_date, txn_date_created, txn_cash_amount, txn_balance_amount, txn_current_balance, txn_ref_number_char, txn_prefix_id, txn_status) VALUES (12, 27, 1, 1, '2026-02-02 00:00:00', '2026-02-02 09:00:00', 0, 600, 600, '1', 15, 4);
    INSERT INTO kb_lineitems VALUES (101, 12, 1, 4, 150, 600, 14, '585W "N-type", bifacial');
    -- sale 4 x 150 = 600, received 100 at billing
    INSERT INTO kb_transactions (txn_id, txn_type, txn_name_id, txn_firm_id, txn_date, txn_date_created, txn_cash_amount, txn_balance_amount, txn_current_balance, txn_ref_number_char, txn_prefix_id) VALUES (13, 1, 1, 1, '2026-02-03 00:00:00', '2026-02-03 09:00:00', 100, 500, 150, '1', 15);
    INSERT INTO kb_lineitems VALUES (102, 13, 1, 4, 150, 600, 14, '585W "N-type", bifacial');
    INSERT INTO txn_payment_mapping VALUES (2, 3, 13, 100, 'TX-1');
    INSERT INTO kb_linked_transactions VALUES (1, 12, 13);
    -- payment-in 300 + discount 50 settling the sale (link 350)
    INSERT INTO kb_transactions (txn_id, txn_type, txn_name_id, txn_firm_id, txn_date, txn_date_created, txn_cash_amount, txn_balance_amount, txn_current_balance, txn_discount_amount, txn_ref_number_char, txn_prefix_id) VALUES (14, 3, 1, 1, '2026-02-10 00:00:00', '2026-02-10 09:00:00', 300, 0, 0, 50, '1', 18);
    INSERT INTO txn_payment_mapping VALUES (3, 1, 14, 300, NULL);
    INSERT INTO kb_txn_links VALUES (1, 13, 14, 350, 1, 3);
    -- expense 200 cash
    INSERT INTO kb_transactions (txn_id, txn_type, txn_name_id, txn_firm_id, txn_date, txn_date_created, txn_cash_amount, txn_balance_amount, txn_current_balance, txn_category_id) VALUES (15, 7, NULL, 1, '2026-02-11 00:00:00', '2026-02-11 09:00:00', 200, 0, 0, 78);
    INSERT INTO txn_payment_mapping VALUES (4, 1, 15, 200, NULL);
  `)
  return v
}
