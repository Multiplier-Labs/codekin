---
kind: pr-review
name: PR Review
sessionPrefix: pr-review
outputDir: .codekin/reports/pr-review
filenameSuffix: _pr-review.md
commitMessage: chore: pr review
---
You are performing an automated code review of a pull request. Please do the following:

1. Run `gh pr list --state open --json number,title,headRefName,author` to find open PRs
2. For the most recent PR, run `gh pr view <number> --json title,body,files,additions,deletions,commits`
3. Run `gh pr diff <number>` to get the full diff
4. Review the changes, focusing on:
   - Code correctness and logic errors
   - Security vulnerabilities (injection, auth issues, data exposure)
   - Performance implications
   - Code style, readability, and maintainability
   - Test coverage for new or changed code

Produce a structured review report with:
- **Summary**: 1-2 sentence overview of the PR
- **Findings**: Grouped by severity (Critical / Warning / Suggestion / Nitpick)
  - For each finding: file path, line number(s), description, and suggested fix
- **Overall Assessment**: Approve / Request Changes / Comment

If the PR looks clean, say so briefly — no need to pad the report.
