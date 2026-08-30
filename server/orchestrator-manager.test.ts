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

vi.mock('./anthropic-models.js', () => ({
  getDefaultClaudeModel: () => 'claude-latest-test',
}))

import {
  ORCHESTRATOR_DIR,
  ensureOrchestratorDir,
  getOrCreateOrchestratorId,
  isOrchestratorSession,
  ensureOrchestratorRunning,
  ensureOrchestratorMcpConfig,
  getOrchestratorSessionId,
  getOrchestratorModel,
  setOrchestratorModel,
  getOrchestratorProvider,
  setOrchestratorProvider,
  readTemplateVersion,
  CLAUDE_MD_TEMPLATE_VERSION,
  ORCHESTRATOR_ALLOWED_TOOLS,
} from './orchestrator-manager.js'

function fakeSessionManager(existingSession?: any, settings: Record<string, string> = {}) {
  return {
    get: vi.fn((id: string) => existingSession && existingSession.id === id ? existingSession : undefined),
    create: vi.fn((_name: string, _dir: string, opts?: any) => ({ id: opts?.id ?? 'new-id', ...opts })),
    startClaude: vi.fn(),
    persistToDisk: vi.fn(),
    archive: {
      getSetting: vi.fn((key: string, fallback = '') => settings[key] ?? fallback),
      setSetting: vi.fn((key: string, value: string) => { settings[key] = value }),
    },
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
    // AGENTS.md carries the same instructions for harnesses that read it
    // (Codex, OpenCode) — the orchestrator is agent-agnostic.
    expect(writtenPaths).toContain('/tmp/test-data/orchestrator/AGENTS.md')
    expect(mockWriteFileSync).toHaveBeenCalledTimes(4)
  })

  it('leaves seed files and a current CLAUDE.md alone (only the system-managed .mcp.json is rewritten)', () => {
    // All paths exist and CLAUDE.md carries the current template version
    mockExistsSync.mockReturnValue(true)
    mockReadFileSync.mockReturnValue(
      `<!-- codekin-template-version: ${CLAUDE_MD_TEMPLATE_VERSION} -->\n# custom`,
    )

    ensureOrchestratorDir()

    expect(mockMkdirSync).not.toHaveBeenCalled()
    const writtenPaths = mockWriteFileSync.mock.calls.map((c: any[]) => c[0])
    expect(writtenPaths).toEqual(['/tmp/test-data/orchestrator/.mcp.json'])
  })

  it('refreshes CLAUDE.md and AGENTS.md when their template version is stale, leaving seed files alone', () => {
    mockExistsSync.mockReturnValue(true)
    // Unstamped (pre-versioning) instruction files → version 0 → stale
    mockReadFileSync.mockReturnValue('# Agent — old template without a stamp')

    ensureOrchestratorDir()

    const writtenPaths = mockWriteFileSync.mock.calls.map((c: any[]) => c[0])
    expect(writtenPaths).toEqual([
      '/tmp/test-data/orchestrator/CLAUDE.md',
      '/tmp/test-data/orchestrator/AGENTS.md',
      '/tmp/test-data/orchestrator/.mcp.json',
    ])
    const written = mockWriteFileSync.mock.calls[0][1] as string
    expect(written).toContain(`<!-- codekin-template-version: ${CLAUDE_MD_TEMPLATE_VERSION} -->`)
  })
})

describe('readTemplateVersion', () => {
  it('returns 0 when the file does not exist', () => {
    mockExistsSync.mockReturnValue(false)
    expect(readTemplateVersion('/tmp/none/CLAUDE.md')).toBe(0)
  })

  it('returns 0 when the file has no version stamp', () => {
    mockExistsSync.mockReturnValue(true)
    mockReadFileSync.mockReturnValue('# no stamp here')
    expect(readTemplateVersion('/tmp/x/CLAUDE.md')).toBe(0)
  })

  it('parses the stamped version', () => {
    mockExistsSync.mockReturnValue(true)
    mockReadFileSync.mockReturnValue('<!-- codekin-template-version: 7 -->\n# hi')
    expect(readTemplateVersion('/tmp/x/CLAUDE.md')).toBe(7)
  })

  it('returns 0 when reading throws', () => {
    mockExistsSync.mockReturnValue(true)
    mockReadFileSync.mockImplementation(() => { throw new Error('EACCES') })
    expect(readTemplateVersion('/tmp/x/CLAUDE.md')).toBe(0)
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
        allowedTools: ORCHESTRATOR_ALLOWED_TOOLS,
        model: 'claude-latest-test',
      }),
    )
    expect(sm.startClaude).toHaveBeenCalledWith('test-uuid-1234')
  })

  it('creates the session with the stored model when one was chosen', () => {
    mockExistsSync.mockReturnValue(false)

    const sm = fakeSessionManager(undefined, { agent_model: 'claude-sonnet-5' })
    ensureOrchestratorRunning(sm)

    expect(sm.create).toHaveBeenCalledWith(
      'Agent TestAgent',
      '/tmp/test-data/orchestrator',
      expect.objectContaining({ model: 'claude-sonnet-5' }),
    )
  })

  it('adopts the stored model when restarting a stopped session', () => {
    mockExistsSync.mockImplementation((p: string) =>
      typeof p === 'string' && p.endsWith('.session-id') ? true : false,
    )
    mockReadFileSync.mockReturnValue('test-uuid-1234')

    const session = {
      id: 'test-uuid-1234',
      model: 'claude-opus-4-7',
      allowedTools: ['Bash(curl:*)', 'CronCreate', 'CronDelete', 'CronList'],
      claudeProcess: { isAlive: () => false },
    }
    const sm = fakeSessionManager(session, { agent_model: 'claude-sonnet-5' })
    ensureOrchestratorRunning(sm)

    expect(session.model).toBe('claude-sonnet-5')
    expect(sm.persistToDisk).toHaveBeenCalled()
    expect(sm.startClaude).toHaveBeenCalledWith('test-uuid-1234')
  })

  it('creates the session on the stored harness, with no Claude model override', () => {
    mockExistsSync.mockReturnValue(false)

    const sm = fakeSessionManager(undefined, { agent_provider: 'codex' })
    ensureOrchestratorRunning(sm)

    expect(sm.create).toHaveBeenCalledWith(
      'Agent TestAgent',
      '/tmp/test-data/orchestrator',
      expect.objectContaining({ provider: 'codex', model: undefined }),
    )
  })

  it('adopts the stored harness when restarting a stopped session and drops the old transcript link', () => {
    mockExistsSync.mockImplementation((p: string) =>
      typeof p === 'string' && p.endsWith('.session-id') ? true : false,
    )
    mockReadFileSync.mockReturnValue('test-uuid-1234')

    const session = {
      id: 'test-uuid-1234',
      model: 'claude-opus-4-7',
      provider: 'claude',
      claudeSessionId: 'old-claude-jsonl',
      allowedTools: ['Bash(curl:*)', 'CronCreate', 'CronDelete', 'CronList'],
      claudeProcess: { isAlive: () => false },
    }
    const sm = fakeSessionManager(session, { agent_provider: 'opencode' })
    ensureOrchestratorRunning(sm)

    expect(session.provider).toBe('opencode')
    expect(session.claudeSessionId).toBeNull()
    expect(sm.persistToDisk).toHaveBeenCalled()
    expect(sm.startClaude).toHaveBeenCalledWith('test-uuid-1234')
  })

  it('leaves a live session on the model its process was started with', () => {
    mockExistsSync.mockImplementation((p: string) =>
      typeof p === 'string' && p.endsWith('.session-id') ? true : false,
    )
    mockReadFileSync.mockReturnValue('test-uuid-1234')

    const session = {
      id: 'test-uuid-1234',
      model: 'claude-opus-4-7',
      allowedTools: ['Bash(curl:*)', 'CronCreate', 'CronDelete', 'CronList'],
      claudeProcess: { isAlive: () => true },
    }
    const sm = fakeSessionManager(session, { agent_model: 'claude-sonnet-5' })
    ensureOrchestratorRunning(sm)

    expect(session.model).toBe('claude-opus-4-7')
    expect(sm.startClaude).not.toHaveBeenCalled()
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

    expect(session.allowedTools).toEqual(ORCHESTRATOR_ALLOWED_TOOLS)
    expect(sm.persistToDisk).toHaveBeenCalled()
  })

  it('grants the MCP tools to a session persisted before they existed', () => {
    mockExistsSync.mockImplementation((p: string) =>
      typeof p === 'string' && p.endsWith('.session-id') ? true : false,
    )
    mockReadFileSync.mockReturnValue('test-uuid-1234')

    const session = {
      id: 'test-uuid-1234',
      allowedTools: ['Bash(curl:*)', 'CronCreate', 'CronDelete', 'CronList'],
      claudeProcess: { isAlive: () => true },
    }
    const sm = fakeSessionManager(session)
    ensureOrchestratorRunning(sm)

    expect(session.allowedTools).toContain('mcp__codekin__spawn_child')
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

describe('ensureOrchestratorMcpConfig', () => {
  it('writes the codekin entry, preserving other servers in an existing config', () => {
    mockExistsSync.mockReturnValue(true)
    mockReadFileSync.mockReturnValue(JSON.stringify({ mcpServers: { bookgraph: { url: 'https://x' } } }))

    ensureOrchestratorMcpConfig('/opt/dist/codekin-mcp-server.js')

    const [path, content] = mockWriteFileSync.mock.calls[0] as [string, string]
    expect(path).toBe('/tmp/test-data/orchestrator/.mcp.json')
    const parsed = JSON.parse(content) as { mcpServers: Record<string, { command?: string; args?: string[]; url?: string }> }
    expect(parsed.mcpServers.codekin.args).toEqual(['/opt/dist/codekin-mcp-server.js'])
    expect(parsed.mcpServers.bookgraph.url).toBe('https://x')
  })

  it('skips (with no write) when the compiled server file is missing', () => {
    mockExistsSync.mockReturnValue(false)

    ensureOrchestratorMcpConfig('/opt/dist/codekin-mcp-server.js')

    expect(mockWriteFileSync).not.toHaveBeenCalled()
  })
})

describe('orchestrator model preference', () => {
  it('falls back to the latest known Claude model when unset', () => {
    const sm = fakeSessionManager()
    expect(getOrchestratorModel(sm)).toBe('claude-latest-test')
  })

  it('returns the stored choice when set', () => {
    const sm = fakeSessionManager(undefined, { agent_model: 'claude-opus-5' })
    expect(getOrchestratorModel(sm)).toBe('claude-opus-5')
  })

  it('round-trips a saved choice', () => {
    const sm = fakeSessionManager()
    setOrchestratorModel(sm, 'claude-fable-5')
    expect(sm.archive.setSetting).toHaveBeenCalledWith('agent_model', 'claude-fable-5')
    expect(getOrchestratorModel(sm)).toBe('claude-fable-5')
  })

  it('applies no model override on a non-Claude harness when unset', () => {
    const sm = fakeSessionManager(undefined, { agent_provider: 'codex' })
    expect(getOrchestratorModel(sm)).toBe('')
  })
})

describe('orchestrator provider preference', () => {
  it('defaults to claude when unset or invalid', () => {
    expect(getOrchestratorProvider(fakeSessionManager())).toBe('claude')
    expect(getOrchestratorProvider(fakeSessionManager(undefined, { agent_provider: 'gemini' }))).toBe('claude')
  })

  it('round-trips a saved choice', () => {
    const sm = fakeSessionManager()
    setOrchestratorProvider(sm, 'codex')
    expect(getOrchestratorProvider(sm)).toBe('codex')
  })

  it('ignores an invalid provider', () => {
    const sm = fakeSessionManager()
    setOrchestratorProvider(sm, 'gemini' as any)
    expect(sm.archive.setSetting).not.toHaveBeenCalled()
  })

  it('clears the stored model when the harness changes — the model belonged to the old one', () => {
    const sm = fakeSessionManager(undefined, { agent_model: 'claude-fable-5' })
    setOrchestratorProvider(sm, 'opencode')
    expect(sm.archive.setSetting).toHaveBeenCalledWith('agent_model', '')
    expect(getOrchestratorModel(sm)).toBe('')
  })

  it('keeps the stored model when re-selecting the same harness', () => {
    const sm = fakeSessionManager(undefined, { agent_model: 'claude-fable-5', agent_provider: 'claude' })
    setOrchestratorProvider(sm, 'claude')
    expect(getOrchestratorModel(sm)).toBe('claude-fable-5')
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
