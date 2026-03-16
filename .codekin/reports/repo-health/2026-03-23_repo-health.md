# Repository Health: codekin

**Date**: 2026-03-23T04:23:20.085Z
**Repository**: /srv/repos/codekin
**Branch**: main
**Workflow Run**: b47a5858-14e3-4ab3-9bd3-a751a5883f13
**Session**: 3c93ef23-490e-4039-9251-282930437f29

---

# Codekin Repository Health Report — 2026-03-23

> Generated: 2026-03-23 | Branch: `main` | Commit: `f5debe3`

---

## Summary

**Overall Health: Good**

Codekin is a highly active project with a clean, well-structured codebase. The engineering discipline is strong: strict TypeScript, comprehensive tests, consistent PR workflow, and zero TODO/FIXME debt in production source code. Key areas for attention are stale remote branch accumulation (23 merged branches pending deletion), a missing CHANGELOG entry for v0.4.1, undocumented orchestrator API routes, and a minor Node.js version contradiction in docs.

| Metric | Value |
|---|---|
| Dead code items | 0 confirmed (1 `.claude/worktrees/` cleanup opportunity) |
| Stale TODOs (project source) | 0 |
| Config issues | 2 minor (ES target mismatch, ESLint warn-vs-error drift) |
| License concerns | 0 (MPL-2.0 deps are build-time only or dual-licensed; documented in `package.json`) |
| Doc drift items | 3 (missing CHANGELOG v0.4.1 entry, undocumented orchestrator API, Node version contradiction) |
| Stale branches (>30 days) | 0 |
| Merged branches pending cleanup | 23 |
| Open PRs | 0 |
| Stuck PRs | 0 |
| Branches with conflict risk | 2 high-risk pairs |

---

## Dead Code

No confirmed dead exports or orphan source files were found. All checked components are imported and in active use. One housekeeping opportunity exists:

| Item | Type | Details | Recommendation |
|---|---|---|---|
| `.claude/worktrees/agent-a90049d3/` | Stale worktree directory | Agent worktree directory with full `src/` copy; not a source file, but accumulates disk space | Delete stale worktree directories when associated sessions end |
| `.claude/worktrees/agent-aa4c2a12/` | Stale worktree directory | Same as above | Delete stale worktree directories when associated sessions end |
| `.claude/worktrees/distributed-kindling-truffle/` | Stale worktree directory | Worktree from a named session | Verify session is inactive; delete if so |
| `.claude/worktrees/purring-fluttering-plum/` | Stale worktree directory | Worktree from a named session | Verify session is inactive; delete if so |

**Note:** `TentativeBanner.tsx`, `ModuleBrowser.tsx`, `DropZone.tsx`, and `OrchestratorContent.tsx` are all actively imported and used. No orphan component files were identified.

---

## TODO/FIXME Tracker

**Zero TODO, FIXME, HACK, XXX, or WORKAROUND comments** were found in project source files (`src/`, `server/*.ts`). The three grep matches that appeared were test assertions that use the string `"TODO"` as a grep pattern value in `server/claude-process.test.ts` — not actual annotations.

| file:line | type | comment | author | date | stale? |
|---|---|---|---|---|---|
| *(none)* | — | — | — | — | — |

**Summary:** Total: 0 | By type: 0 TODO, 0 FIXME, 0 HACK, 0 XXX, 0 WORKAROUND | Stale (>30 days): 0

---

## Config Drift

### `tsconfig.app.json`

| Setting | Current Value | Notes |
|---|---|---|
| `target` | `ES2022` | Fine for modern browsers; slightly behind `tsconfig.node.json` |
| `strict` | `true` | Correct |
| `noUnusedLocals` | `true` | Correct |
| `noUnusedParameters` | `true` | Correct |
| `noEmit` | `true` | Expected for Vite bundler mode |

### `tsconfig.node.json` (Vite config)

| Setting | Current Value | Notes |
|---|---|---|
| `target` | `ES2023` | One version ahead of `tsconfig.app.json` — minor inconsistency, not harmful |

### `server/tsconfig.json`

| Setting | Current Value | Notes |
|---|---|---|
| `target` | `ES2022` | Appropriate for Node.js |
| `strict` | `true` | Correct |
| `module` | `NodeNext` | Correct for ESM Node.js |
| `composite` | `true` | Correct for project references |

### `eslint.config.js`

| Finding | Details | Recommendation |
|---|---|---|
| Multiple strict rules demoted to `warn` | `no-non-null-assertion`, `no-unsafe-assignment`, `no-unsafe-argument`, `no-unsafe-member-access`, `no-unsafe-return`, `no-misused-promises`, `require-await`, `use-unknown-in-catch-callback-variable`, `restrict-template-expressions`, `no-unnecessary-condition`, `no-confusing-void-expression`, `no-base-to-string` are all `warn` | Intentional for incremental adoption (documented in comment). Promote to `error` as codebase is cleaned up. |
| Test files use `tseslint.configs.recommended` | Tests get weaker type checking than production code; `no-explicit-any` is explicitly off | Acceptable for test flexibility. Consider enabling `strictNullChecks`-equivalent checks if test coverage is safety-critical. |
| `server/*.ts` ESLint block excludes test files | Test files fall through to the catch-all `*.test.{ts,tsx}` block with relaxed rules | Fine by design; no action needed. |

---

## License Compliance

**Project license:** MIT

### Summary Table

| License | Count |
|---|---|
| MIT | 277 |
| ISC | 10 |
| BSD-3-Clause | 5 |
| Apache-2.0 | 3 |
| MPL-2.0 | 3 |
| (MPL-2.0 OR Apache-2.0) | 1 |
| (MIT OR WTFPL) | 1 |
| (BSD-2-Clause OR MIT OR Apache-2.0) | 1 |
| 0BSD | 1 |

### Flagged Dependencies

| Package | License | Risk | Notes |
|---|---|---|---|
| `lightningcss@1.31.1` | MPL-2.0 | Low | Build-time dependency via TailwindCSS v4; not distributed in output artifacts. Explicitly noted in `package.json` `licenseNotes`. |
| `lightningcss-linux-x64-gnu@1.31.1` | MPL-2.0 | Low | Platform binary for build; same rationale. |
| `lightningcss-linux-x64-musl@1.31.1` | MPL-2.0 | Low | Platform binary for build; same rationale. |
| `dompurify@3.3.3` | (MPL-2.0 OR Apache-2.0) | None | Dual-licensed; Apache-2.0 option is permissively compatible with MIT. Noted in `package.json` `licenseNotes`. |

**Assessment:** No compliance issues. All MPL-2.0 packages are either build-time-only (not shipped) or dual-licensed with Apache-2.0. The `package.json` `licenseNotes` field accurately documents the reasoning. No GPL, AGPL, or LGPL dependencies detected.

---

## Documentation Freshness

### API Docs Freshness

| Finding | Severity | Details |
|---|---|---|
| Orchestrator API routes undocumented | Medium | `server/orchestrator-routes.ts` exposes 14 REST endpoints under `/api/orchestrator/` (status, start, reports, children, memory, trust, notifications, dashboard, memory/extract). None appear in `docs/API-REFERENCE.md`. These routes were added over the past 30 days. |
| `docs/API-REFERENCE.md` is current for session/auth/webhook routes | — | Sessions, auth-verify, health, sessions/list, sessions/create, diff, hooks, and webhooks sections appear up to date. |

### README Drift

| Finding | Severity | Details |
|---|---|---|
| No script drift in README | — | `npm run dev`, `npm run build`, `npm test`, `npm run lint`, `npm run test:watch` all match `package.json` exactly. |
| `docs/SETUP.md` Node.js version contradiction | Low | Line 31 states "Node.js v18+" as a prerequisite, but later in the same file notes "codekin requires v24 for its own process." The README correctly does not specify a version. CONTRIBUTING.md says "Node.js 20+". Three different minimum versions across three docs. |
| `docs/SETUP.md` uses `npm install --prefix server` | Low | CONTRIBUTING.md includes this step; README (end-user install) does not — appropriate. No drift from current project structure. |
| `CHANGELOG.md` missing v0.4.1 entry | Medium | Current version is `0.4.1` (per `package.json`). The CHANGELOG ends at `[0.4.0] - 2026-03-14`. All changes since then (PRs #141–#232) are unrecorded. |
| `docs/ORCHESTRATOR-SPEC.md` is current | — | Correctly uses "Agent Joe" throughout. No stale "shepherd" or "Joe" inconsistencies in docs. |

---

## Draft Changelog

### [Unreleased → 0.4.1] — 2026-03-15 to 2026-03-23

#### Features
- Add AskUserQuestion prompt UI with enlarged font for question prompts (#232)
- Add orchestrator greeting guidelines and repo-policy discovery before first session spawn (#226, #227)
- Add per-session `allowedTools` pre-approval for CLI tools; pre-approve `curl` for Agent Joe and child sessions (#205)
- Add mid-session git worktree creation with worktree name indicator in input toolbar (#162, #163, #164)
- Add permission mode selector dropdown to InputBar (#157)
- Add Agent Joe welcome screen for empty orchestrator sessions (#184, #185, #186, #187)
- Add sidebar color-coded status dot and icon for Agent Joe session (#213, #215, #217, #219)
- Add tooltips to sidebar session status indicators (#219)
- Add `codekin upgrade` CLI command and in-UI update notification (#141, #142)
- Add Shepherd orchestrator: phases 1–4 (session management, reports, monitoring, memory) (#179)
- Add shepherd/orchestrator session cleanup API endpoints (#207)
- Add diff viewer sidebar for session file changes
- Add inline slash-command autocomplete

#### Fixes
- Workaround CLI `requiresUserInteraction` for AskUserQuestion in stream-json mode (#231)
- Properly extract questions/options and format answers for AskUserQuestion (#230)
- Handle AskUserQuestion via PreToolUse hook instead of `control_request` (#229)
- Use correct nested format for `control_response` messages (#223)
- Emit `planning_mode:false` for ExitPlanMode even without `tool_result` (#222)
- Prevent plan mode from getting stuck after denied ExitPlanMode (#221)
- Clear `isProcessing` flag when child session monitoring ends (#220)
- Rename shepherd to orchestrator; make agent name configurable in settings (#224, #225)
- Stop storing exact commands in approval registry; exclude from `--allowedTools` to prevent CLI parser crash (#217)
- Escape parentheses in `--allowedTools` to prevent tool execution errors (#216)
- Use Joe's `IconRobotFace` for agent-spawned sessions (#214)
- Dual-write approvals to native `settings.local.json` and load at spawn (#211)
- Auto-approve session `allowedTools` in permission hook path (#208)
- Increase orchestrator `MAX_CONCURRENT` from 3 to 5 (#206)
- Prevent restart cascade from stale session ID reuse (#152)
- Use `--resume` flag instead of `--session-id` for session restart (#197)
- Resolve symlinks in `browse-dirs` path check to prevent traversal (#175)
- Fix Agent Joe child sessions not appearing in sidebar (#203, #204)
- Update `flatted` to resolve high-severity prototype pollution vulnerability (#209)
- Update `dompurify` 3.3.2 → 3.3.3 (security patch)
- Harden SQLite file permissions and shell JSON escaping

#### Refactoring
- Rename shepherd → orchestrator throughout codebase (#224)
- Extract `DiffManager` class from `SessionManager` (#203)
- Extract `OrchestratorContent`, `SessionContent`, `DocsBrowserContent` from `App.tsx` (#203)
- Replace AI SDK with `claude -p` for session naming (#146, #147)
- Make prompt queue session-scoped (#177)

#### Documentation
- Implement comment audit improvements across 11 files (#210)
- Remove stale AI SDK references from docs (#201)
- Add orchestrator spec; rename Shepherd to Agent Joe in spec

#### Chores
- Add automated code review and repo health reports
- Add diff-parser test coverage from ~1% to 98% (#202)
- Remove AI SDK dependencies and API key prompts (#147)

---

## Stale Branches

No remote branches have their last commit older than 30 days (cutoff: 2026-02-21). However, **23 merged branches** remain on the remote and should be deleted.

### Merged Branches Pending Deletion

| Branch | Last Commit | Author | Merged? | Recommendation |
|---|---|---|---|---|
| `fix/security-hardening-2026-03-18` | 2026-03-18 | alari76 | Yes | Delete |
| `chore/docs-cleanup-2026-03-18` | 2026-03-18 | alari76 | Yes | Delete |
| `test/diff-parser-coverage-2026-03-18` | 2026-03-18 | alari76 | Yes | Delete |
| `refactor/reduce-complexity-2026-03-18` | 2026-03-18 | alari76 | Yes | Delete |
| `fix/agent-joe-session-sidebar` | 2026-03-19 | alari76 | Yes | Delete |
| `chore/dependency-updates-2026-03-18` | 2026-03-19 | alari76 | Yes | Delete |
| `fix/bug-fixes-2026-03-18` | 2026-03-19 | alari76 | Yes | Delete |
| `feat/per-session-allowed-tools` | 2026-03-19 | alari76 | Yes | Delete |
| `fix/increase-shepherd-concurrency` | 2026-03-19 | alari76 | Yes | Delete |
| `feat/shepherd-session-cleanup-api` | 2026-03-19 | alari76 | Yes | Delete |
| `fix/session-allowedtools-hook-bypass` | 2026-03-19 | alari76 | Yes | Delete |
| `chore/repo-health-report-2026-03-20` | 2026-03-21 | alari76 | Yes | Delete |
| `fix/code-review-audit-findings` | 2026-03-21 | alari76 | Yes | Delete |
| `docs/comment-audit-improvements` | 2026-03-21 | alari76 | Yes | Delete |
| `fix/native-permissions-dual-write` | 2026-03-21 | alari76 | Yes | Delete |
| `fix/agent-joe-cron-tools` | 2026-03-22 | alari76 | Yes | Delete |
| `feat/joe-sidebar-status-dot` | 2026-03-22 | alari76 | Yes | Delete |
| `fix/agent-session-icon` | 2026-03-22 | alari76 | Yes | Delete |
| `fix/cron-create-split-error` | 2026-03-22 | alari76 | Yes | Delete |
| `feat/joe-sidebar-icon-status` | 2026-03-22 | alari76 | Yes | Delete |
| `fix/tool-split-error` | 2026-03-22 | alari76 | Yes | Delete |
| `feat/sidebar-status-tooltips` | 2026-03-22 | alari76 | Yes | Delete |
| `fix/shepherd-icon-status-color` | 2026-03-22 | alari76 | Yes | Delete |

### Unmerged Branches (active or in-flight)

| Branch | Last Commit | Ahead | Behind | Notes |
|---|---|---|---|---|
| `fix/control-response-format` | 2026-03-22 | 2 | 3 | In-flight; touches session-manager.ts |
| `ui/question-prompt-sizing` | 2026-03-22 | 3 | 3 | In-flight; may be superseded by #232 which merged |
| `fix/orchestrator-repo-policy-discovery` | 2026-03-22 | 2 | 8 | In-flight |
| `fix/orchestrator-greeting-guidelines` | 2026-03-22 | 1 | 8 | Possibly superseded by #226 which merged |
| `fix/remove-shepherd-rename-orchestrator` | 2026-03-22 | 1 | 9 | Possibly superseded by #225 which merged |
| `refactor/shepherd-to-orchestrator` | 2026-03-22 | 1 | 12 | 28-file change; likely superseded by #224/#225 |
| `fix/plan-mode-exit-stuck` | 2026-03-22 | 1 | 12 | Appears superseded by #221 (same fix merged) |
| `feat/joe-chat-variant` | 2026-03-17 | 1 | ~35 | Old; superseded by subsequent Joe work |
| `chore/repo-health-report-2026-03-14` | 2026-03-14 | 0 | ~50 | Reports-only; content likely in main via other paths |
| `chore/repo-health-report-2026-03-18` | 2026-03-18 | 0 | ~30 | Reports-only |
| `codekin/reports` | 2026-03-22 | 0 | ~3 | Reports accumulation branch |

---

## PR Hygiene

**0 open pull requests.** The PR queue is completely clear.

| PR# | Title | Author | Days Open | Review Status | Conflicts | Stuck? |
|---|---|---|---|---|---|---|
| *(none)* | — | — | — | — | — | — |

---

## Merge Conflict Forecast

Only branches with commits ahead of `main` are analyzed.

| Branch | Ahead | Behind | Modified Files | Overlap With | Risk |
|---|---|---|---|---|---|
| `ui/question-prompt-sizing` | 3 | 3 | `.claude/hooks/pre-tool-use.mjs`, `server/session-manager.ts`, `server/session-manager.test.ts`, `server/session-routes.ts`, `src/components/PromptButtons.tsx` | `fix/control-response-format` (3 shared files) | **High** |
| `fix/control-response-format` | 2 | 3 | `.claude/hooks/pre-tool-use.mjs`, `server/session-manager.ts`, `server/session-manager.test.ts`, `server/session-routes.ts` | `ui/question-prompt-sizing` (4 shared files) | **High** |
| `refactor/shepherd-to-orchestrator` | 1 | 12 | 28 files including `server/orchestrator-manager.ts`, `server/session-manager.ts`, `src/App.tsx`, `src/types.ts`, `src/index.css`, and more | PRs #224/#225 already merged equivalent changes | **High — likely abandoned** |
| `fix/orchestrator-repo-policy-discovery` | 2 | 8 | `server/orchestrator-manager.ts` | `fix/orchestrator-greeting-guidelines` (same file) | Medium |
| `fix/orchestrator-greeting-guidelines` | 1 | 8 | `server/orchestrator-manager.ts` | `fix/orchestrator-repo-policy-discovery` | Medium |
| `fix/plan-mode-exit-stuck` | 1 | 12 | `server/claude-process.ts`, `server/claude-process.test.ts` | Main (PR #221 already merged the same fix) | Low — likely ghost branch |
| `feat/joe-chat-variant` | 1 | ~35 | `src/components/ChatView.tsx` | Main (extensive ChatView changes since branch point) | Medium — very stale |

**Highest Risk:** `ui/question-prompt-sizing` and `fix/control-response-format` both modify the same 3–4 server files. If both are intended for merge, one should be rebased onto the other to avoid conflicts.

**Action Required:** `refactor/shepherd-to-orchestrator` modifies 28 files and appears entirely superseded by commits already in `main` (#224, #225). It should be reviewed and closed/deleted to avoid accidental merge.

---

## Recommendations

1. **Delete all 23 merged remote branches** — Run `git push origin --delete <branch>` for all branches listed in the "Merged Branches Pending Deletion" table. This reduces noise and makes active work easier to identify. A single command batch can handle all 23.

2. **Add a CHANGELOG entry for v0.4.1** — The current version (`package.json`: `0.4.1`) has no CHANGELOG entry. The draft changelog above covers PRs #141–#232. Add it under a `[0.4.1]` heading with the correct release date.

3. **Document the orchestrator API in `docs/API-REFERENCE.md`** — 14 endpoints under `/api/orchestrator/` are live in production but missing from the reference docs. This makes integration and debugging harder for contributors.

4. **Resolve the `refactor/shepherd-to-orchestrator` branch** — This branch (28 files, 1 commit ahead) appears entirely superseded by PRs #224 and #225 already merged to `main`. Close the branch and delete it to prevent accidental merge.

5. **Merge or close `fix/control-response-format` and `ui/question-prompt-sizing`** — Both branches are ahead of `main` and touch the same files (`session-manager.ts`, `pre-tool-use.mjs`). If both are still needed, rebase one onto the other before merging to minimize conflict risk.

6. **Standardize the Node.js minimum version in docs** — `docs/SETUP.md` says v18+, CONTRIBUTING.md says v20+, and SETUP.md also mentions v24 internally. Pick one authoritative minimum (v20+ per CONTRIBUTING.md is reasonable) and update all three docs to match.

7. **Promote ESLint warnings to errors incrementally** — The ESLint config explicitly defers 10+ strict rules to `warn`. Create a tracking issue or schedule quarterly promotion of at least 2–3 rules to `error` as the codebase is cleaned up (e.g., start with `no-non-null-assertion` and `require-await`).

8. **Clean up stale `.claude/worktrees/` directories** — Four worktree directories (`agent-a90049d3`, `agent-aa4c2a12`, `distributed-kindling-truffle`, `purring-fluttering-plum`) appear to be left over from completed sessions. Verify these sessions are inactive and delete the directories to reclaim disk space. Consider adding automated cleanup to the session delete flow.

9. **Review and close `feat/joe-chat-variant`** — This branch is 1 commit ahead but ~35 commits behind `main`. The Joe chat variant work has since been substantially implemented through many subsequent PRs. Evaluate whether any remaining changes are still relevant or if the branch should be closed.

10. **Add orchestrator-specific integration tests** — The orchestrator subsystem (`orchestrator-manager.ts`, `orchestrator-routes.ts`, `orchestrator-children.ts`, etc.) handles significant business logic (child session spawning, memory, trust, notifications) but does not appear to have dedicated test files. Given the complexity, adding integration tests here would meaningfully increase confidence in the system.Committed and pushed `2026-03-23_repo-health.md` to `main` (commit `9fa5dce`).