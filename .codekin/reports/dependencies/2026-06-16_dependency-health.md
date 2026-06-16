# Dependency Health Report: codekin

**Date**: 2026-06-16T04:17:48.316Z
**Repository**: /srv/repos/Multiplier-Labs/codekin
**Branch**: main
**Workflow Run**: 80885de9-0f78-4ebb-a431-db9559f765fd
**Session**: c11e80e0-512e-4a3a-96e2-041a3938b0f8

---

## Dependency Health Assessment — codekin
**Date:** 2026-06-16 | **Branch:** main

---

## Summary

| Package Manager | Total Deps | Outdated | Vulnerabilities | Risk Level |
|---|---|---|---|---|
| pnpm (npm registry) | 544 | 35 packages behind | 14 advisories (2 high, 8 moderate, 4 low) | **High** |

---

## Security Vulnerabilities

| Package | Severity | CVE / Advisory | Description | Fixed In |
|---|---|---|---|---|
| `ws` | **High** | CVE-2026-48779 / GHSA-96hv-2xvq-fx4p | Memory exhaustion DoS: attacker sends high volume of tiny WebSocket fragments forcing OOM process termination | `>=8.21.0` |
| `vite` | **High** | CVE-2026-53571 / GHSA-fx2h-pf6j-xcff | `server.fs.deny` bypass via Windows NTFS alternate data streams and 8.3 short names — exposes `.env` and cert files | `>=8.0.16` |
| `dompurify` | Moderate | GHSA-76mc-f452-cxcm | Hook mutation of `data.allowedTags`/`data.allowedAttributes` permanently pollutes `DEFAULT_ALLOWED_TAGS`, bypassing sanitization for all subsequent calls (CVSS 6.1) | `>=3.4.7` |
| `dompurify` | Moderate | CVE-2026-49978 / GHSA (1120813) | `IN_PLACE` sanitization bypass via attached shadow root inside `<template>` | `>=3.4.7` |
| `dompurify` | Moderate | CVE-2026-49458 | Cross-realm `IN_PLACE` sanitization leaves executable markup intact via foreign-realm traversal | `>=3.4.6` |
| `dompurify` | Moderate | CVE-2026-49459 | `IN_PLACE` mode preserves attributes of clobbered root element, allowing XSS | `>=3.4.6` |
| `qs` | Moderate | CVE-2026-8723 / GHSA-q8mj-m7cp-5q26 | `qs.stringify` throws TypeError (DoS) on `null`/`undefined` in comma-format arrays when `encodeValuesOnly=true`; in production Express apps this causes 500 errors (CVSS 5.3) | `>=6.15.2` |
| `brace-expansion` | Moderate | CVE-2026-45149 / GHSA-jxxr-4gwj-5jf2 | Large numeric range (e.g. `{1..10000000}`) allocates ~505 MB before `max` limit is applied, defeating documented DoS protection (CVSS 6.5) | `>=5.0.6` |
| `ws` | Moderate | CVE-2026-45736 / GHSA-58qx-3vcg-4xpx | Uninitialized memory disclosure when a `TypedArray` is passed as the `close()` reason argument (CVSS 4.4) | `>=8.20.1` |
| `vite` | Moderate | CVE-2026-53632 / GHSA-v6wh-96g9-6wx3 | `launch-editor` processes Windows UNC paths, triggering NTLM authentication to attacker-controlled SMB server (NTLMv2 hash leak) — Windows-only | `>=8.0.16` |
| `dompurify` | Low | GHSA-x4vx-rjvf-j5p4 | `IN_PLACE` mode trusts attacker-controlled `nodeName` on live non-form nodes, allowing script retention and XSS via attacker-supplied DOM objects | No fix yet |
| `dompurify` | Low | GHSA (1120805) | Trusted Types policy survives `clearConfig()` and can poison later `RETURN_TRUSTED_TYPE_FOR_SAFE_VALUES` calls | `>=3.4.9` |
| `dompurify` | Low | GHSA (1120812) | `SAFE_FOR_TEMPLATES` bypass — template expressions survive sanitization when using certain tag combinations | `>=3.4.8` |
| `@babel/core` | Low | CVE-2026-49356 / GHSA-4x5r-pxfx-6jf8 | Arbitrary file read via malicious `sourceMappingURL` comment when compiling attacker-controlled code (CVSS 3.2) — dev dep, build-time only | `>=7.29.6` |

> **Note:** `brace-expansion` vulnerability is in `eslint > minimatch > brace-expansion` (dev toolchain, not production bundle). `@babel/core` is transitive under `eslint-plugin-react-hooks` (dev only). `ws` and `dompurify` are production/runtime concerns.

---

## Outdated Dependencies

Packages where `pnpm outdated` reports a newer available version (showing top 20 by relevance and gap size):

| Package | Installed (wanted) | Latest | Gap | Type |
|---|---|---|---|---|
| `dompurify` | 3.4.1 | 3.4.10 | 9 patch releases | devDep (bundled) |
| `vite` | 8.0.10 | 8.0.16 | 6 patch releases | devDep (build tool) |
| `@tabler/icons-react` | 3.41.1 | 3.44.0 | 3 minor releases | devDep (bundled) |
| `tailwindcss` | 4.2.4 | 4.3.1 | 1 minor release | devDep (build tool) |
| `@tailwindcss/vite` | 4.2.4 | 4.3.1 | 1 minor release | devDep (build tool) |
| `eslint` | 10.2.1 | 10.5.0 | 3 patch releases | devDep |
| `typescript-eslint` | 8.59.0 | 8.61.1 | 2 patch releases | devDep |
| `better-sqlite3` | 12.9.0 | 12.11.1 | 2 patch releases | dep (production) |
| `ws` | 8.20.0 | 8.21.0 | 1 patch release | dep (production) |
| `marked` | 18.0.2 | 18.0.5 | 3 patch releases | devDep (bundled) |
| `vitest` | 4.1.5 | 4.1.9 | 4 patch releases | devDep |
| `@vitest/coverage-v8` | 4.1.5 | 4.1.9 | 4 patch releases | devDep |
| `@types/node` | 25.6.0 | 25.9.3 | 3 patch releases | devDep |
| `react` | 19.2.5 | 19.2.7 | 2 patch releases | devDep (bundled) |
| `react-dom` | 19.2.5 | 19.2.7 | 2 patch releases | devDep (bundled) |
| `multer` | 2.1.1 | 2.2.0 | 1 minor release | dep (production) |
| `@types/react` | 19.2.14 | 19.2.17 | 3 patch releases | devDep |
| `@vitejs/plugin-react` | 6.0.1 | 6.0.2 | 1 patch release | devDep |
| `jsdom` | 29.1.0 | 29.1.1 | 1 patch release | devDep |
| `eslint-plugin-react-refresh` | 0.5.2 | 0.5.3 | 1 patch release | devDep |

> **Note on "missing" in pnpm output:** `pnpm outdated` reports packages as "missing (wanted X)" when `node_modules` is not fully materialized in CI/read-only contexts; the wanted version shown reflects the lockfile-pinned version resolved from the semver range in `package.json`.

---

## Abandoned / Unmaintained Packages

Based on analysis of direct and notable transitive dependencies:

- **`refractor` v5.0.0** — Listed as a direct devDependency. Refractor v5 was released in 2022 and has had no releases since. The package is largely maintained in maintenance-only mode; active development moved to the `lowlight` ecosystem. No security issues known, but the stagnation is notable given it handles code syntax parsing.
- **`react-diff-view` v3.3.x** — Release cadence has slowed; `3.3.2` → `3.3.3` was a minor bump only. Monitor for upstream activity, especially with React 19 compatibility.

No direct production dependencies appear fully abandoned, but both packages above warrant monitoring. The remainder of the dependency tree (react 19, vite 8, express 5, ws 8, tailwind 4) are actively maintained and current major versions.

---

## Recommendations

1. **[Critical — do now] Update `ws` to `>=8.21.0`.**
   The production WebSocket server (`ws` is in `dependencies`) is affected by a high-severity OOM DoS (CVE-2026-48779) exploitable by unauthenticated remote peers with no prerequisites. Update `ws` in `package.json` from `^8.21.0` (already in range) by running `pnpm update ws`. This also resolves the moderate memory-disclosure advisory (CVE-2026-45736).

2. **[Critical — do now] Update `dompurify` to `>=3.4.10`.**
   `dompurify` accumulates 7 open advisories against version 3.4.1, including multiple XSS bypass vectors in `IN_PLACE` mode and hook-mutation allowlist pollution. While one advisory (GHSA-x4vx-rjvf-j5p4) has no patch yet, all others are fixed by `3.4.9`/`3.4.10`. This is used for HTML sanitization in the frontend — the risk is high if any user-supplied content is rendered. Update immediately: `pnpm update dompurify`.

3. **[High] Update `vite` to `>=8.0.16`.**
   Two advisories affect `vite` 8.0.10: a Windows NTFS `server.fs.deny` bypass (CVE-2026-53571, high) and an NTLMv2 hash leak via UNC paths (CVE-2026-53632, moderate). Although both are Windows-specific and the dev server runs on Linux, these affect any developer on Windows contributing to the project. Run `pnpm update vite @tailwindcss/vite @vitejs/plugin-react`.

4. **[Medium] Update `express` to resolve transitive `qs` DoS.**
   `qs` 6.15.1 (transitive under `express`) has CVE-2026-8723 — a DoS via `TypeError` on `null` array entries with `arrayFormat:'comma'`. Update `express` to pull in `qs>=6.15.2`. Express 5.2.1 is already available and in range (`^5.1.0`): run `pnpm update express`.

5. **[Medium] Update `eslint` to resolve transitive `brace-expansion` vulnerability.**
   `brace-expansion` 5.0.5 under `eslint > minimatch` has CVE-2026-45149 (DoS via large range expansion). This only affects the dev toolchain, not the production bundle. Run `pnpm update eslint` to get `brace-expansion>=5.0.6`.

6. **[Medium] Update `better-sqlite3` to `12.11.1`.**
   Two patch releases behind (`12.9.0` → `12.11.1`). As a production runtime dependency handling persistent storage, staying current on this package is important for stability and any undisclosed fixes.

7. **[Low] Audit usage of `dompurify` `IN_PLACE` mode.**
   Advisory GHSA-x4vx-rjvf-j5p4 has no patch yet. It only affects `DOMPurify.sanitize(node, { IN_PLACE: true })` on attacker-supplied live DOM objects (e.g. from cross-origin iframes). Audit whether Codekin uses `IN_PLACE` mode and if so, switch to string-input sanitization (`DOMPurify.sanitize(dirtyString)`) which is not affected.

8. **[Low] Replace or monitor `refractor`.**
   `refractor` v5.0.0 has had no releases since 2022. The codebase uses it alongside `highlight.js` — consider consolidating on one syntax highlighter (either `highlight.js` directly or `react-syntax-highlighter` which bundles refractor/prism) to reduce the abandoned-dep surface.

9. **[Low] Address `@babel/core` transitive advisory.**
   CVE-2026-49356 affects `@babel/core` ≤7.29.0 under `eslint-plugin-react-hooks`. Only relevant if Babel is used to compile untrusted code during the build. Update `eslint-plugin-react-hooks` to pull in `@babel/core>=7.29.6`. Risk is build-time only.

10. **[Maintenance] Run `pnpm update` for remaining minor/patch drift.**
    `multer`, `marked`, `react`, `react-dom`, `@tabler/icons-react`, `tailwindcss`, `vitest`, `typescript-eslint`, and type packages all have patch or minor updates available with no breaking changes expected. A single `pnpm update` pass will close most of the 35-package gap and reduce the attack surface from future advisories.