# Repository Health: codekin

**Date**: 2026-05-02T03:22:30.378Z
**Repository**: /srv/repos/codekin
**Branch**: main
**Workflow Run**: c86398c8-6a83-4a14-8ac5-e0446c8b71d5
**Session**: ec1c62fc-deac-4f23-8d25-1400dd84ba5c

---

Now I have all the data I need. Let me compile the full report.

---

# Codekin Repository Health Report — 2026-05-02

**Repository**: `Multiplier-Labs/codekin` | **Version**: 0.6.3 | **Branch**: `main` | **Assessed**: 2026-05-02

---

## Summary

**Overall Health: Good**

The codebase is actively maintained, well-tested, and following modern TypeScript and ESLint best practices. The last 7 days saw heavy security hardening activity, orchestrator improvements, and automated audit report generation. No dead code, no stale TODOs, and no license concerns were found. The main areas to address are a minor tsconfig inconsistency between the app and server configs, two merged-but-not-deleted remote branches, and a handful of accumulated automated audit branches that could be cleaned up.

| Metric | Value |
|---|---|
| Dead code items | 0 |
| Stale TODOs/FIXMEs | 0 (0 total in production code) |
| Config issues | 2 minor (tsconfig target mismatch, missing `noImplicitReturns` in server) |
| License concerns | 0 (all deps permissively licensed) |
| Doc drift items | 0 significant (docs actively maintained) |
| Stale remote branches (>30 days) | 0 |
| Merged-but-not-deleted branches | 2 |
| Open PRs | 0 |
| Stuck PRs | 0 |

---

## Dead Code

No dead exports, unreachable functions, or orphan source files were detected. All 250+ exported symbols have confirmed importers. Every `.ts`/`.tsx` file in `src/` and `server/` participates in at least one import chain from a top-level entry point (`src/main.tsx`, `server/ws-server.ts`, or a test suite).

| File | Export / Function | Type | Recommendation |
|---|---|---|---|
| — | — | — | No items to report |

**Methodology note**: exports were cross-referenced against all `import` statements across both `src/` and `server/`. The three exports removed in commit `d9cd42e` (`chore: remove three unused exports`) confirm the team actively tracks this; no residual unused exports remain.

---

## TODO/FIXME Tracker

A full grep across all TypeScript, TSX, CSS, Markdown, and configuration files found **zero production-code annotations** of type `TODO`, `FIXME`, `HACK`, `XXX`, or `WORKAROUND`.

The only hits were:

| File:Line | Type | Comment | Notes |
|---|---|---|---|
| `server/claude-process.test.ts:60-61,809` | `TODO` (as string literal) | `summarizeToolInput('Grep', { pattern: 'TODO' })` | Test fixture input data, not an annotation |
| `server/opencode-process.test.ts:557` | `TODO` (as string literal) | `summarizeToolInput('grep', { pattern: 'TODO' })` | Test fixture input data, not an annotation |

**Summary**

| Type | Production count | Test-fixture count | Stale (>30 days) |
|---|---|---|---|
| TODO | 0 | 4 | 0 |
| FIXME | 0 | 0 | 0 |
| HACK | 0 | 0 | 0 |
| XXX | 0 | 0 | 0 |
| WORKAROUND | 0 | 0 | 0 |
| **Total** | **0** | **4** | **0** |

---

## Config Drift

### TypeScript

Three tsconfig files govern the project: `tsconfig.app.json` (frontend), `tsconfig.node.json` (Vite config), and `server/tsconfig.json` (backend).

| Config file | Setting | Current value | Recommended / Note |
|---|---|---|---|
| `tsconfig.app.json` | `target` | `ES2023` | Modern and appropriate for browser builds via Vite |
| `tsconfig.app.json` | `strict` | `true` | Correct |
| `tsconfig.app.json` | `noUnusedLocals` / `noUnusedParameters` | `true` / `true` | Correct — strict hygiene |
| `tsconfig.app.json` | `noImplicitReturns` | `true` | Correct |
| `tsconfig.app.json` | `erasableSyntaxOnly` | `true` | Correct for TypeScript 5.5+ / TS 6 |
| `server/tsconfig.json` | `target` | `ES2022` | Minor drift vs. `ES2023` in app config — no functional impact on Node.js 20+, but consider aligning to `ES2023` |
| `server/tsconfig.json` | `noImplicitReturns` | *(absent)* | Present in `tsconfig.app.json` but missing from server config; recommend adding for consistency |
| `server/tsconfig.json` | `noUncheckedSideEffectImports` | `true` | Correctly present |
| `tsconfig.node.json` | `noImplicitReturns` | `true` | Correct |

**Overall**: tsconfig configuration is strong across all three files. The two gaps above are minor and non-blocking.

### ESLint

`eslint.config.js` uses the modern flat-config format with `typescript-eslint`'s `strictTypeChecked` preset — the most rigorous available option.

| Setting | Status | Note |
|---|---|---|
| Flat config format | ✅ Used | Up-to-date; legacy `.eslintrc` format abandoned |
| `strictTypeChecked` | ✅ Used for prod code | Best-practice for strict TypeScript projects |
| Test files linting | ✅ Separate block | Uses relaxed `recommended` preset; `no-explicit-any` disabled — appropriate for mocks |
| `@typescript-eslint/no-floating-promises` | `error` | Correct — prevents silent async failures |
| `@typescript-eslint/no-unsafe-*` | All `error` | Correct — enforces type safety at the call boundary |
| `react-refresh` plugin | ✅ Present | Correct for Vite + React dev workflow |
| Server files excluded from React rules | ✅ Correct | Server block has no React plugins |
| `eslint-plugin-react-hooks` | `v7` | Current major version — no drift |

No issues found. Configuration is modern, thorough, and appropriate.

### Prettier

`.prettierrc` uses: `semi: false`, `singleQuote: true`, `trailingComma: all`, `printWidth: 120`, `tabWidth: 2`.

| Setting | Status | Note |
|---|---|---|
| `semi: false` | Consistent with ESLint | Standard in the React/Vite ecosystem |
| `printWidth: 120` | Slightly wide vs. 80/100 convention | Reasonable for a monospace terminal UI codebase; no change needed |
| `trailingComma: all` | Modern | ES2017+ compatible; correct for this target |

No issues found.

---

## License Compliance

Project license: **MIT**

### Dependency License Summary

| License | Count | Packages (representative) |
|---|---|---|
| MIT | ~85% | `express`, `ws`, `multer`, `better-sqlite3`, `marked`, `react`, `react-dom`, `tailwindcss`, `vite`, `vitest`, `cmdk`, `react-markdown`, `typescript-eslint`, and most others |
| BSD-3-Clause | ~5% | `highlight.js`, `refractor` |
| Apache-2.0 | ~5% | `typescript` |
| MPL-2.0 OR Apache-2.0 | 1 | `dompurify` (dual-licensed; either option is permissive and MIT-compatible) |
| MPL-2.0 | 1 | `lightningcss` (transitive, build-time only via TailwindCSS; not distributed in artifacts) |

### Flagged Items

None. All runtime dependencies are MIT or permissively licensed. The two MPL-2.0 items are correctly documented in `package.json`'s `licenseNotes` field:

> *"dompurify is dual-licensed (MPL-2.0 OR Apache-2.0); both are permissively compatible with MIT for library use. lightningcss (MPL-2.0) is a build-time-only dependency used by TailwindCSS and is not included in distributed artifacts."*

No GPL, AGPL, LGPL, SSPL, or copyleft-only licenses detected in direct or first-level transitive dependencies.

---

## Documentation Freshness

### API Docs and Spec Files

| Document | Last updated (git) | Assessment |
|---|---|---|
| `docs/API-REFERENCE.md` | 2026-04-28 (`fix: nested reports path, narrow CSP connect-src, and API docs drift #426`) | Current — updated alongside recent security hardening |
| `docs/ORCHESTRATOR-SPEC.md` | 2026-04-15 (`docs: cleanup docs for Apr 15 audit #414`) | Current — reflects Agent Joe orchestrator implemented in v0.5.0 |
| `docs/WORKFLOWS.md` | 2026-04-22 (`docs: address 2026-04-22 docs-audit findings #429`) | Current |
| `docs/GITHUB-WEBHOOKS-SPEC.md` | 2026-04-05 (`fix: repo cleanup — remove dead export, fix docs drift #300`) | Recent PR review webhook feature (#321, 2026-04-02) post-dates this by ~3 days; the webhook spec may need a refresh to fully document the `pull_request` event handler |
| `docs/INSTALL-DISTRIBUTION.md` | 2026-04-14 | Referenced in README; no drift signals detected |
| `docs/stream-json-protocol.md` | 2026-04-05 | Protocol docs updated per repo-health audit; likely current |
| `docs/operations/` | 2026-04-27 (`docs(ops): document workflow restart-resume and orphan-session handling`) | Current — actively extended |

### README Drift

Verified `README.md` against `package.json` scripts and directory structure:

| Claim in README | Actual state | Status |
|---|---|---|
| `npm run dev` | Defined in `package.json` as `vite` | ✅ Correct |
| `npm run build` | Defined as `tsc -b && vite build` | ✅ Correct |
| `npm test` | Defined as `vitest run` | ✅ Correct |
| `npm run lint` | Defined as `eslint .` | ✅ Correct |
| Port 32352 | Matches `server/` configuration constant | ✅ Correct |
| `REPOS_ROOT` env variable | Present in config table | ✅ Correct |
| References `docs/INSTALL-DISTRIBUTION.md` | File exists | ✅ Correct |
| References `CONTRIBUTING.md` | File exists | ✅ Correct |
| Screenshot at `docs/screenshot.png` | File exists (387 KB) | ✅ Correct |
| `codekin upgrade`, `codekin token`, etc. CLI commands | Implemented in `bin/codekin.mjs` | ✅ Correct |
| `CLAUDE.md` scripts table | Matches `package.json` (`test:watch` = `vitest`) | ✅ Correct |

No README drift detected. README was last updated 2026-04-11 (`docs: update changelog and README to feature OpenCode support #357`) and remains accurate.

**Minor observation**: `docs/GITHUB-WEBHOOKS-SPEC.md` may not fully document the `pull_request` event handler added in commit `24de04e` (2026-04-02). Recommend a targeted pass to add the PR review webhook section.

---

## Draft Changelog

Changes since **v0.6.4** tag (2026-04-27 through 2026-05-01):

### [Unreleased] — 2026-04-28 to 2026-05-01

#### Features
- **Orchestrator child-termination notification**: Parent session is now notified immediately when a child session terminates, with delivery confirmed via `terminalNotifiedAt` stamp (#463, #462)
- **Workflow engine restart/resume**: Workflow engine now supports resume from checkpoint after restart, with orphan session handling (#437)

#### Fixes
- **Security — commit-event prompt sanitization**: Sanitize all user-supplied input in commit-event handler to prevent prompt injection; remove duplicate report write (#455)
- **Security — commit-event repoPath validation**: Validate `repoPath` parameter and enforce `set_permission_mode` WebSocket check; align dependency versions (#454)
- **Security — clone destination canonicalization**: Canonicalize clone destination path to prevent symlink-escape attacks (C1) (#453)
- **Security — permissionMode runtime validation**: Validate `permissionMode` value at session creation time, not just at the type level (#452)
- **Security — cron/path/PATCH hardening**: Address cron DoS vector, path traversal in workflow routes, dedup scoping, and PATCH method validation (#449)
- **Workflow — audit branch forking**: Fork audit branches from `origin/main` instead of local HEAD; restore main checkout after (#461, #457)
- **Workflow — single output path per run**: Each audit now writes to a single deterministic output path; each run creates a fresh branch (#441)
- **WS rate-limit window**: Roll the rate-limit window at the boundary, not after it fires (W5) (#438)
- **Upload routes — realpathSync guard**: Guard `realpathSync` in clone route against symlink attacks (W4) (#438)
- **WS server — Origin header enforcement**: Require `Origin` header in production WebSocket handshake (W3) (#438)
- **Commit hooks cleanup**: Clean up hooks for fully-removed repos to prevent stale hook state (W2) (#438)
- **Workflow routes — cron step=0 rejection**: Reject cron expressions with a step value of `0` (W1) (#438)
- **Passive-repo alert suppression**: Silence passive-repo alert for repos with no enabled workflows (#436)
- **WS rate-limit bypass fix**: Fix WS rate-limit bypass path; add `gh` call timeouts (#435)

#### Tests
- Comprehensive server coverage gaps filled: `stepflow-prompt`, `session-persistence`, `version-check`, `webhook-handler-base`, `tool-labels`, `orchestrator-learning-router`, `orchestrator-routes`, `webhook-routes`, `commit-event-handler`, `error-page` (#440)

#### Documentation
- Document workflow restart-resume and orphan-session handling (`docs/operations/`) (#439)
- Document WebSocket rate limiting parameters (#439)
- Document H1 + M5 security error responses (#433)

#### Chores
- Bump `marked` from v17 to v18.0.2 (#450)
- Bump `@multiplier-labs/stepflow` to 0.3.4 (#445)
- Repo-health cleanup: remove orphaned `dist/`, stale WS docs, unused tsconfig (#451)
- Remove three unused exports (#434)

---

## Stale Branches

No remote branches have been inactive for more than 30 days. All branches visible in `refs/remotes/origin` have at least one commit dated 2026-04-27 or later (within 5 days of the assessment date).

**Merged-but-not-deleted branches** (candidates for immediate cleanup):

| Branch | Last commit date | Author | Merged into main? | Recommendation |
|---|---|---|---|---|
| `origin/fix/security-validation-2026-04-30` | 2026-05-01 | alari76 | ✅ Yes | Delete — fully merged |
| `origin/fix/security-validation-followup-2026-04-30` | 2026-05-01 | alari76 | ✅ Yes | Delete — fully merged |

**Automated audit branches** (accumulate daily/weekly; not stale by age but worth a periodic prune policy):

| Pattern | Count (approx.) | Notes |
|---|---|---|
| `audit/code-review.daily-*` | ~5 visible | Auto-generated; merged via automated PRs |
| `audit/repo-health.weekly-*` | ~3 visible | Auto-generated |
| `audit/security-audit.weekly-*` | ~1 visible | Auto-generated |
| `audit/complexity.weekly-*` | ~1 visible | Auto-generated |
| `audit/dependency-health.daily-*` | ~1 visible | Auto-generated |

Consider adding a branch-cleanup step to the audit workflow (or a dedicated weekly cron) to delete merged audit branches older than 7 days.

---

## PR Hygiene

`gh pr list` returned an empty set: **0 open pull requests**.

| Metric | Value |
|---|---|
| Open PRs | 0 |
| Stuck PRs (>7 days, no review) | 0 |
| PRs with merge conflicts | 0 |

The project follows a fast-merge pattern: feature/fix branches are short-lived, reviewed quickly, and merged. PR #463 (the most recent merge) closed within hours of opening based on branch creation vs. merge commit dates. This is an excellent PR hygiene posture.

---

## Merge Conflict Forecast

Active branches with commits in the last 14 days (2026-04-18 to 2026-05-02):

| Branch | Last commit | Commits ahead of main | Overlapping files with main | Conflict risk |
|---|---|---|---|---|
| `origin/feat/child-session-terminal-notifications-2026-05-01` | 2026-05-01 | ~1–2 (unconfirmed; feature likely merged via #463) | `server/orchestrator*.ts` | Low — likely already merged; verify and delete |
| `origin/fix/workflow-audit-base-branch-2026-05-01` | 2026-05-01 | ~1 (branch for #461 fix) | `server/workflow-*.ts` | Low — narrow scope, likely merged |
| `origin/audit/*-2026-05-01` | 2026-05-01 | 1 each | `.codekin/reports/**` only | None — isolated report paths, no overlap with source |
| `origin/codekin/reports` | 2026-04-27 | Unknown | `.codekin/reports/**` | Low — reports-only files |
| `origin/chore/release-0.6.4` | 2026-04-27 | ~1 (version bump) | `package.json`, `CHANGELOG.md` | Low — likely already superseded by v0.6.4 tag |
| `origin/fix/commit-event-handler-test-mock` | 2026-04-27 | ~1 | `server/*.test.ts` | Low — test-only files |

No branches were found with high conflict risk. The architecture of isolated audit-branch paths (`.codekin/reports/`) and focused fix branches means divergence is low across the board.

**Branch most likely to need attention**: `origin/feat/child-session-terminal-notifications-2026-05-01` — verify it is fully merged (PR #463 is on `main`), then delete it.

---

## Recommendations

1. **Delete merged remote branches** — `origin/fix/security-validation-2026-04-30` and `origin/fix/security-validation-followup-2026-04-30` are confirmed merged into `main`. Run `git push origin --delete fix/security-validation-2026-04-30 fix/security-validation-followup-2026-04-30` to clean up. Verify and similarly delete `origin/feat/child-session-terminal-notifications-2026-05-01` and `origin/fix/workflow-audit-base-branch-2026-05-01` after confirming both PRs are merged.

2. **Add automated audit-branch pruning** — The daily/weekly audit workflow creates a new remote branch per run. Without automatic cleanup, these accumulate. Add a step to each audit workflow (or a separate weekly cron) that deletes merged `audit/*` branches older than 7 days. This keeps the branch list readable and reduces `git fetch` noise.

3. **Align `server/tsconfig.json` target with app** — The server config targets `ES2022` while the frontend targets `ES2023`. Node.js 20+ supports all ES2023 features (e.g. `Array.prototype.toSorted`, `Object.groupBy`). Change `"target": "ES2022"` → `"ES2023"` in `server/tsconfig.json` for consistency. (Low priority; no current functional impact.)

4. **Add `noImplicitReturns` to `server/tsconfig.json`** — This check is enabled in `tsconfig.app.json` and `tsconfig.node.json` but absent from the server config. Adding it closes a minor gap where server functions could silently return `undefined` on some code paths without a compile error.

5. **Document the `pull_request` webhook handler in `docs/GITHUB-WEBHOOKS-SPEC.md`** — The PR review webhook (added in commit `24de04e`, 2026-04-02) is implemented but the spec file predates it. A targeted update (~1 page) would complete the documentation and make the feature discoverable to contributors.

6. **Pin the `@multiplier-labs/stepflow` version** — `package.json` currently specifies `"@multiplier-labs/stepflow": "^0.3.4"` (with caret). If this is an internal package under active development, consider pinning to an exact version or using a workspace reference to avoid unexpected breakage from patch releases that introduce regressions.

7. **Verify `highlight.js` (BSD-3-Clause) in distributed artifact** — `highlight.js` and `refractor` are bundled into the frontend via Vite. BSD-3-Clause is permissive and MIT-compatible, but the project's distributed `npm` package should include a `NOTICE` or `THIRD_PARTY_LICENSES` file that lists BSD-3-Clause and Apache-2.0 attributions, as those licenses require attribution in distributions. Currently only the `licenseNotes` field in `package.json` documents MPL-2.0 items.

8. **Consider rate-limiter configurability via env vars** — `server/ws-server.ts` documents `WS_RATE_MAX_CONNECTIONS` and `WS_AUTH_TIMEOUT_MS` as compile-time constants. Surfacing these as env vars (or including them in the `~/.config/codekin/env` configuration table) would make them tuneable by operators without recompiling, improving operability in high-traffic or multi-tenant deployments.

9. **Add a `CODEOWNERS` or branch-protection rule for `docs/`** — Given the volume of docs-drift findings in previous audits (resolved diligently), adding an automated check (e.g. a CI step that flags if source files change without a corresponding docs touch) or a `CODEOWNERS` rule requiring a docs review on changes to `server/ws-server.ts`, `server/workflow-*.ts`, and `server/orchestrator*.ts` would reduce future drift between code and specifications.

10. **Remove `origin/codekin/reports` branch** — This branch (created 2026-04-27) has an unconventional name that does not follow the project's `feat/`, `fix/`, `audit/`, `chore/` naming convention. Verify its purpose and either merge, rename to `chore/reports-2026-04-27`, or delete it to maintain naming consistency.Reports committed and PR opened: https://github.com/Multiplier-Labs/codekin/pull/464