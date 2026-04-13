# Repository Health Report — codekin

**Date:** 2026-04-13  
**Branch assessed:** feat/daily-code-review-2026-04-12  
**HEAD:** 3db107a (v0.6.3)

---

## Summary

**Overall Health: Good**

The codebase is active and well-maintained. Three minor patch releases shipped in the last 24 hours. There are no stale TODOs, no dead code, and no license compliance issues. The primary concerns are a growing accumulation of unmerged report/audit branches, one feature branch (`feat/auto-webhook-setup`) with high merge-conflict risk against main, and 12 ESLint rules demoted from errors to warnings representing tracked technical debt.

| Metric | Count |
|---|---|
| Dead code items | 0 |
| Stale TODOs (>30 days) | 0 |
| Total TODOs in source | 0 |
| Config issues | 3 (minor) |
| License concerns | 0 |
| Documentation drift items | 2 |
| Unmerged branches (not in main) | 52 |
| Stale branches (>30 days, not merged) | 0 |
| Open PRs | 3 |
| Stuck PRs (>7 days, no review) | 0 |
| High conflict-risk branches | 1 |

---

## Dead Code

No dead exports, unreachable functions, or orphan files were detected.

All components in `src/components/` are imported by at least one other file. All `src/lib/` modules are actively referenced. Server modules in `server/` are all connected via the main entry point or route registration. Test files (`*.test.ts`, `*.test.tsx`) are excluded from this analysis by design.

| File | Export/Function | Type | Recommendation |
|---|---|---|---|
| — | — | — | No findings |

---

## TODO/FIXME Tracker

A full scan of `src/` and `server/` (excluding `node_modules`) found **zero** TODO, FIXME, HACK, XXX, or WORKAROUND comments in application source code. The only hits were in test files using `'TODO'` as a literal test-input string (not actionable comments).

| File:Line | Type | Comment | Author | Date | Stale? |
|---|---|---|---|---|---|
| — | — | — | — | — | — |

**Summary:** Total: 0 · FIXME: 0 · TODO: 0 · HACK: 0 · XXX: 0 · WORKAROUND: 0 · Stale (>30 days): 0

---

## Config Drift

### tsconfig.app.json

| Setting | Current Value | Status |
|---|---|---|
| `strict` | `true` | ✅ |
| `noUnusedLocals` | `true` | ✅ |
| `noUnusedParameters` | `true` | ✅ |
| `noFallthroughCasesInSwitch` | `true` | ✅ |
| `noUncheckedSideEffectImports` | `true` | ✅ |
| `erasableSyntaxOnly` | `true` | ✅ (TypeScript 5.5+) |
| `target` | `ES2022` | ✅ appropriate for modern browsers |

### tsconfig.node.json

| Setting | Current Value | Status |
|---|---|---|
| `target` | `ES2023` | ⚠️ One version ahead of app target (`ES2022`). Not harmful, but inconsistent — consider aligning both to `ES2022` or `ES2023`. |
| `strict` | `true` | ✅ |

### eslint.config.js

| Finding | Detail |
|---|---|
| **12 rules demoted to `warn`** | The config comment explicitly acknowledges this: *"Demote pervasive pre-existing patterns to warnings for incremental adoption."* Rules affected include `@typescript-eslint/no-non-null-assertion`, `@typescript-eslint/no-unsafe-assignment`, `@typescript-eslint/no-unsafe-member-access`, `@typescript-eslint/no-unsafe-return`, `@typescript-eslint/no-misused-promises`, and others. This is tracked technical debt — no immediate action required, but the warnings should be resolved incrementally. |
| **No Prettier config** | Not a problem per se; the project has not adopted Prettier. Consider adding it to enforce consistent formatting if contributor count grows. |
| **`server/*.ts` glob pattern** | Covers only direct children of `server/`. If subdirectories are added under `server/`, they will not be linted by the server rule block. Currently safe since all server files are at the top level. |

---

## License Compliance

Project license: **MIT**

### Runtime / bundled dependencies

| Package | License | Compatible? |
|---|---|---|
| `better-sqlite3` | MIT | ✅ |
| `express` | MIT | ✅ |
| `multer` | MIT | ✅ |
| `ws` | MIT | ✅ |
| `react` / `react-dom` | MIT | ✅ |
| `marked` / `marked-highlight` | MIT | ✅ |
| `cmdk` | MIT | ✅ |
| `react-diff-view` | MIT | ✅ |
| `highlight.js` | BSD-3-Clause | ✅ permissive |
| `dompurify` | MPL-2.0 OR Apache-2.0 | ✅ Apache-2.0 option is permissive; explicitly documented in `package.json` `licenseNotes` |

### Build-only dependencies (not distributed)

| Package | License | Note |
|---|---|---|
| `lightningcss` (via tailwind) | MPL-2.0 | ✅ build-only; explicitly noted in `package.json` `licenseNotes` |

**No GPL, AGPL, or LGPL dependencies detected. No flagged items.**

### Summary table

| License | Count |
|---|---|
| MIT | 8 |
| BSD-3-Clause | 1 |
| MPL-2.0 OR Apache-2.0 | 1 |
| MPL-2.0 (build-only) | 1 |

---

## Documentation Freshness

### README Drift

The README was updated on 2026-04-12 (commit `445bb49`) with a screenshot refresh, and on 2026-04-11 (commit `011cc66`) with OpenCode feature documentation. The install instructions, CLI command reference, feature list, and configuration table are all current.

Scripts referenced in CLAUDE.md (`npm run dev`, `npm run build`, `npm test`, `npm run lint`) all match the current `package.json` scripts. No drift detected.

### API Docs Freshness

| Doc File | Concern |
|---|---|
| `docs/WORKFLOWS.md` | The workflow provider/model picker feature was merged on 2026-04-12 (PR #375). `WORKFLOWS.md` should be reviewed to confirm provider and model selection options are documented. |
| `docs/GITHUB-WEBHOOKS-SPEC.md` / `docs/PR-REVIEW-WEBHOOK.md` | Auto-webhook setup was added in PR #391 (2026-04-12). These spec files should be reviewed to confirm the new setup wizard flow is reflected. |

The `docs/stream-json-protocol.md`, `docs/API-REFERENCE.md`, `docs/ORCHESTRATOR-SPEC.md`, and `docs/INSTALL-DISTRIBUTION.md` files were not flagged as having associated code changes in the last 30 days.

---

## Draft Changelog

### [Unreleased] / v0.6.4 — 2026-04-13

This covers commits from **v0.6.0** to **HEAD** (2026-04-06 through 2026-04-13).

#### Features

- Auto-setup GitHub webhook for PR Review workflows, including health checks and a setup wizard UI (#391, #373)
- Provider selection and searchable model picker in workflow configuration (#375)
- Searchable model picker with recents and keyboard navigation for session model selection (#368)
- Connection status popup with per-provider disable/enable toggles (#346)
- Show disconnected message for OpenCode sessions when provider is unavailable (#345)

#### Fixes

**Session Lifecycle**
- Overhauled session lifecycle to fix crashes, message loss, and duplicate notifications (#381)
- Resolved deadlock preventing Claude session start (#382)
- Fixed session restart loops caused by process lifecycle races (#379)
- Prevented message loss when Claude process exits before `system_init` (#380)
- Fixed missing `_isStarting` property on restored sessions (#361)
- Preserved user input for session naming (#378)

**OpenCode**
- Separated reasoning from text in OpenCode streaming for Kimi models
- Prevented model/session message cascade on OpenCode session start
- Fixed duplicate model messages and mixed thinking text for OpenCode sessions
- Persisted OpenCode model selection across sessions (#384)
- Persisted OpenCode provider when saving workflow config (#377)
- Probed OpenCode availability on startup for accurate connection status (#376)
- Fixed `GIT_*` env var stripping for worktree git operations (#353)
- Fixed stdio buffer deadlock in OpenCode server spawn (#352)
- Fixed duplicate messages and image attachment support (#339, #343)

**Security**
- Hardened path traversal, trust proxy, and image src allowlist (#394)
- Hardened server security: auth, rate limiting, CSP, WebSocket origin (#355)
- Prevented symlink-based path traversal in docs and reports endpoints (#358)
- Fixed CSP `connect-src` to restore WebSocket connections (#356)

**Other**
- Showed 'Session started' message immediately instead of empty chat on startup (#386)
- Fixed model validation when switching between Claude and OpenCode sessions (#363)
- Tightened retry regex patterns and deduped model dropdown entries (#372)
- Addressed 4 server correctness bugs from code review (#359)
- Fixed `NODE_ENV=test` in vitest config to prevent test failures (#371)

#### Chores

- Released v0.6.1, v0.6.2, v0.6.3
- Updated README screenshot

---

## Stale Branches

No remote branches with last commit older than 30 days (cutoff: 2026-03-13) were found that are not already merged into `main`.

The following merged branch is the only one older than 28 days:

| Branch | Last Commit | Author | Merged? | Recommendation |
|---|---|---|---|---|
| `origin/feat/oc-tag-position` | 2026-03-16 | alari | Yes | Safe to delete — already merged |

### Unmerged branches with recent activity (last 4 days)

The table below lists branches that are **not yet merged** into main but have recent commits. Most are report/audit doc branches awaiting PR merge.

| Branch | Last Commit | Ahead | Behind | Type |
|---|---|---|---|---|
| `origin/feat/auto-webhook-setup` | 2026-04-12 | 2 | 4 | Feature (see Conflict Forecast) |
| `origin/chore/pr-audit-2026-04-12` | 2026-04-12 | 1 | 16 | Report doc |
| `origin/chore/repo-health-2026-04-12` | 2026-04-12 | 1 | 31 | Report doc |
| `origin/feat/pr-373-audit-report` | 2026-04-12 | 1 | 30 | Report doc |
| `origin/feat/docs-audit-report-2026-04-11` | 2026-04-11 | 1 | 34 | Report doc |
| `origin/feat/security-audit-report-2026-04-11` | 2026-04-11 | 1 | 34 | Report doc |
| `origin/chore/repo-health-2026-04-11` | 2026-04-11 | 1 | 60 | Report doc |
| `origin/codekin/reports` | 2026-04-12 | 60 | 456 | **Severely diverged** (see below) |

> **Note on `codekin/reports`:** This branch is 60 commits ahead and 456 commits behind `main`, indicating it was created from an early point and has accumulated many report commits independently. It should either be rebased onto `main` or its contents merged and the branch retired.

---

## PR Hygiene

| PR# | Title | Author | Days Open | Review Status | Mergeable | Stuck? |
|---|---|---|---|---|---|---|
| #392 | docs: add daily code review report for 2026-04-12 | alari76 | <1 | None | ✅ | No |
| #390 | docs: PR code review audit (2026-04-12, last 7 merged) | alari76 | <1 | None | ✅ | No |
| #374 | docs: Add audit report for PR #373 | alari76 | 1 | None | ✅ | No |

All three open PRs are documentation/report PRs. None exceed the 7-day threshold for "stuck." No merge conflicts detected. The primary action item is to merge or close the accumulating report PRs to keep the branch list manageable.

---

## Merge Conflict Forecast

Only branches with commits in the last 14 days are considered. Report-only branches (single commit adding a `.md` file to `.codekin/reports/`) are excluded as they carry no conflict risk.

| Branch | Commits Ahead | Commits Behind | Overlapping Files | Risk |
|---|---|---|---|---|
| `origin/feat/auto-webhook-setup` | 2 | 4 | 6 (see below) | **HIGH** |
| `origin/feat/daily-code-review-2026-04-12` | 1 | 3 | 0 | Low |
| `origin/chore/pr-audit-2026-04-12` | 1 | 21 | 0 | Low |
| `origin/feat/connection-status-popup` | 5 | 48 | — | Stale/superseded |

**`feat/auto-webhook-setup` overlapping files with main:**

```
server/workflow-routes.ts
server/workflow-routes.test.ts
src/components/AddWorkflowModal.tsx
src/hooks/useWorkflows.ts
src/lib/workflowApi.ts
src/lib/workflowApi.test.ts
```

These are all core workflow files that have also been modified on main since the branch diverged (via PR #375: provider/model picker). This branch carries **high conflict risk** and should be rebased onto the current `main` before merging.

---

## Recommendations

1. **Merge or close the accumulating report/audit PRs (#392, #390, #374).** There are currently 3 open doc-only PRs and 10+ unmerged report branches. Establishing a regular cadence for merging these (or auto-merging after CI passes) will prevent branch list bloat.

2. **Rebase `feat/auto-webhook-setup` onto current `main`.** It has 6 overlapping files with recent main changes (PR #375). Rebasing now while the diff is small is much cheaper than resolving conflicts after further main divergence.

3. **Resolve or retire `codekin/reports` branch.** This branch is 456 commits behind main and 60 ahead — it is effectively orphaned. If its content (report files) is still needed, cherry-pick commits to a fresh branch off current `main`. Otherwise, delete it.

4. **Promote ESLint `warn` rules to `error` incrementally.** The config comment names this as intentional debt. Suggest creating a tracking issue and promoting one or two rules per sprint: start with `no-non-null-assertion` and `no-misused-promises` as high-value safety catches.

5. **Align tsconfig targets.** `tsconfig.app.json` targets `ES2022` while `tsconfig.node.json` targets `ES2023`. Standardize on `ES2023` for both (or `ES2022` if Node 18 LTS support is needed) to avoid confusion.

6. **Review `docs/WORKFLOWS.md` and webhook spec docs.** The provider/model picker (PR #375) and auto-webhook setup (PR #391) both shipped in the last 24 hours. These are user-visible features that warrant documentation updates before the next release.

7. **Delete the already-merged stale branch `origin/feat/oc-tag-position`** (2026-03-16, merged). Low priority but contributes to branch list noise.

8. **Add Prettier or an EditorConfig** if the contributor base grows. Currently the project relies on TypeScript strict mode and ESLint for correctness but has no formatter enforcement. This is fine for a small team but can cause diff noise as more contributors join.

9. **Consider auto-merge for report PRs.** Since audit and health report PRs are generated automatically and only add `.md` files to `.codekin/reports/`, enabling auto-merge (after CI) for PRs whose diff is confined to that directory would reduce manual PR overhead.

10. **Track ESLint warning count over time.** Given that 12 rules are currently warnings, adding a CI step (or periodic report) that counts total ESLint warnings would make the "incremental adoption" visible and motivate cleanup.
