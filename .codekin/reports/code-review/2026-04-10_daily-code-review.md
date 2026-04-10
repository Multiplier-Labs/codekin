# Daily Code Review — 2026-04-10

**Repository**: Codekin v0.5.4  
**Scope**: Full codebase + last 7 days of commits  
**Reviewer**: Automated (Claude Code)

---

## Recent Commits (Last 7 Days)

| Commit | Description |
|--------|-------------|
| `dcc74c0` | chore: add test coverage report for 2026-04-10 |
| `0c4da06` | Merge: enforce report file output |
| `3e2165d` | fix: add CLAUDE.md instructions to enforce report file output |
| `f6c6448` | fix: respect permission mode for file tool auto-approval in hook (#316) |
| `aee3f00` | chore: housekeeping — fix contradictory comments, prune stale branches (#315) |
| `f413798` | fix: strip uninformative agent noise lines from chat display (#313) |
| `bd3a0cc` | Merge: security audit findings (M1, M2, W-2/L4) |
| `3e7d70d` | fix: address three security audit findings (M1, M2, W-2/L4) |
| `472d93d` | refactor: extract session lifecycle into session-lifecycle.ts (#308) |
| `01b0ea0` | fix: strip GIT_* env vars when spawning Claude CLI processes (#307) |
| `a32481a` | test: add unit tests for session restart and worktree fixes (#306) |

---

## Critical

None identified. Recent security audit findings (M1, M2, W-2/L4) were addressed in `3e7d70d`.

---

## Warnings

### W-01: Missing Tests for `session-lifecycle.ts` (New Refactored Module)

**File**: `server/session-lifecycle.ts` (417 lines)  
**Context**: Extracted from `SessionManager` in commit `472d93d`. Contains all Claude process start/stop/restart/event-wiring logic.  
**Issue**: No dedicated test file exists for this module. The restart decision logic (`evaluateRestart`), backoff calculations, and event wiring are critical paths with no isolated coverage. The existing `session-manager.test.ts` covers the manager's surface, but not the lifecycle module's internals.  
**Recommendation**: Add `server/session-lifecycle.test.ts` covering at minimum: process start/stop, restart with backoff, restart loop prevention, and event wiring.

---

### W-02: Missing Tests for `prompt-router.ts` (New Refactored Module)

**File**: `server/prompt-router.ts` (extracted in a recent refactor)  
**Context**: Extracted from `SessionManager` in commit `cc43f9e`. Routes tool approval dialogs and control requests.  
**Issue**: No dedicated test file for this module. Tool approval routing logic is complex and security-sensitive.  
**Recommendation**: Add `server/prompt-router.test.ts` covering: tool approval routing, control request handling, and edge cases where both paths might be triggered.

---

### W-03: Cross-Repo Approval Threshold Is Low

**File**: `server/approval-manager.ts` (line ~22)  
**Issue**: `CROSS_REPO_THRESHOLD = 2` — if any 2 repos have approved a tool/command, it is auto-approved across all other repos. This is a low bar. A single compromised or carelessly-configured repo pair could pollute the global approval registry.  
**Recommendation**: Raise to 5 or make the threshold configurable via `config.ts`. Consider a "trusted repos" allowlist for cross-repo inference.

---

### W-04: Output History Has No Eviction Policy

**File**: `server/session-manager.ts` (around `MAX_HISTORY = 2000`)  
**Issue**: `MAX_HISTORY` caps the replay buffer, but if a session generates output faster than the cap, older messages are dropped silently. More critically, if the constant is a ceiling and not enforced as a circular buffer, a rapidly-outputting session could hold far more messages in memory.  
**Recommendation**: Confirm the buffer is a circular/sliding window (evicting oldest entries). If not, implement eviction. Add a comment in the code documenting the eviction strategy.

---

### W-05: Silent Catch in Native Permissions

**File**: `server/native-permissions.ts` (approx. lines 49–64)  
**Issue**: Corrupted or unreadable `.claude/settings.local.json` is silently swallowed with `catch { return [] }`. The user loses their approval registry with no indication.  
**Recommendation**: Log a `console.warn` with the file path and error message when parsing fails. Previous fix `57516a9` added logging to other silent catches in the repo — apply the same pattern here.

---

### W-06: Auth Fallback Allows Unauthenticated Access Outside Explicit `NODE_ENV=production`

**File**: `server/ws-server.ts` (auth token check block)  
**Issue**: The unauthenticated-server warning only escalates to a fatal error when `NODE_ENV === 'production'`. If the server is deployed without explicitly setting `NODE_ENV`, it accepts connections with no auth.  
**Recommendation**: Add an additional check: if `CORS_ORIGIN` is set (indicating a public deployment), treat missing auth token as a fatal error regardless of `NODE_ENV`.

---

## Info

### I-01: `auth-routes.ts` Has No Test File

**File**: `server/auth-routes.ts`  
**Issue**: Rate limiting, token verification, and session token derivation are security-sensitive. No test file found.  
**Recommendation**: Add `server/auth-routes.test.ts` with at minimum: rate limit enforcement (11th request returns 429), valid/invalid token verification, and session token scope isolation.

---

### I-02: `ChatView.tsx` and `InputBar.tsx` Are Large

**Files**: `src/components/ChatView.tsx` (~25 KB), `src/components/InputBar.tsx` (~30 KB)  
**Issue**: These components are large enough that individual features (file upload, slash commands, message grouping) are hard to test or reason about in isolation.  
**Recommendation**: Consider extracting slash-command handling and file-upload logic into dedicated sub-components or hooks. Not urgent — existing test coverage partially compensates.

---

### I-03: No Structured Logging Framework

**File**: All server files  
**Issue**: The server uses a mix of `console.log`, `console.warn`, and `console.error` without request/session context attached. Makes log correlation difficult in production.  
**Recommendation**: Adopt a lightweight structured logger (e.g., Pino) and attach session ID + request ID to all log entries. Low priority but useful as traffic grows.

---

### I-04: `CLAUDE_BINARY` Resolution Blocks Server Startup

**File**: `server/config.ts`  
**Issue**: `execFileSync` with a 3-second timeout is used to resolve the Claude CLI path at startup. If `which` is slow (NFS mounts, PATH anomalies), this blocks the entire server startup.  
**Recommendation**: Move binary resolution to an async initialization step, or cache the result and surface a clear error if resolution fails rather than blocking the main thread.

---

### I-05: `npm audit` Not Visible in CI

**File**: `package.json` / CI configuration  
**Issue**: No evidence of `npm audit` in the build or test pipeline. With 4 production dependencies and 31 dev dependencies, this is low surface area — but automated vulnerability scanning adds little cost.  
**Recommendation**: Add `npm audit --audit-level=high` to the CI lint/test step.

---

## Positive Observations

- **Security hardening momentum**: Three consecutive weeks of security audit + fix cycles (commits `9c7eb52`, `3f1047e`, `3e7d70d`). Active and improving.
- **GIT_* env var stripping** (`01b0ea0`): Correct fix — child processes should not inherit auth tokens from the parent environment.
- **Permission mode respected in file tool hooks** (`f6c6448`): Good catch. Tool auto-approval must honor the session's permission mode.
- **SessionLifecycle extraction** (`472d93d`): Clean refactor. The dependency injection pattern keeps the module testable in isolation, even though tests are not yet written.
- **Test expansion for session restart** (`a32481a`): Restart/worktree logic has historically been a source of bugs; adding regression coverage is the right move.
- **Timing-safe token comparison** in `crypto-utils.ts`: Correctly uses `crypto.timingSafeEqual` with fixed-length hashes.
- **Minimal production dependencies** (4 packages): Low attack surface.

---

## Summary

The codebase is in good shape following an active week of security fixes and architectural refactoring. The primary gap is test coverage for the two newly-extracted modules (`session-lifecycle.ts` and `prompt-router.ts`), which represent critical paths. The cross-repo approval threshold warrants a configuration review. No critical issues were identified.

**Recommended actions this sprint**:
1. Add `session-lifecycle.test.ts` (W-01)
2. Add `prompt-router.test.ts` (W-02)
3. Review and raise `CROSS_REPO_THRESHOLD` (W-03)
4. Apply logging to the silent catch in `native-permissions.ts` (W-05)

**Next sprint**:
- Address auth fallback hardening (W-06)
- Add `auth-routes.test.ts` (I-01)
- Add `npm audit` to CI (I-05)
