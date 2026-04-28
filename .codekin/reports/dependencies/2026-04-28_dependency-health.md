# Dependency Health Report: codekin

**Date**: 2026-04-28T04:18:17.735Z
**Repository**: /srv/repos/codekin
**Branch**: docs/audit-reports-2026-04-18
**Workflow Run**: cc6ab042-92c7-4bff-b646-9845106e010e
**Session**: fa8769c6-1266-470a-9981-f0a1f54a4c62

---

# Dependency Health Assessment — 2026-04-28

**Project**: codekin v0.6.3  
**Package Manager**: pnpm  
**Assessment Date**: 2026-04-28

---

## Summary

| Package Manager | Total Deps | Outdated | Vulnerabilities | Risk Level |
|---|---|---|---|---|
| pnpm | 544 | 2 | 0 | **Low** |

All production server dependencies are current. Two minor/major version gaps exist in dev tooling. No known CVEs detected across the full dependency tree.

---

## Security Vulnerabilities

No vulnerabilities found. `pnpm audit` reports 0 issues across all severity levels (critical, high, moderate, low, info) for all 544 resolved packages.

> Note: The `undici` override (`^7.24.0`, resolved to `7.24.6`) is applied to address a prior vulnerability in an indirect dependency. This override should remain pinned until undici is updated transitively by upstream consumers.

---

## Outdated Dependencies

`pnpm outdated` detected 2 packages behind their latest published release:

| Package | Current | Latest | Gap | Type |
|---|---|---|---|---|
| `marked` | 17.0.6 | 18.0.2 | Major version | dev (frontend runtime) |
| `typescript-eslint` | 8.59.0 | 8.59.1 | Patch | dev |

All other direct dependencies (express, ws, better-sqlite3, multer, dompurify, react, vite, typescript, vitest, tailwindcss, react-diff-view, @tabler/icons-react, eslint, jsdom, cmdk, react-markdown, refractor, remark-gfm, marked-highlight, @vitejs/plugin-react) are at their current latest versions.

---

## Abandoned / Unmaintained Packages

No packages exceed the 2-year abandonment threshold. The following packages have had no releases in 12–17 months and are worth monitoring:

| Package | Installed | Latest | Last Release | Months Since Release |
|---|---|---|---|---|
| `source-map-js` | 1.2.1 | 1.2.1 | 2024-09-08 | ~20 months |
| `highlight.js` | 11.11.1 | 11.11.1 | 2024-12-25 | ~16 months |
| `remark-gfm` | 4.0.1 | 4.0.1 | 2025-02-10 | ~14 months |
| `react-markdown` | 10.1.0 | 10.1.0 | 2025-03-07 | ~14 months |
| `refractor` | 5.0.0 | 5.0.0 | 2025-03-11 | ~14 months |
| `cmdk` | 1.1.1 | 1.1.1 | 2025-03-14 | ~14 months |

These packages are all at their published latest; the gap reflects lower release cadence rather than active abandonment. All are widely used in the ecosystem with active downstream consumers.

---

## Dev/Production Classification Issue

Several packages listed in `devDependencies` are imported by production frontend source files in `src/` and are bundled into the Vite output:

| Package | Used In | Concern |
|---|---|---|
| `dompurify` | `MarkdownRenderer.tsx`, `ChatView.tsx` | XSS-critical runtime dep classified as dev |
| `marked` | `MarkdownRenderer.tsx` | Markdown rendering at runtime |
| `marked-highlight` | `MarkdownRenderer.tsx` | Syntax highlighting integration |
| `highlight.js` | `ChatView.tsx`, `src/lib/hljs.ts` | Runtime syntax highlighting |
| `react-markdown` | `src/` components | Runtime markdown rendering |
| `react-diff-view` | `DiffHunkView.tsx` | Runtime diff rendering |
| `cmdk` | `CommandPalette.tsx`, `SlashAutocomplete.tsx` | Runtime command palette UI |
| `refractor` | Used by react-diff-view | Runtime PrismJS adapter |
| `remark-gfm` | Used with react-markdown | Runtime GFM extension |

Because this is a Vite-bundled app (not a published library with consumers that run `npm install --production`), Vite bundles all imported modules regardless of `devDependencies` vs `dependencies` classification. The pre-built `dist/` is what ships. The misclassification does not affect the runtime bundle or security posture, but it misrepresents the project's true dependency surface and would cause breakage if the production server ever ran with `--omit=dev`.

---

## Recommendations

1. **Update `marked` to v18** (priority: medium). This is a major version bump (`17.0.6 → 18.0.2`). Review the v18 changelog for breaking changes — the `marked` API has historically introduced breaking changes between major versions. The `marked-highlight` integration should be verified for compatibility with v18 before updating.

2. **Update `typescript-eslint` to 8.59.1** (priority: low). This is a patch release published 2026-04-27. Run `pnpm update typescript-eslint` — no breaking changes expected.

3. **Reclassify frontend runtime packages from `devDependencies` to `dependencies`** (priority: low-medium). Move `dompurify`, `marked`, `marked-highlight`, `highlight.js`, `react-markdown`, `react-diff-view`, `cmdk`, `refractor`, and `remark-gfm` to `dependencies`. While this does not affect the Vite build or current deployment, it accurately reflects the runtime surface and prevents future `--production` install breakage if server-side rendering or SSR is ever introduced.

4. **Keep the `undici` override pinned and monitor for upstream resolution** (priority: ongoing). Track whether `express` or other consumers update their `undici` dependency transitively so the override can eventually be removed. Periodically check for new advisories on undici.

5. **Monitor `highlight.js` and `remark-gfm` for end-of-life signals** (priority: low). Both have been quiet for 14–16 months. They are widely used packages (highlight.js especially), but if activity continues to decline, evaluate alternatives such as `shiki` (actively maintained, used by Vite itself) for syntax highlighting.

6. **Audit `dompurify` configuration for completeness** (priority: medium). `dompurify` is at latest (3.4.1) and correctly applied, but the custom `afterSanitizeAttributes` hook in `MarkdownRenderer.tsx` should be periodically reviewed against the DOMPurify changelog to ensure no new bypass vectors have been published that the hook does not address.

7. **Verify `marked` v18 does not regress XSS sanitization** (priority: high, if upgrading). When upgrading `marked`, confirm that the DOMPurify sanitization layer in `MarkdownRenderer.tsx` still applies correctly after parsing. Major marked versions have historically changed output HTML structure.

8. **Consider consolidating markdown rendering** (priority: low). The project uses both `marked` (with `marked-highlight` + DOMPurify) and `react-markdown` (with `remark-gfm`) — two parallel rendering stacks. Consolidating to one would reduce the dependency surface and attack surface.