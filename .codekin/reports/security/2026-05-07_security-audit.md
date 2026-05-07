# Security Audit: codekin

**Date**: 2026-05-07T03:34:19.782Z
**Repository**: /srv/repos/codekin
**Branch**: main
**Workflow Run**: 1251f68c-75b6-41c9-a7d8-435d702b5f2c
**Session**: 0680de48-cf4d-4507-9c41-8e067fef0f55

---

# Security Audit Report — Codekin
**Date:** 2026-05-07
**Scope:** `/srv/repos/codekin` (full repository, excluding `node_modules`)
**Auditor:** Automated scan + static analysis
**Stack:** Node.js/Express WebSocket server (TypeScript), React/Vite frontend, SQLite (better-sqlite3), Claude CLI subprocess management

---

## Summary

**Overall Risk Rating: Medium**

No critical vulnerabilities were found. No hardcoded secrets or committed credentials were detected. The codebase demonstrates solid security fundamentals: timing-safe token comparison, HMAC-signed webhooks, `realpathSync`-enforced path traversal guards, DOMPurify-sanitized markdown rendering, and per-IP rate limiting on every sensitive endpoint.

| Severity | Count |
|----------|-------|
| Critical | 0 |
| High     | 2 |
| Medium   | 3 |
| Low      | 3 |
| Info     | 5 positive controls noted |

---

## Critical Findings

_None identified._

---

## High Findings

### H1 — Auth Token Persisted in `localStorage` (XSS-Accessible)

**File:** `src/hooks/useSettings.ts:12–43`

**Description:** The server authentication token (bearer credential) is serialised into `localStorage` under the key `codekin-settings`. Any cross-site scripting execution context in the application can exfiltrate this token with a single `localStorage.getItem('codekin-settings')` call.

**Impact:** If an XSS payload is ever executed in the Codekin origin (e.g., via a future vulnerability in the markdown pipeline, or a third-party dependency), the attacker gains full server authentication and can spawn sessions, read files under `REPOS_ROOT`, execute Claude CLI processes, and manage approvals—persisting access even after the tab is closed.

**Remediation:**
- Migrate the token to an `HttpOnly` session cookie. The server already uses Authelia for session management; the token can be delivered via a server-set cookie and never exposed to JavaScript.
- If cookie migration is not feasible, use a `sessionStorage`-backed in-memory token that is never written to `localStorage`, accepting that users must re-authenticate on each browser session.
- Tighten the CSP `script-src` directive to prevent untrusted script execution at the origin level.

---

### H2 — Auth Token Accepted via URL Query Parameter

**File:** `src/hooks/useSettings.ts:35–42`

**Description:** The application reads a `?token=` query parameter on page load and persists it to `localStorage`. While the code correctly strips the parameter from the visible URL using `window.history.replaceState`, the token is still exposed in:
- Browser history (the URL with the token is added before the `replaceState` call)
- HTTP `Referer` headers sent on subsequent navigations to external resources
- Web server/nginx access logs
- Any browser extensions with history access

**Impact:** Tokens distributed via share links are permanently logged in infrastructure access logs and browser history. Compromise of either reveals valid server credentials.

**Remediation:**
- Prefer a short-lived, single-use invite token that the server exchanges for a session credential, rather than embedding the long-lived bearer token directly in URLs.
- If URL-token delivery must be retained, document the log-exposure risk and implement token rotation/revocation.

---

## Medium Findings

### M1 — `webhookUrl` Accepted Without URL Validation (GitHub-Mediated SSRF)

**File:** `server/webhook-setup-routes.ts:176–230`, `server/webhook-github-setup.ts:166–193`

**Description:** The `/api/integrations/github/pr-review/setup` endpoint accepts a `webhookUrl` body parameter and registers it as a GitHub webhook endpoint. No validation is performed to confirm the URL is an external HTTPS address or that it matches the server's own public address. An authenticated user can supply an internal network URL (e.g., `http://169.254.169.254/latest/meta-data/` on cloud instances, or `http://localhost:22/`) which GitHub would then POST to on each PR/workflow event, potentially exfiltrating data from internal services.

**Impact:** GitHub-initiated SSRF against internal services reachable from GitHub's egress IPs. The attack is limited to authenticated users, reducing overall severity.

**Remediation:**
```typescript
const ALLOWED_WEBHOOK_SCHEMES = ['https:']
function validateWebhookUrl(raw: string): boolean {
  try {
    const u = new URL(raw)
    return ALLOWED_WEBHOOK_SCHEMES.includes(u.protocol) &&
           !u.hostname.match(/^(localhost|127\.|10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|169\.254\.)/i)
  } catch { return false }
}
```
Apply this check before any call to `previewSetup` or `createRepoWebhook`.

---

### M2 — `TRUST_PROXY=true` Enables IP Spoofing of Rate Limiters

**File:** `server/ws-server.ts:471–473`, `server/config.ts:107`

**Description:** When `TRUST_PROXY=true`, the WebSocket rate limiter extracts the client IP from the raw `X-Forwarded-For` header using `.split(',')[0].trim()`. This takes the leftmost (client-controlled) entry from the header. An attacker behind the proxy can inject an arbitrary IP address as the first `X-Forwarded-For` value, bypassing per-IP rate limits by rotating through a pool of fictitious IPs.

The API route rate limiter uses Express's `req.ip`, which respects the `app.set('trust proxy', true)` setting and uses the rightmost untrusted entry—but Express's documentation warns that `trust proxy: true` trusts all proxies unconditionally, which has the same weakness.

**Impact:** Rate limit bypass by authenticated or unauthenticated clients; enables brute-force token attempts against `POST /auth-verify` and connection floods against the WebSocket endpoint.

**Remediation:**
- Set `app.set('trust proxy', N)` where N is the number of trusted reverse-proxy hops (typically 1 for a single nginx layer), rather than `true`. This causes Express to use the Nth-from-right IP in `X-Forwarded-For`, which cannot be spoofed by the client.
- In the WebSocket rate limiter, read `req.socket.remoteAddress` directly (the nginx proxy address) and rely on Express's `req.ip` (with a numeric trust setting) instead of manually parsing the header.

---

### M3 — Tool I/O Logged to Console in Development Mode

**File:** `server/claude-process.ts:line with TOOL_DEBUG`

**Description:** `const TOOL_DEBUG = process.env.NODE_ENV !== 'production'` enables verbose logging of tool names and inputs in any non-production environment. Tool inputs can include shell commands (from the `Bash` tool) and file paths, which may contain sensitive data such as API keys passed as arguments, passwords in command-line invocations, or confidential repository paths.

**Impact:** In staging or developer setups that handle real credentials or code, tool I/O logs may expose secrets to anyone with log access.

**Remediation:**
- Pass all logged tool I/O through `redactSecrets()` (already implemented in `server/crypto-utils.ts`) before writing to console.
- Consider requiring an explicit opt-in environment variable (e.g., `CODEKIN_TOOL_DEBUG=true`) rather than enabling by default in non-production.

---

## Low Findings

### L1 — CSP Allows `'unsafe-inline'` for Styles

**File:** `server/ws-server.ts:314`

**Description:** The `Content-Security-Policy` header includes `style-src 'self' 'unsafe-inline' https://fonts.googleapis.com`. The `'unsafe-inline'` directive permits arbitrary inline `<style>` blocks and `style=` attributes. While this does not enable script execution, it allows CSS injection attacks that can exfiltrate data via CSS attribute selectors (e.g., reading input values character-by-character) in environments where an injection point exists.

**Remediation:** Replace `'unsafe-inline'` with a CSP nonce (`'nonce-{random}'`) generated per request, or use a CSS-in-JS approach that is nonce-compatible. TailwindCSS 4's JIT output is typically static and nonce-compatible.

---

### L2 — Inconsistent Path Boundary Between `/api/docs` and `/api/docs/file`

**File:** `server/docs-routes.ts` (list endpoint ~line 100, file endpoint ~line 120)

**Description:** The directory-listing endpoint (`GET /api/docs?repo=`) restricts browsing to `REPOS_ROOT` **or the user's home directory**, while the file-content endpoint (`GET /api/docs/file?repo=&file=`) restricts to `REPOS_ROOT` only. This inconsistency means the list endpoint can enumerate markdown file names under the home directory, while the content endpoint blocks reading them. While the list-only exposure is limited, the inconsistency creates confusion and could widen if the restriction is relaxed in future.

**Remediation:** Align both endpoints to the same allowed roots. Since docs browsing is a repository feature, restricting both to `REPOS_ROOT` is appropriate.

---

### L3 — Unparameterized `ORDER BY` Clause in `buildListQuery`

**File:** `server/workflow-engine.ts:280–295`

**Description:** The `buildListQuery` function concatenates `opts.orderBy` directly into the SQL string without parameterization: `sql += \` ORDER BY ${opts.orderBy}\``. SQLite does not support parameterized identifiers in `ORDER BY` clauses, so this is a known limitation of the approach. Currently all callers pass the hardcoded literal `'created_at DESC'`, so there is no present injection path.

**Impact:** Low—only exploitable if a caller is added that passes user input to `orderBy`. However, the pattern is unsafe by design and may be inadvertently reused with user-controlled data.

**Remediation:** Add an allowlist validation inside `buildListQuery`:
```typescript
const ALLOWED_ORDER = new Set(['created_at DESC', 'created_at ASC', 'id DESC'])
if (opts.orderBy && !ALLOWED_ORDER.has(opts.orderBy)) throw new Error('Invalid orderBy')
```

---

## Secrets & Credentials Exposure

**No hardcoded secrets, API keys, passwords, or committed `.env` files were found.**

The `.gitignore` correctly excludes `.env` and `.env.*`. Verified via `git log` history: no credential values appear in past commits.

Configuration findings:
- `AUTH_TOKEN` is loaded from the `AUTH_TOKEN` environment variable or a file referenced by `AUTH_TOKEN_FILE`. The server exits fatally at startup if neither is set. ✓
- `GITHUB_WEBHOOK_SECRET` is loaded from `GITHUB_WEBHOOK_SECRET` env var. The server exits fatally if webhooks are enabled without a secret. ✓
- The hook config file (`~/.codekin/hook-config.json`) is written with permissions `0600` (owner read/write only). ✓
- Session-scoped tokens are derived via `HMAC-SHA256(masterToken, "session:" + sessionId)` — cannot be used to recover the master token. ✓

---

## Positive Security Controls Noted

1. **Timing-safe token comparison** (`timingSafeEqual` with SHA-256 hashing to equalise length) prevents timing oracle attacks on auth endpoints.
2. **HMAC-SHA256 webhook signature verification** with `timingSafeEqual` comparison on all GitHub and Stepflow webhook endpoints.
3. **`realpathSync`-enforced path traversal guards** on all endpoints that accept filesystem paths (`/api/sessions/create`, `/api/browse-dirs`, `/api/clone`, `/api/docs`, `/api/docs/file`).
4. **DOMPurify sanitization** of all markdown content rendered in the frontend, with `marked` as the parser.
5. **WebSocket origin validation** in production mode; per-IP rate limiting on connections (30/min), messages (60/sec), and auth attempts (10/min).

---

## Recommendations

1. **[High — H1/H2]** Migrate auth token delivery from `localStorage` / URL parameters to an `HttpOnly` server-set cookie. This is the single highest-impact change: it eliminates XSS token theft and URL log exposure simultaneously.

2. **[High — M1]** Add URL validation to all `webhookUrl` inputs before registering them with GitHub. Reject non-HTTPS schemes and private IP ranges.

3. **[Medium — M2]** Change `app.set('trust proxy', true)` to `app.set('trust proxy', 1)` (or the appropriate hop count) to prevent X-Forwarded-For IP spoofing against rate limiters.

4. **[Medium — M3]** Pipe all development-mode tool I/O logging through `redactSecrets()` and make debug logging opt-in via an explicit environment variable.

5. **[Low — L1]** Replace `style-src 'unsafe-inline'` with a per-request CSP nonce in the `Content-Security-Policy` header to prevent CSS injection attacks.

6. **[Low — L2]** Align `/api/docs` (list) and `/api/docs/file` (content) to the same path boundary (`REPOS_ROOT` only); remove the home-directory allowance from the list endpoint.

7. **[Low — L3]** Add an allowlist inside `buildListQuery` for the `orderBy` parameter to prevent future SQL injection if user-controlled sort fields are introduced.

8. **[Hardening]** Add `Access-Control-Allow-Credentials: false` explicitly to CORS headers to make it unambiguous that credential-bearing cross-origin requests are not intended.

9. **[Hardening]** Consider pinning `npm audit` or a tool like `socket.dev` to CI so dependency vulnerabilities are caught automatically. The current audit shows zero vulnerabilities, but this should be verified continuously.

10. **[Hardening]** Document the expected `TRUST_PROXY` deployment topology in `CLAUDE.md` or server README so operators deploying behind multiple load balancers configure the correct hop count.