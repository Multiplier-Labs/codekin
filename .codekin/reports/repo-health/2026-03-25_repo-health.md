# Repository Health: codekin

**Date**: 2026-03-25T04:23:07.137Z
**Repository**: /srv/repos/codekin
**Branch**: main
**Workflow Run**: 5d7aad9a-ba01-4f7b-b7d3-8738e19f5e52
**Session**: 1b7e0cdc-e1c3-440a-9253-9f041156f07f

---

Now let me check the server files and look for dead code patterns:Now I have all the data needed. Let me write the report:Now I have all the data needed. Let me write the report:The report has been written to `.codekin/reports/docs-audit/2026-03-25_docs-audit.md`.

---

# Repository Health Report — 2026-03-25

## Summary

**Overall Health: Good**

| Metric | Count |
|---|---|
| Dead code items | 3 |
| TODO/FIXME comments | 0 |
| Config issues | 2 (minor) |
| License concerns | 2 (UNKNOWN label, benign) |
| Doc drift items | 1 (`docs/API-REFERENCE.md`) |
| Merged branches pending deletion | 29 |
| Squash-merged orphan branches | ~24 |
| Open PRs | 0 |
| Stuck PRs | 0 |

---

## Dead Code

3 items found — all are exported symbols used only within their own file:

- `server/commit-event-hooks.ts` — `HookConfig` interface, `installCommitHook`, `uninstallCommitHook` (called only by `syncCommitHooks` in the same file)
- `server/orchestrator-learning.ts` — `findDuplicate` (called only by `smartUpsert` in the same file)

**No orphan files.** All source files are reachable from an entry point.

---

## TODO/FIXME Tracker

**Zero** TODO/FIXME/HACK/XXX/WORKAROUND comments found in any source file. The only hits are test strings that use the word "TODO" as a search pattern argument.

---

## Config Drift

- All tsconfigs have `strict: true`, `noUnusedLocals`, `noUnusedParameters` — well-configured.
- **Finding 1:** `tsconfig.app.json` targets `ES2022` vs `tsconfig.node.json`'s `ES2023` — minor skew, should be explained or aligned.
- **Finding 2:** 10 ESLint type-safety rules are intentionally demoted to `warn` (documented in the config). Should be promoted to `error` incrementally.
- `noPropertyAccessFromIndexSignature` is not set in any tsconfig — minor gap.
- Prettier config is clean.

---

## License Compliance

No GPL/AGPL/LGPL dependencies. 524 MIT deps dominate. Two packages (`busboy`, `streamsearch`) show `UNKNOWN` in the lock file but are known permissive transitive deps of `multer`. MPL-2.0 usage is documented in `package.json`'s `licenseNotes`.

---

## Documentation Freshness

- **`docs/API-REFERENCE.md` is stale** — last updated 2026-03-16; 13 server route commits since then. Missing: session lifecycle hook endpoints (#235), orchestrator approval endpoints, AskUserQuestion routing changes.
- `docs/ORCHESTRATOR-SPEC.md` and `docs/stream-json-protocol.md` are current (updated within the last 3 days).
- **README has no drift** — all scripts, paths, and config references match current `package.json` and project structure.

---

## Draft Changelog (since v0.5.0)

**Features:** Session lifecycle hooks and orchestrator approval endpoints (#235)

**Fixes (18):** Orchestrator listener leak (#253), stall warning behavior (#252, #256), ExitPlanMode double-approval/timeout bugs (#245, #244, #255), orchestrator empty state layout (#254), suppress chat noise (#251), save exact commands for non-patternable tools (#246), double-gating race condition (#241), child session completion race (#240), prompt listener wiring (#238), path guard hardening (#237), system prompt concurrent limit (#236), UI polish (#243, #247, #248, #249), and others.

**Tests:** Coverage gaps from March 16 audit (#233)

---

## Stale Branches

- **29 confirmed merged** (by `git branch -r --merged origin/main`) — safe to delete immediately.
- **~24 squash-merged orphans** — content confirmed in `main` by subject-line matching; safe to delete. Git's `--merged` check doesn't catch squash merges.
- **4 to review before deleting:** `feat/joe-chat-variant` (1 commit, open since 2026-03-17), `feat/session-lifecycle-hooks` (2 commits, recent), `chore/repo-health-report-2026-03-14` (webhook-generated), `codekin/reports` (32 unique commits — intentional dedicated branch?).

---

## PR Hygiene

No open PRs. All work is merged.

---

## Merge Conflict Forecast

No high-risk branches. `feat/joe-chat-variant` (1 commit) has potential overlap with heavily-modified `ChatView.tsx`/`OrchestratorView.tsx` but is low-risk overall.

---

## Top Recommendations

1. **Delete 29 confirmed-merged branches** — consider enabling GitHub's auto-delete-on-merge setting.
2. **Add a squash-merge orphan cleanup workflow** — weekly `git push --delete` for branches whose tip commit subject matches a commit on `main`.
3. **Update `docs/API-REFERENCE.md`** — document lifecycle hook and orchestrator approval endpoints from #235.
4. **Close or PR `feat/joe-chat-variant`** — open 8 days with no PR.
5. **Clarify `codekin/reports` branch** — 32 commits not in `main`; document or consolidate.
6. **Remove `export` from 3 internal symbols** — `HookConfig`, `installCommitHook`, `uninstallCommitHook`, `findDuplicate`.
7. **Promote 10 ESLint `warn` rules to `error`** incrementally — start with `no-non-null-assertion`.
8. **Document `busboy`/`streamsearch` in `licenseNotes`** — prevents false positives in compliance tools.
9. **Enable `noPropertyAccessFromIndexSignature`** in all tsconfigs.
10. **Align or document TypeScript `target` version skew** (`ES2022` vs `ES2023`).Committed and pushed to `chore/repo-health-report-2026-03-25`.