# DT Solar Pro v1.4: Super Admin performance and control fixes

Branch `claude/kind-rubin-pbd9yz`. Everything below was executed in the build container (Linux, Electron under Xvfb, Firebase
emulators). Real Windows hardware and the live Firebase project were **not** available.

## Root causes found and fixed
| Problem | Root cause | Fix |
|---|---|---|
| Approvals / device actions felt stuck for 30 s+ | The portal used the default Firestore transport, which waits about 10 s per attempt before falling back when streaming is blocked or throttled (some Windows proxies, VPNs, antivirus). An approval was also about 10 sequential round trips (lookup, request read, 4 sequential transaction reads, commit, certificate write, request write, client link) | Long-polling auto-detect (`initializeFirestore`). An approval is now **one transaction** (reads in parallel, slot + device + history + certificate in `licenseStatus.certs` + the request answer in one commit; no lookup query when the license is known). Reactivation signs the certificate inside its transaction. Measured on the emulator: approval = 1 transaction, 0 other reads (was lookup + 3 reads + 1 transaction + 2 writes) |
| Suspend / revoke / release reached the app up to an hour late | Background license check ran once an hour | Command sync every 5 min while the app runs, 30 s while blocked, on window focus, back-off while offline |
| Reactivated computer stayed blocked after password entry or retry | (1) a blocked app did not re-verify within 5 min of its last check; (2) unlock (password entry) never verified; (3) a stored block made the pass / certificate install refuse as "issued before that decision" | Blocked computers re-verify after 8 s; unlock verifies like sign-in; online proof clears the stored block; **Check again** button on the license banner |
| Pending activation polled too slowly / too long | Fixed 5-8 s polling forever | 3 s for 2 min, then 10 s, then 30 s (free read quota) |
| Approve dialog could stay busy forever | Early `return` after `setBusy(true)` when a replacement computer was not chosen | Validation first |
| Map without pins gave no reason | Desktop sends a location only with consent; nothing said why it did not | Heartbeat carries `locationNote`; the map lists each computer with its reason. Never a guessed position |
| Activity noise | Pass housekeeping wrote an audit entry per license; double clicks / re-run effects wrote twice | History only for housekeeping; identical entries within 5 s are one |

## New
* **Clear chat / Delete chat** (Support), **Clear all** (Activity Log and Dashboard recent activity; security trail kept, one security entry records it).
* **Reset Administrator password** (Devices): signed, device-bound, one-time, 72 h, only a PBKDF2 verifier travels, online or offline delivery, forced new password, progress and audit. Details in `docs/LICENSING.md`.
* UI: Project Summary empty state (no "Rs 0 / margin" without revenue), removed "e.g. / printed as" hint text, "not a cloud AI" line, map wording.

## Deploy
Portal: `cd admin-panel`, `npm install`, `npm run build`, **`firebase deploy --only firestore:rules`** (required: new rules for commands, heartbeat fields, chat deletion), `firebase deploy --only hosting`.
Desktop: `npm install`, `npm run build`, `npm run dist` (keep `keys\license-private.pem`). Customers must install the new desktop build for command sync, reset and location notes; the portal changes work with old apps.

## Tests actually run
| Test | Result |
|---|---|
| `npm run typecheck` (desktop + shared) and portal `tsc` + `vite build` | 0 errors, built |
| `npx vitest run` | 17 files, **292 passed** (new: `tests/admin-reset.test.ts` 9, license sync / reactivation tests) |
| Portal emulator suite (`admin-panel/tests`, real rules): approval in one transaction, hinted approval without lookup, reactivation certificate, Clear / Delete chat (450 messages, rules), Clear all, de-duplication, password-reset publishing and authorisation, heartbeat fields | **51 / 51** |
| `scripts/cloud-emulator-check.mjs` (desktop REST vs real rules): instant activation, reactivation after a stale block, retry timing, command delivery at check-in, heartbeat fields, forged writes | **69 passed, 0 failed** |
| Real-browser flow on the emulator (Playwright): load key, Clear chat, Delete chat, dashboard Clear all, approve (253 ms), reset Administrator password, map reasons and pin | **15 passed, 0 failed, 0 page errors** |
| Desktop e2e in the real Electron app (`scripts/e2e-smoke.mjs`), including the Administrator reset (foreign code refused, temporary password signs in once, new password forced, old one dead) | **0 errors** |

## Limits
* The 30-35 s delay could not be reproduced here (emulator latency is near zero); the fix is based on the transport behaviour and on removing sequential round trips, both verified by test.
* A computer that is offline is not controllable until it reconnects (by design); the Super Admin sees delivery status for password resets only after the computer's next heartbeat (up to 15 min).
* The signing key is now remembered in the browser by default (to stop the repeated prompts). Untick *Remember* on a shared computer; the key never leaves the browser.
* Locations still depend on the customer enabling sharing (consent) and, for exact pins, Windows location services.
