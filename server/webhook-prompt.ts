import type { FailureContext } from './webhook-types.js'

/**
 * Builds the structured prompt sent to Claude for CI failure diagnosis.
 */
export function buildPrompt(ctx: FailureContext, logLinesToInclude = 200): string {
  const lines: string[] = []

  lines.push('A GitHub Actions workflow has failed and needs to be fixed.')
  lines.push('')
  lines.push('## Failure Details')
  lines.push(`- **Repository**: ${ctx.repo}`)
  lines.push(`- **Branch**: ${ctx.branch}`)
  lines.push(`- **Workflow**: ${ctx.workflowName} (run #${ctx.runNumber})`)

  // Failed jobs
  const failedJobNames = ctx.jobs.length > 0
    ? ctx.jobs.map(j => j.name).join(', ')
    : 'Unknown'
  lines.push(`- **Failed jobs**: ${failedJobNames}`)

  lines.push(`- **Trigger**: ${ctx.event} by ${ctx.actor}`)

  // Commit line
  const shortSha = ctx.headSha.slice(0, 7)
  if (ctx.commitMessage !== undefined) {
    lines.push(`- **Commit**: ${shortSha} — "${ctx.commitMessage}"`)
  } else {
    lines.push(`- **Commit**: ${shortSha}`)
  }

  // Pull request (optional)
  if (ctx.pullRequest) {
    const prTitle = ctx.pullRequest.title ? ` — "${ctx.pullRequest.title}"` : ''
    lines.push(`- **Pull Request**: #${ctx.pullRequest.number}${prTitle}`)
  }

  lines.push('')
  lines.push('## Error Logs')
  lines.push('```')

  if (!ctx.failedLogs || ctx.failedLogs.trim() === '') {
    lines.push('No logs available')
  } else {
    const logLines = ctx.failedLogs.split('\n')
    const truncated = logLines.slice(-logLinesToInclude)
    lines.push(truncated.join('\n'))
  }

  lines.push('```')

  // Annotations (optional)
  if (ctx.annotations.length > 0) {
    lines.push('')
    lines.push('## Annotations')
    for (const ann of ctx.annotations) {
      lines.push(`- ${ann.path}:${ann.startLine} — ${ann.message}`)
    }
  }

  lines.push('')
  lines.push('## Instructions')
  lines.push('1. Diagnose the root cause of the CI failure by examining the logs and source code.')
  lines.push('2. Fix the issue in the source code.')
  lines.push('3. Commit the changes with a descriptive commit message that references the failed workflow.')
  lines.push('4. Push the commit to the branch.')
  if (ctx.pullRequest) {
    lines.push(`5. Add a brief comment on PR #${ctx.pullRequest.number} explaining what you found and how you fixed it, using the \`gh\` CLI.`)
  } else {
    lines.push('5. If appropriate, create a pull request for the fix using the `gh` CLI.')
  }
  lines.push('')
  lines.push('Explain what you found and what you changed.')

  return lines.join('\n')
}
