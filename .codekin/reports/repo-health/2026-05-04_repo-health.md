# Repository Health: codekin

**Date**: 2026-05-04T03:19:01.217Z
**Repository**: /srv/repos/codekin
**Branch**: main
**Workflow Run**: d820c42b-8bc3-4b85-8816-0f2cbb5ebddc
**Session**: 9a16b8c5-2869-4c85-888f-031b3eb5a3ba

---

Now I have enough data to write the full report.

---

# Codekin Repository Health Report — 2026-05-04

---

## Summary

**Overall Health: Good**

The codebase is actively maintained with a high commit velocity and strong TypeScript hygiene. No TODO/FIXME comments exist in production source. Config tooling is modern and well-configured. The primary areas needing attention are: (1) several feature/fix branches from April that appear abandoned and unmerged, (2) 15 automated audit branches with no remote deletions accumulating over time, (3) circuit-breaker and quiet-mode features shipped in the last 7 days lack API-level documentation updates, and (4) MPL-2.0 transitive dependencies (`lightningcss`) warrant a brief legal note.

| Metric | Value |
|---|---|
| Dead code items | 0 confirmed orphans; 0 unused exports detected |
| Stale TODO/FIXME | 0 |
| Config issues | 2 minor (prettier not wired to lint; server tsconfig excludes subdirs) |
| License concerns | 13 MPL-2.0 packages; 2 packages with missing license metadata |
| Doc drift items | 3 (circuit-breaker, quiet mode, headless session cap undocumented) |
| Stale/abandoned branches | 8 candidate branches (22–24 days, likely squash-merged) |
| Stuck PRs | 0 |

---

## Dead Code

No orphaned source files or definitively unused exports were detected. All checked hooks and library files are imported by at least one consumer:

| File | Symbol | Import Count | Notes |
|---|---|---|---|
| `src/hooks/useErrorNotification.ts` | `useErrorNotification` | 1 | Single consumer — low risk |
| `src/hooks/useTentativeQueue.ts` | `useTentativeQueue` | 2 | Active |
| `src/lib/deriveActivityLabel.ts` | `deriveActivityLabel` | 1 | Single consumer — low risk |
| `src/lib/hljs.ts` | hljs config | 2 | Active |
| `src/lib/slashCommands.ts` | slash command helpers | 7 | Active |

No orphan files found. The TypeScript compiler enforces `noUnusedLocals` and `noUnusedParameters` in all configs, which structurally prevents dead local symbols from accumulating.

> **Note:** `server/tsconfig.json` uses `"include": ["*.ts"]` (root-level glob only). Server subdirectories (if any are ever added) would be silently excluded from compilation. Currently all server source lives at the root level so this is not an active problem, but worth monitoring.

---

## TODO/FIXME Tracker

A full scan of `src/` and `server/` (excluding `node_modules`) found **zero** TODO, FIXME, HACK, XXX, or WORKAROUND comments in production source code. The only matches were in test files where the string `"TODO"` was used as a grep pattern value in test assertions — not as an annotation.

| Type | Count |
|---|---|
| TODO | 0 |
| FIXME | 0 |
| HACK | 0 |
| XXX | 0 |
| WORKAROUND | 0 |
| **Stale items (>30 days)** | **0** |

**Summary:** Clean. The TSC strict-mode + lint setup appears to drive issues to resolution rather than annotation accumulation.

---

## Config Drift

### `tsconfig.app.json` (Frontend)

| Setting | Current Value | Assessment |
|---|---|---|
| `strict` | `true` | ✅ Correct |
| `noUnusedLocals` | `true` | ✅ Correct |
| `noUnusedParameters` | `true` | ✅ Correct |
| `noImplicitReturns` | `true` | ✅ Correct |
| `noFallthroughCasesInSwitch` | `true` | ✅ Correct |
| `target` | `ES2023` | ✅ Modern |
| `erasableSyntaxOnly` | `true` | ✅ Correct for TS 5.5+ |

### `server/tsconfig.json`

| Setting | Current Value | Assessment |
|---|---|---|
| `strict` | `true` | ✅ Correct |
| `noUnusedLocals` | `true` | ✅ Correct |
| `include` | `["*.ts"]` | ⚠️ Root-level only; subdirectory `.ts` files would be excluded if added |
| `composite` | `true` | ✅ Correct for project references |

### `eslint.config.js`

| Finding | Detail | Recommendation |
|---|---|---|
| Several type-safety rules demoted to `warn` | `@typescript-eslint/no-confusing-void-expression`, `no-unnecessary-condition`, `no-non-null-assertion`, `no-misused-promises`, `require-await`, `use-unknown-in-catch-callback-variable` — all `warn` in both frontend and server configs | Promote to `error` incrementally as the comment in the config already notes |
| Test config uses `tseslint.configs.recommended` | Production and server configs use the stricter `strictTypeChecked` | Acceptable but means test code has looser checking |
| `@typescript-eslint/no-explicit-any: off` in tests | Test files allow `any` freely | Low risk for tests; acceptable |

### `.prettierrc`

Prettier is configured but **no prettier-related check script exists in `package.json`** (`npm run lint` only runs ESLint). There is no `format` or `prettier:check` script, meaning formatting consistency is not enforced in CI.

| Finding | Recommendation |
|---|---|
| No `prettier --check` in CI/scripts | Add `"format:check": "prettier --check ."` to `package.json` scripts |

---

## License Compliance

Project license: **MIT**

### Summary Table

| License | Dependency Count |
|---|---|
| MIT | 312 |
| ISC | 18 |
| MPL-2.0 | 12 |
| BSD-3-Clause | 9 |
| Apache-2.0 | 8 |
| BSD-2-Clause | 8 |
| CC-BY-4.0 | 1 |
| CC0-1.0 | 1 |
| BlueOak-1.0.0 | 1 |
| 0BSD | 1 |
| (MIT OR WTFPL) | 1 |
| (MPL-2.0 OR Apache-2.0) | 1 |
| (BSD-2-Clause OR MIT OR Apache-2.0) | 1 |
| **MISSING/UNKNOWN** | **2** |

### Flagged: MPL-2.0 Packages (weak copyleft)

MPL-2.0 is a file-level weak copyleft license. It does **not** require the whole project to be open-sourced, but modifications to the MPL-licensed files themselves must be shared. For a bundled web app (where `lightningcss` is a build-time tool, not shipped in source form), the risk is low — but worth a legal review note.

| Package | License | Notes |
|---|---|---|
| `lightningcss` | MPL-2.0 | CSS transformer used by Tailwind/Vite; build-time only |
| `lightningcss-*` (12 platform binaries) | MPL-2.0 | Build-time native binaries |
| `dompurify` | MPL-2.0 OR Apache-2.0 | Runtime; dual-licensed — Apache-2.0 option is permissive |

### Flagged: Missing License Metadata

| Package | License in `package.json` | Notes |
|---|---|---|
| `busboy` | MISSING | Widely known MIT; metadata omitted from `package.json` |
| `streamsearch` | MISSING | Bundled with `busboy`; also MIT in practice |

**Recommendation:** `lightningcss` and `dompurify` pose no practical risk for an MIT app (`dompurify` can be treated as Apache-2.0). The two packages with missing metadata are MIT in practice. No action required, but noting for audit completeness.

---

## Documentation Freshness

### API Docs Drift (Last 30 Days)

Three behavioral changes shipped in the last 7 days that lack corresponding documentation updates in `docs/API-REFERENCE.md` or `docs/operations/`:

| Feature | Merged PR | Changed Behavior | Docs Updated? |
|---|---|---|---|
| Rate-limit circuit breaker (`overageStatus=rejected` only) | #470, #469, #468 | Circuit breaker now only trips on `rejected` responses, not all overages; notification text updated | ❌ No mention in API-REFERENCE or operations docs |
| Quiet mode default + headless session lifetime cap | #467, #468 | Server now defaults to quiet mode (no boot-time spawns); headless sessions capped in lifetime | ❌ Not documented in API-REFERENCE or SETUP |
| Dedup key rollback on `startRun` failure | #465 | Reliability fix for workflow runs | ❌ Not documented (minor internal) |

The `docs/operations/ws-rate-limit.md` file added in late April covers WS-level rate limiting but does not cover the application-level circuit breaker behavior.

### README Drift

README.md is end-user focused (install script, `codekin` CLI commands). It accurately reflects the current feature set and config variables (`PORT`, `REPOS_ROOT`). **No drift detected** in README.

### CONTRIBUTING.md Drift

CONTRIBUTING.md documents `npm install --prefix server` as a separate step. This remains accurate — `server/package.json` is separate with its own dependencies. The comment "Start the development server (frontend only)" next to `npm run dev` is accurate (Vite dev server only; the backend must be started separately). No drift detected.

### Docs Summary

| Document | Last Modified | Status |
|---|---|---|
| `docs/API-REFERENCE.md` | 2026-04-30 | ⚠️ Missing circuit-breaker and quiet-mode docs |
| `docs/FEATURES.md` | 2026-04-29 | ⚠️ Missing circuit-breaker and quiet-mode features |
| `docs/operations/ws-rate-limit.md` | 2026-04-29 | Partial — covers WS rate limiting, not app-level circuit breaker |
| `docs/INSTALL-DISTRIBUTION.md` | 2026-04-09 | May need update for new env vars (`TRUST_PROXY` documented in CONTRIBUTING but not here) |
| `README.md` | Current | ✅ Accurate |
| `CONTRIBUTING.md` | Current | ✅ Accurate |

---

## Draft Changelog

### v0.6.5 — 2026-05-04 (since v0.6.4 / last 7 days)

#### Features
- **Orchestrator notifications**: Parent sessions now receive immediate terminal notifications when a child session terminates, improving multi-agent workflow visibility. (#463, #462)

#### Fixes
- **Rate limiting**: Circuit breaker now only trips when `overageStatus=rejected`; previously fired on any overage response, causing unnecessary session interruptions. (#470)
- **Rate limit UX**: Notification messages are now honest about whether a session is in backoff vs. quota-exhausted state. (#469)
- **Headless session cap**: Headless sessions now have a maximum lifetime to prevent runaway resource usage; server defaults to quiet mode on startup (no boot-time Claude spawns or 15-minute monitor). (#468, #467)
- **Reliability**: Dedup key is rolled back on `startRun` failure, preventing workflows from becoming stuck in a dedup-locked state. GitHub org slug parser hardened. (#465)
- **Workflow branches**: Audit workflows now fork from `origin/main` and restore the main checkout after completion. (#461, #457)

#### Chores
- Bump version to 0.6.5. (#bump)
- Add `ecosystem.config.cjs.example` with interpreter pin for PM2 deployments. (#471)
- Add code-review and security audit reports for 2026-04-30. (#456)

---

## Stale Branches

All remote branches are dated from the last 30 days (earliest: April 10, 2026 = 24 days ago). No branch strictly exceeds the 30-day threshold as of 2026-05-04. However, several feature/fix branches from early-to-mid April show no unique commits relative to `origin/main` (0 ahead) and are 11 or more commits behind, indicating they were almost certainly squash-merged but their remote branches were not deleted.

### Candidate-for-Deletion Branches (Likely Already Merged via Squash)

| Branch | Last Commit Date | Author | Commits Ahead of main | Merged (fast-forward)? | Recommendation |
|---|---|---|---|---|---|
| `fix/security-validation-2026-04-30` | 2026-05-01 | alari76 | 0 | Not detected (likely squash) | Delete — 0 commits ahead of main |
| `fix/security-validation-followup-2026-04-30` | 2026-05-01 | alari76 | 0 | Not detected (likely squash) | Delete — 0 commits ahead of main |
| `feat/connection-status-popup` | 2026-04-11 | alari | — | Not detected | Review & delete if merged |
| `feat/daily-code-review-2026-04-12` | 2026-04-12 | alari | — | Not detected | Review & delete if merged |
| `feat/pr-373-audit-report` | 2026-04-12 | alari | — | Not detected | Review & delete if merged |
| `feat/repo-health-2026-04-13` | 2026-04-13 | alari | — | Not detected | Review & delete if merged |
| `feat/test-coverage-2026-04-13` | 2026-04-13 | alari | — | Not detected | Review & delete if merged |
| `test/coverage-gaps-apr10` | 2026-04-10 | Claude (Webhook) | — | Not detected | Review & delete if merged |

### Automated Audit Branches (15 total, none merged to main)

All 15 `audit/*` branches are automated report-only branches. They have never been merged into `main` via `git merge` (they are squash-merged or PR-merged). They accumulate at a rate of ~5/week. Consider configuring branch auto-deletion on PR merge, or a periodic cleanup script.

| Branch Category | Count | Oldest | Recommendation |
|---|---|---|---|
| `audit/code-review.daily-*` | 6 | 2026-04-28 | Auto-delete after PR merge |
| `audit/repo-health.weekly-*` | 5 | 2026-04-28 | Auto-delete after PR merge |
| `audit/security-audit.weekly-*` | 1 | 2026-04-30 | Auto-delete after PR merge |
| `audit/dependency-health.daily-*` | 1 | 2026-04-28 | Auto-delete after PR merge |
| `audit/complexity.weekly-*` | 1 | 2026-04-29 | Auto-delete after PR merge |
| `audit/comment-assessment.daily-*` | 1 | 2026-05-01 | Auto-delete after PR merge |

---

## PR Hygiene

One open PR detected:

| PR# | Title | Author | Days Open | Review Status | Conflicts | Stuck? |
|---|---|---|---|---|---|---|
| #464 | chore(reports): add code-review, comment, and repo-health reports for 2026-05-01 | alari76 | 2 | No review yet | None | No (2 days < 7-day threshold) |

**Summary:** PR pipeline is healthy. Only one open PR, which is a report-only chore PR opened 2 days ago with no conflicts. No stuck PRs detected.

---

## Merge Conflict Forecast

Two active branches were identified with recent commit activity relative to the review window. Both are **0 commits ahead of main**, meaning they contain no unique changes not already in `main`. They appear to be superseded branches from the security validation sprint.

| Branch | Commits Ahead of main | Commits Behind main | Overlapping Files | Conflict Risk |
|---|---|---|---|---|
| `fix/security-validation-2026-04-30` | 0 | 11 | N/A (no unique commits) | None — superseded |
| `fix/security-validation-followup-2026-04-30` | 0 | 11 | N/A (no unique commits) | None — superseded |

No active branch with unique commits was found to have high merge-conflict risk with `main`.

---

## Recommendations

1. **Document the rate-limit circuit breaker and quiet-mode defaults** *(High Impact — User-Facing)*
   Add a section to `docs/API-REFERENCE.md` and `docs/operations/` explaining: (a) circuit breaker behavior when `overageStatus=rejected`, (b) quiet mode as the new default startup behavior, (c) headless session lifetime cap. These are significant behavioral changes shipped in the last 7 days with no documentation counterpart.

2. **Delete superseded security-validation branches** *(Medium Impact — Hygiene)*
   `origin/fix/security-validation-2026-04-30` and `origin/fix/security-validation-followup-2026-04-30` are both 0 commits ahead of main and 11 behind. Run `git push origin --delete fix/security-validation-2026-04-30 fix/security-validation-followup-2026-04-30`.

3. **Enable branch auto-deletion on PR merge** *(Medium Impact — Hygiene)*
   The 15 accumulated `audit/*` branches and 8 other candidate-for-deletion feature branches will continue to grow. Enable "Automatically delete head branches" in the GitHub repository settings to prevent the accumulation.

4. **Promote ESLint warnings to errors incrementally** *(Medium Impact — Code Quality)*
   The ESLint config explicitly notes that `@typescript-eslint/no-non-null-assertion`, `no-misused-promises`, `no-unnecessary-condition`, and others are demoted to `warn` for "incremental adoption." With the codebase in good shape and active cleanup happening, begin converting these to `error` one rule at a time, starting with `no-non-null-assertion` and `no-misused-promises`.

5. **Add `prettier --check` to CI / `package.json` scripts** *(Low Impact — Developer Experience)*
   `.prettierrc` is configured but `npm run lint` only runs ESLint. Add `"format:check": "prettier --check ."` to `package.json` and consider running it in CI alongside lint to enforce consistent formatting.

6. **Fix `server/tsconfig.json` include glob** *(Low Impact — Future-Proofing)*
   `"include": ["*.ts"]` only matches root-level files. If server code is ever organized into subdirectories, those files will be silently excluded from type-checking. Change to `"include": ["**/*.ts"]` and verify no new errors surface.

7. **Review and clean up early-April feature branches** *(Low Impact — Hygiene)*
   The branches `feat/connection-status-popup`, `feat/daily-code-review-2026-04-12`, `feat/pr-373-audit-report`, `feat/repo-health-2026-04-13`, `feat/test-coverage-2026-04-13`, and `test/coverage-gaps-apr10` are 22–24 days old and not detected as merged (likely squash-merged). Verify against PRs and delete to reduce remote branch clutter.

8. **Update `docs/INSTALL-DISTRIBUTION.md` with `TRUST_PROXY` variable** *(Low Impact — Documentation)*
   `TRUST_PROXY` is documented in `CONTRIBUTING.md` and used in the WS rate-limiting documentation but is absent from `INSTALL-DISTRIBUTION.md`, which is the primary reference for operators deploying behind a reverse proxy — exactly the scenario where `TRUST_PROXY` is required.

9. **Clarify `dompurify` license selection** *(Low Impact — Legal Clarity)*
   `dompurify` is dual-licensed `MPL-2.0 OR Apache-2.0`. Since the project is MIT, it is best practice to explicitly elect the Apache-2.0 option in legal documentation or a `NOTICE` file to make clear that the permissive option is being used.

10. **Investigate `busboy`/`streamsearch` missing license metadata** *(Low Impact — Compliance)*
    Both packages lack a `license` field in their `package.json` but are MIT in practice. Confirm by checking the project source `LICENSE` files and document this exception in any internal license inventory.