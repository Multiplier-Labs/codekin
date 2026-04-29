# Repository Health: codekin

**Date**: 2026-04-28T03:23:11.952Z
**Repository**: /srv/repos/codekin
**Branch**: docs/audit-reports-2026-04-18
**Workflow Run**: 2f70fb59-ed14-431c-ae72-2dbc197fe42e
**Session**: 82433c5a-7fba-4ad2-8e7a-0d95bad3da1d

---

I'll gather the data needed for the health assessment by running several parallel queries.Now I have enough data to compile the full report.

---

# Codekin Repository Health Report — 2026-04-28

## Summary

**Overall Health: Good**

The codebase maintains strong TypeScript discipline (strict mode everywhere, no source-level dead code), no copyleft license concerns, and an active development cadence. Primary concerns are a growing backlog of unreviewed/stuck doc PRs, orphaned compiled artifacts in `server/dist/`, a batch of unmerged report branches diverging from `main`, and a few ESLint rules held at `warn` instead of `error`.

| Category | Count / Status |
|---|---|
| Dead code items | 9 orphaned compiled modules in `server/dist/` |
| Source-level TODOs/FIXMEs | 0 (none in production source) |
| Config issues | 3 minor |
| License concerns | 2 dependencies with unknown license |
| Stale branches (>30 days) | 0 strictly; 9 aging (18–28 days behind, unmerged) |
| Stuck PRs (>7 days, no review) | 8 |
| Doc drift items | 2 (ws-rate-limit undocumented; API-REFERENCE last updated Apr 15) |

---

## Dead Code

### Source-Level

No unused exports or orphan source files were found. TypeScript's `noUnusedLocals` and `noUnusedParameters` are enforced on all tsconfigs, and all component and hook files are properly imported.

### Orphaned Compiled Artifacts in `server/dist/`

These `.js`, `.d.ts`, and `.js.map` files have no corresponding `.ts` source and are never imported anywhere in the active codebase.

| File (server/dist/) | Type | Recommendation |
|---|---|---|
| `review-config.{js,d.ts,js.map}` | Orphaned compiled output | Remove — source was deleted |
| `review-handler.{js,d.ts,js.map}` | Orphaned compiled output | Remove — source was deleted |
| `review-routes.{js,d.ts,js.map}` | Orphaned compiled output | Remove — source was deleted |
| `shepherd-children.{js,d.ts,js.map}` | Orphaned compiled output | Remove — source was deleted |
| `shepherd-learning.{js,d.ts,js.map}` | Orphaned compiled output | Remove — source was deleted |
| `shepherd-manager.{js,d.ts,js.map}` | Orphaned compiled output | Remove — source was deleted |
| `shepherd-memory.{js,d.ts,js.map}` | Orphaned compiled output | Remove — source was deleted |
| `shepherd-monitor.{js,d.ts,js.map}` | Orphaned compiled output | Remove — source was deleted |
| `shepherd-routes.{js,d.ts,js.map}` | Orphaned compiled output | Remove — source was deleted |

These are remnants of an earlier rename from `shepherd-*` to `orchestrator-*` and a removed `review-*` subsystem. They bloat the published npm package (the `server/dist/` directory is included in the `files` field of `package.json`) and risk shadowing future modules with similar names.

---

## TODO/FIXME Tracker

Scanned all `.ts`, `.tsx`, and `.sh` files in `src/` and `server/`. No `TODO`, `FIXME`, `HACK`, `XXX`, or `WORKAROUND` comments were found in production source files. The only matches are inside test files using the string `"TODO"` as a test fixture value (e.g., `{ pattern: 'TODO' }` in process test mocks), which are not actionable items.

| Type | Count |
|---|---|
| TODO | 0 |
| FIXME | 0 |
| HACK | 0 |
| XXX | 0 |
| WORKAROUND | 0 |
| **Stale (>30 days)** | **0** |

**Result: Clean.**

---

## Config Drift

### TypeScript

| Config File | Setting | Current Value | Recommended / Note |
|---|---|---|---|
| `tsconfig.app.json` | `target` | `ES2022` | Fine; note minor inconsistency with `tsconfig.node.json` |
| `tsconfig.node.json` | `target` | `ES2023` | Fine; minor inconsistency with app target |
| `tsconfig.app.json`, `tsconfig.node.json`, `server/tsconfig.json` | `noImplicitReturns` | *(absent)* | Consider adding — prevents functions that fall off the end silently |
| All tsconfigs | `skipLibCheck` | `true` | Standard for npm projects; acceptable |
| All tsconfigs | `strict` | `true` | ✓ Correct |
| `tsconfig.app.json` | `noUnusedLocals`, `noUnusedParameters` | `true` | ✓ Correct |

No critical issues. The `ES2022` vs `ES2023` target inconsistency between `tsconfig.app.json` and `tsconfig.node.json` is cosmetic but worth aligning.

### ESLint

| Finding | Detail |
|---|---|
| Rules held at `warn` instead of `error` | 8 rules are `warn` in both frontend and server configs: `no-unnecessary-condition`, `no-confusing-void-expression`, `no-base-to-string`, `no-non-null-assertion`, `no-misused-promises`, `use-unknown-in-catch-callback-variable`, `require-await`, `restrict-template-expressions`. The inline comment acknowledges these as "pre-existing patterns for incremental adoption." These should be tracked and promoted to `error` over time. |
| Test files use `tseslint.configs.recommended` | Test files use a looser config than production files (no `strictTypeChecked`), and `no-explicit-any` is disabled. Intentional, but means test code has less type safety. |
| No `eslint-plugin-import` | There is no import ordering or unused-import lint rule. TypeScript catches unused imports via `noUnusedLocals`, but import order is unregulated. |

### Prettier

| Setting | Current Value | Note |
|---|---|---|
| `printWidth` | `120` | Wider than common defaults (80 or 100); fine as a team preference |
| `singleQuote` | `true` | ✓ Consistent with codebase |
| `semi` | `false` | ✓ Consistent with codebase |

No blocking issues.

---

## License Compliance

Project license: **MIT**

### Dependency License Summary

| License | Count |
|---|---|
| MIT | 465 |
| ISC | 22 |
| Apache-2.0 | 18 |
| MPL-2.0 | 12 |
| BSD-3-Clause | 9 |
| BSD-2-Clause | 8 |
| BlueOak-1.0.0 | 4 |
| MIT-0 | 2 |
| UNKNOWN | 2 |
| CC-BY-4.0 | 1 |
| CC0-1.0 | 1 |
| (MPL-2.0 OR Apache-2.0) | 1 |
| (MIT OR WTFPL) | 1 |
| (BSD-2-Clause OR MIT OR Apache-2.0) | 1 |
| 0BSD | 1 |

**No GPL, AGPL, or LGPL dependencies detected.**

### Flagged Dependencies

| Package | License | Issue |
|---|---|---|
| `busboy` | UNKNOWN | License not recorded in lock file metadata; actual license is MIT (verified via npm registry). Low risk but worth confirming. |
| `streamsearch` | UNKNOWN | Transitive dependency of `busboy`; actual license is MIT. Same situation. |

The `MPL-2.0` entries are consistent with the acknowledgement in `package.json` (`licenseNotes`) regarding `dompurify` and `lightningcss` — both are permissively compatible for this use case and already documented.

---

## Documentation Freshness

### API Docs

| Document | Last Updated | Issue |
|---|---|---|
| `docs/API-REFERENCE.md` | 2026-04-15 (13 days ago) | `ws-rate-limit` (added 2026-04-27) and `ws-origin-check` are new server modules with no corresponding API reference entries. Rate-limit configuration parameters (`WS_RATE_LIMIT_*`) are not yet documented. |
| `docs/ORCHESTRATOR-SPEC.md` | 2026-04-15 | `orchestrator-monitor.ts` was modified on 2026-04-27; verify spec still matches current monitoring behavior. |
| `docs/WORKFLOWS.md` | 2026-04-15 | No changes to workflow engine since Apr 15; still fresh. |
| `docs/GITHUB-WEBHOOKS-SPEC.md` | — | No changes to webhook routes in the last 30 days; likely still accurate. |

### README Drift

The `README.md` is accurate for user-facing documentation. One potential drift item:

| Item | README Says | Actual State | Severity |
|---|---|---|---|
| Package manager | `npm install` (CLAUDE.md) / one-liner install (README) | A `pnpm-lock.yaml` file is present as an untracked file — suggesting the project may be migrating to pnpm. If pnpm is adopted, CLAUDE.md development instructions need updating. | Low (pending decision) |
| Install URL | `codekin.ai/install.sh` | URL not verifiable from repo, but the path is referenced in INSTALL-DISTRIBUTION.md; no mismatch with source. | N/A |
| `codekin upgrade` | Listed as a command | Present in `bin/codekin.mjs` — still valid. | OK |

No broken script names or missing paths were found in the README relative to `package.json`.

---

## Draft Changelog

### v0.6.4 — 2026-04-28 (since v0.6.3)

#### Features
- **WebSocket rate limiting**: Added `ws-rate-limit.ts` — per-IP WebSocket connection rate limiter with configurable window and max-connections cap, hardening the server against connection flooding.
- **WebSocket origin validation**: Added `ws-origin-check.ts` — origin-header validation for WebSocket handshakes, preventing cross-site WebSocket hijacking in production.
- **Claude Opus 4.7 model support**: New model option available in session configuration.

#### Fixes
- Prevent JSON injection in `commit-event-hook.sh` — shell arguments are now properly escaped.
- Block symlink bypass in spawn route — `realpathSync` resolves symlinks before path validation.
- Add hard size caps to auth and webhook rate-limiter maps to prevent unbounded memory growth.
- Harden upload and workflow routes with additional input validation.
- Expand test coverage for `commit-event-handler`, `upload-routes`, `workflow-engine`, `workflow-loader`, `workflow-routes`, and `orchestrator-monitor`.

#### Refactoring
- Decomposed `App.tsx` into focused hooks for better maintainability.
- Split `orchestrator-routes.ts` into focused sub-routers.

#### Chores
- Enforce `strict @typescript-eslint/no-unsafe-*` rules across the codebase.
- Add automated daily repo-health, code-review, test-coverage, docs-audit, and complexity reports.

---

## Stale Branches

No branches have zero commit activity for more than 30 days. However, several unmerged branches are aging and/or highly diverged from `main`:

| Branch | Last Commit | Author | Merged? | Ahead | Behind | Recommendation |
|---|---|---|---|---|---|---|
| `origin/test/coverage-gaps-apr10` | 2026-04-10 | claude-webhook | No | 2 | 137 | Close — nearly 4 weeks old, 137 commits behind; work superseded by later coverage PRs |
| `origin/feat/connection-status-popup` | 2026-04-11 | alari | No | 5 | 111 | Review or close — feature not merged, 111 commits behind |
| `origin/chore/pr-audit-2026-04-12` | 2026-04-12 | alari | No | 1 | 79 | Close — report-only branch, work is in PR #390; very stale |
| `origin/feat/daily-code-review-2026-04-12` | 2026-04-12 | alari | No | 1 | 66 | Close — superseded by later daily review pipeline |
| `origin/feat/pr-373-audit-report` | 2026-04-12 | alari | No | 1 | 93 | Close — audit report; work is in PR #374 |
| `origin/docs/session-restart-audit` | 2026-04-13 | alari | No | 1 | 50 | Close — docs-only branch in PR #402 |
| `origin/feat/repo-health-2026-04-13` | 2026-04-13 | alari | No | 2 | 63 | Close — superseded by continuous health reports |
| `origin/feat/test-coverage-2026-04-13` | 2026-04-13 | alari | No | 3 | 63 | Close — superseded by PR #396 |
| `origin/feat/repo-health-2026-04-15` | 2026-04-16 | alari | No | 4 | 50 | Close — report branch, 50 commits behind |
| `origin/codekin/reports` | 2026-04-27 | alari76 | No | 99 | 519 | Investigate — 519 commits behind main; may be a long-lived accumulation branch that should be rebased or merged |

---

## PR Hygiene

| PR# | Title | Author | Days Open | Review Status | Mergeable | Stuck? |
|---|---|---|---|---|---|---|
| #447 | fix(test): add isWorkflowReportsBranch to commit-event-handler mock | alari76 | 1 | None | ✓ MERGEABLE | No |
| #446 | fix(test): add isWorkflowReportsBranch to commit-event-handler mock | alari76 | 1 | None | ✓ MERGEABLE | No — duplicate of #447; one should be closed |
| #444 | chore: release 0.6.4 | alari76 | 1 | None | ✗ CONFLICTING | No |
| #443 | fix(tests): resolve CI lint errors + stale workflow-loader mock | alari76 | 1 | None | ✓ MERGEABLE | No |
| #442 | fix(ci): unblock lint + repair commit-event-handler test mock | alari76 | 1 | None | ✗ CONFLICTING | No |
| #422 | docs: add accumulated audit reports (2026-04-16 through 2026-04-18) | alari76 | 10 | None | ✗ CONFLICTING | ⚠ Yes |
| #413 | docs: weekly repo health report + accumulated audit reports | alari76 | 13 | None | ✓ MERGEABLE | ⚠ Yes |
| #402 | docs: session restart root cause audit | alari76 | 15 | None | ✓ MERGEABLE | ⚠ Yes |
| #396 | docs: test coverage report 2026-04-13 | alari76 | 15 | None | ✓ MERGEABLE | ⚠ Yes |
| #395 | docs: repo health report 2026-04-13 | alari76 | 15 | None | ✓ MERGEABLE | ⚠ Yes |
| #392 | docs: add daily code review report for 2026-04-12 | alari76 | 16 | None | ✓ MERGEABLE | ⚠ Yes |
| #390 | docs: PR code review audit (2026-04-12) | alari76 | 16 | None | ✓ MERGEABLE | ⚠ Yes |
| #374 | docs: Add audit report for PR #373 | alari76 | 16 | None | ✓ MERGEABLE | ⚠ Yes |

**Notes:**
- PRs #446 and #447 have identical titles — one is a duplicate and should be closed.
- PRs #444 and #422 have merge conflicts that must be resolved before merging.
- 8 PRs are stuck (>7 days with no review). All are docs/report PRs accumulating from the automated audit pipeline. A batch-merge strategy for report PRs would clear this backlog.

---

## Merge Conflict Forecast

| Branch | Commits Ahead | Commits Behind | Changed Files (vs. main) | Overlap Risk | Risk Level |
|---|---|---|---|---|---|
| `origin/docs/audit-reports-2026-04-18` | 15 | 40 | `.codekin/reports/` files only | Reports directory only; no server/src overlap | Low |
| `origin/fix/main-lint-and-test-regressions` | 1 | 1 | `server/commit-event-handler.test.ts` | Test file also modified on `main` side (via `71161ff`) | Medium — rebase recommended |
| `origin/deps/stepflow-0.3.4` | 2 | 25 | `workflows/package.json`, `workflows/package-lock.json`, `workflows/coverage-assessment.ts` | Workflow files not modified on `main` recently | Low |
| `origin/codekin/reports` | 99 | 519 | Hundreds of `.codekin/reports/` files | Extreme divergence — 519 commits behind main; rebasing is infeasible | High — requires investigation |
| `origin/feat/connection-status-popup` | 5 | 111 | `src/App.tsx`, `src/components/SessionContent.tsx`, `src/hooks/useWsConnection.ts` | `App.tsx` was heavily refactored on main (decomposed into hooks); high structural conflict | High — significant rework needed if resumed |

---

## Recommendations

1. **Batch-merge or close the doc/report PR backlog (PRs #374, #390, #392, #395, #396, #402, #413, #422).** Eight report PRs have been open for 10–16 days with no reviews. Establish a policy to auto-merge report PRs after a short window (e.g., 2 days), or consolidate them into a single weekly merge to keep the PR list clean.

2. **Remove orphaned compiled artifacts from `server/dist/`.** Nine `shepherd-*` and `review-*` compiled module groups have no source and are included in the published npm package. Run a clean build (`tsc -b`) after deleting them to confirm nothing references them, then commit the removal. This reduces package size and eliminates confusion.

3. **Document `ws-rate-limit` in `docs/API-REFERENCE.md`.** The new `WS_RATE_LIMIT_*` configuration parameters and the origin-validation behavior of `ws-origin-check.ts` were added in the last commit but are absent from user-facing documentation.

4. **Resolve merge conflicts on PRs #444 and #422** and close the duplicate PR #446. These create noise in the PR list and block the `0.6.4` release if #444 is the release PR.

5. **Close or rebase `feat/connection-status-popup`.** This branch is 17 days old and 111 commits behind main; `App.tsx` was substantially refactored on main since this branch diverged. If the feature is still wanted, it needs a fresh rebase. If not, close it.

6. **Promote ESLint `warn` rules to `error` incrementally.** Eight rules (`no-unnecessary-condition`, `no-non-null-assertion`, `no-misused-promises`, etc.) are held at `warn`. Pick two per sprint and promote them to `error`, fixing violations as you go. This improves long-term type safety without requiring a big-bang cleanup.

7. **Investigate `origin/codekin/reports` (99 ahead, 519 behind main).** This branch is severely diverged and may be an unintended long-running accumulation branch. Determine if it should be archived, rebased, or deleted.

8. **Resolve the `busboy` / `streamsearch` unknown-license entries** by confirming their licenses via the npm registry (both are MIT) and optionally pinning the verified license in `package.json` overrides or a license-check config file.

9. **Decide on `pnpm` migration.** A `pnpm-lock.yaml` exists as an untracked file, suggesting the project may be switching package managers. Either commit the lock file and update CLAUDE.md, or remove it to avoid confusion for contributors using `npm`.

10. **Add `noImplicitReturns: true` to all tsconfigs.** This is a straightforward addition that catches functions that silently return `undefined` through a non-`return` code path, complementing the existing strict-mode settings.Committed and pushed 31 files to `docs/audit-reports-2026-04-18`. The `pnpm-lock.yaml` was left unstaged since it represents a potentially unintentional package manager migration that warrants a separate deliberate decision.