/**
 * Shepherd proactive monitor — watches for new reports, idle repos,
 * and workflow events, then queues notifications for the Shepherd session.
 *
 * Runs a periodic poll and subscribes to workflow engine events.
 * Notifications are delivered in-chat via the Shepherd session.
 */

import { readdirSync, statSync, existsSync } from 'fs'
import { join } from 'path'
import type { SessionManager } from './session-manager.js'
import type { WorkflowEngine, WorkflowEvent } from './workflow-engine.js'
import { scanRepoReports } from './shepherd-reports.js'
import { ShepherdMemory } from './shepherd-memory.js'
import { runAgingCycle, getPendingOutcomeAssessments } from './shepherd-learning.js'
import { getShepherdSessionId } from './shepherd-manager.js'
import { REPOS_ROOT } from './config.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ShepherdNotification {
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
const PASSIVE_THRESHOLD_DAYS = 30

export class ShepherdMonitor {
  private sessions: SessionManager
  private pollTimer: ReturnType<typeof setInterval> | null = null
  private agingTimer: ReturnType<typeof setInterval> | null = null
  private notifications: ShepherdNotification[] = []
  private seenReports = new Set<string>()
  private memory: ShepherdMemory | null = null

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
  setMemory(memory: ShepherdMemory): void {
    this.memory = memory
  }

  /** Start the periodic poll. */
  start(): void {
    if (this.pollTimer) return
    console.log('[shepherd-monitor] Starting proactive monitor (poll every 15m)')

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
  getPending(): ShepherdNotification[] {
    return this.notifications.filter(n => !n.delivered)
  }

  /** Mark notifications as delivered. */
  markDelivered(ids: string[]): void {
    for (const n of this.notifications) {
      if (ids.includes(n.id)) n.delivered = true
    }
  }

  /** Get all notifications (including delivered). */
  getAll(): ShepherdNotification[] {
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
        console.log(`[shepherd-monitor] Aging cycle: ${agingResult.expired} expired, ${agingResult.compacted} compacted, ${agingResult.decayed} decayed`)
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
      console.error('[shepherd-monitor] Aging cycle error:', err)
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

    for (const repoPath of repoPaths) {
      try {
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

  /** Add a notification. */
  private addNotification(opts: Omit<ShepherdNotification, 'id' | 'timestamp' | 'delivered'>): void {
    const notification: ShepherdNotification = {
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

    // Deliver to Shepherd session if active
    this.deliverToShepherd(notification)
  }

  /** Deliver a notification to the Shepherd chat session. */
  private deliverToShepherd(notification: ShepherdNotification): void {
    const shepherdId = getShepherdSessionId(this.sessions)
    if (!shepherdId) return

    const session = this.sessions.get(shepherdId)
    if (!session?.claudeProcess?.isAlive()) return

    // Send as a system message that Joe will see and respond to
    const message = `[Agent Joe Notification — ${notification.severity.toUpperCase()}]\n${notification.title}\n${notification.body}`
    this.sessions.sendInput(shepherdId, message)
    notification.delivered = true
  }

  /** Discover repo paths from REPOS_ROOT. */
  private discoverRepoPaths(): string[] {
    if (!existsSync(REPOS_ROOT)) return []
    try {
      return readdirSync(REPOS_ROOT)
        .map(name => join(REPOS_ROOT, name))
        .filter(p => {
          try {
            return statSync(p).isDirectory() && existsSync(join(p, '.git'))
          } catch {
            return false
          }
        })
    } catch {
      return []
    }
  }
}
