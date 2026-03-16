# Daily Code Review: codekin

**Date**: 2026-03-20T05:03:47.935Z
**Repository**: /srv/repos/codekin
**Branch**: chore/repo-health-report-2026-03-20
**Workflow Run**: a59b25a1-4a16-4a20-bc0d-a3aff7a4d3b4
**Session**: 1045ab5a-eab9-47a0-a948-ec91ee1960a1

---

Now let me read the remaining critical files:Now I have enough to write a comprehensive report. Let me also check the existing previous report to avoid re-reporting known items:Now I have a complete picture. Let me write the report:Report written to `.codekin/reports/code-review/2026-03-20_code-review-daily.md`. Here's the summary:

---

## Daily Code Review — 2026-03-20

### 🔴 Critical (2 new issues)

**1. Path traversal in `/api/shepherd/reports/read`** (`shepherd-routes.ts:116`, `shepherd-reports.ts:113`)  
The `?path=` query parameter goes directly to `readFileSync` with no containment check. Any holder of a valid auth token (including Agent Joe's session-scoped token) can read arbitrary files: `/home/dev/.codekin/sessions.json`, `/etc/passwd`, etc. Fix: require the resolved path to contain `/.codekin/reports/`.

**2. `matchesAllowedTools` prefix bypass** (`session-manager.ts:1262`, introduced in `b5f6a9f`)  
`cmd.startsWith(prefix)` has no word boundary — `Bash(curl:*)` auto-approves `curl-malicious-binary`. The existing `ApprovalManager.matchesPattern` correctly uses `cmd === prefix || cmd.startsWith(prefix + ' ')`. One-line fix.

---

### 🟡 Warning (4 issues)

**3. No `repo` path validation in shepherd child spawn** (`shepherd-routes.ts:143`) — Agent Joe can spawn a Claude session in any filesystem path.

**4. `ensureFinalStep` mutates `outputHistory` with `splice`** (`shepherd-children.ts:298`) — permanently removes a result message, breaking replay for other clients.

**5. `ShepherdChildManager.children` grows unbounded** — completed/failed entries never purged; memory leak with active Agent Joe usage.

**6. `compactExactCommands` silently escalates approval scope** (carry-over from 2026-03-17, still unaddressed).

---

### 🔵 Info (5 items)

- `cleanupWorktree` missing `cleanGitEnv()` (inconsistency with `createWorktree`)
- `copyDirRecursive` follows symlinks without validation
- No unit tests for `matchesAllowedTools` — the exact function with the critical bug above
- `dompurify` lockfile should be verified to pin `3.3.3`