# Repository Health: codekin

**Date**: 2026-05-01T03:23:11.698Z
**Repository**: /srv/repos/codekin
**Branch**: main
**Workflow Run**: f5d7a9d8-13da-4a12-abf4-9d787c15fc9d
**Session**: 25135866-aa7b-41b6-845a-5dc8efbd8022

---

# Repository Health Report — 2026-05-01

**Project:** Codekin · **Branch:** main · **Assessed by:** automated workflow

---

## Summary

**Overall Health: Good**

The codebase is in solid shape following a concentrated security-hardening sprint. TypeScript configs are strict, there are zero real TODO/FIXME comments in source, and all dependencies use permissive licenses. The primary concerns are a growing backlog of unmerged audit-report and docs PRs (8 open, all stale), four open test-fix PRs that are now superseded, and three unused exports in a single helper file. Workflow documentation has a minor drift gap against recent security fixes.

| Metric | Value |
|---|---|
| Dead code items | 3 unused exports, 0 orphan files |
| TODO/FIXME (source) | 0 |
| Config issues | 2 minor (target inconsistency, ESLint warnings-to-error backlog) |
| License concerns | 2 dependencies with missing license metadata |
| Doc drift items | 1 (WORKFLOWS.md missing restart-resume coverage) |
| Stale branches (>30 days) | 0 |
| Branches 15–21 days inactive | 9 |
| Open PRs | 13 (8 stuck, 3 conflicting) |
| Merge conflict risk | Medium (4 active security branches diverged from main) |

---

## Dead Code

| File | Export / Function | Type | Recommendation |
|---|---|---|---|
| `src/lib/workflowHelpers.ts` | `formatHour` | Unused export | Remove — superseded by inline logic in `TimePicker.tsx` |
| `src/lib/workflowHelpers.ts` | `toTimeValue` | Unused export | Remove — no callers in codebase |
| `src/lib/workflowHelpers.ts` | `fromTimeValue` | Unused export | Remove — no callers in codebase |

No orphan files detected. All components in `src/components/`, hooks in `src/hooks/`, and server modules are imported by at least one consumer. The three unused exports were likely left over from an earlier time-picker refactor; commit `d9cd42e` ("remove three unused exports") removed a prior set but missed these.

---

## TODO/FIXME Tracker

**No actionable TODO/FIXME/HACK/XXX/WORKAROUND comments found in project source files.**

The only matches for `TODO` in non-`node_modules` source files are in test code where `'TODO'` appears as a literal string passed to `summarizeToolInput` in `server/opencode-process.test.ts:557` and `server/claude-process.test.ts:60–61,809` — these are test-value strings, not action items.

| Summary | Count |
|---|---|
| Total actionable items | 0 |
| Stale items (>30 days) | 0 |

---

## Config Drift

### TypeScript

| Config File | Setting | Current Value | Note |
|---|---|---|---|
| `server/tsconfig.json` | `target` | `ES2022` | App targets `ES2023`; minor inconsistency — Node.js on the server supports ES2023 fully |
| `tsconfig.app.json` | `target` | `ES2023` | ✓ Consistent with `lib: ["ES2023", "DOM"]` |
| `tsconfig.app.json` | `strict` | `true` | ✓ |
| `tsconfig.app.json` | `noUnusedLocals` / `noUnusedParameters` | `true` | ✓ |
| `server/tsconfig.json` | `strict` | `true` | ✓ |
| `server/tsconfig.json` | `noUnusedLocals` / `noUnusedParameters` | `true` | ✓ |
| `server/tsconfig.json` | `isolatedModules` | `true` | ✓ Good for build correctness |

**Finding:** `server/tsconfig.json` targets `ES2022` while both frontend configs target `ES2023`. The server runs on Node.js 20+, which fully supports ES2023. Consider aligning to `ES2023` for consistency.

### ESLint

| Finding | Detail | Recommendation |
|---|---|---|
| Several rules demoted to `warn` | `restrict-template-expressions`, `no-confusing-void-expression`, `no-unnecessary-condition`, `no-base-to-string`, `no-non-null-assertion`, `no-misused-promises`, `use-unknown-in-catch-callback-variable`, `require-await` | The ESLint config itself acknowledges these should be promoted to `error` — track this as incremental tech debt |
| No Prettier config present | No `.prettierrc` or `prettier.config.*` found | Not necessarily a problem for this codebase, but inconsistent formatting across contributors is a risk |
| Test files use `tseslint.configs.recommended` | Production files use `strictTypeChecked` | Consider `recommendedTypeChecked` for test files to catch more issues without the full strict overhead |

### Summary

Config is substantially well-configured. The `warn`-level ESLint rules are a known backlog item (acknowledged in the config inline comment). The `ES2022`/`ES2023` mismatch is cosmetic but worth a one-line fix.

---

## License Compliance

Project license: **MIT**

### License Distribution (direct + transitive dependencies)

| License | Count |
|---|---|
| MIT | 450 |
| ISC | 19 |
| Apache-2.0 | 17 |
| MPL-2.0 | 12 |
| BSD-3-Clause | 9 |
| BSD-2-Clause | 8 |
| MIT-0 | 2 |
| (MPL-2.0 OR Apache-2.0) | 1 |
| (MIT OR WTFPL) | 1 |
| (BSD-2-Clause OR MIT OR Apache-2.0) | 1 |
| CC-BY-4.0 | 1 |
| CC0-1.0 | 1 |
| BlueOak-1.0.0 | 1 |
| 0BSD | 1 |
| **UNKNOWN / missing** | **2** |

### Flagged Dependencies

| Package | Version | Issue |
|---|---|---|
| `busboy` | 1.6.0 | License field absent from `package-lock.json` record. `busboy` is MIT-licensed upstream — verify by checking the installed `node_modules/busboy/LICENSE` file. |
| `streamsearch` | 1.1.0 | License field absent. Dependency of `busboy`; also MIT upstream. |

**No GPL, LGPL, or AGPL dependencies detected.** MPL-2.0 packages (`lightningcss` et al.) are build-time only and excluded from distributed artifacts, as noted in `package.json#licenseNotes`. The `dompurify` dual-license `(MPL-2.0 OR Apache-2.0)` is permissively compatible with MIT.

**Action:** Confirm `busboy` and `streamsearch` are MIT by inspecting the installed package files or adding explicit license annotations to the lock file.

---

## Documentation Freshness

### API Docs

| Document | Last Updated | Recent Code Changes | Status |
|---|---|---|---|
| `docs/API-REFERENCE.md` | 2026-04-28 | `workflow-routes.ts` changed 2026-04-30 (cron DoS fix, W1 step=0 rejection) | Minor drift: W1 cron-step=0 rejection is not explicitly documented |
| `docs/FEATURES.md` | 2026-04-26 | No significant API changes after that date | ✓ Current |
| `docs/WORKFLOWS.md` | 2026-04-15 | `workflow-engine.ts` changed significantly (restart-resume, #437, 2026-04-25) | **Drift**: restart-resume and orphan session handling added in `workflow-engine.ts` but `WORKFLOWS.md` body does not document this behaviour |
| `docs/operations/workflow-resilience.md` | 2026-04-27 | — | ✓ Created alongside the feature; covers the ops detail |
| `docs/operations/ws-rate-limit.md` | 2026-04-27 | — | ✓ Current |
| `docs/GITHUB-WEBHOOKS-SPEC.md` | Updated 2026-04-15+ | No major changes | ✓ Current |

### README Drift

The README is accurate. All commands listed match `package.json`:

| README Command | package.json Script | Match? |
|---|---|---|
| `npm run dev` | `"dev": "vite"` | ✓ |
| `npm run build` | `"build": "tsc -b && vite build"` | ✓ |
| `npm test` | `"test": "vitest run"` | ✓ |
| `npm run test:watch` | `"test:watch": "vitest"` | ✓ |
| `npm run lint` | `"lint": "eslint ."` | ✓ |

**CONTRIBUTING.md:** The guide instructs `npm install --prefix server` as a separate step. `server/package.json` exists, so this instruction is valid.

### Findings Summary

1. **`docs/WORKFLOWS.md` is 16 days behind code**: The restart-resume feature and orphan session handling added in `workflow-engine.ts` (PR #437, merged 2026-04-25) are covered in `docs/operations/workflow-resilience.md` but not mentioned in the main `WORKFLOWS.md` document. Users reading only `WORKFLOWS.md` will not know the engine auto-resumes interrupted runs.
2. **`docs/API-REFERENCE.md` cron validation**: The W1 security fix (reject cron `step=0`, PR #449) added a new 400 error path. The API docs describe cron validation generally but do not specify that `step=0` is rejected. Minor gap.

---

## Draft Changelog

### Changes since v0.6.4 (2026-04-27 → 2026-05-01)

#### Security Fixes
- Sanitize `repoPath` in commit-event handler and validate `permissionMode` before applying in WS message handler (`fix(security)` #454)
- Canonicalize clone destination path to prevent symlink escape attacks — `realpathSync` guard on upload-routes (`fix(security)` #453)
- Validate `permissionMode` at runtime on session creation; reject unknown values with 400 (`fix(security)` #452)
- Harden workflow and cron routes: reject cron `step=0` (DoS vector), prevent path traversal in workflow `repoPath`, fix dedup scoping, validate PATCH body (`fix(security)` #449)

#### Chores
- Repo-health cleanup: remove orphaned `dist/` artifacts, prune stale WS docs, align tsconfig (`chore` #451)
- Bump `marked` from 17 to 18.0.2 (`chore(deps)` #450)
- Bump `@multiplier-labs/stepflow` to 0.3.4 (`chore(deps)` #445)

#### Tests
- Fix `isWorkflowReportsBranch` export missing from `workflow-loader` mock used in commit-event-handler tests (`fix(test)` #448)

---

## Stale Branches

No branches exceed **30 days** of inactivity as of 2026-05-01. The following branches are **15–21 days** inactive and have corresponding open (unmerged) PRs:

| Branch | Last Commit | Author | Days Inactive | Merged? | Open PR | Recommendation |
|---|---|---|---|---|---|---|
| `test/coverage-gaps-apr10` | 2026-04-10 | Claude (Webhook) | 21 | No | #396? | Review and merge or close |
| `feat/connection-status-popup` | 2026-04-11 | alari | 20 | No | None found | Review — no open PR; consider closing |
| `feat/pr-373-audit-report` | 2026-04-12 | alari | 19 | No | #374 | Merge or close |
| `chore/pr-audit-2026-04-12` | 2026-04-12 | alari | 19 | No | #390 | Merge or close |
| `feat/daily-code-review-2026-04-12` | 2026-04-12 | alari | 19 | No | #392 | Merge or close |
| `feat/repo-health-2026-04-13` | 2026-04-13 | alari | 18 | No | #395 | Merge or close |
| `feat/test-coverage-2026-04-13` | 2026-04-13 | alari | 18 | No | #396 | Merge or close |
| `docs/session-restart-audit` | 2026-04-15 | alari | 16 | No | #402 | Merge or close |
| `feat/repo-health-2026-04-15` | 2026-04-16 | alari | 15 | No | #413 | Merge or close |

Additionally, several audit-report branches created by the automated workflow system (e.g. `audit/code-review.daily-2026-04-30`, `audit/repo-health.weekly-2026-04-29`) are 41–42 commits ahead of the branch point but **46 commits behind `main`**. These represent accumulated report files not yet merged.

---

## PR Hygiene

| PR # | Title | Author | Days Open | Review Status | Conflicts? | Stuck? |
|---|---|---|---|---|---|---|
| #447 | fix(test): add isWorkflowReportsBranch to commit-event-handler mock | alari76 | 3 | None | No | No |
| #446 | fix(test): add isWorkflowReportsBranch to commit-event-handler mock | alari76 | 3 | None | No | No — duplicate of #447 |
| #444 | chore: release 0.6.4 | alari76 | 3 | None | **Yes** | No — likely superseded |
| #443 | fix(tests): resolve CI lint errors + stale workflow-loader mock | alari76 | 3 | None | No | No |
| #442 | fix(ci): unblock lint + repair commit-event-handler test mock | alari76 | 3 | None | **Yes** | No — likely superseded |
| #422 | docs: add accumulated audit reports (2026-04-16 through 2026-04-18) | alari76 | 12 | None | **Yes** | **Yes** |
| #413 | docs: weekly repo health report + accumulated audit reports (2026-04-15) | alari76 | 15 | None | No | **Yes** |
| #402 | docs: session restart root cause audit | alari76 | 17 | None | No | **Yes** |
| #396 | docs: test coverage report 2026-04-13 | alari76 | 17 | None | No | **Yes** |
| #395 | docs: repo health report 2026-04-13 | alari76 | 18 | None | No | **Yes** |
| #392 | docs: add daily code review report for 2026-04-12 | alari76 | 18 | None | No | **Yes** |
| #390 | docs: PR code review audit (2026-04-12, last 7 merged) | alari76 | 18 | None | No | **Yes** |
| #374 | docs: Add audit report for PR #373 | alari76 | 18 | None | No | **Yes** |

**Notes:**
- PRs #446 and #442 appear to be duplicates / superseded versions of #447 and #443 respectively. They should be closed.
- PR #444 ("release 0.6.4") is conflicting and may be stale since the tag was already applied.
- The 8 docs/audit PRs (#374, #390, #392, #395, #396, #402, #413, #422) have been open 12–18 days with no review. These represent an accumulation pattern from the automated workflow system and should be batch-merged or the workflow adjusted to auto-merge report PRs.

---

## Merge Conflict Forecast

Active branches with commits in the last 14 days, showing divergence from `main`:

| Branch | Commits Ahead | Commits Behind | Files Modified | Overlap with Recent Main Changes | Risk |
|---|---|---|---|---|---|
| `fix/security-validation-followup-2026-04-30` | 4 | 2 | `workflow-routes.ts`, `ws-message-handler.ts`, `server/package.json`, `workflows/package.json` | `workflow-routes.ts` and `ws-message-handler.ts` were modified in the commits that are "ahead" of this branch | **Medium** |
| `fix/security-validation-2026-04-30` | 1 | 3 | `session-routes.ts`, `ws-message-handler.ts` | `ws-message-handler.ts` touched in both branch and main | **Medium** |
| `fix/security-clone-symlink-escape-2026-04-30` | 1 | 2 | `upload-routes.ts` | `upload-routes.ts` was changed on main (W4 fix); this branch adds an additional guard | **Medium** |
| `fix/security-commit-event-sanitization-2026-04-30` | 1 | 0 | `commit-event-handler.ts`, `workflow-loader.ts` | 0 behind main — cleanest of the four | **Low** |
| `audit/code-review.daily-2026-04-30` | 42 | 46 | Report `.md` files only | No source file overlap | **Low** (report files only) |
| `audit/security-audit.weekly-2026-04-30` | 42 | 46 | Report `.md` files only | No source file overlap | **Low** (report files only) |
| `docs/audit-reports-2026-04-18` | 41 | 46 | Report `.md` files only | No source file overlap | **Low** (report files only) |

The three security fix branches (`security-validation-followup`, `security-validation`, `security-clone-symlink-escape`) all touch files that were recently changed by merged security PRs. They should be rebased onto `main` before merging to avoid conflicts and ensure security fixes don't inadvertently revert one another.

---

## Recommendations

1. **Close or merge the 8 stale audit/docs PRs (#374, #390, #392, #395, #396, #402, #413, #422).** These have been open 12–18 days with no review. The report files are valid; either batch-merge them in a single commit or automate the workflow to push directly on a dedicated long-lived reports branch. This is the single largest contributor to PR queue noise.

2. **Close duplicate PRs #446 and #442.** Both are superseded by #447 and #443 respectively. PR #444 (release 0.6.4) is conflicting and should be either rebased or closed if the release tag was already applied.

3. **Rebase the three medium-risk security fix branches** (`fix/security-validation-followup`, `fix/security-validation`, `fix/security-clone-symlink-escape`) onto `main` before merging. All three are 2–3 commits behind main and touch files that were recently modified by security fixes; a rebase will surface any conflicts early.

4. **Remove the 3 unused exports from `src/lib/workflowHelpers.ts`** (`formatHour`, `toTimeValue`, `fromTimeValue`). These are dead code and will be caught by `noUnusedLocals` if the file is ever imported more broadly.

5. **Update `docs/WORKFLOWS.md` to mention restart-resume and orphan session handling.** The feature was added in PR #437 (2026-04-25) and is fully documented in `docs/operations/workflow-resilience.md`, but the primary `WORKFLOWS.md` entry point does not link to or summarise this behaviour.

6. **Verify `busboy` and `streamsearch` licenses.** Both are MIT upstream, but their license fields are absent from `package-lock.json`. A one-line `license: "MIT"` in the lock entries (or a note in `package.json#licenseNotes`) would satisfy any future SBOM or compliance tooling.

7. **Promote ESLint warning-level rules to errors incrementally.** The ESLint config notes this explicitly. Starting with `@typescript-eslint/no-misused-promises` (easiest to fix) and `@typescript-eslint/use-unknown-in-catch-callback-variable` would meaningfully improve type safety without a large code churn.

8. **Align `server/tsconfig.json` target to `ES2023`** (currently `ES2022`, app and node configs both use `ES2023`). A one-line change; reduces inconsistency for contributors reading configs.

9. **Document the cron `step=0` rejection in `docs/API-REFERENCE.md`.** The W1 security fix (PR #449) added a 400 error for `step=0` in cron expressions. The API reference documents cron validation generally but does not call this out specifically.

10. **Consider auto-merging or auto-closing audit report PRs.** The accumulation of 8+ unmerged audit report PRs is a recurring pattern (previous audits flagged the same issue). The workflow could be configured to push reports directly to `main` on a dedicated reports-only commit path rather than opening PRs, reducing permanent PR queue bloat.Committed and pushed both report files on branch `audit/repo-health.weekly-2026-05-01`. PR #456 opened: https://github.com/Multiplier-Labs/codekin/pull/456