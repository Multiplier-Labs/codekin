# Session Restart Root Cause Audit

**Date:** 2026-04-13
**Scope:** All code paths that can trigger a session-specific Claude process restart
**Goal:** Identify root causes for random, session-specific restarts (not global server issues)

---

## Summary

The session management pipeline has multiple restart triggers, timer-based mechanisms, and async operations that can interact in unexpected ways. While many guards exist (process generation counter, `_stoppedByUser` flag, `_isStarting` guard), there are gaps where concurrent operations can lead to unintended restarts or duplicate process spawns.

**12 issues identified:** 3 high severity, 6 medium, 3 low.

---

## HIGH Severity

### 1. stopClaudeAndWait → startClaude Promise Race (Concurrent Process Spawns)

**Files:** `session-lifecycle.ts:478-497`, `session-manager.ts:1196-1268`

**Description:** `setProvider()`, `setModel()`, and `setPermissionMode()` all use the same pattern:

```typescript
void this.stopClaudeAndWait(sessionId).then(() => {
  if (this.sessions.has(sessionId)) {
    session._stoppedByUser = false
    this.startClaude(sessionId)
  }
})
```

This is a fire-and-forget promise chain (`void`). Nothing prevents concurrent invocations from racing:

**Race scenario:**
1. Process crashes → `handleClaudeExit()` schedules restart timer (2s delay)
2. User changes model → `stopClaudeAndWait().then(startClaude)` queued
3. `stopClaudeAndWait()` resolves immediately (process already dead) → calls `startClaude()` at ~0ms
4. Restart timer fires at 2s → generation check passes (it was set before the timer was scheduled) → calls `startClaude()` again

**Impact:** Two Claude processes spawned in the same worktree. Git index corruption, interleaved output streams, session state confusion.

**Why the existing guard doesn't catch it:** The `_isStarting` guard in `sendInput()` (line 1113) is not used by the `setModel`/`setProvider`/`setPermissionMode` code paths. The generation counter is bumped inside `startClaude()`, so the first call bumps it but the timer was already scheduled with the old generation number — yet the timer's stored generation matches because `startClaude` hadn't run yet when the timer was scheduled.

**Note:** `setModel()` etc. do clear `_restartTimer` before the `void` chain (lines 1220, 1244), but the race is with `handleClaudeExit()` scheduling a NEW timer after the clear and before the promise resolves.

---

### 2. API Retry Timer vs. Process Restart Timer Interleaving

**Files:** `session-manager.ts:991-1047`, `session-lifecycle.ts:401-442`

**Description:** The API retry mechanism and process restart mechanism operate on independent timers with no coordination:

**Race scenario:**
1. Claude returns API error → `handleApiRetry()` schedules retry in 6s (exponential backoff)
2. Process crashes at 1s → `handleClaudeExit()` schedules restart in 2s
3. At 3s: restart fires → `startClaude()` → injects context summary + pending input
4. At 6s: API retry fires → checks `session.claudeProcess?.isAlive()` → TRUE → re-sends `_lastUserInput`
5. User's message sent TWICE to the new process: once via context injection, once via API retry

**Impact:** Duplicate messages in Claude's context, potentially confusing responses or double tool executions.

**The guard gap:** The API retry timer checks `isAlive()` and `_stoppedByUser` (line 1029) but does NOT check whether the process is the same one that generated the error. After a restart, `isAlive()` returns true for the NEW process that never had the API error.

---

### 3. No-Output Exit Counter Interacts Poorly with API Retries

**Files:** `session-lifecycle.ts:280-305`, `session-manager.ts:991-1047`

**Description:** The `_noOutputExitCount` mechanism clears `claudeSessionId` after 2 consecutive no-output exits, forcing a fresh session. But API retry loops can accelerate this counter:

**Scenario:**
1. API error → retry scheduled
2. Process exits with no output → counter = 1, auto-restart scheduled
3. Restart fires → new process starts, API retry re-sends message
4. Claude crashes again (same API issue) → counter = 2 → `claudeSessionId` cleared
5. Entire conversation context lost — session starts fresh

**Impact:** Premature context loss. A transient API outage (which the retry mechanism is designed to handle) can destroy the session's conversation history by triggering the no-output guard.

---

## MEDIUM Severity

### 4. Idle Reaper Stop vs. Concurrent sendInput Auto-Start

**Files:** `session-manager.ts:193-235`, `session-manager.ts:1102-1134`

**Description:** The idle reaper runs on a `setInterval` and stops idle processes synchronously:

```typescript
// Idle reaper (line 206-210)
session._stoppedByUser = true
session.claudeProcess.removeAllListeners()
session.claudeProcess.stop()
session.claudeProcess = null
```

Meanwhile, `sendInput()` clears `_stoppedByUser` immediately:

```typescript
// sendInput (line 1107)
session._stoppedByUser = false
```

**Race:** If `sendInput()` is called in the brief window between the reaper setting `_stoppedByUser = true` and nulling `claudeProcess`, the flow sees a live process and tries to send to it. After `.stop()` is called but before the process actually exits, `sendMessage()` may silently fail or throw.

**Impact:** User's message lost, session appears frozen until they retry.

---

### 5. Grace Period Timer Closure Holds Session Reference After Deletion

**Files:** `session-manager.ts:737-774`, `session-manager.ts:776-826`

**Description:** When the last client leaves, a 10s grace timer is set. The timer callback captures `session` by closure. If `delete()` is called before the timer fires:

1. `delete()` does clear the timer (line 785) — **this is correct**
2. BUT: if the timer fires in the same event loop tick as `delete()` (microtask ordering), the callback runs with a stale session object

**Impact:** Low probability but the callback calls `session.claudeProcess?.sendControlResponse()` and `pending.resolve()` on an already-deleted session. Effects range from harmless no-ops to broadcasting messages to disconnected clients.

---

### 6. Worktree Deletion During Active Session — Fallback Gap

**Files:** `session-lifecycle.ts:75-107`, `session-lifecycle.ts:307-344`

**Description:** Two independent checks for missing worktrees exist:
- In `startClaude()` (line 79): checks at spawn time, applies fallback
- In `handleClaudeExit()` (line 311): checks after crash, applies fallback

But if the worktree is deleted while the process is running (not at start, not at exit), the process crashes with a CWD error. The exit handler applies fallback, but then restart fires which calls `startClaude()` which checks the SAME worktree path — except `handleClaudeExit` already mutated `session.workingDir`, so `startClaude` sees the fallback path and succeeds. This is actually handled correctly.

**The real gap:** If `handleClaudeExit()` runs and the fallback directory ALSO doesn't exist (e.g., the entire repo was moved), the exit handler broadcasts an error and returns, but the restart timer was already scheduled (line 401-442) BEFORE the worktree check (line 307-344). The timer fires and calls `startClaude()` which then fails the directory check and sets `_stoppedByUser = true` — but the user sees a restart attempt message followed by a failure message.

**Impact:** Misleading UX (restart attempt message followed by failure). Not a true restart loop, but confusing.

---

### 7. Client Reconnection Health-Ping Can Trigger Redundant Session Joins

**Files:** `src/hooks/useWsConnection.ts:157-201`, `src/hooks/useChatSocket.ts` (onHealthPong)

**Description:** When a tab regains focus, `restoreSession()` sends health pings (up to 3 attempts, 2s apart). On receiving a pong, the `onHealthPong` callback re-joins the session:

```typescript
// On pong received, rejoin
onHealthPongRef.current?.(send)
```

**Race:** If the server responds to multiple pings before the client clears `awaitingHealthPong`, multiple pong handlers could fire. The guard (`awaitingHealthPong.current = false`) prevents this in most cases, but:

1. Tab switches away and back rapidly (< 8s `restoringRef` guard window)
2. First restore: sends ping, waits for pong
3. Second restore: blocked by `restoringRef.current = true` — **correct**
4. BUT: after 8s timeout clears `restoringRef`, user switches tab again
5. Multiple restore cycles can overlap if pongs are delayed

**Impact:** Duplicate `join_session` messages → server re-sends full output history → UI briefly flashes with duplicate messages.

---

### 8. `_lastUserInput` Stale Reference in Restart Context Injection

**Files:** `session-lifecycle.ts:418-441`, `session-manager.ts:1102-1134`

**Description:** After restart, if `claudeSessionId` is null, the restart timer injects context + `_lastUserInput`:

```typescript
if (hasPendingInput) {
  const msg = context + '\n\n' + pendingInput
  session.claudeProcess?.sendMessage(msg)
}
```

`_lastUserInput` is only set in `sendInput()` and never cleared. If the user sent input 50 seconds ago and Claude completed the task, but then the process crashes, the restart handler sees `inputAge < 60_000` and re-sends the completed task as if it's pending.

**Impact:** Claude re-executes an already-completed task after restart, potentially making duplicate changes.

---

### 9. Prompt Timeout Creates Orphaned State on Deleted Sessions

**Files:** `server/prompt-router.ts` (requestToolApproval timeout)

**Description:** Tool approval requests have a 5-minute timeout. If the session is deleted while a timeout is pending:
- `delete()` clears `pendingToolApprovals` (indirectly via process kill)
- BUT the `setTimeout` closure still holds a reference to `session.pendingToolApprovals`
- When the timer fires, `session.pendingToolApprovals.has(approvalRequestId)` is false → no-op

**Impact:** Benign in most cases. The resolve function captured by the closure may keep the session object in memory longer than expected (GC pressure, not a restart issue).

---

## LOW Severity

### 10. Process Generation Counter Is Correct but Brittle

**Files:** `session-lifecycle.ts:64-73`, `session-lifecycle.ts:401-412`

**Description:** The generation counter pattern works:
- `startClaude()` bumps generation (line 73)
- Restart timer stores generation at schedule time (line 403)
- Timer checks `session._processGeneration !== generationAtSchedule` before firing (line 410)

**Fragility:** The counter is initialized lazily (`session._processGeneration ?? 0`). If a session is restored from disk without this field, the first `startClaude()` sets it to 1. Any pending timers from before persistence would have stored generation 0, which won't match — this is correct behavior but only by accident.

---

### 11. `evaluateRestart()` Cooldown Window Reset Can Allow Burst Restarts

**Files:** `session-restart-scheduler.ts:51-89`

**Description:** The restart counter resets after a 5-minute cooldown window. A session that crashes at minute 0, 1, 2 (3 restarts, exhausted), then stays alive until minute 7, gets a fresh 3-restart budget. The lifetime cap of 10 total restarts prevents infinite loops, but 10 restarts over 20+ minutes of a flaky session may be too generous. Each restart creates a context injection, potential duplicate messages, and user-facing churn.

**Impact:** Extended flappy behavior before the session finally gives up.

---

### 12. Server Shutdown vs. In-Flight Restart Timers

**Files:** `session-manager.ts:1499-1525`

**Description:** Graceful shutdown clears restart timers and kills processes. But `setTimeout` callbacks are macrotasks — if a timer's callback was already queued in the event loop when shutdown runs, `clearTimeout` won't dequeue it. The callback would execute, find the session missing (`!this.deps.hasSession()`), and bail.

**Impact:** Benign — the guard catches it. But the process spawn attempt would briefly log a warning before the guard returns.

---

## Root Cause Summary

The most likely causes of the observed random session-specific restarts are:

| Priority | Issue | Likelihood |
|----------|-------|------------|
| 1 | **API retry + restart timer interleave** (#2) | High — any transient API error during a process crash window triggers it |
| 2 | **stopClaudeAndWait promise race** (#1) | Medium — requires user action (model/provider change) coinciding with a crash |
| 3 | **Stale `_lastUserInput` re-execution** (#8) | Medium — any crash after task completion re-sends the last message |
| 4 | **No-output counter + API retry context loss** (#3) | Medium — transient API outages can cascade into session ID loss |
| 5 | **Idle reaper vs. sendInput race** (#4) | Low — narrow timing window |

The core architectural pattern that enables most of these issues is: **multiple independent timer-based mechanisms (restart timer, API retry timer, idle reaper interval, grace period timer) that mutate shared session state without mutual exclusion or coordination.**
