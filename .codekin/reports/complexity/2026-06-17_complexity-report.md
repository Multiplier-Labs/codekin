# Complexity Report: codekin

**Date**: 2026-06-17T04:33:53.055Z
**Repository**: /srv/repos/Multiplier-Labs/codekin
**Branch**: main
**Workflow Run**: 0d698766-5c26-440c-8a2e-186d45e33565
**Session**: 539067db-5549-46cd-8ee3-71c82af245ac

---

Now I have enough data to produce a thorough report.

## Summary

**Overall Complexity Rating: Medium-High**

The codebase is a well-structured TypeScript monorepo (260 source files, ~76 K total lines). Architectural decomposition is clearly intentional — `SessionManager` has been partially broken up into sub-managers, and the three process implementations share a `CodingProcess` interface. However, several files have grown very large and have high internal complexity, primarily driven by multi-protocol adapter logic and a God-class tendency in `SessionManager`. The most critical metrics:

- **Largest file**: `session-manager.test.ts` at 3,971 lines (test), `opencode-process.ts` at 1,834 lines (production)
- **Deepest nesting**: `handleSSEEvent` in `opencode-process.ts` — 4+ switch/case levels with nested conditionals inside each case
- **Most complex function**: `sendMessage` in `opencode-process.ts` — ~180 lines, handles 4+ distinct paths (slash commands, attachments, compact, prompt), with 3–4 levels of conditionals

---

## Largest Files

| File | Lines | Primary Responsibility | Refactor Priority |
|---|---|---|---|
| `server/opencode-process.ts` | 1,834 | OpenCode HTTP/SSE adapter with streaming text, tool tracking, reasoning dedup, `<think>` tag stripping | **High** |
| `server/session-manager.ts` | 1,789 | Session CRUD, process lifecycle, worktree management, context injection | **High** |
| `server/workflow-engine.ts` | 1,028 | SQLite-backed workflow runner, cron scheduling, step orchestration | Medium |
| `server/claude-process.ts` | 892 | Claude CLI adapter (stdin/stdout NDJSON protocol) | Medium |
| `server/codex-process.ts` | 860 | Codex HTTP adapter — structurally mirrors `claude-process.ts` | Medium |
| `server/orchestrator-children.ts` | 813 | Child agent spawning, monitoring, timeout/blocked detection, git ops | Medium |
| `src/App.tsx` | 828 | Root React component — wires all hooks and layout regions | **High** |
| `src/components/InputBar.tsx` | 805 | Chat input UI with autocomplete, permission mode picker, drag resize | Medium |
| `src/components/Settings.tsx` | 777 | Full settings panel (auth, models, approval rules, worktree config) | Low |
| `server/prompt-router.ts` | 771 | Tool-approval routing, auto-deny on disconnect, headless-path logic | Medium |
| `server/ws-server.ts` | 724 | Express HTTP + WebSocket server entry point, 41 imports | Medium |
| `server/workflow-loader.ts` | 711 | Markdown workflow parsing and execution shim | Low |
| `server/webhook-handler.ts` | 702 | GitHub webhook ingestion, CI result routing, job dispatch | Low |
| `server/orchestrator-learning.ts` | 696 | Memory dedup, FTS similarity scoring, upsert logic | Low |
| `server/session-routes.ts` | 642 | REST API routes for session management | Low |

---

## Most Complex Functions

| File:Function | Est. Complexity | Issue Description | Refactor Suggestion |
|---|---|---|---|
| `server/opencode-process.ts:984` — `handleSSEEvent` | Very High | 300-line switch with 10 cases; `message.part.updated` has a nested switch of 4 sub-cases; inner cases have 3–4 additional conditionals. Cyclomatic complexity ≈ 30+. | Extract each top-level case to a private handler method (`handlePartDelta`, `handlePartUpdated`, `handlePermissionAsked`, etc.). |
| `server/opencode-process.ts:1582` — `sendMessage` | High | ~180 lines; branches for attachment parsing, file MIME detection, `/compact`, slash-command routing, model split, and plan mode. 4 distinct early-return paths with inline async fetch calls. | Extract `buildMessageParts`, `routeSlashCommand`, `sendCompact`, `sendPrompt` as separate private methods; each under 40 lines. |
| `server/session-manager.ts:444` — `createWorktree` | High | ~125 lines; 6 nested try/catch/await blocks, branching on branch existence × ephemeral flag × cleanup outcomes. Difficult to test without git. | Extract `cleanupStaleWorktree`, `resolveWorktreeBranch`, `copySessionData` into standalone helpers. |
| `server/opencode-process.ts:758` — `stripThinkTags` | Medium-High | 40-line streaming state machine; two interleaved state flags (`thinkActive`, `thinkCarry`) that interact with `partialTagTail`. The logic is subtle and easy to break. | Consolidate into a `ThinkTagStripper` class with clear state and unit tests against edge cases. |
| `server/session-manager.ts:860` — `leave` | Medium | 60-line method with nested `setTimeout` closure, double-check pattern, agent-source guard, and two separate pending-map clear loops. Auto-deny logic is easy to silently break. | Extract `autoDenyPendingPrompts` and `scheduleAutoDenyOnDisconnect`; keep `leave` as a thin coordinator. |
| `server/session-manager.ts:1524` — `buildSessionContext` | Medium | Reconstructs conversation history via a switch/accumulator loop, with multiple flush points and a trailing-truncation loop. Magic number `4000`. | Named constant for the char cap; extract `accumulateAssistantText`, `renderContextLine`. |
| `src/App.tsx:51` — `App` component | Medium-High | 800-line component function with 30+ hooks, 10+ `useState`/`useRef` declarations, and multiple `useCallback`s that depend on each other. | Extract `useAppState`, `useSessionLifecycle`, `useDiffPanel` composite hooks; the component should be a thin composition shell. |
| `server/opencode-process.ts:893` — `classifyPart` | Medium | REST round-trip inside a streaming hot path; logic for in-flight dedup, partial-result retries, and buffer flushing across multiple maps. | Introduce a `PartClassifier` sub-object to own the four interrelated maps and dedup guards. |
| `server/session-manager.ts:1091` — `handleClaudeResult` | Medium | Orchestrates headless cap, API retry, context warning, and result finalization in sequence — delegates to three helpers but still contains the full conditional chain. | The cap and retry checks should live in `ProcessCoordinator`; `handleClaudeResult` should only call `checkContextWarning` and `finalizeResult`. |
| `server/opencode-process.ts:612` — `subscribeToEvents` | Medium | Inner `connectSSE` closure with nested `.then(async)` and a separate `.catch`; reconnect-delay state shared via closure. 110 lines inside the outer method. | Extract `connectSSE` to a private method; pass reconnect state via a small class so tests can inspect it. |

---

## Coupling & Cohesion Issues

**1. `opencode-process.ts` — 25 private instance fields + shared module-level singleton**
`OpenCodeProcess` manages turn state, streaming dedup, reasoning routing, `<think>` tag parsing, attachment handling, slash-command routing, subagent tracking, and permission retry — all in one class, totalling ~25 private fields. Additionally, `serverState` is a module-level singleton shared across all instances, which couples every `OpenCodeProcess` to each other and makes isolated testing impossible without mocking the singleton.
*Suggested fix*: Extract `StreamingState` (delta buffer, reasoning buffer, think-tag state, part kind cache) into a separate class. Extract `OpenCodeServerManager` as an injectable dependency wrapping `serverState`.

**2. `session-manager.ts` — partial God class despite delegation attempts**
Although `SessionManager` has already been decomposed into `SessionLifecycle`, `SessionNaming`, `SessionPersistence`, and `PromptRouter`, the 1,789-line file still contains worktree operations (`createWorktree`, `cleanupWorktree`, `detectDefaultBranch`, `migrateClaudeSession`, `copyDirRecursive`), idle-reaping, context building, history management, and shutdown orchestration. These are unrelated responsibilities pulled together by the session entity.
*Suggested fix*: Extract `WorktreeManager` (worktree CRUD and branch lifecycle) and move history management to `SessionHistory` module.

**3. `handleTaskTool` duplicated across process implementations**
`ClaudeProcess` and `OpenCodeProcess` each define a private `handleTaskTool` method with nearly identical logic (normalized tool-name matching, TodoWrite/TaskCreate/TaskUpdate handling, `syncTaskSeq`). `CodexProcess` does not implement it, which creates an invisible behavioural gap for Codex sessions.
*Suggested fix*: Extract `TaskTracker` as a shared utility class that all three process implementations compose. Eliminates duplication and ensures `CodexProcess` gets todo support automatically.

**4. `ws-server.ts` — 41 imports, high fan-in**
The server entry point imports from 41 modules, including every router, manager, handler, and config helper. It acts as a wiring hub rather than a minimal entry point, which means any change to server startup requires reading almost the entire import graph.
*Suggested fix*: Group routers behind a `createApiRouter(deps)` factory; separate startup side-effects (hook sync, session restore, monitor start) into a `ServerBootstrap` class.

**5. `opencode-process.ts` — direct `serverState.port` references inside class methods**
`classifyPart`, `checkTurnLiveness`, `replyToPermission`, `stop`, and `sendMessage` all access the module-level `serverState.port` directly rather than through a getter. This creates hidden coupling: if the server restarts on a new port, any instance that cached the old base URL will fail silently. The base URL is only re-resolved in `subscribeToEvents` after a reconnect.
*Suggested fix*: Compute `baseUrl` via a `currentBaseUrl()` helper that always reads from `serverState` rather than mixing direct access and cached strings.

**6. `src/App.tsx` — orchestration hooks all co-located**
`App.tsx` coordinates 15+ imported hooks (`useChatSocket`, `useSessionOrchestration`, `useDocsBrowser`, `useGlobalKeyBindings`, `useOpenCodeModelSync`, etc.), all firing in the same component function body with 30+ local state variables. A render of `App` involves resolving all of these hooks in a fixed order, creating implicit dependency chains that are easy to break.
*Suggested fix*: Introduce a `useAppCore` composite hook that owns session state, connection, and routing; a `useUiState` hook for panel/sidebar toggles; and a `useProviders` hook for model/command sync. `App` should be a thin compositor.

---

## Refactoring Candidates

1. **Extract `StreamingState` from `OpenCodeProcess`**
   *Location*: `server/opencode-process.ts`, lines 425–472 (25 instance fields for streaming)
   *Problem*: A single object holds turn latches, delta buffers, reasoning state, part-kind caches, and `<think>` tag parser state. Adding or debugging any one of these requires understanding all others.
   *Approach*: Create a `StreamingState` class (or plain object with a factory reset method) that owns these fields and provides `reset()`, `recordDelta()`, `recordPartKind()`, and `flushAll()` methods. `OpenCodeProcess.sendMessage` calls `this.streamingState.reset()` at turn start.
   *Effort*: Medium

2. **Extract `WorktreeManager` from `SessionManager`**
   *Location*: `server/session-manager.ts`, lines 444–722 (`createWorktree`, `cleanupWorktree`, `detectDefaultBranch`, `migrateClaudeSession`, `copyDirRecursive`)
   *Problem*: ~280 lines of git worktree logic (with its own retry loops, branch strategy, and file copying) are embedded in the session manager. Worktree cleanup races with process teardown and is hard to test in isolation.
   *Approach*: New `server/worktree-manager.ts` class taking `execFileAsync` and `sessions` as injectables. `SessionManager` delegates `createWorktree` and `cleanupWorktree` to it.
   *Effort*: Medium

3. **Unify `TaskTracker` across process implementations**
   *Location*: `server/claude-process.ts:652`, `server/opencode-process.ts:1499`
   *Problem*: Identical `handleTaskTool` logic maintained independently; Codex has no task tracking at all. A bug fix in one doesn't propagate to the other.
   *Approach*: Create `server/task-tracker.ts` exporting a `TaskTracker` class with `handleTool(name, input): boolean` and `getTasks(): TaskItem[]`. All process classes compose it.
   *Effort*: Small

4. **Break `handleSSEEvent` into per-event handlers**
   *Location*: `server/opencode-process.ts:984–1288`
   *Problem*: 300-line switch with deeply nested inner switches (e.g. `message.part.updated` → `part.type`). Each case has independent state mutations. Adding a new event type requires reading the entire method.
   *Approach*: Each top-level case becomes a private method (e.g. `onPartDelta`, `onPartUpdated`, `onPermissionAsked`, `onMessageUpdated`). The switch becomes 10 one-liner dispatch calls. Inner part-type handling in `onPartUpdated` can be a nested strategy map.
   *Effort*: Medium

5. **Simplify `sendMessage` in `OpenCodeProcess`**
   *Location*: `server/opencode-process.ts:1582–1759`
   *Problem*: ~180-line method that handles attachment parsing, MIME detection, file size guards, `/compact`, slash-command routing, model splitting, and prompt fire-and-forget — each branch a separate async path. Hard to unit-test any one path.
   *Approach*: Extract `parseAttachments(content): { textContent, parts }`, `routeCommand(text): boolean`, `sendCompact(): void`, `sendPromptParts(parts, body): void`. `sendMessage` becomes a ~30-line dispatcher.
   *Effort*: Medium

6. **Introduce `ServerBootstrap` to simplify `ws-server.ts`**
   *Location*: `server/ws-server.ts` (41 imports, mixed startup side-effects and route wiring)
   *Problem*: Session restore, hook sync, monitor start, and commit-hook setup all happen inline during module evaluation. Any startup failure is hard to isolate; imports are difficult to mock in tests.
   *Approach*: `ServerBootstrap.run(app, sessions)` handles ordered startup steps with explicit error handling. Route registration moves to `createApiRouter(deps)`. `ws-server.ts` drops to ~100 lines of glue.
   *Effort*: Large

7. **Extract `useAppCore` composite hook from `App.tsx`**
   *Location*: `src/App.tsx:51–828`
   *Problem*: The root component function manages 30+ state variables and 15+ hooks in one block, making it the de-facto application controller. Any performance regression (e.g. extra renders) requires reading the whole component.
   *Approach*: Extract `useAppCore` (session state + WebSocket + routing), `useUiPanels` (sidebar, diff, palette open/close), and `useModelSync` (provider/model validation hooks). `App` becomes a ~150-line compositor.
   *Effort*: Medium

8. **Make `OpenCodeServerManager` injectable**
   *Location*: `server/opencode-process.ts:122–351` (module-level `serverState` singleton)
   *Problem*: All `OpenCodeProcess` instances share one hidden global; tests cannot run two instances in isolation. The port is randomly chosen at startup so tests can't deterministically mock the port.
   *Approach*: Expose `OpenCodeServerManager` class with `ensureServer()`, `baseUrl()`, and `stop()`. Pass an instance to `OpenCodeProcess` via constructor injection (with a default that uses the module-level singleton for backward compat).
   *Effort*: Medium

9. **Named constants for repeated magic numbers in `opencode-process.ts`**
   *Location*: `server/opencode-process.ts`, scattered: `2000` (tool output truncation), `200` (summary cap), `80`/`120` (reasoning summary length), `10 * 1024 * 1024` (attachment limit)
   *Problem*: The same threshold appears in 2–4 places each with different adjacent comments. Changing the limit requires a search-and-replace.
   *Approach*: Declare `const TOOL_OUTPUT_TRUNCATION = 2000`, `const REASONING_SUMMARY_MAX_CHARS = 80`, `const MAX_ATTACHMENT_BYTES` (already named — just use it consistently). Group at the top of the file alongside existing `TURN_WATCHDOG_INTERVAL_MS`.
   *Effort*: Small

10. **Decouple `buildSessionContext` from `SessionManager`**
    *Location*: `server/session-manager.ts:1524–1584`
    *Problem*: Context building iterates `outputHistory` with a multi-case switch and an accumulation loop — stateful but purely functional. It accesses no `SessionManager` instance state; it could be a standalone pure function accepting `outputHistory` and returning a string.
    *Approach*: Move to `server/session-context.ts` as `buildSessionContext(outputHistory: WsServerMessage[]): string | null`. Eliminates the need for the private method and makes it trivially testable.
    *Effort*: Small