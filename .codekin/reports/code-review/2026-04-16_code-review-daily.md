# Daily Code Review: codekin

**Date**: 2026-04-16T04:02:42.730Z
**Repository**: /srv/repos/codekin
**Branch**: feat/repo-health-2026-04-15
**Workflow Run**: e1f9a1d0-a017-4a2e-9b88-f30194ddf9ae
**Session**: 9b33efd0-19c2-4f25-8aa1-fd675b81f490

---

Completed. I reviewed the codebase structure, recent git history (last 7 days), and critical files, and saved the full report to:

`/srv/repos/codekin/.codekin/reports/code-review/2026-04-16_code-review-daily.md`

## 1) Project structure & architecture (quick assessment)

- **Frontend**: `src/` (React + Vite + Tailwind), with hooks-driven state (`useChatSocket`, `useSessions`, orchestration hooks).
- **Backend**: `server/` (Express + ws), modularized by route factories and managers:
  - Core server/bootstrap: `server/ws-server.ts`
  - Session/process lifecycle: `server/session-manager.ts`, `server/session-lifecycle.ts`, `server/process-coordinator.ts`
  - Security-sensitive routes: `auth-routes`, `session-routes`, `docs-routes`, `upload-routes`
  - Automation/webhooks/workflows: `webhook-*`, `workflow-*`
- Architecture is generally solid and has improved recently around lifecycle reliability and security hardening.

## 2) Last 7 days of git log (high-level)

Main themes from recent commits:
- **Session lifecycle reliability** work (restarts, race fixes, coordinator refactor).
- **OpenCode provider** stabilization (streaming, model/session behavior, startup handling).
- **Security hardening** (path traversal protections, CSP/origin handling, rate limiting improvements).
- **Daily/weekly audit reporting** is active and consistent.

## 3) Findings (grouped by severity)

### Critical
- **None found** in this review pass.

### Warning
1. **Repo path collision across different owners**
   - **Files**: `server/upload-routes.ts:121-133`, `server/upload-routes.ts:299-318`
   - **Issue**: Local path uses only repo name (`${reposRoot}/${repo}`), not `owner/repo`.
   - **Risk**: Wrong repo marked as cloned / collisions when orgs share repo names.
   - **Action**: Namespace by owner (`${reposRoot}/${owner}/${repo}`), with migration handling.

2. **Unbounded rate-limiter map growth in two limiters**
   - **Files**: `server/auth-routes.ts:13-23`, `server/webhook-rate-limiter.ts:36-49`
   - **Issue**: Time pruning exists, but no hard key cap.
   - **Risk**: Memory growth under high-cardinality traffic patterns.
   - **Action**: Add max map size + reject new keys when cap reached (similar to `ws-server.ts` map caps).

3. **Critical route modules missing direct tests**
   - **Files**: `server/session-routes.ts`, `server/upload-routes.ts`, `server/docs-routes.ts`, `server/auth-routes.ts`, `server/ws-server.ts`
   - **Issue**: Many high-risk request-path validations are indirectly tested only.
   - **Risk**: Regression risk in auth/bounds/path checks.
   - **Action**: Add route-level tests for unauthorized access, traversal attempts, malformed payloads, and limiter behavior.

### Info
1. **Inconsistent `gh` environment handling**
   - **File**: `server/upload-routes.ts:231`
   - **Issue**: Most `gh` calls use sanitized `ghEnv`, but this call does not.
   - **Action**: Use `ghEnv` consistently for all `gh` invocations in this module.

2. **Documentation gap in runtime config docs**
   - **Files**: `README.md:95-99`, `server/config.ts:18-99`
   - **Issue**: README lists only a subset of actual config vars used operationally.
   - **Action**: Expand README config table (e.g., `CORS_ORIGIN`, `TRUST_PROXY`, auth-related env vars).

3. **Dependency/security baseline is good**
   - `npm audit --omit=dev` (root + server) returned **0 prod vulnerabilities**.
   - `npm test` passed: **60 files / 1639 tests**.

If you want, I can now turn the top warning items into a concrete remediation plan (small PR-sized tasks with suggested test cases).