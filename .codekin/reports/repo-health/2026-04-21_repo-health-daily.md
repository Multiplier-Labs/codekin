# Repository Health Report — codekin

**Date**: 2026-04-21
**Branch assessed**: docs/audit-reports-2026-04-18
**Assessor**: automated (Claude Code)

---

## Summary

**Overall Health: Good**

The codebase is in strong shape. Strict TypeScript configuration, zero production TODO debt, modern tooling (TS 6, ESLint flat config v10, Vite 8, Vitest 4), and active security hardening make this a well-maintained project. The primary concerns are housekeeping in nature: a large accumulation of squash-merged local branches that were never deleted, one untracked report file pending commit, and a handful of squash-merged remote branches that still appear open. No GPL/AGPL licenses, no real dead code, and no stale TODO comments.

| Category | Status | Count |
|---|---|---|
| Dead code items | Clean | 0 confirmed |
| Stale TODOs | Clean | 0 in production |
| Config issues | Minor | 1 note |
| License concerns | Low | 2 UNKNOWN transitive deps |
| Doc drift items | Low | 1 endpoint needing update |
| Stale remote branches | None in last 30 days | 0 |
| Squash-merged remote branches (not cleaned up) | Medium | ~11 |
| Untracked report files | 1 | `.codekin/reports/code-review/2026-04-20_code-review-daily.md` |

---

## Dead Code

TypeScript strict mode (`noUnusedLocals`, `noUnusedParameters`) is active for all three tsconfig targets. A surface-level audit of re-exported symbols was performed. All sampled exports were confirmed to have active consumers within the project.

| File | Export | Finding | Recommendation |
|---|---|---|---|
| — | — | No unused exports detected | TypeScript strict mode guards this at build time |

**Orphan files**: None detected. All source files in `src/` and `server/` are either entry points, imported by other modules, or have test counterparts that reference them.

**Note**: The untracked file `.codekin/reports/code-review/2026-04-20_code-review-daily.md` exists on disk but has not been staged or committed. It should be committed and included in the current branch's PR.

---

## TODO/FIXME Tracker

A full-text scan across `src/`, `server/`, `docs/`, and config files was performed for `TODO`, `FIXME`, `HACK`, `XXX`, and `WORKAROUND`.

**Result: Zero production code debt comments found.**

The only occurrences of the word "TODO" in the codebase appear inside unit test assertions as literal test input strings (e.g., `expect(summarizeToolInput('grep', { pattern: 'TODO' }))`), not as code debt markers.

| Metric | Count |
|---|---|
| TODO | 0 (production) |
| FIXME | 0 |
| HACK | 0 |
| XXX | 0 |
| WORKAROUND | 0 |
| Stale (>30 days) | 0 |

---

## Config Drift

### TypeScript

| Config | Setting | Current | Assessment |
|---|---|---|---|
| `tsconfig.app.json` | `strict` | `true` | Good |
| `tsconfig.app.json` | `noUnusedLocals` | `true` | Good |
| `tsconfig.app.json` | `noUnusedParameters` | `true` | Good |
| `tsconfig.app.json` | `noFallthroughCasesInSwitch` | `true` | Good |
| `tsconfig.app.json` | `erasableSyntaxOnly` | `true` | Good — forward compatible |
| `tsconfig.app.json` | `target` | `ES2022` | Appropriate for modern browsers |
| `tsconfig.node.json` | `target` | `ES2023` | Minor inconsistency vs app (ES2022) — acceptable since this covers only `vite.config.ts` |
| `server/tsconfig.json` | `strict` | `true` | Good |
| `server/tsconfig.json` | `moduleResolution` | `NodeNext` | Correct for Node.js ESM |
| `server/tsconfig.json` | `composite` | `true` | Correct for project references |

**Minor finding**: `tsconfig.app.json` targets ES2022 while `tsconfig.node.json` targets ES2023. These cover different environments (browser vs. Vite config file), so the difference is intentional, but a comment explaining this would reduce future confusion.

### ESLint

| Config | Setting | Assessment |
|---|---|---|
| `eslint.config.js` | Flat config format | Modern — correct for ESLint 10 |
| `eslint.config.js` | `tseslint.configs.strictTypeChecked` | Strong — appropriate strictness |
| `eslint.config.js` | `@typescript-eslint/no-unsafe-*` rules | Set to `error` — good |
| `eslint.config.js` | Test files use `tseslint.configs.recommended` | Weaker than production — acceptable |
| `eslint.config.js` | `server/*.ts` pattern | Covers server root only; if server gains subdirectories this would need updating |

**No deprecated rules found.** The configuration is modern and consistent.

### Prettier

| Setting | Value | Assessment |
|---|---|---|
| `semi` | `false` | Consistent |
| `singleQuote` | `true` | Consistent |
| `trailingComma` | `all` | Modern default |
| `printWidth` | `120` | Wider than community default (80), but explicitly chosen; consistent throughout |
| `tabWidth` | `2` | Standard |

No conflicts between Prettier and ESLint rules detected.

---

## License Compliance

Project license: **MIT**

### License Distribution (all dependencies, including transitive)

| License | Count | Notes |
|---|---|---|
| MIT | 465 | Permissive — compatible |
| ISC | 22 | Permissive — compatible |
| Apache-2.0 | 18 | Permissive — compatible |
| MPL-2.0 | 12 | See notes below |
| BSD-3-Clause | 9 | Permissive — compatible |
| BSD-2-Clause | 8 | Permissive — compatible |
| BlueOak-1.0.0 | 4 | Permissive — compatible |
| MIT-0 | 2 | Permissive — compatible |
| UNKNOWN | 2 | See notes below |
| CC-BY-4.0 | 1 | Attribution required; acceptable for docs/data assets |
| CC0-1.0 | 1 | Public domain — compatible |
| (MPL-2.0 OR Apache-2.0) | 1 | `dompurify` — see notes |
| (MIT OR WTFPL) | 1 | Permissive — compatible |
| (BSD-2-Clause OR MIT OR Apache-2.0) | 1 | Permissive — compatible |
| 0BSD | 1 | Public domain — compatible |

**Total: ~547 entries**

### Flagged Dependencies

| Package | License | Risk | Notes |
|---|---|---|---|
| `lightningcss` + 12 platform variants | MPL-2.0 | **Low** | Dev-only; build-time CSS transformer used by TailwindCSS. Not distributed in runtime artifacts. `package.json` includes a `licenseNotes` field documenting this explicitly. |
| `dompurify` | (MPL-2.0 OR Apache-2.0) | **Low** | Dev dependency; dual-licensed with Apache-2.0 option. `package.json` `licenseNotes` addresses this. |
| `busboy` | UNKNOWN | **Low** | Transitive dependency of `multer`. In practice MIT-licensed but not recorded in lockfile metadata. |
| `streamsearch` | UNKNOWN | **Low** | Transitive dependency of `busboy`/`multer`. In practice MIT-licensed. |

**No GPL, AGPL, or LGPL licenses found.** No action required beyond awareness. The `licenseNotes` field in `package.json` is a good practice — consider expanding it to note `busboy`/`streamsearch` as MIT in practice.

---

## Documentation Freshness

### API Docs Freshness

The last doc update was **2026-04-15** (`docs: cleanup docs for Apr 15 audit — add PR review, cross-references, roadmap restructure`). Since then, the following code changes may not be fully reflected in `docs/API-REFERENCE.md`:

| Change | PR/Commit | Doc Impact |
|---|---|---|
| `fix: validate repoPath and cron expression on workflow/orchestrator routes (#423)` | 2026-04-18 | POST endpoints for workflow and orchestrator routes now return HTTP 400 for invalid `repoPath` and `cron` inputs. Not yet documented in `docs/API-REFERENCE.md`. |
| `feat: add Claude Opus 4.7 to available models (#421)` | 2026-04-17 | The model list in docs/README may need updating to include `claude-opus-4-7`. |

### README Drift

The README was updated within the last month and largely matches the current state. No broken commands or removed features detected.

| Check | Status | Notes |
|---|---|---|
| `npm run dev` | Matches | Vite dev server |
| `npm run build` | Matches | `tsc -b && vite build` |
| `npm test` | Matches | `vitest run` |
| `npm run test:watch` | Matches | `vitest` |
| `npm run lint` | Matches | `eslint .` |
| `npm run preview` | Present in `package.json`, absent from CLAUDE.md | Minor omission; low impact |
| Feature list | Current | Reflects multi-session, orchestrator, webhooks, workflows, etc. |
| Port reference (32352) | Present in CLAUDE.md | Matches `config.ts` |

**No broken paths, removed commands, or stale examples found.**

---

## Draft Changelog

### Unreleased (since v0.6.3, last 7 days: 2026-04-14 – 2026-04-21)

#### Features
- Add Claude Opus 4.7 to available model picker (#421)

#### Fixes
- Validate `repoPath` and cron expression on workflow/orchestrator routes — reject malformed inputs with HTTP 400 (#423)
- Add hard key caps to auth and webhook rate-limiter maps to prevent unbounded growth (#418)
- Prevent JSON injection in `commit-event-hook.sh` via proper quoting (#417)
- Use `realpathSync` to prevent symlink bypass in spawn route (#419)
- Harden docs browser root scope and persist canonical paths (#409)

#### Refactoring
- Decompose `App.tsx` into focused hooks (`useGlobalKeyBindings`, `usePageVisibility`, etc.) for cleaner separation of concerns (#416)
- Split monolithic `orchestrator-routes.ts` into focused sub-routers (`orchestrator-session-router`, `orchestrator-memory-router`, `orchestrator-learning-router`) (#415)
- Enforce strict `@typescript-eslint/no-unsafe-*` rules across the entire codebase (#410, #411)

#### Documentation
- Docs cleanup for Apr 15 audit: add PR review workflow docs, cross-references, roadmap restructure (#414)
- Audit reports added: repo health 2026-04-18, 2026-04-19, 2026-04-20; test coverage 2026-04-20; code review 2026-04-18

#### Chores
- Remove leftover blank line from debug lifecycle log cleanup (#420)

---

## Stale Branches

### Remote Branches

All 21 tracked remote branches have commits within the last **11 days**. None qualify as stale (>30 days inactive).

However, several remote branches appear to contain changes already squash-merged into `main` (based on PR numbers visible in commit messages) but are not detected as merged by `git branch -r --merged main` because squash merges do not create merge commits:

| Branch | Last Commit | Author | In main? | Recommendation |
|---|---|---|---|---|
| `origin/fix/symlink-bypass-spawn` | 2026-04-17 | alari | Yes (git-detected) | Delete |
| `origin/feat/add-opus-4-7` | 2026-04-17 | alari | Yes (#421 in main) | Delete |
| `origin/chore/remove-debug-lifecycle-logs` | 2026-04-17 | alari | Yes (#420 in main) | Delete |
| `origin/fix/rate-limiter-map-caps` | 2026-04-17 | alari | Yes (#418 in main) | Delete |
| `origin/fix/json-injection-hook` | 2026-04-17 | alari | Yes (#417 in main) | Delete |
| `origin/refactor/app-decompose-hooks` | 2026-04-15 | alari | Yes (#416 in main) | Delete |
| `origin/refactor/split-orchestrator-routes` | 2026-04-15 | alari | Yes (#415 in main) | Delete |
| `origin/docs/cleanup-apr15` | 2026-04-15 | alari | Yes (#414 in main) | Delete |
| `origin/feat/repo-health-2026-04-15` | 2026-04-16 | alari | Likely (merged via PR) | Verify and delete |
| `origin/feat/test-coverage-2026-04-13` | 2026-04-13 | alari | Likely | Verify and delete |
| `origin/feat/repo-health-2026-04-13` | 2026-04-13 | alari | Likely | Verify and delete |
| `origin/feat/daily-code-review-2026-04-12` | 2026-04-12 | alari | Likely | Verify and delete |
| `origin/chore/pr-audit-2026-04-12` | 2026-04-12 | alari | Likely | Verify and delete |
| `origin/feat/pr-373-audit-report` | 2026-04-12 | alari | Likely | Verify and delete |
| `origin/docs/session-restart-audit` | 2026-04-15 | alari | Likely | Verify and delete |
| `origin/test/coverage-gaps-apr10` | 2026-04-10 | Claude (Webhook) | Likely | Verify and delete |
| `origin/feat/connection-status-popup` | 2026-04-11 | alari | Likely | Verify and delete |
| `origin/fix/input-validation-2026-04-18` | 2026-04-18 | alari | Yes (#423 in main) | Delete |
| `origin/docs/audit-reports-2026-04-18` | 2026-04-20 | alari | No (current branch) | Open PR |
| `origin/codekin/reports` | 2026-04-20 | alari | No | Review purpose |

### Local-Only Branches

There are approximately **200+ local branches** (`wt/`, `worktree-*`, named feature/fix/docs branches) that exist locally but are not pushed to the remote. Many of these are likely worktree branches from the Claude Code worktree agent. A cleanup pass using `git branch -d` (safe delete, only merged) or `git branch -D` (force) is recommended for branches whose work has landed in main.

---

## PR Hygiene

GitHub CLI (`gh`) is not available in this environment. PR status cannot be verified directly.

Based on branch names and commit log cross-reference:

- `origin/fix/input-validation-2026-04-18` corresponds to commit `a413e45` in main (PR #423) — PR is **merged and closed**.
- `origin/docs/audit-reports-2026-04-18` — this branch with 4 audit commits is pending a PR.
- `origin/codekin/reports` — purpose unclear; should be reviewed.

**Recommendation**: Enable `gh` in this environment to allow automated PR status checks in future reports.

---

## Merge Conflict Forecast

### Active Branches with Divergence from Main

| Branch | Ahead Main | Behind Main | Overlapping Files | Risk |
|---|---|---|---|---|
| `docs/audit-reports-2026-04-18` (current) | 4 | 1 | None — all changes are under `.codekin/reports/` which `main`'s recent commit (`a413e45`) does not touch | **Low** |

The one commit behind main is `fix: validate repoPath and cron expression on workflow/orchestrator routes (#423)`, which modifies `server/workflow-routes.ts` and `server/orchestrator-routes.ts`. The current branch only adds files under `.codekin/reports/`, so **no conflict is expected** on merge/rebase.

No other active branches with significant divergence were detected in the remote tracking list. All recently pushed feature/fix branches have been (or are likely) merged into main.

---

## Recommendations

1. **Commit and open a PR for the pending report file** (High impact / easy)
   `.codekin/reports/code-review/2026-04-20_code-review-daily.md` is untracked. Stage it, add it to the current branch's commit, and open the PR for `docs/audit-reports-2026-04-18`. The branch is only 1 commit behind main with no conflicts.

2. **Delete squash-merged remote branches** (Medium impact / easy)
   At least 8 remote branches (`origin/feat/add-opus-4-7`, `origin/fix/rate-limiter-map-caps`, `origin/fix/json-injection-hook`, etc.) contain work that is already in `main` via squash merge. Run `git push origin --delete <branch>` for each confirmed squash-merged branch to keep the remote clean.

3. **Update `docs/API-REFERENCE.md` to document the new 400 validation responses** (Medium impact / low effort)
   PR #423 added input validation for `repoPath` and `cron` on workflow/orchestrator route handlers. The new error responses should be documented so API consumers know to expect HTTP 400 with a validation message.

4. **Audit and clean up the 200+ local worktree branches** (Medium impact / moderate effort)
   The local branch list contains a large number of `wt/` prefixed branches from past worktree sessions. Run `git branch --merged main | grep "wt/" | xargs git branch -d` to safely remove already-merged worktree branches. For those not merged, review and delete if the work is complete.

5. **Update model list in README/docs** (Low impact / easy)
   Claude Opus 4.7 was added in #421. Verify that the README's model list and any relevant doc sections reflect this addition.

6. **Investigate `busboy` and `streamsearch` license metadata** (Low impact / easy)
   Both packages show `UNKNOWN` license in the lockfile metadata. Both are MIT in practice (easily verified on npm). Add a note to `package.json`'s `licenseNotes` to document this, consistent with the existing notes for `dompurify` and `lightningcss`.

7. **Enable `gh` CLI for automated PR hygiene in future reports** (Low impact / one-time setup)
   The current assessment cannot verify open PR status, review activity, or merge conflicts. Enabling `gh auth login` in the workflow environment would allow complete PR hygiene checks.

8. **Add `npm run preview` to CLAUDE.md script list** (Low impact / trivial)
   The `preview` script exists in `package.json` but is absent from the CLAUDE.md commands reference. Not urgent but keeps the documentation complete.

9. **Add `server/**/*.ts` ESLint glob as a future-proofing measure** (Low impact / one-time)
   `eslint.config.js` currently targets `server/*.ts` (root only). If the server directory ever gains subdirectories, files there would not be linted. Changing to `server/**/*.ts` now is a zero-cost safeguard.

10. **Consider enforcing branch deletion on PR merge via GitHub settings** (Structural / one-time)
    The accumulation of undeleted squash-merged remote branches suggests the "automatically delete head branches" setting is not enabled on the GitHub repository. Enabling it prevents future branch accumulation without any workflow change.
