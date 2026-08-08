/**
 * Hosted relay / control plane server entry point.
 *
 * Serves the control-plane REST API on 127.0.0.1:<RELAY_PORT> behind nginx
 * (app.codekin.ai). The hosted frontend is static-served by nginx; this
 * process only handles /api (and, in later phases, the /relay WebSocket
 * endpoints for browsers and connectors).
 */

import express from 'express'
import session from 'express-session'
import { join } from 'path'
import { loadRelayConfig } from './relay-config.js'
import { openControlPlaneDb } from './control-plane-db.js'
import { SqliteSessionStore } from './sqlite-session-store.js'
import { createRelayAuthRouter } from './relay-auth-routes.js'
import { createMachineRouter } from './machine-routes.js'

const config = loadRelayConfig()
const db = openControlPlaneDb(join(config.dataDir, 'control-plane.db'))
const store = new SqliteSessionStore(db)

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

// Per-IP rate limit on auth endpoints (state generation + GitHub round trips)
const authHits = new Map<string, { count: number; resetAt: number }>()
const AUTH_RATE_LIMIT = 20
const AUTH_RATE_WINDOW_MS = 60_000
app.use('/api/auth', (req, res, next) => {
  const now = Date.now()
  const key = req.ip ?? 'unknown'
  const entry = authHits.get(key)
  if (!entry || entry.resetAt <= now) {
    authHits.set(key, { count: 1, resetAt: now + AUTH_RATE_WINDOW_MS })
    next()
    return
  }
  entry.count += 1
  if (entry.count > AUTH_RATE_LIMIT) {
    res.status(429).json({ error: 'Too many requests' })
    return
  }
  next()
})
setInterval(() => {
  const now = Date.now()
  for (const [key, entry] of authHits) {
    if (entry.resetAt <= now) authHits.delete(key)
  }
}, AUTH_RATE_WINDOW_MS).unref()

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
  res.json({ ok: true, service: 'codekin-relay' })
})

app.use(createRelayAuthRouter({ db, config }))
app.use(createMachineRouter(db))

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

const server = app.listen(config.port, '127.0.0.1', () => {
  console.log(`[relay] Control plane listening on 127.0.0.1:${config.port} (${config.publicUrl})`)
})

function shutdown() {
  console.log('[relay] Shutting down')
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
