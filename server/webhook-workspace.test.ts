import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

type ExecFileCallback = (error: Error | null, stdout: string, stderr: string) => void

vi.mock('child_process', () => ({
  execFile: vi.fn((_cmd: string, _args: string[], _opts: unknown, cb?: ExecFileCallback) => {
    if (typeof _opts === 'function') { (_opts as ExecFileCallback)(null, '', ''); return }
    if (cb) { cb(null, '', ''); return }
  }),
}))

vi.mock('fs', () => ({
  existsSync: vi.fn(() => false),
  mkdirSync: vi.fn(),
  rmSync: vi.fn(),
}))

vi.mock('os', () => ({
  homedir: vi.fn(() => '/mock-home'),
}))

import { createWorkspace, cleanupWorkspace } from './webhook-workspace.js'
import { execFile } from 'child_process'
import { existsSync, mkdirSync, rmSync } from 'fs'

const mockedExecFile = vi.mocked(execFile)
const mockedExistsSync = vi.mocked(existsSync)
const mockedMkdirSync = vi.mocked(mkdirSync)
const mockedRmSync = vi.mocked(rmSync)

/** Helper to extract the command + args from an execFile call. */
function execCalls(): Array<{ cmd: string; args: string[]; opts?: Record<string, unknown> }> {
  return mockedExecFile.mock.calls.map((c) => ({
    cmd: c[0] as string,
    args: c[1] as string[],
    opts: (typeof c[2] === 'object' ? c[2] : undefined) as Record<string, unknown> | undefined,
  }))
}

describe('webhook-workspace', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockedExistsSync.mockReturnValue(false)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('createWorkspace', () => {
    it('happy path: clones from mirror, sets up remote, fetches, checks out, pins commit, sets git config', async () => {
      const result = await createWorkspace(
        'session-1',
        'owner/repo',
        'https://github.com/owner/repo.git',
        'fix-branch',
        'abc1234567890',
      )

      expect(result).toBe('/mock-home/.codekin/workspaces/session-1')

      const calls = execCalls()

      // 1. gh repo clone (bare mirror)
      expect(calls[0].cmd).toBe('gh')
      expect(calls[0].args).toContain('--bare')
      expect(calls[0].args).toContain('owner/repo')

      // 2. git clone from mirror to workspace
      expect(calls[1].cmd).toBe('git')
      expect(calls[1].args[0]).toBe('clone')
      expect(calls[1].args[1]).toBe('/mock-home/.codekin/repos/owner/repo.git')
      expect(calls[1].args[2]).toBe('/mock-home/.codekin/workspaces/session-1')

      // 3. set-url origin
      expect(calls[2].cmd).toBe('git')
      expect(calls[2].args).toEqual(['remote', 'set-url', 'origin', 'https://github.com/owner/repo.git'])

      // 4. fetch branch
      expect(calls[3].cmd).toBe('git')
      expect(calls[3].args[0]).toBe('fetch')
      expect(calls[3].args[2]).toContain('fix-branch')

      // 5. checkout branch
      expect(calls[4].cmd).toBe('git')
      expect(calls[4].args[0]).toBe('checkout')
      expect(calls[4].args).toContain('fix-branch')

      // 6. reset --hard to headSha
      expect(calls[5].cmd).toBe('git')
      expect(calls[5].args).toEqual(['reset', '--hard', 'abc1234567890'])

      // 7. git config user.name
      expect(calls[6].cmd).toBe('git')
      expect(calls[6].args).toEqual(['config', 'user.name', 'Claude (Webhook)'])

      // 8. git config user.email
      expect(calls[7].cmd).toBe('git')
      expect(calls[7].args).toEqual(['config', 'user.email', 'claude-webhook@codekin.local'])

      // 9. git config credential.helper
      expect(calls[8].cmd).toBe('git')
      expect(calls[8].args[0]).toBe('config')
      expect(calls[8].args[1]).toBe('credential.helper')

      // mkdirSync called for parent dir and workspace dir
      expect(mockedMkdirSync).toHaveBeenCalledWith('/mock-home/.codekin/repos/owner', { recursive: true })
      expect(mockedMkdirSync).toHaveBeenCalledWith('/mock-home/.codekin/workspaces/session-1', { recursive: true })
    })

    it('mirror already exists: fetches to update, then clones workspace', async () => {
      // First call checks mirrorPath — return true so it takes the "update" path
      mockedExistsSync.mockReturnValue(true)

      const result = await createWorkspace(
        'session-2',
        'owner/repo',
        'https://github.com/owner/repo.git',
        'main',
        'def456',
      )

      expect(result).toBe('/mock-home/.codekin/workspaces/session-2')

      const calls = execCalls()

      // 1. git fetch --all --prune (update mirror)
      expect(calls[0].cmd).toBe('git')
      expect(calls[0].args).toEqual(['fetch', '--all', '--prune'])
      expect(calls[0].opts?.cwd).toBe('/mock-home/.codekin/repos/owner/repo.git')

      // 2. git clone from mirror
      expect(calls[1].cmd).toBe('git')
      expect(calls[1].args[0]).toBe('clone')

      // Should NOT have called gh repo clone since mirror already exists
      const ghCalls = calls.filter((c) => c.cmd === 'gh')
      expect(ghCalls).toHaveLength(0)
    })

    it('mirror fetch fails but continues with stale mirror', async () => {
      mockedExistsSync.mockReturnValue(true)

      // First execFile call (git fetch --all --prune) should fail
      let callIndex = 0
      mockedExecFile.mockImplementation(
        (_cmd: string, _args: unknown, _opts: unknown, cb?: ExecFileCallback) => {
          callIndex++
          if (callIndex === 1) {
            // Mirror fetch fails
            const err = new Error('network error')
            if (typeof _opts === 'function') { (_opts as ExecFileCallback)(err, '', ''); return undefined as never }
            if (cb) { cb(err, '', ''); return undefined as never }
            return undefined as never
          }
          // All subsequent calls succeed
          if (typeof _opts === 'function') { (_opts as ExecFileCallback)(null, '', ''); return undefined as never }
          if (cb) { cb(null, '', ''); return undefined as never }
          return undefined as never
        },
      )

      // Should not throw — continues with stale mirror
      const result = await createWorkspace(
        'session-3',
        'owner/repo',
        'https://github.com/owner/repo.git',
        'main',
        'aaa111',
      )

      expect(result).toBe('/mock-home/.codekin/workspaces/session-3')

      // The clone step should still have been called despite fetch failure
      const calls = execCalls()
      const cloneCalls = calls.filter((c) => c.cmd === 'git' && (c.args as string[])[0] === 'clone')
      expect(cloneCalls.length).toBeGreaterThanOrEqual(1)
    })

    it('concurrent calls for same repo wait on the lock', async () => {
      let resolveFirst: (() => void) | undefined
      const firstCallBarrier = new Promise<void>((r) => { resolveFirst = r })

      let callCount = 0
      mockedExecFile.mockImplementation(
        (_cmd: string, _args: unknown, _opts: unknown, cb?: ExecFileCallback) => {
          callCount++
          const currentCall = callCount

          if (currentCall === 1) {
            // First call (gh repo clone for mirror) — delay it
            firstCallBarrier.then(() => {
              if (typeof _opts === 'function') { (_opts as ExecFileCallback)(null, '', '') }
              else if (cb) { cb(null, '', '') }
            })
            return undefined as never
          }

          // All other calls complete synchronously
          if (typeof _opts === 'function') { (_opts as ExecFileCallback)(null, '', '') }
          else if (cb) { cb(null, '', '') }
          return undefined as never
        },
      )

      // Start two concurrent createWorkspace calls for the same repo
      const promise1 = createWorkspace(
        'session-a',
        'owner/repo',
        'https://github.com/owner/repo.git',
        'main',
        'sha1',
      )
      const promise2 = createWorkspace(
        'session-b',
        'owner/repo',
        'https://github.com/owner/repo.git',
        'main',
        'sha2',
      )

      // Let the first mirror clone complete
      resolveFirst!()

      const [result1, result2] = await Promise.all([promise1, promise2])

      // Both should resolve with their own workspace paths
      expect(result1).toBe('/mock-home/.codekin/workspaces/session-a')
      expect(result2).toBe('/mock-home/.codekin/workspaces/session-b')

      // The mirror should only have been created once (gh repo clone called once)
      const calls = execCalls()
      const ghCalls = calls.filter((c) => c.cmd === 'gh')
      expect(ghCalls).toHaveLength(1)
    })
  })

  describe('cleanupWorkspace', () => {
    it('removes directory when it exists', () => {
      mockedExistsSync.mockReturnValue(true)

      cleanupWorkspace('session-1')

      expect(mockedRmSync).toHaveBeenCalledWith(
        '/mock-home/.codekin/workspaces/session-1',
        { recursive: true, force: true },
      )
    })

    it('does nothing when directory does not exist', () => {
      mockedExistsSync.mockReturnValue(false)

      cleanupWorkspace('session-nonexistent')

      expect(mockedRmSync).not.toHaveBeenCalled()
    })

    it('handles rmSync errors gracefully', () => {
      mockedExistsSync.mockReturnValue(true)
      mockedRmSync.mockImplementation(() => {
        throw new Error('permission denied')
      })

      // Should not throw
      expect(() => cleanupWorkspace('session-err')).not.toThrow()
    })
  })
})
