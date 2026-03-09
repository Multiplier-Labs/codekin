/**
 * Stepflow → Codekin webhook handler.
 *
 * Receives signed webhook deliveries from a Stepflow `WebhookEventTransport`,
 * creates an isolated git workspace, spawns a Claude session, and POSTs the
 * result back to the workflow via a callback URL.
 *
 * ┌──────────────────────────────────────────────────────────────────────────┐
 * │  Request lifecycle                                                       │
 * │                                                                          │
 * │  POST /api/webhooks/stepflow                                             │
 * │    1. Enabled check           — STEPFLOW_WEBHOOK_ENABLED must be true   │
 * │    2. Signature verify        — X-Webhook-Signature HMAC-SHA256         │
 * │    3. Parse & validate        — StepflowWebhookPayload shape check      │
 * │    4. Event type filter       — only claude.session.requested           │
 * │    5. Deduplication           — webhookId already seen? → 200 duplicate │
 * │    6. Concurrency cap         — active sessions >= max? → 429           │
 * │    7. 202 Accepted            — response sent; processing continues     │
 * │                                                                          │
 * │  Async (processAsync):                                                   │
 * │    8. createWorkspace()       — bare mirror + session-specific clone    │
 * │    9. sessions.create()       — spawn Claude with source='stepflow'     │
 * │   10. sessions.sendInput()    — deliver the built prompt                │
 * │                                                                          │
 * │  On session exit (onSessionExit callback):                              │
 * │   11. POST result to callbackUrl (if provided)                         │
 * │   12. cleanupWorkspace()      — remove workspace dir                   │
 * └──────────────────────────────────────────────────────────────────────────┘
 *
 * Configuration (environment variables):
 *   STEPFLOW_WEBHOOK_ENABLED      — `'true'` / `'1'` to enable (default: false)
 *   STEPFLOW_WEBHOOK_SECRET       — shared HMAC secret with Stepflow (required)
 *   STEPFLOW_WEBHOOK_MAX_SESSIONS — max concurrent sessions (default: 3)
 *
 * Stepflow setup snippet:
 * ```typescript
 * import { WebhookEventTransport } from '@multiplier-labs/stepflow'
 *
 * new WebhookEventTransport({
 *   endpoints: [{
 *     id: 'codekin',
 *     url: 'https://codekin.internal/api/webhooks/stepflow',
 *     secret: process.env.STEPFLOW_WEBHOOK_SECRET,
 *     eventTypes: ['claude.session.requested'],
 *   }],
 * })
 *
 * // Inside a step handler:
 * ctx.emit('claude.session.requested', {
 *   repo: 'acme/my-app',
 *   cloneUrl: 'https://github.com/acme/my-app.git',
 *   branch: 'main',
 *   headSha: commit.sha,
 *   taskDescription: 'Fix the failing TypeScript type errors.',
 *   callbackUrl: `${CODEKIN_URL}/api/stepflow/callback/${ctx.runId}`,
 *   callbackSecret: process.env.STEPFLOW_CALLBACK_SECRET,
 * } satisfies StepflowSessionRequest)
 * ```
 */

import crypto from 'crypto'
import { randomUUID } from 'crypto'
import type { SessionManager } from './session-manager.js'
import { verifyHmacSignature } from './crypto-utils.js'
import type {
  StepflowConfig,
  StepflowEvent,
  StepflowEventStatus,
  StepflowSessionRequest,
  StepflowSessionResult,
  StepflowWebhookPayload,
} from './stepflow-types.js'
import { buildStepflowPrompt } from './stepflow-prompt.js'
import { createWorkspace, cleanupWorkspace } from './webhook-workspace.js'

/** Maximum events stored in the in-memory ring buffer for the management API. */
const MAX_EVENT_HISTORY = 100

/**
 * How long an event may remain in `'processing'` before the watchdog marks it
 * as `'error'`.  Guards against permanently inflated concurrency counts caused
 * by partial failures during workspace creation or session startup.
 */
const PROCESSING_TIMEOUT_MS = 5 * 60 * 1000

/** The only Stepflow event type we act on.  All others are filtered. */
const SUPPORTED_EVENT_TYPE = 'claude.session.requested'

/** TTL for deduplication entries — matches WebhookDedup's 1-hour window. */
const DEDUP_TTL_MS = 60 * 60 * 1000

export class StepflowHandler {
  private config: StepflowConfig
  private sessions: SessionManager

  /** Ring buffer of processed events, capped at MAX_EVENT_HISTORY. */
  private events: StepflowEvent[] = []

  /**
   * Map of webhookId → processedAt timestamp (ms) for deduplication.
   * Entries are evicted after DEDUP_TTL_MS to bound memory usage.
   * Stepflow retries on non-2xx; this prevents duplicate sessions.
   * Note: in-memory only — server restart clears this, which is acceptable
   * because the workspace + session name also provides natural idempotency.
   */
  private seenWebhookIds = new Map<string, number>()

  /**
   * Per-session callback secrets, stored separately from `StepflowEvent` so
   * they are never exposed via the management API.
   *
   * Lifecycle: added in `processAsync`, deleted in the session exit callback.
   *   key   — Codekin sessionId
   *   value — callbackSecret from the Stepflow workflow (may be undefined)
   */
  private sessionCallbackSecrets = new Map<string, string | undefined>()

  private _processingWatchdog: ReturnType<typeof setInterval> | null = null

  constructor(config: StepflowConfig, sessions: SessionManager) {
    this.config = config
    this.sessions = sessions

    // -----------------------------------------------------------------------
    // Session exit: update event status, fire callback, clean up workspace
    // -----------------------------------------------------------------------
    sessions.onSessionExit((sessionId, code, _signal, willRestart) => {
      // Don't report yet if Claude's auto-restart will retry the session
      if (willRestart) return

      const event = this.events.find(
        e => e.sessionId === sessionId &&
          (e.status === 'session_created' || e.status === 'processing'),
      )
      if (!event) return

      const status: StepflowEventStatus = code === 0 ? 'completed' : 'error'
      const error = code !== 0 ? `Claude exited with code ${code}` : undefined
      this.updateEventStatus(event.id, status, error)
      console.log(`[stepflow] Event ${event.id} → ${status} (session ${sessionId}, code=${code})`)

      // Retrieve and remove the callback secret before firing the callback so
      // it doesn't linger in memory after it's been used.
      const callbackSecret = this.sessionCallbackSecrets.get(sessionId)
      this.sessionCallbackSecrets.delete(sessionId)

      if (event.callbackUrl) {
        const result: StepflowSessionResult = {
          runId: event.runId,
          sessionId,
          status,
          exitCode: code ?? 1,
          error,
        }
        this.postCallback(event.callbackUrl, result, callbackSecret).catch(err => {
          console.warn(`[stepflow] Callback POST failed for event ${event.id}:`, err)
        })
      }

      cleanupWorkspace(sessionId)
    })

    // -----------------------------------------------------------------------
    // Watchdog: release concurrency cap from stuck 'processing' events
    // -----------------------------------------------------------------------
    this._processingWatchdog = setInterval(() => {
      const cutoff = Date.now() - PROCESSING_TIMEOUT_MS
      for (const event of this.events) {
        if (event.status === 'processing' && new Date(event.receivedAt).getTime() < cutoff) {
          console.warn(
            `[stepflow] Watchdog: event ${event.id} stuck in 'processing' for >5min, marking error`,
          )
          this.updateEventStatus(event.id, 'error', 'Processing timed out (watchdog)')
        }
      }
    }, 60_000)
    if (this._processingWatchdog.unref) this._processingWatchdog.unref()
  }

  // ---------------------------------------------------------------------------
  // Public: HTTP entry point
  // ---------------------------------------------------------------------------

  /**
   * Handle an incoming Stepflow webhook POST.
   *
   * Runs all synchronous checks synchronously, responds 202, then kicks off
   * async processing.  This keeps the HTTP round-trip fast regardless of how
   * long workspace cloning or gh API calls take.
   *
   * @param rawBody   Raw request body Buffer.  HMAC is computed over these
   *                  exact bytes — do NOT re-serialize before passing in.
   * @param signature Value of the `X-Webhook-Signature` header.
   */
  async handleWebhook(
    rawBody: Buffer,
    signature: string,
  ): Promise<{ statusCode: number; body: Record<string, unknown> }> {

    // 1. Master switch
    if (!this.config.enabled) {
      return {
        statusCode: 200,
        body: { accepted: false, filterReason: 'Stepflow webhook integration is disabled' },
      }
    }

    // 2. Signature
    if (!signature) {
      return { statusCode: 401, body: { error: 'Missing X-Webhook-Signature header' } }
    }
    if (!this.verifySignature(rawBody, signature)) {
      return { statusCode: 401, body: { error: 'Invalid X-Webhook-Signature' } }
    }

    // 3. Parse
    let payload: StepflowWebhookPayload
    try {
      payload = JSON.parse(rawBody.toString('utf-8')) as StepflowWebhookPayload
    } catch {
      return { statusCode: 400, body: { error: 'Malformed JSON payload' } }
    }

    if (!payload.event || !payload.webhookId) {
      return { statusCode: 400, body: { error: 'Missing event or webhookId in payload' } }
    }

    const { event } = payload
    const deliveryId = payload.webhookId

    // 4. Event type filter
    if (event.eventType !== SUPPORTED_EVENT_TYPE) {
      return {
        statusCode: 200,
        body: {
          accepted: false,
          filterReason: `Event type '${event.eventType}' not supported (only '${SUPPORTED_EVENT_TYPE}')`,
        },
      }
    }

    // 5. Validate session request shape
    const req = event.payload as StepflowSessionRequest | undefined
    if (!req ||
        typeof req.repo !== 'string' ||
        typeof req.cloneUrl !== 'string' ||
        typeof req.branch !== 'string' ||
        typeof req.headSha !== 'string' ||
        typeof req.taskDescription !== 'string') {
      return {
        statusCode: 400,
        body: {
          error: 'event.payload must include: repo, cloneUrl, branch, headSha, taskDescription',
        },
      }
    }

    // 6. Deduplication
    const now = Date.now()
    // Evict expired entries to bound memory usage
    for (const [id, ts] of this.seenWebhookIds) {
      if (now - ts > DEDUP_TTL_MS) this.seenWebhookIds.delete(id)
    }
    if (this.seenWebhookIds.has(deliveryId)) {
      this.recordEvent({
        id: deliveryId,
        receivedAt: new Date().toISOString(),
        runId: event.runId,
        kind: event.kind,
        eventType: event.eventType,
        stepKey: event.stepKey,
        repo: req.repo,
        branch: req.branch,
        status: 'duplicate',
        filterReason: `webhookId '${deliveryId}' already processed`,
      })
      return {
        statusCode: 200,
        body: { accepted: false, status: 'duplicate', webhookId: deliveryId },
      }
    }

    // 7. Concurrency cap
    // Include both active sessions AND events still in 'processing' (workspace
    // being set up) so rapid concurrent deliveries can't bypass the cap during
    // the async window between accepting the webhook and creating the session.
    const activeCount = this.sessions.list().filter(s => s.source === 'stepflow' && s.active).length
    const processingCount = this.events.filter(e => e.status === 'processing').length
    if (activeCount + processingCount >= this.config.maxConcurrentSessions) {
      return {
        statusCode: 429,
        body: {
          error: 'Max concurrent Stepflow sessions reached',
          max: this.config.maxConcurrentSessions,
        },
      }
    }

    // 8. Accept: pre-allocate session ID, record the event, respond 202
    const sessionId = randomUUID()
    const stepflowEvent: StepflowEvent = {
      id: deliveryId,
      receivedAt: new Date().toISOString(),
      runId: event.runId,
      kind: event.kind,
      eventType: event.eventType,
      stepKey: event.stepKey,
      repo: req.repo,
      branch: req.branch,
      status: 'processing',
      sessionId,
      callbackUrl: req.callbackUrl,
    }
    this.recordEvent(stepflowEvent)
    this.seenWebhookIds.set(deliveryId, Date.now())

    // Store the callback secret keyed by sessionId so the exit handler can
    // retrieve it without it appearing in the public event record.
    if (req.callbackSecret) {
      this.sessionCallbackSecrets.set(sessionId, req.callbackSecret)
    }

    // Fire-and-forget
    this.processAsync(req, stepflowEvent, sessionId, event.runId, event.kind).catch(err => {
      console.error('[stepflow] Async processing error:', err)
      this.updateEventStatus(deliveryId, 'error', String(err))
    })

    return {
      statusCode: 202,
      body: { accepted: true, status: 'processing', sessionId, webhookId: deliveryId },
    }
  }

  // ---------------------------------------------------------------------------
  // Private: async session lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Background processing: clone workspace → create session → deliver prompt.
   * Called after the 202 has been sent so it never blocks the HTTP response.
   */
  private async processAsync(
    req: StepflowSessionRequest,
    event: StepflowEvent,
    sessionId: string,
    runId: string,
    kind: string,
  ): Promise<void> {
    const repoName = req.repo.split('/')[1] ?? req.repo
    console.log(`[stepflow] Processing: ${req.repo} / ${req.branch} (run ${runId})`)

    // Clone a fresh workspace from the shared bare mirror
    let workspacePath: string
    try {
      workspacePath = await createWorkspace(
        sessionId,
        req.repo,
        req.cloneUrl,
        req.branch,
        req.headSha,
      )
    } catch (err) {
      console.error(`[stepflow] Workspace creation failed for ${req.repo}:`, err)
      this.updateEventStatus(event.id, 'error', `Workspace creation failed: ${err}`)
      // Clean up the orphaned callback secret
      this.sessionCallbackSecrets.delete(sessionId)
      return
    }

    // Group under the canonical repo path so the UI places this session
    // alongside manual sessions for the same repo.
    const reposRoot = process.env.REPOS_ROOT || `${process.env.HOME}/repos`
    const groupDir = `${reposRoot}/${repoName}`
    const sessionName = `stepflow/${repoName}/${req.branch}/${kind}`
    this.sessions.create(sessionName, workspacePath, {
      source: 'stepflow',
      id: sessionId,
      groupDir,
    })

    console.log(`[stepflow] Session created: ${sessionName} (${sessionId})`)
    this.updateEventStatus(event.id, 'session_created')

    // Build and deliver the prompt to Claude
    const prompt = buildStepflowPrompt(req, runId, kind)
    this.sessions.sendInput(sessionId, prompt)

    console.log(`[stepflow] Prompt sent to session ${sessionId}, Claude is processing...`)
  }

  // ---------------------------------------------------------------------------
  // Private: result callback
  // ---------------------------------------------------------------------------

  /**
   * POST the session result to the Stepflow workflow's callback URL.
   *
   * If `callbackSecret` is provided the body is signed with HMAC-SHA256 and
   * the signature is set in the `X-Stepflow-Signature: sha256=<hex>` header,
   * matching the same convention Stepflow uses for outbound webhook signing.
   * The receiving Stepflow step can verify the signature to confirm the
   * callback came from Codekin and not a third party.
   *
   * Times out after 10 seconds.  Errors are logged but not re-thrown —
   * a failed callback does not change the session's final status.
   */
  private async postCallback(
    callbackUrl: string,
    result: StepflowSessionResult,
    callbackSecret?: string,
  ): Promise<void> {
    const body = JSON.stringify(result)
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'User-Agent': 'codekin/1.0',
    }

    if (callbackSecret) {
      const sig = 'sha256=' + crypto
        .createHmac('sha256', callbackSecret)
        .update(body)
        .digest('hex')
      headers['X-Stepflow-Signature'] = sig
    }

    // SSRF protection: validate callback URL against allowlist
    const parsedUrl = new URL(callbackUrl)
    if (parsedUrl.protocol !== 'https:' && parsedUrl.protocol !== 'http:') {
      throw new Error(`Callback URL protocol ${parsedUrl.protocol} not allowed`)
    }
    if (this.config.allowedCallbackHosts.length > 0 &&
        !this.config.allowedCallbackHosts.includes(parsedUrl.hostname)) {
      throw new Error(`Callback host ${parsedUrl.hostname} not in allowlist`)
    }
    // Block private/link-local IP ranges (IPv4 and IPv6)
    const ip = parsedUrl.hostname
    // Strip brackets from IPv6 addresses for matching
    const bareIp = ip.startsWith('[') && ip.endsWith(']') ? ip.slice(1, -1) : ip
    if (/^(127\.|10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|169\.254\.|0\.)/.test(bareIp) ||
        bareIp === 'localhost' || bareIp === '::1' ||
        /^fe80:/i.test(bareIp) ||   // IPv6 link-local
        /^f[cd]/i.test(bareIp) ||   // IPv6 unique-local (fc00::/7)
        bareIp === '::' || bareIp === '::ffff:127.0.0.1') {
      throw new Error(`Callback to private/link-local address ${ip} is blocked`)
    }

    const response = await fetch(callbackUrl, {
      method: 'POST',
      headers,
      body,
      signal: AbortSignal.timeout(10_000),
    })

    if (!response.ok) {
      throw new Error(`Callback to ${callbackUrl} returned HTTP ${response.status}`)
    }

    console.log(`[stepflow] Callback delivered to ${callbackUrl} (${response.status})`)
  }

  // ---------------------------------------------------------------------------
  // Private: HMAC signature verification
  // ---------------------------------------------------------------------------

  /**
   * Verify the `X-Webhook-Signature` header sent by Stepflow.
   * Format is `sha256=<hex>` — the same convention GitHub and Stepflow both use.
   * Comparison uses `timingSafeEqual` to resist timing oracle attacks.
   */
  verifySignature(payload: Buffer, signature: string): boolean {
    if (!this.config.secret) return false
    return verifyHmacSignature(payload, signature, this.config.secret)
  }

  // ---------------------------------------------------------------------------
  // Private: event ring buffer
  // ---------------------------------------------------------------------------

  private recordEvent(event: StepflowEvent): void {
    this.events.push(event)
    if (this.events.length > MAX_EVENT_HISTORY) {
      this.events = this.events.slice(-MAX_EVENT_HISTORY)
    }
  }

  private updateEventStatus(eventId: string, status: StepflowEventStatus, error?: string): void {
    const event = this.events.find(e => e.id === eventId)
    if (event) {
      event.status = status
      if (error) event.error = error
    }
  }

  // ---------------------------------------------------------------------------
  // Public: management API surface
  // ---------------------------------------------------------------------------

  getEvents(): StepflowEvent[] {
    return [...this.events]
  }

  getEvent(id: string): StepflowEvent | undefined {
    return this.events.find(e => e.id === id)
  }

  isEnabled(): boolean {
    return this.config.enabled
  }

  // ---------------------------------------------------------------------------
  // Public: lifecycle
  // ---------------------------------------------------------------------------

  shutdown(): void {
    if (this._processingWatchdog) {
      clearInterval(this._processingWatchdog)
      this._processingWatchdog = null
    }
  }
}

// ---------------------------------------------------------------------------
// Config loader
// ---------------------------------------------------------------------------

/**
 * Load Stepflow webhook configuration from environment variables.
 *
 * ```
 * STEPFLOW_WEBHOOK_ENABLED=true        # master switch (default: false)
 * STEPFLOW_WEBHOOK_SECRET=changeme     # HMAC-SHA256 secret (required when enabled)
 * STEPFLOW_WEBHOOK_MAX_SESSIONS=3      # max concurrent Claude sessions (default: 3)
 * ```
 */
export function loadStepflowConfig(): StepflowConfig {
  const envEnabled = process.env.STEPFLOW_WEBHOOK_ENABLED
  const enabled = envEnabled === 'true' || envEnabled === '1'

  const secret = process.env.STEPFLOW_WEBHOOK_SECRET || ''

  let maxConcurrentSessions = 3
  const envMax = process.env.STEPFLOW_WEBHOOK_MAX_SESSIONS
  if (envMax !== undefined) {
    const n = parseInt(envMax, 10)
    if (!isNaN(n) && n > 0) maxConcurrentSessions = n
  }

  const allowedCallbackHosts = (process.env.STEPFLOW_CALLBACK_HOSTS || '')
    .split(',').map(s => s.trim()).filter(Boolean)

  return { enabled, secret, maxConcurrentSessions, allowedCallbackHosts }
}
