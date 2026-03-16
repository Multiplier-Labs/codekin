# Daily Code Review: codekin

**Date**: 2026-03-17T05:07:03.085Z
**Repository**: /srv/repos/codekin
**Branch**: main
**Workflow Run**: 691ce873-7d77-4f26-aaad-1de12407f22c
**Session**: bd57c025-68f4-4efc-9a32-3516e7b28867

---

Now let me check a few more targeted items:Now let me check one more targeted security concern:Now I have a complete picture. Here's the report:

---

## Daily Code Review — 2026-03-17

### Scope: Last 7 days of commits (PRs #162–#173)
**Focus areas:** worktree robustness, queue-messages setting, approval manager, session lifecycle.

---

## 🔴 Critical

### 1. Symlink traversal in `/api/browse-dirs` (`session-routes.ts:233–234`)

```typescript
const resolved = pathResolve(base)  // Does NOT follow symlinks
if (!allowedRoots.some(root => resolved === root || resolved.startsWith(root + '/'))) {
  return res.status(403).json({ error: 'Path is outside allowed directories' })
}
```

`path.resolve()` normalizes `.`/`..` segments but **does not dereference symlinks**. A symlink at a path within the allowed roots (e.g. `/home/dev/link-to-etc → /etc`) passes the allowedRoots check because the pre-resolved path starts with `/home/dev/`. `fsReaddirSync(base)` then follows the symlink and lists the target directory.

**Fix:** Replace `pathResolve(base)` with `fs.realpathSync(base)` in the security check (wrap in try/catch for broken symlinks). Also requires `fs.realpathSync` on the checked path, not just `base`:

```typescript
const resolved = (() => { try { return realpathSync(base) } catch { return pathResolve(base) } })()
```

---

## 🟡 Warning

### 2. `compactExactCommands()` silently escalates approval scope (`approval-manager.ts:458–493`)

On every server startup, if ≥3 exact commands share a patternable prefix, they're automatically promoted to a `"prefix *"` pattern. A user who explicitly approved `git fetch origin`, `git fetch upstream`, `git fetch --tags` three times gets a silent `git fetch *` — a broader grant they didn't explicitly authorize.

The compaction happens without persisting a changelog or notifying the user. This is a security concern for users who intend to whitelist only specific fetch operations.

**Recommendation:** Log a visible warning when compaction promotes exact approvals to patterns. Consider making compaction opt-in or requiring it to only run when explicitly triggered.

### 3. `stop()` SIGKILL timeout leaks timer reference (`claude-process.ts:606–615`)

```typescript
stop(): void {
  if (this.proc) {
    this.proc.kill('SIGTERM')
    setTimeout(() => {         // No reference stored — can't be cancelled
      if (this.proc) {
        this.proc.kill('SIGKILL')
      }
    }, 5000)
  }
}
```

If `stop()` is called twice (e.g., user deletes a session while it's mid-restart), two 5-second SIGKILL timers run. After the first SIGKILL succeeds and `this.proc` is set to `null` in the `close` handler, the second timer silently no-ops — but if a new process has been assigned to `this.proc` before the timer fires, it will be incorrectly killed. Unlikely in current code paths, but worth guarding.

**Fix:** Store the timer reference and cancel it on subsequent `stop()` calls or in the `close` handler.

### 4. Tentative queue auto-execute uses stale closure (`useSendMessage.ts:206–221`)

```typescript
useEffect(() => {
  // ...
  void handleExecuteTentative(sessionId)
  // ...
}, [sessions]) // eslint-disable-line react-hooks/exhaustive-deps
```

`handleExecuteTentative` is a `useCallback` with its own deps, but because it's not in the `useEffect` dependency array, the stale closure captures the version of `handleExecuteTentative` from the last time the effect was defined. If `sendInput`, `token`, or `clearQueue` change between renders, the effect fires with outdated references.

In practice this is low-risk because `token` rarely changes, but it's a correctness gap. **Recommendation:** Add `handleExecuteTentative` to the dep array and verify sessions still triggers correctly (it should, since `handleExecuteTentative` itself depends on `tentativeQueues`).

### 5. Untracked file content read has no size limit (`diff-manager.ts:148–150`)

```typescript
const content = await fs.readFile(fullPath, 'utf-8')
files.push(createUntrackedFileDiff(relPath, content))
```

For `unstaged`/`all` diff scopes, every untracked file is read entirely into memory as a string. A single large generated file (e.g., a 50MB `package-lock.json` or log file) will spike memory before the binary-detection fallback triggers (which only fires on encoding errors, not on size). The `GIT_MAX_BUFFER` (2MB) applies only to `git diff` output, not this path.

**Fix:** Add a `stat()` size check before reading. Treat files >1MB as binary (or skip them from diffs).

---

## 🔵 Info

### 6. No tests for `useSendMessage.ts`

The hook covers the most critical user-facing logic: slash-command expansion, file upload, tentative queue management, and the auto-execute effect. All other hooks in `src/hooks/` have test files. `useSendMessage.ts` is the odd one out.

### 7. Tool input JSON parse failures are silently swallowed (`claude-process.ts:302–311`)

```typescript
try {
  const parsed = JSON.parse(this.currentToolInput)
  // ...
} catch { /* ignore parse errors */ }
this.emit('tool_done', this.currentToolName!, summary)
```

If streaming is interrupted mid-JSON (e.g. process killed during `input_json_delta`), the tool is still marked done with no summary and no error. The session appears to complete normally. Logging the parse error would aid debugging.

### 8. Drain callbacks in `sendMessage`/`sendRaw` are no-ops (`claude-process.ts:591–593`, `599–601`)

```typescript
const ok = this.proc.stdin.write(data + '\n')
if (!ok) {
  this.proc.stdin.once('drain', () => { /* ready for more */ })
}
```

Data isn't lost (Node.js buffers internally), but the `once('drain')` listener adds overhead and the comment implies intent to do something that never happens. If the write buffer fills up under load, the server will silently fall behind without backpressure signal to callers. Low risk, but misleading pattern.

### 9. Settings stored as strings in `archive.getSetting` (`session-routes.ts:177–178`)

```typescript
const enabled = sessions.archive.getSetting('queue_messages', 'false')
res.json({ enabled: enabled === 'true' })
```

Boolean settings stored as `'true'`/`'false'` strings are fragile. Any value other than the exact string `'true'` is treated as false. The pattern works, but future settings may accidentally use `'1'`/`'0'` or `'True'` and silently behave wrong.

### 10. `docs/` not updated for recent settings additions

The new `queue-messages` and `worktree-auto-enable` settings (PRs #172, #173) don't appear to have corresponding updates in `docs/`. If docs are user-facing or used for onboarding, they should reflect the new settings.

---

## Summary

| Severity | Count | Top item |
|---|---|---|
| Critical | 1 | Symlink traversal in `/api/browse-dirs` |
| Warning | 4 | Approval compaction escalation; stop() timer leak; stale closure in effect; untracked file size |
| Info | 5 | Test coverage gap; silent JSON errors; drain no-ops; stringly-typed settings; docs gap |

The recent worktree work (PRs #165–#170) is well-executed — GIT_* env stripping, cleanup on delete, and preventing path inheritance are all solid. The approval-manager's cross-repo inference logic is appropriately conservative. The main risk areas are the symlink check in `browse-dirs` and the compaction escalation behavior.Report committed and pushed to `chore/repo-health-2026-03-17`.