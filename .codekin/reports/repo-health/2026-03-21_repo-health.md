# Codekin Repository Health Report — 2026-03-21

## Summary

**Overall Health: Good**

The codebase is actively maintained with high commit velocity (255+ code commits in the last 30 days), zero production TODO/FIXME debt, and strong TypeScript strictness configuration across all targets. The main areas requiring attention are: 11 merged-but-not-deleted remote branches accumulating as clutter, one unmerged feature branch (`feat/joe-chat-variant`) with high merge-conflict risk due to 63 commits of divergence, the `docs/API-REFERENCE.md` not covering recently added orchestrator/session endpoints, and one exported symbol (`DAY_PATTERNS`) that is unused.

| Category | Finding |
|---|---|
| Dead code items | 1 unused export |
| Production TODO/FIXME | 0 |
| Config issues | 2 (minor) |
| License concerns | 3 packages flagged (all low risk) |
| Doc drift items | 2 (API reference, orchestrator endpoints undocumented) |
| Merged-but-undeleted branches | 11 |
| Stale unmerged branches | 2 |
| Open PRs | 0 |

---

## Dead Code

### Unused Exports

| File | Export | Type | Recommendation |
|---|---|---|---|
| `src/lib/workflowHelpers.ts:50` | `DAY_PATTERNS` | Unused export | Remove — callers import `DAY_PRESETS` and `DAY_INDIVIDUAL` directly; the combined array is never consumed externally |

### Unreachable Functions

No unreachable private/internal functions detected. The `orchestrator-learning.ts` and `orchestrator-reports.ts` modules were verified to be imported by `server/orchestrator-monitor.ts` and `server/orchestrator-routes.ts`.

### Orphan Files

No orphan source files detected. All modules are reachable through the import graph:
- `server/session-persistence.ts` — imported by `session-manager.ts`
- `server/session-restart-scheduler.ts` — imported by `session-manager.ts`
- `src/lib/hljs.ts` — imported by `ChatView.tsx` and `MarkdownRenderer.tsx`

---

## TODO/FIXME Tracker

No `TODO`, `FIXME`, `HACK`, `XXX`, or `WORKAROUND` annotations were found in any production source file (`.ts`/`.tsx` outside test files).

The only keyword matches were in `server/claude-process.test.ts` (lines 60, 61, 818), which are test fixture strings (`{ pattern: 'TODO' }`) used to assert `summarizeToolInput` output — not actual annotations.

**Summary counts:**

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

### TypeScript

| Config File | Setting | Current Value | Status |
|---|---|---|---|
| `tsconfig.app.json` | `strict` | `true` | Good |
| `tsconfig.app.json` | `noUnusedLocals` | `true` | Good |
| `tsconfig.app.json` | `noUnusedParameters` | `true` | Good |
| `tsconfig.app.json` | `target` | `ES2022` | Good |
| `tsconfig.node.json` | `target` | `ES2023` | Good — vite.config.ts uses Node-side build tooling |
| `server/tsconfig.json` | `strict` | `true` | Good |
| `server/tsconfig.json` | `module` | `NodeNext` | Good — correct for ESM server code |
| `tsconfig.node.json` | `include` | `["vite.config.ts"]` only | Note: narrow scope is intentional but means `server/` has its own tsconfig project |

**No critical drift found.** Two minor notes:

1. **`eslint.config.js` — `ecmaVersion: 2020` across all blocks**: All three ESLint config blocks set `languageOptions.ecmaVersion: 2020`, while TypeScript targets ES2022/ES2023. ESLint's `ecmaVersion` controls which syntax constructs are considered valid; setting it lower than the TS target can cause false parse errors on valid modern syntax (e.g., `using`, `await using` from ES2022+). Recommend bumping to `2022` or `'latest'`.

2. **ESLint test-file block uses `globals.browser`**: The `**/*.test.{ts,tsx}` block sets `globals: globals.browser`, but server-side test files (`server/*.test.ts`) run in Node.js. This could suppress or miss Node-specific global warnings in server tests. Recommend using `globals.node` for server test files or creating a separate block for them.

3. **Several type-safety rules demoted to `warn`**: Intentionally documented in a comment as "incremental adoption." Items like `@typescript-eslint/no-unsafe-assignment`, `no-unsafe-argument`, `no-unsafe-member-access`, and `no-misused-promises` are currently warnings. These should be promoted to `error` as the codebase matures.

### Prettier

`.prettierrc` configuration is standard and consistent with the project style: no semicolons, single quotes, trailing commas, 120-char print width. No drift.

---

## License Compliance

The project is MIT-licensed. Dependency license distribution across 611 packages:

| License | Count | Compatible with MIT? |
|---|---|---|
| MIT | 524 | Yes |
| ISC | 23 | Yes |
| Apache-2.0 | 19 | Yes |
| BSD-3-Clause | 10 | Yes |
| BSD-2-Clause | 8 | Yes |
| BlueOak-1.0.0 | 4 | Yes (permissive) |
| MPL-2.0 | 12 | See note |
| (MPL-2.0 OR Apache-2.0) | 1 | See note |
| MIT-0 | 2 | Yes |
| 0BSD | 1 | Yes |
| CC0-1.0 | 1 | Yes (public domain) |
| CC-BY-4.0 | 1 | Yes (documentation/data only) |
| (BSD-2-Clause OR MIT OR Apache-2.0) | 1 | Yes |
| Python-2.0 | 1 | Yes (PSF permissive) |
| (MIT OR WTFPL) | 1 | Yes |
| UNKNOWN (missing in lock) | 2 | See note |

### Flagged Dependencies

| Package | License | Risk | Notes |
|---|---|---|---|
| `lightningcss` (+ 12 platform binaries) | MPL-2.0 | **Low** | Build-time only dependency used by TailwindCSS; not included in distributed artifacts. Documented in `package.json` `licenseNotes`. |
| `dompurify` | MPL-2.0 OR Apache-2.0 | **Low** | Dual-licensed; Apache-2.0 option is fully permissive. Documented in `package.json` `licenseNotes`. |
| `busboy` | MIT (confirmed) | **Low** | License text in `node_modules/busboy/LICENSE` confirms MIT. Missing from lock file metadata only. |
| `streamsearch` | MIT (confirmed) | **Low** | License text in `node_modules/streamsearch/LICENSE` confirms MIT. Missing from lock file metadata only. |
| `argparse` | Python-2.0 | **Low** | Python Software Foundation License v2, which is a permissive BSD-like license — not copyleft. Used by `eslint` (dev-only). |

**No GPL, AGPL, or strong copyleft licenses detected.** All flagged items are either build-time, dev-only, or carry permissive dual-license alternatives. The existing `licenseNotes` field in `package.json` already documents the MPL-2.0 cases.

---

## Documentation Freshness

### API Docs Freshness

`docs/API-REFERENCE.md` was last updated ~2 weeks ago (commit `246ca4f`). Since then, the following API surface was added and is **not documented**:

| Feature | PR | New Endpoints | Status |
|---|---|---|---|
| Per-session `allowedTools` | #205 | Settings sent in session create payload | **Undocumented** |
| Orchestrator session cleanup API | #207 | `DELETE /api/orchestrator/sessions/cleanup` | **Undocumented** |
| Orchestrator children API (multiple endpoints) | Earlier | `GET/POST /api/orchestrator/children`, `GET /api/orchestrator/children/:id` | **Undocumented** — orchestrator section entirely absent from API reference |
| Orchestrator memory, trust, notifications, dashboard | Earlier | Multiple `/api/orchestrator/*` routes | **Undocumented** |

The `docs/API-REFERENCE.md` covers sessions, auth, uploads, webhooks, and workflows but has zero coverage of the entire `/api/orchestrator/` namespace (~20 endpoints) and the newer `/api/settings/queue-messages`, `/api/settings/repos-path`, `/api/settings/worktree-prefix` settings endpoints.

### README Drift

`README.md` is broadly accurate. Findings:

| Item | Status |
|---|---|
| `codekin token`, `codekin config`, `codekin service *` CLI commands | Accurate |
| Port 32352 default | Matches `server/config.ts` |
| `REPOS_ROOT` default `~/repos` | Matches `server/config.ts` |
| `~/.config/codekin/env` config file path | Plausible; not directly verifiable from source — should confirm against install.sh |
| Feature list (diff viewer, worktrees, AI workflows, webhooks, approval management) | Accurate — all features present |

`CONTRIBUTING.md` is accurate: `npm install --prefix server` is valid (server has its own `package.json`), script names match `package.json`, environment variable table matches `server/config.ts`.

### Spec Documents

`docs/ORCHESTRATOR-SPEC.md` was last updated to rename "Orchestrator" to "Agent Joe" (commit `a2e1727`). The spec and implementation appear aligned. No spec drift detected in recently touched documents (`APPROVALS-FIX-SPEC.md`, `CLAUDE-HOOKS-SPEC.md`, `FEATURES.md`).

---

## Draft Changelog

Changes since `v0.4.1` (current `HEAD` is 2 commits ahead on the report branch; the following covers merged work on `main`):

### [Unreleased] — since v0.4.1

#### Features
- Add orchestrator session cleanup API (`DELETE /api/orchestrator/sessions/cleanup`) for purging orphaned Agent Joe child sessions
- Add per-session `allowedTools` configuration for pre-approving specific CLI tools without global approval
- Pre-approve `curl` for Agent Joe and child agent sessions by default

#### Fixes
- Auto-approve session `allowedTools` in the permission hook evaluation path, preventing bypass of pre-approved tools
- Fix Agent Joe child sessions not appearing in the sidebar after spawn
- Increase orchestrator `MAX_CONCURRENT` limit from 3 to 5 to reduce queue contention

#### Refactoring
- Extract `DiffManager` class from inline stateless functions in `server/diff-manager.ts`
- Decompose `App.tsx` (~749 lines → ~560 lines) by extracting `OrchestratorContent`, `DocsBrowserContent`, and `SessionContent` sub-components

#### Tests
- Raise `diff-parser.ts` test coverage from ~1% to 98% with comprehensive unit tests

#### Documentation
- Remove stale AI SDK and API key references from `docs/FEATURES.md` and `CONTRIBUTING.md`

#### Chores
- Add automated daily reports for 2026-03-19 and 2026-03-20
- Update 2026-03-20 repo health report with comment assessment

---

## Stale Branches

### Unmerged Branches

| Branch | Last Commit | Author | Merged to main? | Commits Ahead | Commits Behind | Recommendation |
|---|---|---|---|---|---|---|
| `origin/feat/joe-chat-variant` | 2026-03-17 | alari | No | 1 | 63 | Review — 63 commits behind with no recent activity suggests this may be abandoned. If the Joe chat variant is still desired, rebase or close. |
| `origin/chore/repo-health-report-2026-03-14` | 2026-03-14 | Claude (Webhook) | No | 2 | 210 | Delete — automated report branch, contents now superseded and incorporated into the `codekin/reports` branch. |
| `origin/chore/repo-health-report-2026-03-18` | 2026-03-18 | alari | No | 2 | 0 | Delete — daily report branch; content committed to main via other means. |
| `origin/codekin/reports` | 2026-03-20 | alari | No | 23 | 210 | Keep or merge — this is the dedicated reports accumulation branch. 210 commits behind main indicates it was branched long ago and receives only report commits. Consider rebasing onto main or merging regularly. |
| `origin/chore/repo-health-report-2026-03-20` | 2026-03-20 | alari | No | 2 | 0 | Current working branch (this report). Merge via PR. |

### Merged-but-Not-Deleted Branches (recommend deletion)

| Branch | Last Commit | Merged? |
|---|---|---|
| `origin/chore/dependency-updates-2026-03-18` | 2026-03-18 | Yes |
| `origin/chore/docs-cleanup-2026-03-18` | 2026-03-18 | Yes |
| `origin/feat/per-session-allowed-tools` | 2026-03-19 | Yes |
| `origin/feat/orchestrator-session-cleanup-api` | 2026-03-19 | Yes |
| `origin/fix/agent-joe-session-sidebar` | 2026-03-19 | Yes |
| `origin/fix/bug-fixes-2026-03-18` | 2026-03-19 | Yes |
| `origin/fix/increase-orchestrator-concurrency` | 2026-03-19 | Yes |
| `origin/fix/security-hardening-2026-03-18` | 2026-03-19 | Yes |
| `origin/fix/session-allowedtools-hook-bypass` | 2026-03-19 | Yes |
| `origin/refactor/reduce-complexity-2026-03-18` | 2026-03-18 | Yes |
| `origin/test/diff-parser-coverage-2026-03-18` | 2026-03-18 | Yes |

All 11 branches are fully merged into `main`. Remote deletion command:
```bash
git push origin --delete \
  chore/dependency-updates-2026-03-18 \
  chore/docs-cleanup-2026-03-18 \
  feat/per-session-allowed-tools \
  feat/orchestrator-session-cleanup-api \
  fix/agent-joe-session-sidebar \
  fix/bug-fixes-2026-03-18 \
  fix/increase-orchestrator-concurrency \
  fix/security-hardening-2026-03-18 \
  fix/session-allowedtools-hook-bypass \
  refactor/reduce-complexity-2026-03-18 \
  test/diff-parser-coverage-2026-03-18
```

---

## PR Hygiene

`gh pr list` returned zero open pull requests. No stuck PRs, no PRs with merge conflicts.

| Metric | Value |
|---|---|
| Open PRs | 0 |
| Stuck PRs (>7 days, no review) | 0 |
| PRs with merge conflicts | 0 |

---

## Merge Conflict Forecast

Active branches with recent commits or significant divergence from `main`:

| Branch | Commits Ahead | Commits Behind | Files Modified (branch-only) | Overlapping Files with main | Risk |
|---|---|---|---|---|---|
| `origin/feat/joe-chat-variant` | 1 | 63 | `src/components/ChatView.tsx` | `src/components/ChatView.tsx`, `src/types.ts`, `server/types.ts`, `src/App.tsx`, `src/components/InputBar.tsx`, `src/components/LeftSidebar.tsx`, `src/hooks/useSendMessage.ts` | **HIGH** — the single commit on this branch touches `ChatView.tsx`, which main has also modified; `types.ts` on both sides have significant additions |
| `origin/codekin/reports` | 23 | 210 | `.codekin/reports/**` only | None (reports directory) | **LOW** — all commits are report files in `.codekin/reports/`; no source code overlap |
| `origin/chore/repo-health-report-2026-03-14` | 2 | 210 | `.codekin/reports/**` only | None | **LOW** — reports only |
| `origin/chore/repo-health-report-2026-03-20` | 2 | 0 | `.codekin/reports/**` only | None | **LOW** — current branch, 0 behind main |

The only branch with genuine conflict risk is `feat/joe-chat-variant`. The overlap on `src/components/ChatView.tsx` is particularly concerning given the 63-commit divergence on `main` that includes major structural changes (App.tsx decomposition, new session types, orchestrator/Agent Joe integration). A merge or rebase would require careful manual resolution.

---

## Recommendations

1. **Delete 11 merged remote branches** — Run the deletion command in the Stale Branches section. These branches add noise to `git branch -r`, slow down tab completion, and clutter GitHub's branch list. This is a 30-second cleanup with no risk.

2. **Document the `/api/orchestrator/` API surface in `docs/API-REFERENCE.md`** — The entire orchestrator/Agent Joe namespace (~20 endpoints) is absent from the API reference. With the feature now stable, document the status, start, children, memory, trust, notifications, dashboard, and cleanup endpoints.

3. **Triage `feat/joe-chat-variant`** — This branch is 63 commits behind `main` and has only 1 commit of its own. Decide: rebase and revive, or close and delete. Leaving it will make a future merge increasingly painful as the conflict surface grows.

4. **Remove the `DAY_PATTERNS` export** from `src/lib/workflowHelpers.ts:50` — It is never imported. Consumers use `DAY_PRESETS` and `DAY_INDIVIDUAL` directly. Removing it reduces the public API surface of the module.

5. **Bump ESLint `ecmaVersion` from `2020` to `2022`** (or `'latest'`) in all three blocks of `eslint.config.js` — The TypeScript targets are ES2022/ES2023; keeping ESLint at 2020 means some valid modern syntax constructs may produce spurious parse errors.

6. **Promote ESLint `warn` rules to `error` incrementally** — Rules like `no-unsafe-assignment`, `no-unsafe-argument`, `no-unsafe-member-access`, and `no-misused-promises` are demoted to warnings. Run `npm run lint` to see current warning count, then fix and promote in batches. The comment in `eslint.config.js` acknowledges this is intentional for incremental adoption — schedule a cleanup sprint.

7. **Add missing license metadata to `package-lock.json`** for `busboy` and `streamsearch` — Both are MIT (confirmed from their `LICENSE` files) but have no `license` field in the lock. While low risk, this causes automated license scanners to flag them as unknown. A simple `npm install` refresh or manual annotation would resolve it.

8. **Merge or regularly rebase `origin/codekin/reports`** — This branch is 210 commits behind `main`. If it is intended as a persistent reports accumulation branch, establish a regular merge cadence (e.g., weekly) so it does not fall too far behind and accumulate unresolvable conflicts if reports structure ever changes.

9. **Consider enabling GitHub's auto-delete-branch-on-merge setting** — Given the 11 accumulated merged branches, enabling "Automatically delete head branches" in the repository settings would prevent this class of clutter from accruing in the future.

10. **Tag a new release** — The current `HEAD` of `main` is 14+ PRs and significant features ahead of `v0.4.1`. The unreleased work includes notable features (Agent Joe orchestration, per-session tool approvals, worktree support maturation) that users installing from npm are not receiving. Consider cutting `v0.5.0`.
