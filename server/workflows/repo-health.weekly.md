---
kind: repo-health.weekly
name: Repository Health
sessionPrefix: repo-health
outputDir: .codekin/reports/repo-health
filenameSuffix: _repo-health.md
commitMessage: chore: repository health report
---
You are performing an automated repository health assessment. This is a comprehensive housekeeping, documentation, and git hygiene check. Please do the following:

## Part 1 — Maintenance & Housekeeping

1. **Dead Code Detection**
   - Find unused exports: scan for exported functions, classes, constants, and types that are never imported elsewhere in the project.
   - Identify unreachable functions: look for private/internal functions that have no callers.
   - Detect orphan files: find source files that are not imported or referenced by any other file.
   - For each finding, note the file path and export/function name, and recommend removal or flag for review.

2. **TODO/FIXME Tracker**
   - Scan the entire codebase for `TODO`, `FIXME`, `HACK`, `XXX`, and `WORKAROUND` comments.
   - For each, report: file:line, the comment text, and the author + date from `git blame`.
   - Flag stale items — any TODO/FIXME where the blamed commit is older than 30 days.
   - Summarize: total count, count by type, count of stale items.

3. **Config Drift Check**
   - Examine tsconfig.json, eslint config, and prettier config (if present).
   - Compare against modern best-practices defaults for the project's stack.
   - Flag any unusual, overly permissive, or outdated settings (e.g. missing `strict: true` in tsconfig, deprecated ESLint rules).
   - Note any inconsistencies between configs (e.g. conflicting target versions).

4. **License Compliance**
   - Audit dependency licenses using the lock file and package metadata.
   - Flag any GPL, AGPL, LGPL, or other copyleft licenses if the project itself uses a permissive license (MIT, Apache, BSD).
   - Flag any dependencies with unknown, missing, or non-standard licenses.
   - Report a summary table: license type → count of dependencies.

## Part 2 — Documentation

5. **API Docs Freshness**
   - Identify API endpoints, public types, and interfaces that serve as the project's API surface.
   - Check if corresponding documentation (README, docs/ files, JSDoc/TSDoc comments) appears stale relative to recent code changes.
   - Flag any endpoints or types that changed in the last 30 days but whose docs were not updated.

6. **README Drift**
   - Read the project's README.md (and any CONTRIBUTING.md or docs/).
   - Verify that install steps, listed scripts (e.g. `npm run dev`, `npm test`), and examples still match the actual package.json scripts and project structure.
   - Flag any commands, paths, or configuration references in the README that no longer exist or have changed.

7. **Changelog Generator**
   - Summarize commits from the last 7 days (or since the last tag, whichever is shorter) into a draft changelog entry.
   - Group by category: Features, Fixes, Refactoring, Documentation, Chores.
   - Use conventional commit messages where available; otherwise infer the category.

## Part 3 — Git & Workflow Hygiene

8. **Stale Branch Cleanup**
   - List all remote branches with no commit activity in the last 30 days.
   - For each, report: branch name, last commit date, last commit author, and whether it has been merged into the main branch.
   - Recommend deletion for branches that are both stale and already merged.

9. **PR Hygiene Report**
   - If a GitHub remote is detected, use `gh pr list` to enumerate open PRs.
   - For each open PR, report: number, title, author, age (days open), review status, and whether it has merge conflicts.
   - Flag "stuck" PRs: those open for more than 7 days with no review activity.

10. **Merge Conflict Forecast**
    - Identify active branches (commits in the last 14 days) that have diverged significantly from the main branch.
    - For each, report the number of commits ahead/behind main and list files modified on both the branch and main since divergence.
    - Flag branches with high conflict risk (overlapping file changes).

---

Produce a structured Markdown report. Your entire response will be saved as the report file, so write valid Markdown only — no conversational preamble.

Report structure:

## Summary
(Overall health rating: Excellent/Good/Fair/Needs Attention. Key stats: dead code items, stale TODOs, config issues, license concerns, doc drift items, stale branches, stuck PRs.)

## Dead Code
(Table: file, export/function, type [unused export | unreachable | orphan file], recommendation)

## TODO/FIXME Tracker
(Table: file:line, type, comment, author, date, stale?)
(Summary counts at the end)

## Config Drift
(List of findings with config file, setting, current value, recommended value)

## License Compliance
(Summary table: license → count. Flagged dependencies listed separately.)

## Documentation Freshness
(List of stale docs, README drift findings, any mismatches)

## Draft Changelog
(Grouped changelog entry for the recent period)

## Stale Branches
(Table: branch, last commit date, author, merged?, recommendation)

## PR Hygiene
(Table: PR#, title, author, days open, review status, conflicts?, stuck?)

## Merge Conflict Forecast
(Table: branch, commits ahead/behind, overlapping files, risk level)

## Recommendations
(Numbered list of 5–10 prioritised actions, ordered by impact)

Important: Do NOT modify any source files. This is a read-only assessment.
