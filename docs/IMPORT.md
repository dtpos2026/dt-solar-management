# CSV import & export — DT Solar Pro

Backup & Restore → **CSV import / export**. Export needs `backup.manage`; import needs `import.manage`. Both work on the **active firm**.
Code: `src/main/services/importer.ts` (import), `src/main/services/csvExport.ts` (export), routes in `src/main/ipc/routes/data.ts`
(`import.*`, `csv.export`), UI in `src/renderer/src/pages/backup/` (ImportPanel, CsvExportCard, csvKinds). Tests: `tests/csv.test.ts`, `tests/data.test.ts`.

> **CSV is not a full backup.** Settings, users, firms, images, projects, returns, quotations, stock-movement history,
> party adjustments and cancelled records are not in CSV files. Use the full backup (`.dtbak`) or the JSON backup for that.
> Vyapar backups have their own converter — see `docs/VYAPAR_IMPORT.md`.

## Entities
| Kind | One row = | Duplicate key | Duplicate policy |
|---|---|---|---|
| Product categories | category | name | skip / update |
| Products (+ opening stock) | product | SKU, else name | skip / update (update never changes stock) |
| Customers / Suppliers (+ opening balance) | party | name + phone | skip / update |
| Sales / Purchase invoices | **invoice line** (flat file; header columns repeated, grouped by *Invoice no*) | invoice no | always skip — existing invoices are never changed |
| Payments & receipts | payment | direction + number | always skip |
| Expenses | expense | number | always skip |
| Stock levels | product + warehouse | — | rows already at the counted qty are skipped |

Column headers of an export are the import field labels, so an exported file maps itself when imported again.
Download template gives the headers for each kind. Header aliases (e.g. *Item code*, *Mobile*, *Cost price*) are matched too.

## File format
- UTF-8 (BOM written on export so Excel shows Urdu correctly; BOM accepted on import). Comma, `;` or tab separated, first row = headers, max 20 MB / 20,000 rows.
- RFC-4180 quoting: commas, `"` (doubled) and newlines inside quoted cells.
- Dates: export writes `yyyy-mm-dd`. On import the user picks **yyyy-mm-dd** or **dd/mm/yyyy**; ISO dates are always accepted, impossible dates (31/02) are rejected.
- Numbers: `.` is the decimal mark; thousands separators `1,234.50`, `Rs`/`PKR` prefix and `(200)` negatives are accepted; `1,5` is rejected rather than guessed.
- Empty cell = no value (null). On *update* an empty cell keeps the existing value.
- Text cells starting with `= + - @` are written with a leading `'` (spreadsheet formula guard) and the `'` is removed on import (e.g. phone `+92…`).

## Import pipeline
1. Pick the entity, the date format, the duplicate policy, then the file.
2. **Mapping**: automatic (exact label first, then aliases, then contains-match), every field can be re-mapped or left out.
3. **Validation summary** (nothing written): required fields, types, negative values, duplicates inside the file, duplicates already in the books,
   unknown references (party by name + phone, product by SKU then name, account, warehouse, invoices in *Against*). Counts new / update / skip / invalid, with row-level errors and warnings, plus file totals.
4. **Dry run** (optional): every record goes through the real services inside a transaction that is rolled back; shows failures and whether the books' totals would match the file totals.
5. **Import**: ONE transaction. By default any invalid row or failing record stops the whole import (nothing saved). With *leave out the invalid ones* the valid records are saved and the rest are reported.
   A reconciliation (opening qty / value, opening balances, document / payment / expense amounts) is checked before commit; a mismatch rolls back.
6. Result: imported / updated / skipped / failed with reasons. Every attempt (also failed ones) is logged in `import_runs` and the audit log.

## Relationships and consistency
All writes go through the normal services (`saveProduct`, `saveParty`, `createDocument`, `createPayment`, `createExpense`, `createAdjustment`), so permissions,
closed periods, stock movements, average cost, serial checks and party balances behave exactly as when the data is typed in.
- Invoice lines link to their invoice by *Invoice no* and to products by *Item SKU*, then *Item name*; an unknown item becomes a text line (warning, no stock effect).
  The original invoice / payment / expense numbers are kept. *Paid amount* + *Paid into account* records the payment taken at billing (walk-in sales must be fully paid).
- Payments link to parties by name (+ phone) and settle documents via *Against*: `INV-0001:500; INV-0002:250`.
- Opening stock of new products goes to the default warehouse; stock levels import posts only the difference as a stock adjustment dated today.
- Recommended order: categories → products → customers → suppliers → purchases → sales → expenses → payments → stock levels.

## Export notes
- Products: *Opening qty / cost* are the opening-stock entries only; current stock is the *Stock levels* export.
- Invoices: *Paid amount* is only the billing payment (notes "Against <number>"); that payment is left out of the payments export so a round trip does not count it twice.
- Optional date range for invoices, payments and expenses. Cancelled records are not exported.
- A party of type *both* appears in both the customers and the suppliers file; importing both files into an empty firm creates two parties.

Round trip tested (`tests/csv.test.ts`): export every kind → import into a fresh database → products, categories, parties (balances), invoices (lines, totals),
payments (allocations), expenses and stock levels are equal, including Urdu names, quotes/commas/newlines, decimals, dates and empty values.
