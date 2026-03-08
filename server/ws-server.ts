/**
 * Main entry point for the Codekin WebSocket server.
 *
 * Provides:
 * - WebSocket server for real-time browser↔session communication
 * - REST API for session CRUD, health checks, tool approval, and hook endpoints
 * - File upload, repo listing, and clone endpoints (merged from upload-server)
 * - GitHub webhook endpoint for automated CI/CD event handling
 * - Stepflow webhook endpoint for workflow-orchestrated Claude sessions
 * - Token-based authentication (via AUTH_TOKEN env var or --auth-file)
 *
 * Single-process server on PORT (default 32352), behind nginx reverse proxy at /cc.
 */

import express from 'express'
import { createServer } from 'http'
import { WebSocketServer, WebSocket } from 'ws'
import { readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { execSync } from 'child_process'
import { randomUUID } from 'crypto'
import { SessionManager } from './session-manager.js'
import type { WsClientMessage, WsServerMessage } from './types.js'
import { loadWebhookConfig } from './webhook-config.js'
import { WebhookHandler } from './webhook-handler.js'
import { createWebhookRateLimiter } from './webhook-rate-limiter.js'
import { StepflowHandler, loadStepflowConfig } from './stepflow-handler.js'
import { initWorkflowEngine, shutdownWorkflowEngine, type WorkflowEvent } from './workflow-engine.js'
import { loadMdWorkflows } from './workflow-loader.js'
import { createWorkflowRouter, syncSchedules } from './workflow-routes.js'
import { createAuthRouter } from './auth-routes.js'
import { createSessionRouter } from './session-routes.js'
import { createWebhookRouter } from './webhook-routes.js'
import { createUploadRouter } from './upload-routes.js'
import { PORT as CONFIG_PORT, AUTH_TOKEN as configAuthToken, CORS_ORIGIN, FRONTEND_DIST } from './config.js'

// ---------------------------------------------------------------------------
// CLI args (legacy bare-metal compat) and auth setup
// ---------------------------------------------------------------------------
const args = process.argv.slice(2)
let port = CONFIG_PORT
let authToken = configAuthToken

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--port' && args[i + 1]) port = parseInt(args[i + 1], 10)
  if (args[i] === '--auth-file' && args[i + 1]) {
    const authFile = args[i + 1]
    if (existsSync(authFile)) {
      authToken = readFileSync(authFile, 'utf-8').trim()
      console.log(`Auth token loaded from ${authFile}`)
    } else {
      console.error(`Auth file not found: ${authFile}`)
      process.exit(1)
    }
  }
}

if (authToken) {
  console.log('Auth token configured')
}

/** Check if a token matches the configured auth token (passes if no auth configured). */
function verifyToken(token: string | undefined): boolean {
  if (!authToken) return true  // No auth configured
  return token === authToken
}

/** Extract auth token from query string, Authorization header, or request body. */
function extractToken(req: express.Request): string | undefined {
  const qToken = req.query.token as string | undefined
  if (qToken) return qToken

  // Check Authorization header
  const authHeader = req.headers.authorization
  if (authHeader?.startsWith('Bearer ')) {
    return authHeader.slice(7)
  }

  // Check body
  if (req.body?.token) return req.body.token

  return undefined
}

// ---------------------------------------------------------------------------
// Startup checks
// ---------------------------------------------------------------------------
let claudeAvailable = false
let claudeVersion = ''
const apiKeySet = !!(process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_CODE_API_KEY)

try {
  claudeVersion = execSync('claude --version', { timeout: 5000 }).toString().trim()
  claudeAvailable = true
  console.log(`Claude CLI found: ${claudeVersion}`)
} catch {
  console.warn('Claude CLI not found or not working')
}

if (!apiKeySet) {
  console.warn('No API key configured (ANTHROPIC_API_KEY or CLAUDE_CODE_API_KEY)')
}

// ---------------------------------------------------------------------------
// Core services
// ---------------------------------------------------------------------------
const sessions = new SessionManager()
sessions._serverPort = port
sessions._authToken = authToken

// GitHub webhook handler
const webhookConfig = loadWebhookConfig()
const webhookHandler = new WebhookHandler(webhookConfig, sessions)

// Run gh health check asynchronously at startup
if (webhookConfig.enabled) {
  if (!webhookConfig.secret) {
    console.warn('[webhook] GITHUB_WEBHOOK_SECRET not set — webhook signature validation will fail')
  }
  webhookHandler.checkHealth().then(healthy => {
    if (healthy) {
      console.log('[webhook] Webhook processing enabled')
    }
  })
} else {
  console.log('[webhook] Webhook processing disabled (GITHUB_WEBHOOK_ENABLED != true)')
}

// Stepflow webhook handler
// Receives claude.session.requested events from Stepflow WebhookEventTransport.
// See stepflow-handler.ts and stepflow-types.ts for integration details.
const stepflowConfig = loadStepflowConfig()
const stepflowHandler = new StepflowHandler(stepflowConfig, sessions)

if (stepflowConfig.enabled) {
  if (!stepflowConfig.secret) {
    console.warn('[stepflow] STEPFLOW_WEBHOOK_SECRET not set — signature validation will fail')
  }
  console.log('[stepflow] Stepflow webhook integration enabled')
} else {
  console.log('[stepflow] Stepflow webhook integration disabled (STEPFLOW_WEBHOOK_ENABLED != true)')
}

// ---------------------------------------------------------------------------
// Express app and REST API
// ---------------------------------------------------------------------------
const app = express()

// In Docker / standalone mode (FRONTEND_DIST set), the server is reached directly without nginx.
// nginx normally strips the /cc prefix before proxying; we replicate that here so the frontend
// (which hardcodes BASE = '/cc') works against the Node server without modification.
if (FRONTEND_DIST && existsSync(FRONTEND_DIST)) {
  app.use((req, _res, next) => {
    if (req.url.startsWith('/cc/')) req.url = req.url.slice(3)
    else if (req.url === '/cc') req.url = '/'
    next()
  })
}

// Both webhook endpoints use raw body for HMAC verification — register BEFORE express.json().
// express.raw() must run before any rate limiter so req.body is a Buffer.
const githubRateLimiter = createWebhookRateLimiter()
app.post(
  '/api/webhooks/github',
  express.raw({ type: 'application/json', limit: '5mb' }),
  githubRateLimiter,
  async (req, res) => {
    const rawBody = req.body as Buffer
    if (!Buffer.isBuffer(rawBody) || rawBody.length === 0) {
      return res.status(400).json({ error: 'Empty or non-JSON body' })
    }

    const result = await webhookHandler.handleWebhook(rawBody, {
      event: req.headers['x-github-event'] as string || '',
      delivery: req.headers['x-github-delivery'] as string || '',
      signature: req.headers['x-hub-signature-256'] as string || '',
    })

    res.status(result.statusCode).json(result.body)
  },
)

// Stepflow webhook endpoint.
// Stepflow signs with X-Webhook-Signature (HMAC-SHA256, format: sha256=<hex>).
// Rate-limited per workflow kind; no gh CLI health check needed.
const stepflowRateLimiter = createWebhookRateLimiter(
  30,
  (body) => (body as { event?: { kind?: string } } | undefined)?.event?.kind,
)
app.post(
  '/api/webhooks/stepflow',
  express.raw({ type: 'application/json', limit: '1mb' }),
  stepflowRateLimiter,
  async (req, res) => {
    const rawBody = req.body as Buffer
    if (!Buffer.isBuffer(rawBody) || rawBody.length === 0) {
      return res.status(400).json({ error: 'Empty or non-JSON body' })
    }

    const signature = req.headers['x-webhook-signature'] as string || ''
    const result = await stepflowHandler.handleWebhook(rawBody, signature)
    res.status(result.statusCode).json(result.body)
  },
)

// JSON body parser for all other routes
app.use(express.json())

// CORS — restrict to configured origin (default: allow all for local dev)
app.use((_req, res, next) => {
  res.header('Access-Control-Allow-Origin', CORS_ORIGIN)
  res.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS')
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization')
  if (_req.method === 'OPTIONS') return res.sendStatus(204)
  next()
})

// --- Serve frontend static files (Docker / standalone mode) ---
if (FRONTEND_DIST && existsSync(FRONTEND_DIST)) {
  app.use(express.static(FRONTEND_DIST))
  console.log(`Serving frontend from ${FRONTEND_DIST}`)
}

// --- REST API routes (delegated to dedicated routers) ---
app.use(createAuthRouter(verifyToken, extractToken, sessions, claudeAvailable, claudeVersion, apiKeySet))
app.use(createSessionRouter(verifyToken, extractToken, sessions))
app.use(createWebhookRouter(verifyToken, extractToken, webhookHandler, stepflowHandler))
app.use(createUploadRouter(verifyToken, extractToken))
app.use('/api/workflows', createWorkflowRouter(verifyToken, extractToken))

// --- SPA fallback: serve index.html for non-API routes (client-side routing) ---
if (FRONTEND_DIST && existsSync(FRONTEND_DIST)) {
  const indexPath = join(FRONTEND_DIST, 'index.html')
  if (existsSync(indexPath)) {
    app.get('*', (req, res) => {
      if (req.path.startsWith('/api/')) {
        res.status(404).json({ error: 'Not found' })
        return
      }
      res.sendFile(indexPath)
    })
  }
}

// ---------------------------------------------------------------------------
// WebSocket server
// ---------------------------------------------------------------------------

const server = createServer(app)
const wss = new WebSocketServer({ server })

// Wire up global broadcast so session manager can notify ALL connected clients
// (e.g. when a webhook creates a new session that all UIs should show)
sessions._globalBroadcast = (msg) => {
  const data = JSON.stringify(msg)
  for (const ws of wss.clients) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(data)
    }
  }
}

/** Maps each WebSocket connection to its current session ID. */
const clientSessions = new Map<WebSocket, string>()

wss.on('connection', (ws: WebSocket, req) => {
  // Authenticate
  const url = new URL(req.url || '/', `http://${req.headers.host}`)
  const token = url.searchParams.get('token') || undefined

  if (!verifyToken(token)) {
    ws.close(4001, 'Unauthorized')
    return
  }

  const connectionId = randomUUID()

  const send = (msg: WsServerMessage) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg))
    }
  }

  send({ type: 'connected', connectionId, claudeAvailable, claudeVersion, apiKeySet })

  ws.on('message', (raw) => {
    let msg: WsClientMessage
    try {
      msg = JSON.parse(raw.toString())
    } catch {
      return
    }

    switch (msg.type) {
      case 'create_session': {
        const session = sessions.create(msg.name, msg.workingDir, { model: msg.model })
        session.clients.add(ws)
        clientSessions.set(ws, session.id)
        send({
          type: 'session_created',
          sessionId: session.id,
          sessionName: session.name,
          workingDir: session.workingDir,
        })
        // Auto-start Claude immediately
        sessions.startClaude(session.id)
        break
      }

      case 'join_session': {
        // Leave current session first
        const currentId = clientSessions.get(ws)
        if (currentId) {
          sessions.leave(currentId, ws)
        }

        const session = sessions.join(msg.sessionId, ws)
        if (session) {
          clientSessions.set(ws, session.id)
          send({
            type: 'session_joined',
            sessionId: session.id,
            sessionName: session.name,
            workingDir: session.workingDir,
            active: session.claudeProcess?.isAlive() ?? false,
            outputBuffer: session.outputHistory.slice(-500),
          })
        } else {
          send({ type: 'error', message: 'Session not found' })
        }
        break
      }

      case 'leave_session': {
        const currentId = clientSessions.get(ws)
        if (currentId) {
          sessions.leave(currentId, ws)
          clientSessions.delete(ws)
          send({ type: 'session_left' })
        }
        break
      }

      case 'start_claude': {
        const sessionId = clientSessions.get(ws)
        if (sessionId) {
          sessions.startClaude(sessionId)
        } else {
          send({ type: 'error', message: 'Not in a session' })
        }
        break
      }

      case 'stop': {
        const sessionId = clientSessions.get(ws)
        if (sessionId) {
          sessions.stopClaude(sessionId)
        }
        break
      }

      case 'input': {
        const sessionId = clientSessions.get(ws)
        if (sessionId) {
          const session = sessions.get(sessionId)
          if (session) {
            const displayText = typeof msg.displayText === 'string' ? msg.displayText : undefined
            const echoMsg: WsServerMessage = { type: 'user_echo', text: displayText || msg.data }
            sessions.addToHistory(session, echoMsg)
            sessions.broadcast(session, echoMsg)

          }
          sessions.sendInput(sessionId, msg.data)
        }
        break
      }

      case 'prompt_response': {
        const sessionId = clientSessions.get(ws)
        console.log(`[prompt_response] sessionId=${sessionId} value=${JSON.stringify(msg.value)} requestId=${msg.requestId}`)
        if (sessionId) {
          sessions.sendPromptResponse(sessionId, msg.value, msg.requestId)
        } else {
          console.warn('[prompt_response] no session found for client')
        }
        break
      }

      case 'set_model': {
        const sessionId = clientSessions.get(ws)
        if (sessionId) {
          sessions.setModel(sessionId, msg.model)
        }
        break
      }

      case 'resize':
        // stream-json mode doesn't use PTY, so resize is a no-op
        break

      case 'ping':
        send({ type: 'pong' })
        break

      case 'get_usage':
        // TODO: track usage
        break
    }
  })

  ws.on('close', () => {
    const sessionId = clientSessions.get(ws)
    if (sessionId) {
      sessions.leave(sessionId, ws)
    }
    clientSessions.delete(ws)
  })

  ws.on('error', (err) => {
    console.error('[ws error]', err.message)
  })
})

// Heartbeat pings to detect dead connections (30s interval)
const heartbeat = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.ping()
    }
  })
}, 30000)

wss.on('close', () => clearInterval(heartbeat))

// ---------------------------------------------------------------------------
// Start server and handle graceful shutdown
// ---------------------------------------------------------------------------

server.listen(port, '0.0.0.0', () => {
  console.log(`Codekin WebSocket server listening on port ${port}`)

  // Auto-restart sessions that were active before the server went down
  sessions.restoreActiveSessions()

  // Initialize workflow engine
  try {
    const engine = initWorkflowEngine()
    loadMdWorkflows(engine, sessions)
    engine.resumeInterrupted().catch(err => {
      console.error('[workflow] Failed to resume interrupted runs:', err)
    })

    // Broadcast workflow events to all WebSocket clients
    engine.on('workflow_event', (event: WorkflowEvent) => {
      const msg: WsServerMessage = {
        type: 'workflow_event',
        eventType: event.eventType,
        runId: event.runId,
        kind: event.kind,
        stepKey: event.stepKey,
        status: event.status,
      }
      const data = JSON.stringify(msg)
      for (const ws of wss.clients) {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(data)
        }
      }
    })

    // Sync cron schedules with config and start scheduler
    syncSchedules()
    engine.startCronScheduler()
    console.log('[workflow] Workflow engine ready')
  } catch (err) {
    console.error('[workflow] Failed to initialize workflow engine:', err)
    console.warn('[workflow] Server will continue without workflow support')
  }
})

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down...')
  shutdownWorkflowEngine()
  webhookHandler.shutdown()
  stepflowHandler.shutdown()
  sessions.shutdown()
  wss.close()
  server.close()
  process.exit(0)
})

process.on('SIGINT', () => {
  console.log('SIGINT received, shutting down...')
  shutdownWorkflowEngine()
  webhookHandler.shutdown()
  stepflowHandler.shutdown()
  sessions.shutdown()
  wss.close()
  server.close()
  process.exit(0)
})
