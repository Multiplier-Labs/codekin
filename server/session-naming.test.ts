/** Tests for SessionNaming — verifies LLM-based session name generation and retry logic; mocks node:child_process.spawn to simulate claude CLI responses. */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { SessionNaming, type SessionNamingDeps } from './session-naming.js'
import { EventEmitter } from 'node:events'

// Mock child_process.spawn
const mockSpawn = vi.hoisted(() => vi.fn())
vi.mock('node:child_process', () => ({ spawn: (...args: any[]) => mockSpawn(...args) }))

/** Create a fake child process that emits events like a real spawn result. */
function fakeProc(stdout: string, code: number, stderr = '') {
  const proc = Object.assign(new EventEmitter(), {
    stdin: { write: vi.fn(), end: vi.fn() },
    stdout: Object.assign(new EventEmitter(), { on: vi.fn() }),
    stderr: Object.assign(new EventEmitter(), { on: vi.fn() }),
    kill: vi.fn(),
  })

  // Wire up data listeners to fire on next tick
  proc.stdout.on = vi.fn((event: string, cb: (chunk: Buffer) => void) => {
    if (event === 'data') {
      queueMicrotask(() => cb(Buffer.from(stdout)))
    }
  })
  proc.stderr.on = vi.fn((event: string, cb: (chunk: Buffer) => void) => {
    if (event === 'data' && stderr) {
      queueMicrotask(() => cb(Buffer.from(stderr)))
    }
  })

  // Fire close after stdout/stderr data
  setTimeout(() => proc.emit('close', code), 5)

  return proc
}

function makeDeps(overrides: Partial<SessionNamingDeps> = {}): SessionNamingDeps {
  return {
    getSession: vi.fn(() => undefined),
    hasSession: vi.fn(() => true),
    rename: vi.fn(() => true),
    ...overrides,
  }
}

function fakeSession(overrides: Record<string, any> = {}): any {
  return {
    name: 'hub:abc123',
    _namingTimer: undefined,
    _namingAttempts: 0,
    _lastUserInput: 'fix the login bug',
    _namingUserInput: 'fix the login bug',
    outputHistory: [{ type: 'output', data: 'I will help fix the login bug.' }],
    ...overrides,
  }
}

describe('SessionNaming', () => {
  beforeEach(() => {
    mockSpawn.mockReset()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  // 1. No context yet — retry scheduled
  it('re-schedules when no user input and no output history', async () => {
    vi.useFakeTimers()
    const session = fakeSession({ _lastUserInput: '', _namingUserInput: '', outputHistory: [] })
    const deps = makeDeps({ getSession: vi.fn(() => session) })
    const naming = new SessionNaming(deps)

    await naming.executeSessionNaming('s1')

    expect(mockSpawn).not.toHaveBeenCalled()
    expect(session._namingTimer).toBeDefined()
    vi.useRealTimers()
  })

  // 2. scheduleSessionNaming — skips if session not found
  it('skips scheduling when session is not found', () => {
    vi.useFakeTimers()
    const deps = makeDeps({ getSession: vi.fn(() => undefined) })
    const naming = new SessionNaming(deps)

    naming.scheduleSessionNaming('s1')

    expect(vi.getTimerCount()).toBe(0)
    vi.useRealTimers()
  })

  // 3. scheduleSessionNaming — skips if name doesn't start with 'hub:'
  it('skips scheduling when session name does not start with hub:', () => {
    vi.useFakeTimers()
    const session = fakeSession({ name: 'My Custom Name' })
    const deps = makeDeps({ getSession: vi.fn(() => session) })
    const naming = new SessionNaming(deps)

    naming.scheduleSessionNaming('s1')

    expect(session._namingTimer).toBeUndefined()
    expect(vi.getTimerCount()).toBe(0)
    vi.useRealTimers()
  })

  // 4. scheduleSessionNaming — skips if timer already pending
  it('skips scheduling when a timer is already pending', () => {
    vi.useFakeTimers()
    const existingTimer = setTimeout(() => {}, 99999)
    const session = fakeSession({ _namingTimer: existingTimer })
    const deps = makeDeps({ getSession: vi.fn(() => session) })
    const naming = new SessionNaming(deps)

    naming.scheduleSessionNaming('s1')

    // Timer should remain the original one
    expect(session._namingTimer).toBe(existingTimer)
    vi.useRealTimers()
  })

  // 5. scheduleSessionNaming — skips after MAX_NAMING_ATTEMPTS (5)
  it('skips scheduling when max naming attempts reached', () => {
    vi.useFakeTimers()
    const session = fakeSession({ _namingAttempts: 5 })
    const deps = makeDeps({ getSession: vi.fn(() => session) })
    const naming = new SessionNaming(deps)

    naming.scheduleSessionNaming('s1')

    expect(session._namingTimer).toBeUndefined()
    expect(vi.getTimerCount()).toBe(0)
    vi.useRealTimers()
  })

  // 6. scheduleSessionNaming — sets timer with correct delay (20s for first attempt)
  it('sets timer with 20s delay on first attempt', () => {
    vi.useFakeTimers()
    const session = fakeSession({ _namingAttempts: 0 })
    const deps = makeDeps({ getSession: vi.fn(() => session) })
    const naming = new SessionNaming(deps)

    naming.scheduleSessionNaming('s1')

    expect(session._namingTimer).toBeDefined()
    expect(vi.getTimerCount()).toBe(1)
    vi.advanceTimersByTime(19_999)
    expect(session._namingTimer).toBeDefined()
    vi.useRealTimers()
  })

  // 7. executeSessionNaming — successful naming with valid CLI response
  it('renames session when CLI returns a valid name', async () => {
    const session = fakeSession()
    const deps = makeDeps({ getSession: vi.fn(() => session) })
    const naming = new SessionNaming(deps)
    mockSpawn.mockReturnValue(fakeProc('Fix Login Page Styling', 0))

    await naming.executeSessionNaming('s1')

    expect(deps.rename).toHaveBeenCalledWith('s1', 'Fix Login Page Styling')
    expect(mockSpawn).toHaveBeenCalledWith(
      'claude',
      ['-p', '--max-turns', '2', '--model', 'haiku'],
      expect.objectContaining({ stdio: ['pipe', 'pipe', 'pipe'] }),
    )
  })

  // 8. executeSessionNaming — strips quotes and "session name:" prefix
  it('strips quotes and session name prefix from CLI response', async () => {
    const session = fakeSession()
    const deps = makeDeps({ getSession: vi.fn(() => session) })
    const naming = new SessionNaming(deps)
    mockSpawn.mockReturnValue(fakeProc('"Session Name: Fix Login Bug"', 0))

    await naming.executeSessionNaming('s1')

    expect(deps.rename).toHaveBeenCalledWith('s1', 'Fix Login Bug')
  })

  // 9. executeSessionNaming — rejects names with too few words
  it('rejects names with fewer than 3 words and re-schedules', async () => {
    const session = fakeSession()
    const deps = makeDeps({ getSession: vi.fn(() => session) })
    const naming = new SessionNaming(deps)
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    mockSpawn.mockReturnValue(fakeProc('Fix', 0))

    await naming.executeSessionNaming('s1')

    expect(deps.rename).not.toHaveBeenCalled()
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('invalid name'))
    expect(session._namingTimer).toBeDefined()
  })

  // 10. executeSessionNaming — truncates names over 60 chars
  it('truncates names longer than 60 characters at word boundary', async () => {
    // 74 chars, 10 words
    const longName = 'Refactor Authentication Module to Use Modern Token Based Session Management'
    expect(longName.length).toBeGreaterThan(60)
    expect(longName.length).toBeLessThanOrEqual(80)
    expect(longName.split(/\s+/).length).toBeGreaterThanOrEqual(3)

    const session = fakeSession()
    const deps = makeDeps({ getSession: vi.fn(() => session) })
    const naming = new SessionNaming(deps)
    mockSpawn.mockReturnValue(fakeProc(longName, 0))

    await naming.executeSessionNaming('s1')

    expect(deps.rename).toHaveBeenCalled()
    const finalName = (deps.rename as any).mock.calls[0][1]
    expect(finalName.length).toBeLessThanOrEqual(60)
  })

  // 10b. executeSessionNaming — rejects error-like CLI output
  it('rejects "Reached max turns" output and re-schedules', async () => {
    const session = fakeSession()
    const deps = makeDeps({ getSession: vi.fn(() => session) })
    const naming = new SessionNaming(deps)
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    mockSpawn.mockReturnValue(fakeProc('Error: Reached max turns (1)', 0))

    await naming.executeSessionNaming('s1')

    expect(deps.rename).not.toHaveBeenCalled()
    expect(session._namingTimer).toBeDefined()
  })

  // 11. executeSessionNaming — CLI error triggers retry
  it('re-schedules on CLI error without renaming', async () => {
    vi.useFakeTimers()
    const session = fakeSession()
    const deps = makeDeps({ getSession: vi.fn(() => session) })
    const naming = new SessionNaming(deps)
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    mockSpawn.mockReturnValue(fakeProc('', 1, 'some error'))

    const promise = naming.executeSessionNaming('s1')
    // Advance timers so the fakeProc 'close' event fires (setTimeout 5ms)
    await vi.advanceTimersByTimeAsync(10)
    await promise

    expect(deps.rename).not.toHaveBeenCalled()
    expect(session._namingTimer).toBeDefined()
    vi.useRealTimers()
  })

  // 12. retrySessionNamingOnInteraction — sets 5s timer
  it('sets a 5s timer on interaction retry', () => {
    vi.useFakeTimers()
    const session = fakeSession()
    const deps = makeDeps({ getSession: vi.fn(() => session) })
    const naming = new SessionNaming(deps)

    naming.retrySessionNamingOnInteraction('s1')

    expect(session._namingTimer).toBeDefined()
    vi.advanceTimersByTime(4_999)
    expect(vi.getTimerCount()).toBe(1)
    vi.advanceTimersByTime(1)
    expect(vi.getTimerCount()).toBe(0)
    vi.useRealTimers()
  })

  // 12b. executeSessionNaming — uses _namingUserInput when _lastUserInput is cleared
  it('uses _namingUserInput when _lastUserInput has been cleared', async () => {
    // Simulates the bug scenario: finalizeResult clears _lastUserInput before naming runs
    const session = fakeSession({
      _lastUserInput: undefined,
      _namingUserInput: 'add dark mode support',
      outputHistory: [{ type: 'output', data: 'I will add dark mode.' }],
    })
    const deps = makeDeps({ getSession: vi.fn(() => session) })
    const naming = new SessionNaming(deps)
    mockSpawn.mockReturnValue(fakeProc('Add Dark Mode Support', 0))

    await naming.executeSessionNaming('s1')

    expect(deps.rename).toHaveBeenCalledWith('s1', 'Add Dark Mode Support')
    // Verify the prompt included the user's message from _namingUserInput
    const stdinWrite = mockSpawn.mock.results[0].value.stdin.write
    const promptText = stdinWrite.mock.calls[0][0]
    expect(promptText).toContain('add dark mode support')
  })

  // 13. executeSessionNaming — skips if session disappears mid-flight
  it('does nothing when session is removed before CLI responds', async () => {
    const session = fakeSession()
    const deps = makeDeps({
      getSession: vi.fn(() => session),
      hasSession: vi.fn(() => false), // session gone by the time CLI responds
    })
    const naming = new SessionNaming(deps)
    mockSpawn.mockReturnValue(fakeProc('Fix Login Page Styling', 0))

    await naming.executeSessionNaming('s1')

    expect(deps.rename).not.toHaveBeenCalled()
  })
})
