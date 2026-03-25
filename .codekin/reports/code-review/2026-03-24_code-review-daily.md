# Daily Code Review: codekin

**Date**: 2026-03-24T05:03:16.725Z
**Repository**: /srv/repos/codekin
**Branch**: main
**Workflow Run**: 86cea35d-5bab-4934-b498-81c1f641c818
**Session**: 6dc503bb-7758-455f-af04-9d9dd2c17665

---

Now let me check the recently-changed key files and look for specific issues.Let me check the listener leak issue and the stall warning fix more closely.All 1109 tests pass. Now let me write the review.Now I have enough to write the review.---

## Daily Code Review — 2026-03-24

**21 commits this week** (all fixes/chores). **1109 tests pass. 0 npm vulnerabilities.**

---

### ⚠️ WARNING (2 actionable bugs, 1 minor correctness issue)

**1. Listener accumulation — `server/orchestrator-children.ts:307-308`**

Every `spawn()` → `monitorChild()` call pushes two listeners into `_resultListeners` / `_exitListeners` in `SessionManager` and **never removes them**. Post-completion they're no-ops, but their closures (referencing `child`, `session`, `sessionId`) stay in memory forever and are iterated on every result/exit event. Under sustained orchestrator use this degrades to O(n) iteration over stale closures.

Fix: `onSessionResult` / `onSessionExit` should return unsubscribe functions; call them in `monitorChild`'s `finally` block.

---

**2. Type-unsafe `_nudged` / `_superseded` field mutation — `server/orchestrator-children.ts:325, 350-354`**

Both fields are bolted on via `as` casts because they aren't declared on their types. `_superseded` also mutates a `WsServerMessage` already stored in `outputHistory`, which contradicts the comment on line 352 ("without mutating the outputHistory array"). TypeScript offers no protection if the property name changes.

Fix: Declare `_nudged` on `ChildSession` (or use a `Set` in `monitorChild`); track superseded messages by identity in a local `Set` rather than mutating history entries.

---

**3. `statSync` uses unresolved path — `server/orchestrator-reports.ts:124`**

`readReport()` resolves `filePath` → `resolved` for the security guard and uses it for `readFileSync`, but then calls `statSync(filePath)` (the original path). If a symlink is involved, the returned `mtime`/`size` could be wrong.

Fix: `statSync(resolved)` on line 124.

---

### ℹ️ INFO

**4. No tests for `OrchestratorChildManager`** — `server/orchestrator-children.ts` has no test file. Especially important once the listener-leak fix lands.

**5. React keys fall back to array index** (`ChatView.tsx`, various) — works for append-only streams, but `filter()`-based trims can shift indices. Low risk now.

**6. `dangerouslySetInnerHTML` with hljs** (`ChatView.tsx:182`) — standard pattern, hljs sanitizes output. Watch on future hljs upgrades.

**7. `x-forwarded-for` spoofable if not behind nginx** (`ws-server.ts:375`) — rate limiter can be bypassed when reached directly. Works correctly under current nginx deployment.

**8. Unexpanded shell vars in orchestrator prompt** (`ws-server.ts:504-505`) — `$CODEKIN_PORT` / `$CODEKIN_AUTH_TOKEN` are sent as literal strings, not interpolated. Cosmetic but may confuse the orchestrator's LLM.

---

Report saved to `.codekin/reports/code-review/2026-03-24_code-review-daily.md`.