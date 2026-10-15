# DT Solar Pro v1.1 — implementation checklist

Status keys: [x] done & tested · [~] partial · [ ] not started · [!] blocked (needs credentials / input)

## Foundation (shared)
- [x] Desktop schema v2 migration (item details, PIN, archive flags, day/month closing, templates, support queue, WhatsApp log, import runs)
- [x] New desktop permissions + automatic upgrade of built-in roles (`PERMISSION_UPGRADES`)
- [x] IPC route areas (`src/main/ipc/routes/*.ts`), Settings sections registry (`pages/settings/sections.tsx`)
- [x] License payload v1.1 fields (planType, clientId, maxDevices, poweredBy, detached) + detached evaluation
- [x] Cloud data model (`admin-panel/DATA_MODEL.md`) and Firestore rules with role-based admin permissions
- [x] Super Admin shell: 11-item sidebar, RBAC hooks (`useCan`), activity logger, public `/v/<token>` entry

## Desktop areas
- [ ] documents — item name + description in editor/preview/print/PDF, invoice delete rules, template designer, thermal layout, Powered-by toggle
- [x] catalog — product delete/archive/restore + bulk category + category delete-with-reassign, project delete/archive/cancel (list + detail), firm activate/deactivate + active-firm limit, firm isolation fixes, assign shared records (unit tested; e2e pending integrator run)
- [x] documents — item name + description in editor/preview/print/PDF, invoice delete rules, template designer, thermal layout, Powered-by from license (unit-tested; UI e2e left to the integrator run)
- [ ] catalog — product delete/archive + category change, project delete/archive, firm activate/deactivate, firm isolation + limit tests
- [ ] data — day/month closing + closing backup, backup history/export/import/validation, CSV import + reconciliation
- [x] access — user selection + PIN login (lockout 5/5min), PIN lock screen, forced password change gate, printers page + per-document printer + paper size + direct print, test print (unit-tested; consolidated e2e pending)
- [ ] cloud — registration in setup wizard, heartbeat + consented location, support messages with offline queue, certificate refresh, License & About in Settings
- [ ] access — user selection + PIN login, PIN lock screen, forced password change, printers page + per-document printer, test print
- [x] cloud — registration in setup wizard (key + registration / trial / offline), heartbeat + consented location (off/approximate/manual), support messages with offline queue, certificate refresh + detached lifetime, License & About in Settings (unit tests: tests/cloud.test.ts; emulator REST check vs real rules: scripts/cloud-emulator-check.mjs — 32/32; Playwright e2e left to integrator)
- [ ] assist — offline Urdu/English help assistant, built-in WhatsApp Web module (QR link device) + send document flow with log

## Super Admin portal areas
- [x] portal-admin — Admins (RBAC users), Settings (branding/invoice/bank/QR/signing key), Activity Log (filters/export/archive/retention), Verify Key, rules tests
- [ ] portal-licensing — Dashboard metrics/charts, Clients, Licenses lifecycle (renew/plan/limits/detach/history), Devices (+requests), Device Map
- [ ] portal-admin — Admins (RBAC users), Settings (branding/invoice/bank/QR/signing key), Activity Log (filters/export/archive/retention), Verify Key, rules tests
- [x] portal-licensing — Dashboard metrics/charts, Clients, Licenses lifecycle (renew/plan/limits/detach/history), Devices (+requests), Device Map (unit-tested; browser e2e left to integrator)
- [ ] portal-billing — Billing invoices/payments/receipts/reports/PDF, public QR verification page, Support conversations

## Blocked / needs input
- [!] External backup conversion: no sample backup was supplied — generic CSV import pipeline provided instead
- [!] Multi-factor auth for admins: needs Firebase Identity Platform (paid upgrade)
