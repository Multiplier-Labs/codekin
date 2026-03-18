# Codekin Repository Health Assessment
**Date**: 2026-03-18
**Branch**: main @ 9bea846
**Assessed by**: Claude Sonnet 4.6 (automated)

---

## Summary

**Overall Health: Good**

The codebase is in solid shape. TypeScript configs are strict, ESLint rules are thorough, all licenses are permissive, and no TODO/FIXME markers remain in source. The main areas needing attention are: stale merged branches piling up on the remote, a few documentation files that reference renamed or removed artifacts, and a potential unmerged PR branch (`feat/joe-chat-variant`).

| Metric | Value |
|---|---|
| Dead code items | 0 |
| Stale TODOs/FIXMEs | 0 |
| Config issues | 1 minor |
| License concerns | 0 |
| Doc drift items | 5 |
| Stale/merged branches eligible for deletion | 13 |
| Open PRs | 0 |
| Stuck PRs | 0 |
| High-risk diverged branches | 1 (`codekin/reports`) |

---

## Dead Code

No dead code was found. All exported functions, classes, constants, and types across `src/` and `server/` are actively imported by other files. No orphan source files were detected. The codebase has good modularity with clean import/export chains.

| File | Export/Function | Type | Recommendation |
|---|---|---|---|
| — | — | — | No findings |

---

## TODO/FIXME Tracker

No `TODO`, `FIXME`, `HACK`, `XXX`, or `WORKAROUND` comments exist in any source files under `src/` or `server/`. The codebase is clean of inline debt markers.

| File:Line | Type | Comment | Author | Date | Stale? |
|---|---|---|---|---|---|
| — | — | — | — | — | — |

**Summary**: 0 total, 0 stale.

---

## Config Drift

### TypeScript

All TypeScript configs use `"strict": true`, `"noUnusedLocals": true`, `"noUnusedParameters": true`, and `"noFallthroughCasesInSwitch": true`. The project correctly separates frontend (`tsconfig.app.json`), build tooling (`tsconfig.node.json`), and backend (`server/tsconfig.json`) configs.

| Config File | Setting | Current Value | Status |
|---|---|---|---|
| `tsconfig.app.json` | `strict` | `true` | OK |
| `tsconfig.app.json` | `target` | `ES2022` | OK |
| `tsconfig.node.json` | `target` | `ES2023` | OK (node build tools, appropriate) |
| `server/tsconfig.json` | `strict` | `true` | OK |
| `server/tsconfig.json` | `module` | `NodeNext` | OK |
| `server/tsconfig.json` | `include` | `["*.ts"]` | Minor: only includes root-level server `.ts` files; subdirectories need their own tsconfig |

### ESLint

ESLint config uses `tseslint.configs.strictTypeChecked` for both frontend and backend. Several unsafe rules are demoted from `error` to `warn` as an incremental cleanup strategy.

| Config File | Setting | Current Value | Recommended |
|---|---|---|---|
| `eslint.config.js` | `ecmaVersion` | `2020` | `2022` — inconsistent with tsconfig ES2022 targets |
| `eslint.config.js` | `no-unsafe-assignment` | `warn` | `error` — revisit after warning cleanup |
| `eslint.config.js` | `no-unsafe-member-access` | `warn` | `error` — revisit after warning cleanup |

### Prettier

`.prettierrc` is standard. No issues.

### Vite

`vite.config.ts` is minimal and correct. Proxy to port 32352 matches server config.

**Summary: 1 actionable finding** — ESLint `ecmaVersion: 2020` should be `2022`.

---

## License Compliance

The project uses an MIT license. All production and development dependencies use permissive licenses.

### License Distribution

| License | Count |
|---|---|
| MIT | 34 |
| Apache-2.0 | 1 (`typescript`) |
| BSD-3-Clause | 1 (`highlight.js`) |
| MPL-2.0 OR Apache-2.0 | 1 (`dompurify`) |
| **Total** | **37** |

### Flagged Dependencies

| Package | License | Assessment |
|---|---|---|
| `dompurify` | MPL-2.0 OR Apache-2.0 | Package offers Apache-2.0 as alternative. No action required for web app library use. |

**Status: Compliant.** No GPL, AGPL, or LGPL dependencies.

---

## Documentation Freshness

### README Drift

`README.md` is accurate. All referenced scripts match `package.json`, and linked files (`docs/screenshot.png`, `docs/INSTALL-DISTRIBUTION.md`, `CONTRIBUTING.md`) exist.

### docs/ Staleness Findings

| File | Issue | Severity |
|---|---|---|
| `docs/ORCHESTRATOR-SPEC.md` | Uses "Shepherd" name throughout all headings, descriptions, and code examples. Feature was renamed to "Agent Joe" in commit `f01005ac` (2026-03-17). Server file names in spec (`shepherd-routes.ts`, etc.) match code but the product name is wrong. | High |
| `docs/SETUP.md` | References `scripts/scan-repos.mjs` which was removed from the repo (lives locally at `/home/dev/.codekin/scripts/scan-repos.mjs`). Setup instructions are broken for new installs. Also references `public/data/repos.json` — no such directory in the repo. | High |
| `docs/FEATURES.md` | Line ~56 references `react-syntax-highlighter` for syntax highlighting. That package is not in `package.json`. Actual packages are `highlight.js` and `refractor`. Also omits the Joe chat variant and welcome screen (added in PRs #183–#187 after last edit date). | Medium |
| `docs/APPROVALS-FIX-SPEC.md` | Fixes 5 and 6 are marked "Planned (Not Yet Implemented)" but commit `f45a9563` claims to implement all 6 approval fixes. Spec status appears stale. | Low |
| `docs/INSTALL-DISTRIBUTION.md` | States "The existing `deploy.sh` + nginx setup (documented in `CLAUDE.md`) continues to work" — `CLAUDE.md` does not document `deploy.sh` (removed from repo). Stale cross-reference. | Low |

### API Surface Changes vs. Docs

The Shepherd → Agent Joe rename (`f01005ac`, 2026-03-17) is the most significant undocumented change. `docs/ORCHESTRATOR-SPEC.md` was not updated in that commit despite being the primary reference for this feature.

---

## Draft Changelog

Changes since tag `v0.4.1` (2026-03-16) through 2026-03-18.

### Features
- **Agent Joe orchestrator**: Introduced Agent Joe as a distinct orchestrator session type, replacing Shepherd. Implements Phases 1–4: orchestrator session spawning (Phase 1), reports/children/memory/trust (Phase 2), monitoring/dashboard/notifications (Phase 3), self-improving memory and autonomy (Phase 4). (#182)
- **Joe chat variant**: New chat variant with distinct visual identity for Joe agent sessions. (#184)
- **Joe welcome screen**: Added distinct welcome screen for Joe agent sessions with empty-state UI. (#185, #186, #187)
- **Session-scoped prompt queue**: Refactored approval prompt queue to be session-scoped, preventing cross-session prompt interference. (#177)
- **Settings UI improvements**: Reorganized settings view for improved organization and consistency. (#180)

### Fixes
- **Worktree session data**: Fixed copying of Claude session data to worktree project directory on mid-session move. (#182, #183)
- **Worktree session context (v2)**: Fixed `CLAUDE_PROJECT_DIR` being set to original repo path for worktree sessions. (#181)
- **Worktree session context**: Fixed session context preservation when migrating to a worktree. (#174)
- **ExitPlanMode double-gate**: Auto-approve `ExitPlanMode` control requests to prevent double confirmation prompts. (#178)
- **Symlink traversal in browse-dirs**: Resolved symlinks in path check to prevent directory traversal via symlink. (#175)
- **Joe agent icon and menu selection**: Fixed icon rendering and menu selection state for Joe agent. (e96339d)
- **ChatView Joe variant wiring**: Fixed Joe variant prop not being passed through to `ChatView` and `InputBar`. (636bd36)
- **Render-time ref read**: Fixed reading a ref during React render in Claude Webhook component. (099dd22)

### Chores
- Added dependency health report for 2026-03-17.
- Added code review report for 2026-03-17.
- Added repo health report for 2026-03-17.
- Implemented repo health audit recommendations from March report.

---

## Stale Branches

No branches meet the 30-day staleness threshold (high development velocity — all branches are from the last 2 days). However, 13 branches have been merged into `main` and are candidates for deletion.

### Merged Branches (Safe to Delete)

| Branch | Last Commit | Author | Merged? | Recommendation |
|---|---|---|---|---|
| `origin/feat/joe-welcome-screen` | 2026-03-17 | alari | Yes | Delete |
| `origin/fix/worktree-copy-session-data` | 2026-03-17 | alari | Yes | Delete |
| `origin/feat/agent-joe` | 2026-03-17 | alari | Yes | Delete |
| `origin/fix/worktree-preserve-session-context-v2` | 2026-03-17 | alari | Yes | Delete |
| `origin/feat/shepherd-orchestrator` | 2026-03-17 | alari | Yes | Delete |
| `origin/feat/settings-ui-improvements` | 2026-03-17 | alari | Yes | Delete |
| `origin/fix/exit-plan-mode-double-gate` | 2026-03-17 | alari | Yes | Delete |
| `origin/feat/session-scoped-prompt-queue` | 2026-03-17 | alari76 | Yes | Delete |
| `origin/chore/repo-health-action-items-march` | 2026-03-17 | alari76 | Yes | Delete |
| `origin/fix/symlink-traversal-browse-dirs` | 2026-03-17 | alari | Yes | Delete |
| `origin/fix/worktree-preserve-session-context` | 2026-03-17 | alari | Yes | Delete |
| `origin/chore/repo-health-2026-03-17` | 2026-03-17 | alari | Yes | Delete |

### Unmerged Branches

| Branch | Last Commit | Author | Ahead/Behind Main | Notes |
|---|---|---|---|---|
| `origin/codekin/reports` | 2026-03-18 | alari | 14 ahead / 154 behind | Reports branch; active today |
| `origin/feat/joe-chat-variant` | 2026-03-17 | alari | 1 ahead / 7 behind | Single unmerged commit; may be superseded |
| `origin/chore/repo-health-report-2026-03-14` | 2026-03-14 | Claude (Webhook) | 2 ahead / 154 behind | Bot-generated; report files only |

---

## PR Hygiene

No open pull requests at time of assessment.

| PR# | Title | Author | Days Open | Review Status | Conflicts? | Stuck? |
|---|---|---|---|---|---|---|
| — | No open PRs | — | — | — | — | — |

---

## Merge Conflict Forecast

Only branches with commits ahead of `main` are analyzed.

| Branch | Commits Ahead | Commits Behind | Likely Overlapping Files | Risk Level |
|---|---|---|---|---|
| `origin/codekin/reports` | 14 | 154 | `.codekin/reports/` only — no source overlap expected | Low |
| `origin/feat/joe-chat-variant` | 1 | 7 | Likely `src/components/ChatView.tsx`, `src/types.ts` — same files changed heavily on main since divergence | Medium |
| `origin/chore/repo-health-report-2026-03-14` | 2 | 154 | Report files only | Low |

`origin/feat/joe-chat-variant` is the only branch with meaningful conflict risk. It has 1 unmerged commit in an area that received heavy subsequent changes on main.

---

## Recommendations

1. **Delete 13 merged remote branches** — Bulk `git push origin --delete` for all 13 branches in the merged table. Straightforward hygiene; reduces remote branch noise significantly.

2. **Investigate `origin/feat/joe-chat-variant`** — 1 unmerged commit, 7 commits behind main in a high-churn area. Either rebase and merge, or close if superseded by the main-branch Agent Joe work. Resolves the medium conflict risk.

3. **Fix `docs/SETUP.md` broken `scan-repos.mjs` reference** — The script was removed from the repo. Either restore it, update the doc to point to its local-only location, or revise the setup instructions to describe an alternative scanning approach. Affects new self-hosted installs.

4. **Update `docs/ORCHESTRATOR-SPEC.md` for Agent Joe rename** — Replace all "Shepherd" references with "Agent Joe". This is a find-and-replace plus updating any server file names referenced in the spec. Consider then consolidating the spec contents into a section in `docs/FEATURES.md` and deleting the standalone spec file.

5. **Update `docs/FEATURES.md`** — (a) Replace `react-syntax-highlighter` with `highlight.js` + `refractor`. (b) Add a section for the Joe chat variant and welcome screen. (c) Replace "Shepherd" with "Agent Joe" throughout.

6. **Raise ESLint `ecmaVersion` to `2022`** — Minor one-line fix in `eslint.config.js` to match the ES2022 target in `tsconfig.app.json`. Prevents any ES2022 syntax from being incorrectly flagged or silently accepted.

7. **Verify and fix `apiKeySet` in `docs/API-REFERENCE.md`** — The health endpoint example response includes `"apiKeySet": true`. The 2026-03-16 AI SDK removal may have dropped this field. Check `server/ws-server.ts` health handler and update the example accordingly.

8. **Verify `docs/APPROVALS-FIX-SPEC.md` Fix 5 and 6 status** — Commit `f45a9563` claims all 6 fixes were implemented but the spec still marks fixes 5 and 6 as "Planned". Update the spec if they are shipped; this prevents confusion about what the current approval system actually does.

9. **Schedule a "warn → error" ESLint pass** — Rules like `no-unsafe-assignment`, `no-unsafe-member-access`, and `no-misused-promises` are intentionally demoted to `warn`. Once the warning count is manageable, promote them back to `error` to enforce full type safety.

10. **Tag `v0.5.0`** — The Agent Joe orchestrator (4 phases), Joe chat variant, session-scoped prompt queue, and multiple worktree fixes since `v0.4.1` collectively represent a minor version's worth of features. A tagged release with a changelog entry would make the project history more navigable.
