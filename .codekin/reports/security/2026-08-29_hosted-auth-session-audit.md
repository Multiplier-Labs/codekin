# Hosted Authentication and Session Security Audit

**Date:** 2026-08-29  
**Scope:** `app.codekin.ai` account admission, browser sessions, relay authorization, and isolation of local GitHub repositories  
**Anchor:** `9384465` (`wt/eb64f6dc`)  
**Method:** Static review of the hosted relay and connector, review of prior audit findings, and unauthenticated checks against the production deployment

## Executive summary

New account creation is **not blocked**. Any GitHub user can complete OAuth and a row is inserted in the `users` table. A login not named by `OWNER_GITHUB_LOGIN` or `ALLOWED_GITHUB_LOGINS` receives `status = pending`; protected REST routes and new browser WebSocket connections then refuse access. This currently prevents a newly created, non-allowlisted account from reaching a machine or repository, but it still permits unbounded pending-account creation and retention of the GitHub profile/email collected during OAuth.

The main repository boundary is structurally sound: the GitHub OAuth token requests only identity scopes and is discarded after profile lookup; repository access occurs through a paired local connector. A browser must own the paired machine or have a session-specific share, and the connector independently enforces the path and session permission policy before using the local machine token.

Existing sessions are not fully revocable. Disabling an account blocks later protected REST requests and later WebSocket upgrades, but an already-open WebSocket remains authorized. Likewise, deleting or expiring a share does not affect a socket that already cached the grant. These are material gaps for the stated requirement that an existing session must not retain access after revocation.

## Findings

| ID | Severity | Finding | Status |
|---|---|---|---|
| HSA-01 | High | Account disablement does not terminate already-open browser WebSockets | Open |
| HSA-02 | High | Share revocation/expiry does not affect already-open browser WebSockets | Open, previously known |
| HSA-03 | Medium | Removing a login from the allowlist does not revoke an active account | By design, operationally risky |
| HSA-04 | Low | OAuth creates pending accounts instead of rejecting non-allowlisted identities before persistence | Open |
| HSA-05 | Low | No explicit server-side session inventory or “log out all sessions” control exists | Open |

### HSA-01 — Account disablement does not terminate open WebSockets — High

`authenticateUpgrade` re-reads the user row and prevents a disabled user from opening a new browser WebSocket. `createRequireActiveUser` similarly re-checks every protected REST request. After upgrade, however, `BrowserHub` stores the `SessionUser` on the client and does not re-check user status per frame or subscribe to account revocation. A WebSocket opened while the user was active can therefore remain connected and continue forwarding REST envelopes and session-stream frames after the account is disabled.

This is particularly important because the cookie has a rolling 30-day lifetime and an open WebSocket is not automatically constrained by cookie expiry. The previous remediation addressed stale cookies and new upgrades, but not live connections.

**Recommendation:** add a central user-revocation operation that deletes all of the user's server-side sessions and instructs `BrowserHub` to close every socket for that user. For defense in depth, re-resolve current account and grant state before privileged requests/channel actions or use a short-lived authorization snapshot with forced refresh.

### HSA-02 — Share revocation/expiry is not live — High

Machine access is resolved once during the browser `hello` frame and cached as `client.access`. Every later REST request and stream channel derives its connector principal from that cached grant. Deleting a share or reaching `expires_at` updates database state only; the already-open browser socket retains the old permissions until it reconnects.

This enables continued viewing of and interaction with another person's coding session—and therefore repository content—after the owner believes access was revoked. This was documented as Medium in the 2026-08-08 audit. Given the explicit requirement that access to other people's repositories be promptly revocable, this audit rates it High.

**Recommendation:** inject `BrowserHub` into share mutation routes and close/re-authorize affected sockets immediately on deletion, permission reduction, or expiry. Also re-resolve grants when opening a channel and before forwarding a request, so expiry does not depend on a timer firing exactly on time.

### HSA-03 — Allowlist removal does not deactivate existing users — Medium

`upsertUserFromGithub` only upgrades `pending` users to `active`; it deliberately never demotes an existing active user when their login disappears from `ALLOWED_GITHUB_LOGINS`. Therefore changing the environment allowlist is not a revocation operation. Operators must update the database status to `disabled`, and even that currently leaves HSA-01's live-socket window.

**Recommendation:** provide an authenticated owner/admin user-management endpoint or CLI with an atomic “disable user” operation that changes status, removes server-side sessions, and closes live sockets. Document clearly that allowlist removal alone is not sufficient, or change login reconciliation to fail closed.

### HSA-04 — Non-allowlisted OAuth users are persisted as pending — Low

The callback fetches the GitHub profile and email, calls `upsertUserFromGithub`, and only afterward relies on `pending` status to block protected resources. This means public signup is open at the identity-record level even though application access is gated. Production's OAuth start endpoint is publicly reachable and issues a correctly protected session cookie.

**Recommendation:** if the intended policy is “no new accounts,” reject non-allowlisted GitHub logins before inserting a user. Avoid requesting/storing email for rejected users unless there is a documented access-request workflow and retention policy. Retain rate limiting and add cleanup/limits for abandoned OAuth sessions and pending users.

### HSA-05 — No global session revocation control — Low

Sessions are server-side SQLite records keyed by a signed, host-only cookie and roll for 30 days. Logout destroys the current session, but there is no user-facing session list, per-device revocation, or logout-all operation. A copied cookie remains useful until it expires or its session-store row is removed manually. Cookie signing prevents forgery, not replay.

**Recommendation:** add session metadata (user ID, creation time, last use, user agent, approximate IP), session inventory, and logout-all/per-session deletion. Rotate the session ID after other privilege changes and define a shorter absolute lifetime in addition to rolling inactivity expiry.

## Controls verified

- Production issues `codekin_relay_sid` with `HttpOnly`, `Secure`, `SameSite=Lax`, host-only scope, and a 30-day expiry.
- OAuth uses 128-bit random state, saves it before redirect, and regenerates the session after successful authentication to prevent fixation.
- The production callback is fixed to `https://app.codekin.ai/api/auth/github/callback`.
- GitHub OAuth requests `read:user user:email`, not repository scope, and the access token is discarded after profile retrieval.
- Protected REST routes re-read user status from the database.
- Browser WebSocket upgrades require an exact `Origin` match and an active database user.
- Machine listing and WebSocket hello enforce owner-or-share access.
- The connector independently limits proxy paths, filters session lists for grantees, and checks every session-stream action against the granted session permissions.
- Browser-supplied authorization headers are discarded; only the connector injects the local Codekin bearer token.
- Machine credentials and pairing device codes are stored as SHA-256 hashes; machine deletion revokes the stored credentials.
- Session fixation, cross-site WebSocket hijacking, direct object access to unrelated machines, and browser access to the local bearer token were not identified in the reviewed paths.

## Production observations

On 2026-08-29, unauthenticated checks confirmed:

- `/api/me` returns no authenticated user.
- `/api/machines` returns `401` without a session.
- `/api/auth/github/start` remains public and redirects to GitHub OAuth.
- Its cookie includes `HttpOnly; Secure; SameSite=Lax`.
- The service sends `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, and `Referrer-Policy: same-origin`.

These checks cannot reveal the production value of `ALLOWED_GITHUB_LOGINS`, prove session-secret handling on the host, or safely complete OAuth as a non-allowlisted test identity. The code's default behavior is nevertheless unambiguous: unknown GitHub identities are created as pending accounts.

## Verification limitations

The repository dependencies were not installed in this worktree, so the targeted Vitest suite could not run (`vitest: not found`). The reviewed authorization behavior has existing unit and end-to-end coverage, and the prior 2026-08-08 audit recorded a green relay suite, but this audit does not claim a fresh dynamic authenticated test against production. A controlled staging test should keep a WebSocket open while disabling a test user and revoking a share, then verify that repository/session frames stop immediately once HSA-01 and HSA-02 are remediated.
