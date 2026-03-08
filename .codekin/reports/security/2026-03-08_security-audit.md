# Security Audit: codekin

**Date**: 2026-03-08T15:51:34.064Z
**Repository**: /home/dev/repos/codekin
**Branch**: fix/remove-local-scripts
**Workflow Run**: d167dc3c-d4b0-4d94-b187-4147fac71c51
**Session**: 83a8d056-b820-42fb-a6e4-c875b414b504

---

Let me check a few more areas before compiling the report.Now I have all the data needed to compile the report. Let me write it.Security audit complete. Report written to `.codekin/outputs/security-audits/2026-03-08_security-audit.md`.

**Key findings:**

- **2 Critical**: Unauthenticated `/api/hook-notify` endpoint (session-routes.ts:249) and SSRF via Stepflow callback URL (stepflow-handler.ts:427)
- **5 High**: Permissive CORS default `*`, auth bypass when no token configured, auth token in URL query strings, unvalidated git clone URLs, localStorage token storage
- **5 Medium**: Missing security headers, path traversal in workflow loader, file upload auth race, unvalidated cron expressions, unvalidated webhook branch names
- **0 Secrets found**: No hardcoded credentials or committed secret files

The highest-priority fix is adding auth to `/api/hook-notify` — a one-line change that closes the only unprotected mutation endpoint.