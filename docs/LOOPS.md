# Loops

Loops are Codekin's durable control plane for outcome-driven agent work: you
state an outcome and acceptance criteria (a **recipe**), and Codekin runs a
coding agent in checkpointed stages until the criteria pass, a human decision
is needed, or a budget boundary is reached. The full design rationale lives in
[LOOPS-REWRITE-SPEC.md](./LOOPS-REWRITE-SPEC.md); this page documents what is
implemented today (Phase 1: durable engine core).

## Core loop

```text
preflight → (plan) → act → evaluate → (review) → decide → … → finalize
```

- **plan** — with `plan.required`, the maker produces an explicit plan
  artifact before touching any files. Guided mode gates execution on plan
  approval (approve / revise-with-note / stop); other modes record the plan
  and proceed. Steering with "revise plan first" asks for a plan revision at
  the next boundary.

- **act** — a maker session (claude / codex / opencode) works in an isolated
  git worktree on the run's branch.
- **evaluate** — deterministic evaluators run in recipe order after every
  maker turn: `command` (exit code), `test-report` (same, plus failing tests
  parsed from vitest/TAP/JUnit-XML output — better feedback, stabler
  no-progress fingerprints), `diff-policy` (change-size caps, forbidden
  paths, secret scan, test-weakening heuristics), and `artifact` (a file the
  run must produce). Failures are fed back to the maker; transient
  environment errors retry per the recipe's `retry` policy.
- **review** — rubric evaluators put an independent model — always a
  *different provider* than the maker — over the diff. It answers with
  `approve` / `request_changes` / `escalate`; an unparseable verdict escalates
  rather than silently passing. `human` evaluators then ask for an explicit
  sign-off (pass / waive / fail — failing sends your note back to the agent),
  and `composite` evaluators fold other results (`all`/`any`).
- **decide** — deterministic code, not the model. The maker never decides
  whether its own acceptance criteria passed. The decision order is: user
  cancel/pause → budgets → protected paths → no-change nudge → evaluation →
  no-progress detection → review → completion.
- **finalize** — Codekin itself commits the verified tree and, per the
  completion action, pushes and opens a PR. Auto-merge does not exist.
- **monitoring_ci** — with a `ci` evaluator, completion waits for the named
  remote checks at the PR. A red required check re-enters the loop (the maker
  investigates, fixes, and the PR is updated) within budget; checks that
  never conclude escalate to the operator (keep waiting / finish qualified /
  stop).

## Durability

Every transition is an append-only row in `loop_events` (monotonic sequence
per run) and orchestration counters are checkpointed after every decided
turn. On restart Codekin reconciles instead of failing runs:

- `paused` and `awaiting_approval` runs are left waiting (they hold no
  process);
- in-flight runs resume at a stage boundary — a fresh session in the
  surviving worktree with a regenerated context prompt (provider sessions are
  not resumed in-provider);
- a run whose worktree is gone fails honestly with a reason.

Execution **state** and terminal **outcome** are separate fields: a run ends
`done` + `completed` / `completed_with_warnings` / `failed` / `canceled`.
Waived or failed-optional evaluators qualify the outcome — a run never shows
an unqualified green with a skipped check. The run detail carries a
**completion scorecard**: every criterion in the frozen recipe with its
latest status (`pending` when not yet evaluated) and its evidence artifacts.

## Controls

Every control appends an auditable event:

- **Pause** — parks the run durably at the next safe boundary; **Resume**
  continues in the same worktree with a fresh session.
- **Stop** — cancels now; the worktree is kept for inspection.
- **Steer** — queue an operator instruction; it reaches the maker at the next
  safe boundary (mid-turn injection is not attempted).
- **Interventions** — when the run cannot decide safely it parks in
  `awaiting_approval` with a pending intervention card: completion approval
  (guided mode), budget extension (extend adds 50% of the original budget),
  or escalation (repeated protected-path violations, no-progress, reviewer
  escalation). Resolving the card continues or ends the run.

## Budgets and no-progress

`budgets.turns` and `budgets.costUsd` are hard caps; `budgets.wallTime` is
optional. At a boundary the run *asks* for a bounded extension (guided /
guarded modes) or stops with a partial result (autonomous mode). The
no-progress detector compares diff summaries and normalized failure
fingerprints across evaluate cycles — producing more text is not progress —
and escalates after `budgets.noProgressAttempts` identical failures.

## Parallel workstreams

With `workers.maxParallel > 1` (requires `plan.required`), the planning prompt
lets the maker declare independent WORKSTREAM blocks — a name, disjoint path
scopes, and a task each. Validation is deterministic and conservative: fewer
than two streams, missing scopes, or overlapping scope prefixes all fall back
to sequential execution. Valid streams fan out to child maker sessions in
child worktrees branched off the run branch; each child's work is committed
engine-side (never dependent on the model remembering to commit) and
scope-checked against its declared globs. A separate `integrate` stage merges
the surviving branches with `--no-ff` — a merge conflict aborts the merge and
escalates to the operator; nothing resolves conflicts silently. The main
maker session handles all post-integration repairs sequentially.

## Forking

Fork (button in the workspace, `POST /runs/:id/fork`) starts a new run from a
run's *current worktree state* — uncommitted work included, captured with
`git stash create` so the source tree is never disturbed. The fork gets the
same frozen recipe and goal, fresh budgets, and a context note carrying the
source's plan and latest evaluation; both runs record the relationship as
events.

## Lessons

After a run ends (except canceled), a deterministic reflection pass over the
run's own evidence suggests lessons scoped to the recipe: retry allowances
for evaluators that hit transient environment errors, budget adjustments when
runs finish near a cap or die at the boundary, standing review guidance when
the reviewer pushes back repeatedly, outcome wording when protected paths
kept getting touched. Suggestions start as `suggested` and are approved or
rejected by you (workspace panel or `POST /lessons/:id/approve|reject`) —
agents never rewrite recipes or policies. Approved lessons are injected into
future runs' prompts (visible as a `lessons_applied` event), and
`GET /recipes/:id/stats` groups run outcomes by frozen recipe hash so recipe
versions can be compared A/B.

## Recipes

A recipe is Markdown + YAML frontmatter, reviewable in git:

```yaml
---
apiVersion: codekin.dev/v2
kind: LoopRecipe
metadata:
  id: ci-autorepair
  name: CI Autorepair
agent:
  provider: auto            # resolves at run start; recorded on the run
workspace:
  strategy: worktree
  protectedPaths: [".github/workflows/**"]
plan:
  required: false           # true: explicit plan artifact before any edits
evaluators:
  - id: tests
    type: command
    command: npm test        # shell string (trusted repo code) or argv array
    timeout: 15m
    retry: { maxAttempts: 2 }
  - id: review
    type: rubric
    provider: different-from-maker
budgets:
  turns: 12
  costUsd: 5
  wallTime: 90m
policy:
  mode: guarded              # guided | guarded | autonomous
completion:
  action: pull-request       # or commit-only; auto-merge does not exist
---
The outcome prompt (markdown body) goes here.
```

Validation is strict — unknown fields fail. The parsed recipe is normalized,
content-hashed, and frozen into every run, so editing the file never changes
what a past run claims it executed. Recipes load from:

- built-ins shipped with the package: `server/loops/*.md`
  (`ci-autorepair`, `coverage-increase`, `dependency-upgrade`);
- per-repo overrides: `{repo}/.codekin/loops/*.md` (same id wins).

All spec §7 evaluator types are available: `command`, `test-report`,
`diff-policy`, `artifact`, `rubric`, `human`, `ci`, and `composite`. Every
recipe needs at least one required `command` or `test-report` evaluator — the
deterministic gate.

## Evidence

Full evaluator output is retained as content-addressed artifacts
(`~/.codekin/loop-artifacts/`), referenced from structured `loop_evaluations`
rows; the maker sees only a tail as feedback. Reviews are artifacts too.

## API

Mounted at `/api/loops` (master Bearer token). See
[API-REFERENCE.md](./API-REFERENCE.md#loops) for the endpoint list. Live
updates ride the shared `workflow_event` WS channel (`engine: 'loop'`) as
pings; clients reconcile against `GET /runs/:id/events?after=<sequence>`.

## UI

The Loops tab in Automations is the operations home: a summary strip (active,
needs attention, 7-day outcomes and spend) over Needs attention → Active →
Recent sections, with the selected run's workspace beside it (Overview with
inline intervention cards, plan, evaluator scorecard, budget bars; Timeline
over the event log). "New loop" opens a four-step wizard — repository picker
(cloned repos), base-branch picker, recipe + outcome, mode/plan/budget
controls, and a preflight screen showing the exact effective configuration
before anything is spent. Start-time overrides freeze into the run's recipe
under a recomputed content hash.

## Storage

Tables in the shared `~/.codekin/runs.db`: `loop_runs`, `loop_stages`,
`loop_attempts`, `loop_events`, `loop_checkpoints`, `loop_evaluations`,
`loop_artifacts` (metadata), `loop_interventions`. The v1 `goal_runs` /
`goal_run_turns` tables are dropped on first open — v1 had no users and no
history worth preserving (spec §12).
