# Repository Health: codekin

**Date**: 2026-06-14T03:20:07.398Z
**Repository**: /srv/repos/Multiplier-Labs/codekin
**Branch**: main
**Workflow Run**: eff6ee8d-d540-4b4c-86da-4af2860fe532
**Session**: 4df07576-cfcb-492d-b1e7-c35b4cab3bd4

---

---

# Codekin Repository Health Assessment
**Date:** 2026-06-14 | **Branch:** main | **Version:** 0.7.0

---

## Summary

**Overall Health: Good**

The codebase is in solid shape: TypeScript strict mode is consistently applied, no real TODO/FIXME technical debt exists in source files, and the dependency license posture is clean with only minor MPL-2.0 annotations already handled in `package.json`. The primary areas needing attention are (1) **documentation drift** — `docs/API-REFERENCE.md` does not yet cover the Codex provider, the child transcript endpoint, or the Fable 5 model added in the last 30 days; (2) a growing **stale branch backlog** of 40 branches (mostly automated audit branches) with no clear cleanup policy; and (3) several ESLint rules intentionally demoted to `warn` that should be graduated to `error` incrementally.

| Metric | Count | Status |
|---|---|---|
| Dead code items (confirmed) | 0 | ✅ |
| Stale TODOs / FIXMEs in source | 0 | ✅ |
| Config issues | 3 (minor) | ⚠️ |
| License concerns | 2 (noted, mitigated) | ⚠️ |
| Doc drift items | 4 | ⚠️ |
| Stale remote branches | 40 | ⚠️ |
| Stuck PRs | 0 | ✅ |
| Open PRs | 0 | ✅ |

---

## Dead Code

TypeScript strict mode (`noUnusedLocals`, `noUnusedParameters`) is enforced across all tsconfig targets. No unused locals or parameters would survive a production build. Manual inspection of exported symbols cross-referenced against import sites confirms all public exports are consumed.

| File | Export / Function | Type | Recommendation |
|---|---|---|---|
| — | — | — | No dead code detected. All exported components, hooks, and utilities have confirmed import sites. |

**Notes:**
- `NewSessionButton` (imported in `LeftSidebar.tsx:19`) — active.
- `TimePicker` (imported in `EditWorkflowModal.tsx`, `AddWorkflowModal.tsx`) — active.
- `ModuleBrowser` (imported in `LeftSidebar.tsx:22`) — active.
- `DocsFilePicker` (imported in `RepoSection.tsx:17`) — active.
- All `src/components/workflows/*` sub-components are imported by `WorkflowsView.tsx` or `AddWorkflowModal.tsx`.

---

## TODO/FIXME Tracker

A full scan of `src/` and `server/` for `TODO`, `FIXME`, `HACK`, `XXX`, and `WORKAROUND` was performed.

| file:line | type | comment | author | date | stale? |
|---|---|---|---|---|---|
| server/opencode-process.test.ts:860 | (test fixture) | `pattern: 'TODO'` — grep pattern string in test, not a comment | — | — | N/A |
| server/claude-process.test.ts:60–61, 838 | (test fixture) | `pattern: 'TODO'` — grep pattern string in test, not a comment | — | — | N/A |

**Summary:**
- Total real TODO/FIXME comments in production source: **0**
- Test fixture occurrences (not actionable comments): 4 lines across 2 test files
- Stale items (>30 days): **0**

The codebase is clean of technical-debt markers in source code. This is consistent with a team that resolves issues before committing.

---

## Config Drift

### tsconfig (tsconfig.app.json, tsconfig.node.json, server/tsconfig.json)

| Config File | Setting | Current Value | Recommendation |
|---|---|---|---|
| `tsconfig.app.json` | `strict` | `true` | ✅ Good |
| `tsconfig.app.json` | `noUnusedLocals` / `noUnusedParameters` | `true` | ✅ Good |
| `tsconfig.app.json` | `noImplicitReturns` | `true` | ✅ Good |
| `tsconfig.app.json` | `target` | `ES2023` | ✅ Appropriate for modern browsers |
| `server/tsconfig.json` | `target` | `ES2022` | ✅ Good for Node.js LTS |
| `tsconfig.node.json` | `lib` | `["ES2023"]` — DOM types absent | ✅ Correct for Vite config context |
| `tsconfig.app.json` | `erasableSyntaxOnly` | `true` | ✅ TypeScript 5.5+ best practice |
| `server/tsconfig.json` | `include` | `["*.ts"]` — only root-level files | ⚠️ Does not recursively include subdirectories; works only because server files are flat, but may silently exclude future nested files |

**Finding 1 — server/tsconfig.json include scope:** `"include": ["*.ts"]` matches only files in the `server/` root, not any future subdirectories. Best practice is `["**/*.ts"]` (excluding `node_modules` and `dist`). Currently harmless since the server is flat, but worth tightening.

### ESLint (eslint.config.js)

| Setting | Current Value | Recommendation |
|---|---|---|
| `@typescript-eslint/restrict-template-expressions` | `warn` | Should graduate to `error` as code is cleaned up. Comment in config acknowledges this. |
| `@typescript-eslint/no-unnecessary-condition` | `warn` | Graduate to `error`. |
| `@typescript-eslint/no-non-null-assertion` | `warn` | Graduate to `error` once non-null assertions are audited. |
| `@typescript-eslint/no-misused-promises` | `warn` | Graduate to `error`. |
| `@typescript-eslint/use-unknown-in-catch-callback-variable` | `warn` | Graduate to `error`. |
| `@typescript-eslint/require-await` | `warn` | Graduate to `error`. |
| Test files: `@typescript-eslint/no-explicit-any` | `off` | Acceptable for test files. |
| `ecmaVersion` in ESLint | `2022` | Minor mismatch: tsconfig targets ES2023. Could align to `2023` but not a functional issue. |

**Finding 2 — 8 rules demoted to `warn`:** The config explicitly documents these as "pre-existing patterns" to be promoted incrementally. The comment is good hygiene, but there is no tracked issue or milestone for graduation. Recommend creating a tracking issue.

**Finding 3 — Server tests excluded from strict type-checked config:** Test files use `tseslint.configs.recommended` (not `strictTypeChecked`). This is intentional and reasonable, but means type safety in test mocks can silently diverge from production types. The existing `@typescript-eslint/no-explicit-any: off` setting is a known trade-off.

### Prettier (.prettierrc)

| Setting | Value | Notes |
|---|---|---|
| `semi` | `false` | ✅ Consistent with modern TS style |
| `singleQuote` | `true` | ✅ |
| `trailingComma` | `"all"` | ✅ |
| `printWidth` | `120` | Wider than default (80), acceptable for a monospace-heavy UI codebase. |
| `tabWidth` | `2` | ✅ |

No significant Prettier drift. Config is consistent and appropriate.

---

## License Compliance

The project is MIT licensed. All runtime and build-time dependencies were audited from `package-lock.json`.

### License Summary Table

| License | Dependency Count | Permissive? |
|---|---|---|
| MIT | 472 | ✅ Yes |
| ISC | 23 | ✅ Yes |
| Apache-2.0 | 18 | ✅ Yes |
| MPL-2.0 | 12 | ⚠️ Weak copyleft (see below) |
| BSD-3-Clause | 9 | ✅ Yes |
| BSD-2-Clause | 8 | ✅ Yes |
| BlueOak-1.0.0 | 4 | ✅ Yes (permissive) |
| MIT-0 | 2 | ✅ Yes |
| CC0-1.0 | 1 | ✅ Public domain |
| CC-BY-4.0 | 1 | ✅ (docs-only) |
| (MPL-2.0 OR Apache-2.0) | 1 | ✅ Dual-licensed; Apache-2.0 applies |
| (MIT OR WTFPL) | 1 | ✅ MIT applies |
| (BSD-2-Clause OR MIT OR Apache-2.0) | 1 | ✅ MIT applies |
| 0BSD | 1 | ✅ Yes |
| **Missing license metadata** | 2 | ⚠️ See below |

### Flagged Dependencies

| Package | License | Concern | Mitigation |
|---|---|---|---|
| `lightningcss` (+ 12 platform targets) | MPL-2.0 | Weak copyleft; source modifications must be shared | Build-time only (used by TailwindCSS v4). Not distributed in output artifacts. Explicitly noted in `package.json` `licenseNotes`. **No action required.** |
| `dompurify` | MPL-2.0 OR Apache-2.0 | MPL-2.0 component | Dual-licensed; Apache-2.0 is permissive. Noted in `package.json` `licenseNotes`. **No action required.** |
| `busboy` | No `license` field in lock file | Missing metadata | Transitive dep of `multer`. Public GitHub repo confirms MIT license. Low risk; consider adding `overrides` entry or NOTICE if distributing. |
| `streamsearch` | No `license` field in lock file | Missing metadata | Transitive dep of `busboy`. MIT license confirmed in source. Low risk. |

**Overall:** The license posture is clean and well-documented. The MPL-2.0 items are correctly identified as build-time-only in `package.json`. No GPL, AGPL, or LGPL dependencies detected.

---

## Documentation Freshness

### API Docs Drift

`docs/API-REFERENCE.md` was last updated on **2026-06-03** (commit `7e257e0`). Multiple server-side features merged since then are not yet reflected:

| Changed Item | PR / Date | Documented? | File to Update |
|---|---|---|---|
| **Codex provider** (`CodingProvider = 'claude' \| 'opencode' \| 'codex'`) | #499, 2026-06-11 | ❌ Missing | `docs/API-REFERENCE.md` — Models section has no Codex mention or `CODEX_MODELS` table |
| **`GET /api/orchestrator/children/:id/transcript`** endpoint | #505, 2026-06-11 | ❌ Missing | `docs/API-REFERENCE.md` — Orchestrator section lists children CRUD but not transcript |
| **`claude-fable-5`** model ID | #492, 2026-06-11 | ❌ Missing | `docs/API-REFERENCE.md` — Models table omits Fable 5 |
| **`codexAvailable` / `codexAuthenticated`** fields in `connected` WS message | #499, 2026-06-11 | ❌ Missing | `docs/API-REFERENCE.md` — WS connection message schema not updated |
| `ORCHESTRATOR-SPEC.md` — agent resilience features (outbox, child timeouts, completion verification) | #498–505, 2026-06-11 | ❌ Partial | `docs/ORCHESTRATOR-SPEC.md` last updated 2026-04-25 |
| `stream-json-protocol.md` | No changes since 2026-04-08 | ✅ No API changes affect it | — |

### README Drift

The README was updated in PR #512 (2026-06-13) and accurately reflects the current feature set including Codex, OpenCode, and Agent Joe. All install steps, scripts, and feature bullets match `package.json` and current code.

One minor drift item in **CONTRIBUTING.md**:

| File | Line | Issue |
|---|---|---|
| `CONTRIBUTING.md` | 24 | `npm install --prefix server` — instructs installing server deps separately. `server/package.json` does exist, so this step remains valid, but since the root `package.json` also includes server deps as `dependencies` (express, ws, etc.), a new contributor may be confused about which install applies where. A clarifying note would help. |

---

## Draft Changelog

**Period:** 2026-06-07 to 2026-06-14 (since last tag `v0.6.x`, the active development window before `v0.7.0`)

> **Note:** All 19 commits in the 7-day window were merged on 2026-06-11–2026-06-13 as part of the v0.7.0 release.

---

### v0.7.0 — 2026-06-13

#### Features
- **Compact new-session dropdown** (#509): Replaced per-provider "New Session" buttons in the left sidebar with a single compact dropdown selector — reduces UI clutter when multiple providers are configured.
- **OpenAI Codex CLI provider** (#499): Added Codex as a third coding-agent backend. Supports `codex app-server` JSON-RPC subprocess protocol, full streaming, tool events, and permission control; requires `codex login`.
- **Agent Joe — Realtime blocked-child notifications** (#498): Orchestrator now emits live notifications when a managed child session is blocked waiting for approval.
- **Agent Joe — Persistent notification outbox with replay** (#501): Notification outbox persists across orchestrator sessions; replays missed notifications on reconnect.
- **Agent Joe — Pausable child timeouts and worktree status** (#503): Child session timeouts are now pausable; worktree status is surfaced in the orchestrator UI.
- **Agent Joe — Ground-truth child completion verification** (#504): Completion detection now verifies against actual process exit state rather than keyword-sniffing transcripts.
- **Agent Joe — Template fixes, child transcript endpoint, org-aware repo discovery** (#505): Added `GET /api/orchestrator/children/:id/transcript`; org repos are now auto-discovered from `GH_ORG` config.
- **Claude Fable 5 model support** (#492): `claude-fable-5` added to the model selector.
- **OpenCode resilience** (#500): Resume hydration, restart recovery, mid-turn message queueing, diff detection, and version check.
- **OpenCode runtime improvements** (#496): Abort, compact, usage reporting, recovery, and subagent support.
- **Dynamic Claude model discovery** (#479, earlier): New models surface automatically without code changes.

#### Fixes
- **Reliable todo panel updates** (#511): Todo panel now updates correctly and closes when work stops.
- **Dark-mode form controls and gold-button contrast** (#510): Resolved colour-contrast regressions in dark mode introduced by the palette audit.
- **Plan-mode permission lifecycle** (#502): Plan-approval flow now correctly updates `permissionMode`; read-only operations are auto-approved; skills list refreshes on session join.
- **UI style audit recommendations** (#508): Prose sizing, contrast ratios, and colour palette aligned to audit findings.

#### Documentation
- **Codex, OpenCode, and Agent Joe documentation** (#512): README and feature docs updated to reflect all new providers and agent capabilities.
- **UI style and colour scheme audit report** (#507): Audit report committed to `.codekin/reports/`.

#### Chores
- **Release v0.7.0** (#513): Version bump and changelog update.

---

## Stale Branches

Branches with no commit activity since **2026-05-14** (30 days before today). The cutoff for "active" is 2026-05-15.

A total of **40 stale branches** were identified. They fall into three categories:

**Category A — Automated audit branches (never merged by design):** These `audit/*` branches were created by the scheduled workflow runner to hold report files. They accumulate indefinitely since there is no cleanup policy.

**Category B — Feature/fix branches with merged content:** Work landed via squash/rebase; the source branch was not deleted.

**Category C — Stale feature branches (unmerged, abandoned):** Require review to determine disposition.

### Selected stale branches (representative sample)

| Branch | Last Commit | Author | Merged into main? | Recommendation |
|---|---|---|---|---|
| `origin/fix/security-validation-2026-04-30` | 2026-05-01 | alari76 | ✅ YES | **Delete** |
| `origin/fix/security-validation-followup-2026-04-30` | 2026-05-01 | alari76 | ✅ YES | **Delete** |
| `origin/fix/clone-test-timeout` | 2026-05-15 | Claude (Webhook) | ❌ NO | Review — CI fix that may have been superseded |
| `origin/audit/comment-assessment.daily-2026-05-08` | 2026-05-08 | alari | ❌ NO | **Archive/Delete** — report branch, not for merging |
| `origin/audit/security-audit.weekly-2026-05-07` | 2026-05-07 | alari | ❌ NO | **Archive/Delete** — report branch |
| `origin/audit/complexity.weekly-2026-05-06` | 2026-05-06 | alari | ❌ NO | **Archive/Delete** — report branch |
| `origin/audit/docs-audit.weekly-2026-05-06` | 2026-05-06 | alari | ❌ NO | **Archive/Delete** — report branch |
| `origin/audit/dependency-health.daily-2026-05-05` | 2026-05-05 | alari | ❌ NO | **Archive/Delete** — report branch |
| `origin/audit/repo-health.weekly-2026-05-04` | 2026-05-04 | alari | ❌ NO | **Archive/Delete** — report branch |
| `origin/audit/code-review.daily-2026-05-04` | 2026-05-04 | alari | ❌ NO | **Archive/Delete** — report branch |
| `origin/chore/reports-2026-05-02` | 2026-05-02 | alari | ❌ NO | Review / delete |
| `origin/docs/audit-reports-2026-04-18` | 2026-04-30 | alari | ❌ NO | Review / delete |
| `origin/fix/security-commit-event-sanitization-2026-04-30` | 2026-04-30 | alari | ❌ NO | Review — security fix; verify content landed in main |
| `origin/fix/ci-lint-errors-and-stale-mock-2026-04-27` | 2026-04-27 | Claude (Webhook) | ❌ NO | Likely superseded by later lint fixes; delete |
| `origin/chore/release-0.6.4` | 2026-04-27 | Claude (Webhook) | ❌ NO | Old release branch; **delete** |
| `origin/feat/connection-status-popup` | 2026-04-11 | alari | ❌ NO | Feature landed differently or abandoned; review |
| `origin/test/coverage-gaps-apr10` | 2026-04-10 | Claude (Webhook) | ❌ NO | Old coverage work; coverage improvements landed since; **delete** |
| `origin/docs/session-restart-audit` | 2026-04-15 | alari | ❌ NO | Audit doc; review if content is in main |
| `origin/feat/repo-health-2026-04-13` | 2026-04-13 | alari | ❌ NO | Report branch; delete |

**~30 additional `audit/*` and `feat/*` branches** from 2026-04-28 to 2026-05-08 follow the same pattern.

**Key finding:** The automated workflow creates a new branch per report run but never deletes old ones. After ~6 weeks of daily/weekly runs, 30+ orphaned audit branches have accumulated. A `git push origin --delete` sweep or a post-run cleanup step in the workflow is needed.

---

## PR Hygiene

`gh pr list` returned **0 open pull requests**. All recent work was merged before this assessment.

| PR# | Title | Author | Days Open | Review Status | Conflicts? | Stuck? |
|---|---|---|---|---|---|---|
| — | No open PRs | — | — | — | — | — |

**Status: Clean.** No stuck or stale PRs to address.

---

## Merge Conflict Forecast

Active branches (commits in last 14 days, i.e., since 2026-05-31):

| Branch | Ahead of main | Behind main | Modified files | Conflict Risk |
|---|---|---|---|---|
| `origin/chore/release-v0.7.0` | 1 | 1 | Version bump files only | **Low** — Release branch; 1 commit behind (post-release commit). Safe to delete once v0.7.0 is confirmed shipped. |
| `origin/fix/clone-test-ci-timeout` | 1 | 12 | `server/upload-routes.test.ts` | **Medium** — 12 commits behind main; upload routes have seen significant changes (org discovery #505). May have conflicts. |
| `origin/docs/claude-code-integration-assessment` | 1 | 20 | `.codekin/reports/code-review/2026-06-11_claude-code-integration-assessment.md` | **Low** — Doc/report file only; no production code overlap. |
| `origin/docs/agent-joe-resilience-audit` | 1 | 20 | `.codekin/reports/` (report file) | **Low** — Report file only. |
| `origin/codekin/reports` | 120 | 575 | Multiple (120 report commits) | **High** — 575 commits behind main; has diverged significantly from main. This branch appears to be the automated reports accumulation branch. It will have merge conflicts with virtually any file touched by the 575 main-branch commits. Consider archiving rather than attempting to merge. |

**Highest Risk:** `origin/codekin/reports` at 575 commits behind main. This branch should be treated as a historical archive and not rebased or merged forward.

---

## Recommendations

Ordered by impact:

1. **Update `docs/API-REFERENCE.md` to reflect v0.7.0 additions** *(High impact — developer DX)*
   Add the Codex provider section (including `CODEX_MODELS`), the `GET /api/orchestrator/children/:id/transcript` endpoint, the `claude-fable-5` model entry, and the new `codexAvailable`/`codexAuthenticated` fields in the WebSocket `connected` message. This doc is 11 days behind the code as of today.

2. **Implement audit-branch cleanup in the workflow runner** *(High impact — repo hygiene)*
   The automated scheduler creates a new branch per audit run and never deletes old ones; 30+ stale `audit/*` branches have accumulated since May. Add a post-run step to delete the branch after merging the report commit to main (or use a single long-lived `codekin/reports` branch that is force-updated, rather than per-run branches).

3. **Delete confirmed-merged and clearly superseded stale branches** *(Medium impact — repo hygiene)*
   Immediate candidates for deletion: `origin/fix/security-validation-2026-04-30`, `origin/fix/security-validation-followup-2026-04-30` (both confirmed merged), `origin/chore/release-0.6.4`, `origin/test/coverage-gaps-apr10`, `origin/chore/release-v0.7.0`. For the remaining 35+, a team review pass would identify which feature branches have landed and which are truly abandoned.

4. **Update `docs/ORCHESTRATOR-SPEC.md` for Agent Joe v2 resilience features** *(Medium impact — developer DX)*
   The spec was last updated 2026-04-25. The five Joe PRs (#498, #501, #503, #504, #505) introduced: a persistent notification outbox, pausable timeouts, ground-truth completion verification, and the transcript API. None of these are reflected in the spec.

5. **Graduate demoted ESLint warnings to errors in a clean-up PR** *(Medium impact — code quality)*
   Eight `@typescript-eslint` rules are currently `warn` due to "pre-existing patterns." The comment in `eslint.config.js` acknowledges this is temporary. Opening a tracking issue and scheduling a quarterly graduation pass will prevent these from becoming permanently tolerated issues. Priority candidates: `no-non-null-assertion`, `no-unnecessary-condition`, `no-misused-promises`.

6. **Review and resolve `origin/fix/clone-test-ci-timeout`** *(Medium impact — CI reliability)*
   This branch is 12 commits behind main and touches `server/upload-routes.test.ts`, which has seen significant changes. Rebase it against main or close it if the CI issue it was fixing has been resolved another way.

7. **Add `busboy` and `streamsearch` license acknowledgements** *(Low impact — compliance hygiene)*
   These two transitive dependencies of `multer` are missing `license` fields in `package-lock.json`. Both are MIT. Add them to the `licenseNotes` in `package.json` or raise with the multer maintainers to ensure the lock file is accurate on next `npm install`.

8. **Tighten `server/tsconfig.json` include pattern** *(Low impact — forward compatibility)*
   Change `"include": ["*.ts"]` to `"include": ["**/*.ts"]` so the TypeScript project correctly covers any future subdirectories under `server/`. Currently harmless since the server is flat, but a pre-emptive fix prevents silent exclusions.

9. **Clarify CONTRIBUTING.md dual-install step** *(Low impact — contributor DX)*
   Add a note explaining that `npm install` at the root installs shared runtime deps, while `npm install --prefix server` installs server-only deps and is required before running or building the server. A brief explanation of why the server has a separate `package.json` would reduce contributor confusion.

10. **Archive or retire `origin/codekin/reports`** *(Low impact — repo hygiene)*
    At 575 commits behind main and 120 ahead, this branch is unrecoverable as a merge candidate. If its report history is needed, tag it for reference (`refs/archive/codekin-reports-2026-06`) and delete the tracking branch to avoid it appearing in everyday `git branch -r` output.