# Agent Joe (Orchestrator) — Resilience & Agentic-Capability Audit

**Date**: 2026-06-11
**Scope**: `server/orchestrator-*.ts`, `server/session-manager.ts`, `server/prompt-router.ts`, frontend orchestrator components
**Reported symptoms**: lack of realtime feedback from sessions; children occasionally lacking access to implement updates; overall low usefulness.

---

## Executive Summary

Agent Joe's architecture (orchestrator + spawned child sessions + memory/trust) is sound, but the feedback loop between children and Joe is **terminal-state-only and lossy**, and the permission model **silently denies or starves** headless child sessions. Both reported symptoms trace to concrete, fixable defects:

1. **No realtime feedback**: nothing notifies Joe when a child becomes blocked, makes progress, or needs input. The only push is a single terminal-state notification — which is **dropped permanently** if Joe's process happens to be down.
2. **Access failures**: a child that needs any tool outside a fixed allowlist either sits blocked until the 10-minute timeout kills it (no client attached), or has the approval **auto-denied 10 seconds after the user closes its tab**.

Severity legend: 🔴 critical · 🟠 high · 🟡 medium · ⚪ low

---

## Findings

### A. Realtime feedback gaps

#### A1. 🔴 No notification when a child gets blocked on a tool approval
- `prompt-router.ts:396` / `prompt-router.ts:166` register pending approvals, but **no event hook fires** — `SessionManager` only exposes `onSessionResult` and `onSessionExit` (`session-manager.ts:735,749`).
- `orchestrator-children.ts:464` explicitly *keeps waiting* when a child has pending approvals — correct, but no one tells Joe.
- Joe's only discovery mechanism is a `*/30 * * * *` cron it must create itself (`orchestrator-manager.ts:284`), polling `/api/orchestrator/sessions/pending-prompts`.
- **Fatal interaction**: the default child timeout is **10 minutes** (`orchestrator-children.ts:86`) but the monitoring cron fires every **30 minutes**. A blocked child is nearly always killed by timeout before Joe ever checks. The approve-stuck-sessions machinery exists but can essentially never be exercised in time.

#### A2. 🔴 Terminal-state notifications are silently lost if Joe is down
- `orchestrator-notify.ts:38` returns `false` when Joe's Claude process isn't alive.
- `notifyTerminal` (`orchestrator-children.ts:248-275`) is invoked exactly once per child (in `monitorChild`'s `finally`, line 502, plus the spawn-failure path). The code comment at lines 261-264 claims non-delivery "does not permanently suppress future retries", **but no caller ever retries**. There is no queue, no replay on Joe restart.
- Result: if Joe's session is idle-restarting, rate-limited, or crashed when a child finishes/fails, Joe never learns the outcome.

#### A3. 🟠 Joe cannot observe child progress mid-flight
- `ChildSession.result` is populated only at terminal state (`orchestrator-children.ts:466-484`). The children API (`orchestrator-session-router.ts:180-246`) exposes no transcript/tail endpoint. Joe literally has no way to answer "what is the child doing right now?" even when asked.

#### A4. 🟠 Monitor notifications are buffered but never replayed
- `OrchestratorMonitor.deliverToOrchestrator` (`orchestrator-monitor.ts:265-282`) bails when Joe's process isn't alive or rate-limited; the notification stays `delivered: false` forever. Nothing flushes pending notifications when Joe (re)starts — they only ever surface as a dashboard count.

#### A5. 🟡 Notifications are injected mid-turn
- `sendInput` (`session-manager.ts:1236`) does not queue: a notification arriving while Joe is mid-turn is pushed straight into the stream. No coalescing or "wait for idle" behavior; bursts of child events can interleave with user conversation.

### B. Access failures ("can't implement updates")

#### B1. 🔴 Auto-deny on client disconnect kills child approvals
- `session-manager.ts:854-889`: when the **last WebSocket client leaves** a session, after a 10s grace period **all pending control requests and tool approvals are auto-denied**.
- Joe's children are exactly the sessions a user opens briefly from the sidebar "to watch" and then closes. The moment they close the tab, anything the child was waiting on is denied — the child then typically reports it "could not complete the task".
- Children that no client ever joins don't get auto-denied, but instead starve until the 10-minute timeout kills the process (A1).
- This is the most direct explanation of "occasionally not having access to implement updates".

#### B2. 🟠 Child allowlist gaps for common dev commands
- `AGENT_CHILD_ALLOWED_TOOLS` (`orchestrator-children.ts:96-116`) omits everyday commands: `mkdir`, `cp`, `mv`, `touch`, `sed`, `awk`, `grep`/`rg`, `python`/`pytest`, `jq`, `find`. Any of these → pending approval → B1/A1 death spiral.
- Compound commands (`cd x && npm test`) and pipes may not match `Bash(npm:*)`-style prefixes either (depends on matcher).

#### B3. 🟠 Joe's own allowlist is narrower than its instructions assume
- Joe gets only `Bash(curl:*)` + Cron tools (`orchestrator-manager.ts:340`). Its CLAUDE.md tells it broadly to "use the Bash tool". Any non-curl Bash (e.g. `date`, `jq` to parse API output) requires approval — and when Joe runs headless from a cron tick with no client attached, that blocks/denies just like B1, taking the whole "unblock stuck children" routine down with it.

#### B4. 🟡 Worktree-creation failure is invisible to Joe
- On failure, the child is told (prompt section "Worktree Not Available", `orchestrator-children.ts:396-407`), but the spawn API response and `ChildSession` object carry no worktree status — Joe can't warn the user or adjust expectations, and the child is now working in the main checkout.

#### B5. 🟡 Trust/escalation system is not wired into the approval path
- The trust records (`orchestrator-memory.ts`) drive Joe's *conversational* behavior only. Nothing consults trust when a child's tool approval arrives — there's no auto-approval of patterns the user has approved 5 times. The learning system therefore cannot reduce the friction that's actually hurting (B1/B2).

### C. Weak agentic mechanics

#### C1. 🟠 Final-step verification is keyword sniffing
- `ensureFinalStep` (`orchestrator-children.ts:527-540`) checks for substrings like `"pull request"` or `"git push"` in the child's output text. False positives ("I could not create a pull request") and false negatives are both easy. Ground truth (`gh pr list --head <branch>`, `git ls-remote`) is never consulted. Nudges at most once.

#### C2. 🟡 Arbitrary completion heuristics
- On process exit, `text.length > 100` → `completed`, else `failed` (`orchestrator-children.ts:481`). A long error transcript counts as success.
- `ensureFinalStep` reads the **first** `result` message in history (`find`, line 546), not the latest.
- `supersededMsgs` is collected but never read — dead code (`orchestrator-children.ts:422,547`).

#### C3. 🟠 Cron-dependent monitoring is fragile by design
- Joe's recurring checks live only in its session and die on every restart; re-creation depends on the model following a prompt instruction (`orchestrator-manager.ts:282-284`), and recurring jobs auto-expire after 7 days. Core monitoring should not depend on prompt-compliance.

#### C4. 🟡 10-minute default child timeout is too short and undiscriminating
- Real implementation tasks routinely exceed 10 minutes. The timer also keeps running while a child is blocked on an approval, so "waiting for a human" is indistinguishable from "hung".

#### C5. 🟡 Repo discovery misses nested org directories
- `discoverRepoPaths` (`orchestrator-monitor.ts:285-300`) scans only one level under `REPOS_ROOT`. Repos organized as `<root>/<org>/<repo>` (e.g. `Multiplier-Labs/codekin`) are invisible to report monitoring and passive-repo checks.

### D. Bugs

#### D1. 🟠 Broken escaping in Joe's generated CLAUDE.md
- In `CLAUDE_MD_TEMPLATE`, the "Checking for Stuck Sessions" / "Giving Approvals" sections (`orchestrator-manager.ts:197-225`) use `\\\`` sequences that render as literal `\`` in the written file — code fences and inline code in exactly the *unblocking instructions* are corrupted markdown. Earlier sections use the correct single-escape form. This degrades Joe's comprehension of its most important recovery procedure. (Note: the template is seeded only if the file doesn't exist, so already-deployed instances keep the broken copy even after a fix — needs a migration/refresh.)

#### D2. ⚪ Misleading retry comment
- `orchestrator-children.ts:261-264` documents retry semantics that no code implements (see A2).

---

## Recommendations (priority order)

### P0 — Close the feedback loop
1. **Emit an event when a pending approval/control request is created** (in `prompt-router.ts`), and push an immediate notification to the parent orchestrator for `source='agent'` sessions: session ID, `requestId`, tool name, tool input summary, plus the exact curl to respond. This single change makes the existing unblock machinery actually usable.
2. **Queue + replay orchestrator notifications.** Persist undelivered notifications (both child terminal-state and monitor notifications) and flush them when Joe's process (re)starts — e.g. on `startClaude` for the orchestrator session, prepend a digest. Fix or remove the misleading retry comment (D2).
3. **Stop auto-denying approvals for orchestrator-managed sessions.** In `session-manager.ts` `leave()`, skip auto-deny when `session.source === 'agent'` (route to Joe instead per #1). Auto-deny is a sensible default for interactive sessions only.

### P1 — Fix the access model
4. **Pause the child timeout while blocked on approvals** (or use a separate, longer "blocked" budget) and surface a distinct `blocked` child status in the children API.
5. **Broaden `AGENT_CHILD_ALLOWED_TOOLS`** with safe everyday commands (`mkdir`, `cp`, `mv`, `touch`, `sed`, `rg`, `jq`, `python3`, `pytest`) and verify compound-command matching behavior.
6. **Wire trust records into child approvals**: when a child approval arrives, consult the trust store; auto-approve patterns at `notify_do`/`silent` level and notify Joe, instead of leaving everything manual.
7. **Give Joe a slightly broader allowlist** (e.g. `Bash(jq:*)`, `Bash(date:*)`) or — better — an MCP-style internal tool wrapping the orchestrator API so it doesn't depend on raw curl at all.
8. **Return worktree status in the spawn response** and on the `ChildSession` object so Joe can react to fallback-to-main-checkout.

### P2 — Make monitoring server-owned and verification truthful
9. **Move recurring child/report checks server-side** (extend `OrchestratorMonitor`, which already exists and survives session restarts) instead of relying on prompt-instructed session crons. Keep session crons for user-defined reminders only.
10. **Verify completion with ground truth**: after a child claims completion, run `gh pr list --head <branch>` / `git ls-remote --heads` server-side and attach the verdict to the child record; nudge based on that, not keyword matching. Drop the `text.length > 100` heuristic in favor of the result message's `is_error` flag.
11. **Raise the default child timeout** (30–45 min) and let Joe set it per task (already supported via `timeoutMs`, but the prompt never mentions it).
12. **Recursive repo discovery** (depth 2) in `discoverRepoPaths` to cover `<org>/<repo>` layouts.

### P3 — Polish
13. **Fix the CLAUDE_MD_TEMPLATE escaping** (D1) and refresh already-seeded `CLAUDE.md` files (e.g. version-stamp the template and rewrite on mismatch).
14. **Add `GET /api/orchestrator/children/:id/transcript`** (tail of `outputHistory`) so Joe can report live progress on demand.
15. Remove dead `supersededMsgs` code; use the *last* result message in `ensureFinalStep`.

---

## What's already good

- Event-hook (not polling) child monitoring with proper unsubscription and a processing-flag safety net.
- Stable orchestrator session ID, idle-timeout exemption, crash auto-restart with cooldown.
- Worktree isolation by default, with explicit prompt guidance on fallback.
- Sensible spawn validation (branch-name sanitization, repo-root boundary with symlink resolution, rate limiting with bounded memory).
- SQLite+FTS memory with typed TTLs and a trust model that is conceptually right — it just isn't connected to the place where friction actually occurs.
