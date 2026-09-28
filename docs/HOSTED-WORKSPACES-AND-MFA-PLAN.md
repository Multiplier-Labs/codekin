# Hosted Workspaces, Invitations and MFA — Implementation Plan

**Status:** Phase 0 in progress · **Date:** 2026-09-28
**Sources:** `.codekin/reports/security/2026-09-28_hosted-access-audit.md` (Claude) and
`.codekin/reports/security/2026-09-28_hosted-access-audit-codex.md` (Codex). The two audits
agree on every confirmed defect. This plan combines them and resolves the few points where
they differ (§2).

## 1. Goal

Turn app.codekin.ai from a single-org, env-allowlisted deployment into a multi-workspace
product:

- users can create workspaces, invite people into them, and manage roles;
- two-factor authentication is enforced on **every** login path.

Erwin Analytics is the reference for the 2FA experience: TOTP enrollment, recovery codes and
admin-driven user management. It has no workspaces or invitations, so that model is designed
here and not copied from Erwin.

## 2. Decisions

| # | Decision | Resolves |
|---|---|---|
| D1 | GitHub OAuth stays the only identity provider. No passwords. | Both audits |
| D2 | Signup stays **invite-only** until the workspace isolation tests pass. Creating a workspace requires a platform flag in v1. | Codex "keep public signup gated" |
| D3 | Roles are **per workspace** (`owner/admin/member/viewer`), held in `workspace_memberships`. `users.status` remains a platform-wide kill switch. | Both |
| D4 | Admins see machine *metadata* across the workspace and can remove or quarantine machines. They **cannot drive sessions** without an explicit share. | Claude oversight vs Codex "preserve the ownership boundary". Both are kept. |
| D5 | Viewers cannot pair machines, and share grants to a viewer are capped at the `viewer` preset. | Both (A5/M3) |
| D6 | A verified passkey (UV) satisfies MFA. GitHub OAuth by itself does not. A device link inherits the assurance of the session that minted it and can never raise it. | Both |
| D7 | MFA is **mandatory for owners and admins**, and a per-workspace `require_mfa` extends it to everyone. | Codex |
| D8 | No "trust this device" bypass in v1. Absolute session lifetime plus step-up provide the convenience/safety balance. | Codex (Claude had it optional) |
| D9 | A workspace admin cannot reset another user's 2FA. Only the platform operator can, through the relay CLI, and the reset is audited. | Claude |
| D10 | When a member is removed, their machines in that workspace are **quarantined** (not reachable) until someone explicitly transfers or deletes them. | Codex |
| D11 | Invitation tokens travel in the URL fragment, are stored hashed, are single-use and expire after 7 days. They are bound to a recipient: a verified GitHub email or an immutable GitHub id. | Both |
| D12 | Invitations are copy-link only until transactional email exists. The UI never claims an email was delivered. | Both |
| D13 | Schema changes go through versioned migrations (`PRAGMA user_version`). Each release includes a backup/restore rehearsal. Old single-org code is never deployed against the new data. | Codex |

## 3. Phases

### Phase 0 — Close current defects (no data-model change beyond sessions)

| Item | Finding |
|---|---|
| Bind browser sockets to their web session. Logout closes that session's sockets, and reauthorization drops sockets whose session is gone. | A1 / H3 |
| `logout-all` and account disable revoke pending device-link codes. | A2 / M1 |
| Validate share `expiresAt` (finite, future) at create and update. An unparseable stored value fails closed. | A6 / M2 |
| Viewers cannot pair machines, and shares to viewers are capped at view-only. | A5 / M3 |
| `web_sessions.user_id` column, so revocation takes O(1) instead of a full-table JSON scan. | M6 |
| Absolute session lifetime (30 d from sign-in, independent of rolling). `secure` cookie derived from `publicUrl`. | A7 / M6 |
| Origin check on cookie-authenticated REST mutations. | A8 / M5 |
| `/api/me` refreshed from the DB. | Codex smaller issue |
| Passkey login verifies the assertion before checking account status (removes the status oracle). WebAuthn challenges expire after 5 min. | L2 / A7 |
| Audit `login`, `login_failed`, `logout` and `logout_all` for every login method. | L1 / A7 |
| Sessions record `authMethod` and `authenticatedAt`, the basis for step-up in Phase 3. | A7 |
| IP rate limits on share, user and pairing-approval mutations. | M7 |

Step-up *enforcement* on passkey enrollment and device-link minting ships with Phase 3. It
needs a second factor to prompt for, and re-running GitHub OAuth is not a meaningful step-up.

### Phase 1 — Workspace boundary

- Migration v1 does the following:
  - renames `organizations` to `workspaces` (adding `slug`, `require_mfa`, `deleted_at`);
  - adds `workspace_memberships(workspace_id, user_id, role, status, …)`;
  - backfills memberships from `users.role`;
  - converts `organization_id` to `workspace_id` on machines, shares and audit events.
- Every data helper takes `workspaceId` as a **required** parameter: machines, shares, grantee
  lookup, users/members, audit reads and pairing.
- A single `can(membership, action)` capability helper implements the matrix in the Claude
  report §5.3, amended by D4 and D5.
- The current workspace is resolved per request from the session plus the `X-Codekin-Workspace`
  header, and is re-checked against the membership on every REST request and on WebSocket
  `hello` and reauthorize.
- Last-owner protection runs inside the same transaction as the change.
- Member removal closes the member's sockets in that workspace, revokes their shares, and
  quarantines their machines (D10).
- UI: workspace switcher, members page, machine list scoped to the workspace.
- `OWNER_GITHUB_ID` becomes bootstrap-only: owner of the migrated workspace plus the platform
  operator.

**Implementation notes (1a, backend):**
- Migration 2 renames `organizations` to `workspaces`. It rebuilds `users` without `role` and
  `organization_id`, adding `can_create_workspaces`, and rebuilds `audit_events` with a nullable
  `workspace_id`.
- `SCHEMA` now runs only on version 0. Every later table change is a migration.
- Authorization lives in `workspaces.ts` (`can()`, membership lifecycle) and `resolveMachineAccess`.
  `resolveMachineAccess` requires an active membership in the machine's workspace. A quarantined
  machine, or a viewer's own machine, is unreachable.
- REST routes not addressed by workspace id resolve the workspace from `X-Codekin-Workspace`,
  falling back to the user's default (bootstrap first), so the pre-1b UI keeps working.
- `/api/users` is operator-only. It handles account status and `canCreateWorkspaces`.
- The bootstrap workspace cannot be deleted while allowlist admission still targets it.

**Implementation notes (1b, frontend):**
- `src/hosted/workspace.ts` holds this tab's workspace in memory, seeded from localStorage. It adds
  `X-Codekin-Workspace` to relay calls (machine list, pairing, shares) and mirrors the capability
  matrix for UI gating.
- Switching workspace forgets the open machine and reloads at `/`, so nothing from the old
  workspace survives.
- The Settings "Workspace" section (`WorkspaceSection.tsx`) holds:
  - the switcher, create, rename, leave and delete controls;
  - members, with role, suspend and remove;
  - admin machine oversight: transfer or remove, including locked machines.
- Accounts with no workspace get a dedicated screen (create one if allowed). The share dialog picks
  grantees from the workspace's members.

### Phase 2 — Invitations and workspace onboarding

- Add the `workspace_invitations` table (Claude report §5.1) and these routes: create, list,
  revoke, resend (which re-issues the token), a public `lookup` (rate-limited), and `accept`
  (POST only, transactional, idempotent for existing members).
- A valid invitation bypasses the env allowlist. Email binding is checked against **verified**
  GitHub emails only (`/user/emails`, with `verified: true`).
- Extend the `returnTo` allowlist to `/invite`. Add a landing page, and handle the "no
  workspace yet", "removed" and "disabled" states.
- Workspace creation stays behind the platform flag (D2).

**Implementation notes:**
- Migration 3 adds `workspace_invitations`. Each invitation is bound to a GitHub id (the username
  is resolved via the public users API at creation) or to an email.
- Invitations are **accepted only in the OAuth callback**:
  1. `/invite#token` calls `POST /api/invitations/lookup`, which gives a preview that never
     discloses the bound email.
  2. `POST /api/invitations/prepare` parks the token in the session.
  3. The browser goes through GitHub sign-in.
  4. The callback matches the invitation against the GitHub id and the *verified* emails, admits
     the account past the allowlist if needed, and consumes the invitation in one transaction.
  5. It redirects to `/?joined=<id>`.
- The inviter's authority is re-checked at acceptance. The inviter must still be an active
  owner or admin, and only owners can have invited an admin.
- There is one live link per recipient, and "new link" revokes the old one.
- At most 100 pending invitations per workspace.
- An existing membership (including a suspended one) is left untouched.

### Phase 3 — Enforced MFA

- Add the `user_totp` table (secret encrypted with AES-256-GCM under a separate, versioned
  `MFA_ENCRYPTION_KEY`; tracks `last_used_step`), the `user_recovery_codes` table (10 codes,
  hashed, each consumed atomically), and a `users.auth_version` column.
- Session state machine: `partial` (after GitHub, when MFA is required or enrolled) → `full`.
  A partial session can reach only the 2FA, enrollment, `me` and logout routes, and cannot
  upgrade to a WebSocket.
- Passkey login counts as `full` (D6). A device link copies the minting session's assurance.
- Step-up requires `mfaVerifiedAt` within 10 min for:
  - passkey add/remove, device-link mint;
  - TOTP disable, recovery-code regeneration;
  - admin invites, ownership transfer, workspace delete, lowering `require_mfa`.
- Enforcement: 5 attempts per 15 min per user and IP, challenges expire after 10 min, and
  every security change bumps `auth_version`, which invalidates older sessions.
- UI: enrollment (QR, confirm, codes shown once), challenge screen, security settings, and a
  members-page compliance column.
- Platform operator CLI: `codekin-relay reset-mfa <github-id>` (D9).

### Phase 4 — Staging gate and rollout

Stand up two independent workspaces plus a user who belongs to both, then walk through the
whole flow: invite onboarding; MFA enrollment, login and recovery; machine pairing; sharing;
removing a member and demoting a role while a stream is live.

Required negative tests:
- every REST and WebSocket ID from workspace A is rejected in workspace B;
- a partial session is denied everywhere;
- wrong-recipient, expired, revoked and replayed invitations all fail;
- concurrent invitation, recovery-code and TOTP consumption stays single-use;
- a viewer holding an editor grant still cannot execute;
- the last owner is protected;
- revoked sessions and device links cannot restore access;
- suspending an account applies globally, while removing a membership applies to that
  workspace only.

Optional later work: transactional email, open signup with per-workspace quotas.

## 4. Status

| Phase | Status | PR |
|---|---|---|
| 0 | Merged | #644 |
| 1 | Merged | #645, #646 |
| 2 | In review (`feat/hosted-invitations`) | — |
| 3 | Not started | — |
| 4 | Not started | — |
