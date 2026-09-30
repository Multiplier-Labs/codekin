# Agent Joe: implementation audit and proposed use case

Date: 2026-09-30. Audited revision: `7f24e7c600727d60c6df2ef1dba7ea49a07017bb`.

## Assessment

Joe has useful execution infrastructure, but an unclear user contract. It presents itself as an AI ops manager, offers generic coding tasks, discusses reports, manages approvals, and receives deployment events. The user must still decide what to delegate, supply policies, interpret chat, and determine whether the work is actually finished. For one straightforward coding task, a normal session has fewer handoffs.

The strongest initial use case is **supervising explicitly delegated coding work until it is ready for human review**:

> “Take these two or three tasks, keep them moving while I work elsewhere, and bring back reviewable changes. Interrupt me only for decisions you cannot resolve within the agreed scope.”

This is a product hypothesis, not a demonstrated customer preference. It fits users already running parallel sessions. If the user mostly runs one session at a time, the benefit is weaker; validate frequency of supervision work before building a large new interface.

## Scope and method

Source audit of the React entry experience, orchestrator prompt, MCP-to-HTTP contracts, child lifecycle, monitoring/outbox, memory/trust integration, Automations interface, and existing test assertions. No live browser walkthrough, production configuration inspection, usage telemetry, real agent run, or test execution was performed. Dependencies are absent in this checkout. Findings describe this revision, not observed production incidents. No application behavior was changed.

## What is already valuable

- Dedicated persistent session with configurable provider/model and a first-party MCP interface: `server/orchestrator-manager.ts:392`, `server/codekin-mcp-server.ts:35`.
- Up to five child sessions, worktree creation, blocked-child events, working-time budgets paused during approvals, and a final-step nudge: `server/orchestrator-children.ts`.
- Durable notification outbox with an idle delivery gate: `server/orchestrator-outbox.ts:36`.
- Child run records in the shared run store and navigation to their sessions from Automations: `server/orchestrator-children.ts:310`, `src/components/AutomationsView.tsx:137`.
- An existing execution path with evaluators, review, and budgets in `server/loops/ci-autorepair.md`. Reuse loop infrastructure where appropriate rather than constructing another executor around Joe.

## Findings

### 1. The entry experience describes capabilities instead of starting a useful job

`src/components/ChatView.tsx:418` renders three generic examples as static divs, including code review and bug investigation. They look like cards but do not initiate an action. `src/components/OrchestratorView.tsx:122` shows repo, pending-notification, and active-session counts; it does not show reviewable outputs or a decision queue. The composer asks Joe to “work on your code,” while its prompt prohibits directly implementing code.

**Impact:** The user must discover the distinction from an ordinary coding session and invent an orchestration workflow. Counts convey activity without establishing value.

**Change:** Offer one clear “Delegate tasks” action with task, repo, completion criteria, and limits. Put decisions and reviewable results above optional chat.

### 2. The primary report-listing tool is broken at the API boundary

`server/codekin-mcp-server.ts:196` defines `list_reports` without inputs. `server/codekin-mcp-api.ts` implements `listReports()` as `GET /api/orchestrator/reports` without query parameters. `server/orchestrator-session-router.ts:141` requires either `repo` or `since` and otherwise returns HTTP 400. The existing test at `server/orchestrator-session-router.test.ts:205` explicitly expects that rejection.

**Impact:** An advertised core action fails through the preferred tool. Joe must discover a curl workaround.

**Change:** Define a real all-managed-repositories contract and test the MCP client against the router. Merely passing `since` still depends on SQLite repo-context records, which are a separate registry from the prompt's `REPOS.md`.

### 3. “Always-on” does not describe the default activation behavior

`docs/FEATURES.md:215` describes automatic startup. `server/config.ts:135` defaults both `CODEKIN_AUTO_RESTORE_SESSIONS` and `CODEKIN_ORCHESTRATOR_MONITOR` to off. `server/ws-server.ts:620` gates startup, and `:886` gates periodic monitoring. Opening Joe starts it through `OrchestratorView`.

This does not disable every event source: workflow listeners, probe signals, and loop events are separately wired. Quiet mode is an intentional quota safeguard, not inherently a bug.

**Impact:** Users can expect ongoing supervision without knowing which parts are active. Conversely, starting Joe can initiate its startup prompt's report/scheduling work.

**Change:** Show an explicit supervision state and bounded opt-in scope. Wake Joe for actionable events associated with delegated work; keep idle monitoring deterministic and inexpensive.

### 4. A completed child is not necessarily a reviewable result

In `server/orchestrator-children.ts:710`, after one nudge, a child returning another non-error result becomes `completed` even if its expected PR is still absent. It receives an error note, but `persistRun()` maps `completed` to `succeeded`. This behavior is explicitly asserted in `server/orchestrator-children.test.ts:371`.

The final-step check at `:795` accepts any PR returned by `gh pr list --state all`, checks branch existence rather than pushed HEAD equality for the push policy, skips commit verification for commit-only, and falls back to transcript keywords when commands fail. It does not verify acceptance criteria, tests, CI, or review readiness.

**Impact:** Joe cannot yet reliably promise “come back when it is done.” A success badge may hide unfinished delivery.

**Change:** Represent unverified work explicitly. Store result artifacts and verification evidence tied to the current commit. Distinguish implementation finished, verification failed/unknown, ready for review, and merged. Unknown verification must not become success.

### 5. Persistent run history does not restore active child supervision

`OrchestratorChildManager` starts with an empty in-memory child map (`server/orchestrator-children.ts:139`). It persists run changes but contains no corresponding run-store recovery path in its constructor. Completion listeners and timeout controllers are established when spawning a child.

**Impact:** After a server restart, historical runs can remain visible while this manager no longer lists or supervises those children. Session restoration alone does not rebuild these relationships. This is a source-level lifecycle gap; restart behavior was not exercised live.

**Change:** Recover active delegated tasks from durable state, reconcile their sessions/artifacts, and restore supervision idempotently before accepting more work.

### 6. There are competing blocked-session notification paths

The child manager sends blocked notifications through its notification helper. Separately, `server/ws-server.ts:636` listens for prompts from every non-orchestrator session and calls Joe's `sendInput()` when its process is alive, without the outbox's idle gate or a check that Joe owns that session.

**Impact:** A Joe child can trigger both paths, and unrelated interactive sessions can demand Joe's attention. The direct path bypasses the deliberate outbox delivery rules.

**Change:** Use one deduplicated event path and explicit task ownership. Make attaching an existing interactive session to Joe a deliberate action.

### 7. Learned memory and trust are less automatic than the product narrative suggests

The prompt instructs Joe to keep Markdown memory and record outcomes. Extraction and decision-recording functions are called from learning HTTP routes; there is no automatic conversation lifecycle caller in the inspected code. `OrchestratorMonitor.setMemory()` has no production caller, so its aging/assessment routine exits without a memory store. Memory/learning CRUD is also absent from the first-party MCP tool list.

Trust lookup and recording are separate operations from executing an approval. The session response endpoint authenticates the caller but does not itself enforce Joe's trust policy (`server/orchestrator-session-router.ts:300`). The MCP approval tool also allows approvals made by Joe to increase the same count used for trust escalation (`server/codekin-mcp-server.ts:178`).

**Impact:** Reliable learning depends on agent behavior and discoverability of fallback APIs. Approval counts need not represent repeated explicit human consent.

**Change:** For the first supervision use case, make scoped permissions explicit and enforce them server-side. Separate human consent from automatic execution receipts. Defer expanded personality/skill profiling until outcome delivery works.

### 8. Report discovery and attention state are incomplete

`server/orchestrator-reports.ts:39` scans a fixed category list that excludes `incidents`, even though Joe's prompt tells diagnostic children to write there; it also excludes existing `product` reports. The monitor tracks report paths in memory and marks existing files seen at startup, so unchanged paths and historical unresolved findings are not a durable work queue.

In Automations, the needs-attention banner fetches loop runs awaiting approval; it does not include Joe's blocked children (`src/components/AutomationsView.tsx:85`). Joe's pending count tracks notification delivery, not whether the human has resolved a decision.

**Impact:** Users can miss actionable work or need to inspect several views. Sending a notification is not equivalent to resolving its underlying issue.

**Change:** Separate durable decisions/results from transient notifications. Discover categories dynamically if report triage remains supported.

## Use cases considered

| Use case | Fit with current implementation | Product judgment |
| --- | --- | --- |
| Supervise a few delegated tasks through review readiness | Children, worktrees, events, run store, transcripts already exist | Best initial hypothesis for parallel-session users; directly reduces supervision work |
| Repair failing CI | Loop recipe already has tests, lint, review, and budgets | Strong bounded task inside the supervisor; another chat launcher alone adds little |
| Daily repo summary | Many relevant data sources exist | Useful secondary surface, but can become another report to read |
| Autonomous repo janitor | Report ingestion and approval learning are incomplete | Risk of creating low-priority work and review load before proving value |
| Deployment incident investigator | Deterministic probes and diagnostic children exist | Valuable for users with linked deployments; narrower audience and configuration dependency |

## Smallest useful version

Pilot on one repository with two or three independent tasks explicitly supplied by the user. Do not start with autonomous issue discovery or broad cross-repository planning.

1. User chooses “Delegate tasks,” enters the tasks, and confirms repo, acceptance criteria, verification commands, PR delivery, and a time/cost ceiling. Infer existing repository policy where possible; ask only for unresolved choices.
2. Joe supervises each task in an isolated workspace. It answers routine questions only within the supplied scope and permissions. Pause safely if isolation fails.
3. The UI has **In progress**, **Needs your decision**, and **Ready for review** sections. Each decision explains what is blocked, Joe's recommendation, and the consequence of each answer.
4. Each result includes the task, PR/diff link, exact verified commit, checks and outcomes, and remaining limitations. A PR alone does not satisfy completion.
5. Background work resumes after server restart. Recovery, retries, and notifications do not duplicate tasks. A stopped or failed task retains its partial work and explanation.

Example return experience: “Two changes are ready for review with passing checks. The third needs your decision about changing the public API.” The user should not have to read three transcripts to establish that state.

Use the existing run store as the source of truth. Add durable task ownership, acceptance criteria, artifacts, verification state, decisions, and recovery. Reuse loops for bounded evaluation/retry where applicable. Keep Joe responsible for coordination and explanations; keep completion and authorization rules in code.

## Delivery and validation

**First:** Repair the report tool contract and misleading completion state. Consolidate notifications, establish supervision recovery, and expose accurate activation state. These are prerequisite reliability fixes, not a new broad agent framework.

**Then:** Build the narrow delegation entry and decision/result surface using the existing execution infrastructure. Start with user-selected tasks and explicit permissions.

**Pilot:** Compare at least ten comparable task batches with ordinary manual session management. Record supervision minutes, manual transcript visits, actionable versus unnecessary interruptions, time blocked, accepted reviewable outputs, and total agent cost including Joe.

Proposed go/no-go criteria: at least 50% fewer manual status checks, no false “ready” result, recovery without duplicate execution in a deliberate restart exercise, and repeated voluntary use by the pilot user. These are proposed targets, not measured outcomes. If supervision effort or review load does not improve, keep Joe as an optional coordination interface and prioritize deterministic run/decision UI instead.
