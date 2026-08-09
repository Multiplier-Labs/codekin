# Relay Audit — Account Binding & Live Authorization

**Date:** 2026-08-09
**Scope:** `app.codekin.ai` hosted relay (`server/relay/`) — GitHub OAuth sign-in, machine
pairing, session sharing, and the browser/connector relay hubs.
**Objective:** Prove that no account mismatching is possible — that no outside user can gain
access to another user's repositories or machines.
**Base commit:** `9384465` (branched from `main` tip `53ce297`).
**Method:** Code review of the identity-binding and authorization paths, plus the relay test
suite (`server/relay/`, 162 tests) extended with regression tests for each finding.

## Summary

Two account-mismatching defects were found and fixed on branch `fix/relay-id-based-authz`. Both
came down to the relay binding authorization to **mutable** identifiers instead of immutable ones,
or to a **stale snapshot** instead of the live database.

| # | Finding | Severity | Status |
|---|---------|----------|--------|
| 1 | Access policy keyed on GitHub login (reassignable) rather than numeric id | Critical | Fixed |
| 2 | Share grant resolves grantee by login, which can collide after a rename | High | Fixed |
| 3 | Revocation (share removal, unpairing, disable) not applied to open sockets | High | Fixed |

Everything else examined held up: the OAuth `state`/CSRF check, session regeneration on login,
cookie attributes, the per-request DB re-read in `requireActiveUser` and the WS upgrade, pairing
code entropy and single-use claiming, machine credential hashing, and the connector-side policy
re-derivation. Notes on each are in the last section.

---

## 1. Access policy keyed on GitHub login instead of numeric id — Critical

**Was:** `resolveUserAccess()` (`control-plane-db.ts`) compared the authenticating user's GitHub
**login** against `OWNER_GITHUB_LOGIN` / `ALLOWED_GITHUB_LOGINS` (`relay-config.ts`) to grant
`owner` / active-member standing. The `users` table already stored GitHub's immutable numeric
`github_id`, but the policy never used it.

**Why it is a takeover.** GitHub logins are mutable and, once vacated by a rename, are released for
anyone to register. So:

1. A trusted owner or member renames their GitHub account (or deletes it).
2. An attacker registers the freed login.
3. The attacker signs into Codekin. Their distinct `github_id` creates a *new* user row, and
   `resolveUserAccess` matches the configured login → the row is auto-activated, as **owner** if
   the owner login was taken.
4. The attacker can now pair a machine, read the machine list, and — as owner — reach every
   session on the org's machines.

The upsert was also upgrade-only, so the legitimate (renamed) account kept its `owner` role too:
the system could believe in two owners at once.

**Fix.**
- `AccessPolicy` is now `{ ownerGithubId: number; allowedGithubIds: number[] }`; `resolveUserAccess`
  matches on the immutable numeric id and treats `0`/unset as "never matches".
- Config reads `OWNER_GITHUB_ID` (required, numeric) and `ALLOWED_GITHUB_IDS` (comma-separated
  numeric). Boot fails with a migration hint if the old `OWNER_GITHUB_LOGIN` /
  `ALLOWED_GITHUB_LOGINS` keys are present or if any allowlist entry is non-numeric — a
  fail-closed migration, so a half-converted deployment can't silently fall back to login matching.
- `upsertUserFromGithub` now renames any stale row still holding a login that the current holder is
  signing in with (to `formerly-<login>-<id>`), so login lookups elsewhere can't resolve to a
  ghost account.

**Regression tests:** `control-plane-db.test.ts` ("does not activate a different account that
claims the owner login", "clears a stale duplicate login…"); `relay-auth-routes.test.ts` ("does not
grant owner to a different GitHub account that claimed the owner login").

**Operational migration.** Existing deployments must replace the env keys. Look up each id with
`curl -s https://api.github.com/users/<login>` (the `id` field). Any user rows already
auto-activated under the old login policy should be reviewed against the new id allowlist and
disabled if they don't belong. Documented in `docs/OPERATIONS.md`.

## 2. Share grantee resolved by login — High

**Was:** `POST /api/shares` looked up the grantee with `SELECT ... WHERE lower(login) = lower(?)`
and took the single row. After a rename, two rows can transiently share one login (the renamer's
old row and the new holder's), so a grant could land on the wrong account — the same mismatch as
finding 1, reached through sharing.

**Fix.** The lookup now selects all matches; zero → 404, more than one → 409 ("ask the intended
user to sign in again, then retry"), which combined with the finding-1 stale-login rename means the
ambiguity resolves the moment the real user next authenticates. Refusing beats guessing.

**Regression test:** `share-routes.test.ts` ("refuses a grantee login held by more than one
account").

## 3. Revocation not applied to already-open sockets — High

**Was:** `resolveMachineAccess` runs once, at browser-hub `hello`, and the resulting principal
lives for the life of the socket. Revoking a share, unpairing a machine, or disabling a user took
effect only on the *next* connection — an open tab kept working. On the connector side, machine
credentials are checked only at connect, so an unpaired machine's live socket kept serving too.

**Fix.**
- `BrowserHub.reauthorize({ userId?, machineId? })` re-resolves each matching client against the
  live DB and closes any whose access changed (revoked, narrowed, user disabled, machine gone),
  with an `access_denied` audit event. A 60-second sweep also runs so direct-to-DB changes
  propagate.
- `ConnectorHub.disconnectMachine()` force-closes a machine's connector socket with 4001 (the
  connector treats that as terminal and does not retry).
- `DELETE /api/machines/:id` now calls both hubs; `DELETE`/`PATCH /api/shares/:id` call
  `reauthorize` for the affected grantee. Wiring is in `relay-server.ts`.

This is the finding PR #557 deliberately left open pending a product decision; the decision taken
here is that revocation is immediate.

**Regression tests:** `browser-hub.test.ts` (disable-user, machine-removed, and unchanged-access
cases); `connector-hub.test.ts` ("disconnectMachine drops the live socket…"); `pairing-routes.test.ts`
and `share-routes.test.ts` (routes invoke the hubs).

---

## Verified sound (no change needed)

- **OAuth CSRF / `state`.** `state` is 16 random bytes, saved before redirect and compared on
  callback; a missing or mismatched state fails closed (`relay-auth-routes.ts`).
- **Session fixation.** `session.regenerate()` runs after login before the user is written.
- **Cookie attributes.** `httpOnly`, `secure` in production, `sameSite=lax` (needed for the OAuth
  return), signed with `SESSION_SECRET` (≥32 chars enforced at boot).
- **Live status re-read.** `requireActiveUser` and the WS upgrade both re-read the user row per
  request (PR #557); finding 3 extends the same principle to standing socket *authorization*.
- **WS Origin check.** The upgrade rejects any `Origin` other than `PUBLIC_URL`.
- **Token substitution.** The GitHub access token is used once to fetch the profile and discarded;
  identity is the numeric id from that profile, never a client-supplied value.
- **Pairing.** Device code is 32 random bytes (stored only as SHA-256); user code is 8 chars from a
  30-symbol unambiguous alphabet, 10-minute TTL, single-use claim (`claimed` status blocks replay).
  Machine secret is 32 random bytes, returned once, stored hashed, compared in constant time.
- **Connector-side policy.** `connector-policy.ts` re-derives what a grantee may do from the
  per-frame principal, independent of the hub — a compromised or buggy hub still can't approve a
  shell command for a viewer.

## Test / build status

`server/relay` suite: 162 passed. Full `npm test`: 2784 passed. `tsc` (root + `server/`): clean.
`npm run build`: clean. `npm run lint`: 0 errors.
