/**
 * CustomWorkflowGuide — collapsible instructions for defining workflow.md files.
 */

import { useState } from 'react'
import { IconChevronDown, IconChevronRight } from '@tabler/icons-react'

// ---------------------------------------------------------------------------
// CustomWorkflowGuide
// ---------------------------------------------------------------------------

export function CustomWorkflowGuide() {
  const [open, setOpen] = useState(false)

  return (
    <div className="workflow-card mt-6 rounded-lg border border-edge bg-surface">
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center gap-2 px-4 py-3 text-left text-body font-medium text-ink hover:text-ink transition-colors"
      >
        {open
          ? <IconChevronDown size={14} stroke={2} className="text-ink-muted" />
          : <IconChevronRight size={14} stroke={2} className="text-ink-muted" />
        }
        Defining Custom Workflows
        <span className="text-meta text-ink-muted font-normal ml-1">via workflow.md files</span>
      </button>

      {open && (
        <div className="px-4 pb-4 text-body text-ink-muted space-y-3 border-t border-edge pt-3">
          <p>
            You can define custom workflow types per-repo by adding <code className="text-accent-3 bg-surface-raised px-1 rounded-control">.md</code> files to:
          </p>
          <pre className="rounded-md bg-page px-3 py-2 text-body text-ink font-mono overflow-x-auto">
{'<repo>/.codekin/workflows/<kind>.md'}
          </pre>

          <p>Each file uses YAML frontmatter + a prompt body:</p>
          <pre className="rounded-md bg-page px-3 py-2 text-body text-ink font-mono overflow-x-auto">{
`---
kind: api-docs.weekly
name: API Documentation Check
sessionPrefix: api-docs
outputDir: .codekin/reports/api-docs
filenameSuffix: _api-docs.md
commitMessage: chore: api docs check
---
You are reviewing the API documentation for this project.

1. Find all REST endpoints and verify they have docs
2. Check for outdated examples or missing parameters
3. Produce a Markdown report

Important: Do NOT modify any source files.`
          }</pre>

          <div className="space-y-1.5 text-body">
            <p className="font-medium text-ink">Frontmatter fields:</p>
            <ul className="list-disc list-inside space-y-0.5 text-ink-muted ml-1">
              <li><code className="text-ink">kind</code> — unique ID, e.g. <code className="text-ink">code-review.daily</code></li>
              <li><code className="text-ink">name</code> — display name shown in the UI</li>
              <li><code className="text-ink">sessionPrefix</code> — prefix for the session name</li>
              <li><code className="text-ink">outputDir</code> — where reports are saved in the repo</li>
              <li><code className="text-ink">filenameSuffix</code> — appended to the date for the report filename</li>
              <li><code className="text-ink">commitMessage</code> — git commit message prefix</li>
            </ul>
          </div>

          <p className="text-ink-muted">
            Custom workflows appear automatically when adding a new workflow for that repo. To override a built-in workflow{"'"}s prompt, use the same <code className="text-ink">kind</code> value.
          </p>
        </div>
      )}
    </div>
  )
}
