# Complexity Audit — 2026-04-10

## Summary

**Overall complexity rating: Medium**

The codebase is well-structured with deliberate decomposition (e.g. `SessionManager` delegates to six sub-modules), thorough comments, and consistent TypeScript conventions. Complexity hot-spots are concentrated in a few large coordination files rather than spread across the codebase. The main risks are a god-object `Session` interface that mixes serializable state with runtime handles, a `SessionManager` constructor that injects 15+ callback closures into sub-modules creating bidirectional coupling, and several frontend components that have grown beyond a single responsibility.

**Key metrics**
- Largest source file: `server/session-manager.ts` — 1 521 lines
- Largest test file: `server/session-manager.test.ts` — 3 639 lines
- Total source files: ~80 (excluding test files, node_modules, dist, worktrees)
- Deepest nesting observed: 4–5 levels (`createWorktree`, `handleUserEvent`)
- Most complex function: `SessionManager.constructor` — 8 delegate objects, 15+ injected callbacks

---

## Largest Files

| File | Lines | Primary Responsibility | Refactor Priority |
|------|-------|----------------------|-------------------|
| `server/session-manager.ts` | 1 521 | Session lifecycle, worktree ops, broadcast, history, retry | High |
| `server/workflow-engine.ts` | 746 | SQLite-backed workflow runs, steps, cron scheduling | Low |
| `server/orchestrator-learning.ts` | 704 | Memory extraction, deduplication, aging, skill modeling | Low |
| `src/components/InputBar.tsx` | 684 | Chat textarea, slash autocomplete, toolbar dropdowns | Medium |
| `src/App.tsx` | 674 | Root component — wires all hooks and layout regions | High |
| `server/prompt-router.ts` | 665 | Tool approval and control-request routing | Low |
| `server/ws-server.ts` | 621 | Express + WebSocket server entry point, all route mounting | Medium |
| `server/orchestrator-routes.ts` | 614 | REST endpoints for orchestrator session | Low |
| `src/components/AddWorkflowModal.tsx` | 580 | Multi-step workflow creation wizard | Medium |
| `server/stepflow-handler.ts` | 521 | Webhook-triggered stepflow session orchestration | Low |
| `src/components/Settings.tsx` | 517 | All settings tabs (auth, models, repos, hooks) | Medium |
| `src/hooks/useChatSocket.ts` | 512 | WebSocket message dispatch, streaming batch, prompt state | Medium |
| `server/workflow-loader.ts` | 505 | Markdown workflow file parsing and validation | Low |
| `src/components/LeftSidebar.tsx` | 504 | Session list, archive, repo grouping, context menus | Medium |
| `server/session-routes.ts` | 475 | REST session CRUD endpoints | Low |

---

## Most Complex Functions

| File:Function | Estimated Complexity | Issue Description | Refactor Suggestion |
|---------------|---------------------|-------------------|---------------------|
| `server/session-manager.ts:constructor` | High | Constructs 8 delegate objects and injects 15+ callback closures; any change to a delegate's interface requires touching this block. Sub-module interaction is bidirectional — `SessionLifecycle` calls back into `SessionManager` methods via closures, creating implicit circular dependency. | Introduce an event bus (or typed `EventEmitter`) shared by sub-modules instead of injecting callbacks. Sub-modules emit events; `SessionManager` listens. |
| `server/session-manager.ts:createWorktree` | High | ~120 lines, 4 sequential `execFileAsync` calls with independent catch chains, branch-exists logic, ephemeral-vs-caller-supplied branch guard, and worktree directory cleanup — all in one method. | Extract `cleanupStaleWorktreeState`, `detectOrCreateBranch`, and `createAndConfigureWorktree` as private helpers. |
| `server/claude-process.ts:handleUserEvent` | Medium-High | Nested type-narrowing: outer loop over content blocks → inner type check for `tool_result` → content-is-array branch → image extraction loop → text assembly. 4–5 levels of nesting. | Extract an `extractToolResultContent(block)` helper that returns `{text, images}` and keep the outer loop flat. |
| `server/claude-process.ts:handleControlRequest` | Medium-High | Handles three distinct responsibilities in one method: AskUserQuestion parsing (with `questions` array walk), auto-approve fast path, and generic forward path. The AskUserQuestion branch has its own 15-line inline struct mapping. | Extract `handleAskUserQuestion(event)` as a dedicated private method. |
| `src/hooks/useChatSocket.ts:handleMessage` | High | 36-case `switch` block that both routes messages and manages multiple independent React state setters (`setIsProcessing`, `setThinkingSummary`, `setCurrentModel`, `setPlanningMode`, etc.). Streaming text flushing (RAF) is interleaved with structural message handling, making the flow hard to follow. | Split into `handleStreamingMessage` (text/thinking) and `handleStructuralMessage` (session events, prompts). The RAF flush logic belongs in a custom `useStreamingText` hook. |
| `src/App.tsx` (root component) | High | 42 hook calls (useState, useEffect, useCallback, useMemo, useRef) in a single function body. Manages 12+ independent pieces of state alongside render logic. | Continue the existing pattern of extracting custom hooks. `usePermissionMode`, `useWorktreeToggle`, `useQueueSettings`, and `useKeyboardShortcuts` are natural candidates. |
| `server/session-manager.ts:handleApiRetry` | Medium | 5-branch early-return chain with timer management, stale-input age check, and duplicate-scheduling guard (`_apiRetryScheduled`). Session fields named `_apiRetryCount`, `_apiRetryTimer`, `_apiRetryScheduled` are closely related but accessed separately. | Group into a small `ApiRetryState` sub-object on `Session`, or extract a dedicated `ApiRetryManager` that owns scheduling. |
| `server/session-manager.ts:reapIdleSessions` | Medium | Two separate iteration loops over `this.sessions.values()` (idle reap + stale prune) sharing the same method. Source-type exclusion lists (`webhook`, `workflow`, `stepflow`, `agent`, `orchestrator`) are duplicated across both loops. | Extract `isHeadlessSession(session)` predicate and `isStaleSession(session, now)` to reduce duplication and make exclusion rules easy to update. |
| `server/claude-process.ts:summarizeToolInput` | Medium | 16-case `switch` returning string summaries. Adding a new tool requires editing this file. | Replace with a `toolSummaryMap: Record<string, (input) => string>` table — new tools register themselves. |
| `src/components/InputBar.tsx:InputBar` | Medium | Component receives 20+ props, renders two conditional variants (`default` vs `orchestrator`), manages 6 local popup-state booleans, and handles resize drag. Variant-specific rendering paths share most markup but diverge in the toolbar. | Extract `OrchestratorToolbar` and `DefaultToolbar` into separate components. Reduce prop count by grouping related props into objects (`worktreeProps`, `permissionProps`). |

---

## Coupling & Cohesion Issues

### 1. `Session` interface — mixed serializable and runtime state
**File:** `server/types.ts:33`
**Issue:** The `Session` interface has 27 fields that include both serializable data (`id`, `name`, `workingDir`, `created`, `source`) and runtime handles (`claudeProcess: ClaudeProcess | null`, `clients: Set<WebSocket>`, `planManager: PlanManager`) alongside many `_`-prefixed ephemeral state fields (`_apiRetryTimer`, `_leaveGraceTimer`, `_restartTimer`, `_planManagerWired`). This makes the type impossible to serialize directly and forces `SessionPersistence` to manually skip runtime fields.
**Fix:** Split into `SessionData` (serializable, persisted to disk) and `SessionRuntime` (runtime handles and timers). `Session = SessionData & SessionRuntime`. `SessionPersistence` only serializes `SessionData`.

### 2. `SessionManager` constructor — bidirectional callback injection
**File:** `server/session-manager.ts:120`
**Issue:** `SessionLifecycle` receives 10 callback closures back into `SessionManager` methods (`onSystemInit`, `onTextEvent`, `handleClaudeResult`, `buildSessionContext`, etc.), while `SessionManager` also holds a direct reference to `SessionLifecycle`. This is a dependency cycle: `SessionManager → SessionLifecycle → SessionManager`. The injection block alone spans 40+ lines and must be updated whenever a sub-module's interface changes.
**Fix:** Introduce a `SessionEventBus extends EventEmitter` shared instance. Sub-modules emit typed events; `SessionManager` listens. Sub-modules no longer hold callback references into their parent.

### 3. `ws-server.ts` — 31 imports, entry-point god module
**File:** `server/ws-server.ts:1`
**Issue:** The server entry point imports 31 modules and performs auth setup, WebSocket handling, route mounting, update checks, hook sync, orchestrator start, and shutdown logic all in sequence. It is the single largest coupling surface in the codebase — touching it risks breaking unrelated features.
**Fix:** Extract `startupSequence()` and `shutdownSequence()` helper functions. WebSocket connection logic can move to `ws-handler.ts`. This is lower priority since the file is not frequently modified, but its size creates a testing gap (it is not unit-tested).

### 4. `App.tsx` — frontend god component
**File:** `src/App.tsx:43`
**Issue:** The root component imports 27 modules and manages all global frontend state: session routing, worktree toggle, queue settings, agent name, permission mode, error banners, diff panel, keyboard shortcuts, and command palette. Fourteen `useCallback` / `useMemo` hooks and twelve `useEffect` calls make it difficult to trace which state changes trigger re-renders.
**Fix:** Continue extracting custom hooks. `usePermissionMode`, `useWorktreeToggle`, `useQueueSettings`, and `useKeyboardShortcuts` each encapsulate cohesive slices of state without needing new files.

### 5. Tool summary duplication — `claude-process.ts` and `ws-message-handler.ts`
**Issue:** `ClaudeProcess.summarizeToolInput` (16-case switch in `claude-process.ts:664`) and activity label logic in `ws-message-handler.ts` both produce human-readable representations of tool invocations. As new tools are added, both must be updated.
**Fix:** Extract a shared `toolLabel(toolName, input)` utility in `server/tool-labels.ts` used by both callers.

### 6. Deprecated constructor overload in `ClaudeProcess`
**File:** `server/claude-process.ts:130`
**Issue:** The constructor supports two call signatures (positional args and options object) with a 25-line disambiguation block. The positional form is marked `@deprecated` but still exists, adding dead weight and a minor cognitive burden for readers.
**Fix:** Remove the positional-args overload. All callers have already been migrated to the options-object form based on the `@deprecated` tag.

---

## Refactoring Candidates

### 1. Split the `Session` interface into serializable data vs. runtime state
**Location:** `server/types.ts:33`, `server/session-persistence.ts`
**Problem:** The 27-field `Session` type mixes serializable fields with runtime handles (WebSocket Set, ClaudeProcess, timers), forcing `SessionPersistence` to hand-filter fields during serialization. The mixed type makes it easy to accidentally serialize or deserialize runtime state.
**Approach:** Introduce `SessionData` (all serializable fields) and `SessionRuntime` (process, clients, timers, planManager). Define `Session = SessionData & SessionRuntime`. Update `SessionPersistence.persistToDisk` to work only with `SessionData`.
**Effort:** Medium

### 2. Replace callback injection in `SessionManager` with an event bus
**Location:** `server/session-manager.ts:120–170`, `server/session-lifecycle.ts`
**Problem:** `SessionLifecycle` receives 10 callback closures that call back into `SessionManager`, creating a bidirectional dependency cycle. This also means the constructor block is 50+ lines of wiring that changes whenever any sub-module interface evolves.
**Approach:** Add a shared `SessionEventBus extends EventEmitter` instance. Sub-modules emit typed events (`system_init`, `text_delta`, `result`, etc.); `SessionManager` subscribes. Remove callback fields from `SessionLifecycleDeps`. Update tests to assert events instead of mocking callbacks.
**Effort:** Large

### 3. Extract streaming and structural message paths in `useChatSocket.handleMessage`
**Location:** `src/hooks/useChatSocket.ts:221`
**Problem:** A 36-case switch handles both high-frequency streaming events (text deltas, tool_active) and low-frequency structural events (session_joined, prompt), with RAF-batching logic interleaved throughout. The combined handler is difficult to test and easy to introduce regressions in.
**Approach:** Split into `handleStreamingMessage` (text/thinking — RAF path) and `handleStructuralMessage` (session/prompt events). Extract RAF text-batching into `useStreamingText(onFlush)` hook. `handleMessage` becomes a thin dispatcher.
**Effort:** Medium

### 4. Reduce `InputBar` prop surface and variant complexity
**Location:** `src/components/InputBar.tsx:234`
**Problem:** `InputBar` accepts 20 props and renders two distinct layout variants (`default` vs `orchestrator`) sharing a complex conditional tree. The 6 local popup-state booleans and drag-resize logic add further density.
**Approach:** Extract `DefaultInputToolbar` and `OrchestratorInputToolbar` sub-components. Group related props into objects (`worktreeProps: WorktreeProps`, `permissionProps: PermissionProps`). This reduces the public interface and makes each variant independently readable.
**Effort:** Medium

### 5. Remove the deprecated positional-args `ClaudeProcess` constructor
**Location:** `server/claude-process.ts:130–153`
**Problem:** The deprecated positional constructor overload adds 25 lines of disambiguation logic and two TypeScript overload signatures. No callers use the positional form — the `@deprecated` tag confirms intent to remove.
**Approach:** Delete the positional overload and the disambiguation `if/else` block. Remove the `@deprecated` JSDoc. Run tests to confirm no callers remain.
**Effort:** Small

### 6. Consolidate `list()` and `listAll()` in `SessionManager`
**Location:** `server/session-manager.ts:645–678`
**Problem:** Two methods produce identical `SessionInfo` serializations with the same `.map()` lambda; the only difference is a comment noting that `listAll` includes the orchestrator session. The code is 34 lines of exact duplication.
**Approach:** Implement a single private `serializeSession(s: Session): SessionInfo` method. Add an `includeAll?: boolean` parameter to `list()`, or keep both public methods but have `listAll()` delegate to `list({ includeAll: true })`. Either removes the duplicated map block.
**Effort:** Small

### 7. Extract `isHeadlessSession` and `isStaleSession` predicates
**Location:** `server/session-manager.ts:184–222` (reapIdleSessions)
**Problem:** The `reapIdleSessions` method contains two `for` loops that both test `session.source` against the same set of headless session types (`webhook`, `workflow`, `stepflow`, `agent`, `orchestrator`). Adding a new source type requires updating both guards.
**Approach:** Extract `isHeadlessSession(session: Session): boolean` as a private or module-level helper. If headless sessions are also excluded from other operations (e.g. archive, naming), promote to `server/session-utils.ts`.
**Effort:** Small

### 8. Extract `toolLabel` shared utility for tool summaries
**Location:** `server/claude-process.ts:664` and `server/ws-message-handler.ts`
**Problem:** Both files independently produce human-readable labels for the same set of tool invocations. Adding support for a new Claude tool requires updating both files, which is easy to miss.
**Approach:** Create `server/tool-labels.ts` exporting `toolLabel(toolName: string, input: Record<string, unknown>): string`. Replace both switch-statement implementations with imports.
**Effort:** Small

### 9. Decompose `App.tsx` — extract focused state hooks
**Location:** `src/App.tsx:43`
**Problem:** The root component directly manages permission mode, worktree toggle, queue-enabled flag, agent display name, error banner timing, and keyboard shortcuts. These are independent slices of state that don't need to live in the root component body.
**Approach:** Extract four hooks: `usePermissionMode()`, `useWorktreeToggle()`, `useQueueSettings(token)`, `useKeyboardShortcuts({...callbacks})`. Each hook already has a clear boundary — the extraction is mechanical and won't change observable behavior.
**Effort:** Small–Medium

### 10. Group `Session` ephemeral timer fields into an `ApiRetryState` sub-object
**Location:** `server/types.ts:88–92`, `server/session-manager.ts:976–1031`
**Problem:** `_apiRetryCount`, `_apiRetryTimer`, `_apiRetryScheduled`, and `_lastUserInput` / `_lastUserInputAt` are always accessed together but declared as separate top-level fields on `Session`. The `handleApiRetry` method accesses all five in a dense pattern, making it hard to see the state machine.
**Approach:** Add `_apiRetry: { count: number; timer?: ReturnType<typeof setTimeout>; scheduled: boolean; lastInput?: string; lastInputAt?: number }` to `Session`. Update `SessionManager.handleApiRetry` to read/write `session._apiRetry.*`. Non-serializable (timer handle) sits naturally alongside the other runtime-only fields already excluded from persistence.
**Effort:** Small
