# Repository Health Report — 2026-04-20

**Project:** Codekin · **Branch assessed:** `docs/audit-reports-2026-04-18` · **Latest tag:** `v0.6.3`

---

## Summary

**Overall Health: Good**

The codebase is in strong shape. Strict TypeScript and ESLint enforcement eliminate dead code at compile time, and no technical debt comments exist in production source. Dependency licenses are clean with no copyleft exposure. The main areas requiring attention are PR queue hygiene (8 open docs-only PRs, several stuck >7 days) and post-merge branch cleanup (19 undeleted remote branches). Documentation is comprehensive but a few recently hardened endpoints are not fully reflected in `docs/API-REFERENCE.md`.

| Metric | Value |
|---|---|
| Dead code items | 0 (enforced by compiler) |
| Stale TODOs (production) | 0 |
| Config issues | 1 minor (ES target inconsistency) |
| License concerns | 2 packages with missing license field in lock file |
| MPL-2.0 packages | 13 (all build-time via lightningcss) |
| Doc drift items | 3 |
| Branches >30 days stale | 0 |
| Branches undeleted post-merge | 1 confirmed + ~14 doc/audit candidates |
| Open PRs | 8 (all docs; 3 stuck >7 days) |

---

## Dead Code

No dead code was found. The project enforces `noUnusedLocals` and `noUnusedParameters` in all three TypeScript configs (`tsconfig.app.json`, `tsconfig.node.json`, `server/tsconfig.json`) and ESLint `strictTypeChecked` catches further issues at lint time. Any orphan export or unreachable function would fail the build before it could accumulate.

**Result:** No items to report.

---

## TODO/FIXME Tracker

A full scan of `src/`, `server/`, and `bin/` for `TODO`, `FIXME`, `HACK`, `XXX`, and `WORKAROUND` in production source files (excluding `*.test.*`) found **zero matches**.

References to "TODO" that appear in the test suite (`server/claude-process.test.ts:60,61,809`, `server/opencode-process.test.ts:557`) are test fixtures for grep pattern matching — not technical debt.

| Metric | Count |
|---|---|
| Total TODO/FIXME/HACK/XXX/WORKAROUND | 0 |
| Stale (>30 days) | 0 |

---

## Config Drift

### tsconfig — minor ES target inconsistency

| Config file | Setting | Current value | Recommended |
|---|---|---|---|
| `tsconfig.node.json` | `target` | `ES2023` | `ES2022` (matches app + server) |
| `tsconfig.app.json` | `target` | `ES2022` | ✓ |
| `server/tsconfig.json` | `target` | `ES2022` | ✓ |

`tsconfig.node.json` covers only `vite.config.ts`, so the mismatch is low-risk, but aligning to ES2022 removes a minor inconsistency.

### tsconfig — all configs pass modern best-practice checks

- `strict: true` ✓ (all three configs)
- `noUnusedLocals`, `noUnusedParameters` ✓ (all three)
- `noFallthroughCasesInSwitch` ✓
- `noUncheckedSideEffectImports` ✓ (app + node configs; server uses `isolatedModules` instead)
- `forceConsistentCasingInFileNames` ✓ (server)
- `skipLibCheck: true` — acceptable for a monorepo using `@types/*`

### ESLint — well-configured, no issues

- Extends `tseslint.strictTypeChecked` for both frontend and server
- All five `no-unsafe-*` rules enforced as errors
- React Hooks plugin and React Refresh plugin active
- Test files correctly relax to `tseslint.recommended` with `no-explicit-any: off`

### Prettier — no issues

`.prettierrc` uses `semi: false`, `singleQuote: true`, `trailingComma: all`, `printWidth: 120` — consistent and sensible for this codebase.

---

## License Compliance

The project is MIT-licensed. No GPL, AGPL, or LGPL dependencies were found.

### License distribution

| License | Package count |
|---|---|
| MIT | 465 |
| ISC | 22 |
| Apache-2.0 | 18 |
| MPL-2.0 | 12 |
| BSD-3-Clause | 9 |
| BSD-2-Clause | 8 |
| BlueOak-1.0.0 | 4 |
| MIT-0 | 2 |
| **UNKNOWN (no field)** | **2** |
| (MPL-2.0 OR Apache-2.0) | 1 |
| (MIT OR WTFPL) | 1 |
| (BSD-2-Clause OR MIT OR Apache-2.0) | 1 |
| CC0-1.0, CC-BY-4.0, 0BSD | 1 each |

### Flagged dependencies

| Package | Version | License | Concern |
|---|---|---|---|
| `busboy` | 1.6.0 | missing in lock file | Upstream is MIT (mscdex/busboy) but field is absent from `package-lock.json` |
| `streamsearch` | 1.1.0 | missing in lock file | Upstream is MIT (same author) but field is absent |
| `lightningcss` + 12 platform packages | — | MPL-2.0 | Build-time only (used by TailwindCSS v4); not bundled into distributed output — no compliance obligation |
| `dompurify` | — | MPL-2.0 OR Apache-2.0 | Dual-licensed; Apache-2.0 option is fully MIT-compatible |

**Action required:** `busboy` and `streamsearch` are transitive dependencies of `multer`. Their license fields are absent from the lock file but both packages are historically MIT. Confirm by reading `node_modules/busboy/LICENSE` and `node_modules/streamsearch/LICENSE` if formal compliance documentation is needed.

---

## Documentation Freshness

### API docs drift

Recent security hardening commits (2026-04-13 to 2026-04-18) introduced or strengthened several server behaviors. The following are not fully reflected in `docs/API-REFERENCE.md`:

| Change | Commit | Doc status |
|---|---|---|
| Hard caps added to auth and webhook rate-limiter Maps | `84d18eb` (2026-04-17) | Rate-limit caps not mentioned in API-REFERENCE |
| `repoPath` and cron expression validation added to workflow/orchestrator routes | `a413e45` (2026-04-18) | Validation constraints not documented on those endpoints |
| Symlink bypass prevention in spawn route via `realpathSync` | `df174b0` (2026-04-17) | Security behavior not documented |

`docs/ORCHESTRATOR-SPEC.md` and `docs/WORKFLOWS.md` should be updated to note that `repoPath` is now validated (resolved against an allowlist or normalized) and that cron expressions are validated server-side.

### README drift

`README.md` accurately describes all `codekin` CLI commands and the `npm run *` scripts in `package.json`. No commands, paths, or configuration references were found to be missing or incorrect.

One minor gap: `README.md` says `npm run dev` starts the development server, but this only launches the Vite frontend — it does not start the Node WebSocket/Express backend. `CONTRIBUTING.md` correctly documents that the server must be started separately. Consider adding a note to the README Quick Start for developers.

### CONTRIBUTING.md

All documented commands (`npm install`, `npm install --prefix server`, `npm run dev`, `npm test`, `npm run lint`, `npm run build`) match `package.json` exactly. No drift.

---

## Draft Changelog

Period: since tag `v0.6.3` to `origin/main` HEAD (2026-04-13 → 2026-04-18)

### Features

- Add Claude Opus 4.7 to available models (`claude-opus-4-7`) — exposes the new model in the model picker for all session types (#421)
- Unified `ProcessCoordinator` for session lifecycle — single coordinator manages startup, shutdown, and restart across Claude and OpenCode providers (#404)

### Fixes

- Validate `repoPath` and cron expression on workflow/orchestrator routes — prevents path traversal and malformed cron from reaching the scheduler (#423)
- Add hard key caps to auth and webhook rate-limiter Maps — bounds memory growth under sustained request load (#418)
- Prevent JSON injection in `commit-event-hook.sh` — shell-escapes repo path before embedding in hook script (#417)
- Use `realpathSync` to prevent symlink bypass in spawn route — resolves symlinks before whitelist check (#419)
- Harden docs browser root scope and persist canonical paths (#409)
- Prevent spurious reconfigure when model is first assigned to a new session (#407)
- Polish Edit Workflow modal — frequency highlights, day grid, model default, layout (#403, #405, #408)
- Unify workflow report commit/push across Markdown and Stepflow systems (#398)
- Add API rate limiter map cap and attachment file size limit (#397)

### Refactoring

- Decompose `App.tsx` into focused hooks — reduces root component size; improves separation of state concerns (#416)
- Split `orchestrator-routes.ts` into focused sub-routers (#415)

### Documentation

- Cleanup docs for Apr 15 audit — PR review additions, cross-references, roadmap restructure (#414)
- Session initiation audit report (#399)

### Chores

- Enforce strict `@typescript-eslint/no-unsafe-*` rules across entire codebase (#410, #411)
- Remove leftover blank line from debug lifecycle log cleanup (#420)

---

## Stale Branches

Branches are assessed against the 30-day staleness threshold (last commit before 2026-03-21). No branches breach this threshold — the repo is actively maintained.

**However**, 19 feature/fix/docs branches remain open on the remote after their work was either merged to `main` or superseded. The table below lists all remote branches, their last activity, and cleanup recommendation.

| Branch | Last commit | Author | Merged to main? | Recommendation |
|---|---|---|---|---|
| `fix/symlink-bypass-spawn` | 2026-04-17 | alari | **Yes** | **Delete** — only confirmed post-merge branch |
| `feat/connection-status-popup` | 2026-04-11 | alari | No (5 commits ahead) | Review — feature may be in-progress or abandoned |
| `test/coverage-gaps-apr10` | 2026-04-10 | Claude (Webhook) | No (2 commits ahead) | Review — no linked PR; may be superseded |
| `feat/pr-373-audit-report` | 2026-04-12 | alari | No (1 commit ahead) | Has open PR #374 — merge or close |
| `feat/daily-code-review-2026-04-12` | 2026-04-12 | alari | No (1 ahead) | Has open PR #392 — merge or close |
| `chore/pr-audit-2026-04-12` | 2026-04-12 | alari | No (1 ahead) | Has open PR #390 — merge or close |
| `feat/repo-health-2026-04-13` | 2026-04-13 | alari | No (1 ahead) | Has open PR #395 — merge or close |
| `feat/test-coverage-2026-04-13` | 2026-04-13 | alari | No (1 ahead) | Has open PR #396 — merge or close |
| `docs/session-restart-audit` | 2026-04-15 | alari | No (1 ahead) | Has open PR #402 — merge or close |
| `docs/cleanup-apr15` | 2026-04-15 | alari | No | Has open PR #413 — merge or close |
| `refactor/app-decompose-hooks` | 2026-04-15 | alari | No (commits ahead) | Corresponding PR #416 merged to main; verify then delete |
| `refactor/split-orchestrator-routes` | 2026-04-15 | alari | No (commits ahead) | Corresponding PR #415 merged to main; verify then delete |
| `fix/json-injection-hook` | 2026-04-17 | alari | No | PR #417 merged to main; verify then delete |
| `fix/rate-limiter-map-caps` | 2026-04-17 | alari | No | PR #418 merged to main; verify then delete |
| `feat/add-opus-4-7` | 2026-04-17 | alari | No | PR #421 merged to main; verify then delete |
| `chore/remove-debug-lifecycle-logs` | 2026-04-17 | alari | No | PR #420 merged to main; verify then delete |
| `fix/input-validation-2026-04-18` | 2026-04-18 | alari | No | PR #423 merged to main; verify then delete |
| `feat/repo-health-2026-04-15` | 2026-04-16 | alari | No | Check if superseded by later health reports |
| `codekin/reports` | 2026-04-19 | alari | No | Active audit branch — keep |
| `docs/audit-reports-2026-04-18` | 2026-04-19 | alari | No | **Current branch** — in-progress |

---

## PR Hygiene

All 8 open PRs are authored by `alari76`. All are `MERGEABLE` with no detected conflicts. All are documentation/audit report PRs with no review decisions recorded.

| PR # | Title | Days open | Stuck (>7d)? |
|---|---|---|---|
| #422 | docs: add accumulated audit reports (2026-04-16 through 2026-04-18) | 2 | No |
| #413 | docs: weekly repo health report + accumulated audit reports (2026-04-15) | 5 | No |
| #402 | docs: session restart root cause audit | 7 | Borderline |
| #396 | docs: test coverage report 2026-04-13 | 7 | Borderline |
| #395 | docs: repo health report 2026-04-13 | 7 | Borderline |
| #392 | docs: add daily code review report for 2026-04-12 | **8** | **Yes** |
| #390 | docs: PR code review audit (2026-04-12, last 7 merged) | **8** | **Yes** |
| #374 | docs: Add audit report for PR #373 | **8** | **Yes** |

All stuck PRs are documentation-only with no code changes. There are no feature or fix PRs currently blocked. The backlog pattern suggests that automated report generation is creating PRs faster than they are reviewed and merged. Consider enabling auto-merge for the `docs:` PR category, or batching audit reports into weekly PRs rather than one per report.

---

## Merge Conflict Forecast

Active branches (commits within the last 14 days) assessed against `origin/main`:

| Branch | Commits ahead | Commits behind | Key files modified | Conflict risk |
|---|---|---|---|---|
| `docs/audit-reports-2026-04-18` (current) | 2 | 1 | `.codekin/reports/` only | **Low** — no source overlap |
| `codekin/reports` | several | several | `.codekin/reports/` only | **Low** — documentation only |
| `feat/connection-status-popup` | 5 | unknown | Unknown — needs investigation | **Unknown** — oldest non-doc branch; may overlap UI files touched by `refactor/app-decompose-hooks` |
| `test/coverage-gaps-apr10` | 2 | many | Server test files | **Low-Medium** — server has had significant changes; test files may need rebasing |

No high-conflict-risk branches were identified among active development branches. The symlink bypass fix, JSON injection fix, rate limiter caps, and model addition all merged cleanly and are no longer branches.

The `feat/connection-status-popup` branch (9 days, 5 commits ahead, no open PR) presents the highest unknown risk — if it touches `src/App.tsx` or `src/hooks/`, the App decomposition refactor (#416) will require rebasing.

---

## Recommendations

1. **Merge the open docs PR backlog** — PRs #374, #390, #392, #395, #396, #402 are all mergeable, stuck, and conflict-free. Merge them in a batch or enable auto-merge for `docs:` label PRs to clear the queue.

2. **Delete confirmed post-merge branches** — `fix/symlink-bypass-spawn` is the only branch confirmed merged via `--merged`. Audit the other fix/feat branches from 2026-04-15 to 2026-04-17 (whose corresponding PRs are merged to main) and delete them: `refactor/app-decompose-hooks`, `refactor/split-orchestrator-routes`, `fix/json-injection-hook`, `fix/rate-limiter-map-caps`, `feat/add-opus-4-7`, `chore/remove-debug-lifecycle-logs`, `fix/input-validation-2026-04-18`.

3. **Resolve or close `feat/connection-status-popup`** — This branch is 9 days old, has 5 commits, no open PR, and is the oldest untracked feature branch. Either open a PR or close and delete the branch before the divergence grows further.

4. **Update API docs for hardened endpoints** — `docs/API-REFERENCE.md`, `docs/ORCHESTRATOR-SPEC.md`, and `docs/WORKFLOWS.md` do not document the `repoPath` validation, cron expression validation, or rate-limiter cap behaviors added in the 2026-04-13 to 2026-04-18 window. Update these before the next external release.

5. **Clarify `npm run dev` in README** — Add a note that `npm run dev` starts only the Vite frontend; the Node backend requires a separate start command. This is a common source of confusion for new contributors.

6. **Investigate `busboy`/`streamsearch` license fields** — These two packages show no license field in `package-lock.json`. Verify by reading `node_modules/busboy/LICENSE` and `node_modules/streamsearch/LICENSE`. If they are MIT as expected, this is informational only; if not, it becomes a compliance issue.

7. **Align `tsconfig.node.json` target to ES2022** — Trivial one-line change to remove the `ES2023` vs `ES2022` inconsistency across configs.

8. **Batch automated audit PRs** — The repo accumulates one PR per daily audit report. Consider running the automated audit workflow in a weekly batch PR instead of daily individual PRs to reduce PR queue noise and reviewer fatigue.

9. **Investigate `test/coverage-gaps-apr10`** — This branch was authored by `Claude (Webhook)` and has 2 commits with no open PR. Verify whether the coverage improvements were incorporated elsewhere, then delete if superseded.

10. **Add explicit MPL-2.0 build-time note to SECURITY.md or LICENSE** — `lightningcss` (MPL-2.0) is a TailwindCSS v4 peer dependency. While it is build-time only and not distributed, a brief note in `SECURITY.md` or a `THIRD_PARTY_LICENSES` file would make the license posture self-documenting for downstream users and auditors.
