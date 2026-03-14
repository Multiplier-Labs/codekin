# Daily Code Review: codekin

**Date**: 2026-03-14T05:04:53.184Z
**Repository**: /srv/repos/codekin
**Branch**: chore/repo-health-report-2026-03-14
**Workflow Run**: 5bdbf4e0-5ba1-49b8-9893-5d5bbffe0f54
**Session**: d48f6554-bfac-43e9-aa03-584a5bffcbd7

---

Now let me deep-dive into the most critical recently-changed files.I now have enough information to write the full review. Let me generate the report.Here's the review summary:

---

## Daily Code Review — 2026-03-14

**Commits reviewed**: 20 commits over 7 days. Heavy activity on the approval system, security fixes, and a new repos-path setting feature.

---

### 🔴 CRITICAL (1)

**CSP `font-src 'self'` blocks Google Fonts in production**
`server/ws-server.ts:241` + `src/index.css:1`

The server's Content-Security-Policy only allows `font-src 'self'`, but `src/index.css` loads fonts from `fonts.googleapis.com`/`fonts.gstatic.com`. In production (when the server serves the built frontend), fonts are silently blocked and fall back to system defaults. Fix: add `fonts.gstatic.com` to `font-src` and `fonts.googleapis.com` to `style-src`, or self-host the fonts.

---

### 🟡 WARNING (4)

1. **`headSha` not validated as hex SHA** — `webhook-workspace.ts:135` passes the value directly to `git reset --hard` without verifying it's a 40-char hex string. A caller with the HMAC secret could pass `-1` or `HEAD~5`, which git would interpret as flags/refs. Fix: validate `/^[0-9a-f]{40}$/i` before use.

2. **`repos_path` setting accepts any string** — `session-routes.ts:153` stores the user-supplied path without validation and it's used as the filesystem root for repo listing and cloning. An authenticated user could set it to `/` or `/etc`. Fix: add basic path sanity checks.

3. **Silent error swallowing in `RepoSelector.tsx:44`** — `.catch(() => {})` gives the user no feedback when saving the repos path fails. `Settings.tsx` handles this correctly with an error message. Fix: add error state matching the Settings.tsx pattern.

4. **REST API routes have 0% test coverage** — `auth-routes.ts`, `session-routes.ts`, `upload-routes.ts`, `webhook-routes.ts`, `docs-routes.ts`, `workflow-routes.ts` are all untested at the HTTP level. The 84% coverage figure comes from the business-logic layer only.

---

### 🔵 INFO (4)

1. **SSRF hostname check doesn't resolve DNS** — `stepflow-handler.ts:406-439` checks literal IP patterns but a hostname that resolves to a private IP would pass. The `allowedCallbackHosts` allowlist is the primary guard and limits real risk.

2. **`SessionListPanel.tsx` is an empty file** — dead code, should be deleted.

3. **`CROSS_REPO_THRESHOLD = 2` is hardcoded** — `approval-manager.ts:21`. Works for solo use but could be too permissive on a shared server. Consider an env var.

4. **Multer MIME type is client-controlled** — `upload-routes.ts:176`. Extension check is the real guard; the MIME check provides no additional security.

---

Full report saved to `.codekin/reports/code-review/2026-03-14_code-review-daily.md`.