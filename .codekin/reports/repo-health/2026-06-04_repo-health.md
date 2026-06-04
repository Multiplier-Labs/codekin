# Repository Health: codekin

**Date**: 2026-06-04T03:20:30.186Z
**Repository**: /srv/repos/Multiplier-Labs/codekin
**Branch**: main
**Workflow Run**: 15969972-991e-4f4b-8906-ba9f7f0d6c5e
**Session**: 5040450c-62a4-4413-9588-aee0a4ca270e

---

Now I have all the data I need. Let me compile the comprehensive report.

---

# Repository Health Report — Codekin
**Date:** 2026-06-04 | **Branch:** main | **Version:** 0.6.5

---

## Summary

**Overall Health: Good**

The codebase is actively maintained, has comprehensive TypeScript strict-mode configs, zero production TODO/FIXME debt, and a robust test suite. The primary concerns are: (1) a significant backlog of stale remote branches (40+) from automated audit workflows, (2) two long-open PRs with no review activity, (3) a CHANGELOG that has not been updated for 11 commits landed in the last 7 days, and (4) two dependencies with unknown licenses.

| Metric | Count |
|---|---|
| Suspicious dead-code exports | 5 |
| Stale TODO/FIXME items | 0 |
| Config drift findings | 3 |
| Unknown-license dependencies | 2 |
| Copyleft-adjacent (MPL-2.0) dependencies | 12 |
| Stale remote branches (>30 days) | 40 |
| Stuck open PRs (>7 days, no review) | 2 |
| Docs drift items | 3 |

---

## Dead Code

TypeScript strict mode (`noUnusedLocals: true`, `noUnusedParameters: true`) is enforced across all three tsconfigs, so unused local variables are caught at build time. The risk area is **cross-module exported symbols** that are never imported by any other module. A full `ts-prune` pass is recommended; the following are flagged based on structural analysis as likely candidates.

| File | Export / Symbol | Type | Recommendation |
|---|---|---|---|
| `src/hooks/useChatSocket.ts:121` | `processMessage` | Unused export (internal fn made public) | Verify — if only used in tests, un-export and import via rewire |
| `src/hooks/useChatSocket.ts:139` | `trimMessages` | Unused export (internal fn made public) | Same as above |
| `src/hooks/useChatSocket.ts:152` | `rebuildFromHistory` | Unused export (internal fn made public) | Same as above |
| `src/hooks/useSessionOrchestration.ts:12` | `groupKey` | Unused export (internal helper) | Un-export; expose only through the hook's return type if tests need it |
| `src/components/workflows/StepCard.tsx:30` | `JsonBlock` | Potentially unused sub-component export | Verify callers outside the file; if only used internally, remove the export keyword |

**Note:** Orphan file detection is not possible without a full bundler trace. The project structure and TypeScript references suggest no orphan files, but running `vite build --reporter verbose` or a dedicated tree-shaking report would confirm.

---

## TODO/FIXME Tracker

A full scan of `src/` and `server/` found **zero** production debt markers (`TODO`, `FIXME`, `HACK`, `XXX`). All hits were either in test fixtures or are intentional documentation of a known CLI protocol workaround.

| File:Line | Type | Comment | Author | Date | Stale? |
|---|---|---|---|---|---|
| `server/plan-manager.ts:8` | WORKAROUND | `deny-with-message workaround for ExitPlanMode` | alari | (recent) | No |
| `server/plan-manager.ts:22` | WORKAROUND | `CLI workaround for requiresUserInteraction` | alari | (recent) | No |
| `server/session-manager.ts:1222` | WORKAROUND | `hook will convert allow→deny-with-approval-message (CLI workaround)` | alari | (recent) | No |
| `server/session-manager.ts:1464` | WORKAROUND | `the deny-with-approval-message workaround` | alari | (recent) | No |
| `server/claude-process.test.ts:60,61,809` | Test fixture | `{ pattern: 'TODO' }` — not a debt marker | — | — | N/A |

**Summary:** Total: 4 WORKAROUND (intentional, documenting a known Claude CLI protocol behavior). Stale items: 0.

---

## Config Drift

### tsconfig (app / node / server)

| Config File | Setting | Current Value | Recommended / Note |
|---|---|---|---|
| `tsconfig.app.json` & `tsconfig.node.json` | `target` | `ES2023` | Modern and appropriate for Vite/browser targets. ✓ |
| `server/tsconfig.json` | `target` | `ES2022` | One version behind frontend. Intentional for broader Node.js compat, but Node 20 (required per CONTRIBUTING) fully supports ES2023. Low-priority upgrade. |
| All three configs | `strict: true` | `true` | ✓ |
| All three configs | `noUnusedLocals`, `noUnusedParameters` | `true` | ✓ |
| All three configs | `noImplicitReturns` | `true` (app/node) / missing (server) | `server/tsconfig.json` does not explicitly set `noImplicitReturns`. Recommend adding for parity. |
| `server/tsconfig.json` | `module` | `NodeNext` | Correct for ESM Node.js. ✓ |

### eslint.config.js

| Finding | Detail | Recommendation |
|---|---|---|
| 8 rules demoted to `warn` | `restrict-template-expressions`, `no-confusing-void-expression`, `no-unnecessary-condition`, `no-base-to-string`, `no-non-null-assertion`, `no-misused-promises`, `use-unknown-in-catch-callback-variable`, `require-await` | These represent acknowledged technical debt. Consider scheduling a sprint to elevate them to `error` incrementally. |
| Test overrides override `strict-type-checked` | Test files use `recommended` only, disabling many type-aware rules | Acceptable trade-off for test ergonomics but reduces type safety in tests. |

### .prettierrc

No issues. Config is self-consistent (`semi: false`, `singleQuote: true`, `printWidth: 120`, `trailingComma: all`).

---

## License Compliance

**Project license:** MIT

| License | Dependency Count | Compatible with MIT? |
|---|---|---|
| MIT | 472 | Yes |
| ISC | 22 | Yes |
| Apache-2.0 | 18 | Yes |
| MPL-2.0 | 12 | Conditional (see below) |
| BSD-3-Clause | 9 | Yes |
| BSD-2-Clause | 8 | Yes |
| BlueOak-1.0.0 | 4 | Yes (permissive) |
| (MPL-2.0 OR Apache-2.0) | 1 | Yes — dompurify; already noted in package.json |
| MIT-0 | 2 | Yes |
| CC-BY-4.0 | 1 | Content license; acceptable for code deps |
| CC0-1.0 | 1 | Yes (public domain) |
| 0BSD | 1 | Yes |
| (MIT OR WTFPL) | 1 | Yes |
| (BSD-2-Clause OR MIT OR Apache-2.0) | 1 | Yes |
| **unknown** | **2** | **Requires investigation** |

**Flagged items:**

- **MPL-2.0 (12 packages):** The Mozilla Public License requires that modifications to MPL-licensed files be released under MPL, but it does not affect the license of a consuming project. `package.json` already documents this for `lightningcss` (build-time only, not in distributed artifacts). Confirm that all 12 MPL packages are either build-time only or used without modification.
- **Unknown license (2 packages):** Two transitive dependencies in `package-lock.json` have no `license` field. These must be investigated to confirm they are not encumbered. Run `license-checker --unknown` to identify them by name.

---

## Documentation Freshness

### API Docs / Code Docs Freshness

| Item | Status | Detail |
|---|---|---|
| `docs/stream-json-protocol.md` | Potentially stale | PR #488 (2026-06-03) canonicalized the WebSocket `workingDir` field. The protocol doc may not reflect that normalization logic. |
| `CHANGELOG.md` | Stale | Last entry covers v0.6.5 (2026-05-14). Eleven commits landed on 2026-06-03 (dynamic model discovery, session grouping fixes, WebSocket workingDir canonicalization, coverage config overhaul, docs fixes) with no CHANGELOG update. |
| `docs/API-REFERENCE.md` | Needs verification | Dynamic Claude model discovery (#479) added a new probe mechanism. If the API reference documents model selection or `/api/models` endpoints, it may need updating. |

### README Drift

The README was audited against `package.json` scripts and `CONTRIBUTING.md`.

| README Section | Finding |
|---|---|
| **Scripts** (`npm run dev`, `npm test`, `npm run build`, `npm run lint`) | All match `package.json`. ✓ |
| **`npm run test:watch`** | Listed in CLAUDE.md; README does not mention it — minor omission, low impact. |
| **Install one-liner** | References `codekin.ai/install.sh`. Not verifiable from repo, but consistent with project docs. |
| **Environment variables** | CONTRIBUTING.md lists variables (PORT, AUTH_TOKEN, etc.); README references them via setup guide. Appears consistent. |
| **OpenCode provider** | README feature list leads with Claude Code/OpenCode multi-provider support. CLAUDE.md architecture section only mentions Claude CLI. Minor documentation asymmetry. |
| **`npm run preview`** | Listed in package.json but not documented in README or CONTRIBUTING. Not a drift issue, just omission. |

---

## Draft Changelog

### [Unreleased] — since v0.6.5 (2026-06-03)

#### Features
- Dynamic Claude model discovery: probes candidate model IDs at runtime instead of relying on static alias lists, adding Opus 4.8 support (#479, #480)

#### Fixes
- Canonicalize WebSocket `workingDir` to prevent session grouping mismatches (#488)
- Group webhook/stepflow sessions under canonical owner-namespaced repo paths (#481)
- Group AI workflow sessions under canonical repo in sidebar (reverted once, then re-landed with a corrected approach: #485, #486)
- Surface and resume archived sessions across different repo clone paths (#482)
- Start new sessions on the latest available model and surface reconnect notices (#483)
- Make session auto-naming resilient to rate limits and verbose model responses (#484)

#### Tests / Coverage
- Make coverage configuration honest (`coverage.all: true`) and add React component tests (#487)
- Add model-discovery tests (#488)

#### Documentation
- Fix accuracy drift found during docs audit (#489)

---

## Stale Branches

Branches with no commit activity in the last 30 days. "Merged?" reflects `git branch -r --merged main` output; audit report branches are architectural artifacts (not feature branches) and are noted separately.

| Branch | Last Commit | Author | Merged? | Recommendation |
|---|---|---|---|---|
| `origin/test/coverage-gaps-apr10` | 2026-04-10 | Claude (Webhook) | No (indirect) | Delete — superseded by recent coverage work |
| `origin/feat/connection-status-popup` | 2026-04-11 | alari | No | Review: if merged via squash, delete; otherwise triage |
| `origin/feat/daily-code-review-2026-04-12` | 2026-04-12 | alari | No | Delete — audit artifact, report committed elsewhere |
| `origin/feat/pr-373-audit-report` | 2026-04-12 | alari | No | Delete — audit artifact |
| `origin/chore/pr-audit-2026-04-12` | 2026-04-12 | alari | No | Delete — audit artifact |
| `origin/feat/repo-health-2026-04-13` | 2026-04-13 | alari | No | Delete — audit artifact |
| `origin/feat/test-coverage-2026-04-13` | 2026-04-13 | alari | No | Delete — audit artifact |
| `origin/docs/session-restart-audit` | 2026-04-15 | alari | No | Review: if content merged, delete |
| `origin/feat/repo-health-2026-04-15` | 2026-04-16 | alari | No | Delete — audit artifact |
| `origin/docs/audit-reports-2026-04-18` | 2026-04-30 | alari | No | Delete — audit artifact |
| `origin/fix/eslint-test-config-unused-vars-and-require` | 2026-04-27 | Claude (Webhook) | No | Delete — CI fix, changes are in main |
| `origin/fix/ci-lint-errors-and-stale-mock-2026-04-27` | 2026-04-27 | Claude (Webhook) | No | Delete — CI fix, changes are in main |
| `origin/fix/commit-event-handler-mock-missing-export` | 2026-04-27 | Claude (Webhook) | No | Delete — CI fix, changes are in main |
| `origin/fix/commit-event-handler-test-mock` | 2026-04-27 | Claude (Webhook) | No | Delete — CI fix, changes are in main |
| `origin/chore/release-0.6.4` | 2026-04-27 | Claude (Webhook) | No | Delete — release branch, v0.6.4 tagged |
| `origin/fix/security-commit-event-sanitization-2026-04-30` | 2026-04-30 | alari | No | Review: if merged via squash, delete |
| `origin/fix/security-validation-2026-04-30` | 2026-05-01 | alari76 | **Yes** | **Delete — merged** |
| `origin/fix/security-validation-followup-2026-04-30` | 2026-05-01 | alari76 | **Yes** | **Delete — merged** |
| `origin/chore/reports-2026-05-02` | 2026-05-02 | alari | No | Delete — audit artifact |
| `origin/audit/repo-health.weekly-2026-04-28` | 2026-04-28 | alari | No | Audit archive — keep or prune per retention policy |
| `origin/audit/code-review.daily-2026-04-28` | 2026-04-28 | alari | No | Audit archive |
| `origin/audit/dependency-health.daily-2026-04-28` | 2026-04-28 | alari | No | Audit archive |
| `origin/audit/complexity.weekly-2026-04-29` | 2026-04-29 | alari | No | Audit archive |
| `origin/audit/code-review.daily-2026-04-29` | 2026-04-29 | alari | No | Audit archive |
| `origin/audit/repo-health.weekly-2026-04-29` | 2026-04-29 | alari | No | Audit archive |
| `origin/audit/security-audit.weekly-2026-04-30` | 2026-04-30 | alari | No | Audit archive |
| `origin/audit/code-review.daily-2026-04-30` | 2026-04-30 | alari | No | Audit archive |
| `origin/audit/code-review.daily-2026-05-01` | 2026-05-01 | alari | No | Audit archive |
| `origin/audit/comment-assessment.daily-2026-05-01` | 2026-05-01 | alari | No | Audit archive |
| `origin/audit/repo-health.weekly-2026-05-02` | 2026-05-02 | alari | No | Audit archive |
| `origin/audit/code-review.daily-2026-05-02` | 2026-05-02 | alari | No | Audit archive |
| `origin/audit/repo-health.weekly-2026-05-03` | 2026-05-03 | alari | No | Audit archive |
| `origin/audit/code-review.daily-2026-05-03` | 2026-05-03 | alari | No | Audit archive |
| `origin/audit/repo-health.weekly-2026-05-04` | 2026-05-04 | alari | No | Audit archive |
| `origin/audit/code-review.daily-2026-05-04` | 2026-05-04 | alari | No | Audit archive |
| `origin/audit/dependency-health.daily-2026-05-05` | 2026-05-05 | alari | No | Audit archive |
| `origin/audit/docs-audit.weekly-2026-05-06` | 2026-05-06 | alari | No | Audit archive |
| `origin/audit/complexity.weekly-2026-05-06` | 2026-05-06 | alari | No | Audit archive |
| `origin/audit/security-audit.weekly-2026-05-07` | 2026-05-07 | alari | No | Audit archive |
| `origin/audit/comment-assessment.daily-2026-05-08` | 2026-05-08 | alari | No | Audit archive |

**Note on audit branches:** The `audit/*` namespace is populated automatically by AI workflow runs. These branches serve as the commit history for audit reports. Consider establishing a retention policy (e.g., delete branches older than 90 days) and running a periodic purge.

---

## PR Hygiene

| PR# | Title | Author | Days Open | Review Status | Conflicts | Stuck? |
|---|---|---|---|---|---|---|
| #478 | fix: mock child_process in clone test to prevent CI timeout | alari76 | 20 | No review | Unknown | Yes (>7 days) |
| #464 | chore(reports): add code-review, comment, and repo-health reports for 2026-05-01 | alari76 | 33 | No review | Unknown | Yes (>7 days) |

Both PRs are flagged as stuck. PR #464 (33 days) is particularly overdue. PR #478 is a CI-stabilization fix that likely should have been merged alongside the related work that landed on 2026-05-15.

---

## Merge Conflict Forecast

Branches with commit activity in the last 14 days (since 2026-05-21), assessed against main.

| Branch | Last Commit | Status vs main | Notable Files | Risk |
|---|---|---|---|---|
| `origin/fix/clone-test-timeout` | 2026-05-15 | Behind main by ~11 commits (rebased or stale) | `server/session-routes.test.ts` | Low — test-only file, unlikely to conflict |
| `origin/codekin/reports` | 2026-06-03 | Up to date (branched from latest main) | `.codekin/reports/**` | Low — separate directory |
| `origin/fix/docs-audit-accuracy` | 2026-06-03 | Up to date | `docs/**` | Low — docs only |
| `origin/fix/coverage-honest-config-and-component-tests` | 2026-06-03 | Up to date | `vitest.config.ts`, test files | Low — test config only |

No high-risk conflict situations detected. The three branches created on 2026-06-03 are all recent forks of main and touch disjoint file sets.

---

## Recommendations

1. **[High] Merge or close PR #464 and PR #478.** Both have been open for weeks with no review. PR #464 (audit report archive) may simply need a quick merge; PR #478 (CI timeout fix) should be reviewed for correctness and merged or superseded.

2. **[High] Update CHANGELOG.md.** Eleven commits landed on 2026-06-03 with no changelog entry. Given the project follows semver and tags releases, the changelog is the canonical record for users upgrading. Add an `[Unreleased]` section covering dynamic model discovery, session grouping fixes, workingDir canonicalization, and coverage improvements.

3. **[Medium] Investigate the 2 unknown-license transitive dependencies.** Run `npx license-checker --unknown` or `npx license-checker --json | jq '[to_entries[] | select(.value.licenses == "UNKNOWN")]'` to identify them. If the licenses turn out to be permissive, add them to `package.json`'s `licenseNotes`; if encumbered, replace the dependency.

4. **[Medium] Run a stale-branch purge.** Delete the 2 confirmed-merged branches (`fix/security-validation-*`) immediately. Then delete the ~15 old `feat/`, `fix/`, `chore/`, `docs/`, and `test/` branches from April that have been superseded by main. Establish a retention policy for `audit/*` branches (suggest: keep last 90 days, delete older).

5. **[Medium] Add `noImplicitReturns: true` to `server/tsconfig.json`.** All other tsconfigs set this flag. The server config omits it, creating a parity gap. It is a zero-risk addition since the server code likely already conforms.

6. **[Medium] Review `docs/stream-json-protocol.md` for workingDir canonicalization.** PR #488 changed how `workingDir` is normalized in the WebSocket layer. If the protocol doc describes the `workingDir` field, it should be updated to document the canonical-path guarantee.

7. **[Low] Schedule ESLint warn-to-error promotions.** Eight rules are demoted to `warn`. The most impactful candidates to promote first are `no-misused-promises` and `no-floating-promises` (already `error` per the config for async safety) and `require-await` (identifies unnecessary async functions). Track this as a housekeeping sprint.

8. **[Low] Consider running `ts-prune` or `knip` in CI.** TypeScript's `noUnusedLocals` does not catch unused cross-module exports. Adding a tool like `knip` as a periodic CI check (not blocking, just reporting) would surface unnecessary public API surface over time.

9. **[Low] Confirm MPL-2.0 build-time isolation for all 12 MPL packages.** `lightningcss` is already documented as build-time only. Verify the remaining 11 MPL packages follow the same pattern (not bundled into distributed artifacts) and add a one-line note in `licenseNotes` if any are runtime dependencies.

10. **[Low] Define an audit branch retention policy in `CLAUDE.md` or a workflow config.** The `audit/*` branch namespace is growing automatically. Without a deletion policy, it will accumulate indefinitely. Adding a weekly or monthly purge step to the audit workflow (delete branches older than 90 days) would keep the remote tidy with no manual effort.