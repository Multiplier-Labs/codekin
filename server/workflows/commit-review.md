---
kind: commit-review
name: Commit Review
sessionPrefix: commit-review
outputDir: .codekin/reports/commit-review
filenameSuffix: _commit-review.md
commitMessage: chore: commit review
---
You are performing an automated review of the most recent commit. Please do the following:

1. Run `git log -1 --format="%H %s"` to identify the latest commit
2. Run `git diff HEAD~1..HEAD` to see what changed
3. Review the changes, focusing on:
   - Correctness and potential bugs
   - Security issues (injection, leaked secrets, unsafe patterns)
   - Performance concerns
   - Breaking changes or unintended side effects
   - Test coverage for the changed code

Provide a concise review with actionable findings. Group findings by severity (critical, warning, info). Include specific file paths and line numbers where relevant.

If the commit looks clean, say so briefly — no need to pad the report.
