# Dependency Health Report — 2026-03-24

## Summary

| Package Manager | Total Deps | Outdated | Vulnerabilities | Risk Level |
|-----------------|-----------|----------|-----------------|------------|
| npm (root)      | 611        | 17       | 0               | Low        |
| npm (server)    | 247        | 4        | 0               | Low        |

**Single ecosystem detected:** Node.js / npm only. No Python, Go, Rust, or Ruby package managers present.

Root package (`codekin`) has 38 direct dependencies. Server subpackage (`codekin-server`) shares 4 of those as its own declared prod deps. Both `npm audit` runs returned zero vulnerabilities.

---

## Security Vulnerabilities

No vulnerabilities detected in either the root or server package audit.

```
npm audit (root):   0 critical, 0 high, 0 moderate, 0 low
npm audit (server): 0 critical, 0 high, 0 moderate, 0 low
```

---

## Outdated Dependencies

Sorted by time since latest version was published (descending). Type: P = production, D = devDependency.

| Package | Current | Latest | Age (days behind) | Type |
|---------|---------|--------|-------------------|------|
| `@eslint/js` | 9.39.4 | 10.0.1 | ~47 days (since 2026-02-06) | D |
| `globals` | 16.5.0 | 17.4.0 | ~23 days (since 2026-03-01) | D |
| `@vitejs/plugin-react` | 5.1.4 | 6.0.1 | ~11 days (since 2026-03-13) | D |
| `better-sqlite3` | 12.6.2 | 12.8.0 | ~10 days (since 2026-03-14) | P |
| `jsdom` | 28.1.0 | 29.0.1 | ~4 days (since 2026-03-20) | D |
| `eslint` | 9.39.4 | 10.1.0 | ~4 days (since 2026-03-20) | D |
| `ws` | 8.19.0 | 8.20.0 | ~3 days (since 2026-03-21) | P |
| `vite` | 7.3.1 | 8.0.2 | ~1 day (since 2026-03-23) | D |
| `typescript` | 5.9.3 | 6.0.2 | ~1 day (since 2026-03-23) | D |
| `vitest` | 4.0.18 | 4.1.1 | patch | D |
| `@vitest/coverage-v8` | 4.0.18 | 4.1.1 | patch | D |
| `typescript-eslint` | 8.56.1 | 8.57.2 | patch | D |
| `eslint-plugin-react-refresh` | 0.4.26 | 0.5.2 | minor | D |
| `marked` | 17.0.4 | 17.0.5 | patch | P |
| `tailwindcss` | 4.2.1 | 4.2.2 | patch | P |
| `@tailwindcss/vite` | 4.2.1 | 4.2.2 | patch | D |
| `@types/node` | 25.4.0 | 25.5.0 | patch | D |

**Major version jumps requiring attention:**

| Package | Current Major | Latest Major | Notes |
|---------|--------------|-------------|-------|
| `eslint` + `@eslint/js` | 9.x | 10.x | Breaking changes likely; both must update together |
| `vite` | 7.x | 8.x | Released 2026-03-23 — very fresh, wait for ecosystem |
| `@vitejs/plugin-react` | 5.x | 6.x | Must track vite major |
| `typescript` | 5.x | 6.x | Released 2026-03-23 — very fresh, wait for toolchain |
| `globals` | 16.x | 17.x | Used by ESLint config |
| `jsdom` | 28.x | 29.x | Used by vitest browser env |

---

## Abandoned / Unmaintained Packages

| Package | Current Version | Last Release | Age |
|---------|----------------|-------------|-----|
| `unidiff` | 1.0.4 | 2023-06-02 | ~2 years 10 months |

`unidiff` has had no releases since June 2023 and only 8 total versions ever published (0.0.1 through 1.0.4). It is used for diff formatting alongside `react-diff-view`. No other production dependencies showed signs of abandonment; all others received releases within the past 15 months.

---

## Duplicate / Conflicting Package Versions

npm's dependency tree contains multiple installed versions of the following packages. Most are expected due to peer-dep constraints across major versions, but some warrant attention:

| Package | Versions Installed | Likely Cause |
|---------|-------------------|-------------|
| `mime-types` | 2.1.35, 3.0.2 | Express v4 transitive dep vs Express v5 direct |
| `type-is` | 1.6.18, 2.0.1 | Express v4 transitive dep vs Express v5 direct |
| `media-typer` | 0.3.0, 1.1.0 | Same Express v4/v5 transition artifact |
| `eslint-visitor-keys` | 3.4.3, 4.2.1, 5.0.1 | ESLint plugin ecosystem fragmentation across v8/v9/v10 |
| `globals` | 14.0.0, 16.5.0 | Older ESLint plugin pulling globals 14 |
| `brace-expansion` | 1.1.12, 5.0.4 | minimatch v3 vs v10 transitive chain |
| `js-tokens` | 4.0.0, 10.0.0 | React source vs another consumer |
| `lru-cache` | 5.1.1, 11.2.6 | Common across tooling; expected |
| `semver` | 6.3.1, 7.7.4 | Common across tooling; expected |

The Express v4/v5 duplication (`mime-types`, `type-is`, `media-typer`) is an artifact of transitive deps from packages that have not yet updated to Express v5 peer deps. This is cosmetic (bundle size only) — no runtime conflict. The `eslint-visitor-keys` triple-version situation reflects a fragmented ESLint plugin ecosystem mid-v9→v10 migration.

---

## Recommendations

1. **Apply safe patch and minor updates now.** Upgrade `ws` (8.19→8.20), `better-sqlite3` (12.6→12.8), `marked` (17.0.4→17.0.5), `tailwindcss`/`@tailwindcss/vite` (4.2.1→4.2.2), `vitest`/`@vitest/coverage-v8` (4.0.18→4.1.1), `typescript-eslint` (8.56→8.57), `@types/node` (25.4→25.5), and `eslint-plugin-react-refresh` (0.4.26→0.5.2). These are low-risk and have no breaking changes. Run `npm update` and verify the test suite passes.

2. **Evaluate replacing `unidiff`.** Last released June 2023 (~3 years ago), only 8 versions total, no maintenance signals. It is used alongside `react-diff-view` for diff formatting. Consider switching to the `diff` npm package or consolidating on utilities already provided by `react-diff-view` internally.

3. **Plan the ESLint 9→10 migration as a dedicated task.** `eslint` and `@eslint/js` must upgrade together (both jump to v10, with `globals` jumping to v17). ESLint 10 drops legacy `.eslintrc` support entirely — confirm the project is already using flat config (`eslint.config.*`) before upgrading. Also verify `eslint-plugin-react-hooks` and `typescript-eslint` compatibility with ESLint 10 first.

4. **Hold on `typescript` 5→6 and `vite` 7→8 for 2–4 weeks.** Both were released on 2026-03-23 (one day ago). TypeScript 6 includes breaking strictness changes and dropped legacy compiler options. Vite 8 changes the Rollup integration layer. Allow the plugin ecosystem (`@vitejs/plugin-react` v6, type packages) to stabilize before migrating.

5. **Upgrade `@vitejs/plugin-react` 5→6 together with `vite` 7→8.** These must be updated as a pair — plugin-react v6 requires Vite 8 APIs and will not work with Vite 7.

6. **Investigate and resolve the Express v4 transitive duplication.** Run `npm why mime-types` to identify which package is pulling in the v4-era `mime-types`/`type-is`/`media-typer`. Either wait for upstream packages to declare Express v5 peer-dep support, or use the `overrides` field in `package.json` (already used for `undici`) to force the v2/v3 versions.

7. **Clean up the `globals` version duplication after the ESLint upgrade.** There are two installed copies (14.0.0 and 16.5.0). After upgrading ESLint to v10 (recommendation 3), re-run `npm ls globals` to confirm the v14 copy is fully eliminated by updated plugin peer deps.

8. **Keep the `~` pin on `typescript` in both `package.json` files.** The existing `~5.9.3` pins are correct practice — TypeScript minor bumps can alter type-checking behavior. Maintain this convention when eventually upgrading to TypeScript 6.
