# Daily Code Review: codekin

**Date**: 2026-03-16T05:04:30.968Z
**Repository**: /srv/repos/codekin
**Branch**: fix/docs-audit-cleanup
**Workflow Run**: 4a3207b0-357c-4073-b37e-cecd62b25ee7
**Session**: 5af55d37-1a7a-4085-9500-c889129e20b8

---

Now let me do a deeper review of the critical server-side files.Now let me check the existing report format before writing the output.Now I'll write the daily code review report.---

## Daily Code Review — 2026-03-16

Report saved to `.codekin/reports/code-review/2026-03-16_code-review-daily.md`.

---

### Critical (2)

**C1 — UTF-8 multibyte truncation bug** `server/diff-parser.ts:33-36`
The 2 MB diff cap slices raw bytes with `buf.subarray(0, maxBytes).toString('utf-8')`. A multibyte character (emoji, CJK, etc.) straddling the byte boundary produces U+FFFD or silently corrupts downstream diff parsing. Fix by walking back to the last valid UTF-8 code-point boundary before slicing.

**C2 — Path separator edge case in discardChanges()** `server/session-manager.ts:1413-1424`
`root = path.resolve(cwd) + path.sep` — if `cwd` already has a trailing slash, `root` becomes double-slashed and the `startsWith` guard can produce false positives (valid paths rejected) or false negatives (out-of-tree paths accepted). Normalize with `path.join(path.resolve(cwd), '/')`.

---

### Warning (7)

| # | File | Issue |
|---|------|-------|
| W1 | `server/approval-manager.ts:222,461` | Shell metachar denylist missing `*`, `?`, `[`, `]`, `~` — `cat *` stores a pattern that matches more than intended; switch to an allowlist |
| W2 | `server/session-routes.ts:183-185` | `browse-dirs` still accepts arbitrary absolute paths (no `BROWSE_ROOT` cap) — flagged 2026-03-15, unresolved |
| W3 | `server/claude-process.ts:243,349-355` | `ExitPlanMode` ID comparison uses mismatched ID types; `inPlanningMode` flag may never clear, sending `planning_mode: true` on every subsequent turn |
| W4 | `server/session-manager.ts:1282-1287` | `findSessionForClient()` is O(n) over all sessions on every inbound WS message; add a reverse `Map<WebSocket, sessionId>` |
| W5 | `server/session-manager.ts:1268-1279` | `broadcast()` calls `JSON.stringify()` once per client; serialize once before the loop |
| W6 | `server/upload-routes.ts:276-281` | Repo name regex `/^[\w][\w.-]*$/` allows `.git` directory names; tighten to deny leading dots and the literal `git` |
| W7 | `src/hooks/useChatSocket.ts:291-305` | Approval prompts for non-active sessions are silently dropped; background sessions time out without the user ever seeing the prompt |

---

### Info (7)

- **I1** — `diff-parser.ts` has 0.91% test coverage; UTF-8, binary, rename, and hunk logic all untested
- **I2** — `commit-event-handler.ts` (134 LOC) and `approval-manager.ts` (484 LOC) have zero tests; both changed recently
- **I3** — `session-routes.ts`, `ws-server.ts`, `auth-routes.ts`, `upload-routes.ts` all zero test coverage (entire HTTP+WS layer)
- **I4** — `session-manager.ts` branch coverage 57%; gaps in timeout/stall/auto-restart paths
- **I5** — `ccApi.ts` auth detection matches on `res.url.includes('/authelia')` — brittle; prefer HTTP status only
- **I6** — `package-lock.json` still at `0.3.7` vs `package.json` `0.4.0` (flagged yesterday, unresolved — run `npm install`)
- **I7** — `slashCommands.ts:95` loads full SKILL.md content for every command at startup; could lazy-load on first useCommitted and pushed to `fix/docs-audit-cleanup`.