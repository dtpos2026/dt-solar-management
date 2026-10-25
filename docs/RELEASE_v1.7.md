# DT Solar Pro v1.7: Standard and Customizable mode

New tab **Settings, Simple / Customize** (owner or anyone who may change settings; needs an active license). Nothing else changes and existing data is kept (no database migration).

* **Standard** (default, also after every upgrade): the software exactly as in v1.6. All switches are ignored.
* **Customizable**: each switch decides what is shown. A switch never set keeps its standard value, so turning Customizable on changes nothing until a switch is changed. Switching only changes what is shown or asked. It never changes totals, stock or profit, hidden fields keep their values, and a switch turned back on brings everything back. It applies to all users and firms of the computer.
* **Quick setups:** *Everything* (all as Standard) and *Simple shop* (no CRM, projects, closing, serial numbers, costing, project link, warehouse, tax and other extras on documents; easy delete on). Any switch can be changed afterwards.

| Group | Switches |
|---|---|
| Menu and modules | CRM, Quotations, Purchases, Solar Projects, Accounts, Expenses, Day Closing, Reports, WhatsApp. A hidden module leaves the menu, the dashboard shortcuts and its screen (the data stays). |
| Sales and purchase documents | Solar project, Warehouse, Customer PO / supplier invoice no., Due date, Item description, Discount, Sales tax, Warranty on each item, Stock and cost hints, Freight / other charges, Round off, Notes and terms, Payment received or paid now, Amount in words |
| Products and services | SKU and barcode, Brand and model, Tax rate, Minimum sale price, Low-stock level, Warranty, Serial number tracking, Description |
| Customers and suppliers | Contact person, second phone and email, CNIC / NTN / STRN, Opening balance, Credit limit and payment terms |
| Solar projects | *Project details* (site contact, types, dates, manager, warranty, overhead) and *Costing and profit* (material issue, labor and other costs, ledger, profit and margin). Both off gives a simple project record: customer, site, capacity, status, progress, contract amount, invoices, payments and files. |
| Editing and deleting | *Delete invoices and bills even after payments*: the payment stays as the customer's or supplier's advance, the stock is put back, a full copy goes to the audit log. Closed days, references from returns or converted documents, and the delete permission still apply. Off in Standard. |

Safe by design: a stock shortage warning, serial numbers of items that track them, and tax already on a line are always shown, even when their switch is off. What an invoice prints (logo, tax, signature, terms, bank details, amount in words) stays in *Invoice templates*.

Tests: `tests/options.test.ts` (11) and the desktop end-to-end run (Standard by default, Simple shop hides CRM, projects, closing and invoice fields, Standard restores them).
