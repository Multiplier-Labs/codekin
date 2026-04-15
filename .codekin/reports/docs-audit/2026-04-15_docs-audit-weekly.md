# Documentation Audit — 2026-04-15

## Summary

The Codekin repository contains **28 documentation files** across root level, `docs/`, `server/workflows/`, and `.github/` template directories. Overall documentation health is **Well-maintained** — the core reference docs are accurate and current, having been updated in step with recent feature releases (PR Review webhooks, OpenCode provider, Agent Joe orchestrator). The main areas needing attention are: (1) a large spec file (`GITHUB-WEBHOOKS-SPEC.md`) that prominently describes unimplemented future phases without clear delineation; (2) two legacy report output directories (`review logs/`, `coverage-reports/`) that predate the current `.codekin/reports/` structure and are gitignored but still present on disk; (3) minor omission in `WORKFLOWS.md` of the `pr-review` workflow; and (4) `SECURITY.md` is the oldest unchanged file and lacks mention of webhook and orchestrator trust-model security.

**Health rating: Well-maintained** — no broken links, no missing file references, no incorrect install instructions. Targeted cleanup needed in 3–4 areas.

---

## Documentation Inventory

| Path | Lines | Last Modified | Purpose | Status |
|------|------:|--------------|---------|--------|
| `README.md` | 110 | 2026-04-11 | Project overview, features, quickstart, configuration | Current |
| `CHANGELOG.md` | 461 | 2026-04-11 | Version history v0.1.7 → v0.6.3 | Current |
| `CLAUDE.md` | 58 | 2026-04-10 | Codebase conventions and audit report rules for AI agent | Current |
| `CONTRIBUTING.md` | 114 | 2026-04-08 | Dev setup, env vars table, contribution workflow | Current |
| `CODE_OF_CONDUCT.md` | 31 | 2026-03-08 | Community standards | Current |
| `SECURITY.md` | 43 | 2026-03-08 | Security policy, vulnerability disclosure | Stale |
| `install.sh` | 143 | 2026-03-10 | One-liner install script | Current |
| `docs/API-REFERENCE.md` | 684 | 2026-04-08 | REST + WebSocket API endpoints, session management | Current |
| `docs/FEATURES.md` | 402 | 2026-03-16 | Comprehensive feature list linking to spec docs | Current |
| `docs/GITHUB-WEBHOOKS-SPEC.md` | 813 | 2026-03-16 | Webhook architecture; Phase 1 implemented, Phases 2–4 unimplemented roadmap | Stale |
| `docs/INSTALL-DISTRIBUTION.md` | 184 | 2026-04-09 | npm distribution model, CLI commands, service install | Current |
| `docs/ORCHESTRATOR-SPEC.md` | 669 | 2026-04-04 | Agent Joe orchestrator architecture and lifecycle | Current |
| `docs/PR-REVIEW-WEBHOOK.md` | 218 | 2026-04-10 | PR automated code review via webhooks | Current |
| `docs/SETUP.md` | 420 | 2026-04-08 | Advanced self-hosted deployment (nginx, Authelia, systemd) | Current |
| `docs/stream-json-protocol.md` | 566 | 2026-04-08 | Claude CLI streaming protocol integration details | Current |
| `docs/WORKFLOWS.md` | 186 | 2026-04-01 | Automated workflow system, frontmatter format, built-in list | Stale |
| `server/workflows/code-review.daily.md` | 22 | 2026-03-08 | Daily code review workflow prompt | Current |
| `server/workflows/security-audit.weekly.md` | 66 | 2026-03-08 | Weekly security audit workflow prompt | Current |
| `server/workflows/complexity.weekly.md` | 54 | 2026-03-08 | Weekly complexity analysis workflow prompt | Current |
| `server/workflows/coverage.daily.md` | 41 | 2026-03-08 | Daily test coverage workflow prompt | Current |
| `server/workflows/comment-assessment.daily.md` | 41 | 2026-03-08 | Daily comment assessment workflow prompt | Current |
| `server/workflows/dependency-health.daily.md` | 46 | 2026-03-08 | Daily dependency health workflow prompt | Current |
| `server/workflows/docs-audit.weekly.md` | 97 | 2026-03-14 | Weekly documentation audit workflow prompt | Current |
| `server/workflows/repo-health.weekly.md` | 111 | 2026-03-09 | Weekly repo health check workflow prompt | Current |
| `server/workflows/commit-review.md` | 22 | 2026-03-11 | Event-driven commit review workflow prompt | Current |
| `server/workflows/pr-review.md` | 27 | 2026-04-10 | Event-driven PR review workflow prompt | Current |
| `.github/ISSUE_TEMPLATE/bug_report.md` | 40 | 2026-03-08 | Bug report template | Current |
| `.github/ISSUE_TEMPLATE/feature_request.md` | 23 | 2026-03-08 | Feature request template | Current |
| `.github/PULL_REQUEST_TEMPLATE.md` | 17 | 2026-03-08 | Pull request template | Current |

**Not included in this audit** (gitignored, not distributed):
- `review logs/2026-03-08_code-review-daily.md` — legacy report directory, gitignored
- `coverage-reports/2026-03-08_coverage-assessment.md` — legacy report directory, gitignored

---

## Staleness Findings

### 1. `docs/GITHUB-WEBHOOKS-SPEC.md` — Phases 2–4 sections are unimplemented roadmap content presented as specification

Last modified: **2026-03-16** — well before `docs/PR-REVIEW-WEBHOOK.md` was written (2026-04-10). The spec's status line reads "Phase 1 implemented and in production. Phases 2-4 are roadmap." However, 813 lines of spec intermix implemented and unimplemented content throughout, making it difficult to tell at a glance what is available today:

- **Line 133–145**: "Phase 2 — Expanded Events (Future)" — `check_run`, `check_suite` events not implemented
- **Lines 207, 223, 238**: Phase 2+ operating modes (`autonomous`, `notify-only`) — not implemented; Phase 1 is always `supervised`
- **Line 334–339**: `GITHUB_WEBHOOK_MODE` env var documented as "Phase 2" — not active yet
- **Lines 421, 441**: Manual retry API, auto-close timer — Phase 2 only
- **Lines 502–504**: Full pipeline with event queue and worker pool — Phase 2+
- **Lines 751–793**: Phases 2, 3, 4 — "Planned — Not Yet Implemented" but listed under "Implementation Phases"
- **Line 117**: "Future (Phase 2+): Migrate to direct GitHub REST API calls with `GITHUB_TOKEN`" — `GITHUB_TOKEN` appears in env table marked Phase 2 but is not in `server/config.ts`

Additionally, the PR Review webhook (shipped 2026-04-10) is a sibling feature to the CI failure webhook described here, but is documented entirely separately in `PR-REVIEW-WEBHOOK.md` with no cross-reference from this file.

### 2. `docs/WORKFLOWS.md` — `pr-review.md` omitted from built-in workflows table

Last modified: **2026-04-01**. The built-in workflows table (lines 68–78) lists 9 workflows. However, `server/workflows/pr-review.md` (added 2026-04-10) also exists in the same directory and is not listed. Because `pr-review` is event-driven rather than scheduled, its absence from the table is arguably intentional, but no note explains this distinction, leaving the table incomplete.

### 3. `SECURITY.md` — Oldest unchanged doc; predates major feature additions

Last modified: **2026-03-08** — before the Agent Joe orchestrator (v0.5.0), GitHub webhook integration, PR review automation, and the trust-escalation model were shipped. The file is not factually wrong (the general guidance remains valid) but is missing security considerations relevant to:
- Webhook HMAC validation (`GITHUB_WEBHOOK_SECRET` env var)
- Orchestrator trust escalation model and the `ASK/NOTIFY+DO/SILENT` permission levels
- The scope of actions the orchestrator can take autonomously

### 4. `docs/FEATURES.md` — Last modified 2026-03-16 but marked as updated to 2026-04-06 in git

Git log shows this file was last touched **2026-03-16** (not 2026-04-06 as the prior explore run suggested — audit is treating the git date as authoritative). PR Review (2026-04-10) is the most recently shipped feature and is not listed in the features file.

---

## Accuracy Issues

### 1. `docs/GITHUB-WEBHOOKS-SPEC.md` — `GITHUB_TOKEN` env var documented but not implemented

Line 334–339 documents a `GITHUB_TOKEN` environment variable as a Phase 2 addition. This variable does not appear in `server/config.ts`. A reader setting up webhooks today might search for this configuration and be confused by its absence. The Phase 2 label exists but is easy to miss in a long table.

### 2. `docs/GITHUB-WEBHOOKS-SPEC.md` — `GITHUB_WEBHOOK_MODE` env var not yet active

Line 339 documents `GITHUB_WEBHOOK_MODE` with default `supervised` and notes it is "ignored until Phase 2." The variable is not in `server/config.ts`. This is not wrong, but is potentially misleading for operators checking what env vars the server reads.

### 3. `docs/ORCHESTRATOR-SPEC.md` — One roadmap item unmarked

Line 5 states: "One Phase 3 item (auto-suggest workflow setup) remains roadmap." The spec's Phase 3 section (lines 503–510) lists this item with a `✓` alongside shipped items without distinguishing it clearly as the single remaining unshipped piece. A reader scanning the checkboxes would not notice this nuance without reading the status header.

### 4. `docs/WORKFLOWS.md` — `pr-review` omission creates an incomplete picture

As noted in Staleness, `server/workflows/pr-review.md` exists but is not in the table. A developer listing workflow kinds in code would find 10 files; the doc says 9. The table header "Built-in Workflows" does not clarify whether it covers all files in `server/workflows/` or only scheduled ones.

### 5. `docs/FEATURES.md` — PR Review feature missing

`docs/PR-REVIEW-WEBHOOK.md` describes a fully shipped feature (2026-04-10) but `docs/FEATURES.md` — the main feature index — does not list it. A user reading FEATURES.md to understand what Codekin can do would not discover the PR Review automation.

---

## Overlap & Redundancy

### Group A — Environment Variable Documentation (CONTRIBUTING.md vs SETUP.md)

Both files document server environment variables:

- **`CONTRIBUTING.md`** (lines 38–50): Definitive table of all 11 env vars with defaults and whether they are required in production.
- **`docs/SETUP.md`** (lines 221–240 and scattered): Documents env vars in the context of the self-hosted nginx+systemd deployment, with partial repetition of the same table.

**Assessment**: Overlap is intentional and appropriate — CONTRIBUTING.md targets developers, SETUP.md targets self-hosted operators. However, SETUP.md could link to CONTRIBUTING.md's table as the source of truth rather than partially reproducing it, reducing maintenance surface.

**More complete/current version**: `CONTRIBUTING.md`.

### Group B — Installation Instructions (README.md vs INSTALL-DISTRIBUTION.md vs SETUP.md)

Three files cover installation:

- **`README.md`**: One-liner quickstart (`curl … | bash`), brief config overview.
- **`docs/INSTALL-DISTRIBUTION.md`**: Full npm distribution model, CLI subcommands, service install, first-run wizard, release process.
- **`docs/SETUP.md`**: Advanced self-hosted bare-metal deployment with nginx, Authelia, systemd.

**Assessment**: Overlap is minimal and each file targets a clearly distinct audience. `SETUP.md` even opens with a note directing standard users to `INSTALL-DISTRIBUTION.md`. No merge needed.

### Group C — Webhook Documentation (GITHUB-WEBHOOKS-SPEC.md vs PR-REVIEW-WEBHOOK.md)

- **`docs/GITHUB-WEBHOOKS-SPEC.md`**: CI failure webhook — triggers Claude sessions to investigate and fix failing CI runs.
- **`docs/PR-REVIEW-WEBHOOK.md`**: PR review webhook — triggers Claude to post code review comments on pull requests.

Both cover GitHub webhooks, share infrastructure (signature validation, deduplication, workspace isolation), and describe overlapping configuration patterns. Neither cross-references the other. A reader arriving at either file gets an incomplete picture of the webhook system.

**Assessment**: Conceptually related but covers distinct use cases. They should not be merged, but `GITHUB-WEBHOOKS-SPEC.md` should reference `PR-REVIEW-WEBHOOK.md` and vice versa. Consider a top-level webhook index section in `docs/API-REFERENCE.md` or `FEATURES.md`.

---

## Fragmentation

### 1. Webhook architecture split across two separate spec files

`GITHUB-WEBHOOKS-SPEC.md` and `PR-REVIEW-WEBHOOK.md` share significant architectural ground (HMAC validation, rate limiting, workspace isolation, deduplication logic) documented redundantly. A developer trying to understand the webhook system must read both files. A short "Webhook System Overview" section at the top of one — linking to the other — would reduce the navigation burden without requiring a full merge.

### 2. `GITHUB-WEBHOOKS-SPEC.md` mixes shipped and roadmap content without clear visual separation

813 lines of implementation phases, of which ~300 lines describe Phases 2–4 (unimplemented). These roadmap sections are distributed throughout the document rather than isolated in a trailing "Roadmap" section, making it hard to skim for "what works today." A clear structural separation (e.g., "## Current Implementation" vs "## Roadmap") would help without removing useful future-planning content.

### 3. `server/workflows/` files are docs but not surfaced in the developer guide

The 10 workflow prompt files in `server/workflows/` are effectively documentation (they define AI behavior). `docs/WORKFLOWS.md` describes the format and lists most of them, but a developer looking for "what does the daily code-review prompt actually say?" has no pointer from the main docs to the `server/workflows/` directory.

### 4. Legacy report directories outside the canonical structure

`review logs/` (space in name) and `coverage-reports/` are gitignored directories containing single March 2026 report files that predate the current `.codekin/reports/<category>/` structure adopted in CLAUDE.md. They are not distributed and are not referenced by any documentation. They represent output from the old structure but their presence on disk can confuse contributors expecting all reports to live under `.codekin/reports/`.

---

## Action Items

### Delete

| File | Reason Safe to Delete |
|------|-----------------------|
| `review logs/2026-03-08_code-review-daily.md` *(gitignored)* | Legacy artifact from before `.codekin/reports/` structure; gitignored, not distributed, single file from 2026-03-08; content superseded by 25+ subsequent reports in `.codekin/reports/code-review/`. The directory name (space in path) is also non-standard. |
| `coverage-reports/2026-03-08_coverage-assessment.md` *(gitignored)* | Same reasoning as above — predates current reporting structure; content superseded by reports in `.codekin/reports/`. Only one file exists. |

> Note: Both directories are gitignored so deletion only affects the local working tree.

### Consolidate

| Source Files | Target File | What to Keep / Drop |
|---|---|---|
| `docs/GITHUB-WEBHOOKS-SPEC.md` Phases 2–4 sections + `docs/PR-REVIEW-WEBHOOK.md` | No merge needed, but **add cross-references** | In `GITHUB-WEBHOOKS-SPEC.md`: add a "See also" note at the top pointing to `PR-REVIEW-WEBHOOK.md`. Move all Phase 2–4 content to a clearly labelled `## Roadmap` section at the end of the file. In `PR-REVIEW-WEBHOOK.md`: add a link back to `GITHUB-WEBHOOKS-SPEC.md` for shared infrastructure context. |
| `docs/SETUP.md` env var table | Consolidate into `CONTRIBUTING.md` | Replace the partial env var table in `SETUP.md` with a link to the definitive table in `CONTRIBUTING.md`. Keeps SETUP.md focused on nginx/systemd configuration. |

### Update

| File | Sections Needing Update | What Changed in Code |
|---|---|---|
| `docs/WORKFLOWS.md` | Built-in Workflows table (lines 68–78) | Add `pr-review.md` to the table. Add a note clarifying it is event-driven (webhook-triggered) rather than scheduled, explaining why it operates differently from the other 9 workflows. |
| `docs/FEATURES.md` | Feature list | Add an entry for PR Review Automation (shipped 2026-04-10) with a link to `docs/PR-REVIEW-WEBHOOK.md`. |
| `docs/GITHUB-WEBHOOKS-SPEC.md` | Throughout — Phase 2–4 sections | (1) Add a status callout at the top clarifying which env vars are currently active vs. Phase 2+. (2) Move all Phase 2–4 subsections under a single `## Roadmap` section at the end. (3) Add a cross-reference to `PR-REVIEW-WEBHOOK.md`. |
| `SECURITY.md` | Security Considerations section | Add a paragraph on webhook security (HMAC signature validation via `GITHUB_WEBHOOK_SECRET`, importance of keeping the secret out of logs). Add a note on the orchestrator trust-escalation model and the permissions it can exercise autonomously. |
| `docs/ORCHESTRATOR-SPEC.md` | Phase 3 section (lines 503–510) | Mark the remaining unshipped item (auto-suggest workflow setup) with a clear `(roadmap)` label so it is visually distinct from the `✓` shipped items. |

---

## Recommendations

1. **Restructure `GITHUB-WEBHOOKS-SPEC.md` to separate current from roadmap.** The single highest-value change: move all Phase 2–4 content into a clearly labelled `## Roadmap` section at the end of the file. This makes the 813-line spec immediately readable for operators and prevents confusion about which env vars and features are active today. Estimated effort: 30 min.

2. **Add PR Review to `FEATURES.md` and `WORKFLOWS.md`.** Two small additions that close the gap between shipped functionality and its documentation. PR Review is the most recently shipped feature (2026-04-10) and is missing from both the feature index and the workflow table. Estimated effort: 15 min.

3. **Add cross-references between the two webhook spec files.** `GITHUB-WEBHOOKS-SPEC.md` and `PR-REVIEW-WEBHOOK.md` describe sibling subsystems. A single "See also" line at the top of each file significantly reduces navigation friction for developers working on the webhook layer. Estimated effort: 5 min.

4. **Refresh `SECURITY.md`.** The file is unchanged since the initial commit (2026-03-08) and the project has since shipped webhook HMAC validation and an orchestrator that can autonomously execute shell commands and file edits. Both warrant a security-considerations paragraph. Estimated effort: 20 min.

5. **Delink the env var table in `SETUP.md` from its current partial duplication.** Replace the partial env var listing in `SETUP.md` with a link to the authoritative table in `CONTRIBUTING.md`. Reduces future drift risk when env vars change. Estimated effort: 10 min.

6. **Delete the legacy `review logs/` and `coverage-reports/` directories.** These gitignored directories serve no ongoing purpose — their content is superseded and their existence on disk creates confusion about where reports should live. A one-time local `rm -rf` cleans this up. Estimated effort: 2 min.

7. **Add a pointer in `docs/WORKFLOWS.md` to `server/workflows/`.**  A single line telling developers where the actual workflow prompt files live would close the gap between the workflow system documentation and the implementation. Currently, a developer who reads WORKFLOWS.md and wants to inspect or customise a prompt has no pointer to `server/workflows/`. Estimated effort: 5 min.

8. **Consider a webhook system index page.** As the webhook surface grows (CI failures, PR review, with more planned), a lightweight `docs/WEBHOOKS.md` index linking to both `GITHUB-WEBHOOKS-SPEC.md` and `PR-REVIEW-WEBHOOK.md` — with a one-paragraph "how webhooks work" overview — would give the webhook docs a clear entry point. Medium priority; implement when a third webhook type is added.
