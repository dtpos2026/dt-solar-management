# DT Solar Pro v1.5: Final update, QC and UAT

Branch `claude/kind-rubin-pbd9yz`. Everything below was executed in the build container (Linux, Electron under Xvfb, Firestore
emulator). Real Windows hardware, real printers, a real WhatsApp account and the live Firebase project were **not** available,
so those items are listed as "not tested" in `docs/QC_UAT_REPORT_v1.5.md`.

## Desktop (DT Solar Pro)
| Area | Change |
|---|---|
| Dashboard | Net Profit uses a money icon. Project Summary shows an empty state instead of "Rs 0 / margin" when there is no revenue. |
| Calendar | One custom date picker (`DateInput`) replaces every native date field: month grid, year list, Today and Clear, min and max. |
| Quotations | Edit and cancel also after conversion (the sale made from it is not touched). Reject keeps the reason. Delete of an open quotation asks for confirmation and is audited. |
| Purchases | Paid and unpaid purchases can be edited, cancelled or deleted. Stock, supplier balance and the payment are adjusted and audited. Sold goods still block a change that would make stock negative. |
| Customers and suppliers | Add, edit, deactivate and delete. Delete is refused with the exact reason when documents, payments or projects exist. |
| Accounts | Deactivate and delete. Delete only when the account has no payments, expenses or transfers. The default account is protected. |
| Users | Disable, enable and delete. The owner and the signed-in user are protected. A user who manages a project or closed a period is disabled instead. |
| Firms | Delete only when the firm is inactive and has no records. Enable and disable (with the licence limit) already existed. |
| Audit log | The owner can remove entries up to a date or the whole log. A CSV copy is saved first (a full database backup too for "whole log"). One permanent entry records the removal. |
| Day Closing | History has From and To date filters. A closed day is corrected by Reopen (reason required, audited) and Close again. |
| Settings | Tabs are grouped under "Preferences" and "Tools and services". |
| Licence and Support | No manual activation, renewal, deactivation or location-send controls for a customer. Information, support chat (Clear chat, Delete chat) and contact stay. The status banner shows "License details", not "Activate / renew". |
| Licence enforcement | Done in the main process, not on screen only: while Digital Target suspends, revokes or releases a computer (or the licence is expired), only the status screen, support and a backup of the customer's own data work. The screen has "Contact Digital Target". Reactivation is picked up within seconds (check every 2 min, 30 s while blocked, on window focus). |
| Location | Asked once from the owner at the first licensed sign-in. Only the Windows location service is read, never the internet address. Denied, Windows blocked, service off, unavailable and offline are reported with a reason instead of a fake place. The server rules accept `source == "device"` only. |
| Version | The app knows its version and the portal's latest published version (License and About). |

## Super Admin panel
| Area | Change |
|---|---|
| Invoice and receipt | New A4 design: purple banner with the Digital Target logo box, spaced "INVOICE", number and status pill, FROM and BILL TO, details card, table, payment details with payment QR and "Scan to verify" QR, totals card (Rs format), terms, signature with signatory name, footer band. Branding gets a "Signatory name" field. |
| Activity Log and Dashboard | Select, Select all, Delete selected, Clear all. Counts really drop; security entries are archived (kept for the trail, out of every count). |
| Devices | Installed and available version with "Update available", active firms of the licence limit (suspended firms are not counted against it), location status with the reason, last seen and online, revoke, release, reactivate, remove. |
| Software version | Settings, Software version: publish the latest and minimum version (public read, `branding.manage` write). |
| Signing key | Remembered in the browser by default; no "No signing key" banner flash while it restores. |
| UI | Minimum 12 px text, plain separators instead of dots, no em dashes, in both apps. |

## Deploy
Portal: `cd admin-panel`, `npm install`, `npm run build`, **`firebase deploy --only firestore:rules`** (required: heartbeat `locationStatus`, `firmsActive`, device-only location), `firebase deploy --only hosting`.
Desktop: `npm install`, `npm run build`, `npm run dist` (keep `keys\license-private.pem`). Customers must install the new desktop build for enforcement, consent and the new actions; the portal changes work with older apps.

## Backup and recovery
See `docs/BACKUP_RECOVERY.md`.
