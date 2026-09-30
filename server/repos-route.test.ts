/**
 * Tests for GET /api/repos (audit N4): local discovery independent of gh,
 * merge by remote URL, per-owner failure isolation, and precise gh status.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import express from 'express'
import type { AddressInfo } from 'net'
import type { Server } from 'http'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

type GhHandler = (args: string[]) => { stdout: string } | Error

const mocks = vi.hoisted(() => ({
  gh: null as null | ((args: string[]) => { stdout: string } | Error),
  calls: [] as string[][],
}))

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>()
  const { promisify } = await import('util')
  const execFile = ((..._args: unknown[]) => {
    throw new Error('callback execFile not mocked')
  }) as unknown as typeof actual.execFile
  Object.defineProperty(execFile, promisify.custom, {
    value: (cmd: string, args: string[]) => {
      mocks.calls.push([cmd, ...args])
      if (cmd !== 'gh' || !mocks.gh) return Promise.reject(Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' }))
      const out = mocks.gh(args)
      return out instanceof Error ? Promise.reject(out) : Promise.resolve({ stdout: out.stdout, stderr: '' })
    },
  })
  return { ...actual, execFile }
})

vi.mock('./config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./config.js')>()
  return { ...actual, GH_ORGS: [] }
})

import { createUploadRouter, classifyGhError, mergeRepoGroups, type ApiRepoGroup } from './upload-routes.js'
import type { LocalRepo } from './local-repos.js'

let root: string
let server: Server
let baseUrl: string

function makeRepo(rel: string, origin?: string) {
  const dir = join(root, rel)
  mkdirSync(join(dir, '.git'), { recursive: true })
  writeFileSync(join(dir, '.git', 'config'), origin ? `[remote "origin"]\n\turl = ${origin}\n` : '')
  return dir
}

function ghExitError(stderr: string): Error {
  return Object.assign(new Error(`Command failed: gh\n${stderr}`), { code: 1, stderr })
}

function ghScript(handlers: Record<string, GhHandler | { stdout: string } | Error>): (args: string[]) => { stdout: string } | Error {
  return (args) => {
    const key = args[0] === 'api' ? `api ${args[1]}` : `list ${args[2]}`
    const h = handlers[key]
    if (!h) return ghExitError(`unexpected gh ${args.join(' ')}`)
    return typeof h === 'function' ? h(args) : h
  }
}

async function getRepos(): Promise<{
  groups: ApiRepoGroup[]
  ghStatus: string
  ghError?: string
  ghMissing: boolean
  reposPath: string
}> {
  const res = await fetch(`${baseUrl}/api/repos`, { headers: { Authorization: 'Bearer t' } })
  expect(res.status).toBe(200)
  return res.json() as never
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'codekin-repos-route-'))
  mocks.gh = null
  mocks.calls = []
  const app = express()
  app.use(express.json())
  app.use(createUploadRouter((t) => t === 't', (req) => req.headers.authorization?.replace('Bearer ', ''), () => root))
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve())
  })
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  rmSync(root, { recursive: true, force: true })
})

describe('GET /api/repos without gh', () => {
  it('lists local checkouts in a Local group and reports ghStatus=missing', async () => {
    makeRepo('project', 'git@github.com:me/project.git')
    makeRepo('acme/tool')
    const body = await getRepos()
    expect(body.ghStatus).toBe('missing')
    expect(body.ghMissing).toBe(true)
    expect(body.groups).toHaveLength(1)
    expect(body.groups[0]).toMatchObject({ owner: 'Local', source: 'local' })
    expect(body.groups[0].repos.map((r) => r.id)).toEqual(['acme/tool', 'project'])
    expect(body.groups[0].repos.every((r) => r.cloned)).toBe(true)
    expect(body.groups[0].repos.find((r) => r.id === 'project')).toMatchObject({
      path: join(root, 'project'),
      workingDir: join(root, 'project'),
      owner: 'me',
    })
  })

  it('reports unauthenticated distinctly and still lists local repos', async () => {
    makeRepo('project')
    mocks.gh = ghScript({ 'api user': ghExitError('To get started with GitHub CLI, please run:  gh auth login') })
    const body = await getRepos()
    expect(body.ghStatus).toBe('unauthenticated')
    expect(body.ghMissing).toBe(false)
    expect(body.groups[0].repos).toHaveLength(1)
  })

  it('reports a timeout as error with 200 and local repos (not a 504)', async () => {
    makeRepo('project')
    mocks.gh = ghScript({ 'api user': Object.assign(new Error('timed out'), { killed: true, signal: 'SIGTERM' }) })
    const body = await getRepos()
    expect(body.ghStatus).toBe('error')
    expect(body.ghError).toMatch(/timed out/)
    expect(body.groups[0].repos).toHaveLength(1)
  })
})

describe('GET /api/repos with gh', () => {
  it('marks a flat checkout of a GitHub repo as cloned at its real path, and isolates a failing org', async () => {
    makeRepo('project', 'git@github.com:me/project.git')
    makeRepo('scratch')
    mocks.gh = ghScript({
      'api user': { stdout: 'me\n' },
      'api user/orgs': { stdout: 'sso-org\nokorg\n' },
      'list sso-org': ghExitError('GraphQL: Resource protected by organization SAML enforcement.'),
      'list okorg': { stdout: JSON.stringify([{ name: 'svc', url: 'https://github.com/okorg/svc', description: 'Service' }]) },
      'list me': {
        stdout: JSON.stringify([
          { name: 'project', url: 'https://github.com/me/project', description: '' },
          { name: 'remote-only', url: 'https://github.com/me/remote-only', description: '' },
        ]),
      },
    })
    const body = await getRepos()
    expect(body.ghStatus).toBe('ok')
    expect(body.groups.map((g) => g.owner)).toEqual(['sso-org', 'okorg', 'me', 'Local'])

    const sso = body.groups[0]
    expect(sso.repos).toEqual([])
    expect(sso.error).toMatch(/SAML/)
    expect(body.groups[1].repos[0]).toMatchObject({ name: 'svc', cloned: false, path: join(root, 'okorg', 'svc') })

    const me = body.groups[2]
    expect(me.repos.find((r) => r.name === 'project')).toMatchObject({
      cloned: true,
      path: join(root, 'project'),
      workingDir: join(root, 'project'),
    })
    expect(me.repos.find((r) => r.name === 'remote-only')).toMatchObject({ cloned: false })
    // The matched checkout is not listed again under Local.
    expect(body.groups[3].repos.map((r) => r.id)).toEqual(['scratch'])

    const listCall = mocks.calls.find((c) => c[1] === 'repo' && c[3] === 'me')
    expect(listCall).toContain('1000')
  })
})

describe('POST /api/clone with an existing flat checkout', () => {
  it('returns the existing path instead of cloning a duplicate', async () => {
    makeRepo('project', 'https://github.com/me/project.git')
    mocks.gh = () => new Error('clone must not be called')
    const res = await fetch(`${baseUrl}/api/clone`, {
      method: 'POST',
      headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
      body: JSON.stringify({ owner: 'me', name: 'project' }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { path: string }
    expect(body.path.endsWith('/project')).toBe(true)
    expect(body.path).not.toContain('/me/')
    expect(mocks.calls.filter((c) => c[1] === 'repo' && c[2] === 'clone')).toEqual([])
  })
})

describe('classifyGhError', () => {
  it('distinguishes missing, unauthenticated, timeout, and other errors', () => {
    expect(classifyGhError(Object.assign(new Error('x'), { code: 'ENOENT' })).status).toBe('missing')
    expect(classifyGhError(ghExitError('You are not logged into any GitHub hosts. Run gh auth login')).status).toBe('unauthenticated')
    expect(classifyGhError(ghExitError('HTTP 401: Bad credentials (https://api.github.com/user)')).status).toBe('unauthenticated')
    expect(classifyGhError(Object.assign(new Error('t'), { killed: true }))).toEqual({ status: 'error', message: 'GitHub CLI timed out' })
    expect(classifyGhError(ghExitError('HTTP 403: API rate limit exceeded'))).toEqual({ status: 'error', message: 'HTTP 403: API rate limit exceeded' })
  })
})

describe('mergeRepoGroups', () => {
  const local = (path: string, relPath: string, remoteKey: string | null): LocalRepo => ({
    path, relPath, name: relPath.split('/').pop() ?? relPath, originUrl: remoteKey ? `https://${remoteKey}` : null, remoteKey,
  })

  it('prefers the owner-namespaced checkout when a remote is on disk twice', () => {
    const groups = mergeRepoGroups('/r', [{ owner: 'me', repos: [{ name: 'p', url: 'https://github.com/me/p' }] }], [
      local('/r/p', 'p', 'github.com/me/p'),
      local('/r/me/p', 'me/p', 'github.com/me/p'),
    ])
    expect(groups[0].repos[0]).toMatchObject({ path: '/r/me/p', cloned: true })
    expect(groups[1]).toMatchObject({ owner: 'Local' })
    expect(groups[1].repos.map((r) => r.path)).toEqual(['/r/p'])
  })

  it('matches an owner-namespaced checkout without a remote by path', () => {
    const groups = mergeRepoGroups('/r', [{ owner: 'me', repos: [{ name: 'p', url: 'https://github.com/me/p' }] }], [
      local('/r/me/p', 'me/p', null),
    ])
    expect(groups).toHaveLength(1)
    expect(groups[0].repos[0]).toMatchObject({ path: '/r/me/p', cloned: true })
  })

  it('omits the Local group when every checkout is claimed or there are none', () => {
    expect(mergeRepoGroups('/r', [], [])).toEqual([])
  })
})
