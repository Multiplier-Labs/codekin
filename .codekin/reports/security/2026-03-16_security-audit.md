# Security Audit: codekin

**Date**: 2026-03-16T15:39:36.538Z
**Repository**: /srv/repos/codekin
**Branch**: feat/permission-mode-selector
**Workflow Run**: fe71ccad-24f8-4a16-adf7-19de8d2507b4
**Session**: b4545ae3-1381-4a66-8292-8fb931be000a

---

## Security Audit Report: Codekin

```markdown
## Summary

**Overall Risk Rating: LOW**

The Codekin codebase demonstrates security-first design with defense-in-depth across authentication, input validation, secret management, and WebSocket handling. No critical vulnerabilities were identified. All major attack vectors (SQL injection, command injection, XSS, path traversal) are properly mitigated.

| Severity | Count |
|----------|-------|
| Critical | 0     |
| High     | 0     |
| Medium   | 4     |
| Low      | 3     |
| Info     | 2     |

---

## Critical Findings

None identified.

---

## High Findings

None identified.

---

## Medium Findings

### M1: Fragile Shell JSON Encoding in Post-Commit Hook

**File:** `server/commit-event-hook.sh` (lines ~48–53)  
**Description:** The bash post-commit hook constructs a JSON payload by embedding `$COMMIT_MESSAGE` via `sed` substitutions (`s/\\/\\\\/g; s/"/\\"/g`). This escaping is incomplete — it does not handle newlines, null bytes, tab characters, or other control characters that are valid in git commit messages.  
**Impact:** A specially crafted local commit message could produce malformed JSON, potentially causing the hook to silently drop events or, in a worst-case scenario, inject unexpected values into the POST body. Because input is local (attacker must already have local repo access), this is not directly exploitable remotely.  
**Remediation:** Replace sed-based escaping with `printf '%s\n' "$COMMIT_MESSAGE" | jq -Rs .` or pass the commit message via stdin/tmpfile to avoid shell interpolation entirely.

---

### M2: Per-IP Rate Limiting Relies on Untrusted X-Forwarded-For Header

**File:** `server/ws-server.ts` (lines ~338–360)  
**Description:** WebSocket connection rate limiting extracts the client IP from the `x-forwarded-for` header without any validation that the server is actually behind a trusted reverse proxy. An attacker on a direct connection could spoof this header to bypass per-IP rate limits entirely by rotating fake IPs.  
**Impact:** Rate limiting bypass enables connection flooding attacks against the WebSocket server. An attacker could establish unlimited connections, exhausting server resources.  
**Remediation:** Either (a) validate that the connection originates from a known trusted proxy IP before trusting `x-forwarded-for`, (b) use the raw socket's `remoteAddress` as the fallback when no proxy is configured, or (c) add an explicit `TRUSTED_PROXY` configuration flag and document the requirement.

---

### M3: Session Archive Database Has Default File Permissions

**File:** `server/session-archive.ts` (line ~46)  
**Description:** The SQLite database at `~/.codekin/session-archive.db` is created using `new Database(path)` with no explicit file mode specified. On most Linux systems this results in world-readable permissions (0o644), depending on the process umask.  
**Impact:** The archive database contains full chat session history, working directory paths, and session metadata. Any local user on the same system could read this data.  
**Remediation:** After database creation, explicitly restrict permissions: `chmodSync(dbPath, 0o600)`. The hook config at `~/.codekin/hook-config.json` already sets 0o600 correctly and should serve as the model.

---

### M4: Server Operates Without Authentication When AUTH_TOKEN Is Unset

**File:** `server/ws-server.ts` (lines ~72–75), `server/config.ts`  
**Description:** If the `AUTH_TOKEN` environment variable is not set, `verifyToken()` returns `false` for all tokens — which fails closed by rejecting all authenticated requests. However, if `AUTH_TOKEN` is empty string, no warning is surfaced beyond initial startup. The server can be run deliberately unauthenticated; there is no enforcement mechanism requiring token configuration in production.  
**Impact:** A misconfigured deployment (missing AUTH_TOKEN) results in all API/WebSocket endpoints being inaccessible but with no runtime indicator beyond the startup log. An operator could mistake "no connections working" for an unrelated error and disable auth checks.  
**Remediation:** In production mode (`NODE_ENV=production`), require `AUTH_TOKEN` to be set (similar to the existing `CORS_ORIGIN` enforcement at config.ts). Log a clear startup error and exit if auth is not configured in production.

---

## Low Findings

### L1: Verbose Flag Always Passed to Claude CLI Subprocess

**File:** `server/claude-process.ts` (line ~115)  
**Description:** `--verbose` is unconditionally included in Claude CLI arguments. Verbose output may include internal state or expand the scope of logged data in future CLI versions.  
**Impact:** Low. Current secret redaction patterns in `crypto-utils.ts` cover common formats, but verbose mode may surface data not currently anticipated by the redaction regexes.  
**Remediation:** Make `--verbose` conditional on a `CODEKIN_DEBUG` environment variable rather than always-on.

---

### L2: SQLite Workflow Database Also Uses Default File Permissions

**File:** `server/workflow-engine.ts`  
**Description:** Same issue as M3 — the workflow runs/steps SQLite database is created without explicit mode restriction.  
**Impact:** Low (workflow metadata, not full chat history), but the same principle applies.  
**Remediation:** Apply `chmodSync(dbPath, 0o600)` after creation, consistent with M3 fix.

---

### L3: No Expiry or Rotation Mechanism for AUTH_TOKEN

**File:** `server/ws-server.ts`, `server/config.ts`  
**Description:** The master `AUTH_TOKEN` has no built-in expiry, rotation schedule, or revocation mechanism. Session-scoped tokens are derived from the master token; if the master is compromised, all session tokens are compromised retroactively.  
**Impact:** Long-lived static tokens increase the blast radius of a credential leak.  
**Remediation:** Document a recommended rotation procedure. Consider adding a token version or issue-time field so old tokens can be invalidated without server restart.

---

## Secrets & Credentials Exposure

**Result: No hardcoded secrets found.**

A thorough scan of `*.ts`, `*.js`, `*.json`, `*.yaml`, `*.env`, and shell scripts found no API keys, passwords, tokens, or private keys embedded in source files.

All sensitive values are environment-variable driven:

| Secret | Source |
|--------|--------|
| `AUTH_TOKEN` | `process.env.AUTH_TOKEN` or `--auth-file` CLI arg |
| `GITHUB_WEBHOOK_SECRET` | `process.env.GITHUB_WEBHOOK_SECRET` |
| `STEPFLOW_WEBHOOK_SECRET` | `process.env.STEPFLOW_WEBHOOK_SECRET` |
| `ANTHROPIC_API_KEY` | Passed through to child process env, never logged |
| `CORS_ORIGIN` | `process.env.CORS_ORIGIN` |

Additionally, `server/crypto-utils.ts` implements a robust redaction layer with 10+ regex patterns that scrub Bearer tokens, URL-embedded credentials, and common API key prefixes (`sk-`, `ghp_`, `ghos_`, `api_key=`, etc.) from all log output before emission.

---

## Recommendations

1. **[High] Fix JSON encoding in post-commit hook shell script** (`server/commit-event-hook.sh`).  
   Replace sed-based escaping with `jq -Rs .` to safely encode arbitrary commit messages. This eliminates the risk of malformed requests and potential injection into the JSON payload.

2. **[High] Harden per-IP rate limiting against header spoofing** (`server/ws-server.ts`).  
   Validate `x-forwarded-for` only when the connection originates from a configured trusted proxy IP range. Fall back to raw socket `remoteAddress` otherwise. Without this, the rate limiter can be bypassed on direct-access deployments.

3. **[High] Restrict SQLite database file permissions to 0o600** (`server/session-archive.ts`, `server/workflow-engine.ts`).  
   Chat history and workflow state are sensitive. Apply explicit `chmodSync(dbPath, 0o600)` after database creation to prevent local users from reading session data.

4. **[Medium] Require AUTH_TOKEN in production mode** (`server/config.ts`).  
   Mirror the existing `CORS_ORIGIN` enforcement: if `NODE_ENV=production` and `AUTH_TOKEN` is unset, log an error and call `process.exit(1)`. This prevents misconfigured deployments from silently running without security.

5. **[Medium] Document reverse proxy configuration requirements**.  
   Add a deployment hardening guide covering: required nginx headers (`X-Forwarded-For`, `X-Real-IP`), HTTPS termination, and `TRUSTED_PROXY` configuration. Many of the medium-severity findings become non-issues with proper proxy setup.

6. **[Medium] Make `--verbose` flag conditional** (`server/claude-process.ts`).  
   Gate verbose Claude CLI output on a `CODEKIN_DEBUG=true` environment variable. Reduces log volume in production and minimises the attack surface for future verbose-mode data leaks.

7. **[Low] Document AUTH_TOKEN rotation procedure**.  
   Add operational documentation for rotating the master token without downtime (e.g., rolling restart pattern, grace period for old session tokens).

8. **[Low] Consider adding Content-Security-Policy `nonce`-based script allowlisting**.  
   The current CSP uses `'self'` for scripts, which is good. Adding nonces or hashes for inline scripts would further harden against any future XSS introduction.

9. **[Info] Audit WebSocket message logging in debug mode**.  
   Confirm that raw WebSocket message payloads (which may contain file contents or tool outputs) are never logged at the `debug`/`verbose` level without redaction. The current redaction layer targets secrets by pattern, but large file contents could leak sensitive user data.

10. **[Info] Periodically re-audit third-party dependencies**.  
    Run `npm audit` and `npx snyk test` on a scheduled basis. The security posture of the application-level code is strong; the main residual risk surface is in the dependency tree (`marked`, `highlight.js`, `better-sqlite3`, `ws`, `multer`).
```This is an existing complexity report that just needs to be committed. Let me do that now.Committed and pushed `2026-03-16.md` complexity report to `feat/permission-mode-selector`.