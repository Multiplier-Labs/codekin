# Agent Joe: repo collaboration, maintenance, and automation management

Status: Implemented (released in v0.9.2). Delivery slices 1–4 (§12) shipped as #702 (collaboration
in sessions), #698 (workflow management tools) and #703 (maintenance, observation → action).
Agent Joe does not run on Grok Build yet.
Date: 2026-09-30

## Purpose

Repo sessions are the primary place to work with Joe. Tasks provides oversight of
delegated work. Every repo explicitly shows whether Joe maintains it, what it
watches, what it may do, and whether that coverage is working.

This proposal supersedes the separate Joe Chat / Tasks navigation proposed in
[JOE-TASKS-SPEC.md](./JOE-TASKS-SPEC.md). It extends that document's durable task,
decision, execution, and review model. It was written as a target design; see
[Implementation notes](#15-implementation-notes) for where the shipped behaviour differs.

## 1. Product model

| Concept | Meaning |
| --- | --- |
| Session | A conversation about work in a repo. |
| Task | Durable work with an owner, status, acceptance criteria, and results. |
| Maintenance plan | Standing instructions describing what Joe watches and how it may respond. |
| Responsibility | One scoped obligation within a maintenance plan. |
| Workflow definition | The instructions and execution configuration for a reusable automation. |
| Repo automation | A configured use of a workflow in a repo, with a schedule or event trigger. |

A repo can have sessions and delegated tasks without ongoing maintenance. Enabling
maintenance requires an explicit plan. Joe's context and authority are scoped to
the repo and request.

Maintenance responsibilities link to existing repo automations where applicable.
They do not introduce a second scheduling engine or duplicate an existing check.

## 2. Navigation and surfaces

Remove the standalone Agent Joe chat entry. Introduce Tasks as the global view of
delegated work. Preserve historical Joe conversations as accessible history.

| Surface | Contents |
| --- | --- |
| Repo session | Coding conversation, messages to Joe, linked tasks, decisions, and results. |
| Tasks | Cross-repo work, repo filters, and sections for decisions, review, running, queued, and closed work. |
| Repo maintenance | Responsibilities, monitoring health, current actions, recent activity, and controls. |
| Automations | Existing workflow configuration and execution details, linked from maintenance. |

Show a maintenance indicator beside each repo name. Selecting it opens the repo's
maintenance view. Tasks includes a compact repo overview showing maintained,
paused, and unhealthy repos. Selecting a repo filters its tasks and exposes its
maintenance details.

For the first version, Tasks provides structured controls and New task without a
general-purpose chat composer.

## 3. Talking to Joe in a repo session

Keep one composer. Ordinary messages go to the session's coding agent. An Ask Joe
action or leading `@Joe` addresses Joe explicitly. The recipient is visible before
sending; after a Joe message, the composer returns to the coding agent.

Examples:

- "@Joe, supervise this fix through to a verified PR."
- "@Joe, turn the remaining findings into tasks."
- "@Joe, what are you monitoring in this repo?"
- "@Joe, run the security review every Monday morning."

Joe receives the repo, originating session, relevant conversation context, and
referenced tasks. It can retrieve additional context from that session. Unrelated
session transcripts are not automatically included. Responses appear in the same
conversation, clearly attributed to Joe.

A question can receive a simple answer. A request to perform execution work
creates or links a durable task. Configuration changes create an auditable change
record and, when implementation is needed, a linked task. Joe does not ask users
to repeat details already agreed in the conversation.

## 4. Ownership and handoffs

Each execution attempt has one controller. Joe and the interactive coding agent
must not independently drive the same attempt.

When asked to supervise work already underway, Joe links the existing session and
task instead of immediately spawning duplicate work. Taking over requires an
explicit handoff, such as Hand over to Joe. An unambiguous user instruction to
hand over is sufficient; no redundant confirmation is required.

The session displays:

> Supervised by Joe · Task: Fix login redirect
>
> Joe is coordinating this execution. **Take back control**

Taking back control prevents further Joe instructions to that execution. The
task and its history remain. Ownership changes must fence queued instructions
from the former controller as well as new instructions.

Independent delegated work may run in a separate execution session. Its task card
links both to the originating conversation and to the execution session.

## 5. Tasks, decisions, and updates

Extend existing tasks with links to the originating session and request, any
maintenance responsibility, the source finding/event, and execution attempts.

Distinguish queued from running. A task is running only when an execution attempt
is active. Answering a question or requesting a start must not prematurely imply
execution. The implementation may use an execution substate while preserving
existing task statuses and API compatibility.

Joe posts meaningful milestones into the originating conversation:

- Work accepted and linked.
- A decision needed.
- A material blocker or failure.
- A result ready for review.

Routine progress stays on task cards and activity history. Chat and Tasks render
the same decision record. Answering in either place resolves it everywhere;
concurrent or stale answers cannot trigger duplicate execution.

Maintenance-generated work has no originating conversation by default. Updates
live in Tasks and repo maintenance activity. Discuss in session opens or links a
repo session with the task context. Archived origins do not prevent task updates;
Tasks remains the durable destination and history preserves the origin link.

## 6. Explicit maintenance state

Separate configured state from operational health.

| Configured state | Meaning |
| --- | --- |
| Off | No standing maintenance mandate; individual tasks remain possible. |
| Enabled | Joe is assigned the configured responsibilities. |
| Paused | Plan retained; automatic checks and new maintenance dispatch suspended. |

| Health | Meaning |
| --- | --- |
| Starting | Coverage has not yet been verified. |
| Healthy | Enabled responsibilities operate within expected timing. |
| Degraded | Some responsibilities have failed or are overdue. |
| Unavailable | A shared dependency, scheduler, or required access prevents coverage. |

Labels combine these facts: Joe maintaining, Maintenance starting, Maintenance
needs attention, Maintenance paused, or Not maintained. An enabled plan with no
enabled responsibilities cannot display healthy active maintenance.

A repo is never labelled maintained merely because Joe remembers it, has worked
there, has an open session, or sees an independently configured automation.

## 7. Responsibility configuration

Each responsibility records:

| Field | Example |
| --- | --- |
| Name | Investigate failures on main |
| Scope | CI runs on the default branch |
| Trigger | Each completed CI run |
| Linked automation or source | Repo automation ID or supported monitoring adapter |
| Response policy | Investigate and open a fix PR |
| Limits | One active investigation per failure; bounded execution budget |
| Required decision | Changes outside agreed scope |
| Latest observation | Main failed at commit abc123 |
| Last successful check | Timestamp |
| Next expected check | Timestamp or named event |
| Health | Healthy |

Response policies:

- Notify: record the finding and bring it to the user's attention.
- Propose work: create a proposed task requiring the user to start it.
- Investigate: authorize diagnosis and a recommendation.
- Implement: authorize a bounded fix through a verified PR.

Policies remain subject to repo permissions and do not grant merge, deployment,
or host-operation authority. Only functioning integrations can be enabled.
Unsupported capabilities must not appear as active coverage.

## 8. Enabling, pausing, and stopping maintenance

Enable maintenance presents supported responsibilities and scopes, response
policies, concurrency/execution limits, and a review of the resulting mandate.
Joe may prepare this configuration from chat and display an inline review card.
A casual request to fix something never silently enrolls the repo.

Pause maintenance prevents new automatic checks and task dispatch governed by
the plan. Already running work continues, with the UI stating how many tasks will
finish. Stop running work is a separate action. Decisions and review results
remain available, and manually requested work can still run.

Resuming reconciles current conditions without producing duplicate tasks for
events received during the pause. Turning maintenance off stops future governed
dispatch and retains task, configuration-change, and activity history.

Independent automations retain their own controls. Linking an independent
automation for observation does not transfer control. Adopting it into Joe's
maintenance plan explicitly changes its management ownership. The UI explains
which automations pause with Joe and which continue independently.

## 9. Observable monitoring and activity

The maintenance view answers three questions:

| Question | Display |
| --- | --- |
| What is Joe watching? | Scope, trigger, last successful check, next expected check, and health. |
| What is Joe doing? | Task, triggering reason, execution status, and links. |
| What happened? | Findings, actions, outcomes, failures, and successful checks without findings. |

A successful check with no findings records No issues found. A failed check
records Check failed. Missing evidence is Unknown, never healthy. Coverage health
is distinct from repo condition: detecting a real CI failure may prove the
monitor is healthy while identifying a repo problem requiring action.

Scheduled checks define an overdue threshold. Event-driven checks expose
connection or reconciliation health. A quiet event stream does not prove
coverage. Activity-based schedule holds must be visible, with the reason and
effective next check; a held check must not masquerade as timely coverage.

Coverage failures create a deduplicated attention item with a recovery action.
Repeated failures update that item instead of flooding chat. Completed clean
checks remain inspectable in activity without generating routine chat messages.

## 10. First-class workflow management

### Implementation before this spec

Joe exposed `trigger_workflow` and `list_runs`. The backend provided schedule CRUD
and repo automation configuration CRUD, but these operations were not exposed as
dedicated Joe MCP tools. Repo workflow definitions live in
`.codekin/workflows/*.md`; changing them requires repo file changes.

Relevant implementation:

- `server/codekin-mcp-server.ts` and `server/codekin-mcp-api.ts`: tool surface.
- `server/orchestrator-manager.ts`: Joe instructions and allowed tool names.
- `server/workflow-routes.ts`: schedules and repo automation configuration.
- `server/workflow-loader.ts`: built-in and repo workflow definitions.

The existing curl fallback is not the intended product interface. This proposal
requires typed tools backed by the existing services and scheduler.

### Required capabilities

The following are proposed tool contracts; names may be aligned with existing
conventions during implementation.

| Tool | Responsibility |
| --- | --- |
| `list_workflows` / `get_workflow` | Discover effective definitions for a repo, source, overrides, and editable fields. |
| `list_repo_automations` / `get_repo_automation` | Read configured workflow, trigger, management owner, enablement, and maintenance links. |
| `create_repo_automation` | Configure an existing validated workflow for a repo and its trigger. |
| `update_repo_automation` | Change schedule, event filters, supported settings, or enablement. |
| `remove_repo_automation` | Remove future configured execution while preserving historical runs. |
| `get_automation_health` | Inspect last success, failures, effective next run, and scheduler/source health. |
| `get_automation_trigger_history` | Explain why an automation ran, was held, or did not run. |
| `validate_workflow` | Validate a proposed definition and report errors before activation. |

Keep `trigger_workflow` and `list_runs`. Triggering must return a durable run link.
Inspection should expose schedule details; mutation should normally address the
repo automation so configuration and derived schedules stay synchronized.

Every mutation requires repo scope, an idempotency key, and an expected revision
for updates/removal. The server validates permissions, workflow availability,
trigger syntax, and supported options. Stale changes return a conflict rather
than overwriting newer configuration.

### Editing definitions versus configuring execution

Changing when a known workflow runs is a configuration operation. Changing its
prompt or behavior is a definition change. Joe must explain which it is doing.

For new or modified repo definitions, Joe delegates file changes to a coding
session, links the task, and validates the result. Activation occurs only after
the approved definition is available in the repo location used by the loader.
A definition in an unmerged worktree must not be reported as active production
coverage. Record the effective definition revision/hash for each run.

Built-in definitions are not edited globally to satisfy one repo's request. Use
an explicit repo override or a new repo definition and display its source.

Removing an automation removes its configured trigger, not its workflow file or
historical runs. Deleting a repo definition is a separate repo change. Refuse
deletion while configurations still reference it unless the same operation
explicitly resolves those dependencies. Removing an override must disclose if a
built-in definition will become effective again.

### User interaction and authority

For a clear request within granted authority, Joe applies the change and returns
the resulting configuration with a link. Do not add redundant confirmation.
When scope or authority is missing, show a concrete proposed change and request
the necessary decision before activation.

Examples:

- "Run the security review every Monday at 09:00": configure the selected repo,
  using its displayed timezone; clarify only if no timezone is established.
- "Make this weekly instead of daily": update the referenced automation and
  report its next effective run.
- "Stop the dependency check": disable it and retain its configuration/history.
- "Remove this automation": remove future execution and retain history.
- "Change the review to focus on authentication": delegate and validate a
  definition change, then report when it becomes effective.

Display timezone, next effective run, and any activity-based hold. Disabling or
removing an automation does not cancel an existing run; show running work and
offer its separate stop control.

All changes record actor, reason, before/after configuration, time, authorization
source, and originating session or task. Joe cannot expand its own permissions.

### Relationship to maintenance

A responsibility may link multiple checks, and an existing automation may serve
multiple responsibilities. Preserve stable references and avoid duplicate
schedules. Disabling/removing a referenced automation must identify affected
responsibilities and update their coverage state in the same operation.

Automation edits made through the existing Automations UI must immediately
update maintenance coverage. Joe and the UI use the same configuration service.
Pause is a dispatch gate for governed automations, not a destructive rewrite of
each automation's enabled setting; resume preserves prior individual settings.

## 11. Persistence, routing, and enforcement

Reuse durable tasks, child execution links, decisions, the outbox, workflow
configuration, and the scheduler. Add persisted records for:

- Maintenance plans and versioned responsibilities.
- Responsibility-to-automation/source links and management ownership.
- Check runs, observations, source-event identifiers, and health evidence.
- Task provenance and originating-session/request links.
- Execution ownership and revisioned handoffs.
- Automation change history and durable destination-specific update delivery.

The backend enforces repo scope, permissions, ownership, plan state, and dispatch
limits. Prompt instructions alone are insufficient. Reads and deterministic
checks do not require Joe's conversational process to be running. Wake Joe when
interpretation or action is needed; opening a view must not initiate work.

Task creation and delivery tolerate retries/restarts without duplicate execution
or messages. Repeated observations of one unresolved problem update its existing
finding/task. Recover source cursors, pending dispatch, and notification state
after restart. Reconcile events with current task/configuration revisions before
acting on them.

## 12. Delivery and migration

1. Move collaboration into sessions: addressed messages, task provenance, inline
   decisions/results, Tasks navigation, and explicit execution handoff.
2. Add workflow management tools over existing services: discovery, configuration
   mutations, validation, health, trigger history, and configuration audit trail.
3. Make maintenance explicit: persisted plans, enrollment, automation ownership
   and links, repo indicators, pause/resume, and evidence-based coverage health.
4. Connect observations to bounded action: response policies, deduplication,
   dispatch limits, and recovery behavior.

Preserve existing tasks, execution links, and Joe conversation history. Do not
infer maintenance from the current managed-repo count, remembered repos, workflow
configuration, or prior child work.

Inventory existing automations and monitoring behavior during migration. Present
existing automations as independently managed until explicitly adopted. Existing
implicit Joe monitoring needs a visible migration state and explicit disposition;
it must neither silently gain new authority nor silently disappear. Release the
maintenance badge only when this migration and health evidence are in place.

## 13. Acceptance criteria

- Users delegate in a repo session and receive results there without separate Joe chat.
- Message recipient and execution controller are visible.
- Joe cannot duplicate or silently take control of interactive work.
- Users can identify all maintained repos and inspect their exact responsibilities.
- Missing, stale, or failed coverage cannot display a healthy maintenance badge.
- Every automatic action links to its observation and authorizing responsibility.
- Joe can discover, create, edit, disable, and remove repo automation configuration
  through dedicated tools, with changes visible in the existing Automations UI.
- Definition changes are validated and only reported active when the effective
  runtime definition has changed.
- Configurations, derived schedules, maintenance links, and health remain consistent
  after changes through either Joe or the UI.
- Conflicting configuration edits are rejected; retries cannot duplicate schedules.
- Pause/resume preserves individual automation settings and does not affect
  independently managed automations.
- Removing a configuration preserves history and cannot silently break linked coverage.
- Timezones, effective next runs, and scheduling holds are inspectable.
- Restart and repeated event delivery preserve state without duplicate execution.
- Decisions answered in one surface resolve everywhere.
- Review readiness requires the task's expected verification evidence.

## 14. Out of scope for the first release

- A general-purpose Tasks chat composer.
- Automatic enrollment of repos into maintenance.
- New categories of monitoring integrations solely to populate the maintenance UI.
- A second scheduler or workflow engine.
- New autonomous merge, deployment, or host-operation authority.

## 15. Implementation notes

What shipped, and where it differs from the design above:

- **Session collaboration (#702).** `@Joe` / Ask Joe reach Joe as a durable Session Request;
  Joe replies with `reply_in_session`. Tasks record `originSessionId` / `originRequestId`, and
  milestone task cards read the live task. Execution substate is `running` / `queued` / `idle`.
  Sessions have a revisioned controller (`user` / `joe`); Joe can take over only with the
  `requestId` of an explicit `@Joe` request, and stale-revision instructions are refused. The
  sidebar entry is **Tasks**; Joe's transcript is a read-only activity log at `/joe`.
- **Automation tools (#698).** The tools in §10 shipped under the names listed, plus
  `trigger_workflow` accepting an `automationId`. Automation health values are `healthy`,
  `starting`, `held`, `degraded`, `unavailable` and `disabled`; `held` is an addition to the §6
  vocabulary so activity holds are visible rather than counted as coverage. The Automations UI
  routes go through the same `AutomationService`.
- **Maintenance (#703).** Plans, responsibilities and activity live in `runs.db`
  (`maintenance_plans`, `maintenance_responsibilities`, `maintenance_activity`). Response
  policies are `notify`, `propose`, `investigate` and `implement`. Joe can propose
  responsibilities and pause; the user enables, resumes, turns off, and changes accepted
  responsibilities. Joe's MCP tools: `list_maintenance`, `get_maintenance_plan`,
  `propose_maintenance_responsibility`, `remove_maintenance_responsibility`,
  `pause_maintenance`, `record_maintenance_activity`. Each finished run of a linked automation
  is recorded once by run id and sent to Joe as a Maintenance Check notification.
- **Not yet built:** the explicit migration state for pre-existing implicit Joe monitoring (§12)
  — existing automations simply appear as independently managed until adopted.
- **API:** [API-REFERENCE.md](./API-REFERENCE.md#joe-in-repo-sessions) documents the session,
  automation and maintenance routes.
