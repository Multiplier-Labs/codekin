# Security Audit: codekin

**Date**: 2026-03-12T04:35:59.938Z
**Repository**: /srv/repos/codekin
**Branch**: chore/repo-health-audit-2026-03-12
**Workflow Run**: 98d94943-fb04-421b-9aa5-73233984b9d5
**Session**: 6506fdc7-a86d-4ca0-b37d-23b1ed47c3a3

---

## Security Audit Report — codekin

**Date**: 2026-03-12
**Repository**: /srv/repos/codekin
**Branch**: chore/repo-health-audit-2026-03-12
**Auditor**: Automated (Claude Code security scan)

---

## Summary

**Overall Risk Rating: Low**

The codekin codebase demonstrates a strong security posture. No critical or injection-class exploitable vulnerabilities were found. Authentication is cryptographically sound, input validation is generally correct, and security headers are properly configured.

| Severity | Count |
|---|---|
| Critical | 0 |
| High | 1 |
| Medium | 2 |
| Low | 2 |
| Informational | 3 |

---

## Critical Findings

None.

---

## High Findings

### H1 — Path Traversal: Incomplete Boundary Check in docs-routes

**File**: `server/docs-routes.ts:150–154`
**Type**: Path Traversal

**Code**:
```typescript
const resolved = resolve(repoPath, filePath)
const repoResolved = resolve(repoPath)
if (!resolved.startsWith(repoResolved + '/') && resolved !== repoResolved) {
  return res.status(404).json({ error: 'File not found' })
}
```

**Description**: The path traversal guard uses a string prefix check (`startsWith(repoResolved + '/')`) without first resolving symlinks. An attacker who can create or control a symlink within the repository directory could escape the intended boundary. Additionally, the guard does not call `realpathSync()` before comparison, so a path such as `/repos/myrepo/subdir/../../../../etc/passwd` — if `resolve()` normalises it to an absolute path outside the repo root — relies on the string comparison alone.

**Impact**: If exploitable, an authenticated user could read arbitrary files on the server that the Node process has read access to (e.g., `/etc/passwd`, private keys, other repositories' source code).

**Remediation**:
```typescript
import { realpathSync } from 'fs'
const resolved = realpathSync(resolve(repoPath, filePath))
const repoResolved = realpathSync(resolve(repoPath))
if (!resolved.startsWith(repoResolved + path.sep)) {
  return res.status(403).json({ error: 'Access denied' })
}
```
Use `realpathSync` (or its async equivalent) to canonicalise both paths before comparison. This resolves symlinks and normalises separators, closing the bypass vector.

---

## Medium Findings

### M1 — SQL Injection Pattern: Unparameterised `orderBy` in `buildListQuery`

**File**: `server/workflow-engine.ts:165–179`
**Type**: SQL Injection (pattern-level, currently low exploitability)

**Code**:
```typescript
function buildListQuery(table: string, opts: ListQueryOpts) {
  let sql = `SELECT * FROM ${table} WHERE 1=1`
  for (const f of opts.filters) {
    sql += ` AND ${f.column} = ?`   // column not validated
    params.push(f.value)
  }
  if (opts.orderBy) sql += ` ORDER BY ${opts.orderBy}` // NOT parameterised
  ...
}
```

**Description**: Both `opts.orderBy` and `f.column` are concatenated directly into the SQL string. SQLite does not support parameterised identifiers, but whitelist validation is missing. Call sites currently pass hardcoded literals, so this is not actively exploitable — however, if the function is reused or its inputs are ever derived from user-controlled data, it becomes a full SQL injection vector.

**Impact**: SQL injection enabling data exfiltration or corruption if call sites ever accept user-controlled `orderBy` or `column` values.

**Remediation**: Add a column/order-by allowlist:
```typescript
const ALLOWED_ORDER_COLS = new Set(['created_at', 'updated_at', 'status', 'kind'])
if (opts.orderBy && !ALLOWED_ORDER_COLS.has(opts.orderBy)) {
  throw new Error(`Invalid orderBy column: ${opts.orderBy}`)
}
```

---

### M2 — CORS Origin Falls Back to `localhost` Without Explicit Production Guard

**File**: `server/config.ts:24–31`, `server/ws-server.ts:250`
**Type**: Configuration — CORS

**Code**:
```typescript
export const CORS_ORIGIN = process.env.CORS_ORIGIN || 'http://localhost:5173'

if (process.env.NODE_ENV === 'production' && !process.env.CORS_ORIGIN) {
  console.error('[config] ERROR: ...')
  process.exit(1)
}
```

**Description**: The guard correctly exits in `NODE_ENV=production` if `CORS_ORIGIN` is unset. However, staging or CI environments that set `NODE_ENV=staging` or omit the variable entirely will silently fall back to `localhost:5173`. The CORS origin is also applied without restricting `Access-Control-Allow-Credentials`, which could allow cross-origin state mutation from the fallback origin in those environments.

**Impact**: In non-production environments with network exposure, cross-origin requests from any page served on localhost could interact with the API.

**Remediation**: Extend the guard to cover any environment that is not purely local development:
```typescript
if (!process.env.CORS_ORIGIN && process.env.NODE_ENV !== 'development') {
  throw new Error('CORS_ORIGIN must be explicitly set in non-development environments')
}
```

---

## Low Findings

### L1 — Unauthenticated Token-Verification Endpoint Enables Brute-Force Oracle

**File**: `server/auth-routes.ts:35–38`
**Type**: Information Disclosure / Brute Force

**Code**:
```typescript
router.post('/auth-verify', (req, res) => {
  const token = extractToken(req)
  res.json({ valid: verifyToken(token) })
})
```

**Description**: The `/auth-verify` endpoint is publicly accessible and returns a boolean confirming whether a submitted token is valid. While the HMAC-SHA256 token derivation makes brute-force computationally infeasible, the endpoint provides a direct oracle — any attacker who obtains a candidate token can confirm its validity without rate limiting.

**Impact**: Facilitates offline-to-online token testing; amplifies impact of any token leak.

**Remediation**: Add IP-based rate limiting (e.g., `express-rate-limit`) to this endpoint, and/or return HTTP 401 on failure rather than `{ valid: false }` to avoid leaking the verification result format.

---

### L2 — No Rate Limiting on General REST API Endpoints

**File**: `server/ws-server.ts` (multiple endpoints)
**Type**: Denial of Service / Resource Exhaustion

**Description**: Webhook endpoints correctly apply `createWebhookRateLimiter` and WebSocket connections are rate-limited. However, REST endpoints such as `GET /api/sessions`, `POST /api/approvals/:id`, and `GET /api/workflows` have no per-IP or per-token rate limits. An attacker with a valid token could send high-volume requests to exhaust server resources.

**Impact**: Authenticated denial of service; potential resource exhaustion (CPU, SQLite write contention).

**Remediation**: Apply a global rate-limit middleware before all `/api/*` routes:
```typescript
import rateLimit from 'express-rate-limit'
app.use('/api/', rateLimit({ windowMs: 60_000, max: 300 }))
```

---

## Secrets & Credentials Exposure

**No hardcoded secrets, API keys, passwords, or private keys were found in any source file.**

Findings from `git grep` scan:
- All token references in source files are environment variable reads (`process.env.AUTH_TOKEN`, `process.env.WEBHOOK_SECRET`, etc.) — none are hardcoded values.
- No `.env` files are committed to the repository.
- No Base64-encoded credentials were found.
- The only token literals in the codebase appear in test fixtures and are clearly synthetic (e.g., `'test-token'`, `'mock-secret'`).

---

## Informational Findings

### I1 — `dangerouslySetInnerHTML` Usage Is Properly Sanitised

**File**: `src/components/MarkdownRenderer.tsx:41`

DOMPurify is applied before all `dangerouslySetInnerHTML` assignments. No XSS risk identified.

### I2 — Child Process Spawning Is Safe

**File**: `server/claude-process.ts`

All `spawn()` calls pass arguments as arrays with `shell: false` (default). No shell metacharacter injection is possible.

### I3 — Webhook Signature Verification Uses Timing-Safe Comparison

**File**: `server/webhook-handler.ts:88–91`

HMAC-SHA256 signatures are verified with `crypto.timingSafeEqual`, preventing timing-based signature oracle attacks. Well-implemented.

---

## Positive Security Practices Noted

| Practice | Location |
|---|---|
| Timing-safe token comparison (`crypto.timingSafeEqual`) | `server/auth-routes.ts`, `server/webhook-handler.ts` |
| HMAC-SHA256 session token derivation (never exposes master key) | `server/auth-routes.ts` |
| Security headers: `X-Frame-Options`, `X-Content-Type-Options`, `HSTS`, CSP | `server/ws-server.ts:235–246` |
| Secret redaction in log output | `server/crypto-utils.ts:13–27` |
| Repository root boundary enforcement with `realpathSync` in upload/clone paths | `server/upload-routes.ts` |
| DOMPurify sanitisation before `dangerouslySetInnerHTML` | `src/components/MarkdownRenderer.tsx` |
| Array-based `spawn()` arguments (no shell=true) | `server/claude-process.ts` |
| File upload MIME type and size validation | `server/upload-routes.ts` |

---

## Recommendations

1. **[HIGH] Fix symlink-bypass path traversal in `server/docs-routes.ts`** — Add `realpathSync()` canonicalisation before the boundary check. This is the only finding that could allow an authenticated user to read files outside a repository directory.

2. **[MEDIUM] Whitelist `orderBy` and `column` values in `buildListQuery`** (`server/workflow-engine.ts`) — Prevent this pattern from becoming exploitable if the function is ever called with user-controlled input.

3. **[MEDIUM] Extend the CORS origin guard to non-`production` NODE_ENV values** (`server/config.ts`) — Any deployed instance that doesn't set `NODE_ENV=production` will silently fall back to a localhost origin.

4. **[LOW] Add rate limiting to `/auth-verify`** (`server/auth-routes.ts`) — At minimum, apply per-IP throttling (e.g., 10 req/min) to prevent the endpoint from functioning as a token-testing oracle.

5. **[LOW] Apply global rate limiting to `/api/*` routes** (`server/ws-server.ts`) — Protect against authenticated resource exhaustion; the webhook rate limiter already exists as a model.

6. **[INFORMATIONAL] Extend `realpathSync` usage to `docs-routes.ts`** consistently with the pattern already established in `upload-routes.ts` — Treat it as a project-wide convention for any endpoint that constructs filesystem paths from request parameters.

7. **[INFORMATIONAL] Add a CI step that fails on `shell: true` in `child_process` calls** — Codify the existing safe practice to prevent regression as the codebase grows.

8. **[INFORMATIONAL] Consider adding a Content Security Policy `report-uri`** — The CSP header is present; adding a report endpoint (or a third-party CSP reporting service) would provide visibility into any future injection attempts.Now I'll append the security audit to the clean HEAD version of the report and write the result.Committed and pushed. The security audit section (201 lines) has been appended to `.codekin/reports/repo-health/2026-03-12_repo-health.md` on `chore/repo-health-audit-2026-03-12`.

**Top findings in the audit:**
- **High**: Path traversal in `server/docs-routes.ts:150–154` — missing `realpathSync()` before boundary check allows symlink escape
- **Medium**: Unparameterised `orderBy`/`column` in `buildListQuery` (`server/workflow-engine.ts:165`)
- **Medium**: CORS origin silently falls back to `localhost` in non-`production` `NODE_ENV` environments
- **Low**: `/auth-verify` endpoint acts as an unauthenticated token oracle; no rate limiting on general `/api/*` routes
- **No secrets found** anywhere in the codebase