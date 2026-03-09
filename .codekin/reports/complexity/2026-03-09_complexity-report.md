# Complexity Report: codekin

**Date**: 2026-03-09T19:06:14.712Z
**Repository**: /srv/repos/codekin
**Branch**: main
**Workflow Run**: d9350d70-821a-458b-b405-e9ff41993485
**Session**: 41ed2bb0-a4bf-4f0c-934f-0fa800239d6c

---

Now I have a thorough picture of the codebase. Let me produce the report.

## Summary

**Overall Complexity Rating: Medium**

The Codekin codebase is well-structured for its feature set — most modules are well-scoped with clean separation (approval, naming, persistence), typed WebSocket protocol, and test coverage. However, complexity concentrates heavily in a few coordinator files. The largest file (`session-manager.ts`, 1270 lines) is the central coordinator; while it delegates to sub-modules, its `wireClaudeEvents` and `handleClaudeExit`/`handleClaudeResult` methods are dense. The frontend's `App.tsx` (620 lines, 73 function definitions) acts as a mega-component that wires together all major UI concerns. The `ws-server.ts` message-handling switch contains inline business logic that would benefit from extraction.

**Key metrics:**
- Largest file: `server/session-manager.test.ts` at 2559 lines (test), `server/session-manager.ts` at 1270 lines (source)
- Largest source component: `src/App.tsx` at 620 lines with 11 React hook calls (8 useState, 7 useCallback, 4 useEffect, 2 useMemo) and ~73 total function/arrow-function definitions
- Most complex function: `useChatSocket` hook — single function body of ~520 lines with a 34-case switch
- Deepest nesting: `handleUserEvent` in `claude-process.ts` (5 levels of block depth, lines 303–352), `handleSendWithFiles` in `App.tsx` (4 levels, lines 274–321), `wireClaudeEvents` in `session-manager.ts` (4 levels in nested callbacks, lines 408–561, deepest in `control_request` handler)

---

## Largest Files

| File | Lines | Primary Responsibility | Refactor Priority |
|------|-------|------------------------|-------------------|
| `server/session-manager.test.ts` | 2559 | Test suite for SessionManager | Low (tests) |
| `server/claude-process.test.ts` | 1405 | Test suite for ClaudeProcess | Low (tests) |
| `server/session-manager.ts` | 1270 | Session lifecycle, process wiring, tool approvals | **High** |
| `src/hooks/useChatSocket.ts` | 677 | WebSocket connection + all message dispatch | **High** |
| `server/workflow-engine.ts` | 654 | Workflow execution, SQLite persistence, cron | Medium |
| `src/App.tsx` | 620 | Root component — UI orchestration, all state | **High** |
| `server/claude-process.ts` | 586 | Claude CLI process + NDJSON parsing | Medium |
| `server/ws-server.ts` | 579 | HTTP server, WS connection handling, routing | Medium |
| `src/components/AddWorkflowModal.tsx` | 557 | Workflow creation/editing form | Medium |
| `server/workflow-loader.test.ts` | 545 | Tests for workflow loader | Low (tests) |
| `src/components/ChatView.tsx` | 477 | Chat message rendering (all message types) | Low |
| `src/components/LeftSidebar.tsx` | 462 | Sidebar nav, repo tree, drag-resize | Medium |
| `src/components/Settings.tsx` | 438 | Settings modal with multiple config sections | Low |
| `server/stepflow-handler.ts` | 506 | Stepflow webhook integration, workspace mgmt | Medium |
| `server/workflow-loader.ts` | 494 | Markdown workflow parsing, session orchestration | Medium |

---

## Most Complex Functions

| File:Function | Est. Complexity | Issue Description | Refactor Suggestion |
|---|---|---|---|
| `src/hooks/useChatSocket.ts:useChatSocket` | Very High | Monolithic hook body (~520 lines). Contains WebSocket lifecycle, a 34-branch `switch` message handler, streaming flush logic, session restoration, auth checking, ping/pong, and model selection — all in one closure. | Extract `useWsConnection` (connect/reconnect/auth/ping), `useWsMessageHandler` (the switch), and `useSessionRestore` as separate hooks or helper functions. |
| `server/session-manager.ts:wireClaudeEvents` | High | Registers 13 event handlers all as inline closures that directly reference `session`, `sessionId`, `cp`. Each handler has its own side effects, including nested conditionals for naming and retry logic. The `control_request` handler alone is ~50 lines. | Extract each event handler into a private named method: `handleTextEvent`, `handleToolActiveEvent`, `handleControlRequestEvent`, etc. `wireClaudeEvents` becomes a thin registration loop. |
| `server/session-manager.ts:handleClaudeExit` | High | 70-line method with three nested branches (stopped-by-user → early return; within-cooldown → restart loop; exhausted → final exit), each duplicating `_exitListeners` notification logic. | Extract `shouldAutoRestart()` predicate and `notifyExitListeners(willRestart)` helper; flatten the branching. |
| `server/session-manager.ts:requestToolApproval` | High | 80-line method that manually constructs a Promise with a timeout holder pattern, duplicates auto-approve logic already present in `control_request` handler, and has 3 levels of conditional nesting for client presence. | Extract `buildApprovalPromise(session, ...)` and `buildPermissionPromptMsg(...)` helpers; the auto-approve check (`checkAutoApproval` + headless guard) is literally copied from `wireClaudeEvents` — refactor into a shared `tryAutoApprove()` helper. |
| `src/App.tsx:handleSendWithFiles` | High | 45-line `useCallback` with 4-level nesting: skill expansion → tentative mode check → file upload branch → docs context injection. Has two separate send paths (with/without files) with duplicated `fileLine` construction logic that's also in `handleExecuteTentative`. | Extract `buildMessageWithFiles(text, files, paths)` utility, and move tentative queue logic to `useTentativeQueue` or `useSessionOrchestration`. |
| `server/claude-process.ts:handleUserEvent` | High | Iterates content blocks with 5-level nesting: method → blocks loop → `tool_result` check → `contentBlocks` branch → `image` type check. Inline image emission is hidden inside this nesting. | Extract `extractToolResultContent(block)` → `{ text, imageEmissions }` to flatten. |
| `server/claude-process.ts:handleStreamEvent` | Medium-High | 75-line switch with three cases, where `content_block_stop` handles 5 different sub-scenarios (thinking end, tool end, ExitPlanMode, task tool, summary) with nested if/try/catch chains. | Extract `handleToolBlockStop()` and `handleThinkingBlockStop()` to replace the branchy `content_block_stop` case. |
| `server/session-manager.ts:handleAskUserQuestion` | Medium | 30-line method parses JSON, handles three different value shapes (string JSON map, plain string, array), with nested try/catch and type coercion. | Extract `parseAskUserAnswers(value, questions)` → `Record<string, string>` as a standalone utility function; unit-testable in isolation. |
| `server/session-manager.ts:sendInput` | Medium | 45-line method combines three responsibilities: auto-start logic, context rebuild (only when no `claudeSessionId`), and turn-count / naming-retry tracking. The `if (!session.claudeSessionId)` block is deeply nested inside the `if (!session.claudeProcess?.isAlive())` block. | Split into `maybeAutoStart(session)` and `maybeRebuildContext(session, data)` helpers. |
| `server/workflow-engine.ts:executeRun` | Medium | 95-line `private async` method containing a nested `try/catch` inside a step loop, inside a try/catch for the overall run, inside a `finally` for `afterRun`. Error path has three sub-branches for `WorkflowSkipped`, `canceled`, and `failed`. | Extract `runStep(stepDef, run, lastOutput, abortSignal)` to lift the inner try/catch into its own method, reducing nesting depth by two levels. |

---

## Coupling & Cohesion Issues

1. **`App.tsx` as God Component**
   `App.tsx` holds 11 hooks, 8 state variables, 12+ callbacks, and renders 6 major sub-trees (chat, docs browser, workflows, mobile bar, settings modal, command palette). It directly calls `leaveSession`, `joinSession`, `clearMessages` from `useChatSocket` when navigating, acting as a manual state machine for session routing.
   *Suggested fix:* The URL/session navigation state machine (auto-join on connect, browser back/forward sync, URL push on session change) is a self-contained concern — extract to `useSessionNavigation`. The docs browser interaction (3 `useCallback` handlers, 1 `useMemo`) should move into `useDocsBrowser` which already exists but lacks the App-side handler construction.

2. **Duplicated auto-approve guard in `SessionManager`**
   The "check auto-approval, then check headless source" pattern appears verbatim in two places: `wireClaudeEvents` (in the `control_request` handler) and `requestToolApproval` (for the hook path). Both blocks check `checkAutoApproval(session.workingDir, toolName, toolInput)` and then check `session.source === 'webhook' || ...`. A logic change to either path must be manually mirrored in the other.
   *Suggested fix:* Extract `resolveApprovalImmediately(session, toolName, toolInput): boolean | null` (returns `true` if auto-approved, `false` if headless-auto-approved, `null` if needs UI prompt) and call it from both sites.

3. **`ws-server.ts` inline WebSocket message handling**
   The `wss.on('connection', ...)` callback (lines 327–499) contains a 12-case switch with direct calls to `sessions.*` methods. This is business logic (session routing, input dispatch) embedded in the server setup file, making it hard to test in isolation.
   *Suggested fix:* Extract a `WsConnectionHandler` class or `handleWsMessage(msg, ws, sessions, send, clientSessions)` function to a dedicated `ws-message-handler.ts` module.

4. **`useChatSocket` manages too many concerns**
   The hook owns WebSocket lifecycle, all 30+ message type handlers, message buffering (`pendingTextRef` + RAF), auth check polling, session restore on visibility change, and model selection. It returns 17 properties. Consumers (`App.tsx`) then pass most of these through 2–3 component layers.
   *Suggested fix:* Extract `useWsConnection(token)` → `{ ws, connState, send, reconnect, disconnect }` and keep `useChatSocket` focused on session-level state. Auth polling could move to a standalone `useAuthCheck(token)` hook.

5. **`LeftSidebar` prop drilling depth**
   `LeftSidebar` receives 30 props, including nested docs picker state (`docsPickerOpen`, `docsPickerRepoDir`, `docsPickerFiles`, `docsPickerLoading`, 2 callbacks) and archived session state — all of which are passed down again to `RepoSection`. This is classic prop drilling for state that `RepoSection` consumes directly.
   *Suggested fix:* Group docs picker state into a `DocsPickerProps` interface (already partially done structurally), or create a `DocsPickerContext` so `RepoSection` can consume it directly without threading through `LeftSidebar`.

6. **`groupKey` function defined twice**
   `groupKey(session)` (returns `session.groupDir ?? session.workingDir`) is defined in both `src/App.tsx` (imported from `useSessionOrchestration`) and `src/components/LeftSidebar.tsx` (local inline definition), with the same logic. Any change must be applied to both.
   *Suggested fix:* The version in `useSessionOrchestration` should be the canonical export; `LeftSidebar` should import it.

---

## Refactoring Candidates

1. **Extract `useWsConnection` from `useChatSocket`**
   *Location:* `src/hooks/useChatSocket.ts:154–677`
   *Problem:* The hook is a 520-line function body responsible for WebSocket lifecycle (connect/disconnect/reconnect/auth timeout/ping), streaming flush buffering, and all 34 message-type handlers. It's difficult to test message handling without testing connection management.
   *Approach:* Extract `useWsConnection(token)` covering `ws`, `connState`, `send`, `connect`, `disconnect`, `cleanup`, `reconnect`. The message switch becomes testable in isolation, and streaming performance logic (`pendingTextRef`/RAF) is cleanly separated from auth/ping concerns.
   *Effort:* Medium

2. **Break `wireClaudeEvents` into named handler methods**
   *Location:* `server/session-manager.ts:408–561`
   *Problem:* A 153-line method that registers 13 inline closures — each is effectively a private method hiding inside `wireClaudeEvents`. The `control_request` inline handler is 50+ lines. When reading a bug report, the developer must mentally parse all 13 closures to find the right one.
   *Approach:* Convert each `cp.on('event_type', ...)` registration into `cp.on('event_type', this.onEventType.bind(this, session, sessionId))` with named private methods. This also makes the auto-approve duplication visible and easy to fix.
   *Effort:* Medium

3. **Reduce `App.tsx` to a thin orchestrator**
   *Location:* `src/App.tsx`
   *Problem:* The component has 11 hook calls, 8 `useState`, 7 `useCallback`, 4 `useEffect`, and 2 `useMemo` all at the top level. It is the single source of truth for session navigation, file uploads, tentative queue execution, skill expansion, docs browser state, and JSX for all 4 layout regions.
   *Approach:* (a) Extract `useSessionNavigation` for URL sync + auto-join effects. (b) Move `handleSendWithFiles` + `expandSkill` + `handleExecuteTentative` + `handleDiscardTentative` into a `useSendMessage` hook. (c) The JSX for the main content area (docs/workflow/chat branches) could move to a `MainArea` component. These changes together would reduce `App.tsx` to under 300 lines.
   *Effort:* Medium

4. **Deduplicate auto-approve logic in `SessionManager`**
   *Location:* `server/session-manager.ts:502–513` and `server/session-manager.ts:902–912`
   *Problem:* The "check auto-approval, then check headless source" guard is copy-pasted in `wireClaudeEvents`'s `control_request` handler and `requestToolApproval`. Adding a new headless source (e.g. a future `'scheduled'` source) requires updating both locations.
   *Approach:* Add a private `resolveAutoApproval(session, toolName, toolInput): 'allow' | 'prompt'` method; replace both inline blocks with a call to it.
   *Effort:* Small

5. **Extract `handleWsMessage` from `ws-server.ts`**
   *Location:* `server/ws-server.ts:350–486`
   *Problem:* The 12-case switch inside `ws.on('message', ...)` is deeply nested inside `wss.on('connection', ...)` and not unit-testable without a real WebSocket. It accesses `clientSessions`, `sessions`, `send`, `authenticated`, and `connectionId` from the enclosing closure.
   *Approach:* Extract `handleWsMessage(msg, context: WsHandlerContext)` where `WsHandlerContext` is a typed struct of the closure state. Move to `ws-message-handler.ts`. The handler can be unit-tested with mock context objects.
   *Effort:* Small

6. **Merge duplicated `groupKey` definitions**
   *Location:* `src/App.tsx` (imported from `useSessionOrchestration`) and `src/components/LeftSidebar.tsx` (re-implemented locally at line 33)
   *Problem:* Two implementations of the same 1-liner. If the grouping logic changes, only one will be updated.
   *Approach:* Remove the local definition in `LeftSidebar.tsx` and import `groupKey` from `useSessionOrchestration`.
   *Effort:* Small

7. **Flatten `handleStreamEvent`'s `content_block_stop` branch**
   *Location:* `server/claude-process.ts:216–293`, specifically the `content_block_stop` case (~40 lines)
   *Problem:* The case handles 5 different scenarios with nested if/try/catch: thinking block end, tool block end with task detection, ExitPlanMode deferral, summary emission, and tool input parse failure. Adding a new event sub-type requires understanding all 5 paths.
   *Approach:* Extract `handleThinkingBlockStop()` and `handleToolBlockStop(toolName, rawInput)` private methods; `content_block_stop` becomes a 4-line routing switch.
   *Effort:* Small

8. **Extract `buildMessageWithFiles` utility to eliminate duplication**
   *Location:* `src/App.tsx:309–319` (`handleSendWithFiles`) and `src/App.tsx:329–342` (`handleExecuteTentative`)
   *Problem:* The pattern of `upload all files → build fileLine → prepend to text → call sendInput` is copy-pasted in both callbacks. A change to the attachment format (e.g. the `[Attached files: ...]` prefix) must be applied in two places.
   *Approach:* Extract a standalone async utility `sendWithFiles(files, text, token, sendInput)` that encapsulates the upload + message construction, returning a promise.
   *Effort:* Small

9. **Reduce `LeftSidebar`'s 30-prop interface**
   *Location:* `src/components/LeftSidebar.tsx:72–113`
   *Problem:* The component receives 30 props, 6 of which relate to docs picker state, 5 to session callbacks, and 3 to mobile state. Downstream consumers (`RepoSection`) re-receive the same docs picker props. Adding new cross-cutting sidebar features will continue to inflate this interface.
   *Approach:* Group into structured prop bags: `docsPickerProps?: DocsPickerProps`, `mobileProps?: MobileProps`. Or use React context for docs picker state since it's consumed by `RepoSection` children. This also removes the need to thread `docsPickerOpen/RepoDir/Files/Loading/Select/Close/StarredDocs` through `LeftSidebar` at all.
   *Effort:* Medium

10. **Lift `listRuns` SQL construction in `workflow-engine.ts` to a query builder**
    *Location:* `server/workflow-engine.ts:436–471`
    *Problem:* `listRuns` builds a SQL string by string concatenation with manual `params` array management — a maintainability risk — while currently parameterized, the manual string concatenation pattern is fragile and could introduce injection vulnerabilities if future filters include unparameterized user input. The pattern also prevents any sharing with future `countRuns` or `listSteps` queries.
    *Approach:* Extract a small `buildListQuery(table, filters, opts)` helper that returns `{ sql, params }` from typed filter objects, or use a tagged template literal helper that ensures parameterization. This also makes the intent readable: today's `if (opts?.kind) { sql += ` AND kind = ?`; params.push(opts.kind) }` becomes a single typed filter object.
    *Effort:* Small
