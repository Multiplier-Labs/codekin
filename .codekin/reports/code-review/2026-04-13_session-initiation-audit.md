# Session Initiation Audit — Multiple "Session Started" Messages

**Date:** 2026-04-13
**Category:** Code Review / Bug Investigation

## Summary

Users are seeing multiple "Session started" messages in the chat UI. In some cases, sending a message produces a new "Session started" instead of a response. This audit traces the session lifecycle to identify root causes.

## Where "Session started" Originates

1. **Server** emits `{ type: 'claude_started' }` in `session-lifecycle.ts:181` whenever a Claude process starts.
2. **Client** converts it to the green "Session started" text in `useChatSocket.ts:70-72`.

A guard exists at `session-lifecycle.ts:179-185`: the `_processStartedOnce` flag prevents **broadcasting** `claude_started` on process restarts. However, the message is **always added to history** via `addToHistory()` regardless of whether broadcast is suppressed.

```typescript
// session-lifecycle.ts:177-185
const isRestart = !!session._processStartedOnce
session._processStartedOnce = true
const startMsg: WsServerMessage = { type: 'claude_started', sessionId }
this.deps.addToHistory(session, startMsg)   // always stored
if (!isRestart) {
  this.deps.broadcast(session, startMsg)    // only broadcast on first start
}
```

## Scenarios That Produce Multiple "Session Started" Messages

### Scenario 1: Tab Visibility Restore Triggers `join_session` History Replay

**Most likely cause of the observed behavior.**

1. User is in a session, switches tabs or the tab loses focus.
2. User returns to the tab — `restoreSession()` fires (`useWsConnection.ts:157`).
3. If the WebSocket is still open, a health ping is sent.
4. On pong, `onHealthPong` **unconditionally** sends `join_session` (`useChatSocket.ts:414-416`).
5. Server responds with `session_joined` containing `outputHistory.slice(-500)` (`ws-message-handler.ts:105`).
6. Client calls `rebuildFromHistory()` which replays **all** `claude_started` messages in history.
7. Every previous process start that was added to history (including restarts where broadcast was suppressed) becomes a visible "Session started" in the rebuilt chat.

**Key issue:** `addToHistory` at line 182 always stores `claude_started`, even for restarts where broadcast is suppressed. The history accumulates multiple `claude_started` entries, and every `join_session` replay shows all of them.

### Scenario 2: User Sends a Message to a Dead Process

1. User sends a message.
2. `sendInput()` (`session-manager.ts:1110`) checks `!session.claudeProcess?.isAlive()`.
3. If the process died (idle reap, crash, server restart), it calls `startClaude()`.
4. `startClaude()` generates a new `claude_started` — and since `_processStartedOnce` may be false (new session object after server restart), it **broadcasts** it.
5. User sees a new "Session started" instead of an immediate answer. The message was sent but the response hadn't arrived yet.

### Scenario 3: Race Between Health Pong Rejoin and User Input

1. Tab focus returns — health ping sent.
2. User immediately sends a message.
3. Pong arrives — `join_session` sent — full history replay (with `claude_started` messages).
4. Simultaneously, `sendInput` finds process dead — calls `startClaude()` — new `claude_started` broadcast.
5. Client receives both: rebuilt history with old "Session started" + new broadcast "Session started".

### Scenario 4: Insufficient Race Guard in `sendInput`

The `_isStarting` flag at `session-manager.ts:1113-1119` prevents concurrent `startClaude()` calls. The guard works correctly for Node.js's single-threaded event loop since `startClaude()` is synchronous. However, if a process dies between the `_isStarting = false` reset and a subsequent `isAlive()` check from another message, a second start could occur. This is a minor edge case.

## Root Causes

| # | Cause | Location | Issue |
|---|-------|----------|-------|
| 1 | History always stores `claude_started` | `session-lifecycle.ts:182` | Even suppressed restarts get saved, then replayed on every `join_session` |
| 2 | `join_session` replays full history | `ws-message-handler.ts:105` | All accumulated `claude_started` entries are sent back to the client |
| 3 | Health pong always re-joins | `useChatSocket.ts:414-416` | No check for whether rejoin is actually needed |
| 4 | Dead process auto-start on input | `session-manager.ts:1110-1121` | Generates new "Session started" when user expected a response |
| 5 | `rebuildFromHistory` has no deduplication | `useChatSocket.ts:338` | Every `claude_started` in the buffer becomes a visible UI message |

## Key Files

| File | Lines | Role |
|------|-------|------|
| `server/session-lifecycle.ts` | 64-187 | `startClaude()` — process spawn and `claude_started` emission |
| `server/session-manager.ts` | 1102-1163 | `sendInput()` — auto-start on dead process with race guard |
| `server/session-manager.ts` | 704-735 | `join()` — adds client to session |
| `server/ws-message-handler.ts` | 91-113 | `join_session` handler — sends full `outputHistory` |
| `src/hooks/useChatSocket.ts` | 70-72 | Client-side `claude_started` → "Session started" rendering |
| `src/hooks/useChatSocket.ts` | 320-352 | `session_joined` handler — rebuilds chat from history |
| `src/hooks/useChatSocket.ts` | 414-417 | `onHealthPong` — unconditional `join_session` on reconnect |
| `src/hooks/useWsConnection.ts` | 157-201 | `restoreSession()` — tab visibility restore flow |

## Recommendations

1. **Skip `claude_started` in history for restarts**: Only call `addToHistory()` when `!isRestart`, matching the broadcast guard.
2. **Deduplicate `claude_started` in `rebuildFromHistory`**: Only keep the most recent `claude_started` when rebuilding from output buffer, or filter out all but the first.
3. **Guard `onHealthPong` rejoin**: Check whether the client is already joined to the session before sending `join_session` on pong.
4. **Suppress duplicate "Session started" on auto-start**: When `sendInput` auto-starts a process, either suppress the `claude_started` message or combine it with the pending user input so the user sees a seamless flow.
