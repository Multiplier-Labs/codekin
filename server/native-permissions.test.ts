/** Tests for native-permissions — verifies permission read/write, tool-to-permission conversion, and allowedTools pattern generation; mocks fs to avoid disk I/O. */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// Hoist mock fns so they're available at module evaluation time
const mockExistsSync = vi.hoisted(() => vi.fn(() => false))
const mockMkdirSync = vi.hoisted(() => vi.fn())
const mockReadFileSync = vi.hoisted(() => vi.fn(() => '{}'))
const mockWriteFileSync = vi.hoisted(() => vi.fn())
const mockRenameSync = vi.hoisted(() => vi.fn())

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  return {
    ...actual,
    existsSync: (...args: any[]) => mockExistsSync(...args),
    mkdirSync: (...args: any[]) => mockMkdirSync(...args),
    readFileSync: (...args: any[]) => mockReadFileSync(...args),
    writeFileSync: (...args: any[]) => mockWriteFileSync(...args),
    renameSync: (...args: any[]) => mockRenameSync(...args),
  }
})

import {
  readNativePermissions,
  addNativePermission,
  removeNativePermission,
  toNativePermission,
  toAllowedToolsPatterns,
} from './native-permissions.js'

beforeEach(() => {
  vi.clearAllMocks()
  mockExistsSync.mockReturnValue(false)
  mockReadFileSync.mockReturnValue('{}')
})

// ─── toNativePermission (pure function, no mocks needed) ──────────────

describe('toNativePermission', () => {
  it('returns null for pre-approved file tools', () => {
    for (const tool of ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'NotebookEdit']) {
      expect(toNativePermission(tool, {})).toBeNull()
    }
  })

  it('returns Bash(command) for Bash with a command', () => {
    expect(toNativePermission('Bash', { command: 'npm run build' })).toBe('Bash(npm run build)')
  })

  it('returns null for Bash with empty command', () => {
    expect(toNativePermission('Bash', { command: '' })).toBeNull()
    expect(toNativePermission('Bash', { command: '   ' })).toBeNull()
  })

  it('returns null for Bash with missing command', () => {
    expect(toNativePermission('Bash', {})).toBeNull()
  })

  it('returns just the tool name for non-Bash tools', () => {
    expect(toNativePermission('WebFetch', { url: 'https://example.com' })).toBe('WebFetch')
  })
})

// ─── toAllowedToolsPatterns ───────────────────────────────────────────

describe('toAllowedToolsPatterns', () => {
  it('passes tools through directly', () => {
    const result = toAllowedToolsPatterns({ tools: ['WebFetch', 'TodoWrite'], commands: [], patterns: [] })
    expect(result).toEqual(['WebFetch', 'TodoWrite'])
  })

  it('excludes exact commands intentionally', () => {
    const result = toAllowedToolsPatterns({ tools: [], commands: ['npm run build', 'git status'], patterns: [] })
    expect(result).toEqual([])
  })

  it('converts wildcard patterns ending with " *" to Bash(prefix:*)', () => {
    const result = toAllowedToolsPatterns({ tools: [], commands: [], patterns: ['git diff *'] })
    expect(result).toEqual(['Bash(git diff:*)'])
  })

  it('converts non-wildcard patterns to Bash(pattern)', () => {
    const result = toAllowedToolsPatterns({ tools: [], commands: [], patterns: ['npm test'] })
    expect(result).toEqual(['Bash(npm test)'])
  })

  it('escapes parentheses and backslashes in patterns', () => {
    const result = toAllowedToolsPatterns({ tools: [], commands: [], patterns: ['echo $(whoami)'] })
    expect(result).toEqual(['Bash(echo $\\(whoami\\))'])
  })
})

// ─── readNativePermissions (needs fs mocks) ───────────────────────────

describe('readNativePermissions', () => {
  it('returns empty array when file does not exist', () => {
    mockExistsSync.mockReturnValue(false)
    expect(readNativePermissions('/repo')).toEqual([])
  })

  it('returns allow list when file exists', () => {
    mockExistsSync.mockReturnValue(true)
    mockReadFileSync.mockReturnValue(JSON.stringify({
      permissions: { allow: ['Bash(npm test)', 'WebFetch'] },
    }))
    expect(readNativePermissions('/repo')).toEqual(['Bash(npm test)', 'WebFetch'])
  })

  it('returns empty array on corrupted JSON', () => {
    mockExistsSync.mockReturnValue(true)
    mockReadFileSync.mockReturnValue('not valid json{{{')
    expect(readNativePermissions('/repo')).toEqual([])
  })
})

// ─── addNativePermission ──────────────────────────────────────────────

describe('addNativePermission', () => {
  it('creates file when it does not exist', async () => {
    mockExistsSync.mockReturnValue(false)

    await addNativePermission('/repo', 'WebFetch')

    expect(mockMkdirSync).toHaveBeenCalledWith('/repo/.claude', { recursive: true })
    expect(mockWriteFileSync).toHaveBeenCalledWith(
      '/repo/.claude/settings.local.json.tmp',
      expect.stringContaining('"WebFetch"'),
      { mode: 0o600 },
    )
    expect(mockRenameSync).toHaveBeenCalledWith(
      '/repo/.claude/settings.local.json.tmp',
      '/repo/.claude/settings.local.json',
    )
  })

  it('appends to existing allow list', async () => {
    mockExistsSync.mockReturnValue(true)
    mockReadFileSync.mockReturnValue(JSON.stringify({
      permissions: { allow: ['WebFetch'] },
    }))

    await addNativePermission('/repo', 'Bash(npm test)')

    const written = mockWriteFileSync.mock.calls[0][1] as string
    const parsed = JSON.parse(written)
    expect(parsed.permissions.allow).toEqual(['WebFetch', 'Bash(npm test)'])
  })

  it('does not add duplicates', async () => {
    mockExistsSync.mockReturnValue(true)
    mockReadFileSync.mockReturnValue(JSON.stringify({
      permissions: { allow: ['WebFetch'] },
    }))

    await addNativePermission('/repo', 'WebFetch')

    expect(mockWriteFileSync).not.toHaveBeenCalled()
    expect(mockRenameSync).not.toHaveBeenCalled()
  })
})

// ─── removeNativePermission ───────────────────────────────────────────

describe('removeNativePermission', () => {
  it('removes an existing permission', async () => {
    mockExistsSync.mockReturnValue(true)
    mockReadFileSync.mockReturnValue(JSON.stringify({
      permissions: { allow: ['WebFetch', 'Bash(npm test)'] },
    }))

    await removeNativePermission('/repo', 'WebFetch')

    const written = mockWriteFileSync.mock.calls[0][1] as string
    const parsed = JSON.parse(written)
    expect(parsed.permissions.allow).toEqual(['Bash(npm test)'])
  })

  it('is a no-op when file does not exist', async () => {
    mockExistsSync.mockReturnValue(false)

    await removeNativePermission('/repo', 'WebFetch')

    expect(mockWriteFileSync).not.toHaveBeenCalled()
    expect(mockRenameSync).not.toHaveBeenCalled()
  })

  it('is a no-op when permission is not in the list', async () => {
    mockExistsSync.mockReturnValue(true)
    mockReadFileSync.mockReturnValue(JSON.stringify({
      permissions: { allow: ['Bash(npm test)'] },
    }))

    await removeNativePermission('/repo', 'WebFetch')

    expect(mockWriteFileSync).not.toHaveBeenCalled()
    expect(mockRenameSync).not.toHaveBeenCalled()
  })
})
