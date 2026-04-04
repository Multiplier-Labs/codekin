# Daily Code Review: codekin

**Date**: 2026-04-03T04:06:04.523Z
**Repository**: /srv/repos/codekin
**Branch**: chore/reports-2026-04-01
**Workflow Run**: 5976bf7f-6bb3-4282-84d0-558725d627d3
**Session**: 5c94f2a3-56bb-44df-b11f-db0865cc6e90

---

Now let me do a deeper review of the most recently changed code files.Now let me check a few more areas before writing the report.Now let me check a couple more specific issues:Now I have enough to write the full review. Let me also check one last thing about the git stash race condition:Now I have a complete picture. Let me write the report.I have enough context now. Let me write the report.Here is the **2026-04-03 Daily Code Review** summary:

---

## Overall: FAIR

**1 critical** (carry-over), **8 warnings** (6 carry-overs + 2 new), **4 info** (2 carry-overs + 2 new).

---

### CRITICAL — 1 (carry-over)

**C-01** `server/upload-routes.ts:286–290` — **Symlink bypass in `/api/clone` bounds check**
`reposRoot` is used raw while `resolvedDest` is fully `resolve()`'d. If `REPOS_ROOT` contains a symlink component the comparison silently fails. Fix: `realpathSync(resolveReposRoot())` before the check.

---

### WARNING — 6 carry-overs + 2 new

| ID | Age | Finding |
|----|-----|---------|
| W-01 | 1 week | `webhook-handler.ts:169` — actor allowlist `includes()` is case-sensitive; GitHub usernames are not |
| W-02 | 4 weeks | `auth-routes.ts:35` — `/auth-verify` has no rate limiting |
| W-03 | 5 weeks | `session-routes.ts:60` — `workingDir` from POST body passed to `sessions.create()` without `REPOS_ROOT` bounds check |
| W-04 | 4 weeks | `ws-server.ts:375` — `X-Forwarded-For` trusted unconditionally |
| W-05 | 2 days | `session-manager.ts:534–599` — `leave()`/`delete()` race condition |
| W-06 | 2 days | `ws-message-handler.ts` — `get_diff`/`discard_changes` fire async ops without `.catch()` |
| **W-07** | **New** | `workflow-loader.ts:261` — hardcoded 3-second `setTimeout` before `sendInput()`, fragile timing |
| **W-08** | **New** | `workflow-loader.ts:349–378` — `git stash` + `checkout` in `save_report` is not concurrency-safe; two simultaneous workflow runs on the same repo corrupt each other's working tree. Fix: use `git worktree add` instead. |

---

### INFO — 2 carry-overs + 2 new

| ID | Finding |
|----|---------|
| I-05 | `ccApi.ts` — `authFetch` has no request timeout |
| **I-06** | `workflow-loader.ts:433` — module-level `registeredRepoKinds` Set never cleared; renamed workflow `kind`s are silently skipped after disk update until restart |
| **I-07** | `session-manager.ts:55–58` — `API_RETRY_PATTERNS` bare `/500/`, `/502/` match content strings, not just HTTP codes |
| **I-08** | TS 6 / Vite 8 / ESLint 10 major version bumps landed this week — monitor CI for latent type regressions |

---

### Positive

- PR #265 added 3,500+ lines of test coverage across 9 critical modules — largest single coverage improvement in weeks.
- PR #267 complexity refactor landed cleanly with no regressions.
- No new security vulnerabilities introduced this week.

**W-02, W-03, W-04 are now 4–5 weeks old with no fix.** They should be assigned to a milestone before the next minor release.

Report saved to `.codekin/reports/code-review/2026-04-03_code-review-daily.md`.