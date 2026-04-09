# Complexity Report: codekin

**Date**: 2026-04-08T04:34:03.812Z
**Repository**: /srv/repos/codekin
**Branch**: chore/workflow-reports-2026-04-07
**Workflow Run**: afd7ef0c-b166-4bea-b067-81dcb3f0db66
**Session**: e504403b-a2ad-4e3c-b9e5-d42aaac40b36

---

Now I have enough information to produce the report.

```markdown
## Summary

**Overall Complexity Rating: Medium–High**

The codebase is a TypeScript/React monorepo (~46,000 lines of first-party code excluding tests) with a well-structured server and a mostly clean frontend. The primary complexity hot-spot is `session-manager.ts` — a 2,174-line, 55-method class that acts as a God Object, combining session CRUD, process lifecycle, WebSocket broadcasting, approval routing, retry logic, plan-mode state, worktree management, and diff delegation. Secondary concerns are parallel tool summarization logic duplicated across modules and prompt/approval flows with 4–5 levels of branching nesting.

| Metric | Value |
|---|---|
| Largest file (non-test) | `server/session-manager.ts` — 2,174 lines |
| Total first-party source files | ~737 |
| Most complex function | `requestToolApproval` (~140 lines, 5+ branch levels) |
| Deepest nesting observed | 5–6 levels (`leave()`, `requestToolApproval`, `sendPromptResponse`) |

---

## Largest Files

| File | Lines | Primary Responsibility | Refactor Priority |
|---|---|---|---|
| `server/session-manager.ts` | 2,174 | Session lifecycle, process management, approval routing, broadcast, worktree, context building | **High** |
| `server/claude-process.ts` | 762 | Spawning/managing a single Claude CLI subprocess | Medium |
| `server/workflow-engine.ts` | 746 | SQLite-backed workflow runs, cron scheduling | Low |
| `server/orchestrator-learning.ts` | 704 | Memory extraction, aging, skill modeling | Low |
| `server/ws-server.ts` | 621 | Express/WebSocket server entry point, startup | Medium |
| `server/orchestrator-routes.ts` | 614 | Orchestrator REST API routes | Low |
| `server/stepflow-handler.ts` | 521 | Stepflow webhook integration | Low |
| `server/workflow-loader.ts` | 505 | Loads `.md` workflow definitions | Low |
| `server/session-routes.ts` | 475 | Session REST endpoints | Low |
| `server/approval-manager.ts` | 456 | Tool auto-approval registry, pattern matching | Low |
| `src/components/InputBar.tsx` | 684 | Chat input, slash commands, skill menu, toolbar | **High** |
| `src/App.tsx` | 674 | Root app component, global state/hooks wiring | **High** |
| `src/components/ChatView.tsx` | 602 | Chat message rendering | Medium |
| `src/components/AddWorkflowModal.tsx` | 580 | Workflow creation modal | Low |
| `src/lib/ccApi.ts` | 534 | REST client functions for server API | Low |

---

## Most Complex Functions

| File:Function | Estimated Complexity | Issue Description | Refactor Suggestion |
|---|---|---|---|
| `session-manager.ts:requestToolApproval` | Very High | ~140 lines with 5-level nesting; handles AskUserQuestion, ExitPlanMode, double-gating guard, pattern construction, and 300s timeout all in one method | Split into `handleQuestionApproval()`, `handlePermissionApproval()`, and `buildPromptMessage()` helpers |
| `session-manager.ts:sendPromptResponse` | High | ~70 lines; routes through 4 approval paths with nested null-checks and fallback logic; difficult to trace which branch handles which case | Extract `routeToolApproval()` and `routeControlRequest()` sub-methods |
| `session-manager.ts:handleClaudeExit` | High | ~90 lines; mixes process cleanup, session conflict detection, restart evaluation, message building, and context injection | Separate `afterExitCleanup()` from the restart decision dispatch |
| `session-manager.ts:leave` | High | 5-level nesting (method → if-no-clients → setTimeout callback → re-check → iterate pending maps) to auto-deny prompts after grace period | Extract `autoDeniesPendingPrompts(session)` called from the timeout |
| `session-manager.ts:startClaude` | High | ~65 lines building env vars, merging allowed tools, computing `resume` flag, and wiring events; assembles too many concerns | Extract `buildProcessEnv()` and `buildClaudeOptions()` helpers |
| `claude-process.ts:handleControlRequest` | Medium-High | Branches on AskUserQuestion, AUTO_APPROVE_TOOLS, and fallback; duplicates question-parsing logic also present in `session-manager.ts:requestToolApproval` | Consolidate question-structure mapping into a shared `parseAskUserQuestions()` utility |
| `session-manager.ts:reapIdleSessions` | Medium | Two separate iteration passes over `this.sessions` (idle-stop pass, stale-prune pass) — O(2n) with duplicated source exemptions | Merge into one pass with a helper that decides action per session |
| `workflow-engine.ts:executeRun` | Medium | ~100 lines; nested try-catch-try-catch with multiple DB update paths for each status (skipped/canceled/failed) | Extract `markRunFailed()`, `markRunSkipped()`, `markRunCanceled()` helpers |
| `session-manager.ts:buildSessionContext` | Medium | History-replay accumulator with state machine logic inline; duplicates pattern from `useChatSocket.ts:applyMessageMut` | Extract a shared `replayHistory(messages)` utility used by both |
| `session-manager.ts:resolveToolApproval` | Medium | Handles three distinct tool types (AskUserQuestion, ExitPlanMode, generic permission) with branching decode + registry update | Dispatch table pattern or strategy objects per tool type |

---

## Coupling & Cohesion Issues

**1. `SessionManager` is a God Object**

`session-manager.ts` mixes at least seven distinct concerns: session CRUD, Claude process lifecycle, WebSocket broadcast, approval/prompt routing, worktree management, session context building, and API retry scheduling. It already delegates some logic to `ApprovalManager`, `SessionNaming`, `SessionPersistence`, and `DiffManager`, but the remaining 2,174 lines still contain too many responsibilities. Any change to approval flow, restart logic, or broadcast requires editing the same file.

*Suggested fix:* Extract a `PromptRouter` class for all approval/prompt dispatch, and a `SessionLifecycle` class for process start/stop/restart. `SessionManager` becomes a thin coordinator.

**2. Duplicated question-structure parsing between `ClaudeProcess` and `SessionManager`**

`claude-process.ts:handleControlRequest` (lines ~495–510) parses the `AskUserQuestion.questions` array and maps option labels/values. The same mapping logic reappears in `session-manager.ts:requestToolApproval` (lines ~1593–1604). Two different callers maintaining the same transformation is a latent inconsistency risk.

*Suggested fix:* Extract `parseStructuredQuestions(rawQuestions)` into a shared utility in `types.ts` or a small `question-utils.ts`.

**3. Tool-input summarization duplicated across `ClaudeProcess` and `SessionManager`**

`claude-process.ts:summarizeToolInput` and `session-manager.ts:summarizeToolPermission` both handle `Bash`, `Read`, `Write`, and other tools with overlapping switch-case logic. They diverge in format (`$ cmd` vs `Allow Bash? \`$ cmd\``) but share the same tool-name dispatch.

*Suggested fix:* Centralize tool input extraction into a `getToolDisplayString(toolName, toolInput)` utility; each call site adds its own prefix.

**4. `ws-server.ts` wires business logic inline**

`ws-server.ts` registers the orchestrator prompt listener (lines 517–540) and the workflow engine event broadcaster (lines 551–566) as inline closures. This makes startup sequencing harder to test and means the file owns behavior beyond "server wiring."

*Suggested fix:* Move these into dedicated `OrchestratorBridge.connect()` and `WorkflowBroadcaster.connect()` methods.

**5. `src/App.tsx` as a mega-component**

`App.tsx` imports 12+ hooks and 15+ components, maintains ~20 pieces of state, and provides callbacks that thread through multiple child components. While content views are extracted (`OrchestratorContent`, `SessionContent`, `DocsBrowserContent`), the App component still wires together authentication, routing, diff panel, worktree toggle, queue messages, command palette, and skill menu.

*Suggested fix:* Extract a `useAppState()` composite hook to own the wiring of smaller domain hooks, leaving `App` as a layout-only component.

---

## Refactoring Candidates

**1. Extract `PromptRouter` from `SessionManager`**
- **Location:** `server/session-manager.ts` lines 1328–1724
- **Problem:** `sendPromptResponse`, `requestToolApproval`, `handleExitPlanModeApproval`, `resolveToolApproval`, `handleAskUserQuestion`, `sendControlResponseForRequest`, and `decodeApprovalValue` form a cohesive approval routing subsystem but live inside `SessionManager` alongside unrelated concerns.
- **Approach:** Create `server/prompt-router.ts` with a `PromptRouter` class that takes `session` + `claudeProcess` as constructor args; move all seven methods there. `SessionManager` holds a `PromptRouter` instance and delegates.
- **Effort:** Medium

**2. Extract `SessionLifecycle` process management**
- **Location:** `server/session-manager.ts` lines 729–875, 1173–1265, 1841–1878
- **Problem:** `startClaude`, `wireClaudeEvents`, `handleClaudeExit`, `stopClaude`, `stopClaudeAndWait`, and `waitForReady` are cohesive but tangled with broadcast and session-state mutation.
- **Approach:** Create `server/session-lifecycle.ts` owning these methods; `SessionManager` delegates and provides a broadcast callback.
- **Effort:** Medium

**3. Consolidate tool-input summarization**
- **Location:** `server/claude-process.ts:summarizeToolInput` (line 633) and `server/session-manager.ts:summarizeToolPermission` (line 1771)
- **Problem:** Duplicated switch-case dispatch with similar logic.
- **Approach:** Extract `server/tool-summary.ts` with `summarizeToolInput(name, input): string` and `permissionPrompt(name, input): string` built on top of it.
- **Effort:** Small

**4. Consolidate `AskUserQuestion` question-structure parsing**
- **Location:** `server/claude-process.ts` ~line 495 and `server/session-manager.ts` ~line 1593
- **Problem:** Same `rawQuestions.map(q => ({ question, header, multiSelect, options: opts.map(...) }))` mapping in two files.
- **Approach:** Add `parseAskUserQuestions(rawInput): StructuredQuestion[]` to `server/types.ts` or a `server/question-utils.ts`; both files call it.
- **Effort:** Small

**5. Reduce `App.tsx` complexity with `useAppState` hook**
- **Location:** `src/App.tsx` lines 1–100+
- **Problem:** 20+ state declarations and 10+ `useCallback` / `useEffect` hooks make the component hard to read and impossible to test in isolation.
- **Approach:** Extract a `src/hooks/useAppState.ts` composing all sub-hooks (`useSettings`, `useRepos`, `useSessions`, `useRouter`, etc.) into a single return value. `App` only handles layout/JSX.
- **Effort:** Medium

**6. Extract `InputBar` sub-components**
- **Location:** `src/components/InputBar.tsx` — 684 lines
- **Problem:** Contains 10+ sub-functions/components (dropdowns, permission picker, model picker, mobile variant, skill menu integration) inside one file; growing independently.
- **Approach:** Move `PermissionModeDropdown`, `ModelDropdown`, `MobileInputBar`, `DesktopInputBar` into a `src/components/InputBar/` folder with an index re-export.
- **Effort:** Small

**7. Merge `reapIdleSessions` into a single pass**
- **Location:** `server/session-manager.ts:reapIdleSessions` (line 141)
- **Problem:** Two separate `for` loops over `this.sessions.values()` — one for idle-stopping, one for stale-pruning — with duplicated source-type exemption guards.
- **Approach:** Combine into one loop; compute both `isIdle` and `isStale` per session, collect actions, then execute. Reduces O(2n) to O(n) and eliminates the repeated exemption checks.
- **Effort:** Small

**8. Replace inline listeners in `ws-server.ts` with bridge classes**
- **Location:** `server/ws-server.ts` lines 517–590
- **Problem:** Orchestrator prompt listener and workflow event broadcaster are long inline closures that belong to the `OrchestratorMonitor` and `WorkflowEngine` subsystems, not to server startup wiring.
- **Approach:** Add `OrchestratorBridge.attach(sessions, engine)` and `WorkflowBroadcaster.attach(engine, wss)` that encapsulate these listeners; call them once after init.
- **Effort:** Small

**9. Extract `buildSessionContext` into a shared history replay utility**
- **Location:** `server/session-manager.ts:buildSessionContext` (line 1914) and `src/hooks/useChatSocket.ts:applyMessageMut`
- **Problem:** Both implement state-machine history replay logic to reconstruct conversation context from `WsServerMessage[]`. The server version is a reduced text version; the client version is a UI version — but the structural pattern (accumulating assistant text, flushing on `result`) is the same.
- **Approach:** Document a `replayHistory<T>(messages, reducer)` utility usable by both; or at minimum extract a shared `accumulateAssistantText(messages): string` helper for the server path.
- **Effort:** Small

**10. Inline cron parser or replace with a library**
- **Location:** `server/workflow-engine.ts` lines 159–210
- **Problem:** The hand-rolled 5-field cron parser (`parseCronField`, `cronMatchesDate`, `nextCronMatch`) is ~50 lines with its own edge-case surface area. The 366-day minute-by-minute search loop in `nextCronMatch` is O(526,560) per call — acceptable for low-frequency use but unexpected.
- **Approach:** Replace with the `cron-parser` npm package (already in the ecosystem, battle-tested) or at least add an early exit to `nextCronMatch` once the next match is found past a reasonable bound.
- **Effort:** Small
```Committed and pushed the complexity report to `chore/workflow-reports-2026-04-07`.