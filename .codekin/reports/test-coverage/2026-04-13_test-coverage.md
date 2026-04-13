# Test Coverage Report — 2026-04-13

**Framework**: Vitest 4.1.2 with `@vitest/coverage-v8`
**Test files**: 59 passed | **Tests**: 1,600 passed
**Run time**: 1.94 s

---

## Summary

| Metric     | Coverage % |
|------------|-----------|
| Statements | 76.93%    |
| Branches   | 69.08%    |
| Functions  | 74.62%    |
| Lines      | 78.22%    |

---

## Uncovered Files

No files are at exactly 0% coverage, but the two files below are functionally uncovered (≤2% statement coverage and 0% function coverage):

- `server/workflow-routes.ts` — 1.53% statements, **4% functions** (lines 49–469 uncovered; all HTTP route handlers untested)
- `server/commit-event-hooks.ts` — 8.06% statements, **0% functions** (lines 50–205 uncovered; every exported function untested)

---

## Low Coverage Files

_Sorted by line coverage ascending, top 15_

| File | Line % | Branch % | Notes |
|------|--------|----------|-------|
| `server/workflow-routes.ts` | 1.68% | 1.48% | All route handlers (lines 49–469) untested |
| `server/commit-event-hooks.ts` | 8.62% | 3.44% | 0% function coverage; git-hook install/remove logic untested |
| `server/opencode-process.ts` | 38.01% | 37.42% | OpenCode SSE integration, process management largely untested |
| `server/webhook-handler.ts` | 49.72% | 34.30% | CI-triage & PR-review orchestration paths untested (lines 142–344, 429–686) |
| `server/webhook-github-setup.ts` | 57.14% | 51.85% | Webhook discovery, create, update flows partially covered |
| `server/session-manager.ts` | 60.99% | 49.86% | Core session CRUD, idle timeout, approval flow gaps |
| `src/hooks/useSendMessage.ts` | 74.46% | 69.89% | Message retry, file attachment, abort paths uncovered |
| `server/session-lifecycle.ts` | 87.19% | 69.11% | **26.92% function coverage** — many lifecycle methods never called in tests |
| `server/prompt-router.ts` | 77.91% | 72.88% | Prompt routing branches (lines 460–562, 592, 629) |
| `src/lib/ccApi.ts` | 83.01% | 79.68% | Tool-use streaming paths (lines 345–150, 457–556) |
| `server/diff-manager.ts` | 89.28% | 77.52% | Branch/scope edge cases (lines 279–284, 311–312) |
| `server/approval-manager.ts` | 91.12% | 86.66% | Approval edge cases (lines 426, 433–434, 449) |
| `server/claude-process.ts` | 87.68% | 80.76% | Streaming edge cases and exit-code paths |
| `server/session-persistence.ts` | 77.14% | 65.38% | Error branches (lines 70, 98–105) |
| `.claude/hooks/lib/presets/completion-gate.mjs` | 89.83% | 68.08% | Blocking/sentinel paths (lines 24–27, 38–39) |

---

## Prioritised Test Proposals

1. **`server/workflow-routes.ts` — all Express route handlers**
   - _Functions_: `GET /api/workflows/runs`, `POST /api/workflows/repos`, `DELETE /api/workflows/repos/:id`, `POST /api/workflows/runs`, `POST /api/workflows/setup-webhook`
   - _Scenario_: Mount the router on a test Express app with a mock `WorkflowEngine` and `SessionManager`; exercise happy-path and error-path for each route (404 unknown repo, 400 bad input, 200/201 success).
   - _Rationale_: Lines 49–469 are entirely uncovered. These routes handle all workflow CRUD and the auto-webhook-setup wizard — high business value, zero test safety net.

2. **`server/commit-event-hooks.ts` — `ensureHookConfig`, `installHook`, `removeHook`, `syncCommitHooks`**
   - _Scenario_: Use `tmp`/`os.tmpdir()` to create a fake repo with a pre-existing `.git/hooks/post-commit`; assert that `installHook` inserts the BEGIN/END markers, `removeHook` cleanly strips them, and `ensureHookConfig` writes a 0600 JSON file.
   - _Rationale_: 0% function coverage on a module that writes executable shell hooks and sets file permissions — a regression here could silently break all commit-review automation.

3. **`server/webhook-handler.ts` — `handleWorkflowRun` and `handlePullRequest`**
   - _Functions_: `handleWorkflowRun`, `handlePullRequest`, watchdog expiry logic
   - _Scenario_: Construct a `WebhookHandler` with mocked `SessionManager`, `WebhookDedup`, and GitHub fetch helpers; send a `workflow_run.completed` payload with a failing conclusion and verify a session is created with the correct prompt; send a `pull_request.opened` payload and verify a PR-review session is spawned.
   - _Rationale_: Lines 142–344 and 429–686 are uncovered. These are the core event-processing paths — the primary value of the webhook integration.

4. **`server/opencode-process.ts` — `ensureServerRunning`, `send`, SSE event mapping**
   - _Functions_: `ensureServerRunning`, `OpenCodeProcess.send`, SSE `tool` / `text` / `step-finish` event handlers
   - _Scenario_: Stub `spawn` to return a fake process that emits `ready` on stdout; stub `fetch` to return SSE streams with sample `message.updated` events; assert that `tool_use` start/finish messages are emitted correctly.
   - _Rationale_: 38% line coverage on the OpenCode integration adapter — if the SSE mapping regresses, all OpenCode sessions silently produce no output.

5. **`server/session-lifecycle.ts` — all exported lifecycle methods**
   - _Functions_: `startSession`, `stopSession`, `restartSession`, `handleProcessExit` (only 26.92% function coverage despite 87% line coverage — many functions never entered)
   - _Scenario_: Unit-test each function with a mock `CodingProcess`; cover the `willRestart=true` path through `handleProcessExit` and the staggered-restart delay logic.
   - _Rationale_: Low function coverage means entire code paths are untested; an error in `stopSession` or restart scheduling would affect every session.

6. **`server/webhook-github-setup.ts` — `previewWebhookSetup`, `createRepoWebhook`, `updateRepoWebhook`**
   - _Scenario_: Use the existing `_setGhRunner` test hook to inject a fake `gh` runner returning sample webhook JSON; assert that `previewWebhookSetup` returns `action: 'create'` for a repo with no existing webhook and `action: 'update'` when a matching URL is found but events differ.
   - _Rationale_: 57% line coverage on the auto-setup wizard that runs when users enable PR review for the first time — wrong action could create duplicate webhooks or silently leave events un-subscribed.

7. **`server/session-manager.ts` — idle session pruning, `onSessionExit` callbacks**
   - _Functions_: `pruneIdleSessions`, `deleteSession`, `onSessionExit`/`onSessionResult` notification paths
   - _Scenario_: Create sessions with artificial `lastActivityAt` timestamps in the past; advance fake timers past `IDLE_SESSION_TIMEOUT_MS`; verify idle sessions are stopped and their processes cleaned up; verify `onSessionExit` fires registered callbacks.
   - _Rationale_: 49.86% branch coverage — the idle-timeout and exit-callback paths protect against memory and process leaks; missing tests here hide potential resource exhaustion bugs.

8. **`src/hooks/useSendMessage.ts` — retry logic and file attachments**
   - _Functions_: message retry on API error, `abortCurrentMessage`, multi-file attachment serialisation
   - _Scenario_: Mock `useChatSocket` to return a `sendRaw` spy; simulate an `api_error` result response and verify the hook retries up to `MAX_API_RETRIES` with exponential backoff; test that calling `abortCurrentMessage` during a retry cancels further attempts.
   - _Rationale_: Lines 166–174 and 185–189 are the retry paths — silent test gaps on retry logic that protects users from transient Claude API errors.

9. **`server/prompt-router.ts` — `routePrompt` edge cases**
   - _Functions_: `routePrompt` with `!currentSession`, slash-command fallthrough, `maybeInjectFiles` with base64-encoded images
   - _Scenario_: Call `routePrompt` with a session where `status === 'stopped'`; verify it returns an error response rather than forwarding to Claude; call with a `/custom-skill` command and a mock skill registry that returns `null` to test the fallthrough path.
   - _Rationale_: Lines 460–562 and 592 cover error-state routing — uncovered paths mean malformed prompts could reach a dead process.

10. **`server/session-persistence.ts` — failure branches in `loadSessions` and `saveSessions`**
    - _Functions_: `loadSessions` when file is corrupted JSON, `saveSessions` when write fails
    - _Scenario_: Write an invalid JSON string to a temp sessions file; call `loadSessions` and assert it returns an empty array (graceful degradation) without throwing; mock `writeFileSync` to throw `ENOSPC` and verify `saveSessions` logs the error instead of crashing.
    - _Rationale_: Lines 98–105 are the error branches — a crash here on startup would prevent the server from loading any existing sessions.
