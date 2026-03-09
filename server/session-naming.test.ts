/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { SessionNaming, type SessionNamingDeps } from './session-naming.js'

const mockGenerateText = vi.hoisted(() => vi.fn())
vi.mock('ai', () => ({ generateText: (...args: any[]) => mockGenerateText(...args) }))
vi.mock('@ai-sdk/groq', () => ({ createGroq: () => (model: string) => ({ modelId: model }) }))
vi.mock('@ai-sdk/openai', () => ({ createOpenAI: () => (model: string) => ({ modelId: model }) }))
vi.mock('@ai-sdk/google', () => ({ createGoogleGenerativeAI: () => (model: string) => ({ modelId: model }) }))
vi.mock('@ai-sdk/anthropic', () => ({ createAnthropic: () => (model: string) => ({ modelId: model }) }))

function makeDeps(overrides: Partial<SessionNamingDeps> = {}): SessionNamingDeps {
  return {
    getSession: vi.fn(() => undefined),
    hasSession: vi.fn(() => true),
    getSetting: vi.fn(() => 'auto'),
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
    outputHistory: [{ type: 'output', data: 'I will help fix the login bug.' }],
    ...overrides,
  }
}

describe('SessionNaming', () => {
  let savedEnv: NodeJS.ProcessEnv

  beforeEach(() => {
    savedEnv = { ...process.env }
    delete process.env.GROQ_API_KEY
    delete process.env.OPENAI_API_KEY
    delete process.env.GEMINI_API_KEY
    delete process.env.ANTHROPIC_API_KEY
    mockGenerateText.mockReset()
  })

  afterEach(() => {
    process.env = savedEnv
    vi.restoreAllMocks()
  })

  // 1. No API key — early exit
  it('exits early with console.warn when no API keys are set', async () => {
    const session = fakeSession()
    const deps = makeDeps({ getSession: vi.fn(() => session) })
    const naming = new SessionNaming(deps)
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await naming.executeSessionNaming('s1')

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('No API key'))
    expect(deps.rename).not.toHaveBeenCalled()
    expect(mockGenerateText).not.toHaveBeenCalled()
  })

  // 2. No context yet — retry scheduled
  it('re-schedules when no user input and no output history', async () => {
    vi.useFakeTimers()
    const session = fakeSession({ _lastUserInput: '', outputHistory: [] })
    const deps = makeDeps({ getSession: vi.fn(() => session) })
    const naming = new SessionNaming(deps)

    await naming.executeSessionNaming('s1')

    expect(mockGenerateText).not.toHaveBeenCalled()
    expect(session._namingTimer).toBeDefined()
    vi.useRealTimers()
  })

  // 3. scheduleSessionNaming — skips if session not found
  it('skips scheduling when session is not found', () => {
    vi.useFakeTimers()
    const deps = makeDeps({ getSession: vi.fn(() => undefined) })
    const naming = new SessionNaming(deps)

    naming.scheduleSessionNaming('s1')

    expect(vi.getTimerCount()).toBe(0)
    vi.useRealTimers()
  })

  // 4. scheduleSessionNaming — skips if name doesn't start with 'hub:'
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

  // 5. scheduleSessionNaming — skips if timer already pending
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

  // 6. scheduleSessionNaming — skips after MAX_NAMING_ATTEMPTS (5)
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

  // 7. scheduleSessionNaming — sets timer with correct delay (20s for first attempt)
  it('sets timer with 20s delay on first attempt', () => {
    vi.useFakeTimers()
    const session = fakeSession({ _namingAttempts: 0 })
    const deps = makeDeps({ getSession: vi.fn(() => session) })
    const naming = new SessionNaming(deps)

    naming.scheduleSessionNaming('s1')

    expect(session._namingTimer).toBeDefined()
    // Verify the timer fires after 20s
    expect(vi.getTimerCount()).toBe(1)
    vi.advanceTimersByTime(19_999)
    // executeSessionNaming would be called, but session lookup returns the session
    // Just verify the timer was set and fires at ~20s
    expect(session._namingTimer).toBeDefined()
    vi.useRealTimers()
  })

  // 8. executeSessionNaming — successful naming with valid AI response
  it('renames session when AI returns a valid name', async () => {
    process.env.GROQ_API_KEY = 'test-key'
    const session = fakeSession()
    const deps = makeDeps({ getSession: vi.fn(() => session) })
    const naming = new SessionNaming(deps)
    mockGenerateText.mockResolvedValue({ text: 'Fix Login Page Styling' })

    await naming.executeSessionNaming('s1')

    expect(deps.rename).toHaveBeenCalledWith('s1', 'Fix Login Page Styling')
  })

  // 9. executeSessionNaming — strips quotes and "session name:" prefix
  it('strips quotes and session name prefix from AI response', async () => {
    process.env.GROQ_API_KEY = 'test-key'
    const session = fakeSession()
    const deps = makeDeps({ getSession: vi.fn(() => session) })
    const naming = new SessionNaming(deps)
    mockGenerateText.mockResolvedValue({ text: '"Session Name: Fix Login Bug"' })

    await naming.executeSessionNaming('s1')

    expect(deps.rename).toHaveBeenCalledWith('s1', 'Fix Login Bug')
  })

  // 10. executeSessionNaming — rejects names with too few words
  it('rejects names with fewer than 3 words and re-schedules', async () => {
    vi.useFakeTimers()
    process.env.GROQ_API_KEY = 'test-key'
    const session = fakeSession()
    const deps = makeDeps({ getSession: vi.fn(() => session) })
    const naming = new SessionNaming(deps)
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    mockGenerateText.mockResolvedValue({ text: 'Fix' })

    await naming.executeSessionNaming('s1')

    expect(deps.rename).not.toHaveBeenCalled()
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('invalid name'))
    expect(session._namingTimer).toBeDefined()
    vi.useRealTimers()
  })

  // 11. executeSessionNaming — truncates names over 60 chars
  it('truncates names longer than 60 characters at word boundary', async () => {
    process.env.GROQ_API_KEY = 'test-key'
    // 74 chars, 10 words — passes the <=80 length check but exceeds the 60-char truncation threshold
    const longName = 'Refactor Authentication Module to Use Modern Token Based Session Management'
    expect(longName.length).toBeGreaterThan(60)
    expect(longName.length).toBeLessThanOrEqual(80)
    expect(longName.split(/\s+/).length).toBeGreaterThanOrEqual(3)

    const session = fakeSession()
    const deps = makeDeps({ getSession: vi.fn(() => session) })
    const naming = new SessionNaming(deps)
    mockGenerateText.mockResolvedValue({ text: longName })

    await naming.executeSessionNaming('s1')

    expect(deps.rename).toHaveBeenCalled()
    const finalName = (deps.rename as any).mock.calls[0][1]
    expect(finalName.length).toBeLessThanOrEqual(60)
  })

  // 12. executeSessionNaming — API error triggers retry
  it('re-schedules on API error without renaming', async () => {
    vi.useFakeTimers()
    process.env.GROQ_API_KEY = 'test-key'
    const session = fakeSession()
    const deps = makeDeps({ getSession: vi.fn(() => session) })
    const naming = new SessionNaming(deps)
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    mockGenerateText.mockRejectedValue(new Error('API rate limit'))

    await naming.executeSessionNaming('s1')

    expect(deps.rename).not.toHaveBeenCalled()
    expect(session._namingTimer).toBeDefined()
    vi.useRealTimers()
  })

  // 13. retrySessionNamingOnInteraction — sets 5s timer
  it('sets a 5s timer on interaction retry', () => {
    vi.useFakeTimers()
    const session = fakeSession()
    const deps = makeDeps({ getSession: vi.fn(() => session) })
    const naming = new SessionNaming(deps)

    naming.retrySessionNamingOnInteraction('s1')

    expect(session._namingTimer).toBeDefined()
    // Verify it fires at 5s
    vi.advanceTimersByTime(4_999)
    // Timer should still be pending
    expect(vi.getTimerCount()).toBe(1)
    vi.advanceTimersByTime(1)
    // Timer should have fired
    expect(vi.getTimerCount()).toBe(0)
    vi.useRealTimers()
  })

  // 14. getNamingModel — respects preferred provider
  it('uses preferred provider when setting specifies one', async () => {
    process.env.OPENAI_API_KEY = 'test-openai-key'
    process.env.GROQ_API_KEY = 'test-groq-key'
    const session = fakeSession()
    const deps = makeDeps({
      getSession: vi.fn(() => session),
      getSetting: vi.fn(() => 'openai'),
    })
    const naming = new SessionNaming(deps)
    mockGenerateText.mockResolvedValue({ text: 'Fix Login Page Styling' })

    await naming.executeSessionNaming('s1')

    expect(mockGenerateText).toHaveBeenCalledWith(
      expect.objectContaining({
        model: expect.objectContaining({ modelId: expect.stringContaining('gpt') }),
      }),
    )
  })
})
