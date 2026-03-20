# Repository Health Report — codekin

**Date**: 2026-03-20  
**Branch assessed**: main (`4386c63`)  
**Assessed by**: Claude Sonnet 4.6 (automated)

---

## Summary

**Overall health: Good**

The repository is in active, high-velocity development with 50+ commits merged in the past 7 days. Code quality infrastructure is strong (strict TypeScript, strictTypeChecked ESLint, comprehensive test coverage). No meaningful dead code or TODO debt exists in project source. The primary concerns are: (1) three API surface additions in the last 48 hours that are not yet reflected in `docs/API-REFERENCE.md`, (2) two report-tracking branches that have diverged significantly from `main` and are accumulating merge debt, and (3) `feat/joe-chat-variant` touches `ChatView.tsx` which has received 10+ main-branch commits since divergence, creating a high conflict risk.

| Metric | Count |
|---|---|
| Dead code items | 0 |
| TODO/FIXME in source | 0 |
| Config issues | 2 (minor) |
| License concerns | 3 (low severity) |
| Doc drift items | 3 |
| Stale branches (>30 days) | 0 |
| Merged remote branches pending deletion | 11 |
| Open PRs | 0 |
| High-conflict-risk branches | 1 |

---

## Dead Code

No unused exports, unreachable functions, or orphan files were detected. All components and server modules are imported and used:

- All `src/components/*.tsx` files are imported by at least one parent component or `App.tsx`.
- All `server/*.ts` files (including `version-check.ts`, `error-page.ts`, `session-restart-scheduler.ts`, `commit-event-hooks.ts`) are imported by `ws-server.ts` or `session-manager.ts`.
- The `shepherd-*` module family (learning, memory, monitor, reports) is properly wired through `shepherd-manager.ts` and `shepherd-routes.ts`.

**Result: No items to report.**

---

## TODO/FIXME Tracker

Scanned all `.ts`, `.tsx`, `.js`, `.mjs` files under `src/`, `server/` (excluding `node_modules` and `dist`).

**Zero TODO/FIXME/HACK/XXX/WORKAROUND comments found in project source code.**

The only hits were:
- Three string literals in `server/claude-process.test.ts` (lines 60–61, 818) where `'TODO'` is used as a literal Grep pattern in test assertions — not actual technical debt markers.

| Type | Count | Stale (>30 days) |
|---|---|---|
| TODO | 0 | 0 |
| FIXME | 0 | 0 |
| HACK | 0 | 0 |
| XXX | 0 | 0 |
| WORKAROUND | 0 | 0 |
| **Total** | **0** | **0** |

---

## Config Drift

### TypeScript (`tsconfig.app.json`, `tsconfig.node.json`, `server/tsconfig.json`)

| File | Setting | Current Value | Assessment |
|---|---|---|---|
| All configs | `strict` | `true` | ✅ Correct |
| `tsconfig.app.json` | `noUnusedLocals` / `noUnusedParameters` | `true` | ✅ Correct |
| `tsconfig.node.json` | `noUnusedLocals` / `noUnusedParameters` | `true` | ✅ Correct |
| `server/tsconfig.json` | `noUnusedLocals` / `noUnusedParameters` | `true` | ✅ Correct |
| `tsconfig.app.json` | `target` | `ES2022` | ✅ Appropriate for modern browsers |
| `tsconfig.node.json` | `target` | `ES2023` | ✅ Appropriate for Node.js |
| `server/tsconfig.json` | `noImplicitReturns` | _(absent)_ | ⚠️ Consider adding — prevents missing return paths |
| `server/tsconfig.json` | `exactOptionalPropertyTypes` | _(absent)_ | ℹ️ Optional but would tighten optional property semantics |

**Finding 1**: `server/tsconfig.json` lacks `noImplicitReturns`. The app and node configs also omit it. This is a minor gap — the strict type checker catches most cases, but explicit return-path enforcement is a useful additional guard in server code.

### ESLint (`eslint.config.js`)

| Setting | Current Value | Assessment |
|---|---|---|
| Frontend extends | `strictTypeChecked` | ✅ Correct |
| Server extends | `strictTypeChecked` | ✅ Correct |
| Test files extends | `recommended` (not `strictTypeChecked`) | ✅ Intentional |
| `@typescript-eslint/no-unsafe-assignment` | `warn` | ⚠️ Should eventually be `error` |
| `@typescript-eslint/no-unsafe-argument` | `warn` | ⚠️ Should eventually be `error` |
| `@typescript-eslint/no-unsafe-member-access` | `warn` | ⚠️ Should eventually be `error` |
| `@typescript-eslint/no-unsafe-return` | `warn` | ⚠️ Should eventually be `error` |
| `@typescript-eslint/no-non-null-assertion` | `warn` | ⚠️ Should eventually be `error` |

**Finding 2**: Eight `@typescript-eslint/no-unsafe-*` rules are demoted to `warn` with an inline comment acknowledging this is temporary for "incremental adoption." This is an intentional and documented trade-off — not an oversight. However, it represents ongoing technical debt: these warnings will be silently ignored in CI unless explicitly checked. Recommend tracking progress on promoting them to `error`.

### Prettier

No Prettier configuration file found. The project does not use Prettier. Not an issue given TailwindCSS's own formatting via `prettier-plugin-tailwindcss` is not required, and ESLint handles style.

---

## License Compliance

Project license: **MIT**

### License Distribution (all dependencies including transitive)

| License | Package Count | Concern? |
|---|---|---|
| MIT | 525 | ✅ None |
| ISC | 23 | ✅ None |
| Apache-2.0 | 19 | ✅ None |
| MPL-2.0 | 12 | ⚠️ See note |
| BSD-3-Clause | 10 | ✅ None |
| BSD-2-Clause | 8 | ✅ None |
| BlueOak-1.0.0 | 4 | ✅ Permissive |
| MIT-0 | 2 | ✅ None |
| CC0-1.0 | 1 | ✅ Public domain |
| 0BSD | 1 | ✅ None |
| Python-2.0 | 1 | ⚠️ See note |
| CC-BY-4.0 | 1 | ℹ️ Docs only |
| unknown | 2 | ⚠️ See note |

**No GPL, AGPL, LGPL, EUPL, or CDDL licenses detected.**

### Flagged Dependencies

| Package | License | Issue | Severity |
|---|---|---|---|
| `argparse@2.0.1` | Python-2.0 (PSF) | PSF is permissive and MIT-compatible, but the SPDX identifier is unusual. The actual Python Software Foundation License 2.0 is not copyleft. | Low |
| `busboy@1.6.0` | unknown | Used by `multer`. The `busboy` package is MIT-licensed in practice (README and source header confirm), but its `package.json` omits the `license` field. | Low |
| `streamsearch@1.1.0` | unknown | A `busboy` sub-dependency. MIT-licensed in practice but not declared in `package.json`. | Low |
| `dompurify` | MPL-2.0 OR Apache-2.0 | Dual-licensed; Apache-2.0 variant is permissive-compatible. Noted in root `package.json` `licenseNotes`. | Low |
| `lightningcss` (via TailwindCSS) | MPL-2.0 | Build-time only, not distributed. Noted in root `package.json` `licenseNotes`. | Low |

**Overall license risk: Low.** The `package.json` `licenseNotes` field proactively documents the MPL-2.0 exceptions. No action required beyond optionally filing an issue with `busboy` and `streamsearch` to add their `license` field.

---

## Documentation Freshness

### API Docs (`docs/API-REFERENCE.md`)

Last updated: **2026-03-16**

Three significant server API additions landed on **2026-03-19** that are not reflected in the API reference:

| Missing Endpoint | Commit | Description |
|---|---|---|
| `GET /api/shepherd/sessions` | `295cf01` | List all sessions including automated ones (source field exposed) |
| `DELETE /api/shepherd/sessions/cleanup` | `295cf01` | Bulk-delete all automated sessions (workflow, webhook, stepflow, agent sources) |
| `DELETE /api/shepherd/sessions/:id` | `295cf01` | Delete a specific session by ID |

Additionally, the `allowedTools` parameter accepted by the `create-session` WebSocket message (`19d73cd`, 2026-03-19) is not documented anywhere in the API reference or `docs/stream-json-protocol.md`.

### README Drift (`README.md`)

README is accurate. Verified against `package.json`:

| README claim | Actual | Status |
|---|---|---|
| `npm run dev` | ✅ Exists | Correct |
| `npm run build` | ✅ Exists | Correct |
| `npm test` | ✅ (`test` script) | Correct |
| `npm run lint` | ✅ Exists | Correct |
| Port `32352` | ✅ Default in config | Correct |
| `REPOS_ROOT` env var | ✅ In server config | Correct |
| `~/.config/codekin/env` config path | Needs field verification | Not testable in this environment |

README does not mention `npm run test:watch` (listed in CLAUDE.md but not README — acceptable). No broken commands or paths found.

### CLAUDE.md

CLAUDE.md scripts section matches `package.json` exactly. Up to date.

### `docs/ORCHESTRATOR-SPEC.md`

Updated 2026-03-18 to rename Shepherd → Agent Joe (`a2e1727`). Accurate as of that date. The spec does not document the new `allowedTools` per-session pre-approval behavior added 2026-03-19, but this is an implementation detail rather than a spec-level feature.

---

## Draft Changelog

Changes from `v0.4.1` (2026-03-13) through `HEAD` (2026-03-19), grouped by category.

---

### v0.4.2 — Draft (2026-03-19)

#### Features

- **Agent Joe orchestrator** — Renamed Shepherd to Agent Joe; refactored as an orchestrator that spawns visible child sessions in the sidebar (#182, #184, #185, #187)
- **Agent Joe welcome screen** — Empty chat sessions now display a Joe-specific welcome UI (#185)
- **Per-session allowed tools** — Sessions can now pre-approve specific CLI tools via `allowedTools`; `curl` pre-approved for Agent Joe and child agent sessions (#205)
- **Shepherd session cleanup API** — New endpoints to list and bulk-delete automated sessions (`GET/DELETE /api/shepherd/sessions`) (#207)
- **Worktree support enhancements** — Mid-session worktree creation; session data copied to worktree project dir; session ID preserved across worktree migration (#183, #193, #194, #195, #196)
- **Settings UI improvements** (#180)

#### Fixes

- Auto-approve `session allowedTools` in the permission hook path (#208)
- Increase shepherd `MAX_CONCURRENT` from 3 to 5 (#206)
- Fix Agent Joe child sessions not appearing in sidebar (#204)
- Navigate away from Joe view when selecting an ordinary session (#191)
- Inject conversation context when Claude restarts after crash (#192)
- Format API error messages instead of showing raw JSON (#194)
- Use `--resume` instead of `--session-id` when restarting Claude sessions (#197)
- Harden SQLite file permissions and shell JSON escaping (#198)
- Guard `chmodSync` calls for in-memory and non-existent DB paths (#198)
- Fix SIGKILL timer leak, stale closure, silent approval escalation, unbounded file reads (#200)
- Improve sidebar menu highlight contrast and consistency (#190)
- Add clone path boundary check, worktree migration warning, and cleanup (#188)
- Set `CLAUDE_PROJECT_DIR` to original repo for worktree sessions (#181)

#### Refactoring

- Extract `DiffManager` class from inline functions in `session-manager.ts` (#203)
- Break up `App.tsx` into focused sub-components: `ShepherdContent`, `DocsBrowserContent`, `SessionContent` (#203)

#### Tests

- Add comprehensive diff-parser tests, raising coverage from ~1% to 98% (#202)

#### Chores

- Update `dompurify` 3.3.2 → 3.3.3 (security patch) (#199)
- Remove stale AI SDK references from docs (#201)
- Rename Shepherd → Agent Joe in orchestrator spec (#188)

---

## Stale Branches

No remote branches have gone without commits for more than 30 days (all activity is within the last 6 days as of 2026-03-20).

However, the following remote branches warrant attention:

### Merged branches pending remote deletion

These branches are fully merged into `main` and their remote refs can be deleted:

| Branch | Last Commit | Author | Merged? | Recommendation |
|---|---|---|---|---|
| `origin/chore/dependency-updates-2026-03-18` | 2026-03-19 | alari | ✅ Yes | Delete remote ref |
| `origin/chore/docs-cleanup-2026-03-18` | 2026-03-18 | alari | ✅ Yes | Delete remote ref |
| `origin/feat/per-session-allowed-tools` | 2026-03-19 | alari | ✅ Yes | Delete remote ref |
| `origin/feat/shepherd-session-cleanup-api` | 2026-03-19 | alari | ✅ Yes | Delete remote ref |
| `origin/fix/agent-joe-session-sidebar` | 2026-03-19 | alari | ✅ Yes | Delete remote ref |
| `origin/fix/bug-fixes-2026-03-18` | 2026-03-19 | alari | ✅ Yes | Delete remote ref |
| `origin/fix/increase-shepherd-concurrency` | 2026-03-19 | alari | ✅ Yes | Delete remote ref |
| `origin/fix/security-hardening-2026-03-18` | 2026-03-18 | Claude (Webhook) | ✅ Yes | Delete remote ref |
| `origin/fix/session-allowedtools-hook-bypass` | 2026-03-19 | alari | ✅ Yes | Delete remote ref |
| `origin/refactor/reduce-complexity-2026-03-18` | 2026-03-18 | alari | ✅ Yes | Delete remote ref |
| `origin/test/diff-parser-coverage-2026-03-18` | 2026-03-18 | alari | ✅ Yes | Delete remote ref |

### Unmerged branches

| Branch | Last Commit | Author | Ahead/Behind main | Merged? | Notes |
|---|---|---|---|---|---|
| `origin/feat/joe-chat-variant` | 2026-03-17 | alari | +1 / −63 | ❌ No | Superseded — Joe features landed via separate PRs (#184–#189); likely a zombie |
| `origin/codekin/reports` | 2026-03-16 | alari | +20 / −210 | ❌ No | Dedicated reports tracking branch; 210 commits behind main |
| `origin/chore/repo-health-report-2026-03-14` | 2026-03-14 | alari / Claude | +2 / −210 | ❌ No | Stale report branch; report content is superseded by newer reports on main |
| `origin/chore/repo-health-report-2026-03-18` | 2026-03-18 | alari | +2 / −56 | ❌ No | Report branch from 2026-03-18; not merged |

---

## PR Hygiene

`gh pr list` returned an empty result — **no open pull requests** at time of assessment.

All recent work has been merged cleanly through the PR workflow. No stuck or stale PRs to report.

---

## Merge Conflict Forecast

Active branches with commits in the last 14 days that have diverged from `main`:

| Branch | Commits Ahead | Commits Behind | Files Modified on Branch | Also Modified on main since divergence | Risk Level |
|---|---|---|---|---|---|
| `origin/feat/joe-chat-variant` | 1 | 63 | `src/components/ChatView.tsx` | `ChatView.tsx` (10+ commits on main since divergence) | 🔴 HIGH |
| `origin/codekin/reports` | 20 | 210 | `.codekin/reports/**` only | None (reports dir is not touched on main) | 🟢 LOW |
| `origin/chore/repo-health-report-2026-03-14` | 2 | 210 | `.codekin/reports/**` only | None | 🟢 LOW |
| `origin/chore/repo-health-report-2026-03-18` | 2 | 56 | `.codekin/reports/**` only | None | 🟢 LOW |

**High-risk detail — `feat/joe-chat-variant`**: This branch adds 36 lines to `ChatView.tsx`. Since its divergence point, `ChatView.tsx` on `main` has received at least 10 commits (Joe variant styling, welcome screen, input bar simplification, error message formatting, etc.). The branch's single commit (`feat: add Joe welcome screen`) appears to be superseded by commits already on `main` via other PRs. **Recommend closing this branch as superseded** rather than attempting to rebase.

---

## Recommendations

1. **Update `docs/API-REFERENCE.md` for v0.4.2 changes** (High impact): Document the three new shepherd session cleanup endpoints (`GET /api/shepherd/sessions`, `DELETE /api/shepherd/sessions/cleanup`, `DELETE /api/shepherd/sessions/:id`) and the `allowedTools` field in the session creation WebSocket message. These are already live on `main` and callable by API consumers.

2. **Close or delete `origin/feat/joe-chat-variant`** (High impact): This branch is 63 commits behind `main`, touches only `ChatView.tsx`, and its Joe welcome screen feature already landed via PR #185. The branch is almost certainly superseded. Keeping it creates unnecessary noise and conflict risk. Recommend `gh pr close` (if there's an open PR) or simply deleting the remote ref.

3. **Bulk-delete merged remote branches** (Medium impact): 11 remote branches that are fully merged into `main` still exist on the remote. Run: `git push origin --delete chore/dependency-updates-2026-03-18 chore/docs-cleanup-2026-03-18 feat/per-session-allowed-tools feat/shepherd-session-cleanup-api fix/agent-joe-session-sidebar fix/bug-fixes-2026-03-18 fix/increase-shepherd-concurrency fix/security-hardening-2026-03-18 fix/session-allowedtools-hook-bypass refactor/reduce-complexity-2026-03-18 test/diff-parser-coverage-2026-03-18` to clean these up.

4. **Resolve the `codekin/reports` branch strategy** (Medium impact): This branch is 210 commits behind `main` and carries 20 report-only commits. Either (a) merge all pending report commits to `main` and retire the branch, or (b) continue using it as a dedicated reports branch but rebase periodically. Letting it drift further increases the risk that file-path conflicts arise if the `.codekin/` directory structure changes on `main`.

5. **Promote `no-unsafe-*` ESLint rules from `warn` to `error`** (Medium impact): The ESLint config's inline comment acknowledges these rules are "warnings for incremental adoption." Tracking this down will surface real unsafe patterns that could cause runtime errors. Recommend incrementally fixing files and promoting to `error` one rule at a time, starting with `no-unsafe-return` (most impactful for correctness).

6. **Clarify `busboy` and `streamsearch` licenses** (Low impact): Both packages are MIT-licensed in practice but have no `license` field in their `package.json`. This causes license audit tools to flag them as `unknown`. File an upstream issue or add an override in a license audit config to document the known license.

7. **Add `noImplicitReturns` to all tsconfig files** (Low impact): This catches missing return statements in non-void functions that the type checker alone can miss. A one-line change in each tsconfig. Likely zero new errors given the codebase's existing quality, but worth adding for completeness.

8. **Tag and release `v0.4.2`** (Low impact, process): The last tag `v0.4.1` is from the March 13 era. Since then, 50+ commits have landed including significant features (Agent Joe, worktree improvements, security hardening). A new release tag would give users a clear upgrade point and make the changelog more useful.
