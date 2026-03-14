# Documentation Audit: codekin

**Date**: 2026-03-14T09:31:53.668Z
**Repository**: /srv/repos/codekin
**Branch**: main
**Workflow Run**: fb024d02-f16d-4f33-ae08-3ae2e6562231
**Session**: 1608abf3-93d3-4e15-a630-f3ab89fa4227

---

Now let me do deeper analysis on the spec files and check for specific accuracy issues.## Documentation Audit — Codekin

## Summary

**Total documentation files:** 19 (excluding `docs/screenshot.png`)
**Total lines:** ~7,800
**Files needing attention:** 8

**Health rating: Needs cleanup**

Core documentation (README, CLAUDE.md, API-REFERENCE, WORKFLOWS, SETUP) is accurate and up-to-date. The primary issue is **spec sprawl**: the `docs/` directory contains five detailed design specifications for features that are now fully shipped. These specs are no longer useful as reference material and inflate the documentation surface area significantly. One document (`codex-integration-plan.md`) describes purely exploratory work that has never started and is the clearest deletion candidate. One minor accuracy gap exists in `CONTRIBUTING.md`.

---

## Documentation Inventory

| Path | Lines | Last Modified | Purpose | Status |
|------|------:|---------------|---------|--------|
| `README.md` | 109 | 2026-03-13 | Project overview, one-liner install, features list, config reference | Current |
| `CLAUDE.md` | 48 | 2026-03-08 | Dev conventions: stack, scripts, branching policy, output format rules | Current |
| `CHANGELOG.md` | 233 | 2026-03-14 | Semver changelog of all releases and notable changes | Current |
| `CONTRIBUTING.md` | 105 | 2026-03-08 | Dev setup, env vars, coding conventions, PR process | Stale (partial) |
| `SECURITY.md` | 43 | 2026-03-08 | Vulnerability disclosure policy and response timeline | Current |
| `CODE_OF_CONDUCT.md` | 31 | 2026-03-08 | Community standards and enforcement | Current |
| `.github/PULL_REQUEST_TEMPLATE.md` | 17 | 2026-03-08 | PR checklist template | Current |
| `docs/FEATURES.md` | 329 | 2026-03-08 | Feature reference: UI components, keyboard shortcuts, permissions | Stale |
| `docs/API-REFERENCE.md` | 398 | 2026-03-13 | REST API endpoints with request/response schemas | Current |
| `docs/SETUP.md` | 440 | 2026-03-10 | Production deployment: nginx, PM2, environment config | Current |
| `docs/WORKFLOWS.md` | 181 | 2026-03-09 | Workflow system: cron scheduling, MD format, built-in workflows | Current |
| `docs/stream-json-protocol.md` | 561 | 2026-03-13 | Claude CLI stream-JSON protocol specification | Current |
| `docs/INSTALL-DISTRIBUTION.md` | 184 | 2026-03-08 | npm distribution, `codekin` CLI commands, service management | Current |
| `docs/CLAUDE-HOOKS-SPEC.md` | 1723 | 2026-03-08 | All 8 Claude Code hook types with full implementation details | Current |
| `docs/DIFF-VIEWER-SPEC.md` | 364 | 2026-03-12 | Design spec for the diff viewer sidebar panel | Redundant |
| `docs/GITHUB-WEBHOOKS-SPEC.md` | 810 | 2026-03-08 | GitHub webhook integration spec (Phase 1–4) | Stale (partial) |
| `docs/DOCS-BROWSER-SPEC.md` | 491 | 2026-03-09 | Design spec for the docs/markdown browser feature | Redundant |
| `docs/APPROVALS-FIX-SPEC.md` | 655 | 2026-03-12 | Bug fix spec for tool approval race conditions (6 fixes) | Stale (partial) |
| `docs/codex-integration-plan.md` | 676 | 2026-03-09 | Exploratory plan for Codex CLI integration (not started) | Outdated |

---

## Staleness Findings

### `docs/FEATURES.md` — last modified 2026-03-08 (initial release)

The feature reference has not been updated since the initial release despite multiple significant features shipping afterward:

- **Approval countdown auto-approve** (merged 2026-03-14, PR #138) — not documented
- **Approval waiting/pending state in sidebar** (merged earlier, PR #135–#136 range) — not documented
- **Docs-audit workflow** registration in UI (commit `31a8635`) — not documented
- The diff viewer, docs browser, and approval panel are described only in their separate spec files; `FEATURES.md` does not fully integrate them into a coherent feature reference

### `docs/GITHUB-WEBHOOKS-SPEC.md` — Phase 1 shipped, Phases 2–4 not

The document describes a four-phase roadmap. Phase 1 (CI failure webhook → auto-fix session) is fully implemented in `server/webhook-*.ts`. Phases 2–4 cover configuration file support, UI webhook events panel, and expanded event types — none of which are implemented. The spec does not clearly distinguish "shipped" from "planned," making it ambiguous as a reference.

### `docs/APPROVALS-FIX-SPEC.md` — Fixes 1–4 shipped, 5–6 planned

The document describes 6 fixes. Fixes 1–4 (prompt queue, requestId cleanup, grace period, requestId filtering) are merged. Fixes 5–6 (surfacing hook denials in UI, pattern-first approval storage) are still on the roadmap. A reader cannot tell from the document alone which fixes are live.

### `docs/codex-integration-plan.md` — no implementation exists

The document is dated March 2025 in its content and describes itself as "Exploratory / Research Phase." No Codex adapter, agent abstraction layer, or JSON-RPC client exists anywhere in `src/` or `server/`. This document describes work that was never started.

---

## Accuracy Issues

### `CONTRIBUTING.md` — environment variables section is misleading

The "Environment Variables" table lists `ANTHROPIC_API_KEY` (marked "Required"), `GROQ_API_KEY`, `GEMINI_API_KEY`, and `OPENAI_API_KEY`. However:

- `ANTHROPIC_API_KEY` is **not required** to run the dev server. Claude Code CLI uses its own auth; this key is only needed for optional session auto-naming fallback.
- The core server environment variables — `PORT`, `REPOS_ROOT`, `DATA_DIR`, `AUTH_TOKEN`, `CORS_ORIGIN`, `GH_ORGS` — are **not documented** in `CONTRIBUTING.md` at all. They are defined in `server/config.ts` and are the variables a developer actually needs to understand for local setup.
- The section should distinguish between "variables consumed by the running server" and "optional third-party API keys for background LLM features."

### `docs/DIFF-VIEWER-SPEC.md`, `docs/DOCS-BROWSER-SPEC.md` — spec language for shipped features

Both files use future-tense design spec language ("The panel SHOULD...", "The component MUST...") for features that are fully implemented and production-ready. Reading them gives the impression these are planned rather than live. The implementation exists in `src/components/DiffPanel.tsx`, `src/components/diff/`, `src/components/DocsBrowser.tsx`, and `src/components/DocsFilePicker.tsx`.

### `docs/FEATURES.md` — does not reflect current feature set

As noted above, the diff viewer, docs browser, approval countdown, and several other shipped features are either missing or only partially described. The file was last updated at the initial release and has not been maintained as features shipped.

---

## Overlap & Redundancy

### `CLAUDE.md` ↔ `CONTRIBUTING.md` — coding conventions and branching policy

Both files document:
- TypeScript strict mode for server code
- TailwindCSS with custom theme in `src/index.css`
- Monospace font: Inconsolata; Sans font: Lato
- WebSocket message types in `src/types.ts`
- Branch naming (`feat/`, `fix/`), no direct pushes to `main`, PR-based workflow, semver release tags

`CLAUDE.md` is the authoritative AI-facing dev conventions file. `CONTRIBUTING.md` duplicates a subset for human contributors. The duplication is not harmful (different audiences), but the branching/convention sections in `CONTRIBUTING.md` should at minimum cross-reference `CLAUDE.md` rather than independently restating the same rules, to avoid drift.

**More complete version:** `CLAUDE.md` (tighter, authoritative)
**Recommendation:** Keep both; add a cross-reference from `CONTRIBUTING.md` to `CLAUDE.md` for the overlapping sections.

### `docs/DIFF-VIEWER-SPEC.md` + `docs/DOCS-BROWSER-SPEC.md` + `docs/APPROVALS-FIX-SPEC.md` ↔ `docs/FEATURES.md`

All three spec files document features that are now fully (or mostly) shipped. The information they contain — what the UI looks like, what keyboard shortcuts exist, what the data flow is — belongs in `docs/FEATURES.md` as a concise reference, not in three large spec documents that mix implementation rationale with user-visible behavior.

| Spec file | Lines | Shipped? | Covered in FEATURES.md? |
|-----------|------:|----------|------------------------|
| `DIFF-VIEWER-SPEC.md` | 364 | Yes (complete) | No |
| `DOCS-BROWSER-SPEC.md` | 491 | Yes (complete) | No |
| `APPROVALS-FIX-SPEC.md` | 655 | Partially (4/6 fixes) | No |

---

## Fragmentation

### Design specs that outlived their purpose

Three spec documents (`DIFF-VIEWER-SPEC.md`, `DOCS-BROWSER-SPEC.md`, `APPROVALS-FIX-SPEC.md`) served their purpose during implementation. The features are now shipped. The implementation decisions are captured in the code and git history. Retaining these as top-level docs:

- Misleads readers into thinking these are planned features
- Makes `docs/` harder to navigate (13 files, a third of which are superseded specs)
- Dilutes the signal-to-noise ratio for developers trying to understand the system

The user-visible behavioral information from these specs should be absorbed into `docs/FEATURES.md`. The implementation-detail rationale (data structures, race condition analysis) has no ongoing reference value and can be dropped.

### `docs/GITHUB-WEBHOOKS-SPEC.md` — shipped + planned mixed in one document

Phase 1 webhook integration is production code. Phases 2–4 are roadmap items. The spec should either be split into a reference doc (Phase 1 behavior) + a separate planning doc, or the Phase 1 content should be folded into `docs/FEATURES.md` and the future phases moved to GitHub Issues or a project board.

### `docs/CLAUDE-HOOKS-SPEC.md` — 1,723 lines, potentially standalone reference value

This is the largest file in the repo. It documents all 8 Claude Code hook types in detail. Unlike the other specs, this content has ongoing reference value as a developer reference (hooks are not visible from the UI or API surface alone). It does not overlap heavily with other docs. No action needed, but it may benefit from an overview table at the top linking to each hook section.

---

## Action Items

### Delete

| File | Reason it is safe to delete |
|------|------------------------------|
| `docs/codex-integration-plan.md` | Describes purely exploratory work that was never started. No code artifacts exist. The "plan" has not been referenced in any commit or PR since it was written. Deleting it removes a 676-line document that misleads readers about the project's direction. |
| `docs/DIFF-VIEWER-SPEC.md` | Feature is fully shipped (`DiffPanel.tsx`, `diff/` subcomponents all exist). The spec language is misleading for a live feature. User-visible behavior should be captured in `FEATURES.md`; implementation rationale is in git history. |
| `docs/DOCS-BROWSER-SPEC.md` | Feature is fully shipped (`DocsBrowser.tsx`, `DocsFilePicker.tsx` exist). Same rationale as `DIFF-VIEWER-SPEC.md`. |

### Consolidate

| Source files | Target file | What to keep / drop |
|-------------|-------------|----------------------|
| `docs/APPROVALS-FIX-SPEC.md` (fixes 1–4 sections) → `docs/FEATURES.md` | `docs/FEATURES.md` | Keep: user-visible approval panel behavior, keyboard shortcuts, auto-approve rules. Drop: race condition analysis, requestId implementation details, internal state diagrams. Once fixes 5–6 land, delete `APPROVALS-FIX-SPEC.md` entirely. |
| `docs/GITHUB-WEBHOOKS-SPEC.md` Phase 1 content → `docs/FEATURES.md` or `docs/SETUP.md` | `docs/SETUP.md` (Phase 1 config/setup) + `docs/FEATURES.md` (Phase 1 behavior) | Keep: webhook endpoint URL, HMAC setup, config fields, rate limits. Drop: Phase 2–4 roadmap sections (move to GitHub Issues). |
| `CONTRIBUTING.md` env vars section ← `server/config.ts` | `CONTRIBUTING.md` | Add the core server vars (PORT, REPOS_ROOT, AUTH_TOKEN, CORS_ORIGIN) as a separate table; clarify that LLM API keys are optional background feature keys, not dev setup requirements. |

### Update

| File | Sections needing update | What changed in code |
|------|------------------------|----------------------|
| `docs/FEATURES.md` | Entire "Approvals" section; missing "Diff Viewer" section; missing "Docs Browser" section | Diff viewer, docs browser, and multiple approval panel improvements shipped after initial release. Approval countdown auto-approve added in PR #138. |
| `docs/GITHUB-WEBHOOKS-SPEC.md` | Phases 2–4 sections | Should be clearly marked as "Planned / Not Yet Implemented" or moved out of the spec into GitHub Issues. Currently no visual distinction between shipped Phase 1 and unimplemented Phases 2–4. |
| `docs/APPROVALS-FIX-SPEC.md` | Fixes 5–6 sections | Should be clearly marked "In Progress / Not Merged" so readers know the current state. |
| `CONTRIBUTING.md` | "Environment Variables" table | Core server config vars (PORT, REPOS_ROOT, AUTH_TOKEN, etc.) are missing; `ANTHROPIC_API_KEY` is incorrectly marked as required. |
| `docs/WORKFLOWS.md` | Built-in workflows list | `docs-audit.weekly` workflow was added (commit `31a8635`) after this file was last updated (2026-03-09). |

---

## Recommendations

1. **Delete `docs/codex-integration-plan.md` immediately.** It is the clearest dead weight: 676 lines describing work that was never started and shows no signs of becoming active. It is the only file where deletion carries zero risk of losing reference-quality information.

2. **Delete `docs/DIFF-VIEWER-SPEC.md` and `docs/DOCS-BROWSER-SPEC.md` after updating `FEATURES.md`.** These specs have served their purpose. Before deleting, extract the user-visible feature summary (keyboard shortcuts, scope selector options, file picker behavior) into `FEATURES.md`. The implementation detail can be safely dropped.

3. **Update `docs/FEATURES.md` to be the canonical feature reference.** It is currently the most stale content-bearing file in the repo. A single update pass should add: diff viewer, docs browser, approval countdown, approval pattern rules, and the docs-audit workflow. This is the highest-leverage single edit.

4. **Add status labels to `docs/GITHUB-WEBHOOKS-SPEC.md` and `docs/APPROVALS-FIX-SPEC.md`.** Until these mixed shipped/planned documents are fully resolved, add a status callout at the top of each section (e.g., `> **Status: Shipped**` / `> **Status: Planned — not yet implemented**`) so readers can immediately distinguish live behavior from roadmap.

5. **Fix `CONTRIBUTING.md` environment variables section.** Split into two tables: (a) core server variables required for the backend to function (`PORT`, `AUTH_TOKEN`, `REPOS_ROOT`), and (b) optional LLM API keys for background features. Remove the "Required" label from `ANTHROPIC_API_KEY`.

6. **Add `docs-audit.weekly` to `docs/WORKFLOWS.md` built-in workflows list.** This is a small one-line addition that keeps the workflow reference accurate.

7. **Establish a lifecycle policy for spec files.** Before merging any spec-driven feature branch, require either: (a) deletion of the spec and absorption of its user-visible content into `FEATURES.md`, or (b) conversion of the spec to a reference document with spec language removed. This prevents future accumulation of shipped-but-spec-worded files.

8. **Consider retiring `docs/APPROVALS-FIX-SPEC.md` once fixes 5–6 land.** The file is currently half-useful (documents the approval system state), but its bug-fix framing makes it a poor permanent reference. When the fixes complete, fold the approval panel behavior into `FEATURES.md` and delete this file.

9. **Add a `docs/` README or index.** With 13 files in `docs/`, new contributors cannot easily determine which documents are reference material vs. completed design specs vs. operational runbooks. A short `docs/README.md` (10–15 lines with a table) would significantly improve navigability without adding maintenance burden.

10. **Archive or remove `ecosystem.config.cjs`.** This file contains hardcoded absolute paths (`/home/dev/repos/codekin`) and a legacy auth token path specific to one developer's machine. It is not useful to other contributors and could be misleading. If PM2 setup is documented in `SETUP.md`, the example config there is sufficient.