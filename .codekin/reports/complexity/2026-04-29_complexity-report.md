# Complexity Report: codekin

**Date**: 2026-04-29T04:34:06.059Z
**Repository**: /srv/repos/codekin
**Branch**: docs/audit-reports-2026-04-18
**Workflow Run**: 65bdb84f-b607-4af0-94a4-696f7b0990cb
**Session**: 2b177278-e51d-45d0-bd9d-d0aeafbf2768

---

Now I have enough data to write a comprehensive complexity report.

---

## Summary

**Overall Complexity Rating: Medium-High**

The codebase is a well-structured Node.js/React application that has been actively refactored (session management is split into focused delegate classes), but several files remain large and complex. The largest source of complexity is the dual-process architecture (`ClaudeProcess` + `OpenCodeProcess`), which has evolved significant parallel state and duplicated logic. The frontend's `App.tsx` is a coordination hub that carries excessive coupling load.

**Key metrics:**
- Largest production file: `session-manager.ts` — 1,594 lines
- Deepest nesting: `subscribeToEvents` in `opencode-process.ts` — 4-level nested callbacks (`connectSSE` → `.then` → `async while` loop → `for` loop + handler calls)
- Most complex function: `handleSSEEvent` in `opencode-process.ts` — large outer `switch` with inner `switch` per case, 13 private boolean fields in `OpenCodeProcess` to manage turn state

---

## Largest Files

| File | Lines | Primary Responsibility | Refactor Priority |
|---|---|---|---|
| `server/session-manager.ts` | 1,594 | Session CRUD, Claude lifecycle orchestration, API retry, idle reaping, diff delegation | Medium — already heavily delegated; remaining logic is legitimately core |
| `server/workflow-engine.ts` | 1,000 | SQLite-backed workflow runner, cron scheduler, step execution, resume-on-restart | Low — well-structured, large due to schema + types |
| `server/opencode-process.ts` | 988 | OpenCode REST/SSE adapter implementing CodingProcess interface | **High** — complex streaming state machine with too many booleans |
| `src/components/InputBar.tsx` | 784 | Chat input bar with drag-resize, slash autocomplete, model/permission dropdowns | Medium — four render variants managed inline |
| `src/components/Settings.tsx` | 777 | Settings panel with provider config, webhook, auth, schedule settings | Medium — many independent sections crammed into one component |
| `server/claude-process.ts` | 765 | Claude CLI child process, NDJSON parsing, tool/thinking/task tracking | Low — logically cohesive, complexity is justified by protocol complexity |
| `src/App.tsx` | 739 | Root component wiring all hooks, routing, session orchestration, model selection | **High** — coordination hub with 32+ imports and 15+ pieces of local state |
| `server/webhook-handler.ts` | 702 | GitHub webhook ingestion, CI triage, PR review session spawning | Medium — well split by event type |
| `server/orchestrator-learning.ts` | 696 | Orchestrator memory/skill/decision tracking | Medium — many loosely related utility functions |
| `server/prompt-router.ts` | 681 | Tool approval routing, control request handling, auto-approve logic | Low — logically cohesive |
| `server/ws-server.ts` | 676 | Express + WebSocket server setup, auth, rate limiting, graceful shutdown | Medium — bootstraps everything; hard to split further |
| `src/components/AddWorkflowModal.tsx` | 645 | Workflow creation/edit modal with multi-step form | Medium — form complexity |
| `server/workflow-loader.ts` | 638 | Workflow YAML loading, validation, schedule registration | Low — straightforward |
| `src/components/ChatView.tsx` | 620 | Chat message list rendering | Low — rendering logic, limited branching |
| `server/session-routes.ts` | 601 | HTTP REST routes for session CRUD, model/provider/permission updates | Medium — many routes, inline validation |

---

## Most Complex Functions

| File:Function | Estimated Complexity | Issue Description | Refactor Suggestion |
|---|---|---|---|
| `server/opencode-process.ts:subscribeToEvents` | Very High | 4-level async nesting: `connectSSE()` closure → `fetch().then(async res => ...)` → `while(alive)` read loop → SSE line parsing. Reconnect logic is duplicated three times (non-2xx, EOF, error) within the same closure. | Extract reconnect logic into a `withReconnect(fn, opts)` helper; extract the line-reading loop into a `drainSSEBody(body, handler)` function |
| `server/opencode-process.ts:handleSSEEvent` | High | Outer `switch` on event type; `message.part.updated` case has an inner `switch` on `part.type`; `message.part.delta` case has `if/else if` chains on `field` × `inReasoningPhase`. 13 boolean/buffer fields on the class manage turn state. | Extract per-part-type handlers; encapsulate turn state in a `TurnState` value object reset on `sendMessage` |
| `server/session-manager.ts:createWorktree` | High | ~120 lines; multi-step async git operations with nested try/catch at each step, complex branching for ephemeral vs caller-supplied branches, fallback filesystem cleanup. | Already has good comments; extract `resolveWorktreeArgs` and `cleanupStaleState` as separate private async methods |
| `server/session-manager.ts:sendInput` | Medium-High | Three sequential phases (ensure alive, inject context, determine message) each with distinct branching; async waitForReady path with then-chained send. | Phase-splitting is correct conceptually; add explicit phase comments and extract `buildMessageContent(session, data)` |
| `server/session-manager.ts:buildSessionContext` | Medium | Iterates history with a `switch` that accumulates multi-line state across cases, then second-pass loop to truncate, with a while loop inside it. | Extract message accumulation into a `ConversationSummarizer` helper with clear `flush()` semantics |
| `server/opencode-process.ts:sendMessage` | Medium | Parses `[Attached files: ...]` prefix with regex, classifies files by extension, handles size limits, constructs multi-part array — all inline in one 70-line method. | Extract `buildMessageParts(content, lastUserInput)` returning `Array<Record<string, unknown>>` |
| `server/claude-process.ts:handleControlRequest` | Medium | AskUserQuestion parsing, AUTO_APPROVE_TOOLS fast-path, fallback emit — clean but the questions-parsing block (15+ lines) is isolated enough to extract. | Extract `parseAskUserQuestionEvent(toolInput)` returning the structured questions array |
| `src/App.tsx:(root component)` | High | 15+ `useState` declarations, 10+ `useCallback` wrappers, 15+ `useEffect` hooks, 32 imports. The JSX is 240 lines of conditional rendering. | Extract `useAppOrchestration()` hook for session/navigation wiring; extract `<MainContent>` for the conditional rendering block |
| `server/opencode-process.ts:handleTaskTool` | Medium | Mirrors `ClaudeProcess.handleTaskTool` almost exactly — pure duplication, 50 lines each. | Extract shared `updateTaskState(tasks, taskSeq, toolName, input)` into `task-tracker.ts` |
| `server/workflow-engine.ts:executeRun` | Medium | ~130 lines; resume/normal dual code path for `lastOutput` initialization, `reachedResumePoint` flag, step-level try/catch with `WorkflowSkipped` rethrow, outer catch for `canceled` vs `failed` disambiguation. | The complexity is justified by the resume requirement; consider a `StepExecutor` class to isolate per-step logic |

---

## Coupling & Cohesion Issues

**1. `App.tsx` — God component**
`App.tsx` directly imports 15 hooks, 12 sub-components, and 5 utility/API modules (32 imports total). It holds UI state (sidebar, diff panel, palette, mobile menu), business state (worktree toggle, queue enabled, agent name, session provider), and navigation logic simultaneously. Any change to session creation, navigation, or model selection requires understanding the full component.
*Suggested fix:* Extract `useAppOrchestration()` to own all session/navigation/provider wiring. Extract `<MainContentArea>` for the conditional view rendering. This mirrors how `useSessionOrchestration` was already split out.

**2. `handleTaskTool` duplicated in `ClaudeProcess` and `OpenCodeProcess`**
Both classes contain a ~50-line `handleTaskTool(toolName, input)` method with near-identical logic for `TodoWrite`, `TaskCreate`, and `TaskUpdate`. The duplication is acknowledged in a comment (`Mirrors the task-tracking logic in ClaudeProcess.handleTaskTool()`). Any bug fix or new task tool support must be applied twice.
*Suggested fix:* Create `server/task-tracker.ts` exporting `updateTaskState(tasks: Map<string, TaskItem>, seq: {value: number}, toolName: string, input: Record<string, unknown>): boolean`.

**3. Environment variable filtering duplicated in `ClaudeProcess.start()` and `startOpenCodeServer()`**
Both spawn paths independently build a filtered environment by iterating `process.env`, removing the same `API_KEY_VARS` set and GIT_* vars (except GIT_EDITOR). A new forbidden var added in one place would be missed in the other.
*Suggested fix:* Extract `buildChildEnv(extra?: Record<string, string>): Record<string, string>` into `server/process-env.ts`.

**4. Turn state managed as 13 boolean fields in `OpenCodeProcess`**
`receivedDeltas`, `emittedPartText`, `deltaBuffer`, `deltaBufferFlushed`, `reasoningBuffer`, `emittedReasoningSummary`, `inReasoningPhase`, `turnComplete`, `lastUserInput`, `taskSeq`, and two more are all reset together in `sendMessage()`. When any of these gets out of sync (e.g. `deltaBufferFlushed` not reset on reconnect), bugs are very hard to diagnose.
*Suggested fix:* Encapsulate into a `TurnState` class or interface with a `reset()` method; hold a single `private turn: TurnState` field.

**5. SSE reconnect logic triplicated in `subscribeToEvents`**
The reconnect-on-failure code (increment counter, check max, log warning, `setTimeout(connectSSE, delay)`, `reconnectDelay = Math.min(...)`) appears verbatim three times within the same closure: on non-2xx status, on clean EOF, and on fetch error. Any change to backoff behavior requires editing three branches.
*Suggested fix:* Extract `scheduleReconnect()` local function inside `connectSSE`'s closure, or use a small `Reconnector` helper class.

**6. `session-routes.ts` — mixed abstraction levels**
Session routes mix high-level request handling (parsing body, calling session manager) with low-level validation (checking field types, string length) and business logic (determining whether a session restart is warranted). Some routes are 5 lines, others are 40+ lines.
*Suggested fix:* Extract a `validateSessionPatchBody(body)` function; move restart-decision logic to `session-manager.ts`.

---

## Refactoring Candidates

**1. Extract shared task-tracking utility** (`server/task-tracker.ts`)
- **Location:** `server/claude-process.ts:593` and `server/opencode-process.ts:796`
- **Problem:** ~50 lines of `TodoWrite`/`TaskCreate`/`TaskUpdate` handling duplicated verbatim in two classes. Any task-tool protocol change requires a double fix.
- **Approach:** Extract `updateTaskState(tasks, seqRef, toolName, input)` into a shared module; both classes import and call it.
- **Effort:** Small

**2. Extract child process environment builder** (`server/process-env.ts`)
- **Location:** `server/claude-process.ts:177–189` and `server/opencode-process.ts:111–122`
- **Problem:** API key and GIT var filtering copied verbatim. Will silently diverge when one copy is updated.
- **Approach:** Export `buildChildEnv(extra?: Record<string, string>): Record<string, string>` with a shared `API_KEY_VARS` constant.
- **Effort:** Small

**3. Encapsulate `OpenCodeProcess` turn state** (`TurnState` object)
- **Location:** `server/opencode-process.ts:253–285`
- **Problem:** 13 loosely related fields manage per-turn streaming state. They are reset manually in `sendMessage()`. Partial resets cause subtle display bugs. Hard to test.
- **Approach:** Introduce `interface TurnState { ... }` with a `resetTurn(): TurnState` factory. Replace all 13 fields with `private turn: TurnState`. Call `this.turn = resetTurn()` in `sendMessage()`.
- **Effort:** Small-Medium

**4. Refactor `subscribeToEvents` reconnect logic** (`opencode-process.ts`)
- **Location:** `server/opencode-process.ts:375–458`
- **Problem:** Three copies of the same reconnect/backoff pattern within one closure. A fourth SSE error path in the future would require a fourth copy.
- **Approach:** Extract `scheduleReconnect(reason: string)` as a local function inside `subscribeToEvents`. Each error path calls it with a reason string for logging.
- **Effort:** Small

**5. Extract `App.tsx` session/routing wiring into `useAppOrchestration` hook**
- **Location:** `src/App.tsx:56–390`
- **Problem:** Root component holds URL sync, auto-join, session creation context injection, provider/model wiring, and docs browser coordination. At 739 lines it is harder to trace a single feature through the file.
- **Approach:** Create `src/hooks/useAppOrchestration.ts` returning the derived state and handlers now computed inline in `App.tsx` (everything except rendering and hooks it already delegates to). Reduce `App.tsx` to mounting, rendering, and hook calls.
- **Effort:** Medium

**6. Split `InputBar.tsx` render variants** into a variant strategy
- **Location:** `src/components/InputBar.tsx:578–780`
- **Problem:** Four toolbar rendering variants (`default`, `orchestrator`, `mobile-default`, `mobile-orchestrator`) are implemented as four separate `{!isMobile && !isOrchestrator && (...)}` blocks. The `AttachButton` and `SendButton` atoms are shared, but the container/layout logic is duplicated.
- **Approach:** Extract `<DefaultToolbar>`, `<OrchestratorToolbar>`, `<MobileToolbar>` sub-components defined in the same file. The main `InputBar` selects among them with a single ternary tree.
- **Effort:** Small-Medium

**7. Extract `createWorktree` git orchestration** out of `SessionManager`
- **Location:** `server/session-manager.ts:352–469`
- **Problem:** `SessionManager` directly calls `execFileAsync('git', ...)` with multi-step cleanup sequences. This git orchestration lives in the wrong abstraction layer (session management vs. VCS operations) and is already partially duplicated in `DiffManager`'s `cleanGitEnv`.
- **Approach:** Move worktree creation/deletion into `server/worktree-manager.ts` alongside `DiffManager`. `SessionManager` calls `WorktreeManager.create()` and `WorktreeManager.remove()`.
- **Effort:** Medium

**8. Hoist orchestrator modules into a single `OrchestratorService`**
- **Location:** `server/orchestrator-learning.ts`, `server/orchestrator-manager.ts`, `server/orchestrator-monitor.ts`, `server/orchestrator-children.ts`, `server/orchestrator-memory.ts`, `server/orchestrator-reports.ts` (2,378 lines total)
- **Problem:** Six related modules with no shared abstraction surface. Callers (`ws-server.ts`, route files) import from multiple individual files. The module boundary between `orchestrator-learning`, `orchestrator-memory`, and `orchestrator-reports` is unclear — all three manipulate the same memory structures.
- **Approach:** Define a `OrchestratorService` class in `server/orchestrator-service.ts` that internally aggregates these modules. Expose a single dependency injection point rather than six.
- **Effort:** Large

**9. Replace `localStorage` scatter with a settings service**
- **Location:** `src/App.tsx` (10 accesses), `src/components/InputBar.tsx` (5 accesses), `src/hooks/useChatSocket.ts` (7 accesses), and others
- **Problem:** `localStorage` keys like `codekin-active-session`, `codekin-use-worktree`, `claude-permission-mode`, `codekin-provider`, `opencode-model`, `inputBarHeight`, and `codekin.recentModels` are scattered across components and hooks without a central registry. A key rename must be tracked across multiple files.
- **Approach:** Centralize in `src/lib/localStore.ts` with typed getters/setters for each key. All reads/writes go through the store.
- **Effort:** Medium

**10. Simplify `handleSSEEvent` in `OpenCodeProcess`**
- **Location:** `server/opencode-process.ts:492–768`
- **Problem:** The outer `switch` dispatches on ~10 event types. The `message.part.updated` case contains an inner `switch` with three branches each with additional `if` logic. The `message.part.delta` case has a 4-way branch on `(field, inReasoningPhase, deltaBufferFlushed)`. The function is ~280 lines of dense branching.
- **Approach:** Extract inner handlers `handlePartUpdated(part)`, `handleTextDelta(delta)`, `handleReasoningDelta(delta)` as private methods. The outer switch becomes a dispatch table of one-liner delegations.
- **Effort:** Medium