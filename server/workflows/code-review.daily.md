---
kind: code-review.daily
name: Daily Code Review
sessionPrefix: review
outputDir: .codekin/reports/code-review
filenameSuffix: _code-review-daily.md
commitMessage: chore: code review
---
You are performing a daily automated code review. Please do the following:

1. Examine the project structure and architecture
2. Review the last 7 days of git log to understand recent changes
3. Do a deeper review of critical files, focusing on:
   - Code quality and consistency
   - Potential bugs or logic errors
   - Security vulnerabilities
   - Performance concerns
   - Documentation gaps
   - Test coverage
   - Dependency issues

Provide a thorough but concise review with actionable findings. Group findings by severity (critical, warning, info). Include specific file paths and line numbers where relevant.
