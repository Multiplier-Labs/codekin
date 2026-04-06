/**
 * GitHub webhook handler for automated CI failure triage and PR code review.
 *
 * Processes incoming webhook events:
 *   - `workflow_run` (completed+failed) → spawns Claude session for CI diagnosis
 *   - `pull_request` (opened/synchronize/reopened) → spawns Claude session for code review
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
import { dirname } from 'path'
import type { SessionManager } from './session-manager.js'
import { verifyHmacSignature } from './crypto-utils.js'
import type { WsServerMessage } from './types.js'
import type { WebhookConfig, WebhookEvent, WebhookEventStatus, WorkflowRunPayload, FailureContext, PullRequestPayload, PullRequestContext } from './webhook-types.js'
import type { FullWebhookConfig } from './webhook-config.js'
import { WebhookDedup, computeIdempotencyKey, computePrIdempotencyKey } from './webhook-dedup.js'
import { checkGhHealth, fetchFailedLogs, fetchJobs, fetchAnnotations, fetchCommitMessage, fetchPRTitle } from './webhook-github.js'
import { fetchPrDiff, fetchPrFiles, fetchPrCommits, fetchPrReviewComments, fetchPrReviews, fetchExistingReviewComment } from './webhook-pr-github.js'
import { buildPrompt } from './webhook-prompt.js'
import { buildPrReviewPrompt } from './webhook-pr-prompt.js'
import { loadPrCache, ensureCacheDir, archivePrCache, deletePrCache } from './webhook-pr-cache.js'
import { createWorkspace, cleanupWorkspace } from './webhook-workspace.js'
import { WebhookHandlerBase } from './webhook-handler-base.js'
import { REPOS_ROOT } from './config.js'

/** How long an event can stay in 'processing' before the watchdog marks it as error. */
const PROCESSING_TIMEOUT_MS = 5 * 60 * 1000

/** Supported pull_request actions for code review. */
const PR_REVIEW_ACTIONS = ['opened', 'synchronize', 'reopened'] as const

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

    // Auto-kill webhook sessions after Claude completes its turn so they don't
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
    if (this.isAtSessionCap(eventId)) {
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

  // ---------------------------------------------------------------------------
  // pull_request handling (new)
  // ---------------------------------------------------------------------------

  private async handlePullRequestEvent(
    payload: PullRequestPayload,
    eventId: string,
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
        body: {
          accepted: false,
          eventId,
          status: 'filtered',
          filterReason: 'Draft PRs are skipped',
        },
      }
    }

    // --- Actor allowlist filter ---
    if (this.config.actorAllowlist.length > 0 && !this.config.actorAllowlist.includes(payload.sender.login)) {
      return {
        statusCode: 200,
        body: {
          accepted: false,
          eventId,
          status: 'filtered',
          filterReason: `Actor '${payload.sender.login}' not in allowlist`,
        },
      }
    }

    // --- Deduplication ---
    const idempotencyKey = computePrIdempotencyKey(
      payload.repository.full_name,
      pr.number,
      payload.action,
      pr.head.sha,
    )

    if (this.dedup.isDuplicate(eventId, idempotencyKey)) {
      this.recordEvent({
        id: eventId,
        idempotencyKey,
        receivedAt: new Date().toISOString(),
        event: 'pull_request',
        action: payload.action,
        repo: payload.repository.full_name,
        branch: pr.head.ref,
        workflow: 'PR Review',
        runId: pr.number,
        runAttempt: 1,
        conclusion: payload.action,
        status: 'duplicate',
        prNumber: pr.number,
        prTitle: pr.title,
        headSha: pr.head.sha,
        baseBranch: pr.base.ref,
      })
      return {
        statusCode: 200,
        body: { accepted: false, eventId, status: 'duplicate' },
      }
    }

    // --- Supersede any active session for this PR ---
    this.supersedePrSessions(payload.repository.full_name, pr.number)

    // --- Session cap check ---
    if (this.isAtSessionCap(eventId)) {
      this.recordEvent({
        id: eventId,
        idempotencyKey,
        receivedAt: new Date().toISOString(),
        event: 'pull_request',
        action: payload.action,
        repo: payload.repository.full_name,
        branch: pr.head.ref,
        workflow: 'PR Review',
        runId: pr.number,
        runAttempt: 1,
        conclusion: payload.action,
        status: 'error',
        error: `Max concurrent webhook sessions reached (${this.config.maxConcurrentSessions})`,
        prNumber: pr.number,
        prTitle: pr.title,
        headSha: pr.head.sha,
        baseBranch: pr.base.ref,
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
      event: 'pull_request',
      action: payload.action,
      repo: payload.repository.full_name,
      branch: pr.head.ref,
      workflow: 'PR Review',
      runId: pr.number,
      runAttempt: 1,
      conclusion: payload.action,
      status: 'processing',
      sessionId,
      prNumber: pr.number,
      prTitle: pr.title,
      headSha: pr.head.sha,
      baseBranch: pr.base.ref,
    }
    this.recordEvent(webhookEvent)
    this.dedup.recordProcessed(eventId, idempotencyKey)

    // Process asynchronously — don't block the 202 response
    this.processPullRequestAsync(payload, webhookEvent, sessionId).catch(err => {
      console.error('[webhook] PR async processing error:', err)
      // Don't overwrite 'superseded' status if a newer event already took over
      if (this.getEvent(eventId)?.status !== 'superseded') {
        this.updateEventStatus(eventId, 'error', String(err))
      }
    })

    return {
      statusCode: 202,
      body: { accepted: true, eventId, status: 'processing', sessionId },
    }
  }

  /**
   * Async background processing for pull_request events:
   * fetch PR context, create workspace, create session, send review prompt.
   */
  private async processPullRequestAsync(
    payload: PullRequestPayload,
    event: WebhookEvent,
    sessionId: string,
  ): Promise<void> {
    const pr = payload.pull_request
    const repo = payload.repository.full_name
    const repoName = payload.repository.name

    console.log(`[webhook] Processing PR: ${repo} #${pr.number} "${pr.title}" (${payload.action})`)

    // --- Fetch PR context (all calls degrade gracefully) ---
    const [diffResult, fileList, commitMessages, reviewComments, reviews, priorCache, existingCommentId] = await Promise.all([
      fetchPrDiff(repo, pr.number),
      fetchPrFiles(repo, pr.number),
      fetchPrCommits(repo, pr.number),
      fetchPrReviewComments(repo, pr.number),
      fetchPrReviews(repo, pr.number),
      Promise.resolve(loadPrCache(repo, pr.number)),
      fetchExistingReviewComment(repo, pr.number),
    ])
    const cachePath = ensureCacheDir(repo, pr.number)

    // Check if superseded while fetching PR context
    if (this.getEvent(event.id)?.status === 'superseded') {
      console.log(`[webhook] Event ${event.id} was superseded, aborting PR processing`)
      return
    }

    const context: PullRequestContext = {
      repo,
      prNumber: pr.number,
      prTitle: pr.title,
      prBody: pr.body ?? '',
      prUrl: pr.html_url,
      author: pr.user.login,
      headBranch: pr.head.ref,
      baseBranch: pr.base.ref,
      headSha: pr.head.sha,
      baseSha: pr.base.sha,
      beforeSha: payload.before,
      action: payload.action as PullRequestContext['action'],
      changedFiles: pr.changed_files,
      additions: pr.additions,
      deletions: pr.deletions,
      diff: diffResult.diff,
      fileList,
      commitMessages,
      reviewComments,
      reviews,
    }

    // --- Create workspace ---
    let workspacePath: string
    try {
      workspacePath = await createWorkspace(
        sessionId,
        repo,
        pr.head.repo?.clone_url ?? payload.repository.clone_url,
        pr.head.ref,
        pr.head.sha,
      )
    } catch (err) {
      console.error(`[webhook] Failed to create workspace for PR ${repo}#${pr.number}:`, err)
      // Don't overwrite 'superseded' status if a newer event already took over
      if (this.getEvent(event.id)?.status !== 'superseded') {
        this.updateEventStatus(event.id, 'error', `Workspace creation failed: ${err}`)
      }
      return
    }

    // Check if superseded while creating workspace
    if (this.getEvent(event.id)?.status === 'superseded') {
      console.log(`[webhook] Event ${event.id} was superseded during workspace creation, cleaning up`)
      cleanupWorkspace(sessionId)
      return
    }

    // --- Create session ---
    const groupDir = `${REPOS_ROOT}/${repoName}`
    let sessionName: string
    if (payload.action === 'synchronize') {
      sessionName = `PR #${pr.number}: ${pr.title} (update @${pr.head.sha.slice(0, 7)})`
    } else if (payload.action === 'reopened') {
      sessionName = `PR #${pr.number}: ${pr.title} (reopened)`
    } else {
      sessionName = `PR #${pr.number}: ${pr.title}`
    }

    this.sessions.create(sessionName, workspacePath, {
      source: 'webhook',
      id: sessionId,
      groupDir,
      model: 'sonnet',
      allowedTools: [
        'Bash(gh:*)',
        'Write',
        'mcp__plugin_context7_context7__resolve-library-id',
        'mcp__plugin_context7_context7__query-docs',
        'WebFetch',
        'WebSearch',
      ],
      addDirs: [dirname(cachePath)],
    })

    console.log(`[webhook] PR session created: ${sessionName} (${sessionId})`)
    this.updateEventStatus(event.id, 'session_created')

    // --- Broadcast webhook event ---
    const updatedEvent = this.getEvent(event.id)
    if (updatedEvent) this.broadcastWebhookEvent(updatedEvent)

    // --- Build and send prompt ---
    const prompt = buildPrReviewPrompt(context, workspacePath, {
      priorCache: priorCache ?? undefined,
      cachePath,
      existingCommentId,
    })
    this.sessions.sendInput(sessionId, prompt)

    console.log(`[webhook] PR review prompt sent to session ${sessionId}, session is processing...`)
  }

  // ---------------------------------------------------------------------------
  // Shared helpers
  // ---------------------------------------------------------------------------

  /**
   * Handle a PR being closed or merged: kill active sessions and archive/delete cache.
   */
  private handlePrClosed(
    payload: PullRequestPayload,
    eventId: string,
  ): { statusCode: number; body: Record<string, unknown> } {
    const pr = payload.pull_request
    const repo = payload.repository.full_name
    const merged = pr.merged

    console.log(`[webhook] PR ${repo}#${pr.number} ${merged ? 'merged' : 'closed'}, cleaning up`)

    // Record the event for observability
    this.recordEvent({
      id: eventId,
      idempotencyKey: computePrIdempotencyKey(repo, pr.number, 'closed', pr.head.sha),
      receivedAt: new Date().toISOString(),
      event: 'pull_request',
      action: 'closed',
      repo,
      branch: pr.head.ref,
      workflow: 'PR Review',
      runId: pr.number,
      runAttempt: 1,
      conclusion: merged ? 'merged' : 'closed',
      status: 'completed',
      prNumber: pr.number,
      prTitle: pr.title,
      headSha: pr.head.sha,
      baseBranch: pr.base.ref,
    })

    // Kill any active review sessions for this PR
    this.supersedePrSessions(repo, pr.number, merged ? 'PR merged' : 'PR closed')

    // Archive or delete the cache file
    if (merged) {
      archivePrCache(repo, pr.number)
    } else {
      deletePrCache(repo, pr.number)
    }

    return {
      statusCode: 200,
      body: {
        accepted: true,
        eventId,
        status: 'processed',
        action: merged ? 'merged' : 'closed',
      },
    }
  }

  /**
   * Find and terminate any active sessions for the same PR.
   * Called before creating a new session so a new push supersedes the old review.
   */
  private supersedePrSessions(repo: string, prNumber: number, reason = 'Superseded by new push'): void {
    const activeStatuses: WebhookEventStatus[] = ['processing', 'session_created']
    const activeEvents = this.getEvents().filter(
      e => e.repo === repo && e.prNumber === prNumber && activeStatuses.includes(e.status)
    )

    for (const oldEvent of activeEvents) {
      console.log(`[webhook] Superseding PR session: event=${oldEvent.id} session=${oldEvent.sessionId} (PR ${repo}#${prNumber})`)

      // Mark superseded FIRST so the exit listener won't overwrite the status
      this.updateEventStatus(oldEvent.id, 'superseded', reason)

      // Delete the session (kills process, cleans up workspace)
      if (oldEvent.sessionId) {
        this.sessions.delete(oldEvent.sessionId)
      }
    }
  }

  /**
   * Check if the webhook session concurrency cap has been reached.
   */
  private isAtSessionCap(_eventId: string): boolean {
    const activeWebhookSessions = this.sessions.list().filter(s => s.source === 'webhook' && s.active).length
    const processingEvents = this.countByStatus('processing')
    const effectiveConcurrency = activeWebhookSessions + processingEvents
    return effectiveConcurrency >= this.config.maxConcurrentSessions
  }

  /**
   * Async background processing for workflow_run events:
   * fetch logs, create workspace, create session, send prompt.
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
    const updatedEvent = this.getEvent(event.id)
    if (updatedEvent) this.broadcastWebhookEvent(updatedEvent)

    // --- Build and send prompt ---
    const prompt = buildPrompt(context, logLines)
    this.sessions.sendInput(sessionId, prompt)

    console.log(`[webhook] Prompt sent to session ${sessionId}, session is processing...`)
  }

  /**
   * Broadcast a webhook event notification to all connected WebSocket clients.
   * Sent globally (not scoped to the new session) so any open browser tab can
   * display the incoming webhook badge regardless of which session is active.
   */
  private broadcastWebhookEvent(event: WebhookEvent): void {
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

    for (const sessionInfo of allSessions) {
      const session = this.sessions.get(sessionInfo.id)
      if (session) {
        this.sessions.broadcast(session, msg)
      }
    }
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
