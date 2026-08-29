# Device Link & Passkey Authentication

**Status**: Draft spec
**Goal**: Let a signed-in user bring a phone (or any second browser) onto hosted Codekin by scanning a QR code — no password, no GitHub round trip on the small screen — and keep that device signed in afterwards with platform biometrics (Face ID / fingerprint) via WebAuthn passkeys.

---

## 1. Problem

Hosted Codekin authenticates with GitHub OAuth and a 30-day rolling cookie session
(`codekin_relay_sid`, DB-backed in `web_sessions`). That is fine on a desktop where the
user is already signed in to GitHub. On a phone it is clumsy:

- First login means a GitHub redirect in a mobile browser: typing a GitHub password
  and completing 2FA on a phone keyboard.
- When the cookie eventually expires (or the user installs the app to the home screen,
  which on iOS gets its own cookie jar), the whole dance repeats.
- There is no notion of a "device": the browser *is* the cookie. Nothing can be listed
  or revoked per device, and nothing cheaper than a full OAuth login can mint a session.

Meanwhile the relay already solves the equivalent problem for machines: device-code
pairing (`server/relay/pairing.ts`) with hashed codes at rest, short TTLs and one-shot
claims. This spec points the same pattern in the opposite direction — from an
authenticated browser toward an unauthenticated one — and adds WebAuthn passkeys so
subsequent logins on that device are a single biometric prompt.

---

## 2. Non-Goals

- Do not replace GitHub OAuth as the identity source. Accounts are still created and
  role/allowlist-gated through GitHub login (`resolveUserAccess`). Device links and
  passkeys only mint sessions for accounts that already exist and are `active`.
- Do not build a native mobile app. The client is the existing SPA, optionally
  installed to the home screen.
- No TOTP/SMS second factors; WebAuthn covers the "something you have + something you
  are" combination natively.
- No cross-device WebAuthn "hybrid" (QR + BLE) login flow. The first-party QR link is
  smoother, works without Bluetooth proximity, and reuses an existing pattern. Nothing
  here precludes adding it later — it would only be additional client UI over the same
  passkey endpoints.
- No change to the local (self-hosted) server's token model. See §10 for the
  self-hosted answer.

---

## 3. Overview

Two mechanisms, independently useful, designed to compose:

1. **Device link (QR)** — instant sign-in on a new device. A signed-in browser mints a
   single-use short-lived link code and renders it as a QR. The new device opens the
   URL, posts the code, and receives a session for the same user. Zero typing.
2. **Passkeys (WebAuthn)** — durable re-auth on that device. After the first sign-in,
   the device is offered biometric enrollment (`navigator.credentials.create` with a
   platform authenticator). From then on the login page offers "Unlock with passkey":
   one biometric prompt mints a fresh session, no GitHub round trip, even after months
   away.

The security asymmetry with machine pairing is deliberate and worth stating: in machine
pairing the code originates on the *unauthenticated* side, so a human must approve it
in the hosted UI. Here the code originates on an *authenticated* device and is
displayed only there — possession of the code is the approval. Single use, a short
TTL, hashing at rest and rate limiting bound the exposure; no approval round trip is
needed.

```text
Desktop (signed in)                Relay                       Phone
     |  POST /api/auth/device-link/start                          |
     |--------------------------------->|                        |
     |   { linkUrl, requestId, ttl }    |                        |
     |<---------------------------------|                        |
     |  renders QR of linkUrl           |                        |
     |                                  |     scans QR, opens    |
     |                                  |     /link#<code>       |
     |                                  |<-----------------------|
     |                                  | POST /api/auth/device-link/complete
     |                                  |<-----------------------|
     |                                  |  validate hash, TTL,   |
     |                                  |  single-use; creator   |
     |                                  |  still active          |
     |                                  |  regenerate session,   |
     |                                  |  set cookie            |
     |                                  |----------------------->|
     |  GET .../status → claimed        |   signed in; offer     |
     |<---------------------------------|   passkey enrollment   |
```

---

## 4. Device Link

### 4.1 Flow

1. **Start** — the signed-in browser calls `POST /api/auth/device-link/start`
   (guarded by `requireActiveUser`). The server mints a 32-byte `base64url` link code,
   stores only its SHA-256 hash together with the creating user id, and returns
   `{ requestId, linkUrl, expiresAt }` where
   `linkUrl = ${PUBLIC_URL}/link#<code>`.
2. **Display** — the client renders `linkUrl` as a QR code, alongside a copy-link
   button (for linking a second desktop browser or sending via an already-secure
   channel). It polls `GET /api/auth/device-link/:requestId/status` to switch the
   dialog to "Linked ✓" when claimed.
3. **Claim** — the phone scans the QR with the camera, which opens `/link#<code>` in
   the browser. The SPA reads the code from `location.hash` (and immediately clears
   it via `history.replaceState`), then calls
   `POST /api/auth/device-link/complete { code }`.
4. **Mint** — the server hashes the code, looks up the pending request, checks TTL and
   single-use status, re-reads the creating user from the DB and requires
   `status = 'active'`, then marks the request `claimed`, **regenerates the session**
   (fixation, same as the OAuth callback), writes `session.user`, and records a
   `device_linked` audit event with IP and user agent. Response: `{ user }`.
5. The phone is signed in and proceeds to passkey enrollment (§5).

### 4.2 Why the code rides in the URL fragment

The fragment is never sent to the server, so the code cannot appear in nginx access
logs, relay logs, or `Referer` headers. Only the deliberate
`POST /api/auth/device-link/complete` carries it, in the request body, over TLS.

### 4.3 Parameters

| Parameter | Value | Rationale |
|---|---|---|
| Code entropy | 32 random bytes, `base64url` | Same as machine device codes |
| Storage | SHA-256 hex of the code | DB theft yields nothing claimable |
| TTL | 3 minutes | The QR is scanned within seconds; anything longer only helps an attacker who photographed the screen |
| Uses | Exactly one — `claimed` is a terminal state | A replayed code cannot mint a second session |
| Start rate limit | Covered by existing `/api/auth` limiter (20/min/IP) plus `requireActiveUser` | |
| Complete rate limit | Covered by existing `/api/auth` limiter | Online guessing of a 256-bit code is not the constraint; the limiter bounds DB write pressure |

Expired and claimed rows are swept opportunistically (on `start`) rather than by a
timer; the table stays tiny.

### 4.4 Endpoints

```text
POST /api/auth/device-link/start              requireActiveUser
GET  /api/auth/device-link/:requestId/status  requireActiveUser (creator only)
POST /api/auth/device-link/complete           unauthenticated (possession of code)
```

All three live under `/api/auth`, inheriting the existing per-IP rate limiter.
`complete` responds `404` for unknown/claimed codes, `410` for expired, `403` when the
creating user is no longer active — mirroring `pair/complete` semantics.

### 4.5 Schema

```sql
CREATE TABLE IF NOT EXISTS device_link_requests (
  id                TEXT PRIMARY KEY,            -- uuid, safe to expose for status polls
  code_hash         TEXT NOT NULL UNIQUE,        -- sha256 hex of the link code
  created_by_user_id TEXT NOT NULL REFERENCES users(id),
  status            TEXT NOT NULL DEFAULT 'pending',  -- pending | claimed
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at        INTEGER NOT NULL,            -- epoch ms
  claimed_at        TEXT,
  claimed_ip        TEXT,
  claimed_user_agent TEXT
);
```

Additive `CREATE TABLE IF NOT EXISTS` in the single `SCHEMA` string
(`control-plane-db.ts`), consistent with how the schema evolves today (no migration
runner).

---

## 5. Passkeys (WebAuthn)

### 5.1 Enrollment

Offered on any signed-in device where `window.PublicKeyCredential` exists — prompted
contextually right after a device-link claim (that is the moment the user is holding
the phone), and available any time from the account menu.

1. `POST /api/auth/webauthn/register/options` (guarded by `requireActiveUser`) returns
   `generateRegistrationOptions()` output: RP id = hostname of `PUBLIC_URL`, user id =
   our `users.id`, `authenticatorSelection: { residentKey: 'preferred',
   userVerification: 'required' }` (platform authenticators produce discoverable
   credentials; `required` verification is what makes the biometric prompt appear).
   Excludes already-registered credential ids. The challenge is stored in the session.
2. The client runs `startRegistration()` (`@simplewebauthn/browser`).
3. `POST /api/auth/webauthn/register/verify` validates with
   `verifyRegistrationResponse()` against the session challenge, expected origin
   (`PUBLIC_URL`) and RP id, then inserts a `webauthn_credentials` row and records a
   `passkey_registered` audit event. The client supplies an optional `label`
   (defaulting to a UA-derived guess like "iPhone — Safari").

### 5.2 Login

The login page grows a second path next to "Continue with GitHub": **"Unlock with
passkey"**, shown when the browser supports WebAuthn (and eagerly attempted via
Conditional UI / `autofill` where available).

1. `POST /api/auth/webauthn/login/options` (unauthenticated, `/api/auth` rate limit)
   returns `generateAuthenticationOptions()` with **empty `allowCredentials`** — the
   discoverable-credential flow, so the server needs no username first — and
   `userVerification: 'required'`. Challenge goes in the (anonymous) session.
2. The client runs `startAuthentication()`; the platform shows Face ID / fingerprint.
3. `POST /api/auth/webauthn/login/verify` looks up the credential by id, validates
   with `verifyAuthenticationResponse()` (origin, RP id, challenge, signature,
   counter), re-reads the owning user and requires `status = 'active'`, updates
   `counter` and `last_used_at`, **regenerates the session**, writes `session.user`,
   records a `passkey_login` audit event, and returns `{ user }`.

A disabled or deleted user's passkeys thus stop working immediately — the check runs
at every login, and live sessions are already re-validated per request by
`requireActiveUser` and per upgrade by `authenticateUpgrade`. Neither WebSocket
chokepoint changes: a session minted by passkey is indistinguishable from one minted
by OAuth.

### 5.3 Management

```text
GET    /api/auth/passkeys        requireActiveUser — list own credentials
DELETE /api/auth/passkeys/:id    requireActiveUser — delete own credential
```

Listed with label, created and last-used timestamps. Deletion records
`passkey_removed`. Deleting the last passkey is allowed — GitHub OAuth always remains
as the recovery path, which is also why passkey lockout needs no special handling.

### 5.4 Schema

```sql
CREATE TABLE IF NOT EXISTS webauthn_credentials (
  id            TEXT PRIMARY KEY,                -- uuid
  user_id       TEXT NOT NULL REFERENCES users(id),
  credential_id TEXT NOT NULL UNIQUE,            -- base64url, as sent by the authenticator
  public_key    TEXT NOT NULL,                   -- base64url COSE public key
  counter       INTEGER NOT NULL DEFAULT 0,
  transports    TEXT,                            -- JSON array, e.g. ["internal","hybrid"]
  label         TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  last_used_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_webauthn_credentials_user ON webauthn_credentials(user_id);
```

### 5.5 Library

`@simplewebauthn/server` on the relay, `@simplewebauthn/browser` in the SPA — the
de-facto standard pair, no native dependencies. Challenge state lives in the existing
`express-session`; no new storage. `PUBLIC_URL` doubles as expected origin, its
hostname as RP id — one config value, zero new environment variables.

---

## 6. Session Model (unchanged, deliberately)

Sessions stay cookie-based, server-side, 30-day rolling. Passkeys do not extend
sessions; they make *re-creating* one cheap. This keeps the two WebSocket/HTTP auth
chokepoints untouched and means every existing revocation property (per-request DB
re-read, upgrade-time status check) applies to passkey-minted sessions for free.

A future hardening option this unlocks: shorten the cookie lifetime (e.g. 7 days) once
passkeys are enrolled, since re-auth costs one biometric tap instead of an OAuth trip.
Out of scope here.

Per-device session attribution ("sign out that phone") requires mapping `web_sessions`
rows to devices. `device_link_requests.claimed_*` plus audit events give forensics
today; a full device registry with per-device sign-out is future work, noted in §9.

---

## 7. Threat Model

| Threat | Mitigation |
|---|---|
| Link code intercepted in transit | TLS; code travels only in a URL fragment (never in server/proxy logs, never in `Referer`) and one POST body |
| QR photographed / shoulder-surfed | 3-minute TTL, single use; the legitimate claim invalidates the copy, and a hostile claim is visible on the desktop's status poll ("Linked" the user didn't do) and in the audit trail |
| DB theft | Only SHA-256 hashes of link codes; passkey rows hold public keys only |
| Link code replay | `claimed` is terminal; second claim → 404 |
| Session fixation via complete/login | `session.regenerate()` before writing the user, same as the OAuth callback |
| CSRF on complete/verify | State-changing POSTs carry secrets (code / signed assertion) in JSON bodies; `sameSite: 'lax'` cookies; JSON body parsing means no form-encoded cross-origin submission applies |
| Phishing a passkey login | WebAuthn origin binding — assertions for `app.codekin.ai` cannot be produced on a look-alike domain |
| Disabled user's phone keeps access | Login verify re-reads user status; existing per-request and per-upgrade re-reads cover live sessions |
| Guessing link codes / credential ids online | 256-bit entropy; `/api/auth` per-IP rate limiter |
| Cloned/rolled-back authenticator | Signature counter checked and persisted per WebAuthn spec |

Audit kinds added: `device_link_created`, `device_linked`, `passkey_registered`,
`passkey_login`, `passkey_removed` — same envelope (`actor_user_id`, `ip`,
`user_agent`, `metadata`) and retention as existing events.

---

## 8. Frontend Changes

- **Link-device dialog** (desktop): "Link a device" action in the machines page
  header / account menu → QR (rendered locally with the `qrcode` package — the link
  must not be sent to a third-party QR service) + copy button + live status.
- **`/link` route** (new device): claims the code from the fragment, shows success,
  then offers passkey enrollment with a skippable prompt. Handled in `HostedApp`
  alongside the existing `/pair` path check.
- **Login page**: "Unlock with passkey" button; on failure or unsupported browsers the
  GitHub button remains primary.
- **Account menu**: passkey list with add/remove.
- **PWA manifest** (hosted build): `manifest.webmanifest` + apple-touch-icon so "Add
  to Home Screen" yields a standalone app. No service worker (nothing here works
  offline anyway). Note: an installed iOS PWA has an isolated cookie jar — its first
  launch lands on the login page, which is precisely the passkey path (or a re-scan of
  a fresh QR); this is the scenario that makes §5 worth building.

Local (self-hosted) build: none of this UI is compiled in; the transport seam
(`src/lib/transport`) already separates the modes.

---

## 9. Rollout

| Phase | Contents | Deploy notes |
|---|---|---|
| 1 | Device link end-to-end (§4, dialog + `/link` route) | Additive table; no env changes; relay restart |
| 2 | Passkeys (§5, login + enrollment UI) | `@simplewebauthn/server` dependency; additive table; relay restart |
| 3 | Device registry & per-device sign-out; optional shorter cookie + passkey step-up; conditional-UI autofill polish | Separate spec-let once 1–2 have usage |

Phases 1 and 2 are independent — either ships alone. Both are pure additions to the
control plane: connector, hubs, relay protocol, and local server are untouched.

---

## 10. Self-Hosted Deployments

The bare-metal deployment (Authelia + shared bearer token) gets its mobile fix through
configuration, not Codekin code:

- **Authelia passkeys**: Authelia ≥ 4.39 supports passwordless passkey login as a
  primary factor. Enabling it lets the phone clear Authelia with Face ID instead of a
  typed password.
- **Token delivery**: the frontend already consumes and strips a `?token=` URL
  parameter into localStorage; a QR of `https://<host>/?token=<AUTH_TOKEN>` onboards a
  phone in one scan. (The token rides in the query, so keep such QRs as private as the
  token itself.)

Documented in `docs/SETUP.md` as part of Phase 1 rather than specced further here.
