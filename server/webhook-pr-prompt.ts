/**
 * Builds the structured prompt sent to Claude for pull request code review.
 *
 * Supports a 3-tier custom prompt resolution for the review instructions:
 *   1. Repo-level: {workspacePath}/.codekin/pr-review-prompt.md
 *   2. Global:     ~/.codekin/pr-review-prompt.md
 *   3. Built-in default (hardcoded below)
 *
 * The PR metadata and diff context are always prepended — custom prompts
 * only replace the review instructions section.
 */

import { existsSync, readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import type { PullRequestContext } from './webhook-types.js'
import type { PrCacheData } from './webhook-pr-cache.js'
import { REVIEW_COMMENT_MARKER } from './webhook-pr-github.js'

/** Options for prompt assembly — cache context and comment management. */
export interface PrPromptOptions {
  priorCache?: PrCacheData
  cachePath?: string
  existingCommentId?: number
}

const CUSTOM_PROMPT_FILENAME = 'pr-review-prompt.md'

/**
 * Attempt to load a custom review prompt from disk.
 * Returns the file contents if found, or undefined.
 */
function loadCustomPrompt(workspacePath: string): string | undefined {
  // 1. Repo-level
  const repoPromptPath = join(workspacePath, '.codekin', CUSTOM_PROMPT_FILENAME)
  if (existsSync(repoPromptPath)) {
    try {
      const content = readFileSync(repoPromptPath, 'utf-8').trim()
      if (content) {
        console.log(`[pr-prompt] Using repo-level custom prompt: ${repoPromptPath}`)
        return content
      }
    } catch (err) {
      console.warn(`[pr-prompt] Failed to read repo-level prompt:`, err)
    }
  }

  // 2. Global
  const globalPromptPath = join(homedir(), '.codekin', CUSTOM_PROMPT_FILENAME)
  if (existsSync(globalPromptPath)) {
    try {
      const content = readFileSync(globalPromptPath, 'utf-8').trim()
      if (content) {
        console.log(`[pr-prompt] Using global custom prompt: ${globalPromptPath}`)
        return content
      }
    } catch (err) {
      console.warn(`[pr-prompt] Failed to read global prompt:`, err)
    }
  }

  return undefined
}

/**
 * Build the default review instructions (used when no custom prompt is found).
 */
function buildDefaultInstructions(ctx: PullRequestContext): string {
  const lines: string[] = []

  if (ctx.action === 'synchronize' && ctx.beforeSha) {
    lines.push(`This PR has been updated with new commits. The previous head was \`${ctx.beforeSha.slice(0, 7)}\`, the new head is \`${ctx.headSha.slice(0, 7)}\`. Review the full PR diff but pay particular attention to changes since the previous head.`)
  } else if (ctx.action === 'reopened') {
    lines.push('This PR has been reopened. Provide a fresh comprehensive code review.')
  } else {
    lines.push('Provide a comprehensive code review of this pull request.')
  }

  lines.push('')
  lines.push('Focus on:')
  lines.push('1. Code correctness and logic errors')
  lines.push('2. Security vulnerabilities (injection, auth issues, data exposure)')
  lines.push('3. Performance implications')
  lines.push('4. Code style, readability, and maintainability')
  lines.push('5. Test coverage for new or changed code')
  lines.push('')
  lines.push('Produce a structured review report with:')
  lines.push('- **Summary**: 1-2 sentence overview of the PR')
  lines.push('- **Findings**: Grouped by severity (Critical / Warning / Suggestion / Nitpick)')
  lines.push('  - For each finding: file path, line number(s), description, and suggested fix')
  lines.push('- **Overall Assessment**: Approve / Request Changes / Comment')

  return lines.join('\n')
}

/**
 * Builds the full prompt for PR review, combining PR context with review instructions.
 *
 * @param ctx           - Pull request context with metadata and diff.
 * @param workspacePath - Path to the cloned workspace (for repo-level prompt lookup).
 * @param options       - Optional cache context and comment management settings.
 */
export function buildPrReviewPrompt(ctx: PullRequestContext, workspacePath: string, options?: PrPromptOptions): string {
  const lines: string[] = []
  const reviewBodyPath = `${workspacePath}/pr-${ctx.prNumber}-review-body.md`

  // --- PR metadata (always included) ---
  lines.push('A pull request needs code review.')
  lines.push('')
  lines.push('## PR Details')
  lines.push(`- **Repository**: ${ctx.repo}`)
  lines.push(`- **PR**: #${ctx.prNumber} — ${ctx.prTitle}`)
  lines.push(`- **Author**: ${ctx.author}`)
  lines.push(`- **Branch**: ${ctx.headBranch} → ${ctx.baseBranch}`)
  lines.push(`- **Stats**: ${ctx.changedFiles} files changed, +${ctx.additions}/-${ctx.deletions}`)

  const shortHead = ctx.headSha.slice(0, 7)
  lines.push(`- **Head**: ${shortHead}`)

  if (ctx.prUrl) {
    lines.push(`- **URL**: ${ctx.prUrl}`)
  }

  // PR description
  if (ctx.prBody) {
    lines.push('')
    lines.push('## PR Description')
    lines.push(ctx.prBody)
  }

  // Changed files
  if (ctx.fileList) {
    lines.push('')
    lines.push('## Changed Files')
    lines.push(ctx.fileList)
  }

  // Commit messages
  if (ctx.commitMessages) {
    lines.push('')
    lines.push('## Commits')
    lines.push(ctx.commitMessages)
  }

  // Existing review comments
  if (ctx.reviews || ctx.reviewComments) {
    lines.push('')
    lines.push('## Existing Reviews')
    if (ctx.reviews) {
      lines.push('### Review Summaries')
      lines.push(ctx.reviews)
    }
    if (ctx.reviewComments) {
      lines.push('### Inline Comments')
      lines.push(ctx.reviewComments)
    }
  }

  // Prior review context (from cache)
  if (options?.priorCache) {
    const cache = options.priorCache
    lines.push('')
    lines.push('## Prior Review Context')
    lines.push(`(from review at commit ${cache.lastReviewedSha} on ${cache.timestamp})`)
    lines.push('')
    lines.push('### Codebase Familiarity')
    lines.push(cache.codebaseContext)
    lines.push('')
    lines.push('### Previous Review Findings')
    lines.push(cache.reviewFindings)
    lines.push('')
    lines.push('### Previous Review Summary')
    lines.push(cache.priorReviewSummary)
    lines.push('')
    lines.push('Note: The above is from a previous review. The diff and comments below are fresh. Review the full current diff but leverage your prior context for faster, more informed review.')
  }

  // Diff
  lines.push('')
  lines.push('## Diff')
  if (ctx.diff) {
    lines.push('```diff')
    lines.push(ctx.diff)
    lines.push('```')
  } else {
    lines.push('No diff available.')
  }

  // --- Review instructions (custom or default) ---
  lines.push('')
  lines.push('## Instructions')

  const customPrompt = loadCustomPrompt(workspacePath)
  if (customPrompt) {
    lines.push(customPrompt)
  } else {
    lines.push(buildDefaultInstructions(ctx))
  }

  // Override any hardcoded intermediate review file paths from custom prompts
  // so concurrent reviews don't collide or write into tracked repo files.
  lines.push('')
  lines.push('## File Paths for This Review')
  lines.push('When writing intermediate files during the review process, use these paths:')
  lines.push(`- Draft review: \`${workspacePath}/pr-${ctx.prNumber}-draft-review.md\``)
  lines.push(`- Codex cross-review output: \`${workspacePath}/pr-${ctx.prNumber}-codex-review.md\``)
  lines.push(`- Codex command: \`codex exec - --skip-git-repo-check -o ${workspacePath}/pr-${ctx.prNumber}-codex-review.md < ${workspacePath}/pr-${ctx.prNumber}-draft-review.md\``)
  lines.push('These paths override any file paths mentioned in the review instructions above.')
  lines.push('Do NOT write review files to the `docs/` directory or any other git-tracked location.')

  // --- Comment posting instructions ---
  lines.push('')
  if (options?.existingCommentId) {
    lines.push('## Posting Your Review Summary')
    lines.push(`An existing Codekin review comment was found on this PR (comment ID: ${options.existingCommentId}).`)
    lines.push('Update it instead of creating a new comment. Use a temporary file for the body to avoid shell escaping issues:')
    lines.push('')
    lines.push(`1. Write your review summary to \`${reviewBodyPath}\``)
    lines.push(`2. Ensure the file starts with \`${REVIEW_COMMENT_MARKER}\` on its own line`)
    lines.push(`3. Run: \`gh api repos/${ctx.repo}/issues/comments/${options.existingCommentId} -X PATCH -F body=@${reviewBodyPath}\``)
    lines.push('')
    lines.push(`IMPORTANT: Always include \`${REVIEW_COMMENT_MARKER}\` at the very beginning of the comment body.`)
  } else {
    lines.push('## Posting Your Review Summary')
    lines.push('Post your review summary as a new comment on the PR. Use a temporary file for the body to avoid shell escaping issues:')
    lines.push('')
    lines.push(`1. Write your review summary to \`${reviewBodyPath}\``)
    lines.push(`2. Ensure the file starts with \`${REVIEW_COMMENT_MARKER}\` on its own line`)
    lines.push(`3. Run: \`gh api repos/${ctx.repo}/issues/${ctx.prNumber}/comments -F body=@${reviewBodyPath}\``)
    lines.push('')
    lines.push(`IMPORTANT: Always include \`${REVIEW_COMMENT_MARKER}\` at the very beginning of the comment body. This marker allows future reviews to update this comment instead of creating a new one.`)
  }

  // --- Cache-writing instructions ---
  if (options?.cachePath) {
    lines.push('')
    lines.push('## Post-Review: Save Context')
    lines.push('After completing your review, write a JSON file to preserve your context for future reviews of this PR.')
    lines.push('')
    lines.push(`Path: ${options.cachePath}`)
    lines.push('')
    lines.push('The file must be valid JSON with this exact structure:')
    lines.push('```json')
    lines.push('{')
    lines.push(`  "prNumber": ${ctx.prNumber},`)
    lines.push(`  "repo": "${ctx.repo}",`)
    lines.push(`  "lastReviewedSha": "${ctx.headSha}",`)
    lines.push('  "timestamp": "<current ISO timestamp>",')
    lines.push('  "priorReviewSummary": "<1-3 sentence summary of your review findings>",')
    lines.push('  "codebaseContext": "<key architectural observations, module structure, patterns you noticed>",')
    lines.push('  "reviewFindings": "<specific issues found, their locations, and whether they were fixed>",')
    lines.push('  "verdict": "<approve | request_changes | comment>",')
    lines.push('  "structuredFindings": [')
    lines.push('    {')
    lines.push('      "severity": "<critical | must-fix | suggestion | minor | nitpick>",')
    lines.push('      "file": "<path/to/file.ts>",')
    lines.push('      "line": <line number or null>,')
    lines.push('      "description": "<short description of the finding>",')
    lines.push('      "status": "<new | open | fixed>"')
    lines.push('    }')
    lines.push('  ],')
    lines.push(`  "author": ${JSON.stringify(ctx.author)},`)
    lines.push(`  "prTitle": ${JSON.stringify(ctx.prTitle)},`)
    lines.push(`  "changedFiles": ${ctx.changedFiles},`)
    lines.push(`  "additions": ${ctx.additions},`)
    lines.push(`  "deletions": ${ctx.deletions}`)
    lines.push('}')
    lines.push('```')
    lines.push('')
    lines.push('IMPORTANT: The `structuredFindings` array must include every finding from your review.')
    lines.push('Use an empty array `[]` if there are no findings. The `verdict` must be exactly one of: approve, request_changes, comment.')
    lines.push('')
    lines.push('Use the Write tool to save this file. This helps future reviews of this PR be more efficient.')
  }

  return lines.join('\n')
}