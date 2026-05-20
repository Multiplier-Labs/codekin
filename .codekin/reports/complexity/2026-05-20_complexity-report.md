# Complexity Report: codekin

**Date**: 2026-05-20T04:32:55.923Z
**Repository**: /srv/repos/codekin
**Branch**: main
**Workflow Run**: b238bc66-8cb6-4b57-b586-f9ca8b399381
**Session**: 5b700104-5a14-4354-9087-f0c4bd5d199a

---

Now I have enough data to produce a thorough report.

---

## Summary

**Overall Complexity Rating: Medium-High**

The codebase is a well-structured TypeScript monorepo (657 source files, ~35k non-test lines), but several modules carry significant complexity. The architecture shows clear modularization effort — `SessionManager` was deliberately broken into `SessionLifecycle`, `PromptRouter`, `SessionPersistence`, etc. — yet the coordinator class still retains 1,708 lines and more than 50 methods, making it the dominant complexity hotspot.

| Metric | Value |
|---|---|
| Total source files (no tests, no worktrees) | ~130 |
| Largest file | `server/session-manager.ts` — 1,708 lines |
| Most complex function | `OpenCodeProcess.handleSSEEvent` — nested switch-in-switch, ~350 lines |
| Deepest nesting | 5–6 levels (`opencode-process.ts` delta handler, `session-lifecycle.ts` exit handler) |

---

## Largest Files

| File | Lines | Primary Responsibility | Refactor Priority |
|---|---|---|---|
| `server/session-manager.ts` | 1,708 | Session lifecycle orchestration, CRUD, event dispatch, worktree management | **High** |
| `server/workflow-engine.ts` | 1,000 | SQLite-backed workflow execution, cron scheduling, run/step lifecycle | Medium |
| `server/opencode-process.ts` | 988 | OpenCode HTTP/SSE client, event mapping, singleton server management | **High** |
| `src/components/InputBar.tsx` | 784 | Chat input with autocomplete, file attach, permission mode, skill menu | Medium |
| `server/claude-process.ts` | 779 | Claude CLI child-process management, NDJSON stream parsing | Medium |
| `src/components/Settings.tsx` | 777 | Settings modal (auth, preferences, integrations, webhook config) | Low |
| `src/App.tsx` | 739 | Root component, wires all hooks and layouts | **High** |
| `server/workflow-loader.ts` | 711 | MD-file workflow parsing, built-in/per-repo loading, step registration | Low |
| `server/webhook-handler.ts` | 702 | GitHub webhook ingestion, CI triage, PR review session dispatch | Medium |
| `server/orchestrator-learning.ts` | 696 | Memory extraction, deduplication, decay, skill modelling | Low |
| `server/ws-server.ts` | 691 | Express bootstrap, WebSocket server startup, route mounting, auth | Medium |
| `server/prompt-router.ts` | 681 | Tool approval, control request, auto-approval resolution | Low |
| `src/components/AddWorkflowModal.tsx` | 645 | Complex multi-step workflow creation form | Medium |
| `src/components/ChatView.tsx` | 620 | Message list renderer with multi-type message handling | Low |
| `server/session-routes.ts` | 604 | Session REST API (CRUD, worktree, model, permission, diff, hooks) | Medium |

---

## Most Complex Functions

| Location | Estimated Complexity | Issue Description | Refactor Suggestion |
|---|---|---|---|
| `server/opencode-process.ts:492` `OpenCodeProcess.handleSSEEvent` | Very High | ~300 line outer `switch` containing a nested `switch` inside `message.part.updated`; reasoning-delta state machine tracks 7+ boolean flags (`inReasoningPhase`, `receivedDeltas`, `emittedPartText`, `deltaBufferFlushed`, `emittedReasoningSummary`, `deltaBuffer`, `reasoningBuffer`) | Extract each `case` into its own private method: `handlePartDelta`, `handlePartUpdated`, `handleSessionStatus`, etc. Extract the reasoning-buffer logic into a `ReasoningTracker` helper class. |
| `server/session-manager.ts:442` `SessionManager.createWorktree` | High | ~130 line method making 6+ sequential `execFileAsync` calls with complex branching on branch existence, stale state cleanup, and fallback paths | Extract into a `WorktreeManager` class with `ensureClean`, `createBranch`, `attachWorktree` sub-methods |
| `server/session-manager.ts:1061` `SessionManager.handleClaudeResult` | High | Orchestrates headless cap logic, API retry, context warning, result finalization — 4 distinct responsibilities in one function | Already partially delegated; `handleApiRetry` and `checkContextWarning` are extracted. Move `headless-cap` logic to `finalizeResult` or a dedicated `enforceHeadlessCap` method. |
| `server/opencode-process.ts:367` `OpenCodeProcess.subscribeToEvents` | High | Closure-heavy SSE reconnect loop with 5-level nesting: `connectSSE` → `fetch.then` → `while(alive)` → `for(lines)` → try/catch; reconnect state managed via captured variables | Extract SSE reading into a `readSSEStream` async generator and reconnect policy into a `SSEReconnector` class |
| `server/session-lifecycle.ts:65` `SessionLifecycle.startClaude` | High | Long branching method handling worktree fallback, provider selection (Claude vs OpenCode), building 15+ CLI args, wiring 10+ event handlers | Extract arg-building into `buildClaudeArgs` and event wiring into `wireProcessEvents` |
| `server/session-manager.ts:224` `SessionManager.reapIdleSessions` | Medium-High | Two sequential loops with overlapping conditions, mixed concerns (idle reaping + stale pruning) plus multiple special-case exemptions | Split into `stopIdleSessions()` and `pruneStaleSession()` private methods called from `reapIdleSessions` |
| `src/App.tsx:48` `App` (render function) | Medium-High | 739-line component function managing 20+ state variables, 15+ hooks, and rendering 5 mutually exclusive content areas via inline conditions | Content areas are already partially extracted (`SessionContent`, `OrchestratorContent`, `DocsBrowserContent`) — finish the extraction; pull remaining state into a dedicated `useAppState` hook |
| `src/components/InputBar.tsx:280` `InputBar` | Medium | Three separate render variants (desktop, mobile, orchestrator) sharing common callbacks but duplicating JSX; 784 lines total; complex drag-resize with raw DOM event listeners | Extract `DesktopInputBar`, `MobileInputBar`, `OrchestratorInputBar` as separate components; extract drag logic into `useDragResize` hook |
| `server/session-routes.ts:129` `createSessionRouter` | Medium | Single 475-line factory function registering 25 REST routes with inline business logic; workingDir path-validation code duplicated on at least 3 routes | Extract path validation into a `validateWorkingDir(req, res)` middleware; split into `createSessionCrudRouter`, `createSessionControlRouter`, `createHookRouter` |
| `server/opencode-process.ts:84` `ensureOpenCodeServer` / `startOpenCodeServer` | Medium | Module-level mutable singleton state (`serverState`) shared between two free functions; `startOpenCodeServer` makes 30-attempt polling loop with embedded fallback logic | Encapsulate in an `OpenCodeServerManager` singleton class with clear `start`, `stop`, `getBaseUrl` API |

---

## Coupling & Cohesion Issues

**1. `SessionManager` as a residual God Object**

Despite deliberate extraction into `SessionLifecycle`, `PromptRouter`, `SessionPersistence`, `SessionNaming`, and `DiffManager`, `SessionManager` still implements worktree creation (130+ lines), Claude session file migration, API retry logic, context-warning logic, orchestrator noise filtering, and a rate-limit circuit breaker. The constructor wires 14 callback dependencies into `SessionLifecycle` alone. The class has more than 50 methods. Suggested fix: move worktree operations to a `WorktreeManager` class; move API-retry and context-warning logic to a `ResultHandler` class; reduce `SessionLifecycle` dependencies to a smaller, typed interface.

**2. `opencode-process.ts` mixes process class with singleton server management**

`OpenCodeProcess` (the per-session class) and the singleton `serverState` / `startOpenCodeServer` / `ensureOpenCodeServer` free functions live in the same file. This means the module-level server is reset whenever any individual `OpenCodeProcess` is imported, and tests cannot isolate the two concerns. `stopOpenCodeServer` is exported as a top-level function from the same file. Suggested fix: move server management to `OpenCodeServerManager` in a separate file; `OpenCodeProcess` takes a `serverManager` dependency.

**3. `ws-server.ts` doubles as a startup script and a router mount**

The file contains CLI argument parsing, token reading, auth helper functions, health-check logic, webhook and workflow initialisation, and all route mounting — all at module scope. It is effectively non-testable because importing it starts the server. Suggested fix: separate `startServer(config)` from the module-level initialization; extract auth middleware to `auth-middleware.ts`.

**4. `session-routes.ts` duplicates path-validation logic**

The `workingDir` bounds-check block (`realpathSync` → `allowedRoots` membership check) appears verbatim on at least three different route handlers inside `createSessionRouter`. Suggested fix: extract a `requireSafeWorkingDir(req, res)` middleware or helper.

**5. `App.tsx` is a god component with 20+ state variables**

The root `App` component directly manages session state, connection state, diff panel state, modal state, provider state, worktree state, queue state, and docs-browser state. Even though most behaviour is delegated to hooks, the component itself has 20+ `useState`/`useRef` declarations and passes deeply nested callbacks down to children. Suggested fix: consolidate into 2–3 domain-specific context providers (`SessionContext`, `UIContext`) to remove prop-drilling and reduce the component's surface.

**6. Reasoning-buffer logic repeated in `opencode-process.ts`**

The pattern "accumulate reasoning text → check length → extract first sentence → emit thinking" appears 3 times in `handleSSEEvent` (in the `message.part.delta` field-text path, the field-reasoning path, and the `message.part.updated` reasoning-part path). Suggested fix: extract a `maybeEmitThinking(buffer: string): string | null` helper called from all three sites.

---

## Refactoring Candidates

**1. Extract `WorktreeManager` from `SessionManager`**
- **Location**: `server/session-manager.ts:442–720` (`createWorktree`, `migrateClaudeSession`, `cleanupWorktree`, `detectDefaultBranch`, `copyDirRecursive`, `claudeProjectPath`, `getWorktreeBranchPrefix`)
- **Problem**: Seven closely related worktree methods total ~280 lines buried inside `SessionManager`, making the class harder to read and the worktree logic impossible to test in isolation.
- **Approach**: Create `server/worktree-manager.ts` with a `WorktreeManager` class. `SessionManager` owns an instance and delegates via thin one-liners.
- **Effort**: Medium

**2. Refactor `OpenCodeProcess.handleSSEEvent` into sub-handlers**
- **Location**: `server/opencode-process.ts:492–800`
- **Problem**: One method handles 8 SSE event types, with a nested switch for message parts, plus duplicated reasoning-buffer logic across 3 code paths and 7 tracking booleans that interact in non-obvious ways.
- **Approach**: Extract each outer `case` to a private method (`onPartDelta`, `onPartUpdated`, `onSessionStatus`, etc.); extract reasoning tracking to a small `ReasoningEmitter` helper; extract delta buffering to `DeltaBuffer`.
- **Effort**: Medium

**3. Extract `OpenCodeServerManager` singleton**
- **Location**: `server/opencode-process.ts:64–228`
- **Problem**: Module-level mutable `serverState` object and three free functions (`ensureOpenCodeServer`, `startOpenCodeServer`, `authHeaders`) cannot be mocked or reset between tests, and conflate server lifecycle with the per-session `OpenCodeProcess` class.
- **Approach**: Create `server/opencode-server-manager.ts` exporting a singleton class with `ensureRunning(workingDir)`, `stop()`, `getBaseUrl()`. Inject it into `OpenCodeProcess` constructor.
- **Effort**: Small

**4. Break `App.tsx` state into context providers**
- **Location**: `src/App.tsx:48–739`
- **Problem**: 20+ `useState`/`useRef` declarations, 15+ hooks, and all cross-component callbacks in one component function. Prop drilling reaches 4–5 levels. Adding new top-level UI state requires touching `App.tsx`.
- **Approach**: Extract `SessionContext` (active session, sessions list, orchestration callbacks) and `UIContext` (settings open, palette open, diff panel) as React context providers. `App` becomes a composition of contexts + layout.
- **Effort**: Large

**5. Deduplicate `workingDir` path-validation in `session-routes.ts`**
- **Location**: `server/session-routes.ts` (routes at lines ~148, ~170, ~280)
- **Problem**: The `realpathSync` → `allowedRoots` bounds-check block is copy-pasted verbatim on at least three handlers, violating DRY and making it easy for a new route to miss the check.
- **Approach**: Extract `validateWorkingDir(rawDir: string): { resolvedDir: string } | { error: string; status: number }` helper and call it at the top of each handler.
- **Effort**: Small

**6. Decompose `InputBar.tsx` into variant components**
- **Location**: `src/components/InputBar.tsx`
- **Problem**: The file exports one large component (`InputBar`) with conditional JSX blocks for desktop, mobile, and orchestrator variants, plus shared atom sub-components (`AttachButton`, `SendButton`, `PermissionModeDropdown`). The drag-resize logic uses raw `document.addEventListener` with cleanup inside a `useCallback`.
- **Approach**: Move atom sub-components to `src/components/input/` sub-directory; extract drag logic into `useDragResize`; create `MobileInputBar` and `DesktopInputBar` that use the same atoms.
- **Effort**: Medium

**7. Decouple `ws-server.ts` startup script from route mounting**
- **Location**: `server/ws-server.ts`
- **Problem**: Module-level side effects (arg parsing, token loading, process listeners) make unit testing impossible — importing the file starts the server. Route mounting for 10+ routers is interleaved with initialization code.
- **Approach**: Wrap everything after the constant declarations in an exported `startServer(config: ServerConfig): void` function. Move auth helpers to `server/auth-middleware.ts`. Route-mounting can stay in `ws-server.ts` but should operate on a passed `app` instance.
- **Effort**: Medium

**8. Extract `ResultHandler` from `SessionManager`**
- **Location**: `server/session-manager.ts:1061–1224` (`handleClaudeResult`, `checkContextWarning`, `handleApiRetry`, `finalizeResult`, `onRateLimitEvent`)
- **Problem**: These five methods (160 lines total) implement a self-contained "what to do when Claude finishes a turn" state machine, but live inside the 1,700-line `SessionManager` class, diluting its cohesion.
- **Approach**: Create a `ResultHandler` class (similar to `SessionLifecycle` / `PromptRouter`) that receives broadcast and history callbacks and owns the retry/warning/finalize logic.
- **Effort**: Medium