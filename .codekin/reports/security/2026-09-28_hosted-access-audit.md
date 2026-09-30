# Hosted Access Audit — Signup, Login, Roles, Workspaces, 2FA

**Date:** 2026-09-28
**Scope:** Hosted webapp (app.codekin.ai): `server/relay/*`, `src/hosted/*`, `docs/HOSTED-RELAY-CONTROL-PLANE-SPEC.md`, `docs/DEVICE-LINK-AND-PASSKEY-SPEC.md`
**Reference:** Erwin-Analytics @ `090769e`
**Goal:** Workspaces with invitations (modelled on Erwin Analytics) plus two-factor authentication.
**Reproduction:** `2026-09-28_hosted-access-repro.mts` (same directory). It runs the real routers on an in-memory DB with synthetic users, and all five `CONFIRMED` findings below reproduce.

---

## 1. Summary

| Area | Current state | Verdict |
|---|---|---|
| Signup | GitHub OAuth only. Admission comes from the env allowlist (`OWNER_GITHUB_ID`, `ALLOWED_GITHUB_IDS`), so adding a user means a restart | Not self-serve |
| Login | GitHub OAuth, or a passkey (primary, usernameless), or a device link | Solid |
| Sessions | express-session in SQLite, 30-day rolling, `regenerate()` on login | Missing an absolute cap and a CSRF check |
| Tenancy | One hardcoded org (`org-default`), `users.organization_id` as a single FK | **Nominal only** |
| Roles | `owner/admin/member/viewer` on the user row. Only enforced in `user-routes.ts` | Mostly decorative |
| Invitations | None | Missing |
| 2FA | None. Passkeys are a login *alternative*, not a second factor. There is no step-up anywhere | Missing |
| Audit | Covers machines, shares, device links and passkeys. Logins and logouts are not recorded | Partial |

**About the reference:** Erwin Analytics has **no workspaces, memberships or invitations** in any clone or branch (its "tenant" code is the Xero org picker). It is a single-tenant app with `admin | standard` roles and admin-created accounts. So Erwin serves as the model for **2FA, recovery codes, trusted devices, lockout and CSRF**. The workspace and invitation design in §5 is new; it borrows no Erwin code.

---

## 2. Current system

### 2.1 Identity and signup
- Signup uses a hand-rolled GitHub OAuth flow (`relay-auth-routes.ts:103-225`). It requests the scopes `read:user user:email`, uses a 16-byte `state` stored in the session, and discards the GitHub token after use.
- `resolveUserAccess` (`control-plane-db.ts:198-206`) decides admission. The owner ID becomes `owner`, allowlisted IDs become `member`, and everyone else is rejected with `access_not_allowed` before any row is written (`relay-auth-routes.ts:199-213`).
- There is no request-and-approve flow. The `pending` screen in `src/hosted/HostedApp.tsx` is effectively unreachable.
- An admin cannot admit a brand-new user. `PATCH /api/users/:id` needs an existing row, and a row only exists once the user is already allowlisted.

### 2.2 Login and sessions
- The session cookie is `codekin_relay_sid`: `httpOnly`, `sameSite=lax`, and `secure` only when `NODE_ENV=production`. It lasts 30 days and rolls forward, with no absolute cap (`relay-server.ts:86-101`).
- On every request, `requireActiveUser` re-reads role and status from the DB (`relay-auth-routes.ts:273-295`).
- Passkeys (`webauthn-routes.ts`) are discoverable, require `userVerification: 'required'`, and serve as the primary login.
- Device link (`device-link.ts`, `device-link-routes.ts`) uses a 256-bit code in the URL fragment. The code expires after 3 minutes, can be used once, and is stored only as a SHA-256 hash.
- Rate limits are per IP and kept in memory: `/api/auth/*` 20/min, `pair/start` 10/min, `pair/complete` 60/min. There are no limits on `/api/shares`, `/api/users`, `pair/info` or `pair/approve`.
- CSRF protection relies on SameSite=Lax plus JSON bodies. REST routes do not check `Origin`, although the WebSocket upgrade does (`relay-server.ts:181-197`).

### 2.3 Authorization
- The schema (`control-plane-db.ts:47-158`) has `organizations`, `users(organization_id, role, status)`, `machines(owner_user_id)`, `session_shares`, `webauthn_credentials`, `device_link_requests` and `audit_events`.
- Access is scoped **per user**, not per org. A machine belongs to its `owner_user_id`, and other users reach it only through per-session shares (8 fine-grained permissions, with `viewer` and `editor` presets). Shares are enforced twice: in the relay hub and in the connector (`connector-policy.ts`).
- `DEFAULT_ORG_ID` is hardcoded on insert. Lookups such as `getMachine`, share resolution, grantee lookup by login and `PATCH /api/users` **do not filter by organization**.

---

## 3. Findings

Severity reflects the current single-tenant deployment. Findings marked **⚑** become High the moment a second workspace exists.

### H1 — Tenancy is nominal ⚑ `CONFIRMED`
There is one hardcoded org, one org per user (`users.organization_id` plus a globally unique `github_id`), and a global role. The repro creates a second org and shows two leaks:
- an owner in `org-default` can **share a session with a user in another org** (`share-routes.ts:99-101` looks up grantees by login without an org filter);
- an owner in `org-default` can **disable a user in another org** (`user-routes.ts`).

**Fix:** a `workspace_memberships` table, plus a workspace filter on every query that loads machines, shares, users or audit events (§5).

### H2 — No step-up authentication before persistence-granting actions
Anyone holding a session cookie can register a passkey (`webauthn-routes.ts:65-149`) or mint a device link (`device-link-routes.ts:26-39`). Both grant access that outlives the session. `logout-all` does not delete passkeys, and the user gets no notification when a passkey or device is added. A stolen cookie therefore turns into permanent access.

**Fix:** require a fresh second factor (under 10 minutes old) before these actions, and before disabling 2FA or changing workspace ownership (§6.4).

### H3 — Plain logout leaves live WebSockets forwarding `CONFIRMED`
`POST /api/auth/logout` destroys the HTTP session, but it never calls `disconnectUser`. `BrowserHub.reauthorize()` re-checks user *status*, not session validity. So after logout, an already-open socket keeps forwarding requests to the connector.

**Fix:** bind each socket to its session ID. On logout or session destroy, close the sockets for that session. During reauthorization, check that the session still exists in the store.

### M1 — `logout-all` does not revoke pending device links `CONFIRMED`
If a device link was minted before `logout-all` and not yet claimed, it still produces a new authenticated session afterwards. The TTL limits the window to 3 minutes, but "log out everywhere" should mean exactly that.

**Fix:** `logout-all` and account disable should expire the user's `pending` rows in `device_link_requests`.

### M2 — Invalid share expiry never expires `CONFIRMED`
`expiresAt` is stored as any string (`share-routes.ts:137,180`). For an invalid date, `isShareExpired` evaluates `NaN <= now`, which is always `false` (`shares.ts:212`), so a share created with `expiresAt: "not-a-date"` stays valid in the year 2100.

**Fix:** validate `expiresAt` as ISO-8601 in the future, reject anything else with 400, and in `isShareExpired` treat an unparseable stored value as already expired.

### M3 — `viewer` and `admin` roles are not enforced outside user management `CONFIRMED`
A global `viewer` can pair a machine and get full owner-level access to it. An `admin` has no oversight: no view of other users' machines, and no audit view for the org.

**Fix:** a per-workspace capability matrix (§5.3).

### M4 — Admission requires editing env files and restarting
There is no invitation primitive. `ALLOWED_GITHUB_IDS` is the only way in.

**Fix:** invitations (§5.4). Keep the allowlist as a bootstrap and break-glass mechanism.

### M5 — CSRF protection is SameSite only
Any subdomain of `codekin.ai` counts as same-site. State-changing REST routes do not check `Origin`, and the unauthenticated `POST /api/auth/logout` can be triggered cross-site.

**Fix:** reject `POST/PATCH/DELETE` requests whose `Origin` is not `publicUrl` (the WebSocket upgrade already has this check), or adopt Erwin's `x-csrf-token` pattern.

### M6 — Sessions: no absolute lifetime, `secure` tied to `NODE_ENV`, O(n) revocation
- Sessions roll for 30 days with no absolute or idle cap.
- The `secure` flag depends on `NODE_ENV` rather than on whether `publicUrl` uses https.
- `destroyUserSessions` JSON-parses every session row (`sqlite-session-store.ts:55-73`).

**Fix:** add a `user_id` column to `web_sessions`, an absolute lifetime of 30 days with a 7-day idle timeout, and derive `secure` from `publicUrl`.

### M7 — Rate limits are missing on authenticated mutation routes
`pair/approve`, `pair/info`, `/api/shares` and `/api/users` have no limit. The in-memory limiter resets on restart.

**Fix:** a per-user limiter on mutation routes, and a dedicated strict limiter on 2FA verification (§6).

### L1 — Audit gaps
None of these are recorded: OAuth login success or failure, `access_not_allowed`, logout, `logout-all`, pairing deny, or passkey login failure. There is no audit view for org or workspace admins.

### L2 — Passkey login leaks account status
Account status is checked before the assertion is verified (`webauthn-routes.ts:176-185`). As a result, anyone holding a credential ID can tell a disabled account (403) from an invalid assertion (401).

### L3 — Grantees are resolved by mutable GitHub login
Shares resolve grantees by login and return a 409 on collision. They should use user IDs, selected from the workspace member list.

---

## 4. What to take from Erwin Analytics

| Erwin mechanism | Copy? | Notes for Codekin |
|---|---|---|
| TOTP enrollment staging (`pending_totp_setups`, 10-min TTL, confirm with a code before enabling) | **Yes** | Store the secret encrypted, both while staged and after enabling. Erwin stores the enabled secret in plaintext. |
| 10 single-use recovery codes, SHA-256 hashed, `XXXX-XXXX-XXXX` | **Yes** | Consume atomically: one row per code with `used_at`, using `UPDATE … WHERE used_at IS NULL`. Erwin splices an array, which races. |
| Partial login after the first factor (`pendingToken`, 5-min TTL, 3 per user) | **Yes, moved into the DB** | Erwin keeps this in memory, which breaks across processes and restarts. Codekin can store it in the session as `pending2fa`, not yet authenticated. |
| Trusted-device cookie (14 days, hashed, list and revoke UI) | **Optional** | Useful given frequent GitHub re-login. Revoke on 2FA disable, `logout-all` and account disable. |
| Account lockout (10 failures → 15 min) | **Adapt** | No passwords, so apply it to failed 2FA verifications: 5 per 15 min per user, then lock the challenge. |
| `x-csrf-token` protection with auth entry points exempt | **Adapt** | An Origin check is simpler here (M5). |
| Session-secret entropy check at startup | **Yes** | Small hardening of `relay-config.ts`. |
| TOTP replay | **Do better** | Store `last_used_step`, and reject a step equal to or earlier than it. |
| Disable 2FA with a TOTP code only | **Do better** | Require step-up (§6.4). Owners and admins cannot disable it while their workspace requires 2FA. |
| "Require 2FA" policy | **Do better** | Erwin only nags. Codekin should enforce it per workspace (§6.3). |
| Admin-created accounts with temporary passwords | **No** | Replaced by invitations plus GitHub OAuth. |
| `admin | standard` roles | **No** | Too coarse. See §5.3. |

---

## 5. Target design: workspaces and invitations

### 5.1 Data model

```sql
-- rename organizations → workspaces (keep id 'org-default' as the migrated workspace)
CREATE TABLE workspaces (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, slug TEXT UNIQUE NOT NULL,
  require_2fa INTEGER NOT NULL DEFAULT 0,
  created_by_user_id TEXT REFERENCES users(id),
  created_at TEXT NOT NULL, deleted_at TEXT
);

CREATE TABLE workspace_memberships (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  user_id      TEXT NOT NULL REFERENCES users(id),
  role   TEXT NOT NULL CHECK (role IN ('owner','admin','member','viewer')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended')),
  invited_by_user_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, user_id)
);

CREATE TABLE workspace_invitations (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  role TEXT NOT NULL CHECK (role IN ('admin','member','viewer')),
  invitee_email TEXT,            -- optional binding (match against verified GitHub emails)
  invitee_github_login TEXT,     -- optional binding (resolved to github_id on accept)
  token_hash TEXT UNIQUE NOT NULL,      -- sha256 of 32 random bytes
  invited_by_user_id TEXT NOT NULL,
  created_at TEXT NOT NULL, expires_at TEXT NOT NULL,   -- default 7 days
  accepted_at TEXT, accepted_by_user_id TEXT, revoked_at TEXT
);

-- machines, session_shares, audit_events: organization_id → workspace_id (NOT NULL, indexed)
```

- `users.role` and `users.organization_id` are retired. `users.status` stays as a **platform-level** flag, so the platform owner can still disable an account everywhere.
- Migration: the existing single org becomes a workspace. Each user's current `role` becomes a membership row, and `OWNER_GITHUB_ID` becomes that workspace's `owner`.

### 5.2 Workspace resolution per request
- The session stores `currentWorkspaceId`, which is validated against `workspace_memberships` on every request by the successor of `requireActiveUser`.
- The client also sends `X-Codekin-Workspace` on REST and in the WebSocket `hello` message. A mismatch or a missing membership returns 403.
- Every data-access helper takes `workspaceId` as a **required** parameter: `getMachine`, `listMachinesForUser`, `resolveMachineAccess`, share CRUD, grantee lookup, `listUsers` and audit reads. This closes H1 at compile time, not by convention.
- `BrowserHub` re-authorization also checks that the membership is still active. Removing a member disconnects their sockets in that workspace.

### 5.3 Capability matrix

| Capability | owner | admin | member | viewer |
|---|---|---|---|---|
| Open sessions shared with them (per share permissions) | ✓ | ✓ | ✓ | ✓ (share presets capped at `viewer`) |
| Pair a machine into the workspace | ✓ | ✓ | ✓ | ✗ |
| Share their own machine's sessions | ✓ | ✓ | ✓ | ✗ |
| Grant `approve_mutating_tool` / `approve_shell` | ✓ | ✓ | ✓ (own machines) | ✗ |
| See every machine in the workspace (metadata only) | ✓ | ✓ | ✗ | ✗ |
| Remove any machine / revoke any share | ✓ | ✓ | own only | ✗ |
| Invite: member/viewer | ✓ | ✓ | ✗ | ✗ |
| Invite or promote: admin | ✓ | ✗ | ✗ | ✗ |
| Suspend or remove members | ✓ | ✓ (not admins/owners) | ✗ | ✗ |
| Workspace audit log | ✓ | ✓ | own events | own events |
| Rename workspace, set `require_2fa` | ✓ | ✗ | ✗ | ✗ |
| Transfer ownership, delete workspace | ✓ (step-up) | ✗ | ✗ | ✗ |
| Leave the workspace | ✓ unless last owner | ✓ | ✓ | ✓ |

- Admins get *metadata* oversight of machines, not the ability to drive sessions on machines they don't own. That remains a share, so the connector keeps its current trust model.
- **Last-owner protection:** every demotion, removal, leave or suspend is rejected if it would leave the workspace with no active owner. Erwin has no such guard.
- Enforce the matrix through one helper, `can(membership, action)`, rather than inline role checks.

### 5.4 Invitation flow
1. **Create:** `POST /api/workspaces/:id/invitations {role, email?, githubLogin?}`. The server generates a 32-byte token, stores only its SHA-256 hash, and returns the link `https://app.codekin.ai/invite#<token>` **once**. The token travels in the fragment, like the device link, so it stays out of server logs and `Referer` headers. There is no email sending yet: the inviter copies the link, and email can be added later behind the same endpoint.
2. **Inspect:** `POST /api/invitations/lookup {token}`, with no authentication and a strict rate limit. It returns the workspace name, inviter and role only, so the landing page can say "Alice invited you to Acme as a member".
3. **Accept:** the invitee signs in with GitHub. The pending invite token is kept in the session across the OAuth round-trip, using the existing return-to mechanism extended to `/invite`.
   - A **valid invitation overrides the env allowlist.** This is the only new way into the platform.
   - If `invitee_email` is set, it must match one of the user's **verified** GitHub emails, fetched from `/user/emails` with the existing `user:email` scope. If `invitee_github_login` is set, it must match.
   - Acceptance runs in one transaction, `UPDATE … WHERE accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now`, so each invitation is used once.
   - If the workspace has `require_2fa` set, the user goes straight into 2FA enrollment before reaching the workspace (§6.3).
4. **Manage:** list pending invitations, revoke (sets `revoked_at`), and resend (revokes and re-issues a new token, since tokens are never stored in plaintext).
5. **Audit:** `invitation_created`, `_revoked`, `_accepted` and `_rejected` (with the reason: expired, email mismatch, reused).

### 5.5 Signup policy (product decision needed)
- **Option A, invite-only (recommended at first):** new users arrive only through invitations or the env allowlist. Workspace creation is limited to the platform owner and users they flag.
- **Option B, open signup:** any GitHub user can sign in and gets a personal workspace. This needs abuse controls (connector and relay quotas per workspace) before launch.

Whichever option is chosen, keep the env allowlist as the bootstrap and break-glass path.

---

## 6. Target design: two-factor authentication

### 6.1 Factors
Codekin has no passwords, so the **first factor is GitHub OAuth**. The second factor can be:
- **TOTP** (RFC 6238, 6 digits, 30-second step, ±1 step window). Use `otpauth` or keep Erwin's small `node:crypto` implementation, and add replay protection.
- **Passkey:** a passkey login with `userVerification: 'required'` already combines possession and inherence, so it **satisfies 2FA on its own**. After GitHub OAuth, a user with a passkey can also use it as the second step.
- **Recovery codes:** 10 codes, single use, hashed.

### 6.2 Data model

```sql
CREATE TABLE user_totp (
  user_id TEXT PRIMARY KEY REFERENCES users(id),
  secret_enc BLOB NOT NULL,       -- AES-256-GCM, key from TOTP_ENCRYPTION_KEY (separate from SESSION_SECRET)
  confirmed_at TEXT,              -- NULL while enrollment is pending (TTL 10 min)
  last_used_step INTEGER,         -- replay protection
  created_at TEXT NOT NULL
);
CREATE TABLE user_recovery_codes (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),
  code_hash TEXT NOT NULL, used_at TEXT, created_at TEXT NOT NULL
);
-- users: add mfa_enabled_at TEXT
-- session: { user, authLevel: 'partial' | 'full', mfaAt?: epoch_ms }
```

### 6.3 Login and enforcement
- **After GitHub OAuth, when 2FA is enrolled:** `regenerate()` the session with `authLevel: 'partial'` and redirect to `/auth/2fa`. A partial session can call only `/api/auth/2fa/*`, `/api/auth/me` and logout. `requireActiveUser` and the WebSocket upgrade reject it.
- **Verifying:** `POST /api/auth/2fa/verify {code}` (TOTP or recovery code) or the passkey assertion endpoints. On success, `regenerate()` again with `authLevel: 'full'` and `mfaAt: now`.
- **Limits:** 5 verification attempts per 15 minutes per user and per IP. Partial sessions expire after 10 minutes.
- **Passkey login alone** yields `authLevel: 'full'` directly.
- **Device link** inherits the creator's `authLevel` (a device link can only be minted from a full session) and records `mfaAt` for the new session as the creator's `mfaAt`.
- **Workspace `require_2fa`:** a member with no second factor who tries to enter that workspace is redirected to enrollment. The endpoint returns 403 with `mfa_enrollment_required`, and the WebSocket `hello` fails the same way. Enabling the policy is refused unless the owner has 2FA. The members page shows who is not yet compliant.

### 6.4 Step-up
The following actions require `now - mfaAt < 10 min`. If that fails, they return 401 with `step_up_required` and the client re-prompts for TOTP or a passkey:
- registering or removing a passkey, and minting a device link (closes H2)
- disabling TOTP and regenerating recovery codes
- transferring ownership, deleting a workspace, turning `require_2fa` off, and inviting an admin

Users without a second factor **cannot** do these things in a workspace that requires 2FA. Elsewhere they fall back to a fresh GitHub OAuth, with `authAt` newer than 10 minutes.

### 6.5 Enrollment and recovery
- **Enroll:** `POST /api/auth/2fa/totp/setup` returns an `otpauth://` URI and QR code, and writes an unconfirmed `user_totp` row. `POST /api/auth/2fa/totp/confirm {code}` sets `confirmed_at`, generates the 10 recovery codes and shows them **once**. This differs from Erwin, which shows the codes before confirmation.
- **Recovery code use:** consumed atomically. The user is warned when three or fewer remain.
- **Lost all factors:** a workspace owner cannot reset another user's 2FA, because users are platform-wide and one workspace must not weaken another's security. Only the **platform owner** can reset it, through a CLI (`codekin-relay reset-2fa <github-id>`). The reset is audited and every session for that user is destroyed.
- **Notifications:** show a banner in the app on the next login after a passkey, TOTP change, device link or recovery-code use, until transactional email exists.

---

## 7. Implementation plan

| Phase | Content | Closes |
|---|---|---|
| **0: hardening, before any schema change** | Close sockets on logout and bind them to sessions; revoke pending device links on `logout-all` and disable; validate share expiry; Origin check on REST mutations; derive `secure` from `publicUrl`; absolute and idle session caps; `user_id` column on `web_sessions`; audit login and logout; passkey status check after verification; per-user limiter on mutation routes | H3, M1, M2, M5, M6, M7, L1, L2 |
| **1: workspaces** | Migrate `organizations` → `workspaces` and add `workspace_memberships`; required `workspaceId` on all data helpers; the `can()` capability helper; workspace switcher; members page; last-owner protection | H1, M3, L3 |
| **2: invitations** | Invitations table, routes and landing page; invitations bypass the allowlist; verified-email binding; audit events | M4 |
| **3: 2FA** | TOTP, recovery codes, `authLevel: partial/full`, passkey as second factor, step-up, `require_2fa` per workspace, platform-owner reset CLI | H2 |
| **4: optional** | Transactional email (invites, security notifications); trusted-device cookie; open signup with quotas | — |

Phase 0 is independent of the rest and fixes everything reproducible today, so it should ship first. Phases 1–3 each need a spec in `docs/` before implementation (update `HOSTED-RELAY-CONTROL-PLANE-SPEC.md` §6/§10 and `DEVICE-LINK-AND-PASSKEY-SPEC.md`, which currently rules TOTP out explicitly).

### Open questions for the product owner
1. Signup policy: invite-only (A) or open signup with personal workspaces (B)? See §5.5.
2. Is it acceptable that admins see metadata for every machine in the workspace but cannot drive those sessions without a share?
3. Should `require_2fa` default to **on** for new workspaces?
4. Is transactional email in scope now? Without it, invitations are copy-link only.
