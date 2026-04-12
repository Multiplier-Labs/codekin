# Daily Code Review: codekin

**Date**: 2026-04-12T04:04:35.635Z
**Repository**: /srv/repos/codekin
**Branch**: fix/vitest-node-env-test
**Workflow Run**: e51e3c7f-2b8b-45e3-89fd-6c1eaacb6361
**Session**: 312e62c3-6b44-429a-9406-fadfe517521f

---

Now I have enough to write the review. Let me check one more thing quickly:Now I have everything needed. Let me write the report:Report written and committed to `.codekin/reports/code-review/2026-04-12_code-review-daily.md`. Here's the summary:

---

## Daily Code Review — 2026-04-12

**84 commits reviewed** over the past 7 days. The week was dominated by OpenCode provider integration, security hardening (symlink traversal, CSP, auth), and model picker UX. **No critical issues found.**

### Warnings (4)

| # | Where | Issue |
|---|-------|-------|
| **W1** | `server/session-manager.ts:66-70` | `API_RETRY_PATTERNS` uses bare `/500/`, `/502/`, `/503/` — matches any string containing those digits (e.g. `"port 5000"`, `"1500 lines"`). Adds spurious retries. Fix: use `\b500\b` etc. |
| **W2** | `src/components/InputBar.tsx:148-151` | Model dropdown search query not cleared on close. Reopening shows stale search text. Fix: reset `query` when `isOpen` transitions to false. |
| **W3** | `src/components/InputBar.tsx:172-247` | `visibleList` for keyboard nav includes recent models *and* all models (duplicates). Models in "Recent" also appear in "All Models", creating dead keyboard navigation positions. Fix: filter recents out of the "All Models" section. |
| **W4** | `server/upload-routes.ts:296` | `realpathSync(resolveReposRoot())` throws `ENOENT` on a fresh install if the repos root dir doesn't exist yet. Fix: wrap in try/catch. |

### Info (6)

- **I1** `RECENTS_KEY` string constant defined inside `ModelDropdown` — recreated every render; move to module scope
- **I2** `getRecents()` reads `localStorage` on every render — memoize
- **I3** `localStorage.setItem` calls (height resize, model recents) lack `QuotaExceededError` guards
- **I4** Vitest `node` environment for React hook tests needs a comment explaining why jsdom isn't required
- **I5** `NEVER_AUTO_APPROVE_TOOLS` is empty — worth documenting which tools rely on `PlanManager` gating instead
- **I6** `MAX_HISTORY = 2000` is count-based; large messages (image data, big tool results) could create memory pressure in multi-session deployments