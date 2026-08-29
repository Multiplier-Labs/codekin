/**
 * Orchestrator proactive monitor — watches for new reports, idle repos,
 * and workflow events, then queues notifications for the orchestrator session.
 *
 * Runs a periodic poll and subscribes to workflow engine events.
 * Notifications are delivered in-chat via the orchestrator session.
 */

import { readdirSync, statSync, existsSync } from 'fs'
import { join } from 'path'
import type { SessionManager } from './session-manager.js'
import type { WorkflowEngine, WorkflowEvent } from './workflow-engine.js'
import type { GoalRunEvent } from './goal-run-store.js'
import { scanRepoReports } from './orchestrator-reports.js'
import { OrchestratorMemory } from './orchestrator-memory.js'
import { runAgingCycle, getPendingOutcomeAssessments } from './orchestrator-learning.js'
import { getOrchestratorSessionId } from './orchestrator-manager.js'
import { getOrchestratorOutbox } from './orchestrator-outbox.js'
import { REPOS_ROOT, getAgentDisplayName } from './config.js'
import { loadWorkflowConfig, type ReviewRepoConfig } from './workflow-config.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface OrchestratorNotification {
  id: string
  severity: 'info' | 'action' | 'alert'
  title: string
  body: string
  timestamp: string
  delivered: boolean
}

// ---------------------------------------------------------------------------
// Monitor
// ---------------------------------------------------------------------------

const POLL_INTERVAL_MS = 15 * 60 * 1000  // 15 minutes
/** Cap on the goal-run notification dedup set (oldest entries dropped). */
const MAX_NOTED_GOAL_RUN_STATES = 500
const PASSIVE_THRESHOLD_DAYS = 30

export class OrchestratorMonitor {
  private sessions: SessionManager
  private pollTimer: ReturnType<typeof setInterval> | null = null
  private agingTimer: ReturnType<typeof setInterval> | null = null
  private notifications: OrchestratorNotification[] = []
  private seenReports = new Set<string>()
  /** (runId:status) pairs already notified — see handleGoalRunEvent. */
  private notedGoalRunStates = new Set<string>()
  private memory: OrchestratorMemory | null = null

  constructor(sessions: SessionManager) {
    this.sessions = sessions
  }

  /** Connect to the workflow engine for event-driven notifications. */
  setEngine(engine: WorkflowEngine): void {
    engine.on('workflow_event', (event: WorkflowEvent) => {
      this.handleWorkflowEvent(event)
    })
  }

  /** Set the memory store for aging and decision tracking. */
  setMemory(memory: OrchestratorMemory): void {
    this.memory = memory
  }

  /** Start the periodic poll. */
  start(): void {
    if (this.pollTimer) return
    console.log('[orchestrator-monitor] Starting proactive monitor (poll every 15m)')

    // Initial scan to populate seen reports
    void this.initialScan()

    this.pollTimer = setInterval(() => {
      void this.poll()
    }, POLL_INTERVAL_MS)

    // Run aging cycle daily (check every 6 hours)
    this.agingTimer = setInterval(() => {
      this.runAgingAndAssessments()
    }, 6 * 60 * 60 * 1000)
  }

  /** Stop the monitor. */
  stop(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer)
      this.pollTimer = null
    }
    if (this.agingTimer) {
      clearInterval(this.agingTimer)
      this.agingTimer = null
    }
  }

  /** Get pending (undelivered) notifications. */
  getPending(): OrchestratorNotification[] {
    return this.notifications.filter(n => !n.delivered)
  }

  /** Mark notifications as delivered. */
  markDelivered(ids: string[]): void {
    for (const n of this.notifications) {
      if (ids.includes(n.id)) n.delivered = true
    }
  }

  /** Get all notifications (including delivered). */
  getAll(): OrchestratorNotification[] {
    return [...this.notifications].sort((a, b) => b.timestamp.localeCompare(a.timestamp))
  }

  // -------------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------------

  /** Run aging cycle and check for pending decision assessments. */
  private runAgingAndAssessments(): void {
    if (!this.memory) return

    try {
      const agingResult = runAgingCycle(this.memory)
      if (agingResult.expired > 0 || agingResult.compacted > 0) {
        console.log(`[orchestrator-monitor] Aging cycle: ${agingResult.expired} expired, ${agingResult.compacted} compacted, ${agingResult.decayed} decayed`)
      }

      // Check for decisions that need outcome assessment
      const pending = getPendingOutcomeAssessments(this.memory)
      if (pending.length > 0) {
        this.addNotification({
          severity: 'info',
          title: 'Decisions need review',
          body: `${pending.length} decision(s) from over a week ago need outcome assessment. Ask me to review them.`,
        })
      }
    } catch (err) {
      console.error('[orchestrator-monitor] Aging cycle error:', err)
    }
  }

  /** Initial scan — populate the set of already-seen reports. */
  private async initialScan(): Promise<void> {
    const repoPaths = this.discoverRepoPaths()
    for (const repoPath of repoPaths) {
      const reports = scanRepoReports(repoPath)
      for (const r of reports) {
        this.seenReports.add(r.filePath)
      }
    }
    // initial scan complete
  }

  /** Periodic poll — check for new reports and idle repos. */
  private async poll(): Promise<void> {
    // Skip the entire poll if the rate-limit circuit breaker is open. This
    // is the dominant source of background API calls; continuing to poke
    // the orchestrator session during a cooldown just deepens the hole.
    if (this.sessions.isRateLimited()) {
      console.log('[orchestrator-monitor] rate-limit circuit breaker open — skipping poll')
      return
    }

    const repoPaths = this.discoverRepoPaths()

    // Check for new reports
    this.checkNewReports(repoPaths)

    // Check for passive repos
    this.checkPassiveRepos(repoPaths)

    // initial scan complete
  }

  /** Check for reports we haven't seen before. */
  private checkNewReports(repoPaths: string[]): void {
    for (const repoPath of repoPaths) {
      const reports = scanRepoReports(repoPath)
      const newReports = reports.filter(r => !this.seenReports.has(r.filePath))

      if (newReports.length > 0) {
        for (const r of newReports) {
          this.seenReports.add(r.filePath)
        }

        const repoName = repoPath.split('/').pop() ?? repoPath
        const categories = [...new Set(newReports.map(r => r.category))]

        this.addNotification({
          severity: 'action',
          title: `New reports for ${repoName}`,
          body: `${newReports.length} new report(s) landed: ${categories.join(', ')}. Want a summary?`,
        })
      }
    }
  }

  /** Check for repos that haven't had recent commits. */
  private checkPassiveRepos(repoPaths: string[]): void {
    const now = Date.now()
    const reviewRepos = loadWorkflowConfig().reviewRepos

    for (const repoPath of repoPaths) {
      try {
        if (!hasEnabledWorkflowForRepo(repoPath, reviewRepos)) continue

        const gitDir = join(repoPath, '.git')
        if (!existsSync(gitDir)) continue

        // Use HEAD ref's mtime as a proxy for last commit time
        const headFile = join(gitDir, 'HEAD')
        if (!existsSync(headFile)) continue

        const headStat = statSync(headFile)
        const daysSinceActivity = Math.floor((now - headStat.mtime.getTime()) / (24 * 60 * 60 * 1000))

        if (daysSinceActivity >= PASSIVE_THRESHOLD_DAYS) {
          const repoName = repoPath.split('/').pop() ?? repoPath
          this.addNotification({
            severity: 'info',
            title: `${repoName} looks passive`,
            body: `No activity in ${daysSinceActivity} days. Consider de-scheduling workflows to save resources.`,
          })
        }
      } catch {
        // Skip repos we can't stat
      }
    }
  }

  /** Handle workflow engine events. */
  private handleWorkflowEvent(event: WorkflowEvent): void {
    // Notify on workflow failures
    if (event.eventType === 'run_failed') {
      this.addNotification({
        severity: 'alert',
        title: `Workflow failed: ${event.kind}`,
        body: `Run ${event.runId} failed. Check the workflow logs for details.`,
      })
    }

    // Notify on successful runs that produce reports
    if (event.eventType === 'run_succeeded') {
      // Report was likely written — next poll will pick it up as a new report
    }
  }

  /**
   * Goal-run (loop) events, bridged from the GoalRunStore listener in
   * ws-server. The supervisor cares about exactly the states where a run
   * stops making progress on its own: `blocked` (a tool call waiting on
   * approval — actionable right now via pending_prompts/respond_to_prompt),
   * `awaiting_human` (escalated), and `failed`.
   *
   * Deduped per (runId, status): `blocked` re-emits on every prompt
   * re-broadcast, and one nudge per state is enough — the first notification
   * already points at pending_prompts, which lists whatever is waiting.
   */
  handleGoalRunEvent(event: GoalRunEvent): void {
    if (event.eventType !== 'run_status' || !event.status) return
    if (event.status !== 'blocked' && event.status !== 'awaiting_human' && event.status !== 'failed') return
    const key = `${event.runId}:${event.status}`
    if (this.notedGoalRunStates.has(key)) return
    this.notedGoalRunStates.add(key)
    if (this.notedGoalRunStates.size > MAX_NOTED_GOAL_RUN_STATES) {
      for (const k of this.notedGoalRunStates) {
        this.notedGoalRunStates.delete(k)
        if (this.notedGoalRunStates.size <= MAX_NOTED_GOAL_RUN_STATES) break
      }
    }

    if (event.status === 'blocked') {
      this.addNotification({
        severity: 'action',
        title: `Loop run blocked: ${event.kind}`,
        body: `Goal run ${event.runId} is waiting on a tool approval or question. Use pending_prompts to see it and respond_to_prompt to unblock it.`,
      })
    } else if (event.status === 'awaiting_human') {
      this.addNotification({
        severity: 'action',
        title: `Loop run needs a decision: ${event.kind}`,
        body: `Goal run ${event.runId} escalated to a human checkpoint. Use list_runs to inspect it and tell the user what happened.`,
      })
    } else {
      this.addNotification({
        severity: 'alert',
        title: `Loop run failed: ${event.kind}`,
        body: `Goal run ${event.runId} failed (budget exhausted, error, or restart). Use list_runs to inspect its evidence ledger.`,
      })
    }
  }

  /** Add a notification. */
  private addNotification(opts: Omit<OrchestratorNotification, 'id' | 'timestamp' | 'delivered'>): void {
    const notification: OrchestratorNotification = {
      id: `notif-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      timestamp: new Date().toISOString(),
      delivered: false,
      ...opts,
    }
    this.notifications.push(notification)

    // Keep last 100 notifications
    if (this.notifications.length > 100) {
      this.notifications = this.notifications.slice(-100)
    }

    // Deliver to orchestrator session if active
    this.deliverToOrchestrator(notification)
  }

  /** Deliver a notification to the orchestrator chat session. */
  private deliverToOrchestrator(notification: OrchestratorNotification): void {
    // Don't push more API work at the orchestrator while the rate-limit
    // circuit breaker is open. The notification stays in the buffer and
    // can still be inspected via the API; it just isn't replayed as a
    // chat message until the cooldown expires.
    if (this.sessions.isRateLimited()) return

    const orchestratorId = getOrchestratorSessionId(this.sessions)
    if (!orchestratorId) return

    const session = this.sessions.get(orchestratorId)
    if (!session?.claudeProcess?.isAlive()) {
      // Orchestrator not running — hand the notification to the persistent
      // outbox so it is replayed (as a digest) when the session comes back,
      // instead of rotting in the in-memory buffer forever.
      getOrchestratorOutbox().enqueue({
        label: notification.severity.toUpperCase(),
        title: notification.title,
        body: notification.body,
      })
      notification.delivered = true
      return
    }

    // Send as a system message that the orchestrator will see and respond to
    const message = `[Agent ${getAgentDisplayName()} Notification — ${notification.severity.toUpperCase()}]\n${notification.title}\n${notification.body}`
    this.sessions.sendInput(orchestratorId, message)
    notification.delivered = true
  }

  /** Discover repo paths from REPOS_ROOT (see discoverRepoPathsUnder). */
  private discoverRepoPaths(): string[] {
    return discoverRepoPathsUnder(REPOS_ROOT)
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Discover git repositories under a root directory, recursing one level into
 * non-repo directories so org-style layouts (root/org/repo) are picked up
 * alongside flat ones (root/repo). Unreadable entries are skipped.
 */
export function discoverRepoPathsUnder(root: string): string[] {
  if (!existsSync(root)) return []
  const repos: string[] = []
  const scan = (dir: string, depth: number): void => {
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      return
    }
    for (const name of entries) {
      const p = join(dir, name)
      try {
        if (!statSync(p).isDirectory()) continue
        if (existsSync(join(p, '.git'))) repos.push(p)
        else if (depth < 2) scan(p, depth + 1)
      } catch {
        // unreadable entry — skip
      }
    }
  }
  scan(root, 1)
  return repos
}

/**
 * Suppress passive-repo alerts unless at least one workflow is enabled for the
 * repo — there's nothing to "de-schedule" otherwise, so the nag is noise.
 */
export function hasEnabledWorkflowForRepo(
  repoPath: string,
  reviewRepos: ReviewRepoConfig[],
): boolean {
  return reviewRepos.some(r => r.repoPath === repoPath && r.enabled)
}
