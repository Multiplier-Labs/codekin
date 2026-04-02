# Security Audit: codekin

**Date**: 2026-04-02  
**Repository**: /srv/repos/codekin  
**Branch**: chore/reports-2026-04-01  
**Auditor**: Automated (Claude Sonnet 4.6)

---

## Summary

**Overall Risk Rating: Low–Medium — 0 Critical, 0 High, 3 Medium, 5 Low**

The codebase maintains strong security fundamentals established in prior audits. No new critical or high-severity vulnerabilities were found. Three medium issues from the March 26 audit remain unaddressed; two additional low-severity issues were identified in this pass. No hardcoded secrets or committed credentials were found.

| Severity | Count | Status vs March 26 |
|----------|-------|--------------------|
| Critical | 0 | No change |
| High     | 0 | No change |
| Medium   | 3 | All carried forward — none fixed |
| Low      | 5 | 4 carried forward + 1 new |

**Strengths confirmed:**
- Timing-safe HMAC token verification (`crypto.timingSafeEqual`) throughout
- HMAC-SHA256 session-token derivation scoped per session (master token not exposed to child processes)
- Array-argument `execFileSync`/`spawn` everywhere — no shell injection surface
- Parameterized SQLite queries — no SQL injection surface
- DOMPurify sanitization of all markdown-rendered HTML
- Comprehensive HTTP security headers (CSP, HSTS in production, X-Frame-Options, etc.)
- SSRF allowlist enforcement in Stepflow callback handler with private-IP blocking
- Per-IP and per-client WebSocket rate limiting
- Webhook deduplication with delivery-ID tracking (1-hour TTL)
- `realpathSync` symlink-safe path validation on the directory browser endpoint

---

## Critical Findings

None.

---

## High Findings

None.

---

## Medium Findings

### M1 — Unauthenticated Server Start is Warn-Only (Not Fatal)

**File**: `server/ws-server.ts:71`  
**Carried forward from**: 2026-03-26 audit

**Description**: When `AUTH_TOKEN` / `AUTH_TOKEN_FILE` is not configured, the server prints a warning and continues:

```typescript
console.warn('⚠️  WARNING: No auth token configured. All endpoints are unauthenticated!')
```

`verifyToken()` at line 76 returns `false` when no token is configured, which means every call to `if (!verifyToken(token)) return res.status(401)` will reject requests. However, the server starts and listens normally with **all routes effectively public** — an operator who misses the warning may unknowingly expose a fully unauthenticated service.

**Impact**: In a misconfigured deployment, all API endpoints (session creation, file browsing, repo listing, workflow execution) become accessible without credentials. An attacker on the same network can create or hijack Claude sessions, exfiltrate repository contents, and trigger arbitrary workflow runs.

**Remediation**: Treat a missing auth token as a fatal startup error in production (`NODE_ENV === 'production'`), following the same pattern already used for `CORS_ORIGIN`:

```typescript
if (process.env.NODE_ENV === 'production' && !authToken) {
  console.error('FATAL: AUTH_TOKEN or AUTH_TOKEN_FILE must be set in production.')
  process.exit(1)
}
```

---

### M2 — Stepflow Enabled Without Secret Silently Rejects All Webhooks

**File**: `server/ws-server.ts:167–169`, `server/stepflow-handler.ts:466`  
**Carried forward from**: 2026-03-26 audit

**Description**: When `STEPFLOW_WEBHOOK_ENABLED=true` but `STEPFLOW_WEBHOOK_SECRET` is unset, the server warns and continues. `verifySignature()` returns `false` when `this.config.secret` is falsy (line 466), so all incoming Stepflow webhook requests are rejected with HTTP 401. This is fail-secure, but the combination of "enabled" and "silently broken" creates a misleading operational state — the integration appears running but processes nothing.

**Impact**: Operators may believe Stepflow is active when it silently rejects all events, leading to undetected pipeline failures. An operator attempting to debug may be tempted to disable signature verification, creating a true vulnerability.

**Remediation**: Exit at startup when Stepflow is enabled without a secret, matching the existing pattern for GitHub webhooks at `server/ws-server.ts:146–158`:

```typescript
if (stepflowConfig.enabled && !stepflowConfig.secret) {
  console.error('FATAL: STEPFLOW_WEBHOOK_SECRET must be set when Stepflow is enabled.')
  process.exit(1)
}
```

---

### M3 — Tool Input/Output Debug Logs Not Gated by NODE_ENV

**File**: `server/claude-process.ts:254, 275, 332, 334, 368, 379, 444, 452` (12 call sites)  
**Carried forward from**: 2026-03-26 audit

**Description**: Tool invocation details — including tool names, input parameters (truncated at 200 chars), and result content (truncated at 300 chars) — are written unconditionally to stdout via `console.log('[tool-debug]')`, `console.log('[task-debug]')`, and `console.log('[tool-result]')`. These logs contain user data from Claude tool calls (file paths, code snippets, command results) and are emitted regardless of `NODE_ENV`.

Example from line 332:
```typescript
if (isTask) console.log('[task-debug] tool:', this.tool.name, 'input:', JSON.stringify(parsed).slice(0, 200))
```

**Impact**: In production deployments aggregating logs (e.g. to a SIEM or log service), user repository contents, file paths, and shell command outputs may be persistently stored and accessible to anyone with log access. This is a data-exposure and privacy risk, not an execution vulnerability.

**Remediation**: Gate all `[tool-debug]`, `[task-debug]`, and `[tool-result]` log lines behind an environment check:

```typescript
const DEBUG_TOOLS = process.env.NODE_ENV !== 'production' || process.env.CODEKIN_DEBUG_TOOLS === '1'
// then: if (DEBUG_TOOLS) console.log('[tool-debug] ...')
```

---

## Low Findings

### L1 — Session `workingDir` Not Validated Against Allowed Roots at Creation

**File**: `server/session-routes.ts:51–73`  
**Carried forward from**: 2026-03-26 audit

**Description**: `POST /api/sessions/create` accepts `workingDir` from the request body and passes it directly to `sessions.create()` without validating that it is within an allowed root (home directory or `REPOS_ROOT`). By contrast, the `GET /api/sessions/browse` endpoint at the same file does enforce `allowedRoots` via `realpathSync` (line 256–263).

```typescript
const { name, workingDir } = req.body
if (!name || !workingDir) return res.status(400).json({ error: 'Missing name or workingDir' })
const session = sessions.create(name, workingDir)  // no path validation
```

**Impact**: An authenticated user can create a session with `workingDir` pointing to any filesystem path (e.g. `/etc`, `/root`, `/var`). Claude is then spawned with that CWD, giving it unrestricted filesystem read access and the ability to run tools outside the designated repo area. The impact is bounded by requiring a valid auth token.

**Remediation**: Apply the same `allowedRoots` / `realpathSync` validation used in the browse endpoint before calling `sessions.create()`.

---

### L2 — Auth Token Accepted via Request Body (Log Exposure Risk)

**File**: `server/ws-server.ts:105`  
**Carried forward from**: 2026-03-26 audit

**Description**: `extractToken()` accepts the master auth token from `req.body.token` as a fallback to the `Authorization: Bearer` header. This exists for compatibility with the `auth-verify` endpoint and "legacy callers". Request bodies may be captured in access logs, reverse-proxy debug logs, or error reporting middleware, potentially exposing the token.

**Impact**: Low. Token exposure requires an attacker to access application or proxy logs. There is no query-parameter token acceptance (which would be worse), and the code comment acknowledges this is a legacy path.

**Remediation**: Audit callers of the body-token path; migrate them to `Authorization: Bearer`. Once the only remaining caller (`auth-verify`) is migrated, remove the `req.body?.token` fallback.

---

### L3 — CSP Allows `style-src 'unsafe-inline'`

**File**: `server/ws-server.ts:248` (Content-Security-Policy header)  
**Carried forward from**: 2026-03-26 audit

**Description**: The Content-Security-Policy header includes `style-src 'self' 'unsafe-inline' https://fonts.googleapis.com`. The `'unsafe-inline'` directive allows injected `<style>` tags and `style=` attributes, which can facilitate CSS-based data exfiltration attacks (e.g. CSS injection to leak form values via attribute selectors).

**Impact**: Low in this application context. TailwindCSS 4 emits inline styles at build time, making this difficult to eliminate entirely without significant build-system changes.

**Remediation**: Investigate whether TailwindCSS 4 supports a nonce-based or hash-based CSP for its inline style output. If so, migrate to `style-src 'self' 'nonce-{nonce}'`. As an interim measure, document this as a known accepted risk.

---

### L4 — Git Hook Config Stores Master Auth Token

**File**: `server/commit-event-hooks.ts:49–55`  
**Carried forward from**: 2026-03-26 audit

**Description**: `ensureHookConfig()` writes the master `AUTH_TOKEN` to `~/.codekin/hook-config.json` so that post-commit hooks can authenticate to the server. The file is created with `mode: 0o600` (owner read/write only), limiting direct access. However, the master token is used rather than a hook-scoped derived token, so theft of this file grants full API access.

```typescript
const config: HookConfig = { serverUrl, authToken }  // authToken is the master token
writeFileSync(HOOK_CONFIG_PATH, JSON.stringify(config, null, 2), { encoding: 'utf-8', mode: 0o600 })
```

**Impact**: Low. Requires local filesystem access (`~/.codekin/` is the attacker's goal), which implies already compromised user-level access. Severity would increase if the hook is installed in shared CI environments.

**Remediation**: Derive a hook-scoped token using the existing `deriveSessionToken(masterToken, 'hook')` pattern from `crypto-utils.ts`, scoped to `commit-hook` usage. The server's `verifyTokenOrSessionToken` already supports scoped tokens.

---

### L5 — File Upload MIME Type Check Bypassable via Client-Controlled Header

**File**: `server/upload-routes.ts:169–178` (new finding)

**Description**: The upload endpoint's `fileFilter` validates against `ALLOWED_MIME_TYPES` using `file.mimetype`, which is sourced from the HTTP `Content-Type` header submitted by the client — not from file magic bytes. The validation also accepts files matching either MIME type OR extension (`||` logic):

```typescript
const allowed = ALLOWED_MIME_TYPES.includes(file.mimetype) || ALLOWED_EXTENSIONS.includes(ext)
```

A client can name a file `malicious.md` to bypass MIME checking entirely (`.md` extension is in the allowed list). Similarly, setting `Content-Type: image/png` on any file payload passes the MIME check.

**Impact**: Low. Uploaded files are stored in the isolated `SCREENSHOTS_DIR` and are not executed by the server. The primary risk is storing unexpected file types (e.g. HTML, SVG with scripts) in the upload directory. Actual code execution requires a separate serving vulnerability.

**Remediation**: Validate file type using magic-byte inspection (e.g. the `file-type` npm package) rather than trusting client-provided headers. Apply `&&` (both MIME and extension must match) rather than `||` to reduce the bypass surface.

---

## Secrets & Credentials Exposure

**No hardcoded secrets or committed credentials were found.**

`git grep` across all `.ts`, `.js`, `.json`, `.yaml`, `.env` source files found no embedded API keys, passwords, tokens, or private keys. All credential references in the codebase are indirect:

| Pattern | Location | Status |
|---------|----------|--------|
| `AUTH_TOKEN` | `server/ws-server.ts`, `server/config.ts` | Read from env var only |
| `GITHUB_WEBHOOK_SECRET` | `server/webhook-handler.ts` | Read from env var only |
| `STEPFLOW_WEBHOOK_SECRET` | `server/stepflow-handler.ts` | Read from env var only |
| `ANTHROPIC_API_KEY` / `CLAUDE_CODE_API_KEY` | `server/ws-server.ts` | Read from env var, not forwarded to child processes |
| `STEPFLOW_CALLBACK_SECRET` | `server/stepflow-handler.ts` | Read from env var only |
| `settings.example.json` | `.codekin/settings.example.json` | Example placeholder only |

`redactSecrets()` in `server/crypto-utils.ts` is applied to error log output, providing an additional safety net against accidental credential leakage in logs.

---

## Recommendations

Ordered by risk impact:

1. **[M1 — High Priority] Make missing `AUTH_TOKEN` a fatal error in production.** The current warn-and-continue behaviour creates the possibility of an entirely unauthenticated production deployment. Add a `process.exit(1)` guard gated on `NODE_ENV === 'production'`, matching the existing `CORS_ORIGIN` guard pattern.

2. **[M2 — High Priority] Exit at startup when Stepflow enabled without a secret.** Fail loudly rather than silently rejecting all webhook events. Apply the same exit-on-misconfiguration pattern used for GitHub webhooks.

3. **[M3 — Medium Priority] Gate tool/task debug logs behind `NODE_ENV` or a debug flag.** Unconditional logging of tool inputs and outputs exposes user repository content in production log pipelines. Introduce a `DEBUG_TOOLS` check and default it off in production.

4. **[L1 — Medium Priority] Validate `workingDir` in `POST /api/sessions/create` against allowed roots.** The directory-browser endpoint already has the correct `realpathSync` + `allowedRoots` guard; apply the same pattern at session creation to prevent authenticated users from spawning Claude outside designated directories.

5. **[L5 — Medium Priority] Validate uploaded file content via magic bytes** rather than relying on the client-supplied `Content-Type` header. Use `&&` instead of `||` in the MIME/extension check so both conditions must be satisfied.

6. **[L4 — Low Priority] Scope the hook config auth token** to a derived `commit-hook` token rather than the master token. `crypto-utils.ts` already provides `deriveSessionToken()` for this purpose; using it limits blast radius if `~/.codekin/hook-config.json` is exfiltrated.

7. **[L2 — Low Priority] Remove the `req.body.token` auth fallback** once its callers are migrated to `Authorization: Bearer`. Preventing token values from appearing in request bodies reduces log-exposure risk.

8. **[L3 — Low Priority] Investigate nonce-based CSP for inline styles.** If TailwindCSS 4's inline-style output can be hash- or nonce-scoped, removing `'unsafe-inline'` from `style-src` would eliminate the CSS-injection data-exfiltration surface.

9. **Audit log for admin actions.** High-privilege operations (session creation, workflow triggers, hook installation) currently produce `console.log` output only. Structured audit logging (who, what, when, from which IP) would support forensic investigation of misuse.

10. **Establish auth token rotation policy.** The master `AUTH_TOKEN` is long-lived with no built-in rotation mechanism. Document a rotation runbook (generate new token → update env → restart server → re-run `syncCommitHooks` to push new hook config) and schedule periodic rotation.
