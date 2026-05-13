# Documentation Audit: codekin

**Date**: 2026-05-13T01:20:20.668Z
**Repository**: /srv/repos/codekin
**Branch**: main
**Workflow Run**: 0f12d591-2dee-4eb6-b570-a38e6d0e40b1
**Session**: 1ff65452-6034-48e4-8238-aba1f8bd937e

---

# Documentation Audit — Codekin Repository
**Date:** 2026-05-13
**Auditor:** Automated workflow (claude-sonnet-4-6)
**Scope:** All `.md` and `.txt` documentation files in `/srv/repos/codekin`

---

## Summary

**Total documentation files:** 16 primary docs + 4 GitHub community templates = 20 files, 5,379 lines across primary docs.

The repository's documentation is **actively maintained** and has received substantial attention through regular audit-driven PRs. The overall structure is clear and well-cross-linked. However, since the last major documentation push (2026-04-08 to 2026-04-28), approximately 30 commits have landed — including a version bump to 0.6.5, new "quiet mode" env vars, a rate-limit circuit breaker, single-branch workflow enforcement, and orchestrator child-termination notifications — none of which are reflected in CHANGELOG.md or the relevant feature/setup docs.

**Health rating: Needs cleanup** — architecture docs are accurate; versioned history and env-var reference are drifting behind the codebase.

**Key findings:**
- CHANGELOG.md stops at v0.6.0; versions 0.6.1–0.6.5 are unrecorded (32-day gap, ~30 commits).
- Two new "quiet mode" env vars (`CODEKIN_AUTO_RESTORE_SESSIONS`, `CODEKIN_ORCHESTRATOR_MONITOR`) introduced in #467 appear nowhere in any user-facing docs.
- Rate-limit circuit breaker (session-level, introduced in #468–#470) is undocumented outside server code.
- WORKFLOWS.md predates the single-branch enforcement (#472) and output-path fix (#441).
- No broken links found; `docs/screenshot.png` exists; `ecosystem.config.cjs.example` exists.
- No significant redundancy or fragmentation requiring structural changes.

---

## Documentation Inventory

| Path | Lines | Last Modified | Purpose | Status |
|---|---|---|---|---|
| `README.md` | 111 | 2026-04-25 | Public-facing overview: install, features, quick-start | Current |
| `CHANGELOG.md` | 461 | 2026-04-11 | Version history (Keep a Changelog format) | **Stale** — missing v0.6.1–0.6.5 |
| `CLAUDE.md` | 58 | 2026-04-10 | Developer conventions, branching policy, report conventions | Current |
| `CONTRIBUTING.md` | 114 | 2026-04-08 | Dev setup, env vars, testing, PR process | **Stale** — missing new quiet-mode env vars |
| `SECURITY.md` | 43 | 2026-03-08 | Supported versions, disclosure process, security considerations | Current |
| `CODE_OF_CONDUCT.md` | 31 | 2026-03-08 | Contributor Covenant v2.1 | Current |
| `docs/API-REFERENCE.md` | 764 | 2026-04-28 | REST and WebSocket API reference with endpoint details | Current |
| `docs/FEATURES.md` | 421 | 2026-04-26 | Feature-by-feature breakdown of Codekin capabilities | **Stale** — missing circuit breaker, orchestrator child-term notifications |
| `docs/GITHUB-WEBHOOKS-SPEC.md` | 947 | 2026-04-25 | Webhook integration spec: CI failure fixing + PR review | Current |
| `docs/INSTALL-DISTRIBUTION.md` | 184 | 2026-04-09 | npm distribution model, CLI commands, publish process | **Stale** — missing quiet-mode env vars |
| `docs/ORCHESTRATOR-SPEC.md` | 748 | 2026-04-25 | Agent Joe orchestrator spec: architecture, memory, API | **Stale** — child-termination notification feature (#462) not reflected |
| `docs/SETUP.md` | 420 | 2026-04-08 | Bare-metal self-hosted deployment guide (nginx, systemd) | **Stale** — missing quiet-mode env vars |
| `docs/stream-json-protocol.md` | 566 | 2026-04-08 | Internal Claude CLI stream-json protocol details | **Stale** — missing quiet mode defaults, circuit breaker |
| `docs/WORKFLOWS.md` | 187 | 2026-04-15 | Workflow execution model, YAML frontmatter spec, built-in kinds | **Stale** — predates single-branch enforcement and output-path fix |
| `docs/operations/workflow-resilience.md` | 196 | 2026-04-27 | Ops runbook: workflow restart/resume, orphan session handling | Current |
| `docs/operations/ws-rate-limit.md` | 128 | 2026-04-27 | Ops guide: WebSocket per-IP and per-connection rate limits | Current |
| `.github/PULL_REQUEST_TEMPLATE.md` | 18 | — | PR submission template | Current |
| `.github/ISSUE_TEMPLATE/bug_report.md` | 41 | — | Bug report template | Current |
| `.github/ISSUE_TEMPLATE/feature_request.md` | 17 | — | Feature request template | Current |

---

## Staleness Findings

### 1. `CHANGELOG.md` — Versions 0.6.1–0.6.5 Missing
- **Last modified:** 2026-04-11. Current package version is `0.6.5` (bumped 2026-04-28 via #410e103).
- The `[Unreleased]` section exists but is empty.
- **Unrecorded changes since 2026-04-11 include (non-exhaustive):**
  - `fix: cap headless session lifetime + circuit-break on rate limits` (#468)
  - `fix(rate-limit): make notification text honest about backoff vs quota` (#469)
  - `fix(rate-limit): only trip circuit breaker on overageStatus=rejected` (#470)
  - `feat: enforce single-branch report commit for AI workflows` (#472)
  - `fix: default to quiet mode (no boot-time Claude spawns or 15m monitor)` (#467)
  - `feat(orchestrator): notify parent session immediately when a child terminates` (#462/#463)
  - `fix(security): canonicalize clone destination to prevent symlink escape` (#453)
  - `fix(security): validate permissionMode at runtime on session creation` (#452)
  - `fix(security): sanitize commit-event prompt input` (#455)
  - `fix(workflow): single output path per audit + fresh branch per run` (#441)
  - `chore: bump version to 0.6.5` + five intermediate version bumps (#410e103)
  - Multiple security fixes: cron DoS, path traversal, dedup scoping, PATCH validation (#449)
  - `docs: add ecosystem.config.cjs.example with interpreter pin` (#471)

### 2. `docs/FEATURES.md` — Undocumented Post-2026-04-26 Behavior
- **Rate-limit circuit breaker** (`#468–#470`): Sessions now implement a circuit breaker that pauses background orchestrator activity when the Claude API signals rate-limiting. No mention of this anywhere in FEATURES.md.
- **Orchestrator child-termination notifications** (`#462, #463`): The orchestrator now immediately notifies the parent session when a child terminates. FEATURES.md "Agent Joe" section does not reflect this.
- **Single-branch workflow commits** (`#472`): Workflow reports are now enforced to commit on a single dedicated branch. FEATURES.md workflow section implies per-run branching without this constraint.

### 3. `docs/WORKFLOWS.md` — Predates Two Workflow Behavioral Fixes
- **Single-branch enforcement** (`#472`, 2026-05-13): Commit `42dc412` enforces that all workflow report commits land on one branch. WORKFLOWS.md step 4 ("save_report") describes auto-commit without this constraint.
- **Single output path per audit** (`ef26c80` / #441, 2026-04-27): Fixed so each workflow run uses a consistent, non-duplicating output path. WORKFLOWS.md does not reflect this fix.
- **Fresh branch per run** (same commit): Branch is now freshly forked from `origin/main` each run. WORKFLOWS.md says "commit it to the repository" without clarifying branching behavior.

### 4. `docs/SETUP.md` and `docs/INSTALL-DISTRIBUTION.md` — Missing Quiet-Mode Env Vars
- Commit `63d04e7` (#467, 2026-04-28) introduced two new opt-in env vars with "off by default" behavior:
  - `CODEKIN_AUTO_RESTORE_SESSIONS` — restores sessions on server restart (default: off)
  - `CODEKIN_ORCHESTRATOR_MONITOR` — enables background orchestrator polling (default: off)
- Neither variable appears in SETUP.md's environment variable section, INSTALL-DISTRIBUTION.md's configuration reference, or CONTRIBUTING.md's variable table.

### 5. `docs/stream-json-protocol.md` — Missing Circuit Breaker and Quiet Mode Context
- **Last modified:** 2026-04-08 — predates multiple significant changes to session lifecycle.
- No mention of session-level rate-limit circuit breaker that pauses background spawning (introduced #468).
- No mention of `CODEKIN_AUTO_RESTORE_SESSIONS` or its default-off behavior (introduced #467).
- The "Session Lifecycle" section describes auto-restore behavior as though it is always active; it now requires explicit opt-in.

### 6. `docs/ORCHESTRATOR-SPEC.md` — Child-Termination Notification Missing
- **Last modified:** 2026-04-25. Feature added post-date: `feat(orchestrator): notify parent session immediately when a child terminates` (#462, #463, 2026-04-28/2026-04-29).
- The spec's "Child Session Management" and "Lifecycle" sections do not mention this event-driven notification mechanism.

---

## Accuracy Issues

### 1. CONTRIBUTING.md — `AUTO_RESTORE_SESSIONS` and `ORCHESTRATOR_MONITOR` Not Listed
The variable table in CONTRIBUTING.md ends with `CODEKIN_AGENT_NAME`. Two new variables verified in `server/config.ts` (lines 136, 143) are absent:
- `CODEKIN_AUTO_RESTORE_SESSIONS` — opt-in session restore on server boot
- `CODEKIN_ORCHESTRATOR_MONITOR` — opt-in orchestrator background polling

### 2. `docs/stream-json-protocol.md` — Auto-Restore Presented as Default Behavior
The "Session Lifecycle" section implies session auto-restore and the 15-minute stall monitor run by default. Since #467, both default to **off**; operators must set `CODEKIN_AUTO_RESTORE_SESSIONS=true` and `CODEKIN_ORCHESTRATOR_MONITOR=true` to enable them. This is a behavioral reversal not reflected in the doc.

### 3. `docs/WORKFLOWS.md` — Step 4 Description Inaccurate for Branch Behavior
Step 4 says the report is "committed to the repository." Since #472, the behavior is more specific: all workflow report commits are enforced onto a single named branch (not arbitrary or per-run branches). The description should clarify this constraint.

### 4. `docs/ORCHESTRATOR-SPEC.md` — `ORCHESTRATOR_MONITOR` Startup Behavior
The spec says the orchestrator is "always-on" and "survives restarts." This is now opt-in via `CODEKIN_ORCHESTRATOR_MONITOR`. The "Lifecycle" section needs updating to reflect the default-off startup posture introduced in #467.

### 5. `CHANGELOG.md` — `[Unreleased]` Section Is Misleading
The `[Unreleased]` section exists but is empty, even though ~30 commits have landed since v0.6.0. Readers relying on the changelog to assess what has changed since the last release will find no information.

---

## Overlap & Redundancy

### Environment Variable Documentation (Minor Overlap)
Three files each contain an env var reference table covering largely the same variables:
- `CONTRIBUTING.md` (dev-focused, 18 vars)
- `docs/INSTALL-DISTRIBUTION.md` (operator-focused, ~10 vars)
- `docs/SETUP.md` (bare-metal, ~15 vars + webhook vars)

The overlap is intentional for different audiences but creates a maintenance burden — as demonstrated by the missing quiet-mode vars across all three. The tables are not identical (SETUP.md includes webhook vars; CONTRIBUTING.md includes development-only vars), so a full merge is not appropriate. However, a single authoritative reference with audience-tagged entries would reduce drift.

### Rate-Limit Documentation (Partial Overlap)
- `docs/API-REFERENCE.md` covers WebSocket transport-level rate limits (per-IP connections, per-connection message rate).
- `docs/operations/ws-rate-limit.md` covers the same topic more deeply with tuning guidance.
- `docs/FEATURES.md` references "exponential backoff" in the keepalive context but not rate limiting.

The API-REFERENCE and ws-rate-limit.md are appropriately split (reference vs. runbook). No consolidation needed, but FEATURES.md should be updated to mention the circuit-breaker behavior.

No other meaningful overlap was found. The spec docs (GITHUB-WEBHOOKS-SPEC, ORCHESTRATOR-SPEC, stream-json-protocol) are clearly scoped and do not duplicate each other.

---

## Fragmentation

### Env Var Reference Split Across Three Files
As noted above, `CONTRIBUTING.md`, `INSTALL-DISTRIBUTION.md`, and `SETUP.md` each carry an env var table. While the audiences differ, the absence of a single canonical list means new variables are routinely omitted from one or more places. **Recommendation:** add a dedicated `docs/CONFIGURATION.md` as the master reference; reduce the tables in the other three to pointers plus audience-specific annotations.

### No Fragmentation Requiring Merges
All other documentation files have clear, non-overlapping scope. The `docs/operations/` subdirectory effectively extends the main docs with operational depth without duplicating content. No completed proposal docs or stale design sketches were found.

---

## Action Items

### Delete

| File | Reason it is safe to delete |
|---|---|
| *(none)* | No files are fully superseded, describe completed proposals with no ongoing reference value, or contain only outdated content. All files serve a current audience. |

### Consolidate

| Source Files | Target File | What to Keep / Drop |
|---|---|---|
| `CONTRIBUTING.md` (env var table), `docs/INSTALL-DISTRIBUTION.md` (config reference), `docs/SETUP.md` (env var section) | `docs/CONFIGURATION.md` (new) | Keep all unique vars; tag each with audience (dev / operator / webhook); reduce the three source tables to a one-line cross-reference. This is **optional** but would eliminate the recurring maintenance gap. |

### Update

| File | Sections Needing Update | What Changed in Code |
|---|---|---|
| `CHANGELOG.md` | `[Unreleased]` section; add entries for v0.6.1–v0.6.5 | ~30 commits since v0.6.0 including security fixes, rate-limit circuit breaker, quiet mode, single-branch enforcement, orchestrator notifications, deps bump |
| `docs/FEATURES.md` | "Agent Joe Orchestrator" section; "Workflows" section; add sub-section on rate-limit behavior | Circuit breaker pauses background spawning; orchestrator notifies parent on child termination; workflow commits now single-branch |
| `docs/WORKFLOWS.md` | Step 4 "save_report"; "Output" section | Single-branch enforcement (#472); single output path per audit (#441); branch forked fresh from `origin/main` each run |
| `CONTRIBUTING.md` | Environment Variables table | Add `CODEKIN_AUTO_RESTORE_SESSIONS` (default: off) and `CODEKIN_ORCHESTRATOR_MONITOR` (default: off) |
| `docs/SETUP.md` | Environment Variables section | Add `CODEKIN_AUTO_RESTORE_SESSIONS` and `CODEKIN_ORCHESTRATOR_MONITOR` with default-off note |
| `docs/INSTALL-DISTRIBUTION.md` | Configuration reference table | Add `CODEKIN_AUTO_RESTORE_SESSIONS` and `CODEKIN_ORCHESTRATOR_MONITOR` |
| `docs/stream-json-protocol.md` | "Session Lifecycle" section | Auto-restore and monitor are now opt-in (default off since #467); document rate-limit circuit breaker that pauses background activity |
| `docs/ORCHESTRATOR-SPEC.md` | "Lifecycle" section; "Child Session Management" | Default-off startup posture; child-termination parent notifications (#462/#463) |

---

## Recommendations

1. **Update CHANGELOG.md immediately.** The `[Unreleased]` section is empty despite ~30 meaningful commits since v0.6.0 (2026-04-10). Readers and operators rely on this file to understand what has changed. Log the security fixes, behavioral reversals, and new features at minimum. Create entries for v0.6.1–v0.6.5 matching the bump commits.

2. **Document the two quiet-mode env vars in all three env-var tables.** `CODEKIN_AUTO_RESTORE_SESSIONS` and `CODEKIN_ORCHESTRATOR_MONITOR` were silently introduced as default-off. They affect server boot behavior fundamentally and must appear in CONTRIBUTING.md, SETUP.md, and INSTALL-DISTRIBUTION.md before the next release.

3. **Correct stream-json-protocol.md's session lifecycle description.** The "auto-restore" and stall-monitor passages currently imply always-on behavior. Since #467 these are opt-in. A single corrective paragraph and a note in the env var table suffices.

4. **Update WORKFLOWS.md to reflect the single-branch enforcement (#472) and fresh-branch-per-run behavior (#441).** Users and operators running or customizing workflows need accurate expectations about where commits land and how branches are managed.

5. **Add a "Rate-limit circuit breaker" sub-section to FEATURES.md.** This is user-visible behavior (the UI receives rate-limit events; background orchestrator activity pauses). It is currently undocumented outside the server source and is a meaningful operational characteristic.

6. **Update ORCHESTRATOR-SPEC.md to reflect default-off startup and child-termination notifications.** The spec is the primary reference for anyone operating or extending Agent Joe. The "always-on" lifecycle claim and missing notification mechanism are inaccurate.

7. **Consider creating `docs/CONFIGURATION.md` as a single env-var reference.** The recurring failure mode — new vars missing from one or more of three files — argues for a single authoritative table. This is the most impactful structural change available and would reduce future drift.

8. **Review API-REFERENCE.md for session-level circuit-breaker exposure.** The session creation endpoint and the WebSocket `rate_limit_event` message type may warrant a note that repeated rate-limit events activate a circuit breaker affecting background orchestrator polling. The current rate-limit section covers transport limits only.

9. **Add `CODEKIN_AUTO_RESTORE_SESSIONS` and `CODEKIN_ORCHESTRATOR_MONITOR` to the SETUP.md troubleshooting section.** Operators who previously relied on auto-restore (which was the default) may be confused after upgrading to 0.6.x. A troubleshooting note pointing to these flags would reduce support load.

10. **Keep the documentation structure as-is.** The existing split between `docs/` (feature/spec/reference) and `docs/operations/` (runbooks) is logical and easy to navigate. No reorganization is needed beyond the consolidation candidate in item 7.