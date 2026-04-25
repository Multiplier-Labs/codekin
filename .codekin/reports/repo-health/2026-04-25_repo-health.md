# Repository Health Report — 2026-04-25

**Project:** Codekin  
**Branch assessed:** `docs/audit-reports-2026-04-18` (current) / `main` (baseline)  
**Assessment date:** 2026-04-25  
**Version at tip of main:** v0.6.3 (tag 2026-04-12)

---

## Summary

**Overall Health: Good**

The codebase is actively maintained with strict TypeScript enforcement, zero technical-debt comments, clean dependency licenses, and current documentation. The main concerns are a growing PR backlog (7 open docs PRs with no reviews), one critically diverged long-running branch (`codekin/reports`), and a moderate accumulation of exported symbols in server modules that appear to have no callers.

| Metric | Value |
|--------|-------|
| Dead code findings | ~30 exported symbols across 11 files |
| Stale TODOs / FIXMEs | **0** |
| Config issues | 2 minor |
| License concerns | **0** |
| Doc drift items | 2 cosmetic |
| Stale branches (>30 days inactive) | **0** |
| Open PRs | 13 |
| Stuck PRs (>7 days, no review) | 7 |
| Critically diverged branches | 1 (`codekin/reports`) |

---

## Dead Code

The following exported symbols could not be found imported anywhere in the project. Many are in server modules that may be pre-built for future use; each should be reviewed before removal.

| File | Export / Function | Type | Recommendation |
|------|------------------|------|----------------|
| `server/orchestrator-learning.ts` | `extractMemoryCandidates`, `findDuplicate`, `smartUpsert`, `recordFindingOutcome`, `getTriageRecommendation` (+9 more) | Unused export | Review: likely a work-in-progress module. Remove or wire up to a caller. |
| `server/webhook-github-setup.ts` | `_setGhRunner`, `_resetGhRunner`, `listRepoWebhooks`, `findCodekinWebhook`, `getWebhookDeliveries`, `createRepoWebhook`, `updateRepoWebhook`, `pingWebhook`, `previewWebhookSetup` | Unused export | Review: webhook setup utilities. If superseded by the auto-setup flow, remove. |
| `server/diff-manager.ts` | `execGit`, `execGitChunked`, `getFileStatuses` | Unused export | Review: git helpers not imported elsewhere. Remove if unused. |
| `server/native-permissions.ts` | `readNativePermissions`, `removeNativePermission` | Unused export | Review: permission helpers with no apparent callers. |
| `server/orchestrator-children.ts` | `ChildSessionRequest`, `ChildStatus`, `ChildSession`, `AGENT_CHILD_ALLOWED_TOOLS` | Unused export | Review: types and constants not imported; confirm they are used only at runtime. |
| `server/orchestrator-reports.ts` | `ReportMeta`, `ReportContent`, `getLatestReport` | Unused export | Review: report helpers not imported outside this module. |
| `server/stepflow-types.ts` | `StepflowWebhookPayload`, `StepflowSessionResult`, `StepflowEventStatus`, `StepflowEvent`, `StepflowConfig` | Unused export | Review: type definitions for Stepflow integration — confirm all are still needed. |
| `src/lib/ccApi.ts` | `listSessions`, `createSession`, `renameSession`, `deleteSession`, `setQueueMessages`, `getWorktreePrefix`, `setWorktreePrefix`, `setAgentName` (+others) | Unused export | Review: REST API wrapper functions. Verify which are called from tests or external scripts. |
| `src/lib/workflowApi.ts` | `listRuns`, `triggerRun`, `cancelRun`, `listSchedules`, `triggerSchedule`, `getConfig` (+others) | Unused export | Review: workflow API wrappers. Check if used in compiled artifacts. |
| `src/lib/workflowHelpers.ts` | `WORKFLOW_KINDS`, `EVENT_DRIVEN_KINDS`, `DAY_PRESETS`, `EVENT_CRON`, `slugify` (+others) | Unused export | Review: utility constants and helpers. Some may be used via barrel imports. |
| `src/types.ts` | `RepoManifest`, `PROVIDERS` | Unused export | Review: `PROVIDERS` may be used at runtime via index access; `RepoManifest` may be a stale type. |

**Orphan files:** None detected. All source files in `src/` and `server/` are reachable from entry points.

**Unreachable internal functions:** No confirmed unreachable private functions. A few closures in `server/prompt-router.ts` (wrappedResolve) and `server/workflow-loader.ts` (repoName) warrant manual inspection.

---

## TODO/FIXME Tracker

No actionable TODO, FIXME, HACK, XXX, or WORKAROUND comments were found in production source code. Strict TypeScript enforcement (`noUnusedLocals`, `noUnusedParameters`) and the team's development discipline prevent accumulation of debt markers.

The only keyword occurrences in the codebase are literal test-string arguments in `server/claude-process.test.ts` and `server/opencode-process.test.ts` (mock Grep tool calls).

| Metric | Count |
|--------|-------|
| Total TODO/FIXME/HACK/XXX/WORKAROUND | 0 |
| Stale (>30 days) | 0 |

---

## Config Drift

| Config File | Setting | Current Value | Recommended Value | Severity |
|-------------|---------|---------------|-------------------|----------|
| `server/tsconfig.json` | `esModuleInterop` | `true` | `false` | Minor — `esModuleInterop` is redundant and potentially conflicting when `module` is `"NodeNext"`. Node.js native ESM handles interop without this flag. |
| `package.json` | `engines` field | _(absent)_ | `{ "node": ">=18.0.0" }` | Minor — the server uses `module: "NodeNext"` and ESM-only syntax; an explicit engine constraint prevents accidental use on older Node. |
| (all configs) | `.editorconfig` | _(absent)_ | Add basic `.editorconfig` | Informational — Prettier handles formatting, but `.editorconfig` is useful for editors that run before Prettier. |

All other config files (`tsconfig.app.json`, `tsconfig.node.json`, `eslint.config.js`, `.prettierrc`) are well-configured and current. TypeScript 6.0.2, ESLint 10.1.0, and `typescript-eslint` 8.58.0 are all at latest versions.

---

## License Compliance

**Project license:** MIT

All 37 audited dependencies use permissive licenses. No GPL, AGPL, LGPL, or copyleft dependencies detected.

| License | Count | Dependencies |
|---------|-------|-------------|
| MIT | 34 | `better-sqlite3`, `express`, `multer`, `ws`, `react`, `react-dom`, `vite`, `vitest`, `eslint`, `tailwindcss`, `cmdk`, `marked`, `marked-highlight`, `react-markdown`, `remark-gfm`, `react-diff-view`, `refractor`, `@tabler/icons-react`, and 16 more |
| Apache-2.0 | 1 | `typescript` |
| BSD-3-Clause | 1 | `highlight.js` |
| MPL-2.0 OR Apache-2.0 | 1 | `dompurify` (dual-licensed; both options are permissive for library use) |
| **Total** | **37** | |

**Flagged dependencies:** None. `dompurify`'s MPL-2.0 option is permissive for library use and does not trigger copyleft requirements in this context.

---

## Documentation Freshness

**Overall status: Fresh** — documentation has been actively maintained, with audit-driven fixes applied on 2026-04-15 and 2026-04-22.

### README Drift

No functional drift found. All verified:

| README Item | Actual State | Status |
|-------------|-------------|--------|
| `npm run dev`, `npm test`, `npm run build`, `npm run lint`, `npm run test:watch` | All present in `package.json` | ✓ Match |
| `src/components/`, `src/hooks/`, `server/`, `docs/` | All directories exist | ✓ Match |
| Port 32352, `REPOS_ROOT`, `DATA_DIR`, `AUTH_TOKEN` env vars | All match server code | ✓ Match |
| WebSocket protocol description | Matches `docs/stream-json-protocol.md` | ✓ Match |

### API Documentation Freshness

`src/types.ts` was cross-referenced against `docs/API-REFERENCE.md`. Message types, permission modes, and provider/model lists are aligned. The Claude models array (`CLAUDE_MODELS`) correctly includes Opus 4.7 (added 2026-04-17) and matches the API reference.

### Identified Drift (Minor)

| Location | Finding | Severity |
|----------|---------|----------|
| `docs/FEATURES.md` line ~330 | References "cc-web token" (legacy service name, now "Codekin") | Cosmetic |
| `docs/FEATURES.md` line ~399 (architecture diagram) | Uses "cc-web server" label; newer docs use "Codekin server" | Cosmetic |

### Documentation Gaps

- No `CHANGELOG.md` file in the repository root. Version history exists in git tags and commit messages but is not surfaced in a human-readable file.
- No upgrade/migration guide for users moving between major versions.

---

## Draft Changelog

### Period: 2026-04-18 – 2026-04-25 (since last audit; last tag v0.6.3 was 2026-04-12)

The `main` branch received only documentation and audit report commits this week. Active feature and fix work is in open PRs awaiting merge.

#### Documentation
- Add accumulated audit reports: repo health (2026-04-18 through 2026-04-24), code reviews, complexity analysis, docs audit, dependency health, test coverage reports (2026-04-18 – 2026-04-24)

#### Unreleased (open PRs, pending merge into main)

**Security**
- `#431` — Harden settings `repos-path` to enforce home/repos-root boundary (H1) and rate-limit child spawn (M5)

**Fixes**
- `#432` — Fix `hooksPath` resolution, schedule cron validation, CORS PATCH method support
- `#430` — Align server TypeScript version and widen ESLint server glob

**Documentation**
- `#433` — Document H1 + M5 security error responses in API reference
- `#429` — Address 2026-04-22 docs-audit findings

> **Note:** Items listed under "Unreleased" are in open PRs and have not yet been merged to `main`. Tag v0.6.4 would naturally include these fixes and the security hardening.

---

## Stale Branches

**No stale branches detected.** All 31 remote branches have received commits within the last 15 days (oldest: `origin/test/coverage-gaps-apr10` from 2026-04-10, 15 days ago).

The 30-day staleness threshold (2026-03-26) is not crossed by any branch.

| Branch | Last Commit | Author | Merged to main? | Note |
|--------|------------|--------|-----------------|------|
| `origin/test/coverage-gaps-apr10` | 2026-04-10 | Claude (Webhook) | No | 15 days old; consider merging or closing |
| `origin/feat/connection-status-popup` | 2026-04-11 | alari | No | 14 days old; open PR #346 merged this feature; branch may be stale |
| `origin/feat/pr-373-audit-report` | 2026-04-12 | alari | No | 13 days old; associated PR closed? |
| `origin/chore/pr-audit-2026-04-12` | 2026-04-12 | alari | No | 13 days old |
| `origin/feat/daily-code-review-2026-04-12` | 2026-04-12 | alari | No | 13 days old |

The above branches are approaching staleness (10–15 days) and should be reviewed: merge, close, or delete if already superseded.

The only branch confirmed merged into `origin/main` is `origin/fix/symlink-bypass-spawn`.

---

## PR Hygiene

13 open pull requests, all authored by `alari76`. **No review decisions** have been recorded on any PR, consistent with a single-maintainer workflow. PRs appear to serve as a tracking mechanism rather than a collaborative review process.

| PR# | Title | Author | Days Open | Review Status | Stuck? |
|-----|-------|--------|-----------|---------------|--------|
| #433 | docs: document H1 + M5 security error responses | alari76 | 1 | No review | No |
| #432 | fix: hooksPath resolution, schedule cron validation, CORS PATCH | alari76 | 2 | No review | No |
| #431 | security: harden settings repos-path and rate-limit child spawn | alari76 | 2 | No review | No |
| #430 | chore: align server TS version and widen ESLint server glob | alari76 | 2 | No review | No |
| #429 | docs: address 2026-04-22 docs-audit findings | alari76 | 3 | No review | No |
| #422 | docs: add accumulated audit reports (2026-04-16 – 2026-04-18) | alari76 | 7 | No review | Borderline |
| #413 | docs: weekly repo health report + accumulated audit reports (2026-04-15) | alari76 | 10 | No review | **Yes** |
| #402 | docs: session restart root cause audit | alari76 | 12 | No review | **Yes** |
| #396 | docs: test coverage report 2026-04-13 | alari76 | 12 | No review | **Yes** |
| #395 | docs: repo health report 2026-04-13 | alari76 | 12 | No review | **Yes** |
| #392 | docs: add daily code review report 2026-04-12 | alari76 | 13 | No review | **Yes** |
| #390 | docs: PR code review audit 2026-04-12 | alari76 | 13 | No review | **Yes** |
| #374 | docs: add audit report for PR #373 | alari76 | 13 | No review | **Yes** |

**Observation:** All 7 stuck PRs are documentation/audit-report PRs. In a single-maintainer project this is expected, but the backlog is accumulating. Consider either auto-merging audit report PRs via CI or batching them into weekly merge commits.

---

## Merge Conflict Forecast

Active branches assessed against `origin/main` for divergence and overlapping file changes.

| Branch | Commits Ahead | Commits Behind | Overlapping Files with Main | Risk |
|--------|--------------|---------------|----------------------------|------|
| `origin/fix/code-review-2026-04-23` | 1 | 0 | None | **Low** |
| `origin/security/audit-2026-04-23-fixes` | 2 | 0 | None | **Low** |
| `origin/chore/eslint-glob-and-ts-align` | 1 | 0 | None | **Low** |
| `origin/docs/audit-2026-04-22-updates` | 1 | 0 | None | **Low** |
| `origin/docs/api-ref-h1-m5-errors` | 1 | 0 | None | **Low** |
| `origin/docs/audit-reports-2026-04-18` | 11 | 6 | None detected | **Medium** — 6 commits behind main; growing divergence risk if main continues to advance |
| `origin/codekin/reports` | 93 | 485 | `.codekin/reports/code-review/2026-03-15_*.md` through `2026-03-20_*.md` and others | **High** — massively diverged; 485 commits behind main. Direct merge would be very complex. |

**`codekin/reports` is the only high-risk branch.** It appears to be a long-running accumulation branch for automated reports that has diverged severely from main (93 commits ahead, 485 behind). A clean resolution strategy (rebase or cherry-pick only the report additions) is strongly recommended before this branch grows further.

---

## Recommendations

1. **Resolve the `codekin/reports` divergence** *(High impact)*  
   This branch is 485 commits behind `main` with overlapping `.codekin/reports/` paths. Rebase or recreate it from `main`, cherry-picking only the report commits. Alternatively, abandon the branch and fold its content into `docs/audit-reports-2026-04-18` (which already carries the same reports).

2. **Merge or close the 7 stuck docs PRs** *(High impact)*  
   PRs #374, #390, #392, #395, #396, #402, and #413 are all docs-only and have been open 10–13 days. In a single-maintainer workflow, consider configuring CI to auto-merge docs PRs on green, or adopting a policy of committing audit reports directly to a dedicated branch and opening one batched weekly PR.

3. **Audit and clean `server/orchestrator-learning.ts`** *(Medium impact)*  
   This module exports ~14 functions that appear to have no callers. If it is pre-built infrastructure for an upcoming feature, add a comment explaining its status. If it is dead code, remove it to reduce maintenance surface.

4. **Fix `esModuleInterop: true` in `server/tsconfig.json`** *(Low impact)*  
   Remove this flag — it conflicts with `module: "NodeNext"` semantics and is unnecessary in modern Node.js ESM. This is a clean, low-risk change.

5. **Add `"engines": { "node": ">=18.0.0" }` to `package.json`** *(Low impact)*  
   The server requires Node.js 18+ for ESM and `crypto.randomUUID()`. An explicit engine constraint will surface incompatibilities early in CI.

6. **Review and prune `server/webhook-github-setup.ts` exports** *(Medium impact)*  
   Nine exported functions (webhook CRUD helpers) appear unused now that the auto-setup flow exists. Confirm which are still exercised; remove the rest to reduce the module's scope.

7. **Delete branches already superseded** *(Low impact)*  
   `origin/feat/connection-status-popup`, `origin/test/coverage-gaps-apr10`, `origin/feat/pr-373-audit-report`, and `origin/chore/pr-audit-2026-04-12` are 13–15 days old and unmerged. Verify whether their content landed via other means; if so, delete them to keep the branch list clean.

8. **Fix legacy "cc-web" terminology in `docs/FEATURES.md`** *(Low impact)*  
   Two architecture references still use the old service name. Standardise on "Codekin server" / "Codekin backend" for consistency with the rest of the documentation.

9. **Add a `CHANGELOG.md` file** *(Low impact)*  
   Version history is only in git tags and commit messages. A maintained `CHANGELOG.md` (even generated from conventional commits) would improve release communication, especially given the rapid pace of fixes and the growing user base.

10. **Audit `src/lib/ccApi.ts` and `src/lib/workflowApi.ts` for unused functions** *(Medium impact)*  
    Several REST wrapper functions appear to have no callers within the frontend source. Confirm whether they are used from external tooling, tests, or compiled artifacts; remove any that are genuinely dead to shrink the public API surface.
