# Dependency Health Report: codekin

**Date**: 2026-09-01T04:19:08.627Z
**Repository**: /srv/repos/Multiplier-Labs/codekin
**Branch**: feat/deployments-ui
**Workflow Run**: 8e0af824-4a4d-47cd-8df2-84504a81a4aa
**Session**: fef4373b-6779-4d89-a924-1dbcc33cd5f5

---

# Dependency Health Report — 2026-09-01

**Project:** codekin v0.8.0  
**Assessed:** 2026-09-01  
**Package manager:** npm (package-lock.json; pnpm-lock.yaml also present — see Recommendations)

---

## Summary

| Package Manager | Total Installed | Direct Outdated | Vulnerabilities | Risk Level |
|---|---|---|---|---|
| npm | 607 (151 prod, 457 dev, 45 optional) | 16 direct | **0** | **Low** |

`npm audit` reports zero known CVEs across all 607 installed packages. The main risks are two major-version gaps (TypeScript 6→7, better-sqlite3 12→13), a stale override keeping nanoid on v3, and an undici override one major behind. Three UI libraries have not had a release in 15–19 months.

---

## Security Vulnerabilities

No vulnerabilities detected by `npm audit` at any severity level.

| Package | Severity | CVE | Description | Fixed In |
|---|---|---|---|---|
| — | — | — | No findings | — |

---

## Outdated Dependencies

Sorted by version gap severity (major → minor → patch). "Wanted" = range ceiling from package.json; "Latest" = current npm registry head.

| Package | Current | Wanted | Latest | Gap | Type |
|---|---|---|---|---|---|
| **typescript** | 6.0.2 | ^6.0.2 | **7.0.2** | MAJOR | devDep |
| **better-sqlite3** | 12.9.0 | ^12.9.0 | **13.0.3** | MAJOR | dep |
| **undici** _(override)_ | 7.29.0 | ^7.29.0 | **8.10.1** | MAJOR | override |
| **jsdom** | 29.0.1 | ^29.0.1 | **30.0.1** | MAJOR | devDep |
| **nanoid** _(override)_ | 3.3.18 | ^3.3.17 | **6.0.1** | MAJOR+2 | override |
| @tabler/icons-react | 3.41.1 | ^3.37.1 | 3.46.0 | minor (5 releases) | devDep |
| tailwindcss | 4.2.2 | ^4.2.0 | 4.3.3 | minor | devDep |
| @tailwindcss/vite | 4.2.2 | ^4.2.2 | 4.3.3 | minor | devDep |
| highlight.js | 11.11.1 | ^11.11.1 | 11.12.0 | minor | devDep |
| multer | 2.2.0 | ^2.0.0 | 2.3.0 | minor | dep |
| @types/multer | 2.1.0 | ^2.1.0 | 2.2.0 | minor | devDep |
| vite | 8.1.5 | ^8.0.16 | 8.2.2 | minor | devDep |
| react / react-dom | 19.2.4 | ^19.2.0 | 19.2.8 | patch | devDep |
| vitest / @vitest/coverage-v8 | 4.1.2 | ^4.1.2 | 4.1.11 | patch | devDep |
| marked | 18.0.2 | ^18.0.2 | 18.0.11 | patch | devDep |
| dompurify | 3.4.13 | ^3.4.13 | 3.4.14 | patch | devDep |
| ws | 8.21.0 | ^8.21.0 | 8.21.3 | patch | dep |
| zod | 4.5.2 | ^4.5.2 | 4.5.4 | patch | dep |
| file-type | 22.0.1 | ^22.0.1 | 22.0.2 | patch | dep |
| postcss _(override)_ | 8.5.25 | ^8.5.23 | 8.5.26 | patch | override |

---

## Abandoned / Unmaintained Packages

No package has gone two full years without a release. Three packages are in the 15–19 month range, which is worth monitoring.

| Package | Installed | Last Registry Update | Months Since Last Release | Notes |
|---|---|---|---|---|
| remark-gfm | 4.0.1 | 2025-02-10 | ~19 months | Used by react-markdown pipeline; upstream unified ecosystem |
| react-markdown | 10.1.0 | 2025-03-07 | ~18 months | Core markdown renderer; actively maintained historically |
| refractor | 5.0.0 | 2025-03-11 | ~18 months | Syntax highlighting via Prism; see highlight.js duplication below |
| cmdk | 1.1.1 | 2025-08-27 | ~12 months | Command palette primitive; approaching watch threshold |
| qrcode | 1.5.4 | 2025-11-13 | ~10 months | QR generation; @types/qrcode also unchanged since Oct 2025 |

---

## Additional Findings

### Duplicate installed versions (5 packages)

These arise from the express v4→v5 transition — express v5's sub-dependencies brought newer versions alongside older ones used by multer/other packages. No action required; they do not indicate a conflict.

| Package | Installed Versions | Root Cause |
|---|---|---|
| content-type | 1.0.5, 2.0.0 | express v5 vs. multer/legacy |
| media-typer | 0.3.0, 1.1.0 | same |
| mime-db | 1.52.0, 1.54.0 | same |
| mime-types | 2.1.35, 3.0.2 | same |
| type-is | 1.6.18, 2.1.0 | same |

### Dual lock files

Both `package-lock.json` and `pnpm-lock.yaml` are present. If only npm is used in CI/CD, the pnpm lock file may be stale and should be removed to avoid confusion.

### devDependencies used in the frontend bundle

The following packages are listed as `devDependencies` but are imported directly in `src/` and therefore compiled into the shipped `dist/` bundle: `cmdk`, `dompurify`, `marked`, `marked-highlight`, `highlight.js`, `react`, `react-dom`, `react-markdown`, `react-diff-view`, `refractor`, `remark-gfm`, `@tabler/icons-react`, `@simplewebauthn/browser`. This is **functionally correct** for an app that ships a pre-built `dist/` — end users of the npm package receive the compiled bundle and do not need to install these. However, the classification is misleading and would break anyone attempting to rebuild from source after `npm install --omit=dev`.

---

## Recommendations

1. **Upgrade TypeScript to v7** — TypeScript 7.0.2 (released 2026-08-31) is a major release. Review the migration guide for breaking changes before upgrading; the existing `tsc -b` build pipeline may require flag adjustments. This is the highest-priority non-security update.

2. **Upgrade better-sqlite3 to v13** — v13.0.3 is a major release that may include native binding changes. After upgrading, rebuild the native module (`npm rebuild better-sqlite3`) and run the full test suite (`npm test`). Pin the `@types/better-sqlite3` type package afterward.

3. **Relax or remove the nanoid override** — The override forces `^3.3.17` while the ecosystem has moved to v6. If no transitive dependency requires v3 specifically, removing the override and letting the tree resolve to v6 is cleaner. Audit which packages pull in nanoid (`npm ls nanoid`) first.

4. **Upgrade the undici override to v8** — `^7.29.0` is one major behind (latest 8.10.1). undici is a high-traffic HTTP client used by the Node.js runtime and MCP SDK; staying current here reduces exposure to future CVEs.

5. **Upgrade vite and @tailwindcss/vite together** — Both are at minor gaps (8.1.5→8.2.2 and 4.2.2→4.3.3). These should be updated together since the Tailwind Vite plugin is tightly coupled to the Vite version. Run `npm run build` to verify the frontend still compiles cleanly.

6. **Remove the stale pnpm-lock.yaml** — With npm as the authoritative package manager, a checked-in `pnpm-lock.yaml` risks diverging from `package-lock.json`. Delete it or add a CI check that enforces a single lock file.

7. **Apply all pending patch/minor updates in one pass** — `ws 8.21.3`, `zod 4.5.4`, `file-type 22.0.2`, `multer 2.3.0`, `marked 18.0.11`, `dompurify 3.4.14`, `vitest 4.1.11`, `highlight.js 11.12.0`, `react 19.2.8` are all safe patch/minor bumps. A single `npm update` scoped to these will tighten the lock file with minimal risk.

8. **Evaluate the react-markdown + refractor + remark-gfm stack** — These three packages (18–19 months without release) form a coupled pipeline. If upstream `unified`/`remark` stalls further, consider migrating to the standalone `marked` pipeline already present in `markdownPipeline.ts` and consolidating to a single renderer — this would also eliminate the refractor dependency.

9. **Re-classify runtime frontend packages** — Move `cmdk`, `dompurify`, `marked`, `marked-highlight`, `highlight.js`, `react`, `react-dom`, `react-markdown`, `react-diff-view`, `remark-gfm`, `@tabler/icons-react`, and `@simplewebauthn/browser` from `devDependencies` to `dependencies`, or document explicitly that the package is "batteries-included" (pre-built dist) and add a `prepare` script warning to prevent `--omit=dev` source builds from silently failing.

10. **Set up automated dependency monitoring** — Integrate `npm audit` and `npm outdated` into CI (e.g., fail on high/critical CVEs; warn on major-version gaps older than 90 days). Given the project's velocity, a monthly automated PR via Renovate or Dependabot would keep the lock file current without manual triage.