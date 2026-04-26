# Repository Health Report — 2026-04-26

**Repository:** codekin  
**Branch:** docs/audit-reports-2026-04-18  
**Assessment Date:** 2026-04-26

---

## Summary

**Overall Health: Good**

The codebase is in strong shape with clean TODO hygiene, excellent license compliance, and modern tooling configurations. The main concerns are a growing backlog of unreviewed documentation PRs, one severely diverged tracking branch (`origin/codekin/reports`), and minor dead code in two server modules.

| Metric | Value |
|---|---|
| Dead code items | 3 (unused exports) |
| Stale TODOs | 0 |
| Config issues | 2 minor |
| License concerns | 0 (1 unverifiable workflow dep) |
| Doc drift items | 1 (API-REFERENCE.md missing Opus 4.7) |
| Stale branches | 9 inactive; 1 merged |
| Open PRs | 8 (all docs, all stuck > 7 days) |
| High-risk merge branches | 1 critical, 2 medium |

---

## Dead Code

| File | Export / Function | Type | Recommendation |
|---|---|---|---|
| `src/types.ts:41` | `RepoManifest` | Unused export (interface) | Remove — no importers found anywhere in the codebase |
| `server/orchestrator-learning.ts:588` | `getSkillLevel` | Unused export (function) | Remove — superseded by direct `loadSkillProfile()` usage |
| `server/orchestrator-reports.ts:148` | `getLatestReport` | Unused export (function) | Remove — superseded by `scanRepoReports()` + filter pattern |

**Notes:** All 60+ other source files are clean. No orphan files or unreachable private functions detected. Only 3 unused exports in the entire codebase indicates excellent code maintenance.

---

## TODO/FIXME Tracker

| File:Line | Type | Comment | Author | Date | Stale? |
|---|---|---|---|---|---|
| — | — | — | — | — | — |

**No TODO, FIXME, HACK, XXX, or WORKAROUND comments found** across all 94 frontend and 76 server source files.

| Type | Count |
|---|---|
| TODO | 0 |
| FIXME | 0 |
| HACK | 0 |
| XXX | 0 |
| WORKAROUND | 0 |
| **Total** | **0** |
| Stale items | 0 |

---

## Config Drift

### TypeScript

| Config File | Setting | Current Value | Recommended | Status |
|---|---|---|---|---|
| All tsconfig files | `strict` | `true` | `true` | ✓ |
| `tsconfig.app.json` | `target` | `ES2022` | `ES2022+` | ✓ |
| `server/tsconfig.json` | `target` | `ES2022`, `module: NodeNext` | Current | ✓ |
| All tsconfig files | `noUncheckedIndexedAccess` | (absent) | Consider enabling | Minor gap |
| All tsconfig files | `exactOptionalPropertyTypes` | (absent) | Consider enabling | Minor gap |

All configs have `strict: true`, `noFallthroughCasesInSwitch: true`, `noUncheckedSideEffectImports: true`. Modern ECMAScript targets are used throughout.

### ESLint

| Setting | Current Value | Status |
|---|---|---|
| Config format | Flat config (ESLint v9+) | ✓ Modern |
| TypeScript strictness | `strictTypeChecked` | ✓ |
| React hooks plugin | `recommended` | ✓ |
| Deprecated rules | None detected | ✓ |
| Unsafe TS operations | error-level | ✓ |

**Finding:** Test files have `no-explicit-any: off` — intentional and appropriate for test code.

### Prettier

| Setting | Value | Conflicts |
|---|---|---|
| `semi` | `false` | None |
| `singleQuote` | `true` | None |
| `trailingComma` | `"all"` | None |
| `printWidth` | `120` | None |

No ESLint/Prettier conflicts detected.

---

## License Compliance

**Project license:** MIT (permissive)

### Root Package — License Summary

| License | Count | Packages |
|---|---|---|
| MIT | 27 | @eslint/js, @tabler/icons-react, @tailwindcss/vite, @types/*, @vitejs/plugin-react, @vitest/coverage-v8, cmdk, eslint, eslint-plugin-react-hooks, eslint-plugin-react-refresh, globals, jsdom, marked, marked-highlight, react, react-diff-view, react-dom, react-markdown, refractor, remark-gfm, typescript-eslint, vite, vitest |
| Apache-2.0 | 1 | typescript |
| MPL-2.0 OR Apache-2.0 | 1 | dompurify (dual-license, documented) |
| BSD-3-Clause | 1 | highlight.js |
| **Total** | **30** | |

### Server Package — License Summary

| License | Count | Packages |
|---|---|---|
| MIT | 9 | better-sqlite3, express, multer, ws, @types/better-sqlite3, @types/express, @types/multer, @types/ws, tsx, vitest |
| Apache-2.0 | 1 | typescript |
| **Total** | **10** | |

**Copyleft (GPL/AGPL/LGPL):** None detected.  
**Unknown/missing licenses:** None in installed packages.

**Flagged item:** `@multiplier-labs/stepflow` (declared in `workflows/package.json`) — license cannot be verified as this workspace is not installed locally. Verify before deploying workflows feature.

---

## Documentation Freshness

### README Drift

**Status: No drift detected.** The README accurately reflects:
- All `npm run` scripts match `package.json`
- Directory structure references (`src/`, `server/`) are current
- Configuration variable references (`PORT`, `REPOS_ROOT`) match `server/config.ts`
- Installation steps and prerequisites are valid

### API Docs Freshness

| Changed Item | Date | Docs Updated? | Status |
|---|---|---|---|
| `claude-opus-4-7` added to `CLAUDE_MODELS` in `src/types.ts` | 2026-04-20 | No | ⚠️ Stale |
| ProcessCoordinator session lifecycle refactor | 2026-04-13 | Partial | ✓ Acceptable |
| orchestrator-routes.ts split into sub-routers | 2026-04-08 | Yes | ✓ |

**Finding:** `docs/API-REFERENCE.md` (last updated 2026-04-08) does not mention `claude-opus-4-7`. While the API reference does not exhaustively list models, a "Supported Models" section should be added.

### JSDoc / TSDoc Coverage

- **Well documented:** `src/types.ts`, `server/types.ts`, `server/session-manager.ts`, `server/approval-manager.ts`, `src/hooks/useSessions.ts`, `src/lib/ccApi.ts`
- **Gaps (no JSDoc):** `src/lib/workflowHelpers.ts`, `src/lib/slashCommands.ts`, `server/json-parse.ts`, `server/tool-labels.ts`
- **Estimated coverage:** ~70% of exported public APIs

---

## Draft Changelog

### Commits: 2026-04-19 – 2026-04-26

#### Features
- Add Claude Opus 4.7 to available models (`8bbfbcd`, #421)

#### Fixes
- Add hard key caps to auth and webhook rate-limiter maps (`84d18eb`, #418)
- Fix hooksPath resolution and CORS PATCH method support (`f5243d5`, #432)

#### Refactoring / Chores
- Align server TypeScript version and widen ESLint server glob (`6bc2c17`, #430)
- Code review reports 2026-04-24 and 2026-04-25
- Repository health reports 2026-04-24 and 2026-04-25

#### Documentation
- Document H1 + M5 security error responses (`50d90fd`, #433)
- Address 2026-04-22 docs-audit findings (`567349e`, #429)
- Add accumulated audit reports 2026-04-16 through 2026-04-18 (#422)

---

## Stale Branches

Branches with no commit activity since 2026-03-27 (30-day threshold).

| Branch | Last Commit | Days Stale | Merged into main? | Recommendation |
|---|---|---|---|---|
| `origin/fix/symlink-bypass-spawn` | 2026-04-17 | 9 | **YES** | **Delete — merged and stale** |
| `origin/docs/session-restart-audit` | 2026-04-15 | 11 | No | Review and merge or close |
| `origin/docs/cleanup-apr15` | 2026-04-15 | 11 | No | Review and merge or close |
| `origin/feat/test-coverage-2026-04-13` | 2026-04-13 | 13 | No | Review and merge or close |
| `origin/feat/repo-health-2026-04-13` | 2026-04-13 | 13 | No | Review and merge or close |
| `origin/feat/daily-code-review-2026-04-12` | 2026-04-12 | 14 | No | Review and merge or close |
| `origin/feat/pr-373-audit-report` | 2026-04-12 | 14 | No | Review and merge or close |
| `origin/chore/pr-audit-2026-04-12` | 2026-04-12 | 14 | No | Review and merge or close |
| `origin/feat/connection-status-popup` | 2026-04-11 | 15 | No | Review and merge or close |
| `origin/test/coverage-gaps-apr10` | 2026-04-10 | 16 | No | Review and merge or close |

**Total stale branches:** 10 (1 confirmed merged, 9 unmerged)

---

## PR Hygiene

All 8 open PRs are documentation/audit reports authored by `alari76`. None have received a review decision.

| PR# | Title | Author | Days Open | Review Status | Conflicts | Stuck? |
|---|---|---|---|---|---|---|
| #422 | docs: add accumulated audit reports (2026-04-16 through 2026-04-18) | alari76 | 8 | None | Unknown | Yes |
| #413 | docs: weekly repo health report + accumulated audit reports (2026-04-15) | alari76 | 11 | None | Unknown | Yes |
| #402 | docs: session restart root cause audit | alari76 | 13 | None | Unknown | Yes |
| #396 | docs: test coverage report 2026-04-13 | alari76 | 13 | None | Unknown | Yes |
| #395 | docs: repo health report 2026-04-13 | alari76 | 13 | None | Unknown | Yes |
| #392 | docs: add daily code review report for 2026-04-12 | alari76 | 14 | None | Unknown | Yes |
| #390 | docs: PR code review audit (2026-04-12, last 7 merged) | alari76 | 14 | None | Unknown | Yes |
| #374 | docs: Add audit report for PR #373 | alari76 | 14 | None | Unknown | Yes |

**Pattern:** All PRs are docs-only from the single maintainer. The absence of reviews reflects the single-maintainer context, not neglect. However, the accumulation of 8 unmerged docs PRs is creating backlog and potential merge conflicts in `.codekin/reports/`.

---

## Merge Conflict Forecast

Active branches (commits in last 14 days) compared against `main`.

| Branch | Commits Ahead | Commits Behind | Overlapping File Areas | Risk |
|---|---|---|---|---|
| `origin/codekin/reports` | 95 | 490 | `.codekin/reports/` (95+ files) | **CRITICAL** |
| `origin/docs/audit-reports-2026-04-18` | 12 | 11 | `.codekin/reports/` | Medium |
| `origin/fix/code-review-2026-04-23` | 1 | 5 | Server routes & hooks | Medium |
| `origin/security/audit-2026-04-23-fixes` | 2 | 5 | `server/session-routes.ts` | Medium |
| `origin/chore/eslint-glob-and-ts-align` | 2 | 4 | `eslint.config.js`, `server/package.json` | Low |
| `origin/docs/api-ref-h1-m5-errors` | 2 | 1 | `docs/API-REFERENCE.md` | Low |
| `origin/test/coverage-critical-routes` | 2 | 6 | `*.test.ts` files | Low |

**Critical:** `origin/codekin/reports` is 490 commits behind main — this branch appears to be a parallel tracking branch or abandoned experiment. It should be investigated and either rebased or deleted. Do not attempt to merge it without a full rebase.

**Medium:** The 8 open docs PRs all touch `.codekin/reports/` paths. As each merges it will cause minor conflicts in subsequent PRs, but since these are additive file creations (new dated files), actual conflicts are unlikely — only ordering concerns.

---

## Recommendations

1. **Investigate `origin/codekin/reports` (Critical)** — This branch is 490 commits behind `main` and 95 ahead. Determine if it serves a purpose; if not, delete it to avoid confusion and accidental merges.

2. **Batch-merge open docs PRs (High)** — All 8 open PRs are docs-only and accumulating age. Establish an auto-merge policy for green docs PRs, or merge them in sequence now (oldest first: #374, #390, #392, #395, #396, #402, #413, #422).

3. **Delete the merged stale branch (High)** — `origin/fix/symlink-bypass-spawn` is confirmed merged into `main` and can be safely deleted: `git push origin --delete fix/symlink-bypass-spawn`.

4. **Clean up remaining stale branches (Medium)** — Review the 9 unmerged stale branches (inactive 11–16 days). Most appear to be audit-report or experimental feature branches. Delete confirmed dead ones to reduce remote branch noise.

5. **Remove 3 unused exports (Medium)** — `RepoManifest` in `src/types.ts`, `getSkillLevel` in `server/orchestrator-learning.ts`, and `getLatestReport` in `server/orchestrator-reports.ts` are unused and safe to delete. Reduces surface area and improves tree-shaking.

6. **Add Opus 4.7 to API-REFERENCE.md (Medium)** — The `claude-opus-4-7` model added on 2026-04-20 is not documented. Add a "Supported Models" section or update relevant endpoint docs.

7. **Verify `@multiplier-labs/stepflow` license (Medium)** — Before shipping the workflows feature, confirm this dependency's license is compatible with the project's MIT license.

8. **Add JSDoc to utility files (Low)** — `src/lib/workflowHelpers.ts`, `src/lib/slashCommands.ts`, `server/json-parse.ts`, and `server/tool-labels.ts` lack documentation headers. Low priority but improves contributor experience.

9. **Consider enabling `noUncheckedIndexedAccess` in tsconfig (Low)** — All TypeScript configs have `strict: true` but omit this flag. Enabling it would catch potential runtime errors from array/object indexed access patterns.

10. **Establish a docs PR auto-merge workflow (Low)** — Given the single-maintainer context and recurring automated audit reports, configuring a CI rule to auto-merge docs-only PRs when checks pass would eliminate the ongoing PR backlog without sacrificing auditability.
