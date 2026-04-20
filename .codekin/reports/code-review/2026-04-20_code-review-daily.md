# Daily Code Review: codekin

**Date**: 2026-04-20T04:02:58.419Z
**Repository**: /srv/repos/codekin
**Branch**: docs/audit-reports-2026-04-18
**Workflow Run**: 52423de8-35d9-42ad-a27b-769140339632
**Session**: 25bfb6ec-5102-4205-9f11-c366807d5cee

---

Done — I completed the review and saved the full report here:

```text
.codekin/reports/code-review/2026-04-20_code-review-daily.md
```

## 1) Project structure & architecture (assessment)

- **Frontend**: `src/` (React + Vite + Tailwind), hook-driven state, WS-first session/chat UX.
- **Backend**: `server/ws-server.ts` is the integration hub (REST + WS + webhooks + workflows + orchestrator).
- **Runtime core**: `SessionManager` + `SessionLifecycle` + `ProcessCoordinator` handle process lifecycle, restart logic, approvals, and persistence.
- Overall architecture is coherent and trending in a good direction (recent decomposition + hardening work).

## 2) Last 7 days of git activity (high-level)

Themes from recent commits:
- Security hardening (symlink boundary checks, limiter map caps, hook payload safety)
- Session lifecycle/restart stability improvements
- Router/module decomposition
- Model/provider updates and workflow UI polish
- Ongoing automated reporting

## 3) Deep review findings (grouped by severity)

### Critical
- **None found** in this pass.

### Warning

1. **`repos_path` storage can break clone flow with `~` values**
   - `server/session-routes.ts:318-323`
   - `server/upload-routes.ts:299`
   - Why: validated with expanded path, but raw `~` may be persisted; later `realpathSync` on raw value can fail at runtime.
   - Action: persist canonical absolute path (expanded + realpath), not raw user input.

2. **Repo identity collision across owners**
   - `server/upload-routes.ts:121`
   - `server/upload-routes.ts:299-301`
   - Why: local path uses only repo name; `ownerA/foo` and `ownerB/foo` collide.
   - Action: namespace local repo storage by owner (`<reposRoot>/<owner>/<repo>`).

3. **Synchronous FS work in request handlers (event-loop blocking risk)**
   - `server/docs-routes.ts:40-71`, `92-137`, `181-184`
   - `server/upload-routes.ts:61-100`, `225-227`, `132-133`
   - Why: recursive sync scans and sync reads on hot API paths.
   - Action: async FS + bounded traversal + short TTL cache.

4. **CSP `connect-src` broader than necessary**
   - `server/ws-server.ts:309`
   - Why: `connect-src 'self' wss: ws:` allows arbitrary WS destinations.
   - Action: tighten to `'self'` + explicit trusted origins.

5. **Hook config parsing is brittle**
   - `server/commit-event-hook.sh:21-23`
   - Why: `grep/sed` parsing JSON is fragile around formatting/escaping.
   - Action: prefer `jq -r` robustly (or move config to key/value format).

6. **Large lint-warning backlog**
   - `npm run lint` reports **450 warnings** (0 errors)
   - Example: `src/hooks/useOpenCodeModelSync.ts:70` (`react-hooks/exhaustive-deps`)
   - Action: staged warning burn-down plan by rule category.

### Info

- **Tests**: `npm test` passed (**60 files, 1639 tests**).
- **Dependencies/security**: `npm audit --audit-level=high` reports **0 vulnerabilities**.
- **Coverage gap remains in critical modules**:
  - `server/workflow-routes.ts` ~**1.68%** line coverage
  - `server/commit-event-hooks.ts` ~**8.62%** line coverage
  - Action: prioritize route/integration tests for workflow endpoints and commit-hook sync/install/remove paths.
- **Dependency management drift risk**:
  - `package.json` and `server/package.json` coexist with overlapping deps/overrides; define one authoritative strategy and enforce via CI.