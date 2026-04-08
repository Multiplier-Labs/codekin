# Dependency Health Report: codekin

**Date**: 2026-04-07T04:16:57.661Z
**Repository**: /srv/repos/codekin
**Branch**: chore/reports-2026-04-07
**Workflow Run**: 24f16fb6-3260-436a-83d2-3bb70b261e77
**Session**: 87b93d1a-4ec5-4e1c-bb40-a7e3b9624c5c

---

Now I have enough data to write the report.## Summary

| Package Manager | Total Deps | Outdated | Vulnerabilities | Risk Level |
|---|---|---|---|---|
| npm | 548 (113 prod, 436 dev, 45 optional) | 5 | 1 package (3 CVEs) | **High** |

---

## Security Vulnerabilities

| Package | Severity | Advisory | Description | Fixed In |
|---|---|---|---|---|
| vite | **High** | GHSA-v2wj-q39q-566r | `server.fs.deny` bypassed with URL queries — allows unauthorized file access through the dev server | 8.0.5 |
| vite | **High** | GHSA-p9ff-h696-f583 | Arbitrary File Read via Vite Dev Server WebSocket — unauthenticated WebSocket access can read arbitrary files | 8.0.5 |
| vite | Moderate | GHSA-4w7w-66w2-5vf9 | Path Traversal in Optimized Deps `.map` Handling — crafted URLs can escape the allowed directory | 8.0.5 |

> All three vulnerabilities affect `vite` versions `>=8.0.0 <=8.0.4`. The installed version is **8.0.3**. A fix is available in **8.0.5** (already within the `^8.0.3` semver range declared in `package.json`). These are dev-only vulnerabilities affecting the Vite dev server and build tooling — they do not affect the production runtime. However, they should still be patched promptly.

---

## Outdated Dependencies

| Package | Current | Latest | Lag | Type |
|---|---|---|---|---|
| vite | 8.0.3 | 8.0.5 | 2 patches (security) | devDependency |
| eslint | 10.1.0 | 10.2.0 | 1 minor | devDependency |
| marked | 17.0.5 | 17.0.6 | 1 patch | devDependency |
| jsdom | 29.0.1 | 29.0.2 | 1 patch | devDependency |
| @types/node | 25.5.0 | 25.5.2 | 2 patches | devDependency |

> All outdated packages are minor or patch updates, and all are dev dependencies. The overall dependency hygiene is excellent — no production dependencies are outdated.

---

## Abandoned / Unmaintained Packages

No packages in the direct dependency tree show signs of abandonment. Notable observations:

- **`refractor`** (`^5.0.0`) — a PrismJS-based syntax highlighter wrapper. The `refractor` package has historically had slow release cadence; if the installed version is significantly behind, consider migrating to `highlight.js` (already also a direct dependency) for a consolidated highlighting solution.
- **`react-diff-view`** (`^3.3.2`) — a niche package with limited maintainer activity. Monitor for updates; if it stalls, `diff2html` is a maintained alternative.

No direct production dependencies (`express`, `ws`, `better-sqlite3`, `multer`) show signs of abandonment — all are actively maintained projects with recent releases.

---

## Recommendations

1. **[Critical — do now] Update `vite` to `^8.0.5`** — resolves all 3 active CVEs (two High, one Moderate). Run `npm install vite@latest` or `npm update vite`. The fix is a patch bump well within the declared semver range, so it should be safe.

2. **[Routine] Apply remaining patch/minor updates** — `eslint`, `marked`, `jsdom`, and `@types/node` all have minor updates available. A single `npm update` pass will pull them in. Consider doing this in a dedicated chore PR to keep security fixes isolated.

3. **[Hygiene] Audit the `undici` override** — `package.json` has `"overrides": { "undici": "^7.24.0" }`. This suggests a past transitive vulnerability forced an override. Verify whether the override is still necessary after the next round of updates, and remove it if the upstream packages have resolved to a safe version on their own.

4. **[Hygiene] Consolidate syntax highlighting** — both `highlight.js` and `refractor` (a PrismJS wrapper) are present. They serve the same purpose. Standardising on one (prefer `highlight.js` as it has wider adoption and faster CVE response) would reduce bundle size and maintenance surface.

5. **[Watch] Monitor `react-diff-view`** — this is a niche devDependency with limited maintenance history. If it goes unmaintained or incompatible with React 19, consider `react-diff-viewer-continued` or a custom implementation using the `diff` npm package directly.

6. **[Process] Pin `vite` major in CI** — given that `vite` already has three CVEs within its first four patch releases of the v8 series, consider adding a scheduled `npm audit` step to CI (or a Dependabot/Renovate configuration) so future vulnerabilities in the dev toolchain are caught automatically rather than requiring manual assessment.

7. **[Verification] Confirm no dev deps leak to production bundle** — run `vite build` with `--minify=false` and inspect `dist/` to confirm that packages like `eslint`, `vitest`, `jsdom`, and type packages are absent from the production output. Given the project structure, this is likely already correct, but worth a one-time verification given the large devDependency count (436).