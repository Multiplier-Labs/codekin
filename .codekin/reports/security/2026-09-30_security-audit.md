# Security Audit: codekin

**Date**: 2026-09-30T04:44:13.261Z
**Repository**: /srv/repos/Multiplier-Labs/codekin
**Branch**: refactor/loop-engine-guards
**Workflow Run**: aa891d91-aaf7-466d-bccf-00b65c7f6ca5
**Session**: 45751c36-dc0f-4e95-96e9-6383bb27127d

---

I’ll inspect the repository and history, then report findings with file and line references. I won’t change source files or include secret values.The project has a local Express and WebSocket server, a hosted relay, and a React frontend. I’m checking the auth boundaries and file and network handlers next, since those are the most likely paths to a meaningful exploit.## Summary

**Overall risk: High.** The audit found **0 critical, 1 high, and 3 medium findings**. The highest risk is a local WebSocket broadcast path that can send approval prompts to a connection before it authenticates.

Codekin uses a React frontend, a Node.js Express and WebSocket server, and a separate hosted relay. The review covered those entry points, authentication, file and command handlers, deployment configuration, tracked files, and recent Git history. This was a source review; deployed configuration and exploitability in a running environment were not verified.

## Critical Findings

None identified.

## High Findings

### Approval prompts can reach unauthenticated WebSocket connections

- **File:line:** `server/ws-server.ts:456–462`; `server/prompt-router.ts:165–185`, `405–424`
- **Description:** The global broadcaster sends messages to every open socket without checking whether it has completed bearer-token authentication. When a session has no attached client, approval prompts are sent through that broadcaster and can include the session name, question, tool name, tool input, and request ID. A newly opened socket has up to five seconds to authenticate.
- **Impact:** An unauthenticated client connected at the right time could receive sensitive prompt content. The production Origin check limits browser connections, but a non-browser client can supply an Origin header.
- **Remediation:** Track authenticated sockets and broadcast only to them. Add a regression test that opens a socket without sending an auth frame, triggers a global approval prompt, and verifies that no prompt arrives.

## Medium Findings

### Local bearer token is printed in a URL

- **File:line:** `bin/codekin.mjs:96–103`; `src/hooks/useSettings.ts:48–57`
- **Description:** CLI output places the master bearer token in a `?token=` URL. The frontend removes it from the address after loading, but the initial request can already appear in browser history, proxy access logs, and other URL records.
- **Impact:** Anyone who obtains that URL can use the token to access the local server.
- **Remediation:** Print the server URL and token separately. Accept the token through the connection settings UI without putting it in a request URL; redact query strings in proxy logs where existing links remain in use.

### Local server can listen on all interfaces over plain HTTP

- **File:line:** `server/ws-server.ts:610`; `server/config.ts:18–22`
- **Description:** The local server binds to `0.0.0.0` by default. Its bearer-token REST and WebSocket traffic has no built-in TLS requirement.
- **Impact:** If the port is reachable beyond the host, network observers could capture the token and session traffic. Firewall or reverse-proxy protection depends on deployment configuration.
- **Remediation:** Bind to loopback by default. Require an explicit setting for remote binding and document TLS termination and network access controls for that mode.

### Hosted frontend example omits security headers and HTTPS redirect

- **File:line:** `nginx/app.codekin.ai.example:8–47`; `server/relay/relay-server.ts:52–57`
- **Description:** The checked-in hosted nginx example serves HTTP and does not set CSP or HSTS on static frontend responses. The relay sets some headers on API responses, but those do not cover the nginx-served frontend. The example says TLS is added by Certbot; the resulting deployed configuration was not available to verify.
- **Impact:** Deployments based on the example may permit plaintext access or lack browser defenses against injected content.
- **Remediation:** Provide a complete HTTPS example with an HTTP-to-HTTPS redirect and appropriate CSP, HSTS, and other security headers for static responses. Verify the headers on the deployed site.

## Secrets & Credentials Exposure

No hardcoded production credential, private key, or committed `.env` file was identified in the tracked source inspected. A key-shaped string in `server/loop-evaluators.test.ts:236–237` is explicitly an example test fixture.

The local master token is **exposed operationally through printed URLs**, as described above; its value is not included in this report. Recent Git commits were listed, but this review did not establish that the full repository history is free of previously committed secrets.

## Recommendations

1. Gate every WebSocket broadcast on completed authentication, then test the pre-auth window.
2. Stop placing the master token in URLs and review access-log retention for earlier requests.
3. Bind the local server to loopback by default; require explicit remote exposure.
4. Publish and verify a complete hosted HTTPS configuration with security headers.
5. Run a dedicated secret scanner across **all Git revisions**, and rotate any credential it confirms.
6. Add security regression coverage for unauthenticated WebSocket broadcasts and deployed response headers.