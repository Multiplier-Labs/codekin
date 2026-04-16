# Security Audit: codekin — 2026-04-16

**Overall Risk Rating: Low — 0 Critical, 0 High, 2 Medium, 4 Low**

---

## Summary

The codebase continues to demonstrate strong security fundamentals. All five findings from the April 2 audit (M1, L1, L2, M2, L5) have been remediated. Two medium and four low findings remain open or are newly identified. No hardcoded secrets or committed credentials were detected.

| Severity | Count | Status |
|----------|-------|--------|
| Critical | 0 | — |
| High | 0 | — |
| Medium | 2 | 1 new, 1 carried forward |
| Low | 4 | 2 new, 2 carried forward |

### Remediations confirmed since April 2 audit

| Finding | Description | Fix |
|---------|-------------|-----|
| M1 | No auth token exits instead of warn | `process.exit(1)` added at `ws-server.ts:75` |
| M2 | Stepflow enabled without secret silently drops events | `process.exit(1)` added at `ws-server.ts:183` |
| L1 | `workingDir` not validated at session creation | `realpathSync`/`allowedRoots` check added at `session-routes.ts:148–158` |
| L2 | Auth token accepted via request body | `req.body.token` path removed |
| L5 | MIME type `||` bypass in file upload | Fixed to `&&` at `upload-routes.ts:179` |

---

## Critical Findings

None.

---

## High Findings

None.

---

## Medium Findings

### M1 — Shell Injection via Unescaped Git Metadata in Post-Commit Hook JSON

**File**: `server/commit-event-hook.sh:60`

**Description**: The shell hook constructs a JSON payload by direct variable interpolation. While `COMMIT_MESSAGE` is properly escaped through `jq -Rs` (when `jq` is available), the variables `REPO_PATH`, `BRANCH`, `AUTHOR`, and `COMMIT_HASH` are embedded raw into the JSON string:

```sh
-d "{\"repoPath\":\"${REPO_PATH}\",\"branch\":\"${BRANCH}\",\"commitHash\":\"${COMMIT_HASH}\",\"commitMessage\":${ESCAPED_MESSAGE},\"author\":\"${AUTHOR}\"}"
```

A git repository path or author name containing `"`, `\`, newlines, or other special characters will produce malformed JSON. More critically, a crafted author name such as `foo", "injected": "value` corrupts the payload structure. The `AUTHOR` field is particularly exploitable — git commit author names are user-controlled and not validated server-side before the hook fires.

**Impact**: Malformed or attacker-controlled JSON sent to the server's commit-event endpoint. An attacker who can author a commit to an instrumented repo (e.g., an org member) can inject arbitrary JSON fields into the webhook payload, potentially overriding `repoPath` or `branch` fields and triggering unintended server-side workflow logic.

**Remediation**: Use `jq` (with the same availability check already present) or `printf '%s'` piped through per-field escaping for all four variables. Example:

```sh
REPO_PATH_ESC=$(printf '%s' "$REPO_PATH" | jq -Rs .)
AUTHOR_ESC=$(printf '%s' "$AUTHOR" | jq -Rs .)
BRANCH_ESC=$(printf '%s' "$BRANCH" | jq -Rs .)
# COMMIT_HASH is already hex-only (safe), but quote it for consistency
```

---

### M2 — Orchestrator `spawn` Child Validates Repo Path with `resolve()` Instead of `realpathSync()`  *(carried forward from M-class attention, now upgraded to Medium)*

**File**: `server/orchestrator-routes.ts:250`

**Description**: The `POST /api/orchestrator/children` endpoint validates the caller-supplied `repo` path using `path.resolve()`:

```ts
const resolvedRepo = resolve(repo)
if (!resolvedRepo.startsWith(REPOS_ROOT + '/') && resolvedRepo !== REPOS_ROOT) {
  return res.status(400).json({ error: 'Invalid repo path: must be under configured repos root' })
}
```

`resolve()` normalises `..` segments but does **not** dereference symlinks. If `REPOS_ROOT` contains a symlink pointing outside it (e.g., `~/repos/linked-repo → /etc/sensitive`), the check passes and a Claude child session is spawned with `/etc/sensitive` as its working directory. This is the same class of bug fixed in the docs-routes hardening (`4bfad4e`).

**Impact**: Authenticated orchestrator users can spawn Claude sessions with arbitrary filesystem paths as the working directory, bypassing the intended `REPOS_ROOT` boundary.

**Remediation**: Replace `resolve(repo)` with `realpathSync(resolve(repo))` (wrapped in try/catch), identical to the pattern used in `session-routes.ts:153` and `docs-routes.ts`.

---

## Low Findings

### L1 — Hook Config Stores Master Auth Token  *(carried forward)*

**File**: `server/commit-event-hooks.ts:49–55`

**Description**: `ensureHookConfig()` writes the full master `authToken` to `~/.codekin/hook-config.json` with `0600` permissions. The file is read by the post-commit shell script to authenticate commit-event webhook calls. A process running as the same user (e.g., a compromised tool in the dev environment) that reads this file obtains the master token, which grants access to all API endpoints.

**Impact**: Compromise of the hook config file escalates to full server access rather than scoped commit-event access only.

**Remediation**: Derive a scope-limited token using `deriveSessionToken(masterToken, 'commit-hook')` (already in `crypto-utils.ts`) and store that instead. The server's commit-event endpoint should then verify using the same derivation. This limits the blast radius of a stolen hook config.

---

### L2 — CSP `style-src 'unsafe-inline'`  *(carried forward)*

**File**: `server/ws-server.ts:309`

**Description**: The `Content-Security-Policy` header includes `style-src 'self' 'unsafe-inline'` to support TailwindCSS 4 inline styles. This weakens the XSS mitigation provided by CSP, as injected inline `<style>` tags would not be blocked.

**Impact**: If an XSS vector were discovered (none currently identified), `unsafe-inline` in `style-src` reduces the defence-in-depth protection. CSS injection via `<style>` can be used for data exfiltration (CSS attribute selectors reading DOM values).

**Remediation**: Investigate Tailwind's nonce-based or hash-based style approach. If not feasible, document the known exception and confirm Tailwind 4's CSS variables approach does not require `unsafe-inline` at all style call sites.

---

### L3 — Auth-Verify Endpoint Is a Timing/Brute-Force Oracle

**File**: `server/auth-routes.ts:67–70`

**Description**: `POST /auth-verify` returns `{ valid: true/false }` based on whether the supplied Bearer token matches. The endpoint is rate-limited to 10 req/min per IP, which limits online brute force. However, the binary true/false response with no jitter or lockout means a distributed attacker (multiple IPs) can test tokens at 10/min per IP without account lockout.

The token comparison itself uses `timingSafeEqual` (via SHA-256 hashing in `verifyToken`), so there is no timing oracle. The concern is the existence of a public verification oracle for any auth token.

**Impact**: Low — the token space is large enough (typically a UUID or random string) that enumeration is not practical even with a distributed attack. However, the endpoint provides confirmation of successful token discovery, which aids targeted attacks.

**Remediation**: Add a minimum response delay (e.g., 100ms) regardless of outcome to eliminate any residual timing signal. Consider whether the endpoint is needed at all by unauthenticated clients, or whether it should require an existing valid token.

---

### L4 — FTS5 `MATCH` Query Accepts Unsanitised User Input (SQLite DoS)

**File**: `server/orchestrator-memory.ts:218–226`

**Description**: The `search()` method passes the caller-controlled `query` string directly into SQLite's FTS5 `MATCH` operator via a prepared statement:

```ts
WHERE memory_fts MATCH ?
```

While prepared statements prevent SQL injection, FTS5's `MATCH` syntax is not SQL — it has its own grammar. Malformed FTS5 expressions (e.g., `AND AND`, `"unterminated`) cause SQLite to throw a `SQLITE_ERROR`, which propagates as an unhandled exception if the caller doesn't catch it. The calling route in `orchestrator-routes.ts:294` does not wrap the call in a try/catch.

**Impact**: An authenticated orchestrator user can cause the memory search endpoint to return a 500 error or crash the route handler by submitting a malformed FTS5 query string. No data exfiltration risk.

**Remediation**: Wrap the `db.prepare(...).all(...)` call in a try/catch in `orchestrator-memory.ts:search()`. Return an empty result set on parse error, or sanitise the query string (strip FTS5 operators) before passing to `MATCH`.

---

## Secrets & Credentials Exposure

No hardcoded secrets, API keys, or committed credentials were found in any tracked source file. All credentials are sourced from environment variables (`AUTH_TOKEN`, `AUTH_TOKEN_FILE`, `ANTHROPIC_API_KEY`, `GITHUB_WEBHOOK_SECRET`, `STEPFLOW_WEBHOOK_SECRET`) or from locally-stored config files outside the repository (`~/.codekin/hook-config.json`, `~/.codekin/webhook-config.json`). The `.gitignore` correctly excludes `.env` and `.env.*` files. The `settings.example.json` committed to the repo contains no real credentials.

The `~/.codekin/hook-config.json` file (storing the master auth token) is written with `0600` permissions (owner read/write only) — see L1 for the scoping concern.

---

## Recommendations

1. **[Medium — High Priority] Fix JSON injection in `commit-event-hook.sh`**: Escape all four git metadata variables through `jq -Rs` or an equivalent. The `jq` availability guard is already in place; extend it to cover all fields, not just `COMMIT_MESSAGE`. This is the highest-risk new finding.

2. **[Medium] Replace `resolve()` with `realpathSync()` in orchestrator spawn validation** (`orchestrator-routes.ts:250`): Consistent with the fix already applied to docs-routes and session-routes. One-line change with high impact.

3. **[Low — Quick Win] Scope the commit-hook auth token** (`commit-event-hooks.ts`): Use `deriveSessionToken(masterToken, 'commit-hook')` from the existing `crypto-utils.ts`. Add a corresponding verification path in the commit-event endpoint. Reduces master token exposure.

4. **[Low] Wrap FTS5 `MATCH` in try/catch** (`orchestrator-memory.ts:search()`): One-line fix — catch the SQLite error and return `[]`. Prevents 500 responses from malformed search queries.

5. **[Low] Add minimum response delay to `/auth-verify`**: A 50–100ms fixed delay eliminates any residual timing signal and slightly raises the cost of distributed brute-force enumeration without meaningfully affecting UX.

6. **[Low — Ongoing] Investigate CSP `'unsafe-inline'` removal**: Evaluate whether TailwindCSS 4 can operate without `style-src 'unsafe-inline'`. If not achievable in the short term, document the exception explicitly in the security posture notes.

7. **[Informational] Extend `TOOL_DEBUG` gating to `opencode-process.ts`**: The `NODE_ENV !== 'production'` check added for `claude-process.ts` (M3 fix) should be verified as applied consistently in the newer `opencode-process.ts` file, which also handles tool events.
