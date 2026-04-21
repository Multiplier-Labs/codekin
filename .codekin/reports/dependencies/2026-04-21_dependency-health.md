# Dependency Health Report: codekin

**Date**: 2026-04-21T04:17:41.301Z
**Repository**: /srv/repos/codekin
**Branch**: docs/audit-reports-2026-04-18
**Workflow Run**: c88bcde9-ef62-4bb5-b6b0-1ce389466901
**Session**: 216aab52-78e9-470c-908d-6e2ac3021124

---

I'll gather dependency information before writing the report.Now I have all the data needed to write the report.Report written. Now committing it to the current branch and opening a PR.Report written to `.codekin/reports/dependencies/2026-04-21_dependency-health.md` and committed.

Key findings:

- **0 vulnerabilities** — `npm audit` is clean across all 548 packages
- **8 direct deps are behind** — `better-sqlite3` (12.8.0→12.9.0) is the only one `npm outdated` flagged; `dompurify` (3.3.3→3.4.0) is the most security-relevant gap
- **5 extraneous packages** — WASM/NAPI helpers from `better-sqlite3`'s optional native addons; harmless but noisy
- **No abandoned packages** — `refractor` had a 2-year gap before v5 (Mar 2025) but is now current
- **Top actions**: update `better-sqlite3` and `dompurify` first, then batch `npm update` for the rest, and consider adding Renovate/Dependabot for automated drift detection