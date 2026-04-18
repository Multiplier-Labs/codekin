# Code Commenting Audit — 2026-04-17

## Summary

**Overall comment coverage: ~83%**
**Quality rating: B+ (Good, approaching Excellent)**

The Codekin codebase demonstrates strong commenting discipline overall. Nearly every file opens with a purposeful module-level doc comment. Complex algorithms, state machines, and protocol flows are well-explained. Comment styles are highly consistent (JSDoc blocks for modules and interfaces, `// ----` section headers, inline `//` for logic explanations). The server layer is notably thorough, with several files serving as reference-quality examples.

Key observations:
- **Strengths**: Module-level documentation is near-universal; type definitions are exemplary; ASCII state-machine diagrams appear where warranted; section headers keep large files navigable.
- **Gaps**: A subset of shared utility functions and small helper components lack JSDoc; the largest switch statement in the codebase (`applyMessageMut` in `useChatSocket.ts`) has no per-case explanation; some grouping/map-building loops are self-contained enough that a one-line rationale would help future readers.
- **Accuracy**: No clearly inaccurate or stale comments were found during sampling.

---

## Well-Documented Areas

### `src/types.ts`
Exemplary module doc on line 1 describes scope (repo/session models, WebSocket protocol, chat UI). All major interfaces carry purpose comments. Constants such as `PermissionMode` include a cross-codebase synchronization warning. The WebSocket message type blocks (lines 107–166) explain the canonical client→server→client flow with directional notation, making the protocol self-documenting.

### `src/hooks/useWsConnection.ts`
Outstanding. Module doc (lines 1–10) explains the hook's responsibility; dependency comments (lines 16–27) justify each import; a multi-line ASCII state-machine diagram (lines 45–55) documents the session-restore flow. This file sets the bar for complex-hook documentation.

### `src/hooks/useChatSocket.ts` — module header and batching explanation
Lines 1–12 explain the streaming batching strategy; lines 19–24 annotate debounce constants with their purpose; lines 111–131 justify the immutable-reducer architecture choice. The performance-sensitive streaming path has clear section headers.

### `src/components/PromptButtons.tsx`
Module doc (lines 1–14) describes modal interaction modes and multi-question flow. The internal state machine for multi-question sequencing (lines 33–58) and the auto-allow countdown logic (lines 80–99) both carry thorough inline explanations.

### `server/types.ts`
Every field of the central `Session` interface carries an inline comment explaining its role. Notable examples: `processGeneration` includes the race-condition rationale; `pendingToolApprovals` explains the approval gate lifecycle; `planManager` notes lazy-initialization behavior. This is the canonical example of server-side type documentation.

### `server/webhook-handler.ts`
Lines 1–18 include a module doc with an embedded state-machine description of the event lifecycle (pending → approved/rejected → settled). Complex initialization logic for session-completion tracking is annotated step-by-step.

### `server/approval-manager.ts`
`NEVER_AUTO_APPROVE_TOOLS` (lines 18–22) carries a governance rationale. The overlap-validation concern is documented at the constructor level (lines 41–44). The approval validation logic has clear inline explanations.

### `server/session-manager.ts` and `server/session-lifecycle.ts`
Both carry detailed module docs explaining the delegation pattern and lifecycle scope. Guard logic for process-generation race conditions is commented at the point of check.

---

## Underdocumented Areas

| File | Issue | Severity |
|------|-------|----------|
| `src/hooks/useChatSocket.ts:42–109` | `applyMessageMut` — 9+ switch cases with no per-case explanation; mutation side-effects are opaque without tracing type definitions | High |
| `src/hooks/useChatSocket.ts:220–397` | `handleMessage` — large dispatch function with minimal inline guidance after its opening comment; branches for error, tool-use, and result types are uncommented | High |
| `src/components/LeftSidebar.tsx:40–65` | `buildRepoNodes` — the two-pass grouping strategy (collect then wrap) has no rationale comment | Medium |
| `src/hooks/useDiff.ts:77–109` | `handleToolDone` — heuristic for classifying commands as read-only is non-obvious; the approach is not explained | Medium |
| `src/lib/ccApi.ts:188–196` | `uploadAndBuildMessage` — exported utility with no JSDoc; parameters and return type are implicit | Medium |
| `src/components/WorkflowsView.tsx:46–68` | Map-building loops that construct `runsPerRepo` and related structures lack even a one-line explanation of the grouping intent | Medium |
| `src/components/InputBar.tsx:35–69` | `AttachButton` and `SendButton` sub-components have no JSDoc despite being reusable UI atoms | Low |
| `src/hooks/usePromptState.ts:103–113` | `getActive`/`getQueueSize` helpers lack JSDoc; null/empty-queue behavior is not described | Low |
| `src/hooks/useSessions.ts:65–72` | Polling/refresh mechanism has no comment explaining the interval rationale | Low |
| `src/lib/workflowHelpers.ts:129–146` | `describeCron` — formatting logic is compact and non-obvious; inline comments explaining each branch would help | Low |
| `src/components/InputBar.tsx:Props` | Component Props interface has no field-level JSDoc | Low |
| `server/approval-manager.ts:90–120` | `PATTERNABLE_PREFIXES` block lacks a top-level design comment explaining why prefix-matching is the chosen strategy | Low |
| `src/hooks/useChatSocket.ts:193–215` | `flushPendingText` — `requestAnimationFrame` usage timing rationale is unexplained | Low |
| `src/components/WorkflowsView.tsx:Props` | Props interface has no field-level JSDoc | Low |
| `src/lib/chatFormatters.ts` | File is small and generally clear, but exported functions lack JSDoc parameter/return descriptions | Low |

---

## Comment Quality Issues

No demonstrably inaccurate or stale comments were identified during sampling. The following are accuracy-adjacent concerns worth monitoring:

- **`src/hooks/useChatSocket.ts`, line 1 module doc** references "batching strategy" but the batching logic spans several functions; a brief cross-reference to `flushPendingText` and the debounce constant would keep this accurate as the code evolves.
- **`server/types.ts`, `processGeneration` field comment** correctly documents the race-condition guard, but the comment does not mention that the value is incremented on session restart — a future reader modifying the restart path may not realize this field must be bumped.
- **`src/types.ts`, `groupDir` field (line ~95–96)** — the comment "Optional grouping key" is technically accurate but does not convey that absence of this field causes the skill to appear ungrouped at the root level. This is implicit behavior worth stating.

---

## Recommendations

1. **Document each case in `applyMessageMut` (`src/hooks/useChatSocket.ts:42–109`)**
   Add a one-line comment above each `switch` case explaining what state transition the branch performs and any side-effects (e.g., why a particular field is mutated in place). This function is the central state reducer; understanding each case is essential for any contributor modifying message handling.

2. **Add section headers to `handleMessage` (`src/hooks/useChatSocket.ts:220–397`)**
   Group branches into labeled sections (e.g., `// --- Streaming text ---`, `// --- Tool use ---`, `// --- Error handling ---`) following the same `// ----` convention used elsewhere in the file. This reduces cognitive overhead when scanning a function with 15+ branches.

3. **Add JSDoc to `uploadAndBuildMessage` and other exported lib utilities (`src/lib/ccApi.ts:188–196`, `src/lib/chatFormatters.ts`)**
   Exported functions are the public API surface of their modules. A `@param` / `@returns` block for each prevents misuse and makes intent clear without requiring callers to read the implementation.

4. **Explain the heuristic in `handleToolDone` (`src/hooks/useDiff.ts:77–109`)**
   The read-only command detection logic uses a non-obvious heuristic. Add a comment naming the heuristic (e.g., "Classify a tool call as read-only if its first argument matches a known read-only prefix list") and link the decision to the `READ_ONLY_PREFIXES` constant, making the relationship explicit.

5. **Document `buildRepoNodes` grouping strategy (`src/components/LeftSidebar.tsx:40–65`)**
   Add a two-sentence comment before the function explaining that it performs a two-pass operation: first collecting skills by `groupDir`, then wrapping groups into tree nodes. This prevents future refactors from accidentally collapsing the two passes.

6. **Add Props JSDoc to components (`src/components/InputBar.tsx`, `src/components/WorkflowsView.tsx`)**
   For component Props interfaces, add a brief `/** */` comment on any non-self-evident field. TypeScript types describe shape; comments describe intent and valid values. Priority: fields that accept callbacks, optional flags that change behavior, or fields whose absence has a meaningful default.

7. **Add a design comment to `PATTERNABLE_PREFIXES` (`server/approval-manager.ts:90–120`)**
   Prepend a comment explaining why prefix-matching was chosen over exact matching for this approval category, and what security invariant it is intended to enforce. This prevents future contributors from inadvertently weakening the pattern list.

8. **Explain `requestAnimationFrame` usage in `flushPendingText` (`src/hooks/useChatSocket.ts:193–215`)**
   Add an inline comment stating why `requestAnimationFrame` is used here (e.g., "defer DOM reconciliation until after the current paint to avoid layout thrashing during rapid streaming"). This is non-obvious and will recur as a question for any reader unfamiliar with the streaming path.

9. **Annotate `processGeneration` increment sites (`server/session-lifecycle.ts`)**
   Wherever `processGeneration` is incremented, add a comment noting that this bump is intentional and coordinates with the race-condition guard documented in `server/types.ts`. A cross-reference keeps the two sides of the protocol connected.

10. **Add polling-interval rationale to `useSessions.ts:65–72`**
    Document why the chosen refresh interval was selected (performance vs. freshness tradeoff, any relationship to Claude session timeout). Even a one-line comment prevents the "magic number" from being changed arbitrarily.
