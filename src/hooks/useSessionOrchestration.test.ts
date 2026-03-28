/** Tests for useSessionOrchestration — verifies the groupKey helper for session grouping by repo directory with no mocks. */
import { describe, it, expect } from 'vitest'
import { groupKey } from './useSessionOrchestration'
import type { Session } from '../types'

/** Minimal session stub with only fields needed by groupKey. */
function stubSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 'test-id',
    name: 'test',
    workingDir: '/repos/project',
    active: false,
    created: new Date().toISOString(),
    ...overrides,
  } as Session
}

describe('groupKey', () => {
  it('returns groupDir when set', () => {
    const s = stubSession({ groupDir: '/repos/project', workingDir: '/repos/project-wt-abc123' })
    expect(groupKey(s)).toBe('/repos/project')
  })

  it('falls back to workingDir when groupDir is undefined', () => {
    const s = stubSession({ groupDir: undefined, workingDir: '/repos/project' })
    expect(groupKey(s)).toBe('/repos/project')
  })

  it('returns repo root for worktree sessions with groupDir', () => {
    const s = stubSession({
      groupDir: '/srv/repos/codekin',
      workingDir: '/srv/repos/codekin-wt-f832eace',
    })
    expect(groupKey(s)).toBe('/srv/repos/codekin')
  })
})
