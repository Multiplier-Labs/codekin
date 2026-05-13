# Complexity Report: codekin

**Date**: 2026-05-13T04:32:53.959Z
**Repository**: /srv/repos/codekin
**Branch**: main
**Workflow Run**: cb864dc1-e68b-4e6f-94fd-38186a0edb9d
**Session**: 870980cc-f1b2-4879-917b-898bbeb4f324

---

## Summary

**Overall Complexity Rating: Medium–High**

The codebase is a TypeScript Node.js/React monorepo at roughly 25,600 lines of production server code and 19,000 lines of frontend code (excluding tests). The architecture shows active refactoring: `SessionManager` has been partially decomposed into focused sub-modules, and routers have been extracted from `ws-server.ts`. However, several files remain large and bear mixed concerns.

| Metric | Value |
|--------|-------|
| Largest production file | `server/session-manager.ts` — 1,699 lines |
| Deepest nesting observed | 5 levels (SSE reconnect loop in `opencode-process.ts`) |
| Most complex function | `createWorktree` in `session-manager.ts` (~125 lines, 4–5 nesting levels) |
| Total production source files | ~85 (server + frontend, excluding tests) |

---

## Largest Files

| File | Lines | Primary Responsibility | Refactor Priority |
|------|-------|------------------------|-------------------|
| `server/session-manager.ts` | 1,699 | Session CRUD, worktree ops, context injection, rate-limit circuit breaker, history management | High |
| `server/workflow-engine.ts` | 1,000 | SQLite-backed workflow run tracking, step execution, cron scheduling | Medium |
| `server/opencode-process.ts` | 988 | OpenCode HTTP/SSE client + shared server singleton | Medium |
| `server/workflow-loader.ts` | 711 | MD workflow parsing + 4-step execution pipeline + report commit | High |
| `server/webhook-handler.ts` | 702 | GitHub webhook CI failure and PR review orchestration | Medium |
| `server/orchestrator-learning.ts` | 696 | Memory extraction, deduplication, aging, skill modeling | Low |
| `server/ws-server.ts` | 691 | HTTP server bootstrap + WebSocket server + all middleware wiring | High |
| `server/prompt-router.ts` | 681 | Tool approval routing, control requests, auto-approval logic | Low |
| `server/workflow-routes.ts` | 554 | Workflow HTTP routes + schedule sync | Low |
| `server/orchestrator-children.ts` | 564 | Child session spawning and tracking for orchestrator | Medium |
| `server/session-routes.ts` | 604 | Session REST routes (create/list/delete/rename/approve) | Low |
| `src/App.tsx` | 739 | Root React component, state wiring, layout switching | High |
| `src/components/InputBar.tsx` | 784 | Chat input, slash autocomplete, file attach, permission mode | Medium |
| `src/components/Settings.tsx` | 777 | Settings dialog with auth, preferences, webhook config | Medium |
| `src/components/AddWorkflowModal.tsx` | 645 | Workflow creation/editing modal | Low |

---

## Most Complex Functions

| File:Function | Est. Complexity | Issue Description | Refactor Suggestion |
|---|---|---|---|
| `session-manager.ts:createWorktree` | Very High | ~125 lines, 4–5 nesting levels: git exec sequences, stale-state cleanup, branch existence checks, worktree add, Claude session data migration. Two distinct sub-concerns: workspace preparation and session pointer update. | Extract `prepareWorktreeDirectory(repoRoot, branchName, …)` returning the path, and `migrateSessionToWorktree(session, worktreePath)` as separate private methods. |
| `opencode-process.ts:connectSSE` (inner) | High | Deep nesting: `while (alive)` → async `reader.read()` loop → `for (const line of lines)` → SSE parse try/catch. Error handling is duplicated in both the `.catch` and the success path for reconnect logic. | Extract `parseSSEChunk(buffer, decoder, value)` → lines, and pull reconnect logic into `scheduleReconnect(delay, attempt)` utility. |
| `session-manager.ts:sendInput` | High | Combines process liveness check, race guard, message content selection, context injection, and naming retry in one function. ~80 lines. | Already partially structured but the "determine message to send" block could be `buildMessageWithContext(session, data): string`. |
| `session-manager.ts:reapIdleSessions` | Medium-High | Performs two unrelated operations in one method: stopping idle active processes, and pruning stale dead sessions. Different thresholds, different data sets. | Split into `stopIdleProcesses()` and `pruneStateSessions()`, called sequentially from a single `runIdleReaper()` coordinator. |
| `workflow-loader.ts:buildKindWorkflow` (step handlers) | Medium-High | The `save_report` step handler (~120 lines) mixes git branch detection, file writing, path traversal validation, commit, and push. The `run_prompt` step handler injects commit context, guards re-sends, and awaits the result — very long. | Extract a `GitReportWriter` class (branch detection, write, commit, push) from `save_report`, and a `PromptSender` helper for `run_prompt`. |
| `session-manager.ts:buildSessionContext` | Medium | Switch over all message types, dual-buffer tracking for assistant text, inline truncation logic. Not complex per se but mixing parsing and formatting. | Extract a stateless `historyToContextString(history, maxLen)` pure function; move to its own module `session-context.ts`. |
| `server/ws-server.ts` (module body) | Medium-High | 691-line startup script with 36 imports doing server init, auth, all route mounting, WebSocket upgrade, workflow engine init, and signal handling inline. Not a class — procedural setup code. | The current route decomposition is good; the remaining inline startup logic (>200 lines) could be wrapped in a `startServer()` function to make the module structure explicit and testable. |
| `src/App.tsx:App` (component) | Medium-High | Single 700-line component with ~20 `useState`/`useRef` declarations, ~15 `useCallback`/`useEffect` hooks, and direct JSX for every layout branch. The JSX render method alone spans ~250 lines with deeply nested ternary branches. | The `useChatSocket` call site (props: onSessionCreated, onRawMessage, etc.) could become a `useChatBridge` hook. Mobile/desktop layout branches can be sub-components. |
| `session-manager.ts:handleClaudeResult` | Medium | Orchestrates headless turn cap, API retry, context warning, and result finalization — four distinct operations, each delegated but sequenced inline. | Already well-named; the sequencing is clear. Low refactor value unless retry logic grows. |
| `src/components/InputBar.tsx` (component) | Medium | 784 lines, 26 internal functions/components, multiple exported variant types (`InputBarVariant`, `MobileInputBar`). Three separate layout variants (`default`, `simple`, `mobile`) share handlers through prop drilling to sub-atoms. | Split mobile and desktop variants into separate files (`InputBar.desktop.tsx`, `InputBar.mobile.tsx`) sharing a `useInputBarState` hook. |

---

## Coupling & Cohesion Issues

**1. `ws-server.ts` as god entry-point**
- Imports 36 modules including every router, handler, engine, and config. While routes are extracted, `ws-server.ts` still directly couples all cross-cutting concerns: auth, CORS, WebSocket upgrade, workflow scheduling, orchestrator lifecycle, commit hooks, and update checks.
- *Suggested fix*: Group into three factory functions: `buildHttpApp(sessionManager)`, `attachWebSocketServer(server, sessionManager)`, `initBackgroundServices(sessionManager)`. Call them sequentially from a thin `main()`.

**2. `session-manager.ts` retains worktree concern**
- Despite delegating process start/stop to `SessionLifecycle`, the manager still owns all worktree creation, cleanup, branch detection, and session directory migration (~250 lines). This is unrelated to session state management.
- *Suggested fix*: Extract a `WorktreeManager` class (`server/worktree-manager.ts`) with `create`, `cleanup`, `detectDefaultBranch`, and `migrateSession` methods. `SessionManager` calls it but doesn't own the logic.

**3. `workflow-loader.ts` conflates loading and execution**
- The `WorkflowLoader` class reads workflow definitions from disk *and* builds the 4-step execution pipeline against live `SessionManager` and `WorkflowEngine` references. These two concerns have very different change rates.
- *Suggested fix*: Split into `WorkflowRegistry` (pure loader — parses MD, returns `WorkflowDef[]`) and `WorkflowRunner` (takes registry + deps, executes runs). The current `MdWorkflowLoader` class mixes both.

**4. `App.tsx` accumulates cross-cutting state**
- Root component owns upload state, diff panel callbacks, worktree toggle, queue messages flag, agent name, provider tracking, and all session-related routing. These are passed down as deep prop chains to `LeftSidebar`, `SessionContent`, etc.
- *Suggested fix*: Candidate for a React Context split: `SessionContext` (active session, routing), `UIPreferencesContext` (worktree, provider, model). This removes 8–10 props from major component boundaries.

**5. `opencode-process.ts` module-level singleton**
- The `serverState` singleton (`OpenCodeServerState`) is a plain module-level variable shared across all `OpenCodeProcess` instances. This makes testing difficult and couples the per-session class to global state.
- *Suggested fix*: Extract `OpenCodeServerManager` as an injectable singleton class, passed into `OpenCodeProcess` constructor. Matches the dependency-injection pattern already used elsewhere.

**6. `src/lib/ccApi.ts` as a broad-scope API facade**
- 577 lines, one flat module of exported functions covering authentication, session ops, repo ops, webhook config, integration health, diff, approval, workflow, orchestrator, and agent APIs. All frontend modules import from this one file.
- *Suggested fix*: Namespace by domain: `ccApi/sessions.ts`, `ccApi/workflows.ts`, `ccApi/webhooks.ts`, etc., re-exported from `ccApi/index.ts` for backwards compat.

---

## Refactoring Candidates

**1. Extract `WorktreeManager` from `SessionManager`**
- **Location**: `server/session-manager.ts:442–711` (createWorktree, cleanupWorktree, detectDefaultBranch, migrateClaudeSession, copyDirRecursive)
- **Problem**: ~270 lines of git worktree logic live inside a class whose primary concern is session lifecycle. The worktree creation function alone has 5 nesting levels and 12+ early-exit paths.
- **Approach**: Create `server/worktree-manager.ts` with a `WorktreeManager` class. Inject it into `SessionManager` constructor. Zero logic changes required — only extraction.
- **Effort**: Medium

**2. Split `workflow-loader.ts` into Registry + Runner**
- **Location**: `server/workflow-loader.ts` (711 lines)
- **Problem**: `MdWorkflowLoader` reads definitions from disk, validates paths, and also directly constructs the 4-step async execution pipeline that holds live references to `SessionManager` and `WorkflowEngine`. A change in the execution model requires understanding the parsing code, and vice versa.
- **Approach**: `WorkflowRegistry` owns `parseMdFile`, `loadBuiltins`, `loadRepoWorkflows`, `list`. `WorkflowRunner` owns `buildKindWorkflow` and the step handlers. `WorkflowLoader` becomes a thin facade.
- **Effort**: Medium

**3. Consolidate `App.tsx` cross-cutting state into contexts**
- **Location**: `src/App.tsx` (~200 lines of state declarations)
- **Problem**: Root component owns ~20 state variables crossing layout, session, provider, upload, diff panel, and UI preference concerns. Every sub-component receives long prop lists.
- **Approach**: Introduce `SessionContext` (active session id, navigate, socket actions) and `UIStateContext` (worktree toggle, provider, upload status). Components consume via `useContext` hooks.
- **Effort**: Large

**4. Extract `WorkflowStepHandlers` from `workflow-loader.ts`**
- **Location**: `server/workflow-loader.ts:buildKindWorkflow` (the `save_report` and `run_prompt` step handlers)
- **Problem**: The `save_report` step handler does git branch detection, canonical path resolution, file writing, commit, and push — all inline. Any failure mode is hard to test without a real git repo.
- **Approach**: Extract a `ReportCommitter` class (`server/report-committer.ts`) with `writeAndCommit(repoPath, outputPath, content, message)`. This class already has a natural test seam (can mock `execFileSync`).
- **Effort**: Small

**5. Extract `buildSessionContext` to a pure utility module**
- **Location**: `server/session-manager.ts:1434–1494`
- **Problem**: The function reconstructs a conversation summary from raw `WsServerMessage` history. It is stateless (reads `session.outputHistory`, does not mutate). Keeping it inside `SessionManager` hides a natural seam for unit testing and reuse.
- **Approach**: Move to `server/session-context.ts` as `export function buildSessionContext(history: WsServerMessage[], maxLen?: number): string | null`. Add focused unit tests.
- **Effort**: Small

**6. Decompose `InputBar.tsx` into mobile and desktop variants**
- **Location**: `src/components/InputBar.tsx` (784 lines, 3 exported component variants + 8 shared atoms)
- **Problem**: Mobile and desktop input bar variants share internal state hooks but have divergent JSX trees. The file size makes it hard to navigate and the shared sub-atoms (`AttachButton`, `SendButton`, `PermissionModeDropdown`) are defined only for internal use but add visual noise.
- **Approach**: Move shared atoms to `InputBarAtoms.tsx`. Create `InputBar.desktop.tsx` and `InputBar.mobile.tsx`. Re-export public API from `InputBar.tsx` (keeping import paths stable).
- **Effort**: Small

**7. Introduce `OpenCodeServerManager` injectable singleton**
- **Location**: `server/opencode-process.ts:63–270` (module-level `serverState`, `ensureOpenCodeServer`, `stopOpenCodeServer`)
- **Problem**: `serverState` is a bare module-level variable. This makes the `OpenCodeProcess` class impossible to test in isolation and causes implicit global side effects on module import.
- **Approach**: Wrap in `OpenCodeServerManager` class with `ensureServer()`, `stop()`, and a `getPort()`/`getPassword()` accessor. Pass an instance into `OpenCodeProcess` via constructor injection. Default-export a singleton for production use.
- **Effort**: Small

**8. Decompose `ws-server.ts` startup into factory functions**
- **Location**: `server/ws-server.ts:55–691` (procedural startup body)
- **Problem**: The file is not a module exporting a service — it is a 691-line imperative script. `startServer()` does not exist; everything runs at import time. This makes integration testing and programmatic startup impossible.
- **Approach**: Wrap the startup sequence into `export async function startServer(options): Promise<{ app, server, wss }>`. The `if (import.meta.url === …)` guard calls it. No behavior changes.
- **Effort**: Small

**9. Namespace `ccApi.ts` by domain**
- **Location**: `src/lib/ccApi.ts` (577 lines, single flat export namespace)
- **Problem**: All API callers import from one file. A change to one domain (e.g., webhook config) forces a re-parse of the entire 577-line file by the TypeScript compiler and bundler. Discovery of available functions requires reading the whole file.
- **Approach**: `src/lib/ccApi/sessions.ts`, `ccApi/workflows.ts`, `ccApi/webhooks.ts`, `ccApi/repos.ts`, `ccApi/orchestrator.ts`, re-exported via `ccApi/index.ts`. No external API changes.
- **Effort**: Small

**10. Extract `reapIdleSessions` dual concerns**
- **Location**: `server/session-manager.ts:224–274`
- **Problem**: `reapIdleSessions` performs two unrelated operations: stopping processes of idle-but-alive sessions, and pruning completely dead sessions older than a threshold. The two loops use different predicates and different log tags but share a function, making each concern harder to test or disable independently.
- **Approach**: `private stopIdleProcesses(): void` and `private pruneStaleSessionRecords(): void`, called from a single `private runIdleReaper(): void`. Enables threshold-specific unit tests.
- **Effort**: Small