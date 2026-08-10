# Repository Health: codekin

**Date**: 2026-08-10T03:19:27.851Z
**Repository**: /srv/repos/Multiplier-Labs/codekin
**Branch**: main
**Workflow Run**: 6818986d-9482-4708-b1e1-2ce54ca1636c
**Session**: 7a0b8de4-c33c-4c0d-b142-06b426dcee6b

---

I now have enough data to produce the report.

---

# Codekin Repository Health Report — 2026-08-10

## Summary

**Overall Health: Good**

The codebase is actively developed (40+ commits since `v0.8.0`, released 2026-08-04), has strong TypeScript strictness, and a well-structured ESLint config. No dead code of concern was found. The only maintenance debt is a backlog of stale remote branches (21 audit branches and 10+ feature branches never formally deleted) and 4 modified-but-uncommitted files sitting in the working tree that represent an in-flight GPT model ID update. No GPL/AGPL license risks; the two flagged MPL-2.0 packages are already acknowledged in `package.json`. No open PRs detected.

| Metric | Count |
|---|---|
| Dead code items | 0 confirmed (2 types reviewed, both used) |
| TODO/FIXME comments | 0 (only test-fixture occurrences) |
| Config issues | 1 minor (ESLint warnings deferred for "incremental adoption") |
| License concerns | 0 new (MPL-2.0 packages documented in package.json) |
| Doc drift items | 1 (API-REFERENCE model example, in-progress fix already staged) |
| Stale branches (>30 days, not merged) | 29 |
| Open PRs | 0 (no open PRs on GitHub remote) |
| Merge conflict risk | Low-medium on 10 active feature branches |

---

## Dead Code

No confirmed dead exports or orphan files were found. The TypeScript compiler is configured with `noUnusedLocals: true` and `noUnusedParameters: true` across all tsconfigs — this eliminates the most common class of dead code at compile time.

Two types in `src/types.ts` that warranted spot-checking are actively used:

| File | Export | Finding |
|---|---|---|
| `src/types.ts:300` | `DocsPickerProps` | Used in `src/components/CommandPalette.tsx:12` — **not dead** |
| `src/types.ts:311` | `MobileProps` | Used in `src/components/LeftSidebar.tsx:17` — **not dead** |

**Recommendation:** The compiler strictness is doing its job. No manual removals required.

---

## TODO/FIXME Tracker

A full codebase scan found **zero** `TODO`, `FIXME`, `HACK`, `XXX`, or `WORKAROUND` comments in production source files. The four apparent hits were all inside test files where those strings appear as **test fixture data** (e.g. a `grep` pattern of `'TODO'` in test expectations), not as action items.

| File:Line | Type | Comment | Stale? |
|---|---|---|---|
| `server/claude-process.test.ts:60-61` | test fixture | `pattern: 'TODO'` inside a `summarizeToolInput` test | Not a comment — test data |
| `server/opencode-process.test.ts:971` | test fixture | `pattern: 'TODO'` inside a test assertion | Not a comment — test data |
| `server/relay/pairing-routes.test.ts:211` | test fixture | `code=XXXX-YYYY` in a 404 assertion | Not a comment — test data |
| `src/hosted/PairPage.tsx:1,153` | JSDoc / placeholder | `/** Approval screen … */` + `placeholder="XXXX-XXXX"` | Not action items |

**Summary:** 0 action-item TODOs/FIXMEs. 0 stale items.

---

## Config Drift

### `tsconfig.app.json` and `tsconfig.node.json`

Both are well-configured. All recommended strict flags are enabled.

| Setting | Value | Assessment |
|---|---|---|
| `strict` | `true` | ✅ |
| `noUnusedLocals` | `true` | ✅ |
| `noUnusedParameters` | `true` | ✅ |
| `noImplicitReturns` | `true` | ✅ |
| `noFallthroughCasesInSwitch` | `true` | ✅ |
| `noUncheckedSideEffectImports` | `true` | ✅ |
| `erasableSyntaxOnly` | `true` | ✅ (new TS 5.5+ flag, good) |
| `target` | `ES2023` | ✅ |
| `moduleResolution` | `bundler` | ✅ (correct for Vite) |

### `server/tsconfig.json`

| Setting | Value | Assessment |
|---|---|---|
| `module` | `NodeNext` | ✅ |
| `strict` | `true` | ✅ |
| `noImplicitReturns` | absent | ⚠️ Missing — frontend tsconfigs have it; server is less strict on return paths |
| `erasableSyntaxOnly` | absent | Minor — optional, but inconsistent with app tsconfig |

### `eslint.config.js`

The config is thorough with `strictTypeChecked` applied to all non-test files, a custom semantic-token styling guard for components, and appropriate relaxations for test files.

**Findings:**

| Config File | Setting | Current Value | Recommendation |
|---|---|---|---|
| `eslint.config.js` | `@typescript-eslint/restrict-template-expressions` | `warn` | Comment says "incremental adoption" — promote to `error` as codebase stabilises |
| `eslint.config.js` | `@typescript-eslint/no-confusing-void-expression` | `warn` | Promote to `error` |
| `eslint.config.js` | `@typescript-eslint/no-misused-promises` | `warn` | This should be `error` — misused promises are runtime bugs, not style |
| `eslint.config.js` | `@typescript-eslint/no-non-null-assertion` | `warn` | Promote to `error` after clearing existing non-null assertions |
| `eslint.config.js` | `@typescript-eslint/require-await` | `warn` | Promote to `error` |
| `server/tsconfig.json` | `noImplicitReturns` | absent | Add to match app tsconfigs |

No prettier config was found — the project appears not to use Prettier, which is consistent with the codebase style (ESLint handles formatting rules).

---

## License Compliance

The project is MIT-licensed. Summary of direct and transitive dependency licenses:

| License | Count |
|---|---|
| MIT | 457 |
| ISC | 20 |
| Apache-2.0 | 17 |
| MPL-2.0 | 12 |
| BSD-3-Clause | 9 |
| BSD-2-Clause | 8 |
| (MPL-2.0 OR Apache-2.0) | 1 |
| MIT-0 | 2 |
| CC-BY-4.0 | 1 |
| CC0-1.0 | 1 |
| BlueOak-1.0.0 | 1 |
| (MIT OR WTFPL) | 1 |
| (BSD-2-Clause OR MIT OR Apache-2.0) | 1 |
| 0BSD | 1 |
| **UNKNOWN** | **2** |

**Flagged packages:**

| Package | License | Risk | Notes |
|---|---|---|---|
| `lightningcss` + 11 platform variants | MPL-2.0 | **Acknowledged** | Build-time only (used by TailwindCSS); explicitly noted in `package.json` `licenseNotes` — not distributed |
| `dompurify` | MPL-2.0 OR Apache-2.0 | **Acknowledged** | Apache-2.0 alternative selected; noted in `package.json` `licenseNotes` |
| `busboy` | UNKNOWN (uses legacy `licenses` array) | Low | Confirmed MIT via `licenses[].type` field; no action required |
| `streamsearch` | UNKNOWN (uses legacy `licenses` array) | Low | Confirmed MIT via `licenses[].type` field; no action required |

**Assessment:** No GPL/AGPL exposure. The two MPL-2.0 packages are already documented. The two "UNKNOWN" packages are MIT when inspected directly — the `package-lock.json` parser misses the legacy `licenses` array format. Consider adding an explicit `license` field to justify these if auditors ever run automated tools.

---

## Documentation Freshness

### API Docs

**In-flight changes (working tree, not yet committed):**

| File | Change | Status |
|---|---|---|
| `docs/API-REFERENCE.md` | Codex model example updated from `gpt-5.5` → `gpt-5.6-sol` | ✅ Matches in-progress code change — needs commit |
| `server/codex-process.ts` | JSDoc comment + interface updated to `gpt-5.6-sol` example | ✅ Consistent |
| `src/types.ts` | `CODEX_MODELS` static fallback list replaced (GPT-5.4/5.5 → GPT-5.6 family) | ✅ Consistent |

These four modified files appear to be one coherent, uncommitted update. No staleness — just needs to land on a branch.

### README Drift

The README is accurate relative to the codebase:

| README Claim | Actual | Status |
|---|---|---|
| `npm run dev` | Exists (`"dev": "vite"`) | ✅ |
| `npm run build` | Exists (`"build": "tsc -b && vite build"`) | ✅ |
| `npm test` | Exists (`"test": "vitest run"`) | ✅ |
| `npm run test:watch` | Exists (`"test:watch": "vitest"`) | ✅ |
| `npm run lint` | Exists (`"lint": "eslint ."`) | ✅ |
| `server/` directory | Present | ✅ |
| `src/components/` directory | Present | ✅ |

**One note:** The README's feature list mentions `build:hosted` and `dev:hosted` scripts (for hosted app), which exist in `package.json` but are not documented in the README's "Development" section. This is an omission, not a drift — the README's scope is the standard install flow.

---

## Draft Changelog

Changes since `v0.8.0` (released 2026-08-04) through 2026-08-10:

### Features
- **Hosted relay: connect directly to workspace** — Hosted app now connects straight to the machine workspace; sharing moved to the sidebar (#558)
- **One agent control for harness and model** — Composer now uses a single unified agent control for both harness selection and model picker (#559)
- **Session streaming over hosted relay** — Full streaming support over the relay transport (phase 4) (#549)
- **Session sharing, ACLs, and audit** — Session-level access control and audit logging over the hosted relay (phase 5) (#550)
- **Relay hardening** — Backpressure, rate limits, and message retention (phase 6) (#552)
- **Machine pairing and relay connector** — Pairing flow and connector bridge between local machine and hosted relay (#546)
- **Hosted control plane with GitHub auth** — app.codekin.ai control plane server with GitHub OAuth (#545)
- **Frontend transport abstraction** — Client-side transport layer that switches between local WebSocket and hosted relay (phase 1) (#544)
- **REST proxy over hosted relay** — End-to-end REST tunnelling over relay (phase 3 remainder) (#547)
- **Cross-harness session handoff** — Carry-context provider switch so sessions can be handed off across harnesses (#548)

### Fixes
- **Composer agent control tone** — Unified tone for the harness/model dropdown (#560)
- **Hosted workspace layout and diagnostics** — Layout fix + connector diagnostic improvements (#554)
- **Connector hub race condition** — Close `hello_ack` race in connector hub online test (#553)
- **Connector env overrides** — Read connector overrides from env files; keep tests hermetic (#555)
- **Codex session recovery** — Recover Codex sessions whose thread has no rollout yet (#551)
- **Relay ownership enforcement** — Enforce machine ownership, live revocation, and stream backpressure (#557)

### Documentation
- **Relay spec, plan, and operations runbook** — Added to `docs/` on main (#556)

### Chores
- `chore: sync server lockfile` (#541)
- `chore: align server tsconfig target` (#540)

---

## Stale Branches

Branches with no activity for more than 30 days. All audit/report branches are generated by automated workflows and are never merged via PR — they accumulate indefinitely.

### Automated audit branches (all stale, none merged to main via `--merged` check — squash-merged)

| Branch | Last Commit | Author | Recommendation |
|---|---|---|---|
| `audit/code-review.daily-2026-04-28` through `2026-05-04` (7 branches) | 2026-04-28 – 2026-05-04 | alari | Delete — automated, content superseded |
| `audit/comment-assessment.daily-2026-05-01`, `2026-05-08` | 2026-05-01 – 2026-05-08 | alari | Delete — automated |
| `audit/complexity.weekly-2026-04-29`, `2026-05-06` | 2026-04-29 – 2026-05-06 | alari | Delete — automated |
| `audit/dependency-health.daily-2026-04-28`, `2026-05-05` | 2026-04-28 – 2026-05-05 | alari | Delete — automated |
| `audit/docs-audit.weekly-2026-05-06` | 2026-05-06 | alari | Delete — automated |
| `audit/repo-health.weekly-2026-04-28` through `2026-05-04` (5 branches) | 2026-04-28 – 2026-05-04 | alari | Delete — automated |
| `audit/security-audit.weekly-2026-04-30`, `2026-05-07` | 2026-04-30 – 2026-05-07 | alari | Delete — automated |

### Manual feature/fix/docs branches (stale)

| Branch | Last Commit | Author | Merged? | Recommendation |
|---|---|---|---|---|
| `chore/pr-audit-2026-04-12` | 2026-04-12 | alari | No (squash) | Delete |
| `chore/reports-2026-05-02` | 2026-05-02 | alari | No (squash) | Delete |
| `docs/agent-joe-resilience-audit` | 2026-06-11 | alari | No (squash) | Delete |
| `docs/claude-code-integration-assessment` | 2026-06-11 | alari | No (squash) | Delete |
| `docs/session-restart-audit` | 2026-04-15 | alari | No (squash) | Delete |
| `docs/audit-reports-2026-04-18` | 2026-04-30 | alari | No (squash) | Delete |
| `feat/connection-status-popup` | 2026-04-11 | alari | No (squash) | Delete — feature shipped in #346 |
| `feat/daily-code-review-2026-04-12` | 2026-04-12 | alari | No (squash) | Delete |
| `feat/pr-373-audit-report` | 2026-04-12 | alari | No (squash) | Delete |
| `feat/repo-health-2026-04-13` | 2026-04-13 | alari | No (squash) | Delete |
| `feat/repo-health-2026-04-15` | 2026-04-16 | alari | No (squash) | Delete |
| `feat/test-coverage-2026-04-13` | 2026-04-13 | alari | No (squash) | Delete |
| `fix/ci-lint-errors-and-stale-mock-2026-04-27` | 2026-04-27 | Claude (Webhook) | No (squash) | Delete |
| `fix/clone-test-ci-timeout` | 2026-06-11 | Claude (Webhook) | No (squash) | Delete |
| `fix/clone-test-timeout` | 2026-05-15 | Claude (Webhook) | No (squash) | Delete |
| `fix/commit-event-handler-mock-missing-export` | 2026-04-27 | Claude (Webhook) | No (squash) | Delete |
| `fix/commit-event-handler-test-mock` | 2026-04-27 | Claude (Webhook) | No (squash) | Delete |
| `fix/eslint-test-config-unused-vars-and-require` | 2026-04-27 | Claude (Webhook) | No (squash) | Delete |
| `hosted-relay-control-plane-spec` | 2026-08-08 | alari | No (squash, #543) | Delete — work shipped |
| `chore/release-0.7.1` | 2026-08-05 | alari | Yes (release tag) | Delete |

**Note:** All branches show as "not merged" by `git --merged` because the project uses squash-merges via GitHub PRs; the merge commits are not ancestry-traceable. Deletion is safe for all listed branches.

---

## PR Hygiene

No open pull requests were found on the GitHub remote (`gh pr list` returned an empty array). All recent feature work (agent-model-dropdown, relay-user-admin, connection-popover-target, etc.) is on unmerged remote branches but has no associated open PR at the time of this report.

**Notable:** Ten branches with single commits were pushed on 2026-08-09 but have no open PR. These may be in-progress work items waiting to be turned into PRs.

| Branch | Commits ahead of main | Last push | Status |
|---|---|---|---|
| `feat/agent-model-dropdown` | 1 | 2026-08-09 | No PR |
| `feat/connection-popover-target` | 1 | 2026-08-09 | No PR |
| `feat/hosted-auto-reconnect` | 1 | 2026-08-09 | No PR |
| `feat/hosted-connect-in-settings` | 1 | 2026-08-09 | No PR |
| `feat/hosted-disconnect-in-settings` | 1 | 2026-08-09 | No PR |
| `feat/relay-user-admin` | 1 | 2026-08-09 | No PR |
| `feat/sidebar-harness-mark` | 1 | 2026-08-09 | No PR |
| `feat/two-row-session-rows` | 1 | 2026-08-09 | No PR |
| `fix/agent-dropdown-tone` | 1 | 2026-08-09 | No PR |
| `fix/relay-id-based-authz` | 1 | 2026-08-09 | No PR |

---

## Merge Conflict Forecast

Active branches (activity in the last 14 days) and their divergence from `main`:

| Branch | Ahead | Behind | Files changed on branch | Overlaps with main changes? | Risk |
|---|---|---|---|---|---|
| `feat/connection-popover-target` | 1 | 1 | `ConnectionPopup.tsx`, `HostedApp.tsx`, transport layer | `ConnectionPopup.tsx` last changed in #568 — **direct overlap** | **HIGH** |
| `feat/relay-user-admin` | 1 | 2 | `docs/OPERATIONS.md`, relay server files | relay files heavily modified on main — likely conflicts | **MEDIUM-HIGH** |
| `feat/agent-model-dropdown` | 1 | 11 | `src/components/InputBar.tsx` | `InputBar.tsx` touched in composer redesign (#559, #558) — overlap likely | **MEDIUM** |
| `feat/sidebar-harness-mark` | 1 | 8 | (RepoSection area) | RepoSection work in `feat/two-row-session-rows` — parallel edits | **MEDIUM** |
| `feat/hosted-auto-reconnect` | 1 | 8 | (hosted transport area) | Transport layer heavily modified by phases 3-6 of relay work | **MEDIUM** |
| `feat/hosted-connect-in-settings` | 1 | 5 | (settings area) | Settings area changed in multiple composer/layout PRs | **LOW-MEDIUM** |
| `feat/hosted-disconnect-in-settings` | 1 | 6 | (settings area) | Same concern as above | **LOW-MEDIUM** |
| `feat/two-row-session-rows` | 1 | 4 | `RepoSection.tsx`, `RepoSection.test.tsx` | RepoSection modified in sidebar PRs | **LOW** |
| `fix/relay-id-based-authz` | 1 | 8 | (relay auth area) | Relay auth routes updated heavily in phases 5-6 | **MEDIUM** |
| `fix/agent-dropdown-tone` | 1 | 9 | (InputBar tone) | Merged via #560 — this branch IS #560 | Already merged |

---

## Recommendations

1. **Commit and branch the in-progress GPT-5.6 model ID update** — Four files (`docs/API-REFERENCE.md`, `server/codex-process.ts`, `server/codex-process.test.ts`, `src/types.ts`) are modified in the working tree but uncommitted. Create a `fix/codex-gpt56-models` branch and open a PR to land these cleanly.

2. **Open PRs for the 10 unmerged feature branches** — All 10 branches pushed on 2026-08-09 are single-commit and have no open PR. Either open PRs or delete the branches to avoid silent drift. `feat/connection-popover-target` has the highest conflict risk due to direct overlap with `ConnectionPopup.tsx`.

3. **Bulk-delete stale remote branches** — 29+ stale branches (21 automated audit branches + 8+ manual feature/fix/docs branches) are cluttering the remote. Use `git push origin --delete <branch>` or a single sweep. Since the project uses squash merges, these are safe to delete without data loss.

4. **Promote ESLint warnings to errors** — Four rules demoted to `warn` for "incremental adoption" (`no-misused-promises`, `require-await`, `restrict-template-expressions`, `no-non-null-assertion`) are runtime-risk rules, not style preferences. `no-misused-promises` in particular should be `error` immediately.

5. **Add `noImplicitReturns` to `server/tsconfig.json`** — The server tsconfig is missing this flag that the frontend tsconfigs have, creating an inconsistency in strictness across the codebase.

6. **Add a branch-cleanup step to the automated audit workflow** — The automated repo-health and code-review workflows push their report branches but never prune old ones. A weekly `git push origin --delete audit/*` sweep (or auto-delete after branch merge in GitHub settings) would prevent further accumulation.

7. **Resolve `feat/connection-popover-target` conflict risk immediately** — This branch modifies `ConnectionPopup.tsx` and the transport layer, both of which have been updated on `main` since the branch was cut (11 commits behind). Rebase or close before the gap widens further.

8. **Configure GitHub's "Automatically delete head branches"** — This free GitHub setting would auto-delete merged branches on PR close, preventing the stale-branch accumulation pattern entirely.

9. **Document the `build:hosted` and `dev:hosted` scripts in CLAUDE.md** — These scripts for the hosted-mode build exist in `package.json` but are undocumented in `CLAUDE.md`'s Development section, which will confuse contributors working on the hosted variant.

10. **Acknowledge `busboy`/`streamsearch` license format in `package.json` notes** — These two packages use the legacy `licenses` array format instead of the standard `license` string, causing automated scanners to flag them as "UNKNOWN." Adding a note alongside the existing `licenseNotes` field documents that they are MIT and prevents recurring false positives in future audits.