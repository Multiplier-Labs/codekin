# Settings as a Full View

**Status:** Complete: PR 1 #651, PR 2 #652, PR 3 (hosted home, Profile, operator Accounts)

## 1. Problem

Settings is a modal (`src/components/Settings.tsx`, ~1,100 lines) that has outgrown the format:

- Hosted mode has eight sections. The Workspace section alone is page-sized: switcher, members,
  invitations, all machines, "require 2FA", and a danger zone.
- A modal has no URL. "Settings → Workspace → Members" can't be linked, and a reload closes it.
- Multi-step flows stack dialogs on the modal: 2FA enrollment, recovery codes, and the
  "Confirm it's you" step-up.
- When no machine is connected, hosted mode already renders Settings as a whole screen
  (`machinesOnly`). That's a second layout for the same content.

## 2. Target

A routed view at **`/settings/<section>`**, built the way `/automations` is (see `App.tsx`,
`navigate()`):

- **Desktop:** a left section nav and the section content, taking the whole window. The session
  sidebar (and the mobile top bar) is not shown while Settings is open — Settings is a page of its
  own, not a panel beside the session tree; Close returns to the session.
- **Mobile:** the section list, then a section page with a back button (list → detail).

Sections are grouped by **what they apply to**:

| Group | Section (`/settings/…`) | Contents | Shown |
|---|---|---|---|
| Account | `profile` | Signed-in identity, sign out, sign out everywhere | hosted |
| | `security` | 2FA, passkeys, device linking | hosted |
| | `appearance` | Theme | always |
| Workspace | `workspace` | Name, require 2FA, leave/delete | hosted |
| | `members` | Members, roles, invitations | hosted |
| | `machines` | Your machines; all machines for owners/admins | hosted |
| This machine | `connection` | Access token (local), agent name | when a machine is reachable |
| | `sessions` | Retention, message queueing, repos path, worktrees | when a machine is reachable |
| | `permissions` | Default permission mode, auto-approved patterns | when a machine is reachable |
| | `webhooks` | GitHub webhooks, health check, setup wizard | when a machine is reachable |
| Platform | `accounts` | Account status, who may create workspaces | operator only |

Rules:

- Every section loads its own data when it mounts. No section fetches for another.
- Everything saves immediately, except the access token, which keeps an explicit Verify/Save.
  The modal's global Save/Cancel footer goes away.
- Machine-backed sections don't render while disconnected, the rule the current
  `machinesOnly` test already asserts. The nav shows them as unavailable instead.
- In hosted mode with no machine connected, `/settings` *is* the home screen. This replaces the
  `machinesOnly` special case.
- **Quick settings stay quick.** The theme gets a small quick menu from the sidebar/avatar, so
  switching it isn't a page visit.
- Unknown or unavailable section ids redirect to the first available section. Role-gated
  sections are hidden, not disabled.
- The local (non-hosted) app uses the same view. It shows only Appearance and This machine.

## 3. Delivery

| PR | Change | User-visible |
|---|---|---|
| 1 | Extract each modal section into `src/components/settings/*` with its own state and data loading. The modal becomes a thin shell. | No |
| 2 | `SettingsView` with nav and `/settings/<section>` routing (desktop + mobile). The sidebar/top-bar Settings buttons open it; the modal is removed. Theme quick menu. | Yes |
| 3 | The hosted disconnected home becomes `/settings/machines`, and `machinesOnly` is removed. Add the Platform → Accounts section (operator UI for `/api/users`). | Yes |

**Notes from PR 2:**
- The theme quick menu already existed (`ThemeMenu` in the sidebar, desktop and mobile), so PR 2
  adds nothing for it.
- `Account → Profile` (identity, sign out) moves to PR 3. The account screens that own sign-out
  live in `HostedApp`, which PR 3 reworks anyway.
- Opening Settings no longer leaves the current session. The URL-to-session sync skips the
  settings view, and closing returns to `/s/<id>`.
- The Workspace card is split into `WorkspaceGeneral`, `WorkspaceMembers` and `WorkspaceMachines`
  (`src/hosted/WorkspaceSection.tsx`). `WorkspaceSection` composes them for the not-connected
  screen until PR 3.

**Notes from PR 3:**
- The hosted no-machine screen is now `SettingsView` with `connected={false}`. It opens on
  `/settings/machines`, machine sections are listed as unavailable ("Connect a machine to change
  these"), and the header shows who is signed in plus Sign out in place of Close. Opening a
  machine from there lands in the app at `/`. A reload on `/settings/<section>` with a remembered
  machine reconnects and stays on that page.
- Account → Profile shows identity, the current workspace and Sign out.
- Platform → Accounts is for the operator only, detected via `/api/me`. The view doesn't redirect
  away from it until that answer is in. Changes go through `stepUpFetch`.
- The old `Settings.tsx` screen and the composed `WorkspaceSection` export are removed.

## 4. Out of scope

Search within settings, per-repo settings pages, and changes to what any setting does.
