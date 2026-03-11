# Complexity Report: codekin

**Date**: 2026-03-11T05:32:45.833Z
**Repository**: /srv/repos/codekin
**Branch**: fix/remove-gh-org-readme
**Workflow Run**: d49e49b2-a1cb-4947-9e0c-058af20f2835
**Session**: ace8b0c3-8aa1-4fe3-9309-b599da818000

---

## Summary

Overall complexity rating: **Medium**

The codebase (~18,500 non-test source lines) is a well-structured TypeScript monorepo. Concerns are largely separated into focused modules, but a few files remain overlong. The highest complexity concentrations are `session-manager.ts` (1,266 lines), `App.tsx` (615 lines), and the `useChatSocket` hook (677 lines). Nesting depth is generally shallow; the main complexity indicators are large switch statements, many-branch error/retry flows, and a high degree of callback wiring in the session lifecycle.

---

## Largest Files

| File | Lines | Primary Responsibility | Refactor Priority |
|---|---|---|---|
| `server/session-manager.ts` | 1,266 | Session CRUD, Claude process lifecycle, event wiring, approval routing, auto-restart, API retry | High |
| `src/hooks/useChatSocket.ts` | 677 | WebSocket connection lifecycle, message dispatch, streaming | Medium |
| `server/workflow-engine.ts` | 669 | SQLite-backed workflow runner, cron scheduler, step executor | Low |
| `src/App.tsx` | 615 | Root component, state composition, skill expansion, tentative queue, file upload | High |
| `server/claude-process.ts` | 591 | Claude CLI child process, NDJSON stream parsing, tool/task event emission | Medium |
| `src/components/AddWorkflowModal.tsx` | 557 | Workflow creation form | Medium |
| `server/stepflow-handler.ts` | 506 | Stepflow webhook handler, workspace lifecycle, callback | Low |
| `server/workflow-loader.ts` | 494 | MD workflow parsing, 4-step execution model registration | Low |
| `src/components/ChatView.tsx` | 480 | Chat message renderer | Low |
| `server/ws-server.ts` | 468 | Server entry point, WebSocket auth, startup orchestration | Medium |
| `src/components/LeftSidebar.tsx` | 459 | Sidebar tree, resize logic, module browser | Low |
| `src/components/Settings.tsx` | 438 | Settings modal sections | Low |
| `src/components/ApprovalsPanel.tsx` | 407 | Approvals UI, rule management | Low |
| `server/webhook-handler.ts` | 391 | GitHub webhook handler | Low |
| `src/components/RepoSection.tsx` | 370 | Repo node in sidebar tree | Low |

---

## Most Complex Functions

| File:Function | Estimated Complexity | Issue Description | Refactor Suggestion |
|---|---|---|---|
| `session-manager.ts:handleClaudeResult` | High | Multi-branch result handling: API retry logic with exponential back-off, transient error detection, turn counting, session naming trigger — all in one function (~70 lines, 4+ nesting levels) | Extract `handleApiRetry` and `handleSuccessfulResult` as private methods |
| `useChatSocket.ts:ws.onmessage` | High | 20+ `case` branches in a single inline `switch`, mixing state updates, streaming batching, cross-session tracking, and auth checks | Split into domain-specific handlers (`handleStreamEvent`, `handleSessionEvent`, `handleConnectionEvent`) called from a thin dispatch switch |
| `session-manager.ts:onControlRequestEvent` | High | Routes control requests through auto-approval check, builds prompt message, handles no-client case with global broadcast — 5+ conditionals, references 6+ session fields | Extract into `ControlRequestRouter` helper class or standalone function |
| `claude-process.ts:handleUserEvent` | High | Parses raw content blocks, handles image vs text content, tracks deferred `ExitPlanMode` ID — nested type assertions and conditional branches | Split image extraction and plan-mode deferral into dedicated helpers |
| `App.tsx:handleSendWithFiles` | High | Skill expansion, docs context injection, tentative queue check, conflict detection, file upload — 7+ conditionals, 320-char dependency array | Extract conflict/tentative check and skill expansion into custom hook or utility |
| `workflow-engine.ts:executeRun` | Medium | Step-by-step executor with abort-signal check, nested try/catch per step, `WorkflowSkipped` special case, and status finalization in multiple branches | Already clean but `WorkflowSkipped` catch clause could be factored into `handleRunCompletion(err, run)` |
| `claude-process.ts:handleStreamEvent` | Medium | 3-case switch with deeply nested `if` chains for thinking deltas, partial JSON accumulation, and planning-mode detection | Already partially extracted; split thinking-block delta handling into `handleThinkingDelta` |
| `stepflow-handler.ts:handleWebhook` | Medium | 8 sequential validation steps (enabled → signature → parse → type filter → shape validate → dedup → concurrency cap → accept) with early returns | Each step maps cleanly to a method; could extract as `validateRequest(): ValidationResult` pipeline |
| `session-manager.ts:onPromptEvent` | Medium | 9-parameter function signature — carries full prompt context through a long parameter list | Bundle prompt parameters into a `PromptEventPayload` interface |
| `server/ws-server.ts:(startup block)` | Medium | The `server.listen` callback initialises workflow engine, loads workflows, broadcasts events, syncs schedules, and starts cron — all inline | Extract into `initWorkflowSubsystem(engine, sessions, wss)` function |

---

## Coupling & Cohesion Issues

**1. `SessionManager` as a thin facade with retained handler methods**
`session-manager.ts` delegated `ApprovalManager`, `SessionNaming`, and `SessionPersistence` but still holds all Claude event handlers (`onSystemInit`, `onTextEvent`, `onToolActiveEvent`, etc.) as private methods. These handlers collectively form a "session event adapter" concern distinct from lifecycle management. The class retains 15+ private handler methods plus public delegation wrappers, making the file 1,266 lines despite the prior decomposition.
*Suggested fix:* Extract `SessionEventAdapter` or `ClaudeEventForwarder` that takes a session and a broadcast callback, and move all `on*Event` methods there.

**2. `ws-server.ts` as a composition root with inline logic**
`ws-server.ts` acts as the application entry point and wires all subsystems, but also contains: `verifyToken`, `verifyTokenOrSessionToken`, `extractToken`, `checkWsRateLimit`, startup sequence, WebSocket connection handling, and graceful shutdown. Auth helpers are duplicated as closures that are then passed by reference to every router.
*Suggested fix:* Move `verifyToken`, `extractToken`, and `verifyTokenOrSessionToken` into `auth-utils.ts` (or the existing `crypto-utils.ts`). Move startup orchestration into a `startServer()` function.

**3. `App.tsx` — overloaded root component**
`App.tsx` (615 lines) manages: WebSocket state, session orchestration, file uploads, skill expansion, tentative queue auto-execution, docs browser state, URL routing sync, keyboard shortcut listener, theme sync, and error banners. It is the frontend equivalent of a god object.
*Suggested fix:* Extract `useSkillExpander`, `useFileUpload`, and `useTentativeQueue` composition into a `useAppActions` hook, leaving `App.tsx` as a pure layout composition component.

**4. `useChatSocket.ts` — dual responsibility**
The hook manages both WebSocket connection/reconnect logic (connect, disconnect, backoff, auth check, visibility restore) and message processing (streaming batching, state updates, session events). These are independently testable concerns.
*Suggested fix:* Extract `useWsConnection(token, onMessage)` for the transport layer, leaving `useChatSocket` to own message semantics only.

**5. Session token passing via mutable public properties**
`SessionManager._serverPort`, `._authToken`, and `._globalBroadcast` are set from `ws-server.ts` after construction. This pattern creates implicit temporal coupling — constructing `SessionManager` before the server is listening means properties are undefined during `restoreActiveSessions()` if the ordering changes.
*Suggested fix:* Pass these as constructor parameters or group them into a `ServerContext` injection object.

---

## Refactoring Candidates

**1. Extract `ClaudeEventAdapter` from `SessionManager`**
- **Location:** `server/session-manager.ts:408–467` (all `on*Event` methods)
- **Problem:** 15 private event-handler methods bloat `SessionManager`. They translate `ClaudeProcess` events into `WsServerMessage` broadcasts — a distinct concern.
- **Approach:** Create `server/claude-event-adapter.ts` with a function `wireClaudeEvents(cp, session, broadcast, sessionId, opts)` that takes a broadcast callback. Move all `onTextEvent`, `onToolActiveEvent`, etc. there. `SessionManager.wireClaudeEvents` becomes a one-liner delegation.
- **Effort:** Medium

**2. Flatten `ws.onmessage` switch in `useChatSocket`**
- **Location:** `src/hooks/useChatSocket.ts:282–484`
- **Problem:** A 200-line switch statement inside a `useCallback` mixes streaming performance logic, session state updates, connection health, and cross-session waiting indicator management.
- **Approach:** Define handlers as `Record<string, (msg) => void>` map or split into `handleStreamMsg`, `handleSessionMsg`, `handleConnectionMsg` pure functions called from a thin dispatch. This makes each branch independently unit-testable.
- **Effort:** Medium

**3. Decompose `App.tsx` via `useAppActions` hook**
- **Location:** `src/App.tsx:225–375` (skill expansion, file handling, tentative queue auto-execute, send logic)
- **Problem:** `handleSendWithFiles` (95 lines, 7 dependencies) and `handleExecuteTentative` belong to a "send pipeline" concern, not a layout component.
- **Approach:** Extract `useAppActions({ sendInput, sessions, activeSessionId, settings, docsBrowser, ... })` returning `{ handleSendWithFiles, handleExecuteTentative, handleDiscardTentative, expandSkill }`. `App.tsx` becomes a slim layout orchestrator.
- **Effort:** Medium

**4. Consolidate auth utilities out of `ws-server.ts`**
- **Location:** `server/ws-server.ts:68–102`
- **Problem:** `verifyToken`, `verifyTokenOrSessionToken`, and `extractToken` are defined as closures in the top-level server file and passed by reference to six routers. Any change requires tracing all call sites back to this one file.
- **Approach:** Move them into `server/auth-utils.ts` (or extend `crypto-utils.ts`). Each router imports directly, eliminating the parameter-passing pattern and making auth logic independently testable.
- **Effort:** Small

**5. Replace magic timeout constant in `App.tsx`**
- **Location:** `src/App.tsx:105` — `setTimeout(() => sendInputRef.current(ctx), 500)`
- **Problem:** The 500ms delay after session creation (waiting for Claude to initialize) is an unexplained magic number. If the initialization takes longer under load the context message is lost silently.
- **Approach:** Name the constant `PENDING_CONTEXT_SEND_DELAY_MS = 500` with a comment, or replace the timer with a message-driven approach (send context when `session_joined` or first `system_message` is received).
- **Effort:** Small

**6. Extract `WorkflowSkipped` catch path from `executeRun`**
- **Location:** `server/workflow-engine.ts:384–406`
- **Problem:** The outer `catch` in `executeRun` handles three distinct outcomes — skipped, canceled, and failed — using `instanceof` and signal checks inside a single block with shared mutation.
- **Approach:** Extract `finalizeRunError(run, err, abortController, db)` that returns `RunStatus` and handles DB writes. `executeRun`'s catch becomes a single call plus an `emitEvent`.
- **Effort:** Small

**7. Replace `onPromptEvent`'s 9-parameter signature**
- **Location:** `server/session-manager.ts:469–495`
- **Problem:** The method signature mirrors `ClaudeProcess`'s `prompt` event tuple exactly. Any new field added to the prompt event requires updating the method signature and every callsite.
- **Approach:** Define `PromptEventPayload` interface in `types.ts` (matching `ClaudeProcessEvents['prompt']` tuple), change `onPromptEvent(session, payload: PromptEventPayload)`, and spread at the call site.
- **Effort:** Small

**8. Introduce `ServerContext` injection for `SessionManager`**
- **Location:** `server/session-manager.ts:64–73`, `server/ws-server.ts:126–128`
- **Problem:** Three public mutable properties (`_serverPort`, `_authToken`, `_globalBroadcast`) are set post-construction, creating temporal coupling and exposing server internals on the manager.
- **Approach:** Define `interface ServerContext { port: number; authToken: string; globalBroadcast(msg): void }` and pass to constructor. Mark underscore-prefixed properties private.
- **Effort:** Small

**9. Deduplicate cron-field parsing in `workflow-engine.ts`**
- **Location:** `server/workflow-engine.ts:100–136` (`parseCronField`, `cronMatchesDate`, `nextCronMatch`)
- **Problem:** The cron parser is a self-contained 50-line block embedded in the engine file. It's untested in isolation and couples engine size to a parsing concern.
- **Approach:** Extract to `server/cron-parser.ts`. Export `parseCronField`, `cronMatchesDate`, `nextCronMatch` as pure functions. Add a focused unit test file.
- **Effort:** Small

**10. Colocate `buildListQuery` with query helpers**
- **Location:** `server/workflow-engine.ts:157–179`
- **Problem:** `buildListQuery` is a generic SQL-builder embedded in the workflow engine. It cannot be reused by `session-archive.ts` or future query needs without importing from the engine.
- **Approach:** Move to `server/db-utils.ts` alongside any future query helpers. Import into `workflow-engine.ts`.
- **Effort:** Small