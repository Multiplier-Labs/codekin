# Repository Health: codekin

**Date**: 2026-03-17T04:24:17.092Z
**Repository**: /srv/repos/codekin
**Branch**: main
**Workflow Run**: 1517cdc8-3b0d-426e-80ef-bb15f72f6110
**Session**: eb6672cd-2fb4-4588-85ed-b4f3ecc67514

---

Now I have all the data needed. Let me compose the full report.Now I have everything needed. Let me write the full report.Now I have everything I need. Here is the complete health assessment report:

---

## Summary

**Overall Health Rating: Good**

Codekin (`v0.4.1`) is in active, healthy development with strong practices: PR-based workflow strictly enforced, strict TypeScript throughout, ~83% test coverage, 0 vulnerabilities, and zero TODO/FIXME debt in production code. The primary issues are housekeeping: 31 merged remote branches awaiting deletion, a stale `package-lock.json` left after AI SDK removal, 14 ESLint type-safety rules demoted to warnings, and 1 long-open PR with no reviewer. Documentation is largely current with one minor README staleness item.

| Metric | Value |
|---|---|
| Dead code items | 1 (stale lockfile entries; no unused exports found) |
| Stale TODOs/FIXMEs | 0 |
| Config issues | 1 (14 ESLint rules at `warn` instead of `error`) |
| License concerns | 1 low-risk (MPL-2.0 `lightningcss`, build-tool only) |
| Doc drift items | 1 (README mentions removed API key prompts) |
| Stale branches | 0 stale (30-day window); 31 merged branches awaiting deletion |
| Stuck PRs | 1 (PR #131, 3 days old, no reviewer) |

---

## Dead Code

No unused exported symbols or orphan source files were identified. All exports in `src/types.ts` and `server/types.ts` are consumed by their respective callers. All React components are rendered from `App.tsx` or parent components. All server modules are imported by entry points or peer modules.

**One category of orphaned references was found: stale lockfile entries.**

| File | Item | Type | Recommendation |
|---|---|---|---|
| `package-lock.json` | `@ai-sdk/anthropic`, `@ai-sdk/google`, `@ai-sdk/groq`, `@ai-sdk/openai`, `@ai-sdk/gateway`, `@ai-sdk/provider`, and ~10 transitive `@ai-sdk/*` sub-packages | Orphaned lockfile entries | Run `npm install` to regenerate the lockfile after the `package.json` cleanup in commit `e099d28` (2026-03-16). The stale entries don't cause vulnerabilities (`npm audit` reports 0) but cause `package-lock.json` / `package.json` inconsistency. |

**Note on `session-manager.ts`**: At 1,519 lines, this is the largest server file despite partial refactoring (`DiffManager`, `RestartScheduler` were extracted in commit `3dd0f89`). It warrants a future dead-path audit but no concrete unused functions were identified in this scan.

---

## TODO/FIXME Tracker

**Zero actionable TODO/FIXME/HACK/XXX/WORKAROUND annotations** were found in any production source file under `src/` or `server/`.

The only matches were in test fixture data:
- `server/claude-process.test.ts` lines 60–61, 818: the string literal `'TODO'` used as test input to `summarizeToolInput()` — these are test data strings, not annotations.

| File:Line | Type | Comment | Author | Date | Stale? |
|---|---|---|---|---|---|
| `server/claude-process.test.ts:60` | Test data | `'TODO'` as grep argument in test fixture | — | — | N/A |

**Summary**

| Category | Count |
|---|---|
| TODO | 0 |
| FIXME | 0 |
| HACK | 0 |
| XXX | 0 |
| WORKAROUND | 0 |
| **Stale (>30 days)** | **0** |

---

## Config Drift

### `tsconfig.app.json` / `tsconfig.node.json` / `server/tsconfig.json`

| Setting | Current Value | Assessment |
|---|---|---|
| `strict` | `true` | Correct |
| `noUnusedLocals` | `true` | Correct |
| `noUnusedParameters` | `true` | Correct |
| `noFallthroughCasesInSwitch` | `true` | Correct |
| `noUncheckedSideEffectImports` | `true` | Correct (TypeScript 5.6+) |
| `erasableSyntaxOnly` | `true` | Correct (TS 5.5+ best practice) |
| `target` | `ES2022` (app) / `ES2023` (node) | Appropriate for the runtimes |
| `moduleResolution` | `bundler` | Correct for Vite |

No drift found in TypeScript configuration. Settings are modern and well-matched to the stack.

### `eslint.config.js`

| Config File | Setting | Current Value | Recommended Value | Notes |
|---|---|---|---|---|
| `eslint.config.js` | `@typescript-eslint/no-unsafe-assignment` | `warn` | `error` | Demoted alongside 13 other rules to allow incremental adoption |
| `eslint.config.js` | `@typescript-eslint/no-unsafe-argument` | `warn` | `error` | Same batch demotion |
| `eslint.config.js` | `@typescript-eslint/no-unsafe-member-access` | `warn` | `error` | Same batch demotion |
| `eslint.config.js` | `@typescript-eslint/no-unsafe-return` | `warn` | `error` | Same batch demotion |
| `eslint.config.js` | `@typescript-eslint/no-unsafe-call` | `warn` | `error` | Same batch demotion |
| `eslint.config.js` | `@typescript-eslint/no-non-null-assertion` | `warn` | `error` | Same batch demotion |
| `eslint.config.js` | `@typescript-eslint/no-misused-promises` | `warn` | `error` | Same batch demotion |
| `eslint.config.js` | `@typescript-eslint/no-unnecessary-condition` | `warn` | `error` | Same batch demotion |
| `eslint.config.js` | `@typescript-eslint/restrict-template-expressions` | `warn` | `error` | Same batch demotion |
| `eslint.config.js` | `@typescript-eslint/no-explicit-any` | `off` (tests) | `warn` | Off in test files — acceptable but allows any leakage |
| `eslint.config.js` | Test files use `recommended` only | — | `strictTypeChecked` | Test linting is less strict than production |

A comment in the file acknowledges this is intentional ("should be promoted to errors incrementally"). The intent is tracked; no config is broken — this is planned technical debt.

**Prettier**: No Prettier configuration found. The project does not use Prettier; formatting consistency relies on TypeScript compiler strictness and developer discipline.

---

## License Compliance

**Project license:** MIT

**Dependency license summary (unique packages, from `package-lock.json`):**

| License | Package Count | Status |
|---|---|---|
| MIT | 508 | ✅ Compatible |
| Apache-2.0 | 27 | ✅ Compatible |
| ISC | 18 | ✅ Compatible |
| BSD-3-Clause | 10 | ✅ Compatible |
| BSD-2-Clause | 8 | ✅ Compatible |
| MPL-2.0 | 12 | ⚠️ Weak copyleft — see note |
| BlueOak-1.0.0 | 2 | ✅ Permissive |
| MIT-0 | 2 | ✅ Compatible |
| CC-BY-4.0 | 1 | ✅ Data license — see note |
| CC0-1.0 | 1 | ✅ Compatible |
| 0BSD | 1 | ✅ Compatible |
| Python-2.0 | 1 | ✅ Compatible |
| (MPL-2.0 OR Apache-2.0) | 1 | ✅ Use Apache-2.0 option |
| Other multi-license | 2 | ✅ Compatible option available |

**Flagged dependencies:**

| Package | Version | License | Issue |
|---|---|---|---|
| `lightningcss` + 11 platform variants | `1.31.1` | MPL-2.0 | Weak copyleft. Used by TailwindCSS as a **build-time** CSS transformer — not distributed in the application bundle or the published npm package (`files` in `package.json` only includes `bin/`, `dist/`, `server/dist/`, `server/workflows/`). Low risk. |
| `dompurify` | — | MPL-2.0 OR Apache-2.0 | Project `package.json` already notes this as permissively compatible (Apache-2.0 option). Included in `dist/`. No issue. |
| `caniuse-lite` | `1.0.30001777` | CC-BY-4.0 | Data/content license, not a code license. Attribution required. Transitive build-time dep via browserslist. Standard across the ecosystem; no practical issue. |

**No GPL, AGPL, or LGPL licenses detected.**

**Note on stale lockfile entries:** The removed `@ai-sdk/*` packages in `package-lock.json` are all Apache-2.0 licensed — no compliance concern, but they add noise to any license scan until the lockfile is regenerated.

---

## Documentation Freshness

### API Docs (`docs/API-REFERENCE.md`)

`docs/API-REFERENCE.md` is comprehensive and covers all major REST endpoints including sessions, archive, settings, approvals, hooks, uploads, repos, docs browser, webhooks, and workflows. However, the recent addition of **git worktree support** (PR #156, merged 2026-03-16) introduced new session fields and behavior that may not be reflected:

| Area | Changed | Doc Updated? | Flag |
|---|---|---|---|
| Session object: worktree fields (`worktreeDir`, `worktreeName`) | 2026-03-16 (PR #156) | Not confirmed | ⚠️ Review `POST /api/sessions` and `GET /api/sessions/:id` response schemas |
| Worktree creation endpoint (if REST) | 2026-03-16 | Not confirmed | ⚠️ Check if worktree creation is API-accessible and documented |
| Permission mode field on sessions | 2026-03-16 (PR #157/158) | Not confirmed | ⚠️ Review session create/update payloads |
| Settings: `autoEnableWorktrees`, `queueMessages` | 2026-03-17 (PR #172/173) | Not confirmed | ⚠️ Review `GET/PUT /api/settings` response schema in docs |

### README Drift (`README.md`)

| Section | Current README Text | Actual State | Flag |
|---|---|---|---|
| Install wizard description | "Prompt for optional LLM API keys (Groq, OpenAI, Gemini, Anthropic)" | API key prompts removed from setup wizard in commit `e099d28` (2026-03-16) | ⚠️ Stale — minor |
| Script table | `npm run dev`, `npm test`, `npm run build`, `npm run lint` | Matches `package.json` scripts | ✅ Current |
| Install URL | `codekin.ai/install.sh` | Updated in commit `6d1225c` | ✅ Current |
| CLI command list | `token`, `config`, `service`, `start`, `setup`, `upgrade`, `uninstall` | `upgrade` command added in `b0a3072` (2026-03-16); README already covers it | ✅ Current |
| Configuration table | `PORT`, `REPOS_ROOT`, `GROQ_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, `ANTHROPIC_API_KEY` | AI SDK removed; Groq/OpenAI/Gemini keys no longer used by server | ⚠️ Stale — config table still lists AI provider keys that the server no longer consumes |

### WORKFLOWS.md

Lists 7 built-in workflows. The file was updated in the docs cleanup commit (`6da2b0f`, 2026-03-14). No concrete drift detected without comparing against `server/workflows/` directory contents.

---

## Draft Changelog

### Unreleased — 2026-03-17 (since `v0.4.0` tag, 2026-03-14)

> **Note:** `v0.4.1` was tagged on 2026-03-16 via commit `2fd8282`. The entries below represent all non-merge commits between `v0.4.0` and the current HEAD (`90077d3`).

#### Features

- Add git worktree support for isolated session directories (`9e8a144`)
- Add mid-session worktree creation from the InputBar (`c20f5c3`, `f59899d`)
- Add auto-enable worktrees setting for new sessions (`82186ab`)
- Make queued message system a configurable setting (off by default) (`582fc9e`)
- Add permission mode selector dropdown to InputBar (`8161915`)
- Add `codekin upgrade` CLI command (`b0a3072`)
- Add in-UI notification when a newer version is available (`8d88873`)
- Increase diff panel max width to 1,200 px for wider screens (`2329d16`)
- Add docs-audit automated weekly workflow (`feat/docs-audit-workflow`)

#### Fixes

- Worktree creation: resolve failures and session ID reuse (`a2c86b6`)
- Worktree creation: harden against stale dirs and subdirectory cwd (`3d13344`)
- Worktree lifecycle: wait for Claude process exit before migration (`76b69c8`)
- Worktree lifecycle: clean up on session delete; block inheritance to new sessions (`126982b`)
- Worktree paths: key approval rules by repo root, not worktree path (`3b459dc`)
- Worktree environment: strip inherited `GIT_*` env vars from child processes (`d71e27b`)
- Worktree UI: keep toggle visible until user sends first message (`470a0c8`)
- Skills popup: anchor to right edge to prevent viewport overflow (`ec796fc`)
- Popup selectors: unify styles and close siblings on open (`373a7e1`, `85ae039`)
- Permission hook: fall back to `control_request` when hook can't reach server (`6caae1f`)
- Permission mode and model validation: harden server-side checks (`6bee5fa`)
- Session naming: prevent CLI error messages from becoming session names (`126d575`)
- Session restore: fix restart loop after server restart (`f9f41f9`)
- Server restart cascade: prevent from stale session ID reuse (`3ac19c2`)
- SPA routing: add fallback error handling and styled 404/500 pages (`5577d0f`)
- `ExitPlanMode`: prevent from being auto-approved (`cf9f05a`)
- Approval countdown: fix auto-approve not firing when timer expires (`9757531`)
- Folder picker: follow symlinks, fix CLI naming (`fbdb2ee`)
- Completion gate: install deps before running tests/build (`434d5cd`)
- Gitignore: add `.claude/worktrees/` entry (`2d44712`)

#### Refactoring

- Extract `DiffManager` and `RestartScheduler` from `SessionManager` (`3dd0f89`)
- Replace AI SDK with `claude -p` for session naming (`47db47f`, `844dccf`)
- Reorganize InputBar footer layout (`fdd204b`)

#### Documentation

- Remove stale AI SDK and API key references from docs and README (`246ca4f`, `6da2b0f`)

#### Chores

- Remove `ai`, `@ai-sdk/*` dependencies and API key setup prompts from installer (`e099d28`)
- Bump version to `0.4.1` (`2fd8282`)
- Add daily code review, security audit, and complexity reports (`b86e528`, `8f8c814`, `b577699`)

---

## Stale Branches

**Definition:** branches with no commit activity in the last 30 days.

**Finding:** All 34 remote branches (excluding `main`) have activity dated 2026-03-14 or later — none are stale by the 30-day definition.

However, 31 of these branches are **fully merged into `main`** and are candidates for immediate deletion:

| Branch | Last Commit | Author | Merged? | Recommendation |
|---|---|---|---|---|
| `origin/chore/repo-health-action-items` | 2026-03-14 | alari | ✅ Yes | Delete |
| `origin/feat/folder-picker-repos-path` | 2026-03-14 | Claude (Webhook) | ✅ Yes | Delete |
| `origin/fix/csp-google-fonts` | 2026-03-14 | alari76 | ✅ Yes | Delete |
| `origin/fix/approval-waiting-state` | 2026-03-14 | alari | ✅ Yes | Delete |
| `origin/feat/docs-audit-workflow` | 2026-03-14 | alari76 | ✅ Yes | Delete |
| `origin/fix/approval-auto-approve-countdown` | 2026-03-14 | alari | ✅ Yes | Delete |
| `origin/fix/docs-audit-cleanup` | 2026-03-16 | alari | ✅ Yes | Delete |
| `origin/feat/update-notification` | 2026-03-16 | alari | ✅ Yes | Delete |
| `origin/feat/diff-panel-max-width` | 2026-03-16 | alari | ✅ Yes | Delete |
| `origin/fix/completion-gate-install-deps` | 2026-03-16 | alari | ✅ Yes | Delete |
| `origin/fix/remove-ai-sdk-and-api-key-prompts` | 2026-03-16 | alari76 | ✅ Yes | Delete |
| `origin/fix/folder-picker-symlinks-and-cli-naming` | 2026-03-16 | alari | ✅ Yes | Delete |
| `origin/fix/session-restore-race-condition` | 2026-03-16 | Claude (Webhook) | ✅ Yes | Delete |
| `origin/fix/gitignore-worktrees` | 2026-03-16 | alari76 | ✅ Yes | Delete |
| `origin/fix/docs-remove-ai-sdk-references` | 2026-03-16 | alari76 | ✅ Yes | Delete |
| `origin/fix/server-restart-cascade` | 2026-03-16 | alari76 | ✅ Yes | Delete |
| `origin/fix/permission-hook-silent-deny` | 2026-03-16 | alari | ✅ Yes | Delete |
| `origin/fix/spa-fallback-and-404-page` | 2026-03-16 | alari | ✅ Yes | Delete |
| `origin/feat/worktree-support` | 2026-03-16 | alari | ✅ Yes | Delete |
| `origin/feat/permission-mode-selector` | 2026-03-16 | alari | ✅ Yes | Delete |
| `origin/fix/worktree-toggle-visibility` | 2026-03-16 | alari | ✅ Yes | Delete |
| `origin/fix/popup-style-and-mutual-close` | 2026-03-16 | alari | ✅ Yes | Delete |
| `origin/feat/mid-session-worktree` | 2026-03-16 | alari | ✅ Yes | Delete |
| `origin/fix/worktree-session-race` | 2026-03-16 | alari | ✅ Yes | Delete |
| `origin/fix/worktree-creation` | 2026-03-16 | alari | ✅ Yes | Delete |
| `origin/fix/worktree-creation-robustness` | 2026-03-16 | alari | ✅ Yes | Delete |
| `origin/fix/worktree-git-env-pollution` | 2026-03-16 | alari | ✅ Yes | Delete |
| `origin/fix/worktree-session-cleanup` | 2026-03-16 | alari76 | ✅ Yes | Delete |
| `origin/fix/skills-popup-overflow` | 2026-03-17 | alari | ✅ Yes | Delete |
| `origin/feat/worktree-auto-enable-setting` | 2026-03-17 | alari76 | ✅ Yes | Delete |
| `origin/feat/queue-messages-setting` | 2026-03-17 | alari76 | ✅ Yes | Delete |

**Unmerged branches (active, not merged):**

| Branch | Last Commit | Author | Merged? | Recommendation |
|---|---|---|---|---|
| `origin/chore/repo-health-report-2026-03-14` | 2026-03-14 | Claude (Webhook) | ❌ No | Open as PR #131 — review and merge or close |
| `origin/codekin/reports` | 2026-03-16 | alari | ❌ No | Automated reports branch — intentionally separate; retain as-is |

**Bulk delete command for all merged branches:**

```bash
git push origin --delete \
  chore/repo-health-action-items feat/folder-picker-repos-path fix/csp-google-fonts \
  fix/approval-waiting-state feat/docs-audit-workflow fix/approval-auto-approve-countdown \
  fix/docs-audit-cleanup feat/update-notification feat/diff-panel-max-width \
  fix/completion-gate-install-deps fix/remove-ai-sdk-and-api-key-prompts \
  fix/folder-picker-symlinks-and-cli-naming fix/session-restore-race-condition \
  fix/gitignore-worktrees fix/docs-remove-ai-sdk-references fix/server-restart-cascade \
  fix/permission-hook-silent-deny fix/spa-fallback-and-404-page feat/worktree-support \
  feat/permission-mode-selector fix/worktree-toggle-visibility fix/popup-style-and-mutual-close \
  feat/mid-session-worktree fix/worktree-session-race fix/worktree-creation \
  fix/worktree-creation-robustness fix/worktree-git-env-pollution fix/worktree-session-cleanup \
  fix/skills-popup-overflow feat/worktree-auto-enable-setting feat/queue-messages-setting
```

---

## PR Hygiene

| PR# | Title | Author | Days Open | Review Decision | Conflicts | Stuck? |
|---|---|---|---|---|---|---|
| #131 | Add automated repo health report for 2026-03-14 | alari76 | 3 | None | MERGEABLE | ⚠️ Yes |

**PR #131 notes:**
- Created 2026-03-14 by automated workflow (Claude webhook). Content: a 306-line Markdown health report for the prior week.
- No reviewer assigned; no review decision.
- GitHub API reports `MERGEABLE` (no conflicts as of report generation).
- 3 days open exceeds the 7-day threshold partially, but given the high development velocity since 2026-03-14 (18 PRs merged), this is the only open item and is low-risk to merge or close.
- **Recommendation:** Merge directly (report is additive, no code changes) or close if superseded by the current report.

---

## Merge Conflict Forecast

| Branch | Commits Ahead | Commits Behind | Overlapping Files | Risk Level |
|---|---|---|---|---|
| `origin/chore/repo-health-report-2026-03-14` | 2 | 0 (GitHub reports MERGEABLE) | None — adds only `.codekin/reports/repo-health/` Markdown files | Low |
| `origin/codekin/reports` | 5 | 0 | `.codekin/reports/` subdirectories only — automated report commits | Low |

No active development branches diverged significantly from `main`. All feature branches from the recent sprint (2026-03-14 to 2026-03-17) have been merged. There is no high-risk overlap scenario.

---

## Recommendations

1. **Regenerate `package-lock.json`** *(High impact, 1 minute)*
   Run `npm install` to sync the lockfile with the current `package.json` after the removal of AI SDK dependencies in commit `e099d28`. The current lockfile contains ~15 orphaned `@ai-sdk/*` entries that will confuse future dependency audits and license scans.

2. **Delete 31 merged remote branches** *(Medium impact, 2 minutes)*
   All 31 feature/fix branches from the 2026-03-14 to 2026-03-17 sprint are merged but still present on the remote. Use the bulk delete command in the Stale Branches section. This will reduce `git fetch` noise and clarify which work is actually pending.

3. **Resolve PR #131** *(Low impact, 5 minutes)*
   The automated repo health report PR from 2026-03-14 has been open for 3 days with no reviewer. Either merge it (it's a read-only report addition, zero risk) or close it and track reports via the `codekin/reports` branch only. Pick a consistent strategy for automated reports.

4. **Update README.md to reflect AI SDK removal** *(Low impact, 10 minutes)*
   Two sections are stale: (a) the install wizard description still mentions prompting for Groq/OpenAI/Gemini/Anthropic API keys; (b) the configuration table still lists `GROQ_API_KEY`, `OPENAI_API_KEY`, and `GEMINI_API_KEY` as supported env vars. These keys are no longer consumed by the server after commit `e099d28`. Remove or update both sections.

5. **Audit `docs/API-REFERENCE.md` for worktree and settings additions** *(Medium impact, 30 minutes)*
   Three significant API surfaces were added in the 2026-03-16 sprint that may not be documented: (a) `Session` object worktree fields, (b) worktree creation/management endpoints (if any), (c) new `settings` keys `autoEnableWorktrees` and `queueMessages`. Cross-check the current `server/session-manager.ts` and `server/ws-server.ts` against the docs.

6. **Promote ESLint warn rules to error incrementally** *(Medium impact, ongoing)*
   The 14 `@typescript-eslint` type-safety rules currently at `warn` level (including `no-unsafe-assignment`, `no-unsafe-return`, `no-non-null-assertion`) represent meaningful safety gaps. The config file's own comment acknowledges they should be promoted. Consider tackling one rule per sprint: run `npx eslint --rule '{"@typescript-eslint/no-unsafe-assignment": "error"}' src/ server/`, fix the violations, and lock it in.

7. **Add a Prettier configuration** *(Low impact, 30 minutes)*
   The project has no Prettier config. As the codebase grows (currently 107 frontend + 64 server TypeScript files), formatting consistency will increasingly rely on reviewer discipline. Adding a minimal `.prettierrc` and `format` script prevents formatting drift in PRs without enforcing a strict style overhaul.

8. **Verify MPL-2.0 `lightningcss` is build-only** *(Low impact, 15 minutes)*
   Confirm that `lightningcss` (12 packages, MPL-2.0) is used only at build time by TailwindCSS and is not bundled into `dist/` or `server/dist/`. If build artifacts are inspected and `lightningcss` code is absent from the published npm package, the MPL-2.0 copyleft obligation does not apply to distributed code. Add a note to `package.json` `licenseNotes` similar to the existing `dompurify` note for audit traceability.

9. **Consider a branch-deletion CI/GitHub Action** *(Low impact, 1 hour)*
   With 454 commits in 30 days across dozens of short-lived branches, branch accumulation is a recurring housekeeping burden. GitHub's "Automatically delete head branches" repository setting (Settings → General → automatically delete head branches) would remove merged branches immediately upon PR merge, eliminating this entire category of maintenance.

10. **Track `session-manager.ts` complexity** *(Low impact, ongoing)*
    At 1,519 lines, `session-manager.ts` remains the largest single server file despite two classes being extracted. As worktree support adds more state management surface, consider extracting a `WorktreeManager` class in a future refactor sprint before the file grows further.