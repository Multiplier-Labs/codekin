# Relay hardening

**Status:** In progress. Built: §1 (health endpoints), §2 (error reporting), §3 (browser security headers), §4 (connector version floors), §6 (quotas, metering, abuse signals) and §7 (staging tools). The rest is spec.
**Date:** 2026-11-08
**Scope:** hardening features for anyone who runs the relay (`server/relay`), whether self-hosted or as a public service. Values specific to a deployment, such as limits, thresholds and monitoring setup, belong in that deployment's own config. They are not defined here.
**Related:** `docs/RELAY-SIGNED-INTENTS-AND-E2E-SPEC.md`, `docs/SELF-HOSTED-RELAY.md`, `docs/OPERATIONS.md` ("Hosted relay").

---

## 1. Health endpoints

**Built** (`server/relay/health-routes.ts`). `GET /api/health` used to be unauthenticated and report `machinesOnline` and `browserClients`. Those counts are usage data, so the public probes no longer return them.

| Route | Auth | Body |
| --- | --- | --- |
| `GET /api/health/live` | none | `{ "ok": true }`: the process serves HTTP. No dependency checks, so a slow DB never gets a healthy process restarted |
| `GET /api/health/ready` | none | `{ "ok": true }` (200) or `{ "ok": false }` (503). Checks the control-plane DB, both WebSocket servers, and event-loop lag under 1 s. The response doesn't name the failing check; the log does |
| `GET /api/health` | none | alias of `live`, kept so existing probes keep working |
| `GET /api/admin/stats` | operator, full auth level | `{ machinesOnline, browserClients, channelsOpen, connectorVersions }` |

## 2. Error reporting

**Built** (`server/relay/error-reporting.ts`, `telemetry-routes.ts`, `src/hosted/errorReporting.ts`).

- **Optional.** Error reporting is off unless `RELAY_ERROR_DSN` is set. Any service that speaks the Sentry ingest API (GlitchTip, Sentry) works. `RELAY_BROWSER_ERROR_DSN` sends browser errors to a separate project, and `RELAY_ERROR_ENVIRONMENT` sets the environment label.
- **No SDK.** The relay builds each event itself from the error's type, message and stack frames and posts it as an envelope. Nothing else can ride along: no request bodies, headers, cookies, URLs, user or IP. Stack frame paths lose their origin, query string, working directory and home directory. Server errors are tagged with the method and the route *pattern*, never the path. At most 30 events a minute are sent; the rest are dropped.
- **Redaction.** Messages are scrubbed before they leave. That covers:
  - query strings
  - `Bearer`/`Basic` credentials
  - values under keys matching `/secret|token|password|cookie|authorization|code|sig|otp|recovery|credential|session/i`
  - any base64url string of 24 or more characters
- **Never sent:** relay frame payloads.
- **Tests** push a known secret through each path and assert it never reaches the outgoing event.
- **Browser errors** go through the relay (`POST /api/telemetry/errors`), so the CSP can keep `connect-src 'self'` and the visitor's IP stays with the relay. The endpoint is same-origin only, 10/min per IP and 16 KB max. Reports carry only the exception type, a message truncated to 200 characters and scrubbed by the relay, and stack frames: no breadcrumbs, DOM text, console output or session replay. The hosted app reports only errors whose stack runs through its own `/assets/` bundle, five per page load at most. Without a DSN, the relay accepts the report and drops it.

## 3. Browser security headers

**Built.** The hosted frontend is static and served by the reverse proxy. The example configs include a snippet, `nginx/snippets/codekin-security-headers.conf.example`. Include it **in every `location` block**: nginx drops server-level `add_header` in any location that sets its own. The policy, with the optional report endpoint added:

```nginx
add_header Content-Security-Policy "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data: https://avatars.githubusercontent.com; font-src 'self'; connect-src 'self' wss://relay.example.com; manifest-src 'self'; frame-src 'none'; frame-ancestors 'none'; object-src 'none'; base-uri 'none'; form-action 'self'; upgrade-insecure-requests; report-uri /api/csp-report" always;
add_header Strict-Transport-Security "max-age=63072000; includeSubDomains" always;
add_header Cross-Origin-Opener-Policy "same-origin" always;
add_header Cross-Origin-Resource-Policy "same-origin" always;
add_header X-Content-Type-Options "nosniff" always;
add_header Referrer-Policy "strict-origin-when-cross-origin" always;
add_header Permissions-Policy "camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), bluetooth=()" always;
```

Supporting changes (**built**):
- **Fonts** are bundled (`@fontsource`) instead of loaded from Google Fonts. This removes the only third-party origin.
- **Rendered markdown** shows remote images as a link instead of loading them (`src/lib/remoteImage.ts`, used by every markdown renderer). Transcript content then never makes the browser contact third parties.
- **CSP report endpoint:** `POST /api/csp-report` (`server/relay/csp-report-routes.ts`), unauthenticated, 5/min per IP, body ≤ 8 KB. It logs only the directive and the blocked host. Add `report-uri /api/csp-report` to the policy to use it; a new policy can ship as `Report-Only` first.
- **API responses** also carry `Content-Security-Policy: default-src 'none'; frame-ancestors 'none'`.
- **CI check:** `npm run check:csp` checks both builds: `index.html` has no inline `<script>`, and neither it nor the stylesheets name a third-party origin.
- **Self-hosters** replace `YOUR_DOMAIN` in the snippet with their own host.

## 4. Connector version floors per capability

**Built** (`server/relay/connector-version.ts`, `connector-hub.ts`). A connector below `MIN_SUPPORTED_CONNECTOR_VERSION` used to trigger only a warning. Features like signed intents need the relay to refuse machines that can't enforce them. No capability floor is set yet; each one is set when its feature ships.

- **Floors.** `CONNECTOR_FLOORS` in `connector-version.ts` sets a `base` floor plus one floor per capability (`intents`, `e2e`, `credentialClass`). Connectors advertise capabilities in `ConnectorHello.capabilities.features`. A machine has a capability when it advertises it **and** meets that capability's floor.
- **Below a floor, or missing a capability its workspace requires:**
  - The hub keeps the socket open. Closing it would put old connectors in a reconnect loop.
  - It sends `hello_ack.updateRequired: { minimum, missing, reason }`.
  - It refuses every request and stream to the machine with `connector_update_required`. The hosted app shows the machine as **update required**; the connector reports `update_required` in `codekin relay status` and the local Settings.
- **Workspace setting.** `workspaces.required_capabilities` (JSON array). The default is empty. It is read when a machine connects; there is no API to change it yet, since no capability has shipped.
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

**Built:** the quotas (`server/relay/quotas.ts`), usage metering and the bandwidth throttle (`server/relay/usage-meter.ts`), and abuse signals (`server/relay/abuse-signals.ts`).

- **Quotas** come from an `EntitlementsProvider`. The default reads `RELAY_QUOTAS_FILE` (JSON) at boot; without it, everything is unlimited. A malformed file stops the relay rather than running it unlimited. A missing key is unlimited, `workspaces` entries override `default` key by key, and `null` in a workspace entry lifts that limit for the workspace:

  ```json
  {
    "default":    { "machinesPerWorkspace": 25, "pendingPairingsPerUser": 5, "browserSocketsPerUser": 10,
                    "channelsPerUser": 16, "invitationsPerWorkspacePerDay": 50, "sharesPerSession": 10 },
    "workspaces": { "<workspace-id>": { "machinesPerWorkspace": 100, "channelsPerUser": null } }
  }
  ```

  | Quota | Counts | Checked at |
  | --- | --- | --- |
  | `machinesPerWorkspace` | machine rows in the workspace, including unfinished setups | install command (`pair/precreate`) and CLI pairing approval |
  | `pendingPairingsPerUser` | the user's approved pairings no machine has claimed yet | the same two points |
  | `browserSocketsPerUser` | the user's open relay connections, on every machine | browser `hello`; refused with close code 4030, which the app doesn't retry |
  | `channelsPerUser` | the user's open session streams, on every machine | `stream_open`; a channel error with code `quota_exceeded` |
  | `invitationsPerWorkspacePerDay` | invitations created in the last 24 hours, resends included | invitation create and resend |
  | `sharesPerSession` | other people the session is shared with now; changing an existing grantee's share is free | share create |
  | `relayedBytesPerWorkspacePerDay` | bytes relayed for the workspace's machines today (UTC), both directions | every relayed frame; throttles, never refuses |
  | `throttledBytesPerSecond` | not a limit: the rate per connection once the daily bytes are used up (default 64 KiB/s) | — |

  The limits that apply are those of the workspace the action happens in. For a browser connection, that is the machine's workspace.
- **Over a quota.**
  - Discrete limits answer HTTP 429 `{ error: 'quota_exceeded', quota, limit, message }`, and the hosted app shows `message`.
  - Over `relayedBytesPerWorkspacePerDay`, traffic slows instead of stopping, so an active session keeps working. Each connection gets a token bucket at `throttledBytesPerSecond`. When it's empty, the relay stops *reading* that socket for a moment (at most 5 s), so TCP backpressure holds the excess at the sender and the relay buffers nothing. The throttle lifts at UTC midnight and is logged once per workspace per day.
- **Usage metering.** Both hubs count every frame they receive, from machines (`bytes_m2b`) and browsers (`bytes_b2m`), against the workspace that owns the machine. Counts are flushed every minute to `usage_daily (workspace_id, day, bytes_b2m, bytes_m2b, frames)` and kept 400 days. A crash loses at most a minute of counting, which is fine for quotas and capacity planning; it is not a billing meter. Metering runs with or without a quotas file.
- **Abuse signals.** The connector protocol is open, so a "machine" can be any program that uses the relay as a generic pipe. The hub keeps a per-machine traffic window: frames, bytes in both directions, large frames, stream frames that aren't a JSON object with a string `type`, and the sessions the connector last advertised. Each window it hands the summary to an `AbuseSignals` policy.
  - **Policy file.** The built-in policy reads rules from `RELAY_ABUSE_POLICY_FILE`. Without one, nothing is evaluated and no payload is inspected. Every rule is optional, and a malformed file stops the relay at boot:

    ```json
    {
      "windowMinutes": 10,
      "malformedStreamFrames":  { "minFrames": 200, "ratio": 0.01, "action": "flag" },
      "largeFrames":            { "minFrames": 100, "ratio": 0.5, "frameBytes": 6000000, "action": "flag" },
      "sustainedThroughput":    { "bytesPerSecond": 1000000, "windows": 2, "action": "throttle" },
      "trafficWithoutSessions": { "bytes": 100000000, "action": "flag" }
    }
    ```

    These numbers illustrate the format; they aren't recommendations.
  - **Actions** are `flag` (the operator's review queue) and `throttle` (flag, and slow the workspace's relayed traffic as if it were over its daily bytes, until the flag is resolved). There is one open flag per machine and signal. Flags carry numbers only, never payloads, and are audit-logged (`abuse_flagged`, `abuse_flag_resolved`).
  - **Review.** The operator reviews flags in **Settings → Accounts → Abuse review**, or with `GET /api/admin/abuse-flags` and `POST /api/admin/abuse-flags/:id/resolve` (a note and a fresh second factor required). Stopping a machine (disabling its owner) stays a deliberate operator action.

## 7. Test sessions for staging

**Built** (`server/relay/relay-admin-cli.ts`, `scripts/staging/gate.mjs`).

- **Staging mode.** `RELAY_STAGING=1` marks a relay as a test deployment:
  - The app shows a **STAGING** badge and title prefix (from `GET /api/auth/config`).
  - API responses send `X-Robots-Tag: noindex, nofollow`. Set the same header on the static app in the reverse proxy.
  - The admin CLI may mint sessions.
- **Command.** `node server/dist/relay/relay-admin-cli.js mint-session <github-id> [--hours N]` (at most 24 hours, default 8) writes a fully signed-in session for an existing, active account and prints the cookie (`codekin_relay_sid=…`) on stdout. Automated suites can then run without a test-login HTTP route; using the command needs a shell on the host, the same trust as the database file. It is audited (`session_minted`).
  - An account with a second factor gets a fresh one on its session, so step-up passes.
  - An account that must have 2FA but doesn't is sent to enrollment, as a real sign-in would be.
- **Guard.** The command refuses unless the relay's config has `RELAY_STAGING=1`, so it does nothing on a relay without that flag.
- **Suite.** `node scripts/staging/gate.mjs [--report out.md] [--no-frontend]` with `GATE_URL` and `GATE_COOKIE_A/B/C` (A owns WS-A and a machine in it, B owns WS-B, C is a member of both). Each identity has a positive control, so a bad cookie fails the run instead of passing it vacuously. It checks:
  - the public surface: health bodies, CSP and HSTS, anonymous access, operator stats
  - workspace isolation over REST: reading, listing by naming another workspace, sharing, removing, pairing and inviting across workspaces, the origin guard
  - machine isolation over the relay socket: a non-owner (even a fellow member) gets close 4003; a cross-origin socket is refused

  The report adds the manual checklist (real machines, invitation misuse, concurrency, live demotion, MFA recovery). `server/relay/staging-gate.test.ts` runs the suite against a real relay process in CI. The forged-principal cases from the intents spec join it when L1 ships.
