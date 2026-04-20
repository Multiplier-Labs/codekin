# Test Coverage Report — 2026-04-20

**Framework**: Vitest v4.1.2 with `@vitest/coverage-v8`  
**Test run**: 1639 tests across 60 test files — all passed  
**Command**: `npx vitest run --coverage`

---

## Summary

| Metric    | Coverage % |
|-----------|-----------|
| Statements | 77.31 %  |
| Branches   | 69.70 %  |
| Functions  | 75.58 %  |
| Lines      | 78.44 %  |

Branch coverage (69.7 %) is the weakest dimension and the most meaningful signal for untested logic paths.

---

## Uncovered Files

No file reached absolute 0 %, but the following are functionally uncovered (< 10 % lines):

| File | Line % | Notes |
|------|--------|-------|
| `server/workflow-routes.ts` | 1.68 % | Lines 84–504 — all route handler bodies untested |
| `server/commit-event-hooks.ts` | 8.62 % | Lines 50–205 — 0 % function coverage; all hook-install logic untested |

---

## Low Coverage Files

Files under 70 % line coverage, sorted ascending:

| File | Stmt % | Branch % | Func % | Line % |
|------|--------|----------|--------|--------|
| `server/workflow-routes.ts` | 1.53 | 1.48 | 4.00 | 1.68 |
| `server/commit-event-hooks.ts` | 8.06 | 3.44 | 0.00 | 8.62 |
| `server/opencode-process.ts` | 35.96 | 37.20 | 41.66 | 37.47 |
| `server/webhook-workspace.ts` | 46.55 | 46.15 | 83.33 | 49.09 |
| `server/webhook-handler.ts` | 50.00 | 34.30 | 56.00 | 49.72 |
| `server/webhook-github-setup.ts` | 55.71 | 51.85 | 56.25 | 57.14 |
| `server/session-manager.ts` | 66.12 | 56.67 | 56.92 | 67.79 |
| `src/hooks/useSendMessage.ts` | 70.94 | 69.89 | 80.00 | 74.46 |
| `server/session-persistence.ts` | 78.94 | 65.38 | 100.00 | 77.14 |
| `server/webhook-config.ts` | 79.24 | 88.88 | 60.00 | 77.77 |
| `server/prompt-router.ts` | 77.09 | 72.88 | 81.81 | 77.91 |
| `server/session-lifecycle.ts` | 79.91 | 70.33 | 29.62 | 88.65 |
| `server/session-manager.ts` | 66.12 | 56.67 | 56.92 | 67.79 |
| `server/ws-message-handler.ts` | — | 84.41 | 87.50 | 86.99 |
| `server/diff-manager.ts` | 89.58 | 77.52 | 69.23 | 89.28 |

---

## Prioritised Test Proposals

1. **`server/workflow-routes.ts` — all route handlers (lines 84–504)**  
   *Functions*: every Express route handler mounted on the `/api/workflows/` router  
   *Scenarios*: happy-path request/response for `GET /runs`, `POST /runs`, `GET /schedules`, `POST /schedules/:id`, `DELETE /schedules/:id`, `PATCH /repos/:repo`, and the commit-event dispatch endpoint; also 4xx error paths (missing body fields, unknown kind)  
   *Rationale*: 98 % of this critical API surface is completely untested. A regression here would silently break all workflow scheduling, repo management, and manual run triggers.

2. **`server/commit-event-hooks.ts` — `ensureHookConfig`, `installCommitHook`, `removeCommitHook`, `syncCommitHooks`**  
   *Scenario*: use a temp directory fixture to simulate `~/.codekin` and a bare git repo; assert that the BEGIN/END marker block is inserted on install, idempotent on re-run, and fully removed on uninstall; assert `hook-config.json` is written with mode 0600  
   *Rationale*: 0 % function coverage on filesystem-mutating code that runs on every `POST /api/workflows/repos` call. Silent failures here would leave repos with broken or missing post-commit hooks.

3. **`server/opencode-process.ts` — `OpenCodeProcess` SSE event mapping**  
   *Functions*: `connect`, message-part dispatch (`text`, `tool`, `step-start`/`step-finish`), and permission-reply flow  
   *Scenario*: mock an HTTP server that emits a sequence of SSE events and assert the correct `ClaudeProcessEvents` are emitted; test `tool` parts with `status: 'completed'` vs `'error'`  
   *Rationale*: 37 % coverage on the only alternative coding provider. Any mapping bug silently drops or corrupts assistant output for OpenCode users and cannot be caught by ClaudeProcess tests.

4. **`server/webhook-handler.ts` — main event dispatch (lines 229–686)**  
   *Functions*: `handleWebhookEvent`, PR-opened / PR-synchronize / push event branches, duplicate-detection early-exit  
   *Scenario*: inject a mock `SessionManager` and fire synthetic GitHub webhook payloads; assert sessions are created for new PRs, re-used for synchronize, and skipped for duplicates  
   *Rationale*: 34 % branch coverage on the entry point for all GitHub-triggered automation. Missing branch paths mean untested failure modes for the core PR-review workflow.

5. **`server/webhook-workspace.ts` — `ensureBareMirror`, `createWorkspace`, `cleanupWorkspace`**  
   *Scenario*: mock `execFileAsync`/`existsSync` with an in-memory fs; test the concurrent-clone lock (two simultaneous calls share one promise), path-traversal guard, and cleanup of stale workspace dirs  
   *Rationale*: the mirror-lock and path-traversal check are security-relevant and completely untested (46 % line coverage). A regression could expose the host filesystem to path injection or corrupt a shared bare mirror under load.

6. **`server/webhook-github-setup.ts` — `previewWebhookSetup`, `createRepoWebhook`, `updateRepoWebhook`**  
   *Functions*: all three exported setup functions plus `parseGitHubSlug`  
   *Scenario*: inject a stub `ghRunner` returning mock `gh api` JSON; assert correct hook URL construction, idempotent update detection, and graceful failure when `gh` returns non-zero  
   *Rationale*: 51 % branch coverage; the untested branches include the "already configured" short-circuit and error-propagation paths that operators rely on during initial webhook setup.

7. **`server/session-manager.ts` — idle-session eviction and stale-session pruning**  
   *Functions*: `checkIdleSessions`, `pruneDeadSessions`, `getOrCreateSession`  
   *Scenario*: create sessions with synthetic `lastActivity` timestamps that exceed `IDLE_SESSION_TIMEOUT_MS` and `STALE_SESSION_AGE_MS`; assert the correct sessions are stopped/removed without affecting active ones  
   *Rationale*: 56 % function coverage on the central state manager. Idle-eviction bugs lead to runaway Claude processes; pruning bugs accumulate disk state indefinitely.

8. **`server/session-lifecycle.ts` — `wireClaudeEvents` and auto-restart logic**  
   *Functions*: `handleClaudeExit`, `wireClaudeEvents`, `stopClaudeAndWait`  
   *Scenario*: emit synthetic `exit` events with various exit codes and assert `evaluateRestart` is invoked with correct arguments; test the staggered-restart delay and the `willRestart: false` path when max retries are exhausted  
   *Rationale*: 29 % function coverage. Restart logic is the last line of defence against silent session death; untested paths could cause infinite restart loops or suppress legitimate restarts.

9. **`src/hooks/useSendMessage.ts` — file attachment and retry paths (lines 166–189)**  
   *Functions*: `sendWithAttachments`, error-retry branch inside `sendMessage`  
   *Scenario*: mock `ccApi.uploadFile` to return a file token; assert the composed message contains the token; also simulate a transient network error and assert the retry counter increments before succeeding  
   *Rationale*: 69 % branch coverage; the untested attachment path is exercised every time a user drags a file into the chat — a silent failure here produces a message with a missing attachment and no error feedback.

10. **`server/prompt-router.ts` — routing decision branches (lines 461–630)**  
    *Functions*: `routePrompt`, system-prompt injection, tool-filter application  
    *Scenario*: configure router with each supported mode (`readonly`, `default`, `acceptEdits`) and assert the correct `system` prefix and `allowedTools` list are produced; test the override-by-session-flag path  
    *Rationale*: 72 % branch coverage on code that controls which tools Claude is permitted to call. An untested routing branch could inadvertently grant write-tool access in read-only sessions.
