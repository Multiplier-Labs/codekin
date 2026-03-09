# Repository Health: codekin

**Date**: 2026-03-09T12:29:39.025Z
**Repository**: /srv/repos/codekin
**Branch**: release/v0.3.0
**Workflow Run**: 089fa9be-3490-45f1-9eca-6817323bf3d4
**Session**: 7bb09539-06ea-42c9-b47a-9da4e1fdc929

---

Yes, just finished gathering all the data. Now compiling the final report — one moment.Now I have all the data needed to write the full report. Let me save it to the reports directory.Here is the full report:

---

## Summary

**Overall Health: Good**

Codekin is in strong shape after a burst of 100+ commits on 2026-03-08–09. Zero TODO/FIXME debt, strict TypeScript enforced everywhere, no open PRs, and all dependencies appear MIT/permissive. The main maintenance concerns are cosmetic and hygiene-related.

| Area | Status |
|---|---|
| Dead code | Low risk — ~6 exported symbols to review |
| TODO/FIXME debt | **Clean** — 0 found |
| Config issues | 2 minor (no Prettier, ESLint not on `strictTypeChecked`) |
| License concerns | None |
| Doc drift | 2 minor items (missing `model` field in WORKFLOWS.md, missing `auth` variant in protocol doc) |
| CHANGELOG | **Significantly stale** — missing v0.1.8 through v0.3.0 |
| Merged undeleted branches | **29** — all safe to delete |
| Open / stuck PRs | 0 |

---

## Dead Code

TypeScript's `noUnusedLocals: true` catches local dead code at build time. Only *exported* symbols escape that check:

| File | Export | Recommendation |
|---|---|---|
| `src/hooks/useChatSocket.ts` | `processMessage`, `trimMessages`, `rebuildFromHistory` | Likely test-only exports — verify or move to test helper |
| `src/components/workflows/StepCard.tsx` | `StepIcon`, `JsonBlock` | Unexport if not used outside this file |
| `src/lib/workflowHelpers.ts` | `slugify`, `repoNameFromRun`, `statusBadge` + ~15 others | Audit imports; remove any unreferenced functions |
| `server/webhook-github.ts` | `_setGhRunner()`, `_resetGhRunner()` | Intentional test injection — add `@internal` JSDoc |
| `src/hooks/useSessionOrchestration.ts` | `groupKey()` | Unexport if internal-only |

---

## TODO/FIXME Tracker

**Zero** actionable annotations found in any source file. The only grep matches were test fixture strings in `server/claude-process.test.ts`.

| Type | Count | Stale |
|---|---|---|
| TODO / FIXME / HACK / XXX / WORKAROUND | 0 | 0 |

---

## Config Drift

1. **`eslint.config.js`** — Using `tseslint.configs.recommended`; consider upgrading to `strictTypeChecked` for stronger guarantees (unsafe type assertions, unhandled promises, `any` leakage).
2. **No Prettier config** — Formatting is unenforced; formatting drift can accumulate across contributors.
3. **`package-lock.json` version field** — Still reads `0.2.2` after the `0.3.0` bump; run `npm install` to sync.

---

## License Compliance

**Project**: MIT. All identified dependencies (react, vite, tailwindcss, eslint, typescript, marked, dompurify, highlight.js, etc.) use MIT, Apache-2.0, or BSD licenses. No GPL/LGPL/AGPL detected. Run `npx license-checker --summary` for a full transitive audit.

---

## Documentation Freshness

**README**: No drift detected. All scripts, paths, and feature descriptions match reality.

**Stale items**:
1. `docs/WORKFLOWS.md` — The optional `model` frontmatter field added in v0.3.0 is not documented.
2. `docs/stream-json-protocol.md` — The `auth` variant of `WsClientMessage` (commit `d2938f2`) is not in the client→server message table.
3. `CHANGELOG.md` — Missing entries for v0.1.8, v0.2.0, v0.2.1, v0.2.2, and v0.3.0.

---

## Draft Changelog

```markdown
## [0.3.0] - 2026-03-09

### Features
- Docs browser: in-app markdown docs viewer with inline file picker,
  keyboard navigation, inverted header, and star/favourite persistence
- Workflow model selection: optional `model` frontmatter field; model badge in workflow list
- GitHub Webhooks section in Settings panel
- Repository Health built-in workflow type
- Custom TimePicker component replacing native browser time input; bi-weekly frequency toggle

### Fixes
- Fix workflow panel contrast in light mode
- Fix docs icon toggle (clicking again closes the picker)
- Fix sidebar timestamp vertical alignment
- Fix docs file picker not appearing on sidebar icon click
- Fix docs API: switch from path params to query params
- Fix sidebar session name bold and workflow list alignment
- Fix sidebar repo ordering (alphabetical)
- Fix workflow validate_repo failing when REPOS_ROOT is a symlink
- Fix Settings font sizes and light mode contrast
- Remove tracked dist/ files causing stale asset references
- Fix CI: restore better-sqlite3 as root devDependency
- Add missing auth variant to server WsClientMessage type

### Security
- Implement critical code review audit findings (H1–H3, M1–M6, L1–L4)
- Implement critical dependency audit findings

### Refactoring
- Reduce complexity across 7 modules per complexity audit
- Refine SessionManager split; complete delegation to extracted modules
- Improve Settings modal layout with section cards

### Documentation
- Add JSDoc and inline comments per comment audit
- Add docs/DOCS-BROWSER-SPEC.md

### Chores
- Add 50 new tests from coverage audit
- Bump version to 0.3.0
```

---

## Stale Branches

No branches meet the 30-day staleness threshold (all activity is within 2 days). The primary hygiene issue is **29 merged branches not yet deleted from the remote**.

**All 29 merged branches** (docs/comment-audit-recommendations, feat/docs-browser, feat/docs-browser-spec, feat/docs-star-favourites, feat/redesign-workflow-view, feat/repo-health-workflow, feat/settings-webhook-section, feat/workflow-list-larger-fonts, feat/workflow-model-selection, fix/code-review-security-fixes, fix/custom-time-picker-styling, fix/dist-tracking-deploy, fix/docs-api-query-params, fix/docs-header-contrast, fix/docs-icon-toggle, fix/docs-picker-inline, fix/docs-picker-positioning, fix/remove-local-scripts, fix/security-audit-hardening, fix/settings-layout-cleanup, fix/settings-light-mode-contrast, fix/sidebar-alphabetical-sort, fix/sidebar-timestamp-alignment, fix/ui-sidebar-bold-workflow-alignment, fix/workflow-contrast-and-sidebar-timestamps, fix/workflow-model-display, fix/workflow-panel-contrast, fix/workflow-time-selector-and-biweekly-toggle, refactor/complexity-audit-2026-03, release/v0.2.0) → **Recommend deletion**.

**Unmerged branches**:

| Branch | Ahead/Behind | Recommendation |
|---|---|---|
| `release/v0.3.0` | +2 / 0 | Merge to main, tag, delete |
| `codekin/reports` | +5 / 102 | PR the report files into main; address divergence |
| `feat/enforce-branching-policy` | +8 / 124 (no merge base) | Cherry-pick any useful content; delete |

---

## PR Hygiene

**0 open PRs.** Nothing stuck.

---

## Merge Conflict Forecast

| Branch | Ahead | Behind | Changed Files | Risk |
|---|---|---|---|---|
| `release/v0.3.0` | 2 | 0 | `package.json`, `server/types.ts` | **Low** — clean fast-forward |
| `codekin/reports` | 5 | 102 | 5 report files (non-overlapping) | **Low content risk, High rebase effort** |
| `feat/enforce-branching-policy` | 8 | 124 | No shared merge base | **High** — cannot rebase conventionally |

---

## Recommendations

1. **Merge `release/v0.3.0` → `main` and tag `v0.3.0`** — Clean fast-forward, no conflicts.
2. **Delete 29 merged remote branches** — `git push origin --delete <branch>` for each, or batch via `gh`.
3. **Update `CHANGELOG.md`** — Add entries for v0.1.8 through v0.3.0 using the draft above.
4. **Document `model` field in `docs/WORKFLOWS.md`** — One row in the frontmatter table.
5. **Document `auth` WsClientMessage variant in `docs/stream-json-protocol.md`**.
6. **Resolve `codekin/reports` branch drift** — Merge the 5 report files into main via a PR.
7. **Evaluate and close `feat/enforce-branching-policy`** — No merge base; cherry-pick or delete.
8. **Run `npm install`** to sync `package-lock.json` version field to `0.3.0`.
9. **Add `.prettierrc`** to enforce consistent formatting across contributors.
10. **Upgrade ESLint to `strictTypeChecked`** for stronger type-aware linting.

---

Report saved to `.codekin/reports/repo-health/2026-03-09_repo-health.md`.Committed and pushed. The report is now at `.codekin/reports/repo-health/2026-03-09_repo-health.md` on `release/v0.3.0`.