# Documentation Audit: codekin

**Date**: 2026-06-03T19:21:50.278Z
**Repository**: /srv/repos/Multiplier-Labs/codekin
**Branch**: main
**Workflow Run**: 186e3da2-56f5-49ff-8e7f-4e308d49097a
**Session**: bcbdbcee-0592-4a1e-b81e-cd4185da926b

---

Now I have enough data to write the full audit report.

---

## Summary

**Total documentation files**: 16 primary docs (6 root-level, 10 in `docs/`), plus 10 built-in workflow prompt files in `server/workflows/` (not user-facing docs but auditable for accuracy). Excluding the `.codekin/reports/` archive and `.github/` templates.

**Health rating: Needs cleanup** — The documentation corpus is well-structured and actively maintained (last major refresh: 2026-05-15). However, four concrete accuracy issues were found: a stale model table in `API-REFERENCE.md`, wrong workflow output directories in `WORKFLOWS.md`, stale product naming in `FEATURES.md`, and a missing CLI command in `README.md`. No files are fully obsolete or deserve deletion, but several need targeted updates.

---

## Documentation Inventory

| Path | Lines | Last Modified | Purpose | Status |
|---|---|---|---|---|
| `README.md` | 111 | 2026-04-25 | Public-facing install, usage, features overview | Stale (missing CLI command) |
| `CHANGELOG.md` | 591 | 2026-05-15 | Version history | Current |
| `CONTRIBUTING.md` | 116 | 2026-05-15 | Contributor guidelines, PR process, dev setup | Current |
| `CODE_OF_CONDUCT.md` | 31 | 2026-03-08 | Community conduct policy | Current |
| `CLAUDE.md` | 58 | 2026-04-10 | AI agent instructions for Claude Code | Current |
| `SECURITY.md` | 43 | 2026-03-08 | Vulnerability reporting & security policy | Current |
| `docs/API-REFERENCE.md` | 764 | 2026-04-28 | REST/WebSocket API, models, rate limits | Stale (model table outdated) |
| `docs/FEATURES.md` | 421 | 2026-04-26 | Complete feature reference for end users | Stale (naming, workflow list/dirs) |
| `docs/GITHUB-WEBHOOKS-SPEC.md` | 947 | 2026-04-25 | GitHub webhook integration & PR review architecture | Current |
| `docs/INSTALL-DISTRIBUTION.md` | 186 | 2026-05-15 | npm distribution, CLI commands, release process | Current |
| `docs/ORCHESTRATOR-SPEC.md` | 748 | 2026-04-25 | Agent Joe orchestrator architecture & capabilities | Current |
| `docs/SETUP.md` | 434 | 2026-05-15 | Advanced / self-hosted bare-metal setup with nginx, Authelia | Current |
| `docs/WORKFLOWS.md` | 187 | 2026-05-15 | Workflow definition format, built-in list, custom workflows | Stale (output dirs wrong; count wrong) |
| `docs/stream-json-protocol.md` | 566 | 2026-04-08 | Claude Code stream-JSON spawning protocol & event types | Current |
| `docs/operations/ws-rate-limit.md` | 128 | 2026-04-27 | WebSocket rate limiting per-IP and per-connection | Current |
| `docs/operations/workflow-resilience.md` | 196 | 2026-04-27 | Workflow restart-resume and orphan-session handling | Current |

---

## Staleness Findings

### 1. `docs/WORKFLOWS.md` — Output directory table is significantly out of date

The table on lines 70–79 lists workflow output directories that were replaced at some point with a unified `.codekin/reports/` structure. **Six of ten entries are wrong**:

| Workflow | Table claims | Actual frontmatter (`outputDir`) |
|---|---|---|
| `code-review.daily` | `review logs/` | `.codekin/reports/code-review` |
| `security-audit.weekly` | `security-reports/` | `.codekin/reports/security` |
| `complexity.weekly` | `complexity-reports/` | `.codekin/reports/complexity` |
| `coverage.daily` | `coverage-reports/` | `.codekin/reports/coverage` |
| `comment-assessment.daily` | `comment-reports/` | `.codekin/reports/comments` |
| `dependency-health.daily` | `dependency-reports/` | `.codekin/reports/dependencies` |

The remaining four (`docs-audit`, `commit-review`, `repo-health`, and `pr-review`) are correct.

Additionally, the doc states "Codekin ships with **nine** built-in workflows" in two places (lines 3 and 66), but there are **ten** workflow files in `server/workflows/` — `pr-review.md` was added and appears in the table but was not counted.

### 2. `docs/API-REFERENCE.md` — Models table missing `claude-opus-4-8`

The models table (lines 76–80) lists four model identifiers: `claude-opus-4-7`, `claude-opus-4-6`, `claude-sonnet-4-6`, `claude-haiku-4-5-20251001`. The file was last updated 2026-04-28; `claude-opus-4-8` was added to `src/types.ts` in commit `ce890c1` (#480, after that date). The doc is missing Opus 4.8 and example API calls on lines 490 and 558 still reference `claude-opus-4-7` as the canonical example model.

### 3. `docs/FEATURES.md` — Stale `cc-web` product naming (3 occurrences)

Three references use the old internal service name `cc-web` rather than the public product name `Codekin`:

- Line 330: *"Enter your cc-web token in the Settings modal"* → should be "Codekin token"
- Line 399 (architecture diagram): *"cc-web server (port 32352)"* → should be "Codekin server"
- Line 410 (services table): service named *"cc-web server"* → should be "Codekin"

These would confuse users who find no such thing called `cc-web` in the product.

### 4. `docs/FEATURES.md` — `pr-review` missing from built-in workflow list

The "Automated Workflows" section (lines 175–188) lists 9 built-in workflow types but omits `pr-review`. The PR Review feature is documented in its own section later, but the workflow table is incomplete for cross-reference.

### 5. `README.md` — `codekin stop` not documented

The Usage section lists 8 CLI commands but omits `codekin stop` (stop the running background service). This command is implemented in `bin/codekin.mjs` and referenced in `docs/SETUP.md`. Users relying only on the README have no indication this command exists.

---

## Accuracy Issues

### 1. `docs/WORKFLOWS.md` — "Report Output" section uses stale example paths

The "Auto-committed reports" bullet in `docs/FEATURES.md` (line 188) cites `review logs/` and `security-reports/` as example `outputDir` values. These are no longer representative of any real workflow; all built-in workflows now use `.codekin/reports/<topic>`.

### 2. `docs/FEATURES.md` — "Shipped: 2026-04-10" marker in PR Review Automation section

Line 196 contains `**Shipped**: 2026-04-10` — a delivery timestamp from when the feature was first released. This is stale metadata that belongs in the CHANGELOG, not in the feature reference. It creates a confusing impression that the feature is experimental or newly added.

### 3. `docs/FEATURES.md` — Session persistence path slightly misleading

Line 300 states sessions are persisted to `~/.codekin/sessions.json`. The code in `server/session-manager.ts` delegates to `SessionPersistence` — the actual path is controlled by `DATA_DIR`. The default is correct (`~/.codekin/`) but documenting the full path `~/.codekin/sessions.json` as fixed is fragile; the `DATA_DIR` override is not mentioned here, though it is documented elsewhere.

### 4. `docs/INSTALL-DISTRIBUTION.md` — Install script URL differs from README

`README.md` line 22 shows the install URL as `curl -fsSL codekin.ai/install.sh | bash` (no scheme specified beyond the hostname), while `docs/INSTALL-DISTRIBUTION.md` line 8 shows `curl -fsSL https://raw.githubusercontent.com/Multiplier-Labs/codekin/main/install.sh | bash` (GitHub raw URL). These are not necessarily wrong (one may be a CDN redirect of the other), but they are inconsistent and the difference may confuse users comparing docs.

---

## Overlap & Redundancy

### Feature coverage overlap: `docs/FEATURES.md` ↔ `README.md`

`README.md` contains a Features section (lines 50–68) with a concise bullet list. `docs/FEATURES.md` is a 421-line deep-dive on the same topics. This is intentional (README = terse overview, FEATURES.md = full reference) and not a problem — they serve different audiences. No merge needed.

### Workflow documentation overlap: `docs/FEATURES.md` ↔ `docs/WORKFLOWS.md`

`docs/FEATURES.md` § "Automated Workflows" (lines 172–190) duplicates some of `docs/WORKFLOWS.md`'s content (list of built-ins, staleness check, auto-commit behavior). The FEATURES section correctly cross-links to WORKFLOWS.md. No merge recommended, but both files need the same output-directory correction.

### Install documentation overlap: `README.md` ↔ `docs/INSTALL-DISTRIBUTION.md` ↔ `docs/SETUP.md`

Three documents cover installation:
- `README.md` — one-liner for end users
- `docs/INSTALL-DISTRIBUTION.md` — release/distribution process (maintainers) + standard user config reference
- `docs/SETUP.md` — advanced/self-hosted bare-metal with nginx and Authelia

The scope is clearly differentiated and cross-linking is in place. No consolidation needed; this is appropriate layering.

### Operations docs: `docs/operations/ws-rate-limit.md` ↔ `docs/API-REFERENCE.md`

`docs/API-REFERENCE.md` § "WebSocket Server Hardening" (lines 19–67) fully covers per-IP and per-connection rate limiting — the same content as `docs/operations/ws-rate-limit.md`. This is the most significant redundancy in the corpus.

| Files | Shared topic | More complete version |
|---|---|---|
| `docs/API-REFERENCE.md` (§ WebSocket Server Hardening) and `docs/operations/ws-rate-limit.md` | WS rate limiting config, thresholds, behaviour | API-REFERENCE is more detailed and is the authoritative reference |

**Recommendation**: The `ws-rate-limit.md` ops doc can be reduced to a brief ops-focused summary (circuit-breaker behaviour, alerting) with a pointer to API-REFERENCE for config details, or folded into API-REFERENCE entirely.

---

## Fragmentation

### `docs/operations/` directory — two small files that could merge

`docs/operations/ws-rate-limit.md` (128 lines) and `docs/operations/workflow-resilience.md` (196 lines) are short, audience-compatible files covering production operational concerns. Neither is large enough to justify separate navigation. They would be easier to read and maintain as a single `docs/operations/operations-guide.md` or renamed `docs/OPERATIONS.md`.

### `server/workflows/*.md` — workflow prompts are not user documentation

The files in `server/workflows/` are runtime prompt templates, not documentation for users or developers. They do not need to appear in any docs index, but they should be accurate (they are, currently). No action needed beyond keeping them out of the docs inventory.

### No completed "proposal" or "plan" documents found

No `PROPOSAL-*.md`, `PLAN-*.md`, or similar speculative design docs exist in the repo. All current docs describe shipped functionality.

---

## Action Items

### Delete

No files are candidates for outright deletion. All 16 primary docs describe current, live functionality.

| File | Reason considered | Decision |
|---|---|---|
| `docs/operations/ws-rate-limit.md` | Redundant with API-REFERENCE | Keep but reduce; see Consolidate |

### Consolidate

| Source files | Target file | What to keep / drop |
|---|---|---|
| `docs/operations/ws-rate-limit.md` + `docs/operations/workflow-resilience.md` | `docs/operations/OPERATIONS.md` | Merge both files verbatim under a single ops guide; rename the directory file |
| `docs/API-REFERENCE.md` § WebSocket Hardening + `docs/operations/ws-rate-limit.md` | `docs/API-REFERENCE.md` (keep) | Drop the rate-limit detail from `ws-rate-limit.md`; replace with a 2–3 sentence summary linking to API-REFERENCE |

### Update

| File | Section | What changed / what's wrong |
|---|---|---|
| `docs/API-REFERENCE.md` | § Models table (lines 76–80) | Add `claude-opus-4-8 → Opus 4.8` (added in #480 after doc was last updated) |
| `docs/API-REFERENCE.md` | Example request bodies (lines 490, 558) | Update example `model` value from `claude-opus-4-7` to `claude-opus-4-8` |
| `docs/WORKFLOWS.md` | Built-in workflows table (lines 70–76) | Correct output directory column: replace `review logs/`, `security-reports/`, `complexity-reports/`, `coverage-reports/`, `comment-reports/`, `dependency-reports/` with actual `.codekin/reports/*` paths from workflow frontmatter |
| `docs/WORKFLOWS.md` | Lines 3 and 66 (workflow count) | Change "nine" → "ten" |
| `docs/FEATURES.md` | § Authentication & Security (line 330) | Replace "cc-web token" → "Codekin token" |
| `docs/FEATURES.md` | § Architecture Overview (lines 399, 410) | Replace "cc-web server" → "Codekin server" in both the architecture diagram and the services table |
| `docs/FEATURES.md` | § Automated Workflows (line 188) | Update `outputDir` examples from `review logs/`, `security-reports/` to `.codekin/reports/<topic>` |
| `docs/FEATURES.md` | § Automated Workflows built-in list (lines 175–184) | Add `pr-review` (event-driven, posts to GitHub PR) to complete the list to 10 |
| `docs/FEATURES.md` | § PR Review Automation (line 196) | Remove `**Shipped**: 2026-04-10` — shipping dates belong in CHANGELOG, not feature reference |
| `README.md` | § Usage command table (lines 38–47) | Add `codekin stop` — implemented in `bin/codekin.mjs`, already in SETUP.md but missing here |

---

## Recommendations

1. **Fix WORKFLOWS.md output directory table immediately** (highest impact). All six wrong paths (`review logs/` etc.) will actively mislead users who try to find their reports after a workflow run. This is a one-pass find-and-replace against the actual workflow frontmatter.

2. **Update API-REFERENCE.md models table** to include `claude-opus-4-8`. The model was added in #480; the reference doc now lags behind the actual codebase and UI selector.

3. **Purge all three `cc-web` references from FEATURES.md**. The old internal service name surfaces to users reading the authentication section and architecture diagram. Simple string replacements.

4. **Add `codekin stop` to README.md usage table**. The omission creates a gap — users who read only the README (the most likely starting point) have no way to discover the stop command without reading deeper docs.

5. **Correct the workflow count claim** in WORKFLOWS.md from "nine" to "ten." The table already lists 10; only the prose lags.

6. **Merge `docs/operations/` into a single file**. Two 128- and 196-line files under `docs/operations/` are too fragmented to justify separate navigation. A single `docs/operations/OPERATIONS.md` is easier to discover and maintain.

7. **Remove the `Shipped: 2026-04-10` timestamp from FEATURES.md §PR Review**. Feature-reference docs describe current state, not delivery dates. Move it to CHANGELOG if not already there.

8. **Reconcile install script URLs** between README.md (`codekin.ai/install.sh`) and INSTALL-DISTRIBUTION.md (GitHub raw URL). Pick the canonical URL and use it in both places, or add a note that one redirects to the other.

9. **Clarify session persistence path** in FEATURES.md §Session Persistence to mention that `~/.codekin/sessions.json` is the default and can be relocated via `DATA_DIR`.

10. **Add a completeness check to the workflow frontmatter** (or CI lint) to ensure that future changes to `outputDir` in `.md` workflow files automatically flag the WORKFLOWS.md table as needing review. This is the root cause of finding #1 and will recur without a guardrail.