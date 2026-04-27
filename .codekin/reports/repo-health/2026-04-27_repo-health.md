# Repository Health Report — 2026-04-27

**Repository**: codekin  
**Branch at assessment time**: docs/audit-reports-2026-04-18  
**Main branch HEAD**: cb6d717 (feat: workflow engine restart resume + orphan session handling #437)  
**Assessment date**: 2026-04-27

---

## Summary

**Overall health: Good**

The codebase is in sound shape. TypeScript strict mode is enforced project-wide, license compliance is clean, and there are no TODO/FIXME comments anywhere in production code. Active development velocity is high (14 commits merged to main in 7 days). The primary concerns are: one orphan test file with no corresponding source module; a growing backlog of 8 unreviewed documentation-only PRs (all stuck >7 days); several short-lived branches that are unmerged but were not deleted after their PR was merged; and one newly added feature (`ws-rate-limit.ts`) whose deployment-facing behavior is not yet reflected in docs.

| Category | Status | Count |
|---|---|---|
| Dead code items | 1 orphan test file | 1 |
| Stale TODOs | None | 0 |
| Config issues | Minor (ESLint warn-demotions tracked) | 2 |
| License concerns | None | 0 |
| Doc drift items | 1 (ws-rate-limit undocumented) | 1 |
| Stale branches (>30 days) | None | 0 |
| Aging unmerged branches (14-17 days) | Likely already merged, not deleted | ~8 |
| Stuck PRs (>7 days, no review) | All open PRs | 8 |

---

## Dead Code

### Orphan Files

| File | Type | Finding | Recommendation |
|---|---|---|---|
| `server/provider-dispatch.test.ts` | Orphan test file | No corresponding `provider-dispatch.ts` exists. The test file references session-persistence and session-manager internals. The module was likely absorbed into session-manager during a refactor, but the test file was not removed or updated. | Delete or migrate tests into `session-manager.test.ts` |

### Unused Export Patterns

| File | Export | Type | Note |
|---|---|---|---|
| `server/webhook-github-setup.ts` | `_setGhRunner`, `_resetGhRunner` | Test-injection helpers | Exported for use in tests only; naming convention (`_` prefix) signals intent. Acceptable pattern; not true dead code. |
| `server/webhook-pr-github.ts` | `_setGhRunner`, `_resetGhRunner` | Test-injection helpers | Same pattern as above. |
| `server/webhook-github.ts` | `_setGhRunner` | Test-injection helper | Same pattern as above. |

No other unused exports found. All frontend components, hooks, and utility functions are imported by at least one consumer. PR #434 (`d9cd42e`, 2026-04-26) already cleaned up three previously identified unused exports from this branch.

---

## TODO/FIXME Tracker

A full scan (`TODO`, `FIXME`, `HACK`, `XXX`, `WORKAROUND`) across all source files (excluding `node_modules`, `dist`, `.git`, worktrees) returned **zero results** in production code. The only occurrences of "TODO" in the codebase are literal pattern strings in test assertions (`{ pattern: 'TODO' }` in claude-process and opencode-process tests), not comments.

**Summary**: 0 TODOs, 0 FIXMEs, 0 stale items.

---

## Config Drift

### `tsconfig.app.json` (frontend)

| Setting | Current Value | Notes |
|---|---|---|
| `strict` | `true` | ✓ Correct |
| `noUnusedLocals` | `true` | ✓ Correct |
| `noUnusedParameters` | `true` | ✓ Correct |
| `target` | `ES2022` | Appropriate for modern browser targets |
| `moduleResolution` | `bundler` | ✓ Correct for Vite |
| `noUncheckedSideEffectImports` | `true` | ✓ Modern best practice |

### `tsconfig.node.json` (vite config)

| Setting | Current Value | Notes |
|---|---|---|
| `target` | `ES2023` | One minor version ahead of `tsconfig.app.json` (`ES2022`). Harmless since each targets its runtime; worth aligning for readability. |
| `strict` | `true` | ✓ Correct |

### `server/tsconfig.json`

| Setting | Current Value | Notes |
|---|---|---|
| `module` / `moduleResolution` | `NodeNext` / `NodeNext` | ✓ Correct for Node.js ESM |
| `strict` | `true` | ✓ Correct |
| `composite` | `true` | ✓ Required for project references |
| `declaration` | `true` | ✓ Correct |

No drift from best practices found.

### `eslint.config.js`

| Finding | Detail | Recommendation |
|---|---|---|
| Several rules demoted to `warn` | `no-non-null-assertion`, `no-unnecessary-condition`, `no-confusing-void-expression`, `no-misused-promises`, `require-await`, `use-unknown-in-catch-callback-variable`, `no-base-to-string`, `restrict-template-expressions` are all `warn` in both frontend and server configs. The code includes a comment noting these are "pre-existing patterns" for "incremental adoption." | These warnings represent tracked technical debt. Promote to `error` as the codebase is cleaned up. No urgent action needed. |
| Test file config relaxed | `@typescript-eslint/no-explicit-any: 'off'` for test files | Appropriate. Test code benefits from flexibility. |
| Server excluded from frontend config | `ignores: ['server/**']` in frontend block; separate server block exists | ✓ Correct and intentional. |
| No Prettier config | No `.prettierrc` found | Low risk — the project relies on ESLint for formatting rules. Consider adding Prettier for consistency enforcement if team grows. |

---

## License Compliance

### Summary Table

| License | Count |
|---|---|
| MIT | 100 |
| ISC | 7 |
| Apache-2.0 | 2 |
| BSD-3-Clause | 2 |
| MIT OR WTFPL | 1 |
| BSD-2-Clause OR MIT OR Apache-2.0 | 1 |
| **Total** | **113** |

No GPL, AGPL, LGPL, or other copyleft licenses detected.

The project's `package.json` contains a `licenseNotes` field that explicitly documents:
- **dompurify** (MPL-2.0 OR Apache-2.0): dual-licensed; Apache-2.0 is compatible with MIT.
- **lightningcss** (MPL-2.0): build-time only, not shipped in distributed artifacts.

No license compliance concerns.

---

## Documentation Freshness

### API Docs — Potentially Stale

| Area | Change | Date Merged | Doc Status |
|---|---|---|---|
| WebSocket rate-limiting | New `ws-rate-limit.ts` module added; WS rate-limit bypass patched (#435) | 2026-04-26 | **Not documented** in `docs/stream-json-protocol.md` or `README.md`. The rate-limit behavior (per-IP limits, headers returned) is not surfaced to operators. |
| Workflow engine restart resume | `cb6d717` — Engine now resumes in-progress workflows and cleans up orphaned sessions (#437) | 2026-04-26 | **`docs/WORKFLOWS.md` may be stale** — restart/resume behavior is new and likely not reflected. |
| Child spawn rate-limiting | New hard cap on agent child session spawning (#431) | 2026-04-25 | Partially documented in API reference via PR #433. No operator-facing configuration docs. |
| CORS PATCH method | Added PATCH to CORS allowed methods (#432) | 2026-04-25 | Internal only; no end-user documentation needed. |
| Repos path canonicalization | Owner-namespaced local repo storage (#425) | 2026-04-21 | May affect `INSTALL-DISTRIBUTION.md` directory layout descriptions. |

### README Drift Check

| Check | Result |
|---|---|
| `npm run dev` script | ✓ Exists in `package.json` |
| `npm run build` script | ✓ Exists in `package.json` |
| `npm test` script | ✓ (`npm test` maps to `vitest run`) |
| `npm run lint` script | ✓ Exists |
| Port 32352 | ✓ Matches `server/config.ts` default |
| `REPOS_ROOT` default `~/repos` | ✓ Matches `server/config.ts` |
| Feature list (Agent Joe, diff viewer, approval management, etc.) | ✓ All verified in source |
| `codekin upgrade` command | ✓ In `bin/codekin.mjs` |

No README drift detected. CONTRIBUTING.md is accurate.

---

## Draft Changelog

### Period: 2026-04-21 through 2026-04-27 (since last tag `v0.6.3`)

#### Features
- **Workflow engine restart-resume** — The workflow engine now resumes workflows that were in-progress when the server restarted. Orphaned sessions (children with no live parent) are automatically detected and cleaned up on startup. (#437)

#### Fixes
- Silence false alert when a repo has no enabled workflows (#436)
- Patch WebSocket rate-limit bypass; add timeouts to `gh` subprocess calls; align prompt-timeout documentation (#435)
- Resolve hooksPath resolution regression; add PATCH to CORS allowed methods (#432)
- Fix nested reports path traversal; narrow CSP `connect-src`; repair API docs drift (#426)
- Canonicalize `repos_path` and namespace local repo storage by owner to prevent collisions (#425)

#### Security
- Harden `repos-path` validation in settings endpoint; add hard rate-limit cap on child session spawning (#431)

#### Tests
- Add coverage for auth, docs, session, workflow, and commit-event route handlers (#428)
- Add coverage for workflow routes and commit-event hooks (#427)

#### Documentation
- Document H1 and M5 security error responses in API reference (#433)
- Address 2026-04-22 docs-audit findings — update WORKFLOWS.md, ORCHESTRATOR-SPEC.md, and related docs (#429)

#### Chores
- Remove three unused exports identified in code review (#434)
- Align server TypeScript version; widen ESLint server glob to include all `server/` subdirectories (#430)
- Bump dompurify to 3.4.0; bump better-sqlite3 to 12.9.0 (#424)

---

## Stale Branches

No remote branches have a last commit older than 30 days (oldest observed: `test/coverage-gaps-apr10` at 2026-04-10, 17 days ago).

### Aging Unmerged Branches (14–17 days, likely already merged via PR)

The following branches have had no commits in 14+ days and their content appears in main's commit history (indicating the PR was merged but the remote branch was not deleted):

| Branch | Last Commit | Author | Merged into main? | Recommendation |
|---|---|---|---|---|
| `fix/symlink-bypass-spawn` | 2026-04-17 | alari | **Yes** (confirmed by merge-base check) | Delete |
| `refactor/app-decompose-hooks` | 2026-04-15 | alari | Likely (corresponds to #416 `ae33fd2`) | Delete |
| `refactor/split-orchestrator-routes` | 2026-04-15 | alari | Likely (corresponds to #415 `5053233`) | Delete |
| `test/coverage-gaps-apr10` | 2026-04-10 | alari | Likely (content in main) | Delete |
| `feat/connection-status-popup` | 2026-04-11 | alari | Likely (corresponds to #346) | Delete |
| `feat/repo-health-2026-04-13` | 2026-04-13 | alari | Likely (content in main) | Delete |
| `feat/test-coverage-2026-04-13` | 2026-04-13 | alari | Likely (content in main) | Delete |
| `feat/daily-code-review-2026-04-12` | 2026-04-12 | alari | Likely (content in main) | Delete |
| `chore/pr-audit-2026-04-12` | 2026-04-12 | alari | Likely (content in main) | Delete |
| `feat/pr-373-audit-report` | 2026-04-12 | alari | Likely (content in main) | Delete |
| `docs/session-restart-audit` | 2026-04-13 | alari | Likely (corresponds to #402) | Pending PR |
| `docs/cleanup-apr15` | 2026-04-15 | alari | Likely (corresponds to #414) | Delete |

**Recommendation**: Run `git remote prune origin` to remove stale remote-tracking refs for merged branches. Enable "automatically delete head branches" in GitHub repository settings to prevent future accumulation.

---

## PR Hygiene

All 8 open PRs are documentation-only (audit report files). All are mergeable and unreviewed.

| PR # | Title | Author | Days Open | Review Status | Conflicts | Stuck? |
|---|---|---|---|---|---|---|
| #422 | docs: add accumulated audit reports (2026-04-16 through 2026-04-18) | alari76 | 9 | No reviews | None | **Yes** |
| #413 | docs: weekly repo health report + accumulated audit reports (2026-04-15) | alari76 | 12 | No reviews | None | **Yes** |
| #402 | docs: session restart root cause audit | alari76 | 14 | No reviews | None | **Yes** |
| #396 | docs: test coverage report 2026-04-13 | alari76 | 14 | No reviews | None | **Yes** |
| #395 | docs: repo health report 2026-04-13 | alari76 | 14 | No reviews | None | **Yes** |
| #392 | docs: add daily code review report for 2026-04-12 | alari76 | 15 | No reviews | None | **Yes** |
| #390 | docs: PR code review audit (2026-04-12, last 7 merged) | alari76 | 15 | No reviews | None | **Yes** |
| #374 | docs: Add audit report for PR #373 | alari76 | 15 | No reviews | None | **Yes** |

**Observation**: There are no open feature or fix PRs — all code changes are being merged directly or auto-merged. The PR backlog is entirely composed of documentation report PRs that accumulate faster than they are reviewed and merged. Consider batch-merging these docs PRs in a single session, or adopting a policy of auto-merging docs-only PRs after a short hold period.

---

## Merge Conflict Forecast

Active branches (commits within last 14 days) and their divergence from main:

| Branch | Ahead | Behind | Files Changed | Overlapping w/ Main (since divergence) | Risk |
|---|---|---|---|---|---|
| `fix/workflow-engine-resilience` | 2 | 2 | `server/workflow-engine.{ts,test.ts}`, `server/workflow-loader.{ts,test.ts}` | `server/workflow-engine.ts` touched by #437 on main | **Medium-High** |
| `fix/notifier-skip-empty-workflows` | 2 | 2 | `server/orchestrator-monitor.{ts,test.ts}` | No overlap detected | Low |
| `fix/code-review-2026-04-26` | ~2 | ~2 | `docs/FEATURES.md`, `server/upload-routes.ts`, `server/ws-rate-limit.{ts,test.ts}`, `server/ws-server.ts` | `server/ws-server.ts` and `server/upload-routes.ts` modified on main via #435 | **Medium** |
| `chore/dead-code-and-opus-4-7-docs` | 1 | 4 | `server/orchestrator-learning.ts`, `server/orchestrator-reports.ts`, `src/types.ts` | Both orchestrator files also modified in current working branch | **Medium** |
| `docs/api-ref-h1-m5-errors` | 2 | 5 | `docs/FEATURES.md` | `docs/FEATURES.md` also in `fix/code-review-2026-04-26` | Low-Medium |
| `chore/eslint-glob-and-ts-align` | 2 | 8 | ESLint config, tsconfig files | ESLint changes on main via #430 | **Medium** |

**Highest risk**: `fix/workflow-engine-resilience` — this branch touches `workflow-engine.ts`, and main just merged a major workflow-engine feature (#437, restart-resume). A rebase or merge will require careful conflict resolution.

**Action**: Rebase `fix/workflow-engine-resilience` against main immediately before the divergence grows further.

---

## Recommendations

1. **[High] Rebase `fix/workflow-engine-resilience` against main immediately.** The workflow-engine restart-resume feature (#437) landed 2026-04-26 and this branch is already 2 commits behind with direct file overlap. Delay increases conflict complexity.

2. **[High] Batch-merge the 8 stuck documentation PRs (#374, #390, #392, #395, #396, #402, #413, #422).** All are mergeable, all contain only audit report files, and none require review. Enable "auto-merge" on docs-only PRs or establish a weekly merge ritual to clear the backlog before it grows further.

3. **[Medium] Delete stale remote branches after verifying merge status.** At least 10 branches are aging with no activity and their content appears in main. Run `git remote prune origin` and delete confirmed-merged branches from GitHub. Enable auto-deletion of merged branches in repository settings.

4. **[Medium] Document `ws-rate-limit.ts` for operators.** The new WebSocket rate-limiter (added in #435) enforces per-IP limits, but the thresholds, error codes, and retry guidance are not described in any operator-facing documentation. Add a brief section to `docs/stream-json-protocol.md` or `INSTALL-DISTRIBUTION.md`.

5. **[Medium] Update `docs/WORKFLOWS.md` to reflect workflow restart-resume behavior.** PR #437 added significant new behavior (restart-resume, orphaned session cleanup) that operators need to understand for predictable workflow operation after server restarts.

6. **[Medium] Remove orphan test file `server/provider-dispatch.test.ts`.** The corresponding `provider-dispatch.ts` module does not exist. The tests either need to be migrated to the module that absorbed this functionality (likely `session-manager.test.ts`) or deleted if the behavior is already covered.

7. **[Low] Align `target` version between `tsconfig.app.json` (ES2022) and `tsconfig.node.json` (ES2023).** This is a minor inconsistency that causes no real issues (each targets its correct runtime) but can confuse contributors. Standardise on ES2022 unless ES2023 features are needed in the Vite config.

8. **[Low] Progressively promote ESLint `warn` rules to `error`.** The ESLint config contains a tracked comment acknowledging 8 demoted rules. Consider scheduling a cleanup sprint to eliminate `no-non-null-assertion` and `no-unnecessary-condition` warnings — these are the most likely to hide real bugs at runtime.

9. **[Low] Add a Prettier config** (`.prettierrc`) to complement ESLint for consistent formatting across editors. Currently formatting is enforced only by linting rules, which is inconsistent for non-TS files (Markdown, JSON, YAML).

10. **[Low] Consider enabling GitHub's "Automatically delete head branches" setting** to prevent the ongoing accumulation of merged-but-not-deleted remote branches. This is purely a housekeeping convenience.
