# Documentation Audit: codekin

**Date**: 2026-09-02T01:23:12.515Z
**Repository**: /srv/repos/Multiplier-Labs/codekin
**Branch**: feat/deployments-ui
**Workflow Run**: d1de5175-f4cb-4d9d-aa2c-51afeaf5e2ef
**Session**: a59c0004-879f-4c28-b3d1-5363c04b49d1

---

Now I have enough information to compile the full documentation audit report.

---

# Documentation Audit — Codekin
**Date**: 2026-09-02  
**Branch**: feat/deployments-ui  
**Auditor**: Automated documentation audit workflow

---

## Summary

The Codekin documentation corpus consists of **34 files** across root, `docs/`, `design_handoff_codekin_styling/`, and `server/` directories (excluding `.codekin/reports/` which are generated audit outputs, and `server/workflows/*.md` which are workflow prompt definitions, not developer documentation).

**Key findings**:
- The CHANGELOG is frozen at v0.8.0 (2026-08-05), leaving ~74 commits undocumented — including deployments monitoring, host probes, trigger engine, durable signals, relay pairing, device-link/passkeys, Automations UI, and agent-agnostic Joe.
- `docs/FEATURES.md` (last updated 2026-06-03) is missing Goal Runs, the Automations view, deployment monitoring, and all features shipped in v0.8.0 and later.
- `docs/API-REFERENCE.md` is missing two entire API surfaces: `/api/goal-runs` (Goal Runs) and `/api/deployments` (Deployment Monitoring).
- `docs/SESSION-HANDOFF-SPEC.md` is marked "draft / ideation" but Phase 1 shipped in PR #548.
- `docs/HOSTED-RELAY-CONTROL-PLANE-SPEC.md` and `docs/HOSTED-RELAY-IMPLEMENTATION-PLAN.md` are design-phase documents for functionality that is now fully live.
- `design_handoff_codekin_styling/` (9 files) is a task-list / design brief that served its purpose when the design was being implemented — it has no reference value for users or contributors now that the work is shipped.
- `docs/stream-json-protocol.md` (last updated 2026-04-08) predates the Codex/OpenCode providers, `set_provider`, `move_to_worktree`, and the goal-run push channel.

**Health rating: Needs cleanup** — the core reference docs (API-REFERENCE, OPERATIONS, SETUP) are solid but significantly out of date, and the corpus is cluttered by completed spec/design documents and an empty CHANGELOG.

---

## Documentation Inventory

### Primary documentation (included in scope)

| Path | Lines | Last Modified | Purpose | Status |
|------|-------|---------------|---------|--------|
| `README.md` | 116 | 2026-08-05 | Public-facing install, usage, feature list | Mostly current — missing post-v0.8.0 features |
| `CHANGELOG.md` | 668 | 2026-08-05 | Version history | Stale — v0.8.0 is the last entry; ~74 commits unlogged |
| `CLAUDE.md` | 82 | 2026-08-05 | Codebase orientation for Claude Code | Current |
| `CONTRIBUTING.md` | 116 | 2026-05-15 | Developer setup and conventions | Stale — server install step outdated |
| `CODE_OF_CONDUCT.md` | 31 | 2026-03-08 | Community standards | Current (evergreen) |
| `SECURITY.md` | 43 | 2026-03-08 | Vulnerability reporting | Current (evergreen) |
| `docs/API-REFERENCE.md` | 812 | 2026-08-06 | REST & WebSocket API | Stale — missing `/api/goal-runs` and `/api/deployments` |
| `docs/DEPLOYMENTS.md` | 84 | 2026-08-30 | Deployment monitoring reference | Current |
| `docs/DEVICE-LINK-AND-PASSKEY-SPEC.md` | 336 | 2026-08-29 | Device-link QR + passkey spec | Spec = shipped; status header not updated |
| `docs/FEATURES.md` | 420 | 2026-06-03 | User-facing feature reference | Outdated — predates Goal Runs, Automations, Deployments, v0.8.0 design overhaul |
| `docs/GITHUB-WEBHOOKS-SPEC.md` | 953 | 2026-08-05 | Webhook integration spec (Phase 1 live) | Partially stale — in-memory event queue claim contradicted by durable signals |
| `docs/HOSTED-RELAY-CONTROL-PLANE-SPEC.md` | 625 | 2026-08-08 | Hosted relay architecture spec | Spec superseded — feature is live; document is now historical |
| `docs/HOSTED-RELAY-IMPLEMENTATION-PLAN.md` | 301 | 2026-08-09 | Implementation plan for hosted relay | Plan superseded — work complete |
| `docs/INSTALL-DISTRIBUTION.md` | 186 | 2026-05-15 | npm distribution / install guide | Stale — missing `stop`, `upgrade`, `uninstall` CLI commands |
| `docs/LOOPS.md` | 128 | 2026-08-29 | Goal Runs (Loop Runs) reference | Current |
| `docs/OPERATIONS.md` | 425 | 2026-08-09 | Ops guide for rate limiting, workflow engine, relay | Stale — missing Deployment Monitoring operations |
| `docs/ORCHESTRATOR-SPEC.md` | 769 | 2026-08-30 | Agent Joe architecture reference | Mostly current — new Joe features (durable signals, MCP server, trust-gated prompts) minimally covered |
| `docs/SESSION-HANDOFF-SPEC.md` | 204 | 2026-08-08 | Cross-harness session handoff spec | Stale status — still marked "draft/ideation" though Phase 1 shipped in PR #548 |
| `docs/SETUP.md` | 438 | 2026-06-03 | Advanced/bare-metal deployment guide | Stale — directory structure table has gaps; points to `/etc/systemd/system` (root), inconsistent with INSTALL-DISTRIBUTION |
| `docs/stream-json-protocol.md` | 566 | 2026-04-08 | Claude Code stream-JSON protocol internals | Outdated — predates Codex/OpenCode, `set_provider`, `move_to_worktree`, goal-run push events |
| `docs/WORKFLOWS.md` | 226 | 2026-08-30 | Workflow system reference | Current |
| `design_handoff_codekin_styling/README.md` | 125 | 2026-08-05 | Design handoff index for styling tasks | Obsolete — tasks shipped (PR #522/#523); no ongoing value |
| `design_handoff_codekin_styling/01-type-scale.md` | 60 | 2026-08-04 | Task prompt: type scale implementation | Obsolete — implemented |
| `design_handoff_codekin_styling/02-derive-scopes.md` | 95 | 2026-08-05 | Task prompt: token scope rationalisation | Obsolete — revised and deferred indefinitely |
| `design_handoff_codekin_styling/03-semantic-tokens.md` | 72 | 2026-08-04 | Task prompt: semantic token migration | Obsolete — implemented |
| `design_handoff_codekin_styling/04-surfaces.md` | 58 | 2026-08-04 | Task prompt: surfaces implementation | Obsolete — implemented |
| `design_handoff_codekin_styling/05-transcript.md` | 70 | 2026-08-04 | Task prompt: transcript layout | Obsolete — implemented |
| `design_handoff_codekin_styling/06-density.md` | 51 | 2026-08-04 | Task prompt: density token implementation | Obsolete — implemented |
| `design_handoff_codekin_styling/07-composer.md` | 107 | 2026-08-05 | Task prompt: composer implementation | Obsolete — implemented |
| `design_handoff_codekin_styling/08-sidebar-and-drawer.md` | 107 | 2026-08-05 | Task prompt: sidebar/drawer implementation | Obsolete — implemented |
| `design_handoff_codekin_styling/09-chrome-palette.md` | 79 | 2026-08-05 | Task prompt: chrome palette | Obsolete — implemented |

### Operational prompts (workflow definitions — not developer docs)

These are workflow prompt definitions consumed by the Codekin workflow engine, not developer documentation. They are listed for completeness but excluded from the staleness and consolidation analysis.

| Path | Lines | Last Modified |
|------|-------|---------------|
| `server/workflows/code-review.daily.md` | 22 | 2026-03-08 |
| `server/workflows/comment-assessment.daily.md` | 41 | 2026-03-08 |
| `server/workflows/commit-review.md` | 22 | 2026-03-11 |
| `server/workflows/complexity.weekly.md` | 54 | 2026-03-08 |
| `server/workflows/coverage.daily.md` | 41 | 2026-03-08 |
| `server/workflows/dependency-health.daily.md` | 46 | 2026-03-08 |
| `server/workflows/docs-audit.weekly.md` | 97 | 2026-03-14 |
| `server/workflows/pr-review.md` | 27 | 2026-04-10 |
| `server/workflows/repo-health.weekly.md` | 111 | 2026-03-09 |
| `server/workflows/security-audit.weekly.md` | 66 | 2026-03-08 |
| `server/loops/ci-autorepair.md` | 24 | 2026-06-14 |
| `server/loops/coverage-increase.md` | 23 | 2026-06-14 |
| `server/loops/dependency-upgrade.md` | 26 | 2026-06-14 |

---

## Staleness Findings

### 1. CHANGELOG.md — frozen at v0.8.0 (2026-08-05)

Approximately 74 commits have landed since the v0.8.0 entry, including major features with no changelog entries:

- Trigger engine core with pre-dispatch gates, trigger ledger, heartbeat (#602)
- Repo Activity Index (tiers, dispatch gating, Joe visibility) (#603)
- Agent-agnostic orchestrator — persisted harness, AGENTS.md (#604)
- Durable signals — at-least-once event queue in trigger engine (#605)
- Deployments monitoring: registry, probes, breach signals (#606)
- Incident response — auto-diagnosed breaches, security probes (#607)
- Host probe family, propose-tier maintenance, weekly digest (#608)
- Deployments UI tab in Automations (current branch, unreleased)
- One-line relay install-and-pair (#596)
- QR device linking and passkey sign-in (#573) — also absent from CHANGELOG
- Unified Automations view (#582)
- Unified run store and read model (#585, #591)

### 2. docs/FEATURES.md — predates v0.8.0 entirely

Last updated 2026-06-03. Missing entire feature categories:

- **Goal Runs / Loop Runs** — act→verify→continue loops (v0.8.0, #517)
- **Automations view** — unified UI tab covering Workflows, Loop Runs, and Deployments (#582)
- **Deployment Monitoring** — registry, probes, breach signals, incident response (#606–#608)
- **Design system overhaul** results — the feature list still describes the pre-overhaul UI (#522–#534)
- **Agent Joe resilience features** — durable notifications, trust-gated prompts, MCP server, trigger-engine integration (#574, #586–#590, #602–#605)
- **Hosted relay improvements** — device-link, passkeys, one-click pairing (#573, #596)
- **Session handoff** — `set_provider` with `carryContext` flag (#548)

### 3. docs/API-REFERENCE.md — two missing API surfaces

Last updated 2026-08-06, covers the orchestrator API added around that date. Missing:

- **`/api/goal-runs`** (Goal Runs) — templates, runs, ledger, start, abort (all documented in `docs/LOOPS.md` but not in the central API reference)
- **`/api/deployments`** — full CRUD registry, discovery, and sample history endpoints

### 4. docs/SESSION-HANDOFF-SPEC.md — status header not updated

File says `Status: **draft / ideation**` but PR #548 shipped Phase 1 (`set_provider` with `carryContext`). The spec describes three phases; Phase 1 is live, Phases 2 (external import) and 3 (`/handoff` export) are still pending.

### 5. docs/stream-json-protocol.md — predates Codex/OpenCode integration (2026-04-08)

Missing from the protocol documentation:
- `set_provider` client→server message (cross-harness switching with `carryContext`)
- `move_to_worktree` client→server message
- `CodingProvider` type (`claude | opencode | codex`)
- Provider field on `session_created` / `session_joined` messages
- Goal-run event push channel types

### 6. docs/GITHUB-WEBHOOKS-SPEC.md — event queue claim contradicted by code

Line 523 states the webhook event queue is an "In-memory bounded queue (max 50 pending events)". The durable signals system (PR #605, 2026-08-30) replaced in-memory event handling with a DB-backed at-least-once queue. The claim is now inaccurate for the parts of the webhook stack that publish into the durable signal queue.

### 7. docs/INSTALL-DISTRIBUTION.md — incomplete CLI command table

The CLI table (7 commands) is missing commands documented in `bin/codekin.mjs` and `README.md`:
- `codekin stop` — stop the running background service
- `codekin upgrade` — upgrade to latest version
- `codekin uninstall` — remove Codekin entirely
- `codekin relay <cmd>` — hosted relay pairing and connector

### 8. docs/SETUP.md — directory structure table outdated

The `## Directory Structure` section lists `server/upload-routes.ts` as a key file and `nginx/codekin.example` (correct, exists) but shows an incomplete server directory. It also lists `/etc/systemd/system/codekin.service` in the Key File Paths table — this is the root-level systemd path for the bare-metal guide, which is internally consistent, but a note that the distribution method uses the user-level path (`~/.config/systemd/user/`) would prevent confusion.

### 9. docs/OPERATIONS.md — missing Deployment Monitoring operations

The ops guide covers rate limiting, workflow restart-resume, and the hosted relay configuration, but has no section on:
- Configuring and operating the deployment registry (`~/.codekin/deployments.json`)
- Probe breach/recovery signal flow and the 6-hour cooldown
- Auto-diagnosis cooldown and the children cap (5) for incident response
- Host probe and weekly digest configuration

---

## Accuracy Issues

### A1. CONTRIBUTING.md — stale server install step

`CONTRIBUTING.md:24` says: `npm install --prefix server`

The server has its own `package.json` and `node_modules`, so this instruction is technically correct. However, `CLAUDE.md` only says `npm install` (root only). These should be aligned — either CONTRIBUTING.md should explain why the server step is needed, or the two files should agree on the single command.

### A2. docs/SETUP.md — references outdated `/api/health` response shape

Line 397 documents the health endpoint returning `{"status":"ok","claudeAvailable":true,"claudeVersion":"...","apiKeySet":true,...}`. The current health endpoint returns additional fields for Codex and OpenCode availability (`codexAvailable`, `codexAuthenticated`, `openCodeAvailable`) that are not shown.

### A3. docs/ORCHESTRATOR-SPEC.md — Phase 4 not mentioned

The spec lists Phases 1–3 as complete, and one Phase 3 item ("auto-suggest workflow setup for new repos") as remaining. Several significant post-v0.8.0 Joe features are not reflected in the spec's architecture description:
- First-party Codekin MCP server registered in `.mcp.json` (#587)
- Trust-gated prompt handling (audit B5, #590)
- Joe hears loop-run events via the shared push channel (#588)
- Agent-agnostic harness choice persisted to settings (#604)

### A4. docs/DEVICE-LINK-AND-PASSKEY-SPEC.md — shipped but still marked "Draft spec"

The spec header says `**Status**: Draft spec` despite the feature shipping in PR #573 (QR device linking and passkeys). Phase 1 (device link) and Phase 2 (passkeys) are both complete per the CHANGELOG and git log.

### A5. docs/HOSTED-RELAY-CONTROL-PLANE-SPEC.md — "Draft architecture spec"

Header still says `**Status**: Draft architecture spec`. The relay is live at `app.codekin.ai` and all four implementation phases from `HOSTED-RELAY-IMPLEMENTATION-PLAN.md` have shipped.

---

## Overlap & Redundancy

### Group 1: Setup / Installation overlap

`docs/SETUP.md` (438 lines) and `docs/INSTALL-DISTRIBUTION.md` (186 lines) cover overlapping ground: both describe environment variables, the auth token, and how to run the server. The split is intentional (bare-metal vs npm distribution), but the files share the env-var table and the troubleshooting section, which creates a maintenance burden.

- **More complete**: `docs/SETUP.md` (system-service config, nginx, Authelia, webhooks)
- **More current target audience**: `docs/INSTALL-DISTRIBUTION.md` (most users)
- **Recommendation**: Move the shared env-var table to a single `docs/CONFIGURATION.md` include-reference and link from both. Do not merge — the audiences are different.

### Group 2: Hosted relay — spec + plan + operations section

Three documents cover the hosted relay:
- `docs/HOSTED-RELAY-CONTROL-PLANE-SPEC.md` (625 lines) — the original design spec
- `docs/HOSTED-RELAY-IMPLEMENTATION-PLAN.md` (301 lines) — the original implementation plan
- `docs/OPERATIONS.md` §"Hosted Relay" (≈100 lines) — the current ops reference

Now that the relay is live, the spec and plan are historical design documents. The operational information in `OPERATIONS.md` is authoritative and current. The two spec/plan files should be archived or deleted; their operational content (config table, user management) is already duplicated in `OPERATIONS.md`.

### Group 3: API surface split between API-REFERENCE.md and LOOPS.md

`docs/LOOPS.md` contains a small API table for `/api/goal-runs` endpoints. This is the only API surface documented outside `docs/API-REFERENCE.md`. The split is minor but creates inconsistency — a developer consulting the API reference will miss the goal-runs endpoints. The LOOPS.md table should remain (it's contextually useful) but the API-REFERENCE.md should also gain the section.

### Group 4: Orchestrator documented in three places

Agent Joe's architecture is spread across:
- `docs/ORCHESTRATOR-SPEC.md` (769 lines) — comprehensive architectural reference
- `docs/FEATURES.md` §"Agent Joe Orchestrator" (≈15 lines) — user-facing summary
- `docs/API-REFERENCE.md` §"Orchestrator (Agent Joe)" (≈250 lines) — REST API

This three-way split is appropriate: spec → user-facing → API. No merge recommended, but the spec and features pages need synchronising with shipped post-v0.8.0 Joe capabilities.

---

## Fragmentation

### F1. design_handoff_codekin_styling/ — 10 files for a completed one-time task

This directory contains a design brief (`README.md`) and 9 task-prompt files (01–09) that were used to drive a specific implementation refactor shipped in PRs #522–#534 (v0.8.0). The work is complete (with Task 02 revised and deferred indefinitely). These files:
- Are not referenced by any other document in the repo
- Are not prompt definitions consumed by the workflow engine
- Have no ongoing reference value — the canonical styling rules are in `CLAUDE.md` and `src/index.css`

The entire `design_handoff_codekin_styling/` directory is a fragmented, orphaned implementation artifact.

### F2. SESSION-HANDOFF-SPEC.md — describes a feature that is partially shipped

The spec outlines three phases. Phase 1 is live as `set_provider` with `carryContext`. The spec as written is still useful as a reference for Phases 2 and 3, but its "draft/ideation" framing should be updated and the shipped portion should be clearly marked.

### F3. GITHUB-WEBHOOKS-SPEC.md — very large spec for Phase 1 only

At 953 lines, the spec documents all four planned phases exhaustively, but only Phase 1 (`workflow_run` CI failures + PR review) is shipped. The remaining ~600 lines describe Phases 2–4 which are unimplemented roadmap. The spec is the canonical reference, so deletion is not appropriate, but the Phase 1 portions should be clearly separated from roadmap content.

---

## Action Items

### Delete

| File | Reason it is safe to delete |
|------|----------------------------|
| `design_handoff_codekin_styling/01-type-scale.md` | Task prompt for work shipped in PR #522; no ongoing reference value |
| `design_handoff_codekin_styling/02-derive-scopes.md` | Deferred indefinitely after measurement showed pixel-neutrality is impossible; the conclusion is in the file itself and in the CLAUDE.md styling rules |
| `design_handoff_codekin_styling/03-semantic-tokens.md` | Task prompt shipped in PR #522 |
| `design_handoff_codekin_styling/04-surfaces.md` | Task prompt shipped in PR #522 |
| `design_handoff_codekin_styling/05-transcript.md` | Task prompt shipped in PR #522 |
| `design_handoff_codekin_styling/06-density.md` | Task prompt shipped in PR #522 |
| `design_handoff_codekin_styling/07-composer.md` | Task prompt shipped in PR #523 |
| `design_handoff_codekin_styling/08-sidebar-and-drawer.md` | Task prompt shipped in PRs #523, #526 |
| `design_handoff_codekin_styling/09-chrome-palette.md` | Task prompt shipped in PR #523 |
| `design_handoff_codekin_styling/README.md` | Design brief index; all tasks complete; not referenced elsewhere |
| `docs/HOSTED-RELAY-IMPLEMENTATION-PLAN.md` | Plan for work that is complete; operational content is already in `docs/OPERATIONS.md`; git history preserves the decision record |

### Consolidate

| Source files | Target file | What to keep / drop |
|---|---|---|
| `docs/HOSTED-RELAY-CONTROL-PLANE-SPEC.md`, archived | `docs/OPERATIONS.md` §"Hosted Relay" | Keep: current OPERATIONS.md section (config table, user management, deploy steps). From spec: extract and add the security model summary (GitHub id vs login rationale) and the connector's path allowlist behaviour — these are not in OPERATIONS.md. Drop: design diagrams, phase sequencing, and the "Non-Goals" section (historical). |
| `docs/LOOPS.md` API table | `docs/API-REFERENCE.md` | Duplicate the 5-row `/api/goal-runs` table into API-REFERENCE.md under a new `## Goal Runs` section. Keep LOOPS.md table as contextual inline reference. |

### Update

| File | Sections needing update | What changed in code |
|------|------------------------|----------------------|
| `CHANGELOG.md` | Add `[Unreleased]` or `[0.9.0]` section | 74 commits since v0.8.0 including deployments monitoring, host probes, durable signals, trigger engine, relay pairing, passkeys, Automations view, agent-agnostic Joe, unified run store |
| `docs/FEATURES.md` | Add: Goal Runs, Automations view, Deployment Monitoring, hosted relay improvements; Update: Agent Joe section with durable notifications/trust/MCP; Update architecture overview | All post-v0.8.0 feature work; entire v0.8.0 design system overhaul descriptions |
| `docs/API-REFERENCE.md` | Add `## Goal Runs` section, add `## Deployment Monitoring` section | `/api/goal-runs` routes (LOOPS.md has the table); `/api/deployments` routes (deployment-routes.ts) |
| `docs/SESSION-HANDOFF-SPEC.md` | Update status header; add "Phase 1 — Shipped" section at top | PR #548 shipped `set_provider` with `carryContext`; Phases 2–3 still pending |
| `docs/DEVICE-LINK-AND-PASSKEY-SPEC.md` | Change `Status: Draft spec` → `Status: Shipped (v0.8+)` | PR #573 shipped QR device linking and passkeys |
| `docs/HOSTED-RELAY-CONTROL-PLANE-SPEC.md` | Change `Status: Draft architecture spec` → `Status: Live — see docs/OPERATIONS.md for operations` | Relay is live at app.codekin.ai |
| `docs/ORCHESTRATOR-SPEC.md` | Add Phase 4 entries: Codekin MCP server, trust-gated prompts, loop-run events, agent-agnostic harness | PRs #587, #588, #590, #604 |
| `docs/OPERATIONS.md` | Add `## Deployment Monitoring` section covering registry, probe ops, breach cooldown, incident response, host probe, weekly digest | PRs #606–#608 |
| `docs/stream-json-protocol.md` | Add: `set_provider` message, `move_to_worktree` message, `CodingProvider` type, provider field on session messages, goal-run push event types; update permission modes table for `dangerouslySkipPermissions` | PRs #499, #548, and goal-run push channel (#578) |
| `docs/INSTALL-DISTRIBUTION.md` | Add `stop`, `upgrade`, `uninstall`, `relay` to the CLI command table | `bin/codekin.mjs` has these commands; README documents them |
| `docs/GITHUB-WEBHOOKS-SPEC.md` | Update event queue description (line 523): replace "in-memory bounded queue" with "durable DB-backed signal queue (at-least-once, 24h TTL, 3 retries)" | PR #605 — durable signals replaced in-memory queue |
| `CONTRIBUTING.md` | Clarify whether `npm install --prefix server` is required (CLAUDE.md says only `npm install`) | Server has its own `package.json`; the two files disagree |

---

## Recommendations

1. **Write the CHANGELOG `[Unreleased]` section immediately.** Seventy-four commits without a changelog entry is the single biggest documentation gap. The features shipped (deployments monitoring, trigger engine, durable signals, Automations view, device links, passkeys) are product-significant and undiscoverable from the changelog.

2. **Delete `design_handoff_codekin_styling/` in one PR.** All 10 files are orphaned task prompts for shipped work. They add noise to `git log`, confuse contributors browsing the repo, and are not referenced by any other file. Deleting the entire directory is a one-line PR with zero risk.

3. **Archive (or delete) `docs/HOSTED-RELAY-IMPLEMENTATION-PLAN.md` and update the spec's status header.** The implementation plan describes sequencing for work that is complete. The git history preserves the design record. Deleting the plan and changing the spec header from "Draft architecture spec" to "Live — see OPERATIONS.md" removes two pieces of misleading documentation.

4. **Add `/api/goal-runs` and `/api/deployments` sections to `docs/API-REFERENCE.md`.** These are two live API surfaces with no central reference. The LOOPS.md table covers goal-runs partially; deployment-routes.ts is not documented anywhere in `docs/`. A developer building against the API will not find these routes.

5. **Update `docs/FEATURES.md` to reflect v0.8.0 and later.** The feature reference is the primary document for understanding what Codekin does. It is three months out of date and missing Goal Runs, Automations, and Deployment Monitoring entirely — the three most significant feature additions since June 2026.

6. **Update `docs/SESSION-HANDOFF-SPEC.md` status.** The "draft / ideation" label is actively misleading. Phase 1 shipped in PR #548. Add a "What's shipped" section at the top before the design content.

7. **Update `docs/stream-json-protocol.md` for the three new providers.** The protocol document does not mention `set_provider`, Codex, or OpenCode. A developer integrating with Codekin over WebSocket will miss the cross-harness switching flow entirely.

8. **Add a Deployment Monitoring section to `docs/OPERATIONS.md`.** Operators need to know how to configure `~/.codekin/deployments.json`, what breach-cooldown means, and how auto-diagnosis interacts with the children cap. None of this is in the ops guide.

9. **Align `CONTRIBUTING.md` and `CLAUDE.md` on the server install step.** Either both should say `npm install && npm install --prefix server`, or only the root install is needed (if the server deps are hoisted). The current disagreement will cause confusion for new contributors.

10. **Add `CHANGELOG.md` updates to the PR template or definition-of-done.** The corpus will continue to drift if the changelog is not updated alongside code. The root cause of the current gap is a process issue, not a one-time fix.