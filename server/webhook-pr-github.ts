/**
 * GitHub API helpers for pull request webhook processing.
 *
 * All functions delegate to the `gh` CLI and degrade gracefully — errors are
 * logged as warnings and an empty result is returned so callers can proceed
 * with partial data.
 */

import { execFile } from 'child_process'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)
const GH_TIMEOUT_MS = 30_000

/** Maximum diff size in bytes before truncation (~100KB). */
const MAX_DIFF_BYTES = 100_000

type GhRunner = (args: string[]) => Promise<string>

let ghRunner: GhRunner = async (args) => {
  const { stdout } = await execFileAsync('gh', args, { timeout: GH_TIMEOUT_MS })
  return stdout
}

/** @internal Test-only: override the gh CLI runner */
export function _setGhRunner(runner: GhRunner): void {
  ghRunner = runner
}

/** @internal Test-only: reset to default gh CLI runner */
export function _resetGhRunner(): void {
  ghRunner = async (args) => {
    const { stdout } = await execFileAsync('gh', args, { timeout: GH_TIMEOUT_MS })
    return stdout
  }
}

/**
 * Fetch the unified diff for a pull request.
 * Truncates to ~100KB with a note if larger.
 *
 * @param repo     - GitHub repo in `owner/name` format.
 * @param prNumber - Pull request number.
 * @returns The diff text, or empty string on error.
 */
export async function fetchPrDiff(repo: string, prNumber: number): Promise<{ diff: string; truncated: boolean }> {
  try {
    const output = await ghRunner([
      'api',
      `/repos/${repo}/pulls/${prNumber}`,
      '-H', 'Accept: application/vnd.github.diff',
    ])

    if (output.length > MAX_DIFF_BYTES) {
      const truncated = output.slice(0, MAX_DIFF_BYTES)
      // Cut at last newline to avoid splitting a line
      const lastNewline = truncated.lastIndexOf('\n')
      return {
        diff: (lastNewline > 0 ? truncated.slice(0, lastNewline) : truncated) +
          `\n\n... (diff truncated — full diff is ${Math.round(output.length / 1024)}KB, showing first ~${Math.round(MAX_DIFF_BYTES / 1024)}KB)`,
        truncated: true,
      }
    }

    return { diff: output, truncated: false }
  } catch (err) {
    console.warn(`fetchPrDiff: failed for ${repo} PR #${prNumber}:`, err)
    return { diff: '', truncated: false }
  }
}

/**
 * Fetch the list of changed files for a pull request with stats.
 *
 * @param repo     - GitHub repo in `owner/name` format.
 * @param prNumber - Pull request number.
 * @returns Formatted file list, or empty string on error.
 */
export async function fetchPrFiles(repo: string, prNumber: number): Promise<string> {
  try {
    const raw = await ghRunner([
      'api',
      `/repos/${repo}/pulls/${prNumber}/files`,
      '--paginate',
    ])
    const files = JSON.parse(raw) as Array<{
      filename: string
      status: string
      additions: number
      deletions: number
    }>

    if (!Array.isArray(files) || files.length === 0) return ''

    return files
      .map(f => `${f.filename} (${f.status}, +${f.additions}/-${f.deletions})`)
      .join('\n')
  } catch (err) {
    console.warn(`fetchPrFiles: failed for ${repo} PR #${prNumber}:`, err)
    return ''
  }
}

/**
 * Fetch commit messages for a pull request.
 *
 * @param repo     - GitHub repo in `owner/name` format.
 * @param prNumber - Pull request number.
 * @returns Formatted commit list, or empty string on error.
 */
/**
 * Fetch existing review comments (inline code comments) for a pull request.
 *
 * @param repo     - GitHub repo in `owner/name` format.
 * @param prNumber - Pull request number.
 * @returns Formatted comment list, or empty string on error.
 */
export async function fetchPrReviewComments(repo: string, prNumber: number): Promise<string> {
  try {
    const raw = await ghRunner([
      'api',
      `/repos/${repo}/pulls/${prNumber}/comments`,
      '--paginate',
    ])
    const comments = JSON.parse(raw) as Array<{
      path: string
      line: number | null
      body: string
      user: { login: string }
    }>

    if (!Array.isArray(comments) || comments.length === 0) return ''

    return comments
      .map(c => {
        const location = c.line ? `${c.path}:${c.line}` : c.path
        return `- ${c.user.login} on ${location}: ${c.body}`
      })
      .join('\n')
  } catch (err) {
    console.warn(`fetchPrReviewComments: failed for ${repo} PR #${prNumber}:`, err)
    return ''
  }
}

/**
 * Fetch review summaries (approve/request changes/comment) for a pull request.
 *
 * @param repo     - GitHub repo in `owner/name` format.
 * @param prNumber - Pull request number.
 * @returns Formatted review list, or empty string on error.
 */
export async function fetchPrReviews(repo: string, prNumber: number): Promise<string> {
  try {
    const raw = await ghRunner([
      'api',
      `/repos/${repo}/pulls/${prNumber}/reviews`,
      '--paginate',
    ])
    const reviews = JSON.parse(raw) as Array<{
      state: string
      body: string | null
      user: { login: string }
    }>

    if (!Array.isArray(reviews) || reviews.length === 0) return ''

    return reviews
      .filter(r => r.state !== 'PENDING')
      .map(r => `- ${r.user.login} (${r.state}): ${r.body || '(no summary)'}`)
      .join('\n')
  } catch (err) {
    console.warn(`fetchPrReviews: failed for ${repo} PR #${prNumber}:`, err)
    return ''
  }
}

/** HTML marker embedded in Codekin review comments for identification. */
export const REVIEW_COMMENT_MARKER = '<!-- codekin-review -->'

/**
 * Find an existing Codekin review summary comment on a PR.
 * Searches issue comments (top-level conversation comments) for the marker.
 *
 * @param repo     - GitHub repo in `owner/name` format.
 * @param prNumber - Pull request number.
 * @returns The comment ID if found, or undefined.
 */
export async function fetchExistingReviewComment(repo: string, prNumber: number): Promise<number | undefined> {
  try {
    const raw = await ghRunner([
      'api',
      `/repos/${repo}/issues/${prNumber}/comments`,
      '--paginate',
    ])
    const comments = JSON.parse(raw) as Array<{
      id: number
      body: string
    }>

    if (!Array.isArray(comments) || comments.length === 0) return undefined

    // Search in reverse to find the most recent matching comment
    for (let i = comments.length - 1; i >= 0; i--) {
      if (comments[i].body.includes(REVIEW_COMMENT_MARKER)) {
        return comments[i].id
      }
    }
    return undefined
  } catch (err) {
    console.warn(`fetchExistingReviewComment: failed for ${repo} PR #${prNumber}:`, err)
    return undefined
  }
}

export async function fetchPrCommits(repo: string, prNumber: number): Promise<string> {
  try {
    const raw = await ghRunner([
      'api',
      `/repos/${repo}/pulls/${prNumber}/commits`,
      '--paginate',
    ])
    const commits = JSON.parse(raw) as Array<{
      sha: string
      commit: { message: string }
    }>

    if (!Array.isArray(commits) || commits.length === 0) return ''

    return commits
      .map(c => `- ${c.sha.slice(0, 7)}: ${c.commit.message.split('\n')[0]}`)
      .join('\n')
  } catch (err) {
    console.warn(`fetchPrCommits: failed for ${repo} PR #${prNumber}:`, err)
    return ''
  }
}