# Repository Health Assessment — 2026-04-12

**Project:** Codekin  
**Branch assessed:** main  
**Latest tag:** v0.6.1  
**Assessment date:** 2026-04-12  

---

## Summary

**Overall health: Good**

The repository is in active, high-velocity development with strong engineering discipline. TypeScript strict mode, comprehensive linting, and a clean PR-based branching workflow keep code quality high. No dead code, no TODO debt, and no stale branches were found. The primary concerns are a growing backlog of unmerged audit/report PRs, a non-trivial ESLint rule-demotion list that allows unsafe patterns as warnings rather than errors, and MPL-2.0 / CC-BY-4.0 licensed dependencies that warrant acknowledgement.

| Metric | Value |
|---|---|
| Dead code items | 0 |
| Stale TODOs (>30 days) | 0 |
| Total TODO/FIXME annotations | 0 |
| Config drift findings | 4 |
| License concerns (flagged) | 2 (lightningcss MPL-2.0, caniuse-lite CC-BY-4.0) |
| Doc drift items | 1 minor |
| Stale branches (>30 days) | 0 |
| Open PRs | 14 |
| Stuck PRs (>7 days, no review) | 0 |
| Active unmerged branches (conflict risk) | 1 (low risk) |

---

## Dead Code

TypeScript strict mode is enabled across all three tsconfig targets (`tsconfig.app.json`, `server/tsconfig.json`, `tsconfig.node.json`) with `noUnusedLocals: true` and `noUnusedParameters: true`. The compiler enforces zero dead locals at build time. A runtime scan confirms no orphan source files or unreachable exported symbols exist in `src/` or `server/`.

| File | Symbol | Type | Recommendation |
|---|---|---|---|
| — | — | — | No items found |

**Result: CLEAN.** The compiler acts as a continuous dead-code detector; no manual removal needed.

---

## TODO/FIXME Tracker

Patterns searched: `TODO`, `FIXME`, `HACK`, `XXX`, `WORKAROUND` across all TypeScript/TSX source and documentation files.

| File:Line | Type | Comment | Author | Date | Stale? |
|---|---|---|---|---|---|
| — | — | — | — | — | — |

The only matches found are within `server/claude-process.test.ts` at lines 61, 62, and 810, where the string `'TODO'` appears as a **test fixture pattern** (data under test, not a code annotation).

**Summary:**

| Type | Count | Stale (>30 days) |
|---|---|---|
| TODO | 0 | 0 |
| FIXME | 0 | 0 |
| HACK | 0 | 0 |
| XXX | 0 | 0 |
| WORKAROUND | 0 | 0 |
| **Total** | **0** | **0** |

**Result: CLEAN.**

---

## Config Drift

### tsconfig (all three targets)

All tsconfig files are well-configured against modern TypeScript best practices:
- `strict: true` enabled on all targets
- `noUnusedLocals: true`, `noUnusedParameters: true`
- `noFallthroughCasesInSwitch: true`
- `noUncheckedSideEffectImports: true`
- `target: ES2022` — appropriate for a Node 20+ / modern browser environment
- `module: NodeNext` on server — correct for ESM with Node resolution

No drift found in tsconfig.

### eslint.config.js

The project uses `typescript-eslint` with `strictTypeChecked` profiles — a strong baseline. However, several safety-critical rules have been manually demoted from `error` to `warn`, which allows unsafe patterns to pass CI without blocking.

| Config File | Rule | Current Value | Recommended Value | Rationale |
|---|---|---|---|---|
| eslint.config.js | `@typescript-eslint/no-unsafe-assignment` | `warn` | `error` | Allows `any`-typed assignments to silently spread |
| eslint.config.js | `@typescript-eslint/no-unsafe-argument` | `warn` | `error` | Allows `any` values in function calls without type checking |
| eslint.config.js | `@typescript-eslint/no-unsafe-member-access` | `warn` | `error` | Allows unchecked property access on `any` typed objects |
| eslint.config.js | `@typescript-eslint/no-unsafe-return` | `warn` | `error` | Allows `any`-typed returns to escape into typed code |
| eslint.config.js | `@typescript-eslint/no-non-null-assertion` | `warn` | `error` | Non-null assertions bypass the compiler's null-safety |
| eslint.config.js | `@typescript-eslint/no-misused-promises` | `warn` | `error` | Unhandled promise misuse can cause silent async bugs |
| eslint.config.js | `@typescript-eslint/require-await` | `warn` | `error` | Async functions without `await` indicate design issues |
| eslint.config.js | `@typescript-eslint/use-unknown-in-catch-callback-variable` | `warn` | `error` | Typed `catch` variables prevent unsafe error property access |

Additionally, several `no-unsafe-*` rules are individually listed across both the frontend and server config blocks — this duplication could be consolidated into a shared overrides object for maintainability.

### .prettierrc

`printWidth: 120` is set. The most common community standard is 80 or 100. At 120 characters, long lines pass formatting checks that may be hard to read in split-pane editors. This is a style preference, not a correctness issue, but worth noting for team alignment.

---

## License Compliance

The project is licensed **MIT**. All direct runtime dependencies use permissive licenses. The full transitive dependency tree is assessed below.

### Summary Table

| License | Dependency Count | Compatible with MIT? |
|---|---|---|
| MIT | 441 | Yes |
| ISC | 20 | Yes |
| Apache-2.0 | 18 | Yes |
| BSD-3-Clause | 9 | Yes |
| BSD-2-Clause | 8 | Yes |
| MPL-2.0 | 13 | Conditional (see below) |
| MIT-0 | 2 | Yes |
| BlueOak-1.0.0 | 2 | Yes (permissive) |
| CC-BY-4.0 | 1 | Conditional (see below) |
| (MPL-2.0 OR Apache-2.0) | 1 | Yes (Apache-2.0 option applies) |
| (MIT OR WTFPL) | 1 | Yes |
| (BSD-2-Clause OR MIT OR Apache-2.0) | 1 | Yes |
| CC0-1.0 | 1 | Yes (public domain) |
| 0BSD | 1 | Yes (public domain-like) |

### Flagged Dependencies

| Package | License | Risk | Notes |
|---|---|---|---|
| `lightningcss` + 11 platform binaries | MPL-2.0 | **Low** | Build-time only (pulled in by Vite/TailwindCSS v4). MPL-2.0 requires that modifications to MPL-licensed *files* be released under MPL-2.0. Since this is a build tool, its source is not incorporated into the distributed output and the project does not modify it. Risk is low but legal review is recommended if the project is commercialised. |
| `dompurify` | (MPL-2.0 OR Apache-2.0) | **None** | The Apache-2.0 licence option is fully compatible with MIT. No action needed. |
| `caniuse-lite` | CC-BY-4.0 | **Low** | CC-BY-4.0 is a Creative Commons Attribution licence designed for creative works, not software. It is used here for browser compatibility data (not code). Attribution is required in documentation. No redistribution issue exists for an application, but the licence is non-standard for software dependencies. No action required unless the project redistributes the data directly. |

---

## Documentation Freshness

### API Docs / Endpoint Changes

The `docs/API-REFERENCE.md` documents REST endpoints and the WebSocket protocol. Recent changes to the server include:

- New `provider` field added to session serialisation (#340, 2026-04-11)
- New connection status endpoint(s) for the popup feature (#346, 2026-04-11)
- Rate limiting and CSP headers added (#355, 2026-04-11)
- Symlink-path-traversal guards on docs and reports endpoints (#358, 2026-04-11)

`docs/API-REFERENCE.md` was last updated on 2026-04-11 (commit `011cc66`, "docs: update changelog and README to feature OpenCode support"). The OpenCode provider type and its session fields appear to be documented in that update. However, the specific new security hardening behaviour (rate-limit headers, enforced WebSocket origin validation) is not confirmed to be reflected in the API reference.

**Flag:** `docs/API-REFERENCE.md` — verify that rate-limiting responses (429) and the enforced `Origin` WebSocket handshake are documented, given the hardening in #355.

### README Drift

README.md was updated on 2026-04-11. Verification against `package.json` scripts:

| README Command | Exists in package.json? | Match? |
|---|---|---|
| `npm install` | n/a (standard) | ✓ |
| `npm run dev` | `"dev": "vite"` | ✓ |
| `npm run build` | `"build": "tsc -b && vite build"` | ✓ |
| `npm test` | `"test": "vitest run"` | ✓ |
| `npm run test:watch` | `"test:watch": "vitest"` | ✓ |
| `npm run lint` | `"lint": "eslint ."` | ✓ |

**Result: No README drift detected.** All documented commands match the current `package.json`.

One minor note: `npm run preview` (`vite preview`) exists in `package.json` but is not mentioned in the README. This is a low-priority omission since it is a dev-only convenience command.

---

## Draft Changelog

### Since v0.6.1 (commits on main after tag)

> **[Unreleased]** — 2026-04-12

#### Features
- Improve model picker usability: full-text search, recently-used models list, and keyboard navigation (#368)

#### Fixes
- Address 5 small issues from audit reports (#366)

---

### Full 7-day summary (2026-04-06 to 2026-04-12)

> **v0.6.1** — 2026-04-11

#### Features
- Add OpenCode as an alternative AI provider with `CodingProcess` abstraction (#322)
- Wire provider selection through REST API, workflows engine, and sidebar UI (#323)
- Add connection status popup with per-provider disable/enable toggles (#346)
- Show "disconnected" banner for OpenCode sessions (#345)
- Add `pull_request` webhook handler for automated PR code review (#321)
- Add PR Review as an event-driven workflow kind in the Workflows UI (#334)
- Expand agent child session permissions with a curated tool allowlist (#320)

#### Fixes
- Harden server security: bearer auth, rate limiting, CSP headers, WebSocket origin enforcement (#355)
- Prevent symlink-based path traversal in docs and reports endpoints (#358)
- Restore `wss:`/`ws:` in CSP `connect-src` to unbreak WebSocket connections (#356)
- Harden session restart logic to reduce spurious restarts and context loss (#351)
- Prevent false session resets from aggressive zombie detection; add grace period (#349)
- Suppress spurious restart message during graceful shutdown (#350)
- Prevent stdio buffer deadlock in OpenCode server spawn (#352)
- Strip `GIT_*` env vars from OpenCode server to fix worktree git operations (#353)
- Fix duplicate OpenCode messages; support image and text file attachments (#339, #343)
- Handle reasoning deltas and strip user echo in OpenCode responses (#342)
- Validate model when switching between Claude and OpenCode sessions (#363)
- Add missing `_isStarting` property to restored sessions (#361)
- Address 4 server correctness bugs from code review (#359)
- Fix provider-disabled overlay and input bar UX (#347, #348)
- Fix model dropdown to be scrollable (max 10 items) (#341)
- Include `provider` field in serialized session info (#340)
- Fix OpenCode model list population (#opencode-model-list)
- Strip uninformative agent noise lines from chat display (#313)

#### Refactoring
- Migrate workflow engine to open-source `@multiplier-labs/stepflow` (#333)
- Complexity quick wins: remove deprecated constructor, deduplicate methods, extract helpers (#331)

#### Tests
- Add coverage for `session-lifecycle`, orchestrator-children, and `prompt-router` (#328)

#### Chores
- Bump version to v0.6.0 (#332), then v0.6.1
- Housekeeping: fix contradictory comments, prune stale branches (#315)

---

## Stale Branches

A branch is considered stale if its last commit is more than 30 days before the assessment date (before 2026-03-13).

The full remote branch list contains 47 branches. The **oldest** branch in the list has a last-commit date of **2026-04-09** — just 3 days before this assessment. No branches exist with commit dates older than 30 days in the remote tracking refs.

| Branch | Last Commit | Author | Merged into main? | Recommendation |
|---|---|---|---|---|
| — | — | — | — | No stale branches found |

**Result: CLEAN.** No stale branches.

**Note on branch volume:** There are 41 unmerged remote branches and 5 branches that are registered as merged (via `git branch --merged`). The discrepancy is expected: the team uses squash-merge PRs. Squash merges do not leave a Git ancestry trail, so `git branch --merged` does not recognise them. The unmerged branches are all from 2026-04-09 to 2026-04-12 and represent recently-squashed PR source branches. A periodic `git push origin --delete <branch>` sweep after PR merges would reduce noise. See Recommendations #3.

---

## PR Hygiene

All 14 open PRs were created within the last 2 days. No PR is older than 7 days, so none qualify as "stuck" by the defined threshold.

| PR# | Title | Author | Age | Review Status | Mergeable | Stuck? |
|---|---|---|---|---|---|---|
| #369 | fix: resolve eslint template literal error in claude-process | alari76 | 0d | No reviews | MERGEABLE | No |
| #367 | docs: add documentation audit report for 2026-04-11 | alari76 | 0d | No reviews | MERGEABLE | No |
| #365 | docs: add comment quality audit report | alari76 | 0d | No reviews | UNKNOWN | No |
| #364 | chore: bump version to 0.6.1 | alari76 | 0d | No reviews | UNKNOWN | No |
| #362 | Add security audit report for 2026-04-11 | alari76 | 0d | No reviews | UNKNOWN | No |
| #354 | Add security audit report | alari76 | 0d | No reviews | UNKNOWN | No |
| #338 | chore: daily code review 2026-04-11 | alari76 | 0d | No reviews | UNKNOWN | No |
| #336 | chore: complexity report 2026-04-10 | alari76 | 0d | No reviews | UNKNOWN | No |
| #335 | chore: repo health assessment 2026-04-11 | alari76 | 0d | No reviews | UNKNOWN | No |
| #326 | docs: security audit report 2026-04-10 | alari76 | 1d | No reviews | MERGEABLE | No |
| #325 | chore: add daily code review report for 2026-04-10 | alari76 | 1d | No reviews | MERGEABLE | No |
| #324 | chore: test coverage report 2026-04-10 | alari76 | 1d | No reviews | MERGEABLE | No |
| #314 | chore: add reports for 2026-04-09/10 | alari76 | 1d | No reviews | MERGEABLE | No |
| #310 | chore: add complexity and repo-health reports for April | alari76 | 2d | No reviews | MERGEABLE | No |

**Pattern observation:** 12 of 14 open PRs are audit/report PRs (`chore:`, `docs:`). These are generated by automated assessment workflows and are accumulating without being merged. They are not blocking development but represent housekeeping debt. Consider a batch-merge or auto-merge policy for report-only PRs (no source file changes). See Recommendations #1.

PR #369 (`fix/ci-lint-template-expression-error`) is the only actionable code fix awaiting merge.

---

## Merge Conflict Forecast

Active branches are defined as having at least one commit in the last 14 days that is not yet on `main`.

| Branch | Commits Ahead of main | Commits Behind main | Modified Files | Overlapping Files with main | Risk |
|---|---|---|---|---|---|
| `fix/ci-lint-template-expression-error` | 2 | 0 | `src/components/ModelDropdown.tsx`, `server/claude-process.ts` | None (0 behind) | **Low** |

All other remote branches (41 total) are squash-merged PR source branches with no new commits after their merge. They appear as "unmerged" in git graph terms due to squash-merge mechanics but contain no divergent work.

**Result:** No high-risk merge conflicts forecast. The one active unmerged branch is 0 commits behind main and modifies files in distinct areas (a UI component and one server file) that are not being actively changed on main at this moment.

---

## Recommendations

1. **[High] Merge or auto-merge the report PR backlog.** Twelve open PRs are audit/report documents (`chore:`, `docs:`) that have accumulated without being merged. These inflate the open PR count and hide the signal of real code PRs (like #369). Consider establishing an auto-merge policy for PRs that touch only `.codekin/reports/` paths, or batch-merge them manually.

2. **[High] Merge PR #369 (`fix/ci-lint-template-expression-error`).** This is the only open code-fix PR. It is mergeable, 0 commits behind main, and addresses an ESLint error that may be blocking CI. It should be prioritised.

3. **[Medium] Delete squash-merged remote branches after PR close.** 41 remote branches are unmerged in git graph terms (squash-merge artefacts). Add a branch-deletion setting to the repository (GitHub: Settings → General → "Automatically delete head branches") to keep the remote clean without manual effort.

4. **[Medium] Promote demoted ESLint unsafe rules from `warn` to `error`.** Eight `@typescript-eslint/no-unsafe-*` and related rules are currently set to `warn`, meaning unsafe patterns build and pass CI without correction. Elevating these to `error` would bring the linting configuration in line with the `strictTypeChecked` profile's intent. Recommended order: start with `no-unsafe-call` (already `error`) as the template, then `no-unsafe-assignment` → `no-unsafe-argument` → `no-non-null-assertion`.

5. **[Medium] Audit `docs/API-REFERENCE.md` against recent server hardening.** The security hardening in #355 (rate limiting, WebSocket origin enforcement, updated CSP) and the new session `provider` field may not be fully reflected in the API reference. Verify that error responses (401 Unauthorized, 429 Too Many Requests) and the WebSocket handshake requirements are documented.

6. **[Low] Review lightningcss MPL-2.0 usage in context of commercialisation.** `lightningcss` and its platform binaries are MPL-2.0 licensed. As a build-time tool with unmodified source, the current usage is low risk. However, if the project is ever packaged for commercial redistribution (e.g., as a SaaS product or distributed binary), legal review of the MPL-2.0 copyleft obligations should be conducted.

7. **[Low] Consider adding `npm run preview` to the README.** The `preview` script exists in `package.json` but is undocumented. It is a minor gap — useful for testing production builds locally before deploying — and a one-line addition to the README would make it discoverable.

8. **[Low] Consider consolidating duplicate ESLint rule overrides.** The `no-unsafe-*` rules are listed independently in both the frontend and server config blocks. Extracting them into a shared `sharedRuleOverrides` constant would make the ESLint config easier to audit and update in one place.
