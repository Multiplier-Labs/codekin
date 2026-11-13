/**
 * Tests for places.ts — place detection (scratch / folder / repo, git or
 * not), the scratch root bounds, scratch folder naming, and the cache.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdirSync, rmSync, realpathSync, writeFileSync, existsSync, symlinkSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { randomUUID } from 'crypto'

const mockHomedir = vi.hoisted(() => vi.fn(() => '/tmp/placeholder'))
const mockReposRoot = vi.hoisted(() => ({ value: '/tmp/placeholder-repos' }))

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>()
  return { ...actual, homedir: mockHomedir }
})
vi.mock('./config.js', () => ({
  get REPOS_ROOT() { return mockReposRoot.value },
}))

import {
  configureScratchRoot, createScratchDir, describePlace, detectPlace, findWorkTreeRoot, getScratchRoot,
  invalidatePlace, scratchName, validateScratchRoot,
} from './places.js'

let BASE: string
let HOME: string
let REPOS: string
let OUTSIDE: string

beforeEach(() => {
  BASE = join(realpathSync(tmpdir()), 'codekin-places-' + randomUUID())
  HOME = join(BASE, 'home')
  REPOS = join(BASE, 'repos')
  OUTSIDE = join(BASE, 'outside')
  for (const d of [HOME, REPOS, OUTSIDE]) mkdirSync(d, { recursive: true })
  mockHomedir.mockReturnValue(HOME)
  mockReposRoot.value = REPOS
  configureScratchRoot('')
  delete process.env.SCRATCH_ROOT
  invalidatePlace()
})

afterEach(() => {
  rmSync(BASE, { recursive: true, force: true })
})

function gitRepo(dir: string, config = '[core]\n\tbare = false\n'): void {
  mkdirSync(join(dir, '.git'), { recursive: true })
  writeFileSync(join(dir, '.git', 'config'), config)
}

describe('detectPlace', () => {
  it('a plain folder is a folder without git', () => {
    const dir = join(HOME, 'notes')
    mkdirSync(dir)
    expect(detectPlace(dir)).toEqual({ kind: 'folder', git: false })
  })

  it('a work tree without an origin remote is a git folder', () => {
    const dir = join(HOME, 'local-only')
    gitRepo(dir)
    expect(detectPlace(dir)).toEqual({ kind: 'folder', git: true })
  })

  it('a work tree with an origin remote is a repo, whatever the host', () => {
    const gh = join(REPOS, 'acme', 'api')
    gitRepo(gh, '[core]\n\tbare = false\n[remote "origin"]\n\turl = git@github.com:acme/api.git\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n')
    const gl = join(REPOS, 'other')
    gitRepo(gl, '[remote "origin"]\n  url = https://gitlab.example.com/x/y.git\n[branch "main"]\n\tremote = origin\n')
    expect(detectPlace(gh)).toEqual({ kind: 'repo', git: true })
    expect(detectPlace(gl)).toEqual({ kind: 'repo', git: true })
  })

  it('a remote other than origin does not make it a repo', () => {
    const dir = join(HOME, 'fork')
    gitRepo(dir, '[remote "upstream"]\n\turl = https://example.com/a.git\n[remote "origin"]\n[core]\n\tbare = false\n')
    expect(detectPlace(dir)).toEqual({ kind: 'folder', git: true })
  })

  it('follows a .git file to a linked worktree and reads the common config', () => {
    const main = join(REPOS, 'main')
    gitRepo(main, '[remote "origin"]\n\turl = https://example.com/main.git\n')
    const wtGit = join(main, '.git', 'worktrees', 'wt1')
    mkdirSync(wtGit, { recursive: true })
    writeFileSync(join(wtGit, 'commondir'), '../..\n')
    const wt = join(HOME, 'wt1')
    mkdirSync(wt)
    writeFileSync(join(wt, '.git'), `gitdir: ${wtGit}\n`)
    expect(detectPlace(wt)).toEqual({ kind: 'repo', git: true })
  })

  it('a folder inside a repository belongs to it, and names its root', () => {
    const repo = join(REPOS, 'acme', 'api')
    gitRepo(repo, '[remote "origin"]\n\turl = https://example.com/api.git\n')
    const nested = join(repo, 'src', 'lib')
    mkdirSync(nested, { recursive: true })
    expect(detectPlace(nested)).toEqual({ kind: 'repo', git: true, inRepo: repo })
    expect(findWorkTreeRoot(nested)).toBe(repo)
    // The root itself carries no inRepo.
    expect(detectPlace(repo)).toEqual({ kind: 'repo', git: true })
    expect(findWorkTreeRoot(repo)).toBe(repo)
  })

  it('a folder inside a linked worktree belongs to that worktree', () => {
    const main = join(REPOS, 'main')
    gitRepo(main)
    const wtGit = join(main, '.git', 'worktrees', 'wt1')
    mkdirSync(wtGit, { recursive: true })
    writeFileSync(join(wtGit, 'commondir'), '../..\n')
    const wt = join(HOME, 'wt1')
    mkdirSync(join(wt, 'pkg'), { recursive: true })
    writeFileSync(join(wt, '.git'), `gitdir: ${wtGit}\n`)
    expect(detectPlace(join(wt, 'pkg'))).toEqual({ kind: 'folder', git: true, inRepo: wt })
  })

  it('a folder with no repository above it has no git', () => {
    const dir = join(HOME, 'a', 'b')
    mkdirSync(dir, { recursive: true })
    expect(findWorkTreeRoot(dir)).toBeNull()
    expect(detectPlace(dir)).toEqual({ kind: 'folder', git: false })
  })

  it('anything under the scratch root is scratch', () => {
    const dir = createScratchDir()
    expect(detectPlace(dir)).toEqual({ kind: 'scratch', git: false })
    gitRepo(dir)
    expect(detectPlace(dir)).toEqual({ kind: 'scratch', git: true })
  })
})

describe('describePlace cache', () => {
  it('serves a cached place within the TTL and re-detects after invalidation', () => {
    const dir = join(HOME, 'p')
    mkdirSync(dir)
    expect(describePlace(dir, 1000).git).toBe(false)
    gitRepo(dir)
    expect(describePlace(dir, 2000).git).toBe(false)
    expect(describePlace(dir, 7000).git).toBe(true)
    rmSync(join(dir, '.git'), { recursive: true })
    invalidatePlace(dir)
    expect(describePlace(dir, 7001).git).toBe(false)
  })
})

describe('scratch root', () => {
  it('defaults to ~/codekin/scratch', () => {
    expect(getScratchRoot()).toBe(join(HOME, 'codekin', 'scratch'))
  })

  it('uses SCRATCH_ROOT, and the Settings value over it', () => {
    process.env.SCRATCH_ROOT = join(REPOS, 'env-scratch')
    expect(getScratchRoot()).toBe(join(REPOS, 'env-scratch'))
    configureScratchRoot('~/mine')
    expect(getScratchRoot()).toBe(join(HOME, 'mine'))
  })

  it('falls back to the default when the configured root is out of bounds', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    configureScratchRoot(join(OUTSIDE, 'scratch'))
    expect(getScratchRoot()).toBe(join(HOME, 'codekin', 'scratch'))
    warn.mockRestore()
  })

  it('validates bounds, relative paths, symlink escapes and files', () => {
    expect(validateScratchRoot('~/x')).toEqual({ ok: true, path: join(HOME, 'x') })
    expect(validateScratchRoot('relative/x').ok).toBe(false)
    expect(validateScratchRoot(join(OUTSIDE, 'x')).ok).toBe(false)
    symlinkSync(OUTSIDE, join(HOME, 'link'))
    expect(validateScratchRoot(join(HOME, 'link', 'x')).ok).toBe(false)
    writeFileSync(join(HOME, 'file'), '')
    expect(validateScratchRoot(join(HOME, 'file')).ok).toBe(false)
  })
})

describe('createScratchDir', () => {
  it('creates adjective-noun folders and retries on collision', () => {
    const always0 = () => 0
    const first = createScratchDir(undefined, always0)
    expect(first.endsWith('/amber-badger')).toBe(true)
    const second = createScratchDir(undefined, always0)
    expect(second.endsWith('/amber-badger-10')).toBe(true)
    expect(existsSync(first) && existsSync(second)).toBe(true)
  })

  it('refuses a default root that resolves outside the allowed roots, without creating anything', () => {
    // ~/codekin is a symlink to a folder outside home and the repos root.
    symlinkSync(OUTSIDE, join(HOME, 'codekin'))
    expect(() => createScratchDir()).toThrow(/under your home directory or the repositories root/)
    expect(existsSync(join(OUTSIDE, 'scratch'))).toBe(false)
  })

  it('refuses an explicit out-of-bounds root before creating it', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(() => createScratchDir(join(OUTSIDE, 'scratch'))).toThrow()
    expect(existsSync(join(OUTSIDE, 'scratch'))).toBe(false)
    // An invalid configured root falls back to an invalid default: still nothing written.
    configureScratchRoot(join(OUTSIDE, 'configured'))
    symlinkSync(OUTSIDE, join(HOME, 'codekin'))
    expect(() => createScratchDir()).toThrow()
    expect(existsSync(join(OUTSIDE, 'configured'))).toBe(false)
    expect(existsSync(join(OUTSIDE, 'scratch'))).toBe(false)
    warn.mockRestore()
  })

  it('names are two lowercase words', () => {
    expect(scratchName()).toMatch(/^[a-z]+-[a-z]+$/)
  })
})
