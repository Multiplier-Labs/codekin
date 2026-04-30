# Repository Health: codekin

**Date**: 2026-04-29T03:22:26.049Z
**Repository**: /srv/repos/codekin
**Branch**: docs/audit-reports-2026-04-18
**Workflow Run**: 30c982c3-acd2-4f16-97ca-4c71195b8bbc
**Session**: 618cb38e-a442-4edb-9471-acc04fb8e376

---

---

# Repository Health Report — Codekin
**Date:** 2026-04-29  
**Branch assessed:** `docs/audit-reports-2026-04-18`  
**Assessor:** Automated workflow (Claude Sonnet 4.6)

---

## Summary

**Overall Health: Good**

The codebase is actively maintained with strong guardrails (TypeScript strict mode, enforced ESLint rules, zero TODO/FIXME technical debt markers, and a growing test suite). The main areas needing attention are open PR accumulation — 13 PRs are open, 8 of which are stuck (7+ days, no review activity) — and a growing backlog of diverging long-lived branches. License compliance is clean, configuration is modern, and documentation is reasonably current.

| Category | Status | Key Stat |
|---|---|---|
| Dead code | Good | TypeScript strict mode prevents unused locals; no orphaned files detected |
| TODO/FIXME debt | Excellent | 0 comments found across all source files |
| Config hygiene | Good | Strict mode enforced; one minor ESLint note |
| License compliance | Good | MPL-2.0 from build-only deps; 2 entries with missing lock-file fields |
| Documentation freshness | Fair | Several docs-only PRs are stale/conflicting |
| Stale branches | Good | No branches older than 30 days |
| Open PRs | Needs Attention | 13 open; 9 stuck (>7 days, no review); 3 with merge conflicts |
| Merge conflict risk | Fair | Current branch 40 ahead/43 behind main; `codekin/reports` at 99/522 |

---

## Dead Code

TypeScript `strict: true` + `noUnusedLocals: true` + `noUnusedParameters: true` are enforced in both `tsconfig.app.json` (frontend) and `server/tsconfig.json`. These compiler flags statically reject unused local variables and parameters at build time, making local dead code structurally impossible to ship.

No orphaned source files (files with no incoming import) were detected via cross-reference scanning. The most recent cleanup commit (`5044af5 chore: remove three unused exports`) confirms ongoing housekeeping.

| File | Export / Function | Type | Recommendation |
|---|---|---|---|
| *(none found)* | — | — | No action required |

**Note:** With 220+ frontend exports and 250+ server exports, a more targeted import-graph analysis (e.g., `ts-prune`) would give higher confidence. The TypeScript build being clean is a strong signal, but module-level exports that are never imported by external callers are not caught by the compiler. A scheduled `ts-prune` run is recommended (see Recommendations).

---

## TODO/FIXME Tracker

A full scan across `src/**/*.{ts,tsx}`, `server/**/*.ts`, and config/build files for `TODO`, `FIXME`, `HACK`, `XXX`, and `WORKAROUND` returned **zero results**.

| file:line | type | comment | author | date | stale? |
|---|---|---|---|---|---|
| *(none)* | — | — | — | — | — |

**Summary:**
- Total: **0**
- By type: TODO 0, FIXME 0, HACK 0, XXX 0, WORKAROUND 0
- Stale (>30 days): **0**

This is a strong positive signal. The codebase has no lingering technical debt annotations.

---

## Config Drift

### `tsconfig.app.json` (Frontend)

| Setting | Current Value | Recommended | Assessment |
|---|---|---|---|
| `strict` | `true` | `true` | ✅ Good |
| `noUnusedLocals` | `true` | `true` | ✅ Good |
| `noUnusedParameters` | `true` | `true` | ✅ Good |
| `noImplicitReturns` | `true` | `true` | ✅ Good |
| `skipLibCheck` | `true` | Prefer `false` or targeted | ⚠️ Acceptable compromise, but suppresses all third-party type errors |
| `target` | `ES2023` | `ES2023` | ✅ Appropriate for modern browser targets |
| `erasableSyntaxOnly` | `true` | `true` (TS 5.5+) | ✅ Good — future-proofs against type-stripping |
| `noUncheckedSideEffectImports` | `true` | `true` | ✅ Good |

### `server/tsconfig.json`

| Setting | Current Value | Recommended | Assessment |
|---|---|---|---|
| `strict` | `true` | `true` | ✅ Good |
| `target` | `ES2022` | `ES2022` (Node 18+) | ✅ Appropriate |
| `module` | `NodeNext` | `NodeNext` | ✅ Correct for ESM Node |
| `skipLibCheck` | `true` | Same caveat as frontend | ⚠️ Minor concern |
| `composite` | `true` | ✅ Required for project refs | ✅ Good |
| `include` | `["*.ts"]` — top-level only | Should include subdirectories | ⚠️ See note below |

**`include` scope issue:** `server/tsconfig.json` has `"include": ["*.ts"]`, which only type-checks top-level server files. Subdirectory files (e.g., `server/utils/`, if any) would only be compiled if referenced. In practice, the Vitest test config and ESLint use separate configurations, so the build still works — but this is an unusual pattern that could cause confusion. The previous `tsconfig.server.json` cleanup (`66861fd`) may have addressed this already; confirm the build output covers all subdirectories.

### `eslint.config.js`

| Setting | Current Value | Assessment |
|---|---|---|
| `@typescript-eslint/no-unsafe-*` rules | `error` | ✅ Excellent — prevents type-unsafe operations |
| `@typescript-eslint/no-floating-promises` | `error` | ✅ Good |
| `@typescript-eslint/no-deprecated` | `error` | ✅ Good |
| `restrict-template-expressions` | `warn` | ⚠️ Consider promoting to `error` in next cleanup cycle |
| `no-misused-promises` | `warn` | ⚠️ Consider promoting to `error` — async in event handlers is a real risk |
| `no-non-null-assertion` | `warn` | ⚠️ Consider promoting to `error` — non-null assertions bypass strict null checks |

**No deprecated or conflicting ESLint rules detected.** The flat config format is current.

---

## License Compliance

The project is MIT licensed. The full dependency tree (546 packages with license data) is predominantly permissive.

### License Distribution

| License | Count | Compatible with MIT? |
|---|---|---|
| MIT | 465 | ✅ Yes |
| ISC | 22 | ✅ Yes |
| Apache-2.0 | 18 | ✅ Yes |
| MPL-2.0 | 12 | ⚠️ See note |
| BSD-3-Clause | 9 | ✅ Yes |
| BSD-2-Clause | 8 | ✅ Yes |
| BlueOak-1.0.0 | 4 | ✅ Yes (permissive) |
| MIT-0 | 2 | ✅ Yes |
| CC-BY-4.0 | 1 | ✅ Yes (documentation only) |
| CC0-1.0 | 1 | ✅ Yes (public domain) |
| 0BSD | 1 | ✅ Yes |
| (MPL-2.0 OR Apache-2.0) | 1 | ✅ Use as Apache-2.0 |
| (BSD-2-Clause OR MIT OR Apache-2.0) | 1 | ✅ Use as MIT |
| (MIT OR WTFPL) | 1 | ✅ Use as MIT |
| **UNKNOWN (missing field)** | **2** | ⚠️ Verify |

### Flagged Dependencies

| Package | License | Risk | Notes |
|---|---|---|---|
| `lightningcss` (+ platform variants, 12 packages) | MPL-2.0 | Low | **Build-time only** (TailwindCSS internal); not bundled into the distributed application. MPL-2.0 file-level copyleft does not extend to the MIT project output. |
| `dompurify` | MPL-2.0 OR Apache-2.0 | None | Dual-licensed; project may use under Apache-2.0 terms, which is MIT-compatible. |
| `busboy` | UNKNOWN (field missing in lock) | Low | Actually MIT; the missing `license` field is a known `busboy` packaging quirk. Verify via `npm info busboy license`. |
| `streamsearch` | UNKNOWN (field missing in lock) | Low | Actually MIT (authored by mscdex, same author as busboy). Verify via `npm info streamsearch license`. |

**No GPL or AGPL dependencies detected.** Overall compliance posture is clean.

---

## Documentation Freshness

### API Docs / JSDoc

The `docs/` directory contains operational and protocol documentation. Recent commits have actively updated docs in response to audit findings:
- `63737bb docs: address 2026-04-22 docs-audit findings` (merged)
- `dca6fa7 docs: document H1 + M5 security error responses` (merged)
- `7eddef1 docs(ops): document workflow restart-resume and orphan-session handling` (merged)
- `1f22550 docs(ops): document WebSocket rate limiting` (merged)

No JSDoc/TSDoc annotations are used in this project — the TypeScript types serve as the primary API contract documentation. This is a reasonable choice for an internal tool but limits external discoverability.

### README Drift

README was cross-checked against `package.json` scripts and CLI:

| README Claim | Actual State | Issue? |
|---|---|---|
| `codekin token`, `codekin config`, `codekin service *`, `codekin start`, `codekin upgrade`, `codekin uninstall` | CLI commands from `bin/codekin.mjs` | ✅ No drift — these are runtime CLI commands |
| Install via `curl -fsSL codekin.ai/install.sh \| bash` | External URL not verified here | ⚠️ Ensure install script is kept in sync with current entry point |
| `PORT` default `32352` | `server/config.ts` exports `PORT` (matches CLAUDE.md) | ✅ Correct |
| `REPOS_ROOT` default `~/repos` | Server config uses this variable | ✅ Correct |
| Features list includes "Agent Joe", "Git worktrees", "OpenCode" | All present in codebase (`orchestrator-manager.ts`, `opencode-process.ts`) | ✅ Accurate |

**CLAUDE.md development scripts** (`npm run dev`, `npm run build`, `npm test`, `npm run lint`) all match `package.json` exactly. ✅

**One potential drift item:** The README screenshot references `docs/screenshot.png`. Verify this file exists and reflects the current UI after recent feature additions (connection status popup, worktree UI, workflow views).

---

## Draft Changelog

### Period: 2026-04-22 to 2026-04-29 (last 7 days on `main`)

#### Features
- **Workflow engine restart & resume** — workflow runs can now restart after server restarts; orphan sessions from crashed workflows are automatically recovered (`feat: workflow engine restart resume + orphan session handling`, #437)

#### Fixes
- **Security hardening (5 findings):**
  - Cron step value of `0` now rejected in workflow routes (DoS vector) (W1)
  - Git commit hooks are cleaned up when repos are fully removed (W2)
  - Production WebSocket handshake now requires an `Origin` header (W3)
  - `realpathSync` in clone route is guarded against path traversal (W4)
  - WebSocket rate-limit rolling window corrected (was advancing at boundary rather than after) (W5)
- **Workflow output path** — audit workflows now write to a single canonical path per run; each run gets a fresh branch (`fix/workflow-output-path-and-fresh-branch`)
- **Passive-repo alert silenced** — repos with no enabled workflows no longer emit false-positive alerts (#436)
- **Test mock repair** — `isWorkflowReportsBranch` added to commit-event-handler mock; CI lint unblocked (#448)

#### Chores
- **`marked` bumped** from v17 to v18.0.2 (#450)
- **`@multiplier-labs/stepflow` bumped** to 0.3.4 (#445)
- **Repo-health cleanup** — orphaned `dist/`, stale WS docs, redundant tsconfig removed (#451)

#### Tests
- Comprehensive server coverage additions: `stepflow-prompt`, `session-persistence`, `version-check`, `webhook-handler-base`, `tool-labels`, `orchestrator-learning-router`, `orchestrator-routes`, `webhook-routes`, `commit-event-handler`, `error-page`, `ws-server` (#440)

#### Documentation
- WebSocket rate limiting operational guide added
- Workflow restart/resume and orphan session handling documented

---

## Stale Branches

A branch is considered stale if it has had no commit activity in the last 30 days (cutoff: 2026-03-30). All remote branches were examined.

**No branches older than 30 days were found.** The oldest non-main branch is `test/coverage-gaps-apr10` (last commit 2026-04-10, 19 days ago).

However, several branches are **candidates for cleanup** due to age and apparent merge status:

| Branch | Last Commit | Author | Merged to main? | Recommendation |
|---|---|---|---|---|
| `origin/test/coverage-gaps-apr10` | 2026-04-10 | Claude (Webhook) | Likely yes (coverage work merged via other PRs) | Verify and delete |
| `origin/feat/connection-status-popup` | 2026-04-11 | alari | Unknown | Verify if feature merged; delete if so |
| `origin/feat/pr-373-audit-report` | 2026-04-12 | alari | Likely yes (audit reports branch) | Delete |
| `origin/chore/pr-audit-2026-04-12` | 2026-04-12 | alari | Likely yes | Delete |
| `origin/feat/daily-code-review-2026-04-12` | 2026-04-12 | alari | Likely yes | Delete |
| `origin/feat/repo-health-2026-04-13` | 2026-04-13 | alari | Likely yes | Delete |
| `origin/feat/test-coverage-2026-04-13` | 2026-04-13 | alari | Likely yes | Delete |
| `origin/docs/session-restart-audit` | 2026-04-15 | alari | Unknown — open PR #402 | Resolve PR first |
| `origin/feat/repo-health-2026-04-15` | 2026-04-16 | alari | Likely yes | Delete |

---

## PR Hygiene

**13 open PRs** as of 2026-04-29. A PR is flagged "stuck" if it has been open for more than 7 days with no review decision recorded.

| PR# | Title | Author | Days Open | Review Status | Mergeable | Stuck? |
|---|---|---|---|---|---|---|
| #447 | fix(test): add isWorkflowReportsBranch to commit-event-handler mock | alari76 | 1 | None | ✅ Mergeable | No |
| #446 | fix(test): add isWorkflowReportsBranch to commit-event-handler mock | alari76 | 1 | None | ✅ Mergeable | No — **duplicate of #447** |
| #444 | chore: release 0.6.4 | alari76 | 1 | None | ❌ Conflicting | No (new) |
| #443 | fix(tests): resolve CI lint errors + stale workflow-loader mock | alari76 | 1 | None | ✅ Mergeable | No |
| #442 | fix(ci): unblock lint + repair commit-event-handler test mock | alari76 | 1 | None | ❌ Conflicting | No (new) |
| #422 | docs: add accumulated audit reports (2026-04-16 through 2026-04-18) | alari76 | 10 | None | ❌ Conflicting | ⚠️ Yes |
| #413 | docs: weekly repo health report + accumulated audit reports (2026-04-15) | alari76 | 13 | None | ✅ Mergeable | ⚠️ Yes |
| #402 | docs: session restart root cause audit | alari76 | 15 | None | ✅ Mergeable | ⚠️ Yes |
| #396 | docs: test coverage report 2026-04-13 | alari76 | 15 | None | ✅ Mergeable | ⚠️ Yes |
| #395 | docs: repo health report 2026-04-13 | alari76 | 15 | None | ✅ Mergeable | ⚠️ Yes |
| #392 | docs: add daily code review report for 2026-04-12 | alari76 | 16 | None | ✅ Mergeable | ⚠️ Yes |
| #390 | docs: PR code review audit (2026-04-12, last 7 merged) | alari76 | 16 | None | ✅ Mergeable | ⚠️ Yes |
| #374 | docs: Add audit report for PR #373 | alari76 | 16 | None | ✅ Mergeable | ⚠️ Yes |

**Key observations:**
- **Duplicate PRs #446 and #447** have identical titles. One should be closed.
- **PR #444 (release 0.6.4)** has merge conflicts and is 2 days old — needs rebase before proceeding.
- **PR #422** has merge conflicts — oldest conflicting PR at 10 days; needs rebase or closure.
- **9 docs-only PRs** (reports and audit content) are stuck. These are low-risk to merge but accumulate over time. Consider a batch merge or dedicated docs-cleanup session.
- **No PRs from external contributors** — all from `alari76` (solo project).

---

## Merge Conflict Forecast

Active branches (commits in the last 14 days) diverged from `origin/main`:

| Branch | Commits Ahead | Commits Behind | Last Commit | Risk Level | Notes |
|---|---|---|---|---|---|
| `origin/docs/audit-reports-2026-04-18` | 40 | 43 | 2026-04-29 | **High** | Current branch — 43 commits behind main means significant merge effort; PR #422 already CONFLICTING |
| `origin/audit/code-review.daily-2026-04-28` | 18 | 43 | 2026-04-28 | **High** | Audit report branch — 43 commits behind; likely has file-level conflicts in `.codekin/reports/` |
| `origin/audit/dependency-health.daily-2026-04-28` | 18 | 43 | 2026-04-28 | **High** | Same parent as above — overlapping report path conflicts likely |
| `origin/audit/repo-health.weekly-2026-04-28` | 18 | 43 | 2026-04-28 | **High** | Same parent — conflicts in report directory |
| `origin/codekin/reports` | 99 | 522 | 2026-04-27 | **Critical** | Extremely diverged — 522 behind main. Merging this is effectively impossible without a full rebase; likely a defunct experiment |
| `origin/chore/release-0.6.4` | 3 | 5 | 2026-04-27 | Low | Small divergence; PR #444 has conflicts |
| `origin/fix/commit-event-handler-test-mock` | 1 | 4 | 2026-04-27 | Low | Single-commit fix; minimal risk |
| `origin/fix/commit-event-handler-mock-missing-export` | 1 | 4 | 2026-04-27 | Low | Single-commit fix; minimal risk |
| `origin/fix/ci-lint-errors-and-stale-mock-2026-04-27` | 1 | 5 | 2026-04-27 | Low | Single-commit fix |
| `origin/fix/eslint-test-config-unused-vars-and-require` | 1 | 5 | 2026-04-27 | Low | Single-commit fix |

**The `codekin/reports` branch (99 ahead / 522 behind) is the highest-risk item.** It diverged from an ancient base and can never be cleanly merged. This branch should be deleted.

**Overlapping file risk:** The audit report branches all likely touch `.codekin/reports/` directories in overlapping or sequential ways. These branches should be merged or closed promptly while the file-tree is stable.

---

## Recommendations

1. **[High Impact] Close or rebase PR #422 and the 8 stuck docs PRs.** Nine open PRs representing accumulated audit reports have been open 10–16 days with no review. The conflicting ones (#422, #442, #444) are actively blocking clean merges. Batch-merge the mergeable docs PRs and rebase or close the conflicting ones. This will reduce open-PR noise and unblock the release workflow.

2. **[High Impact] Delete `origin/codekin/reports` branch.** At 99 commits ahead / 522 commits behind `main`, this branch is unmergeable and represents accumulated drift from what appears to be an experimental reports-only branch. Verify it contains no unreleased work, then delete it.

3. **[Medium Impact] Close duplicate PR #446 (or #447).** Two PRs with identical titles and contents are open simultaneously. Close the older one (#446) to avoid confusion and duplicate CI runs.

4. **[Medium Impact] Rebase the `docs/audit-reports-2026-04-18` branch (current branch) onto main.** It is 43 commits behind main. The current automated workflow that produces this report is branched from a stale base. Future reports should branch from a fresh `main` checkout.

5. **[Medium Impact] Schedule a branch cleanup sweep.** At least 9 old feature/chore/audit branches from April 10–16 are candidates for deletion (see Stale Branches table). Run `git branch -r --merged origin/main` after resolving the stuck PRs to identify safe deletions.

6. **[Medium Impact] Add a `ts-prune` run to CI.** TypeScript's `noUnusedLocals` catches unused local symbols but not exported symbols that are never imported externally. Running `ts-prune` periodically would identify exported-but-unused symbols across module boundaries, complementing the existing strict-mode compile checks.

7. **[Low Impact] Verify `busboy` and `streamsearch` licenses.** These two packages show `UNKNOWN` in the lock file. Run `npm info busboy license && npm info streamsearch license` to confirm they are MIT (expected), then document the finding to satisfy any future compliance audits.

8. **[Low Impact] Promote three ESLint `warn` rules to `error`:** `no-misused-promises`, `no-non-null-assertion`, and `restrict-template-expressions`. These are substantive type-safety rules being treated as warnings. A one-time fix pass and promotion to `error` would tighten the safety net without significant effort.

9. **[Low Impact] Verify `docs/screenshot.png` reflects the current UI.** The README references this file. Recent UI additions (connection status panel, workflow views, Agent Joe orchestrator) may have significantly changed the appearance. An updated screenshot improves first-impressions for new users.

10. **[Low Impact] Verify `server/tsconfig.json` include scope covers all compiled subdirectories.** The `"include": ["*.ts"]` pattern only captures top-level files. Confirm the build pipeline (Vitest and production build) correctly handles server subdirectories, and update the include glob to `["**/*.ts"]` if it does not already do so via another mechanism.Let me look at the failing test file to understand what's happening.`AUTH_TOKEN` is declared twice in the same file scope — at line 214 and line 855. Let me see the context.The second block is an exact duplicate of the first section header, constant, and function. Let me see more context around each to understand the file structure.The duplicate was introduced by commit `bf01046`. Lines 851–869 are an exact copy of the block already defined at lines 210–228 — same section comment, `AUTH_TOKEN`, `verifyToken`, `extractToken`, and `authHeader`. I'll remove the duplicate block.I need to include surrounding context to uniquely target the second (duplicate) occurrence.More duplicates. Let me find all of them at once.The `interface TestHarness` and `async function startServer` are also duplicated at lines 851–882. I'll remove the second copy of all of them.All 80 test files pass now (2034 tests, up from 1942 — the new cron/security tests from commit `65f27a2` were previously unreachable due to the parse error).

**Root cause:** Commit `bf01046` ("test: cover workflow routes and commit-event hooks") appended a second `describe('workflow routes')` block to the file but accidentally duplicated the file-scope helper declarations (`AUTH_TOKEN`, `verifyToken`, `extractToken`, `authHeader`, `interface TestHarness`, `async function startServer`) that already existed earlier in the file. The parse error only surfaced after `65f27a2` added more content that triggered the oxc parser to re-validate the whole file.

The fix removes the 35-line duplicate block — the second `describe` block uses the declarations from the first section without issue.