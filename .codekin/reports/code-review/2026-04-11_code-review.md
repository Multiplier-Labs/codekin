# Daily Code Review — 2026-04-11

**Project:** Codekin v0.6.0  
**Branch reviewed:** `main` (HEAD ~5 commits)  
**Scope:** Full codebase with focus on changes in the last 7 days

---

## Recent Changes (Last 7 Days)

| Commit | Description |
|--------|-------------|
| `9b3073b` | chore: complexity report 2026-04-10 |
| `97ec940` | feat: add PR Review as event-driven workflow kind |
| `f7eed7f` | refactor: migrate to open-source @multiplier-labs/stepflow |
| `8307033` | chore: bump version to v0.6.0 |
| `1a9cf5d` | fix: resolve lint errors failing CI |

---

## Findings

### Critical

#### [CRITICAL-1] Path Traversal via Symlink Fallback — `server/session-routes.ts`

**Lines:** ~74–77 (session creation) and ~285–287 (browse-dirs endpoint)

When `realpathSync()` fails (e.g., on a non-existent path), the code silently falls back to `path.resolve()`, which does not dereference symlinks:

```typescript
try {
  resolvedDir = fsRealpathSync(pathResolve(workingDir))
} catch {
  resolvedDir = pathResolve(workingDir)  // symlinks NOT resolved here
}
if (!allowedRoots.some(root => resolvedDir === root || resolvedDir.startsWith(root + '/'))) {
  return res.status(403).json({ error: 'workingDir is outside allowed directories' })
}
```

A symlink inside an allowed directory pointing outside (e.g., `~/repos/allowed/escape -> /etc`) would pass the `startsWith` boundary check. The correct fix is to reject the request when `realpathSync` fails rather than falling back.

**Applies to:** both the session-creation route and the `/api/browse-dirs` endpoint.

**Recommendation:** On catch, return `403` immediately. Do not fall through to `path.resolve()`.

---

### Warnings

#### [WARN-1] Uncovered Critical-Path Modules — Test Coverage Gap

The following server-side modules have no corresponding test files:

- `server/commit-event-handler.ts`
- `server/commit-event-hooks.ts`
- `server/orchestrator-monitor.ts`
- `server/version-check.ts`

These handle commit hooks and version enforcement — high-consequence code paths. A logic error here could silently break automated workflows or version-gating.

**Recommendation:** Add unit tests for at least `commit-event-handler.ts` and `version-check.ts` as a priority.

---

#### [WARN-2] Large Monolithic Files — Maintainability Risk

| File | Lines |
|------|-------|
| `server/session-manager.ts` | ~1,570 |
| `server/webhook-handler.ts` | ~800+ |
| `server/claude-process.ts` | ~757 |
| `src/components/InputBar.tsx` | ~800+ |

While refactoring is ongoing (SessionLifecycle and PromptRouter have been extracted), these files remain difficult to test in isolation and have high cyclomatic complexity. Bugs are harder to locate and change surface area is large.

**Recommendation:** Continue incremental extraction. Prioritize `webhook-handler.ts` next — it combines GitHub event parsing, orchestration, and session management.

---

#### [WARN-3] Multer Upload Configuration Not Verified — `server/upload-routes.ts`

File upload handling uses Multer, but the configuration (file size limits, MIME type allowlist, filename sanitization) was not fully visible during review.

**Recommendation:** Verify that:
- `limits.fileSize` is set (e.g., ≤10 MB)
- Only expected MIME types are accepted
- Uploaded filenames are sanitized before use in any file system operation

---

### Info

#### [INFO-1] `CROSS_REPO_THRESHOLD` at 5 — Consider Raising

`server/approval-manager.ts` line ~21: `CROSS_REPO_THRESHOLD = 5`. After 5 repos independently approve a tool pattern, it auto-approves globally. This was recently raised from 2 to 5, which is an improvement. For higher-confidence safety, consider raising to 10 or making it configurable via environment variable.

---

#### [INFO-2] Stepflow Migration — `f7eed7f`

The migration from a proprietary stepflow to `@multiplier-labs/stepflow` (open-source) looks clean. Event-driven workflow kinds (`commit-review`, `pr-review`) are correctly registered, and cron/biweekly schedule parsing appears correct. No issues found.

---

#### [INFO-3] PR Review Workflow Addition — `97ec940`

`EVENT_DRIVEN_KINDS` now includes `pr-review`. The new kind follows the same patterns as `commit-review`. The webhook routing and deduplication logic extends cleanly. No issues found.

---

## Confirmed Secure / Previously Addressed

| Area | Status |
|------|--------|
| Token verification (timing-safe `timingSafeEqual`) | ✓ Secure |
| HMAC webhook signature verification | ✓ Secure |
| Session-scoped token derivation (`HMAC-SHA256(master, "session:" + id)`) | ✓ Secure |
| XSS protection via DOMPurify in ChatView and MarkdownRenderer | ✓ Implemented |
| Write locks for concurrent settings file access | ✓ Correct |
| Auth token fatal in non-dev environments | ✓ Fixed (`55cbfd8`) |
| headSha validated with `/^[0-9a-f]{40,64}$/` before git ops | ✓ Fixed (`55cbfd8`) |
| Corrupted settings JSON now logs a warning | ✓ Fixed (`55cbfd8`) |
| Session restart race conditions | ✓ Fixed (multiple prior PRs) |
| Output history capped (server: 2000, browser: 500) | ✓ Correct |
| npm audit | ✓ 0 vulnerabilities |

---

## Recommendations Summary

| Priority | Action |
|----------|--------|
| **Immediate** | Fix path traversal fallback in `session-routes.ts` (L74–77, L285–287) — reject on `realpathSync` failure |
| **Immediate** | Audit Multer config in `upload-routes.ts` for size limits and MIME allowlist |
| **Near-term** | Add tests for `commit-event-handler.ts` and `version-check.ts` |
| **Near-term** | Continue breaking up `webhook-handler.ts` |
| **Low** | Consider raising `CROSS_REPO_THRESHOLD` to 10 or making it env-configurable |

---

*Generated: 2026-04-11 | Codekin v0.6.0*
