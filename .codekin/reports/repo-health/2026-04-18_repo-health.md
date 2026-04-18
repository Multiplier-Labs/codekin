# Repository Health Report — 2026-04-18

**Project:** Codekin v0.6.3  
**Branch:** main  
**Assessed by:** Automated health workflow  

---

## Summary

**Overall Health: Good**

Codekin is an actively maintained project with strict TypeScript, comprehensive test coverage (~220 test files), and a clean codebase. No dead code or TODO/FIXME comments were found. Configs are modern and consistent. All dependencies carry permissive licenses. Documentation is actively audited and up to date. The primary areas requiring attention are branch hygiene (18+ remote branches, several stale) and an accumulation of open documentation PRs that should be merged or closed.

| Metric | Value |
|---|---|
| Dead code items | 0 |
| Stale TODOs/FIXMEs | 0 |
| Config issues | 0 |
| License concerns | 0 |
| Doc drift items | 1 minor (API-REFERENCE.md) |
| Stale branches | 7 (>14 days old) |
| Open PRs | 7 (all docs/audit) |
| Stuck PRs (>7 days, no review) | 7 |

---

## Dead Code

No dead code detected. All exported symbols in `src/` and `server/` are actively imported. No orphan source files found. All 15 frontend test files and 205 server test files are in active use.

| File | Export / Function | Type | Recommendation |
|---|---|---|---|
| — | — | — | No findings |

---

## TODO/FIXME Tracker

No `TODO`, `FIXME`, `HACK`, `XXX`, or `WORKAROUND` comments exist in the production codebase (`src/`, `server/`). The only hits are in test fixtures that assert on those literal strings as test data.

| File:Line | Type | Comment | Author | Date | Stale? |
|---|---|---|---|---|---|
| server/claude-process.test.ts:60 | TEST FIXTURE | Pattern match for 'TODO' string | — | — | N/A |
| server/claude-process.test.ts:809 | TEST FIXTURE | Pattern match for 'TODO' string | — | — | N/A |
| server/opencode-process.test.ts:557 | TEST FIXTURE | Pattern match for 'TODO' string | — | — | N/A |

**Summary:** Total production markers = 0. Test fixtures = 3 (not actionable). Stale items = 0.

---

## Config Drift

All TypeScript and ESLint configurations are modern, consistent, and follow best practices for the project's stack. No issues found.

| Config File | Setting | Current Value | Recommended Value | Notes |
|---|---|---|---|---|
| tsconfig.app.json | `strict` | `true` | `true` | ✅ Correct |
| tsconfig.app.json | `noUnusedLocals` | `true` | `true` | ✅ Correct |
| tsconfig.app.json | `noUnusedParameters` | `true` | `true` | ✅ Correct |
| tsconfig.node.json | `target` | `ES2023` | `ES2022+` | ✅ Acceptable |
| server/tsconfig.json | `module` | `NodeNext` | `NodeNext` | ✅ Correct for Node ESM |
| eslint.config.js | Config format | Flat config v8 | Flat config v8 | ✅ Current |
| eslint.config.js | Type-checked rules | `strictTypeChecked` | `strictTypeChecked` | ✅ Correct |
| .prettierrc | `printWidth` | `120` | 80–120 | ✅ Within acceptable range |
| .prettierrc | `semi` | `false` | team preference | ✅ Consistent |

**Verdict:** No drift. Configurations are modern and internally consistent across frontend, backend, and build tooling.

---

## License Compliance

**Project license:** MIT

All direct dependencies carry permissive licenses. No GPL, AGPL, or LGPL dependencies found.

| License | Dependency Count |
|---|---|
| MIT | ~25 (express, ws, react, react-dom, vite, marked, highlight.js, better-sqlite3, multer, etc.) |
| Apache-2.0 | 1 (typescript) |
| BSD-3-Clause | 1 (highlight.js) |
| MPL-2.0 OR Apache-2.0 | 1 (dompurify — dual-licensed, both compatible with MIT for library use) |
| MPL-2.0 | 1 (lightningcss — build-time only, not distributed in artifacts) |

**Flagged dependencies:** None requiring action.

> **Note:** `dompurify` is dual-licensed MPL-2.0/Apache-2.0; Apache-2.0 is permissively compatible with MIT. `lightningcss` (MPL-2.0) is used at build time by TailwindCSS and is not included in distributed bundles — no licensing obligation applies. This is already documented in `package.json`.

---

## Documentation Freshness

### API Docs Status

| Doc File | Last Updated | Status |
|---|---|---|
| docs/FEATURES.md | 2026-04-17 | ✅ Current |
| docs/GITHUB-WEBHOOKS-SPEC.md | 2026-04-17 | ✅ Current |
| docs/PR-REVIEW-WEBHOOK.md | 2026-04-17 | ✅ Current |
| docs/WORKFLOWS.md | 2026-04-17 | ✅ Current |
| docs/INSTALL-DISTRIBUTION.md | 2026-04-09 | ✅ Current (install steps stable) |
| docs/SETUP.md | 2026-04-08 | ✅ Current (reviewed Apr 15 audit) |
| docs/stream-json-protocol.md | 2026-04-08 | ✅ Current (reviewed Apr 15 audit) |
| docs/API-REFERENCE.md | 2026-04-08 | ⚠️ Minor — 10 days old; server/ had commits Apr 17 |
| docs/ORCHESTRATOR-SPEC.md | 2026-04-04 | ⚠️ Minor — 14 days old; reviewed Apr 15 audit but not re-dated |

**Doc drift items:** `API-REFERENCE.md` and `ORCHESTRATOR-SPEC.md` are the oldest docs. Both were covered in the Apr 15 audit (PR #414) which updated cross-references; however neither file itself was re-dated. Verify that the Apr 17 server-side changes (orchestrator route decomposition in PR #415, App.tsx decomposition in PR #416) are reflected.

### README Drift

No drift detected. All scripts in `package.json` match usage documented in `README.md`:

| README Command | package.json Script | Match? |
|---|---|---|
| `npm run dev` | `"dev": "vite"` | ✅ |
| `npm run build` | `"build": "tsc -b && vite build"` | ✅ |
| `npm test` | `"test": "vitest run"` | ✅ |
| `npm run test:watch` | `"test:watch": "vitest"` | ✅ |
| `npm run lint` | `"lint": "eslint ."` | ✅ |

All feature descriptions in README.md (multi-provider, worktrees, webhooks, skills, etc.) correspond to implemented code.

---

## Draft Changelog

### [Unreleased] — 2026-04-15 to 2026-04-17

#### Features
- Add Claude Opus 4.7 to available models (#421)

#### Bug Fixes
- Add hard key caps to auth and webhook rate-limiter maps to prevent unbounded growth (#418)
- Prevent JSON injection in `commit-event-hook.sh` via proper quoting (#417)
- Use `realpathSync` to prevent symlink bypass in spawn route (#419)

#### Refactoring
- Decompose `App.tsx` into focused hooks for improved maintainability (#416)
- Split `orchestrator-routes.ts` into focused sub-routers (#415)
- Enforce strict `@typescript-eslint/no-unsafe-*` rules across entire codebase (#411)

#### Documentation
- Cleanup docs for Apr 15 audit — add PR review spec, cross-references, roadmap restructure (#414)

#### Chores
- Remove leftover blank line from debug lifecycle log cleanup (#420)

---

## Stale Branches

Branches with no commit activity in the last 14 days:

| Branch | Last Commit | Author | Merged to main? | Recommendation |
|---|---|---|---|---|
| origin/feat/test-coverage-2026-04-13 | 2026-04-13 | alari | No | Review and merge or delete |
| origin/feat/repo-health-2026-04-13 | 2026-04-13 | alari | No | Review and merge or delete |
| origin/feat/daily-code-review-2026-04-12 | 2026-04-12 | alari | No | Review and merge or delete |
| origin/chore/pr-audit-2026-04-12 | 2026-04-12 | alari | No | Review and merge or delete |
| origin/feat/pr-373-audit-report | 2026-04-12 | alari | No | Review and merge or delete |
| origin/feat/connection-status-popup | 2026-04-11 | alari | No | Rebase or close (71 commits behind) |
| origin/test/coverage-gaps-apr10 | 2026-04-10 | Claude (Webhook) | No | Review and delete (97 commits behind) |

**Additional concern:** `origin/codekin/reports` is 74 commits ahead and **479 commits behind** main — this branch has severely diverged and poses a high rebase cost. It should be evaluated for whether it can be squashed and rebased, or closed.

Recent-but-merged branches (safe to delete):
- `origin/fix/symlink-bypass-spawn` — merged (PR #419)

---

## PR Hygiene

All 7 open PRs are documentation/audit reports authored by alari76. None have received a review. All have been open more than 3 days; 5 of 7 exceed the 7-day stuck threshold.

| PR# | Title | Author | Days Open | Review Status | Mergeable | Stuck? |
|---|---|---|---|---|---|---|
| #413 | docs: weekly repo health report + accumulated audit reports (2026-04-15) | alari76 | 3 | None | ✅ Yes | No |
| #402 | docs: session restart root cause audit | alari76 | 5 | None | ✅ Yes | No |
| #396 | docs: test coverage report 2026-04-13 | alari76 | 5 | None | ✅ Yes | No |
| #395 | docs: repo health report 2026-04-13 | alari76 | 5 | None | ⚠️ Unknown | No |
| #392 | docs: add daily code review report for 2026-04-12 | alari76 | 6 | None | ✅ Yes | No |
| #390 | docs: PR code review audit (2026-04-12, last 7 merged) | alari76 | 6 | None | ✅ Yes | No |
| #374 | docs: Add audit report for PR #373 | alari76 | 6 | None | ⚠️ Unknown | No |

**Observation:** All open PRs are audit/report documents. Given that these are self-authored with no external reviewers, consider adopting a policy of self-merging audit PRs after a short review window (e.g., 24–48 hours), or batch them into a single weekly docs PR to reduce noise.

---

## Merge Conflict Forecast

Active branches (commits in the last 14 days) compared to main:

| Branch | Commits Ahead | Commits Behind | Overlapping Risk Files | Risk Level |
|---|---|---|---|---|
| origin/codekin/reports | 74 | 479 | Likely: .codekin/reports/**, CHANGELOG.md | 🔴 HIGH |
| origin/test/coverage-gaps-apr10 | 2 | 97 | server/ tests, src/ tests | 🔴 HIGH |
| origin/feat/connection-status-popup | 5 | 71 | src/components/, src/hooks/ | 🟠 MEDIUM-HIGH |
| origin/feat/repo-health-2026-04-13 | 2 | 23 | .codekin/reports/, CHANGELOG.md | 🟡 MEDIUM |
| origin/feat/test-coverage-2026-04-13 | 3 | 23 | server/ tests | 🟡 MEDIUM |
| origin/feat/daily-code-review-2026-04-12 | 1 | 26 | .codekin/reports/ | 🟡 MEDIUM |
| origin/chore/pr-audit-2026-04-12 | 1 | 39 | .codekin/reports/ | 🟡 MEDIUM |
| origin/feat/add-opus-4-7 | 1 | 1 | server/ model config | 🟢 LOW |
| origin/fix/rate-limiter-map-caps | 1 | 6 | server/ auth/webhook | 🟢 LOW |
| origin/fix/json-injection-hook | 1 | 6 | scripts/ | 🟢 LOW |
| origin/refactor/app-decompose-hooks | 1 | 8 | src/App.tsx, src/hooks/ | 🟢 LOW |
| origin/refactor/split-orchestrator-routes | 1 | 8 | server/routes/ | 🟢 LOW |

**Notes:**
- `origin/codekin/reports` is the highest-risk branch. Its 479-commit gap means a rebase would be very costly — evaluate whether the content can be cherry-picked onto main directly.
- `origin/feat/connection-status-popup` (5 commits ahead, 71 behind) touches `src/components/` and `src/hooks/`, which have received many updates since Apr 11. Significant manual rebase work expected.
- Recent single-commit branches (Apr 17) carry minimal conflict risk.

---

## Recommendations

1. **[HIGH] Merge or close the 7 open documentation PRs.** All are mergeable audit reports. Batch or self-merge them to reduce PR queue noise. Consider a policy of auto-merging audit PRs after 48 hours with no objections.

2. **[HIGH] Delete stale merged branches.** At minimum, delete `origin/fix/symlink-bypass-spawn` (confirmed merged). Run `git push origin --delete <branch>` for each merged branch to keep the remote clean.

3. **[HIGH] Triage `origin/codekin/reports` (479 commits behind).** This branch has the highest divergence in the repo. Either cherry-pick its unique content onto main, or close it. A full rebase is not practical.

4. **[MEDIUM] Close or rebase `origin/feat/connection-status-popup` (71 commits behind).** This appears to be an in-progress feature that has been superseded by many main-branch changes. Rebase now before the gap grows further, or close the branch if the feature was abandoned.

5. **[MEDIUM] Audit `docs/API-REFERENCE.md` against recent server changes.** The orchestrator route decomposition (PR #415) and App.tsx decomposition (PR #416) may have changed public API surfaces not yet reflected in the Apr 8 reference doc.

6. **[MEDIUM] Clean up stale report branches (Apr 10–13).** The branches `feat/daily-code-review-2026-04-12`, `chore/pr-audit-2026-04-12`, `feat/pr-373-audit-report`, `feat/repo-health-2026-04-13`, `feat/test-coverage-2026-04-13`, and `test/coverage-gaps-apr10` are all 5–8 days old and significantly behind main. Merge their PRs and delete the branches.

7. **[LOW] Verify `docs/ORCHESTRATOR-SPEC.md` reflects the split-router refactor (PR #415).** The spec was last updated Apr 4 and the orchestrator routes were restructured Apr 17 into focused sub-routers.

8. **[LOW] Establish a branch TTL policy.** Given the high volume of report/audit branches being created, consider a convention of deleting branches within 7 days of PR merge (or PR close), and add a note to CLAUDE.md or CONTRIBUTING.md.

9. **[LOW] Consider tagging a v0.6.4 release.** The current unreleased set (Opus 4.7, rate-limiter caps, JSON injection fix, symlink bypass fix) represents meaningful security and feature improvements that would benefit from a version tag.

10. **[INFORMATIONAL] No action needed on code quality.** Zero TODO/FIXME debt, no dead exports, strict TypeScript, and all-permissive licenses mean the core codebase is in excellent shape. Maintenance effort should focus on branch/PR hygiene rather than code quality.
