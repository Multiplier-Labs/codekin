# Daily Code Review: codekin

**Date**: 2026-04-13T04:02:16.616Z
**Repository**: /srv/repos/codekin
**Branch**: feat/test-coverage-2026-04-13
**Workflow Run**: 19566ea4-1f3c-4c23-b2a7-99726ba81c38
**Session**: 3b6b3882-25c4-4576-852f-e764bc8169aa

---

Completed. I reviewed the structure, last 7 days of history, and critical runtime files, and saved the full report here:

```text
.codekin/reports/code-review/2026-04-13_code-review-daily.md
```

### 1) Project structure & architecture (quick assessment)
- **Frontend:** React + Vite (`src/`)
- **Backend:** Express + WebSocket (`server/`)
- **Session core:** `server/session-manager.ts` + `server/session-lifecycle.ts`
- **Provider abstraction:** Claude/OpenCode via coding-process layer
- **Transport/UI state:** `src/hooks/useChatSocket.ts`
- Overall architecture is sound, but complexity is concentrated in very large files:
  - `server/session-manager.ts` (~1591 LOC)
  - `server/opencode-process.ts` (~982 LOC)
  - `server/ws-server.ts` (~662 LOC)

### 2) Last 7 days git log (themes)
Recent commits heavily focused on:
- **Security hardening** (path traversal, ws origin/CSP/rate limits)
- **Session reliability** (restart races, startup deadlocks, state persistence)
- **OpenCode integration quality** (model/session handling, streaming fixes)
- **Workflow/webhook features** (GitHub webhook setup + PR review flow)
- **Test/report automation** (new tests + recurring reports)

### 3) Findings by severity

## Critical
- **None found** in this pass.

## Warning

1. **Potential memory amplification in API limiter map**
   - **File:** `server/ws-server.ts`
   - **Lines:** 268–279, 281–294
   - `apiRateBuckets` has cleanup but no hard max size (unlike WS limiter map). High-cardinality IP churn can grow memory.
   - **Action:** Add max-cap + eviction/deny strategy.

2. **Large synchronous attachment reads can block event loop / spike memory**
   - **File:** `server/opencode-process.ts`
   - **Lines:** 885, 889, 891–892
   - `readFileSync` is used for full image/text attachment payloads without explicit size cap in this layer.
   - **Action:** enforce per-file size limits and reject oversized files early.

3. **Weak request-body typing/validation at route boundaries**
   - **File:** `server/session-routes.ts`
   - **Lines:** 79, 97–101, 358, 382, 439, 471 (and others)
   - Extensive unsafe `req.body` usage; lint flags many `no-unsafe-*` issues.
   - **Action:** add schema validation (zod/valibot) for all request payloads.

4. **Synchronous recursive docs scan in request path**
   - **File:** `server/docs-routes.ts`
   - **Lines:** 41–73, 93–140
   - Sync FS traversal can cause latency spikes on large repos.
   - **Action:** add caching and traversal limits / async scan.

5. **Coverage gap in critical route modules**
   - No direct tests found for:
     - `server/ws-server.ts`
     - `server/session-routes.ts`
     - `server/docs-routes.ts`
   - **Action:** add focused auth/path/rate-limit tests for these endpoints.

## Info

1. **Quality debt from lint warnings in backend**
   - `npm run lint` passes but with many warnings in core server files, especially unsafe assignments/arguments.
   - High-signal files: `server/session-routes.ts`, `server/orchestrator-routes.ts`, `server/opencode-process.ts`, `server/claude-process.ts`.

2. **Dependency freshness**
   - `npm audit --omit=dev`: **0 vulnerabilities** (root + server)
   - `npm outdated`:
     - Root: `better-sqlite3` behind latest
     - Server: `better-sqlite3`, `ws` behind latest
   - **Action:** patch-update with regression run.

3. **Test status**
   - `npm test`: **59 files, 1600 tests, all passing**

If you want, I can next produce a prioritized fix plan (top 3 changes with estimated effort/risk).