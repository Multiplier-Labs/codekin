# Product Audit — New-User Experience & Automation Unification

**Date:** 2026-08-29
**State audited:** `main` @ `2023856` (fix(hosted): let the hosted UI clone a repo the machine doesn't have, #569)
**Scope:** (1) new-user experience and initial setup, with agent-agnosticism and a SaaS/relay-first funnel as goals; (2) the scattered automation surface — AI Workflows, Loop Runs, Agent Joe — and a path to a unified, more complete experience. Spec level only; no implementation proposals below the architecture line.

---

## Part 1 — New-User Experience & Initial Setup

### 1.1 Current state

**The entire local first-run flow is a token paste.** When no token is stored, the app auto-opens the *full* ~1000-line Settings modal (`src/App.tsx:83,479-482`) — auth, retention, repos path, worktree prefix, approvals, webhooks, theme — with the relevant field labeled "Claude Code Web Token" (`src/components/Settings.tsx:307`). There is no onboarding wizard, welcome tour, or first-run checklist anywhere. `codekin setup` is described as a wizard (`bin/codekin.mjs:8,685`) but asks zero questions: it generates a token, writes two env keys, and prints a URL.

**The server knows the environment health; the UI throws it away.** The `connected` WS frame carries `claudeAvailable`, `claudeVersion`, `apiKeySet`, `codexAvailable`, `codexAuthenticated` (`server/ws-server.ts:540`, typed at `src/types.ts:184`) — and no frontend code reads any of it. A user whose CLI is missing or logged out gets a silent failure at session start. The only environment problem surfaced in the UI is a missing `gh` (`src/components/RepoSelector.tsx:72-85`).

**The installer is Claude-gated; the product is not.** `install.sh:52-60` hard-exits if `claude` is absent, and never checks Codex or OpenCode — even though the product ships three harness adapters and the New Session flow offers all three unconditionally. Conversely, the session-creation provider list (`src/components/NewSessionButton.tsx:114`) is *not* filtered by availability, so a Claude-only user is offered Codex and discovers the failure only after the session starts. The one place that gates on availability is the workflow editor (`ProviderModelSection.tsx:117-146`).

**Claude is the structural default, not just the default option.** The abstraction exists (`server/coding-process.ts` — `CodingProvider`, `CodingProcess`, three adapters) but Claude is the `else` branch everywhere: process factory (`session-lifecycle.ts:185-193`), provider fallbacks (`session-manager.ts:395`, `ws-message-handler.ts:60`), model-list ternaries, permission-mode vocabulary (`PermissionMode` is defined as "the Claude CLI `--permission-mode` flag" and other harnesses translate into it). The shared event contract is literally `ClaudeProcessEvents`; the field holding a Codex thread id is named `claudeSessionId`; every harness's start event is `claude_started`. 65 occurrences of "Claude" in non-test frontend strings.

**Non-Claude users still secretly depend on the Claude CLI.** Three background utilities spawn `CLAUDE_BINARY` regardless of the session's harness:
- session auto-naming (`server/session-naming.ts:73`)
- cross-harness handoff distillation (`server/handoff-manager.ts:82`) — the flagship *agent-agnostic* feature requires a working Claude install
- model refresh probing (`server/anthropic-models.ts:205`)

Additional asymmetries: only Claude gets a real startup auth probe (`ws-server.ts:122-147`; OpenCode gets none at all); approval-registry `allowedTools` are computed for every session but passed only to the Claude branch (`session-lifecycle.ts:156-158,190`); "always allow" persists to `.claude/settings.local.json` only (`native-permissions.ts:39`); the skill menu feeds `~/.claude/skills` to Codex sessions (`src/App.tsx:311-318`); worktree history migration reads `~/.claude/projects/` without a provider guard, producing a false "history could not be preserved" warning for Codex/OpenCode sessions (`session-manager.ts:553,573-589`).

**The declared capability matrix is dead code.** `ProviderCapabilities` (`coding-process.ts:29-46,108-138`) is defined and assigned by all three adapters and read by nothing. Consequence: `CODEX_CAPABILITIES.planMode: false` has no effect — the composer still offers Plan mode on Codex sessions (`InputBar.tsx:514-516` only filters `dangerouslySkipPermissions`).

**The hosted/SaaS path is invisible and gated.** `README.md` never mentions app.codekin.ai, `codekin relay`, or hosted mode; the funnel exists only in internal docs. Signup is allowlist-only: a non-allowlisted GitHub login lands on a Pending page with no in-product approval path (revocation/management *endpoints* shipped in #566/#567, but nothing renders them). The machines empty state now gives the two pairing commands (good), but presumes Codekin is already installed on a machine and links to no install instructions. The two funnels — hosted signup and local install — are never stitched together. The most fragile step is the connector token wiring (`AUTH_TOKEN_FILE` / origin mismatch warnings in `connector-cli.ts:62-74`), which is exactly the step the product leaves to the user.

**Recent improvements worth crediting:** the hosted flow now remembers the connection, lands in Settings when disconnected (#562-#564), session rows spell out their harness (#561), and remote repos can be cloned on demand from the hosted UI (#569). The direction is right; the front door is still missing.

### 1.2 Scenarios

**S1 — The SaaS-first newcomer.** A developer hears about Codekin and opens app.codekin.ai.
*Today:* GitHub sign-in → either a dead-end "pending approval" page (no self-serve path, no admin UI to approve them) or, if allowlisted, an empty machines list telling them to run `codekin relay login` on "a machine running Codekin" — a product they have not installed and are given no link to. If they do find `install.sh`, it exits unless Claude Code is installed and authenticated. Then they must separately discover `codekin relay login`, `codekin relay connect`, and possibly debug `AUTH_TOKEN_FILE`.
*Target:* sign in → (self-serve workspace creation, or a visible "request access" flow an admin can approve in-product) → a **Connect your first machine** screen showing one copy-paste command that installs *and* pairs in a single pass — e.g. `curl -fsSL codekin.ai/install.sh | bash -s -- --pair XXXX-XXXX` — with the installer detecting whichever agent CLIs exist, wiring the connector token itself, and reporting status back to the browser via the pairing poll. The browser page live-updates: *machine online → agents detected: Codex ✓, Claude ✗ (install hint) → pick a repo → first session*. Zero manual token handling.

**S2 — The Codex-only user.** Has a ChatGPT subscription and the Codex CLI; no Anthropic account.
*Today:* `install.sh` refuses to install at all (`exit 1` on missing `claude`). If they install via npm directly, the product works — mostly: every session is named by a silently-failing Claude subprocess, handoff distillation degrades to a raw transcript dump, Plan mode is offered but does nothing, the skill autocomplete shows Claude skills, and the landing page invites them to "start a Claude Code session".
*Target:* the installer requires *at least one supported agent*, not one specific vendor; background AI utilities (naming, distillation) run through whatever harness the session uses or any available one; UI copy, defaults, and feature toggles derive from a live per-harness capability/availability model rather than Claude-with-exceptions.

**S3 — The local-first tinkerer.** Installs via npm on their own box, no relay.
*Today:* opens the URL, is dropped into the full Settings modal to paste a token they were shown in the terminal (the `?token=` URL already automates this — the modal is mostly noise), then a repo list with a bare "No repositories configured" if the path guess missed. Whether their agents are actually usable is discoverable only by trying.
*Target:* a first-run checklist as the landing surface, driven by data the server already sends: ① connected ✓ ② agents — one row per harness with availability + auth state and the exact fix command (`codex login`, `claude` once, install links) ③ repos root confirmed / repos found ④ optional: connect to app.codekin.ai for remote access ⑤ start your first session. Every row is a live check, not documentation.

### 1.3 Spec recommendations

**N1 — Replace the settings-modal first-run with an onboarding checklist.** One dedicated surface (local and hosted variants sharing the checklist core), consuming the environment-health data already present in the `connected` frame. It doubles as a permanent "system status" page after onboarding — the current `gh`-missing card and the invisible upgrade notification both belong there.

**N2 — Make the harness registry the single source of truth.** Replace the if/else factory and the dead `ProviderCapabilities` with a real registry: each adapter self-describes `{ id, label, binary, installHint, authProbe, authFixHint, capabilities, modelDiscovery }`. Every surface derives from it: installer checks, startup probes, the connections popover, provider pickers (filtered by availability, disabled with a fix-it hint rather than hidden), permission-mode and plan-mode visibility, empty-state copy. Adding harness #4 becomes one file, not twelve edit sites. Enforce capabilities at the composer (no Plan toggle on a harness that lacks it).

**N3 — A "utility agent" abstraction for background AI calls.** Session naming, handoff distillation, and future summarization pick an available harness (prefer the session's own; fall back to any authenticated one; degrade gracefully to non-AI behavior). No hardcoded `CLAUDE_BINARY` outside the Claude adapter.

**N4 — Installer neutrality + pairing-code install.** `install.sh` requires *any one* supported agent (offering to install one if none found) and gains `--pair <code>` / `--relay <url>` flags so the hosted funnel's "connect a machine" step is one command. `codekin setup` becomes a genuinely interactive wizard only where a choice exists (which agent is default; pair with hosted?) — otherwise stays silent.

**N5 — Stitch the hosted funnel and make it the front door.** README and codekin.ai lead with the hosted path; local-only install becomes the self-hosting section. In-product: an admin approval screen over the #566/#567 endpoints so Pending is no longer a dead end; the machines empty state links the pairing-code install command; the connector inherits the local token automatically during pairing instead of requiring `AUTH_TOKEN_FILE` archaeology.

**N6 — Copy and naming sweep.** User-facing: "Claude Code Web Token" → "Codekin access token"; "Choose a repository to start a Claude Code session" → "…to start a session"; npm/systemd/CLI descriptions → "web UI for coding agents". Internal (gradual, behind the registry work): `claudeSessionId` → `harnessSessionId`, `claude_started` → `session_started`, `ClaudeProcessEvents` → `CodingProcessEvents`. The neutral word already in use in the UI and handoff code — **harness** — should become the canonical term over `CodingProvider`.

**Priority order (matching the stated goal, SaaS-first):** N5 + N4's pairing install are the funnel; N1 is the landing; N2/N3 are the agent-agnostic substrate the funnel promises; N6 rides along with each touched surface.

---

## Part 2 — AI Workflows, Loop Runs, Agent Joe

### 2.1 Current state: three parallel systems

The three features are, conceptually, three points on one axis — *how much autonomy a background run has* — but they are implemented as three unrelated stacks:

| | AI Workflows | Loop Runs | Agent Joe |
|---|---|---|---|
| Concept | scheduled/event one-shot → report artifact | goal + verifier + budget, iterate to convergence | resident supervisor spawning child sessions |
| Engine | `workflow-engine.ts` 4-step machine | `goal-run-controller.ts` event loop | `orchestrator-*` (12 files) |
| Store | `~/.codekin/workflows.db` | `~/.codekin/goal-runs.db` | memory.db + **children in-memory only** |
| Scheduler | own 60s cron poll + hand-rolled parser | none (event-driven on session result) | prompt-instructed session `CronCreate` + 15-min monitor poll |
| Recipe format | MD + line-split pseudo-frontmatter | MD + real YAML frontmatter | CLAUDE.md template |
| Recipe location | `server/workflows/` + `{repo}/.codekin/workflows/` | `server/loops/` + `{repo}/.codekin/loops/` | `~/.codekin/orchestrator/` |
| Status enum | `queued/running/succeeded/failed/canceled/skipped` | `…/verifying/checking/awaiting_human/aborted` | `starting/running/blocked/completed/failed/timed_out` |
| Stop verb | `cancel` | `abort` | (timeout) |
| UI feed | poll 5s/15s (a `workflow_event` push channel exists and is consumed by nothing) | poll 4s/3s, no events | notification injection into Joe's stdin |
| Session source | `workflow` | `agent` | `orchestrator` + children `agent` |
| Restart resume | yes (`resumeInterrupted`) | **no — in-flight runs stuck forever** | notifications durable (outbox); child records lost |
| Session allowlist | `['Bash(gh pr:*)']` | **none** | ~40 curated patterns |
| Harness support | per-repo `provider` | maker/checker per role | **Claude only** (children created with no provider) |
| Docs | `docs/WORKFLOWS.md` ✓ | **none** | `docs/ORCHESTRATOR-SPEC.md` ✓ |
| Naming | "AI Workflows" (vs `stepflow`, repo `workflows/` pkg, CI workflows — four meanings) | "Loop Runs" / `GoalRun` / `loop-loader` — three names | "Agent Joe" / `orchestrator` — `/joe` and `/orchestrator` both routed |

The only cross-feature wire: `OrchestratorMonitor` subscribes to workflow events and scans `.codekin/reports/` so Joe can triage workflow findings.

### 2.2 Functional gaps and defects

1. **Loop runs cannot survive a restart.** No rehydration at boot; a run in `running`/`verifying`/`checking` when the server restarts is stuck permanently; `abortRun` is the only escape (`goal-run-controller.ts`).
2. **Blocked-run stall hole.** The Joe-audit fix exempting `source === 'agent'` sessions from auto-deny (`session-manager.ts:883`) assumed an orchestrator is watching. GoalRun maker/checker sessions share that source but are not Joe children, so a non-allowlisted tool call with no client attached blocks silently — no deny, no notification, no `blocked` status; the run stalls in `running` until the 300s router timeout, then loops.
3. **GoalRun sessions get no `allowedTools` at all** (`goal-run-controller.ts:135-139`) — every `npm test` in a maker turn is an approval candidate, which combined with (2) makes headless loop runs fragile by construction.
4. **`GoalRunKind` is a closed 3-member union declared in four places.** A repo-defined loop template is *listed* by the templates endpoint but *rejected* by `POST /runs`. Workflows accept arbitrary repo kinds; loops don't. Direct functional gap.
5. **Joe's children are in-memory** — the resilience audit made notifications durable but the child ledger still evaporates on restart, purges after 1h.
6. **Joe is Claude-only** (children spawned with no provider → default `claude`), contradicting the agent-agnostic goal at the feature most likely to showcase it.
7. **Push channel exists, UI polls anyway.** `workflow_event` is broadcast and typed on both sides and consumed nowhere; loops emit no events; Joe injects into stdin mid-turn (open audit item A5).
8. Open items from the 2026-06 Joe audit: A5 (mid-turn injection), B3 (Joe's own allowlist is just curl + cron), B5 (trust records never wired into approvals). The audit report itself is unreachable from HEAD (exists only on an unmerged branch, commit `0e6127c`).
9. **No spec for loops** anywhere in docs/, FEATURES.md, or README — the least-documented feature is the one with the richest data model.
10. Vocabulary divergence throughout: `canceled` vs `aborted`, two frontmatter parsers with different failure behavior, three cron implementations, `LoopProvider` vs `CodingProvider` re-declared.

### 2.3 Unifying concept: one Run primitive

All three features reduce to the same shape:

```
Automation  = trigger × recipe × policy
  trigger   = schedule (cron) | event (commit, PR, webhook) | goal (manual/API) | delegation (spawned by a supervisor)
  recipe    = prompt + harness/model per role (maker, checker?) + verify[] commands + output contract (report file | PR | commit)
  policy    = budget (turns, cost, time) + allowedTools + completionPolicy + escalation target

Run         = { id, automationId, trigger, status, sessionIds[], ledger[], cost, artifacts, evidence }
  ledger    = ordered steps/turns (the GoalRun evidence ledger generalizes the workflow step table)
  status    = one shared enum; 'awaiting_human' and 'blocked' are first-class, not feature-specific
```

Under this model:
- **A workflow is a degenerate loop**: `maxTurns: 1`, no checker, no verify commands, output contract = report file on `codekin/reports`. Its 4-step engine (validate → session → prompt → save) becomes the single-turn path of the loop engine.
- **A loop run** is the general case: verify[] gates each turn, an optional checker role reviews, the finalizer owns git/PR mechanics.
- **A Joe child is a run with `trigger: delegation`** — same ledger, same policy, same completion verification (`gh pr list` ground truth already exists in both Joe and the loop finalizer; today it is implemented twice).
- **Joe stops being a third execution system and becomes the supervisor over the run ledger**: it subscribes to run events (blocked, awaiting_human, completed, failed), triages artifacts, and *creates* runs — via the same API the UI uses. Joe's chat is the conversational front-end to automations; the dashboard is a view over the same store. This also structurally fixes defect (2): *any* run whose session blocks routes to the supervisor/notification inbox, whether or not Joe spawned it.

Substrate consolidation implied: one SQLite store, one scheduler (the workflow cron service, absorbing loop scheduling needs and replacing Joe's prompt-instructed session crons), one recipe loader (real YAML, `{repo}/.codekin/automations/`, with back-compat reading of the two existing directories), one event stream that the UI actually consumes (replacing three polling loops and stdin injection), one status vocabulary, one stop verb.

### 2.4 Scenarios

**U1 — Nightly repo health (today: workflow).** User adds the `repo-health.weekly` recipe to a repo. In the unified view they see one Automations screen: the recipe card shows its trigger (`Mon 07:00`), last run status dot, and its run history; opening a run shows the ledger (validate ✓ → session → report committed) with a link into the live session transcript. Nothing conceptually changes — this is the baseline that must not get more complicated.

**U2 — "Fix the CI" (today: loop run).** User picks the `ci-autorepair` recipe on a red repo — or writes `.codekin/automations/flaky-e2e.md` with their own verify commands, which *works* because kinds are open. The run card shows turn count, spend vs budget, and per-turn verify evidence. When the maker hits an approval boundary, the run flips to `blocked`, appears in the shared inbox, and Joe (if enabled) or the user resolves it — instead of stalling invisibly. After a deploy restart, the run resumes from its ledger instead of dying.

**U3 — "Joe, keep my repos green" (today: three disconnected features).** The user tells Joe the goal in chat. Joe creates a scheduled automation (health reports), subscribes to its results, and when a report flags failing CI, creates a goal run — all through the one API, all visible as rows in the same Automations view with `trigger: delegation` attribution. The user has one place to see everything running on their machine and one inbox for everything that needs a human. Today this story requires the user to mentally join three views, and half the wiring (Joe → loops) doesn't exist at all.

**U4 — Restart during a busy night.** Server restarts mid: one workflow run, two loop runs, three Joe children. Today: the workflow resumes, the loops are stuck forever, the children vanish. Unified: one `resumeInterrupted` pass over one store rehydrates or cleanly fails every run, and the supervisor is notified of anything it was watching.

**U5 — Codex-only user automates (ties Part 1 to Part 2).** Recipes name harness per role (`maker: codex`), Joe's children inherit a configurable default harness, and the run engine uses the harness registry (N2) for availability. Automation stops being the Claude-only corner of an otherwise multi-harness product.

### 2.5 Migration path

**Phase 0 — stop the bleeding (no data-model changes).** Fix the four defects that make loops untrustworthy: restart resume for goal runs; route blocked agent-source sessions to notification instead of silent stall; give loop sessions a real allowlist (start from Joe's curated 40); open the kind union to repo templates. Write `docs/LOOPS.md`. Land the unreachable Joe audit report. Consume `workflow_event` in the UI to retire one polling loop.

**Phase 1 — shared substrate.** One status enum + stop verb; one YAML recipe loader with back-compat; goal-run store and workflow store merge into one DB with a `Run`/`ledger` schema; one scheduler; run events on one stream. Feature behavior unchanged — this phase is invisible to users by design.

**Phase 2 — one view.** A single **Automations** entry replaces "AI Workflows" and "Loop Runs" in the sidebar: recipe cards grouped by repo, filterable by trigger type, one run-detail page (ledger + evidence + linked session), one inbox for `blocked`/`awaiting_human`. The two old routes redirect.

**Phase 3 — Joe on top.** Joe's child-spawning migrates to creating delegation-triggered runs; the dashboard becomes a view over the run ledger; trust records (open item B5) finally get a place to act — auto-approving the `blocked` inbox within trust level. Joe's chat becomes the conversational way to author recipes and launch runs.

### 2.6 Making Joe more powerful with MCP

There is a proven local pattern to follow. Three sibling projects expose domain knowledge as MCP servers, and the integration model was designed with Codekin in mind:

- **BookGraph** — read-only research MCP over Streamable HTTP (7 tools: passage search, knowledge graph, cross-book synthesis…), shipped 2026-08-25. Its design record (`bookgraph/docs/codekin-bookgraph-mcp-integration.md`) is explicitly a Codekin integration spec, and its key architectural decision applies verbatim here: **Codekin does not proxy MCP; each harness inherits its provider-native MCP configuration** (user-scope `claude mcp`, Codex config, OpenCode config), so one HTTP MCP server serves all three harnesses with zero protocol work in Codekin.
- **Erwin Analytics** — ships `apps/mcp-server` with per-token auth (`McpAuthContext`), token-usage logging, and an audit log that **redacts free-text args before storage** — the governance pattern an autonomous agent's tool calls need.
- **TubeGraph** — same shape; its deployment gotcha is instructive: headless tokens must live in `~/.profile`, not `~/.bashrc`, because non-interactive shells (exactly what Codekin spawns) skip the latter.

**Why Joe gets none of this today.** BookGraph and TubeGraph are already registered user-scope on this machine, so Joe's Claude process inherits them — but Joe's allowlist is `['Bash(curl:*)', 'CronCreate', 'CronDelete', 'CronList']` (`orchestrator-manager.ts:393`) and the child allowlist has no `mcp__*` patterns either, so every MCP call stalls on an approval prompt with no one watching. This is open audit item B3 in concrete form. (Joe and children being Claude-only, §2.2 #6, also means MCP inheritance for Codex/OpenCode children is moot until the harness registry lands.)

**Spec recommendations:**

**M1 — Replace curl-driving with a Codekin MCP server.** Joe's entire control surface today is string-built `curl` commands against Codekin's REST API, taught via a prompt template. Wrap that API (spawn/monitor children, list runs, respond to prompts, memory/trust/learning ops, read reports) in a first-party MCP server and put `mcp__codekin__*` in Joe's allowlist. Typed tools instead of shell strings resolves B3 outright, is self-describing (less prompt template to maintain and version), works identically across harnesses when Joe's children stop being Claude-only, and the same server can later be exposed to external clients (Claude Desktop, a phone agent) as the remote-control story.

**M2 — MCP grants as policy, gated by trust.** Extend the allowlist vocabulary already present in `ChildSessionRequest.allowedTools` and the unified `policy.tools` (§2.3) with `mcp__<server>__*` patterns. Read-only servers (BookGraph, TubeGraph, Erwin's query tools) are grantable by default; write-capable MCP tools sit behind trust levels — giving the never-wired trust records (open item B5) their first real job.

**M3 — A connections surface in Codekin.** The BookGraph doc's one unbuilt ask: "give Codekin a connection-management surface." A Settings/onboarding section that lists MCP servers per harness, health-checks them (list tools), and toggles availability for Joe and for automation runs. Recipes then declare requirements (`mcp: [erwin]`) and the run engine checks availability before starting, the same way it should check harness availability (N2).

**M4 — Audit every MCP call into the evidence ledger.** Adopt Erwin's pattern: log tool name, redacted args, and child/run attribution into the unified run ledger, so an autonomous Joe consulting external systems stays reviewable.

**What Joe concretely gains:** Erwin Analytics tools let Joe ground triage in product reality ("error rate on X spiked; opening a goal run") instead of only repo signals; BookGraph/TubeGraph give planning children citable engineering guidance when writing specs and reviews; and the Codekin MCP server turns Joe from a curl-scripted operator into a properly tool-equipped supervisor.

### 2.7 Open questions for discussion

1. **Naming.** "Automations" is the working title above; alternatives: "Runs", "Agents", "Jobs". Whatever is chosen should also settle the Loop-Runs/GoalRun/loop-loader triple-name and the four meanings of "workflow".
2. **Do workflows and loops merge at the recipe level or only at the view level?** The spec above argues recipe-level (a workflow is a 1-turn loop); the cheaper alternative — shared view over two engines — preserves the code but ossifies the duplication.
3. **Is Joe a privileged component or the first API consumer?** The spec argues consumer: everything Joe can do, the UI and external API can do. That keeps the supervisor optional (important for the SaaS story, where a hosted workspace may not want a resident agent burning quota).
4. **Does the hosted relay expose automations in v1 of the unified view?** The relay currently proxies sessions; runs/recipes would need proxying + share-permission mapping (viewer sees runs, editor can launch?).
5. **Budget/quota ownership.** All background AI (utility calls, Joe, runs) bills the user's own subscriptions today (a deliberate design note in `server/config.ts:135-139`). A unified automation surface makes spend far more visible — should the run ledger's cost tracking roll up into a per-repo/per-day budget with a global kill switch?
