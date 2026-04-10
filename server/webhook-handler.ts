/**
 * GitHub webhook handler for automated CI failure triage and PR code review.
 *
 * Processes incoming webhook events:
 *   - `workflow_run` (completed+failed) → spawns Claude session for CI diagnosis
 *   - `pull_request` (opened/synchronize/reopened/ready_for_review) → spawns Claude session for code review
 *
 * Event lifecycle / state machine:
 *   received → (filtered/duplicate/capped)
 *   received → processing  — event accepted, async fetch started
 *            → session_created — workspace ready, session spawned, prompt sent
 *            → completed | error  — Claude exited 0 (success) or non-zero (failure)
 *
 * The 'processing' state bridges the async gap between accepting the webhook
 * (202 response) and the session being created.  A watchdog marks events stuck
 * in 'processing' as 'error' after PROCESSING_TIMEOUT_MS to prevent the
 * concurrency cap from leaking on partial failures.
 */

import { randomUUID } from 'crypto'
import type { SessionManager } from './session-manager.js'
import { verifyHmacSignature } from './crypto-utils.js'
import type { WsServerMessage } from './types.js'
import type { WebhookConfig, WebhookEvent, WebhookEventStatus, WorkflowRunPayload, FailureContext, PullRequestPayload, PullRequestContext } from './webhook-types.js'
import type { FullWebhookConfig } from './webhook-config.js'
import { WebhookDedup, computeIdempotencyKey, computePrIdempotencyKey } from './webhook-dedup.js'
import { checkGhHealth, fetchFailedLogs, fetchJobs, fetchAnnotations, fetchCommitMessage, fetchPRTitle } from './webhook-github.js'
import { fetchPrDiff, fetchPrFiles, fetchPrCommits, fetchPrReviewComments, fetchPrReviews, fetchExistingReviewComment } from './webhook-pr-github.js'
import { buildPrReviewPrompt } from './webhook-pr-prompt.js'
import { loadPrCache, ensureCacheDir, archivePrCache, deletePrCache } from './webhook-pr-cache.js'
import { buildPrompt } from './webhook-prompt.js'
import { createWorkspace, cleanupWorkspace } from './webhook-workspace.js'
import { WebhookHandlerBase } from './webhook-handler-base.js'
import { REPOS_ROOT } from './config.js'

/** How long an event can stay in 'processing' before the watchdog marks it as error. */
const PROCESSING_TIMEOUT_MS = 5 * 60 * 1000

/** Supported pull_request actions for code review. */
const PR_REVIEW_ACTIONS = ['opened', 'synchronize', 'reopened', 'ready_for_review'] as const

export class WebhookHandler extends WebhookHandlerBase<WebhookEvent, WebhookEventStatus> {
  private config: FullWebhookConfig
  private sessions: SessionManager
  private dedup: WebhookDedup
  private ghHealthy = false

  constructor(config: FullWebhookConfig, sessions: SessionManager) {
    super('webhook', PROCESSING_TIMEOUT_MS)

    this.config = config
    this.sessions = sessions
    this.dedup = new WebhookDedup()

    // Track session completion to update webhook event status.
    // Only update on final exit (willRestart=false) to avoid prematurely
    // marking events as 'error' when auto-restart will retry.
    sessions.onSessionExit((sessionId, code, _signal, willRestart) => {
      if (willRestart) return  // Don't update status — Claude will retry

      // Match any non-terminal status — covers both 'processing' (if Claude
      // exits before status reaches 'session_created') and 'session_created'.
      const event = this.getEvents().find(e => e.sessionId === sessionId && (e.status === 'session_created' || e.status === 'processing'))
      if (event) {
        const status: WebhookEventStatus = (code === 0) ? 'completed' : 'error'
        this.updateEventStatus(event.id, status, code !== 0 ? `Claude exited with code ${code}` : undefined)
        console.log(`[webhook] Event ${event.id} → ${status} (session ${sessionId}, code=${code})`)

        // Clean up the workspace for completed/errored webhook sessions
        cleanupWorkspace(sessionId)
      }
    })

    // Auto-kill PR review sessions after Claude completes its turn so they don't
    // sit idle waiting for more input and consume memory indefinitely.
    sessions.onSessionResult((sessionId, isError) => {
      if (isError) return

      const event = this.getEvents().find(
        e => e.sessionId === sessionId && (e.status === 'session_created' || e.status === 'processing'),
      )
      if (!event) return

      this.updateEventStatus(event.id, 'completed')
      console.log(`[webhook] Session ${sessionId} completed review, scheduling cleanup`)

      this.sessions.stopClaude(sessionId) // suppress auto-restart
      setTimeout(() => {
        this.sessions.delete(sessionId)
      }, 2000)
    })
  }

  /**
   * Check if we are at the session cap (for reuse across event types).
   */
  private isAtSessionCap(): boolean {
    const activeWebhookSessions = this.sessions.list().filter(s => s.source === 'webhook' && s.active).length
    const processingEvents = this.countByStatus('processing')
    return (activeWebhookSessions + processingEvents) >= this.config.maxConcurrentSessions
  }

  /**
   * Run gh CLI health check. Must be called on startup.
   * Sets ghHealthy flag — if false, webhook processing is disabled.
   */
  async checkHealth(): Promise<boolean> {
    const result = await checkGhHealth()
    this.ghHealthy = result.available
    if (!result.available) {
      console.warn(`[webhook] gh health check failed: ${result.reason}`)
      console.warn('[webhook] Webhook processing disabled — manual sessions still work')
    } else {
      console.log('[webhook] gh CLI health check passed')
    }
    return this.ghHealthy
  }

  /**
   * Verify the HMAC-SHA256 signature of a webhook payload.
   */
  verifySignature(payload: Buffer, signature: string): boolean {
    if (!this.config.secret) return false
    return verifyHmacSignature(payload, signature, this.config.secret)
  }

  /**
   * Main entry point: handle an incoming GitHub webhook request.
   * Returns the response to send back to GitHub.
   */
  async handleWebhook(
    rawBody: Buffer,
    headers: {
      event: string
      delivery: string
      signature: string
    },
  ): Promise<{
    statusCode: number
    body: Record<string, unknown>
  }> {
    const eventId = headers.delivery || randomUUID()

    // --- Enabled check ---
    if (!this.config.enabled) {
      return {
        statusCode: 200,
        body: { accepted: false, eventId, status: 'disabled', filterReason: 'Webhooks are disabled' },
      }
    }

    // --- gh health check ---
    if (!this.ghHealthy) {
      return {
        statusCode: 200,
        body: { accepted: false, eventId, status: 'disabled', filterReason: 'gh CLI not available' },
      }
    }

    // --- Signature validation ---
    if (!headers.signature) {
      return { statusCode: 401, body: { error: 'Missing X-Hub-Signature-256 header' } }
    }
    if (!this.verifySignature(rawBody, headers.signature)) {
      return { statusCode: 401, body: { error: 'Invalid signature' } }
    }

    // --- Parse payload (generic parse, dispatch by event type) ---
    let payload: unknown
    try {
      payload = JSON.parse(rawBody.toString('utf-8'))
    } catch {
      return { statusCode: 400, body: { error: 'Malformed JSON payload' } }
    }

    // --- Event type dispatch ---
    switch (headers.event) {
      case 'workflow_run':
        return this.handleWorkflowRunEvent(payload as WorkflowRunPayload, eventId, headers)
      case 'pull_request':
        return this.handlePullRequestEvent(payload as PullRequestPayload, eventId, headers)
      default:
        return {
          statusCode: 200,
          body: { accepted: false, eventId, status: 'filtered', filterReason: `Event type '${headers.event}' not supported` },
        }
    }
  }

  // ---------------------------------------------------------------------------
  // workflow_run handling (existing logic, extracted into its own method)
  // ---------------------------------------------------------------------------

  private async handleWorkflowRunEvent(
    payload: WorkflowRunPayload,
    eventId: string,
    headers: { event: string; delivery: string; signature: string },
  ): Promise<{ statusCode: number; body: Record<string, unknown> }> {
    const wr = payload.workflow_run
    if (!wr) {
      return { statusCode: 400, body: { error: 'Missing workflow_run in payload' } }
    }

    if (payload.action !== 'completed' || wr.conclusion !== 'failure') {
      return {
        statusCode: 200,
        body: {
          accepted: false,
          eventId,
          status: 'filtered',
          filterReason: `action=${payload.action}, conclusion=${wr.conclusion ?? 'null'} (only completed+failure triggers processing)`,
        },
      }
    }

    // --- Actor allowlist filter ---
    const actorLower = wr.actor.login.toLowerCase()
    if (this.config.actorAllowlist.length > 0 && !this.config.actorAllowlist.some(a => a.toLowerCase() === actorLower)) {
      return {
        statusCode: 200,
        body: {
          accepted: false,
          eventId,
          status: 'filtered',
          filterReason: `Actor '${wr.actor.login}' not in allowlist`,
        },
      }
    }

    // --- Deduplication ---
    const idempotencyKey = computeIdempotencyKey(
      payload.repository.full_name,
      headers.event,
      wr.id,
      payload.action,
      wr.conclusion ?? '',
      wr.run_attempt,
    )

    if (this.dedup.isDuplicate(eventId, idempotencyKey)) {
      this.recordEvent({
        id: eventId,
        idempotencyKey,
        receivedAt: new Date().toISOString(),
        event: headers.event,
        action: payload.action,
        repo: payload.repository.full_name,
        branch: wr.head_branch,
        workflow: wr.name,
        runId: wr.id,
        runAttempt: wr.run_attempt,
        conclusion: wr.conclusion ?? 'unknown',
        status: 'duplicate',
      })
      return {
        statusCode: 200,
        body: { accepted: false, eventId, status: 'duplicate' },
      }
    }

    // --- Session cap check ---
    if (this.isAtSessionCap()) {
      this.recordEvent({
        id: eventId,
        idempotencyKey,
        receivedAt: new Date().toISOString(),
        event: headers.event,
        action: payload.action,
        repo: payload.repository.full_name,
        branch: wr.head_branch,
        workflow: wr.name,
        runId: wr.id,
        runAttempt: wr.run_attempt,
        conclusion: wr.conclusion ?? 'unknown',
        status: 'error',
        error: `Max concurrent webhook sessions reached (${this.config.maxConcurrentSessions})`,
      })
      return {
        statusCode: 429,
        body: { error: 'Max concurrent webhook sessions reached', max: this.config.maxConcurrentSessions },
      }
    }

    // --- Pre-allocate session ID and respond 202 ---
    const sessionId = randomUUID()
    const webhookEvent: WebhookEvent = {
      id: eventId,
      idempotencyKey,
      receivedAt: new Date().toISOString(),
      event: headers.event,
      action: payload.action,
      repo: payload.repository.full_name,
      branch: wr.head_branch,
      workflow: wr.name,
      runId: wr.id,
      runAttempt: wr.run_attempt,
      conclusion: wr.conclusion ?? 'unknown',
      status: 'processing',
      sessionId,
    }
    this.recordEvent(webhookEvent)
    this.dedup.recordProcessed(eventId, idempotencyKey)

    // Process asynchronously — don't block the 202 response
    this.processWebhookAsync(payload, webhookEvent, sessionId).catch(err => {
      console.error('[webhook] Async processing error:', err)
      this.updateEventStatus(eventId, 'error', String(err))
    })

    return {
      statusCode: 202,
      body: { accepted: true, eventId, status: 'processing', sessionId },
    }
  }

  /**
   * Async background processing: fetch logs, create workspace, create session, send prompt.
   */
  private async processWebhookAsync(
    payload: WorkflowRunPayload,
    event: WebhookEvent,
    sessionId: string,
  ): Promise<void> {
    const wr = payload.workflow_run
    const repo = payload.repository.full_name
    const repoName = payload.repository.name
    const logLines = this.config.logLinesToInclude

    console.log(`[webhook] Processing: ${repo} / ${wr.name} run #${wr.run_number} (${wr.head_branch})`)

    // --- Fetch failure context (all calls degrade gracefully) ---
    const [failedLogs, jobs, annotations, commitMessage] = await Promise.all([
      fetchFailedLogs(repo, wr.id, logLines),
      fetchJobs(repo, wr.id),
      fetchAnnotations(repo, wr.check_suite_id),
      fetchCommitMessage(repo, wr.head_sha),
    ])

    // Fetch PR title if applicable
    let pullRequest: FailureContext['pullRequest'] | undefined
    if (wr.pull_requests.length > 0) {
      const pr = wr.pull_requests[0]
      const title = await fetchPRTitle(repo, pr.number)
      pullRequest = { number: pr.number, title: title || undefined }
    }

    const context: FailureContext = {
      repo,
      repoName,
      branch: wr.head_branch,
      headSha: wr.head_sha,
      workflowName: wr.name,
      runId: wr.id,
      runNumber: wr.run_number,
      runAttempt: wr.run_attempt,
      actor: wr.actor.login,
      event: wr.event,
      htmlUrl: wr.html_url,
      failedLogs,
      annotations,
      jobs,
      pullRequest,
      commitMessage: commitMessage || undefined,
    }

    // --- Create workspace ---
    let workspacePath: string
    try {
      workspacePath = await createWorkspace(
        sessionId,
        repo,
        payload.repository.clone_url,
        wr.head_branch,
        wr.head_sha,
      )
    } catch (err) {
      console.error(`[webhook] Failed to create workspace for ${repo}:`, err)
      this.updateEventStatus(event.id, 'error', `Workspace creation failed: ${err}`)
      return
    }

    // --- Create session ---
    // Use the canonical repo path as groupDir so the frontend groups webhook
    // sessions under the same tab as manual sessions for the same repo.
    const groupDir = `${REPOS_ROOT}/${repoName}`
    const sessionName = `webhook/${repoName}/${wr.head_branch}/${wr.name}`
    this.sessions.create(sessionName, workspacePath, {
      source: 'webhook',
      id: sessionId,
      groupDir,
    })

    console.log(`[webhook] Session created: ${sessionName} (${sessionId})`)
    this.updateEventStatus(event.id, 'session_created')

    // --- Broadcast webhook event to all connected WS clients ---
    // Re-fetch the event after status update to ensure broadcast uses current status
    const updatedEvent = this.getEvent(event.id)
    if (updatedEvent) this.broadcastWebhookEvent(updatedEvent)

    // --- Build and send prompt ---
    const prompt = buildPrompt(context, logLines)
    this.sessions.sendInput(sessionId, prompt)

    console.log(`[webhook] Prompt sent to session ${sessionId}, Claude is processing...`)
  }

  /**
   * Broadcast a webhook event notification to all connected WebSocket clients.
   * Sent globally (not scoped to the new session) so any open browser tab can
   * display the incoming webhook badge regardless of which session is active.
   */
  private broadcastWebhookEvent(event: WebhookEvent): void {
    // Iterate all active sessions as proxies to their connected WS clients
    const allSessions = this.sessions.list()
    const msg: WsServerMessage = {
      type: 'webhook_event',
      event: event.event,
      repo: event.repo,
      branch: event.branch,
      workflow: event.workflow,
      conclusion: event.conclusion,
      status: event.status,
      sessionId: event.sessionId,
    }

    // Broadcast to all active sessions
    for (const sessionInfo of allSessions) {
      const session = this.sessions.get(sessionInfo.id)
      if (session) {
        this.sessions.broadcast(session, msg)
      }
    }
  }

  // ---------------------------------------------------------------------------
  // pull_request handling (PR code review)
  // ---------------------------------------------------------------------------

  private async handlePullRequestEvent(
    payload: PullRequestPayload,
    eventId: string,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _headers: { event: string; delivery: string; signature: string },
  ): Promise<{ statusCode: number; body: Record<string, unknown> }> {
    const pr = payload.pull_request
    if (!pr) {
      return { statusCode: 400, body: { error: 'Missing pull_request in payload' } }
    }

    // --- Closed/merged handling (cleanup, no review) ---
    if (payload.action === 'closed') {
      return this.handlePrClosed(payload, eventId)
    }

    // --- Action filter ---
    if (!(PR_REVIEW_ACTIONS as readonly string[]).includes(payload.action)) {
      return {
        statusCode: 200,
        body: {
          accepted: false,
          eventId,
          status: 'filtered',
          filterReason: `PR action '${payload.action}' not supported (only ${PR_REVIEW_ACTIONS.join(', ')})`,
        },
      }
    }

    // --- Draft filter ---
    if (pr.draft) {
      return {
        statusCode: 200,
        body: { accepted: false, eventId, status: 'filtered', filterReason: 'PR is a draft' },
      }
    }

    // --- Actor allowlist ---
    const actorLower = (payload.sender?.login ?? '').toLowerCase()
    if (this.config.actorAllowlist.length > 0 && !this.config.actorAllowlist.some(a => a.toLowerCase() === actorLower)) {
      return {
        statusCode: 200,
        body: { accepted: false, eventId, status: 'filtered', filterReason: `Actor '${payload.sender?.login}' not in allowlist` },
      }
    }

    // --- Deduplication ---
    const headSha = pr.head?.sha ?? ''
    const idempotencyKey = computePrIdempotencyKey(
      payload.repository.full_name,
      pr.number,
      payload.action,
      headSha,
    )

    if (this.dedup.isDuplicate(eventId, idempotencyKey)) {
      return {
        statusCode: 200,
        body: { accepted: false, eventId, status: 'duplicate' },
      }
    }

    // --- Session cap ---
    if (this.isAtSessionCap()) {
      return {
        statusCode: 429,
        body: { error: 'Max concurrent webhook sessions reached', max: this.config.maxConcurrentSessions },
      }
    }

    // --- Pre-allocate session ID and respond 202 ---
    const sessionId = randomUUID()
    const repo = payload.repository.full_name

    const webhookEvent: WebhookEvent = {
      id: eventId,
      idempotencyKey,
      receivedAt: new Date().toISOString(),
      event: 'pull_request',
      action: payload.action,
      repo,
      branch: pr.head?.ref ?? 'unknown',
      workflow: `PR #${pr.number}`,
      runId: pr.number,
      runAttempt: 1,
      conclusion: 'pending',
      status: 'processing',
      sessionId,
    }
    this.recordEvent(webhookEvent)
    this.dedup.recordProcessed(eventId, idempotencyKey)

    // Process asynchronously
    this.processPrReviewAsync(payload, webhookEvent, sessionId).catch(err => {
      console.error('[webhook] PR review async processing error:', err)
      this.updateEventStatus(eventId, 'error', String(err))
    })

    return {
      statusCode: 202,
      body: { accepted: true, eventId, status: 'processing', sessionId },
    }
  }

  /**
   * Handle PR closed/merged — archive or delete the review cache and kill any
   * active review sessions for this PR.
   */
  private async handlePrClosed(
    payload: PullRequestPayload,
    eventId: string,
  ): Promise<{ statusCode: number; body: Record<string, unknown> }> {
    const pr = payload.pull_request
    const repo = payload.repository.full_name
    const merged = pr.merged ?? false

    console.log(`[webhook] PR #${pr.number} ${merged ? 'merged' : 'closed'} in ${repo}`)

    // Archive (merged) or delete (closed without merge) the cache
    try {
      if (merged) {
        archivePrCache(repo, pr.number)
      } else {
        deletePrCache(repo, pr.number)
      }
    } catch (err) {
      console.warn(`[webhook] Failed to clean up PR cache for ${repo}#${pr.number}:`, err)
    }

    // Kill any active review sessions for this PR
    const prLabel = `PR #${pr.number}`
    const activeEvents = this.getEvents().filter(
      e => e.repo === repo && e.workflow === prLabel && (e.status === 'processing' || e.status === 'session_created'),
    )
    for (const event of activeEvents) {
      if (event.sessionId) {
        this.sessions.stopClaude(event.sessionId)
        setTimeout(() => this.sessions.delete(event.sessionId!), 1000)
      }
      this.updateEventStatus(event.id, 'completed')
    }

    return {
      statusCode: 200,
      body: { accepted: true, eventId, status: 'completed', action: merged ? 'archived' : 'deleted' },
    }
  }

  /**
   * Async background processing for PR review: fetch PR context, create workspace,
   * create session, send review prompt.
   */
  private async processPrReviewAsync(
    payload: PullRequestPayload,
    event: WebhookEvent,
    sessionId: string,
  ): Promise<void> {
    const pr = payload.pull_request
    const repo = payload.repository.full_name
    const repoName = payload.repository.name
    const prNumber = pr.number
    const headSha = pr.head?.sha ?? ''
    const baseRef = pr.base?.ref ?? 'main'

    console.log(`[webhook] Processing PR review: ${repo}#${prNumber} (${pr.title})`)

    // --- Ensure cache dir ---
    ensureCacheDir(repo, prNumber)

    // --- Load prior review cache ---
    const priorCache = loadPrCache(repo, prNumber)

    // --- Fetch PR context (all calls degrade gracefully) ---
    const [diffResult, files, commits, reviewComments, reviews, existingComment] = await Promise.all([
      fetchPrDiff(repo, prNumber),
      fetchPrFiles(repo, prNumber),
      fetchPrCommits(repo, prNumber),
      fetchPrReviewComments(repo, prNumber),
      fetchPrReviews(repo, prNumber),
      fetchExistingReviewComment(repo, prNumber),
    ])

    const prContext: PullRequestContext = {
      repo,
      repoName,
      prNumber,
      prTitle: pr.title,
      prBody: pr.body ?? '',
      prUrl: pr.html_url ?? '',
      author: pr.user?.login ?? 'unknown',
      headBranch: pr.head?.ref ?? 'unknown',
      baseBranch: baseRef,
      headSha,
      baseSha: pr.base?.sha ?? '',
      beforeSha: payload.before,
      action: payload.action as PullRequestContext['action'],
      changedFiles: pr.changed_files ?? 0,
      additions: pr.additions ?? 0,
      deletions: pr.deletions ?? 0,
      diff: diffResult.diff,
      fileList: files,
      commitMessages: commits,
      reviewComments,
      reviews,
      existingComment: existingComment != null ? String(existingComment) : null,
      priorCache: priorCache ?? null,
    }

    // --- Create workspace ---
    let workspacePath: string
    const headRepo = pr.head?.repo?.clone_url ?? payload.repository.clone_url
    try {
      workspacePath = await createWorkspace(
        sessionId,
        repo,
        headRepo,
        pr.head?.ref ?? baseRef,
        headSha,
      )
    } catch (err) {
      console.error(`[webhook] Failed to create workspace for PR ${repo}#${prNumber}:`, err)
      this.updateEventStatus(event.id, 'error', `Workspace creation failed: ${err}`)
      return
    }

    // --- Create session ---
    const groupDir = `${REPOS_ROOT}/${repoName}`
    const sessionName = `review/${repoName}/PR-${prNumber}`
    this.sessions.create(sessionName, workspacePath, {
      source: 'webhook',
      id: sessionId,
      groupDir,
      allowedTools: ['Bash(git:*)', 'Bash(gh:*)'],
    })

    console.log(`[webhook] PR review session created: ${sessionName} (${sessionId})`)
    this.updateEventStatus(event.id, 'session_created')

    // Broadcast
    const updatedEvent = this.getEvent(event.id)
    if (updatedEvent) this.broadcastWebhookEvent(updatedEvent)

    // --- Build and send prompt ---
    const prompt = buildPrReviewPrompt(prContext, workspacePath)
    this.sessions.sendInput(sessionId, prompt)

    console.log(`[webhook] PR review prompt sent to session ${sessionId}`)
  }

  getConfig(): WebhookConfig {
    return {
      enabled: this.config.enabled,
      maxConcurrentSessions: this.config.maxConcurrentSessions,
      logLinesToInclude: this.config.logLinesToInclude,
      actorAllowlist: this.config.actorAllowlist,
    }
  }

  shutdown(): void {
    super.shutdown()
    this.dedup.shutdown()
  }
}
