/** Revoking an approval also revokes the Claude-native copies "Always Allow" wrote. */
import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  return {
    ...actual,
    existsSync: vi.fn(() => false),
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
    renameSync: vi.fn(),
    readFileSync: vi.fn(() => '{}'),
  }
})

vi.mock('./native-permissions.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./native-permissions.js')>()
  return { ...actual, addNativePermission: vi.fn(() => Promise.resolve()), removeNativePermission: vi.fn(() => Promise.resolve()) }
})

import { ApprovalManager } from './approval-manager.js'
import { removeNativePermission } from './native-permissions.js'

/** The predicate removeApproval passed for its native file. */
function removedBy(): (perm: string) => boolean {
  const calls = vi.mocked(removeNativePermission).mock.calls
  expect(calls).toHaveLength(1)
  expect(calls[0][0]).toBe('/repo/a')
  return calls[0][1] as (perm: string) => boolean
}

describe('ApprovalManager.removeApproval — native permissions', () => {
  let mgr: ApprovalManager

  beforeEach(() => {
    vi.clearAllMocks()
    mgr = new ApprovalManager()
  })

  it('removes the native entry for a revoked tool', () => {
    mgr.addRepoApproval('/repo/a', { tool: 'WebFetch' })
    mgr.removeApproval('/repo/a', { tool: 'WebFetch' })
    const matches = removedBy()
    expect(matches('WebFetch')).toBe(true)
    expect(matches('WebSearch')).toBe(false)
    expect(matches('Bash(WebFetch)')).toBe(false)
  })

  it('removes the exact native command for a revoked command', () => {
    mgr.addRepoApproval('/repo/a', { command: 'rm -rf build' })
    mgr.removeApproval('/repo/a', { command: 'rm -rf build' })
    const matches = removedBy()
    expect(matches('Bash(rm -rf build)')).toBe(true)
    expect(matches('Bash(rm -rf build2)')).toBe(false)
  })

  it('removes every native command a revoked pattern covers', () => {
    mgr.addRepoApproval('/repo/a', { pattern: 'git push *' })
    mgr.removeApproval('/repo/a', { pattern: 'git push *' })
    const matches = removedBy()
    expect(matches('Bash(git push)')).toBe(true)
    expect(matches('Bash(git push origin main)')).toBe(true)
    expect(matches('Bash(git pushx)')).toBe(false)
    expect(matches('Bash(git status)')).toBe(false)
  })

  it('keeps native commands a remaining rule still covers', () => {
    mgr.addRepoApproval('/repo/a', { pattern: 'git *' })
    mgr.addRepoApproval('/repo/a', { pattern: 'git push *' })
    mgr.addRepoApproval('/repo/a', { command: 'git push --force' })
    mgr.removeApproval('/repo/a', { pattern: 'git push *' })
    const matches = removedBy()
    expect(matches('Bash(git push origin main)')).toBe(false)
    expect(matches('Bash(git push --force)')).toBe(false)
  })

  it('leaves the native file alone when nothing was removed', () => {
    mgr.removeApproval('/repo/a', { tool: 'WebFetch' })
    expect(removeNativePermission).not.toHaveBeenCalled()
  })
})
