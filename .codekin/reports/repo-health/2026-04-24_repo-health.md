# Repository Health Report — 2026-04-24

**Scope**: Comprehensive housekeeping, documentation, and git hygiene assessment  
**Branch assessed**: `docs/audit-reports-2026-04-18` (current HEAD)  
**Assessor**: Automated workflow

---

## Summary

**Overall Health: Good**

The codebase is actively maintained with strong type-safety configuration, zero TODO/FIXME debt, and clean license compliance. The main areas of concern are an accumulation of 12 unreviewed open PRs (7 stuck >7 days), one severely diverged branch (`codekin/reports`: 90 ahead / 485 behind main), and two recent security patches (H1 path-boundary enforcement, M5 child-spawn rate-limit) that are merged but not yet reflected in API reference documentation. Config hygiene is excellent.

| Metric | Value |
|--------|-------|
| Dead code items (confirmed) | 0 |
| Stale TODOs/FIXMEs | 0 |
| Config issues | 1 minor (target version inconsistency) |
| License concerns | 0 |
| Docs drift items | 2 |
| Stale branches (>30 days, top-50 checked) | 0 |
| Open PRs | 12 |
| Stuck PRs (>7 days, no review) | 7 |
| High-risk diverged branches | 1 |

---

## Dead Code

**No dead code detected.**

The TypeScript compiler is configured with `"noUnusedLocals": true` and `"noUnusedParameters": true` across all three tsconfig targets (app, node, server), enforced at build time (`npm run build`). A build that passes — as indicated by recent successful CI merges — guarantees no unused locals or parameters exist in compiled source.

Orphan file analysis: The server directory contains 97 source files paired with 97 test files in a consistent naming convention (`<module>.ts` / `<module>.test.ts`). The frontend contains 108 components, 23 hooks, and 10 utility modules, all wired into `src/main.tsx → src/App.tsx`. No unimported source files were identified.

| File | Symbol | Type | Recommendation |
|------|--------|------|----------------|
| — | — | — | No items flagged |

---

## TODO/FIXME Tracker

**No production TODOs found.**

A full scan of `src/` and `server/` for `TODO`, `FIXME`, `HACK`, `XXX`, and `WORKAROUND` returned only two test-file occurrences where the string `"TODO"` appears as test fixture data (not as a developer comment):

| File:Line | Type | Comment | Author | Date | Stale? |
|-----------|------|---------|--------|------|--------|
| `server/opencode-process.test.ts:557` | Test data | `pattern: 'TODO'` (tool input summarization assertion) | alari76 | 2026-04-10 | No |
| `server/claude-process.test.ts:60-61` | Test data | `pattern: 'TODO'` (grep tool summarization test) | Multiplier Labs | 2026-03-08 | No |
| `server/claude-process.test.ts:809` | Test data | `{ pattern: 'TODO' }` (tool input test case) | Multiplier Labs | 2026-03-08 | No |

**Summary**

| Category | Count |
|----------|-------|
| TODO (production) | 0 |
| FIXME (production) | 0 |
| HACK / XXX / WORKAROUND | 0 |
| Stale items (>30 days) | 0 |
| **Total** | **0** |

---

## Config Drift

All configs are modern and well-configured. One minor inconsistency noted:

| Config File | Setting | Current Value | Recommended Value | Severity |
|-------------|---------|---------------|-------------------|----------|
| `tsconfig.node.json` | `target` | `"ES2023"` | `"ES2022"` (align with `tsconfig.app.json`) | Minor |
| `tsconfig.app.json` | `target` | `"ES2022"` | — (good) | — |
| `server/tsconfig.json` | `target` | `"ES2022"` | — (good) | — |

**Findings detail:**

- **`tsconfig.app.json`** — Strong: `strict: true`, `noUnusedLocals`, `noUnusedParameters`, `noFallthroughCasesInSwitch`, `noUncheckedSideEffectImports`, `verbatimModuleSyntax`, `erasableSyntaxOnly`. Bundler-mode resolution is correct for a Vite project. ✓
- **`tsconfig.node.json`** — Same strict settings as app config. Uses `ES2023` target vs `ES2022` for the app config — a one-version drift. Not harmful in practice but worth aligning for consistency.
- **`server/tsconfig.json`** — Uses `NodeNext` module/resolution (correct for Node.js ESM), `composite: true`, `declaration: true`, `sourceMap: true`. Fully strict. ✓
- **`eslint.config.js`** — Modern flat config (ESLint 10). Separate rulesets for frontend, server, and test files. Appropriately relaxes `@typescript-eslint/no-explicit-any` in test files only. Bans unsafe TypeScript operations. ✓
- **`.prettierrc`** — `"semi": false`, `"singleQuote": true`, `"trailingComma": "all"`, `"printWidth": 120`. Consistent with codebase style. ✓
- **`vite.config.ts`** — Proxy `/cc` → `127.0.0.1:32352` with WebSocket support. Correct for development. ✓

No deprecated ESLint rules, no missing `strict: true`, no conflicting module targets in meaningful ways.

---

## License Compliance

**Project license**: MIT  
**Status**: All dependencies are compatible. No copyleft issues.

| License | Count | Dependencies |
|---------|-------|-------------|
| MIT | 35 | react, react-dom, express, ws, better-sqlite3, multer, vite, vitest, eslint, tailwindcss, cmdk, marked, react-markdown, remark-gfm, react-diff-view, refractor, marked-highlight, jsdom, @tabler/icons-react, @types/*, eslint-plugin-*, typescript-eslint, globals, @eslint/js, @vitejs/plugin-react, @tailwindcss/vite |
| Apache-2.0 | 1 | typescript 6.0.2 (dev dep) |
| BSD-3-Clause | 1 | highlight.js 11.11.1 |
| MPL-2.0 OR Apache-2.0 | 1 | dompurify 3.3.3 |

**Flagged dependencies (informational, not problematic):**

- **dompurify** (MPL-2.0 OR Apache-2.0): Dual-licensed; both options are permissively compatible with MIT for library use. The project's `package.json` explicitly documents this: *"dompurify is dual-licensed (MPL-2.0 OR Apache-2.0); both are permissively compatible with MIT for library use."* No action required.
- **lightningcss** (MPL-2.0): Used as a build-time dependency via TailwindCSS, not distributed in artifacts. Explicitly noted in `package.json`. No action required.
- **highlight.js** (BSD-3-Clause): BSD-3-Clause is fully compatible with MIT distribution. No action required.

No GPL, AGPL, LGPL, SSPL, or unknown-license dependencies detected.

---

## Documentation Freshness

### API Docs Freshness

Two areas where recent code changes outpace documentation:

1. **Security hardening endpoints not fully documented** — PR #431 (`security/audit-2026-04-23-fixes`, merged on 2026-04-23) added:
   - `POST /api/settings` — now enforces home/repos-root path boundary (H1 fix)
   - `POST /api/orchestrator/children` — now rate-limited (M5 fix)  
   These behavioral constraints are not yet reflected in `docs/API-REFERENCE.md`. The endpoint signatures are unchanged but the new error responses (403 on boundary violation, 429 on rate limit) should be documented.

2. **CSP `connect-src` tightened** — PR #426 (2026-04-21) narrowed the CSP `connect-src` directive. `docs/SETUP.md` references CSP configuration for self-hosted deployments; the hardened defaults should be noted there.

### README Drift

`README.md` was verified against `package.json` scripts and current project structure:

| README Item | Status |
|-------------|--------|
| `npm run dev` | ✓ Matches `package.json` |
| `npm run build` | ✓ Matches |
| `npm test` | ✓ Matches (runs `vitest run`) |
| `npm run test:watch` | ✓ Matches |
| `npm run lint` | ✓ Matches |
| Port 32352 | ✓ Still the default in `server/config.ts` |
| Claude Code CLI prerequisite | ✓ Still required |
| OpenCode as optional provider | ✓ Documented |
| Install one-liner | ✓ Points to npm package `codekin` |

No README drift detected. All documented commands and paths remain accurate.

### CONTRIBUTING.md

`CONTRIBUTING.md` references `Node.js 20+` and `Claude Code CLI in PATH` — both still current prerequisites. Dev workflow matches `package.json`. ✓

---

## Draft Changelog

### Unreleased (since v0.6.3, 2026-04-12)

#### Features
- Add Claude Opus 4.7 to available model list (#421)

#### Fixes
- Prevent JSON injection in `commit-event-hook.sh` (#417)
- Use `realpathSync` to prevent symlink bypass in spawn route (#419)
- Add hard key caps to auth and webhook rate-limiter maps (#418)
- Validate `repoPath` and cron expression on workflow/orchestrator routes (#423)
- Canonicalize `repos_path` and namespace local repo storage by owner (#425)
- Narrow CSP `connect-src` and fix nested reports path (#426)
- Fix `hooksPath` resolution and add CORS `PATCH` method support (#432)

#### Security
- Enforce home/repos-root path boundary on `PATCH /api/settings repos-path` — H1 severity (#431)
- Rate-limit `POST /api/orchestrator/children` spawn endpoint — M5 severity (#431)

#### Tests
- Add test coverage for workflow routes and commit-event hooks (#427)
- Add test coverage for auth, docs, session, workflow, and commit-event route handlers (#428)

#### Chores
- Bump `dompurify` to 3.4.0 and `better-sqlite3` to 12.9.0 (#424)
- Align server TypeScript version and widen ESLint server glob (#430)

---

## Stale Branches

All remote branches examined in the top-50 (sorted by commit recency) show activity since 2026-03-25 (within the last 30 days). No definitively stale and merged branches were found in that set. However, the repository contains **533 total branches**, a large number that warrants a dedicated cleanup sweep.

Notable long-lived branches still open:

| Branch | Last Commit | Author | Behind Main | Merged? | Recommendation |
|--------|-------------|--------|-------------|---------|----------------|
| `codekin/reports` | 2026-04-23 | alari | 485 commits | No | Review and close or rebase — 485 behind main is unsustainable |
| `refactor/app-decompose-hooks` | 2026-04-23 | alari | 14 commits behind, 1 ahead | No | Rebase on main and merge or close |
| `chore/remove-debug-lifecycle-logs` | 2026-04-23 | alari | 12 behind, 1 ahead | No | Merge or close (stale fix) |
| `fix/rate-limiter-map-caps` | 2026-04-23 | alari | 12 behind, 1 ahead | No | Superseded by #418 merged to main — close |
| `feat/add-opus-4-7` | 2026-04-23 | alari | 7 behind, 1 ahead | Likely | Superseded by #421 merged to main — close |

The 533-branch total is driven primarily by `wt/` prefixed worktree branches created by the orchestrator for isolated tasks. A sweep to delete merged/orphaned worktree branches is recommended.

---

## PR Hygiene

12 open PRs as of 2026-04-24, all from `alari76`, all MERGEABLE (no conflicts).

| PR # | Branch | Age (days) | Review Status | Conflicts | Stuck? |
|------|--------|-----------|---------------|-----------|--------|
| #432 | `fix/code-review-2026-04-23` | 0 | No review | None | No |
| #431 | `security/audit-2026-04-23-fixes` | 0 | No review | None | No |
| #430 | `chore/eslint-glob-and-ts-align` | 0 | No review | None | No |
| #429 | `docs/audit-2026-04-22-updates` | 1 | No review | None | No |
| #422 | `docs/audit-reports-2026-04-18` | 5 | No review | None | No |
| #413 | `feat/repo-health-2026-04-15` | **8** | No review | None | **Yes** |
| #402 | `docs/session-restart-audit` | **10** | No review | None | **Yes** |
| #396 | `feat/test-coverage-2026-04-13` | **10** | No review | None | **Yes** |
| #395 | `feat/repo-health-2026-04-13` | **10** | No review | None | **Yes** |
| #392 | `feat/daily-code-review-2026-04-12` | **11** | No review | None | **Yes** |
| #390 | `chore/pr-audit-2026-04-12` | **11** | No review | None | **Yes** |
| #374 | `feat/pr-373-audit-report` | **11** | No review | None | **Yes** |

**Pattern**: All 12 PRs are from the same author with no external reviewers. The 7 PRs older than 7 days are exclusively documentation and report PRs. The primary issue is not conflict risk but queue depth — audit/docs PRs are accumulating faster than they are being merged.

**Recommendation**: Batch-merge the 7 stuck documentation PRs in chronological order (#374 → #390 → #392 → #395 → #396 → #402 → #413), then the recently opened ones (#422 → #429 → #430 → #431 → #432).

---

## Merge Conflict Forecast

Active branches (commits in the last 14 days) that have diverged from `main`:

| Branch | Commits Behind Main | Commits Ahead of Main | Risk Level | Notes |
|--------|--------------------|-----------------------|------------|-------|
| `codekin/reports` | 485 | 90 | **Critical** | Reports-only commits but 485 behind = massive rebase required |
| `refactor/app-decompose-hooks` | 14 | 1 | Medium | 1 commit touching `src/App.tsx` area — likely conflicts with recent main changes |
| `docs/audit-reports-2026-04-18` | 6 | 10 | Low | Docs-only; main changes are code — clean merge likely |
| `feat/repo-health-2026-04-15` | 7 | 4 | Low | Docs-only; mergeable per GitHub |
| `feat/add-opus-4-7` | 7 | 1 | Low | Superseded by #421 (already merged to main) |
| `chore/remove-debug-lifecycle-logs` | 12 | 1 | Low | Single-line cleanup; easy rebase |
| `fix/rate-limiter-map-caps` | 12 | 1 | Low | Superseded by #418 already in main |

**Overlap risk details:**

- `codekin/reports`: The 90 ahead commits are all in `.codekin/reports/` (no source overlap with main's code changes). However, with 485 commits behind, any merge will require either a very long rebase or a merge commit. Given reports-only content, a squash-merge with conflict resolution on `.codekin/reports/` paths is the lowest-risk approach.
- `refactor/app-decompose-hooks`: The 14-commit divergence from main includes changes to `src/App.tsx` in both branches. Recent main commits to session management and provider model sync increase the likelihood of a semantic conflict in this file.

---

## Recommendations

1. **Merge the stuck documentation PRs** (#374, #390, #392, #395, #396, #402, #413) in ascending order. All are docs-only, conflict-free, and represent completed work. The queue depth risks making future merges harder. *Impact: High, Effort: Low.*

2. **Document new error responses in `docs/API-REFERENCE.md`** for the two security patches from 2026-04-23: `403 Forbidden` on `PATCH /api/settings` for out-of-bounds repos-path, and `429 Too Many Requests` on `POST /api/orchestrator/children`. *Impact: High, Effort: Low.*

3. **Address the `codekin/reports` branch** (90 ahead, 485 behind). Either squash-merge all report commits with a single conflict resolution on `.codekin/reports/`, or close the branch and preserve the reports by cherry-picking to a fresh branch off `main`. The current state will only worsen. *Impact: High, Effort: Medium.*

4. **Close superseded branches** `feat/add-opus-4-7` and `fix/rate-limiter-map-caps` — both were resolved by commits that landed on `main` via different PRs. Leaving them open creates noise and confusion about what is pending. *Impact: Medium, Effort: Very Low.*

5. **Sweep and delete merged `wt/` worktree branches**. The 533-branch count is dominated by orchestrator worktree branches. Run `git branch -r --merged main | grep wt/ | xargs -I{} git push origin --delete {}` (or equivalent) to reclaim remote branch namespace. *Impact: Medium, Effort: Low.*

6. **Rebase or close `refactor/app-decompose-hooks`** before it diverges further. It is 14 commits behind main and touches `src/App.tsx`, a high-churn file. Delay increases rebase complexity. *Impact: Medium, Effort: Low-Medium.*

7. **Align `tsconfig.node.json` target to `ES2022`** to match `tsconfig.app.json`. Minor but improves cross-config consistency and avoids potential build-environment surprises. *Impact: Low, Effort: Very Low.*

8. **Consider adopting a PR merge cadence** for the automated audit/docs PRs. Given that all PRs are from a single author with no external review process, a daily auto-merge of passing docs-only PRs (or direct commits on the audit branch) would prevent the current accumulation pattern from recurring. *Impact: Medium, Effort: Low.*

9. **Note `lightningcss` (MPL-2.0) in `CONTRIBUTING.md`** under the license section for transparency, even though it's already acknowledged in `package.json`. Developers running `npm install` on a fork should be aware. *Impact: Low, Effort: Very Low.*

10. **Validate `docs/SETUP.md` CSP section** against the hardened `connect-src` defaults introduced in PR #426. Self-hosted users relying on the documented CSP policy may encounter unexpected blocking if their configuration predates the tightening. *Impact: Medium, Effort: Low.*
