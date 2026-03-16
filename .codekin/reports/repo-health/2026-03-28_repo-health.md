# Repository Health: codekin

**Date**: 2026-03-28T04:22:16.872Z
**Repository**: /srv/repos/codekin
**Branch**: chore/repo-health-report-2026-03-26
**Workflow Run**: 443d8e03-a87d-446b-8b09-9c2eccaa908e
**Session**: 28e8f4fc-163b-4d49-8aba-26671cba4eff

---

Now I have all the data needed. Here is the full report:

---

# Repository Health Report — Codekin — 2026-03-28

## Summary

**Overall Health: Good**

The repository is in good shape with active, focused development. The main areas of concern are cosmetic/hygiene issues rather than correctness problems: a large backlog of undeleted merged branches and some ESLint rules still in warning mode rather than error mode. The codebase has zero TODO/FIXME debt, strong TypeScript configuration, and clean license compliance.

| Metric | Value |
|---|---|
| Dead code items | 0 (enforced by TypeScript strict mode) |
| TODO/FIXME items | 0 actionable; 4 intentional `WORKAROUND` comments |
| Stale TODOs | n/a |
| Config issues | 1 (ESLint `unsafe-*` rules in warning mode) |
| License concerns | 0 (all permissive; MPL-2.0 is build-only) |
| Doc drift items | 1 (stream-json-protocol.md — verify against recent type changes) |
| Remote branches | 63 total; 29 confirmed merged, 32 unconfirmed |
| Open PRs | 1 (PR #259, 2 days old, no review yet) |
| Stuck PRs | 0 |
| Commits since v0.5.0 (2026-03-23) | 14 |

---

## Dead Code

No dead code detected. TypeScript is configured with `strict: true`, `noUnusedLocals: true`, and `noUnusedParameters: true` across all three tsconfig targets (frontend, node, server). A passing build (`tsc -b`) guarantees the absence of unused locals and parameters at the compiler level.

No orphan source files found — all modules in `src/` and `server/` are transitively reachable from their entry points.

| File | Export / Function | Type | Recommendation |
|---|---|---|---|
| — | — | — | No findings |

---

## TODO/FIXME Tracker

No `TODO`, `FIXME`, `HACK`, or `XXX` comments exist in the codebase. There are four occurrences of the word `workaround` used as inline documentation for a known Claude CLI limitation (the deny-with-approval-message pattern required for `ExitPlanMode`). These are intentional and do not represent deferred work.

| File:Line | Type | Comment | Author | Date | Stale? |
|---|---|---|---|---|---|
| `server/plan-manager.ts:8` | WORKAROUND (doc) | `// deny-with-message workaround for ExitPlanMode` | alari76 | 2026-03-25 | No |
| `server/plan-manager.ts:22` | WORKAROUND (doc) | `// On approve: hook returns deny-with-approval-message (CLI workaround for requiresUserInteraction)` | alari76 | 2026-03-25 | No |
| `server/session-manager.ts:1222` | WORKAROUND (doc) | `// The hook will convert allow→deny-with-approval-message (CLI workaround).` | alari76 | 2026-03-25 | No |
| `server/session-manager.ts:1464` | WORKAROUND (doc) | `// the deny-with-approval-message workaround). On deny, returns allow:false.` | alari76 | 2026-03-25 | No |

**Summary:** Total: 4 | TODO: 0 | FIXME: 0 | HACK: 0 | XXX: 0 | WORKAROUND (doc-only): 4 | Stale (>30 days): 0

---

## Config Drift

### `tsconfig.app.json` / `tsconfig.node.json` / `server/tsconfig.json`

All three TypeScript configs are well-configured and consistent with modern best practices.

| Config File | Setting | Current Value | Status |
|---|---|---|---|
| All tsconfigs | `strict` | `true` | ✓ Correct |
| All tsconfigs | `noUnusedLocals` | `true` | ✓ Correct |
| All tsconfigs | `noUnusedParameters` | `true` | ✓ Correct |
| `tsconfig.app.json` | `target` | `ES2022` | ✓ Appropriate for modern bundler |
| `server/tsconfig.json` | `module` | `NodeNext` | ✓ Correct for ESM Node.js |
| `tsconfig.app.json` | `erasableSyntaxOnly` | `true` | ✓ TypeScript 5.5+ best practice |
| `tsconfig.app.json` | `noUncheckedSideEffectImports` | `true` | ✓ Modern best practice |

No issues found in TypeScript configuration.

### `eslint.config.js`

| Config File | Setting | Current Value | Recommended Value | Notes |
|---|---|---|---|---|
| `eslint.config.js` | `@typescript-eslint/no-unsafe-assignment` | `warn` | `error` | Allows unchecked `any` assignments without blocking build |
| `eslint.config.js` | `@typescript-eslint/no-unsafe-argument` | `warn` | `error` | Same as above |
| `eslint.config.js` | `@typescript-eslint/no-unsafe-member-access` | `warn` | `error` | Same as above |
| `eslint.config.js` | `@typescript-eslint/no-unsafe-return` | `warn` | `error` | Same as above |
| `eslint.config.js` | `@typescript-eslint/no-non-null-assertion` | `warn` | `error` | Non-null assertions can cause runtime errors |
| `eslint.config.js` | `@typescript-eslint/no-misused-promises` | `warn` | `error` | Unhandled promise rejections risk |
| `eslint.config.js` | `@typescript-eslint/require-await` | `warn` | `error` | Low-risk but should be enforced |

**Assessment:** The `unsafe-*` rules being in warning mode is a deliberate incremental adoption strategy (noted in the config comments). This is acceptable for an active codebase but should be tracked toward promotion to `error`. The rule `no-floating-promises` is correctly set to `error`, which is the highest-risk async rule.

### `.prettierrc`

No issues. `semi: false`, `singleQuote: true`, `trailingComma: "all"`, `printWidth: 120`, `tabWidth: 2`. Consistent with the codebase style.

---

## License Compliance

**Project license:** MIT

All dependencies use permissive or compatible licenses. No GPL, AGPL, or copyleft licenses with distribution requirements detected.

### License Distribution (610 packages)

| License | Count | Compatible with MIT? |
|---|---|---|
| MIT | 525 | ✓ Yes |
| ISC | 23 | ✓ Yes |
| Apache-2.0 | 19 | ✓ Yes |
| MPL-2.0 | 12 | ⚠ File-level copyleft (see note) |
| BSD-3-Clause | 10 | ✓ Yes |
| BSD-2-Clause | 8 | ✓ Yes |
| BlueOak-1.0.0 | 4 | ✓ Yes |
| MIT-0 | 2 | ✓ Yes |
| 0BSD | 1 | ✓ Yes |
| CC0-1.0 | 1 | ✓ Yes |
| CC-BY-4.0 | 1 | ✓ Yes (data/docs only) |
| Python-2.0 | 1 | ✓ Yes (legacy PSF compatible) |
| `(MPL-2.0 OR Apache-2.0)` | 1 | ✓ Use Apache-2.0 variant |
| `(MIT OR WTFPL)` | 1 | ✓ Use MIT variant |
| `(BSD-2-Clause OR MIT OR Apache-2.0)` | 1 | ✓ Use MIT variant |

**MPL-2.0 note:** The primary MPL-2.0 package is `lightningcss` (used via `@tailwindcss/vite`). MPL-2.0 is file-level copyleft — modifications to MPL files must be released under MPL, but it does not require licensing the whole project under MPL. Since Codekin does not ship or modify the lightningcss source, this is a build-time dependency with no distribution risk.

**No flagged dependencies.** All licenses are compatible with MIT distribution.

---

## Documentation Freshness

### README Drift

The README.md was updated as part of the v0.5.0 release (commit `5b8ad3f`, 2026-03-23) and accurately reflects the current feature set.

| Check | Status | Notes |
|---|---|---|
| Install command (`curl -fsSL codekin.ai/install.sh \| bash`) | ✓ Current | Matches documented install flow |
| `npm run dev` | ✓ Matches | `package.json` scripts confirmed |
| `npm run build` | ✓ Matches | `tsc -b && vite build` |
| `npm test` | ✓ Matches | `vitest run` |
| `npm run test:watch` | ✓ Matches | `vitest` |
| `npm run lint` | ✓ Matches | `eslint .` |
| Feature list (orchestrator, worktrees, skills, workflows) | ✓ Current | v0.5.0 docs added 2026-03-23 |
| Max concurrent orchestrator sessions (5) | ✓ Current | Updated in #249 and spec on 2026-03-23 |

### CLAUDE.md Drift

No drift detected. Scripts section in `CLAUDE.md` matches `package.json` exactly.

### API / Type Surface Freshness

`src/types.ts` (the shared client-server WebSocket contract) has been modified 5 times in the last 7 days. The docs files should be verified against these changes:

| Doc File | Last Verified | Risk | Notes |
|---|---|---|---|
| `docs/stream-json-protocol.md` | Unknown | ⚠ Medium | `WsServerMessage` and `WsClientMessage` changed multiple times this week; verify the union types in the protocol doc match current `src/types.ts` |
| `docs/ORCHESTRATOR-SPEC.md` | 2026-03-23 | ✓ Low | Updated in #249 to reflect 5-session limit; current |
| `docs/API-REFERENCE.md` | Unknown | ⚠ Low-Medium | Review against recent session lifecycle hook additions (#235) |
| `docs/WORKFLOWS.md` | Unknown | ✓ Low | Workflow subsystem was stable in this period |
| `docs/GITHUB-WEBHOOKS-SPEC.md` | Unknown | ✓ Low | No webhook-related commits in last 30 days |

**Recommendation:** Do a targeted diff of `src/types.ts` against `docs/stream-json-protocol.md` to confirm new message types (e.g., orchestrator approval/denial message types added in `95858e5`) are documented.

---

## Draft Changelog

_Period: since v0.5.0 tag (2026-03-23) through 2026-03-28. 14 commits on main._

### [Unreleased] — 2026-03-28

#### Fixes
- **Plan mode gating**: Enforce plan mode gating via hook + PlanManager state machine, preventing entry/exit race conditions (#258)
- **Security**: Update `picomatch` to resolve high-severity audit vulnerability (automated, 2026-03-26)
- **Orchestrator**: Remove stall timer warning from orchestrator chat — warning was noisy and misleading (#256)
- **Plan mode**: Use deny-with-message pattern for ExitPlanMode hook approval, fixing approval flow for plan mode exit (#255)
- **Orchestrator UI**: Improve orchestrator empty state layout (#254)
- **Orchestrator**: Resolve listener leak, type-unsafe mutations, and wrong path in orchestrator (#253)
- **Orchestrator**: Show stall warning only once until new user input — reduces chat noise (#252)

#### Refactoring
- **PlanManager**: Replace distributed plan mode flags with a PlanManager state machine — centralises all plan mode state transitions into a single class (#257)

#### Chores
- Prune stale report files (2026-03-25)
- Add automated repo health reports for 2026-03-24, 2026-03-25, 2026-03-26, 2026-03-27

---

## Stale Branches

**Definition:** branches with no commit activity in the last 30 days. Today is 2026-03-28; the 30-day cutoff is 2026-02-27. The oldest remote branch (`chore/repo-health-report-2026-03-14`) is only 14 days old — **no branches exceed the 30-day staleness threshold.**

However, **29 branches are confirmed merged into `main`** and should be deleted as routine housekeeping. An additional 32 branches are unmerged per `git branch -r --no-merged` but may have been squash-merged (their content is in main via PR merge commits, but their branch HEAD is not an ancestor of main).

### Confirmed Merged — Safe to Delete (29 branches)

| Branch | Last Commit | Author | Merged into main? | Recommendation |
|---|---|---|---|---|
| `origin/chore/dependency-updates-2026-03-18` | 2026-03-19 | alari | Yes | Delete |
| `origin/chore/docs-cleanup-2026-03-18` | 2026-03-18 | alari | Yes | Delete |
| `origin/chore/repo-health-report-2026-03-20` | 2026-03-21 | alari | Yes | Delete |
| `origin/docs/comment-audit-improvements` | 2026-03-21 | alari | Yes | Delete |
| `origin/docs/v0.5.0-release-notes` | 2026-03-23 | alari | Yes | Delete |
| `origin/feat/joe-sidebar-icon-status` | 2026-03-22 | alari | Yes | Delete |
| `origin/feat/joe-sidebar-status-dot` | 2026-03-22 | alari | Yes | Delete |
| `origin/feat/per-session-allowed-tools` | 2026-03-19 | alari | Yes | Delete |
| `origin/feat/shepherd-session-cleanup-api` | 2026-03-19 | alari | Yes | Delete |
| `origin/feat/sidebar-status-tooltips` | 2026-03-22 | alari | Yes | Delete |
| `origin/fix/agent-joe-cron-tools` | 2026-03-22 | alari | Yes | Delete |
| `origin/fix/agent-joe-session-sidebar` | 2026-03-19 | alari | Yes | Delete |
| `origin/fix/agent-session-icon` | 2026-03-22 | alari | Yes | Delete |
| `origin/fix/bug-fixes-2026-03-18` | 2026-03-19 | alari | Yes | Delete |
| `origin/fix/code-review-audit-findings` | 2026-03-21 | alari | Yes | Delete |
| `origin/fix/cron-create-split-error` | 2026-03-22 | alari | Yes | Delete |
| `origin/fix/increase-shepherd-concurrency` | 2026-03-19 | alari | Yes | Delete |
| `origin/fix/native-permissions-dual-write` | 2026-03-21 | alari | Yes | Delete |
| `origin/fix/orchestrator-listener-leak-and-type-safety` | 2026-03-24 | alari | Yes | Delete |
| `origin/fix/orchestrator-path-guards` | 2026-03-23 | alari | Yes | Delete |
| `origin/fix/orchestrator-session-icon-color` | 2026-03-23 | alari | Yes | Delete |
| `origin/fix/security-hardening-2026-03-18` | 2026-03-18 | Claude (Webhook) | Yes | Delete |
| `origin/fix/session-allowedtools-hook-bypass` | 2026-03-19 | alari | Yes | Delete |
| `origin/fix/shepherd-icon-status-color` | 2026-03-22 | alari | Yes | Delete |
| `origin/fix/tool-split-error` | 2026-03-22 | alari | Yes | Delete |
| `origin/refactor/reduce-complexity-2026-03-18` | 2026-03-18 | alari | Yes | Delete |
| `origin/test/diff-parser-coverage-2026-03-18` | 2026-03-18 | alari | Yes | Delete |
| `origin/wt/8ea42b7c` | 2026-03-23 | alari76 | Yes | Delete (stale worktree branch) |
| `origin/wt/ec931b88` | 2026-03-23 | alari76 | Yes | Delete (stale worktree branch) |

### Unmerged but Likely Superseded (32 branches)

These branches are not direct ancestors of `main` (possibly squash-merged) but appear inactive. Notable examples:

| Branch | Last Commit | Notes |
|---|---|---|
| `origin/chore/repo-health-report-2026-03-14` | 2026-03-14 | Report content committed to main separately |
| `origin/codekin/reports` | 2026-03-16 | Appears superseded |
| `origin/feat/joe-chat-variant` | 2026-03-17 | Likely superseded by orchestrator rename work |
| `origin/fix/suppress-orchestrator-noise` | 2026-03-24 | Content merged via #251 — 11 commits behind main |
| `origin/chore/repo-health-report-2026-03-25` | 2026-03-25 | Open PR #259 — do not delete yet |
| `origin/refactor/plan-manager-state-machine` | 2026-03-25 | Content merged via #257 |
| `origin/fix/plan-mode-gating-enforcement` | 2026-03-25 | Content merged via #258 |

---

## PR Hygiene

| PR# | Title | Author | Days Open | Review Status | Conflicts? | Stuck? |
|---|---|---|---|---|---|---|
| #259 | chore: add repo health reports for 2026-03-25 and 2026-03-26 | alari76 | 2 | No review yet | No (MERGEABLE) | No (< 7 days) |

**Assessment:** Only one open PR. It is 2 days old, has no review decision, and is mergeable. Not yet stuck (threshold: 7 days). No action required beyond normal review flow.

---

## Merge Conflict Forecast

Active branches (commits in the last 14 days) assessed for divergence from `main`:

| Branch | Commits Ahead | Commits Behind | Overlapping Files | Risk |
|---|---|---|---|---|
| `chore/repo-health-report-2026-03-26` (current) | 3 | 0 | `.codekin/reports/` only | None — no source overlap |
| `origin/chore/repo-health-report-2026-03-25` (PR #259) | 2 | 2 | `.codekin/reports/` only | Low — report files only |
| `origin/fix/suppress-orchestrator-noise` | 2 | 11 | `server/session-manager.ts` (likely) | Medium if not already superseded |
| `origin/refactor/plan-manager-state-machine` | 1 | 2 | `server/plan-manager.ts`, `server/session-manager.ts` | Low — content squash-merged via #257 |
| `origin/fix/plan-mode-gating-enforcement` | 1 | 1 | `server/plan-manager.ts` | Low — content squash-merged via #258 |

**Note:** `origin/fix/suppress-orchestrator-noise` is 11 commits behind main and touches `server/session-manager.ts`, which has been heavily modified in the same period. If this branch is not already abandoned, rebasing it would likely produce conflicts in that file. Recommend verifying it is superseded before deleting.

All other currently active work is on the current report branch which modifies only `.codekin/reports/` — zero conflict risk with any ongoing development.

---

## Recommendations

1. **[High] Delete 29 confirmed-merged remote branches.** Run `git push origin --delete <branch>` for all branches listed in the "Confirmed Merged" table. At 29 branches, this is actionable in a single batch command. Keeping the remote tidy reduces confusion about what is in-flight.

2. **[High] Verify `docs/stream-json-protocol.md` against current `src/types.ts`.** The shared WebSocket message types (`WsServerMessage`, `WsClientMessage`) have had 5 commits in 7 days. The protocol doc is the primary reference for any external integrations and should be checked for drift against the new orchestrator message types (gray approval/denial messages, stall warnings, plan mode transitions).

3. **[Medium] Review and merge or close PR #259.** The report branch PR has been open 2 days with no review. These are chore commits (report files) that do not need review scrutiny, but letting them accumulate delays the branch cleanup cycle.

4. **[Medium] Establish a branch cleanup policy.** The volume of undeleted branches (63 total, growing daily with the report-branch workflow) will make branch management increasingly burdensome. Consider adding automatic branch deletion on PR merge via GitHub repository settings ("Automatically delete head branches").

5. **[Medium] Promote ESLint `unsafe-*` rules from `warn` to `error`.** The current config explicitly notes these are in warning mode for incremental adoption. Given the codebase's maturity and TypeScript strict mode already being enforced, tightening `no-unsafe-assignment`, `no-unsafe-argument`, `no-unsafe-member-access`, and `no-unsafe-return` to errors would close a gap in type safety enforcement at lint time.

6. **[Medium] Audit `docs/API-REFERENCE.md` against session lifecycle hook additions.** Commit `4cdabef` (feat: session lifecycle hooks and orchestrator approval endpoints, #235, 2026-03-23) added new API surface in the server. Verify these endpoints are reflected in the API reference.

7. **[Low] Verify `origin/fix/suppress-orchestrator-noise` is truly abandoned.** This branch is 11 commits behind main and likely superseded by #251. Confirm its content was merged, then delete it to avoid it appearing as an active work item.

8. **[Low] Consider graduating `feat/joe-chat-variant` and `codekin/reports` branches.** Both are 11–12 days old and predate the orchestrator rename. If their content was never merged (not squash-merged either), decide whether to abandon or rebase. The `feat/joe-chat-variant` name suggests it may be relevant to current orchestrator chat work.

9. **[Low] Pin the `picomatch` override in `package.json` with an explanatory comment.** The automated security fix (88fad4f) added a picomatch override but the `overrides` section in `package.json` may not explain why it exists. Future maintainers should know this is a transitive security pin, not an intentional version downgrade.

10. **[Low] Monitor commit velocity in `server/session-manager.ts`.** This file has been modified in 15+ commits over 14 days across plan mode, orchestrator, approval, and AskUserQuestion subsystems. It is the highest-churn file in the codebase and may benefit from a review for cohesion and separation of concerns once the current fix cycle stabilises.

---

_Report generated: 2026-03-28 | Branch: `chore/repo-health-report-2026-03-26` | Tool: Claude Sonnet 4.6_Committed and pushed. The two report files from 2026-03-27 are now on `chore/repo-health-report-2026-03-26`.