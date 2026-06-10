# Documentation Audit: codekin

**Date**: 2026-06-10T01:20:04.271Z
**Repository**: /srv/repos/Multiplier-Labs/codekin
**Branch**: main
**Workflow Run**: e9119ced-a310-49ee-92de-7636f446418f
**Session**: b76cdf0e-92ab-4671-ac0c-48bbfbc2851f

---

---

## Summary

**Total documentation files:** 15 (6 root-level + 9 in `docs/`)
**Total documented lines:** ~5,120 lines across all files
**Files needing attention:** 5
**Health rating: Well-maintained** — documentation is comprehensive, internally consistent, and mostly accurate. All internal links resolve, environment variable references are broadly correct, and major feature areas have dedicated docs. Three specific issues reduce the rating below "excellent": two design-spec documents that predate two major version bumps, webhook env vars missing from the contributor setup table, and one potential broken anchor.

---

## Documentation Inventory

| Path | Lines | Last Modified | Purpose | Status |
|------|-------|---------------|---------|--------|
| `README.md` | 112 | 2026-06-03 | Main overview, install one-liner, feature list, config table | Current |
| `CLAUDE.md` | 58 | 2026-04-10 | Dev conventions, branching policy, audit output rules | Current |
| `CONTRIBUTING.md` | 116 | 2026-05-15 | Dev setup, env vars table, testing/lint commands, PR process | Stale (partial) |
| `CODE_OF_CONDUCT.md` | 31 | 2026-03-08 | Community conduct expectations | Current |
| `SECURITY.md` | 43 | 2026-03-08 | Supported versions, vulnerability reporting, deployment hardening | Current |
| `CHANGELOG.md` | 591 | 2026-05-15 | Version history from v0.6.1 through v0.6.5 | Stale (partial) |
| `docs/API-REFERENCE.md` | 765 | 2026-06-03 | Full REST + WebSocket endpoint reference with schemas | Current |
| `docs/FEATURES.md` | 420 | 2026-06-03 | Feature reference with implementation details | Current |
| `docs/SETUP.md` | 438 | 2026-06-03 | Self-hosted deployment guide (nginx, Authelia, SSL) | Current |
| `docs/INSTALL-DISTRIBUTION.md` | 186 | 2026-05-15 | npm distribution model, CLI commands, release process | Stale (minor) |
| `docs/WORKFLOWS.md` | 187 | 2026-06-03 | Workflow system reference, YAML frontmatter spec, built-in types | Current |
| `docs/OPERATIONS.md` | 310 | 2026-06-03 | Production operations: rate limiting, DB schema, heartbeats, resume | Current |
| `docs/GITHUB-WEBHOOKS-SPEC.md` | 947 | 2026-04-25 | Webhook integration spec — Phase 1 live, Phases 2–4 roadmap | Stale |
| `docs/ORCHESTRATOR-SPEC.md` | 748 | 2026-04-25 | Agent Joe architecture spec — all 4 phases shipped (as of v0.5.2) | Outdated |
| `docs/stream-json-protocol.md` | 566 | 2026-04-08 | Internal Claude Code stream-JSON protocol reference | Stale |

---

## Staleness Findings

### 1. `docs/ORCHESTRATOR-SPEC.md` — All phases shipped; document not updated since v0.5.2

- Last modified **2026-04-25**; the spec's own implementation table marks all four phases complete "as of v0.5.2".
- The current codebase is **v0.6.5** — two minor versions and multiple patch releases later. New capabilities introduced in v0.5.3–v0.6.5 (visible in CHANGELOG.md) are not reflected in the spec.
- The document retains proposal/design-spec language ("this design document", "implementation phases") that is now fully historical. It describes architecture decisions as future choices that have already been resolved.
- **Risk:** A developer reading this spec cannot tell which sections still describe the live system vs. which sections were superseded by later v0.6.x refinements.

### 2. `docs/GITHUB-WEBHOOKS-SPEC.md` — Roadmap phases mix with shipped phase; document not updated since v0.5.x

- Last modified **2026-04-25**. Phase 1 (CI failure auto-fix + PR review) is documented as "in production". Phases 2–4 are described as roadmap.
- CHANGELOG entries from v0.5.3 through v0.6.5 include additional webhook-related changes (e.g., allowlist, rate limiting, actor filtering) that are not reflected in this document.
- The document also documents webhook env vars (`GITHUB_WEBHOOK_SECRET`, `GITHUB_WEBHOOK_ENABLED`, `GITHUB_WEBHOOK_MAX_SESSIONS`, `GITHUB_WEBHOOK_LOG_LINES`, `GITHUB_WEBHOOK_ACTOR_ALLOWLIST`) but these are **not present in `CONTRIBUTING.md`'s env vars table** — a gap for developers setting up webhooks for the first time.
- **Risk:** Developers cannot distinguish Phase 1 (live) from Phases 2–4 (roadmap) without careful reading; post-v0.5.2 webhook enhancements are invisible.

### 3. `docs/stream-json-protocol.md` — Internal protocol doc, oldest in docs/, not referenced from user docs

- Last modified **2026-04-08** — the oldest file in the `docs/` directory.
- Documents the internal stream-JSON wire protocol between Codekin and the Claude Code CLI subprocess. This is valuable for contributors but is **not referenced from any user-facing document** (not linked from README, FEATURES, API-REFERENCE, SETUP, or INSTALL-DISTRIBUTION).
- The content (spawn flags, permission modes, stdout event types) matches current implementation, but there is no indication to users or contributors that this file exists.
- **Risk:** Contributors working on the protocol layer cannot discover this reference from normal navigation.

### 4. `CONTRIBUTING.md` — Missing webhook environment variables

- The env vars table covers 13 core variables accurately, but omits the webhook-specific env var family:
  - `GITHUB_WEBHOOK_SECRET`
  - `GITHUB_WEBHOOK_ENABLED`
  - `GITHUB_WEBHOOK_MAX_SESSIONS`
  - `GITHUB_WEBHOOK_LOG_LINES`
  - `GITHUB_WEBHOOK_ACTOR_ALLOWLIST`
- These are handled by `server/webhook-config.ts` (loaded from `~/.codekin/webhook-config.json` or env), a separate config path not mentioned in the contributor setup guide.
- **Risk:** Developers following CONTRIBUTING.md to set up a local webhook integration will not find the necessary env vars there.

### 5. `CHANGELOG.md` — Last entry is v0.6.5; no unreleased section reflects current HEAD

- CHANGELOG.md was last modified **2026-05-15**. Today is **2026-06-10**. The current commit log includes several fixes and features merged since then (e.g., SQL injection fix #490, WebSocket canonicalization #488, coverage improvements #487, docs fixes #489). None of these appear in the changelog's Unreleased section.
- **Risk:** The CHANGELOG does not reflect the last ~25 days of work on `main`.

---

## Accuracy Issues

### 1. `INSTALL-DISTRIBUTION.md` line 147 — Potential broken anchor

- References `[webhook setup section in SETUP.md](./SETUP.md#10-configure-github-webhooks-optional)`.
- The `docs/SETUP.md` file exists, but the heading anchor `#10-configure-github-webhooks-optional` cannot be verified without confirming the exact heading text matches. SETUP.md section headings use numbered prefixes; if that section was renumbered or renamed during any of the three SETUP.md updates since INSTALL-DISTRIBUTION.md was last modified, this anchor is silently broken.
- **Severity:** Minor — the parent link to `SETUP.md` still resolves; only the jump-to-section would fail.

### 2. `docs/CONTRIBUTING.md` — Webhook config mechanism not explained

- The contributor guide documents main config env vars but does not explain that webhook configuration uses a **separate config file path** (`~/.conekin/webhook-config.json`) or that the webhook env vars override that file. This is an undocumented dual-config pattern.
- A contributor following the setup guide end-to-end would not know how to configure webhook functionality.

### 3. `docs/ORCHESTRATOR-SPEC.md` — Implementation phase table frozen at v0.5.2

- The document's implementation table marks all phases complete but does not reflect any post-v0.5.2 refinements (renamed agent persona, memory changes, concurrency behavior updates visible in v0.6.x CHANGELOGs).
- Specific claim: "CODEKIN_AGENT_NAME defaults to 'Joe'" is accurate per config.ts, but the spec's personality/identity section describes implementation choices as if still proposed.

---

## Overlap & Redundancy

### Group A: Installation documentation (README.md ↔ INSTALL-DISTRIBUTION.md)

| File | Coverage |
|------|----------|
| `README.md` (lines 14–46) | Install one-liner, prerequisites, `codekin` CLI commands, links to docs/SETUP.md |
| `docs/INSTALL-DISTRIBUTION.md` | Full npm distribution model, same CLI commands, config reference, service setup, release process |

**Overlap:** CLI commands (`codekin token`, `codekin start`, `codekin service install`, etc.) are listed in both files. The configuration table in INSTALL-DISTRIBUTION.md partially duplicates CONTRIBUTING.md's env vars table, and both reference `docs/SETUP.md` for self-hosted setup.

**More complete version:** `docs/INSTALL-DISTRIBUTION.md` is the authoritative reference for the distribution model and CLI. README.md is appropriately concise for a project landing page.

**Recommendation:** README.md should link to INSTALL-DISTRIBUTION.md for CLI command details rather than repeating the command list. The configuration table in INSTALL-DISTRIBUTION.md and the env vars table in CONTRIBUTING.md should share a single source or explicitly scope themselves (user config vs. developer env).

### Group B: Feature descriptions (FEATURES.md ↔ API-REFERENCE.md)

| File | Coverage |
|------|----------|
| `docs/FEATURES.md` | User-oriented feature descriptions with implementation notes |
| `docs/API-REFERENCE.md` | API endpoint schemas that implement each feature |

**Overlap:** Moderate — each feature in FEATURES.md has a corresponding API section, but the perspectives differ (what it does vs. how to call it). This split is intentional and appropriate; the overlap is not redundant but complementary.

**Recommendation:** No merge needed. Ensure cross-links remain current.

### Group C: Architecture descriptions (ORCHESTRATOR-SPEC.md ↔ FEATURES.md)

| File | Coverage |
|------|----------|
| `docs/ORCHESTRATOR-SPEC.md` (748 lines) | Full design spec — architecture, personality, capabilities, phases |
| `docs/FEATURES.md` (lines ~310–360) | User-facing orchestrator feature description |

**Overlap:** The architecture overview, session model, and capability list appear in both, with ORCHESTRATOR-SPEC.md being far more detailed. Since all phases are shipped, the spec's historical "proposal" framing is redundant with the shipped feature in FEATURES.md.

**Recommendation:** Condense ORCHESTRATOR-SPEC.md into an architecture decision record (ADR) or fold the stable architecture content into FEATURES.md. The current 748-line spec is disproportionate to its post-ship reference value.

---

## Fragmentation

### 1. Webhook documentation split across three documents

Information about the GitHub webhook integration is currently split between:
- `docs/GITHUB-WEBHOOKS-SPEC.md` (947 lines) — architecture, API design, configuration, phases
- `docs/API-REFERENCE.md` — webhook endpoint schemas
- `docs/SETUP.md` — webhook setup in the self-hosted guide

A developer setting up webhooks needs to read all three. The spec is the most complete but is written as a design proposal rather than an operator runbook. Consolidating the Phase 1 operational content into SETUP.md and API-REFERENCE.md (where it largely already exists) and reducing GITHUB-WEBHOOKS-SPEC.md to a roadmap-only document would reduce fragmentation.

### 2. `docs/stream-json-protocol.md` — orphaned internal spec

This 566-line protocol reference has no incoming links from any other documentation file. It covers the internal subprocess communication protocol — valuable to contributors modifying the Claude/OpenCode process integration layer. Its existence is not discoverable from any user or developer entry point. It should be linked from CONTRIBUTING.md or CLAUDE.md under a "Protocol internals" or "Architecture" reference section.

### 3. Completed spec documents retained as standalone files

Both `docs/ORCHESTRATOR-SPEC.md` and the Phase 1 section of `docs/GITHUB-WEBHOOKS-SPEC.md` describe work that is fully shipped. Keeping them as standalone "spec" documents alongside live reference docs (`FEATURES.md`, `API-REFERENCE.md`) creates ambiguity about which documents are authoritative for the current system. Best practice is to either:
- Archive them in a `docs/archive/` subdirectory, or
- Fold the stable content into FEATURES.md/API-REFERENCE.md and replace the spec file with a short ADR (Architecture Decision Record) summarizing the key design choices.

---

## Action Items

### Delete

| File | Reason it's safe to delete |
|------|---------------------------|
| *(none unconditionally)* | No file is safe to delete without replacement. ORCHESTRATOR-SPEC.md should be archived or condensed, not deleted outright, as it contains implementation rationale not present elsewhere. |

### Consolidate

| Source files | Target file | What to keep / drop |
|-------------|-------------|---------------------|
| `docs/ORCHESTRATOR-SPEC.md` (748 lines) → condense | `docs/ORCHESTRATOR-SPEC.md` (shortened) or `docs/archive/ORCHESTRATOR-SPEC.md` | **Keep:** Architecture decisions, session model rationale, capability table. **Drop:** Proposal framing, phase-gate language, implementation checklist (all shipped). Add a header note: "All phases shipped as of v0.5.2; see FEATURES.md for current user reference." |
| `docs/GITHUB-WEBHOOKS-SPEC.md` Phase 1 content → merge | `docs/SETUP.md` webhook section + `docs/API-REFERENCE.md` | **Keep in spec:** Phases 2–4 roadmap, design rationale. **Move to SETUP.md:** Operational env vars, webhook-config.json structure. **Move to API-REFERENCE.md:** Any endpoint schemas not already there. Reduce spec to ~200-line roadmap + design notes doc. |
| `CONTRIBUTING.md` env vars + `docs/INSTALL-DISTRIBUTION.md` config table | `CONTRIBUTING.md` (expanded) | **Keep in CONTRIBUTING.md:** All core + webhook env vars. **Drop from INSTALL-DISTRIBUTION.md:** Duplicate env var listing; replace with a link to CONTRIBUTING.md. |

### Update

| File | Sections needing update | What changed in code |
|------|------------------------|---------------------|
| `CONTRIBUTING.md` | Environment variables table | Webhook env vars (`GITHUB_WEBHOOK_SECRET`, `GITHUB_WEBHOOK_ENABLED`, `GITHUB_WEBHOOK_MAX_SESSIONS`, `GITHUB_WEBHOOK_LOG_LINES`, `GITHUB_WEBHOOK_ACTOR_ALLOWLIST`) not listed; webhook-config.json dual-config pattern not explained |
| `CHANGELOG.md` | Unreleased section | Commits since 2026-05-15 not reflected: SQL injection fix (#490), WebSocket canonicalization fix (#488), coverage improvements (#487), docs fixes (#489), revert (#486) |
| `docs/GITHUB-WEBHOOKS-SPEC.md` | Phase 1 status section, configuration section | Post-v0.5.2 webhook enhancements (actor allowlist, rate limiting changes, additional env vars) not reflected; document not updated alongside v0.6.x releases |
| `docs/ORCHESTRATOR-SPEC.md` | Implementation phases table, identity section | Frozen at v0.5.2; does not reflect v0.6.x refinements; proposal language should be replaced with past-tense shipped descriptions |
| `docs/stream-json-protocol.md` | Document header / discoverability | Not linked from CONTRIBUTING.md or CLAUDE.md; no indication it exists in developer entry points |
| `docs/INSTALL-DISTRIBUTION.md` | Line 147 anchor link | Anchor `#10-configure-github-webhooks-optional` in SETUP.md may be stale if that section was renumbered |

---

## Recommendations

1. **Update CHANGELOG.md for recent commits (HIGH)** — The five PRs merged since 2026-05-15 are not logged. Run a git log summary against the unreleased section and add entries. This is the most visible gap for operators tracking changes.

2. **Add webhook env vars to CONTRIBUTING.md (HIGH)** — Developers following the contributor setup guide cannot discover the webhook configuration path. Add a "Webhook Configuration" subsection to the env vars table covering `GITHUB_WEBHOOK_*` variables and explain the `~/.codekin/webhook-config.json` override mechanism.

3. **Add a discoverability link for `stream-json-protocol.md` (MEDIUM)** — Add a "Protocol Internals" link in CONTRIBUTING.md or CLAUDE.md pointing to `docs/stream-json-protocol.md`. This 566-line reference is invisible to contributors who need it when working on the Claude/OpenCode process layer.

4. **Condense `docs/ORCHESTRATOR-SPEC.md` and mark as historical (MEDIUM)** — Add a banner at the top: "All phases shipped as of v0.5.2. This document is a historical design record. See FEATURES.md for current reference." Optionally move to `docs/archive/`. At 748 lines for a fully-shipped feature, it creates navigational confusion alongside the live reference docs.

5. **Reduce `docs/GITHUB-WEBHOOKS-SPEC.md` and extract operational content (MEDIUM)** — The Phase 1 operational content (env vars, configuration, API endpoints) belongs in SETUP.md and API-REFERENCE.md, not only in a design spec. Move those sections, then reduce the spec to a forward-looking roadmap document (Phases 2–4 only) of roughly 200–300 lines.

6. **Verify and fix the broken anchor in `INSTALL-DISTRIBUTION.md` line 147 (LOW)** — Confirm that `docs/SETUP.md` still has a heading that resolves to `#10-configure-github-webhooks-optional`. If the heading was renumbered or renamed, update the anchor or replace with a plain link to the file.

7. **Eliminate duplicate CLI command list between README.md and INSTALL-DISTRIBUTION.md (LOW)** — README.md repeats the CLI command table that INSTALL-DISTRIBUTION.md already covers in more detail. Replace the README.md command list with a short summary and a link to INSTALL-DISTRIBUTION.md to keep the landing page lean and avoid future drift.

8. **Reconcile the CONTRIBUTING.md and INSTALL-DISTRIBUTION.md config tables (LOW)** — Both files list environment variables. CONTRIBUTING.md covers developer setup; INSTALL-DISTRIBUTION.md covers user/operator deployment. Scope each table to its audience, cross-link the other, and ensure neither becomes stale relative to `server/config.ts`.

9. **Establish a policy for design-spec documents (LOW)** — Define a lifecycle for spec documents: once a feature ships, the spec should be either archived (moved to `docs/archive/`) or converted to an ADR with a brief summary. This prevents the accumulation of "proposal" documents alongside live reference docs, which creates navigational ambiguity.

10. **Link `docs/OPERATIONS.md` from README.md (LOW)** — The operations reference covers production rate limiting, database inspection, and heartbeat/resume semantics — information operators need. README.md does not link to it. Adding a "For operators" link in the README's docs section would improve discoverability for self-hosters.