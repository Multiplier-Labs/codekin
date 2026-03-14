---
kind: docs-audit.weekly
name: Documentation Audit
sessionPrefix: docs-audit
outputDir: .codekin/reports/docs-audit
filenameSuffix: _docs-audit.md
commitMessage: chore: documentation audit report
---
You are performing an automated documentation audit. Your goal is to reduce documentation sprawl, eliminate outdated content, and identify files that should be consolidated — keeping the repo's docs lean, accurate, and easy to navigate.

## Part 1 — Inventory & Staleness

1. **Documentation Inventory**
   - List every documentation file in the repo: root `.md` files, `docs/` directory, inline READMEs in subdirectories, and any `.txt` documentation files.
   - For each file, report: path, line count, last modified date (from `git log -1`), and a one-line summary of its purpose.

2. **Staleness Detection**
   - For each documentation file, compare its last-modified date against the code it documents.
   - Flag files where the documented code has changed significantly (new features, removed APIs, renamed files) but the docs were not updated.
   - Check for references to files, functions, CLI commands, config keys, or URLs that no longer exist.
   - Report broken internal links (references to other docs or code paths that don't resolve).

3. **Accuracy Check**
   - Verify that install/setup instructions still work against the current `package.json` scripts and project structure.
   - Check that documented API endpoints, types, and interfaces match the actual codebase.
   - Flag any code examples or configuration snippets that reference outdated syntax, removed options, or renamed variables.

## Part 2 — Redundancy & Consolidation

4. **Overlap Detection**
   - Identify documentation files that cover the same or heavily overlapping topics.
   - For each overlap, list the files involved, the shared topic, and which file has the more complete/current version.
   - Recommend which files should be merged and which should be deleted after merging.

5. **Fragmentation Analysis**
   - Flag cases where closely related information is split across multiple small files that would be easier to navigate as a single document.
   - Identify spec/feature docs that describe functionality already shipped and stable — these may be candidates for folding into the main feature reference or API docs.
   - Check for "plan" or "proposal" documents that describe work already completed — these are candidates for deletion or archival.

6. **Naming & Organization**
   - Check that file names clearly indicate their content and audience (user guide vs. developer spec vs. ops runbook).
   - Flag confusing or ambiguous file names.
   - Assess whether the `docs/` directory structure is logical or if files should be reorganized.

## Part 3 — Recommendations

7. **Deletion Candidates**
   - List files that are fully outdated, superseded by other docs, or describe completed proposals with no ongoing reference value.
   - For each, explain why it's safe to delete.

8. **Consolidation Candidates**
   - List groups of files that should be merged into a single document.
   - For each group, recommend the target file name and which content to keep vs. drop.

9. **Update Candidates**
   - List files that are still valuable but need content updates to match the current codebase.
   - For each, note specific sections or claims that are stale.

---

Produce a structured Markdown report. Your entire response will be saved as the report file, so write valid Markdown only — no conversational preamble.

Report structure:

## Summary
(Overview: total doc files, files needing attention, key findings. Health rating: Well-maintained / Needs cleanup / Significant drift.)

## Documentation Inventory
(Table: path, lines, last modified, purpose, status [current | stale | outdated | redundant])

## Staleness Findings
(List of stale docs with specific outdated references, broken links, or inaccurate claims)

## Accuracy Issues
(List of incorrect instructions, outdated examples, or mismatched API references)

## Overlap & Redundancy
(Groups of overlapping files with merge recommendations)

## Fragmentation
(Cases where related docs should be combined, and completed specs that should be folded in or removed)

## Action Items

### Delete
(Table: file, reason it's safe to delete)

### Consolidate
(Table: source files, target file, what to keep/drop)

### Update
(Table: file, sections needing update, what changed in code)

## Recommendations
(Numbered list of 5–10 prioritised actions to reduce doc sprawl and improve accuracy)

Important: Do NOT modify any files. This is a read-only assessment.
