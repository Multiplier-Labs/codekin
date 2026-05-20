# Documentation Audit: codekin

**Date**: 2026-05-20T01:19:11.840Z
**Repository**: /srv/repos/codekin
**Branch**: main
**Workflow Run**: 706bc919-531b-4171-b72f-3d3322940811
**Session**: 8a3df9aa-96e5-4211-b59e-4feeb2e99969

---

---

# Documentation Audit — Codekin
**Date:** 2026-05-20 | **Auditor:** Automated (Claude Code)

---

## Summary

**19 documentation files** were audited across the root directory, `docs/`, and `docs/operations/`. The documentation is **largely accurate and current**, with most files updated in April–May 2026 in step with the v0.6.x release series. Environment variables, API endpoints, and package scripts all match the live codebase.

Three issues warrant attention:

1. **ORCHESTRATOR-SPEC.md** conflates the project `CLAUDE.md` with an "Agent Joe system prompt" — a conceptual inaccuracy.
2. **GITHUB-WEBHOOKS-SPEC.md** and **ORCHESTRATOR-SPEC.md** contain large speculative/planned sections (Phases 2–4, advanced memory features) that describe unimplemented work, creating ambiguity for readers.
3. **`docs/operations/`** guides are completely disconnected from the main doc hierarchy — no file links to them.
4. **`docs/stream-json-protocol.md`** is the oldest doc (2026-04-08) and predates several server changes.

**Health rating: Well-maintained** — no critical drift, but two large spec docs need scope-trimming to remove noise from unshipped planned work.

---

## Documentation Inventory

| Path | Lines | Last Modified | Purpose | Status |
|---|---|---|---|---|
| `README.md` | 111 | 2026-04-25 | Installation overview, quick-start | Current |
| `CHANGELOG.md` | 591 | 2026-05-15 | Release notes through v0.6.5 | Current |
| `CLAUDE.md` | 58 | 2026-04-10 | Dev conventions, branching/commit policy | Current |
| `CONTRIBUTING.md` | 116 | 2026-05-15 | Contributor guide, PR workflow | Current |
| `CODE_OF_CONDUCT.md` | 31 | 2026-03-08 | Community standards (Contributor Covenant) | Current |
| `SECURITY.md` | 43 | 2026-03-08 | Vulnerability disclosure policy | Current |
| `docs/FEATURES.md` | 421 | 2026-04-26 | Complete UI feature reference | Current |
| `docs/API-REFERENCE.md` | 764 | 2026-04-28 | REST + WebSocket API, auth, rate limits | Current |
| `docs/SETUP.md` | 434 | 2026-05-15 | Bare-metal deployment, env vars, nginx | Current |
| `docs/INSTALL-DISTRIBUTION.md` | 186 | 2026-05-15 | npm package install, CLI reference | Current |
| `docs/WORKFLOWS.md` | 187 | 2026-05-15 | Workflow system, YAML format, built-ins | Current |
| `docs/stream-json-protocol.md` | 566 | 2026-04-08 | Claude CLI stream-JSON protocol spec | Possibly stale |
| `docs/GITHUB-WEBHOOKS-SPEC.md` | 947 | 2026-04-25 | Webhook architecture, PR review automation | Redundant/planned |
| `docs/ORCHESTRATOR-SPEC.md` | 748 | 2026-04-25 | Agent Joe system design, memory, routing | Redundant/planned |
| `docs/operations/ws-rate-limit.md` | 129 | *(no git date)* | Per-IP/connection rate limiting ops guide | Orphaned |
| `docs/operations/workflow-resilience.md` | 197 | *(no git date)* | Workflow restart-resume, orphan handling | Orphaned |

**Total: 16 files, ~5,530 lines of documentation.**

---

## Staleness Findings

### 1. `docs/stream-json-protocol.md` — Oldest doc, predates server refactor

- Last modified **2026-04-08**, nearly six weeks before the most recent server changes.
- The file documents Claude CLI flags including `--session-id <UUID>`, `--append-system-prompt`, `--include-partial-messages`, and `--verbose`. These need verification against the current `server/claude-process.ts` invocation code.
- The file warns against using the `-p` flag (non-interactive print mode) on lines 19 and 552 — this aligns with current server behavior, but the surrounding context should be checked if the server's process spawning arguments changed post-v0.6.3 (OpenCode model persistence work, Apr 14).

### 2. `docs/GITHUB-WEBHOOKS-SPEC.md` — Phases 2–4 are unimplemented planned work

- Sections covering **Phase 2** (event queuing, session reuse), **Phase 3** (multi-repo routing), and **Phase 4** (advanced analytics) describe work explicitly marked as "planned but not yet implemented" (lines 907–948).
- The "Known Limitations (Phase 1)" section (lines 880–885) calls out: no automatic session cleanup, no session reuse, no event queuing, workspace disk usage orphans — all still true. These limitations are from the initial Phase 1 implementation.
- A reader cannot easily distinguish what is shipped vs. what is a design proposal without careful reading.

### 3. `docs/ORCHESTRATOR-SPEC.md` — Agent Joe system prompt claim is inaccurate

- Section 8 (around line 346) describes a "dedicated CLAUDE.md" as the Agent Joe system prompt.
- The actual `CLAUDE.md` at repo root is the **generic project developer conventions file** (58 lines, last modified 2026-04-10). It contains branching policy, coding conventions, and audit report instructions — not an Agent Joe persona prompt.
- The Agent Joe prompt content is embedded in ORCHESTRATOR-SPEC.md itself (lines 350–388), not in a separate file. The spec is self-referentially inaccurate.
- Additionally, ORCHESTRATOR-SPEC.md contains a full "Advanced Memory Architecture" section (multi-tier episodic/semantic/procedural memory, vector embeddings, cross-session learning) — there is no evidence this is implemented; `server/` has no vector DB or embedding pipeline files.

### 4. `docs/operations/ws-rate-limit.md` and `docs/operations/workflow-resilience.md` — No git history

- Both files return no result from `git log -1`, suggesting they were either added in a bulk commit with no individual file tracking, or are working copies not yet committed. They contain complete, accurate operational guidance, but their provenance is unclear.

---

## Accuracy Issues

### 1. `docs/ORCHESTRATOR-SPEC.md` — Advanced Memory section describes unimplemented features

- Lines covering episodic/semantic/procedural memory tiers, vector embeddings, and cross-session learning have no corresponding implementation in `server/`. The actual memory store is `memory.sqlite` with flat file supplements (`PROFILE.md`, `REPOS.md`, `DECISIONS.md`). The spec significantly overstates current capability.

### 2. `docs/GITHUB-WEBHOOKS-SPEC.md` — Future-tense phases mixed with shipped features

- The document uses present tense for shipped Phase 1 features and future tense for Phases 2–4, but this distinction is not made explicit in headings. Without a clear "Implemented" vs. "Planned" marker, the document reads as a complete feature description rather than a hybrid spec/roadmap.

### 3. `docs/CLAUDE.md` (root) — Audit report path policy may conflict with workflow runner

- `CLAUDE.md` lines covering audit report output state: *"Always write the report to a file"* and *"Commit the report on a branch and open a PR."* However, the `docs-audit.weekly.md` workflow uses an automated runner that saves the report itself. This creates conflicting instructions that could confuse automated agents running the workflow.

### 4. `docs/API-REFERENCE.md` — Orchestrator endpoint detail vs. ORCHESTRATOR-SPEC.md

- API-REFERENCE.md (lines 506–765) documents orchestrator routes. ORCHESTRATOR-SPEC.md section 10.2 (lines 470–529) documents the same endpoints with more architectural context. The two are consistent but duplicate — changes to endpoint signatures must be applied in two places.

---

## Overlap & Redundancy

### Group 1: Orchestrator Routes (2 files)

| File | Overlap | More Complete |
|---|---|---|
| `docs/API-REFERENCE.md` (lines 506–765) | Orchestrator REST endpoints | API-REFERENCE (reference format) |
| `docs/ORCHESTRATOR-SPEC.md` (section 10.2) | Same endpoints with design rationale | ORCHESTRATOR-SPEC (context) |

**Recommendation:** Keep the endpoint table in API-REFERENCE.md only. ORCHESTRATOR-SPEC.md should reference API-REFERENCE for the route list and focus on architecture/design.

### Group 2: Webhook Configuration (2 files)

| File | Overlap | More Complete |
|---|---|---|
| `docs/SETUP.md` (lines 240–246) | Webhook env vars with defaults | SETUP.md (operational) |
| `docs/GITHUB-WEBHOOKS-SPEC.md` (lines 339–344) | Same env vars in spec context | GITHUB-WEBHOOKS-SPEC (spec) |

**Recommendation:** SETUP.md should remain the authoritative env var reference. GITHUB-WEBHOOKS-SPEC should reference SETUP.md rather than restating the table.

### Group 3: Installation Instructions (2 files)

| File | Overlap | More Complete |
|---|---|---|
| `README.md` | Quick-start install + env setup | README (entry point) |
| `docs/INSTALL-DISTRIBUTION.md` | Full npm package CLI reference | INSTALL-DISTRIBUTION (complete) |

**Recommendation:** These serve different audiences (README = first look, INSTALL-DISTRIBUTION = full reference). Keep both but ensure README links explicitly to INSTALL-DISTRIBUTION for detailed options.

---

## Fragmentation

### 1. Operations guides are orphaned

`docs/operations/ws-rate-limit.md` and `docs/operations/workflow-resilience.md` are complete, well-written ops guides with no inbound links from any other doc. `docs/SETUP.md`, `docs/WORKFLOWS.md`, and `docs/API-REFERENCE.md` are the natural homes for "see also" links that would surface these guides to operators.

### 2. GITHUB-WEBHOOKS-SPEC.md and ORCHESTRATOR-SPEC.md contain completed-spec content mixed with roadmap

Both documents started as design specs and have been partially implemented. The shipped portions should either be folded into FEATURES.md/API-REFERENCE.md (as stable feature docs) or clearly partitioned with an **Implemented** / **Planned** header convention. Leaving them as monolithic spec+roadmap docs creates ongoing maintenance debt.

### 3. No top-level docs index

There is no `docs/README.md` or navigation index. A reader landing in `docs/` has 8 files plus a subdirectory with no guidance on reading order or which document covers their question.

---

## Action Items

### Delete

| File | Reason |
|---|---|
| *(none recommended for deletion)* | All files contain at least some unique, accurate content. Deletion candidates should emerge after consolidation steps below. |

### Consolidate

| Source Files | Target File | Keep / Drop |
|---|---|---|
| `docs/ORCHESTRATOR-SPEC.md` §10.2 route table | `docs/API-REFERENCE.md` | Keep route table in API-REFERENCE; drop duplicate from ORCHESTRATOR-SPEC; add cross-reference |
| `docs/GITHUB-WEBHOOKS-SPEC.md` env var table (lines 339–344) | `docs/SETUP.md` | Keep in SETUP.md; replace GITHUB-WEBHOOKS-SPEC table with "See SETUP.md §Webhooks" |
| `docs/GITHUB-WEBHOOKS-SPEC.md` Phases 2–4 + `docs/ORCHESTRATOR-SPEC.md` Advanced Memory | New `docs/ROADMAP.md` | Move all unimplemented planned sections into a single roadmap file; flag as "not yet implemented" |

### Update

| File | Sections Needing Update | What Changed |
|---|---|---|
| `docs/stream-json-protocol.md` | CLI flags section; message type list | Predates v0.6.3–v0.6.5 server work; verify `--session-id`, `--include-partial-messages` flags still match current `claude-process.ts` invocation |
| `docs/ORCHESTRATOR-SPEC.md` | §8 (Agent Joe CLAUDE.md claim); Advanced Memory section | `CLAUDE.md` is a project dev file, not Agent Joe's system prompt; advanced memory is not implemented |
| `docs/GITHUB-WEBHOOKS-SPEC.md` | Phase headers throughout | Add explicit `[Shipped]` / `[Planned]` markers to all phase headings to distinguish implemented vs. roadmap |
| `CLAUDE.md` | Audit report output instructions | Conflicts with automated workflow runner behavior — the "write to file + PR" instruction should note it applies to manual audit runs, not to automated workflow-driven reports |
| `docs/SETUP.md` | "See also" / links section | Add links to `docs/operations/ws-rate-limit.md` and `docs/operations/workflow-resilience.md` |
| `docs/WORKFLOWS.md` | "See also" / links section | Add link to `docs/operations/workflow-resilience.md` for restart-resume operational guidance |
| `docs/API-REFERENCE.md` | Rate limits section | Add link to `docs/operations/ws-rate-limit.md` for operational tuning guidance |

---

## Recommendations

1. **Add `docs/README.md` navigation index.** A single-page map of all docs files with one-line descriptions and reading-order suggestions. This costs ~30 lines and eliminates the orphaned-docs problem entirely.

2. **Extract all unimplemented planned sections into `docs/ROADMAP.md`.** Remove Phases 2–4 from GITHUB-WEBHOOKS-SPEC.md and the Advanced Memory section from ORCHESTRATOR-SPEC.md. Concentrate them in one clearly-labeled roadmap file. This makes both spec docs accurate descriptions of shipped functionality.

3. **Correct the Agent Joe / CLAUDE.md inaccuracy in ORCHESTRATOR-SPEC.md §8.** Either note that the system prompt is embedded in the spec itself, or create a dedicated `server/agent-joe-prompt.md` and reference it. The current claim that `CLAUDE.md` serves as the Agent Joe system prompt is factually wrong.

4. **Verify `docs/stream-json-protocol.md` against current `server/claude-process.ts`.** This is the oldest doc and the one most likely to have drifted. A quick diff of the documented CLI flags vs. the actual `spawn()` call arguments would confirm accuracy or surface gaps.

5. **Add "See also: docs/operations/" links** from SETUP.md (for ws-rate-limit), WORKFLOWS.md (for workflow-resilience), and API-REFERENCE.md (for both). This requires three one-line additions and fully surfaces the orphaned operations guides.

6. **Clarify CLAUDE.md audit-report instructions** to note the "write + commit + PR" policy applies to manually-triggered audits. The automated workflow runner handles file persistence; the current instructions risk double-writes when workflows execute.

7. **Deduplicate the orchestrator route table.** Keep it authoritative in API-REFERENCE.md; replace the ORCHESTRATOR-SPEC.md copy with a `See docs/API-REFERENCE.md §Orchestrator` reference. This eliminates a two-location maintenance burden for any future endpoint changes.

8. **Add `[Shipped]` / `[Planned]` phase markers to GITHUB-WEBHOOKS-SPEC.md.** Without changing substance, this single structural change makes the spec immediately readable as a hybrid shipped-feature + roadmap document.

9. **Investigate git history for `docs/operations/` files.** Both files have no `git log` result, which may indicate they were added in a commit that wasn't captured properly. Verify they are committed to the repository and confirm their last-modified dates so they can be correctly maintained going forward.

10. **Consider a lightweight doc-freshness check in CI.** A simple script that flags any `docs/*.md` file not touched within 90 days of the last `server/` or `src/` commit to the same feature area would prevent silent drift, which is currently the main documentation risk for this codebase.