# Repository Health: codekin

**Date**: 2026-03-15T04:19:50.335Z
**Repository**: /srv/repos/codekin
**Branch**: fix/docs-audit-cleanup
**Workflow Run**: 626bd9f6-7f6a-4ff5-b81a-ce458c186fcc
**Session**: 4b145888-a498-40d7-a878-deb624844b98

---

Gathering data across three parallel agents (git/PRs/branches, TODOs/configs/licenses, dead code/docs/exports). I'll compile the full report once they complete.Git data collected. Waiting for the other two agents to finish.Two of three agents complete. Waiting for the dead code/docs agent.# Codekin Repository Health Assessment
**Date:** 2026-03-15 | **Branch assessed:** `fix/docs-audit-cleanup` | **Version:** 0.4.0

---

## Summary

**Overall Health: Good**

The codebase is actively maintained with a clean, modern TypeScript stack, full strict-mode enforcement, and zero TODO/FIXME debt. The primary concerns are a small cluster of already-merged branches accumulating on the remote, one open PR awaiting review, a minor lock-file version drift, and several ESLint rules deliberately demoted to warnings that represent acknowledged technical debt. Documentation is generally current following a recent audit cleanup (2026-03-14).

| Metric | Value |
|---|---|
| Dead code items | 0 orphans · 3 lightly-used utilities flagged for review |
| Stale TODOs/FIXMEs | 0 |
| Config issues | 2 minor (lock file drift, ESLint ecmaVersion mismatch) |
| License concerns | 0 copyleft · 3 non-MIT licenses noted (all permissive) |
| Doc drift items | 2 (CONTRIBUTING.md install step, API-REFERENCE coverage gap) |
| Stale / merged branches | 6 branches 0-commits-ahead of main (deletion candidates) |
| Open PRs | 1 (age: 1 day, not yet stuck) |
| High conflict-risk branches | 2 (18 commits behind main) |

---

## Dead Code

No completely orphaned source files were detected. All modules are reachable from an entry point. Three utility files have narrow usage and warrant periodic review:

| File | Export / Symbol | Type | Recommendation |
|---|---|---|---|
| `src/lib/deriveActivityLabel.ts` | `deriveActivityLabel` | Lightly used utility | Used only in `App.tsx`; keep, but consider inlining if usage stays at 1 call site |
| `src/lib/hljs.ts` | `hljs` (configured Highlight.js instance) | Lightly used utility | Used only by `MarkdownRenderer`; acceptable single-consumer module |
| `src/lib/chatFormatters.ts` | various format helpers | Lightly used utility | Review at next refactor; consolidate with related formatting logic if scope expands |

> **Note:** TypeScript `noUnusedLocals` and `noUnusedParameters` are enabled in all tsconfig files. Any truly dead local symbols would already be caught at build time.

---

## TODO/FIXME Tracker

**No TODO, FIXME, HACK, XXX, or WORKAROUND comments were found** in any `.ts`, `.tsx`, `.js`, `.jsx`, or `.mjs` source file.

| Metric | Count |
|---|---|
| TODO | 0 |
| FIXME | 0 |
| HACK | 0 |
| XXX | 0 |
| WORKAROUND | 0 |
| **Total** | **0** |
| Stale (> 30 days) | 0 |

---

## Config Drift

### tsconfig (all configs)

All four tsconfig files (`tsconfig.json`, `tsconfig.app.json`, `tsconfig.node.json`, `server/tsconfig.json`) are well-configured. No critical issues found.

| Config File | Setting | Current Value | Status |
|---|---|---|---|
| `tsconfig.app.json` | `strict` | `true` | ✅ Correct |
| `tsconfig.app.json` | `noUnusedLocals` / `noUnusedParameters` | `true` | ✅ Correct |
| `tsconfig.app.json` | `target` | `ES2022` | ✅ Modern |
| `tsconfig.node.json` | `target` | `ES2023` | ✅ Modern |
| `server/tsconfig.json` | `strict` | `true` | ✅ Correct |
| `server/tsconfig.json` | `module` | `NodeNext` | ✅ Correct for ESM Node |

### ESLint (`eslint.config.js`)

| Setting | Current Value | Concern |
|---|---|---|
| `ecmaVersion` (both frontend + server blocks) | `2020` | Minor mismatch — TypeScript targets ES2022/ES2023; should be `2022` or `"latest"` to stay consistent |
| 14 `@typescript-eslint/*` rules | `"warn"` | Intentional incremental adoption (per inline comment), but creates a permissive floor. Rules like `no-unsafe-assignment`, `no-unsafe-member-access`, and `no-non-null-assertion` being warnings rather than errors means type-unsafety can accumulate silently. |
| `@typescript-eslint/no-floating-promises` | `"error"` | ✅ Correct — async mistakes are errors |
| Test files block | `tseslint.configs.recommended` (not `strictTypeChecked`) | Acceptable for tests, but `any` is fully off — consider re-enabling selectively |

### Prettier (`.prettierrc`)

No issues. `printWidth: 120`, `singleQuote: true`, `semi: false`, `trailingComma: "all"` — consistent with codebase style.

### Lock File Version Drift

| File | `version` field | Status |
|---|---|---|
| `package.json` | `0.4.0` | Current |
| `package-lock.json` | `0.3.7` | **Stale** — lock file was not regenerated after the version bump in commit `675e935`. Run `npm install` to sync. |

---

## License Compliance

**Project license:** MIT

Sampled approximately 100 direct and transitive dependencies. No GPL, LGPL, or AGPL licenses found.

### License Summary Table

| License | Approx. Count | Status |
|---|---|---|
| MIT | ~135 | ✅ Compatible |
| Apache-2.0 | ~15 | ✅ Compatible |
| BSD-2-Clause | ~12 | ✅ Compatible |
| BSD-3-Clause | ~8 | ✅ Compatible |
| ISC | ~6 | ✅ Compatible |
| CC-BY-4.0 | 1 (`caniuse-lite`) | ✅ Data license, permissive for use |
| Python-2.0 | 1 (`argparse`) | ✅ PSF permissive license |
| MPL-2.0 OR Apache-2.0 | 1 (`dompurify`) | ✅ Documented in `package.json` `licenseNotes`; Apache-2.0 variant is MIT-compatible |
| MIT OR WTFPL | 1 (`expand-template`) | ✅ MIT variant applies |

### Flagged Dependencies (Attention, Not Blockers)

| Package | License | Note |
|---|---|---|
| `dompurify` | `(MPL-2.0 OR Apache-2.0)` | Dual-licensed; using as a library under Apache-2.0 is fine. Already documented in `package.json`. No action needed. |
| `caniuse-lite` | `CC-BY-4.0` | Creative Commons data license. Attribution required but no restriction on distribution. Transitive dep of browserslist/postcss — standard in the ecosystem. |

---

## Documentation Freshness

### API Docs vs Recent Code Changes

| Area | Last Code Change | Doc File | Status |
|---|---|---|---|
| Approval system (6 fixes) | 2026-03-12 | `docs/APPROVALS-FIX-SPEC.md` | ✅ Spec added same day as implementation |
| Configurable repos path | 2026-03-12 | `docs/API-REFERENCE.md` | ⚠️ Repos path setting and folder picker added in #120/#132 — API-REFERENCE may not reflect new settings endpoints |
| Diff viewer sidebar | 2026-03-12 | `docs/FEATURES.md` | ⚠️ Diff viewer listed in FEATURES.md but sidebar-specific UX (global scroll, darker bg) from #127 may be undocumented |
| CSP / Google Fonts fix | 2026-03-14 | `docs/SETUP.md` | ✅ CSP is infrastructure-level; SETUP.md covers nginx/production config |
| Docs audit workflow | 2026-03-14 | `docs/WORKFLOWS.md` | ✅ `docs-audit` workflow listed in WORKFLOWS.md |

### README Drift

| README/CONTRIBUTING Claim | Actual State | Status |
|---|---|---|
| CONTRIBUTING.md: `npm install` then `npm install --prefix server` | Root `package.json` scripts control everything; server has its own `package.json` requiring a separate install | ⚠️ CONTRIBUTING.md is correct that the server requires a separate install step, but this is not mentioned in CLAUDE.md's quick-start — could confuse new contributors |
| CLAUDE.md quick-start: `npm install` only | Does not mention `npm install --prefix server` | ⚠️ Minor omission — new contributors following CLAUDE.md alone will miss the server install step |
| Scripts listed in CLAUDE.md: `dev`, `build`, `test`, `test:watch`, `lint` | All present in `package.json` | ✅ Accurate |
| Port 32352 mentioned in CLAUDE.md | Server config uses PORT env var, defaulting to 32352 | ✅ Accurate |

---

## Draft Changelog

**Period:** v0.3.7 → v0.4.0 (2026-03-12 to 2026-03-14)

### Features
- Add diff viewer sidebar for browsing session file changes (#119)
- Add configurable repos path setting for locally cloned repositories (#120)
- Add Code Review button to chat area when files are modified (#124)
- Add repositories path setting to empty state view (#128)
- Add folder picker and path validation for repos path setting (#132)
- Add documentation audit workflow with weekly scheduling (#134, #137)
- Add daily code review and repo health automated reports (#133)

### Fixes
- Approval countdown auto-approve not firing when timer expires (#138)
- Approval prompt not always showing yellow status on sidebar (#136)
- Add Google Fonts domains to CSP so fonts load in production (#135)
- Fix Code Review button contrast in light mode (#127)
- Improve diff panel UX: global scroll, darker background, lighter light-mode diff colors (#127)
- Chunk git path args in discard to avoid `E2BIG` error on large repos (#119)
- Upgrade `undici` to 7.24.1 to fix CI audit failure (#132)

### Refactoring
- Implement all 6 approval system fixes from APPROVALS-FIX-SPEC: cross-remote escalation, executor validation, requestId matching, leave grace period, hook denial surfacing, pattern-first approval storage (#122)
- Fix cross-remote escalation, notify auth, requestId guard (GPT/Gemini review rounds)
- Fix security issues from code review audit (#125)

### Documentation
- Add `APPROVALS-FIX-SPEC.md` spec document (#121)
- Add documentation from code comment audit (#123)
- Clean up documentation per audit findings (2026-03-14)
- Add docs-audit weekly report (2026-03-14)

### Chores
- Bump version to 0.4.0
- Register `docs-audit.weekly` in UI workflow kinds

---

## Stale Branches

All remote branches had activity on **2026-03-14** (yesterday), so none are stale by the 30-day criterion. However, six branches have **0 commits ahead of `main`**, meaning they have been fully merged and are safe to delete.

| Branch | Last Commit | Author | Ahead/Behind Main | Merged? | Recommendation |
|---|---|---|---|---|---|
| `origin/fix/approval-auto-approve-countdown` | 2026-03-14 | alari | 0 ahead / 1 behind | ✅ Yes (#138) | **Delete** |
| `origin/fix/approval-waiting-state` | 2026-03-14 | alari | 0 ahead / 6 behind | ✅ Yes (#136) | **Delete** |
| `origin/fix/csp-google-fonts` | 2026-03-14 | alari76 | 0 ahead / 8 behind | ✅ Yes (#135) | **Delete** |
| `origin/feat/docs-audit-workflow` | 2026-03-14 | alari76 | 0 ahead / 3 behind | ✅ Yes (#137) | **Delete** |
| `origin/feat/folder-picker-repos-path` | 2026-03-14 | Claude (Webhook) | 0 ahead / 16 behind | ✅ Yes (#132) | **Delete** |
| `origin/chore/repo-health-action-items` | 2026-03-14 | alari | 0 ahead / 14 behind | ✅ Yes (#133) | **Delete** |
| `origin/fix/docs-audit-cleanup` | 2026-03-14 | alari | 3 ahead / 0 behind | ❌ Open (current) | Keep — active work |
| `origin/chore/repo-health-report-2026-03-14` | 2026-03-14 | Claude (Webhook) | 2 ahead / 18 behind | ❌ Open (#131) | Keep — pending PR |
| `origin/codekin/reports` | 2026-03-14 | alari | 4 ahead / 18 behind | ❌ Open | Review — unmerged commits |

---

## PR Hygiene

| PR # | Title | Author | Days Open | Review Status | Conflicts | Stuck? |
|---|---|---|---|---|---|---|
| #131 | Add automated repo health report for 2026-03-14 | alari76 | 1 | No review yet | UNKNOWN | ❌ Not yet (< 7 days) |

Only one open PR. Not stuck by the 7-day threshold. The `mergeable: UNKNOWN` status from the GitHub API typically resolves itself; re-querying after a few minutes will yield a definitive MERGEABLE/CONFLICTING result.

---

## Merge Conflict Forecast

Branches with commits in the last 14 days:

| Branch | Commits Ahead | Commits Behind | Modified Files (estimate) | Risk |
|---|---|---|---|---|
| `origin/fix/docs-audit-cleanup` | 3 | 0 | Version bump, docs, weekly report | 🟢 **Low** — purely additive docs/chore changes, 0 behind main |
| `origin/chore/repo-health-report-2026-03-14` | 2 | 18 | Report files | 🟡 **Medium** — 18 commits behind main; report files likely non-overlapping but should rebase |
| `origin/codekin/reports` | 4 | 18 | Report/docs files | 🟡 **Medium** — 18 commits behind main; 4 unique commits in reports directory; rebase recommended before merge |

No branch shows direct file-level overlap with main's recent changes, but the two branches 18 commits behind main should be rebased promptly as divergence will increase.

---

## Recommendations

1. **Delete 6 merged remote branches** (`fix/approval-auto-approve-countdown`, `fix/approval-waiting-state`, `fix/csp-google-fonts`, `feat/docs-audit-workflow`, `feat/folder-picker-repos-path`, `chore/repo-health-action-items`). They are fully merged and add noise to `git branch -r`. One batch command: `git push origin --delete fix/approval-auto-approve-countdown fix/approval-waiting-state fix/csp-google-fonts feat/docs-audit-workflow feat/folder-picker-repos-path chore/repo-health-action-items`.

2. **Regenerate `package-lock.json`** by running `npm install` from the repo root. The lock file still reports version `0.3.7` while `package.json` is `0.4.0`. This causes `npm audit` and `npm ci` to emit warnings in CI and confuses tooling that reads the lock file version.

3. **Rebase `chore/repo-health-report-2026-03-14` and `codekin/reports`** onto main. Both are 18 commits behind. While the modified files (report outputs) are unlikely to conflict, the gap will only grow and `gh pr merge` will become harder.

4. **Promote ESLint warnings to errors incrementally.** Fourteen `@typescript-eslint` rules are currently `warn`. The inline comment acknowledges this as intentional, but without a tracking mechanism these warnings become permanent background noise. Prioritise: `no-unsafe-assignment`, `no-unsafe-member-access`, `no-non-null-assertion` — the most impactful for runtime safety.

5. **Fix `ecmaVersion: 2020` in `eslint.config.js`** (both frontend and server blocks). TypeScript targets ES2022/ES2023; the ESLint parser should match with `ecmaVersion: 2022` or `"latest"` to avoid false-positive parse errors on newer syntax (e.g., top-level `await` in `.mjs`).

6. **Update `CLAUDE.md` quick-start** to include `npm install --prefix server` (or note that it is required). New contributors following the top-level README/CLAUDE.md will build the frontend successfully but fail to start the server because `server/node_modules` will be missing.

7. **Audit `docs/API-REFERENCE.md` against the configurable-repos-path feature** added in #120/#132. The settings endpoint and folder-picker validation logic are new; verify that the reference documents the new `repos_root` setting, path validation rules, and the `GET /api/settings` response shape.

8. **Review PR #131** ("Add automated repo health report for 2026-03-14"). It has been open for 1 day with no review activity. Since it is auto-generated content rather than functional code, a lightweight review policy (e.g., auto-merge if CI passes) would reduce review queue burden.

9. **Address `dompurify` dual-license in a dependency audit comment.** The `licenseNotes` field in `package.json` is non-standard and will be ignored by automated license scanners (`license-checker`, `licensee`). Consider adding a `NOTICE` file or using a `.licensee.yml` / `license-checker` allowlist to make the intentional exception machine-readable and auditable in CI.

10. **Establish a policy for the `warn`-to-`error` ESLint promotion.** The current state (`warn` + comment "should be promoted to errors as the codebase is cleaned up") has no actionable milestone. Attaching promotion of each rule to a specific version target or sprint would prevent the warnings from becoming permanent fixtures.