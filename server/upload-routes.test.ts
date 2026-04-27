/**
 * Tests for upload-routes — covers the localRepoPath helper plus the clone
 * route's handling of an unresolvable repos root (W4).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import express from 'express'
import type { AddressInfo } from 'net'
import type { Server } from 'http'

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


