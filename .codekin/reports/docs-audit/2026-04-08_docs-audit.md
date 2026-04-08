# Repository Health Assessment — 2026-04-08

**Repository:** codekin  
**Branch assessed:** chore/workflow-reports-2026-04-07  
**Assessment date:** 2026-04-08  
**Assessor:** Automated (Claude Sonnet 4.6)

---

## Summary

**Overall Health: Good**

The repository is in active, well-maintained condition with high-volume commit activity (40+ commits in 7 days) focused on security hardening, reliability improvements, and tooling upgrades. No critical structural issues were found. Primary concerns are stale compiled artifacts in `server/dist/`, one documented API endpoint that does not exist as a REST route, two open PRs with no review activity, and two branches at high risk of merge conflicts with `main`.

| Metric | Count |
|---|---|
| Dead code items (source-level) | 0 |
| Stale compiled artifacts | 10 (in `server/dist/`) |
| Stale TODOs/FIXMEs | 0 |
| Config issues | 2 minor (ESLint) |
| License concerns | 0 |
| Doc drift items | 2 (phantom REST endpoint; undocumented workflow routes) |
| Stale branches (30+ days) | 0 |
| Open PRs | 2 (both <2 days old, neither reviewed) |
| High conflict-risk branches | 2 |

---

## Dead Code

No unused exports, unreachable functions, or orphan source files were found in `src/` or `server/*.ts`. All modules are reachable from entry points (`src/main.tsx`, `server/ws-server.ts`).

### Stale Compiled Artifacts

`server/dist/` contains `.d.ts` declaration files for modules whose source `.ts` files no longer exist. These are remnants of the shepherd→orchestrator rename and the removed review subsystem.

| File | Type | Recommendation |
|---|---|---|
| `server/dist/review-config.d.ts` | Orphan compiled artifact | Delete — source removed |
| `server/dist/review-handler.d.ts` | Orphan compiled artifact | Delete — source removed |
| `server/dist/review-routes.d.ts` | Orphan compiled artifact | Delete — source removed |
| `server/dist/shepherd-children.d.ts` | Orphan compiled artifact | Delete — source removed (renamed to orchestrator) |
| `server/dist/shepherd-learning.d.ts` | Orphan compiled artifact | Delete — source removed |
| `server/dist/shepherd-manager.d.ts` | Orphan compiled artifact | Delete — source removed |
| `server/dist/shepherd-memory.d.ts` | Orphan compiled artifact | Delete — source removed |
| `server/dist/shepherd-monitor.d.ts` | Orphan compiled artifact | Delete — source removed |
| `server/dist/shepherd-reports.d.ts` | Orphan compiled artifact | Delete — source removed |
| `server/dist/shepherd-routes.d.ts` | Orphan compiled artifact | Delete — source removed |

**Root cause:** `server/dist/` is not cleaned before TypeScript compilation. Running `rm -rf server/dist && npm run build --prefix server` before deploy would eliminate these permanently.

---

## TODO/FIXME Tracker

**Result: Zero actionable annotations found.**

A full scan of `src/**`, `server/*.ts`, and configuration files for `TODO`, `FIXME`, `HACK`, `XXX`, and `WORKAROUND` returned no results in production source files. The only pattern matches were inside a test file that asserts grep behavior — not actual annotations.

| Metric | Count |
|---|---|
| Total annotations | 0 |
| TODO | 0 |
| FIXME | 0 |
| HACK | 0 |
| XXX | 0 |
| WORKAROUND | 0 |
| Stale (>30 days) | 0 |

---

## Config Drift

### TypeScript (`tsconfig.json`, `tsconfig.app.json`, `tsconfig.node.json`, `server/tsconfig.json`)

All TypeScript configurations are modern and correct:

- Strict mode enabled everywhere
- `noUnusedLocals: true`, `noUnusedParameters: true` enforced
- Frontend uses `erasableSyntaxOnly: true` (correct for TS 6 / Vite 8 erase-only compilation model)
- Server uses `module: NodeNext`, `moduleResolution: NodeNext` (correct for ESM)

**No issues found.**

### ESLint (`eslint.config.js`)

| Config file | Setting | Current value | Note |
|---|---|---|---|
| `eslint.config.js` | 11 `@typescript-eslint/*` rules | `warn` (intentionally downgraded) | Should eventually be `error`; acknowledged in config as staged migration |
| `eslint.config.js` | Frontend test globals | `globals.browser` | Tests run in jsdom/vitest — `globals.node` would be more accurate; no practical impact |

The 11 warn-downgraded rules are explicitly acknowledged in the config. This is a conscious technical debt decision, not unintentional drift. The `globals.browser` mismatch for test files is minor.

### Prettier (`.prettierrc`)

No issues. Modern settings (`semi: false`, `singleQuote: true`, `printWidth: 120`). No eslint-plugin-prettier integration — the modern recommended approach.

---

## License Compliance

All production dependencies use MIT or MIT-compatible licenses. No copyleft licenses present in distributed artifacts.

**Production dependencies:**

| License | Count | Packages |
|---|---|---|
| MIT | 4 | `better-sqlite3`, `express`, `multer`, `ws` |

**Key dev/bundled dependencies (included in frontend bundle):**

| License | Count | Packages |
|---|---|---|
| MIT | 11 | `react`, `react-dom`, `tailwindcss`, `marked`, `react-markdown`, `cmdk`, `refractor`, `react-diff-view`, `remark-gfm`, `marked-highlight`, `eslint` |
| BSD-3-Clause | 1 | `highlight.js` |
| MPL-2.0 OR Apache-2.0 | 1 | `dompurify` (dual-licensed; both permissive, compatible with MIT for library use) |
| Apache-2.0 | 1 | `typescript` (build-only, not distributed) |
| MPL-2.0 | 1 | `lightningcss` (build-only via TailwindCSS, not distributed) |

**Flagged dependencies:** None. No GPL, AGPL, or LGPL licenses present.

---

## Documentation Freshness

### API Docs — Finding: Phantom Endpoint

`docs/API-REFERENCE.md` documents `POST /api/tool-approval` as a REST endpoint in the Hook Endpoints auth section:

> "Hook endpoints (`/api/tool-approval`, `/api/hook-decision`, `/api/hook-notify`) also accept session-scoped tokens."

**This endpoint does not exist as a REST route.** Tool approval is handled via WebSocket message routing (`approval_response` message type in `ws-message-handler.ts`), not HTTP. `/api/hook-decision` and `/api/hook-notify` exist as REST routes; `/api/tool-approval` does not.

**Action:** Remove `/api/tool-approval` from the REST endpoint list; add a note clarifying approval responses travel via WebSocket (`approval_response` message type).

### API Docs — Finding: Undocumented Workflow Routes

`workflow-routes.ts` defines 15+ endpoints (`/api/workflows/*`) covering schedule management, run control, repo config, and commit-event webhooks. These are absent from `docs/API-REFERENCE.md`. The workflow system has a dedicated `docs/WORKFLOWS.md` covering the workflow format but not the REST API surface.

**Action:** Add a Workflows section to `docs/API-REFERENCE.md`.

### README Drift

| Document | Item | Status |
|---|---|---|
| `CLAUDE.md` | `npm run dev`, `npm run build`, `npm test`, `npm run test:watch`, `npm run lint` | All valid ✓ |
| `CONTRIBUTING.md` | `npm install`, `npm install --prefix server`, all standard scripts | All valid ✓ |
| `README.md` | End-user CLI commands | Intentionally user-facing; no dev scripts expected |
| `package.json` | `npm run preview` | Not documented in README, CLAUDE.md, or CONTRIBUTING.md — minor omission |
| `CONTRIBUTING.md` | Server build step (`npm run build --prefix server`) | Not mentioned; deploy script depends on it |

No breaking README drift. All documented commands and paths are valid.

---

## Draft Changelog

### Since `v0.5.4` (last tag, 2026-04-06)

#### [Unreleased] — 2026-04-07 to 2026-04-08

##### Chores
- Add workflow reports for 2026-04-07 (`9fa3e36`)

##### Fixes
- Security, reliability, and housekeeping fixes — PR #298 (`9c7eb52`)

---

### Full 7-Day Activity (2026-04-01 to 2026-04-08)

#### Features
- Add `--dangerously-skip-permissions` as a configurable permission mode setting (`34dae11`)
- Pass `CODEKIN_SKIP_PERMISSIONS` env var to hooks when dangerouslySkipPermissions is active (`8d72746`)
- Support subscription auth and unblock standalone CLI sessions (`86ab1b5`)

#### Fixes
- Security, reliability, and housekeeping fixes — PR #298 (`9c7eb52`)
- Fall back to fresh session when `--resume` hangs with zero output — PR #292 (`5218005`)
- Stabilize Claude process lifecycle to prevent restart loops — PR #290 (`42e228c`)
- Resolve restart loop from race condition in `startClaude()` — PR #288 (`b800e22`)
- Exempt agent/orchestrator sessions from idle reaper and stale pruner (`4365bf0`)
- Overhaul approvals architecture for parity with native CLI — PR #280 (`da1e26b`)
- Address security audit warnings W-01, W-02, W-03 (`3f1047e`)
- Address code review findings W-02, W-03, W-04, W-09, I-09 — PR #282 (`7c5893f`)
- Remove dead export, fix docs drift, add logging to silent catches (`57516a9`)
- Address code review warnings and update stale docs (`f996d91`)

#### Refactoring
- Reduce code complexity across 6 high-priority areas — PR #267 (`917f748`)

#### Tests
- Improve code coverage across server and frontend modules — PR #265 (`1fa73a3`)

#### Documentation
- Update changelog and readme for v0.5.4 — PR #295 (`87b8db8`, `152c11b`)
- Update API reference, orchestrator spec, protocol docs, and changelog (`bb82455`)

#### Chores
- Add workflow reports for 2026-04-07 (`9fa3e36`)
- Upgrade TypeScript 6, Vite 8, ESLint 10, jsdom 29 (`ea69433`, `88dd14c`)
- Bump version to 0.5.4, 0.5.3, 0.5.2 (`0f0bd02`, `3afd27f`, `0ccae41`)

---

## Stale Branches

No branches with last commit older than 30 days. All remote branches are recent (within 3 days of assessment date).

| Branch | Last Commit | Age | Merged? | Recommendation |
|---|---|---|---|---|
| `origin/chore/workflow-reports-2026-04-07` | 2026-04-08 | 0 days | No | Active — current branch |
| `origin/main` | 2026-04-07 | 1 day | — | — |
| `origin/fix/reliability-security-apr07` | 2026-04-07 | 1 day | No | Rebase onto main and merge, or close |
| `origin/chore/reports-2026-04-07` | 2026-04-07 | 1 day | No | Likely superseded; review and close |
| `origin/docs/changelog-readme-v0.5.4` | 2026-04-06 | 2 days | Yes | Safe to delete |
| `origin/fix/repo-cleanup-2026-04-06` | 2026-04-06 | 2 days | Yes | Safe to delete |
| `origin/chore/reports-2026-04-06` | 2026-04-06 | 2 days | Yes | Safe to delete |
| `origin/fix/resume-hang-fallback` | 2026-04-05 | 3 days | No | Likely superseded by `5218005` on main; verify and close |
| `origin/fix/code-review-2026-04-05` | 2026-04-05 | 3 days | Yes | Safe to delete |

**Merged branches safe to delete (4):** `docs/changelog-readme-v0.5.4`, `fix/repo-cleanup-2026-04-06`, `chore/reports-2026-04-06`, `fix/code-review-2026-04-05`

---

## PR Hygiene

| PR# | Title | Author | Days Open | Review Status | Mergeable | Stuck? |
|---|---|---|---|---|---|---|
| #299 | chore: add workflow reports for 2026-04-07 | alari76 | <1 | No reviews | MERGEABLE | No |
| #297 | chore: add repo health report for 2026-04-07 and fix code review artifact | alari76 | 1 | No reviews | UNKNOWN | No |

Both PRs are chore/report PRs from the automated workflow system. Neither is stuck (both <2 days old). PR #297's `UNKNOWN` mergeability should be investigated — it is 1 commit behind main and may have a conflict.

---

## Merge Conflict Forecast

| Branch | Ahead main | Behind main | Overlapping files with main | Risk |
|---|---|---|---|---|
| `fix/reliability-security-apr07` | 2 | 1 | `server/session-manager.ts`, `server/ws-server.ts`, `eslint.config.js` | **HIGH** |
| `fix/resume-hang-fallback` | 1 | 10 | `server/session-manager.ts`, `server/claude-process.ts` | **HIGH** (likely superseded) |
| `chore/reports-2026-04-07` | 1 | 1 | `.codekin/reports/` (markdown only) | LOW |
| `chore/workflow-reports-2026-04-07` | 1 | 0 | `.codekin/reports/` (markdown only) | LOW |

**Details:**

- **`fix/reliability-security-apr07`** — edits `session-manager.ts` and `ws-server.ts`. Main's most recent commit `9c7eb52` (security/reliability fixes, April 7) also touched these files. Rebasing before merge is required; manual conflict resolution likely needed.

- **`fix/resume-hang-fallback`** — 10 commits behind main. Commit `5218005` on main already contains "fall back to fresh session when --resume hangs with zero output", which matches this branch's stated purpose. This branch is likely fully superseded and should be closed without merging.

---

## Recommendations

1. **Close `fix/resume-hang-fallback` as superseded.** Commit `5218005` on `main` already contains the resume-hang fallback fix. The branch is 10 commits behind and creates duplicate/conflicting changes to `session-manager.ts` and `claude-process.ts`. Verify and close.

2. **Rebase `fix/reliability-security-apr07` immediately.** HIGH conflict risk with `main` due to overlapping edits to `session-manager.ts` and `ws-server.ts`. Rebase onto current `main`, resolve conflicts, and merge or close before additional main commits accumulate.

3. **Fix the phantom `/api/tool-approval` reference in `docs/API-REFERENCE.md`.** This documents a non-existent REST endpoint. Update the auth/hook section to reflect that approval responses travel via WebSocket (`approval_response` message type). This causes active confusion for developers reading the API docs.

4. **Add a Workflows section to `docs/API-REFERENCE.md`.** The `workflow-routes.ts` file defines 15+ REST endpoints for schedule management, run control, repo config, and commit-event webhooks. None are documented in the API reference.

5. **Clean up `server/dist/` stale artifacts.** The 10 orphaned `.d.ts` files from the shepherd→orchestrator rename are noise in the compiled output. Add `rm -rf server/dist` before the TypeScript compile step in the deploy script to ensure clean builds.

6. **Delete 4 already-merged remote branches.** `docs/changelog-readme-v0.5.4`, `fix/repo-cleanup-2026-04-06`, `chore/reports-2026-04-06`, `fix/code-review-2026-04-05` are all merged and can be deleted: `git push origin --delete <branch>`.

7. **Resolve PR #297 mergeability.** The `UNKNOWN` status may indicate a merge conflict. Check for conflicts and rebase if needed before the PR stagnates.

8. **Promote ESLint `warn` rules to `error` incrementally.** The 11 downgraded TypeScript ESLint rules accumulate type-unsafe patterns over time. Consider a quarterly campaign to fix violations one rule at a time, starting with `require-await` and `no-non-null-assertion`.

9. **Add `npm run preview` and server build step to developer documentation.** The `preview` script is undocumented; the `npm run build --prefix server` step required for deploy is also absent from `CONTRIBUTING.md`.

10. **Add an `[Unreleased]` section to `CHANGELOG.md`.** Commit `9c7eb52` (security/reliability fixes, PR #298) shipped after the v0.5.4 tag with no changelog entry. Following Keep a Changelog convention, add an `[Unreleased]` section above `[0.5.4]`.
