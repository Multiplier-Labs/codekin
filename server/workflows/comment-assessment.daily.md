---
kind: comment-assessment.daily
name: Comment Assessment
sessionPrefix: comments
outputDir: comment-reports
filenameSuffix: _comment-assessment.md
commitMessage: chore: comment assessment
---
You are performing an automated code commenting assessment. Please do the following:

1. Examine the project structure to understand the codebase language(s), size, and conventions.

2. Assess the quality and coverage of code comments and documentation across the codebase:
   - Public APIs, exported functions, classes, and types — are they documented?
   - Complex algorithms and non-obvious logic — do they have inline explanations?
   - File-level and module-level doc comments — are they present where appropriate?
   - Comment accuracy — do comments match what the code actually does?
   - Comment style consistency — are JSDoc/TSDoc/docstring conventions followed?
   - Outdated or misleading comments that no longer reflect the code

3. Sample representative files from different parts of the codebase (src/, lib/, server/, etc.) to get a broad picture.

4. Produce a structured Markdown report. Your entire response will be saved as the report file, so write valid Markdown only — no conversational preamble.

Report structure:
## Summary
(Overall assessment: comment coverage %, quality rating, key observations)

## Well-Documented Areas
(List of files or modules with good commenting practices, with examples)

## Underdocumented Areas
(Table: File | Issue | Severity — sorted by severity, top 15)

## Comment Quality Issues
(List of specific issues found: inaccurate, outdated, or misleading comments with file paths and line numbers)

## Recommendations
(Numbered list of 5–10 actionable improvements, each with: file path or area, what to add/fix, and why it matters)

Important: Do NOT modify any source files.
