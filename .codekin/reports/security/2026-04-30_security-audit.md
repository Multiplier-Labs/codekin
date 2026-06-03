# Security Audit: codekin

**Date**: 2026-04-30T03:37:00.907Z
**Repository**: /srv/repos/codekin
**Branch**: docs/audit-reports-2026-04-18
**Workflow Run**: 9c2db27a-0ce0-4ecf-9658-cc33107e5829
**Session**: f568106e-95f6-4b1b-b0d0-a925837ab505

---

Now I have enough data to compile the report.

---

# Security Audit Report — Codekin
**Date:** 2026-04-30
**Branch:** `docs/audit-reports-2026-04-18`
**Auditor:** Automated (Claude Sonnet 4.6)

---

## Summary

**Overall Risk Rating: Medium**

The codebase demonstrates mature security practices: timing-safe token comparison, session-scoped HMAC-derived child process tokens, webhook HMAC-SHA256 verification, consistent `realpathSync` path traversal protection, DOMPurify XSS sanitization, comprehensive rate limiting, and a defense-in-depth CSP header policy. No hardcoded secrets, committed credentials, or SQL injection risks were found.

| Severity | Count |
|----------|-------|
| Critical | 0 |
| High     | 1 |
| Medium   | 4 |
| Low      | 5 |

---

## Critical Findings

*None identified.*

---

## High Findings

### H1 — `permissionMode` Not Validated on Session Creation API

**File:** `server/session-routes.ts:192–196`

**Description:**
The `POST /api/sessions/create` REST handler extracts `permissionMode` from `req.body` and passes it directly to `sessions.create()` without checking it against `VALID_PERMISSION_MODES`. The constant `VALID_PERMISSION_MODES` (defined in `server/types.ts:23`) exists for this purpose but is never consulted in the route handler. By contrast, `provider` is validated with `!VALID_PROVIDERS.has(provider)` on line 194. Any authenticated client can therefore submit `permissionMode: 'dangerouslySkipPermissions'` and spawn a Claude session with all tool-approval prompts bypassed.

```typescript
// server/session-routes.ts:192-196
const { provider, model, permissionMode } = req.body
if (provider && !VALID_PROVIDERS.has(provider)) {  // provider IS validated
  return res.status(400).json({ ... })
}
const session = sessions.create(name, resolvedDir, { provider, model, permissionMode })  // permissionMode is NOT validated
```

**Impact:** Any holder of a valid master auth token can create sessions that run Claude with `--dangerously-skip-permissions`, allowing unrestricted shell command execution, arbitrary file modification, and destructive git operations — entirely bypassing the approval gate that protects the host system.

**Remediation:** Add a guard immediately after the `provider` check:
```typescript
if (permissionMode && !VALID_PERMISSION_MODES.has(permissionMode)) {
  return res.status(400).json({ error: `Invalid permissionMode: ${permissionMode}.` })
}
```
Also audit the `create_session` WebSocket message path in `ws-message-handler.ts` for the same gap.

---

## Medium Findings

### M1 — Commit-Event `repoPath` Not Validated Against `REPOS_ROOT`

**File:** `server/workflow-routes.ts:255–270`

**Description:**
The `POST /api/workflows/commit-event` endpoint accepts a `repoPath` field from the request body and passes it directly to `handler.handle()` without calling `resolveRepoPathInRoot()`. Every other endpoint that accepts a repo path (session creation, orchestrator child spawn, docs browsing, workflow config) applies a `realpathSync` + boundary check. The commit-event route is the only exception.

```typescript
const { repoPath, branch, commitHash, commitMessage, author } = req.body
if (!repoPath || !branch || !commitHash || !commitMessage) {
  return res.status(400).json({ error: 'Missing required fields ...' })
}
const result = await handler.handle({ repoPath, branch, commitHash, commitMessage, author })
// No resolveRepoPathInRoot() call before passing to handler
```

**Impact:** A client with a valid master auth token could supply an out-of-root `repoPath`, potentially triggering a commit-review workflow run against an unintended directory (e.g., a system directory or a path outside `REPOS_ROOT`). Immediate exploitation risk is limited because the handler checks workflow config for a matching repo before dispatching.

**Remediation:** Add `resolveRepoPathInRoot(repoPath)` validation before calling `handler.handle()`, matching the pattern used in all other route handlers.

---

### M2 — Unvalidated User-Controlled Commit Fields Flow Into Claude Prompts (Prompt Injection)

**File:** `server/workflow-routes.ts:255–270`, `server/commit-event-handler.ts`

**Description:**
The `commitMessage`, `commitHash`, `branch`, and `author` fields accepted by `/api/workflows/commit-event` are passed verbatim into the workflow engine, which ultimately includes them in the system prompt sent to a Claude session. There is no sanitization or escaping of these fields before prompt construction. Because the git post-commit hook writes these values to the endpoint, a malicious commit message containing prompt-injection payloads (e.g., `"Ignore previous instructions and...`) would be forwarded to Claude with full tool access.

**Impact:** An attacker who can create a git commit in a monitored repository can craft a commit message to inject instructions into the Claude session's context, potentially causing it to exfiltrate data, modify files, or perform other privileged actions within the session's tool permissions.

**Remediation:** Truncate commit messages to a reasonable maximum length (e.g., 500 characters), strip any control characters, and consider wrapping the values in XML-style delimiters in the prompt template to reduce injection surface.

---

### M3 — `TRUST_PROXY` Misconfiguration Enables Rate-Limit Bypass via IP Spoofing

**File:** `server/ws-server.ts:201–202`, `server/config.ts:83`

**Description:**
When `TRUST_PROXY=true`, the server calls `app.set('trust proxy', true)` and derives the client IP for rate-limiting from the `X-Forwarded-For` header via `req.ip`. If the server is deployed without a reverse proxy that strips untrusted `X-Forwarded-For` headers (or if `TRUST_PROXY` is mistakenly enabled), any client can forge this header to impersonate arbitrary IP addresses and bypass per-IP rate limits on all API routes, authentication endpoints, and webhook endpoints.

**Impact:** Complete bypass of all IP-based rate limiting, enabling brute-force attacks against the auth endpoint (normally limited to 10 requests/minute) and denial-of-service amplification against downstream services.

**Remediation:** Document that `TRUST_PROXY` must only be set when a trusted reverse proxy (nginx/Caddy) strips upstream `X-Forwarded-For` before the request reaches Node.js. Consider implementing an explicit trusted IP range rather than relying on the boolean flag.

---

### M4 — OpenCode Sidecar Server Listens on Predictable Local Port Range

**File:** `server/opencode-process.ts:107–108`

**Description:**
When the OpenCode provider is used, a local HTTP server is started on `localhost` using a port selected as `14096 + Math.floor(Math.random() * 1000)` — a range of only 1,000 ports. While the server requires HTTP Basic Auth (`opencode:<randomUUID>` encoded as Base64), a local process could enumerate the 1,000-port range and identify the sidecar. On a shared host or container with multiple users, this narrows the attack surface for credential-free probing.

**Impact:** On shared infrastructure, a co-tenant process could rapidly scan ports 14096–15096 on loopback to identify the OpenCode sidecar. If the Basic Auth mechanism has any weakness, or if a future code change removes it, this becomes exploitable. Currently rated medium due to the randomUUID credential.

**Remediation:** Use an OS-assigned ephemeral port (`port: 0`) and retrieve the actual port from the server's `listening` event rather than pre-selecting from a fixed range.

---

## Low Findings

### L1 — HSTS Applied Only in Production; No `preload` Directive

**File:** `server/ws-server.ts:315–317`

**Description:** `Strict-Transport-Security` is set only when `NODE_ENV === 'production'`. Staging and review environments lack the header, leaving those instances vulnerable to SSL-stripping attacks. The production header also omits the `preload` directive, meaning browsers must visit once over HTTP before HSTS is activated.

**Remediation:** Add `; preload` to the HSTS value and consider applying the header in all non-development environments, not only `production`.

---

### L2 — CSP `style-src 'unsafe-inline'` Weakens Injection Protection

**File:** `server/ws-server.ts:314`

**Description:** The `Content-Security-Policy` header permits `style-src 'self' 'unsafe-inline' https://fonts.googleapis.com`. The `'unsafe-inline'` directive for styles allows injected `<style>` tags and `style=` attributes to execute, which can be used for data exfiltration via CSS injection (e.g., attribute selectors sending network requests to attacker-controlled origins) or UI-redressing attacks.

**Remediation:** Move to CSS hashes or nonces to eliminate `'unsafe-inline'`. TailwindCSS 4's build output is fully static and can be served as an external stylesheet, removing the need for inline styles entirely.

---

### L3 — Master Auth Token Persisted to Disk in Hook Config

**File:** `server/commit-event-hooks.ts:47–52`

**Description:** `ensureHookConfig()` writes the full master auth token to `~/.codekin/hook-config.json` with mode `0600` so that the git post-commit shell script can authenticate to the server. While the file permission is correct, the master token on disk increases the persistence risk: backup utilities, core dumps, disk forensics, or a `sudo` escalation could expose the credential. A session-scoped derived token (as used for child Claude processes) would limit blast radius.

**Remediation:** Replace the master token in `hook-config.json` with a dedicated, narrowly-scoped HMAC-derived token tied to the commit-event endpoint only, similar to how child process session tokens are derived in `session-lifecycle.ts`.

---

### L4 — WebSocket Origin Validation Relaxed in Non-Production Mode

**File:** `server/ws-origin-check.ts:14–19`

**Description:** In development mode (`NODE_ENV !== 'production'`), WebSocket connections with a missing `Origin` header are accepted. While intentional for CLI tools, this means a local page from any origin could establish a WebSocket connection if the development server is reachable, as browsers will include `Origin` but tools won't. If a developer accidentally exposes port 32352 on an interface other than loopback, cross-site WebSocket hijacking becomes possible without the `Origin` header check.

**Remediation:** Document the assumption that the development server binds to `127.0.0.1` only. Add an explicit bind-address check or warn at startup when `NODE_ENV` is not `production` and the server is bound to a non-loopback interface.

---

### L5 — `set_permission_mode` WebSocket Message Accepts Any String Value

**File:** `server/types.ts:323`, `server/ws-message-handler.ts` (inferred)

**Description:** The `set_permission_mode` WebSocket client message type accepts a `permissionMode: PermissionMode` field. TypeScript enforcement applies at compile time but not at runtime JSON deserialization. If the WebSocket message handler does not validate the incoming `permissionMode` string against `VALID_PERMISSION_MODES` at runtime (same gap as H1 above), an authenticated WebSocket client can switch an active session to `dangerouslySkipPermissions` mid-conversation.

**Remediation:** Apply `VALID_PERMISSION_MODES.has(permissionMode)` validation in the WebSocket message handler for `set_permission_mode` messages, consistent with the fix recommended in H1.

---

## Secrets & Credentials Exposure

No hardcoded secrets, API keys, private keys, or credentials were found in any tracked source file. Specifically:

- `.env` files are excluded by `.gitignore` and none are present in the repository
- `AUTH_TOKEN`, `ANTHROPIC_API_KEY`, `CLAUDE_CODE_API_KEY`, `GITHUB_WEBHOOK_SECRET`, and `STEPFLOW_WEBHOOK_SECRET` are loaded exclusively from environment variables at runtime
- `ecosystem.config.cjs` (which may contain deployment paths) is gitignored
- The `opencode` sidecar password is generated with `randomUUID()` at startup and never persisted
- `crypto-utils.ts` implements `redactSecrets()` to strip sensitive patterns from log output before writing to console

The `~/.codekin/hook-config.json` file (outside the repo) holds the master auth token at mode `0600`. This is a local file and not a repository exposure, but see L3 above.

---

## Recommendations

1. **(H1 — Immediate)** Validate `permissionMode` against `VALID_PERMISSION_MODES` in `POST /api/sessions/create` and in the `set_permission_mode` WebSocket handler. The set already exists; the guard is a single `has()` check away.

2. **(M1 — Short-term)** Apply `resolveRepoPathInRoot(repoPath)` to the `repoPath` field in `POST /api/workflows/commit-event` before passing it to the commit event handler, matching the boundary-check pattern used throughout the rest of the codebase.

3. **(M2 — Short-term)** Sanitize commit-event fields (`commitMessage`, `branch`, `author`) before including them in Claude prompts: cap length, strip control characters, and wrap in distinguishing delimiters so that injected instructions cannot escape the "data" context.

4. **(L3 / M — Medium-term)** Replace the master auth token in `hook-config.json` with a purpose-scoped derived credential (analogous to session tokens) that is valid only for the commit-event endpoint. This minimises the impact of credential file exposure.

5. **(M3 — Operational)** Add startup validation that warns or exits if `TRUST_PROXY=true` but the server is not reachable through a known reverse-proxy address. Document clearly in deployment guides that this flag must only be set when a hardening proxy strips upstream `X-Forwarded-For`.

6. **(M4 — Medium-term)** Switch the OpenCode sidecar to an OS-assigned port (`port: 0`) and communicate the actual port through the process API rather than a fixed random range.

7. **(L2 — Medium-term)** Eliminate `style-src 'unsafe-inline'` from the CSP by serving TailwindCSS as an external stylesheet and using nonces for any remaining inline styles injected by the framework.

8. **(L1 — Short-term)** Add `; preload` to the HSTS header and extend the header to staging/preview environments (e.g., apply when `NODE_ENV !== 'development'`).

9. **(L4 — Operational)** Add a startup warning when the WebSocket server binds to a non-loopback interface in non-production mode, explicitly calling out that Origin validation is relaxed.

10. **(General — Ongoing)** The `VALID_PERMISSION_MODES` constant in `types.ts` suggests intent to validate; add a linting rule or integration test that asserts this set is actually consulted in all route/message handlers that accept a `permissionMode` field, to prevent future regressions.Committed and pushed. The 3 new reports and the test file cleanup are now on `docs/audit-reports-2026-04-18`.