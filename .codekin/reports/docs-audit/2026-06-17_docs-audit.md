# Documentation Audit: codekin

**Date**: 2026-06-17T01:21:48.691Z
**Repository**: /srv/repos/Multiplier-Labs/codekin
**Branch**: main
**Workflow Run**: 77729036-bcc3-472b-8177-05282818ce2c
**Session**: 8ce89f9c-dc2c-462a-87ee-ede4e6e0ae17

---

# Codekin Documentation Audit — 2026-06-17

---

## Summary

**Total documentation files:** 26 (15 primary docs, 3 GitHub templates, 8 server workflow definitions, plus `docs/screenshot.png`)

**Health rating: Needs cleanup**

The core user-facing docs (README, CONTRIBUTING, SETUP, WORKFLOWS) are broadly accurate. The two large architectural specs — `docs/ORCHESTRATOR-SPEC.md` and `docs/GITHUB-WEBHOOKS-SPEC.md` — are frozen at their 2026-04-25 state and have drifted significantly from the codebase: the Agent Joe resilience suite (PRs #498, #501, #503–#505) added five new server modules not reflected in the spec, and the GoalRun MVP (PR #517, 7 new server files, new UI view) has zero documentation coverage anywhere. `docs/FEATURES.md`, `docs/API-REFERENCE.md`, and `docs/stream-json-protocol.md` also have notable gaps around multi-provider support (OpenCode, Codex) shipped in v0.7.0.

**Key findings:**
- 2 spec docs are 7+ weeks stale with major untracked features
- GoalRun / Loop Runs (5 API endpoints, new UI) is entirely undocumented
- Multi-provider AI (OpenCode, Codex) appears only in README and CHANGELOG; FEATURES, API-REFERENCE, SETUP, and stream-json-protocol have not been updated
- `docs/stream-json-protocol.md` is the oldest non-boilerplate doc (2026-04-08) and is now Claude-Code-only while two additional protocol adapters exist
- `CLAUDE.md` conventions section is 10 weeks old; setup instructions in CONTRIBUTING match current `package.json` scripts

---

## Documentation Inventory

| Path | Lines | Last Modified | Purpose | Status |
|---|---|---|---|---|
| `README.md` | 114 | 2026-06-13 | Public-facing project overview, install quickstart, feature highlights | **Current** |
| `CHANGELOG.md` | 630 | 2026-06-13 | Semver release history (v0.6.5–v0.7.0) | **Current** |
| `CLAUDE.md` | 58 | 2026-04-10 | Internal dev conventions, coding rules, audit report output format | **Stale** |
| `CONTRIBUTING.md` | 116 | 2026-05-15 | Contributor setup guide, branching policy, PR process | **Current** |
| `SECURITY.md` | 43 | 2026-03-08 | Vulnerability reporting policy and response timelines | **Current** |
| `CODE_OF_CONDUCT.md` | 31 | 2026-03-08 | Community conduct standards (Contributor Covenant v2.1) | **Current** |
| `docs/FEATURES.md` | 420 | 2026-06-03 | User-facing feature reference | **Stale** |
| `docs/API-REFERENCE.md` | 765 | 2026-06-03 | REST API endpoints, WebSocket hardening, rate limiting | **Stale** |
| `docs/SETUP.md` | 438 | 2026-06-03 | Self-hosted nginx + Authelia + systemd deployment | **Current** |
| `docs/OPERATIONS.md` | 310 | 2026-06-03 | Operational reference: rate limiting, workflow recovery | **Current** |
| `docs/WORKFLOWS.md` | 187 | 2026-06-03 | Automated workflow system: MD format, YAML frontmatter, execution model | **Current** |
| `docs/INSTALL-DISTRIBUTION.md` | 186 | 2026-05-15 | npm distribution packaging, CLI install, release process | **Current** |
| `docs/ORCHESTRATOR-SPEC.md` | 748 | 2026-04-25 | Agent Joe architecture, identity, phases | **Outdated** |
| `docs/GITHUB-WEBHOOKS-SPEC.md` | 947 | 2026-04-25 | GitHub webhook integration, CI auto-fix, PR review | **Outdated** |
| `docs/stream-json-protocol.md` | 566 | 2026-04-08 | Claude Code stream-JSON spawning, permission modes, env vars | **Outdated** |
| `docs/screenshot.png` | — | — | UI screenshot linked from README | **Current** |
| `.github/ISSUE_TEMPLATE/bug_report.md` | 40 | 2026-03-08 | Bug report template | **Current** |
| `.github/ISSUE_TEMPLATE/feature_request.md` | 22 | 2026-03-08 | Feature request template | **Current** |
| `.github/PULL_REQUEST_TEMPLATE.md` | 17 | 2026-03-08 | PR checklist template | **Current** |
| `server/workflows/code-review.daily.md` | 22 | 2026-04-10 | Daily code-review workflow definition | **Current** |
| `server/workflows/comment-assessment.daily.md` | 41 | 2026-04-10 | Daily comment-quality workflow definition | **Current** |
| `server/workflows/commit-review.md` | 22 | 2026-04-10 | On-demand commit review workflow | **Current** |
| `server/workflows/complexity.weekly.md` | 54 | 2026-04-10 | Weekly complexity analysis workflow | **Current** |
| `server/workflows/coverage.daily.md` | 41 | 2026-04-10 | Daily test-coverage workflow | **Current** |
| `server/workflows/dependency-health.daily.md` | 46 | 2026-04-10 | Daily dependency health workflow | **Current** |
| `server/workflows/docs-audit.weekly.md` | 97 | 2026-04-10 | Weekly documentation audit workflow | **Current** |
| `server/workflows/pr-review.md` | 27 | 2026-04-10 | On-demand PR review workflow | **Current** |
| `server/workflows/repo-health.weekly.md` | 111 | 2026-04-10 | Weekly repo health workflow | **Current** |
| `server/workflows/security-audit.weekly.md` | 66 | 2026-04-10 | Weekly security audit workflow | **Current** |

---

## Staleness Findings

### 1. `docs/ORCHESTRATOR-SPEC.md` — Last modified 2026-04-25

The spec header states: *"Status: v1.0 — all four implementation phases shipped as of v0.5.2."* This is stale by 7+ weeks and 13 merged commits.

**Missing features (shipped after 2026-04-25):**

| Feature | PRs | New server modules |
|---|---|---|
| Realtime blocked-child notifications | #498 | `orchestrator-notify.ts` |
| Persistent notification outbox with replay | #501 | `orchestrator-outbox.ts` |
| Pausable child timeouts, broader allowlist, worktree status | #503 | Updates to `orchestrator-children.ts`, `orchestrator-session-router.ts` |
| Ground-truth child completion verification | #504 | `orchestrator-children.ts` |
| Template fixes, child transcript endpoint, org-aware repo discovery | #505 | `orchestrator-manager.ts`, `orchestrator-monitor.ts`, `orchestrator-session-router.ts` |
| Rate-limit child spawn security hardening | #431 | `orchestrator-session-router.ts` |
| Memory and learning subsystems | (various) | `orchestrator-memory.ts`, `orchestrator-memory-router.ts`, `orchestrator-learning.ts`, `orchestrator-learning-router.ts` |

**The spec's module table** at line 463 lists only four routers. The actual server now has 12 `orchestrator-*.ts` files — the spec accounts for roughly half of them.

**Phase checklist** (line 565): States "Phase 4 — Self-Improving Memory & Autonomy ✓" as the final phase, but there is no mention of the capability additions from the Joe 2–5 series, which represent a material expansion of Phase 3/4 scope.

---

### 2. `docs/GITHUB-WEBHOOKS-SPEC.md` — Last modified 2026-04-25

**Status header (line 3) is partially incorrect:** *"Status: Phase 1 implemented and in production. Phases 2-4 are roadmap."* The PR-review feature (`pull_request` events) is listed in the expanded events table (line 141) as **"Implemented"** and has its own 180-line implementation section at the bottom. The overall status header contradicts this.

**More importantly**, commit `c9964e4` (fix: group webhook/stepflow sessions under canonical owner-namespaced repo) landed after the doc was frozen. The spec's workspace section describes a plain clone-per-session model that does not mention the canonical owner-namespaced grouping now implemented.

**Webhook module inventory drift:** The spec's implementation file list (around line 769) references 8–10 files. The actual `server/` directory contains 16 `webhook-*.ts` files, including `webhook-setup-routes.ts`, `webhook-types.ts`, `webhook-config.ts`, and `webhook-rate-limiter.ts`, which have no documentation.

---

### 3. `docs/FEATURES.md` — Last modified 2026-06-03

Commit `8617cac` (docs: document Codex, OpenCode, Agent Joe, 2026-06-13) explicitly updated only README and CHANGELOG. FEATURES.md was not touched.

**Missing features:**
- **Multi-provider AI** (OpenCode, OpenAI Codex): added across PRs #492–#500, #499. README describes both thoroughly; FEATURES.md has zero mention of either.
- **GoalRun / Loop Runs**: PR #517 (merged 2026-06-14) added a full new UI view, `/api/goal-runs/*` routes, three loop templates (ci-autorepair, coverage-increase, dependency-upgrade), maker-checker review pass, and PR write-back. FEATURES.md has no mention.
- **Compact provider-selection dropdown**: PR #509 (replace per-provider new-session buttons with compact dropdown) changed a core UI element described in FEATURES.md.

---

### 4. `docs/API-REFERENCE.md` — Last modified 2026-06-03

**Missing API surface:** The GoalRun routes module (`server/goal-run-routes.ts`) exposes at minimum:
- `GET /api/goal-runs` — list runs (filterable by `kind`, `status`, `repo`)
- `POST /api/goal-runs` — create a run (kind, repo, branch, goal)
- Additional routes for templates and status transitions

None of these endpoints appear anywhere in `docs/API-REFERENCE.md`.

---

### 5. `docs/stream-json-protocol.md` — Last modified 2026-04-08 (oldest non-boilerplate doc)

This document covers only the Claude Code `--output-format stream-json` protocol. Since April 2026, the codebase added full adapter layers for:
- **OpenCode** (`server/opencode-process.ts`) — uses OpenCode's native agents, permissions, and commands; has its own turn lifecycle, abort mechanism, compact, diff detection, version check, and reasoning-part classification
- **OpenAI Codex** (`server/codex-process.ts`) — third provider added in PR #499

The title "stream-json-protocol" no longer reflects the document's scope. Readers looking to understand the Codex or OpenCode integration have no documentation to consult.

---

### 6. `CLAUDE.md` — Last modified 2026-04-10

The architecture section lists `src/components/`, `src/hooks/` as key directories but omits `src/lib/` which exists in the source tree. This is a minor gap but affects onboarding accuracy.

The `build` script documented as `tsc -b && vite build` matches `package.json` exactly. The `test:watch` script documented as `vitest` matches the actual `"test:watch": "vitest"` entry. Scripts are accurate.

---

## Accuracy Issues

| Document | Claim | Actual State |
|---|---|---|
| `docs/ORCHESTRATOR-SPEC.md:5` | "all four implementation phases shipped as of v0.5.2" | 5+ additional capability milestones shipped across v0.6.x–v0.7.0 after spec was written |
| `docs/ORCHESTRATOR-SPEC.md:463` | Module table lists 4 orchestrator routers | 12 `orchestrator-*.ts` files exist in server |
| `docs/GITHUB-WEBHOOKS-SPEC.md:3` | "Phases 2-4 are roadmap" | PR review (listed at line 141 as "Implemented") is in production and part of Phase 1 |
| `docs/FEATURES.md:1–420` | No mention of OpenCode or Codex providers | Both providers have been in production since v0.7.0 (June 2026) |
| `docs/FEATURES.md:1–420` | No mention of GoalRun / Loop Runs | Feature shipped June 14, 2026 (PR #517) with new UI view |
| `docs/stream-json-protocol.md:title` | Titled as stream-JSON protocol for Claude Code | Codekin now supports 3 providers with distinct process adapters |
| `CLAUDE.md:Key Directories` | Lists `src/components/`, `src/hooks/` | `src/lib/` also exists and is not listed |
| `CONTRIBUTING.md:24` | `npm install --prefix server` | Correct; server has its own `package.json`. But `server/package.json` `test:watch` script differs from root |

---

## Overlap & Redundancy

### Group A: Installation / Getting Started (3 files)

| File | Audience | Overlap area |
|---|---|---|
| `README.md` (Install section) | All users | Quickstart install via `curl | bash` |
| `docs/INSTALL-DISTRIBUTION.md` | npm package users / release managers | End-user install, npm lifecycle |
| `docs/SETUP.md` (§ Quickstart section) | Self-hosted operators | Dev-mode quickstart and full nginx/systemd setup |

`docs/SETUP.md` has a short quickstart subsection (≈20 lines) that duplicates `INSTALL-DISTRIBUTION.md`'s basic install flow. These files are otherwise purposefully differentiated (distribution vs. self-hosted ops) and should remain separate, but the quickstart overlap in SETUP.md should be reduced to a reference link.

### Group B: Agent Joe / Orchestrator (2 files)

| File | Coverage |
|---|---|
| `docs/ORCHESTRATOR-SPEC.md` | Deep technical spec: architecture, phases, API surface, system prompt |
| `docs/FEATURES.md` (Agent Joe section) | User-facing summary of capabilities |

Both describe Agent Joe's capabilities and repository monitoring behavior. The FEATURES.md treatment is appropriately lighter; no merge is needed, but the two must stay synchronized.

### Group C: Webhook / PR Review (2 files)

| File | Coverage |
|---|---|
| `docs/GITHUB-WEBHOOKS-SPEC.md` | Detailed implementation spec |
| `docs/FEATURES.md` (PR Review Automation section) | User-facing summary |

Same pattern as Group B. Intentional layering, not redundancy.

---

## Fragmentation

### `docs/stream-json-protocol.md` — Isolated and underlinked

No other documentation file in `docs/` links to `stream-json-protocol.md`. It is not referenced from `docs/API-REFERENCE.md`, `docs/FEATURES.md`, or `docs/SETUP.md`. It reads as a self-contained research note rather than an integrated part of the documentation set. Now that Codekin supports three CLI backends with different protocols, this document is either:
- A candidate for expansion into a **multi-provider protocol reference** and integration into `docs/API-REFERENCE.md` as a technical appendix, or
- A candidate for a rename and scope update to `docs/PROVIDER-PROTOCOLS.md`

### GoalRun has no dedicated doc home

The GoalRun / Loop Runs feature spans: a new UI view (`WorkflowsView` area), a REST API (`/api/goal-runs`), three loop templates (`server/workflows/loop-*.md`?), a store, controller, finalizer, and verifier. None of the existing docs has a natural home for this. It needs a section in `docs/FEATURES.md` at minimum, and API endpoint coverage in `docs/API-REFERENCE.md`.

### Spec docs mix shipped state with open roadmap

Both `docs/ORCHESTRATOR-SPEC.md` and `docs/GITHUB-WEBHOOKS-SPEC.md` interleave checked "✓" items with unchecked roadmap items in the same phase tables. This makes it difficult to distinguish current capability from future intent. As more items complete without the docs being updated, the tables become misleading.

---

## Action Items

### Delete

No files are candidates for outright deletion. All docs address distinct concerns and retain reference value. However, the roadmap-only sections inside the two spec docs could be trimmed or separated.

### Consolidate

| Source Files | Target File | What to keep / drop |
|---|---|---|
| `docs/stream-json-protocol.md` (Claude Code protocol only) + new OpenCode/Codex protocol notes | Rename to `docs/PROVIDER-PROTOCOLS.md` or absorb into `docs/API-REFERENCE.md` as Appendix A | Keep: Claude Code spawn flags, permission modes, env vars. Add: OpenCode adapter overview, Codex adapter overview. Drop: nothing — expand scope. |
| `docs/SETUP.md` quickstart subsection (≈20 lines) | Remove from SETUP.md, replace with link to INSTALL-DISTRIBUTION.md | Keep full content in INSTALL-DISTRIBUTION.md. Drop duplicate from SETUP.md. |

### Update

| File | Sections needing update | What changed in code |
|---|---|---|
| `docs/ORCHESTRATOR-SPEC.md` | Status header, module table (§10), phase checklist (§11), architecture diagram (§4) | Joe resilience suite: 5 PRs added blocked-child notifications, notification outbox/replay, pausable timeouts, ground-truth child verification, org-aware repo discovery, child transcript endpoint. 8 new server modules. |
| `docs/GITHUB-WEBHOOKS-SPEC.md` | Status header (line 3), implementation file list (§PR review), workspace section | PR review is shipped Phase 1 (not roadmap). 16 webhook modules exist vs. ~10 documented. Canonical owner-namespaced repo grouping added. |
| `docs/FEATURES.md` | Add: Multi-provider AI section, GoalRun / Loop Runs section. Update: Session creation UI (compact dropdown replacing per-provider buttons) | OpenCode and Codex providers (v0.7.0). GoalRun MVP (PR #517, 2026-06-14). Compact provider dropdown (PR #509). |
| `docs/API-REFERENCE.md` | Add: `/api/goal-runs` endpoint group | Goal Run routes: list, create, status, templates. `server/goal-run-routes.ts` mounts at `/api/goal-runs`. |
| `docs/stream-json-protocol.md` | Expand scope or retitle; add OpenCode and Codex protocol adapters | `server/opencode-process.ts` and `server/codex-process.ts` implement distinct process lifecycles. |
| `CLAUDE.md` | Key Directories section | `src/lib/` directory exists but is not listed. |

---

## Recommendations

1. **Update `docs/ORCHESTRATOR-SPEC.md` urgently (highest priority).** It is the primary reference for the orchestrator and is 7+ weeks behind. The Joe resilience suite (#498, #501, #503–#505) introduced major architectural additions — notification outbox, learning router, memory router, manager — none of which appear. This should be updated before the next significant orchestrator PR lands and the gap widens further.

2. **Document GoalRun / Loop Runs before it ships in a release.** PR #517 merged to main with no corresponding documentation update. Add a feature section to `docs/FEATURES.md` and the API endpoint group to `docs/API-REFERENCE.md`. The feature has 7 server files and a new UI view — it warrants a paragraph in FEATURES and a full endpoint table in API-REFERENCE.

3. **Fix the status header in `docs/GITHUB-WEBHOOKS-SPEC.md`.** Line 3 says "Phases 2-4 are roadmap" but the same document documents PR review as "Implemented." This internal contradiction will mislead contributors. At minimum, update the header to reflect the true shipped scope.

4. **Expand `docs/stream-json-protocol.md` to cover all three providers.** Rename it to `docs/PROVIDER-PROTOCOLS.md` or add it as an appendix in `docs/API-REFERENCE.md`. The current document is valuable but has a misleading narrow scope now that OpenCode and Codex are production-grade integrations.

5. **Add a multi-provider AI section to `docs/FEATURES.md`.** The README covers OpenCode and Codex clearly. FEATURES.md still reads as a single-provider (Claude Code) product. Users consulting FEATURES.md will not discover the multi-provider capability.

6. **Update `docs/ORCHESTRATOR-SPEC.md` and `docs/GITHUB-WEBHOOKS-SPEC.md` phase tables** to clearly separate shipped state from open roadmap. Consider moving roadmap items to a `docs/ROADMAP.md` or to GitHub Issues so the spec docs serve as accurate present-state references rather than mixed spec/plan hybrids.

7. **Update `CLAUDE.md` Key Directories section** to include `src/lib/`. This is a minor onboarding accuracy issue but affects new contributors following the conventions document.

8. **Remove the quickstart subsection in `docs/SETUP.md`** (basic `npm install && npm run dev` block) and replace it with a link to `docs/INSTALL-DISTRIBUTION.md`. SETUP.md's audience is self-hosted operators; the quickstart duplication adds noise without value.

9. **Establish a doc-update checklist in the PR template.** The PRs #498–#505 (Joe resilience) and #517 (GoalRun) all merged without doc updates. Adding a checkbox item — "Updated docs/FEATURES.md and docs/API-REFERENCE.md if new user-facing features or API endpoints were added" — to `.github/PULL_REQUEST_TEMPLATE.md` would prevent future drift.

10. **Consider a `docs/GOAL-RUNS.md`** if the GoalRun feature expands further (additional template types, user-configurable verifiers, PR write-back configuration). Right now it can live as a FEATURES.md section, but the architecture (store, controller, finalizer, verifier, templates, maker-checker) is complex enough that a dedicated doc will be warranted soon.