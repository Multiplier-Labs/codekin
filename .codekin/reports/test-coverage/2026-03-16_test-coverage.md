## Summary

**Framework:** Vitest 4.0.18 · Coverage provider: v8 (`@vitest/coverage-v8`)
**Run date:** 2026-03-16
**Test result:** 36 test files · 945 tests · **all passed**

| Metric    | Coverage % |
|-----------|-----------|
| Statements | 79.16 %  |
| Branches   | 71.99 %  |
| Functions  | 80.34 %  |
| Lines      | 80.06 %  |

---

## Uncovered Files

Files with 0 % (or effectively 0 %) coverage:

- `server/diff-parser.ts` — **0.91 % Stmts / 0 % Branch / 0 % Funcs** (lines 25–239 uncovered; only the module-level constant and type imports are exercised)

---

## Low Coverage Files

Files below 80 % line coverage, sorted by line % ascending (top 15):

| File | Stmts % | Branch % | Funcs % | Lines % |
|------|---------|----------|---------|---------|
| `server/diff-parser.ts` | 0.91 | 0.00 | 0.00 | 0.98 |
| `server/session-manager.ts` | 57.14 | 51.67 | 61.16 | 58.07 |
| `server/workflow-loader.ts` | 70.85 | 63.15 | 50.00 | 73.44 |
| `src/hooks/usePromptState.ts` | 71.42 | 56.52 | 100.00 | 79.16 |
| `server/approval-manager.ts` | 74.68 | 74.86 | 80.95 | 74.09 |
| `src/lib/ccApi.ts` | 80.55 | 78.57 | 74.19 | 79.46 |
| `server/workflow-engine.ts` | 84.36 | 69.14 | 79.41 | 86.48 |
| `server/stepflow-workspace.ts` | 88.13 | 68.75 | 100.00 | 88.13 |
| `src/hooks/useChatSocket.ts` | 86.73 | 76.02 | 82.22 | 88.35 |
| `server/webhook-handler.ts` | 89.89 | 72.88 | 91.66 | 89.36 |
| `.claude/hooks/lib/presets/auto-lint.mjs` | 93.10 | 72.22 | 100.00 | 100.00 |
| `server/webhook-handler-base.ts` | 93.33 | 73.33 | 90.90 | 96.00 |
| `server/session-naming.ts` | 93.67 | 82.53 | 100.00 | 100.00 |
| `server/stepflow-handler.ts` | 92.96 | 88.17 | 85.71 | 94.26 |
| `src/hooks/useWebSocketConnection.ts` | 89.60 | 84.09 | 81.48 | 96.00 |

---

## Prioritised Test Proposals

1. **`server/diff-parser.ts` — `parseDiff` — core unified-diff parsing**
   - **Scenario:** Parse a typical multi-file `git diff` string containing additions, deletions, renamed files, binary files, and context lines; assert the returned `DiffFile[]` array contains correct `status`, `additions`, `deletions`, and `hunks`.
   - **Also cover:** truncation path — pass a string whose `Buffer.byteLength` exceeds `DEFAULT_MAX_BYTES` and assert `truncated === true` and `truncationReason` is set.
   - **Rationale:** This is the *only* file with 0 % function and branch coverage despite being a pure-function parser with no external dependencies — the easiest possible file to unit-test and the highest-impact gap (all git-diff UI features depend on it).

2. **`server/session-manager.ts` — `getDiff` / `discardChanges` — git diff scopes**
   - **Scenario:** Mock `execGit` to return a sample diff string for each scope (`staged`, `unstaged`, `all`); assert that the correct `git diff` arguments are passed and that the returned `WsServerMessage` has `type: 'diff_result'` with parsed files. Also test the `scope === 'all'` fallback path where `git diff HEAD` throws and falls back to staged + unstaged.
   - **Rationale:** Lines 1304–1511 (the two diff-related methods) are among the largest uncovered blocks; they also exercise `parseDiff`, further increasing the value of covering them.

3. **`server/session-manager.ts` — `setModel` / `stopClaude` — model-change restart**
   - **Scenario:** Create a session with a live `claudeProcess` stub; call `setModel` with a new model string; assert `stopClaude` is called, a `setTimeout` fires, and `startClaude` is invoked with the new model. Separately test `setModel` when `claudeProcess` is `null` (no restart expected).
   - **Rationale:** Uncovered lines 1122–1146 cover critical user-facing model-switching behaviour; branch coverage on the "is alive?" guard is currently missing.

4. **`server/approval-manager.ts` — `checkAutoApproval` / `checkCrossRepoApproval` — cross-repo inference**
   - **Scenario:** Pre-populate two repos each having approved the same `git push origin main` command; call `checkAutoApproval` for a *third* repo (not in the set) and assert it returns `true` because `CROSS_REPO_THRESHOLD` (2) is met. Also test that a command approved in only one repo does *not* cross-approve.
   - **Rationale:** Branch coverage for approval-manager is 74.86 %. The cross-repo inference path is a security-relevant feature: incorrect behaviour could silently auto-approve dangerous commands.

5. **`server/approval-manager.ts` — `derivePattern` / `compactExactCommands` — pattern derivation**
   - **Scenario:** Add several exact `git push origin feat/a`, `git push origin feat/b` commands for one repo; call `compactExactCommands` and assert the patterns set contains `git push *` and the commands set is cleared. Then verify a new `git push origin feat/c` is matched by `checkRepoApproval`.
   - **Rationale:** These functions contain the prefix-grouping logic that reduces approval fatigue; uncovered branches here risk silent regressions in UI "Always allow" flows.

6. **`server/diff-parser.ts` — `parseFileSection` — edge-case file statuses**
   - **Scenario:** Pass diff sections for (a) a deleted file (`--- a/file` + `/dev/null`), (b) a renamed file (`rename from` / `rename to`), and (c) a binary file (`Binary files ... differ`); assert the returned `DiffFile` objects carry the correct `status` (`deleted`, `renamed`, `added`/`modified`) and `isBinary` flag.
   - **Rationale:** All internal helper functions in `diff-parser.ts` are at 0 % coverage; the binary and rename paths are exercised only if specifically crafted test inputs are provided.

7. **`src/hooks/usePromptState.ts` — `dismiss` — queue management edge cases**
   - **Scenario (branch lines 68–72):** Call `dismiss()` with no argument on a queue of two entries; assert the *oldest* entry is removed and the newer one becomes `active`. Also call `dismiss()` on an empty queue and assert the queue remains empty (the early-return guard on `prev.size === 0`).
   - **Rationale:** Branch coverage is 56.52 % (the lowest in `src/hooks/`). The multi-prompt queue was a regression fix; the dismissal ordering logic is not yet tested.

8. **`server/workflow-loader.ts` — `discoverRepoWorkflows` / `ensureRepoWorkflowsRegistered` — repo workflow discovery**
   - **Scenario:** Create a temporary directory with a `.codekin/workflows/` folder containing one valid and one invalid MD file; call `discoverRepoWorkflows`; assert only the valid workflow is returned. Then call `ensureRepoWorkflowsRegistered` twice with the same repo path and assert the second call is a no-op (the `registeredRepoKinds` guard).
   - **Rationale:** Function coverage is 50 % — half of exported functions are untested. Repo-level workflow discovery is the extension point used by end-users; breakage would be silent.

9. **`src/lib/ccApi.ts` — `getRetentionDays` / `setRetentionDays` / `getReposPath` / `setReposPath` / `browseDirs` — settings API functions**
   - **Scenario:** Mock `fetch` (or `authFetch`) to return 200 and a JSON body for each endpoint; assert the returned value matches the mock payload. Also assert that a non-2xx response causes the function to throw with the server error message.
   - **Rationale:** Lines 274–331 (five API wrapper functions) have no tests. These are called directly from settings UI components; undetected regressions could silently break settings persistence.

10. **`server/workflow-engine.ts` — `WorkflowEngine.resumeRun` / stale-step recovery — error path branches**
    - **Scenario:** Start a run, kill the engine process mid-step (simulate by rejecting the step function), then construct a new `WorkflowEngine` against the same DB file; assert the stale `running` step is marked `failed` on re-init and that `getRunStatus` reflects the failure. Also cover the `cancelRun` path for an already-completed run.
    - **Rationale:** Branch coverage is 69.14 % for the engine; the crash-recovery and cancellation paths are critical for workflow reliability but are absent from the current test suite.
