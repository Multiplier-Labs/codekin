# Complexity Report: codekin

**Date**: 2026-04-15T04:33:37.551Z
**Repository**: /srv/repos/codekin
**Branch**: feat/repo-health-2026-04-15
**Workflow Run**: 95cc04f7-9fe3-4836-8247-06302d3e05fc
**Session**: 57b6d285-79ee-499c-98dd-15387e72ae53

---

Now I have enough data to write the report.Now I have enough data to write the report. Let me compose it:The report has been written to `.codekin/reports/complexity/2026-04-15_complexity-analysis.md`.

Here's a brief summary of the findings:

**Overall rating: Medium-High complexity**

- **~56,700 lines** across ~765 source files (excluding tests and worktrees)
- **15 files over 600 lines**, with `session-manager.ts` (1,594 lines) as the largest

**Top complexity hotspots:**
1. `opencode-process.ts:handleSSEEvent` — 280-line switch/case with 6 nesting levels
2. `opencode-process.ts:subscribeToEvents` — triply-duplicated backoff logic, deep async nesting
3. `App.tsx` — 20+ useState/useEffect hooks, multiple unrelated concerns in one component
4. `session-manager.ts:constructor` — 20 inline callback closures, `const self = this` alias

**Key structural issues:**
- Module-level singleton `serverState` in `opencode-process.ts` (untestable, hidden global)
- `orchestrator-routes.ts` handles 10+ unrelated concerns in one 706-line router
- `ws-server.ts` is the entry point *and* god module (34 imports, no testable factory)
- 3× duplicated idle-completion logic in `opencode-process.ts`

**Highest-ROI refactors (small effort):** extract `OrchestratorLearning` facade, deduplicate backoff in `subscribeToEvents`, collapse the triple `session.idle` duplication, and split `App.tsx` useEffect concerns into hooks.