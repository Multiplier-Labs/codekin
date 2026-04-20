# Daily Code Review: codekin

**Date**: 2026-04-19T04:06:37.469Z
**Repository**: /srv/repos/codekin
**Branch**: docs/audit-reports-2026-04-18
**Workflow Run**: 50088af0-cbd5-47a5-b48b-1f5a92a4dda8
**Session**: 377d5ff7-4a14-4387-806a-8db1f8b636ec

---

Completed. I reviewed structure/architecture, last 7 days of git history, and critical server/frontend paths.

I also saved the full daily review here:

```text
.codekin/reports/code-review/2026-04-19_code-review-daily.md
```

## Project structure & architecture (quick assessment)

- **Frontend**: `src/` (React + Vite + Tailwind), hook-centric state management, websocket-driven chat/session UX.
- **Backend**: `server/ws-server.ts` is the integration hub (REST + WS + webhooks + workflows + orchestrator).
- **Session runtime**: `SessionManager` + `SessionLifecycle` manage Claude/OpenCode process orchestration, approvals, persistence, and restart logic.
- **General quality**: strong modularization trend (recent router decomposition, lifecycle refactors), strict TS/lint posture, good test depth.

## Last 7 days of git activity (high-level)

Recent commits are heavily concentrated on:
- session lifecycle stability/race-condition fixes
- security hardening (symlink/path traversal, rate-limiter caps, JSON injection prevention)
- orchestrator/workflow route decomposition
- OpenCode model/session behavior fixes
- regular automated report generation

---

## Findings by severity

### Critical
- **None found** in this review window.

### Warning

1. **Synchronous filesystem scans in docs routes can block event loop under load**  
   - **File**: `server/docs-routes.ts`  
   - **Lines**: `40-71`, `92-137`, `144-186`  
   - **Risk**: recursive `readdirSync/statSync/readFileSync` on request path can stall server responsiveness for large repos/concurrent users.  
   - **Action**: move to async FS, add TTL cache and result caps.

2. **`/api/repos` scales latency linearly with org count due to serial gh calls**  
   - **File**: `server/upload-routes.ts`  
   - **Lines**: `231-253`, `246-248`  
   - **Risk**: slow response tails from sequential external CLI/network calls.  
   - **Action**: bounded parallel fetch (`Promise.allSettled` + concurrency limit), timeout + partial-result strategy.

3. **Hook config parsing is brittle (grep/sed over JSON)**  
   - **File**: `server/commit-event-hook.sh`  
   - **Lines**: `21-23`  
   - **Risk**: escaped chars/format changes can silently break token/url extraction.  
   - **Action**: prefer `jq -r` parsing (or switch config format to shell-safe key/value).

4. **CSP connect-src is broader than needed**  
   - **File**: `server/ws-server.ts`  
   - **Line**: `309`  
   - **Risk**: `connect-src 'self' wss: ws:` allows WS connections to any ws/wss origin.  
   - **Action**: narrow to `'self'` (+ explicit allowed origin(s) only).

5. **Missing direct tests for critical route modules**  
   - **Files lacking dedicated tests**:
     - `server/auth-routes.ts`
     - `server/session-routes.ts`
     - `server/docs-routes.ts`
     - `server/upload-routes.ts`
     - `server/orchestrator-session-router.ts`  
   - **Risk**: auth/path-boundary regressions may slip through via indirect coverage only.  
   - **Action**: add focused route-level tests for auth failure paths, traversal checks, malformed payloads, and rate limiting.

### Info

- `npm test` passed: **60 files / 1639 tests**.
- `npm audit` reports **0 vulnerabilities** (prod + dev).
- Security hardening velocity is strong in recent commits.
- Minor maintainability risk: duplicated root/server dependency manifests can drift over time (`package.json` vs `server/package.json`).

---

If you want, I can do the next pass as a **fix plan** (small PR-sized tasks, ordered by risk/effort).