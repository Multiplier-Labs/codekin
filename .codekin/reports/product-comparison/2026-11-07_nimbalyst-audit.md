# Nimbalyst compared with Codekin

Date: 2026-11-07

## Assessment

Codekin would benefit most from making agent outputs and human decisions first-class objects: an attention inbox, persistent session-to-file/commit/PR links, and review that survives agent commits. Nimbalyst offers substantially more visual editing, task organization, and desktop/mobile integration. Codekin should selectively adopt those interaction patterns while preserving its browser-based, self-hostable execution and automation architecture.

The distinction is emphasis, not exclusive capability. Nimbalyst already has multi-agent coordination, isolated worktrees, autonomous Super Loops, scheduled wakeups, and team collaboration. Codekin already has three coding harnesses, remote/mobile browser access, structured approvals, queued prompts, session persistence, workflows, autonomous loops, and orchestration. Adding those again is not a competitive roadmap.

## Scope and evidence

Static product and architecture audit, not a security audit, performance benchmark, or hands-on usability test. Neither application was launched and no runtime test suite was run. Recommendations are judgments based on inspected source and documentation, not measured customer demand.

- Codekin: local clean checkout at `7f24e7c600727d60c6df2ef1dba7ea49a07017bb`, before this report.
- Nimbalyst: public `main` tree resolved to `826adb4f93dbe86db35b76ce2502a3a33abe0489`; inspected feature inventory, architecture documents, and selected implementation files.
- “Missing” means no corresponding first-class feature was found in the inspected Codekin UI, routes, types, and dependency declarations. An agent can still perform many of these tasks through its tools.
- Nimbalyst's inventory describes current source, including opt-in and platform-specific functionality. This does not establish availability in every stable release.
- Its collaboration sync server is a separate project and was not audited. The public client repository alone does not establish full hosted-service behavior. [Licensing boundary](https://github.com/nimbalyst/nimbalyst/blob/826adb4f93dbe86db35b76ce2502a3a33abe0489/LICENSING.md).
- Older documents on both sides can lag implementation. Codekin's `FEATURES.md` and `CLAUDE.md` still contain Claude-centric descriptions; its current source and README support Claude, Codex, and OpenCode. Nimbalyst's worktree reliability document is a list of proposed improvements, not proof of currently outstanding bugs.

## Capability comparison

| Area | Nimbalyst | Codekin at audited revision | Implication |
| --- | --- | --- | --- |
| Primary interface | Electron desktop workspace, visual editors, native mobile companions, team web surfaces | React browser workbench backed by a Node service and optional relay | Different deployment and interaction choices; keep Codekin's browser reach |
| Coding harnesses | Broad provider catalog, including SDK, CLI and ACP lanes, plus extension-contributed agents | Claude Code, Codex, OpenCode behind a shared process interface and harness registry | More providers are lower priority than consistent behavior across the current three |
| Parallel work | Worktrees, nested sessions, teammates, Blitz | Worktrees, Agent Joe children, workflow and loop execution | Already substantial overlap |
| Autonomous work | Super Loops with fresh-context iterations and file-carried progress; scheduled wakeups | Durable outcome loops, deterministic evaluators, independent-provider review, budgets, scheduled workflows and webhook triggers | Different execution semantics, not an absent Nimbalyst capability |
| Human attention | Session phase board; awaiting-input, running and unread grouping; desktop and mobile notifications | Repository session rows with waiting/running/idle indicators; orchestrator notifications and approvals | Add a cross-repo human attention queue |
| Work history | Indexed file/session links, session-associated commits, PR/tracker/review-session navigation | Session transcripts, archives, current working-tree diffs, run artifacts | Add durable navigation from results back to their producing sessions |
| Review | Rendered document diffs, edit history, accept/reject, hunk-selecting commit proposals | Unified Git diffs, staged/unstaged scopes and file/all discard; separate tool/plan permissions | Improve result review; do not confuse edit acceptance with permission to execute |
| Documents and artifacts | Markdown/code editors, diagrams, mockups, spreadsheets, previews and canvas | Rendered/raw Markdown reader; changes requested through chat | Start with lightweight artifact rendering and annotation |
| Planning | Persistent trackers and plan documents linked to sessions | Agent task popup, plan approval state machine, automation recipes | Add durable task identity before attempting a general project tracker |
| Mobile | Native iOS/Android companions; push; iOS voice and additional OS integration | Responsive browser access, pairing and server-stored preferences | Background attention is the useful gap; mobile access itself already exists |
| Git finish workflow | Commit controls, worktree merge/rebase/squash, integrated GitHub PR review | Interactive diff/discard and agent-driven Git; loops automate commit/push/PR finalization | Add a narrow review-to-PR workflow rather than a complete Git client |
| Extensibility | Shared EditorHost lifecycle, tool widgets and agent extensions | Skills, modules, workflow files, Codekin MCP tools, fixed React views | Start with internal artifact/tool renderer contracts |

Nimbalyst evidence: [feature inventory](https://github.com/nimbalyst/nimbalyst/blob/826adb4f93dbe86db35b76ce2502a3a33abe0489/docs/FEATURE_INVENTORY.md), [session hierarchy](https://github.com/nimbalyst/nimbalyst/blob/826adb4f93dbe86db35b76ce2502a3a33abe0489/docs/SESSION_HIERARCHY.md), [SuperLoopService](https://github.com/nimbalyst/nimbalyst/blob/826adb4f93dbe86db35b76ce2502a3a33abe0489/packages/electron/src/main/services/SuperLoopService.ts), [extension architecture](https://github.com/nimbalyst/nimbalyst/blob/826adb4f93dbe86db35b76ce2502a3a33abe0489/docs/EXTENSION_ARCHITECTURE.md).

Codekin evidence: [README](https://github.com/Multiplier-Labs/codekin/blob/7f24e7c600727d60c6df2ef1dba7ea49a07017bb/README.md), [process contract](https://github.com/Multiplier-Labs/codekin/blob/7f24e7c600727d60c6df2ef1dba7ea49a07017bb/server/coding-process.ts), [harness registry](https://github.com/Multiplier-Labs/codekin/blob/7f24e7c600727d60c6df2ef1dba7ea49a07017bb/server/harness-registry.ts), [LoopEngine](https://github.com/Multiplier-Labs/codekin/blob/7f24e7c600727d60c6df2ef1dba7ea49a07017bb/server/loop-engine.ts), [session rows](https://github.com/Multiplier-Labs/codekin/blob/7f24e7c600727d60c6df2ef1dba7ea49a07017bb/src/components/RepoSection.tsx), [DocsBrowser](https://github.com/Multiplier-Labs/codekin/blob/7f24e7c600727d60c6df2ef1dba7ea49a07017bb/src/components/DocsBrowser.tsx), [TodoPanel](https://github.com/Multiplier-Labs/codekin/blob/7f24e7c600727d60c6df2ef1dba7ea49a07017bb/src/components/TodoPanel.tsx), [PlanManager](https://github.com/Multiplier-Labs/codekin/blob/7f24e7c600727d60c6df2ef1dba7ea49a07017bb/server/plan-manager.ts).

## Recommended priorities

### 1. High: an attention inbox across repositories

Nimbalyst's board gives sessions a work phase separate from their runtime state; its notification service explicitly handles questions, permissions, plan approval and commit proposals. Codekin already knows when sessions need input, but presents that primarily in repository rows and the active session.

Build an inbox with “Needs an answer”, “Ready for review”, “Failed/stalled”, and “Completed since last visit”. Each item should show the exact requested action, waiting duration, repository, provider and a link to the relevant prompt or result. Keep runtime state, user-managed work phase, and read/unread status separate. A stopped process is not proof that a task is complete.

First slice: unresolved prompts across all repositories, oldest first, with durable acknowledgement and direct navigation. Add completion review next; a draggable Kanban board is optional.

Measure median human response time, age of the oldest blocked session, and how many sessions users inspect to find actionable work.

Evidence: [Nimbalyst session board](https://github.com/nimbalyst/nimbalyst/blob/826adb4f93dbe86db35b76ce2502a3a33abe0489/packages/electron/src/renderer/components/TrackerMode/SessionKanbanBoard.tsx), [notification service](https://github.com/nimbalyst/nimbalyst/blob/826adb4f93dbe86db35b76ce2502a3a33abe0489/packages/electron/src/main/services/NotificationService.ts); [Codekin session rows](https://github.com/Multiplier-Labs/codekin/blob/7f24e7c600727d60c6df2ef1dba7ea49a07017bb/src/components/RepoSection.tsx), [orchestrator monitor](https://github.com/Multiplier-Labs/codekin/blob/7f24e7c600727d60c6df2ef1dba7ea49a07017bb/server/orchestrator-monitor.ts).

### 2. High: preserve what a session actually produced

Nimbalyst stores file interactions with session IDs and supports both “files for this session” and “sessions for this file”. It distinguishes read, edited and referenced relationships.

Codekin's interactive DiffManager runs Git diff in the session working directory. “All” means `git diff HEAD`, with additional untracked-file handling. Consequently:

- Once an agent commits its changes, those changes disappear from the uncommitted diff view.
- Pre-existing dirty changes can appear as part of the current directory's diff.
- Shared-directory activity does not establish which session authored each change.

These are limitations of the view's semantics, not evidence of lost Git data. Codekin loops already have base SHAs, events and artifacts; the gap is extending durable provenance to ordinary interactive sessions.

Persist a session baseline, pre-existing dirty-state information, changed paths, producing tool/turn references, resulting commit SHAs and PR URL. Offer separate “Working tree” and “Session changes” views. Track renames/deletions and qualify uncertain attribution rather than inventing certainty. A baseline commit alone is insufficient when starting from a dirty or shared checkout.

First slice: session baseline and committed/uncommitted changes in an isolated worktree, plus a persistent result summary. Then add reverse file-to-session navigation.

Measure whether users can recover a session's output after a commit, reconnect, restart and archive.

Evidence: [Nimbalyst SessionFilesRepository](https://github.com/nimbalyst/nimbalyst/blob/826adb4f93dbe86db35b76ce2502a3a33abe0489/packages/runtime/src/storage/repositories/SessionFilesRepository.ts), [SessionFileTracker](https://github.com/nimbalyst/nimbalyst/blob/826adb4f93dbe86db35b76ce2502a3a33abe0489/packages/electron/src/main/services/SessionFileTracker.ts); [Codekin DiffManager](https://github.com/Multiplier-Labs/codekin/blob/7f24e7c600727d60c6df2ef1dba7ea49a07017bb/server/diff-manager.ts), [session worktree handling](https://github.com/Multiplier-Labs/codekin/blob/7f24e7c600727d60c6df2ef1dba7ea49a07017bb/server/session-manager.ts), [loop artifact storage](https://github.com/Multiplier-Labs/codekin/blob/7f24e7c600727d60c6df2ef1dba7ea49a07017bb/server/loop-artifacts.ts).

### 3. High: review the result, then give targeted feedback

Nimbalyst's documented diff system snapshots pre-edit content and presents changes after they have been written to disk. “Reject” restores earlier content; it is not a sandbox preventing execution. Its feature inventory also describes commit proposals with individual-hunk selection.

Codekin's current diff UI offers scopes and discard controls. Tool permissions answer “may the agent do this?”; result review answers “is this change correct?”. Both are useful and should remain distinct.

Add line/hunk comments that send exact file, range, revision and feedback to the originating session. Follow with selected-hunk staging and a commit/PR proposal containing the diff, checks and destination branch.

Every review decision should be bound to a content revision. When the agent changes the file during review, invalidate or refresh the decision. Rejecting an old snapshot must not overwrite a newer human or agent edit. Keep review status, Git staging, and execution permission independent.

First slice: revision-bound “Ask agent to revise this hunk” plus session-level review status. This is smaller and safer than immediately implementing visual rollback across all file formats.

Evidence: [Nimbalyst diff lifecycle](https://github.com/nimbalyst/nimbalyst/blob/826adb4f93dbe86db35b76ce2502a3a33abe0489/docs/FILE_WATCHER_DIFF_SYSTEM.md), [Git feature inventory](https://github.com/nimbalyst/nimbalyst/blob/826adb4f93dbe86db35b76ce2502a3a33abe0489/docs/FEATURE_INVENTORY.md#git-integration); [Codekin DiffToolbar](https://github.com/Multiplier-Labs/codekin/blob/7f24e7c600727d60c6df2ef1dba7ea49a07017bb/src/components/diff/DiffToolbar.tsx), [DiffFileCard](https://github.com/Multiplier-Labs/codekin/blob/7f24e7c600727d60c6df2ef1dba7ea49a07017bb/src/components/diff/DiffFileCard.tsx).

### 4. Medium-high: artifact tabs and explicit context selection

Codekin's DocsBrowser renders Markdown or raw text. Its “inline editing” is an instruction to the agent, not direct document editing. Nimbalyst supports direct editing and passes selected text or objects into chat as removable context chips.

A useful Codekin first slice is a result pane for Markdown reports, Mermaid diagrams, images and test results. Add text/range selection with “Ask about this” and “Request change”. Display exactly which document and revision will be sent. Expand to direct Markdown editing only with conflict detection and a consistent save lifecycle.

Use a small internal artifact interface for content loading, external-change events, selection, revision, theme and review actions. Do not build an extension marketplace before proving two or three built-in renderers. Any later executable HTML preview needs an isolated rendering boundary appropriate to Codekin's authenticated browser architecture.

Measure how often users leave Codekin to inspect an output and how many clarification turns are needed to locate the intended section.

Evidence: [Nimbalyst EditorHost contract](https://github.com/nimbalyst/nimbalyst/blob/826adb4f93dbe86db35b76ce2502a3a33abe0489/docs/EXTENSION_ARCHITECTURE.md), [custom tool widgets](https://github.com/nimbalyst/nimbalyst/blob/826adb4f93dbe86db35b76ce2502a3a33abe0489/docs/CUSTOM_TOOL_WIDGETS.md); [Codekin DocsBrowserContent](https://github.com/Multiplier-Labs/codekin/blob/7f24e7c600727d60c6df2ef1dba7ea49a07017bb/src/components/DocsBrowserContent.tsx), [Markdown pipeline](https://github.com/Multiplier-Labs/codekin/blob/7f24e7c600727d60c6df2ef1dba7ea49a07017bb/src/components/markdownPipeline.ts), [ChatView](https://github.com/Multiplier-Labs/codekin/blob/7f24e7c600727d60c6df2ef1dba7ea49a07017bb/src/components/ChatView.tsx).

### 5. Medium: durable task identity across sessions and runs

Nimbalyst connects plans and tracker items to agent sessions and PRs. Codekin's TodoPanel shows an agent's current task list, while PlanManager handles the plan-approval lifecycle. Neither is a durable project task record.

Start with a small task record: objective, acceptance criteria, status, linked sessions/runs, artifacts and PRs. Let humans and agents update it through the same API, with changes recorded. Optionally mirror portable records into repository Markdown with stable IDs; choose one authority and define conflict behavior rather than creating competing database/file truth.

First slice: turn a session's approved objective into a task and attach subsequent retries, provider handoffs and loop runs. Link external issues where available. Defer custom schemas, calendars, dependencies and a separate project-management product.

Keep organizational grouping separate from who controls a worker and receives its reports. Nimbalyst's session hierarchy explicitly distinguishes these relationships.

Evidence: [Nimbalyst planning system](https://github.com/nimbalyst/nimbalyst/blob/826adb4f93dbe86db35b76ce2502a3a33abe0489/docs/PLANNING_SYSTEM.md), [session hierarchy](https://github.com/nimbalyst/nimbalyst/blob/826adb4f93dbe86db35b76ce2502a3a33abe0489/docs/SESSION_HIERARCHY.md); [Codekin TodoPanel](https://github.com/Multiplier-Labs/codekin/blob/7f24e7c600727d60c6df2ef1dba7ea49a07017bb/src/components/TodoPanel.tsx), [handoff manager](https://github.com/Multiplier-Labs/codekin/blob/7f24e7c600727d60c6df2ef1dba7ea49a07017bb/server/handoff-manager.ts).

### 6. Medium: background notifications before native mobile apps

Codekin already supports mobile browser use. The inspected tree has no browser push/service-worker implementation equivalent to Nimbalyst's native notification path.

After the inbox exists, add opt-in browser notifications and evaluate Web Push/PWA support on target devices. Deep-link to the exact pending interaction, suppress duplicates when the user is already viewing it, and preserve events through reconnects. Use non-sensitive notification previews by default. Browser/platform constraints must be tested before promising closed-app delivery.

Native iOS/Android applications and voice are later investments, justified by actual mobile usage. Nimbalyst's platform-specific feature matrix is a useful reminder not to promise identical behavior everywhere.

Evidence: [Nimbalyst mobile capabilities](https://github.com/nimbalyst/nimbalyst/blob/826adb4f93dbe86db35b76ce2502a3a33abe0489/docs/FEATURE_INVENTORY.md#mobile-ios), [notification service](https://github.com/nimbalyst/nimbalyst/blob/826adb4f93dbe86db35b76ce2502a3a33abe0489/packages/electron/src/main/services/NotificationService.ts); [Codekin remote-access implementation](https://github.com/Multiplier-Labs/codekin/blob/7f24e7c600727d60c6df2ef1dba7ea49a07017bb/src/lib/transport/relay-client.ts), [README](https://github.com/Multiplier-Labs/codekin/blob/7f24e7c600727d60c6df2ef1dba7ea49a07017bb/README.md).

## Engineering lessons worth adopting

1. **Declare provider fidelity, not just provider identity.** Nimbalyst distinguishes structured file-change events, tool-argument hints, and no reliable attribution. Its fallback watcher policy follows that contract. Extend Codekin's existing capabilities with observed file-event fidelity and test add/edit/delete/rename/shell-write behavior across its three harnesses. Avoid presenting inferred authorship as authoritative. [Nimbalyst contract](https://github.com/nimbalyst/nimbalyst/blob/826adb4f93dbe86db35b76ce2502a3a33abe0489/packages/runtime/src/ai/server/providerFileTracking.ts), [Codekin capabilities](https://github.com/Multiplier-Labs/codekin/blob/7f24e7c600727d60c6df2ef1dba7ea49a07017bb/server/coding-process.ts).

2. **Preserve native agent semantics where possible.** Nimbalyst's file watching/snapshot design lets agents keep their ordinary edit tools. For Codekin, enrich native events and reconcile disk state rather than requiring all providers to use a special editor tool. Distinguish “a file changed” from “this agent definitely changed it”.

3. **Test complete interaction sequences.** Nimbalyst documents editor tests for external writes, accept/reject, autosave and closing dirty tabs, and has session/worktree E2E files. Codekin has substantial unit coverage, but the inspected package/CI does not configure a browser E2E suite. Add a small set of workflows: answer a blocked prompt after reconnect; recover review after commit/restart; reject stale feedback; review from a phone-sized viewport. This is an investment recommendation, not a finding that Nimbalyst's tests currently pass. [Nimbalyst test conventions](https://github.com/nimbalyst/nimbalyst/blob/826adb4f93dbe86db35b76ce2502a3a33abe0489/docs/EDITOR_E2E_TESTING.md), [example E2E source](https://github.com/nimbalyst/nimbalyst/blob/826adb4f93dbe86db35b76ce2502a3a33abe0489/packages/electron/e2e/ai/diff.spec.ts), [Codekin CI](https://github.com/Multiplier-Labs/codekin/blob/7f24e7c600727d60c6df2ef1dba7ea49a07017bb/.github/workflows/ci.yml).

4. **Retain Codekin's existing Git protections.** Its worktree helper already serializes repository operations, rolls back failed creation and refuses force-removal of dirty worktrees. Nimbalyst's reliability document discusses similar failure classes. Use that document as a scenario checklist, not as a claim that Codekin lacks these protections or that Nimbalyst has fixed every listed item. [Codekin worktree implementation](https://github.com/Multiplier-Labs/codekin/blob/7f24e7c600727d60c6df2ef1dba7ea49a07017bb/server/worktree-ops.ts), [Nimbalyst reliability proposals](https://github.com/nimbalyst/nimbalyst/blob/826adb4f93dbe86db35b76ce2502a3a33abe0489/docs/WORKTREE_RELIABILITY_IMPROVEMENTS.md).

5. **Describe deployment and encryption precisely.** Nimbalyst documents zero-knowledge personal sync but server-managed encryption for team data; those are different trust models. Codekin's relay transports application JSON over authenticated connections and should not be described as end-to-end encrypted based on the inspected implementation. Its fully self-hostable relay is a concrete alternative. An E2EE product decision would require separate key, sharing, recovery and authorization design. [Nimbalyst collaboration posture](https://github.com/nimbalyst/nimbalyst/blob/826adb4f93dbe86db35b76ce2502a3a33abe0489/docs/FEATURE_INVENTORY.md#collaboration), [Codekin relay protocol](https://github.com/Multiplier-Labs/codekin/blob/7f24e7c600727d60c6df2ef1dba7ea49a07017bb/server/relay/relay-protocol.ts), [self-hosted relay](https://github.com/Multiplier-Labs/codekin/blob/7f24e7c600727d60c6df2ef1dba7ea49a07017bb/docs/SELF-HOSTED-RELAY.md).

## What Codekin should retain and emphasize

- **Browser-accessible execution on user infrastructure**, including a self-hosted relay, instead of requiring a desktop installation on every viewing device.
- **Explicit verification semantics**: deterministic command gates, independent-provider rubric review, budgets and durable transition records. Nimbalyst's Super Loops also iterate and recover interrupted work; Codekin's specific evaluation/recovery design is the meaningful distinction.
- **Operational integrations**: scheduled workflows, activity-aware triggers, webhook PR reviews, CI repair and deployment monitoring form a coherent workflow beyond interactive coding.
- **Consistent support for the existing harnesses**: provider handoff, approvals and recovery are more valuable than maximizing the provider count.
- **Portable repository outputs**, with report files and workflow definitions, while preserving provenance in the application.

These are source-supported strengths and positioning opportunities, not benchmarked superiority over Nimbalyst. [Codekin overview](https://github.com/Multiplier-Labs/codekin/blob/7f24e7c600727d60c6df2ef1dba7ea49a07017bb/README.md), [loop semantics](https://github.com/Multiplier-Labs/codekin/blob/7f24e7c600727d60c6df2ef1dba7ea49a07017bb/server/loop-engine.ts), [Nimbalyst loop implementation](https://github.com/nimbalyst/nimbalyst/blob/826adb4f93dbe86db35b76ce2502a3a33abe0489/packages/electron/src/main/services/SuperLoopService.ts).

## Suggested sequence and explicit deferrals

1. Establish session provenance and an unresolved-attention API; ship the inbox and persistent session output summary.
2. Add session-baseline diffs, revision-bound feedback, review status and result-to-session navigation.
3. Add artifact tabs/context selection, followed by background notifications.
4. Add durable tasks linked to sessions, runs and PRs if the first three expose a need for longer-lived planning.

Priorities reflect architectural fit and likely usefulness, not effort estimates or a calendar commitment. Validate them with users who supervise multiple concurrent sessions; measure blocked time and review/navigation friction before expanding scope.

Defer a complete IDE, spreadsheet/CAD/editor suite, arbitrary third-party extension execution, native mobile apps, full tracker customization and extra providers without demand. Nimbalyst's broad workspace is coherent for its product; copying its breadth would create several new maintenance surfaces for Codekin.

The most useful lesson is to make it easy to answer: **What needs me now? What did this session produce? Can I inspect it, request a precise change, and trace it back later?**
