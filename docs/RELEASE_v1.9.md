# DT Solar Pro v1.9: POS counter and ERP modules, each with its own on / off switch

New card at the top of **Settings, Simple / Customize: "POS and ERP modules"**. Five modules, **all off after install and after every upgrade**, so a client who does not switch one on sees no change at all (no menu entry, no dashboard shortcut, no screen; the server also refuses the module's calls). Switching a module off hides it and keeps its data; switching it on brings everything back. The switches are independent of Standard / Editable mode, so the same installation can be a solar company (Standard, no modules), an electrician shop (Simple shop plus POS) or a company with staff (HR, cheques, service).

| Module | Menu entry | Built-in roles that get it |
|---|---|---|
| Point of Sale | POS Counter | Super Administrator (everything); Salesperson (`pos.use`, `pos.shift`); Accountant (`pos.reports`) |
| Cheques | Cheques | Super Administrator; Accountant (`cheques.view`, `cheques.manage`) |
| Service and Warranty | Service & Warranty | Super Administrator; Salesperson (view and manage); Project Manager (view) |
| HR and Payroll | Staff & Salary | Super Administrator; Accountant (view and pay the salary sheet, `hr.view`, `hr.payroll`) |
| Reorder Planning | Reorder Planning | Anyone who can view inventory (making the orders also needs `purchases.create`) |

New permissions are added to the built-in roles automatically on upgrade (catalogue version 4); custom roles get them only if you tick them. New database tables arrive with migration v12 (with the usual backup first).

## POS counter
* Search, scan a barcode or tap an item tile; the cart takes quantity, line discount and bill discount (only if "Cashier can give discount" is on and the user may give discounts).
* **Shift and cash drawer:** open with the cash in the drawer, cash in / out with a reason, close with the counted cash; the report shows sales, discounts, cancelled bills, money received by method, credit left, the cash the drawer should hold and the difference. It prints as a Z report (X while open).
* **Pay:** cash, card, bank transfer, online, or any mix. Cash gives change; non-cash methods are taken first and cash takes the rest. A walk-in customer must pay in full; credit needs a selected customer and "Allow credit sale". Each method goes to the account chosen in the POS settings (or the first account of the right type: cash for cash, bank or wallet for the rest).
* **Held bills:** park a cart, serve someone else, recall it later.
* A POS sale is an ordinary sales invoice (numbering, stock, customer balance, reports, returns and cancellation all work as for any invoice); the POS tables only add the shift, the cash tendered and the change. The receipt prints on the receipt printer (80 mm layout) straight after the sale when "Print the receipt after each sale" is on.
* Settings: shift required, discounts, price change, credit, auto print, receipt layout, default method, round the bill, tiles and stock on tiles.

## Cheques
Register of cheques **received** (often post-dated) and **issued**. Nothing is booked until a cheque clears: **Cleared** books a payment from or to the chosen account against the linked invoice or bill (or the oldest open ones); **Bounced** books nothing, and a cheque that bounces after clearing reverses its payment. Overdue cheques are flagged, summary cards show what is waiting, and the bell shows cheques due today or overdue.

## Service and warranty
Ticket per complaint: customer (or just a name), item, serial, problem, priority, technician, promised date, charge. **Warranty check** from the serial number sold by us: the customer, item and invoice fill in and the ticket shows if the item is under warranty (sale date plus the item's warranty months). Status flow new, in progress, waiting for parts, resolved, closed (resolved and closed need a written fix); a timeline of calls, visits, WhatsApp and notes; overdue tickets are flagged. A ticket that has been worked on is kept; only an untouched new ticket can be deleted.

## HR and payroll
* **Employees** with code, designation, monthly salary or daily wage, advances owed.
* **Attendance** grid per month (present, absent, paid leave, half day, holiday, overtime hours), mark a single day or a whole day for everyone.
* **Advance** is booked as a paid expense (category Salaries) from the chosen account at once and taken back from the next salary.
* **Salary sheet** per month: monthly pay loses one day of pay (salary / days in the month) for each absent day and half for a half day; days with no mark count as worked, so a shop that keeps no attendance pays the full salary. Daily wage pays only the marked days. Overtime is hours x (day rate / 8) x 1.5. Bonus, deductions and advance recovery can be changed per employee; recovery cannot exceed the advance owed and net pay cannot go below zero. **Pay** books one paid expense per employee for the net amount; **Undo payment** cancels those expenses and brings the advances back. Printable A4 salary sheet.
* Not included: tax and provident fund rules, payslips per employee, biometric devices.

## Reorder planning
Items at or below their low-stock level with the quantity already on purchase orders, a suggested quantity (up to 1x to 4x the level, minus stock and open orders), and the supplier and rate of the last purchase. Choose items, quantities and suppliers, and one purchase order per supplier is created (a line without a supplier is refused, never silently dropped).

## Barcode labels (comes with the POS module)
In Inventory, select items: **Assign barcodes** gives each item that has none its own code (P and 8 digits, never overwriting an existing one), **Print labels** prints an A4 sheet of 3 x 8 labels (name, Code 128 barcode, price). The Code 128 encoder is tested against JsBarcode. Scan boxes (POS and invoice) read the same codes.

## Tests
`tests/pos.test.ts` (12), `tests/cheques.test.ts` (7), `tests/service.test.ts` (7), `tests/hr.test.ts` (11), `tests/reorder.test.ts` (6), `tests/code128.test.ts` (4); each module's tests also check that its calls are refused while the module is off. The desktop end-to-end run switches each module on from Settings and drives it (POS sale with change and Z report; cheque cleared into a bank account; service ticket opened, worked and resolved; employee added, absence marked, salary sheet prepared, paid and printed; reorder to a purchase order; barcode labels printed) and then switches everything off again, checking the server refuses the module.

## Not included, and not tested
Fixed assets, bank reconciliation, manufacturing / bill of materials, wholesale price lists, customer loyalty points, a customer-facing display, cash-drawer kick and weighing-scale hardware. Receipts and labels were checked as on-screen print previews; they have not been printed on a real thermal printer, label printer or barcode scanner, and the app has not been run on a real Windows machine in this environment.
