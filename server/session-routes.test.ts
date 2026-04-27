/**
 * Tests for createSessionRouter — focuses on auth enforcement, path boundary
 * checks (workingDir must live under $HOME or REPOS_ROOT), input validation,
 * and hook-endpoint token verification.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import express from 'express'
import type { Request } from 'express'
import type { AddressInfo } from 'net'
import type { Server } from 'http'
import { mkdirSync, rmSync, realpathSync, symlinkSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { randomUUID } from 'crypto'

// Temp test roots — both home and repos_root point to fresh dirs per test run.
let TMP_BASE: string
let HOME_DIR: string
let REPOS_DIR: string
let OUTSIDE_DIR: string

const mockHomedir = vi.hoisted(() => vi.fn(() => '/tmp/placeholder'))
const mockReposRoot = vi.hoisted(() => ({ value: '/tmp/placeholder-repos' }))
const mockGetAgentDisplayName = vi.hoisted(() => vi.fn(() => 'Joe'))

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>()
  return { ...actual, homedir: mockHomedir }
})

vi.mock('./config.js', () => ({
  get REPOS_ROOT() { return mockReposRoot.value },
  getAgentDisplayName: mockGetAgentDisplayName,
}))

vi.mock('./types.js', () => ({
  VALID_PROVIDERS: new Set(['claude', 'opencode']),
}))

vi.mock('./native-permissions.js', () => ({
  toNativePermission: vi.fn(() => null),
}))

vi.mock('./opencode-process.js', () => ({
  fetchOpenCodeModels: vi.fn(async () => ({ models: [] })),
}))

import { createSessionRouter } from './session-routes.js'
import type { SessionManager } from './session-manager.js'

const TOKEN = 'valid-token'
const verifyToken = (t: string | undefined) => t === TOKEN
const extractToken = (req: Request) => {
  const h = req.headers['authorization']
  if (!h) return undefined
  const m = h.match(/^Bearer\s+(.+)$/)
  return m?.[1]
}

function fakeSessions(overrides: Partial<Record<string, unknown>> = {}): SessionManager {
  const created = {
    id: 'session-1',
    name: 'test',
    created: '2026-04-21T00:00:00Z',
    workingDir: '/repos/test',
    source: 'manual',
  }
  const archive = {
    list: vi.fn(() => []),
    get: vi.fn(() => null),
    delete: vi.fn(() => true),
    getRetentionDays: vi.fn(() => 30),
    setRetentionDays: vi.fn(),
    getSetting: vi.fn((k: string, def: string) => def),
    setSetting: vi.fn(),
  }
  const approvalManager = {
    getApprovals: vi.fn(() => ({ approvals: [] })),
    getGlobalApprovals: vi.fn(() => ({ approvals: [] })),
    removeApproval: vi.fn(() => true),
    persistRepoApprovals: vi.fn(),
  }
  return {
    list: vi.fn(() => []),
    listAll: vi.fn(() => []),
    create: vi.fn(() => created),
    get: vi.fn(() => null),
    delete: vi.fn(() => true),
    rename: vi.fn(() => true),
    archive,
    approvalManager,
    getWorktreeBranchPrefix: vi.fn(() => 'wt/'),
    setWorktreeBranchPrefix: vi.fn(),
    requestToolApproval: vi.fn(async () => ({ allow: true, always: false })),
    addToHistory: vi.fn(),
    broadcast: vi.fn(),
    getPendingPrompts: vi.fn(() => []),
    sendPromptResponse: vi.fn(),
    ...overrides,
  } as unknown as SessionManager
}

async function startApp(router: express.Router): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const app = express()
  app.use(express.json())
  app.use(router)
  return await new Promise((resolve) => {
    const server: Server = app.listen(0, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo
      resolve({
        baseUrl: `http://127.0.0.1:${addr.port}`,
        close: () => new Promise((r) => server.close(() => r())),
      })
    })
  })
}

function auth(): Record<string, string> {
  return { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }
}

describe('createSessionRouter', () => {
  let server: { baseUrl: string; close: () => Promise<void> }
  let sessions: SessionManager

  beforeEach(() => {
    TMP_BASE = realpathSync(tmpdir())
    const unique = 'codekin-session-test-' + randomUUID()
    HOME_DIR = join(TMP_BASE, unique, 'home')
    REPOS_DIR = join(TMP_BASE, unique, 'repos')
    OUTSIDE_DIR = join(TMP_BASE, 'codekin-outside-' + randomUUID())
    mkdirSync(HOME_DIR, { recursive: true })
    mkdirSync(REPOS_DIR, { recursive: true })
    mkdirSync(OUTSIDE_DIR, { recursive: true })
    mkdirSync(join(REPOS_DIR, 'ok'), { recursive: true })
    mkdirSync(join(HOME_DIR, 'ok'), { recursive: true })

    mockHomedir.mockReturnValue(HOME_DIR)
    mockReposRoot.value = REPOS_DIR
  })

  afterEach(async () => {
    await server?.close()
    try { rmSync(join(TMP_BASE, HOME_DIR.split('/').slice(-2, -1)[0]), { recursive: true, force: true }) } catch { /* ignore */ }
    try { rmSync(OUTSIDE_DIR, { recursive: true, force: true }) } catch { /* ignore */ }
  })

  describe('auth enforcement', () => {
    beforeEach(async () => {
      sessions = fakeSessions()
      server = await startApp(createSessionRouter(verifyToken, extractToken, sessions))
    })

    const ROUTES: Array<[string, string]> = [
      ['GET', '/api/sessions/list'],
      ['POST', '/api/sessions/create'],
      ['GET', '/api/sessions/archived'],
      ['GET', '/api/settings/retention'],
      ['PUT', '/api/settings/retention'],
      ['GET', '/api/settings/worktree-prefix'],
      ['PUT', '/api/settings/worktree-prefix'],
      ['GET', '/api/settings/queue-messages'],
      ['PUT', '/api/settings/queue-messages'],
      ['GET', '/api/settings/repos-path'],
      ['PUT', '/api/settings/repos-path'],
      ['GET', '/api/settings/agent-name'],
      ['PUT', '/api/settings/agent-name'],
      ['GET', '/api/browse-dirs'],
      ['GET', '/api/approvals?path=/repos/x'],
      ['GET', '/api/approvals/global'],
    ]

    it.each(ROUTES)('%s %s returns 401 without a token', async (method, path) => {
      const res = await fetch(`${server.baseUrl}${path}`, { method, headers: { 'Content-Type': 'application/json' } })
      expect(res.status).toBe(401)
    })
  })

  describe('POST /api/sessions/create', () => {
    beforeEach(async () => {
      sessions = fakeSessions()
      server = await startApp(createSessionRouter(verifyToken, extractToken, sessions))
    })

    it('returns 400 when name or workingDir is missing', async () => {
      const res = await fetch(`${server.baseUrl}/api/sessions/create`, {
        method: 'POST', headers: auth(), body: JSON.stringify({ name: 'x' }),
      })
      expect(res.status).toBe(400)
    })

    it('returns 400 when workingDir does not exist', async () => {
      const res = await fetch(`${server.baseUrl}/api/sessions/create`, {
        method: 'POST', headers: auth(),
        body: JSON.stringify({ name: 'x', workingDir: '/does/not/exist' }),
      })
      expect(res.status).toBe(400)
    })

    it('returns 403 when workingDir is outside HOME and REPOS_ROOT', async () => {
      const res = await fetch(`${server.baseUrl}/api/sessions/create`, {
        method: 'POST', headers: auth(),
        body: JSON.stringify({ name: 'x', workingDir: OUTSIDE_DIR }),
      })
      expect(res.status).toBe(403)
      const body = await res.json()
      expect(body.error).toMatch(/outside allowed/)
    })

    it('returns 400 for an invalid provider', async () => {
      const res = await fetch(`${server.baseUrl}/api/sessions/create`, {
        method: 'POST', headers: auth(),
        body: JSON.stringify({ name: 'x', workingDir: join(REPOS_DIR, 'ok'), provider: 'bogus' }),
      })
      expect(res.status).toBe(400)
    })

    it('creates a session under REPOS_ROOT', async () => {
      const res = await fetch(`${server.baseUrl}/api/sessions/create`, {
        method: 'POST', headers: auth(),
        body: JSON.stringify({ name: 'x', workingDir: join(REPOS_DIR, 'ok') }),
      })
      expect(res.status).toBe(200)
      expect(sessions.create).toHaveBeenCalled()
    })

    it('creates a session under HOME_DIR', async () => {
      const res = await fetch(`${server.baseUrl}/api/sessions/create`, {
        method: 'POST', headers: auth(),
        body: JSON.stringify({ name: 'x', workingDir: join(HOME_DIR, 'ok') }),
      })
      expect(res.status).toBe(200)
    })
  })

  describe('GET /api/browse-dirs', () => {
    beforeEach(async () => {
      sessions = fakeSessions()
      server = await startApp(createSessionRouter(verifyToken, extractToken, sessions))
    })

    it('returns 403 when path is outside allowed roots', async () => {
      const res = await fetch(
        `${server.baseUrl}/api/browse-dirs?path=${encodeURIComponent(OUTSIDE_DIR)}`,
        { headers: auth() },
      )
      expect(res.status).toBe(403)
    })

    it('returns 400 when path cannot be resolved', async () => {
      const res = await fetch(
        `${server.baseUrl}/api/browse-dirs?path=${encodeURIComponent(join(REPOS_DIR, 'does-not-exist'))}`,
        { headers: auth() },
      )
      expect(res.status).toBe(400)
    })

    it('lists directory entries on happy path', async () => {
      mkdirSync(join(REPOS_DIR, 'ok', 'sub1'), { recursive: true })
      mkdirSync(join(REPOS_DIR, 'ok', 'sub2'), { recursive: true })
      const res = await fetch(
        `${server.baseUrl}/api/browse-dirs?path=${encodeURIComponent(join(REPOS_DIR, 'ok'))}`,
        { headers: auth() },
      )
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.dirs).toContain('sub1')
      expect(body.dirs).toContain('sub2')
    })
  })

  describe('PUT /api/settings/retention', () => {
    beforeEach(async () => {
      sessions = fakeSessions()
      server = await startApp(createSessionRouter(verifyToken, extractToken, sessions))
    })

    it('rejects non-numeric days with 400', async () => {
      const res = await fetch(`${server.baseUrl}/api/settings/retention`, {
        method: 'PUT', headers: auth(), body: JSON.stringify({ days: 'abc' }),
      })
      expect(res.status).toBe(400)
    })

    it('rejects days < 1 with 400', async () => {
      const res = await fetch(`${server.baseUrl}/api/settings/retention`, {
        method: 'PUT', headers: auth(), body: JSON.stringify({ days: 0 }),
      })
      expect(res.status).toBe(400)
    })

    it('persists valid days', async () => {
      const res = await fetch(`${server.baseUrl}/api/settings/retention`, {
        method: 'PUT', headers: auth(), body: JSON.stringify({ days: 14 }),
      })
      expect(res.status).toBe(200)
      expect(sessions.archive.setRetentionDays).toHaveBeenCalledWith(14)
    })
  })

  describe('PUT /api/settings/worktree-prefix', () => {
    beforeEach(async () => {
      sessions = fakeSessions()
      server = await startApp(createSessionRouter(verifyToken, extractToken, sessions))
    })

    it('sanitizes and appends a trailing slash', async () => {
      const res = await fetch(`${server.baseUrl}/api/settings/worktree-prefix`, {
        method: 'PUT', headers: auth(), body: JSON.stringify({ prefix: 'foo/bar!' }),
      })
      expect(res.status).toBe(200)
      const body = await res.json()
      // '!' is stripped; trailing / re-added
      expect(body.prefix).toBe('foo/bar/')
      expect(sessions.setWorktreeBranchPrefix).toHaveBeenCalledWith('foo/bar/')
    })

    it('falls back to wt/ when prefix is empty after sanitization', async () => {
      const res = await fetch(`${server.baseUrl}/api/settings/worktree-prefix`, {
        method: 'PUT', headers: auth(), body: JSON.stringify({ prefix: '!!!' }),
      })
      const body = await res.json()
      expect(body.prefix).toBe('wt/')
    })

    it('rejects non-string prefix', async () => {
      const res = await fetch(`${server.baseUrl}/api/settings/worktree-prefix`, {
        method: 'PUT', headers: auth(), body: JSON.stringify({ prefix: 123 }),
      })
      expect(res.status).toBe(400)
    })
  })

  describe('PUT /api/settings/repos-path', () => {
    beforeEach(async () => {
      sessions = fakeSessions()
      server = await startApp(createSessionRouter(verifyToken, extractToken, sessions))
    })

    it('accepts empty path (means use default)', async () => {
      const res = await fetch(`${server.baseUrl}/api/settings/repos-path`, {
        method: 'PUT', headers: auth(), body: JSON.stringify({ path: '' }),
      })
      expect(res.status).toBe(200)
    })

    it('rejects a path that does not exist', async () => {
      const res = await fetch(`${server.baseUrl}/api/settings/repos-path`, {
        method: 'PUT', headers: auth(),
        body: JSON.stringify({ path: '/definitely/not/a/real/path/xyz' }),
      })
      expect(res.status).toBe(400)
    })

    it('accepts ~ to mean home', async () => {
      const res = await fetch(`${server.baseUrl}/api/settings/repos-path`, {
        method: 'PUT', headers: auth(), body: JSON.stringify({ path: '~' }),
      })
      expect(res.status).toBe(200)
    })

    it('happy path: accepts a directory inside the allowed parent', async () => {
      const res = await fetch(`${server.baseUrl}/api/settings/repos-path`, {
        method: 'PUT', headers: auth(),
        body: JSON.stringify({ path: join(REPOS_DIR, 'ok') }),
      })
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.path).toBe(realpathSync(join(REPOS_DIR, 'ok')))
    })

    it('rejects a traversal attempt via ../../etc', async () => {
      // Many ".." segments climb past root and resolve to /etc on Linux.
      const traversal = REPOS_DIR + '/../../../../../../../../../etc'
      const res = await fetch(`${server.baseUrl}/api/settings/repos-path`, {
        method: 'PUT', headers: auth(),
        body: JSON.stringify({ path: traversal }),
      })
      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.error).toMatch(/outside allowed/i)
    })

    it('rejects an absolute path outside allowed parents', async () => {
      const res = await fetch(`${server.baseUrl}/api/settings/repos-path`, {
        method: 'PUT', headers: auth(),
        body: JSON.stringify({ path: OUTSIDE_DIR }),
      })
      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.error).toMatch(/outside allowed/i)
    })

    it('rejects a symlink that points outside allowed parents', async () => {
      const linkPath = join(HOME_DIR, 'escape-link')
      symlinkSync(OUTSIDE_DIR, linkPath, 'dir')
      const res = await fetch(`${server.baseUrl}/api/settings/repos-path`, {
        method: 'PUT', headers: auth(),
        body: JSON.stringify({ path: linkPath }),
      })
      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.error).toMatch(/outside allowed/i)
    })
  })

  describe('PUT /api/settings/agent-name', () => {
    beforeEach(async () => {
      sessions = fakeSessions()
      server = await startApp(createSessionRouter(verifyToken, extractToken, sessions))
    })

    it('rejects empty name', async () => {
      const res = await fetch(`${server.baseUrl}/api/settings/agent-name`, {
        method: 'PUT', headers: auth(), body: JSON.stringify({ name: '   ' }),
      })
      expect(res.status).toBe(400)
    })

    it('truncates name to 30 chars', async () => {
      const long = 'x'.repeat(100)
      const res = await fetch(`${server.baseUrl}/api/settings/agent-name`, {
        method: 'PUT', headers: auth(), body: JSON.stringify({ name: long }),
      })
      const body = await res.json()
      expect(body.name.length).toBe(30)
    })
  })

  describe('DELETE /api/sessions/:id', () => {
    it('returns 404 when session not found', async () => {
      sessions = fakeSessions({ delete: vi.fn(() => false) })
      server = await startApp(createSessionRouter(verifyToken, extractToken, sessions))
      const res = await fetch(`${server.baseUrl}/api/sessions/missing`, {
        method: 'DELETE', headers: auth(),
      })
      expect(res.status).toBe(404)
    })

    it('returns 200 when deleted', async () => {
      sessions = fakeSessions()
      server = await startApp(createSessionRouter(verifyToken, extractToken, sessions))
      const res = await fetch(`${server.baseUrl}/api/sessions/abc`, {
        method: 'DELETE', headers: auth(),
      })
      expect(res.status).toBe(200)
    })
  })

  describe('PATCH /api/sessions/:id/rename', () => {
    beforeEach(async () => {
      sessions = fakeSessions()
      server = await startApp(createSessionRouter(verifyToken, extractToken, sessions))
    })

    it('rejects empty name with 400', async () => {
      const res = await fetch(`${server.baseUrl}/api/sessions/abc/rename`, {
        method: 'PATCH', headers: auth(), body: JSON.stringify({ name: '  ' }),
      })
      expect(res.status).toBe(400)
    })

    it('renames with truncation to 60 chars', async () => {
      const res = await fetch(`${server.baseUrl}/api/sessions/abc/rename`, {
        method: 'PATCH', headers: auth(), body: JSON.stringify({ name: 'x'.repeat(100) }),
      })
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.name.length).toBe(60)
    })
  })

  describe('hook endpoints', () => {
    beforeEach(async () => {
      sessions = fakeSessions()
      // Custom session-token verifier — accepts the master token OR a session-scoped pair.
      // This mirrors the real ws-server implementation where master always works.
      const verifySessionTokenFn = (token: string | undefined, sessionId: string | undefined) => {
        if (token === TOKEN) return true
        return token === 'session-scoped' && sessionId === 'session-1'
      }
      server = await startApp(createSessionRouter(verifyToken, extractToken, sessions, verifySessionTokenFn))
    })

    it('POST /api/hook-decision rejects invalid token with 401', async () => {
      const res = await fetch(`${server.baseUrl}/api/hook-decision`, {
        method: 'POST',
        headers: { Authorization: 'Bearer wrong', 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: 'session-1', toolName: 'Bash' }),
      })
      expect(res.status).toBe(401)
    })

    it('POST /api/hook-decision accepts session-scoped token', async () => {
      const res = await fetch(`${server.baseUrl}/api/hook-decision`, {
        method: 'POST',
        headers: { Authorization: 'Bearer session-scoped', 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: 'session-1', toolName: 'Bash' }),
      })
      expect(res.status).toBe(200)
      expect(sessions.requestToolApproval).toHaveBeenCalledWith('session-1', 'Bash', {})
    })

    it('POST /api/hook-decision rejects missing fields with 400', async () => {
      const res = await fetch(`${server.baseUrl}/api/hook-decision`, {
        method: 'POST', headers: auth(), body: JSON.stringify({ sessionId: 'x' }),
      })
      expect(res.status).toBe(400)
    })

    it('POST /api/auth/validate rejects invalid token with 401', async () => {
      const res = await fetch(`${server.baseUrl}/api/auth/validate`, {
        method: 'POST',
        headers: { Authorization: 'Bearer wrong', 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: 'session-1' }),
      })
      expect(res.status).toBe(401)
    })

    it('POST /api/auth/validate accepts master token', async () => {
      const res = await fetch(`${server.baseUrl}/api/auth/validate`, {
        method: 'POST', headers: auth(), body: JSON.stringify({}),
      })
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.valid).toBe(true)
    })

    it('POST /api/hook-notify rejects missing sessionId with 400', async () => {
      const res = await fetch(`${server.baseUrl}/api/hook-notify`, {
        method: 'POST', headers: auth(), body: JSON.stringify({}),
      })
      expect(res.status).toBe(400)
    })
  })

  describe('approvals', () => {
    beforeEach(async () => {
      sessions = fakeSessions()
      server = await startApp(createSessionRouter(verifyToken, extractToken, sessions))
    })

    it('GET /api/approvals requires path query parameter', async () => {
      const res = await fetch(`${server.baseUrl}/api/approvals`, { headers: auth() })
      expect(res.status).toBe(400)
    })

    it('DELETE /api/approvals rejects invalid single-delete with 400', async () => {
      // Return 'invalid' from removeApproval to trigger the 400 path
      sessions.approvalManager.removeApproval = vi.fn(() => 'invalid')
      const res = await fetch(`${server.baseUrl}/api/approvals?path=/repos/x`, {
        method: 'DELETE', headers: auth(), body: JSON.stringify({}),
      })
      expect(res.status).toBe(400)
    })

    it('DELETE /api/approvals supports bulk delete via items', async () => {
      sessions.approvalManager.removeApproval = vi.fn(() => true)
      const res = await fetch(`${server.baseUrl}/api/approvals?path=/repos/x`, {
        method: 'DELETE', headers: auth(),
        body: JSON.stringify({ items: [{ tool: 'Bash' }, { command: 'ls' }] }),
      })
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.removed).toBe(2)
    })
  })
})
