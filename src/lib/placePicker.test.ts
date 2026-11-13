import { describe, it, expect } from 'vitest'
import {
  INITIAL_PICKER_STATE, enterView, flatRows, isPathQuery, pickerKey, pickerModel, splitPathQuery,
  type PickerData, type PickerKey, type PickerState,
} from './placePicker'
import { NEW_SCRATCH, placeFromOwner, placeFromPath } from './places'
import type { ApiRepo, RepoGroup } from '../hooks/useRepos'

const HOME = '/home/sam'
const REPOS = '/home/sam/repos'

function repo(owner: string, name: string, cloned = true): ApiRepo {
  return {
    id: name, name, owner, path: `${REPOS}/${owner}/${name}`, workingDir: `${REPOS}/${owner}/${name}`,
    cloned, description: `${name} service`, url: '', skills: [], modules: [], tags: [],
  }
}

const GROUPS: RepoGroup[] = [
  { owner: 'acme-co', source: 'github', repos: [repo('acme-co', 'api'), repo('acme-co', 'billing', false), repo('acme-co', 'web-app')] },
  { owner: 'sam', source: 'github', repos: [repo('sam', 'dotfiles')] },
  { owner: 'local', source: 'local', repos: [repo('', 'scratchpad')] },
]

function data(over: Partial<PickerData> = {}): PickerData {
  return {
    groups: GROUPS,
    recent: [placeFromPath(`${HOME}/notes`, false, HOME), placeFromOwner('acme-co')],
    showOrgPlaces: false,
    listing: null,
    roots: [HOME, REPOS],
    home: HOME,
    ...over,
  }
}

const labels = (s: PickerState, d = data()) => flatRows(pickerModel(s, d)).map(r => r.label)

describe('path query helpers', () => {
  it.each([
    ['~', true], ['~/x', true], ['/srv', true], ['notes', false], ['~x', false],
  ])('isPathQuery(%s) = %s', (q, want) => { expect(isPathQuery(q)).toBe(want) })

  it.each([
    ['~/Doc', { dir: HOME, partial: 'Doc' }],
    ['~/Documents/', { dir: `${HOME}/Documents`, partial: '' }],
    ['~', { dir: HOME, partial: '' }],
    ['/srv', { dir: '/', partial: 'srv' }],
    ['/', { dir: '/', partial: '' }],
  ])('splitPathQuery(%s)', (q, want) => { expect(splitPathQuery(q, HOME)).toEqual(want) })
})

describe('root view', () => {
  it('shows Recent, Start fresh and the owners; org places hidden by default', () => {
    const model = pickerModel(INITIAL_PICKER_STATE, data())
    expect(model.sections.map(s => s.title)).toEqual(['Recent', 'Start fresh', 'GitHub'])
    expect(labels(INITIAL_PICKER_STATE)).toEqual([
      '~/notes', 'Scratch folder', 'Choose a folder on this machine…', 'acme-co', 'sam', 'Local checkouts',
    ])
    expect(model.footer).toBe('↑↓ move · ⏎ use place · → open · esc close')
  })

  it('shows org recents when org places are on', () => {
    expect(labels(INITIAL_PICKER_STATE, data({ showOrgPlaces: true }))).toContain('acme-co')
    const rows = flatRows(pickerModel(INITIAL_PICKER_STATE, data({ showOrgPlaces: true })))
    expect(rows[1].tag).toBe('org')
  })

  it('calls the section Repositories when there are only local checkouts', () => {
    const local = data({ groups: GROUPS.filter(g => g.source === 'local') })
    expect(pickerModel(INITIAL_PICKER_STATE, local).sections.map(s => s.title)).toEqual(['Recent', 'Start fresh', 'Repositories'])
  })

  it('leaves a recent scratch folder to Start fresh', () => {
    const rows = flatRows(pickerModel(INITIAL_PICKER_STATE, data({ recent: [NEW_SCRATCH, placeFromPath(`${HOME}/notes`, false, HOME)] })))
    expect(rows.filter(r => r.label === 'Scratch folder')).toHaveLength(1)
  })

  it('offers no scratch folder when attaching', () => {
    const model = pickerModel(INITIAL_PICKER_STATE, data({ allowScratch: false }))
    expect(model.sections.map(s => s.title)).toEqual(['Recent', 'This machine', 'GitHub'])
    expect(flatRows(model).some(r => r.label === 'Scratch folder')).toBe(false)
  })

  it('drops the Recent section with no history', () => {
    expect(pickerModel(INITIAL_PICKER_STATE, data({ recent: [] })).sections[0].title).toBe('Start fresh')
  })
})

describe('owner view', () => {
  const owner = enterView({ name: 'owner', owner: 'acme-co' })

  it('lists the repos after a back row; remote repos clone on send', () => {
    const rows = flatRows(pickerModel(owner, data()))
    expect(rows.map(r => r.label)).toEqual(['acme-co', 'api', 'billing', 'web-app'])
    expect(rows[0].action).toEqual({ type: 'back' })
    expect(rows[2]).toMatchObject({ icon: 'remote', tag: 'clones on send' })
    expect(owner.highlight).toBe(1)
  })

  it('offers the whole organization first when org places are on', () => {
    expect(labels(owner, data({ showOrgPlaces: true }))[1]).toBe('Whole organization')
  })

  it('filters by name or description', () => {
    expect(labels({ ...owner, query: 'bill' })).toEqual(['acme-co', 'billing'])
    const model = pickerModel({ ...owner, query: 'zzz' }, data())
    expect(model.notices[0].text).toBe('No repositories match.')
  })
})

describe('browse view', () => {
  const browse = enterView({ name: 'browse' })
  const listing = { path: `${HOME}/projects`, dirs: ['notes', 'site'], gitDirs: new Set(['site']), git: false }

  it('offers the folder itself first, then subfolders tagged git', () => {
    const rows = flatRows(pickerModel(browse, data({ listing })))
    expect(rows.map(r => r.label)).toEqual(['Choose a folder', 'Use ~/projects', 'notes', 'site'])
    expect(rows[1]).toMatchObject({ accent: true, action: { type: 'pick', place: { kind: 'folder', path: `${HOME}/projects`, git: false } } })
    expect(rows[3]).toMatchObject({ icon: 'repo', tag: 'git', opens: true, action: { type: 'browse', path: `${HOME}/projects/site` } })
  })

  it('a folder inside a repository is picked as git, naming the repository root', () => {
    const inside = { path: `${HOME}/projects/site/src`, dirs: ['lib'], gitDirs: new Set<string>(), git: true, repoRoot: `${HOME}/projects/site` }
    const rows = flatRows(pickerModel(browse, data({ listing: inside })))
    expect(rows[1]).toMatchObject({ action: { type: 'pick', place: { path: `${HOME}/projects/site/src`, git: true, inRepo: `${HOME}/projects/site` } } })
  })

  it('tags the folder itself when it is a repo', () => {
    const rows = flatRows(pickerModel(browse, data({ listing: { ...listing, git: true } })))
    expect(rows[1].tag).toBe('git repo')
  })

  it('filters subfolders and explains an empty folder', () => {
    expect(labels({ ...browse, query: 'si' }, data({ listing }))).toEqual(['Choose a folder', 'Use ~/projects', 'site'])
    const empty = pickerModel(browse, data({ listing: { ...listing, dirs: [], gitDirs: new Set() } }))
    expect(empty.notices[0].text).toBe('No subfolders. Use this folder, or go back.')
  })
})

describe('search', () => {
  it('matches recent places and repos by name across owners', () => {
    expect(labels({ ...INITIAL_PICKER_STATE, query: 'a' })).toEqual(
      expect.arrayContaining(['acme-co/api', 'acme-co/billing', 'acme-co/web-app']),
    )
    expect(labels({ ...INITIAL_PICKER_STATE, query: 'notes' })).toEqual(['~/notes'])
  })

  it('says how to use any folder when nothing matches', () => {
    const model = pickerModel({ ...INITIAL_PICKER_STATE, query: 'zzz' }, data())
    expect(model.notices[0].text).toBe('No places match. Type a path starting with ~ to use any folder.')
  })

  it('completes a ~/ path against the listed folder, with Use first on an exact match', () => {
    const listing = { path: HOME, dirs: ['Documents', 'Downloads', 'notes'], gitDirs: new Set<string>(), git: false }
    const partial = labels({ ...INITIAL_PICKER_STATE, query: '~/Do' }, data({ listing }))
    expect(partial).toEqual(['~/Documents', '~/Downloads'])
    const exact = labels({ ...INITIAL_PICKER_STATE, query: '~/notes' }, data({ listing }))
    expect(exact).toEqual(['Use ~/notes', '~/notes'])
    const dirItself = labels({ ...INITIAL_PICKER_STATE, query: '~' }, data({ listing }))
    expect(dirItself[0]).toBe('Use ~')
  })

  it('waits for the listing of the folder a path points into', () => {
    const listing = { path: '/elsewhere', dirs: ['x'], gitDirs: new Set<string>(), git: false }
    expect(labels({ ...INITIAL_PICKER_STATE, query: '~/Do' }, data({ listing }))).toEqual([])
  })

  it('refuses an absolute path outside the allowed roots', () => {
    const model = pickerModel({ ...INITIAL_PICKER_STATE, query: '/etc/nginx' }, data())
    expect(flatRows(model)).toEqual([])
    expect(model.notices[0]).toMatchObject({
      tone: 'error',
      text: 'Only folders under your home or the repos root can be used. /etc/nginx is outside both.',
    })
  })

  it('refuses a path the server refused, e.g. through a symlink', () => {
    const model = pickerModel({ ...INITIAL_PICKER_STATE, query: '~/link/x' }, data({ refusedPath: `${HOME}/link` }))
    expect(model.notices[0].tone).toBe('error')
  })
})

describe('keys', () => {
  const rows = flatRows(pickerModel(INITIAL_PICKER_STATE, data()))
  const press = (s: PickerState, key: PickerKey, r = rows) => pickerKey(s, r, key)

  it('arrows move and wrap', () => {
    expect(press(INITIAL_PICKER_STATE, 'ArrowDown').state.highlight).toBe(1)
    expect(press(INITIAL_PICKER_STATE, 'ArrowUp').state.highlight).toBe(rows.length - 1)
    expect(press({ ...INITIAL_PICKER_STATE, highlight: rows.length - 1 }, 'ArrowDown').state.highlight).toBe(0)
  })

  it('Enter activates the highlighted row', () => {
    expect(press({ ...INITIAL_PICKER_STATE, highlight: 1 }, 'Enter').action).toEqual({ type: 'pick', place: NEW_SCRATCH })
    expect(press({ ...INITIAL_PICKER_STATE, highlight: 3 }, 'Enter').action).toEqual({ type: 'open-owner', owner: 'acme-co' })
  })

  it('→ opens only openable rows and only with an empty query', () => {
    expect(press({ ...INITIAL_PICKER_STATE, highlight: 3 }, 'ArrowRight').action).toEqual({ type: 'open-owner', owner: 'acme-co' })
    expect(press({ ...INITIAL_PICKER_STATE, highlight: 0 }, 'ArrowRight').handled).toBe(false)
    expect(press({ ...INITIAL_PICKER_STATE, highlight: 3, query: 'x' }, 'ArrowRight').handled).toBe(false)
  })

  it('← and Backspace go back with an empty query: owner → root, browse → up', () => {
    const owner = enterView({ name: 'owner', owner: 'acme-co' })
    expect(press(owner, 'ArrowLeft').action).toEqual({ type: 'back' })
    expect(press(owner, 'Backspace').action).toEqual({ type: 'back' })
    expect(press({ ...owner, query: 'a' }, 'Backspace').handled).toBe(false)
    expect(press(enterView({ name: 'browse' }), 'ArrowLeft').action).toEqual({ type: 'up' })
    expect(press(INITIAL_PICKER_STATE, 'ArrowLeft').handled).toBe(false)
  })

  it('Esc closes', () => {
    expect(press(INITIAL_PICKER_STATE, 'Escape').close).toBe(true)
  })

  it('handles an empty list', () => {
    expect(press(INITIAL_PICKER_STATE, 'ArrowDown', []).state.highlight).toBe(0)
    expect(press(INITIAL_PICKER_STATE, 'Enter', []).action).toBeUndefined()
  })
})
