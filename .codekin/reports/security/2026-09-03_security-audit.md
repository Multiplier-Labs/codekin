# Security Audit: codekin

**Date**: 2026-09-03T03:34:34.577Z
**Repository**: /srv/repos/Multiplier-Labs/codekin
**Branch**: feat/deployments-ui
**Workflow Run**: 51fa425b-746c-4e13-8914-724a22c753e4
**Session**: 252009b3-1a64-45ff-8432-4f94865cdcc5

---

I’ll inspect the repository structure and run the requested grep/log checks first, then review the likely entry points and security-sensitive code paths without modifying files.The sandbox failed before the commands could run, so I’m rerunning the same read-only inspection commands outside the sandbox.The project is a TypeScript/Vite app with a Node server. The initial secret grep did not show obvious live credentials, so I’m checking server entry points, auth/relay code, file upload/path handling, process spawning, and production config next.The broad pattern scan is noisy because the app intentionally handles bearer tokens and command execution. I’m narrowing to concrete server files where auth, uploads, local filesystem access, subprocess execution, and hosted sessions are implemented.I found no `server/index.ts`; the executable entry point appears to be elsewhere. I’m locating the actual startup file and reading the rest of upload/session routes to avoid missing route-level issues.The local server binds to all interfaces and appears to support optional origin controls and bearer-token auth. I’m checking that implementation and the relay server’s session/cookie settings closely now.The local API uses bearer tokens only, which limits CSRF relevance there. The hosted relay uses cookie sessions, so I’m checking its state-changing routes for explicit origin or CSRF controls and any IDOR/share authorization gaps.The relay has layered authorization on browser, hub, and connector paths, including grantee filtering. One issue is emerging around cookie-authenticated hosted REST endpoints lacking an explicit same-origin/CSRF gate, so I’m verifying whether middleware elsewhere covers that before classifying it.I’m checking client-side token handling and any Markdown/HTML rendering paths now, since this app displays model output and stores a local bearer token in the browser.The remaining checks are for committed environment/example files and database/query construction. Most database access I’ve seen uses prepared statements; I’m doing a final targeted pass for dynamic SQL and committed secret-like files.I found the hosted relay sets basic security headers but not CSP/HSTS in its own Express layer. I’m checking whether nginx examples cover them and whether pairing/device-link endpoints have additional protections.I’ve finished the code inspection. I’m collecting exact line references for the configuration findings, then I’ll return the Markdown report only.## Summary

Overall risk rating: Medium

Findings count by severity:
- Critical: 0
- High: 0
- Medium: 3

Project overview:
- Stack: TypeScript, React 19, Vite, Express 5, WebSocket `ws`, SQLite via `better-sqlite3`.
- Main local server entry point: `server/ws-server.ts`, launched by `bin/codekin.mjs`.
- Hosted relay/control-plane entry point: `server/relay/relay-server.ts`.
- Sensitive areas reviewed: bearer-token auth, hosted cookie sessions, OAuth/WebAuthn/device-link flows, relay proxy authorization, uploads, repository cloning, webhook HMAC handling, filesystem path handling, subprocess execution, Markdown rendering, and nginx examples.
- Required commands run:
  - `git log --all --oneline | head -20`
  - `git grep -rn "password\|secret\|api_key\|token\|private_key" -- "*.js" "*.ts" "*.py" "*.go" "*.env" "*.json" "*.yaml" "*.yml" 2>/dev/null | grep -v "node_modules\|.git\|test\|spec\|mock" | head -100`

## Critical Findings

None identified.

## High Findings

None identified.

## Medium Findings

### Missing Explicit CSRF/Origin Validation On Hosted Cookie-Authenticated Mutations

File: `server/relay/relay-server.ts:44`, `server/relay/relay-server.ts:104`, `server/relay/pairing-routes.ts:57`, `server/relay/user-routes.ts:82`, `server/relay/share-routes.ts:59`

Description:
The hosted relay uses `express-session` cookie authentication and mounts state-changing routes without a global CSRF token check or explicit `Origin`/`Referer` validation for REST requests. Examples include precreating machine pairing tokens, changing users, and creating/updating shares. The browser WebSocket path does validate `Origin`, but equivalent REST middleware was not found.

Impact:
A malicious page may have limited ability to trigger JSON endpoints because cookies are `sameSite: 'lax'` and the API expects JSON, but the defense is implicit and route-dependent. Future endpoints, content-type changes, same-site deployments, or proxy behavior could make privileged actions CSRF-exploitable.

Remediation:
Add middleware before hosted relay routes that rejects unsafe methods unless `Origin` exactly matches `config.publicUrl` or a synchronizer/double-submit CSRF token validates. Keep unauthenticated code-completion endpoints narrowly exempted only where possession of a single-use code is the intended credential.

### Hosted Relay Example Omits Production TLS And Security Headers

File: `nginx/app.codekin.ai.example:8`

Description:
The hosted nginx example defines only a port 80 server block for `app.codekin.ai` and does not include a 443 TLS server, HTTP-to-HTTPS redirect, HSTS, or CSP headers for the hosted frontend. The relay Express app sets `X-Content-Type-Options`, `X-Frame-Options`, and `Referrer-Policy`, but not HSTS or CSP.

Impact:
If deployed from the example without certbot-generated hardening, OAuth/session traffic and static assets may be served without enforced TLS and without browser-side policy controls that reduce XSS and downgrade risk.

Remediation:
Update the hosted nginx example to include a canonical HTTPS server block, redirect HTTP to HTTPS, set HSTS after TLS is confirmed, and add CSP/Permissions-Policy headers compatible with the hosted frontend.

### Local Bearer Token Stored In localStorage And Accepted From URL Query

File: `src/hooks/useSettings.ts:31`, `src/hooks/useSettings.ts:43`, `src/hooks/useSettings.ts:47`, `bin/codekin.mjs:100`

Description:
The local app persists the server bearer token in `localStorage` and the CLI prints an access URL containing `?token=...`. The app strips the query token after load, but the token can still be exposed through shell history, terminal logs, browser history before replacement, screenshots, extensions, or any successful XSS.

Impact:
Compromise of the token grants access to local Codekin APIs and WebSocket sessions, including session control, file upload, repo operations, and automation endpoints.

Remediation:
Prefer one-time bootstrap codes exchanged for an HttpOnly same-site cookie or store tokens in memory/session storage with short expiry. Avoid printing full bearer-token URLs by default; print a localhost URL plus a separate copy command or one-time login code.

## Secrets & Credentials Exposure

No hardcoded live secrets, private keys, API keys, or committed `.env` files were identified in the scanned source set.

Observed non-secret/expected matches:
- `.codekin/settings.example.json:8` references an example `authFile` path only.
- Lockfiles contain package names with “token” in dependency names.
- Source files contain token/auth handling code but no literal credential values.
- High-confidence regex scan for private keys, AWS keys, GitHub PATs, Stripe live keys, and Slack tokens returned no matches.

## Recommendations

1. Add hosted relay CSRF protection or strict `Origin` validation for all unsafe cookie-authenticated REST methods.
2. Harden `nginx/app.codekin.ai.example` with HTTPS, HTTP redirect, HSTS, CSP, and Permissions-Policy.
3. Replace URL/localStorage bearer-token handling with a short-lived bootstrap flow and HttpOnly cookie or in-memory token handling.
4. Add regression tests for hosted REST CSRF/origin rejection on representative mutation routes.
5. Keep the existing WebSocket origin checks and relay connector-side authorization checks; they are important compensating controls.
6. Continue using `execFile`/argument arrays for subprocesses and prepared SQLite statements; avoid introducing shell-string execution or dynamic SQL.
7. Add automated secret scanning in CI with allowlisted examples to catch future committed credentials.