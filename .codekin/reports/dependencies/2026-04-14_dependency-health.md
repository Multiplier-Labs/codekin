# Dependency Health Report: codekin

**Date**: 2026-04-14T04:16:50.582Z
**Repository**: /srv/repos/codekin
**Branch**: main
**Workflow Run**: a08248eb-1b52-4cb7-b93c-77758a4bcbe1
**Session**: b71c69a0-a55e-489c-a42e-95820a4e642f

---

Now I have all the data needed. Let me write the report.Report written to `.codekin/reports/dependencies/2026-04-14_dependency-health.md`.

**TL;DR findings:**

- **0 vulnerabilities** — `npm audit` is clean across all severity levels
- **1 outdated package** — `better-sqlite3` is one minor version behind (12.8.0 → 12.9.0)
- **1 maintenance concern** — `refractor` v5.0.0 wraps PrismJS, which is in maintenance-only mode upstream; no active CVEs but slow to patch
- **Notable**: `undici` is overridden in `package.json` as a proactive CVE guard — should be kept current
- **Stack currency**: Very modern — React 19, Vite 8, TypeScript 6, Express 5, Tailwind 4; essentially leading-edge across the board

Top action items: update `better-sqlite3`, document the `undici` override reason, and evaluate migrating off PrismJS/refractor long-term.