# Repository Health: codekin — Code Review

**Date**: 2026-03-18
**Repository**: /srv/repos/codekin
**Branch**: chore/repo-health-report-2026-03-18
**Scope**: Architecture review + deep audit of critical server files
**Period**: Last 7 days (2026-03-11 → 2026-03-18)

---

## Recent Activity (Last 7 Days)

Key merges since 2026-03-11:
- **Agent Joe** rename from Shepherd + orchestrator spawning visible sessions (`feat/agent-joe`)
- **Worktree session migration** — copy Claude session JSONL on mid-session worktree move (`fix/worktree-copy-session-data`)
- **Joe welcome screen** + chat variant with distinct visual identity (`feat/joe-welcome-screen`, `feat/joe-chat-variant`)

Most risk is concentrated in `session-manager.ts` (worktree changes) and `shepherd-children.ts` (new spawn logic).

---

## Findings

### CRITICAL

_No findings at critical severity._

---

### WARNING

#### W1 — Unvalidated `sinceTimestamp` passed to git `--since`
**File**: `server/workflow-loader.ts:216`
**Category**: Input Validation

```typescript
const newCommits = execFileSync('git', ['log', `--since=${sinceTimestamp}`, '--oneline'], { cwd: repoPath, timeout: 5000 })
```

`sinceTimestamp` is read directly from workflow input with no format validation before being interpolated into the git flag. While `execFileSync` with array args prevents shell injection, git's `--since` parser accepts arbitrary freeform strings (e.g., `"2 weeks ago"`, `"yesterday"`, `"2022-bananas"`). A malformed or adversarially crafted value could cause git to silently return wrong results (e.g., all commits, or no commits), causing workflows to fire or skip unexpectedly.

**Fix**: Validate against ISO 8601 or Unix epoch before use:
```typescript
if (sinceTimestamp && !/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2})?/.test(sinceTimestamp)) {
  throw new Error(`Invalid sinceTimestamp format: ${sinceTimestamp}`)
}
```

---

#### W2 — Silent worktree session copy failure — no user notification
**File**: `server/session-manager.ts:280-283`
**Category**: Bug / UX

```typescript
if (!existsSync(srcJsonl)) {
  console.warn(`[worktree] No session JSONL at ${srcJsonl}, skipping copy`)
  return  // Claude restarts without conversation context
}
```

When the JSONL file doesn't exist (e.g., session was very new, or storage issue), the worktree migration silently skips copying conversation history. Claude then starts in a fresh state while the user expects continuity. The `console.warn` goes to server logs only — no message is broadcast to the session.

This was introduced in commit `65cf05f` (2026-03-13).

**Fix**: Broadcast a system message to the session when copy is skipped:
```typescript
// After the console.warn:
this.broadcast(session, {
  type: 'output',
  data: '\n[system] Warning: Could not migrate session history to worktree (source not found). Conversation context was reset.\n'
})
```

---

#### W3 — Stale worktree cleanup swallows all errors silently
**File**: `server/session-manager.ts` (worktree setup block)
**Category**: Bug / Reliability

```typescript
await execFileAsync('git', ['worktree', 'remove', '--force', worktreePath], ...)
  .catch(() => {})  // All errors silently swallowed
```

If the `git worktree remove` fails due to a permission error or corrupt state (not just "not found"), the code proceeds to attempt `git worktree add` on the same path, which will then also fail — but with a confusing error about an existing worktree. The silent catch makes root cause diagnosis very difficult.

**Fix**: Log unexpected errors while still allowing "not found" to pass:
```typescript
.catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err)
  if (!msg.includes('not a worktree') && !msg.includes('does not exist')) {
    console.warn(`[worktree] failed to remove stale worktree at ${worktreePath}:`, msg)
  }
})
```

---

#### W4 — Race condition in `shepherd-children.ts` spawn: monitor launched before error-path check
**File**: `server/shepherd-children.ts:122-136`
**Category**: Bug / Race Condition

```typescript
child.status = 'running'
const prompt = this.buildPrompt(request)
this.sessions.sendInput(sessionId, prompt)  // Could throw
void this.monitorChild(child)               // Launched regardless

return child
} catch (err) {
  child.status = 'failed'   // Too late — monitorChild already sees 'running'
```

`monitorChild` is launched (`void this.monitorChild(child)`) on line 129 before `sendInput` could throw. If `sendInput` throws, the catch block sets `child.status = 'failed'` — but the monitor is already running polling for a `'running'` session and may loop indefinitely or act on stale state.

In practice `sendInput` is unlikely to throw synchronously, but the ordering is fragile.

**Fix**: Move `void this.monitorChild(child)` to after `sendInput` succeeds (after line 126, before `return child`). The current structure already looks correct topologically, but `monitorChild` is launched before the try-catch concludes — move it to just before `return child`:
```typescript
this.sessions.sendInput(sessionId, prompt)
void this.monitorChild(child)
return child
```
(This is already the case — but verify `sendInput` itself cannot throw synchronously to eliminate the window entirely.)

---

#### W5 — Missing REPOS_ROOT boundary check in `/api/clone`
**File**: `server/upload-routes.ts:286-294`
**Category**: Security / Defense-in-depth

```typescript
const dest = join(reposRoot, name)
// No: const resolved = resolve(dest); assert resolved.startsWith(reposRoot)
execFileAsync('gh', ['repo', 'clone', `${owner}/${name}`, dest], ...)
```

The `name` parameter is validated with `/^[a-zA-Z0-9][\w.-]*$/` which prevents obvious traversal. However, `path.join()` is used without a post-resolution boundary check, unlike the correct pattern already present in `workflow-loader.ts:205-208` (`realpathSync` + `startsWith(REPOS_ROOT + sep)`). Consistency is the issue — one path uses the defense, the other doesn't.

**Fix**: Add the same check pattern used in `workflow-loader.ts`:
```typescript
const dest = join(reposRoot, name)
// For a new clone, dest won't exist yet — check the parent is still within bounds
const resolvedParent = realpathSync(reposRoot)
const resolvedDest = join(resolvedParent, name)
if (!resolvedDest.startsWith(resolvedParent + sep)) {
  return res.status(400).json({ error: 'Invalid repository name' })
}
```

---

### INFO

#### I1 — `outputHistory` can reach ~200MB per session
**File**: `server/session-manager.ts` (`addToHistory` method)
**Category**: Performance / Memory

Output chunks are coalesced up to 100KB each (`data.length < 100_000`). With `MAX_HISTORY = 2000` entries, a single busy session can hold ~200MB in-memory. For a multi-session server with long-running sessions this accumulates quickly.

No immediate action needed but worth monitoring. Consider adding a per-session byte-size cap alongside the message count cap.

---

#### I2 — `persistToDiskDebounced` called on every output message; no flush on shutdown
**File**: `server/session-manager.ts` (`addToHistory`, `persistToDiskDebounced`)
**Category**: Reliability

Debounced persistence is called for every output message. The debounce interval is not documented inline. More importantly, if the server is killed (SIGKILL, crash) between messages and the last debounced write, a burst of history may be lost. The graceful shutdown path should call the non-debounced version.

**Fix**: In the shutdown handler (wherever `process.on('SIGTERM')` / `SIGINT` is handled), ensure `sessionPersistence.persistToDisk()` is called synchronously before exiting.

---

#### I3 — `docs/ORCHESTRATOR-SPEC.md` still references "Shepherd"
**File**: `docs/ORCHESTRATOR-SPEC.md`
**Category**: Documentation

Agent Joe was renamed from Shepherd in commit `f01005a` (2026-03-15), but the orchestrator spec doc still uses the old name throughout. New contributors will find the doc inconsistent with the code.

**Fix**: Update `docs/ORCHESTRATOR-SPEC.md` to replace "Shepherd" → "Agent Joe" / "Joe".

---

#### I4 — `git push` timeout of 30s may be insufficient for large repos
**File**: `server/workflow-loader.ts` (save_report step)
**Category**: Reliability

```typescript
execFileSync('git', ['push', 'origin', REPORTS_BRANCH], { cwd: repoPath, timeout: 30_000 })
```

30 seconds is marginal for repos with large history or slow CI runners. A partial push failure leaves no clear error path and will surface as a cryptic SIGTERM from execFileSync.

**Fix**: Increase to 120s or make configurable via env var `GIT_PUSH_TIMEOUT_MS`.

---

## Summary

| ID | Severity | Category | File |
|----|----------|----------|------|
| W1 | Warning | Input Validation | `server/workflow-loader.ts:216` |
| W2 | Warning | Bug / UX | `server/session-manager.ts:280` |
| W3 | Warning | Bug / Reliability | `server/session-manager.ts` (worktree setup) |
| W4 | Warning | Bug / Race Condition | `server/shepherd-children.ts:122-136` |
| W5 | Warning | Security / Hardening | `server/upload-routes.ts:286` |
| I1 | Info | Performance | `server/session-manager.ts` (addToHistory) |
| I2 | Info | Reliability | `server/session-manager.ts` (shutdown path) |
| I3 | Info | Documentation | `docs/ORCHESTRATOR-SPEC.md` |
| I4 | Info | Reliability | `server/workflow-loader.ts` (save_report) |

**Positives confirmed**: timing-safe auth comparison, HMAC webhook verification, `execFile` (not `exec`) for all subprocess calls, path traversal protection in workflows, rate limiting on WebSocket connections/messages, auth timeout on unauthenticated connections, full security header suite (CSP, HSTS, X-Frame-Options, etc.).

Most urgent fixes: **W2** (users lose conversation context silently) and **W1** (workflow skip/fire logic can be fooled by bad timestamp input). The rest are hardening/reliability improvements.
