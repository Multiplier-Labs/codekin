# Claude Code Integration Assessment

**Date:** 2026-06-11
**Scope:** Plan mode lifecycle, permission system, skills/slash-command setup
**Branch reviewed:** `main` @ 577c695

---

## Executive Summary

The integration is architecturally sound — the PreToolUse-hook approval pipeline, session-scoped auth tokens, and fail-closed behavior are well designed. However, **plan mode is structurally broken**: approving a plan never updates the session's `permissionMode`, so the implementation phase that follows runs with plan-mode gating still active, and any process restart re-spawns the CLI back into plan mode. Permissions are functional but fragile under disconnects/timeouts (silent auto-denies). Skills work but the skill list goes stale across repo/worktree switches.

---

## 1. Plan Mode (critical)

### How it works today

| Step | Location |
|---|---|
| Mode set at spawn via `--permission-mode` CLI arg | `server/claude-process.ts:200` |
| UI mode change → process **restart** via reconfigure | `server/session-manager.ts:1379-1383`, `server/process-coordinator.ts:67-75` |
| EnterPlanMode stream event → `PlanManager.onEnterPlanMode()` | `server/session-lifecycle.ts:231-240` |
| ExitPlanMode intercepted by PreToolUse hook → server approval | `.claude/hooks/pre-tool-use.mjs:110-132`, `server/prompt-router.ts:485-541` |
| Approve/deny resolution via PlanManager | `server/prompt-router.ts:448-465` |
| PlanManager reset only on process exit | `server/session-lifecycle.ts:271` |

### Findings

**P0 — Plan approval never transitions `session.permissionMode`.**
`resolveToolApproval` for ExitPlanMode (`prompt-router.ts:448-465`) calls `planManager.approve()` and allows the tool, but `session.permissionMode` stays `'plan'`. Two severe consequences:

1. **Implementation phase prompts on every file write.** `resolveAutoApproval` (`prompt-router.ts:613-619`) only auto-approves `FILE_TOOLS` when the mode is in `EDIT_MODES` (`acceptEdits`/`bypassPermissions`/`dangerouslySkipPermissions`). With the mode stuck at `'plan'`, every `Edit`/`Write`/`NotebookEdit` after plan approval requires a manual click — the "Approve plan" action doesn't actually unlock editing.
2. **Process restarts re-enter plan mode mid-implementation.** Auto-restart after crash, reconfigure, or session resume re-spawns with `--permission-mode plan` (`claude-process.ts:200`), so Claude is yanked back into planning while halfway through implementing the approved plan.

There is no equivalent of the CLI's native "approve and auto-accept edits" transition. **Fix:** on plan approval, set `session.permissionMode` to `acceptEdits` (or a configurable post-plan mode), persist it, and broadcast the change.

**P0 — Glob/Grep (and out-of-project Read) prompt the user during planning.**
The hook auto-allows only in-project `Read` (`pre-tool-use.mjs:135-146`). `Glob`/`Grep` are forwarded to the server, where plan mode is not in `EDIT_MODES`, so they resolve to `'prompt'`. Plan mode — a read-only research mode — generates approval prompts for read-only search tools. **Fix:** treat read-only tools (`Read`, `Glob`, `Grep`) as auto-approved in all modes (in-project), at the hook or in `resolveAutoApproval`.

**P1 — Plan mode is not actually enforced for writes.**
In plan mode, a `Write`/`Edit` resolves to `'prompt'` rather than deny. If the user clicks approve, the hook's `allow` overrides the CLI's plan-mode restrictions and the edit executes during planning. The server should deny (or hide) write tools while `permissionMode === 'plan'` / `PlanManager` is in `planning`.

**P1 — Mode change restarts the Claude process.**
`setPermissionMode` → `requestReconfigure` stops and restarts the process (`session-manager.ts:1379-1383`). Switching modes mid-turn kills in-flight work and pending approvals (which exist only in memory). The stream-json protocol supports changing permission mode via control request without a restart — worth adopting.

**P2 — State synchronization gaps.**
- `session_joined` (`ws-message-handler.ts:115-124`) includes `permissionMode` but not the current `PlanManager` state; the frontend reconstructs planning state from the last 500 history entries (`useChatSocket.ts:342-348`) — stale after restarts.
- `setPermissionMode` emits only a free-text `system_message` (`session-manager.ts:1373-1377`), no structured state echo, and it's emitted *before* the reconfigure completes (misleading if restart fails).
- Plan approval responses can race a process restart: the pending approval promise survives while `PlanManager` is reset on exit (`session-lifecycle.ts:271`), leaving the state machine inconsistent.

---

## 2. Permissions

### Architecture (sound)

- PreToolUse hook → HTTP `/api/hook-decision` (`server/session-routes.ts:488-543`) → `PromptRouter.requestToolApproval` → WS `prompt` to clients. Fail-closed on server error (`pre-tool-use.mjs:207-210`). Session-scoped derived auth tokens (`session-lifecycle.ts:118-122`). Good.
- Auto-approval layers: permission-mode file tools, repo approval registry (`~/.codekin/repo-approvals.json`), session `allowedTools`, headless-source allowance (`prompt-router.ts:613-636`). Agent child sessions correctly excluded from blanket headless approval.

### Findings

| # | Issue | Location | Severity |
|---|---|---|---|
| 1 | **Silent auto-deny on timeout** — 5-min approval timeout denies with no user-visible notification | `prompt-router.ts:336-345`, `501-509` | High |
| 2 | **Silent auto-deny on disconnect** — 10s grace period after last client leaves, then pending prompts denied; rejoining user is never told | `session-manager.ts:861-889` | High |
| 3 | **Pending approvals lost on restart/resume** — in-memory only; a crash mid-prompt orphans the hook request | `session-lifecycle.ts:143-150` | Medium |
| 4 | **Multi-client races** — first response wins; responses without `requestId` are rejected when multiple prompts pend | `prompt-router.ts:194-230` | Medium |
| 5 | **Dangerous modes one click away** — `bypassPermissions` / `dangerouslySkipPermissions` selectable in UI with only a server-side `console.warn`, no confirmation step | `src/types.ts:74-78`, `session-manager.ts:1369-1371` | Medium |
| 6 | **AskUserQuestion workaround is fragile** — answers smuggled through a `deny` reason because the CLI's `requiresUserInteraction()` guard blocks hook allows; depends on Claude parsing the denial text | `pre-tool-use.mjs:58-104` | Medium (known CLI limitation; document + monitor) |
| 7 | Bash denylist is prefix-based (`rm`, `docker`, `git push`…) — easily bypassed via `command; rm …`, env tricks, or absolute paths; fine as UX guard, must not be treated as a security boundary | `server/approval-manager.ts:129-137` | Low/informational |

### Verdict

Properly thought through for the happy path; the gaps are all in failure/edge handling (timeouts, disconnects, restarts) and in missing friction before dangerous modes.

---

## 3. Skills / Slash Commands

### Architecture (mostly sound)

- Discovery: `~/.claude/skills/` + `.claude/skills/` scanned for `SKILL.md`, frontmatter parsed, served via `/cc/api/repos` (`server/upload-routes.ts:31-80`).
- Invocation: built-ins handled locally; filesystem skills expanded client-side (`$ARGUMENTS` substitution, `displayText` for collapsed UI rendering); bundled skills passed through to the CLI's native Skill tool (`src/hooks/useSendMessage.ts:80-111`, `server/ws-message-handler.ts:163-175`). Precedence (filesystem > bundled > built-in) is implemented and tested (`src/lib/slashCommands.ts:82-115`, `slashCommands.test.ts:70-84`).

### Findings

| # | Issue | Location | Severity |
|---|---|---|---|
| 1 | **Skill list never refreshed** — fetched once at app startup; switching repo/worktree or adding a skill mid-session shows stale/missing skills | `src/hooks/useRepos.ts:39-56`, `src/App.tsx:263-269` | Medium |
| 2 | **Frontmatter parser is regex-based** — silently degrades on colons in values, multi-line YAML; no validation or error surfacing | `server/upload-routes.ts:49` | Low |
| 3 | **Silent shadowing** — a filesystem skill named `commit` silently replaces the bundled `/commit`; no warning to the user | `src/lib/slashCommands.ts:82-115` | Low |
| 4 | No validation that a skill body uses `$ARGUMENTS` when args are supplied (args silently dropped) | `src/hooks/useSendMessage.ts:80-111` | Low |

---

## Prioritized Recommendations

1. **(P0)** On plan approval, transition `session.permissionMode` from `plan` → `acceptEdits` (persist + broadcast a structured mode-change message). Fixes both the prompt-storm after approval and the restart-back-into-plan-mode bug.
2. **(P0)** Auto-approve read-only tools (`Read`, `Glob`, `Grep` for in-project paths) regardless of permission mode, so plan mode is usable for research.
3. **(P1)** Deny write tools server-side while planning instead of prompting — make plan mode actually read-only.
4. **(P1)** Replace restart-on-mode-change with the stream-json mode-change control request; keep restart only as a fallback.
5. **(P1)** Notify clients when approvals are auto-denied (timeout or disconnect grace period) with a visible system message in history.
6. **(P2)** Include `PlanManager` state in `session_joined`; broadcast a structured `permission_mode_changed` message instead of free-text only.
7. **(P2)** Add a confirmation step before activating `bypassPermissions` / `dangerouslySkipPermissions`.
8. **(P2)** Refresh skills on session create/join and repo/worktree switch; use a real YAML parser for frontmatter.
