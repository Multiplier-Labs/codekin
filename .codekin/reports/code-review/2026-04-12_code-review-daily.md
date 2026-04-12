# Daily Code Review: codekin

**Date**: 2026-04-12T17:35:01.920Z
**Repository**: /srv/repos/codekin
**Branch**: main
**Workflow Run**: 599313d4-879e-46ad-8578-67580b85fd50
**Session**: 24e0c463-2133-45ff-9dde-b6a4c4a68877

---

Completed. I reviewed structure, recent commits, critical server/frontend paths, and ran validation checks (`npm test`, `npm run lint`, `npm run build`, `npm audit --omit=dev`).

I also saved the full report to:

```text
.codekin/reports/code-review/2026-04-12_code-review-daily.md
```

## Critical
- **None found** in this pass.

## Warning

1. **Missing boundary validation for OpenCode model probe endpoint**
   - **File**: `server/session-routes.ts:53-58`
   - `/api/opencode/models` accepts `workingDir` and passes it to `fetchOpenCodeModels()` without the allowed-root realpath checks used in session creation.
   - **Action**: Apply same guard pattern as `/api/sessions/create` and WS `create_session` (realpath + allowed roots).

2. **Proxy/IP handling inconsistency in rate limiting**
   - **Files**:
     - `server/config.ts:95` (`TRUST_PROXY` exists)
     - `server/ws-server.ts:275-277` (API limiter uses `req.ip`)
     - `server/auth-routes.ts:27` (auth limiter uses `req.ip`)
   - WS path has proxy-aware handling; REST rate limiters do not configure Express `trust proxy`.
   - **Action**: Set `app.set('trust proxy', TRUST_PROXY)` and centralize IP extraction for all limiters.

3. **Unrestricted image sources in assistant markdown rendering**
   - **File**: `src/components/ChatView.tsx:215-223`
   - Custom `img` renderer forwards arbitrary `src` from model output.
   - **Risk**: Browser-side privacy leakage/tracking beacons.
   - **Action**: Enforce protocol/host allowlist (similar to link safety logic).

4. **Frontend bundle size warning (performance debt)**
   - **Evidence**: `npm run build` reports main chunk ~`831.65 kB` (minified), warning threshold exceeded.
   - **Action**: Add code splitting/lazy loading for heavier views.

5. **Test gaps in critical route glue files**
   - No direct tests found for:
     - `server/ws-server.ts`
     - `server/session-routes.ts`
     - `server/upload-routes.ts`
     - `server/docs-routes.ts`
   - **Action**: Add integration tests around auth, boundary checks, and error responses.

## Info

1. **Recent 7-day git trend**
   - Heavy churn in `session-lifecycle`, `opencode-process`, `session-manager`, and chat socket handling.
   - Security hardening and webhook/workflow expansion are active.
   - This area is improving, but still highest regression risk zone.

2. **Quality consistency**
   - `npm run lint` passes but with many warnings (notably unsafe `any` and null assertions) concentrated in backend request/process paths.
   - **Action**: prioritize warning cleanup in `orchestrator-routes`, `session-routes`, `claude-process`, `opencode-process`.

3. **Dependency/security posture**
   - `npm audit --omit=dev`: **0 prod vulnerabilities**.
   - Tests are healthy: **1600 passing**.

4. **Docs consistency gap**
   - `README.md` references OpenCode upstream differently than `server/opencode-process.ts` comments.
   - **Action**: align canonical OpenCode repo reference.