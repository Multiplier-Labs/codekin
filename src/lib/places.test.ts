import { describe, it, expect, vi, beforeEach } from 'vitest'

const store = vi.hoisted(() => ({ prefs: {} as Record<string, unknown> }))
vi.mock('./prefs', () => ({
  getPref: (k: string) => store.prefs[k],
  setPref: (k: string, v: unknown) => { store.prefs[k] = v },
}))

import {
  NEW_SCRATCH, MAX_RECENT_PLACES, defaultPlace, withRecentPlace, placeKey, samePlace,
  placeFromRepo, placeFromPath, sessionPlaceLabel, placeFromSession, placeFromOwner, placeHint, placeTag, isNotRepoPlace,
  tildify, untildify, baseName, getRecentPlaces, rememberPlace, type DraftPlace,
} from './places'
import type { ApiRepo } from '../hooks/useRepos'

const HOME = '/home/sam'

function repo(over: Partial<ApiRepo> = {}): ApiRepo {
  return {
    id: 'web-app', name: 'web-app', owner: 'acme-co', path: '/home/sam/repos/acme-co/web-app',
    workingDir: '/home/sam/repos/acme-co/web-app', cloned: true, description: '', url: '',
    skills: [], modules: [], tags: [], ...over,
  }
}

beforeEach(() => { store.prefs = {} })

describe('paths', () => {
  it('tildify and untildify round-trip under home only', () => {
    expect(tildify('/home/sam/notes', HOME)).toBe('~/notes')
    expect(tildify('/home/sam', HOME)).toBe('~')
    expect(tildify('/home/samuel/x', HOME)).toBe('/home/samuel/x')
    expect(tildify('/srv/x', null)).toBe('/srv/x')
    expect(untildify('~/notes', HOME)).toBe('/home/sam/notes')
    expect(untildify('~', HOME)).toBe(HOME)
    expect(untildify('/abs', HOME)).toBe('/abs')
  })

  it('baseName takes the last segment', () => {
    expect(baseName('/a/b/c/')).toBe('c')
  })
})

describe('defaultPlace', () => {
  it('is a new scratch folder with no history', () => {
    expect(defaultPlace(undefined)).toBe(NEW_SCRATCH)
    expect(defaultPlace([])).toBe(NEW_SCRATCH)
  })

  it('is the last place used', () => {
    const folder = placeFromPath('/home/sam/notes', false, HOME)
    expect(defaultPlace([folder, NEW_SCRATCH])).toBe(folder)
  })

  it('never reuses a specific scratch folder', () => {
    const used: DraftPlace = { kind: 'scratch', path: '/home/sam/codekin/scratch/brisk-otter', git: false, label: 'x' }
    expect(defaultPlace([used])).toBe(NEW_SCRATCH)
  })
})

describe('recent places', () => {
  it('puts the latest first, dedupes and caps', () => {
    let h: DraftPlace[] = []
    for (let i = 0; i < MAX_RECENT_PLACES + 3; i++) h = withRecentPlace(h, placeFromPath(`/home/sam/p${i}`, false, HOME))
    expect(h).toHaveLength(MAX_RECENT_PLACES)
    expect(h[0].path).toBe(`/home/sam/p${MAX_RECENT_PLACES + 2}`)
    h = withRecentPlace(h, placeFromPath('/home/sam/p5', false, HOME))
    expect(h[0].path).toBe('/home/sam/p5')
    expect(h.filter(p => p.path === '/home/sam/p5')).toHaveLength(1)
  })

  it('remembers a created scratch folder as a new scratch folder', () => {
    const h = withRecentPlace([], { kind: 'scratch', path: '/s/x', git: false, label: 'x' })
    expect(h).toEqual([NEW_SCRATCH])
  })

  it('treats a remote repo and its later clone as the same place', () => {
    const remote = placeFromRepo(repo({ cloned: false }))
    const cloned = placeFromRepo(repo())
    expect(samePlace(remote, cloned)).toBe(true)
    expect(withRecentPlace([remote], cloned)).toEqual([cloned])
  })

  it('persists through prefs and drops malformed entries', () => {
    store.prefs.recentPlaces = [{ kind: 'bogus' }, placeFromPath('/home/sam/a', true, HOME), 3]
    expect(getRecentPlaces()).toHaveLength(1)
    rememberPlace(NEW_SCRATCH)
    expect((store.prefs.recentPlaces as DraftPlace[])[0]).toEqual(NEW_SCRATCH)
  })
})

describe('place constructors', () => {
  it('a repo not yet cloned has no path', () => {
    const p = placeFromRepo(repo({ cloned: false }))
    expect(p).toMatchObject({ kind: 'repo', git: true, label: 'acme-co/web-app' })
    expect(p.path).toBeUndefined()
    expect(placeKey(p)).toBe('repo:acme-co/web-app')
  })

  it('a session place maps scratch to a new scratch folder', () => {
    expect(placeFromSession({ workingDir: '/s/x', place: { kind: 'scratch', git: false } }, HOME)).toBe(NEW_SCRATCH)
    expect(placeFromSession({ workingDir: '/home/sam/wt/1', groupDir: '/home/sam/repos/a', place: { kind: 'repo', git: true } }, HOME))
      .toEqual({ kind: 'repo', path: '/home/sam/repos/a', git: true, label: 'a' })
  })

  it('an org session reopens as its org, and is never offered git init', () => {
    const fromSession = placeFromSession({ workingDir: '/home/sam/repos/acme-co', place: { kind: 'org', git: false, owner: 'acme-co' } }, HOME)
    expect(fromSession).toEqual({ kind: 'org', path: '/home/sam/repos/acme-co', git: false, label: 'acme-co', owner: 'acme-co' })
    expect(isNotRepoPlace({ kind: 'org', git: false, owner: 'acme-co' })).toBe(false)
    expect(isNotRepoPlace({ kind: 'folder', git: false })).toBe(true)
    expect(isNotRepoPlace({ kind: 'repo', git: true })).toBe(false)
    expect(isNotRepoPlace(undefined)).toBe(false)
  })

  it('describes an org place before and after its folder exists', () => {
    expect(placeHint(placeFromOwner('acme-co'), true, { home: HOME }))
      .toBe("Works across acme-co from the repositories folder's acme-co/. The agent clones repos as it needs them (you approve each), and each repo it changes gets its own worktree.")
    expect(placeHint({ ...placeFromOwner('acme-co'), path: '/home/sam/repos/acme-co' }, false, { home: HOME }))
      .toBe('Works across acme-co from ~/repos/acme-co. The agent clones repos as it needs them (you approve each), and it edits the clones in place.')
  })

  it('org places key by owner', () => {
    expect(placeKey(placeFromOwner('acme-co'))).toBe('org:acme-co')
  })
})

describe('placeHint', () => {
  it('describes each kind of place', () => {
    expect(placeHint(NEW_SCRATCH, true, { home: HOME, scratchRoot: '/home/sam/codekin/scratch' }))
      .toBe('Creates ~/codekin/scratch/… when you send. Git is optional: connect a repo later or never.')
    expect(placeHint(placeFromPath('/home/sam/notes', false, HOME), true, { home: HOME }))
      .toBe('Runs in ~/notes. Not a git repo, so there are no worktrees.')
    expect(placeHint(placeFromPath('/home/sam/site', true, HOME), true, { home: HOME }))
      .toBe('Runs in ~/site, on a fresh worktree.')
    expect(placeHint(placeFromPath('/home/sam/site', true, HOME), false, { home: HOME }))
      .toBe('Runs in ~/site, on the checked-out branch.')
    expect(placeHint(placeFromRepo(repo({ cloned: false })), true))
      .toBe('Clones acme-co/web-app into the repositories folder when you send.')
  })

  it('a folder inside a repository runs in place, whatever the worktree preference', () => {
    const nested = placeFromPath('/home/sam/site/src', true, HOME, '/home/sam/site')
    expect(nested.inRepo).toBe('/home/sam/site')
    expect(placeHint(nested, true, { home: HOME }))
      .toBe('Runs in ~/site/src, inside ~/site, on the checked-out branch (no worktree in a subfolder).')
    // At the repository root there is nothing to note.
    expect(placeFromPath('/home/sam/site', true, HOME, '/home/sam/site').inRepo).toBeUndefined()
    expect(placeFromSession({ workingDir: '/home/sam/site/src', place: { kind: 'repo', git: true, inRepo: '/home/sam/site' } }, HOME).inRepo)
      .toBe('/home/sam/site')
  })
})

describe('placeTag', () => {
  it('maps kinds to sidebar tags', () => {
    expect(placeTag('scratch', false)).toBe('scratch')
    expect(placeTag('folder', false)).toBe('folder')
    expect(placeTag('folder', true)).toBe('git folder')
    expect(placeTag('repo', true)).toBe('repo')
  })
})

describe('sessionPlaceLabel', () => {
  it('names scratch, org, repo and folder places', () => {
    expect(sessionPlaceLabel('/home/sam/codekin/scratch/brisk-otter', { kind: 'scratch', git: false }, '/home/sam')).toBe('scratch/brisk-otter')
    expect(sessionPlaceLabel('/home/sam/repos/acme-co', { kind: 'org', git: false, owner: 'acme-co' }, '/home/sam')).toBe('acme-co')
    expect(sessionPlaceLabel('/home/sam/repos/acme-co/api', { kind: 'repo', git: true }, '/home/sam')).toBe('api')
    expect(sessionPlaceLabel('/home/sam/notes', { kind: 'folder', git: false }, '/home/sam')).toBe('~/notes')
  })
})
