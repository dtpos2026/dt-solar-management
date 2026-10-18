# DT Solar Pro — Licensing (desktop side)

Cloud contract: `admin-panel/DATA_MODEL.md`. Server-side checks: `admin-panel/firestore.rules` (Firebase Spark — no Cloud Functions).
Code: `src/main/license/*` (certificate, evaluation, check-ins), `src/main/ipc/router.ts` (write gating), `src/main/cloud/*`.

## Certificates
- A license is an Ed25519-signed certificate (`dtsp-license`, payload v1) bound to this computer's device id. The app holds only
  the PUBLIC key (`resources/license-public.pem`). The private key stays with Digital Target (portal / `scripts/license-tool.mjs`).
- Payload: license id, business, plan, limits (firms / users / devices), `issuedAt`, `expiresAt` (null = lifetime), `leaseUntil`,
  `checkinDays` and `graceDays` (set per license in the portal), `poweredBy`, `detached`.
- Development / automated tests only: an UNPACKAGED run may use a throwaway public key from `DTSP_LICENSE_PUBLIC_KEY_FILE`
  (used by `scripts/e2e-smoke.mjs`). Packaged builds always use the built-in key.

## Activation (no local trial)
- A fresh install is **Not activated**: the setup wizard's License step offers only
  (a) **online activation** — license key + company / owner / phone / address. **Instant** (v1.3): the app fetches the
  license's activation pass (`activationPasses/{sha256(key)}`, signed by the owner's key for device `*`), verifies it,
  checks `licenseStatus`, and registers this computer on the license in one Firestore commit (rules: license active, not
  expired, free slot, computer never registered before) → active at once, no waiting. Only when that is impossible (no pass
  published yet / unknown key, device limit full, computer released or deactivated earlier) an `activationRequests` document
  is created with the reason shown to the customer; the app keeps retrying the instant path (≤ 1/min, "Check now" forces it),
  so a freed slot or a newly published pass completes the activation without an admin; or
  (b) **offline activation** — request code (key + device id) → Digital Target → activation code pasted in the app.
  The wizard cannot continue and no business data can be created (`auth.setup` refuses) until a valid certificate is installed.
- A **trial** is a normal certificate issued by the Super Admin with plan `trial` and a short expiry (about 15 days); the app shows
  "Trial — N days left" from the certificate. When it ends the mode is `trial_expired` (read-only).
- **Old installations** that used the former local 15-day trial (state `trialStartedAt` or `app_meta.trial_started_at`) keep all
  data and open **read-only** (view / print / export / backup) with "Activate your license". The old state is still read safely;
  no local trial is ever started.
- **One slot per computer**: re-entering the key on a computer already registered binds the pass again without using a new
  slot. A pass is valid only on the computer that registered it online (state `boundPass`); copying it elsewhere is refused.
  When the Super Admin later publishes per-device certificates (`licenseStatus.certs`), they replace the pass at check-in.
- License keys and full device ids are never written to logs or the audit trail (the UI shows a masked installation id).

## Command sync, retry and reactivation
- **While the app runs** it asks Digital Target every **5 minutes** for the license status, this computer's decision (suspended,
  revoked, released) and a re-signed certificate; **every 30 s while blocked**; on window focus (at most every 20 s); after a failure
  it retries with back-off (2, 4, 8, max 10 min) and catches up as soon as the connection is back. That is one Firestore read per check
  (about 120 reads per computer per working day).
- **Sign-in, unlock (password entry), a protected write and the "Check again" button** re-verify when the last answer is older than
  **8 s while blocked** (5 min while healthy). A reactivation by the Super Admin is therefore picked up at the next retry; a stored
  block is also cleared by online proof (pass registration / check-in), so a reactivated computer is not kept blocked by stale state.
- **Nothing is claimed while disconnected:** an offline computer keeps following its signed policy (check-in days + grace); a
  suspension or revocation reaches it the moment it can reach Digital Target. The stored decision still cannot be bypassed by deleting files.

## Administrator password reset (Super Admin → Devices → Reset admin password)
1. The portal (signing key loaded) generates a one-time temporary password in the browser and signs a command
   (`type admin_password_reset`, licenseId, **deviceId**, random nonce, issuedAt, expiresAt ≤ 72 h, PBKDF2-SHA256 salt + verifier).
   Only the **verifier** is in the command; the password is shown once to the Super Admin and stored nowhere.
2. Delivery: online computers read `licenseStatus/{licenseId}.commands[deviceId]` at their next check-in; offline computers paste the
   code on the sign-in screen (**Administrator locked out?**, route `auth.applyResetCode`).
3. The app verifies the Ed25519 signature (domain-separated: a command can never be installed as a certificate and vice versa), the
   device id, the expiry and the one-time nonce, then stores it as *pending* (`settings.admin_reset_pending`). Nothing changes yet.
4. The Administrator (owner account) signs in with the temporary password (any case, dashes optional). The app verifies it against
   the verifier, stores a normal scrypt hash, clears any lock-out, forces a new password and burns the nonce. Progress
   (`received` / `used`) is reported to the portal with the heartbeat. Other users and PINs are not touched.
5. The Super Admin can withdraw an unused reset; every issue / withdrawal is a protected `security` entry in the activity log.

## Modes
`not_activated`, `trial`, `active`, `grace` (writes allowed in the last three only), `trial_expired`, `expired`, `suspended`,
`revoked`, `device_deactivated`, `lease_expired` (check-in overdue), `clock_error`, `invalid`.
Each blocked mode has a `blockReason` — `activation`, `license`, `device`, `connectivity`, `clock` — and a specific message.
A license problem never deletes or changes business data.

## Enforcement
- **Start-up**: a background check (never delays the window), then hourly.
- **Sign-in**: a background check (never delays signing in).
- **Before every protected write** (router `route.write`): when online is configured and the last successful verification is older
  than **5 minutes**, a check-in runs first and the write waits at most **4 s**. Successful checks are cached for 5 minutes;
  concurrent checks share one request; after a network failure writes do not wait again for 60 s.
- A check reads `licenseStatus/{licenseId}`: `status` suspended / revoked or this device listed in `deactivatedDevices` blocks
  the write immediately (license message vs device message). Expiry comes from the signed certificate.
- A re-signed certificate in `licenseStatus.certs[deviceId]` (renewal / plan / limits / detach) is installed only when the license
  is not suspended / revoked and this device is not deactivated.
- The remote decision is stored in **both** `license/state.json` and the business DB (`settings.license_remote`): deleting
  either one does not restore access. Re-installing an older certificate cannot lift it; only a certificate issued after the
  decision (re-approval) or a successful check-in that shows the license active again does.
- **Network failures** never clear a stored suspension / revocation / deactivation. They fall back to the signed offline policy:
  after `checkinDays` without a successful check the `graceDays` grace period starts; when it runs out the app is read-only
  (`lease_expired`, "connect to the internet").
- **Limitation**: a computer that stays fully disconnected cannot be blocked instantly — remote suspension reaches it at the next
  successful check-in, or when its check-in deadline + grace period runs out. A detached lifetime license performs no check-ins.

## Location (Settings → Online & location, consent required)
- **off** (default) · **device** — "Use this computer's location service": PowerShell `System.Device.Location.GeoCoordinateWatcher`
  (hidden window, ~10 s wait, 25 s timeout) → `{ source:'device', lat, lng, accuracyKm: HorizontalAccuracy/1000,
  label:'Windows location service', updatedAt }`. Refreshed at most every 6 h; after a failure retried after 1 h. If Windows
  location is off / denied / has no provider / times out, the app shows "unavailable" and sends no location — there is no silent
  fallback · **approximate** — "Approximate (internet IP — usually the ISP's city, e.g. Lahore for Burewala)", ipwho.is, cached
  24 h · **manual** — coordinates typed by the customer.
- Settings shows the source, accuracy and last update time; "Exactly what is sent" previews the heartbeat.

## Tests
- `tests/license.test.ts`: evaluation, no-trial / not-activated, write gating (freshness cache, coalescing, wait limit), remote
  state persistence (state file deleted → DB copy still blocks), certificate refusal while suspended / deactivated.
- `tests/cloud.test.ts`: location parsing / caching (device, approximate, manual), heartbeat shapes, certificate refresh.
- `scripts/cloud-emulator-check.mjs`: the real REST calls against the real rules on the Firestore emulator, incl. suspend → next
  write blocked and device deactivated → device message.
- `scripts/e2e-smoke.mjs`: wizard activation with a throwaway-key offline activation code.

## One signing key for the Super Admin panel and every installer (v1.5.1)
Every license, activation pass, certificate and command is signed in the Super Admin panel with the private key
(`keys\license-private.pem`, never committed) and verified by the installer with the matching public key
(`resources\license-public.pem`). If they differ, the desktop says **"License signature is invalid"**, shows
"Waiting for approval" and never activates, whatever is approved in the panel.

**Cause found in the field:** the repository holds `NOT_CONFIGURED` as the public key. Building from a freshly unzipped source folder
used to create a NEW key pair silently, so the installer carried a public key that did not match the key loaded in the panel.
`npm run build` now **stops** when the folder has neither `keys\license-private.pem` nor a configured public key, and says what to do:
1. copy your existing `keys\license-private.pem` into `keys\` of the new folder, or
2. Super Admin, Settings, Signing key, **Copy public key**, paste it into `resources\license-public.pem`, or
3. only if no license was ever issued: `set DTSP_NEW_KEY=1` for that build, then load the new private key in the panel.

**How to check:** the panel shows the **Key ID** of the loaded key (Settings, Signing key). The installer shows the same ID under
Settings, License and About, "License key ID". They must be equal. Every activation request carries the installer's key ID; the
panel marks a mismatch in red, refuses to approve it and never reports it as "Activated instantly". The desktop explains the same
thing instead of waiting.

