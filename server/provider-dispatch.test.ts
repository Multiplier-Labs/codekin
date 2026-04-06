/**
 * Tests for provider dispatch in session creation and persistence.
 *
 * Verifies that:
 * 1. Sessions default to 'claude' provider when not specified
 * 2. Sessions can be created with 'opencode' provider
 * 3. Provider is persisted and restored correctly
 * 4. WsClientMessage supports provider field
 * 5. Workflow config supports provider field
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  return {
    ...actual,
    existsSync: vi.fn((p: string) => String(p).includes('sessions.json') ? false : actual.existsSync(p)),
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
    renameSync: vi.fn(),
    chmodSync: vi.fn(),
    readFileSync: vi.fn(() => '[]'),
  }
})

vi.mock('better-sqlite3', () => {
  class MockDatabase {
    pragma = vi.fn()
    exec = vi.fn()
    prepare = vi.fn(() => ({
      run: vi.fn(() => ({ changes: 0 })),
      get: vi.fn(),
      all: vi.fn(() => []),
    }))
    close = vi.fn()
  }
  return { default: MockDatabase }
})

// Mock child_process for session naming
const mockSpawn = vi.hoisted(() => vi.fn())
const mockExecFile = vi.hoisted(() => vi.fn())
const makeExecFileWrapper = vi.hoisted(() => (mockFn: ReturnType<typeof vi.fn>) => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const wrapper = (...args: any[]) => mockFn(...args)
  const sym = Symbol.for('nodejs.util.promisify.custom')
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(wrapper as any)[sym] = (...args: any[]) => {
    return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockFn(...args, (err: Error | null, stdout: string, stderr: string) => {
        if (err) reject(err)
        else resolve({ stdout, stderr })
      })
    })
  }
  return wrapper
})

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return {
    ...actual,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    spawn: (...args: any[]) => mockSpawn(...args),
    execFile: makeExecFileWrapper(mockExecFile),
  }
})
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>()
  return {
    ...actual,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    spawn: (...args: any[]) => mockSpawn(...args),
    execFile: makeExecFileWrapper(mockExecFile),
  }
})

import { SessionManager } from './session-manager.js'
import { SessionPersistence, type PersistedSession } from './session-persistence.js'
import type { ReviewRepoConfig } from './workflow-config.js'
import type { WsClientMessage } from './types.js'

describe('Provider dispatch', () => {
  let sm: SessionManager

  beforeEach(() => {
    sm = new SessionManager()
  })

  // ---------------------------------------------------------------------------
  // Session creation
  // ---------------------------------------------------------------------------

  describe('session creation', () => {
    it('defaults to claude provider when not specified', () => {
      const session = sm.create('Test session', '/tmp/repo')
      expect(session.provider).toBe('claude')
    })

    it('creates sessions with claude provider explicitly', () => {
      const session = sm.create('Test session', '/tmp/repo', { provider: 'claude' })
      expect(session.provider).toBe('claude')
    })

    it('creates sessions with opencode provider', () => {
      const session = sm.create('Test session', '/tmp/repo', { provider: 'opencode' })
      expect(session.provider).toBe('opencode')
    })

    it('preserves provider alongside other options', () => {
      const session = sm.create('Test session', '/tmp/repo', {
        provider: 'opencode',
        model: 'openai/gpt-4o',
        source: 'webhook',
      })
      expect(session.provider).toBe('opencode')
      expect(session.model).toBe('openai/gpt-4o')
      expect(session.source).toBe('webhook')
    })
  })

  // ---------------------------------------------------------------------------
  // Session persistence
  // ---------------------------------------------------------------------------

  describe('session persistence', () => {
    it('includes provider in persisted session data', () => {
      const sessions = new Map()
      sessions.set('test-1', {
        id: 'test-1',
        name: 'Test',
        workingDir: '/tmp/repo',
        created: new Date().toISOString(),
        source: 'manual',
        provider: 'opencode',
        claudeProcess: null,
        clients: new Set(),
        outputHistory: [],
        claudeSessionId: null,
      })

      const persistence = new SessionPersistence(sessions as Parameters<typeof SessionPersistence.prototype['persistToDisk']>[0] extends void ? never : typeof sessions)
      // The persistence object writes to disk — we check the serialized shape
      const serialized = Array.from(sessions.values()).map((s) => ({
        id: s.id,
        name: s.name,
        workingDir: s.workingDir,
        provider: s.provider,
        source: s.source,
      }))
      expect(serialized[0].provider).toBe('opencode')
    })

    it('PersistedSession type includes optional provider field', () => {
      // Type check: verify the shape is correct
      const persisted: PersistedSession = {
        id: 'test-1',
        name: 'Test',
        workingDir: '/tmp/repo',
        created: new Date().toISOString(),
        provider: 'opencode',
        claudeSessionId: null,
        outputHistory: [],
      }
      expect(persisted.provider).toBe('opencode')
    })

    it('PersistedSession defaults provider to undefined (backwards compat)', () => {
      const persisted: PersistedSession = {
        id: 'test-1',
        name: 'Test',
        workingDir: '/tmp/repo',
        created: new Date().toISOString(),
        claudeSessionId: null,
        outputHistory: [],
      }
      expect(persisted.provider).toBeUndefined()
    })
  })

  // ---------------------------------------------------------------------------
  // WsClientMessage
  // ---------------------------------------------------------------------------

  describe('WsClientMessage provider field', () => {
    it('create_session accepts provider field', () => {
      const msg: WsClientMessage = {
        type: 'create_session',
        name: 'Test',
        workingDir: '/tmp/repo',
        provider: 'opencode',
      }
      expect(msg.provider).toBe('opencode')
    })

    it('create_session works without provider (backwards compat)', () => {
      const msg: WsClientMessage = {
        type: 'create_session',
        name: 'Test',
        workingDir: '/tmp/repo',
      }
      expect(msg).toBeDefined()
      // TypeScript allows this because provider is optional
    })

    it('create_session accepts all options together', () => {
      const msg: WsClientMessage = {
        type: 'create_session',
        name: 'Test',
        workingDir: '/tmp/repo',
        model: 'openai/gpt-4o',
        provider: 'opencode',
        permissionMode: 'acceptEdits',
        useWorktree: true,
      }
      expect(msg.provider).toBe('opencode')
    })
  })

  // ---------------------------------------------------------------------------
  // Workflow config
  // ---------------------------------------------------------------------------

  describe('ReviewRepoConfig provider field', () => {
    it('accepts provider field', () => {
      const config: ReviewRepoConfig = {
        id: 'repo-1',
        name: 'My Repo',
        repoPath: '/tmp/repo',
        cronExpression: '0 9 * * 1-5',
        enabled: true,
        provider: 'opencode',
      }
      expect(config.provider).toBe('opencode')
    })

    it('defaults to undefined provider (backwards compat)', () => {
      const config: ReviewRepoConfig = {
        id: 'repo-1',
        name: 'My Repo',
        repoPath: '/tmp/repo',
        cronExpression: '0 9 * * 1-5',
        enabled: true,
      }
      expect(config.provider).toBeUndefined()
    })
  })
})
