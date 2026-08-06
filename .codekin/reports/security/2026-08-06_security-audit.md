# Security Audit: codekin

**Date**: 2026-08-06T03:33:08.190Z
**Repository**: /srv/repos/Multiplier-Labs/codekin
**Branch**: main
**Workflow Run**: 4088ecf3-e67b-440d-8daf-f7e8099bf5e0
**Session**: 906dc72d-0bc8-4535-ac4d-3e2a7bd7d3c8

---

I’ll inspect the repository structure and run the requested secret/search commands without modifying files, then review the relevant code paths for security issues.The sandbox failed before the commands could run, so I’m rerunning the same read-only inspection commands with approval as required by the environment.The repo is a TypeScript/Vite app with an Express-style server surface. I’m narrowing the audit to server entry points, auth/webhook/upload routes, process spawning, filesystem access, CORS/origin handling, and config handling.The first pass shows security controls already present in several areas, including bearer auth, origin checks, upload filtering, path containment comments, and security headers. I’m reading the implementations now to separate real issues from guarded patterns.Uploads and clone paths are using allowlists, magic-byte checks for binary uploads, execFile rather than shell execution, and symlink-aware containment checks. I’m checking secondary routes for authorization gaps and filesystem read/write exposure.The authenticated REST and WebSocket routes consistently require the master token, with limited session-scoped hook tokens for child-process callbacks. I’m checking token generation/verification and report-reading helpers because those are the likely places for subtle exposure.Token setup uses a generated local token file and constant-time verification; no committed real secret appeared in the requested grep output. One design concern is that the CLI prints an access URL containing the bearer token in the query string, so I’m checking how the frontend consumes that token and whether it persists in URL/history.The URL token is stripped after first load, but it is also copied into localStorage for future requests. That is a medium-risk client-side storage choice because any future XSS would become full API/session compromise; I’m checking the markdown rendering path before classifying it.Markdown output is sanitized with DOMPurify, so I’m not treating the localStorage token by itself as a high-severity issue. I’m doing one more pass over webhook setup and workflow execution because those touch GitHub APIs, shell-adjacent operations, and persisted configuration.I found one concrete secret-handling problem: the webhook config file persists a webhook secret without an explicit restrictive file mode. I’m doing a final quick check for committed env/private-key style files before writing the report.One high-confidence secret regex command needed a syntax correction because the pattern starts with dashes. I’m rerunning it with `--` so the private-key marker is treated as a pattern, not an option.The corrected command still had the glob flags after `--`, so ripgrep treated them as paths. I’m rerunning it once more with flags before the pattern separator.## Summary

Overall risk rating: **High**

Findings by severity:

- Critical: 0
- High: 1
- Medium: 2

Scope reviewed: TypeScript/Vite frontend, Express/WebSocket server, REST routes, upload handling, docs browsing, webhook handling/setup, workflow routes, process spawning, auth/token handling, filesystem access, and committed configuration files.

Requested scans were run, including:

- `git log --all --oneline | head -20`
- `git grep -rn "password\|secret\|api_key\|token\|private_key" -- "*.js" "*.ts" "*.py" "*.go" "*.env" "*.json" "*.yaml" "*.yml" ... | head -100`
- Additional high-confidence secret and insecure-sink scans

## Critical Findings

None found.

## High Findings

### Webhook secret config is written without restrictive file permissions

**File:** `server/webhook-config.ts:112`

**Description:**  
`saveWebhookConfig()` persists `~/.codekin/webhook-config.json`, which can contain the GitHub webhook HMAC secret. The write uses:

```ts
writeFileSync(tmpFile, JSON.stringify(merged, null, 2) + '\n', 'utf-8')
```

Because no file mode is specified, the resulting temporary file permissions depend on the process umask. On common systems with umask `022`, the secret-bearing file may be created as world-readable before being renamed into place.

**Impact:**  
A local user or compromised process on the same host could read the GitHub webhook secret and forge valid webhook requests. Forged webhook events can trigger automated sessions and workflow activity under the server’s configured GitHub/agent context.

**Remediation:**  
Write the temp file with mode `0o600`, and consider applying `chmodSync(CONFIG_FILE, 0o600)` after rename for existing files. Match the existing safer patterns used in `server/workflow-config.ts`, `server/commit-event-hooks.ts`, and other persistence helpers.

## Medium Findings

### Bearer auth token is persisted in browser localStorage

**File:** `src/hooks/useSettings.ts:21`  
**File:** `src/hooks/useSettings.ts:35`  
**File:** `src/hooks/useSettings.ts:48`

**Description:**  
The frontend stores the Codekin bearer token in `localStorage` under the settings object. It also accepts `?token=` from the URL and immediately persists it to `localStorage`, although it does remove the token from the visible URL afterward.

**Impact:**  
Any future XSS issue, malicious browser extension, or compromised same-origin script would be able to read the token and gain full API/WebSocket access. The reviewed markdown rendering paths use DOMPurify, which reduces current XSS likelihood, but localStorage still increases blast radius.

**Remediation:**  
Prefer an HttpOnly, Secure, SameSite cookie issued after token validation, or store the token in memory/sessionStorage with explicit re-authentication. Avoid `?token=` bootstrap links where possible; use one-time exchange codes if URL-based setup is required.

### Webhook setup accepts arbitrary webhook URLs without server-side URL policy

**File:** `server/webhook-setup-routes.ts:176`  
**File:** `server/webhook-setup-routes.ts:190`  
**File:** `server/webhook-setup-routes.ts:217`  
**File:** `server/workflow-routes.ts:119`  
**File:** `server/workflow-routes.ts:145`  
**File:** `server/workflow-routes.ts:494`

**Description:**  
Authenticated webhook setup routes accept `webhookUrl` from the request body and pass it to GitHub webhook creation/update. The frontend normally supplies the current Codekin URL, but the server does not independently enforce scheme, host, or path constraints.

**Impact:**  
A compromised bearer token or malicious authenticated user can configure GitHub to send webhook deliveries, including signed payloads, to an arbitrary URL. This can exfiltrate repository event metadata and may create a blind request primitive from GitHub infrastructure. It can also accidentally configure insecure `http://` webhook destinations.

**Remediation:**  
Validate `webhookUrl` server-side. Require `https://` outside localhost development, restrict host/path to configured public Codekin origin, and reject private/internal/non-Codekin destinations unless an explicit administrative override is configured.

## Secrets & Credentials Exposure

No committed production secrets, API keys, private keys, or `.env` files were found in the reviewed source tree.

Observed secret-related items:

- `.codekin/settings.example.json:8` references an example auth token file path only; no token value is committed.
- `server/webhook-config.ts:112` can persist a generated webhook secret to `~/.codekin/webhook-config.json` with unsafe default permissions. This is a runtime/local secret exposure risk, not a committed secret.
- `server/commit-event-hooks.ts:55` writes hook auth config with mode `0o600`, which is appropriate.
- `bin/codekin.mjs:137` writes the generated auth token file with mode `0o600`, which is appropriate.
- The requested keyword scan mostly matched lockfile package names and token-related code comments/types, not actual credentials.

No actual secret values are included in this report.

## Recommendations

1. Fix `saveWebhookConfig()` to write webhook config files with mode `0o600` and repair permissions on existing `~/.codekin/webhook-config.json` files.

2. Add server-side validation for webhook setup URLs: require HTTPS in production, restrict to the configured Codekin public origin, and reject arbitrary destinations.

3. Replace long-lived browser `localStorage` bearer-token storage with an HttpOnly Secure SameSite cookie or a short-lived in-memory/session token flow.

4. Add regression tests for sensitive file permissions, especially webhook config, workflow config, hook config, approval config, and session persistence files.

5. Add explicit URL policy tests for webhook setup routes and workflow PR-review auto-setup.

6. Keep bearer tokens out of URLs where possible; replace `?token=` onboarding with a one-time exchange code or explicit manual entry.

7. Continue enforcing the existing path containment patterns for uploads, docs, repos, and orchestrator report reads; these areas currently show good symlink-aware boundary checks.

8. Keep using `execFile`/`spawn` with argument arrays for GitHub/Git/CLI operations; no shell-command injection issue was found in the reviewed command execution paths.