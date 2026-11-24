/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
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
const HISTORY_DIR = join(TEST_DATA_DIR, 'session-history')
const logFile = (id: string) => join(HISTORY_DIR, `${id}.jsonl`)
const legacyFile = (id: string) => join(HISTORY_DIR, `${id}.json`)

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
  rmSync(HISTORY_DIR, { recursive: true, force: true })
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

  it('round-trips attached folders and pending place notes', () => {
    seed([{
      id: 's1', name: 'A', workingDir: '/some/repo', created: '2026-11-13T00:00:00Z', claudeSessionId: null, outputHistory: [],
      addDirs: ['/home/u/notes'], pendingPlaceNotes: ['<codekin-place-attached>…</codekin-place-attached>'],
    }])
    const sessions = restoreQuietly()
    expect(sessions.get('s1')!.addDirs).toEqual(['/home/u/notes'])
    new SessionPersistence(sessions).persistToDisk()
    const written = JSON.parse(readFileSync(SESSIONS_FILE, 'utf-8'))
    expect(written[0]).toMatchObject({ addDirs: ['/home/u/notes'], pendingPlaceNotes: ['<codekin-place-attached>…</codekin-place-attached>'] })
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

describe('SessionPersistence output history logs', () => {
  const quiet = <T>(fn: () => T): T => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    try { return fn() } finally { logSpy.mockRestore() }
  }
  const readSessions = () => JSON.parse(readFileSync(SESSIONS_FILE, 'utf-8'))
  const readLines = (id: string) => readFileSync(logFile(id), 'utf-8').split('\n').filter(Boolean).map(l => JSON.parse(l))
  const restore = () => {
    const restored = new Map<string, Session>()
    quiet(() => new SessionPersistence(restored).restoreFromDisk())
    return restored
  }
  const outputs = (n: number, from = 0) => Array.from({ length: n }, (_, i) => ({ type: 'output', data: `m${from + i}` })) as any[]

  it('keeps history out of sessions.json and in a log per session', () => {
    const sessions = new Map<string, Session>()
    sessions.set('s1', makeSession({ id: 's1', outputHistory: [{ type: 'output', data: 'hi' }] as any }))
    new SessionPersistence(sessions).persistToDisk()

    expect(readSessions()[0].outputHistory).toBeUndefined()
    expect(readLines('s1')).toEqual([[0, { type: 'output', data: 'hi' }]])
  })

  it('appends only what changed, and re-writes a last entry that grew', () => {
    const sessions = new Map<string, Session>()
    const s1 = makeSession({ id: 's1', outputHistory: [{ type: 'output', data: 'a' }] as any })
    sessions.set('s1', s1)
    sessions.set('s2', makeSession({ id: 's2', outputHistory: [{ type: 'user_echo', text: 'x' }] as any }))
    const p = new SessionPersistence(sessions)
    p.persistToDisk()
    p.persistToDisk()
    expect(readLines('s1')).toHaveLength(1)
    expect(readLines('s2')).toHaveLength(1)

    // The last output chunk grows in place as streamed text merges into it.
    ;(s1.outputHistory[0] as any).data += 'b'
    s1.outputHistory.push({ type: 'result' } as any)
    p.persistToDisk()
    expect(readLines('s1')).toEqual([
      [0, { type: 'output', data: 'a' }],
      [0, { type: 'output', data: 'ab' }],
      [1, { type: 'result' }],
    ])
    expect(readLines('s2')).toHaveLength(1)
    expect(restore().get('s1')!.outputHistory).toEqual([{ type: 'output', data: 'ab' }, { type: 'result' }])
  })

  it('keeps positions across front trims and restores the newest entries', () => {
    const sessions = new Map<string, Session>()
    const s1 = makeSession({ id: 's1', outputHistory: outputs(3) })
    sessions.set('s1', s1)
    const p = new SessionPersistence(sessions)
    p.persistToDisk()

    // What SessionManager.trimHistory does.
    s1.outputHistory.push(...outputs(2, 3))
    s1.outputHistory.splice(0, 2)
    s1._historyBase = 2
    p.persistToDisk()
    expect(readLines('s1').map(([pos]) => pos)).toEqual([0, 1, 2, 3, 4])

    const restored = restore().get('s1')!
    expect(restored.outputHistory.map((m: any) => m.data)).toEqual(['m0', 'm1', 'm2', 'm3', 'm4'])
    expect(restored._historyBase).toBe(0)
  })

  it('drops entries past the history cap when restoring', () => {
    const sessions = new Map<string, Session>()
    sessions.set('s1', makeSession({ id: 's1', outputHistory: outputs(2003) }))
    const p = new SessionPersistence(sessions)
    p.persistToDisk({ final: true })

    const restored = restore().get('s1')!
    expect(restored.outputHistory).toHaveLength(2000)
    expect(restored._historyBase).toBe(3)
    expect((restored.outputHistory[0] as any).data).toBe('m3')
  })

  it('rewrites a replaced history in the background, keeping it inline until then', async () => {
    const sessions = new Map<string, Session>()
    const s1 = makeSession({ id: 's1', outputHistory: outputs(100) })
    sessions.set('s1', s1)
    const p = new SessionPersistence(sessions)
    p.persistToDisk()
    // Too long to write at once with no log yet: queued, and inline meanwhile.
    expect(readSessions()[0].outputHistory).toHaveLength(100)
    await p.whenHistoriesWritten()
    expect(readLines('s1')).toHaveLength(100)

    // Replacing the array (as stripping a turn's output does) is not an append.
    s1.outputHistory = outputs(80, 500)
    p.persistToDisk()
    expect(readSessions()[0].outputHistory).toBeUndefined() // the old log still restores
    expect(readLines('s1')).toHaveLength(100)
    await p.whenHistoriesWritten()
    expect(readLines('s1').map(([, m]) => m.data)).toEqual(outputs(80, 500).map(m => m.data))

    // Appends continue the rewritten log.
    s1.outputHistory.push({ type: 'result' } as any)
    p.persistToDisk()
    expect(readLines('s1')).toHaveLength(81)
  })

  it('compacts a log grown mostly stale by re-written entries', async () => {
    const sessions = new Map<string, Session>()
    const chunk = 'x'.repeat(100_000)
    const s1 = makeSession({ id: 's1', outputHistory: [{ type: 'output', data: '' }] as any })
    sessions.set('s1', s1)
    const p = new SessionPersistence(sessions)
    p.persistToDisk()
    // Each persist re-appends the growing last entry whole.
    for (let i = 0; i < 15; i++) {
      ;(s1.outputHistory[0] as any).data += chunk
      p.persistToDisk()
    }
    expect(readLines('s1').length).toBeGreaterThan(1)
    await p.whenHistoriesWritten()
    expect(readLines('s1')).toEqual([[0, { type: 'output', data: chunk.repeat(15) }]])
  })

  it('does a queued rewrite synchronously on shutdown', () => {
    const sessions = new Map<string, Session>()
    const s1 = makeSession({ id: 's1', outputHistory: outputs(100) })
    sessions.set('s1', s1)
    const p = new SessionPersistence(sessions)
    p.persistToDisk()
    expect(existsSync(logFile('s1'))).toBe(false)

    p.persistToDisk({ final: true })
    expect(readLines('s1')).toHaveLength(100)
    expect(readSessions()[0].outputHistory).toBeUndefined()
  })

  it('an abandoned background rewrite does not replace the shutdown write', async () => {
    const sessions = new Map<string, Session>()
    const s1 = makeSession({ id: 's1', outputHistory: outputs(100) })
    sessions.set('s1', s1)
    const p = new SessionPersistence(sessions)
    p.persistToDisk()
    s1.outputHistory.push({ type: 'result' } as any)
    p.persistToDisk({ final: true })
    await p.whenHistoriesWritten()

    expect(readLines('s1')).toHaveLength(101)
    expect(existsSync(logFile('s1') + '.compact.tmp')).toBe(false)
  })

  it('restores history from its log and appends to it without a rewrite', () => {
    const sessions = new Map<string, Session>()
    sessions.set('s1', makeSession({ id: 's1', outputHistory: [{ type: 'user_echo', text: 'hello' }] as any }))
    new SessionPersistence(sessions).persistToDisk()

    const restored = new Map<string, Session>()
    const p = new SessionPersistence(restored)
    quiet(() => p.restoreFromDisk())
    const s1 = restored.get('s1')!
    expect(s1.outputHistory).toEqual([{ type: 'user_echo', text: 'hello' }])

    p.persistToDisk()
    expect(readLines('s1')).toHaveLength(1)
    s1.outputHistory.push({ type: 'result' } as any)
    p.persistToDisk()
    expect(readLines('s1')).toEqual([[0, { type: 'user_echo', text: 'hello' }], [1, { type: 'result' }]])
  })

  it('skips a line cut short by a crash, then rewrites the log', async () => {
    mkdirSync(HISTORY_DIR, { recursive: true })
    writeFileSync(SESSIONS_FILE, JSON.stringify([{ id: 's1', name: 'S', workingDir: '/repos/x', created: '2026-04-27T00:00:00Z', claudeSessionId: null }]))
    writeFileSync(logFile('s1'), '[0,{"type":"output","data":"a"}]\n[1,{"type":"outp\n[2,{"type":"result"}]\n')

    const restored = new Map<string, Session>()
    const p = new SessionPersistence(restored)
    quiet(() => p.restoreFromDisk())
    expect(restored.get('s1')!.outputHistory).toEqual([{ type: 'output', data: 'a' }, { type: 'result' }])

    // Positions now have a gap, so the log is rewritten rather than appended to.
    p.persistToDisk()
    await p.whenHistoriesWritten()
    expect(readLines('s1').map(([pos]) => pos)).toEqual([0, 1])
  })

  it('converts a history file from the array format into a log once it changes', () => {
    mkdirSync(HISTORY_DIR, { recursive: true })
    writeFileSync(SESSIONS_FILE, JSON.stringify([{ id: 's1', name: 'S', workingDir: '/repos/x', created: '2026-04-27T00:00:00Z', claudeSessionId: null }]))
    writeFileSync(legacyFile('s1'), JSON.stringify([{ type: 'output', data: 'old' }]))

    const sessions = new Map<string, Session>()
    const p = new SessionPersistence(sessions)
    quiet(() => p.restoreFromDisk())
    expect(sessions.get('s1')!.outputHistory).toEqual([{ type: 'output', data: 'old' }])

    // Unchanged, the old file keeps serving it.
    p.persistToDisk()
    expect(existsSync(logFile('s1'))).toBe(false)
    expect(readSessions()[0].outputHistory).toBeUndefined()

    // Changed, it becomes a log; the old file stays for an older version to read.
    sessions.get('s1')!.outputHistory.push({ type: 'result' } as any)
    p.persistToDisk()
    expect(readLines('s1')).toEqual([[0, { type: 'output', data: 'old' }], [1, { type: 'result' }]])
    expect(JSON.parse(readFileSync(legacyFile('s1'), 'utf-8'))).toEqual([{ type: 'output', data: 'old' }])
    expect(restore().get('s1')!.outputHistory).toEqual([{ type: 'output', data: 'old' }, { type: 'result' }])

    // Both go with the session.
    sessions.delete('s1')
    p.persistToDisk()
    expect(existsSync(logFile('s1'))).toBe(false)
    expect(existsSync(legacyFile('s1'))).toBe(false)
  })

  it('migrates a history saved inline in sessions.json into its own log', () => {
    writeFileSync(SESSIONS_FILE, JSON.stringify([{
      id: 's1', name: 'Old', workingDir: '/repos/x', created: '2026-04-27T00:00:00Z',
      claudeSessionId: null, outputHistory: [{ type: 'output', data: 'legacy' }],
    }]))
    const sessions = new Map<string, Session>()
    const p = new SessionPersistence(sessions)
    quiet(() => p.restoreFromDisk())
    expect(sessions.get('s1')!.outputHistory).toEqual([{ type: 'output', data: 'legacy' }])

    p.persistToDisk()
    expect(readLines('s1')).toEqual([[0, { type: 'output', data: 'legacy' }]])
    expect(readSessions()[0].outputHistory).toBeUndefined()
  })

  it('removes the log of a session that is gone', () => {
    const sessions = new Map<string, Session>()
    sessions.set('s1', makeSession({ id: 's1', outputHistory: [{ type: 'output', data: 'a' }] as any }))
    const p = new SessionPersistence(sessions)
    p.persistToDisk()
    expect(existsSync(logFile('s1'))).toBe(true)

    sessions.delete('s1')
    p.persistToDisk()
    expect(existsSync(logFile('s1'))).toBe(false)
  })

  it('keeps the history inline for an id that is not safe as a file name', () => {
    const sessions = new Map<string, Session>()
    sessions.set('../x', makeSession({ id: '../x', outputHistory: [{ type: 'output', data: 'a' }] as any }))
    new SessionPersistence(sessions).persistToDisk()

    expect(readSessions()[0].outputHistory).toEqual([{ type: 'output', data: 'a' }])
    expect(existsSync(join(TEST_DATA_DIR, 'x.json'))).toBe(false)
    expect(existsSync(join(TEST_DATA_DIR, 'x.jsonl'))).toBe(false)
  })
})
