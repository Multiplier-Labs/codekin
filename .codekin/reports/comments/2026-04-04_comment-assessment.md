# Comment Assessment: codekin

**Date**: 2026-04-04T05:49:00.348Z
**Repository**: /srv/repos/codekin
**Branch**: chore/reports-2026-04-01
**Workflow Run**: 5c4d90e1-90d3-420b-bbb7-fa6fedc879d0
**Session**: 9337898c-dc54-41bc-a216-f45f2d4eeee3

---

## Summary

**Overall coverage: ~88%** — module-level JSDoc present in approximately 90% of server files and 100% of frontend hook files. Field-level documentation on interfaces varies: the most critical types (`WsClientMessage`, `WsServerMessage`, `StepflowSessionRequest`) are thoroughly documented field-by-field, while internal/secondary interfaces often have none.

**Quality rating: A− (87/100)**

Key observations:
- State machine diagrams are exceptional and used consistently throughout the codebase.
- Comments routinely explain *why*, not just *what* — design rationale is first-class.
- Cross-file sync notes (`Keep in sync with server/types.ts`) help prevent drift between shared types.
- The performance rationale for RAF-batched streaming (`useChatSocket.ts`) is a model example of inline comment quality.
- Largest gap is field-level JSDoc on internal/secondary interfaces and `@param`/`@returns` tags on complex functions.
- One comment accuracy issue: `git push` appears in both `PATTERNABLE_PREFIXES` and `NEVER_PATTERN_PREFIXES` in `approval-manager.ts` with contradictory inline descriptions.

---

## Well-Documented Areas

### `server/plan-manager.ts`
Full state machine ASCII diagram with exact transition labels, enforcement architecture explanation, and rationale for the `deny-with-approval-message` workaround. Every public method and emitted event is documented.

```typescript
// State transitions:
//   idle ──EnterPlanMode──► planning
//   planning ──ExitPlanMode hook──► reviewing  (user sees approval prompt)
//   reviewing ──approve──► idle               (hook returns deny-with-approval-message)
```

### `server/stepflow-types.ts`
Best-documented file in the codebase. Every interface field has JSDoc, including usage examples in TypeScript code blocks showing how to register the webhook and emit events. Integration diagram in ASCII box art. State machine doc for `StepflowEventStatus`.

### `src/types.ts`
Protocol-level JSDoc on both `WsClientMessage` and `WsServerMessage` explains the canonical message sequence, paired message contracts (`tool_active`/`tool_done`), and constraints (`auth` must be first). Field-level docs on `Session`, `Skill`, `PermissionMode`.

### `server/approval-manager.ts`
`PATTERNABLE_PREFIXES` and `NEVER_PATTERN_PREFIXES` have inline comments per group (`// Git operations`, `// Code executors — arbitrary code execution risk`). The `IMPORTANT:` warning on `PATTERNABLE_PREFIXES` correctly separates "UI grouping" from "auto-approval" semantics.

### `src/hooks/useWsConnection.ts`
Health-check session restore flow documented as an indented decision tree:
```
//   Tab hidden → Tab visible
//     ├─ WS OPEN:  set awaitingHealthPong=true, send ping, start 2s timeout
//     │    ├─ pong received before timeout → call onHealthPong (rejoin session)
//     │    └─ timeout fires → close WS as zombie, reconnect via onclose
```
Exponential backoff ref annotated inline.

### `server/diff-parser.ts`
UTF-8 boundary-handling algorithm explained at the point of the bit-mask operation:
```typescript
// UTF-8 continuation bytes start with 0b10xxxxxx (0x80–0xBF).
// Walk back past any continuation bytes so we don't split a code point.
while (end > 0 && (buf[end] & 0xC0) === 0x80) end--
```

### `server/session-manager.ts`
All module-level constants documented with units and intent (lines 43–58). `Map` fields annotated with access-pattern rationale (`// Reverse lookup: WebSocket → session ID for O(1) client-to-session resolution`). Delegation architecture listed explicitly.

### `server/config.ts`
Every exported constant has JSDoc. Production CORS misconfiguration is caught at startup with an actionable error message including an example value.

### `src/hooks/useTentativeQueue.ts`
Module doc explains the localStorage serialisation trade-off (File objects not serialisable → text persisted, files in React state only, acceptable because text is the critical piece). `@param` tags on all helper functions.

### `server/session-restart-scheduler.ts`
Pure function with clear "Does NOT mutate state or perform side effects — the caller applies the result" contract. All three return variants of `RestartAction` are self-describing discriminated union members.

### `server/commit-event-handler.ts`
Five-layer filter chain documented as a numbered list in the module header, making the defense-in-depth strategy immediately readable without tracing code.

---

## Underdocumented Areas

| File | Issue | Severity |
|------|-------|----------|
| `src/types.ts:179–210` | `DiffFile`, `DiffHunk`, `DiffLine`, `DiffSummary` interfaces have no field-level JSDoc; contrast with the documented `Session`, `Skill`, `PromptOption` immediately above | High |
| `server/session-manager.ts:71–82` | `CreateSessionOptions` fields `source`, `id`, `groupDir`, `model` lack JSDoc; only `useWorktree`, `permissionMode`, and `allowedTools` are documented | Medium |
| `server/orchestrator-memory.ts` | Orchestrator sub-modules (`orchestrator-learning.ts`, `orchestrator-reports.ts`, `orchestrator-monitor.ts`) likely have minimal inline documentation given their complexity | Medium |
| `src/hooks/useSendMessage.ts:19–43` | `UseSendMessageOptions` interface fields (`token`, `activeSessionId`, `activeWorkingDir`, `sessions`, `sendInput`, etc.) have no JSDoc; complex hook with many parameters | Medium |
| `server/ws-message-handler.ts` | Handles all inbound WS message routing; large dispatch may lack per-case documentation | Medium |
| `server/session-manager.ts:60–68` | `API_RETRY_PATTERNS` array has no comment explaining which error sources each regex targets | Low |
| `server/orchestrator-children.ts:18–50` | `ChildSessionRequest` fields `completionPolicy` and `deployAfter` document their types but not the interaction between them | Low |
| `src/hooks/useChatSocket.ts` | `UseChatSocketOptions` interface fields (`onSessionCreated`, `onSessionJoined`, `onSessionRenamed`) undocumented | Low |
| `server/session-manager.ts` | `SessionManager` class itself has no class-level JSDoc block; documentation lives at module level only | Low |
| `server/webhook-dedup.ts` | Ring-buffer deduplication logic may lack explanation of eviction strategy | Low |
| `server/workflow-loader.ts` | 505-line file; complex workflow loading/scheduling logic — inline coverage unknown beyond header | Low |
| `server/session-persistence.ts` | Disk I/O helpers delegated from SessionManager; field-level coverage likely minimal | Low |
| Test files (`*.test.ts`) | Use compact single-line headers rather than full JSDoc blocks; acceptable but inconsistent with production file style | Low |
| `server/types.ts` | Server-side internal `Session` type field coverage likely less documented than client `src/types.ts` | Low |
| `src/lib/ccApi.ts` | Exported functions (`wsUrl`, `checkAuthSession`, `uploadAndBuildMessage`) may lack `@param`/`@returns` | Low |

---

## Comment Quality Issues

### 1. `git push` dual-membership contradiction — `server/approval-manager.ts:89,126`

`git push` appears in **both** `PATTERNABLE_PREFIXES` (line 89) and `NEVER_PATTERN_PREFIXES` (line 126). Each entry has its own inline comment:

```typescript
// Line 89 (PATTERNABLE_PREFIXES):
'git push',  // user explicitly clicks "Always Allow" — safe to pattern

// Line 126 (NEVER_PATTERN_PREFIXES):
'git push',  // cross-remote escalation risk — no stored pattern, but prefix-match at runtime is allowed (see PATTERNABLE_PREFIXES)
```

The comments are contradictory on their face ("safe to pattern" vs. "no stored pattern"). The actual behaviour — prefix-match at runtime but no wildcard stored to disk — requires reading `checkRepoApproval()` to understand. The `validatePrefixSets()` startup warning fires for `git push`, which looks like a misconfiguration warning but is intentional.

### 2. Missing units comment on `PERSIST_DEBOUNCE_MS` — `server/approval-manager.ts:16`

```typescript
const PERSIST_DEBOUNCE_MS = 2000
```

All other duration constants in the codebase append `// N minutes` or `// N seconds`. This one is bare.

### 3. `API_RETRY_PATTERNS` with no per-entry labels — `server/session-manager.ts:60–68`

The HTTP status code regexes (`/529/`, `/500/`) and text patterns (`/overloaded/`) originate from different sources (Anthropic API vs. generic HTTP). There is no comment associating patterns with their origin, making it unclear which patterns are Anthropic-specific vs. generic HTTP errors.

### 4. Silent empty-catch with no rationale — `src/hooks/useTentativeQueue.ts:49,69`

```typescript
} catch { /* ignore parse errors */ }
```

The empty catch is intentional (corrupt localStorage shouldn't crash the UI), but there is no explanation of whether corrupt data should be cleared. The same pattern appears at line 69 in `loadAllQueues()`.

---

## Recommendations

1. **Add field-level JSDoc to `DiffFile`, `DiffHunk`, `DiffLine`, `DiffSummary` in `src/types.ts:179–210`.**
   These interfaces are exported and used by both the diff viewer components and the server's `parseDiff` output. The rest of `src/types.ts` documents all fields; these four are the only exceptions. Even a one-line description per struct brings them in line with the established convention.

2. **Document `CreateSessionOptions` fields in `server/session-manager.ts:71–82`.**
   `source`, `id`, and `groupDir` affect session display and grouping in the UI. A new contributor reading `webhook-handler.ts` or `stepflow-handler.ts` needs to know what values `source` accepts and when `groupDir` is appropriate. Add JSDoc matching the `Session` interface counterparts in `src/types.ts`.

3. **Resolve the `git push` dual-membership in `server/approval-manager.ts`.**
   Add an explicit comment at the `validatePrefixSets` call site acknowledging the intentional dual entry, or introduce a `RUNTIME_PREFIX_ONLY` set for commands that match at runtime but are never persisted as wildcard patterns. The current setup logs a startup warning that looks like a bug but is by design.

4. **Add `@param`/`@returns` tags to complex exported functions in `server/diff-parser.ts` and `server/native-permissions.ts`.**
   `parseDiff(raw, maxBytes)` and `addNativePermission(repoDir, entry)` take multiple parameters where the constraints (e.g. `maxBytes` default, effect of `entry` shape) are not obvious from the signature. These are entry points called by multiple modules.

5. **Document `UseSendMessageOptions` fields in `src/hooks/useSendMessage.ts:19–43`.**
   This hook is the central message-dispatch surface for the UI with 10+ fields including callback functions (`onBuiltinCommand`, `sendInput`) with non-obvious call contracts. A one-liner per field prevents incorrect call-site wiring.

6. **Annotate `API_RETRY_PATTERNS` entries in `server/session-manager.ts:60–68` with source labels.**
   Group into `// Anthropic API text signals` and `// HTTP status codes` with a note on which error scenarios each addresses. This makes the list maintainable as the upstream API evolves.

7. **Upgrade empty-catch comments in `src/hooks/useTentativeQueue.ts:49,69`.**
   Replace `/* ignore parse errors */` with `// corrupt localStorage entry — silently discard, queue re-initialises empty` to communicate the intentional policy.

8. **Add a class-level JSDoc block to `SessionManager` in `server/session-manager.ts:85`.**
   The module-level doc (lines 1–19) covers the lifecycle well, but the class itself has no doc block. IDEs that surface hover docs will show nothing for `new SessionManager()`. A two-line summary referencing the module doc would close this gap.

9. **Add `@param` and `@returns` to exported functions in `src/lib/ccApi.ts`.**
   `wsUrl`, `checkAuthSession`, `uploadAndBuildMessage`, and `redirectToLogin` are the only cross-cutting API helpers in the frontend and are called by multiple hooks and components. Parameter constraints matter to anyone extending upload or auth flow.

10. **Formalise single-line test file headers as an explicit convention.**
    Test files consistently use compact single-line JSDoc (`/** Tests for X — verifies A, B, C; mocks M. */`). This is a clean pattern worth codifying in `CLAUDE.md` so new tests match without requiring a style review comment.
