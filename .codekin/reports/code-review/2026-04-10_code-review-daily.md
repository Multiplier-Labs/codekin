# Daily Code Review: codekin

**Date**: 2026-04-10T00:00:00.000Z
**Repository**: /srv/repos/codekin
**Branch**: chore/add-reports-2026-04-10
**Version**: 0.5.4

---

## Executive Summary

**Overall Assessment: GOOD**

The codebase is in solid shape. Active security auditing (weekly), zero known CVEs, strong TypeScript type safety, and 26 test files covering critical paths. Two medium-severity findings from the 2026-04-09 security audit remain open; both are straightforward to fix.

**Last 7 days:** 22 commits across security fixes, session lifecycle refactor, worktree stability improvements, and housekeeping.

---

## CRITICAL

None identified.

---

## HIGH

None identified.

---

## MEDIUM

### M1 — Unsanitized HTML in ChatView code block highlighting
**File**: `src/components/ChatView.tsx` ~line 184  
**Issue**: `highlightCode()` output is passed directly to `dangerouslySetInnerHTML` without DOMPurify sanitization. `MarkdownRenderer.tsx:41` correctly sanitizes markdown HTML — ChatView should do the same.  
**Risk**: Low in practice (highlight.js output is safe), but inconsistent defense posture; elevates if hljs is ever compromised.  
**Fix**:
```typescript
dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(highlightCode(codeString, match[1])) }}
```
**Status**: Carried over from 2026-04-09 security audit (M1); not yet fixed.

---

### M2 — CORS misconfiguration warning is non-fatal in production
**File**: `server/config.ts` lines 30–31  
**Issue**: When `NODE_ENV=production` and `CORS_ORIGIN` contains "localhost", the server logs an error but continues. Webhook secret misconfiguration correctly calls `process.exit(1)`; CORS should do the same.  
**Risk**: Misconfigured prod deployment could expose CSRF attack surface.  
**Fix**:
```typescript
if (process.env.NODE_ENV === 'production' && (!CORS_ORIGIN || CORS_ORIGIN.includes('localhost'))) {
  console.error('[config] FATAL: CORS_ORIGIN must be a production HTTPS origin.')
  process.exit(1)
}
```
**Status**: Carried over from 2026-04-09 security audit (M2); not yet fixed.

---

## WARNING

### W1 — No webhook timestamp validation
**Files**: `server/webhook-handler.ts:137`, `server/stepflow-handler.ts`  
**Issue**: Webhooks are HMAC-verified and deduplicated by ID, but event timestamps are not validated. A captured signed payload could be replayed once the dedup window expires.  
**Fix**: Reject payloads where `created_at` is more than 5 minutes old.  
**Status**: Documented in 2026-04-09 audit (L3); low practical risk.

### W2 — CSP allows `unsafe-inline` for styles
**File**: `server/ws-server.ts:275` (CSP header)  
**Issue**: `style-src 'self' 'unsafe-inline'` weakens CSP; CSS injection can enable UI redressing or data exfiltration combined with HTML injection.  
**Fix**: Eliminate via nonce injection (Vite plugin) or extract all inline styles to static CSS.  
**Status**: Longer-term fix; documented in 2026-04-09 audit (L2).

### W3 — No CI-time `npm audit`
**Issue**: No CI step enforces `npm audit --audit-level=high`. Currently clean, but a supply-chain vulnerability would not block builds.  
**Fix**: Add audit step to CI pipeline.

### W4 — `useEffect` missing dependency array in useChatSocket
**File**: `src/hooks/useChatSocket.ts:165–167`  
**Issue**: An effect that assigns to a ref has no dependency array, causing it to run on every render. Currently benign (ref assignment only), but poor practice.  
**Fix**: Add `[]` dependency array or move the assignment outside the effect.

---

## INFO

### I1 — Zero known CVEs
`npm audit` clean on both root and `server/` packages. No action needed; recommend adding to CI (see W3).

### I2 — No shell injection vectors
All subprocess calls use `execFile()` with argument arrays. No `spawn(shell: true)` anywhere in server code.

### I3 — DOMPurify correctly applied in MarkdownRenderer
`MarkdownRenderer.tsx:41` sanitizes all rendered markdown. The M1 finding in ChatView is the only exception.

### I4 — Session state complexity
`server/session-manager.ts` session objects carry 40+ fields (timers, flags, pending maps). All timer handles are cleaned up in `shutdown()`. No leak detected, but discipline required in every exit path. The 2026-04-07 refactor extracting `session-lifecycle.ts` helps maintainability here.

### I5 — Approval registry has no eviction policy
`ApprovalManager.repoApprovals` (in-memory Map) grows with each new working directory used. No LRU or TTL eviction. Practical risk is minimal for typical deployments (<100 repos), but worth tracking.

### I6 — Auth token correctly stripped from child process env
`server/claude-process.ts:179–190` strips `AUTH_TOKEN`, `ANTHROPIC_API_KEY`, and `CLAUDE_CODE_API_KEY` from the environment inherited by Claude child processes. Appears correct; verify list is kept current as new env vars are added.

---

## Recent Changes (Last 7 Days)

| Commit | Summary | Quality |
|--------|---------|---------|
| `f413798` | Strip uninformative agent noise lines from chat display | Clean, minimal |
| `3e7d70d` | Address security audit findings M1/M2/L4 | Partial; M1 XSS fix still pending |
| `472d93d` | Extract session lifecycle into `session-lifecycle.ts` | Well-structured refactor |
| `c022112` | Use `git show-ref` for branch detection, prevent accidental deletion | Good safety improvement |
| `a32481a` | Add unit tests for session restart and worktree fixes | 529 lines, covers edge cases |
| `bd3a0cc` | Merge security audit fixes (PR #311) | — |
| `25a8cbc` | Merge housekeeping PR #312 | — |

---

## Security Posture Summary

| Category | Status | Notes |
|----------|--------|-------|
| Authentication | ✅ Good | Timing-safe comparison, rate limiting, session-scoped tokens |
| Authorization | ✅ Good | Path bounds-check, model/permmode whitelist validation |
| Injection | ✅ Good | No `shell: true` anywhere; DOMPurify applied (except ChatView highlight) |
| CSRF | ⚠️ OK | Bearer token auth prevents CSRF; needs docs note for future cookie work |
| Secrets | ✅ Good | No hardcoded secrets; hook config `0o600` perms |
| Dependencies | ✅ Good | 0 CVEs, locked versions |
| Logging | ⚠️ Fair | Console only; recommend structured logging for security events |

---

## Recommendations (Prioritized)

**Before next production deployment:**
1. Fix M1 — add `DOMPurify.sanitize()` in `ChatView.tsx` (~5 min)
2. Fix M2 — escalate CORS check to `process.exit(1)` in `config.ts` (~2 min)

**Next 2 weeks:**
3. Add webhook timestamp validation — reject payloads >5 min old (`webhook-handler.ts`)
4. Add `npm audit --audit-level=high` to CI pipeline
5. Fix `useEffect` dependency array in `useChatSocket.ts:165`

**Next quarter:**
6. Eliminate CSP `unsafe-inline` for styles
7. Add structured security event logging (auth failures, rate-limit breaches)
8. Approval registry eviction policy
9. WebSocket error handling test coverage
