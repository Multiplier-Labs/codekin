# Complexity Report: codekin

**Date**: 2026-04-01T04:33:42.776Z
**Repository**: /srv/repos/codekin
**Branch**: chore/repo-health-report-2026-03-30
**Workflow Run**: 3f14cbc6-21db-4293-b0d0-918cf202fa8f
**Session**: 8a8531d5-8f9c-4e2e-99d1-b4174fa5765c

---

Now I have enough information to write the complete report.Now I have sufficient data to produce the report.```markdown
## Summary

**Overall complexity rating: Medium-High**

The codebase is a ~26,000-line TypeScript monorepo split into a React/Vite frontend (`src/`) and a Node.js WebSocket server (`server/`). Both halves are generally well-structured, with clear module boundaries emerging from prior refactoring work. The server-side `SessionManager` remains a single large class at 1,954 lines — far larger than any other file and the dominant complexity hotspot. Several frontend components also accumulate multiple rendering variants and concerns in a single file. The majority of the rest of the codebase is focused and well-scoped.

| Metric | Value |
|---|---|
| Total source lines (excl. tests, worktrees) | ~26,200 |
| Largest file | `server/session-manager.ts` (1,954 lines) |
| Deepest nesting observed | ~5 levels (`requestToolApproval`, `sendPromptResponse`) |
| Most complex function | `requestToolApproval` (~140 lines, 4+ nesting levels, 3 major branches) |

---

## Largest Files

| File | Lines | Primary Responsibility | Refactor Priority |
|---|---|---|---|
| `server/session-manager.ts` | 1,954 | Session CRUD, process lifecycle, worktree management, approval routing, auto-restart, noise filtering | **High** |
| `server/workflow-engine.ts` | 746 | SQLite-backed workflow execution, cron scheduling, step lifecycle | Low (well-organized) |
| `src/components/InputBar.tsx` | 709 | Chat input, 4 rendering variants (desktop/mobile × default/orchestrator), drag-resize, file upload, slash autocomplete | Medium |
| `server/orchestrator-learning.ts` | 704 | Memory extraction, deduplication, aging, skill modeling, decision tracking | Low (well-organized) |
| `src/App.tsx` | 674 | Root component: wires ~15 hooks, session/routing/upload/UI state | Medium |
| `server/claude-process.ts` | 654 | NDJSON stream parsing, Claude CLI process management, event emission | Low–Medium |
| `server/orchestrator-routes.ts` | 612 | REST API for orchestrator: session lifecycle, reports, memory, children, skills | Low–Medium |
| `src/components/ChatView.tsx` | 602 | Chat message rendering (all message types) | Low |
| `server/ws-server.ts` | 587 | Server entry point: WebSocket + Express setup, auth, service wiring | Medium |
| `src/components/AddWorkflowModal.tsx` | 580 | Add-workflow form with validation and preview | Low |
| `server/stepflow-handler.ts` | 521 | Webhook-triggered workflow orchestration | Low–Medium |
| `src/lib/ccApi.ts` | 534 | REST API client (all server endpoints) | Low |
| `src/components/Settings.tsx` | 517 | Settings panel UI | Low |
| `src/hooks/useChatSocket.ts` | 512 | Core WebSocket hook for message processing and session state | Low–Medium |
| `server/workflow-loader.ts` | 507 | Markdown/TypeScript workflow discovery and loading | Low |

---

## Most Complex Functions

| File:Function | Estimated Complexity | Issue Description | Refactor Suggestion |
|---|---|---|---|
| `server/session-manager.ts:requestToolApproval` | High | ~140 lines, 4+ nesting levels, 3 completely distinct code paths (AskUserQuestion, ExitPlanMode, permission), inline structured-question mapping, duplicate Promise scaffold with timeout | Extract each branch into `requestQuestionApproval`, `requestPlanApproval`, `requestPermissionApproval`; share the Promise/timeout scaffold |
| `server/session-manager.ts:sendPromptResponse` | High | ~65 lines, 5 nesting levels, 4-way branch on (no requestId × pending count) × (toolApproval vs controlRequest vs fallback) — routing logic is hard to trace without a state diagram | Model the routing as an explicit decision table or extract `resolvePromptTarget(session, requestId)` returning a discriminated union |
| `server/session-manager.ts:handleClaudeResult` | Medium-High | ~80 lines, 3 nesting levels; combines API-retry back-off, noise-filter heuristics, result broadcasting, and session naming — four unrelated concerns | Split into `maybeRetryApiError`, `maybeFilterNoise`, then delegate result/naming separately |
| `src/components/InputBar.tsx:<render>` | Medium-High | 400+ line JSX block with 4 fully branched rendering variants (desktop-default, desktop-orchestrator, mobile-default, mobile-orchestrator), many `!isMobile && !isOrchestrator && (...)` ladder | Extract `<DesktopDefaultToolbar>`, `<DesktopOrchestratorToolbar>`, `<MobileDefaultToolbar>`, `<MobileOrchestratorToolbar>` sub-components |
| `server/session-manager.ts:handleClaudeExit` | Medium | ~80 lines; decision tree for stop/restart/rate-limit paths with staggered setTimeout; fallback context injection on fresh crash | Already uses `evaluateRestart()` — extract `injectCrashContext` into a standalone function |
| `src/App.tsx:App` | Medium | ~500+ lines; root component function with 15+ hooks, 6+ `useEffect`s, 10+ callbacks, and inline JSX that conditionally renders 4 major content views | Continue the existing content-extraction pattern: move inline effects into a `useAppEffects` hook; extract view-switch JSX into `<ActiveView>` |
| `server/session-manager.ts:startClaude` | Medium | ~60 lines; builds env vars, merges allowed-tools lists, selects `--resume` vs `--session-id`, wires all events — mixing configuration assembly with process startup | Extract `buildClaudeEnv(session, authToken, port)` → `Record<string,string>` and `buildAllowedTools(session, approvalManager)` → `string[]` as pure helpers |
| `server/session-manager.ts:resolveToolApproval` | Medium | ~50 lines, 3 nesting levels, 3 special-case branches (AskUserQuestion, ExitPlanMode, generic permission) | Mirror the `requestToolApproval` extraction above — one handler per tool class |
| `server/orchestrator-learning.ts:extractMemoryCandidates` | Medium | Rule-based extractor with ~8 hard-coded regex pattern groups and nested loops — brittle and hard to extend | Convert pattern groups to a static data structure (`{ type, patterns, scorer }[]`) and loop over it uniformly |
| `server/claude-process.ts:processLine` | Medium | Long `switch` on `event.type` with several nested conditions for partial-json accumulation, thinking-block detection, task tracking, and tool lifecycle | Already reasonably structured; consider extracting `handleToolEvent`, `handleThinkingEvent`, `handleTodoEvent` to reduce the switch arm length |

---

## Coupling & Cohesion Issues

### 1. `SessionManager` — God Class Residue

Despite prior delegations (ApprovalManager, SessionNaming, SessionPersistence, DiffManager), `SessionManager` still owns: session CRUD, Claude process lifecycle and event wiring, worktree Git operations, tool approval routing (two separate approval paths — hook and control-request), API-error retry, session noise filtering, session context injection after crash, plan-mode approval, and PlanManager event wiring. Any change to any approval flow, restart logic, or worktree behavior touches this one 1,954-line file.

**Suggested fix:** Extract a `ToolApprovalRouter` class to own both `requestToolApproval` and `sendPromptResponse` (and their helpers `resolveToolApproval`, `handleExitPlanModeApproval`, etc.). Extract a `ClaudeLifecycleHandler` for `startClaude`, `wireClaudeEvents`, `handleClaudeResult`, `handleClaudeExit`. `SessionManager` then becomes a thin coordinator.

---

### 2. `InputBar.tsx` — Four Components in One

A single 709-line component renders four distinct toolbar layouts via nested `!isMobile && !isOrchestrator` / `isMobile && isOrchestrator` guards. The `variant` prop ("default" vs "orchestrator") and `isMobile` prop together produce a 2×2 rendering matrix, but they are expressed as interleaved JSX branches rather than separate subcomponents. This forces readers to track both dimensions simultaneously.

**Suggested fix:** Introduce a `<ToolbarRow variant isMobile ... />` subcomponent that renders only the toolbar section; its four implementations can be four small components inside the same file, keeping the outer `InputBar` focused on textarea state and event handling.

---

### 3. `ws-server.ts` — Auth Logic Defined Inline at Module Level

`verifyToken`, `verifyTokenOrSessionToken`, and `extractToken` are plain functions defined at the module level of `ws-server.ts` rather than imported from a dedicated auth module. All route factories (`createSessionRouter`, `createWebhookRouter`, etc.) receive these functions as parameters, meaning a 3-function auth "interface" is threaded through 7+ call sites. When auth logic needs to change (e.g. adding JWT), there is no single file to edit.

**Suggested fix:** Create `server/auth-middleware.ts` exporting `makeAuthMiddleware(authToken)` returning the three verifier functions as a typed object. Route factories accept `AuthContext` by type.

---

### 4. `orchestrator-routes.ts` — Deep Import from `orchestrator-learning.ts`

`orchestrator-routes.ts` imports 10 named symbols directly from `orchestrator-learning.ts` (`extractMemoryCandidates`, `smartUpsert`, `runAgingCycle`, `recordFindingOutcome`, `getTriageRecommendation`, `loadSkillProfile`, `updateSkillLevel`, `getGuidanceStyle`, `recordDecision`, `assessDecisionOutcome`, `getPendingOutcomeAssessments`). All of these are invoked inline inside route handlers rather than behind a service facade, meaning the route file has intimate knowledge of learning internals.

**Suggested fix:** Introduce an `OrchestratorLearning` class (or a `createLearningService()` factory) that exposes a higher-level API (`extractAndStore`, `runMaintenance`, `getGuidance`, etc.). Route handlers then call the facade — not the raw functions.

---

### 5. `src/App.tsx` — Root Component as Wiring Hub

`App` imports 15+ hooks, 10+ components, and wires them together with 6+ `useEffect`s and 10+ `useCallback`s. Although the content views are properly extracted into `SessionContent`, `OrchestratorContent`, and `DocsBrowserContent`, the wiring — especially the cross-cutting concerns (page visibility, keyboard shortcuts, sendInputRef sync, queueEnabled fetch, agentName fetch, permissionModeRef sync, error auto-dismiss) — is co-located with the JSX. This makes both the component and each individual concern harder to test in isolation.

**Suggested fix:** Continue the established pattern: bundle the side-effect-only `useEffect`s into a `useAppSideEffects(...)` hook; the keyboard-shortcut handler into `useAppKeyBindings(...)`; and the cross-session ref sync into wherever those refs are defined.

---

## Refactoring Candidates

1. **Extract `ToolApprovalRouter` from `SessionManager`**
   - **Location:** `server/session-manager.ts` lines ~1130–1523
   - **Problem:** `requestToolApproval`, `sendPromptResponse`, `resolveToolApproval`, `handleAskUserQuestion`, `handleExitPlanModeApproval`, `sendControlResponseForRequest`, `decodeApprovalValue` are 400+ lines handling two entirely separate approval paths. Changes to one path risk breaking the other, and unit-testing requires constructing a full `SessionManager`.
   - **Approach:** Create `server/tool-approval-router.ts` with a `ToolApprovalRouter` class; inject `sessions`, `approvalManager`, `broadcast`, `globalBroadcast`, `promptListeners` via constructor. `SessionManager` calls `this.approvalRouter.requestApproval(...)` and `this.approvalRouter.handleResponse(...)`.
   - **Effort:** Medium

2. **Split `InputBar.tsx` toolbar rendering into subcomponents**
   - **Location:** `src/components/InputBar.tsx` lines ~370–706 (entire return body toolbar section)
   - **Problem:** Four rendering variants expressed as interleaved conditional blocks make the component 709 lines and hard to modify one variant without accidentally disturbing the others.
   - **Approach:** Extract `DesktopDefaultToolbar`, `DesktopOrchestratorToolbar`, `MobileDefaultToolbar`, `MobileOrchestratorToolbar` as file-local functional components. The outer `InputBar` renders `{getToolbar(isMobile, isOrchestrator, props)}`.
   - **Effort:** Small

3. **Extract Claude process lifecycle helpers from `SessionManager`**
   - **Location:** `server/session-manager.ts:startClaude`, `wireClaudeEvents`, `handleClaudeResult`, `handleClaudeExit`, `buildSessionContext`, `buildCrashContext`
   - **Problem:** Process startup, event-wiring, result handling, and restart logic are ~300 lines embedded in `SessionManager`. They depend on `SessionManager` private state, but have no dependency on session CRUD or storage.
   - **Approach:** Create a `ClaudeSessionLifecycle` helper class that receives a `Session` reference and callbacks for broadcast/globalBroadcast; `SessionManager` instantiates it per-session on `startClaude`.
   - **Effort:** Medium

4. **Introduce an `OrchestratorLearning` service facade**
   - **Location:** `server/orchestrator-routes.ts` imports + `server/orchestrator-learning.ts`
   - **Problem:** Route handlers call 10+ raw functions from the learning module directly, creating tight coupling and making routes dependent on learning internals.
   - **Approach:** Add a class `OrchestratorLearningService` wrapping the 11 exported functions into 4–5 higher-level methods. `orchestrator-routes.ts` receives an instance and calls only those.
   - **Effort:** Small

5. **Move inline auth functions in `ws-server.ts` to a dedicated module**
   - **Location:** `server/ws-server.ts` lines ~76–108 (`verifyToken`, `verifyTokenOrSessionToken`, `extractToken`)
   - **Problem:** Auth is defined inline at the module level, threaded through 7+ route factory calls as loose function arguments, and duplicated in the type-aliases at the top of `orchestrator-routes.ts`.
   - **Approach:** Create `server/auth.ts` exporting `makeAuthContext(authToken: string): AuthContext` where `AuthContext = { verifyToken, verifyTokenOrSessionToken, extractToken }`. All route factories accept `AuthContext`.
   - **Effort:** Small

6. **Consolidate `sendPromptResponse` routing into a typed decision table**
   - **Location:** `server/session-manager.ts:sendPromptResponse` lines ~1128–1193
   - **Problem:** Routing logic for prompt responses spans 5 nesting levels with implicit fallthrough cases; adding a third approval path would require reading the full function to find safe insertion points.
   - **Approach:** Define `type PromptTarget = { kind: 'tool_approval'; approval } | { kind: 'control_request'; pending } | { kind: 'fallback' }` and extract `resolvePromptTarget(session, requestId): PromptTarget` as a pure function. `sendPromptResponse` then becomes a flat `switch` over the discriminated union.
   - **Effort:** Small

7. **Extract `App.tsx` side-effects and keyboard bindings into focused hooks**
   - **Location:** `src/App.tsx` `useEffect` blocks at lines ~88–100, ~103–106, ~188–190, ~294–313
   - **Problem:** Six `useEffect`s in the root component make the component long and make it hard to reason about individual side-effect lifecycles (visibility, agentName, worktree ref sync, keyboard shortcuts, error timer).
   - **Approach:** Create `useAppEffects` for the server-fetch effects; `useAppKeyBindings` for keyboard shortcuts. The component body shrinks to hook calls + JSX.
   - **Effort:** Small

8. **Convert `extractMemoryCandidates` pattern groups to a data structure**
   - **Location:** `server/orchestrator-learning.ts:extractMemoryCandidates` (~lines 92–200)
   - **Problem:** 8 hard-coded `if`-blocks with inline regex arrays for preference/decision/finding/repo-context extraction. Adding a new memory category requires understanding the full function.
   - **Approach:** Define a `const EXTRACTION_RULES: ExtractionRule[]` array at module level; each rule has `{ memoryType, patterns, scorer, scope }`. The function body becomes a loop over rules.
   - **Effort:** Small

9. **Extract `list()` / `listAll()` duplication in `SessionManager`**
   - **Location:** `server/session-manager.ts:list` and `listAll` lines ~455–488
   - **Problem:** `list()` and `listAll()` are identical except for a filter on `source !== 'orchestrator'`. The mapping lambda is duplicated verbatim.
   - **Approach:** Extract `private toSessionInfo(s: Session): SessionInfo` and implement `list()` as `this.listAll().filter(...)`.
   - **Effort:** Small (already very small, but a clear inconsistency)

10. **Extract `handleAskUserQuestion` JSON-parsing into a named helper**
    - **Location:** `server/session-manager.ts:handleAskUserQuestion` lines ~1262–1292
    - **Problem:** The function mixes answer-mapping logic (JSON parse → map to questions → array join fallback) with the control-response dispatch. The parsing has 3 nesting levels and try/catch that makes the happy path non-obvious.
    - **Approach:** Extract `parseAnswerMap(value: string | string[], questions): Record<string, string>` as a pure, fully testable function. `handleAskUserQuestion` becomes a one-liner that calls it and dispatches.
    - **Effort:** Small
```