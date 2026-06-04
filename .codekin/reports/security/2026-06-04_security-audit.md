# Security Audit: codekin

**Date**: 2026-06-04T03:35:15.848Z
**Repository**: /srv/repos/Multiplier-Labs/codekin
**Branch**: main
**Workflow Run**: 612c8594-9d4f-4de9-a58c-94a3bcd86a98
**Session**: 9f8b49e5-9efa-49f1-b713-0c79b94c677d

---

# Security Audit Report — Codekin
**Date:** 2026-06-04
**Auditor:** Automated (Claude Sonnet 4.6)
**Scope:** Full repository scan — `/srv/repos/Multiplier-Labs/codekin`
**Version:** 0.6.5

---

## Summary

**Overall Risk Rating: Low–Medium**

The codebase demonstrates a solid security posture with defence-in-depth: timing-safe token verification, parameterised SQL queries, exec-safe child process spawning, and multiple rate-limiting layers. No hardcoded credentials were found in source files. The principal findings are confined to a latent SQL injection path in the query-builder (unexercised today but structurally unsafe), a potential DNS-rebinding gap in SSRF protection, missing token expiry, and a mildly weakened CSP.

| Severity | Count |
|----------|-------|
| Critical | 0 |
| High | 0 |
| Medium | 3 |
| Low | 4 |
| Informational | 3 |

---

## Critical Findings

None identified.

---

## High Findings

None identified.

---

## Medium Findings

### M1 — SQL Injection Risk in `buildListQuery` (Column Name Interpolation)

**File:** `server/workflow-engine.ts:286–299`

**Description:**
The helper `buildListQuery` interpolates `f.column` and `opts.orderBy` directly into the SQL string without any allowlist validation:

```typescript
sql += ` AND ${f.column} = ?`   // line 291 — column name unsanitised
sql += ` ORDER BY ${opts.orderBy}` // line 295 — order clause unsanitised
```

Current callers (`listRuns`, line 679–684) use hardcoded column names (`'kind'`, `'status'`) and a hardcoded `orderBy` value (`'created_at DESC'`), so the vulnerability is not reachable today. However, the function signature accepts arbitrary `string` for both fields, and any future caller that passes user-controlled input (e.g., a sort-by query parameter) would produce a direct SQL injection.

The same structural pattern is repeated in `server/orchestrator-memory.ts:187–212`, where the SQL is built manually but only with hardcoded column names.

**Impact:** If a future route exposes `column` or `orderBy` to user input, an attacker could exfiltrate the entire SQLite database or corrupt data.

**Remediation:** Introduce an allowlist inside `buildListQuery`:

```typescript
const ALLOWED_COLUMNS = new Set(['kind', 'status', 'created_at', 'session_id'])
const ALLOWED_ORDER = /^[a-z_]+ (ASC|DESC)$/i

if (opts.orderBy && !ALLOWED_ORDER.test(opts.orderBy)) throw new Error('Invalid orderBy')
for (const f of opts.filters) {
  if (!ALLOWED_COLUMNS.has(f.column)) throw new Error(`Invalid column: ${f.column}`)
}
```

---

### M2 — SSRF Protection Does Not Mitigate DNS Rebinding

**File:** `server/stepflow-handler.ts:411–460`

**Description:**
The Stepflow callback URL validator correctly checks `parsedUrl.hostname` against `STEPFLOW_CALLBACK_HOSTS` and blocks known private/loopback IPv4/IPv6 ranges. However, the check occurs at parse-time using the literal string in the URL. A DNS rebinding attack can bypass this:

1. Attacker registers `attacker.example.com` on the allowlist (or controls a hostname that happens to be allowed).
2. Attacker's DNS returns a legitimate IP during validation, then rebinds to `127.0.0.1` for the actual `fetch()` call.
3. The server-side `fetch` reaches internal services.

**Impact:** An attacker who can influence the allowlist, or who controls an allowlisted domain's DNS TTL, could direct the server to make requests to internal infrastructure (metadata services, other local services on port 32352, etc.).

**Remediation:** After the DNS-name check, resolve the hostname and verify the resulting IPs are not in private ranges before making the outbound request. Libraries such as `ssrf-req-filter` provide this capability. Alternatively, route all outbound callback traffic through an egress proxy that enforces network-level controls.

---

### M3 — Authentication Tokens Have No Expiry

**File:** `server/config.ts:40–60`, `server/crypto-utils.ts`

**Description:**
`AUTH_TOKEN` is a static string loaded at startup with no time-to-live, rotation mechanism, or revocation path. Session-scoped tokens derived via HMAC-SHA256 are similarly permanent for the lifetime of the server process. If a token is leaked (e.g., from `hook-config.json`, process environment exposure via `/proc`, or log capture before redaction), it remains valid indefinitely until the server is manually restarted with a new token.

**Impact:** Compromised tokens grant permanent full access to all sessions and API endpoints.

**Remediation:**
- Implement token rotation: allow a `NEW_AUTH_TOKEN` env variable and a grace period; invalidate old token after N hours.
- Alternatively, derive the master token from a short-lived secret (e.g., TOTP-style HMAC keyed on day/hour) so it rolls automatically.
- At minimum, document and enforce a mandatory rotation interval in operations runbooks.

---

## Low Findings

### L1 — `hook-config.json` Written to User Home with Auth Token

**File:** `server/commit-event-hooks.ts:47–52`

**Description:**
The server writes `~/.codekin/hook-config.json` with permissions `0600`, containing the live auth token. If a local process runs as the same user (e.g., a malicious npm post-install script or a compromised Claude tool invocation), it can read this file and obtain the master auth token.

**Remediation:** Consider using a token scoped only to commit-hook operations (derived via HMAC from master + purpose) rather than the master token itself.

---

### L2 — CSP Allows `style-src 'unsafe-inline'`

**File:** `server/ws-server.ts:309`

**Description:**
The Content-Security-Policy header includes `style-src 'self' 'unsafe-inline'`. This allows any injected inline `<style>` tag or `style=` attribute to execute, which weakens CSS-based injection defences.

**Remediation:** TailwindCSS 4's JIT mode generates `<style>` blocks at build time. Switch to nonce-based inline style allowance (`'nonce-{random}'`) or hash-based allowance (`'sha256-...'`) so that only known stylesheets are permitted at runtime.

---

### L3 — `X-Forwarded-For` Trust Without Validation of Proxy Chain

**File:** `server/ws-server.ts` (rate limiting), `server/config.ts` (`TRUST_PROXY`)

**Description:**
When `TRUST_PROXY=true` is set, Express trusts the `X-Forwarded-For` header to determine client IP for rate limiting. An attacker who can reach the server without going through the trusted proxy (e.g., direct TCP access on port 32352) can spoof this header and bypass per-IP rate limits.

**Remediation:** Restrict `TRUST_PROXY` to specific upstream proxy IP addresses (`app.set('trust proxy', '127.0.0.1')`) rather than the boolean `true`, and ensure the server port is firewalled to accept connections only from the proxy.

---

### L4 — Webhook Secret Absence Produces Only a Warning for GitHub Webhooks

**File:** `server/ws-server.ts:163–170`

**Description:**
When `GITHUB_WEBHOOK_SECRET` is not set, the server logs a warning and continues operating, with the webhook endpoint effectively unauthenticated. In contrast, `STEPFLOW_WEBHOOK_SECRET` causes a fatal exit. This inconsistency means a misconfigured deployment can silently accept unsigned GitHub events.

**Remediation:** Treat the absent GitHub webhook secret with the same severity as Stepflow: fail fast on startup if webhooks are enabled but the secret is missing.

---

## Informational Findings

### I1 — `kind` and `status` Query Parameters Pass Through Without Enum Validation

**File:** `server/workflow-routes.ts:323–329`

`status` is cast to `RunStatus` via TypeScript without runtime validation before being passed to the query. TypeScript types are erased at runtime. While these values are used as parameterised SQL values (safe from injection), passing unexpected strings to SQLite queries silently returns zero rows. A runtime allowlist check would make the API contract explicit and improve observability.

---

### I2 — Server Version Exposed in Startup Logs and API Health Response

**File:** `server/ws-server.ts`, `package.json`

The running version string is exposed in startup logs and the `/api/health` endpoint. This is standard practice and acceptable for an internal tool, but worth noting if the surface becomes internet-exposed without an auth proxy.

---

### I3 — `db.exec()` Used for Schema Migrations Without Transaction Guards

**File:** `server/workflow-engine.ts:388–392`

Schema migration SQL statements are applied via `this.db.exec(sql)` in a loop without wrapping the entire migration batch in a transaction. If the server crashes mid-migration, the schema could be left in a partially-migrated state. This is a correctness/availability concern rather than a security issue.

---

## Secrets & Credentials Exposure

**No hardcoded credentials were found in production source files.**

The following credential-like strings were identified in test fixtures only, where they are intentional:

| File | Line(s) | Type | Notes |
|------|---------|------|-------|
| `server/workflow-routes.test.ts` | 62, 244 | Test bearer token, test webhook secret | Fixture values; not real secrets |
| `server/crypto-utils.test.ts` | 69–78 | Webhook HMAC secret | Test fixture only |

The `redactSecrets()` function in `server/crypto-utils.ts:9–30` strips Bearer tokens, Authorization headers, URL-embedded passwords, and common API-key patterns (`sk_`, `ghp_`, etc.) from all log output before it reaches the console or persistence layer.

No `.env` files, credential files, or secrets were found committed to git history (spot-checked via `git log --all --oneline`).

---

## Recommendations

Ordered by risk impact:

1. **[M1] Harden `buildListQuery` with column/order allowlists** — Add an explicit allowlist for column names and a regex guard for ORDER BY clauses. This prevents a latent SQL injection path from becoming exploitable as the codebase grows. (`server/workflow-engine.ts:286–299`)

2. **[M2] Resolve hostnames and verify IPs before Stepflow callbacks** — Replace the DNS-name-only SSRF check with post-resolution IP validation to close the DNS-rebinding window. Consider using `ssrf-req-filter` or an egress proxy. (`server/stepflow-handler.ts:411–460`)

3. **[M3] Implement auth token rotation** — Add support for a `NEW_AUTH_TOKEN` env variable with a configurable grace period, or derive tokens from a rolling secret. Document the rotation procedure. (`server/config.ts`)

4. **[L1] Scope hook-config tokens** — Write a purpose-scoped HMAC-derived token to `hook-config.json` instead of the master auth token, so compromise of that file does not grant full server access. (`server/commit-event-hooks.ts`)

5. **[L4] Fail fast on missing GitHub webhook secret** — Elevate the missing-secret warning to a fatal startup error (matching Stepflow behaviour) so misconfigured deployments are caught immediately. (`server/ws-server.ts:163`)

6. **[L3] Scope `TRUST_PROXY` to specific upstream IPs** — Set `app.set('trust proxy', '<nginx-ip>')` rather than `true` to prevent per-IP rate-limit bypass via `X-Forwarded-For` spoofing.

7. **[L2] Eliminate `style-src 'unsafe-inline'` in CSP** — Investigate whether TailwindCSS 4 CSS can be served as an external stylesheet, or use nonce/hash-based allowance. (`server/ws-server.ts:309`)

8. **[I3] Wrap schema migrations in a transaction** — Ensure `workflow-engine.ts` migration batches are atomic: open a transaction, apply all DDL, commit; roll back on any error. (`server/workflow-engine.ts:388–392`)

9. **[I1] Add runtime validation for `status` enum in workflow routes** — Check `status` against the set of valid `RunStatus` values before passing to the engine, and return HTTP 400 for invalid values. (`server/workflow-routes.ts:326`)

10. **Establish a dependency audit cadence** — Run `npm audit` (or `pnpm audit`) as part of CI and enforce a policy of resolving high/critical advisories within a defined SLA. No vulnerable packages were identified in this scan, but the project's dependency surface warrants ongoing monitoring.