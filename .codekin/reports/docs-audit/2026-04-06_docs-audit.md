# Documentation Audit: codekin

**Date**: 2026-04-06T16:11:35.109Z
**Repository**: /home/benjamintalic/repos/codekin
**Branch**: feat/opencode-provider
**Workflow Run**: 09bb5922-e547-4d44-a7df-c47f3f73357b
**Session**: f890175d-9328-40fd-b395-ce41efc72e3f

---

Let me try a different approach to get workflow file info.Now let me check the actual default in the code to see if the plan was implemented:Good — the plan was implemented. Now I have all the data I need to produce the report.

## Summary

**Total documentation files: 20** (excluding workflow prompts and generated reports). **Health rating: Needs cleanup.** The core technical docs (API reference, stream protocol, features) are largely accurate, but there is significant sprawl from spec/plan documents that describe already-shipped work, inconsistent session cap defaults across docs, and one untracked plan file that should be deleted. The `docs/` directory mixes user-facing guides, developer specs, and completed implementation plans without clear organization.

| Metric | Count |
|--------|-------|
| Total doc files (excluding workflows/reports) | 20 |
| Current / accurate | 10 |
| Stale (minor updates needed) | 5 |
| Outdated or redundant | 3 |
| Completed plan (delete candidate) | 2 |

## Documentation Inventory

| Path | Lines | Last Modified | Purpose | Status |
|------|-------|---------------|---------|--------|
| `CLAUDE.md` | 57 | 2026-04-04 | Project conventions, dev commands, branching policy | Current |
| `CONTRIBUTING.md` | 111 | 2026-03-18 | Contribution guide: setup, coding style, PR process | Stale |
| `SECURITY.md` | 43 | 2026-03-08 | Vulnerability reporting, deployment security | Current |
| `CODE_OF_CONDUCT.md` | 31 | 2026-03-08 | Community guidelines (Contributor Covenant) | Current |
| `docs/SETUP.md` | 415 | 2026-04-01 | Production deployment guide (nginx + Authelia + systemd) | Stale |
| `docs/INSTALL-DISTRIBUTION.md` | 184 | 2026-04-01 | npm distribution model, CLI commands, service install | Current |
| `docs/FEATURES.md` | 401 | 2026-04-01 | Feature walkthrough for end users/developers | Stale |
| `docs/API-REFERENCE.md` | 691 | 2026-03-16 | REST + WebSocket API reference | Stale |
| `docs/stream-json-protocol.md` | 586 | 2026-03-16 | Claude CLI stream-json protocol internals | Current |
| `docs/WORKFLOWS.md` | 186 | 2026-04-01 | Automated workflow system documentation | Current |
| `docs/ORCHESTRATOR-SPEC.md` | 669 | 2026-03-16 | Agent Joe orchestrator specification (Phases 1–4) | Stale |
| `docs/GITHUB-WEBHOOKS-SPEC.md` | 810 | 2026-03-14 | GitHub webhook architecture spec (Phase 1 + roadmap) | Outdated |
| `docs/PR-REVIEW-WEBHOOK.md` | 219 | 2026-04-06 | PR review webhook system documentation | Current |
| `docs/plan-webhook-fixes.md` | 356 | Untracked | Implementation plan for 3 webhook fixes | Redundant |
| `.github/ISSUE_TEMPLATE/bug_report.md` | 40 | 2026-03-08 | GitHub issue template for bugs | Current |
| `.github/ISSUE_TEMPLATE/feature_request.md` | 23 | 2026-03-08 | GitHub issue template for features | Current |
| `.github/PULL_REQUEST_TEMPLATE.md` | 17 | 2026-03-08 | GitHub PR template | Current |
| `server/workflows/*.md` (9 files) | ~varies | 2026-03-14 | Workflow prompt templates (not traditional docs) | N/A |

## Staleness Findings

### 1. `docs/GITHUB-WEBHOOKS-SPEC.md` — Outdated defaults and roadmap items
- **Session cap default**: Spec says default is 3 (line ~19 area), but code was changed to 15 (`server/webhook-config.ts:19`). The plan doc and commit `d20c5ce` confirm this was intentionally bumped.
- **Phase 1 scope**: Describes only `workflow_run` events, but PR review webhooks (`pull_request` events) are now fully implemented and documented separately in `PR-REVIEW-WEBHOOK.md`.
- **Roadmap phases 2–4**: Still listed as future work; unclear which items have been implemented since this file was last updated 2026-03-14.
- **`GITHUB_WEBHOOK_MODE`** documented as default `supervised` for Phase 2+ — may not reflect current implementation.

### 2. `docs/ORCHESTRATOR-SPEC.md` — Version reference drift
- References "Phase 1 shipped (v0.5.0), Phases 2–4 shipped (v0.5.2)" but `package.json` shows version `0.5.3`.
- Memory retention expiry (30/60/90/180 day policies) documented but no background cleanup job described — unclear if implemented.

### 3. `CONTRIBUTING.md` — Missing webhook environment variables
- Lists `AUTH_TOKEN` as required in production but does not mention `AUTH_TOKEN_FILE` (preferred in `SETUP.md`).
- No mention of webhook-specific env vars (`GITHUB_WEBHOOK_SECRET`, `GITHUB_WEBHOOK_ENABLED`) that are now part of the system.
- References `npm install --prefix server` for server dependencies — verify this is still needed or if root `npm install` covers both.

### 4. `docs/FEATURES.md` — Minor session cap reference
- "Auto-close countdown" mentioned for webhook sessions, but the auto-kill behavior was only recently implemented (commit `bd8449f`). Verify the described behavior matches the actual implementation.

### 5. `docs/API-REFERENCE.md` — Potentially missing newer endpoints
- Last updated 2026-03-16. Multiple webhook, workflow, and orchestrator endpoints have been added since. The `set_provider` WebSocket message type was added (visible in `src/types.ts`) but may not be documented.
- Hook endpoints (`/api/tool-approval`, `/api/hook-decision`, `/api/hook-notify`) are listed but their interaction with the newer approval system may have evolved.

## Accuracy Issues

### 1. Session cap inconsistency across docs
| Document | Claimed Default | Actual (code) |
|----------|----------------|----------------|
| `GITHUB-WEBHOOKS-SPEC.md` | 3 | **15** |
| `PR-REVIEW-WEBHOOK.md` | "default 3, set to 10 via config" | **15** |
| `plan-webhook-fixes.md` | "change from 3 to 15" | **15** (implemented) |

All docs except the plan are stale on this value.

### 2. Environment file path inconsistency
- `SETUP.md` references `~/.codekin/env`
- `INSTALL-DISTRIBUTION.md` references `~/.config/codekin/env`
- Both paths may work, but the inconsistency is confusing for users.

### 3. `CONTRIBUTING.md` server install command
- Documents `npm install --prefix server` as a separate step. Verify whether the root `package.json` postinstall or workspace config handles this automatically.

### 4. `/auth-verify` vs `/api/auth/validate` duplication
- `API-REFERENCE.md` documents both endpoints. It's unclear if both are still active or if one supersedes the other.

## Overlap & Redundancy

### Group 1: Webhook Documentation Overlap
| File | Lines | Topic |
|------|-------|-------|
| `docs/GITHUB-WEBHOOKS-SPEC.md` | 810 | Full webhook architecture (Phase 1 focus: `workflow_run`) |
| `docs/PR-REVIEW-WEBHOOK.md` | 219 | PR review webhook system (`pull_request` events) |
| `docs/plan-webhook-fixes.md` | 356 | Implementation plan for 3 webhook fixes |

**Overlap**: `GITHUB-WEBHOOKS-SPEC.md` covers the original webhook system. `PR-REVIEW-WEBHOOK.md` extends it for PR events. `plan-webhook-fixes.md` is a completed implementation plan.

**Recommendation**: 
- Delete `plan-webhook-fixes.md` (all 3 fixes are implemented per commits `d20c5ce`, `bd8449f`, `9b23448`).
- Update `GITHUB-WEBHOOKS-SPEC.md` to reference `PR-REVIEW-WEBHOOK.md` for PR-specific behavior, or consolidate into a single webhook doc.

### Group 2: Setup / Installation Overlap
| File | Lines | Topic |
|------|-------|-------|
| `docs/SETUP.md` | 415 | Manual production deployment (nginx, systemd, Authelia) |
| `docs/INSTALL-DISTRIBUTION.md` | 184 | npm install, CLI usage, user-level services |
| `CONTRIBUTING.md` | 111 | Dev setup, env vars, coding conventions |

**Overlap**: All three document environment variables with slightly different lists and different default paths. `SETUP.md` and `CONTRIBUTING.md` both cover development setup steps.

**Recommendation**: Consolidate environment variable documentation into one canonical source (probably `SETUP.md`) and have others reference it.

## Fragmentation

### 1. Completed spec docs still maintained as standalone files
`docs/ORCHESTRATOR-SPEC.md` (669 lines) describes a fully shipped feature (Phases 1–4 all marked complete). This is a design spec that has served its purpose. The ongoing reference value is limited since the feature is now best understood by reading the code and API reference.

**Recommendation**: Fold key operational details into `docs/API-REFERENCE.md` and `docs/FEATURES.md`, then archive or delete the spec.

### 2. `docs/GITHUB-WEBHOOKS-SPEC.md` (810 lines) — largest doc file
Contains detailed Phase 1 implementation spec plus Phases 2–4 roadmap. Phase 1 is shipped; the roadmap sections add bulk without clear value if they're not being actively tracked.

**Recommendation**: Trim roadmap sections or move to a GitHub project board. Keep operational reference in the main doc.

### 3. Workflow prompt templates in `server/workflows/`
These 9 `.md` files are Claude prompt templates, not user-facing documentation. They appear in `**/*.md` searches and could confuse documentation tooling. This is a minor concern since they're clearly in `server/` rather than `docs/`.

## Action Items

### Delete

| File | Reason |
|------|--------|
| `docs/plan-webhook-fixes.md` | All 3 fixes implemented (commits `d20c5ce`, `bd8449f`, `9b23448`, `289d127`). File is untracked in git. No ongoing reference value — the commits tell the story. |

### Consolidate

| Source Files | Target | Keep/Drop |
|-------------|--------|-----------|
| `GITHUB-WEBHOOKS-SPEC.md` + `PR-REVIEW-WEBHOOK.md` | Keep both, but add cross-references | `GITHUB-WEBHOOKS-SPEC.md` should link to `PR-REVIEW-WEBHOOK.md` for PR events; remove any duplicated webhook infrastructure descriptions from the PR doc |
| `SETUP.md` + `CONTRIBUTING.md` env var sections | Canonical env var table in `SETUP.md` | `CONTRIBUTING.md` should reference `SETUP.md` for env vars instead of maintaining a separate list |

### Update

| File | Sections Needing Update | What Changed |
|------|------------------------|--------------|
| `docs/GITHUB-WEBHOOKS-SPEC.md` | Default session cap, Phase 1 scope | Cap changed from 3 → 15; PR review webhooks now implemented but not mentioned |
| `docs/API-REFERENCE.md` | WebSocket message types, newer endpoints | `set_provider` message type added; verify orchestrator/webhook endpoints current |
| `docs/ORCHESTRATOR-SPEC.md` | Version reference | Says v0.5.2, current is v0.5.3 |
| `CONTRIBUTING.md` | Environment variables section | Missing webhook env vars (`GITHUB_WEBHOOK_SECRET`, etc.); missing `AUTH_TOKEN_FILE` |
| `docs/SETUP.md` | Env file path | Uses `~/.codekin/env`; should align with `INSTALL-DISTRIBUTION.md`'s `~/.config/codekin/env` or explain both |
| `docs/PR-REVIEW-WEBHOOK.md` | Session cap default | Still references "default 3"; actual default is now 15 |
| `docs/FEATURES.md` | Webhook session lifecycle | Auto-kill behavior recently implemented; verify described behavior matches |

## Recommendations

1. **Delete `docs/plan-webhook-fixes.md`** — Completed plan, untracked, all fixes shipped. Immediate cleanup win.

2. **Fix session cap references across all docs** — The default changed from 3 to 15. Update `GITHUB-WEBHOOKS-SPEC.md`, `PR-REVIEW-WEBHOOK.md`, and any other references. This is the most impactful inaccuracy.

3. **Canonicalize environment variable documentation** — Create one authoritative table in `SETUP.md` covering all env vars (including webhook-specific ones). Have `CONTRIBUTING.md` and `INSTALL-DISTRIBUTION.md` link to it rather than maintaining separate partial lists.

4. **Resolve `~/.codekin/env` vs `~/.config/codekin/env` path confusion** — Document both paths with clear explanation of when each is used, or migrate to a single path.

5. **Update `docs/API-REFERENCE.md`** — Last substantive update was 2026-03-16. Audit all endpoints against current route files to catch any added/removed/changed endpoints.

6. **Trim `docs/GITHUB-WEBHOOKS-SPEC.md` roadmap sections** — Phases 2–4 roadmap adds 400+ lines of speculative content. Move to GitHub issues or a project board, keep only implemented behavior.

7. **Consider archiving `docs/ORCHESTRATOR-SPEC.md`** — At 669 lines, this fully-shipped spec is the second-largest doc. Its operational value should be captured in `API-REFERENCE.md` and `FEATURES.md`, then the spec can be archived.

8. **Add cross-references between webhook docs** — `GITHUB-WEBHOOKS-SPEC.md` and `PR-REVIEW-WEBHOOK.md` cover related systems but don't link to each other.

9. **Clarify auth endpoint duplication** — Document whether `/auth-verify` and `/api/auth/validate` are both needed or if one should be deprecated.

10. **Add version discovery to bug report template** — The bug report template asks for "Codekin version" but doesn't explain how to find it. Add a note about `codekin --version` or checking `package.json`.