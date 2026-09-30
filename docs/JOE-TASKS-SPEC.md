# Agent Joe — Per-Repo Task List and Delegation

Status: Phase 1 (backend) and Phase 2 (UI) in progress. Background: the Agent Joe audit
(`.codekin/reports/product/2026-09-30_agent-joe-audit.md`), which proposed "supervise
delegated tasks until verified changes are ready for review" as Joe's first job. Builds on
the child lifecycle (#688) and session-control tools (#691).

## Goal

Joe keeps a durable **task list for every repository** it manages. The user delegates work
into that list. Joe also adds work it finds (audit findings, incidents), with the user's
consent. Each task moves through the same small set of states until a human accepts the
result. That list is what lets Joe grow from a chat that spawns sessions into a repo
maintainer: it remembers what is outstanding, what is waiting on the user, and what is
ready to merge.

When the user comes back, the answer to "what happened?" is three short lists, not three
transcripts:

- **Needs your decision:** Joe cannot continue without the user.
- **Ready for review:** a verified PR at a known commit.
- **In progress:** a supervised child is working.

## Model

One row per task in `runs.db` (`joe_tasks`), plus an append-only history (`joe_task_events`).

| Field | Meaning |
| --- | --- |
| `id`, `repo` | Every task belongs to exactly one repository |
| `title`, `detail`, `acceptance` | What to do and how we know it is done |
| `priority` | `high` / `normal` / `low` |
| `source`, `sourceRef` | `user` (delegated), `joe`, `report` (path), `incident` (deployment/probe) |
| `status` | See below |
| `completionPolicy` | `pr` (default) / `merge` (push) / `commit-only`, passed to the child |
| `childId`, `childIds` | Current and past supervised attempts (child session ids = run ids) |
| `prUrl`, `commit`, `verification` | Evidence copied from the child's final-step verification |
| `decision` | `{ question, recommendation, options, askedAt, answer, answeredAt }` when a human is needed |
| `reviewNote` | The user's latest "request changes" note |

### Status

```
todo ──start──▶ in_progress ──verified──▶ in_review ──accept──▶ done
  ▲                │   ▲                     │
  │ child canceled │   │ answered / retry     │ request changes
  │                ▼   │                     ▼
  └────────── needs_decision ◀───────────────┘ (back to in_progress)

any open state ──dismiss──▶ dismissed        done/dismissed ──reopen──▶ todo
```

The linked child's lifecycle drives status automatically. Nobody has to remember to update it:

| Child | Task |
| --- | --- |
| `starting` / `running` / `blocked` | `in_progress`. A blocked child shows "waiting on approval"; Joe handles routine prompts within trust and escalates the rest with a decision |
| `completed` (verified) | `in_review`, with PR, commit and verification recorded |
| `unverified` / `failed` / `timed_out` | `needs_decision`, with a system decision: retry or dismiss, and the reason |
| `canceled` | `todo` (the work is kept in its worktree; restarting is explicit) |

Joe can also open a decision at any time (`request_decision`), e.g. "this needs a public
API change: A or B?". An open decision holds the task in `needs_decision` until answered.

## Who does what

- **User (UI / REST):** delegates tasks, answers decisions, accepts, requests changes,
  edits, dismisses or reopens. Every action that needs follow-up work reaches Joe as a
  durable outbox notification. The server never spawns work behind Joe's back, so repo
  policies (REPOS.md) and trust still apply.
- **Joe (MCP):** `list_tasks`, `create_task`, `update_task`, `request_decision`, and
  `spawn_child` with `taskId`, which links the attempt and moves the task to `in_progress`.
  `resume_child` on a linked child is a new attempt of the same task.
- **Server:** keeps task status in sync with child lifecycle events, copies verification
  evidence, and keeps the history.

## API (`/api/orchestrator/tasks`, orchestrator auth)

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/tasks?repo=&status=` | List tasks (newest first) plus per-status counts |
| GET | `/tasks/:id` | One task with its history |
| POST | `/tasks` | Create (`{ repo, tasks: [{ title, detail?, acceptance?, priority? }], completionPolicy?, source?, sourceRef?, delegate? }`). `delegate: true` notifies Joe to start them |
| PATCH | `/tasks/:id` | Edit fields; `status` may be set to `todo`, `done`, `dismissed` |
| POST | `/tasks/:id/decision` | Joe opens a decision (`{ question, recommendation?, options? }`) |
| POST | `/tasks/:id/answer` | User answers the open decision (`{ answer }`) → Joe notified |
| POST | `/tasks/:id/start` | User asks Joe to start a `todo` task (or resume a stopped attempt) |
| POST | `/tasks/:id/accept` | User accepts a reviewed task → `done` |
| POST | `/tasks/:id/request-changes` | User sends it back (`{ note }`) → Joe notified to resume the child |

Mutations broadcast a `workflow_event` (`engine: 'agent'`, `kind: 'task'`), so open views
refresh immediately.

## UI (Phase 2)

Joe's view gets **Chat / Tasks** tabs. The Tasks tab has a count badge for items waiting on
the user (decisions + reviews).

- Repo filter: all repos, or one.
- Sections in order: Needs your decision, Ready for review, In progress, To do, then Done /
  Dismissed collapsed.
- A decision card shows the question, Joe's recommendation, one-click options and a free-text
  answer. A failure card offers Retry and Dismiss.
- A review card shows the PR link, verified commit, verification detail, and Accept or Request
  changes with a note.
- Every card links to the child session.
- **Delegate tasks** opens a form: repo, one task per line (or title plus details), acceptance
  criteria, and delivery (PR / push / commit). Submitting creates the tasks and hands them to Joe.

## Later phases

- CI check results in the evidence (`gh pr checks`), so "ready" means "green" too.
- A task becomes `done` automatically when its PR merges (PR webhook / poll).
- Report triage creates `source: report` tasks for findings the user approves; incident
  auto-diagnosis creates `source: incident` tasks.
- Pilot measurement from the audit: status checks avoided, time to decision, false-ready = 0.
