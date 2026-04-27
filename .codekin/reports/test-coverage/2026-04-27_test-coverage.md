# Test Coverage Report: codekin

**Date**: 2026-04-27  
**Branch**: docs/audit-reports-2026-04-18  
**Framework**: Vitest v4.1.2 + @vitest/coverage-v8  
**Test run**: 1 795 tests across 67 test files — all passed  

---

## Summary

| Metric     | Coverage % |
|------------|------------|
| Statements | 77.56 %    |
| Branches   | 69.97 %    |
| Functions  | 76.86 %    |
| Lines      | 78.73 %    |

Coverage is collected only from files imported during the test run (v8 default, `coverage.all` not enabled). Files that are never imported by any test are absent from the table and have effective 0 % coverage.

---

## Uncovered Files

These source files were not imported by any test and received no coverage instrumentation. They represent completely untested code paths.

**Server**
- `server/commit-event-handler.ts`
- `server/error-page.ts`
- `server/orchestrator-learning-router.ts`
- `server/orchestrator-memory-router.ts`
- `server/orchestrator-memory.ts`
- `server/orchestrator-monitor.ts`
- `server/orchestrator-routes.ts`
- `server/orchestrator-session-router.ts`
- `server/stepflow-prompt.ts`
- `server/version-check.ts`
- `server/webhook-routes.ts`
- `server/webhook-setup-routes.ts`

**Frontend hooks** (`src/hooks/`)
- `src/hooks/useDocsBrowser.ts`
- `src/hooks/useDiff.ts`
- `src/hooks/useErrorNotification.ts`
- `src/hooks/useGlobalKeyBindings.ts`
- `src/hooks/useIsMobile.ts`
- `src/hooks/useOpenCodeModelSync.ts`
- `src/hooks/useOutsideClick.ts`
- `src/hooks/useProviderValidation.ts`
- `src/hooks/useRepos.ts`
- `src/hooks/useTentativeQueue.ts`
- `src/hooks/useWorkflows.ts`

**Frontend lib** (`src/lib/`)
- `src/lib/hljs.ts`

---

## Low Coverage Files

Files with measured coverage below 80 % line coverage, sorted ascending by line %.

| File | Stmt % | Branch % | Func % | Line % |
|------|-------:|--------:|-------:|-------:|
| `server/upload-routes.ts` | 3.91 | 0.00 | 5.00 | 4.19 |
| `server/opencode-process.ts` | 35.96 | 37.20 | 41.66 | 37.47 |
| `server/orchestrator-reports.ts` | 39.58 | 50.00 | 16.66 | 43.90 |
| `server/webhook-workspace.ts` | 46.55 | 46.15 | 83.33 | 49.09 |
| `server/webhook-handler.ts` | 50.00 | 34.30 | 56.00 | 49.72 |
| `server/webhook-github-setup.ts` | 55.71 | 51.85 | 56.25 | 57.14 |
| `server/session-manager.ts` | 66.12 | 56.67 | 56.92 | 67.79 |
| `server/session-routes.ts` | 67.38 | 52.00 | 86.48 | 67.48 |
| `server/workflow-routes.ts` | 67.82 | 69.65 | 68.00 | 70.65 |
| `src/hooks/useSendMessage.ts` | 70.94 | 69.89 | 80.00 | 74.46 |
| `server/prompt-router.ts` | 77.09 | 72.88 | 81.81 | 77.91 |
| `server/session-persistence.ts` | 78.94 | 65.38 | 100.00 | 77.14 |
| `server/webhook-config.ts` | 79.24 | 88.88 | 60.00 | 77.77 |
| `server/auth-routes.ts` | 78.94 | 64.70 | 77.77 | 81.81 |
| `server/session-lifecycle.ts` | 79.91 | 70.33 | 29.62 | 88.65 |

> **Notable**: `server/session-lifecycle.ts` reports 88.65 % line coverage but only **29.62 % function coverage**, meaning most of its exported functions are never invoked in any test.

---

## Prioritised Test Proposals

1. **`server/upload-routes.ts` — all route handlers**  
   _Scenario_: POST `/upload` with a valid multipart file; assert the file is saved and a 200 response is returned. Add a test for oversized payload (413) and an unsupported MIME type (400).  
   _Rationale_: Only 3.91 % of statements are executed. File-upload logic is a security-sensitive boundary (path traversal, size limits, MIME sniffing) and is entirely dark to the test suite.

2. **`server/opencode-process.ts` — `start`, `stop`, and output streaming**  
   _Scenario_: Mock the child-process spawn; assert that `start()` populates the process handle, that streaming output emits the correct events, and that `stop()` sends SIGTERM and resolves.  
   _Rationale_: OpenCode is a second coding provider (35.96 % stmts). Its process lifecycle mirrors `claude-process.ts`, which has 87 % coverage — the same test patterns can be adapted directly.

3. **`server/orchestrator-reports.ts` — `listReports` and `serveReport`**  
   _Scenario_: Create a temp directory tree matching `.codekin/reports/<category>/YYYY-MM-DD_name.md`; call `listReports` and assert the returned list; call `serveReport` with a valid path and with a path-traversal attempt (expect rejection).  
   _Rationale_: Only 16.66 % of functions are covered. The security-critical path-validation logic (symlink escape, REPOS_ROOT boundary) already has tests for `readReport` but the listing and serving helpers are untested.

4. **`server/webhook-handler.ts` — event dispatch branches**  
   _Scenario_: Simulate `push`, `pull_request` (opened, synchronize, closed), and `check_run` (completed) payloads; assert the correct downstream handler is called for each. Also test the fallthrough for an unrecognised event type.  
   _Rationale_: 34.30 % branch coverage on the primary GitHub-webhook dispatch table means most event types are never exercised. A missed branch here silently swallows real CI events.

5. **`server/session-lifecycle.ts` — `destroySession`, `reconfigureSession`, `renameSession`**  
   _Scenario_: Build a minimal stub `SessionManager`; call each function; assert the expected manager methods are invoked and that the WebSocket broadcast carries the correct message type.  
   _Rationale_: Function coverage is 29.62 % despite reasonable line coverage, which means complete functions are skipped. `destroySession` and `reconfigureSession` are critical paths exercised during every session teardown.

6. **`server/webhook-workspace.ts` — `createWorkspace` and workspace cleanup**  
   _Scenario_: Mock `fs.mkdir` and `git clone`; assert a workspace directory is created at the expected path, that credentials are injected, and that `destroyWorkspace` removes the directory. Test the error path when clone fails.  
   _Rationale_: 46.55 % statement coverage on code that prepares the on-disk environment for each webhook run. A bug here would corrupt every automated code-fix session silently.

7. **`server/session-manager.ts` — `createSession`, `deleteSession`, `getSessionsByRepo`**  
   _Scenario_: Instantiate `SessionManager` against an in-memory SQLite database (as used in existing tests); create multiple sessions across two repos; delete one; assert correct isolation between repos.  
   _Rationale_: Session management is the core of the server (56.92 % function coverage). Many CRUD operations are only reachable through integration tests that do not exist.

8. **`server/webhook-github-setup.ts` — `installWebhook` and `deleteWebhook`**  
   _Scenario_: Mock the GitHub REST API responses; call `installWebhook` and assert the correct POST payload is sent; simulate a 422 (already exists) response and assert idempotent behaviour.  
   _Rationale_: GitHub setup is called once per repo and hard to exercise manually. 51.85 % branch coverage means half the conditional paths (auth errors, rate-limit retries, existing-hook detection) are dark.

9. **`src/hooks/useSendMessage.ts` — retry logic and optimistic cancellation**  
   _Scenario_: Render the hook with a mock WebSocket that rejects the first send; assert the hook retries and eventually resolves. Also assert that calling cancel before the response arrives discards the pending message.  
   _Rationale_: 69.89 % branch coverage (74.46 % lines) on the hook responsible for every user message. Retry and cancellation paths are the most likely sources of ghost messages or silent failures.

10. **`server/orchestrator-routes.ts` / `server/orchestrator-session-router.ts` — HTTP contract**  
    _Scenario_: Mount both routers onto a test Express app; hit each registered endpoint with valid and invalid inputs; assert status codes and response shapes.  
    _Rationale_: Both files have 0 % coverage despite being the public HTTP surface of the orchestrator subsystem. Any regression in route registration or middleware order is currently invisible.
