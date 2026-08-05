# Security Audit: codekin

**Date**: 2026-08-05T12:36:39.462Z
**Repository**: /srv/repos/Multiplier-Labs/codekin
**Branch**: main
**Workflow Run**: efa2e0ce-d367-435d-9e31-986c2aa7f0bb
**Session**: 364310a8-b568-434f-aa4f-9c4c8d86b807

---

I’ll inspect the repo and run the requested searches without modifying files. I’ll keep the final response as pure Markdown so the workflow can save it directly.The sandbox failed before the shell ran, so I’m rerunning the same read-only audit commands with escalation. These only inspect repository files and git history output.The initial scan shows a TypeScript/Vite app with an Express-style server and workflow/webhook surfaces. I’m drilling into server entry points, auth, websocket origin checks, upload routes, process spawning, and webhook handling because those are the highest-risk areas here.The grep results did not show obvious committed secrets, but the routing and process-control code is where auth boundary mistakes would matter. I’m checking the concrete middleware ordering and command execution paths before classifying findings.The user-side approval for `sed` reads was rejected, so I’m switching to `rg`-based reads, which already worked for repository inspection. I’ll keep this read-only and focus on specific security-relevant symbols.Approval mode changed, so I can continue with normal read-only commands now. I’m resuming the audit from the route and process-control files.So far I’m seeing several defensive controls already present: bearer auth on APIs, HMAC checks for enabled webhooks, `execFile`/`spawn` rather than shell execution in most places, path canonicalization in several directory flows, and CSP/security headers. I’m now checking the exceptions: raw markdown rendering, verifier command execution, report/doc file serving, webhook workspace operations, and persistent config permissions.One concrete issue is emerging around token handling: the CLI prints an access URL with the bearer token in the query string. Even if convenient for local use, query tokens leak through browser history, screenshots, referrers, and reverse proxy logs more easily than headers or one-time login flows.The token-in-URL issue is broader than the CLI: the frontend explicitly consumes `?token=` and stores it in `localStorage`. I’m checking whether that token is removed from the address bar after import, because that decides whether this is just local-storage risk or also persistent URL exposure.The webhook and commit-hook code stores secrets outside the repo, and most files that are intentionally secret-bearing use `0600`. I found one persisted webhook config writer that does not set restrictive permissions, which is worth reporting because it can contain the GitHub webhook secret.Stepflow callback SSRF is mostly covered by an explicit callback-host allowlist and private-address rejection. The clone/workspace path uses argument-vector git calls, but the Stepflow `repo` value is trusted from the signed sender and should still be constrained operationally if the webhook secret is shared across workflows.I found a more material issue in attachment handling for the OpenCode provider: it parses attachment paths from a text prefix and reads those paths directly. Since the prefix is part of the normal chat input format, an authenticated caller can reference arbitrary server-readable files instead of only uploaded attachments.I’m doing one dependency vulnerability check as supporting context. The requested audit focuses on source-level issues, but this project is an npm app with lockfiles, so an `npm audit` result helps avoid missing known vulnerable packages.## Summary

Overall risk rating: **High**

Findings count: **0 Critical**, **2 High**, **2 Medium**. No committed hardcoded secrets were confirmed in the scanned source/config files. The main risks are authenticated arbitrary local file attachment handling, a known high-severity Multer denial-of-service advisory, token exposure through URL/localStorage workflows, and permissive filesystem permissions for persisted webhook secrets.

Audit commands run included:

```bash
git log --all --oneline | head -20
git grep -rn "password\|secret\|api_key\|token\|private_key" -- "*.js" "*.ts" "*.py" "*.go" "*.env" "*.json" "*.yaml" "*.yml" 2>/dev/null | grep -v "node_modules\|.git\|test\|spec\|mock" | head -100
npm audit --omit=dev --json
npm audit --json
```

## Critical Findings

None found.

## High Findings

### Arbitrary server-side file read through attachment prefix

File: `server/opencode-process.ts:1620`

Description: OpenCode message handling parses a user-controlled text prefix matching `[Attached files: ...]`, splits the supplied paths, and reads each path directly with `readFileSync()` if it exists. The frontend normally builds this prefix from `/api/upload` results, but the server accepts the same prefix from ordinary chat input without verifying that each path came from an upload or resides under `SCREENSHOTS_DIR`. Related Codex handling also trusts the same prefix for local image paths at `server/codex-process.ts:730`.

Impact: Any authenticated client, or any attacker who obtains the bearer token, can cause the server to read arbitrary files accessible to the Codekin process and send their contents to the provider. This can expose local secrets such as SSH keys, auth files, environment files, repository secrets, and private source files.

Remediation: Replace the text prefix protocol with structured attachment IDs returned by `/api/upload`. On the server, resolve each attachment with `realpathSync()` and require it to be under `SCREENSHOTS_DIR`; reject absolute or non-upload paths. For OpenCode, avoid reading arbitrary text attachments from paths supplied by the chat message.

### Vulnerable Multer version allows denial of service

File: `package.json:44`

Description: `npm audit` reports `multer` as a direct high-severity vulnerable dependency. The locked installed version is `2.1.1` in `package-lock.json:5981` and `server/package-lock.json:2345`, affected by `GHSA-72gw-mp4g-v24j` and `GHSA-3p4h-7m6x-2hcm`.

Impact: The authenticated upload endpoint at `server/upload-routes.ts:213` uses Multer. A malicious or compromised authenticated client could trigger denial-of-service behavior through crafted multipart uploads.

Remediation: Upgrade Multer to a fixed release, regenerate both root and server lockfiles, and rerun `npm audit`. Keep the existing file size and type validation, but do not rely on those controls as a substitute for patching the parser.

## Medium Findings

### Webhook secret config is written without restrictive file mode

File: `server/webhook-config.ts:112`

Description: `saveWebhookConfig()` persists merged webhook configuration to `~/.codekin/webhook-config.json`, which can include the GitHub webhook secret, but writes the temp file with a plain string encoding and no explicit `0600` mode. Other secret-bearing files in the repo use `mode: 0o600`, for example `server/commit-event-hooks.ts:55`.

Impact: On hosts with permissive umask or shared local users, the webhook secret may be readable by other users. Disclosure of this secret allows forged GitHub webhook deliveries when webhook processing is enabled.

Remediation: Write the temp file with `{ encoding: 'utf-8', mode: 0o600 }`, call `chmodSync(CONFIG_FILE, 0o600)` after rename for existing files, and document expected permissions for `~/.codekin/webhook-config.json`.

### Master auth token is distributed through URL query string and persisted in localStorage

File: `bin/codekin.mjs:99`

Description: The CLI prints an access URL containing `?token=<token>`. The frontend then imports `token` from the query string and persists it in `localStorage` at `src/hooks/useSettings.ts:29`. The code strips the query parameter from the browser address bar after loading, which helps, but the token is still exposed in terminal output, browser history before replacement, screenshots, copied URLs, and any intermediary logs that capture the original request.

Impact: The token is the master bearer credential for REST and WebSocket APIs. Disclosure can allow full control of sessions, repository operations, uploads, workflow actions, and tool approvals.

Remediation: Stop putting the token in the URL. Prefer a manual token prompt, one-time pairing code, or local callback flow that exchanges a short-lived code for the token. If browser persistence is required, consider narrower session-scoped credentials and explicit expiry rather than storing the master token in `localStorage`.

## Secrets & Credentials Exposure

No real committed secrets were confirmed in source files during this scan.

Observed non-secret placeholders and references:

- `.codekin/settings.example.json:8` references an example auth token file path.
- `docs/SETUP.md`, `docs/API-REFERENCE.md`, and `docs/INSTALL-DISTRIBUTION.md` contain placeholder token/secret documentation.
- `ecosystem.config.cjs.example:13` reads an auth token from a placeholder file path.
- `server/commit-event-hook.sh:76` uses an environment-loaded auth token but does not hardcode it.
- `server/crypto-utils.test.ts:98` contains a JWT-shaped test string, not a real credential.

No `.env`, private key, PEM, or obvious credential files were found by filename scan.

## Recommendations

1. Replace attachment path prefixes with server-issued upload IDs and enforce `realpath` containment under `SCREENSHOTS_DIR`.
2. Upgrade `multer` to a fixed version and regenerate both root and server lockfiles.
3. Remove master tokens from access URLs; use a pairing/login flow or manual entry instead.
4. Add `0600` permissions and post-rename `chmod` for `~/.codekin/webhook-config.json`.
5. Rotate any webhook secret stored by versions of the app that may have written world-readable config files.
6. Add regression tests for forged `[Attached files: ...]` messages using paths outside the upload directory.
7. Add a dependency audit check to CI for production dependencies.
8. Consider reducing the privilege of session-scoped tokens and using them more broadly for internal hooks instead of storing or distributing the master bearer token.