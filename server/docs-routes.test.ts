/**
 * Tests for createDocsRouter — verifies auth, path boundary enforcement (REPOS_ROOT),
 * extension guards, and the happy-path listing / file-content endpoints.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import express from 'express'
import type { Request } from 'express'
import type { AddressInfo } from 'net'
import type { Server } from 'http'
import { mkdirSync, writeFileSync, rmSync, realpathSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { randomUUID } from 'crypto'

// A temp dir becomes both REPOS_ROOT and the "home" for OUTSIDE_DIR under mocked os.
let TMP_ROOT: string
let REPO_DIR: string
let OUTSIDE_DIR: string

const mockReposRoot = vi.hoisted(() => ({ value: '/tmp/placeholder' }))
vi.mock('./config.js', () => ({
  get REPOS_ROOT() { return mockReposRoot.value },
}))

import { createDocsRouter } from './docs-routes.js'

const TOKEN = 'valid-token'
const verifyToken = (t: string | undefined) => t === TOKEN
const extractToken = (req: Request) => {
  const h = req.headers['authorization']
  if (!h) return undefined
  const m = h.match(/^Bearer\s+(.+)$/)
  return m?.[1]
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
  return { Authorization: `Bearer ${TOKEN}` }
}

describe('createDocsRouter', () => {
  let server: { baseUrl: string; close: () => Promise<void> }

  beforeEach(async () => {
    TMP_ROOT = realpathSync(tmpdir())
    const unique = 'codekin-docs-test-' + randomUUID()
    REPO_DIR = join(TMP_ROOT, unique, 'repo')
    OUTSIDE_DIR = join(TMP_ROOT, unique, 'outside')
    mkdirSync(REPO_DIR, { recursive: true })
    mkdirSync(OUTSIDE_DIR, { recursive: true })
    // Populate a small markdown tree
    writeFileSync(join(REPO_DIR, 'README.md'), '# readme')
    writeFileSync(join(REPO_DIR, 'CLAUDE.md'), '# claude')
    writeFileSync(join(REPO_DIR, 'other.md'), '# other')
    mkdirSync(join(REPO_DIR, 'docs'), { recursive: true })
    writeFileSync(join(REPO_DIR, 'docs', 'guide.md'), '# guide')
    writeFileSync(join(REPO_DIR, 'docs', 'not-md.txt'), 'skip me')
    mkdirSync(join(REPO_DIR, 'node_modules'), { recursive: true })
    writeFileSync(join(REPO_DIR, 'node_modules', 'ignored.md'), '# should be excluded')

    writeFileSync(join(OUTSIDE_DIR, 'secret.md'), '# should not be accessible')

    // REPOS_ROOT contains REPO_DIR but not OUTSIDE_DIR
    mockReposRoot.value = join(TMP_ROOT, unique)
    // But a unique sub-path to ensure the OUTSIDE_DIR is still under the unique dir
    // — adjust: move OUTSIDE_DIR to a sibling of the unique dir so it's outside REPOS_ROOT
    rmSync(OUTSIDE_DIR, { recursive: true, force: true })
    OUTSIDE_DIR = join(TMP_ROOT, 'codekin-docs-outside-' + randomUUID())
    mkdirSync(OUTSIDE_DIR, { recursive: true })
    writeFileSync(join(OUTSIDE_DIR, 'secret.md'), '# should not be accessible')

    const router = createDocsRouter(verifyToken, extractToken)
    server = await startApp(router)
  })

  afterEach(async () => {
    await server.close()
    try { rmSync(join(TMP_ROOT, 'codekin-docs-test-' + REPO_DIR.split('codekin-docs-test-')[1]?.split('/')[0]), { recursive: true, force: true }) } catch { /* ignore */ }
    try { rmSync(OUTSIDE_DIR, { recursive: true, force: true }) } catch { /* ignore */ }
  })

  describe('auth enforcement', () => {
    it('rejects GET /api/docs without auth', async () => {
      const res = await fetch(`${server.baseUrl}/api/docs?repo=${encodeURIComponent(REPO_DIR)}`)
      expect(res.status).toBe(401)
    })

    it('rejects GET /api/docs/file without auth', async () => {
      const res = await fetch(`${server.baseUrl}/api/docs/file?repo=${encodeURIComponent(REPO_DIR)}&file=README.md`)
      expect(res.status).toBe(401)
    })
  })

  describe('GET /api/docs', () => {
    it('returns 400 when repo query is missing', async () => {
      const res = await fetch(`${server.baseUrl}/api/docs`, { headers: auth() })
      expect(res.status).toBe(400)
    })

    it('returns 404 when repo path does not exist', async () => {
      const ghost = join(TMP_ROOT, 'ghost-' + randomUUID())
      const res = await fetch(
        `${server.baseUrl}/api/docs?repo=${encodeURIComponent(ghost)}`,
        { headers: auth() },
      )
      expect(res.status).toBe(404)
    })

    it('returns 403 when repo is outside REPOS_ROOT', async () => {
      const res = await fetch(
        `${server.baseUrl}/api/docs?repo=${encodeURIComponent(OUTSIDE_DIR)}`,
        { headers: auth() },
      )
      expect(res.status).toBe(403)
    })

    it('lists .md files with pinned files first and excludes node_modules', async () => {
      const res = await fetch(
        `${server.baseUrl}/api/docs?repo=${encodeURIComponent(REPO_DIR)}`,
        { headers: auth() },
      )
      expect(res.status).toBe(200)
      const body = await res.json()
      const paths = body.files.map((f: { path: string; pinned: boolean }) => f.path)
      expect(paths).toContain('README.md')
      expect(paths).toContain('CLAUDE.md')
      expect(paths).toContain('other.md')
      expect(paths).toContain('docs/guide.md')
      // Excluded via EXCLUDED_DIRS
      expect(paths).not.toContain('node_modules/ignored.md')

      // Pinned (CLAUDE.md, README.md) come first — pinned order is CLAUDE.md then README.md
      expect(body.files[0]).toEqual({ path: 'CLAUDE.md', pinned: true })
      expect(body.files[1]).toEqual({ path: 'README.md', pinned: true })
    })
  })

  describe('GET /api/docs/file', () => {
    it('returns 400 when repo or file missing', async () => {
      const res1 = await fetch(`${server.baseUrl}/api/docs/file?repo=${encodeURIComponent(REPO_DIR)}`, { headers: auth() })
      expect(res1.status).toBe(400)
      const res2 = await fetch(`${server.baseUrl}/api/docs/file?file=README.md`, { headers: auth() })
      expect(res2.status).toBe(400)
    })

    it('returns 403 when repo is outside REPOS_ROOT', async () => {
      const res = await fetch(
        `${server.baseUrl}/api/docs/file?repo=${encodeURIComponent(OUTSIDE_DIR)}&file=secret.md`,
        { headers: auth() },
      )
      expect(res.status).toBe(403)
    })

    it('returns 400 for non-markdown files', async () => {
      const res = await fetch(
        `${server.baseUrl}/api/docs/file?repo=${encodeURIComponent(REPO_DIR)}&file=docs/not-md.txt`,
        { headers: auth() },
      )
      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.error).toMatch(/Only .md files/)
    })

    it('returns 404 when path traverses outside repo', async () => {
      const res = await fetch(
        `${server.baseUrl}/api/docs/file?repo=${encodeURIComponent(REPO_DIR)}&file=${encodeURIComponent('../secret.md')}`,
        { headers: auth() },
      )
      // Either 404 (file not found / traversal blocked). Any 2xx here would be a security regression.
      expect([404, 403]).toContain(res.status)
    })

    it('returns markdown content for a valid file', async () => {
      const res = await fetch(
        `${server.baseUrl}/api/docs/file?repo=${encodeURIComponent(REPO_DIR)}&file=README.md`,
        { headers: auth() },
      )
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.path).toBe('README.md')
      expect(body.content).toBe('# readme')
    })

    it('returns 404 for non-existent markdown file', async () => {
      const res = await fetch(
        `${server.baseUrl}/api/docs/file?repo=${encodeURIComponent(REPO_DIR)}&file=nope.md`,
        { headers: auth() },
      )
      expect(res.status).toBe(404)
    })
  })
})
