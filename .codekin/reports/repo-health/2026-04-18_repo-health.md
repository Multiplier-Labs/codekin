# Repository Health Report — Codekin

**Date**: 2026-04-19  
**Repository**: /srv/repos/codekin  
**Branch assessed**: main (as of 2026-04-18)  
**Version**: v0.6.3

---

## Summary

**Overall health: Good**

The codebase is in strong shape: strict TypeScript enforces zero dead code accumulation, the test suite is comprehensive (1,639 tests, all passing), and recent weeks show an active security hardening campaign. The main areas needing attention are branch hygiene (several unmerged feature branches with growing divergence), a backlog of 8 unreviewed audit-report PRs, and a critically diverged `codekin/reports` branch that poses operational risk.

| Category | Stat |
|---|---|
| Dead code items | 0 significant |
| Stale TODO/FIXME (>30 days) | 0 — no actionable TODOs found in source |
| Config drift issues | 0 — configs are modern and consistent |
| License concerns | 13 MPL-2.0 packages (build-time only; low risk) |
| Doc drift items | 1 — `ORCHESTRATOR-SPEC.md` may lag Apr-15 refactor |
| Branches with no recent activity (>14 days) | 0 of 20 remote branches |
| Branches that are stale-relative-to-main candidates | 2 (`test/coverage-gaps-apr10`, `feat/connection-status-popup`) |
| Open PRs | 8 (all docs/audit, all MERGEABLE, none reviewed) |
| Stuck PRs (>7 days, no review) | 3 (#374, #390, #392) |
| High merge-conflict risk | 1 (`feat/connection-status-popup`) |

---

## Dead Code

No dead-code issues found. The project enforces `noUnusedLocals: true` and `noUnusedParameters: true` in both `tsconfig.app.json` and `server/tsconfig.json`, which means the TypeScript compiler prevents accumulation of unused exports at build time. ESLint `@typescript-eslint/no-unsafe-*` rules are enforced as errors.

No orphan files were detected: every source file in `src/` is reachable from the React component tree rooted at `App.tsx`, and every server module is imported through the Express router chain.

| File | Symbol | Type | Recommendation |
|---|---|---|---|
| — | — | — | No items to report |

---

## TODO/FIXME Tracker

Scanned `src/` and `server/` for `TODO`, `FIXME`, `HACK`, `XXX`, `WORKAROUND`. The only matches are inside test files and are test-fixture strings, not technical-debt annotations.

| File:Line | Type | Comment | Author | Date | Stale? |
|---|---|---|---|---|---|
| `server/claude-process.test.ts:60–61` | (test fixture) | `summarizeToolInput('Grep', { pattern: 'TODO' })` | alari | — | No — test code |
| `server/claude-process.test.ts:809` | (test fixture) | `input: { pattern: 'TODO' }` | alari | — | No — test code |
| `server/opencode-process.test.ts:557` | (test fixture) | `summarizeToolInput('grep', { pattern: 'TODO' })` | alari | — | No — test code |

**Summary**: 0 actionable TODO/FIXME items in source code. 3 occurrences are test strings verifying tool-input summarization logic.

| Type | Count |
|---|---|
| TODO (source) | 0 |
| TODO (test fixtures) | 3 |
| FIXME | 0 |
| HACK | 0 |
| XXX | 0 |
| WORKAROUND | 0 |
| **Stale (>30 days)** | **0** |

---

## Config Drift

### tsconfig.app.json (frontend)

| Setting | Current | Recommended | Status |
|---|---|---|---|
| `strict` | `true` | `true` | ✓ OK |
| `noUnusedLocals` | `true` | `true` | ✓ OK |
| `noUnusedParameters` | `true` | `true` | ✓ OK |
| `target` | `ES2022` | `ES2022`+ | ✓ OK |
| `moduleResolution` | `bundler` | `bundler` (Vite) | ✓ OK |
| `noFallthroughCasesInSwitch` | `true` | `true` | ✓ OK |
| `erasableSyntaxOnly` | `true` | — (TS 5.5+) | ✓ Modern |

### server/tsconfig.json

| Setting | Current | Recommended | Status |
|---|---|---|---|
| `strict` | `true` | `true` | ✓ OK |
| `noUnusedLocals` | `true` | `true` | ✓ OK |
| `noUnusedParameters` | `true` | `true` | ✓ OK |
| `target` | `ES2022` | `ES2022`+ | ✓ OK |

### eslint.config.js (flat config)

| Setting | Current | Assessment |
|---|---|---|
| Config format | Flat config (ESLint v9+) | ✓ Modern |
| `@typescript-eslint/no-unsafe-*` | Error | ✓ Strict |
| `@typescript-eslint/no-floating-promises` | Error | ✓ Good |
| `restrict-template-expressions` | Warn (demoted) | Acceptable — pre-existing patterns |
| `no-unnecessary-condition` | Warn (demoted) | Acceptable — pre-existing patterns |

**No config drift found.** All configurations are consistent with modern best practices for the React + Vite + TypeScript + Node.js stack.

---

## License Compliance

**Project license**: MIT

| License | Dependency Count | Notes |
|---|---|---|
| MIT | 465 | ✓ Compatible |
| ISC | 22 | ✓ Compatible |
| Apache-2.0 | 18 | ✓ Compatible |
| BSD-3-Clause | 9 | ✓ Compatible |
| BSD-2-Clause | 8 | ✓ Compatible |
| MPL-2.0 | 12 | ⚠ See below |
| BlueOak-1.0.0 | 4 | ✓ Compatible (permissive) |
| MIT-0 | 2 | ✓ Compatible |
| (MPL-2.0 OR Apache-2.0) | 1 | ✓ Apache-2.0 option is compatible |
| CC-BY-4.0 | 1 | ✓ Data/content only |
| CC0-1.0 | 1 | ✓ Public domain |
| 0BSD | 1 | ✓ Compatible |
| (BSD-2-Clause OR MIT OR Apache-2.0) | 1 | ✓ Compatible |
| (MIT OR WTFPL) | 1 | ✓ Compatible |

**Flagged — MPL-2.0 packages (12 total):**

All 12 are platform-specific binaries for `lightningcss`, which is a build-time CSS processing library used by Tailwind CSS v4's Vite plugin. These packages are not distributed with the application output — they are build toolchain dependencies. MPL-2.0 has a file-level copyleft requirement, but since `lightningcss` is not bundled into the distributed application or modified, **this poses minimal practical risk** for an MIT-licensed project. No legal action is required, but the situation should be noted for legal review if the project is commercialised.

`dompurify` (runtime dependency) is `(MPL-2.0 OR Apache-2.0)` — selecting the Apache-2.0 option makes it fully compatible with MIT.

**No GPL, AGPL, or LGPL dependencies detected.**

---

## Documentation Freshness

### README.md

Scripts documented in README vs actual `package.json`:

| README Command | Actual Script | Status |
|---|---|---|
| `npm install` | — | ✓ OK |
| `npm run dev` | `vite` | ✓ OK |
| `npm run build` | `tsc -b && vite build` | ✓ OK |
| `npm test` | `vitest run` | ✓ OK |
| `npm run test:watch` | `vitest` | ✓ OK |
| `npm run lint` | `eslint .` | ✓ OK |

README is current and matches the project structure.

### docs/ Freshness

| Document | Last Updated | Related Recent Changes | Status |
|---|---|---|---|
| `FEATURES.md` | 2026-04-17 | Updated alongside feature additions | ✓ Fresh |
| `GITHUB-WEBHOOKS-SPEC.md` | 2026-04-17 | Matches webhook hardening commits | ✓ Fresh |
| `PR-REVIEW-WEBHOOK.md` | 2026-04-17 | Matches PR review webhook feature | ✓ Fresh |
| `WORKFLOWS.md` | 2026-04-17 | Matches workflow engine updates | ✓ Fresh |
| `API-REFERENCE.md` | 2026-04-08 | New routes added in input-validation PR (#418, Apr 18) | ⚠ Possibly stale |
| `ORCHESTRATOR-SPEC.md` | 2026-04-04 (est.) | Orchestrator routes split into sub-routers (Apr 15, #415) | ⚠ May lag refactor |
| `SETUP.md` | 2026-04-08 | No structural changes since | ✓ OK |
| `stream-json-protocol.md` | 2026-04-08 | No protocol changes since | ✓ OK |
| `INSTALL-DISTRIBUTION.md` | 2026-04-09 | No install changes since | ✓ OK |
| `CHANGELOG.md` | 2026-04-12 | v0.6.3 release documented | ✓ OK (pre-release period) |

**Stale doc findings:**

1. **`ORCHESTRATOR-SPEC.md`** — `refactor: split orchestrator-routes.ts into focused sub-routers (#415)` on Apr 15 reorganised the orchestrator route architecture. The spec should be verified against the new sub-router layout.
2. **`API-REFERENCE.md`** — The Apr 18 input-validation PR added or hardened routes (`repoPath` and cron expression validation). The reference may not reflect the updated route constraints.

---

## Draft Changelog

### Unreleased (2026-04-13 – 2026-04-18) — since v0.6.3

#### Features
- Add Claude Opus 4.7 to available models (#421)
- Unified `ProcessCoordinator` for session lifecycle management (#404)
- Auto-setup GitHub webhook for PR Review workflows (#391)

#### Fixes
- Prevent JSON injection in `commit-event-hook.sh` (#417)
- Use `realpathSync` to prevent symlink bypass in spawn route (#419)
- Add hard key caps to auth and webhook rate-limiter maps (#418)
- Add `repoPath` and cron expression validation on routes (input-validation PR)
- Harden docs browser root scope and persist canonical paths (#409)
- Prevent spurious session reconfigure when model is first assigned (#407)
- Polish Edit Workflow modal — frequency highlights, day grid, model default (#405)
- Address GPT review feedback on report commit robustness (#400)

#### Refactoring
- Decompose `App.tsx` into focused hooks (#416)
- Split `orchestrator-routes.ts` into focused sub-routers (#415)
- Enforce strict `@typescript-eslint/no-unsafe-*` rules across codebase (#410, #411)

#### Chores
- Remove leftover blank line from debug lifecycle log cleanup (#420)
- Remove lifecycle debug logging added in #406

#### Documentation
- Cleanup docs for Apr 15 audit — PR review, cross-references, roadmap restructure (#414)
- Accumulated audit reports 2026-04-16 through 2026-04-18

---

## Stale Branches

"Stale" threshold: last commit older than 30 days (before 2026-03-20).

**No remote branches meet the 30-day staleness threshold** — the oldest branch (`origin/test/coverage-gaps-apr10`) last committed on 2026-04-10, which is 9 days ago.

However, the following branches are **candidates for cleanup** due to significant divergence from `main` combined with low recent activity:

| Branch | Last Commit | Author | Ahead of main | Behind main | Merged? | Recommendation |
|---|---|---|---|---|---|---|
| `origin/test/coverage-gaps-apr10` | 2026-04-10 | Claude (Webhook) | 2 | 98 | No | Review and close or rebase — 9 days stale, 98 commits behind |
| `origin/feat/connection-status-popup` | 2026-04-11 | alari | 5 | 72 | No | High-conflict risk — see Merge Conflict Forecast; needs rebase or closure |
| `origin/codekin/reports` | 2026-04-18 | alari | 76 | 480 | No | Automated reports branch; 480 commits behind main is critical — investigate purpose |
| `origin/fix/symlink-bypass-spawn` | 2026-04-17 | alari | 0 | — | Yes | Safe to delete — already merged |

All other 16 remote branches are active (last 8 days) and within normal PR lifecycle divergence.

---

## PR Hygiene

All 8 open PRs are automated audit/documentation report PRs. None have been reviewed. All are MERGEABLE.

| PR# | Title | Author | Days Open | Review Status | Conflicts | Stuck? |
|---|---|---|---|---|---|---|
| #422 | docs: add accumulated audit reports (2026-04-16 through 2026-04-18) | alari76 | 1 | None | None | No |
| #413 | docs: weekly repo health report + accumulated audit reports (2026-04-15) | alari76 | 4 | None | None | No |
| #402 | docs: session restart root cause audit | alari76 | 6 | None | None | No |
| #396 | docs: test coverage report 2026-04-13 | alari76 | 6 | None | None | No |
| #395 | docs: repo health report 2026-04-13 | alari76 | 6 | None | None | No |
| #392 | docs: add daily code review report for 2026-04-12 | alari76 | 7 | None | None | **Yes** |
| #390 | docs: PR code review audit (2026-04-12, last 7 merged) | alari76 | 7 | None | None | **Yes** |
| #374 | docs: Add audit report for PR #373 | alari76 | 7 | None | None | **Yes** |

**Observation**: The accumulation of unreviewed docs PRs (8 open, 3 crossing the 7-day stuck threshold) suggests the review/merge cadence for automated report PRs is not keeping up with generation cadence. Consider establishing an auto-merge policy for `docs/audit-*` and `docs/repo-health-*` branches, or batching them more aggressively before opening PRs.

---

## Merge Conflict Forecast

Branches with commits in the last 14 days (after 2026-04-05):

| Branch | Ahead main | Behind main | Files Modified (branch) | Overlap with main? | Risk |
|---|---|---|---|---|---|
| `origin/feat/connection-status-popup` | 5 | 72 | `src/App.tsx`, `src/components/SessionContent.tsx`, `src/hooks/useWsConnection.ts` | **Yes — `src/App.tsx` was refactored into hooks on main (Apr 15, #416)** | **HIGH** |
| `origin/docs/audit-reports-2026-04-18` | 1 | 1 | `.codekin/reports/**` only | No — reports dirs are append-only | LOW |
| `origin/codekin/reports` | 76 | 480 | Unknown (automated reports) | Unknown — 480 commits behind poses broad risk | **HIGH** |
| `origin/feat/repo-health-2026-04-15` | 4 | 15 | Report files | No | LOW |

**High-risk detail — `feat/connection-status-popup`**: This branch modifies `src/App.tsx`, which was significantly decomposed into focused hooks in `refactor/app-decompose-hooks` (#416, merged Apr 15). The branch is 72 commits behind main. A merge attempt is likely to produce substantial conflicts in `App.tsx`.

---

## Recommendations

1. **Merge or close `feat/connection-status-popup`** (HIGH impact) — This branch is 72 commits behind main and modifies `App.tsx`, which has been heavily refactored. Either rebase it against current main immediately, or close it if the feature was absorbed. The longer it waits, the harder the merge becomes.

2. **Investigate and triage `origin/codekin/reports`** (HIGH impact) — This automated branch is 76 commits ahead and 480 commits behind main. It is unclear if this branch is actively used by a workflow or if it is orphaned. If it is the output target of an automated workflow, the workflow should be updated to target `main` or a short-lived branch. If it is orphaned, delete it.

3. **Establish an auto-merge policy for audit/report PRs** (MEDIUM impact) — 8 docs-only PRs are open, 3 of which have crossed the 7-day stuck threshold. Since these contain only append-only `.codekin/reports/` files with no code changes, they are safe for auto-merge. Configure a GitHub Actions workflow to auto-merge PRs matching the `docs/audit-*` or `docs/repo-health-*` pattern when CI passes.

4. **Delete the merged `fix/symlink-bypass-spawn` branch** (LOW effort) — This branch is already merged into main. It can be deleted from the remote with `git push origin --delete fix/symlink-bypass-spawn`.

5. **Close or rebase `test/coverage-gaps-apr10`** (MEDIUM impact) — This branch is 98 commits behind main with only 2 commits of its own. It is likely stale. Check if its changes were incorporated elsewhere; if not, rebase it. If they were, delete the branch.

6. **Update `ORCHESTRATOR-SPEC.md`** (MEDIUM impact) — The Apr 15 refactor split `orchestrator-routes.ts` into sub-routers. The orchestrator spec should be verified and updated to reflect the new module boundaries, so it remains a reliable reference.

7. **Update `API-REFERENCE.md`** (LOW-MEDIUM impact) — The Apr 18 input-validation PR added route-level validation constraints. Verify that the API reference documents the new validation rules and any updated route signatures.

8. **Review MPL-2.0 dependency situation with legal** (LOW risk, informational) — `lightningcss` and its platform binaries (13 packages) are MPL-2.0. They are build-time only and not distributed, so practical risk is low. However, this should be documented in a `NOTICES` file or legal checklist if the project is commercialised or distributed as a product.

9. **Batch open audit PRs before generating new ones** (MEDIUM impact) — The current pattern of one PR per report run creates a long-lived backlog. Consider batching reports across a week into a single PR, or merge existing PRs before generating new ones.

10. **Tag a new release after the recent security fixes** (MEDIUM impact) — Several meaningful security hardening commits have landed since v0.6.3 (Apr 12): symlink bypass prevention, JSON injection fix, rate-limiter caps, input validation. A v0.6.4 or v0.7.0 release tag would make the security posture improvements visible in the version history.
