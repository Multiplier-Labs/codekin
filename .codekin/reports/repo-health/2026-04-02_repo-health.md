# Repository Health: codekin

**Date**: 2026-04-02T03:25:26.710Z
**Repository**: /srv/repos/codekin
**Branch**: main
**Workflow Run**: a3e0819c-6e4d-4b20-8326-c8b594b0e49d
**Session**: f295fcb6-da58-4f07-932d-39934399224e

---

Now I have all the data. Let me compile the full report.Now I have all the data needed to produce the report.

```markdown
# Codekin Repository Health Assessment

**Assessment Date:** 2026-04-02
**Branch assessed:** `main` (741a9cf)
**Scope:** Full repository — frontend (`src/`), server (`server/`), config, docs, git history

---

## Summary

**Overall Health Rating: Good**

The repository is actively maintained with a healthy CI/CD workflow, strict TypeScript configuration, and zero active technical debt markers. The main areas requiring attention are a large backlog of unmerged remote branches (many superseded), two open PRs with no review activity, and a handful of stale `server/dist/` build artifacts from a pre-rename phase. Documentation is broadly up-to-date following a recent audit cycle.

| Metric | Count | Status |
|---|---|---|
| Dead code / orphan files | 0 active (1 build artifact group) | ✓ Good |
| Active TODO/FIXME items | 0 | ✓ Excellent |
| Config issues | 2 minor | ~ Fair |
| License concerns | 2 UNKNOWN (likely MIT) | ~ Minor |
| Doc drift items | 2 | ~ Minor |
| Branches older than 30 days | 0 | ✓ Good |
| Merged branches not yet deleted | 29 | ✗ Needs cleanup |
| Open PRs | 2 (0 reviewed) | ~ Monitor |
| Stuck PRs (>7 days, no review) | 1 | ~ Monitor |

---

## Dead Code

### Unused Exports / Unreachable Functions

No unused exports or unreachable functions were detected. All exported symbols in `src/` and `server/` are imported by at least one other module. Entry points `src/main.tsx` and `src/App.tsx` are correctly referenced by `index.html` and the Vite entry configuration respectively, not by TypeScript imports.

### Orphan Files

No orphan source files detected. All `.ts`/`.tsx` files in `src/` and `server/` are reachable from an entry point.

### Stale Build Artifacts

| File | Type | Recommendation |
|---|---|---|
| `server/dist/shepherd-monitor.d.ts` | Build artifact (pre-rename) | Delete — superseded by orchestrator-monitor |
| `server/dist/shepherd-learning.d.ts` | Build artifact (pre-rename) | Delete — superseded by orchestrator-learning |
| `server/dist/shepherd-routes.d.ts` | Build artifact (pre-rename) | Delete — superseded by orchestrator-routes |
| `server/dist/shepherd-memory.d.ts` | Build artifact (pre-rename) | Delete — superseded by orchestrator-memory |

These are stale `.d.ts` declaration files in `server/dist/` left over from before the shepherd→orchestrator rename (completed in PRs #268–270). They are not source files and will be overwritten on the next clean server build, but their presence in dist is misleading. A `tsc -b --clean` followed by a fresh build would eliminate them.

---

## TODO/FIXME Tracker

**Zero active TODO/FIXME/HACK/XXX/WORKAROUND comments found in production source code** (`src/` and `server/`).

The only three grep matches are in `server/claude-process.test.ts` at lines 61, 62, and 810. These are test *input data* strings used to verify that `summarizeToolInput('Grep', { pattern: 'TODO' })` returns `'TODO'` — they are not technical debt markers.

| file:line | type | comment | author | date | stale? |
|---|---|---|---|---|---|
| `server/claude-process.test.ts:61` | test data | `{ pattern: 'TODO' }` | Multiplier Labs | Initial release | N/A — not a debt marker |
| `server/claude-process.test.ts:62` | test data | `{ pattern: 'TODO' }` | Multiplier Labs | Initial release | N/A — not a debt marker |
| `server/claude-process.test.ts:810` | test data | `{ pattern: 'TODO' }` | Multiplier Labs | Initial release | N/A — not a debt marker |

**Summary:** 0 active items, 0 stale items.

---

## Config Drift

### TypeScript

All four tsconfig files (`tsconfig.json`, `tsconfig.app.json`, `tsconfig.node.json`, `server/tsconfig.json`) have `"strict": true` and additional strictness flags. No issues with strictness.

| Config file | Setting | Current value | Finding |
|---|---|---|---|
| `tsconfig.app.json` | `target` | `ES2022` | ✓ Modern and appropriate for browser |
| `tsconfig.node.json` | `target` | `ES2023` | ✓ Appropriate for Vite config (Node.js) |
| `server/tsconfig.json` | `target` | `ES2022` | ✓ Appropriate for Node 20+ |
| `tsconfig.app.json` + `tsconfig.node.json` | `moduleResolution` | `bundler` | ✓ Correct for Vite-bundled frontend |
| `server/tsconfig.json` | `moduleResolution` | `NodeNext` | ✓ Correct for native ESM server |
| All | `noUnusedLocals`, `noUnusedParameters` | `true` | ✓ Enforced at compiler level |
| All | `noFallthroughCasesInSwitch` | `true` | ✓ |
| `tsconfig.app.json` | `erasableSyntaxOnly` | `true` | ✓ TS 5.5+ flag, forward-compatible |

**No TypeScript config issues found.** The composite project setup is clean and targets are internally consistent.

### ESLint (`eslint.config.js`)

| Finding | Detail | Severity |
|---|---|---|
| Several `@typescript-eslint/no-unsafe-*` rules set to `warn` | `no-unsafe-assignment`, `no-unsafe-argument`, `no-unsafe-member-access`, `no-unsafe-return` are warnings instead of errors | Minor — labeled in-file as "pre-existing patterns for incremental adoption" |
| `@typescript-eslint/no-non-null-assertion` set to `warn` | Non-null assertions (`!`) are not errors | Minor — acceptable if team is disciplined |
| `@typescript-eslint/require-await` set to `warn` | Async functions without `await` allowed as warnings | Minor |
| `@typescript-eslint/no-misused-promises` set to `warn` | Promise misuse is not an error | Minor — worth escalating to `error` |
| Test files use `recommended` only, not `strictTypeChecked` | Lower lint bar for test files | Acceptable practice |

**Recommendation:** The demoted `warn`-level rules are explicitly commented as pre-existing debt for incremental adoption. Consider escalating `no-unsafe-*` and `no-misused-promises` to `error` as the codebase continues to mature — the TypeScript strict settings already catch most of these at compile time.

### Prettier (`.prettierrc`)

```json
{ "semi": false, "singleQuote": true, "trailingComma": "all", "printWidth": 120, "tabWidth": 2 }
```

No issues. `printWidth: 120` is wider than the conventional 80 but consistent across the codebase.

### Vite (`vite.config.ts`)

No issues. The `/cc` proxy is correctly configured for the WebSocket server on port 32352.

---

## License Compliance

**Project license:** MIT

**License distribution across direct dependencies (non-nested `node_modules`):**

| License | Count |
|---|---|
| MIT | 450 |
| ISC | 19 |
| Apache-2.0 | 17 |
| MPL-2.0 | 12 |
| BSD-3-Clause | 9 |
| BSD-2-Clause | 8 |
| MIT-0 | 2 |
| UNKNOWN | 2 |
| (MPL-2.0 OR Apache-2.0) | 1 |
| CC-BY-4.0 | 1 |
| CC0-1.0 | 1 |
| BlueOak-1.0.0 | 1 |
| 0BSD | 1 |
| (MIT OR WTFPL) | 1 |
| (BSD-2-Clause OR MIT OR Apache-2.0) | 1 |
| **Total** | **~524** |

**Flagged dependencies:**

| Package | License | Flag | Notes |
|---|---|---|---|
| `busboy` | UNKNOWN (missing lockfile field) | Low — verify | Transitive dep of `multer`. Widely known to be MIT-licensed; lockfile entry simply lacks the `license` field. Verify with `npm info busboy license`. |
| `streamsearch` | UNKNOWN (missing lockfile field) | Low — verify | Transitive dep of `busboy`. Also MIT in practice. Verify with `npm info streamsearch license`. |
| MPL-2.0 (12 packages) | MPL-2.0 | Acknowledged | `package.json` explicitly notes these are build-time only (TailwindCSS/lightningcss chain) and not distributed in the shipped artifact. No action required. |

**No GPL, AGPL, or LGPL dependencies detected.** No copyleft concern for this MIT project beyond the acknowledged MPL-2.0 build-time deps.

---

## Documentation Freshness

### API Docs / Spec Files

Nearly all server modules were modified in the last 30 days as part of the shepherd→orchestrator rename, complexity refactor, and dependency upgrades. The docs directory was also updated as part of the 2026-04-01 audit commit (`docs: fix documentation issues from weekly audit`, PR #266).

**Findings:**

| Finding | Detail |
|---|---|
| `docs/` updated in lockstep with code | The 2026-04-01 docs audit commit (PR #266) covered the same files touched in the orchestrator refactor. ✓ |
| Several spec files referenced in git log no longer exist in `docs/` | `APPROVALS-FIX-SPEC.md`, `CLAUDE-HOOKS-SPEC.md`, `DIFF-VIEWER-SPEC.md`, `DOCS-BROWSER-SPEC.md`, `codex-integration-plan.md`, `spec-claude-code-bridge.md` appear in 30-day history but are absent from current `docs/`. These were implementation specs and appear to have been intentionally removed post-implementation. No action required. |
| `stream-json-protocol.md` in `docs/` | The protocol doc should be verified against current WebSocket message types in `src/types.ts` — both were touched in the last 30 days. Consider a spot-check. |

### README Drift

| Finding | File | Detail |
|---|---|---|
| `npm run preview` undocumented | `README.md`, `CONTRIBUTING.md`, `CLAUDE.md` | The `preview` script is present in `package.json` but not mentioned in any documentation. Low impact since it is a standard Vite command. |
| All documented scripts verified accurate | `CLAUDE.md` | `dev`, `build`, `lint`, `test`, `test:watch` all match `package.json` exactly. ✓ |
| Install steps accurate | `CONTRIBUTING.md` / `README.md` | `npm install` documented correctly. ✓ |
| Port 32352 documented | `CLAUDE.md` | Matches `vite.config.ts` proxy target. ✓ |

---

## Draft Changelog

**Period:** 2026-03-28 → 2026-04-01 (since tag `v0.5.1`)

### Fixes
- Resolved 3 ESLint errors that were breaking CI pipeline (run #691)
- Fixed archived sessions not displaying worktree-based manual sessions
- Added context size management to GPT and Gemini review tools to prevent token overflow

### Features
- Added actor allowlist filter for webhook events, allowing per-actor filtering of incoming webhook payloads

### Refactoring
- Reduced code complexity across 6 high-priority areas identified in complexity audit

### Tests
- Improved code coverage across server and frontend modules

### Documentation
- Fixed documentation issues identified in weekly audit
- Improved code comments per comment assessment audit

### Chores
- Upgraded TypeScript 6, Vite 8, ESLint 10, jsdom 29
- Improved dependency health per 2026-03-31 audit
- Bumped version to `v0.5.1`
- Updated ExitPlanMode hook and bumped GPT model default
- Added skip patterns for translations, assets, and generated files

---

## Stale Branches

**Threshold for "stale":** No commit activity in the last 30 days (before 2026-03-03).

**No branches meet the 30-day staleness threshold.** The oldest branch (`chore/repo-health-report-2026-03-14`) is 19 days old as of the assessment date.

However, **29 merged branches** remain on the remote and should be pruned:

| Branch | Last Commit | Author | Merged into main? | Recommendation |
|---|---|---|---|---|
| `chore/dependency-health` | 2026-04-01 | alari | ✓ Yes | Delete — merged via PR #268/#269 |
| `docs/audit-fixes` | 2026-04-01 | alari | ✓ Yes | Delete — merged via PR #266 |
| `chore/dependency-updates-2026-03-18` | 2026-03-19 | alari | ✓ Yes | Delete |
| `chore/docs-cleanup-2026-03-18` | 2026-03-18 | alari | ✓ Yes | Delete |
| `chore/repo-health-report-2026-03-20` | 2026-03-21 | alari | ✓ Yes | Delete |
| `docs/comment-audit-improvements` | 2026-03-21 | alari | ✓ Yes | Delete |
| `docs/v0.5.0-release-notes` | 2026-03-23 | alari | ✓ Yes | Delete |
| `feat/joe-sidebar-icon-status` | 2026-03-22 | alari | ✓ Yes | Delete |
| `feat/joe-sidebar-status-dot` | 2026-03-22 | alari | ✓ Yes | Delete |
| `feat/per-session-allowed-tools` | 2026-03-19 | alari | ✓ Yes | Delete |
| `feat/shepherd-session-cleanup-api` | 2026-03-19 | alari | ✓ Yes | Delete |
| `feat/sidebar-status-tooltips` | 2026-03-22 | alari | ✓ Yes | Delete |
| `fix/agent-joe-cron-tools` | 2026-03-22 | alari | ✓ Yes | Delete |
| `fix/agent-joe-session-sidebar` | 2026-03-19 | alari | ✓ Yes | Delete |
| `fix/agent-session-icon` | 2026-03-22 | alari | ✓ Yes | Delete |
| `fix/bug-fixes-2026-03-18` | 2026-03-19 | alari | ✓ Yes | Delete |
| `fix/code-review-audit-findings` | 2026-03-21 | alari | ✓ Yes | Delete |
| `fix/cron-create-split-error` | 2026-03-22 | alari | ✓ Yes | Delete |
| `fix/increase-shepherd-concurrency` | 2026-03-19 | alari | ✓ Yes | Delete |
| `fix/native-permissions-dual-write` | 2026-03-21 | alari | ✓ Yes | Delete |
| `fix/orchestrator-listener-leak-and-type-safety` | 2026-03-24 | alari | ✓ Yes | Delete |
| `fix/orchestrator-path-guards` | 2026-03-23 | alari | ✓ Yes | Delete |
| `fix/orchestrator-session-icon-color` | 2026-03-23 | alari | ✓ Yes | Delete |
| `fix/security-hardening-2026-03-18` | 2026-03-18 | Claude (Webhook) | ✓ Yes | Delete |
| `fix/session-allowedtools-hook-bypass` | 2026-03-19 | alari | ✓ Yes | Delete |
| `fix/shepherd-icon-status-color` | 2026-03-22 | alari | ✓ Yes | Delete |
| `fix/tool-split-error` | 2026-03-22 | alari | ✓ Yes | Delete |
| `refactor/reduce-complexity-2026-03-18` | 2026-03-18 | alari | ✓ Yes | Delete |
| `test/diff-parser-coverage-2026-03-18` | 2026-03-18 | alari | ✓ Yes | Delete |
| `wt/8ea42b7c` | 2026-03-23 | alari76 | ✓ Yes | Delete — stale worktree branch |
| `wt/ec931b88` | 2026-03-23 | alari76 | ✓ Yes | Delete — stale worktree branch |

**Unmerged branches of note (not stale by date, but potentially superseded):**

| Branch | Last Commit | Ahead | Behind | Notes |
|---|---|---|---|---|
| `codekin/reports` | 2026-03-16 | 51 | 315 | 315 commits behind main — heavily diverged, unclear purpose |
| `refactor/shepherd-to-orchestrator` | 2026-03-22 | 1 | 63 | Shepherd→orchestrator work was completed via other PRs |
| `fix/remove-shepherd-rename-orchestrator` | 2026-03-22 | 1 | 60 | Likely superseded |
| `feat/joe-chat-variant` | 2026-03-17 | 1 | 168 | 168 commits behind — very stale, 1 commit ahead |
| `chore/repo-health-report-2026-03-14` | 2026-03-14 | 2 | 315 | Oldest unmerged branch, 315 behind |

---

## PR Hygiene

| PR# | Title | Author | Days Open | Review Status | Mergeable | Stuck? |
|---|---|---|---|---|---|---|
| [#263](../../pull/263) | chore: add repo health and code review reports for 2026-03-28 through 2026-03-30 | alari76 | 3 days | No reviews | Unknown | No (< 7 days) |
| [#259](../../pull/259) | chore: add repo health reports for 2026-03-25 and 2026-03-26 | alari76 | 7 days | No reviews | Unknown | ⚠ Yes (7 days, no review) |

Both PRs are human-authored chore PRs adding report files to `.codekin/reports/`. Neither has a blocking issue — they appear to be awaiting routine merge rather than review. PR #259 crosses the 7-day threshold.

**Note:** The `mergeable` field returned `UNKNOWN` from the GitHub API for both PRs, indicating GitHub has not yet computed merge status. This is not a conflict indicator — it typically means the merge check hasn't been triggered recently.

---

## Merge Conflict Forecast

Only branches with activity in the last 14 days (since 2026-03-19) are assessed.

| Branch | Last Commit | Ahead | Behind | Risk | Notes |
|---|---|---|---|---|---|
| `fix/archived-sessions-worktree-filter` | 2026-04-01 | 5 | 11 | Low | Recent branch, small divergence; server-side session filtering changes |
| `chore/repo-health-report-2026-03-30` | 2026-04-01 | 4 | 11 | Very Low | Report files only — no source overlap |
| `test/improve-coverage` | 2026-04-01 | 1 | 10 | Very Low | Test-only changes |
| `refactor/complexity-improvements` | 2026-04-01 | 1 | 10 | Low | 1 commit ahead, focused refactor |
| `docs/improve-code-comments` | 2026-03-28 | 5 | 17 | Low | Comment-only changes, no logic overlap |
| `chore/repo-health-report-2026-03-26` | 2026-03-28 | 5 | 17 | Very Low | Report files only |
| `feat/webhook-actor-allowlist` | 2026-03-29 | 1 | 15 | Very Low | Merged as PR #261 — branch should be deleted |
| `fix/review-tool-context-limits` | 2026-03-29 | 1 | 14 | Very Low | Merged as PR #262 — branch should be deleted |
| `codekin/reports` | 2026-03-16 | 51 | 315 | **High** | 315 commits behind, 51 ahead — extremely diverged; almost certain merge conflicts if ever rebased |

**Most branches carry low conflict risk** given they are 1–5 commits ahead of a main branch that has moved 10–17 commits forward. The only high-risk branch is `codekin/reports`, which has not tracked main for a very long time.

---

## Recommendations

1. **[High] Prune 31 merged/stale remote branches.** Run `git push origin --delete <branch>` for all 29 merged branches plus the 2 stale worktree branches (`wt/8ea42b7c`, `wt/ec931b88`). This reduces noise in branch listings and tooling. Consider enabling "auto-delete head branches on merge" in GitHub repo settings to prevent future accumulation.

2. **[High] Investigate and resolve `codekin/reports` branch.** This branch is 51 commits ahead and 315 commits behind `main`. Either rebase it onto main (if the commits are valuable), cherry-pick what's needed, or delete it. Its divergence will only grow. If it was a working branch for the report infrastructure, those files are now committed on `main` and this branch serves no purpose.

3. **[Medium] Merge or close PR #259.** It has been open 7 days with no review. Both open PRs are chore/report commits with no source changes — they can be merged directly without a formal review. Clearing the PR backlog prevents drift between report branches and main.

4. **[Medium] Clean up superseded shepherd-rename branches.** `refactor/shepherd-to-orchestrator`, `fix/remove-shepherd-rename-orchestrator`, and `feat/shepherd-session-cleanup-api` (merged) are unmerged or orphaned branches from the orchestrator rename work that is now complete. Review each and delete the ones superseded by merged PRs.

5. **[Medium] Run `tsc -b --clean && tsc -b` in `server/` to purge stale `shepherd-*.d.ts` build artifacts.** The four declaration files in `server/dist/` from the pre-rename era are misleading and will appear in IDE type lookups. A clean rebuild eliminates them.

6. **[Low] Escalate `@typescript-eslint/no-unsafe-*` and `no-misused-promises` from `warn` to `error` in `eslint.config.js`.** These rules are currently demoted as pre-existing debt. Given the recent complexity refactor and ESLint 10 upgrade, this is a good time to enforce them. Run `npm run lint` to see the current warning count and address them incrementally.

7. **[Low] Document `npm run preview` in CONTRIBUTING.md or CLAUDE.md.** It is present in `package.json` and is a useful command for verifying production builds locally, but is undocumented in all developer-facing docs.

8. **[Low] Verify licenses for `busboy` and `streamsearch`.** Run `npm info busboy license` and `npm info streamsearch license` to confirm they are MIT (as expected). If confirmed, consider filing a note in `package.json`'s license comment block alongside the existing DOMPurify acknowledgement.

9. **[Low] Spot-check `docs/stream-json-protocol.md` against `src/types.ts`.** Both files were modified in the last 30 days. A quick review to confirm the protocol doc reflects the current WebSocket message schema would close the loop on the orchestrator-era changes.

10. **[Info] Consider enabling GitHub branch protection auto-delete.** With 31 branches needing manual cleanup now and a pattern of high PR throughput (~270 PRs to date), enabling automatic branch deletion on merge in GitHub settings (`Settings → General → Automatically delete head branches`) would eliminate this maintenance task going forward.
```Committed and pushed the two report files on branch `chore/reports-2026-04-01`.