# Daily Code Review: codekin

**Date**: 2026-10-19T04:02:17.231Z
**Repository**: /srv/repos/Multiplier-Labs/codekin
**Branch**: main
**Workflow Run**: 517a64f8-2eec-4e6b-b79f-ce24a6d67f8c
**Session**: 8ac6a02d-adbf-4a3e-926c-78431702f67b

---

# Codekin Daily Code Review — 2026-10-19
**Branch reviewed:** `wt/8ac6a02d` (`HEAD` `7f24e7c`)  
**Scope:** Current branch state, last 7 days of commit history, and critical files touched in recent work.  
**Reviewer note:** `npm install` completed, but the checked-in lock files are stale: `vitest` and `eslint` are referenced in `package.json` / `server/package.json` but are not actually installed, so automated tests and lint could not be executed.

---

## Recent activity

No commits landed on the current branch in the last 7 days. Several important security fixes (WebSocket pre-auth limits, proxy IP handling, dependency audit) exist on the `chore/release-0.9.4` branch but are **not present** on `wt/8ac6a02d`. This branch is functionally behind the release branch and should be rebased or have those fixes cherry-picked.

---

## Critical

### 1. Stale lock files block CI and local verification
**Files:** `package-lock.json`, `server/package-lock.json`, `package.json`, `server/package.json`  
**Lines:** `package.json:50-107`, `server/package.json:30-38`

`npm install` installs only the lock-file contents; `vitest` and `eslint` are listed as dev dependencies but do not exist in `node_modules/.bin`. Both `npm test` and `npm run lint` fail immediately.

- Root `package.json` version is `0.9.1` while `chore/release-0.9.4` is at `0.9.4`.
- Running `npm audit` on either package reports **4 active advisories**, including:
  - `proxy-addr` — **critical** IP spoofing via IPv4-mapped IPv6 trust subnet (`GHSA-jqcg-44mw-7w3h`)
  - `@modelcontextprotocol/sdk` — **high** OAuth credential leak (`GHSA-6qxp-vccf-f47h`)
  - `hono`, `ip-address` — moderate

**Action:** Regenerate both lock files from the current `package.json` manifests, run `npm audit fix`, and verify `npm test` and `npm run lint` pass.

---

### 2. WebSocket server trusts client-supplied `X-Forwarded-For` and has no pre-auth frame-size cap
**File:** `server/ws-server.ts`  
**Lines:** `208-210`, `452`, `514`

The current code sets Express `trust proxy` to `true` and then keys the WebSocket connection rate-limiter on the **leftmost** entry of `X-Forwarded-For`:

```ts
// ws-server.ts:208-210
if (TRUST_PROXY) {
  app.set('trust proxy', true)
}

// ws-server.ts:514
const ip = (TRUST_PROXY && (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim()) || req.socket.remoteAddress || 'unknown'
```

A client can supply an arbitrary leftmost IP and obtain a fresh rate-limit bucket on every connection. Combined with the missing `maxPayload` on the `WebSocketServer` constructor, this allows an unauthenticated client to:
- bypass per-IP connection rate limiting,
- buffer up to the `ws` default 100 MiB frame size before authentication or message rate limits run.

**Action:** Apply the same hardening that landed on `chore/release-0.9.4` in PR #720:
- Set `maxPayload` (e.g. 4 MiB) on `WebSocketServer`.
- Set Express `trust proxy` to a fixed hop count (`1`) and derive the WebSocket IP from the rightmost trusted `X-Forwarded-For` entry.
- Add unit coverage in `server/ws-limits.test.ts`.

---

### 3. `proxy-addr` critical vulnerability is active via Express trust-proxy
**Files:** `server/ws-server.ts:208`, `package-lock.json`, `server/package-lock.json`

Because `app.set('trust proxy', true)` is in use, the vulnerable `proxy-addr` path is exercised for IP derivation. The advisory allows IPv4-mapped IPv6 trust-subnet spoofing, which can defeat the API rate limiter and any IP-based access controls.

**Action:** Update `proxy-addr` (and the Express dependency chain) to a patched version; switch to a numeric hop count as noted above.

---

## Warning

### 4. `useChatSocket.setModel` overwrites the Claude model preference for all providers
**File:** `src/hooks/useChatSocket.ts`  
**Lines:** `526-530`

```ts
const setModel = useCallback((model: string) => {
  send({ type: 'set_model', model })
  setCurrentModel(model)
  setPref('claudeModel', model)   // <- always the claude key
}, [send])
```

`set_model` is called for Codex and OpenCode sessions as well as Claude sessions, but the preference write is hard-coded to `claudeModel`. `App.tsx:417-424` has a separate `handleModelChange` that writes the correct per-provider key, but not all call sites use it.

**Action:** Make `setModel` in `useChatSocket` provider-aware, or remove the preference write there and require callers to store per-provider preferences explicitly.

---

### 5. Unhandled rejection / fire-and-forget in session worktree cleanup
**File:** `server/session-manager.ts`  
**Lines:** `801-818`, `567-582`

```ts
const exitPromise = session.claudeProcess
  ? (() => { ... cp.stop(); return cp.waitForExit() })()
  : Promise.resolve()

// ...
if (session.worktreePath) {
  void exitPromise.then(() => this.cleanupWorktree(wtPath, repoDir))
}
```

`exitPromise` is not awaited and has no `.catch()`. If `waitForExit()` rejects, the rejection is unhandled. `cleanupWorktree` itself is an async IIFE without a catch, so a failure in `removeWorktree` becomes an unhandled rejection.

**Action:** Add a `.catch()` handler to log (and metrics-tag) cleanup failures; avoid unhandled rejections in the session deletion path.

---

### 6. Worktree path collisions across nested repos with identical basenames
**File:** `server/worktree-ops.ts`  
**Lines:** `190-195`

```ts
function managedPaths(repoRoot: string, ownerId: string): string[] {
  const base = path.resolve(repoRoot, '..', `${path.basename(repoRoot)}-wt-${ownerId}`)
```

Two different repos with the same directory basename (e.g., `~/projects/foo` and `~/work/foo`) will map to the same sibling worktree prefix and can collide or skip each other.

**Action:** Use the full canonical repo path (hashed or encoded) in the worktree sibling directory name, not just `basename(repoRoot)`.

---

### 7. `/api/settings/prefs` stores arbitrary JSON values with only key validation
**File:** `server/session-routes.ts`  
**Lines:** `438-473`

The prefs endpoint validates key names (`/^[a-zA-Z][a-zA-Z0-9]{0,63}$/`) and total blob size (256 KiB), but places no type/value constraints. A malformed value can break client code that expects specific shapes (e.g., `starredDocs` to be a record of string arrays, `tentativeQueues` a record of string arrays).

**Action:** Add a lightweight schema check for known preference keys, or at least reject non-object values for object-typed keys.

---

### 8. Dependency drift between root and server packages
**Files:** `package.json`, `server/package.json`

Both workspaces depend on the same runtime libraries (`express`, `ws`, `better-sqlite3`, `zod`, `@modelcontextprotocol/sdk`) but at potentially different resolved versions because they have separate lock files. The root `package.json` does not include `tsx`, `express-session`, or `@simplewebauthn/server`, which the server uses.

**Action:** Consolidate shared runtime dependency versions, or add a CI step that verifies both workspaces resolve to compatible/patched versions.

---

### 9. `MarkdownRenderer` and `ChatView` use `dangerouslySetInnerHTML`
**Files:** `src/components/MarkdownRenderer.tsx:19-22`, `src/components/ChatView.tsx:229`

Both are piped through `DOMPurify.sanitize()` and `marked` with GFM. This is acceptable if DOMPurify stays up to date (see advisory `@modelcontextprotocol/sdk` is unrelated, but `dompurify` itself had recent advisories). The current configuration does not restrict `data:` URLs, `javascript:` URLs, or inline event handlers beyond DOMPurify defaults.

**Action:** Pin a minimum patched `dompurify` version and add a snapshot test for markdown containing malicious links/scripts.

---

## Info

### 10. SQL queries are consistently parameterized
Across `server/relay/*.ts`, `server/workflow-engine.ts`, `server/loop-store.ts`, `server/session-archive.ts`, and `server/session-routes.ts`, all SQLite statements use `?` placeholders. No string-interpolated SQL was found in application code.

### 11. Path traversal controls are present and duplicated
`server/session-routes.ts` (`canonicalizeReposPath`, `/api/sessions/create`, `/api/browse-dirs`, `/api/opencode/models`) and `server/relay/relay-auth-routes.ts` (no file-system routes observed) enforce that resolved paths live under `homedir()` or `REPOS_ROOT`. The check is copy-pasted in four places; consider extracting `assertPathWithinAllowedRoots()` to reduce drift.

### 12. Hosted control-plane schema migration framework is sound
**File:** `server/relay/control-plane-db.ts`  
**Lines:** `179-345`

Migrations run inside transactions with `foreign_keys = OFF`, then `foreign_key_check`, then `user_version` bump. The bootstrap workspace insertion is idempotent (`INSERT OR IGNORE`). This is a solid pattern.

### 13. `App.tsx` intentionally suppresses some React exhaustive-deps warnings
**File:** `src/App.tsx`  
**Lines:** `533-547`, `554`

The comments explain the omission of `activeSessionId` to avoid loops. This is documented and localized, but it increases the risk of stale closures when the listed dependencies change in the future. No immediate bug is visible.

---

## Summary of recommended actions

| Priority | Action |
|----------|--------|
| **Critical** | Regenerate `package-lock.json` / `server/package-lock.json` and run `npm audit fix`. |
| **Critical** | Cherry-pick or merge PR #720 security fixes into `wt/8ac6a02d` (`maxPayload`, `trust proxy` hop count, rightmost `X-Forwarded-For`). |
| **Critical** | Verify `npm test` and `npm run lint` pass after lock-file refresh. |
| **Warning** | Make `setModel` in `useChatSocket.ts` provider-aware. |
| **Warning** | Add `.catch()` to worktree cleanup promises in `session-manager.ts`. |
| **Warning** | Use repo-path-derived (not basename-derived) worktree sibling directory names. |
| **Warning** | Add schema/value validation to `/api/settings/prefs`. |
| **Info** | Extract shared path-boundary check to reduce duplicated traversal guards. |