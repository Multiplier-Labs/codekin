# Agent Joe: implementation audit and proposed use case

Date: 2026-09-30. Audited revision: `7f24e7c600727d60c6df2ef1dba7ea49a07017bb`.

## Status after re-audit against `main`

Findings were re-checked against `main` at `cba2d02` (after #672 and #684). The findings below are kept as originally written; this section records corrections and where each one stands.

**Corrections:**

- **S5 isolation fallback — outdated.** Since #672, a child whose worktree cannot be created fails and notifies Joe; it never runs in the shared checkout. Provider selection and inheritance were added by #684.
- **Finding 5 / S4 restart — overstated.** At boot, `ws-server` already calls `runStore.failInterrupted('agent')` (since #591), so interrupted runs are recorded as `failed`, not left `running`. The diagnostic built a manager without that boot step. The real gaps were narrower: recovered children did not reappear in `list()`, Joe was never told, and with `CODEKIN_AUTO_RESTORE_SESSIONS` the child sessions restarted without supervision.
- **Finding 4 — also covers the fallback.** When `gh` / `git` failed, completion fell back to transcript keywords, so "Opened a pull request" in the output counted as success.

**New finding:**

- **N1 — High: timed-out children restarted unsupervised.** The timeout killed the child process with a bare `SIGTERM`, without marking a deliberate stop. The session lifecycle classified the exit as a crash and auto-restarted it after the monitor had already detached.

**Where each finding stands:**

| Finding | Status |
| --- | --- |
| S1 stop/delete don't settle the child | Fixed in #688: `onSessionStopped` → `canceled`, slot freed, single notification |
| S2 cleanup deletes active work | Fixed in #688: completed-only, reports skipped sessions, `?dryRun=true` |
| S3 approvals don't resume the clock | Fixed in #688: `onSessionPromptResolved` from every dismiss path |
| S4 / 5 restart recovery | Fixed in #688: interrupted children relisted, Joe notified once, no unsupervised auto-restart; `get()` falls back to the run store |
| 4 / S6 false completion | Fixed in #688: PR or remote head must equal the worktree HEAD; otherwise `unverified` (`awaiting_human`), never `succeeded` |
| N1 timed-out children restarted | Fixed in #688 |
| 2 `list_reports` returns 400 | Fixed in #688: no-argument call lists all managed repos; optional `repo` / `since` |
| 8 report categories hardcoded | Fixed in #688: categories discovered from disk. Automations banner still omits blocked children (open) |
| S5 `timeoutMs` / `deployAfter` | Fixed in #688: `timeoutMs` exposed; `deployAfter` removed from MCP and rejected by REST |
| 6 duplicate notification paths | Partly fixed in #688: Joe's own children use only the outbox path. Unrelated interactive sessions still reach Joe directly (open product decision) |
| Session-control MCP tools (follow up, stop, resume, close) | Open — next slice, built on the #688 lifecycle events |
| S6 ownership and structured answers | Open — part of the control-tools slice |
| 1 entry experience, 3 activation state, 7 memory/trust automation | Open — product and UI work after the reliability slices |

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

## Follow-up: session management tooling audit

Requested focus: can Joe spawn, control, and close Codekin sessions reliably?

**Verdict:** The basic spawn/inspect/answer path is implemented and tested. Joe does not have a complete session-management MCP interface, and underlying lifecycle gaps make control and closure unreliable as a supervisory workflow. Fix the lifecycle alongside adding tools; exposing existing methods alone will preserve stale states.

### Capability map

| Operation | What Joe has today | Assessment |
| --- | --- | --- |
| Spawn a child | `spawn_child` → child REST route → child manager | Basic path works; worktree default, capacity cap, status records, and notifications exist |
| Select provider and time budget | MCP exposes model, but no provider or `timeoutMs`; REST supports `timeoutMs` | All children default to Claude; Joe cannot select another harness or configure the supported working budget through MCP |
| Inspect children | `list_children`, `get_child`, `get_child_transcript` | Useful during current process lifetime; list purges terminal children after one hour, and manager does not recover from run store |
| List all Codekin sessions | REST `GET /api/orchestrator/sessions` | No corresponding MCP tool; curl fallback required |
| Answer a permission or question | `pending_prompts`, `respond_to_prompt` | Existing route checks pending request IDs; scope is all sessions, not just Joe-owned work |
| Send a follow-up instruction | User WebSocket `input` operation | No Joe MCP tool or equivalent orchestrator REST operation |
| Stop or resume a child | User WebSocket `stop` / `start_claude` operations | No Joe MCP tools; stopping is not synchronized with child status |
| Cancel a run | `abort_run` | Only calls the loop cancellation endpoint; cannot cancel a Joe child or workflow |
| Close one session | REST `DELETE /api/orchestrator/sessions/:id` | No MCP wrapper; deletes session, conditionally archives transcript, and attempts worktree cleanup |
| Close finished sessions | REST `DELETE /api/orchestrator/sessions/cleanup` | Deletes all automated sessions regardless of whether they are finished; unsuitable for this intent |

Evidence: `server/codekin-mcp-server.ts:35`, `server/codekin-mcp-api.ts:14`, `server/orchestrator-session-router.ts:185`, `server/ws-message-handler.ts:145`.

### S1 — High: stop and delete do not settle the child supervisor

`SessionLifecycle.stopClaude()` (`server/session-lifecycle.ts:477`) removes process listeners, stops the process, and clears its reference without notifying session exit observers. `SessionManager.delete()` (`server/session-manager.ts:786`) likewise removes listeners and the session without a child-manager lifecycle event. The child manager listens to result/exit/prompt events, not deletion or explicit stopping.

Consequently a stopped or deleted child can stay `running` or `blocked`, continue occupying one of the five slots, and eventually be recorded as `timed_out`. On the blocked path, that can last until the separate 30-minute blocked cap. Restarting the process manually does not create a fresh supervised attempt with explicit semantics.

**Evidence check:** Two temporary tests invoked the actual SessionManager stop/delete methods with mocked processes and verified no exit observer was called. A child-manager diagnostic removed its backing session without a result/exit event; it remained active until its working timeout and then became `timed_out`.

**Improvement:** Add explicit stop/cancel/delete lifecycle events, durable cancellation state, immediate slot release, timer/listener disposal, and exactly-once terminal notification. Define whether resume continues an attempt or starts another. A close tool must report session, archive, branch, and worktree outcomes separately.

### S2 — High: cleanup includes active work, not just completed sessions

The cleanup route (`server/orchestrator-session-router.ts:377`) selects every session whose source is workflow, webhook, stepflow, or agent. It does not filter active/blocked state or restrict selection to Joe's children. This can stop unrelated active automation when Joe uses cleanup to tidy finished work.

The underlying deletion behavior does have useful protections: it waits for process exit before worktree cleanup, keeps branches, and uses non-forced `git worktree remove`, retaining dirty/untracked work (`server/worktree-ops.ts:330`). Transcript archival only occurs above a 150-character output threshold. Calling it “archive” without explaining these semantics would be misleading.

**Improvement:** Provide `close_session` and a completed-only cleanup operation with explicit IDs or a previewable selection. Reject active work unless cancellation is expressly requested. Return what was closed, what was retained, and why.

### S3 — High: approvals do not resume the child working clock promptly

`handleChildPrompt()` immediately pauses the timer. `monitorChild()` only resumes it in `onResult` after pending prompts have cleared (`server/orchestrator-children.ts:701`). `PromptRouter.sendPromptResponse()` clears/routes the answer but emits no matching unblocked event (`server/prompt-router.ts:203`). A tool can execute and the model can keep working before another result is emitted.

**Evidence check:** With a 60-second budget, the diagnostic consumed 30 seconds, raised a permission prompt, cleared the pending approval, and advanced another 120 seconds without a result. The child still reported `blocked`, and the process was not stopped. The existing tests simulate unblocking by explicitly emitting a result, masking this interval.

**Improvement:** Resume the working clock and transition to running when the last outstanding prompt resolves, including auto-denial paths. Track prompt resolution explicitly, not by waiting for turn completion.

### S4 — High: durable records are not durable control

The follow-up confirmed finding 5: reconstructing `OrchestratorChildManager` against the same run store yields an empty list, zero active count, and no child by ID even though its stored run remains running. The five-child cap therefore also loses historical active work at restart. Terminal children are additionally evicted by `list()` after one hour, after which child transcript lookup returns 404 even when the session still exists.

**Improvement:** Recover active tasks and watchers from persisted records, reconcile missing/stopped sessions, and expose durable history separately from live process state. Let transcript lookup resolve an authorized retained session independently of the short-lived child map.

### S5 — Medium: spawning options do not match the supported product

`spawn_child` exposes `model` but not `provider`. The child manager calls `sessions.create()` without a provider (`server/orchestrator-children.ts:377`); `SessionManager.create()` defaults it to `claude` (`server/session-manager.ts:391`). Joe running on Codex or OpenCode does not change that. The MCP schema also omits the REST route's supported `timeoutMs` and `allowedTools` fields.

`deployAfter` is accepted, recorded, and exposed in MCP, but no child execution or completion branch consumes it. A diagnostic comparing spawned prompts with false/true produced identical instructions. The `merge` completion policy means pushing the current branch, not merging a PR. If worktree creation fails, spawning proceeds in the original checkout.

**Improvement:** Add validated provider/model and timeout support; decide provider inheritance explicitly. Remove or reject unimplemented deployment options. Rename the push policy to describe what it does. Default to pausing on isolation failure rather than silently changing the execution environment.

### S6 — High: completion and permission enforcement remain prerequisites

The earlier false-success finding is confirmed by the existing child test suite: a missing PR after one nudge produces `completed` with an error note, which the run store maps to success. A control interface needs distinct `canceled`, `failed`, and `verification_unknown` outcomes.

The approval route can act on any session; consulting trust is an agent instruction rather than a server-side prerequisite. Its MCP value accepts only a string whereas the underlying prompt router also supports string arrays. Ownership and structured answer support should be part of a deliberate control contract, rather than exposing unrestricted mutation endpoints under friendlier tool names.

### Recommended implementation order

1. Fix stop/delete/cancel transitions, approval-resolution timing, false completion, and restart reconciliation. Add integration tests connecting the child manager to actual session lifecycle methods.
2. Add typed MCP operations: list/get sessions, send input with explicit queue-or-interrupt behavior, stop/cancel, resume, and close. Distinguish a running process from an active task and a retained transcript. Enforce ownership and scoped authorization on mutations.
3. Make cleanup completed-only by default; expose retained worktrees and archival results. Add provider/timeout selection and remove misleading spawn fields.
4. Add tool-to-real-router contract tests. The current API-client tests use a catch-all HTTP stub; they verify request shapes but cannot establish that a real endpoint supports them.

### Follow-up validation

Installed checkout dependencies and rebuilt the SQLite native binding. Ran:

```bash
npx vitest run server/codekin-mcp-api.test.ts server/orchestrator-children.test.ts server/orchestrator-session-router.test.ts server/orchestrator-notify.test.ts server/orchestrator-outbox.test.ts
```

Result: **97 tests passed across five files**. Six additional temporary diagnostic tests reproduced the approval-clock gap, missing recovery, missing provider/unused deployment option, delayed settlement after session removal, and absent exit notifications on actual stop/delete methods. They assert the current undesirable behavior, not acceptance criteria for a fix, and were removed after the audit. Processes and provider execution were mocked; no live sessions were spawned, stopped, or closed. No application code was changed. This validation supersedes the initial audit's no-test-execution limitation for the specific follow-up scope only.
