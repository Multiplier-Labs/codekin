# Security Audit: codekin

**Date**: 2026-10-15T03:32:32.063Z
**Repository**: /srv/repos/Multiplier-Labs/codekin
**Branch**: main
**Workflow Run**: 908a3bc2-e2c6-4ae3-b112-6aa133d00833
**Session**: b41d407b-5731-4020-891a-6c8ecd34a4b0

---

I’ll inspect the repository and run the requested searches, then report verified findings with file and line references. I won’t change any files or include secret values.This is a TypeScript app with a React client and an Express server that can run coding agents and manage GitHub webhooks. I’m focusing on the server’s trust boundaries: authentication, file access, command execution, uploads, and outbound requests.The local server’s REST routes generally require the master token, but I found a WebSocket broadcast path that appears to send events to every connected socket before authentication. I’m checking what those events contain and reviewing the hosted relay for access control gaps.## Summary

**Overall risk: High.** Found **0 critical, 2 high, and 3 medium** findings.

The project is a React and Vite frontend with a Node.js, Express, and WebSocket server. Sensitive paths include local coding sessions, file uploads, GitHub webhooks, and the hosted relay. This was a static audit; no source files were changed or live deployment tested.

## Critical Findings

None identified.

## High Findings

### H1 — Approval prompts can reach unauthenticated WebSocket clients

- **File:** `server/ws-server.ts:456`, `server/prompt-router.ts:420`
- **Description:** The global broadcast sends to every open socket. Authentication happens later, on the first client message. When a session has no connected viewer, broadcasts can include an approval prompt with its tool input.
- **Impact:** A client that connects without a valid token could receive sensitive prompt content during the five-second authentication window.
- **Remediation:** Track authenticated sockets separately and send global broadcasts only to them. Add a regression test that connects without authenticating while a prompt is broadcast.

### H2 — WebSocket accepts large frames before authentication

- **File:** `server/ws-server.ts:452`, `server/ws-server.ts:542`
- **Description:** The WebSocket server sets no application-specific payload limit. Frame parsing and the message rate limit occur after a complete frame has been received.
- **Impact:** Repeated large unauthenticated frames can consume substantial memory and disrupt the server.
- **Remediation:** Set a small `maxPayload` appropriate to the protocol, enforce limits at the reverse proxy, and reject unauthenticated connections as early as practical.

## Medium Findings

### M1 — Trusting client supplied forwarding headers can bypass IP limits

- **File:** `server/ws-server.ts:208`, `server/ws-server.ts:514`, `nginx/codekin.example:69`
- **Description:** With `TRUST_PROXY` enabled, Express trusts the forwarded IP chain, while the WebSocket limiter explicitly uses its first address. The example nginx configuration appends to `X-Forwarded-For`, allowing a client supplied first address to remain in the chain.
- **Impact:** An attacker can vary the apparent IP to evade API and WebSocket rate limits.
- **Remediation:** Trust only the known proxy hop, have nginx overwrite untrusted incoming forwarding headers, and use the resulting trusted address for both limiters.

### M2 — Local master token appears in an access URL and browser storage

- **File:** `bin/codekin.mjs:96`, `src/hooks/useSettings.ts:29`, `src/hooks/useSettings.ts:48`
- **Description:** The CLI prints an access URL containing the master token as a query parameter. The client removes that parameter after loading, but the initial request can reach server or proxy logs; the token is then retained in `localStorage`.
- **Impact:** Exposure through URL handling, logs, or same-origin script compromise grants full local-server access.
- **Remediation:** Replace query-string delivery with a short-lived exchange code, avoid storing the master token in `localStorage`, and rotate tokens exposed through logs.

### M3 — Hosted frontend example lacks security headers

- **File:** `nginx/app.codekin.ai.example:8`, `server/relay/relay-server.ts:52`
- **Description:** The hosted nginx example sets no CSP, HSTS, or frame policy for static pages. The relay sets `X-Frame-Options` and `nosniff` on its API responses, but does not supply CSP or HSTS.
- **Impact:** Deployments based on this example have weaker protection against framing and script injection, and do not instruct browsers to keep using HTTPS.
- **Remediation:** Add CSP and frame protection to static responses, and enable HSTS on the HTTPS virtual host after TLS is configured.

## Secrets & Credentials Exposure

No hardcoded production credentials, committed `.env` files, private keys, or convincing obfuscated secrets were found in the tracked source reviewed. The requested keyword search primarily returned token-related code, configuration references, and dependency lockfile entries. The historical filename check found no tracked `.env`, `.pem`, or `.key` files.

Runtime token exposure is described in **M2**. Example configuration paths and workflow references contain placeholders or environment-variable names, not secret values.

## Recommendations

1. Gate every local WebSocket broadcast on completed authentication.
2. Set and test strict WebSocket frame size limits before message parsing.
3. Correct proxy trust and forwarding-header handling for both API and WebSocket rate limits.
4. Remove master tokens from access URLs and browser persistent storage; rotate any token found in request logs.
5. Add CSP, frame protection, and HTTPS-only HSTS to the hosted deployment configuration.
6. Add focused security tests for unauthenticated broadcasts, oversized frames, and spoofed forwarding headers.