---
kind: dependency-health.daily
name: Dependency Health Report
sessionPrefix: deps
outputDir: dependency-reports
filenameSuffix: _dependency-health.md
commitMessage: chore: dependency health report
---
You are performing an automated dependency health assessment. Please do the following:

1. Detect the package manager(s) in use by examining: package.json, yarn.lock, pnpm-lock.yaml, pyproject.toml, requirements.txt, Pipfile, go.mod, Cargo.toml, Gemfile, pom.xml, build.gradle, or similar files.

2. For each detected package manager, gather dependency information:
   - JS/TS (npm): run `npm audit --json 2>/dev/null | head -500` and `npm outdated --json 2>/dev/null | head -500`
   - JS/TS (yarn): run `yarn audit --json 2>/dev/null | head -500` and `yarn outdated --json 2>/dev/null | head -500`
   - JS/TS (pnpm): run `pnpm audit --json 2>/dev/null | head -300` and `pnpm outdated 2>/dev/null | head -300`
   - Python (pip): run `pip list --outdated --format=json 2>/dev/null | head -300` and `pip-audit --format=json 2>/dev/null | head -300` (if available)
   - Python (poetry): run `poetry show --outdated 2>/dev/null | head -100`
   - Go: run `go list -u -m all 2>/dev/null | head -100`
   - Rust: run `cargo outdated 2>/dev/null | head -100` (if available), `cargo audit 2>/dev/null | head -200` (if available)

3. Also check for common issues:
   - Packages with no updates in 2+ years (potential abandonment)
   - Duplicate or conflicting versions of the same package
   - Dependencies with known CVEs at critical or high severity
   - Dev dependencies accidentally included in production bundles (for JS)

4. Produce a structured Markdown report. Your entire response will be saved as the report file, so write valid Markdown only — no conversational preamble.

Report structure:
## Summary
(Table: Package Manager | Total Deps | Outdated | Vulnerabilities | Risk Level)

## Security Vulnerabilities
(Table: Package | Severity | CVE | Description | Fixed In — sorted by severity descending, critical/high first)

## Outdated Dependencies
(Table: Package | Current | Latest | Age | Type — sorted by age descending, top 20)

## Abandoned / Unmaintained Packages
(List of packages with no releases in 2+ years, with last release date)

## Recommendations
(Numbered list of 5–10 prioritised actions: what to update/replace and why)

Important: Do NOT modify any source files, package.json, or lock files.
