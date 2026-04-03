# Daily Code Review: codekin

**Date**: 2026-04-01T00:00:00.000Z
**Repository**: /srv/repos/codekin
**Branch**: chore/repo-health-report-2026-03-30

---

## Daily Code Review — 2026-04-01

**Overall Health: GOOD** — 1,132 tests passing, npm audit clean, no critical findings. Three carry-over warnings from previous reviews remain unresolved.

---

### CRITICAL (0)

None.

---

### WARNING (4 findings)

| ID | File | Finding | Status |
|----|------|---------|--------|
| W-01 | `server/webhook-handler.ts:169` | **Actor allowlist comparison is case-sensitive.** `actorAllowlist.includes(wr.actor.login)` does a strict string match. GitHub usernames are case-insensitive, so a user configured as `"Alice"` won't match a GitHub event for `"alice"`. Fix: normalize both sides — `this.config.actorAllowlist.map(u => u.toLowerCase()).includes(wr.actor.login.toLowerCase())`. Same issue in `webhook-config.ts:59` where the env-var list is parsed: apply `.toLowerCase()` there so the canonical form is always lowercase. | **Carry-over** (3rd week) |
| W-02 | `server/auth-routes.ts:35` | **`/auth-verify` endpoint has no rate limiting.** All other auth-adjacent paths (WebSocket, `/api/health`) have per-IP limiting; this REST endpoint does not. A remote attacker can enumerate tokens without throttling. Fix: apply the same per-IP rate limiter used in `ws-server.ts:349`. | **Carry-over** (2nd week) |
| W-03 | `server/session-routes.ts:55-60` | **`workingDir` accepted without REPOS_ROOT bounds check.** `POST /api/sessions/create` accepts any absolute path as `workingDir` without verifying it falls under `REPOS_ROOT`. `orchestrator-routes.ts:158-164` has the correct guard (`path.startsWith(reposRoot)`); mirror it here. Without this check, a caller with a valid token can start a Claude session in an arbitrary directory (e.g., `/etc` or `/home`). | **Carry-over** (3rd week) |
| W-04 | `server/ws-server.ts:375` | **`X-Forwarded-For` trusted without restricting to the proxy.** The per-IP WebSocket rate limiter reads the client IP from `X-Forwarded-For`. An attacker who can reach the server directly (bypassing nginx) can spoof arbitrary IPs and evade the rate limit entirely. Fix: only trust `X-Forwarded-For` when `req.socket.remoteAddress` is `127.0.0.1` (the local nginx). | **Carry-over** (2nd week) |

---

### INFO (4 findings)

| ID | File | Finding |
|----|------|---------|
| I-01 | `server/crypto-utils.ts:49,73` | **`timingSafeEqual` compares hex strings as UTF-8 buffers.** `Buffer.from(hexString)` without an encoding arg produces UTF-8-encoded ASCII bytes (64 bytes per SHA-256 digest), not the decoded binary (32 bytes). The equality check is still *correct* — identical hex strings produce identical UTF-8 buffers — but it is semantically misleading. The ideal form is either `Buffer.from(s, 'hex')` (compare 32 binary bytes) or pass the comparison length check explicitly. No functional impact, but worth cleaning up for clarity. |
| I-02 | `server/ws-message-handler.ts` | **`prompt_response` `msg.value` may not be redacted before logging.** Previous review flagged this; confirm whether the log path at the prompt-response handler passes the value through `redactSecrets()`. If the user pastes an API key into a prompt response it could appear in server logs. |
| I-03 | `server/approval-manager.ts:121-129` | **`NEVER_PATTERN_PREFIXES` blocklist is incomplete.** The list blocks `ssh`, `sudo`, `curl`, `git reset`, etc., but omits `dd` (raw disk write), `iptables`/`ufw` (firewall rules), and `mkfs` (filesystem format). These are low-probability commands in the context of a dev tool, but adding them is trivial and reduces surface area. |
| I-04 | `server/webhook-handler.ts:216-239` | **Session cap check has a narrow TOCTOU window.** The concurrent-session count is snapshotted before async workspace creation; a burst of near-simultaneous webhooks could exceed the cap. Acceptable in practice given the watchdog timeout cleanup, but worth documenting as a known limitation. |

---

### Resolved Since Last Review

| ID | Finding | Resolution |
|----|---------|------------|
| ~~W-03~~ (prev) | `dangerouslySetInnerHTML` in `ChatView.tsx` without DOMPurify | **Fixed** — `grep` finds no `dangerouslySetInnerHTML` in `src/**/*.tsx`; output is routed through `MarkdownRenderer` which uses DOMPurify 3.3.2. |

---

### Top 3 Actionable Items

1. **Fix actor allowlist case normalization** (`webhook-handler.ts:169`, `webhook-config.ts:59`) — one-line change; prevents legitimate users from being silently blocked by the new allowlist feature. Carry-over for 3 weeks.
2. **Add REPOS_ROOT bounds check to `POST /api/sessions/create`** (`session-routes.ts:60`) — copy the guard from `orchestrator-routes.ts:158-164`. Prevents arbitrary-directory session creation by token holders. Carry-over for 3 weeks.
3. **Rate-limit `/auth-verify`** (`auth-routes.ts:35`) — apply existing per-IP limiter to close the token enumeration gap. Low-effort, consistent with the rest of the auth surface.
