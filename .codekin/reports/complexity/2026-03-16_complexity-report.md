# Complexity Report: codekin

**Date**: 2026-03-16T15:39:14.373Z
**Repository**: /srv/repos/codekin
**Branch**: feat/permission-mode-selector
**Workflow Run**: 2c0203fd-c6a9-4c21-a4b4-aef054d96429
**Session**: e373b1ac-8641-42d0-a459-bc5cb9ced365

---

Now I have enough data to produce the report. Let me check a couple more files quickly.Now I have sufficient data for a thorough report.Now I have everything needed for a comprehensive report. Let me write it.## Summary

**Overall Complexity Rating: Medium**

The Codekin codebase (~18,000 non-test source lines) is reasonably well-structured with clear module boundaries. The main risk concentrations are:

- `server/session-manager.ts` (1,710 lines) — god-object covering session CRUD, git-diff, WebSocket broadcasting, approval dispatch, and restart logic
- `src/App.tsx` (647 lines) — orchestration root with 34 React hook calls, 12 `useEffect`s, and three layout variants inline
- `src/components/InputBar.tsx` (578 lines) — desktop and mobile permission/model menus duplicated (~200 lines of near-identical JSX)
- `src/hooks/useChatSocket.ts` (534 lines) — a 150-line `handleMessage` callback with a 30-case switch doing inline state mutations

**10 refactoring candidates** are identified in the report, ordered by impact:

1. Extract `DiffManager` from `SessionManager` (git ops) — **Medium effort**
2. Break `App.tsx` into `ChatLayout`/`DocsBrowserLayout` sub-components — **Medium effort**
3. Deduplicate `InputBar` mobile/desktop menus — **Small effort**
4. Replace `useChatSocket.handleMessage` switch with a handler map — **Medium effort**
5. Pre-index cross-repo approval lookups (O(1) vs O(R×C)) — **Small–Medium effort**
6. Extract `SessionRestartScheduler` from `handleClaudeExit` — **Medium effort**
7. Move `ws-server.ts` auth helpers to `server/auth.ts` — **Small effort**
8. Split `workflow-engine.ts` types and cron utilities — **Small effort**
9. Extract `approval-config.ts` prefix sets — **Small effort**
10. Remove `SessionManager` approval-delegation boilerplate — **Small effort**

Full report saved to `.codekin/reports/complexity/2026-03-16.md`.