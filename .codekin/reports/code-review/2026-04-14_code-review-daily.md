# Daily Code Review: codekin

**Date**: 2026-04-14T04:02:37.690Z
**Repository**: /srv/repos/codekin
**Branch**: main
**Workflow Run**: 8d40c9f1-241e-4e29-a6d1-eef65993664a
**Session**: f5fabdb0-198c-49f8-a8d4-ba5dccc67a2b

---

Here’s the daily automated code review for `codekin`.

## 1) Project structure & architecture (quick assessment)

- **Frontend**: React/Vite (`src/`) with focused components + hooks architecture.
- **Backend**: Node/Express + `ws` (`server/`) acting as:
  - REST API gateway
  - WebSocket transport
  - session/process lifecycle manager for Claude/OpenCode
  - webhook/workflow automation engine
- **Design strength**: good modular decomposition in server (`session-lifecycle.ts`, `process-coordinator.ts`, route-level modules, handler base classes).
- **Current risk concentration**: lifecycle/process orchestration and webhook/workflow automation paths (high complexity + high churn).

## 2) Last 7 days of git activity (trend review)

Major themes from `git log --since='7 days ago'`:
- Heavy reliability/security work in:
  - `server/session-manager.ts`
  - `server/session-lifecycle.ts`
  - `server/opencode-process.ts`
  - `server/ws-server.ts`
  - `server/webhook-*`
- UI churn around workflow editing:
  - `src/components/EditWorkflowModal.tsx`
- Frequent hot files (count from recent history):
  - `server/session-manager.ts` (27)
  - `server/session-lifecycle.ts` (13)
  - `server/opencode-process.ts` (11)
  - `server/claude-process.ts` (11)
  - `server/ws-server.ts` (9)

Interpretation: project is actively improving, but these high-churn core files are the most regression-prone.

---

## 3) Findings by severity

## Critical
- **No critical issues confirmed** in this pass.

## Warning

1. **Canonical path validated but non-canonical path persisted (possible symlink-retarget escape)**
   - **File**: `server/session-routes.ts`
   - **Lines**: `84-95`, `101`
   - **Issue**: `workingDir` is validated via `realpathSync(...)` (`resolvedDir`) but `sessions.create(...)` stores the original user-supplied `workingDir`.
   - **Risk**: if a symlink path is accepted and later retargeted, subsequent process operations may execute outside the originally validated location.
   - **Action**: persist `resolvedDir` instead of raw `workingDir`; optionally re-validate/canonicalize before each process start.

2. **Docs browser can read markdown anywhere under home directory**
   - **File**: `server/docs-routes.ts`
   - **Lines**: `109-115`, `154-160`
   - **Issue**: allowed roots include both `homedir()` and `REPOS_ROOT`.
   - **Risk**: with token compromise, attacker can read arbitrary `*.md` under user home (notes, credentials docs, internal runbooks).
   - **Action**: default to `REPOS_ROOT` only; optionally add explicit allowlist per configured repo path.

3. **Coverage gaps in security/automation-critical server modules**
   - **Files**:
     - `server/workflow-routes.ts` (~1.53% statements covered)
     - `server/webhook-handler.ts` (~50%)
     - `server/webhook-workspace.ts` (~46.55%)
   - **Evidence**: `npx vitest run --coverage`
   - **Risk**: regressions likely in webhook setup, commit-event, and repo-mutating automation flows.
   - **Action**: prioritize integration tests for:
     - webhook setup/update/test endpoints
     - commit-event auth + payload validation
     - report branch/worktree commit/push paths

## Info

1. **Auth verification endpoint acts as token-validity oracle**
   - **File**: `server/auth-routes.ts`
   - **Lines**: `67-70`
   - **Note**: rate-limited (good), but endpoint still gives explicit valid/invalid signal.
   - **Suggestion**: consider generic response + stronger per-IP/account lockout behavior if exposed broadly.

2. **Configuration docs lag security-relevant env vars**
   - **Files**:
     - `README.md` lines `95-99` (very minimal env var table)
     - `server/config.ts` lines `22-33`, `95`, etc. (enforces `CORS_ORIGIN`, `TRUST_PROXY`, auth file behavior)
   - **Gap**: runtime-critical security/network vars are under-documented.
   - **Action**: expand README config matrix to include `AUTH_TOKEN[_FILE]`, `CORS_ORIGIN`, `TRUST_PROXY`, `DATA_DIR`, webhook envs.

3. **Dependency health currently good**
   - **Evidence**: `npm audit --json` shows **0 vulnerabilities** (prod + dev).
   - **Action**: keep weekly audit in CI; no immediate dependency remediation needed.

4. **Test suite health is strong overall**
   - **Evidence**: `npm test` -> **60 files, 1639 tests, all passing**.
   - **Action**: keep this baseline, but shift new test effort to low-coverage critical modules above.

---

## Recommended next actions (priority order)

1. Fix canonical-path persistence in session creation (`session-routes.ts`).
2. Restrict docs browsing root scope (or add explicit repo allowlist mode).
3. Add targeted tests for `workflow-routes`, `webhook-handler`, `webhook-workspace`.
4. Update README config documentation for security/runtime env vars.

