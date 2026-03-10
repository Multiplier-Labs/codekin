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
import { execFileSync } from 'child_process'
import { randomUUID, timingSafeEqual } from 'crypto'
import { verifySessionToken } from './crypto-utils.js'
import { SessionManager } from './session-manager.js'
import type { WsClientMessage, WsServerMessage } from './types.js'
import { handleWsMessage } from './ws-message-handler.js'
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
import { createDocsRouter } from './docs-routes.js'
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
} else {
  console.warn('⚠️  WARNING: No auth token configured. All endpoints are unauthenticated!')
  console.warn('   Set AUTH_TOKEN or AUTH_TOKEN_FILE to secure the server.')
}

/** Check if a token matches the configured auth token. Fails closed when no token is configured. */
function verifyToken(token: string | undefined): boolean {
  if (!authToken) return false  // No auth configured — fail closed
  if (!token) return false
  // Timing-safe comparison to prevent timing attacks
  const a = Buffer.from(authToken)
  const b = Buffer.from(token)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

/**
 * Verify a token that may be either the master auth token or a session-scoped
 * token derived for a specific session. Used by hook endpoints where child
 * processes authenticate with their session-scoped token.
 */
function verifyTokenOrSessionToken(token: string | undefined, sessionId: string | undefined): boolean {
  if (verifyToken(token)) return true
  if (!authToken || !token || !sessionId) return false
  return verifySessionToken(authToken, sessionId, token)
}

/** Extract auth token from Authorization header or request body. */
function extractToken(req: express.Request): string | undefined {
  // Check Authorization header (preferred — avoids token in URL/logs)
  const authHeader = req.headers.authorization
  if (authHeader?.startsWith('Bearer ')) {
    return authHeader.slice(7)
  }

  // Check body (used by auth-verify and legacy callers)
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
  claudeVersion = execFileSync('claude', ['--version'], { timeout: 5000 }).toString().trim()
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
    console.error('[webhook] FATAL: GITHUB_WEBHOOK_ENABLED is set but GITHUB_WEBHOOK_SECRET is missing. Refusing to accept unsigned webhooks.')
    process.exit(1)
  }
  void webhookHandler.checkHealth().then(healthy => {
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

// Security headers
app.use((_req, res, next) => {
  res.header('X-Content-Type-Options', 'nosniff')
  res.header('X-Frame-Options', 'DENY')
  res.header('X-XSS-Protection', '1; mode=block')
  res.header('Referrer-Policy', 'strict-origin-when-cross-origin')
  res.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()')
  res.header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' wss: ws:; img-src 'self' data: https:; font-src 'self'")
  if (process.env.NODE_ENV === 'production') {
    res.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains')
  }
  next()
})

// CORS — restrict to configured origin (default: localhost dev server)
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
app.use(createSessionRouter(verifyToken, extractToken, sessions, verifyTokenOrSessionToken))
app.use(createWebhookRouter(verifyToken, extractToken, webhookHandler, stepflowHandler))
app.use(createUploadRouter(verifyToken, extractToken))
app.use(createDocsRouter(verifyToken, extractToken))
app.use('/api/workflows', createWorkflowRouter(verifyToken, extractToken, sessions))

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

/** Timeout (ms) for WebSocket clients to send an auth message after connecting. */
const WS_AUTH_TIMEOUT_MS = 5000

/** Per-IP WebSocket connection rate limiter. */
const wsConnections = new Map<string, { count: number; resetAt: number }>()
const WS_RATE_WINDOW_MS = 60_000
const WS_RATE_MAX_CONNECTIONS = 30

// Periodically purge expired rate-limit entries to prevent unbounded memory growth
setInterval(() => {
  const now = Date.now()
  for (const [ip, entry] of wsConnections) {
    if (now >= entry.resetAt) wsConnections.delete(ip)
  }
}, WS_RATE_WINDOW_MS)

function checkWsRateLimit(ip: string): boolean {
  const now = Date.now()
  const entry = wsConnections.get(ip)
  if (!entry || now >= entry.resetAt) {
    wsConnections.set(ip, { count: 1, resetAt: now + WS_RATE_WINDOW_MS })
    return true
  }
  entry.count++
  return entry.count <= WS_RATE_MAX_CONNECTIONS
}

wss.on('connection', (ws: WebSocket, req) => {
  // Rate-limit by IP before any processing
  const ip = (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() || req.socket.remoteAddress || 'unknown'
  if (!checkWsRateLimit(ip)) {
    ws.close(4029, 'Too many connections')
    return
  }
  let authenticated = false
  const connectionId = randomUUID()

  const send = (msg: WsServerMessage) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg))
    }
  }

  // Close unauthenticated connections after timeout
  const authTimeout = setTimeout(() => {
    if (!authenticated) {
      ws.close(4001, 'Auth timeout')
    }
  }, WS_AUTH_TIMEOUT_MS)

  const handlerCtx = { ws, sessions, clientSessions, send }

  ws.on('message', (raw) => {
    let msg: WsClientMessage
    try {
      msg = JSON.parse(raw.toString())
    } catch {
      return
    }

    // First message must be auth
    if (!authenticated) {
      if (msg.type !== 'auth' || !verifyToken(msg.token)) {
        clearTimeout(authTimeout)
        ws.close(4001, 'Unauthorized')
        return
      }
      authenticated = true
      clearTimeout(authTimeout)
      send({ type: 'connected', connectionId, claudeAvailable, claudeVersion, apiKeySet })
      return
    }

    handleWsMessage(msg, handlerCtx)
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
    syncSchedules(sessions)
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
