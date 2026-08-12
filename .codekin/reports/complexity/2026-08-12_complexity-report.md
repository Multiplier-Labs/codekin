# Complexity Report: codekin

**Date**: 2026-08-12T04:33:47.967Z
**Repository**: /srv/repos/Multiplier-Labs/codekin
**Branch**: main
**Workflow Run**: 91a7426c-9197-46bd-ac4a-c74c5807c676
**Session**: ac1d394e-3ad0-4ae4-841c-b9d178643107

---

## Summary

**Overall Complexity Rating: Medium-High**

The codebase is a mature, well-structured TypeScript monorepo (207 production files, ~91k LOC including tests). Architecture is largely sound — `SessionManager` was already refactored into focused sub-modules (`SessionLifecycle`, `PromptRouter`, `ApprovalManager`, etc.). The main complexity concerns cluster around a few very large files, three near-duplicate process adapters, and a classic god-component in `App.tsx`.

| Metric | Value |
|---|---|
| Largest file | `server/opencode-process.ts` (1,838 lines) |
| Deepest nesting | `handleSSEEvent` — 5–6 levels in the `message.part.delta` branch |
| Most complex function | `OpenCodeProcess.handleSSEEvent` (~304 lines, 8 cases, nested state machines) |
| Most overloaded module | `server/ws-server.ts` (41 imports, wires all subsystems) |
| Largest frontend component | `src/App.tsx` (911 lines, 18 state variables, 71 hook calls) |

---

## Largest Files

| File | Lines | Primary Responsibility | Refactor Priority |
|---|---|---|---|
| `server/opencode-process.ts` | 1,838 | OpenCode HTTP/SSE adapter + server singleton + streaming delta routing | **High** |
| `server/session-manager.ts` | 1,833 | Session CRUD, worktree management, API retry, rate limiting, context building | Medium |
| `server/workflow-engine.ts` | 1,028 | SQLite-backed workflow executor + step runner + cron scheduler | Low |
| `src/components/Settings.tsx` | 979 | Auth, preferences, permissions, webhook, approval sections — all in one modal | **High** |
| `src/hooks/useChatSocket.hook.test.ts` | 986 | Test file — no refactor needed | — |
| `src/components/InputBar.tsx` | 926 | Composer textarea + slash autocomplete + skill menu + toolbar controls | Medium |
| `src/App.tsx` | 911 | Root orchestrator: routing, all session state, model sync, UI coordination | **High** |
| `server/codex-process.ts` | 893 | Codex JSON-RPC adapter (near-duplicate of claude/opencode patterns) | Medium |
| `server/claude-process.ts` | 892 | Claude CLI NDJSON adapter | Medium |
| `server/orchestrator-children.ts` | 813 | Spawns/monitors orchestrator child sessions | Low |
| `server/prompt-router.ts` | 771 | Tool approval + control request routing | Low |
| `server/workflow-loader.ts` | 711 | MD workflow definition loading + 4-step executor | Low |
| `server/webhook-handler.ts` | 702 | GitHub webhook CI triage + PR review dispatch | Low |
| `server/orchestrator-learning.ts` | 696 | Memory extraction, deduplication, aging, skill modeling | Low |
| `server/session-routes.ts` | 662 | REST routes: session CRUD + settings + hook endpoints (mixed concerns) | Medium |

---

## Most Complex Functions

| File:Function | Est. Complexity | Issue Description | Refactor Suggestion |
|---|---|---|---|
| `server/opencode-process.ts:985` `handleSSEEvent` | Very High (CC ~18) | 304-line switch with 12 cases, nested switches, 5–6 levels of `if` chains, multiple early-return paths, and inline state machine transitions | Extract each `case` into a private handler method (`handleDeltaEvent`, `handlePartUpdated`, `handleSessionStatus`, etc.) |
| `server/opencode-process.ts:1583` `sendMessage` | High (CC ~12) | 181-line method handles attachment parsing, slash-command routing, `/compact`, model splitting, plan-mode selection, and fire-and-forget HTTP — all inline | Extract `parseAttachments()`, `routeSlashCommand()`, `buildPromptBody()` as private helpers |
| `server/opencode-process.ts:613` `subscribeToEvents` | High (CC ~10) | 111-line method nests an async SSE reader loop, reconnect backoff logic, and a delta parser — all inside one closure | Extract `readSseStream()` and the reconnect scheduler as separate private methods |
| `server/session-manager.ts:445` `createWorktree` | High (CC ~10) | 127-line async method with 4+ levels of try/catch nesting, multiple git shell calls, worktree existence checks, and session field mutation | Extract `resolveRepoRoot()`, `prepareWorktreePath()`, and `migrateSessionData()` as private helpers |
| `server/session-manager.ts:861` `leave` | Medium-High (CC ~8) | 60-line method with nested timer callback containing four distinct concern blocks (agent-session guard, control-request deny, tool-approval deny, history logging) | Extract the grace-period callback body into `autoDenyOnLastClientLeft()` |
| `server/opencode-process.ts:506` `initialize` | Medium (CC ~7) | 84-line async method mixing session creation, PATCH for permission update, SSE subscription, command loading, and `system_init` emit | Already structured linearly — add early-return helpers; extract `resumeSession()` and `createNewSession()` |
| `server/session-manager.ts:1266` `sendInput` | Medium (CC ~7) | 70-line method with three labeled phases, a pending-handoff branch, and wait-for-ready async path | Extract the "determine message content" block (`buildMessageContent()`) |
| `src/App.tsx:58` `App` (render) | High | 18 local state variables + 71 hook calls in one component; localStorage scattered across 13 call sites; 280-line JSX return | Extract `useAppState()` mega-hook or split into `SessionStateProvider` + `UIStateProvider`; move localStorage into a `useLocalStorage` abstraction |
| `src/components/Settings.tsx:1` `Settings` | Medium-High | 979-line component with 5 distinct sections each making independent API calls + local state | Split into `AuthSection`, `PreferencesSection`, `PermissionsSection`, `WebhooksSection` — each manages its own fetch lifecycle |
| `server/session-manager.ts:162` `constructor` | Medium (CC ~5) | 56-line constructor wires 12 delegate closures, some with `get` accessors capturing `this` to avoid closure staleness — unusual pattern | The `get` accessor workaround (lines 186–188) indicates the `SessionLifecycle` dependency interface is over-wide; narrow it |

---

## Coupling & Cohesion Issues

**1. Three near-duplicate process adapters (`claude-process.ts`, `codex-process.ts`, `opencode-process.ts`)**
- `handleTaskTool` + `syncTaskSeq` are copy-pasted verbatim across all three files (verified at `claude-process.ts:652`, `codex-process.ts:1500`, `opencode-process.ts:1500`).
- Attachment parsing logic (`resolveAttachmentPath`, `readFileSync`, `fileMimeMap`, binary-probe heuristic) is duplicated between `codex-process.ts` and `opencode-process.ts`.
- User-echo stripping (`lastUserInput.startsWith`) appears in four places inside `opencode-process.ts` alone.
- **Fix**: Extract a `ProcessBase` abstract class or `processUtils.ts` with `handleTaskTool()`, `syncTaskSeq()`, `parseAttachments()`, and `stripUserEchoPrefix()` shared utilities.

**2. `opencode-process.ts` hosts a mutable module-level singleton (`serverState`)**
- `serverState` is a global `const` holding process handle, port, password, and readiness — mutated by multiple async paths. Any `OpenCodeProcess` instance shares and races on this state.
- **Fix**: Extract `OpenCodeServerManager` as a proper class (or at minimum move `serverState` inside a module-scoped closure with an explicit interface), making testability and multi-server scenarios possible.

**3. `ws-server.ts` is an orchestration god-module (41 imports)**
- Wires WebSocket server, REST router mounting, webhook init, workflow engine, orchestrator, commit hooks, update checks, and CORS — all in one 724-line file.
- **Fix**: Extract startup sequencing into a `ServerBootstrapper` class; ws-server.ts should only call `bootstrapper.start()` and register cleanup handlers.

**4. `session-routes.ts` mixes session CRUD, settings, and hook endpoints (29 routes)**
- Routes for `/api/session/:id`, `/api/settings/*`, `/api/hook/*`, and `/api/repos` all live in one router factory.
- **Fix**: Split into `session-crud-routes.ts`, `settings-routes.ts`, and `hook-routes.ts` — each already exists as a concept in the codebase (`auth-routes.ts`, `webhook-routes.ts` show the pattern).

**5. `src/App.tsx` scatters `localStorage` across 13 call sites**
- `localStorage.getItem`/`setItem` for `codekin-active-session`, `codekin-use-worktree`, `claude-permission-mode`, `codekin-provider`, `opencode-model`, `codex-model` are inline with business logic.
- **Fix**: Extract a `useLocalStorage<T>(key, default)` hook and use it at each declaration site; this also makes state persistence testable.

---

## Refactoring Candidates

**1. Extract `processUtils.ts` for shared process-adapter logic**
- **Location**: `server/claude-process.ts`, `server/codex-process.ts`, `server/opencode-process.ts`
- **Problem**: `handleTaskTool`, `syncTaskSeq`, and attachment parsing are copy-pasted across all three files. A bug fix or new task status must be applied three times.
- **Suggested approach**: Create `server/process-utils.ts` exporting `createTaskHandler()` (returns a self-contained `{handleTaskTool, syncTaskSeq, seedTasks}` closure over a `Map`) and `parseAttachments()`. Each process class composes these rather than re-implementing them.
- **Effort**: Medium — requires careful interface extraction, but logic is already isolated.

**2. Split `OpenCodeProcess.handleSSEEvent` into per-event handlers**
- **Location**: `server/opencode-process.ts:985`
- **Problem**: 304-line switch statement is the largest single function in the codebase. Adding or debugging an event type requires navigating hundreds of lines.
- **Suggested approach**: Move each `case` to a private method (`#onMessagePartDelta`, `#onMessagePartUpdated`, `#onSessionStatus`, `#onPermissionAsked`, `#onMessageUpdated`). The switch becomes a 20-line dispatcher.
- **Effort**: Medium — pure mechanical extraction, no behavior change.

**3. Extract `opencode-process.ts` server singleton into `OpenCodeServerManager`**
- **Location**: `server/opencode-process.ts:124–352` (`serverState`, `ensureOpenCodeServer`, `startOpenCodeServer`, `authHeaders`, `stopOpenCodeServer`)
- **Problem**: Module-level mutable global state makes multi-server testing impossible and creates implicit coupling between all `OpenCodeProcess` instances.
- **Suggested approach**: Create `server/opencode-server-manager.ts` with a `OpenCodeServerManager` class; export a default singleton instance. `OpenCodeProcess` receives it via constructor injection (or imports the singleton), enabling stub injection in tests.
- **Effort**: Medium — no behavior change, but requires updating imports in `opencode-process.ts` and `session-routes.ts`.

**4. Split `src/App.tsx` state into domain hooks**
- **Location**: `src/App.tsx:58–630`
- **Problem**: 18 `useState` variables, 71 hook calls, and `localStorage` access are co-located in the root component. Any state change triggers broad re-render evaluation; adding a feature requires reading the full file.
- **Suggested approach**: Extract `useSessionUIState()` (active session, diff panel, archive refresh, file changes), `useAppPreferences()` (worktree, queue, permission mode, provider, model), and `useLockedNavState()` (view, mobile menu, palette, settings). Each hook encapsulates its `localStorage` calls.
- **Effort**: Large — high test value, but many downstream props threads to update.

**5. Split `src/components/Settings.tsx` into section components**
- **Location**: `src/components/Settings.tsx`
- **Problem**: 979 lines; each of the 5 `SectionCard` blocks (`Authentication`, `Preferences`, `Permissions`, `GitHub Webhooks`, and the implicit approval block) manages its own fetch state and is independently testable.
- **Suggested approach**: Create `settings/AuthSection.tsx`, `settings/PreferencesSection.tsx`, `settings/PermissionsSection.tsx`, `settings/WebhooksSection.tsx`. Each owns its API calls and local state; `Settings.tsx` becomes a layout shell.
- **Effort**: Medium — mostly mechanical, reduces render surface area and makes each section independently reviewable.

**6. Extract `session-routes.ts` into three focused routers**
- **Location**: `server/session-routes.ts`
- **Problem**: 29 routes across three conceptual domains (session lifecycle, server settings, hook/approval endpoints) in a single 662-line file. Any contributor touching session creation must navigate webhook-setup and hook logic.
- **Suggested approach**: Create `server/settings-routes.ts` (model, retention, repos path, worktree prefix, queue messages, agent name, approval rules) and `server/hook-routes.ts` (`/api/hook/*`, `/api/tool-approval/*`). `session-routes.ts` retains only session CRUD and diff routes.
- **Effort**: Small — routers are already factory functions; extraction is straightforward.

**7. Consolidate `sendMessage` attachment handling into a shared utility**
- **Location**: `server/opencode-process.ts:1619–1666`, `server/codex-process.ts` (similar block)
- **Problem**: The `[Attached files: ...]` prefix parsing, MIME-type mapping, binary-probe heuristic, and 10 MB size cap are duplicated with slight variations between the two files.
- **Suggested approach**: Extract `server/attachment-parser.ts` exporting `parseAttachmentPrefix(content, workingDir): { textContent: string; parts: AttachmentPart[] }`. Each process calls this and formats the parts for its own protocol.
- **Effort**: Small — well-scoped, low risk, immediately testable.

**8. Introduce `useLocalStorage<T>` hook in the frontend**
- **Location**: `src/App.tsx` (13 scattered `localStorage` call sites)
- **Problem**: localStorage key strings are literals scattered through component logic. A typo or key rename requires grep-level search.
- **Suggested approach**: `export function useLocalStorage<T>(key: string, defaultValue: T): [T, (v: T) => void]` in `src/hooks/useLocalStorage.ts`. Replace each inline `localStorage.getItem/setItem` pair with a hook call. Centralizes serialization logic.
- **Effort**: Small — minimal behavior change, significant testability gain.