## Summary

**Framework:** Vitest 4.0.18 · Coverage provider: v8 (`@vitest/coverage-v8`)
**Run date:** 2026-03-23
**Test result:** 1067 tests · **all passed**

| Metric     | Coverage % | vs 2026-03-16 |
|------------|-----------|---------------|
| Statements | 75.19 %   | -3.97 pp      |
| Branches   | 70.62 %   | -1.37 pp      |
| Functions  | 72.35 %   | -7.99 pp      |
| Lines      | 76.16 %   | -3.90 pp      |

> **Trend warning:** All four metrics dropped week-over-week despite the test count growing from 945 to 1,067. New code (orchestrator modules, stepflow, additional server routes) was merged without corresponding test coverage, pulling the aggregate down.

---

## Uncovered Files

Files with 0 % coverage (never imported during the test run — v8 only instruments loaded modules):

**Server**
- `server/auth-routes.ts` — Express auth route handlers
- `server/commit-event-handler.ts` — commit event processing logic
- `server/commit-event-hooks.ts` — hooks triggered on commit events
- `server/docs-routes.ts` — documentation serving routes
- `server/error-page.ts` — HTML error-page renderer
- `server/orchestrator-children.ts` — child-session orchestration
- `server/orchestrator-learning.ts` — orchestrator learning/adaptation logic
- `server/orchestrator-manager.ts` — top-level orchestrator lifecycle manager
- `server/orchestrator-memory.ts` — orchestrator memory persistence
- `server/orchestrator-monitor.ts` — orchestrator health monitoring
- `server/orchestrator-reports.ts` — orchestrator report generation
- `server/orchestrator-routes.ts` — Express routes for orchestrator API
- `server/session-routes.ts` — session CRUD HTTP routes
- `server/session-restart-scheduler.ts` — automatic session restart scheduling
- `server/stepflow-prompt.ts` — stepflow prompt construction
- `server/upload-routes.ts` — file upload HTTP routes
- `server/version-check.ts` — CLI version check utility
- `server/webhook-routes.ts` — webhook HTTP routing
- `server/workflow-routes.ts` — workflow HTTP routes
- `server/ws-server.ts` — WebSocket server bootstrap

**Frontend**
- `src/hooks/useDiff.ts` — diff state management hook
- `src/hooks/useDocsBrowser.ts` — docs browser hook
- `src/hooks/useIsMobile.ts` — responsive breakpoint hook
- `src/hooks/useRepos.ts` — repository list hook
- `src/hooks/useSendMessage.ts` — message-send orchestration hook
- `src/hooks/useTentativeQueue.ts` — optimistic message queue hook
- `src/hooks/useWorkflows.ts` — workflow list/trigger hook
- `src/lib/hljs.ts` — highlight.js initialisation helper
- `src/lib/slashCommands.ts` — slash-command registry and parser

---

## Low Coverage Files

Files with < 80 % line coverage that *were* exercised, sorted by line % ascending (top 15):

| File | Stmts % | Branch % | Lines % |
|------|---------|----------|---------|
| `src/hooks/useSessionOrchestration.ts` | 1.21 | 5.40 | 1.49 |
| `server/diff-manager.ts` | 2.77 | 0.00 | 2.85 |
| `server/ws-message-handler.ts` | 23.42 | 24.19 | 25.24 |
| `server/native-permissions.ts` | 46.57 | 40.62 | 47.61 |
| `src/lib/ccApi.ts` | 58.90 | 61.87 | 59.76 |
| `server/session-manager.ts` | 60.16 | 56.73 | 61.16 |
| `server/workflow-loader.ts` | 70.85 | 63.15 | 73.44 |
| `server/approval-manager.ts` | 79.42 | 80.60 | 77.64 |
| `.claude/hooks/lib/presets/completion-gate.mjs` | 76.74 | 68.08 | 83.33 |
| `server/workflow-engine.ts` | 84.50 | 69.38 | 86.55 |
| `server/webhook-handler.ts` | 89.89 | 72.88 | 89.36 |
| `server/webhook-workspace.ts` | 88.13 | 68.75 | 88.13 |

---

## Prioritised Test Proposals

1. **`server/diff-manager.ts` — all public methods (apply, revert, list diffs)**
   - *Scenario:* Create a `DiffManager` instance backed by an in-memory or tmp SQLite DB; apply a synthetic unified diff; assert the stored diff can be retrieved; call revert and assert the file is restored.
   - *Rationale:* 2.77 % statements with 0 % branch coverage on a module that manages destructive file mutations. Any regression here is undetectable.

2. **`src/hooks/useSessionOrchestration.ts` — session lifecycle transitions**
   - *Scenario:* Use `renderHook` (vitest-browser or jsdom) to mount the hook; drive it through `idle → running → stopped` states via mock WebSocket messages; assert the exported state values at each transition.
   - *Rationale:* 1.21 % statement coverage on the hook that coordinates the entire frontend session lifecycle. It is exercised in production on every user session but is essentially untested.

3. **`server/ws-message-handler.ts` — inbound WebSocket message routing**
   - *Scenario:* Instantiate the handler with mock session-manager and approval-manager stubs; fire each recognised message type (`tool_use`, `approval`, `ping`, unknown); assert the correct handler branch is invoked and the correct response is sent.
   - *Rationale:* 23 % coverage on the central dispatcher for all real-time client↔server communication. The 75 % of uncovered branches includes error paths and tool-approval flows that are critical for correctness.

4. **`server/native-permissions.ts` — permission grant/deny/check**
   - *Scenario:* Test `checkPermission` with each permission level (allow, deny, ask); verify that a denied tool returns the correct rejection shape; test that `glob`-style patterns match tool names correctly.
   - *Rationale:* 40.62 % branch coverage on the security-critical module that decides whether Claude is allowed to execute a given tool. Uncovered branches likely include edge cases in pattern matching that could be exploited.

5. **`server/orchestrator-manager.ts` — orchestrator start/stop/spawn**
   - *Scenario:* Unit-test the public API with a mock child-process spawner; assert that `start()` registers the correct state, `stop()` tears down children, and that a crashed child triggers the expected restart logic.
   - *Rationale:* 0 % coverage on the component that manages long-running multi-agent orchestrations. No tests at all means silent breakage on every deploy.

6. **`server/session-manager.ts` — `createSession` / `destroySession` / `getSession`**
   - *Scenario:* The existing tests cover ~60 %. Focus new tests on the uncovered lines around session timeout logic, the `worktree` attach/detach path, and the `allowedTools` mutation path (lines ~1400–1466 per the coverage output).
   - *Rationale:* Session management is the highest-traffic server code path; the uncovered 39 % includes timeout and tool-permission mutations that affect every active user.

7. **`src/lib/ccApi.ts` — `uploadFile`, `deleteFile`, `listFiles` API calls**
   - *Scenario:* Mock `fetch` with `vi.spyOn`; call each uncovered method (lines 264–266, 417–484); assert the correct endpoint, method, and headers are used, and that error responses surface as rejected promises.
   - *Rationale:* 58.9 % coverage. The uncovered methods (file management and a large block in the lower half of the file) are called from user-facing UI flows and have no test safety net.

8. **`src/hooks/useSendMessage.ts` — message queuing and dispatch**
   - *Scenario:* Mock the WebSocket connection hook; call `sendMessage` with text, with an attachment, and while offline; assert the tentative queue is updated and drained correctly, and that the offline case returns a recoverable error state.
   - *Rationale:* 0 % coverage on the primary user-action hook. Every message a user sends passes through this code.

9. **`src/lib/slashCommands.ts` — command parsing and registry lookup**
   - *Scenario:* Test `parseSlashCommand` with valid `/command arg` input, bare `/`, an unknown command, and a command with multiple spaces; assert the returned `{name, args}` shape or null for unknown commands.
   - *Rationale:* 0 % coverage on the parser that powers all skill invocations. Parsing bugs here silently swallow user intent.

10. **`server/workflow-loader.ts` — YAML workflow loading and validation**
    - *Scenario:* Point the loader at a temp directory containing a valid workflow YAML, a YAML missing required fields, and an unparseable file; assert that valid files are returned, and that invalid/unparseable files produce structured errors rather than uncaught exceptions.
    - *Rationale:* 63.15 % branch coverage and 50 % function coverage. The un-hit branches include the error-handling paths for malformed workflow definitions that operators will encounter when authoring custom workflows.
