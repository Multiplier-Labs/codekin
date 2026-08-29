# Loop Runs (Goal Runs)

A loop run wraps a coding session in a durable **act → verify → continue/stop**
loop: an agent (the *maker*) works toward a goal in an isolated worktree, a
deterministic verifier runs shell commands after every turn, and the loop
continues — feeding failures back to the maker — until the verifier passes,
a budget is exhausted, or a human needs to decide. Every step is recorded in an
evidence ledger, so a run is auditable after the fact.

Loop runs differ from [AI Workflows](WORKFLOWS.md) in shape: a workflow is a
scheduled one-shot session that produces a report; a loop run is goal-driven
and iterates until a machine-checkable condition holds.

## Lifecycle

```
queued → running ⇄ verifying ⇄ checking → succeeded
              ⇅                              failed
           blocked                           aborted
                                             awaiting_human
```

| Status | Meaning |
|---|---|
| `queued` | Created; maker session not yet started. |
| `running` | The maker is working a turn. |
| `verifying` | The verify commands are executing against the worktree. |
| `checking` | The checker (second provider) is reviewing the diff. |
| `blocked` | A maker/checker tool call is waiting on human approval or a question. Non-terminal: answer the prompt (open the session from the sidebar) and the loop resumes; unanswered prompts are denied by the router timeout and the loop continues on the denial. |
| `awaiting_human` | Escalated to a human checkpoint — repeated readonly violations, a checker `escalate` verdict, or an unparseable verdict. Terminal. |
| `succeeded` | Verifier green (and checker approval, if configured); changes landed per the completion policy. |
| `failed` | Turn/cost budget exhausted, unrecoverable error, or the run was interrupted by a server restart. |
| `aborted` | Cancelled by the user. |

**Restarts.** In-flight runs do not survive a server restart: at boot, any run
persisted in a non-terminal status is marked `failed` with a
"interrupted by a server restart" row in its ledger. (Reattaching to a live
maker session after a restart is future work — until then the ledger is honest
rather than optimistic.)

## Turn mechanics

Each maker turn ends with a session result, which triggers:

1. **Budgets** — the run fails once `maxTurns` or `maxCostUsd` is reached.
2. **Readonly enforcement** — files matching `readonly` globs must not change;
   a violation re-prompts the maker, and repeated violations escalate.
3. **No-change nudge** — a clean tree is not success; the maker is re-prompted.
4. **Verify (debounced)** — the `verify` commands run in order in the worktree
   (10 min per command); the run skips re-verifying when the diff is unchanged.
   Failures are fed back to the maker as the next turn's input.
5. **Checker review (optional)** — when the spec names a `checker`, a second
   provider reviews the diff read-only and must end its reply with
   `VERDICT: approve | request_changes | escalate`.
6. **Finalization** — on success Codekin (not the agent) commits the verified
   tree and, per `completionPolicy`, pushes and opens a PR. Auto-merge is never
   performed.

## Tool allowlists

Maker sessions are created with the shared headless-agent allowlist
(`server/agent-allowlist.ts`) — git, gh, package managers, build/test tools,
non-destructive file operations. Destructive commands (`rm`, `sudo`,
`git push --force`, …) still require approval; a run waiting on one shows as
`blocked`. Checker sessions get a read-only subset (no Write/Edit) — a reviewer
that needs to write has left its mandate.

## Templates

A loop template is a markdown file with YAML frontmatter (spec) and a body
(default goal text):

```markdown
---
kind: flaky-e2e
name: Flaky E2E Quarantine
maker:
  provider: claude
checker:            # optional — omit for a single-provider loop
  provider: opencode
verify:
  - npm test
  - npm run lint
readonly:           # optional
  - .github/workflows/**
maxTurns: 12
maxCostUsd: 5
completionPolicy: pr   # pr | merge | commit-only (defaults to pr)
---
Find the flaky e2e test on this branch, fix the root cause...
```

Templates are read from two places:

- **Built-ins** shipped with the package (`server/loops/*.md`):
  `ci-autorepair`, `coverage-increase`, `dependency-upgrade`.
- **Per-repo templates** in `{repo}/.codekin/loops/*.md`. A repo template with
  the same `kind` overrides the built-in; a repo template with a **new kind is
  a first-class loop** — kinds are an open set, validated only as lowercase
  slugs (letters, digits, `.`, `_`, `-`, max 64 chars).

## API

All endpoints require the master Bearer token.

| Endpoint | Description |
|---|---|
| `GET /api/goal-runs/templates?repoPath=` | Available templates (built-ins + repo). |
| `GET /api/goal-runs/runs?kind=&status=&limit=` | List runs, newest first. |
| `GET /api/goal-runs/runs/:id` | One run plus its turn-by-turn evidence ledger. |
| `POST /api/goal-runs/runs` | Start a run: `{ kind, repo, branch, goal? }`. `goal` overrides the template's default goal text. |
| `POST /api/goal-runs/runs/:id/abort` | Abort an in-flight (or restart-orphaned) run. |

## UI

The **Loop Runs** sidebar entry (`/loops`) lists runs with live status, spend
vs budget, and turn count; a run's detail view shows the evidence ledger. The
maker and checker are ordinary sessions (`source: agent`) and appear in the
sidebar — open one to answer a `blocked` prompt or watch the agent work.

## Storage

SQLite at `~/.codekin/goal-runs.db` (WAL, `0600`): `goal_runs` (one row per
run) and `goal_run_turns` (the evidence ledger — diff stat, verify command,
exit code, output tail, checker verdict, cost per action).
