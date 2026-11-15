import { describe, it, expect } from 'vitest'
import { buildRepoNodes, SCRATCH_GROUP } from './sidebarGroups'
import type { Session } from '../types'

function session(id: string, workingDir: string, over: Partial<Session> = {}): Session {
  return { id, name: id, created: '2026-11-13T10:00:00Z', active: false, workingDir, connectedClients: 0, lastActivity: '2026-11-13T10:00:00Z', ...over }
}

describe('buildRepoNodes order', () => {
  const sessions = [
    session('z', '/srv/zeta', { lastTurnAt: '2026-11-15T09:00:00Z' }),
    session('a', '/srv/alpha', { lastTurnAt: '2026-11-14T09:00:00Z' }),
    session('a2', '/srv/alpha', { lastTurnAt: '2026-11-15T12:00:00Z' }),
    session('m', '/srv/mid'),
    session('s', '/home/sam/codekin/scratch/brisk-otter', { place: { kind: 'scratch', git: false }, lastTurnAt: '2026-11-15T10:00:00Z' }),
  ]

  it('sorts groups by their latest session by default', () => {
    expect(buildRepoNodes(sessions, {}, {}).map(n => n.displayName)).toEqual(['alpha', 'Scratch', 'zeta', 'mid'])
  })

  it('puts a group with a turn in progress first', () => {
    const running = sessions.map(s => s.id === 'm' ? { ...s, isProcessing: true } : s)
    expect(buildRepoNodes(running, {}, {}).map(n => n.displayName)[0]).toBe('mid')
  })

  it('sorts by name with Scratch first when asked', () => {
    expect(buildRepoNodes(sessions, {}, {}, 'name').map(n => n.displayName)).toEqual(['Scratch', 'alpha', 'mid', 'zeta'])
  })

  it('breaks activity ties by name', () => {
    const tied = [session('y', '/srv/yak'), session('b', '/srv/bee')]
    expect(buildRepoNodes(tied, {}, {}).map(n => n.displayName)).toEqual(['bee', 'yak'])
  })
})

describe('buildRepoNodes places', () => {
  it('puts every scratch session in one Scratch group, first', () => {
    const nodes = buildRepoNodes([
      session('a', '/home/sam/repos/acme/api', { place: { kind: 'repo', git: true } }),
      session('s1', '/home/sam/codekin/scratch/brisk-otter', { place: { kind: 'scratch', git: false } }),
      session('s2', '/home/sam/codekin/scratch/calm-heron', { place: { kind: 'scratch', git: false } }),
      session('n', '/home/sam/notes', { place: { kind: 'folder', git: false } }),
    ], {}, {}, 'name')
    expect(nodes.map(n => [n.displayName, n.kind, n.sessions.length])).toEqual([
      ['Scratch', 'scratch', 2],
      ['api', 'repo', 1],
      ['notes', 'folder', 1],
    ])
    expect(nodes[0].workingDir).toBe(SCRATCH_GROUP)
  })

  it('groups a worktree session under its repo with the repo place', () => {
    const nodes = buildRepoNodes([
      session('w', '/home/sam/.codekin/worktrees/x', { groupDir: '/home/sam/site', place: { kind: 'folder', git: true } }),
      session('m', '/home/sam/site', { place: { kind: 'folder', git: true } }),
    ], {}, {})
    expect(nodes).toHaveLength(1)
    expect(nodes[0]).toMatchObject({ workingDir: '/home/sam/site', kind: 'folder', git: true })
  })

  it('leaves the kind unset for sessions from an older server', () => {
    const nodes = buildRepoNodes([session('o', '/srv/repos/old')], {}, {})
    expect(nodes[0].kind).toBeUndefined()
  })
})
