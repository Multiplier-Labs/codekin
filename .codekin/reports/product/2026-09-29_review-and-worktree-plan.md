Concrete plan: branch review and dependable worktree lifecycle

Follow-up to the [Conductor comparison](2026-09-28_conductor-comparison.md). This is a proposed implementation plan, based on static inspection of the same application checkout (`8772ef5`). No application behavior was changed or runtime-tested for this plan.

**Product outcome.** A developer can review the complete result of a task after the agent commits, give precise feedback, and archive that task without losing its code. A session that requested isolation cannot start or restart in the shared checkout because isolation failed.

**A. Review the task's complete changes.**

Current implementation: `DiffManager.getDiff()` supports staged, unstaged, and all uncommitted changes. Git errors can be caught and converted into empty output. `useDiff` has no request/session identity on diff responses and refreshes mainly through tool-name heuristics. The same `DiffScope` type is used for reading and discarding changes. These details need attention when expanding the feature. Sources: [diff manager](../../../server/diff-manager.ts), [client hook](../../../src/hooks/useDiff.ts), [message handler](../../../server/ws-message-handler.ts), [types](../../../src/types.ts).

Proposed changes panel:

| View | Meaning | Destructive actions |
|---|---|---|
| All task changes (default for isolated coding sessions) | Net tracked-file changes from the branch merge base to current working files, plus untracked files | None |
| Committed | Merge base to the captured branch HEAD | None |
| Uncommitted | Current HEAD to working files, including staged and untracked changes | Existing discard operations, with explicit scope |
| Staged / unstaged | Existing detailed edit views | Existing scope-specific operations |

The header names the feature branch and comparison base. A local-changes badge makes it clear when the result is newer than the current commit or PR. Keep an explicit uncommitted default for sessions deliberately working in an existing checkout until a review base is selected.

Store the repository identity, creation ref and resolved start commit when creating an isolated session. Separately store the review base ref and its origin: user choice, PR metadata, or repository default. A creation commit is a historical fact; a review base can change. Explicit user choice takes priority over automatic PR discovery, with any discrepancy shown. Never use a feature branch's push upstream as its review base by assumption. For old sessions, suggest the configured repository default and allow correction; missing or ambiguous refs need a visible base-selection state.

Resolve permitted Git refs to object IDs and compute the merge base with captured HEAD. Committed review compares those immutable IDs. The live view compares the merge base against the working tree and adds untracked files once. Base updates are explicit/cached, with freshness visible; opening the panel should not require a network fetch. For fork PRs, identify the base repository as well as the base branch. Unrelated histories, shallow clones without the merge base, and a changed checkout must produce actionable states, never a false empty diff.

Keep the initial implementation in `DiffManager` plus a small Git-context helper; retain the existing parser and renderer. No new Git library or editor is necessary. Add response metadata for request ID, session ID, selected base, base/head/merge-base object IDs, view, and timestamp. Reject late responses after switching sessions or views. Refresh on agent turn completion, panel activation, reconnect, and manual refresh; retain tool-triggered refresh as an optimization. Detect a moved HEAD during collection and retry or mark the result stale. Live working-tree views remain best-effort observations when external tools can write; do not claim transactional snapshots.

Use distinct read-view and discard-scope types. Server validation must reject discarding a branch/history view, even if a client bypasses the UI. Surface Git command failures, output limits, binary/large-file omissions, and untracked-file read errors as incomplete/error states. Only a successful complete comparison may say there are no changes.

**B. Add precise feedback after branch review works.**

A line or range selection opens a comment draft. Batch drafts into one explicit “Send feedback to agent” action, rather than sending a new prompt on every click. Store drafts server-side for reconnects and multiple devices, with author identity and existing access checks.

Each comment records the file path, old/new side, line range, code excerpt, review base/head IDs, and content fingerprint for uncommitted content. Sending attaches the anchored code and comment to the current session through the existing prompt path. If the relevant content changed, label the anchor stale and require re-selection or explicit sending of the original excerpt; do not silently attach it to a new line. Sent does not mean resolved. Keep initial statuses draft/sent; add reviewed/resolved semantics only when a real workflow exists.

Implement in `DiffHunkView`, `DiffFileCard`, `DiffPanel`, and a review-draft store/routes. Use `view_diff` for reading and existing prompt-send authority for sending. A viewer must not acquire mutation privileges through a new review endpoint. Keep local feedback separate from posting a GitHub review.

**C. Add a small PR status card.**

After the core diff and feedback work, show the associated PR link, base/head, draft/open/merged state, check results and update time. Expand to unresolved threads and approval state in a subsequent slice if API complexity warrants it. Discover PRs using repository plus branch/head identity, including forks; use a picker for ambiguity.

GitHub checks describe the remote PR head. Show “local commits not pushed” or “local edits not checked” when that differs from current work. Missing credentials, access denial, rate limiting, unknown, and stale results must remain distinct from passing. Share a repository-scoped cache and refresh at meaningful events. Reviewers with limited session grants receive only authorized session-specific information, not a generic GitHub proxy. Start with “Open on GitHub”; do not add merge controls in the first version.

**D. Treat requested isolation as a durable property.**

Affected paths include interactive creation in `ws-message-handler`, child creation in `orchestrator-children`, loop maker startup in `loop-engine`, and startup/restart/disk restoration in `session-lifecycle` and `session-persistence`. Inspect reviewer and parallel-child worktree creation as well. Some current paths substitute the repo root for a missing or failed worktree. Sources: [interactive creation](../../../server/ws-message-handler.ts), [children](../../../server/orchestrator-children.ts), [loop startup](../../../server/loop-engine.ts), [lifecycle](../../../server/session-lifecycle.ts), [persistence](../../../server/session-persistence.ts).

Persist an explicit execution mode (`isolated` or `existing-checkout`) independently from whether a directory currently exists. Keep lifecycle (active/archived), worktree readiness (preparing/ready/failed/missing), and process state separate. Missing files must not erase the intention to run isolated.

Replace the nullable creation result with a structured success/error result carrying canonical repo, path, branch, base ref/commit, ownership, and a user-readable failure. Keep one start-time invariant for every execution path: an isolated session starts only in its verified worktree. At failure, retain the task/prompt and offer Retry. Switching to the shared checkout is a separate explicit mode change, never a timeout or recovery default. Prevent delayed creation callbacks from starting an archived/canceled session by validating a lifecycle generation before activation. Stop restart scheduling while readiness is failed/missing.

For new installations, recommend isolated mode for independent coding work. Preserve existing explicit preferences and provide an existing-checkout choice. Persist actual session mode server-side; localStorage is only a creation preference. When resuming legacy sessions, infer isolated mode from existing worktree metadata, and flag unverifiable cases rather than rewriting their paths.

**E. Make worktree retries non-destructive.**

`createWorktree()` currently force-removes its candidate path, may recursively remove leftovers, and may force-delete a generated branch during retry cleanup. `cleanupWorktree()` also has forced filesystem removal after retries. Replace these assumptions with ownership and state checks. [Implementation](../../../server/session-manager.ts).

Serialize Codekin operations per canonical repo/worktree identity. A matching, valid worktree owned by the same session can be reused. A different existing directory is a collision: choose a new managed path or report it; never delete merely because its name matches. Retain generated branches containing commits. Refuse cleanup while another session/run references the path. Record partial creation failures and clean only resources whose ownership and empty/unused state are verified.

Mid-session “Move to worktree” needs explicit semantics: the current path creates from the default base and migrates conversation data, not a general transfer of current edits. For the first version, require a clean checkout and branch from captured current HEAD, or offer “Start independent task from base.” If dirty, explain and stop; do not imply edits moved. A later copy-changes operation can use a reviewed patch with conflict handling and preserve the source checkout.

**F. Make archive preserve the working state.**

The sidebar's “Close & archive” invokes session deletion. That path archives qualifying transcript output and then cleans up the worktree. Archived conversation continuation seeds a new session and is not an exact worktree restore. [Sidebar action](../../../src/components/RepoSection.tsx), [session manager](../../../server/session-manager.ts), [archive continuation](../../../src/hooks/useSessionOrchestration.ts).

| Action | Agent process | Files/branch | Persistence |
|---|---|---|---|
| Stop | Stops | Preserved | Remains active and resumable |
| Archive | Stops and cancels restart/pending start | Preserved | Hidden from active list; identity and execution metadata retained |
| Resume | Starts deliberately after validation | Same worktree | Same task/session identity where provider resume remains available |
| Remove working files | Must be stopped; preflight required | Explicit deletion of owned worktree only; branch retained by default | Transcript/metadata retained with files-removed state |
| Delete history | No filesystem side effect | Unchanged | Explicit transcript deletion only |

Use additive archive/resume operations and a separate cleanup-preflight/removal operation. Do not silently reinterpret the old DELETE contract for all callers: inventory internal cleanup, REST clients, UI, and relay route permissions, migrate them deliberately, and deprecate unsafe behavior. Add an archived lifecycle flag to the existing durable session metadata rather than introducing a full task subsystem now. Ensure archived sessions are excluded from automatic process restoration and coordinator recovery.

The archive must retain provider/resume identity, repo/worktree identity, execution mode, base/head metadata, and readiness. Archive even a very short session if it owns a worktree or useful state; output length is not evidence that code is disposable. Legacy transcript-only entries remain labeled as such and offer “Start new session with this context.” Never claim historical code can be restored when it was not preserved.

Removal preflight reports tracked changes, untracked files, ignored-file implications, local commits without confirmed remote preservation, active references, and ownership. Unknown remote state does not count as safe. Check again after stopping the process and before removal; reject changed preflight state. Normal deletion uses Git's refusal to remove a dirty worktree. Force deletion requires an explicit current decision with the exact loss described; no recursive deletion fallback. Retain cleanup failures visibly. Codekin locks serialize its own operations but cannot guarantee exclusion of external writers.

The existing transcript archive retention defaults to seven days. Keep working-file retention independent: do not inherit that expiry for worktrees, and do not let transcript pruning erase the only ownership record for retained code. Offer manual disk cleanup first; automatic garbage collection can wait.

**Implementation sequence and acceptance tests.**

| Slice | Scope | Essential validation |
|---|---|---|
| 1 | Durable isolation requirement and all failed/missing-worktree guards; non-destructive creation retries | Inject failures for interactive, coordinator, maker/reviewer/parallel loops, restart, and restore. Assert no agent starts at repo root; retry never removes dirty files or unique commits. Cancel during creation cannot start a process later. |
| 2 | Safe archive/resume and explicit cleanup; migrate close action and internal callers | Archive dirty/untracked work, restart server, resume same branch/files. Preserve short-session work. Missing worktree shows recovery state. Old transcript-only archives and seven-day pruning never delete retained files. |
| 3 | All-task and committed diff views, base metadata, response identity, error honesty | Use temporary Git repos: committed clean branch; committed plus dirty/untracked changes; advanced base; missing/shallow base; rename/binary/large file; command failure; late response after session switch. Branch-view discard is rejected. |
| 4 | Anchored feedback drafts and send-to-agent | Deleted/added lines, moved lines, stale local content, reconnect persistence, author permissions, and one batch producing one prompt. |
| 5 | Read-only PR/checks card | Fork PR, multiple candidate PRs, missing auth, stale cache, changed local HEAD, dirty tree, out-of-order requests, and restricted shared-session access. |

Slices 1 and 3 can be developed independently; slices 2 and 3 share the small persisted Git identity fields. Review feedback depends on stable review metadata. The first release can stop after slices 1–3. It delivers complete review after commit and reliable archive/recovery without a new task model, managed cloud, full editor, auto-merge, or general checkpoint engine.
