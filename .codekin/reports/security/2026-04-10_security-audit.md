# Security Audit Report — Codekin

**Date:** 2026-04-10
**Scope:** Full codebase — `/srv/repos/codekin`
**Auditor:** Automated (Claude Code security audit)
**Commit:** `0c4da06` (main)

---

## Summary

**Overall Risk Rating: Low**

The Codekin codebase demonstrates solid security fundamentals: no hardcoded secrets, timing-safe token comparisons, HMAC webhook verification, SSRF allowlist enforcement, DOMPurify XSS mitigation, and consistent use of `execFile`/`execFileAsync` (preventing shell injection). One medium-severity path-traversal issue was found in the docs API. All remaining findings are low or informational.

| Severity | Count |
|----------|-------|
| Critical | 0 |
| High | 0 |
| Medium | 1 |
| Low | 2 |
| Informational | 2 |

---

## Critical Findings

None.

---

## High Findings

None.

---

## Medium Findings

### M1 — Authenticated Path Traversal via `/api/docs`

**File:** `server/docs-routes.ts` lines 92–105
**Description:** The `/api/docs` and `/api/docs/file` endpoints accept an arbitrary filesystem path via the `repo` query parameter. Unlike all other path-accepting endpoints in the codebase (e.g., `/api/browse-dirs`, `/api/sessions/create`), there is no restriction of `repoPath` to `REPOS_ROOT` or the home directory. An authenticated user can point this endpoint at any directory or file on the server's filesystem to list markdown files or read their contents.
**Impact:** An authenticated user can exfiltrate any `.md` file accessible to the server process, including files outside the intended repository root (e.g., `~/.claude/`, system markdown files, or documentation containing configuration details).
**Remediation:** Apply the same `allowedRoots = [home, REPOS_ROOT]` boundary check used by `/api/browse-dirs`. Resolve the requested path with `realpathSync` and verify it starts with one of the allowed roots before processing.

---

## Low Findings

### L1 — `headSha` Passed to `git reset --hard` Without Format Validation

**File:** `server/webhook-workspace.ts` lines 134–137
**Description:** The `headSha` value—sourced from GitHub's `workflow_run.head_sha` or Stepflow's `req.headSha`—is passed directly as an argument to `git reset --hard <headSha>` via `execFileAsync`. Unlike `branch` (validated against `/^[a-zA-Z0-9/_.-]+$/`) and `cloneUrl` (validated against a GitHub HTTPS pattern), `headSha` has no format validation.
**Impact:** Since `execFileAsync` is used (not a shell `exec`), shell injection is not possible. However, a crafted SHA value (e.g., `--merge`, `ORIG_HEAD`, or a refspec like `HEAD~1`) could be interpreted by git as a flag or symbolic reference, potentially resetting to an unintended state. Exploitability depends on trust in the webhook sender; with HMAC verification in place, the immediate risk is low.
**Remediation:** Validate `headSha` against `/^[0-9a-f]{40}$/` (or `/^[0-9a-f]{40,64}$/` to future-proof for SHA-256 object names) before use.

### L2 — Overly Broad CSP `connect-src` Directive

**File:** `server/ws-server.ts` line 272
**Description:** The Content-Security-Policy header includes `connect-src 'self' wss: ws:`, which permits the page's JavaScript to open WebSocket connections to **any** host—not just the application's own origin.
**Impact:** If an XSS vulnerability were introduced (despite DOMPurify mitigation), a malicious script could exfiltrate data over WebSocket to an attacker-controlled server. The overly broad directive eliminates a layer of defense-in-depth.
**Remediation:** Narrow `connect-src` to the application's specific origin and the WebSocket host, e.g., `connect-src 'self' wss://${HOST} ws://localhost:*`. Use an environment variable for the production WebSocket host so the CSP can be tightened at deploy time.

---

## Informational Findings

### I1 — Server Binds on All Interfaces (`0.0.0.0`)

**File:** `server/ws-server.ts` line 499
**Description:** The Node.js server listens on `0.0.0.0:32352`, accepting connections on all network interfaces.
**Impact:** In bare-metal deployments, if firewall rules do not restrict external access to port 32352, the WebSocket/HTTP API is directly internet-accessible without the nginx TLS termination layer. The auth token provides protection, but the attack surface is expanded.
**Remediation:** For production deployments, ensure firewall rules restrict port 32352 to localhost or the nginx host only. Optionally, make the bind address configurable (e.g., via a `BIND_HOST` environment variable defaulting to `127.0.0.1` in production).

### I2 — Default `CORS_ORIGIN` Could Mislead Staging Environments

**File:** `server/config.ts` line 22
**Description:** The default `CORS_ORIGIN` value is `http://localhost:5173`. The production guard (which rejects localhost origins when `NODE_ENV=production`) is correct. However, staging environments that do not set `NODE_ENV=production` but also do not set `CORS_ORIGIN` will inherit the localhost default, potentially masking CORS misconfigurations until they reach production.
**Impact:** Low — could result in CORS errors or overly permissive configuration in staging environments only.
**Remediation:** Consider requiring `CORS_ORIGIN` to be explicitly set in any non-development environment, or default to a restrictive value (e.g., empty/none) rather than localhost.

---

## Secrets & Credentials Exposure

**No hardcoded or committed secrets found.**

All sensitive values are loaded exclusively from environment variables at runtime:

- `AUTH_TOKEN` / `AUTH_TOKEN_FILE` — master WebSocket auth token
- `GITHUB_WEBHOOK_SECRET` — GitHub webhook HMAC signing secret
- `STEPFLOW_WEBHOOK_SECRET` — Stepflow webhook HMAC signing secret

Additional protections observed:
- `server/crypto-utils.ts` implements `redactSecrets()`, which strips Bearer tokens, API keys, URL-embedded credentials, and `key=value` secrets from all log output before writing to the console.
- `server/commit-event-hooks.ts` (line 54) writes hook config files with mode `0o600` (owner-read-only) because they contain derived auth tokens.
- No auth tokens or secrets appear in `console.log` calls anywhere in the codebase.
- No `.env` files are present in the repository.

---

## Positive Security Controls Observed

The following security practices deserve explicit acknowledgment:

1. **Timing-safe token comparison** — `server/ws-server.ts` uses `crypto.timingSafeEqual` over SHA-256 hashes for all token comparisons, preventing timing oracle attacks.
2. **HMAC session-scoped tokens** — Child Claude processes receive only an HMAC-SHA256 derived token (`masterToken + "session:" + sessionId`), preventing session-to-session escalation.
3. **HMAC webhook verification** — Both GitHub and Stepflow webhooks are verified with HMAC-SHA256 and timing-safe comparison before processing.
4. **SSRF allowlist for Stepflow callbacks** — Callback URLs are validated against a hostname allowlist and blocked against all RFC-1918/loopback/link-local ranges (including IPv4-mapped IPv6).
5. **No `exec()` with shell** — All subprocess calls use `execFile`/`execFileAsync`/`spawn` with argument arrays, preventing shell injection throughout the codebase.
6. **DOMPurify sanitization** — All `dangerouslySetInnerHTML` usages in the React frontend pass content through `DOMPurify.sanitize()` first.
7. **File upload restrictions** — Extension allowlist, MIME type allowlist, 20 MB size limit, and filename sanitization all enforced on uploads.
8. **Rate limiting** — Auth endpoint (10 req/min/IP), WebSocket connections (30/min/IP), and WebSocket messages (60/sec/connection) are all rate-limited.
9. **Production auth requirement** — Server exits with FATAL at startup if `AUTH_TOKEN` is not configured in production, preventing accidental unauthenticated deployments.
10. **Tool debug logging disabled in production** — `TOOL_DEBUG` is gated on `NODE_ENV !== 'production'`.

---

## Recommendations

1. **(Medium priority)** Fix path traversal in `/api/docs` — apply the `allowedRoots` boundary check already used by `/api/browse-dirs`. This is the only finding with meaningful data-exfiltration potential.

2. **(Low priority)** Add SHA format validation for `headSha` in `server/webhook-workspace.ts` — a one-line regex check (`/^[0-9a-f]{40,64}$/.test(headSha)`) before passing to `git reset --hard`.

3. **(Low priority)** Narrow the CSP `connect-src` directive from the wildcard `wss: ws:` to the application's specific WebSocket origin. Parameterize the production WebSocket host via an environment variable.

4. **(Informational)** Consider binding to `127.0.0.1` by default (or making `BIND_HOST` configurable) so that firewall misconfiguration in bare-metal deployments does not directly expose the API port.

5. **(Informational)** Require `CORS_ORIGIN` to be explicitly configured in staging/CI environments, or fail fast with a warning when `NODE_ENV` is not `development` and `CORS_ORIGIN` is not set.

6. **(Ongoing)** Continue the current practice of using `execFile`/`execFileAsync` for all subprocess calls. Document this as a mandatory pattern in CLAUDE.md so future contributors do not inadvertently introduce shell-string execution.

7. **(Ongoing)** Maintain the existing `redactSecrets()` log scrubbing and `0o600` file permission practices for any new code that handles authentication material.
