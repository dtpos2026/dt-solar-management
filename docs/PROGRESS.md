# DT Solar Pro v1.1 — implementation checklist

Status keys: [x] done & tested · [~] partial · [!] blocked (needs credentials / input / hardware)

## Desktop app
- [x] Schema v2 + v8 migrations (item details, PIN, archive, day/month closing, templates, support queue, WhatsApp log, imports); built-in roles get new permissions automatically
- [x] Documents: item name + item description in editor, preview, every print layout and PDF; invoice delete rules (unpaid, unreferenced, open period, permission, audit snapshot); template designer (classic / modern / compact / 80 mm thermal) with live preview and per-print customisation; "Powered by Digital Target" only when the Super Admin enables it
- [x] Catalog: product delete vs archive/restore, bulk category change, category delete-with-reassign; project delete vs archive/restore/cancel; firm activate/deactivate; firm limit on create + reactivate; firm isolation fixes; assign shared records to firms
- [x] Data: day closing + month closing (counted cash, difference, closing backup, reopen, print, CSV); closed periods lock transactions; backup history / verify / export / restore; firm JSON export; hourly in-app backup scheduler; CSV import (products, customers, suppliers) with mapping, validation, reconciliation, rollback
- [x] Access: user tiles + PIN or password login, PIN lockout, PIN unlock of the lock screen, forced password change gate; Printers page (OS printer list, per-document printers, paper size incl. 80/58 mm, direct print, test print)
- [x] Cloud: setup-wizard License step (online activation with registration details / offline activation — no local trial, the wizard cannot finish without a certificate), heartbeat every 15 min, consented location (off / Windows location service / approximate IP / manual), support messages with offline queue, certificate refresh (renew / plan / limits / detach), License & About inside Settings
- [x] Assist: offline Urdu / English help assistant (58 articles, Roman-Urdu, typo tolerant); WhatsApp Web module inside the app (QR link device, stays linked), Send on WhatsApp (PDF + chat + drag tile + send log, no automation)
- [x] White-label: sidebar shows the active firm's name and logo; Digital Target stays in the footer
- [x] PDF / print pagination (release hardening): A4 sheets get CSS page rules (size + orientation, 10/12 mm margins, "Page x of y" footer), repeated table headers, rows kept whole; wide reports turn landscape automatically (Portrait/Landscape selector); preview toolbar shows the real PDF page count and a Page view of the exact pages; Print / Save PDF / WhatsApp share one option set (`pdfOptionsFor`); 80 mm thermal stays one strip and gets no A4 rules. Gate: `scripts/pdf-check.mjs` — 17 PDFs + page view, all A4 595x842 (landscape 842x595), long docs paginate (invoice 120 lines = 11 pages, quotation 60 = 6, statement 200 rows = 7), preview count == PDF count

- [x] License hardening (license-desktop, docs/LICENSING.md): no automatic trial (fresh install = "Not activated", read-only; trial = Super Admin-issued plan 'trial' certificate, "Trial — N days left"); old local-trial installations keep their data, read-only until activated; background check at start-up and sign-in; protected writes re-verify when the last success is > 5 min old (<= 4 s wait, 5-min cache, concurrent checks coalesced, 60 s back-off after a network failure); suspended / revoked / expired / device-deactivated block with distinct license / device / connectivity messages; remote decision persisted in license/state.json AND settings.license_remote; no certs[deviceId] install while suspended/revoked/deactivated; one approval per device; Windows location provider (PowerShell GeoCoordinateWatcher, 6 h cache, 1 h retry, reports "unavailable", no silent fallback). Tests: unit (license + cloud), emulator check 44/44, e2e wizard with throwaway-key offline activation — 0 errors

## Super Admin portal (Firebase Spark: Firestore + Auth only)
- [x] Role-based admins (owner, manager, sales, billing, support, technical, custom) enforced by Firestore rules; 28 rules tests on the emulator
- [x] Dashboard, Clients, Licenses (generate, suspend, reactivate, revoke, renew, change plan / firm / device limits, history, lifetime detach), Devices (+ activation requests, offline activation), Device Map (consented locations only)
- [x] Release hardening — portal licensing: no auto-approval (explicit devices.manage approval; re-issue for an active computer; "needs reassignment" → reject or replace computer in one transaction, race-tested), Issue trial (15 days, 1 computer), masked keys / device ids, license detail with heartbeat version / last verification / location source + accuracy, lazy paginated history; Devices page from `license.devicesSummary` (emulator, 300 licenses / 600 devices / 600 heartbeats: 302 queries · 1500 reads · 2152 ms → 2 queries · 900 reads · 244 ms)
- [x] Billing (invoices, payments, receipts, reports, print / PDF), public QR verification page `/v/<token>`, Support conversations
- [x] Settings (branding, invoice, bank, payment QR, support, portal, signing key), Activity Log (filters, CSV, archive, retention), Verify Key

## Verification (latest run)
- [x] Typecheck (desktop + portal), 218 unit tests, both production builds
- [x] Desktop end-to-end smoke: wizard (offline activation with a throwaway test key), every screen incl. v1.1 screens, 8 print previews + PDFs — 0 errors
- [x] Portal browser smoke on emulators: login, Initialise Super Admin, all pages, Verify Key, public verification (valid + invalid) — 0 page errors
- [x] Desktop ↔ cloud REST calls against the real rules on the emulator (44 checks incl. suspend / device-deactivate write gating)

## Blocked / needs input
- [!] External backup conversion: no sample file of the other software was supplied — CSV import provided (docs/IMPORT.md)
- [!] Multi-factor auth for admins: needs Firebase Identity Platform (paid upgrade)
- [!] Not testable here: real Windows printers, the real web.whatsapp.com QR (needs internet on the customer PC), the Windows installer (built on Windows with npm run dist)
