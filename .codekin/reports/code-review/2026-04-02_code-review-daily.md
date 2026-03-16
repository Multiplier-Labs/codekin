# Daily Code Review: codekin

**Date**: 2026-04-02T04:05:02.678Z
**Repository**: /srv/repos/codekin
**Branch**: chore/reports-2026-04-01
**Workflow Run**: d43ebe21-be3c-4e92-8ede-29ca76f410e8
**Session**: 3217d538-d38c-4b32-a6b3-70e972bfc9d8

---

Now let me check the existing reports structure and the already-modified security audit file before writing the review.Now I have everything I need. Let me write today's code review report.Here is the **2026-04-02 Daily Code Review** summary:

---

## Overall: FAIR

**1 critical** (new), **6 warnings** (4 carry-overs + 2 new), **5 info** (4 carry-overs + 1 new).

---

### CRITICAL — 1 new

**C-01** `server/upload-routes.ts:286–293` — **Path traversal in `/api/clone`**
The `reposRoot + sep` prefix check is fragile; replace with `path.relative(reposRoot, resolvedDest).startsWith('..')` negation.

---

### WARNING — 4 carry-overs + 2 new

| ID | Status | Issue |
|----|--------|-------|
| W-01 | Carry-over (4th week) | Actor allowlist comparison is case-sensitive — `webhook-handler.ts:169` |
| W-02 | Carry-over (3rd week) | `/auth-verify` has no rate limiting — `auth-routes.ts:35` |
| W-03 | Carry-over (4th week) | `workingDir` accepted without `REPOS_ROOT` bounds check — `session-routes.ts:55–60` |
| W-04 | Carry-over (3rd week) | `X-Forwarded-For` trusted unconditionally — `ws-server.ts:375` |
| W-05 | **New** | Race condition in session lifecycle (`leave()`/`delete()`) — `session-manager.ts:534–599` |
| W-06 | **New** | Unhandled promise rejections on `get_diff` and `discard_changes` — `ws-message-handler.ts` |

**W-05** is the most architecturally significant: `leave()` captures a session reference in a timer closure while concurrent `join()` or `delete()` can mutate the session, and `delete()` vs the restart evaluator have a check-then-act race on `_stoppedByUser`. A small state machine (`ACTIVE → STOPPING → DELETED`) would fix both.

**W-03** remains the highest practical risk among carry-overs — a post-auth directory traversal that lets any valid-token holder spawn Claude in an arbitrary directory.

---

### INFO — 4 carry-overs + 1 new

**I-05** (new): `src/lib/ccApi.ts:81–88` — `authFetch` has no request timeout. All API calls can hang indefinitely. Add `AbortController` with per-call timeouts.

---

### Trend

The 4 persistent warnings have been open 3–4 weeks with no fix. They should be assigned to a milestone. Report written to `.codekin/reports/code-review/2026-04-02_code-review-daily.md`.