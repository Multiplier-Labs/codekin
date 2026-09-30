# Complexity Report: codekin

**Date**: 2026-09-30T04:33:14.854Z
**Repository**: /srv/repos/Multiplier-Labs/codekin
**Branch**: fix/settings-standalone-view
**Workflow Run**: ea95a454-6d41-45a3-b367-5ac57e7552e4
**Session**: c344954c-3d99-4028-9924-562a88a4e7c0

---

Now I have enough data to produce the report.

## Summary

**Overall complexity rating: High**

The Codekin codebase is a feature-rich, production-grade system (~123K lines across 467 source files) with a Node.js WebSocket server, a React frontend, and a sophisticated agentic-loop orchestration engine. Complexity is heavily concentrated in a handful of server-side files. The architecture shows deliberate layering (SessionManager delegates to focused sub-managers, LoopEngine injects its dependencies), but three files still carry exceptional cyclomatic complexity, and the central entry point (`ws-server.ts`) is a god-module that wires together 54 imports.

Key metrics:
- **Largest file**: `loop-engine.ts` — 2,360 lines
- **Deepest nesting**: `onMakerResult` / `runOneWorker` in `loop-engine.ts` — 5–6 logical levels (async try/catch with nested if-chains and inner async closures)
- **Most complex function**: `onMakerResult` in `loop-engine.ts` — 7 sequential guard clauses plus async side-effects, ~100 lines

---

## Largest Files

| File | Lines | Primary Responsibility | Refactor Priority |
|------|-------|----------------------|-------------------|
| `server/loop-engine.ts` | 2,360 | Durable agentic-loop state machine | **High** |
| `server/opencode-process.ts` | 1,875 | OpenCode HTTP/SSE adapter + streaming | **High** |
| `server/session-manager.ts` | 1,836 | Session CRUD, persistence, broadcast | Medium |
| `server/workflow-engine.ts` | 1,455 | SQLite-backed workflow + cron engine | Medium |
| `server/loop-store.ts` | 1,007 | Event-sourced loop run persistence | Low |
| `src/App.tsx` | 984 | Root React orchestrator component | **High** |
| `server/ws-server.ts` | 942 | Express/WS server entry point | Medium |
| `src/components/InputBar.tsx` | 934 | Chat input bar with multi-variant toolbar | Medium |
| `server/claude-process.ts` | 918 | Claude CLI stdin/stdout process adapter | Low |
| `server/codex-process.ts` | 906 | Codex CLI process adapter | Low |
| `server/loop-recipe.ts` | 744 | Loop recipe schema + provider resolution | Low |
| `server/workflow-loader.ts` | 744 | Markdown workflow file parsing + loading | Low |
| `server/orchestrator-children.ts` | 843 | Orchestrator child-session lifecycle | Medium |
| `server/webhook-handler.ts` | 769 | GitHub webhook event processing | Low |
| `server/orchestrator-manager.ts` | 675 | Orchestrator session bootstrap + routing | Low |

---

## Most Complex Functions

| File:Function | Estimated Complexity | Issue Description | Refactor Suggestion |
|---------------|---------------------|-------------------|---------------------|
| `server/loop-engine.ts:onMakerResult` | Very High (CC ~18) | 7 sequential guard-clause branches plus async side-effects in a ~100-line method called on every agent turn; nesting reaches 5 levels inside the protected-path check | Extract each concern (budget, protected-paths, phase routing) into dedicated private methods and call them in sequence |
| `server/loop-engine.ts:resolveIntervention` | High (CC ~15) | Large `switch` with 8+ cases, each with sub-conditionals and async calls; a `startsWith` comparison for human-evaluation short-circuits before the switch | Move each `case` to a `resolveX(ctx, run, choice, note)` method, called via a dispatch table |
| `server/loop-engine.ts:evaluate` | High (CC ~14) | Iterates evaluators with a type-discriminated `if-else if` chain (5 branches) plus short-circuit logic, then diverges into rubric vs. human evaluation paths | Replace the inline type-dispatch with a `runEvaluator(config, ctx)` strategy map; move the rubric/human fork to `afterDeterministicEval` |
| `server/opencode-process.ts:subscribeToEvents` (inner `connectSSE`) | High (CC ~12) | 150-line inner async closure with reconnect logic, port re-resolution, stream iteration, and line-level JSON parsing; nested inside a method that sets up the retry state machine | Extract `connectSSE` to a top-level private method; extract the line-reader/SSE-parse loop to `consumeSSEStream` |
| `server/opencode-process.ts:handleSSEEvent` | Medium-High (CC ~11) | Large `switch` dispatching 10 event types with inline guard checks on `isOwnSession`; several cases contain non-trivial inline logic | Already partially factored — move the remaining inline logic (session-status type coercion, idle detection) to helpers; add a `default` logging helper |
| `server/opencode-process.ts:handlePartDelta` | Medium-High (CC ~10) | Routes deltas by part kind with 3 code paths, a buffering path, and an in-flight dedup guard; also contains the think-tag streaming filter | Split into `routeKnownPartDelta` and `bufferUnknownPartDelta`; isolate the `<think>` filter as `filterThinkTags(delta)` |
| `server/loop-engine.ts:runOneWorker` | Medium-High (CC ~10) | Wraps a worker session lifecycle in a `Promise` constructor with inner async closure and a `finish` callback; 5-level nesting inside scope-checking block | Convert to `async/await` with `Promise.withResolvers()` or a `Deferred`; extract `inspectWorkerOutput(cwd, branch, stream)` |
| `src/App.tsx:(component body)` | Medium-High (CC ~9) | 984-line root component body acts as an integration seam for ~18 hooks, 6 sub-views, and ~20 callbacks; mixes state, navigation, and render logic | Extract `useAppSession`, `useAppNavigation`, and `useAppMessaging` custom hooks to reduce the component body to ~200 lines of layout |
| `server/workflow-engine.ts:WorkflowEngine` | Medium (CC ~8) | 1,455-line class combines schema migration, run execution, step scheduling, cron-tick logic, and event emission; schema migration is inline in the constructor | Move schema migrations to a `migrateDb(db)` helper; extract cron scheduler to `CronScheduler`; the run-execution core shrinks to ~400 lines |
| `server/session-manager.ts:leave` | Medium (CC ~8) | Grace-period timer with doubly-nested condition checks (clients empty → source check → pending-prompt iteration for both approval maps); contains inline denial logic | Extract `autoDenyPendingPrompts(session)` and `handleAgentSessionLeave(session)` |

---

## Coupling & Cohesion Issues

1. **`server/ws-server.ts` — 54-import god entrypoint**
   Every subsystem (loop engine, workflow engine, orchestrator, relay, webhook, stepflow, auth, upload, docs, deployment, commit events) is instantiated and wired here. Any change to a subsystem boundary requires touching this file. The pattern of mutating `sessions._serverPort`, `sessions._authToken`, and `sessions._globalBroadcast` after construction leaks wiring detail into the consumer.
   *Suggested fix*: Introduce a `AppContext` bag (or pass config to the `SessionManager` constructor) and move subsystem init into a `createApp(config)` factory; `ws-server.ts` becomes the bootstrap shim only.

2. **`server/session-manager.ts` — 20 direct dependents, no interface**
   `SessionManager` is imported by 20 non-test server modules as a concrete type. Changes to its internal structure propagate broadly. The `SessionHost` interface already exists in `loop-engine.ts` as a narrower projection; other consumers could be similarly narrowed.
   *Suggested fix*: Extract a `ISessionManager` interface covering the public API surface and have each consumer depend on the interface, not the class.

3. **`server/opencode-process.ts` — dual responsibility: HTTP client + event translator**
   The class manages the shared OpenCode server lifecycle (`ensureOpenCodeServer`, `startOpenCodeServer`), its own session, SSE subscription, and the full mapping from OpenCode events to `CodingProcess` events. The shared server state is module-level (not on the class), creating an implicit singleton with shared mutable state.
   *Suggested fix*: Move the shared server management into `OpenCodeServerManager` (singleton, tested separately); `OpenCodeProcess` only creates/subscribes to one session.

4. **`src/App.tsx` — 18-hook root component as integration seam**
   The root component directly calls 18 hooks, constructs callbacks for every user action, and conditionally renders 6 distinct content views. It is the only integration point for WebSocket state, routing, settings, provider management, diff panel, and command palette — preventing independent testing of any of those concerns.
   *Suggested fix*: Extract `SessionContext` (active session, message history, send functions) and `AppLayout` (sidebar + content area switching); `App.tsx` becomes a thin provider tree.

5. **`server/loop-engine.ts` + `server/loop-store.ts` — behavioral coupling through raw SQL row shapes**
   `LoopEngine` calls `store.patchRun`, `store.appendEvent`, `store.createStage`, `store.completeStage` etc. at 30+ call sites, interleaving store mutations with orchestration logic. The store's row shapes leak into engine conditionals (e.g. `store.listArtifacts(runId).filter(a => a.kind === 'plan').at(-1)`).
   *Suggested fix*: Add higher-level store methods (`store.latestPlanArtifact(runId)`, `store.recordEvaluationPassed(...)`) and let the engine call domain-named operations rather than raw CRUD.

6. **`server/ws-server.ts` WS message loop — duplicates session lookup with `session-routes.ts`**
   Both `ws-message-handler.ts` and the various `*-routes.ts` files repeat the auth → lookup → act pattern. Rate limiting, auth extraction, and session-not-found handling are re-implemented inline in each place.
   *Suggested fix*: Create `withSession(sessionId, req, handler)` and `wsWithSession(msg, sessions, handler)` wrappers that centralize auth, lookup, and not-found responses.

---

## Refactoring Candidates

1. **Extract `LoopEngine.onMakerResult` into a pipeline of guard methods**
   - **Location**: `server/loop-engine.ts:376–470`
   - **Problem**: The 95-line method is called on every agent-turn completion. It tests 7 sequential conditions (cancel, pause, error, budget, planning phase, protected-path violations, no-change), each with side-effects; a mistake in ordering silently changes behavior.
   - **Approach**: Model each guard as a `checkXxx(ctx, run): boolean` predicate returning `true` to halt and `false` to pass through; compose them in `onMakerResult` as an explicit ordered chain.
   - **Effort**: Small

2. **Split `server/opencode-process.ts` into server-manager + session-process + event-mapper**
   - **Location**: `server/opencode-process.ts` (entire file)
   - **Problem**: The 1,875-line file manages three distinct concerns: the shared OpenCode process lifecycle, this session's HTTP interactions, and the mapping from OpenCode's SSE schema to the `CodingProcess` event model. The streaming think-tag filter (`thinkActive`/`thinkCarry`) and part-kind classification (`partKinds`/`partDeltaBuffers`) are significant independent state machines buried inside a larger class.
   - **Approach**: (a) Move server lifecycle into `OpenCodeServerManager`; (b) extract the SSE event mapper into `OpenCodeEventMapper` (pure, easily unit-tested); (c) keep `OpenCodeProcess` as a thin coordinator.
   - **Effort**: Large

3. **Decompose `src/App.tsx` into context providers and a layout component**
   - **Location**: `src/App.tsx` (entire file)
   - **Problem**: The 984-line root component is the only place where session, routing, settings, and messaging state coexist. Any change to the active session flow or a routing rule requires navigating a 900+ line file with 18 hook call-sites.
   - **Approach**: Create `SessionContextProvider` (active session id, messages, send, join/leave), `SettingsContextProvider` (settings, provider, model), and `AppLayout` (sidebar + view switching). `App.tsx` becomes a ~150-line tree of providers + `<AppLayout />`.
   - **Effort**: Large

4. **Introduce a `WorkflowEngine` schema-migration module**
   - **Location**: `server/workflow-engine.ts:1–150` (constructor block)
   - **Problem**: The `WorkflowEngine` constructor contains all SQLite `CREATE TABLE` and `ALTER TABLE` migration statements inline. Adding a new column requires navigating a large constructor body and risks accidentally breaking the existing schema.
   - **Approach**: Extract `applyMigrations(db: Database)` into `workflow-db-migrations.ts`, following the pattern already used in `run-db.ts`. The constructor becomes a single function call.
   - **Effort**: Small

5. **Add domain-named query methods to `LoopStore`**
   - **Location**: `server/loop-store.ts` (public API surface)
   - **Problem**: `LoopEngine` reconstructs common queries at 30+ sites: `store.listArtifacts(id).filter(a => a.kind === 'plan').at(-1)`, `store.listEvents(id).filter(e => e.type === 'review_verdict')`, etc. These are copy-pasted, fragile to refactor, and hide the semantics.
   - **Approach**: Add `store.latestPlanArtifact(runId)`, `store.reviewVerdicts(runId)`, `store.pendingIntervention(runId)` etc.; tests for the store cover the query logic directly.
   - **Effort**: Small

6. **Extract `ws-server.ts` startup wiring into an `AppFactory`**
   - **Location**: `server/ws-server.ts:150–450`
   - **Problem**: The top-level script mixes initialization, service wiring, and route registration. It patches `sessions._serverPort`, `sessions._authToken`, and `sessions._globalBroadcast` after construction — post-construction mutation of private fields via underscore-prefixed backdoors.
   - **Approach**: Move service construction and wiring into `createApp(config): { app, sessions, ... }`; `ws-server.ts` becomes `const { app } = createApp(loadConfig()); app.listen(port)`.
   - **Effort**: Medium

7. **Resolve the `SessionManager` concrete-type coupling**
   - **Location**: All 20 non-test server files that import `SessionManager` directly
   - **Problem**: No interface exists; consumers cannot be tested with a mock or stub, which is why the `session-manager.test.ts` test file is 4,007 lines (the largest in the codebase — it integration-tests everything together).
   - **Approach**: Extract `ISessionManager` interface from the class's public methods; gradually migrate consumers to the interface. High-value first targets: `orchestrator-children.ts`, `webhook-handler.ts`, `workflow-loader.ts`.
   - **Effort**: Medium

8. **Consolidate duplicated process-adapter boilerplate (`claude-process.ts`, `codex-process.ts`, `opencode-process.ts`)**
   - **Location**: `server/claude-process.ts`, `server/codex-process.ts`, `server/opencode-process.ts`
   - **Problem**: All three implement `CodingProcess` but re-implement permission-mode mapping, session-init timeout patterns, and startup/stop lifecycle independently. `codex-process.ts` (906 lines) was modelled on `claude-process.ts` (918 lines) and shares ~30% structural similarity.
   - **Approach**: Extract a `BaseProcessAdapter` abstract class covering startup timeouts, alive-flag management, and event plumbing; concrete adapters override `initialize()` and `sendMessage()` only.
   - **Effort**: Large