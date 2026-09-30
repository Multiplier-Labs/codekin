/** Tests for local repository discovery and remote-URL normalization (audit N4). */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  discoverLocalRepos,
  githubSlugFromKey,
  normalizeRemoteUrl,
  parseOriginUrl,
  resolveGitConfigPath,
} from './local-repos.js'

describe('normalizeRemoteUrl', () => {
  it.each([
    ['https://github.com/Owner/Repo.git', 'github.com/owner/repo'],
    ['https://github.com/Owner/Repo', 'github.com/owner/repo'],
    ['https://github.com/Owner/Repo/', 'github.com/owner/repo'],
    ['http://github.com/owner/repo.git/', 'github.com/owner/repo'],
    ['https://user:token@github.com/owner/repo.git', 'github.com/owner/repo'],
    ['git@github.com:Owner/Repo.git', 'github.com/owner/repo'],
    ['github.com:owner/repo', 'github.com/owner/repo'],
    ['ssh://git@github.com/owner/repo.git', 'github.com/owner/repo'],
    ['ssh://git@github.com:22/owner/repo', 'github.com/owner/repo'],
    ['git://github.com/owner/repo.git', 'github.com/owner/repo'],
    ['https://gitlab.example.com/group/sub/proj.git', 'gitlab.example.com/group/sub/proj'],
  ])('%s → %s', (input, expected) => {
    expect(normalizeRemoteUrl(input)).toBe(expected)
  })

  it('makes the https and ssh forms of one repo equal', () => {
    expect(normalizeRemoteUrl('git@github.com:a/b.git')).toBe(normalizeRemoteUrl('https://github.com/a/b'))
  })

  it.each([null, undefined, '', '   ', '/srv/git/repo.git', '../repo', 'file:///srv/git/repo.git', 'C:\\repos\\x'])(
    'returns null for non-network remote %j',
    (input) => {
      expect(normalizeRemoteUrl(input)).toBeNull()
    },
  )
})

describe('githubSlugFromKey', () => {
  it('extracts owner/name from GitHub keys only', () => {
    expect(githubSlugFromKey('github.com/acme/app')).toEqual({ owner: 'acme', name: 'app' })
    expect(githubSlugFromKey('gitlab.com/acme/app')).toBeNull()
    expect(githubSlugFromKey('github.com/acme/app/extra')).toBeNull()
    expect(githubSlugFromKey(null)).toBeNull()
  })
})

describe('parseOriginUrl', () => {
  it('reads the origin url and ignores other remotes and sections', () => {
    const cfg = [
      '[core]',
      '\turl = nope',
      '[remote "upstream"]',
      '\turl = https://github.com/up/stream.git',
      '[remote "origin"]',
      '\t# comment',
      '\turl = "git@github.com:me/proj.git"',
      '\tfetch = +refs/heads/*:refs/remotes/origin/*',
    ].join('\n')
    expect(parseOriginUrl(cfg)).toBe('git@github.com:me/proj.git')
  })

  it('returns null without an origin remote', () => {
    expect(parseOriginUrl('[core]\n\tbare = false\n')).toBeNull()
  })
})

describe('discoverLocalRepos', () => {
  let root: string

  function makeRepo(rel: string, origin?: string) {
    const dir = join(root, rel)
    mkdirSync(join(dir, '.git'), { recursive: true })
    const cfg = origin ? `[core]\n\tbare = false\n[remote "origin"]\n\turl = ${origin}\n` : '[core]\n\tbare = false\n'
    writeFileSync(join(dir, '.git', 'config'), cfg)
    return dir
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'codekin-local-repos-'))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('finds flat and owner-namespaced checkouts with their origin', () => {
    makeRepo('flat', 'git@github.com:acme/flat.git')
    makeRepo('acme/nested', 'https://github.com/acme/nested.git')
    makeRepo('solo')
    const repos = discoverLocalRepos(root)
    expect(repos.map((r) => r.relPath)).toEqual(['acme/nested', 'flat', 'solo'])
    expect(repos.find((r) => r.name === 'flat')).toMatchObject({
      path: join(root, 'flat'),
      remoteKey: 'github.com/acme/flat',
    })
    expect(repos.find((r) => r.name === 'solo')).toMatchObject({ originUrl: null, remoteKey: null })
  })

  it('does not descend into a checkout or past depth 2', () => {
    makeRepo('outer')
    makeRepo('outer/inner-vendored')
    makeRepo('a/b/too-deep')
    expect(discoverLocalRepos(root).map((r) => r.relPath)).toEqual(['outer'])
  })

  it('skips hidden directories and node_modules', () => {
    makeRepo('.hidden/repo')
    makeRepo('node_modules/pkg')
    makeRepo('visible')
    expect(discoverLocalRepos(root).map((r) => r.relPath)).toEqual(['visible'])
  })

  it('handles a .git file pointing at a linked worktree (via commondir)', () => {
    const main = makeRepo('main', 'https://github.com/acme/main')
    const wtGitDir = join(main, '.git', 'worktrees', 'feature')
    mkdirSync(wtGitDir, { recursive: true })
    writeFileSync(join(wtGitDir, 'commondir'), '../..\n')
    const wt = join(root, 'feature-wt')
    mkdirSync(wt)
    writeFileSync(join(wt, '.git'), `gitdir: ${wtGitDir}\n`)

    expect(resolveGitConfigPath(join(wt, '.git'))).toBe(join(main, '.git', 'config'))
    // Worktrees (e.g. Codekin's `<project>-wt-<id>` siblings) are not projects.
    expect(discoverLocalRepos(root).map((r) => r.name)).toEqual(['main'])
  })

  it('handles a relative gitdir (submodule-style)', () => {
    const modDir = join(root, 'store', 'modules', 'lib')
    mkdirSync(modDir, { recursive: true })
    writeFileSync(join(modDir, 'config'), '[remote "origin"]\n\turl = git@github.com:acme/lib.git\n')
    const checkout = join(root, 'lib')
    mkdirSync(checkout)
    writeFileSync(join(checkout, '.git'), 'gitdir: ../store/modules/lib\n')
    expect(discoverLocalRepos(root).find((r) => r.name === 'lib')?.remoteKey).toBe('github.com/acme/lib')
  })

  it('follows symlinked directories', () => {
    const outside = mkdtempSync(join(tmpdir(), 'codekin-local-outside-'))
    try {
      mkdirSync(join(outside, '.git'))
      writeFileSync(join(outside, '.git', 'config'), '')
      symlinkSync(outside, join(root, 'linked'))
      expect(discoverLocalRepos(root).map((r) => r.relPath)).toEqual(['linked'])
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })

  it('returns [] for a missing root', () => {
    expect(discoverLocalRepos(join(root, 'does-not-exist'))).toEqual([])
  })
})
