# Daily Code Review: codekin

**Date**: 2026-03-30T04:05:44.908Z
**Repository**: /srv/repos/codekin
**Branch**: chore/repo-health-report-2026-03-30
**Workflow Run**: e5310aec-2408-4429-a81b-133133b5a431
**Session**: 128bcd4d-4053-47d2-8ba1-cf0161d06f5b

---

Now let me write the report file.Good — npm audit is clean. Now I have all the information needed to write the report.---

## Daily Code Review — 2026-03-30

**Overall Health: GOOD** — 1,132 tests passing, npm audit clean (the `path-to-regexp` HIGH vuln from previous reviews is resolved). No critical findings.

---

### WARNING (5 findings)

| ID | File | Finding |
|----|------|---------|
| W-01 | `server/webhook-handler.ts:169` | **Actor allowlist is case-sensitive for case-insensitive GitHub usernames.** New feature from `ab0f422`. `Array.includes()` uses strict equality — a user whose login casing differs from the allowlist entry is incorrectly blocked. Fix: `.toLowerCase()` both sides. |
| W-02 | `server/auth-routes.ts:35` | **No rate limiting on `/auth-verify`.** Allows brute-force token testing. WebSocket has per-IP limiting; REST auth endpoints don't. |
| W-03 | `src/components/ChatView.tsx:184` | **`dangerouslySetInnerHTML` without DOMPurify** *(carry-over from 2026-03-28)*. Wrap `highlightCode()` output in `DOMPurify.sanitize()`. |
| W-04 | `server/session-routes.ts:55-60` | **`workingDir` not validated against REPOS_ROOT** *(carry-over from 2026-03-28)*. `orchestrator-routes.ts:158-164` has the correct guard; mirror it here. |
| W-05 | `server/ws-server.ts:375` | **`X-Forwarded-For` trusted without proxy source validation.** Attacker can spoof IP to bypass WebSocket rate limiting. Since nginx is the only ingress, consider trusting only `req.socket.remoteAddress`. |

### INFO (4 findings)

| ID | Finding |
|----|---------|
| I-01 | Silent discard of malformed WS messages (`ws-server.ts:408`) — add debug logging. |
| I-02 | `prompt_response` `msg.value` logged without `redactSecrets()` — could expose API keys pasted into prompts. |
| I-03 | `PlanManager` state machine refactor is clean and well-tested; `onTurnEnd()` silent transition is intentional. |
| I-04 | `webhook-dedup.ts` Map eviction using `.keys().next().value` is correct (JS Maps maintain insertion order). |

### Top 3 Actionable Items

1. **Fix actor allowlist case sensitivity** — one-line fix in `webhook-handler.ts:169` + `webhook-config.ts:59`; prevents legit users from being blocked by a new feature.
2. **Add `workingDir` path guard to `POST /api/sessions/create`** — `session-routes.ts:60`, carry-over.
3. **Add DOMPurify to `ChatView.tsx:184`** — carry-over, low effort.

Report saved to `.codekin/reports/code-review/2026-03-30_code-review-daily.md`.