# Daily Code Review: codekin

**Date**: 2026-04-25T04:02:15.029Z
**Repository**: /srv/repos/codekin
**Branch**: docs/audit-reports-2026-04-18
**Workflow Run**: 047f647a-e500-4715-9efe-641943c99079
**Session**: b1f36217-1ea6-45b8-9c10-c5c650095a6a

---

Completed. I performed the review and saved the full report here:

```text
.codekin/reports/code-review/2026-04-25_code-review-daily.md
```

### Architecture / structure
- Clean separation between frontend (`src/`) and backend (`server/`), with shared protocol types.
- Security-sensitive concerns are centralized in server route/middleware layers.
- Test suite is substantial and currently healthy: **60 files / 1639 tests passing**.
- Prod dependency audit is clean: **0 vulnerabilities** (`npm audit --omit=dev`).

### Last 7 days of git activity
- Commits in the last week are almost entirely `.codekin/reports/*` updates.
- No meaningful application code churn in this window, so main risk is existing code paths rather than recent regressions.

---

## Findings by severity

## Critical
- **None identified** in reviewed critical paths.

## Warning
1. **CORS preflight mismatch with implemented endpoints**
   - `server/ws-server.ts:319` allows `GET, POST, DELETE, OPTIONS` only.
   - But PATCH routes exist:
     - `server/session-routes.ts:208`
     - `server/workflow-routes.ts:373`
     - `server/workflow-routes.ts:477`
   - **Action:** Add `PATCH` (and any used verbs) to `Access-Control-Allow-Methods`.

2. **Inconsistent GH CLI env handling can break `/api/repos`**
   - `server/upload-routes.ts:231` runs `gh api user` without `{ env: ghEnv }`.
   - Nearby GH call does use `ghEnv` (`server/upload-routes.ts:240`).
   - **Action:** pass `{ env: ghEnv }` consistently.

3. **CSP `connect-src` broader than necessary**
   - `server/ws-server.ts:309` allows global `wss:` and `ws:`.
   - **Action:** tighten to explicit trusted origins (`'self'` + known socket hosts).

4. **Rate limiter algorithm may degrade under burst traffic**
   - `server/auth-routes.ts:32`
   - `server/webhook-rate-limiter.ts:80`
   - Both use per-key timestamp arrays + `filter()` per request (O(n)).
   - **Action:** move to token-bucket/leaky-bucket counters.

5. **No coverage thresholds enforced**
   - `vitest.config.ts:6-10` has no coverage gating.
   - Existing low-coverage critical files (from latest coverage report) include:
     - `server/workflow-routes.ts` (1.68% lines)
     - `server/commit-event-hooks.ts` (8.62% lines)
     - `server/webhook-handler.ts` (49.72% lines)
   - **Action:** enforce global/per-file minimums in CI.

## Info
1. **Good security practices present**
   - Timing-safe token checks: `server/ws-server.ts:79-86`
   - Raw-body + signature verification before JSON parsing: `server/ws-server.ts:216-259`
   - Realpath boundary checks in docs file serving: `server/docs-routes.ts:109-113`, `168-179`

2. **Documentation gap**
   - `README.md:95-99` only lists `PORT` and `REPOS_ROOT`.
   - **Action:** document production security env vars (`CORS_ORIGIN`, `TRUST_PROXY`, `AUTH_TOKEN[_FILE]`, webhook secrets).

3. **Dependency management drift risk**
   - Duplicate manifests (`package.json` and `server/package.json`) with overlapping but differing versions.
   - **Action:** align or explicitly document intentional version divergence.