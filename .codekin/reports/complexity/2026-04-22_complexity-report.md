# Complexity Report: codekin

**Date**: 2026-04-22T04:35:07.247Z
**Repository**: /srv/repos/codekin
**Branch**: docs/audit-reports-2026-04-18
**Workflow Run**: 8d7cb06a-31df-47b6-a2de-fd5820cff260
**Session**: 5229d8b8-1b9f-4ac8-ade4-bf8c09d98f36

---

Now let me check import counts and a few more metrics for the coupling section.I have all the data I need. Now I'll write the report to the correct location.The report is written. Now let me commit it on the current branch.Report written and committed to `.codekin/reports/complexity/2026-04-22_complexity-report.md`. Here's the executive summary:

**Overall rating: High complexity**

The codebase is 34,000 lines across ~60 production files. 33 files exceed 300 lines; 9 exceed 700.

**Biggest hotspots:**
- `server/session-manager.ts` (1,594 lines) — still the coordination hub despite prior decomposition; git/worktree ops and idle-reaper logic should be extracted next
- `server/opencode-process.ts:handleSSEEvent()` (~277 lines, 12 event types, 6-level nesting) — the single most complex function; needs per-event-type handler extraction
- `src/App.tsx` (739 lines, 16 hook imports, 9 refs, 5 view branches) — frontend God component; needs view-router and session-controller splits

**Top 3 quick wins:**
1. **Small effort:** Consolidate scattered magic constants (`30_000`, `300_000`, `0.85`, etc.) into `server/constants.ts`
2. **Small effort:** Extract `TaskTracker` to eliminate duplicate task-tracking code between `claude-process.ts` and `opencode-process.ts`
3. **Small effort:** Pull `validateCallbackUrl()` out of `stepflow-handler.ts:postCallback()` so SSRF logic can be unit-tested independently