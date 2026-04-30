/**
 * Tests for upload-routes — covers the localRepoPath helper plus the clone
 * route's handling of an unresolvable repos root (W4).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import express from 'express'
import type { AddressInfo } from 'net'
import type { Server } from 'http'
import { mkdtempSync, symlinkSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

// ---------------------------------------------------------------------------
// Hoisted mock state — lets tests toggle realpathSync's behavior.
// ---------------------------------------------------------------------------

const mocks = vi.hoisted(() => ({
  realpathThrows: false,
}))

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  return {
    ...actual,
    realpathSync: ((p: string) => {
      if (mocks.realpathThrows) throw new Error('ENOENT: no such file or directory')
      return actual.realpathSync(p)
    }) as typeof actual.realpathSync,
  }
})

// Imported after vi.mock so the router picks up the mocked fs.
import { localRepoPath, createUploadRouter } from './upload-routes.js'

describe('localRepoPath', () => {
  it('namespaces the repo under its owner', () => {
    expect(localRepoPath('/srv/repos', 'ownerA', 'foo')).toBe('/srv/repos/ownerA/foo')
  })

  it('prevents collision between ownerA/foo and ownerB/foo', () => {
    const a = localRepoPath('/srv/repos', 'ownerA', 'foo')
    const b = localRepoPath('/srv/repos', 'ownerB', 'foo')
    expect(a).not.toBe(b)
  })

  it('works with different reposRoots', () => {
    expect(localRepoPath('/home/user/repos', 'org', 'proj')).toBe('/home/user/repos/org/proj')
  })

  it('handles owner and repo names with hyphens, underscores, and dots', () => {
    expect(localRepoPath('/r', 'my-org', 'my_repo.name')).toBe('/r/my-org/my_repo.name')
  })
})

// ---------------------------------------------------------------------------
// POST /api/clone — error handling for unresolvable repos root (W4)
// ---------------------------------------------------------------------------

const AUTH_TOKEN = 'test-token'

function verifyToken(token: string | undefined): boolean {
  return token === AUTH_TOKEN
}

function extractToken(req: { headers: Record<string, string | string[] | undefined> }): string | undefined {
  const h = req.headers['authorization']
  if (typeof h === 'string' && h.startsWith('Bearer ')) return h.slice(7)
  return undefined
}

describe('POST /api/clone', () => {
  let server: Server
  let baseUrl: string

  beforeEach(async () => {
    mocks.realpathThrows = false
    const app = express()
    app.use(express.json())
    app.use(createUploadRouter(
      verifyToken,
      extractToken as unknown as (req: express.Request) => string | undefined,
      () => '/tmp/codekin-test-repos',
    ))
    server = app.listen(0)
    await new Promise<void>(res => server.once('listening', () => res()))
    const port = (server.address() as AddressInfo).port
    baseUrl = `http://127.0.0.1:${port}`
  })

  afterEach(async () => {
    await new Promise<void>(res => server.close(() => res()))
  })

  it('returns 500 with structured error when realpathSync throws (W4)', async () => {
    mocks.realpathThrows = true
    const res = await fetch(`${baseUrl}/api/clone`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${AUTH_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ owner: 'someone', name: 'somerepo' }),
    })
    expect(res.status).toBe(500)
    const body = await res.json() as { error: string }
    expect(body.error).toBe('invalid_repos_root')
  })
})

// ---------------------------------------------------------------------------
// POST /api/clone — symlink escape prevention (C1)
// ---------------------------------------------------------------------------

describe('POST /api/clone — symlink escape (C1)', () => {
  let tmpRoot: string
  let server: Server
  let baseUrl: string

  beforeEach(async () => {
    mocks.realpathThrows = false
    tmpRoot = mkdtempSync(join(tmpdir(), 'codekin-symtest-'))
    const app = express()
    app.use(express.json())
    app.use(createUploadRouter(
      verifyToken,
      extractToken as unknown as (req: express.Request) => string | undefined,
      () => tmpRoot,
    ))
    server = app.listen(0)
    await new Promise<void>(res => server.once('listening', () => res()))
    const port = (server.address() as AddressInfo).port
    baseUrl = `http://127.0.0.1:${port}`
  })

  afterEach(async () => {
    await new Promise<void>(res => server.close(() => res()))
    rmSync(tmpRoot, { recursive: true, force: true })
  })

  it('rejects clone when owner dir is a symlink pointing outside REPOS_ROOT (C1)', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'codekin-evil-'))
    try {
      symlinkSync(outside, join(tmpRoot, 'evil-owner'))
      const res = await fetch(`${baseUrl}/api/clone`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${AUTH_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ owner: 'evil-owner', name: 'myrepo' }),
      })
      expect(res.status).toBe(400)
      const body = await res.json() as { error: string }
      expect(body.error).toBe('Path escapes allowed root')
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })

  it('rejects clone when REPOS_ROOT is symlinked and owner dir escapes (C1 grandparent)', async () => {
    // realRoot is the actual filesystem root; symRoot is a symlink to it.
    // Inside realRoot, the owner dir is itself a symlink pointing outside.
    const realRoot = mkdtempSync(join(tmpdir(), 'codekin-real-'))
    const outside = mkdtempSync(join(tmpdir(), 'codekin-evil2-'))
    const symRootPath = join(tmpdir(), `codekin-symroot-${Date.now()}`)
    symlinkSync(realRoot, symRootPath)
    symlinkSync(outside, join(realRoot, 'linked-owner'))

    const app2 = express()
    app2.use(express.json())
    app2.use(createUploadRouter(
      verifyToken,
      extractToken as unknown as (req: express.Request) => string | undefined,
      () => symRootPath,
    ))
    const server2 = app2.listen(0)
    await new Promise<void>(res => server2.once('listening', () => res()))
    const port2 = (server2.address() as AddressInfo).port

    try {
      const res = await fetch(`http://127.0.0.1:${port2}/api/clone`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${AUTH_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ owner: 'linked-owner', name: 'myrepo' }),
      })
      expect(res.status).toBe(400)
    } finally {
      await new Promise<void>(res => server2.close(() => res()))
      rmSync(realRoot, { recursive: true, force: true })
      rmSync(outside, { recursive: true, force: true })
      rmSync(symRootPath, { force: true })
    }
  })

  it('allows clone when owner dir does not exist (normal path, regression)', async () => {
    const res = await fetch(`${baseUrl}/api/clone`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${AUTH_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ owner: 'valid-owner', name: 'myrepo' }),
    })
    // Boundary check passes; clone itself may fail (no gh credentials) — not 400
    expect(res.status).not.toBe(400)
  })
})
