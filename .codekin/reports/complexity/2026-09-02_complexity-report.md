# Complexity Report: codekin

**Date**: 2026-09-02T04:39:16.170Z
**Repository**: /srv/repos/Multiplier-Labs/codekin
**Branch**: feat/deployments-ui
**Workflow Run**: a5cf05bc-eb44-472e-a627-72ba5d29629b
**Session**: 1e18775f-391f-4a2d-ad63-7a422232ae04

---

Now I have enough data to write the comprehensive report.

## Summary

**Overall complexity rating: High**

The codebase is a mature, feature-rich terminal UI with a WebSocket backend — approximately 56 k source lines across 400 files (excluding tests). Growth has been well-structured (clear module boundaries, a `CodingProcess` interface abstracted over three backends), but several files have grown into complexity hotspots that warrant targeted refactoring.

Key metrics:
- **Largest file (non-test):** `server/opencode-process.ts` — 1,838 lines
- **Deepest nesting:** `handleSSEEvent` in `opencode-process.ts` — 4-5 levels inside a 305-line switch dispatcher
- **Most complex function:** `handleSSEEvent` (~305 lines, ~6 branching paths per case, part-classification state machine spread across 12 private fields)
- **Largest component:** `src/App.tsx` — 956 lines, 14 hooks, 21 callbacks, god-component role

---

## Largest Files

| File | Lines | Primary Responsibility | Refactor Priority |
|---|---|---|---|
| `server/opencode-process.ts` | 1,838 | OpenCode SSE adapter — streaming, think-tag stripping, part classification, permissions, reconnect | **High** |
| `server/session-manager.ts` | 1,836 | Session CRUD, process lifecycle, context injection, retry, idle reaping, worktree management | **High** |
| `server/workflow-engine.ts` | 1,450 | SQLite-backed workflow runner — run/step lifecycle, cron scheduler, signal processing, activity gates | Medium |
| `src/components/Settings.tsx` | 1,073 | Single modal with 7+ conceptually distinct settings sections | Medium |
| `src/App.tsx` | 956 | Root component — routing, all session state, model/provider sync, command dispatch | **High** |
| `src/components/InputBar.tsx` | 934 | Composer UI — slash commands, permission mode picker, provider switcher, file attachments | Medium |
| `server/claude-process.ts` | 918 | Claude CLI child-process adapter — stream parsing, tool/think blocks, task tracking | Low |
| `server/codex-process.ts` | 906 | Codex JSON-RPC adapter — turn/item/notification dispatch, reasoning, tool events | Low |
| `server/ws-server.ts` | 885 | Express app bootstrap, WebSocket server, auth, rate limiting, incident response, graceful shutdown | Medium |
| `server/orchestrator-children.ts` | 843 | Spawn/monitor child agent sessions — pausable timeout clocks, nudge, blocked detection | Medium |
| `server/prompt-router.ts` | 771 | Tool-approval routing, plan-mode gating, AskUserQuestion answers, allowlist enforcement | Low |
| `server/workflow-loader.ts` | 744 | Workflow registration — 350-line `registerWorkflow` function containing all step handlers inline | **High** |
| `server/webhook-handler.ts` | 711 | GitHub PR/workflow-run event routing, dedup, actor allowlist, session lifecycle | Medium |
| `server/orchestrator-learning.ts` | 696 | Outcome memory, skill model, guidance-style adaptation, decision tracking | Low |
| `server/goal-run-controller.ts` | 696 | Maker/verifier/checker loop, readonly enforcement, budget management | Medium |

---

## Most Complex Functions

| Location | Estimated Complexity | Issue | Refactor Suggestion |
|---|---|---|---|
| `server/opencode-process.ts:985` `handleSSEEvent` | Very High — 305 lines, 9 top-level cases, each with 3-6 nested branches; 12 stateful fields it reads/writes | Single switch dispatches streaming text, reasoning, tool events, permission requests, child-session events, session completion, and error handling — a mini event bus | Extract each `case` into its own private method (`handleDeltaEvent`, `handlePartUpdated`, `handleSessionCompleted`, etc.); promote the 12 scattered state fields into a `TurnState` object |
| `server/session-manager.ts:1219` `finalizeResult` + `sendInput` (combined turn lifecycle) | High — `sendInput` is 90 lines with 3 sequential phases and 4 branching paths; `finalizeResult` further chains into naming/broadcasting | The two functions together form the full message-send turn lifecycle but are split across the file with unrelated methods between them | Introduce a `TurnCoordinator` (partially done via `ProcessCoordinator`) and move these into it; `sendInput` especially should delegate context-injection logic to a dedicated `ContextInjector` |
| `server/opencode-process.ts:613` `subscribeToEvents` | High — 112 lines; closure-heavy reconnect loop with nested `connectSSE → fetch → then → reader → drain` chain | 5 levels of nesting inside a closure that closes over mutable `reconnectAttempts`, `reconnectDelay`, and `firstConnect` | Extract into an `SseReconnector` class with explicit state fields; move the drain loop to a separate `drainSseBody` method |
| `server/workflow-loader.ts:288` `registerWorkflow` | High — 350 lines; 6 step-handler lambdas each containing substantial logic (git probes, session creation, prompt composition, PR detection) | Entire workflow implementation is inline; impossible to test steps in isolation | Extract each step handler into a top-level named function (`validateRepoStep`, `createSessionStep`, `runWorkflowStep`, etc.) |
| `server/orchestrator-children.ts:600` `monitorChild` | High — 182 lines; two nested async promise constructors, pause/resume clock, 3 event subscriptions, nudge logic | Mix of timeout-clock management, event routing, and ground-truth verification inside one function | Split the pausable-clock logic into a `PausableClock` helper class; extract the result/exit hook bodies into `onChildResult` and `onChildExit` methods |
| `server/session-manager.ts:227` `reapIdleSessions` | Medium — iterates all sessions with a 7-branch decision tree per session (headless staleness, user-stop flag, client count, process liveness, idle threshold) | Readability suffers from combined purge and reap decisions in one pass | Extract the per-session decision into `shouldReapSession(session): 'stop' \| 'archive' \| 'purge' \| 'keep'` |
| `server/session-routes.ts:538` `hook-decision` handler | Medium — 55 lines inside a single route handler; AskUserQuestion JSON/string parsing with try/catch, always-allow permission mapping | Business logic is inline in the route handler; untestable without a full HTTP stack | Extract into `resolveHookDecision(toolName, toolInput, result)` in a separate file |
| `server/workflow-engine.ts:1152` `evaluateAndDispatch` | Medium — 75 lines; 6 guard clauses (catch-up, activity tier, concurrency, SHA gate) each returning early | Logic is correct but each gate is equally weighted in the source; no indication of which are "fast" vs "slow" gates | Extract gates into named predicates (`isCatchUpMissed`, `isRepoDormant`, `isConcurrentRunActive`, `isUnchangedSince`) and call them from a single dispatcher |
| `src/App.tsx` (entire component) | High — 956 lines; 38 imports, 14 hooks, 21 callbacks, view-switch logic in JSX | God component responsible for routing, model/provider sync, session state, file upload, command dispatch, and layout | Decompose into `useSessionController`, `useProviderSync`, `useChatCommands`, and extract view rendering into a `MainContent` component |
| `src/components/Settings.tsx:144` `Settings` | Medium — 16 prop inputs; 7 logical sections (token, retention, approval, permissions, agent, worktree, hosted) all in one component | Unmaintainable as a monolith; adding a new settings section requires modifying this file | Split into `<TokenSection>`, `<PermissionsSection>`, `<StorageSection>`, `<AgentSection>`, each self-contained, composed by `Settings` |

---

## Coupling & Cohesion Issues

**1. `ws-server.ts` as application bootstrap god-module**
Owns 49 imports, CLI arg parsing, auth helper functions, startup health probes, Express app creation, rate limiters, WebSocket server, incident auto-diagnosis, graceful shutdown, AND the orchestrator auto-start sequence. Any change to startup behavior requires editing this file. Suggested fix: extract a `createApp(config)` factory (Express setup + route wiring), a `runServer(app, config)` entry point (listen + shutdown), and move the incident/orchestrator startup to a `startDependentServices` function.

**2. `session-routes.ts` — 29 routes and settings management in one router**
Routes cover session CRUD, model discovery, 9 settings endpoints, directory browsing, approval management, and hook callbacks. Each domain should have its own router file. Suggested fix: extract `settings-routes.ts` (retention, repos-path, worktree-prefix, queue-messages, agent-name), `approval-routes.ts`, and `hook-routes.ts`.

**3. Duplicated type definitions across `src/types.ts` and `server/types.ts`**
`WsServerMessage`, `WsClientMessage`, and `TaskItem` are defined identically in both files. If one is updated, the other must be updated manually. Suggested fix: move shared wire types to a `shared/types.ts` (or a `protocol.ts`) importable by both sides; server-only types (those with `WebSocket`, `PlanManager`, etc.) stay in `server/types.ts`.

**4. `OpenCodeProcess` class — 30+ private fields, zero sub-objects**
The class accumulates 30+ private fields covering turn state, think-tag carry buffers, part classification inflight sets, reconnect counters, and turn watchdog timers — all at the same level. This makes it hard to reason about which fields belong to which subsystem. Suggested fix: group related fields into named sub-objects (`this.turn: TurnState`, `this.sse: SseState`, `this.thinkTag: ThinkTagState`) — no external API change required.

**5. `registerWorkflow` in `workflow-loader.ts` — step handlers inline**
The 350-line function defines all workflow steps as inline lambda closures, making them impossible to unit-test without registering a full `WorkflowEngine`. Any new step type requires modifying this single function. Suggested fix: define step handlers as top-level named async functions, pass `{ engine, sessions, def }` as explicit arguments.

**6. Repeated auth boilerplate across all route handlers**
Every route in `session-routes.ts` (and others) repeats the `extractToken → verifyToken → 401` pattern 29 times. Suggested fix: implement an `authMiddleware` (already partially done via `auth()` in `workflow-routes.ts`); apply it at the router level rather than per-handler.

---

## Refactoring Candidates

**1. Extract `TurnState` object from `OpenCodeProcess`**
- **Location:** `server/opencode-process.ts`, lines 389–475
- **Problem:** 30+ private fields at the same class level span 3 distinct subsystems (SSE reconnect state, streaming turn state, think-tag stripping state). Each change risks accidentally touching unrelated state.
- **Approach:** Introduce `private turn: TurnState` (delta buffers, partKinds, watchdog timer, inReasoningPhase), `private sse: SseState` (abortController, reconnectAttempts, firstConnect), and `private thinkTag: ThinkTagState` (active, carry, emittedReasoningSummary). Reset each as a whole-object assignment at turn boundaries.
- **Effort:** Medium

**2. Split `handleSSEEvent` into per-case methods**
- **Location:** `server/opencode-process.ts:985`
- **Problem:** A 305-line switch statement is the hardest function to test in isolation; adding a new SSE event type means appending to an already-large body.
- **Approach:** Extract each `case` into `private handleDeltaEvent(props)`, `private handlePartUpdated(part)`, `private handleSessionCompleted(props)`, `private handlePermissionRequest(props)`, etc. The switch becomes a thin dispatch table.
- **Effort:** Medium

**3. Decompose `src/App.tsx` into controller hooks + view component**
- **Location:** `src/App.tsx`, entire file
- **Problem:** 956 lines, 38 imports, 21 callbacks — additions to any session or UI feature require editing this file. Bugs in provider sync can break the session list and vice versa.
- **Approach:** Extract `useSessionController` (session CRUD, active session state, leaveSession), `useProviderSync` (model, provider, disable flags), `useChatCommands` (handleBuiltinCommand, handleSend), and a `MainContent` rendering component. `App.tsx` becomes an orchestrator of ~100 lines.
- **Effort:** Large

**4. Extract step handlers from `registerWorkflow`**
- **Location:** `server/workflow-loader.ts:288`
- **Problem:** 350-line monolithic function makes step logic untestable and conflates registration with implementation. Any bug in step 3 ("run workflow") requires reading the entire function to understand context.
- **Approach:** Define `validateRepoStep`, `createSessionStep`, `runWorkflowStep`, `collectResultStep`, and `createPrStep` as named async functions that receive `(input, ctx, def, sessions)`. `registerWorkflow` becomes a 20-line function that assembles them.
- **Effort:** Medium

**5. Deduplicate `WsServerMessage` / `WsClientMessage` / `TaskItem` into a shared protocol module**
- **Location:** `src/types.ts` vs `server/types.ts`
- **Problem:** Three types are defined identically in both files. A field added to `WsServerMessage` on the server must be manually mirrored to the client — a source of drift already visible in `activeForm?` comment difference in `TaskItem`.
- **Approach:** Create `shared/protocol.ts` (or `src/protocol.ts` imported by the server as `../src/protocol.js`). Both `src/types.ts` and `server/types.ts` re-export from it.
- **Effort:** Small

**6. Extract per-route auth middleware in `session-routes.ts`**
- **Location:** `server/session-routes.ts`, all 29 route handlers
- **Problem:** The token-verify + 401 pattern is repeated 29 times. A future auth model change (e.g., adding a scope to the token) requires 29 edits.
- **Approach:** Use the existing pattern from `workflow-routes.ts:220` — a local `auth` middleware applied via `router.use(auth)` or selectively via `router.get('/path', auth, handler)`.
- **Effort:** Small

**7. Introduce `PausableClock` helper for `monitorChild`**
- **Location:** `server/orchestrator-children.ts:600`
- **Problem:** The 182-line `monitorChild` function implements a custom pausable countdown timer using 4 local `let` variables and 3 inner functions — logic that is independently testable but currently buried.
- **Approach:** Extract a `PausableClock` class (constructor takes `durationMs`, exposes `pause()`, `resume()`, `cancel()`). `monitorChild` becomes the event subscription logic only.
- **Effort:** Small

**8. Split `Settings.tsx` into section components**
- **Location:** `src/components/Settings.tsx:144`
- **Problem:** 16-prop component with 7 conceptually independent settings sections; adding a new setting requires reading the entire 1073-line file. The component mixes hosted-only and local-only concerns with no clean separation.
- **Approach:** Create `TokenSection`, `PermissionsSection`, `StorageSection`, `AgentSection`, `WorktreeSection` as standalone components. `Settings.tsx` becomes a layout shell passing slices of its state to each section.
- **Effort:** Medium

**9. Move `ws-server.ts` startup bootstrapping into a `createApp` factory**
- **Location:** `server/ws-server.ts`, lines 1–580
- **Problem:** The entire startup sequence, service initialization, and route wiring lives in module-level code. This makes the file untestable as a module and means that any integration test must spin up the full server.
- **Approach:** Export a `createApp(config: AppConfig): { app, server, wss }` function. The top-level module just calls it and calls `server.listen`. Each service (SessionManager, WorkflowEngine, WebhookHandler) is constructed inside `createApp` and injected into routers.
- **Effort:** Large

**10. Consolidate the three process `handleNotification`/`handleStreamEvent` patterns**
- **Location:** `server/claude-process.ts:442`, `server/opencode-process.ts:985`, `server/codex-process.ts:534`
- **Problem:** All three process implementations emit `tool_active`, `tool_done`, `text`, `thinking`, `result`, and `rate_limit` events but each implements its own dispatch logic. Common patterns (reasoning summary throttle, task-tool side-effects) are copy-evolved rather than shared.
- **Approach:** Extract a `ProcessEventEmitter` mixin or base class with `emitThinkingSummary(buffer, emitted)`, `emitToolActive(name, input)`, `emitToolDone(name, summary)` helpers with shared throttle/dedup logic. Each process class calls the helpers rather than re-implementing the guards.
- **Effort:** Medium