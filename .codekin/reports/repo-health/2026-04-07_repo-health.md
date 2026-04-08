# Repository Health Assessment — codekin

**Date**: 2026-04-07
**Branch**: main
**Assessed by**: Claude (automated)

---

## Summary

**Overall Health: Excellent**

The repository is in strong shape. Code discipline is high — zero TODO/FIXME comments, strict TypeScript across all layers, comprehensive ESLint coverage, and regular automated auditing has kept technical debt minimal. The main areas of attention are a handful of stale remote branches pending deletion, some API/protocol documentation that hasn't been refreshed since March 16 despite significant server-side changes in early April, and a batch of ESLint rules intentionally downgraded to warnings that represent a known incremental-cleanup backlog.

| Metric | Value |
|---|---|
| Dead code items | 0 |
| Stale TODO/FIXMEs | 0 |
| Config issues | 2 (minor) |
| License concerns | 0 (MPL devDeps are build-only) |
| Doc drift items | 3 files not updated since March 16 |
| Stale branches | 5 (4 merged, 1 squash-merged stale) |
| Open PRs | 0 |
| Stuck PRs | 0 |

---

## Dead Code

No dead exports, unreachable functions, or orphan files were detected.

All 198 named exports across `server/*.ts` have confirmed importers. All React components in `src/components/`, custom hooks in `src/hooks/`, and library utilities have active consumers. Entry points (`main.tsx`, `ws-server.ts`) and test files were excluded from orphan analysis.

| File | Export/Function | Type | Recommendation |
|---|---|---|---|
| — | — | — | No items found |

---

## TODO/FIXME Tracker

A scan of all `.ts`, `.tsx`, `.js`, and `.mjs` files under `src/` and `server/` (excluding `node_modules`, `dist/`, and test fixture strings) found **zero** TODO, FIXME, HACK, XXX, or WORKAROUND comments in production code. Three test-file matches for the string `'TODO'` were confirmed to be test fixture values in `server/claude-process.test.ts`, not real annotations.

| File:Line | Type | Comment | Author | Date | Stale? |
|---|---|---|---|---|---|
| — | — | — | — | — | — |

**Summary:** 0 total · 0 by type · 0 stale (≥30 days old)

---

## Config Drift

### tsconfig.app.json

| Setting | Current Value | Status |
|---|---|---|
| `target` | `ES2022` | ✓ Appropriate for modern browser target |
| `strict` | `true` | ✓ |
| `noUnusedLocals` | `true` | ✓ |
| `noUnusedParameters` | `true` | ✓ |
| `noFallthroughCasesInSwitch` | `true` | ✓ |
| `noUncheckedSideEffectImports` | `true` | ✓ (TS 6 addition) |
| `erasableSyntaxOnly` | `true` | ✓ (TS 6 addition, enables native-strip compatibility) |
| `verbatimModuleSyntax` | `true` | ✓ |
| `skipLibCheck` | `true` | Acceptable; speeds up builds at cost of type safety in third-party .d.ts files |

### server/tsconfig.json

| Setting | Current Value | Status |
|---|---|---|
| `target` | `ES2022` | ✓ |
| `module` | `NodeNext` | ✓ Correct for ESM Node.js |
| `strict` | `true` | ✓ |
| `isolatedModules` | `true` | ✓ |
| `composite` | `true` | ✓ Enables project references |

### eslint.config.js

**Finding 1 — `ecmaVersion: 2020` inconsistent with TS target ES2022.**
Both the frontend and server ESLint blocks set `ecmaVersion: 2020`, but TypeScript targets ES2022. This means ESLint won't validate use of ES2021 (`Promise.any`, logical assignment operators) or ES2022 (`Array.at`, `Object.hasOwn`, class static blocks) syntax. Low risk since TypeScript enforces the actual type constraints, but the mismatch can cause false ESLint errors on valid ES2022 syntax.
- **Current**: `ecmaVersion: 2020`
- **Recommended**: `ecmaVersion: 2022`

**Finding 2 — 10 ESLint rules intentionally demoted to warnings pending incremental cleanup.**
The config contains a documented comment noting these are pre-existing patterns being cleaned up. This is a known, managed backlog — not an oversight. Tracked here for visibility.

Rules currently at `warn` that should eventually reach `error`:

| Rule | Risk if warned |
|---|---|
| `@typescript-eslint/no-unsafe-assignment` | Type safety gap |
| `@typescript-eslint/no-unsafe-argument` | Type safety gap |
| `@typescript-eslint/no-unsafe-member-access` | Type safety gap |
| `@typescript-eslint/no-unsafe-return` | Type safety gap |
| `@typescript-eslint/no-non-null-assertion` | Runtime crash risk |
| `@typescript-eslint/no-misused-promises` | Async logic bugs |
| `@typescript-eslint/restrict-template-expressions` | Unintended string coercions |
| `@typescript-eslint/no-unnecessary-condition` | Dead branch risk |
| `@typescript-eslint/no-confusing-void-expression` | Logic bugs |
| `@typescript-eslint/require-await` | Async overhead |

### .prettierrc

```json
{ "semi": false, "singleQuote": true, "trailingComma": "all", "printWidth": 120, "tabWidth": 2 }
```

No drift found. Configuration is intentional and consistent with project style.

---

## License Compliance

The project is licensed under its own terms (distributed as an npm package). No GPL, AGPL, or strong-copyleft licenses are present in direct dependencies.

### Production dependencies (runtime)

| License | Count | Packages |
|---|---|---|
| MIT | 100 | (bulk of transitive deps) |
| ISC | 7 | — |
| Apache-2.0 | 2 | — |
| BSD-3-Clause | 2 | — |
| (MIT OR WTFPL) | 1 | expand-template |
| (BSD-2-Clause OR MIT OR Apache-2.0) | 1 | — |

### All dependencies (including devDependencies)

| License | Count |
|---|---|
| MIT | 441 |
| ISC | 20 |
| Apache-2.0 | 18 |
| BSD-3-Clause | 9 |
| BSD-2-Clause | 8 |
| MPL-2.0 | 3 |
| MIT-0 | 2 |
| BlueOak-1.0.0 | 2 |
| CC-BY-4.0 | 1 |
| (MPL-2.0 OR Apache-2.0) | 1 |
| CC0-1.0 | 1 |
| 0BSD | 1 |

### Flagged dependencies

| Package | License | Type | Note |
|---|---|---|---|
| `lightningcss` + platform variants | MPL-2.0 | devDependency (build tool) | Transitive via TailwindCSS 4. Build-time only — not distributed in the runtime bundle or shipped to end users. No copyleft obligation. |
| `dompurify` | MPL-2.0 OR Apache-2.0 | devDependency (bundled) | Dual-licensed. The Apache-2.0 option is permissive. Bundled into the frontend. Acceptable. |

**No action required.** No GPL/AGPL licenses found anywhere in the dependency tree. The MPL packages either are build-time only or carry permissive license alternatives.

---

## Documentation Freshness

### Last-updated dates per docs file

| File | Last Updated | Days Since Update |
|---|---|---|
| `docs/API-REFERENCE.md` | 2026-03-16 | 22 days |
| `docs/FEATURES.md` | 2026-03-16 | 22 days |
| `docs/ORCHESTRATOR-SPEC.md` | 2026-03-16 | 22 days |
| `docs/stream-json-protocol.md` | 2026-03-16 | 22 days |
| `docs/GITHUB-WEBHOOKS-SPEC.md` | 2026-03-16 | 22 days |
| `docs/INSTALL-DISTRIBUTION.md` | 2026-04-01 | 6 days |
| `docs/SETUP.md` | 2026-04-01 | 6 days |
| `docs/WORKFLOWS.md` | 2026-04-01 | 6 days |

### Potential stale docs vs recent code changes (since March 16)

The following substantive server-side changes landed after the last batch doc update on March 16:

| Change | Commit | Date | Affected Doc |
|---|---|---|---|
| Approvals architecture overhaul for parity with native CLI (`#280`) | `da1e26b` | Apr 3 | `stream-json-protocol.md`, `API-REFERENCE.md` |
| `--dangerously-skip-permissions` permission mode added (`#276`) | `34dae11` | Apr 3 | `stream-json-protocol.md`, `FEATURES.md` ✓ |
| Subscription auth support and standalone CLI session unblocking (`#283`) | `86ab1b5` | Apr 4 | `SETUP.md`, `API-REFERENCE.md` |
| Session process lifecycle overhaul — restart loop fix, idle reaper exemptions (`#288`, `#290`, `#292`) | `b800e22`, `42e228c`, `5218005` | Apr 3–5 | `ORCHESTRATOR-SPEC.md` (lifecycle section) |
| Security audit fixes W-01, W-02, W-03 | `3f1047e` | Apr 4 | — |

**Note:** `dangerouslySkipPermissions` is already documented in `FEATURES.md` and `stream-json-protocol.md` — no drift there. The approvals architecture overhaul and subscription auth additions are the highest-priority doc gaps.

### README Drift

The `README.md` is an end-user installation/usage guide (not a developer reference). It correctly describes the CLI commands (`codekin token`, `codekin upgrade`, etc.) and does not list development scripts — those live in `CLAUDE.md`.

`CLAUDE.md` lists the following dev scripts, all of which match `package.json` exactly:

| Script in CLAUDE.md | package.json | Status |
|---|---|---|
| `npm install` | standard | ✓ |
| `npm run dev` | `vite` | ✓ |
| `npm run build` | `tsc -b && vite build` | ✓ |
| `npm test` | `vitest run` | ✓ |
| `npm run test:watch` | `vitest` | ✓ |
| `npm run lint` | `eslint .` | ✓ |

No README/CLAUDE.md drift found.

---

## Draft Changelog

The following covers commits since **2026-04-01** (last 7 days), grouped by category. The most recent tag is `v0.5.4` (released April 6); the items below are already included in that release.

### v0.5.4 — 2026-04-06

#### Fixes

- Fall back to fresh session when `--resume` hangs with zero output — prevents infinite restart loops on long-lived and orchestrator sessions (#292)
- Stabilize Claude process lifecycle to prevent restart loops caused by race condition in `startClaude()` (#290, #288)
- Exempt agent/orchestrator sessions from idle reaper and stale session pruner (#289)
- Support subscription (OAuth) auth and unblock standalone CLI sessions (#283)
- Address 5 code review findings: W-02, W-03, W-04, W-09, I-09 (#282)
- Overhaul approvals architecture for parity with native Claude CLI (#280)
- Pass `CODEKIN_SKIP_PERMISSIONS` env var to hooks when `dangerouslySkipPermissions` is active
- Address 3 security audit warnings (W-01, W-02, W-03)
- Repo cleanup: remove dead export, fix docs drift, add logging to previously-silent error catches

#### Features

- Add `--dangerously-skip-permissions` as a configurable permission mode setting (#276)

#### Documentation

- Update API reference, orchestrator spec, protocol docs, and changelog (March 16 batch)
- Update changelog and readme for v0.5.4

#### Chores

- Bump version to 0.5.4
- Add code review and repo health reports for 2026-04-04 through 2026-04-06
- Fix ESLint worktree linting issue in CI

---

## Stale Branches

All remote branches (excluding `main`) and their status:

| Branch | Last Commit | Last Author | Merged to main? | Recommendation |
|---|---|---|---|---|
| `chore/reports-2026-04-06` | 2026-03-16 | alari | Yes (squash) | **Delete** — merged, 22 days stale |
| `docs/changelog-readme-v0.5.4` | 2026-03-16 | alari | Yes (squash) | **Delete** — merged, 22 days stale |
| `fix/code-review-2026-04-05` | 2026-03-16 | alari | Yes (squash) | **Delete** — merged, 22 days stale |
| `fix/repo-cleanup-2026-04-06` | 2026-03-16 | alari | Yes (squash) | **Delete** — merged, 22 days stale |
| `fix/resume-hang-fallback` | 2026-03-16 | alari | Effectively yes¹ | **Delete** — squash-merged as #292; branch has minor log-verbosity divergences only |

¹ `fix/resume-hang-fallback` was squash-merged into main as commit `5218005` (PR #292). Git does not detect it as merged because squash merges break the ancestry chain. The branch differs from main in only 3 files (`claude-process.ts`, `session-manager.ts`, `session-manager.test.ts`) with minor differences in error-log verbosity (the main branch is more verbose following the April 6 cleanup commit `57516a9`). The branch is safe to delete.

---

## PR Hygiene

```
gh pr list --state open
```

**Result: No open PRs.**

The repository has a clean PR queue. All recent work has been merged.

---

## Merge Conflict Forecast

Only one branch diverges from `main`:

| Branch | Commits Ahead | Commits Behind | Diverging Files | Overlap with main? | Risk |
|---|---|---|---|---|---|
| `fix/resume-hang-fallback` | 1 | 9 | `server/claude-process.ts`, `server/session-manager.ts`, `server/session-manager.test.ts` | Yes — all 3 files have since been modified on `main` | Low — branch is a superseded squash-merge artifact; main's version is strictly superior. No rebase needed. |

No other active branches (commits in last 14 days) diverge from main.

---

## Recommendations

Ordered by impact:

1. **Delete 5 stale remote branches** — `fix/resume-hang-fallback`, `chore/reports-2026-04-06`, `docs/changelog-readme-v0.5.4`, `fix/code-review-2026-04-05`, `fix/repo-cleanup-2026-04-06`. All are either squash-merged or already superseded by main. Command: `git push origin --delete fix/resume-hang-fallback chore/reports-2026-04-06 docs/changelog-readme-v0.5.4 fix/code-review-2026-04-05 fix/repo-cleanup-2026-04-06`

2. **Refresh `docs/stream-json-protocol.md` and `docs/API-REFERENCE.md`** — The approvals architecture was overhauled in PR #280 (April 3). These two files were last updated March 16 and may not reflect the new approval flow, `requestId` handling, or the subscription-auth endpoints added in PR #283.

3. **Update `docs/ORCHESTRATOR-SPEC.md`** for session lifecycle changes — PRs #288, #289, #290, #292 made significant changes to how sessions start, restart, and are reaped. The orchestrator spec's lifecycle section should be reviewed for accuracy.

4. **Promote ESLint warning backlog to errors incrementally** — 10 `@typescript-eslint` rules are intentionally at `warn`. The highest-priority candidates for promotion (most likely to catch real bugs) are: `no-unsafe-assignment`, `no-unsafe-argument`, `no-non-null-assertion`, and `no-misused-promises`. Consider a quarterly ticket to reduce this list.

5. **Bump `ecmaVersion` to `2022` in `eslint.config.js`** — Both frontend and server blocks set `ecmaVersion: 2020`, inconsistent with the TypeScript ES2022 target. This is a one-line change in two places and prevents potential false ESLint errors on valid ES2022 syntax.

6. **Add `docs/` freshness check to weekly audit workflow** — Several docs files drifted 22 days without a corresponding update. The existing automated audit already flags code drift but could be extended to cross-reference `git log --since` on both `server/*.ts` and `docs/*.md` to surface this automatically.

7. **Consider promoting `skipLibCheck: true` discussion** — Both tsconfigs skip third-party `.d.ts` checking. This is common practice but means type errors in packages are invisible. As the project matures this trade-off is worth re-evaluating, especially for critical dependencies like `express` and `ws`.
