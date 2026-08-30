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
import { tryGetRepoActivityIndex } from './repo-activity.js'
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
const AGING_INTERVAL_MS = 6 * 60 * 60 * 1000  // aging cycle checked every 6 hours
/** Cap on the goal-run notification dedup set (oldest entries dropped). */
const MAX_NOTED_GOAL_RUN_STATES = 500

export class OrchestratorMonitor {
  private sessions: SessionManager
  private pollTimer: ReturnType<typeof setInterval> | null = null
  private agingTimer: ReturnType<typeof setInterval> | null = null
  private notifications: OrchestratorNotification[] = []
  private seenReports = new Set<string>()
  /** (runId:status) pairs already notified — see handleGoalRunEvent. */
  private notedGoalRunStates = new Set<string>()
  private memory: OrchestratorMemory | null = null
  private engine: WorkflowEngine | null = null
  /** True once a stall alert has been sent — reset when the heartbeat recovers. */
  private engineStallNotified = false
  private started = false
  /** Poll holds off until the initial report scan lands (no boot-time false "new report" spam). */
  private initialScanDone = false

  constructor(sessions: SessionManager) {
    this.sessions = sessions
  }

  /** Connect to the workflow engine for event-driven notifications. */
  setEngine(engine: WorkflowEngine): void {
    this.engine = engine
    engine.on('workflow_event', (event: WorkflowEvent) => {
      this.handleWorkflowEvent(event)
    })
  }

  /** Set the memory store for aging and decision tracking. */
  setMemory(memory: OrchestratorMemory): void {
    this.memory = memory
  }

  /**
   * Start the periodic poll. When an engine is attached (setEngine), the poll
   * and aging cycles register as engine tick tasks — they ride the dispatch
   * loop's clock and heartbeat instead of owning setInterval loops (the one
   * observable liveness story). Without an engine (standalone/tests), the
   * legacy intervals run.
   */
  start(): void {
    if (this.started) return
    this.started = true
    console.log('[orchestrator-monitor] Starting proactive monitor (poll every 15m)')

    // Initial scan to populate seen reports; poll() holds off until it lands
    // so boot-time reports are never announced as new.
    void this.initialScan().then(() => { this.initialScanDone = true })

    if (this.engine) {
      this.engine.registerTickTask('orchestrator-poll', POLL_INTERVAL_MS, () => this.poll())
      this.engine.registerTickTask('orchestrator-aging', AGING_INTERVAL_MS, () => { this.runAgingAndAssessments() })
      return
    }

    this.pollTimer = setInterval(() => {
      void this.poll()
    }, POLL_INTERVAL_MS)

    // Run aging cycle daily (check every 6 hours)
    this.agingTimer = setInterval(() => {
      this.runAgingAndAssessments()
    }, AGING_INTERVAL_MS)
  }

  /** Stop the monitor. */
  stop(): void {
    this.started = false
    if (this.engine) {
      this.engine.unregisterTickTask('orchestrator-poll')
      this.engine.unregisterTickTask('orchestrator-aging')
    }
    if (this.pollTimer) {
      clearInterval(this.pollTimer)
      this.pollTimer = null
    }
    if (this.agingTimer) {
      clearInterval(this.agingTimer)
      this.agingTimer = null
    }
  }

  /**
   * Queue a notification from outside the monitor's own checks (e.g. a
   * deployment probe breach delivered via the signal queue).
   */
  notify(severity: OrchestratorNotification['severity'], title: string, body: string): void {
    this.addNotification({ severity, title, body })
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
    // Engine-driven polls can fire within a minute of boot — wait for the
    // initial scan so pre-existing reports aren't announced as new.
    if (!this.initialScanDone) return

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

    // Sweep the activity index and notify on tier transitions
    this.checkRepoActivity(repoPaths)

    // Check the trigger engine's heartbeat
    this.checkEngineHeartbeat()
  }

  /**
   * Watchdog for the workflow dispatch loop. The engine writes a heartbeat row on
   * every 60s tick; if it hasn't for 5+ minutes the interval has died or the
   * process is wedged — something the engine cannot report about itself.
   * Alerts once per stall, re-arming when the heartbeat recovers.
   */
  private checkEngineHeartbeat(): void {
    if (!this.engine) return
    try {
      const health = this.engine.getEngineHealth()
      // A null heartbeat means the scheduler was never started (e.g. disabled) — not a stall.
      if (!health.lastTickAt) return

      const stale = Date.now() - new Date(health.lastTickAt).getTime() > 5 * 60_000
      if (stale && !this.engineStallNotified) {
        this.engineStallNotified = true
        this.addNotification({
          severity: 'alert',
          title: 'Workflow trigger engine stalled',
          body: `The workflow dispatch loop last ticked at ${health.lastTickAt}. Scheduled workflows are not firing — the server likely needs attention.`,
        })
      } else if (!stale) {
        this.engineStallNotified = false
      }
    } catch (err) {
      console.error('[orchestrator-monitor] Engine heartbeat check error:', err)
    }
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

  /**
   * Sweep the repo activity index for configured repos and notify on tier
   * transitions. Replaces the old `.git/HEAD`-mtime "looks passive" heuristic —
   * the index aggregates commits, sessions, commit events, and PR events, and
   * its dormant tier actually holds scheduled dispatches (workflow-engine
   * activity gate), so the notification describes something real.
   */
  private checkRepoActivity(repoPaths: string[]): void {
    const index = tryGetRepoActivityIndex()
    if (!index) return

    const reviewRepos = loadWorkflowConfig().reviewRepos
    const configured = repoPaths.filter(p => hasEnabledWorkflowForRepo(p, reviewRepos))

    try {
      for (const transition of index.sweep(configured)) {
        const repoName = transition.repoPath.split('/').pop() ?? transition.repoPath
        if (transition.to === 'dormant') {
          this.addNotification({
            severity: 'info',
            title: `${repoName} went dormant`,
            body: `No commits, sessions, or PR events in 30+ days. Its scheduled workflows are held until activity resumes — no action needed unless that's a surprise.`,
          })
        } else if (transition.from === 'dormant') {
          this.addNotification({
            severity: 'info',
            title: `${repoName} woke up`,
            body: `New activity after a dormant spell — its scheduled workflows resume on their next fire.`,
          })
        }
      }
    } catch (err) {
      console.error('[orchestrator-monitor] Activity sweep error:', err)
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
    if (!session?.claudeProcess?.isAlive() || session.isProcessing) {
      // Orchestrator not running, or mid-turn (injecting now would derail
      // its active turn — audit item A5): hand the notification to the
      // persistent outbox, whose flusher retries under the same idle gate,
      // instead of letting it rot in the in-memory buffer.
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
