/**
 * GitHub API helpers for webhook processing.
 *
 * All functions delegate to the `gh` CLI rather than calling the REST API
 * directly, so authentication is handled by the ambient `gh auth` credential
 * store.  Each function degrades gracefully — errors are logged as warnings
 * and an empty/zero-value result is returned so callers can proceed with
 * partial data rather than failing the entire webhook event.
 */

import { execFile } from 'child_process'
import { promisify } from 'util'
import type { Annotation, JobInfo } from './webhook-types.js'

const execFileAsync = promisify(execFile)
/** Generous timeout for gh CLI calls — GH API can be slow under load. */
const GH_TIMEOUT_MS = 30_000

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
 * Check whether the `gh` CLI is available, authenticated, and has API access.
 * Runs three sequential checks: PATH lookup, auth status, and API connectivity.
 */
export async function checkGhHealth(): Promise<{ available: boolean; reason?: string }> {
  try {
    await ghRunner(['--version'])
  } catch {
    return { available: false, reason: 'gh CLI is not installed or not on PATH' }
  }

  try {
    await ghRunner(['auth', 'status'])
  } catch {
    return { available: false, reason: 'gh CLI is not authenticated (run gh auth login)' }
  }

  try {
    await ghRunner(['api', '/user'])
  } catch {
    return { available: false, reason: 'gh CLI cannot access the GitHub API' }
  }

  return { available: true }
}

/**
 * Fetch the failed job logs for a workflow run, truncated to the last N lines.
 * Returns empty string on error.
 */
export async function fetchFailedLogs(repo: string, runId: number, maxLines: number): Promise<string> {
  try {
    const output = await ghRunner(['run', 'view', String(runId), '--repo', repo, '--log-failed'])
    const lines = output.split('\n')
    if (lines.length > maxLines) {
      return lines.slice(-maxLines).join('\n')
    }
    return output
  } catch (err) {
    console.warn(`fetchFailedLogs: failed for ${repo} run ${runId}:`, err)
    return ''
  }
}

/**
 * Fetch job information for a workflow run via the GitHub API.
 * Returns empty array on error.
 */
export async function fetchJobs(repo: string, runId: number): Promise<JobInfo[]> {
  try {
    const raw = await ghRunner(['api', `/repos/${repo}/actions/runs/${runId}/jobs`, '--paginate'])
    const data = JSON.parse(raw) as { jobs?: Array<{
      id: number
      name: string
      conclusion: string | null
      steps?: Array<{ name: string; number: number; conclusion: string | null }>
    }> }

    if (!data.jobs || !Array.isArray(data.jobs)) {
      return []
    }

    return data.jobs.map(job => ({
      id: job.id,
      name: job.name,
      conclusion: job.conclusion ?? 'unknown',
      steps: (job.steps ?? []).map(step => ({
        name: step.name,
        number: step.number,
        conclusion: step.conclusion ?? 'unknown',
      })),
    }))
  } catch (err) {
    console.warn(`fetchJobs: failed for ${repo} run ${runId}:`, err)
    return []
  }
}

/**
 * Fetch annotations for failed check runs in a check suite.
 * Traverses: check-suite -> check-runs (filtered by failure) -> annotations.
 * Returns what we have so far on error at any step.
 */
export async function fetchAnnotations(repo: string, checkSuiteId: number): Promise<Annotation[]> {
  const annotations: Annotation[] = []

  let checkRuns: Array<{ id: number; conclusion: string | null }>
  try {
    const raw = await ghRunner([
      'api',
      `/repos/${repo}/check-suites/${checkSuiteId}/check-runs?per_page=100`,
    ])
    const data = JSON.parse(raw) as {
      check_runs?: Array<{ id: number; conclusion: string | null }>
    }
    checkRuns = data.check_runs ?? []
  } catch (err) {
    console.warn(`fetchAnnotations: failed to fetch check runs for ${repo} suite ${checkSuiteId}:`, err)
    return annotations
  }

  const failedRuns = checkRuns.filter(cr => cr.conclusion === 'failure')

  for (const run of failedRuns) {
    try {
      const raw = await ghRunner([
        'api',
        `/repos/${repo}/check-runs/${run.id}/annotations?per_page=50`,
      ])
      const items = JSON.parse(raw) as Array<{
        path: string
        start_line: number
        end_line: number
        message: string
        annotation_level: string
      }>

      if (Array.isArray(items)) {
        for (const item of items) {
          annotations.push({
            path: item.path,
            startLine: item.start_line,
            endLine: item.end_line,
            message: item.message,
            annotationLevel: item.annotation_level,
          })
        }
      }
    } catch (err) {
      console.warn(`fetchAnnotations: failed to fetch annotations for check run ${run.id}:`, err)
      // Continue with remaining check runs
    }
  }

  return annotations
}

/**
 * Fetch the commit message for a given SHA.
 * Returns empty string on error.
 */
export async function fetchCommitMessage(repo: string, sha: string): Promise<string> {
  try {
    const output = await ghRunner(['api', `/repos/${repo}/git/commits/${sha}`, '--jq', '.message'])
    return output.trim()
  } catch (err) {
    console.warn(`fetchCommitMessage: failed for ${repo} sha ${sha}:`, err)
    return ''
  }
}

/**
 * Fetch the title of a pull request.
 * Returns empty string on error.
 */
export async function fetchPRTitle(repo: string, prNumber: number): Promise<string> {
  try {
    const output = await ghRunner(['api', `/repos/${repo}/pulls/${prNumber}`, '--jq', '.title'])
    return output.trim()
  } catch (err) {
    console.warn(`fetchPRTitle: failed for ${repo} PR #${prNumber}:`, err)
    return ''
  }
}
