# Dependency Health Report: codekin

**Date**: 2026-05-19T04:16:47.034Z
**Repository**: /srv/repos/codekin
**Branch**: main
**Workflow Run**: 884a18a1-6f90-4fbb-8660-fa9a4ca44c9d
**Session**: 55deaad5-f0c3-46d6-a11d-b1ffd628a79e

---

# Dependency Health Assessment — 2026-05-19

**Project:** codekin v0.6.5
**Package Manager:** pnpm (lock file: `pnpm-lock.yaml`)
**Assessment Date:** 2026-05-19

---

## Summary

| Package Manager | Total Deps | Outdated (minor) | Vulnerabilities | Risk Level |
|---|---|---|---|---|
| pnpm | 544 | 18 | 2 (moderate) | **Medium** |

No critical or high-severity vulnerabilities were found. Two moderate CVEs were identified — both are freshly disclosed (May 2026) and have patches available. The overall dependency footprint is healthy with a modern, actively maintained stack.

---

## Security Vulnerabilities

| Package | Severity | CVE | Description | Fixed In |
|---|---|---|---|---|
| `ws` | **Moderate** | CVE-2026-45736 | Uninitialized memory disclosure when a `TypedArray` is passed as the `close()` reason argument; potential for partial memory leak | 8.20.1 |
| `brace-expansion` | **Moderate** | CVE-2026-45149 | Large numeric range (e.g. `{1..10000000}`) causes full intermediate array allocation before the `max` limit is applied, defeating DoS protection (~505 MB / ~800 ms) | 5.0.6 |

**Notes:**
- `ws` is a **direct production dependency** (`dependencies`). Upgrade is straightforward and required.
- `brace-expansion@5.0.5` is a **transitive dependency** via `eslint → minimatch → brace-expansion` (depth 4). The pnpm audit suggests updating `brace-expansion` directly (action type: `update`). Because the vulnerability path is dev-only (through ESLint), production runtime exposure is nil — but the package should still be updated.
- Both CVEs were disclosed on 2026-05-18, the day before this audit.

---

## Outdated Dependencies

All detected out-of-date packages are within the same major version (patch or minor bumps). No major-version breaking changes are pending.

| Package | Current (Locked) | Latest | Delta | Type |
|---|---|---|---|---|
| `dompurify` | 3.4.1 | 3.4.5 | +4 patches | devDependency (bundled) |
| `@tabler/icons-react` | 3.41.1 | 3.44.0 | +3 minors | devDependency (bundled) |
| `tailwindcss` | 4.2.4 | 4.3.0 | +1 minor | devDependency |
| `@tailwindcss/vite` | 4.2.4 | 4.3.0 | +1 minor | devDependency |
| `eslint` | 10.2.1 | 10.4.0 | +2 patches | devDependency |
| `typescript-eslint` | 8.59.0 | 8.59.4 | +4 patches | devDependency |
| `@types/node` | 25.6.0 | 25.9.0 | +3 patches | devDependency |
| `vite` | 8.0.10 | 8.0.13 | +3 patches | devDependency |
| `vitest` | 4.1.5 | 4.1.6 | +1 patch | devDependency |
| `@vitest/coverage-v8` | 4.1.5 | 4.1.6 | +1 patch | devDependency |
| `better-sqlite3` | 12.9.0 | 12.10.0 | +1 minor | dependency (prod) |
| `ws` | 8.20.0 | 8.20.1 | +1 patch | dependency (prod) |
| `react` | 19.2.5 | 19.2.6 | +1 patch | devDependency (bundled) |
| `react-dom` | 19.2.5 | 19.2.6 | +1 patch | devDependency (bundled) |
| `marked` | 18.0.2 | 18.0.3 | +1 patch | devDependency (bundled) |
| `jsdom` | 29.1.0 | 29.1.1 | +1 patch | devDependency |
| `@vitejs/plugin-react` | 6.0.1 | 6.0.2 | +1 patch | devDependency |
| `globals` | 17.5.0 | 17.6.0 | +1 minor | devDependency |

---

## Abandoned / Unmaintained Packages

No packages with confirmed zero releases in 2+ years were found in the direct dependency list. Two packages in the transitive closure warrant monitoring:

- **`refractor@5.0.0`** — Syntax highlighting primitives used by `react-diff-view`. The v5 line has seen infrequent activity; if the project's React 19 support becomes blocked upstream, consider switching to `shiki` (the successor ecosystem for PrismJS-based highlighters).
- **`bidi-js@1.0.3`** — Bidirectional text utility used transitively. Very small, stable API — low risk of abandonment impact, but has no recent activity.
- **`chownr@1.1.4`** — Used transitively by `better-sqlite3` build tooling. The `chownr` maintainer released v3.x but this version is pinned deep. No known security issues, but represents technical debt if `better-sqlite3` hasn't upgraded.

---

## Recommendations

1. **Patch `ws` immediately (CVE-2026-45736).** This is a direct production dependency. Run `pnpm update ws@8.20.1` and commit the lockfile. The patch is minimal and should be safe. Exposure is real — any code passing a `TypedArray` to `ws.close()` could leak uninitialized memory. Priority: **high**.

2. **Resolve `brace-expansion` transitive vulnerability (CVE-2026-45149).** Add `"brace-expansion": "^5.0.6"` to the `overrides` section of `package.json` (alongside the existing `undici` override). This forces the nested version used by `eslint → minimatch` to the patched release without waiting for upstream to update. Priority: **medium** (dev-only path, no prod runtime exposure).

3. **Update `dompurify` from 3.4.1 → 3.4.5.** This package sanitizes HTML in the frontend and is included in the production bundle. Four patch releases have shipped since the locked version — check the changelog for any security-relevant fixes before upgrading. Priority: **medium**.

4. **Update `better-sqlite3` from 12.9.0 → 12.10.0.** This is a direct production dependency handling SQLite I/O. Minor version bumps for native modules often include important bug fixes or macOS/glibc compatibility updates. Priority: **medium**.

5. **Update `tailwindcss` + `@tailwindcss/vite` from 4.2.4 → 4.3.0.** The v4 Tailwind line has been moving fast; minor releases can include new utilities or CSS engine fixes. Since these are build-only, there is no production runtime risk. Run together and verify the built CSS output. Priority: **low**.

6. **Batch-update all patch-level dev tools** (`eslint`, `typescript-eslint`, `vite`, `vitest`, `@vitest/coverage-v8`, `@vitejs/plugin-react`, `jsdom`, `globals`, `react`, `react-dom`, `marked`). These are all single-patch bumps and unlikely to be breaking. A single `pnpm update` pass followed by `pnpm test && pnpm build` should validate them safely. Priority: **low**.

7. **Update `@tabler/icons-react` from 3.41.1 → 3.44.0.** Three minor releases have shipped. Icon libraries can occasionally remove or rename icons between minor versions; run a visual smoke test after upgrading. Priority: **low**.

8. **Evaluate `refractor` / `react-diff-view` long-term.** The `react-diff-view` + `refractor` combination for diff rendering has limited recent maintenance. If syntax-highlighted diffs are a core feature, consider migrating to `@uiw/react-codemirror` or a `shiki`-based solution that supports React 19 natively and receives active updates. Priority: **low / strategic**.

9. **Audit dev-dependency bundle inclusion.** Several devDependencies (`dompurify`, `react`, `react-dom`, `marked`, `@tabler/icons-react`, `cmdk`, `highlight.js`) are actually bundled into the production frontend build. Structurally these should be in `dependencies`, not `devDependencies`, to accurately reflect the production footprint. This is a documentation/correctness issue, not a runtime bug, but it means `npm audit --only=prod` would incorrectly exclude them. Priority: **low / housekeeping**.

10. **Add `pnpm audit` to CI pipeline.** The two moderate CVEs were disclosed one day before this audit. A CI gate that runs `pnpm audit --audit-level=moderate` would surface newly disclosed vulnerabilities automatically on every PR rather than requiring a periodic manual assessment. Priority: **medium**.