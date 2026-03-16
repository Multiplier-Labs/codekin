# Complexity Report: codekin

**Date**: 2026-03-18T05:34:17.677Z
**Repository**: /srv/repos/codekin
**Branch**: chore/repo-health-report-2026-03-18
**Workflow Run**: f4e67d7b-ad82-40fd-9fdd-44b8671711ac
**Session**: 596e30bc-2c56-4213-9600-8c164bd4ad18

---

Now I have enough information to produce the report.I now have sufficient data to write the report. Let me compose it.```markdown
## Summary

**Overall Complexity Rating: Medium**

The codekin codebase is well-decomposed overall — the server team has already broken out `ApprovalManager`, `SessionNaming`, `SessionPersistence`, `DiffManager`, and `SessionRestartScheduler` from what was once a single god-class. Despite that, `session-manager.ts` remains the dominant complexity hotspot (1,593 lines, 55+ methods, 180+ control-flow branches). Frontend complexity is spread across `App.tsx` (752 lines) and `InputBar.tsx` (701 lines), both of which carry too many concerns for single files. The codebase totals ~28,000 source lines (excluding tests) across 725 files.

| Metric | Value |
|---|---|
| Largest file (non-test) | `server/session-manager.ts` — 1,593 lines |
| Most branching (non-test) | `server/session-manager.ts` — ~180 if/switch/for statements |
| Most complex single function | `SessionManager.sendPromptResponse` — multi-path approval routing |
| Deepest nesting | `session-manager.ts: sendPromptResponse` — 5–6 levels |
| Most coupled module | `SessionManager` — imported by 12 server modules |
| Most props on a component | `InputBar` — 19 props |

---

## Largest Files

| File | Lines | Primary Responsibility | Refactor Priority |
|---|---|---|---|
| `server/session-manager.ts` | 1,593 | Session lifecycle, Claude process wiring, approvals, retry, stall detection, naming, worktrees | **High** |
| `src/App.tsx` | 752 | Root component — wires all hooks, routes views, renders full layout | **High** |
| `server/shepherd-learning.ts` | 704 | Memory extraction, deduplication, aging, skill model, decision history | Medium |
| `src/components/InputBar.tsx` | 701 | Chat textarea, toolbar, slash autocomplete, file attach, permission menu | Medium |
| `server/workflow-engine.ts` | 669 | Workflow/step execution, cron scheduling, SQLite persistence | Medium |
| `server/claude-process.ts` | 651 | Claude CLI child process, NDJSON parsing, event emission | Low |
| `src/components/AddWorkflowModal.tsx` | 580 | Workflow creation/editing form | Low |
| `server/ws-server.ts` | 555 | Express app setup, WebSocket server, route registration | Medium |
| `server/stepflow-handler.ts` | 521 | Stepflow webhook integration and session orchestration | Low |
| `src/hooks/useChatSocket.ts` | 512 | WS session management, message processing, state | Medium |
| `src/lib/ccApi.ts` | 508 | All REST API calls, auth redirect logic | Low |
| `server/workflow-loader.ts` | 507 | Markdown workflow loading, session orchestration for each step | Low |
| `server/approval-manager.ts` | 503 | Per-repo approval rules, pattern matching, cross-repo propagation | Low |
| `server/shepherd-routes.ts` | 497 | Shepherd REST API routes | Low |
| `src/components/LeftSidebar.tsx` | 486 | Sidebar tree — sessions, repos, docs, modals | Low |

---

## Most Complex Functions

| File:Function | Estimated Complexity | Issue Description | Refactor Suggestion |
|---|---|---|---|
| `server/session-manager.ts:sendPromptResponse` | High | Routes prompt responses across two separate approval systems (PreToolUse hooks vs. control_requests) with 5–6 levels of nesting and 6+ conditional branches | Extract into `resolveHookApprovalResponse` and `resolveControlRequestResponse` helpers |
| `server/session-manager.ts:requestToolApproval` | High | Builds prompt, stores pending approval, handles clientless sessions, fires global broadcast — all in one 80-line function | Split into `buildApprovalPrompt()` and `emitPendingApproval()` |
| `server/session-manager.ts:handleClaudeResult` | Medium-High | API retry logic nested inside a result handler; mixes retry state management with session naming logic | Extract `handleApiRetry(session, result)` as a separate private method |
| `server/session-manager.ts:wireClaudeEvents` | Medium | 15 event bindings each delegating to a private handler — acts as a routing table | Already extracted well; consider grouping event bindings by concern (I/O, tool, lifecycle) |
| `server/session-manager.ts:buildSessionContext` | Medium | Reconstructs a text transcript from WsServerMessage history with duplicate flush logic for `assistantText` | Refactor to a pure utility function in a separate `session-context.ts` module |
| `server/approval-manager.ts:checkRepoApproval` | Medium | Three-layer check (tools → exact commands → patterns) with separate cross-repo lookup; hard to test in isolation | Already well-structured; add early-return guards to reduce nesting |
| `src/App.tsx:App` (component) | High | 750-line single-component root: 12+ hooks, 15+ callbacks, 6 views, 10 useEffects | Extract view components (`ShepherdLayout`, `DocsBrowserLayout`, `ChatLayout`) and a `useAppCallbacks` hook |
| `src/components/InputBar.tsx:InputBar` | Medium-High | 19 props, 5 popup states, drag-resize logic, slash autocomplete, file handling, mobile layout — all in one component | Extract `InputBarToolbar` (model/perm/skill menus) and `SlashCommandInput` as separate components |
| `server/workflow-engine.ts:executeRun` | Medium | Orchestrates multi-step execution with per-step abort signals, status updates, and afterRun cleanup — hard to follow error paths | Steps are relatively clean; add inline comments for abort-signal interaction |
| `server/claude-process.ts:handleUserEvent` | Medium | Extracts tool results from user events with inline content-block parsing and image extraction logic; two nested for-loops | Extract `extractToolResultContent(block)` to reduce nesting |

---

## Coupling & Cohesion Issues

### 1. `SessionManager` as a Central God Class

**Modules affected:** `ws-server.ts`, `session-routes.ts`, `webhook-handler.ts`, `stepflow-handler.ts`, `workflow-loader.ts`, `shepherd-*.ts`, `ws-message-handler.ts` (12 consumers total)

**Issue:** Despite good extraction of `ApprovalManager`, `SessionNaming`, and `SessionPersistence`, `SessionManager` still exposes 55+ methods including `requestToolApproval`, `sendPromptResponse`, `startClaude`, `setModel`, `getDiff`, `createWorktree`, and `restoreActiveSessions`. It manages four orthogonal concerns: session CRUD, Claude process lifecycle, tool approval UX, and git operations. Any caller change risks touching unrelated behaviour.

**Suggested fix:** Introduce a facade interface `ISessionBus` (emitting events) that consumers subscribe to, reducing the shared method surface. Extract `WorktreeManager` and `ToolApprovalGate` as separate classes injected into `SessionManager` rather than inlined.

---

### 2. `App.tsx` Acts as an Application Orchestrator

**Issue:** `App.tsx` imports 31 modules (11 hooks, 14 components, 6 utilities), wires their interactions inline, and renders all four views (`chat`, `shepherd`, `workflows`, `docs`). State that belongs to each view leaks into the parent: `hasFileChanges`, `diffPanelOpen`, `archiveRefreshKey`, `pendingContextRef`, `shepherdSessionRef`. The result is a 750-line component that is difficult to test and slow to scan.

**Suggested fix:** Extract `<ChatLayout>`, `<ShepherdLayout>`, and `<DocsBrowserLayout>` view components. Move view-specific state into each. Let `App.tsx` only handle routing between views and global singletons (settings, token, connState).

---

### 3. Approval Logic Duplicated Between `onControlRequestEvent` and `requestToolApproval`

**Modules affected:** `session-manager.ts` lines 688–736 and 1095–1172

**Issue:** Both methods construct an identical `promptMsg` object (`type: 'prompt'`, `promptType: 'permission'`, `options`, `toolName`, `toolInput`, `requestId`). The broadcast-or-wait-for-client logic is also copy-pasted. If a field is added to the prompt message type, it must be updated in two places.

**Suggested fix:** Extract `buildPermissionPrompt(toolName, toolInput, requestId, opts)` returning the `WsServerMessage` object, and `broadcastOrGlobalNotify(session, promptMsg)` to eliminate the duplication.

---

### 4. `shepherd-learning.ts` Mixes Five Concerns in One Module

**Issue:** Memory extraction, deduplication, aging/decay, user skill modeling, and decision history are all in a single 704-line file. Each concern has its own distinct data types, algorithms, and external dependencies. The only shared element is the `ShepherdMemory` parameter — they are not cohesive.

**Suggested fix:** Split into `shepherd-extraction.ts`, `shepherd-aging.ts`, `shepherd-skill-model.ts`, `shepherd-decisions.ts`. Each would be under 200 lines and independently testable.

---

### 5. `ccApi.ts` Contains Both Domain Logic and Auth Redirect Side Effects

**Issue:** `redirectToLogin()` and `checkAuthResponse()` are stateful side-effectful functions embedded in an otherwise pure HTTP-call module. The `redirecting` module-level boolean makes `ccApi.ts` hard to unit-test and implicitly couples the auth state machine to the HTTP client.

**Suggested fix:** Extract auth state to a dedicated `authSession.ts` module; import it from `ccApi.ts` rather than inlining it.

---

## Refactoring Candidates

**1. Split `session-manager.ts` — extract `ToolApprovalGate`**

- **Location:** `server/session-manager.ts` lines 688–1172
- **Problem:** Two parallel approval paths (`pendingToolApprovals` / `pendingControlRequests`) with duplicated prompt-building and broadcast logic. The approval state machine (pending → resolved/timed-out) spans ~500 lines.
- **Approach:** Create `server/tool-approval-gate.ts` holding both maps, `requestApproval()`, `resolveApproval()`, `sendControlApproval()`, timeout management, and the shared `buildPermissionPrompt()` helper. `SessionManager` delegates to it.
- **Effort:** Medium

---

**2. Split `src/App.tsx` — extract view layout components**

- **Location:** `src/App.tsx` lines 510–714 (view rendering)
- **Problem:** All four view layouts (chat, shepherd, docs, workflows) render inline in `App.tsx` with their state and callbacks entangled. Adding a fifth view requires touching an already-large file.
- **Approach:** Create `src/layouts/ChatLayout.tsx`, `src/layouts/ShepherdLayout.tsx`, `src/layouts/DocsBrowserLayout.tsx`. Move their props/state down. `App.tsx` becomes a router and global-state provider only.
- **Effort:** Medium

---

**3. Split `InputBar.tsx` — extract `InputBarToolbar`**

- **Location:** `src/components/InputBar.tsx`
- **Problem:** The toolbar (model selector, permission mode picker, skill menu, worktree toggle, mobile overflow menu) is a complex sub-component with its own popup state, refs, and close-all logic embedded inside `InputBar`. With 19 props and 5 popup states, the component is hard to reason about.
- **Approach:** Extract `<InputBarToolbar>` accepting only toolbar-specific props. Keep `InputBar` focused on textarea, height drag, file attachment, and slash autocomplete.
- **Effort:** Small

---

**4. Split `shepherd-learning.ts` into domain-focused modules**

- **Location:** `server/shepherd-learning.ts`
- **Problem:** Five unrelated concerns in one file. Each one changes for different reasons (extraction heuristics change independently of aging TTLs, for instance).
- **Approach:** Split into `shepherd-extraction.ts`, `shepherd-aging.ts`, `shepherd-skill-model.ts`, `shepherd-decisions.ts`. Update imports in `shepherd-routes.ts` and `shepherd-monitor.ts`.
- **Effort:** Small

---

**5. Extract `buildSessionContext` to a pure utility module**

- **Location:** `server/session-manager.ts:1312–1372`
- **Problem:** This function builds a text transcript from `WsServerMessage[]` history. It is pure (no side effects, no `this` references) but lives inside the `SessionManager` class. It duplicates the `assistantText` flush pattern twice.
- **Approach:** Move to `server/session-context-builder.ts` as an exported pure function `buildSessionContext(history: WsServerMessage[]): string | null`. Easy to unit-test in isolation.
- **Effort:** Small

---

**6. Deduplicate permission prompt construction**

- **Location:** `server/session-manager.ts:onControlRequestEvent` (line 710) and `requestToolApproval` (line 1140)
- **Problem:** Identical `promptMsg` objects and broadcast-or-global-notify logic are copy-pasted in two methods, creating a drift risk when `WsServerMessage` prompt fields change.
- **Approach:** Extract `buildPermissionPrompt(toolName, toolInput, requestId, approvePattern?)` → `WsServerMessage` and `broadcastOrGlobalNotify(session, msg, sessionId?)` → `void` as private helpers.
- **Effort:** Small

---

**7. Decouple auth redirect side effects from `ccApi.ts`**

- **Location:** `src/lib/ccApi.ts:26–51`
- **Problem:** Module-level `redirecting` flag and `redirectToLogin()` create hidden side effects inside an HTTP client module. Every import of `ccApi.ts` transitively depends on the auth redirect state.
- **Approach:** Move `redirecting`, `redirectToLogin()`, and `checkAuthResponse()` to `src/lib/authSession.ts`. Import from there in `ccApi.ts`.
- **Effort:** Small

---

**8. Introduce interface segregation for `SessionManager` consumers**

- **Location:** `server/session-manager.ts` (class definition)
- **Problem:** All 12 consumer modules import the full `SessionManager` type, coupling them to methods they never use. `webhook-handler.ts` only needs `create`/`startClaude`/`list`; `shepherd-monitor.ts` only needs `list`/`sendInput`.
- **Approach:** Define narrow interfaces (e.g. `ISessionCreator`, `ISessionReader`) in `server/session-types.ts`. Consumer modules accept these interfaces rather than the concrete class.
- **Effort:** Medium
```## Summary

**Overall Complexity Rating: Medium**

The codebase (~28,000 source lines across 725 files) is generally well-structured with good prior decomposition. The dominant hotspot is `server/session-manager.ts` (1,593 lines, 55+ methods, 180+ branching statements, imported by 12 modules). Frontend complexity concentrates in `App.tsx` (752 lines, 31 imports, 4 inlined view layouts) and `InputBar.tsx` (701 lines, 19 props).

Key findings:

- **`SessionManager`** remains a partial god class despite good prior splits — the approval system alone spans ~500 lines across two parallel paths with duplicated prompt-building logic
- **`App.tsx`** inlines all four view layouts with interleaved state, making it hard to test or extend
- **`shepherd-learning.ts`** bundles five unrelated concerns (extraction, aging, skills, decisions, deduplication) in one file
- **Top 8 refactoring candidates** are documented in the report, all rated small–medium effort with clear extraction paths

Report saved to `.codekin/reports/complexity/2026-03-18_complexity-analysis.md`.