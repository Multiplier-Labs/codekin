# Hosted access, signup, login, workspaces and 2FA audit

Date: 2026-09-28. Result: **not ready for the requested multi-workspace product**. Existing hosted access is a single-organization, GitHub-allowlisted system with machine ownership and per-session sharing. Workspace creation, workspace memberships, invitations, and an enforced MFA policy are missing. This report and its reproduction script do not change application behavior.

## Scope and evidence

- Codekin checkout: `1493e9dc3486acfcf228cf1686a019973071e4b9`.
- Erwin Analytics current remote main: `6e286ffcdae4257f1e9eef49e306f21c29e46aa5`, fetched for comparison. Its authentication/user/TOTP files are unchanged from the local checkout `090769e84b7489b200b292abd02ebb4e92c5789a`.
- Reviewed hosted relay routes, SQLite schema/session store, browser authorization, connector permission policy, hosted UI, and relevant tests. Local standalone Codekin bearer-token auth is a separate system, not the hosted login mechanism.
- Ran `npm test -- server/relay src/hosted`: **32 files, 363 tests passed**.
- Ran the accompanying [local reproduction script](2026-09-28_hosted-access-repro.mts): all five printed checks passed, confirming six behaviors described below. It uses synthetic users, an in-memory database, loopback HTTP and an in-process browser socket double; it never contacts production or GitHub OAuth.
- No deployed configuration, real accounts, real passkey ceremony, browser UI walkthrough, infrastructure penetration test, or full dependency audit was performed. Passing existing tests does not establish the missing guarantees.

Codekin source references below are paths and line numbers at the audited commit. They can be opened against [that commit](https://github.com/Multiplier-Labs/codekin/tree/1493e9dc3486acfcf228cf1686a019973071e4b9).

## Current behavior and reference comparison

| Capability | Codekin hosted today | Erwin Analytics reference | Required target |
|---|---|---|---|
| Signup | First GitHub login creates an account only for configured numeric GitHub IDs; admitted active accounts remain admitted after allowlist removal | Admin creates email/password accounts, optionally issuing a temporary password | Authenticate identity, then create a workspace or accept a valid invitation |
| Workspaces | Hardcoded `org-default`; one organization and role on each user | Singleton organization settings; subsidiary permissions | Multiple workspaces, membership per user/workspace, workspace switcher |
| Invitations | No invitation record, acceptance route, or email delivery; session shares require an existing active user | Admin-created accounts; no workspace invitation flow found on current main | Expiring, revocable, single-use invitations bound to recipient and workspace |
| Permissions | Global owner/admin/member/viewer plus independent machine ownership and session grants | Admin/standard roles plus subsidiary access | Workspace roles intersected with machine/session grants |
| Login | GitHub OAuth, independent passkey login, or QR/device-link session transfer | Email/password, optionally followed by TOTP/recovery code; trusted-device bypass | Explicit authentication assurance enforced on every entry path |
| 2FA | No TOTP, recovery codes, required-MFA policy, or pending-MFA state | TOTP setup/verification, backup codes and trusted devices | Authenticator-app 2FA and/or verified passkeys, safe recovery, workspace enforcement |
| Admin UI | `/api/users` GET/PATCH exists; no hosted members/invitations management UI found | User administration and 2FA settings | Members, invite/resend/revoke, roles, security settings, ownership transfer |

**Reference correction:** the inspected Erwin repository is useful for user administration and TOTP UX, but it does not implement the workspace/invitation model requested here. Do not claim workspace parity with it. See [Erwin user creation](https://github.com/Multiplier-Labs/Erwin-Analytics/blob/6e286ffcdae4257f1e9eef49e306f21c29e46aa5/apps/api/src/routes/users.ts#L125), [authentication](https://github.com/Multiplier-Labs/Erwin-Analytics/blob/6e286ffcdae4257f1e9eef49e306f21c29e46aa5/apps/api/src/routes/auth.ts), and [singleton organization settings](https://github.com/Multiplier-Labs/Erwin-Analytics/blob/6e286ffcdae4257f1e9eef49e306f21c29e46aa5/packages/db/src/queries/org-settings.ts).

## Findings, ordered by implementation priority

### A1 — High: server-side socket access survives ordinary logout

**Confirmed locally.** `server/relay/relay-auth-routes.ts:228` destroys the HTTP session but does not disconnect its browser sockets. `server/relay/browser-hub.ts:126` periodically rechecks user status and resource grants, not the session that authorized the socket. The browser client record contains no session ID or session expiry. `relay-server.ts:183` checks the session only at upgrade.

An already-connected client can keep issuing machine requests after logout. The reproduction logs out through the real HTTP route, calls hub reauthorization, then successfully forwards another request through the same socket. Normal UI teardown may close a cooperative browser, but it is not server-side revocation. Session expiry has the same architectural gap (source-reviewed, not separately timed).

**Fix:** bind sockets to session IDs and authentication expiry; close the matching session's sockets at logout. Revalidate session validity as well as membership on active sockets. Stop dispatch immediately once revoked; do not rely solely on WebSocket close-handshake completion. Retain user-wide disconnect for logout-all. Add logout/expiry tests with existing sockets and channels.

### A2 — High: pending device-login links survive logout-all

**Confirmed locally.** `relay-auth-routes.ts:237` deletes stored sessions and disconnects the user, but leaves `device_link_requests` intact. `device-link-routes.ts:54` accepts an outstanding code and grants a full fresh session if the user remains active. Codes expire after three minutes (`device-link.ts:20`).

A code created before “log out all devices” still logs a device in afterward. This matters when logout-all is used after a suspected compromise. Temporary account disabling prevents redemption while disabled, but re-enabling within the code lifetime also needs a defined revocation policy.

**Fix:** revoke pending login-transfer codes on logout-all/security reset/account disable. Bind transfer requests to the originating session and an account authentication version. Require recent authentication to create them, and do not let them bypass future MFA policy. Test concurrent redemption versus revocation transactionally.

### A3 — Launch blocker: organization columns do not provide tenant isolation

**Confirmed with a synthetic second organization; not a claim of an existing production cross-tenant incident.** `control-plane-db.ts:44` hardcodes the organization. User roles are global and there is no memberships table. `user-routes.ts:82` changes a target fetched by ID without an organization check. `share-routes.ts:99` resolves grantees globally by login. `shares.ts:151` always writes the default organization, and `resolveMachineAccess` checks owner/grants without organization membership.

The reproduction shows a default-organization owner changing another organization's user, and a session share granting access across organization IDs. No public workspace creation exists today, so these are blockers for introducing multiple tenants, not an anonymous exploit of the single-org UI.

**Fix:** add explicit memberships and central workspace authorization first. Scope admin operations, machine registration, shares, audit queries, REST and WebSocket authorization to current active membership. Changing `DEFAULT_ORG_ID` or adding a workspace selector alone is insufficient.

### A4 — Launch blocker: passkeys exist, but MFA is not enforced across login paths

**Source-confirmed gap.** OAuth (`relay-auth-routes.ts:222`), passkey login (`webauthn-routes.ts:216`) and device linking (`device-link-routes.ts:85`) all directly set `req.session.user`. There is no authentication-method/assurance marker, second-factor requirement, pending-MFA state, or workspace security policy in the schema or guards.

Passkeys already request user verification; the installed SimpleWebAuthn verifier defaults also enforce it. A verified passkey can satisfy a deliberately designed MFA policy. The gap is that GitHub OAuth and transferable device links can still establish the same full session without Codekin enforcing that policy. This code does not inspect evidence of GitHub MFA; having GitHub 2FA on an account is not an application-level enforcement mechanism.

**Fix:** centralize completion of all login paths and enforce the state machine specified below at HTTP guards and WebSocket upgrades. Do not implement a TOTP screen while leaving either alternate login path unrestricted.

### A5 — Medium: a global viewer is not read-only

**Confirmed locally; product semantics need to be made explicit.** `pairing-routes.ts:100` and `:191` require an active account but not a role. A viewer can pair a machine; `shares.ts` treats its owner as unrestricted regardless of global viewer role. A viewer can also receive an editor share because sharing does not cap grants by global role. Actual per-session viewer grants are separately enforced by the connector.

This does not give a viewer another person's unshared machine. It does mean that assigning “viewer” is not a workspace-wide read-only restriction, and role demotion need not change current machine access.

**Fix:** define the workspace role matrix and intersect it with resource grants. Decide explicitly whether viewers may register machines; recommendation: no. Demotion must immediately narrow existing socket/channel rights.

### A6 — Medium: malformed share expiry fails open

**Confirmed locally.** `share-routes.ts:137` and `:180` accept arbitrary expiry strings. `shares.ts:211` compares `new Date(value).getTime()` with the current time; invalid dates produce `NaN`, so the comparison never expires the grant. A grant created with `expiresAt: 'not-a-date'` remains usable even with the test clock set to 2100.

**Fix:** validate expiry as a finite timestamp at creation/update, normalize it, reject invalid/past expiries, and fail closed on malformed stored data. Test both HTTP routes and access resolution.

### A7 — Medium hardening: long-lived sessions can enroll durable credentials without fresh proof

**Source-reviewed.** `webauthn-routes.ts:65` and `:233` require only an active session to add/delete passkeys; device-link creation has the same gate. Sessions roll for 30 days (`relay-server.ts:94`) without an absolute authentication-age limit. WebAuthn challenges have no explicit server-side ceremony expiry beyond session lifetime.

Possession of a stolen still-valid session can therefore be extended into a durable passkey credential. Registering a new passkey proves control of the new authenticator, not ownership of the original account.

**Fix:** recent reauthentication for credential enrollment/removal, recovery-code regeneration and MFA disable; short-lived single-use challenges with server-enforced expiry and atomic consumption; authentication timestamps and an absolute session lifetime. Notify/audit credential changes. Audit login success/failure and logout too; OAuth currently has no corresponding audit writes.

### A8 — Medium hardening: REST lacks explicit CSRF checks

**Source-reviewed; no browser exploit asserted.** `relay-server.ts` checks exact Origin for WebSockets, but has no equivalent CSRF token/Origin enforcement on cookie-authenticated REST mutations. SameSite=Lax and JSON parsing provide useful protection, but some mutations need no body, and same-site sibling origins are a separate boundary.

**Fix:** enforce trusted Origin/CSRF protection for cookie-authenticated mutations, including logout, credential/device operations and the new workspace/invitation endpoints. Keep OAuth callback state validation and narrowly handle machine-to-machine endpoints that intentionally have no browser Origin. Validate cross-origin and sibling-origin browser cases.

### Smaller correctness and future-invitation issues

- `/api/me` returns the session snapshot (`relay-auth-routes.ts:257`) without refreshing DB state. Guarded APIs do refresh. Role/status UI can be stale after changes; this is not an authorization bypass in guarded routes.
- Removing an ID from `ALLOWED_GITHUB_IDS` is not revocation: existing active accounts are intentionally grandfathered. Use explicit disable today; replace the ambiguous model with membership lifecycle management.
- Non-allowlisted new logins create no pending account, so the existing “administrator must approve” screen is not a complete access-request workflow. Disabled users see the same pending copy.
- GitHub email collection does not check the `verified` field (`relay-auth-routes.ts:178`). It is profile metadata today, not an access-control key. **Never reuse this value for email-bound invitation acceptance without verified ownership.**
- Shared users receive machine-wide total/active session counts (`machine-routes.ts:49`), despite session-specific access. These are counts, not session titles/content. Decide whether to omit or filter them.

## Controls worth preserving

- Admission uses immutable numeric GitHub identity; OAuth state and return-path validation are present, and successful authentication regenerates session IDs.
- Session cookies are HttpOnly/SameSite=Lax and Secure in production configuration; sessions are stored server-side. Production configuration itself was not inspected.
- Active-user guards reread account status from the DB. Disable destroys stored sessions; share changes and account changes trigger resource reauthorization, with periodic checks as a fallback.
- Device-link tokens are high entropy, stored hashed, expire after three minutes and are atomically single-use.
- Passkeys verify origin/RP/challenge and signatures; credentials are scoped to their user.
- Machine ownership is separate from administrative rank; organization admin status does not automatically grant machine execution access. Preserve this boundary.
- Connector enforcement restricts shared-session actions and filters session lists. Existing access-control tests cover many of these boundaries.

## Proposed workspace and invitation design

This is a proposed target, not existing Erwin functionality.

### Data model and authorization

- `users`: global identity and account security status; separate provider identities keyed by `(provider, provider_subject)` if more providers are added.
- `workspaces`: ID, name, lifecycle state and MFA policy.
- `workspace_memberships`: unique `(workspace_id, user_id)`, role, status and membership timestamps. Keep account suspension separate from leaving/removal in one workspace.
- `workspace_invitations`: workspace, verified recipient email or immutable provider identity, allowed role, token hash, inviter, expiry, accepted/revoked timestamps. Never store raw invitation tokens.
- Machines belong to exactly one workspace plus an owner. Shares must belong to that workspace and reference active memberships. Audit records use the actual workspace rather than a default.
- Central guards resolve `account + authentication assurance + active membership + resource grant` on every request. Selecting a workspace is UI state, never evidence of permission. Scope machine pairing credentials and browser principals to the resolved workspace.

| Action | Owner | Admin | Member | Viewer |
|---|---|---|---|---|
| Edit workspace/security policy | Yes | Limited, no lowering mandatory MFA | No | No |
| Invite/remove member or viewer | Yes | Yes | No | No |
| Assign admin, transfer ownership, delete workspace | Yes, with recent MFA | No | No | No |
| Register own machine | Yes | Yes | Yes | No |
| Access machine/session | Ownership or explicit grant | Ownership or explicit grant | Ownership or explicit grant | Explicit read-only grant |
| Grant shell/mutating execution | Machine owner, explicit grant | Same | Same | No |

Protect the last owner transactionally. On member removal, close workspace sockets and revoke applicable shares/pairing requests. Define machine disposition: recommended first release quarantines the removed member's machines until an explicit authorized transfer or removal. Removing someone from one workspace must not globally disable them.

### Signup and invitation flow

1. Keep GitHub as the initial identity provider; do not introduce passwords solely to copy Erwin. Successful authentication may create an identity with no workspace access.
2. An authenticated new user creates a workspace (subject to rollout/abuse controls) and atomically becomes its owner, or accepts an invitation into an existing workspace.
3. Owners/admins invite a recipient with a permitted role. Generate an opaque random token, store only its hash, set a proposed seven-day expiry, and provide resend/revoke controls. Resend invalidates the old token. Email delivery is a separate configured dependency; do not claim delivery without it.
4. Opening a link displays context; acceptance requires authentication as the bound recipient, verified email/provider identity and any required MFA enrollment. Never switch accounts silently or accept on a GET request.
5. Consume the invitation and insert membership in one transaction. Handle already-members idempotently; reject expired/revoked/wrong-recipient tokens. Recheck inviter authority/workspace state and cancel their outstanding invites when appropriate.
6. Add workspace switcher, workspace creation, members/roles, invitations, security settings and clear no-workspace/removed/disabled states. Extend the existing narrow `returnTo` allowlist deliberately for invitation continuation.

## 2FA implementation contract

Use Erwin's enrollment, challenge and recovery UX as a reference, but do not copy its implementation blindly. In particular, [its enable route](https://github.com/Multiplier-Labs/Erwin-Analytics/blob/6e286ffcdae4257f1e9eef49e306f21c29e46aa5/apps/api/src/routes/totp.ts#L175) passes the decrypted TOTP secret into [a direct text-column update](https://github.com/Multiplier-Labs/Erwin-Analytics/blob/6e286ffcdae4257f1e9eef49e306f21c29e46aa5/packages/db/src/queries/totp.ts#L37); encrypted pending setup does not by itself encrypt the enrolled secret. Its verifier also does not track consumed TOTP time steps. These are reuse cautions, not a full Erwin security audit.

Proposed session states:

```text
anonymous -> primary identity verified -> MFA pending/enrollment required
                                      -> fully authenticated -> workspace authorized
verified passkey ---------------------> fully authenticated (UV verified)
device-link redemption --------------> policy check; MFA pending when required
```

- GitHub OAuth must create only a restricted pending state when the account requires MFA. A pending session cannot list machines, manage users, create links/passkeys, accept privileged invites or open relay sockets.
- Preserve passkeys as a phishing-resistant sign-in option. Explicitly verify user verification and record method/time; allow them to satisfy MFA only under the documented policy. OAuth-only recovery and QR transfer must not silently downgrade assurance.
- Add authenticator-app TOTP enrollment with a pending secret and confirmation before enablement. Encrypt enrolled and pending secrets using authenticated encryption and a separately managed, versioned key. Never expose secret/QR data after enrollment.
- Short-lived challenges, per-account and per-IP throttling, a bounded attempt count, atomic challenge consumption, and rejection of already-consumed TOTP steps. Persist pending state so restart does not create inconsistent policy.
- Recovery codes: sufficiently random, hashed, displayed once, individually and atomically consumed. Regeneration invalidates all old codes. Require recent strong authentication for disable/reset/regeneration; prevent disabling the last acceptable factor when workspace policy requires MFA.
- Account/session authentication versions invalidate old sessions and pending credentials after security changes. Store `authenticatedAt`, method and `mfaVerifiedAt`; enforce recent authentication for sensitive actions.
- Initially avoid a separate “trust this device” MFA-bypass token. Existing session persistence can supply convenience while absolute expiry and sensitive-action reauthentication bound it.
- Require MFA for owners/admins at rollout; support workspace-required MFA for everyone. Enrollment-required users get only the setup/recovery/logout surface until compliant. Prevent removal of the last workspace owner during recovery.
- Recovery/admin reset must be audited and independently verified; a workspace admin must not gain the ability to take over a user's global identity across other workspaces.

Reauthentication for factor changes, safe recovery and avoiding weaker alternate paths align with [OWASP MFA guidance](https://cheatsheetseries.owasp.org/cheatsheets/Multifactor_Authentication_Cheat_Sheet.html). Absolute expiry and server-side revocation align with [OWASP session guidance](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html). Explicit CSRF checks supplement SameSite cookies as described in [OWASP CSRF guidance](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html). The specific policy and schema above are recommendations for Codekin.

## Implementation sequence and release gates

1. **Close current defects:** A1/A2/A6; recent-auth security operations; REST CSRF handling; fresh `/api/me`; audit authentication events. Add desired-behavior regression tests, not assertions that preserve the vulnerabilities.
2. **Build tenant boundary:** versioned SQLite migrations, workspaces/memberships, central guards, workspace-scoped machines/shares/audit/pairing and socket principals. Backfill `org-default` and existing roles/statuses; keep existing machine ownership intact. Replace the deployment-wide owner configuration with bootstrap-only behavior.
3. **Ship workspace onboarding/invitations:** create/switch workspace, member administration, delivery integration and recipient-bound transactional acceptance. Keep public signup gated until isolation tests pass.
4. **Ship enforced MFA:** central login state machine, passkey assurance, TOTP/recovery, enrollment/challenge/settings UI, restricted setup access, security-event invalidation and migration of existing sessions. Build this before enabling general hosted signup.
5. **Stage the complete flow:** two independent workspaces and a user in both; invitation onboarding; MFA enrollment/login/recovery; machine pairing and session sharing; membership removal and role demotion during a live stream.

Required negative tests: every REST resource and WebSocket machine/session ID from workspace A rejected in B; pending-MFA sessions denied all normal APIs and socket upgrades; wrong-recipient/expired/revoked/replayed invites; concurrent invitation/recovery/TOTP consumption; viewer cannot execute despite an editor grant; last-owner protection; revoked/expired sessions and preexisting device links cannot restore access; account suspension affects all workspaces while membership removal affects only its workspace.

Migration release gate: backup/restore rehearsal, schema version tracking, existing membership/ownership counts verified, and old sessions deliberately expired or upgraded through reauthentication. Do not deploy old single-org code against newly created multi-workspace data as a rollback strategy. No migration or deployment was performed by this audit.

## Reproduce the confirmed behaviors

From the repository root with existing server dependencies installed:

```bash
server/node_modules/.bin/tsx .codekin/reports/security/2026-09-28_hosted-access-repro.mts
```

The script intentionally asserts current insecure/incomplete behavior. After fixes, its assertions should fail; replace them with desired-behavior regression tests in the normal suite. It is an audit artifact, not a CI acceptance test.