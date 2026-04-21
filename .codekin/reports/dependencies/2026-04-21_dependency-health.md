# Dependency Health Report — 2026-04-21

**Project**: codekin v0.6.3  
**Package Manager**: npm  
**Generated**: 2026-04-21

---

## Summary

| Package Manager | Total Deps | Outdated (direct) | Vulnerabilities | Risk Level |
|---|---|---|---|---|
| npm | 548 (113 prod, 436 dev, 45 optional) | 8 | 0 | Low |

No vulnerabilities were detected by `npm audit`. Eight direct dependencies are behind their latest published version, all minor or patch releases. Five extraneous packages (unlisted in `package.json`) were found in `node_modules`.

---

## Security Vulnerabilities

**None.** `npm audit` reports zero vulnerabilities across all 548 installed packages.

> Note: `dompurify` (XSS sanitizer) is on v3.3.3; v3.4.0 was released 2026-04-14. While no CVE is associated with the older version, upgrading a security-critical library promptly is best practice.

---

## Outdated Dependencies

Sorted by version gap / recency of latest release (top 20 direct deps only; no transitive outdated deps were flagged by `npm outdated`).

| Package | Current | Latest | Released | Type | Notes |
|---|---|---|---|---|---|
| `better-sqlite3` | 12.8.0 | 12.9.0 | 2026-04-12 | prod | Minor — flagged by `npm outdated` |
| `dompurify` | 3.3.3 | 3.4.0 | 2026-04-14 | dev (bundled) | Security-relevant; upgrade promptly |
| `eslint` | 10.1.0 | 10.2.1 | — | dev | Minor patch |
| `typescript-eslint` | 8.58.0 | 8.59.0 | — | dev | Patch |
| `marked-highlight` | 2.2.3 | 2.2.4 | 2026-04-07 | dev (bundled) | Patch |
| `globals` | 17.4.0 | 17.5.0 | — | dev | Patch |
| `jsdom` | 29.0.1 | 29.0.2 | — | dev (test only) | Patch |
| `@types/node` | 25.5.0 | 25.6.0 | — | dev | Patch |

All other direct dependencies (`express`, `multer`, `ws`, `react`, `react-dom`, `vite`, `tailwindcss`, `typescript`, `@tabler/icons-react`, `react-markdown`, `vitest`, etc.) are at their latest versions within their declared semver ranges.

---

## Abandoned / Unmaintained Packages

No direct dependencies meet the 2+ year inactivity threshold as of 2026-04-21.

**Previously at-risk — now resolved:**

| Package | Old Last Release | Current Version Released | Status |
|---|---|---|---|
| `refractor` | 4.8.1 (2023-02-28) | 5.0.0 (2025-03-11) | Active — v5 released Mar 2025 |

`refractor` had a 2-year gap between v4.8.1 and v5.0.0, but the project is now current and the installed version (5.0.0) is the latest.

---

## Extraneous Packages

Five packages are installed in `node_modules` but not listed in `package.json` or `package-lock.json` as direct dependencies. These were flagged by `npm list`:

| Package | Version | Likely Source |
|---|---|---|
| `@emnapi/core` | 1.9.1 | Optional native addon (better-sqlite3 / napi-rs) |
| `@emnapi/runtime` | 1.9.1 | Optional native addon |
| `@emnapi/wasi-threads` | 1.2.0 | Optional native addon |
| `@napi-rs/wasm-runtime` | 1.1.2 | Optional native addon (napi-rs WASM fallback) |
| `@tybys/wasm-util` | 0.10.1 | Optional native addon |

These are WASM/NAPI runtime helpers, likely installed as optional platform-specific dependencies of `better-sqlite3`. They should not appear in the frontend bundle (server-side only), and they pose no known security risk. Running `npm install` on a clean checkout may or may not reproduce them depending on the platform.

---

## Dev Dependencies in Production Bundle

The project uses a Vite + React build pipeline. Frontend packages (`react`, `dompurify`, `marked`, `highlight.js`, `@tabler/icons-react`, etc.) are listed under `devDependencies` but are intentionally bundled into the client-side artifact — this is the correct pattern for a Vite SPA.

The true production runtime dependencies (Node.js server) are the four listed under `dependencies`: `better-sqlite3`, `express`, `multer`, `ws`. These are not bundled by Vite and are loaded at runtime only.

`jsdom` is a test-only devDependency (used by vitest) and is not imported in any production source. No misplaced dev-only packages were found in production code paths.

---

## Recommendations

1. **Update `better-sqlite3` to 12.9.0** — the only package flagged by `npm audit --json` as behind. Run `npm install better-sqlite3@latest` and re-run the test suite; this is a patch release with no breaking changes expected.

2. **Update `dompurify` to 3.4.0** — as the XSS sanitizer used on rendered HTML, it is the highest-priority security-adjacent library in the bundle. Update promptly even without a known CVE: `npm install dompurify@latest`.

3. **Batch-update minor/patch devDependencies** — `eslint`, `typescript-eslint`, `marked-highlight`, `globals`, `jsdom`, and `@types/node` all have patch or minor updates available. Run `npm update` to pull them all within their semver ranges, then run `npm run lint` and `npm test` to verify no regressions.

4. **Investigate extraneous packages** — run `npm install` on a clean checkout and confirm whether `@emnapi/*`, `@napi-rs/wasm-runtime`, and `@tybys/wasm-util` appear. If they do not, consider adding them to `.npmrc` as `optional=false` or filing an issue against `better-sqlite3` if they are unexpected. They are harmless now but make `npm list` noisy.

5. **Pin `dompurify` to `dependencies` (not `devDependencies`)** — it is used in the frontend runtime to sanitize rendered Markdown and is currently listed as a devDependency. While Vite bundles it correctly either way, listing it under `devDependencies` is semantically misleading and could cause confusion if the build pipeline changes.

6. **Monitor `refractor`** — the package powers syntax highlighting via `react-diff-view`. It had a multi-year gap before v5 and has no releases since March 2025. Watch for further inactivity; if it stalls again, consider migrating to `shiki` or `highlight.js` (already a direct dependency) for syntax highlighting.

7. **Add a monthly `npm outdated` check to CI** — none of the outdated dependencies were caught by the existing pipeline. A non-blocking `npm outdated` step in CI (or a Dependabot / Renovate configuration) would surface minor/patch drift before it accumulates.

8. **Consider adopting Renovate or Dependabot** — with 548 transitive packages and a fast-moving frontend stack (React 19, Vite 8, TailwindCSS 4, TypeScript 6), automated PRs for minor/patch updates reduce the maintenance burden and keep the dependency graph current without manual audits.
