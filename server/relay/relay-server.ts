/**
 * Hosted relay / control plane server entry point.
 *
 * Serves the control-plane REST API and the /relay/connector WebSocket on
 * 127.0.0.1:<RELAY_PORT> behind nginx (app.codekin.ai). The hosted frontend
 * is static-served by nginx; /relay/browser (client streams) arrives in a
 * later phase.
 */

import express from 'express'
import session from 'express-session'
import { createServer } from 'http'
import { WebSocketServer } from 'ws'
import { join } from 'path'
import { loadRelayConfig } from './relay-config.js'
import { openControlPlaneDb } from './control-plane-db.js'
import { SqliteSessionStore } from './sqlite-session-store.js'
import { createRelayAuthRouter } from './relay-auth-routes.js'
import { createMachineRouter } from './machine-routes.js'
import { createPairingRouter } from './pairing-routes.js'
import { ConnectorHub } from './connector-hub.js'

const config = loadRelayConfig()
const db = openControlPlaneDb(join(config.dataDir, 'control-plane.db'))
const store = new SqliteSessionStore(db)
const hub = new ConnectorHub(db)

const app = express()

// Behind nginx: trust X-Forwarded-* so secure cookies and req.ip work.
app.set('trust proxy', 1)
app.disable('x-powered-by')

app.use(express.json({ limit: '1mb' }))

app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('X-Frame-Options', 'DENY')
  res.setHeader('Referrer-Policy', 'same-origin')
  next()
})

/** Simple per-IP fixed-window rate limiter. */
function ipRateLimiter(limit: number, windowMs: number): express.RequestHandler {
  const hits = new Map<string, { count: number; resetAt: number }>()
  setInterval(() => {
    const now = Date.now()
    for (const [key, entry] of hits) {
      if (entry.resetAt <= now) hits.delete(key)
    }
  }, windowMs).unref()
  return (req, res, next) => {
    const now = Date.now()
    const key = req.ip ?? 'unknown'
    const entry = hits.get(key)
    if (!entry || entry.resetAt <= now) {
      hits.set(key, { count: 1, resetAt: now + windowMs })
      next()
      return
    }
    entry.count += 1
    if (entry.count > limit) {
      res.status(429).json({ error: 'Too many requests' })
      return
    }
    next()
  }
}

// Auth endpoints: state generation + GitHub round trips.
app.use('/api/auth', ipRateLimiter(20, 60_000))
// Pairing: start writes rows; complete is polled every ~3s by the CLI.
app.use('/api/machines/pair/start', ipRateLimiter(10, 60_000))
app.use('/api/machines/pair/complete', ipRateLimiter(60, 60_000))

app.use(
  session({
    name: 'codekin_relay_sid',
    secret: config.sessionSecret,
    store,
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: {
      httpOnly: true,
      secure: config.isProduction,
      // 'lax' is required for the OAuth return trip from github.com
      sameSite: 'lax',
      path: '/',
      maxAge: 30 * 24 * 60 * 60 * 1000,
    },
  }),
)

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, service: 'codekin-relay', machinesOnline: hub.onlineCount })
})

app.use(createRelayAuthRouter({ db, config }))
app.use(createMachineRouter(db))
app.use(createPairingRouter(db, config))

app.use((_req, res) => {
  res.status(404).json({ error: 'Not found' })
})

// eslint-disable-next-line @typescript-eslint/no-unused-vars -- Express identifies error handlers by arity
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('[relay] Unhandled error:', err)
  if (!res.headersSent) {
    res.status(500).json({ error: 'Internal server error' })
  }
})

const server = createServer(app)

// Path-routed WebSocket upgrades (noServer — reject unknown paths).
const connectorWss = new WebSocketServer({ noServer: true })
connectorWss.on('connection', socket => { hub.handleConnection(socket); })

server.on('upgrade', (req, socket, head) => {
  const path = (req.url ?? '').split('?')[0]
  if (path === '/relay/connector') {
    connectorWss.handleUpgrade(req, socket, head, ws => {
      connectorWss.emit('connection', ws, req)
    })
  } else {
    socket.destroy()
  }
})

server.listen(config.port, '127.0.0.1', () => {
  console.log(`[relay] Control plane listening on 127.0.0.1:${config.port} (${config.publicUrl})`)
})

function shutdown() {
  console.log('[relay] Shutting down')
  hub.close()
  server.close(() => {
    store.close()
    db.close()
    process.exit(0)
  })
  // Fallback if connections keep the server open
  setTimeout(() => process.exit(0), 5000).unref()
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
