# Documentation Audit: codekin

**Date**: 2026-05-06T01:20:27.065Z
**Repository**: /srv/repos/codekin
**Branch**: main
**Workflow Run**: f85bcae3-3aea-4fad-8cc9-8da7209bc182
**Session**: 497e7ee7-44a7-446a-ba5e-6c0572e55fbb

---

Now I have all the information needed to produce a comprehensive audit report.

---

# Documentation Audit Report — Codekin

**Audit Date**: 2026-05-06
**Repository**: Multiplier-Labs/codekin
**Auditor**: Automated docs-audit workflow

---

## Summary

**Total documentation files**: 31 (excluding node_modules and GitHub Actions templates)
**Files requiring attention**: 14
**Key findings**:
- The built-in workflow output-path table in `docs/WORKFLOWS.md` is entirely stale — 6 of 10 entries list legacy root-level directories that were migrated to `.codekin/reports/` months ago.
- `docs/FEATURES.md` has zero coverage of OpenCode multi-provider support, the largest feature shipped in v0.6.0.
- `CHANGELOG.md` is missing entries for five consecutive releases (v0.6.1–v0.6.5), leaving the changelog functionally outdated from April 12 onward.
- Rate-limiting documentation is split between `docs/API-REFERENCE.md` (summarised) and `docs/operations/ws-rate-limit.md` (deep-dive), with substantial content overlap.
- Two legacy workflow-output files (`coverage-reports/` and `review logs/`) exist at the repo root under the old naming convention and have no git history, suggesting they are untracked noise.

**Health rating**: **Needs cleanup** — core reference docs are largely accurate, but several high-impact gaps and one significant staleness cluster require attention before the docs can be considered fully trustworthy.

---

## Documentation Inventory

| Path | Lines | Last Modified | Purpose | Status |
|---|---|---|---|---|
| `README.md` | 111 | 2026-04-25 | Project overview, one-liner install, CLI usage, features list | Current |
| `CHANGELOG.md` | 461 | 2026-04-11 | Release history (Keep a Changelog format) | Stale |
| `CLAUDE.md` | 58 | 2026-04-10 | Dev/AI coding conventions, branching policy, report output rules | Current |
| `CODE_OF_CONDUCT.md` | 31 | 2026-03-08 | Community standards (Contributor Covenant) | Current |
| `CONTRIBUTING.md` | 114 | 2026-04-08 | Contributor setup, env vars, coding conventions, PR process | Current |
| `SECURITY.md` | 43 | 2026-03-08 | Vulnerability reporting policy | Current |
| `docs/API-REFERENCE.md` | 764 | 2026-04-28 | REST API endpoints, WS hardening, model list | Current |
| `docs/FEATURES.md` | 421 | 2026-04-26 | Feature-by-feature reference for end users | Stale |
| `docs/GITHUB-WEBHOOKS-SPEC.md` | 947 | 2026-04-25 | Webhook integration design spec + PR review implementation | Stale |
| `docs/INSTALL-DISTRIBUTION.md` | 184 | 2026-04-09 | npm distribution model, release process, install script design | Current |
| `docs/ORCHESTRATOR-SPEC.md` | 748 | 2026-04-25 | Agent Joe architecture and implementation reference | Current |
| `docs/SETUP.md` | 420 | 2026-04-08 | Advanced bare-metal/nginx self-hosted setup guide (incl. webhook setup) | Current |
| `docs/WORKFLOWS.md` | 187 | 2026-04-15 | Workflow system format, built-in workflows table, custom workflows | Stale |
| `docs/stream-json-protocol.md` | 566 | 2026-04-08 | Claude Code stream-json protocol, flags, events, env vars | Stale |
| `docs/operations/workflow-resilience.md` | 196 | 2026-04-27 | Ops guide for workflow restart-resume and orphan-session handling | Current |
| `docs/operations/ws-rate-limit.md` | 128 | 2026-04-27 | Ops guide for WS per-IP and per-connection rate limiting | Redundant |
| `server/workflows/code-review.daily.md` | 22 | 2026-03-08 | Workflow prompt: daily code review | Current |
| `server/workflows/comment-assessment.daily.md` | 41 | 2026-03-08 | Workflow prompt: daily comment quality audit | Current |
| `server/workflows/commit-review.md` | 22 | 2026-03-11 | Workflow prompt: per-commit review (event-driven) | Current |
| `server/workflows/complexity.weekly.md` | 54 | 2026-03-08 | Workflow prompt: weekly complexity analysis | Current |
| `server/workflows/coverage.daily.md` | 41 | 2026-03-08 | Workflow prompt: daily test coverage assessment | Current |
| `server/workflows/dependency-health.daily.md` | 46 | 2026-03-08 | Workflow prompt: daily dependency health check | Current |
| `server/workflows/docs-audit.weekly.md` | 97 | 2026-03-14 | Workflow prompt: weekly documentation audit | Current |
| `server/workflows/pr-review.md` | 27 | 2026-04-10 | Workflow prompt: PR review (event-driven, posts to GitHub) | Current |
| `server/workflows/repo-health.weekly.md` | 111 | 2026-03-09 | Workflow prompt: weekly repository health assessment | Current |
| `server/workflows/security-audit.weekly.md` | 66 | 2026-03-08 | Workflow prompt: weekly security audit | Current |
| `coverage-reports/2026-03-08_coverage-assessment.md` | 214 | _(untracked)_ | Legacy workflow output from March 2026 (old path convention) | Outdated |
| `review logs/2026-03-08_code-review-daily.md` | 205 | _(untracked)_ | Legacy workflow output from March 2026 (old path convention) | Outdated |
| `.github/PULL_REQUEST_TEMPLATE.md` | 17 | 2026-03-08 | PR submission checklist template | Current |
| `.github/ISSUE_TEMPLATE/bug_report.md` | 40 | 2026-03-08 | Bug report issue template | Current |
| `.github/ISSUE_TEMPLATE/feature_request.md` | 23 | 2026-03-08 | Feature request issue template | Current |

---

## Staleness Findings

### 1. `docs/WORKFLOWS.md` — Built-in workflow output paths entirely wrong

The "Built-in Workflows" table lists legacy root-level output directories that were migrated to `.codekin/reports/<category>/` before the April 2026 doc cleanup. Six of ten rows are stale:

| Workflow | Table claims | Actual (`server/workflows/*.md`) |
|---|---|---|
| `code-review.daily` | `review logs/` | `.codekin/reports/code-review` |
| `security-audit.weekly` | `security-reports/` | `.codekin/reports/security` |
| `complexity.weekly` | `complexity-reports/` | `.codekin/reports/complexity` |
| `coverage.daily` | `coverage-reports/` | `.codekin/reports/coverage` |
| `comment-assessment.daily` | `comment-reports/` | `.codekin/reports/comments` |
| `dependency-health.daily` | `dependency-reports/` | `.codekin/reports/dependencies` |

The `docs-audit`, `commit-review`, `repo-health`, and `pr-review` entries are correct.

### 2. `docs/FEATURES.md` — No OpenCode / Multi-Provider AI coverage

OpenCode multi-provider support was the headline feature of v0.6.0 (shipped 2026-04-10, PR #322). `docs/FEATURES.md` has zero mentions of "OpenCode", "provider", or "multi-provider" across its 421 lines. The Architecture Overview section still shows only `Claude Code CLI` as the backend. `README.md` covers this feature correctly; `FEATURES.md` does not.

### 3. `CHANGELOG.md` — Missing five release entries

`CHANGELOG.md` was last updated on 2026-04-11. Five releases have since shipped: v0.6.1 (Apr 12), v0.6.2 (Apr 12), v0.6.3 (Apr 12), v0.6.4 (inferred), and v0.6.5 (May 3). None appear in the changelog; the `[Unreleased]` section still contains changes that should have been moved into versioned entries.

### 4. `docs/GITHUB-WEBHOOKS-SPEC.md` — Status banner doesn't reflect PR review being shipped

The document header reads: *"Status: Phase 1 implemented and in production. Phases 2–4 are roadmap."* However, the PR review webhook handler (built on this infrastructure) shipped in v0.6.0 as PR #321, with a full implementation section at the bottom of this spec. The status banner and the `[Webhook Events]` table's "Status" column for `pull_request` events still carry "Roadmap (Phase 4)" labels for several event types that have shipped sub-functionality.

### 5. `docs/stream-json-protocol.md` — Env var table may be incomplete post-refactor

The document was last modified 2026-04-08. Since then, `server/session-lifecycle.ts` shows both `CODEKIN_TOKEN` (legacy) and `CODEKIN_AUTH_TOKEN` are passed to spawned processes. The spec's env var table lists them both with a note about the legacy name — this is still accurate. However, the circuit-breaker logic added in PRs #468–#470 (May 2026) introduces new rate-limit behavior that affects how spawned sessions behave when Claude API rate limits are hit; this is not reflected in the protocol documentation.

### 6. `docs/FEATURES.md` — Automated Workflows section uses old output path examples

The "Automated Workflows" bullet point says reports are saved to *"e.g. `review logs/`, `security-reports/`"* — these are the old root-level directories. Current output goes to `.codekin/reports/<category>/` for all built-in workflows.

---

## Accuracy Issues

### `docs/WORKFLOWS.md` — Incorrect output directory table
**Claim**: `code-review.daily` → `review logs/`; `security-audit.weekly` → `security-reports/`; etc.
**Reality**: All six affected workflows now write to `.codekin/reports/<slug>/`. This is confirmed by checking each workflow's `outputDir` frontmatter field directly.

### `docs/FEATURES.md` — Architecture diagram omits OpenCode
**Claim**: Architecture shows `Claude Code CLI (spawned per-session with stream-json format)` as the only backend.
**Reality**: Sessions can use either Claude Code or OpenCode as the backend (configurable per session since v0.6.0). The architecture diagram should show both.

### `CHANGELOG.md` — `[Unreleased]` contains shipped features
**Claim**: Items in `[Unreleased]` including "Connection status popup" (#346) and "PR Review workflow" (#334) are unreleased.
**Reality**: These shipped before v0.6.5. The changelog has not been maintained through five release cycles.

### `docs/API-REFERENCE.md` — Model list accuracy
The model table lists `claude-opus-4-7` as a valid model. The `CLAUDE_MODELS` constant in `src/types.ts` confirms this is accurate at time of writing.

### `docs/SETUP.md` — Directory structure section is illustrative, not complete
The directory listing shows `server/upload-routes.ts` and `server/ws-server.ts` as if they are the primary server files. The actual `server/` directory contains 125+ TypeScript source files. While this is a simplified illustration, it could mislead contributors about the server's scope. This is a documentation clarity issue rather than a factual error.

### `docs/INSTALL-DISTRIBUTION.md` — Install script URL uses `raw.githubusercontent.com`
**Claim**: Install script URL is `https://raw.githubusercontent.com/Multiplier-Labs/codekin/main/install.sh`
**Reality**: `README.md` shows the canonical URL as `curl -fsSL codekin.ai/install.sh | bash`. The install-distribution doc uses the raw GitHub URL which may be a secondary/fallback form. Not technically wrong, but inconsistent.

---

## Overlap & Redundancy

### Group 1: WebSocket Rate Limiting (partial duplicate)

| File | Lines | Depth |
|---|---|---|
| `docs/API-REFERENCE.md` (WS Server Hardening section) | ~50 | Summary — constants, behavior, close codes |
| `docs/operations/ws-rate-limit.md` | 128 | Deep-dive — strategy, window math, monitoring, tuning, known limits |

**Shared topic**: Per-IP connection rate limiting and per-connection message rate limiting — both documents describe the same constants, close codes, and behavior.

**More complete/current**: `docs/operations/ws-rate-limit.md` (newer, more detailed).

**Recommendation**: Keep the ops doc as the authoritative deep-dive. Shorten the API-REFERENCE section to a 2–3 line summary with a "See `docs/operations/ws-rate-limit.md`" cross-reference.

---

### Group 2: GitHub Webhook Setup (split across two files)

| File | Webhook content |
|---|---|
| `docs/SETUP.md` (Step 10, ~100 lines) | Full setup walkthrough: env vars, nginx config, gh CLI auth, repo settings, troubleshooting table |
| `docs/GITHUB-WEBHOOKS-SPEC.md` | Full design spec + configuration reference + PR review implementation |

**Shared topic**: Webhook setup instructions, configuration env vars, nginx location block, `GITHUB_WEBHOOK_SECRET`, `gh` CLI requirement.

**More appropriate home**: Operational setup belongs in `docs/SETUP.md` (already there). The spec is a design/reference document. The overlap is minimal-but-real: env var tables appear in both with slightly different formatting. Cross-references already exist between them, so this is well-managed rather than problematic duplication.

---

## Fragmentation

### 1. `docs/GITHUB-WEBHOOKS-SPEC.md` — Hybrid spec/reference/runbook at 947 lines

This file started as a design spec (with phases, open questions, roadmap) and has grown to include a full PR review implementation reference. It mixes:
- Original design goals and non-goals (historical interest only)
- Phased implementation plan (Phase 1 is shipped; Phases 2–4 are still future)
- API design and configuration reference (actively useful)
- PR review implementation detail (actively useful)
- Roadmap items (future interest)

The result is difficult to navigate. A reader wanting to configure PR review must scroll through 600+ lines of design rationale. Splitting into a `docs/GITHUB-WEBHOOKS.md` (config reference) and archiving the design phases to a separate spec file would improve navigability.

### 2. `docs/operations/` — Two files, underused pattern

The `docs/operations/` directory contains only two files (`ws-rate-limit.md`, `workflow-resilience.md`). The pattern is good — operational runbooks separated from feature docs — but several operational topics remain embedded in other docs:
- Workflow monitoring (SQLite queries) → `docs/operations/workflow-resilience.md` ✓
- WS rate limit monitoring → `docs/operations/ws-rate-limit.md` ✓
- Agent Joe operational behavior (quiet mode, heartbeat) → scattered in `docs/ORCHESTRATOR-SPEC.md` and not in `docs/operations/`
- GitHub webhook troubleshooting → embedded in `docs/SETUP.md`

The operations directory should grow to house these, but no existing file is broken — this is a growth opportunity.

### 3. Completed spec content in `docs/ORCHESTRATOR-SPEC.md`

The ORCHESTRATOR-SPEC self-identifies as a "present-tense reference for the shipped Agent Joe system" (v1.0, all phases shipped as of v0.5.2). This is well-handled. One remaining pending item (auto-suggest workflow setup for new repos) is flagged explicitly. No fragmentation issue here.

---

## Action Items

### Delete

| File | Reason it's safe to delete |
|---|---|
| `coverage-reports/2026-03-08_coverage-assessment.md` | Untracked workflow output from March 2026. Old root-level path convention replaced by `.codekin/reports/coverage/`. Content is obsolete (references branch `fix/remove-local-scripts`). No downstream docs reference this file. |
| `review logs/2026-03-08_code-review-daily.md` | Same: untracked March 2026 workflow output under the old `review logs/` path convention. Superseded by `.codekin/reports/code-review/`. No downstream references. |

---

### Consolidate

| Source files | Target file | What to keep / drop |
|---|---|---|
| `docs/API-REFERENCE.md` (WS Hardening rate-limit subsection, ~50 lines) + `docs/operations/ws-rate-limit.md` (128 lines) | Keep `docs/operations/ws-rate-limit.md` as authoritative | In `API-REFERENCE.md`: replace the full rate-limit subsection with a 3-line summary and link to the ops doc. Retain the API-REFERENCE's origin-validation and auth-timeout subsections (not in ops doc). |

---

### Update

| File | Sections needing update | What changed in code |
|---|---|---|
| `docs/WORKFLOWS.md` | "Built-in Workflows" table — Output Directory column | All 6 stale entries (`review logs/`, `security-reports/`, `complexity-reports/`, `coverage-reports/`, `comment-reports/`, `dependency-reports/`) should be updated to `.codekin/reports/<slug>/` to match actual workflow frontmatter. |
| `docs/FEATURES.md` | Entire "Multi-Provider AI / OpenCode" section (missing); "Automated Workflows" bullet (old path examples); "Architecture Overview" diagram | Add a new "Multi-Provider AI" section covering OpenCode backend, provider selector, and supported providers. Update the output path examples. Update the architecture diagram to show OpenCode as an alternative backend. |
| `CHANGELOG.md` | `[Unreleased]` section + missing versioned entries | Move `[Unreleased]` items into versioned entries for v0.6.1–v0.6.5. Add entries for security fixes, reliability work, orchestrator improvements, and dependency bumps that shipped in those five releases (PRs #337–#470). |
| `docs/GITHUB-WEBHOOKS-SPEC.md` | Status banner at top; `pull_request` event row in Webhook Events table | Update header status to reflect that PR review is shipped (not just Phase 1). Update event table to mark `pull_request` events as implemented. |
| `docs/stream-json-protocol.md` | Spawning section — consider noting rate-limit circuit-breaker behavior | PRs #468–#470 added client-side rate-limit circuit-breaking (headless session lifetime cap + circuit-break on `overageStatus=rejected`). If the protocol doc aims to cover session lifecycle, this new behavior should be noted. |
| `docs/FEATURES.md` | "Automated Workflows" → output directory example | Update `"e.g. review logs/, security-reports/"` to `"e.g. .codekin/reports/code-review/, .codekin/reports/security/"` |

---

## Recommendations

1. **Fix `docs/WORKFLOWS.md` output-path table immediately** (high impact, low effort). Six of ten built-in workflow rows point to directories that no longer exist as output targets. Any user following this table to find their reports will look in the wrong place. Update the six stale `outputDir` values to match the workflow frontmatter.

2. **Add a "Multi-Provider AI" section to `docs/FEATURES.md`** (high impact, medium effort). OpenCode support is the largest v0.6.0 feature and is entirely absent from the feature reference. At minimum, document the provider selector, OpenCode as an alternative backend, and supported LLM providers. Mirror the level of detail already in `README.md`.

3. **Catch up `CHANGELOG.md` through v0.6.5** (medium impact, medium effort). Five releases are undocumented. The changelog is a key signal for upgrade decisions and downstream integrators. Batch the PRs (#337–#470) into the five release entries using the existing format.

4. **Update `docs/GITHUB-WEBHOOKS-SPEC.md` status banner** (low effort). Change the header from "Phase 1 in production, Phases 2–4 roadmap" to accurately reflect that the PR review webhook handler (built on this infrastructure) shipped in v0.6.0. Mark the `pull_request` event row in the Webhook Events table as "Implemented" rather than "Roadmap (Phase 4)".

5. **Delete `coverage-reports/` and `review logs/` directories** (low effort, reduces confusion). These untracked directories contain a single March 2026 workflow report each, produced under the old root-level output convention. The current convention writes to `.codekin/reports/`. Their presence will confuse users and future workflow runs. Remove both directories and add them to `.gitignore` as a safeguard.

6. **Consolidate WS rate-limit documentation** (low effort). Replace the ~50-line rate-limit subsection in `docs/API-REFERENCE.md` with a summary sentence and a cross-reference to `docs/operations/ws-rate-limit.md`. The ops doc is newer, more detailed, and better suited as the single source of truth for this topic.

7. **Update `docs/FEATURES.md` Automated Workflows output path example** (trivial effort). Replace the two legacy example paths (`review logs/`, `security-reports/`) with the current convention (`.codekin/reports/<category>/`). This is a one-line change that prevents user confusion when searching for workflow outputs.

8. **Consider splitting `docs/GITHUB-WEBHOOKS-SPEC.md`** (medium effort, long-term). At 947 lines, the file mixes historical design rationale, phased implementation plans, an active configuration reference, and a full PR review implementation guide. A split into `docs/GITHUB-WEBHOOKS.md` (configuration reference + PR review) and an archived `docs/specs/github-webhooks-design.md` (phases, open questions, roadmap) would make both documents easier to navigate and maintain.

9. **Add "Start backend server" step to `CONTRIBUTING.md`** (low effort). The Getting Started block runs `npm run dev` with the label "Start the development server (frontend only)". New contributors may not realise they also need to run the codekin server backend separately. A short note pointing to the server's startup command and environment variables would reduce onboarding friction.

10. **Note the circuit-breaker rate-limit behavior in `docs/stream-json-protocol.md`** (low effort). PRs #468–#470 introduced headless session lifetime caps and client-side circuit-breaking when Claude API rate limits are hit. If the stream-json protocol doc aims to be the authoritative guide for session behavior, a short section on how the server responds to sustained API rate limit signals would complete the picture for anyone debugging long-running sessions.