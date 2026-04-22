# Documentation Audit Report — 2026-04-22

**Project**: codekin v0.6.3
**Generated**: 2026-04-22

---

## Summary

This audit covers **15 documentation files** totalling **4,991 lines** across root-level markdown, `docs/`, and inline specifications. The repository is in **good overall health** — core references (README, CLAUDE.md, CONTRIBUTING.md, FEATURES.md, WORKFLOWS.md) are accurate and current. The main concerns are a **spec document that has drifted from a significantly-refactored implementation** (ORCHESTRATOR-SPEC.md), one **API reference that is missing a recently shipped model**, and two **webhook documents that overlap in topic** and could be consolidated. Community governance files have not been touched in 45 days, though they require no immediate action.

**Health rating: Well-maintained — minor drift in two files, one consolidation opportunity.**

---

## Documentation Inventory

| Path | Lines | Last Modified | Purpose | Status |
|---|---|---|---|---|
| `CLAUDE.md` | 58 | 2026-04-10 | Project conventions, architecture, branching policy, report output rules | Current |
| `README.md` | 110 | 2026-04-11 | User-facing intro, install, feature list, config table | Current |
| `CHANGELOG.md` | 461 | 2026-04-11 | Full version history v0.1.7 → v0.6.3 | Current |
| `CONTRIBUTING.md` | 114 | 2026-04-08 | Dev setup, env vars, conventions, PR process | Current |
| `CODE_OF_CONDUCT.md` | 31 | 2026-03-08 | Community standards, reporting mechanisms | Current (stable) |
| `SECURITY.md` | 43 | 2026-03-08 | Vulnerability reporting policy, deployment security notes | Current (stable) |
| `docs/FEATURES.md` | 421 | 2026-04-15 | Comprehensive feature catalog (all major features) | Current |
| `docs/API-REFERENCE.md` | 684 | 2026-04-08 | 40+ REST endpoints with request/response examples | Stale (1 gap) |
| `docs/GITHUB-WEBHOOKS-SPEC.md` | 823 | 2026-04-15 | Webhook infra spec; Phase 1 production, Phases 2–4 roadmap | Current (spec) |
| `docs/PR-REVIEW-WEBHOOK.md` | 220 | 2026-04-15 | PR review automation implementation detail | Current (redundant) |
| `docs/stream-json-protocol.md` | 566 | 2026-04-08 | Claude Code CLI spawn flags, stdin/stdout event protocol | Current |
| `docs/WORKFLOWS.md` | 187 | 2026-04-15 | Workflow system: file format, built-in types, scheduling | Current |
| `docs/SETUP.md` | 420 | 2026-04-08 | Advanced self-hosted setup: nginx, Authelia, systemd | Current |
| `docs/INSTALL-DISTRIBUTION.md` | 184 | 2026-04-09 | npm distribution, one-liner install, service setup, CLI commands | Current |
| `docs/ORCHESTRATOR-SPEC.md` | 669 | 2026-03-16 | Agent Joe design spec; all phases shipped, but code evolved significantly | Stale |

---

## Staleness Findings

### 1. `docs/ORCHESTRATOR-SPEC.md` — Last updated 2026-03-16 (37 days ago)

- The document is labelled "Status: v1.0 — Phase 1 shipped (v0.5.0). Phases 2–4 shipped (v0.5.2)" — all phases are complete, making this a post-ship reference document rather than a live spec.
- **32 commits** to `server/orchestrator-*.ts` files since the spec was last updated.
- The most impactful: commit `5053233` (2026-04-11) refactored `orchestrator-routes.ts` into focused sub-routers. The spec describes a single-file route structure that no longer matches the implementation.
- Commit `4cdabef` added session lifecycle hooks and approval endpoints that are not described in the spec.
- The spec's architecture diagrams and session-model section reflect pre-refactor structure.

### 2. `docs/API-REFERENCE.md` — Last updated 2026-04-08 (14 days ago)

- Commit `8bbfbcd` (2026-04-18) added **Claude Opus 4.7** (`claude-opus-4-7`) as an available model. The API reference does not list this model in its session-creation or settings endpoints.
- The orchestrator route refactor (`5053233`, 2026-04-11) split routes into sub-routers; it is unclear whether the public endpoint paths changed. The API reference should be verified against current routes.

### 3. `CODE_OF_CONDUCT.md` and `SECURITY.md` — Last updated 2026-03-08 (45 days ago)

- Both files are static boilerplate-adjacent documents that are unlikely to contain drift. No code-linked claims to become stale. Flagged for completeness only; no action is urgent.

---

## Accuracy Issues

### 1. Missing Opus 4.7 in API-REFERENCE.md

The `feat: add Claude Opus 4.7` commit (2026-04-18, `8bbfbcd`) is not reflected anywhere in `docs/API-REFERENCE.md`. Any session-creation or model-selection endpoint that lists accepted model values is incomplete.

### 2. README.md omits Node.js version prerequisite

`CONTRIBUTING.md` states "Node.js 20+" under prerequisites. `README.md` lists only "macOS or Linux" and "Claude Code CLI" with no Node.js version. For users who skip CONTRIBUTING.md, there is no Node.js version guidance in the primary entry point. (Actual installed version is v24.13.1, which satisfies the ≥20 requirement.)

### 3. ORCHESTRATOR-SPEC.md route structure diverges from code

The spec describes a single `orchestrator-routes.ts` handling all orchestrator REST endpoints. After the refactor, routes are split across at minimum four files (`orchestrator-routes.ts`, `orchestrator-*-router.ts` variants). Developers using the spec as an architectural reference will encounter a mismatch.

---

## Overlap & Redundancy

### Group A: Webhook documentation (1,043 lines combined)

| File | Lines | Focus |
|---|---|---|
| `docs/GITHUB-WEBHOOKS-SPEC.md` | 823 | Full webhook infra spec — architecture, workspace management, git auth, CI failure handling, all phases |
| `docs/PR-REVIEW-WEBHOOK.md` | 220 | PR review automation — event flow, context cache, comment updating, dedup logic |

**Overlap**: Both cover the PR review webhook event flow, session lifecycle, git authentication, dedup logic, configuration variables, and test suite counts. `PR-REVIEW-WEBHOOK.md` is a deep-dive on a single subsystem that is already outlined in `GITHUB-WEBHOOKS-SPEC.md`.

**Recommendation**: Fold `PR-REVIEW-WEBHOOK.md` into `GITHUB-WEBHOOKS-SPEC.md` as a dedicated section ("§ PR Review Implementation"). The spec already has a Phase-based structure; the PR review doc maps cleanly to Phase 1. After merging, delete `PR-REVIEW-WEBHOOK.md`.

### Group B: Orchestrator spec vs. feature catalog

| File | Content |
|---|---|
| `docs/ORCHESTRATOR-SPEC.md` | Full design spec: identity, architecture, session model, capabilities, memory, trust, permissions, state machine |
| `docs/FEATURES.md` | Feature catalog entry for Agent Joe (covers sidebar, child sessions, memory, trust escalation) |

**Overlap**: The Agent Joe sections in `FEATURES.md` summarise the same capabilities described at length in `ORCHESTRATOR-SPEC.md`. They do not conflict, but a reader may be uncertain which document to trust for implementation truth.

**Recommendation**: Convert `ORCHESTRATOR-SPEC.md` into an "Implementation Reference" rather than a design spec — strip prescriptive future-tense language, update the route structure section to reflect the sub-router refactor, and add a header note that `FEATURES.md` is the user-facing summary.

---

## Fragmentation

### 1. Installation guidance split across two files

`docs/INSTALL-DISTRIBUTION.md` (one-liner, npm, service) and `docs/SETUP.md` (bare-metal, nginx, Authelia, systemd) serve different audiences and are **intentionally separate** — well-differentiated, not fragmentation.

### 2. Webhook docs are fragmented

The PR review subsystem is documented in a standalone file but belongs inside the webhook spec. 220 lines of detail for a single webhook type do not justify a top-level file.

### 3. ORCHESTRATOR-SPEC.md is a completed-spec orphan

All four phases are shipped. The document is neither a living reference nor an archived proposal — it occupies an ambiguous middle ground. Post-ship specs that are not updated to reflect code drift become a liability rather than an asset.

---

## Action Items

### Delete

| File | Reason |
|---|---|
| `docs/PR-REVIEW-WEBHOOK.md` | Fully subsumed by `docs/GITHUB-WEBHOOKS-SPEC.md`; content should be folded in as a section before deletion. Safe to delete once merged — no unique architectural decisions exist here that aren't already in the spec. |

### Consolidate

| Source Files | Target File | What to Keep / Drop |
|---|---|---|
| `docs/GITHUB-WEBHOOKS-SPEC.md` + `docs/PR-REVIEW-WEBHOOK.md` | `docs/GITHUB-WEBHOOKS-SPEC.md` | Keep: all of spec + full PR-review detail (context cache, dedup fix, comment-update logic, test counts). Drop: duplicate event-flow and git-auth sections from the PR-review doc (already covered in spec). |

### Update

| File | Section Needing Update | What Changed in Code |
|---|---|---|
| `docs/API-REFERENCE.md` | Model list in session-create / settings endpoints | Claude Opus 4.7 (`claude-opus-4-7`) added in commit `8bbfbcd` (2026-04-18) |
| `docs/API-REFERENCE.md` | Orchestrator endpoint listing | Routes split into sub-routers in commit `5053233` (2026-04-11); verify paths unchanged |
| `docs/ORCHESTRATOR-SPEC.md` | Architecture / Route structure section | `orchestrator-routes.ts` refactored into focused sub-routers; lifecycle hooks and approval endpoints added |
| `docs/ORCHESTRATOR-SPEC.md` | Header / document status | Phases 2–4 are shipped; prescriptive future-tense language should be converted to present-tense implementation reference |
| `README.md` | Prerequisites section | Add explicit "Node.js v20+" requirement to match `CONTRIBUTING.md` |

---

## Recommendations

1. **Update `docs/API-REFERENCE.md` to add Claude Opus 4.7.** This is the highest-priority accuracy gap — a shipped model that is absent from the API reference. Add `claude-opus-4-7` to every endpoint or table that lists accepted model identifiers.

2. **Audit `docs/ORCHESTRATOR-SPEC.md` against the current sub-router structure.** Run a diff of the documented endpoint list against the actual routes exported by `server/orchestrator-*-router.ts` files. Update the architecture section and convert future-tense language to present-tense. Add a note at the top distinguishing this from the user-facing summary in `FEATURES.md`.

3. **Merge `docs/PR-REVIEW-WEBHOOK.md` into `docs/GITHUB-WEBHOOKS-SPEC.md`, then delete the source file.** The PR-review implementation detail (context cache, dedup logic, comment-update pattern) belongs as a subsection of the webhook spec — this reduces top-level doc count by one and puts all webhook knowledge in one place.

4. **Add Node.js version requirement to `README.md`.** One line under Prerequisites: "Node.js v20+". This closes the only gap between the primary user entry point and `CONTRIBUTING.md`.

5. **Verify `docs/API-REFERENCE.md` orchestrator endpoint paths post-refactor.** Commit `5053233` restructured orchestrator routes. Confirm whether public URL paths changed or only internal file organisation — if paths changed, update the reference table accordingly.

6. **Convert `docs/ORCHESTRATOR-SPEC.md` header to reflect post-ship status.** Replace "Specification" with "Implementation Reference" in the title and add a short preamble ("All phases shipped as of v0.5.2. This document describes the current architecture.") so readers know it is a reference, not a proposal.

7. **Schedule a `docs-audit.weekly` workflow run to catch future drift.** The built-in `docs-audit.weekly` workflow exists but the API-REFERENCE drift (14 days) and ORCHESTRATOR-SPEC drift (37 days) suggest the weekly cadence may not be triggering reliably — or its output is not prompting updates. Verify the workflow is scheduled and that its findings are acted on within the sprint.

8. **Keep `CODE_OF_CONDUCT.md` and `SECURITY.md` on a quarterly review schedule.** These are stable boilerplate-adjacent files, but SECURITY.md should be reviewed after any authentication or rate-limiting changes (e.g., commit `84d18eb` added hard caps to rate-limiter maps — the deployment security section should acknowledge rate-limiting as a built-in control).

9. **Consider adding a `docs/` index file (`docs/README.md`).** With 10 files in `docs/`, new contributors have no navigation aid. A short index listing each file with one-line descriptions would reduce orientation time without requiring any content changes to existing files.

10. **Preserve the `-SPEC` naming convention with clarity.** `GITHUB-WEBHOOKS-SPEC.md` and `ORCHESTRATOR-SPEC.md` use a `-SPEC` suffix that signals "design document" — but after all phases ship, this label becomes misleading. Consider renaming to `GITHUB-WEBHOOKS.md` and `ORCHESTRATOR.md` to signal current-state reference rather than proposal.
