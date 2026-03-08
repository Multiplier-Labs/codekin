# Automated Workflows

Codekin includes an automated workflow system that runs Claude Code sessions on a schedule to produce structured reports — code reviews, security audits, coverage assessments, and more. Workflows are defined as Markdown files with YAML frontmatter.

---

## How Workflows Run

Every workflow follows the same four-step execution model:

1. **validate_repo** — Verify the repo path exists and is a git repository. If a `sinceTimestamp` is provided, skip the run if there are no new commits since that time.
2. **create_session** — Create a Codekin session scoped to the repo.
3. **run_prompt** — Start Claude, send the workflow prompt, and wait for a result (10-minute timeout).
4. **save_report** — Write the output as a dated Markdown file into the repo, then commit it.

Workflow runs are triggered by cron schedules configured per-repo via the workflow API.

---

## MD File Format

Workflow definitions are Markdown files with YAML frontmatter. The frontmatter contains configuration metadata; the body is the prompt sent verbatim to Claude.

```
---
kind: my-workflow.daily
name: My Workflow
sessionPrefix: myworkflow
outputDir: my-reports
filenameSuffix: _my-report.md
commitMessage: chore: my workflow
---
You are performing an automated analysis. Please do the following:

1. ...
2. ...
```

### Frontmatter Fields

| Field | Required | Description |
|---|---|---|
| `kind` | yes | Unique identifier for this workflow type. Used in API calls and as the filename stem for per-repo overrides. Convention: `<topic>.<frequency>` (e.g. `code-review.daily`) |
| `name` | yes | Human-readable display name shown in the UI and as the report heading |
| `sessionPrefix` | yes | Prefix for the Codekin session name created for each run (e.g. `review` → session named `review:<repo-name>`) |
| `outputDir` | yes | Directory inside the repo where report files are written (e.g. `review logs`) |
| `filenameSuffix` | yes | Filename suffix appended to the date (e.g. `_code-review-daily.md` → `2026-03-07_code-review-daily.md`) |
| `commitMessage` | yes | Git commit message prefix used when the report is committed (date is appended automatically) |

### Prompt Body

Everything after the closing `---` is the prompt sent to Claude. Write it as a plain instruction — Claude will execute it in the context of the target repository.

**Tips for writing effective workflow prompts:**

- Instruct Claude to produce only valid Markdown in its response — the entire output is saved as the report file
- Specify a concrete report structure (sections, tables) so output is consistent across runs
- End with `Important: Do NOT modify any source files.` to prevent unintended changes
- Use explicit shell commands (e.g. `git log`, `npm audit`) where needed rather than relying on Claude to infer them

---

## Built-in Workflows

Codekin ships with six built-in workflow definitions in `server/workflows/`:

| File | Kind | Schedule | Output Directory |
|---|---|---|---|
| `code-review.daily.md` | `code-review.daily` | Daily | `review logs/` |
| `security-audit.weekly.md` | `security-audit.weekly` | Weekly | `security-reports/` |
| `complexity.weekly.md` | `complexity.weekly` | Weekly | `complexity-reports/` |
| `coverage.daily.md` | `coverage.daily` | Daily | `coverage-reports/` |
| `comment-assessment.daily.md` | `comment-assessment.daily` | Daily | `comment-reports/` |
| `dependency-health.daily.md` | `dependency-health.daily` | Daily | `dependency-reports/` |

All built-in workflows are loaded automatically at server start.

---

## Per-Repo Prompt Overrides

You can override the prompt for any workflow kind on a per-repository basis without modifying the built-in definitions. Create a file at:

```
{repoPath}/.codekin/workflows/{kind}.md
```

For example, to override the daily code review prompt for a specific repo:

```
my-repo/.codekin/workflows/code-review.daily.md
```

The override file uses the same MD format (frontmatter + prompt body). At run time, the loader checks for this file first; if found, its prompt replaces the global one for that run. The frontmatter in an override file is parsed but only the `prompt` body is used — the workflow metadata (outputDir, commitMessage, etc.) always comes from the built-in definition.

**Use cases for per-repo overrides:**

- Focus the review on areas specific to this codebase (e.g. "pay special attention to the payment module")
- Adjust the report format or section headings
- Add repo-specific shell commands or file paths
- Restrict scope to certain directories or file types

---

## Adding New Workflow Types

To add a new built-in workflow, create a `.md` file in `server/workflows/` following the format above. It will be discovered and registered automatically at next server start — no code changes required.

Choose a `kind` that doesn't conflict with existing workflows. The convention is `<topic>.<frequency>` where frequency is one of `daily`, `weekly`, or `monthly`.

---

## Report Output

Each generated report is saved as:

```
{repo}/{outputDir}/{YYYY-MM-DD}{filenameSuffix}
```

The file begins with an auto-generated header:

```markdown
# {name}: {repoName}

**Date**: {ISO timestamp}
**Repository**: {repoPath}
**Branch**: {branch}
**Workflow Run**: {runId}
**Session**: {sessionId}

---

{Claude output}
```

After saving, the report is automatically staged and committed to the repository using the configured `commitMessage` + date suffix.
