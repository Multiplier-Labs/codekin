# Security Audit: codekin

**Date**: 2026-10-08T03:32:35.911Z
**Repository**: /srv/repos/Multiplier-Labs/codekin
**Branch**: main
**Workflow Run**: 4b7072d9-4f40-47bb-8509-870e0943044e
**Session**: b50d6c46-b94c-4a52-a3f5-49551015adbe

---

I’ll inspect the repository and trace the security-sensitive entry points, then return the audit as Markdown without changing files.The project is a TypeScript/React app with an Express server and a hosted relay. I’m checking the local file and command routes, relay authorization, and browser rendering paths against the existing security controls.## Summary

**Overall risk: Medium.** The source review found **0 Critical, 0 High, and 2 Medium findings**. No committed credential or private key was found in the scans performed.

Codekin uses a React frontend, a local Express and WebSocket server, and a separate hosted relay. The review covered tracked files, recent commit history, authentication and session controls, request handlers, file paths, command execution, HTML rendering, and configuration. It was a source audit; deployed proxy settings and running services were not tested.

## Critical Findings

None identified.

## High Findings

None identified.

## Medium Findings

### 1. Callback URL validation does not cover redirects or DNS resolution

- **File:line:** `server/stepflow-handler.ts:412–455`
- **Description:** The Stepflow callback checks the URL’s hostname against an allowlist and blocks private IP literals, then calls `fetch()` with its default redirect behavior. A redirect from an allowed host can send the request to a destination that was never checked. A hostname that resolves to a private address also passes the literal-IP check.
- **Impact:** If a sender authorized to submit a signed Stepflow webhook can select an allowed callback URL that redirects, or can influence its DNS, the server may make requests to an internal service. Redirects may also forward the callback body and signature.
- **Remediation:** Disable automatic redirects or validate every destination before following it. Resolve and check destination addresses, and account for DNS changes between validation and connection.

### 2. Local master bearer token is placed in an access URL

- **File:line:** `bin/codekin.mjs:97–100`; `src/hooks/useSettings.ts:48–58`
- **Description:** The CLI prints an access URL containing the master token in `?token=`. The frontend removes the parameter after loading, but the initial HTTP request has already carried it in the URL.
- **Impact:** The token can appear in browser history, reverse-proxy access logs, or other URL-recording systems. Anyone obtaining it has the local server’s master bearer credential.
- **Remediation:** Use a short-lived, single-use bootstrap code in the URL and exchange it for a credential. Until then, exclude query strings from access logs and avoid sharing the printed URL.

## Secrets & Credentials Exposure

No hardcoded credential, private key, or committed `.env` file was identified. The requested `git grep` scan produced mostly references to tokens and secrets, plus lockfile package names; targeted searches found no credential-shaped values outside examples and detection patterns. Actual runtime secrets are loaded from environment variables or local files. This does not establish that past commits or deployed systems contain no secrets.

## Recommendations

1. Close the Stepflow callback redirect and DNS gaps; test redirects to loopback and private addresses.
2. Replace the master-token URL with a short-lived bootstrap flow.
3. Verify production proxy logs omit query strings and rotate any token known to have entered retained logs.
4. Confirm the hosted proxy supplies CSP and HSTS. The relay application sets other security headers in `server/relay/relay-server.ts:52–57`, but does not set those two itself.
5. Keep regression coverage for relay authorization and path normalization; the earlier hosted isolation audit documents fixes whose deployed status was outside this review.
6. Run a dedicated secret scanner across full Git history and review any matches without publishing their values.