# Code Complexity Analysis — 2026-04-15

## Summary

**Overall Complexity Rating: Medium-High**

The codebase is a mature, well-structured TypeScript monorepo (~56,700 lines across 765 source files, excluding test files and worktrees). Most architectural concerns have been cleanly extracted into focused modules — `SessionManager` in particular has shed large responsibilities via `SessionLifecycle`, `PromptRouter`, `SessionNaming`, `ApprovalManager`, etc. However, several files remain substantially large and complex, and a handful of functions exhibit high cyclomatic complexity.

| Metric | Value |
|---|---|
| Total source files (excl. tests, worktrees) | ~765 |
| Total lines (excl. tests) | ~56,700 |
| Largest source file | `server/session-manager.ts` (1,594 lines) |
| Largest non-test single class | `OpenCodeProcess.handleSSEEvent` (~280 lines) |
| Highest nesting depth observed | 6 levels (`opencode-process.ts:subscribeToEvents`) |
| Files over 300 lines | 36 |
| Files over 600 lines | 15 |

---

## Largest Files

| File | Lines | Primary Responsibility | Refactor Priority |
|---|---|---|---|
| `server/session-manager.ts` | 1,594 | Session lifecycle orchestrator — CRUD, worktree ops, output history, context building, API retry, broadcasts | Medium |
| `server/opencode-process.ts` | 988 | OpenCode HTTP/SSE adapter + module-level singleton server manager | High |
| `src/App.tsx` | 802 | Root React component — wires all hooks, global state, keyboard shortcuts, routing | High |
| `src/components/InputBar.tsx` | 784 | Chat input bar with skill menu, slash autocomplete, permission dropdown, drag handle | Medium |
| `src/components/Settings.tsx` | 777 | Settings modal — auth, preferences, webhooks, integrations | Low |
| `server/claude-process.ts` | 765 | Claude CLI child-process wrapper and NDJSON parser | Low |
| `server/workflow-engine.ts` | 747 | SQLite-backed workflow execution engine with cron scheduling | Low |
| `server/orchestrator-routes.ts` | 706 | REST endpoints for orchestrator status, children, memory, learning | Medium |
| `server/orchestrator-learning.ts` | 705 | AI-powered memory extraction, aging, skill modeling, decision tracking | Medium |
| `server/webhook-handler.ts` | 702 | GitHub webhook event handler (CI triage + PR review) | Low |
| `server/prompt-router.ts` | 681 | Tool approval and prompt routing logic | Low |
| `server/ws-server.ts` | 669 | Express/WebSocket server entry point — all service wiring | Medium |
| `src/components/AddWorkflowModal.tsx` | 645 | Add/edit workflow modal with form fields and preview | Low |
| `src/components/ChatView.tsx` | 620 | Session chat view — message rendering, diff panel, approvals | Low |
| `server/stepflow-handler.ts` | 526 | Stepflow webhook integration for orchestrated sessions | Low |

---

## Most Complex Functions

| File:Function | Estimated Complexity | Issue Description | Refactor Suggestion |
|---|---|---|---|
| `server/opencode-process.ts:handleSSEEvent` | Very High | ~280-line `switch` on event type, each case with nested `if` guards plus inner `switch`/`for` on part types; total ~6 levels of nesting | Split into per-event handler methods (e.g. `handleMessagePartDelta`, `handleSessionStatus`, `handlePermissionAsked`) that `handleSSEEvent` dispatches to |
| `server/opencode-process.ts:subscribeToEvents` | High | Async SSE reconnect loop with three separate error paths (`!res.ok`, clean-EOF, catch), each duplicating the exponential-backoff/counter logic; 5–6 levels of nesting inside the `fetch` promise chain | Extract `handleSSEStream(res)` for the read loop and a shared `scheduleReconnect()` for the three identical backoff paths |
| `server/session-manager.ts:constructor` | High | Wires 8 delegates by passing ~20 callback closures inline; the constructor body spans ~55 lines and mixes initialization with self-referential closure captures (`const self = this`) | Extract a factory function or builder pattern; inject `self` references via a `getThis()` accessor after construction |
| `server/session-manager.ts:createWorktree` | High | ~130-line async function with 4 sequential try/catch blocks, worktree state mutated across branches, and 3 independent cleanup sub-steps before actual creation | Extract `cleanupStaleWorktree(repoRoot, worktreePath, branchName, isEphemeral)` and `createWorktreeDir(repoRoot, args)` helpers |
| `src/App.tsx:(component body)` | High | Single React component with 20+ `useState`/`useEffect` calls, managing session switching, OpenCode model fetching, keyboard shortcuts, provider validation, and routing simultaneously; ~800 lines | Extract `useOpenCodeModelSync`, `useProviderValidation`, and `useGlobalKeyBindings` into dedicated hooks; this is already the pattern used elsewhere in the codebase |
| `server/opencode-process.ts:sendMessage` | Medium-High | Builds attachment list with nested `statSync`/`readFileSync` calls and multi-branch encoding logic; handles text extraction, image detection, and base64 encoding in a single method | Extract `buildFileAttachments(paths)` returning `{text: string[], images: ...[] }` |
| `server/session-manager.ts:sendInput` | Medium | Three distinct phases (start process, inject context, send message) with guard conditions spread across 60 lines; phase transitions are implicit | Decompose into `ensureAlive()`, `injectContextIfNeeded()`, and `deliverMessage()` helpers; call sequentially |
| `server/session-manager.ts:buildSessionContext` | Medium | Stateful accumulator (`assistantText`) with flush-on-`result` logic duplicated twice at the end, inside a `switch` over message types; the context truncation loop mutates `lines` while reassigning `context` | Use a two-pass approach: collect turn objects first, then render to string with a single truncation step |
| `server/ws-server.ts:(module body)` | Medium | 669-line server entry file mixes CLI arg parsing, auth setup, service instantiation, startup probes, route mounting, WebSocket handler, and process signal handlers; 34 imports | Extract `createServer(config)` factory and move signal handling to a `gracefulShutdown` module |
| `server/orchestrator-routes.ts:createOrchestratorRouter` | Medium | Single router factory with ~600 lines of route definitions covering status, spawn, reports, memory CRUD, trust records, learning, and decision tracking — ~10 unrelated concerns | Split into sub-routers: `orchestrator-session-routes`, `orchestrator-memory-routes`, `orchestrator-learning-routes` |

---

## Coupling & Cohesion Issues

### 1. `opencode-process.ts` — Module-level mutable singleton (`serverState`)

The `serverState` object is a module-level variable that holds the shared OpenCode server process, port, and password. All `OpenCodeProcess` instances share it implicitly. This creates hidden global state that makes testing difficult (no way to inject a mock server), makes error recovery fragile (one failed instance can poison the shared state), and prevents running multiple OpenCode servers (e.g., for different repos).

**Suggested fix:** Extract `OpenCodeServerManager` as an injectable class (or at minimum a factory that returns a scoped manager). `OpenCodeProcess` should receive an `OpenCodeServerManager` reference via constructor injection, making the dependency explicit and testable.

---

### 2. `src/App.tsx` — God component for global state

`App.tsx` accumulates all cross-cutting global state that doesn't fit cleanly into a focused hook. It currently owns: active session ID + routing sync, OpenCode model fetching + validation, provider selection, permission mode + ref sync, keyboard shortcuts, error notification timers, diff panel callbacks, and file-change tracking. This makes the component difficult to test and refactor in isolation.

**Suggested fix:** The codebase already decomposes hooks well elsewhere. The remaining concerns in `App.tsx` should move to purpose-built hooks: `useOpenCodeModelSync` (model fetch + set on session switch), `useGlobalKeyBindings` (Cmd+K/Cmd+Shift+D), `useProviderValidation` (CLAUDE_MODELS fallback), and `useErrorNotification` (5s auto-dismiss). The component body should shrink to ~200 lines of JSX wiring.

---

### 3. `server/session-manager.ts` — Mixed responsibilities in private methods

Despite extensive delegation to sub-modules, `SessionManager` retains: `buildSessionContext`, `extractCurrentTurnText`, `stripCurrentTurnOutput`, `handleApiRetry`, `checkContextWarning`, `finalizeResult`, `addToHistory`, `broadcast`, and `archiveSessionIfWorthSaving`. The boundary between what belongs in `SessionManager` and what belongs in `SessionLifecycle` is unclear — some of these private methods are called only from `SessionLifecycle` callbacks, which means `SessionLifecycle` is calling back into `SessionManager` for logic that `SessionLifecycle` itself initiated.

**Suggested fix:** Move `handleApiRetry`, `checkContextWarning`, `finalizeResult`, and the `buildSessionContext` / history helper methods into a new `TurnResultHandler` module, consistent with the existing delegation pattern. `SessionManager` becomes a thinner coordinator.

---

### 4. `server/orchestrator-routes.ts` + `server/orchestrator-learning.ts` — Wide function surface import

`orchestrator-routes.ts` imports 11 named exports from `orchestrator-learning.ts` (`extractMemoryCandidates`, `smartUpsert`, `runAgingCycle`, `recordFindingOutcome`, `getTriageRecommendation`, `loadSkillProfile`, `updateSkillLevel`, `getGuidanceStyle`, `recordDecision`, `assessDecisionOutcome`, `getPendingOutcomeAssessments`) — the entire public API of that module. This tight coupling means any change to `orchestrator-learning.ts` types forces a change in the route handlers. There is no abstraction layer between the HTTP surface and the learning internals.

**Suggested fix:** Introduce an `OrchestratorLearning` class or facade object that encapsulates the module functions. The router imports only this facade, and route handlers call `learning.recordFindingOutcome(...)` rather than importing the function directly. This also enables straightforward mocking in tests.

---

### 5. `server/ws-server.ts` — Entry point as God module

`ws-server.ts` performs startup checks (Claude CLI probe, auth detection), creates all service singletons (`SessionManager`, `WebhookHandler`, `StepflowHandler`, `CommitEventHandler`, `WorkflowEngine`, `OrchestratorMonitor`), mounts all routers, creates the WebSocket server, registers the WS `connection` handler, and installs `SIGTERM`/`SIGINT` process signal handlers — all in a single 669-line file with 34 imports. This makes it impossible to unit-test the server startup logic or mock individual services.

**Suggested fix:** Extract `createExpressApp(sessions, ...)` to a testable factory function in a separate `app.ts`. Keep `ws-server.ts` as a thin bootstrap that calls the factory, picks a port, and starts listening.

---

## Refactoring Candidates

**1. Extract `OpenCodeServerManager` class from `opencode-process.ts`**
- **Location:** `server/opencode-process.ts` lines 63–224
- **Problem:** Module-level singleton `serverState` is implicit global state shared by all `OpenCodeProcess` instances. Cannot be injected, mocked, or reset between tests. `startOpenCodeServer` and `ensureOpenCodeServer` are module-scope functions with no clear owner.
- **Approach:** Create `class OpenCodeServerManager { start(), stop(), getBaseUrl(), authHeaders() }`. Pass an instance to `OpenCodeProcess` constructor. Export a default singleton for production use. This unblocks testing and enables future multi-server support.
- **Effort:** Medium

---

**2. Split `OpenCodeProcess.handleSSEEvent` into per-event methods**
- **Location:** `server/opencode-process.ts:handleSSEEvent` (~lines 492–769)
- **Problem:** ~280 lines in a single method; 6 levels of nesting in the `message.part.updated` branch; the `message.updated` case recursively calls `handleSSEEvent` (implicit recursion that can be confusing); the `session.idle`/`session.status`/`session.updated` cases share identical 4-line bodies duplicated three times.
- **Approach:** Extract `handleMessagePartDelta`, `handleMessagePartUpdated`, `handleSessionIdle`, `handlePermissionAsked` private methods. Deduplicate the three idle-status paths into a single `handleSessionBecameIdle()` call.
- **Effort:** Medium

---

**3. Decompose `App.tsx` into focused hooks**
- **Location:** `src/App.tsx` lines 96–400 (state declarations and `useEffect`s)
- **Problem:** Single component manages provider validation, OpenCode model lifecycle, error notification timers, keyboard bindings, and session-ID persistence — in addition to its legitimate role as JSX orchestrator.
- **Approach:** Extract `useOpenCodeModelSync({ token, activeSessionId, activeSessionProvider, setModel })`, `useGlobalKeyBindings({ setPaletteOpen, setDiffPanelOpen })`, and `useErrorNotification()`. The pattern already exists in `useSessionOrchestration`, `useDocsBrowser`, etc.
- **Effort:** Small

---

**4. Extract `TurnResultHandler` from `SessionManager`**
- **Location:** `server/session-manager.ts` — `handleClaudeResult`, `handleApiRetry`, `checkContextWarning`, `finalizeResult`, `extractCurrentTurnText`, `stripCurrentTurnOutput`, `buildSessionContext` (lines ~962–1390)
- **Problem:** These seven private methods (~430 lines) are all concerned with "what happens when a Claude turn ends". They are called from `SessionLifecycle` callbacks injected into `SessionManager`, making them a separate concern that happens to live in the manager.
- **Approach:** Extract a `TurnResultHandler` class, consistent with how `SessionLifecycle`, `PromptRouter`, and `SessionNaming` were previously extracted. `SessionManager` delegates `handleClaudeResult` to it.
- **Effort:** Medium

---

**5. Split `orchestrator-routes.ts` into sub-routers**
- **Location:** `server/orchestrator-routes.ts` (706 lines)
- **Problem:** A single router file covers 10+ conceptually distinct areas: session status/start, child session management, report scanning, memory CRUD, trust records, notifications, learning (finding outcomes, skill levels, decisions), and agent name config. The file has 12 imports from `orchestrator-learning.ts` alone.
- **Approach:** Split into `orchestrator-session-router.ts`, `orchestrator-memory-router.ts`, and `orchestrator-learning-router.ts`. Mount all three via `createOrchestratorRouter()` at the same path prefix.
- **Effort:** Small

---

**6. Replace `SessionManager.constructor` inline closures with post-construction wiring**
- **Location:** `server/session-manager.ts` lines 132–185
- **Problem:** The constructor passes 20 callback closures to `SessionLifecycle` and `PromptRouter`, including a `const self = this` alias to work around stale closure captures on mutable properties. This pattern is a code smell for "too many things need `this`".
- **Approach:** Wire dependencies after construction using explicit setter/registry calls (e.g. `lifecycle.setContext(context)`), or adopt a dependency-injection container. Short-term: collect all callbacks into a `SessionManagerContext` struct and pass a single object.
- **Effort:** Small

---

**7. Deduplicate reconnect backoff in `opencode-process.ts:subscribeToEvents`**
- **Location:** `server/opencode-process.ts:subscribeToEvents` lines 367–458
- **Problem:** The exponential backoff + attempt-count check is duplicated 3× across the `!res.ok`, clean-EOF, and `catch` paths. Any change to the reconnect policy must be made in all three places.
- **Approach:** Extract `scheduleReconnect(reason: string): boolean` that handles the counter check, warning log, `setTimeout`, and backoff mutation. Return `false` when the limit is exceeded (caller returns early).
- **Effort:** Small

---

**8. Extract `createExpressApp` factory from `ws-server.ts`**
- **Location:** `server/ws-server.ts` (669 lines, 34 imports)
- **Problem:** As the server entry point, `ws-server.ts` combines startup probes, service creation, route mounting, WebSocket setup, and signal handling. There is no way to import the server configuration without side effects (spawning processes, registering routes, etc.).
- **Approach:** Extract `createExpressApp(sessions: SessionManager, services: ServerServices): express.Application` into `app.ts`. Keep `ws-server.ts` as a ~50-line bootstrap. This enables integration tests to call `createExpressApp()` without binding a port.
- **Effort:** Medium

---

**9. Convert `orchestrator-learning.ts` free functions to an injectable class facade**
- **Location:** `server/orchestrator-learning.ts` (705 lines) and its callers
- **Problem:** 11 free functions are imported directly by `orchestrator-routes.ts`. No abstraction layer exists between the HTTP handlers and the learning internals, and the functions access the filesystem and SQLite directly, making route-level tests require real storage.
- **Approach:** Wrap the 11 functions in an `OrchestratorLearning` class that accepts an `OrchestratorMemory` instance via constructor. Existing callers switch from `import { fn }` to `learning.fn()`. Enables mock injection in tests.
- **Effort:** Small

---

**10. Inline `session.idle` / `session.status` / `session.updated` triple duplication**
- **Location:** `server/opencode-process.ts:handleSSEEvent` lines 652–737
- **Problem:** Three separate `case` blocks (`session.status`, `session.updated`, `session.idle`) each contain the same 4-line body: check own session, check `turnComplete`, set `turnComplete=true`, call `flushDeltaBuffer()`, emit `result`. Any fix to turn-completion logic must be applied three times.
- **Approach:** Extract `private handleSessionIdle(): void` and call it from all three cases. This is the lowest-effort, highest-reliability fix for a subtle production bug risk.
- **Effort:** Small
