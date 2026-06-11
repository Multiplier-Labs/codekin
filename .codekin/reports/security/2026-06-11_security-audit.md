# Security Audit: codekin

**Date**: 2026-06-11T03:34:21.080Z
**Repository**: /srv/repos/Multiplier-Labs/codekin
**Branch**: main
**Workflow Run**: 5c2e724f-b0d9-45f3-bca7-642b979ea1db
**Session**: 66f8409f-828c-4899-a151-ad93c4e018da

---

Now I have enough information to produce a comprehensive security audit report.

---

# Security Audit Report — Codekin
**Date:** 2026-06-11
**Audited revision:** `577c695` (main)
**Auditor:** Automated (Claude Sonnet 4.6)

---

## Summary

**Overall Risk Rating: Medium**

The codebase shows consistent security attention: timing-safe token comparison, HMAC-verified webhooks, per-IP rate limiting across multiple layers, symlink-aware path traversal guards, DOMPurify for markdown rendering, and layered SQL-injection mitigations. No hardcoded secrets or committed `.env` files were found.

| Severity | Count |
|----------|-------|
| Critical | 0 |
| High     | 2 |
| Medium   | 5 |
| Low/Info | 4 |

---

## Critical Findings

*None identified.*

---

## High Findings

### H1 — `allowedTools` Strings Passed to Claude CLI Without Content Validation

**File:** `server/orchestrator-session-router.ts:201-203`, `server/claude-process.ts:207`

**Description:** The `/api/orchestrator/children` endpoint accepts an `allowedTools` array and validates that every element is a string, but does not validate the *content* of each string. These strings are concatenated with commas and passed verbatim as `--allowedTools <value>` to the Claude CLI:

```ts
'--allowedTools', ['Bash(git:*)', ...(this.allowedTools || [])].join(','),
```

An authenticated caller can therefore inject additional CLI flags into the `--allowedTools` value by embedding shell-control characters, whitespace, or Claude CLI flag syntax (e.g. `Bash(*) --dangerously-skip-permissions`). The Claude CLI parses this as a single comma-separated argument, but any unrecognised fragment could alter its behaviour depending on its own argument parsing.

**Impact:** An authenticated orchestrator caller could potentially escalate child-session permissions beyond the intended `acceptEdits` permission mode.

**Remediation:** Validate each element of `allowedTools` against an allowlist of known-safe patterns before use, e.g.:
```ts
const TOOL_PATTERN = /^[a-zA-Z_*():/,.-]{1,200}$/
if (!allowedTools.every(t => TOOL_PATTERN.test(t))) {
  return res.status(400).json({ error: 'allowedTools contains invalid characters' })
}
```

---

### H2 — Master Auth Token Persisted to Disk in `hook-config.json`

**File:** `server/commit-event-hooks.ts:47-52`

**Description:** `ensureHookConfig()` writes the full master auth token (loaded from `AUTH_TOKEN` env var or auth file) to `~/.codekin/hook-config.json` with mode `0600`. The commit hook shell script reads this file to authenticate requests to the server:

```ts
const config: HookConfig = { serverUrl, authToken }
writeFileSync(HOOK_CONFIG_PATH, JSON.stringify(config, null, 2), { encoding: 'utf-8', mode: 0o600 })
```

The master token can derive **all** session-scoped tokens (`deriveSessionToken(masterToken, sessionId)`), so possession of this file grants full server access. Note: this finding has appeared in previous audit reports (2026-03-16, 2026-04-02, 2026-04-30) without being remediated.

**Impact:** Backup software, core dump leakage, local privilege escalation, or an attacker who reads `~/` would gain full Codekin API access. All session-scoped tokens are also compromised.

**Remediation:** Derive a narrow HMAC token scoped only to the commit-event endpoint:
```ts
const hookToken = deriveSessionToken(masterToken, 'commit-event-hook')
```
Then verify it server-side in the commit-event handler. This mirrors the pattern already used for child Claude processes in `session-lifecycle.ts:118-129`.

---

## Medium Findings

### M1 — `model` Parameter Not Validated Before Being Passed to Claude CLI

**File:** `server/orchestrator-session-router.ts:190`, `server/claude-process.ts:207`

**Description:** The `model` field from the `POST /api/orchestrator/children` request body is passed directly as `--model <value>` to the Claude CLI (`claude-process.ts:207`) without format validation. While the WebSocket `set_model` path (`ws-message-handler.ts:193`) accepts any non-empty string acknowledging dynamic model availability, the REST spawn path performs no shape check at all.

**Impact:** A caller can pass a model string containing characters that influence CLI argument parsing (spaces, `--` sequences). Worst case, a crafted model string could inject additional CLI flags.

**Remediation:** Apply a format guard on the REST path:
```ts
if (model && !/^[a-zA-Z0-9][\w.-]{0,100}$/.test(model)) {
  return res.status(400).json({ error: 'Invalid model identifier' })
}
```

---

### M2 — `OrchestratorMemory` SQLite Database Created Without `chmod 0o600`

**File:** `server/orchestrator-memory.ts:64-68`

**Description:** `SessionArchive` (`session-archive.ts:50`) and `WorkflowEngine` (`workflow-engine.ts:347`) both call `chmodSync(resolvedPath, 0o600)` after opening their SQLite databases, restricting read access to the owner. `OrchestratorMemory` opens `~/.codekin/orchestrator/memory.sqlite` but applies no `chmodSync` call — the file is created at the process umask (typically `0o644`), making it world-readable.

**Impact:** The orchestrator memory database stores session history, trust records, and free-form memory items that may contain sensitive information (workflow outputs, internal notes, partial API responses). Other local users on a multi-user system can read this data.

**Remediation:** Add `chmodSync(resolvedPath, 0o600)` after database creation in `OrchestratorMemory` constructor, matching the pattern in `SessionArchive`.

---

### M3 — `Content-Security-Policy` Permits `'unsafe-inline'` for Styles

**File:** `server/ws-server.ts:314`

**Description:** The server-sent CSP header is:
```
style-src 'self' 'unsafe-inline' https://fonts.googleapis.com
```
The `'unsafe-inline'` directive for styles allows arbitrary CSS injection if any endpoint ever reflects user-controlled content into HTML without full sanitization.

**Impact:** CSS injection can be leveraged for data exfiltration (via CSS attribute selectors that trigger network requests), UI redress attacks, and in some browser versions cross-origin attacks. While the current codebase does not obviously reflect unsanitized content into HTML, the broad permission reduces defence-in-depth.

**Remediation:** Replace `'unsafe-inline'` with a `nonce-<value>` or `hash-<value>` source for the inline styles that are actually needed. Alternatively adopt CSS Modules (already partially in use via Tailwind) to eliminate inline styles entirely.

---

### M4 — `task` Field in Orchestrator Child Spawn Not Length-Bounded

**File:** `server/orchestrator-session-router.ts:186-198`

**Description:** The `/api/orchestrator/children` endpoint validates `repo`, `task`, and `branchName` for presence, and `branchName` for character set. However, the `task` string (which is written verbatim into the Claude session's initial prompt via `buildPrompt()`) has no maximum length enforced at the API level.

**Impact:** An authenticated caller can send an arbitrarily large `task` payload, potentially exhausting memory when the prompt is built and buffered, or degrading context-window usage for the spawned Claude process. There is also a mild prompt-injection risk if a future code change interpolates `task` into a structured format without escaping.

**Remediation:** Cap `task` at a reasonable limit (e.g. 10 000 characters):
```ts
if (task.length > 10_000) {
  return res.status(400).json({ error: 'task exceeds maximum length (10,000 characters)' })
}
```

---

### M5 — WebSocket Auth Token Transmitted in First Message Frame (Not in HTTP Upgrade)

**File:** `server/ws-server.ts:494-504`

**Description:** Authentication is performed by requiring the first WebSocket message after connection to be `{ type: 'auth', token: '...' }`. This means the bearer token is sent over the WebSocket data channel rather than in the HTTP `Authorization` or `Cookie` header during the upgrade handshake.

**Impact:** The token is therefore subject to the same transport security as the WebSocket connection, but is not protected by the 5-second auth timeout if the client sends other message types first (the current code correctly closes on non-auth first messages). However, intermediaries that log WebSocket frame bodies (debug proxies, some WAFs) will log the token in plaintext. Additionally, it is not possible to reject unauthenticated connections at the HTTP layer (e.g. by a reverse proxy).

**Remediation:** Pass the token in the HTTP `Authorization: Bearer` header during the WebSocket upgrade, verifiable in the `connection` event via `req.headers.authorization`. This allows middleware and reverse proxies to enforce auth before the WebSocket connection is fully established, and prevents token appearance in frame-level logs.

---

## Low / Informational Findings

### L1 — CORS `Access-Control-Allow-Credentials` Not Set (Positive)

**File:** `server/ws-server.ts:323-327`

The CORS headers do not include `Access-Control-Allow-Credentials: true` and the frontend does not use `credentials: 'include'`. This correctly prevents cross-origin authenticated requests even if the `Access-Control-Allow-Origin` were ever misconfigured. No action needed.

---

### L2 — `X-Permitted-Cross-Domain-Policies` Header Absent

**File:** `server/ws-server.ts:306-319`

The security header middleware sets `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, `Permissions-Policy`, and `Content-Security-Policy` — a good baseline. The `X-Permitted-Cross-Domain-Policies: none` header, which blocks Adobe Flash and PDF cross-domain policy files, is absent. While Flash is obsolete, some PDF readers still respect this header.

**Remediation (Low priority):** Add `res.header('X-Permitted-Cross-Domain-Policies', 'none')` alongside the existing security headers.

---

### L3 — `DOMPurify` Used Without Explicit Config (Permissive Defaults)

**File:** `src/components/markdownPipeline.ts:44`

`DOMPurify.sanitize(html)` is called with default options. DOMPurify defaults are safe in most cases, but the app does not explicitly set `ALLOWED_TAGS`, `ALLOWED_ATTR`, or `FORCE_BODY`. The `afterSanitizeAttributes` hook that adds `target="_blank"` and `rel="noopener noreferrer"` is correct, but a future developer might not realise that the sanitiser is responsible for all HTML safety and may add a code path that bypasses it.

**Remediation (Low):** Document the security dependency on DOMPurify in `markdownPipeline.ts` with a comment; consider locking to explicit allowed tags suited to Markdown output.

---

### L4 — `commit-event-hook.sh` `json_escape` Fallback Does Not Escape All JSON Control Characters

**File:** `server/commit-event-hook.sh:65-71`

The `jq`-less fallback `json_escape` function escapes `\`, `"`, tab, and `\r`, but does not escape `\n` (newline), `\b` (backspace), `\f` (form feed), or Unicode control characters (U+0000–U+001F). A crafted commit message containing a literal newline would produce invalid JSON, causing the webhook request to be rejected by the server's JSON parser rather than processed, so the practical impact is denial-of-service on the hook call rather than injection.

**Remediation (Low):** Add `\n` escaping to the fallback path, or document that `jq` is a required dependency. The `jq` path (preferred path) is already correct.

---

## Secrets & Credentials Exposure

No hardcoded API keys, passwords, private keys, or base64-encoded credentials were found in any committed source file.

- `AUTH_TOKEN` is loaded exclusively from the `AUTH_TOKEN` environment variable or `AUTH_TOKEN_FILE` path — never embedded in source.
- `GITHUB_WEBHOOK_SECRET` and `STEPFLOW_WEBHOOK_SECRET` are loaded from environment variables only.
- `.gitignore` correctly excludes `.env`, `*.local`, `.claude/settings.local.json`, and `.claude/CLAUDE.md`.
- `~/.codekin/hook-config.json` (outside the repository) holds the master auth token at `0o600` mode. See **H2** for the recommendation to scope this credential.
- `~/.codekin/webhook-config.json` (outside the repository) holds the GitHub webhook secret at default umask permissions — consider applying `0o600` here as well (`webhook-config.ts:84`).

---

## Recommendations

1. **(H2 — High, quick win)** Replace the master auth token in `hook-config.json` with a narrowly-scoped HMAC-derived credential using `deriveSessionToken(masterToken, 'commit-event-hook')`, and update the commit-event server route to verify it. This has been flagged in three previous audit reports and should be prioritised.

2. **(H1 — High)** Add a content-pattern allowlist for each string in `allowedTools` before concatenating and passing to the Claude CLI, preventing argument injection through crafted tool name strings.

3. **(M1 — Medium)** Validate the `model` identifier format (regex `^[a-zA-Z0-9][\w.-]{0,100}$`) in the `/api/orchestrator/children` route before it is forwarded to `--model`.

4. **(M2 — Medium)** Add `chmodSync(resolvedPath, 0o600)` in `OrchestratorMemory` constructor after database creation to match the permissions already applied to `session-archive.db` and `workflows.db`.

5. **(M3 — Medium)** Replace `style-src 'unsafe-inline'` in the CSP header with per-rule nonces or hashes. Audit the actual inline styles that are needed and generate a hash-based allowlist.

6. **(M4 — Medium)** Enforce a maximum length (10 000 characters) on the `task` field in `/api/orchestrator/children` to prevent memory exhaustion and guard against prompt-injection via oversized payloads.

7. **(Medium)** Apply `0o600` to `~/.codekin/webhook-config.json` after writing, mirroring the handling already done for `hook-config.json`.

8. **(M5 — Medium, architectural)** Move WebSocket authentication from the first message frame into the HTTP Upgrade request (`Authorization: Bearer` header), enabling reverse-proxy-level enforcement and preventing token appearance in WebSocket frame logs.

9. **(L4 — Low)** In the `commit-event-hook.sh` `json_escape` fallback, add escaping for `\n`, `\b`, `\f`, and other JSON control characters, or explicitly document that `jq` is required.

10. **(L2 — Low)** Add `X-Permitted-Cross-Domain-Policies: none` to the security headers middleware in `ws-server.ts`.