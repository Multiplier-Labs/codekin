# Dependency Health Report: codekin

**Date**: 2026-03-17T05:19:35.110Z
**Repository**: /srv/repos/codekin
**Branch**: chore/repo-health-2026-03-17
**Workflow Run**: 2a595b1f-6c40-4e8d-9f71-38406d3382e3
**Session**: 2e4d39d6-89b4-4f7b-aa03-b721fde2c03e

---

Now I have all the data I need to write the report.

## Dependency Health Assessment — 2026-03-17

**Package Manager**: npm  
**Project**: codekin v0.4.1  
**Total installed packages**: 628 (297 prod · 256 dev · 93 optional · 17 peer)

---

## Summary

| Package Manager | Total Deps | Outdated | Vulnerabilities | Risk Level |
|---|---|---|---|---|
| npm | 628 | 13 | 0 | 🟢 Low |

---

## Security Vulnerabilities

No vulnerabilities detected. `npm audit` reports 0 issues across all severity levels (info / low / moderate / high / critical).

---

## Outdated Dependencies

Sorted by version-gap significance (major bumps first, then minor/patch). Top 20 shown.

| Package | Current | Latest | Update Type | Type |
|---|---|---|---|---|
| `vite` | 7.3.1 | 8.0.0 | **Major** | dev |
| `eslint` | 9.39.4 | 10.0.3 | **Major** | dev |
| `@eslint/js` | 9.39.4 | 10.0.1 | **Major** | dev |
| `globals` | 16.5.0 | 17.4.0 | **Major** | dev |
| `@vitejs/plugin-react` | 5.1.4 | 6.0.1 | **Major** | dev |
| `jsdom` | 28.1.0 | 29.0.0 | **Major** | dev |
| `eslint-plugin-react-refresh` | 0.4.26 | 0.5.2 | Minor | dev |
| `vitest` | 4.0.18 | 4.1.0 | Minor | dev |
| `@vitest/coverage-v8` | 4.0.18 | 4.1.0 | Minor | dev |
| `better-sqlite3` | 12.6.2 | 12.8.0 | Minor | prod |
| `@types/node` | 25.4.0 | 25.5.0 | Minor | dev |
| `typescript-eslint` | 8.56.1 | 8.57.1 | Patch | dev |
| `dompurify` | 3.3.2 | 3.3.3 | Patch | prod |

**Note**: All 13 outdated packages are within their semver range (`^`) except for the major-version packages — those require intentional upgrades.

---

## Abandoned / Unmaintained Packages

No packages appear abandoned based on available data. Notable observations:

- **`unidiff` (v1.0.4)** — small, niche diff utility with infrequent releases. Functional but lightly maintained; worth monitoring.
- **`refractor` (^5.0.0)** — PrismJS-based syntax highlighter in "maintenance mode." The upstream PrismJS project has been superseded by Shiki/highlight.js for active development. `highlight.js` is already a direct dependency in this project, creating potential redundancy via `react-diff-view` → `refractor`.
- **`react-diff-view` (^3.3.2)** — low release frequency; last major activity was in 2023–2024. If diff rendering needs expand, consider alternatives.

---

## Recommendations

1. **Update `vite` 7 → 8** *(high priority)*  
   Vite 8 is a major release with performance improvements and updated defaults. As the core build tool, this upgrade should be tested thoroughly (check `vite.config.ts` for any deprecated options). Update `@vitejs/plugin-react` to v6 at the same time — they are typically released in lockstep.

2. **Update `eslint` 9 → 10 and `@eslint/js` 9 → 10** *(medium priority)*  
   ESLint 10 drops several legacy compatibility shims and requires flat-config only. Since the project already uses flat config (`eslint.config.js`-style), migration effort should be low. Update `globals` to v17 and `typescript-eslint` simultaneously, as these are tightly coupled.

3. **Update `vitest` and `@vitest/coverage-v8` to 4.1.0** *(low effort, do soon)*  
   Minor release — update the lockfile with `npm update vitest @vitest/coverage-v8`. No breaking changes expected.

4. **Update `jsdom` 28 → 29** *(medium priority)*  
   Major version used only in test environments (via vitest). Check the jsdom changelog for any WHATWG spec changes that might affect DOM-dependent tests before upgrading.

5. **Update `better-sqlite3` 12.6.2 → 12.8.0** *(low effort)*  
   Minor update to the only production native addon. Test against the actual SQLite operations in `server/` after updating.

6. **Apply the `dompurify` patch (3.3.2 → 3.3.3)** *(do immediately)*  
   DOMPurify is a security-critical library used to sanitize HTML. Even patch releases may contain security fixes. This is the safest and most urgent update.

7. **Audit `refractor` + `react-diff-view` for redundancy**  
   The project already uses `highlight.js` directly. `react-diff-view` pulls in `refractor` (PrismJS-based). Evaluate whether `react-diff-view` can be configured to use `highlight.js` instead, or whether a lighter diff-rendering approach would reduce the dependency surface.

8. **Pin `undici` override more precisely**  
   The `overrides.undici: "^7.24.0"` in `package.json` suggests a past vulnerability mitigation. Verify this override is still needed against the current transitive dependency tree (`npm ls undici`) and remove it if `undici` has been updated in the upstream chain.

9. **Add `npm audit` to CI pipeline** *(if not already present)*  
   Although there are currently zero vulnerabilities, automating `npm audit --audit-level=high` in CI ensures future vulnerabilities are caught before merge.

10. **Monitor `unidiff` and `react-diff-view` for abandonment**  
    Both packages have low release frequency and small maintainer bases. If either goes unmaintained, plan replacements: `diff` (npm) for diffing, and a Shiki- or PrismJS-v2-based component for diff views.Committed and pushed `.codekin/reports/code-review/2026-03-17_code-review-daily.md` to `chore/repo-health-2026-03-17`.