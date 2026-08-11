# Dependency Health Report: codekin

**Date**: 2026-08-11T04:19:55.226Z
**Repository**: /srv/repos/Multiplier-Labs/codekin
**Branch**: main
**Workflow Run**: bf37c9d6-864f-4869-80e9-62dddd56f38a
**Session**: d920aee0-d735-4d6e-9b38-1203bc747aff

---

Now I have all the data needed to produce the report.

---

# Dependency Health Assessment — 2026-08-11

**Project**: codekin v0.8.0  
**Package manager(s)**: npm (primary, `package-lock.json` v3) + pnpm (`pnpm-lock.yaml` v9) — dual lockfiles present  
**Assessment date**: 2026-08-11

---

## Summary

| Package Manager | Total Deps (tree) | Direct Deps (prod/dev) | Outdated | Vulnerabilities | Risk Level |
|---|---|---|---|---|---|
| npm / pnpm (dual) | 558 | 6 prod / 33 dev | 26 | **0** | **Low** |

`npm audit` returned zero vulnerabilities across all 558 installed packages. The primary health concerns are pending major-version upgrades, a handful of legacy packages pulled in by native-build tooling, and the presence of two competing lockfiles.

---

## Security Vulnerabilities

No CVEs were detected by `npm audit` at the time of this assessment.

| Package | Severity | CVE | Description | Fixed In |
|---|---|---|---|---|
| — | — | — | No vulnerabilities reported | — |

**Notable near-miss / watch list:**

- `minimist@1.2.8` (transitive via `better-sqlite3 → prebuild-install → rc`): historically affected by prototype-pollution CVEs; 1.2.8 is the patched version, no current open CVE.
- `dompurify`: `npm outdated` reports `current=3.4.0` while `package-lock.json` records `3.4.13` — a lockfile/node_modules divergence (likely caused by the dual pnpm+npm lockfiles). The newer version should be live after a clean `npm install`.

---

## Outdated Dependencies

Sorted by severity of version gap; top 20 shown. "Wanted" = highest version satisfying the current semver range; "Latest" = absolute newest on the registry.

| Package | Current | Wanted | Latest | Semver Lag | Type |
|---|---|---|---|---|---|
| `typescript` | 6.0.2 | 6.0.3 | **7.0.2** | MAJOR (next gen) | dev |
| `better-sqlite3` | 12.9.0 | 12.11.1 | **13.0.3** | MAJOR | prod |
| `@types/better-sqlite3` | 7.6.13 | 7.6.13 | **9.6.0** | +2 MAJOR | dev |
| `@types/node` | 25.5.0 | 25.9.5 | **26.2.0** | MAJOR | dev |
| `vite` | 8.0.5 | 8.2.1 | 8.2.1 | minor (8.2.1) | dev |
| `tailwindcss` | 4.2.2 | 4.3.3 | 4.3.3 | minor (4.3.3) | dev |
| `@tailwindcss/vite` | 4.2.2 | 4.3.3 | 4.3.3 | minor (4.3.3) | dev |
| `typescript-eslint` | 8.58.0 | 8.67.0 | 8.67.0 | minor (8.67.0) | dev |
| `eslint` | 10.1.0 | 10.8.1 | 10.8.1 | minor (10.8.1) | dev |
| `@tabler/icons-react` | 3.41.1 | 3.46.0 | 3.46.0 | minor (3.46.0) | dev |
| `marked` | 18.0.2 | 18.0.9 | 18.0.9 | patch (18.0.9) | dev |
| `react` | 19.2.4 | 19.2.8 | 19.2.8 | patch (19.2.8) | dev |
| `react-dom` | 19.2.4 | 19.2.8 | 19.2.8 | patch (19.2.8) | dev |
| `vitest` | 4.1.2 | 4.1.10 | 4.1.10 | patch (4.1.10) | dev |
| `@vitest/coverage-v8` | 4.1.2 | 4.1.10 | 4.1.10 | patch (4.1.10) | dev |
| `multer` | 2.1.1 | 2.2.0 | 2.2.0 | patch (2.2.0) | prod |
| `ws` | 8.21.0 | 8.21.3 | 8.21.3 | patch (8.21.3) | prod |
| `jsdom` | 29.0.1 | 29.1.1 | 29.1.1 | patch (29.1.1) | dev |
| `globals` | 17.4.0 | 17.9.0 | 17.9.0 | patch (17.9.0) | dev |
| `dompurify` | 3.4.0\* | 3.4.13 | 3.4.13 | patch (3.4.13) | dev |

\* dompurify version reflects what npm reads from node_modules; lockfile records 3.4.13 — see Dual Lockfile note under Recommendations.

Additional outdated packages (patch-level, all dev): `@vitejs/plugin-react` 6.0.1→6.0.5, `@types/react` 19.2.14→19.2.18, `@types/react-dom` 19.2.3→19.2.4, `@types/multer` 2.1.0→2.2.0, `eslint-plugin-react-hooks` 7.0.1→7.1.1, `eslint-plugin-react-refresh` 0.5.2→0.5.4.

---

## Abandoned / Unmaintained Packages

All entries below are **transitive** dependencies only — none appear in `package.json` directly. Two dependency chains account for all of them:

**Chain A** — `better-sqlite3@12.9.0 → prebuild-install@7.1.3 → rc@1.2.8 → …`

| Package | Version | Last Release (approx.) | Notes |
|---|---|---|---|
| `tunnel-agent` | 0.6.0 | ~2017 | Part of the abandoned `request` ecosystem; no upstream activity in ~9 years |
| `deep-extend` | 0.6.0 | ~2018 | Simple deep-merge utility, unmaintained; only kept alive by `rc` |
| `rc` | 1.2.8 | ~2021 | Config reader, largely inactive; used by `prebuild-install` to load `.npmrc` |
| `minimist` | 1.2.8 | ~2022 (security patches only) | Argument parser; historically had prototype-pollution CVEs; 1.2.8 is patched but no new feature work |

**Chain B** — `multer@2.1.1 → concat-stream → …`

| Package | Version | Last Release (approx.) | Notes |
|---|---|---|---|
| `typedarray` | 0.0.6 | ~2014 | TypedArray polyfill; superseded by native runtime support for a decade |
| `concat-stream` | (transitive) | ~2019 | Stream concatenation utility, minimal maintenance |

> **Root cause**: upgrading `better-sqlite3` to v13.x will likely modernize its native build toolchain (or switch from `prebuild-install` to `node-pre-gyp`/`@mapbox/node-pre-gyp`), dropping Chain A entirely. Updating `multer` to 2.2.0 should similarly clear Chain B.

---

## Other Findings

### Dual Lockfiles (High-priority cleanliness issue)

Both `package-lock.json` (npm v3) and `pnpm-lock.yaml` (pnpm v9) exist at the repo root. This creates ambiguity about which tool is canonical and causes inconsistencies visible in this report (e.g., `dompurify` version disagreement between the two). CI and contributors may use different managers, producing divergent trees.

### Duplicate `nanoid` Override in `package.json`

```json
"overrides": {
  "nanoid": "^3.3.18",
  ...
  "nanoid": "^3.3.17"   // ← shadowed duplicate key
}
```

JSON does not allow duplicate keys; the second entry (`^3.3.17`) silently shadows the first (`^3.3.18`). The installed version is `3.3.18` (pnpm may resolve differently). The first entry should be removed, keeping the higher version pin.

### Version Conflicts in the Dependency Tree

24 packages appear in nested `node_modules` (true version splits), most benign. The notable ones:

| Package | Versions present | Owner |
|---|---|---|
| `semver` | 6.3.1 + 7.7.4 | `@typescript-eslint`, `make-dir`, `node-abi` each pin an older sub-version |
| `lru-cache` | 5.1.1 + 11.2.7 | `@asamuzakjp/*` and `jsdom` use 11.x; older tools pin 5.x |
| `mime-types` / `mime-db` | 2.1.x + 3.0.x | `multer` bundles its own old copy |
| `type-is` | 1.6.18 + 2.1.0 | Same multer bundling |

These are all resolved by npm's hoisting and pose no runtime risk, but running `npm dedupe` would flatten several of them.

### `lodash` in Production Tree

`react-diff-view` pulls in `lodash@4.18.1` — a large utility library — into the client bundle. Lodash is not dead, but this is the only consumer and represents avoidable bundle weight. Consider replacing `react-diff-view` or patching only the specific lodash methods used.

---

## Recommendations

1. **Resolve the dual lockfile conflict.** Decide on npm or pnpm as the single canonical package manager, delete the other lockfile, and enforce this in `.npmrc` / CI. Until resolved, `npm` commands read a stale state and reports like this one carry uncertainty.

2. **Update `better-sqlite3` to 13.x (prod, major).** This is the single highest-leverage change: it likely eliminates the entire `prebuild-install → rc → tunnel-agent / deep-extend / minimist` legacy chain from the production dependency tree. Review the v13 changelog for breaking changes before upgrading.

3. **Update `multer` to 2.2.0 (prod, patch).** Already installed at 2.2.0 in the tree per the lockfile; the `package.json` range `^2.0.0` and npm both agree. Update the lockfile with `npm install multer@2.2.0` and align `package.json` to `^2.2.0`. This also resolves the bundled old `mime-types`/`type-is` sub-versions.

4. **Update `ws` to 8.21.3 (prod, patch).** Security-adjacent WebSocket patch; straightforward drop-in.

5. **Fix the duplicate `nanoid` override** — remove the lower `^3.3.17` entry from `package.json` overrides to leave only `"nanoid": "^3.3.18"`.

6. **Flush the patch backlog in one pass.** Run `npm update` (or `pnpm update`) to install all in-range updates: `vite`, `tailwindcss`, `@tailwindcss/vite`, `eslint`, `typescript-eslint`, `react`, `react-dom`, `vitest`, `marked`, `jsdom`, `globals`, `dompurify`, and the remaining `@types/*` packages. These are all within declared semver ranges and should be zero-risk.

7. **Evaluate TypeScript 7 migration.** The current `^6.0.2` range does not reach 7.x. TS 7 introduces Go-based compilation (10× speed improvement) and potential strict-mode changes. Plan a dedicated upgrade branch; pin `typescript` to `^7.0.2` and update `@types/better-sqlite3` to `^9.6.0` at the same time.

8. **Update `@types/node` to ^26.** The current pin is `^25.0.0`; `@types/node@26.x` tracks Node.js 26 LTS. Update after confirming Node 26 is the runtime target.

9. **Run `npm dedupe`** after the above updates to flatten redundant nested versions of `semver`, `lru-cache`, and `eslint-visitor-keys` and reduce tree size.

10. **Audit `react-diff-view` bundle impact.** This package brings `lodash` into the client bundle. Evaluate whether a lighter diff-rendering alternative (`diff2html`, `diff` + custom renderer) would reduce bundle weight meaningfully, especially given Codekin's terminal-UI character.