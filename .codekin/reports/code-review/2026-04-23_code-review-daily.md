# Daily Code Review: codekin

**Date**: 2026-04-23T04:03:06.599Z
**Repository**: /srv/repos/codekin
**Branch**: docs/audit-reports-2026-04-18
**Workflow Run**: f9319ef2-0a79-42cd-badf-64a80a8b4e27
**Session**: e73f33e2-ab87-4633-a345-92e24cd6d7eb

---

Here’s the daily automated review for `/srv/repos/codekin`.

## 1) Project structure & architecture (quick assessment)

**Architecture is cleanly split** between:
- `src/` React/Vite frontend
- `server/` Express + WebSocket backend
- Workflow/webhook/orchestrator subsystems as separate server modules (`workflow-*`, `webhook-*`, `orchestrator-*`)
- Shared message/type contracts in `server/types.ts` and `src/types.ts`

This is a good modular layout for a realtime app with automation features. Security-sensitive boundaries (auth, webhook signature checks, path validation) are mostly handled server-side.

---

## 2) Last 7 days of git activity (high-level)

### Observed trend
- **Majority of commits** in last 7 days are report/doc churn under `.codekin/reports/*`.
- **Actual runtime code changes** were concentrated on **2026-04-17**, mainly:
  - `server/auth-routes.ts`
  - `server/webhook-rate-limiter.ts`
  - `server/commit-event-hook.sh`
  - `server/orchestrator-session-router.ts`
  - model list updates in `server/types.ts`, `src/types.ts`

### Risk implication
- Security fixes landed recently, but there was limited follow-up code change/testing depth in the same week for adjacent critical flows.

---

## 3) Deep review findings (grouped by severity)

## Critical
- **No critical exploitable issue found** in this pass.

---

## Warning

1) **`core.hooksPath` relative path handling appears incorrect**
- **File:** `server/commit-event-hooks.ts`
- **Lines:** `68-73`, used by `101-103`
- **Issue:** `getHooksDir()` returns `core.hooksPath` directly when set. If that value is relative (common: `.githooks`), later file writes are relative to process CWD, not guaranteed repo root.
- **Impact:** Hook install/uninstall can target wrong path; commit-event hook may silently fail to install where expected.
- **Action:** Normalize with `path.isAbsolute(customPath) ? customPath : path.join(repoPath, customPath)`.

2) **Schedule PATCH route allows invalid cron expression updates**
- **File:** `server/workflow-routes.ts`
- **Lines:** `373-386` (PATCH), compare with validation in POST at `355-360`
- **Issue:** `PATCH /schedules/:id` applies `cronExpression` without calling `isValidCron`.
- **Impact:** Invalid schedule data can be persisted; runtime scheduler behavior becomes unreliable.
- **Action:** If `req.body.cronExpression` is present, validate it and return `400` on invalid format.

3) **CORS method list omits PATCH while API exposes PATCH endpoints**
- **File:** `server/ws-server.ts`
- **Lines:** `319-321`
- **Issue:** `Access-Control-Allow-Methods` is `GET, POST, DELETE, OPTIONS` but API includes PATCH routes (e.g. workflow config/schedule updates).
- **Impact:** Cross-origin clients will fail preflight on valid API operations.
- **Action:** Add `PATCH` (and any used verbs), and ideally set `Vary: Origin`.

4) **Hook sync logic does not fully match “removed repo” behavior described in comments**
- **File:** `server/commit-event-hooks.ts`
- **Lines:** `167-170` vs implementation `188-197`
- **Issue:** Comment says disabled/removed repos are uninstalled, but loop only iterates current config entries; previously removed repos are no longer enumerable here.
- **Impact:** Stale `post-commit` hook snippets can remain in repos removed from workflow config.
- **Action:** Track prior installed repo set (persisted) or perform explicit cleanup against known managed repo list.

5) **Very low coverage on critical workflow route surface**
- **Files:** `server/workflow-routes.ts`, `server/workflow-routes.test.ts`
- **Evidence:** test file only covers `parseGitHubSlug` (`workflow-routes.test.ts:1-37`); coverage report shows ~1.68% lines for this file.
- **Impact:** High regression risk for auth-protected workflow CRUD and commit-event endpoint behavior.
- **Action:** Add integration-style route tests for `/runs`, `/schedules`, `/config/repos`, and error paths.

---

## Info

1) **Security posture checks currently good in key areas**
- Webhook signature enforcement and fail-closed behavior:
  - `server/webhook-handler.ts:160-166`
- WebSocket auth timeout and rate limiting:
  - `server/ws-server.ts:464-468`, `504-513`
- Symlink-resolved repo boundary check:
  - `server/orchestrator-session-router.ts:161-165`

2) **Dependency security status**
- `npm audit --json`: **0 vulnerabilities**
- `npm outdated`: only `better-sqlite3` behind (`12.8.0 -> 12.9.0`)
- **File reference:** `package.json:40`
- Recommendation: bump to latest patch and re-run tests/lint.

3) **Current test suite health**
- `npm test`: **60 files, 1639 tests, all passing**
- Strong baseline signal, but uneven coverage in high-risk server routing modules remains.

---

## Suggested next actions (priority order)

1. Fix `core.hooksPath` resolution bug in `commit-event-hooks.ts`.
2. Add cron validation in `PATCH /schedules/:id`.
3. Update CORS allowed methods to include PATCH.
4. Add workflow route tests (especially failure/validation paths and auth checks).
5. Upgrade `better-sqlite3` patch version and re-run CI suite.

If you want, I can turn this into a patch plan with exact test cases per endpoint/module next.