# Documentation Audit: codekin

**Date**: 2026-04-01T01:20:52.650Z
**Repository**: /srv/repos/codekin
**Branch**: chore/repo-health-report-2026-03-30
**Workflow Run**: a6929990-e201-4332-8d0d-18b5c3ae3ca1
**Session**: fb32c84d-092a-4713-bfb5-efc0e84a2f2c

---

Now I have enough data to write the comprehensive audit report.

```markdown
## Summary

The Codekin documentation corpus comprises **15 authored documentation files** (6 root-level `.md` files and 9 in `docs/`) plus 9 workflow definition files in `server/workflows/`. GitHub issue/PR templates are not evaluated here.

Overall health: **Needs cleanup.** The core user-facing docs (README, CONTRIBUTING, API-REFERENCE) are in good shape. However, several issues require attention:

- Two built-in workflows (`commit-review` and `repo-health.weekly`) are entirely absent from `docs/WORKFLOWS.md`
- `docs/FEATURES.md` is missing the Agent Joe orchestrator feature (shipped in v0.5.0), and documents incorrect API paths for the Docs Browser
- `docs/SETUP.md` contains a Node.js version contradiction, references a non-existent `scripts/` directory and `scan-repos.mjs` script, and describes an outdated manual repo-scanning workflow
- `docs/ORCHESTRATOR-SPEC.md` still carries "Draft v0.1" status despite the feature being shipped and in production
- `docs/INSTALL-DISTRIBUTION.md` references `deploy.sh` as documented in `CLAUDE.md`, but neither claim is true
- `CHANGELOG.md` stops at v0.5.0 while the package is at v0.5.1

---

## Documentation Inventory

| Path | Lines | Last Modified | Purpose | Status |
|---|---|---|---|---|
| `README.md` | 106 | 2026-03-23 | User-facing install, usage, features overview, config table | Current |
| `CONTRIBUTING.md` | 111 | 2026-03-18 | Developer setup, env vars, conventions, PR process | Current |
| `CLAUDE.md` | 48 | 2026-03-08 | AI assistant instructions: architecture, dev commands, conventions, branching policy | Current |
| `CHANGELOG.md` | 306 | 2026-03-23 | Semver changelog from v0.2.0 → v0.5.0 | Stale (missing v0.5.1) |
| `CODE_OF_CONDUCT.md` | 31 | 2026-03-08 | Community standards (Contributor Covenant v2.1) | Current |
| `SECURITY.md` | 43 | 2026-03-08 | Vulnerability reporting, response timelines, deployment security | Current |
| `docs/API-REFERENCE.md` | 385 | 2026-03-16 | Full REST API reference for all endpoints | Current |
| `docs/FEATURES.md` | 364 | 2026-03-18 | Comprehensive feature reference with implementation details | Stale |
| `docs/SETUP.md` | 437 | 2026-03-16 | Production setup guide: nginx, systemd, webhooks, directory structure | Stale |
| `docs/WORKFLOWS.md` | 182 | 2026-03-14 | Workflow system guide: format, built-in list, custom workflows | Stale |
| `docs/INSTALL-DISTRIBUTION.md` | 181 | 2026-03-16 | npm distribution model, CLI commands, release process, config reference | Stale |
| `docs/GITHUB-WEBHOOKS-SPEC.md` | 810 | 2026-03-23 | GitHub webhooks integration spec (Phase 1 shipped; Phases 2-4 roadmap) | Outdated (spec partially superseded) |
| `docs/ORCHESTRATOR-SPEC.md` | 669 | 2026-03-23 | Agent Joe design spec — session model, capabilities, memory, personality | Outdated (shipped; status not updated) |
| `docs/stream-json-protocol.md` | 586 | 2026-03-22 | Claude Code stream-JSON protocol reference (spawning, events, hooks) | Current |

**Workflow definitions** (`server/workflows/`): 9 files, 500 total lines. Not user-facing docs; omitted from detailed analysis.

---

## Staleness Findings

### 1. `docs/WORKFLOWS.md` — Missing two built-in workflows

The file lists 7 built-in workflows in its table. The actual `server/workflows/` directory contains **9** files:

- **`commit-review.md`** — not listed anywhere in `WORKFLOWS.md` or `FEATURES.md`
- **`repo-health.weekly.md`** — not listed anywhere in `WORKFLOWS.md` or `FEATURES.md`

The table also documents `docs-audit.weekly` as writing to `.codekin/reports/docs-audit/` which differs from other built-in output paths — this may be intentional but is worth confirming.

### 2. `docs/FEATURES.md` — Agent Joe entirely absent

The v0.5.0 release (2026-03-23) shipped Agent Joe as a major feature, listed prominently in `README.md` and `CHANGELOG.md`. `FEATURES.md` was last modified on 2026-03-18 — before the release — and contains no mention of Agent Joe, orchestrator sessions, child session management, worktrees, or the permission mode selector. The "Multi-Session Management" section is incomplete as a result.

### 3. `docs/FEATURES.md` — Wrong API paths for Docs Browser

The "Docs Browser" section documents:
> `GET /api/repos/:repoId/docs` lists markdown files; `GET /api/repos/:repoId/docs/:filePath` returns file content.

The actual routes in `server/docs-routes.ts` are:
- `GET /api/docs` (with `?repo=` query param)
- `GET /api/docs/file` (with `?repo=` and `?file=` query params)

These match `docs/API-REFERENCE.md` correctly. `FEATURES.md` is wrong.

### 4. `docs/SETUP.md` — Contradictory Node.js version requirement

Line 31 reads: `Node.js v18+ (codekin requires v24 for its own process)` — the same sentence states two different requirements. The prerequisite should specify one version clearly.

### 5. `docs/SETUP.md` — References non-existent `scripts/` directory

Section 5 instructs:
```bash
node scripts/scan-repos.mjs
```
No `scripts/` directory exists in the repository. No `scan-repos.mjs` was found anywhere in the codebase. The described workflow (scanning to generate `public/data/repos.json`) reflects an earlier architecture that has been superseded by the server's live repo discovery.

### 6. `docs/SETUP.md` — Duplicate env var setup across sections

`GITHUB_WEBHOOK_SECRET` is listed in the env file at Step 2 (the base setup), then added again in Step 10 (webhook setup). Step 2's env file should only contain universally required variables or clearly note that webhook-specific vars are added in Step 10.

### 7. `docs/INSTALL-DISTRIBUTION.md` — False reference to `CLAUDE.md`

The final paragraph states: `"The existing deploy.sh + nginx setup (documented in CLAUDE.md) continues to work..."` — `CLAUDE.md` does not document `deploy.sh`, and the deploy script is not in the repository (it was removed in commit `14061b2` and exists only as a local file on the host machine). This misleads contributors who would look in `CLAUDE.md` for deploy instructions.

### 8. `docs/ORCHESTRATOR-SPEC.md` — "Draft v0.1" status is stale

The spec header reads `**Status**: Draft v0.1` despite Agent Joe being shipped in v0.5.0. The spec retains value as an architectural reference, but the status line is misleading. The "Open Questions" section (if present) may reference decisions already made in the implementation.

### 9. `CHANGELOG.md` — Missing v0.5.1 entry

The package is at version `0.5.1` (per `package.json`) but the changelog's most recent entry is `[0.5.0]`. The v0.5.1 release has no documented changes.

---

## Accuracy Issues

### 1. `docs/FEATURES.md` — Docs Browser API paths wrong

As noted above, `GET /api/repos/:repoId/docs` and `GET /api/repos/:repoId/docs/:filePath` do not exist. The correct routes are `GET /api/docs` and `GET /api/docs/file` with query parameters. Any consumer following `FEATURES.md` to build an integration would get 404 errors.

### 2. `docs/SETUP.md` — `repos.yml` and manual repo scanner not part of current architecture

Section 5 ("Configure Repositories") describes two options:
- **Option A**: Run `node scripts/scan-repos.mjs` to generate `public/data/repos.json`
- **Option B**: Create `~/.codekin/repos.yml`

Neither `scripts/scan-repos.mjs` nor a `repos.yml` reader are present in the current server codebase. The server uses live filesystem scanning and GitHub API calls (via `GH_ORG` env var) to discover repos. This entire section describes a superseded workflow.

### 3. `docs/SETUP.md` — `curl http://127.0.0.1:32352/health` returns wrong response

The troubleshooting section states: `Should return: {"status":"ok"}`. The actual `/api/health` endpoint returns a richer object with `claudeAvailable`, `claudeVersion`, etc. (per `API-REFERENCE.md`). The bare `/health` path may differ from `/api/health`.

### 4. `docs/INSTALL-DISTRIBUTION.md` — `AUTH_TOKEN_FILE` default path inconsistency

INSTALL-DISTRIBUTION.md documents the auth token at `~/.config/codekin/token`, while SETUP.md documents it at `~/.codekin/auth-token`. These are different paths for the same concept. The systemd service in SETUP.md uses `~/.codekin/auth-token`; the npm distribution model in INSTALL-DISTRIBUTION.md uses `~/.config/codekin/token`. If both setups are supported, this distinction should be explicit.

### 5. `docs/SETUP.md` — `settings.json` field `serverDir` undocumented behavior

The settings table documents `serverDir` as "Runtime directory for the server / `./server`". This field is not referenced in any server-side code visible in the repository. If it has been removed from `settings.json` handling, this row should be removed.

---

## Overlap & Redundancy

### 1. Install / Setup instructions split across three files

`README.md`, `docs/SETUP.md`, and `docs/INSTALL-DISTRIBUTION.md` all cover installation, but for different audiences and deployment models:

| File | Audience | Deployment model |
|---|---|---|
| `README.md` | End users | npm one-liner |
| `INSTALL-DISTRIBUTION.md` | Developers/contributors | npm package internals + release process |
| `SETUP.md` | Server admins | Bare-metal / manual / nginx |

This split is logical and intentional. However, there is genuine overlap: both `SETUP.md` and `INSTALL-DISTRIBUTION.md` contain a configuration reference table for env vars, with different sets of variables and different defaults documented. These should be reconciled into a single authoritative table, or each file should clearly state which variables it covers and link to the other.

### 2. Webhook setup duplicated between `SETUP.md` and `GITHUB-WEBHOOKS-SPEC.md`

`SETUP.md` Section 10 is a self-contained operational guide for setting up GitHub webhooks (14-step process, nginx config, troubleshooting table). `GITHUB-WEBHOOKS-SPEC.md` covers the same configuration in its "Configuration" section, plus adds the full architectural specification.

For operational users, `SETUP.md` is the right place. The spec's configuration section is now redundant with `SETUP.md` for the Phase 1 content. **Recommendation**: `GITHUB-WEBHOOKS-SPEC.md` should reference `SETUP.md` for operational setup steps and focus exclusively on architecture, design decisions, and the roadmap.

### 3. Architecture overview duplicated

An architecture diagram appears in:
- `docs/FEATURES.md` (Architecture Overview section)
- `docs/SETUP.md` (Architecture section at the top)
- `docs/INSTALL-DISTRIBUTION.md` (implicitly in the distribution model description)

These diagrams are not identical, which compounds the maintenance burden. A single canonical diagram in one place (likely `FEATURES.md` or a new `docs/ARCHITECTURE.md`) with references from others would reduce drift.

---

## Fragmentation

### 1. `docs/GITHUB-WEBHOOKS-SPEC.md` — Completed spec mixed with active roadmap

At 810 lines, this is the longest documentation file. Phase 1 is fully implemented and in production. Phases 2-4 remain roadmap. The implemented content (Phase 1 architecture, security model, session behavior) could be folded into `docs/FEATURES.md` as a "GitHub Webhooks" section, while the roadmap phases could be kept as a lighter `docs/GITHUB-WEBHOOKS-ROADMAP.md` or moved to GitHub Issues/Projects.

### 2. `docs/ORCHESTRATOR-SPEC.md` — Shipped feature documented only as a spec

Agent Joe is live in v0.5.0. Its user-facing behavior (personality, capabilities, child session management, UI location) should appear in `docs/FEATURES.md`. The spec-style content (system prompt requirements, memory store design, approval workflow internals) is still useful as an architecture reference for contributors but should be clearly labeled as such and have its status updated.

### 3. No single "what's new" entry point for v0.5.0 features

The major v0.5.0 features (Agent Joe, git worktrees, permission mode selector, dual-write approvals) appear in `CHANGELOG.md` and partially in `README.md`, but are absent from `FEATURES.md`. New users reading `FEATURES.md` get an incomplete picture of the product's current state.

---

## Action Items

### Delete

| File | Reason it's safe to delete |
|---|---|
| *(none)* | No file is fully obsolete — each retains some reference value. See Consolidate table for spec files that should be trimmed or archived. |

### Consolidate

| Source Files | Target File | What to keep / drop |
|---|---|---|
| `docs/GITHUB-WEBHOOKS-SPEC.md` (Phase 1 sections) → `docs/FEATURES.md` | `docs/FEATURES.md` | Keep: Phase 1 architecture summary, security model (HMAC), session behavior. Drop from spec: detailed operational setup (already in SETUP.md). Retain `GITHUB-WEBHOOKS-SPEC.md` for Phases 2-4 roadmap only; update status header. |
| `docs/ORCHESTRATOR-SPEC.md` (user-facing sections) → `docs/FEATURES.md` | `docs/FEATURES.md` | Keep in FEATURES: identity/personality, capabilities, UI location, session model. Keep in spec: system prompt design, memory store schema, approval internals. Update spec status from "Draft v0.1" to "Partially implemented". |
| Env var tables in `docs/SETUP.md` and `docs/INSTALL-DISTRIBUTION.md` | `docs/SETUP.md` (authoritative for server env vars) | SETUP.md becomes the canonical env var reference. INSTALL-DISTRIBUTION.md tables should reference SETUP.md or be limited to end-user vars only. |

### Update

| File | Sections needing update | What changed in code |
|---|---|---|
| `docs/WORKFLOWS.md` | "Built-in Workflows" table | Two new workflows added to `server/workflows/`: `commit-review.md` and `repo-health.weekly.md`. Table must be updated with their kind, schedule, and output directories. |
| `docs/FEATURES.md` | Add "Agent Joe Orchestrator" section; update "Multi-Session Management"; fix "Docs Browser" API paths | Agent Joe (child sessions, orchestrator UI, memory store) shipped in v0.5.0. Git worktrees, permission mode selector also missing. Docs Browser REST API paths are wrong (`/api/docs` not `/api/repos/:repoId/docs`). |
| `docs/SETUP.md` | Prerequisites (Node.js version), Section 5 (repo configuration), Troubleshooting (`/health` response) | Contradictory Node.js version statement; `scan-repos.mjs` and `repos.yml` no longer exist; `/health` response format may differ from documented. |
| `docs/INSTALL-DISTRIBUTION.md` | "Bare-Metal / Advanced Setup" final paragraph | Remove false claim that `deploy.sh` is documented in `CLAUDE.md`. It is not in the repo and not documented anywhere in the public codebase. |
| `CHANGELOG.md` | Add `[0.5.1]` entry | Package is at v0.5.1 with no changelog entry. Even a minimal "patch" entry with the relevant fixes should be added. |
| `docs/ORCHESTRATOR-SPEC.md` | Status header | Change `**Status**: Draft v0.1` to `**Status**: Phase 1 implemented (v0.5.0). Phases 2+ are roadmap.` |

---

## Recommendations

1. **Update `docs/FEATURES.md` immediately.** It is the primary feature reference and is missing the entire Agent Joe feature (v0.5.0's headline feature), git worktrees, and the permission mode selector. It also has a wrong API reference for the Docs Browser. This is the highest-impact accuracy gap. Add an "Agent Joe / Orchestrator" section and fix the Docs Browser API paths.

2. **Fix `docs/WORKFLOWS.md` built-in workflows table.** Two workflows (`commit-review` and `repo-health.weekly`) are completely undocumented. This will confuse users who see these workflows appear in the UI without documentation. This is a quick, low-effort fix.

3. **Purge the `scan-repos.mjs` references from `docs/SETUP.md`.** The `scripts/` directory doesn't exist; the workflow it describes is superseded. Replace Section 5 with a note that repos are discovered automatically via filesystem scanning and the `GH_ORG` env var. This prevents wasted effort by admins following a dead-end setup path.

4. **Add the v0.5.1 CHANGELOG entry.** The package version and changelog are out of sync. Even a brief entry describing what changed maintains the changelog's reliability as a version history.

5. **Update `docs/ORCHESTRATOR-SPEC.md` status.** Change the "Draft v0.1" status header to reflect that Phase 1 is shipped. Optionally add a pointer to the `FEATURES.md` section once that is written. This costs one line but prevents confusion for contributors reading the spec.

6. **Fix `INSTALL-DISTRIBUTION.md`'s false `deploy.sh`/`CLAUDE.md` cross-reference.** Replace with a note that a local deploy script may exist at `~/.codekin/scripts/deploy.sh` on the host but is not part of the repository.

7. **Reconcile env var tables across `SETUP.md` and `INSTALL-DISTRIBUTION.md`.** Both files have configuration reference tables with different variables and different defaults. Designate `SETUP.md` as the authoritative reference for server-side env vars and have `INSTALL-DISTRIBUTION.md` point to it for the full list.

8. **Resolve the Node.js version contradiction in `docs/SETUP.md`.** The single line `Node.js v18+ (codekin requires v24 for its own process)` states two incompatible requirements. Clarify the actual minimum version (checking `package.json` `engines` field if set, or the Node.js features used).

9. **Consider slimming `docs/GITHUB-WEBHOOKS-SPEC.md`.** At 810 lines, it is the longest doc and nearly half covers Phase 1 content now also described in `SETUP.md` and `FEATURES.md`. Extract the Phase 1 architectural summary into `FEATURES.md`, strip the operational setup (it lives in `SETUP.md`), and leave the spec focused on design rationale and the Phase 2-4 roadmap. This would reduce the spec to roughly half its current size with no information loss.

10. **Add a "What's New in v0.5.0" call-out to `docs/FEATURES.md` or `README.md`.** Users upgrading from v0.4.x have no fast path to discover the major new features. A brief "New in v0.5.0" section or banner in FEATURES.md (linking to the relevant sections) would address this discoverability gap without requiring a separate document.
```3 report files committed and pushed to `chore/repo-health-report-2026-03-30`.