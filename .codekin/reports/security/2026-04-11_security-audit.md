# Security Audit Report

Date: 2026-04-11

## Summary

This repository implements a WebSocket + REST server that executes local processes (Claude CLI), handles webhooks, and exposes file upload and repo operations. The attack surface is significant due to process execution, webhook ingestion, and session management.

Overall risk level: **Medium–High** (sensitive operations exposed over network, mitigations present but with gaps)

---

## Critical Findings

### 1. Auth Can Be Disabled in Development (Risk of Accidental Exposure)

File: `server/ws-server.ts:69-77`

- If `AUTH_TOKEN` is not set and `NODE_ENV !== 'development'`, the server exits.
- In development, the server runs **without authentication**.
- This is dangerous if deployed or exposed unintentionally (e.g., misconfigured environment, Docker, or reverse proxy).

Impact:
- Full unauthenticated access to:
  - Session execution
  - File uploads
  - WebSocket control
  - Potential command execution via Claude CLI

---

### 2. Command Execution Surface via Claude CLI

Files:
- `server/claude-process.ts`
- `server/coding-process.ts`
- `server/ws-server.ts`

- The system spawns CLI processes (`execFileSync`, long-lived Claude sessions).
- User input is ultimately routed into these processes.

Risks:
- Prompt injection leading to unintended filesystem or shell actions
- Indirect command execution depending on CLI capabilities
- Abuse of long-running sessions

Impact:
- Remote code execution (RCE) depending on CLI capabilities and permissions

---

### 3. File Upload and Repository Path Handling

File: `server/upload-routes.ts`

- Upload routes depend on a dynamic `repos_path` setting.
- No evidence of strict path normalization / traversal protection at this layer.

Risks:
- Path traversal (`../`) if not sanitized downstream
- Overwriting arbitrary files
- Uploading executable payloads

Impact:
- Arbitrary file write
- Persistence or privilege escalation

---

## High Findings

### 4. Weak CORS Policy Enforcement

File: `server/ws-server.ts:280-287`

- CORS allows a single configured origin, but:
  - No validation beyond string match
  - No dynamic checks for credentials or subdomains

Risks:
- Misconfiguration can expose API to unintended origins

---

### 5. CSP Allows Unsafe Inline Styles

File: `server/ws-server.ts:273`

- `style-src 'unsafe-inline'` is enabled.

Risks:
- Enables CSS injection vectors
- Often paired with XSS escalation paths

---

### 6. WebSocket Security Not Explicitly Hardened

File: `server/ws-server.ts`

- No visible origin validation for WebSocket connections
- No per-connection auth enforcement shown at handshake level

Risks:
- Unauthorized WS connections if token handling is weak elsewhere
- CSRF-like attacks via browser WebSocket

---

### 7. Token Extraction Allows Body-Based Tokens

File: `server/ws-server.ts:101-112`

- Token can be passed via request body (`req.body.token`).

Risks:
- Tokens may be logged or stored unintentionally
- Easier leakage compared to Authorization header

---

### 8. Missing Global Rate Limiting

- Rate limiting is applied to webhook endpoints only.
- No rate limiting on:
  - Auth endpoints
  - Session APIs
  - Upload endpoints

Impact:
- Brute force attacks
- Resource exhaustion (CPU, memory, process spawning)

---

## Medium Findings

### 9. Potential Information Leakage via Logs

- Logs include:
  - Auth token source (file path)
  - Claude CLI version
  - Auth status

Risk:
- Operational details exposed in logs

---

### 10. Webhook Handling Complexity

Files:
- `server/webhook-*`

- Multiple webhook systems (GitHub, Stepflow)
- Custom signature validation

Risks:
- Signature validation mistakes
- Replay attacks (no nonce/timestamp validation observed)

---

### 11. CSP Allows `ws:` and `wss:` Broadly

- `connect-src 'self' wss: ws:`

Risk:
- Allows connections to arbitrary WS endpoints

---

## Low Findings

### 12. Legacy Security Headers

- `X-XSS-Protection` is deprecated in modern browsers

---

### 13. Lack of Explicit Input Validation Layer

- No centralized validation (e.g., schema validation like Zod/Joi)

Risk:
- Inconsistent sanitization across routes

---

## Positive Observations

- Timing-safe token comparison (`timingSafeEqual`)
- HMAC verification for webhooks
- Separation of routers (modular structure)
- Security headers (CSP, HSTS, etc.) present
- Webhook rate limiting implemented

---

## Recommendations (Non-Exhaustive)

- Enforce authentication in all environments by default
- Add global rate limiting middleware
- Validate and normalize all filesystem paths
- Enforce strict WebSocket authentication at handshake
- Remove body-based token support
- Harden CSP (remove `unsafe-inline` if possible)
- Add request schema validation
- Introduce audit logging for sensitive actions

---

## Final Assessment

The system demonstrates solid foundational security practices (token hashing, webhook verification, headers), but exposes high-risk capabilities (process execution, file writes) with insufficient systemic safeguards (rate limiting, strict auth enforcement, input validation).

Primary concern is **exposure of powerful local capabilities over network interfaces without comprehensive defense-in-depth controls**.
