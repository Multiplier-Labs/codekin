# Repository Health Assessment — 2026-04-10

## Summary

**Overall Health: Good**

The codebase is in strong shape. TypeScript strict mode with `noUnusedLocals`/`noUnusedParameters` enforced across all configs eliminates dead code at compile time; no production TODO/FIXME debt exists. Active development is high (22 commits since v0.5.4 in ~9 days). The primary areas for attention are: orphaned compiled artifacts in `server/dist/`, a single open PR pending review, and a cluster of unmerged branches that appear to have been superseded by squash-merged equivalents on `main`.

| Metric | Value |
|---|---|
| Dead code items | 0 source; ~21 orphaned `server/dist/` artifacts |
| Stale TODOs | 0 |
| Config issues | 2 minor (ESLint rule demotion inconsistency; `server/tsconfig.json` scope) |
| License concerns | 2 packages with `UNKNOWN` in lock file (confirmed MIT in package.json) |
| Doc drift items | 0 (docs updated April 8; CHANGELOG current at v0.5.4) |
| Stale branches (>30 days) | 0 |
| Unmerged branches (cleanup candidates) | 4 confirmed merged; 9 likely superseded |
| Open PRs | 1 (#310, 1 day old, no review) |

---

## Dead Code

TypeScript strict compilation (`noUnusedLocals: true`, `noUnusedParameters: true`) prevents live dead code from existing in source files. No orphan source files, unused exports, or unreachable functions were found in `src/` or `server/`.

**Orphaned compiled artifacts** — source modules were deleted but their compiled output remains in `server/dist/`:

| File | Type | Recommendation |
|---|---|---|
| `server/dist/shepherd-children.{js,d.ts,js.map}` | Orphan compiled artifact | Delete — no source file |
| `server/dist/shepherd-learning.{js,d.ts,js.map}` | Orphan compiled artifact | Delete — no source file |
| `server/dist/shepherd-manager.{js,d.ts,js.map}` | Orphan compiled artifact | Delete — no source file |
| `server/dist/shepherd-memory.{js,d.ts,js.map}` | Orphan compiled artifact | Delete — no source file |
| `server/dist/shepherd-monitor.{js,d.ts,js.map}` | Orphan compiled artifact | Delete — no source file |
| `server/dist/shepherd-reports.{js,d.ts,js.map}` | Orphan compiled artifact | Delete — no source file |
| `server/dist/shepherd-routes.{js,d.ts,js.map}` | Orphan compiled artifact | Delete — no source file |
| `server/dist/review-config.{js,d.ts,js.map}` | Orphan compiled artifact | Delete — no source file |
| `server/dist/review-handler.{js,d.ts,js.map}` | Orphan compiled artifact | Delete — no source file |
| `server/dist/review-routes.{js,d.ts,js.map}` | Orphan compiled artifact | Delete — no source file |

**Note:** These do not affect runtime behaviour (they are never imported) but they create noise, inflate the distribution, and may confuse future reviewers. A `tsc --build --clean` followed by a fresh build would remove them.

---

## TODO/FIXME Tracker

**Zero production TODO/FIXME/HACK/XXX/WORKAROUND annotations found.**

A grep of all `.ts`, `.tsx`, `.js`, and `.mjs` files in `src/`, `server/*.ts`, and `bin/` returned no code-comment debt. The only matches are string literals in test fixtures (e.g., `server/claude-process.test.ts` uses `'TODO'` as synthetic input content, not as a code annotation).

| Total | By type | Stale (>30 days) |
|---|---|---|
| 0 | — | 0 |

---

## Config Drift

### `tsconfig.app.json` / `tsconfig.node.json` / `server/tsconfig.json`

All three configs enable `strict: true` plus `noUnusedLocals`, `noUnusedParameters`, `noFallthroughCasesInSwitch`, and `noUncheckedSideEffectImports`. This is exemplary. No drift found.

**Minor finding:**

| Config File | Setting | Current Value | Note |
|---|---|---|---|
| `server/tsconfig.json` | `include` | `["*.ts"]` | Only includes root-level server files. If any `.ts` files are placed in a subdirectory under `server/` (other than `node_modules`/`dist`), they will silently be excluded from compilation. Currently safe (only `server/workflows/*.md`), but worth adding `**/*.ts` as projects grow. |

### `eslint.config.js`

Using the modern flat config format (ESLint v10). TypeScript-eslint strict-type-checked is applied. Clean configuration overall.

**Minor findings:**

| Config File | Setting | Current Value | Recommended Value | Note |
|---|---|---|---|---|
| `eslint.config.js` | `@typescript-eslint/no-unsafe-assignment` | `warn` | `error` | Downgraded from strict default. Inconsistent: `no-unsafe-call` is still an error. The asymmetry means unsafe assignments pass silently. |
| `eslint.config.js` | `@typescript-eslint/no-unsafe-argument` | `warn` | `error` | Same inconsistency — call arguments can be `any` without error. |
| `eslint.config.js` | `@typescript-eslint/no-unsafe-return` | `warn` | `error` | Return types can leak `any`. |
| `eslint.config.js` | `@typescript-eslint/no-non-null-assertion` | `warn` | `error` | Non-null assertions (`!`) bypass type safety silently. |

These demotions appear intentional (pragmatic) but create a two-tier safety system where warnings accumulate unnoticed. Consider a periodic `eslint --max-warnings 0` check in CI to prevent warning accumulation.

### `.prettierrc`

```json
{ "semi": false, "singleQuote": true, "trailingComma": "all", "printWidth": 120, "tabWidth": 2 }
```

No issues. `printWidth: 120` is wider than the Prettier default (80) but consistent with a monospace terminal UI context. No conflicts with ESLint config.

### `vite.config.ts`

Proxy `"/cc/*" → http://127.0.0.1:32352` is hardcoded. The port matches the default in `config.ts`. No drift.

---

## License Compliance

Project license: **MIT**

### Summary Table

| License | Count | Compatibility with MIT |
|---|---|---|
| MIT | 465 | ✅ Compatible |
| ISC | 22 | ✅ Compatible |
| Apache-2.0 | 18 | ✅ Compatible |
| MPL-2.0 | 12 | ⚠️ File-level copyleft (see note) |
| BSD-3-Clause | 9 | ✅ Compatible |
| BSD-2-Clause | 8 | ✅ Compatible |
| BlueOak-1.0.0 | 4 | ✅ Compatible (permissive) |
| MIT-0 | 2 | ✅ Compatible |
| CC-BY-4.0 | 1 | ✅ Compatible (data/docs use) |
| CC0-1.0 | 1 | ✅ Compatible (public domain) |
| 0BSD | 1 | ✅ Compatible |
| (MPL-2.0 OR Apache-2.0) | 1 | ✅ Compatible |
| (MIT OR WTFPL) | 1 | ✅ Compatible |
| (BSD-2-Clause OR MIT OR Apache-2.0) | 1 | ✅ Compatible |

**Total dependencies with license metadata: 546**

### Flagged Dependencies

| Package | Lock File License | Actual License | Risk |
|---|---|---|---|
| `busboy` | `UNKNOWN` (in lock file) | MIT (confirmed in package.json) | None — lock file metadata missing, not an actual license issue |
| `streamsearch` | `UNKNOWN` (in lock file) | MIT (confirmed in package.json) | None — same as above |

**MPL-2.0 packages** (12 total: `dompurify` + `lightningcss` and its platform-specific binaries):

MPL-2.0 is "file-level copyleft": modifications to MPL-licensed files must be released under MPL, but combining MPL code with proprietary/MIT code in a larger work is permitted. Since Codekin uses these as unmodified dependencies (not forking or distributing modified versions of their source), there is **no compliance issue** for a web app distribution. No action required.

**No GPL, AGPL, or LGPL dependencies detected.**

---

## Documentation Freshness

### API Docs

`docs/API-REFERENCE.md` was last updated in commit `bb82455` (2026-04-04: "docs: update API reference, orchestrator spec, protocol docs, and changelog") and then again in `d8acba0` (2026-04-09: "chore: remove dead orchestrator API functions and fix CORS_ORIGIN doc"). The most recent server-side change — `session-lifecycle.ts` extraction (refactor #308) — is an internal refactor with no externally-visible API surface change. No stale API docs found.

### README Drift

README.md was reviewed against `package.json` scripts and project structure.

| Check | Status | Notes |
|---|---|---|
| `npm run dev` | ✅ Matches | `vite` in package.json |
| `npm run build` | ✅ Matches | `tsc -b && vite build` |
| `npm test` | ✅ Matches | `vitest run` |
| `npm run test:watch` | ✅ Matches | `vitest` |
| `npm run lint` | ✅ Matches | `eslint .` |
| Port 32352 | ✅ Matches | Referenced correctly in README and config.ts |
| `REPOS_ROOT` env var | ✅ Matches | Documented in README config table |
| `~/.config/codekin/env` config path | ✅ Matches | Consistent with install script |
| `codekin token`, `codekin config`, etc. | ✅ Matches | CLI commands align with `bin/codekin.mjs` |

**No README drift detected.** The docs were cleaned up in commits `01de339` and `57516a9` within the last 30 days.

### CHANGELOG

`CHANGELOG.md` was last updated at v0.5.4 (commit `87b8db8`, 2026-04-08). Since then, 22 commits have landed on `main` (see Draft Changelog below). The CHANGELOG is currently one release behind. This is expected until the next version bump.

---

## Draft Changelog

Changes since `v0.5.4` (tag) through `2026-04-10`:

### Fixes

- Strip uninformative agent noise lines from chat display (#313)
- Address three security audit findings: M1 (input validation), M2 (output escaping), W-2/L4 (#311)
- Strip `GIT_*` environment variables when spawning Claude CLI processes (#307)
- Prevent branch deletion on caller-supplied worktree branch names; use `show-ref` for detection (#305)
- Prevent worktree restart death loops via CWD existence validation (#305)
- Prevent broken worktree directories from causing infinite restart loops (#304)
- Preserve `claudeSessionId` on spawn failures (`ENOENT`) (#302)
- Resolve session restart race conditions and worktree index corruption (#301)
- Remove unused WebSocket import in `prompt-router`
- Security, reliability, and housekeeping fixes (#298)

### Refactoring

- Extract session lifecycle logic into `session-lifecycle.ts` (#308)
- Extract `PromptRouter` from `SessionManager` into standalone module (#303)

### Chores

- Remove dead orchestrator API functions; fix `CORS_ORIGIN` documentation
- Add workflow reports for 2026-04-07 (#299)

### Tests

- Add unit tests for session restart and worktree resilience fixes (#306)

### Documentation

- Fix stale paths, env vars, and remove non-existent endpoints from docs (#300)

---

## Stale Branches

All remote branches were last active on **2026-04-08 or 2026-04-09** — none are older than 30 days. There are no stale branches by the >30-day criterion.

However, several branches are **cleanup candidates** — either confirmed-merged or superseded:

| Branch | Last Commit | Author | Merged into main? | Recommendation |
|---|---|---|---|---|
| `origin/chore/housekeeping-2026-04-09` | 2026-04-09 | alari | ✅ Yes (confirmed) | Delete |
| `origin/fix/security-audit-2026-04-09` | 2026-04-09 | alari | ✅ Yes (confirmed) | Delete |
| `origin/refactor/session-manager-extract` | 2026-04-08 | alari | ✅ Yes (confirmed) | Delete |
| `origin/fix/spawn-failure-preserve-session-id` | 2026-04-08 | alari | ✅ Yes (confirmed) | Delete |
| `origin/fix/session-restart-race-conditions` | 2026-04-08 | alari | ⚠️ No (squash-merged equivalent landed) | Likely superseded — review and delete |
| `origin/fix/strip-agent-noise-messages` | 2026-04-09 | alari | ⚠️ No (ahead=1, behind=1) | Behind by 1 commit — rebase or delete |
| `origin/fix/strip-git-env-vars-from-claude-spawn` | 2026-04-08 | alari | ⚠️ No (ahead=1, behind=7) | Superseded — fix landed via #307 |
| `origin/fix/worktree-creation-resilience` | 2026-04-08 | alari | ⚠️ No (ahead=1, behind=11) | Superseded — fix landed via #304/#305 |
| `origin/fix/worktree-restart-resilience` | 2026-04-08 | alari | ⚠️ No (ahead=3, behind=10) | Superseded — fix landed via #305 |
| `origin/refactor/extract-session-lifecycle` | 2026-04-08 | alari | ⚠️ No (ahead=1, behind=6) | Superseded — refactor landed via #308 |
| `origin/test/cover-session-restart-fixes` | 2026-04-08 | alari | ⚠️ No (ahead=1, behind=8) | Superseded — tests landed via #306 |
| `origin/docs/cleanup-2026-04-08` | 2026-04-08 | alari | ⚠️ No (ahead=5, behind=19) | Open PR #310 covers some of these; review for merge |
| `origin/chore/add-reports-2026-04-09` | 2026-04-09 | alari | ⚠️ No (ahead=1, behind=5) | Pending — covered by open PR #310 |

**Note:** GitHub squash merges do not register as merged in `git branch --merged`. The branches marked "No" above were cross-checked against commit messages on `main` to assess supersession.

---

## PR Hygiene

| PR # | Title | Author | Days Open | Review Decision | Conflicts | Stuck? |
|---|---|---|---|---|---|---|
| #310 | chore: add complexity and repo-health reports for April 2026 | alari76 | 1 day | No review | Mergeable | No (recent) |

**1 open PR total.** Not stuck — opened 2026-04-09, no review yet but within normal window.

---

## Merge Conflict Forecast

Branches with commits in the last 14 days that have diverged from `main`:

| Branch | Ahead (commits) | Behind (commits) | Files Modified on Branch | Overlap Risk | Risk Level |
|---|---|---|---|---|---|
| `fix/strip-agent-noise-messages` | 1 | 1 | `src/components/ChatView.tsx` | `ChatView.tsx` had no changes on `main` since divergence | Low |
| `docs/cleanup-2026-04-08` | 5 | 19 | `docs/API-REFERENCE.md`, `docs/SETUP.md`, `docs/stream-json-protocol.md`, `CONTRIBUTING.md`, `.codekin/reports/*` | `docs/API-REFERENCE.md` was touched by `d8acba0` on `main` post-divergence | **Medium** |
| `fix/session-restart-race-conditions` | 1 | 17 | (session restart logic) | Same area heavily refactored on `main` via #301, #303, #308 | **High** (superseded) |
| `refactor/extract-session-lifecycle` | 1 | 6 | `server/session-lifecycle.ts`, `server/session-manager.ts` | `session-lifecycle.ts` was created on `main` via #308 — direct conflict | **High** (superseded) |
| `fix/worktree-restart-resilience` | 3 | 10 | (worktree restart logic) | Related fixes landed via #304, #305 on `main` | **High** (superseded) |
| `fix/strip-git-env-vars-from-claude-spawn` | 1 | 7 | (claude spawn env) | Fix landed via #307 on `main` | **High** (superseded) |
| `test/cover-session-restart-fixes` | 1 | 8 | (test files) | New tests for same area landed via #306 | Medium (tests may conflict) |
| `chore/add-reports-2026-04-09` | 1 | 5 | (report files only) | Report files are append-only, no overlap | Low |

**Recommended action:** The branches flagged High are all superseded by squash-merged equivalents on `main`. They should be deleted rather than rebased and merged, to avoid re-introducing changes that were already cleaned up.

---

## Recommendations

1. **Delete confirmed-merged and superseded remote branches** (4 confirmed + 7 superseded). These create noise in `git branch -r` and slow down conflict analysis. Use `gh` or direct `git push origin --delete <branch>` for each. Priority: high, effort: low.

2. **Clean up orphaned `server/dist/` artifacts** from deleted shepherd/review modules. Run `tsc --build --clean` then rebuild, or manually delete the 10 orphaned file groups. These don't affect runtime but inflate the distribution. Priority: medium, effort: low.

3. **Review and merge PR #310** (chore: add complexity and repo-health reports). It has been open 1 day, is mergeable, and touches only report files — straightforward merge. Priority: medium, effort: low.

4. **Promote ESLint `no-unsafe-*` warnings back to errors** (or document the explicit decision to keep them as warnings). The current asymmetry — `no-unsafe-call` is an error but `no-unsafe-assignment`/`no-unsafe-return`/`no-unsafe-argument` are warnings — is inconsistent. At minimum, add a CI step with `--max-warnings 0` to prevent warning accumulation. Priority: medium, effort: low.

5. **Widen `server/tsconfig.json` include glob** from `["*.ts"]` to `["**/*.ts"]` to ensure any future subdirectory modules under `server/` are automatically included in compilation. Currently safe but a latent footgun. Priority: low, effort: trivial.

6. **Update CHANGELOG.md** ahead of the next version bump. 22 commits have landed since v0.5.4; drafting the changelog now (see Draft Changelog section above) will reduce friction at release time. Priority: low, effort: low.

7. **Verify `busboy` and `streamsearch` license metadata in `package-lock.json`** is populated. Both packages have MIT licenses (confirmed via their `package.json`), but the lock file records `UNKNOWN`. This may cause automated license scanners to flag them. Re-running `npm install` after a `npm dedupe` often refreshes this metadata. Priority: low, effort: trivial.

8. **Resolve `docs/cleanup-2026-04-08` branch** before `docs/API-REFERENCE.md` diverges further. This branch is 5 commits ahead and 19 behind `main`, and the docs it modifies were also touched by `d8acba0` on `main`. Either rebase and merge, or close the branch and cherry-pick the relevant changes. Priority: medium, effort: low.
