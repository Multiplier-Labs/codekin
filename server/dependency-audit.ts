/**
 * Dependency audit on dependency change.
 *
 * Activity-triggered, not wall-clock (expansion plan §4.3): a repo is audited
 * only when its dependency manifest (package.json / package-lock.json)
 * actually changed since the last audited commit. The sweep itself rides the
 * engine tick every 6 hours, but a repo whose manifests are untouched costs
 * one `git rev-parse` — `npm audit` runs only on real dependency movement.
 *
 * Alerts flow as durable `dependency-audit` signals when high/critical
 * counts change; remediation stays operator/child-run (`npm audit fix` is
 * proposed, never executed here).
 */

import { execFile, execFileSync } from 'child_process'
import { promisify } from 'util'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { loadWorkflowConfig } from './workflow-config.js'

const execFileAsync = promisify(execFile)

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AuditCounts {
  info: number
  low: number
  moderate: number
  high: number
  critical: number
}

interface RepoAuditState {
  /** Last audited (or examined-and-skipped) HEAD sha. */
  sha: string
  at: string
  counts?: AuditCounts
}

type AuditStateFile = Record<string, RepoAuditState>

/** IO seams — real git/npm in production, injected in tests. */
export interface DependencyAuditIo {
  headSha: (repoPath: string) => string | null
  /** Files changed between two commits; `null` when the diff fails (rewritten history) → treat as changed. */
  changedFiles: (repoPath: string, fromSha: string) => string[] | null
  hasLockfile: (repoPath: string) => boolean
  /** Vulnerability counts from `npm audit`; `null` when the audit itself fails. */
  runNpmAudit: (repoPath: string) => Promise<AuditCounts | null>
}

export type AuditSignalPublisher = (input: { kind: string; payload?: Record<string, unknown>; dedupeKey?: string; ttlMs?: number }) => void

const STATE_PATH = join(homedir(), '.codekin', 'dependency-audit.json')
const MANIFEST_RE = /(^|\/)package(-lock)?\.json$/
const SIGNAL_TTL_MS = 24 * 60 * 60 * 1000

// ---------------------------------------------------------------------------
// Default IO
// ---------------------------------------------------------------------------

function gitOut(repoPath: string, args: string[]): string | null {
  try {
    return execFileSync('git', args, { cwd: repoPath, timeout: 10_000 }).toString().trim()
  } catch {
    return null
  }
}

export function parseAuditCounts(stdout: string): AuditCounts | null {
  try {
    const parsed = JSON.parse(stdout) as { metadata?: { vulnerabilities?: Partial<AuditCounts> } }
    const v = parsed.metadata?.vulnerabilities
    if (!v) return null
    return { info: v.info ?? 0, low: v.low ?? 0, moderate: v.moderate ?? 0, high: v.high ?? 0, critical: v.critical ?? 0 }
  } catch {
    return null
  }
}

const DEFAULT_IO: DependencyAuditIo = {
  headSha: (repoPath) => gitOut(repoPath, ['rev-parse', 'HEAD']),
  changedFiles: (repoPath, fromSha) => {
    const out = gitOut(repoPath, ['diff', '--name-only', `${fromSha}..HEAD`])
    return out === null ? null : out.split('\n').filter(Boolean)
  },
  hasLockfile: (repoPath) => existsSync(join(repoPath, 'package-lock.json')),
  runNpmAudit: async (repoPath) => {
    try {
      const { stdout } = await execFileAsync('npm', ['audit', '--omit=dev', '--json'], {
        cwd: repoPath, timeout: 120_000, maxBuffer: 20 * 1024 * 1024,
      })
      return parseAuditCounts(stdout)
    } catch (err) {
      // npm audit exits non-zero when vulnerabilities exist — the JSON is still on stdout.
      const stdout = (err as { stdout?: string }).stdout
      return stdout ? parseAuditCounts(stdout) : null
    }
  },
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

function loadState(statePath: string): AuditStateFile {
  try {
    if (existsSync(statePath)) return JSON.parse(readFileSync(statePath, 'utf-8')) as AuditStateFile
  } catch (err) {
    console.error('[dependency-audit] Failed to load state:', err)
  }
  return {}
}

function saveState(statePath: string, state: AuditStateFile): void {
  const dir = join(statePath, '..')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileSync(statePath, JSON.stringify(state, null, 2), { encoding: 'utf-8', mode: 0o600 })
}

/** Alert when actionable (high+critical) exposure exists and has changed. */
export function shouldAlert(previous: AuditCounts | undefined, current: AuditCounts): boolean {
  const actionable = current.high + current.critical
  if (actionable === 0) return false
  const prevActionable = previous ? previous.high + previous.critical : -1
  return actionable !== prevActionable
}

// ---------------------------------------------------------------------------
// Sweep
// ---------------------------------------------------------------------------

export async function runDependencyAuditSweep(opts: {
  publish: AuditSignalPublisher
  io?: Partial<DependencyAuditIo>
  statePath?: string
  repoPaths?: string[]
}): Promise<void> {
  const io: DependencyAuditIo = { ...DEFAULT_IO, ...opts.io }
  const statePath = opts.statePath ?? STATE_PATH
  const repoPaths = opts.repoPaths ?? [...new Set(loadWorkflowConfig().reviewRepos.map(r => r.repoPath))]
  const state = loadState(statePath)
  let dirty = false

  for (const repoPath of repoPaths) {
    try {
      const sha = io.headSha(repoPath)
      if (!sha) continue

      const prior = state[repoPath]
      if (prior?.sha === sha) continue // nothing moved since last look

      // Only audit when the dependency manifests actually changed. A failed
      // diff (rewritten history) counts as changed — err toward auditing.
      if (prior) {
        const changed = io.changedFiles(repoPath, prior.sha)
        if (changed !== null && !changed.some(f => MANIFEST_RE.test(f))) {
          state[repoPath] = { ...prior, sha, at: new Date().toISOString() }
          dirty = true
          continue
        }
      }

      if (!io.hasLockfile(repoPath)) {
        state[repoPath] = { sha, at: new Date().toISOString() }
        dirty = true
        continue
      }

      const counts = await io.runNpmAudit(repoPath)
      if (!counts) {
        console.error(`[dependency-audit] npm audit failed for ${repoPath} — will retry next sweep`)
        continue // state untouched: retried on the next sweep
      }

      if (shouldAlert(prior?.counts, counts)) {
        const repoName = repoPath.split('/').pop() ?? repoPath
        opts.publish({
          kind: 'dependency-audit',
          payload: { repoPath, repoName, sha, counts, previous: prior?.counts ?? null },
          dedupeKey: `dependency-audit::${repoPath}::${sha}`,
          ttlMs: SIGNAL_TTL_MS,
        })
      }

      state[repoPath] = { sha, at: new Date().toISOString(), counts }
      dirty = true
    } catch (err) {
      console.error(`[dependency-audit] Sweep error for ${repoPath}:`, err)
    }
  }

  if (dirty) saveState(statePath, state)
}
