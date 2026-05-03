# Repository Health: codekin

**Date**: 2026-05-03T03:21:22.245Z
**Repository**: /srv/repos/codekin
**Branch**: main
**Workflow Run**: 8e915cf6-eacd-4bc9-95fa-53b71e515ddf
**Session**: 81eaef9f-50ad-4a89-8fb6-6415187091e7

---

# Codekin Repository Health Report — 2026-05-03

---

## Summary

**Overall Health: Good**

The repository is well-maintained with active development, strong TypeScript hygiene enforced at compile time, and no production TODO/FIXME debt. The codebase passed several security-hardening sprints in the past week and documentation has been actively kept in sync. The main areas requiring attention are a growing accumulation of unmerged remote branches (many from automated audit workflows), one outstanding open PR awaiting review, and a handful of ESLint rules intentionally downgraded to warnings that should be promoted to errors over time.

| Metric | Value |
|---|---|
| Dead code items | 0 confirmed (TypeScript strict catches at compile time) |
| Stale TODOs | 0 |
| Config issues | 2 minor (ES target mismatch, ESLint warning-tier rules) |
| License concerns | Low — MPL-2.0 deps are build-time only and documented |
| Doc drift items | 0 blocking — docs actively maintained |
| Stale branches (>30 days) | 0 |
| Approaching-stale branches (17–23 days, unmerged) | 9 |
| Special-case diverged branches | 2 (`codekin/reports`, `chore/release-0.6.4`) |
| Open PRs | 1 |
| Stuck PRs (>7 days, no review) | 0 |

---

## Dead Code

TypeScript strict mode (`noUnusedLocals: true`, `noUnusedParameters: true`) is enabled across all three tsconfig targets (app, node, server), making dead-code violations a build-time error rather than a runtime concern. A recent commit (#434, 2026-04-26) already removed three unused exports, indicating this hygiene is actively enforced.

Manual inspection of low-import library files found no orphans:

| File | Import count (non-test) | Status |
|---|---|---|
| `src/lib/chatFormatters.ts` | 1 (`ChatView.tsx`) | OK — single dedicated consumer |
| `src/lib/deriveActivityLabel.ts` | 1 (`App.tsx`) | OK — single dedicated consumer |
| `src/lib/hljs.ts` | 2 | OK |
| `src/lib/slashCommands.ts` | 7 | OK |
| `src/lib/workflowHelpers.ts` | 8 | OK |

**Finding: No dead code detected.** The combination of strict TypeScript and recent active cleanup leaves the codebase clean.

---

## TODO/FIXME Tracker

A full scan of `src/` and `server/` for `TODO`, `FIXME`, `HACK`, `XXX`, and `WORKAROUND` in production TypeScript/TSX files returned **zero results**. The only matches were inside test files where `'TODO'` appears as a literal string being passed to `summarizeToolInput` as test input data — not as code annotations.

| Type | Count | Stale (>30 days) |
|---|---|---|
| TODO | 0 | — |
| FIXME | 0 | — |
| HACK | 0 | — |
| XXX | 0 | — |
| WORKAROUND | 0 | — |
| **Total** | **0** | **0** |

**Finding: Excellent — zero annotation debt.**

---

## Config Drift

### TypeScript

| Config file | Setting | Current value | Notes |
|---|---|---|---|
| `tsconfig.app.json` | `target` | `ES2023` | Correct for modern browsers |
| `tsconfig.node.json` | `target` | `ES2023` | Correct for Vite/Node build tools |
| `server/tsconfig.json` | `target` | `ES2022` | One version behind app/node configs — minor inconsistency |
| All configs | `strict` | `true` | ✓ |
| All configs | `noUnusedLocals` | `true` | ✓ |
| All configs | `noUnusedParameters` | `true` | ✓ |
| All configs | `noFallthroughCasesInSwitch` | `true` | ✓ |
| `tsconfig.app.json` | `erasableSyntaxOnly` | `true` | TS 5.5+ feature, correct for TypeScript 6 |

**Finding:** The server tsconfig targets ES2022 while the frontend targets ES2023. Node.js 20+ supports ES2023, so bumping `server/tsconfig.json` `target` to `ES2023` would align the project. This is a low-priority cosmetic inconsistency with no functional impact.

### ESLint

The flat config (`eslint.config.js`) is modern and well-structured. A documented intentional pattern is that several rules are demoted from `error` to `warn` for "incremental adoption." These are flagged below as they represent accruing technical debt:

| Rule | Current level | Recommended level | Rationale |
|---|---|---|---|
| `@typescript-eslint/no-non-null-assertion` | `warn` | `error` | Non-null assertions are a common source of runtime crashes |
| `@typescript-eslint/no-misused-promises` | `warn` | `error` | Unhandled promise returns are a common bug source |
| `@typescript-eslint/no-unnecessary-condition` | `warn` | `error` | Dead branches indicate stale logic |
| `@typescript-eslint/require-await` | `warn` | `error` | Async functions without await are misleading |
| `@typescript-eslint/use-unknown-in-catch-callback-variable` | `warn` | `error` | Type-unsafe catch blocks |
| `@typescript-eslint/no-confusing-void-expression` | `warn` | `warn` | Can stay warn — less safety-critical |
| `@typescript-eslint/no-base-to-string` | `warn` | `warn` | Can stay warn — rarely dangerous |

**Finding:** No deprecated ESLint rules detected. TypeScript ESLint v8, ESLint v10 flat config, and `typescript-eslint` are all current. The warning-tier rules are the main area for improvement.

### Prettier

No `prettier` config file is present in the repository. The project relies on ESLint for code style enforcement. This is consistent with TailwindCSS 4's `@tailwindcss/vite` integration pattern and is not a problem — just noted.

---

## License Compliance

Project license: **MIT**

### Dependency License Summary

| License | Count |
|---|---|
| MIT | 441 |
| ISC | 20 |
| Apache-2.0 | 18 |
| BSD-3-Clause | 9 |
| BSD-2-Clause | 8 |
| MPL-2.0 | 3 |
| MIT-0 | 2 |
| BlueOak-1.0.0 | 2 |
| CC-BY-4.0 | 1 |
| (MPL-2.0 OR Apache-2.0) | 1 |
| (MIT OR WTFPL) | 1 |
| (BSD-2-Clause OR MIT OR Apache-2.0) | 1 |
| CC0-1.0 | 1 |
| 0BSD | 1 |
| **Total** | **509** |

### Flagged Dependencies

| Package | License | Issue | Assessment |
|---|---|---|---|
| `lightningcss@1.32.0` (×3 platform variants) | MPL-2.0 | File-level copyleft | **Low risk** — build-time only, not distributed. Documented in `package.json` `licenseNotes` field. |
| `dompurify@3.4.0` | MPL-2.0 OR Apache-2.0 | MPL-2.0 option is file-level copyleft | **Low risk** — dual-licensed; Apache-2.0 option chosen. Documented in `package.json` `licenseNotes`. |
| `expand-template@2.0.3` | MIT OR WTFPL | WTFPL is non-standard (though permissive) | **No risk** — WTFPL is maximally permissive; MIT option applies. Transitive dependency only. |

**Finding:** No GPL, AGPL, or LGPL dependencies found. The three MPL-2.0 flagged items are already acknowledged and properly documented in `package.json`. No action required.

---

## Documentation Freshness

### API Docs

`docs/API-REFERENCE.md` has been actively updated in the last 30 days with at least 6 documentation commits:
- WS rate-limit documentation added (2026-04-27)
- Workflow restart-resume / orphan-session handling docs added (2026-04-27)
- Security error responses documented (2026-04-25)
- API docs drift fixes for CSP and session routes (2026-04-22)
- PR review webhook docs (ongoing)

Server files with heavy recent changes (`session-routes.ts`, `workflow-routes.ts`, `orchestrator-*.ts`, `ws-server.ts`) all have corresponding documentation updates. No obvious staleness detected.

### README Drift

Scripts documented in `CONTRIBUTING.md` vs `package.json`:

| Script | In CONTRIBUTING.md | In package.json | Match? |
|---|---|---|---|
| `npm install` | ✓ (also `npm install --prefix server`) | ✓ | ✓ |
| `npm run dev` | ✓ | ✓ | ✓ |
| `npm test` | ✓ | ✓ (via `vitest run`) | ✓ |
| `npm run test:watch` | ✓ | ✓ (via `vitest`) | ✓ |
| `npm run lint` | ✓ | ✓ | ✓ |
| `npm run build` | ✓ | ✓ | ✓ |
| `npm run preview` | — | ✓ | Not in docs — minor, low priority |

README feature list and install instructions align with the current published npm package and `bin/codekin.mjs` entry point.

**Finding:** No significant README drift. The only gap is that `npm run preview` (Vite preview server) is in `package.json` but not documented in CONTRIBUTING.md — not worth adding given it's a dev utility.

---

## Draft Changelog

### Unreleased (since v0.6.4, 2026-04-27 → 2026-05-02)

#### Features
- **Orchestrator**: Parent sessions are notified immediately when a child session reaches a terminal state (`feat(orchestrator)` #463). A `terminalNotifiedAt` timestamp is stamped only on confirmed delivery to avoid duplicate notifications (#465 follow-up).

#### Fixes
- **Reliability**: Roll back workflow run dedup key on `startRun` failure to prevent phantom "already running" blocks; harden GitHub repo slug parser to handle edge-case remote URL formats (`fix(reliability)` #465).
- **Workflow**: Audit branches are now forked from `origin/main` and the main branch is restored after the audit run, preventing accidental dirty-main states (`fix(workflow)` #461, #457).
- **Security** (batch from #449–#455):
  - Sanitize commit-event prompt input; remove duplicate report write path (#455)
  - Validate `permissionMode` at WS session creation; fix commit-event `repoPath` handling; align dep versions (#454, #452)
  - Canonicalize clone destination to prevent symlink escape attack (#453)
  - Fix cron DoS vector, path traversal, dedup scoping, and PATCH endpoint validation (#449)

#### Chores
- Commit code-review and security audit reports for 2026-04-30 (#456).
- Bump `marked` from v17 to v18.0.2 (#450).
- Bump `@multiplier-labs/stepflow` to 0.3.4 (#445).
- Add `isWorkflowReportsBranch` to `workflow-loader` test mock to fix CI gap (#448).

---

## Stale Branches

No remote branches exceed the **30-day staleness threshold** (before 2026-04-03). However, 9 branches are 17–23 days old and unmerged (their content appears superseded by subsequent work landed in `main` via squash-merge or later PRs):

| Branch | Last commit | Author | Merged (by ref)? | Recommendation |
|---|---|---|---|---|
| `origin/test/coverage-gaps-apr10` | 2026-04-10 | Claude (Webhook) | No | Delete — coverage work superseded by #440 (2026-04-27) |
| `origin/feat/connection-status-popup` | 2026-04-11 | alari | No | Verify `ConnectionPopup.tsx` is in `main`; if so, delete |
| `origin/feat/pr-373-audit-report` | 2026-04-12 | alari | No | Delete — audit report workflow is now fully automated |
| `origin/chore/pr-audit-2026-04-12` | 2026-04-12 | alari | No | Delete — point-in-time audit, obsolete |
| `origin/feat/daily-code-review-2026-04-12` | 2026-04-12 | alari | No | Delete — code-review workflow now in `main` |
| `origin/feat/repo-health-2026-04-13` | 2026-04-13 | alari | No | Delete — repo-health workflow now in `main` |
| `origin/feat/test-coverage-2026-04-13` | 2026-04-13 | alari | No | Delete — superseded by later coverage work |
| `origin/docs/session-restart-audit` | 2026-04-13 | alari | No | Delete — docs since updated in `main` |
| `origin/feat/repo-health-2026-04-15` | 2026-04-16 | alari | No | Delete — superseded by later repo-health work |

### Special-case diverged branches

| Branch | Last commit | Ahead/Behind | Notes |
|---|---|---|---|
| `origin/codekin/reports` | 2026-04-27 | 99 ahead / 532 behind | Legacy tracking branch; massively diverged. **Candidate for deletion** — reports now committed on `audit/` branches per workflow. |
| `origin/chore/release-0.6.4` | 2026-04-27 | 3 ahead / 15 behind | Release branch for v0.6.4 tag. Tag `v0.6.4` is on commit `814c0cf`; `main` has moved past it. **Safe to delete.** |

> Note: Many `audit/*` branches from Apr 28–May 02 show as "unmerged by ref" because workflow reports are squash-merged. These are expected and will age out as new runs create fresh branches.

---

## PR Hygiene

| PR # | Title | Author | Days open | Review status | Mergeable | Stuck? |
|---|---|---|---|---|---|---|
| [#464](https://github.com/Multiplier-Labs/codekin/pull/464) | chore(reports): add code-review, comment, and repo-health reports for 2026-05-01 | alari76 | 1 | No reviews | MERGEABLE | No |

**Finding:** The single open PR is a routine reports commit, 1 day old, MERGEABLE, and not yet flagged as stuck. No action required beyond normal review cadence.

---

## Merge Conflict Forecast

Branches with commits in the last 14 days that have not been merged into `main`:

| Branch | Ahead | Behind | Files changed (branch-only) | Risk |
|---|---|---|---|---|
| `fix/commit-dedup-and-slug-parser-2026-05-02` | 1 | 1 | `commit-event-handler.ts`, `workflow-routes.ts` + tests | **Low** — 1 commit, small delta |
| `feat/child-session-terminal-notifications-2026-05-01` | 2 | 5 | `orchestrator-children.ts`, `orchestrator-notify.ts`, `orchestrator-session-router.ts` + tests | **Medium** — orchestrator files touched heavily on `main` recently; rebase recommended |
| `fix/workflow-audit-base-branch-2026-05-01` | 1 | 6 | `commit-event-handler.ts`, `orchestrator-children.ts`, `orchestrator-notify.ts`, `workflow-routes.ts` + tests | **Medium** — overlaps with same orchestrator files as above |
| `audit/code-review.daily-2026-05-02` | 1 | 1 | Report `.md` files only | **None** — doc-only, no source overlap |
| `audit/repo-health.weekly-2026-05-02` | 1 | 1 | Report `.md` files only | **None** — doc-only |
| `chore/reports-2026-05-02` | 1 | 1 | Report `.md` files only | **None** — doc-only |
| `fix/security-commit-event-sanitization-2026-04-30` | 1 | 7 | `commit-event-handler.ts` + tests | **Low-Medium** — 7 commits behind; security fix likely superseded by #455 already in `main` |
| `fix/security-clone-symlink-escape-2026-04-30` | 1 | 9 | `commit-event-handler.ts` + tests | **Low-Medium** — 9 commits behind; security fix likely superseded by #453 |
| Audit branches Apr 28–30 (×9) | 18–42 | 53 | Report `.md` files only | **None** — report files only; high divergence count is misleading |

**High-risk overlapping file set** (touched on `main` AND on active feature branches):  
`server/orchestrator-children.ts`, `server/orchestrator-notify.ts`, `server/orchestrator-session-router.ts`, `server/commit-event-handler.ts`, `server/workflow-routes.ts`

---

## Recommendations

1. **Merge or close `feat/child-session-terminal-notifications-2026-05-01` promptly** — it is 5 commits behind `main` and touches the orchestrator files that have been the most active area this week. Every day increases rebase complexity. Priority: high.

2. **Delete the `codekin/reports` and `chore/release-0.6.4` remote branches** — `codekin/reports` is 532 commits behind and serves no current purpose; `chore/release-0.6.4` is a superseded release branch. Cleaning these reduces noise in `git branch -r` output and CI branch scanning.

3. **Promote 5 ESLint warning-tier rules to errors** — `no-non-null-assertion`, `no-misused-promises`, `no-unnecessary-condition`, `require-await`, and `use-unknown-in-catch-callback-variable` are the highest-value safety rules currently at `warn`. Run `npm run lint` after promoting to measure the fix scope; address in a single chore PR.

4. **Sweep the 9 approaching-stale feature/audit branches (Apr 10–16)** — verify their content is already in `main` (high likelihood given squash-merge workflow), then bulk-delete from origin. Reduces branch list by ~9 entries.

5. **Align `server/tsconfig.json` target to ES2023** — single-line change bringing the server config in line with the frontend and Node configs. Node 20+ fully supports ES2023. Low effort, eliminates the minor inconsistency.

6. **Resolve or close `fix/security-commit-event-sanitization-2026-04-30` and `fix/security-clone-symlink-escape-2026-04-30`** — these security fix branches appear to be superseded by PRs #455 and #453 already merged into `main`. Confirm and delete if so.

7. **Merge open PR #464** — routine reports commit, 1 day old, zero conflicts, no reviews blocking it. Low-hanging fruit to keep the main branch current.

8. **Add `npm run preview` to CONTRIBUTING.md** — minor gap; one line under the scripts table. Helps contributors doing local production-build verification.

9. **Rebase `fix/workflow-audit-base-branch-2026-05-01` onto current `main`** — 6 commits behind with overlap on `orchestrator-children.ts` and `workflow-routes.ts`. Rebase now while the diff is still small.

10. **Track ESLint warning count as a KPI** — given the documented intent to "promote warnings to errors as the codebase is cleaned up," adding a CI step that fails if the warning count increases (e.g., `eslint . --max-warnings <N>`) would prevent regression and create positive pressure to reduce the backlog.