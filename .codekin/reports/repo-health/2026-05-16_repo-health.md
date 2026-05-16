# Repository Health: codekin

**Date**: 2026-05-16T03:19:26.598Z
**Repository**: /srv/repos/codekin
**Branch**: main
**Workflow Run**: 3c8ae9f3-091b-4287-8019-7d74ab081b58
**Session**: 3104ae87-5d0d-42ab-971b-69bf591a5887

---

---

# Codekin Repository Health Report
**Generated**: 2026-05-16 | **Version**: v0.6.5 | **Branch**: main

---

## Summary

**Overall Health: Good**

Codekin is in strong shape: strict TypeScript across all three compilation targets, zero production TODO/FIXME debt, no orphaned source files, and a well-maintained README. The main areas needing attention are branch accumulation (8 stale unmerged branches, a massively diverged `codekin/reports` branch), one stuck PR (14 days without review), and 13 MPL-2.0 transitive packages (all `lightningcss` platform binaries, build-time only) worth noting for license tracking.

| Metric | Count | Status |
|--------|-------|--------|
| Dead code items | 0 | ✅ Excellent |
| Production TODO/FIXME | 0 | ✅ Excellent |
| Config issues | 1 minor | ✅ Good |
| License concerns (MPL-2.0) | 13 (build-time) | ⚠️ Noted |
| Doc drift items | 0 | ✅ Excellent |
| Stale unmerged branches | 8 | ⚠️ Needs cleanup |
| Stuck PRs (>7 days, no review) | 1 | ⚠️ Action needed |
| High merge-conflict risk branches | 1 | ⚠️ Action needed |

---

## Dead Code

**No dead code detected.**

TypeScript strict mode (`noUnusedLocals: true`, `noUnusedParameters: true`) is enforced across all three compilation targets (app, node, server). This acts as a structural enforcement mechanism — unused exports and unreachable code cause compile-time errors that block the build. No orphan files were found: all 85 frontend source files and ~68 backend production source files are reachable from their respective entry points.

| File | Export/Function | Type | Recommendation |
|------|----------------|------|----------------|
| — | — | — | No findings |

---

## TODO/FIXME Tracker

**No production code debt markers found.**

A full scan of `src/`, `server/`, and root config files for `TODO`, `FIXME`, `HACK`, `XXX`, and `WORKAROUND` returned zero results in production code. The only matches in the repository are literal test-fixture strings inside `server/claude-process.test.ts` (lines ~60, 809) where `'TODO'` is passed as input to `summarizeToolInput()` under test — these are intentional test inputs, not debt markers.

**Summary counts**: Total: 0 | Stale: 0 | By type: none

---

## Config Drift

Overall configuration quality is **A-tier**. All three TypeScript targets run strict mode. ESLint uses the modern flat-config API (v9+). One minor finding:

| Config File | Setting | Current Value | Recommended | Severity |
|-------------|---------|---------------|-------------|----------|
| `eslint.config.js` | `@typescript-eslint/no-non-null-assertion` | `warn` | `error` | Minor |
| `eslint.config.js` | `@typescript-eslint/no-misused-promises` | `warn` | `error` | Minor |
| `eslint.config.js` | `@typescript-eslint/require-await` | `warn` | `error` | Minor |
| `eslint.config.js` | `@typescript-eslint/restrict-template-expressions` | `warn` | `error` | Minor |
| `eslint.config.js` | `@typescript-eslint/use-unknown-in-catch-callback-variable` | `warn` | `error` | Minor |

**Notes:**
- All three `tsconfig` variants (`tsconfig.app.json`, `tsconfig.node.json`, `server/tsconfig.json`) correctly enable `strict: true`, `noUnusedLocals`, `noUnusedParameters`, `noFallthroughCasesInSwitch`, and `noUncheckedSideEffectImports`. No issues.
- `server/tsconfig.json` targets `ES2022` while frontend targets `ES2023` — this is intentional and appropriate (Node.js vs browser targets).
- `.prettierrc` uses `semi: false`, `singleQuote: true`, `trailingComma: "all"`, `printWidth: 120` — consistent and reasonable.
- ESLint's 5 demoted-to-warn rules are documented suppressions of legitimate stylistic tradeoffs, not oversight. Progressively promoting them to `error` as the codebase is cleaned would improve safety.

---

## License Compliance

**Project license**: MIT. No GPL/AGPL/LGPL dependencies detected. Two categories of weak-copyleft (MPL-2.0) packages are present and documented.

### License Summary Table (all dependencies incl. transitive)

| License | Package Count | Compatible with MIT? |
|---------|--------------|----------------------|
| MIT | 472 | ✅ Yes |
| ISC | 22 | ✅ Yes |
| Apache-2.0 | 18 | ✅ Yes |
| BSD-3-Clause | 9 | ✅ Yes |
| **MPL-2.0** | **12** | ⚠️ Weak copyleft (file-level) |
| BSD-2-Clause | 8 | ✅ Yes |
| BlueOak-1.0.0 | 4 | ✅ Yes |
| MIT-0 | 2 | ✅ Yes |
| **(MPL-2.0 OR Apache-2.0)** | **1** | ✅ Choose Apache-2.0 |
| CC-BY-4.0 | 1 | ✅ Yes (data/docs only) |
| CC0-1.0 | 1 | ✅ Yes |
| 0BSD | 1 | ✅ Yes |
| (MIT OR WTFPL) | 1 | ✅ Yes |
| (BSD-2-Clause OR MIT OR Apache-2.0) | 1 | ✅ Yes |

### Flagged Dependencies

| Package | License | Risk | Notes |
|---------|---------|------|-------|
| `lightningcss` + 11 platform variants | MPL-2.0 | Low | Build-time only (TailwindCSS CSS processor). Not shipped in runtime output. MPL-2.0 file-level copyleft applies only if you distribute modified versions of lightningcss source files themselves. |
| `dompurify` | MPL-2.0 OR Apache-2.0 | None | Dual-licensed; project may rely on the Apache-2.0 option, which is fully compatible with MIT. Already documented in `package.json` license notes. |

**Conclusion**: No action required. The MPL-2.0 packages are build-tool transitive dependencies not distributed at runtime, and the dual-licensed `dompurify` has a compatible Apache-2.0 option. No GPL/AGPL/LGPL packages detected anywhere in the dependency tree.

---

## Documentation Freshness

### API Docs Freshness

No stale documentation items detected. All five major docs files were either updated in the last 14 days or describe stable APIs that have not changed.

| Docs File | Last Assessed | Status |
|-----------|--------------|--------|
| `docs/API-REFERENCE.md` | Updated in recent security chore (#474) | ✅ Current |
| `docs/WORKFLOWS.md` | Updated in chore/security-quickwins (#474) | ✅ Current |
| `docs/SETUP.md` | Updated in chore/security-quickwins (#474) | ✅ Current |
| `docs/INSTALL-DISTRIBUTION.md` | Updated in chore/security-quickwins (#474) | ✅ Current |
| `docs/ORCHESTRATOR-SPEC.md` | Stable API surface, no recent changes | ✅ No drift |
| `docs/GITHUB-WEBHOOKS-SPEC.md` | Stable, no interface changes | ✅ No drift |
| `docs/stream-json-protocol.md` | Stable WebSocket protocol | ✅ No drift |
| `docs/FEATURES.md` | Feature list matches README | ✅ Current |

### README Drift

No drift found. Verification against `package.json`:

| README Claim | Actual | Match? |
|-------------|--------|--------|
| `npm install` | ✅ in package.json | ✅ |
| `npm run dev` | ✅ `"dev": "vite"` | ✅ |
| `npm run build` | ✅ `"build": "tsc -b && vite build"` | ✅ |
| `npm test` | ✅ `"test": "vitest run"` | ✅ |
| `npm run test:watch` | ✅ `"test:watch": "vitest"` | ✅ |
| `npm run lint` | ✅ `"lint": "eslint ."` | ✅ |
| Port 32352 (configurable) | Matches `PORT` env var docs | ✅ |
| Node.js 20+ prerequisite | Appropriate for ES2022/ESNext | ✅ |
| MIT license badge | `"license": "MIT"` in package.json | ✅ |

---

## Draft Changelog

Changes since `v0.6.5` tag (2026-05-09 → 2026-05-16):

### Fixes
- **Isolate session-naming `claude -p` from project context** (#477) — Prevents session naming calls from inheriting the active project's Claude configuration, avoiding unintended context bleed.
- **Group nested worktrees under canonical main repo in sidebar** (#476) — Sidebar now correctly clusters worktree sessions under their parent repository instead of showing them as top-level entries.
- **Server-side magic-byte validation for uploads (M2)** (#475) — Adds server-side MIME type verification via file magic bytes, completing security milestone M2 for upload hardening.

### Chores
- **Security quick-wins + docs refresh (M3/M4)** (#474) — Additional security hardening items from milestones M3 and M4; refreshes CHANGELOG, env var documentation, and WORKFLOWS docs.

### Features
- **Enforce single-branch report commit for AI workflows** (#472) — AI workflow report commits are now restricted to a single canonical branch, preventing duplicate or scattered report commits across branches.

---

## Stale Branches

Branches with no commit activity since before **2026-04-16** (>30 days ago). All 8 stale branches report as **not merged** into `main` per `git branch -r --merged`.

| Branch | Last Commit | Author | Merged into main? | Recommendation |
|--------|-------------|--------|-------------------|----------------|
| `origin/test/coverage-gaps-apr10` | 2026-04-10 | Claude (Webhook) | No | Review & delete — superseded by later coverage work |
| `origin/feat/connection-status-popup` | 2026-04-11 | alari | No | Review — feature may have been landed differently |
| `origin/feat/pr-373-audit-report` | 2026-04-12 | alari | No | Delete — audit report branches are ephemeral |
| `origin/chore/pr-audit-2026-04-12` | 2026-04-12 | alari | No | Delete — audit chore branches are ephemeral |
| `origin/feat/daily-code-review-2026-04-12` | 2026-04-12 | alari | No | Delete — audit report branch |
| `origin/feat/repo-health-2026-04-13` | 2026-04-13 | alari | No | Delete — audit report branch |
| `origin/feat/test-coverage-2026-04-13` | 2026-04-13 | alari | No | Review — may contain unmerged test improvements |
| `origin/docs/session-restart-audit` | 2026-04-15 | alari | No | Review — docs may have been incorporated elsewhere |

**Note**: `git branch -r --merged` only shows `origin/fix/security-validation-2026-04-30` and `origin/fix/security-validation-followup-2026-04-30` as explicitly merged. The stale branches above may have had their content landed via squash-merge (leaving the branch head unrecognized as merged). Manual review is warranted before deletion.

---

## PR Hygiene

| PR# | Title | Author | Days Open | Review Status | Conflicts? | Stuck? |
|-----|-------|--------|-----------|---------------|-----------|--------|
| [#478](https://github.com/Multiplier-Labs/codekin/pull/478) | fix: mock child_process in clone test to prevent CI timeout | alari76 | 1 | No review yet | No | No |
| [#464](https://github.com/Multiplier-Labs/codekin/pull/464) | chore(reports): add code-review, comment, and repo-health reports for 2026-05-01 | alari76 | 14 | No review | No | **Yes** |

**PR #464** is stuck: 14 days open with no review activity and no review requested. As a reports chore PR, it may be lower priority, but it should either be merged, closed, or have its scope clarified. Its mergeable status shows `UNKNOWN` (GitHub is recalculating), which may indicate it needs a rebase.

---

## Merge Conflict Forecast

Active branches with commits in the last 14 days, measured against `origin/main`:

| Branch | Ahead | Behind | Files Modified on Branch | Risk |
|--------|-------|--------|--------------------------|------|
| `origin/codekin/reports` | 543 | 102 | `.codekin/reports/**` (hundreds of report files), `.claude/hooks/**`, `.claude/tools/**` | **HIGH** |
| `origin/feat/enforce-workflow-report-commit` | 5 | 1 | `CHANGELOG.md`, `CONTRIBUTING.md`, `docs/INSTALL-DISTRIBUTION.md`, `docs/SETUP.md`, `docs/WORKFLOWS.md`, `package.json`, `server/claude-process.ts`, `server/session-manager.ts`, `server/session-naming.ts`, `server/upload-routes.ts`, `server/workflow-loader.ts` | Medium |
| `origin/chore/security-quickwins-and-docs-refresh` | 4 | 1 | Overlaps with security-related server files | Low-Medium |
| `origin/fix/upload-magic-byte-validation` | 4 | 2 | `server/upload-routes.ts` | Low |
| `origin/fix/worktree-sidebar-grouping` | 2 | 1 | Sidebar/session files | Low |
| `origin/wt/1cae591b` | 1 | 1 | `server/session-naming.ts` | Low |

**High-risk detail — `origin/codekin/reports`**: This branch is 543 commits ahead and 102 commits behind `main`. It appears to be a long-running accumulator branch for automated report commits. With 102 commits on `main` not yet incorporated, and hundreds of report files on the branch, a direct merge would be extremely complex. This branch likely needs a dedicated reconciliation strategy (e.g., rebase onto current `main`, or migrate the report accumulation model to avoid long-lived divergence).

---

## Recommendations

1. **[High] Resolve `origin/codekin/reports` branch divergence.** At 543 ahead / 102 behind, this branch will only become harder to reconcile. Evaluate whether the long-running accumulator model is still appropriate, or whether report branches should be short-lived (created from `main`, merged, deleted). Consider rebasing onto `main` or migrating to a per-report PR workflow.

2. **[High] Close or merge PR #464** (chore: 2026-05-01 reports). It has been open 14 days with no review. If the reports workflow now handles committing automatically, this PR may be superseded. Either merge it or close it with a comment explaining why.

3. **[Medium] Audit and clean up 8 stale remote branches** (last commit before 2026-04-16). Most appear to be ephemeral audit/report branches that were superseded. Verify each was not carrying unmerged feature work, then delete. This reduces noise in `git branch -r` and `git for-each-ref` output. Command: `git push origin --delete <branch-name>` for each confirmed safe deletion.

4. **[Medium] Investigate unmerged stale feature branches.** `origin/feat/connection-status-popup` (2026-04-11) and `origin/feat/test-coverage-2026-04-13` are not audit branches — they may contain feature or test work that was never landed. Review their diffs to determine if anything should be salvaged before deletion.

5. **[Medium] Progressively promote ESLint warnings to errors.** Five rules are currently demoted to `warn`: `no-non-null-assertion`, `no-misused-promises`, `require-await`, `restrict-template-expressions`, `use-unknown-in-catch-callback-variable`. Promoting these incrementally (one per sprint) would eliminate a class of potential runtime bugs with minimal disruption.

6. **[Low] Confirm `dompurify` Apache-2.0 license election** is documented in a `NOTICE` or `LICENSE-THIRD-PARTY` file. Currently it is only noted in a comment in `package.json`. An explicit file would be more defensible for future license audits.

7. **[Low] Consider a branch protection rule or automated cleanup cron** for `audit/*` and `chore/reports-*` branches. These are generated automatically and accumulate rapidly. A GitHub Actions workflow that deletes merged/abandoned audit branches older than 14 days would reduce clutter without manual intervention.

8. **[Low] Add a `preview` script alias note to the README.** The `npm run preview` script exists in `package.json` but is not mentioned in the README's development section. Not critical, but aids onboarding contributors who want to preview production builds locally.