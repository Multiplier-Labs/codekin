# Security Audit: codekin

**Date**: 2026-10-01T03:32:11.402Z
**Repository**: /srv/repos/Multiplier-Labs/codekin
**Branch**: main
**Workflow Run**: c8592686-0b8e-4737-b45d-d4652df39287
**Session**: d51c8499-7ccb-4fa4-a90c-4055a534ce98

---

I’ll inspect the repository and relevant code paths, then return the audit as Markdown. I won’t modify files or include secret values.The project is a TypeScript/React frontend with an Express server that can access local repositories and coding agents. I’m focusing the audit on the server’s auth boundary, file operations, webhooks, uploads, and process execution.I found two likely high impact issues: broadcasts can reach WebSocket connections before authentication, and saved command approvals appear to match later commands by prefix. I’m checking the call sites and payloads before assigning severity.## Summary

**Overall risk: High.** The audit found **0 critical, 2 high, and 4 medium** findings.

Codekin has a React frontend, a local Express and WebSocket server with access to repositories and coding agents, and a separate hosted relay. The most serious issues are an unauthenticated WebSocket broadcast path and command approvals that can match unsafe follow-on shell commands. This was a static review of the current checkout; no source files were changed and no live deployment was tested.

## Critical Findings

None confirmed.

## High Findings

### 1. Unauthenticated WebSocket connections receive broadcasts

- **File:line:** `server/ws-server.ts:456–462`, `server/ws-server.ts:502–533`; sensitive payload source: `server/prompt-router.ts:420–424`
- **Description:** The global broadcast sends to every open WebSocket, including connections still within the five-second authentication window. A pending tool approval can include its question and `toolInput`.
- **Impact:** A remote client that opens a socket without a token can receive session metadata and potentially sensitive tool arguments while waiting to be disconnected. The production Origin check does not authenticate a non-browser client.
- **Remediation:** Track authenticated sockets and broadcast only to that set. Apply the same check to the workflow event broadcasts at `server/ws-server.ts:682–729`.

### 2. Saved command approvals can authorize a different shell command

- **File:line:** `server/approval-manager.ts:159–173`, `server/approval-manager.ts:192–207`, `server/approval-manager.ts:269–274`
- **Description:** Commands are approved by text prefix without checking the *new* command for shell operators. A saved approval for a command beginning with `cat` or `git diff` can therefore match a later command that starts the same way and adds another command with `;`. The pattern creation check at line 244 applies when saving a rule, not when matching it.
- **Impact:** Agent-supplied shell commands can bypass a fresh approval and run additional commands with the server process’s privileges. Cross-repository approval inference extends the exposure.
- **Remediation:** Parse and authorize the full command at execution time. Reject shell operators for prefix approvals, and avoid passing broad wildcard approvals to the coding harness.

## Medium Findings

### 1. Stepflow callback validation does not cover redirects or DNS resolution

- **File:line:** `server/stepflow-handler.ts:411–458`
- **Description:** The callback URL is checked against a host allowlist and literal private IP ranges, but `fetch()` follows redirects by default. A permitted hostname can redirect to a private address; DNS resolution can also map a permitted hostname to one.
- **Impact:** A validly signed Stepflow request could make the server send callback data to an unintended internal service if an allowed host redirects or resolves there.
- **Remediation:** Disable redirects or validate every redirect target. Resolve and reject private, loopback, and link-local addresses at connection time.

### 2. Local bearer token is stored in browser localStorage

- **File:line:** `src/hooks/useSettings.ts:29–35`, `src/hooks/useSettings.ts:43–58`
- **Description:** The local server’s bearer token is persisted in localStorage. The app also accepts it from a `?token=` URL parameter before removing that parameter.
- **Impact:** Script execution in the app’s origin can read the token. A token supplied in a URL may also be captured in browser history or request logs before the page removes it.
- **Remediation:** Use a short-lived, scoped browser credential where practical. Remove URL-based token delivery and provide a pairing flow that does not place credentials in request URLs.

### 3. Local WebSocket server has no explicit frame size limit

- **File:line:** `server/ws-server.ts:451–452`, `server/ws-server.ts:542–556`
- **Description:** The server constructs `WebSocketServer` without a `maxPayload` limit, then converts incoming frames to strings for JSON parsing. Unauthenticated sockets remain open for up to five seconds.
- **Impact:** Large frames can consume substantial memory and CPU before authentication fails, allowing denial of service.
- **Remediation:** Set a small `maxPayload` appropriate to the largest supported client message and reject oversized frames before parsing.

### 4. Hosted configuration omits CSP and HSTS headers

- **File:line:** `server/relay/relay-server.ts:52–56`; `nginx/app.codekin.ai.example:8–47`
- **Description:** The hosted relay sets some security headers, but the checked-in nginx configuration serving the frontend does not set Content Security Policy or HTTP Strict Transport Security. The relay API also sets neither header.
- **Impact:** If deployed from this configuration without additional controls, browsers receive less protection against script injection and HTTP downgrade.
- **Remediation:** Add a tested CSP and HSTS policy at the hosted reverse proxy, including for static pages and API responses. Verify headers on the deployed HTTPS site.

## Secrets & Credentials Exposure

No hardcoded API key, password, private key, committed `.env` file, or obvious encoded credential was found in the current tracked files. The search found configuration references and placeholders, including `.codekin/settings.example.json:8` and `server/relay/relay-config.ts:109–121`; these are not embedded secret values. The requested recent Git log and keyword search were run. This review did not scan every historical Git object for previously removed secrets.

## Recommendations

1. Gate every local WebSocket broadcast on completed authentication.
2. Replace command prefix approvals with authorization of the complete command at execution time; remove broad shell wildcards already persisted.
3. Restrict Stepflow callbacks across DNS resolution and every redirect hop.
4. Set an explicit WebSocket payload limit before JSON parsing.
5. Stop accepting bearer tokens in URLs and reduce the lifetime and scope of browser-stored credentials.
6. Add and verify CSP and HSTS on the hosted HTTPS deployment.
7. Run a dedicated secret scanner across full Git history, then rotate any credential it identifies.