# Coding Conventions

Patterns observed in the Codekin codebase. These describe what the code *does*, not aspirational guidelines.

## File Naming

- All modules: **kebab-case** (`session-manager.ts`, `approval-manager.ts`, `diff-parser.ts`)
- Tests: `.test.ts` or `.test.tsx` suffix alongside source files
- Server routes: `*-routes.ts` (`session-routes.ts`, `upload-routes.ts`, `webhook-routes.ts`)
- React components: **PascalCase** `.tsx` (`ChatView.tsx`, `InputBar.tsx`, `DiffPanel.tsx`)

## Server File Naming by Role

- `*-manager.ts` — stateful lifecycle managers (`SessionManager`, `ApprovalManager`, `PlanManager`)
- `*-handler.ts` — event/request handlers (`WebhookHandler`, `StepflowHandler`, `CommitEventHandler`)
- `*-routes.ts` — Express route definitions (`session-routes`, `workflow-routes`)
- `*-process.ts` — subprocess/process managers (`ClaudeProcess`, `OpenCodeProcess`)
- `*-types.ts` — type definitions (`webhook-types`, `stepflow-types`)
- `*-prompt.ts` — prompt generation (`webhook-prompt`, `webhook-pr-prompt`)
- `*-monitor.ts` — background monitoring (`OrchestratorMonitor`)

## Function & Variable Naming

- Classes/components: PascalCase (`SessionManager`, `ChatView`)
- Functions/methods: camelCase (`sendInput`, `handleWsMessage`)
- Constants: SCREAMING_SNAKE_CASE (`MAX_HISTORY`, `IDLE_SESSION_TIMEOUT_MS`)
- Private/internal: `_` prefix (`_lastUserInput`)
- Predicates: `is*`, `has*`, `can*` (`isAlive()`, `hasSession()`)
- Getters/setters: `get*` / `set*` (`getSessionId()`, `setModel()`)

## Server Patterns

- **One class per module**: `session-manager.ts` exports `SessionManager`, `approval-manager.ts` exports `ApprovalManager`
- **EventEmitter for process communication**: `ClaudeProcess` and `OpenCodeProcess` extend `EventEmitter<ClaudeProcessEvents>`
- **Typed message routing**: `handleWsMessage()` switches on `msg.type` with exhaustive handling
- **Validation at boundaries**: Allow-list checks for provider, model, permission mode in `ws-message-handler.ts`
- **API retry**: Exponential backoff (3s, 6s, 12s) for transient errors matching: `api_error`, `overloaded`, `rate.?limit`, `529|500|502|503`
- **Debounced persistence**: Disk writes (sessions, approvals) debounced with 2s window to avoid excessive I/O
- **Flat module layout**: All server `.ts` files in `server/` root (no subdirectories except `workflows/`)

## Frontend Patterns

- **Hook-based state management**: No Redux/Zustand — custom hooks (`useChatSocket`, `useSessions`, `useSettings`, `useRepos`)
- **Message batching**: `requestAnimationFrame` in `useChatSocket` for smooth 60fps rendering
- **REST client in `src/lib/ccApi.ts`**: All HTTP calls go through typed wrapper functions
- **Type imports**: `import type { ... }` for type-only imports
- **TailwindCSS**: Utility classes with custom color theme in `src/index.css`, dark/light via CSS variables
- **Minimal client-side router**: `useRouter` hook parses pathname, routes: `/`, `/s/:sessionId`, `/workflows`, `/orchestrator`

## Testing Patterns

- **Framework**: Vitest (Jest-compatible)
- **Mocking**: `vi.mock()` for fs, better-sqlite3, child_process — no real disk/process side effects
- **Fixtures**: Helper functions for fake objects (e.g., `fakeCliProc()`)
- **Structure**: Table-driven tests where applicable, `describe`/`it` blocks
- **Frontend mocks**: Mock `fetch` for HTTP, mock `EventEmitter` for WebSocket, mock `localStorage` for settings

## Error Handling

- **Server**: Validation errors return message to client; process crashes logged + client notified; graceful degradation (e.g., worktree fallback to main dir)
- **Frontend**: 401 → redirect to login; silent fail for non-critical fetches; WebSocket reconnect with exponential backoff (1s → 32s)
- **Process lifecycle**: SIGTERM first, SIGKILL after timeout; auto-restart with staggered delays

## Import Style

- **Server**: Relative imports with `.js` extensions (ESM compatibility)
- **Frontend**: Relative imports, no path aliases
- **Type imports**: Separated with `import type` syntax

## File Organization

Server modules grouped by concern:
- **Process**: `claude-process.ts`, `opencode-process.ts`, `coding-process.ts`
- **Session**: `session-manager.ts`, `session-persistence.ts`, `session-naming.ts`, `session-archive.ts`
- **Permissions**: `approval-manager.ts`, `plan-manager.ts`, `native-permissions.ts`
- **Git**: `diff-manager.ts`, `diff-parser.ts`
- **Webhooks**: `webhook-handler.ts`, `webhook-github.ts`, `webhook-pr-github.ts`, `webhook-rate-limiter.ts`, `webhook-dedup.ts`
- **Workflows**: `workflow-engine.ts`, `workflow-loader.ts`, `workflow-config.ts`
- **Orchestration**: `orchestrator-manager.ts`, `orchestrator-children.ts`, `orchestrator-learning.ts`, `orchestrator-monitor.ts`, `orchestrator-memory.ts`
- **Routes**: `session-routes.ts`, `upload-routes.ts`, `webhook-routes.ts`, `workflow-routes.ts`, `orchestrator-routes.ts`, `docs-routes.ts`
