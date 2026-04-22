# Code Complexity Report — 2026-04-22

## Summary

**Overall complexity rating: High**

The codebase comprises ~34,000 lines of TypeScript/TSX across ~60 production source files (excluding tests and worktrees). The server layer, in particular, carries significant complexity driven by process lifecycle management, multi-provider streaming, and webhook orchestration. The frontend root component has grown into a coordination hub aggregating too many concerns.

| Metric | Value |
|---|---|
| Total source lines (excl. tests/worktrees) | ~34,000 |
| Files over 300 lines | 33 |
| Files over 500 lines | 18 |
| Files over 700 lines | 9 |
| Largest file | `server/session-manager.ts` (1,594 lines) |
| Most complex single function | `opencode-process.ts:handleSSEEvent()` (~277 lines, 12 event types, 6-level nesting) |
| Deepest JSX nesting | `App.tsx` (6–7 levels) |
| Highest import count | `server/ws-server.ts` (35 imports) |

---

## Largest Files

| File | Lines | Primary Responsibility | Refactor Priority |
|---|---|---|---|
| `server/session-manager.ts` | 1,594 | Session lifecycle orchestration, API retry, history, worktree management | **High** |
| `server/opencode-process.ts` | 988 | OpenCode provider: SSE streaming, delta parsing, tool tracking | **High** |
| `src/components/InputBar.tsx` | 784 | Prompt input, file attachment, model/permission dropdowns, drag-resize | Medium |
| `src/components/Settings.tsx` | 777 | Settings modal, webhook setup wizard, health checks, retention config | Medium |
| `server/claude-process.ts` | 765 | Claude CLI process management, stream-json protocol, thinking extraction | Medium |
| `server/workflow-engine.ts` | 747 | Step execution, cron scheduling, SQLite persistence, run lifecycle | Low |
| `src/App.tsx` | 739 | Root layout, view routing, hook orchestration, localStorage, keyboard bindings | **High** |
| `server/orchestrator-learning.ts` | 705 | Pattern learning, memory aging, skill level tracking, journal compaction | Medium |
| `server/webhook-handler.ts` | 702 | GitHub webhook processing, PR/push/workflow-run events, session spawning | Medium |
| `server/prompt-router.ts` | 681 | Tool approval routing, auto-approve, allowlist pattern matching, timeouts | Medium |
| `server/ws-server.ts` | 669 | Express + WebSocket server wiring, auth, rate limiting, startup sequence | Medium |
| `src/components/AddWorkflowModal.tsx` | 645 | Workflow creation/editing UI form | Low |
| `src/components/ChatView.tsx` | 620 | Message rendering, tool-run grouping, scroll management, noise filtering | Low |
| `src/lib/ccApi.ts` | 577 | All REST API calls to the Codekin backend | Low |
| `server/session-routes.ts` | 568 | Session CRUD routes, file browsing, bulk approval ops | Low |

---

## Most Complex Functions

| Location | Est. Complexity | Issue Description | Refactor Suggestion |
|---|---|---|---|
| `server/opencode-process.ts:handleSSEEvent()` | Very High | ~277 lines, monolithic switch handling 12 SSE event types with 5–6 levels of nesting; message delta accumulation, reasoning phase detection, tool tracking, and completion signals all interleaved | Extract one handler per event type family (`handleMessagePart`, `handleToolUpdate`, `handleSessionEvent`, etc.) |
| `server/session-lifecycle.ts:handleClaudeExit()` | High | ~150 lines; restart FSM with 5 distinct outcomes (non-retryable, stopped, restart, exhausted, directory-missing fallback); duck-typed method detection for ClaudeProcess vs OpenCodeProcess | Introduce typed `ExitContext` and dedicated `RestartCoordinator`; remove duck-typing with provider protocol |
| `server/session-lifecycle.ts:startClaude()` | High | ~120 lines; path validation, worktree fallback, env construction, process branching (ClaudeProcess vs OpenCodeProcess), event wiring — all in one method | Extract provider factory, path validation step, and env builder into separate functions |
| `server/prompt-router.ts:requestToolApproval()` | High | ~149 lines; promise wrapping with timeout, multi-branch approval routing (auto-approve, registry, UI prompt), pattern matching for parameterized tools like `Bash(curl:*)` | Extract `TimeoutPromise` helper, separate approval decision from approval delivery |
| `server/opencode-process.ts:subscribeToEvents()` | High | ~85 lines; SSE reconnect loop with exponential backoff, streaming line parser, session-ID filtering guard, abort signal propagation | Extract backoff loop and line-buffer logic into standalone utilities |
| `server/session-manager.ts:executeRun()` | High | ~109 lines; event-driven run loop mixing input queuing, API retry scheduling, context injection, and idle detection | Break into: `queueInput()`, `scheduleRetry()`, `injectContext()` — called by a thin coordinator |
| `server/orchestrator-learning.ts:extractMemoryCandidates()` | Medium-High | ~109 lines; 18+ inline regex pattern tests with hardcoded confidence values (0.9, 0.6, 0.8) scattered through conditions; no named constants for thresholds | Define pattern rules as a typed array (`{ regex, confidence, category }[]`); iterate instead of sequential if-chains |
| `server/webhook-handler.ts:handleWorkflowRunEvent()` | Medium-High | ~120 lines; complex async flow for fetching failed job logs, building prompts, creating workspaces, and spawning sessions; deeply nested Promise.all with non-blocking GitHub calls | Extract `buildWorkflowRunPrompt()`, `fetchFailedJobDetails()` into separate modules |
| `src/App.tsx` (main render) | Medium-High | ~235-line JSX return with 5 conditional view branches; 9 refs for cross-hook coordination; 8 useEffect blocks with careful but fragile dependency arrays | Introduce a view-router component; lift per-view state into dedicated feature components |
| `server/stepflow-handler.ts:postCallback()` | Medium | SSRF protection logic for IPv4-mapped IPv6 addresses (`::ffff:x.x.x.x`) with hex-to-dotted conversion inline; correct but opaque | Extract `validateCallbackUrl(url, allowlist)` with its own tests |

---

## Coupling & Cohesion Issues

### 1. `server/ws-server.ts` — Application Wiring God Module
Imports 35 modules and acts as both the HTTP/WS server and the application bootstrap layer. It initializes the database, loads configs, registers all routes, wires webhooks, starts the orchestrator, and handles graceful shutdown. Any module addition requires touching `ws-server.ts`. **Suggested fix:** introduce an `AppBootstrapper` class that encapsulates startup ordering; `ws-server.ts` becomes a thin entry point.

### 2. `src/App.tsx` — Frontend God Component
Imports 16 hooks and 12 components. Manages 9 `useRef` values for cross-hook coordination (e.g. `permissionModeRef`, `autoJoinedRef`, `pendingContextRef`), 8 `useEffect` blocks, and 5 view branches in a single render tree. Responsibility spans: view routing, session lifecycle, file uploads, keyboard shortcuts, localStorage, and error notifications. **Suggested fix:** extract a `SessionController` component for session lifecycle, a `ViewRouter` for view branching, and delegate localStorage keys to `useSettings`.

### 3. `server/session-manager.ts` — Partially Decomposed Hub
Despite substantial prior extraction into `SessionLifecycle`, `PromptRouter`, `DiffManager`, etc., `SessionManager` still directly implements: git worktree creation (`createWorktree`), idle session detection/reaping, API retry scheduling, output history management, and session persistence — alongside coordinating all delegated modules. **Suggested fix:** complete the extraction by pulling git/worktree operations into `WorktreeManager` and idle-reaper logic into `SessionReaper`.

### 4. Duplicate Task Tracking: `claude-process.ts` vs `opencode-process.ts`
Both files independently track `currentTaskId`, `totalTasks`, and `completedTasks` with parallel logic and identical field names. Any change to task tracking semantics must be made in two places. **Suggested fix:** introduce a shared `TaskTracker` class or mixin, instantiated by each process implementation.

### 5. `server/orchestrator-learning.ts` — Mixed Concerns
A single class handles: memory aging with TTL constants, pattern extraction with inline regex, Jaccard similarity for deduplication, skill level state transitions with hardcoded thresholds, and direct file I/O for journal compaction and skill profile persistence. **Suggested fix:** split into `MemoryAging`, `PatternExtractor`, and `SkillTracker`; move file I/O into `OrchestratorPersistence`.

### 6. Magic Constants Scattered Across Server Modules
Timeouts, thresholds, and retry limits appear as inline literals across multiple files: `30_000` (waitForReady), `60_000` (idle input threshold), `300_000` (approval timeout), `0.95` (decay rate), `0.85` (dedup threshold), `2000` (MAX_HISTORY). No central constants module exists. **Suggested fix:** consolidate into `server/constants.ts` grouped by domain.

### 7. `server/session-routes.ts` — Large Route Handler File
15+ route handlers in a single file, including directory traversal protection, symlink dereferencing, bulk approval deletion, and session CRUD — all co-located. Route handler logic is difficult to unit-test in isolation. **Suggested fix:** move business logic into service functions; keep route files as thin request/response adapters.

---

## Refactoring Candidates

**1. Extract SSE event handlers from `opencode-process.ts:handleSSEEvent()`**
- **Location:** `server/opencode-process.ts`, line ~492
- **Problem:** ~277 lines of interleaved event-type handling. Adding a new event type or debugging existing behavior requires navigating the entire function.
- **Suggested approach:** Define a `SseEventHandlers` map of `eventType → handler(event, state)`. Extract state (delta buffer, reasoning phase, task tracking) into a typed `SseSessionState` object passed to each handler.
- **Effort:** Medium

**2. Decompose `App.tsx` into feature-scoped components**
- **Location:** `src/App.tsx`
- **Problem:** 739-line root component is the only place session lifecycle, view routing, keyboard shortcuts, and error handling co-exist. A change to any feature risks breaking others; testing requires mounting the entire app.
- **Suggested approach:** Extract `<ViewRouter>` (5-branch view switch), `<SessionController>` (create/join/leave/delete + refs), and move localStorage keys into `useSettings`. Each feature slice becomes independently testable.
- **Effort:** Large

**3. Complete `session-manager.ts` decomposition**
- **Location:** `server/session-manager.ts`
- **Problem:** Still 1,594 lines after prior extraction. Git/worktree operations (`createWorktree`, worktree cleanup), idle reaper timer, and API retry scheduler remain inline alongside module coordination.
- **Suggested approach:** Move `createWorktree` + cleanup into `server/worktree-manager.ts`; move idle detection into `server/session-reaper.ts`. `SessionManager` becomes a coordinator with no direct business logic.
- **Effort:** Medium

**4. Introduce a shared `TaskTracker` for process implementations**
- **Location:** `server/claude-process.ts`, `server/opencode-process.ts`
- **Problem:** Both files duplicate task ID, count, and completion tracking with identical field names and parallel update logic.
- **Suggested approach:** Extract a `TaskTracker` class with `start(id, total)`, `complete()`, `reset()`, and `snapshot()` methods. Both `ClaudeProcess` and `OpenCodeProcess` instantiate it.
- **Effort:** Small

**5. Consolidate server-side constants into `server/constants.ts`**
- **Location:** Scattered across `session-manager.ts`, `prompt-router.ts`, `session-lifecycle.ts`, `opencode-process.ts`, `orchestrator-learning.ts`
- **Problem:** Timeouts, retry limits, and ML thresholds appear as bare numeric literals with no discoverability. Changing a timeout requires a grep across the server directory.
- **Suggested approach:** Create `server/constants.ts` with named exports grouped by domain: `SESSION_TIMEOUTS`, `RETRY_CONFIG`, `LEARNING_THRESHOLDS`. Import by name at each use site.
- **Effort:** Small

**6. Extract `InputBar.tsx` sub-components into separate files**
- **Location:** `src/components/InputBar.tsx`
- **Problem:** `ModelDropdown` (with ref-managed keyboard navigation and model search), `PermissionModeDropdown`, and the drag-to-resize handler are all co-located in one 784-line file. The component accepts 20 props, making it a test and reuse bottleneck.
- **Suggested approach:** Move `ModelDropdown` → `src/components/ModelDropdown.tsx`, drag-resize logic → `src/hooks/useDragResize.ts`. Reduce `InputBar` props by grouping model-related props behind a `modelConfig` object.
- **Effort:** Small

**7. Extract `validateCallbackUrl()` from `stepflow-handler.ts`**
- **Location:** `server/stepflow-handler.ts:postCallback()`, lines ~420–460
- **Problem:** IPv4-mapped IPv6 normalization and private-IP blocklist are embedded inline in the callback method, making them impossible to unit-test without a full HTTP call.
- **Suggested approach:** Extract to `server/url-validation.ts` with exported `validateCallbackUrl(url: string, allowedHosts: string[]): void` (throws on violation). Add targeted unit tests.
- **Effort:** Small

**8. Separate file I/O from learning logic in `orchestrator-learning.ts`**
- **Location:** `server/orchestrator-learning.ts`
- **Problem:** Journal compaction reads/writes Markdown files and skill profiles persist to JSON, all within the same class that runs aging cycles and extracts patterns. Pure learning logic cannot be tested without touching the filesystem.
- **Suggested approach:** Extract `OrchestratorPersistence` for all file I/O; inject it into `OrchestratorLearning`. Learning logic becomes purely functional and testable.
- **Effort:** Medium
