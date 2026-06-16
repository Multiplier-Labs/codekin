# Repository Health: codekin

**Date**: 2026-06-16T03:19:40.315Z
**Repository**: /srv/repos/Multiplier-Labs/codekin
**Branch**: main
**Workflow Run**: 55ec9b48-bb79-4d8d-be39-89d89b0f8859
**Session**: 3ced89b8-2c64-4cec-a357-0afc0959d5b9

---

---

# Repository Health Report — 2026-06-16

**Project:** codekin · **Branch:** main · **Version:** 0.7.0

---

## Summary

**Overall Health: Good**

The codebase is in solid shape with no TODO/FIXME debt, strong TypeScript configs, and a clean main branch. The primary concerns are a large backlog of stale remote branches (41 branches older than 30 days, the majority never formally merged to main), documentation drift in the Orchestrator spec and the newly shipped GoalRun API, and a minor discrepancy between the server TypeScript config and the frontend equivalent.

| Area | Stat |
|---|---|
| Dead code items identified | 0 confirmed |
| Stale TODO/FIXME | 0 |
| Config issues | 1 minor (server tsconfig) |
| License concerns | Low (all MPL-2.0 items are build-time only, noted in package.json) |
| Doc drift items | 3 (GoalRun API undocumented; ORCHESTRATOR-SPEC 52 days stale; `stream-json-protocol` 69 days stale) |
| Stale remote branches (>30 days) | 41 |
| Merged stale branches | 3 |
| Open PRs | 0 |

---

## Dead Code

No confirmed dead-code items were found. All exported components, hooks, and utilities in `src/` that were sampled had at least one import site. The codebase's TypeScript strict settings (`noUnusedLocals`, `noUnusedParameters`) provide continuous enforcement, making persistent dead code unlikely.

| File | Symbol | Type | Notes |
|---|---|---|---|
| — | — | — | Nothing flagged. TSC strict mode + noUnusedLocals enforcing at build time. |

---

## TODO/FIXME Tracker

A full scan of all `.ts`, `.tsx`, `.js`, and `.mjs` source files (excluding `node_modules`, `server/dist`, and test files) returned **zero** instances of `TODO`, `FIXME`, `HACK`, `XXX`, or `WORKAROUND` comments.

**Summary counts:**

| Type | Count | Stale (>30 days) |
|---|---|---|
| TODO | 0 | 0 |
| FIXME | 0 | 0 |
| HACK | 0 | 0 |
| XXX | 0 | 0 |
| WORKAROUND | 0 | 0 |
| **Total** | **0** | **0** |

---

## Config Drift

### TypeScript

| Config file | Setting | Current value | Recommended / Note |
|---|---|---|---|
| `tsconfig.app.json` | `strict` | `true` | ✅ |
| `tsconfig.app.json` | `noUnusedLocals` | `true` | ✅ |
| `tsconfig.app.json` | `noImplicitReturns` | `true` | ✅ |
| `tsconfig.app.json` | `target` | `ES2023` | ✅ Modern target, matches Node 20+ |
| `server/tsconfig.json` | `strict` | `true` | ✅ |
| `server/tsconfig.json` | `noUnusedLocals` | `true` | ✅ |
| `server/tsconfig.json` | `noImplicitReturns` | **absent** | ⚠️ Should mirror frontend — add `"noImplicitReturns": true` for parity |
| `server/tsconfig.json` | `target` | `ES2022` | Minor: frontend is `ES2023`; no functional issue but inconsistent |

### ESLint

The ESLint configuration (`eslint.config.ts`) uses `typescript-eslint` v8 with `strictTypeChecked` for both frontend and server. Several rules are demoted to `warn` with a note that they should be promoted to `error` as the codebase is cleaned up — this is a deliberate incremental strategy, not a drift issue. The approach is sound.

| Config | Setting | Status |
|---|---|---|
| Test file config | `@typescript-eslint/no-explicit-any: off` | ✅ Acceptable for test isolation |
| Test file config | `@typescript-eslint/no-require-imports: off` | ✅ Required for `vi.hoisted()` blocks, documented in comment |
| Server files | No separate `reactHooks` or `reactRefresh` plugins | ✅ Correct — server has no React code |
| Globally | No `@typescript-eslint/consistent-type-imports` rule | Low priority gap; enforced by `verbatimModuleSyntax` in tsconfig instead |

### Prettier

```json
{ "semi": false, "singleQuote": true, "trailingComma": "all", "printWidth": 120, "tabWidth": 2 }
```

No issues. `printWidth: 120` is wider than the conventional 80 but is intentional for this monospace terminal context. No deprecated options.

---

## License Compliance

The project is MIT-licensed. Dependency audit via `package-lock.json`:

| License | Count |
|---|---|
| MIT | 472 |
| ISC | 23 |
| Apache-2.0 | 18 |
| **MPL-2.0** | **12** |
| BSD-3-Clause | 9 |
| BSD-2-Clause | 8 |
| BlueOak-1.0.0 | 4 |
| MIT-0 | 2 |
| CC-BY-4.0 | 1 |
| CC0-1.0 | 1 |
| 0BSD | 1 |
| (MPL-2.0 OR Apache-2.0) | 1 |
| (MIT OR WTFPL) | 1 |
| (BSD-2-Clause OR MIT OR Apache-2.0) | 1 |
| UNKNOWN (no license field) | 2 |

**Flagged items:**

| Package | License | Status |
|---|---|---|
| `lightningcss` + 11 platform packages | MPL-2.0 | ✅ Build-time only (used by TailwindCSS); not included in distributed artifacts. Explicitly noted in `package.json#licenseNotes`. No action required. |
| `dompurify` | MPL-2.0 OR Apache-2.0 | ✅ Dual-licensed; Apache-2.0 choice is permissive. Noted in `package.json#licenseNotes`. |
| `busboy` | UNKNOWN | ℹ️ Well-known MIT library (used by `multer`); license field absent from lock metadata but source is MIT. Low risk. |
| `streamsearch` | UNKNOWN | ℹ️ Same — `busboy` internal dependency, MIT in practice. Low risk. |

No GPL, AGPL, or LGPL dependencies detected. License posture is clean.

---

## Documentation Freshness

### API Docs Freshness

| Document | Last Updated | Concern |
|---|---|---|
| `docs/API-REFERENCE.md` | 2026-06-03 | ⚠️ GoalRun API (`/api/goal-runs/templates`, `/api/goal-runs/runs`, `/api/goal-runs/runs/:id`, `POST /runs`, `POST /runs/:id/abort`) shipped in PR #517 (2026-06-15) — not yet in the reference doc |
| `docs/FEATURES.md` | 2026-06-03 | ⚠️ GoalRun / Loop Runs UI (PR #517) not documented |
| `docs/ORCHESTRATOR-SPEC.md` | 2026-04-25 | ⚠️ **52 days stale.** Six Agent Joe resilience PRs landed in June (#498, #501, #503, #504, #505) adding blocked-child notifications, notification outbox with replay, pausable timeouts, ground-truth completion verification, and org-aware repo discovery — none are reflected in the spec |
| `docs/WORKFLOWS.md` | 2026-06-03 | ✅ |
| `docs/stream-json-protocol.md` | 2026-04-08 | ⚠️ **69 days stale.** No changes in the past 30 days touched this file while OpenCode and Codex providers were added — confirm protocol is still accurate for all three providers |
| `docs/GITHUB-WEBHOOKS-SPEC.md` | (not checked in 30-day window) | Monitor |

### README Drift

The `README.md` is current. It correctly lists Claude Code, OpenCode, and Codex providers; accurately describes Agent Joe, GoalRun/Loop Runs, and Workflows features; and the install / upgrade / uninstall command tables are accurate. No drift detected.

**CONTRIBUTING.md discrepancy:**

The `CONTRIBUTING.md` Getting Started section instructs:
```bash
npm install                   # root
npm install --prefix server   # server
```

`CLAUDE.md` only lists `npm install` (root). The server does have its own `package.json` (it is a private workspace with separate devDependencies), so the two-step instruction in `CONTRIBUTING.md` is technically correct — but the inconsistency with `CLAUDE.md` may confuse contributors. Recommend either adding `npm install --prefix server` to `CLAUDE.md` or noting that the build scripts handle it.

---

## Draft Changelog

### Changes since v0.7.0 (2026-06-13 → 2026-06-16)

#### Features
- **GoalRun primitive** — new `GoalRun` loop primitive (store, verifier, controller) with a maker-checker review pass, loop templates, Goal Run API endpoints, and a Loop Runs UI view (#517, Cuts 1–5)
- **GoalRun finalization + PR write-back** — deterministic finalization with automatic PR write-back on completion (#517 Cut 5)

#### Fixes
- Strip literal `<think>` tags leaking into OpenCode response text (#516)
- Use correct REST endpoint to classify OpenCode reasoning parts (#515)
- Stop OpenCode reasoning content leaking into response text (#514)

#### Tests / Chores
- Cover `orchestrator-learning` and `memory-router` with tests (#518)

---

## Stale Branches

Cutoff: branches with last commit before **2026-05-17** (>30 days ago). 41 branches qualify.

### Representative sample — stale and NOT merged to main

| Branch | Last Commit | Author | Merged? | Recommendation |
|---|---|---|---|---|
| `origin/audit/code-review.daily-2026-04-28` | 2026-04-28 | alari | No | Delete — automated audit artifact |
| `origin/audit/code-review.daily-2026-04-29` | 2026-04-29 | alari | No | Delete — automated audit artifact |
| `origin/audit/code-review.daily-2026-04-30` | 2026-04-30 | alari | No | Delete — automated audit artifact |
| `origin/audit/code-review.daily-2026-05-01` | 2026-05-01 | alari | No | Delete — automated audit artifact |
| `origin/audit/code-review.daily-2026-05-02` | 2026-05-02 | alari | No | Delete — automated audit artifact |
| `origin/audit/code-review.daily-2026-05-03` | 2026-05-03 | alari | No | Delete — automated audit artifact |
| `origin/audit/code-review.daily-2026-05-04` | 2026-05-04 | alari | No | Delete — automated audit artifact |
| `origin/audit/comment-assessment.daily-2026-05-01` | 2026-05-01 | alari | No | Delete — automated audit artifact |
| `origin/audit/comment-assessment.daily-2026-05-08` | 2026-05-08 | alari | No | Delete — automated audit artifact |
| `origin/audit/complexity.weekly-2026-04-29` | 2026-04-29 | alari | No | Delete — automated audit artifact |
| `origin/audit/complexity.weekly-2026-05-06` | 2026-05-06 | alari | No | Delete — automated audit artifact |
| `origin/audit/dependency-health.daily-2026-04-28` | 2026-04-28 | alari | No | Delete — automated audit artifact |
| `origin/audit/dependency-health.daily-2026-05-05` | 2026-05-05 | alari | No | Delete — automated audit artifact |
| `origin/audit/docs-audit.weekly-2026-05-06` | 2026-05-06 | alari | No | Delete — automated audit artifact |
| `origin/audit/repo-health.weekly-2026-04-28` | 2026-04-28 | alari | No | Delete — automated audit artifact |
| `origin/audit/repo-health.weekly-2026-04-29` | 2026-04-29 | alari | No | Delete — automated audit artifact |
| `origin/audit/repo-health.weekly-2026-05-02` | 2026-05-02 | alari | No | Delete — automated audit artifact |
| `origin/audit/repo-health.weekly-2026-05-03` | 2026-05-03 | alari | No | Delete — automated audit artifact |
| `origin/audit/repo-health.weekly-2026-05-04` | 2026-05-04 | alari | No | Delete — automated audit artifact |
| `origin/audit/security-audit.weekly-2026-04-30` | 2026-04-30 | alari | No | Delete — automated audit artifact |
| `origin/audit/security-audit.weekly-2026-05-07` | 2026-05-07 | alari | No | Delete — automated audit artifact |
| `origin/chore/pr-audit-2026-04-12` | 2026-04-12 | alari | No | Delete — old PR audit |
| `origin/chore/release-0.6.4` | 2026-04-27 | Claude (Webhook) | No | Delete — old release branch |
| `origin/chore/reports-2026-05-02` | 2026-05-02 | alari | No | Delete |
| `origin/docs/audit-reports-2026-04-18` | 2026-04-30 | alari | No | Delete — old docs audit |
| `origin/docs/session-restart-audit` | 2026-04-15 | alari | No | Delete — old audit |
| `origin/feat/connection-status-popup` | 2026-04-11 | alari | No | Review — feature branch; verify if work was superseded |
| `origin/feat/daily-code-review-2026-04-12` | 2026-04-12 | alari | No | Delete — automated artifact |
| `origin/feat/pr-373-audit-report` | 2026-04-12 | alari | No | Delete — old audit report |
| `origin/feat/repo-health-2026-04-13` | 2026-04-13 | alari | No | Delete |
| `origin/feat/repo-health-2026-04-15` | 2026-04-16 | alari | No | Delete |
| `origin/feat/test-coverage-2026-04-13` | 2026-04-13 | alari | No | Delete |
| `origin/fix/ci-lint-errors-and-stale-mock-2026-04-27` | 2026-04-27 | Claude (Webhook) | No | Delete — old CI fix |
| `origin/fix/clone-test-timeout` | 2026-05-15 | Claude (Webhook) | No | Delete — superseded by `fix/clone-test-ci-timeout` |
| `origin/fix/commit-event-handler-mock-missing-export` | 2026-04-27 | Claude (Webhook) | No | Delete |
| `origin/fix/commit-event-handler-test-mock` | 2026-04-27 | Claude (Webhook) | No | Delete |
| `origin/fix/eslint-test-config-unused-vars-and-require` | 2026-04-27 | Claude (Webhook) | No | Delete |
| `origin/fix/security-commit-event-sanitization-2026-04-30` | 2026-04-30 | alari | No | Delete — content landed via other PRs |
| `origin/fix/security-validation-2026-04-30` | 2026-05-01 | alari76 | **Yes** | Safe to delete — already merged |
| `origin/fix/security-validation-followup-2026-04-30` | 2026-05-01 | alari76 | **Yes** | Safe to delete — already merged |
| `origin/test/coverage-gaps-apr10` | 2026-04-10 | Claude (Webhook) | No | Delete — old coverage work |

**Note:** `origin/codekin/reports` is a long-lived accumulation branch (122 commits ahead, 586 behind main) used by the automated audit workflow to store report files. It diverges by design and should be treated as a standalone persistent branch — not a candidate for deletion.

---

## PR Hygiene

`gh pr list` reports **0 open PRs** at the time of this report. The repository is clean.

| PR# | Title | Status |
|---|---|---|
| — | No open PRs | — |

---

## Merge Conflict Forecast

Branches with commits in the last 14 days (since 2026-06-02):

| Branch | Commits Ahead | Commits Behind | Files Modified (branch vs main) | Risk |
|---|---|---|---|---|
| `origin/test/orchestrator-coverage` | 1 | 11 | `server/orchestrator-learning.test.ts`, `server/orchestrator-memory-router.test.ts` | **Low** — test-only files |
| `origin/fix/opencode-strip-think-tags` | 1 | 9 | `server/opencode-process.ts`, `server/opencode-process.test.ts` | **Low** — fix already landed as PR #516; branch is a stale remote artifact |
| `origin/fix/opencode-reasoning-classify-endpoint` | 1 | 10 | `server/opencode-process.ts`, `server/opencode-process.test.ts` | **Low** — same as above; PR #515 merged |
| `origin/fix/opencode-reasoning-leak` | 1 | 11 | `server/opencode-process.ts`, `server/opencode-process.test.ts` | **Low** — same; PR #514 merged |
| `origin/fix/clone-test-ci-timeout` | 1 | 23 | `server/upload-routes.test.ts` | **Low** — test file only |
| `origin/docs/agent-joe-resilience-audit` | 1 | 31 | `.codekin/reports/agent-joe/2026-06-11_resilience-audit.md` | **Low** — report file only |
| `origin/docs/claude-code-integration-assessment` | 1 | 31 | `.codekin/reports/code-review/2026-06-11_claude-code-integration-assessment.md` | **Low** — report file only |
| `origin/chore/release-v0.7.0` | 1 | 12 | `CHANGELOG.md`, `package.json`, `package-lock.json` | **Low** — release prep; content already superseded |
| `origin/feat/goal-runs` | 0 | 2 | — (fully merged) | **None** |
| `origin/codekin/reports` | 122 | 586 | Report `.md` files only | **None** — isolated to `.codekin/reports/`; no source overlap |

No active branches show high conflict risk. All recently-active non-main branches either touch test files, documentation/reports, or have already been merged to main.

---

## Recommendations

1. **Bulk-delete stale remote audit branches** *(High impact, low risk)*  
   There are ~38 stale audit/fix/feature branches older than 30 days. The automated workflow creates per-run branches that are never formally merged. Run a batch `git push origin --delete` for all `audit/*` and old fix branches. Keep `codekin/reports` as it is a long-lived accumulation branch. This will dramatically reduce branch noise in the remote.

2. **Document the GoalRun API** *(High impact)*  
   PR #517 shipped five GoalRun endpoints (`GET /templates`, `GET /runs`, `GET /runs/:id`, `POST /runs`, `POST /runs/:id/abort`) plus a Loop Runs UI. Neither `docs/API-REFERENCE.md` nor `docs/FEATURES.md` mentions GoalRuns yet. Add a section to both before the next release.

3. **Update `docs/ORCHESTRATOR-SPEC.md`** *(High impact)*  
   The spec is 52 days stale and pre-dates all Agent Joe resilience work (#498, #501, #503, #504, #505). The new features — blocked-child notifications, notification outbox with replay, pausable timeouts, and ground-truth completion verification — fundamentally change the orchestrator's behavior model. Update the spec to reflect the current architecture.

4. **Add `noImplicitReturns: true` to `server/tsconfig.json`** *(Low effort, parity win)*  
   The frontend (`tsconfig.app.json`) and Vite config (`tsconfig.node.json`) both enable `noImplicitReturns`. The server tsconfig omits it, creating a subtle safety gap. A one-line addition brings full parity.

5. **Reconcile `CLAUDE.md` and `CONTRIBUTING.md` install instructions** *(Low effort)*  
   `CLAUDE.md` lists only `npm install`; `CONTRIBUTING.md` adds `npm install --prefix server`. The server has its own `package.json` with dev dependencies, so both steps are correct — but the inconsistency risks contributor confusion. Align them or add a note in `CLAUDE.md` explaining the two-step setup.

6. **Review or close `origin/feat/connection-status-popup`** *(Medium priority)*  
   This feature branch from 2026-04-11 is 66 days old and not merged. A connection status popup concept may have been superseded by later connection health work. Verify whether the work is still relevant; close the branch if not.

7. **Review staleness of `docs/stream-json-protocol.md`** *(Medium impact)*  
   Last updated 2026-04-08 (69 days ago). OpenCode and Codex providers were added since then, each with distinct stream-JSON event shapes. Confirm the document still accurately describes the protocol for all three providers, or add provider-specific sections.

8. **Add automated stale-branch cleanup to the audit workflow** *(Systemic fix)*  
   The automated audit workflow creates new branches without retiring old ones. Consider adding a step that deletes `audit/*` branches older than 14 days after their associated PR is merged (or after a fixed TTL). This prevents the backlog from growing with each run.

9. **Promote `warn`-level ESLint rules to `error` incrementally** *(Long-term code quality)*  
   Seven TypeScript ESLint rules are currently demoted to `warn` with an explicit comment noting they should be promoted. Tracking this as a periodic chore (e.g., one rule per sprint) will improve type safety over time. Candidates: `@typescript-eslint/no-unnecessary-condition` and `@typescript-eslint/no-non-null-assertion` are highest-value.

10. **Verify `busboy` and `streamsearch` license metadata** *(Low risk, compliance hygiene)*  
    Both packages lack a `license` field in `package-lock.json`. Both are well-known MIT packages (`busboy` is used by `multer`, which is a direct dependency). Confirm via `npm info busboy license` or by reading the package source, and add a note to `package.json#licenseNotes` for audit completeness.