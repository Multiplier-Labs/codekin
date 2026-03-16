# Daily Code Review: codekin

**Date**: 2026-04-06T04:04:58.739Z
**Repository**: /srv/repos/codekin
**Branch**: chore/reports-2026-04-06
**Workflow Run**: bd26aa8b-06f7-4e2a-b987-edeb34dec444
**Session**: 25943a24-f220-491a-8976-b8bb504f6e23

---

## Code Review — 2026-04-06

**Tests**: 1,328 passing | **Lint**: 0 errors (631 pre-existing warnings)

---

### CRITICAL — Fixed

**C-01: ESLint broken by active worktrees** (`eslint.config.js:9`)

`globalIgnores` was missing `.claude/worktrees/**`. When agent worktrees are present, ESLint can't resolve `tsconfigRootDir` (multiple candidates) and throws parse errors across every file in those directories — blocking CI. Fixed by adding the glob to the ignore list.

---

### WARNINGS

| ID | Location | Issue |
|----|----------|-------|
| W-01 | `server/claude-process.ts` | Broad silent `catch { }` on JSON parse paths — hides protocol changes with no log trail |
| W-02 | `server/session-manager.ts` `getReposPath()` | Empty catch — silent path resolution failures |
| W-03 | `server/config.ts` ~line 82 | Claude binary falls back to bare PATH lookup silently; could pick wrong binary |
| W-04 | `server/session-manager.ts` (MAX_HISTORY=2000) | No `since`-timestamp option on replay — full replay to every joining client could cause latency spikes on long sessions |
| W-05 | `server/claude-process.ts` ~line 166 | `NODE_NO_WARNINGS=1` suppresses all deprecation warnings in child process |

---

### INFO

- **Bundle**: 804 KB / 239 KB gzipped — highlight.js and react-markdown are candidates for dynamic import splitting
- **Logging**: All `console.log/warn/error` — structured JSON logging (pino) worth planning for production scale
- **Rate limiter cleanup**: Runs every 5 min; shortening to 60s costs nothing and reduces DoS exposure window
- **631 lint warnings**: All pre-existing demoted patterns (tracked in eslint.config.js) — no new issues

---

### Security Posture

All surfaces confirmed clean: process spawning (API key isolation, SIGTERM→SIGKILL), WebSocket auth (timing-safe, rate-limited), webhook verification (HMAC-SHA256 + idempotency), file uploads (MIME+ext whitelist), XSS (DOMPurify), native permissions (0o600, atomic writes). No new issues found.

**Overall: A-** — one critical lint fix applied, remaining findings are low-severity improvements.