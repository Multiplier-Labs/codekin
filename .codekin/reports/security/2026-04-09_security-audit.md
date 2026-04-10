# Security Audit: codekin

**Date**: 2026-04-09T03:35:13.102Z
**Repository**: /srv/repos/codekin
**Branch**: main
**Workflow Run**: c15b7587-9655-4eee-a285-a0eea584093f
**Session**: 22f52c85-3655-4474-880b-937c467c7eb5

---

Now I have enough data to produce the complete, structured security report.

## Security Audit Report — Codekin
**Date:** 2026-04-09 | **Auditor:** Automated Security Audit | **Branch:** `main` (472d93d)

---

## Summary

**Overall Risk Rating: Low**

No critical or high-severity vulnerabilities were found. The codebase demonstrates defence-in-depth: timing-safe authentication, parameterised SQL, path-boundary validation, HMAC-verified webhooks, DOMPurify XSS protection, and multi-layer rate limiting. All known-vulnerability checks (`npm audit`) returned zero findings.

| Severity | Count |
|----------|-------|
| Critical | 0 |
| High | 0 |
| Medium | 2 |
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

### M1 — `dangerouslySetInnerHTML` with Unsanitised `hljs` Output

**File:** `src/components/ChatView.tsx:184`

**Description:** The `highlightCode()` function at line 152 passes the output of `hljs.highlight()` directly into `dangerouslySetInnerHTML` without routing it through DOMPurify. By contrast, `src/components/MarkdownRenderer.tsx:41` correctly applies `DOMPurify.sanitize()` before any HTML injection. While `highlight.js` is widely trusted to produce safe output by HTML-entity-escaping code content, this creates an inconsistency: defence against a hypothetical hljs regression or supply-chain issue depends entirely on that library's internal escaping rather than an explicit sanitisation layer.

**Impact:** If hljs ever emitted unsanitised HTML (e.g., via a vulnerability or malicious update), code blocks in assistant messages could deliver stored XSS to the browser.

**Remediation:** Wrap the `highlightCode` return value with `DOMPurify.sanitize()` before assigning to `dangerouslySetInnerHTML`:

```typescript
dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(highlightCode(codeString, match[1])) }}
```

---

### M2 — CORS Misconfiguration Produces Warning, Not Fatal Error, on `localhost` in Production

**File:** `server/config.ts:30-31`

**Description:** When `NODE_ENV=production` and `CORS_ORIGIN` contains `"localhost"`, the server emits `console.warn` but continues running. The equivalent check for an *unset* `CORS_ORIGIN` in production only logs an error (line 26) but also does not exit. Compare with `GITHUB_WEBHOOK_SECRET` and `STEPFLOW_WEBHOOK_SECRET`, which call `process.exit(1)` when absent — a stricter and safer pattern.

**Impact:** A misconfigured deployment could allow cross-origin requests from any page hosted on the same `localhost` machine. In a shared-host or developer-machine scenario, this could permit CSRF-style attacks or session hijacking by other locally hosted services.

**Remediation:** Escalate the production `CORS_ORIGIN` check to `process.exit(1)` consistent with webhook secrets:

```typescript
if (process.env.NODE_ENV === 'production' && (!process.env.CORS_ORIGIN || CORS_ORIGIN.includes('localhost'))) {
  console.error('[config] FATAL: CORS_ORIGIN must be set to a production HTTPS origin.')
  process.exit(1)
}
```

---

## Low Findings

### L1 — No CSRF Protection on State-Changing REST Endpoints

**Files:** `server/session-routes.ts`, `server/orchestrator-routes.ts`, `server/upload-routes.ts`

**Description:** All `POST`/`DELETE` REST endpoints rely solely on a Bearer token passed in the `Authorization` header for authentication. While this is effectively CSRF-safe for XHR/fetch clients (browsers will not auto-attach `Authorization` headers via HTML form submissions), there is no explicit CSRF token or `SameSite` cookie guard. If the application ever migrates to cookie-based auth, all endpoints would become CSRF-vulnerable without additional changes.

**Impact:** Currently low: Bearer token auth prevents CSRF. Risk elevates to high if cookie-based auth is introduced.

**Remediation:** Document the assumption that auth must remain header-based, or add CSRF token validation now as a hedge. At minimum, ensure `SameSite=Strict` is set on any future session cookies.

---

### L2 — `Content-Security-Policy` Allows `'unsafe-inline'` for Styles

**File:** `server/ws-server.ts:275` (CSP header)

**Description:** The CSP includes `style-src 'self' 'unsafe-inline' https://fonts.googleapis.com`. The `'unsafe-inline'` directive for styles weakens the CSP by permitting injected `style` attributes, which can be used in some XSS attack chains (e.g., CSS-based data exfiltration or UI redressing).

**Impact:** Low in isolation. Combined with an HTML injection, allows CSS injection attacks.

**Remediation:** Prefer nonce-based or hash-based style allowlisting, or extract inline styles to static CSS files. For Vite-built output this may require a build-time nonce injection plugin.

---

### L3 — No Webhook Replay Protection via Timestamp Validation

**Files:** `server/webhook-handler.ts`, `server/stepflow-handler.ts`

**Description:** GitHub and Stepflow webhooks are HMAC-verified and deduplicated by webhook ID (preventing exact-replay of identical payloads). However, there is no validation of the event timestamp. An attacker who intercepts a valid signed webhook payload could replay it after an arbitrarily long delay, as long as the webhook ID had aged out of the deduplication window.

**Impact:** Low: requires network interception of HTTPS traffic and knowledge of the webhook ID rotation. Impact is limited to triggering already-processed webhook actions again.

**Remediation:** Validate that the `X-GitHub-Event` delivery timestamp (or a `timestamp` field in Stepflow payloads) is within an acceptable window (e.g., ±5 minutes). Reject stale payloads.

---

### L4 — Auth Token Written to Hook Config File Readable by Child Processes

**File:** `server/commit-event-hooks.ts:46-51`

**Description:** When git commit hooks are installed, a session-scoped HMAC-derived auth token is written to `~/.codekin/hook-config.json` with `0o600` permissions. This is appropriate. However, the Claude child process running in each session inherits the environment, which includes the master `AUTH_TOKEN` (via `claude-process.ts:119`). If a malicious or compromised tool call exfiltrates the environment, the master token is exposed.

**Impact:** Low: Claude processes are trusted by design and the token is scoped per session via HMAC derivation. The architecture is correct; this is a residual risk acknowledgement.

**Remediation:** Verify that `claude-process.ts` passes only the session-scoped token (not the master token) as the child's `AUTH_TOKEN` environment variable. If the master token is currently passed, replace it with the HMAC-derived session token.

---

## Secrets & Credentials Exposure

**Git log scan (20 most recent commits):** No credentials committed. All commit messages are functional, no accidental secret exposure found.

**`git grep` scan of `*.ts`, `*.js`, `*.json`, `*.yaml`, `*.env`:** No hardcoded secret values found. All findings were references to token-handling *functions* or environment variable *names* (e.g., `process.env.AUTH_TOKEN`, `process.env.GITHUB_WEBHOOK_SECRET`) — not literal values.

**`.env` files:** None committed. `.env` and `.env.*` are correctly listed in `.gitignore`.

**Config files committed to repo:** No sensitive values. `settings.json` is gitignored (`.codekin/settings.json` in `.gitignore`).

**Sensitive files with appropriate `0o600` permissions:**
- `~/.codekin/session-archive.db`
- `~/.codekin/hook-config.json`
- `~/.codekin/workflow-config.json`

No actual secret values were found anywhere in the scanned source. No redaction required.

---

## Informational Findings

### I1 — `npm audit` Reports Zero Vulnerabilities

All direct and transitive dependencies are free from known CVEs as of audit date. No action required; schedule re-auditing on a regular cadence (see Recommendations).

### I2 — `exec()` / Shell Execution Not Used in Server Code

A full scan of `server/**/*.ts` found no use of `exec()`, `execSync()`, or `spawn()` with `shell: true`. All subprocess invocations use `execFile()` with argument arrays, preventing shell injection. Use of `db.exec()` is for SQLite DDL statements only (schema creation), not user input.

### I3 — `marked` Library Used Without Version Pin

`marked` is listed as a dependency for Markdown parsing. The library has had historical XSS issues in older versions. The current use is safe because DOMPurify sanitises its output in `MarkdownRenderer.tsx`, but the `ChatView.tsx` path uses `react-markdown` (which parses internally), not `marked` directly.

---

## Recommendations

Ordered by risk impact:

1. **[M1 — Fix immediately]** Add `DOMPurify.sanitize()` around `highlightCode()` output in `src/components/ChatView.tsx:184` to make XSS protection consistent across all HTML injection points.

2. **[M2 — Fix before next production deployment]** Escalate the `CORS_ORIGIN` localhost-in-production check from `console.warn` to `process.exit(1)` in `server/config.ts:30-31`, matching the severity enforcement already applied to webhook secrets.

3. **[L4 — Verify and fix if needed]** Audit `server/claude-process.ts` to confirm that child Claude processes receive only the session-scoped HMAC token, not the master `AUTH_TOKEN`. If the master token is in the child's environment, replace it with the derived token.

4. **[L3 — Medium-term]** Add timestamp validation to webhook handlers (`server/webhook-handler.ts`, `server/stepflow-handler.ts`): reject payloads whose delivery timestamp is more than 5 minutes old to prevent delayed replay attacks.

5. **[L1 — Document now]** Formally document (in `CLAUDE.md` or `docs/`) that the security model assumes header-based Bearer token auth and must never be migrated to cookies without adding CSRF protection. This prevents inadvertent CSRF exposure in future refactors.

6. **[L2 — Longer term]** Eliminate `'unsafe-inline'` from the `style-src` CSP directive. Use a Vite build plugin to inject CSP nonces, or move all inline styles to static CSS files.

7. **[Operational]** Add `npm audit --audit-level=high` as a required CI step and fail the build on high/critical findings. Schedule weekly automated dependency audits.

8. **[Operational]** Pin `highlight.js` and other HTML-outputting libraries to exact versions in `package.json` and use `package-lock.json` integrity verification in CI, reducing supply-chain risk.

9. **[Operational]** Add structured security event logging (authentication failures, rate-limit breaches, HMAC verification failures) to a persistent log sink for incident response. Current console output is ephemeral.

10. **[Operational]** Implement a documented AUTH_TOKEN rotation procedure and test it. The CLI already supports `codekin setup --regenerate`; ensure the procedure for updating all dependent hook config files is scripted and tested.PR created: Multiplier-Labs/codekin#310 — the two report files are committed and pushed on branch `chore/add-reports-2026-04-09`.