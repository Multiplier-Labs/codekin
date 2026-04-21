# Daily Code Review: codekin

**Date**: 2026-04-21T04:03:21.259Z
**Repository**: /srv/repos/codekin
**Branch**: docs/audit-reports-2026-04-18
**Workflow Run**: 864bb2ba-ea44-4f74-bc2c-a571640111a5
**Session**: 7a14adce-63e8-46c0-87e1-33ecc50d3fc4

---

Completed. I reviewed structure, 7-day git history, and high-risk files, and saved the full report to:

`/srv/repos/codekin/.codekin/reports/code-review/2026-04-21_code-review-daily.md`

### 1) Project structure / architecture (quick assessment)
- **Frontend:** `src/` (React + Vite + Tailwind), with recent decomposition of `App.tsx` into focused hooks.
- **Backend:** `server/` (Express + `ws`) with modular routers (`auth`, `session`, `webhook`, `docs`, `orchestrator`).
- **Shared contracts:** types are mostly aligned between `src/types.ts` and `server/types.ts`.
- **Operational posture:** auth token checks, per-IP/per-key rate-limiting, and symlink-aware path checks are in place.

### 2) Last 7 days git log (trend)
- Most commits were **audit/report docs** updates under `.codekin/reports/...`.
- Code commits focused on:
  - security hardening (symlink and JSON-injection fixes),
  - rate-limiter memory caps,
  - orchestrator router refactor,
  - frontend App hook refactor,
  - model support update (Opus 4.7).

---

## Findings by severity

## Critical
- **None identified** in reviewed scope.

## Warning
1. **Nested repo report reads can fail due path validation logic**
   - `server/orchestrator-reports.ts:115-117`
   - Regex only matches repo paths one level under `REPOS_ROOT`; nested paths like `REPOS_ROOT/org/repo/...` may be rejected.
   - **Action:** replace regex with a depth-agnostic canonical path check for `/.codekin/reports/`.

2. **CSP is broader than needed for websocket egress**
   - `server/ws-server.ts:309`
   - `connect-src 'self' wss: ws:` allows any ws/wss destination.
   - **Action:** restrict websocket targets to expected origin(s) only.

3. **Commit hook JSON fallback escaping is incomplete**
   - `server/commit-event-hook.sh:57-61`
   - Fallback encoder doesn’t fully escape all JSON control chars (e.g., newline edge cases) when `jq` is missing.
   - **Action:** require `jq` or use a robust fallback (`python json.dumps`).

4. **API docs drift from current orchestrator implementation**
   - Docs: `docs/API-REFERENCE.md:456-464,478-479,506,512`
   - Code: `server/orchestrator-session-router.ts:95-107,118-122,178,261,287`
   - Mismatches in query params and response keys (`success/cleaned/childId` vs actual outputs).
   - **Action:** update API reference to exact live request/response contracts.

5. **Coverage gaps in security-sensitive route modules**
   - No dedicated tests found for:
     - `server/auth-routes.ts`
     - `server/docs-routes.ts`
     - `server/session-routes.ts`
     - `server/orchestrator-session-router.ts`
     - `server/orchestrator-reports.ts`
   - **Action:** add focused tests for auth enforcement, path boundaries, and contract behavior.

## Info
- `npm test` passed: **60 files, 1639 tests**.
- `npm audit --audit-level=high` returned **0 vulnerabilities**.
- Recent refactors improved modularity and maintainability.

If you want, I can next turn this into a prioritized fix plan (with suggested PR split and test cases).