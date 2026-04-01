/** Tests for DiffManager — verifies git env cleaning, file status parsing, diff retrieval, and discard operations; mocks child_process, fs, and diff-parser to avoid real disk and git side-effects. */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// ---------------------------------------------------------------------------
// Hoisted mock functions
// ---------------------------------------------------------------------------
const mockExecFile = vi.hoisted(() => vi.fn())
const mockStat = vi.hoisted(() => vi.fn())
const mockReadFile = vi.hoisted(() => vi.fn())
const mockUnlink = vi.hoisted(() => vi.fn())
const mockParseDiff = vi.hoisted(() => vi.fn())
const mockCreateUntrackedFileDiff = vi.hoisted(() => vi.fn())

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>()
  return {
    ...actual,
    execFile: (...args: any[]) => mockExecFile(...args),
  }
})

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  return {
    ...actual,
    promises: {
      ...actual.promises,
      stat: (...args: any[]) => mockStat(...args),
      readFile: (...args: any[]) => mockReadFile(...args),
      unlink: (...args: any[]) => mockUnlink(...args),
    },
  }
})

vi.mock('./diff-parser.js', () => ({
  parseDiff: (...args: any[]) => mockParseDiff(...args),
  createUntrackedFileDiff: (...args: any[]) => mockCreateUntrackedFileDiff(...args),
}))

// ---------------------------------------------------------------------------
// Imports (must come after vi.mock calls)
// ---------------------------------------------------------------------------
import { cleanGitEnv, execGit, execGitChunked, getFileStatuses, DiffManager } from './diff-manager.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Make mockExecFile invoke its callback with the given stdout. */
function stubExecFile(stdout: string, stderr = '') {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
  mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
    cb(null, { stdout, stderr })
  })
}

/** Make mockExecFile invoke its callback with an error. */
function stubExecFileError(message: string) {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
  mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
    cb(new Error(message), { stdout: '', stderr: '' })
  })
}

/**
 * Set up sequential execFile responses keyed by a substring in the args array.
 * Falls through to a default if no pattern matches.
 */
function stubExecFileByArgs(mapping: Record<string, string | Error>) {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
  mockExecFile.mockImplementation((_cmd: string, args: string[], _opts: unknown, cb: Function) => {
    const argStr = args.join(' ')
    for (const [pattern, result] of Object.entries(mapping)) {
      if (argStr.includes(pattern)) {
        if (result instanceof Error) {
          cb(result, { stdout: '', stderr: '' })
        } else {
          cb(null, { stdout: result, stderr: '' })
        }
        return
      }
    }
    // Default: empty stdout
    cb(null, { stdout: '', stderr: '' })
  })
}

beforeEach(() => {
  vi.restoreAllMocks()
  mockExecFile.mockReset()
  mockStat.mockReset()
  mockReadFile.mockReset()
  mockUnlink.mockReset()
  mockParseDiff.mockReset()
  mockCreateUntrackedFileDiff.mockReset()
})

// ===========================================================================
// cleanGitEnv
// ===========================================================================
describe('cleanGitEnv', () => {
  const origEnv = process.env

  afterEach(() => {
    process.env = origEnv
  })

  it('removes GIT_INDEX_FILE, GIT_DIR, GIT_PREFIX from env', () => {
    process.env = {
      ...origEnv,
      GIT_INDEX_FILE: '/tmp/index',
      GIT_DIR: '/tmp/.git',
      GIT_PREFIX: 'sub/',
      HOME: '/home/user',
    }
    const env = cleanGitEnv()
    expect(env).not.toHaveProperty('GIT_INDEX_FILE')
    expect(env).not.toHaveProperty('GIT_DIR')
    expect(env).not.toHaveProperty('GIT_PREFIX')
  })

  it('preserves GIT_EDITOR', () => {
    process.env = {
      ...origEnv,
      GIT_EDITOR: 'vim',
      GIT_DIR: '/tmp/.git',
    }
    const env = cleanGitEnv()
    expect(env.GIT_EDITOR).toBe('vim')
    expect(env).not.toHaveProperty('GIT_DIR')
  })

  it('preserves non-GIT vars', () => {
    process.env = {
      HOME: '/home/user',
      PATH: '/usr/bin',
      GIT_DIR: '/tmp/.git',
    }
    const env = cleanGitEnv()
    expect(env.HOME).toBe('/home/user')
    expect(env.PATH).toBe('/usr/bin')
  })
})

// ===========================================================================
// execGit
// ===========================================================================
describe('execGit', () => {
  it('returns stdout from git command', async () => {
    stubExecFile('main\n')
    const result = await execGit(['rev-parse', '--abbrev-ref', 'HEAD'], '/repo')
    expect(result).toBe('main\n')
    expect(mockExecFile).toHaveBeenCalledOnce()
    // Verify first two args are 'git' and the args array
    expect(mockExecFile.mock.calls[0][0]).toBe('git')
    expect(mockExecFile.mock.calls[0][1]).toEqual(['rev-parse', '--abbrev-ref', 'HEAD'])
  })

  it('rejects on git error', async () => {
    stubExecFileError('fatal: not a git repository')
    await expect(execGit(['status'], '/not-a-repo')).rejects.toThrow('fatal: not a git repository')
  })
})

// ===========================================================================
// execGitChunked
// ===========================================================================
describe('execGitChunked', () => {
  it('concatenates output from multiple chunks', async () => {
    // Create 250 paths to force 2 chunks (chunk size is 200)
    const paths = Array.from({ length: 250 }, (_, i) => `file${i}.ts`)
    let callCount = 0
    // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
  mockExecFile.mockImplementation((_cmd: string, args: string[], _opts: unknown, cb: Function) => {
      callCount++
      cb(null, { stdout: `chunk${callCount}\n`, stderr: '' })
    })
    const result = await execGitChunked(['diff'], paths, '/repo')
    expect(result).toBe('chunk1\nchunk2\n')
    expect(callCount).toBe(2)
  })
})

// ===========================================================================
// getFileStatuses
// ===========================================================================
describe('getFileStatuses', () => {
  it('parses modified file status', async () => {
    // git status --porcelain -z: " M src/app.ts\0"
    stubExecFile(' M src/app.ts\0')
    const result = await getFileStatuses('/repo')
    expect(result['src/app.ts']).toBe('modified')
  })

  it('parses untracked (??) as added', async () => {
    stubExecFile('?? newfile.ts\0')
    const result = await getFileStatuses('/repo')
    expect(result['newfile.ts']).toBe('added')
  })

  it('parses deleted files', async () => {
    stubExecFile(' D removed.ts\0')
    const result = await getFileStatuses('/repo')
    expect(result['removed.ts']).toBe('deleted')
  })

  it('parses renamed files (R status has two paths)', async () => {
    // Renamed: "R  old.ts\0new.ts\0"
    stubExecFile('R  old.ts\0new.ts\0')
    const result = await getFileStatuses('/repo')
    expect(result['new.ts']).toBe('renamed')
    expect(result).not.toHaveProperty('old.ts')
  })

  it('parses staged added files (A status)', async () => {
    stubExecFile('A  staged-new.ts\0')
    const result = await getFileStatuses('/repo')
    expect(result['staged-new.ts']).toBe('added')
  })

  it('handles empty output', async () => {
    stubExecFile('')
    const result = await getFileStatuses('/repo')
    expect(result).toEqual({})
  })

  it('passes paths to git status when provided', async () => {
    stubExecFile(' M foo.ts\0')
    await getFileStatuses('/repo', ['foo.ts'])
    const args = mockExecFile.mock.calls[0][1] as string[]
    expect(args).toContain('--')
    expect(args).toContain('foo.ts')
  })
})

// ===========================================================================
// DiffManager.getDiff
// ===========================================================================
describe('DiffManager.getDiff', () => {
  let dm: DiffManager

  beforeEach(() => {
    dm = new DiffManager()
    mockParseDiff.mockReturnValue({ files: [], truncated: false })
  })

  it('returns diff_result with branch, files, summary for scope=all', async () => {
    stubExecFileByArgs({
      'rev-parse --abbrev-ref': 'main\n',
      'diff --find-renames': 'diff output',
      'ls-files --others': '',
    })
    mockParseDiff.mockReturnValue({
      files: [{ path: 'a.ts', status: 'modified', isBinary: false, additions: 3, deletions: 1, hunks: [] }],
      truncated: false,
    })

    const result = await dm.getDiff('/repo', 'all') as any
    expect(result.type).toBe('diff_result')
    expect(result.branch).toBe('main')
    expect(result.scope).toBe('all')
    expect(result.files).toHaveLength(1)
    expect(result.summary.filesChanged).toBe(1)
    expect(result.summary.insertions).toBe(3)
    expect(result.summary.deletions).toBe(1)
  })

  it('uses --cached flag for scope=staged', async () => {
    stubExecFileByArgs({
      'rev-parse --abbrev-ref': 'feat/x\n',
      'diff --find-renames': 'cached diff',
      'ls-files --others': '',
    })
    mockParseDiff.mockReturnValue({ files: [], truncated: false })

    await dm.getDiff('/repo', 'staged')

    // Verify that --cached was passed to git diff
    const diffCall = mockExecFile.mock.calls.find((c: any[]) =>
      c[1].includes('diff') && c[1].includes('--cached')
    )
    expect(diffCall).toBeDefined()
  })

  it('does not discover untracked files for staged scope', async () => {
    stubExecFileByArgs({
      'rev-parse --abbrev-ref': 'main\n',
      'diff --find-renames': '',
    })
    mockParseDiff.mockReturnValue({ files: [], truncated: false })

    await dm.getDiff('/repo', 'staged')

    // ls-files --others should NOT be called for staged scope
    const lsFilesCall = mockExecFile.mock.calls.find((c: any[]) =>
      c[1].includes('ls-files') && c[1].includes('--others')
    )
    expect(lsFilesCall).toBeUndefined()
  })

  it('falls back when git diff HEAD fails (no HEAD commit)', async () => {
    stubExecFileByArgs({
      'rev-parse --abbrev-ref': 'main\n',
      'diff --find-renames --no-color --unified=3 HEAD': new Error('bad revision HEAD'),
      'diff --cached': 'staged diff\n',
      // plain diff (unstaged) falls through to default ''
      'ls-files --others': '',
    })
    // First call for HEAD fails, parseDiff is called with fallback combined output
    mockParseDiff.mockReturnValue({ files: [], truncated: false })

    const result = await dm.getDiff('/repo', 'all') as any
    expect(result.type).toBe('diff_result')
    // parseDiff should have been called with the fallback output
    expect(mockParseDiff).toHaveBeenCalled()
  })

  it('discovers untracked files for unstaged scope', async () => {
    stubExecFileByArgs({
      'rev-parse --abbrev-ref': 'main\n',
      'diff --find-renames': '',
      'ls-files --others': 'newfile.ts\n',
    })
    mockParseDiff.mockReturnValue({ files: [], truncated: false })
    mockStat.mockResolvedValue({ size: 100 })
    mockReadFile.mockResolvedValue('const x = 1\n')
    mockCreateUntrackedFileDiff.mockReturnValue({
      path: 'newfile.ts',
      status: 'added',
      isBinary: false,
      additions: 1,
      deletions: 0,
      hunks: [],
    })

    const result = await dm.getDiff('/repo', 'unstaged') as any
    expect(result.type).toBe('diff_result')
    expect(result.files).toHaveLength(1)
    expect(result.files[0].path).toBe('newfile.ts')
    expect(mockCreateUntrackedFileDiff).toHaveBeenCalledWith('newfile.ts', 'const x = 1\n')
  })

  it('skips large untracked files (>1MB) marking them as binary', async () => {
    stubExecFileByArgs({
      'rev-parse --abbrev-ref': 'main\n',
      'diff --find-renames': '',
      'ls-files --others': 'huge.bin\n',
    })
    mockParseDiff.mockReturnValue({ files: [], truncated: false })
    mockStat.mockResolvedValue({ size: 2 * 1024 * 1024 }) // 2 MB

    const result = await dm.getDiff('/repo', 'all') as any
    expect(result.type).toBe('diff_result')
    expect(result.files).toHaveLength(1)
    expect(result.files[0].path).toBe('huge.bin')
    expect(result.files[0].isBinary).toBe(true)
    expect(result.files[0].additions).toBe(0)
    // readFile should NOT have been called for the large file
    expect(mockReadFile).not.toHaveBeenCalled()
  })

  it('returns diff_error on general failure', async () => {
    // Make all git calls succeed but parseDiff throw to trigger the outer catch
    stubExecFileByArgs({
      'rev-parse --abbrev-ref': 'main\n',
      'diff --find-renames': 'some diff',
    })
    mockParseDiff.mockImplementation(() => { throw new Error('fatal: something broke') })

    const result = await dm.getDiff('/repo') as any
    expect(result.type).toBe('diff_error')
    expect(result.message).toContain('fatal: something broke')
  })

  it('sets branch to "unknown" when rev-parse fails', async () => {
    stubExecFileByArgs({
      'rev-parse': new Error('not a repo'),
      'diff --find-renames': '',
      'ls-files --others': '',
    })
    mockParseDiff.mockReturnValue({ files: [], truncated: false })

    const result = await dm.getDiff('/repo') as any
    expect(result.type).toBe('diff_result')
    expect(result.branch).toBe('unknown')
  })

  it('handles detached HEAD state', async () => {
    stubExecFileByArgs({
      'rev-parse --abbrev-ref HEAD': 'HEAD\n',
      'rev-parse --short HEAD': 'abc1234\n',
      'diff --find-renames': '',
      'ls-files --others': '',
    })
    mockParseDiff.mockReturnValue({ files: [], truncated: false })

    const result = await dm.getDiff('/repo') as any
    expect(result.type).toBe('diff_result')
    expect(result.branch).toBe('detached at abc1234')
  })
})

// ===========================================================================
// DiffManager.discardChanges
// ===========================================================================
describe('DiffManager.discardChanges', () => {
  let dm: DiffManager

  beforeEach(() => {
    dm = new DiffManager()
    mockParseDiff.mockReturnValue({ files: [], truncated: false })
  })

  it('rejects paths with ".." (path traversal)', async () => {
    const result = await dm.discardChanges('/repo', 'all', ['../etc/passwd']) as any
    expect(result.type).toBe('diff_error')
    expect(result.message).toContain('Invalid path')
  })

  it('rejects absolute paths', async () => {
    const result = await dm.discardChanges('/repo', 'all', ['/etc/passwd']) as any
    expect(result.type).toBe('diff_error')
    expect(result.message).toContain('Invalid path')
  })

  it('uses git restore --staged --worktree for scope=all with tracked files', async () => {
    stubExecFileByArgs({
      'status --porcelain': ' M src/app.ts\0',
      'restore': '',
      'rev-parse --abbrev-ref': 'main\n',
      'diff --find-renames': '',
      'ls-files --others': '',
    })

    await dm.discardChanges('/repo', 'all', ['src/app.ts'], { 'src/app.ts': 'modified' })

    const restoreCall = mockExecFile.mock.calls.find((c: any[]) =>
      c[1].includes('restore')
    )
    expect(restoreCall).toBeDefined()
    const restoreArgs = restoreCall![1] as string[]
    expect(restoreArgs).toContain('--staged')
    expect(restoreArgs).toContain('--worktree')
    expect(restoreArgs).toContain('src/app.ts')
  })

  it('uses git restore --staged for scope=staged with tracked files', async () => {
    stubExecFileByArgs({
      'restore': '',
      'rev-parse --abbrev-ref': 'main\n',
      'diff --find-renames': '',
    })

    await dm.discardChanges('/repo', 'staged', ['src/app.ts'], { 'src/app.ts': 'modified' })

    const restoreCall = mockExecFile.mock.calls.find((c: any[]) =>
      c[1].includes('restore')
    )
    expect(restoreCall).toBeDefined()
    const restoreArgs = restoreCall![1] as string[]
    expect(restoreArgs).toContain('--staged')
    expect(restoreArgs).not.toContain('--worktree')
  })

  it('deletes untracked files for scope != staged', async () => {
    stubExecFileByArgs({
      'ls-files --stage': '',       // empty = untracked
      'rev-parse --abbrev-ref': 'main\n',
      'diff --find-renames': '',
      'ls-files --others': '',
    })
    mockUnlink.mockResolvedValue(undefined)

    await dm.discardChanges('/repo', 'all', ['newfile.ts'], { 'newfile.ts': 'added' })

    expect(mockUnlink).toHaveBeenCalledWith(expect.stringContaining('newfile.ts'))
  })

  it('does not delete untracked files for scope=staged', async () => {
    stubExecFileByArgs({
      'ls-files --stage': '',       // empty = untracked
      'rev-parse --abbrev-ref': 'main\n',
      'diff --find-renames': '',
    })
    mockUnlink.mockResolvedValue(undefined)

    await dm.discardChanges('/repo', 'staged', ['newfile.ts'], { 'newfile.ts': 'added' })

    expect(mockUnlink).not.toHaveBeenCalled()
  })

  it('handles staged new files with git rm --cached', async () => {
    stubExecFileByArgs({
      'ls-files --stage -- staged-new.ts': '100644 abc123 0\tstaged-new.ts\n',
      'rm --cached': '',
      'rev-parse --abbrev-ref': 'main\n',
      'diff --find-renames': '',
    })

    await dm.discardChanges('/repo', 'staged', ['staged-new.ts'], { 'staged-new.ts': 'added' })

    const rmCall = mockExecFile.mock.calls.find((c: any[]) =>
      c[1].includes('rm') && c[1].includes('--cached')
    )
    expect(rmCall).toBeDefined()
  })

  it('handles staged new files with rm --cached and unlink for scope=all', async () => {
    stubExecFileByArgs({
      'ls-files --stage -- staged-new.ts': '100644 abc123 0\tstaged-new.ts\n',
      'rm --cached': '',
      'rev-parse --abbrev-ref': 'main\n',
      'diff --find-renames': '',
      'ls-files --others': '',
    })
    mockUnlink.mockResolvedValue(undefined)

    await dm.discardChanges('/repo', 'all', ['staged-new.ts'], { 'staged-new.ts': 'added' })

    const rmCall = mockExecFile.mock.calls.find((c: any[]) =>
      c[1].includes('rm') && c[1].includes('--cached')
    )
    expect(rmCall).toBeDefined()
    expect(mockUnlink).toHaveBeenCalledWith(expect.stringContaining('staged-new.ts'))
  })

  it('returns fresh diff after discard', async () => {
    stubExecFileByArgs({
      'restore': '',
      'rev-parse --abbrev-ref': 'main\n',
      'diff --find-renames': '',
      'ls-files --others': '',
    })
    mockParseDiff.mockReturnValue({
      files: [],
      truncated: false,
    })

    const result = await dm.discardChanges('/repo', 'all', ['a.ts'], { 'a.ts': 'modified' }) as any
    // The result should be a fresh diff_result from getDiff
    expect(result.type).toBe('diff_result')
    expect(result.scope).toBe('all')
  })

  it('fetches file statuses when not provided', async () => {
    stubExecFileByArgs({
      'status --porcelain': ' M auto.ts\0',
      'restore': '',
      'rev-parse --abbrev-ref': 'main\n',
      'diff --find-renames': '',
      'ls-files --others': '',
    })

    await dm.discardChanges('/repo', 'all', ['auto.ts'])

    // status --porcelain should have been called to discover statuses
    const statusCall = mockExecFile.mock.calls.find((c: any[]) =>
      c[1].includes('status') && c[1].includes('--porcelain')
    )
    expect(statusCall).toBeDefined()
  })
})
