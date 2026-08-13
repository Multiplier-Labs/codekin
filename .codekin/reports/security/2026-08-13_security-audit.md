# Security Audit: codekin

**Date**: 2026-08-13T03:33:04.401Z
**Repository**: /srv/repos/Multiplier-Labs/codekin
**Branch**: main
**Workflow Run**: 6559a68b-3d25-4b42-9d7a-d94f3840323c
**Session**: e74e9336-a271-42dd-93fc-d5b182a6733e

---

## Summary

Overall risk rating: **Medium**

Findings by severity:

| Severity | Count |
|---|---:|
| Critical | 0 |
| High | 0 |
| Medium | 2 |

Scope reviewed: TypeScript/React/Vite frontend, Express/WebSocket local server, hosted relay/control-plane server, GitHub/Stepflow webhook handlers, workflow/goal-run automation, upload/docs/session routes, SQLite-backed relay state, and CLI bootstrap code.

Required commands were run:
- `git log --all --oneline | head -20`
- `git grep -rn "password\|secret\|api_key\|token\|private_key" -- "*.js" "*.ts" "*.py" "*.go" "*.env" "*.json" "*.yaml" "*.yml" 2>/dev/null | grep -v "node_modules\|.git\|test\|spec\|mock" | head -100`

## Critical Findings

None identified.

## High Findings

None identified.

## Medium Findings

### Bearer token is exposed through the startup URL

**File:** `bin/codekin.mjs:96`  
**Related:** `src/hooks/useSettings.ts:41`

**Description:** The CLI prints an access URL containing the bearer token as a query parameter: `http://localhost:<port>?token=<redacted>`. The frontend reads that query parameter, persists it to `localStorage`, then strips it from the visible URL. Stripping helps after page load, but the token can still be captured in terminal scrollback, browser history/session restore artifacts, proxy/access logs for the first request, screenshots, or support bundles.

**Impact:** Anyone who obtains the token can authenticate to the local Codekin server and access session history, browse allowed directories, create sessions, run agent workflows, upload files, clone repositories, and interact with the WebSocket API.

**Remediation:** Avoid putting bearer tokens in URLs. Prefer an out-of-band pairing flow, one-time short-lived bootstrap code, localhost-only callback exchange, or copying the token into a form field. If URL bootstrapping remains, make it a single-use code exchanged server-side for the real token, expire it quickly, and avoid logging request URLs.

### Local server binds to all interfaces by default

**File:** `server/ws-server.ts:580`  
**Related:** `server/config.ts:19`

**Description:** The main server listens on `0.0.0.0`, exposing the REST and WebSocket API on every network interface by default. Authentication is required and token comparison is timing-safe, but the default network exposure is broader than necessary for a local developer tool, especially because the printed access URL implies localhost-only use.

**Impact:** On shared networks, containers, cloud workstations, or developer machines without a firewall, the service becomes reachable by other hosts. A leaked or weakly handled bearer token would then grant remote control over Codekin sessions and local repo operations.

**Remediation:** Default to `127.0.0.1` and add an explicit `HOST` or `BIND_ADDR` environment variable for users who intentionally need remote access. Document the security implications of non-loopback binding and require TLS/reverse-proxy hardening for remote deployments.

## Secrets & Credentials Exposure

No committed high-confidence secrets were identified.

Observed secret-related items were placeholders, examples, or safe references rather than exposed credential values:

| Location | Type | Assessment |
|---|---|---|
| `.codekin/settings.example.json:8` | Example auth token file path | Placeholder path only; no token value present |
| `workflows/coverage-assessment.ts:31` | Example webhook secret value | Documentation/example placeholder; not a real secret |
| `server/stepflow-handler.ts:501` | Example Stepflow secret value | Documentation/example placeholder; not a real secret |
| `server/config.ts:44-49` | Runtime auth token loading | Reads from environment or file; no committed value |
| `server/webhook-config.ts:86-117` | Webhook secret generation/storage | Generates random secret and stores outside repo with `0600` permissions |
| `server/relay/relay-config.ts:81-89` | Hosted relay required secrets | Fails fast when required secrets are missing or placeholder values |

Additional high-confidence scans for private keys, GitHub tokens, AWS keys, OpenAI-style keys, Slack tokens, Google API keys, and JWT-like values found no committed production secrets. The only JWT-like match was a test fixture in `server/crypto-utils.test.ts`.

## Recommendations

1. Remove bearer tokens from startup URLs; replace with a short-lived one-time bootstrap code or explicit token entry flow.
2. Change the default server bind address from `0.0.0.0` to `127.0.0.1`; require explicit opt-in for remote binding.
3. Keep the existing fail-closed auth behavior and timing-safe token comparison; add tests asserting no token is accepted from query parameters.
4. Treat `localStorage` token persistence as a defense-in-depth target: consider session-only storage or a secure local exchange that does not persist the master token in browser storage.
5. Continue enforcing production CORS configuration and WebSocket Origin checks; both are important controls for this app’s mixed REST/WebSocket surface.
6. Keep repo/path boundary checks covered with regression tests, especially for symlinks and `..` traversal in docs, uploads, clone paths, workflow outputs, and session working directories.
7. Consider adding automated secret scanning in CI with high-confidence rules for private keys, cloud keys, GitHub tokens, OAuth client secrets, and `.env` files.
8. Document the security model for workflow and goal-run verification commands: they intentionally execute trusted repo-defined commands, so users should only run automation on repositories they trust.