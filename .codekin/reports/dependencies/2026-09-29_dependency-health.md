# Dependency Health Report: codekin

**Date**: 2026-09-29T04:18:38.846Z
**Repository**: /srv/repos/Multiplier-Labs/codekin
**Branch**: fix/settings-standalone-view
**Workflow Run**: 87e8848c-5624-40c4-8593-357ab508e581
**Session**: e05e38a2-7242-49b7-a4ae-64468e395ef7

---

# Dependency Health Report — Codekin
**Date**: 2026-09-29 | **Branch**: `fix/settings-standalone-view`

---

## Summary

| Package Manager | Total Deps | Outdated (direct) | Vulnerabilities | Risk Level |
|---|---|---|---|---|
| npm (root `package.json`) | 604 (148 prod · 457 dev · 45 optional) | 7 prod + ~12 dev | 2 (1 High · 1 Moderate) | **Medium** |
| npm (`server/package.json`) | shares root `node_modules` via workspace | 1 notable | mirrors root audit | **Medium** |

---

## Security Vulnerabilities

| Package | Installed | Severity | Advisory | Description | Fixed In |
|---|---|---|---|---|---|
| `fast-uri` | 3.1.6 | **HIGH** (CVSS 7.5) | GHSA-qw65-cvwx-89v3 | Authority injection via unvalidated port in `serialize()` | ≥ 3.1.7 |
| `fast-uri` | 3.1.6 | **HIGH** (CVSS 7.5) | GHSA-58mr-gqgx-xq4g | Host confusion via unclosed bracket in URI authority | ≥ 3.1.7 |
| `qs` | 6.15.2 | **MODERATE** (CVSS 5.3) | GHSA-4mjr-xmp4-gh2g | Denial of Service via attacker-controlled `isBuffer` check | ≥ 6.16.0 |
| `qs` | 6.15.2 | **MODERATE** (CVSS 3.7) | GHSA-x5fp-wj9c-mxmx | `array-limit` bypass via bracket-key comma parsing | ≥ 6.16.0 |

**Dependency chains:**
- `fast-uri`: pulled in by `@modelcontextprotocol/sdk → ajv@8` and `ajv-formats → ajv@8`; fix requires `@modelcontextprotocol/sdk@1.31.0` (already available) which ships a patched ajv.
- `qs`: pulled in by `express@5 → body-parser`; the `express` override in `package.json` pins the range — `npm audit fix` can resolve this.

---

## Outdated Dependencies

*(Sorted by update gap: major bumps first, then minor, then patch — top 20)*

| Package | Current | Latest | Gap | Type |
|---|---|---|---|---|
| `typescript` | 6.0.2 | 7.0.2 | +1 major | devDep |
| `@simplewebauthn/browser` | 13.3.0 | 14.0.0 | +1 major | devDep |
| `@simplewebauthn/server` *(server/)* | 13.3.3 | 14.0.0 | +1 major | prod (server) |
| `vitest` | 4.1.2 | 5.0.2 | +1 major | devDep |
| `better-sqlite3` | 12.9.0 | 13.0.3 | +1 major | prod |
| `vite` | 8.1.5 | 8.3.1 | +2 minor | devDep |
| `eslint` | 10.1.0 | 10.11.0 | +10 patch | devDep |
| `typescript-eslint` | 8.58.0 | 8.71.0 | +13 patch | devDep |
| `tailwindcss` | 4.2.2 | 4.3.3 | +1 minor | devDep |
| `@tabler/icons-react` | 3.41.1 | 3.48.0 | +7 patch | devDep |
| `@vitejs/plugin-react` | 6.0.1 | 6.1.1 | +1 minor | devDep |
| `zod` | 4.5.2 | 4.6.5 | +1 minor | prod |
| `marked` | 18.0.2 | 18.0.14 | +12 patch | devDep |
| `react` | 19.2.4 | 19.3.0 | +1 minor | devDep |
| `dompurify` | 3.4.13 | 3.4.16 | +3 patch | devDep |
| `highlight.js` | 11.11.1 | 11.12.0 | +1 patch | devDep |
| `@modelcontextprotocol/sdk` | 1.30.0 | 1.31.0 | +1 patch | prod |
| `ws` | 8.21.0 | 8.22.0 | +1 patch | prod |
| `file-type` | 22.0.1 | 22.1.1 | +1 patch | prod |
| `yaml` | 2.9.0 | 2.9.1 | +1 patch | prod |

---

## Abandoned / Unmaintained Packages

These are transitive dependencies with no releases in 2+ years:

- **`append-field` v1.0.0** — last published 2022-06-13 (4+ years ago). Latest: v2.0.0. Pulled in by `multer`'s internal dependency tree; `multer@2.4.0` still pins to `^1.0.0`.
- **`set-blocking` v2.0.0** — last published 2022-06-26 (4+ years ago). A minimal 2-version yargs utility; only 39 lines of code. Pulled in transitively by test tooling (devDep only). Low risk but signals legacy test infrastructure.

---

## Duplicate / Conflicting Package Versions

21 packages are installed in multiple versions simultaneously. Notable conflicts:

| Package | Versions Present | Root Cause |
|---|---|---|
| `ajv` | 6.14.0 · 8.20.0 | MCP SDK and other packages require different majors |
| `express` | 5.0.6 · 5.2.1 | Lock-file skew — two sub-ranges resolve to different patch releases |
| `qs` | 6.15.0 · 6.15.2 | Two separate resolution paths through express sub-tree |
| `body-parser` | 1.19.6 · 2.3.0 · 2.0.0 | Old vitest/jsdom transitive + current express |
| `multer` | six versions | Multiple versions in nested test fixtures and the actual package |
| `jsdom` | 11.2.7 · 29.0.1 | Very old version pulled in from some transitive test dep alongside current vitest |

The `qs` duplication is directly related to the Moderate vulnerability: both installed versions are in the affected range (< 6.16.0).

---

## Recommendations

1. **Run `npm audit fix` immediately** to resolve the `qs` vulnerability (Moderate, CVSS 5.3). The fix is semver-compatible and available. Also add `"qs": "^6.16.0"` to `overrides` in `package.json` as a belt-and-suspenders guard until the `express@5` dependency ships it natively.

2. **Update `@modelcontextprotocol/sdk` to 1.31.0** — this resolves both HIGH `fast-uri` vulnerabilities, which enter the tree through this package's `ajv@8` dependency. Update in both `package.json` and `server/package.json`.

3. **Update `better-sqlite3` to 13.0.3** (major bump) — check the [13.x changelog](https://github.com/WiseLibs/better-sqlite3/releases) for breaking API changes; the main change is dropping Node 14/16 support, which is fine here.

4. **Synchronise `@simplewebauthn/browser` and `@simplewebauthn/server`** to v14.0.0 — these must be updated together (they share protocol-level types). The browser package is in root devDeps and server package is in `server/` deps; update both in the same PR to avoid a version mismatch.

5. **Upgrade `typescript` from 6.0.2 → 7.0.2** — TypeScript 7 introduces isolatedDeclarations and `--verbatimModuleSyntax` improvements. Review `tsconfig.json` for deprecated options before upgrading, and check that `typescript-eslint@8.71.0` (the latest compatible release) is updated in the same pass.

6. **Upgrade `vitest` from 4.1.2 → 5.0.2** (major) along with `@vitest/coverage-v8`. Vitest 5 drops Node 18 but this environment runs Node 22+; check the migration guide for changed defaults on `test.environment` and snapshot serialisers.

7. **Update frontend patch/minor packages in one batch PR**: `vite` → 8.3.1, `tailwindcss` → 4.3.3, `@vitejs/plugin-react` → 6.1.1, `react` → 19.3.0, `dompurify` → 3.4.16, `highlight.js` → 11.12.0, `marked` → 18.0.14. These are all minor/patch and unlikely to be breaking.

8. **Add `"qs": "^6.16.0"` and `"fast-uri": "^3.1.7"` to `overrides`** in root `package.json`. This defensive-override pattern is already used for `undici`, `nanoid`, `postcss`, and `@babel/core`, so the project has established precedent for this approach to transitive vulnerabilities.

9. **Investigate the `jsdom` v11 ghost** — the lock-file carries `jsdom@11.2.7` alongside the intentional `jsdom@29.0.1`. The v11 copy is very old and pulls in older transitive deps. Run `npm ls jsdom` to find which package requires it and consider an `overrides` entry or dependency replacement.

10. **Consider moving `react`, `react-dom`, `dompurify`, `marked`, and `highlight.js` from `devDependencies` to `dependencies`** in root `package.json`. They are bundled in the production build (`dist/`), and their current placement as devDeps is technically correct (Vite bundles them at build time), but it creates confusion for contributors and tooling that infers bundle scope from the `dependencies`/`devDependencies` split. The published npm package ships a pre-built `dist/`, so the classification does not affect end-users — but clarity in the manifest is worth the one-line change.