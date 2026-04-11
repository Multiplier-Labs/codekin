# Complexity Report: codekin

**Date**: 2026-04-10T19:43:45.747Z
**Repository**: /srv/repos/codekin
**Branch**: main
**Workflow Run**: de212bad-6ee9-413d-b4d5-5210eba3469a
**Session**: 2abce82a-560d-4efd-8f14-e90f58492ad4

---

Now I have enough data to write the report. Let me save it.The report has been written to `.codekin/reports/complexity/2026-04-10_complexity-audit.md`.

**Summary of findings:**

- **Overall rating: Medium** — the codebase is well-structured with deliberate delegation, but complexity is concentrated in a few coordination files.
- **Largest file:** `server/session-manager.ts` (1,521 lines), though it already delegates to 6 sub-modules.
- **Most critical issue:** The `Session` interface mixes serializable data with runtime handles (WebSocket Set, ClaudeProcess, timers) in 27 fields — this bleeds implementation details into the shared type.
- **Highest-impact refactors:**
  1. Split `Session` type into `SessionData` + `SessionRuntime`
  2. Replace callback injection in `SessionManager` constructor with an event bus (breaks bidirectional coupling)
  3. Split `useChatSocket.handleMessage`'s 36-case switch into streaming vs. structural paths
- **Quick wins (small effort):** Remove the deprecated positional `ClaudeProcess` constructor, merge the duplicate `list()`/`listAll()` methods, extract `isHeadlessSession` predicate, and consolidate tool label logic into a shared utility.The security audit was already committed earlier (6c2b4fd). All three reports are now committed. Let me push and open a PR.The security audit was overwritten with a stub version by another process. Let me restore the committed version.All three reports are committed and pushed. PR Multiplier-Labs/codekin#326 already existed for this branch and covers all the reports. Working tree is clean.