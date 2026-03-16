# Codekin Repository Health Assessment — 2026-04-05

---

## Summary

**Overall Health Rating: Good**

The codebase is in solid shape with strict TypeScript across all configurations, zero TODO/FIXME debt, no license compliance issues, and a clean open-PR queue. The main areas requiring attention are a cluster of stale remote branches (many already merged), two slightly stale docs files, and a set of ESLint rules intentionally demoted to warnings that should be progressively promoted to errors.

| Metric | Value |
|---|---|
| Dead code items | 9 (possible unused exports; no orphans) |
| Stale TODOs/FIXMEs | 0 |
| Config drift issues | 3 (minor) |
| License concerns | 0 |
| Doc drift items | 2 |
| Stale/merged remote branches | 15+ already merged; ~9 unmerged-but-old |
| Open PRs | 0 |
| High-risk conflict branches | 1 (`fix/approvals-overhaul`) |

---

## Dead Code

### Possibly Unused Exports

| File | Export / Symbol | Type | Recommendation |
|---|---|---|---|
| `src/lib/ccApi.ts:178` | `getOrchestratorChildren` | Unused export | Review — no internal importer found; may be reserved for future UI panel |
| `src/lib/ccApi.ts:187` | `spawnOrchestratorChild` | Unused export | Review — same as above |
| `src/lib/ccApi.ts:201` | `queryOrchestratorMemory` | Unused export | Review — same as above |
| `src/lib/ccApi.ts:214` | `getOrchestratorTrust` | Unused export | Review — same as above |
| `src/lib/ccApi.ts:223` | `getOrchestratorDashboard` | Unused export | Review — same as above |
| `src/lib/ccApi.ts:232` | `getOrchestratorNotifications` | Unused export | Review — same as above |
| `src/types.ts:256` | `DocsPickerProps` | Unused type | Flag for removal if no planned consumer |
| `src/types.ts:267` | `MobileProps` | Unused type | Flag for removal if no planned consumer |
| `src/components/workflows/CustomWorkflowGuide.tsx:12` | `CustomWorkflowGuide` | Unused export | No import found anywhere in src/; review or remove |

**Notes:**
- The six `ccApi.ts` orchestrator functions may be intentionally pre-built for upcoming UI panels. If so, add a comment explaining their planned use.
- `DocsPickerProps` and `MobileProps` in `types.ts` appear to be vestigial type definitions not referenced by any component.
- `CustomWorkflowGuide` component has no importer — it may be a work-in-progress component or an oversight.

### Orphan Files

No orphan source files detected. All `.ts`/`.tsx` files are imported by at least one other module or serve as an entry point.

### Unreachable Internal Functions

No unreachable non-exported functions identified in `server/` or `src/`.

---

## TODO/FIXME Tracker

**No actionable TODO, FIXME, HACK, XXX, or WORKAROUND comments were found in the project source code.**

The only matches for the string "TODO" in the codebase are test fixture data in `server/claude-process.test.ts` (lines 61–62, 810) where `'TODO'` is used as a literal test input to `summarizeToolInput`, not as a developer annotation.

| Category | Count |
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

### Finding 1 — `server/tsconfig.json` missing `erasableSyntaxOnly`

| Config File | Setting | Current Value | Recommended Value |
|---|---|---|---|
| `server/tsconfig.json` | `erasableSyntaxOnly` | *(absent)* | `true` |

**Context:** `tsconfig.app.json` and `tsconfig.node.json` both set `"erasableSyntaxOnly": true` (added in TypeScript 5.5+). This option prevents use of `const enum` and `namespace` declarations that can't be erased by a non-TypeScript tool. The server config omits this, creating a minor inconsistency. Low risk since the server compiles directly with `tsc`, not a bundler like Vite.

---

### Finding 2 — ESLint rules demoted to `warn` in `eslint.config.js`

| Config File | Setting | Current Value | Recommended Value |
|---|---|---|---|
| `eslint.config.js` | `@typescript-eslint/restrict-template-expressions` | `warn` | `error` (when codebase is clean) |
| `eslint.config.js` | `@typescript-eslint/no-unsafe-assignment` | `warn` | `error` |
| `eslint.config.js` | `@typescript-eslint/no-unsafe-argument` | `warn` | `error` |
| `eslint.config.js` | `@typescript-eslint/no-unsafe-member-access` | `warn` | `error` |
| `eslint.config.js` | `@typescript-eslint/no-unsafe-return` | `warn` | `error` |
| `eslint.config.js` | `@typescript-eslint/no-non-null-assertion` | `warn` | `error` |
| `eslint.config.js` | `@typescript-eslint/no-misused-promises` | `warn` | `error` |
| `eslint.config.js` | `@typescript-eslint/require-await` | `warn` | `error` |
| `eslint.config.js` | `@typescript-eslint/no-unnecessary-condition` | `warn` | `error` |
| `eslint.config.js` | `@typescript-eslint/use-unknown-in-catch-callback-variable` | `warn` | `error` |
| `eslint.config.js` | `@typescript-eslint/no-confusing-void-expression` | `warn` | `error` |
| `eslint.config.js` | `@typescript-eslint/no-base-to-string` | `warn` | `error` |

**Context:** These rules are part of `strictTypeChecked` but have been intentionally downgraded to warnings with a comment indicating they should be promoted as the codebase matures. This is a tracked technical debt item within the config itself. The recommendation is to triage each rule, fix any remaining violations, and promote to `error`.

---

### Finding 3 — Missing `engines` field in `package.json`

| Config File | Setting | Current Value | Recommended Value |
|---|---|---|---|
| `package.json` | `engines.node` | *(absent)* | `">=20.0.0"` |

**Context:** The README and docs specify Node.js 20+ as a requirement, but `package.json` has no `engines` field to enforce this at install time. Adding `"engines": { "node": ">=20.0.0" }` would surface clear errors when users attempt to run on unsupported Node versions.

---

## License Compliance

**Project license:** MIT

All direct dependencies use permissive licenses. No copyleft concerns.

| License | Count | Dependencies |
|---|---|---|
| MIT | 30+ | express, ws, react, vite, eslint, vitest, tailwindcss, marked, cmdk, etc. |
| Apache-2.0 | 1 | typescript (dev-only, not distributed) |
| BSD-3-Clause | 1 | highlight.js |
| MPL-2.0 OR Apache-2.0 | 1 | dompurify |

**Flagged items (informational, not blocking):**

- **`dompurify`** — dual-licensed `MPL-2.0 OR Apache-2.0`. When distributed as a web application, the Apache-2.0 option applies, which is fully compatible with MIT. The MPL-2.0 option would require source disclosure only for *modifications to dompurify itself*, not for the application. No compliance issue for current usage.
- **`lightningcss`** — MPL-2.0, a transitive dependency of TailwindCSS 4. Used only at build time; not included in distributed web artifacts. No compliance issue.
- **`typescript`** — Apache-2.0, development-only dependency. Not distributed. No compliance issue.

**Verdict:** No license compliance issues. All flagged items have been reviewed and confirmed non-blocking.

---

## Documentation Freshness

### Stale Documentation

| Doc File | Last Updated | Related Source Files Changed | Status |
|---|---|---|---|
| `docs/GITHUB-WEBHOOKS-SPEC.md` | Before 2026-03-06 | `server/webhook-handler.ts`, `server/webhook-config.ts` (actor allowlist, security fixes — 2026-03-29, 2026-04-04) | **Stale — needs update** |
| `docs/FEATURES.md` | 2026-04-01 | `server/claude-process.ts` (dangerouslySkipPermissions mode — 2026-04-03, commit `34dae11`) | **Possibly stale — needs review** |

**Details:**

1. **`docs/GITHUB-WEBHOOKS-SPEC.md`** — The actor allowlist feature (`feat: add actor allowlist filter for webhook events`, PR #261, 2026-03-29) added a new configuration option to `server/webhook-config.ts` and new filtering logic to `server/webhook-handler.ts`. This spec was not updated with the last batch of docs fixes (`ba465bc`, 2026-04-01) or the subsequent docs PR (`bb82455`, 2026-04-04). The spec does not document the `actorAllowlist` field or how it interacts with webhook routing.

2. **`docs/FEATURES.md`** — The `--dangerously-skip-permissions` permission mode was added in commit `34dae11` (2026-04-03) after the last FEATURES.md update. It is a user-facing feature that should be documented in the feature list.

### Recently Updated Docs (in sync)

| Doc File | Updated | Related Commits |
|---|---|---|
| `docs/API-REFERENCE.md` | 2026-04-04 | Covers endpoints changed in 2026-04-04 security/fix PRs |
| `docs/ORCHESTRATOR-SPEC.md` | 2026-04-04 | Updated after orchestrator passivity fix (PR #273) |
| `docs/stream-json-protocol.md` | 2026-04-04 | Updated alongside ws-server and ws-message-handler changes |
| `docs/SETUP.md` | 2026-04-01 | No major server entry-point changes since |
| `docs/WORKFLOWS.md` | 2026-04-01 | No breaking workflow changes since |
| `docs/INSTALL-DISTRIBUTION.md` | 2026-04-01 | No distribution changes since |

### README Drift

No README drift detected. All commands and paths verified:

| README Item | Status |
|---|---|
| `npm install` | OK |
| `npm run dev` | OK — maps to `vite` |
| `npm run build` | OK — maps to `tsc -b && vite build` |
| `npm test` | OK — maps to `vitest run` |
| `npm run test:watch` | OK — maps to `vitest` |
| `npm run lint` | OK — maps to `eslint .` |
| `codekin token`, `config`, `service`, `start`, `setup`, `upgrade`, `uninstall` | All implemented in `bin/codekin.mjs` |
| `docs/screenshot.png` | Exists |
| `docs/INSTALL-DISTRIBUTION.md` | Exists |
| `CONTRIBUTING.md` | Exists |
| `LICENSE` | Exists |

**Minor omission:** `npm run preview` exists in `package.json` but is not mentioned in the README or CLAUDE.md. Not a drift issue (it is a standard Vite command), but worth adding for completeness.

---

## Draft Changelog

### [Unreleased] — since v0.5.3

#### Fixes
- Address 3 security audit warnings (W-01, W-02, W-03) — hardening in webhook handler and WS message handler (`3f1047e`)

#### Documentation
- Update API reference, orchestrator spec, stream-JSON protocol docs, and changelog (`bb82455`)

---

### [v0.5.3] — 2026-04-03

#### Features
- Add `--dangerously-skip-permissions` as a permission mode setting; pass `CODEKIN_SKIP_PERMISSIONS` env to hooks (`34dae11`, `8d72746`)
- Add actor allowlist filter for webhook events — only process events from configured GitHub actors (#261, `ab0f422`)

#### Fixes
- Overhaul approvals architecture for parity with native Claude CLI (#280, `da1e26b`)
- Support subscription auth and unblock standalone CLI sessions (#283, `86ab1b5`)
- Address 5 code review findings: W-02, W-03, W-04, W-09, I-09 — auth routes, config, session routes, WS handler (#282, `7c5893f`)
- Resolve Agent Joe passivity — orchestrator agent no longer goes passive during long idle periods (#273, `a642843`)
- Improve long session stability and resource management (#272, `824efcf`)
- Address security and code review findings from 2026-04-02 audit (`c47ca94`)
- Archived sessions not showing for worktree-based manual sessions (#264, `d282e4a`)
- Fix context size management for GPT and Gemini review tools (#262, `b9d8b10`)
- Upgrade lodash to 4.18.1 to resolve high-severity audit vulnerabilities (`92ca595`)
- Resolve 3 ESLint errors breaking CI (`97c15db`)

#### Refactoring
- Reduce code complexity across 6 high-priority areas (#267, `917f748`)

#### Tests
- Improve code coverage across server and frontend modules (#265, `1fa73a3`)

#### Chores
- Upgrade TypeScript 6, Vite 8, ESLint 10, jsdom 29 (`958615c`)
- Improve dependency health per 2026-03-31 audit (`4ad2d8c`)
- Add skip patterns for translations, assets, and generated files (`9343359`)
- Update ExitPlanMode hook and bump GPT model default (`6bfec63`)

#### Documentation
- Fix documentation issues from weekly audit (`ba465bc`)
- Update changelog and README for v0.5.2 (#279, `65ae310`)

---

## Stale Branches

### Already-Merged Remote Branches (recommend deletion)

| Branch | Last Commit | Author | Merged? | Recommendation |
|---|---|---|---|---|
| `origin/docs/api-reference-and-spec-updates` | 2026-04-04 | alari | Yes (PR #286) | **Delete** |
| `origin/fix/security-warnings-w01-w02-w03` | 2026-04-04 | alari | Yes (PR #285) | **Delete** |
| `origin/chore/reports-2026-04-01` | 2026-04-04 | alari | Yes | **Delete** |
| `origin/chore/dependency-updates-2026-03-18` | 2026-03-19 | alari | Yes | **Delete** |
| `origin/chore/docs-cleanup-2026-03-18` | 2026-03-18 | alari | Yes | **Delete** |
| `origin/fix/bug-fixes-2026-03-18` | 2026-03-19 | alari | Yes | **Delete** |
| `origin/fix/security-hardening-2026-03-18` | 2026-03-18 | alari | Yes | **Delete** |
| `origin/refactor/reduce-complexity-2026-03-18` | 2026-03-18 | alari | Yes | **Delete** |
| `origin/test/diff-parser-coverage-2026-03-18` | 2026-03-18 | alari | Yes | **Delete** |
| `origin/feat/dangerously-skip-permissions` | 2026-04-03 | alari | Yes | **Delete** |
| `origin/chore/dependency-health` | 2026-04-01 | alari | Yes | **Delete** |
| `origin/refactor/complexity-improvements` | 2026-04-01 | alari | Yes | **Delete** |
| `origin/docs/audit-fixes` | 2026-04-01 | alari | Yes | **Delete** |
| `origin/test/improve-coverage` | 2026-04-01 | alari | Yes | **Delete** |
| `origin/docs/comment-audit-improvements` | 2026-03-21 | alari | Yes | **Delete** |

### Unmerged but Likely Superseded (review and delete if confirmed)

| Branch | Last Commit | Merged? | Notes |
|---|---|---|---|
| `origin/fix/aging-warnings-w02-w03-w04-w09-i09` | 2026-04-04 | No (but likely = PR #282) | Same files touched as merged PR #282 |
| `origin/fix/subscription-auth-and-hook-passthrough` | 2026-04-04 | No (but likely = PR #283) | Same files touched as merged PR #283 |
| `origin/fix/long-session-stability` | 2026-04-03 | No (but likely = PR #272) | Same change as merged PR #272 |
| `origin/fix/orchestrator-passive-agent` | 2026-04-03 | No (but likely = PR #273) | Same change as merged PR #273 |
| `origin/fix/security-audit-findings` | 2026-04-03 | No (but likely = `c47ca94`) | Likely superseded |
| `origin/chore/repo-health-report-2026-03-14` | 2026-03-14 | No | Reports-only; safe to delete |
| `origin/chore/repo-health-report-2026-03-18` | 2026-03-18 | No | Reports-only; safe to delete |
| `origin/feat/joe-chat-variant` | 2026-03-17 | No | Unshipped feature; review if still planned |
| `origin/fix/plan-mode-exit-stuck` | 2026-03-22 | No | May be superseded by subsequent plan-mode work |
| `origin/refactor/shepherd-to-orchestrator` | 2026-03-22 | No | Rename refactor; verify not needed |
| `origin/refactor/plan-manager-state-machine` | 2026-03-25 | No | Significant unmerged refactor; review intent |
| `origin/fix/plan-mode-gating-enforcement` | 2026-03-25 | No | May be superseded |
| `origin/docs/improve-code-comments` | 2026-03-28 | No | Docs; check if content incorporated elsewhere |

### Special-Purpose Diverged Branch

| Branch | Last Commit | Ahead/Behind | Notes |
|---|---|---|---|
| `origin/codekin/reports` | 2026-04-03 | +57 / -343 | Automated report storage branch; intentionally diverged; do not merge or delete without understanding the pipeline |

---

## PR Hygiene

**No open pull requests as of 2026-04-05.**

The `gh pr list` command returned an empty array for `Multiplier-Labs/codekin`. The repository has a clean PR queue with all recent work merged.

---

## Merge Conflict Forecast

### Active Branches (commits in last 14 days)

| Branch | Ahead of main | Behind main | Overlapping Files | Risk |
|---|---|---|---|---|
| `fix/approvals-overhaul` | 2 | 13 | `server/approval-manager.ts`, `server/session-manager.ts`, `server/auth-routes.ts`, `server/session-routes.ts`, `.claude/hooks/pre-tool-use.mjs` | **HIGH** |
| `fix/aging-warnings-w02-w03-w04-w09-i09` | 1 | 7 | `server/auth-routes.ts`, `server/claude-process.ts`, `server/config.ts`, `server/session-routes.ts`, `server/webhook-handler.ts`, `server/ws-message-handler.ts` | LOW (likely already merged) |
| `fix/subscription-auth-and-hook-passthrough` | 1 | 6 | `server/claude-process.ts`, `server/ws-server.ts`, `server/ws-message-handler.ts` | LOW (likely already merged) |
| `fix/long-session-stability` | 2 | 28 | `server/claude-process.ts`, `server/session-manager.ts` | LOW (likely already merged) |
| `fix/orchestrator-passive-agent` | 4 | 28 | `server/claude-process.ts`, `server/orchestrator-manager.ts` | LOW (likely already merged) |
| `fix/security-audit-findings` | 5 | 28 | multiple server files | LOW (likely already merged) |
| `codekin/reports` | 57 | 343 | `.codekin/reports/**` only | NONE (no code overlap) |

**High-risk detail — `fix/approvals-overhaul`:**

This branch contains 2 unique commits that modify `server/approval-manager.ts` and `server/session-manager.ts`. Main has since merged `da1e26b` (approvals overhaul, PR #280) which touched the **same files**. If this branch is a precursor to PR #280, it is already superseded. If it contains additional changes not in PR #280, merging it would likely produce conflicts in `approval-manager.ts` and `session-manager.ts`. Recommend investigating this branch before any merge attempt.

**Low-risk branches:** The five "likely already merged" branches (`fix/aging-warnings-*`, `fix/subscription-auth-*`, `fix/long-session-stability`, `fix/orchestrator-passive-agent`, `fix/security-audit-findings`) are 6–28 commits behind main. Their content appears to correspond to already-merged PRs (#272, #273, #280, #282, #283). These should be confirmed and deleted rather than merged again.

---

## Recommendations

1. **Delete merged remote branches** (highest impact / lowest risk) — 15+ remote branches have been merged into main and can be bulk-deleted. This cleans up the branch list and reduces cognitive overhead. Run:
   ```bash
   git fetch --prune
   git branch -r --merged origin/main | grep -v 'origin/main' | sed 's/origin\///' | xargs -I{} gh api repos/Multiplier-Labs/codekin/git/refs/heads/{} --method DELETE
   ```

2. **Investigate and delete the "likely superseded" unmerged branches** — Confirm that `fix/approvals-overhaul`, `fix/aging-warnings-*`, `fix/subscription-auth-*`, `fix/long-session-stability`, `fix/orchestrator-passive-agent`, and `fix/security-audit-findings` are indeed superseded by their corresponding merged PRs, then delete them. Pay special attention to `fix/approvals-overhaul` which has the highest conflict risk.

3. **Update `docs/GITHUB-WEBHOOKS-SPEC.md`** — Document the `actorAllowlist` configuration option added in PR #261. This is a user-facing feature that is completely undocumented in the spec.

4. **Add `--dangerously-skip-permissions` to `docs/FEATURES.md`** — The feature added in `34dae11` is missing from the feature documentation. Add a description of the mode and its security implications.

5. **Audit unused exports in `src/lib/ccApi.ts`** — The six orchestrator API functions (`getOrchestratorChildren`, `spawnOrchestratorChild`, `queryOrchestratorMemory`, `getOrchestratorTrust`, `getOrchestratorDashboard`, `getOrchestratorNotifications`) have no internal importers. If these are planned for future UI panels, add an explanatory comment. If not, remove them to reduce the dead-surface area.

6. **Remove `DocsPickerProps`, `MobileProps` from `src/types.ts`** and delete `CustomWorkflowGuide.tsx` if no consumer exists or is planned — these add noise to the type surface and component tree without providing value.

7. **Progressively promote ESLint `warn` rules to `error`** — The 12 `strictTypeChecked` rules demoted to warnings in `eslint.config.js` represent unresolved type-safety gaps. Running `eslint . --rule '{"@typescript-eslint/no-unsafe-assignment": "error"}'` will reveal the remaining violations. Tackling these one rule at a time will strengthen the type safety guarantees.

8. **Add `engines` field to `package.json`** — Enforce the documented Node.js 20+ requirement at install time:
   ```json
   "engines": { "node": ">=20.0.0" }
   ```

9. **Add `erasableSyntaxOnly: true` to `server/tsconfig.json`** — Minor consistency fix to align the server TypeScript config with the frontend and Vite configs.

10. **Review `origin/feat/joe-chat-variant` and `origin/refactor/plan-manager-state-machine`** — These are the two most substantive unmerged non-reports branches with no clear corresponding merged PR. Determine whether they represent active work, abandoned experiments, or ideas that should be tracked as issues instead of open branches.
