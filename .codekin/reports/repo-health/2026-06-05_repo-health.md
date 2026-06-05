# Repository Health: codekin

**Date**: 2026-06-05T03:21:38.730Z
**Repository**: /srv/repos/Multiplier-Labs/codekin
**Branch**: main
**Workflow Run**: 54a1d081-739a-47dd-a3e0-5de15860e62f
**Session**: 09766a48-e53e-4fea-b40f-acc93d77ea5a

---

Now I have all the data needed. Compiling the full report:

---

# Repository Health Report — Codekin
**Date:** 2026-06-05
**Branch assessed:** `main` (HEAD: `577c695`)

---

## Summary

**Overall Health Rating: Good**

The codebase is in solid shape. Documentation was audited and refreshed two days ago, the test suite has honest coverage configuration, and a critical SQL injection fix was merged this week. The main concerns are a growing backlog of unmerged remote branches (primarily automated audit branches that are never cleaned up), two stuck open PRs, and a minor config inconsistency in `workflows/tsconfig.json`.

| Category | Status | Key Metric |
|---|---|---|
| Dead Code | Excellent | 1 orphaned test file |
| TODO/FIXME | Excellent | 0 actionable items |
| Config Drift | Fair | 4 issues in `workflows/tsconfig.json` |
| License Compliance | Excellent | All permissive |
| Documentation | Good | 3 undocumented env vars |
| Stale Branches | Needs Attention | 40+ unmerged, 12 non-audit stale |
| Open PRs | Needs Attention | 2 open, both stuck (21+ days) |
| Merge Conflict Forecast | Good | Low risk on active branches |

---

## Dead Code

| File | Export / Symbol | Type | Recommendation |
|---|---|---|---|
| `server/provider-dispatch.test.ts` | entire file | Orphan test file | Review: no corresponding `provider-dispatch.ts` source exists; tests cover logic now embedded in `session-manager.ts`. Confirm coverage then delete or rename to match actual source. |

**Notes:** All 46 components in `src/components/`, all 27 hooks in `src/hooks/`, all utilities in `src/lib/`, and all server exports were verified as imported and used. No unused exports, no unreachable private functions, and no orphaned source files were found beyond the one test file above.

---

## TODO/FIXME Tracker

No actionable developer annotations found in production source code.

| File:Line | Type | Comment | Author | Date | Stale? |
|---|---|---|---|---|---|
| `server/claude-process.test.ts:60` | — | `'TODO'` (test fixture string, not a comment) | alari76 | 2026-04-10 | N/A |
| `server/claude-process.test.ts:809` | — | `{ pattern: 'TODO' }` (test fixture) | Multiplier Labs | 2026-03-08 | N/A |
| `server/opencode-process.test.ts:557` | — | `'TODO'` (test fixture string) | alari76 | 2026-04-10 | N/A |

**Summary:**
- Total actionable TODO/FIXME/HACK/XXX/WORKAROUND comments: **0**
- The only matches are test data strings inside assertions for `summarizeToolInput()`, not deferred work items.
- Stale items (>30 days): **0**

---

## Config Drift

### `workflows/tsconfig.json` — Under-specified (4 issues)

The `workflows/` directory has a significantly less strict TypeScript config compared to `server/tsconfig.json`:

| Setting | `server/tsconfig.json` | `workflows/tsconfig.json` | Recommended |
|---|---|---|---|
| `noUnusedLocals` | `true` | missing | `true` |
| `noUnusedParameters` | `true` | missing | `true` |
| `noFallthroughCasesInSwitch` | `true` | missing | `true` |
| `noUncheckedSideEffectImports` | `true` | missing | `true` |
| `isolatedModules` | `true` | missing | `true` |
| `composite` | `true` | missing | `true` (needed for project references) |
| `declaration` / `sourceMap` | both `true` | missing | recommended |

### `server/tsconfig.json` — Minor omission

| Setting | Current | Recommended |
|---|---|---|
| `noImplicitReturns` | missing | `true` (present in `tsconfig.app.json` and `tsconfig.node.json`) |

### Target version inconsistency

| Config | `target` |
|---|---|
| `tsconfig.app.json` | ES2023 |
| `tsconfig.node.json` | ES2023 |
| `server/tsconfig.json` | ES2022 |
| `workflows/tsconfig.json` | ES2022 |

Minor: aligning server and workflows to ES2023 would improve consistency.

### ESLint (`eslint.config.js`) — No issues

Modern flat config, uses `strictTypeChecked` for both frontend and server, proper per-environment globals, and separate relaxed profile for tests. Several high-severity rules correctly downgraded to `warn` for incremental adoption. No deprecated rules detected.

### Prettier (`.prettierrc`) — No issues

Practical defaults; no conflicts with ESLint rule set.

---

## License Compliance

**Project License:** MIT

| License | Count | Dependencies |
|---|---|---|
| MIT | 36 | express, react, vite, vitest, ws, tailwindcss, cmdk, marked, jsdom, and 27 others |
| Apache-2.0 | 1 | typescript |
| BSD-3-Clause | 1 | highlight.js |
| MPL-2.0 OR Apache-2.0 | 1 | dompurify |
| MPL-2.0 (build-only) | 1 | lightningcss (transitive, via TailwindCSS) |

**Flagged dependencies:**

| Dependency | License | Concern | Resolution |
|---|---|---|---|
| `dompurify` | MPL-2.0 OR Apache-2.0 | Dual-licensed; MPL-2.0 has file-level copyleft | Project's `licenseNotes` in `package.json` documents this as permissively compatible. The Apache-2.0 option applies. No action needed. |
| `typescript` | Apache-2.0 | Dev-only tool | Apache-2.0 is permissive and fully compatible with MIT. No issue. |
| `lightningcss` | MPL-2.0 | Transitive build-time dep | Build-time only, not distributed in artifacts. Project `licenseNotes` acknowledges this explicitly. No action needed. |

**Result: Full compliance.** No GPL, AGPL, or LGPL dependencies found. All flagged items are pre-documented by the project or confirmed non-issues.

---

## Documentation Freshness

### README drift

**No drift detected.** All documented commands match the CLI implementation in `bin/codekin.mjs`. The README documents user-facing CLI commands (`codekin start`, `stop`, `token`, etc.), not npm scripts, which is correct.

`codekin stop` was added to README in commit `7e257e0` (2026-06-03), consistent with a recent completeness audit.

### docs/ files

All seven documentation files (`API-REFERENCE.md`, `FEATURES.md`, `SETUP.md`, `OPERATIONS.md`, `WORKFLOWS.md`, `GITHUB-WEBHOOKS-SPEC.md`, `INSTALL-DISTRIBUTION.md`) were refreshed as part of the docs audit on 2026-06-03.

### Minor gaps

| Item | Location | Status |
|---|---|---|
| `SCREENSHOTS_DIR` env var | `server/config.ts` | Not listed in `docs/SETUP.md` env vars table |
| `GH_ORGS` env var | `server/config.ts` | Not listed in `docs/SETUP.md` env vars table |
| `FRONTEND_DIST` env var | `server/config.ts` | Not listed in `docs/SETUP.md` env vars table |

These three env vars have sensible defaults and are low-priority to document; they affect advanced deployments only.

### Recently changed APIs vs docs

| Change | Commit | Doc Status |
|---|---|---|
| Dynamic model discovery | `9ba8dff` (2026-06-03) | Documented in `API-REFERENCE.md` |
| Opus 4.8 model addition | `ce890c1` (2026-06-03) | Updated in models table |
| SQL injection fix in workflow query builder | `577c695` (2026-06-04) | Internal; no user-facing API change |
| WebSocket workingDir canonicalization | `9dd2bb1` (2026-06-03) | Covered by existing WS docs |

**No stale API documentation found.**

---

## Draft Changelog

### [Unreleased] — 2026-05-30 to 2026-06-04

#### Features
- Dynamic Claude model discovery: probe Anthropic API + CLI to detect available models at runtime, falling back to a curated static list (`9ba8dff`, #479)

#### Fixes
- Validate identifiers in workflow query builder to prevent SQL injection (`577c695`, #490)
- Include Opus 4.8 in model list; probe candidate IDs instead of stale aliases (`ce890c1`, #480)
- Canonicalize WebSocket `workingDir` + add model-discovery tests (`9dd2bb1`, #488)
- Group AI workflow sessions under canonical repo in sidebar (`f6266ad`, #485) — subsequently reverted (`79f664f`, #486) due to regression
- Make session auto-naming resilient to rate limits and chatty replies (`aa23134`, #484)
- Start new sessions on latest model and surface reconnect notices (`97853e9`, #483)
- Surface and resume archived sessions across repo clone paths (`d5c5456`, #482)
- Group webhook/stepflow sessions under canonical owner-namespaced repo (`c9964e4`, #481)

#### Documentation
- Fix accuracy drift surfaced by docs audit (`7e257e0`, #489): update output directory paths, add missing `codekin stop` command, replace stale naming, add `pr-review` workflow entry

#### Chores / Testing
- Make coverage honest (`coverage.all`) and start covering React components (`d9795b1`, #487)

---

## Stale Branches

Branches with no commit activity in the last 30 days (before 2026-05-06). "Audit" branches are generated automatically by scheduled workflows.

### Non-audit stale branches (actionable)

| Branch | Last Commit | Author | Merged? | Recommendation |
|---|---|---|---|---|
| `feat/connection-status-popup` | 2026-04-11 | alari | No | Review — if work was absorbed into later PRs, delete |
| `chore/pr-audit-2026-04-12` | 2026-04-12 | alari | No | Delete — stale chore branch |
| `feat/daily-code-review-2026-04-12` | 2026-04-12 | alari | No | Delete — content superseded by ongoing audit workflow |
| `feat/pr-373-audit-report` | 2026-04-12 | alari | No | Delete — point-in-time audit artifact |
| `docs/session-restart-audit` | 2026-04-13 | alari | No | Review — check if doc changes were merged separately |
| `feat/repo-health-2026-04-13` | 2026-04-13 | alari | No | Delete — superseded by ongoing repo-health workflow |
| `feat/test-coverage-2026-04-13` | 2026-04-13 | alari | No | Review — verify coverage changes landed in main |
| `feat/repo-health-2026-04-15` | 2026-04-16 | alari | No | Delete — superseded by ongoing repo-health workflow |
| `chore/release-0.6.4` | 2026-04-27 | Claude (Webhook) | No | Review — confirm release was cut; delete if so |
| `fix/ci-lint-errors-and-stale-mock-2026-04-27` | 2026-04-27 | Claude (Webhook) | No | Review — check if merged via squash (hence "not merged" in git) |
| `fix/commit-event-handler-mock-missing-export` | 2026-04-27 | Claude (Webhook) | No | Review — as above |
| `fix/commit-event-handler-test-mock` | 2026-04-27 | Claude (Webhook) | No | Review — as above |
| `docs/audit-reports-2026-04-18` | 2026-04-30 | alari | No | Delete — point-in-time doc artifact |
| `fix/clone-test-timeout` | 2026-05-15 | Claude (Webhook) | No | Has open PR #478 — see PR hygiene section |

### Automated audit branches (pattern: `audit/*`, `codekin/reports`)

There are **27** accumulated `audit/` branches ranging from 2026-04-28 to 2026-05-08, none merged into main. These appear to be report-only branches generated by the workflow system and never cleaned up. This is a growing accumulation pattern.

| Branch pattern | Count | Date range | Recommendation |
|---|---|---|---|
| `audit/code-review.daily-*` | 7 | 2026-04-28 to 2026-05-04 | Delete all — reports are in the repo via other means |
| `audit/repo-health.weekly-*` | 5 | 2026-04-28 to 2026-05-04 | Delete all |
| `audit/comment-assessment.daily-*` | 2 | 2026-05-01, 2026-05-08 | Delete |
| `audit/complexity.weekly-*` | 2 | 2026-04-29, 2026-05-06 | Delete |
| `audit/dependency-health.daily-*` | 2 | 2026-04-28, 2026-05-05 | Delete |
| `audit/docs-audit.weekly-*` | 1 | 2026-05-06 | Delete |
| `audit/security-audit.weekly-*` | 2 | 2026-04-30, 2026-05-07 | Delete |
| `chore/reports-2026-05-02` | 1 | 2026-05-02 | Delete |
| `codekin/reports` | 1 | 2026-06-04 (active) | See merge forecast |

---

## PR Hygiene

| PR# | Title | Author | Days Open | Review Status | Conflicts | Stuck? |
|---|---|---|---|---|---|---|
| #464 | chore(reports): add code-review, comment, and repo-health reports for 2026-05-01 | alari76 | **34** | No review | Unknown | **Yes** |
| #478 | fix: mock child_process in clone test to prevent CI timeout | alari76 | **21** | No review | Unknown | **Yes** |

Both PRs are flagged as stuck (open >7 days, no review activity).

**PR #464** is a 34-day-old report chore — likely superseded. The reports it adds were for 2026-05-01 and newer reports have been generated since. Recommend closing or merging with a note.

**PR #478** is a test fix (mock `child_process` in clone test to prevent CI timeout) that is 21 days stale with no review. The fix appears relevant — `fix/clone-test-timeout` has not been merged. Recommend prioritizing review.

---

## Merge Conflict Forecast

Active branches (commits in the last 14 days) compared against `origin/main`:

| Branch | Commits Ahead | Commits Behind | Overlapping Risk | Risk Level |
|---|---|---|---|---|
| `chore/tsconfig-parity-and-changelog` | 1 | 0 | None — main is fully incorporated | **Low** |
| `fix/coverage-honest-config-and-component-tests` | 3 | 5 | Possible overlap in test config files touched by recent coverage work on main | **Medium** |
| `fix/docs-audit-accuracy` | 2 | 10 | Possible overlap in `docs/` files updated by `7e257e0` on main | **Medium** |
| `codekin/reports` | 114 | 555 | Massive divergence — this is a long-lived report accumulation branch. Conflict risk with any file touched on main | **High (by design)** |

`codekin/reports` has 555 commits behind main — this branch accumulates automated report files and diverges continuously. It is not intended to be rebased; its high conflict count is structural, not actionable in the usual sense. However, the pattern of 114 unmerged ahead-commits suggests reports are written there but the branch is never fast-forwarded.

`fix/coverage-honest-config-and-component-tests` and `fix/docs-audit-accuracy` are both 2–3 days old and 5–10 commits behind main. These should be rebased or merged promptly before more divergence accumulates.

---

## Recommendations

1. **[High] Merge or close PR #478** (`fix/clone-test-timeout`, 21 days stale). This is a test fix for a real CI problem. Review and merge to unblock the branch. It has no open review activity.

2. **[High] Close PR #464** (chore reports from 2026-05-01, 34 days stale). The content is superseded — newer reports have been generated. Closing with a note is cleaner than merging a month-old report.

3. **[High] Purge stale audit branches** — 27+ `audit/*` branches, `chore/reports-2026-05-02`, and `codekin/reports` (if it's no longer the active reports branch) are accumulating on the remote. Implement a branch retention policy or automated cleanup for `audit/*` branches older than 60 days.

4. **[Medium] Delete 14 stale non-audit feature/fix branches** from April 2026. Start with the clearly superseded ones (`feat/repo-health-*`, `feat/daily-code-review-*`, `chore/pr-audit-*`) and review the fix branches from 2026-04-27 to confirm their changes landed in main via squash merges.

5. **[Medium] Rebase or merge `fix/coverage-honest-config-and-component-tests` and `fix/docs-audit-accuracy`** — both are active branches 5–10 commits behind main. The longer they sit, the higher the merge friction.

6. **[Medium] Align `workflows/tsconfig.json` with `server/tsconfig.json`** — add `noUnusedLocals`, `noUnusedParameters`, `noFallthroughCasesInSwitch`, `noUncheckedSideEffectImports`, and `isolatedModules`. The workflows directory runs the same TypeScript and deserves the same strictness guarantees.

7. **[Medium] Remove or relocate `server/provider-dispatch.test.ts`** — the only orphaned file in the codebase. Its source (`provider-dispatch.ts`) does not exist; the tested behavior lives in `session-manager.ts`. Either delete the file or rename it to match the actual module it covers.

8. **[Low] Add `noImplicitReturns` to `server/tsconfig.json`** — present in all other tsconfigs in the project; a one-line addition for consistency.

9. **[Low] Document `SCREENSHOTS_DIR`, `GH_ORGS`, and `FRONTEND_DIST` env vars in `docs/SETUP.md`** — these are in `server/config.ts` but absent from the env vars reference table. Even a brief entry with default values prevents confusion for new operators.

10. **[Low] Establish a branch cleanup cadence** — the current accumulation of 40+ unmerged remote branches (most from automated workflow runs) suggests the repository lacks a pruning policy. A monthly cron or post-PR-merge hook to delete `audit/*` branches older than N days would prevent this from growing further.