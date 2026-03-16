## Summary

**Framework:** Vitest 4.1.2 · Coverage provider: v8 (`@vitest/coverage-v8`)
**Run date:** 2026-04-04
**Test result:** 1328 tests · 47 test files · **all passed**

| Metric     | Coverage % | vs 2026-03-23 |
|------------|-----------|---------------|
| Statements | 84.20 %   | +9.01 pp      |
| Branches   | 77.23 %   | +6.61 pp      |
| Functions  | 81.68 %   | +9.33 pp      |
| Lines      | 85.36 %   | +9.20 pp      |

> **Positive trend:** All four metrics improved substantially week-over-week (+9 pp on statements). The previously uncovered server modules (auth-routes, orchestrator-manager, docs-routes, etc.) are now instrumented, and 261 net-new tests were added. No files register 0 % coverage this week.

---

## Uncovered Files

No files with 0 % coverage were detected in this run. All source files included in the coverage report are imported during test execution and have at least partial coverage.

---

## Low Coverage Files

Files sorted by line coverage ascending (top 15):

| File | Stmts % | Branch % | Funcs % | Lines % |
|------|---------|----------|---------|---------|
| `server/session-manager.ts` | 56.61 | 51.63 | 52.63 | 58.26 |
| `src/hooks/useSendMessage.ts` | 70.94 | 69.89 | 80.00 | 74.46 |
| `src/lib/ccApi.ts` | 76.25 | 73.38 | 78.26 | 78.10 |
| `.claude/hooks/lib/presets/completion-gate.mjs` | 76.74 | 68.08 | 100.00 | 83.33 |
| `.claude/hooks/lib/handler.mjs` | 83.33 | 80.00 | 100.00 | 81.81 |
| `.claude/hooks/lib/presets/auto-lint.mjs` | 93.10 | 72.22 | 100.00 | 100.00 |
| `server/webhook-workspace.ts` | 88.13 | 68.75 | 100.00 | 88.13 |
| `server/workflow-engine.ts` | 90.61 | 76.53 | 88.23 | 92.47 |
| `server/webhook-handler.ts` | 90.09 | 74.60 | 91.66 | 89.58 |
| `server/claude-process.ts` | 88.43 | 78.62 | 72.72 | 88.56 |
| `server/diff-manager.ts` | 89.58 | 77.52 | 69.23 | 89.28 |
| `src/hooks/useWsConnection.ts` | 89.60 | 84.09 | 81.48 | 96.00 |
| `src/hooks/useChatSocket.ts` | 91.25 | 86.99 | 86.48 | 92.14 |
| `server/webhook-handler-base.ts` | 93.33 | 73.33 | 90.90 | 96.00 |
| `src/hooks/useSessionOrchestration.ts` | 95.12 | 67.56 | 100.00 | 98.50 |

---

## Prioritised Test Proposals

1. **`server/session-manager.ts` — `buildSessionContext()`**
   Test via `startClaude` or a direct instance with: (a) an empty history returning `null`; (b) a history mixing `user_echo`, `output`, `tool_active`, `tool_done`, and `result` events producing the expected summary string; (c) a history whose joined text exceeds 4 000 chars, asserting the oldest lines are shifted off until it fits within the cap.
   **Rationale:** This path is exercised on every server restart where Claude has no saved session ID — a regression here silently discards conversation context for all resuming sessions.

2. **`server/session-manager.ts` — `addToHistory()` oversized-output splitting (lines 1953–1960)**
   Pass a `msg.data` string longer than `MAX_OUTPUT_CHUNK` (50 000 chars) and assert: the history contains multiple bounded `output` entries; no single entry exceeds the chunk limit; `persistToDiskDebounced` is called.
   **Rationale:** The merge path is tested; the split path for very large Claude outputs is not, leaving a silent history-corruption risk for long-running multi-step tasks.

3. **`server/session-manager.ts` — `handleApiRetry()` and `isRetryableApiError()`**
   Test that: (a) a known retryable error string (`overloaded_error`) triggers retry with stripped output and an incremented counter; (b) a non-retryable error falls through to `finalizeResult`; (c) the counter caps at the configured maximum and stops retrying.
   **Rationale:** These methods guard against Claude API overload cascades; at 52 % function coverage, many retry branches (including the cap) are completely untested.

4. **`src/hooks/useSendMessage.ts` — file-upload queuing path (lines 142–158)**
   Mock `uploadAndBuildMessage` to resolve and to reject, exercising the branch where `queueEnabled` is true and a conflict exists: (a) files uploaded then queued via `addToQueue`; (b) upload failure falls back to queuing text-only; (c) `uploadStatus` transitions `'Uploading files...'` → `null`.
   **Rationale:** The upload-then-queue code path handles concurrent sessions — the most common real-world usage pattern — and its error branch is entirely unreachable by current tests.

5. **`src/hooks/useSendMessage.ts` — `handleExecuteTentative()` with files (lines 184–188)**
   Exercise `handleExecuteTentative` with a queue entry that has `files.length > 0`, asserting that `uploadAndBuildMessage` is called and its result is passed to `sendInput`. Also test the catch branch where the upload throws, asserting `sendInput` falls back to `entry.text`.
   **Rationale:** The tentative-queue execution is the critical path for deferred messages in multi-session workflows; the file-upload variant is currently unreachable by tests.

6. **`src/lib/ccApi.ts` — orchestrator API functions (lines 148–237)**
   Add tests for `getOrchestratorStatus`, `startOrchestrator`, `getOrchestratorReports`, `spawnOrchestratorChild`, `queryOrchestratorMemory`, and `getOrchestratorNotifications` by mocking `fetch`/`authFetch`. Cover: (a) successful JSON response returned; (b) non-OK response throws with a message including the HTTP status code; (c) URL query parameters are correctly serialised for `getOrchestratorReports` and `queryOrchestratorMemory`.
   **Rationale:** The entire orchestrator API surface (~90 lines, lines 148–237) is uncovered; these functions are called by multiple UI components and the orchestrator dashboard.

7. **`server/webhook-workspace.ts` — `createWorkspace()` partial-workspace cleanup on failure (lines 162–166)**
   Mock `execFileAsync` to throw during `git clone`, then assert: the workspace directory is removed; the warning is logged. Also test the nested failure branch where `rmSync` itself throws, ensuring no unhandled exception escapes.
   **Rationale:** This cleanup prevents disk exhaustion from failed webhook-triggered clones of private repositories; the dual-failure case is a silent swallow with no current coverage.

8. **`server/webhook-workspace.ts` — `createWorkspace()` URL and branch validation (lines 103–110)**
   Pass (a) an `ssh://`-scheme `cloneUrl`, (b) a URL with path traversal, and (c) a `branch` name containing `..`, asserting that `Error` is thrown with the expected message and the partial workspace directory is cleaned up in each case.
   **Rationale:** These are security-critical input validators for public GitHub webhook payloads arriving from the internet; branch coverage is only 68.75 %, indicating the rejection branches are untested.

9. **`.claude/hooks/lib/presets/completion-gate.mjs` — `detectInstallCommand()` and `ensureDepsInstalled()` (lines 24–27, 38–39)**
   Using `tmpdir`, create fake lockfiles (`yarn.lock`, `pnpm-lock.yaml`, `bun.lockb`) and assert the correct install command string is returned for each. Test `ensureDepsInstalled` where `execSync` throws, verifying the function swallows the error rather than propagating it.
   **Rationale:** These helpers run before every test gate in CI; a wrong package manager command causes silent install failures that mask real test errors, yet the variant-detection branches are uncovered.

10. **`server/diff-manager.ts` — `discardChanges()` and untested methods (lines 279–284, 311–312)**
    Test `discardChanges` with a list of specific file paths: mock `execGit` to capture arguments and verify the correct `git checkout HEAD --` invocation. Verify the chunked path is taken when the file list exceeds `GIT_PATH_CHUNK_SIZE`. Also test the `getFileStatuses` function with staged-only and unstaged-only inputs.
    **Rationale:** `DiffManager` has only 69.23 % function coverage; `discardChanges` is a destructive operation invoked from the UI diff panel and requires correctness guarantees before merging code that touches it.
