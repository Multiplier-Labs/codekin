# Repository Health: codekin

**Date**: 2026-08-09T03:22:15.907Z
**Repository**: /srv/repos/Multiplier-Labs/codekin
**Branch**: main
**Workflow Run**: d3e92890-a28b-4728-be9e-e4237bff8a26
**Session**: 38d0dee8-11ca-4014-814c-338b279f8081

---

Now I have all the data needed. Let me produce the comprehensive report.

---

# Repository Health Assessment — 2026-08-09

**Repository:** `Multiplier-Labs/codekin` | **Branch:** `main` | **Version:** `0.8.0`

---

## Summary

**Overall Health: Good**

The codebase is in solid shape with zero actual TODO/FIXME technical debt comments in production code, a fully strict TypeScript configuration, and clean license compliance. The main areas needing attention are: a growing accumulation of stale audit/fix branches (40+ remote branches older than 30 days), a duplicate `nanoid` override key in `package.json`, 8 ESLint rules held at `warn` level that the config itself identifies as pending promotion, and a minor documentation gap in `OPERATIONS.md` — the new machine-removal endpoint added in PR #557 is implemented but not documented.

| Category | Count |
|---|---|
| Dead code items | 0 confirmed (1 false-positive flag cleared) |
| Stale TODO/FIXME items | 0 (no production code TODOs) |
| Config issues | 2 (duplicate `nanoid` key; 8 ESLint `warn` rules pending promotion) |
| License concerns | 2 packages with missing lockfile `license` field (MIT-licensed in practice) |
| Doc drift items | 1 (machine-removal endpoint not in OPERATIONS.md) |
| Stale branches | 40 (all >30 days, none from the last 14 days; `codekin/reports` diverged 131 commits) |
| Stuck PRs | 0 (no open PRs) |

---

## Dead Code

No confirmed orphan files or unused exports were found in production source code.

`src/lib/transport/index.ts` was flagged by the orphan-file heuristic (no file imports `transport/index` by that exact path) but is in active use — nine files import from `'../lib/transport'` and `'./transport'`, which resolve to this index. It is not an orphan.

`src/App.tsx`, `src/main.tsx`, and `src/hosted/HostedApp.tsx` are Vite entry points; they are not imported by other modules by design.

**No removals recommended.** The TypeScript compiler is configured with `noUnusedLocals: true` and `noUnusedParameters: true` across all three tsconfig targets, providing continuous dead-code detection that would surface genuine unused exports at build time.

---

## TODO/FIXME Tracker

**Zero production-code TODO/FIXME/HACK/WORKAROUND comments found.**

The only hits in the codebase are:

| File:Line | Type | Comment | Notes |
|---|---|---|---|
| `server/claude-process.test.ts:60-61` | Test string | `'TODO'` used as a grep pattern literal in a test assertion | Not a real TODO; is test input data |
| `server/opencode-process.test.ts:971` | Test string | `'TODO'` used as a grep pattern literal in a test assertion | Not a real TODO; is test input data |
| `src/hosted/PairPage.tsx:1` | JSDoc | `XXXX-XXXX` in a placeholder string/comment | Not a FIXME; is UI placeholder text |

**Summary:**
- Total actionable TODO/FIXME items: **0**
- Stale items (>30 days): **0**
- Count by type: n/a

---

## Config Drift

### `package.json` — overrides block

| Setting | Current Value | Issue | Recommendation |
|---|---|---|---|
| `overrides.nanoid` | Two entries: `"^3.3.18"` (line 53) and `"^3.3.17"` (line 55) | Duplicate key; JSON parsers keep the last value (`^3.3.17`), silently discarding the higher bound | Remove the lower-version duplicate, keep `"nanoid": "^3.3.18"` |

### `eslint.config.js` — warn rules pending promotion

The config itself notes these rules were "demoted to warnings for incremental adoption" and "should be promoted to errors as the codebase is cleaned up." Eight rules are held at `warn` in both the frontend and server configurations:

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

These are duplicated identically in both the frontend and server rule blocks — any cleanup needs to be applied to both.

### tsconfig files — No issues

All three tsconfig targets (`tsconfig.app.json`, `tsconfig.node.json`, `server/tsconfig.json`) have `strict: true`, `noUnusedLocals: true`, `noUnusedParameters: true`, `noFallthroughCasesInSwitch: true`, and `skipLibCheck: true`. The `ES2023` target is consistent across all three. The server correctly uses `NodeNext` module resolution while the app uses `bundler` mode — this is appropriate and intentional.

### Prettier — No config present

No Prettier configuration file exists. This is a project choice and not a drift issue given the codebase does not list `prettier` as a dependency. No action required.

---

## License Compliance

The project license is **MIT**. No copyleft (GPL/LGPL/AGPL) dependencies were found among the 559 packages in the lock file.

### License distribution (all 559 packages)

| License | Package Count |
|---|---|
| MIT | 474 |
| ISC | 23 |
| Apache-2.0 | 18 |
| MPL-2.0 | 12 |
| BSD-3-Clause | 9 |
| BSD-2-Clause | 8 |
| BlueOak-1.0.0 | 4 |
| MIT-0 | 2 |
| (unlisted in lockfile) | 2 |
| CC-BY-4.0 | 1 |
| (MPL-2.0 OR Apache-2.0) | 1 |
| (MIT OR WTFPL) | 1 |
| CC0-1.0 | 1 |
| (BSD-2-Clause OR MIT OR Apache-2.0) | 1 |
| 0BSD | 1 |

### Flagged items

| Package | Lock License Field | Actual License | Risk |
|---|---|---|---|
| `busboy@1.6.0` | *(missing)* | MIT (LICENSE file present in package) | None — missing field is a publish artifact of the package author; the code is MIT |
| `streamsearch@1.1.0` | *(missing)* | MIT (transitive dep of `busboy`) | None — same situation |

### MPL-2.0 packages (12)

All 12 are `lightningcss` and its platform-specific binaries. `package.json` already documents this: `"lightningcss (MPL-2.0) is a build-time-only dependency used by TailwindCSS and is not included in distributed artifacts."` No action required.

**The `dompurify` dual-license `(MPL-2.0 OR Apache-2.0)` is also noted in `package.json` and is permissively compatible with MIT.**

---

## Documentation Freshness

### API docs — one gap

**`docs/OPERATIONS.md` does not document the machine-removal endpoint** added in PR #557.

The endpoint `DELETE /api/machines/:machineId` was implemented in `server/relay/pairing-routes.ts:114` (PR #557, 2026-08-08) and emits a `machine_removed` audit event. The OPERATIONS.md "Connecting a machine" section describes pairing but has no guidance on *removing* a machine — neither the REST endpoint nor the `codekin relay` CLI surface for machine management are mentioned.

All other recently-changed API surfaces had corresponding documentation updates:
- Model discovery endpoints documented in #539 (`docs: document model discovery endpoints`)
- Relay spec and operations runbook added in #556
- Session handoff spec added alongside the implementation in #548

### README drift — None

All CLI commands listed in README.md (`codekin token`, `codekin config`, `codekin service {status,install,uninstall}`, `codekin start`, `codekin stop`, `codekin setup --regenerate`, `codekin upgrade`, `codekin uninstall`) are present and correctly implemented in `bin/codekin.mjs`.

The configuration table (`PORT`, `REPOS_ROOT`) matches `server/config.ts` — `REPOS_ROOT` defaults to `~/repos` in both.

CLAUDE.md scripts (`npm run dev`, `npm run build`, `npm test`, `npm run test:watch`, `npm run lint`) all exist in `package.json`.

### CONTRIBUTING.md — current

The server setup instruction (`npm install --prefix server`) and all environment variable defaults match `server/config.ts`. No drift found.

---

## Draft Changelog

Changes since `v0.8.0` (tag cut 2026-08-04):

### Unreleased (since v0.8.0)

#### Features
- **Hosted relay phase 1:** Frontend transport abstraction separating local and relay backends (#544)
- **Hosted relay phase 2:** Machine pairing and relay connector (#546)
- **Hosted relay phase 3:** REST proxy end-to-end over the hosted relay (#547)
- **Hosted relay phase 4:** Session streaming over the hosted relay (#549)
- **Hosted relay phase 5:** Session sharing, ACLs, and audit trail (#550)
- **Hosted relay phase 6:** Backpressure, rate limits, and message retention hardening (#552)
- **Session handoff:** Cross-harness session handoff with carry-context provider switching (#548)
- **Hosted control plane:** GitHub-authenticated control plane server at app.codekin.ai (#545)

#### Fixes
- Enforce machine ownership and live revocation; stream backpressure for relay connections (#557)
- Hosted workspace layout and connector diagnostics (#554)
- Read connector overrides from env files; keep tests hermetic (#555)
- Recover Codex sessions whose thread has no rollout yet (#551)
- Rate-limit model refresh; tighten upload and date validation (#542)
- Contain attachment paths to upload dir; harden webhook config mode (#538)
- Start new sessions on the selected model; lighten light-mode thinking badge (#537)

#### Documentation
- Add relay spec, implementation plan, and operations runbook to main (#556)
- Document model discovery endpoints and refresh models table (#539)

#### Chores
- Sync server lockfile with license field (#541)
- Align server tsconfig target with app tsconfig (#540)

---

## Stale Branches

Branches with no commit activity in the last 30 days (as of 2026-08-09). The project uses squash-merge, so branch content being on `main` must be inferred from PR references in commit messages rather than from `git branch --merged`.

| Branch | Last Commit | Author | Days Stale | Likely Merged? | Recommendation |
|---|---|---|---|---|---|
| `audit/code-review.daily-2026-04-28` through `2026-05-04` (7 branches) | 2026-04-28 – 2026-05-04 | alari | 97–103 | Yes (automated audit reports) | Delete |
| `audit/comment-assessment.daily-2026-05-01` | 2026-05-01 | alari | 100 | Yes | Delete |
| `audit/comment-assessment.daily-2026-05-08` | 2026-05-08 | alari | 93 | Yes | Delete |
| `audit/complexity.weekly-2026-04-29` | 2026-04-29 | alari | 102 | Yes | Delete |
| `audit/complexity.weekly-2026-05-06` | 2026-05-06 | alari | 95 | Yes | Delete |
| `audit/dependency-health.daily-2026-04-28` | 2026-04-28 | alari | 103 | Yes | Delete |
| `audit/dependency-health.daily-2026-05-05` | 2026-05-05 | alari | 96 | Yes | Delete |
| `audit/docs-audit.weekly-2026-05-06` | 2026-05-06 | alari | 95 | Yes | Delete |
| `audit/repo-health.weekly-2026-04-28` through `2026-05-04` (5 branches) | 2026-04-28 – 2026-05-04 | alari | 97–103 | Yes | Delete |
| `audit/security-audit.weekly-2026-04-30` | 2026-04-30 | alari | 101 | Yes | Delete |
| `audit/security-audit.weekly-2026-05-07` | 2026-05-07 | alari | 94 | Yes | Delete |
| `chore/pr-audit-2026-04-12` | 2026-04-12 | alari | 119 | Yes | Delete |
| `chore/release-0.6.4` | 2026-04-27 | Claude (Webhook) | 104 | Yes | Delete |
| `chore/reports-2026-05-02` | 2026-05-02 | alari | 99 | Yes | Delete |
| `docs/agent-joe-resilience-audit` | 2026-06-11 | alari | 59 | Yes (PR #495) | Delete |
| `docs/audit-reports-2026-04-18` | 2026-04-30 | alari | 101 | Yes | Delete |
| `docs/claude-code-integration-assessment` | 2026-06-11 | alari | 59 | Yes | Delete |
| `docs/session-restart-audit` | 2026-04-13 | alari | 116 | Yes | Delete |
| `feat/connection-status-popup` | 2026-04-11 | alari | 120 | Yes | Delete |
| `feat/daily-code-review-2026-04-12` | 2026-04-12 | alari | 119 | Yes | Delete |
| `feat/pr-373-audit-report` | 2026-04-12 | alari | 119 | Yes | Delete |
| `feat/repo-health-2026-04-13` | 2026-04-13 | alari | 118 | Yes | Delete |
| `feat/repo-health-2026-04-15` | 2026-04-16 | alari | 115 | Yes | Delete |
| `feat/test-coverage-2026-04-13` | 2026-04-13 | alari | 118 | Yes | Delete |
| `fix/ci-lint-errors-and-stale-mock-2026-04-27` | 2026-04-27 | Claude (Webhook) | 104 | Yes | Delete |
| `fix/clone-test-ci-timeout` | 2026-06-11 | Claude (Webhook) | 59 | Yes | Delete |
| `fix/clone-test-timeout` | 2026-05-15 | Claude (Webhook) | 86 | Yes | Delete |
| `fix/commit-event-handler-mock-missing-export` | 2026-04-27 | Claude (Webhook) | 104 | Yes | Delete |
| `fix/commit-event-handler-test-mock` | 2026-04-27 | Claude (Webhook) | 104 | Yes | Delete |
| `fix/eslint-test-config-unused-vars-and-require` | 2026-04-27 | Claude (Webhook) | 104 | Yes | Delete |
| `fix/security-commit-event-sanitization-2026-04-30` | 2026-04-30 | alari | 101 | Yes | Delete |
| `test/coverage-gaps-apr10` | 2026-04-10 | Claude (Webhook) | 121 | Yes | Delete |

**Branches active within the last 14 days (not stale):**

| Branch | Last Commit | Ahead/Behind Main | Notes |
|---|---|---|---|
| `chore/release-0.7.1` | 2026-08-05 | +1 / -21 | Single release commit; behind main by 21 commits — likely intentional release branch, safe to delete after confirming tag is pushed |
| `codekin/reports` | 2026-08-06 | +131 / -635 | Accumulates all automated report commits; significantly diverged — see Merge Conflict Forecast |
| `hosted-relay-control-plane-spec` | 2026-08-08 | +2 / -30 | Two spec doc commits; content was merged to main via #556, branch itself is now redundant |

---

## PR Hygiene

```
gh pr list --state open
```

**Result: No open PRs.** The PR queue is clean.

---

## Merge Conflict Forecast

Branches with commits in the last 14 days that have diverged from `main`:

| Branch | Commits Ahead | Commits Behind | Files Modified on Branch | Overlap with Main? | Risk |
|---|---|---|---|---|---|
| `chore/release-0.7.1` | 1 | 21 | `CHANGELOG.md`, `README.md`, `package.json`, `package-lock.json` | `package.json` and `CHANGELOG.md` have been modified on main since the branch point | Medium — `package.json` version field and `CHANGELOG.md` will conflict; routine merge |
| `codekin/reports` | 131 | 635 | `.codekin/reports/**` (report files only) | No overlap — reports branch only touches `.codekin/reports/`, which main never modifies | Low for files; rebasing is impractical at 635-behind depth |
| `hosted-relay-control-plane-spec` | 2 | 30 | `docs/HOSTED-RELAY-CONTROL-PLANE-SPEC.md`, `docs/HOSTED-RELAY-IMPLEMENTATION-PLAN.md` | Both files were merged to main via PR #556 | High — identical files edited on both branches; but the branch content is now fully superseded by main; deletion is preferable to merging |

---

## Recommendations

1. **Delete 40 stale remote branches** — The repository has 40 remote branches inactive for 30+ days, the majority of which are automated audit report branches and old fix branches that were squash-merged. A single batch delete (`git push origin --delete <branch>...`) would reduce branch list noise substantially. For the automated audit workflow, consider configuring it to auto-delete branches after the report PR is merged.

2. **Fix the duplicate `nanoid` override in `package.json`** — Lines 53 and 55 both define `"nanoid"` in the `overrides` block; JSON silently takes the last value (`^3.3.17`), discarding the higher floor (`^3.3.18`). Remove line 55 to restore the intended minimum.

3. **Document machine removal in `docs/OPERATIONS.md`** — The `DELETE /api/machines/:machineId` endpoint added in PR #557 is the only machine management operation without a runbook entry. Add a short "Removing a machine" section covering the REST call and expected `machine_removed` audit event, consistent with the existing "Connecting a machine" section.

4. **Delete or merge `hosted-relay-control-plane-spec` branch** — Its content (`HOSTED-RELAY-CONTROL-PLANE-SPEC.md`, `HOSTED-RELAY-IMPLEMENTATION-PLAN.md`) was explicitly merged to `main` via PR #556. The branch itself is now redundant and 30 commits behind `main`. Deleting it removes confusion.

5. **Promote the 8 ESLint `warn` rules to `error`** — The config explicitly calls these out as pending promotion ("incremental adoption"). The relay and handoff features represent a substantial new code surface; doing a lint pass now (before more features land) is lower-effort than later. Both the frontend and server rule blocks need the same change.

6. **Resolve `codekin/reports` branch divergence** — At 131 ahead / 635 behind `main`, this branch will never merge cleanly. If the automated report workflow is intended to keep report commits separate from feature history, establish a clear policy — either cherry-pick the latest reports to `main` periodically or document that this branch is a permanent archive. Its current state makes the branch list misleading.

7. **Close out `chore/release-0.7.1`** — This branch has one release commit (`chore: release v0.7.1`) but `main` is already at `v0.8.0`. If `v0.7.1` was published (the npm publish workflow and the git tag mechanism are in place), the branch can be deleted. If the `v0.7.1` tag was never pushed, confirm whether the release is still needed.

8. **Verify `busboy` and `streamsearch` licenses explicitly** — Both packages have MIT `LICENSE` files but are missing the `license` field in the `package-lock.json` entries. This is a `busboy` publish artifact (not a Codekin issue), but any automated license-scanning tool will flag them as `UNKNOWN`. Add a note to `licenseNotes` in `package.json` alongside the existing `dompurify` and `lightningcss` annotations, or accept the false-positive as known.

9. **Configure the automated audit workflow to prune its own branches** — There are 21 `audit/*` branches on the remote dating back to April 2026. The report workflow creates a branch per run but does not clean up after merge. Adding a post-merge branch deletion step (or using the GitHub auto-delete-merged-branches setting) would prevent this from accumulating further.

10. **Consider adding `noImplicitReturns: true` to `server/tsconfig.json`** — The app-side `tsconfig.app.json` includes `noImplicitReturns: true` and `noUncheckedSideEffectImports: true`, but `server/tsconfig.json` only has `noUncheckedSideEffectImports`. The server config is missing `noImplicitReturns`, a minor drift worth aligning given the server is the more security-sensitive half of the stack.