# Security Audit: codekin

**Date**: 2026-04-23T03:35:17.549Z
**Repository**: /srv/repos/codekin
**Branch**: docs/audit-reports-2026-04-18
**Workflow Run**: 6f9ad788-efab-48ab-9547-edc427fd50c6
**Session**: 5a5eca66-c407-4c89-8542-83ca90f99f73

---

I'll run the security audit now, gathering data across all scan areas in parallel.I now have enough data to write the full report. Let me compile the findings.The security audit report has been written to `.codekin/reports/security/2026-04-23_security-audit.md`.

**Summary of findings:**

- **0 Critical**, **2 High**, **5 Medium**, **3 Low** — overall rating **Medium**
- No hardcoded secrets or committed credentials anywhere in the source or git history
- Strong baseline: timing-safe token comparison, HMAC webhook verification, `realpathSync` boundary checks on all filesystem endpoints, DOMPurify XSS protection, per-IP rate limiting throughout

**Top issues:**

| # | Severity | Finding |
|---|----------|---------|
| H1 | High | `PUT /api/settings/repos-path` accepts arbitrary host paths — no boundary enforcement unlike all other filesystem endpoints |
| H2 | High | CSP `connect-src: wss: ws:` allows WebSocket connections to any host |
| M1 | Medium | `style-src 'unsafe-inline'` weakens CSS injection protection |
| M2 | Medium | Stepflow SSRF callback guard checks literal hostname string but does not resolve DNS — DNS rebinding bypass possible |
| M3 | Medium | nginx example config omits all security headers |
| M4 | Medium | `img-src: https:` allows image exfiltration from any HTTPS origin |
| M5 | Medium | No rate limit on orchestrator child session spawn endpoint |