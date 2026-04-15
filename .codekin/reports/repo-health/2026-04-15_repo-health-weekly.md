# Codekin Repository Health Report — 2026-04-15

**Assessment date:** 2026-04-15  
**Branch assessed:** `main` (HEAD `66d6e37`)  
**Last tag:** `v0.6.3`

---

## Summary

**Overall health rating: Good**

The codebase is in solid condition: strict TypeScript enforced everywhere, no TODO/FIXME debt, no orphan source files, and clean licence posture. The main action items are a cluster of unmerged report branches accumulating behind `main`, one PR with a merge conflict, and two minor documentation gaps from recently landed features.

| Metric | Count |
|---|---|
| Dead code items | 0 (no orphan files, no unused exports detected) |
| Stale TODOs (>30 days) | 0 |
| Config issues | 1 minor (see Config Drift) |
| License concerns | 2 transitive deps missing licence metadata |
| Doc drift items | 2 (ProcessCoordinator, GitHub webhook auto-setup) |
| Stale branches (>30 days) | 0 |
| Branches with pending PRs | 6 (all docs reports) |
| Stuck PRs (>7 days, no review) | 0 |

---

## Dead Code

A full import-graph sweep found no orphaned source files and no exported symbols that are entirely unimported across the project. All server modules (`opencode-process.ts`, `orchestrator-learning.ts`, `orchestrator-memory.ts`, `orchestrator-monitor.ts`, etc.) are imported by at least one other module. All frontend hooks and components are wired into `App.tsx` or sibling components.

| File | Symbol | Type | Finding |
|---|---|---|---|
| — | — | — | No dead code detected |

**Note on debug logging:** Commit `4a6ed13` (`debug: add lifecycle logging — #406`) added nine `console.log` trace calls to `session-manager.ts` and `session-lifecycle.ts`. All nine were subsequently removed in `8767041` (#407) and `1f93348` (#404). No residual debug logging from that commit remains.

---

## TODO/FIXME Tracker

A search for `TODO`, `FIXME`, `HACK`, `XXX`, and `WORKAROUND` across all `.ts` / `.tsx` files in `src/` and `server/` returned **zero hits** (matches in `node_modules/` and test-fixture strings excluded).

| file:line | type | comment | author | date | stale? |
|---|---|---|---|---|---|
| — | — | No items found | — | — | — |

**Summary:** 0 total · 0 by type · 0 stale

---

## Config Drift

### `tsconfig.app.json` (frontend)

| Setting | Current value | Assessment |
|---|---|---|
| `strict` | `true` | ✅ Correct |
| `noUnusedLocals` | `true` | ✅ Correct |
| `noUnusedParameters` | `true` | ✅ Correct |
| `noFallthroughCasesInSwitch` | `true` | ✅ Correct |
| `noUncheckedSideEffectImports` | `true` | ✅ Correct |
| `erasableSyntaxOnly` | `true` | ✅ Valid (requires TS ≥ 5.5, project uses 6.0.2) |
| `skipLibCheck` | `true` | ⚠️ Suppresses declaration-file errors; acceptable for Vite apps but hides upstream type regressions |
| `target` | `ES2022` | ✅ Appropriate for modern-browser target |

### `tsconfig.node.json` (Vite config)

| Setting | Current value | Assessment |
|---|---|---|
| `strict` | `true` | ✅ Correct |
| `target` | `ES2023` | ✅ Appropriate |
| `skipLibCheck` | `true` | Same note as above |

### `server/tsconfig.json`

| Setting | Current value | Assessment |
|---|---|---|
| `strict` | `true` | ✅ Correct |
| `module` / `moduleResolution` | `NodeNext` / `NodeNext` | ✅ Correct for ESM Node.js server |
| `isolatedModules` | `true` | ✅ Correct |
| `skipLibCheck` | `true` | Same note as above |

### `eslint.config.js`

| Finding | Detail |
|---|---|
| ✅ Flat config (ESLint 9+) | Uses modern flat config format; no deprecated `.eslintrc` files present |
| ✅ `@typescript-eslint/no-deprecated: 'error'` | Both frontend and server rule groups enforce this |
| ✅ `@typescript-eslint/no-unsafe-*` rules enforced | Strict unsafe-operation rules added in PR #410 |
| ⚠️ `@typescript-eslint/no-explicit-any: 'off'` in test config | Intentional relaxation for test files; acceptable but worth documenting as a deliberate choice |

### `.prettierrc`

| Setting | Current value | Assessment |
|---|---|---|
| `semi` | `false` | ✅ Consistent with project style |
| `singleQuote` | `true` | ✅ Consistent |
| `trailingComma` | `"all"` | ✅ Consistent |
| `printWidth` | `120` | ✅ Reasonable for wide-screen development |

**Overall config verdict:** Excellent. All three tsconfig targets enforce `strict`, `noUnusedLocals`, and `noUnusedParameters`. No deprecated ESLint rules detected. The only minor note is `skipLibCheck: true` across all configs — a common Vite project default, but worth revisiting if upstream type errors become a concern.

---

## License Compliance

Project licence: **MIT** (permissive)

### Licence summary table

| Licence | Dependency count | Risk |
|---|---|---|
| MIT | 465 | ✅ None |
| ISC | 22 | ✅ None (permissive) |
| Apache-2.0 | 18 | ✅ None |
| MPL-2.0 | 12 | ℹ️ Weak copyleft (file-level); safe for MIT projects when source files not modified |
| BSD-3-Clause | 9 | ✅ None |
| BSD-2-Clause | 8 | ✅ None |
| BlueOak-1.0.0 | 4 | ✅ None (permissive) |
| MIT-0 | 2 | ✅ None |
| CC-BY-4.0 | 1 | ✅ Documentation/attribution only |
| CC0-1.0 | 1 | ✅ Public domain |
| (BSD-2-Clause OR MIT OR Apache-2.0) | 1 | ✅ None |
| (MIT OR WTFPL) | 1 | ✅ None |
| (MPL-2.0 OR Apache-2.0) | 1 | ✅ None |
| 0BSD | 1 | ✅ None |
| **MISSING** | **2** | ⚠️ See below |

### Flagged dependencies

| Package | Issue | Notes |
|---|---|---|
| `busboy` | No `license` field in `package-lock.json` | Transitive dependency of `multer`. Package source carries MIT licence but metadata is absent from the lock file. Low risk; verify with `npm view busboy license`. |
| `streamsearch` | No `license` field in `package-lock.json` | Transitive dependency of `busboy` (→ `multer`). Same situation. Low risk. |

No GPL, AGPL, or LGPL dependencies detected. MPL-2.0 packages (`source-map`, `mozilla-*` utilities) are used unmodified so copyleft does not propagate.

---

## Documentation Freshness

### API Docs drift

| Area | Change | Doc status |
|---|---|---|
| `ProcessCoordinator` (PR #404 — 2026-04-13) | New `server/process-coordinator.ts` module unifying session lifecycle | ⚠️ Not reflected in `docs/API-REFERENCE.md` or `docs/FEATURES.md` |
| GitHub webhook auto-setup (PR #391 — 2026-04-08) | `POST /api/integrations/github/pr-review/setup` auto-configures webhook | ⚠️ `docs/GITHUB-WEBHOOKS-SPEC.md` and `docs/PR-REVIEW-WEBHOOK.md` should describe the new auto-setup flow |
| Strict `@typescript-eslint/no-unsafe-*` rules (PR #410 — 2026-04-14) | ESLint config tightened | ✅ Internal change; no user-facing doc update needed |
| Edit Workflow modal layout fixes (#401, #403, #405, #408) | UI polish only | ✅ No doc update needed |

### README drift

The `README.md` was updated in the same release cycle (screenshot refreshed with PR `445bb49`). All commands listed under "Usage" and "Install" were verified against `package.json` scripts and `bin/codekin.mjs`. No drift detected.

| README item | Actual state | Status |
|---|---|---|
| `npm run dev` | Present in `package.json` | ✅ |
| `npm run build` | Present in `package.json` | ✅ |
| `npm test` | Mapped to `vitest run` | ✅ |
| `npm run lint` | Mapped to `eslint` | ✅ |
| `PORT=32352` default | Matches `server/config.ts` | ✅ |
| `REPOS_ROOT=~/repos` | Matches `server/config.ts` | ✅ |
| OpenCode listed as optional prerequisite | Accurate | ✅ |

---

## Draft Changelog

### v0.6.4 (unreleased) — since v0.6.3

#### Features
- **Unified ProcessCoordinator** — new `server/process-coordinator.ts` centralises session lifecycle management across Claude and OpenCode providers, replacing ad-hoc start/stop calls scattered across session handlers (#404)
- **GitHub webhook auto-setup** — PR Review workflows now auto-configure the GitHub webhook via the setup wizard; no manual token entry required (#391)

#### Fixes
- Harden docs browser root scope and persist canonical paths to prevent path traversal edge cases (#409)
- Widen Edit Workflow modal to prevent day-label clipping on narrow viewports (#408)
- Prevent spurious model reconfiguration when a model is first assigned to a new session (#407)
- Polish Edit Workflow modal: frequency highlights, day grid, model default (#403, #405)
- Streamline Edit Workflow modal two-column layout (#401, #393)
- Address robustness issues in report commit flow identified in GPT review (#400)
- Unify workflow report commit/push logic across Markdown and Stepflow paths (#398)
- Cap API rate-limiter map size and add attachment file size limit (#397)
- Harden path traversal, trust-proxy config, and image-src allowlist (#394)

#### Chores
- Enforce strict `@typescript-eslint/no-unsafe-*` rules across the entire codebase (#410)

#### Documentation
- Session initiation audit report (#399)

#### Debug (temporary — already cleaned up)
- *(internal)* Added lifecycle trace logging to diagnose first-message-lost race condition (#406); removed in #407 and #404

---

## Stale Branches

No branches with last commit older than 30 days were found. All remote branches are within the past 14 days.

| Branch | Last commit | Author | Merged into main? | Recommendation |
|---|---|---|---|---|
| `origin/chore/eslint-strict-unsafe` | 2026-04-14 | alari | No (pre-merge shadow) | **Delete** — content already merged via PR #410; this branch has an identical commit 1-ahead that creates a confusing duplicate |
| `origin/fix/security-and-cleanup-apr14` | 2026-04-14 | alari | No | Review and merge or close; 1 commit ahead, modifies `session-routes.ts` and `docs-routes.ts` |
| `origin/docs/session-restart-audit` | 2026-04-13 | alari | No | Corresponds to open PR #402 (merge conflict); resolve conflict and merge |
| `origin/feat/repo-health-2026-04-13` | 2026-04-13 | alari | No | Corresponds to open PR #395; merge |
| `origin/feat/test-coverage-2026-04-13` | 2026-04-13 | alari | No | Corresponds to open PR #396; merge |
| `origin/feat/daily-code-review-2026-04-12` | 2026-04-12 | alari | No | Corresponds to open PR #392; merge |
| `origin/chore/pr-audit-2026-04-12` | 2026-04-12 | alari | No | Corresponds to open PR #390; merge |
| `origin/feat/pr-373-audit-report` | 2026-04-12 | alari | No | Corresponds to open PR #374; merge |
| `origin/feat/connection-status-popup` | 2026-04-11 | alari | No | No open PR; 5 commits ahead, 61 behind — stale feature branch; create PR or delete |
| `origin/test/coverage-gaps-apr10` | 2026-04-10 | Claude (Webhook) | No | 2 commits ahead, 87 behind — very stale; merge or abandon |
| `origin/codekin/reports` | 2026-04-15 | alari | No | Automated reports branch; 66 ahead / 469 behind — extreme divergence (see Merge Conflict Forecast) |

---

## PR Hygiene

All 6 open PRs are doc-report branches created by automated workflows. None has been open for more than 3 days.

| PR# | Title | Author | Days open | Review status | Conflicts? | Stuck? |
|---|---|---|---|---|---|---|
| #402 | docs: session restart root cause audit | alari76 | 2 | None | ⚠️ CONFLICTING | No |
| #396 | docs: test coverage report 2026-04-13 | alari76 | 2 | None | No | No |
| #395 | docs: repo health report 2026-04-13 | alari76 | 2 | None | No | No |
| #392 | docs: add daily code review report for 2026-04-12 | alari76 | 3 | None | No | No |
| #390 | docs: PR code review audit (2026-04-12, last 7 merged) | alari76 | 3 | None | No | No |
| #374 | docs: Add audit report for PR #373 | alari76 | 3 | None | No | No |

No PRs meet the "stuck" threshold (>7 days open, no review). PR #402 requires conflict resolution before it can merge.

---

## Merge Conflict Forecast

Active branches (commits within last 14 days) assessed against `main`.

| Branch | Ahead main | Behind main | Modified files | Overlap with main? | Risk |
|---|---|---|---|---|---|
| `origin/codekin/reports` | 66 | 469 | Report files in `.codekin/reports/` | Low (report files only) | 🟡 Medium — extreme divergence but reports-only edits; merge will produce a large diff but likely no code conflicts |
| `origin/fix/security-and-cleanup-apr14` | 1 | 2 | `server/docs-routes.ts`, `server/session-routes.ts` | `session-routes.ts` also touched by PR #410 (eslint-strict, now merged into main) | 🟠 High — overlapping `session-routes.ts`; line-level conflicts likely when merging |
| `origin/chore/eslint-strict-unsafe` | 1 | 1 | `eslint.config.js`, 10 server `.ts` files | All touched files are identical to PR #410 already in main | 🔴 Critical — this branch IS a duplicate of the merged PR; it will conflict on every file it touches |
| `origin/feat/connection-status-popup` | 5 | 61 | `ConnectionPopup.tsx` and related frontend files | No recent main-branch changes to those files | 🟡 Medium — 61 commits behind but likely isolated to its own files; needs rebase |
| `origin/test/coverage-gaps-apr10` | 2 | 87 | Test files | No recent main-branch test changes to same files | 🟡 Medium — 87 commits behind; low code overlap but needs rebase |

---

## Recommendations

1. **Delete `origin/chore/eslint-strict-unsafe`** — Its single commit is a duplicate of PR #410, which was already merged into `main`. The branch is not associated with any open PR and will cause conflict noise if left around. Run: `git push origin --delete chore/eslint-strict-unsafe`.

2. **Resolve and merge PR #402 (session restart audit)** — It is the only open PR with a merge conflict. Rebase the branch onto current `main` and resolve the conflict so the audit report lands in history.

3. **Batch-merge or close the five pending docs-report PRs (#374, #390, #392, #395, #396)** — These are automated report branches created by workflows. They are mergeable and have no review requirements. Merging them clears the open-PR queue and keeps the report history up to date.

4. **Triage `origin/feat/connection-status-popup`** — 5 commits, 61 commits behind `main`, no open PR. Either open a PR, rebase, and merge, or delete the branch if the work was superseded.

5. **Address `origin/codekin/reports` divergence** — This automated branch is 469 commits behind `main`. Decide whether it should be periodically rebased or whether reports should always be committed directly to dated feature branches (current practice). If the branch exists only as an artefact, delete it.

6. **Document `ProcessCoordinator` in `docs/API-REFERENCE.md` and `docs/FEATURES.md`** — PR #404 introduced a significant architectural change (unified session lifecycle coordinator) that is not yet reflected in any documentation file.

7. **Update `docs/GITHUB-WEBHOOKS-SPEC.md` and `docs/PR-REVIEW-WEBHOOK.md` for auto-setup flow** — PR #391 added a one-click webhook auto-setup endpoint. The existing spec docs describe a manual configuration path and should be updated to reflect the new wizard.

8. **Verify `busboy` and `streamsearch` licence metadata** — Both packages have missing `license` fields in `package-lock.json`. Run `npm view busboy license` and `npm view streamsearch license` to confirm they are MIT and update the lock file via a `npm install` refresh if needed.

9. **Review `fix/security-and-cleanup-apr14` for `session-routes.ts` conflicts** — This branch touches the same file as the recently merged PR #410. Pull it up, rebase onto `main`, resolve conflicts, and either merge or close before the divergence widens further.

10. **Consider enabling `skipLibCheck: false` in a follow-up refactor** — All three tsconfig files use `skipLibCheck: true`, which is a Vite scaffolding default. Now that strict mode and `no-unsafe-*` rules are fully enforced, enabling `skipLibCheck: false` would catch upstream type regressions at build time. Low urgency, but worth scheduling as a future hardening step.
