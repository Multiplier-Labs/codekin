# Daily Code Review: codekin

**Date**: 2026-04-24T04:01:42.201Z
**Repository**: /srv/repos/codekin
**Branch**: docs/audit-reports-2026-04-18
**Workflow Run**: 93dfaab6-ed5d-4fe6-8554-b22d6e9a5241
**Session**: d44d667f-4e27-4a07-9c56-5a9dcf0c1e90

---

Here’s the daily code review summary based on project inspection, last 7 days of git history, and deep review of critical server/frontend files.

## 1) Project structure & architecture (quick assessment)

- **Architecture is cleanly split**:
  - Frontend: `src/` (React + hooks/components/lib)
  - Backend: `server/` (Express + ws + routing modules)
  - Shared protocol/types: `src/types.ts`, `server/types.ts`
- **Security-sensitive concerns are centralized** in server routes (`auth`, `session`, `upload`, `webhook`, `orchestrator`).
- **Testing is substantial**: 60 test files, 1639 tests currently passing (`npm test`).
- **Dependency posture (prod)**: `npm audit --omit=dev` reports **0 vulnerabilities**.

---

## 2) Git activity review (last 7 days)

- Most commits are **report/documentation automation** under `.codekin/reports/*`.
- Actual code changes were concentrated on **2026-04-17**, mainly:
  - security hardening in path checks and hook payload handling
  - rate-limiter map growth caps
  - model list update
- Net: recent engineering work focused on **defensive security improvements**, with low functional churn since then.

---

## 3) Findings by severity

## Critical

- **No critical issues found** in reviewed files.

## Warning

1. **`/api/repos` may fail due to env inconsistency in `gh` call**
   - **File:** `server/upload-routes.ts:231`
   - `gh api user` is called **without** `{ env: ghEnv }`, while other GH calls do use it.
   - If `GITHUB_TOKEN` in environment is incompatible, repo listing can degrade unexpectedly.
   - **Action:** Use `execFileAsync('gh', ['api', 'user', '--jq', '.login'], { env: ghEnv })` for consistency.

2. **CSP `connect-src` is broader than needed**
   - **File:** `server/ws-server.ts:309`
   - Current policy allows `wss:` and `ws:` globally, not only same-origin.
   - **Risk:** increases blast radius if any XSS ever bypasses sanitization.
   - **Action:** tighten to explicit origins (e.g., `'self'` + known websocket endpoint).

3. **Potential rate-limiter performance degradation under high request volume**
   - **Files:**  
     - `server/auth-routes.ts:32`  
     - `server/webhook-rate-limiter.ts:80`
   - Both use per-key timestamp arrays with `filter()` on each request (O(n)).
   - **Action:** consider token-bucket / leaky-bucket counters for predictable O(1) behavior.

4. **Test coverage gap on security-sensitive routes**
   - **Files lacking direct tests:** `server/auth-routes.ts`, `server/orchestrator-session-router.ts`
   - No matching test files found for these modules.
   - **Action:** add focused tests for:
     - unauthorized/authorized access
     - symlink/path-boundary validation
     - input validation failures (`branchName`, `allowedTools`, repo path).

## Info

1. **Good recent hardening patterns are present**
   - Symlink boundary protections: `server/orchestrator-session-router.ts:161-165`, `server/docs-routes.ts:168-179`
   - Timing-safe auth token compare: `server/ws-server.ts:79-86`
   - Hook payload injection mitigation: `server/commit-event-hook.sh:47-62`

2. **Docs gap for production security config**
   - **File:** `README.md:95-99`
   - Config table is minimal; does not prominently document security-critical deployment vars like `CORS_ORIGIN`, `TRUST_PROXY`, auth token setup strategy.
   - **Action:** expand configuration docs with “secure production defaults” section.

3. **Dependency/version drift risk between root and `server/` package manifests**
   - **Files:** `package.json`, `server/package.json`
   - Toolchain versions differ (e.g., Vitest/TypeScript), which can cause inconsistent CI/dev behavior.
   - **Action:** align or document why divergence is intentional.

---

If you want, I can turn this into a tracked report file under:

```text
.codekin/reports/code-review/YYYY-MM-DD_code-review-daily.md
```

and include a short “recommended next actions” checklist for tomorrow’s run.