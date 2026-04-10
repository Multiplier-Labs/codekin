# Test Coverage Report — 2026-04-10

**Framework**: Vitest v4.1.2 with `@vitest/coverage-v8`  
**Test run**: 1355 tests across 48 test files — all passing  
**Command**: `npx vitest run --coverage --coverage.reporter=text`

---

## Summary

| Metric     | Coverage % |
|------------|-----------|
| Statements | 81.97%    |
| Branches   | 74.61%    |
| Functions  | 79.18%    |
| Lines      | 83.06%    |

---

## Uncovered Files

No files recorded at exactly 0% coverage in this run. All source files included in the coverage report have at least partial test coverage.

---

## Low Coverage Files

Files below 70% line coverage, sorted by statement coverage ascending (top 15):

| File | Stmts % | Branch % | Funcs % | Lines % |
|------|---------|----------|---------|---------|
| `server/session-lifecycle.ts` | 35.56 | 31.00 | 11.53 | 41.10 |
| `server/orchestrator-children.ts` | 35.71 | 17.14 | 31.81 | 39.00 |
| `server/prompt-router.ts` | 60.86 | 63.38 | 68.18 | 61.15 |
| `server/session-manager.ts` | 59.90 | 49.84 | 56.55 | 61.17 |
| `src/hooks/useSendMessage.ts` | 70.94 | 69.89 | 80.00 | 74.46 |
| `server/session-persistence.ts` | 78.94 | 62.50 | 100.00 | 77.14 |
| `server/ws-message-handler.ts` | 90.29 | 74.60 | 92.30 | 89.69 |
| `server/webhook-handler.ts` | 90.29 | 74.60 | 92.30 | 89.69 |
| `server/workflow-engine.ts` | 90.61 | 76.53 | 88.23 | 92.47 |
| `server/webhook-workspace.ts` | 88.13 | 68.75 | 100.00 | 88.13 |
| `server/diff-manager.ts` | 89.58 | 77.52 | 69.23 | 89.28 |
| `.claude/hooks/lib/presets/completion-gate.mjs` | 76.74 | 68.08 | 100.00 | 83.33 |
| `server/terminal-manager.ts` | 90.82 | 86.66 | 86.36 | 91.12 |
| `server/claude-process.ts` | 86.87 | 78.43 | 70.27 | 86.86 |
| `server/stepflow-handler.ts` | 92.96 | 88.17 | 85.71 | 94.26 |

---

## Prioritised Test Proposals

1. **`server/session-lifecycle.ts` — `SessionLifecycle.startClaude` — process spawn and event wiring**  
   _Scenario_: Verify that `startClaude` spawns a `ClaudeProcess`, wires all event handlers (`onSystemInit`, `onTextEvent`, `onToolActiveEvent`, etc.), and broadcasts a `session_started` message via the injected `deps`.  
   _Rationale_: This file sits at 35% statement / 11% function coverage — it is the critical path for starting every Claude session. The dependency-injection interface (`SessionLifecycleDeps`) makes it straightforward to mock all deps and unit-test the lifecycle in isolation, with no child process actually spawned.

2. **`server/session-lifecycle.ts` — `handleClaudeExit` — auto-restart logic**  
   _Scenario_: Test the exit handler with (a) a clean exit code, (b) an error exit, (c) the `evaluateRestart` returning a restart delay, and (d) a restart that succeeds vs. one that finds the session gone.  
   _Rationale_: Auto-restart is a reliability feature; the branch coverage of 31% strongly suggests the restart and non-restart branches are largely untested.

3. **`server/orchestrator-children.ts` — `OrchestratorChildManager.spawn` — child session creation and status tracking**  
   _Scenario_: Verify that `spawn` creates a `ChildSession` with status `starting`, transitions it to `running` when the underlying session becomes active, and eventually records `completed` or `failed` based on the session outcome. Also test timeout behaviour when the session never becomes ready.  
   _Rationale_: At 35% statement / 17% branch coverage this is the most under-tested file in the codebase and is central to orchestrated multi-agent workflows.

4. **`server/prompt-router.ts` — `PromptRouter` — tool approval flow (`resolveToolApproval`)**  
   _Scenario_: Test the full approval decision tree: (a) tool already in session `allowedTools` → auto-approve; (b) tool in the global registry with `always` → auto-approve; (c) headless mode with no registry entry → auto-deny; (d) interactive approval request with a `deny` response; (e) `alwaysAllow` response that persists the entry.  
   _Rationale_: `resolveToolApproval` is private but heavily branched (63% branch coverage). Testing it via the public `handlePreToolUse` surface will cover the most critical security decision in the application.

5. **`server/session-manager.ts` — `SessionManager.createSession` and `deleteSession`**  
   _Scenario_: Create a session with valid options and verify it appears in `getSessions()`; delete it and verify it is removed; attempt to delete a non-existent session and confirm graceful failure.  
   _Rationale_: `SessionManager` is the largest file in the server (1521 lines, 59% coverage). `createSession`/`deleteSession` are the foundation of all other behaviour and are exercised only indirectly in existing tests.

6. **`src/hooks/useSendMessage.ts` — `handleSend` — tentative queue path**  
   _Scenario_: Set up a scenario where another session for the same `workingDir` is `isProcessing = true`, call `handleSend`, and assert that `addToQueue` is called rather than `sendInput`. Also test the auto-execute `useEffect` path by flipping `isProcessing` to false and verifying `handleExecuteTentative` fires.  
   _Rationale_: The queue path (lines 138–158) is flagged as uncovered. It is the only mechanism that prevents concurrent conflicting writes to the same repo, making it high-risk if broken.

7. **`src/hooks/useSendMessage.ts` — `handleSend` — file-upload failure fallback**  
   _Scenario_: Mock `uploadAndBuildMessage` to reject, then call `handleSend` with a non-empty `pendingFiles` array. Assert that `sendInput` is still called with the text-only payload and that `uploadStatus` eventually resets to `null`.  
   _Rationale_: Lines 172–174 (upload failure branch) are uncovered. Silent failure here would drop user messages.

8. **`server/session-persistence.ts` — `SessionPersistence` — round-trip serialisation**  
   _Scenario_: Call `persist()` with a set of sessions, then call `load()` with a fresh instance against the same SQLite file, and assert that all session fields (id, name, workingDir, history, etc.) survive the round-trip. Also test the behaviour when the DB file does not exist (first boot).  
   _Rationale_: 62.5% branch coverage indicates the conditional paths for missing/corrupt DB are untested; persistence bugs cause complete session loss on server restart.

9. **`server/ws-message-handler.ts` — unknown or malformed message types**  
   _Scenario_: Send a WebSocket message with an unrecognised `type` field, a missing `sessionId`, and a message whose JSON is syntactically invalid. Assert that none of these crash the handler and that an appropriate error (or silence) is returned.  
   _Rationale_: The 74% branch coverage strongly suggests defensive paths are skipped. A malformed message from a browser client or webhook could otherwise bring down the WebSocket server.

10. **`.claude/hooks/lib/presets/completion-gate.mjs` — gate rejection and pass-through scenarios**  
    _Scenario_: Test (a) a tool call that is on the block-list → gate rejects; (b) a tool call that passes all checks → gate allows; (c) a gate invocation when the session has no active plan → should pass through without error.  
    _Rationale_: 68% branch coverage on this hook means some gate conditions are never exercised. The completion gate is a last-line-of-defence against unintended destructive actions during autonomous runs.
