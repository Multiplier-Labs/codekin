/**
 * Orchestrator proactive monitor — watches for new reports, idle repos,
 * and workflow events, then notifies the orchestrator session.
 *
 * Runs a periodic poll and subscribes to workflow engine events. Delivery
 * goes through the shared notify path (orchestrator-notify): sent now if the
 * orchestrator is idle, otherwise held in the persistent outbox.
 */

import { readdirSync, statSync, existsSync } from 'fs'
import { join } from 'path'
import type { SessionManager } from './session-manager.js'
import type { WorkflowEngine, WorkflowEvent } from './workflow-engine.js'
import type { LoopEvent } from './loop-store.js'
import { scanRepoReports } from './orchestrator-reports.js'
import { notifyOrchestrator } from './orchestrator-notify.js'
import { tryGetRepoActivityIndex } from './repo-activity.js'
import { REPOS_ROOT } from './config.js'
import { loadWorkflowConfig, type ReviewRepoConfig } from './workflow-config.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface OrchestratorNotification {
  severity: 'info' | 'action' | 'alert'
  title: string
  body: string
}

// ---------------------------------------------------------------------------
// Monitor
// ---------------------------------------------------------------------------

const POLL_INTERVAL_MS = 15 * 60 * 1000  // 15 minutes
/** Cap on the loop-event notification dedup set (oldest entries dropped). */
const MAX_NOTED_LOOP_EVENTS = 500

export class OrchestratorMonitor {
  private sessions: SessionManager
  private pollTimer: ReturnType<typeof setInterval> | null = null
  private seenReports = new Set<string>()
  /** (runId:event) keys already notified — see handleLoopEvent. */
  private notedLoopEvents = new Set<string>()
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

  /**
   * Start the periodic poll. When an engine is attached (setEngine), the poll
   * registers as an engine tick task — it rides the dispatch
   * loop's clock and heartbeat instead of owning a setInterval loop (the one
   * observable liveness story). Without an engine (standalone/tests), the
   * legacy interval runs.
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
      return
    }

    this.pollTimer = setInterval(() => {
      void this.poll()
    }, POLL_INTERVAL_MS)
  }

  /** Stop the monitor. */
  stop(): void {
    this.started = false
    if (this.engine) {
      this.engine.unregisterTickTask('orchestrator-poll')
    }
    if (this.pollTimer) {
      clearInterval(this.pollTimer)
      this.pollTimer = null
    }
  }

  /**
   * Notify from outside the monitor's own checks (e.g. a deployment probe
   * breach delivered via the signal queue).
   */
  notify(severity: OrchestratorNotification['severity'], title: string, body: string): void {
    this.addNotification({ severity, title, body })
  }

  // -------------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------------

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
   * Loop events, bridged from the LoopStore listener in ws-server. The
   * supervisor cares about exactly the moments where a run stops making
   * progress on its own:
   *
   *   - `intervention_created` — a pending human decision (approval, budget
   *     extension, or escalation);
   *   - `session_blocked` — a maker/reviewer tool call waiting on approval,
   *     actionable right now via pending_prompts/respond_to_prompt;
   *   - `run_completed` with outcome `failed`.
   *
   * Deduped per (runId, event key): `session_blocked` re-emits per prompt,
   * and one nudge per situation is enough.
   */
  handleLoopEvent(event: LoopEvent): void {
    const payload = (event.payload ?? {}) as Record<string, unknown>
    let key: string
    let notification: { severity: 'action' | 'alert'; title: string; body: string }

    if (event.type === 'intervention_created') {
      key = `${event.runId}:intervention:${String(payload.interventionId ?? '')}`
      notification = {
        severity: 'action',
        title: `Loop run needs a decision: ${String(payload.title ?? 'intervention pending')}`,
        body: `Loop run ${event.runId} is waiting on a decision (${String(payload.purpose ?? 'intervention')}). Use list_runs to inspect it and tell the user what is needed.`,
      }
    } else if (event.type === 'session_blocked') {
      key = `${event.runId}:blocked:${String(payload.requestId ?? payload.toolName ?? '')}`
      notification = {
        severity: 'action',
        title: `Loop run blocked`,
        body: `Loop run ${event.runId} has a session waiting on a tool approval or question. Use pending_prompts to see it and respond_to_prompt to unblock it.`,
      }
    } else if (event.type === 'run_completed' && payload.outcome === 'failed') {
      key = `${event.runId}:failed`
      notification = {
        severity: 'alert',
        title: `Loop run failed`,
        body: `Loop run ${event.runId} failed: ${String(payload.reason ?? 'see the run events')}. Use list_runs to inspect it.`,
      }
    } else {
      return
    }

    if (this.notedLoopEvents.has(key)) return
    this.notedLoopEvents.add(key)
    if (this.notedLoopEvents.size > MAX_NOTED_LOOP_EVENTS) {
      for (const k of this.notedLoopEvents) {
        this.notedLoopEvents.delete(k)
        if (this.notedLoopEvents.size <= MAX_NOTED_LOOP_EVENTS) break
      }
    }
    this.addNotification(notification)
  }

  /** Hand a notification to the shared orchestrator notify path. */
  private addNotification(notification: OrchestratorNotification): void {
    notifyOrchestrator(this.sessions, {
      label: notification.severity.toUpperCase(),
      title: notification.title,
      body: notification.body,
    })
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
