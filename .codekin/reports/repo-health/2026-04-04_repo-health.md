# Codekin Repository Health Assessment — 2026-04-04

---

## Summary

**Overall Health: Good**

The codebase is well-structured with strict TypeScript enforcement, zero TODO debt, and clean licensing. The main areas requiring attention are: stale open PRs with potential merge conflicts, an entirely undocumented Orchestrator API surface, a missing CHANGELOG entry for v0.5.3, and ~60 merged remote branches awaiting cleanup.

| Metric | Value |
|---|---|
| Dead code items | 2 (low severity) |
| Stale TODOs | 0 |
| Config issues | 1 (10 ESLint rules demoted to warn) |
| License concerns | 2 unknown licenses to verify |
| Doc drift items | 30+ undocumented Orchestrator endpoints + 4 undocumented settings endpoints |
| Stale merged branches | ~60 |
| Open PRs | 4 (0 reviewed, 2 likely superseded) |
| Merge conflict risk | High for 2 active branches vs. recently merged approvals overhaul |

---

## Dead Code

| File | Export / Function | Type | Recommendation |
|---|---|---|---|
| `src/types.ts:41` | `RepoManifest` | Unused export | Audit all consumers; if truly unused, remove |
| `server/webhook-github.ts:27,32` | `_setGhRunner`, `_resetGhRunner` | Test-seam export in production file | Convert to a proper dependency-injection pattern or move to a test helper module |

**Notes:**
- All `src/components/*.tsx` files have at least one importer — no orphan components found.
- All `src/hooks/*.ts` exports are consumed by components.
- `server/diff-manager.ts` exports `cleanGitEnv` — verify it is imported outside its own file; if not, restrict to non-exported.
- `server/stepflow-prompt.ts`, `server/webhook-prompt.ts`, `server/session-restart-scheduler.ts` are low-connectivity server files; confirmed not orphaned but worth a pass if their callers are ever removed.

---

## TODO/FIXME Tracker

**Zero TODO/FIXME/HACK/XXX/WORKAROUND annotations found** in `/srv/repos/codekin/src` or `/srv/repos/codekin/server`.

The only matches for `TODO` in the repository are test fixture strings in `server/claude-process.test.ts` (lines 61, 62, 810) — these are grep pattern strings inside test assertions, not annotations.

| File:Line | Type | Comment | Author | Date | Stale? |
|---|---|---|---|---|---|
| `server/claude-process.test.ts:61` | Test fixture | `'TODO'` as grep pattern in test assertion | Multiplier Labs | 2026-03-08 | N/A — not an annotation |

**Summary:**
- Total annotations: **0**
- Stale annotations (>30 days): **0**
- Count by type: TODO: 0, FIXME: 0, HACK: 0, XXX: 0, WORKAROUND: 0

The codebase is entirely free of outstanding technical debt markers.

---

## Config Drift

| Config File | Setting | Current Value | Recommended Value | Severity |
|---|---|---|---|---|
| `eslint.config.js` | `@typescript-eslint/restrict-template-expressions` | `warn` | `error` | Low — acknowledged debt, comment notes promotion pending cleanup |
| `eslint.config.js` | `@typescript-eslint/no-confusing-void-expression` | `warn` | `error` | Low |
| `eslint.config.js` | `@typescript-eslint/no-unnecessary-condition` | `warn` | `error` | Low |
| `eslint.config.js` | `@typescript-eslint/no-base-to-string` | `warn` | `error` | Low |
| `eslint.config.js` | `@typescript-eslint/no-non-null-assertion` | `warn` | `error` | Low |
| `eslint.config.js` | `@typescript-eslint/no-unsafe-assignment` | `warn` | `error` | Medium — unsafe rules at warn can mask type holes |
| `eslint.config.js` | `@typescript-eslint/no-unsafe-member-access` | `warn` | `error` | Medium |
| `eslint.config.js` | `@typescript-eslint/no-unsafe-argument` | `warn` | `error` | Medium |
| `eslint.config.js` | `@typescript-eslint/no-unsafe-return` | `warn` | `error` | Medium |
| `eslint.config.js` | `@typescript-eslint/no-misused-promises` | `warn` | `error` | Medium |
| `eslint.config.js` | `@typescript-eslint/require-await` | `warn` | `error` | Low |
| `eslint.config.js` | `@typescript-eslint/use-unknown-in-catch-callback-variable` | `warn` | `error` | Low |
| `tsconfig.app.json` vs `tsconfig.node.json` | `target` | `ES2022` vs `ES2023` | Intentional (browser vs Node) — no action needed | Info |

**Positive findings:**
- `strict: true` is set in all three tsconfig files (app, node, server).
- `noUnusedLocals: true` and `noUnusedParameters: true` are enforced across all tsconfig files.
- Server correctly uses `NodeNext` module resolution; frontend uses `bundler` (Vite). No cross-contamination.
- `.prettierrc` is consistent with observed code style.
- ESLint uses `tseslint.configs.strictTypeChecked` for production code and `recommended` for tests — appropriate tiering.

---

## License Compliance

**Project license:** MIT

### License Distribution (direct + transitive dependencies)

| License | Count |
|---|---|
| MIT | 312 |
| ISC | 18 |
| MPL-2.0 | 12 |
| BSD-3-Clause | 9 |
| Apache-2.0 | 8 |
| BSD-2-Clause | 8 |
| MPL-2.0 OR Apache-2.0 | 1 |
| CC-BY-4.0 | 1 |
| CC0-1.0 | 1 |
| BlueOak-1.0.0 | 1 |
| BSD-2-Clause OR MIT OR Apache-2.0 | 1 |
| MIT OR WTFPL | 1 |
| 0BSD | 1 |
| **unknown** | **2** |

### GPL/LGPL/AGPL Flagged Dependencies

**None detected.** Zero copyleft-incompatible licenses found.

### Other Flags

| Dependency | License | Note |
|---|---|---|
| `dompurify` | MPL-2.0 OR Apache-2.0 | Permissively compatible for library use. Documented in `package.json#licenseNotes`. |
| `lightningcss` (via TailwindCSS) | MPL-2.0 | Build-time only — not distributed in the output bundle. Low risk. |
| 2 unknown-license packages | unknown | Manually inspect `package-lock.json` for entries with no `license` field; check upstream repositories. |

---

## Documentation Freshness

### API Endpoints Missing from `docs/API-REFERENCE.md`

All `/api/orchestrator/*` endpoints are entirely absent from documentation. This represents the largest doc gap in the project.

| Missing Endpoint | Source File |
|---|---|
| All `GET/POST/PUT/DELETE /api/orchestrator/*` (~30+ routes) | `server/orchestrator-routes.ts` |
| `GET /api/settings/worktree-prefix` | `server/session-routes.ts:154` |
| `PUT /api/settings/worktree-prefix` | `server/session-routes.ts:160` |
| `GET /api/settings/queue-messages` | `server/session-routes.ts:176` |
| `PUT /api/settings/queue-messages` | `server/session-routes.ts:183` |
| `GET /api/settings/agent-name` | `server/session-routes.ts:224` |
| `PUT /api/settings/agent-name` | `server/session-routes.ts:230` |
| `GET /api/browse-dirs` | `server/session-routes.ts:244` |
| Workflow sub-routes: `/api/workflows/runs`, `/api/workflows/schedules/*`, `/api/workflows/config/repos/*` | `server/workflow-routes.ts` |

### README Drift

| Finding | Severity |
|---|---|
| `CHANGELOG.md` has no entry for `v0.5.3` (approvals overhaul, PR #280, merged 2026-04-03) | Medium |
| README does not mention the Orchestrator/Agent Joe REST API surface | Low |
| `codekin config` CLI command referenced in README — verify `bin/codekin.mjs` still implements this subcommand | Low |
| "Session archive — Full retrieval and re-activation" in README — re-activation path should be verified end-to-end | Info |

### Positive Findings

- All `package.json` scripts documented in CLAUDE.md (`dev`, `build`, `lint`, `test`, `test:watch`) match actual scripts — no drift.
- `docs/INSTALL-DISTRIBUTION.md` exists and is valid.
- `src/types.ts` has good JSDoc coverage on all major interfaces and WS message unions.
- `CONTRIBUTING.md` and `LICENSE` both exist at repo root.

---

## Draft Changelog

### [Unreleased] — since v0.5.3 (2026-04-04)

*(No new commits on main beyond v0.5.3 as of this report.)*

---

### [0.5.3] — 2026-04-03

#### Fixes
- **Overhaul approvals architecture for parity with native CLI** (#280) — reworked approval-manager, session-manager, and session-routes to align approval flow with upstream Claude CLI behavior.

---

### [0.5.2] — 2026-04-02

#### Features
- **Add `--dangerously-skip-permissions` as a permission mode setting** (#276, #277) — new permission mode that bypasses all tool-permission prompts; passes `CODEKIN_SKIP_PERMISSIONS` env to hooks.
- **Add actor allowlist filter for webhook events** (#261) — webhook events can now be filtered to a list of allowed GitHub actor logins.

#### Fixes
- **Upgrade lodash to 4.18.1 to resolve high-severity audit vulnerabilities** (#275, commit `92ca595`)
- **Address security and code review findings** (#275, commit `c47ca94`) — auth routes, upload routes, webhook config hardening.
- **Resolve Agent Joe passivity** (#273) — orchestrator agent now responds correctly to idle states.
- **Improve long session stability and resource management** (#272) — session-manager and session-persistence improvements.
- **Resolve 3 ESLint errors breaking CI** (#270) — fixed linting regressions from dependency upgrades.
- **Fix archived sessions not showing worktree-based manual sessions** (#264)
- **Add context size management to GPT and Gemini review tools** (#262)

#### Chores
- **Upgrade TypeScript 6, Vite 8, ESLint 10, jsdom 29** (#269) — major dependency health pass.
- **Improve dependency health** (#268) — per 2026-03-31 audit.

#### Refactoring
- **Reduce code complexity across 6 high-priority areas** (#267)

#### Tests
- **Improve code coverage across server and frontend modules** (#265)

#### Documentation
- **Fix documentation issues from weekly audit** (#266)
- **Improve code comments per comment assessment audit** (#260)

---

## Stale Branches

Branches older than 30 days (before 2026-03-05):

| Branch | Last Commit | Author | Merged into main? | Recommendation |
|---|---|---|---|---|
| `origin/chore/repo-health-report-2026-03-14` | 2026-03-14 | alari | Yes | Delete |

**Note on merged-but-not-deleted branches:** There are approximately 60 remote branches from the period 2026-03-14 through 2026-04-01 that have been merged into main but not deleted. While these are not "stale" in the traditional sense (they are recent), they create noise in the remote branch list. A bulk prune is recommended.

| Category | Example Branch | Count (approx.) | Recommendation |
|---|---|---|---|
| Merged `fix/*` | `origin/fix/long-session-stability` | ~15 | Delete after confirming merge |
| Merged `feat/*` | `origin/feat/webhook-actor-allowlist` | ~5 | Delete after confirming merge |
| Merged `chore/*` | `origin/chore/repo-health-report-*` | ~10 | Delete |
| Merged `refactor/*` | `origin/refactor/complexity-improvements` | ~4 | Delete |
| Merged `docs/*` | `origin/docs/improve-code-comments` | ~4 | Delete |
| Merged `test/*` | `origin/test/improve-coverage` | ~3 | Delete |
| Merged `wt/*` worktree snapshots | `origin/wt/8ea42b7c` | ~3 | Delete |
| Merged `codekin/*` | `origin/codekin/reports` | ~2 | Delete |

**Recommended cleanup command** (after verifying each is merged):
```bash
git fetch --prune  # removes local tracking refs for deleted remotes
# Then for each confirmed-merged branch:
git push origin --delete <branch-name>
```

---

## PR Hygiene

| PR# | Title | Author | Days Open | Review Status | Mergeable | Stuck? |
|---|---|---|---|---|---|---|
| #274 | fix: override lodash to resolve high-severity audit vulnerability | alari | 1 | No reviews | Unknown | No — but likely **superseded** (lodash already merged via `92ca595`) |
| #271 | fix: resolve critical and long-standing security audit findings | alari | 1 | No reviews | Unknown | No — but **high conflict risk** (see below) |
| #263 | chore: add repo health and code review reports for 2026-03-28 through 2026-03-30 | alari | 5 | No reviews | Unknown | **Yes** — 5 days, no activity, 21 commits behind main |
| #259 | chore: add repo health reports for 2026-03-25 and 2026-03-26 | alari | 9 | No reviews | Unknown | **Yes** — 9 days, no activity, 27 commits behind main |

**Key concerns:**
- **PR #274** is almost certainly superseded: the lodash upgrade (`92ca595`) was already merged into main as part of `fix/security-symlink-and-warnings`. This PR should be closed as duplicate.
- **PR #271** (`fix/security-audit-findings`) modifies `session-routes.ts`, `auth-routes.ts`, `ws-server.ts`, and `webhook-handler.ts` — all of which were significantly changed by the approvals overhaul (#280, already merged). This PR requires a rebase before it can merge cleanly.
- **PR #263 and #259** are reports-only chores. They are low-risk but have accumulated significant lag behind main. They should either be rebased + merged or closed if superseded by newer reports.

---

## Merge Conflict Forecast

| Branch | Commits Ahead of Main | Commits Behind Main | Overlapping Files with Main (since divergence) | Risk Level |
|---|---|---|---|---|
| `origin/fix/security-audit-findings` | 5 | 10 | `session-routes.ts`, `auth-routes.ts`, `ws-server.ts`, `webhook-handler.ts`, `webhook-config.ts`, `upload-routes.ts` | **High** — all 6 files were modified by the approvals overhaul already on main |
| `origin/fix/long-session-stability` | 2 | 10 | `session-manager.ts`, `session-persistence.ts`, `types.ts`, `package-lock.json` | **High** — `session-manager.ts` and `types.ts` both modified by approvals overhaul on main |
| `origin/fix/lodash-audit-vulnerability` | 1 | 9 | `package.json`, `package-lock.json` | **Medium** — lodash already merged; branch is superseded |
| `origin/chore/reports-2026-04-01` | 3 | 0 | `.codekin/reports/**` (markdown only) | **Low** — no code overlap |
| `origin/fix/approvals-overhaul` | 7 | 0 | (already merged as #280) | **Closed** |

**Overlap detail for high-risk branches:**

`fix/security-audit-findings` touches the same files as main's commit `da1e26b` (approvals overhaul):
- `session-routes.ts` — modified in both
- `auth-routes.ts` — modified in both
- `ws-server.ts` — modified in both

`fix/long-session-stability` touches same files as `da1e26b`:
- `session-manager.ts` — heavily modified by approvals overhaul
- `types.ts` — interface changes in both

**Recommendation:** Both high-risk branches need an interactive rebase onto current `main` before they can be merged. The security findings branch in particular will require careful manual conflict resolution across at minimum 6 files.

---

## Recommendations

1. **[High] Rebase and merge or close PR #271 (`fix/security-audit-findings`)** — this branch is 10 commits behind main and touches 6 files that were restructured by the approvals overhaul. It contains security hardening changes that should not be abandoned; rebase it onto main, resolve conflicts, and merge. Do this before the branch falls further behind.

2. **[High] Close PR #274 (`fix/lodash-audit-vulnerability`)** — the lodash upgrade is already on main (`92ca595`). This PR is a duplicate; closing it removes noise and prevents an accidental double-merge of conflicting lock files.

3. **[High] Rebase and merge `fix/long-session-stability`** — `session-manager.ts` changes from this branch are still relevant and not yet on main. Rebase onto current main, resolve `session-manager.ts` conflicts with the approvals overhaul, and open a PR.

4. **[Medium] Add a `v0.5.3` entry to `CHANGELOG.md`** — the approvals architecture overhaul (PR #280) is a significant change with no changelog entry. Update `CHANGELOG.md` before the next release.

5. **[Medium] Document the Orchestrator REST API in `docs/API-REFERENCE.md`** — 30+ endpoints in `server/orchestrator-routes.ts` have zero documentation. This is the largest undocumented API surface in the project and will impede onboarding and integration.

6. **[Medium] Bulk-delete merged remote branches** — approximately 60 merged branches remain on the remote. Run `git fetch --prune` and then batch-delete confirmed-merged branches. This reduces cognitive overhead and speeds up branch-listing operations in tools.

7. **[Medium] Merge or close PR #263 and #259** — these report-chore PRs are 21–27 commits behind main. Rebase them (reports-only, low conflict risk) and merge, or close them if the reports have been superseded by newer ones committed directly to main.

8. **[Low] Promote the 10 demoted ESLint rules from `warn` to `error`** — the ESLint config acknowledges these should be promoted once the codebase is cleaned up. Doing so incrementally (one rule at a time, fixing violations) will strengthen the type-safety guarantees of `strictTypeChecked`.

9. **[Low] Remove or internalize `RepoManifest` from `src/types.ts`** — this interface is exported but never imported. Either it is dead code (remove it) or it is intentionally kept for external consumers (add a comment explaining why).

10. **[Low] Audit the 2 `unknown`-license dependencies in `package-lock.json`** — check their upstream repositories for license files. If they are permissively licensed, add a note to `package.json#licenseNotes`; if not, evaluate replacement.
