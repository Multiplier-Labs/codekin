# Relay hardening

**Status:** Spec. Nothing here is built.
**Date:** 2026-11-08
**Scope:** hardening features for anyone who runs the relay (`server/relay`), whether self-hosted or as a public service. Values specific to a deployment, such as limits, thresholds and monitoring setup, belong in that deployment's own config. They are not defined here.
**Related:** `docs/RELAY-SIGNED-INTENTS-AND-E2E-SPEC.md`, `docs/SELF-HOSTED-RELAY.md`, `docs/OPERATIONS.md` ("Hosted relay").

---

## 1. Health endpoints

`GET /api/health` (`server/relay/relay-server.ts:128`) is unauthenticated and reports `machinesOnline` and `browserClients`. Those counts are usage data, so it should stop returning them.

| Route | Auth | Body |
| --- | --- | --- |
| `GET /api/health/live` | none | `{ "ok": true }`: the process serves HTTP. No dependency checks, so a slow DB never gets a healthy process restarted |
| `GET /api/health/ready` | none | `{ "ok": true }` (200) or `{ "ok": false }` (503). Checks the control-plane DB, both WebSocket servers, and event-loop lag under 1 s. The response doesn't name the failing check; the log does |
| `GET /api/health` | none | alias of `live`, kept so existing probes keep working |
| `GET /api/admin/stats` | operator, full auth level | `{ machinesOnline, browserClients, channelsOpen, connectorVersions }` |

## 2. Error reporting

- **Optional.** Error reporting is off unless `RELAY_ERROR_DSN` is set. Any service that speaks the Sentry API works.
- **Scrubbing.** Before anything is sent, the relay drops:
  - request bodies and cookies
  - every header except `user-agent`, `content-type` and `content-length`
  - all query strings
- **Redaction.** It also redacts:
  - values under keys matching `/secret|token|password|cookie|authorization|code|sig|otp|recovery|credential|session/i`
  - any base64url string of 24 or more characters
- **Never sent:** relay frame payloads.
- **Tests** push a known secret through each path and assert it never reaches the outgoing event.
- **Browser errors** go through the relay (`POST /api/telemetry/errors`, rate-limited), so the CSP can keep `connect-src 'self'`. They carry only exception type, a truncated and scrubbed message, and stack frames: no breadcrumbs, no session replay.

## 3. Browser security headers

The hosted frontend is static and served by the reverse proxy. Today only `/api` responses carry security headers. The example config gains a snippet, `nginx/snippets/codekin-app-security-headers.conf`. Include it **in every `location` block**: nginx drops server-level `add_header` in any location that sets its own.

```nginx
add_header Content-Security-Policy "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data: https://avatars.githubusercontent.com; font-src 'self'; connect-src 'self' wss://relay.example.com; manifest-src 'self'; frame-src 'none'; frame-ancestors 'none'; object-src 'none'; base-uri 'none'; form-action 'self'; upgrade-insecure-requests; report-uri /api/csp-report" always;
add_header Strict-Transport-Security "max-age=63072000; includeSubDomains" always;
add_header Cross-Origin-Opener-Policy "same-origin" always;
add_header Cross-Origin-Resource-Policy "same-origin" always;
add_header X-Content-Type-Options "nosniff" always;
add_header Referrer-Policy "strict-origin-when-cross-origin" always;
add_header Permissions-Policy "camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), bluetooth=()" always;
```

Supporting changes:
- **Fonts** are bundled (`@fontsource`) instead of loaded from Google Fonts. This removes the only third-party origin.
- **Rendered markdown** shows remote images as a link instead of loading them. Transcript content then never makes the browser contact third parties.
- **CSP report endpoint:** `POST /api/csp-report`, unauthenticated, rate-limited, body ≤ 8 KB. Ship the policy as `Report-Only` first.
- **CI check:** the hosted build's `index.html` has no inline `<script>` and no third-party origins.
- **Self-hosters** replace `relay.example.com` with their own host.

## 4. Connector version floors per capability

Today a connector below `MIN_SUPPORTED_CONNECTOR_VERSION` only triggers a warning (`connector-hub.ts:385`). Features like signed intents need the relay to refuse machines that can't enforce them.

- **Floors.** `CONNECTOR_FLOORS` in `connector-version.ts` sets a `base` floor plus one floor per capability (`intents`, `e2e`, …). A machine has a capability when it advertises it **and** meets that capability's floor.
- **Below a floor, or missing a capability its workspace requires:**
  - The hub keeps the socket open. Closing it would put old connectors in a reconnect loop.
  - It sends `hello_ack.updateRequired: { minimum, missing, reason }`.
  - It marks the machine `update_required` and refuses browser traffic to it with `connector_update_required`.
- **Workspace setting.** `required_capabilities` per workspace. The default is empty for self-hosted relays.
- **Floors only go up.** `/api/admin/stats` shows the version spread before a floor is raised.

## 5. Secret storage

- **Interface.** `server/relay/secret-store.ts` defines a `SecretStore` (`get`, `set`, `delete`) with two implementations:
  - `FileSecretStore`: today's `relay.json` (0600), still the default for the CLI.
  - `HelperSecretStore`: used when `CODEKIN_SECRET_HELPER` is set.
- **Desktop app.** It bundles a signed helper (`codekin-secrets`, built on the Rust `keyring` crate) and points the server at it, so the machine secret lives in the macOS Keychain. `relay.json` then holds `"secretRef": "keychain"`.
  - Secrets travel over stdin/stdout, never argv.
  - Migrating an existing file is atomic: write to the Keychain, read it back and compare, then rewrite `relay.json` without the secret.
- **Other keys.** The L1 machine identity key and the L2 key-agreement key use the same store.
- **Limit.** This protects against backups and sync tools. It doesn't protect against code already running as the user.

## 6. Quotas and abuse hooks

These are mechanisms only. No limits are built in, and a relay without config stays unlimited, as it is today.
- **Quotas** come from an `EntitlementsProvider`. The default reads `RELAY_QUOTAS_FILE` (JSON); without it, everything is unlimited. Quota types:
  - machines and pending pairings per account
  - browser sockets and channels per user
  - relayed bytes per account per day
  - invitations per workspace per day
  - shares per session
- **Over a quota.**
  - Discrete limits answer `{ error: 'quota_exceeded', quota, limit }`.
  - Bandwidth can throttle (bytes per second per socket) rather than refuse, so an active session slows down instead of breaking.
- **Usage metering.** A `usage_daily` table holds bytes, frames and channel-seconds per account per day, flushed from memory every minute.
- **Abuse signals.** An `AbuseSignals` hook gets per-machine traffic summaries: frame shape, sustained throughput, sessions advertised. It can flag, throttle or quarantine, and every action is audit-logged. The relay ships only the hook.

## 7. Test sessions for staging

- **Command.** `relay-admin mint-session --user <githubId> --auth-level full` writes a session row to the local DB and prints a cookie, so automated suites can run against a staging relay without a test-login HTTP route.
- **Guard.** It refuses unless `RELAY_STAGING=1` is set and `publicUrl` differs from the configured production URL.
- **Suite.** `scripts/staging/gate.e2e.mts` runs against any relay URL. It covers the cross-tenant suite from `docs/HOSTED-WORKSPACES-AND-MFA-PLAN.md` (Phase 4), the forged-principal cases from the intents spec, and the checks in this document.
