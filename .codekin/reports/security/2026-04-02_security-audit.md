# Security Audit: codekin

**Date**: 2026-04-02T03:38:12.746Z
**Repository**: /srv/repos/codekin
**Branch**: chore/reports-2026-04-01
**Workflow Run**: 4f24c617-5f6d-4487-a0cd-ee679ebcaf2d
**Session**: 352672fc-1f55-452a-9366-a6fca4b7de1a

---

Now I have all the data I need. Let me write the report.# Security Audit: codekin — 2026-04-02

**Overall Risk Rating: Low–Medium — 0 Critical, 0 High, 3 Medium, 5 Low**

---

## Summary

The codebase has strong security fundamentals. No new critical or high-severity issues were found. The three medium issues from the March 26 audit are unaddressed, and one new low-severity issue was identified (file upload MIME bypass).

| Severity | Count | Notes |
|----------|-------|-------|
| Critical | 0 | — |
| High | 0 | — |
| Medium | 3 | All carried forward from March 26 |
| Low | 5 | 4 carried forward + 1 new |

---

## Medium Findings

**M1 — Unauthenticated Server Start is Warn-Only** (`server/ws-server.ts:71`)  
Missing `AUTH_TOKEN` prints a warning and continues — all endpoints become public in a misconfigured deployment. Fix: `process.exit(1)` in production when no token is set, matching the existing `CORS_ORIGIN` guard.

**M2 — Stepflow Enabled Without Secret Silently Rejects All Webhooks** (`server/ws-server.ts:167`)  
`verifySignature()` returns `false` when no secret is set (fail-secure), but the integration appears active while silently dropping all events. Fix: exit at startup like the GitHub webhook path does.

**M3 — Tool I/O Debug Logs Not Gated by NODE_ENV** (`server/claude-process.ts`, 12 call sites)  
Tool names, input params, and result content are logged unconditionally to stdout, sending user repository data into production log pipelines. Fix: gate on `NODE_ENV !== 'production'`.

---

## Low Findings

**L1 — `workingDir` Not Validated at Session Creation** (`server/session-routes.ts:60`)  
`POST /api/sessions/create` skips the `realpathSync`/`allowedRoots` check that the browse endpoint enforces — authenticated users can spawn Claude outside designated repo dirs.

**L2 — Auth Token Accepted via Request Body** (`server/ws-server.ts:105`)  
Legacy `req.body.token` fallback; token values can appear in proxy/access logs.

**L3 — CSP `style-src 'unsafe-inline'`** (`server/ws-server.ts:248`)  
Required by TailwindCSS 4 inline styles; investigate nonce/hash-based alternative.

**L4 — Hook Config Stores Master Auth Token** (`server/commit-event-hooks.ts:49–55`)  
`~/.codekin/hook-config.json` holds the full master token (0600 perms). Use `deriveSessionToken()` for a scoped hook token instead.

**L5 (new) — File Upload MIME Type Bypassable** (`server/upload-routes.ts:169–178`)  
`fileFilter` uses client-supplied `Content-Type` and allows extension OR MIME (`||`). A `.md` filename bypasses all MIME checking. Fix: magic-byte validation + `&&` logic.

---

## Secrets & Credentials

No hardcoded secrets or committed credentials found. All credentials are read from environment variables only.

---

Report saved to `.codekin/reports/security/2026-04-02_security-audit.md`.Both report files committed and pushed to `chore/reports-2026-04-01`.