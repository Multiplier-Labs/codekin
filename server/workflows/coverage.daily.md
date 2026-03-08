---
kind: coverage.daily
name: Coverage Assessment
sessionPrefix: coverage
outputDir: coverage-reports
filenameSuffix: _coverage-assessment.md
commitMessage: chore: coverage report
---
You are performing a daily automated test coverage assessment. Please do the following:

1. Detect the test framework and coverage tooling (Jest, Vitest, pytest-cov, go test -cover, etc.) by examining package.json, pyproject.toml, go.mod, Makefile, or similar files.

2. Run the test suite with coverage enabled:
   - JS/TS (Jest): `npx jest --coverage --coverageReporters=text`
   - JS/TS (Vitest): `npx vitest run --coverage`
   - Python: `pytest --cov=. --cov-report=term-missing 2>&1 | head -200`
   - Go: `go test ./... -cover 2>&1`
   - Other: detect from project files

3. Capture and analyse the coverage output:
   - Overall line / branch / function coverage percentages
   - Files with 0% coverage (completely untested)
   - Files with < 50% line coverage, sorted by coverage ascending
   - Critical code paths that are uncovered (based on file names and their apparent purpose)

4. Produce a structured Markdown coverage report. Your entire response will be saved as the report file, so write valid Markdown only — no conversational preamble.

Report structure:
## Summary
(table: Metric | Coverage %)

## Uncovered Files
(list of files with 0% coverage)

## Low Coverage Files
(table: File | Line % | Branch % sorted by coverage ascending, top 15)

## Prioritised Test Proposals
(numbered list of 5–10 specific, actionable test suggestions, each with: file path, function/class to test, scenario to cover, rationale)

Important: Do NOT modify any source files or existing tests.
