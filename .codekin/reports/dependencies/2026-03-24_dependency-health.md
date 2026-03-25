# Dependency Health Report: codekin

**Date**: 2026-03-24T05:19:36.756Z
**Repository**: /srv/repos/codekin
**Branch**: main
**Workflow Run**: 2b46ed80-e71f-4d5c-b8aa-d120dc907da2
**Session**: 8a6f1194-6bbd-4d04-b912-a7c4b0189c89

---

Now I have all the data needed. Let me write the report.## Dependency Health Report — 2026-03-24

**Package manager detected:** npm only (no Python, Go, Rust, or Ruby ecosystems).

### Key findings:

**Security:** Clean — `npm audit` returned **0 vulnerabilities** across both root and server packages.

**Outdated:** 17 packages lag behind latest, but nearly all are due to very recent major version releases:
- `typescript` 5→6 and `vite` 7→8 were both released **yesterday** (2026-03-23) — hold off
- `eslint` + `@eslint/js` 9→10 is the most actionable major upgrade (~47 days old)
- Safe patches (`ws`, `better-sqlite3`, `tailwindcss`, `vitest`, etc.) can be applied immediately with `npm update`

**Abandoned:** `unidiff` (last release: June 2023, ~2 years 10 months ago) — the only package showing abandonment signals. Used alongside `react-diff-view` for diff formatting; consider replacing.

**Duplicate versions:** 18 packages have multiple versions installed, mostly expected artifacts from the Express v4→v5 transition and the ESLint v9→v10 ecosystem fragmentation. No runtime conflicts.

The full structured report has been written to `.codekin/reports/repo-health/2026-03-24_repo-health.md`.