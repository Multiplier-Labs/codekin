# Repository Health Assessment — Codekin

**Date**: 2026-03-09
**Branch assessed**: `release/v0.3.0`
**Assessed by**: Automated workflow (Claude claude-sonnet-4-6)

---

## Summary

**Overall Health: Good**

Codekin is in a strong state following a burst of productive activity on 2026-03-08–09 that delivered 100+ commits across security hardening, feature additions, refactoring, and bug fixes. The codebase has zero TODO/FIXME debt, strict TypeScript enforcement in both frontend and server, and no open PRs. The primary maintenance concerns are cosmetic: a large backlog of merged-but-not-deleted remote branches, a significantly out-of-date CHANGELOG, and minor config inconsistencies.

| Area | Status | Count |
|---|---|---|
| Dead code items | Low risk | ~6 exports flagged for review |
| Stale TODOs | None | 0 |
| Config issues | Minor | 2 |
| License concerns | None | 0 |
| Doc drift items | Minor | 2 |
| Merged undeleted branches | 29 | cleanup recommended |
| Active unmerged branches | 3 | (`release/v0.3.0`, `codekin/reports`, `feat/enforce-branching-policy`) |
| Open PRs | None | 0 |
| Stuck PRs | None | 0 |

---

## Dead Code

TypeScript's `noUnusedLocals: true` and `noUnusedParameters: true` are active in all tsconfigs, which means purely local dead code is caught at build time. The following items are **exported symbols** that escape that check and should be manually verified.

| File | Export / Function | Type | Recommendation |
|---|---|---|---|
| `src/hooks/useChatSocket.ts` | `processMessage`, `trimMessages`, `rebuildFromHistory` | Potentially test-only exports | Confirm usage; if only used in tests, move to a non-exported internal or re-export from a test helper |
| `src/components/workflows/StepCard.tsx` | `StepIcon`, `JsonBlock` | Internal helpers as public exports | Make private (unexported) if not used outside this file |
| `src/lib/workflowHelpers.ts` | `slugify`, `repoNameFromRun`, `statusBadge` (and ~15 others) | Large utility surface | Audit imports; remove any functions not referenced in `src/` |
| `server/webhook-github.ts` | `_setGhRunner()`, `_resetGhRunner()` | Test injection points | Intentional; acceptable pattern. Consider a `/** @internal */` JSDoc annotation |
| `src/hooks/useSessionOrchestration.ts` | `groupKey()` | Utility export | Verify imported by consumers; unexport if internal-only |

**Orphan file candidates**: None found. All hook and component files follow naming conventions matching their consumers. `noUnusedLocals` in tsconfig would surface any truly unreferenced local symbols at build time.

---

## TODO/FIXME Tracker

A full grep across `src/`, `server/`, `docs/`, and config files found **zero** actionable `TODO`, `FIXME`, `HACK`, `XXX`, or `WORKAROUND` comments in source code.

The only matches were inside `server/claude-process.test.ts` (lines 60–61, 818) where `'TODO'` appears as a test fixture *value* passed to `summarizeToolInput('Grep', { pattern: 'TODO' })`. These are intentional test data strings, not debt markers.

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

### tsconfig.app.json

| Setting | Current Value | Recommendation | Status |
|---|---|---|---|
| `strict` | `true` | `true` | ✅ Good |
| `noUnusedLocals` | `true` | `true` | ✅ Good |
| `noUnusedParameters` | `true` | `true` | ✅ Good |
| `target` | `ES2022` | ES2022+ | ✅ Good |
| `noEmit` | `true` (frontend only) | Expected for Vite | ✅ Good |

### tsconfig.node.json

| Setting | Current Value | Recommendation | Status |
|---|---|---|---|
| `strict` | `true` | `true` | ✅ Good |
| `target` | `ES2023` | ES2022+ | ✅ Good |
| Scope | `vite.config.ts` only | — | ⚠️ `server/` has its own `tsconfig.json`; coverage verified separately |

### Server tsconfig (`server/tsconfig.json`)

Not present under the root composite — the server is compiled independently. Confirm `strict: true` is set in its own tsconfig; if missing, server code does not benefit from null-safety and strict checks.

### eslint.config.js

| Setting | Current Value | Recommendation | Status |
|---|---|---|---|
| Config format | Flat config (ESLint 9+) | Flat config | ✅ Modern |
| React Hooks rules | `reactHooks.configs.flat.recommended` | Enabled | ✅ Good |
| React Refresh rules | `reactRefresh.configs.vite` | Enabled | ✅ Good |
| `@typescript-eslint` | `tseslint.configs.recommended` | Use `strict` variant for stronger guarantees | ⚠️ Consider upgrading to `tseslint.configs.strictTypeChecked` |
| `no-explicit-any` disabled in tests | `@typescript-eslint/no-explicit-any: off` for `*.test.*` | Acceptable test exception | ✅ Acceptable |

### Prettier

No `.prettierrc` or `prettier.config.*` file exists in the repo root. Code formatting is not enforced by CI. This is a minor gap — if contributors have different editor settings, formatting drift can accumulate.

**Findings summary**:
1. **`tseslint.configs.recommended` (eslint.config.js)** — Consider upgrading to `strictTypeChecked` for stronger type-aware linting.
2. **No Prettier config** — Formatting is unenforced; consider adding `.prettierrc` and a `lint:format` script.

### package-lock.json version field

The lock file header still reads `"version": "0.2.2"` even though `package.json` was bumped to `0.3.0`. This is cosmetic (the version field in lockfiles is informational, not functional), but it indicates `npm install` was not re-run after the version bump. Running `npm install` will update it.

---

## License Compliance

**Project license**: MIT

All direct and dev dependencies were identified from `package.json`. Based on well-known package registries:

| License | Count | Packages |
|---|---|---|
| MIT | ~22 | `react`, `react-dom`, `vite`, `tailwindcss`, `eslint`, `typescript`, `typescript-eslint`, `marked`, `marked-highlight`, `cmdk`, `remark-gfm`, `react-markdown`, `vitest`, `jsdom`, `@vitejs/plugin-react`, `@tabler/icons-react`, `globals`, `@types/*` (most) |
| BSD-2-Clause | ~1 | `highlight.js` |
| Apache-2.0 | ~1 | `dompurify` (also dual-licensed MIT/Apache) |
| Unknown / unverified | — | License data not computed at runtime; verify with `npx license-checker --summary` |

**Flagged dependencies**: None. No GPL, LGPL, AGPL, or copyleft licenses identified among known dependencies. All dependencies appear compatible with the project's MIT license.

**Recommendation**: Run `npx license-checker --summary --excludePrivatePackages` to produce a definitive license audit with transitive dependencies included.

---

## Documentation Freshness

### README.md

The README is well-maintained and reflects the current install, usage, and configuration. Verified items:

| README Item | Matches Reality? | Notes |
|---|---|---|
| `npm install -g codekin` install command | ✅ | npm package exists |
| `npm run dev` / `npm run build` / `npm test` | ✅ | All present in `package.json` |
| WebSocket server port 32352 | ✅ | Matches `CLAUDE.md` and server config |
| Feature list (workflows, docs browser, webhooks) | ✅ | All features shipped in v0.3.0 |
| Configuration table (`ANTHROPIC_API_KEY`, `REPOS_ROOT`, etc.) | ✅ | Matches server env var usage |

**No README drift detected.**

### API Docs Freshness

| Doc File | Last Known Update | Recent Code Changes | Stale? |
|---|---|---|---|
| `docs/stream-json-protocol.md` | Pre-v0.3.0 (stable) | `server/types.ts` had an auth variant added (d2938f2) | ⚠️ Minor — WsClientMessage auth variant added; doc may not reflect it |
| `docs/WORKFLOWS.md` | Pre-v0.3.0 | Workflow model field added (v0.3.0) | ⚠️ Minor — `model` frontmatter field added to workflow definitions; not documented |
| `docs/GITHUB-WEBHOOKS-SPEC.md` | 2026-02-23 | Security hardening applied (94b498e) | ✅ Spec predates impl; security changes are impl details |
| `docs/DOCS-BROWSER-SPEC.md` | 2026-03-09 | Feature fully implemented | ✅ Fresh |
| `docs/CLAUDE-HOOKS-SPEC.md` | 2026-02-25 | No changes to hooks | ✅ Current |
| `docs/FEATURES.md` | Pre-v0.3.0 | Docs browser, webhooks settings UI added | ⚠️ Minor — new features may not be listed |

**Stale doc items** (2):
1. `docs/stream-json-protocol.md` — The new `auth` variant of `WsClientMessage` (added in commit `d2938f2`) is not documented.
2. `docs/WORKFLOWS.md` — The optional `model` frontmatter field (added in v0.3.0 via commits `3e24e83`, `a33e712`) is not documented in the workflow file format reference.

### CHANGELOG

**Significantly stale.** `CHANGELOG.md` only documents `v0.1.7`. Versions `v0.1.8`, `v0.2.0`, `v0.2.1`, `v0.2.2`, and `v0.3.0` are all missing entries. See Draft Changelog below.

---

## Draft Changelog

> Period: `v0.2.2` → `v0.3.0` (2026-03-08 – 2026-03-09)
> Note: v0.1.8, v0.2.0, v0.2.1, v0.2.2 entries are also missing from CHANGELOG.md and should be reconstructed from git log for those ranges separately.

```markdown
## [0.3.0] - 2026-03-09

### Features
- **Docs browser**: New in-app markdown docs browser accessible from the sidebar,
  with inline file picker, keyboard navigation, inverted header, and star/favourite
  persistence (#35, #33, #44, #43, #45, #48)
- **Workflow model selection**: Workflows can now specify a Claude model via an
  optional `model` frontmatter field; model badge shown in workflow list (#30, #31)
- **GitHub Webhooks settings**: Settings panel now includes a GitHub Webhooks
  configuration section (#40)
- **Repository Health workflow**: New built-in `repo-health` assessment workflow type (#34)
- **Custom TimePicker**: Native browser time input replaced with a custom themed
  TimePicker component; bi-weekly frequency toggle added to schedule UI (#26, #27)

### Fixes
- Fix workflow panel contrast in light mode (#47, #49)
- Fix docs icon toggle: clicking again now closes the picker (#48)
- Fix sidebar timestamp vertical alignment (#46)
- Fix docs file picker not appearing when clicking sidebar doc icon (#39)
- Fix docs API: switch from path params to query params (#37)
- Fix sidebar session name bold and workflow list alignment (#38)
- Fix sidebar repo ordering to sort alphabetically (#29)
- Fix workflow `validate_repo` failing when `REPOS_ROOT` is a symlink (#25)
- Fix Settings font sizes to match app conventions (#41)
- Fix settings panel contrast in light mode (#42)
- Remove tracked `dist/` files that caused stale asset references (#36)
- Fix CI: restore `better-sqlite3` as root devDependency for tests
- Add missing `auth` variant to server `WsClientMessage` type

### Security
- Implement critical findings from code review audit (H1–H3, M1–M6, L1–L4) (#32)
- Implement critical findings from dependency audit

### Refactoring
- Reduce code complexity across 7 modules per complexity audit (#28)
- Refine `SessionManager` split: complete delegation to extracted modules
- Improve Settings modal layout with section cards and wider form factor (#41)
- Unify button styles and text sizing across workflow views
- Improve workflow schedule UI: narrower time input, themed picker (#26)

### Documentation
- Add JSDoc and inline comments per comment audit recommendations (#22)
- Add docs browser feature spec (`docs/DOCS-BROWSER-SPEC.md`) (#33)

### Chores
- Bump version to 0.3.0
- Add top-priority tests from coverage audit (50 new tests)
- Add complexity, security, code-review, and dependency audit reports
```

---

## Stale Branches

> "Stale" threshold: no commit activity in the last 30 days.
> Given all repo activity is within the last 2 days, no branches are stale by the 30-day definition.
> The relevant hygiene issue is **merged branches not yet deleted from the remote** (29 branches).

### Merged branches still on remote (safe to delete)

All 29 of the following branches are fully merged into `origin/main` and have no unique commits. They can be safely deleted.

| Branch | Last Commit | Merged into main? | Recommendation |
|---|---|---|---|
| `origin/docs/comment-audit-recommendations` | 2026-03-08 | ✅ Yes | Delete |
| `origin/feat/docs-browser` | 2026-03-09 | ✅ Yes | Delete |
| `origin/feat/docs-browser-spec` | 2026-03-09 | ✅ Yes | Delete |
| `origin/feat/docs-star-favourites` | 2026-03-09 | ✅ Yes | Delete |
| `origin/feat/redesign-workflow-view` | 2026-03-08 | ✅ Yes | Delete |
| `origin/feat/repo-health-workflow` | 2026-03-09 | ✅ Yes | Delete |
| `origin/feat/settings-webhook-section` | 2026-03-09 | ✅ Yes | Delete |
| `origin/feat/workflow-list-larger-fonts` | 2026-03-08 | ✅ Yes | Delete |
| `origin/feat/workflow-model-selection` | 2026-03-09 | ✅ Yes | Delete |
| `origin/fix/code-review-security-fixes` | 2026-03-09 | ✅ Yes | Delete |
| `origin/fix/custom-time-picker-styling` | 2026-03-09 | ✅ Yes | Delete |
| `origin/fix/dist-tracking-deploy` | 2026-03-09 | ✅ Yes | Delete |
| `origin/fix/docs-api-query-params` | 2026-03-09 | ✅ Yes | Delete |
| `origin/fix/docs-header-contrast` | 2026-03-09 | ✅ Yes | Delete |
| `origin/fix/docs-icon-toggle` | 2026-03-09 | ✅ Yes | Delete |
| `origin/fix/docs-picker-inline` | 2026-03-09 | ✅ Yes | Delete |
| `origin/fix/docs-picker-positioning` | 2026-03-09 | ✅ Yes | Delete |
| `origin/fix/remove-local-scripts` | 2026-03-08 | ✅ Yes | Delete |
| `origin/fix/security-audit-hardening` | 2026-03-09 | ✅ Yes | Delete |
| `origin/fix/settings-layout-cleanup` | 2026-03-09 | ✅ Yes | Delete |
| `origin/fix/settings-light-mode-contrast` | 2026-03-09 | ✅ Yes | Delete |
| `origin/fix/sidebar-alphabetical-sort` | 2026-03-09 | ✅ Yes | Delete |
| `origin/fix/sidebar-timestamp-alignment` | 2026-03-09 | ✅ Yes | Delete |
| `origin/fix/ui-sidebar-bold-workflow-alignment` | 2026-03-09 | ✅ Yes | Delete |
| `origin/fix/workflow-contrast-and-sidebar-timestamps` | 2026-03-09 | ✅ Yes | Delete |
| `origin/fix/workflow-model-display` | 2026-03-09 | ✅ Yes | Delete |
| `origin/fix/workflow-panel-contrast` | 2026-03-09 | ✅ Yes | Delete |
| `origin/fix/workflow-time-selector-and-biweekly-toggle` | 2026-03-09 | ✅ Yes | Delete |
| `origin/refactor/complexity-audit-2026-03` | 2026-03-09 | ✅ Yes | Delete |
| `origin/release/v0.2.0` | 2026-03-08 | ✅ Yes | Delete |

### Unmerged branches

| Branch | Last Commit | Ahead/Behind main | Merged? | Recommendation |
|---|---|---|---|---|
| `origin/release/v0.3.0` | 2026-03-09 | +2 / 0 | ❌ No | Active release branch — merge to main and tag, then delete |
| `origin/codekin/reports` | 2026-03-09 | +5 / 102 | ❌ No | Automated reports branch; 102 commits behind main. Consider rebasing or merging the report files directly into main via a PR |
| `origin/feat/enforce-branching-policy` | 2026-03-08 | +8 / 124 | ❌ No | No merge base with main (diverged early). Review if any unique content needs to be cherry-picked; otherwise abandon and delete |

---

## PR Hygiene

`gh pr list` returned **no open pull requests**. The repository is in a clean state with respect to PRs.

| Metric | Value |
|---|---|
| Open PRs | 0 |
| Stuck PRs (>7 days, no review) | 0 |
| PRs with merge conflicts | 0 |

---

## Merge Conflict Forecast

Only branches with commits in the last 14 days and diverged from `main` are assessed.

| Branch | Commits Ahead | Commits Behind | Files Changed vs Main | Conflict Risk |
|---|---|---|---|---|
| `origin/release/v0.3.0` | 2 | 0 | `package.json`, `server/types.ts` | **Low** — 0 commits behind; clean fast-forward merge possible |
| `origin/codekin/reports` | 5 | 102 | 5 report files in `.codekin/reports/` | **Low** — changes are in non-overlapping report files; content conflict unlikely but rebase would require touching 102 commits |
| `origin/feat/enforce-branching-policy` | 8 | 124 | No shared merge base (unrelated history) | **High** — no common ancestor with current `main`; cannot be rebased conventionally; treat as an isolated branch |

**Overlapping file check** (`release/v0.3.0` vs `main`):
- `package.json` — changed on `release/v0.3.0` (version bump); `main` is at the prior commit — no conflict, clean merge.
- `server/types.ts` — auth variant added; no conflicting change on `main`.

---

## Recommendations

1. **Merge `release/v0.3.0` into `main` and tag** _(High impact)_ — The release branch is 2 commits ahead of `main` with no conflicts. Complete the release cycle: merge to `main`, tag `v0.3.0` on main, then delete the release branch.

2. **Delete 29 merged remote branches** _(Medium impact — hygiene)_ — Run `git push origin --delete <branch>` for all 29 merged branches listed above, or use `gh api` to batch-delete. This reduces noise in `git branch -r` and makes active branches immediately visible.

3. **Update `CHANGELOG.md`** _(Medium impact — documentation)_ — The changelog is missing entries for `v0.1.8`, `v0.2.0`, `v0.2.1`, `v0.2.2`, and `v0.3.0`. Use the draft changelog above as the basis for the `v0.3.0` entry, and reconstruct earlier versions from `git log`.

4. **Document new workflow `model` field in `docs/WORKFLOWS.md`** _(Medium impact — documentation)_ — The optional `model` frontmatter key added in v0.3.0 is not mentioned in the workflow format reference. Add a row to the frontmatter field table.

5. **Document `auth` WsClientMessage variant in `docs/stream-json-protocol.md`** _(Low-medium impact)_ — The `auth` variant added to `WsClientMessage` (`server/types.ts`, commit `d2938f2`) should be added to the client→server message table in the protocol doc.

6. **Resolve `origin/codekin/reports` branch drift** _(Low-medium impact)_ — This branch is 102 commits behind main. Either (a) merge the report files into `main` directly via a PR, or (b) rebase the branch onto main so reports can be committed cleanly going forward.

7. **Evaluate `origin/feat/enforce-branching-policy`** _(Low impact)_ — This branch has no merge base with current `main`. Review its 8 unique commits to see if any content is worth cherry-picking (branching policy docs, etc.), then delete the branch.

8. **Run `npm install` to sync `package-lock.json` version** _(Low impact — cosmetic)_ — The lock file header still reads `"version": "0.2.2"`. Running `npm install` after the version bump will update it and keep lock file metadata consistent.

9. **Add Prettier config** _(Low impact — developer experience)_ — No `.prettierrc` exists. Adding one with `"semi": false, "singleQuote": true` (or whatever the current convention is) and a `lint:format` / `format` script will prevent future formatting drift without relying on per-editor settings.

10. **Upgrade ESLint to `strictTypeChecked`** _(Low impact — code quality)_ — `tseslint.configs.recommended` catches basic TypeScript issues. Upgrading to `tseslint.configs.strictTypeChecked` (requires adding `parserOptions.projectService: true`) would surface unsafe type assertions, unhandled promise rejections, and `any` leakage that the current config misses.
