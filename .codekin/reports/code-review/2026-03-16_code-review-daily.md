# Daily Code Review: codekin

**Date**: 2026-03-16T15:39:50.750Z
**Repository**: /srv/repos/codekin
**Branch**: feat/permission-mode-selector
**Workflow Run**: 088c32d5-dba1-4101-9425-dc9d1752abde
**Session**: a75f84f1-aa33-4bc1-b16f-3f5c39ee0456

---

Now I have enough context to write the full review. Here it is:

---

## Daily Code Review — 2026-03-16

**Branch:** `feat/permission-mode-selector`  
**Scope:** Last 7 days of commits + focused review of the permission mode feature

---

### Critical

**1. No server-side validation of `permissionMode` input** (`server/ws-message-handler.ts:148-153`)

The `set_permission_mode` and `create_session` handlers pass the client-supplied `permissionMode` directly to `sessions.setPermissionMode()` / `sessions.create()` without any allow-list check. That value is then passed verbatim to the `--permission-mode` CLI flag:

```ts
// server/ws-message-handler.ts:148
case 'set_permission_mode': {
  const sessionId = clientSessions.get(ws)
  if (sessionId) {
    sessions.setPermissionMode(sessionId, msg.permissionMode)  // no validation
  }
}
```

```ts
// server/claude-process.ts:111
'--permission-mode', this.permissionMode || 'acceptEdits',
```

Any authenticated user can send an arbitrary string as `permissionMode`. While it won't cause command injection (it's passed as an argument, not a shell string), it can produce unexpected CLI behavior or error output. The same issue exists for `set_model` — no allow-list there either. Add an explicit check:

```ts
const VALID_PERMISSION_MODES = new Set(['default', 'acceptEdits', 'plan', 'bypassPermissions'])
if (!VALID_PERMISSION_MODES.has(msg.permissionMode)) break  // or send error
```

---

**2. `window.confirm()` is the only guard for `bypassPermissions`** (`src/components/InputBar.tsx:238-248`)

The dangerous mode confirmation is entirely client-side. The server has no record of which sessions are in bypass mode, no audit log of when it's activated, and no rate limiting. A compromised or modified client could silently activate it. The `bypassPermissions` mode causes Claude to accept all tool calls without asking — making it a meaningful security boundary that deserves a server-side acknowledgment at minimum. Consider:
- Emitting a visible system message in the chat when bypass mode is activated (already done for other state changes like planning mode)
- Adding a server-side log entry when `setPermissionMode('bypassPermissions')` is called

---

### Warning

**3. Race condition in `setPermissionMode` / `setModel`** (`server/session-manager.ts:1198-1200`)

```ts
this.stopClaude(sessionId)
setTimeout(() => this.startClaude(sessionId), 500)
```

The 500ms hard-coded timeout is a smell. If the session is deleted, the `_stoppedByUser` flag is set, or another restart is triggered within that window, `startClaude` will either no-op or behave incorrectly. The `setModel` method (line 1185) has the same pattern. Consider gating `startClaude` on a callback from `stopClaude` completing, or setting a flag (`_pendingRestart`) and checking it in the stop cleanup path.

---

**4. Session join doesn't sync `permissionMode` or `model` to rejoining client** (`server/ws-message-handler.ts:72-79`)

The `session_joined` message does not include `permissionMode` or `model`:

```ts
send({
  type: 'session_joined',
  sessionId: session.id,
  sessionName: session.name,
  workingDir: session.workingDir,
  active: session.claudeProcess?.isAlive() ?? false,
  outputBuffer: session.outputHistory.slice(-500),
  // missing: model, permissionMode
})
```

The client reads both from `localStorage`, so a second browser tab, a reconnect after a mid-session mode change, or any client that didn't initiate the change will display a stale value. This is especially problematic for permission mode since the displayed mode should always reflect the actual running process. The `model` field was added before (the `system:init` event syncs it), but there's no equivalent sync for permission mode.

---

**5. `PermissionMode` type is duplicated across `src/types.ts` and `server/types.ts`**

Both define identical `PermissionMode = 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions'`. If a new mode is ever added (or one is removed), both files need updating in sync. The server can't import from `src/`, but a shared `types/` package or a `// keep in sync with src/types.ts` comment would help. The `PERMISSION_MODES` constant with metadata only lives in `src/types.ts` — the server uses the raw string union, which is fine — but the potential for drift is real.

---

**6. `setPermissionMode` doesn't broadcast the change to other clients** (`server/session-manager.ts:1191-1203`)

When a client changes the permission mode, other connected clients to the same session receive no notification. Compare: planning mode changes emit a `planning_mode` WsServerMessage that all clients receive. Changing permission mode mid-session is equally significant but silent to other clients. Add a `permission_mode_changed` broadcast (or reuse an existing `system` message subtype) so all connected clients can update their UI.

---

**7. No tests for the new permission mode feature**

The feature touches 10 files and adds a non-trivial mid-session restart path. There are no tests for:
- `SessionManager.setPermissionMode()` (happy path, session-not-found, restart behavior)
- `ws-message-handler` `set_permission_mode` case
- `useChatSocket` `setPermissionMode` / `currentPermissionMode` state
- The `bypassPermissions` confirmation flow in `InputBar`

Given the project has 1001 tests and good coverage discipline, this is an outlier that should be addressed before merge.

---

### Info

**8. `plan` mode description is slightly misleading** (`src/types.ts:54`)

```ts
{ id: 'plan', label: 'Plan mode', description: 'Create a plan before making changes', icon: 'map' },
```

`plan` mode in Claude CLI restricts tool calls that have side effects (file writes, shell commands) but still allows reads. "Create a plan before making changes" implies a two-phase workflow but doesn't convey the restriction semantics. Something like "Read-only: proposes changes without applying them" is more accurate.

---

**9. `shortPermissionLabel` function is only used once** (`src/components/InputBar.tsx:21-23`)

```ts
function shortPermissionLabel(mode: PermissionMode): string {
  return PERMISSION_MODES.find(m => m.id === mode)?.label ?? mode
}
```

Used only at line 350. Could be inlined or replaced with `PERMISSION_MODES.find(m => m.id === currentPermissionMode)?.label`. Minor.

---

**10. `permissionModeRef` sync via `useEffect` has a 1-render lag** (`src/App.tsx:158-160`)

```ts
useEffect(() => { permissionModeRef.current = currentPermissionMode }, [currentPermissionMode])
```

`useEffect` runs after render, so `permissionModeRef.current` lags one render behind `currentPermissionMode`. In practice this is safe because the ref is only read during a user-initiated session creation, but it's a subtle footgun. A cleaner pattern is to update the ref synchronously in the `setPermissionMode` callback rather than via effect.

---

### Summary

| Severity | Count | Key Items |
|---|---|---|
| Critical | 2 | Server-side permission mode validation missing; bypass mode has no server-side audit |
| Warning | 5 | Race condition in restart; no mode sync on join; type duplication; no broadcast; no tests |
| Info | 3 | Description accuracy; dead code; ref sync lag |

The most important fixes before merging this PR are **#1** (input validation) and **#7** (tests). The race condition (#3) and session join sync (#4) are pre-existing issues shared with `setModel` and warrant a follow-up issue.The `2026-03-16.md` file was already committed in a prior commit. Only the `_complexity-report.md` variant was new. Both are now committed and the working tree is clean.Committed and pushed.