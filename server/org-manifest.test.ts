/** The org manifest names what is cloned, how to get the rest, and where edits go. */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, realpathSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { randomUUID } from 'crypto'
import { buildOrgManifest, clonedRepos } from './org-manifest.js'

let DIR: string
const SESSION = 'abcdef12-3456-7890-abcd-ef1234567890'

beforeEach(() => {
  DIR = join(realpathSync(tmpdir()), 'codekin-org-' + randomUUID(), 'acme-co')
  mkdirSync(DIR, { recursive: true })
})
afterEach(() => { rmSync(join(DIR, '..'), { recursive: true, force: true }) })

function repo(name: string) { mkdirSync(join(DIR, name, '.git'), { recursive: true }) }

describe('clonedRepos', () => {
  it('lists repositories, not plain folders, hidden folders or session worktrees', () => {
    repo('web'); repo('api'); repo('api-wt-abcdef12')
    mkdirSync(join(DIR, 'notes'))
    mkdirSync(join(DIR, '.cache', '.git'), { recursive: true })
    expect(clonedRepos(DIR)).toEqual(['api', 'web'])
  })

  it('is empty for a missing folder', () => {
    expect(clonedRepos(join(DIR, 'nope'))).toEqual([])
  })
})

describe('buildOrgManifest', () => {
  it('names the owner, the folder, the clones and how to get the rest', () => {
    repo('api'); repo('web')
    const text = buildOrgManifest({ owner: 'acme-co', dir: DIR, sessionId: SESSION, worktrees: false, branchPrefix: 'wt/' })
    expect(text.startsWith('<codekin-org-session>')).toBe(true)
    expect(text).toContain(`GitHub owner "acme-co". The working directory is ${DIR}`)
    expect(text).toContain('Cloned already (2): api, web.')
    expect(text).toContain('gh repo list acme-co')
    expect(text).toContain('gh repo clone acme-co/<name>')
    expect(text).toContain('Edit the clones in place')
    expect(text).not.toContain('worktree add')
  })

  it('says when nothing is cloned yet', () => {
    const text = buildOrgManifest({ owner: 'acme-co', dir: DIR, sessionId: SESSION, worktrees: false, branchPrefix: 'wt/' })
    expect(text).toContain('No repositories are cloned yet.')
  })

  it('asks for one worktree per repository on the session branch when worktrees are on', () => {
    const text = buildOrgManifest({ owner: 'acme-co', dir: DIR, sessionId: SESSION, worktrees: true, branchPrefix: 'feat/' })
    expect(text).toContain('git -C <name> worktree add ../<name>-wt-abcdef12 -b feat/abcdef12')
  })
})
