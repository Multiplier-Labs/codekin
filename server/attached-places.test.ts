/** Attached places: which folders may be attached, and what the agent is told. */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'fs'
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

import { MAX_ATTACHED, buildPlaceNote, describeAttached, validateAttachPath } from './attached-places.js'
import { invalidatePlace } from './places.js'

let BASE: string, HOME: string, REPOS: string, OUTSIDE: string, PRIMARY: string

beforeEach(() => {
  BASE = join(realpathSync(tmpdir()), 'codekin-attach-' + randomUUID())
  HOME = join(BASE, 'home'); REPOS = join(BASE, 'repos'); OUTSIDE = join(BASE, 'outside')
  PRIMARY = join(HOME, 'project')
  for (const d of [HOME, REPOS, OUTSIDE, PRIMARY]) mkdirSync(d, { recursive: true })
  mockHomedir.mockReturnValue(HOME)
  mockReposRoot.value = REPOS
  invalidatePlace()
})
afterEach(() => { rmSync(BASE, { recursive: true, force: true }) })

function dir(...parts: string[]): string {
  const d = join(...parts)
  mkdirSync(d, { recursive: true })
  return d
}

describe('validateAttachPath', () => {
  it('accepts a folder under home or the repos root, as its realpath', () => {
    const notes = dir(HOME, 'notes')
    symlinkSync(notes, join(HOME, 'link'))
    expect(validateAttachPath(join(HOME, 'link'), [PRIMARY], [])).toEqual({ ok: true, path: notes })
    const repo = dir(REPOS, 'acme', 'api')
    expect(validateAttachPath(repo, [PRIMARY], [])).toEqual({ ok: true, path: repo })
  })

  it('refuses missing paths, files, and folders outside the allowed roots', () => {
    expect(validateAttachPath('', [PRIMARY], []).ok).toBe(false)
    expect(validateAttachPath(42, [PRIMARY], []).ok).toBe(false)
    expect(validateAttachPath(join(HOME, 'nope'), [PRIMARY], [])).toMatchObject({ ok: false, error: /does not exist/ })
    writeFileSync(join(HOME, 'f.txt'), '')
    expect(validateAttachPath(join(HOME, 'f.txt'), [PRIMARY], [])).toMatchObject({ ok: false, error: /Not a folder/ })
    expect(validateAttachPath(dir(OUTSIDE, 'x'), [PRIMARY], [])).toMatchObject({ ok: false, error: /home directory/ })
  })

  it('refuses the session\'s own folder, a folder inside it, and one around it', () => {
    expect(validateAttachPath(PRIMARY, [PRIMARY], [])).toMatchObject({ ok: false, error: /already works/ })
    expect(validateAttachPath(dir(PRIMARY, 'src'), [PRIMARY], [])).toMatchObject({ ok: false, error: /already works/ })
    expect(validateAttachPath(HOME, [PRIMARY], [])).toMatchObject({ ok: false, error: /already works/ })
  })

  it('refuses a folder already attached, or nested with one, and more than the cap', () => {
    const a = dir(HOME, 'a')
    expect(validateAttachPath(a, [PRIMARY], [a])).toMatchObject({ ok: false, error: /already attached/ })
    expect(validateAttachPath(dir(a, 'deep'), [PRIMARY], [a])).toMatchObject({ ok: false, error: /already attached/ })
    const many = Array.from({ length: MAX_ATTACHED }, (_, i) => join(HOME, `m${i}`))
    expect(validateAttachPath(dir(HOME, 'one-more'), [PRIMARY], many)).toMatchObject({ ok: false, error: /At most/ })
  })
})

describe('buildPlaceNote', () => {
  const base = { sessionId: 'abcdef12-0000-0000-0000-000000000000', worktrees: false, branchPrefix: 'wt/' }

  it('names an attached folder and its kind', () => {
    const notes = dir(HOME, 'notes')
    const note = buildPlaceNote({ ...base, action: 'attached', path: notes })
    expect(note).toContain(`attached ${notes} (a folder (not a git repository))`)
    expect(note.startsWith('<codekin-place-attached>')).toBe(true)
    dir(HOME, 'gitdir', '.git')
    expect(buildPlaceNote({ ...base, action: 'attached', path: join(HOME, 'gitdir') })).toContain('(a git folder)')
  })

  it('carries the org manifest when an org folder is attached', () => {
    const org = dir(REPOS, 'acme-co')
    dir(org, 'api', '.git')
    const note = buildPlaceNote({ ...base, action: 'attached', path: org })
    expect(note).toContain('GitHub owner "acme-co"')
    expect(note).toContain('<codekin-org-session>')
    expect(note).toContain('Cloned already (1): api')
  })

  it('tells the agent to stop using a detached folder', () => {
    const note = buildPlaceNote({ ...base, action: 'detached', path: '/x/y' })
    expect(note).toContain('detached /x/y')
    expect(note.startsWith('<codekin-place-detached>')).toBe(true)
  })
})

describe('describeAttached', () => {
  it('is undefined for none, and gives each folder its place', () => {
    expect(describeAttached(undefined)).toBeUndefined()
    expect(describeAttached([])).toBeUndefined()
    const notes = dir(HOME, 'notes')
    expect(describeAttached([notes])).toEqual([{ path: notes, place: { kind: 'folder', git: false } }])
  })
})
