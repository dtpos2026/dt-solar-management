# QC and UAT report, DT Solar Pro v1.5 and Super Admin panel

Environment: build container (Linux), Electron under Xvfb, Firestore and Auth emulators, Chromium via Playwright.
Only checks that were actually run are marked "Passed". Everything else is listed under "Not tested".

## Results of the runs
| Run | Scope | Result |
|---|---|---|
| `tsc` (desktop main, renderer, shared, portal) | types | 0 errors |
| `npx vitest run` | 19 files, services on real SQLite, licence logic, portal logic | **310 passed, 0 failed** |
| Portal emulator suite (`admin-panel/tests`, real `firestore.rules`) | rules matrix, licensing, clients and licences, operations | **51 passed, 0 failed** |
| `scripts/cloud-emulator-check.mjs` | the desktop's real Firestore REST calls against the real rules, forged writes | **70 passed, 0 failed** |
| `scripts/e2e-smoke.mjs` (Electron under Xvfb) | first-run wizard, licence activation, every screen, location consent dialog, CSV dry run, Administrator reset, print previews | Passed, 0 console errors |
| Portal browser flow (Chromium against the dev build and emulators) | key load, Support Clear and Delete chat, Dashboard Clear all, approval, Administrator reset, device map | **15 passed, 0 failed, 0 page errors** |
| `vite build` (portal), `electron-vite build` (desktop) | builds | Built |

## What the new tests prove (`tests/final-update.test.ts` 12, `tests/uat.test.ts` 6)
* Quotation: edit and cancel after conversion, the sale is untouched, reject keeps the reason, delete is audited, permissions are enforced.
* Purchases, paid and unpaid: edit, cancel and delete adjust stock, supplier balance and keep the payment; sold goods block an unsafe change.
* Accounts: default protected, delete refused with exact counts when payments, expenses or transfers exist, deactivated account refused for new entries, unused account deleted and audited.
* Users: owner and self protected, user with a closing refused, clean user deleted and audit keeps the name.
* Firms: default, active and used firms refused, empty inactive firm removed with its own account, sequences and warehouse.
* Audit log: owner only, by date, selected and all, CSV of removed rows, one permanent record of the removal.
* UAT figures with two firms: stock 60, customer 200,000, supplier 300,000, cash 85,000, bank 380,000, revenue 300,000, cost of sales at moving average, operating expenses 15,000; consolidated report equals the sum of both firms; transfers do not change profit.
* JSON backup round trip: after export, read, rebuild and open, every figure (P&L per firm and consolidated, dashboard, account balances, stock, party balances, document, payment, stock movement and audit counts) is identical; integrity and foreign key checks are clean; new sales continue the numbering; a modified file fails the checksum; a foreign or non-JSON file is refused.
* CSV round trip: customers, suppliers, products, sales, purchases, payments and expenses re-import with matching totals. Accounts are not in CSV and must exist first (the import says which one is missing).
* Rules: heartbeat location is accepted only from the device location service; internet-address (approximate) and typed (manual) positions are refused even with consent.
* Clear all (portal): non-security entries deleted, security entries archived, clean-up recorded, other data untouched, security entries cannot be deleted.

## Bugs found and fixed during this QC
| Severity | Finding | Fix |
|---|---|---|
| High | Customer-facing licence controls could still be reached from the status banner ("Activate / renew") | Banner now says "License details"; the page has no manual activation or renewal for an active licence |
| High | Heartbeat rules still accepted a guessed (approximate) or typed location | Rules accept `source == "device"` only |
| Medium | Delete of a party silently deactivated it (the UI never offered delete) | Explicit deactivate and delete with dependency messages |
| Medium | Portal dashboard flashed "No signing key" while a remembered key was restoring | Suppressed while restoring |
| Medium | Test harnesses (`ops.emu`, browser flow, cloud check, e2e) were written for older behaviour | Updated to the current behaviour |
| Low | Tiny text, decorative dashes and dots in both apps | 12 px minimum, plain separators, no em dashes |

## Not tested (no such environment here)
* Windows installer (`npm run dist`) and the packaged app on real Windows; the PowerShell `GeoCoordinateWatcher` location read on a real PC (parsing and error classes are unit tested with simulated output).
* Real printers, thermal 80 mm printing, WhatsApp sending to a real account.
* The live Firebase project (rules deploy, hosting), long-polling behind a real corporate proxy, and the real browser Print to PDF of the new invoice (the A4 layout was rendered to a one-page PDF in Chromium and checked visually).
* Load with large real customer data beyond the emulator figures in `perf/`.
* The Super Admin invoice screen flow with a live invoice (creation, payment, print) was not re-run in the browser flow; the invoice component was rendered and viewed with sample data (unpaid, paid, receipt).

## Known limits
* The audit log "Remove entries" is owner only and is not undoable from inside the app; the CSV and the safety backup are the way back.
* A firm, account or user with history is never deleted; it is deactivated so the books stay correct.
