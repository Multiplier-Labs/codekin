# Dependency Health Report: codekin

**Date**: 2026-06-09T04:19:09.520Z
**Repository**: /srv/repos/Multiplier-Labs/codekin
**Branch**: main
**Workflow Run**: ce338477-fddb-40db-a804-52450a8cf2ce
**Session**: 1a3df35a-9ff6-4794-b203-bd7b6f4c3b6f

---

# Dependency Health Assessment — 2026-06-09

**Repository:** Multiplier-Labs/codekin | **Branch:** main

---

## Summary

| Package Manager | Scope | Total Deps | Outdated | Vulnerabilities | Risk Level |
|---|---|---|---|---|---|
| pnpm | root (`/`) | 544 | 28 | 3 moderate | **Medium** |
| npm | `server/` | 240 | 4 | 1 moderate (shared with root) | Low |
| npm | `workflows/` | 98 | 0 | 0 | Low |

> **Note — lockfile / node_modules drift:** `pnpm-lock.yaml` pins `ws@8.20.0` (vulnerable) and `qs@6.15.1` (vulnerable), yet the physical `node_modules/` contains `ws@8.21.0` and `qs@6.15.0`. The audit result is based on the lockfile, which is authoritative for reproducible installs. A fresh `pnpm install` would restore the vulnerable versions.

---

## Security Vulnerabilities

| Package | Locked Version | Severity | CVSS | CVE | Description | Fixed In |
|---|---|---|---|---|---|---|
| `brace-expansion` | 5.0.5 (via `eslint›minimatch`) | Moderate | 6.5 | CVE-2026-45149 | Large numeric range (e.g. `{1..10000000}`) generates full intermediate array before applying `max` limit, allocating ~505 MB and spending ~800 ms — defeating the documented DoS protection | 5.0.6+ |
| `qs` | 6.15.1 (via `express`) | Moderate | 5.3 | CVE-2026-8723 | `qs.stringify` throws synchronous `TypeError` on `null`/`undefined` array entries when `arrayFormat: 'comma'` and `encodeValuesOnly: true` are both set; causes HTTP 500 in request handlers | 6.15.2+ |
| `ws` | 8.20.0 (direct dep) | Moderate | 4.4 | CVE-2026-45736 | Uninitialized memory disclosure when a `TypedArray` is passed as the `reason` argument to `websocket.close()` | 8.20.1+ |

All three vulnerabilities have available patches. No critical or high-severity issues were found.

---

## Outdated Dependencies

Sorted by number of releases behind / security relevance. "Current" reflects the version in the lockfile (pnpm) or `node_modules` (where directly observed).

| Package | Current | Latest | Behind By | Type |
|---|---|---|---|---|
| `vite` | 8.0.5 | 8.0.16 | 11 patches (~2 months) | devDep |
| `dompurify` | 3.4.0 | 3.4.8 | 7 patches (~7 weeks) | devDep |
| `ws` | 8.20.0 *(lockfile)* | 8.21.0 | 1 patch — **CVE fix** | dep |
| `qs` *(transitive)* | 6.15.1 | 6.15.2 | 1 patch — **CVE fix** | dep |
| `brace-expansion` *(transitive)* | 5.0.5 | 5.0.6 | 1 patch — **CVE fix** | dep |
| `@tabler/icons-react` | 3.41.1 | 3.44.0 | 3 minor versions | devDep |
| `tailwindcss` | 4.2.4 | 4.3.0 | 1 minor version | devDep |
| `@tailwindcss/vite` | 4.2.4 | 4.3.0 | 1 minor version | devDep |
| `eslint` | 10.2.1 | 10.4.1 | 2 minor versions | devDep |
| `typescript-eslint` | 8.59.0 | 8.61.0 | 2 patches | devDep |
| `vitest` | 4.1.5 | 4.1.8 | 3 patches | devDep |
| `@vitest/coverage-v8` | 4.1.5 | 4.1.8 | 3 patches | devDep |
| `marked` | 18.0.2 | 18.0.5 | 3 patches | devDep |
| `react` | 19.2.5 | 19.2.7 | 2 patches | devDep |
| `react-dom` | 19.2.5 | 19.2.7 | 2 patches | devDep |
| `@types/node` | 25.6.0 | 25.9.2 | 3 patches | devDep |
| `@types/react` | 19.2.14 | 19.2.17 | 3 patches | devDep |
| `multer` | 2.0.0 *(package.json range)* | 2.1.1 | 1 minor version | dep |
| `better-sqlite3` | 12.9.0 | 12.10.0 | 1 minor version | dep |
| `globals` | 17.5.0 | 17.6.0 | 1 patch | devDep |

---

## Abandoned / Unmaintained Packages

No packages with zero releases in 2+ years were found. Two packages are approaching the 18-month threshold and warrant monitoring:

- **`refractor@5.0.0`** — Last release: **2025-03-11** (~15 months ago). This is a PrismJS wrapper used for syntax highlighting. Active development has been sporadic historically; if no new release appears by late 2026, consider migrating to `highlight.js` (already a direct devDep) or `shiki`.
- **`cmdk@1.1.1`** — Last release: **2025-03-14** (~15 months ago). Command-palette component. No security concern, but worth watching for continued maintenance.
- **`@multiplier-labs/stepflow`** — Private GitHub Packages registry; registry auth was unavailable during this audit. Version health could not be verified. Verify `^0.3.4` is the current stable release by checking the internal repository.

---

## Additional Finding: Unused `dompurify` devDependency

`dompurify` is declared in `devDependencies` (`^3.4.0`) but a full-text search of `src/` found **no imports**. This is notable because:

1. If it was intended to sanitize HTML rendered in the UI, it is silently absent from production code — a potential XSS risk in any component that renders untrusted content.
2. If it was previously used and removed, the devDependency declaration is dead weight.

Action required: either wire `DOMPurify` into the HTML rendering pipeline (e.g., `marked` output before `innerHTML` assignment) or remove the declaration.

---

## Recommendations

1. **Sync the pnpm lockfile immediately.** Run `pnpm update ws qs` (or `pnpm install`) to commit a lockfile that reflects the patched versions already present in `node_modules`. The current state — patched on disk, vulnerable in lockfile — means CI builds and fresh developer checkouts will install the CVE-affected versions.

2. **Upgrade `brace-expansion` via `eslint`.** The CVE-2026-45149 fix requires `brace-expansion@5.0.6+`; this is a transitive dep locked by `eslint›minimatch`. Run `pnpm update eslint` to pull in the patched transitive version, or add an `overrides` entry for `brace-expansion`.

3. **Update `vite` to 8.0.16.** Eleven patch releases have shipped since 8.0.5 (released 2026-04-06). Vite patch releases frequently include security fixes, module resolution hardening, and performance improvements for the dev server — staying current is low risk and high value.

4. **Update `dompurify` to 3.4.8 and resolve the unused import.** Seven rapid patch releases (3.4.1 → 3.4.8, spanning only 6 weeks) from a security-focused sanitizer library strongly suggests an active patch cycle. Either update and integrate it into the markdown/HTML pipeline, or remove it from the project entirely.

5. **Update `multer` from `^2.0.0` to `^2.1.1`.** The `multer` minor update may include multipart parsing improvements relevant to the file-upload endpoint in the server. The server's `package-lock.json` also resolves an outdated version.

6. **Update `tailwindcss` and `@tailwindcss/vite` to 4.3.0.** The 4.3.0 minor release introduces new utility classes and Vite plugin improvements. Keeping the Tailwind toolchain aligned reduces integration friction.

7. **Address the lockfile / node_modules divergence systematically.** The current state where `pnpm-lock.yaml` and physical `node_modules/` disagree (ws, qs) indicates `pnpm install` has not been run after manual package changes. Enforce `pnpm install --frozen-lockfile` in CI to catch this class of drift before it reaches production.

8. **Audit HTML rendering for XSS exposure.** With `dompurify` unused, any component that passes `marked` or `react-markdown` output into `dangerouslySetInnerHTML` or raw DOM APIs is unsanitized. Review `ChatView` and any other components that render untrusted model output as HTML.

9. **Enable automated dependency update PRs.** Given the project's active release cadence and this assessment showing 28+ outdated packages, configure Renovate (or Dependabot) with grouping rules (e.g., group patch security fixes; separate minor/major updates) to keep dependencies current without manual tracking overhead.

10. **Verify `@multiplier-labs/stepflow` version health.** The `workflows/` subpackage depends on `^0.3.4` of a private package that couldn't be audited here. Manually confirm the latest stable version in the internal registry and ensure `workflows/package-lock.json` is not pinning a vulnerable or outdated release.