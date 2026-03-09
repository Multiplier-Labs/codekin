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
    <div className="workflow-card mt-6 rounded-lg border border-neutral-9/60 bg-neutral-10/30">
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center gap-2 px-4 py-3 text-left text-[15px] font-medium text-neutral-3 hover:text-neutral-1 transition-colors"
      >
        {open
          ? <IconChevronDown size={14} stroke={2} className="text-neutral-5" />
          : <IconChevronRight size={14} stroke={2} className="text-neutral-5" />
        }
        Defining Custom Workflows
        <span className="text-[13px] text-neutral-5 font-normal ml-1">via workflow.md files</span>
      </button>

      {open && (
        <div className="px-4 pb-4 text-[14px] text-neutral-4 space-y-3 border-t border-neutral-9/40 pt-3">
          <p>
            You can define custom workflow types per-repo by adding <code className="text-accent-3 bg-neutral-10 px-1 rounded">.md</code> files to:
          </p>
          <pre className="rounded-md bg-neutral-12 px-3 py-2 text-[14px] text-neutral-3 font-mono overflow-x-auto">
{'<repo>/.codekin/workflows/<kind>.md'}
          </pre>

          <p>Each file uses YAML frontmatter + a prompt body:</p>
          <pre className="rounded-md bg-neutral-12 px-3 py-2 text-[14px] text-neutral-3 font-mono overflow-x-auto leading-relaxed">{
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

          <div className="space-y-1.5 text-[14px]">
            <p className="font-medium text-neutral-3">Frontmatter fields:</p>
            <ul className="list-disc list-inside space-y-0.5 text-neutral-4 ml-1">
              <li><code className="text-neutral-3">kind</code> — unique ID, e.g. <code className="text-neutral-3">code-review.daily</code></li>
              <li><code className="text-neutral-3">name</code> — display name shown in the UI</li>
              <li><code className="text-neutral-3">sessionPrefix</code> — prefix for the session name</li>
              <li><code className="text-neutral-3">outputDir</code> — where reports are saved in the repo</li>
              <li><code className="text-neutral-3">filenameSuffix</code> — appended to the date for the report filename</li>
              <li><code className="text-neutral-3">commitMessage</code> — git commit message prefix</li>
            </ul>
          </div>

          <p className="text-neutral-5">
            Custom workflows appear automatically when adding a new workflow for that repo. To override a built-in workflow{"'"}s prompt, use the same <code className="text-neutral-3">kind</code> value.
          </p>
        </div>
      )}
    </div>
  )
}
