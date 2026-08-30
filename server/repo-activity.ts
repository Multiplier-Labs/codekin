/**
 * Repo Activity Index — the ambient "is this repo alive?" signal store.
 *
 * One row per repo, fed by cheap local sources: last commit (git log, no
 * network), session activity (aggregated per repo), commit events from the
 * post-commit hook, and PR events from the GitHub webhook stack. From those
 * signals each repo gets a tier:
 *
 *   active  — a signal within 7 days  → full configured workflow cadence
 *   cooling — 7–30 days              → scheduled workflows throttled to weekly
 *   dormant — 30+ days               → scheduled workflows held until it wakes
 *
 * There is deliberately no polling loop here (trigger-engine principle: no
 * new intervals). Rows refresh lazily — `getFresh()` re-reads git/session
 * state when a row is older than 15 minutes — and event bumps keep hot repos
 * current in real time. Reactivation is automatic: any new signal on a
 * dormant repo restores `active` and the dispatch gate opens on the next fire.
 */

import Database from 'better-sqlite3'
import { execFileSync } from 'child_process'
import { existsSync, chmodSync } from 'fs'
import { defaultRunsDbPath } from './run-db.js'
import { loadWorkflowConfig } from './workflow-config.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ActivityTier = 'active' | 'cooling' | 'dormant'

export interface RepoActivity {
  repoPath: string
  lastCommitAt: string | null
  lastCommitSha: string | null
  lastSessionAt: string | null
  lastCommitEventAt: string | null
  lastPrEventAt: string | null
  /** Max of all signal timestamps — what the tier is computed from. */
  lastSignalAt: string | null
  tier: ActivityTier
  updatedAt: string
}

export interface ActivityTransition {
  repoPath: string
  from: ActivityTier | null
  to: ActivityTier
}

/** Read a repo's latest commit; `null` when unavailable (not a git repo, no commits). */
export type GitInfoResolver = (repoPath: string) => { sha: string; committedAt: string } | null
/** Most recent session activity for a repo (ISO), or `null` when none. */
export type SessionActivityResolver = (repoPath: string) => string | null

const ACTIVE_WITHIN_DAYS = 7
const DORMANT_AFTER_DAYS = 30
const DAY_MS = 24 * 60 * 60 * 1000
/** How stale a row may be before `getFresh()` re-reads git/session state. */
const FRESHNESS_MS = 15 * 60 * 1000

// ---------------------------------------------------------------------------
// Default resolvers
// ---------------------------------------------------------------------------

function defaultGitInfo(repoPath: string): { sha: string; committedAt: string } | null {
  try {
    const out = execFileSync('git', ['log', '-1', '--format=%H %cI'], { cwd: repoPath, timeout: 5000 })
      .toString().trim()
    const [sha, committedAt] = out.split(' ')
    if (!sha || !committedAt) return null
    return { sha, committedAt: new Date(committedAt).toISOString() }
  } catch {
    return null
  }
}

/** Extract `owner/repo` (lowercased) from a repo's origin remote, or `null`. */
export function repoSlugFromRemote(repoPath: string): string | null {
  try {
    const url = execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: repoPath, timeout: 5000 })
      .toString().trim()
    const match = /github\.com[:/]([^/]+\/[^/\s]+?)(?:\.git)?$/.exec(url)
    return match ? match[1].toLowerCase() : null
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Index
// ---------------------------------------------------------------------------

export class RepoActivityIndex {
  private db: Database.Database
  private gitInfo: GitInfoResolver
  private sessionActivity: SessionActivityResolver
  /** repoPath → origin slug, cached for PR-event resolution. */
  private slugCache = new Map<string, string | null>()

  constructor(opts?: {
    dbPath?: string
    gitInfo?: GitInfoResolver
    sessionActivity?: SessionActivityResolver
  }) {
    const resolvedPath = opts?.dbPath ?? defaultRunsDbPath()
    this.db = new Database(resolvedPath, { fileMustExist: false })
    if (resolvedPath !== ':memory:' && existsSync(resolvedPath)) chmodSync(resolvedPath, 0o600)
    this.db.pragma('journal_mode = WAL')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS repo_activity (
        repo_path TEXT PRIMARY KEY,
        last_commit_at TEXT,
        last_commit_sha TEXT,
        last_session_at TEXT,
        last_commit_event_at TEXT,
        last_pr_event_at TEXT,
        tier TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `)
    this.gitInfo = opts?.gitInfo ?? defaultGitInfo
    this.sessionActivity = opts?.sessionActivity ?? (() => null)
  }

  close(): void {
    this.db.close()
  }

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  get(repoPath: string): RepoActivity | null {
    const row = this.db.prepare(`SELECT * FROM repo_activity WHERE repo_path = ?`).get(repoPath) as
      Record<string, unknown> | undefined
    return row ? this.rowToActivity(row) : null
  }

  list(): RepoActivity[] {
    return (this.db.prepare(`SELECT * FROM repo_activity ORDER BY repo_path`).all() as Record<string, unknown>[])
      .map(row => this.rowToActivity(row))
  }

  /**
   * The dispatch-gate entry point: return the repo's activity, re-reading
   * git/session state when the stored row is missing or older than 15 minutes.
   */
  getFresh(repoPath: string, now: Date = new Date()): RepoActivity {
    const existing = this.get(repoPath)
    if (existing && now.getTime() - new Date(existing.updatedAt).getTime() < FRESHNESS_MS) {
      return existing
    }
    return this.refresh(repoPath, now).activity
  }

  // -------------------------------------------------------------------------
  // Writes
  // -------------------------------------------------------------------------

  /** Re-read git and session state for one repo and recompute its tier. */
  refresh(repoPath: string, now: Date = new Date()): { activity: RepoActivity; transition: ActivityTransition | null } {
    const previous = this.get(repoPath)
    const git = this.gitInfo(repoPath)
    const sessionAt = this.sessionActivity(repoPath)

    const record: RepoActivity = this.finalize({
      repoPath,
      lastCommitAt: git?.committedAt ?? previous?.lastCommitAt ?? null,
      lastCommitSha: git?.sha ?? previous?.lastCommitSha ?? null,
      lastSessionAt: sessionAt ?? previous?.lastSessionAt ?? null,
      lastCommitEventAt: previous?.lastCommitEventAt ?? null,
      lastPrEventAt: previous?.lastPrEventAt ?? null,
    }, now)

    this.persist(record)
    const transition = record.tier !== previous?.tier
      ? { repoPath, from: previous?.tier ?? null, to: record.tier }
      : null
    return { activity: record, transition }
  }

  /** Refresh a set of repos and report tier transitions (monitor entry point). */
  sweep(repoPaths: string[], now: Date = new Date()): ActivityTransition[] {
    const transitions: ActivityTransition[] = []
    for (const repoPath of repoPaths) {
      const { transition } = this.refresh(repoPath, now)
      if (transition) transitions.push(transition)
    }
    return transitions
  }

  /** A commit landed (post-commit hook) — bump and re-read git state immediately. */
  recordCommitEvent(repoPath: string, now: Date = new Date()): void {
    const previous = this.get(repoPath)
    const git = this.gitInfo(repoPath)
    const record = this.finalize({
      repoPath,
      lastCommitAt: git?.committedAt ?? previous?.lastCommitAt ?? null,
      lastCommitSha: git?.sha ?? previous?.lastCommitSha ?? null,
      lastSessionAt: previous?.lastSessionAt ?? null,
      lastCommitEventAt: now.toISOString(),
      lastPrEventAt: previous?.lastPrEventAt ?? null,
    }, now)
    this.persist(record)
  }

  /**
   * A PR event arrived from the webhook stack, which only knows the GitHub
   * slug. Match it against the origin remotes of configured review repos
   * (cached) and bump the matching repo, if any.
   */
  recordPrEventBySlug(slug: string, now: Date = new Date()): string | null {
    const wanted = slug.toLowerCase()
    const repoPaths = [...new Set(loadWorkflowConfig().reviewRepos.map(r => r.repoPath))]
    for (const repoPath of repoPaths) {
      if (!this.slugCache.has(repoPath)) this.slugCache.set(repoPath, repoSlugFromRemote(repoPath))
      if (this.slugCache.get(repoPath) !== wanted) continue

      const previous = this.get(repoPath)
      const record = this.finalize({
        repoPath,
        lastCommitAt: previous?.lastCommitAt ?? null,
        lastCommitSha: previous?.lastCommitSha ?? null,
        lastSessionAt: previous?.lastSessionAt ?? null,
        lastCommitEventAt: previous?.lastCommitEventAt ?? null,
        lastPrEventAt: now.toISOString(),
      }, now)
      this.persist(record)
      return repoPath
    }
    return null
  }

  // -------------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------------

  private finalize(signals: Omit<RepoActivity, 'lastSignalAt' | 'tier' | 'updatedAt'>, now: Date): RepoActivity {
    const timestamps = [signals.lastCommitAt, signals.lastSessionAt, signals.lastCommitEventAt, signals.lastPrEventAt]
      .filter((t): t is string => !!t)
    const lastSignalAt = timestamps.length ? timestamps.reduce((a, b) => (a > b ? a : b)) : null

    let tier: ActivityTier = 'dormant'
    if (lastSignalAt) {
      const age = now.getTime() - new Date(lastSignalAt).getTime()
      if (age < ACTIVE_WITHIN_DAYS * DAY_MS) tier = 'active'
      else if (age < DORMANT_AFTER_DAYS * DAY_MS) tier = 'cooling'
    }

    return { ...signals, lastSignalAt, tier, updatedAt: now.toISOString() }
  }

  private persist(record: RepoActivity): void {
    this.db.prepare(`
      INSERT INTO repo_activity (repo_path, last_commit_at, last_commit_sha, last_session_at, last_commit_event_at, last_pr_event_at, tier, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(repo_path) DO UPDATE SET
        last_commit_at = excluded.last_commit_at,
        last_commit_sha = excluded.last_commit_sha,
        last_session_at = excluded.last_session_at,
        last_commit_event_at = excluded.last_commit_event_at,
        last_pr_event_at = excluded.last_pr_event_at,
        tier = excluded.tier,
        updated_at = excluded.updated_at
    `).run(
      record.repoPath, record.lastCommitAt, record.lastCommitSha, record.lastSessionAt,
      record.lastCommitEventAt, record.lastPrEventAt, record.tier, record.updatedAt,
    )
  }

  private rowToActivity(row: Record<string, unknown>): RepoActivity {
    const signals = {
      repoPath: row.repo_path as string,
      lastCommitAt: row.last_commit_at as string | null,
      lastCommitSha: row.last_commit_sha as string | null,
      lastSessionAt: row.last_session_at as string | null,
      lastCommitEventAt: row.last_commit_event_at as string | null,
      lastPrEventAt: row.last_pr_event_at as string | null,
    }
    const timestamps = [signals.lastCommitAt, signals.lastSessionAt, signals.lastCommitEventAt, signals.lastPrEventAt]
      .filter((t): t is string => !!t)
    return {
      ...signals,
      lastSignalAt: timestamps.length ? timestamps.reduce((a, b) => (a > b ? a : b)) : null,
      tier: row.tier as ActivityTier,
      updatedAt: row.updated_at as string,
    }
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let instance: RepoActivityIndex | null = null

export function initRepoActivityIndex(opts?: ConstructorParameters<typeof RepoActivityIndex>[0]): RepoActivityIndex {
  instance?.close()
  instance = new RepoActivityIndex(opts)
  return instance
}

/** The index, or `null` when not initialized — bump call sites fail open. */
export function tryGetRepoActivityIndex(): RepoActivityIndex | null {
  return instance
}

export function shutdownRepoActivityIndex(): void {
  instance?.close()
  instance = null
}
