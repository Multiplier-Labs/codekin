# Repository Health Report — 2026-04-16

> **Scope:** Full housekeeping, documentation, and git hygiene assessment.
> **Branch assessed:** `main` (at commit `274298e`) + active remote branches.
> **Date:** 2026-04-16

---

## Summary

**Overall health: Good**

The codebase is in solid shape with strict TypeScript, comprehensive ESLint coverage, clean licensing, and zero TODO/FIXME debt in production code. The main concerns are a handful of unused exports in `orchestrator-learning.ts` and two frontend utility files, a TypeScript version mismatch between root and server workspaces, a clutch of 7 stale-ish ESLint `warn` rules flagged for future promotion, an accumulation branch (`codekin/reports`) that is severely diverged from `main`, and a growing queue of open docs/report PRs with no reviews.

| Category | Status | Detail |
|---|---|---|
| Dead code items | 8 | Unused exports in `orchestrator-learning`, `ccApi`, `workflowApi`, `workflowHelpers` |
| Stale TODOs | 0 | No TODO/FIXME/HACK/XXX in production source |
| Config issues | 3 | TS version mismatch, 7 `warn`→`error` promotions pending, no Prettier |
| License concerns | 0 | All dependencies MIT/ISC/Apache/BSD |
| Doc drift items | 2 | Debug lifecycle logs in `main`, open docs PRs accumulating |
| Stale branches | 1 | `codekin/reports` (69 ahead, 473 behind main) |
| Stuck PRs (>7 days) | 0 | All 7 open PRs are 1–4 days old |

---

## Dead Code

### Unused Exports

| File | Export | Type | Recommendation |
|---|---|---|---|
| `server/orchestrator-learning.ts` | `findDuplicate` | Unused export (function) | Remove or add caller; no references outside defining file |
| `server/orchestrator-learning.ts` | `getSkillLevel` | Unused export (function) | Remove or add caller; no references outside defining file |
| `server/orchestrator-learning.ts` | `saveSkillProfile` | Unused export (function) | Remove or add caller; `loadSkillProfile` is called but save is not |
| `src/lib/ccApi.ts` | `HealthCheckDetail` | Unused export (type) | Remove type export; type appears unused by any component |
| `src/lib/workflowApi.ts` | `RunStatus` | Unused export (type) | Internal type; remove export if not part of public API |
| `src/lib/workflowApi.ts` | `StepStatus` | Unused export (type) | Internal type; remove export if not part of public API |
| `src/lib/workflowHelpers.ts` | `EVENT_DRIVEN_KINDS` | Unused export (const) | No importers found; remove or use in `workflowApi` filtering |
| `src/lib/workflowHelpers.ts` | `biweeklyDay` | Unused export (function) | No importers found; likely superseded by newer frequency logic |

### Unreachable Functions

No unreachable private functions were detected in a spot-check of high-complexity modules.

### Orphan Files

`server/vitest.config.ts` is excluded from the server `tsconfig.json` and not imported by any module — this is intentional (vitest's own config pickup); not a concern.

`server/ws-server.ts` is the main server entry point. The import-chain check correctly shows 0 *inbound* imports — it is the root, not an orphan.

---

## TODO/FIXME Tracker

A full scan of `src/` and `server/` (all `.ts`/`.tsx` files, excluding `node_modules`) found **zero** `TODO`, `FIXME`, `HACK`, `XXX`, or `WORKAROUND` comments in production source code. The only matches were inside test assertion strings (e.g. `expect(summarizeToolInput('Grep', { pattern: 'TODO' }))`).

| Type | Count | Stale (>30 days) |
|---|---|---|
| TODO | 0 | 0 |
| FIXME | 0 | 0 |
| HACK | 0 | 0 |
| XXX | 0 | 0 |
| WORKAROUND | 0 | 0 |
| **Total** | **0** | **0** |

**Notable observation:** Debug lifecycle logging committed in PR #406 (`debug: add lifecycle logging to diagnose first-message-lost bug`) — including `console.log` calls tagged `[startClaude]`, `[sendInput]`, `[onSystemInit]`, and `[setModel]` — was merged to `main` as a diagnostic measure. The associated bug fix (PR #407) did not remove this logging. These are not `TODO` comments, but they represent temporary diagnostic code that has lingered. See **Recommendations** §1.

---

## Config Drift

### TypeScript Version Mismatch

| Config file | Setting | Current value | Recommended |
|---|---|---|---|
| `package.json` (root/frontend) | `devDependencies.typescript` | `"^6.0.2"` | Align with server |
| `server/package.json` | `devDependencies.typescript` | `"~5.9.3"` | Upgrade to `^6.0.2` or pin both to same major |

**Risk:** The frontend and server TypeScript compilers are on different major versions. This can cause inconsistent `tsc` behavior, different lib types, and unexpected compile errors during upgrades.

### ESLint: `warn` Rules Scheduled for Promotion

The ESLint config (`eslint.config.js`) includes an explicit comment: *"These should be promoted to errors as the codebase is cleaned up."* Seven rules are currently `warn` in both the `src/` and `server/` rule sets:

| Rule | Current | Target |
|---|---|---|
| `@typescript-eslint/restrict-template-expressions` | `warn` | `error` |
| `@typescript-eslint/no-confusing-void-expression` | `warn` | `error` |
| `@typescript-eslint/no-unnecessary-condition` | `warn` | `error` |
| `@typescript-eslint/no-base-to-string` | `warn` | `error` |
| `@typescript-eslint/no-non-null-assertion` | `warn` | `error` |
| `@typescript-eslint/no-misused-promises` | `warn` | `error` |
| `@typescript-eslint/use-unknown-in-catch-callback-variable` | `warn` | `error` |
| `@typescript-eslint/require-await` | `warn` | `error` |

The recent chore (#410) already promoted all `no-unsafe-*` rules to `error`. Promoting the remaining `warn` rules incrementally would further harden CI gates.

### ESLint: Test Files Use Relaxed Config

| Config file | Setting | Current | Recommended |
|---|---|---|---|
| `eslint.config.js` (test glob) | `extends` | `tseslint.configs.recommended` | Consider `strictTypeChecked` with targeted overrides |

Test files currently opt out of `strictTypeChecked` entirely. While `@typescript-eslint/no-explicit-any: off` is reasonable for test stubs, using `recommended` loses several useful safety rules in test code.

### Missing Prettier Config

No `.prettierrc`, `prettier.config.*`, or `prettier` key in `package.json` was found. Code style is enforced by TSC and ESLint only. Not a blocking issue, but adding a Prettier config would prevent whitespace/formatting churn in PRs.

---

## License Compliance

**Project license:** MIT

All production and dev dependencies use permissively compatible licenses. The project's `package.json` includes explicit notes for the two borderline cases.

| License | Count |
|---|---|
| MIT | 100 |
| ISC | 7 |
| Apache-2.0 | 2 |
| BSD-3-Clause | 2 |
| (MIT OR WTFPL) | 1 |
| (BSD-2-Clause OR MIT OR Apache-2.0) | 1 |
| **Total** | **113** |

**Flagged for awareness (not blocking):**

- **`dompurify`** — Dual-licensed MPL-2.0 OR Apache-2.0. The `package.json` `licenseNotes` field correctly documents that library use under Apache-2.0 is permissively compatible with MIT. No action required.
- **`lightningcss`** — MPL-2.0, used by TailwindCSS at build time only (not distributed in output artifacts). The `licenseNotes` field documents this. No action required.

No GPL, AGPL, or LGPL dependencies detected.

---

## Documentation Freshness

### API Docs vs Recent Code Changes

`docs/API-REFERENCE.md` covers the primary REST endpoints and was last meaningfully updated to reflect the session-lifecycle overhaul and orchestrator API changes. Recent feature additions that may warrant doc updates:

| Area | Last Code Change | Doc Status |
|---|---|---|
| GitHub webhook auto-setup (`feat: auto-setup GitHub webhook`, PR #391) | 2026-04-12 | `docs/GITHUB-WEBHOOKS-SPEC.md` last updated ~Apr 5; PR #414 (merged Apr 15 via `docs/cleanup-apr15`) may have addressed this — confirm post-merge |
| PR Review webhook (`docs/PR-REVIEW-WEBHOOK.md`) | Code: Apr 12 | Branch `docs/cleanup-apr15` touched this file; merged Apr 15 via PR #414 |
| ProcessCoordinator (`feat: unified ProcessCoordinator`, PR #404) | 2026-04-13 | No dedicated doc section; `stream-json-protocol.md` may be implicitly stale |
| Debug lifecycle logs (`debug: add lifecycle logging`, PR #406) | 2026-04-13 | Not documented — intentional (temporary code), but creates noise for contributors reading the source |

### README Drift

The project README (`README.md`) is end-user focused and does **not** expose `npm run dev` or other dev commands — those live in `CONTRIBUTING.md`. No drift found between the two.

**CONTRIBUTING.md verification:**
- `npm install --prefix server` — `server/package.json` exists; command is valid ✓
- `npm run dev` — present in root `package.json` as `"vite"` ✓
- Environment variable table — matches `server/config.ts` exports ✓
- No stale paths or removed commands detected

**Minor finding:** CONTRIBUTING.md references `server/config.ts` for env vars but does not mention `CODEKIN_AGENT_NAME` in its variable table, even though it is a documented export and configurable at runtime. Low severity.

---

## Draft Changelog

### v0.6.4 (since v0.6.3 tag, 2026-04-12 to 2026-04-16)

#### Features
- **Unified ProcessCoordinator** for session lifecycle management — single entry point for `startClaude`, `stopClaude`, and restart logic across the session state machine (#404)
- **Auto-setup GitHub webhook** for PR Review workflows — wizard now configures the webhook automatically during workflow creation (#391)

#### Fixes
- Prevent spurious model reconfigure when a model is first assigned to a new session (#407)
- Harden docs browser root scope and persist canonical paths to prevent path traversal edge cases (#409)
- Widen Edit Workflow modal to prevent day-label clipping on narrow viewports (#408)
- Unify workflow report commit/push across Markdown and Stepflow systems (#398)
- Add API rate-limiter map cap and attachment file-size limit (#397)
- Harden path traversal, trust-proxy, and image-src allowlist (#394)
- Improve Edit Workflow modal layout: two-column design, frequency highlights, day grid, model default (#393, #401, #403, #405)
- Address GPT review feedback on report commit robustness (#400)

#### Chores
- Enforce strict `@typescript-eslint/no-unsafe-*` rules across the full codebase; promote all five `no-unsafe-*` rules from `warn` to `error` (#410)
- Release v0.6.3 (#388 tag)

#### Documentation
- Weekly repo health report and accumulated audit reports (2026-04-15) (#413)
- Session initiation audit report (#399)
- Session restart root-cause audit (#402)
- Test coverage report 2026-04-13 (#396)
- Repo health report 2026-04-13 (#395)
- Daily code-review report 2026-04-12 (#392)
- PR code-review audit 2026-04-12 (#390)
- Audit report for PR #373 GitHub webhook health checks (#374)
- Docs cleanup: features, webhook specs, PR review spec, workflows doc (Apr 15) (PR #414)

---

## Stale Branches

All detected remote branches have activity within the last 6 days. None are older than 30 days. The only branch warranting immediate action is `codekin/reports`, which has diverged severely from `main` and appears to serve as an accumulation buffer for automated report commits.

| Branch | Last Commit | Author | Merged into main? | Recommendation |
|---|---|---|---|---|
| `origin/codekin/reports` | 2026-04-15 | alari | No (69 ahead, 473 behind) | Investigate purpose; if it's an automated accumulation branch, document it. If superseded by the PR-based report flow, delete it. |
| `origin/test/coverage-gaps-apr10` | 2026-04-10 | Claude (Webhook) | No (no open PR found) | Verify work was incorporated; delete if abandoned |
| `origin/feat/connection-status-popup` | 2026-04-11 | alari | No (no open PR found) | Verify work was merged via squash under different name; delete if done |
| `origin/feat/pr-373-audit-report` | 2026-04-12 | alari | No (open PR #374) | Merge or close PR #374 |
| `origin/feat/daily-code-review-2026-04-12` | 2026-04-12 | alari | No (open PR #392) | Merge or close PR #392 |
| `origin/chore/pr-audit-2026-04-12` | 2026-04-12 | alari | No (open PR #390) | Merge or close PR #390 |
| `origin/feat/repo-health-2026-04-13` | 2026-04-13 | alari | No (open PR #395) | Merge or close PR #395 |
| `origin/feat/test-coverage-2026-04-13` | 2026-04-13 | alari | No (open PR #396) | Merge or close PR #396 |
| `origin/docs/session-restart-audit` | 2026-04-15 | alari | No (open PR #402) | Merge or close PR #402 |
| `origin/refactor/app-decompose-hooks` | 2026-04-15 | alari | Yes (merged PR #416) | Delete remote branch |
| `origin/refactor/split-orchestrator-routes` | 2026-04-15 | alari | Yes (merged PR #415) | Delete remote branch |
| `origin/docs/cleanup-apr15` | 2026-04-15 | alari | Yes (merged PR #414) | Delete remote branch |

---

## PR Hygiene

All 7 open PRs are docs/audit-report submissions. None have received any review activity. None exceed the 7-day "stuck" threshold yet, but 6 of them are 3–4 days old with no movement.

| PR # | Title | Author | Days Open | Review Status | Conflicts | Stuck? |
|---|---|---|---|---|---|---|
| #413 | docs: weekly repo health report + accumulated audit reports (2026-04-15) | alari76 | 1 | No review | Unknown | No |
| #402 | docs: session restart root cause audit | alari76 | 3 | No review | Unknown | No |
| #396 | docs: test coverage report 2026-04-13 | alari76 | 3 | No review | Unknown | No |
| #395 | docs: repo health report 2026-04-13 | alari76 | 3 | No review | Unknown | No |
| #392 | docs: add daily code review report for 2026-04-12 | alari76 | 4 | No review | Unknown | No |
| #390 | docs: PR code review audit (2026-04-12, last 7 merged) | alari76 | 4 | No review | Unknown | No |
| #374 | docs: Add audit report for PR #373 | alari76 | 4 | No review | Unknown | No |

**Pattern note:** The repo has a recurring workflow that auto-generates report PRs. These are accumulating without a clear merge cadence. Consider either auto-merging docs-only PRs via a CI rule, or batching them into a single weekly docs PR to reduce open-PR noise.

---

## Merge Conflict Forecast

Branches with commits in the last 14 days that have not yet merged into `main`:

| Branch | Commits Ahead | Commits Behind | Files Modified on Branch | Overlapping with Main Changes | Risk |
|---|---|---|---|---|---|
| `origin/docs/session-restart-audit` | 1 | 4 | `.codekin/reports/` (docs only) | No source overlaps | Low |
| `origin/feat/repo-health-2026-04-15` | 1 | 4 | `.codekin/reports/` (docs only) | No source overlaps | Low |
| `origin/codekin/reports` | 69 | 473 | `.codekin/reports/` (accumulation) | Potential report file name collisions | Medium — file-level conflicts possible if same report dates were generated on main and on branch |

Branches already merged (remote refs not yet cleaned up): `refactor/app-decompose-hooks`, `refactor/split-orchestrator-routes`, `docs/cleanup-apr15`.

**No high-risk source code conflicts detected.** All active unmerged branches touch only docs/reports directories or are already merged.

---

## Recommendations

1. **Remove debug lifecycle logs from `main`** *(High impact, Low effort)*
   Commit #406 added `console.log` calls tagged `[startClaude]`, `[sendInput]`, `[onSystemInit]`, and `[setModel]` to `server/session-lifecycle.ts` and `server/session-manager.ts`. These were diagnostic aids for the first-message-lost bug. PR #407 fixed the bug but did not remove the logs. They now pollute server stdout in production. Strip them in a clean-up commit.

2. **Remove three unused exports from `server/orchestrator-learning.ts`** *(Medium impact, Low effort)*
   `findDuplicate`, `getSkillLevel`, and `saveSkillProfile` are exported but have no callers in any production module. Either add callers or remove the exports to reduce the public surface and avoid confusion. `saveSkillProfile` is particularly suspicious given `loadSkillProfile` has callers — a missing call site may indicate a logic gap.

3. **Align TypeScript versions across workspaces** *(Medium impact, Low effort)*
   Root `package.json` pins `typescript@^6.0.2`; `server/package.json` pins `~5.9.3`. Upgrade the server to `^6.0.x` (or a matching `~6.0.x` pin) so both workspaces compile with the same compiler. This prevents subtle type differences and simplifies upgrade coordination.

4. **Promote ESLint `warn` rules to `error` incrementally** *(Medium impact, Medium effort)*
   Eight rules are explicitly marked as "should be promoted to errors". The recent `no-unsafe-*` promotion (PR #410) demonstrates the pattern works. Tackle `@typescript-eslint/no-non-null-assertion` and `@typescript-eslint/no-misused-promises` next — they catch real runtime bugs and the codebase likely has few remaining violations after recent cleanups.

5. **Merge or close the 7 open docs PRs** *(Medium impact, Low effort)*
   Six docs/report PRs are 3–4 days old with zero reviews. These are automated outputs. Establish a policy: either merge them on creation (or via auto-merge if CI passes) or close them in favour of a weekly batch. The current accumulation creates open-PR noise and makes it harder to spot real work-in-progress PRs.

6. **Investigate and clean up `origin/codekin/reports` branch** *(Medium impact, Low effort)*
   This branch is 473 commits behind `main` and 69 ahead — it has likely drifted beyond usefulness as a merge target. If it serves as an automated report accumulation buffer (separate from the PR-based flow), document this intent. If it is superseded, delete it.

7. **Delete stale remote branches for merged work** *(Low impact, Low effort)*
   `origin/refactor/app-decompose-hooks`, `origin/refactor/split-orchestrator-routes`, and `origin/docs/cleanup-apr15` all have merged PRs but their remote refs were not deleted. Run `git push origin --delete <branch>` for each. Also confirm `feat/connection-status-popup` and `test/coverage-gaps-apr10` are accounted for (no open PRs found; verify the work landed under a different branch name).

8. **Remove 5 unused frontend exports** *(Low impact, Low effort)*
   `HealthCheckDetail` (ccApi), `RunStatus` and `StepStatus` (workflowApi), `EVENT_DRIVEN_KINDS` and `biweeklyDay` (workflowHelpers) are exported but have no importers. With `noUnusedLocals: true` in tsconfig, these survive only because they are explicitly `export`ed. Remove the `export` keyword (or the symbols entirely if they are truly dead).

9. **Add a Prettier configuration** *(Low impact, Low effort)*
   The project has no formatting config. Adding a minimal `.prettierrc` (e.g., `{ "singleQuote": true, "semi": false }`) and a `format` script would prevent formatting drift in PRs and align with the existing single-quote, no-semicolon style visible throughout the codebase.

10. **Add `CODEKIN_AGENT_NAME` to CONTRIBUTING.md environment variable table** *(Low impact, Low effort)*
    The `CODEKIN_AGENT_NAME` env var is exported from `config.ts` and documented in code comments but is absent from CONTRIBUTING.md's env var table. A one-line addition would make it discoverable for contributors.
