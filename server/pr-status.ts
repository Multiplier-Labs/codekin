/**
 * Read-only pull request status for a session's branch, via the `gh` CLI.
 *
 * Every non-success outcome has its own state — no GitHub remote, gh
 * missing, not authenticated, rate limited, lookup error — so the UI never
 * mistakes "unknown" for "passing". Results are cached per repository and
 * branch; a failed refresh keeps showing the last good result, marked stale.
 *
 * GitHub checks describe the PR's remote head. Each PR therefore carries how
 * the local branch relates to that head (commits not pushed, remote commits
 * not pulled), and the status says whether the working tree has edits that
 * no check has seen.
 */

import { execFile } from 'child_process'
import { promisify } from 'util'
import { execGit, getFileStatuses } from './diff-manager.js'
import type { PrChecksSummary, PrLookupState, PrStatus, PullRequestInfo } from './types.js'

const execFileAsync = promisify(execFile)

const GH_TIMEOUT_MS = 20_000
/** How long a lookup is reused before gh is called again (unless forced). */
export const PR_STATUS_TTL_MS = 60_000
/** Names of failing checks listed in the card. */
const MAX_FAILING_NAMES = 5

const PR_FIELDS = [
  'number', 'title', 'url', 'state', 'isDraft', 'baseRefName', 'headRefName', 'headRefOid',
  'isCrossRepository', 'headRepositoryOwner', 'updatedAt', 'statusCheckRollup', 'reviewDecision',
].join(',')

type GhRunner = (args: string[], cwd: string) => Promise<string>

let ghRunner: GhRunner = async (args, cwd) => {
  const { stdout } = await execFileAsync('gh', args, { cwd, timeout: GH_TIMEOUT_MS })
  return stdout
}

/** @internal Test-only: replace the gh runner. */
export function _setPrStatusRunner(runner: GhRunner): void {
  ghRunner = runner
}

const cache = new Map<string, PrStatus>()

/** @internal Test-only: forget cached lookups. */
export function _clearPrStatusCache(): void {
  cache.clear()
}

interface RawCheck {
  __typename?: string
  name?: string
  context?: string
  status?: string
  conclusion?: string
  state?: string
}

interface RawPull {
  number: number
  title: string
  url: string
  state: string
  isDraft: boolean
  baseRefName: string
  headRefName: string
  headRefOid: string
  isCrossRepository: boolean
  headRepositoryOwner?: { login?: string } | null
  updatedAt: string
  statusCheckRollup?: RawCheck[] | null
  reviewDecision?: string | null
}

const FAILED = new Set(['FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE'])
const SKIPPED = new Set(['SKIPPED', 'NEUTRAL', 'STALE'])

/** Collapse GitHub check runs and commit statuses into counts. */
export function summarizeChecks(rollup: RawCheck[] | null | undefined): PrChecksSummary {
  const summary: PrChecksSummary = { total: 0, passed: 0, failed: 0, pending: 0, skipped: 0, failing: [] }
  for (const check of rollup ?? []) {
    summary.total++
    // CheckRun: status + conclusion. StatusContext: state.
    const outcome = check.__typename === 'StatusContext' || (check.state && !check.status)
      ? (check.state ?? '')
      : check.status === 'COMPLETED' ? (check.conclusion ?? '') : 'PENDING'
    if (outcome === 'SUCCESS') summary.passed++
    else if (FAILED.has(outcome)) {
      summary.failed++
      if (summary.failing.length < MAX_FAILING_NAMES) summary.failing.push(check.name ?? check.context ?? 'unnamed check')
    } else if (SKIPPED.has(outcome)) summary.skipped++
    else summary.pending++
  }
  return summary
}

/** Classify a gh failure into a state the UI can explain. */
export function classifyGhError(err: unknown): { state: PrLookupState; message: string } {
  const code = err && typeof err === 'object' && 'code' in err ? err.code : undefined
  if (code === 'ENOENT') return { state: 'gh_missing', message: 'The GitHub CLI (gh) is not installed on this machine.' }
  const stderr = err && typeof err === 'object' && 'stderr' in err && typeof err.stderr === 'string' ? err.stderr : ''
  const text = `${stderr} ${err instanceof Error ? err.message : ''}`
  if (/gh auth login|not logged in|authentication|HTTP 401|bad credentials/i.test(text)) {
    return { state: 'unauthenticated', message: 'The GitHub CLI is not signed in. Run `gh auth login` on this machine.' }
  }
  if (/rate limit/i.test(text)) return { state: 'rate_limited', message: 'GitHub rate limit reached. Try again later.' }
  if (/no git remotes|none of the git remotes|could not determine|not a git repository|could not resolve to a repository|no github/i.test(text)) {
    return { state: 'no_github_remote', message: 'This repository has no GitHub remote.' }
  }
  return { state: 'error', message: (stderr.trim() || (err instanceof Error ? err.message : String(err))).slice(0, 300) }
}

async function countCommits(range: string, cwd: string): Promise<number | null> {
  try {
    return Number((await execGit(['rev-list', '--count', range], cwd)).trim())
  } catch {
    return null
  }
}

async function commitKnownLocally(sha: string, cwd: string): Promise<boolean> {
  try {
    await execGit(['cat-file', '-e', `${sha}^{commit}`], cwd)
    return true
  } catch {
    return false
  }
}

/** How the local HEAD relates to a PR's remote head; null counts when that head is not fetched. */
async function compareWithPrHead(headRefOid: string, localHead: string, cwd: string): Promise<{ ahead: number | null; behind: number | null }> {
  if (headRefOid === localHead) return { ahead: 0, behind: 0 }
  if (!(await commitKnownLocally(headRefOid, cwd))) return { ahead: null, behind: null }
  return {
    ahead: await countCommits(`${headRefOid}..${localHead}`, cwd),
    behind: await countCommits(`${localHead}..${headRefOid}`, cwd),
  }
}

/** Open PRs first, then most recently updated. */
function comparePulls(a: PullRequestInfo, b: PullRequestInfo): number {
  if ((a.state === 'OPEN') !== (b.state === 'OPEN')) return a.state === 'OPEN' ? -1 : 1
  return b.updatedAt.localeCompare(a.updatedAt)
}

/**
 * Look up pull requests whose head is the branch checked out at `cwd`.
 * Cached for {@link PR_STATUS_TTL_MS} per repository and branch unless `refresh`.
 */
export async function getPrStatus(cwd: string, opts: { refresh?: boolean } = {}): Promise<PrStatus> {
  const now = new Date().toISOString()
  let branch: string
  let localHead: string
  let repoKey: string
  try {
    branch = (await execGit(['rev-parse', '--abbrev-ref', 'HEAD'], cwd)).trim()
    localHead = (await execGit(['rev-parse', 'HEAD'], cwd)).trim()
    repoKey = (await execGit(['rev-parse', '--path-format=absolute', '--git-common-dir'], cwd)).trim()
  } catch {
    return { state: 'none', message: 'This session is not on a git branch with commits.', pulls: [], dirty: false, fetchedAt: now }
  }
  if (branch === 'HEAD') {
    return { state: 'none', message: 'Detached HEAD: there is no branch to find a pull request for.', pulls: [], dirty: false, fetchedAt: now }
  }

  const key = `${repoKey}::${branch}`
  const cached = cache.get(key)
  const dirty = await getFileStatuses(cwd).then(s => Object.keys(s).length > 0).catch(() => false)

  let status: PrStatus
  if (cached && !opts.refresh && Date.now() - Date.parse(cached.fetchedAt) < PR_STATUS_TTL_MS) {
    status = cached
  } else {
    try {
      const raw = JSON.parse(await ghRunner(['pr', 'list', '--head', branch, '--state', 'all', '--limit', '10', '--json', PR_FIELDS], cwd)) as RawPull[]
      const pulls = raw
        .filter(p => p.headRefName === branch)
        .map((p): PullRequestInfo => ({
          number: p.number,
          title: p.title,
          url: p.url,
          state: p.state === 'MERGED' || p.state === 'CLOSED' ? p.state : 'OPEN',
          isDraft: p.isDraft,
          baseRefName: p.baseRefName,
          headRefName: p.headRefName,
          headRefOid: p.headRefOid,
          isCrossRepository: p.isCrossRepository,
          headOwner: p.headRepositoryOwner?.login ?? undefined,
          updatedAt: p.updatedAt,
          reviewDecision: p.reviewDecision || undefined,
          checks: summarizeChecks(p.statusCheckRollup),
          ahead: null,
          behind: null,
        }))
        .sort(comparePulls)
      status = { state: pulls.length ? 'found' : 'none', branch, pulls, dirty: false, fetchedAt: now }
      if (!pulls.length) status.message = `No pull request found for ${branch}.`
      cache.set(key, status)
    } catch (err) {
      const { state, message } = classifyGhError(err)
      // Keep showing the last good answer, clearly marked, rather than nothing.
      if (cached?.state === 'found') {
        status = { ...cached, staleReason: `Could not refresh: ${message}` }
      } else {
        return { state, message, branch, pulls: [], dirty, fetchedAt: now }
      }
    }
  }

  // Local comparisons are cheap and always current, even for a cached lookup.
  const pulls = await Promise.all(status.pulls.map(async p => ({ ...p, ...(await compareWithPrHead(p.headRefOid, localHead, cwd)) })))
  return { ...status, pulls, dirty }
}

/**
 * The base branch to review against, from a cached lookup only (no network):
 * the single open, same-repository PR for `branch`. Fork PRs are skipped —
 * their base lives in another repository.
 */
export function cachedPrBase(repoKey: string, branch: string): string | null {
  const status = cache.get(`${repoKey}::${branch}`)
  if (status?.state !== 'found') return null
  const open = status.pulls.filter(p => p.state === 'OPEN' && !p.isCrossRepository)
  return open.length === 1 ? open[0].baseRefName : null
}

/** {@link cachedPrBase} for the branch checked out at `cwd`; null when unknown. */
export async function cachedPrBaseFor(cwd: string): Promise<string | null> {
  try {
    const branch = (await execGit(['rev-parse', '--abbrev-ref', 'HEAD'], cwd)).trim()
    const repoKey = (await execGit(['rev-parse', '--path-format=absolute', '--git-common-dir'], cwd)).trim()
    return branch === 'HEAD' ? null : cachedPrBase(repoKey, branch)
  } catch {
    return null
  }
}
