# Repository Health: codekin

**Date**: 2026-04-06T03:22:14.764Z
**Repository**: /srv/repos/codekin
**Branch**: main
**Workflow Run**: e756da1a-0037-4e8a-88c6-2c7e77021e23
**Session**: 78d0e07b-25f9-4ac9-9547-84b6a5a3d1d3

---

Now let me save the report to the reports directory.---

# Codekin — Repository Health Report
**Date:** 2026-04-06  
**Branch:** main  
**Assessed by:** Automated health check

---

## Summary

The repository is in good health overall. Active development is high (696 commits in the last 30 days), the TypeScript configuration is strict across all targets, and no raw TODO/FIXME annotations exist in first-party source files. Key findings are:

- **Dead code (minor):** One exported interface (`SlashAutocompleteHandle`) is defined but never consumed. `TimePicker` uses a default export in a codebase that otherwise uses named exports.
- **Docs drift:** `docs/FEATURES.md` references the removed `react-syntax-highlighter` dependency; the actual renderer uses `marked` + `highlight.js`.
- **Stale branches:** 13 of 15 remote branches (excluding `main`) have not merged and are significantly behind `main`, ranging from 2 to 350 commits behind. Several are older than 30 days.
- **License:** All dependencies are permissively licensed. Two entries report `unknown` license — worth investigating.
- **No TODOs/FIXMEs** in any first-party source file (only in vendored `node_modules`).
- **One open PR** (#287) has been open since 2026-04-05 with an `UNKNOWN` mergeability status.

---

## Dead Code

### Orphan Exported Symbols

| Symbol | File | Issue |
|---|---|---|
| `SlashAutocompleteHandle` | `src/components/SlashAutocomplete.tsx:31` | Exported interface never imported anywhere. The component uses `cmdk` for keyboard navigation internally; the handle type was likely a leftover from a `forwardRef` refactor. |

### Default Export Inconsistency

| Symbol | File | Issue |
|---|---|---|
| `TimePicker` | `src/components/TimePicker.tsx` | Uses `export default` while all other components in `src/components/` use named exports. Not dead code, but an inconsistency that makes tree-shaking and refactoring harder. |

### Internal Functions / Orphan Files

No orphan files were found — all server modules (`commit-event-handler.ts`, `session-restart-scheduler.ts`, `orchestrator-memory.ts`, `orchestrator-learning.ts`, `orchestrator-reports.ts`, `orchestrator-monitor.ts`, `error-page.ts`, `version-check.ts`, `session-persistence.ts`, `plan-manager.ts`) are imported by at least one other module. All frontend hooks and components are similarly imported.

---

## TODO/FIXME Tracker

**No TODO, FIXME, HACK, XXX, or WORKAROUND comments were found in any first-party source file** under `src/` or `server/`.

**Summary:** Total: 0 | By type: n/a | Stale: 0

---

## Config Drift

### TypeScript

All three tsconfig targets are well-configured with strict mode enabled.

| Config | Target | `strict` | `noUnusedLocals` | `noUnusedParameters` | Notes |
|---|---|---|---|---|---|
| `tsconfig.app.json` | ES2022 | ✅ | ✅ | ✅ | Also sets `erasableSyntaxOnly`, `noUncheckedSideEffectImports` |
| `tsconfig.node.json` | ES2023 | ✅ | ✅ | ✅ | Vite config only |
| `server/tsconfig.json` | ES2022 | ✅ | ✅ | ✅ | `NodeNext` module resolution, `isolatedModules`, `composite` |

### ESLint — Rules Demoted to Warnings

| Rule | Risk |
|---|---|
| `@typescript-eslint/no-unsafe-assignment` | Medium — allows `any` propagation |
| `@typescript-eslint/no-unsafe-argument` | Medium |
| `@typescript-eslint/no-unsafe-member-access` | Medium |
| `@typescript-eslint/no-unsafe-return` | Medium |
| `@typescript-eslint/no-non-null-assertion` | Low–Medium |
| `@typescript-eslint/no-unnecessary-condition` | Low |
| `@typescript-eslint/no-misused-promises` | Medium |
| `@typescript-eslint/require-await` | Low |

### Prettier

Configured (`semi: false, singleQuote: true, trailingComma: "all", printWidth: 120`). No issues.

---

## License Compliance

**Project license:** MIT

| License | Count | Status |
|---|---|---|
| MIT | 312 | ✅ Compatible |
| ISC | 18 | ✅ Compatible |
| MPL-2.0 | 12 | ✅ Build-time only |
| BSD-3-Clause | 9 | ✅ Compatible |
| Apache-2.0 | 8 | ✅ Compatible |
| BSD-2-Clause | 8 | ✅ Compatible |
| BlueOak-1.0.0 | 1 | ✅ Permissive |
| CC-BY-4.0 | 1 | ⚠️ Verify not bundled into output |
| CC0-1.0 | 1 | ✅ Public domain |
| 0BSD | 1 | ✅ Permissive |
| **unknown** | **2** | ⚠️ Needs investigation |

---

## Documentation Freshness

### Stale Reference

**`docs/FEATURES.md:57`** — Claims syntax highlighting uses `react-syntax-highlighter` (VS Code Dark+ theme). This dependency is not in `package.json`; actual stack is `marked` + `marked-highlight` + `highlight.js`.

### API Reference

`docs/API-REFERENCE.md` was updated 2026-04-04, but the approvals architecture overhaul (#280), security fixes, and subscription auth changes landed after that. A targeted review against `server/approval-manager.ts` and `server/session-routes.ts` is warranted.

### README Scripts

All scripts referenced in README.md (`npm run dev`, `npm run build`, `npm test`, `npm run test:watch`, `npm run lint`, `npm run preview`) exist in `package.json`. ✅

---

## Draft Changelog

*Changes since `v0.5.3` (2026-04-03):*

### Fixes
- Fall back to fresh session when `--resume` hangs with zero output (#292)
- Stabilize Claude process lifecycle to prevent restart loops (#290)
- Resolve restart loop caused by race condition in `startClaude()` (#288)
- Address 3 security audit warnings (W-01, W-02, W-03)
- Support subscription auth and unblock standalone CLI sessions (#283)
- Address 5 code review findings (W-02, W-03, W-04, W-09, I-09) (#282)
- Overhaul approvals architecture for parity with native CLI (#280)
- Upgrade lodash to 4.18.1 (high-severity audit vuln)
- Resolve Agent Joe passivity (#273)
- Improve long session stability and resource management (#272)

### Features
- Add `--dangerously-skip-permissions` as a permission mode setting

### Refactoring
- Reduce code complexity across 6 high-priority areas (#267)

### Tests
- Improve code coverage across server and frontend modules (#265)

### Chores
- Upgrade TypeScript 6, Vite 8, ESLint 10, jsdom 29

> 5 commits have landed since `v0.5.3` — consider cutting `v0.5.4`.

---

## Stale Branches

| Branch | Last Activity | Ahead | Behind | Merged? | Recommendation |
|---|---|---|---|---|---|
| `origin/fix/code-review-2026-04-05` | 2026-03-16 | 0 | 2 | ✅ Yes | Delete |
| `origin/chore/reports-2026-04-04` | 2026-03-16 | 1 | 11 | ❌ No | Delete (stale, superseded) |
| `origin/chore/reports-2026-04-05` | 2026-03-16 | 1 | 7 | ❌ No | Delete (stale, superseded) |
| `origin/codekin/reports` | 2026-03-16 | 57 | 350 | ❌ No | ⚠️ Delete (350 behind) |
| `origin/fix/resume-hang-fallback` | 2026-03-16 | 1 | 1 | ❌ No | Delete (superseded by #292) |
| `origin/feat/joe-chat-variant` | 2026-03-17 | 1 | 203 | ❌ No | ⚠️ Delete (203 behind) |
| `origin/chore/repo-health-report-2026-03-18` | 2026-03-18 | 2 | 196 | ❌ No | ⚠️ Delete (196 behind) |
| `origin/test/approval-flow-v3` | 2026-03-23 | 1 | 76 | ❌ No | Delete (approval arch overhauled in #280) |
| `origin/chore/repo-health-report-2026-03-25` | 2026-03-25 | 2 | 54 | ❌ No | Delete (superseded) |
| `origin/chore/repo-health-report-2026-03-26` | 2026-03-28 | 5 | 52 | ❌ No | Delete (superseded) |
| `origin/chore/repo-health-report-2026-03-30` | 2026-04-01 | 4 | 46 | ❌ No | Delete (superseded) |
| `origin/fix/lodash-audit-vulnerability` | 2026-04-03 | 1 | 34 | ❌ No | Delete (fix likely on main) |
| `origin/fix/long-session-stability` | 2026-04-03 | 2 | 35 | ❌ No | Review — possibly superseded by #290 |
| `origin/fix/security-audit-findings` | 2026-04-03 | 5 | 35 | ❌ No | ⚠️ High conflict risk — rebase or close |
| `origin/chore/repo-health-report-2026-03-14` | 2026-03-14 | 2 | 350 | ❌ No | ⚠️ Delete (oldest, 350 behind) |

**14 of 15** non-main branches are unmerged and stale.

---

## PR Hygiene

| # | Title | Author | Days Open | Review Status | Mergeable | Stuck? |
|---|---|---|---|---|---|---|
| #287 | chore: add repo health assessment for 2026-04-05 | alari76 | 1 | — | UNKNOWN | No |

One open PR, opened yesterday. No stuck PRs.

---

## Merge Conflict Forecast

| Branch | Last Activity | Ahead | Behind | Overlapping Files | Risk |
|---|---|---|---|---|---|
| `origin/fix/lodash-audit-vulnerability` | 2026-04-03 | 1 | 34 | `package.json`, `package-lock.json` | Low |
| `origin/fix/long-session-stability` | 2026-04-03 | 2 | 35 | `server/claude-process.ts`, `server/session-manager.ts` | Medium |
| `origin/fix/security-audit-findings` | 2026-04-03 | 5 | 35 | `server/ws-message-handler.ts`, `server/webhook-handler.ts` | **High** |
| `origin/test/approval-flow-v3` | 2026-03-23 | 1 | 76 | `server/approval-manager.ts` | **High** |
| `origin/chore/repo-health-report-2026-03-30` | 2026-04-01 | 4 | 46 | `.codekin/reports/` only | Low |

---

## Recommendations

1. **Branch cleanup sweep** — Delete the 12+ stale branches. Immediate candidates: `origin/codekin/reports`, `origin/chore/repo-health-report-2026-03-14`, `origin/feat/joe-chat-variant`, `origin/chore/repo-health-report-2026-03-18` (all 196–350 commits behind).

2. **Resolve `fix/security-audit-findings` conflict risk** — 5 diverged commits on the same files patched by recent security PRs. Rebase and merge or close as superseded.

3. **Investigate the 2 `unknown`-license dependencies** — Run the identification query and confirm license compatibility before the next release.

4. **Remove `SlashAutocompleteHandle` export** (`src/components/SlashAutocomplete.tsx:31`) — Zero consumers; wire it up or delete it.

5. **Fix `docs/FEATURES.md:57`** — Replace the stale `react-syntax-highlighter` reference with the actual renderer stack.

6. **Cut `v0.5.4`** — Five production-relevant fixes have landed since `v0.5.3`; worth a patch release.

7. **Promote ESLint warnings to errors** — Start with `no-unsafe-assignment` and `no-misused-promises` to prevent `any` propagation.

8. **Normalize `TimePicker` to a named export** — Aligns with the rest of `src/components/`.

9. **Review `docs/API-REFERENCE.md` against current approval routes** — The #280 overhaul may have changed request/response shapes not reflected in docs.

10. **Verify CC-BY-4.0 dependency** — Confirm it is documentation/data only and not compiled into distributed frontend assets.

---

*Report saved to `.codekin/reports/repo-health/2026-04-06_repo-health.md`*Committed and pushed. PR: Multiplier-Labs/codekin#293