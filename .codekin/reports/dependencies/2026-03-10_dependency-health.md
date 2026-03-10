# Dependency Health Report: codekin

**Date**: 2026-03-10T05:17:43.083Z
**Repository**: /srv/repos/codekin
**Branch**: chore/repo-health-audit-fixes
**Workflow Run**: aab158e9-c73a-4bc6-939c-40ceb03f5480
**Session**: c48cb426-68b3-4477-a65e-4fa80f86bc80

---

Now I have all the data needed to produce the report.

## Summary

| Package Manager | Total Deps | Outdated (direct) | Vulnerabilities | Risk Level |
|---|---|---|---|---|
| npm (root) | 529 | 6 | 0 | Low |
| npm (server/) | 248 | 3 | 0 | Low |

Both `npm audit` runs return **zero vulnerabilities** across all severity levels.

---

## Security Vulnerabilities

No known CVEs detected by `npm audit` as of 2026-03-10.

| Package | Severity | CVE | Description | Fixed In |
|---|---|---|---|---|
| — | — | — | No vulnerabilities found | — |

---

## Outdated Dependencies

Sorted by version age / major-version gap, top 20.

| Package | Current | Latest | Gap | Type | Workspace |
|---|---|---|---|---|---|
| `express` | 4.22.1 | 5.2.1 | **Major** (4→5) | prod | server/ |
| `multer` | 1.4.5-lts.2 | 2.1.1 | **Major** (1→2) | prod | server/ |
| `eslint` | 9.39.4 | 10.0.3 | **Major** (9→10) | dev | root |
| `@eslint/js` | 9.39.4 | 10.0.1 | **Major** (9→10) | dev | root |
| `globals` | 16.5.0 | 17.4.0 | **Major** (16→17) | dev | root |
| `@types/node` | 24.12.0 | 25.4.0 | **Major** (24→25) | dev | root |
| `eslint-plugin-react-refresh` | 0.4.26 | 0.5.2 | Minor | dev | root |
| `typescript-eslint` | 8.56.1 | 8.57.0 | Patch | dev | root |
| `@types/dompurify` | 3.0.5 | 3.2.0 | Minor | dep* | root |
| `@ai-sdk/anthropic` | 3.0.59 | 3.0.58† | Patch | prod | server/ |

> † `@ai-sdk/anthropic` 3.0.59 is installed; npm reports latest as 3.0.58, suggesting the installed version may be ahead of the stable channel (pre-release or dist-tag mismatch). Monitor.
>
> \* `@types/dompurify` is listed under `dependencies` rather than `devDependencies`; since it is a type-declaration-only package it should be moved to `devDependencies`.

---

## Abandoned / Unmaintained Packages

These are **transitive** dependencies pulled in by older direct deps (primarily `multer@1.x` and legacy `express@4` sub-deps). None are direct dependencies declared in either `package.json`.

| Package | Installed | Latest | Last npm Publish | Pulled In By |
|---|---|---|---|---|
| `append-field` | 1.0.0 | 2.0.0 | 2022-06-13 (~3.75 yrs) | multer 1.x |
| `array-flatten` | 1.1.1 | 3.0.0 | 2023-07-12 (~2.7 yrs) | express 4.x |
| `concat-stream` | 1.6.2 | 2.0.0 | 2023-07-12 (~2.7 yrs) | multer 1.x |
| `isarray` | 1.0.0 | 2.0.5 | 2023-07-12 (~2.7 yrs) | multer 1.x (readable-stream) |
| `deep-extend` | 0.6.0 | 0.6.0 | 2023-07-10 (~2.7 yrs) | node-gyp (better-sqlite3 build) |
| `chownr` | 1.1.4 | 3.0.0 | 2024-04-06 (~1.9 yrs) | tar (better-sqlite3 build) |

The cluster of `multer 1.x` transitive deps (`append-field`, `concat-stream`, `isarray`) would be resolved by upgrading `multer` to v2.

---

## Recommendations

1. **Upgrade `express` 4 → 5 in `server/`.**  
   Express 5.2.1 is now stable. It improves async error handling, removes deprecated APIs, and keeps you on a supported maintenance track. Express 4.x is in maintenance-only mode. Review the [Express 5 migration guide](https://expressjs.com/en/guide/migrating-5.html) for breaking changes (mainly router path syntax and `res.redirect` status codes).

2. **Upgrade `multer` 1.x → 2.x in `server/`.**  
   `multer` 2.1.1 drops the legacy `busboy` fork, removes several unmaintained transitive dependencies (`append-field`, `concat-stream`, `isarray`), and aligns with modern Node.js streams. This single upgrade clears the entire "abandoned transitive deps" cluster listed above.

3. **Align the `eslint` + `@eslint/js` + `globals` major versions in root.**  
   `eslint` 10, `@eslint/js` 10, and `globals` 17 were released together as a coordinated major. Upgrade all three simultaneously to avoid peer-dependency conflicts; review the [ESLint 10 migration guide](https://eslint.org/docs/latest/use/migrate-to-10.0.0) (main change: drops Node.js < 18.18).

4. **Upgrade `@types/node` 24 → 25 in root devDependencies.**  
   This is a low-risk type-only bump. It ensures TypeScript picks up the latest Node.js 22 LTS and Node 24 API surface. Pair with any `tsconfig.json` `lib`/`target` adjustments if needed.

5. **Move `@types/dompurify` from `dependencies` to `devDependencies`.**  
   It is a TypeScript declaration package with no runtime value. Having it in `dependencies` causes it to appear as a peer dependency for any downstream consumers of the package and adds unnecessary weight to production installs.

6. **Watch `@ai-sdk/anthropic` version pinning in `server/`.**  
   The `package.json` specifies `^3.0.59` but npm's latest dist-tag is `3.0.58`, suggesting 3.0.59 may have been unpublished or is on a non-`latest` dist-tag. Pin to a confirmed stable release and verify the version resolves correctly in CI.

7. **Monitor `react-syntax-highlighter` for potential replacement.**  
   The package is used alongside `highlight.js` directly — both serve overlapping syntax-highlighting roles. Consolidating on one (either the standalone `highlight.js` already in prod deps, or `react-syntax-highlighter` which bundles its own version) would reduce bundle size and eliminate the risk of version skew between the two highlighting engines.

8. **Schedule a routine quarterly dependency refresh.**  
   All direct dependencies are currently at or very near their latest versions. Setting a recurring `npm outdated` check (e.g., via a monthly Dependabot / Renovate PR) will prevent the drift seen with `express` 4→5 from accumulating again.