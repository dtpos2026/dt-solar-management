# DT Solar Pro v1.3 — Super Admin fixes + instant activation

## Root cause of the endless "Waiting for approval"
On the Spark plan (no server code) every online activation created an `activationRequests` document that only an admin
with the signing key loaded in the portal could approve (auto-approve was removed in v1.2). A valid key therefore never
activated by itself, and the desktop polled forever.

## Fix
* The portal publishes a signed **activation pass** per active license (`activationPasses/{sha256(key)}`), kept current
  automatically while the signing key is loaded (`<PassSync/>`; the key is now remembered by default, so no repeated prompts).
* The desktop fetches the pass with the typed key, verifies the signature, checks `licenseStatus`, and registers its own
  computer in one Firestore commit. The rules accept it only for an **active, unexpired license with a free slot and a
  computer never registered before** (`selfActivation` / `selfDevice`). Result: a valid key activates immediately.
* Approval remains only where genuinely required, with the reason shown in the app: device limit full (replace a computer),
  computer released/deactivated earlier, or a key without a published pass. A pending request retries the instant path
  (≤ 1/min, "Check now" forces it) and the portal closes it automatically once the computer is active.
* Security: a pass copied to another computer is refused (valid only on the computer that registered it online);
  slot counter cannot be raised without a matching device record; suspended/revoked/expired licenses are refused;
  the private key never leaves the owner's browser.

## Portal fixes
* Clients: delete with confirmation (blocked while an active license is linked; unlink option), persists, list updates at once.
* License form: manual client name / phone / company; client created or updated on save with no duplicates (phone, then company+owner).
* License delete (owner): removes pass, history, device records, status, answers pending requests; confirmed by typing DELETE.
* Devices and Map: "Remove device" in both; map shows device, company, last seen, location time, accuracy and source;
  devices without a location are listed as unavailable (never faked).
* Billing: invoice delete (cancelled or unpaid, with payments and public copy), A4 and 80 mm invoice/receipt print,
  WhatsApp share and copy link; cancellation unchanged.
* Settings: fixed the bug where stored settings (including the logo) never reappeared after reload and could be overwritten
  on Save; saving writes only changed fields; Saving→Saved always finishes.
* Performance: reads while moving between pages 2803 → 603; opening Licenses 951 → 1; login 2 → 1 read before the app opens.

## Deploy
Desktop: `npm install`, `npm run build`, `npm run dist` (keep `keys\license-private.pem`).
Portal: `cd admin-panel`, `npm install`, `npm run build`, **`firebase deploy --only firestore:rules`** (required), `firebase deploy --only hosting`.
Then open the portal, load the signing key once (tick "Remember"): passes for all active licenses are published automatically.

## Tests actually run
typecheck 0 errors; root vitest 16 files / 281 passed; portal tsc + vite build OK; portal emulator suite 43/43;
desktop-vs-rules emulator check 59/59 (instant activation, limit full, same computer, copied pass, suspended, released, forged writes);
desktop e2e smoke 0 errors (before the final portal merge; desktop code unchanged since).

## Not done / limitations
* Not tested on real Windows or the live Firebase project.
* Portal local-first preferences (sidebar, page sizes, filters) not added; there is no theme switch in the portal.
* Invoice creation time unchanged (~0.9 s on the emulator; reads 4 → 2).
* Licenses created before the first portal visit with the key loaded need that visit once to get their pass; until then they use approval.
* Deleting a license does not block already-activated computers immediately (they go read-only after check-in + grace days); use Revoke for an immediate block.
