# Daily Code Review: codekin

**Date**: 2026-04-08
**Branch**: chore/workflow-reports-2026-04-07
**Reviewer**: Automated (Claude Sonnet 4.6)
**Commit range**: Last 7 days (since 2026-04-01)

---

## Overall Assessment: EXCELLENT

No blocking issues. All critical findings from the prior audit have been resolved in commit `9c7eb52`. The codebase demonstrates consistent fail-closed security patterns, multi-layer rate limiting, timing-safe crypto, and strong test coverage.

---

## CRITICAL

_No critical issues found._

All previously identified critical issues were fixed in `9c7eb52` (2026-04-07).

---

## WARNING

### W-1: WebSocket rate-limiter map bounded but edge-case rejection behavior

**File**: `server/ws-server.ts` — rate limit map logic  
**Commit**: Fixed in `9c7eb52`  
**Status**: Fixed — operational note remains

The 10,000-IP cap (`WS_RATE_MAP_MAX_SIZE`) was added to prevent unbounded memory growth. Under aggressive distributed attacks, all new source IPs are rejected when the map is full. This is intentional fail-closed behavior but may affect legitimate users in a scenario with many NAT-ed clients behind rotating IPs.

**Recommendation**: If deployed behind nginx, add `limit_conn` at the nginx layer to handle this at the edge before it reaches the Node.js process.

---

### W-2: Documentation gaps — API reference and protocol spec are stale

**Files**: `docs/API-REFERENCE.md`, `docs/stream-json-protocol.md`, `docs/ORCHESTRATOR-SPEC.md`  
**Severity**: WARNING (developer experience)

- `docs/API-REFERENCE.md`: Documents `POST /api/tool-approval` which routes via WebSocket, not REST. Also missing the 15+ `/api/workflows/*` endpoints added in recent sprints.
- `docs/stream-json-protocol.md`: Last updated March 16; approvals architecture overhauled April 3.
- `docs/ORCHESTRATOR-SPEC.md`: Session lifecycle changes from April 3–5 not reflected.

**Recommendation**: Backlog tickets for each doc file. None block production.

---

## INFO

### I-1: Path traversal fix — now fail-closed (fixed in 9c7eb52)

**File**: `server/ws-message-handler.ts` lines 36–42

Previously, when `fsRealpathSync()` threw (non-existent or inaccessible path), code fell back to `pathResolve()` which does not follow symlinks — enabling potential symlink-based traversal. Fix sends an error message and breaks rather than falling through. Correct.

### I-2: Authentication is timing-safe and fail-closed

**File**: `server/ws-server.ts` lines 80–87

`verifyToken()` returns `false` when no token is configured, uses `timingSafeEqual` after SHA-256 hashing both inputs to fixed length. No timing oracle possible.

### I-3: Multi-layer rate limiting in place

Five distinct rate-limiting layers:
1. WebSocket per-IP connection rate (30/60s)
2. WebSocket per-client message rate (60/s)
3. GitHub webhook per-repo
4. Stepflow webhook per-workflow-kind
5. Auth endpoint per-IP (10/min)

### I-4: Webhook secrets enforced at startup

**File**: `server/ws-server.ts` lines 166–194

Server calls `process.exit(1)` if `GITHUB_WEBHOOK_ENABLED` or `STEPFLOW_WEBHOOK_SECRET` are set without their corresponding secret. Proper fail-fast pattern.

### I-5: XSS protection via DOMPurify

**File**: `src/components/MarkdownRenderer.tsx`

All markdown content passes through `DOMPurify.sanitize()` before being set via `dangerouslySetInnerHTML`. Memoized correctly to avoid redundant sanitization passes.

### I-6: Vite CVE overrides applied (9c7eb52)

**File**: `server/package.json` overrides block

Transitive `vite@7.3.1` (CVEs: GHSA-4w7w-66w2-5vf9, GHSA-v2wj-q39q-566r, GHSA-p9ff-h696-f583) pinned to `^8.0.5` via overrides. Root `package.json` pinned to match.

### I-7: Worktree cleanup now retries on failure (9c7eb52)

**File**: `server/session-manager.ts` cleanup logic

Previously silent on error. Now logs warnings, retries once after 3s, then logs a full error. Orphaned worktrees will surface in logs instead of accumulating silently.

### I-8: API retry race condition guarded (9c7eb52)

**File**: `server/session-manager.ts` `handleApiRetry()`

`_apiRetryScheduled` flag set before timer creation, cleared after firing. Prevents duplicate retry timers from concurrent error paths.

### I-9: ESLint ecmaVersion aligned with TypeScript target (9c7eb52)

**File**: `eslint.config.js`

Bumped from `ecmaVersion: 2020` to `ecmaVersion: 2022` to match `tsconfig.json` `ES2022` target. ES2021+ syntax like `Promise.any()` and `Object.hasOwn()` will now be linted correctly.

### I-10: Stale `.d.ts` artifacts in server/dist/

**Files**: `server/dist/` — approximately 10 `.d.ts` files from the shepherd→orchestrator rename

These are build artifacts and are gitignored, so they don't ship. However they may confuse IDE type resolution in the server directory. A `rm -rf server/dist` followed by rebuild clears them.

---

## Dependency Audit

| Package | Version | License | Notes |
|---------|---------|---------|-------|
| express | ^5.1.0 | MIT | Stable, maintained |
| ws | ^8.18.0 | MIT | Stable |
| better-sqlite3 | ^12.6.2 | MIT | Parameterized queries only — no injection risk |
| multer | ^2.0.0 | MIT | File upload, validation applied |
| dompurify | current | MPL-2.0 / Apache-2.0 | Dual-licensed, bundled |
| lightningcss | transitive | MPL-2.0 | Build-time only, not distributed |

No GPL/AGPL licenses in distributed code. No unresolved high-severity CVEs.

---

## Security Checklist

| Control | Status | Notes |
|---------|--------|-------|
| Authentication | PASS | Timing-safe token verification |
| Path traversal | PASS | Fail-closed symlink resolution |
| XSS | PASS | DOMPurify + hljs |
| CSRF | PASS | Token-based, no session cookies |
| Rate limiting | PASS | 5 layers |
| Secrets at startup | PASS | Fatal on missing webhook secrets |
| Dependency CVEs | PASS | Vite pinned, no high-severity open |
| SQL injection | PASS | Parameterized queries only |
| Error info leakage | PASS | Stack traces suppressed in production |

---

## Test Coverage

- 497 test files total
- Strong coverage: session lifecycle, webhook handling, crypto utilities, diff operations, workflow engine
- No obvious gaps in critical paths identified
