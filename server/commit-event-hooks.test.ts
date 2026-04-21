/**
 * Tests for commit-event-hooks — verifies idempotent post-commit hook install/uninstall,
 * BEGIN/END marker handling, and secure hook-config.json (mode 0600) placement.
 *
 * Uses a temporary directory to simulate ~/.codekin and a bare git repo so the
 * real filesystem is exercised without touching the user's home directory.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, statSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { randomUUID } from 'crypto'

// Temp home dir created per-test; referenced via the hoisted mockHomedir.
let TMP_HOME: string

const mockHomedir = vi.hoisted(() => vi.fn(() => '/tmp/placeholder'))

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>()
  return {
    ...actual,
    homedir: mockHomedir,
  }
})

const mockLoadWorkflowConfig = vi.hoisted(() => vi.fn(() => ({ reviewRepos: [] })))
vi.mock('./workflow-config.js', () => ({
  loadWorkflowConfig: mockLoadWorkflowConfig,
}))

// Import under test AFTER mocks are declared. Note: commit-event-hooks resolves
// HOOK_CONFIG_PATH eagerly at import time using homedir(), so we must set
// TMP_HOME and mockHomedir before each test via dynamic import.
type HookModule = typeof import('./commit-event-hooks.js')

async function loadModule(): Promise<HookModule> {
  vi.resetModules()
  return await import('./commit-event-hooks.js')
}

function makeRepo(root: string): string {
  const repo = join(root, 'repo-' + randomUUID().slice(0, 8))
  mkdirSync(join(repo, '.git', 'hooks'), { recursive: true })
  return repo
}

beforeEach(() => {
  TMP_HOME = join(tmpdir(), 'codekin-hooks-test-' + randomUUID())
  mkdirSync(TMP_HOME, { recursive: true })
  mockHomedir.mockReturnValue(TMP_HOME)
  mockLoadWorkflowConfig.mockReturnValue({ reviewRepos: [] })
})

afterEach(() => {
  if (TMP_HOME && existsSync(TMP_HOME)) {
    rmSync(TMP_HOME, { recursive: true, force: true })
  }
  vi.restoreAllMocks()
})

describe('ensureHookConfig', () => {
  it('writes ~/.codekin/hook-config.json with mode 0600', async () => {
    const { ensureHookConfig } = await loadModule()
    ensureHookConfig('secret-token-xyz', 'http://localhost:32352')

    const path = join(TMP_HOME, '.codekin', 'hook-config.json')
    expect(existsSync(path)).toBe(true)
    const contents = JSON.parse(readFileSync(path, 'utf-8'))
    expect(contents).toEqual({ serverUrl: 'http://localhost:32352', authToken: 'secret-token-xyz' })

    // Assert restrictive permissions (0600). The low 9 bits are rwxrwxrwx.
    const mode = statSync(path).mode & 0o777
    expect(mode).toBe(0o600)
  })

  it('creates the .codekin directory if it does not exist', async () => {
    const { ensureHookConfig } = await loadModule()
    expect(existsSync(join(TMP_HOME, '.codekin'))).toBe(false)
    ensureHookConfig('tok', 'http://x')
    expect(existsSync(join(TMP_HOME, '.codekin'))).toBe(true)
  })

  it('overwrites an existing config with new values', async () => {
    const { ensureHookConfig } = await loadModule()
    ensureHookConfig('old', 'http://old')
    ensureHookConfig('new', 'http://new')
    const path = join(TMP_HOME, '.codekin', 'hook-config.json')
    const contents = JSON.parse(readFileSync(path, 'utf-8'))
    expect(contents.authToken).toBe('new')
    expect(contents.serverUrl).toBe('http://new')
  })
})

describe('installCommitHook', () => {
  it('creates a new post-commit hook file with BEGIN/END markers and shebang', async () => {
    const { installCommitHook } = await loadModule()
    const repo = makeRepo(TMP_HOME)
    installCommitHook(repo)

    const hookPath = join(repo, '.git', 'hooks', 'post-commit')
    expect(existsSync(hookPath)).toBe(true)
    const contents = readFileSync(hookPath, 'utf-8')
    expect(contents.startsWith('#!/bin/sh')).toBe(true)
    expect(contents).toContain('# BEGIN CODEKIN COMMIT HOOK')
    expect(contents).toContain('# END CODEKIN COMMIT HOOK')

    // Executable bits set
    const mode = statSync(hookPath).mode & 0o777
    expect(mode).toBe(0o755)
  })

  it('is idempotent — repeated installs only keep one BEGIN/END section', async () => {
    const { installCommitHook } = await loadModule()
    const repo = makeRepo(TMP_HOME)
    installCommitHook(repo)
    installCommitHook(repo)
    installCommitHook(repo)

    const contents = readFileSync(join(repo, '.git', 'hooks', 'post-commit'), 'utf-8')
    const beginCount = (contents.match(/# BEGIN CODEKIN COMMIT HOOK/g) ?? []).length
    const endCount = (contents.match(/# END CODEKIN COMMIT HOOK/g) ?? []).length
    expect(beginCount).toBe(1)
    expect(endCount).toBe(1)
  })

  it('appends to an existing user-provided hook without deleting their content', async () => {
    const { installCommitHook } = await loadModule()
    const repo = makeRepo(TMP_HOME)
    const hookPath = join(repo, '.git', 'hooks', 'post-commit')
    const existingUserContent = '#!/bin/sh\n# user hook\necho "hello from user"\n'
    writeFileSync(hookPath, existingUserContent, 'utf-8')

    installCommitHook(repo)

    const contents = readFileSync(hookPath, 'utf-8')
    expect(contents).toContain('echo "hello from user"')
    expect(contents).toContain('# BEGIN CODEKIN COMMIT HOOK')
  })

  it('replaces existing codekin section in-place on reinstall', async () => {
    const { installCommitHook } = await loadModule()
    const repo = makeRepo(TMP_HOME)
    const hookPath = join(repo, '.git', 'hooks', 'post-commit')

    installCommitHook(repo)
    const before = readFileSync(hookPath, 'utf-8')
    // Install again — content should still be a single section
    installCommitHook(repo)
    const after = readFileSync(hookPath, 'utf-8')

    expect(after.split('# BEGIN CODEKIN COMMIT HOOK').length).toBe(2)
    // Sanity: the two runs produce identical output (section is deterministic)
    expect(before).toBe(after)
  })

  it('creates the hooks directory if it is missing', async () => {
    const { installCommitHook } = await loadModule()
    const repo = join(TMP_HOME, 'no-hooks-dir')
    mkdirSync(join(repo, '.git'), { recursive: true })
    installCommitHook(repo)
    expect(existsSync(join(repo, '.git', 'hooks', 'post-commit'))).toBe(true)
  })
})

describe('uninstallCommitHook', () => {
  it('returns false when no hook file exists', async () => {
    const { uninstallCommitHook } = await loadModule()
    const repo = makeRepo(TMP_HOME)
    expect(uninstallCommitHook(repo)).toBe(false)
  })

  it('returns false when hook file exists but has no codekin section', async () => {
    const { uninstallCommitHook } = await loadModule()
    const repo = makeRepo(TMP_HOME)
    const hookPath = join(repo, '.git', 'hooks', 'post-commit')
    writeFileSync(hookPath, '#!/bin/sh\necho "foreign hook"\n')
    expect(uninstallCommitHook(repo)).toBe(false)
    // File is left untouched
    expect(readFileSync(hookPath, 'utf-8')).toContain('foreign hook')
  })

  it('removes the codekin section but keeps user content', async () => {
    const { installCommitHook, uninstallCommitHook } = await loadModule()
    const repo = makeRepo(TMP_HOME)
    const hookPath = join(repo, '.git', 'hooks', 'post-commit')
    writeFileSync(hookPath, '#!/bin/sh\n# user hook\necho "hi"\n', 'utf-8')
    installCommitHook(repo)

    expect(uninstallCommitHook(repo)).toBe(true)
    const contents = readFileSync(hookPath, 'utf-8')
    expect(contents).not.toContain('CODEKIN COMMIT HOOK')
    expect(contents).toContain('echo "hi"')
  })

  it('deletes the hook file if it contains only the codekin section + shebang', async () => {
    const { installCommitHook, uninstallCommitHook } = await loadModule()
    const repo = makeRepo(TMP_HOME)
    installCommitHook(repo)

    expect(uninstallCommitHook(repo)).toBe(true)
    expect(existsSync(join(repo, '.git', 'hooks', 'post-commit'))).toBe(false)
  })
})

describe('syncCommitHooks', () => {
  it('installs hooks for enabled commit-review repos', async () => {
    const { syncCommitHooks } = await loadModule()
    const repo = makeRepo(TMP_HOME)
    mockLoadWorkflowConfig.mockReturnValue({
      reviewRepos: [
        { id: '1', name: 'r', repoPath: repo, cronExpression: 'event', enabled: true, kind: 'commit-review' },
      ],
    } as ReturnType<typeof mockLoadWorkflowConfig>)

    syncCommitHooks()
    expect(existsSync(join(repo, '.git', 'hooks', 'post-commit'))).toBe(true)
  })

  it('uninstalls hooks for repos no longer in commit-review', async () => {
    const hooksMod = await loadModule()
    const repo = makeRepo(TMP_HOME)

    // First install a hook
    hooksMod.installCommitHook(repo)
    expect(existsSync(join(repo, '.git', 'hooks', 'post-commit'))).toBe(true)

    // Config switches that repo to a non-commit-review workflow
    mockLoadWorkflowConfig.mockReturnValue({
      reviewRepos: [
        { id: '1', name: 'r', repoPath: repo, cronExpression: '0 9 * * *', enabled: true, kind: 'code-review.daily' },
      ],
    } as ReturnType<typeof mockLoadWorkflowConfig>)
    hooksMod.syncCommitHooks()
    expect(existsSync(join(repo, '.git', 'hooks', 'post-commit'))).toBe(false)
  })

  it('skips disabled commit-review repos', async () => {
    const { syncCommitHooks } = await loadModule()
    const repo = makeRepo(TMP_HOME)
    mockLoadWorkflowConfig.mockReturnValue({
      reviewRepos: [
        { id: '1', name: 'r', repoPath: repo, cronExpression: 'event', enabled: false, kind: 'commit-review' },
      ],
    } as ReturnType<typeof mockLoadWorkflowConfig>)

    syncCommitHooks()
    expect(existsSync(join(repo, '.git', 'hooks', 'post-commit'))).toBe(false)
  })

  it('skips repos without a .git directory', async () => {
    const { syncCommitHooks } = await loadModule()
    const repo = join(TMP_HOME, 'not-a-git-repo')
    mkdirSync(repo, { recursive: true })
    mockLoadWorkflowConfig.mockReturnValue({
      reviewRepos: [
        { id: '1', name: 'r', repoPath: repo, cronExpression: 'event', enabled: true, kind: 'commit-review' },
      ],
    } as ReturnType<typeof mockLoadWorkflowConfig>)

    // Should not throw
    expect(() => syncCommitHooks()).not.toThrow()
    expect(existsSync(join(repo, '.git'))).toBe(false)
  })
})
