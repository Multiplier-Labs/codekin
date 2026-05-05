# Dependency Health Report: codekin

**Date**: 2026-05-05T04:17:10.042Z
**Repository**: /srv/repos/codekin
**Branch**: main
**Workflow Run**: 0a4a05ea-94d9-4fd4-a88b-d20e035ec8a7
**Session**: a13d032f-6bd1-4380-9114-246f99b70786

---

---
title: Dependency Health Assessment — codekin
date: 2026-05-05
category: dependencies
---

# Dependency Health Assessment

**Project:** codekin v0.6.5  
**Date:** 2026-05-05  
**Package Manager:** pnpm (lockfile v9)

---

## Summary

| Package Manager | Total Deps | Outdated | Vulnerabilities | Risk Level |
|----------------|-----------|---------|----------------|------------|
| pnpm | 544 | 7 | 0 | Low |

No security vulnerabilities were detected. All production runtime dependencies are at their latest published versions. The seven outdated packages are all minor or patch-level bumps in dev dependencies, none of which affect the production server runtime.

---

## Security Vulnerabilities

No vulnerabilities detected by `pnpm audit` across all 544 resolved packages.

**Notable proactive measure:** The project carries an explicit `overrides` entry in `package.json` pinning `undici` to `^7.24.0` (resolved to `7.25.0` in the lockfile). This is a deliberate security override for a transitive dependency, suggesting a past advisory was addressed. The override should be revisited once `undici` ≥ 7.24.0 becomes the organic resolution for all consumers, at which point the override can be removed.

---

## Outdated Dependencies

All production dependencies (`better-sqlite3`, `express`, `multer`, `ws`) are at their latest versions. The following dev/frontend dependencies have newer patch or minor releases available:

| Package | Installed (Lockfile) | Latest | Delta | Type |
|---------|---------------------|--------|-------|------|
| `@tabler/icons-react` | 3.41.1 | 3.42.0 | minor | devDependency |
| `eslint` | 10.2.1 | 10.3.0 | minor | devDependency |
| `globals` | 17.5.0 | 17.6.0 | minor | devDependency |
| `dompurify` | 3.4.1 | 3.4.2 | patch | devDependency (bundled) |
| `jsdom` | 29.1.0 | 29.1.1 | patch | devDependency (test) |
| `marked` | 18.0.2 | 18.0.3 | patch | devDependency (bundled) |
| `typescript-eslint` | 8.59.0 | 8.59.2 | patch | devDependency |

Note: `dompurify` and `marked` are listed under `devDependencies` but are bundled into the production frontend artifact by Vite. Updates to these directly affect the shipped frontend code.

---

## Abandoned / Unmaintained Packages

| Package | Version | Last Release | Age | Usage |
|---------|---------|-------------|-----|-------|
| `refractor` | 5.0.0 | ~Feb 2023 | ~2.2 years | Pulled in transitively by `react-diff-view` for syntax highlighting |

`refractor` is the only package in the dependency graph that has not received a release in over two years. It is a stable PrismJS wrapper by @wooorm and does not expose a runtime surface vulnerable to typical supply-chain risks. However, its stale state means security patches would not be delivered through it if a downstream PrismJS vulnerability were found. The risk is contained since `refractor` is used only for diff rendering (display-only), not for any security-critical path.

---

## Additional Observations

**Peer dependency version boundary (informational):** `typescript-eslint@8.59.0` declares a peer constraint of `typescript: '>=4.8.4 <6.1.0'`. The project uses TypeScript `6.0.3`, which is technically within range (6.0.3 < 6.1.0), but sits very close to the upper bound. An upgrade of TypeScript to `6.1.x` would break this constraint until `typescript-eslint` raises its cap.

**Dev-as-prod bundled packages:** Several packages under `devDependencies` (`react`, `react-dom`, `dompurify`, `marked`, `highlight.js`, `marked-highlight`, `react-markdown`, `remark-gfm`, `refractor`, `react-diff-view`, `cmdk`, `@tabler/icons-react`) are compiled into the production frontend bundle by Vite. This is architecturally appropriate for a single-repo frontend+server project, but it means security-relevant frontend libraries like `dompurify` and `marked` need to be monitored with the same diligence as production dependencies despite their `dev` classification.

**No version conflicts detected:** No packages appear at multiple incompatible major versions in the lockfile.

---

## Recommendations

1. **Patch `dompurify` promptly (3.4.1 → 3.4.2).** Despite being a `devDependency`, DOMPurify ships in the production bundle and is the primary XSS sanitization layer. Patch releases from DOMPurify frequently address sanitization edge cases; apply without delay.

2. **Patch `marked` (18.0.2 → 18.0.3).** Similarly bundled into production. Markdown parsers have historically been a source of XSS vectors; patch promptly.

3. **Run `pnpm update --minor` for the remaining dev-only packages** (`eslint`, `typescript-eslint`, `globals`, `jsdom`, `@tabler/icons-react`). These are all safe minor/patch bumps with no breaking-change risk. A single pass keeps the lockfile current and avoids drift accumulation.

4. **Pin TypeScript below 6.1.0 until `typescript-eslint` raises its peer cap.** Add a comment in `package.json` (e.g., `"typescript": "^6.0.0 <6.1.0"`) to prevent an accidental upgrade to 6.1.x that would break the ESLint pipeline until the upstream peer constraint is updated. Alternatively, watch for a `typescript-eslint` release that extends the cap.

5. **Audit the `undici` override quarterly.** Check whether `undici ^7.24.0` is now the natural resolution of all transitive consumers. If so, remove the override from `package.json` to reduce maintenance surface and allow normal semver resolution to apply.

6. **Evaluate replacing `refractor` as a transitive dependency.** Since `refractor` has had no releases in ~2.2 years, assess whether `react-diff-view` has added support for an alternative (e.g., `shiki` or direct PrismJS) or whether a more actively maintained diff-view library is available. This is low-urgency but worth scheduling before the gap reaches 3 years.

7. **Establish a monthly `pnpm audit` check in CI.** The project currently has no automated vulnerability scanning step evident in the repository configuration. Adding `pnpm audit --audit-level=high` as a CI step would catch newly published advisories between dependency health reports.