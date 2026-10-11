# DT Solar Pro — Solar Business Management System

**by Digital Target** · digitaltarget.digital@gmail.com · +92 345 1873354
Demo branding: **WETCO SOLAR SOLUTIONS**, Multan.

Offline Windows desktop app (Electron + React + TypeScript + SQLite) for solar trading, inventory, sales,
purchases, accounts and **project-wise profit**. It includes a web **Super Admin panel** that controls
licenses through Firebase on the free Spark plan (Firestore + Auth only, no Cloud Functions).

## Features
- Multi-firm (firms can share inventory and parties; each firm keeps its own ledgers and reports), multi-user with roles and permissions, audit log
- Products, stock at moving-average cost, warehouses, serial numbers, warranty, stock adjustments and transfers
- Quotations → sales orders → delivery challans → invoices, returns/credit notes, purchases, purchase orders, returns
- Receipts and payments with invoice allocation and advances, cash/bank accounts, transfers, expenses
- **Solar projects:** revenue, material (issued / invoiced / bought for site), labor, other costs, gross and net profit, margin, project ledger, material usage, attachments
- Reports: P&L, sales and purchase registers, item profit, stock valuation, receivables and payables aging, project profitability, tax, day book, cash book
- Professional A4 printing and PDF: logo, signature and stamp images, amount in words, multi-page tables
- Animated splash screen, 7 themes, auto-lock, automatic daily backups, restore with integrity check
- Offline license with signed certificates, a 15-day trial, online (approval) or offline activation

## Build the Windows installer (on your Windows PC)
Requirements: **Node.js 22 LTS** (https://nodejs.org) and Git.

Open **Command Prompt** in the project folder and run:

```bat
npm install
npm run license:keygen
npm run build
npm run dist:win
```

- `npm run license:keygen` — run this **only once ever**. It creates your secret signing key `keys\license-private.pem`
  (keep a backup on a USB drive and never share it) and `resources\license-public.pem`, which is built into the app.
- The installer is created at **`release\1.0.0\DT-Solar-Pro-Setup-1.0.0.exe`**.
- Optional: `npm test` runs the automated tests, and `npm run dev` runs the app in development mode.

## Super Admin panel (license control)
```bat
cd admin-panel
npm install
npm run dev
```
Open http://localhost:5180, sign in with `digitaltarget.digital@gmail.com` (create this user first in Firebase
Console → Authentication → Add user), then click **Initialise Super Admin**.
Go to **Signing key** and load `keys\license-private.pem`.

To host the panel online for free on Firebase Hosting:
```bat
npm install -g firebase-tools
firebase login
cd admin-panel && npm run build && cd ..
firebase deploy --only hosting,firestore:rules,firestore:indexes
```
The panel will be live at https://dt-soalr-mangement.web.app.

## Selling a license
1. Admin panel → **Licenses → New license** (choose plan, limits and expiry) → copy the **license key**.
2. The customer installs DT Solar Pro → **License & About** → enters the key → **Activate online**.
3. Admin panel → **Activation requests** → **Approve** (or tick *Auto-approve* and keep the page open). The customer's app activates automatically.
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
