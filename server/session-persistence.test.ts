/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'

const { TEST_DATA_DIR } = vi.hoisted(() => {
  const fs = require('fs') as typeof import('fs')
  const os = require('os') as typeof import('os')
  const path = require('path') as typeof import('path')
  return { TEST_DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'codekin-persist-test-')) }
})

vi.mock('./config.js', () => ({
  DATA_DIR: TEST_DATA_DIR,
  PORT: 32352,
  getAgentDisplayName: () => 'TestAgent',
}))

vi.mock('./plan-manager.js', () => ({
  PlanManager: class {
    plans: never[] = []
  },
}))

import { SessionPersistence } from './session-persistence.js'
import type { Session } from './types.js'

const SESSIONS_FILE = join(TEST_DATA_DIR, 'sessions.json')

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: overrides.id ?? 's1',
    name: overrides.name ?? 'Session 1',
    workingDir: overrides.workingDir ?? '/repos/proj',
    created: overrides.created ?? '2026-04-27T00:00:00Z',
    source: overrides.source ?? 'manual',
    provider: overrides.provider ?? 'claude',
    claudeProcess: overrides.claudeProcess ?? null,
    clients: new Set(),
    outputHistory: overrides.outputHistory ?? [],
    claudeSessionId: overrides.claudeSessionId ?? null,
    restartCount: 0,
    lastRestartAt: null,
    _stoppedByUser: false,
    _isStarting: false,
    _wasActiveBeforeRestart: false,
    pendingControlRequests: new Map(),
    pendingToolApprovals: new Map(),
    ...(overrides as object),
  } as unknown as Session
}

afterEach(() => {
  if (existsSync(SESSIONS_FILE)) rmSync(SESSIONS_FILE)
  if (existsSync(SESSIONS_FILE + '.tmp')) rmSync(SESSIONS_FILE + '.tmp')
})

afterEach(() => {
  vi.useRealTimers()
})

describe('SessionPersistence.persistToDisk', () => {
  it('writes session data to disk as JSON', () => {
    const sessions = new Map<string, Session>()
    sessions.set('s1', makeSession({
      id: 's1',
      name: 'Test',
      workingDir: '/repos/x',
      worktreePath: '/repos/x.wt',
      groupDir: '/repos/x',
      claudeSessionId: 'claude-123',
      model: 'claude-opus-4-7',
    }))

    new SessionPersistence(sessions).persistToDisk()

    const raw = readFileSync(SESSIONS_FILE, 'utf-8')
    const parsed = JSON.parse(raw)
    expect(parsed).toHaveLength(1)
    expect(parsed[0]).toMatchObject({
      id: 's1',
      name: 'Test',
      workingDir: '/repos/x',
      worktreePath: '/repos/x.wt',
      groupDir: '/repos/x',
      claudeSessionId: 'claude-123',
      model: 'claude-opus-4-7',
      wasActive: false,
    })
  })

  it('records wasActive=true when claudeProcess.isAlive() returns true', () => {
    const sessions = new Map<string, Session>()
    sessions.set('s1', makeSession({
      claudeProcess: { isAlive: () => true } as any,
    }))

    new SessionPersistence(sessions).persistToDisk()

    const parsed = JSON.parse(readFileSync(SESSIONS_FILE, 'utf-8'))
    expect(parsed[0].wasActive).toBe(true)
  })

  it('handles write errors without throwing', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const sessions = new Map<string, Session>()
    sessions.set('s1', makeSession())

    // Point DATA_DIR-derived SESSIONS_FILE at an unwritable path by replacing
    // the real sessions file with a directory at the .tmp location, which
    // causes writeFileSync to fail.
    const fs = require('fs') as typeof import('fs')
    fs.mkdirSync(SESSIONS_FILE + '.tmp', { recursive: true })

    expect(() => new SessionPersistence(sessions).persistToDisk()).not.toThrow()
    expect(errSpy).toHaveBeenCalledWith('Failed to persist sessions:', expect.any(Error))

    fs.rmdirSync(SESSIONS_FILE + '.tmp')
    errSpy.mockRestore()
  })
})

describe('SessionPersistence.persistToDiskDebounced', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  it('debounces multiple calls into a single write', () => {
    const sessions = new Map<string, Session>()
    sessions.set('s1', makeSession())
    const persistence = new SessionPersistence(sessions)
    const writeSpy = vi.spyOn(persistence, 'persistToDisk')

    persistence.persistToDiskDebounced()
    persistence.persistToDiskDebounced()
    persistence.persistToDiskDebounced()

    expect(writeSpy).not.toHaveBeenCalled()

    vi.advanceTimersByTime(2000)
    expect(writeSpy).toHaveBeenCalledTimes(1)
  })

  it('allows a second debounced write after the first fires', () => {
    const sessions = new Map<string, Session>()
    sessions.set('s1', makeSession())
    const persistence = new SessionPersistence(sessions)
    const writeSpy = vi.spyOn(persistence, 'persistToDisk').mockImplementation(() => {})

    persistence.persistToDiskDebounced()
    vi.advanceTimersByTime(2000)
    persistence.persistToDiskDebounced()
    vi.advanceTimersByTime(2000)

    expect(writeSpy).toHaveBeenCalledTimes(2)
  })
})

describe('SessionPersistence.restoreFromDisk', () => {
  function seed(data: unknown): void {
    writeFileSync(SESSIONS_FILE, JSON.stringify(data))
  }

  it('returns silently when the sessions file does not exist', () => {
    const sessions = new Map<string, Session>()
    expect(() => new SessionPersistence(sessions).restoreFromDisk()).not.toThrow()
    expect(sessions.size).toBe(0)
  })

  it('restores valid sessions into the Map', () => {
    seed([{
      id: 's1',
      name: 'Restored',
      workingDir: '/repos/x',
      created: '2026-04-27T00:00:00Z',
      claudeSessionId: 'cs-1',
      outputHistory: [],
      wasActive: true,
    }])

    const sessions = new Map<string, Session>()
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    new SessionPersistence(sessions).restoreFromDisk()
    logSpy.mockRestore()

    expect(sessions.size).toBe(1)
    const s = sessions.get('s1')!
    expect(s.name).toBe('Restored')
    expect(s.workingDir).toBe('/repos/x')
    expect(s.source).toBe('manual')
    expect(s.provider).toBe('claude')
    expect(s.claudeSessionId).toBe('cs-1')
    expect(s._wasActiveBeforeRestart).toBe(true)
  })

  function restoreQuietly(): Map<string, Session> {
    const sessions = new Map<string, Session>()
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    new SessionPersistence(sessions).restoreFromDisk()
    warnSpy.mockRestore()
    logSpy.mockRestore()
    return sessions
  }

  it('keeps a missing worktree on the session and marks it missing instead of falling back', () => {
    seed([{
      id: 's1',
      name: 'WT',
      workingDir: '/nonexistent/wt',
      groupDir: '/some/repo',
      worktreePath: '/nonexistent/wt',
      executionMode: 'isolated',
      worktreeState: 'ready',
      created: '2026-04-27T00:00:00Z',
      claudeSessionId: null,
      outputHistory: [],
    }])

    const s = restoreQuietly().get('s1')!

    expect(s.workingDir).toBe('/nonexistent/wt')
    expect(s.worktreePath).toBe('/nonexistent/wt')
    expect(s.executionMode).toBe('isolated')
    expect(s.worktreeState).toBe('missing')
    expect(s.worktreeError).toContain('/nonexistent/wt')
  })

  it('treats a legacy session with a worktree as isolated', () => {
    const fs = require('fs') as typeof import('fs')
    const os = require('os') as typeof import('os')
    const wtDir = fs.mkdtempSync(join(os.tmpdir(), 'codekin-legacy-wt-'))
    seed([{
      id: 's1',
      name: 'WT',
      workingDir: wtDir,
      worktreePath: wtDir,
      created: '2026-04-27T00:00:00Z',
      claudeSessionId: null,
      outputHistory: [],
    }])

    const s = restoreQuietly().get('s1')!

    expect(s.executionMode).toBe('isolated')
    expect(s.worktreeState).toBe('ready')
    rmSync(wtDir, { recursive: true })
  })

  it('marks a worktree creation interrupted by a restart as failed', () => {
    seed([{
      id: 's1',
      name: 'WT',
      workingDir: '/some/repo',
      executionMode: 'isolated',
      worktreeState: 'preparing',
      created: '2026-04-27T00:00:00Z',
      claudeSessionId: null,
      outputHistory: [],
    }])

    const s = restoreQuietly().get('s1')!

    expect(s.worktreeState).toBe('failed')
    expect(s.worktreeError).toContain('interrupted')
  })

  it('keeps the removed state for a worktree whose files were deliberately removed', () => {
    seed([{
      id: 's1',
      name: 'WT',
      workingDir: '/nonexistent/wt',
      worktreePath: '/nonexistent/wt',
      executionMode: 'isolated',
      worktreeState: 'removed',
      archivedAt: '2026-09-29T10:00:00.000Z',
      created: '2026-04-27T00:00:00Z',
      claudeSessionId: null,
      outputHistory: [],
    }])

    const s = restoreQuietly().get('s1')!

    expect(s.worktreeState).toBe('removed')
    expect(s.archivedAt).toBe('2026-09-29T10:00:00.000Z')
  })

  it('round-trips isolation fields through persistToDisk', () => {
    seed([{
      id: 's1',
      name: 'Plain',
      workingDir: '/some/repo',
      executionMode: 'existing-checkout',
      worktreeBranch: 'wt/abc',
      worktreeBase: 'main',
      reviewBase: 'release/1.2',
      reviewComments: [{
        id: 'c1', body: 'why?', status: 'draft', author: 'owner', authorRole: 'owner', createdAt: '2026-09-29T10:00:00.000Z',
        anchor: { path: 'a.ts', side: 'new', startLine: 1, endLine: 1, view: 'branch', source: 'worktree', excerpt: ['x'], fingerprint: 'f' },
      }],
      archivedAt: '2026-09-29T10:00:00.000Z',
      created: '2026-04-27T00:00:00Z',
      claudeSessionId: null,
      outputHistory: [],
    }])
    const sessions = restoreQuietly()

    sessions.get('s1')!.reviewComments![0].stale = true  // computed, never persisted
    new SessionPersistence(sessions).persistToDisk()
    const written = JSON.parse(readFileSync(SESSIONS_FILE, 'utf-8'))

    expect(written[0]).toMatchObject({ executionMode: 'existing-checkout', worktreeBranch: 'wt/abc', worktreeBase: 'main', reviewBase: 'release/1.2', archivedAt: '2026-09-29T10:00:00.000Z' })
    expect(written[0].reviewComments).toHaveLength(1)
    expect(written[0].reviewComments[0]).not.toHaveProperty('stale')
  })

  it('handles malformed JSON without throwing', () => {
    writeFileSync(SESSIONS_FILE, 'not json {')

    const sessions = new Map<string, Session>()
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    expect(() => new SessionPersistence(sessions).restoreFromDisk()).not.toThrow()
    expect(errSpy).toHaveBeenCalledWith('Failed to restore sessions from disk:', expect.any(Error))
    errSpy.mockRestore()
  })

  it('applies defaults for missing source and provider fields', () => {
    seed([{
      id: 's1',
      name: 'Defaults',
      workingDir: '/repos/x',
      created: '2026-04-27T00:00:00Z',
      claudeSessionId: null,
      outputHistory: [],
    }])

    const sessions = new Map<string, Session>()
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    new SessionPersistence(sessions).restoreFromDisk()
    logSpy.mockRestore()

    expect(sessions.get('s1')!.source).toBe('manual')
    expect(sessions.get('s1')!.provider).toBe('claude')
  })
})
