# Daily Code Review: codekin

**Date**: 2026-04-18T04:03:12.214Z
**Repository**: /srv/repos/codekin
**Branch**: docs/audit-reports-2026-04-18
**Workflow Run**: 8f2de2cd-090c-4d83-8269-3f4873cb2059
**Session**: 6a1dc486-e916-48f6-919d-272b05e3eec0

---

Done — I completed the review and saved the full report to:

`/srv/repos/codekin/.codekin/reports/code-review/2026-04-18_code-review-daily.md`

## Summary (actionable)

### Critical
- No critical issues found in this pass.

### Warning
1. **Missing `repoPath` boundary validation in workflow config routes**  
   - `server/workflow-routes.ts:419-446`, `server/workflow-routes.ts:477-487`  
   - `repoPath` is accepted without `realpath` + allowed-root enforcement.  
   - **Action:** apply the same canonicalization/root checks used in `session-routes.ts`.

2. **Cron validation gap on schedule patch endpoint**  
   - `server/workflow-routes.ts:373-386`  
   - `PATCH /api/workflows/schedules/:id` can persist invalid cron values.  
   - **Action:** validate `cronExpression` with `isValidCron` when provided.

3. **Orchestrator report listing route accepts unchecked repo path**  
   - `server/orchestrator-session-router.ts:95-101`  
   - Directly scans the user-provided path for reports.  
   - **Action:** enforce `REPOS_ROOT` (or managed-repo allowlist) before scanning.

4. **Rate limiter implementation has avoidable per-request overhead**  
   - `server/auth-routes.ts:16-33`, `server/webhook-rate-limiter.ts:38-45,77-81`  
   - Filters timestamp arrays every request (CPU/GC cost under bursts).  
   - **Action:** move to `{count, resetAt}` bucket model.

### Info
1. **Tests are passing, but coverage is uneven in critical routes**
   - `npm test`: 1639/1639 passing  
   - Coverage highlights (`npm test -- --coverage`):
     - `server/workflow-routes.ts`: **1.53%**
     - `server/opencode-process.ts`: **35.96%**
     - `server/webhook-handler.ts`: **50%**
   - **Action:** prioritize tests around workflow route mutations + webhook failure paths.

2. **No direct tests found for several sensitive routers**
   - Missing dedicated tests for:
     - `server/auth-routes.ts`
     - `server/docs-routes.ts`
     - `server/session-routes.ts`
     - `server/upload-routes.ts`
     - `server/orchestrator-session-router.ts`
   - **Action:** add router-level integration tests for auth, path bounds, invalid inputs.

3. **Documentation gap**
   - Endpoint exists: `server/session-routes.ts:117-137` (`GET /api/opencode/models`)  
   - Not found in `docs/API-REFERENCE.md`.  
   - **Action:** document request/response + workingDir restrictions.

4. **Dependency status**
   - `npm audit --omit=dev`: 0 vulnerabilities  
   - `npm outdated`: `better-sqlite3` patch update available (`12.8.0 -> 12.9.0`).

---

If you want, I can now implement the top 2 warnings (repoPath validation + cron patch validation) in a focused fix pass.