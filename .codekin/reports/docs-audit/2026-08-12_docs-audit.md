# Documentation Audit: codekin

**Date**: 2026-08-12T01:20:05.276Z
**Repository**: /srv/repos/Multiplier-Labs/codekin
**Branch**: main
**Workflow Run**: eae522c4-9512-45fb-b125-08e5e2fba055
**Session**: d119d7f7-55f9-4f5a-8574-63851ccfeab8

---

Now I have enough information to write the complete audit report.

## Summary

**Total documentation files**: 18 primary docs (root + `docs/`) + 10 design handoff files + 9 workflow definitions + 3 loop templates = **40 documentation files** (excluding `.codekin/reports/` which are generated outputs, not maintained docs).

**Health rating**: **Needs cleanup** — the project's core reference docs are well-structured, but a significant divergence has opened between the feature set shipped in v0.7.0–v0.8.0 (June–August 2026) and what the narrative documentation covers. Two spec documents still carry "Draft" / "Proposed" status despite being fully implemented. The design handoff directory has served its purpose and is now stale process scaffolding living in the project root.

**Key findings**:
- `docs/FEATURES.md` is missing four major features shipped in the last 2 months (Goal Runs, Hosted Relay, Session Handoff, Session Sharing).
- `docs/HOSTED-RELAY-IMPLEMENTATION-PLAN.md` and `docs/HOSTED-RELAY-CONTROL-PLANE-SPEC.md` both carry draft/proposed status while the relay has been live at `app.codekin.ai` since August 2026.
- `docs/SESSION-HANDOFF-SPEC.md` still reads "draft / ideation" despite `handoff-manager.ts` being shipped.
- `docs/stream-json-protocol.md` is Claude-only but codekin now supports three providers (Claude, OpenCode, Codex).
- The `design_handoff_codekin_styling/` directory (9 task files + README) belongs as an internal implementation document, not permanent repo documentation.

---

## Documentation Inventory

| Path | Lines | Last Modified | Purpose | Status |
|---|---|---|---|---|
| `README.md` | 116 | 2026-08-05 | Public-facing overview, install, feature summary | Current |
| `CLAUDE.md` | 82 | 2026-08-05 | AI assistant coding conventions | Current |
| `CHANGELOG.md` | 668 | 2026-08-05 | Version history through v0.8.0 | Current |
| `CONTRIBUTING.md` | 116 | 2026-05-15 | Dev setup, PR guidelines | Stale |
| `CODE_OF_CONDUCT.md` | 31 | 2026-03-08 | Community conduct policy | Current |
| `SECURITY.md` | 43 | 2026-03-08 | Vulnerability disclosure policy | Current |
| `docs/API-REFERENCE.md` | 812 | 2026-08-06 | REST + WebSocket API reference | Stale |
| `docs/FEATURES.md` | 420 | 2026-06-03 | User-facing feature reference | Outdated |
| `docs/GITHUB-WEBHOOKS-SPEC.md` | 953 | 2026-08-05 | Webhook integration spec + PR review | Stale |
| `docs/HOSTED-RELAY-CONTROL-PLANE-SPEC.md` | 625 | 2026-08-08 | Architecture spec for hosted relay | Stale |
| `docs/HOSTED-RELAY-IMPLEMENTATION-PLAN.md` | 301 | 2026-08-08 | Implementation plan for hosted relay | Stale |
| `docs/INSTALL-DISTRIBUTION.md` | 186 | 2026-05-15 | npm distribution, CLI, release process | Current |
| `docs/OPERATIONS.md` | 392 | 2026-08-08 | Ops runbook for production | Current |
| `docs/ORCHESTRATOR-SPEC.md` | 748 | 2026-04-25 | Agent Joe reference doc | Stale |
| `docs/SESSION-HANDOFF-SPEC.md` | 204 | 2026-08-08 | Cross-harness session handoff design | Stale |
| `docs/SETUP.md` | 438 | 2026-06-03 | Self-hosted bare-metal setup guide | Stale |
| `docs/stream-json-protocol.md` | 566 | 2026-04-08 | Claude stream-JSON protocol reference | Outdated |
| `docs/WORKFLOWS.md` | 187 | 2026-06-03 | Automated workflow system guide | Current |
| `design_handoff_codekin_styling/README.md` | 125 | 2026-08-05 | Design handoff task overview | Redundant |
| `design_handoff_codekin_styling/01-type-scale.md` | 60 | 2026-08-04 | Type scale task prompt | Redundant |
| `design_handoff_codekin_styling/02-derive-scopes.md` | 95 | 2026-08-05 | Scope derivation task prompt | Redundant |
| `design_handoff_codekin_styling/03-semantic-tokens.md` | 72 | 2026-08-04 | Semantic token task prompt | Redundant |
| `design_handoff_codekin_styling/04-surfaces.md` | 58 | 2026-08-04 | Surfaces task prompt | Redundant |
| `design_handoff_codekin_styling/05-transcript.md` | 70 | 2026-08-04 | Transcript task prompt | Redundant |
| `design_handoff_codekin_styling/06-density.md` | 51 | 2026-08-04 | Density task prompt | Redundant |
| `design_handoff_codekin_styling/07-composer.md` | 107 | 2026-08-05 | Composer task prompt | Redundant |
| `design_handoff_codekin_styling/08-sidebar-and-drawer.md` | 107 | 2026-08-05 | Sidebar/drawer task prompt | Redundant |
| `design_handoff_codekin_styling/09-chrome-palette.md` | 79 | 2026-08-05 | Chrome palette task prompt | Redundant |
| `server/loops/ci-autorepair.md` | 24 | 2026-06-14 | Loop template: CI autorepair | Current |
| `server/loops/coverage-increase.md` | 23 | 2026-06-14 | Loop template: coverage increase | Current |
| `server/loops/dependency-upgrade.md` | 26 | 2026-06-14 | Loop template: dependency upgrade | Current |
| `server/workflows/code-review.daily.md` | 22 | 2026-03-08 | Built-in daily code review workflow | Current |
| `server/workflows/comment-assessment.daily.md` | 41 | 2026-03-08 | Built-in daily comment assessment | Current |
| `server/workflows/commit-review.md` | 22 | 2026-03-11 | Event-driven commit review workflow | Current |
| `server/workflows/complexity.weekly.md` | 54 | 2026-03-08 | Built-in weekly complexity report | Current |
| `server/workflows/coverage.daily.md` | 41 | 2026-03-08 | Built-in daily coverage workflow | Current |
| `server/workflows/dependency-health.daily.md` | 46 | 2026-03-08 | Built-in daily dependency health | Current |
| `server/workflows/docs-audit.weekly.md` | 97 | 2026-03-14 | Built-in weekly docs audit | Current |
| `server/workflows/pr-review.md` | 27 | 2026-04-10 | Event-driven PR review workflow | Current |
| `server/workflows/repo-health.weekly.md` | 111 | 2026-03-09 | Built-in weekly repo health | Current |
| `server/workflows/security-audit.weekly.md` | 66 | 2026-03-08 | Built-in weekly security audit | Current |

---

## Staleness Findings

### 1. `docs/FEATURES.md` — Missing four major features (last updated 2026-06-03)

78 commits landed in `src/` and `server/` after this file was last touched. The following entire feature areas are absent:

- **Goal Runs** (v0.8.0, shipped PR #517) — the durable act→verify→continue loop with templates, evidence ledger, maker-checker review, PR write-back. This is prominently featured in `README.md` as the second bullet under Features but has no entry in `FEATURES.md`.
- **Hosted Relay / app.codekin.ai** (PRs #544–#552, #558) — 8 PRs shipped full relay: transport abstraction, control plane, machine pairing, REST proxy, session streaming, session sharing/ACLs, relay hardening. None of this appears in `FEATURES.md`.
- **Cross-harness Session Handoff** (PR #548) — `handoff-manager.ts` is live, but `FEATURES.md` has no entry.
- **Session Sharing and ACLs** (PR #550) — share links, audit events, per-session ACLs over the relay. Missing entirely.

### 2. `docs/HOSTED-RELAY-IMPLEMENTATION-PLAN.md` — Status says "Proposed" but relay is live

Line 4: `**Status**: Proposed`. The relay was fully implemented across PRs #544–#558 and has been running at `app.codekin.ai` since August 2026. The plan also describes `server/connector/` as a distinct directory that was never created (the connector code lives in `server/relay/`).

### 3. `docs/HOSTED-RELAY-CONTROL-PLANE-SPEC.md` — Status says "Draft architecture spec" but is shipped

Line 3: `**Status**: Draft architecture spec`. Same gap as the implementation plan — the relay is deployed and operational, not a draft.

### 4. `docs/SESSION-HANDOFF-SPEC.md` — Status says "draft / ideation" but implementation is shipped

Line 5: `Status: **draft / ideation**`. `server/handoff-manager.ts` exists and `feat: cross-harness session handoff` (PR #548) shipped on 2026-08-08. The spec predates implementation and does not reflect the actual shipped interface.

### 5. `docs/stream-json-protocol.md` — Claude-only; doesn't cover OpenCode or Codex (last updated 2026-04-08)

The document title is "Claude Code Stream-JSON Protocol." Since then, two additional providers have shipped:
- **OpenCode** (native JSON/REST integration, PR #494, v0.7.0)
- **OpenAI Codex** (JSON-RPC 2.0 over stdio, PR #499, v0.7.0)

Both have their own `server/opencode-process.ts` and `server/codex-process.ts` but no documentation. The single-provider framing of the document is now misleading.

### 6. `docs/ORCHESTRATOR-SPEC.md` — Version references outdated (last updated 2026-04-25)

Line 5: references `v0.5.2` and `v0.5.0` as milestones. Current version is v0.8.0. The document's content is otherwise accurate, but the version pinning is stale and the pending roadmap item ("auto-suggest workflow setup for new repos") has no tracking of whether it was implemented.

### 7. `docs/SETUP.md` — Server directory listing is dramatically simplified (last updated 2026-06-03)

Line 411–415 shows only three files in `server/`: `upload-routes.ts`, `ws-server.ts`, `package.json`. The `server/` directory now contains 80+ files including full orchestrator, webhook, goal-run, relay, and handoff subsystems. The directory tree in SETUP.md gives a false impression of the server's scope.

### 8. `CONTRIBUTING.md` — Separate server install step may be unnecessary (last updated 2026-05-15)

Line 23–24: `npm install --prefix server`. The root `package.json` does not include a `postinstall` script to handle this automatically, so the step is still correct — but the guide does not mention that `server/` has its own `node_modules` for a reason (different dependency set). This is a minor clarity gap rather than a broken instruction.

---

## Accuracy Issues

### 1. `docs/SETUP.md` — references `settings.example.json` fields that may not match current schema

The "Deploy Settings" section (step 6) documents `webRoot`, `distDir`, `serverDir`, `port`, `authFile`, `log` as `settings.json` fields. The example file exists at `.codekin/settings.example.json` but its actual fields should be verified against `server/config.ts` for accuracy. This is a medium risk — the env variable reference (`FRONTEND_DIST`) in the same section is the correct modern approach for containerized deploys, but the `settings.json` path is still presented as the primary mechanism.

### 2. `docs/SETUP.md` — Directory structure in "Directory Structure" section is stale

The server block shows only `upload-routes.ts`, `ws-server.ts`, and `package.json`. The real server has grown to 80+ TypeScript files. A reader following this diagram would be confused when navigating the actual code.

### 3. `docs/GITHUB-WEBHOOKS-SPEC.md` — PR review status is ambiguous

The header says "Phase 1 implemented and in production. Phases 2-4 are roadmap." But the spec body (line 141) marks `pull_request` as `Implemented` with a pointer to the "PR Review Implementation" section (line 763). This is internally consistent but the status line is misleading — PR review is implemented but lumped in with unimplemented phases 2–4 in the status summary.

### 4. `docs/API-REFERENCE.md` — Relay API endpoints are not documented (last updated 2026-08-06)

The file covers local server endpoints comprehensively but has no section for the relay server endpoints: `GET /api/machines`, `POST /api/machines/pair/start`, `POST /api/machines/pair/complete`, `GET /api/me`, `GET /api/shares`, `POST /api/shares`, `GET /api/audit-events`, GitHub OAuth endpoints. These were implemented in `server/relay/` (PRs #545–#552) and deployed 2 days after the API reference's last update.

### 5. `docs/INSTALL-DISTRIBUTION.md` — References `bin/codekin.mjs` as `connector.ts` entrypoint

The relay implementation plan (line 128) describes `server/relay/connector-cli.ts` as the connector entry point. The INSTALL-DISTRIBUTION.md references only `bin/codekin.mjs` and `server/dist/`. With the relay connector now living in `server/relay/connector-cli.ts`, the CLI section doesn't reflect the `codekin relay login` and `codekin relay connect` commands mentioned in `OPERATIONS.md`.

### 6. `docs/stream-json-protocol.md` — `--session-id` flag documentation may be stale

The document describes session spawning with `--session-id <UUID>`. However, the flag reference table and permission modes section were last updated in April 2026, before the multi-provider work. The OpenCode and Codex providers use fundamentally different IPC mechanisms (native agents, JSON-RPC 2.0) that are not covered.

---

## Overlap & Redundancy

### Group 1: Setup / Installation (three documents with overlapping scope)

| File | Scope | Overlap |
|---|---|---|
| `README.md` | Install one-liner + feature list | Contains install instructions that duplicate INSTALL-DISTRIBUTION.md |
| `docs/INSTALL-DISTRIBUTION.md` | npm distribution, CLI, release process, bare-metal pointer | Bare-metal section explicitly defers to SETUP.md |
| `docs/SETUP.md` | Advanced self-hosted: nginx, Authelia, systemd | Duplicates env-var table found in CONTRIBUTING.md |

**Recommendation**: The scope boundaries are intentional and mostly clean. The only true overlap is the env-var reference table, which appears in both `docs/SETUP.md` (step 2) and `CONTRIBUTING.md` (Core Server Variables). The CONTRIBUTING.md table is slightly more complete (includes `SCREENSHOTS_DIR`, `GH_ORG`, `FRONTEND_DIST`). Consider making SETUP.md reference CONTRIBUTING.md for the full env-var list rather than maintaining a second copy.

### Group 2: Hosted Relay (spec + plan + operations section)

| File | Scope |
|---|---|
| `docs/HOSTED-RELAY-CONTROL-PLANE-SPEC.md` | Architecture spec (625 lines) |
| `docs/HOSTED-RELAY-IMPLEMENTATION-PLAN.md` | Implementation sequencing (301 lines) |
| `docs/OPERATIONS.md` §3 | Ops runbook for the live relay (75+ lines) |

The spec and plan were both created as pre-implementation design documents. Now that the relay is live, the OPERATIONS.md section is the authoritative operational reference. The spec and plan retain value as architecture context (especially trust boundaries and protocol decisions), but their "Draft" / "Proposed" status headers are actively misleading.

**Recommendation**: Update status headers on both to "Implemented". Consider whether HOSTED-RELAY-IMPLEMENTATION-PLAN.md (which describes a sequencing of PRs that are now all merged) serves ongoing readers or is purely historical.

### Group 3: Agent Joe (spec vs API reference)

| File | Scope |
|---|---|
| `docs/ORCHESTRATOR-SPEC.md` | Full Agent Joe design + API endpoint list (748 lines) |
| `docs/API-REFERENCE.md` | Orchestrator API section (covers same endpoints) |

The orchestrator endpoint list appears in both documents with different levels of detail. `ORCHESTRATOR-SPEC.md` provides character/UX context that `API-REFERENCE.md` doesn't; the endpoint list in the spec is a secondary artifact of the narrative. No merge needed, but the spec's endpoint list should be marked as a summary with a pointer to API-REFERENCE.md as the authoritative source.

---

## Fragmentation

### 1. Design handoff directory — 10 files that are implementation-complete task prompts

`design_handoff_codekin_styling/` contains a README and 9 numbered task files (01 through 09). The README explains these were "Claude Code task prompts" for a one-time styling refactor. Tasks 01–09 were shipped in v0.8.0 (PRs #522–#534), with the only deferred item being Task 02's oklch ramp (noted in project memory as awaiting direction).

These files are not reference documentation — they are one-shot implementation prompts that have already been executed. They have no ongoing navigational value for users or contributors and add confusion by sitting in the project root alongside `src/`, `server/`, and `docs/`.

### 2. Provider protocol documentation — one file for Claude, nothing for OpenCode or Codex

`docs/stream-json-protocol.md` covers only the Claude Code stream-JSON protocol. OpenCode (native agents, JSON/REST) and Codex (JSON-RPC 2.0 over stdio, thread-based) have their own protocol adapters (`server/opencode-process.ts`, `server/codex-process.ts`) with no documentation. Either the existing file should become a "provider protocols" umbrella document, or two companion files should be added.

### 3. Spec/plan documents describing completed work — candidates for status update or archival

Both `docs/HOSTED-RELAY-CONTROL-PLANE-SPEC.md` and `docs/HOSTED-RELAY-IMPLEMENTATION-PLAN.md` were written as pre-ship planning documents. They remain valuable as architecture records but their current-state language ("we will...") reads as forward-looking when the work is done. `docs/SESSION-HANDOFF-SPEC.md` has the same issue — "draft / ideation" when Phase 1 is shipped.

### 4. `docs/GITHUB-WEBHOOKS-SPEC.md` — 953 lines mixing implemented and roadmap content

Phase 1 + PR review are implemented; Phases 2–4 are not. The spec does not visually separate these, making it hard to quickly determine what's live. The Open Questions section (line ~940) and Roadmap section contain items some of which may have been resolved (e.g., `issue_comment` / `pull_request_review` are listed as roadmap but the checkbox format suggests they were tracked differently).

---

## Action Items

### Delete

| File | Reason it's safe to delete |
|---|---|
| `design_handoff_codekin_styling/01-type-scale.md` | One-shot task prompt; shipped in v0.8.0 PR #522. No ongoing reference value. |
| `design_handoff_codekin_styling/02-derive-scopes.md` | Same — shipped in v0.8.0; the oklch deferral is tracked in project memory and CLAUDE.md, not in this file. |
| `design_handoff_codekin_styling/03-semantic-tokens.md` | Shipped in v0.8.0 PR #522. |
| `design_handoff_codekin_styling/04-surfaces.md` | Shipped in v0.8.0 PR #522. |
| `design_handoff_codekin_styling/05-transcript.md` | Shipped in v0.8.0 PR #522. |
| `design_handoff_codekin_styling/06-density.md` | Shipped in v0.8.0 PR #522. |
| `design_handoff_codekin_styling/07-composer.md` | Shipped in v0.8.0 PR #530. |
| `design_handoff_codekin_styling/08-sidebar-and-drawer.md` | Shipped in v0.8.0 PR #534. |
| `design_handoff_codekin_styling/09-chrome-palette.md` | Shipped in v0.8.0 PR #523. |
| `design_handoff_codekin_styling/README.md` | Context document for the above task prompts; once tasks are deleted, this has no audience. |

### Consolidate

| Source Files | Target File | What to Keep / Drop |
|---|---|---|
| `docs/SETUP.md` (env-var table, step 2) + `CONTRIBUTING.md` (Core Server Variables table) | `CONTRIBUTING.md` | Keep the more complete CONTRIBUTING.md table (includes `SCREENSHOTS_DIR`, `GH_ORG`, `FRONTEND_DIST`); drop the shorter duplicate from SETUP.md and replace with a link to CONTRIBUTING.md. |
| `docs/HOSTED-RELAY-IMPLEMENTATION-PLAN.md` + `docs/HOSTED-RELAY-CONTROL-PLANE-SPEC.md` §7 relay protocol | Keep both but add a "Historical note" header | The plan is now historical (all PRs merged). Consider adding a note to its header and removing/archiving if the team decides the sequencing detail has no future value. The spec's architecture and trust boundary sections remain useful. |

### Update

| File | Sections Needing Update | What Changed in Code |
|---|---|---|
| `docs/FEATURES.md` | Entire file — add Goal Runs, Hosted Relay, Session Handoff, Session Sharing sections; update Agent Joe section to v0.8.0 resilience additions | PRs #517, #544–#552, #548, #550, #558 shipped four major feature areas after this file's last update (2026-06-03) |
| `docs/HOSTED-RELAY-IMPLEMENTATION-PLAN.md` | Header status line; §2 "connector directory" reference | Status should be "Implemented (all PRs merged)"; connector lives in `server/relay/`, not a separate `server/connector/` directory |
| `docs/HOSTED-RELAY-CONTROL-PLANE-SPEC.md` | Header status line | Change from "Draft architecture spec" to "Architecture reference (implemented)" |
| `docs/SESSION-HANDOFF-SPEC.md` | Header status line; add "Implementation" section | `handoff-manager.ts` is shipped (PR #548); spec still reads "draft / ideation"; needs a Phase 1 implementation summary |
| `docs/API-REFERENCE.md` | Add "Relay Server API" section | 15+ relay endpoints in `server/relay/` are undocumented: machines, pairing, shares, audit-events, GitHub OAuth, `/api/me` |
| `docs/stream-json-protocol.md` | Title + add OpenCode and Codex sections | Two new provider adapters shipped in v0.7.0 with distinct IPC protocols; this file only covers Claude Code stream-JSON |
| `docs/SETUP.md` | "Directory Structure" section | Server block shows 3 files; actual `server/` has 80+ files; at minimum add a note that only key entry points are listed |
| `docs/ORCHESTRATOR-SPEC.md` | Status line (v0.5.2 references) | Current version is v0.8.0; v0.5.2 version pinning in the status and refactor notes is confusing to readers in v0.8.0 context |
| `docs/GITHUB-WEBHOOKS-SPEC.md` | Status header | "Phases 2-4 are roadmap" is true, but PR review (listed as Roadmap in the status summary) is actually implemented; the header should say "Phase 1 + PR review implemented; Phases 2-4 roadmap" |
| `CONTRIBUTING.md` | Environment Variables section | Lacks `GITHUB_WEBHOOK_SECRET`, `GITHUB_WEBHOOK_ENABLED`, relay-specific env vars (`RELAY_*`) that exist in `server/relay/relay-config.ts` |

---

## Recommendations

1. **Update `docs/FEATURES.md` urgently** — This is the most visible gap. Four major features (Goal Runs, Hosted Relay, Session Handoff, Session Sharing) are in the README but absent from the feature reference. A reader of FEATURES.md has a 2-month-old picture of the product.

2. **Delete the `design_handoff_codekin_styling/` directory** — All 10 files are one-shot Claude Code task prompts for a completed refactor. They serve no ongoing documentation purpose and add root-level clutter. The visual system specification they describe is now encoded in CLAUDE.md and `src/index.css`.

3. **Update status headers on the three spec/plan documents** — `HOSTED-RELAY-CONTROL-PLANE-SPEC.md`, `HOSTED-RELAY-IMPLEMENTATION-PLAN.md`, and `SESSION-HANDOFF-SPEC.md` all carry pre-ship language ("Draft", "Proposed", "draft / ideation") for shipped functionality. These are one-line fixes but they actively mislead readers.

4. **Document the relay API in `docs/API-REFERENCE.md`** — The relay server exposes 15+ endpoints (machines, pairing, shares, audit-events, auth) that are entirely absent from the API reference. This is the highest-priority accuracy gap in a reference document that engineers use actively.

5. **Broaden `docs/stream-json-protocol.md` to cover all three providers** — Rename to `docs/provider-protocols.md` (or add sibling files) and document OpenCode's native agent protocol and Codex's JSON-RPC 2.0 + thread model. The current file implies Claude Code is the only provider.

6. **Fix `docs/GITHUB-WEBHOOKS-SPEC.md` status header** — The header says "Phase 1 implemented, Phases 2-4 are roadmap" but PR review (`pull_request` events) is actually implemented as part of Phase 1. Change to "Phase 1 + PR review implemented; Phases 2-4 roadmap" to match the body.

7. **Consolidate the duplicate env-var tables** — `docs/SETUP.md` and `CONTRIBUTING.md` both maintain server env-var reference tables. Remove the shorter one from SETUP.md and link to CONTRIBUTING.md, which is more complete. Extend CONTRIBUTING.md to include webhook and relay env vars.

8. **Update the directory structure listing in `docs/SETUP.md`** — The `server/` block shows 3 files. Add a note clarifying it lists only entry points, or update it to reflect the current major subsystems (orchestrator, webhooks, goal-runs, relay, workflows).

9. **Add version-neutral language to `docs/ORCHESTRATOR-SPEC.md`** — Replace "shipped as of v0.5.2" with current status ("All phases shipped"). The spec is otherwise accurate and does not need a rewrite — just the version-pinned status line and the refactor note that references v0.5.2.

10. **Archive or clearly label `docs/HOSTED-RELAY-IMPLEMENTATION-PLAN.md`** — The document describes the sequencing of 8 PRs that are all now merged. It has value as a historical design record but reads as a to-do list. Add a prominent "Historical — all work complete" banner at the top, or move it to `.codekin/reports/architecture/` alongside the existing architecture audit.