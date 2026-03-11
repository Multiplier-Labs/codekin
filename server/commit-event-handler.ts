/**
 * Commit-review event dispatcher.
 *
 * Receives commit events from git post-commit hooks and dispatches
 * commit-review workflow runs after passing a multi-layer filter chain
 * for cycle prevention and deduplication.
 *
 * Filter chain (defense in depth):
 *   1. Branch filter — reject if `codekin/reports`
 *   2. Message filter — reject if message starts with any workflow commitMessage prefix
 *   3. Config lookup — reject if no enabled `commit-review` workflow for this repo
 *   4. Commit hash dedup — in-memory Map with 1h TTL, reject duplicates
 *   5. Concurrency cap — max 1 running commit-review per repo
 */

import { getWorkflowEngine } from './workflow-engine.js'
import { loadWorkflowConfig } from './workflow-config.js'
import { getWorkflowCommitPrefixes } from './workflow-loader.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CommitEvent {
  repoPath: string
  branch: string
  commitHash: string
  commitMessage: string
  author: string
}

export interface CommitEventResult {
  accepted: boolean
  reason?: string
  runId?: string
}

// ---------------------------------------------------------------------------
// CommitEventHandler
// ---------------------------------------------------------------------------

/** TTL for commit hash deduplication entries (1 hour). */
const DEDUP_TTL_MS = 60 * 60 * 1000

/** Interval for cleaning up expired dedup entries (10 minutes). */
const DEDUP_CLEANUP_INTERVAL_MS = 10 * 60 * 1000

export class CommitEventHandler {
  /** commitHash → timestamp of when it was recorded. */
  private seenCommits = new Map<string, number>()
  private cleanupTimer: ReturnType<typeof setInterval>

  constructor() {
    // Periodically prune expired dedup entries
    this.cleanupTimer = setInterval(() => this.pruneExpired(), DEDUP_CLEANUP_INTERVAL_MS)
  }

  /**
   * Process a commit event through the filter chain.
   * Returns accepted=true if a workflow run was dispatched.
   */
  async handle(event: CommitEvent): Promise<CommitEventResult> {
    // Layer 1: Branch filter
    if (event.branch === 'codekin/reports') {
      return { accepted: false, reason: 'Rejected: reports branch' }
    }

    // Layer 2: Message filter — reject if message starts with any workflow commit prefix
    const prefixes = getWorkflowCommitPrefixes()
    for (const prefix of prefixes) {
      if (event.commitMessage.startsWith(prefix)) {
        return { accepted: false, reason: `Rejected: workflow commit message (${prefix})` }
      }
    }

    // Layer 3: Config lookup — find an enabled commit-review workflow for this repo
    const config = loadWorkflowConfig()
    const repoConfig = config.reviewRepos.find(
      r => r.repoPath === event.repoPath && r.enabled && r.kind === 'commit-review'
    )
    if (!repoConfig) {
      return { accepted: false, reason: 'Rejected: no enabled commit-review config for this repo' }
    }

    // Layer 4: Commit hash dedup
    if (this.seenCommits.has(event.commitHash)) {
      return { accepted: false, reason: 'Rejected: duplicate commit hash' }
    }
    this.seenCommits.set(event.commitHash, Date.now())

    // Layer 5: Concurrency cap — max 1 running commit-review per repo
    const engine = getWorkflowEngine()
    const activeRuns = engine.listRuns({ kind: 'commit-review', status: 'running', limit: 100 })
    const hasActiveRun = activeRuns.some(
      run => (run.input as Record<string, unknown>).repoPath === event.repoPath
    )
    if (hasActiveRun) {
      return { accepted: false, reason: 'Rejected: commit-review already running for this repo' }
    }

    // All filters passed — dispatch the workflow
    try {
      const run = await engine.startRun('commit-review', {
        repoPath: event.repoPath,
        repoName: repoConfig.name,
        commitHash: event.commitHash,
        customPrompt: repoConfig.customPrompt,
        model: repoConfig.model,
      })

      console.log(`[commit-event] Dispatched commit-review run ${run.id} for ${event.repoPath} (${event.commitHash.slice(0, 8)})`)
      return { accepted: true, runId: run.id }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`[commit-event] Failed to start run for ${event.repoPath}:`, msg)
      return { accepted: false, reason: `Failed to start run: ${msg}` }
    }
  }

  /** Remove dedup entries older than the TTL. */
  private pruneExpired() {
    const cutoff = Date.now() - DEDUP_TTL_MS
    for (const [hash, ts] of this.seenCommits) {
      if (ts < cutoff) this.seenCommits.delete(hash)
    }
  }

  /** Clean up resources. */
  shutdown() {
    clearInterval(this.cleanupTimer)
    this.seenCommits.clear()
  }
}
