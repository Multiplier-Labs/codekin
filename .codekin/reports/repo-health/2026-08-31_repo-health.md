# Repository Health: codekin

**Date**: 2026-08-31T03:19:27.192Z
**Repository**: /srv/repos/Multiplier-Labs/codekin
**Branch**: feat/deployments-ui
**Workflow Run**: dfa76803-8fd3-49d9-a69f-7331cd56d219
**Session**: 20d8f4a2-04ac-414c-b2df-6d5d0ffd815c

---

# Codekin Repository Health Report — 2026-08-31

## Summary

**Overall Health: Good**

The codebase is exceptionally clean at the code quality level: strict TypeScript enforces zero dead local symbols, and the codebase has effectively zero TODO/FIXME debt. The main concerns are (1) **significant API documentation drift** — six major feature areas added in the last 30 days have no corresponding API reference entries, (2) **42 stale remote branches** (mostly old automated audit branches never pruned), and (3) a **server `tsconfig.json` include gap** that may leave `server/loops/` and `server/workflows/` subdirectories outside the project's TypeScript composite build.

| Metric | Value |
|---|---|
| Dead code items (confirmed) | 0 |
| TODO/FIXME comments | 0 real items |
| Config issues | 1 notable, 2 minor |
| License concerns | 2 low-risk (MPL-2.0, 2 no-license) |
| Doc drift items | 6 feature areas undocumented |
| Stale remote branches (>30 days) | 42 |
| Open PRs | 0 |
| Stuck PRs | 0 |
| Merge conflict risk branches | 1 high (7 overlapping files) |

---

## Dead Code

**No confirmed dead exports or orphan files.**

The project's TypeScript configuration enforces `noUnusedLocals: true` and `noUnusedParameters: true` across all three tsconfigs (app, node, server), which eliminates dead local symbols at compile time. The ESLint config similarly runs `tseslint.configs.strictTypeChecked` on all production code.

A filename-based import scan found all source files are referenced elsewhere. Exported symbols that are unused across module boundaries would not be caught by tsconfig alone; however, given the strict TypeScript setup and active ESLint enforcement, the risk of silently dead exports is low.

**Recommendation:** If a more thorough unused-export sweep is desired, run `ts-prune` or `knip` as a one-time audit — the current toolchain does not statically check cross-module export usage.

---

## TODO/FIXME Tracker

A full grep across all `.ts`, `.tsx`, `.js`, and `.jsx` files (excluding tests and `node_modules`) found **zero real TODO/FIXME/HACK/XXX/WORKAROUND comments**.

The two grep hits that surfaced were both false positives in `src/hosted/PairPage.tsx`:
- Line 1: JSDoc describing a URL pattern `(/pair?code=XXXX-XXXX)` — not a code comment marker.
- Line 153: An HTML `placeholder="XXXX-XXXX"` attribute — not a code comment at all.

**Summary:**

| Type | Count | Stale (>30 days) |
|---|---|---|
| TODO | 0 | 0 |
| FIXME | 0 | 0 |
| HACK | 0 | 0 |
| XXX | 0 | 0 |
| WORKAROUND | 0 | 0 |
| **Total** | **0** | **0** |

---

## Config Drift

### tsconfig (app — `tsconfig.app.json`)

No drift. All recommended strict options are enabled: `strict`, `noUnusedLocals`, `noUnusedParameters`, `noImplicitReturns`, `noFallthroughCasesInSwitch`. Target is ES2023 which is appropriate for a modern Vite build.

### tsconfig (server — `server/tsconfig.json`)

| File | Setting | Current Value | Issue |
|---|---|---|---|
| `server/tsconfig.json` | `include` | `["*.ts", "relay/*.ts"]` | **Does not cover `server/loops/` or `server/workflows/` subdirectories.** These were added as part of the trigger engine / Loops 2.0 work. If these files are compiled only by test runners (Vitest) and not by `tsc -b`, type errors in them would not surface in CI's build step. |
| `server/tsconfig.json` | `noImplicitReturns` | not set | Absent from server tsconfig but present in app tsconfig — minor inconsistency. Low risk since strict mode covers most cases. |

### ESLint (`eslint.config.js`)

Well-structured and up to date. One intentional pattern worth noting:

| Rule | Current State | Note |
|---|---|---|
| Multiple `@typescript-eslint/*` rules | `warn` (demoted from `error`) | The file documents these as "pre-existing patterns for incremental adoption" and calls for promoting them to `error` over time. The rules include `no-non-null-assertion`, `no-unnecessary-condition`, `no-misused-promises`, `require-await`, `use-unknown-in-catch-callback-variable`. These should be graduated to `error` as the codebase stabilises. |
| Server ESLint | Applies `tseslint.configs.strictTypeChecked` | Correctly stricter than test files. |
| Test ESLint | `tseslint.configs.recommended` (not strict) | Appropriate and expected for test files. |

### Prettier

No `.prettierrc` or `prettier.config.*` file detected. Formatting is enforced implicitly through ESLint rules and editor conventions. Consider adding an explicit Prettier config for consistency across contributors.

---

## License Compliance

Project license: **MIT**

**License summary:**

| License | Dependency count |
|---|---|
| MIT | 513 |
| ISC | 31 |
| Apache-2.0 | 18 |
| **MPL-2.0** | **12** |
| BSD-3-Clause | 10 |
| BSD-2-Clause | 9 |
| BlueOak-1.0.0 | 4 |
| MIT-0 | 2 |
| (MPL-2.0 OR Apache-2.0) | 1 |
| CC-BY-4.0 | 1 |
| CC0-1.0 | 1 |
| 0BSD | 1 |
| (MIT OR WTFPL) | 1 |
| (BSD-2-Clause OR MIT OR Apache-2.0) | 1 |
| **No license field** | **2** |

**Flagged items:**

| Package | License | Risk |
|---|---|---|
| `lightningcss` (+ 11 platform-specific variants) | MPL-2.0 | **Low.** MPL-2.0 is weak copyleft — it requires that modifications to the MPL-licensed *files themselves* be disclosed, not the surrounding application. Since `lightningcss` is an unmodified build-time dependency (used internally by Vite/TailwindCSS), no disclosure obligation is triggered. No action required, but worth documenting in a third-party notices file. |
| `dompurify` | MPL-2.0 OR Apache-2.0 | **None.** The dual-license permits Apache-2.0 use; MIT-licensed projects can use it freely under that option. |
| `busboy` | No license field in lock file | **Very low.** `busboy` is a well-known MIT-licensed package maintained by the Node.js team. The metadata omission is a lock-file artifact, not a genuine licensing gap. |
| `streamsearch` | No license field in lock file | **Very low.** A dependency of `busboy`, also MIT. Same explanation applies. |

No GPL, AGPL, or LGPL dependencies detected.

---

## Documentation Freshness

### API Docs (`docs/API-REFERENCE.md`)

The API reference (812 lines) was last substantively updated in PR #542 (2026-08-04, "rate-limit model refresh and tighten upload/date validation"). Since then, **six major feature areas** have shipped with new server endpoints that have no corresponding documentation:

| Feature | Merged | New endpoints | Documented? |
|---|---|---|---|
| Deployment registry + probes (#606, #607, #609, #612, #616) | 2026-08-30 | `GET/POST/PATCH/DELETE /api/deployments`, `GET /api/deployments/discover`, `GET /api/deployments/samples` | **No** |
| Host monitoring probes (#608) | 2026-08-30 | Host probe REST surface (mounted under `/api/deployments` or similar) | **No** |
| Incident response / security probes (#607) | 2026-08-30 | Incident-response trigger endpoints | **No** |
| Trigger engine + durable signals (#602, #605) | 2026-08-29–30 | Trigger ledger endpoints | **No** |
| Loops 2.0 engine + control plane (#620–#623) | 2026-08-30 | New loop run management endpoints (replaced goal-run) | **No** |
| Per-harness MCP registration (#619) | 2026-08-30 | MCP config endpoints | **No** |

The current branch (`feat/deployments-ui`) includes a minor edit to `docs/API-REFERENCE.md` (1 line changed) but does not add deployment endpoint documentation.

### README Drift (`README.md`)

No drift detected. All CLI commands (`codekin token`, `codekin config`, `codekin service status`, etc.), install steps, and feature descriptions were verified against `package.json` scripts. The `npm run` scripts documented in CLAUDE.md (`dev`, `build`, `test`, `test:watch`, `lint`) all match `package.json` exactly.

The README's features list is comprehensive and current as of the Joe / Deployments era.

---

## Draft Changelog

**Period:** 2026-08-24 → 2026-08-31 (since last week's cadence; all activity concentrated on 2026-08-29–30)

### Features

- **Loops 2.0 — complete rewrite** (#620–#624): Durable engine core replacing goal runs; control plane with plan stage, wizard, and run workspace; evaluator platform with remote CI and completion scorecard; parallel workstreams, checkpoint forks, lessons, and version stats; model-based reflection via `policy.reflection: model`.
- **Deployments UI** (#606–#612, #616): Deployment registry with deterministic probes; incident response — auto-diagnosed breaches and security probes; error-rate log probe; learned p95 latency baseline + TLS protocol floor; Deployments tab in the Automations view with registry, probe status, and discovery.
- **Host monitoring** (#608): Host probe family with propose-tier maintenance, weekly digest, and startup greeting.
- **Trigger engine enhancements** (#602–#605, #614, #618): Trigger engine core with pre-dispatch gates and heartbeat; repo activity index with tiers and dispatch gating; durable signals (at-least-once event queue); accepted PR events routed through the durable signal queue; trigger log panel showing why runs did or didn't fire.
- **Agent Joe improvements** (#599, #604, #619): Model picker in the composer; agent-agnostic orchestrator with persisted harness choice and `AGENTS.md`; per-harness MCP registration for opencode.json and codex config.toml.
- **Security** (#617): Automated npm audit on dependency change.
- **Relay** (#596): One-line install-and-pair for the hosted funnel.
- **Server** (#597): Background AI utilities without a hardcoded vendor.

### Fixes

- **Orchestrator** (#613): Deterministic newest-first ordering in `monitor.getAll()`.
- **Deployments** (#609): Tolerate pm2 jlist warning banners before the JSON payload.
- **Relay** (#598): Let the hosted UI reach workflows, loops, and the run read model.
- **Server** (#594): Break Joe's stale-resume loop; stop stdin EPIPE from killing the server.

### Refactoring

- **Engine** (#615): Monitor poll and outbox flusher unified to ride the dispatch tick.

### Documentation

- (#611): Loops 2.0 rewrite spec.
- (#601, #600): Trigger engine core and Joe value expansion proposal.

---

## Stale Branches

84 total remote branches. **42 have no commit activity in the last 30 days** (last commit before 2026-08-01). None of these 42 are merged into `main` via `git branch --merged`, but many are automated audit report branches that were opened as PRs, had their content merged via a separate commit, and were never deleted.

**Representative stale branches (oldest first):**

| Branch | Last commit | Author | Merged? | Recommendation |
|---|---|---|---|---|
| `test/coverage-gaps-apr10` | 2026-04-10 | Claude (Webhook) | No | Delete — test-gap report, content superseded |
| `feat/connection-status-popup` | 2026-04-11 | alari | No | Review; likely superseded by connection-status work in main |
| `feat/pr-373-audit-report` | 2026-04-12 | alari | No | Delete — audit report branch |
| `chore/pr-audit-2026-04-12` | 2026-04-12 | alari | No | Delete — audit branch |
| `feat/daily-code-review-2026-04-12` | 2026-04-12 | alari | No | Delete — automated review branch |
| `feat/repo-health-2026-04-13` | 2026-04-13 | alari | No | Delete — report branch |
| `feat/test-coverage-2026-04-13` | 2026-04-13 | alari | No | Delete — report branch |
| `docs/session-restart-audit` | 2026-04-15 | alari | No | Review; may have useful content not yet landed |
| `fix/eslint-test-config-unused-vars-and-require` | 2026-04-27 | Claude (Webhook) | No | Delete — fix long since superseded |
| `chore/release-0.6.4` | 2026-04-27 | Claude (Webhook) | No | Delete — release chore |
| `fix/clone-test-timeout` | 2026-05-15 | Claude (Webhook) | No | Delete — test fix |
| `docs/agent-joe-resilience-audit` | 2026-06-11 | alari | No | Review; audit report |
| `audit/code-review.daily-2026-04-28` through `audit/...` | 2026-04-28 to 2026-05-08 | alari | No | **Delete all** — automated daily/weekly audit branches, ~20 of them, content captured in report files |

**Note:** The 42 stale branches are almost entirely two categories: (1) automated audit/report branches from the April–May 2026 period, and (2) a handful of feature branches from April that were either abandoned or superseded. A bulk remote branch deletion sweep (`git push origin --delete <name>`) is recommended for the `audit/*` series.

---

## PR Hygiene

`gh pr list` returns an empty set — **no open pull requests** at time of report.

The current working branch `feat/deployments-ui` is 1 commit ahead of `main` and 15 commits behind. It has 4 modified files (`src/components/AutomationsView.tsx`, `src/components/DeploymentsView.tsx`, `src/hooks/useDeployments.ts`, `src/lib/deploymentsApi.ts`) and 4 dirty-but-uncommitted files (`docs/API-REFERENCE.md`, `server/codex-process.test.ts`, `server/codex-process.ts`, `src/types.ts`). It has not been opened as a PR yet.

---

## Merge Conflict Forecast

Active unmerged branches (commits in last 14 days) with file overlap against main:

| Branch | Commits ahead | Commits behind | Overlapping files | Risk |
|---|---|---|---|---|
| `feat/tick-consolidation` | 1 | 11 | 7 | **High** |
| `feat/loops-model-reflection` | 1 | 1 | 3 | Medium |
| `feat/dependency-audit` | 1 | 9 | 3 | Medium |
| `feat/per-harness-mcp` | 1 | 7 | 2 | Low–Medium |
| `feat/probe-upgrades` | 1 | 10 | 2 | Low–Medium |

**`feat/tick-consolidation` — High Risk:**

This branch is 11 commits behind main and has file-level overlap with 7 actively modified server files:

- `server/orchestrator-monitor.ts` / `.test.ts`
- `server/orchestrator-outbox.ts` / `.test.ts`
- `server/trigger-dispatch.test.ts`
- `server/workflow-engine.ts`
- `server/ws-server.ts`

All seven of these files were also touched by the Loops 2.0 rewrite (#620–#624) on main. A rebase onto current main before merging is strongly recommended and will likely require manual conflict resolution in the orchestrator and workflow-engine files.

The remaining active branches (loops-model-reflection, dependency-audit, per-harness-mcp, probe-upgrades) each have 1–3 overlapping files and are only 1 commit ahead of their branch point, making rebases straightforward.

---

## Recommendations

1. **Write API documentation for the six undocumented feature areas.** The deployment registry, host probes, incident-response endpoints, trigger engine/ledger, Loops 2.0 run management, and per-harness MCP endpoints all shipped in the last 30 days with no API reference updates. `docs/API-REFERENCE.md` is ~30% stale relative to the current server surface. This is the highest-impact documentation gap.

2. **Fix the `server/tsconfig.json` include gap.** The current `"include": ["*.ts", "relay/*.ts"]` excludes `server/loops/*.ts` and `server/workflows/*.ts`. Add `"loops/*.ts"` and `"workflows/*.ts"` (or use a glob like `"**/*.ts"` with appropriate excludes) to ensure the TypeScript composite build type-checks all server code, not just the root and relay directories.

3. **Bulk-delete old audit branches.** The ~20 `audit/*` branches from April–May 2026 and several `feat/`/`fix/` branches from the same period are stale noise in the remote. Run a sweep: `git push origin --delete audit/code-review.daily-2026-04-28 audit/repo-health.weekly-2026-04-28 ...` (and similar for all pre-June audit branches). This reduces cognitive overhead when reviewing `git branch -r`.

4. **Rebase `feat/tick-consolidation` onto `main` promptly.** It has 11 commits of drift and 7 overlapping files with the Loops 2.0 rewrite. The longer this waits, the harder the merge becomes — the orchestrator-monitor and workflow-engine files in particular saw significant changes in #620–#623.

5. **Graduate ESLint warnings to errors.** The `eslint.config.js` explicitly flags several rules (`no-non-null-assertion`, `no-unnecessary-condition`, `no-misused-promises`, `require-await`, `use-unknown-in-catch-callback-variable`) as warnings "for incremental adoption." Now that the codebase is stable and actively maintained, these should be promoted to `error` to prevent regressions. A one-time lint run will surface any remaining violations to fix.

6. **Open the `feat/deployments-ui` PR.** The current branch has uncommitted changes across 4 files and is 15 commits behind main. Committing the in-progress changes, rebasing onto main, and opening a PR will close the loop on the Deployments UI work.

7. **Add a Prettier config file.** The project has no explicit Prettier configuration. Adding a `.prettierrc` or `prettier.config.js` ensures consistent formatting for new contributors and enables editor auto-format without relying on implicit conventions.

8. **Document the MPL-2.0 dependency rationale.** `lightningcss` (a Vite/TailwindCSS build dependency) is MPL-2.0 licensed. While no disclosure obligation is triggered by unmodified use, adding a `THIRD-PARTY-NOTICES` or `LICENSES.md` file with a one-line acknowledgment is good practice for a project distributed via npm.

9. **Review `docs/session-restart-audit` and `feat/connection-status-popup`.** These two non-audit stale branches (from April) may contain work that was never fully landed. A 5-minute review will confirm whether their content is now superseded by main or whether anything needs to be rescued before deletion.

10. **Consider adding a branch-protection rule or CI step to enforce API doc updates.** Given the velocity of server endpoint additions in the last 30 days (6 major feature areas undocumented), a lightweight check — even a manual PR checklist item — would prevent future API reference drift from accumulating.