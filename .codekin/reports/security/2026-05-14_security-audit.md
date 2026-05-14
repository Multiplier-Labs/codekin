# Security Audit: codekin

**Date**: 2026-05-14T03:34:32.336Z
**Repository**: /srv/repos/codekin
**Branch**: main
**Workflow Run**: 5cea9ea6-9968-4e1d-882d-3470b06fb0b7
**Session**: 3f212eb1-fb79-4fe3-90c6-4ff9fa72a77a

---

Now I have all the information needed for a comprehensive security audit. Let me compile the full report.

---

# Security Audit Report — Codekin
**Date:** 2026-05-14  
**Auditor:** Automated AI Security Review  
**Commit:** 42dc412 (HEAD, main)  
**Scope:** Full source audit — server (TypeScript/Node.js), frontend (React/TypeScript), configuration, and git history

---

## Summary

**Overall Risk Rating: Low–Medium**

The Codekin codebase demonstrates strong security fundamentals: timing-safe authentication, parameterized database queries, comprehensive input validation, DOMPurify-based XSS prevention, webhook HMAC verification, and layered rate limiting. No hardcoded secrets or committed credentials were found.

| Severity | Count |
|----------|-------|
| Critical | 0 |
| High | 1 |
| Medium | 4 |
| Low / Informational | 3 |

---

## Critical Findings

None identified.

---

## High Findings

### H1 — TRUST_PROXY Enables IP Spoofing for Rate-Limit Bypass

**File:** `server/ws-server.ts:457`, `server/config.ts:112`

**Description:** When the `TRUST_PROXY=true` environment variable is set, the server reads the client IP from the first value in the `X-Forwarded-For` header for all rate-limiting decisions (auth endpoint, WebSocket connection throttling, message rate limiting). If the deployment path allows untrusted clients to set this header — for example, if Nginx is not configured to strip or overwrite it — any remote client can rotate through arbitrary IP addresses and evade per-IP rate limits entirely.

```typescript
// ws-server.ts:457
const ip = (TRUST_PROXY && (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim())
         || req.socket.remoteAddress || 'unknown'
```

Express's built-in `trust proxy` setting (line 204) canonicalises the IP for routing purposes, but the raw header split above bypasses Express's proxy trust chain for WebSocket upgrades, where `req.ip` is not reliable.

**Impact:** An attacker who can inject arbitrary `X-Forwarded-For` values can evade rate limiting on authentication attempts and session creation, enabling brute-force and DoS vectors that the rate limiting was designed to prevent.

**Remediation:**
- In production, configure the upstream reverse proxy (nginx) to unconditionally set `X-Forwarded-For` from `$remote_addr` and strip any client-supplied value before it reaches Node.js.
- In the application, consider replacing the manual header split with Express's `req.ip` (which already respects `trust proxy` hops) so that the same source of truth is used everywhere.
- Document the required nginx configuration in the deployment guide.

---

## Medium Findings

### M1 — `style-src 'unsafe-inline'` in Content-Security-Policy

**File:** `server/ws-server.ts:314`

**Description:** The CSP header includes `'unsafe-inline'` in the `style-src` directive to accommodate TailwindCSS utility classes applied at runtime. While no XSS vector was found in the current code (all HTML is DOMPurify-sanitised), this directive substantially weakens the defence-in-depth value of the CSP: if an XSS payload were ever introduced, it could inject arbitrary `<style>` blocks or inline `style=` attributes to facilitate clickjacking, data exfiltration via CSS selectors, or UI redressing.

**Impact:** Reduces the protective value of CSP. Any future XSS vulnerability gains an additional exploitation avenue.

**Remediation:**
- Migrate to CSS Modules, a nonce-based inline style policy (`'nonce-…'`), or hash-based allowlisting (`'sha256-…'`) for the small number of dynamic inline styles, eliminating the broad `'unsafe-inline'` grant.
- As a short-term improvement, add `'unsafe-hashes'` only for specific hash-matched style values rather than blanket inline permission.

---

### M2 — Upload MIME Type Validated from Client-Supplied Header

**File:** `server/upload-routes.ts:187–198`

**Description:** The file upload handler validates uploaded files against an allowlist of MIME types and extensions. However, the MIME type check (`file.mimetype`) is sourced from the multipart `Content-Type` header sent by the client, which an attacker can freely set to any value. An attacker can upload a file with a `.png` extension and `image/png` MIME type header while the actual file content is executable or malicious (e.g., an SVG with embedded script, or a polyglot file).

```typescript
const ALLOWED_MIME_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'text/markdown']
const ALLOWED_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.md']
const extAllowed = ALLOWED_EXTENSIONS.includes(ext)
const mimeAllowed = ALLOWED_MIME_TYPES.includes(file.mimetype)   // client-supplied
```

Uploaded files are stored in `SCREENSHOTS_DIR` and served back to Claude sessions as file attachments. The risk is partially mitigated by the tight extension allowlist and the fact that files are not executed server-side.

**Impact:** A user could upload a polyglot file (e.g., a JPEG/PHP polyglot, or SVG with script tags) that passes the type check. If the serving infrastructure ever changes or files are re-interpreted, this creates a stored XSS or code-execution path.

**Remediation:**
- Perform server-side magic-byte / file signature validation (e.g., using the `file-type` npm package) in addition to the client-supplied MIME type check.
- Ensure uploaded files are served with `Content-Disposition: attachment` and `X-Content-Type-Options: nosniff` to prevent browser sniffing.

---

### M3 — `pkill -f` Pattern Uses Session UUID in Regex Match

**File:** `server/claude-process.ts:228–229`

**Description:** When resuming a Claude session, the server runs `pkill -f` with a regex pattern that includes the session UUID to kill any orphaned process. Session IDs are generated via `randomUUID()` (UUID v4), which are reliably safe. However, the `extraEnv` dictionary (line 129–130) can carry arbitrary key-value pairs injected at session creation. While session UUIDs are safe, future refactors that incorporate externally-supplied data into the pkill pattern string could introduce process-injection risk.

```typescript
const pattern = `${CLAUDE_BINARY} .*(--resume|--session-id) ${this.sessionId}(\\s|$)`
execFileSync('pkill', ['-f', pattern], { timeout: 2000, stdio: 'ignore' })
```

Note: `execFileSync` is used with an array of arguments (not shell-interpolated), so there is no current shell injection. The risk is architectural.

**Impact:** Low currently; elevated if the pattern string ever incorporates user-controlled data. A compromised pattern could match and kill unrelated system processes.

**Remediation:**
- Add an assertion that `this.sessionId` matches the UUID v4 format (`/^[0-9a-f-]{36}$/i`) before constructing the pattern, making the assumption explicit and verifiable.
- Consider using a PID file written at spawn time and killing by PID rather than by name pattern.

---

### M4 — Spawn Argument Array Logged at INFO Level

**File:** `server/claude-process.ts:235`

**Description:** The full CLI argument array for each spawned Claude process is logged at INFO level:

```typescript
console.log(`[claude-spawn] cwd=${this.workingDir} args=${JSON.stringify(args)}`)
```

The args array includes `--append-system-prompt` followed by the full system prompt string, `--allowedTools` with the complete tool list, `--session-id` / `--resume` with the session UUID, and `--add-dir` paths. This information is not secret in isolation, but server logs may be aggregated to external services (e.g., log management platforms). Session UUIDs appearing in logs could assist session hijacking if the WebSocket auth were bypassed.

Additionally, `extraEnv` (line 188) is merged into the child process environment after stripping API key variables. If a calling path ever places sensitive values in `extraEnv` keys, those values would be inherited by the child process (environment), though not logged here.

**Impact:** Session IDs and working directory paths in logs may assist targeted attacks if logs are exfiltrated. No secrets are logged in the current implementation.

**Remediation:**
- Redact `--session-id` value from the logged args string, similar to how `redactSecrets` is applied elsewhere.
- Review `extraEnv` usage at all call sites to confirm no sensitive values are passed through (currently: session ID, port, and a session-scoped HMAC token — acceptable, but worth documenting).

---

## Low / Informational Findings

### L1 — CORS Production Guard Logs Error But Does Not Exit

**File:** `server/config.ts:25–31`

When `NODE_ENV=production` and `CORS_ORIGIN` is not set or contains `localhost`, the server emits `console.error` messages but continues to start. An operator might miss these errors in noisy logs, resulting in a deployment with an insecure CORS origin.

**Remediation:** Add `process.exit(1)` after the error message so that a misconfigured production instance refuses to start rather than running silently with a dangerous default.

---

### L2 — Hook Config File Contains Auth Token on Disk

**File:** `server/commit-event-hooks.ts:47–54`

The server writes `~/.codekin/hook-config.json` containing the live auth token with `0o600` permissions. This file persists between server restarts. If the auth token is rotated, the hook config file retains the old token until `ensureHookConfig` is called again with the new token.

**Impact:** If the token is rotated without restarting the server (or without the hook config being refreshed), the shell hook may use a stale, invalid token — a usability rather than security risk. If the file is accidentally world-readable due to a umask misconfiguration, the token is exposed.

**Remediation:** Document the need to restart/refresh the hook config on token rotation. The `0o600` file mode is correct; verify it takes effect even under non-standard umask values by using `fs.chmodSync` after writing.

---

### L3 — `connect-src 'self'` in CSP May Need Explicit WebSocket Origin

**File:** `server/ws-server.ts:314`

The CSP `connect-src 'self'` directive allows WebSocket connections to the same origin. In most deployments this is correct, but if the server and frontend are on different origins (e.g., the API on port 32352 and the UI served via nginx on port 443), `'self'` may block the WebSocket connection in some browser implementations, leading operators to add a wildcard. The current configuration should be verified against the actual production topology.

**Remediation:** Explicitly include the WebSocket server origin (`wss://…`) in `connect-src` rather than relying on `'self'` to resolve correctly across proxy configurations.

---

## Secrets & Credentials Exposure

**No hardcoded secrets, API keys, passwords, or tokens were found in the source tree.**

- All authentication tokens are loaded from `AUTH_TOKEN` (env var) or `AUTH_TOKEN_FILE` (file path env var) — `server/config.ts:40–54`
- Webhook secrets (`GITHUB_WEBHOOK_SECRET`, `STEPFLOW_WEBHOOK_SECRET`) are loaded exclusively from environment variables — `server/ws-server.ts:163–184`
- The `.env` pattern is present in `.gitignore` (confirmed)
- No `.env*` files were found in the repository
- `package-lock.json` and `pnpm-lock.yaml` contain only package-name references to the word "token" (CSS tokenizers) — no credentials
- Git history (20 most recent commits) contains no secret-exposure events; all recent commits are feature work and chore/audit commits

The `~/.codekin/hook-config.json` file (auth token on disk) is correctly excluded from git via `.gitignore`'s `.codekin/` entry and is set to `0o600` permissions — `server/commit-event-hooks.ts:54`

---

## Recommendations

Ordered by risk impact:

1. **[H1] Harden reverse-proxy IP trust configuration.** Document and enforce that the upstream nginx must strip and overwrite `X-Forwarded-For` before traffic reaches Node.js. Add a startup warning if `TRUST_PROXY=true` but `NODE_ENV` is not `production`, to catch misconfigured development proxies.

2. **[M1] Eliminate `'unsafe-inline'` from CSP `style-src`.** Introduce nonce-based or hash-based inline style allowlisting. This is the highest-value hardening action that does not require changes to existing secure logic — only the CSP string and the build pipeline for style generation.

3. **[M2] Add magic-byte file validation to the upload endpoint.** Integrate server-side file signature detection (e.g., `file-type` npm package) to complement the client-supplied MIME type check. Enforce `Content-Disposition: attachment` on served upload files.

4. **[L1] Make production CORS misconfiguration fatal.** Change the `console.error` in `server/config.ts:25–31` to `console.error(…); process.exit(1)` so that a production deployment with a localhost CORS origin fails loudly at startup rather than silently serving with a dangerous default.

5. **[M3] Add UUID assertion before `pkill -f` pattern construction.** Assert `this.sessionId` matches `UUID_V4_REGEX` before building the pkill pattern, making the implicit safety assumption explicit and guarding against future regressions. Longer term, consider PID-file-based process tracking.

6. **[M4] Redact session ID from spawn log line.** Apply `redactSecrets` or a targeted UUID mask to the `args` array before logging in `claude-process.ts:235` to avoid session UUIDs appearing in plain-text server logs.

7. **[L3] Specify explicit WebSocket origin in `connect-src`.** Update the CSP to include the production WebSocket URL (`wss://your-domain`) in `connect-src` rather than relying on `'self'`, ensuring the policy works correctly when the API and UI origins differ.

8. **[General] Establish a dependency update cadence.** Run `pnpm audit` on a scheduled basis (e.g., weekly via a Codekin workflow). The current dependency tree was not found to have known CVEs at audit time, but `marked`, `dompurify`, `express`, and `ws` are high-surface libraries warranting prompt patching when security releases are published.

9. **[General] Consider centralising rate-limit storage.** The current in-process `Map`-based rate limiters (with per-IP cleanup timers) work correctly for a single-instance deployment but do not share state across processes. If the server is ever horizontally scaled, rate limits become per-instance, halving their effectiveness. Document this single-instance assumption or migrate to Redis-backed rate limiting.

10. **[General] Add an automated security audit to the CI pipeline.** Integrate `pnpm audit --audit-level=high` and a static analysis tool (e.g., `eslint-plugin-security` or `semgrep` with the Node.js ruleset) into the existing CI workflow to catch newly-introduced patterns before merge.