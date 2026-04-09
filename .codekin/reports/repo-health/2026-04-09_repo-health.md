# Repository Health: codekin

**Date**: 2026-04-09T03:24:21.219Z
**Repository**: /srv/repos/codekin
**Branch**: main
**Workflow Run**: c0f2f83c-0065-4a64-8243-9a7ec8d004e0
**Session**: 5907a5ea-3b05-4757-9832-3ad0ffaeb070

---

Good, now let me gather the remaining data in parallel.Now I have all the data needed. Let me compile the final report.Now I have everything needed. Let me write the report.

```markdown
# Codekin Repository Health Assessment — 2026-04-09

## Summary

**Overall Health: Good**

The repository is in active, well-maintained shape. CI is green, all open work was merged yesterday (2026-04-08) across 10 PRs, no open PRs remain, and there are zero stale TODO/FIXME items. The main housekeeping needs are: (1) a cluster of dead orchestrator-related code that should be removed, (2) 9 stale remote branch refs from yesterday's merged PRs, (3) a handful of minor config inconsistencies, and (4) a small CORS default misdocumentation.

| Category | Count / Status |
|---|---|
| Dead code items | 13 (10 functions + 1 constant + 2 type clusters) |
| Stale TODOs/FIXMEs | 0 |
| Config issues | 7 minor |
| License concerns | 0 (3 MPL-2.0 acknowledged, build-time only) |
| Doc drift items | 4 (1 medium, 3 low) |
| Stale branches | 0 truly stale; 9 merged-PR refs pending deletion |
| Stuck open PRs | 0 (no open PRs) |
| High merge-conflict risk | 0 (all branches already merged) |

---

## Dead Code

> All findings are in the `src/` or `server/` directories. No orphan files were detected — all non-entry-point source files are imported by at least one other file.

| File | Export / Function | Type | Recommendation |
|---|---|---|---|
| `src/lib/ccApi.ts` | `getOrchestratorStatus()` | Unused export | Remove — orchestrator feature inactive |
| `src/lib/ccApi.ts` | `getOrchestratorReports()` | Unused export | Remove — orchestrator feature inactive |
| `src/lib/ccApi.ts` | `getOrchestratorChildren()` | Unused export | Remove — orchestrator feature inactive |
| `src/lib/ccApi.ts` | `spawnOrchestratorChild()` | Unused export | Remove — orchestrator feature inactive |
| `src/lib/ccApi.ts` | `queryOrchestratorMemory()` | Unused export | Remove — orchestrator feature inactive |
| `src/lib/ccApi.ts` | `getOrchestratorTrust()` | Unused export | Remove — orchestrator feature inactive |
| `src/lib/ccApi.ts` | `getOrchestratorNotifications()` | Unused export | Remove — orchestrator feature inactive |
| `src/lib/ccApi.ts` | `getOrchestratorDashboard()` | Unused export | Remove — orchestrator feature inactive |
| `server/commit-event-hooks.ts` | `installCommitHook()` | Unused export | Remove — abandoned feature, ~35 lines |
| `server/commit-event-hooks.ts` | `uninstallCommitHook()` | Unused export | Remove — abandoned feature, ~35 lines |
| `server/orchestrator-reports.ts` | `scanAllReports()` | Unused export | Remove — no callers anywhere in codebase |
| `src/lib/workflowHelpers.ts` | `DAY_PATTERNS` | Unused export | Remove — `DAY_PRESETS`/`DAY_INDIVIDUAL` used internally but this combined export is not |
| Various `src/types.ts` | Orchestrator types: `ChildSessionRequest`, `ChildStatus`, `ChildSession`, `TrustLevel`, `TrustRecord`, `MemoryCandidate`, `SkillLevel`, `DecisionRecord` | Unused type exports | Remove as a group if orchestrator feature is abandoned |

**Pattern:** The 8 orchestrator API functions in `ccApi.ts`, the `scanAllReports` function in `orchestrator-reports.ts`, and the orchestrator type cluster in `types.ts` all form a coherent dead-code island — an incomplete or abandoned "orchestrator" feature. These should be removed as a unit.

---

## TODO/FIXME Tracker

> Scanned all `.ts`, `.tsx`, `.js`, `.mjs` files in `src/` and `server/`. Today's cutoff for "stale" is 2026-03-10 (30 days before 2026-04-09).

| File:Line | Type | Comment | Author | Date | Stale? |
|---|---|---|---|---|---|
| `server/plan-manager.ts:8` | WORKAROUND | `deny-with-message workaround for ExitPlanMode` | alari | 2026-03-25 | No |
| `server/plan-manager.ts:22` | WORKAROUND | `On approve: hook returns deny-with-approval-message (CLI workaround for requiresUserInteraction)` | alari | 2026-03-25 | No |

Both are intentional JSDoc annotations documenting a known Claude CLI behavioral constraint (the `ExitPlanMode` deny-with-approval-message pattern). They are not deferred work items.

Three occurrences of the string literal `'TODO'` appear in `server/claude-process.test.ts:61,62,810` (blamed to 2026-03-08, >30 days) — these are test fixture values passed to `summarizeToolInput()`, not debt markers.

**Summary:**

| Type | Count | Stale |
|---|---|---|
| TODO | 0 | 0 |
| FIXME | 0 | 0 |
| HACK | 0 | 0 |
| XXX | 0 | 0 |
| WORKAROUND | 2 (intentional) | 0 |
| **Total** | **2** | **0** |

---

## Config Drift

| Config File | Setting | Current Value | Recommended Value / Action |
|---|---|---|---|
| `package.json` + `server/package.json` | TypeScript version | Frontend: `^6.0.2`, Server: `~5.9.3` | Align both to `^6.0.2` — two different versions cause inconsistent type checking |
| `tsconfig.node.json` | `target` | `ES2023` | `ES2022` — inconsistent with `tsconfig.app.json` and `server/tsconfig.json` (both `ES2022`) |
| `server/tsconfig.json` | `noUncheckedSideEffectImports` | Missing | Add `true` — present in other configs, provides consistent safety checks |
| `eslint.config.js` | Rule severity (8 rules) | `warn` | Promote to `error` over time — warnings allow CI to pass with violations |
| `eslint.config.js` | Test file config | `tseslint.configs.recommended` | Consider `strictTypeChecked` — test code currently gets less strict type checking than production code |
| `package.json` | `lint` script | `"eslint ."` | `"eslint src server vite.config.ts"` — current form may lint build outputs |
| `server/package.json` | `overrides.vite` | `"^8.0.5"` | Remove — Vite is not a direct server dependency; this override is spurious |

**Positive findings:** `strict: true` is set in all TypeScript configs; ESLint uses modern flat config (v9+) with `strictTypeChecked` for frontend and server; Prettier config is clean.

---

## License Compliance

**Project license:** MIT

**Summary (509 packages):**

| License | Count | Notes |
|---|---|---|
| MIT | 441 | Permissive ✓ |
| ISC | 20 | Permissive ✓ |
| Apache-2.0 | 18 | Permissive ✓ |
| BSD-3-Clause | 9 | Permissive ✓ |
| BSD-2-Clause | 8 | Permissive ✓ |
| MPL-2.0 | 3 | Weak copyleft — see below |
| MIT-0 | 2 | Permissive ✓ |
| BlueOak-1.0.0 | 2 | Permissive ✓ |
| MPL-2.0 OR Apache-2.0 | 1 | Dual-licensed — see below |
| CC-BY-4.0 | 1 | Data only (`caniuse-lite`) ✓ |
| CC0-1.0 | 1 | Public domain (`mdn-data`) ✓ |
| MIT OR WTFPL | 1 | Permissive either way ✓ |
| 0BSD | 1 | Public domain (`tslib`) ✓ |

**Flagged packages:**

| Package | License | Risk | Notes |
|---|---|---|---|
| `lightningcss` + 2 platform binaries | MPL-2.0 | Low | Build-time only (TailwindCSS dep); not shipped in built artifacts |
| `dompurify` | MPL-2.0 OR Apache-2.0 | Negligible | Dual-licensed; Apache-2.0 option is fully permissive |

Both MPL-2.0 situations are already acknowledged in `package.json`'s `licenseNotes` field. No GPL, AGPL, LGPL, SSPL, BUSL, or EPL packages detected. All 509 packages have a recognised SPDX identifier — zero unknown licenses.

---

## Documentation Freshness

### API / Protocol Docs

The `docs/API-REFERENCE.md` and `docs/stream-json-protocol.md` were updated on 2026-04-08 (PR #300) to remove stale endpoints and fix env var names. The WebSocket message types in `src/types.ts` and the `session-lifecycle.ts` refactor (PR #308) are internal — no protocol changes required doc updates. No server-route drift detected.

### README Drift

The `README.md` scripts (`npm run dev`, `npm run build`, `npm test`, `npm run lint`, `npm run test:watch`) all exist in `package.json`. No drift.

### Stale Doc Items

| File | Line | Issue | Severity |
|---|---|---|---|
| `docs/INSTALL-DISTRIBUTION.md` | ~141 | `CORS_ORIGIN` default documented as `*`; actual default in `server/config.ts` is `http://localhost:5173` | Medium |
| `docs/SETUP.md` | ~395 | `lib/` directory described as containing "terminal theme" — no such file exists (removed with xterm.js) | Low |
| `docs/SETUP.md` | ~351 | "Updating" section includes `cd server && npm install` — server deps are now in root `package.json` | Low |
| `CLAUDE.md` | components example | `RepoSelector` listed as example component; file was removed (replaced by `RepoList.tsx`/`RepoSection.tsx`) | Very Low |

---

## Draft Changelog

> Covers commits since tag `v0.5.4` (2026-04-06) through 2026-04-09. 16 commits on `main`.

### Refactoring
- Extract session lifecycle logic into dedicated `session-lifecycle.ts` module (#308)
- Extract `PromptRouter` from `SessionManager` into its own module (#303)

### Fixes
- Strip `GIT_*` environment variables when spawning Claude CLI processes to prevent env leakage (#307)
- Prevent worktree restart death loops by validating CWD before restart (#305)
- Prevent broken worktree directories from causing infinite restart loops (#304)
- Preserve `claudeSessionId` on spawn failures (ENOENT) so session history is not lost (#302)
- Resolve session restart race conditions and worktree index corruption (#301)
- Prevent caller-supplied branch names from being deleted; use `show-ref` for branch detection
- Remove unused WebSocket import in `prompt-router`

### Tests
- Add unit tests covering session restart and worktree fix scenarios (#306)

### Documentation
- Fix stale paths, env var names, and remove non-existent API endpoints from docs (#300)

### Chores
- Add workflow reports for 2026-04-07 (#299)
- Security, reliability, and housekeeping fixes (#298)

---

## Stale Branches

> No branches have been inactive for 30+ days. All 9 non-main remote branches received their last commit on 2026-04-08 (yesterday). However, all 9 correspond to PRs that were merged yesterday — their remote refs are now orphaned and should be deleted.

| Branch | Last Commit | Author | PR | Merged? | Recommendation |
|---|---|---|---|---|---|
| `refactor/extract-session-lifecycle` | 2026-04-08 | alari | #308 | Yes | Delete remote ref |
| `fix/strip-git-env-vars-from-claude-spawn` | 2026-04-08 | alari | #307 | Yes | Delete remote ref |
| `test/cover-session-restart-fixes` | 2026-04-08 | alari | #306 | Yes | Delete remote ref |
| `fix/worktree-restart-resilience` | 2026-04-08 | alari | #305 | Yes | Delete remote ref |
| `fix/worktree-creation-resilience` | 2026-04-08 | alari | #304 | Yes | Delete remote ref |
| `refactor/session-manager-extract` | 2026-04-08 | alari | #303 | Yes | Delete remote ref |
| `fix/spawn-failure-preserve-session-id` | 2026-04-08 | alari | #302 | Yes | Delete remote ref |
| `fix/session-restart-race-conditions` | 2026-04-08 | alari | #301 | Yes | Delete remote ref |
| `docs/cleanup-2026-04-08` | 2026-04-08 | alari | #300 | Yes | Delete remote ref |

---

## PR Hygiene

**No open PRs.** All recent work was merged on 2026-04-08.

**Notable closed PRs to be aware of:**

| PR# | Title | Status | Note |
|---|---|---|---|
| #309 | fix: resolve all 24 lint errors | Closed without merging | Lint errors may still be present — verify with `npm run lint` |
| #297 | chore: add repo health report | Closed without merging | Superseded by subsequent reports |
| #296 | Chore/docs optimize 2026-04-06 | Closed without merging | Superseded |

PR #309 is the most relevant: it was closed without merging, suggesting the 24 lint errors it addressed may remain in the codebase. This should be verified.

---

## Merge Conflict Forecast

All 9 non-main remote branches correspond to **already-merged PRs**. There are no truly active unmerged branches. The "ahead" commits visible on those branches are pre-squash branch tips that were superseded by the squash merge into main — they pose no conflict risk.

| Branch | Ahead | Behind | Status | Risk |
|---|---|---|---|---|
| All 9 listed above | 0–5 (artifact) | 1–14 | Merged via PR | None — branch can be deleted |

No active unmerged work is currently diverged from `main`.

---

## Recommendations

1. **Remove orphaned remote branch refs** (9 branches) — these all correspond to merged PRs from 2026-04-08 and add noise to `git branch -r`. Run `git push origin --delete <branch>` for each, or use `git remote prune origin` after deleting via GitHub.

2. **Delete the dead orchestrator code island** — the 8 functions in `src/lib/ccApi.ts`, `server/orchestrator-reports.ts:scanAllReports()`, and the orchestrator types in `src/types.ts` are all unreferenced. Removing them reduces the codebase by ~150–200 lines and eliminates misleading surface area. Do this as a single PR.

3. **Verify lint status after PR #309 was closed** — PR #309 ("fix: resolve all 24 lint errors") was closed without merging. Run `npm run lint` to determine if lint errors remain in the current `main` branch. If so, open a fresh fix branch.

4. **Fix `CORS_ORIGIN` documentation in `INSTALL-DISTRIBUTION.md`** — the documented default (`*`) differs from the actual default (`http://localhost:5173`). This is a medium-severity issue for anyone deploying from docs alone.

5. **Remove `installCommitHook`/`uninstallCommitHook` from `server/commit-event-hooks.ts`** — these are dead code from an abandoned feature with zero callers. Can be batched into the orchestrator cleanup PR.

6. **Align TypeScript versions** — `package.json` allows `^6.0.2` while `server/package.json` pins `~5.9.3`. Align both to `^6.0.2` (or use a workspace-level single TS install) to avoid subtle type-checking inconsistencies.

7. **Tag a new release** — 16 commits (including 8 fixes, 2 refactors, 1 test addition) have landed on `main` since `v0.5.4` (2026-04-06). This warrants at minimum a `v0.5.5` patch tag.

8. **Remove `workflowHelpers.ts:DAY_PATTERNS`** — unused export; can be removed in a small cleanup PR or batched with item 2.

9. **Standardise `tsconfig.node.json` target** — change `ES2023` to `ES2022` to match the other two tsconfig files and eliminate a subtle inconsistency in the build pipeline.

10. **Update `docs/SETUP.md`** — fix the two low-severity items: remove the stale "terminal theme" description from the `lib/` entry and remove the obsolete `cd server && npm install` step from the "Updating" section.
```Report written to `.codekin/reports/repo-health/2026-04-09_repo-health.md`.

---

Here's the executive summary of findings:

**Overall Health: Good**

The repo is in solid shape — 10 PRs merged cleanly yesterday, zero open PRs, zero stale TODOs, clean license tree. The main action items:

**Top priorities:**
1. **Dead orchestrator code** — 8 unused API functions in `src/lib/ccApi.ts`, `scanAllReports()` in `server/orchestrator-reports.ts`, and a cluster of orphaned types in `src/types.ts` form a coherent dead-code island (~150–200 lines). Remove as one PR.
2. **Verify lint errors** — PR #309 ("fix: resolve all 24 lint errors") was closed without merging. Run `npm run lint` to confirm whether those errors are still present.
3. **Delete 9 stale remote branch refs** — all correspond to yesterday's merged PRs; safe to prune.
4. **Fix `CORS_ORIGIN` docs** — `INSTALL-DISTRIBUTION.md` documents the default as `*` but `server/config.ts` defaults to `http://localhost:5173`.
5. **Tag `v0.5.5`** — 16 commits have landed since `v0.5.4`.

**Minor config drift:** TypeScript version mismatch between `package.json` (`^6.0.2`) and `server/package.json` (`~5.9.3`); `tsconfig.node.json` targets `ES2023` while others target `ES2022`; spurious Vite override in `server/package.json`.