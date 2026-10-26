# DT Solar Pro — Solar Business Management System

**by Digital Target** · digitaltarget.digital@gmail.com · +92 345 1873354
Demo branding: **WETCO SOLAR SOLUTIONS**, Multan.

Offline Windows desktop app (Electron + React + TypeScript + SQLite) for solar trading, inventory, sales,
purchases, accounts and **project-wise profit**. It includes a web **Super Admin panel** that controls
licenses through Firebase on the free Spark plan (Firestore + Auth only, no Cloud Functions).

## Features
- **CRM:** leads with a drag-and-drop pipeline (New, Contacted, Site visit, Quotation sent, Negotiation, Won, Lost), follow-up dates with reminders in the notification bell, a call / WhatsApp / visit timeline, win a lead to create the customer and start a quotation
- **Standard or Editable mode (Vyapar-style settings):** Settings, "Simple / Customize". Standard is the software exactly as before. Editable gives the Vyapar settings screens (Transaction, Invoice Print, Item) plus Party, Menu and Solar Projects, each switch really working: cash sale by default, billing name, time, barcode scan, last 5 sale prices, automatic round off, invoice preview, company details and totals on the printed invoice, enable item, stock maintenance, update sale price from the invoice, simple projects, and optional easy delete. See docs/RELEASE_v1.8.md and docs/VYAPAR_SETTINGS_MAP.md
- **POS and ERP modules (each on / off):** Settings, "Simple / Customize", "POS and ERP modules". All start off, so nothing changes until a module is switched on. POS counter (shifts, split payment, change, held bills, Z report, 80 mm receipt), Cheques, Service and Warranty tickets, HR and Payroll (attendance, advances, salary sheet), Reorder planning and barcode labels. See docs/RELEASE_v1.9.md
- Multi-firm (firms can share inventory and parties; each firm keeps its own ledgers and reports), multi-user with roles and permissions, audit log
- Products, stock at moving-average cost, warehouses, serial numbers, warranty, stock adjustments and transfers
- Quotations → sales orders → delivery challans → invoices, returns/credit notes, purchases, purchase orders, returns
- Receipts and payments with invoice allocation and advances, cash/bank accounts, transfers, expenses
- **Solar projects:** revenue, material (issued / invoiced / bought for site), labor, other costs, gross and net profit, margin, project ledger, material usage, attachments
- Reports: P&L, sales and purchase registers, item profit, stock valuation, receivables and payables aging, project profitability, tax, day book, cash book
- Professional A4 printing and PDF: logo, signature and stamp images, amount in words, multi-page tables
- Animated splash screen, 7 themes, auto-lock, automatic daily backups, restore with integrity check
- Offline license with signed certificates; **no automatic trial** — a trial is a short license issued by Digital Target; online (admin approval) or offline activation; revocation / suspension enforced before every protected action when online, and through the signed check-in deadline + grace period when offline

## New in v1.1
- Setup wizard starts with **License**: activate with a key (company, owner, phone, address are sent for approval) or offline with an activation code; nothing can be recorded before activation
- Invoices and quotations print the **item name and item description**; **Invoice templates** designer (classic, modern, compact, 80 mm thermal)
- Delete unpaid invoices (with audit snapshot), delete/archive products and projects, change categories
- **Day Closing** and month closing with automatic closing backup; closed days are locked
- **PIN login** with user tiles, **Printers** page (choose printer per document, test print)
- **WhatsApp** module in the sidebar: WhatsApp Web inside the software — scan the QR once (WhatsApp → Linked devices),
  then "Send on WhatsApp" on any invoice prepares the PDF and opens the chat; drag the PDF into the chat and press Send
- **Help & Support**: offline Urdu / English help assistant; Settings → Support messages to Digital Target (works offline, sends later)
- Sidebar shows the customer's own firm name and logo; License & About moved to Settings

## New in v1.2 (release hardening)
- License: no local trial, approval per computer, device replacement, enforcement before every write (details: `docs/LICENSING.md`)
- Device location: Windows location service (with consent), approximate IP (labelled — usually the ISP's city), manual, or off
- Print / PDF: A4 pages with "Page x of y", portrait / landscape, preview shows the real page count, thermal 80 mm receipts
- Backups: full **JSON backup (.js1)** export / restore, **CSV** export / import per entity, **Import from Vyapar (.vyb)** (`docs/VYAPAR_IMPORT.md`)
- Super Admin portal redesign, faster pages (fewer Firestore reads), activity-log clearing by scope (security trail protected)

## Build the Windows installer (on your Windows PC)
Install **Node.js 22 LTS** (https://nodejs.org). Open **Command Prompt** in the project folder:

```bat
npm install
npm run build
npm run dist
```

- The installer is created at **`release\1.0.0\DT-Solar-Pro-Setup-1.0.0.exe`**.
- The first `npm run build` creates your license signing key **`keys\license-private.pem`** automatically
  (only once — it is never overwritten). Load it in the Super Admin panel → *Signing key*.
  **Keep a backup on a USB drive and never share it.**

## Super Admin panel (license control)
One-time setup: `npm install -g firebase-tools` and then `firebase login`.

Open Command Prompt in the **admin-panel** folder:

```bat
npm install
npm run build
firebase deploy --only firestore:rules
firebase deploy --only hosting
```

The panel goes live at **https://dt-soalr-mangement.web.app**. To log in:
1. Create the user `digitaltarget.digital@gmail.com` in Firebase Console → Authentication → **Add user**.
2. Sign in to the panel and click **Initialise Super Admin**.
3. Open **Signing key** and load `keys\license-private.pem`.

To run the panel locally instead, use `npm run dev` and open http://localhost:5180.

**After updating to v1.1, deploy the rules and hosting again** (same two commands). The owner record is upgraded
automatically; add more admin users under **Admins** (each gets a role and permissions).

Portal pages: Dashboard, Clients, Licenses, Devices, Device Map, Billing, Support, Verify Key, Activity Log, Admins,
Settings. Billing invoices carry a QR code that opens `https://dt-soalr-mangement.web.app/v/<code>` — a public page
that confirms the invoice is genuine (it does not prove payment). Branding, bank details and the signing key are in
**Settings**. Optional: `npm run test:rules` runs the Firestore rules tests (needs firebase-tools and Java).

## Selling a license
1. Admin panel → **Licenses → New license** (choose plan, limits and expiry) → copy the **license key**.
2. The customer installs DT Solar Pro → **License & About** → enters the key → **Activate online**.
3. Admin panel → **Devices → Activation requests** → **Approve** (every new computer needs an explicit approval; a valid key alone never grants access). If the license's computer limit is full, choose **Replace computer X with this one** or reject. The customer's app activates automatically.
   Trial: Licenses → **Issue trial** (15 days, 1 computer, still needs approval).
4. Customer without internet: they send the **request code** → admin panel **Offline activation** → send back the activation code / `.dtlic` file.
   Command-line alternative: `npm run license:issue -- --request <code> --business "Name" --days 365`

Suspend, revoke or deactivate a computer from the license page. The app picks the change up at its next
online check. A license problem makes the app read-only; business data is never deleted.

## Where data is stored (customer PC)
- Database: `%APPDATA%\DT Solar Pro\data\dtsolarpro.db`
- Automatic backups: `Documents\DT Solar Pro Backups`
- Uninstalling keeps data and backups. Upgrades run safe migrations and take an automatic backup first.

## Project structure
```
src/main       Electron main process: database, migrations, services (business rules), secure IPC, license, backup
src/preload    Secure bridge (contextIsolation, sandbox)
src/renderer   React UI (pages, A4 print templates)
src/shared     Shared types, permissions, money and totals maths
admin-panel    Super Admin web panel (Firebase Auth + Firestore)
scripts        License tool, icon builder, end-to-end smoke test
tests          Automated tests (vitest)
```

## Release notes and QC
- v1.5: `docs/RELEASE_v1.5.md`, test report `docs/QC_UAT_REPORT_v1.5.md`, backup and recovery `docs/BACKUP_RECOVERY.md`
