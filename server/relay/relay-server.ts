/**
 * Hosted relay / control plane server entry point.
 *
 * Serves the control-plane REST API, the /relay/connector WebSocket (paired
 * machines) and the /relay/browser WebSocket (signed-in browsers) on
 * 127.0.0.1:<RELAY_PORT> behind nginx (app.codekin.ai). The hosted frontend
 * is static-served by nginx.
 */

import express from 'express'
import session from 'express-session'
import { createServer, ServerResponse } from 'http'
import { WebSocketServer } from 'ws'
import type { IncomingMessage } from 'http'
import { join } from 'path'
import { loadRelayConfig } from './relay-config.js'
import { openControlPlaneDb, getUserById } from './control-plane-db.js'
import { SqliteSessionStore } from './sqlite-session-store.js'
import { createRelayAuthRouter, toSessionUser } from './relay-auth-routes.js'
import { createMachineRouter } from './machine-routes.js'
import { createPairingRouter } from './pairing-routes.js'
import { createShareRouter } from './share-routes.js'
import { createUserRouter } from './user-routes.js'
import { createDeviceLinkRouter } from './device-link-routes.js'
import { createWebauthnRouter } from './webauthn-routes.js'
import { ConnectorHub } from './connector-hub.js'
import { BrowserHub } from './browser-hub.js'
import { MAX_PROXY_BODY_BYTES } from './relay-protocol.js'
import { pruneAuditEvents } from './audit.js'
import { sweepOrphanMachines } from './pairing.js'
import type { SessionUser } from './relay-auth-routes.js'
import { createMutationOriginGuard } from './origin-guard.js'

const config = loadRelayConfig()
const db = openControlPlaneDb(join(config.dataDir, 'control-plane.db'))
const store = new SqliteSessionStore(db)
const hub = new ConnectorHub(db)
const browserHub = new BrowserHub(db, hub, { isSessionAlive: sid => store.isAlive(sid) })

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
// Authenticated mutations and lookups: generous for people, a ceiling for scripts.
app.use('/api/machines/pair/approve', ipRateLimiter(20, 60_000))
app.use('/api/machines/pair/info', ipRateLimiter(30, 60_000))
app.use('/api/shares', ipRateLimiter(60, 60_000))
app.use('/api/users', ipRateLimiter(60, 60_000))

// Cookie-authenticated REST mutations must come from the app itself.
// SameSite=Lax alone still admits sibling subdomains of the site.
app.use(createMutationOriginGuard(config.publicUrl))

// Held in a const so WebSocket upgrades can reuse it to resolve the session.
const sessionMiddleware = session({
  name: 'codekin_relay_sid',
  secret: config.sessionSecret,
  store,
  resave: false,
  saveUninitialized: false,
  rolling: true,
  cookie: {
    httpOnly: true,
    // Follows the public URL, not NODE_ENV: an https deployment must never
    // issue a cookie a plain-http hop could carry.
    secure: config.publicUrl.startsWith('https:'),
    // 'lax' is required for the OAuth return trip from github.com
    sameSite: 'lax',
    path: '/',
    maxAge: 30 * 24 * 60 * 60 * 1000,
  },
})

app.use(sessionMiddleware)

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'codekin-relay',
    machinesOnline: hub.onlineCount,
    browserClients: browserHub.clientCount,
  })
})

app.use(createRelayAuthRouter({
  db,
  config,
  store,
  disconnectUser: (userId, reason) => { browserHub.disconnectUser(userId, reason) },
  disconnectSession: (sessionId, reason) => { browserHub.disconnectSession(sessionId, reason) },
}))
app.use(createMachineRouter(db, hub))
app.use(createPairingRouter(db, config, { connectorHub: hub, browserHub }))
app.use(createShareRouter(db, browserHub))
app.use(createUserRouter(db, config, browserHub, store))
app.use(createDeviceLinkRouter(db, config))
app.use(createWebauthnRouter(db, config))

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

// Audit retention (spec §12): prune daily, and once at boot so a lowered
// retention setting takes effect without waiting a day.
if (config.auditRetentionDays > 0) {
  const prune = () => {
    const removed = pruneAuditEvents(db, config.auditRetentionDays)
    if (removed > 0) console.log(`[relay] Pruned ${removed} audit events older than ${config.auditRetentionDays} days`)
  }
  prune()
  setInterval(prune, 24 * 60 * 60 * 1000).unref()
}

// Install commands that were never run leave a machine row behind. Sweep the
// ones whose pairing expired unclaimed (GET /api/machines also sweeps lazily).
// Machines that have ever held a credential are never touched.
const sweepOrphans = () => {
  const removed = sweepOrphanMachines(db)
  if (removed.length > 0) console.log(`[relay] Swept ${removed.length} unclaimed machine(s) with expired pairing`)
}
sweepOrphans()
setInterval(sweepOrphans, 5 * 60 * 1000).unref()

const server = createServer(app)

// Path-routed WebSocket upgrades (noServer — reject unknown paths).
// maxPayload bounds a single frame; base64 bodies expand by ~4/3.
const wssOptions = { noServer: true, maxPayload: Math.ceil(MAX_PROXY_BODY_BYTES * 1.4) }
const connectorWss = new WebSocketServer(wssOptions)
connectorWss.on('connection', socket => { hub.handleConnection(socket); })

const browserWss = new WebSocketServer(wssOptions)

/**
 * Resolve the express-session user for an upgrade request.
 *
 * WebSocket upgrades are not covered by the same-origin policy but do carry
 * cookies, so the Origin is checked explicitly — otherwise any site could
 * open an authenticated relay socket in a signed-in user's browser.
 *
 * Status comes from the database, not the session snapshot, for the same
 * reason requireActiveUser re-reads it: a socket opened on a stale session
 * would outlive the revocation by as long as the tab stays open.
 */
function authenticateUpgrade(req: IncomingMessage): Promise<{ user: SessionUser; sessionId: string } | null> {
  const origin = req.headers.origin
  if (origin !== config.publicUrl) return Promise.resolve(null)

  return new Promise(resolve => {
    const res = new ServerResponse(req) as unknown as express.Response
    sessionMiddleware(req as express.Request, res, () => {
      const expressReq = req as express.Request
      const user = expressReq.session?.user
      if (!user) {
        resolve(null)
        return
      }
      const current = getUserById(db, user.id)
      resolve(current && current.status === 'active'
        ? { user: toSessionUser(current), sessionId: expressReq.sessionID }
        : null)
    })
  })
}

server.on('upgrade', (req, socket, head) => {
  const path = (req.url ?? '').split('?')[0]
  if (path === '/relay/connector') {
    connectorWss.handleUpgrade(req, socket, head, ws => {
      connectorWss.emit('connection', ws, req)
    })
    return
  }
  if (path === '/relay/browser') {
    void authenticateUpgrade(req).then(auth => {
      if (!auth) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
        socket.destroy()
        return
      }
      browserWss.handleUpgrade(req, socket, head, ws => {
        browserHub.handleConnection(ws, auth.user, auth.sessionId)
      })
    })
    return
  }
  socket.destroy()
})

server.listen(config.port, '127.0.0.1', () => {
  console.log(`[relay] Control plane listening on 127.0.0.1:${config.port} (${config.publicUrl})`)
})

function shutdown() {
  console.log('[relay] Shutting down')
  browserHub.close()
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
