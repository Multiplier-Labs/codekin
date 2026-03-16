# Dependency Health Report: codekin

**Date**: 2026-03-31T04:17:37.855Z
**Repository**: /srv/repos/codekin
**Branch**: chore/repo-health-report-2026-03-30
**Workflow Run**: 38108385-181e-4fb2-a30c-ba099f856ef5
**Session**: 50d8117f-b4f9-4580-b218-29352de970eb

---

## Summary

| Package Manager | Total Deps | Outdated | Vulnerabilities | Risk Level |
|---|---|---|---|---|
| npm (v10) | 611 (297 prod / 239 dev / 76 optional) | 19 | 0 | **Low** |

---

## Security Vulnerabilities

No vulnerabilities detected. `npm audit` returned zero findings across all severity levels (critical, high, moderate, low, info).

---

## Outdated Dependencies

> Sorted by update magnitude (major → minor → patch), then by package type (prod first).

| Package | Current | Latest | Gap | Type |
|---|---|---|---|---|
| `typescript` | 5.9.3 | 6.0.2 | **Major** | dev |
| `vite` | 7.3.1 | 8.0.3 | **Major** | dev |
| `@vitejs/plugin-react` | 5.1.4 | 6.0.1 | **Major** | dev |
| `eslint` | 9.39.4 | 10.1.0 | **Major** | dev |
| `@eslint/js` | 9.39.4 | 10.0.1 | **Major** | dev |
| `globals` | 16.5.0 | 17.4.0 | **Major** | dev |
| `jsdom` | 28.1.0 | 29.0.1 | **Major** | dev |
| `@tabler/icons-react` | 3.40.0 | 3.41.1 | Minor | prod |
| `react-diff-view` | 3.3.2 | 3.3.3 | Patch | prod |
| `better-sqlite3` | 12.6.2 | 12.8.0 | Patch | prod |
| `marked` | 17.0.4 | 17.0.5 | Patch | prod |
| `ws` | 8.19.0 | 8.20.0 | Patch | prod |
| `tailwindcss` | 4.2.1 | 4.2.2 | Patch | prod |
| `@tailwindcss/vite` | 4.2.1 | 4.2.2 | Patch | prod |
| `vitest` | 4.0.18 | 4.1.2 | Minor | dev |
| `@vitest/coverage-v8` | 4.0.18 | 4.1.2 | Minor | dev |
| `typescript-eslint` | 8.56.1 | 8.58.0 | Patch | dev |
| `eslint-plugin-react-refresh` | 0.4.26 | 0.5.2 | Minor | dev |
| `@types/node` | 25.4.0 | 25.5.0 | Patch | dev |

---

## Abandoned / Unmaintained Packages

| Package | Installed | Latest | Last Release | Age |
|---|---|---|---|---|
| `unidiff` | 1.0.4 | 1.0.4 | 2023-06-02 | ~2 years 10 months |

**Notes:**
- `unidiff` (1.0.4) has had no release since June 2023 and shows no active development. It is a direct prod dependency used alongside `react-diff-view` for parsing unified diff output.
- `refractor` (5.0.0) had a gap of ~2 years between 4.8.1 (Feb 2023) and 5.0.0 (Mar 2025) but is now current with an active release — **not** considered abandoned.
- All other direct dependencies have had releases within the past 12 months.

---

## Recommendations

1. **Update patch and minor prod dependencies immediately** — `ws`, `better-sqlite3`, `marked`, `react-diff-view`, `tailwindcss`, `@tailwindcss/vite`, and `@tabler/icons-react` all have non-breaking updates. Run `npm update` to apply them. These carry low risk and `ws` in particular (WebSocket server) benefits from staying current.

2. **Plan a TypeScript 6 migration** — TypeScript 6.0.2 is a major release with breaking changes (stricter checks, removed legacy flags). This is a significant upgrade that should be scheduled and tested against the full build (`tsc -b && vite build`) and test suite. Update `typescript-eslint` alongside it, as the two are tightly coupled.

3. **Upgrade Vite 7 → 8 with `@vitejs/plugin-react` 5 → 6** — These two are released in lockstep and should be upgraded together. Vite 8 includes breaking changes to the plugin API. Test with `npm run build` and `npm run dev` after upgrading.

4. **Upgrade ESLint 9 → 10 with `@eslint/js` and `globals`** — ESLint 10 drops some deprecated APIs. `globals` 17.x is a major bump that may affect flat-config setups. Upgrade these three together and run `npm run lint` to catch any config breakage.

5. **Replace or isolate `unidiff`** — This package has been unmaintained for nearly 3 years. Evaluate whether its functionality can be absorbed by `react-diff-view`'s own parsing utilities (which already handle unified diffs) or replaced with a maintained alternative such as `diff` (jsdiff). Open a tracking issue to avoid silent breakage if future Node.js versions change behavior.

6. **Upgrade `jsdom` 28 → 29** — This is a test-only (dev) dependency used by Vitest. jsdom 29 drops support for some deprecated APIs. Run `npm test` after upgrading to catch any test environment regressions.

7. **Update `vitest` and `@vitest/coverage-v8` together** — Move from 4.0.18 → 4.1.2. These are minor releases with bug fixes to the test runner and V8 coverage provider; low risk, high reward for test reliability.

8. **Audit prod vs. dev dependency placement** — `highlight.js`, `marked`, and `marked-highlight` are listed as `dependencies` (prod) but may only be used at runtime in the frontend bundle (which is pre-built). Verify they are not duplicated in the final server bundle. If they are purely frontend, moving them to `devDependencies` would reduce the installed footprint for server-only deployments.

9. **Establish a quarterly dependency update cadence** — Most of the outdated items are major-version bumps that accumulated without a scheduled update process. A quarterly `npm outdated` check with a dedicated PR for minor/patch updates (and a separate PR for major upgrades) would keep the dependency graph manageable.

10. **Pin `typescript` range more loosely** — The current `package.json` uses `~5.9.3` (patch-level pin) rather than `^5.9.3`. While cautious, this means major and minor TypeScript improvements are blocked by default. Consider relaxing to `^5.9.3` (or upgrading to `^6.0.2`) once the TypeScript 6 migration is validated.