# Daily Code Review: codekin

**Date**: 2026-08-30T04:04:59.969Z
**Repository**: /srv/repos/Multiplier-Labs/codekin
**Branch**: main
**Workflow Run**: 3d5ab30c-a78c-49ef-9f55-1b1c883b5725
**Session**: d08ea31b-03ff-49cd-bb09-6c42b98f5ce7

---

# Daily Code Review — 2026-08-30

## Executive Summary

- **Commits reviewed (last 7 days):** 35 on `main`, 63 total refs including feature branches.
- **Latest commit:** `80c9630` — feat(workflows): trigger engine core — pre-dispatch gates, trigger ledger, heartbeat (#602).
- **Health checks:** ✅ 3,007 tests pass across 151 files; ✅ TypeScript build clean; ⚠️ 559 ESLint warnings, 0 errors.
- **Uncommitted changes:** 4 files (Codex model string refresh only).
- **Overall:** Trigger-engine core is well-tested and addresses the previous sliding-window bug, but introduces race conditions and stale fallback logic that should be fixed before broader rollout.

---

## Severity: Critical

### 1. Per-tick race on `lastReviewedSha` can duplicate reviews of the same commit
- **File:** `server/workflow-engine.ts` lines 982–994 (dispatch) and 651–655 (success handler)
- **Finding:** `evaluateAndDispatch` checks `schedule.lastReviewedSha === headSha` synchronously, then starts a run that advances `lastReviewedSha` asynchronously. Within a single tick, two schedules for the same repository can both observe the old anchor and both dispatch, producing duplicate reviews of the same SHA.
- **Action:** Re-check the stored `lastReviewedSha` inside the success handler before writing it (only update if the stored value is still older), or take a per-repo dispatch lock for the duration of the tick.

### 2. Single-flight concurrency gate is not atomic and mismatches its comment
- **File:** `server/workflow-engine.ts` lines 964–973
- **Finding:** The gate reads running + queued runs with limit 100 and checks `input.repoPath === repoPath`. It is a point-in-time snapshot, not a lock, so a status transition between the check and `startRun` can stack runs. The comment says "same kind + repo" but the code only compares `repoPath`.
- **Action:** Clarify whether cross-kind concurrency is intentional. If not, compare both `kind` and `repoPath`, and add a DB-level guard (e.g., unique partial index or `INSERT ... WHERE NOT EXISTS`) to make single-flight atomic.

### 3. Cron fallback can enter an infinite drift loop for never-matching expressions
- **File:** `server/cron.ts` lines 62–73
- **Finding:** If an expression never matches within 366 days, the code returns `after + 24h`. That date may not satisfy the expression, causing the scheduler to repeatedly advance by 24 hours without ever dispatching.
- **Action:** Return `null` from `nextCronMatch` when no match exists, disable the schedule, and log a warning so the user can correct the expression.

### 4. `sinceTimestamp` still uses the last fire time, not the last successful run time
- **File:** `server/workflow-engine.ts` lines 990–993; `server/workflow-loader.ts` lines 278–284
- **Finding:** The new SHA gate is supposed to replace the timestamp gate. However, the in-run `validate_repo` step still receives `sinceTimestamp = schedule.lastRunAt` (last fire). On manual trigger or if the SHA gate is bypassed, skipped/failed runs advance `lastRunAt`, so the in-run check can skip commits that were never actually reviewed.
- **Action:** Remove the in-run `sinceTimestamp` check now that pre-dispatch SHA gating exists, or change it to use a new `lastSuccessAt` column. Update `docs/WORKFLOWS.md` line 11, which still describes the old behavior.

---

## Severity: Warning

### 5. Resume logic lacks transaction and uses hardcoded resumable steps
- **File:** `server/workflow-engine.ts` lines 1055–1141
- **Finding:** `resumeInterrupted` scans running rows and calls `executeRun` fire-and-forget for each without a transaction around status check and reset, allowing duplicate resume after repeated restarts. `RESUMABLE_STEPS` is hardcoded to `['run_prompt', 'save_report']` and will drift if step keys change.
- **Action:** Wrap the resume decision in a transaction and set a transient `resuming` status. Derive resumability from step metadata rather than hardcoded keys.

### 6. Default behavior without a session resolver is dangerously permissive
- **File:** `server/workflow-engine.ts` lines 1102–1108
- **Finding:** Without a registered `sessionResolver`, the code treats every interrupted run with a `session_id` as resumable. The comment calls this "conservative," but resuming unknown sessions is optimistic, not conservative. Tests and future callers may rely on this default.
- **Action:** Make the default fail-safe: without a resolver, fail interrupted runs unless explicitly configured otherwise.

### 7. `heldCount` grows unbounded
- **File:** `server/workflow-engine.ts` lines 918–924
- **Finding:** A schedule held every minute accumulates `heldCount` without a cap. Overflow is unlikely but the ever-growing counter is brittle and may confuse UI consumers.
- **Action:** Cap `heldCount` at a maximum (e.g., 9999) or reset it on successful dispatch.

### 8. Heartbeat stale threshold is inconsistent between route and monitor
- **File:** `server/workflow-routes.ts` lines 359–366; `server/orchestrator-monitor.ts` line 196
- **Finding:** The `/engine-health` endpoint uses `3 * 60_000` ms, while the orchestrator monitor uses `5 * 60_000` ms.
- **Action:** Export a shared `ENGINE_HEARTBEAT_STALE_MS` constant and use it in both locations. Document the threshold in `docs/WORKFLOWS.md`.

### 9. UI hold comparison uses lexicographic ISO strings
- **File:** `src/components/workflows/WorkflowRow.tsx` lines 62–65
- **Finding:** `schedule.lastHeldAt > lastRun.createdAt` compares ISO strings. They are usually sortable, but mixed offsets or non-canonical formats can produce wrong ordering.
- **Action:** Parse both values to `Date` objects before comparing.

### 10. `lastReviewedSha` advances even when the run produced no review
- **File:** `server/workflow-engine.ts` lines 651–655
- **Finding:** Any successful run advances the SHA anchor, even if the workflow step produced no actual review output.
- **Action:** Consider requiring an explicit `reviewedSha` output from the workflow step and only advancing the anchor when the step reports it. At minimum, document the current semantic.

### 11. `POST /schedules` cannot set `catchUp`
- **File:** `server/workflow-routes.ts` lines 378–398 and 400–423
- **Finding:** The create endpoint ignores `catchUp`, forcing schedules to default to `collapse` and requiring a separate PATCH to change the catch-up policy.
- **Action:** Add `catchUp?: 'collapse' | 'skip'` to the create body schema and validate it in the POST handler, mirroring PATCH.

### 12. Webhook URL is silently dropped on repo edits
- **File:** `server/workflow-routes.ts` lines 450–516, especially 497–513
- **Finding:** `addReviewRepo` uses `webhookUrl` only when `kind === 'pr-review'`, but the field is not part of persisted `ReviewRepoConfig`. Re-editing a repo loses the webhook setup result.
- **Action:** Persist `webhookUrl` separately or document clearly that it is creation-time only.

### 13. `trigger-dispatch.test.ts` `dueAt` uses wall-clock and may be brittle in CI
- **File:** `server/trigger-dispatch.test.ts` line 14
- **Finding:** `dueAt` returns `Date.now() + ms`. If the CI machine pauses between `beforeEach` and the first tick, the computed due time may lag behind the schedule's actual `nextRunAt`.
- **Action:** Compute `dueAt` from the schedule's actual `nextRunAt` after upsert, or use `vi.useFakeTimers()` for deterministic ticks.

### 14. `setEngine` can register duplicate listeners
- **File:** `server/orchestrator-monitor.ts` lines 62–67
- **Finding:** Each call to `setEngine` adds another `workflow_event` listener. It is currently called once, but the API allows leakage.
- **Action:** Remove the previous listener or throw if `setEngine` is called more than once.

### 15. `fetchCodexModels` may leave zombie processes
- **File:** `server/codex-process.ts` lines 127–178
- **Finding:** After resolving, the function kills the spawned process with `SIGTERM` but does not remove event listeners. If SIGTERM is ignored, there is no SIGKILL fallback.
- **Action:** Clean up listeners after settlement and add a SIGKILL fallback after a short delay.

---

## Severity: Info

### 16. Cron parser tests are shallow
- **File:** `server/cron.ts` and `server/cron.test.ts`
- **Finding:** Tests cover basic `nextCronMatch`, validation, and match agreement, but not steps (`*/15`), ranges (`10-20`), lists (`1,3,5`), or invalid expressions.
- **Action:** Port existing `isValidCron` tests from `workflow-routes.test.ts` and expand coverage for edge cases.

### 17. New workflow API endpoints are undocumented
- **File:** `docs/API-REFERENCE.md` lines 450–553
- **Finding:** `GET /api/workflows/engine-health` and `GET /api/workflows/trigger-ledger` are not documented.
- **Action:** Add subsections with query parameters, response shapes, and example payloads.

### 18. `WorkflowEvent.status` is typed as `string`
- **File:** `server/workflow-engine.ts` lines 36 and 174
- **Finding:** `RunStatus` is strict, but `WorkflowEvent.status` weakens downstream type safety.
- **Action:** Change `WorkflowEvent.status` to `RunStatus` and verify consumers.

### 19. `useWorkflows` does not expose catch-up selection
- **File:** `src/lib/workflowApi.ts` lines 58–71
- **Finding:** `catchUp` is added to the client type but modals and hooks do not let users change it.
- **Action:** Add a catch-up selector in `EditWorkflowModal` or schedule settings.

### 20. Uncommitted changes are trivial but have a noisy diff
- **File:** `src/types.ts`
- **Finding:** Codex model strings are updated consistently, but the trailing newline was removed.
- **Action:** Restore the trailing newline before committing.

### 21. Startup tick has no jitter
- **File:** `server/workflow-engine.ts` lines 1004–1025
- **Finding:** `startCronScheduler` ticks immediately, so all instances that restart together will fire simultaneously.
- **Action:** Add startup jitter or stagger the first tick per schedule in production.

### 22. Ledger pruning is redundant on scheduler restart
- **File:** `server/workflow-engine.ts` lines 1008–1010
- **Finding:** Pruning runs every time the scheduler is stopped and restarted.
- **Action:** Move pruning to the constructor or track a `hasPruned` flag.

### 23. Missing route tests for new endpoints
- **File:** `server/workflow-routes.test.ts`
- **Finding:** `/engine-health` and `/trigger-ledger` lack dedicated route tests.
- **Action:** Add tests following the existing endpoint patterns.

---

## General Observations

- **Test suite:** Healthy (3,007 passing). No regressions detected in the latest commit.
- **Lint:** 559 warnings, all pre-existing style/strictness warnings; no errors introduced by PR #602.
- **Build:** Clean production build. Vite warns about chunk size >500 kB for `App-CTxcIT_-.js` (701 kB); consider dynamic imports or code-splitting.
- **Dependencies:** Production dependency surface is small and current. `multer@2.0.0` is still pre-2.0 stable; monitor for final 2.x release notes.
- **Security:** No SQL injection vectors found in new code. Input validation for cron, repo paths, and status fields is present. XSS surface in `WorkflowRow` is low because React escapes the title attribute, but the comparison and raw-string handling should be hardened.

---

## Recommended Priority Order

1. Fix the per-tick `lastReviewedSha` race (critical #1).
2. Make single-flight atomic or tighten the kind+repo comparison (critical #2).
3. Replace or correct the stale `sinceTimestamp` fallback (critical #4).
4. Guard the cron never-match fallback (critical #3).
5. Align heartbeat stale threshold and document new endpoints (warning #8, info #17).
6. Add route tests for `/engine-health` and `/trigger-ledger` (info #23).
7. Restore the trailing newline in `src/types.ts` and commit the Codex model refresh (info #20).