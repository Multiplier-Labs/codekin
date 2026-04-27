# Daily Code Review: codekin

**Date**: 2026-04-27T04:02:22.871Z
**Repository**: /srv/repos/codekin
**Branch**: docs/audit-reports-2026-04-18
**Workflow Run**: 911eb05a-9807-44a0-bfc2-94620f1783a0
**Session**: 6e60f780-b714-4c81-8a02-58884479c8ef

---

Completed. I reviewed the structure, last 7 days of git history, and did a deep pass on the recent critical server changes.

I also saved the full report to:

- `.codekin/reports/code-review/2026-04-27_code-review-daily.md`

## 1) Project structure & architecture (quick assessment)

- Clear split between frontend (`src/`) and backend (`server/`), with Express + WebSocket server as the core runtime.
- Security-sensitive logic is centralized in server routes and `ws-server.ts`.
- Workflow/audit subsystem is integrated and active (`server/workflow-*.ts`, `.codekin/reports/*`).
- Overall architecture is coherent and maintainable.

## 2) Last 7 days git activity

- 12 commits total in the last week.
- **One major code change**: `71161ff` (server hardening + WS rate limiting + significant test expansion).
- Other commits were mostly report/docs updates under `.codekin/reports/`.

## 3) Findings (by severity)

### Critical
- **None identified.**

### Warning

1. **Invalid cron accepted (`*/0`)**
   - **File:** `server/workflow-routes.ts:159-168`
   - `isValidCron()` parses step syntax but does not reject step `0`.
   - **Action:** Enforce step >= 1 and add regression tests.

2. **Commit hooks may remain after repo removal**
   - **File:** `server/commit-event-hooks.ts:191-199`
   - `syncCommitHooks()` only uninstalls for repos still present in current config; fully removed repos can retain stale hooks.
   - **Action:** Track previously managed repos and uninstall hooks for removed entries.

3. **WebSocket allows missing Origin header in production**
   - **File:** `server/ws-server.ts:448-451`
   - Current check rejects only mismatched non-empty origin; missing origin is allowed.
   - **Action:** In production, require `Origin === CORS_ORIGIN`.

4. **Clone route can throw on invalid repos root resolution**
   - **File:** `server/upload-routes.ts:324`
   - `realpathSync(resolveReposRoot())` is not locally guarded.
   - **Action:** Wrap in try/catch and return structured JSON error.

5. **Rate-limit window boundary off-by-one**
   - **File:** `server/ws-rate-limit.ts:32`
   - Uses `>` instead of `>=` when rolling window.
   - **Action:** switch to `>=`; add boundary test.

### Info

1. **Test posture improved significantly**
   - **Files:** `server/session-routes.test.ts`, `server/workflow-routes.test.ts`, `server/auth-routes.test.ts`, `server/ws-rate-limit.test.ts`
   - Large expansion in route/helper test coverage in recent commit.

2. **Upload route tests are still shallow**
   - **Files:** `server/upload-routes.ts` vs `server/upload-routes.test.ts:1-23`
   - Current tests cover helper only, not HTTP route security/error cases.
   - **Action:** Add tests for `/api/upload`, `/api/repos`, `/api/clone` negative paths/timeouts.

3. **Dependencies look clean right now**
   - `npm audit --omit=dev` reports **0 vulnerabilities**.
   - But root and `server/` manifests may drift over time.
   - **Action:** add periodic version-alignment check or document intentional divergence.

---

### Validation summary
- `npm test`: **67 test files, 1795 tests passed**
- `npm audit --omit=dev`: **0 prod vulnerabilities**

If you want, next I can turn the top 3 warnings into a concrete fix plan with patch-ready diffs.