# Dependency Health Report: codekin

**Date**: 2026-09-29T04:18:38.846Z
**Repository**: /srv/repos/Multiplier-Labs/codekin
**Branch**: fix/settings-standalone-view
**Workflow Run**: 87e8848c-5624-40c4-8593-357ab508e581
**Session**: e05e38a2-7242-49b7-a4ae-64468e395ef7

---

# Dependency Health Report — Codekin
**Date**: 2026-09-29 | **Branch**: `fix/settings-standalone-view`

> **Revised 2026-09-29 after review.** The vulnerability findings were confirmed and fixed in PR #667. Several claims in the first version were wrong and have been corrected or removed: the duplicate-versions table (it confused `@types/*` packages with the runtime packages), the "jsdom v11" finding, the `@modelcontextprotocol/sdk` remediation for `fast-uri`, the TypeScript 7 description, and the suggestion to move frontend libraries into `dependencies`.

---

## Summary

| Package Manager | Total Deps | Outdated (direct) | Vulnerabilities | Risk Level |
|---|---|---|---|---|
| npm (root `package-lock.json`) | 604 (148 prod · 457 dev · 45 optional) | 7 prod + ~13 dev | 2 (1 High · 1 Moderate) → **0 after #667** | Low |
| npm (`server/package-lock.json`) | separate lockfile | `@simplewebauthn/server` (major) | 2 (1 High · 1 Moderate) → **0 after #667** | Low |

A stale `pnpm-lock.yaml` also exists at the root (last updated 2026-04-28, #450). CI and releases use npm, so this file is out of date and should be removed.

---

## Security Vulnerabilities

| Package | Installed | Severity | Advisory | Description | Fixed In |
|---|---|---|---|---|---|
| `fast-uri` | 3.1.6 | **HIGH** (CVSS 7.5) | GHSA-qw65-cvwx-89v3 | Authority injection via unvalidated port in `serialize()` | 3.1.7 |
| `fast-uri` | 3.1.6 | **HIGH** (CVSS 7.5) | GHSA-58mr-gqgx-xq4g | Host confusion via unclosed bracket in URI authority | 3.1.7 |
| `qs` | 6.15.2 | **MODERATE** (CVSS 5.3) | GHSA-4mjr-xmp4-gh2g | Denial of Service via attacker-controlled `isBuffer` | 6.16.0 |
| `qs` | 6.15.2 | **MODERATE** (CVSS 3.7) | GHSA-x5fp-wj9c-mxmx | `arrayLimit` bypass via bracket-key comma parsing | 6.16.0 |

Both advisories affect the root and `server/` lockfiles.

- **`fast-uri`** comes in through `ajv@8` (under `@modelcontextprotocol/sdk` and `ajv-formats`), whose `^3.0.1` range already accepts the fix. Only ajv's JSON-schema URI handling uses it, so it is hard to exploit here.
- **`qs`** is on express's request-parsing path (`express` / `body-parser`), which the relay exposes. In practice this is the more relevant of the two.

**Status:** both fixed by an in-range lockfile update in PR #667 (`fast-uri` → 3.1.8, `qs` → 6.16.0). No `package.json` or `overrides` changes were needed.

---

## Outdated Dependencies

*(Ranked by update size: major bumps first. The Age column is omitted because release dates were not collected.)*

| Package | Current | Latest | Gap | Type |
|---|---|---|---|---|
| `typescript` | 6.0.2 | 7.0.2 | major | devDep |
| `@simplewebauthn/browser` | 13.3.0 | 14.0.0 | major | devDep |
| `@simplewebauthn/server` *(server/)* | ^13.3.3 (range) | 14.0.0 | major | prod (server) |
| `vitest` | 4.1.2 | 5.0.2 | major | devDep |
| `better-sqlite3` | 12.9.0 | 13.0.3 | major | prod |
| `vite` | 8.1.5 | 8.3.1 | minor | devDep |
| `eslint` | 10.1.0 | 10.11.0 | minor | devDep |
| `typescript-eslint` | 8.58.0 | 8.71.0 | minor | devDep |
| `tailwindcss` | 4.2.2 | 4.3.3 | minor | devDep |
| `@tabler/icons-react` | 3.41.1 | 3.48.0 | minor | devDep |
| `@vitejs/plugin-react` | 6.0.1 | 6.1.1 | minor | devDep |
| `zod` | 4.5.2 | 4.6.5 | minor | prod |
| `react` / `react-dom` | 19.2.4 | 19.3.0 | minor | devDep |
| `@modelcontextprotocol/sdk` | 1.30.0 | 1.31.0 | minor | prod |
| `ws` | 8.21.0 | 8.22.0 | minor | prod |
| `file-type` | 22.0.1 | 22.1.1 | minor | prod |
| `highlight.js` | 11.11.1 | 11.12.0 | minor | devDep |
| `marked` | 18.0.2 | 18.0.14 | patch | devDep |
| `dompurify` | 3.4.13 | 3.4.16 | patch | devDep |
| `yaml` | 2.9.0 | 2.9.1 | patch | prod |

The lockfile already pins `multer` 2.4.0. `npm outdated` reported 2.2.0 because the local `node_modules` was stale; a fresh `npm ci` fixes that.

---

## Abandoned / Unmaintained Packages

No direct dependency is unmaintained. Two small transitive packages have had no release in over two years:

- **`append-field` 1.0.0** (prod, through `multer`): last published 2022-06-13. It is a tiny, stable utility, so the risk is low.
- **`set-blocking` 2.0.0** (dev only): last published 2022-06-26. It is a stable utility with no known issues.

The native-build chain `better-sqlite3 → prebuild-install → tar-fs@2 → tar-stream@2 / bl@4 / chownr@1` pins older majors. It is maintained, not abandoned; the `better-sqlite3` 13 upgrade is the way to modernise it.

---

## Duplicate / Conflicting Package Versions

No problematic runtime duplicates were found. There is one copy each of `express` (5.2.1), `multer` (2.4.0), `jsdom` (29.0.1) and `better-sqlite3` (12.9.0). Two versions of `ajv` (6.x for ESLint, 8.x for the MCP SDK) are expected and harmless.

---

## Recommendations

1. **Merge PR #667** (`fast-uri` + `qs` lockfile fix, root and `server/`). This clears every current audit finding.
2. **Run `npm ci` on dev/prod clones after merging.** Local `node_modules` is out of date with the lockfile (for example, multer 2.2.0 installed vs 2.4.0 locked). On this machine, use `NODE_ENV=development npm ci --include=dev`.
3. **Remove the stale `pnpm-lock.yaml`.** It hasn't been updated since April and could mislead tooling or contributors.
4. **Batch the in-range minor and patch updates** in one PR: `vite`, `tailwindcss`, `@vitejs/plugin-react`, `eslint`, `typescript-eslint`, `react`/`react-dom`, `dompurify`, `highlight.js`, `marked`, `zod`, `ws`, `yaml`, `file-type`, `@modelcontextprotocol/sdk`.
5. **Upgrade `better-sqlite3` to 13 in its own PR.** It is a native module, so rebuild and test on the prod Node version, and check the release notes for Node-version and API changes.
6. **Upgrade `@simplewebauthn/browser` and `@simplewebauthn/server` to 14 together.** They share the WebAuthn protocol types, so a mismatch would break passkey login and device linking. Test the passkey ceremony end to end.
7. **Upgrade `vitest` to 5** (along with `@vitest/coverage-v8`) in its own PR, following the upstream migration guide.
8. **Evaluate TypeScript 7 separately.** It is the native (Go) compiler port, not a routine feature release. Check that it works with `typescript-eslint`, `tsc -b` project references and the Vite toolchain before adopting it.
9. **Leave frontend libraries in `devDependencies`.** `dist/` ships pre-built, so moving React, marked and the rest into `dependencies` would only make `npm install codekin` users download them for nothing.
