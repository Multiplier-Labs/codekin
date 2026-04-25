# Code Commenting Assessment — 2026-04-24

## Summary

**Comment coverage**: ~75% of exported symbols documented; ~90%+ of complex logic sections have inline explanations.
**Quality rating**: 8/10 — Very Good.

The Codekin codebase demonstrates strong, professional commenting practices. File-level module documentation is nearly universal, type/interface definitions are thoroughly annotated, and non-obvious algorithms (state machines, streaming optimisation, retry logic) are well-explained with inline comments. The primary gap is inconsistent JSDoc coverage on exported functions and public class methods — especially in the largest files — where interfaces are documented but the functions that use them are not. No inaccurate, misleading, or obviously outdated comments were found.

**Key observations:**

- File-level and type-level documentation is excellent across both `src/` and `server/`.
- Hook files (`useChatSocket.ts`, `useSendMessage.ts`) set the gold standard for the project.
- `server/session-manager.ts` (1,594 lines) is the single most significant documentation gap: its class methods lack JSDoc despite housing the core orchestration logic.
- Inline comment style (`//`) is used appropriately for implementation detail; JSDoc (`/** */`) is used for public contracts — the distinction is mostly consistent.
- ESLint-disable directives are accompanied by explanatory comments throughout, which is good practice.

---

## Well-Documented Areas

### `src/hooks/useChatSocket.ts` (516 lines)
Gold-standard hook documentation. File-level doc explains transport delegation and streaming. All exported symbols have JSDoc. Internal helpers (`applyMessageMut`, `processMessage`, `rebuildFromHistory`) have complete `@param`/return documentation. Section comments mark major phases of the message pipeline.

```ts
/**
 * Applies an incoming stream delta to an existing message in place.
 * Returns true if the message was modified, false if it should be
 * added as a new entry.
 */
function applyMessageMut(...)
```

### `src/hooks/useSendMessage.ts`
Five-phase explanation in `handleSend()` JSDoc. `processSlashCommand()` documents its return-object semantics including the "handled" flag. Three numbered command-resolution paths are clearly annotated inline.

### `server/claude-process.ts` (765 lines)
File-level doc explains the Claude CLI streaming protocol and event categories. Every interface field in `ClaudeProcessOptions`, `ThinkingState`, `ToolState`, and `ClaudeProcessEvents` is individually documented. Flag comments explain subtle race-condition guards (`sessionIdInUse`, `spawnFailed`). Environment variable handling block lists specific vars with purpose.

### `server/webhook-handler.ts`
File-level doc includes a readable ASCII state-machine diagram showing event lifecycle. Helper methods all have JSDoc. The "Only update on final exit" comment correctly captures a non-obvious invariant.

### `server/workflow-engine.ts`
All enums (`RunStatus`, `StepStatus`) document each variant. Every interface field in `WorkflowRun`, `WorkflowStep`, `CronSchedule`, and `WorkflowEvent` is annotated with `@param`-style inline docs. Custom error class is documented.

### `server/types.ts` (385 lines)
The `Session` interface (lines 37–136) is exemplary: every field has a trailing comment explaining its purpose, valid values, and in some cases, invariants. Synchronisation notes ("Keep in sync with client/types.ts") prevent drift.

### `src/lib/slashCommands.ts` (116 lines)
File-level doc explains three command categories with clear distinctions. `buildSlashCommandList()` documents priority rules. `resolveBuiltinAlias()` has complete JSDoc.

### `src/components/DiffPanel.tsx` (152 lines)
Drag-handler delta-direction logic is annotated inline. ESLint-disable directives include explicit reasoning. Parent-contract callback registration is explained in comments.

---

## Underdocumented Areas

| File | Issue | Severity |
|---|---|---|
| `server/session-manager.ts` | Public class methods (`create`, `startClaude`, `join`, `leave`, `reapIdleSessions`, `sendInput`, `cancel`, `resize`, etc.) have no JSDoc despite 1,594 lines of complex orchestration logic | High |
| `server/ws-message-handler.ts` | Exported `handleWsMessage()` function (the primary entry point for all WebSocket messages) has no JSDoc | High |
| `src/App.tsx` | `App()` default export (739-line component) has no JSDoc; the file-level doc does not substitute for the function signature doc | Medium |
| `src/hooks/useSettings.ts` | `useSettings()` exported hook has no JSDoc; return shape and side-effects (URL token handling) are non-obvious | Medium |
| `src/components/ChatView.tsx` | `parseApiError()` helper documents logic via inline comments inside the function body rather than a JSDoc block; not discoverable from call sites | Medium |
| `src/components/InputBar.tsx` | `InputBar()` main export has no JSDoc; `PermissionModeDropdown` and `ModelDropdown` inner components document only props, not side-effects or state dependencies | Medium |
| `server/session-manager.ts` | `SessionManager` class itself has no JSDoc block; only the constructor has a comment | Medium |
| `src/hooks/useRepos.ts` | `useRepos()` has no JSDoc; return shape (`groups`, `all`, `find`) requires reading the implementation to understand | Low |
| `src/components/` (broadly) | Many smaller components (`StatusBar`, `Sidebar`, `RepoSelector`, `SettingsPanel`, `TooltipButton`) appear to have no file-level or function-level JSDoc | Low |
| `server/` (route handlers) | Express route-handler functions wired in `index.ts`/`routes.ts` lack JSDoc for expected request shape, auth requirements, and response contract | Low |
| `src/lib/ccApi.ts` | `checkAuthResponse()` logic is well-commented inline but the function itself has no JSDoc block | Low |
| `src/App.tsx` | Lines 365–370 eslint-disable comment justifies dep-array omissions but does not explain the state invariant that makes those omissions safe | Low |
| `server/session-manager.ts` | Long methods (e.g., `startClaude`) lack section comments breaking up phases of the spawn lifecycle (env setup → spawn → pipe → handshake) | Low |
| `src/hooks/` (smaller hooks) | Several hooks (`useSessionList`, `useActiveSession`, `useTheme`) have no file-level or function-level JSDoc | Low |
| `server/diff-manager.ts` | No data was gathered; file was not sampled — pending review | Low |

---

## Comment Quality Issues

No actively inaccurate or misleading comments were identified in the sampled files. The following are style or omission issues worth noting:

1. **`src/App.tsx:221`** — `// eslint-disable-line react-hooks/set-state-in-effect -- sync with session change`. The "sync with session change" rationale is vague; it does not explain _why_ a synchronous state update on session change is necessary here rather than in an effect, which would be clearer for future maintainers.

2. **`src/App.tsx:365–382`** — The deps-array omission comment correctly flags intentional omissions but does not state the invariant that makes this safe (e.g., "X is stable across renders because it is derived from a ref"). A future reader cannot verify correctness without tracing through the hook.

3. **`src/components/ChatView.tsx:44–61`** — `parseApiError()` is documented with a comment block using `//` inside the function body rather than a `/** */` JSDoc block above the declaration. This means the documentation is invisible to IDE hover tooling and TypeScript's `--declaration` output.

4. **`server/session-manager.ts` (multiple locations)** — The constructor comment (lines 133–186) is well-written but reads as a file-level description rather than a constructor contract. Constructor JSDoc should document `@param` inputs and post-construction invariants separately from the file-level module overview.

5. **`server/ws-message-handler.ts:17–23`** — `WsHandlerContext` interface has minimal per-field documentation ("the WebSocket connection" for `ws`, but no explanation of the ownership model — whether the handler should close it, who owns the lifecycle).

---

## Recommendations

1. **Add JSDoc to all public `SessionManager` methods** (`server/session-manager.ts`).
   Each method should document: what it does, key `@param` inputs (especially non-obvious ones like `worktreeMode`), what it returns, and any side-effects (e.g., spawning a process, mutating session state). This is the single highest-value documentation improvement given the file's size and centrality.

2. **Add JSDoc to `handleWsMessage()`** (`server/ws-message-handler.ts:26`).
   This is the entry point for all client→server communication. Its JSDoc should document the `WsHandlerContext` contract (who owns lifecycle of `ws`), which message types it handles, and what errors it throws vs. sends back to the client.

3. **Add JSDoc to `App()`** (`src/App.tsx:48`).
   Even a two-line description of its responsibilities (session orchestration, layout, built-in command dispatch) gives future contributors a map before reading 739 lines. Note the key refs and effects it manages.

4. **Add JSDoc to `useSettings()`** (`src/hooks/useSettings.ts:51`).
   The hook reads a URL token, sets a cookie, and returns structured settings. None of this is visible from the call site. Document the return shape and the URL-token side-effect explicitly.

5. **Convert `parseApiError()` to JSDoc** (`src/components/ChatView.tsx:44`).
   Replace the `//` comment block inside the function with a `/** */` block above the declaration. This makes the documentation discoverable via IDE hover and consistent with the rest of the codebase.

6. **Add section comments to long methods in `session-manager.ts`**.
   Methods like `startClaude()` span hundreds of lines. Divide them into clearly labelled phases with `// --- Phase: <name> ---` comments (e.g., `// --- Phase: environment setup`, `// --- Phase: spawn process`, `// --- Phase: attach listeners`). This is low-cost and significantly improves readability.

7. **Document `WsHandlerContext` fields more precisely** (`server/ws-message-handler.ts:17–23`).
   Add lifecycle and ownership comments to `ws` and `sessionId` fields. Clarify whether the handler is expected to close the socket on error or leave that to the caller.

8. **Add file-level and function-level JSDoc to smaller unsampled components**.
   Components such as `StatusBar`, `Sidebar`, `RepoSelector`, and `SettingsPanel` likely lack documentation based on patterns in the sampled set. A sweep of `src/components/` to add file-level docs (one or two lines each) would bring coverage to near-100%.

9. **Document Express route handlers** (`server/index.ts` or equivalent routes file).
   Each route should have a brief comment stating: HTTP method + path, authentication requirement (if any), expected request body shape, and response shape. This is particularly important for routes that accept JSON bodies or return non-trivial payloads.

10. **Clarify the deps-array omission invariants in `App.tsx`** (lines 365–382).
    Replace the generic "intentional" note with a comment that states the invariant (e.g., "`sendMessage` is stable because it is memoised on `sessionId`, which is already in deps"). This allows future readers to verify the correctness of the omission rather than taking it on faith.
