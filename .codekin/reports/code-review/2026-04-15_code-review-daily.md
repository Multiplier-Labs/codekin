# Daily Code Review: codekin

**Date**: 2026-04-15T04:04:37.574Z
**Repository**: /srv/repos/codekin
**Branch**: feat/repo-health-2026-04-15
**Workflow Run**: ffafb31c-88fa-458d-aa6b-ee2c690bc33f
**Session**: b569a695-0945-4b08-a381-1752564c1449

---

Completed. I also saved the full daily report to:

```text
.codekin/reports/code-review/2026-04-15_code-review-daily.md
```

## 1) Project structure & architecture (quick assessment)

- **Frontend:** `src/` (React + Vite + Tailwind), clear split between UI (`src/components/*`) and behavior hooks (`src/hooks/*`).
- **Backend:** `server/` (Express + ws), modular routers + dedicated lifecycle/process modules (`session-manager.ts`, `session-lifecycle.ts`, `process-coordinator.ts`).
- **Automation:** webhook/workflow stack (`webhook-*.ts`, `workflow-*.ts`, `commit-event-*.ts`) handles scheduled audits, CI, and PR automation.
- **Risk concentration:** high in lifecycle + webhook/workflow modules due to complexity + high recent churn.

## 2) Last 7 days of git activity

Recent history is heavily focused on reliability/security hardening and OpenCode/session lifecycle fixes.

Most frequently changed files (7d):
1. `server/session-manager.ts` (26)
2. `server/session-manager.test.ts` (14)
3. `server/session-lifecycle.ts` (13)
4. `server/claude-process.ts` (12)
5. `server/opencode-process.ts` (11)
6. `server/ws-server.ts` (9)

## 3) Findings by severity

### Critical
- No confirmed critical issues in this pass.

### Warning

1. **CORS allow-methods don’t match API usage**
   - `server/ws-server.ts:319`
   - Allows `GET, POST, DELETE, OPTIONS` but API uses `PUT/PATCH` too.
   - **Action:** add `PUT, PATCH` (and optionally `HEAD`) to `Access-Control-Allow-Methods`.

2. **`repos_path` is validated expanded but stored raw**
   - `server/session-routes.ts:318-324`
   - Used downstream in `server/upload-routes.ts:151-157,299`
   - `~/...` can validate but later break clone/list path handling.
   - **Action:** persist canonical expanded (ideally realpath) value.

3. **Docs listing may follow symlinked dirs outside repo boundary**
   - `server/docs-routes.ts:56-63,115`
   - Recursive listing uses `statSync` and follows symlink dirs without boundary check on descent.
   - **Action:** use `lstatSync` and skip symlink directories, or enforce `realpath` boundary on each walk step.

4. **Auth rate limiter map has no hard cap**
   - `server/auth-routes.ts:13-24,27-33`
   - Could grow under high-cardinality IP traffic.
   - **Action:** cap map size / LRU eviction (similar to `ws-server.ts` limiter pattern).

5. **WebSocket create-session validates canonical path but stores raw path**
   - `server/ws-message-handler.ts:37,51`
   - `resolvedDir` is checked; `sessions.create` still uses `msg.workingDir`.
   - **Action:** pass `resolvedDir` for canonical consistency.

### Info

1. **Tests pass**
   - `npm test`: 60 files, 1639 tests, all passing.

2. **Coverage is decent overall, but weak in key automation areas**
   - Overall (`coverage/index.html`): Statements 77.3%, Branches 69.69%, Functions 75.41%, Lines 78.45%.
   - Low-coverage hot spots (`coverage/server/index.html`): `commit-event-hooks.ts`, `opencode-process.ts`, `webhook-workspace.ts`, `workflow-routes.ts`.
   - **Action:** prioritize tests for webhook/workflow/report-commit flows and OpenCode lifecycle edges.

3. **Dependencies are clean**
   - `npm audit` (prod+dev): 0 vulnerabilities.

4. **Lint debt remains large**
   - `npm run lint` reports many warnings, including generated `coverage/*`.
   - **Action:** ignore `coverage/` in ESLint config and then reduce high-signal runtime warnings.

If you want, I can now convert the top 3 warnings into a concrete patch plan (or implement fixes directly).