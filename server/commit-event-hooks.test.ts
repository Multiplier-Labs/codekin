/**
 * Tests for commit-event-hooks — verifies hook-config.json write with 0600 mode,
 * post-commit marker block install / remove / idempotent re-install, and
 * syncCommitHooks behavior against a temp ~/.codekin + bare git repo fixture.
 *
 * We override os.homedir() via vi.mock so ~/.codekin resolves into a temp dir,
 * and stub loadWorkflowConfig() so syncCommitHooks reads from our fixture.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs'
import { execFileSync } from 'child_process'
import { tmpdir } from 'os'
import { join } from 'path'

// ---------------------------------------------------------------------------
// Hoisted state — carries the temp home dir between mock factory and tests.
// vi.mock factories run after vi.hoisted but before the test file's imports,
// so we populate this object in the 'os' mock factory.
// ---------------------------------------------------------------------------

const state = vi.hoisted(() => ({
  home: '',
  workflowConfig: { reviewRepos: [] as Array<{
    id: string
    name: string
    repoPath: string
    cronExpression: string
    enabled: boolean
    kind?: string
  }> },
}))

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>()
  const fs = await vi.importActual<typeof import('fs')>('fs')
  const path = await vi.importActual<typeof import('path')>('path')
  state.home = fs.mkdtempSync(path.join(actual.tmpdir(), 'codekin-hooks-'))
  return { ...actual, homedir: () => state.home }
})

vi.mock('./workflow-config.js', () => ({
  loadWorkflowConfig: () => state.workflowConfig,
  saveWorkflowConfig: vi.fn(),
  addReviewRepo: vi.fn(),
  removeReviewRepo: vi.fn(),
  updateReviewRepo: vi.fn(),
}))

import {
  ensureHookConfig,
  installCommitHook,
  uninstallCommitHook,
  syncCommitHooks,
} from './commit-event-hooks.js'

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const BEGIN_MARKER = '# BEGIN CODEKIN COMMIT HOOK'
const END_MARKER = '# END CODEKIN COMMIT HOOK'

/** Create a bare working git repo in a temp dir. Returns the repo path. */
function makeGitRepo(): string {
  const repoDir = mkdtempSync(join(tmpdir(), 'codekin-repo-'))
  execFileSync('git', ['init', '-q', repoDir], { stdio: ['ignore', 'ignore', 'ignore'] })
  return repoDir
}

/** Clean up one or more directories recursively (ignores missing). */
function rmAll(...dirs: string[]) {
  for (const d of dirs) {
    if (d && existsSync(d)) rmSync(d, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------------------
// ensureHookConfig
// ---------------------------------------------------------------------------

describe('ensureHookConfig', () => {
  const configPath = () => join(state.home, '.codekin', 'hook-config.json')
  const configDir = () => join(state.home, '.codekin')

  beforeEach(() => {
    // Ensure a clean ~/.codekin between runs
    rmAll(configDir())
  })

  it('writes hook-config.json with serverUrl + authToken', () => {
    ensureHookConfig('tok-123', 'http://localhost:32352')

    expect(existsSync(configPath())).toBe(true)
    const parsed = JSON.parse(readFileSync(configPath(), 'utf-8'))
    expect(parsed).toEqual({ serverUrl: 'http://localhost:32352', authToken: 'tok-123' })
  })

  it('writes the file with 0600 permissions', () => {
    ensureHookConfig('secret-token', 'http://example.test')
    const mode = statSync(configPath()).mode & 0o777
    expect(mode).toBe(0o600)
  })

  it('creates the ~/.codekin directory if it does not exist', () => {
    expect(existsSync(configDir())).toBe(false)
    ensureHookConfig('t', 'u')
    expect(existsSync(configDir())).toBe(true)
  })

  it('overwrites an existing config on re-run', () => {
    ensureHookConfig('old-token', 'http://old')
    ensureHookConfig('new-token', 'http://new')

    const parsed = JSON.parse(readFileSync(configPath(), 'utf-8'))
    expect(parsed.authToken).toBe('new-token')
    expect(parsed.serverUrl).toBe('http://new')
  })
})

// ---------------------------------------------------------------------------
// installCommitHook
// ---------------------------------------------------------------------------

describe('installCommitHook', () => {
  let repoDir: string

  beforeEach(() => {
    repoDir = makeGitRepo()
  })

  afterEach(() => {
    rmAll(repoDir)
  })

  it('creates post-commit with a shebang + marker block when no hook exists', () => {
    installCommitHook(repoDir)

    const hookPath = join(repoDir, '.git', 'hooks', 'post-commit')
    expect(existsSync(hookPath)).toBe(true)

    const content = readFileSync(hookPath, 'utf-8')
    expect(content.startsWith('#!/bin/sh')).toBe(true)
    expect(content).toContain(BEGIN_MARKER)
    expect(content).toContain(END_MARKER)
    // The block references the shipped shell script
    expect(content).toContain('commit-event-hook.sh')
  })

  it('sets executable permissions (0755) on the hook', () => {
    installCommitHook(repoDir)
    const hookPath = join(repoDir, '.git', 'hooks', 'post-commit')
    const mode = statSync(hookPath).mode & 0o777
    expect(mode).toBe(0o755)
  })

  it('is idempotent — re-running does not duplicate the marker block', () => {
    installCommitHook(repoDir)
    installCommitHook(repoDir)

    const hookPath = join(repoDir, '.git', 'hooks', 'post-commit')
    const content = readFileSync(hookPath, 'utf-8')

    // Count markers — should be exactly one of each
    const beginCount = (content.match(new RegExp(BEGIN_MARKER, 'g')) || []).length
    const endCount = (content.match(new RegExp(END_MARKER, 'g')) || []).length
    expect(beginCount).toBe(1)
    expect(endCount).toBe(1)
  })

  it('appends the block to an existing user hook (preserving user content)', () => {
    const hookPath = join(repoDir, '.git', 'hooks', 'post-commit')
    const userContent = '#!/bin/bash\n# User-defined hook\necho "user hook"\n'
    writeFileSync(hookPath, userContent)

    installCommitHook(repoDir)

    const final = readFileSync(hookPath, 'utf-8')
    expect(final).toContain('# User-defined hook')
    expect(final).toContain('echo "user hook"')
    expect(final).toContain(BEGIN_MARKER)
    expect(final).toContain(END_MARKER)
  })

  it('replaces an existing codekin block rather than appending a second one', () => {
    installCommitHook(repoDir)
    const hookPath = join(repoDir, '.git', 'hooks', 'post-commit')
    // Hand-tamper the marker block contents to simulate an older install
    const before = readFileSync(hookPath, 'utf-8')
    const tampered = before.replace('commit-event-hook.sh', 'OLD-PATH.sh')
    writeFileSync(hookPath, tampered)

    installCommitHook(repoDir)

    const after = readFileSync(hookPath, 'utf-8')
    expect(after).not.toContain('OLD-PATH.sh')
    expect(after).toContain('commit-event-hook.sh')
    // Still only one block
    expect((after.match(new RegExp(BEGIN_MARKER, 'g')) || []).length).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// uninstallCommitHook
// ---------------------------------------------------------------------------

describe('uninstallCommitHook', () => {
  let repoDir: string

  beforeEach(() => {
    repoDir = makeGitRepo()
  })

  afterEach(() => {
    rmAll(repoDir)
  })

  it('returns false if no hook file exists', () => {
    expect(uninstallCommitHook(repoDir)).toBe(false)
  })

  it('returns false if hook exists but does not contain the codekin block', () => {
    const hookPath = join(repoDir, '.git', 'hooks', 'post-commit')
    writeFileSync(hookPath, '#!/bin/sh\necho "not codekin"\n')
    expect(uninstallCommitHook(repoDir)).toBe(false)
  })

  it('removes the entire hook file when only codekin block + shebang remain', () => {
    installCommitHook(repoDir)
    const hookPath = join(repoDir, '.git', 'hooks', 'post-commit')
    expect(existsSync(hookPath)).toBe(true)

    const result = uninstallCommitHook(repoDir)
    expect(result).toBe(true)
    expect(existsSync(hookPath)).toBe(false)
  })

  it('preserves user hook content and strips only the codekin block', () => {
    const hookPath = join(repoDir, '.git', 'hooks', 'post-commit')
    const userContent = '#!/bin/bash\n# User-defined hook\necho "user hook"\n'
    writeFileSync(hookPath, userContent)
    installCommitHook(repoDir)

    const result = uninstallCommitHook(repoDir)
    expect(result).toBe(true)
    expect(existsSync(hookPath)).toBe(true)

    const remaining = readFileSync(hookPath, 'utf-8')
    expect(remaining).toContain('# User-defined hook')
    expect(remaining).toContain('echo "user hook"')
    expect(remaining).not.toContain(BEGIN_MARKER)
    expect(remaining).not.toContain(END_MARKER)
  })
})

// ---------------------------------------------------------------------------
// syncCommitHooks
// ---------------------------------------------------------------------------

describe('syncCommitHooks', () => {
  let repoA: string
  let repoB: string

  beforeEach(() => {
    repoA = makeGitRepo()
    repoB = makeGitRepo()
    state.workflowConfig.reviewRepos = []
  })

  afterEach(() => {
    rmAll(repoA, repoB)
  })

  it('installs hooks for enabled commit-review repos', () => {
    state.workflowConfig.reviewRepos = [{
      id: 'a', name: 'RepoA', repoPath: repoA,
      cronExpression: 'event', enabled: true, kind: 'commit-review',
    }]

    syncCommitHooks()

    const hookPath = join(repoA, '.git', 'hooks', 'post-commit')
    expect(existsSync(hookPath)).toBe(true)
    expect(readFileSync(hookPath, 'utf-8')).toContain(BEGIN_MARKER)
  })

  it('does NOT install for disabled commit-review repos', () => {
    state.workflowConfig.reviewRepos = [{
      id: 'a', name: 'RepoA', repoPath: repoA,
      cronExpression: 'event', enabled: false, kind: 'commit-review',
    }]

    syncCommitHooks()

    const hookPath = join(repoA, '.git', 'hooks', 'post-commit')
    expect(existsSync(hookPath)).toBe(false)
  })

  it('does NOT install for non-commit-review kinds (e.g. code-review.daily)', () => {
    state.workflowConfig.reviewRepos = [{
      id: 'a', name: 'RepoA', repoPath: repoA,
      cronExpression: '0 6 * * *', enabled: true, kind: 'code-review.daily',
    }]

    syncCommitHooks()

    const hookPath = join(repoA, '.git', 'hooks', 'post-commit')
    expect(existsSync(hookPath)).toBe(false)
  })

  it('uninstalls hook when a repo switches away from commit-review', () => {
    // First pass: commit-review enabled → hook installed
    state.workflowConfig.reviewRepos = [{
      id: 'a', name: 'RepoA', repoPath: repoA,
      cronExpression: 'event', enabled: true, kind: 'commit-review',
    }]
    syncCommitHooks()
    const hookPath = join(repoA, '.git', 'hooks', 'post-commit')
    expect(existsSync(hookPath)).toBe(true)

    // Second pass: switched kind → sync should remove the hook
    state.workflowConfig.reviewRepos = [{
      id: 'a', name: 'RepoA', repoPath: repoA,
      cronExpression: '0 6 * * *', enabled: true, kind: 'code-review.daily',
    }]
    syncCommitHooks()
    expect(existsSync(hookPath)).toBe(false)
  })

  it('handles multiple repos — installing the enabled commit-review one only', () => {
    state.workflowConfig.reviewRepos = [
      { id: 'a', name: 'A', repoPath: repoA, cronExpression: 'event', enabled: true, kind: 'commit-review' },
      { id: 'b', name: 'B', repoPath: repoB, cronExpression: '0 6 * * *', enabled: true, kind: 'code-review.daily' },
    ]

    syncCommitHooks()

    expect(existsSync(join(repoA, '.git', 'hooks', 'post-commit'))).toBe(true)
    expect(existsSync(join(repoB, '.git', 'hooks', 'post-commit'))).toBe(false)
  })
})
