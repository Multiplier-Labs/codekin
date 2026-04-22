# Repository Health: codekin

**Date**: 2026-04-22T03:22:13.227Z
**Repository**: /srv/repos/codekin
**Branch**: docs/audit-reports-2026-04-18
**Workflow Run**: b4b91420-393b-4e2b-89db-7903f6eaf4a0
**Session**: c1a5c061-99a8-4011-ae02-b280cfdafb83

---

I'll start the comprehensive repo health assessment by exploring the codebase in parallel.Now I have all the data I need. Let me write the report to the file.# Repository Health Report — 2026-04-22

**Repository:** codekin  
**Branch assessed:** `docs/audit-reports-2026-04-18`  
**Reference branch:** `main` (v0.6.3)  
**Date:** 2026-04-22  

---

## Summary

**Overall health: Good**

The repository is actively maintained with strong TypeScript discipline (strict mode throughout, zero lint suppressions in production code). The main areas requiring attention are an accumulation of unreviewed doc/audit PRs, one branch with extreme divergence (`codekin/reports`, 84 commits ahead / 485 behind), one merged branch not yet deleted, and minor documentation drift in `docs/API-REFERENCE.md` and `CONTRIBUTING.md`.

| Category | Finding |
|---|---|
| Dead code items | 0 significant |
| Stale TODOs/FIXMEs | **0** (clean) |
| Config issues | 2 minor (ESLint warning promotions overdue; CONTRIBUTING/CLAUDE.md script mismatch) |
| License concerns | 1 flagged (lightningcss MPL-2.0 indirect dep) |
| Doc drift items | 3 (API reference, ORCHESTRATOR-SPEC.md, CONTRIBUTING.md) |
| Stale branches (>30 days) | 0 |
| Merged but undeleted branches | 1 (`fix/symlink-bypass-spawn`) |
| Open PRs | 9 |
| Stuck PRs (>7 days, no review) | 7 |

---

## Dead Code

No orphan files, unreachable functions, or unused exports were identified through static analysis. The TypeScript configuration enforces `noUnusedLocals: true` and `noUnusedParameters: true` across all three tsconfig targets (app, node, server), which would surface most issues at build time. All React hooks in `src/hooks/` are imported in at least one production component. All server modules are transitively reachable from the main entry point.

| File | Export/Symbol | Type | Recommendation |
|---|---|---|---|
| — | — | — | No dead code detected |

---

## TODO/FIXME Tracker

A full scan of `src/` and `server/` for `TODO`, `FIXME`, `HACK`, `XXX`, and `WORKAROUND` found **zero matches** in production source files. The only occurrences are in test files, where the string `"TODO"` appears as a literal pattern argument to mock Grep tool calls (e.g., `server/claude-process.test.ts:60`).

| File:Line | Type | Comment | Author | Date | Stale? |
|---|---|---|---|---|---|
| — | — | No items found | — | — | — |

**Summary:** Total=0, Stale=0. The codebase is free of technical debt markers.

---

## Config Drift

### `tsconfig.app.json` / `tsconfig.node.json` / `server/tsconfig.json`

All three TypeScript configurations are well-aligned with modern best practices:

| Setting | All Three Configs | Assessment |
|---|---|---|
| `strict: true` | ✅ | Correct |
| `noUnusedLocals` | ✅ | Correct |
| `noUnusedParameters` | ✅ | Correct |
| `noFallthroughCasesInSwitch` | ✅ | Correct |
| `noUncheckedSideEffectImports` | ✅ (app, node, server) | Best practice |
| `skipLibCheck` | ✅ | Acceptable for monorepo |
| `erasableSyntaxOnly` | ✅ (app, node only) | Correct for bundler mode |

No drift found. Minor observation: `tsconfig.node.json` includes only `vite.config.ts` (not the server) — this is intentional; the server has its own tsconfig.

### `eslint.config.js`

The project uses `typescript-eslint` with `strictTypeChecked`, which is the recommended configuration. Several rules are intentionally demoted from `error` to `warn` to support incremental adoption — this is explicitly documented in the config. However, these have been in the `warn` state since at least April 5 and should be scheduled for promotion:

| Rule | Current | Recommended | Notes |
|---|---|---|---|
| `@typescript-eslint/no-non-null-assertion` | `warn` | `error` | Demoted as pre-existing pattern |
| `@typescript-eslint/no-unnecessary-condition` | `warn` | `error` | Demoted as pre-existing pattern |
| `@typescript-eslint/no-confusing-void-expression` | `warn` | `error` | Demoted as pre-existing pattern |
| `@typescript-eslint/no-base-to-string` | `warn` | `error` | Demoted as pre-existing pattern |
| `@typescript-eslint/no-misused-promises` | `warn` | `error` | High-risk rule, should be error |
| `@typescript-eslint/require-await` | `warn` | `error` | Demoted as pre-existing pattern |

The test file block disables `no-explicit-any`, which is appropriate for test contexts.

---

## License Compliance

The project is MIT-licensed. Dependency license summary:

| License | Count | Notes |
|---|---|---|
| MIT | 465 | Permissive — no concern |
| ISC | 22 | Permissive — no concern |
| Apache-2.0 | 18 | Permissive — no concern |
| BSD-3-Clause | 9 | Permissive — no concern |
| BSD-2-Clause | 8 | Permissive — no concern |
| MPL-2.0 | 12 | Weak copyleft — flagged below |
| BlueOak-1.0.0 | 4 | Permissive — no concern |
| (BSD-2-Clause OR MIT OR Apache-2.0) | 1 | Permissive — no concern |
| (MIT OR WTFPL) | 1 | Permissive — no concern |
| (MPL-2.0 OR Apache-2.0) | 1 | Can be used as Apache-2.0 — no concern |
| CC-BY-4.0 | 1 | Data license (`caniuse-lite`) — no concern |
| 0BSD | 2 | Permissive — no concern |
| MIT-0 | 2 | Permissive — no concern |
| CC0-1.0 | 1 | Public domain — no concern |
| unknown | 2 | Flagged below |

**Flagged dependencies:**

| Package | License | Risk | Notes |
|---|---|---|---|
| `lightningcss` + 12 platform variants | MPL-2.0 | Low | Indirect dep via `tailwindcss`/`@tailwindcss/vite`. MPL-2.0 is file-level copyleft; compiled CSS output is not affected. Standard practice for web toolchains. |
| `busboy` | unknown | Low | HTTP multipart parser (indirect via `multer`/`express`). Likely MIT; license field missing in lock file. No concern in practice. |
| `streamsearch` | unknown | Low | String search utility (indirect via `busboy`). No concern in practice. |

**Overall assessment:** No GPL/LGPL/AGPL dependencies. The MPL-2.0 `lightningcss` packages are build-time tooling with no copyleft impact on the compiled output. No action required.

---

## Documentation Freshness

### API Docs

`docs/API-REFERENCE.md` was last updated **2026-04-08** (14 days ago). In the 14 days since, the following route files changed on `main`:

- `server/auth-routes.ts`
- `server/docs-routes.ts`
- `server/orchestrator-routes.ts` (refactored into 4 sub-routers on 2026-04-15, PR #415)
- `server/session-routes.ts`
- `server/upload-routes.ts`
- `server/webhook-setup-routes.ts`
- `server/workflow-routes.ts`

The orchestrator route refactor (#415) is the most significant: `orchestrator-routes.ts` was split into `orchestrator-session-router.ts`, `orchestrator-learning-router.ts`, `orchestrator-memory-router.ts`, and `orchestrator-reports.ts`. The API reference may have stale endpoint paths or missing coverage for any newly added routes in these files.

Additionally, the new `claude-opus-4-7` model added in commit `8bbfbcd` (#421, 2026-04-17) should be reflected in the API reference's model enumeration if it is documented there.

### README Drift

| Section | README Says | Actual State | Drift? |
|---|---|---|---|
| Install one-liner | `curl -fsSL codekin.ai/install.sh \| bash` | `install.sh` exists in repo root | No drift |
| CLI commands (`codekin token`, `codekin config`, etc.) | Listed correctly | Match `bin/` implementation | No drift |
| Configuration table (`PORT`, `REPOS_ROOT`) | Shown | Match `server/config.ts` | No drift |
| Development scripts | Not listed in README (lives in CLAUDE.md) | `npm run dev`, `build`, `test`, `test:watch`, `lint`, `preview` | No drift |
| Features list | Extensive, last updated 2026-04-11 | Includes OpenCode, Opus 4.7, PR webhooks | Current |

README is in good shape. Minor: `npm run preview` (Vite preview server) is not mentioned in CLAUDE.md's script list, but this is a minor omission.

### CONTRIBUTING.md Drift

`CONTRIBUTING.md` instructs developers to run `npm install --prefix server` as a separate step after `npm install`. `CLAUDE.md` only lists `npm install`. The server does have its own `package.json` and `node_modules/`, so the CONTRIBUTING.md instruction is technically correct — but the discrepancy is confusing and should be harmonised.

### ORCHESTRATOR-SPEC.md

Last updated **2026-03-16** (37 days ago). All phases are shipped; the spec is now a post-ship reference. However, the major orchestrator refactor in PR #415 (split into sub-routers) and the `ProcessCoordinator` unification (PR #404) represent structural changes not reflected in the spec. The spec section on internal session management and API routing paths may be inaccurate.

---

## Draft Changelog

Changes since `v0.6.3` tag (2026-04-12) through 2026-04-22:

### [Unreleased] — since v0.6.3

#### Features
- Add Claude Opus 4.7 (`claude-opus-4-7`) to available models (#421)

#### Fixes
- Add hard key caps to auth and webhook rate-limiter maps to prevent memory exhaustion (#418)
- Prevent JSON injection in `commit-event-hook.sh` via proper escaping (#417)
- Use `realpathSync` to prevent symlink bypass in spawn route (security hardening, #419)

#### Refactoring
- Decompose `App.tsx` into focused hooks for improved maintainability (#416)
- Split `orchestrator-routes.ts` into four focused sub-routers: session, learning, memory, reports (#415)

#### Documentation
- Cleanup docs for Apr 15 audit: PR review cross-references, roadmap restructure (#414)
- Accumulated audit reports: repo health, code review, test coverage, dependency health, docs audit (2026-04-15 through 2026-04-22)

#### Chores
- Remove leftover blank line from debug lifecycle log cleanup (#420)

---

## Stale Branches

No remote branches have last-commit dates older than 30 days (as of 2026-04-22). The oldest active branch is `test/coverage-gaps-apr10` (2026-04-10, 12 days ago).

**Merged but undeleted branches:**

| Branch | Last Commit | Author | Merged into main? | Recommendation |
|---|---|---|---|---|
| `origin/fix/symlink-bypass-spawn` | 2026-04-17 | alari | Yes (PR #419) | **Delete** — already merged |

**Notable outlier — `origin/codekin/reports`:**
This branch is 84 commits ahead and 485 commits behind `main`. It appears to be a long-running shadow branch tracking automated report commits outside the normal PR flow. Unless intentional, this branch creates risk of extreme divergence and should be reviewed for either archival or formal merging via PRs.

| Branch | Last Commit | Last Author | Merged? | Ahead/Behind main | Recommendation |
|---|---|---|---|---|---|
| `origin/fix/symlink-bypass-spawn` | 2026-04-17 | alari | Yes | +1/0 | Delete |
| `origin/codekin/reports` | 2026-04-22 | alari | No | +84 / −485 | Review & archive or continue via PRs |
| All other branches | 2026-04-10 to 2026-04-22 | alari | No | Small divergence | No action (active work) |

---

## PR Hygiene

All 9 open PRs are documentation/audit report PRs authored by `alari76`. None have received review activity. The pattern appears to be automated audit reports opened as PRs and awaiting periodic batch-merge by the owner.

| PR# | Title | Author | Age (days) | Review Status | Conflicts | Stuck (>7d)? |
|---|---|---|---|---|---|---|
| #429 | docs: address 2026-04-22 docs-audit findings | alari76 | 0 | None | No | No |
| #422 | docs: add accumulated audit reports (2026-04-16 through 2026-04-18) | alari76 | 4 | None | No | No |
| #413 | docs: weekly repo health report + accumulated audit reports (2026-04-15) | alari76 | 7 | None | Unknown | Borderline |
| #402 | docs: session restart root cause audit | alari76 | 9 | None | Unknown | **Yes** |
| #396 | docs: test coverage report 2026-04-13 | alari76 | 9 | None | Unknown | **Yes** |
| #395 | docs: repo health report 2026-04-13 | alari76 | 9 | None | Unknown | **Yes** |
| #392 | docs: add daily code review report for 2026-04-12 | alari76 | 10 | None | Unknown | **Yes** |
| #390 | docs: PR code review audit (2026-04-12, last 7 merged) | alari76 | 10 | None | Unknown | **Yes** |
| #374 | docs: Add audit report for PR #373 | alari76 | 10 | None | Unknown | **Yes** |

**Note:** All 7 stuck PRs are doc-only changes with no code impact. The lack of review is expected for a single-maintainer workflow. The backlog of 9 open doc PRs is an accumulation pattern that warrants periodic batch-merge sessions.

---

## Merge Conflict Forecast

Active branches (commits in the last 14 days) with divergence from `main`:

| Branch | Commits Ahead | Commits Behind | Files Modified (vs main) | Overlapping w/ Other Active Branches | Risk |
|---|---|---|---|---|---|
| `docs/audit-reports-2026-04-18` | 7 | 6 | `.codekin/reports/**` (audit reports only) | None | Low |
| `docs/audit-2026-04-22-updates` | 1 | 0 | Unknown (docs) | None | Low |
| `chore/bump-dompurify-better-sqlite3` | 1 | 5 | `package.json`, `package-lock.json` | None with source changes | Low |
| `fix/nested-reports-path-csp-and-api-docs` | 1 | 5 | `docs/API-REFERENCE.md`, `server/orchestrator-reports.ts`, `server/ws-server.ts` | `test/coverage-critical-routes` touches `server/session-routes.test.ts` | Low |
| `test/coverage-critical-routes` | 2 | 1 | `server/auth-routes.test.ts`, `server/docs-routes.test.ts`, `server/session-routes.test.ts` | `fix/repos-path-tilde-and-owner-namespace` touches `server/session-routes.ts` | **Medium** |
| `fix/repos-path-tilde-and-owner-namespace` | 1 | 4 | `server/session-routes.ts`, `server/session-routes.test.ts`, `server/upload-routes.ts`, `server/upload-routes.test.ts` | `test/coverage-critical-routes` (shared file: `server/session-routes.test.ts`) | **Medium** |
| `test/coverage-workflow-routes-and-commit-hooks` | 1 | 5 | Workflow/commit test files | None | Low |
| `fix/input-validation-2026-04-18` | 1 | 6 | Unknown | None | Low |
| `chore/remove-debug-lifecycle-logs` | 1 | 12 | Debug log removal | None | Low |
| `fix/json-injection-hook` | 1 | 12 | Commit hook script | None | Low |
| `fix/rate-limiter-map-caps` | 1 | 12 | Rate limiter | None | Low |
| `feat/add-opus-4-7` | 1 | 7 | Model list | None | Low |
| `codekin/reports` | 84 | 485 | Unknown (reports) | Many — extreme divergence | **High** |

**High-risk:** `origin/codekin/reports` is 485 commits behind `main` and 84 ahead. Any attempt to merge this branch would require resolving 485 commits of divergence. This branch should be assessed immediately.

**Medium-risk overlap:** `test/coverage-critical-routes` and `fix/repos-path-tilde-and-owner-namespace` both modify `server/session-routes.test.ts`. Whichever merges second will need to incorporate the other's changes manually.

---

## Recommendations

1. **Merge or archive `origin/codekin/reports`** — This branch is 485 commits behind main and growing. If it contains valuable automated reports, they should be cherry-picked onto the current branch or routed through normal audit-report PRs. Left unattended, it will never be mergeable.

2. **Batch-merge the 7 stuck doc PRs** (#374, #390, #392, #395, #396, #402, #413) — These are low-risk documentation-only PRs open for 9–10 days. A single merge session would clear the backlog and reduce noise in the PR list.

3. **Delete `origin/fix/symlink-bypass-spawn`** — This branch was merged (PR #419) and its remote tracking ref should be deleted: `git push origin --delete fix/symlink-bypass-spawn`.

4. **Update `docs/API-REFERENCE.md`** — The reference is 14 days stale relative to the orchestrator route refactor (PR #415) and the new Opus 4.7 model (PR #421). A focused update covering route path changes and the new model should be prioritised before the next release.

5. **Update `docs/ORCHESTRATOR-SPEC.md`** — The spec is 37 days old and the orchestrator underwent significant structural changes (ProcessCoordinator unification, sub-router split). Update or deprecate in favour of a leaner reference pointing to the current source structure.

6. **Harmonise install instructions** — `CONTRIBUTING.md` references `npm install --prefix server` as a separate step, but `CLAUDE.md` lists only `npm install`. Either unify both repos' deps or clarify in both files.

7. **Resolve the `server/session-routes.test.ts` overlap** — `test/coverage-critical-routes` and `fix/repos-path-tilde-and-owner-namespace` both touch this file. Merge one before the other to avoid a conflict.

8. **Promote ESLint warnings to errors** — Six rules remain at `warn` level (including `no-non-null-assertion` and `no-misused-promises`) per the incremental adoption note. Schedule a clean-up pass to promote them to `error` — the codebase is clean enough for this now.

9. **Consider a `CODEOWNERS` file** — With 9 open PRs all by the sole maintainer and zero reviewer assignments, a `CODEOWNERS` file would formalise the review process and ensure PRs do not linger silently.

10. **Tag `v0.6.4`** — Multiple fixes and the Opus 4.7 feature have shipped since `v0.6.3` (2026-04-12). A release tag would mark the security hardening fixes (symlink bypass, JSON injection, rate limiter caps) and keep the changelog and npm version aligned.Committed and pushed both reports to `docs/audit-reports-2026-04-18`.