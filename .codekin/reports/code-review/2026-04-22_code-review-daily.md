# Daily Code Review: codekin

**Date**: 2026-04-22T04:04:13.205Z
**Repository**: /srv/repos/codekin
**Branch**: docs/audit-reports-2026-04-18
**Workflow Run**: 52d22777-cef0-421c-be4b-f14ddbb7d9c6
**Session**: 826c0f25-53fb-4f9c-9260-d37257a436a8

---

Done — I completed the review and also saved it to:

- `.codekin/reports/code-review/2026-04-22_code-review-daily.md`

## 1) Project structure & architecture (quick assessment)

- **Frontend**: React/Vite app in `src/`, with `App.tsx` coordinating session/chat/docs/workflow UI and many extracted hooks/components.
- **Backend**: Single Express + WebSocket server in `server/ws-server.ts`, with modular routers (`auth`, `session`, `upload`, `webhook`, `workflow`, `orchestrator`).
- **Ops/reporting**: Workflow definitions in `server/workflows/`; recurring outputs in `.codekin/reports/...`.

## 2) Last 7 days of git log (summary)

Most commits were report/docs updates. Notable code commits in the period:
- Security hardening:
  - symlink bypass prevention (`server/orchestrator-session-router.ts`)
  - JSON injection mitigation (`server/commit-event-hook.sh`)
  - rate-limiter map caps (`server/auth-routes.ts`, `server/webhook-rate-limiter.ts`)
- Refactors:
  - `App.tsx` decomposition into hooks
  - orchestrator router split into focused sub-routers
- Feature:
  - add `claude-opus-4-7` model support

---

## Findings by severity

### Critical
- **None found** in this pass.

### Warning

1. **Repo clone/list path collision across owners**
   - `server/upload-routes.ts:121`, `:252`, `:299-301`
   - Paths are owner-agnostic (`<reposRoot>/<repoName>`), so same repo name across org/user can collide.
   - **Action**: move to owner-scoped paths (`<reposRoot>/<owner>/<repo>`) + migration handling.

2. **Potential unhandled error if repos root doesn’t exist**
   - `server/upload-routes.ts:299`
   - `realpathSync(resolveReposRoot())` may throw and bubble to 500.
   - **Action**: wrap in `try/catch`, return controlled 400, optionally create directory if missing.

3. **Security-sensitive areas still lack direct tests**
   - recently hardened files with no dedicated tests found:
     - `server/auth-routes.ts`
     - `server/orchestrator-session-router.ts`
     - `server/commit-event-hook.sh`
   - **Action**: add targeted tests for rate-limiter caps, symlink boundary checks, and hook payload escaping/fallback behavior.

4. **Hook dependency warning in OpenCode model sync**
   - `src/hooks/useOpenCodeModelSync.ts:70`
   - Lint reports missing dependency (`react-hooks/exhaustive-deps`), potential stale behavior.
   - **Action**: refactor effect dependencies/state derivation and add focused hook tests.

5. **High lint-warning volume reduces signal**
   - `npm run lint` => **450 warnings**, 0 errors.
   - **Action**: staged lint debt reduction + “no new warnings” CI gate.

### Info

1. **Documentation drift against current API behavior**
   - `docs/API-REFERENCE.md:25` says `/auth-verify` accepts body token, but implementation uses Authorization header:
     - `server/auth-routes.ts:76-77`
     - `server/ws-server.ts:99-105`
   - `docs/API-REFERENCE.md:175` shows `/api/browse-dirs` as object list, while implementation returns string dir names + `path`:
     - `server/session-routes.ts:389`
   - **Action**: update API reference contracts.

2. **Dependency posture is clean**
   - `npm audit --json` (root and `server/`) shows **0 known vulnerabilities**.

3. **Tests are healthy, but branch coverage is still the weak spot**
   - `npm test` passed: 60 files / 1639 tests.
   - Prior coverage report (`.codekin/reports/test-coverage/2026-04-20_test-coverage.md`) shows branch coverage lagging (~69.7%).

---

If you want, I can now turn the top warnings into a concrete remediation plan (PR-sized task list with estimated effort).