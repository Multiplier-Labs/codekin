# Daily Code Review: codekin

**Date**: 2026-04-07T04:04:07.678Z
**Repository**: /srv/repos/codekin
**Branch**: chore/reports-2026-04-07
**Workflow Run**: af0a72c2-5f3c-4557-aea7-87fdf736c423
**Session**: c887328b-15ac-4de5-b1a7-76534630bbcf

---

Now let me read the current report file to update it with the findings.The existing report has leftover junk text. Let me rewrite it cleanly with today's review findings.---

## Code Review — 2026-04-07

**Overall: Good — no critical vulnerabilities. Three high-priority reliability issues need fixes.**

---

### Warning (4 issues requiring fixes)

**W-01 — Memory leak: WS rate-limiter Map** (`server/ws-server.ts` ~370–381)
The `wsConnections` Map has no size cap. Under sustained load, expired entries accumulate faster than the 60s cleanup interval. Add a max-size guard before inserting.

**W-02 — Race condition: API retry timers** (`server/session-manager.ts` ~520+)
Multiple error paths can each schedule a retry independently, leaking timers. Gate on a `retryScheduled` boolean or replace with a promise queue.

**W-03 — Silent failure: worktree cleanup** (`server/session-manager.ts` ~407–431)
`void (async () => {})()` swallows cleanup errors — no log, no retry, no queue. Git worktrees accumulate silently on failure.

**W-04 — Path traversal: symlink bypass** (`server/ws-message-handler.ts` ~31–44)
When `realpathSync()` fails, the fallback uses `pathResolve()` which doesn't follow symlinks. A symlink inside an allowed dir pointing outside can bypass the `startsWith()` check. Remove the fallback entirely.

**W-05 — Hard-coded 60s Claude startup timeout** (`server/claude-process.ts` ~212–220)
Fails on slow hosts (cold-start VMs, NFS). Make configurable via `CLAUDE_STARTUP_TIMEOUT_MS`.

---

### Info (minor)

- **I-01**: `PermissionMode` defined independently in frontend and server — drift risk (`src/types.ts:51`)
- **I-02**: Session output buffers (2000 msg × 100 sessions ≈ 200 MB) — no archival strategy
- **I-03**: SQL WHERE clauses in `server/orchestrator-memory.ts` use mixed string concatenation + params — safe now, but fragile pattern
- **I-04**: ESLint `ecmaVersion: 2020` vs TypeScript target ES2022 — one-line fix in `eslint.config.js`

---

### Security posture: strong
Timing-safe token compare, HMAC-SHA256 session tokens, fail-closed auth, DOMPurify XSS protection, parameterized SQL, rate limiting, WS auth timeout — all verified good.

Report written to `.codekin/reports/repo-health/2026-04-07_repo-health.md`.