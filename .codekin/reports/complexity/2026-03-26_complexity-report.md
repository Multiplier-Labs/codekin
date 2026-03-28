# Codekin Repository Health Report — 2026-03-26

**Generated**: 2026-03-26
**Branch**: main
**Version**: 0.5.0
**Last tag**: v0.5.0

---

## Summary

**Overall Health: Good**

The codebase is in healthy shape with strong TypeScript discipline, no copyleft license exposure, an active commit cadence, and zero open PRs. The main areas for attention are a growing backlog of post-merge branches that should be pruned, several ESLint rules demoted to warnings as acknowledged technical debt, a missing REST API reference document, and one long-lived divergent branch (`codekin/reports`) with high conflict risk.

| Metric | Value |
|---|---|
| Dead code items | 0 confirmed orphans or unused exports found |
| Stale TODOs / FIXMEs | 0 (none in production code) |
| Config issues | 3 minor (ESLint ecmaVersion lag, ES target mismatch, warn-downgraded rules) |
| License concerns | 2 packages missing license field (MIT files present); 2 noted data/permissive licenses |
| Doc drift items | 1 (ORCHESTRATOR-SPEC.md still marked "Draft v0.1") |
| Stale branches (>30 days) | 0 by strict definition; ~26 post-merge shadows to clean up |
| Open PRs | 0 |
| High merge-conflict risk branches | 2 (`codekin/reports`, `feat/joe-chat-variant`) |

---

## Dead Code

A full import-graph scan was performed across `src/` and `server/`. All components, hooks, and server modules were found to have at least one import site. The TypeScript compiler enforces `noUnusedLocals: true` and `noUnusedParameters: true`, which provides continuous dead-code detection at build time.

| File | Export / Symbol | Type | Recommendation |
|---|---|---|---|
| — | — | — | No orphan files, unused exports, or unreachable functions detected |

**Notes:**
- `src/components/ModuleBrowser.tsx` is imported only by `LeftSidebar.tsx` — not orphaned, but is a single-use component worth monitoring.
- The TypeScript strict-mode compiler configuration (`noUnusedLocals`, `noUnusedParameters`) provides ongoing automated dead-code enforcement, making this category low-risk.

---

## TODO/FIXME Tracker

A scan of all `.ts` and `.tsx` files under `src/` and `server/` found **zero** `TODO`, `FIXME`, `HACK`, `XXX`, or `WORKAROUND` comments in production code. The only matches were in test files asserting on the literal string `"TODO"` as a test input (e.g., `claude-process.test.ts`).

| File:Line | Type | Comment | Author | Date | Stale? |
|---|---|---|---|---|---|
| — | — | No items found | — | — | — |

**Summary:**
- Total: **0**
- By type: n/a
- Stale (>30 days): **0**

---

## Config Drift

### `tsconfig.app.json` / `tsconfig.node.json`

| Config File | Setting | Current Value | Notes |
|---|---|---|---|
| `tsconfig.app.json` | `target` | `ES2022` | Good — matches modern browser support |
| `tsconfig.node.json` | `target` | `ES2023` | One version ahead of app config — minor inconsistency |
| Both | `strict: true` | `true` | Excellent |
| Both | `noUnusedLocals` | `true` | Excellent |
| Both | `noUnusedParameters` | `true` | Excellent |
| Both | `noFallthroughCasesInSwitch` | `true` | Excellent |
| Both | `skipLibCheck` | `true` | Acceptable for app code; standard practice |

**Finding 1 — ES target mismatch:** `tsconfig.app.json` targets `ES2022` while `tsconfig.node.json` targets `ES2023`. These configs cover different scopes (browser vs. Vite config), so this is not a functional issue, but aligning them to `ES2023` would be cleaner.

### `eslint.config.js`

| Setting | Current Value | Recommended Value | Severity |
|---|---|---|---|
| `ecmaVersion` (both frontend + server blocks) | `2020` | `2022` or `"latest"` | Minor — lags behind `ES2022`/`ES2023` tsconfig targets |
| `@typescript-eslint/no-non-null-assertion` | `'warn'` | `'error'` (long-term) | Technical debt — documented as intentional |
| `@typescript-eslint/no-unsafe-assignment` | `'warn'` | `'error'` (long-term) | Technical debt — documented as intentional |
| `@typescript-eslint/no-unsafe-member-access` | `'warn'` | `'error'` (long-term) | Technical debt — documented as intentional |
| `@typescript-eslint/no-misused-promises` | `'warn'` | `'error'` (long-term) | Technical debt — documented as intentional |

**Finding 2 — `ecmaVersion: 2020` lag:** The ESLint `ecmaVersion` in both frontend and server blocks is `2020`, while TypeScript targets `ES2022`/`ES2023`. This means ESLint may not recognize newer syntax as valid in some edge cases. Setting `ecmaVersion: 2022` or `"latest"` would align with the compiler target.

**Finding 3 — Warn-downgraded rules:** Several TypeScript-ESLint rules are explicitly demoted to `'warn'` for "incremental adoption" (documented inline). These represent acknowledged technical debt. Tracking progress toward promoting them back to `'error'` over time would be beneficial.

### Prettier

No Prettier config found. The project appears to rely on ESLint for formatting conventions.

---

## License Compliance

The project is MIT licensed. No GPL, AGPL, or LGPL dependencies were found.

**License Distribution (611 total packages):**

| License | Count | Notes |
|---|---|---|
| MIT | 524 | Permissive — compatible |
| ISC | 23 | Permissive — compatible |
| Apache-2.0 | 19 | Permissive — compatible |
| MPL-2.0 | 12 | See note below |
| BSD-3-Clause | 10 | Permissive — compatible |
| BSD-2-Clause | 8 | Permissive — compatible |
| BlueOak-1.0.0 | 4 | Permissive — compatible |
| MIT-0 | 2 | Permissive — compatible |
| CC-BY-4.0 | 1 | Data license (caniuse-lite) — see note |
| Python-2.0 (PSF) | 1 | Permissive — compatible |
| (MPL-2.0 OR Apache-2.0) | 1 | dompurify — dual-licensed, compatible |
| (MIT OR WTFPL) | 1 | expand-template — permissive |
| CC0-1.0 | 1 | Public domain |
| 0BSD | 1 | Permissive — compatible |
| (BSD-2-Clause OR MIT OR Apache-2.0) | 1 | Permissive |
| UNKNOWN (no field) | 2 | busboy, streamsearch — see note |

**Flagged items:**

| Package | License | Issue | Verdict |
|---|---|---|---|
| `lightningcss` (+ platform variants, 12 total) | MPL-2.0 | Copyleft, but build-time only | **Not a concern** — documented in `package.json` `licenseNotes`; not bundled into distributed artifacts |
| `dompurify` | MPL-2.0 OR Apache-2.0 | Dual-licensed | **Not a concern** — dual-license with Apache-2.0 is permissive; documented in `package.json` |
| `busboy` | Missing in lock file | No `license` field in `package-lock.json` | **Low risk** — MIT `LICENSE` file present in `node_modules/busboy/`; transitive dep of `multer` |
| `streamsearch` | Missing in lock file | No `license` field in `package-lock.json` | **Low risk** — MIT `LICENSE` file present in `node_modules/streamsearch/`; transitive dep of `busboy` |
| `caniuse-lite` | CC-BY-4.0 | Data license, not software license | **Low risk** — CC-BY-4.0 covers the browser compatibility data; widely accepted for this use case |
| `argparse` | Python-2.0 | PSF (Python Software Foundation) License | **Low risk** — PSF License is permissive and well-recognized; standard for argparse (used by `js-yaml`) |

**Overall license posture: Clean.** No copyleft exposure in distributed artifacts. Both MPL-2.0 concerns are already acknowledged in `package.json`'s `licenseNotes` field.

---

## Documentation Freshness

### API Docs

| Doc File | Status | Last Updated | Notes |
|---|---|---|---|
| `docs/ORCHESTRATOR-SPEC.md` | Partially stale | 2026-03-23 | Still marked **"Status: Draft v0.1"** despite the orchestrator being GA in v0.5.0. Spec content was updated for the 5-session limit but the status line was not promoted. |
| `docs/WORKFLOWS.md` | Not verified as stale | — | Workflows feature is active; last major docs change was ~March 18 |
| `docs/GITHUB-WEBHOOKS-SPEC.md` | Not verified as stale | — | Webhook feature is active |
| `docs/stream-json-protocol.md` | Not verified as stale | — | Core protocol doc; no REST API reference exists |
| REST API endpoints | **Undocumented** | — | No API reference exists for server REST endpoints (session, approval, orchestrator, webhook routes). `API-REFERENCE.md` exists in `docs/` but covers the WebSocket/stream-json protocol, not HTTP routes. |

**Finding — ORCHESTRATOR-SPEC.md status field:** The spec header still reads `Status: Draft v0.1`. The orchestrator is now in production and has been the subject of 20+ commits in the last 7 days. The status should be updated to `Status: v1.0 (Stable)` or similar.

**Finding — No HTTP REST API reference:** The server exposes HTTP endpoints for sessions, approvals, diffs, uploads, webhooks, docs, and orchestrator management. None of these are documented in a discoverable API reference. As the project grows, this becomes a friction point for contributors.

### README Drift

| README Section | Status | Notes |
|---|---|---|
| Install prerequisites | Accurate | Node.js 20+, Claude Code CLI |
| `npm run dev` script | Accurate | Matches `package.json` |
| `npm run build` | Accurate | `tsc -b && vite build` |
| `npm test` | Accurate | `vitest run` |
| `npm run lint` | Accurate | `eslint .` |
| Features list | Accurate | Agent Joe, worktrees, skills, workflows all listed correctly |
| Configuration table | Accurate | `PORT`, `REPOS_ROOT` are the current env vars |
| `codekin upgrade` command | Accurate | Command was added in recent releases |
| `docs/INSTALL-DISTRIBUTION.md` reference | Not verified | File exists in `docs/` |

**README drift: None detected.** The README is up to date with the current codebase.

---

## Draft Changelog

### v0.5.x — 2026-03-19 to 2026-03-26

#### Features
- Add session lifecycle hooks and orchestrator approval endpoints (#235)
- Add tooltips to sidebar session status indicators
- Show color-coded status dot for Agent Joe in sidebar
- Use Agent Joe icon for session status instead of separate dot

#### Fixes
- **Plan mode gating**: Enforce plan mode gating via hook + `PlanManager` state machine (#258)
- **ExitPlanMode**: Use deny-with-message pattern for ExitPlanMode hook approval (#255); prevent double-approval and timeout-denial bugs (#245); exit plan mode immediately when `PreToolUse` hook approves it (#244)
- **Orchestrator stability**: Resolve listener leak, type-unsafe mutations, and wrong orchestrator path; prevent double-gating race on respond endpoint (#241); don't mark child session completed while tool approvals are pending (#240); wire up orchestrator prompt listener and extend child approval timeout (#238); harden report path guard and `branchName` validation (#237)
- **Orchestrator UX**: Remove stall timer warning from orchestrator chat (#256); show stall warning only once per user turn (#252); suppress repetitive orchestrator noise in chat (#251); polish orchestrator chat view — resizable input, remove clutter (#247); improve orchestrator empty state layout (#254); use gray color for approval/denial messages (#243); use status-derived color for session icons
- **AskUserQuestion**: Handle via `PreToolUse` hook; properly extract questions/options and format answers (#230); increase font size for question prompts (#232); workaround CLI `requiresUserInteraction` flag in stream-json mode (#231)
- **Approvals**: Save exact commands when "Always Allow" is clicked for non-patternable commands (#246); dual-write approvals to native `settings.local.json` and load at session spawn
- **Orchestrator config**: Update system prompt and spec to reflect 5 concurrent session limit (#249, #236); orchestrator asks repo policy before first session spawn (#227); add `CronCreate`/`Delete`/`List` to Agent Joe allowed tools
- **Rename**: Rename shepherd → orchestrator, make agent name configurable in settings (#224, #225)
- Add missing `isOrchestrator` dep to `onDragStart` useCallback (#248)
- Remove unnecessary template literal in ws-server prompt notification (#239)
- Fix `flatted` to resolve high-severity prototype pollution vulnerability
- Exclude exact commands from `--allowedTools` to prevent CLI parser crash; escape parentheses in `--allowedTools`

#### Refactoring
- Replace distributed plan mode flags with `PlanManager` state machine (#257)

#### Documentation
- Add v0.5.0 changelog and update README features
- Update orchestrator spec to reflect 5 concurrent session limit
- Implement comment audit improvements across 11 files

#### Chores
- Bump version to 0.5.0
- Add automated code review and repo health reports
- Add and prune daily health reports

---

## Stale Branches

No remote branches have their last commit older than 30 days (cutoff: 2026-02-24). All branch activity is recent (March 14 – March 25, 2026).

However, a significant number of branches show the pattern of **1–2 commits ahead, many commits behind main**, indicating they were squash-merged into main and their remote branches were not deleted. These are "shadow" branches and should be pruned.

### Shadow branches (likely squash-merged, safe to delete)

| Branch | Last Commit | Behind Main | Merged? | Recommendation |
|---|---|---|---|---|
| `fix/plan-mode-exit-stuck` | 2026-03-22 | 46 | No (squash) | Delete — superseded by #257/#258 |
| `refactor/shepherd-to-orchestrator` | 2026-03-22 | 46 | No (squash) | Delete — superseded by #224 |
| `fix/orchestrator-greeting-guidelines` | 2026-03-22 | 42 | No (squash) | Delete — superseded by #226 |
| `fix/orchestrator-repo-policy-discovery` | 2026-03-22 | 42 | No (squash) | Delete |
| `fix/control-response-format` | 2026-03-22 | 37 | No (squash) | Delete — superseded by #223 |
| `ui/question-prompt-sizing` | 2026-03-22 | 37 | No (squash) | Delete — superseded by #232 |
| `test/coverage-gaps` | 2026-03-23 | 33 | No (squash) | Delete — superseded by #233 |
| `feat/session-lifecycle-hooks` | 2026-03-23 | 30 | No (squash) | Delete — superseded by #235 |
| `fix/orchestrator-concurrent-limit` | 2026-03-23 | 29 | No (squash) | Delete |
| `fix/orchestrator-security-hardening` | 2026-03-23 | 29 | No (squash) | Delete |
| `fix/orchestrator-approval-wiring` | 2026-03-23 | 27 | No (squash) | Delete |
| `test/approval-flow-v3` | 2026-03-23 | 24 | No (squash) | Delete |
| `fix/respond-endpoint-race-condition` | 2026-03-23 | 24 | No (squash) | Delete |
| `fix/orchestrator-info-message-color` | 2026-03-23 | 21 | No (squash) | Delete |
| `fix/exit-plan-mode-stuck-after-approval` | 2026-03-23 | 20 | No (squash) | Delete |
| `fix/exit-plan-mode-approval-bugs` | 2026-03-23 | 19 | No (squash) | Delete — superseded by #245 |
| `fix/always-allow-exact-commands` | 2026-03-23 | 18 | No (squash) | Delete — superseded by #246 |
| `fix/orchestrator-chat-polish` | 2026-03-23 | 17 | No (squash) | Delete — superseded by #247 |
| `fix/orchestrator-concurrent-limit-docs` | 2026-03-23 | 13 | No (squash) | Delete |
| `fix/suppress-orchestrator-noise` | 2026-03-24 | 11 | No (squash) | Delete — superseded by #251 |
| `fix/orchestrator-empty-state-layout` | 2026-03-24 | 6 | No (squash) | Delete — superseded by #254 |
| `fix/exit-plan-mode-deny-with-message` | 2026-03-24 | 6 | No (squash) | Delete — superseded by #255 |
| `fix/remove-stall-timer` | 2026-03-24 | 4 | No (squash) | Delete — superseded by #256 |
| `fix/pending-prompts-completed-sessions` | 2026-03-23 | ~24 | No (squash) | Delete |

### Notable divergent branches

| Branch | Last Commit | Ahead | Behind | Recommendation |
|---|---|---|---|---|
| `codekin/reports` | 2026-03-25 | 35 | 298 | High conflict risk — review intent; likely candidate for deletion or rebase |
| `feat/joe-chat-variant` | 2026-03-17 | 1 | 151 | Appears abandoned; if not being developed, delete |
| `chore/repo-health-report-2026-03-14` | 2026-03-14 | 2 | 298 | Old report branch — delete |
| `chore/repo-health-report-2026-03-18` | 2026-03-18 | 2 | 144 | Old report branch — delete |
| `chore/repo-health-report-2026-03-25` | 2026-03-25 | 2 | 2 | Recent report branch — close or merge |
| `refactor/plan-manager-state-machine` | 2026-03-25 | 1 | 2 | Recent — likely squash-merged as #257; delete |

---

## PR Hygiene

**No open pull requests** were found at the time of this report (`gh pr list` returned an empty array).

The repository appears to be using a squash-merge workflow where feature branches are merged promptly but their remote refs are not deleted after merge (see Stale Branches above).

---

## Merge Conflict Forecast

Active branches (commits in last 14 days) were analyzed for divergence from `origin/main`.

| Branch | Commits Ahead | Commits Behind | Risk Level | Notes |
|---|---|---|---|---|
| `codekin/reports` | 35 | 298 | **HIGH** | 35 unique commits not on main, and 298 main commits not on this branch. High surface area for conflicts across many files |
| `feat/joe-chat-variant` | 1 | 151 | **MEDIUM** | Diverged significantly; likely touches UI files that have been heavily modified on main |
| `chore/repo-health-report-2026-03-14` | 2 | 298 | **HIGH (if revived)** | Extremely divergent; effectively unrebaseable without effort |
| `chore/repo-health-report-2026-03-18` | 2 | 144 | **HIGH (if revived)** | Same pattern |
| `fix/suppress-orchestrator-noise` | 2 | 11 | **LOW** | Close to main; superseded by #251 |
| `chore/repo-health-report-2026-03-25` | 2 | 2 | **LOW** | Nearly current; easy to rebase |
| `refactor/plan-manager-state-machine` | 1 | 2 | **LOW** | Virtually current; easy to rebase |

**Key risk: `codekin/reports` branch.** With 35 commits ahead and 298 behind, any attempt to rebase or merge this branch would involve significant conflict resolution across server and frontend files that have been heavily refactored. This branch should be investigated — if it is a long-running feature branch, it needs immediate attention; if it is an artifact of an automated reporting workflow, it should be cleaned up.

---

## Recommendations

1. **[HIGH] Prune ~24 post-merge shadow branches** — Run a batch `git push origin --delete <branch>` for all squash-merged branches listed in the Stale Branches section. This will reduce remote branch noise and make the branch list actionable. Consider automating branch deletion on squash-merge via GitHub branch protection settings ("Automatically delete head branches").

2. **[HIGH] Investigate and resolve `codekin/reports` branch** — This branch is 35 commits ahead and 298 behind main. If it belongs to an automated reporting workflow, audit whether it should write directly to main instead of accumulating on a separate branch. If it is a feature branch, rebase it now before further drift.

3. **[MEDIUM] Promote ORCHESTRATOR-SPEC.md from "Draft" to stable** — Update the `Status: Draft v0.1` header to reflect the current production state (v0.5.0). The spec is actively maintained and the feature is GA.

4. **[MEDIUM] Fix ESLint `ecmaVersion: 2020` lag** — Update the `ecmaVersion` in `eslint.config.js` to `2022` (or `"latest"`) in both the frontend and server rule blocks to align with the TypeScript compilation targets (`ES2022`/`ES2023`).

5. **[MEDIUM] Add a REST API reference document** — The server exposes 8+ route groups (sessions, approvals, auth, diffs, uploads, webhooks, docs, orchestrator, workflows). Create `docs/API-REFERENCE.md` covering HTTP endpoints, request/response shapes, and authentication. This is the biggest documentation gap.

6. **[LOW] Align `tsconfig` ES targets** — `tsconfig.app.json` targets `ES2022`; `tsconfig.node.json` targets `ES2023`. Aligning both to `ES2023` would keep the configs consistent with no functional downside.

7. **[LOW] Track ESLint warn→error promotion progress** — The ESLint config documents that several rules were intentionally demoted to `'warn'` for "incremental adoption." Create a tracking issue or checklist to gradually promote `no-unsafe-assignment`, `no-non-null-assertion`, `no-misused-promises`, and related rules back to `'error'` as the codebase is cleaned up.

8. **[LOW] Document `busboy`/`streamsearch` license in `package.json`** — These two transitive dependencies (of `multer`) have MIT license files but no `license` field in `package-lock.json`. Adding a note in `licenseNotes` (as was done for `dompurify` and `lightningcss`) provides an audit trail.

9. **[LOW] Delete `feat/joe-chat-variant`** — This branch is 1 commit ahead and 151 behind main. It appears to be an abandoned UI experiment. If there is no active plan to develop it, delete it to reduce noise.

10. **[INFO] No dead code or TODO/FIXME debt** — The combination of `noUnusedLocals`, `noUnusedParameters`, strict TypeScript, and active ESLint enforcement keeps the codebase clean. This is excellent hygiene; continue enforcing at the build level.
