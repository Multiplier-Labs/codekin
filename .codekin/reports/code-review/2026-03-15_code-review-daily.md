# Daily Code Review: codekin

**Date**: 2026-03-15T05:04:10.128Z
**Repository**: /srv/repos/codekin
**Branch**: fix/docs-audit-cleanup
**Workflow Run**: 4cfa3af9-91e2-4f61-abdb-1978277bbc81
**Session**: e2fb4534-339a-4f7e-a6e1-6902e6873082

---

Now let me look at the files changed in recent commits more closely, particularly the recent bug fixes and new features.Now I have enough to write a comprehensive review. Let me also write the report to the reports directory.Here's the daily code review for **2026-03-15**:

---

## Critical — None

---

## Warnings (3)

**W1 — Stepflow missing-secret doesn't exit (`server/ws-server.ts:157-158`)**
GitHub webhook guard calls `process.exit(1)` when the secret is missing; Stepflow only logs a warning and continues. This means a misconfigured Stepflow deployment accepts unsigned payloads instead of refusing to start. Should mirror the GitHub guard.

**W2 — `browse-dirs` exposes full filesystem to any auth'd user (`server/session-routes.ts:179-200`)**
`GET /api/browse-dirs?path=...` accepts any absolute path — `/etc`, `/root`, etc. Only directory names (not file contents) are returned, and auth is required, but a leaked token gives full directory tree enumeration. Consider adding a `BROWSE_ROOT` env var defaulting to `$HOME` and rejecting paths outside it.

**W3 — `package-lock.json` version is `0.3.7`, `package.json` is `0.4.0`**
Causes `npm ci` warnings in CI and confuses tooling. Fix: `npm install` from repo root.

---

## Info (6)

| | |
|---|---|
| **I1** | `eslint.config.js` uses `ecmaVersion: 2020` but TypeScript targets ES2022/ES2023 — false-positive lint errors possible on newer syntax |
| **I2** | 14 `@typescript-eslint` rules still at `warn` with no promotion milestone; attach to a version target |
| **I3** | 6 merged branches safe to delete (`fix/approval-auto-approve-countdown`, `fix/approval-waiting-state`, `fix/csp-google-fonts`, `feat/docs-audit-workflow`, `feat/folder-picker-repos-path`, `chore/repo-health-action-items`) |
| **I4** | `CLAUDE.md` quick-start omits `npm install --prefix server` — new contributors will fail to start the server |
| **I5** | `docs/API-REFERENCE.md` likely missing the new `/api/settings/repos-path` and `/api/browse-dirs` endpoints added in #120/#132 |
| **I6** | `chore/repo-health-report-2026-03-14` and `codekin/reports` branches are 18 commits behind main — rebase recommended |

---

## Spot Review of Recent Changes

- **PromptButtons.tsx** (countdown fix, #138): Correct use of ref to avoid stale closure in `setInterval`. No issues.
- **FolderPicker.tsx** (#132): Path construction, outside-click detection, and double-save guard all look correct. No issues.
- **useChatSocket.ts** (waiting state fix, #136): Safety-net `useEffect` and `sessions_updated` pruning logic are correct. No issues.
- **session-routes.ts browse-dirs**: Functionally correct (hidden dirs filtered, errors caught); scope concern covered in W2.

Report saved to `.codekin/reports/code-review/2026-03-15_code-review-daily.md`.