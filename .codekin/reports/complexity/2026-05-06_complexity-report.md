# Complexity Report: codekin

**Date**: 2026-05-06T04:33:04.966Z
**Repository**: /srv/repos/codekin
**Branch**: main
**Workflow Run**: 3059afc7-6cb8-4786-b176-36282aab2656
**Session**: 7f8708ad-52cf-42e9-a86c-b35f517b8e91

---

## Summary

**Overall complexity rating: Medium**

The codebase is well-organized with clear intent to decompose large classes (evidenced by recent extraction of `SessionLifecycle`, `PromptRouter`, `DiffManager`, etc. from `SessionManager`). However, several modules remain large and show signs of accumulated complexity. The largest source of technical debt is the `Session` interface (77 fields), which acts as a god object. The `opencode-process.ts` SSE handler and `session-manager.ts`'s worktree/result-handling code carry the highest cyclomatic complexity.

- **Largest file**: `server/session-manager.ts` — 1,699 lines (non-test)
- **Most complex function**: `subscribeToEvents` in `opencode-process.ts` (~110 lines, nested async SSE loop with 3-level nesting and 3-path reconnect logic)
- **Deepest nesting**: `executeRun` in `workflow-engine.ts` (try/catch inside for loop inside try/catch — ~4 levels)

**Codebase metrics**: 228 source files (excl. worktrees), ~25,500 lines of non-test server TypeScript, ~14,000 lines of frontend TypeScript/TSX.

---

## Largest Files

| File | Lines | Primary Responsibility | Refactor Priority |
|------|-------|------------------------|-------------------|
| `server/session-manager.ts` | 1,699 | Session CRUD, process lifecycle delegation, history, diffing, context building | High |
| `server/workflow-engine.ts` | 1,000 | Workflow step execution, cron scheduling, SQLite persistence, resume logic | Medium |
| `server/opencode-process.ts` | 988 | OpenCode HTTP+SSE adapter, SSE event mapping, attachment handling | High |
| `server/claude-process.ts` | 770 | Claude CLI process wrapper, stream-json parsing, event emission | Medium |
| `server/webhook-handler.ts` | 702 | GitHub webhook CI triage and PR review session orchestration | Medium |
| `server/orchestrator-learning.ts` | 696 | Memory extraction, deduplication, aging, skill modeling | Low |
| `server/ws-server.ts` | 691 | Express + WebSocket entry point, route mounting, auth | Medium |
| `server/prompt-router.ts` | 681 | Tool approval, control request routing, auto-approval resolution | Low |
| `server/workflow-loader.ts` | 679 | Markdown workflow parsing, schema validation, registration | Low |
| `src/components/InputBar.tsx` | 784 | Chat textarea, toolbar, model/permission/skill/worktree controls | Medium |
| `src/components/Settings.tsx` | 777 | Settings modal: auth, preferences, webhook config | Low |
| `src/App.tsx` | 739 | Root component, session orchestration, UI state wiring | Medium |
| `src/components/AddWorkflowModal.tsx` | 645 | Workflow creation form with step editor and preview | Low |
| `src/components/ChatView.tsx` | 620 | Message rendering, tool output display, approval UI | Low |
| `server/session-routes.ts` | 604 | REST endpoints for session CRUD, approvals, hooks, settings | Low |

---

## Most Complex Functions

| File:Function | Estimated Complexity | Issue Description | Refactor Suggestion |
|---------------|----------------------|-------------------|--------------------|
| `opencode-process.ts:subscribeToEvents` | High (CC ~18) | ~110-line async SSE read loop with nested reconnect logic duplicated in 3 catch paths; 4-level nesting (async fn → while → catch chain) | Extract `reconnectWithBackoff()` helper; extract the raw line-to-event parser into a separate function |
| `opencode-process.ts:handleSSEEvent` | High (CC ~20) | Large `switch` with 10 cases; `message.part.updated` case has nested `switch`; reasoning buffer flush logic duplicated 3 times | Extract per-case handlers into private methods (`handleTextPart`, `handleReasoningPart`, `handleToolPart`); extract `emitThinkingSummary(buffer)` |
| `session-manager.ts:createWorktree` | High (CC ~15) | ~117-line async method handling branch detection, stale state cleanup, ephemeral vs caller-supplied branch logic, JSONL migration, session update — all in one function | Split into `prepareWorktreeDirectory()` (cleanup/prune), `resolveWorktreeBranch()`, and `migrateSession()` sub-methods |
| `session-manager.ts:sendInput` | Medium (CC ~10) | 3-phase logic (process lifecycle, context injection, readiness wait) interleaved with naming/retry state mutations | Extract phase 1–3 into `ensureProcessAlive()`, `buildMessageWithContext()`, `dispatchMessage()` |
| `workflow-engine.ts:executeRun` | Medium (CC ~14) | ~129-line method with try/catch inside for loop, resume branching, multiple DB writes, and `WorkflowSkipped` special-cased in catch | Extract step execution body into `executeStep()`, separate `finalizeRun()` for the terminal state writes |
| `session-manager.ts:buildSessionContext` | Medium (CC ~12) | Switch over message types, dual flush paths, length truncation with while loop; logic is functional but hard to follow in one pass | Extract to a dedicated `SessionContextBuilder` class or utility module |
| `opencode-process.ts:sendMessage` | Medium (CC ~10) | Inline file-type detection, base64 encoding, size-gating, and OpenRouter model ID splitting all in one method (~85 lines) | Extract `parseAttachments(content)` and `buildModelSpec(model)` as standalone helpers |
| `session-manager.ts:reapIdleSessions` | Medium (CC ~10) | Two nested loops with multiple guard conditions each; stale-prune threshold differs by source type | Extract pruning loop into `pruneStaleSession(session, now)` predicate |
| `src/App.tsx:App` | Medium (CC ~12) | 58 hook calls at component root; delegates to `OrchestratorContent`, `SessionContent`, `DocsBrowserContent` but still wires all cross-cutting state directly | Extract a `useAppState()` hook consolidating the 15+ `useState`/`useRef` declarations; move route-derived branching into sub-components |
| `src/components/InputBar.tsx:InputBar` | Medium (CC ~10) | 4 layout variants (mobile/desktop × default/orchestrator) rendered via boolean conditions inside one return; shared atoms (`AttachButton`, `SendButton`) are already extracted but variant branching remains tangled | Extract `DefaultDesktopToolbar`, `OrchestratorDesktopToolbar`, `MobileToolbar` as sub-components to eliminate nested ternaries |

---

## Coupling & Cohesion Issues

1. **`Session` interface as god object** (`server/types.ts`): The `Session` interface holds 77 fields spanning process state (`claudeProcess`, `alive`), UI-layer hints (`_wasActiveBeforeRestart`, `_processStartedOnce`), naming state (`_namingTimer`, `_namingAttempts`, `_namingUserInput`), API retry state (`_apiRetry`, `_lastUserInput`, `_lastUserInputAt`), context window tracking (`_claudeTurnCount`, `_contextWarningShown`), and lifecycle flags (`_stoppedByUser`, `_isStarting`). This single type couples all consuming modules (14 files import `Session`) to every concern, making field additions affect the whole system. **Suggested fix**: Extract `SessionNamingState`, `SessionRetryState`, `SessionLifecycleFlags` sub-interfaces and compose them into `Session`.

2. **`SessionLifecycle` and `SessionManager` tight callback coupling** (`server/session-lifecycle.ts`): `SessionLifecycleDeps` injects 13 callbacks that are all private methods of `SessionManager` — effectively back-calling the parent through an interface. This creates an implicit circular dependency where lifecycle logic can only be understood by reading `SessionManager`'s private implementations. **Suggested fix**: Promote the shared event-handling logic (`onTextEvent`, `onToolActiveEvent`, etc.) into a separate `SessionEventBroadcaster` that both modules depend on without back-calling.

3. **Reasoning summary logic duplicated 3× in `opencode-process.ts`** (lines ~511–518, ~546–553, ~601–607): The same ~8-line pattern (check buffer length > 20, match first sentence, emit `thinking`) appears identically in the `field=text`+inReasoningPhase path, the `field=reasoning` path, and the `message.part.updated` `reasoning` case. **Suggested fix**: Extract `this.emitThinkingSummaryIfReady(buffer: string): void` and call it from all three sites.

4. **`SessionManager` acts as a façade over too many concerns** (`server/session-manager.ts`): Even after delegation to `SessionLifecycle`, `PromptRouter`, `SessionPersistence`, etc., `SessionManager` still directly implements worktree creation/cleanup, Claude session JSONL migration, history management, context building, API retry, context warning thresholds, and the idle reaper. Most of these are unrelated to each other. **Suggested fix**: Extract `WorktreeManager` (createWorktree, cleanupWorktree, migrateClaudeSession) and `HistoryManager` (addToHistory, buildSessionContext, completeInProgressTasks).

5. **`ws-server.ts` imports 36 modules** (`server/ws-server.ts`): The entry-point file has grown to import handlers, routers, config values, managers, and utilities from 36 distinct modules. While it correctly delegates to routers, it still contains inline WebSocket message parsing, auth verification, and startup sequencing. **Suggested fix**: Extract startup orchestration into a `ServerBootstrapper` class; keep `ws-server.ts` to `<50` lines of actual glue.

---

## Refactoring Candidates

1. **Extract `WorktreeManager` from `SessionManager`** (`server/session-manager.ts:442–673`)
   - **Problem**: `createWorktree`, `cleanupWorktree`, `detectDefaultBranch`, `migrateClaudeSession`, and `copyDirRecursive` are ~230 lines of git and filesystem logic inside `SessionManager`. They have no dependency on session state beyond reading/writing `session.workingDir`, `session.worktreePath`, and `session.groupDir`.
   - **Approach**: Create `server/worktree-manager.ts` with a `WorktreeManager` class; inject it into `SessionManager` the same way `DiffManager` is. Update the 3 call sites.
   - **Effort**: Small

2. **Extract `emitThinkingSummaryIfReady()` in `OpenCodeProcess`** (`server/opencode-process.ts:511–553`)
   - **Problem**: Identical 8-line reasoning-to-thinking emission block repeated 3 times. Any change to the threshold (currently `> 20`) or summary extraction regex must be applied in 3 places.
   - **Approach**: Add `private emitThinkingSummaryIfReady(buffer: string): void`; replace all 3 occurrences.
   - **Effort**: Small

3. **Decompose `subscribeToEvents` / `handleSSEEvent` in `OpenCodeProcess`** (`server/opencode-process.ts:367–769`)
   - **Problem**: `subscribeToEvents` is a 110-line nested async function with 3-path reconnect duplication. `handleSSEEvent` is a 280-line switch with inlined handler logic per case.
   - **Approach**: Extract `connectSSE()` as a standalone helper that returns a promise with a shared `reconnectWithBackoff()`. Split `handleSSEEvent` into `handleTextPartUpdated()`, `handleReasoningPart()`, `handleToolPart()`, `handleTurnComplete()`.
   - **Effort**: Medium

4. **Decompose `executeRun` in `WorkflowEngine`** (`server/workflow-engine.ts:488–616`)
   - **Problem**: The 129-line method mixes step iteration, per-step DB writes, abort signal checks, `WorkflowSkipped` special-casing, and a finally block for `afterRun`. The resume path adds a second branching concern.
   - **Approach**: Extract `executeStep(stepDef, run, lastOutput, abortSignal, isResumed)` returning `{ output, skipped }`. Move terminal state writes (succeeded/failed/skipped/canceled) into `finalizeRun(run, status, error)`.
   - **Effort**: Medium

5. **Extract `useAppState()` hook from `App.tsx`** (`src/App.tsx`)
   - **Problem**: The `App` component root has 58 hook calls (15+ `useState`, 12+ `useRef`, 8+ `useCallback`, 10+ `useEffect`) mixed with JSX rendering logic. This makes the component hard to test in isolation and slows down render-time analysis.
   - **Approach**: Create `src/hooks/useAppState.ts` that returns all non-UI state and callbacks; `App.tsx` calls `useAppState()` and handles only layout/routing JSX.
   - **Effort**: Medium

6. **Reduce `Session` interface surface area** (`server/types.ts`)
   - **Problem**: 77 fields makes every `Session` creation (in `session-manager.ts:create()`) a ~25-line object literal. Internal-only fields prefixed with `_` are mixed with public contract fields, and naming/retry/lifecycle concerns are all flat.
   - **Approach**: Introduce composable sub-types: `SessionNamingState` (6 fields), `SessionRetryState` (3 fields), `SessionLifecycleFlags` (6 fields). Keep `Session` as the composition. This is a pure rename/restructure — no behavioral change.
   - **Effort**: Large (impacts all 14 importing files)

7. **Split `InputBar.tsx` variant rendering** (`src/components/InputBar.tsx:575–780`)
   - **Problem**: The toolbar section renders 4 variants (desktop-default, desktop-orchestrator, mobile-default, mobile-orchestrator) via nested boolean ternaries that repeat `AttachButton` and `SendButton` with slightly different props in each branch.
   - **Approach**: Extract `DefaultDesktopToolbar`, `OrchestratorToolbar`, `MobileToolbar` sub-components with explicit prop signatures; reduce the main render to a 4-way switch on `{ isMobile, isOrchestrator }`.
   - **Effort**: Small

8. **Extract `SessionEventBroadcaster` to break the `SessionLifecycle`→`SessionManager` callback chain** (`server/session-lifecycle.ts`, `server/session-manager.ts`)
   - **Problem**: The `SessionLifecycleDeps` interface injects 8 event-handler callbacks that are all private methods of `SessionManager`, creating an implicit circular dependency and preventing `SessionLifecycle` from being tested independently.
   - **Approach**: Create `server/session-event-broadcaster.ts` with `onTextEvent`, `onToolActiveEvent`, `onToolDoneEvent`, etc. Both `SessionManager` and `SessionLifecycle` depend on this broadcaster without back-calling each other.
   - **Effort**: Large

9. **Extract `buildSessionContext` to a utility module** (`server/session-manager.ts:1434–1494`)
   - **Problem**: The 60-line context-building function is a pure transformation of `WsServerMessage[]` into a string summary. It has no side effects and no dependency on `SessionManager`'s other state, but lives in the class.
   - **Approach**: Move to `server/session-context-builder.ts` as an exported function `buildSessionContext(history: WsServerMessage[]): string | null`. Call it from `SessionManager`.
   - **Effort**: Small

10. **Consolidate `handleClaudeResult` / `finalizeResult` / `handleApiRetry` / `checkContextWarning`** into a `TurnResultHandler` module (`server/session-manager.ts:1052–1215`)
    - **Problem**: These four methods (~163 lines total) collectively handle the result lifecycle for a completed turn. They are private to `SessionManager` but share no state with its other concerns (CRUD, worktree, diff). They are hard to unit-test because they live inside a class that also manages process startup and history.
    - **Approach**: Extract a `TurnResultHandler` class (or pure-function module) that takes `session`, `broadcastFn`, and `globalBroadcastFn` as dependencies and exposes a single `handleResult(session, sessionId, result, isError)` entry point.
    - **Effort**: Medium