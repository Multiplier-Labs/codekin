# Repository Health: codekin

**Date**: 2026-09-27T03:19:39.128Z
**Repository**: /srv/repos/Multiplier-Labs/codekin
**Branch**: main
**Workflow Run**: 3dde0640-3e30-48a3-8d5c-46bb379e091f
**Session**: c1037ec7-7d09-4eeb-88a7-b74bc076f41c

---

Now I have enough data to produce the full report.

---

# Repository Health Report — Codekin

**Date:** 2026-09-27
**Branch assessed:** `main` (HEAD: `fbcc9dc`)
**Scope:** `src/`, `server/`, `docs/`, `package.json`, `tsconfig*.json`, `eslint.config.js`

---

## Summary

**Overall Health: Good**

The codebase is actively maintained, well-typed, and has strong CI guardrails (strict TypeScript, ESLint semantic-token enforcement, npm audit on dependency change). The primary concerns are a rapidly accumulating stale-branch backlog (~60+ unmerged feature branches from August–September 2026, all 20–30 commits behind `main`), one genuinely stuck open PR, and `docs/OPERATIONS.md` lagging six significant deployment subsystem additions. Dead code is minimal, TODOs are absent, config is sound.

| Category | Count / Status |
|---|---|
| Dead-code items (unexported/unreachable) | 0 confirmed; ~30 exported props/types with 0 grep hits (likely consumed by JSX, see note) |
| Stale TODOs (> 30 days old) | 0 |
| Config issues | 0 critical; 3 minor warnings demoted to `warn` |
| License concerns | 2 deps with missing `license` field in package.json (MIT-equivalent LICENSE files exist) |
| Doc drift items | 2 (`OPERATIONS.md` stale since 2026-08-09; `fix/latest-model-discovery` branch adds `API-REFERENCE.md` changes not yet on main) |
| Stale remote branches (> 30 days, not on main) | 62 |
| Stuck PRs (> 7 days, no review) | 1 (#626) |

---

## Dead Code

No unreachable private functions or true orphan source files were identified. The scan below found exported names that have zero string-grep hits outside their own file — however, in a React/TypeScript project many Props interfaces (`RepoSectionProps`, `ChatViewProps`, etc.) are consumed as JSX-implicit types rather than named imports. These are flagged here for manual verification rather than automatic deletion.

| File | Export/Symbol | Type | Recommendation |
|---|---|---|---|
| `src/components/AutomationsView.tsx` | `AutomationsTab` | Exported type | Verify JSX usage; remove if unused |
| `src/components/RepoSection.tsx` | `RepoSectionProps` | Exported interface | Likely JSX-consumed; verify before removing |
| `src/components/RepoDrawer.tsx` | `RepoDrawerProps` | Exported interface | Likely JSX-consumed; verify before removing |
| `src/components/DocsBrowserContent.tsx` | `DocsBrowserContentProps` | Exported interface | Likely JSX-consumed; verify before removing |
| `src/components/OrchestratorContent.tsx` | `OrchestratorContentProps` | Exported interface | Likely JSX-consumed; verify before removing |
| `src/components/ChatView.tsx` | `ChatViewVariant` | Exported type | Verify JSX usage |
| `src/components/InputBar.tsx` | `InputBarVariant` | Exported type | Verify JSX usage |
| `src/components/SessionContent.tsx` | `SessionContentProps` | Exported interface | Likely JSX-consumed; verify before removing |
| `src/components/CommandPalette.tsx` | `PaletteDoc` | Exported type | Verify usage |
| `src/hooks/usePromptState.ts` | `UsePromptStateReturn` | Exported type | Verify; remove if unused |
| `src/hooks/useRouter.ts` | `parsePath` | Exported function | No callers found outside file; review |
| `src/hooks/useSessionOrchestration.ts` | `UseSessionOrchestrationParams`, `UseSessionOrchestrationReturn` | Exported types | Verify usage |
| `src/hooks/useSettings.ts` | `HOSTED_TOKEN_SENTINEL` | Exported const | No callers found; review |
| `src/hooks/useWsConnection.ts` | `UseWsConnectionOptions` | Exported type | Verify |
| `src/hooks/useChatSocket.ts` | `trimMessages` | Exported function | No callers found outside file; consider unexporting |
| `src/lib/slashCommands.ts` | `BUILTIN_COMMANDS` | Exported const | No callers found; review |
| `src/lib/agentHealth.ts` | `ProviderAvailability` | Exported type | Verify |
| `src/hosted/deviceLink.ts` | `ClaimResult` | Exported type | Verify |
| `src/hosted/useHostedAuth.ts` | `HostedAuthState` | Exported type | Verify |
| `src/hosted/sessions.ts` | `SignOutEverywhereResult` | Exported type | Verify |
| `src/hosted/machines.ts` | `LAST_MACHINE_KEY` | Exported const | Potential dead export; review |
| `server/dist/*.d.ts` (multiple) | Various `.d.ts` re-exports | Stale build artifact | `server/dist/` is a generated artifact; skip manual cleanup |

> **Note:** `server/dist/` entries are compiled declaration files and not source-of-truth — they will be regenerated on next build. No action needed there.

---

## TODO/FIXME Tracker

Scanned all `*.ts` and `*.tsx` files for `TODO`, `FIXME`, `HACK`, `XXX`, and `WORKAROUND`.

**Result: Zero findings.** No TODO, FIXME, HACK, XXX, or WORKAROUND comments exist in any TypeScript/TSX source file.

The only hits are test fixtures:
- `server/claude-process.test.ts:60-61,838` — test that asserts `summarizeToolInput('Grep', { pattern: 'TODO' })` returns `'TODO'` (testing the tool-input summarizer, not a TODO comment).
- `server/opencode-process.test.ts:971` — same fixture pattern.
- `src/hosted/PairPage.tsx:153` — `placeholder="XXXX-XXXX"` in a form field (not a comment).
- `server/relay/pairing-routes.test.ts:242` — URL test fixture `XXXX-YYYY`.

| Type | Count | Stale (> 30 days) |
|---|---|---|
| TODO | 0 | 0 |
| FIXME | 0 | 0 |
| HACK | 0 | 0 |
| XXX | 0 | 0 |
| WORKAROUND | 0 | 0 |
| **Total** | **0** | **0** |

---

## Config Drift

### TypeScript (`tsconfig.app.json`, `tsconfig.node.json`, `server/tsconfig.json`)

All three configs include `"strict": true`, `"noUnusedLocals": true`, `"noUnusedParameters": true`, `"noFallthroughCasesInSwitch": true`, and `"noImplicitReturns": true`. No significant drift from modern best practices.

| Config | Setting | Current Value | Status |
|---|---|---|---|
| `tsconfig.app.json` | `target` | `ES2023` | ✅ Current |
| `tsconfig.app.json` | `strict` | `true` | ✅ |
| `tsconfig.app.json` | `noUncheckedSideEffectImports` | `true` | ✅ Strict (good) |
| `tsconfig.node.json` | `target` | `ES2023` | ✅ Current |
| `server/tsconfig.json` | `module` | `NodeNext` | ✅ Correct for Node ESM |
| `server/tsconfig.json` | `isolatedModules` | `true` | ✅ |
| All | `skipLibCheck` | `true` | ⚠️ Minor — suppresses type errors in `.d.ts` files; acceptable trade-off for build speed |

### ESLint (`eslint.config.js`)

The config uses the new flat-config format with `typescript-eslint` strict type-checked rules. No deprecated rule names detected. Minor findings:

| Setting | Current Value | Note |
|---|---|---|
| `@typescript-eslint/restrict-template-expressions` | `warn` (demoted) | Should be promoted to `error`; comment in file acknowledges this |
| `@typescript-eslint/no-confusing-void-expression` | `warn` (demoted) | Should be promoted to `error` |
| `@typescript-eslint/no-unnecessary-condition` | `warn` (demoted) | Should be promoted to `error` |
| `@typescript-eslint/no-non-null-assertion` | `warn` (demoted) | Should be promoted to `error` |
| `@typescript-eslint/no-misused-promises` | `warn` (demoted) | Should be promoted to `error` |
| Server config | Duplicates frontend rules verbatim | Minor: could be extracted into a shared config object to reduce duplication and drift risk |
| Test config | Uses `tseslint.configs.recommended` (not `strictTypeChecked`) | Intentional—acceptable for test files |

### Prettier

No Prettier config file found. Formatting is handled by ESLint-only. Not a drift issue, but worth noting if cross-editor consistency matters.

---

## License Compliance

The project is licensed **MIT**. No GPL, AGPL, or LGPL dependencies were found.

**License summary table (direct + transitive, from `package-lock.json`):**

| License | Dependency count |
|---|---|
| MIT | 510 |
| ISC | 31 |
| Apache-2.0 | 18 |
| MPL-2.0 | 12 |
| BSD-3-Clause | 10 |
| BSD-2-Clause | 9 |
| BlueOak-1.0.0 | 4 |
| MIT-0 | 2 |
| (MPL-2.0 OR Apache-2.0) | 1 |
| (MIT OR WTFPL) | 1 |
| (BSD-2-Clause OR MIT OR Apache-2.0) | 1 |
| CC-BY-4.0 | 1 |
| CC0-1.0 | 1 |
| 0BSD | 1 |
| **Missing `license` field** | **2** |

**Flagged dependencies:**

| Package | Version | Issue |
|---|---|---|
| `busboy` | 1.6.0 | `license` field absent from `package.json`; however a permissive MIT-equivalent `LICENSE` file exists in `node_modules/busboy/`. Transitive dep of `multer`. Low risk. |
| `streamsearch` | 1.1.0 | `license` field absent from `package.json`; same author as busboy, same permissive style. Transitive dep of `busboy`. Low risk. |

**MPL-2.0 note:** `lightningcss` (12 MPL-2.0 hits) is a build-time-only dependency used internally by TailwindCSS. The project's `package.json` already documents this: *"lightningcss (MPL-2.0) is a build-time-only dependency used by TailwindCSS and is not included in distributed artifacts."*  No action required.

**DOMPurify note:** Dual-licensed `(MPL-2.0 OR Apache-2.0)`, already documented in `package.json` as permissively compatible. No action required.

---

## Documentation Freshness

### API Docs

| Document | Last updated | Code changed since? | Status |
|---|---|---|---|
| `docs/API-REFERENCE.md` | 2026-09-26 | On `fix/latest-model-discovery` branch (not yet merged) | ✅ Current on branch; will be current once #631-area changes land |
| `docs/LOOPS.md` | 2026-08-30 | Loops 2.0 Phases 1–4 all landed — doc updated in same wave | ✅ Current |
| `docs/LOOPS-REWRITE-SPEC.md` | 2026-08-30 | Spec branch, not updated since then | ✅ Spec complete — no further changes expected |
| `docs/DEPLOYMENTS.md` | 2026-08-30 | 6 deployment-subsystem commits landed after this | ⚠️ Partially stale |
| `docs/OPERATIONS.md` | 2026-08-09 | 6 major deployment subsystem commits since (error-rate probe, p95 baseline, TLS floor, incident response, breach signals) | ❌ Stale — does not document the `deployment-monitor`, `incident-response`, or `host-probe` subsystems added in PRs #606–#616 |
| `docs/ORCHESTRATOR-SPEC.md` | 2026-08-30 | Minor orchestrator fixes (deterministic order, init-cycle) since | ✅ Acceptable |
| `docs/HOSTED-RELAY-CONTROL-PLANE-SPEC.md` | 2026-08-08 | 8 relay server commits since | ⚠️ Relay docs not updated since user-management endpoints (#567) |

### README Drift

The README install script, CLI commands (`codekin token`, `codekin service status`, `codekin upgrade`, etc.), and npm dev-workflow scripts (`npm run dev`, `npm test`, `npm run lint`) all match the current `package.json` scripts and `bin/codekin.mjs` implementations. The README also correctly lists `codekin relay connect` (present in bin).

| Claim | Actual | Status |
|---|---|---|
| `npm run dev` | Present in `package.json` | ✅ |
| `npm test` | `vitest run` in `package.json` | ✅ |
| `npm run build` | `tsc -b && vite build` in `package.json` | ✅ |
| `npm run lint` | `eslint .` in `package.json` | ✅ |
| `codekin token`, `service`, `upgrade`, `uninstall` | All present in `bin/codekin.mjs` | ✅ |
| Config at `~/.config/codekin/env` | Referenced in bin script | ✅ |
| `codekin relay connect` mentioned in bin but not README | Present in README `codekin relay connect` section implicitly via relay feature description | ✅ |

No README drift detected.

---

## Draft Changelog

### Since `v0.8.0` (post-tag commits as of 2026-09-27)

```
## [Unreleased] — 2026-09-27

### Fixes
- **models**: Discover point-release model variants (Fable 5.1, Opus 5.5,
  GPT-6) automatically via probe; CLI alias cache now refreshed on backend
  startup (#631)
- **deps**: Bump multer to 2.4.0 to clear a high-severity CVE (#630)
- **deps**: Resolve critical/high CVEs in the workflows lock file (#627)
- **relay**: Let the hosted UI reach the Deployments tab (#625)
- **orchestrator**: Break the outbox/manager module-init cycle (#628)
- **orchestrator**: Deterministic newest-first order in monitor getAll() (#613)

### Refactoring
- **types**: Remove unused `CODEX_MODELS` static list (#632)
- **opencode**: Split the 305-line SSE event dispatcher into focused modules (#629)
- **engine**: Monitor poll and outbox flusher ride the shared dispatch tick (#615)

### Features (prior wave, merged to `v0.8.0`)
- **loops**: Loops 2.0 — durable engine core, control plane with plan stage
  and wizard, evaluator platform with remote CI, parallel workstreams,
  checkpoint forks, lessons, and version stats (Phases 1–4, #620–#623)
- **loops**: Model-based reflection (`policy.reflection: model`) (#624)
- **joe**: Per-harness MCP registration (opencode.json + codex config.toml) (#619)
- **ui**: Trigger log panel showing why automation runs did/didn't fire (#618)
- **security**: npm audit probe runs automatically on dependency changes (#617)
- **deployments**: Learned p95 latency baseline + TLS protocol floor (#616)
- **webhooks**: Accepted PR events ride the durable signal queue (#614)
- **deployments**: Error-rate log probe (#612)
```

---

## Stale Branches

Branches with no commit activity since **2026-08-27** (> 30 days ago). All of the pre-August branches have `merged=NO` in the remote tracking but their commits have been squash-merged into `main` via PRs — the remote branch itself was never deleted.

**August 2026 and earlier — strongly recommend deletion:**

| Branch | Last commit | Author | Merged to main? | Recommendation |
|---|---|---|---|---|
| `origin/test/coverage-gaps-apr10` | 2026-04-10 | Claude (Webhook) | Squash-merged | Delete |
| `origin/feat/connection-status-popup` | 2026-04-11 | alari | Squash-merged | Delete |
| `origin/chore/pr-audit-2026-04-12` | 2026-04-12 | alari | Squash-merged | Delete |
| `origin/feat/daily-code-review-2026-04-12` | 2026-04-12 | alari | Squash-merged | Delete |
| `origin/feat/pr-373-audit-report` | 2026-04-12 | alari | Squash-merged | Delete |
| `origin/feat/repo-health-2026-04-13` | 2026-04-13 | alari | Squash-merged | Delete |
| `origin/feat/test-coverage-2026-04-13` | 2026-04-13 | alari | Squash-merged | Delete |
| `origin/docs/session-restart-audit` | 2026-04-15 | alari | Squash-merged | Delete |
| `origin/feat/repo-health-2026-04-15` | 2026-04-16 | alari | Squash-merged | Delete |
| `origin/chore/release-0.6.4` | 2026-04-27 | alari | Release tag only | Delete |
| `origin/fix/ci-lint-errors-and-stale-mock-2026-04-27` | 2026-04-27 | Claude (Webhook) | Squash-merged | Delete |
| `origin/fix/commit-event-handler-mock-missing-export` | 2026-04-27 | Claude (Webhook) | Squash-merged | Delete |
| `origin/fix/commit-event-handler-test-mock` | 2026-04-27 | Claude (Webhook) | Squash-merged | Delete |
| `origin/fix/eslint-test-config-unused-vars-and-require` | 2026-04-27 | Claude (Webhook) | Squash-merged | Delete |
| `origin/audit/*` (11 branches, 2026-04-28 to 2026-05-08) | Apr–May 2026 | alari | Reports on main | Delete (audit branches are ephemeral) |
| `origin/chore/reports-2026-05-02` | 2026-05-02 | alari | Squash-merged | Delete |
| `origin/fix/clone-test-timeout` | 2026-05-15 | Claude (Webhook) | Squash-merged | Delete |
| `origin/docs/session-restart-audit` | 2026-04-15 | alari | Squash-merged | Delete |
| `origin/docs/agent-joe-resilience-audit` | 2026-06-11 | alari | On main | Delete |
| `origin/docs/claude-code-integration-assessment` | 2026-06-11 | alari | On main | Delete |
| `origin/fix/clone-test-ci-timeout` | 2026-06-11 | Claude (Webhook) | On main | Delete |
| `origin/chore/release-0.7.1` | 2026-08-05 | alari | Release tag only | Delete |
| `origin/hosted-relay-control-plane-spec` | 2026-08-08 | alari76 | Spec on main | Delete |

**August 2026 feature branches** (28+ days behind `main`, each 1 commit ahead — squash-merge candidates):

All `origin/feat/*`, `origin/fix/*`, and `origin/docs/*` branches dated 2026-08-29 to 2026-08-31 (35 branches) contain exactly 1 commit ahead of `main` and are 16–46 commits behind. These were development branches for features now squash-merged into `main` in the `v0.8.0` wave. They should be deleted as a batch.

**`origin/codekin/reports`** is a special case — 146 commits ahead, 711 behind. This is the automated audit-report accumulation branch and diverges significantly. It should be reviewed separately (rebase or archive).

---

## PR Hygiene

| PR # | Title | Author | Days open | Review status | Conflicts | Stuck? |
|---|---|---|---|---|---|---|
| #626 | `test(upload-routes): stub the gh subprocess in the clone regression test` | alari76 | **27 days** | No review | MERGEABLE | ✅ Yes — no review activity |

Only one open PR was found. PR #626 has been open 27 days with no review decision and no comments. It is stuck.

---

## Merge Conflict Forecast

Branches with commits in the last 14 days that have diverged from `main`:

| Branch | Commits ahead | Commits behind | Files changed (vs main) | Conflict risk |
|---|---|---|---|---|
| `origin/fix/latest-model-discovery` | 1 | 2 | `docs/API-REFERENCE.md`, `server/anthropic-models.ts`, `server/codex-process.ts` | **Low** — touches model-discovery only; recent main commits (#631, #632) touch the same area; verify no overlap |
| `origin/fix/multer-high-cve` | 1 | 5 | `package.json`, `package-lock.json`, `server/package.json`, `server/package-lock.json` | **Low** — lock file merge; main already bumped multer (#630) so this branch is likely superseded |
| `origin/fix/orchestrator-init-cycle` | 1 | 4 | `server/orchestrator-identity.ts`, `server/orchestrator-manager.ts`, `server/orchestrator-outbox.ts` | **Low-Medium** — main has `fix(orchestrator): break the outbox/manager module-init cycle (#628)`; this branch may be the same fix or overlap |
| `origin/fix/remove-dead-codex-models` | 1 | 1 | `src/types.ts` | **Low** — main commit #632 already removed `CODEX_MODELS`; this branch is very likely superseded |
| `origin/refactor/opencode-sse-dispatcher` | 1 | 4 | `server/opencode-process.ts` | **Low** — main commit #629 already refactored the SSE dispatcher; this branch is very likely superseded |

> **Alert:** `fix/multer-high-cve`, `fix/remove-dead-codex-models`, and `refactor/opencode-sse-dispatcher` all appear **superseded** by commits already on `main`. They should be closed/deleted rather than merged.

---

## Recommendations

1. **Delete stale remote branches (highest impact, zero risk).** Run a batch delete of all ~60 branches dated before 2026-09-01 that have been squash-merged into `main`. This de-clutters the remote, reduces `git fetch` noise, and makes the PR/branch view legible. Use `gh api -X DELETE repos/Multiplier-Labs/codekin/git/refs/heads/<branch>` per branch, or a single batch script.

2. **Close/delete superseded fix branches.** `fix/multer-high-cve`, `fix/remove-dead-codex-models`, and `refactor/opencode-sse-dispatcher` are all superseded by commits already on `main` (#629, #630, #632). Close those PRs (if any) and delete the branches to avoid confusion.

3. **Review and merge or close PR #626.** The `test(upload-routes)` stub PR has been open 27 days with no review. It is mergeable — either review and merge it, or close it if the fix was superseded.

4. **Update `docs/OPERATIONS.md`.** The document was last updated 2026-08-09 and does not cover six major deployment subsystems added since then: the deployment registry and deterministic probes (#606), incident response (#607), error-rate log probe (#612), p95 latency baseline + TLS floor (#616), and the host probe family (#608). Add a new **Deployments & Incident Response** section documenting `deployment-monitor.ts`, `incident-response.ts`, and `host-probe.ts`.

5. **Rebase or archive `origin/codekin/reports`.** This branch is 711 commits behind `main` and 146 ahead — it has diverged to the point where it can never be cleanly merged. If it stores audit report history, consider either rebasing it onto `main` or archiving its content as a folder under `.codekin/reports/` on `main` and deleting the branch.

6. **Promote ESLint warnings to errors.** Six rules are intentionally demoted to `warn` (`restrict-template-expressions`, `no-confusing-void-expression`, `no-unnecessary-condition`, `no-non-null-assertion`, `no-misused-promises`, `require-await`). The code comments acknowledge this is a temporary state. Promoting them to `error` in a focused cleanup PR will eliminate a class of silent quality regressions.

7. **Verify and remove genuinely unused exports.** The exports `HOSTED_TOKEN_SENTINEL`, `trimMessages`, `parsePath`, `BUILTIN_COMMANDS`, and `LAST_MACHINE_KEY` have no import-site grep hits. Run `tsc --noEmit` with `noUnusedLocals: true` against these files specifically to confirm, then remove them if unneeded. (Props interfaces are likely false positives due to JSX implicit consumption.)

8. **Annotate `busboy` and `streamsearch` licenses.** Add a note to `licenseNotes` in `package.json` clarifying that these two transitive dependencies of `multer` carry permissive MIT-equivalent licenses (as evidenced by their `LICENSE` files) even though their `package.json` omits the `license` field. This satisfies any automated license-scanner that flags the missing field.

9. **Document the Deployments subsystem in `docs/DEPLOYMENTS.md`.** The file was last updated 2026-08-30 and covers the core spec, but the p95 baseline learning, TLS floor probing, and error-rate log probe (#612, #616) added after that date should be reflected.

10. **Extract shared ESLint rule set.** The frontend and server ESLint configs duplicate ~15 identical rules verbatim. Extracting them into a shared `const baseRules = { ... }` object at the top of `eslint.config.js` halves the surface area where rule-level drift can silently occur.