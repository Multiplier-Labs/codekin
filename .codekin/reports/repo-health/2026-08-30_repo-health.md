# Repository Health: codekin

**Date**: 2026-08-30T03:20:09.902Z
**Repository**: /srv/repos/Multiplier-Labs/codekin
**Branch**: main
**Workflow Run**: 89500794-ccac-4cbe-be16-7ac2c75a536c
**Session**: 693a7f4f-40a0-420f-a473-249ed39fa79c

---

Now I have enough data to compile the full report.

---

# Codekin Repository Health Report — 2026-08-30

---

## Summary

**Overall Health: Good**

Codekin is in an active, well-maintained state with exceptional commit velocity (35 PRs merged in 7 days). TypeScript configs are strict and well-structured; the ESLint setup is thorough. The main concerns are a large accumulation of stale remote branches (42 unmerged, 30+ days old), an API reference document that has drifted behind rapid server-side changes, and a small set of unlicensed transitive dependencies. There are **zero TODO/FIXME comments** in the codebase — a positive sign of clean-up discipline. No open PRs at time of assessment.

| Metric | Value |
|---|---|
| Dead code items | 0 confirmed (1 minor candidate) |
| TODO/FIXME comments | 0 |
| Config issues | 1 (missing Prettier config) |
| License concerns | 2 UNKNOWN transitive deps |
| Doc drift items | 3 |
| Stale remote branches (>30d) | 42 unmerged, 4 merged |
| Open PRs | 0 |
| Uncommitted working-tree changes | 4 files (model-ID update in progress) |

---

## Dead Code

No confirmed unused exports or orphan source files were found. All sampled utility modules (`json-parse.ts`, `crypto-utils.ts`, `ws-origin-check.ts`, `agent-allowlist.ts`, `verifier-runner.ts`) have at least 2 references in other source files.

One minor candidate:

| File | Item | Type | Recommendation |
|---|---|---|---|
| `server/glob-match.test.ts` | *(entire file)* | Test file with 0 non-self references | No action needed — test files are discovered by Vitest, not imported; confirm coverage is exercised via `npm test` |

No orphan source files or unreachable internal functions were detected. TypeScript's `noUnusedLocals` and `noUnusedParameters` flags (enforced in all three tsconfig targets) provide ongoing compile-time enforcement.

---

## TODO/FIXME Tracker

**Zero actionable TODO/FIXME/HACK/XXX/WORKAROUND comment lines** were found in the codebase. The `grep` scan of all `.ts`, `.tsx`, and `.js` files returned only false positives from test files that use `"TODO"` as a literal grep-pattern string under test (e.g. `summarizeToolInput('grep', { pattern: 'TODO' })`), and the file-level JSDoc in `PairPage.tsx` (which uses `XXX-XXXX` as a UI placeholder, not a code annotation).

| Type | Count | Stale (>30d) |
|---|---|---|
| TODO | 0 | 0 |
| FIXME | 0 | 0 |
| HACK | 0 | 0 |
| XXX | 0 | 0 |
| WORKAROUND | 0 | 0 |
| **Total** | **0** | **0** |

---

## Config Drift

### `tsconfig.app.json` (frontend)

All major strict flags are present: `strict`, `noUnusedLocals`, `noUnusedParameters`, `noImplicitReturns`, `noFallthroughCasesInSwitch`, `erasableSyntaxOnly`, `noUncheckedSideEffectImports`. Target `ES2023` is appropriate for a modern Vite build. No issues found.

### `tsconfig.node.json` (Vite config)

Identical strict flags to the app config. Correct for a build-tool config file.

### `server/tsconfig.json`

Strict flags all present. Uses `module: NodeNext` / `moduleResolution: NodeNext` — correct for a Node.js ESM server. `composite: true` and `declaration: true` are appropriate for the referenced project setup.

### `eslint.config.js`

Well-structured flat config with `strictTypeChecked` for both frontend and server. The rules demoted to `warn` instead of `error` are documented with an inline comment ("incremental adoption") — this is intentional tech-debt tracking, not drift.

One finding:

| Config file | Setting | Current value | Recommended value | Severity |
|---|---|---|---|---|
| *(absent)* | Prettier config | Not present | Add `.prettierrc` or `prettier` key in `package.json` | Low |

No Prettier configuration is present in the repository. This means formatting is left to editor defaults, which can cause noisy diffs. Given the existing ESLint setup, adding a Prettier config (or explicitly opting out via a comment in `package.json`) would close this gap.

No deprecated ESLint rules, conflicting target versions, or permissive overrides outside the test block were detected.

---

## License Compliance

The project is MIT-licensed. All production dependencies are permissive. The `package.json` already documents the two edge cases (`dompurify` MPL-2.0 dual-license and `lightningcss` build-only MPL-2.0).

### License distribution (lock file, `node_modules/**`)

| License | Count |
|---|---|
| MIT | 513 |
| ISC | 31 |
| Apache-2.0 | 18 |
| MPL-2.0 | 12 |
| BSD-3-Clause | 10 |
| BSD-2-Clause | 9 |
| BlueOak-1.0.0 | 4 |
| MIT-0 | 2 |
| **UNKNOWN** | **2** |
| CC-BY-4.0 | 1 |
| (MPL-2.0 OR Apache-2.0) | 1 |
| (MIT OR WTFPL) | 1 |
| CC0-1.0 | 1 |
| (BSD-2-Clause OR MIT OR Apache-2.0) | 1 |
| 0BSD | 1 |

### Flagged dependencies

| Package | License | Notes |
|---|---|---|
| `busboy` | UNKNOWN | Transitive dep of `multer`; the package has no top-level `license` field in the lock file. Actual license is MIT (confirmed upstream). No action required, but worth noting. |
| `streamsearch` | UNKNOWN | Transitive dep of `busboy`/`multer`; also MIT upstream. Same note applies. |

No GPL, AGPL, or LGPL dependencies found. No copyleft risk for an MIT-licensed product.

---

## Documentation Freshness

### API Reference drift (`docs/API-REFERENCE.md`)

The API reference was last committed on **2026-08-06** (PR #542). Since then, `server/ws-server.ts` received 3+ commits (most recently 2026-08-29 via the harness-registry refactor and unified run store). The reference document documents the rate-limit constants and WS endpoint behaviour — this section should be verified against the current `ws-server.ts` implementation after the recent refactors.

Additionally, **4 files are currently modified in the working tree** but not yet committed:

| File | Change |
|---|---|
| `docs/API-REFERENCE.md` | Codex model example updated: `gpt-5.5` → `gpt-5.6-sol` |
| `server/codex-process.ts` | JSDoc example updated: same model ID change; cache-TTL comment clarified |
| `server/codex-process.test.ts` | Test fixtures updated to `gpt-5.6-sol` / `gpt-5.6-luna` |
| `src/types.ts` | `CODEX_MODELS` constant fully updated to GPT-5.6 family |

These are consistent and self-contained — they should be committed as a single chore commit.

### Orchestrator/relay docs

`docs/ORCHESTRATOR-SPEC.md` and `docs/LOOPS.md` were updated recently (within 30 days), but the orchestrator received ~12 significant feature PRs in the same period (trust-gated prompts, MCP server, run events, harness registry, notification mid-turn fix). These specs should be reviewed to confirm they reflect the current implementation.

### README drift

The README accurately describes the install process, binary commands, and feature set. All `npm run` scripts in the README (`dev`, `build`, `lint`, `test`) match `package.json` exactly. The `build:hosted` and `dev:hosted` scripts present in `package.json` are not mentioned in the README — this is acceptable (hosted-mode is an internal variant), but could be documented in `docs/` if operators need to build it themselves.

| Finding | Severity |
|---|---|
| `docs/API-REFERENCE.md` last committed 2026-08-06; `server/ws-server.ts` changed 3× since then | Medium |
| Working-tree model-ID update (4 files) not yet committed | Low — commit when ready |
| Orchestrator spec may not reflect ~12 feature PRs since last doc update | Low |

---

## Draft Changelog

### v0.8.x — 2026-08-23 to 2026-08-30

#### Features

- **Trigger engine core** — pre-dispatch gates, trigger ledger, and heartbeat for Joe automation workflows (#602)
- **Agent Joe model picker** — select Joe's model from the session composer (#599)
- **Background AI utilities** — vendor-agnostic one-shot utility agent for server-side tasks (#597)
- **One-line install-and-pair** — hosted funnel flow for connecting a new machine in a single command (#596)
- **Environment checklist** — first-run checklist on the landing surface to validate provider availability (#593)
- **Agent availability indicators** — provider picker surfaces which harnesses are reachable (#592)
- **Unified run store** — single database for all background runs; Joe's children are the first tenant (#591)
- **Trust-gated prompt handling for Joe** — audit B5: prompts from Joe children require operator trust approval (#590)
- **Joe hears loop run events** — orchestrator receives goal-run status updates in real time (#588)
- **First-party Codekin MCP server for Joe** — dedicated MCP channel for Joe's tool calls (#587)
- **Sign out everywhere** — Settings page now revokes all sessions (#586)
- **Unified run read model** — merged All-runs feed aggregates runs across all background processes (#585)
- **Goal-run events on push channel** — loop status emitted to shared WebSocket push channel (#578)
- **Workflow event push channel** — UI subscribes to live `workflow_event` stream (#576)
- **Unified Automations view** — single tab for loops, workflows, and webhooks with needs-attention banner (#582)
- **One database for all background runs** — single SQLite file replaces per-feature stores (#581)
- **QR device linking and passkey sign-in** — mobile pairing and WebAuthn for the hosted app (#573)

#### Fixes

- Break Joe's stale-resume loop; stop stdin EPIPE from killing the server process (#594)
- Never inject orchestrator notifications mid-turn (audit A5) (#589)
- Destroy stored relay sessions on revocation; close the pending gate (#583)
- Let the hosted UI reach workflows, loops, and the run read model (#598)
- Goal runs: allowlist enforcement, blocked status, restart recovery, open kinds (#574)
- Revoke hosted access immediately on token deletion

#### Refactoring

- Harness registry — one definition per agent type, replaces scattered per-file declarations (#595)
- Shared run status vocabulary and stop-verb aliases across all run types (#580)
- Single frontmatter splitter and YAML-first workflow parsing (#579)

#### Documentation

- Trigger-engine core and sudo-free policy added to Joe expansion proposal (#601)
- Joe value expansion: activity-aware automation, app and host monitoring (#600)
- Hosted auth and session isolation security audit (#584, #577)
- NUX and automation unification product audit (#570)
- Agent Joe resilience audit (2026-06-11) landed on main (#575)
- Device link and passkey authentication spec (#571)

---

## Stale Branches

61 total remote branches. 42 are >30 days old with no merge into `main`. The table below groups by category:

### Automated audit branches (generated by workflow runner — safe to prune)

| Branch | Last Commit | Author | Merged? | Recommendation |
|---|---|---|---|---|
| `origin/audit/repo-health.weekly-2026-04-28` | 2026-04-28 | alari | No | Delete — superseded by newer audits |
| `origin/audit/repo-health.weekly-2026-04-29` | 2026-04-29 | alari | No | Delete |
| `origin/audit/repo-health.weekly-2026-05-02` | 2026-05-02 | alari | No | Delete |
| `origin/audit/repo-health.weekly-2026-05-03` | 2026-05-03 | alari | No | Delete |
| `origin/audit/repo-health.weekly-2026-05-04` | 2026-05-04 | alari | No | Delete |
| `origin/audit/code-review.daily-2026-04-28` | 2026-04-28 | alari | No | Delete |
| `origin/audit/code-review.daily-2026-04-29` | 2026-04-29 | alari | No | Delete |
| `origin/audit/code-review.daily-2026-04-30` | 2026-04-30 | alari | No | Delete |
| `origin/audit/code-review.daily-2026-05-01` | 2026-05-01 | alari | No | Delete |
| `origin/audit/code-review.daily-2026-05-02` | 2026-05-02 | alari | No | Delete |
| `origin/audit/code-review.daily-2026-05-03` | 2026-05-03 | alari | No | Delete |
| `origin/audit/code-review.daily-2026-05-04` | 2026-05-04 | alari | No | Delete |
| `origin/audit/comment-assessment.daily-2026-05-01` | 2026-05-01 | alari | No | Delete |
| `origin/audit/comment-assessment.daily-2026-05-08` | 2026-05-08 | alari | No | Delete |
| `origin/audit/complexity.weekly-2026-04-29` | 2026-04-29 | alari | No | Delete |
| `origin/audit/complexity.weekly-2026-05-06` | 2026-05-06 | alari | No | Delete |
| `origin/audit/dependency-health.daily-2026-04-28` | 2026-04-28 | alari | No | Delete |
| `origin/audit/dependency-health.daily-2026-05-05` | 2026-05-05 | alari | No | Delete |
| `origin/audit/docs-audit.weekly-2026-05-06` | 2026-05-06 | alari | No | Delete |
| `origin/audit/security-audit.weekly-2026-04-30` | 2026-04-30 | alari | No | Delete |
| `origin/audit/security-audit.weekly-2026-05-07` | 2026-05-07 | alari | No | Delete |

### Feature/fix branches (work has landed on main via squash-merge)

| Branch | Last Commit | Author | Merged? | Recommendation |
|---|---|---|---|---|
| `origin/feat/connection-status-popup` | 2026-04-11 | alari | No* | Delete — work landed via later squash PR |
| `origin/feat/daily-code-review-2026-04-12` | 2026-04-12 | alari | No* | Delete |
| `origin/feat/repo-health-2026-04-13` | 2026-04-13 | alari | No* | Delete |
| `origin/feat/repo-health-2026-04-15` | 2026-04-16 | alari | No* | Delete |
| `origin/feat/test-coverage-2026-04-13` | 2026-04-13 | alari | No* | Delete |
| `origin/feat/pr-373-audit-report` | 2026-04-12 | alari | No* | Delete |
| `origin/fix/clone-test-ci-timeout` | 2026-06-11 | Claude (Webhook) | No* | Delete |
| `origin/fix/clone-test-timeout` | 2026-05-15 | Claude (Webhook) | No* | Delete |
| `origin/fix/commit-event-handler-mock-missing-export` | 2026-04-27 | Claude (Webhook) | No* | Delete |
| `origin/fix/commit-event-handler-test-mock` | 2026-04-27 | Claude (Webhook) | No* | Delete |
| `origin/fix/ci-lint-errors-and-stale-mock-2026-04-27` | 2026-04-27 | Claude (Webhook) | No* | Delete |
| `origin/fix/eslint-test-config-unused-vars-and-require` | 2026-04-27 | Claude (Webhook) | No* | Delete |
| `origin/fix/security-commit-event-sanitization-2026-04-30` | 2026-04-30 | alari | No* | Delete |
| `origin/test/coverage-gaps-apr10` | 2026-04-10 | Claude (Webhook) | No* | Delete |

### Documentation / chore branches

| Branch | Last Commit | Author | Merged? | Recommendation |
|---|---|---|---|---|
| `origin/docs/agent-joe-resilience-audit` | 2026-06-11 | alari | No* | Delete — content landed on main via #575 |
| `origin/docs/claude-code-integration-assessment` | 2026-06-11 | alari | No* | Delete |
| `origin/docs/audit-reports-2026-04-18` | 2026-04-30 | alari | No* | Delete |
| `origin/docs/session-restart-audit` | 2026-04-15 | alari | No* | Delete |
| `origin/chore/pr-audit-2026-04-12` | 2026-04-12 | alari | No* | Delete |
| `origin/chore/reports-2026-05-02` | 2026-05-02 | alari | No* | Delete |
| `origin/chore/release-0.6.4` | 2026-04-27 | Claude (Webhook) | No* | Delete — release branch, tag exists |
| `origin/hosted-relay-control-plane-spec` | 2026-08-08 | alari76 | No | Review — spec content; check if fully merged into docs/ |
| `origin/codekin/reports` | 2026-08-13 | alari | No | Review before deleting |

*Squash-merge pattern: the branch commit SHA is not in `main`'s history, but the work is present under a squash commit.

---

## PR Hygiene

No open pull requests at the time of this assessment (`gh pr list` returned an empty set). All recent work has been merged promptly — consistent with the high commit velocity and squash-merge workflow observed in git history.

| Metric | Value |
|---|---|
| Open PRs | 0 |
| Stuck PRs (>7d, no review) | 0 |
| PRs with conflicts | N/A |

---

## Merge Conflict Forecast

All "active" remote branches (commits in the last 14 days) follow a squash-merge pattern: each branch is exactly 1 commit ahead of its pre-squash state and N commits behind `main` (where N equals the number of PRs merged after the branch was created). These branches carry no unmerged work — they are post-merge branch pointers left over from feature development.

| Branch | Ahead of main | Behind main | Overlapping files | Risk |
|---|---|---|---|---|
| `origin/feat/trigger-engine-core` | 1 | 1 | `server/workflow-engine.ts`, `server/cron.ts` | **Low** — squash-merged as #602 |
| `origin/fix/stale-resume-and-stdin-epipe` | 2 | 7 | `server/claude-process.ts`, `server/session-lifecycle.ts` | **Low** — squash-merged as #594 |
| `origin/fix/joe-midturn-injection` | 2 | 15 | `server/orchestrator-notify.ts` | **Low** — squash-merged as #589 |
| `origin/docs/joe-trigger-engine` | 1 | 2 | `docs/` only | **None** — docs branch |
| `origin/docs/joe-value-expansion` | 1 | 3 | `docs/` only | **None** |
| All other recent branches | 1 | 4–17 | Various `server/` files | **Low** — all squash-merged |

No branches with genuine unmerged, conflicting work were detected. The squash-merge workflow is working correctly to keep main clean.

---

## Recommendations

1. **Commit the in-progress model-ID update.** Four files (`docs/API-REFERENCE.md`, `server/codex-process.ts`, `server/codex-process.test.ts`, `src/types.ts`) have uncommitted changes updating Codex models from the GPT-5.5 family to GPT-5.6. These are consistent and complete — commit them as `chore(codex): update default model IDs to GPT-5.6 family` on a branch and open a PR.

2. **Prune stale audit branches in bulk.** 21 automated audit branches (`origin/audit/*`) from April–May 2026 are accumulating. Add a branch-cleanup step to the audit workflow, or run a one-time `git push origin --delete` sweep for all `audit/*` branches older than 60 days. This will reduce noise in `git branch -r` output significantly.

3. **Prune stale feature/fix branches from the squash-merge era.** ~20 feature and fix branches from April–June 2026 (many authored by Claude via webhook) have no unmerged work but are not removed post-merge. Configure the repository's GitHub settings to auto-delete head branches after merge, or add a periodic cleanup script.

4. **Refresh `docs/API-REFERENCE.md` against recent server changes.** The document was last updated 24 days ago. Since then, the harness registry refactor (#595), the unified run store (#591), and several relay/orchestrator changes have touched `ws-server.ts`. Walk through the Rate Limit and WebSocket sections to verify constant values and endpoint paths still match.

5. **Verify `docs/ORCHESTRATOR-SPEC.md` and `docs/LOOPS.md` against the ~12 orchestrator PRs.** The orchestrator received trust-gating, MCP integration, run event subscriptions, harness registry changes, and notification-injection fixes — all within the last 30 days. A quick diff of the spec against the current `orchestrator-*.ts` files would surface any divergence before the next release.

6. **Add a Prettier config.** The absence of a `.prettierrc` or `prettier` key in `package.json` means formatting is enforced only by ESLint and editor conventions. Adding a minimal Prettier config (4-space indent, single quotes, trailing comma) will prevent formatting noise in PRs, especially as contributor count grows.

7. **Resolve the `busboy`/`streamsearch` UNKNOWN license entries.** Both are transitive dependencies of `multer` and are MIT-licensed upstream. Add a `licenseNotes` annotation in `package.json` alongside the existing `dompurify`/`lightningcss` notes, so the license picture is fully self-documenting.

8. **Consider promoting ESLint warnings to errors incrementally.** Several rules are demoted to `warn` with an explicit "incremental adoption" comment: `no-non-null-assertion`, `no-unnecessary-condition`, `no-misused-promises`, `use-unknown-in-catch-callback-variable`, and others. Given the codebase's current quality, a quarterly review to promote one or two of these to `error` would continue raising the baseline.

9. **Review `origin/hosted-relay-control-plane-spec` and `origin/codekin/reports` before deletion.** These two branches from August 2026 are not clearly superseded by known PRs. Confirm their content landed on main before deleting.

10. **Automate post-merge branch deletion.** Enable "Automatically delete head branches" in the GitHub repository settings. All the stale webhook-authored fix branches (`fix/clone-test-*`, `fix/commit-event-*`) would be eliminated automatically going forward, without any manual cleanup burden.