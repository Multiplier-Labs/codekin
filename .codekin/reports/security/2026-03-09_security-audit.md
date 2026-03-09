# Security Audit: codekin

**Date**: 2026-03-09T09:15:00.658Z
**Repository**: /home/dev/repos/codekin
**Branch**: fix/workflow-model-display
**Workflow Run**: 42a8460c-5d2b-470b-bcda-5ec0e74f3c5a
**Session**: 2530e33f-9179-4415-a523-7cd16dc7662c

---

Now I have all the data needed. Here is the complete security audit report:

---

## Summary

**Overall Risk Rating: Medium**

| Severity | Count |
|----------|-------|
| Critical | 0 |
| High     | 3 |
| Medium   | 6 |
| Low      | 4 |
| Info     | 3 |

The codebase demonstrates good baseline security practices: timing-safe token comparison, HMAC-SHA256 webhook verification, array-based process spawning (no shell injection), and a fail-closed authentication model. No hardcoded secrets or known dependency vulnerabilities were found. The principal risks are a potential SSRF path in the Stepflow callback handler, the auth token being present in WebSocket URL query strings (server log exposure), and inadequate access controls when `allowedCallbackHosts` is unconfigured.

---

## Critical Findings

None identified.

---

## High Findings

### H1 — SSRF: Stepflow Callback URL Validation Bypassable When `allowedCallbackHosts` Is Empty

**File:** `server/stepflow-handler.ts:407–427`

**Description:**
When a Stepflow webhook event includes a `callbackUrl`, the server POSTs results to that URL. The allowlist check is:

```typescript
if (this.config.allowedCallbackHosts.length > 0 &&
    !this.config.allowedCallbackHosts.includes(parsedUrl.hostname)) {
```

When `STEPFLOW_CALLBACK_HOSTS` is unset (the default), `allowedCallbackHosts` is an empty array and the guard short-circuits to `false` — **every host is permitted**. An attacker who can submit a crafted Stepflow event (or replay one) can route the callback to an internal network address, leaking session output and potentially triggering SSRF against internal services.

**Impact:** Internal service enumeration; data exfiltration via callback body; potential pivot to internal infrastructure.

**Remediation:** Invert the guard logic to deny-by-default: if `allowedCallbackHosts` is empty, block all external callbacks and log a startup warning requiring explicit configuration.

```typescript
// Secure variant
if (this.config.allowedCallbackHosts.length === 0 ||
    !this.config.allowedCallbackHosts.includes(parsedUrl.hostname)) {
  throw new Error(`Callback host '${parsedUrl.hostname}' is not in the allowlist`);
}
```

---

### H2 — Auth Token Exposed in WebSocket URL Query String

**File:** `server/ws-server.ts:287` (token extracted from `req.url` query string)

**Description:**
The WebSocket client authenticates by appending the bearer token to the connection URL (`?token=<value>`). URLs — including query strings — are routinely captured in:
- Nginx/reverse-proxy access logs
- Browser history
- `Referrer` headers sent to third-party resources
- System logs on the host

An attacker with read access to any of these sources can recover the token and gain full server control.

**Impact:** Full authentication bypass; access to all sessions, repos, and shell operations.

**Remediation:** Move token delivery out of the URL. Use the WebSocket `protocols` field for initial token handshake, or send a signed `auth` message immediately after connection establishment, then close unauthenticated connections after a short timeout. Remove query-string token extraction.

---

### H3 — Auth Token Forwarded to Claude Child Processes

**File:** `server/claude-process.ts:68`, `server/session-manager.ts:69`

**Description:**
The server auth token is passed into the environment of spawned Claude CLI subprocesses (noted in type comments: *"Additional env vars passed to the child process (session ID, port, token)"*). Any skill, tool, or hook executing inside Claude's context inherits this token and can use it to make authenticated API calls back to the Codekin server — escalating from a restricted Claude session to full server access.

**Impact:** Privilege escalation from a Claude tool/hook to full server control; potential for a malicious skill to exfiltrate all session data.

**Remediation:** Issue session-scoped tokens with limited permissions (e.g., approve/deny only for their own session) and pass those to child processes instead of the master auth token. Alternatively, expose a minimal local IPC socket inside the subprocess instead of reusing the main auth token.

---

## Medium Findings

### M1 — CORS Default Origin Permits Dev Server in Production

**File:** `server/ws-server.ts:227–234`

**Description:**
`Access-Control-Allow-Origin` defaults to `http://localhost:5173` when `CORS_ORIGIN` is not set. If the server is deployed without this variable, cross-origin requests from `localhost:5173` (or a page that can redirect through it) are accepted. More practically, the wildcard case is never used, but an absent `CORS_ORIGIN` silently allows the Vite dev origin.

**Impact:** Unintended cross-origin access from local development tooling if `CORS_ORIGIN` is not explicitly set in production.

**Remediation:** At startup, enforce that `CORS_ORIGIN` is explicitly configured in non-development environments. Log a startup error and refuse to bind if the variable is missing in production mode.

---

### M2 — Auth Token Appears in WebSocket URL Visible to All Joined Clients

**File:** `server/ws-server.ts:302–344`

**Description:**
When a new client joins a session, the server replays the last 500 messages from `outputHistory`. If any prior command output or log entry contained the connection URL (with token), it will be replayed to subsequent clients. There is no scrubbing of sensitive strings in history replay.

**Impact:** Token leakage to any user who joins a session after someone whose token appeared in output.

**Remediation:** Add token redaction to history replay, or switch to the non-URL token delivery mechanism recommended in H2.

---

### M3 — No Rate Limiting on WebSocket Connections

**File:** `server/ws-server.ts:284–290`

**Description:**
HTTP REST endpoints with webhook functionality have rate limiters, but the WebSocket upgrade endpoint has no connection rate limiting. An attacker can open thousands of unauthenticated WebSocket connections before token verification completes, exhausting file descriptors or memory.

**Impact:** Denial of service against the WebSocket server.

**Remediation:** Apply a rate limiter (e.g., `express-rate-limit` or `ws`-level connection counting per IP) to the HTTP upgrade path before the WebSocket handshake is completed.

---

### M4 — Session History Stored Without Encryption at Rest

**File:** `server/session-manager.ts` (sessions persisted to `~/.codekin/sessions.json`)

**Description:**
Session metadata (names, working directories, model choices) is written to disk in plaintext. If the host is compromised or the file is world-readable (default umask does not guarantee 0600), an attacker can enumerate all managed repositories and sessions.

**Impact:** Information disclosure of repository paths and session metadata.

**Remediation:** Explicitly set file permissions to 0600 on write, or at minimum add a startup check that warns if the file is group/world readable.

---

### M5 — Bash Command Logging May Expose Secrets

**File:** `server/approval-manager.ts`, `server/session-manager.ts`

**Description:**
Bash commands submitted to Claude are logged verbatim as part of approval and audit flows. Commands that include credentials (e.g., `curl -H 'Authorization: Bearer sk-...'`, `git clone https://user:password@host`) will appear in server logs in plaintext.

**Impact:** Credential exposure in log files, which may be forwarded to log aggregators or accessible to multiple users.

**Remediation:** Apply regex-based secret redaction to logged command strings before writing them to any log sink. At minimum, redact patterns matching `Authorization:`, `Bearer `, `password`, and common API key patterns.

---

### M6 — `execSync('claude --version')` in Server Startup

**File:** `server/ws-server.ts:101`

```typescript
claudeVersion = execSync('claude --version', { timeout: 5000 }).toString().trim()
```

**Description:**
This is the only use of `execSync` in the codebase. While the command itself is safe (no user input), `execSync` uses a shell by default on some platforms and blocks the event loop. If `claude` is not found, the server startup flow may throw synchronously. More importantly, if `PATH` is manipulated in the deployment environment, a different binary named `claude` could be executed.

**Impact:** Low — potential for PATH hijacking in misconfigured deployment; minor event-loop blocking at startup.

**Remediation:** Replace with `execFileSync('claude', ['--version'], { timeout: 5000 })` to avoid shell invocation. Alternatively, use `spawnSync` with an absolute path.

---

## Low Findings

### L1 — Missing HTTP Security Headers

**File:** `server/ws-server.ts` (global middleware)

**Description:**
No security headers are set on HTTP responses: no `Content-Security-Policy`, `Strict-Transport-Security`, `X-Frame-Options`, `X-Content-Type-Options`, or `Permissions-Policy`. The app relies on being deployed behind nginx, but headers should also be set at the application layer as defense-in-depth.

**Remediation:** Add `helmet` middleware (`npm install helmet`) or set headers manually in the Express middleware chain.

---

### L2 — No Audit Log for Approval Decisions

**File:** `server/approval-manager.ts`

**Description:**
When a user approves or denies a Claude tool/bash action, the decision is sent to the process but not persisted to any audit log. There is no record of who approved which command in which session at what time.

**Impact:** No forensic trail for post-incident analysis; inability to detect approval abuse.

**Remediation:** Write structured approval/denial events to an append-only log file or database table, including timestamp, session ID, command, and decision.

---

### L3 — Webhook Workspace Cleanup Not Validated on Failure

**File:** `server/webhook-workspace.ts`

**Description:**
Workspaces are cleaned up with `rmSync(workspacePath, { recursive: true, force: true })`. If cleanup is skipped due to an early error return, the workspace (containing a full git clone of a private repository) persists on disk indefinitely.

**Impact:** Gradual disk exhaustion; potential exposure of source code from private repositories.

**Remediation:** Wrap cleanup in a `finally` block so it always executes, and log a warning if it fails.

---

### L4 — Repository/Owner Identifier Validation in Clone Endpoint

**File:** `server/upload-routes.ts`

**Description:**
The clone endpoint validates `owner` and `name` with `/^[\w.-]+$/`. While this prevents obvious path traversal, the regex permits names like `...` or `.git` which could be meaningful to git in certain contexts. The validation relies entirely on `gh repo clone` doing the right thing downstream.

**Impact:** Low — `gh` CLI handles these cases, but defense-in-depth suggests tighter validation.

**Remediation:** Add an explicit blocklist for names that begin with `.` or consist entirely of dots, and enforce a minimum length.

---

## Secrets & Credentials Exposure

**No hardcoded secrets were found in any committed source file.**

The `git grep` scan across all TypeScript, JavaScript, JSON, YAML, and environment files produced only benign matches:

| File | Match Type | Notes |
|------|-----------|-------|
| `server/auth-routes.ts`, `session-routes.ts`, `upload-routes.ts` | `token` (variable name) | Auth token verification logic — no literal values |
| `server/config.ts` | `AUTH_TOKEN`, `AUTH_TOKEN_FILE` | Environment variable names only |
| `server/crypto-utils.ts` | `secret` (parameter name) | HMAC function signature — no literal value |
| `server/stepflow-handler.ts` | `STEPFLOW_WEBHOOK_SECRET` | Environment variable reference only |
| `.codekin/settings.example.json:8` | `authFile` | Path to token file — example template, no actual token |
| `package-lock.json` | `tokens` | CSS tokenizer package names — irrelevant |

All secrets (API keys, auth tokens, webhook secrets) are loaded exclusively from environment variables or gitignored local files (`~/.codekin/auth-token`, `.codekin/settings.json`). Both `.env*` and `.codekin/settings.json` are correctly listed in `.gitignore`.

`npm audit` reports **0 vulnerabilities** across all dependencies.

---

## Recommendations

1. **[High] Fix the SSRF in Stepflow callback handling (H1).** Invert the `allowedCallbackHosts` guard to deny-by-default. This is a one-line fix with high security impact. Require explicit host configuration before enabling Stepflow webhooks.

2. **[High] Move auth token off the WebSocket URL (H2).** Implement a post-connect `auth` message handshake or use the `protocols` field. This also resolves H3 indirectly if session-scoped tokens are issued per-connection.

3. **[High] Stop forwarding the master auth token to Claude child processes (H3).** Issue a least-privilege session token (approve/deny only) for the subprocess environment. This limits the blast radius of any malicious skill or hook.

4. **[Medium] Add HTTP security headers (L1 combined with M concern).** Install `helmet` or manually set `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Content-Security-Policy`, and `Strict-Transport-Security`. This is a single middleware addition.

5. **[Medium] Rate-limit WebSocket connections (M3).** Apply a per-IP connection rate limit to the `/` upgrade endpoint before the handshake completes. Consider a maximum simultaneous connection count per IP.

6. **[Medium] Require explicit `CORS_ORIGIN` in production (M1).** Add a startup check that exits with an error if `NODE_ENV=production` and `CORS_ORIGIN` is not set or is a `localhost` URL.

7. **[Medium] Implement secret redaction in command logging (M5).** Apply regex scrubbing to logged bash command strings to prevent credential leakage into log files. At minimum, redact `Bearer `, `Authorization:`, and URL-embedded passwords.

8. **[Medium] Enforce 0600 permissions on all persisted state files (M4).** Use `fs.chmodSync(path, 0o600)` immediately after writing `sessions.json`, `repo-approvals.json`, and any session-scoped files.

9. **[Low] Add a structured audit log for approval decisions (L2).** Persist a JSON record for every tool-use approval or denial, including session ID, working directory, command, decision, and UTC timestamp. This is essential for post-incident forensics.

10. **[Low] Wrap webhook workspace cleanup in `finally` blocks (L3).** Ensure workspace directories are always deleted on session completion or error, and log a warning (with the workspace path) if deletion fails, so operators can manually clean up.