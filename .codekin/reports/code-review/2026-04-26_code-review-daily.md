# Daily Code Review: codekin

**Date**: 2026-04-26T04:02:17.853Z
**Repository**: /srv/repos/codekin
**Branch**: docs/audit-reports-2026-04-18
**Workflow Run**: 11805a0e-5759-4fab-9dfa-1662bdc67c61
**Session**: a05df34a-2340-446a-9dca-1027a9e2ccac

---

Completed. I reviewed structure/architecture, last 7 days of git history, and deep-inspected critical backend files.

I also saved the full report to:

`/.codekin/reports/code-review/2026-04-26_code-review-daily.md`

## Architecture & project structure (quick read)
- Clear split: React/Vite frontend (`src/`) + Node/Express/WebSocket backend (`server/`).
- Core runtime is centralized in `server/ws-server.ts`, with good modularization via dedicated routers and managers (`SessionManager`, `SessionLifecycle`, `PromptRouter`, `WebhookHandler`, etc.).
- Overall architecture is coherent and maintainable, though `ws-server.ts` is still a high-complexity hotspot.

## Last 7 days of git activity
- Recent commits are almost entirely report/doc updates under `.codekin/reports/**`.
- No substantial production code changes in this window.
- Meaning: current risk mostly comes from existing behavior, not recent regressions.

## Findings by severity

### Critical
- **None found** in reviewed files.

### Warning
1. **WebSocket rate-limit bypass via invalid JSON**
   - **File:** `server/ws-server.ts`  
   - **Lines:** `478-484`, `504-513`
   - **Issue:** Parse failures return before message-rate counters are incremented.
   - **Risk:** Authenticated client can flood malformed frames and bypass 60 msg/s limit.
   - **Action:** Count all frames (or pre-parse throttle), not only valid parsed messages.

2. **Repo path collisions across owners/orgs**
   - **File:** `server/upload-routes.ts`
   - **Lines:** `121`, `300`
   - **Issue:** Local paths use `${reposRoot}/${repoName}` (owner not included).
   - **Risk:** `ownerA/repoX` and `ownerB/repoX` collide; wrong clone detection/reuse possible.
   - **Action:** Use owner-scoped pathing (e.g. `${reposRoot}/${owner}/${name}`) + migration handling.

3. **Missing explicit timeout on gh calls in repo listing flow**
   - **File:** `server/upload-routes.ts`
   - **Lines:** `112-116`, `231`, `240`
   - **Issue:** Some `gh` execs can hang indefinitely under network/API issues.
   - **Risk:** Slow/hung API requests and degraded responsiveness.
   - **Action:** Add timeouts + fallback error path per GH call.

4. **Documentation mismatch for approval timeout behavior**
   - **Docs:** `docs/FEATURES.md` lines `126`, `128`
   - **Code:** `server/prompt-router.ts` lines `345`, `500-509`
   - **Issue:** Docs describe 15s auto-approve / 60s timeout; code does 300s auto-deny.
   - **Risk:** Operator/user assumptions don’t match actual security/runtime behavior.
   - **Action:** Align docs and implementation.

### Info
1. **Testing is strong overall but key ingress routes lack direct tests**
   - `npm test`: **1639 tests passing**
   - Coverage (from `coverage/coverage-final.json`): Statements **77.3%**, Functions **75.6%**, Branches **69.7%**
   - No direct tests found for:
     - `server/ws-server.ts`
     - `server/upload-routes.ts`
     - `server/auth-routes.ts`
   - **Action:** Add focused tests for auth flow, upload/clone validation, malformed WS frame throttling.

2. **Dependency posture is good**
   - `npm audit --omit=dev`: **0 vulnerabilities**
   - `npm outdated`: one prod dependency behind patch (`better-sqlite3`)
   - **Action:** Patch upgrade and rerun tests.

If you want, I can now implement fixes for the top two warnings (WS throttle bypass + owner-scoped repo paths) and add targeted tests.