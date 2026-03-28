# Repository Health: codekin

**Date**: 2026-03-26T04:20:15.751Z
**Repository**: /srv/repos/codekin
**Branch**: main
**Workflow Run**: 61adc865-f5aa-4b58-bb35-fb78b9ca4a8f
**Session**: b19958bb-827d-45d2-b967-25f13ed2307b

---

Now I have all the data I need. Let me write the report.---

## Repository Health Report — 2026-03-26

**Overall: Good**

Report saved to `.codekin/reports/complexity/2026-03-26_complexity-report.md`.

### Key findings:

**Dead Code** — None. TypeScript's `noUnusedLocals`/`noUnusedParameters` provides continuous enforcement. All components and server modules have import sites.

**TODOs/FIXMEs** — Zero in production code. The only hits were test files using `"TODO"` as a literal test input.

**Config Drift** — 3 minor items:
- `eslint.config.js` has `ecmaVersion: 2020` while tsconfig targets `ES2022`/`ES2023`
- `tsconfig.app.json` (ES2022) and `tsconfig.node.json` (ES2023) are one version apart
- ~10 ESLint rules intentionally demoted to `'warn'` — acknowledged tech debt, but should be tracked for promotion

**License Compliance** — Clean. No GPL/AGPL/LGPL. MPL-2.0 (lightningcss, dompurify) is already documented in `package.json`. `busboy`/`streamsearch` have no `license` field in the lock file but MIT files exist in `node_modules`.

**Docs** — `ORCHESTRATOR-SPEC.md` still reads `Status: Draft v0.1` despite the feature being GA in v0.5.0. No HTTP REST API reference document exists (the biggest doc gap).

**Changelog (last 7 days)** — Very active: 1 refactor (PlanManager state machine), 4 features (session lifecycle hooks, orchestrator approval endpoints, sidebar status tooltips/icons), 30+ fixes concentrated on orchestrator stability, ExitPlanMode reliability, and AskUserQuestion flow.

**Branches** — No branches older than 30 days. However, ~24 post-merge "shadow" branches (showing 1 commit ahead, many behind main) should be bulk-deleted. Two high-risk divergent branches: `codekin/reports` (35 ahead, 298 behind) and `feat/joe-chat-variant` (1 ahead, 151 behind).

**PRs** — No open PRs.

---

# Security Audit — 2026-03-26

**Audited by:** Claude Code (automated)
**Scope:** Full server and frontend source, config files, git history
**Tech stack:** Node.js/Express 5 + WebSocket server (TypeScript), React + Vite frontend, better-sqlite3, multer

---

## Summary

**Overall Risk Rating: Low–Medium**

No critical or high-severity vulnerabilities were found. The codebase demonstrates a generally strong security posture: all child-process calls use array-argument forms (no shell injection surface), HMAC verification is timing-safe throughout, session tokens are scoped per child process, and path traversal protections use `realpathSync` + prefix boundary checks at all major file operation points. Security headers are applied globally and CORS is strictly enforced in production.

| Severity | Count |
|----------|-------|
| Critical | 0 |
| High     | 0 |
| Medium   | 3 |
| Low      | 4 |
| Info     | 6 |

---

## Critical Findings

None.

---

## High Findings

None.

---

## Medium Findings

### M1 — Missing Auth Token Allows Fully Unauthenticated API Access

**File:** `server/ws-server.ts` (startup auth token loading, ~line 71)

**Description:** When `AUTH_TOKEN` is not set (and no `--auth-file` is provided), the server logs a `console.warn` and continues running. The `verifyToken()` function returns `false` for all token checks when `authToken` is falsy — correctly rejecting individual requests — but the server itself does not exit. If an operator deploys without configuring an auth token (e.g., after an environment variable misconfiguration), the entire API becomes accessible without authentication.

**Impact:** A misconfigured production deployment could unintentionally expose the entire API with no authentication. The current behavior relies solely on operators noticing a startup warning.

**Remediation:** In `config.ts` or at server startup, add an explicit `process.exit(1)` when `NODE_ENV === 'production'` and no auth token is configured. This mirrors the pattern already used for the `CORS_ORIGIN` production validation check.

---

### M2 — Stepflow Webhook Without Secret Is Non-Fatal (Inconsistency With GitHub Webhook)

**File:** `server/ws-server.ts` (Stepflow webhook init, ~line 168)

**Description:** The GitHub webhook integration correctly calls `process.exit(1)` at startup if `GITHUB_WEBHOOK_ENABLED=true` but `GITHUB_WEBHOOK_SECRET` is not set. The Stepflow webhook path only emits a `console.warn` in the equivalent condition, then continues running and processes unsigned webhook payloads. An attacker aware of the Stepflow endpoint could send arbitrary payloads triggering session and workspace operations.

**Impact:** Unsigned Stepflow webhook payloads could be accepted, potentially triggering unintended git workspace clones or session operations.

**Remediation:** Apply the same `process.exit(1)` guard to Stepflow webhook initialization that already exists for GitHub webhooks. Treat missing-secret-with-webhook-enabled as a fatal configuration error.

---

### M3 — Tool Input and Output Logged to stdout Without NODE_ENV Gating

**File:** `server/claude-process.ts` (lines ~240, ~301, ~349)

**Description:** `[task-debug]` and `[tool-result]` `console.log` calls emit tool names and truncated tool input/output (up to 200–300 characters) to process stdout unconditionally, with no `NODE_ENV` or `DEBUG` flag gate. In production, server logs could contain snippets of user file contents, code being edited, or API call parameters from tool interactions.

**Impact:** Sensitive user data (file contents, code, potentially tokens passed as tool arguments) may be written to server logs accessible to operators or log aggregation systems.

**Remediation:** Gate debug-level log calls behind a `DEBUG` environment variable flag or `NODE_ENV !== 'production'` check. Use a structured logger (e.g., `pino`, `winston`) with configurable log levels so that verbose tool tracing can be enabled selectively without leaking to production logs.

---

## Low Findings

### L1 — User-Controlled `workingDir` Not Validated Against Allowed Repository Roots

**File:** `server/session-routes.ts` / `server/ws-server.ts` (create_session handling)

**Description:** The `create_session` WebSocket message and `/api/sessions/create` REST endpoint accept an arbitrary `workingDir` value from the authenticated client, used as the `cwd` for the spawned Claude CLI child process. The directory is not validated against an allowlist of permitted repository roots before use. An authenticated user can point a session at any directory readable by the server process.

**Impact:** An authenticated attacker could direct sessions at arbitrary directories outside intended repository scopes. No code execution risk (the child command and args are static), but privilege separation between users or repositories is not enforced.

**Remediation:** Apply `realpathSync` + `REPOS_ROOT` prefix check to `workingDir` in session creation, consistent with how clone destinations are validated in `upload-routes.ts`.

---

### L2 — Auth Token Accepted via Query Parameter and Request Body (Log Exposure Risk)

**File:** `server/ws-server.ts` (`extractToken` function, ~line 105)

**Description:** The `extractToken` helper accepts the bearer token from three sources: `Authorization: Bearer` header, `token` query parameter, and `req.body.token` POST body field. Tokens submitted in query parameters appear in HTTP access logs by default; body tokens may appear in error traces or debug logs depending on express/nginx configuration.

**Impact:** Auth tokens could be inadvertently persisted in log files, increasing the attack surface for token theft via log access.

**Remediation:** Remove query parameter and body token extraction. Require tokens exclusively via the `Authorization: Bearer` header, which is not logged by default in standard HTTP access log formats.

---

### L3 — CSP Permits `style-src 'unsafe-inline'`

**File:** `server/ws-server.ts` (Content-Security-Policy header, ~line 220)

**Description:** The Content-Security-Policy header includes `style-src 'self' 'unsafe-inline' https://fonts.googleapis.com`. The `'unsafe-inline'` directive allows injection of arbitrary CSS via any XSS vector that reaches inline style attributes or `<style>` tags. This is a common tradeoff for React/Tailwind applications, but weakens CSP's ability to contain style-based attacks.

**Impact:** Low — style injection can enable UI redressing or CSS-based data exfiltration, but requires a pre-existing XSS vector. The `X-Frame-Options: DENY` header mitigates the clickjacking angle independently.

**Remediation:** Since Tailwind compiles styles at build time via Vite, audit whether any runtime inline styles are genuinely needed. If not, remove `'unsafe-inline'` from `style-src`. As an intermediate step, use a nonce-based CSP or hash allowlist instead of blanket `'unsafe-inline'`.

---

### L4 — Hook Config File Stores Master Auth Token in Plaintext

**File:** `server/commit-event-hooks.ts` (hook config write, ~line 80)

**Description:** The git hook installer writes a config file (typically `~/.codekin/hook-config.json`) with `chmod 0600` permissions. This file contains the master auth token in plaintext so git hooks can authenticate back to the server. While `0600` is appropriate, the master token (from which all session-scoped tokens can be derived) is stored rather than a hook-scoped token.

**Impact:** Compromise of the OS user account gives immediate access to the master auth token and, by extension, all derived session tokens.

**Remediation:** Extend the existing session-scoped token derivation in `crypto-utils.ts` to generate hook-specific tokens (e.g., `HMAC(masterToken, "hook:" + hookId)`), scoped only to hook callback endpoints (`/api/hook-decision`, `/api/hook-notify`). Write only these scoped tokens to the hook config file.

---

## Secrets & Credentials Exposure

**Result: No hardcoded secrets found.**

- `git grep` across all tracked `.ts`, `.js`, `.json`, `.yaml`, `.yml` files for `password`, `secret`, `api_key`, `token`, `private_key` returned only:
  - References to npm package names containing "token" in `package-lock.json` (not credentials)
  - Code variables named `authToken` in server source (no literal values assigned)
  - `process.env.AUTH_TOKEN` and `process.env.AUTH_TOKEN_FILE` references in `server/config.ts` — correct env-based pattern
- No `.env` files committed at any level (outside `node_modules`)
- Git history scan found no historical commits adding `.env`, `credentials`, `key.pem`, or `id_rsa` files
- `.codekin/settings.json` contains only path configuration; references `authFile: ~/.codekin/auth-token` (a local path pointer, not the token value itself)
- `.claude/settings.local.json` contains Claude CLI configuration only; no API keys observed

---

## Informational Findings

**I1 — No Shell Injection Surface:** All child-process calls use `execFile`/`execFileSync` with argument arrays. No `exec()`, `execSync()`, or `spawn()` with `shell: true` was found in application code. Shell injection is not possible through any current code path.

**I2 — Timing-Safe Token Comparison:** `crypto-utils.ts` uses `crypto.timingSafeEqual` on SHA256 hashes for all HMAC and token comparison operations, preventing timing-based token extraction attacks.

**I3 — Session Token Scoping:** Child Claude processes receive HMAC-SHA256-derived session-scoped tokens rather than the master token. Compromise of a child process does not expose the master credential.

**I4 — Thorough SSRF Protection:** `stepflow-handler.ts` validates callback URLs against an explicit hostname allowlist and blocks RFC 1918 private ranges, loopback, link-local, and IPv4-mapped IPv6 addresses (correctly unwrapping `::ffff:` prefixes before IPv4 checks).

**I5 — Webhook Replay Protection:** Webhook handlers deduplicate by delivery ID with a 1-hour cache window, preventing replay of previously-processed payloads.

**I6 — Consistent Path Traversal Defenses:** All user-influenced file paths apply `realpathSync` (resolving symlinks) followed by a `startsWith(allowedRoot + sep)` boundary check, applied consistently across `session-routes.ts`, `upload-routes.ts`, `webhook-workspace.ts`, and `workflow-loader.ts`.

---

## Recommendations

1. **[Medium — M1] Fail-fast on missing auth token in production** — Add `process.exit(1)` in `config.ts` when `NODE_ENV === 'production'` and no `AUTH_TOKEN` or auth file is configured. Prevents silent unauthenticated deployments.

2. **[Medium — M2] Make missing Stepflow webhook secret fatal** — Apply the same `process.exit(1)` guard that GitHub webhook uses to Stepflow webhook initialization. Ensures consistent security posture across webhook providers.

3. **[Medium — M3] Gate debug logging behind a flag** — Introduce a `DEBUG` env var or structured logger with configurable levels. Move all `[task-debug]`/`[tool-result]` tool-content log lines behind a debug-only gate to prevent user data from appearing in production logs.

4. **[Low — L1] Validate `workingDir` against allowed repository roots** — Apply `realpathSync` + `REPOS_ROOT` prefix check to `workingDir` in session creation, mirroring the validation already in place for clone destinations in `upload-routes.ts`.

5. **[Low — L2] Restrict token extraction to Authorization header only** — Remove `req.query.token` and `req.body.token` extraction from `extractToken()`. Require `Authorization: Bearer <token>` exclusively to prevent tokens appearing in access logs.

6. **[Low — L4] Issue hook-scoped tokens for git hook config files** — Extend `crypto-utils.ts` to derive hook-specific tokens scoped only to hook callback endpoints. Store these scoped tokens in hook config files instead of the master token.

7. **[Low — L3] Remove `'unsafe-inline'` from CSP style-src** — Audit runtime inline style usage; if Tailwind's compile-time output covers all styling, remove `'unsafe-inline'` from `style-src` to strengthen CSP. Use nonces or hashes if some inline styles are unavoidable.

8. **[Info] Add `npm audit` to the local dev workflow** — CI already runs `npm audit --audit-level=high`. Add a dev-facing script alias or pre-push hook so vulnerabilities are caught locally before CI, reducing round-trip time.

9. **[Info] Add HSTS to staging/preview environments** — HSTS is currently gated on `NODE_ENV === 'production'`. If any non-production environments are served over HTTPS, enable HSTS there as well to maintain consistent transport security.

10. **[Info] Document unauthenticated-mode behavior in deployment docs** — Clearly document in `docs/` what happens when `AUTH_TOKEN` is absent, so operators understand the risk before the code-level fix in recommendation #1 is implemented.

---

## Manual Code Review — 2026-03-26 (Daily)

**Reviewer**: Claude Code (claude-sonnet-4-6)
**Scope**: Last 7 days of commits; focused on recently changed files

### WARNING

#### `version-check.ts:36` — Unguarded `readFileSync` + `JSON.parse` at server startup

`getCurrentVersion()` reads `package.json` synchronously at server startup with no error handling:

```ts
function getCurrentVersion(): string {
  if (!state.currentVersion) {
    const pkgPath = join(import.meta.dirname, '..', 'package.json')
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'))  // no try-catch
    state.currentVersion = pkg.version
  }
  return state.currentVersion
}
```

If `package.json` is absent or malformed, this throws synchronously during the version-check startup flow. Wrap in try-catch and fall back to `'unknown'`.

Note: this is separate from the `fetchLatestVersion()` async path below it, which is already correctly wrapped in try-catch (line 55).

---

### INFO

#### Plan Mode refactor (`ec9e689`, `499e6fd`) — well-designed; no issues

The `PlanManager` state machine is correct. Key properties verified by reading both `plan-manager.ts` and its integration in `session-manager.ts`:

- **Stale ID rejection**: `approve(reviewId)` and `deny(reviewId)` validate against `_pendingReviewId`. A stale resolution from a timed-out round cannot affect a live review.
- **`onTurnEnd()` auto-deny**: transitions `reviewing → planning` (not `→ idle`), preserving plan mode. Previous behavior silently approved; the fix never auto-approves.
- **5-minute timeout** (`session-manager.ts:1483`): correctly cleans up `pendingToolApprovals`, calls `deny(reviewId)`, broadcasts `prompt_dismiss`, and resolves the promise. No memory leak.
- **Idempotent listener wiring**: `_planManagerWired` guard (`session-manager.ts:755`) prevents duplicate event listeners on session restore.

One note: `deny()` returns `string | null` (the rejection message), but `onTurnEnd()` bypasses `deny()` entirely — it sets state directly. This is intentional since `onTurnEnd()` has no hook awaiting a response. The asymmetry is correct but could use a comment to avoid future confusion.

#### All previously flagged `JSON.parse` sites — false alarm

The subagent's initial list of unguarded `JSON.parse` calls was verified file-by-file:
- `webhook-config.ts:26` — inside try-catch (lines 24–32) ✓
- `workflow-config.ts:48` — inside try-catch (lines 45–52) ✓
- `webhook-github.ts:99,143,160` — all three inside separate try-catch blocks ✓
- `native-permissions.ts:47,63,93` — all inside try-catch blocks ✓
- `session-persistence.ts:86` — inside try-catch (lines 84–122) ✓

Only `version-check.ts:36` is genuinely unguarded (see WARNING above).

#### `native-permissions.ts` — atomic write pattern is correct

Uses write-to-tmp + `renameSync` for atomic updates, with a per-repo in-process mutex (`writeLocks` Map) preventing concurrent write races. Both patterns are production-correct.

#### No shell injection surface confirmed

All child-process spawns use `execFileAsync` with argv arrays (no `shell: true`, no string interpolation). Verified across `webhook-github.ts`, `diff-manager.ts`, `session-manager.ts`, and `claude-process.ts`.

#### Test coverage on new code

`plan-manager.test.ts` covers all state transitions including corrected `onTurnEnd` behavior, stale-ID rejection, and unique ID generation per review round. The orchestrator lifecycle hooks added in `4cdabef` (`approve-child`/`deny-child` endpoints) appear to have lighter integration test coverage — worth adding.

#### `ORCHESTRATOR-SPEC.md` still shows `Status: Draft v0.1`

Feature is GA in v0.5.0. The spec header should be updated.
