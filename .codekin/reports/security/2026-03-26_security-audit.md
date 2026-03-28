# Security Audit: codekin

**Date**: 2026-03-26T04:36:41.840Z
**Repository**: /srv/repos/codekin
**Branch**: chore/repo-health-report-2026-03-26
**Workflow Run**: 644ab334-87bf-4841-a69e-3e808c9192a9
**Session**: 0071c6e1-b3f1-4bb1-a2e2-3028ddfec957

---

## Summary

**Overall Risk Rating: Low–Medium — 0 Critical, 0 High, 3 Medium, 4 Low**

The security audit is complete. The report has been written to `.codekin/reports/repo-health/2026-03-26_repo-health.md` (appended to the existing daily health report).

**Key findings:**

| # | Severity | Issue |
|---|----------|-------|
| M1 | Medium | Missing auth token is warn-only (not fatal) — unauthenticated API exposure risk in misconfigured prod deployments |
| M2 | Medium | Stepflow webhook enabled without secret is non-fatal (inconsistent with GitHub webhook which exits) |
| M3 | Medium | Tool input/output logged to stdout without `NODE_ENV` gating — user data in production logs |
| L1 | Low | `workingDir` in session creation not validated against allowed repo roots |
| L2 | Low | Auth token accepted via query param and request body (log exposure risk) |
| L3 | Low | CSP permits `style-src 'unsafe-inline'` |
| L4 | Low | Git hook config stores master auth token instead of a hook-scoped token |

**No hardcoded secrets or committed credentials were found.** The codebase has strong fundamentals: no shell injection surface (all `execFile` with array args), timing-safe HMAC comparisons, session-scoped child process tokens, consistent path traversal defenses with `realpathSync`, webhook replay protection, and SSRF allowlisting in the Stepflow handler.