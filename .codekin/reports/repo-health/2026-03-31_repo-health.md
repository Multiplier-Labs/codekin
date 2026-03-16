# Repository Health: codekin

**Date**: 2026-03-31T03:25:23.920Z
**Repository**: /srv/repos/codekin
**Branch**: chore/repo-health-report-2026-03-30
**Workflow Run**: 89ac4df2-8cb5-43d6-86f5-5379866ea472
**Session**: 2151a517-0055-4a20-a4c3-6be08cf2d3ef

---

Now I have everything needed to produce the report. Let me write it:Report written to `.codekin/reports/repo-health/2026-03-31_repo-health.md`.

**Key findings:**

- **Dead code**: No orphan files or unreachable functions. 5 exported test-helper symbols flagged (`processMessage`, `trimMessages`, `rebuildFromHistory` in `useChatSocket.ts`; `_setGhRunner`/`_resetGhRunner` in `webhook-github.ts`) — low severity.
- **TODO/FIXME**: Zero real annotations. Three matches are test string literals, not code comments.
- **Config**: Excellent TypeScript strictness across all three tsconfig targets. Minor: ESLint `ecmaVersion: 2020` inconsistent with TS target ES2022; four `no-unsafe-*` rules set to `warn` instead of `error`.
- **License**: Clean — no GPL/AGPL. MPL-2.0 (12 packages, file-scoped copyleft, not an issue); one CC-BY-4.0 dependency worth verifying it covers data only.
- **Docs drift**: `docs/GITHUB-WEBHOOKS-SPEC.md` doesn't document the new `actorAllowlist` config field added in PR #261.
- **Stale branches**: No branches older than 30 days, but **29 merged branches** are undeleted and accumulating as noise. Five fix branches appear superseded by the PlanManager refactor.
- **PRs**: PR #259 (5 days old, no reviewer) will hit the 7-day stuck threshold on 2026-04-02.
- **Conflict risk**: Low across the board. Two feature branches (`feat/session-lifecycle-hooks`, `feat/joe-chat-variant`) diverged before the PlanManager refactor and carry medium rebase risk if still active.