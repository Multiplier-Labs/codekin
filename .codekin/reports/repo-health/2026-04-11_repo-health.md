# Repository Health Report — Codekin
**Date:** 2026-04-11 | **Version:** 0.6.0 | **Branch:** main | **Assessed by:** automated workflow

---

## Summary

**Overall health: Good**

The repository is actively maintained, well-structured, and shows strong engineering discipline. TypeScript strict mode is uniformly enforced, automated audit workflows catch issues quickly, and there are no actionable TODO/FIXME comments anywhere in the production source tree. The main areas requiring attention are: (1) a backlog of unmerged—and significantly diverged—feature/chore branches that should be cleaned up or landed, (2) open report PRs that have accumulated without review, and (3) the README and API docs not yet reflecting the new OpenCode provider and PR-review webhook features shipped on 2026-04-10.

| Metric | Value |
|---|---|
| Dead code items found | 0 |
| Stale TODO/FIXME items | 0 |
| Config drift issues | 2 (minor) |
| License concerns | 1 (minor, MPL-2.0 dev-only dep) |
| Doc drift items | 3 |
| Stale remote branches (>30 days) | 0 |
| Merged branches not yet deleted | 2 |
| Open PRs | 5 |
| Stuck PRs (>7 days, no review) | 0 |
| High-divergence branches | 10 |

---

## Dead Code

No unused exports, unreachable functions, or orphan files were detected. All 72 frontend and 56 backend TypeScript modules are referenced by at least one other file. Entry points are clean: `src/main.tsx` → `App`, `server/ws-server.ts` → all server modules, `bin/codekin.mjs` → CLI.

| File | Export/Function | Type | Recommendation |
|---|---|---|---|
| — | — | — | No dead code found |

---

## TODO/FIXME Tracker

A full scan of `src/` and `server/` for `TODO`, `FIXME`, `HACK`, `XXX`, and `WORKAROUND` comment patterns returned **zero matches** in production source files. The only hits were:

- `server/claude-process.test.ts:60–61, 809` — `'TODO'` used as a literal string argument in test assertions for `summarizeToolInput()`, not a comment.
- `server/opencode-process.test.ts:480` — same pattern, test fixture data.
- `server/workflows/repo-health.weekly.md:19–22, 78, 83` — the workflow template *instructs* Claude to scan for TODOs; these are not TODO comments.

**Summary:** Total = 0 actionable items. Stale items = 0. The codebase is clean.

---

## Config Drift

### TypeScript

All three tsconfig files (`tsconfig.app.json`, `tsconfig.node.json`, `server/tsconfig.json`) enable strict mode with all flags. Targets are ES2022/ES2023, module resolution is ESNext/NodeNext — appropriate for the stack.

| Config | Setting | Current Value | Recommendation |
|---|---|---|---|
| `tsconfig.app.json` | `exclude` | Excludes `*.test.ts` but not `*.test.tsx` | Add `*.test.tsx` to exclude list for symmetry |
| `server/tsconfig.json` | `include` | `["*.ts"]` (root-level only) — subdirectories are imported transitively | Acceptable; no action needed |

No deprecated or overly permissive settings found.

### ESLint (`eslint.config.js`)

Using ESLint v10 flat config with typescript-eslint strict-type-checked preset. Several rules that would be `error` in the preset are demoted to `warn` for incremental adoption. This is intentional and not problematic, but the following are worth tracking as long-term cleanup targets:

| Rule | Current Level | Recommended Level | Notes |
|---|---|---|---|
| `@typescript-eslint/no-explicit-any` | `warn` | `error` | Only demoted in test files — acceptable |
| `@typescript-eslint/no-floating-promises` | `warn` | `error` | Frontend config; server config has it at `error` — inconsistency |
| `@typescript-eslint/no-misused-promises` | `warn` | `error` | Frontend only; server is stricter |
| `react-refresh/only-export-components` | `warn` | `warn` | Intentional for dev ergonomics — fine |

**Finding:** Server ESLint config is stricter than frontend. Consider aligning frontend warning rules to errors as tech-debt burn-down.

### Prettier (`.prettierrc`)

```json
{ "semi": false, "singleQuote": true, "trailingComma": "all", "printWidth": 120, "tabWidth": 2 }
```

No conflicts with ESLint or TypeScript config. `printWidth: 120` is wider than the common 80/100 default but consistent throughout the repo — no action needed.

### Vite (`vite.config.ts`)

Dev proxy correctly forwards `/cc/*` to `http://127.0.0.1:32352` with WebSocket support. Matches the documented backend port. No drift.

---

## License Compliance

**Project license:** MIT

**Production dependencies:**

| Package | License | Flag? |
|---|---|---|
| `better-sqlite3` | MIT | — |
| `express` | MIT | — |
| `multer` | MIT | — |
| `ws` | MIT | — |

All four production runtime dependencies are MIT. No copyleft concerns for the distributed package.

**Notable devDependencies:**

| Package | License | Flag? |
|---|---|---|
| `dompurify` | MPL-2.0 OR Apache-2.0 | Minor — dual-licensed; Apache-2.0 option is permissive and compatible with MIT distribution |
| `lightningcss` (via TailwindCSS) | MPL-2.0 | Minor — build-time only, not distributed in the npm package |
| All others | MIT / ISC / BSD / Apache-2.0 | — |

**Summary by license type:**

| License | Count (approx.) |
|---|---|
| MIT | ~50 |
| ISC | ~5 |
| Apache-2.0 | ~3 |
| MPL-2.0 or (MPL-2.0 OR Apache-2.0) | 2 (devDeps only) |
| BSD-2-Clause / BSD-3-Clause | ~3 |

**No GPL, AGPL, or LGPL dependencies detected.** The `undici` override (`^7.24.0`) is maintained for security — MIT licensed.

---

## Documentation Freshness

### API Docs / Feature Docs

| Changed Feature | Commit | Date | Docs Updated? | Verdict |
|---|---|---|---|---|
| OpenCode alternative AI provider | `6359cd4` (#322) | 2026-04-10 | `docs/API-REFERENCE.md` exists; README features list does not mention OpenCode | **Stale — README** |
| PR review via pull_request webhook | `24de04e` (#321) | 2026-04-10 | `docs/PR-REVIEW-WEBHOOK.md` exists (likely updated) | Needs verification |
| Stepflow migrated to `@multiplier-labs/stepflow` | `f7eed7f` (#333) | 2026-04-10 | Any Stepflow setup/config docs not confirmed updated | **Potentially stale** |
| Agent child session permissions expanded | `1f4b996` (#320) | 2026-04-10 | `docs/ORCHESTRATOR-SPEC.md` may not reflect new allowlist | **Potentially stale** |

### README Drift

The README.md is user-facing (install/upgrade/uninstall). Dev workflow scripts (`npm run dev`, `npm test`, etc.) are documented in `CLAUDE.md` — appropriate separation.

| README Section | Finding |
|---|---|
| Features list | Does **not** mention the new OpenCode provider as an alternative to Claude. Feature was added 2026-04-10. |
| GitHub webhooks description | Says "Automated bugfixing on CI failures via webhook integration" — now also includes PR code review. Description is incomplete post-#321. |
| CLI commands | All verified against `bin/codekin.mjs` — `token`, `config`, `service`, `setup`, `upgrade`, `uninstall`, `start` all present. No drift. |
| Configuration table (`PORT`, `REPOS_ROOT`) | Matches `server/config.ts` defaults. No drift. |
| Install one-liner | References `codekin.ai/install.sh` — external URL, cannot verify but no code change suggests this has moved. |

**Action items:**
1. Add OpenCode to the README features list.
2. Update the GitHub webhooks feature bullet to mention PR review automation.
3. Verify `docs/ORCHESTRATOR-SPEC.md` reflects the expanded child session tool allowlist from #320.

---

## Draft Changelog

_Period: since v0.5.5 tag (all commits landed on 2026-04-10) + context from 2026-04-07–09._

### v0.6.0 — 2026-04-10

#### Features
- **OpenCode provider** — Added OpenCode as an alternative AI provider with a `CodingProcess` abstraction layer; provider can be selected per session via REST API, sidebar UI, and workflows (#322, #323).
- **PR review webhook** — Added `pull_request` GitHub webhook handler for automated code review on pull requests; integrated as an event-driven workflow kind in the Workflows UI (#321, #334).
- **Agent child permissions** — Expanded agent child session tool allowlist to a curated, capability-appropriate set (#320).

#### Fixes
- Resolved lint errors that were failing CI (#330, #329).
- Addressed Apr 10 security and code review audit findings (#327).
- Respected permission mode in file-tool auto-approval hook (#316).
- Stripped uninformative agent noise lines from chat display (#313).
- Addressed three security audit findings (M1, M2, W-2/L4) (#311).
- Stripped `GIT_*` env vars when spawning Claude CLI processes (#307).
- Prevented worktree restart death loops and CWD validation failures (#305, #304).
- Resolved session restart race conditions and worktree index corruption (#301).
- Preserved `claudeSessionId` on ENOENT spawn failures (#302).

#### Refactoring
- Migrated Stepflow integration to the open-source `@multiplier-labs/stepflow` package (#333).
- Complexity quick wins: removed deprecated constructor, deduplicated methods, extracted helpers (#331).
- Extracted session lifecycle into `session-lifecycle.ts` (#308).

#### Tests
- Added coverage for session lifecycle, orchestrator children, and prompt router (#328).
- Added unit tests for session restart and worktree behaviour (#306).

#### Chores
- Bumped version to v0.6.0 (#332).
- Housekeeping: fixed contradictory comments, pruned stale branches (#315).
- Added CLAUDE.md instructions to enforce report file output (#317).

---

## Stale Branches

No remote branches have their last commit older than 30 days — all visible branches are from 2026-04-09 or 2026-04-10.

However, two branches are fully merged into `main` and should be deleted:

| Branch | Last Commit | Author | Merged? | Recommendation |
|---|---|---|---|---|
| `origin/docs/changelog-readme-v0.5.5` | 2026-04-10 | alari | Yes | **Delete** |
| `origin/fix/enforce-report-file-output` | 2026-04-10 | alari | Yes | **Delete** |

The following branches are unmerged but significantly behind `main`, suggesting they may be superseded by squash-merged PRs (common in this repo's workflow):

| Branch | Behind Main | Ahead Main | Recommendation |
|---|---|---|---|
| `chore/add-reports-2026-04-09` | 23 | 1 | Likely superseded — verify and delete |
| `chore/add-reports-2026-04-10` | 18 | 3 | Likely superseded — verify and delete |
| `chore/housekeeping-2026-04-10` | 18 | 1 | Likely superseded — verify and delete |
| `fix/file-tool-permission-mode-approval` | 17 | 1 | Likely superseded (#316 merged) — verify and delete |
| `feat/security-audit-2026-04-10` | 14 | 4 | May still be active — check PR |
| `test/coverage-gaps-apr10` | 14 | 2 | May still be active — check PR |
| `chore/code-review-2026-04-10` | 14 | 2 | Likely superseded — verify and delete |
| `chore/test-coverage-2026-04-10` | 14 | 1 | Likely superseded — verify and delete |
| `feat/agent-child-permissions` | 12 | 1 | Likely superseded (#320 merged) — verify and delete |
| `feat/pr-review-webhooks` | 12 | 1 | Likely superseded (#321 merged) — verify and delete |
| `feat/opencode-provider` | 10 | 1 | Likely superseded (#322 merged) — verify and delete |
| `fix/opencode-provider-followups` | 9 | 2 | Likely superseded (#323 merged) — verify and delete |
| `fix/apr10-audit-findings` | 8 | 2 | Likely superseded (#327 merged) — verify and delete |
| `refactor/complexity-quick-wins` | 7 | 1 | Likely superseded (#331 merged) — verify and delete |
| `feat/stepflow-open-source-migration` | 2 | 1 | Likely superseded (#333 merged) — verify and delete |
| `feat/pr-review-workflow` | 2 | 1 | Likely superseded (#334 merged) — verify and delete |

---

## PR Hygiene

All open PRs are 1–2 days old and are automated report/chore submissions. None qualify as "stuck" (threshold: >7 days with no review).

| PR# | Title | Author | Days Open | Review Status | Conflicts | Stuck? |
|---|---|---|---|---|---|---|
| #326 | docs: security audit report 2026-04-10 | alari76 | 1 | No review yet | Unknown | No |
| #325 | chore: add daily code review report for 2026-04-10 | alari76 | 1 | No review yet | Unknown | No |
| #324 | chore: test coverage report 2026-04-10 | alari76 | 1 | No review yet | Unknown | No |
| #314 | chore: add reports for 2026-04-09/10 | alari76 | 1 | No review yet | Unknown | No |
| #310 | chore: add complexity and repo-health reports for April 2026 | alari76 | 2 | No review yet | Unknown | No |

**Note:** All five open PRs are automated report submissions (security audit, code review, test coverage, complexity, repo health). These accumulate faster than they are reviewed. Consider a batch-merge strategy or auto-merge policy for report-only PRs to reduce backlog.

---

## Merge Conflict Forecast

Active branches (commits in the last 14 days) that have diverged from `main`. Conflict risk is assessed based on divergence count and the nature of files likely modified (report PRs touch only `.codekin/reports/` files and carry low conflict risk; source branches carry higher risk).

| Branch | Commits Behind | Commits Ahead | File Overlap Risk | Risk Level |
|---|---|---|---|---|
| `feat/security-audit-2026-04-10` | 14 | 4 | Source files likely modified alongside main | **Medium** |
| `test/coverage-gaps-apr10` | 14 | 2 | Test files — low overlap with current main source | **Low–Medium** |
| `chore/add-reports-2026-04-10` | 18 | 3 | Report files only (`.codekin/reports/`) | **Low** |
| `chore/add-reports-2026-04-09` | 23 | 1 | Report files only | **Low** |
| `chore/housekeeping-2026-04-10` | 18 | 1 | Small housekeeping changes — likely overlaps with #315 | **Medium** |
| `fix/file-tool-permission-mode-approval` | 17 | 1 | Permission/hook code — high churn area | **Medium** |
| All other branches (feat/*, fix/*, chore/*) | 7–12 | 1 | Likely superseded by squash-merged PRs | Low (if deletable) |

**Highest risk:** `feat/security-audit-2026-04-10` — 14 commits behind with 4 unique commits, touching source files in a period of heavy activity. If this branch is still active, rebase against `main` before merging.

---

## Recommendations

1. **Merge or close the open report PRs (#310, #314, #324, #325, #326).** All five are automated report submissions from the past two days. Establish a batch-merge or auto-merge policy for PRs that touch only `.codekin/reports/` to prevent accumulation.

2. **Delete merged remote branches** (`origin/docs/changelog-readme-v0.5.5`, `origin/fix/enforce-report-file-output`). These are confirmed merged into main and can be safely removed with `git push origin --delete <branch>`.

3. **Audit and delete superseded feature branches.** At least 14 remote branches are significantly behind main and likely correspond to squash-merged PRs. Run `git branch -r --merged origin/main` after pulling to confirm, then bulk-delete. This reduces noise in branch listings and the merge conflict forecast.

4. **Update the README features list** to mention OpenCode as an alternative AI provider. A single bullet under Features and a note in the configuration table is sufficient. (See Documentation Freshness section.)

5. **Update the GitHub webhooks README bullet** to reflect that webhooks now support both CI failure auto-fix and PR code review automation (#321).

6. **Verify and update `docs/ORCHESTRATOR-SPEC.md`** to reflect the expanded agent child session tool allowlist introduced in #320. The spec likely describes the old, more restricted set.

7. **Rebase `feat/security-audit-2026-04-10`** against main before attempting to merge. At 14 commits behind with 4 unique commits touching source files, this has the highest conflict risk of all active branches.

8. **Align frontend ESLint severity with the server config.** `@typescript-eslint/no-floating-promises` and `@typescript-eslint/no-misused-promises` are `warn` in the frontend config but `error` in the server config. Promote these to `error` in the frontend config as a low-effort, high-value consistency improvement.

9. **Add `*.test.tsx` to the `tsconfig.app.json` exclude list** for symmetry with the existing `*.test.ts` exclusion. Minor, but keeps type-checking scope consistent.

10. **Consider a CODEOWNERS file** (`.github/CODEOWNERS`). All PRs currently have no assigned reviewers, which explains the no-review status across all open PRs. A CODEOWNERS entry for `alari76` would auto-request review on future PRs and prevent report PRs from going stale.
