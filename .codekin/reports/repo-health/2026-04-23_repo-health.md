# Repository Health Report — 2026-04-23

**Project:** Codekin v0.6.3  
**Branch assessed:** `docs/audit-reports-2026-04-18` (current) + `origin/main`  
**Assessment date:** 2026-04-23

---

## Summary

**Overall health: Good**

Codekin is an actively maintained, well-structured codebase with strong TypeScript discipline, comprehensive test coverage, and no lingering technical debt markers. The primary concerns are operational rather than code quality: a growing backlog of unmerged documentation/audit PRs, one severely diverged long-lived branch (`codekin/reports`), a minor TypeScript version split between frontend and server, and ESLint coverage gaps in server subdirectories.

| Metric | Value |
|---|---|
| Dead code items | 0 |
| Stale TODO/FIXME | 0 (none found) |
| Config issues | 2 (TS version split, ESLint scope gap) |
| License concerns | Low — MPL-2.0 build-only deps; 2 deps missing lock-file license field |
| Doc drift items | 2 (docs branch pending merge; minor env path ambiguity) |
| Stale branches (>30 days) | 0 |
| Stuck PRs (>7 days, no review) | 7 |
| High conflict-risk branches | 1 (`codekin/reports`) |

---

## Dead Code

No dead code was detected across the codebase.

**Exports:** All exported functions, classes, constants, and types in `src/` and `server/` are consumed — either by other modules, route handlers, test suites, or the CLI entry point.

**Orphan files:** No source files (`.ts`, `.tsx`) were found that are not imported by at least one other module or loaded by the test runner.

**Unreachable functions:** TypeScript strict mode (`noUnusedLocals`, `noUnusedParameters`) is enforced at compile time, providing continuous dead-code detection at build time. No violations were reported.

| File | Export/Function | Type | Recommendation |
|---|---|---|---|
| — | — | — | No items to report |

---

## TODO/FIXME Tracker

No `TODO`, `FIXME`, `HACK`, `XXX`, or `WORKAROUND` comments were found in any source file under `src/` or `server/`.

The only occurrences of these keywords in the repository are:
- A grep pattern in a test expectation (`server/opencode-process.test.ts:557`) verifying that output detection works correctly.
- References in workflow markdown files documenting that TODO-tracking is part of the health audit process.

**Summary:**

| Type | Count | Stale (>30 days) |
|---|---|---|
| TODO | 0 | 0 |
| FIXME | 0 | 0 |
| HACK | 0 | 0 |
| XXX | 0 | 0 |
| WORKAROUND | 0 | 0 |
| **Total** | **0** | **0** |

---

## Config Drift

### Finding 1 — TypeScript version split between frontend and server

| Config file | Setting | Current value | Recommended value |
|---|---|---|---|
| `package.json` (root) | `typescript` | `^6.0.2` | — |
| `server/package.json` | `typescript` | `~5.9.3` | `^6.0.2` (align with root) |

The root package uses TypeScript 6.x while the server pins to `~5.9.3` (patch-compatible with 5.9 only). Both configs have identical compiler options; the version split is unnecessary and creates the risk of type-checking behaving differently between the two environments. The `~` pin also prevents receiving minor-version improvements.

**Recommendation:** Align server to `^6.0.x` or `^6.0.2` to match the frontend.

---

### Finding 2 — ESLint `files` glob does not cover server subdirectories

| Config file | Setting | Current value | Issue |
|---|---|---|---|
| `eslint.config.js` | `files` (server block) | `['server/*.ts']` | Matches only root-level `server/` files; `server/routes/**`, `server/managers/**`, and other subdirectories are excluded |

The server ESLint block uses `server/*.ts` (single-level glob), so files in nested directories such as `server/routes/`, `server/managers/`, `server/handlers/` are not linted. The strict TypeScript rules (no-unsafe-assignment, no-floating-promises, etc.) therefore do not apply to those files, creating a silent coverage gap.

**Recommendation:** Change `'server/*.ts'` to `'server/**/*.ts'` (and `'server/**/*.test.ts'` in the ignore list accordingly).

---

### Other config observations (no action required)

- **`tsconfig.app.json` vs `tsconfig.node.json` target mismatch** (`ES2022` vs `ES2023`): Intentional — the node build tools config uses ES2023 to match Node.js 20+; the frontend targets ES2022 for broader browser compatibility.
- **ESLint rules demoted to warnings:** Several `@typescript-eslint` rules are `warn` rather than `error` (e.g., `no-non-null-assertion`, `no-confusing-void-expression`). The config comments explain this is a deliberate incremental-adoption strategy. These should be promoted to `error` as the codebase is cleaned up.
- **`skipLibCheck: true`** in both tsconfig files: Standard Vite/React practice; no concern.
- **Prettier config:** No drift found. No-semicolons, single quotes, 120-char line width, trailing commas — all consistent with code style observed.

---

## License Compliance

The project is MIT-licensed. Dependency licenses are summarized below.

### License summary

| License | Count | Concern? |
|---|---|---|
| MIT | 465 | None |
| ISC | 22 | None |
| Apache-2.0 | 18 | None |
| MPL-2.0 | 12 | See note below |
| BSD-3-Clause | 9 | None |
| BSD-2-Clause | 8 | None |
| BlueOak-1.0.0 | 4 | None (permissive) |
| MIT-0 | 2 | None (public domain equivalent) |
| CC-BY-4.0 | 1 | None (documentation only) |
| (MPL-2.0 OR Apache-2.0) | 1 | None (effectively Apache-2.0) |
| (MIT OR WTFPL) | 1 | None (permissive) |
| (BSD-2-Clause OR MIT OR Apache-2.0) | 1 | None (permissive) |
| CC0-1.0 | 1 | None (public domain) |
| 0BSD | 1 | None (permissive) |
| *Missing license field in lock file* | 2 | See note below |

### Flagged dependencies

**MPL-2.0 — `lightningcss` and its platform bundles (12 entries):**  
Mozilla Public License 2.0 is a file-level copyleft license, not a project-level one. It requires modifications to MPL-licensed *files* to be released under MPL-2.0, but does not infect the rest of the project. `lightningcss` is an indirect build-time dependency pulled in by TailwindCSS/Vite — it is never distributed as part of the Codekin runtime or frontend bundle. **Risk: minimal.** No action required, but worth noting for any future commercial distribution review.

**`dompurify`: `(MPL-2.0 OR Apache-2.0)`:**  
`dompurify` is a runtime dependency (HTML sanitization). The dual-license means any user of the library can choose Apache-2.0, making it freely compatible with MIT. **Risk: none.**

**Missing license field — `busboy`, `streamsearch`:**  
These two packages have no `license` field in their `package-lock.json` entries. Both are well-known MIT-licensed packages by `mscdex` (transitive dependencies of `multer`). The missing field is a lock-file artifact, not an indication of missing upstream licenses. **Risk: none. Action:** Optionally run `license-checker` or `nlf` to confirm when convenient.

**No GPL, LGPL, or AGPL dependencies detected.**

---

## Documentation Freshness

### API docs drift — pending branch

Branch `origin/docs/audit-2026-04-22-updates` (1 commit ahead of `main`, opened as PR #429) contains updates to:
- `README.md`
- `docs/API-REFERENCE.md`
- `docs/FEATURES.md`
- `docs/GITHUB-WEBHOOKS-SPEC.md`
- `docs/ORCHESTRATOR-SPEC.md`
- `docs/PR-REVIEW-WEBHOOK.md`

These updates were triggered by the 2026-04-22 docs audit, which identified drift between code and docs. The fixes are written but unmerged. Until PR #429 lands, the docs in `main` are stale relative to the current API surface.

**Recommendation:** Merge PR #429.

### README drift

| Check | Status |
|---|---|
| `npm install` matches `package.json` | ✅ Matches |
| `npm run dev` matches `package.json` | ✅ Matches |
| `npm test` matches `package.json` | ✅ Matches |
| `npm run build` matches `package.json` | ✅ Matches |
| `npm run lint` matches `package.json` | ✅ Matches |
| Port `32352` consistent with CLAUDE.md | ✅ Matches |
| `REPOS_ROOT` default `~/repos` matches server env | ✅ Matches |
| CLI commands (`codekin token`, `codekin config`, etc.) | ✅ Present in `bin/codekin.mjs` |

**Minor observation — config file path ambiguity:**  
README says configuration lives in `~/.config/codekin/env`; CONTRIBUTING.md refers to the data directory as `~/.codekin/`. These refer to different locations (install config vs. runtime data) and are not contradictory, but a new contributor reading only the README may be confused. A single sentence clarifying the distinction would help.

### Docs coverage for recent API changes

The following endpoints/types were modified in the last 30 days and their documentation is currently pending in PR #429 (not yet in `main`):

- Orchestrator child session API (extended fields)
- Workflow `/config/repos` endpoint (canonicalized path behavior)
- CSP `connect-src` changes (narrowed scope)

---

## Draft Changelog

**Period:** 2026-04-17 through 2026-04-23 (last 7 days on `origin/main`)

### Features

- Add Claude Opus 4.7 to available models (#421)

### Fixes

- Use `realpathSync` to prevent symlink bypass in spawn route (#419)
- Prevent JSON injection in `commit-event-hook.sh` (#417)
- Add hard key caps to auth and webhook rate-limiter maps (#418)
- Validate `repoPath` and cron expression on workflow/orchestrator routes (#423)
- Canonicalize `repos_path` and namespace local repo storage by owner (#425)
- Fix nested reports path, narrow CSP `connect-src`, and address API docs drift (#426)

### Tests

- Cover workflow routes and commit-event hooks (#427)
- Cover auth, docs, session, workflow, and commit-event route handlers (#428)

### Chores

- Bump DOMPurify to 3.4.0 and better-sqlite3 to 12.9.0 (#424)
- Remove leftover blank line from debug lifecycle log cleanup (#420)

---

## Stale Branches

No remote branches have been inactive for more than 30 days (threshold: before 2026-03-24). The oldest active branch is `origin/test/coverage-gaps-apr10` (last commit 2026-04-10, 13 days ago).

| Branch | Last commit | Author | Merged into main? | Recommendation |
|---|---|---|---|---|
| `origin/test/coverage-gaps-apr10` | 2026-04-10 | alari | Squash-merged (PR #428 content) | Delete — work landed |
| `origin/feat/connection-status-popup` | 2026-04-11 | alari | Likely squash-merged | Verify and delete if merged |
| `origin/chore/pr-audit-2026-04-12` | 2026-04-12 | alari | No open PR found | Review and delete or open PR |
| `origin/feat/pr-373-audit-report` | 2026-04-12 | alari | Open PR #374 | Pending review |
| `origin/feat/daily-code-review-2026-04-12` | 2026-04-12 | alari | Open PR #392 | Pending review |
| `origin/feat/repo-health-2026-04-13` | 2026-04-13 | alari | Open PR #395 | Pending review |
| `origin/feat/test-coverage-2026-04-13` | 2026-04-13 | alari | Open PR #396 | Pending review |
| `origin/docs/session-restart-audit` | 2026-04-15 | alari | Open PR #402 | Pending review |
| `origin/docs/cleanup-apr15` | 2026-04-15 | alari | Squash-merged | Delete |
| `origin/refactor/split-orchestrator-routes` | 2026-04-15 | alari | Squash-merged | Delete |
| `origin/refactor/app-decompose-hooks` | 2026-04-15 | alari | Squash-merged | Delete |
| `origin/feat/repo-health-2026-04-15` | 2026-04-16 | alari | Open PR #413 | Pending review |
| `origin/fix/json-injection-hook` | 2026-04-17 | alari | Squash-merged (#417) | Delete |
| `origin/fix/rate-limiter-map-caps` | 2026-04-17 | alari | Squash-merged (#418) | Delete |
| `origin/fix/symlink-bypass-spawn` | 2026-04-17 | alari | Merged (#419) | Delete |
| `origin/chore/remove-debug-lifecycle-logs` | 2026-04-17 | alari | Squash-merged (#420) | Delete |
| `origin/feat/add-opus-4-7` | 2026-04-17 | alari | Squash-merged (#421) | Delete |
| `origin/fix/input-validation-2026-04-18` | 2026-04-18 | alari | Squash-merged (#423) | Delete |
| `origin/chore/bump-dompurify-better-sqlite3` | 2026-04-21 | alari | Squash-merged (#424) | Delete |
| `origin/fix/repos-path-tilde-and-owner-namespace` | 2026-04-21 | alari | Squash-merged (#425) | Delete |
| `origin/fix/nested-reports-path-csp-and-api-docs` | 2026-04-21 | alari | Squash-merged (#426) | Delete |
| `origin/test/coverage-workflow-routes-and-commit-hooks` | 2026-04-21 | alari | Squash-merged (#427) | Delete |
| `origin/test/coverage-critical-routes` | 2026-04-21 | alari | Squash-merged (#428) | Delete |
| `origin/docs/audit-2026-04-22-updates` | 2026-04-22 | alari | Open PR #429 | Merge promptly |
| `origin/docs/audit-reports-2026-04-18` | 2026-04-22 | alari | Current working branch | In progress |
| `origin/codekin/reports` | 2026-04-22 | alari | No (87 ahead / 485 behind) | See below |

**Special case — `origin/codekin/reports`:**  
This branch is 87 commits ahead and 485 commits behind `main`. It appears to be a long-running parallel branch that accumulates raw report commits without going through PRs. It has diverged so far from `main` that a conventional merge would be very painful. Consider either: (a) abandoning this branch and ensuring all future reports flow through the standard PR workflow, or (b) cherry-picking any unique report commits into the current audit PR.

---

## PR Hygiene

All 9 open PRs are authored by `alari76`. All are `MERGEABLE` (no conflicts). None have received any review activity.

| PR# | Title | Author | Days open | Review status | Conflicts? | Stuck? |
|---|---|---|---|---|---|---|
| #429 | docs: address 2026-04-22 docs-audit findings | alari76 | 1 | None | No | No |
| #422 | docs: add accumulated audit reports (2026-04-16 through 2026-04-18) | alari76 | 5 | None | No | No |
| #413 | docs: weekly repo health report + accumulated audit reports (2026-04-15) | alari76 | 8 | None | No | ⚠️ Yes |
| #402 | docs: session restart root cause audit | alari76 | 10 | None | No | ⚠️ Yes |
| #396 | docs: test coverage report 2026-04-13 | alari76 | 10 | None | No | ⚠️ Yes |
| #395 | docs: repo health report 2026-04-13 | alari76 | 10 | None | No | ⚠️ Yes |
| #392 | docs: add daily code review report for 2026-04-12 | alari76 | 11 | None | No | ⚠️ Yes |
| #390 | docs: PR code review audit (2026-04-12, last 7 merged) | alari76 | 11 | None | No | ⚠️ Yes |
| #374 | docs: Add audit report for PR #373 | alari76 | 11 | None | No | ⚠️ Yes |

**Pattern:** All open PRs are audit/documentation report PRs. None contain code changes. They are safe to merge but are accumulating without review. A batch merge of #374, #390, #392, #395, #396, #402, #413, and #422 would clear the backlog immediately.

---

## Merge Conflict Forecast

Only branches with commits in the last 14 days (since 2026-04-09) are assessed.

| Branch | Commits ahead main | Commits behind main | Overlapping files with main | Risk |
|---|---|---|---|---|
| `origin/docs/audit-2026-04-22-updates` | 1 | 0 | `README.md`, `docs/API-REFERENCE.md`, `docs/FEATURES.md`, `docs/GITHUB-WEBHOOKS-SPEC.md`, `docs/ORCHESTRATOR-SPEC.md`, `docs/PR-REVIEW-WEBHOOK.md` | 🟡 Medium — changes docs files that may receive parallel edits, but no commits behind main yet |
| `origin/docs/audit-reports-2026-04-18` | 8 | 6 | `.codekin/reports/**` only | 🟢 Low — all changes are additive report files in `.codekin/reports/`; no source overlap |
| `origin/codekin/reports` | 87 | 485 | `.codekin/reports/**` (historical) | 🔴 High — severely diverged; the 485-commit gap means any merge attempt would produce hundreds of conflicts in report files. Branch should be abandoned, not merged |

---

## Recommendations

1. **Merge the audit PR backlog (PRs #374, #390, #392, #395, #396, #402, #413, #422, #429).** All are documentation-only, conflict-free, and safe. The 7 stuck PRs represent 11 days of unreviewed reports. Batch merging them removes the backlog and prevents further divergence of the `docs/audit-reports-2026-04-18` working branch.

2. **Abandon or archive `origin/codekin/reports`.** This branch is 485 commits behind `main` and cannot be practically merged. If it contains any unique report files not present in `main`, cherry-pick those into the current audit PR. Then delete the branch.

3. **Delete squash-merged branches.** At least 11 branches (`origin/fix/json-injection-hook`, `origin/fix/rate-limiter-map-caps`, `origin/fix/symlink-bypass-spawn`, `origin/chore/remove-debug-lifecycle-logs`, `origin/feat/add-opus-4-7`, `origin/fix/input-validation-2026-04-18`, `origin/chore/bump-dompurify-better-sqlite3`, `origin/fix/repos-path-tilde-and-owner-namespace`, `origin/fix/nested-reports-path-csp-and-api-docs`, `origin/test/coverage-workflow-routes-and-commit-hooks`, `origin/test/coverage-critical-routes`) have had their work squash-merged into `main`. These remote branches are stale and should be deleted to keep the branch list navigable.

4. **Fix the ESLint server glob scope.** Change `'server/*.ts'` to `'server/**/*.ts'` in `eslint.config.js` (and the corresponding ignore from `'server/*.test.ts'` to `'server/**/*.test.ts'`). The current config silently skips all TypeScript files in server subdirectories, leaving them without the strict type-safety rules that apply to root-level server files.

5. **Align TypeScript versions.** Update `server/package.json` to use `^6.0.2` for TypeScript, matching the root. The `~5.9.3` pin diverges from the frontend and prevents the server from receiving TypeScript 6.x improvements. Run `npm install --prefix server` after updating.

6. **Promote ESLint warnings to errors.** The ESLint config demotes five rules to `warn` as an incremental adoption strategy. Begin promoting these one at a time, starting with `@typescript-eslint/no-non-null-assertion` (highest risk) and `@typescript-eslint/no-misused-promises`. Each promotion should be accompanied by fixing the violations flagged.

7. **Establish a PR merge cadence for audit reports.** Audit reports are generated daily but PRs are accumulating over 11 days without review. Consider: (a) merging report PRs immediately after generation without formal review (they're read-only report files), or (b) batching all weekly reports into a single PR to reduce PR count.

8. **Clarify config path documentation in README.** Add a sentence distinguishing the install config file (`~/.config/codekin/env`) from the runtime data directory (`~/.codekin/`) to prevent confusion for new contributors following the README.

9. **Verify license fields for `busboy` and `streamsearch`.** Run `npx license-checker --production` to confirm these transitive `multer` dependencies are MIT-licensed and update internal dependency tracking if needed. Low priority but closes the minor gap in license documentation.

10. **Address MPL-2.0 (`lightningcss`) in distribution documentation.** `lightningcss` is a build-time dependency pulled in transitively by TailwindCSS/Vite. It is not part of the distributed runtime, so there is no copyleft concern for the current use case. Document this in `CONTRIBUTING.md` or a `LICENSES.md` file if Codekin is ever packaged for commercial distribution, to ensure future contributors understand the dependency profile.
