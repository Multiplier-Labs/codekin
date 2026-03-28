# Complexity Report: codekin

**Date**: 2026-03-25T05:33:27.166Z
**Repository**: /srv/repos/codekin
**Branch**: chore/repo-health-report-2026-03-25
**Workflow Run**: 8a9d4d31-4557-4037-9cee-39ee92143758
**Session**: 3a525f83-8877-4c0f-877d-78a70545abd8

---

Now I have enough data to produce the report.Now I have all the information needed to write the report.

```markdown
## Summary

**Overall Complexity Rating: Medium**

The Codekin codebase is a ~27k-line TypeScript monorepo (frontend + server) with a healthy module decomposition trend — several large classes have already been split into delegates. Complexity is concentrated in a handful of files:

- **Largest file**: `server/session-manager.ts` — 1,832 lines
- **Deepest nesting**: `server/claude-process.ts:handleUserEvent` — 4+ levels (for→if→if→if)
- **Most complex function**: `SessionManager.handleClaudeResult` — multi-branch retry logic, noise filtering, naming trigger, and result listener dispatch all in one method (~80 lines)
- **Widest constructor**: `ClaudeProcess` constructor — 7 positional parameters

---

## Largest Files

| File | Lines | Primary Responsibility | Refactor Priority |
|---|---|---|---|
| `server/session-manager.ts` | 1,832 | Session lifecycle, Claude process wiring, approval routing, worktree ops, archiving | High |
| `server/workflow-engine.ts` | 746 | SQLite-backed workflow execution, cron scheduling, step orchestration | Low |
| `server/claude-process.ts` | 716 | Claude CLI subprocess management, NDJSON stream parsing, event emission | Medium |
| `src/components/InputBar.tsx` | 709 | Text input, file attach, model/permission menus, mobile variant | Medium |
| `server/orchestrator-learning.ts` | 704 | Memory extraction, aging, skill model, decision tracking | Low |
| `src/App.tsx` | 674 | Root app state, hook wiring, layout routing, modal management | Medium |
| `server/orchestrator-routes.ts` | 612 | REST endpoints for orchestrator (memory, trust, children, reports) | Low |
| `src/components/ChatView.tsx` | 602 | Message list rendering, virtual scroll, image/tool/planning views | Low |
| `server/ws-server.ts` | 587 | Express/WS server bootstrap, auth, route registration | Medium |
| `src/components/AddWorkflowModal.tsx` | 580 | Workflow creation form with YAML preview and validation | Low |
| `src/lib/ccApi.ts` | 534 | REST client for all server API endpoints | Low |
| `server/stepflow-handler.ts` | 521 | Stepflow webhook to Claude session bridge | Low |
| `src/components/Settings.tsx` | 517 | Settings modal with multiple sections and nested forms | Low |
| `src/hooks/useChatSocket.ts` | 512 | WebSocket session hook, message state, streaming | Low |
| `server/workflow-loader.ts` | 507 | Markdown → workflow definition parser and file watcher | Low |

---

## Most Complex Functions

| File:Function | Estimated Complexity | Issue Description | Refactor Suggestion |
|---|---|---|---|
| `server/session-manager.ts:startClaude` | High | Builds env vars, merges tool lists, creates ClaudeProcess, and calls `wireClaudeEvents` — several concerns in one method (~60 lines) | Extract env-var assembly into `buildChildEnv()` and tool merging into `buildAllowedTools()` |
| `server/session-manager.ts:handleClaudeResult` | High | Single method handles: API retry logic (3 paths), noise filtering, result broadcasting, naming trigger, and result listener dispatch (~80 lines, 6 branches) | Split into `handleApiRetry()` + `handleSuccessfulResult()`, call from a thin coordinator |
| `server/claude-process.ts:handleUserEvent` | High | 4+ nesting levels: for→block-type check→image-vs-text branch→ExitPlanMode match→approval-message check. Spans ~55 lines | Extract "ExitPlanMode result" logic into `handleExitPlanModeResult()`, extract image content block into `handleImageBlock()` |
| `server/claude-process.ts:handleStreamEvent` | Medium-High | Nested switch-in-switch (outer: event type, inner: block/delta type); thinking delta path has 3 levels of conditionals | Extract `handleContentBlockStart/Delta/Stop()` per case — already partially done for stop |
| `server/session-manager.ts:onControlRequestEvent` | Medium-High | 6 branches: invalid requestId, auto-approve, pre-existing tool approval, build prompt, broadcast to present/absent clients, notify listeners (~65 lines) | Extract prompt-building into `buildPermissionPrompt()` and client broadcast logic into `sendPromptToClients()` |
| `server/claude-process.ts:constructor` | Medium | 7 positional parameters — easy to mis-order on call sites: `new ClaudeProcess(dir, id, env, model, perm, resume, tools)` | Replace with an options object `ClaudeProcessOptions` |
| `src/components/InputBar.tsx:(root component)` | Medium | Renders 4 distinct toolbar variants (desktop default, desktop orchestrator, mobile default, mobile orchestrator) inline with duplicated button JSX | Extract each variant into `DesktopToolbar`, `OrchestratorToolbar`, `MobileToolbar` sub-components |
| `server/session-manager.ts:sendPromptResponse` | Medium | Routes `allow`/`always_allow`/`deny` + cross-references two separate pending maps (`pendingToolApprovals` and `pendingControlRequests`), handles pattern updates, emits dismiss | Split tool-approval response path from control-request response path into separate handlers |
| `src/App.tsx:(root component)` | Medium | 30+ state variables and callbacks, 15 hooks, 4 view branches in JSX (~630 lines) | Most logic is already delegated; the remaining complexity is prop drilling — consider a context for `token`/`isMobile`/`settings` |
| `server/workflow-engine.ts:executeRun` | Medium | Nested try-catch-finally with 4 error-path branches (WorkflowSkipped, canceled, failed, afterRun error) inside an async for loop | Extract inner step execution into `executeStep()` returning a discriminated union; handle run-level transitions in `executeRun` |

---

## Coupling & Cohesion Issues

### 1. `SessionManager` — Too Many Responsibilities
**File**: `server/session-manager.ts`

The class currently handles: session CRUD, Claude process lifecycle, event wiring, WebSocket client tracking, approval routing, worktree creation/teardown, session archiving, and output history management. While delegates (`ApprovalManager`, `SessionNaming`, `SessionPersistence`, `DiffManager`) have been extracted, the core class still has 44 methods. The private event handlers (`onTextEvent`, `onToolActiveEvent`, etc.) are thin but the lifecycle methods (`startClaude`, `handleClaudeResult`, `handleClaudeExit`) each carry significant branching logic.

**Suggested fix**: Extract a `ClaudeSessionLifecycle` class to own `startClaude`, `wireClaudeEvents`, `handleClaudeResult`, and `handleClaudeExit`. `SessionManager` becomes a coordinator that delegates to it plus the existing delegates.

---

### 2. `ws-server.ts` — Route Registration and Business Logic Mixed
**File**: `server/ws-server.ts`

The file bootstraps the Express/WS server, registers all routers, and also embeds standalone business logic: CLI arg parsing, auth token loading, `claude` version check, update polling, orchestrator startup, cron schedule sync, and commit hook installation. This makes it hard to test the individual startup steps in isolation.

**Suggested fix**: Move startup checks into a `startup.ts` module that returns a validated configuration object; leave `ws-server.ts` as pure wiring (create server, attach routers, listen).

---

### 3. `InputBar.tsx` — Four Variant Branches With Duplicated JSX
**File**: `src/components/InputBar.tsx`

The component renders four variants (`!isMobile && !isOrchestrator`, `!isMobile && isOrchestrator`, `isMobile && !isOrchestrator`, `isMobile && isOrchestrator`) each with their own permission-mode selector, model picker, skills button, and send button. The mobile permission-mode list is duplicated from the desktop version.

**Suggested fix**: Extract `PermissionModeMenu`, `ModelMenu`, and `SendButton` atoms. The four branch blocks then assemble these atoms rather than repeating the full render tree.

---

### 4. `App.tsx` — Prop Drilling Through Content Components
**File**: `src/App.tsx`

`App.tsx` passes 25+ props to `SessionContent`, `OrchestratorContent`, and `DocsBrowserContent`. Several of these props (`token`, `isMobile`, `currentPermissionMode`, `onPermissionModeChange`, `skillGroups`, `slashCommands`) are the same for all three views.

**Suggested fix**: Introduce a `SessionContext` React context for stable cross-cutting values (`token`, `isMobile`, `settings`, `skillGroups`). Content components consume the context rather than receiving repeated props.

---

### 5. `orchestrator-routes.ts` — Stateful Dependencies as Closure Captures
**File**: `server/orchestrator-routes.ts`

`OrchestratorMemory` and `OrchestratorChildManager` are instantiated inside `createOrchestratorRouter`. This prevents sharing them with other modules and makes testing harder (no injection point).

**Suggested fix**: Accept `memory` and `children` as parameters to `createOrchestratorRouter`, constructed at the server startup level alongside the other service singletons.

---

### 6. `ClaudeProcess` — State Machine State Scattered Across Fields
**File**: `server/claude-process.ts`

State for thinking blocks (`inThinkingBlock`, `thinkingText`, `thinkingSummaryEmitted`), tool accumulation (`currentToolName`, `currentToolInput`), and plan mode deferred exit (`pendingExitPlanModeId`, `exitPlanModeDenied`) are stored as separate fields and reset/set in multiple methods. This is hard to reason about when adding new block types.

**Suggested fix**: Group related state into small inner interfaces (`ThinkingState`, `ToolState`, `PlanModeState`) with a single reset method per group.

---

## Refactoring Candidates

1. **Split `ClaudeProcess` constructor into an options object**
   - **Location**: `server/claude-process.ts:93`
   - **Problem**: 7 positional parameters are easy to mis-order. Adding an 8th (e.g., `timeoutMs`) requires updating every call site.
   - **Approach**: Introduce `interface ClaudeProcessOptions { workingDir, sessionId?, extraEnv?, model?, permissionMode?, resume?, allowedTools? }` and destructure in the constructor body.
   - **Effort**: Small

2. **Extract `SessionManager.handleClaudeResult` into two methods**
   - **Location**: `server/session-manager.ts:872`
   - **Problem**: API retry logic, noise filtering, result broadcasting, naming trigger, and listener dispatch are fused. Any change to one path risks the others.
   - **Approach**: `handleApiRetryError(session, sessionId, result)` handles the retry loop and returns early; `finalizeResult(session, sessionId, result, isError)` handles broadcast, naming, and listeners. `handleClaudeResult` calls the two in sequence.
   - **Effort**: Small

3. **Extract `InputBar.tsx` toolbar variants into sub-components**
   - **Location**: `src/components/InputBar.tsx:370–705`
   - **Problem**: ~330 lines of near-duplicate JSX for four toolbar layouts. The permission-mode list is copy-pasted between the desktop and mobile branches.
   - **Approach**: Extract `<PermissionModeDropdown>`, `<ModelDropdown>`, `<SkillsButton>`, `<SendButton>` atoms. Compose them in `<DesktopToolbar>`, `<OrchestratorToolbar>`, `<MobileToolbar>` wrappers.
   - **Effort**: Medium

4. **Introduce `SessionContext` in `App.tsx` to replace prop drilling**
   - **Location**: `src/App.tsx:522–634` (prop lists passed to content components)
   - **Problem**: Every content view receives 20–25 props, most of which are stable cross-cutting values rather than view-specific state.
   - **Approach**: Create `SessionContext` with `token`, `isMobile`, `skillGroups`, `slashCommands`, `currentPermissionMode`, `onPermissionModeChange`. Content components call `useSessionContext()` for those; `App.tsx` passes only view-specific data.
   - **Effort**: Medium

5. **Extract `ClaudeSessionLifecycle` from `SessionManager`**
   - **Location**: `server/session-manager.ts:645–1050` (Claude process methods)
   - **Problem**: `SessionManager` at 1,832 lines owns the session CRUD contract *and* the detailed Claude process wiring. Testing process lifecycle requires constructing a full `SessionManager`.
   - **Approach**: Move `startClaude`, `wireClaudeEvents`, `handleClaudeResult`, `handleClaudeExit`, and the API-retry constants into `ClaudeSessionLifecycle`. It accepts a `Session` reference and a `broadcast` callback. `SessionManager.startClaude` delegates to it.
   - **Effort**: Medium

6. **Replace `handleUserEvent` inline ExitPlanMode match with a method**
   - **Location**: `server/claude-process.ts:347–403`
   - **Problem**: 4 levels of nesting inside the `for (const block of blocks)` loop for the ExitPlanMode approval-message detection.
   - **Approach**: Extract `handleExitPlanModeToolResult(block, content, isError): void` — contains the `pendingExitPlanModeId` matching and `planning_mode` emission.
   - **Effort**: Small

7. **Inject `OrchestratorMemory` and `OrchestratorChildManager` into route factory**
   - **Location**: `server/orchestrator-routes.ts:39–40`
   - **Problem**: Singleton services constructed inside a factory function prevent sharing state across routers or easy unit testing.
   - **Approach**: Accept `memory: OrchestratorMemory` and `children: OrchestratorChildManager` as parameters; construct them once in `ws-server.ts` alongside other services.
   - **Effort**: Small

8. **Replace the three repeated outside-click `useEffect` hooks in `InputBar.tsx`**
   - **Location**: `src/components/InputBar.tsx:146–179`
   - **Problem**: Three nearly identical `useEffect` blocks each close a different dropdown on outside click. Any bug fix must be applied three times.
   - **Approach**: Extract a `useOutsideClick(ref, isOpen, onClose)` hook.
   - **Effort**: Small

9. **Group scattered thinking/tool/plan-mode state in `ClaudeProcess` into typed structs**
   - **Location**: `server/claude-process.ts:55–69`
   - **Problem**: 8 boolean/string fields across three conceptual state machines make `handleStreamEvent` hard to follow and test.
   - **Approach**: Define `thinkingState: ThinkingState`, `toolState: ToolState`, `planModeState: PlanModeState`. Encapsulate reset and update logic in each type's methods.
   - **Effort**: Medium

10. **Move `ws-server.ts` startup checks and configuration loading into `startup.ts`**
    - **Location**: `server/ws-server.ts:50–160`
    - **Problem**: ~110 lines of CLI arg parsing, auth-token loading, Claude version check, `apiKeySet` flag, and port resolution are interleaved with service and router construction, preventing independent testing.
    - **Approach**: Export `loadServerConfig(): ServerConfig` from `startup.ts` — pure function taking `process.argv` and `process.env`. `ws-server.ts` calls it once and passes the result to constructors.
    - **Effort**: Small
```Committed and pushed both report files (`2026-03-25_code-review-daily.md` and `2026-03-25_repo-health.md`) to `chore/repo-health-report-2026-03-25`.