# Daily Code Review: codekin

**Date**: 2026-04-09T04:03:57.076Z
**Repository**: /srv/repos/codekin
**Branch**: chore/add-reports-2026-04-09
**Workflow Run**: 42d25f40-38df-43e3-b819-2fa8625d6a66
**Session**: 35a72fdc-0b7d-4e23-a0fc-f494eb2056a3

---

Good findings from the exploration. Let me verify a few key details before writing the report.The security audit report already exists as an untracked file. Let me verify the key findings before presenting the final review.Good — L4 is already handled: session lifecycle passes `CODEKIN_AUTH_TOKEN` (a HMAC-derived session token), not the master `AUTH_TOKEN`. Let me check report locations.Let me check whether the master AUTH_TOKEN flows into Claude child processes.Confirmed — `AUTH_TOKEN` (master) is passed through `process.env` spread since it's not in `API_KEY_VARS`. L4 is a **valid, unresolved finding**. Now I'll write the report.Here's the daily code review summary:

---

## Daily Code Review — 2026-04-09

**Overall: GOOD.** No critical issues. Two actionable warnings identified.

### WARNING (2)

**W-1 — XSS surface inconsistency** (`src/components/ChatView.tsx:184`)
`highlightCode()` output goes directly into `dangerouslySetInnerHTML` without `DOMPurify.sanitize()`. `MarkdownRenderer.tsx` does this correctly. A supply-chain compromise of `highlight.js` would deliver stored XSS via code blocks. **Fix:** wrap the call: `DOMPurify.sanitize(highlightCode(codeString, match[1]))`.

**W-2 — Master `AUTH_TOKEN` in Claude child process env** (`server/claude-process.ts:180-189`)
`process.env` is spread with only API key vars filtered. `AUTH_TOKEN` (the master server secret) is not excluded and flows into every spawned Claude CLI process. `session-lifecycle.ts` correctly derives session-scoped `CODEKIN_AUTH_TOKEN`, but the master token still leaks in. **Fix:** add `'AUTH_TOKEN'` and `'AUTH_TOKEN_FILE'` to the `API_KEY_VARS` exclusion set.

### INFO (3)

- **I-1** `server/config.ts:30` — localhost-in-production CORS is warn-only; should be `process.exit(1)` for consistency
- **I-2** `server/webhook-handler.ts` — no timestamp window validation on webhooks (HMAC dedup is good, but replay window exists)
- **I-3** `server/ws-server.ts` — CSP has `unsafe-inline` for `style-src` (low risk, long-term cleanup)

### Positive notes
- Session restart hardening this week (worktree loop prevention, CWD validation) is solid — `4545a6d`, `5804aca`, `0e45e4f`
- GIT_* env var stripping (`01b0ea0`) correctly addresses the root cause of worktree index corruption
- 1351 tests all passing; `npm audit` shows zero vulnerabilities

Report written to `.codekin/reports/code-review/2026-04-09_code-review-daily.md`.