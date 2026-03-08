/**
 * Prompt builder for Stepflow-initiated Claude sessions.
 *
 * Translates a `StepflowSessionRequest` into a structured Markdown prompt that
 * tells Claude what to do and why.  The prompt follows the same conventions as
 * the GitHub webhook prompt (`webhook-prompt.ts`) so both kinds of sessions
 * feel consistent from Claude's point of view.
 *
 * Prompt anatomy:
 *   ## Task            — the primary instruction (always present)
 *   ## Context         — background / constraints (when provided)
 *   ## Repository Info — repo, branch, commit, associated PR/issue
 *   ## Instructions    — standard operating procedure for autonomous sessions
 *
 * Usage:
 * ```typescript
 * const prompt = buildStepflowPrompt(request)
 * sessions.sendInput(sessionId, prompt)
 * ```
 */

import type { StepflowSessionRequest } from './stepflow-types.js'

/**
 * Maps workflow kinds that produce report artifacts to their `.codekin/outputs/` subdirectory.
 * When a session's kind matches, the prompt instructs Claude to write the report there.
 */
const KIND_OUTPUT_DIR: Record<string, string> = {
  'code.review':          '.codekin/outputs/code-reviews',
  'security.audit':       '.codekin/outputs/security-audits',
  'complexity.analysis':  '.codekin/outputs/complexity-reports',
  'complexity.report':    '.codekin/outputs/complexity-reports',
  'coverage.assessment':  '.codekin/outputs/coverage-assessments',
  'coverage.analysis':    '.codekin/outputs/coverage-assessments',
  'comment.assessment':   '.codekin/outputs/comment-assessments',
  'dependency.health':    '.codekin/outputs/dependency-health',
}

/**
 * Build the initial prompt sent to Claude for a Stepflow-initiated session.
 *
 * @param req - The session request from the Stepflow workflow step.
 * @param runId - The Stepflow run ID, included for traceability.
 * @param kind - The Stepflow workflow kind (e.g. `'code.fix'`), for context.
 */
export function buildStepflowPrompt(
  req: StepflowSessionRequest,
  runId: string,
  kind: string,
): string {
  const lines: string[] = []

  // -------------------------------------------------------------------------
  // Task
  // -------------------------------------------------------------------------
  lines.push('## Task')
  lines.push('')
  lines.push(req.taskDescription)

  // -------------------------------------------------------------------------
  // Context (optional free-form background from the workflow)
  // -------------------------------------------------------------------------
  if (req.taskContext) {
    lines.push('')
    lines.push('## Context')
    lines.push('')
    lines.push(req.taskContext)
  }

  // -------------------------------------------------------------------------
  // Repository info
  // -------------------------------------------------------------------------
  lines.push('')
  lines.push('## Repository Info')
  lines.push('')
  lines.push(`- **Repository**: ${req.repo}`)
  lines.push(`- **Branch**: ${req.branch}`)
  lines.push(`- **Commit**: ${req.headSha.slice(0, 7)}`)

  if (req.prNumber !== undefined) {
    const prTitle = req.prTitle ? ` — "${req.prTitle}"` : ''
    lines.push(`- **Pull Request**: #${req.prNumber}${prTitle}`)
  }

  if (req.issueNumber !== undefined) {
    const issueTitle = req.issueTitle ? ` — "${req.issueTitle}"` : ''
    lines.push(`- **Issue**: #${req.issueNumber}${issueTitle}`)
  }

  // Traceability: let Claude know this was triggered by an automated workflow,
  // not a human, so it doesn't prompt for confirmation on routine actions.
  lines.push('')
  lines.push(`_Triggered by Stepflow workflow \`${kind}\` (run \`${runId}\`)._`)

  // -------------------------------------------------------------------------
  // Instructions
  // -------------------------------------------------------------------------
  lines.push('')
  lines.push('## Instructions')
  lines.push('')
  lines.push('This session was started automatically by a workflow orchestrator.')
  lines.push('There is no human reviewing this in real time — operate autonomously.')
  lines.push('')
  lines.push('1. Read and understand the task above.')
  lines.push('2. Explore the repository as needed to understand the relevant code.')
  lines.push('3. Implement the required changes.')
  lines.push('4. Commit your changes with a clear, descriptive message.')
  lines.push('5. Push the commit to the branch.')
  if (req.prNumber !== undefined) {
    lines.push(`6. Add a brief comment on PR #${req.prNumber} summarising what you did, using the \`gh\` CLI.`)
  }
  lines.push('')
  lines.push('Only make changes that are necessary for the stated task.')
  lines.push('Do not refactor unrelated code or add unrequested features.')

  // -------------------------------------------------------------------------
  // Report output (for analysis/review workflow kinds)
  // -------------------------------------------------------------------------
  const outputDir = KIND_OUTPUT_DIR[kind]
  if (outputDir) {
    const slug = req.repo.replace('/', '-')
    const filename = `${slug}-${runId.slice(0, 8)}.md`
    lines.push('')
    lines.push('## Report Output')
    lines.push('')
    lines.push(`This is a **${kind}** workflow. After completing your analysis, write a Markdown report to:`)
    lines.push('')
    lines.push(`\`${outputDir}/${filename}\``)
    lines.push('')
    lines.push('The report should summarise findings, issues, and recommendations.')
    lines.push('Commit this file along with any code changes.')
  }

  return lines.join('\n')
}
