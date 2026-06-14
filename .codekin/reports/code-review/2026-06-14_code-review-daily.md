# Daily Code Review: codekin

**Date**: 2026-06-14T04:03:26.486Z
**Repository**: /srv/repos/Multiplier-Labs/codekin
**Branch**: main
**Workflow Run**: e8d1ce00-53ed-4100-9696-df920b0e65f5
**Session**: 07146354-23a5-4b3d-baa0-2ba64aec2e8a

---

The user wants me to perform a daily automated code review. The key instruction is: "Do NOT use the Write or Edit tools to create the report yourself — that produces a duplicate file. Respond with the report Markdown directly, with no preamble."

So I should:
1. Examine project structure
2. Review last 7 days of git log
3. Review critical files for code quality, bugs, security, performance, docs, tests, dependencies
4. Provide findings grouped by severity with file paths and line numbers
5. Output the report directly as markdown in my response, no preamble

Let me start by gathering information. I'll run multiple tool calls in parallel.Now let me read the project structure more deeply, especially the server and src directories, and examine key files changed recently.Now I have a good overview of the project structure and recent commits. Let me now dive deeper into critical files that have seen significant changes in the last 7 days. The major changes involve:

1. OpenCode integration (resilience, native agents, permissions)
2. Codex provider addition
3. Agent Joe orchestrator (children, notifications, outbox, timeouts, ground truth verification)
4. UI updates (dark mode, buttons, todo panel, dropdown)
5. Session management improvements

Let me read the key files that are most critical:
- opencode-process.ts (resilience changes)
- codex-process.ts (new provider)
- orchestrator-children.ts (Joe features)
- orchestrator-notify.ts (notification outbox)
- orchestrator-outbox.ts (persistent notifications)
- orchestrator-manager.ts (core orchestrator)
- session-lifecycle.ts / session-manager.ts
- approval-manager.ts / native-permissions.ts
- config.ts
- ws-server.ts

I need to look at both source and test files for these.Now I need to look at more of the critical files, especially those recently changed. Let me read more of the key files and look at the test coverage and any potential security issues.

Let me read:
- src/components (recently changed files)
- server files related to recent commits (todo panel, dark mode fixes, provider dropdown)
- Check for any new security patterns in auth
- Review the test files to check coverage

I should also check git diff for the recent commits to see what actually changed.I need to continue examining the critical files. Let me also check some frontend files and test coverage data.The test suite has 1 failure: `upload-routes.test.ts` cannot import the `yaml` package. This is a dependency issue — `yaml` is listed in `dependencies` in `package.json`, but it seems the test runner can't resolve it. Let me check if `yaml` is actually installed.

Also, I need to continue reviewing the critical files. Let me read more of the recently changed files and check for issues.

Recent changes in the last 7 days:
1. Codex provider added
2. OpenCode resilience improvements
3. Agent Joe orchestrator features (child sessions, outbox, notifications)
4. UI fixes (dark mode, todo panel, dropdown)
5. Documentation updates

Let me read a few more critical files and then check the `yaml` import issue.Now let me review some more critical areas: frontend components, routing, and security/auth.Now let me look at a few more key files for security and quality review, including the recent changes around the UI, todo panel, and session lifecycle. I also want to check for any lint issues or code patterns.Now I have a good overview of the project. Let me compile the findings.

Key things noticed:
1. **Test failure**: `upload-routes.test.ts` fails because it cannot find the `yaml` package imported from `upload-routes.ts`. This is a real bug — `yaml` is in `dependencies` but apparently vitest can't resolve it. Wait, looking at the package.json, `yaml` IS in dependencies. But vitest runs with the server test and can't find it. Looking more carefully at the error: `Error: Cannot find package 'yaml' imported from /srv/repos/Multiplier-Labs/codekin/server/upload-routes.ts`. This might be a vitest/vite resolution issue. But it means one test file is completely failing.

2. **ESLint**: 1 error, 528 warnings. The error is likely important. I should check what the error is.

3. **Code quality concerns**:
   - `opencode-process.ts` line 162: `serverState.port = 14096 + Math.floor(Math.random() * 1000)` — port selection is random but could collide. No retry logic shown if port is in use.
   - `opencode-process.ts` line 183: `stdio: 'ignore'` — this prevents seeing stderr if the server fails to start.
   - `native-permissions.ts`: The `withLock` function catches errors from previous lock but doesn't propagate them. Line 21: `const next = prev.catch(() => {}).then(fn)` — this swallows errors silently. If a previous write fails, subsequent writes still proceed without knowing.
   - `orchestrator-children.ts` line 789: `return out.trim().length === 0` — this checks if the branch exists on remote, but `git ls-remote` output format could have empty lines? Actually `trim().length === 0` is okay.
   - `orchestrator-children.ts` line 698: `child.error = isError ? 'Claude returned an error' : missing ? ... : null` — but `isError` is a parameter. If `missing` is true but `isError` is false, the child status is still 'completed' (line 696), which seems contradictory — if completion isn't verified, marking as completed with an error message is a bit odd but intentional based on nudge logic.

4. **Security**:
   - `auth-routes.ts`: The IP-based rate limiter uses `req.ip` which can be spoofed if `TRUST_PROXY` is not configured correctly. But there is proxy trust configuration.
   - `config.ts` lines 72-81: `resolveRepoPathInRoot` uses `realpathSync` and checks `startsWith(REPOS_ROOT + '/')`. This is a path traversal defense. Good.
   - `upload-routes.ts` (didn't read fully): File uploads and repo listing. Need to check for path traversal in clone/upload routes.
   - `orchestrator-children.ts` line 773: `gh pr list` is executed. The `exec` function is injectable but the default `execFile` might be vulnerable to command injection if arguments aren't properly escaped. Looking at line 774-776: `['pr', 'list', '--head', branch, '--state', 'all', '--json', 'number', '--limit', '1']` — these are passed as args array, so safe from shell injection.
   - `session-manager.ts`: `cleanGitEnv` is imported but not shown.

5. **Performance**:
   - `opencode-process.ts` has a lot of complex state management. The SSE reconnect logic looks okay but the `handleSSEEvent` method is very long.
   - `orchestrator-outbox.ts`: Uses `JSON.stringify` synchronously. With 200 items, this is fine.
   - `session-manager.ts`: `MAX_HISTORY = 2000` — large history could cause memory issues over many sessions.

6. **Documentation**:
   - `CLAUDE.md` exists and seems up to date.
   - Many files have good JSDoc.

7. **Dependency issues**:
   - `undici` override in package.json: `"undici": "^7.24.0"` — this is interesting. Undici is a Node.js HTTP client. Overriding it might cause issues with Node's built-in fetch.
   - `package.json` uses `express ^5.1.0` — this is a very new major version, should be stable but worth noting.

8. **Critical: ESLint error**:
   - The output showed 1 error. I need to find it. Looking at the lint output, it shows warnings but no specific error file. Wait, it says `1 error`. Let me check again. Actually the output didn't show the error clearly. It might be from the `--fix` option message? Or maybe one of the warnings is actually an error? Wait, `✖ 529 problems (1 error, 528 warnings)`. I need to see the actual error. Let me run lint again or grep for 'error' in the output. Actually, looking back, the first warning in the lint output starts with line 3:1 in some file, but the file path is cut off. Let me check the first line of the lint output again:
   ```
   3:1  warning  Unused eslint-disable directive...
   ```
   Wait, where is the error? Maybe the error was cut off because `tail -n 30` was used. Let me run lint again and get the full output, or just grep for 'error' level.

Actually, I can just run `npm run lint | grep -E '^\\s*[0-9]+:[0-9]+\\s+error'` to find it.

Wait, but the instructions say not to use bash for grep-like operations. Hmm, but I'm just searching lint output. I can use bash with grep since it's not file content search. Or I can use `npm run lint 2>&1 | head -n 50` to see the top.Now I have gathered enough information to write a comprehensive code review report. Let me synthesize my findings from the codebase.

Key areas examined:
1. Project structure - 3 provider architecture (Claude, OpenCode, Codex)
2. Recent changes (last 7 days) - Codex provider, OpenCode resilience, Agent Joe orchestrator improvements, UI fixes
3. Critical files reviewed:
   - opencode-process.ts (1595 lines, complex SSE handling)
   - codex-process.ts (860 lines, JSON-RPC handling)
   - orchestrator-children.ts (813 lines, child session lifecycle)
   - orchestrator-outbox.ts (173 lines, persistent notifications)
   - orchestrator-manager.ts (437 lines, orchestrator lifecycle)
   - session-manager.ts, session-lifecycle.ts, process-coordinator.ts
   - config.ts, auth-routes.ts
   - upload-routes.ts (file upload handling)
   - App.tsx, SessionContent.tsx (frontend)
   - webhook-handler.ts (CI/PR automation)

Issues found:

CRITICAL:
1. `upload-routes.ts` import of `yaml` package fails - test fails because yaml package can't be found. Actually looking closer, `yaml` IS in package.json dependencies... but vitest fails to resolve it. Wait, I see `yaml` is listed in dependencies. This could be an ESM/CJS resolution issue or missing from server/package.json. Actually the server has its own package.json? Let me check.

Wait, I saw server/package-lock.json and server/package.json in the directory listing. Let me check if server/package.json exists and if yaml is there.

Actually I only read the root package.json which has yaml. The server might have its own package.json. I should check.

Also I noticed eslint has 1 error but I didn't see it in the head output. Let me look for it.

2. In `orchestrator-children.ts` line 698: `child.error = isError ? 'Claude returned an error' : missing ? 'Completion not verified...' : null` - this looks like nested ternary but is valid. However, `isError` is the parameter to `onResult`, not a property on `child`. Let me check... Actually in the context `isError` is the boolean parameter. This is fine.

3. `orchestrator-children.ts` line 697: `child.result = text || null` and line 698 `child.error = isError ? ...` - wait, `isError` is a boolean parameter. But on line 696 `child.status = isError ? 'failed' : 'completed'` - this is fine.

4. In `orchestrator-children.ts` `onResult` callback at line 653: `const session = this.sessions.get(child.id)` and then later line 670 `if (session.pendingToolApprovals.size > 0 || ...)` - but session can be null because `get` returns `Session | undefined`. Wait, no, SessionManager.get()... let me check. Actually line 655 already checks `if (!session)` and returns. So by line 670, session is defined. Good.

5. `orchestrator-children.ts` line 721: `let missing = session ? await this.isFinalStepMissing(child, text) : true` - but `text` is defined as `const text = session ? this.extractText(session.outputHistory) : ''` on line 718. OK.

6. In `codex-process.ts` line 576: `if (error?.codexErrorInfo === 'usageLimitExceeded')` - codexErrorInfo is typed as `unknown` in CodexThreadItem but compared to string. That's fine with the optional chain.

7. In `opencode-process.ts` around line 162: `serverState.port = 14096 + Math.floor(Math.random() * 1000)` - random port selection could collide. Should check if port is in use.

8. `opencode-process.ts` line 182: spawn uses stdio: 'ignore' - fine.

9. In `opencode-process.ts` `ensureOpenCodeServer` - singleton pattern. But what if workingDir changes between sessions? The server is shared across all sessions with a single workingDir from the first call. That's by design since OpenCode server handles multiple sessions.

10. `native-permissions.ts` line 80: `writeFileSync(tmp, JSON.stringify(settings, null, 2) + '\n', { mode: 0o600 })` - atomic write with proper permissions. Good!

11. `auth-routes.ts` line 39-42: Rejects new IPs if map is too large. Good DoS protection.

12. `config.ts` lines 25-33: Hard exit in production if CORS_ORIGIN misconfigured. Good security practice.

13. `orchestrator-outbox.ts` lines 77-83: Clears items before sending. If `sessions.sendInput` throws, items are lost. Comment acknowledges this trade-off. This is a known risk.

14. `codex-process.ts` `fetchCodexModels` - spawns a short-lived app-server. No cleanup of the readline interface on early return paths (lines 145-148). `rl` is created after `proc` but if spawn fails, `rl` is never created and never cleaned up. If spawn succeeds but timer fires, `done` kills proc but doesn't close rl. Minor leak.

15. `opencode-process.ts` `subscribeToEvents` - SSE reconnection logic. Reconnect attempts capped at 20, then gives up and calls `this.stop()`.

16. `orchestrator-manager.ts` line 45: `CLAUDE_MD_TEMPLATE_VERSION = 2` - template versioning for orchestrator instructions. Good.

17. `session-lifecycle.ts` line 81: worktree validation - checks if `.git` exists in workingDir. Good.

18. `session-lifecycle.ts` line 121: `const sessionToken = this.deps.authToken ? deriveSessionToken(...) : ''` - if no auth token, empty string is passed. This means auth is effectively disabled. Is this intentional? The comment says "limits child process privileges" but if authToken is empty, sessionToken is empty. This seems like a security concern but might be intentional for dev mode.

19. `session-lifecycle.ts` line 129: `CODEKIN_TOKEN` and `CODEKIN_AUTH_TOKEN` both set to same derived value. Good backward compat.

20. `upload-routes.ts` line 221: `upload.single('file')(req, res, (err: unknown) => {...})` - Multer middleware applied inline. The outer middleware `(req, res, next)` calls `upload.single('file')(req, res, cb)` which is correct.

21. `upload-routes.ts` line 239-249: Magic-byte validation for binary types using `fileTypeFromFile`. Good security practice.

22. `webhook-handler.ts` line 88-91: Auto-kills PR review sessions after completion with `setTimeout(() => { this.sessions.delete(sessionId) }, 2000)`. Good cleanup.

23. `webhook-handler.ts` line 63: `this.updateEventStatus(event.id, status, code !== 0 ? 'Claude exited...' : undefined)` - maps exit code to status.

24. `orchestrator-children.ts` line 613-616: When timeout fires, stops the Claude process. Good.

25. `orchestrator-children.ts` line 625: `blockedTimer ??= setTimeout(...)` - uses nullish coalescing assignment. Good.

26. `orchestrator-children.ts` line 642-646: work timer started. But if `remainingMs` is 0 (edge case from pause/resume), setTimeout fires immediately. Should guard against 0.

27. `orchestrator-children.ts` line 624: `remainingMs = Math.max(0, remainingMs - (Date.now() - workStartedAt))` - OK, ensures non-negative.

28. `codex-process.ts` `handleServerRequest` line 482: `this.write({ id: rpcId, error: { code: -32601, message: ... } })` - returns JSON-RPC error for unsupported methods. Good.

29. `codex-process.ts` line 391: `timeoutMs: number = RPC_TIMEOUT_MS` - default 30s. For long turns, timeoutMs=0 disables. Good.

30. `opencode-process.ts` line 401: `turnComplete` and `turnInFlight` - two latches. The comment about turn watchdog is good.

31. `opencode-process.ts` line 410: `pendingMessages` - messages queued while turn in flight. Good.

32. `opencode-process.ts` line 412: `recentOutputText` - for resume hydration dedup. Good.

33. `opencode-process.ts` line 429-433: delta buffer for user echo detection. Good UX.

34. ESLint: 1 error. Need to find it. The output showed 529 problems (1 error, 528 warnings). Let me search for the error in the lint output.

Actually, I didn't capture the error line. Let me check if it's in the server files or src files. The head of the lint output shows warnings only. The error might be later in the output.

Let me grep for 'error' in the lint output or just look at a specific file. Or maybe it's in the src/hooks/useTentativeQueue.ts at line 86 but that's a warning.

Actually looking at the very end of the lint output:
```
✖ 529 problems (1 error, 528 warnings)
  0 errors and 266 warnings potentially fixable with the --fix` option.
```

And earlier I see at the very top of the second lint command output:
```
/srv/repos/Multiplier-Labs/codekin/src/hooks/useTentativeQueue.ts
  86:11  warning  Unnecessary conditional...
```

I need to find that one error. Let me run eslint and filter.

Actually, I already ran `npm run lint` and got the output. But the error wasn't shown in the snippets I captured. Let me search by piping to grep.

But for the review, I can note that there is 1 ESLint error. I'll mention it generally or try to find it specifically.

Wait, looking at the first lint output tail:
```
/srv/repos/Multiplier-Labs/codekin/src/main.tsx
  6:12  warning  Forbidden non-null assertion  @typescript-eslint/no-non-null-assertion

✖ 529 problems (1 error, 528 warnings)
```

The error is not shown in the tail because it's probably in the middle. Let me get just the error.

Actually, the lint output is quite long. The error could be anywhere. But I can see from the first lint call head that the first file was `src/hooks/useTentativeQueue.ts` with a warning. The error might be in a file alphabetically before that. But since it's sorted alphabetically, it would have appeared before `src/hooks/useTentativeQueue.ts`. Actually no, the output seems to group by file path. Let me check.

Files in the first lint output head:
- server/anthropic-models.ts
- server/approval-manager.ts
- server/auth-routes.ts
- server/claude-process-start.test.ts
- server/claude-process.test.ts
- server/claude-process.ts

The error could be in any file before `server/anthropic-models.ts` alphabetically, like `server/...` actually no, `server/anthropic-models.ts` is near the top. Files before it would be like `server/...` no, 'a' is early. The error could be in `src/...` files, which come after `server/...`. So it's somewhere in the full output but not shown in the snippets.

Wait, in the second lint call, I did `head -n 40` which showed server files. The error might be in a file that comes later.

For the code review, I can note there is 1 ESLint error remaining and provide the count.

But let me try to quickly find it with grep.

Actually, let me just focus on writing the report. I have enough information.

Let me also check the coverage quickly from the test run: 91 passed, 1 failed. 2353 tests passed. The coverage was enabled but I didn't see the coverage summary. The test suite is substantial.

Now let me structure the review:

### Project Health (last 7 days)
- 20+ commits: Codex provider, OpenCode resilience, Agent Joe orchestrator improvements (child sessions, outbox, ground-truth verification, pausable timeouts, worktrees), UI fixes (dark mode, dropdown), docs.
- v0.7.0 released.
- 2353 server tests passing (1 test file failing due to import resolution).

### CRITICAL
1. **Import failure in upload-routes tests** - `yaml` package import fails in `server/upload-routes.test.ts`. This is a runtime/test failure. Even though `yaml` is in root package.json, the server tests fail to resolve it. This blocks CI. [server/upload-routes.test.ts:44, server/upload-routes.ts:17]
2. **ESLint error** - 1 unresolved ESLint error remains across the codebase (528 warnings also exist). Need to identify and fix.
3. **Potential data loss in outbox flush** - `orchestrator-outbox.ts` clears queued items BEFORE calling `sessions.sendInput()`. If `sendInput` throws (e.g., process dies mid-call), the notification is permanently lost. [server/orchestrator-outbox.ts:79-83]
4. **CodexProcess JSON-RPC request ID type mismatch** - `serverApprovals` map keys are strings (`${APPROVAL_ID_PREFIX}${rpcId}`) but `rpcId` can be `number | string`. The key construction uses template literal which coerces to string, but `pending` map keys are numbers (`this.nextRpcId++`). Server requests use `msg.id` which can be string. In `handleServerRequest`, `rpcId` is typed as `number | string` but `serverApprovals.set(requestId, { rpcId, method })` stores it. In `sendPromptResponse`, `const info = this.serverApprovals.get(requestId)` and then `this.write({ id: info.rpcId, ... })` - if `info.rpcId` is a string and the server expects a number for JSON-RPC, this is fine because JSON-RPC allows string IDs. But `pending.get(msg.id as number)` in `handleLine` assumes `msg.id` is a number, which could be unsafe if the server returns a string ID. [server/codex-process.ts:426]
5. **OpenCode singleton server workingDir is sticky** - `ensureOpenCodeServer` uses the first `workingDir` forever. If sessions switch to different repos, the OpenCode server still runs in the original directory. This could cause context confusion. [server/opencode-process.ts:141]
6. **orchestrator-children.ts: remainingMs edge case** - When `remainingMs` becomes 0 after pause/resume, `workTimer = setTimeout(() => fireTimeout(...), remainingMs)` fires immediately in the same event loop tick, causing an instant timeout. Should guard with `Math.max(1, remainingMs)` or check for 0. [server/orchestrator-children.ts:634]
7. **OpenCodeProcess missing signal timeout on createRes** - `fetch` to create session doesn't use an AbortSignal.timeout, unlike other calls. A hung create could stall initialization indefinitely. [server/opencode-process.ts:512-527]

### WARNING
1. **CodexProcess readline leak in fetchCodexModels** - If the 15s timer fires, `done([])` kills the process but never closes the `readline` interface, leaking memory. [server/codex-process.ts:131-167]
2. **Magic byte validation only for binary types** - `upload-routes.ts` only validates file signatures for images. Text/markdown uploads have no content validation, allowing potential XSS if markdown is rendered unsafely. However, markdown rendering uses DOMPurify so this is mitigated. Still worth noting.
3. **ClaudeProcess non-null assertions** - Multiple `!` assertions in claude-process.ts (lines 271, 272, 274, etc.) could mask null dereference bugs. [server/claude-process.ts]
4. **SessionLifecycle empty auth token** - If `AUTH_TOKEN` is not set, `sessionToken` becomes empty string, meaning child processes receive empty auth tokens. This effectively disables session-scoped auth. Should probably refuse to start in production without auth. [server/session-lifecycle.ts:121-123]
5. **orchestrator-children.ts dedup set memory leak** - `notifiedPromptIds` is a Set with a cap of 500, but old entries are dropped via insertion order iteration. However, `requestId` values from child sessions could be UUIDs, and with high churn, the set fills up quickly. The oldest eviction is fine but the Set iteration to find oldest is O(n). With 500 entries this is negligible.
6. **ProcessCoordinator enqueue type safety** - `enqueue` uses `!` definite assignment assertions for `resolve`/`reject`. While standard for promise constructor pattern, it's a type-system bypass. [server/process-coordinator.ts:147-149]
7. **Diff panel file change heuristic** - `tool === 'edit' || tool === 'write' || tool === 'patch'` is case-insensitive via `.toLowerCase()` but doesn't catch all file-mutating tools (e.g., `NotebookEdit`, `Bash(rm:*)`, etc.). [src/App.tsx:187-189]
8. **OpenCodeProcess SSE reconnection exhaustion** - After 20 reconnect attempts, `this.stop()` is called but the method doesn't emit 'exit' with a code since it's not a child process. Frontend might not show disconnection properly. [server/opencode-process.ts:597-599]
9. **orchestrator-manager.ts template literal injection** - `CLAU_MD_TEMPLATE` embeds `AGENT_DISPLAY_NAME` directly. If the display name contains backticks or markdown characters, the template could be malformed. However, display name is controlled by env var / admin, not user input. Low risk.

### INFO
1. **Excellent test coverage** - 2353 tests across 92 files. Strong coverage.
2. **Good security practices** - HMAC verification, CORS hardening, rate limiting, per-IP caps, file signature validation, atomic file writes with 0o600 permissions, symlink traversal prevention.
3. **Well-documented orchestrator architecture** - `CLAUDE.md` template is versioned (v2) and auto-refreshed.
4. **Ground-truth verification** - orchestrator-children now verifies PR/branch existence via `gh`/`git` instead of transcript sniffing. Good improvement.
5. **ProcessCoordinator mutex** - Good concurrency control replacing scattered flags.
6. **Pausable child timeouts** - Blocked time is separately budgeted from working time.
7. **Persistent outbox** - Notifications survive server restarts.
8. **UI improvements** - Dark mode fixes, compact provider dropdown.
9. **Upload file size limit** - 20MB cap with multer. Good.
10. **License notes** - Package.json includes license compatibility notes for MPL-2.0 dependencies. Good diligence.

Wait, I should verify the `yaml` import issue more carefully. `yaml` is in the root package.json dependencies, but `upload-routes.test.ts` says `Cannot find package 'yaml'`. This is likely because the server tests are run from the root with vitest, and `yaml` is an ESM-only package or there's a module resolution issue. But root package.json says `"type": "module"`. Let me check if `yaml` is actually installed in node_modules.

Actually, the test command ran 91 passed suites and 1 failed. 2353 tests passed. So `yaml` IS resolvable for most tests but `upload-routes.test.ts` specifically fails. This might be because `upload-routes.ts` imports `yaml` directly, but perhaps there's a server-specific node_modules? No, the root is the workspace.

Wait, looking at the error: `Cannot find package 'yaml' imported from /srv/repos/Multiplier-Labs/codekin/server/upload-routes.ts` — this is a Node.js native ESM resolution error. It means the `yaml` package is literally not found in node_modules. Maybe it wasn't installed? Let me check quickly.

Actually, since I can't run more commands without being careful about timeouts, I'll note this as a test infrastructure issue that needs fixing.

Also, I want to check if there's a `server/package.json` that might be missing `yaml`.

Let me look at `server/package.json` if it exists.Now I have enough context. Let me search for the specific lint error at line 44:29 to understand the issue.Now let me synthesize the review. I have a comprehensive understanding of the project, its architecture, recent changes, and the state of tests/linting.

Key findings:

**CRITICAL:**
1. ESLint error in `server/upload-routes.ts:44` — `parseYaml(rawFrontmatter)` call fails type resolution because `yaml` is declared in root `package.json` but the server package is missing it. Test suite (`upload-routes.test.ts`) also fails because of this import error. Root cause: monorepo root has `yaml` but the server workspace doesn't get it installed correctly. Actually `yaml` IS in root package.json dependencies, but node_modules/yaml is missing — this is a dependency resolution issue. The `upload-routes.ts` import `import { parse as parseYaml } from 'yaml'` uses an ESM named import. If the package isn't installed in node_modules, or if its types are missing, `parseYaml` becomes `any` and the call becomes an `unsafe-call` error.

Actually looking at root `package.json`, `yaml` is in dependencies. But `node_modules/yaml` doesn't exist. This means dependencies are not installed properly or the package was removed. This is a real problem because it breaks the build/tests.

Wait, the vitest output says: "Cannot find package 'yaml' imported from /srv/repos/Multiplier-Labs/codekin/server/upload-routes.ts". So `yaml` is not installed. But it IS in the root package.json. This might mean someone forgot to run `npm install` after adding it, or it's a workspace issue. This is a critical issue.

2. `server/package.json` has its own dependency list that does NOT include `yaml`, `file-type`, `dompurify`, `marked`, etc., but these are all in root `package.json`. The server code uses `yaml` and `file-type` and `multer`, `better-sqlite3`, etc. The root package.json has everything. But the server tests fail to find `yaml`.

This is a workspace / monorepo dependency resolution issue. In a pnpm workspace (there's pnpm-lock.yaml), packages should be hoisted. But there might be a lockfile mismatch or npm vs pnpm conflict.

Wait, there is BOTH `package-lock.json` AND `pnpm-lock.yaml`. This is a major red flag — using both npm and pnpm will cause dependency resolution issues. The `package.json` scripts say `npm install`. But the presence of `pnpm-lock.yaml` suggests pnpm is also used. This is a recipe for confusion.

Let me check if `yaml` is actually present: `ls node_modules/yaml` said it doesn't exist. So the install is incomplete. The test failure is real.

**WARNINGS:**
3. ESLint: 528 warnings, many of which are `no-unsafe-call`, `no-non-null-assertion`, `no-unnecessary-condition`, `no-confusing-void-expression`, `no-base-to-string`. These aren't blocking the build but indicate areas where types are weak or logic is brittle. The `no-base-to-string` warnings in `codex-process.ts` (lines 608, 662, 668, etc.) are particularly concerning because they mean string coercion of potentially object values, which could produce `[object Object]` in user-facing output.

4. In `server/codex-process.ts`, `permissionMode` has a check for `autoApprove` (line 444), but `acceptEdits` is checked for file changes (line 464) but NOT for command execution (line 448). This means `acceptEdits` mode auto-approves file changes but not commands. That seems intentional from the code, but it might be inconsistent with user expectations.

5. In `server/orchestrator-children.ts` `buildHintLine` (line 458), it accesses `session?.worktreePath` directly. The `worktreePath` is stored on the child object, not on the session. Wait, looking at the Session type in `types.ts`, sessions may have `worktreePath`. In `orchestrator-children.ts`, line 460: `const worktreePath = session?.worktreePath`. If `session` is the SessionManager's session object, it has `worktreePath`. But if it's the child session object, it does not. Actually `this.sessions.get(child.id)` returns a `Session` object, which might have `worktreePath`. But earlier in `session-lifecycle.ts`, when a worktree is created, it sets `session.worktreePath`. So this is likely fine.

6. `server/orchestrator-children.ts` `isFinalStepMissing` (line 764): For `commit-only`, it returns `false` immediately (line 766). But then in `monitorChild` (line 724-725): "commit-only has no remote artifact to verify; an exit without any output cannot be considered a success." So it overrides `missing = true` if there's no text. This seems correct — if there's no text output, it's a failure even for commit-only. But the `isFinalStepMissing` doesn't know about text length. This is handled in the caller (`onExit`), so it's fine.

7. `server/opencode-process.ts` line 162: `serverState.port = 14096 + Math.floor(Math.random() * 1000)`. This selects a random port without checking if it's in use. With 1000 possible ports, collision probability is low but non-zero. No retry on port conflict.

8. `server/opencode-process.ts` line 198: `fetch` with `AbortSignal.timeout(2000)` — this is a very short timeout for health checks. Might be too aggressive on slower systems.

9. `server/opencode-process.ts` line 181: `stdio: 'ignore'` for the OpenCode server process. If the server crashes, stderr is lost, making debugging hard.

10. `server/config.ts` line 14: `import { execFileSync } from 'child_process'` — this is used for `which claude` at module load time. If `which` is not available or `claude` is not in PATH during startup, it falls back gracefully. OK.

11. `server/auth-routes.ts` line 27: `if (cleanup.unref) cleanup.unref()` — ESLint warns this is always truthy. In Node.js, `setInterval` returns a `Timeout` object which always has `unref`. So this is just defensive coding. Not a bug.

12. `server/upload-routes.ts` line 188: `file.originalname.slice(0, 64).replace(...)` — originalname comes from the client and can be spoofed. This is used only for the filename on disk. It's safe because it goes through regex sanitization.

13. `server/upload-routes.ts` line 212-230: The multer error handler doesn't validate that `err` is actually a multer error before using `err instanceof multer.MulterError`. Actually it does: `err instanceof multer.MulterError`. This is fine.

14. `src/App.tsx` line 60-62: `localStorage.getItem('codekin-active-session')` — no validation that the session ID exists or is a valid UUID. This is UI state, not a security issue.

15. `src/App.tsx` line 116-122: `permissionModeRef` and `providerRef` read from `localStorage` without validation. Malformed values could be passed to the WebSocket. The server likely validates, but it would be cleaner to validate on the client.

16. `server/session-manager.ts` line 122: `private sessions = new Map<string, Session>()` — sessions are stored in memory. No upper bound on number of sessions except for headless stale pruning. Could lead to memory pressure if many sessions are created rapidly.

17. `server/session-manager.ts` line 46: `MAX_HISTORY = 2000` — the output history buffer is capped at 2000 messages, but there's no bound on the size of each message. A malicious session could produce very large messages and consume memory.

18. `server/claude-process.ts` (from lint warnings): `no-base-to-string` warnings indicate potential object-to-string coercion in tool input handling. This could produce `[object Object]` in user-facing strings.

19. `server/opencode-process.ts` line 400-445: extensive per-turn state tracking. The complexity is high, and the risk of state desync between SSE events and internal flags is significant. This is a known risk documented in comments.

20. `server/orchestrator-children.ts` line 114-158: `AGENT_CHILD_ALLOWED_TOOLS` is a long allowlist. It uses wildcard patterns like `Bash(git:*)`. If the underlying CLI's pattern parser has bugs (e.g., with parentheses), this could break. The `escapeForAllowedTools` function in `native-permissions.ts` is aware of this.

21. `server/codex-process.ts` line 86: `const CODEX_BINARY = process.env.CODEX_BINARY || 'codex'` — the binary is not validated at startup. If `codex` is not installed, the process will fail at spawn time. For OpenCode, the server validates via `which` in `config.ts`? No, `config.ts` only resolves `claude`. OpenCode and Codex binaries are not pre-checked.

22. `server/orchestrator-children.ts` line 330-332: `if (this.activeCount() >= MAX_CONCURRENT) throw new Error(...)`. This is fine, but the error is not typed.

23. `server/orchestrator-children.ts` line 353-362: `this.sessions.create(...)` is called with `source: 'agent'`. But `CreateSessionOptions` has `source?: 'manual' | 'webhook' | 'workflow' | 'stepflow' | 'orchestrator' | 'agent'`. So `'agent'` is valid.

24. `server/orchestrator-notify.ts` line 57: `outbox.enqueue` is called without an `id` or `queuedAt` field. Wait, the `NotificationOutbox` interface only requires `label`, `title`, `body`. The actual `OrchestratorOutbox.enqueue` adds `id` and `queuedAt`. This is fine.

25. `server/orchestrator-outbox.ts` line 66-83: `flush` clears items before sending. If `sessions.sendInput` throws, the items are lost. The comment acknowledges this trade-off.

26. `server/native-permissions.ts` line 80: `writeFileSync(tmp, JSON.stringify(settings, null, 2) + '\n', { mode: 0o600 })`. This sets permissions correctly, but `renameSync` is atomic on the same filesystem. If `tmp` is on a different mount, it won't be atomic. Usually not an issue.

27. `server/config.ts` line 19: `PORT = parseInt(process.env.PORT || '32352', 10)` — if `PORT` is set to a non-numeric string, `parseInt` returns `NaN`, which could break the server. Should validate.

28. `server/config.ts` line 72-81: `resolveRepoPathInRoot` uses `realpathSync`. This resolves symlinks, which is good for security. But if `REPOS_ROOT` itself is a symlink, it works because `REPOS_ROOT` is already resolved via `realpathSync` on line 62-64.

29. `server/webhook-handler.ts` line 86-91: `setTimeout(() => { this.sessions.delete(sessionId) }, 2000)`. If the session is referenced elsewhere, `delete` might fail silently or cause issues. The `SessionManager.delete` method probably handles cleanup.

30. `server/webhook-handler.ts` line 58-72: `sessions.onSessionExit` listener. This adds a listener per WebhookHandler instance. Since WebhookHandler is likely a singleton, this is fine.

**INFO:**
31. High test coverage — 2353 tests passing, 91/92 test files pass. The single failure is `upload-routes.test.ts` due to missing `yaml` dependency.

32. Documentation: Recent commits include docs for Codex, OpenCode, Agent Joe, visual updates, and UI style audits.

33. No obvious security vulnerabilities in auth handling. Auth token is derived per-session using HMAC (`deriveSessionToken`).

34. Rate limiting is present on auth endpoints and WebSocket origins.

35. CORS origin is validated in production.

36. Process environment variables are filtered before spawning child processes (`API_KEY_VARS`, `GIT_*` stripping).

37. The project uses both `package-lock.json` and `pnpm-lock.yaml`. This is a potential source of dependency drift. The `package.json` scripts reference `npm`, but `pnpm-lock.yaml` exists. One should be removed to avoid confusion.

Let me compile this into a proper report.```markdown
# Daily Code Review — 2026-06-14

**Project:** Codekin v0.7.0  
**Commits reviewed:** e354256..e2795c5 (last 7 days)  
**Test result:** 2353 passed / 2353 tests, 91/92 suites pass, 1 suite failed  
**Lint result:** 1 error, 528 warnings

---

## Executive Summary

The past week delivered three major feature sets: **OpenAI Codex CLI as a third provider** (PR #499), **Agent Joe orchestrator child-session improvements** (PRs #498–#505), and **OpenCode resilience hardening** (PRs #493–#500). There is also UI polish (dark-mode fixes, compact provider dropdown) and documentation updates. The codebase is well-tested and generally well-structured, but **one dependency issue is currently breaking a test suite and producing a build error**, and several lint/type warnings hint at brittle coercion patterns in the new provider integrations.

---

## CRITICAL

### 1. Missing `yaml` package breaks `upload-routes` tests and ESLint
- **File:** `server/upload-routes.ts:17`, `server/upload-routes.test.ts`
- **Error:** `Cannot find package 'yaml' imported from server/upload-routes.ts`
- **ESLint:** `44:29  error  Unsafe call of a type that could not be resolved`
- **Impact:** Test suite `upload-routes.test.ts` fails; build may fail if that module is loaded before `yaml` is installed.
- **Root cause:** `yaml` is declared in the root `package.json` dependencies but is not present in `node_modules`. The workspace also has a separate `server/package.json` that does not list it.
- **Action:** Run `npm install` (or `pnpm install`) to sync the lockfile with `package.json`. Verify the package appears in `node_modules/yaml`. If using pnpm workspaces, ensure the root dependency is hoisted to the server workspace.

### 2. Dual lockfiles (`package-lock.json` + `pnpm-lock.yaml`) risk dependency drift
- **Files:** `package-lock.json`, `pnpm-lock.yaml`
- **Impact:** Different installs (`npm` vs `pnpm`) can produce different dependency trees. CI may use one while local dev uses the other. This is the most likely reason `yaml` is missing from `node_modules` despite being in `package.json`.
- **Action:** Delete one lockfile and standardize on a single package manager. Update CI and documentation accordingly.

---

## WARNING

### 3. Unsafe object-to-string coercion in Codex process tool handling
- **File:** `server/codex-process.ts`
- **Lines:** 608, 662, 668, 670, 677, 681, 683, 688, 696
- **Lint rule:** `@typescript-eslint/no-base-to-string`
- **Detail:** Expressions like `toolInput.command || ''`, `item.id || ++this.taskSeq`, and `input.subject || ''` can produce `"[object Object]"` if the value is an object rather than a string/number. In a streaming UI this results in garbage text or broken task IDs.
- **Action:** Add explicit type guards or use `String(x)` with validation. For example:
  ```ts
  const cmd = typeof toolInput.command === 'string' ? toolInput.command : ''
  ```

### 4. Non-null assertions and unnecessary optionals in core server files
- **File:** `server/claude-process.ts`
- **Lines:** 271, 274, 391, 436, 484, 487, 496, 577
- **Rules:** `no-non-null-assertion`, `no-unnecessary-condition`, `no-confusing-void-expression`
- **Impact:** These weaken TypeScript's safety net in the most critical process-spawning code. A regression in Node.js stdio types or process lifecycle could turn into a runtime crash.
- **Action:** Replace `!` assertions with explicit null checks and use `void` or braces for side-effect arrow functions.

### 5. Client-side localStorage values are not validated before use
- **File:** `src/App.tsx`
- **Lines:** 60–62, 115–122
- **Detail:** `localStorage.getItem('codekin-active-session')`, `'claude-permission-mode'`, and `'codekin-provider'` are read without validation and passed directly into refs/WebSocket calls. A corrupted localStorage entry (e.g. from a browser extension or manual edit) could inject an invalid provider or permission mode.
- **Action:** Add a small validation helper:
  ```ts
  const validProviders: CodingProvider[] = ['claude', 'opencode', 'codex']
  const provider = validProviders.find(p => p === stored) || 'claude'
  ```

### 6. OpenCode server port selection does not check for conflicts
- **File:** `server/opencode-process.ts:162`
- **Code:** `serverState.port = 14096 + Math.floor(Math.random() * 1000)`
- **Impact:** With 1000 ephemeral ports the collision probability is ~0.1% per launch, but on busy hosts it could cause "address already in use" errors. The health-check loop then fails and throws.
- **Action:** After picking a port, attempt a `net.createServer().listen(port)` probe before spawning `opencode serve`, or catch `EADDRINUSE` and retry up to N times.

### 7. OpenCode server stderr is discarded
- **File:** `server/opencode-process.ts:183`
- **Code:** `stdio: 'ignore'`
- **Impact:** If the OpenCode server fails to start, there is no stderr capture for diagnostics. The only signal is the health-check timeout.
- **Action:** Pipe stderr to a log file or capture the last N lines in memory (similar to `codex-process.ts` `stderrTail`).

### 8. Session output history has unbounded message size
- **File:** `server/session-manager.ts:46`
- **Code:** `const MAX_HISTORY = 2000`
- **Impact:** While the *count* of messages is capped, the *size* of each message is not. A malicious or runaway session emitting megabyte-sized `output` or `diff_result` messages could exhaust heap memory.
- **Action:** Add a per-message size cap (e.g. 128 KB) or a total-history byte budget, truncating oversized messages and logging a warning.

### 9. Port parsing in config lacks NaN guard
- **File:** `server/config.ts:19`
- **Code:** `export const PORT = parseInt(process.env.PORT || '32352', 10)`
- **Impact:** If `PORT=foo`, `parseInt` returns `NaN`, and the server later passes `NaN` to `server.listen()`, which throws an obscure error.
- **Action:** Validate and provide a clear startup error:
  ```ts
  const parsed = parseInt(process.env.PORT || '32352', 10)
  if (Number.isNaN(parsed)) { console.error(...); process.exit(1) }
  ```

### 10. Plan-mode permission lifecycle may auto-approve read-only tools unexpectedly
- **File:** `server/native-permissions.ts:124`
- **Code:** `const preApproved = new Set(['Read', 'Write', 'Edit', 'Glob', 'Grep', 'NotebookEdit'])`
- **Detail:** `Write` and `Edit` are in the pre-approved set, but `plan` mode is supposed to be read-only. The mapping happens in `PromptRouter`, which may filter these out before they reach native permissions. Still, having `Write`/`Edit` in a list called `preApproved` is a foot-gun if any caller skips `PromptRouter`.
- **Action:** Rename to `nonPersistentTools` or split into read-only and edit sets to make intent explicit.

---

## INFO

### 11. Test suite health
- **Passing:** 2353 tests across 91 suites.
- **Failing:** 1 suite (`upload-routes.test.ts`) — see Critical #1.
- **Recommendation:** Once the `yaml` dependency is fixed, confirm this suite passes and consider adding a CI gate that fails on any test failure.

### 12. ESLint warning volume
- **Total:** 528 warnings (266 auto-fixable).
- **Categories:** `no-unnecessary-condition`, `no-base-to-string`, `no-non-null-assertion`, `no-confusing-void-expression`, `use-unknown-in-catch-callback-variable`.
- **Recommendation:** Schedule a cleanup PR to batch-fix auto-fixable warnings and tighten `no-base-to-string` in provider files.

### 13. Documentation coverage
- Recent commits added docs for Codex integration, OpenCode resilience, Agent Joe capabilities, and UI style audits. This is positive.
- **Gap:** No inline architecture doc explaining how the three providers (Claude, OpenCode, Codex) differ in their permission models. A short `docs/providers.md` would help future reviewers.

### 14. Security posture
- Auth tokens are derived per-session via HMAC (`deriveSessionToken`).
- CORS origin is validated in production.
- Env var filtering (`API_KEY_VARS`, `GIT_*` stripping) is applied consistently across all three provider spawn paths.
- Repo path traversal is guarded by `resolveRepoPathInRoot` with `realpathSync`.
- File uploads validate magic bytes (`fileTypeFromFile`).
- **No new vulnerabilities identified.**

### 15. Provider parity
- Codex and OpenCode both implement `CodingProcess` and map to the same `ClaudeProcessEvents` interface. This is good abstraction hygiene.
- `seedTasks` is a no-op in `CodexProcess` (line ~3b8b882), which is acceptable since Codex does not emit todo events natively. A comment in the source explaining why it's a no-op would be helpful.

---

## Actionable Checklist (prioritized)

1. **Fix `yaml` dependency** — run install, verify `node_modules/yaml` exists, re-run `upload-routes.test.ts`.
2. **Remove dual lockfiles** — pick npm or pnpm, delete the other lockfile, update CI/docs.
3. **Fix `no-base-to-string` warnings** in `server/codex-process.ts` to prevent `[object Object]` in streamed output.
4. **Add localStorage validation** in `src/App.tsx` for `provider` and `permissionMode`.
5. **Add NaN guard** for `PORT` in `server/config.ts`.
6. **Add port-conflict retry** in `server/opencode-process.ts`.
7. **Add per-message size cap** to session output history.
8. **Batch-fix auto-fixable ESLint warnings** in a dedicated PR.
```