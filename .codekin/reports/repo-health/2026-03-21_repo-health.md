# Repository Health: codekin

**Date**: 2026-03-21T04:20:08.897Z
**Repository**: /srv/repos/codekin
**Branch**: chore/repo-health-report-2026-03-20
**Workflow Run**: 74ed5713-10ef-4807-a965-1c88e201f096
**Session**: 199c8398-5809-455b-9832-f63138f785ea

---

Now I have all the data needed. Let me write the report.`.codekin/reports/repo-health/2026-03-21_repo-health.md`

**Overall health: Good.** Key findings:

- **Dead code**: 1 item — `DAY_PATTERNS` exported in `src/lib/workflowHelpers.ts` but never imported anywhere.
- **TODO/FIXME**: Zero production annotations. The only keyword matches in the codebase are test fixture strings in `claude-process.test.ts`.
- **Config drift**: 2 minor ESLint issues — `ecmaVersion: 2020` is below the TypeScript targets (ES2022/ES2023), and the test-file block uses `globals.browser` for server-side tests. TypeScript strictness is exemplary across all three tsconfig files.
- **Licenses**: No GPL/AGPL. All MPL-2.0 packages are build-time or dual-licensed and documented in `package.json`. `busboy`/`streamsearch` are MIT but missing lock file metadata.
- **Docs drift**: `docs/API-REFERENCE.md` is missing the entire `/api/shepherd/` namespace (~20 endpoints) and several newer settings endpoints. Last updated ~2 weeks ago.
- **Stale branches**: 11 merged-but-undeleted branches ready for immediate cleanup. `feat/joe-chat-variant` is 63 commits behind main with `ChatView.tsx` and `types.ts` overlap — high merge conflict risk if revived.
- **PRs**: 0 open.
- **Release gap**: `main` is 14+ PRs ahead of `v0.4.1`, including significant features (Agent Joe, per-session tool approvals, worktrees). A `v0.5.0` release is overdue.Committed and pushed. 3 report files in one commit on `chore/repo-health-report-2026-03-20`.