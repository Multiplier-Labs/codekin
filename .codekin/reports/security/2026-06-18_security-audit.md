# Security Audit: codekin

**Date**: 2026-06-18T03:35:09.956Z
**Repository**: /srv/repos/Multiplier-Labs/codekin
**Branch**: main
**Workflow Run**: c11c73a9-eebb-4714-a037-464e77bcca1c
**Session**: 3bdfae59-b896-4c04-9628-1145b6667a77

---

# Security Audit — Codekin
**Date:** 2026-06-18  
**Auditor:** Automated (Claude claude-sonnet-4-6)  
**Scope:** `/srv/repos/Multiplier-Labs/codekin` — full source tree, server and frontend

---

## Summary

**Overall Risk Rating: Medium**

The codebase demonstrates solid security awareness in many areas: timing-safe token comparisons, consistent path-traversal bounds checks, DOMPurify sanitization on all HTML injection points, and security headers (CSP, HSTS, X-Frame-Options). No hardcoded secrets or committed `.env` files were found.

The remaining risk surface is concentrated in three areas: intentional shell execution of user-supplied verify commands (authorized but high-blast-radius), a soft CORS misconfiguration in production that logs but does not halt, and a defensive-code gap where `STEPFLOW_WEBHOOK_SECRET` can technically be set to an empty string despite a startup guard.

| Severity | Count |
|----------|-------|
| Critical | 0 |
| High | 1 |
| Medium | 4 |
| Low / Informational | 5 |

---

## Critical Findings

None identified.

---

## High Findings

### H-1: Shell Execution of API-Supplied Verify Commands

**File:** `server/verifier-runner.ts:85`  
**Pattern:**
```typescript
exec(command, { cwd, timeout: timeoutMs, maxBuffer: MAX_BUFFER, env }, ...)
```

**Description:** `child_process.exec()` spawns a full shell. The `commands` array executed here originates from Goal Run API requests (`server/goal-run-routes.ts:104`) and loop template definitions authored through the API. An attacker who obtains a valid auth token can POST a goal run with arbitrary shell commands (e.g., `rm -rf /`, reverse shell, exfiltration) and have them execute with the server process's OS user privileges.

**Impact:** Remote code execution on the server host if auth is compromised. The blast radius extends to any file accessible by the server's OS user, including other users' session data and the auth token file itself.

**Remediation:**
- Restrict `commands` to an allowlist of pre-defined script names (e.g., `npm test`, `npm run lint`) rather than accepting free-form shell strings via the API.
- If free-form commands are a design requirement, run them in a sandboxed container or at minimum under a low-privilege uid with filesystem restrictions (`--read-only`, cgroups).
- Consider replacing `exec()` with `execFile()` and splitting commands into `[binary, ...args]` to prevent shell metacharacter injection.

---

## Medium Findings

### M-1: Production CORS Misconfiguration Logs Warning But Does Not Halt

**File:** `server/config.ts:25–31`  
**Pattern:**
```typescript
if (process.env.NODE_ENV === 'production' && !process.env.CORS_ORIGIN) {
  console.error('[config] ERROR: CORS_ORIGIN is not set in production...')
  // process continues
}
```

**Description:** If `CORS_ORIGIN` is unset in production, the server starts with the default `http://localhost:5173` CORS origin. The logged error is easy to miss in automated deployments. A frontend served from a real domain would be blocked by CORS, but the API would still respond to non-browser clients from any origin without an `Origin` header check.

**Impact:** Operational misconfiguration risk; any HTTP client (curl, scripted attacker) not bound by browser CORS policy can reach all API endpoints regardless of the missing header.

**Remediation:** Replace the `console.error` with `process.exit(1)` when `NODE_ENV === 'production'` and `CORS_ORIGIN` is unset or contains `localhost`.

---

### M-2: Stepflow Webhook Secret Fallback to Empty String

**File:** `server/stepflow-handler.ts:509`  
**Pattern:**
```typescript
const secret = process.env.STEPFLOW_WEBHOOK_SECRET || ''
```

**Description:** The startup guard in `server/ws-server.ts:206–207` correctly fatally errors if `STEPFLOW_WEBHOOK_SECRET` is absent. However, the handler itself still applies `|| ''` as a fallback. If the startup guard is ever bypassed (e.g., the handler is instantiated in a test context or an alternative entry point), HMAC verification would pass vacuously because an empty secret produces a deterministic, brute-forceable signature.

**Impact:** An attacker who can reach the Stepflow webhook endpoint without triggering the startup check could forge valid webhook payloads.

**Remediation:** Remove the `|| ''` fallback. Throw an explicit `Error('STEPFLOW_WEBHOOK_SECRET is required')` at construction time inside `stepflow-handler.ts` if the env var is absent, making the guard local and impossible to bypass.

---

### M-3: `exec()` Used for Coverage Assessment Workflow

**File:** `workflows/coverage-assessment.ts:98`  
**Pattern:**
```typescript
const output = execSync(...)
```

**Description:** The coverage assessment workflow uses `execSync` to run commands. Unlike the verifier runner (which is guarded by auth), this workflow file runs in a different execution context. The command content should be reviewed to ensure it cannot be influenced by untrusted input passed through workflow parameters.

**Impact:** If workflow input parameters are ever interpolated into the exec'd command string, shell injection is possible.

**Remediation:** Verify no user-controlled strings are concatenated into the command. Prefer `execFileSync(binary, argsArray)` over `execSync(commandString)` for all subprocess calls.

---

### M-4: `dangerouslySetInnerHTML` — Verify Full DOMPurify Coverage

**Files:**
- `src/components/ChatView.tsx:200` — ✅ `DOMPurify.sanitize(...)` applied
- `src/components/MarkdownRenderer.tsx:21` — delegates to `renderMarkdownToSafeHtml()`

**Description:** `MarkdownRenderer.tsx` calls `renderMarkdownToSafeHtml()` from `src/components/markdownPipeline.ts`, which does apply `DOMPurify.sanitize()`. Both usages are currently protected. However, the indirection (pipeline function in a separate file) means a future refactor of `markdownPipeline.ts` could inadvertently remove sanitization without a visible change at the injection site.

**Impact:** If DOMPurify is ever removed from the pipeline without updating the component, stored XSS is possible via attacker-controlled markdown content in session messages or docs.

**Remediation:** Add a lint rule or unit test that asserts `renderMarkdownToSafeHtml` always passes output through DOMPurify before returning. Consider adding a comment to the `dangerouslySetInnerHTML` call site referencing the sanitization contract.

---

## Low / Informational Findings

### L-1: ANTHROPIC_API_KEY Propagated to All Child Processes

**File:** `server/codex-process.ts:88`, `server/opencode-process.ts:170`, `server/claude-process.ts:186`

`ANTHROPIC_API_KEY` and `CLAUDE_CODE_API_KEY` are intentionally passed to spawned Claude/Codex/OpenCode processes via an `API_KEY_VARS` allowlist. Note: `claude-process.ts:179` explicitly excludes them by default. This is architecturally necessary but means a compromised child process can read the key from its environment. No actionable fix required; document the trust boundary.

---

### L-2: No Rate Limiting on General REST API Endpoints

**File:** `server/webhook-rate-limiter.ts` covers webhook routes only.

All non-webhook API endpoints (`/api/sessions`, `/api/goal-runs`, `/api/workflows`) have no visible rate limiting. An authenticated attacker with a stolen token could enumerate or flood these endpoints.

**Remediation:** Apply a general-purpose rate limiter (e.g., `express-rate-limit`) to all API routes, with a tighter limit on auth-sensitive paths.

---

### L-3: Auth Token File Permissions Not Verified at Runtime

**File:** `server/ws-server.ts:66–75` (auth token read from file path)

The auth token is read via `readFileSync(authFile)`. While the file is created with `0o600` permissions in some contexts (`server/commit-event-hooks.ts:55`), the server does not verify the file's permissions or ownership before reading. A world-readable auth token file would not be detected.

**Remediation:** After reading the auth token file, check `statSync(authFile).mode & 0o077 === 0` and warn or exit if the file is group/world readable.

---

### L-4: Error Responses May Leak Internal File Paths

**File:** `server/session-routes.ts:176`, `server/docs-routes.ts`

Some 400/403 responses return the literal `workingDir` value back to the client (e.g., `'workingDir could not be resolved ...'`). While not a direct vulnerability, internal path structure is disclosed on invalid input.

**Remediation:** Omit the user-supplied path from error responses; return only a generic reason string.

---

### L-5: Compiled `server/dist/` Checked In to Repository

**Directory:** `server/dist/`

The compiled JavaScript distribution is committed alongside TypeScript sources. If a developer edits `server/dist/*.js` directly, the change is invisible to TypeScript type-checking and code review diffs look confusing. More critically, the dist files could diverge from the sources without detection.

**Remediation:** Add `server/dist/` to `.gitignore` and build on deployment. If keeping dist in the repo is intentional (for zero-build deploys), add a CI step that rebuilds and asserts the dist matches the sources.

---

## Secrets & Credentials Exposure

**No hardcoded secrets were found.** The audit checked for patterns including `sk-`, `ANTHROPIC_API_KEY=`, `Bearer `, `password=`, `api_key=`, and Base64-encoded strings in all `.ts`, `.js`, `.json`, `.yaml`, and `.env` files.

**`.env` and `.env.*` files are absent from the repository** and are correctly excluded in `.gitignore`.

The only credential-adjacent finding was:
- `workflows/coverage-assessment.ts:31`: Contains the example string `STEPFLOW_WEBHOOK_SECRET=changeme` in a code comment. This is illustrative documentation, not an active secret. No action required, but if this file is publicly visible, ensure operators know to change the example value.

---

## Recommendations

1. **[HIGH] Constrain Goal Run verify commands.** Replace free-form shell command strings in the Goal Run API with an allowlist of pre-approved script references (e.g., npm script names from `package.json`). This eliminates the RCE surface without breaking the verifier use case.

2. **[MEDIUM] Hard-fail on missing `CORS_ORIGIN` in production.** Replace the `console.error` in `server/config.ts:25` with `process.exit(1)` so misconfigured production deployments fail loudly at startup rather than silently.

3. **[MEDIUM] Remove `|| ''` from Stepflow secret fallback.** In `server/stepflow-handler.ts:509`, throw at construction time if the env var is absent, eliminating the empty-secret bypass path regardless of how the handler is instantiated.

4. **[MEDIUM] Replace all `exec()` calls with `execFile()`.** In `server/verifier-runner.ts` and `workflows/coverage-assessment.ts`, use `execFile(binary, argsArray)` instead of `exec(commandString)` to prevent shell metacharacter injection, even when input is considered trusted.

5. **[LOW] Add a rate limiter to all API routes.** Apply `express-rate-limit` globally in `server/ws-server.ts` (excluding WebSocket upgrade paths) to limit the impact of stolen tokens and brute-force enumeration.

6. **[LOW] Verify auth token file permissions at startup.** After reading the auth token file, assert the file is not group- or world-readable and exit with a clear error if it is.

7. **[LOW] Add a unit test asserting DOMPurify contract in `markdownPipeline.ts`.** Guard the sanitization step with a test that would fail if `DOMPurify.sanitize` is removed from the pipeline function.

8. **[LOW] Remove internal paths from 400/403 error responses.** Return generic error strings rather than echoing back user-supplied path values to prevent information disclosure.

9. **[INFO] Consider adding `server/dist/` to `.gitignore`** and building on deployment, or add a CI step to detect source/dist divergence.

10. **[INFO] Document the child-process API key trust boundary** in `CLAUDE.md` or inline comments to prevent future developers from inadvertently expanding which processes inherit API keys.