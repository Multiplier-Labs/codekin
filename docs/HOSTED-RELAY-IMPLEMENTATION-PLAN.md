# Hosted Relay & Control Plane — Implementation Plan

**Status**: Proposed
**Companion to**: `HOSTED-RELAY-CONTROL-PLANE-SPEC.md`

This document maps the spec onto the current codebase, fixes concrete technical decisions, and sequences the work into reviewable PRs. It also covers the first deployment target: `app.codekin.ai` on the current dev server.

---

## 1. Current-State Findings

Facts the plan builds on, from a code audit (2026-08-08):

### Frontend network layer (the transport seam)

- The WebSocket half is a clean seam: `wsUrl()` in `src/lib/ccApi.ts:461` is the only WS URL
  construction, called from exactly one place (`src/hooks/useWsConnection.ts:86`).
- The REST half is **not** centralized: four `BASE` constants (`src/lib/ccApi.ts:10`,
  `src/lib/workflowApi.ts:7`, `src/lib/goalRunApi.ts:8`, `src/hooks/useDocsBrowser.ts:10`) plus
  four raw `fetch('/cc/...')` calls (`src/hooks/useRepos.ts:42`,
  `src/components/NewSessionButton.tsx:69`, `src/components/RepoSelector.tsx:50`,
  `src/components/OrchestratorView.tsx:55`).
- Authelia is baked into the frontend transport: `LOGIN_URL`, `redirectToLogin()`,
  `checkAuthSession()` in `ccApi.ts`, plus a 60s auth probe in `useWsConnection.ts:203`. Hosted
  mode needs a different session-expiry strategy.
- The socket lifecycle is already layered: `useWsConnection.ts` (transport, reconnect, auth
  handshake) vs `useChatSocket.ts` (session semantics). Only the lower layer changes for relay.

### Local server

- Single process: Express 5 + `ws` on one HTTP server (`server/ws-server.ts`), port 32352.
  `/cc` is stripped by nginx/Vite before it reaches the server.
- The WS server accepts upgrades on **any** path (`new WebSocketServer({ server })`); path-routed
  upgrades require switching to `noServer: true` + manual `server.on('upgrade')`.
- Auth: bearer token from `~/.config/codekin/token`, verified per-route (REST) and via a
  first-message `{type:'auth', token}` handshake (WS). Exactly what the connector will inject.
- CSP hardcodes `connect-src 'self'` (`server/ws-server.ts:337`) — fine for local mode; the
  hosted frontend is same-origin with the relay, so it stays fine there too.
- WS protocol: 17 client→server kinds, 33 server→client kinds, defined in `src/types.ts`. The
  relay wraps these opaquely (spec §7.5) — no changes needed.
- CLI: `bin/codekin.mjs` (single file), command dispatch at `:503`; `relay` subcommands slot in
  there. Note `server/dist/` is in the npm `files` list but no script builds it — the CLI falls
  back to `tsx` on raw `.ts`. The connector must work under that fallback too.

### Gitnook auth reference (`/srv/repos/gitnook`)

- Hand-rolled GitHub OAuth (no passport/arctic): `/auth/github/start` generates `state` into the
  session and 302s to GitHub; callback exchanges the code, upserts the user, regenerates the
  session. Server-side sessions in SQLite (`@fastify/session` + custom store), cookie
  `sameSite: 'lax'` (required for the OAuth return trip), `rolling: true`, 30 days.
- Load-bearing details to replicate: explicit promisified `session.save()` before the OAuth
  redirect (otherwise `state` is lost), `session.regenerate()` after login (session fixation),
  session-store TTL from `cookie.originalMaxAge` (not `maxAge`, which shrinks under rolling).
- Frontend: one `/me` call on boot into a store with an `isInitialized` one-shot latch (prevents
  login-screen flash); 401 responses dispatch a global `auth:unauthorized` event.
- **Gitnook has no user allowlist** — anyone with a GitHub account gets in, because
  authorization is delegated to GitHub repo permissions. Codekin hosted grants access to
  *machines*, so we must add an allowlist (Gitnook's `requireAuth` middleware is the seam).
- Simplifications vs Gitnook: we need identity only, so no GitHub App, no token storage, no
  AES encryption machinery, no token refresh. A plain OAuth App with `read:user user:email`
  scope; the access token is used once to fetch the profile and discarded.

### Deployment surface (this machine)

- DNS `app.codekin.ai` → 84.50.41.32 = this server. No nginx vhost or cert for it yet.
- nginx already serves: `codekin.ai` (static website), `claude.trec.one` (current
  Authelia-protected Codekin prod → port 32352), `gitnook.trec.one` (→ port 3005).
- pm2: `codekin` (id 1) is the current prod local server. `gitnook-api` (id 2).
- The existing claude.trec.one / Authelia deployment stays untouched and running throughout.

---

## 2. Decisions (proposed)

**D1 — Monorepo.** The relay server (control plane + relay hub) lives in this repo under
`server/relay/`, the connector under `server/connector/`, shared protocol types in
`src/relay-protocol.ts` (same pattern as `src/types.ts`). One repo keeps the envelope types, the
local API surface, and the connector in lockstep. The relay server is *not* part of the published
npm package initially; it runs from a repo clone like the current prod deployment. The connector
*is* shipped in the package (it's what `codekin relay …` runs).

**D2 — Hosted stack mirrors the local stack.** Express + `ws` + `better-sqlite3` (all already
dependencies), TypeScript run under `tsx` like the local server. New entry point
`server/relay/relay-server.ts`, default port **32360**, own systemd/pm2 process
(`codekin-relay`), own data dir `~/.codekin-relay/` (SQLite DB, config).

**D3 — Auth: GitHub OAuth, sessions, allowlist.**
- Plain GitHub **OAuth App** (not a GitHub App), scope `read:user user:email`, callback
  `https://app.codekin.ai/api/auth/github/callback`. Server-side callback that 302s back to `/`
  (simpler than Gitnook's frontend-callback XHR pattern; we're same-origin so nothing needs it).
- `express-session` + a `better-sqlite3` store (port of Gitnook's, including the
  `originalMaxAge` TTL fix), cookie `httpOnly` + `secure` + `sameSite: 'lax'`, rolling 30 days.
- Access control: `users.status ∈ {active, pending}`. A GitHub login on the allowlist (or org
  owner) becomes `active`; anyone else gets a row as `pending` and a "request access" screen.
  Owner promotes pending users from an admin page (or directly in the DB for MVP).
- Single hardcoded organization for MVP ("Multiplier Labs"); the `organizationId` column exists
  from day one so multi-org is a data change, not a schema change.

**D4 — One frontend codebase, build-time mode.** `VITE_APP_MODE=hosted` produces the hosted
build (hosted transport, login page, machine selector); the default build stays byte-identical
in behavior for local mode. The transport abstraction (spec §9.3) is
`src/lib/transport/{types,local,hosted}.ts`; `LocalHttpTransport` reproduces today's `/cc` +
bearer behavior exactly.

**D5 — Deployment topology for `app.codekin.ai`.**

```
browser ──https──▶ nginx (app.codekin.ai)
                     ├─ /            → /var/www/codekin-app (hosted frontend build)
                     ├─ /api/       → 127.0.0.1:32360 (control plane REST)
                     └─ /relay/     → 127.0.0.1:32360 (WS: /relay/browser, /relay/connector)
connector (any dev machine, incl. this one) ──wss──▶ app.codekin.ai/relay/connector
connector ──http──▶ 127.0.0.1:32352 (local Codekin, existing bearer token)
```

Certbot issues the `app.codekin.ai` cert. No Authelia on this vhost — auth is the control
plane's own GitHub OAuth. First paired machine: this server's own local Codekin (the
claude.trec.one instance), which dogfoods the whole path without a second machine.

**D6 — Connector inside the CLI.** `codekin relay login|connect|status|disconnect|logout`
dispatch from `bin/codekin.mjs:503` into `server/connector/`. Pairing via device-code-style
flow (spec §6.2): CLI prints a short code + URL, user approves in the hosted UI, control plane
issues a machine credential stored at `~/.config/codekin/relay.json` (mode 0600). The machine
credential is a random secret, stored hashed server-side.

---

## 3. PR Sequence

Each PR is independently shippable and keeps local mode green. Spec-phase mapping in brackets.

### PR 1 — Frontend transport abstraction [Phase 1]

Pure refactor, no behavior change.

- Add `src/lib/transport/` with the `CodekinTransport` interface (`request`, `openSocket`) and
  `LocalHttpTransport` implementing today's behavior (`/cc` base, bearer header, Authelia
  session probe).
- Consolidate the four `BASE` constants and four raw `fetch('/cc/...')` calls onto it.
  `wsUrl()` moves behind `openSocket()`.
- Isolate Authelia-specific logic (`redirectToLogin`, `checkAuthSession`, the 60s probe) into
  the local transport so the hosted transport can substitute its own expiry handling.
- Tests: existing suite passes; add transport-level unit tests pinning URL construction and
  auth-header behavior.

### PR 2 — Control plane skeleton + GitHub auth + hosted deploy [Phase 3 partial]

Goal: `https://app.codekin.ai` is live — GitHub sign-in works, shows an empty "Machines" page.

- `server/relay/relay-server.ts`: Express app, port 32360, SQLite at
  `~/.codekin-relay/control-plane.db`.
- Schema v1: `organizations`, `users`, `web_sessions`, `machines`, `machine_credentials`,
  `pairing_requests`, `session_shares`, `audit_events` (shares/audit empty until PR 6).
- Auth routes (Gitnook-derived): `GET /api/auth/github/start`, `GET /api/auth/github/callback`,
  `POST /api/auth/logout`, `GET /api/me`. Allowlist enforcement per D3.
- Hosted frontend shell: `VITE_APP_MODE=hosted` entry showing login page → machines list
  (empty state). `HostedRelayTransport` stub (cookie-based `request()` against `/api`).
- Deploy: nginx vhost + certbot + pm2 `codekin-relay` + `npm run build:hosted` →
  `/var/www/codekin-app` (runbook in §4).

### PR 3 — Connector + pairing [Phase 2]

- `codekin relay login`: device-code pairing against the control plane
  (`POST /api/machines/pair/start` from CLI → user approves at `app.codekin.ai/pair` →
  `pair/complete` issues the machine credential → `~/.config/codekin/relay.json`).
- `codekin relay connect`: outbound WSS to `/relay/connector`, envelope handshake
  (`hello`/`hello_ack` per spec §7.2), heartbeat, reconnect with exponential backoff + jitter.
- Capability advertisement: Codekin version, providers, repo list summary.
- Control plane: machine registry with online/offline status; hosted UI machines page shows
  real state.
- `codekin relay status|disconnect|logout`.

### PR 4 — REST proxy end-to-end [Phase 3 remainder]

- Relay hub: `request`/`response` envelope routing browser↔connector with per-message ACL
  check (owner-only at this stage), timeouts, max body size.
- Connector: allowlisted path prefix map onto `http://127.0.0.1:32352`, injecting the local
  bearer token. Read-only endpoints first (`/api/sessions/list`, `/api/repos`,
  `/api/claude/models`, health), then mutating ones.
- `HostedRelayTransport.request()` routes through `/relay/browser` WS (or short-lived POST
  bridge — decided in PR, WS preferred to reuse the channel).
- Hosted UI: select a machine → see its sessions and repos live.

### PR 5 — Session streaming [Phase 4]

- `stream_open`/`stream_data`/`stream_close` channels; connector opens the local Codekin WS,
  performs the local `auth` handshake, and pipes frames opaquely.
- `HostedRelayTransport.openSocket()` returns a WebSocket-shaped adapter over a relay channel so
  `useWsConnection`/`useChatSocket` work unchanged.
- Reconnect semantics: browser-side channel reopen rejoins the session (the local server already
  re-broadcasts pending prompts on `join`, `server/session-manager.ts:826`); note the
  leave-grace timer sizing now includes relay latency.
- Acceptance: full chat + approvals + diffs from the hosted UI against a paired machine.

### PR 6 — Sharing, ACLs, audit [Phase 5]

- Share CRUD (`/api/shares`), permission set per spec §6.3, hosted UI for sharing a session
  and for viewing sessions shared with you.
- Connector-side enforcement mirror: the connector re-checks the grant (pushed to it on change)
  before forwarding, so a compromised relay cannot exceed a grant (spec §5.2).
- Audit events per spec §9.5, metadata-only by default.

### PR 7 — Hardening [Phase 6]

- Backpressure: bounded queues, max message size, channel and rate limits per user/machine;
  overflow closes the channel.
- Reconnect recovery polish, connector version warnings, audit export, retention config.

Parallelism: PR 1 and PR 2 are independent (different layers) and can proceed simultaneously.
PR 3 depends on 2; PR 4 on 1+3; PR 5 on 4.

---

## 4. Deployment Runbook (app.codekin.ai)

One-time setup on this server (sudo steps run by the operator):

1. GitHub OAuth App (manual, github.com → Settings → Developer settings → OAuth Apps):
   - Homepage `https://app.codekin.ai`, callback `https://app.codekin.ai/api/auth/github/callback`.
2. `sudo tee /etc/nginx/sites-available/app.codekin.ai` — vhost per D5 (static root
   `/var/www/codekin-app`, `/api/` and `/relay/` proxied to 32360, `Upgrade` headers +
   `proxy_read_timeout 86400` on `/relay/`), then symlink into `sites-enabled`.
3. `sudo certbot --nginx -d app.codekin.ai`.
4. `sudo mkdir -p /var/www/codekin-app && sudo chown dev:dev /var/www/codekin-app`.
5. `~/.codekin-relay/env`: `RELAY_PORT=32360`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`,
   `SESSION_SECRET` (32+ random bytes), `PUBLIC_URL=https://app.codekin.ai`,
   `OWNER_GITHUB_ID=<owner's numeric GitHub id>`.
6. pm2: `codekin-relay` app in the ecosystem file → `pm2 start ecosystem.config.cjs --only codekin-relay && pm2 save`.

Per-deploy: `npm run build:hosted && rsync -a --delete dist-hosted/ /var/www/codekin-app/ && pm2 restart codekin-relay`.

The existing `codekin` pm2 app (local server, claude.trec.one) is not touched by any of this.

---

## 5. Control-Plane Schema v1

```sql
CREATE TABLE organizations (id TEXT PRIMARY KEY, name TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now')));

CREATE TABLE users (
  id TEXT PRIMARY KEY, organization_id TEXT NOT NULL REFERENCES organizations(id),
  github_id INTEGER UNIQUE NOT NULL, login TEXT NOT NULL, display_name TEXT,
  email TEXT, avatar_url TEXT,
  role TEXT NOT NULL DEFAULT 'member',      -- owner | admin | member | viewer
  status TEXT NOT NULL DEFAULT 'pending',   -- active | pending | disabled
  created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')));

CREATE TABLE web_sessions (sid TEXT PRIMARY KEY, sess TEXT NOT NULL, expire TEXT NOT NULL);

CREATE TABLE machines (
  id TEXT PRIMARY KEY, organization_id TEXT NOT NULL REFERENCES organizations(id),
  owner_user_id TEXT NOT NULL REFERENCES users(id),
  display_name TEXT NOT NULL, hostname TEXT, platform TEXT,
  connector_version TEXT, local_codekin_version TEXT,
  status TEXT NOT NULL DEFAULT 'offline',   -- online | offline | degraded
  last_seen_at TEXT, created_at TEXT DEFAULT (datetime('now')));

CREATE TABLE machine_credentials (
  id TEXT PRIMARY KEY, machine_id TEXT NOT NULL REFERENCES machines(id),
  secret_hash TEXT NOT NULL,                -- sha256, timing-safe compare
  created_at TEXT DEFAULT (datetime('now')), revoked_at TEXT);

CREATE TABLE pairing_requests (
  code TEXT PRIMARY KEY,                    -- short user-facing code
  requested_by_host TEXT, status TEXT NOT NULL DEFAULT 'pending',
  approved_by_user_id TEXT REFERENCES users(id),
  machine_id TEXT REFERENCES machines(id),
  created_at TEXT DEFAULT (datetime('now')), expires_at TEXT NOT NULL);

CREATE TABLE session_shares (               -- populated from PR 6
  id TEXT PRIMARY KEY, organization_id TEXT NOT NULL,
  machine_id TEXT NOT NULL REFERENCES machines(id), local_session_id TEXT NOT NULL,
  shared_by_user_id TEXT NOT NULL REFERENCES users(id),
  grantee_user_id TEXT REFERENCES users(id),
  permissions TEXT NOT NULL,                -- JSON array of SessionPermission
  created_at TEXT DEFAULT (datetime('now')), expires_at TEXT);

CREATE TABLE audit_events (                 -- populated from PR 6
  id INTEGER PRIMARY KEY AUTOINCREMENT, organization_id TEXT NOT NULL,
  kind TEXT NOT NULL, actor_user_id TEXT, machine_id TEXT, local_session_id TEXT,
  ip TEXT, user_agent TEXT, metadata TEXT,  -- JSON, no prompt text by default
  created_at TEXT DEFAULT (datetime('now')));
```

---

## 6. Open Questions (need product/owner input)

1. **GitHub OAuth App credentials** — needs manual creation under the owner's GitHub account
   (or the Multiplier-Labs org); callback URL as in §4. Blocks PR 2's deploy step only; all
   code can be built against placeholder env vars.
2. **Initial allowlist** — which GitHub logins are `active` from day one?
3. **Packaging** — confirm the relay server stays unpublished (repo-clone deploy) for MVP.
4. **First paired machine** — confirm this server's own local Codekin is the pairing guinea
   pig, with claude.trec.one/Authelia left running unchanged in parallel.
5. **Retention** — confirm metadata-only hosted retention (no transcripts, no file contents)
   as the launch default, per spec §12.
6. Spec §14 remainder (repo-scoped sharing, non-owner shell approvals, E2E encryption) —
   proposed answer for all three: defer past MVP; defaults per spec §10 table.
