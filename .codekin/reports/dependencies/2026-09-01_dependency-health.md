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

> **Correction (applied 2026-09-01, after initial publication).** The first version of this
> report audited only the root `package.json` and reported "0 vulnerabilities". The repository
> contains **three** projects with committed lock files — root, `server/`, and `workflows/` —
> and `workflows/` carried one critical and one high advisory. The Summary and Security
> Vulnerabilities sections below have been corrected, and several Recommendations were
> withdrawn after verification. Fix shipped in PR #627.

## Summary

| Project | Total Installed | Direct Outdated | Vulnerabilities | Risk Level |
|---|---|---|---|---|
| root | 607 (151 prod, 457 dev, 45 optional) | 16 direct | 0 | Low |
| `server/` | 295 (191 prod, 105 dev, 58 optional) | not assessed | 0 | Low |
| **`workflows/`** | 98 (64 prod, 35 dev, 27 optional) | not assessed | **1 critical, 1 high, 1 moderate** | **High** |

The root and `server/` projects are clean. All security findings are confined to `workflows/`,
whose lock file had never been audited — `.github/workflows/ci.yml` runs
`npm audit --audit-level=high` against the root and `server/` only, so this third project could
accumulate advisories indefinitely without any CI signal.

Outside of security, the main open items are two major-version gaps (TypeScript 6→7 and
better-sqlite3 12→13 — the latter now known to be blocked, see Recommendations) and three UI
libraries with no release in 15–19 months.

---

## Security Vulnerabilities

All findings are in `workflows/package-lock.json`. All three were resolved in PR #627 via
`npm audit fix --package-lock-only` (no `--force`, no direct dependency changes).

| Package | Severity | Advisories | Description | Fixed In |
|---|---|---|---|---|
| `tar` 7.5.13 | **critical** | [GHSA-vmf3-w455-68vh](https://github.com/advisories/GHSA-vmf3-w455-68vh), [GHSA-23hp-3jrh-7fpw](https://github.com/advisories/GHSA-23hp-3jrh-7fpw), [GHSA-8x88-c5mf-7j5w](https://github.com/advisories/GHSA-8x88-c5mf-7j5w), [GHSA-r292-9mhp-454m](https://github.com/advisories/GHSA-r292-9mhp-454m), [GHSA-w8wr-v893-vjvp](https://github.com/advisories/GHSA-w8wr-v893-vjvp), [GHSA-gvwx-54wh-qm9j](https://github.com/advisories/GHSA-gvwx-54wh-qm9j) | Parser interpretation differential enabling file smuggling; decompression DoS (CVSS 7.5); infinite loop on negative entry size (7.5); uncontrolled recursion stack-overflow DoS (7.5) | 7.5.22 |
| `undici` 6.25.0 | **high** | [GHSA-vxpw-j846-p89q](https://github.com/advisories/GHSA-vxpw-j846-p89q), [GHSA-p88m-4jfj-68fv](https://github.com/advisories/GHSA-p88m-4jfj-68fv), [GHSA-35p6-xmwp-9g52](https://github.com/advisories/GHSA-35p6-xmwp-9g52), [GHSA-8xcm-r25x-g524](https://github.com/advisories/GHSA-8xcm-r25x-g524), [GHSA-v3r7-h72x-cjcm](https://github.com/advisories/GHSA-v3r7-h72x-cjcm), [GHSA-m8rv-5g2x-5cg5](https://github.com/advisories/GHSA-m8rv-5g2x-5cg5), [GHSA-g8m3-5g58-fq7m](https://github.com/advisories/GHSA-g8m3-5g58-fq7m) | WebSocket DoS via fragment-count bypass (CVSS 7.5); HTTP header injection via Set-Cookie percent-decoding (5.9); response queue poisoning via keep-alive socket reuse | 8.10.1 |
| `re2` 1.24.0 | moderate | [GHSA-6hxr-mr5r-9836](https://github.com/advisories/GHSA-6hxr-mr5r-9836), [GHSA-8hcv-x26h-mcgp](https://github.com/advisories/GHSA-8hcv-x26h-mcgp), [GHSA-ff84-5f28-78qj](https://github.com/advisories/GHSA-ff84-5f28-78qj), [GHSA-j4r3-hg7j-8chg](https://github.com/advisories/GHSA-j4r3-hg7j-8chg) | Infinite loop with unbounded native memory growth (CVSS 6.2); process abort on oversized replace (6.2); OOB heap read disclosing adjacent memory to JavaScript (5.1) | 1.26.1 |

**Dependency paths.** `re2` is a direct dependency of `@multiplier-labs/stepflow`; `tar` and
`undici` both arrive through `node-gyp`. The three resolve as one coherent chain rather than
three independent bumps: `re2` 1.26.1 requires `node-gyp` ^13.0.1, and `node-gyp` 13 carries
the fixed `tar` and `undici`.

**Exposure.** Low in practice. `workflows/` is `private: true`, absent from the root `files`
field, not referenced by any runtime code path, and its `node_modules` was not even installed
locally. The advisories were nonetheless live in a committed lock file.

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

### Three projects, four committed lock files

The repository contains `package-lock.json` at the root, in `server/`, and in `workflows/`, plus
an orphaned `pnpm-lock.yaml` at the root. Any audit of this repo must cover all three npm
projects; auditing only the root — as the first version of this report did — misses `workflows/`
entirely, which is where every current advisory lives.

### Orphaned pnpm lock file

`pnpm-lock.yaml` was last modified 2026-06-03 and last touched by a commit in April 2026, while
`package-lock.json` is current as of 2026-08-29. No reference to pnpm exists in `package.json`,
`.github/workflows/`, or the docs. It is orphaned and safe to delete.

### devDependencies used in the frontend bundle

The following packages are listed as `devDependencies` but are imported directly in `src/` and
therefore compiled into the shipped `dist/` bundle: `cmdk`, `dompurify`, `marked`,
`marked-highlight`, `highlight.js`, `react`, `react-dom`, `react-markdown`, `react-diff-view`,
`refractor`, `remark-gfm`, `@tabler/icons-react`, `@simplewebauthn/browser`.

This is **correct as-is**, not a latent bug. The package ships a prebuilt `dist/`, so consumers
never rebuild from source. Tracing the CLI entrypoint's full import graph
(`bin/codekin.mjs` → `server/dist/relay/connector-cli.js`, 8 files) confirms its only external
imports are `better-sqlite3` and `ws`, both already declared in root `dependencies`. No
reclassification is needed — see withdrawn recommendation #11.

---

## Recommendations

1. **Fix the `workflows/` advisories** — ✅ **Done in PR #627.** `npm audit fix --package-lock-only`
   clears all three findings. Verified: `npm ci --include=dev` installs cleanly,
   `npm run coverage:build` (`tsc --noEmit`) passes, `npm audit` reports 0 vulnerabilities.

2. **Add `workflows/` to the CI audit step** — This is the root cause of finding #1 and the
   highest-value remaining action. `.github/workflows/ci.yml` currently audits only two of the
   three projects:

   ```yaml
   - name: Audit dependencies
     run: |
       npm audit --audit-level=high
       cd server && npm audit --audit-level=high
   ```

   Adding `cd workflows && npm audit --audit-level=high` closes the gap cheaply — `npm audit`
   reads the lock file directly and needs no install step. Note that a full `npm ci` for
   `workflows/` should *not* be added: `node-gyp` 13's dependencies declare
   `node: ^22.22.2 || ^24.15.0 || >=26.0.0`, which would emit `EBADENGINE` warnings on the
   Node 20 leg of the CI matrix. Audit-only avoids this entirely.

3. **Upgrade TypeScript to v7** — TypeScript 7.0.2 (released 2026-08-31) is a major release.
   Review the migration guide for breaking changes before upgrading; the existing `tsc -b`
   pipeline may require flag adjustments. Real, but there is no forcing function — schedule it
   deliberately rather than treating it as routine dependency hygiene.

4. ~~**Upgrade better-sqlite3 to v13**~~ — **Withdrawn: blocked.** v13 declares
   `engines: {node: ">=22"}`, but the CI matrix is `node-version: [20, 22]` and `publish.yml`
   builds on Node 20. Upgrading would silently drop Node 20 support. Revisit only as part of a
   deliberate decision to raise the project's Node floor, updating CI and `publish.yml` together.

5. ~~**Relax or remove the nanoid override**~~ — **Withdrawn: not possible.** The original
   recommendation assumed the override was holding back an ecosystem that had moved to v6. It
   is not: `postcss` requires `nanoid ^3.3.16`, so v3 is the only reachable major. The override
   (`^3.3.17`, resolving to 3.3.18) is redundant but harmless. No action.

6. **Consider upgrading the root undici override to v8** — `^7.29.0` is one major behind (latest
   8.10.1). No advisory currently applies to 7.29.0, so this is forward-looking hygiene rather
   than a fix. Low priority.

7. **Upgrade vite and @tailwindcss/vite together** — Both are at minor gaps (8.1.5→8.2.2 and
   4.2.2→4.3.3). These should be updated together since the Tailwind Vite plugin is tightly
   coupled to the Vite version. Run `npm run build` to verify the frontend still compiles cleanly.

8. **Apply all pending patch/minor updates in one pass** — `ws 8.21.3`, `zod 4.5.4`,
   `file-type 22.0.2`, `multer 2.3.0`, `marked 18.0.11`, `dompurify 3.4.14`, `vitest 4.1.11`,
   `highlight.js 11.12.0`, `react 19.2.8` are all safe patch/minor bumps. No advisories sit
   behind any of them, so this is low-urgency lock-file tightening.

9. **Remove the stale pnpm-lock.yaml** — Confirmed orphaned: last modified 2026-06-03 (three
   months staler than `package-lock.json`), last touched by a commit in April 2026, and with
   zero references to pnpm anywhere in `package.json`, `.github/workflows/`, or the docs. Safe
   to delete; trivial cleanup with no functional impact.

10. **Evaluate the react-markdown + refractor + remark-gfm stack** — These three packages
    (18–19 months without release) form a coupled pipeline. If upstream `unified`/`remark` stalls
    further, consider migrating to the standalone `marked` pipeline already present in
    `markdownPipeline.ts` and consolidating to a single renderer — this would also eliminate the
    `refractor` dependency.

11. ~~**Re-classify runtime frontend packages**~~ — **Withdrawn: unnecessary.** The original
    recommendation warned that `--omit=dev` source builds would break. Verified against the
    actual published surface: the package ships a prebuilt `dist/`, and tracing the full import
    graph of the CLI entrypoint (`bin/codekin.mjs` → `server/dist/relay/connector-cli.js`, 8
    files) shows its only external imports are `better-sqlite3` and `ws` — both already in root
    `dependencies`. The current classification is correct.

12. **Set up automated dependency monitoring** — Integrate `npm audit` and `npm outdated` into CI
    across **all three** projects (see #2; fail on high/critical, warn on major-version gaps older
    than 90 days). A monthly Renovate or Dependabot PR would keep lock files current without
    manual triage — and would have surfaced the `workflows/` advisories long before this audit.