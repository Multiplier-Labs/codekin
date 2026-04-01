/** Tests for orchestrator-manager — verifies directory setup, stable ID persistence, session detection, and orchestrator lifecycle management; mocks fs, crypto, and config. */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockExistsSync = vi.hoisted(() => vi.fn(() => false))
const mockMkdirSync = vi.hoisted(() => vi.fn())
const mockReadFileSync = vi.hoisted(() => vi.fn(() => ''))
const mockWriteFileSync = vi.hoisted(() => vi.fn())
const mockRandomUUID = vi.hoisted(() => vi.fn(() => 'test-uuid-1234'))

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  return {
    ...actual,
    existsSync: mockExistsSync,
    mkdirSync: mockMkdirSync,
    readFileSync: mockReadFileSync,
    writeFileSync: mockWriteFileSync,
  }
})

vi.mock('crypto', () => ({ randomUUID: mockRandomUUID }))

vi.mock('./config.js', () => ({
  DATA_DIR: '/tmp/test-data',
  AGENT_DISPLAY_NAME: 'TestAgent',
  getAgentDisplayName: () => 'TestAgent',
}))

import {
  ORCHESTRATOR_DIR,
  ensureOrchestratorDir,
  getOrCreateOrchestratorId,
  isOrchestratorSession,
  ensureOrchestratorRunning,
  getOrchestratorSessionId,
} from './orchestrator-manager.js'

function fakeSessionManager(existingSession?: any) {
  return {
    get: vi.fn((id: string) => existingSession && existingSession.id === id ? existingSession : undefined),
    create: vi.fn((_name: string, _dir: string, opts?: any) => ({ id: opts?.id ?? 'new-id', ...opts })),
    startClaude: vi.fn(),
    persistToDisk: vi.fn(),
  } as any
}

beforeEach(() => {
  vi.clearAllMocks()
  mockExistsSync.mockReturnValue(false)
  mockReadFileSync.mockReturnValue('')
})

describe('ORCHESTRATOR_DIR', () => {
  it('is derived from DATA_DIR', () => {
    expect(ORCHESTRATOR_DIR).toBe('/tmp/test-data/orchestrator')
  })
})

describe('isOrchestratorSession', () => {
  it('returns true for "orchestrator"', () => {
    expect(isOrchestratorSession('orchestrator')).toBe(true)
  })

  it('returns false for "workflow"', () => {
    expect(isOrchestratorSession('workflow')).toBe(false)
  })

  it('returns false for undefined', () => {
    expect(isOrchestratorSession(undefined)).toBe(false)
  })

  it('returns false for other strings', () => {
    expect(isOrchestratorSession('manual')).toBe(false)
    expect(isOrchestratorSession('')).toBe(false)
  })
})

describe('ensureOrchestratorDir', () => {
  it('creates directories when they do not exist', () => {
    mockExistsSync.mockReturnValue(false)

    ensureOrchestratorDir()

    expect(mockMkdirSync).toHaveBeenCalledWith('/tmp/test-data/orchestrator', { recursive: true })
    expect(mockMkdirSync).toHaveBeenCalledWith('/tmp/test-data/orchestrator/journal', { recursive: true })
  })

  it('writes seed files when they do not exist', () => {
    mockExistsSync.mockReturnValue(false)

    ensureOrchestratorDir()

    const writtenPaths = mockWriteFileSync.mock.calls.map((c: any[]) => c[0])
    expect(writtenPaths).toContain('/tmp/test-data/orchestrator/PROFILE.md')
    expect(writtenPaths).toContain('/tmp/test-data/orchestrator/REPOS.md')
    expect(writtenPaths).toContain('/tmp/test-data/orchestrator/CLAUDE.md')
    expect(mockWriteFileSync).toHaveBeenCalledTimes(3)
  })

  it('does not overwrite existing files', () => {
    // All paths exist
    mockExistsSync.mockReturnValue(true)

    ensureOrchestratorDir()

    expect(mockMkdirSync).not.toHaveBeenCalled()
    expect(mockWriteFileSync).not.toHaveBeenCalled()
  })
})

describe('getOrCreateOrchestratorId', () => {
  it('returns existing ID from file', () => {
    mockExistsSync.mockReturnValue(true)
    mockReadFileSync.mockReturnValue('existing-uuid-5678')

    const id = getOrCreateOrchestratorId()

    expect(id).toBe('existing-uuid-5678')
    expect(mockWriteFileSync).not.toHaveBeenCalled()
    expect(mockRandomUUID).not.toHaveBeenCalled()
  })

  it('creates new UUID when file does not exist', () => {
    mockExistsSync.mockReturnValue(false)

    const id = getOrCreateOrchestratorId()

    expect(id).toBe('test-uuid-1234')
    expect(mockRandomUUID).toHaveBeenCalled()
    expect(mockWriteFileSync).toHaveBeenCalledWith(
      '/tmp/test-data/orchestrator/.session-id',
      'test-uuid-1234',
      'utf-8',
    )
  })

  it('creates new UUID when file is empty', () => {
    mockExistsSync.mockReturnValue(true)
    mockReadFileSync.mockReturnValue('   \n')

    const id = getOrCreateOrchestratorId()

    expect(id).toBe('test-uuid-1234')
    expect(mockRandomUUID).toHaveBeenCalled()
    expect(mockWriteFileSync).toHaveBeenCalledWith(
      '/tmp/test-data/orchestrator/.session-id',
      'test-uuid-1234',
      'utf-8',
    )
  })
})

describe('ensureOrchestratorRunning', () => {
  it('creates new session when none exists', () => {
    // existsSync: false for dirs/files (ensureOrchestratorDir) and false for session-id file
    mockExistsSync.mockReturnValue(false)

    const sm = fakeSessionManager()
    const id = ensureOrchestratorRunning(sm)

    expect(id).toBe('test-uuid-1234')
    expect(sm.create).toHaveBeenCalledWith(
      'Agent TestAgent',
      '/tmp/test-data/orchestrator',
      expect.objectContaining({
        source: 'orchestrator',
        id: 'test-uuid-1234',
        permissionMode: 'acceptEdits',
        allowedTools: ['Bash(curl:*)', 'CronCreate', 'CronDelete', 'CronList'],
      }),
    )
    expect(sm.startClaude).toHaveBeenCalledWith('test-uuid-1234')
  })

  it('restarts Claude when session exists but process not alive', () => {
    // Make the session-id file exist with our stable ID
    mockExistsSync.mockImplementation((p: string) =>
      typeof p === 'string' && p.endsWith('.session-id') ? true : false,
    )
    mockReadFileSync.mockReturnValue('test-uuid-1234')

    const session = {
      id: 'test-uuid-1234',
      allowedTools: ['Bash(curl:*)', 'CronCreate', 'CronDelete', 'CronList'],
      claudeProcess: { isAlive: () => false },
    }
    const sm = fakeSessionManager(session)
    const id = ensureOrchestratorRunning(sm)

    expect(id).toBe('test-uuid-1234')
    expect(sm.create).not.toHaveBeenCalled()
    expect(sm.startClaude).toHaveBeenCalledWith('test-uuid-1234')
  })

  it('updates allowedTools when session exists but tools missing', () => {
    mockExistsSync.mockImplementation((p: string) =>
      typeof p === 'string' && p.endsWith('.session-id') ? true : false,
    )
    mockReadFileSync.mockReturnValue('test-uuid-1234')

    const session = {
      id: 'test-uuid-1234',
      allowedTools: [],
      claudeProcess: { isAlive: () => true },
    }
    const sm = fakeSessionManager(session)
    ensureOrchestratorRunning(sm)

    expect(session.allowedTools).toEqual(['Bash(curl:*)', 'CronCreate', 'CronDelete', 'CronList'])
    expect(sm.persistToDisk).toHaveBeenCalled()
  })

  it('returns stable ID in all cases', () => {
    mockExistsSync.mockReturnValue(false)

    // Case 1: new session
    const sm1 = fakeSessionManager()
    expect(ensureOrchestratorRunning(sm1)).toBe('test-uuid-1234')

    // Case 2: existing session, alive
    mockExistsSync.mockImplementation((p: string) =>
      typeof p === 'string' && p.endsWith('.session-id') ? true : false,
    )
    mockReadFileSync.mockReturnValue('test-uuid-1234')

    const session = {
      id: 'test-uuid-1234',
      allowedTools: ['Bash(curl:*)'],
      claudeProcess: { isAlive: () => true },
    }
    const sm2 = fakeSessionManager(session)
    expect(ensureOrchestratorRunning(sm2)).toBe('test-uuid-1234')
  })
})

describe('getOrchestratorSessionId', () => {
  it('returns null when no ID file exists', () => {
    mockExistsSync.mockReturnValue(false)

    const sm = fakeSessionManager()
    expect(getOrchestratorSessionId(sm)).toBeNull()
  })

  it('returns null when session does not exist in manager', () => {
    mockExistsSync.mockReturnValue(true)
    mockReadFileSync.mockReturnValue('orphaned-uuid')

    // fakeSessionManager with no matching session
    const sm = fakeSessionManager()
    expect(getOrchestratorSessionId(sm)).toBeNull()
  })

  it('returns ID when session exists', () => {
    mockExistsSync.mockReturnValue(true)
    mockReadFileSync.mockReturnValue('existing-uuid')

    const session = { id: 'existing-uuid' }
    const sm = fakeSessionManager(session)
    expect(getOrchestratorSessionId(sm)).toBe('existing-uuid')
  })
})
