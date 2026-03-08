---
kind: complexity.weekly
name: Complexity Report
sessionPrefix: complexity
outputDir: .codekin/reports/complexity
filenameSuffix: _complexity-report.md
commitMessage: chore: complexity report
---
You are performing an automated code complexity analysis. Please do the following:

1. Examine the project structure to understand the tech stack, language(s), and codebase size.

2. Identify large files and modules:
   - Run: `find . -type f \( -name "*.ts" -o -name "*.tsx" -o -name "*.js" -o -name "*.jsx" -o -name "*.py" -o -name "*.go" -o -name "*.rs" \) ! -path "*/node_modules/*" ! -path "*/.git/*" ! -path "*/dist/*" ! -path "*/build/*" | xargs wc -l 2>/dev/null | sort -rn | head -30`
   - Flag files over 300 lines as candidates for splitting

3. Identify deeply nested and complex functions:
   - Look for functions with deeply nested conditionals (4+ levels of nesting)
   - Functions with many parameters (5+ parameters)
   - Long functions (50+ lines of logic)
   - High cyclomatic complexity indicators: many if/else chains, switch cases, loops with nested conditions
   - Read the top 10 largest files and assess their internal complexity

4. Identify coupling and cohesion issues:
   - God objects/modules that do too many unrelated things
   - Circular dependencies or tightly coupled modules
   - Large import lists suggesting poor module boundaries
   - Repeated logic that should be extracted into shared utilities

5. Identify other maintainability concerns:
   - Functions that are hard to test due to side effects or global state
   - Magic numbers and strings without named constants
   - Inconsistent abstractions within the same module
   - Areas where a refactor would have the highest impact

6. Produce a structured Markdown report. Your entire response will be saved as the report file, so write valid Markdown only — no conversational preamble.

Report structure:
## Summary
(Overall complexity rating: High/Medium/Low, key metrics: largest file, deepest nesting, most complex function)

## Largest Files
(Table: File | Lines | Primary Responsibility | Refactor Priority — top 15, sorted by lines descending)

## Most Complex Functions
(Table: File:Function | Estimated Complexity | Issue Description | Refactor Suggestion — top 10)

## Coupling & Cohesion Issues
(List of modules with coupling problems, description of the issue, suggested fix)

## Refactoring Candidates
(Numbered list of 5–10 highest-impact refactoring opportunities, each with: location, problem description, suggested approach, effort estimate: small/medium/large)

Important: Do NOT modify any source files.
