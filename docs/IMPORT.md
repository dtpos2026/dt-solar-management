# Data import (CSV) — DT Solar Pro

Backup & Restore → **Import data** (permission `import.manage`). Imports go into the **active firm**.

## Pipeline
1. Choose what to import (Products / Customers / Suppliers) and pick a `.csv` file (comma, semicolon or tab separated, UTF-8, first row = headers, max 20 MB).
2. Columns are auto-mapped by header name (aliases below); every field can be re-mapped or left out.
3. Every row is validated. Errors are listed per row; **nothing is written** while any error exists (the failed attempt is logged in `import_runs`).
4. Dry-run reconciliation: rows, valid rows, total opening qty, opening stock value (qty × unit cost), total opening balances.
5. Import runs in **one database transaction** — on any failure everything is rolled back.
6. An `import_runs` row stores the file name, mapping, counts, errors and the reconciliation (file totals vs imported totals, `matched`).

## Products
| Field | Required | Header aliases |
|---|---|---|
| Name | yes | name, product, product name, item, item name, title |
| SKU / code | | sku, code, item code, product code, barcode |
| Category | | category, group, item group, type (created if missing) |
| Unit | | unit, uom, units |
| Brand | | brand, make, manufacturer |
| Model | | model, model no, model number |
| Description | | description, details, specification, specs |
| Purchase price | | purchase price, cost, cost price, buy price, purchase rate |
| Sale price | | sale price, price, selling price, rate, sale rate, retail price |
| Opening qty | | opening qty, opening quantity, qty, quantity, stock, opening stock |
| Opening unit cost | | opening cost, opening unit cost, unit cost, opening rate (defaults to purchase price) |

Opening stock is posted through the normal **opening-stock adjustment** into the firm's default warehouse, so stock
movements and moving-average cost stay consistent. Duplicate SKUs / names (in the file or already in the database) are rejected.

## Customers / Suppliers
| Field | Required | Header aliases |
|---|---|---|
| Name | yes | name, customer, customer name, supplier, supplier name, party, party name, vendor |
| Phone | | phone, mobile, cell, contact, phone no, mobile no, contact no |
| Address | | address, street, location |
| City | | city, town |
| Opening balance | | opening balance, opening, balance, opening bal, previous balance |

Opening balance is positive when the customer owes you / you owe the supplier. Numbers may contain thousands separators,
an `Rs`/`PKR` prefix, or accounting negatives `(1,000)`. Negative quantities, prices and balances are rejected.

## Converting an "external backup" from other software
**Not implemented — a sample is needed.** No sample backup/export file from the previous software was supplied, so its
format is unknown and no converter has been written (we do not guess formats). To migrate today: export products and
customers/suppliers from the old software to CSV/Excel, save as CSV and use the import above with the mapping table.
Please supply a real sample export (with a few rows) so a dedicated converter can be built and tested against it.
