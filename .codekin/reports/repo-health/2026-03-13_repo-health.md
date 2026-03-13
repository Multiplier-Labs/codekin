# Repository Health: codekin

**Date**: 2026-03-13T04:20:18.459Z
**Repository**: /srv/repos/codekin
**Branch**: main
**Workflow Run**: 4afa1127-56f3-4a29-85ec-b9742fb7e2fc
**Session**: 4438c704-d1d7-4bea-8e03-7bb6e55d3222

---

Now I have sufficient data to compile the full report. Let me write it.I now have all the data needed. Here is the full health assessment report:

---

## Summary

**Overall Health Rating: Good**

Codekin is an actively maintained project with strong TypeScript discipline, regular PR-based workflow, and near-zero comment debt. The main areas of concern are: a handful of unmerged remote branches that appear abandoned, one long-open PR, several ESLint safety rules downgraded to `warn` (noted as intentional but not tracked for promotion), and a lack of inline API documentation on route handlers. No copyleft licenses detected. Zero TODO/FIXME comments in source code.

| Metric | Value |
|---|---|
| Dead code items | 1 unused export identified |
| Stale TODOs (>30 days) | 0 |
| Config issues | 3 (warn-level ESLint rules, tsconfig target drift, missing server option) |
| License concerns | 0 (dompurify dual-license explicitly acknowledged) |
| Doc drift items | 2 (API endpoints undocumented; spec docs lag code) |
| Stale branches (>30 days) | 0 |
| Unmerged abandoned branches | 8 (candidates for cleanup) |
| Stuck PRs (>7 days, no review) | 1 |

---

## Dead Code

| File | Export / Function | Type | Recommendation |
|---|---|---|---|
| `src/lib/ccApi.ts:146` | `getHealth` | Unused export | No callers found in `src/` or `server/`. Remove unless needed for future use or external tooling. |

**Notes:**
- All other exports in `src/lib/ccApi.ts`, `src/hooks/`, `src/lib/chatFormatters.ts`, `src/lib/workflowHelpers.ts`, and `server/*.ts` were verified to have callers.
- No orphan files detected — all source files under `src/` and `server/` are transitively reachable from entry points.
- No unreachable private/internal functions found through spot-checking; the codebase is modular with clear import chains.

---

## TODO/FIXME Tracker

**No TODO, FIXME, HACK, XXX, or WORKAROUND comments exist in any project source file** (`src/`, `server/`, `bin/`).

The only hits from a broad grep are inside `server/claude-process.test.ts` where the string `'TODO'` appears as a *test input pattern* (verifying that `summarizeToolInput` returns the pattern text), not as a code comment.

| Metric | Count |
|---|---|
| TODO | 0 |
| FIXME | 0 |
| HACK | 0 |
| XXX | 0 |
| WORKAROUND | 0 |
| **Total** | **0** |
| Stale (>30 days) | 0 |

---

## Config Drift

### `tsconfig.app.json` (frontend)
No issues. `strict: true`, `noUnusedLocals`, `noUnusedParameters`, `noFallthroughCasesInSwitch`, `noUncheckedSideEffectImports`, `erasableSyntaxOnly` are all enabled. Targeting ES2022 with `moduleResolution: bundler` is appropriate for a Vite project.

### `tsconfig.node.json` (vite config only)
| Setting | Current Value | Note |
|---|---|---|
| `target` | `ES2023` | Slightly ahead of `tsconfig.app.json`'s ES2022 target. Minor inconsistency — no functional impact, but worth aligning. |

### `server/tsconfig.json`
| Setting | Current Value | Recommended | Note |
|---|---|---|---|
| `noUncheckedSideEffectImports` | *(absent)* | `true` | Present in both app configs but missing from the server config. Side-effect imports in server code go unchecked. |
| `target` | `ES2022` | ES2022 | OK. |
| `composite` | `true` | OK | |

### `eslint.config.mjs`
| Setting | Current Value | Recommended | Note |
|---|---|---|---|
| `@typescript-eslint/no-unsafe-assignment` | `warn` | `error` | Downgraded to warn for "incremental adoption." 10 unsafe-access rules are all `warn`. This is intentional per the inline comment, but without a tracking mechanism these may never be promoted. |
| `@typescript-eslint/no-unsafe-argument` | `warn` | `error` | Same as above. |
| `@typescript-eslint/no-unsafe-member-access` | `warn` | `error` | Same. |
| `@typescript-eslint/no-unsafe-return` | `warn` | `error` | Same. |
| `@typescript-eslint/no-unsafe-call` | `warn` | `error` | Same. |
| `@typescript-eslint/no-misused-promises` | `warn` | `error` | Same. |
| Test file config | `tseslint.configs.recommended` | `strictTypeChecked` | Test files use a weaker ruleset. Acceptable trade-off but worth noting. |

**Summary:** TypeScript configs are well-structured and strict. The primary risk is ESLint safety rules locked at `warn` with no visible escalation plan — they may accumulate violations silently.

### `.prettierrc`
No issues. `semi: false`, `singleQuote: true`, `trailingComma: all`, `printWidth: 120` — consistent and intentional.

---

## License Compliance

Project license: **MIT**

### Direct dependency license summary

| License | Count | Dependencies |
|---|---|---|
| MIT | 19 | react, react-dom, express, ws, marked, marked-highlight, highlight.js, tailwindcss, cmdk, multer, refractor, react-diff-view, react-markdown, remark-gfm, unidiff, better-sqlite3, vitest, eslint, @tabler/icons-react |
| Apache-2.0 | 2 | vite, ai (Vercel AI SDK) |
| BSD-3-Clause | 1 | typescript-eslint |
| MPL-2.0 OR Apache-2.0 | 1 | dompurify |

### Flagged dependencies

None. All licenses are permissively compatible with MIT:
- **Apache-2.0** (vite, ai): Fully compatible with MIT for distribution.
- **BSD-3-Clause** (typescript-eslint): Permissive.
- **MPL-2.0 OR Apache-2.0** (dompurify): The Apache-2.0 option makes it compatible. The project's `package.json` includes a `licenseNotes` field explicitly acknowledging this: *"dompurify is dual-licensed (MPL-2.0 OR Apache-2.0); both are permissively compatible with MIT for library use."*

No GPL, AGPL, LGPL, SSPL, or Commons Clause licenses detected in direct dependencies.

---

## Documentation Freshness

### API Docs Freshness

The server exposes approximately 40 REST endpoints across 8 route files. **None have JSDoc/TSDoc comments.** In the last 7 days, the following routes were added or significantly modified with no accompanying documentation update:

| Route | File | Change |
|---|---|---|
| `POST /api/tool-approval` | `session-routes.ts` | Approval system overhauled (requestId matching, pattern-first storage) |
| `POST /api/hook-decision` | `session-routes.ts` | Hook denial notification added |
| `POST /api/hook-notify` | `session-routes.ts` | New endpoint for surfacing hook denials |
| `GET /api/settings/repos-path` | `session-routes.ts` | New endpoint (configurable repos path) |
| `PUT /api/settings/repos-path` | `session-routes.ts` | New endpoint |
| `GET/POST /api/docs`, `GET /api/docs/file` | `docs-routes.ts` | Docs browser endpoints — no user-facing documentation |
| Diff viewer WebSocket messages | `src/types.ts` | New `DiffFile`, `DiffHunk`, `DiffLine`, `DiffSummary` types added without API docs |

`docs/stream-json-protocol.md` documents the WebSocket protocol at a high level but does not cover the new diff viewer WS message types added recently.

**Recommendation:** At minimum, add a brief comment block per route group describing auth requirements, request/response shapes, and error codes.

### README Drift

The README accurately reflects the following:
- Install commands (`curl -fsSL codekin.ai/install.sh | bash`) ✅
- CLI commands (`codekin token`, `codekin config`, `codekin service status`, etc.) ✅
- `npm run dev`, `npm test`, `npm run build` — match `package.json` ✅
- `REPOS_ROOT` default of `~/repos` — matches `server/config.ts:59` ✅
- Configuration variables table (PORT, REPOS_ROOT, GROQ_API_KEY, etc.) ✅

**Drift items found:**

| Item | Location | Issue |
|---|---|---|
| Slash command autocomplete | README Features | Listed under "Skill browser" but the new inline slash autocomplete (added `95a7606`) is not separately called out |
| Diff viewer sidebar | README Features | New diff viewer sidebar (added `000130c`) is not mentioned in the README features list |
| `CONTRIBUTING.md` | README | README references `CONTRIBUTING.md` ("see CONTRIBUTING.md for guidelines") but this file does not exist in the repository |

### CONTRIBUTING.md

Referenced in `README.md` but **missing from the repo**. Any contributor following the README will hit a 404.

---

## Draft Changelog

### Since v0.3.7 (2026-03-11) — 41 commits

#### Features

- **Diff viewer sidebar**: New `DiffPanel` component for browsing staged/unstaged/all file changes per session, with per-file discard support and card-based layout. Chunks large git path args to avoid `E2BIG` on large repos. (`000130c`, `e2efa62`)
- **Slash command autocomplete**: Inline autocomplete for `/skill` and built-in commands in the input bar. Refactored expansion pipeline to support both built-in and custom commands. (`95a7606`, `2336153`, `7787108`)
- **Configurable repos path**: New `GET/PUT /api/settings/repos-path` endpoints and UI setting for overriding the default `~/repos` discovery root. (`3cc0154`)
- **Approval system — 6 fixes**: Pattern-first approval storage (replacing exact-command bloat), surfacing silent hook denials in UI with access suggestions, requestId-guarded approval matching, cross-remote escalation fix, single-pending fallback, executor deny-list, prefix validation, and try/catch around denial notifications. (`f45a956`, `64d3064`, `4181c57`, `9263846`, `4045527`, `57ee8e3`, `89d24ad`)

#### Fixes

- File uploads: Added markdown support, increased size limit, improved error messages, and switched to immediate upload when message is withheld. (`89c7409`, `1c76f9a`, `fcbdd8d`)
- AskUserQuestion: Fallback for malformed input, preserve option values, add `image` event type. (`1a3bb5c`)
- Missing approval prompts for `WebSearch`, `WebFetch`, and other non-Bash tools. (`144a62b`)
- Stale cron schedules and decoupled commit-event auth. (`45c67db`)
- GPT/Gemini review nits: test wording, dangerous-prefix compaction test, safety tiers. (`a4bba2a`, `225ce22`, `9f31834`)

#### Documentation

- Added `APPROVALS-FIX-SPEC.md` covering all 6 approval system fixes with safety tiers and spec validation. (`eed4ec6` … `ed04303`)
- Added `DIFF-VIEWER-SPEC.md` with card layout, toolbar, discard support, and scope-aware untracked files. (`f5e1e37` … `2808829`)
- Removed Claude Code Bridge spec from public repo. (`01f6825`)
- Added repo health and security audit reports for 2026-03-12.

#### Chores

- Version bump to 0.3.7, package-lock.json update. (`38559d4`, `2018351`)
- Removed obsolete `.codekin/outputs/` directory. (`f5e8328`)

---

## Stale Branches

**Reference date:** 2026-03-13. Stale threshold: last commit > 30 days ago (i.e., before 2026-02-11).

**No branches meet the 30-day staleness threshold.** All remote branches have activity between 2026-03-08 and 2026-03-12.

However, the following unmerged branches have not been merged into `main` and appear to be abandoned or superseded — they are candidates for cleanup:

| Branch | Last Commit | Author | Merged? | Recommendation |
|---|---|---|---|---|
| `origin/feat/enforce-branching-policy` | 2026-03-08 | alari | No | 5 days old, unmerged. Review for relevance; delete if superseded. |
| `origin/fix/ci-lint-errors` | 2026-03-09 | alari | No | 4 days old. Likely superseded by subsequent lint fixes. Delete. |
| `origin/chore/update-test-coverage-report-2026-03-09` | 2026-03-10 | alari | No | Blocked by open PR #76. Merge or close. |
| `origin/chore/repo-health-audit-improvements` | 2026-03-11 | alari | No | Review and merge or close. |
| `origin/fix/installer-gh-auth-check` | 2026-03-10 | alari | No | 3 days old. Assess if still needed. |
| `origin/feat/uninstall-command` | 2026-03-10 | alari | No | 3 days old. Review; may be superseded. |
| `origin/feat/commit-review-workflow` | 2026-03-11 | alari | No | Related branches (`-def`, `-ui`, `-dispatcher`) are merged; this one is not. Review. |
| `origin/codekin/reports` | 2026-03-12 | alari | No | Appears to be a reports-only branch. Assess purpose. |

Additionally, **36 merged branches** exist on the remote that could be pruned (`git remote prune origin` + branch deletion) to reduce noise.

---

## PR Hygiene

| PR# | Title | Author | Days Open | Review Status | Conflicts | Stuck? |
|---|---|---|---|---|---|---|
| #76 | Chore: update test coverage report 2026-03-09 | alari76 | 3 | No reviews | Unknown | Borderline (no activity) |

Only 1 open PR. It has been open for 3 days with no review decision recorded. At the 7-day threshold it would qualify as "stuck." The branch `origin/chore/update-test-coverage-report-2026-03-09` is the source; the merge status is `UNKNOWN` (GitHub could not compute it at query time).

**Action:** Assign a reviewer or close if the test coverage data is superseded by more recent audit runs.

---

## Merge Conflict Forecast

All currently unmerged branches were branched from `main` between 2026-03-08 and 2026-03-12, within the last 5 days. `main` has received 41 commits since the oldest unmerged branch diverged.

| Branch | Approx. Commits Ahead | Commits main is Ahead | Overlapping Areas | Risk |
|---|---|---|---|---|
| `feat/enforce-branching-policy` | ~1–2 | ~40 | Likely workflow/CI configs | Medium — main has changed significantly |
| `fix/ci-lint-errors` | ~2–3 | ~38 | ESLint config, source files | Medium — ESLint config has evolved |
| `feat/commit-review-workflow` | ~3–5 | ~36 | `server/workflow-*.ts`, `server/ws-server.ts` | Medium — workflow engine has seen commits |
| `chore/update-test-coverage-report-2026-03-09` | ~1 | ~38 | `.codekin/reports/` | Low — reports are append-only |
| `chore/repo-health-audit-improvements` | ~5–8 | ~35 | Various | Medium |
| `feat/uninstall-command` | ~2–3 | ~38 | `bin/codekin.mjs`, `server/` | Medium — bin has likely changed |
| `fix/installer-gh-auth-check` | ~1–2 | ~38 | `bin/codekin.mjs` | Medium — same file area |
| `codekin/reports` | ~1–2 | ~37 | `.codekin/reports/` | Low — reports are append-only |

No branch is at critical/high conflict risk because the unmerged branches are small (1–8 commits). The medium-risk branches touch areas that have evolved on `main` (workflow engine, installer, ESLint), but the overlap is unlikely to be extensive. Recommend rebasing or merging promptly before `main` diverges further.

---

## Recommendations

1. **Create `CONTRIBUTING.md`** *(High Impact, Low Effort)* — The README links to it but the file is missing. Any first-time contributor will hit a dead end. A minimal guide covering branch naming, PR process, and the `npm test` / `npm run lint` commands is sufficient.

2. **Delete or merge the 8 unmerged remote branches** *(Medium Impact, Low Effort)* — `feat/enforce-branching-policy`, `fix/ci-lint-errors`, `feat/uninstall-command`, `fix/installer-gh-auth-check`, `feat/commit-review-workflow`, `chore/repo-health-audit-improvements`, `chore/update-test-coverage-report-2026-03-09`, `codekin/reports`. Run `git remote prune origin` after to clean tracking refs. Also prune the 36 merged-but-undeleted remote branches.

3. **Resolve PR #76** *(Medium Impact, Low Effort)* — Assign a reviewer or close it. The test coverage report may be superseded by more recent automated audit runs. If the branch's coverage data is still current, merge it; otherwise close and delete the branch.

4. **Create a plan to promote ESLint `warn` rules to `error`** *(High Impact, Medium Effort)* — Ten `@typescript-eslint` unsafe-access rules are currently warnings. Without an explicit promotion plan, they will remain warnings indefinitely and violations will accumulate silently. Add a `// TODO: promote to error by vX.Y` annotation or a tracking issue for each rule.

5. **Remove unused `getHealth` export** *(Low Impact, Minimal Effort)* — `src/lib/ccApi.ts:146` exports `getHealth` but it is never imported. Either remove the export or add a caller. The TypeScript compiler may flag this if `noUnusedLocals` is enforced at the module boundary.

6. **Add `noUncheckedSideEffectImports: true` to `server/tsconfig.json`** *(Low Impact, Minimal Effort)* — Both `tsconfig.app.json` and `tsconfig.node.json` have this option; the server tsconfig does not. Aligning all three tsconfigs eliminates an inconsistency.

7. **Update README to mention diff viewer and slash command autocomplete** *(Low Impact, Minimal Effort)* — Both features shipped since the last README update. They are significant UX features that new users will want to discover.

8. **Add route-level documentation to the API** *(Medium Impact, Medium Effort)* — The server exposes ~40 endpoints with no JSDoc, no OpenAPI spec, and no API reference in `docs/`. At minimum, each route module (`session-routes.ts`, `upload-routes.ts`, `webhook-routes.ts`, `workflow-routes.ts`, `docs-routes.ts`, `auth-routes.ts`) should have a header comment summarizing auth requirements and the shape of request/response bodies. New endpoints from the approvals fix (hook-notify, hook-decision) are especially opaque.

9. **Document new WebSocket message types in `docs/stream-json-protocol.md`** *(Medium Impact, Low Effort)* — The diff viewer introduced new WS message types (`DiffFile`, `DiffHunk`, `DiffSummary`, etc.) but `docs/stream-json-protocol.md` has not been updated. Any tooling or integration relying on this doc will be out of date.

10. **Align `tsconfig.node.json` target with `tsconfig.app.json`** *(Low Impact, Minimal Effort)* — `tsconfig.node.json` targets ES2023 while `tsconfig.app.json` targets ES2022. Since `tsconfig.node.json` only covers `vite.config.ts`, this is harmless today, but aligning them prevents confusion in a project that otherwise maintains consistent TypeScript settings.