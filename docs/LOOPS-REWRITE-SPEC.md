# Loops 2.0 — Product and Technical Specification

**Status:** proposal

**Date:** 2026-08-30
**Scope:** replace the current Goal Runs/Loop Runs experience and engine
outright. The v1 implementation has no active users and no run history worth
preserving, so backwards compatibility is a non-requirement.

## 1. Decision summary

Loops should become Codekin's **durable control plane for outcome-driven agent
work**. A user states an outcome and success criteria; Codekin turns them into
an inspectable plan, runs the work in checkpoints, evaluates evidence, and
either continues, asks for a bounded decision, or stops with a clear reason.

This is not a visual refresh of the evidence ledger. The rewrite adds:

1. durable pause/resume and crash recovery;
2. an explicit plan that may be revised without losing history;
3. composable evaluators (commands, diff policy, artifacts, CI, and reviewer);
4. first-class intervention: pause, steer, approve, retry, skip, and stop;
5. structured events and artifacts rather than output tails;
6. reusable recipes with a guided builder and preflight;
7. run comparison and opt-in lessons from previous runs;
8. parallel workers only where work is provably independent;
9. risk-, time-, token-, cost-, and no-progress-based controls.

The current maker → shell verifier → optional checker loop remains a valid
simple recipe *shape*, but nothing about the v1 implementation — engine, API,
schema, or UI — is preserved.

## 2. Why rewrite it

### What Codekin has today

The current implementation is a sound first vertical slice:

- isolated worktree and agent session;
- deterministic shell verification;
- optional separate-provider checker;
- turn and dollar limits;
- readonly globs, no-change detection, and an audit ledger;
- commit/push/PR finalization;
- repo-local Markdown templates.

The UI, however, exposes only a template picker, free-text repo and branch,
optional goal override, a flat run list, and turn rows. The engine marks all
in-flight work aborted after a Codekin restart. A turn is the main unit of state,
plans are implicit in chat, verification is only an ordered command list, and
the user can only open the maker session or abort.

None of this is in active use: there are no historical runs or third-party
templates to preserve, which is why replacement is cheaper and safer than
evolution.

### Resulting product problems

- Users cannot understand the intended path before spending begins.
- “Running” does not answer what is happening, why, or what happens next.
- A blocked run makes the user leave Loops to find and operate a raw session.
- Long work is fragile across restarts and provider interruptions.
- One failing command is treated much like any other; failures lack ownership,
  classification, retry policy, and targeted evidence.
- The checker reviews the final diff, but cannot express weighted criteria or
  distinguish correctness, scope, security, and maintainability.
- Templates are powerful but effectively author-only: discovery, editing,
  validation, and previews are missing.
- The ledger is auditable but not diagnostic: it stores output tails rather
  than a navigable trace with artifacts and causality.
- Runs do not improve future runs and cannot be compared meaningfully.

## 3. Research synthesis

The common direction across current agent frameworks and recent practitioner
reports is a **bounded state machine around the model**, not an unconstrained
prompt loop.

### Primary-source findings

- Prefer the simplest workflow that fits; use evaluator–optimizer loops when
  criteria are clear and iteration has measurable value. Anthropic explicitly
  separates predictable workflows from flexible agents and describes the
  evaluator–optimizer pattern. [Anthropic: Building Effective Agents](https://www.anthropic.com/engineering/building-effective-agents)
- Durable agents checkpoint explicit state. LangGraph documents step-level
  checkpoints for fault tolerance, human intervention, replay, and forks, plus
  persisted writes so already-successful parallel work is not repeated.
  [LangGraph persistence](https://docs.langchain.com/oss/python/langgraph/persistence)
- Human intervention is a resumable state transition, not a terminal error.
  Both LangGraph and OpenAI serialize state, expose pending decisions, and
  continue the same run after approval or edits.
  [LangGraph interrupts](https://docs.langchain.com/oss/python/langgraph/interrupts),
  [OpenAI Agents SDK HITL](https://openai.github.io/openai-agents-python/human_in_the_loop/)
- Resumable workflows require replay-safe boundaries and idempotent side
  effects. [LangGraph functional API](https://docs.langchain.com/oss/python/langgraph/functional-api)
- Observability is moving from transcripts to traces of model calls, tools,
  handoffs, guardrails, and custom spans.
  [OpenAI Agents SDK tracing](https://openai.github.io/openai-agents-python/tracing/)
- Production agent SDKs now expose explicit max-turn limits, input/output/tool
  guardrails, context shaping, and durable runtime integrations rather than
  treating them as prompt conventions.
  [OpenAI Agents SDK runner](https://openai.github.io/openai-agents-python/running_agents/)

### TubeGraph findings

TubeGraph returned strong retrieval evidence from **18 videos across 13
channels**, published 2026-06-29 through 2026-08-26, with no invalid citations
and a 13% top-channel concentration. These are practitioner claims from video
transcripts, not independently established facts.

- A Spotify engineering account calls automated tests and a robust verification
  loop the most important prerequisite for safe autonomous merges.
  [Claude/Spotify, 2026-06-29](https://www.youtube.com/watch?v=9DHZLw5653E&t=735s)
- A benchmark team describes combining deterministic tests with flexible LLM
  judges, using a validation agent to translate expert specifications into
  scalable checks.
  [YC Paper Club, 2026-08-20](https://www.youtube.com/watch?v=IfoPg2QefF8&t=1158s)
- Recent harness discussion emphasizes explicit context ownership, structured
  tool outputs, and agents behaving like reducers over external state.
  [The Pragmatic Engineer, 2026-07-15](https://www.youtube.com/watch?v=Usufn8IQJgw&t=1075s)
- Higher-level controllers are being used to decompose and supervise smaller
  subtasks. [Level1Techs, 2026-08-21](https://www.youtube.com/watch?v=tmcn1-jFLWY&t=395s)
- Real execution logs are proposed as feedback for improving evaluation
  environments and task difficulty.
  [YC Paper Club, 2026-08-20](https://www.youtube.com/watch?v=IfoPg2QefF8&t=2065s)
- Greater autonomy also creates supervision overload and unintended scope
  expansion; one team reports agents turning small changes into hours of new
  decisions. [SaaStr AI, 2026-08-05](https://www.youtube.com/watch?v=u-LAHVbpIas&t=286s)
- Practitioners therefore argue for kill switches, identity controls, and strict
  policy enforcement at runtime.
  [20VC, 2026-08-06](https://www.youtube.com/watch?v=Q6kDZJ0xdSw&t=1957s)

**Product inference:** Codekin should preserve deterministic verification as
the authority for machine-checkable claims, add rubric-based review for
qualities tests cannot express, and make state, control, and evidence visible.
It should not imply that a checker or the agent's own test execution replaces
independent CI.

## 4. Product model

### Terminology

- **Recipe:** versioned reusable definition of goal inputs, policy, stages,
  evaluators, budgets, and completion behavior. Replaces “template” in the UI.
- **Loop:** configured intent: recipe + repository + inputs + policy overrides.
- **Run:** one execution of a loop against a frozen recipe version and base SHA.
- **Stage:** durable unit in the run graph, such as plan, act, evaluate, review,
  checkpoint, or finalize.
- **Attempt:** one execution of a stage.
- **Evaluator:** produces a structured result and evidence against one criterion.
- **Checkpoint:** persisted, resumable state boundary.
- **Intervention:** a request or user action that changes the future trajectory.
- **Artifact:** retained output such as a plan, diff, test report, log, review,
  screenshot, coverage report, commit, or PR.

### Core loop

```text
define → preflight → plan → act → evaluate → decide
                         ↑         │         │
                         └─ revise ┴─ steer ─┘
                                           │
                       finalize ← approve ─┘
```

The decision node is deterministic code. It considers evaluator results,
policy, progress, budgets, risk, and pending intervention. The model may propose
a next action or plan revision but must not decide whether its own acceptance
criteria passed.

### Modes

| Mode | Behavior | Default use |
|---|---|---|
| Guided | Approve plan and high-risk actions; approve completion | unfamiliar or high-risk work |
| Guarded | Auto-run low-risk stages; interrupt on policy/risk/ambiguity | default |
| Autonomous | Run to a policy boundary; notify at milestones | trusted, well-tested recipes |

Mode is shorthand for an editable policy. It is never a bypass around hard
repository or organization guardrails.

## 5. User experience

### 5.1 Loops home

Replace the two-pane ledger with an operations view:

- summary strip: active, needs attention, succeeded/failed last 7 days, spend;
- sections: **Needs attention**, **Active**, **Recent**;
- filters: repo, recipe, initiator, status, mode, provider, date;
- run row shows outcome label, current stage and step, elapsed time, progress,
  last meaningful event, spend/budget, and required action;
- primary actions: New loop, Resume/Review attention, Pause all;
- recipes tab: built-in/repo/user recipes, validation state, version, run history.

Status language must be user-facing: “Implementing step 2 of 4”, “Tests failed;
repairing”, “Waiting for approval to change workflow”, not merely `running`.

### 5.2 New loop wizard

1. **Outcome:** natural-language goal or choose a recipe.
2. **Scope:** repository picker, base branch picker, optional issue/PR, allowed
   and protected paths. Never require users to type an absolute path.
3. **Success:** suggested checks discovered from package scripts, CI config,
   changed area, and recipe; user can add/remove/reorder criteria.
4. **Control:** Guided/Guarded/Autonomous, provider/model policy, time/cost/token
   limits, completion action.
5. **Preflight:** validate clean base, credentials, provider availability,
   commands, estimated risk, and show the exact effective recipe.

The final button says what will happen: “Start in isolated worktree; open PR
after approval.” Saving as a recipe is optional after a successful run.

### 5.3 Run workspace

Use a stable header plus four tabs:

- **Overview:** outcome, current stage, plan checklist, acceptance scorecard,
  budget/time, diff summary, and next action.
- **Timeline:** causally ordered trace grouped by stage and attempt. Collapse
  noisy tool/model events; stream live; filter by errors, decisions, or agent.
- **Changes:** file tree and diff by checkpoint, commits, artifacts, and PR/CI.
- **Context:** frozen recipe, effective policy, input sources, learned context,
  and provider/model versions.

Persistent controls:

- Pause after current safe boundary;
- Stop now (kill switch);
- Steer with an instruction, optionally “revise plan first”;
- Approve/reject/edit a pending action in place;
- Retry failed stage, skip optional stage, or roll back to a checkpoint;
- Fork from checkpoint as a new run;
- change remaining budget within organization caps.

Every control creates an event containing actor, timestamp, reason, previous
state, and resulting state.

### 5.4 Attention inbox

An intervention card must contain:

- one-sentence decision needed;
- why the run cannot decide safely;
- proposed action and exact diff/tool arguments where applicable;
- risk and affected resources;
- evaluator evidence already collected;
- options: approve, edit then approve, reject with guidance, stop;
- whether and when a default/timeout policy applies.

No approval should be hidden only inside the underlying maker session.

### 5.5 Completion

The completion view answers:

- Did the requested outcome pass each criterion?
- What changed, and what was deliberately not changed?
- What evidence supports success?
- How much time/cost/tokens/turns were used?
- Which interventions and plan revisions occurred?
- Where is the commit/PR, and what is CI doing?
- What lesson is suggested for this recipe?

“Succeeded with warnings” is distinct from “succeeded”; an evaluator waived by
a user remains visible and prevents an unqualified green result.

## 6. Recipe format v2

Continue using Markdown + YAML so definitions remain reviewable in git. Freeze
the normalized recipe and its content hash into every run.

```yaml
---
apiVersion: codekin.dev/v2
kind: LoopRecipe
metadata:
  id: ci-repair
  name: Repair failing CI
  description: Diagnose and repair the current branch without weakening tests.
inputs:
  issue:
    type: string
    required: false
agent:
  provider: auto
  modelClass: coding-frontier
  skills: [repo-discovery, test-debugging]
plan:
  required: true
  approval: risk-based
workspace:
  strategy: worktree
  allowedPaths: ["**"]
  protectedPaths: [".github/workflows/**"]
evaluators:
  - id: tests
    type: command
    command: npm test
    timeout: 10m
    required: true
    retry: { maxAttempts: 2, on: [infra_error] }
  - id: lint
    type: command
    command: npm run lint
    required: true
  - id: scope
    type: diff-policy
    noTestWeakening: true
    protectedPaths: [".github/workflows/**"]
  - id: review
    type: rubric
    provider: different-from-maker
    criteria:
      correctness: { weight: 5, threshold: 4 }
      scope: { weight: 3, threshold: 3 }
budgets:
  wallTime: 45m
  turns: 12
  costUsd: 5
  tokens: 500000
  noProgressAttempts: 3
policy:
  mode: guarded
  approvalRequiredFor: [protected_path, network_write, secret_access]
  maxParallelWorkers: 2
completion:
  action: pull-request
  requireHumanApproval: true
---
{{ goal }}
```

Required design rules:

- command evaluators use argument arrays internally; shell strings are accepted
  as authoring convenience and visibly labeled as trusted repository code;
- secrets are references, never embedded recipe values;
- provider `auto` resolves at run start and the resolution is recorded;
- unknown fields fail validation; recipe versions are immutable once referenced.

## 7. Evaluation and decision policy

### Evaluator types for v2

1. `command`: exit code plus structured stdout/stderr artifact.
2. `test-report`: parse JUnit/TAP/Vitest and show failing tests and deltas.
3. `diff-policy`: protected paths, generated files, max change size, secret scan,
   dependency and test-weakening policies.
4. `artifact`: require a file/report/screenshot/schema and validate its shape.
5. `ci`: wait for named remote checks at the pushed SHA.
6. `rubric`: independent model scores named criteria and cites diff evidence.
7. `human`: explicit sign-off for subjective or high-impact criteria.
8. `composite`: all/any/weighted expression over evaluator results.

Evaluator output:

```ts
type EvaluationResult = {
  evaluatorId: string
  status: 'pass' | 'fail' | 'warning' | 'error' | 'waived'
  classification?: 'code' | 'test' | 'environment' | 'policy' | 'ambiguous'
  summary: string
  evidenceArtifactIds: string[]
  fingerprint?: string
  retryable: boolean
  durationMs: number
  costUsd?: number
}
```

### Deterministic decision order

1. hard policy violation → pause/rollback/stop according to policy;
2. user stop/pause → reach safe boundary and persist;
3. required evaluator error → retry if classified transient, otherwise ask;
4. required evaluator failure with remaining progress budget → repair stage;
5. repeated fingerprint/no material diff → replan, then ask after threshold;
6. all required evaluators pass → review/completion gate;
7. budget boundary → ask for bounded extension or stop with partial result.

The no-progress detector compares diff hash, failing-evidence fingerprints,
plan state, and repeated tool errors. Merely producing more text is not progress.

## 8. Durable runtime architecture

Implement an event-sourced state machine on the existing SQLite run database.
SQLite remains appropriate for a single Codekin instance; keep the orchestration
interfaces storage-agnostic for a future server deployment.

### State graph

```text
draft → preflight → planning → awaiting_plan_approval → executing
                                      ↑                 ↓
                         replanning ← evaluating → reviewing
                              ↑             ↓           ↓
                         awaiting_input / awaiting_approval
                                            ↓
                       finalizing → monitoring_ci → completed

Any active state → pausing → paused → previous resumable state
Any active state → canceling → canceled
Unexpected failure → recovering → previous checkpoint | failed
```

“Blocked” becomes a reason attached to a wait state, not an overloaded status.
Terminal results are `completed`, `completed_with_warnings`, `failed`, and
`canceled`; outcome and execution state are stored separately.

### Persistence

Add these logical tables (names may follow existing migration conventions):

- `loop_recipes`, `loop_recipe_versions`;
- `loop_runs` (effective policy, recipe hash, base SHA, state, outcome);
- `loop_stages` and `loop_attempts`;
- `loop_events` (append-only, monotonic sequence per run);
- `loop_checkpoints` (serialized orchestration state and replay cursor);
- `loop_evaluations`;
- `loop_artifacts` (metadata; large bodies stored on disk by content hash);
- `loop_interventions`;
- `loop_usage` (provider/model/token/cost/duration dimensions);
- `loop_lessons` (suggested/approved/rejected, scoped to recipe or repo).

Persist a checkpoint before and after every side-effecting stage. Side effects
receive an idempotency key `{runId}:{stageId}:{attempt}`. On startup, acquire a
run lease, reconcile sessions/worktrees/commands, and resume from the last
checkpoint. Never blanket-fail active runs after restart.

### Execution adapters

Separate orchestration from provider sessions:

- `AgentExecutor`: start/resume/interrupt/cancel; streams structured events;
- `Workspace`: create/snapshot/diff/rollback/finalize;
- `Evaluator`: execute and return `EvaluationResult`;
- `PolicyEngine`: risk classification and approval decision;
- `ArtifactStore`: content-addressed retention/redaction;
- `EventBus`: one ordered run stream to UI, MCP, and notifications.

Use one orchestrator-owned worktree. Parallel workers get isolated child
worktrees and declared path scopes; integration is a separate deterministic
stage. Start with sequential execution. Enable parallelism only after durable
stages and merge-conflict handling are proven.

### Context contract

Each agent invocation receives a generated context bundle, not the full ledger:

- immutable outcome, acceptance criteria, and policy;
- current plan and assigned step;
- relevant repository instructions and approved lessons;
- latest diff summary and evaluator failures;
- remaining budgets;
- explicit expected structured result.

Store the bundle hash and source artifact IDs. Summarization never replaces raw
evidence; it only creates a derived artifact. Do not replay irrelevant chat by
default.

## 9. API and events

Introduce `/api/loops`; `/api/goal-runs` is removed in the same release, with
no dual-API window.

Minimum REST surface:

```text
GET    /recipes
POST   /recipes/validate
GET    /recipes/:id/versions/:version
POST   /runs/preflight
POST   /runs
GET    /runs
GET    /runs/:id
GET    /runs/:id/events?after=<sequence>
GET    /runs/:id/artifacts/:artifactId
POST   /runs/:id/pause
POST   /runs/:id/resume
POST   /runs/:id/cancel
POST   /runs/:id/steer
POST   /runs/:id/interventions/:interventionId/resolve
POST   /runs/:id/stages/:stageId/retry
POST   /runs/:id/checkpoints/:checkpointId/fork
POST   /runs/:id/budgets
```

WebSocket/SSE events share one envelope:

```ts
type LoopEvent<T> = {
  runId: string
  sequence: number
  type: string
  at: string
  actor: { type: 'user' | 'system' | 'agent'; id?: string }
  stageId?: string
  attemptId?: string
  payload: T
}
```

Clients reconnect with the last sequence, fetch the gap, then continue live.
Payload schemas are versioned. Sensitive model/tool content is redacted before
persistence and event delivery.

Expose MCP tools for list/get/start/pause/resume/cancel/steer/resolve, using the
same service layer and policy checks as REST.

## 10. Safety model

- Deny by default outside the declared workspace and tool capability set.
- Classify every tool call as read, workspace-write, external-write,
  credentialed, destructive, or irreversible.
- Require approval by action/risk, not by provider-specific prompt behavior.
- Fail closed when tool arguments cannot be parsed or risk cannot be determined.
- Keep credentials brokered and scoped; agents receive capability handles, not
  durable secret values.
- Preserve an immediate kill switch that cancels providers and child processes,
  revokes leases, and retains the recoverable worktree.
- Run untrusted repo commands in the strongest sandbox available and show the
  effective sandbox level during preflight.
- Apply retention/redaction settings separately to traces, logs, and artifacts.
- Completion actions are explicit: commit, PR, or merge. Merge is never implied
  by an “autonomous” mode and must respect repository policy.

## 11. Learning without unsafe self-modification

After completion, a reflection stage may suggest:

- a missing evaluator;
- better repo context;
- a refined plan pattern;
- a command or failure classification;
- a budget adjustment.

Suggestions are evidence-linked and start as `suggested`. A user may approve
them into a new recipe version or repo-scoped lesson. Agents cannot silently
rewrite recipes, policies, prompts, or their own evaluator. Show subsequent
runs whether an approved lesson was used and support A/B comparison by recipe
version.

## 12. Replacement plan

v1 is deleted, not migrated:

- remove the v1 engine (`goal-run-controller`, `goal-run-finalizer`), store,
  routes (`/api/goal-runs`), and `LoopRunsView` as their v2 equivalents ship;
- drop the `goal_runs` and `goal_run_turns` tables — the v2 schema is created
  fresh in its final shape, free of additive-migration constraints;
- rewrite the built-in templates (`ci-autorepair`, `coverage-increase`,
  `dependency-upgrade`) directly in recipe v2 format. The conceptual mapping
  when rewriting: maker → agent, checker → rubric evaluator with a
  different-provider constraint, verify[] → required command evaluators,
  readonly[] → protected paths, maxTurns/maxCostUsd → budgets,
  completionPolicy → completion.action;
- no normalization layer, no legacy run renderer, no dual-API window.

### Delivery phases

**Phase 1 — durable engine core**

- Run/stage/attempt/event/checkpoint schema, leases, idempotency keys, and
  startup recovery; sequential execution only.
- Recipe v2 loader with strict validation; command evaluators with structured
  results and artifacts.
- Event envelope, `/api/loops` REST surface, and resumable event stream.

**Phase 2 — usable control plane**

- New home, wizard with real repo/branch pickers and recipe discovery, run
  workspace, inline intervention cards.
- Pause, resume, steer, cancel; plan artifact and plan approval/revision.

**Phase 3 — evaluator platform and CI**

- Retry policies, error classification, no-progress detection, wall-time and
  token budgets.
- Test parsers, diff policy, rubric, artifact, human, composite, remote CI.
- Completion scorecard and qualified outcomes.

**Phase 4 — controlled concurrency and learning**

- scoped parallel child worktrees and deterministic integration.
- checkpoint forks, run comparison, approved lessons, recipe experiments.

Each phase ships behind `loopsV2` and ends in a runnable vertical slice (Phase
1 is exercisable via API before the UI exists). Phase 1 must be stable before
parallel work.

## 13. Success metrics

Primary:

- percentage of started runs that achieve all required criteria;
- percentage of completed PR runs whose required remote CI remains green;
- median human attention minutes per successful run;
- percentage of active runs recovered after Codekin restart;
- rate of unintended protected/external actions (target: zero).

Diagnostic:

- preflight failure and abandonment rate;
- time to first meaningful code change;
- evaluator failure-to-repair rate by classification;
- no-progress and replan rates;
- interventions per run and median response latency;
- cost/time/tokens per accepted outcome;
- checker reversal and human waiver rates;
- recipe/version success and regression rates.

Do not optimize raw turn count, code volume, or agent activity; they reward busy
loops rather than outcomes.

## 14. Acceptance criteria for the rewrite

1. A new user can start a guarded CI-repair loop without typing a filesystem
   path or authoring YAML.
2. Before start, the user sees the effective scope, checks, risk policy, budget,
   sandbox, and completion action.
3. At any moment the run page explains current work, current plan, evidence,
   remaining budget, and the next transition.
4. Codekin can be killed during planning, execution, evaluation, or approval;
   after restart it reconciles and resumes without duplicating completed side
   effects.
5. Approval and clarification can be completed inside the Loops workspace.
6. Pause, resume, steer, cancel, retry, rollback, and fork produce durable,
   auditable events.
7. Required evaluators cannot be marked passed by the maker; waivers remain
   explicit and change the qualified outcome.
8. Identical failures with no material progress trigger replan and eventually a
   bounded human decision rather than consuming the entire budget silently.
9. The completion report links every acceptance criterion to retained evidence.
10. Once `loopsV2` is the default, no v1 code path (engine, routes, tables,
    views) remains reachable.

## 15. Explicit non-goals for the first release

- a free-form visual DAG editor;
- arbitrary user-authored executable evaluator plugins in the UI;
- autonomous production deployment;
- automatic merge merely because local checks pass;
- unrestricted swarms or agent-to-agent chat;
- silent self-editing of recipes or policies;
- cross-organization shared memory.

## 16. Open decisions

1. Should the v2 runtime remain an in-process state machine initially, or use an
   embedded durable workflow runtime? Recommendation: keep an internal adapter
   boundary and implement SQLite-backed orchestration first to reduce migration
   risk, benchmarking recovery before adopting another operational dependency.
2. What sandbox guarantees can Codekin provide per operating system? The wizard
   must state the actual level, not a generic “isolated” claim.
3. Which provider exposes sufficiently stable resumable state? Where it does
   not, resume at a Codekin stage boundary with a regenerated context bundle.
4. Which remote CI providers are in the first adapter set? GitHub Checks is the
   natural first target given current PR finalization.
5. Should recipe edits live only in repo files or also in Codekin? Recommendation:
   support user drafts in Codekin, but make promotion to team use an explicit
   repository commit.
