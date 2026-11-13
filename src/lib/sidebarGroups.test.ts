import { describe, it, expect } from 'vitest'
import { buildRepoNodes, SCRATCH_GROUP } from './sidebarGroups'
import type { Session } from '../types'

function session(id: string, workingDir: string, over: Partial<Session> = {}): Session {
  return { id, name: id, created: '2026-11-13T10:00:00Z', active: false, workingDir, connectedClients: 0, lastActivity: '2026-11-13T10:00:00Z', ...over }
}

describe('buildRepoNodes places', () => {
  it('puts every scratch session in one Scratch group, first', () => {
    const nodes = buildRepoNodes([
      session('a', '/home/sam/repos/acme/api', { place: { kind: 'repo', git: true } }),
      session('s1', '/home/sam/codekin/scratch/brisk-otter', { place: { kind: 'scratch', git: false } }),
      session('s2', '/home/sam/codekin/scratch/calm-heron', { place: { kind: 'scratch', git: false } }),
      session('n', '/home/sam/notes', { place: { kind: 'folder', git: false } }),
    ], {}, {})
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
