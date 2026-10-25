# DT Solar Pro v1.8: Standard and Editable mode with the Vyapar settings

New tab **Settings, Simple / Customize** (anyone who may change settings; needs an active license). It follows the Vyapar settings screens a client already knows: **Transaction**, **Invoice Print** and **Item**, with the same section headings and labels, plus **Party**, **Menu and modules** and **Solar Projects**. A search box finds a setting by name.

* **Standard** (default, and after every upgrade): the software exactly as in v1.6. All switches are ignored and shown dimmed.
* **Editable**: every switch and value works. A switch never set keeps its standard value, so turning Editable on changes nothing until something is changed. Switching changes only what is shown, asked or printed, never totals, stock or profit, hidden fields keep their values, and a switch turned back on brings everything back. One setting for all users and firms of the computer.
* **Quick setup:** *Everything* (all as Standard) and *Simple shop* (cash sale by default, invoice preview, last prices; no CRM, projects, closing, serial numbers, costing and extra fields; easy delete on).

Every Vyapar setting in the screenshots, and what was done with it, is in `docs/VYAPAR_SETTINGS_MAP.md`.

## What each screen does
| Screen | Working switches and values |
|---|---|
| Transaction | Cash Sale by default, Billing name of Parties, PO Details, Add Time On Transactions, Solar project, Warehouse, Barcode scanning (scan box), Item description, Display Purchase Price, Show Last 5 Sale Price of Items, Warranty on each item, Item wise discount, Transaction wise Discount, Item wise tax, Freight, Round Off (manual, or automatic nearest / up / down to 1, 5, 10, 50, 100), Amount in words, Payment now, Due Dates, Enable Invoice Preview, Notes, Terms and Conditions, delete even after payments |
| Invoice Print | Company name (with text size), logo, address, email, phone, NTN / STRN, extra space on top, printed names of the eight document types, item table columns (unit, description, brand / model, discount, tax details, serials, warranty), minimum rows, total quantity, decimals, amount grouping, received, balance, previous balance, You Saved, amount in words with lakh or million format, notes, terms, bank details, payments, customer signature box, authorised signature with custom text, stamp. They apply to every template and layout (classic, modern, compact, 80 mm receipt for the company details) and to receipts. |
| Item | Enable Item, Item Type (both, products, services), Stock maintenance, Category, Units, Default Unit, SKU and barcode, brand and model, minimum price, low-stock level, warranty, serial tracking, Description, Update Sale Price from TXN |
| Party | Contact person / second phone / email, CNIC / NTN / STRN, opening balance, credit limit and payment terms |
| Menu and modules | CRM, Quotations, Purchases, Solar Projects, Accounts, Expenses, Day Closing, Reports, WhatsApp. Item off also hides Inventory. A hidden module leaves the menu, the dashboard shortcuts and its screen; the data stays. |
| Solar Projects | Project details, Costing and profit (both off gives a simple project record) |

## Rules worth knowing
* **Cash Sale by default:** a new sales invoice is a walk-in sale with the full amount taken as received (walk-in sales must be fully paid anyway). Untick the box on the invoice for a credit sale.
* **Stock maintenance off:** stock numbers are not shown and never stop a sale. The movements are still recorded, so switching it on later gives correct stock.
* **Update Sale Price from TXN:** only a saved sales invoice changes the item sale price (not quotations or purchases); every change is in the audit log.
* **Delete even after payments:** the payment stays as the customer or supplier advance, stock is put back, a full copy goes to the audit log. Closed days, returns, converted documents and the delete permission still apply. Off in Standard.
* **Safe by design:** a stock shortage warning (when stock is maintained), serial numbers of items that track them and tax already on a line are always shown.
* The new database column `parties.billing_name` is added by an automatic migration (v11, with the usual backup first).

Tests: `tests/options.test.ts` (21) and the desktop end-to-end run (screens and labels, Simple shop menu and invoice, cash sale box, barcode scan, Invoice Print settings in the printed document, Standard restores).
