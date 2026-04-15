# Repository Health Assessment — 2026-04-14

**Assessed by:** Automated health agent  
**Branch at assessment:** `main` (HEAD: `aee990a`)  
**Last tag:** `v0.6.3` (2026-04-12)

---

## Summary

**Overall Health Rating: Good**

The codebase is in solid shape. TypeScript strict mode is fully enforced across all configs, there are zero outstanding TODO/FIXME comments, all dependency license concerns are pre-acknowledged in `package.json`, and CI is active. The main areas needing attention are: (1) a debug-labelled commit on `main` that added lifecycle logging and has not been cleaned up, (2) a runaway `codekin/reports` branch that is 467 commits behind `main`, (3) 75 unmerged remote branches creating clutter, (4) 6 open doc-only PRs awaiting merge, and (5) a handful of ESLint type-unsafe rules configured as warnings rather than errors.

| Category | Status | Key Stat |
|---|---|---|
| Dead code | ✅ Clean | Build enforces `noUnusedLocals`/`noUnusedParameters`; 1 debug commit flagged |
| TODO/FIXME | ✅ Clean | 0 items found |
| Config drift | ⚠️ Minor | 5 ESLint `warn`-level rules could be `error`; no prettier/ESLint bridge |
| License compliance | ✅ Clean | MPL-2.0 deps pre-documented; all others permissive |
| Documentation | ⚠️ Minor | `ProcessCoordinator` (#404) and rate-limiter changes (#397) not reflected in docs |
| Stale branches | ⚠️ Moderate | 75 unmerged; 7 merged-but-not-deleted; `codekin/reports` massively diverged |
| Open PRs | ⚠️ Minor | 6 open (all docs); #402 has merge conflicts |
| Merge conflict risk | ⚠️ Moderate | `codekin/reports` is 62 ahead/467 behind main |

---

## Dead Code

The TypeScript compiler enforces `noUnusedLocals: true` and `noUnusedParameters: true` in all three tsconfigs, which eliminates most local dead code at compile time. No orphan files or clearly unreachable code were identified in the source tree. However, one concern warrants review:

| File | Export / Symbol | Type | Recommendation |
|---|---|---|---|
| `server/claude-process.ts` (and related) | Lifecycle debug `console.log` calls added in #406 | Debug code in production | Remove or gate behind `DEBUG` flag after the first-message-lost bug is resolved |

**Note on exported symbols:** Cross-module unused exports are not caught by `noUnusedLocals`. A tool like `ts-prune` or `knip` would provide a definitive scan; running one is recommended as a follow-up (see Recommendations #3).

---

## TODO/FIXME Tracker

**Scan coverage:** `src/**/*.{ts,tsx}`, `server/**/*.ts`

No actionable `TODO`, `FIXME`, `HACK`, `XXX`, or `WORKAROUND` comments were found in any source file. The only occurrences of these tokens appear inside test string fixtures testing grep-pattern logic (not actual code debt markers).

| Type | Count |
|---|---|
| TODO | 0 |
| FIXME | 0 |
| HACK | 0 |
| XXX | 0 |
| WORKAROUND | 0 |
| **Total** | **0** |
| Stale (>30 days) | 0 |

---

## Config Drift

### TypeScript (`tsconfig.app.json`, `tsconfig.node.json`, `server/tsconfig.json`)

All three configs are modern and well-configured. No significant drift.

| Config file | Setting | Current value | Assessment |
|---|---|---|---|
| `tsconfig.app.json` | `strict` | `true` | ✅ |
| `tsconfig.app.json` | `noUnusedLocals` / `noUnusedParameters` | `true` | ✅ |
| `tsconfig.app.json` | `target` | `ES2022` | ✅ Modern |
| `tsconfig.app.json` | `erasableSyntaxOnly` | `true` | ✅ Forward-looking (Node 22 native TS) |
| `tsconfig.app.json` | `verbatimModuleSyntax` | `true` | ✅ Prevents type-import pollution |
| `server/tsconfig.json` | `moduleResolution` | `NodeNext` | ✅ Correct for Node |
| All | `skipLibCheck` | `true` | ⚠️ Suppresses errors in `node_modules` — acceptable but masks bad type declarations |

### ESLint (`eslint.config.js`)

ESLint uses modern flat config with `typescript-eslint strictTypeChecked` — excellent baseline. However, several type-safety rules are downgraded to warnings:

| Rule | Current level | Recommended level | Rationale |
|---|---|---|---|
| `@typescript-eslint/no-unsafe-assignment` | `warn` | `error` | Unsafe assignments silently pass in CI |
| `@typescript-eslint/no-unsafe-argument` | `warn` | `error` | Same concern |
| `@typescript-eslint/no-unsafe-member-access` | `warn` | `error` | Same concern |
| `@typescript-eslint/no-unsafe-return` | `warn` | `error` | Same concern |
| `@typescript-eslint/no-non-null-assertion` | `warn` | `error` or code review | Non-null assertions in production paths are runtime risks |

Additionally, `eslint-config-prettier` is not installed. Without it, Prettier and ESLint formatting rules can conflict silently. Not a blocker today, but a `prettier --check` pre-commit hook or the bridge package would eliminate the ambiguity.

Test files use `tseslint.configs.recommended` (weaker) rather than `strictTypeChecked` — this is a common and reasonable trade-off.

### Prettier (`.prettierrc`)

```json
{ "semi": false, "singleQuote": true, "trailingComma": "all", "printWidth": 120, "tabWidth": 2 }
```

All settings are consistent with the declared stack. `printWidth: 120` is wider than the community default (80) but an explicit project preference. No drift detected.

---

## License Compliance

Project license: **MIT**

| License | Package count | Permissive? | Notes |
|---|---|---|---|
| MIT | 465 | ✅ | |
| ISC | 22 | ✅ | Functionally equivalent to MIT |
| Apache-2.0 | 18 | ✅ | Compatible with MIT distribution |
| BSD-3-Clause | 9 | ✅ | |
| BSD-2-Clause | 8 | ✅ | |
| MPL-2.0 | 12 | ⚠️ See note | All are `lightningcss` platform packages |
| (MPL-2.0 OR Apache-2.0) | 1 | ✅ | `dompurify` — Apache-2.0 elected |
| BlueOak-1.0.0 | 4 | ✅ | Permissive |
| MIT-0 | 2 | ✅ | No-attribution variant of MIT |
| CC-BY-4.0 | 1 | ✅ | Documentation only |
| CC0-1.0 | 1 | ✅ | Public domain |
| 0BSD | 1 | ✅ | |
| (MIT OR WTFPL) | 1 | ✅ | MIT elected |
| (BSD-2-Clause OR MIT OR Apache-2.0) | 1 | ✅ | |

**Flagged dependencies:**

| Package | License | Issue | Status |
|---|---|---|---|
| `lightningcss` + 11 platform packages | MPL-2.0 | File-level copyleft | ✅ Pre-documented in `package.json#licenseNotes` as build-time only; not shipped in distributed artifacts |
| `dompurify` | MPL-2.0 OR Apache-2.0 | Dual-license | ✅ Pre-documented; Apache-2.0 is permissive and compatible |

**Conclusion:** All MPL-2.0 dependencies are either build-time-only tools or carry a permissive alternative. The `licenseNotes` field in `package.json` explicitly acknowledges both. No compliance action required.

---

## Documentation Freshness

### API Docs / Feature Docs

Recent code changes were compared against `docs/` content to identify potential staleness:

| Code change | PR/commit | Docs file likely affected | Status |
|---|---|---|---|
| `ProcessCoordinator` — new unified session lifecycle class | #404 (2026-04-13) | `docs/API-REFERENCE.md`, `docs/FEATURES.md` | ⚠️ Docs predate this refactor; session lifecycle section may be stale |
| Rate limiter map cap + attachment file size limit | #397 (2026-04-13) | `docs/API-REFERENCE.md` (rate limiting section) | ⚠️ New limits not documented |
| Auto-setup GitHub webhook for PR Review workflows | #391 (2026-04-12) | `docs/GITHUB-WEBHOOKS-SPEC.md`, `docs/PR-REVIEW-WEBHOOK.md` | ⚠️ Wizard behaviour may not be reflected |
| Security hardening: path traversal, trust proxy, image src allowlist | #394 (2026-04-12) | `docs/API-REFERENCE.md` (security headers) | ⚠️ `trust proxy` and allowlist not documented |
| Provider selection + searchable model picker in workflows | #375 (2026-04-12) | `docs/WORKFLOWS.md` | ⚠️ Provider field addition likely missing |

### README Drift

The README was reviewed against `package.json` scripts and the current project structure:

| README claim | Actual state | Status |
|---|---|---|
| `npm run dev` | Matches `package.json` → `"dev": "vite"` | ✅ |
| `npm run build` | Matches → `"build": "tsc -b && vite build"` | ✅ |
| `npm test` | Matches → `"test": "vitest run"` | ✅ |
| `npm run lint` | Matches → `"lint": "eslint ."` | ✅ |
| `npm run test:watch` | Matches → `"test:watch": "vitest"` | ✅ |
| Port 32352 | Matches server default | ✅ |
| Screenshot (`docs/screenshot.png`) | Updated 2026-04-12 | ✅ |
| `CLAUDE.md` description ("Web-based terminal UI for Claude Code sessions") | README now references both Claude Code and OpenCode | ⚠️ CLAUDE.md description is slightly stale (does not mention OpenCode) — low impact |

No broken install steps, paths, or script references found. README is in good shape.

---

## Draft Changelog

### Since `v0.6.3` (2026-04-12) — Unreleased

#### Fixes
- **Edit Workflow modal:** widen modal to prevent day-label clipping (#408)
- **Session lifecycle:** prevent spurious `reconfigure` call when model is first assigned to a new session (#407)

#### Debug / In-progress
- Add lifecycle logging to diagnose first-message-lost bug (#406) — **note: debug code, not production-ready**

---

### `v0.6.3` period — 2026-04-07 to 2026-04-12

#### Features
- **ProcessCoordinator:** unified session lifecycle coordinator replacing ad-hoc per-process management (#404)
- **Auto-webhook setup:** automatically configure GitHub webhook when creating a PR Review workflow (#391)
- **Workflow model picker:** provider selection (Claude / OpenCode) and searchable model picker in workflow editor (#375)
- **Webhook health checks:** GitHub webhook integration health indicators and setup wizard (#373)

#### Fixes
- Polish Edit Workflow modal: frequency highlights, day grid, model default (#403, #405)
- Improve/streamline Edit Workflow modal layout — two-column design (#393, #401)
- Address GPT review feedback on report commit robustness (#400)
- Unify workflow report commit/push across MD and Stepflow systems (#398)
- Add API rate limiter map cap and attachment file size limit (#397)
- Harden path traversal, trust proxy, and image src allowlist (#394)
- Show 'Session started' immediately on startup, not empty chat (#386)
- Separate reasoning from text in OpenCode streaming for Kimi models
- Prevent model/session message cascade on OpenCode session start
- Resolve duplicate model messages and mixed thinking text for OpenCode (#385)
- Persist OpenCode model selection across sessions (#384)
- Show model info only once per session, not every turn (#383)
- Resolve deadlock preventing Claude session start (#382)
- Overhaul session lifecycle: fix crashes, message loss, duplicate notifications (#381)
- Prevent message loss when Claude process exits before `system_init` (#380)
- Prevent session restart loops from process lifecycle races (#379)
- Preserve user input for session naming (#378)
- Persist OpenCode provider when saving workflow config (#377)
- Probe OpenCode availability on startup for accurate connection status (#376)
- Tighten retry regex patterns and deduplicate model dropdown entries (#372)
- Set `NODE_ENV=test` in vitest config to prevent `act-is-not-a-function` failures (#371)
- Resolve eslint template literal error in `claude-process` (#369)
- Address 5 small issues from audit reports (#366)
- Validate model when switching between claude and opencode sessions (#363)
- Prevent symlink-based path traversal in docs and reports endpoints (#358)
- Address 4 server correctness bugs from code review (#359)
- Harden server security: auth, rate limiting, CSP, WebSocket origin (#355)

#### Documentation
- Session initiation audit report (#399)
- Update changelog and README to feature OpenCode support (#357)

#### Chores
- Release `v0.6.3`
- Bump version to `v0.6.1` (#364)

---

## Stale Branches

**Stale threshold:** 30 days (cutoff: 2026-03-15)

**Result: No branches are older than 30 days.** The oldest branches date to 2026-04-09. The repository is in a period of very high activity.

However, the following **merged** branches are still present on the remote and can be safely deleted:

| Branch | Last commit date | Author | Merged into main? | Recommendation |
|---|---|---|---|---|
| `origin/docs/changelog-readme-v0.5.5` | 2026-04-10 | alari | ✅ Yes | Delete |
| `origin/feat/model-picker-search` | 2026-04-12 | alari | ✅ Yes | Delete |
| `origin/feat/oc-tag-position` | 2026-04-11 | alari | ✅ Yes | Delete |
| `origin/fix/apr11-reliability-security` | 2026-04-11 | alari | ✅ Yes | Delete |
| `origin/fix/enforce-report-file-output` | 2026-04-10 | alari | ✅ Yes | Delete |
| `origin/fix/opencode-model-and-thinking` | 2026-04-12 | alari | ✅ Yes | Delete |
| `origin/fix/security-hardening-apr12` | 2026-04-12 | alari | ✅ Yes | Delete |

**Total remote branches: 83** (75 unmerged, 7 merged-not-deleted, 1 main)

The number of short-lived feature/fix branches is high (expected for this workflow), but the accumulation will become harder to navigate. A periodic cleanup cadence (e.g., delete merged branches weekly) is recommended.

---

## PR Hygiene

All open PRs as of 2026-04-14:

| PR# | Title | Author | Days open | Reviews | Mergeable | Stuck? |
|---|---|---|---|---|---|---|
| #374 | docs: Add audit report for PR #373 | alari76 | 2 | 0 | ✅ MERGEABLE | No |
| #390 | docs: PR code review audit (2026-04-12) | alari76 | 2 | 0 | ✅ MERGEABLE | No |
| #392 | docs: add daily code review report 2026-04-12 | alari76 | 2 | 0 | ✅ MERGEABLE | No |
| #395 | docs: repo health report 2026-04-13 | alari76 | 1 | 0 | ✅ MERGEABLE | No |
| #396 | docs: test coverage report 2026-04-13 | alari76 | 1 | 0 | ✅ MERGEABLE | No |
| #402 | docs: session restart root cause audit | alari76 | 1 | 0 | ⛔ CONFLICTING | No (age) |

**None are stuck** (>7 days with no activity). All are documentation-only PRs.

**Action needed on #402:** Merge conflict must be resolved before this PR can land.

**Observation:** All 6 open PRs are docs/audit reports generated by automated agents. They are accumulating faster than they are being merged. Establishing a regular merge cadence for these (e.g., batch-merge weekly) would reduce PR queue noise.

---

## Merge Conflict Forecast

Active branches (commits within last 14 days) compared against `main`:

| Branch | Last commit | Commits ahead | Commits behind | Risk level | Notes |
|---|---|---|---|---|---|
| `origin/codekin/reports` | 2026-04-13 | 62 | 467 | 🔴 Critical | Long-running reports accumulation branch; massively diverged. High conflict risk if rebased or merged |
| `origin/feat/process-coordinator` | 2026-04-13 | 6 | 6 | 🟡 Medium | Session lifecycle changes; may overlap with #407/#406 on main |
| `origin/feat/test-coverage-2026-04-13` | 2026-04-13 | 3 | 11 | 🟡 Medium | 11 commits behind; test files may conflict with recent server changes |
| `origin/feat/repo-health-2026-04-13` | 2026-04-13 | 2 | 11 | 🟡 Low-medium | Report files only; low code conflict risk but merge needed |
| `origin/docs/session-initiation-audit` | 2026-04-13 | 2 | 9 | 🟢 Low | Docs only |
| `origin/fix/first-message-lost` | 2026-04-13 | 1 | 4 | 🟢 Low | May be superseded by #407 already merged to main |
| `origin/fix/first-message-lost-reconfigure` | 2026-04-13 | 1 | 2 | 🟢 Low | May be superseded by #407 |
| `origin/fix/edit-workflow-polish-2` | 2026-04-13 | 1 | 4 | 🟢 Low | Likely superseded by #408 |
| `origin/fix/workflow-modal-width` | 2026-04-13 | 1 | 1 | 🟢 Low | Likely superseded by #408 |
| All other branches | 2026-04-12 | 0–2 | 12–27 | 🟢 Low | Merged or superseded |

**Key concern:** `origin/codekin/reports` at 62 ahead / 467 behind is the highest-risk entry. This branch appears to be a long-running accumulation of report commits that diverged from main early and has never been reconciled. It should either be rebased/reset to main or treated as an independent archive branch and never merged. Attempting a merge as-is would produce hundreds of conflicts.

**Secondary concern:** `origin/feat/process-coordinator` (6 ahead, 6 behind) addresses the same session lifecycle area as recent main commits (#406, #407). If this branch is still active it should be rebased before merging.

---

## Recommendations

Ordered by impact:

1. **Clean up debug commit #406** — The commit `debug: add lifecycle logging to diagnose first-message-lost bug` was merged to `main` with lifecycle `console.log` calls for diagnostic purposes. Once the root cause is confirmed (or fixed), these logs should be removed or gated behind a `DEBUG` environment variable to avoid leaking internal state in production.

2. **Resolve or abandon `origin/codekin/reports`** — This branch is 467 commits behind `main` and 62 ahead. It cannot be cleanly merged. Decide: (a) reset it to current `main` and cherry-pick the 62 report commits, or (b) close it as a historical archive and stop using it as a target branch.

3. **Run `knip` or `ts-prune` for unused export detection** — TypeScript's `noUnusedLocals` does not catch exported symbols that are never imported. A one-time run of a dead-export scanner would confirm whether the codebase is truly free of unused public API surface.

4. **Merge or close the 6 open doc PRs** — PRs #374, #390, #392, #395, #396 are all mergeable. PR #402 needs conflict resolution. Batching these docs merges weekly rather than letting them accumulate would keep the PR queue clean.

5. **Delete 7 merged remote branches** — `docs/changelog-readme-v0.5.5`, `feat/model-picker-search`, `feat/oc-tag-position`, `fix/apr11-reliability-security`, `fix/enforce-report-file-output`, `fix/opencode-model-and-thinking`, `fix/security-hardening-apr12` are all merged into main and safe to delete.

6. **Elevate 4 ESLint `no-unsafe-*` rules from `warn` to `error`** — `no-unsafe-assignment`, `no-unsafe-argument`, `no-unsafe-member-access`, and `no-unsafe-return` being warnings means CI passes despite type-unsafe code. Elevating these would harden the type safety guarantee.

7. **Update `docs/WORKFLOWS.md` and `docs/API-REFERENCE.md` for recent features** — The `ProcessCoordinator` refactor (#404), rate limiter caps (#397), and provider/model picker in workflows (#375) changed observable behaviour but docs were not updated alongside. These sections should be brought current.

8. **Document the auto-webhook setup wizard in `docs/GITHUB-WEBHOOKS-SPEC.md`** — Feature added in #391 (2026-04-12). The spec predates it.

9. **Add `eslint-config-prettier`** — Without it, ESLint formatting rules (e.g. spacing, quotes) can silently conflict with Prettier. Adding the bridge package disables ESLint rules that Prettier owns and removes the ambiguity.

10. **Establish a branch cleanup policy** — With 83 remote branches all created in 5 days, the remote is growing quickly. A policy of auto-deleting merged branches (GitHub has a "Automatically delete head branches" repository setting) would prevent the current accumulation from recurring.
