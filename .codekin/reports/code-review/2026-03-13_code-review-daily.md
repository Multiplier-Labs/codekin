# Daily Code Review: codekin

**Date**: 2026-03-13T05:02:12.442Z
**Repository**: /srv/repos/codekin
**Branch**: docs/comment-audit-fixes
**Workflow Run**: 9b7364dc-e087-4a98-aea3-748c4373ed21
**Session**: b112f1fe-2111-44d8-ac65-e7bae0eac5c4

---

## Daily Code Review — 2026-03-13

### Overview
- **Branch**: `docs/comment-audit-fixes` | **Version**: v0.3.7
- **Tests**: 947 passing | **Codebase**: ~24,500 lines TS/TSX
- **Overall Risk**: LOW-MEDIUM

---

## Critical

### 1. SSRF in Stepflow Callback URL
**`server/stepflow-handler.ts:384-395`**

Callback URLs from webhook payloads are passed directly to `fetch()` without validation. An attacker controlling the webhook could target internal services (e.g., `http://169.254.169.254`, `http://localhost:8080`).

The test file at `server/stepflow-handler.test.ts:362-374` explicitly documents this gap with a comment: *"This test documents the gap: the request reaches fetch instead of being rejected."*

**Fix**: Validate callback URLs against an allowlist (HTTPS + known domains) before fetching.

---

## Warnings

### 2. Workspace Path Traversal Risk
**`server/webhook-workspace.ts:39`**

Mirror path construction: `join(REPOS_DIR, \`${repo}.git\`)` uses the repo name without explicit `path.resolve()` + boundary check. The format validation in webhook handlers (`owner/name`) partially mitigates this, but no explicit escape detection exists.

**Fix**: Add `path.resolve()` and verify result starts with `REPOS_DIR`.

### 3. Token Redaction Gaps
**`server/crypto-utils.ts:13-26`**

The `redactSecrets()` regex patterns may miss edge-case token formats (Bearer tokens with special characters, non-standard URL-embedded credentials).

**Fix**: Expand patterns or adopt a dedicated redaction library.

### 4. 502 ESLint Warnings — Type Safety Debt
183 `@typescript-eslint/no-unsafe-*` warnings concentrated in:
- `src/components/ChatView.tsx` (59 warnings)
- `src/hooks/useChatSocket.ts` (35 warnings)
- `src/lib/workflowApi.ts` (27 warnings)

These represent `any` type proliferation in API response handling, increasing runtime error risk.

**Fix**: Enable `strict: true` in `tsconfig.json` and incrementally type API responses.

---

## Info

### 5. Missing SSRF Tests
No unit tests cover callback URL rejection — only a comment documenting the known gap. Tracking issue should be filed.

### 6. SQLite/Session File Permissions
Session data files (`~/.codekin/sessions.json`) may contain sensitive tokens. No code enforces `0600` permissions at write time. Should be documented or enforced.

### 7. Generic Error Codes in Webhook Handler
**`server/webhook-handler.ts:97-150`** — Some failure paths return the same 401/503 status for distinct conditions (gh CLI unavailable vs. auth failed vs. disabled). Makes debugging harder.

### 8. Dead Condition
**`src/lib/deriveActivityLabel.ts:16`** — A variable is always truthy; the condition is unreachable. Minor cleanup item.

---

## What Looks Good

- **Auth**: Timing-safe token comparison via `crypto.timingSafeEqual()` throughout
- **Rate limiting**: Connection (30/min), message (60/sec), and webhook limits all in place
- **XSS**: `DOMPurify.sanitize()` properly wrapping all markdown rendering
- **Security headers**: CSP, HSTS, X-Frame-Options, X-Content-Type-Options in production
- **Input validation**: Clone/upload endpoints validate owner/name format before use
- **No SQL injection**: Parameterized queries used consistently

---

## Priority Action Items

| Priority | Item |
|----------|------|
| **Critical** | Whitelist/validate callback URLs in `stepflow-handler.ts` before `fetch()` |
| **High** | Add `path.resolve()` boundary check in `webhook-workspace.ts:39` |
| **High** | File tracking issue for SSRF test gap in `stepflow-handler.test.ts` |
| **Medium** | Harden token redaction regex in `crypto-utils.ts` |
| **Low** | Address type-safety lint warnings in `ChatView.tsx`, `useChatSocket.ts`, `workflowApi.ts` |
| **Low** | Enforce `0600` file permissions on session/SQLite files at write time |