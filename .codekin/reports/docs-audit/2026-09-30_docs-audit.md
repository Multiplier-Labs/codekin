# Documentation Audit: codekin

**Date**: 2026-09-30T01:22:02.622Z
**Repository**: /srv/repos/Multiplier-Labs/codekin
**Branch**: fix/settings-standalone-view
**Workflow Run**: 9d3da26b-29d5-4b66-941f-a80d124c2aba
**Session**: 37fc2371-b0fb-48b0-8100-8b7a897c61dd

---

Now I have enough information to compile the report. Let me check a few more things about the design_handoff directory and its completeness status.Now I have enough to write the comprehensive docs audit report.

---

# Documentation Audit — 2026-09-30

**Repository:** Multiplier-Labs/codekin
**Branch assessed:** fix/settings-standalone-view
**Assessor:** Automated (Claude Sonnet 4.6)

---

## Summary

The repository contains **116 documentation files** across six locations (root, `docs/`, `design_handoff_codekin_styling/`, `server/loops/`, `server/workflows/`, and `.codekin/reports/`). The `.codekin/reports/` tree (90 files) is automated historical output and is excluded from the actionable count; the **26 actively maintained docs** are assessed here.

The documentation health is **Needs cleanup**. The core user-facing docs (README, GETTING-STARTED, API-REFERENCE, OPERATIONS) are well-maintained, but a cluster of issues has built up since the v0.8–v0.9 wave of features (Settings view, hosted workspaces, themes, Settings PR 3):

- **`docs/FEATURES.md` is significantly stale** — last updated 2026-06-03, predates hosted relay, workspaces, nine themes, device linking, passkeys, routed Settings view, Loops 2.0, and the Deployment monitoring system.
- **`docs/SETUP.md` has two accuracy issues** — it references a removed Settings modal and a `settings.json` deploy config that the server no longer reads.
- **`docs/OPERATIONS.md` has one stale claim** — "there is no UI yet" for user management, overridden by the shipped Platform → Accounts section.
- **`design_handoff_codekin_styling/`** is a completed internal task folder that has no ongoing reference value; `Settings.tsx` (referenced in task 08) was removed by the Settings view PRs.
- **Six spec docs** (`LOOPS-REWRITE-SPEC.md`, `SESSION-HANDOFF-SPEC.md`, `HOSTED-RELAY-CONTROL-PLANE-SPEC.md`, `HOSTED-RELAY-IMPLEMENTATION-PLAN.md`, `SETTINGS-VIEW-SPEC.md`, `THEME-SELECTOR-SPEC.md`) describe work that has shipped; they linger as historical record but add navigation cost.
- **`docs/screenshot.png`** has not been updated since 2026-04-12 and predates the nine-theme UI, routed Settings view, and hosted workspaces screens.

**Key finding count:** 3 accuracy bugs, 1 significant stale feature doc, 6 completed-spec files, 1 design-task folder to archive.

---

## Documentation Inventory

| Path | Lines | Last Modified | Purpose | Status |
|---|---|---|---|---|
| `README.md` | 139 | 2026-09-28 | Quick-start, feature list, CLI usage, links to deeper docs | current |
| `CHANGELOG.md` | 724 | 2026-09-28 | Release history | current |
| `CLAUDE.md` | 86 | 2026-09-27 | AI assistant conventions (coding style, deploy policy) | current |
| `CONTRIBUTING.md` | 117 | 2026-09-27 | Developer setup, env vars, PR guidelines | current |
| `CODE_OF_CONDUCT.md` | 31 | 2026-03-08 | Contributor code of conduct (boilerplate) | current |
| `SECURITY.md` | 46 | 2026-09-28 | Vulnerability disclosure policy + security guidance | current |
| `docs/README` (screenshot) | — | 2026-04-12 | UI screenshot used in README | stale |
| `docs/GETTING-STARTED.md` | 74 | 2026-09-28 | First-session walkthrough, hosted + local paths | current |
| `docs/FEATURES.md` | 420 | 2026-06-03 | Feature reference (all major capabilities) | stale |
| `docs/API-REFERENCE.md` | 934 | 2026-09-26 | REST API documentation with full endpoint listing | current |
| `docs/SETUP.md` | 420 | 2026-09-27 | Advanced self-hosted nginx + Authelia deployment guide | stale (2 issues) |
| `docs/INSTALL-DISTRIBUTION.md` | 214 | 2026-09-27 | npm packaging internals, installer mechanics, CLI reference | current |
| `docs/OPERATIONS.md` | 482 | 2026-09-27 | Ops guide: rate limits, workflow restart, hosted relay ops | stale (1 issue) |
| `docs/DEPLOYMENTS.md` | 87 | 2026-08-30 | Deployment monitoring probes, API, incident response | current |
| `docs/LOOPS.md` | 226 | 2026-08-30 | Loops user reference (shipped Loops 2.0 Phase 1) | current |
| `docs/WORKFLOWS.md` | 226 | 2026-08-30 | Automated workflows: format, trigger engine, durable signals | current |
| `docs/stream-json-protocol.md` | 566 | 2026-04-08 | Claude CLI stream-JSON protocol internals | current |
| `docs/GITHUB-WEBHOOKS-SPEC.md` | 953 | 2026-08-05 | Webhooks spec (Phase 1 shipped, Phases 2–4 roadmap) | current (partial spec) |
| `docs/ORCHESTRATOR-SPEC.md` | 769 | 2026-08-30 | Agent Joe specification (all phases shipped) | current (self-marked reference) |
| `docs/LOOPS-REWRITE-SPEC.md` | 662 | 2026-08-30 | Loops 2.0 design spec (all phases shipped) | redundant (shipped) |
| `docs/SESSION-HANDOFF-SPEC.md` | 204 | 2026-08-08 | Session handoff spec (Phase 1 shipped; Phase 2–3 pending) | current (partial spec) |
| `docs/HOSTED-RELAY-CONTROL-PLANE-SPEC.md` | 625 | 2026-08-08 | Relay architecture spec (shipped) | redundant (shipped) |
| `docs/HOSTED-RELAY-IMPLEMENTATION-PLAN.md` | 301 | 2026-08-30 | Relay implementation plan (shipped) | redundant (shipped) |
| `docs/HOSTED-WORKSPACES-AND-MFA-PLAN.md` | 208 | 2026-09-28 | Workspaces/MFA plan (Phases 0–3 deployed, Phase 4 open) | current (phase 4 open) |
| `docs/HOSTED-SECURITY-AUDIT-2026-09-28.md` | 120 | 2026-09-28 | Security audit with findings (all fixed in #655) | current (historical record) |
| `docs/DEVICE-LINK-AND-PASSKEY-SPEC.md` | 338 | 2026-09-28 | Device link + passkey spec (shipped) | redundant (shipped) |
| `docs/SETTINGS-VIEW-SPEC.md` | 88 | 2026-09-28 | Settings full-view spec (all 3 PRs shipped) | redundant (shipped) |
| `docs/THEME-SELECTOR-SPEC.md` | 282 | 2026-09-28 | Theme selector spec (shipped) | redundant (shipped, contains stale localStorage claim) |
| `design_handoff_codekin_styling/README.md` | 125 | 2026-08-05 | Design handoff index for 9-task styling refactor | redundant (tasks executed) |
| `design_handoff_codekin_styling/01-type-scale.md` | 60 | 2026-08-04 | Styling task: type scale | redundant |
| `design_handoff_codekin_styling/02-derive-scopes.md` | 95 | 2026-08-05 | Styling task: colour scopes (task deferred) | redundant |
| `design_handoff_codekin_styling/03-semantic-tokens.md` | 72 | 2026-08-04 | Styling task: semantic token audit | redundant |
| `design_handoff_codekin_styling/04-surfaces.md` | 58 | 2026-08-04 | Styling task: surfaces | redundant |
| `design_handoff_codekin_styling/05-transcript.md` | 70 | 2026-08-04 | Styling task: transcript | redundant |
| `design_handoff_codekin_styling/06-density.md` | 51 | 2026-08-04 | Styling task: density | redundant |
| `design_handoff_codekin_styling/07-composer.md` | 107 | 2026-08-05 | Styling task: composer | redundant |
| `design_handoff_codekin_styling/08-sidebar-and-drawer.md` | 107 | 2026-08-05 | Styling task: sidebar and drawer | redundant |
| `design_handoff_codekin_styling/09-chrome-palette.md` | 79 | 2026-08-05 | Styling task: chrome palette | redundant |
| `server/loops/ci-autorepair.md` | 45 | 2026-08-30 | Loop recipe: CI autorepair | current |
| `server/loops/coverage-increase.md` | 43 | 2026-08-30 | Loop recipe: coverage increase | current |
| `server/loops/dependency-upgrade.md` | 52 | 2026-08-30 | Loop recipe: dependency upgrade | current |
| `server/workflows/code-review.daily.md` | 22 | 2026-03-08 | Workflow definition: daily code review | current |
| `server/workflows/comment-assessment.daily.md` | 41 | 2026-03-08 | Workflow definition: daily comment assessment | current |
| `server/workflows/commit-review.md` | 22 | 2026-03-11 | Workflow definition: commit review | current |
| `server/workflows/complexity.weekly.md` | 54 | 2026-03-08 | Workflow definition: weekly complexity | current |
| `server/workflows/coverage.daily.md` | 41 | 2026-03-08 | Workflow definition: daily coverage | current |
| `server/workflows/dependency-health.daily.md` | 46 | 2026-03-08 | Workflow definition: daily dependency health | current |
| `server/workflows/docs-audit.weekly.md` | 97 | 2026-03-14 | Workflow definition: weekly docs audit | current |
| `server/workflows/pr-review.md` | 27 | 2026-04-10 | Workflow definition: PR review | current |
| `server/workflows/repo-health.weekly.md` | 111 | 2026-03-09 | Workflow definition: weekly repo health | current |
| `server/workflows/security-audit.weekly.md` | 66 | 2026-03-08 | Workflow definition: weekly security audit | current |

---

## Staleness Findings

### S1 — `docs/FEATURES.md` missing ~6 months of major features (HIGH)

Last modified **2026-06-03**. The following shipped features are entirely absent:

- **Hosted relay, workspaces, and teams** (v0.7–v0.9): remote access via app.codekin.ai, workspace creation, member invitations, roles, machine management, two-factor authentication (TOTP + passkeys), session sharing.
- **Device link and passkey authentication** (PR #573, 2026-08-29): QR code device linking, WebAuthn passkeys.
- **Nine colour themes** (PR #638/#640, 2026-09-27): Dark, Light, Midnight, Paper, High Contrast, Solarized Light, Dracula, Gruvbox, Matrix.
- **Routed Settings view** (PRs #651–#654, 2026-09-28): Settings is now a full `/settings/<section>` view, not a modal.
- **Deployment monitoring** (v0.7+): HTTP/pm2/disk/log/host probes, auto-diagnosis, weekly host digest.
- **Loops 2.0** (PR #620–#623, 2026-08-30): durable engine, evaluators, fork, lessons, CI monitoring.
- **Automations unified view** (v0.8): combined loops, Joe runs, and scheduled workflows with trigger ledger.

FEATURES.md also contains three references to "the Settings modal" (`docs/FEATURES.md:142`, `:329`, `:332`) which has been removed and replaced by the routed Settings view.

### S2 — `docs/THEME-SELECTOR-SPEC.md` claims localStorage for theme persistence

`docs/THEME-SELECTOR-SPEC.md:47` states "The theme stays in `localStorage`". The Settings view PRs (#670) moved preferences to server-side for hosted mode, but inspection of `src/hooks/useSettings.ts` confirms the theme remains in `localStorage` in both modes. This claim is **technically still accurate**; however the spec also says "No server-side persistence or cross-device sync" — which is now false for hosted mode where server-side preferences exist for other settings. The theme-specific claim is fine; the broader cross-device statement is slightly stale given the direction set by #670.

### S3 — `docs/stream-json-protocol.md` uses a historical model ID in examples

`docs/stream-json-protocol.md:84` and `:154` show `"model": "claude-opus-4-6"`. This model is still in the fallback list but is an older generation. The examples would be less confusing if updated to a current default model. This is minor (examples, not prescriptive) but could mislead developers expecting a modern default.

### S4 — `design_handoff_codekin_styling/08-sidebar-and-drawer.md` references removed file

`design_handoff_codekin_styling/08-sidebar-and-drawer.md:27` lists `src/components/Settings.tsx` as a target file. That file was deleted by the Settings view refactor (PR #651). The design handoff folder is no longer actionable as written.

---

## Accuracy Issues

### A1 — `docs/SETUP.md:211` references the removed Settings modal (HIGH)

> "The Settings modal opens automatically — paste your codekin token (from `~/.config/codekin/token`)"

The Settings modal was removed in PR #652. The first login experience is now a routed view at `/settings/connection`. This step-by-step instruction in the "First Login" section is wrong for any version ≥ 0.9.0.

### A2 — `docs/SETUP.md` "Deploy Settings" section describes a config file the server no longer reads (MEDIUM)

`docs/SETUP.md:142–162` instructs users to copy `.codekin/settings.example.json` and populate `webRoot`, `distDir`, `serverDir`, `port`, `authFile` fields. Grepping the server codebase (`server/*.ts`, `bin/*.mjs`) finds **no code that reads this file**. The server is configured exclusively through environment variables (`PORT`, `FRONTEND_DIST`, `AUTH_TOKEN_FILE`, etc.). The `settings.example.json` file exists on disk but has no effect. The `Key file paths` table at line 412 also perpetuates this with `"set via FRONTEND_DIST or settings.json"`.

The only accurate guidance in that section is the pointer to environment variables, which is separately documented correctly in the table at lines 62–82.

### A3 — `docs/OPERATIONS.md:362` says "there is no UI yet" for user-admin management (LOW)

> "an **owner or admin** uses the user-admin API (there is no UI yet)"

A full Platform → Accounts admin UI was shipped in PR #654 (`src/hosted/AccountPages.tsx`, `AccountsSection`), accessible at `/settings/accounts` for operators. The curl examples remain valid as a supplemental API path, but the parenthetical is incorrect.

### A4 — `docs/SETUP.md:391` shows an outdated directory structure (LOW)

The `server/` directory listing shows only `upload-routes.ts` and `ws-server.ts` but the server now has dozens of modules across `server/relay/`, `server/loops/`, `server/workflows/`, and many root-level files. The listing is illustrative rather than comprehensive, so this is low severity — but a reader expecting to find a file based on this listing will be confused.

---

## Overlap & Redundancy

### Group 1 — Setup / installation docs (3 files)

| File | Topic | Overlap | Recommendation |
|---|---|---|---|
| `docs/GETTING-STARTED.md` | First session, hosted + local quickstart | Low: well-separated from SETUP | Keep |
| `docs/SETUP.md` | Advanced nginx/Authelia/systemd bare-metal deploy | Medium: duplicates some env var table from CONTRIBUTING | Keep (niche audience); fix accuracy issues |
| `docs/INSTALL-DISTRIBUTION.md` | npm packaging, installer internals, CLI reference | Low | Keep |

These three serve genuinely different audiences (new users, advanced self-hosters, contributors/packagers). Cross-references between them are correct. No merger recommended; the accuracy fixes in SETUP.md are the priority.

### Group 2 — Spec docs for fully shipped features (5 files)

All five describe work that is complete and deployed. They survive in `docs/` primarily as historical design rationale and implementation notes:

| Files | Status |
|---|---|
| `docs/LOOPS-REWRITE-SPEC.md` | All phases shipped (PR #620–#623) |
| `docs/HOSTED-RELAY-CONTROL-PLANE-SPEC.md` | Shipped (app.codekin.ai live) |
| `docs/HOSTED-RELAY-IMPLEMENTATION-PLAN.md` | Shipped |
| `docs/DEVICE-LINK-AND-PASSKEY-SPEC.md` | Shipped (PR #573) |
| `docs/SETTINGS-VIEW-SPEC.md` | All 3 PRs shipped (#651–#654) |
| `docs/THEME-SELECTOR-SPEC.md` | Shipped (PR #638) |

These overlap with the user-facing docs (`FEATURES.md`, `API-REFERENCE.md`, `LOOPS.md`) in that both describe the same system. The specs go deeper on rationale and rejected alternatives. If the team wants to keep them as design rationale, move them to a `docs/specs/` or `docs/archive/` subdirectory to reduce noise in `docs/`.

### Group 3 — `docs/LOOPS.md` and `docs/LOOPS-REWRITE-SPEC.md`

`docs/LOOPS.md` is the living user reference and explicitly says the design rationale lives in `LOOPS-REWRITE-SPEC.md`. The spec has `Status: proposal` still in its header despite all phases shipping. `LOOPS.md` alone is sufficient for users; the rewrite spec is historical.

### Group 4 — `docs/HOSTED-WORKSPACES-AND-MFA-PLAN.md` and `docs/HOSTED-SECURITY-AUDIT-2026-09-28.md`

Both are current and serve different purposes (implementation plan vs. audit findings). `HOSTED-WORKSPACES-AND-MFA-PLAN.md` correctly marks Phases 0–3 deployed with Phase 4 open, making it the authoritative status tracker. The audit is a point-in-time findings document. No merger needed.

---

## Fragmentation

### F1 — `design_handoff_codekin_styling/` should be archived or removed

This 10-file directory is a one-shot design task packet for a styling refactor that has been executed. It no longer functions as actionable guidance — `Settings.tsx` (referenced in task 08) was deleted, tasks 01–09 have been applied, and task 02 was explicitly marked as deferred with no current work item. The directory serves no navigational purpose for new contributors; it is internal scaffolding from a past sprint. It should be moved to `docs/archive/` or deleted.

### F2 — `docs/LOOPS-REWRITE-SPEC.md` still marked `Status: proposal`

The spec header (`docs/LOOPS-REWRITE-SPEC.md:3`) says `**Status:** proposal`. All four phases shipped in PR #620–#623. The status line is wrong and will mislead readers about what is implemented. If the file is kept, the header must be updated to reflect completion; if it is archived, the staleness is moot.

### F3 — Server-level workflow and loop definitions not documented in WORKFLOWS.md / LOOPS.md

`server/loops/` and `server/workflows/` contain the shipped recipe and workflow Markdown files. `docs/WORKFLOWS.md` describes the format and trigger model thoroughly but does not link to or enumerate the built-in definitions. A contributor looking for the shipped recipes has to know to look in `server/loops/` separately. A single cross-reference line in each user doc would resolve this.

### F4 — Session handoff spec status

`docs/SESSION-HANDOFF-SPEC.md` is `Status: draft / ideation` and describes three phases. Per session memory, Phase 1 shipped (PR #548). The spec remains useful for phases 2 and 3 but should be updated to reflect that Phase 1 is complete.

---

## Action Items

### Delete

| File | Reason safe to delete |
|---|---|
| `design_handoff_codekin_styling/` (entire directory, 10 files) | One-shot design task packet, fully executed; `Settings.tsx` target was removed; task 02 deferred indefinitely with no open ticket; has no ongoing reference value |

### Consolidate

| Source files | Target | What to keep / drop |
|---|---|---|
| `docs/HOSTED-RELAY-CONTROL-PLANE-SPEC.md` + `docs/HOSTED-RELAY-IMPLEMENTATION-PLAN.md` | `docs/archive/` subdirectory (or delete) | Keep as historical record if desired; remove from `docs/` root to reduce noise; update OPERATIONS.md cross-references to point to archive or remove them |
| `docs/LOOPS-REWRITE-SPEC.md` | `docs/archive/LOOPS-REWRITE-SPEC.md` or delete | `docs/LOOPS.md` is the living reference; the rewrite spec's design rationale is historical; update the cross-reference in `LOOPS.md` |
| `docs/DEVICE-LINK-AND-PASSKEY-SPEC.md` | `docs/archive/` or delete | Feature shipped; `OPERATIONS.md` and `SECURITY.md` cover user-facing device link and passkey guidance |
| `docs/SETTINGS-VIEW-SPEC.md` | Archive or delete | All 3 PRs shipped; the delivered feature is self-documenting in the UI; CHANGELOG covers it |
| `docs/THEME-SELECTOR-SPEC.md` | Archive or delete | Feature shipped; nine themes documented in README and CONTRIBUTING; spec added no ongoing reference value beyond CLAUDE.md's styling rules |

### Update

| File | Sections needing update | What changed in code |
|---|---|---|
| `docs/FEATURES.md` | Add: Hosted relay/workspaces/MFA, Device link + passkeys, Nine themes, Routed Settings view, Loops 2.0, Deployment monitoring, Automations view. Remove/fix: three "Settings modal" references (`:142`, `:329`, `:332`) | All of v0.7–v0.9 (2026-08-08 to 2026-09-28) |
| `docs/SETUP.md` | §9 First Login (line 211): replace "Settings modal opens automatically" with "Settings → Connection opens automatically". §6 Deploy Settings (lines 142–162): remove or clearly mark `settings.json` config table as legacy/unused; note that the server is configured via env vars only | PR #652 (Settings view removed modal); `settings.json` keys unused in current server |
| `docs/OPERATIONS.md` | §Managing access (line 362): remove "(there is no UI yet)" — Platform → Accounts section exists at `/settings/accounts` | PR #654 shipped `AccountsSection` |
| `docs/LOOPS-REWRITE-SPEC.md` | Header: change `Status: proposal` to `Status: implemented (all phases shipped)` | PRs #620–#623 (2026-08-30) |
| `docs/SESSION-HANDOFF-SPEC.md` | Header: change `Status: draft / ideation` to `Status: Phase 1 shipped; Phases 2–3 pending`. Mark Phase 1 items as complete | PR #548 (2026-08-08) |
| `docs/stream-json-protocol.md` | Code examples at lines 84 and 154: update `"model": "claude-opus-4-6"` to a current default | Model list update (v0.8+) |
| `docs/screenshot.png` | Entire image | Predates nine-theme UI (2026-04-12), hosted workspaces, and routed Settings; the README screenshot is significantly out of date |

---

## Recommendations

1. **Fix `docs/FEATURES.md` accuracy immediately (highest impact).** This is the first doc a developer reads for capability reference. It predates six months of major features and contains three stale "Settings modal" references. Update or replace the section on Settings & Configuration; add sections for Hosted relay, Workspaces & teams, Nine themes, Device link + passkeys, Loops 2.0, Deployment monitoring, and Automations.

2. **Fix the two accuracy bugs in `docs/SETUP.md`.** The "First Login" step pointing to a removed modal will break a new self-hosted deployer's first session. The `settings.json` "Deploy Settings" section should be removed or annotated as unused legacy to avoid confusing operators who may spend time editing a file that has no effect.

3. **Update the "no UI yet" claim in `docs/OPERATIONS.md`.** A one-line edit (remove the parenthetical) keeps the curl examples as supplemental reference while correctly reflecting the shipped Platform → Accounts UI.

4. **Archive or delete `design_handoff_codekin_styling/`.** It has no ongoing utility: the tasks were executed, the target file (`Settings.tsx`) was deleted, and task 02 has no open work. Moving it to `docs/archive/` preserves history with no directory-level noise; deleting it is equally safe.

5. **Create a `docs/archive/` or `docs/specs/` directory and move completed-spec files there.** Move `LOOPS-REWRITE-SPEC.md`, `HOSTED-RELAY-CONTROL-PLANE-SPEC.md`, `HOSTED-RELAY-IMPLEMENTATION-PLAN.md`, `DEVICE-LINK-AND-PASSKEY-SPEC.md`, `SETTINGS-VIEW-SPEC.md`, and `THEME-SELECTOR-SPEC.md`. Update the single cross-reference in `docs/LOOPS.md` (`:7`) and in `docs/OPERATIONS.md` (`:327–329`) to point to the archive location. This removes six files from the top-level `docs/` listing without losing the design rationale.

6. **Update `docs/LOOPS-REWRITE-SPEC.md` status header before archiving** (or on its own if kept). The `Status: proposal` label is factually wrong for a document that describes shipped production code.

7. **Update `docs/SESSION-HANDOFF-SPEC.md` status.** Phase 1 shipped in PR #548. Mark it complete in the spec header and annotate the Phase 1 items accordingly, so the spec correctly represents the current state (Phases 2–3 remain open).

8. **Update `docs/screenshot.png`.** The README hero image predates the nine-theme UI and the hosted workspaces screen by five months. A current screenshot would better represent the product to new users and potential contributors discovering it on GitHub.

9. **Add cross-references from `docs/LOOPS.md` and `docs/WORKFLOWS.md` to the built-in recipe and workflow files** in `server/loops/` and `server/workflows/`. A single sentence and directory link in each file makes the shipped examples discoverable without requiring knowledge of the source tree layout.

10. **Mark the `docs/GITHUB-WEBHOOKS-SPEC.md` Phases 2–4 section explicitly as roadmap** (it already says "roadmap" in the status line but the individual phase descriptions blend with the Phase 1 shipped material, which could mislead readers). Consider extracting the roadmap phases into a clearly delineated section or a note at the top of each phase.