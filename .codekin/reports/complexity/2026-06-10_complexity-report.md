# Complexity Report: codekin

**Date**: 2026-06-10T04:33:14.322Z
**Repository**: /srv/repos/Multiplier-Labs/codekin
**Branch**: main
**Workflow Run**: f30c74e6-fe0d-4f6e-9531-9579854b81e8
**Session**: db0dc7b8-3de3-4f97-8e1d-4b5e1deae8de

---

Now I have enough data for a thorough analysis. Let me compile the report.

---

## Summary

**Overall Complexity Rating: Medium-High**

The Codekin codebase (237 TypeScript/TSX source files, ~30k non-test lines) is well-structured and has undergone meaningful decomposition (e.g., `SessionManager` delegates to `SessionLifecycle`, `PromptRouter`, `SessionPersistence`, etc.). However, several modules remain very large, some functions carry multi-level nesting, and a few coupling anti-patterns create maintenance risk.

- **Largest file**: `server/session-manager.ts` — 1,709 lines
- **Deepest nesting**: `createWorktree()` in `session-manager.ts` and `registerWorkflow()` in `workflow-loader.ts` — 4–5 levels
- **Most complex function**: `registerWorkflow()` in `workflow-loader.ts` — 338 lines of inline step-handler closures; `executeRun()` in `workflow-engine.ts` — deeply nested try/catch/finally with multi-branch status machine

---

## Largest Files

| File | Lines | Primary Responsibility | Refactor Priority |
|------|-------|----------------------|-------------------|
| `server/session-manager.ts` | 1,709 | Session lifecycle orchestrator + worktree ops + history/broadcast | High |
| `server/workflow-engine.ts` | 1,028 | Step execution, SQLite persistence, cron scheduling | Medium |
| `server/opencode-process.ts` | 988 | OpenCode HTTP/SSE process wrapper | Medium |
| `server/claude-process.ts` | 779 | Claude CLI child-process wrapper | Medium |
| `server/workflow-loader.ts` | 711 | MD workflow registration + 4-step handler closures | High |
| `server/webhook-handler.ts` | 702 | GitHub webhook CI/PR processing | Medium |
| `server/orchestrator-learning.ts` | 696 | Memory extraction, deduplication, aging, skill modeling | Medium |
| `server/ws-server.ts` | 691 | Express+WS setup, auth, route mounting, startup | Low |
| `server/prompt-router.ts` | 681 | Tool approval, control requests, pending prompts | Low |
| `server/session-routes.ts` | 612 | REST endpoints for session CRUD | Low |
| `src/components/InputBar.tsx` | 784 | Chat input, toolbar, model/permission dropdowns | High |
| `src/App.tsx` | 744 | Root component, all hook wiring, view routing | High |
| `src/components/Settings.tsx` | 777 | Settings modal UI | Medium |
| `src/components/AddWorkflowModal.tsx` | 645 | Workflow creation UI | Low |
| `src/components/ChatView.tsx` | 620 | Message rendering | Low |

---

## Most Complex Functions

| File:Function | Estimated Complexity | Issue Description | Refactor Suggestion |
|---|---|---|---|
| `workflow-loader.ts:registerWorkflow` | Very High | 338-line function containing all 4 inline `async` step-handler closures; each handler is 50–120 lines with multi-level nesting | Extract each step into a named `StepHandler` factory or class (`ValidateRepoStep`, `CreateSessionStep`, etc.) outside the closure |
| `session-manager.ts:createWorktree` | High | 127 lines, 4–5 nesting levels: worktree prune → remove → branch delete → add, each inside try/catch blocks | Extract cleanup phase into a private `prepareWorktree()` helper, error-handling into a `handleWorktreeCleanupError()` |
| `session-lifecycle.ts:handleClaudeExit` | High | 200+ lines; multi-path restart decision tree + fallback logic + worktree fallback + no-output tracking | Already delegates to `evaluateRestart()`; extract working-dir fallback to `handleMissingWorkingDir()` and no-output tracking to a pure utility |
| `session-manager.ts:addToHistory` | Medium | Repeated bounds-checking/splicing logic appears twice: once for chunked output and once for the general path | Consolidate into a single `trimHistory()` private helper called after every push |
| `workflow-engine.ts:executeRun` | High | 130-line `async` method; outer try/catch wraps inner try/catch per step; complex status transitions with `WorkflowSkipped` special-casing; `isResume` flag threads through all branches | Extract step execution loop into `executeSteps()`, failure handling into `handleRunError()`, and resume logic into a pre-execution filter |
| `workflow-loader.ts:save_report (step 4 handler)` | High | ~160 lines; git branch existence check → fetch → create, worktree management, path-traversal defenses, commit, push — all inline | Extract git-based report commit logic into `commitReportToGit(repoPath, branch, filePath, content)` in a separate `workflow-git.ts` |
| `opencode-process.ts:startOpenCodeServer` | Medium | Busy-poll with `for (let i=0; i<30; i++) { await sleep(1000) }` to detect server readiness; no exponential backoff | Replace with a retry-with-backoff utility; a 30-second flat wait with 1-second sleeps is a reliability risk |
| `session-manager.ts:handleClaudeResult` | Medium | Chains headless-cap check → API retry logic → context warning → noise filter → result broadcast; each concern is a method call but the orchestration is dense | The chain is readable; primary issue is that each delegated method still reads/mutates `session` directly. Consider a `SessionResultContext` value object |
| `InputBar.tsx:InputBar (render)` | High | 450-line JSX render body; manually branches on `isMobile × isOrchestrator` producing 4 near-identical toolbar variants | Extract each toolbar variant (`DesktopDefaultToolbar`, `DesktopOrchestratorToolbar`, `MobileDefaultToolbar`, `MobileOrchestratorToolbar`) as sub-components |
| `App.tsx:App` | High | 744-line root component using 32 imports and ~93 `use*` calls/references; layout JSX is 200+ lines inline | Already partially factored (`SessionContent`, `OrchestratorContent`); extract remaining layout sections; move provider/model sync effects to dedicated hooks |

---

## Coupling & Cohesion Issues

1. **`SessionManager` as a god object (partially mitigated)**
   - Even after the decomposition into `SessionLifecycle`, `PromptRouter`, `SessionPersistence`, `SessionNaming`, and `DiffManager`, `SessionManager` itself is 1,709 lines and still owns: worktree creation/cleanup, output history management, API retry scheduling, context building, noise filtering, and idle-reaping. It holds private methods for unrelated concerns (`buildSessionContext`, `completeInProgressTasks`, `archiveSessionIfWorthSaving`).
   - **Suggested fix**: Extract `WorktreeManager` (createWorktree, cleanupWorktree, detectDefaultBranch, migrateClaudeSession) and `HistoryManager` (addToHistory, extractCurrentTurnText, stripCurrentTurnOutput, buildSessionContext) as injected collaborators with the same pattern used for `DiffManager`.

2. **Bidirectional dependency between `SessionManager` and `SessionLifecycle`**
   - `SessionLifecycle` is constructed with 15+ callback functions that all point back to `SessionManager` methods (`onSystemInit`, `onTextEvent`, `handleClaudeResult`, `buildSessionContext`, etc.). This is inversion-of-control via constructor injection, which works, but the `SessionLifecycleDeps` interface has 16 members. Any change to how Claude events are dispatched requires editing both files.
   - **Suggested fix**: Replace the 16-callback `deps` struct with an `EventBus` pattern or a narrower `SessionEventSink` interface (~5 methods: `onOutput`, `onTool`, `onResult`, `onPrompt`, `onSystem`). Callers receive typed events and route them internally.

3. **Duplicate env-stripping logic in `claude-process.ts` and `opencode-process.ts`**
   - Both files define an identical `API_KEY_VARS` Set and apply the same GIT_* filtering. If a new key is added, it must be updated in two places.
   - **Suggested fix**: Extract `buildChildEnv(extras?: Record<string, string>): NodeJS.ProcessEnv` into `coding-process.ts` or a new `env-utils.ts` shared module.

4. **`workflow-loader.ts` couples session creation, git operations, and workflow registration**
   - The `registerWorkflow` function closure captures `sessions: SessionManager`, `engine: WorkflowEngine`, and `def: WorkflowDef` and then performs git operations (branch creation, worktree, commit, push), session lifecycle (create, start, waitForReady, delete), and output history traversal all in one 338-line block.
   - **Suggested fix**: Extract `WorkflowStepLibrary` with static factory methods for each step, injected with only the dependencies they need, rather than the full `SessionManager`.

5. **`App.tsx` imports 32 modules** and is the sole owner of cross-cutting state (session ID, diff panel, error notifications, provider, model, permission mode, worktree toggle, queue, agent name). This makes any feature change require modifying the root component.
   - **Suggested fix**: Introduce a `useAppState()` mega-hook that owns all these slices, keeping the JSX in `App.tsx` as pure layout. The slices can then be individually extracted over time.

6. **Busy-polling in `workflow-loader.ts:waitForSessionResult`**
   - Uses `while (Date.now() < deadline) { await sleep(pollMs) }` to check `outputHistory`. This is CPU-idle but still runs every 2 seconds for up to 10 minutes per run. The `SessionManager` already fires `onSessionResult` listeners.
   - **Suggested fix**: Replace the poll with a `Promise`-based listener on `SessionManager.onSessionResult`, falling back to the poll only when the listener API is unavailable.

---

## Refactoring Candidates

1. **Extract `WorktreeManager` from `SessionManager`**
   - **Location**: `server/session-manager.ts:443–683`
   - **Problem**: `createWorktree`, `cleanupWorktree`, `detectDefaultBranch`, `migrateClaudeSession`, `copyDirRecursive` are 240 lines of git-filesystem logic embedded in the session lifecycle orchestrator.
   - **Approach**: Create `server/worktree-manager.ts` with a `WorktreeManager` class. Inject it into `SessionManager` alongside `DiffManager`. The class receives only the minimal `execFileAsync`/`existsSync`/`broadcast` surface it needs.
   - **Effort**: Medium

2. **Split `InputBar.tsx` into toolbar sub-components**
   - **Location**: `src/components/InputBar.tsx:576–781`
   - **Problem**: The toolbar section manually branches on `isMobile × isOrchestrator` → 4 near-identical layouts. `AttachButton` and `SendButton` atoms already exist; the problem is the 4-branch variant dispatch.
   - **Approach**: Extract `DesktopToolbar`, `MobileToolbar` as separate components that accept `variant: 'default' | 'orchestrator'` internally. The main `InputBar` render drops to ~200 lines.
   - **Effort**: Small

3. **Extract step handlers from `registerWorkflow` into named factories**
   - **Location**: `server/workflow-loader.ts:263–600`
   - **Problem**: A single 338-line function contains all business logic for 4 workflow steps as inline closures. The `save_report` handler alone is ~160 lines with nested git operations.
   - **Approach**: Create `server/workflow-steps.ts` with exported `makeValidateRepoStep(def)`, `makeCreateSessionStep(sessions, def)`, `makeRunPromptStep(sessions, def)`, `makeSaveReportStep(def)`. `registerWorkflow` becomes 20 lines calling these factories.
   - **Effort**: Medium

4. **Replace busy-poll in `waitForSessionResult` with event-based wait**
   - **Location**: `server/workflow-loader.ts:185–228`
   - **Problem**: 2-second poll loop running for up to 10 minutes per workflow run; fires even when the session result is available immediately.
   - **Approach**: Add `waitForResult(sessionId, abortSignal): Promise<ResultEvent>` to `SessionManager` backed by a one-shot `onSessionResult` listener + timeout. Replace the poll. Fall back to `waitForSessionResult` only for backwards compatibility.
   - **Effort**: Small

5. **Deduplicate env-stripping into `coding-process.ts`**
   - **Location**: `server/claude-process.ts:174–186`, `server/opencode-process.ts:111–120`
   - **Problem**: `API_KEY_VARS` set and GIT_* filter logic duplicated verbatim in both process wrappers.
   - **Approach**: Export `buildSafeChildEnv(extra?: Record<string, string>): NodeJS.ProcessEnv` from `coding-process.ts` and replace both inline copies.
   - **Effort**: Small

6. **Extract `HistoryManager` from `SessionManager`**
   - **Location**: `server/session-manager.ts:1413–1503` (`extractCurrentTurnText`, `stripCurrentTurnOutput`, `buildSessionContext`, `addToHistory`, `completeInProgressTasks`)
   - **Problem**: ~120 lines of output-history manipulation mixed into the session orchestrator. The repeated `outputHistory.length > MAX_HISTORY` bounds check appears twice in `addToHistory`.
   - **Approach**: Create `server/history-manager.ts`; inject as a collaborator alongside `DiffManager`. Merge the two `MAX_HISTORY` trim paths into one private `trimToLimit()` call.
   - **Effort**: Medium

7. **Refactor `App.tsx` — extract a `useAppState` hook**
   - **Location**: `src/App.tsx:49–300`
   - **Problem**: Root component owns 15+ state variables plus effects for `queueEnabled`, `agentName`, `permissionModeRef`, `providerRef`, `hasFileChanges`, `archiveRefreshKey`, model sync, provider validation, and session orchestration. Any feature change touches this file.
   - **Approach**: Create `src/hooks/useAppState.ts` that consolidates all cross-cutting state and returns a single props-like object. `App.tsx` becomes layout-only.
   - **Effort**: Large

8. **Narrow `SessionLifecycleDeps` interface**
   - **Location**: `server/session-lifecycle.ts:24–48`, `server/session-manager.ts:177–200`
   - **Problem**: The deps struct has 16 members including 9 event-callback functions. Any signature change requires coordination across both files.
   - **Approach**: Introduce a `SessionEventSink` interface with ~5 typed methods (`onOutput`, `onToolEvent`, `onResult`, `onPrompt`, `onSystem`) and replace the 9 individual callbacks. Reduces `SessionLifecycleDeps` to ~8 members.
   - **Effort**: Medium

9. **Extract git report-commit logic from `save_report` step handler**
   - **Location**: `server/workflow-loader.ts:473–600`
   - **Problem**: The `save_report` handler is ~130 lines of git branch management (check/create/fetch, worktree add, commit, push, prune) embedded inside a step handler closure.
   - **Approach**: Extract `commitWorkflowReport(repoPath: string, branch: string, relPath: string, content: string): Promise<void>` into `server/workflow-git.ts`. The step handler becomes 20 lines calling this function.
   - **Effort**: Small

10. **Convert `opencode-process.ts:startOpenCodeServer` to backoff-based readiness check**
    - **Location**: `server/opencode-process.ts:103–162`
    - **Problem**: Linear 30-second poll with 1-second sleep per attempt. Slow to detect readiness when server starts fast (wastes ~15s), and no diagnostic differentiation between "server starting slowly" and "server crashed immediately."
    - **Approach**: Use exponential backoff (250ms → 500ms → 1s → 2s → ...) capped at 5s, with a max total wait of 30s. Log each attempt with elapsed time. Differentiate ECONNREFUSED (still starting) from HTTP 5xx (started but unhealthy).
    - **Effort**: Small